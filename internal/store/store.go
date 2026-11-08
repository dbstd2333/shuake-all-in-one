// SPDX-License-Identifier: AGPL-3.0-or-later

// Package store persists accounts, task history and settings in SQLite.
// Account credentials and API keys are encrypted (see crypto.go).
package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

// ErrNotFound is returned when a row does not exist.
var ErrNotFound = errors.New("not found")

// Account is a platform login. Credentials are never sent to the frontend.
type Account struct {
	ID        string         `json:"id"`
	Platform  string         `json:"platform"`
	Name      string         `json:"name"`
	Fields    map[string]any `json:"fields"` // non-secret: tenant_name, username...
	User      map[string]any `json:"user"`   // display info returned by the engine
	Status    string         `json:"status"` // new | ok | invalid
	HasSecret bool           `json:"hasSecret"`
	CreatedAt int64          `json:"createdAt"`
	UpdatedAt int64          `json:"updatedAt"`
}

// Task is a recorded run.
type Task struct {
	ID         string         `json:"id"`
	AccountID  string         `json:"accountId"`
	Platform   string         `json:"platform"`
	Title      string         `json:"title"`
	Options    map[string]any `json:"options"`
	Status     string         `json:"status"` // queued | running | success | failed | cancelled
	Summary    map[string]any `json:"summary"`
	Error      string         `json:"error"`
	CreatedAt  int64          `json:"createdAt"`
	StartedAt  int64          `json:"startedAt"`
	FinishedAt int64          `json:"finishedAt"`
}

// Store wraps the database.
type Store struct {
	db      *sql.DB
	sealer  *sealer
	DataDir string
}

