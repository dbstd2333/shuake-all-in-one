// SPDX-License-Identifier: AGPL-3.0-or-later

// Package core runs engine jobs, keeps task state and fans events out to the UI.
package core

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/shuake/aio/internal/pyenv"
	"github.com/shuake/aio/internal/runner"
	"github.com/shuake/aio/internal/store"
)

// Platforms supported by the engine.
var Platforms = map[string]string{
	"xuetangx":   "学堂在线",
	"icve_ai":    "智慧职教 · AI优课/常规MOOC",
	"icve_mooc":  "智慧职教 · MOOC学院",
	"weban":      "安全微伴",
	"zhihuishu":  "智慧树",
	"diagnostic": "诊断（测试用）",
}

// Event names emitted to the frontend.
const (
	EventEngine  = "engine:msg"
	EventTask    = "task:update"
	EventAccount = "account:update"
)

// EngineEvent wraps one engine message for the UI.
type EngineEvent struct {
	JobID     string         `json:"jobId"`
	TaskID    string         `json:"taskId,omitempty"`
	AccountID string         `json:"accountId,omitempty"`
	Platform  string         `json:"platform"`
	Action    string         `json:"action"`
	Msg       map[string]any `json:"msg"`
}

// PendingRequest is a request waiting for the user.
type PendingRequest struct {
	EngineEvent
	ID string `json:"id"`
}

// Settings are user preferences (the AI key is stored separately, encrypted).
type Settings struct {
	AIEnabled bool `json:"aiEnabled"`
	// AIProvider is "deepseek", "aliyun" or "custom" (any OpenAI-compatible API).
	AIProvider string `json:"aiProvider"`
	AIBaseURL  string `json:"aiBaseUrl"`
	AIModel    string `json:"aiModel"`
	// AIThinking is the reasoning level: "off", "low", "medium", "high", "max",
	// or "" to send nothing and use the model's default.
	AIThinking string `json:"aiThinking"`
	// AIHasKey reports whether the current provider has a saved key.
	AIHasKey    bool   `json:"aiHasKey"`
	Concurrency int    `json:"concurrency"`
	BrowserPath string `json:"browserPath"`
	Debug       bool   `json:"debug"`
	// PlatformLimits caps concurrent run tasks per platform (0 / missing = only
	// the global limit). 智慧树 runs a real Chrome per task, so it defaults low.
	PlatformLimits map[string]int `json:"platformLimits"`
	// ServerMode is set by the host, never stored: the UI hides desktop-only features.
	ServerMode bool `json:"serverMode"`
}

// MaxConcurrency is the upper bound accepted for the global limit.
const MaxConcurrency = 50

// DefaultSettings returns the defaults for a fresh install.
func DefaultSettings() Settings {
	return Settings{AIProvider: "deepseek", AIBaseURL: AIProviders["deepseek"].BaseURL,
		AIModel: AIProviders["deepseek"].Model, AIThinking: "low", Concurrency: 3,
		PlatformLimits: map[string]int{"zhihuishu": 2}}
}

// AIProvider holds the defaults for a built-in AI provider.
type AIProvider struct {
	BaseURL string
	Model   string
}

