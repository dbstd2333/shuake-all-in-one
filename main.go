// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 刷课 All-in-One — desktop front end for several course automation engines.
// Copyright (C) 2026 contributors. Licensed under the GNU AGPL v3 or later.
package main

import (
	"embed"
	"log"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/shuake/aio/internal/core"
	"github.com/shuake/aio/internal/services"
	"github.com/shuake/aio/internal/store"
)

// Version is overridden at build time with -ldflags "-X main.Version=...".
var Version = "0.1.0"

//go:embed all:frontend/dist
var assets embed.FS

func dataDir() string {
	if d := os.Getenv("SHUAKE_DATA_DIR"); d != "" {
		return d
	}
	base, err := os.UserConfigDir()
	if err != nil {
		base = "."
	}
	return filepath.Join(base, "ShuakeAIO")
}

func main() {
	dir := dataDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		log.Fatal(err)
	}
	st, err := store.Open(dir)
	if err != nil {
		log.Fatal(err)
	}
	defer st.Close()

	mgr := core.NewManager(st, dir, nil, nil)

	app := application.New(application.Options{
		Name:        "刷课 All-in-One",
		Description: "学堂在线 / 智慧职教 / 安全微伴 一站式刷课工具",
		Services: []application.Service{
			application.NewService(&services.AccountService{M: mgr}),
			application.NewService(&services.TaskService{M: mgr}),
			application.NewService(&services.AppService{M: mgr, Version: Version}),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
		OnShutdown: mgr.Shutdown,
	})
	mgr.Emit = func(name string, data any) { app.Event.Emit(name, data) }
	mgr.OpenURL = func(url string) { _ = app.Browser.OpenURL(url) }
	mgr.OpenPath = func(path string) { _ = app.Browser.OpenFile(path) }

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:     "刷课 All-in-One",
		Width:     1240,
		Height:    800,
		MinWidth:  980,
		MinHeight: 640,
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 40,
			Backdrop:                application.MacBackdropNormal,
			TitleBar:                application.MacTitleBarHiddenInset,
		},
		BackgroundColour: application.NewRGB(245, 246, 248),
		URL:              "/",
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
