// SPDX-License-Identifier: AGPL-3.0-or-later
//
// shuake-server — 刷课 All-in-One 的服务端版本：无界面运行，用浏览器管理多个账号与任务。
// Copyright (C) 2026 contributors. Licensed under the GNU AGPL v3 or later.
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/shuake/aio/frontend"
	"github.com/shuake/aio/internal/core"
	"github.com/shuake/aio/internal/server"
	"github.com/shuake/aio/internal/store"
)

// Version is overridden at build time with -ldflags "-X main.Version=...".
var Version = "0.1.0"

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

// adminPassword returns the configured password, or a generated one that is
// kept in the data dir (and printed) so the first start works out of the box.
func adminPassword(dir string) string {
	if strings.EqualFold(os.Getenv("SHUAKE_AUTH"), "off") {
		log.Print("警告：SHUAKE_AUTH=off，已关闭登录验证，请确保只在可信网络中访问")
		return ""
	}
	if pw := os.Getenv("SHUAKE_ADMIN_PASSWORD"); pw != "" {
		return pw
	}
	file := filepath.Join(dir, ".admin-password")
	if b, err := os.ReadFile(file); err == nil && len(strings.TrimSpace(string(b))) > 0 {
		pw := strings.TrimSpace(string(b))
		log.Printf("管理员密码保存在 %s（设置 SHUAKE_ADMIN_PASSWORD 可自定义）", file)
		return pw
	}
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		log.Fatal(err)
	}
	pw := base64.RawURLEncoding.EncodeToString(b)
	if err := os.WriteFile(file, []byte(pw+"\n"), 0o600); err != nil {
		log.Fatal(err)
	}
	log.Printf("已生成管理员密码：%s（保存在 %s，设置 SHUAKE_ADMIN_PASSWORD 可自定义）", pw, file)
	return pw
}

func main() {
	log.SetFlags(log.LstdFlags)
	dir := env("SHUAKE_DATA_DIR", "data")
	if abs, err := filepath.Abs(dir); err == nil {
		dir = abs
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		log.Fatal(err)
	}
	// No desktop keychain on a server: the master key is SHUAKE_MASTER_KEY or a key file.
	if os.Getenv("SHUAKE_NO_KEYCHAIN") == "" {
		_ = os.Setenv("SHUAKE_NO_KEYCHAIN", "1")
	}

	st, err := store.Open(dir)
	if err != nil {
		log.Fatal(err)
	}
	defer st.Close()

	mgr := core.NewManager(st, dir, nil, nil)
	assets, err := fs.Sub(frontend.Dist, "dist")
	if err != nil {
		log.Fatal(err)
	}
	srv, err := server.New(mgr, server.Options{Version: Version, Password: adminPassword(dir), Assets: assets})
	if err != nil {
		log.Fatal(err)
	}
	if e, err := mgr.Env(); err != nil {
		log.Printf("警告：Python 引擎不可用：%v", err)
	} else {
		log.Printf("Python 引擎：%s", e.Python)
	}
	if e, err := mgr.NodeEnv(); err != nil {
		log.Printf("警告：智慧树引擎不可用：%v", err)
	} else {
		log.Printf("智慧树引擎：%s %s", e.Python, e.Bootstrap)
	}

	addr := env("SHUAKE_LISTEN", ":8080")
	hs := &http.Server{
		Addr:              addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		log.Printf("刷课 All-in-One %s 已启动：http://%s （数据目录 %s）", Version, displayAddr(addr), dir)
		if err := hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Print("正在停止：结束所有任务…")
	mgr.Shutdown()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = hs.Shutdown(ctx)
}

func displayAddr(addr string) string {
	if strings.HasPrefix(addr, ":") {
		return "localhost" + addr
	}
	return addr
}