// AIProviders are the built-in presets; "custom" has none.
var AIProviders = map[string]AIProvider{
	"deepseek": {BaseURL: "https://api.deepseek.com", Model: "deepseek-flash"},
	"aliyun":   {BaseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", Model: "qwen3.8-flash"},
}

// AIThinkingLevels are the accepted AIThinking values.
var AIThinkingLevels = map[string]bool{"": true, "off": true, "low": true, "medium": true, "high": true, "max": true}

// AIKeyName is the secret setting holding the API key of a provider. Custom
// endpoints keep the original "ai_api_key" so older installs keep their key.
func AIKeyName(provider string) string {
	if _, ok := AIProviders[provider]; ok {
		return "ai_api_key:" + provider
	}
	return "ai_api_key"
}

// inferAIProvider guesses the provider of settings saved before providers existed.
func inferAIProvider(baseURL string) string {
	u := strings.ToLower(baseURL)
	switch {
	case strings.Contains(u, "deepseek.com"):
		return "deepseek"
	case strings.Contains(u, "dashscope") || strings.Contains(u, "aliyuncs.com"):
		return "aliyun"
	}
	return "custom"
}

type job struct {
	id        string
	taskID    string
	accountID string
	platform  string
	action    string
	proc      *runner.Process
	logFile   *os.File

	mu       sync.Mutex
	pending  map[string]PendingRequest
	progress map[string]map[string]any
	result   map[string]any
	errMsg   string
	// cumulative bytes reported by the engine ("stats" messages) and the part
	// already booked into the daily totals
	rx, tx         int64
	seenRx, seenTx int64
}

// Manager owns all running engine processes.
type Manager struct {
	Store   *store.Store
	DataDir string
	Emit    func(name string, data any)
	OpenURL func(url string)
	// OpenPath reveals a local path in the file manager.
	OpenPath func(path string)

	// ServerMode marks the headless web deployment: there is no local browser
	// window or file manager, and engines are told so via options.server_mode.
	ServerMode bool

	envOnce  sync.Once
	env      *pyenv.Env
	envErr   error
	nodeOnce sync.Once
	nodeEnv  *pyenv.Env
	nodeErr  error

	mu        sync.Mutex
	jobs      map[string]*job
	active    int
	activeBy  map[string]int
	logins    map[string]LoginState
	batches   []*Batch
	closing   bool
	cancelled sync.Map // queued task ids cancelled before they started
	ctx       context.Context
	stop      context.CancelFunc
	traffic   trafficState
}

// NewManager creates a manager. emit/openURL may be nil in tests.
func NewManager(st *store.Store, dataDir string, emit func(string, any), openURL func(string)) *Manager {
	if emit == nil {
		emit = func(string, any) {}
	}
	if openURL == nil {
		openURL = func(string) {}
	}
	ctx, stop := context.WithCancel(context.Background())
	m := &Manager{Store: st, DataDir: dataDir, Emit: emit, OpenURL: openURL, OpenPath: func(string) {}, jobs: map[string]*job{}, activeBy: map[string]int{}, logins: map[string]LoginState{}, ctx: ctx, stop: stop}
	m.startTraffic()
	return m
}

// Env returns the located Python engine.
func (m *Manager) Env() (*pyenv.Env, error) {
	m.envOnce.Do(func() { m.env, m.envErr = pyenv.Locate() })
	return m.env, m.envErr
}

// NodeEnv returns the located Node engine (智慧树).
func (m *Manager) NodeEnv() (*pyenv.Env, error) {
	m.nodeOnce.Do(func() { m.nodeEnv, m.nodeErr = pyenv.LocateNode() })
	return m.nodeEnv, m.nodeErr
}

// envFor picks the engine implementation of a platform.
func (m *Manager) envFor(platform string) (*pyenv.Env, error) {
	if platform == "zhihuishu" {
		return m.NodeEnv()
	}
	return m.Env()
}

// Shutdown kills every running engine.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	m.closing = true
	m.mu.Unlock()
	m.stop()
	m.mu.Lock()
	jobs := make([]*job, 0, len(m.jobs))
	for _, j := range m.jobs {
		jobs = append(jobs, j)
	}
	m.mu.Unlock()
	for _, j := range jobs {
		j.proc.Kill()
	}
	deadline := time.After(3 * time.Second)
	for _, j := range jobs {
		select {
		case <-j.proc.Done():
		case <-deadline:
		}
		m.settleJob(j)
	}
	m.flushTraffic()
}

// ---------------------------------------------------------------- settings

// Settings loads the user settings.
func (m *Manager) Settings() Settings {
	s := DefaultSettings()
	_ = m.Store.GetSetting("settings", &s)
	if m.legacyAISettings() {
		// saved before providers existed: keep the endpoint as it was, and
		// send no thinking options (the model's default) like before
		s.AIProvider = inferAIProvider(s.AIBaseURL)
		s.AIThinking = ""
	} else if _, ok := AIProviders[s.AIProvider]; !ok {
		s.AIProvider = "custom"
	}
	if !AIThinkingLevels[s.AIThinking] {
		s.AIThinking = ""
	}
	s.AIHasKey = m.aiKey(s.AIProvider) != ""
	if s.Concurrency <= 0 {
		s.Concurrency = 3
	}
	if s.PlatformLimits == nil {
		s.PlatformLimits = DefaultSettings().PlatformLimits
	}
	s.ServerMode = m.ServerMode
	return s
}

