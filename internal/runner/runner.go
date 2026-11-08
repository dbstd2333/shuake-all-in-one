// SPDX-License-Identifier: AGPL-3.0-or-later

// Package runner starts a Python engine process and speaks the JSON Lines
// protocol documented in docs/ENGINE.md.
package runner

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/shuake/aio/internal/pyenv"
)

// Exit codes used by the engine.
const (
	ExitOK        = 0
	ExitError     = 1
	ExitLogin     = 2
	ExitCancelled = 3
)

// Start is the first message sent to the engine.
type Start struct {
	Platform   string         `json:"platform"`
	Action     string         `json:"action"`
	Account    map[string]any `json:"account,omitempty"`
	Credential map[string]any `json:"credential,omitempty"`
	Options    map[string]any `json:"options,omitempty"`
	AI         map[string]any `json:"ai,omitempty"`
	DataDir    string         `json:"data_dir"`
	Debug      bool           `json:"debug,omitempty"`
}

// Message is one decoded line from the engine. Type is always set.
type Message struct {
	Type string         `json:"type"`
	Raw  map[string]any `json:"-"`
}

// Str returns a string field of the message.
func (m Message) Str(key string) string {
	if v, ok := m.Raw[key].(string); ok {
		return v
	}
	return ""
}

// Process is a running engine.
type Process struct {
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	writeMu  sync.Mutex
	done     chan struct{}
	exitCode int
	waitErr  error
	killer   killer
	once     sync.Once
}

// Handler receives every message in order. It runs on the reader goroutine;
// keep it fast.
type Handler func(Message)

// Spawn launches the engine and sends the start message.
func Spawn(env *pyenv.Env, start Start, onMsg Handler) (*Process, error) {
	cmd := exec.Command(env.Python, env.Args()...)
	cmd.Env = append(os.Environ(),
		"PYTHONIOENCODING=utf-8",
		"PYTHONUNBUFFERED=1",
		"PYTHONDONTWRITEBYTECODE=1",
	)
	if start.DataDir != "" {
		cmd.Dir = start.DataDir
	}
	prepareCmd(cmd)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("启动 Python 失败: %w", err)
	}
	p := &Process{cmd: cmd, stdin: stdin, done: make(chan struct{})}
	p.killer = attachKiller(cmd)

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 64*1024), 32*1024*1024)
		for sc.Scan() {
			line := sc.Bytes()
			if len(line) == 0 {
				continue
			}
			var raw map[string]any
			if err := json.Unmarshal(line, &raw); err != nil {
				onMsg(Message{Type: "log", Raw: map[string]any{"type": "log", "level": "info", "msg": string(line)}})
				continue
			}
			t, _ := raw["type"].(string)
			onMsg(Message{Type: t, Raw: raw})
		}
	}()
	go func() {
		defer wg.Done()
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
		for sc.Scan() {
			txt := strings.TrimRight(sc.Text(), "\r")
			if txt == "" {
				continue
			}
			onMsg(Message{Type: "log", Raw: map[string]any{"type": "log", "level": "warn", "msg": txt, "stderr": true}})
		}
	}()
	go func() {
		wg.Wait()
		err := cmd.Wait()
		p.waitErr = err
		p.exitCode = cmd.ProcessState.ExitCode()
		p.killer.release()
		close(p.done)
	}()

	b, _ := json.Marshal(struct {
		Type string `json:"type"`
		Start
	}{"start", start})
	if err := p.writeLine(b); err != nil {
		p.Kill()
		return nil, err
	}
	return p, nil
}

func (p *Process) writeLine(b []byte) error {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	if _, err := p.stdin.Write(append(b, '\n')); err != nil {
		return err
	}
	return nil
}

// Reply answers a request from the engine.
func (p *Process) Reply(id string, value any) error {
	b, err := json.Marshal(map[string]any{"type": "reply", "id": id, "value": value})
	if err != nil {
		return err
	}
	return p.writeLine(b)
}

// Cancel asks the engine to stop and kills it (with its children) if it has
// not exited after grace.
func (p *Process) Cancel(grace time.Duration) {
	b, _ := json.Marshal(map[string]any{"type": "cancel"})
	_ = p.writeLine(b)
	go func() {
		select {
		case <-p.done:
		case <-time.After(grace):
			p.Kill()
		}
	}()
}

// Kill terminates the engine and every process it started.
func (p *Process) Kill() {
	p.once.Do(func() {
		_ = p.stdin.Close()
		p.killer.kill()
	})
}

// Done is closed when the process has exited.
func (p *Process) Done() <-chan struct{} { return p.done }

// ExitCode is valid after Done is closed.
func (p *Process) ExitCode() int { return p.exitCode }

// Wait blocks until exit or ctx is done (then the process is cancelled).
func (p *Process) Wait(ctx context.Context) int {
	select {
	case <-p.done:
	case <-ctx.Done():
		p.Cancel(3 * time.Second)
		<-p.done
	}
	return p.exitCode
}

// ErrLogin is returned by Call when the engine exits with ExitLogin.
var ErrLogin = errors.New("login required")

// killer abstracts process-tree termination per OS.
type killer interface {
	kill()
	release()
}
