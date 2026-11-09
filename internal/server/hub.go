// SPDX-License-Identifier: AGPL-3.0-or-later

package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// hub fans backend events out to every connected browser over SSE.
type hub struct {
	mu      sync.Mutex
	clients map[*client]struct{}
}

type client struct {
	ch   chan []byte
	once sync.Once
	gone chan struct{}
}

func (c *client) drop() { c.once.Do(func() { close(c.gone) }) }

func newHub() *hub { return &hub{clients: map[*client]struct{}{}} }

// Emit matches core.Manager.Emit.
func (h *hub) Emit(name string, data any) {
	b, err := json.Marshal(map[string]any{"name": name, "data": data})
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		select {
		case c.ch <- b:
		default:
			// Too slow: disconnect. The browser reconnects and rehydrates
			// from the REST endpoints, which is cheaper than unbounded buffers.
			delete(h.clients, c)
			c.drop()
		}
	}
}

func (h *hub) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients)
}

func (h *hub) serve(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	c := &client{ch: make(chan []byte, 2048), gone: make(chan struct{})}
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.clients, c)
		h.mu.Unlock()
	}()

	hd := w.Header()
	hd.Set("Content-Type", "text/event-stream")
	hd.Set("Cache-Control", "no-cache")
	hd.Set("Connection", "keep-alive")
	hd.Set("X-Accel-Buffering", "no") // nginx: do not buffer the stream
	fmt.Fprint(w, "retry: 3000\n: hello\n\n")
	fl.Flush()

	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-c.gone:
			return
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			fl.Flush()
		case b := <-c.ch:
			fmt.Fprintf(w, "data: %s\n\n", b)
			// drain what is already queued before flushing
			for n := len(c.ch); n > 0; n-- {
				fmt.Fprintf(w, "data: %s\n\n", <-c.ch)
			}
			fl.Flush()
		}
	}
}
