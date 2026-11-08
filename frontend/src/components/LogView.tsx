// SPDX-License-Identifier: AGPL-3.0-or-later
import { Empty, Segmented, Flex, Switch, Typography } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LogLine } from "../stores/app";

const COLORS: Record<string, string> = {
  debug: "var(--ant-color-text-quaternary)",
  info: "var(--ant-color-text)",
  success: "var(--ant-color-success)",
  warn: "var(--ant-color-warning)",
  error: "var(--ant-color-error)",
};

const LEVEL_RANK: Record<string, number> = { debug: 0, info: 1, success: 1, warn: 2, error: 3 };

function fmt(ts: number) {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString("zh-CN", { hour12: false });
}

export default function LogView({ lines, height = 360 }: { lines: LogLine[]; height?: number | string }) {
  const [level, setLevel] = useState<string>("info");
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    const min = LEVEL_RANK[level] ?? 1;
    const filtered = lines.filter((l) => (LEVEL_RANK[l.level] ?? 1) >= min);
    return filtered.length > 1500 ? filtered.slice(filtered.length - 1500) : filtered;
  }, [lines, level]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown, follow]);

  return (
    <Flex vertical gap={8}>
      <Flex justify="space-between" align="center">
        <Segmented
          size="small"
          value={level}
          onChange={(v) => setLevel(v as string)}
          options={[
            { label: "全部", value: "debug" },
            { label: "信息", value: "info" },
            { label: "警告", value: "warn" },
            { label: "错误", value: "error" },
          ]}
        />
        <Flex gap={6} align="center">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>自动滚动</Typography.Text>
          <Switch size="small" checked={follow} onChange={setFollow} />
        </Flex>
      </Flex>
      <div className="log-view" ref={box} style={{ height }}>
        {shown.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无日志" />
        ) : (
          shown.map((l, i) => (
            <div key={i} className="log-line" style={{ color: COLORS[l.level] ?? COLORS.info }}>
              <span className="log-ts">{fmt(l.ts)}</span>
              <span className="log-msg">{l.msg}</span>
            </div>
          ))
        )}
      </div>
    </Flex>
  );
}
