// SPDX-License-Identifier: AGPL-3.0-or-later

package core

import (
	"os"
	"sort"
	"sync"
	"time"

	"github.com/shuake/aio/internal/netstat"
	"github.com/shuake/aio/internal/store"
)

// EventTraffic carries one TrafficTick every trafficInterval.
const EventTraffic = "traffic:tick"

const (
	trafficInterval = 2 * time.Second
	trafficSamples  = 300 // 10 minutes of history for the live chart
	trafficFlush    = 15  // ticks between database writes (30 s)
	trafficDays     = 31
	scopeSystem     = "system"
	scopePlatform   = "p:"
)

// JobTraffic is the live traffic of one engine process.
type JobTraffic struct {
	JobID     string  `json:"jobId"`
	TaskID    string  `json:"taskId,omitempty"`
	AccountID string  `json:"accountId,omitempty"`
	Platform  string  `json:"platform"`
	Action    string  `json:"action"`
	Rx        int64   `json:"rx"`
	Tx        int64   `json:"tx"`
	RxRate    float64 `json:"rxRate"`
	TxRate    float64 `json:"txRate"`
}

// TrafficTick is one sample. Rates are bytes per second.
type TrafficTick struct {
	TS int64 `json:"ts"` // unix ms
	// System is the network interface rate (whole container / host); only when supported.
	RxRate float64 `json:"rxRate"`
	TxRate float64 `json:"txRate"`
	// Engine is the sum of what the engines reported.
	EngineRxRate float64      `json:"engineRxRate"`
	EngineTxRate float64      `json:"engineTxRate"`
	Jobs         []JobTraffic `json:"jobs,omitempty"`
}

// TrafficDay is one day of totals.
type TrafficDay struct {
	Day       string              `json:"day"`
	Rx        int64               `json:"rx"`
	Tx        int64               `json:"tx"`
	Platforms map[string][2]int64 `json:"platforms"` // platform -> [rx, tx]
}

// TrafficOverview is everything the traffic page needs on load.
type TrafficOverview struct {
	// Scope says what the system counters cover: "container", "host" or
	// "engines" (unsupported OS: only engine-reported bytes are known).
	Scope      string        `json:"scope"`
	Interfaces []string      `json:"interfaces"`
	Samples    []TrafficTick `json:"samples"`
	Days       []TrafficDay  `json:"days"`
	Latest     *TrafficTick  `json:"latest,omitempty"`
}

type trafficState struct {
	mu         sync.Mutex
	supported  bool
	scope      string
	interfaces []string
	prevRx     uint64
	prevTx     uint64
	prevAt     time.Time
	samples    []TrafficTick
	pending    map[string]map[string][2]int64 // day -> scope -> [rx, tx], not yet written
	ticks      int
}

func (m *Manager) startTraffic() {
	t := &m.traffic
	t.pending = map[string]map[string][2]int64{}
	if c, err := netstat.Read(); err == nil {
		t.supported = true
		t.interfaces = c.Interfaces
		t.prevRx, t.prevTx, t.prevAt = c.Rx, c.Tx, time.Now()
		t.scope = "host"
		if os.Getenv("ENVIRONMENT") == "docker" {
			t.scope = "container"
		}
	} else {
		t.scope = "engines"
	}
	go func() {
		tk := time.NewTicker(trafficInterval)
		defer tk.Stop()
		for {
			select {
			case <-m.ctx.Done():
				return
			case <-tk.C:
				m.sampleTraffic()
			}
		}
	}()
}

func today() string { return time.Now().Format("2006-01-02") }

// addPending must be called with traffic.mu held.
func (t *trafficState) addPending(scope string, rx, tx int64) {
	if rx <= 0 && tx <= 0 {
		return
	}
	d := today()
	if t.pending[d] == nil {
		t.pending[d] = map[string][2]int64{}
	}
	v := t.pending[d][scope]
	t.pending[d][scope] = [2]int64{v[0] + max(rx, 0), v[1] + max(tx, 0)}
}

// takeJobDelta returns the bytes a job reported since the last call.
func takeJobDelta(j *job) (rx, tx int64) {
	j.mu.Lock()
	defer j.mu.Unlock()
	rx, tx = j.rx-j.seenRx, j.tx-j.seenTx
	j.seenRx, j.seenTx = j.rx, j.tx
	return
}

// settleJob books whatever a finished job reported after the last sample.
func (m *Manager) settleJob(j *job) {
	rx, tx := takeJobDelta(j)
	m.traffic.mu.Lock()
	m.traffic.addPending(scopePlatform+j.platform, rx, tx)
	m.traffic.mu.Unlock()
}

