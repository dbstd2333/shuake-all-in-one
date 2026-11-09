// SPDX-License-Identifier: AGPL-3.0-or-later

package core

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/shuake/aio/internal/store"
)

// Event names for batch operations.
const (
	EventLogin = "account:login"
	EventBatch = "batch:update"
)

// batchWorkers bounds how many engine calls a batch runs at the same time
// (logins / course listings are short but may each open a browser).
const batchWorkers = 3

// ---------------------------------------------------------------- bulk login

// LoginState is the live state of a background login of one account.
type LoginState struct {
	AccountID string `json:"accountId"`
	State     string `json:"state"` // queued | running | ok | failed
	Error     string `json:"error,omitempty"`
	JobID     string `json:"jobId,omitempty"` // engine job of the attempt (for its log)
	Code      int    `json:"code"`            // engine exit code (3 = cancelled)
	UpdatedAt int64  `json:"updatedAt"`
}

func (m *Manager) setLogin(st LoginState) {
	st.UpdatedAt = time.Now().Unix()
	m.mu.Lock()
	m.logins[st.AccountID] = st
	m.mu.Unlock()
	m.Emit(EventLogin, st)
}

// LoginStates returns the state of recent background logins.
func (m *Manager) LoginStates() []LoginState {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]LoginState, 0, len(m.logins))
	for _, s := range m.logins {
		out = append(out, s)
	}
	return out
}

// LoginMany logs accounts in on the background, a few at a time. Interactive
// steps (QR codes, captchas) show up in the interaction center as usual.
func (m *Manager) LoginMany(ids []string) error {
	if len(ids) == 0 {
		return errors.New("没有选择账号")
	}
	var todo []string
	m.mu.Lock()
	for _, id := range ids {
		if s, ok := m.logins[id]; ok && (s.State == "queued" || s.State == "running") {
			continue
		}
		todo = append(todo, id)
	}
	m.mu.Unlock()
	for _, id := range todo {
		m.setLogin(LoginState{AccountID: id, State: "queued"})
	}
	go m.forEach(todo, func(id string) {
		m.setLogin(LoginState{AccountID: id, State: "running"})
		res, err := m.Call(m.ctx, JobSpec{Action: "login", AccountID: id})
		switch {
		case err != nil:
			m.setLogin(LoginState{AccountID: id, State: "failed", Error: err.Error()})
		case res.Code != 0:
			m.setLogin(LoginState{AccountID: id, State: "failed", Error: res.Error, JobID: res.JobID, Code: res.Code})
		default:
			m.setAccountStatus(id, "ok", nil)
			m.setLogin(LoginState{AccountID: id, State: "ok", JobID: res.JobID})
		}
	})
	return nil
}

// forEach runs fn over items with batchWorkers goroutines.
func (m *Manager) forEach(items []string, fn func(string)) {
	ch := make(chan string)
	var wg sync.WaitGroup
	for i := 0; i < batchWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for it := range ch {
				fn(it)
			}
		}()
	}
	for _, it := range items {
		select {
		case ch <- it:
		case <-m.ctx.Done():
		}
	}
	close(ch)
	wg.Wait()
}

// ---------------------------------------------------------------- batch tasks

// BatchRequest starts the same kind of task for many accounts.
type BatchRequest struct {
	AccountIDs []string       `json:"accountIds"`
	Options    map[string]any `json:"options"`
	// Mode selects courses per account: "unfinished" (progress < 100 or
	// unknown), "all", or "keyword" (name contains any of Keywords).
	Mode     string   `json:"mode"`
	Keywords []string `json:"keywords"`
	// Title prefix; the account name is appended.
	Title string `json:"title"`
}

// BatchItem is the outcome for one account of a batch.
type BatchItem struct {
	AccountID   string `json:"accountId"`
	AccountName string `json:"accountName"`
	State       string `json:"state"` // pending | listing | queued | skipped | failed
	Message     string `json:"message,omitempty"`
	TaskID      string `json:"taskId,omitempty"`
	Courses     int    `json:"courses"`
}

// Batch groups the tasks created by one StartBatch.
type Batch struct {
	ID        string      `json:"id"`
	Title     string      `json:"title"`
	Mode      string      `json:"mode"`
	CreatedAt int64       `json:"createdAt"`
	Done      bool        `json:"done"`
	Items     []BatchItem `json:"items"`
}

const maxBatches = 30

// Batches returns recent batches, newest first.
func (m *Manager) Batches() []Batch {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Batch, 0, len(m.batches))
	for i := len(m.batches) - 1; i >= 0; i-- {
		b := *m.batches[i]
		b.Items = append([]BatchItem(nil), b.Items...)
		out = append(out, b)
	}
	return out
}

func (m *Manager) emitBatch(b *Batch) {
	m.mu.Lock()
	cp := *b
	cp.Items = append([]BatchItem(nil), b.Items...)
	m.mu.Unlock()
	m.Emit(EventBatch, cp)
}

func (m *Manager) updateItem(b *Batch, i int, fn func(*BatchItem)) {
	m.mu.Lock()
	fn(&b.Items[i])
	m.mu.Unlock()
	m.emitBatch(b)
}

