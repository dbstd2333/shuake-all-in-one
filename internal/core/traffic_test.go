// SPDX-License-Identifier: AGPL-3.0-or-later

package core

import (
	"testing"

	"github.com/shuake/aio/internal/runner"
	"github.com/shuake/aio/internal/store"
)

func stats(rx, tx float64) runner.Message {
	return runner.Message{Type: "stats", Raw: map[string]any{"type": "stats", "rx": rx, "tx": tx}}
}

func TestTrafficAccounting(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	var ticks []TrafficTick
	m := NewManager(st, dir, func(name string, data any) {
		if name == EventTraffic {
			ticks = append(ticks, data.(TrafficTick))
		}
		if name == EventEngine {
			t.Errorf("stats must not be forwarded as an engine event")
		}
	}, nil)
	m.stop() // drive the sampler by hand
	j := &job{id: "j1", taskID: "t1", platform: "zhihuishu", action: "run", pending: map[string]PendingRequest{}, progress: map[string]map[string]any{}}
	m.jobs[j.id] = j

	m.handle(j, stats(1000, 100))
	m.sampleTraffic()
	m.handle(j, stats(5000, 300))
	m.handle(j, stats(4000, 200)) // stale / out of order: ignored
	m.sampleTraffic()
	if len(ticks) != 2 || len(ticks[1].Jobs) != 1 {
		t.Fatalf("ticks %+v", ticks)
	}
	if got := ticks[1].Jobs[0]; got.Rx != 5000 || got.Tx != 300 || got.RxRate <= 0 {
		t.Fatalf("job traffic %+v", got)
	}

	// bytes reported after the last sample are booked when the job ends
	m.handle(j, stats(6000, 400))
	delete(m.jobs, j.id)
	m.settleJob(j)
	m.flushTraffic()
	m.handle(j, stats(6000, 400))
	m.settleJob(j) // no double counting

	ov, err := m.TrafficOverview()
	if err != nil {
		t.Fatal(err)
	}
	if len(ov.Days) != 1 {
		t.Fatalf("days %+v", ov.Days)
	}
	if p := ov.Days[0].Platforms["zhihuishu"]; p != [2]int64{6000, 400} {
		t.Fatalf("platform totals %v", p)
	}
	if len(ov.Samples) != 2 || ov.Latest == nil {
		t.Fatalf("samples %d", len(ov.Samples))
	}
}

func TestTaskTrafficColumnsPersist(t *testing.T) {
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	task := &store.Task{ID: "x", AccountID: "a", Platform: "weban", Status: "running"}
	if err := st.InsertTask(task); err != nil {
		t.Fatal(err)
	}
	task.RxBytes, task.TxBytes, task.Status = 123, 45, "success"
	if err := st.UpdateTask(task); err != nil {
		t.Fatal(err)
	}
	got, _ := st.GetTask("x")
	if got.RxBytes != 123 || got.TxBytes != 45 {
		t.Fatalf("got %+v", got)
	}
}