// aiKey returns the saved key of a provider. A built-in provider without its
// own key falls back to the pre-provider key when that one was for the same
// endpoint (installs upgraded from a single-key version).
func (m *Manager) aiKey(provider string) string {
	key, _ := m.Store.GetSecretSetting(AIKeyName(provider))
	if key != "" || provider == "custom" {
		return key
	}
	if m.legacyAISettings() {
		var old struct {
			AIBaseURL string `json:"aiBaseUrl"`
		}
		_ = m.Store.GetSetting("settings", &old)
		if inferAIProvider(old.AIBaseURL) == provider {
			key, _ = m.Store.GetSecretSetting("ai_api_key")
		}
	}
	return key
}

// legacyAISettings reports settings saved by a version without AI providers.
func (m *Manager) legacyAISettings() bool {
	var probe struct {
		AIBaseURL  *string `json:"aiBaseUrl"`
		AIProvider *string `json:"aiProvider"`
	}
	_ = m.Store.GetSetting("settings", &probe)
	return probe.AIBaseURL != nil && probe.AIProvider == nil
}

// AIConfig is the "ai" block sent to the engine.
func AIConfig(s Settings, key string) map[string]any {
	return map[string]any{"enabled": s.AIEnabled, "provider": s.AIProvider, "base_url": s.AIBaseURL,
		"model": s.AIModel, "thinking": s.AIThinking, "api_key": key}
}

func (m *Manager) aiConfig(s Settings) map[string]any {
	return AIConfig(s, m.aiKey(s.AIProvider))
}

// MigrateAIKey moves the single key of a pre-provider install into the slot of
// the provider it was used with. Call it before the old settings are replaced.
func (m *Manager) MigrateAIKey() error {
	if !m.legacyAISettings() {
		return nil
	}
	var old struct {
		AIBaseURL string `json:"aiBaseUrl"`
	}
	_ = m.Store.GetSetting("settings", &old)
	p := inferAIProvider(old.AIBaseURL)
	key, _ := m.Store.GetSecretSetting("ai_api_key")
	if p == "custom" || key == "" {
		return nil
	}
	if cur, _ := m.Store.GetSecretSetting(AIKeyName(p)); cur == "" {
		if err := m.Store.SetSecretSetting(AIKeyName(p), key); err != nil {
			return err
		}
	}
	return m.Store.SetSecretSetting("ai_api_key", "")
}

// AIKey returns the saved key of a provider (see aiKey).
func (m *Manager) AIKey(provider string) string { return m.aiKey(provider) }

// ---------------------------------------------------------------- jobs

// JobSpec describes an engine invocation.
type JobSpec struct {
	Platform  string
	Action    string
	AccountID string
	Options   map[string]any
	TaskID    string
	// AIOverride replaces the saved AI config (used by "test connection").
	AIOverride map[string]any
}

func (m *Manager) buildStart(spec JobSpec) (runner.Start, error) {
	settings := m.Settings()
	st := runner.Start{
		Platform:  spec.Platform,
		Action:    spec.Action,
		AccountID: spec.AccountID,
		Options:   map[string]any{},
		AI:        m.aiConfig(settings),
		DataDir:   m.DataDir,
		Debug:     settings.Debug,
	}
	if spec.AIOverride != nil {
		st.AI = spec.AIOverride
	}
	if settings.BrowserPath != "" {
		st.Options["browser_path"] = settings.BrowserPath
	}
	if m.ServerMode {
		st.Options["server_mode"] = true
	}
	for k, v := range spec.Options {
		st.Options[k] = v
	}
	if spec.AccountID != "" {
		acc, err := m.Store.GetAccount(spec.AccountID)
		if err != nil {
			return st, fmt.Errorf("账号不存在: %w", err)
		}
		st.Platform = acc.Platform
		st.Account = acc.Fields
		if st.Credential, err = m.Store.Secret(acc.ID); err != nil {
			return st, err
		}
	}
	if _, ok := Platforms[st.Platform]; !ok && st.Platform != "engine" {
		return st, fmt.Errorf("未知平台: %s", st.Platform)
	}
	return st, nil
}

