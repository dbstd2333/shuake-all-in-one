// SPDX-License-Identifier: AGPL-3.0-or-later

// Package services exposes the backend to the frontend through Wails bindings.
package services

import (
	"context"
	"errors"
	"os"
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
	return s.M.Store.DeleteAccount(id)
}

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
}

// Info returns static app information.
func (s *AppService) Info() Info {
	info := Info{Version: s.Version, DataDir: s.M.DataDir, KeyBackend: s.M.Store.KeyBackend()}
	if env, err := s.M.Env(); err != nil {
		info.EnvError = err.Error()
	} else {
		info.Python, info.Bundled = env.Python, env.Bundled
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
	if st.Concurrency > 10 {
		st.Concurrency = 10
	}
	st.AIBaseURL = strings.TrimSpace(st.AIBaseURL)
	st.AIModel = strings.TrimSpace(st.AIModel)
	st.BrowserPath = strings.TrimSpace(st.BrowserPath)
	if st.BrowserPath != "" {
		if _, err := os.Stat(st.BrowserPath); err != nil {
			return st, errors.New("浏览器路径不存在")
		}
	}
	if err := s.M.Store.SetSetting("settings", st); err != nil {
		return st, err
	}
	if clearKey {
		if err := s.M.Store.SetSecretSetting("ai_api_key", ""); err != nil {
			return st, err
		}
	} else if k := strings.TrimSpace(aiKey); k != "" {
		if err := s.M.Store.SetSecretSetting("ai_api_key", k); err != nil {
			return st, err
		}
	}
	return s.M.Settings(), nil
}

// TestAI sends a tiny prompt to the AI endpoint. An empty key uses the saved one.
func (s *AppService) TestAI(ctx context.Context, baseURL, model, key string) (*core.CallResult, error) {
	if key == "" {
		key, _ = s.M.Store.GetSecretSetting("ai_api_key")
	}
	return s.M.Call(ctx, core.JobSpec{Platform: "engine", Action: "ai_test",
		AIOverride: map[string]any{"enabled": true, "base_url": baseURL, "model": model, "api_key": key}})
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
	order := []string{"xuetangx", "icve_ai", "icve_mooc", "weban", "diagnostic"}
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

// OpenDataDir reveals the data directory in the file manager.
func (s *AppService) OpenDataDir() { s.M.OpenPath(s.M.DataDir) }
