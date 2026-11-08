// SPDX-License-Identifier: AGPL-3.0-or-later
export * as AccountAPI from "../bindings/github.com/shuake/aio/internal/services/accountservice";
export * as TaskAPI from "../bindings/github.com/shuake/aio/internal/services/taskservice";
export * as AppAPI from "../bindings/github.com/shuake/aio/internal/services/appservice";
export type { Account, Task } from "../bindings/github.com/shuake/aio/internal/store/models";
export type { CallResult, PendingRequest, RunningTask, Settings } from "../bindings/github.com/shuake/aio/internal/core/models";
export type { Info } from "../bindings/github.com/shuake/aio/internal/services/models";

/** Extracts a readable message from a rejected binding call. */
export function errText(e: unknown): string {
  if (!e) return "未知错误";
  if (typeof e === "string") return e;
  const anyE = e as { message?: string; cause?: unknown };
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