func (m *Manager) startJob(spec JobSpec) (*job, error) {
	start, err := m.buildStart(spec)
	if err != nil {
		return nil, err
	}
	env, err := m.envFor(start.Platform)
	if err != nil {
		return nil, err
	}
	j := &job{
		id:        store.NewID(),
		taskID:    spec.TaskID,
		accountID: spec.AccountID,
		platform:  start.Platform,
		action:    start.Action,
		pending:   map[string]PendingRequest{},
		progress:  map[string]map[string]any{},
	}
	if spec.TaskID != "" {
		if f, err := os.OpenFile(m.taskLogPath(spec.TaskID), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
			j.logFile = f
		}
	}
	proc, err := runner.Spawn(env, start, func(msg runner.Message) { m.handle(j, msg) })
	if err != nil {
		if j.logFile != nil {
			j.logFile.Close()
		}
		return nil, err
	}
	j.proc = proc
	m.mu.Lock()
	m.jobs[j.id] = j
	m.mu.Unlock()
	return j, nil
}

func (m *Manager) finishJob(j *job) int {
	<-j.proc.Done()
	code := j.proc.ExitCode()
	m.mu.Lock()
	delete(m.jobs, j.id)
	m.mu.Unlock()
	m.settleJob(j)
	j.mu.Lock()
	for id, p := range j.pending {
		delete(j.pending, id)
		m.Emit(EventEngine, EngineEvent{JobID: j.id, TaskID: j.taskID, AccountID: j.accountID, Platform: j.platform, Action: j.action,
			Msg: map[string]any{"type": "request_done", "id": p.ID}})
	}
	j.mu.Unlock()
	m.Emit(EventEngine, EngineEvent{JobID: j.id, TaskID: j.taskID, AccountID: j.accountID, Platform: j.platform, Action: j.action,
		Msg: map[string]any{"type": "exit", "code": code}})
	if j.logFile != nil {
		j.logFile.Close()
	}
	if j.accountID != "" && code == runner.ExitLogin {
		m.setAccountStatus(j.accountID, "invalid", nil)
	}
	return code
}

func (m *Manager) handle(j *job, msg runner.Message) {
	ev := EngineEvent{JobID: j.id, TaskID: j.taskID, AccountID: j.accountID, Platform: j.platform, Action: j.action, Msg: msg.Raw}
	switch msg.Type {
	case "credential":
		if data, ok := msg.Raw["data"].(map[string]any); ok && j.accountID != "" {
			_ = m.Store.MergeSecret(j.accountID, data)
		}
		return // never forward secrets to the UI
	case "open_url":
		if u := msg.Str("url"); strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://") {
			m.OpenURL(u)
		}
	case "request":
		j.mu.Lock()
		j.pending[msg.Str("id")] = PendingRequest{EngineEvent: ev, ID: msg.Str("id")}
		j.mu.Unlock()
	case "request_done":
		j.mu.Lock()
		delete(j.pending, msg.Str("id"))
		j.mu.Unlock()
	case "stats":
		// cumulative byte counters; only used for traffic accounting, not shown as a log line
		rx, _ := msg.Raw["rx"].(float64)
		tx, _ := msg.Raw["tx"].(float64)
		j.mu.Lock()
		j.rx = max(j.rx, int64(rx))
		j.tx = max(j.tx, int64(tx))
		j.mu.Unlock()
		return
	case "progress":
		j.mu.Lock()
		j.progress[msg.Str("scope")] = msg.Raw
		j.mu.Unlock()
	case "result":
		if data, ok := msg.Raw["data"].(map[string]any); ok {
			j.mu.Lock()
			j.result = data
			j.mu.Unlock()
			if j.accountID != "" {
				if fields, ok := data["account_fields"].(map[string]any); ok {
					m.mergeAccountFields(j.accountID, fields)
				}
				if user, ok := data["user"].(map[string]any); ok {
					m.setAccountStatus(j.accountID, "ok", user)
				}
			}
		}
	case "error":
		j.mu.Lock()
		j.errMsg = msg.Str("msg")
		j.mu.Unlock()
	}
	if j.logFile != nil && msg.Type != "request_done" {
		rec := msg.Raw
		if msg.Type == "request" || msg.Type == "result" {
			rec = map[string]any{"type": msg.Type, "kind": msg.Raw["kind"], "ts": float64(time.Now().UnixMilli()) / 1000}
		}
		if b, err := json.Marshal(rec); err == nil {
			_, _ = j.logFile.Write(append(b, '\n'))
		}
	}
	m.Emit(EventEngine, ev)
}

func (m *Manager) mergeAccountFields(id string, fields map[string]any) {
	acc, err := m.Store.GetAccount(id)
	if err != nil {
		return
	}
	if acc.Fields == nil {
		acc.Fields = map[string]any{}
	}
	for k, v := range fields {
		acc.Fields[k] = v
	}
	_ = m.Store.UpdateAccount(acc)
}