func (m *Manager) sampleTraffic() {
	now := time.Now()
	m.mu.Lock()
	jobs := make([]*job, 0, len(m.jobs))
	for _, j := range m.jobs {
		jobs = append(jobs, j)
	}
	m.mu.Unlock()

	t := &m.traffic
	t.mu.Lock()
	elapsed := now.Sub(t.prevAt).Seconds()
	if t.prevAt.IsZero() || elapsed <= 0 {
		elapsed = trafficInterval.Seconds()
	}
	tick := TrafficTick{TS: now.UnixMilli()}
	if t.supported {
		if c, err := netstat.Read(); err == nil {
			// counters can reset (interface re-created): count from zero then
			drx, dtx := int64(c.Rx-t.prevRx), int64(c.Tx-t.prevTx)
			if c.Rx < t.prevRx {
				drx = int64(c.Rx)
			}
			if c.Tx < t.prevTx {
				dtx = int64(c.Tx)
			}
			tick.RxRate, tick.TxRate = float64(drx)/elapsed, float64(dtx)/elapsed
			t.addPending(scopeSystem, drx, dtx)
			t.prevRx, t.prevTx = c.Rx, c.Tx
			t.interfaces = c.Interfaces
		}
	}
	t.prevAt = now
	for _, j := range jobs {
		rx, tx := takeJobDelta(j)
		t.addPending(scopePlatform+j.platform, rx, tx)
		j.mu.Lock()
		jt := JobTraffic{JobID: j.id, TaskID: j.taskID, AccountID: j.accountID, Platform: j.platform, Action: j.action,
			Rx: j.rx, Tx: j.tx, RxRate: float64(rx) / elapsed, TxRate: float64(tx) / elapsed}
		j.mu.Unlock()
		tick.EngineRxRate += jt.RxRate
		tick.EngineTxRate += jt.TxRate
		tick.Jobs = append(tick.Jobs, jt)
	}
	sort.Slice(tick.Jobs, func(a, b int) bool { return tick.Jobs[a].JobID < tick.Jobs[b].JobID })
	if !t.supported {
		tick.RxRate, tick.TxRate = tick.EngineRxRate, tick.EngineTxRate
	}
	hist := tick
	hist.Jobs = nil
	t.samples = append(t.samples, hist)
	if len(t.samples) > trafficSamples {
		t.samples = t.samples[len(t.samples)-trafficSamples:]
	}
	t.ticks++
	flush := t.ticks%trafficFlush == 0
	t.mu.Unlock()

	if flush {
		m.flushTraffic()
	}
	m.Emit(EventTraffic, tick)
}

// flushTraffic writes the pending per-day deltas to the database.
func (m *Manager) flushTraffic() {
	t := &m.traffic
	t.mu.Lock()
	var rows []store.TrafficRow
	for day, scopes := range t.pending {
		for scope, v := range scopes {
			rows = append(rows, store.TrafficRow{Day: day, Scope: scope, Rx: v[0], Tx: v[1]})
		}
	}
	t.pending = map[string]map[string][2]int64{}
	t.mu.Unlock()
	if err := m.Store.AddTraffic(rows); err != nil {
		// keep the bytes for the next attempt
		t.mu.Lock()
		for _, r := range rows {
			if t.pending[r.Day] == nil {
				t.pending[r.Day] = map[string][2]int64{}
			}
			v := t.pending[r.Day][r.Scope]
			t.pending[r.Day][r.Scope] = [2]int64{v[0] + r.Rx, v[1] + r.Tx}
		}
		t.mu.Unlock()
	}
}

// TrafficOverview returns recent samples and the last 31 days of totals
// (including bytes not yet written to the database).
func (m *Manager) TrafficOverview() (*TrafficOverview, error) {
	since := time.Now().AddDate(0, 0, -(trafficDays - 1)).Format("2006-01-02")
	rows, err := m.Store.TrafficSince(since)
	if err != nil {
		return nil, err
	}
	t := &m.traffic
	t.mu.Lock()
	for day, scopes := range t.pending {
		for scope, v := range scopes {
			rows = append(rows, store.TrafficRow{Day: day, Scope: scope, Rx: v[0], Tx: v[1]})
		}
	}
	ov := &TrafficOverview{Scope: t.scope, Interfaces: append([]string{}, t.interfaces...), Samples: append([]TrafficTick{}, t.samples...)}
	if n := len(t.samples); n > 0 {
		last := t.samples[n-1]
		ov.Latest = &last
	}
	supported := t.supported
	t.mu.Unlock()

	byDay := map[string]*TrafficDay{}
	for _, r := range rows {
		if r.Day < since {
			continue
		}
		d := byDay[r.Day]
		if d == nil {
			d = &TrafficDay{Day: r.Day, Platforms: map[string][2]int64{}}
			byDay[r.Day] = d
		}
		switch {
		case r.Scope == scopeSystem:
			if supported {
				d.Rx += r.Rx
				d.Tx += r.Tx
			}
		case len(r.Scope) > len(scopePlatform) && r.Scope[:len(scopePlatform)] == scopePlatform:
			p := r.Scope[len(scopePlatform):]
			v := d.Platforms[p]
			d.Platforms[p] = [2]int64{v[0] + r.Rx, v[1] + r.Tx}
			if !supported {
				d.Rx += r.Rx
				d.Tx += r.Tx
			}
		}
	}
	ov.Days = make([]TrafficDay, 0, len(byDay))
	for _, d := range byDay {
		ov.Days = append(ov.Days, *d)
	}
	sort.Slice(ov.Days, func(a, b int) bool { return ov.Days[a].Day < ov.Days[b].Day })
	return ov, nil
}
