// SPDX-License-Identifier: AGPL-3.0-or-later

// Package pyenv locates the bundled Python interpreter and the engine sources.
package pyenv

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// Env describes a usable Python engine installation.
type Env struct {
	Python    string `json:"python"`    // interpreter executable
	Bootstrap string `json:"bootstrap"` // engine/bootstrap.py
	Bundled   bool   `json:"bundled"`   // true when found inside the packaged app
}

// Args returns the interpreter arguments that start the engine.
func (e *Env) Args() []string {
	return []string{"-I", "-X", "utf8", "-u", e.Bootstrap}
}

func pythonRel() string {
	if runtime.GOOS == "windows" {
		return filepath.Join("python", "python.exe")
	}
	return filepath.Join("python", "bin", "python3")
}

func exists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// candidate runtime roots, each expected to contain python/ and engine/
func runtimeRoots() []string {
	var roots []string
	if exe, err := os.Executable(); err == nil {
		if real, err := filepath.EvalSymlinks(exe); err == nil {
			exe = real
		}
		dir := filepath.Dir(exe)
		// macOS: App.app/Contents/MacOS/<bin> -> Contents/Resources/runtime
		roots = append(roots, filepath.Join(dir, "..", "Resources", "runtime"))
		// Windows / portable: <dir>/runtime
		roots = append(roots, filepath.Join(dir, "runtime"))
	}
	return roots
}

// projectDirs walks up from start looking for a checkout (engine/bootstrap.py).
func projectDir(start string) string {
	dir := start
	for i := 0; i < 8; i++ {
		if exists(filepath.Join(dir, "engine", "bootstrap.py")) {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return ""
}

// Locate finds the engine. Search order:
//  1. SHUAKE_PYTHON / SHUAKE_ENGINE environment variables
//  2. runtime directory next to the executable (packaged app)
//  3. a development checkout: build/runtime/<goos>-<goarch>/python + engine/
func Locate() (*Env, error) {
	if py := os.Getenv("SHUAKE_PYTHON"); py != "" {
		eng := os.Getenv("SHUAKE_ENGINE")
		if eng == "" {
			if wd, err := os.Getwd(); err == nil {
				if p := projectDir(wd); p != "" {
					eng = filepath.Join(p, "engine")
				}
			}
		}
		boot := filepath.Join(eng, "bootstrap.py")
		if exists(py) && exists(boot) {
			return &Env{Python: py, Bootstrap: boot}, nil
		}
		return nil, fmt.Errorf("SHUAKE_PYTHON=%s 或 SHUAKE_ENGINE=%s 无效", py, eng)
	}

	for _, root := range runtimeRoots() {
		py := filepath.Join(root, pythonRel())
		boot := filepath.Join(root, "engine", "bootstrap.py")
		if exists(py) && exists(boot) {
			return &Env{Python: filepath.Clean(py), Bootstrap: filepath.Clean(boot), Bundled: true}, nil
		}
	}

	var starts []string
	if wd, err := os.Getwd(); err == nil {
		starts = append(starts, wd)
	}
	if exe, err := os.Executable(); err == nil {
		starts = append(starts, filepath.Dir(exe))
	}
	target := runtime.GOOS + "-" + runtime.GOARCH
	for _, s := range starts {
		p := projectDir(s)
		if p == "" {
			continue
		}
		py := filepath.Join(p, "build", "runtime", target, pythonRel())
		boot := filepath.Join(p, "engine", "bootstrap.py")
		if exists(py) {
			return &Env{Python: py, Bootstrap: boot}, nil
		}
		return nil, fmt.Errorf("未找到开发用 Python 运行时 %s，请先运行: python3 scripts/prepare_runtime.py", py)
	}
	return nil, errors.New("未找到内置 Python 运行时，安装包可能已损坏")
}