func (m *Manager) setAccountStatus(id, status string, user map[string]any) {
	acc, err := m.Store.GetAccount(id)
	if err != nil {
		return
	}
	acc.Status = status
	if user != nil {
		acc.User = user
		if acc.Name == "" {
			if n, _ := user["name"].(string); n != "" {
				acc.Name = n
			}
		}
	}
	if err := m.Store.UpdateAccount(acc); err == nil {
		if acc, err = m.Store.GetAccount(id); err == nil {
			m.Emit(EventAccount, acc)
		}
	}
}

// CallResult is what Call returns to the UI.
type CallResult struct {
	JobID string         `json:"jobId"`
	Code  int            `json:"code"`
	Data  map[string]any `json:"data"`
	Error string         `json:"error"`
}

// Call runs a short engine action (login, list_courses, ...) and waits for it.
// Interactive requests are forwarded to the UI like for tasks.
func (m *Manager) Call(ctx context.Context, spec JobSpec) (*CallResult, error) {
	j, err := m.startJob(spec)
	if err != nil {
		return nil, err
	}
	go func() {
		select {
		case <-ctx.Done():
			j.proc.Cancel(3 * time.Second)
		case <-m.ctx.Done():
		case <-j.proc.Done():
		}
	}()
	code := m.finishJob(j)
	j.mu.Lock()
	defer j.mu.Unlock()
	res := &CallResult{JobID: j.id, Code: code, Data: j.result, Error: j.errMsg}
	if code != 0 && res.Error == "" {
		switch code {
		case runner.ExitCancelled:
			res.Error = "已取消"
		case runner.ExitLogin:
			res.Error = "登录失败"
		default:
			res.Error = fmt.Sprintf("引擎异常退出（代码 %d）", code)
		}
	}
	return res, nil
}

// Reply answers a pending request of a job.
func (m *Manager) Reply(jobID, requestID string, value any) error {
	m.mu.Lock()
	j := m.jobs[jobID]
	m.mu.Unlock()
	if j == nil {
		return errors.New("任务已结束")
	}
	return j.proc.Reply(requestID, value)
}

// CancelJob cancels a job (task run or short call).
func (m *Manager) CancelJob(jobID string) {
	m.mu.Lock()
	j := m.jobs[jobID]
	m.mu.Unlock()
	if j != nil {
		j.proc.Cancel(5 * time.Second)
	}
}

// Pending lists every request still waiting for the user.
func (m *Manager) Pending() []PendingRequest {
	m.mu.Lock()
	jobs := make([]*job, 0, len(m.jobs))
	for _, j := range m.jobs {
		jobs = append(jobs, j)
	}
	m.mu.Unlock()
	out := []PendingRequest{}
	for _, j := range jobs {
		j.mu.Lock()
		for _, p := range j.pending {
			out = append(out, p)
		}
		j.mu.Unlock()
	}
	sort.Slice(out, func(a, b int) bool { return out[a].ID < out[b].ID })
	return out
}

// ---------------------------------------------------------------- tasks

func (m *Manager) taskLogPath(taskID string) string {
	dir := filepath.Join(m.DataDir, "logs")
	_ = os.MkdirAll(dir, 0o700)
	return filepath.Join(dir, "task-"+taskID+".jsonl")
}

// RunningTask is the live state of a task.
type RunningTask struct {
	TaskID   string                    `json:"taskId"`
	JobID    string                    `json:"jobId"`
	Progress map[string]map[string]any `json:"progress"`
}

// Running returns live state for all running tasks.
func (m *Manager) Running() []RunningTask {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []RunningTask{}
	for _, j := range m.jobs {
		if j.taskID == "" {
			continue
		}
		j.mu.Lock()
		p := map[string]map[string]any{}
		for k, v := range j.progress {
			p[k] = v
		}
		j.mu.Unlock()
		out = append(out, RunningTask{TaskID: j.taskID, JobID: j.id, Progress: p})
	}
	return out
}

