// SPDX-License-Identifier: AGPL-3.0-or-later

// Package services exposes the backend to the frontend through Wails bindings.
package services

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/shuake/aio/internal/core"
	"github.com/shuake/aio/internal/store"
)

// ---------------------------------------------------------------- accounts

// AccountService manages platform accounts.
type AccountService struct{ M *core.Manager }

// List returns every account (without secrets).
func (s *AccountService) List() ([]*store.Account, error) { return s.M.Store.ListAccounts() }

// Create adds an account. secret holds password/token fields; it is encrypted.
func (s *AccountService) Create(platform, name string, fields map[string]any, secret map[string]any) (*store.Account, error) {
	if _, ok := core.Platforms[platform]; !ok {
		return nil, errors.New("未知平台")
	}
	acc, err := s.M.Store.CreateAccount(platform, strings.TrimSpace(name), fields, secret)
	if err == nil {
		s.M.Emit(core.EventAccount, acc)
	}
	return acc, err
}

// Update changes the name/fields and merges secret (empty strings are ignored).
func (s *AccountService) Update(id, name string, fields map[string]any, secret map[string]any) (*store.Account, error) {
	acc, err := s.M.Store.GetAccount(id)
	if err != nil {
		return nil, err
	}
	acc.Name = strings.TrimSpace(name)
	if fields != nil {
		acc.Fields = fields
	}
	if err := s.M.Store.UpdateAccount(acc); err != nil {
		return nil, err
	}
	patch := map[string]any{}
	for k, v := range secret {
		if str, ok := v.(string); ok && str == "" {
			continue
		}
		patch[k] = v
	}
	if len(patch) > 0 {
		if err := s.M.Store.MergeSecret(id, patch); err != nil {
			return nil, err
		}
	}
	acc, err = s.M.Store.GetAccount(id)
	if err == nil {
		s.M.Emit(core.EventAccount, acc)
	}
	return acc, err
}

// Delete removes an account, its credentials and its task history.
func (s *AccountService) Delete(id string) error {
	tasks, _ := s.M.Store.ListTasks(10000)
	for _, t := range tasks {
		if t.AccountID == id {
			if t.Status == "running" || t.Status == "queued" {
				return errors.New("该账号还有未结束的任务")
			}
			s.M.DeleteTaskLog(t.ID)
		}
	}
	if err := s.M.Store.DeleteAccount(id); err != nil {
		return err
	}
	// per-account browser profile / state of the 智慧树 engine
	_ = os.RemoveAll(filepath.Join(s.M.DataDir, "zhihuishu", "accounts", id))
	return nil
}

// ImportRow is one account of a bulk import.
type ImportRow struct {
	Name   string         `json:"name"`
	Fields map[string]any `json:"fields"`
	Secret map[string]any `json:"secret"`
}

// ImportResult reports a bulk import.
type ImportResult struct {
	Created int      `json:"created"`
	Skipped int      `json:"skipped"`
	Errors  []string `json:"errors"`
	IDs     []string `json:"ids"`
}

// Import creates many accounts of one platform. Rows whose username already
// exists on that platform are skipped.
func (s *AccountService) Import(platform string, rows []ImportRow) (*ImportResult, error) {
	if _, ok := core.Platforms[platform]; !ok {
		return nil, errors.New("未知平台")
	}
	existing, err := s.M.Store.ListAccounts()
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, a := range existing {
		if u, _ := a.Fields["username"].(string); a.Platform == platform && u != "" {
			seen[u] = true
		}
	}
	res := &ImportResult{Errors: []string{}, IDs: []string{}}
	for i, r := range rows {
		u, _ := r.Fields["username"].(string)
		u = strings.TrimSpace(u)
		if u != "" && seen[u] {
			res.Skipped++
			continue
		}
		acc, err := s.M.Store.CreateAccount(platform, strings.TrimSpace(r.Name), r.Fields, r.Secret)
		if err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("第 %d 行：%v", i+1, err))
			continue
		}
		if u != "" {
			seen[u] = true
		}
		res.Created++
		res.IDs = append(res.IDs, acc.ID)
		s.M.Emit(core.EventAccount, acc)
	}
	return res, nil
}

// LoginMany logs several accounts in on the background.
func (s *AccountService) LoginMany(ids []string) error { return s.M.LoginMany(ids) }

// LoginStates returns the state of background logins.
func (s *AccountService) LoginStates() []core.LoginState { return s.M.LoginStates() }

