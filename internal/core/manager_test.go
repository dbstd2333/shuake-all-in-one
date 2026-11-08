// SPDX-License-Identifier: AGPL-3.0-or-later

package core

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/shuake/aio/internal/store"
)

func init() { _ = os.Setenv("SHUAKE_NO_KEYCHAIN", "1") }

func setup(t *testing.T) (*Manager, chan EngineEvent) {
	t.Helper()
	root, _ := filepath.Abs("../..")
	py := filepath.Join(root, "build", "runtime", runtime.GOOS+"-"+runtime.GOARCH, "python", "bin", "python3")
	if runtime.GOOS == "windows" {
		py = filepath.Join(root, "build", "runtime", runtime.GOOS+"-"+runtime.GOARCH, "python", "python.exe")
	}
	if _, err := os.Stat(py); err != nil {
		t.Skip("bundled runtime not prepared: run scripts/prepare_runtime.py")
	}
	t.Setenv("SHUAKE_PYTHON", py)
	t.Setenv("SHUAKE_ENGINE", filepath.Join(root, "engine"))
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	events := make(chan EngineEvent, 1000)
	var mu sync.Mutex
	m := NewManager(st, dir, func(name string, data any) {
		mu.Lock()
		defer mu.Unlock()
		if ev, ok := data.(EngineEvent); ok {
			events <- ev
		}
	}, nil)
	t.Cleanup(m.Shutdown)
	return m, events
}

func TestLoginRequestReplyAndCredential(t *testing.T) {
	m, events := setup(t)
	acc, err := m.Store.CreateAccount("diagnostic", "", map[string]any{"username": "u1"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for ev := range events {
			if ev.Msg["type"] == "request" && ev.Msg["kind"] == "captcha_image" {
				_ = m.Reply(ev.JobID, ev.Msg["id"].(string), "abcd")
				return
			}
		}
	}()
	res, err := m.Call(context.Background(), JobSpec{Action: "login", AccountID: acc.ID})
	if err != nil || res.Code != 0 {
		t.Fatalf("login failed: %v %+v", err, res)
	}
	sec, _ := m.Store.Secret(acc.ID)
	if sec["token"] != "diag-abcd" {
		t.Fatalf("credential not stored: %v", sec)
	}
	acc, _ = m.Store.GetAccount(acc.ID)
	if acc.Status != "ok" || acc.Name != "u1" {
		t.Fatalf("account not updated: %+v", acc)
	}
}

func TestTaskRunAndCancel(t *testing.T) {
	m, _ := setup(t)
	acc, _ := m.Store.CreateAccount("diagnostic", "d", nil, nil)
	done, err := m.StartTask(acc.ID, "ok", map[string]any{"course_ids": []string{"1"}, "steps": 2})
	if err != nil {
		t.Fatal(err)
	}
	long, _ := m.StartTask(acc.ID, "long", map[string]any{"steps": 200})
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		t1, _ := m.Store.GetTask(done.ID)
		t2, _ := m.Store.GetTask(long.ID)
		if t2.Status == "running" && t1.Status == "success" {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	m.CancelTask(long.ID)
	for time.Now().Before(deadline) {
		if t2, _ := m.Store.GetTask(long.ID); t2.Status == "cancelled" {
			logs, _ := m.TaskLogs(long.ID, 10)
			if len(logs) == 0 {
				t.Fatal("expected task log records")
			}
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t1, _ := m.Store.GetTask(done.ID)
	t2, _ := m.Store.GetTask(long.ID)
	t.Fatalf("unexpected states: %s %s", t1.Status, t2.Status)
}

func TestQueuedTaskCancel(t *testing.T) {
	m, _ := setup(t)
	_ = m.Store.SetSetting("settings", Settings{Concurrency: 1})
	acc, _ := m.Store.CreateAccount("diagnostic", "d", nil, nil)
	a, _ := m.StartTask(acc.ID, "a", map[string]any{"steps": 200})
	b, _ := m.StartTask(acc.ID, "b", map[string]any{"steps": 2})
	time.Sleep(1500 * time.Millisecond)
	if tb, _ := m.Store.GetTask(b.ID); tb.Status != "queued" {
		t.Fatalf("b should be queued, got %s", tb.Status)
	}
	m.CancelTask(b.ID)
	m.CancelTask(a.ID)
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		ta, _ := m.Store.GetTask(a.ID)
		tb, _ := m.Store.GetTask(b.ID)
		if ta.Status == "cancelled" && tb.Status == "cancelled" {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatal("tasks were not cancelled")
}