// StartTask records a task and runs it when a slot is free.
func (m *Manager) StartTask(accountID, title string, options map[string]any) (*store.Task, error) {
	acc, err := m.Store.GetAccount(accountID)
	if err != nil {
		return nil, err
	}
	t := &store.Task{ID: store.NewID(), AccountID: acc.ID, Platform: acc.Platform, Title: title, Options: options, Status: "queued"}
	if err := m.Store.InsertTask(t); err != nil {
		return nil, err
	}
	m.Emit(EventTask, t)
	go m.runTask(t)
	return t, nil
}

// acquire waits for a free concurrency slot (global and per platform). It
// returns false when the task was cancelled while queued or the app is
// shutting down.
func (m *Manager) acquire(taskID, platform string) bool {
	for {
		if _, ok := m.cancelled.LoadAndDelete(taskID); ok {
			return false
		}
		st := m.Settings()
		perPlatform := st.PlatformLimits[platform]
		m.mu.Lock()
		if m.active < st.Concurrency && (perPlatform <= 0 || m.activeBy[platform] < perPlatform) {
			m.active++
			m.activeBy[platform]++
			m.mu.Unlock()
			return true
		}
		m.mu.Unlock()
		select {
		case <-m.ctx.Done():
			return false
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func (m *Manager) release(platform string) {
	m.mu.Lock()
	m.active--
	m.activeBy[platform]--
	m.mu.Unlock()
}

func (m *Manager) runTask(t *store.Task) {
	if !m.acquire(t.ID, t.Platform) {
		t.Status, t.FinishedAt = "cancelled", time.Now().Unix()
		_ = m.Store.UpdateTask(t)
		m.Emit(EventTask, t)
		return
	}
	defer m.release(t.Platform)
	t.Status, t.StartedAt = "running", time.Now().Unix()
	_ = m.Store.UpdateTask(t)
	m.Emit(EventTask, t)

	opts := map[string]any{}
	for k, v := range t.Options {
		opts[k] = v
	}
	j, err := m.startJob(JobSpec{Action: "run", AccountID: t.AccountID, Options: opts, TaskID: t.ID})
	if err != nil {
		t.Status, t.Error, t.FinishedAt = "failed", err.Error(), time.Now().Unix()
		_ = m.Store.UpdateTask(t)
		m.Emit(EventTask, t)
		return
	}
	code := m.finishJob(j)
	j.mu.Lock()
	if s, ok := j.result["summary"].(map[string]any); ok {
		t.Summary = s
	}
	t.Error = j.errMsg
	t.RxBytes, t.TxBytes = j.rx, j.tx
	j.mu.Unlock()
	m.mu.Lock()
	closing := m.closing
	m.mu.Unlock()
	switch {
	case closing && code != runner.ExitOK:
		t.Status, t.Error = "cancelled", "应用退出时任务被中断"
	case code == runner.ExitOK:
		t.Status = "success"
	case code == runner.ExitCancelled:
		t.Status = "cancelled"
	default:
		t.Status = "failed"
		if t.Error == "" {
			t.Error = fmt.Sprintf("引擎异常退出（代码 %d）", code)
		}
	}
	t.FinishedAt = time.Now().Unix()
	_ = m.Store.UpdateTask(t)
	m.Emit(EventTask, t)
}

// CancelTask cancels a queued or running task.
func (m *Manager) CancelTask(taskID string) {
	m.mu.Lock()
	var target *job
	for _, j := range m.jobs {
		if j.taskID == taskID {
			target = j
		}
	}
	m.mu.Unlock()
	if target != nil {
		target.proc.Cancel(5 * time.Second)
		return
	}
	m.cancelled.Store(taskID, true)
}

// TaskLogs returns the last limit records of a task log.
func (m *Manager) TaskLogs(taskID string, limit int) ([]map[string]any, error) {
	f, err := os.Open(m.taskLogPath(taskID))
	if err != nil {
		if os.IsNotExist(err) {
			return []map[string]any{}, nil
		}
		return nil, err
	}
	defer f.Close()
	if limit <= 0 {
		limit = 2000
	}
	ring := make([]map[string]any, 0, limit)
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 8*1024*1024)
	for sc.Scan() {
		var rec map[string]any
		if json.Unmarshal(sc.Bytes(), &rec) != nil {
			continue
		}
		if len(ring) == limit {
			ring = ring[1:]
		}
		ring = append(ring, rec)
	}
	return ring, sc.Err()
}

// DeleteTaskLog removes the log file of a task.
func (m *Manager) DeleteTaskLog(taskID string) { _ = os.Remove(m.taskLogPath(taskID)) }
