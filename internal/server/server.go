// SPDX-License-Identifier: AGPL-3.0-or-later

// Package server serves the web UI and a JSON API over HTTP, so the app can
// run headless (e.g. in Docker) and be managed from a browser.
package server

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shuake/aio/internal/core"
	"github.com/shuake/aio/internal/services"
)

// Options configure the server.
type Options struct {
	Version  string
	Password string // admin password; empty disables auth
	Assets   fs.FS  // built frontend (dist/)
}

// Server is the HTTP front end of a core.Manager.
type Server struct {
	m     *core.Manager
	opts  Options
	hub   *hub
	auth  *auth
	rpc   *rpc
	index []byte
	files http.Handler
	gz    sync.Map // asset path -> gzipped bytes, built on first request
}

// New wires a manager to HTTP. It replaces the manager's Emit/OpenURL hooks.
func New(m *core.Manager, opts Options) (*Server, error) {
	a, err := newAuth(m.DataDir, opts.Password)
	if err != nil {
		return nil, err
	}
	s := &Server{m: m, opts: opts, hub: newHub(), auth: a, rpc: newRPC()}
	m.ServerMode = true
	m.Emit = s.hub.Emit
	// There is no local browser: let the UI show the link instead.
	m.OpenURL = func(u string) { s.hub.Emit("app:open_url", map[string]string{"url": u}) }
	m.OpenPath = func(string) {}

	s.rpc.register("AccountService", &services.AccountService{M: m})
	s.rpc.register("TaskService", &services.TaskService{M: m})
	s.rpc.register("AppService", &services.AppService{M: m, Version: opts.Version}, "OpenDataDir")

	if opts.Assets != nil {
		idx, err := fs.ReadFile(opts.Assets, "index.html")
		if err != nil {
			return nil, err
		}
		// Tell the SPA it talks to the HTTP API instead of Wails bindings.
		s.index = bytes.Replace(idx, []byte("<head>"), []byte(`<head><script>window.__SHUAKE_SERVER__=true</script>`), 1)
		s.files = http.FileServer(http.FS(opts.Assets))
	}
	return s, nil
}

// Handler returns the root HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "clients": s.hub.count()})
	})
	mux.HandleFunc("GET /api/session", s.session)
	mux.HandleFunc("POST /api/login", s.login)
	mux.HandleFunc("POST /api/logout", func(w http.ResponseWriter, r *http.Request) {
		clearCookie(w, r)
		writeJSON(w, 200, map[string]any{"ok": true})
	})
	mux.Handle("GET /api/events", s.guard(http.HandlerFunc(s.hub.serve)))
	mux.Handle("POST /api/{service}/{method}", s.guard(http.HandlerFunc(s.call)))
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 404, map[string]string{"message": "not found"})
	})
	mux.HandleFunc("/", s.static)
	return securityHeaders(mux)
}

func securityHeaders(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Set("X-Content-Type-Options", "nosniff")
		hd.Set("X-Frame-Options", "DENY")
		hd.Set("Referrer-Policy", "same-origin")
		h.ServeHTTP(w, r)
	})
}

func (s *Server) guard(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.auth.valid(r) {
			writeJSON(w, 401, map[string]string{"message": "请先登录"})
			return
		}
		// CSRF: browsers cannot add custom headers cross-site without a CORS
		// preflight, which this server never approves.
		if r.Method != http.MethodGet && r.Header.Get("X-Requested-With") != "shuake" {
			writeJSON(w, 403, map[string]string{"message": "缺少请求头"})
			return
		}
		h.ServeHTTP(w, r)
	})
}

func (s *Server) session(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{
		"authed":       s.auth.valid(r),
		"authRequired": s.auth.enabled(),
		"version":      s.opts.Version,
	})
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if !s.auth.enabled() {
		writeJSON(w, 200, map[string]any{"ok": true})
		return
	}
	ip := clientIP(r)
	if !s.auth.allow(ip) {
		writeJSON(w, 429, map[string]string{"message": "尝试次数过多，请 10 分钟后再试"})
		return
	}
	var body struct {
		Password string `json:"password"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body)
	if !s.auth.check(body.Password) {
		s.auth.fail(ip)
		time.Sleep(700 * time.Millisecond)
		writeJSON(w, 401, map[string]string{"message": "密码错误"})
		return
	}
	s.auth.setCookie(w, r)
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) call(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 16<<20))
	if err != nil {
		writeJSON(w, 400, map[string]string{"message": err.Error()})
		return
	}
	// Long calls (QR login, course listing) must not die with the HTTP
	// request: a page reload would otherwise kill a half finished login.
	// They stay cancellable through TaskService.CancelJob.
	ctx := context.WithoutCancel(r.Context())
	name := r.PathValue("service") + "/" + r.PathValue("method")
	res, err := s.rpc.call(ctx, name, body)
	if err != nil {
		writeJSON(w, statusOf(err), map[string]string{"message": err.Error()})
		return
	}
	writeJSON(w, 200, res)
}

func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	if s.files == nil {
		http.Error(w, "web UI not built", http.StatusNotFound)
		return
	}
	p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if p != "" && p != "index.html" {
		if f, err := s.opts.Assets.Open(p); err == nil {
			f.Close()
			if strings.HasPrefix(p, "assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			if s.serveGzip(w, r, p) {
				return
			}
			s.files.ServeHTTP(w, r)
			return
		}
	}
	// SPA fallback
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(s.index)
}

var compressible = map[string]bool{".js": true, ".css": true, ".svg": true, ".json": true, ".html": true, ".txt": true, ".map": true}

// serveGzip sends a gzip-compressed copy of a text asset (the JS bundle is
// ~1.3 MB raw, ~0.4 MB compressed). It reports false when the client or the
// file type does not qualify, so the caller serves the file as is.
func (s *Server) serveGzip(w http.ResponseWriter, r *http.Request, p string) bool {
	ext := path.Ext(p)
	if !compressible[ext] || !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") || r.Header.Get("Range") != "" {
		return false
	}
	var body []byte
	if v, ok := s.gz.Load(p); ok {
		body = v.([]byte)
	} else {
		raw, err := fs.ReadFile(s.opts.Assets, p)
		if err != nil || len(raw) < 1024 {
			return false
		}
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
		_, _ = zw.Write(raw)
		_ = zw.Close()
		body = buf.Bytes()
		s.gz.Store(p, body)
	}
	if ct := mime.TypeByExtension(ext); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.Header().Set("Content-Encoding", "gzip")
	w.Header().Set("Vary", "Accept-Encoding")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		log.Printf("encode response: %v", err)
	}
}
