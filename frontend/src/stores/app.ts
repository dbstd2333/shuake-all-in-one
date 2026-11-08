// SPDX-License-Identifier: AGPL-3.0-or-later
import { Events } from "@wailsio/runtime";
import { create } from "zustand";
import { AccountAPI, TaskAPI, type Account, type Task } from "../api";

export interface LogLine {
  ts: number;
  level: string;
  msg: string;
}

export interface Progress {
  scope: string;
  current: number;
  total: number;
  label?: string;
  eta?: number;
}

export interface EngineRequest {
  id: string;
  jobId: string;
  taskId?: string;
  accountId?: string;
  platform: string;
  action: string;
  kind: string;
  blocking: boolean;
  payload: Record<string, any>;
}

interface EngineEvent {
  jobId: string;
  taskId?: string;
  accountId?: string;
  platform: string;
  action: string;
  msg: Record<string, any>;
}

const MAX_LOGS = 3000;

interface State {
  accounts: Account[];
  tasks: Task[];
  /** live progress by task id, then scope */
  progress: Record<string, Record<string, Progress>>;
  /** logs by task id (runs) or job id (short calls) */
  logs: Record<string, LogLine[]>;
  /** latest event label per task, e.g. current item name */
  current: Record<string, string>;
  requests: EngineRequest[];
  jobOfTask: Record<string, string>;

  loadAccounts(): Promise<void>;
  loadTasks(): Promise<void>;
  init(): () => void;
  setLogs(key: string, lines: LogLine[]): void;
  removeRequest(id: string, jobId: string): void;
}

function unwrap<T>(data: unknown): T {
  if (Array.isArray(data) && data.length === 1) return data[0] as T;
  return data as T;
}

function appendLog(logs: Record<string, LogLine[]>, key: string, line: LogLine) {
  const cur = logs[key] ?? [];
  const next = cur.length >= MAX_LOGS ? cur.slice(cur.length - MAX_LOGS + 1) : cur.slice();
  next.push(line);
  return { ...logs, [key]: next };
}

export const useApp = create<State>((set, get) => ({
  accounts: [],
  tasks: [],
  progress: {},
  logs: {},
  current: {},
  requests: [],
  jobOfTask: {},

  async loadAccounts() {
    const list = (await AccountAPI.List()) ?? [];
    set({ accounts: list.filter(Boolean) as Account[] });
  },

  async loadTasks() {
    const list = (await TaskAPI.List(200)) ?? [];
    set({ tasks: list.filter(Boolean) as Task[] });
  },

  setLogs(key, lines) {
    set((s) => ({ logs: { ...s.logs, [key]: lines } }));
  },

  removeRequest(id, jobId) {
    set((s) => ({ requests: s.requests.filter((r) => !(r.id === id && r.jobId === jobId)) }));
  },

  init() {
    const handleEngine = (ev: EngineEvent) => {
      const m = ev.msg ?? {};
      const key = ev.taskId || ev.jobId;
      switch (m.type) {
        case "log":
          set((s) => ({ logs: appendLog(s.logs, key, { ts: m.ts ?? Date.now() / 1000, level: m.level ?? "info", msg: String(m.msg ?? "") }) }));
          break;
        case "progress":
          if (ev.taskId) {
            set((s) => ({
              progress: { ...s.progress, [ev.taskId!]: { ...(s.progress[ev.taskId!] ?? {}), [m.scope]: m as Progress } },
              jobOfTask: { ...s.jobOfTask, [ev.taskId!]: ev.jobId },
            }));
          }
          break;
        case "event":
          if (ev.taskId && (m.name === "item_start" || m.name === "course_start")) {
            const label = m.data?.name || m.data?.title;
            if (label) set((s) => ({ current: { ...s.current, [ev.taskId!]: String(label) } }));
          }
          if (ev.taskId) set((s) => ({ jobOfTask: { ...s.jobOfTask, [ev.taskId!]: ev.jobId } }));
          break;
        case "request":
          set((s) => ({
            requests: [
              ...s.requests.filter((r) => !(r.id === m.id && r.jobId === ev.jobId)),
              {
                id: m.id,
                jobId: ev.jobId,
                taskId: ev.taskId,
                accountId: ev.accountId,
                platform: ev.platform,
                action: ev.action,
                kind: m.kind,
                blocking: m.blocking !== false,
                payload: m.payload ?? {},
              },
            ],
          }));
          break;
        case "request_done":
          get().removeRequest(m.id, ev.jobId);
          break;
        case "exit":
          set((s) => ({ requests: s.requests.filter((r) => r.jobId !== ev.jobId) }));
          break;
        case "error":
          set((s) => ({ logs: appendLog(s.logs, key, { ts: Date.now() / 1000, level: "error", msg: String(m.msg ?? m.code) }) }));
          break;
      }
    };

    const offEngine = Events.On("engine:msg", (e) => handleEngine(unwrap<EngineEvent>(e.data)));
    const offTask = Events.On("task:update", (e) => {
      const t = unwrap<Task>(e.data);
      set((s) => {
        const idx = s.tasks.findIndex((x) => x.id === t.id);
        const tasks = idx >= 0 ? s.tasks.map((x) => (x.id === t.id ? t : x)) : [t, ...s.tasks];
        return { tasks };
      });
    });
    const offAccount = Events.On("account:update", (e) => {
      const a = unwrap<Account>(e.data);
      set((s) => {
        const idx = s.accounts.findIndex((x) => x.id === a.id);
        return { accounts: idx >= 0 ? s.accounts.map((x) => (x.id === a.id ? a : x)) : [a, ...s.accounts] };
      });
    });

    // Rehydrate after a reload of the webview.
    void get().loadAccounts();
    void get().loadTasks();
    void TaskAPI.Running().then((running) => {
      const progress: State["progress"] = {};
      const jobOfTask: State["jobOfTask"] = {};
      for (const r of running ?? []) {
        progress[r.taskId] = (r.progress ?? {}) as Record<string, Progress>;
        jobOfTask[r.taskId] = r.jobId;
      }
      set({ progress, jobOfTask });
    });
    void TaskAPI.Pending().then((pending) => {
      set({
        requests: (pending ?? []).map((p) => ({
          id: p.id,
          jobId: p.jobId,
          taskId: p.taskId,
          accountId: p.accountId,
          platform: p.platform,
          action: p.action,
          kind: p.msg?.kind,
          blocking: p.msg?.blocking !== false,
          payload: p.msg?.payload ?? {},
        })),
      });
    });

    return () => {
      offEngine();
      offTask();
      offAccount();
    };
  },
}));

export const isActive = (t: Task) => t.status === "running" || t.status === "queued";
