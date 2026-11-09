// SPDX-License-Identifier: AGPL-3.0-or-later

package server

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/shuake/aio/internal/core"
	"github.com/shuake/aio/internal/store"
)

func newTestServer(t *testing.T) (*httptest.Server, *core.Manager) {
	t.Helper()
	t.Setenv("SHUAKE_NO_KEYCHAIN", "1")
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	m := core.NewManager(st, dir, nil, nil)
	t.Cleanup(m.Shutdown)
	assets := fstest.MapFS{
		"index.html":    {Data: []byte("<html><head><title>x</title></head><body></body></html>")},
		"assets/app.js": {Data: []byte("console.log(1)")},
		"assets/big.js": {Data: []byte(strings.Repeat("console.log('hello');\n", 500))},
	}
	s, err := New(m, Options{Version: "test", Password: "secret", Assets: assets})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts, m
}

func newClient(t *testing.T) *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{Jar: jar, Timeout: 10 * time.Second}
}

func post(t *testing.T, c *http.Client, url, body string, csrf bool) (int, []byte) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if csrf {
		req.Header.Set("X-Requested-With", "shuake")
	}
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, b
}

func login(t *testing.T, ts *httptest.Server, c *http.Client) {
	t.Helper()
	if code, b := post(t, c, ts.URL+"/api/login", `{"password":"secret"}`, false); code != 200 {
		t.Fatalf("login: %d %s", code, b)
	}
}

func TestAuthAndCSRF(t *testing.T) {
	ts, _ := newTestServer(t)
	c := newClient(t)

	if code, _ := post(t, c, ts.URL+"/api/AppService/Platforms", "[]", true); code != 401 {
		t.Fatalf("unauthenticated call: want 401, got %d", code)
	}
	if code, _ := post(t, c, ts.URL+"/api/login", `{"password":"nope"}`, false); code != 401 {
		t.Fatalf("wrong password: want 401, got %d", code)
	}
	login(t, ts, c)
	if code, _ := post(t, c, ts.URL+"/api/AppService/Platforms", "[]", false); code != 403 {
		t.Fatalf("missing csrf header: want 403, got %d", code)
	}
	code, b := post(t, c, ts.URL+"/api/AppService/Platforms", "[]", true)
	if code != 200 || !strings.Contains(string(b), `"zhihuishu"`) {
		t.Fatalf("platforms: %d %s", code, b)
	}
	if code, _ := post(t, c, ts.URL+"/api/AppService/Nope", "[]", true); code != 404 {
		t.Fatalf("unknown method: want 404, got %d", code)
	}
	if code, _ := post(t, c, ts.URL+"/api/AppService/OpenDataDir", "[]", true); code != 404 {
		t.Fatalf("desktop-only method must not be exposed, got %d", code)
	}

	// session survives, logout clears it
	res, _ := c.Get(ts.URL + "/api/session")
	var sess map[string]any
	_ = json.NewDecoder(res.Body).Decode(&sess)
	res.Body.Close()
	if sess["authed"] != true {
		t.Fatalf("session: %v", sess)
	}
	post(t, c, ts.URL+"/api/logout", "{}", false)
	if code, _ := post(t, c, ts.URL+"/api/AppService/Platforms", "[]", true); code != 401 {
		t.Fatalf("after logout: want 401, got %d", code)
	}
}

func TestRPCArgumentsAndErrors(t *testing.T) {
	ts, _ := newTestServer(t)
	c := newClient(t)
	login(t, ts, c)

	rows := `["diagnostic", [{"name":"甲","fields":{"username":"a"},"secret":{}},{"name":"乙","fields":{"username":"b"},"secret":{}}]]`
	code, b := post(t, c, ts.URL+"/api/AccountService/Import", rows, true)
	if code != 200 {
		t.Fatalf("import: %d %s", code, b)
	}
	var res struct {
		Created, Skipped int
		IDs              []string
	}
	_ = json.Unmarshal(b, &res)
	if res.Created != 2 || len(res.IDs) != 2 {
		t.Fatalf("import result: %s", b)
	}
	_, b = post(t, c, ts.URL+"/api/AccountService/Import", rows, true)
	_ = json.Unmarshal(b, &res)
	if res.Created != 0 || res.Skipped != 2 {
		t.Fatalf("duplicate import should be skipped: %s", b)
	}

	if code, b := post(t, c, ts.URL+"/api/AccountService/Create", `["nope","x",{},{}]`, true); code != 422 || !strings.Contains(string(b), "未知平台") {
		t.Fatalf("service error: %d %s", code, b)
	}
	if code, _ := post(t, c, ts.URL+"/api/AccountService/Create", `{"not":"array"}`, true); code != 400 {
		t.Fatalf("bad body: want 400, got %d", code)
	}
	if code, b := post(t, c, ts.URL+"/api/TaskService/StartBatch", `[{"accountIds":[],"mode":"all"}]`, true); code != 422 || !strings.Contains(string(b), "没有选择账号") {
		t.Fatalf("batch validation: %d %s", code, b)
	}
}

func TestEventsStream(t *testing.T) {
	ts, _ := newTestServer(t)
	c := newClient(t)
	login(t, ts, c)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/api/events", nil)
	res, err := (&http.Client{Jar: c.Jar}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if ct := res.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content type %q", ct)
	}
	got := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(res.Body)
		for sc.Scan() {
			if line := sc.Text(); strings.HasPrefix(line, "data: ") {
				got <- line
				return
			}
		}
	}()
	time.Sleep(100 * time.Millisecond) // let the client register
	post(t, c, ts.URL+"/api/AccountService/Create", `["diagnostic","丙",{"username":"c"},{}]`, true)
	select {
	case line := <-got:
		if !strings.Contains(line, `"account:update"`) || !strings.Contains(line, "丙") {
			t.Fatalf("event: %s", line)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no event received")
	}
}

func TestStaticAndSPAFallback(t *testing.T) {
	ts, _ := newTestServer(t)
	for _, p := range []string{"/", "/accounts/whatever"} {
		res, err := http.Get(ts.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if !strings.Contains(string(b), "window.__SHUAKE_SERVER__=true") {
			t.Fatalf("%s: server flag not injected: %s", p, b)
		}
	}
	res, _ := http.Get(ts.URL + "/assets/app.js")
	if cc := res.Header.Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Fatalf("asset cache header %q", cc)
	}
	res.Body.Close()
}

func TestGzipAssets(t *testing.T) {
	ts, _ := newTestServer(t)
	tr := &http.Transport{DisableCompression: true}
	get := func(enc string) (*http.Response, []byte) {
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/assets/big.js", nil)
		if enc != "" {
			req.Header.Set("Accept-Encoding", enc)
		}
		res, err := (&http.Client{Transport: tr}).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res, b
	}
	res, b := get("gzip, br")
	if res.Header.Get("Content-Encoding") != "gzip" || len(b) >= 11000 || !strings.Contains(res.Header.Get("Content-Type"), "javascript") {
		t.Fatalf("gzip: enc=%q len=%d ct=%q", res.Header.Get("Content-Encoding"), len(b), res.Header.Get("Content-Type"))
	}
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	plain, _ := io.ReadAll(zr)
	if len(plain) != 11000 {
		t.Fatalf("decompressed %d bytes", len(plain))
	}
	res, b = get("")
	if res.Header.Get("Content-Encoding") != "" || len(b) != 11000 {
		t.Fatalf("identity: enc=%q len=%d", res.Header.Get("Content-Encoding"), len(b))
	}
}
