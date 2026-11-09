// SPDX-License-Identifier: AGPL-3.0-or-later
import { create } from "zustand";
import { AccountAPI, CONNECTION, RECONNECTED, TaskAPI, onEvent, type Account, type Batch, type LoginState, type Task } from "../api";

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
  /** background login state by account id */
  logins: Record<string, LoginState>;
  /** recent batch runs, newest first */
  batches: Batch[];
  /** server build: is the event stream connected */
  connected: boolean;

  loadAccounts(): Promise<void>;
  loadTasks(): Promise<void>;
  loadBatches(): Promise<void>;
  rehydrate(): void;
  init(): () => void;
  setLogs(key: string, lines: LogLine[]): void;
  removeRequest(id: string, jobId: string): void;
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
  logins: {},
  batches: [],
  connected: true,

  async loadAccounts() {
    const list = (await AccountAPI.List()) ?? [];
    set({ accounts: list.filter(Boolean) as Account[] });
  },

  async loadTasks() {
    const list = (await TaskAPI.List(200)) ?? [];
    set({ tasks: list.filter(Boolean) as Task[] });
  },

  async loadBatches() {
    const list = (await TaskAPI.Batches()) ?? [];
    set({ batches: list });
  },

  rehydrate() {
    void get().loadAccounts();
    void get().loadTasks();
    void get().loadBatches();
    void AccountAPI.LoginStates().then((list) => {
      const logins: Record<string, LoginState> = {};
      for (const l of list ?? []) logins[l.accountId] = l;
      set({ logins });
    });
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

    const offs = [
      onEvent("engine:msg", (ev: EngineEvent) => handleEngine(ev)),
      onEvent("task:update", (t: Task) => {
        set((s) => {
          const idx = s.tasks.findIndex((x) => x.id === t.id);
          const tasks = idx >= 0 ? s.tasks.map((x) => (x.id === t.id ? t : x)) : [t, ...s.tasks];
          return { tasks };
        });
      }),
      onEvent("account:update", (a: Account) => {
        set((s) => {
          const idx = s.accounts.findIndex((x) => x.id === a.id);
          return { accounts: idx >= 0 ? s.accounts.map((x) => (x.id === a.id ? a : x)) : [a, ...s.accounts] };
        });
      }),
      onEvent("account:login", (l: LoginState) => set((s) => ({ logins: { ...s.logins, [l.accountId]: l } }))),
      onEvent("batch:update", (b: Batch) => {
        set((s) => {
          const idx = s.batches.findIndex((x) => x.id === b.id);
          return { batches: idx >= 0 ? s.batches.map((x) => (x.id === b.id ? b : x)) : [b, ...s.batches] };
        });
      }),
      onEvent(CONNECTION, (up: boolean) => set({ connected: up })),
      // Events were missed while the stream was down: reload everything.
      onEvent(RECONNECTED, () => get().rehydrate()),
    ];

    // Rehydrate after a reload of the page / webview.
    get().rehydrate();

    return () => offs.forEach((off) => off());
  },
}));
export const isActive = (t: Task) => t.status === "running" || t.status === "queued";
