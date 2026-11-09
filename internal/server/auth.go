// SPDX-License-Identifier: AGPL-3.0-or-later

package server

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	cookieName = "shuake_session"
	sessionTTL = 30 * 24 * time.Hour
)

// auth is a single shared admin password with stateless signed session
// cookies. The signing key lives in the data dir so sessions survive restarts;
// it is mixed with the password so changing the password logs everyone out.
type auth struct {
	password string // empty = authentication disabled
	key      []byte

	mu       sync.Mutex
	failures map[string][]time.Time
}

func newAuth(dataDir, password string) (*auth, error) {
	a := &auth{password: password, failures: map[string][]time.Time{}}
	if password == "" {
		return a, nil
	}
	keyFile := filepath.Join(dataDir, ".session.key")
	if b, err := os.ReadFile(keyFile); err == nil && len(b) >= 32 {
		a.key = b
	} else {
		a.key = make([]byte, 32)
		if _, err := rand.Read(a.key); err != nil {
			return nil, err
		}
		if err := os.WriteFile(keyFile, a.key, 0o600); err != nil {
			return nil, err
		}
	}
	return a, nil
}

func (a *auth) enabled() bool { return a.password != "" }

func (a *auth) sign(exp int64) string {
	m := hmac.New(sha256.New, a.key)
	m.Write([]byte(strconv.FormatInt(exp, 10)))
	m.Write([]byte{0})
	m.Write([]byte(a.password))
	return hex.EncodeToString(m.Sum(nil))
}

func (a *auth) valid(r *http.Request) bool {
	if !a.enabled() {
		return true
	}
	c, err := r.Cookie(cookieName)
	if err != nil {
		return false
	}
	expStr, sig, ok := strings.Cut(c.Value, ".")
	if !ok {
		return false
	}
	exp, err := strconv.ParseInt(expStr, 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return false
	}
	return hmac.Equal([]byte(sig), []byte(a.sign(exp)))
}

func secureRequest(r *http.Request) bool {
	return r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

func (a *auth) setCookie(w http.ResponseWriter, r *http.Request) {
	exp := time.Now().Add(sessionTTL).Unix()
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: strconv.FormatInt(exp, 10) + "." + a.sign(exp),
		Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: secureRequest(r),
		Expires: time.Unix(exp, 0),
	})
}

func clearCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true,
		SameSite: http.SameSiteLaxMode, Secure: secureRequest(r)})
}

// allow implements a small per-IP throttle: 10 failures per 10 minutes.
func (a *auth) allow(ip string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	cut := time.Now().Add(-10 * time.Minute)
	list := a.failures[ip][:0]
	for _, t := range a.failures[ip] {
		if t.After(cut) {
			list = append(list, t)
		}
	}
	a.failures[ip] = list
	return len(list) < 10
}

func (a *auth) fail(ip string) {
	a.mu.Lock()
	a.failures[ip] = append(a.failures[ip], time.Now())
	a.mu.Unlock()
}

func (a *auth) check(pw string) bool {
	return subtle.ConstantTimeCompare([]byte(pw), []byte(a.password)) == 1
}