// Logout forgets the saved session (token/cookies) but keeps the password.
func (s *AccountService) Logout(id string) error {
	sec, err := s.M.Store.Secret(id)
	if err != nil {
		return err
	}
	patch := map[string]any{}
	for k := range sec {
		if k != "password" {
			patch[k] = nil
		}
	}
	return s.M.Store.MergeSecret(id, patch)
}

// Login runs the interactive login of the platform (QR code / SSO / captcha).
func (s *AccountService) Login(ctx context.Context, id string) (*core.CallResult, error) {
	return s.M.Call(ctx, core.JobSpec{Action: "login", AccountID: id})
}

// ---------------------------------------------------------------- tasks

// TaskService runs and tracks jobs.
type TaskService struct{ M *core.Manager }

// ListCourses asks the platform for the account's courses.
func (s *TaskService) ListCourses(ctx context.Context, accountID string, options map[string]any) (*core.CallResult, error) {
	return s.M.Call(ctx, core.JobSpec{Action: "list_courses", AccountID: accountID, Options: options})
}

// Start queues a run task.
func (s *TaskService) Start(accountID, title string, options map[string]any) (*store.Task, error) {
	return s.M.StartTask(accountID, title, options)
}

// StartBatch queues tasks for many accounts (courses picked per account by mode).
func (s *TaskService) StartBatch(req core.BatchRequest) (*core.Batch, error) {
	return s.M.StartBatch(req)
}

// Batches returns recent batches.
func (s *TaskService) Batches() []core.Batch { return s.M.Batches() }

// Retry queues a finished task again with the same options.
func (s *TaskService) Retry(taskID string) (*store.Task, error) { return s.M.RetryTask(taskID) }

// Cancel cancels a task.
func (s *TaskService) Cancel(taskID string) { s.M.CancelTask(taskID) }

// CancelJob cancels a short call (login, course list, ...).
func (s *TaskService) CancelJob(jobID string) { s.M.CancelJob(jobID) }

// List returns recent tasks.
func (s *TaskService) List(limit int) ([]*store.Task, error) { return s.M.Store.ListTasks(limit) }

// Get returns one task.
func (s *TaskService) Get(id string) (*store.Task, error) { return s.M.Store.GetTask(id) }

// Delete removes a finished task and its log.
func (s *TaskService) Delete(id string) error {
	if err := s.M.Store.DeleteTask(id); err != nil {
		return err
	}
	s.M.DeleteTaskLog(id)
	return nil
}

// Logs returns the tail of a task's log.
func (s *TaskService) Logs(taskID string, limit int) ([]map[string]any, error) {
	return s.M.TaskLogs(taskID, limit)
}

// Running returns live progress of running tasks.
func (s *TaskService) Running() []core.RunningTask { return s.M.Running() }

// Pending returns requests waiting for the user (captcha, QR code, ...).
func (s *TaskService) Pending() []core.PendingRequest { return s.M.Pending() }

// Reply answers a pending request.
func (s *TaskService) Reply(jobID, requestID string, value any) error {
	return s.M.Reply(jobID, requestID, value)
}

// ---------------------------------------------------------------- app

// AppService covers settings, environment and platform helpers.
type AppService struct {
	M       *core.Manager
	Version string
}

// Platform describes a supported platform.
type Platform struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Info is shown on the settings/about page.
type Info struct {
	Version    string `json:"version"`
	DataDir    string `json:"dataDir"`
	Python     string `json:"python"`
	Bundled    bool   `json:"bundled"`
	EnvError   string `json:"envError"`
	KeyBackend string `json:"keyBackend"`
	Node       string `json:"node"`
	NodeError  string `json:"nodeError"`
}

// Info returns static app information.
func (s *AppService) Info() Info {
	info := Info{Version: s.Version, DataDir: s.M.DataDir, KeyBackend: s.M.Store.KeyBackend()}
	if env, err := s.M.Env(); err != nil {
		info.EnvError = err.Error()
	} else {
		info.Python, info.Bundled = env.Python, env.Bundled
	}
	if env, err := s.M.NodeEnv(); err != nil {
		info.NodeError = err.Error()
	} else {
		info.Node = env.Python + " " + env.Bootstrap
	}
	return info
}

// GetSettings returns the user settings.
func (s *AppService) GetSettings() core.Settings { return s.M.Settings() }

