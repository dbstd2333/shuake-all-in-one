// SPDX-License-Identifier: AGPL-3.0-or-later

package store

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

var setenv = os.Setenv

func TestSecretRoundTrip(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a, err := s.CreateAccount("weban", "n", map[string]any{"username": "x"}, map[string]any{"password": "p@ss"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.MergeSecret(a.ID, map[string]any{"token": "t", "password": nil}); err != nil {
		t.Fatal(err)
	}
	sec, err := s.Secret(a.ID)
	if err != nil || sec["token"] != "t" || sec["password"] != nil {
		t.Fatalf("got %v %v", sec, err)
	}
	var raw []byte
	_ = s.db.QueryRow(`SELECT secret FROM accounts WHERE id=?`, a.ID).Scan(&raw)
	if string(raw) == `{"token":"t"}` {
		t.Fatal("secret stored in plain text")
	}
	if err := s.SetSecretSetting("k", "v"); err != nil {
		t.Fatal(err)
	}
	if v, _ := s.GetSecretSetting("k"); v != "v" {
		t.Fatalf("secret setting = %q", v)
	}
}

func init() { _ = setenv("SHUAKE_NO_KEYCHAIN", "1") }

func TestMigrateOldTasksTable(t *testing.T) {
	dir := t.TempDir()
	old, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "shuake.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, platform TEXT NOT NULL,
		title TEXT NOT NULL DEFAULT '', options TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '{}',
		error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, started_at INTEGER NOT NULL DEFAULT 0, finished_at INTEGER NOT NULL DEFAULT 0);
		INSERT INTO tasks (id, account_id, platform, status, created_at) VALUES ('old', 'a', 'weban', 'success', 1)`); err != nil {
		t.Fatal(err)
	}
	old.Close()
	for i := 0; i < 2; i++ { // second open: migration must be idempotent
		s, err := Open(dir)
		if err != nil {
			t.Fatal(err)
		}
		task, err := s.GetTask("old")
		if err != nil || task.RxBytes != 0 {
			t.Fatalf("old task: %+v %v", task, err)
		}
		if err := s.AddTraffic([]TrafficRow{{Day: "2026-11-09", Scope: "system", Rx: 10, Tx: 1}}); err != nil {
			t.Fatal(err)
		}
		s.Close()
	}
	s, _ := Open(dir)
	defer s.Close()
	rows, _ := s.TrafficSince("2026-11-01")
	if len(rows) != 1 || rows[0].Rx != 20 || rows[0].Tx != 2 {
		t.Fatalf("traffic rows %+v", rows)
	}
}
