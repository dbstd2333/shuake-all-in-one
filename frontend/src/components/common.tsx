// SPDX-License-Identifier: AGPL-3.0-or-later
import { Progress as AntProgress, Flex, Tag, Typography } from "antd";
import type { Task } from "../api";
import { platformById } from "../platforms";
import type { Progress } from "../stores/app";

export function PlatformTag({ id }: { id: string }) {
  const p = platformById(id);
  return <Tag color={p.color} style={{ marginInlineEnd: 0 }}>{p.short}</Tag>;
}

const STATUS: Record<string, { color: string; text: string }> = {
  queued: { color: "default", text: "排队中" },
  running: { color: "processing", text: "运行中" },
  success: { color: "success", text: "已完成" },
  failed: { color: "error", text: "失败" },
  cancelled: { color: "warning", text: "已停止" },
};

export function TaskStatus({ status }: { status: string }) {
  const s = STATUS[status] ?? { color: "default", text: status };
  return <Tag color={s.color}>{s.text}</Tag>;
}

const ACCOUNT_STATUS: Record<string, { color: string; text: string }> = {
  new: { color: "default", text: "未登录" },
  ok: { color: "success", text: "已登录" },
  invalid: { color: "error", text: "需重新登录" },
};

export function AccountStatus({ status }: { status: string }) {
  const s = ACCOUNT_STATUS[status] ?? { color: "default", text: status };
  return <Tag color={s.color}>{s.text}</Tag>;
}

export function formatDuration(sec?: number) {
  if (sec == null || !isFinite(sec) || sec < 0) return "";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

export function formatTime(unix?: number) {
  if (!unix) return "-";
  return new Date(unix * 1000).toLocaleString("zh-CN", { hour12: false });
}

function pct(p?: Progress) {
  if (!p || !p.total) return 0;
  return Math.min(100, Math.round((p.current / p.total) * 100));
}

const SCOPE_LABEL: Record<string, string> = { overall: "总体", course: "当前课程", item: "当前条目" };

export function TaskProgressBars({ progress, task, compact }: { progress?: Record<string, Progress>; task: Task; compact?: boolean }) {
  const scopes = ["overall", "course", "item"].filter((s) => progress?.[s]);
  if (task.status !== "running" || scopes.length === 0) {
    const done = task.status === "success";
    return <AntProgress percent={done ? 100 : 0} size="small" status={task.status === "failed" ? "exception" : done ? "success" : "normal"} showInfo={!compact} />;
  }
  return (
    <Flex vertical gap={compact ? 2 : 6}>
      {scopes.map((s) => {
        const p = progress![s];
        return (
          <div key={s}>
            {!compact && (
              <Flex justify="space-between">
                <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                  {SCOPE_LABEL[s]}{p.label ? ` · ${p.label}` : ""}
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {p.eta ? `剩余约 ${formatDuration(p.eta)}` : `${p.current}/${p.total}`}
                </Typography.Text>
              </Flex>
            )}
            <AntProgress percent={pct(p)} size="small" status="active" showInfo={!compact} />
          </div>
        );
      })}
    </Flex>
  );
}