const schema = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  fields TEXT NOT NULL DEFAULT '{}',
  user TEXT NOT NULL DEFAULT '{}',
  secret BLOB,
  status TEXT NOT NULL DEFAULT 'new',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL DEFAULT 0,
  finished_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tasks_created ON tasks(created_at DESC);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  secret BLOB
);
`

// Open opens (and migrates) the database in dataDir.
func Open(dataDir string) (*Store, error) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dataDir, "shuake.db")+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("初始化数据库失败: %w", err)
	}
	s, err := newSealer(dataDir)
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("初始化密钥失败: %w", err)
	}
	// Tasks left running by a crash are not running any more.
	_, _ = db.Exec(`UPDATE tasks SET status='failed', error='应用异常退出' WHERE status IN ('queued','running')`)
	return &Store{db: db, sealer: s, DataDir: dataDir}, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

// KeyBackend tells where the master key is stored ("keychain" or "file").
func (s *Store) KeyBackend() string { return s.sealer.backend }

// NewID returns a random 16 hex char id.
func NewID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func mustJSON(v any) string {
	if v == nil {
		return "{}"
	}
	b, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(b)
}

func fromJSON(s string) map[string]any {
	m := map[string]any{}
	_ = json.Unmarshal([]byte(s), &m)
	return m
}

// ---------------------------------------------------------------- accounts

func (s *Store) scanAccount(row interface{ Scan(...any) error }) (*Account, error) {
	var a Account
	var fields, user string
	var secret []byte
	if err := row.Scan(&a.ID, &a.Platform, &a.Name, &fields, &user, &secret, &a.Status, &a.CreatedAt, &a.UpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	a.Fields = fromJSON(fields)
	a.User = fromJSON(user)
	a.HasSecret = len(secret) > 0
	return &a, nil
}

const accountCols = `id, platform, name, fields, user, secret, status, created_at, updated_at`

// ListAccounts returns all accounts, newest first.
func (s *Store) ListAccounts() ([]*Account, error) {
	rows, err := s.db.Query(`SELECT ` + accountCols + ` FROM accounts ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Account{}
	for rows.Next() {
		a, err := s.scanAccount(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// GetAccount loads one account.
func (s *Store) GetAccount(id string) (*Account, error) {
	return s.scanAccount(s.db.QueryRow(`SELECT `+accountCols+` FROM accounts WHERE id=?`, id))
}

// CreateAccount inserts a new account with an initial secret map.
func (s *Store) CreateAccount(platform, name string, fields, secret map[string]any) (*Account, error) {
	now := time.Now().Unix()
	id := NewID()
	enc, err := s.sealJSON(secret)
	if err != nil {
		return nil, err
	}
	if _, err := s.db.Exec(`INSERT INTO accounts (id, platform, name, fields, user, secret, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
		id, platform, name, mustJSON(fields), "{}", enc, "new", now, now); err != nil {
		return nil, err
	}
	return s.GetAccount(id)
}

// UpdateAccount updates the editable columns.
func (s *Store) UpdateAccount(a *Account) error {
	_, err := s.db.Exec(`UPDATE accounts SET name=?, fields=?, user=?, status=?, updated_at=? WHERE id=?`,
		a.Name, mustJSON(a.Fields), mustJSON(a.User), a.Status, time.Now().Unix(), a.ID)
	return err
}

// DeleteAccount removes an account and its task history.
func (s *Store) DeleteAccount(id string) error {
	if _, err := s.db.Exec(`DELETE FROM tasks WHERE account_id=?`, id); err != nil {
		return err
	}
	_, err := s.db.Exec(`DELETE FROM accounts WHERE id=?`, id)
	return err
}

func (s *Store) sealJSON(m map[string]any) ([]byte, error) {
	if len(m) == 0 {
		return nil, nil
	}
	b, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	return s.sealer.seal(b)
}

// Secret returns the decrypted credential map of an account.
func (s *Store) Secret(id string) (map[string]any, error) {
	var blob []byte
	if err := s.db.QueryRow(`SELECT secret FROM accounts WHERE id=?`, id).Scan(&blob); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	plain, err := s.sealer.open(blob)
	if err != nil {
		return nil, fmt.Errorf("凭证解密失败（钥匙串密钥可能已变化）: %w", err)
	}
	m := map[string]any{}
	if len(plain) > 0 {
		_ = json.Unmarshal(plain, &m)
	}
	return m, nil
}

// MergeSecret merges patch into the stored credential map (nil values delete keys).
func (s *Store) MergeSecret(id string, patch map[string]any) error {
	cur, err := s.Secret(id)
	if err != nil {
		cur = map[string]any{}
	}
	for k, v := range patch {
		if v == nil {
			delete(cur, k)
		} else {
			cur[k] = v
		}
	}
	enc, err := s.sealJSON(cur)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`UPDATE accounts SET secret=?, updated_at=? WHERE id=?`, enc, time.Now().Unix(), id)
	return err
}

// ---------------------------------------------------------------- tasks

const taskCols = `id, account_id, platform, title, options, status, summary, error, created_at, started_at, finished_at`

func scanTask(row interface{ Scan(...any) error }) (*Task, error) {
	var t Task
	var opts, summary string
	if err := row.Scan(&t.ID, &t.AccountID, &t.Platform, &t.Title, &opts, &t.Status, &summary, &t.Error, &t.CreatedAt, &t.StartedAt, &t.FinishedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	t.Options = fromJSON(opts)
	t.Summary = fromJSON(summary)
	return &t, nil
}

// InsertTask records a new task.
func (s *Store) InsertTask(t *Task) error {
	if t.CreatedAt == 0 {
		t.CreatedAt = time.Now().Unix()
	}
	_, err := s.db.Exec(`INSERT INTO tasks (`+taskCols+`) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		t.ID, t.AccountID, t.Platform, t.Title, mustJSON(t.Options), t.Status, mustJSON(t.Summary), t.Error, t.CreatedAt, t.StartedAt, t.FinishedAt)
	return err
}

// UpdateTask saves status/summary/error/timestamps.
func (s *Store) UpdateTask(t *Task) error {
	_, err := s.db.Exec(`UPDATE tasks SET status=?, summary=?, error=?, started_at=?, finished_at=? WHERE id=?`,
		t.Status, mustJSON(t.Summary), t.Error, t.StartedAt, t.FinishedAt, t.ID)
	return err
}

// GetTask loads one task.
func (s *Store) GetTask(id string) (*Task, error) {
	return scanTask(s.db.QueryRow(`SELECT `+taskCols+` FROM tasks WHERE id=?`, id))
}

// ListTasks returns the latest tasks.
func (s *Store) ListTasks(limit int) ([]*Task, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.db.Query(`SELECT `+taskCols+` FROM tasks ORDER BY created_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Task{}
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// DeleteTask removes a finished task record.
func (s *Store) DeleteTask(id string) error {
	_, err := s.db.Exec(`DELETE FROM tasks WHERE id=? AND status NOT IN ('queued','running')`, id)
	return err
}

// ---------------------------------------------------------------- settings

// GetSetting decodes the JSON value of key into out. Missing keys leave out unchanged.
func (s *Store) GetSetting(key string, out any) error {
	var v string
	err := s.db.QueryRow(`SELECT value FROM settings WHERE key=?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return json.Unmarshal([]byte(v), out)
}

// SetSetting stores v as JSON under key.
func (s *Store) SetSetting(key string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, string(b))
	return err
}

// GetSecretSetting returns a decrypted secret setting ("" if unset).
func (s *Store) GetSecretSetting(key string) (string, error) {
	var blob []byte
	err := s.db.QueryRow(`SELECT secret FROM settings WHERE key=?`, key).Scan(&blob)
	if errors.Is(err, sql.ErrNoRows) || len(blob) == 0 {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	p, err := s.sealer.open(blob)
	return string(p), err
}

// SetSecretSetting encrypts and stores a secret setting.
func (s *Store) SetSecretSetting(key, value string) error {
	var enc []byte
	if value != "" {
		var err error
		if enc, err = s.sealer.seal([]byte(value)); err != nil {
			return err
		}
	}
	_, err := s.db.Exec(`INSERT INTO settings (key, value, secret) VALUES (?, '""', ?) ON CONFLICT(key) DO UPDATE SET secret=excluded.secret`, key, enc)
	return err
}
