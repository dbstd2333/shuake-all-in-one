// SPDX-License-Identifier: AGPL-3.0-or-later

//go:build windows

package runner

import (
	"os/exec"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const createNoWindow = 0x08000000

func prepareCmd(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow | windows.CREATE_NEW_PROCESS_GROUP}
}

// jobKiller puts the engine in a Job Object with KILL_ON_JOB_CLOSE so that its
// whole process tree (including browsers) is terminated together.
type jobKiller struct {
	mu  sync.Mutex
	job windows.Handle
	cmd *exec.Cmd
}

func attachKiller(cmd *exec.Cmd) killer {
	k := &jobKiller{cmd: cmd}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return k
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		_ = windows.CloseHandle(job)
		return k
	}
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		_ = windows.CloseHandle(job)
		return k
	}
	defer windows.CloseHandle(h)
	if err := windows.AssignProcessToJobObject(job, h); err != nil {
		_ = windows.CloseHandle(job)
		return k
	}
	k.job = job
	return k
}

func (k *jobKiller) kill() {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.job != 0 {
		_ = windows.TerminateJobObject(k.job, 1)
		return
	}
	_ = k.cmd.Process.Kill()
}

func (k *jobKiller) release() {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.job != 0 {
		_ = windows.CloseHandle(k.job) // KILL_ON_JOB_CLOSE reaps leftovers
		k.job = 0
	}
}
