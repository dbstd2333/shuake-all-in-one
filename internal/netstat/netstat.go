// SPDX-License-Identifier: AGPL-3.0-or-later

// Package netstat reads machine-wide network byte counters.
//
// Only Linux is supported (/proc/net/dev). Inside a container the file
// describes the container's own network namespace, so the numbers are exactly
// the traffic of this app including every Chrome and engine process.
package netstat

import (
	"bufio"
	"errors"
	"io"
	"os"
	"strconv"
	"strings"
)

// ErrUnsupported is returned when the platform has no /proc/net/dev.
var ErrUnsupported = errors.New("当前系统不支持读取网卡流量")

// virtual interfaces are skipped so bridged / tunnelled bytes are not counted twice.
var virtualPrefixes = []string{"lo", "docker", "veth", "br-", "virbr", "cni", "flannel", "cali", "vxlan", "kube", "tailscale", "wg", "tun", "tap", "zt", "ifb"}

// Counters are cumulative byte counts since boot (or since the namespace was created).
type Counters struct {
	Rx, Tx     uint64
	Interfaces []string
}

// Read returns the summed counters of all physical interfaces.
func Read() (Counters, error) {
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		return Counters{}, ErrUnsupported
	}
	defer f.Close()
	return Parse(f)
}

// Parse parses the /proc/net/dev format.
func Parse(r io.Reader) (Counters, error) {
	var c Counters
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := sc.Text()
		i := strings.IndexByte(line, ':')
		if i < 0 {
			continue // header lines
		}
		name := strings.TrimSpace(line[:i])
		if isVirtual(name) {
			continue
		}
		f := strings.Fields(line[i+1:])
		if len(f) < 9 {
			continue
		}
		rx, err1 := strconv.ParseUint(f[0], 10, 64)
		tx, err2 := strconv.ParseUint(f[8], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		c.Rx += rx
		c.Tx += tx
		c.Interfaces = append(c.Interfaces, name)
	}
	return c, sc.Err()
}

func isVirtual(name string) bool {
	for _, p := range virtualPrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}
