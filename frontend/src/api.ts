// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Backend access for both builds:
//  - desktop (Wails): generated bindings + Wails events
//  - server (Docker / web): POST /api/<Service>/<Method> + Server-Sent Events
// The server injects window.__SHUAKE_SERVER__ into index.html.
import type { AccountServiceAPI, AppServiceAPI, TaskServiceAPI } from "./types";

export type * from "./types";

declare global {
  interface Window {
    __SHUAKE_SERVER__?: boolean;
  }
}

export const SERVER = !!window.__SHUAKE_SERVER__ || import.meta.env.VITE_SHUAKE_SERVER === "1";

// ---------------------------------------------------------------- transport

// Lazily loaded so that the web build works without generated bindings.
const bindings = import.meta.glob("../bindings/github.com/shuake/aio/internal/services/*service.ts");

/** Called when the server answers 401 (session expired / logged out). */
let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function httpJSON<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Requested-With": "shuake" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  if (res.status === 401 && !url.endsWith("/api/login")) onUnauthorized();
  if (!res.ok) throw new Error(data?.message || `请求失败（HTTP ${res.status}）`);
  return data as T;
}

function service<T extends object>(name: string, file: string): T {
  return new Proxy({} as T, {
    get(_, method) {
      if (typeof method !== "string" || method === "then") return undefined;
      return async (...args: unknown[]) => {
        if (SERVER) return httpJSON(`/api/${name}/${method}`, args);
        const load = bindings[`../bindings/github.com/shuake/aio/internal/services/${file}.ts`];
        if (!load) throw new Error("Wails 绑定未生成，请先运行 wails3 generate bindings");
        const mod = (await load()) as Record<string, (...a: unknown[]) => Promise<unknown>>;
        return mod[method](...args);
      };
    },
  });
}

export const AccountAPI = service<AccountServiceAPI>("AccountService", "accountservice");
export const TaskAPI = service<TaskServiceAPI>("TaskService", "taskservice");
export const AppAPI = service<AppServiceAPI>("AppService", "appservice");

/** Opens a link: system browser on desktop, new tab on the web. */
export function openURL(url: string) {
  if (!/^https?:\/\//.test(url)) return;
  if (SERVER) window.open(url, "_blank", "noopener,noreferrer");
  else void AppAPI.OpenURL(url);
}

// ---------------------------------------------------------------- events

type Listener = (data: any) => void;
const listeners = new Map<string, Set<Listener>>();
let source: EventSource | null = null;

function dispatch(name: string, data: unknown) {
  listeners.get(name)?.forEach((fn) => {
    try {
      fn(data);
    } catch (e) {
      console.error(e);
    }
  });
}

/** Fired (server build) when the event stream reconnects, so state can be reloaded. */
export const RECONNECTED = "__reconnected";
/** Fired (server build) when the event stream is up or down. */
export const CONNECTION = "__connection";

function ensureStream() {
  if (source) return;
  let wasDown = false;
  source = new EventSource("/api/events", { withCredentials: true });
  source.onopen = () => {
    dispatch(CONNECTION, true);
    if (wasDown) dispatch(RECONNECTED, null);
    wasDown = false;
  };
  source.onerror = () => {
    wasDown = true;
    dispatch(CONNECTION, false);
    // A 401 closes the stream for good; check the session.
    if (source?.readyState === EventSource.CLOSED) {
      source = null;
      httpJSON<{ authed: boolean }>("/api/session")
        .then((s) => (s.authed ? setTimeout(ensureStream, 3000) : onUnauthorized()))
        .catch(() => setTimeout(ensureStream, 3000));
    }
  };
  source.onmessage = (e) => {
    try {
      const { name, data } = JSON.parse(e.data);
      dispatch(name, data);
    } catch {
      /* ignore malformed */
    }
  };
}

/** Closes the event stream (logout). */
export function closeEvents() {
  source?.close();
  source = null;
}

function unwrap<T>(data: unknown): T {
  if (Array.isArray(data) && data.length === 1) return data[0] as T;
  return data as T;
}

/** Subscribes to a backend event; returns the unsubscribe function. */
export function onEvent(name: string, fn: Listener): () => void {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name)!.add(fn);
  let off: (() => void) | undefined;
  if (SERVER) {
    if (!name.startsWith("__")) ensureStream();
  } else if (!name.startsWith("__")) {
    let cancelled = false;
    import("@wailsio/runtime").then(({ Events }) => {
      if (!cancelled) off = Events.On(name, (e: { data: unknown }) => fn(unwrap(e.data)));
    });
    return () => {
      cancelled = true;
      off?.();
      listeners.get(name)?.delete(fn);
    };
  }
  return () => listeners.get(name)?.delete(fn);
}

// ---------------------------------------------------------------- helpers

/** Extracts a readable message from a rejected call. */
export function errText(e: unknown): string {
  if (!e) return "未知错误";
  if (typeof e === "string") return e;
  const anyE = e as { message?: string };
  if (anyE.message) {
    try {
      const parsed = JSON.parse(anyE.message);
      if (parsed?.message) return parsed.message;
    } catch {
      /* not json */
    }
    return anyE.message;
  }
  return String(e);
}
