// SPDX-License-Identifier: AGPL-3.0-or-later

//go:build !windows

package runner

import (
	"os/exec"
	"syscall"
)

func prepareCmd(cmd *exec.Cmd) {
	// Own process group so that browsers started by the engine die with it.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

type pgKiller struct{ pid int }

func attachKiller(cmd *exec.Cmd) killer { return &pgKiller{pid: cmd.Process.Pid} }

func (k *pgKiller) kill() {
	_ = syscall.Kill(-k.pid, syscall.SIGTERM)
	_ = syscall.Kill(-k.pid, syscall.SIGKILL)
}

func (k *pgKiller) release() {
	// Reap any orphans left in the group (e.g. a Chrome started by nodriver).
	_ = syscall.Kill(-k.pid, syscall.SIGKILL)
}
