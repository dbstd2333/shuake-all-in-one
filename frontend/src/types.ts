// SPDX-License-Identifier: AGPL-3.0-or-later
// Mirrors the Go models (internal/store, internal/core, internal/services).
// Hand-written so the web build does not depend on generated Wails bindings.

type Dict = Record<string, any>;

export interface Account {
  id: string;
  platform: string;
  name: string;
  fields: Dict | null;
  user: Dict | null;
  status: string;
  hasSecret: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Task {
  id: string;
  accountId: string;
  platform: string;
  title: string;
  options: Dict | null;
  status: string;
  summary: Dict | null;
  error: string;
  createdAt: number;
  startedAt: number;
  finishedAt: number;
  /** bytes the engine downloaded / uploaded for this run */
  rxBytes?: number;
  txBytes?: number;
}

export interface CallResult {
  jobId: string;
  code: number;
  data: Dict | null;
  error: string;
}

export interface PendingRequest {
  id: string;
  jobId: string;
  taskId?: string;
  accountId?: string;
  platform: string;
  action: string;
  msg: Dict | null;
}

export interface RunningTask {
  taskId: string;
  jobId: string;
  progress: Record<string, Dict | null> | null;
}

export type AIProvider = "deepseek" | "aliyun" | "custom";
export type AIThinking = "" | "off" | "low" | "medium" | "high" | "max";

export interface Settings {
  aiEnabled: boolean;
  aiProvider: AIProvider;
  aiBaseUrl: string;
  aiModel: string;
  aiThinking: AIThinking;
  aiHasKey: boolean;
  concurrency: number;
  browserPath: string;
  debug: boolean;
  platformLimits: Record<string, number> | null;
  serverMode: boolean;
}

export interface Info {
  version: string;
  dataDir: string;
  python: string;
  bundled: boolean;
  envError: string;
  keyBackend: string;
  node?: string;
  nodeError?: string;
}

export interface LoginState {
  accountId: string;
  state: "queued" | "running" | "ok" | "failed" | string;
  error?: string;
  jobId?: string;
  code: number;
  updatedAt: number;
}

export interface BatchItem {
  accountId: string;
  accountName: string;
  state: "pending" | "listing" | "queued" | "skipped" | "failed" | string;
  message?: string;
  taskId?: string;
  courses: number;
}

export interface Batch {
  id: string;
  title: string;
  mode: string;
  createdAt: number;
  done: boolean;
  items: BatchItem[] | null;
}

export interface BatchRequest {
  accountIds: string[];
  options: Dict;
  mode: "unfinished" | "all" | "keyword";
  keywords: string[];
  title: string;
}

export interface ImportRow {
  name: string;
  fields: Dict;
  secret: Dict;
}

export interface ImportResult {
  created: number;
  skipped: number;
  errors: string[] | null;
  ids: string[] | null;
}

export interface AccountServiceAPI {
  List(): Promise<Account[] | null>;
  Create(platform: string, name: string, fields: Dict, secret: Dict): Promise<Account | null>;
  Update(id: string, name: string, fields: Dict, secret: Dict): Promise<Account | null>;
  Delete(id: string): Promise<void>;
  Logout(id: string): Promise<void>;
  Login(id: string): Promise<CallResult | null>;
  Import(platform: string, rows: ImportRow[]): Promise<ImportResult | null>;
  LoginMany(ids: string[]): Promise<void>;
  LoginStates(): Promise<LoginState[] | null>;
}

export interface TaskServiceAPI {
  ListCourses(accountId: string, options: Dict): Promise<CallResult | null>;
  Start(accountId: string, title: string, options: Dict): Promise<Task | null>;
  StartBatch(req: BatchRequest): Promise<Batch | null>;
  Batches(): Promise<Batch[] | null>;
  Retry(taskId: string): Promise<Task | null>;
  Cancel(taskId: string): Promise<void>;
  CancelJob(jobId: string): Promise<void>;
  List(limit: number): Promise<Task[] | null>;
  Get(id: string): Promise<Task | null>;
  Delete(id: string): Promise<void>;
  Logs(taskId: string, limit: number): Promise<Dict[] | null>;
  Running(): Promise<RunningTask[] | null>;
  Pending(): Promise<PendingRequest[] | null>;
  Reply(jobId: string, requestId: string, value: unknown): Promise<void>;
}

export interface AppServiceAPI {
  Info(): Promise<Info>;
  GetSettings(): Promise<Settings>;
  SaveSettings(st: Settings, aiKey: string, clearKey: boolean): Promise<Settings>;
  TestAI(st: Settings, key: string): Promise<CallResult | null>;
  AIKeyStatus(): Promise<Record<AIProvider, boolean>>;
  CheckEnv(): Promise<CallResult | null>;
  ListTenants(): Promise<CallResult | null>;
  OpenURL(url: string): Promise<void>;
  OpenDataDir(): Promise<void>;
  TrafficOverview(): Promise<TrafficOverview>;
}

export interface JobTraffic {
  jobId: string;
  taskId?: string;
  accountId?: string;
  platform: string;
  action: string;
  rx: number;
  tx: number;
  rxRate: number;
  txRate: number;
}

/** one sample every 2 s; rates in bytes per second */
export interface TrafficTick {
  ts: number;
  rxRate: number;
  txRate: number;
  engineRxRate: number;
  engineTxRate: number;
  jobs?: JobTraffic[];
}

export interface TrafficDay {
  day: string;
  rx: number;
  tx: number;
  /** platform -> [rx, tx] */
  platforms: Record<string, [number, number]>;
}

export interface TrafficOverview {
  /** container: the whole container; host: every physical NIC of the machine; engines: only what the engines reported */
  scope: "container" | "host" | "engines";
  interfaces: string[];
  samples: TrafficTick[];
  days: TrafficDay[];
  latest?: TrafficTick;
}
