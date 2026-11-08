// SPDX-License-Identifier: AGPL-3.0-or-later

package store

import (
	"os"
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