// SaveSettings stores the settings. A non-empty aiKey replaces the saved key;
// clearKey removes it.
func (s *AppService) SaveSettings(st core.Settings, aiKey string, clearKey bool) (core.Settings, error) {
	if st.Concurrency < 1 {
		st.Concurrency = 1
	}
	if st.Concurrency > core.MaxConcurrency {
		st.Concurrency = core.MaxConcurrency
	}
	for k, v := range st.PlatformLimits {
		if v < 0 {
			st.PlatformLimits[k] = 0
		}
	}
	st.ServerMode = false
	st.AIBaseURL = strings.TrimSpace(st.AIBaseURL)
	st.AIModel = strings.TrimSpace(st.AIModel)
	if _, ok := core.AIProviders[st.AIProvider]; !ok {
		st.AIProvider = "custom"
	}
	if !core.AIThinkingLevels[st.AIThinking] {
		return st, errors.New("未知的思考强度")
	}
	if p, ok := core.AIProviders[st.AIProvider]; ok {
		if st.AIBaseURL == "" {
			st.AIBaseURL = p.BaseURL
		}
		if st.AIModel == "" {
			st.AIModel = p.Model
		}
	}
	if err := s.M.MigrateAIKey(); err != nil {
		return st, err
	}
	keyName := core.AIKeyName(st.AIProvider)
	st.BrowserPath = strings.TrimSpace(st.BrowserPath)
	if s.M.ServerMode {
		st.BrowserPath = ""
	}
	if st.BrowserPath != "" {
		if _, err := os.Stat(st.BrowserPath); err != nil {
			return st, errors.New("浏览器路径不存在")
		}
	}
	if err := s.M.Store.SetSetting("settings", st); err != nil {
		return st, err
	}
	if clearKey {
		if err := s.M.Store.SetSecretSetting(keyName, ""); err != nil {
			return st, err
		}
	} else if k := strings.TrimSpace(aiKey); k != "" {
		if err := s.M.Store.SetSecretSetting(keyName, k); err != nil {
			return st, err
		}
	}
	return s.M.Settings(), nil
}

// TestAI sends a tiny prompt to the AI endpoint with the settings in the form
// (not yet saved). An empty key uses the provider's saved one.
func (s *AppService) TestAI(ctx context.Context, st core.Settings, key string) (*core.CallResult, error) {
	if _, ok := core.AIProviders[st.AIProvider]; !ok {
		st.AIProvider = "custom"
	}
	if key = strings.TrimSpace(key); key == "" {
		key = s.M.AIKey(st.AIProvider)
	}
	st.AIEnabled = true
	st.AIBaseURL, st.AIModel = strings.TrimSpace(st.AIBaseURL), strings.TrimSpace(st.AIModel)
	return s.M.Call(ctx, core.JobSpec{Platform: "engine", Action: "ai_test", AIOverride: core.AIConfig(st, key)})
}

// AIKeyStatus reports which providers have a saved API key.
func (s *AppService) AIKeyStatus() map[string]bool {
	out := map[string]bool{}
	for _, p := range []string{"deepseek", "aliyun", "custom"} {
		out[p] = s.M.AIKey(p) != ""
	}
	return out
}

// CheckEnv imports every engine dependency and detects a browser.
func (s *AppService) CheckEnv(ctx context.Context) (*core.CallResult, error) {
	return s.M.Call(ctx, core.JobSpec{Platform: "engine", Action: "env_check"})
}

// ListTenants returns the schools known by 安全微伴.
func (s *AppService) ListTenants(ctx context.Context) (*core.CallResult, error) {
	return s.M.Call(ctx, core.JobSpec{Platform: "weban", Action: "list_tenants"})
}

// Platforms returns supported platform ids and names.
func (s *AppService) Platforms() []Platform {
	order := []string{"xuetangx", "icve_ai", "icve_mooc", "weban", "zhihuishu", "diagnostic"}
	out := make([]Platform, 0, len(order))
	for _, id := range order {
		out = append(out, Platform{ID: id, Name: core.Platforms[id]})
	}
	return out
}

// OpenURL opens a link in the system browser.
func (s *AppService) OpenURL(url string) {
	if strings.HasPrefix(url, "http://") || strings.HasPrefix(url, "https://") {
		s.M.OpenURL(url)
	}
}

// TrafficOverview returns live samples and the last 31 days of network usage.
func (s *AppService) TrafficOverview() (*core.TrafficOverview, error) { return s.M.TrafficOverview() }

// OpenDataDir reveals the data directory in the file manager.
func (s *AppService) OpenDataDir() { s.M.OpenPath(s.M.DataDir) }
