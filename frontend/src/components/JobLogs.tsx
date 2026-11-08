// SPDX-License-Identifier: AGPL-3.0-or-later
import { Modal } from "antd";
import { create } from "zustand";
import { useApp } from "../stores/app";
import LogView from "./LogView";

/** Logs of short engine calls (login, course list, env check) for debugging. */
export const useJobLogs = create<{ jobId?: string; title?: string; show(jobId: string, title?: string): void; hide(): void }>((set) => ({
  show: (jobId, title) => set({ jobId, title }),
  hide: () => set({ jobId: undefined }),
}));

export default function JobLogsModal() {
  const { jobId, title, hide } = useJobLogs();
  const lines = useApp((s) => (jobId ? s.logs[jobId] : undefined));
  return (
    <Modal open={!!jobId} onCancel={hide} footer={null} width={820} title={title || "运行日志"} destroyOnHidden>
      <LogView lines={lines ?? []} height={480} />
    </Modal>
  );
}