// filterCourses applies the batch mode to a course list from list_courses.
func filterCourses(courses []any, mode string, keywords []string) []map[string]any {
	out := []map[string]any{}
	for _, raw := range courses {
		c, ok := raw.(map[string]any)
		if !ok || c["id"] == nil {
			continue
		}
		name, _ := c["name"].(string)
		switch mode {
		case "all":
		case "keyword":
			hit := false
			for _, k := range keywords {
				if k = strings.TrimSpace(k); k != "" && strings.Contains(name, k) {
					hit = true
					break
				}
			}
			if !hit {
				continue
			}
		default: // unfinished
			if p, ok := c["progress"].(float64); ok && p >= 100 {
				continue
			}
		}
		out = append(out, c)
	}
	return out
}

// StartBatch lists the courses of every account, applies the mode and queues
// one run task per account. It returns immediately; progress is reported
// through EventBatch.
func (m *Manager) StartBatch(req BatchRequest) (*Batch, error) {
	if len(req.AccountIDs) == 0 {
		return nil, errors.New("没有选择账号")
	}
	if req.Mode == "keyword" && len(req.Keywords) == 0 {
		return nil, errors.New("请填写课程关键词")
	}
	b := &Batch{ID: store.NewID(), Title: strings.TrimSpace(req.Title), Mode: req.Mode, CreatedAt: time.Now().Unix()}
	index := map[string]int{}
	for _, id := range req.AccountIDs {
		acc, err := m.Store.GetAccount(id)
		if err != nil {
			continue
		}
		index[id] = len(b.Items)
		b.Items = append(b.Items, BatchItem{AccountID: id, AccountName: accountLabel(acc), State: "pending"})
	}
	if len(b.Items) == 0 {
		return nil, errors.New("账号不存在")
	}
	m.mu.Lock()
	m.batches = append(m.batches, b)
	if len(m.batches) > maxBatches {
		m.batches = m.batches[len(m.batches)-maxBatches:]
	}
	m.mu.Unlock()
	m.emitBatch(b)

	ids := make([]string, 0, len(b.Items))
	for _, it := range b.Items {
		ids = append(ids, it.AccountID)
	}
	go func() {
		m.forEach(ids, func(id string) { m.batchOne(b, index[id], req) })
		m.mu.Lock()
		b.Done = true
		m.mu.Unlock()
		m.emitBatch(b)
	}()
	cp := *b
	return &cp, nil
}

func (m *Manager) batchOne(b *Batch, i int, req BatchRequest) {
	id := b.Items[i].AccountID
	m.updateItem(b, i, func(it *BatchItem) { it.State = "listing"; it.Message = "正在获取课程…" })
	res, err := m.Call(m.ctx, JobSpec{Action: "list_courses", AccountID: id, Options: req.Options})
	if err == nil && res.Code != 0 {
		err = errors.New(res.Error)
	}
	if err != nil {
		m.updateItem(b, i, func(it *BatchItem) { it.State = "failed"; it.Message = "获取课程失败：" + err.Error() })
		return
	}
	all, _ := res.Data["courses"].([]any)
	picked := filterCourses(all, req.Mode, req.Keywords)
	if len(picked) == 0 {
		msg := fmt.Sprintf("共 %d 门课程，没有符合条件的", len(all))
		m.updateItem(b, i, func(it *BatchItem) { it.State = "skipped"; it.Message = msg })
		return
	}
	opts := map[string]any{}
	for k, v := range req.Options {
		opts[k] = v
	}
	courseIDs := make([]any, 0, len(picked))
	names := make([]string, 0, len(picked))
	courses := make([]any, 0, len(picked))
	for _, c := range picked {
		courseIDs = append(courseIDs, fmt.Sprint(c["id"]))
		n, _ := c["name"].(string)
		names = append(names, n)
		courses = append(courses, c)
	}
	opts["course_ids"] = courseIDs
	opts["courses"] = courses
	opts["batch_id"] = b.ID

	title := b.Items[i].AccountName + " · " + summarizeNames(names)
	if b.Title != "" {
		title = b.Title + " · " + b.Items[i].AccountName
	}
	t, err := m.StartTask(id, title, opts)
	if err != nil {
		m.updateItem(b, i, func(it *BatchItem) { it.State = "failed"; it.Message = err.Error() })
		return
	}
	m.updateItem(b, i, func(it *BatchItem) {
		it.State, it.TaskID, it.Courses = "queued", t.ID, len(picked)
		it.Message = fmt.Sprintf("已加入队列：%d 门课程", len(picked))
	})
}

func accountLabel(a *store.Account) string {
	if a.Name != "" {
		return a.Name
	}
	if u, _ := a.Fields["username"].(string); u != "" {
		return u
	}
	return a.ID[:6]
}

func summarizeNames(names []string) string {
	if len(names) == 0 {
		return ""
	}
	if len(names) == 1 {
		return names[0]
	}
	return fmt.Sprintf("%s 等 %d 门", names[0], len(names))
}

// ---------------------------------------------------------------- retry

// RetryTask queues a new run with the same account, title and options.
func (m *Manager) RetryTask(id string) (*store.Task, error) {
	t, err := m.Store.GetTask(id)
	if err != nil {
		return nil, err
	}
	if t.Status == "running" || t.Status == "queued" {
		return nil, errors.New("任务还没有结束")
	}
	return m.StartTask(t.AccountID, t.Title, t.Options)
}
