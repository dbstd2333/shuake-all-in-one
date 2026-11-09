// SPDX-License-Identifier: AGPL-3.0-or-later

package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
)

var (
	ctxType = reflect.TypeOf((*context.Context)(nil)).Elem()
	errType = reflect.TypeOf((*error)(nil)).Elem()
)

// rpc exposes the exported methods of service structs as
// POST /api/<Service>/<Method>, mirroring the Wails bindings: the body is a
// JSON array of the positional arguments, a context.Context parameter is
// injected, and the response is the first non-error return value.
type rpc struct {
	methods map[string]reflect.Value
}

func newRPC() *rpc { return &rpc{methods: map[string]reflect.Value{}} }

// register adds every exported method of svc (a pointer) under name.
func (r *rpc) register(name string, svc any, skip ...string) {
	v := reflect.ValueOf(svc)
	t := v.Type()
	skipped := map[string]bool{}
	for _, s := range skip {
		skipped[s] = true
	}
	for i := 0; i < t.NumMethod(); i++ {
		m := t.Method(i)
		if skipped[m.Name] || m.Name == "ServiceStartup" || m.Name == "ServiceShutdown" {
			continue
		}
		r.methods[name+"/"+m.Name] = v.Method(i)
	}
}

type rpcError struct {
	Status int
	Msg    string
}

func (e *rpcError) Error() string { return e.Msg }

func (r *rpc) call(ctx context.Context, path string, body []byte) (any, error) {
	fn, ok := r.methods[path]
	if !ok {
		return nil, &rpcError{404, "接口不存在: " + path}
	}
	var raw []json.RawMessage
	if s := strings.TrimSpace(string(body)); s != "" {
		if err := json.Unmarshal(body, &raw); err != nil {
			return nil, &rpcError{400, "参数必须是 JSON 数组"}
		}
	}
	ft := fn.Type()
	args := make([]reflect.Value, 0, ft.NumIn())
	next := 0
	for i := 0; i < ft.NumIn(); i++ {
		pt := ft.In(i)
		if pt == ctxType {
			args = append(args, reflect.ValueOf(ctx))
			continue
		}
		pv := reflect.New(pt)
		if next < len(raw) && string(raw[next]) != "null" {
			if err := json.Unmarshal(raw[next], pv.Interface()); err != nil {
				return nil, &rpcError{400, fmt.Sprintf("第 %d 个参数格式错误: %v", next+1, err)}
			}
		}
		next++
		args = append(args, pv.Elem())
	}
	out := fn.Call(args)
	var result any
	for i, o := range out {
		if ft.Out(i) == errType {
			if !o.IsNil() {
				return nil, o.Interface().(error)
			}
			continue
		}
		if result == nil {
			result = o.Interface()
		}
	}
	return result, nil
}

func statusOf(err error) int {
	var re *rpcError
	if errors.As(err, &re) {
		return re.Status
	}
	return 422
}
