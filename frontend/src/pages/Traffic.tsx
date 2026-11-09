// SPDX-License-Identifier: AGPL-3.0-or-later
import { ArrowDownOutlined, ArrowUpOutlined } from "@ant-design/icons";
import { Card, Col, Empty, Flex, Row, Statistic, Table, Tag, Tooltip, Typography } from "antd";
import { useMemo } from "react";
import type { JobTraffic } from "../api";
import { PlatformTag } from "../components/common";
import { DailyChart, RateChart } from "../components/TrafficCharts";
import { platformById } from "../platforms";
import { useApp } from "../stores/app";
import { daysWithLive, formatBytes, formatMbps, formatRate, trafficToday, useTraffic } from "../stores/traffic";

const { Text } = Typography;

const SCOPE_TEXT: Record<string, string> = {
  container: "统计范围：整个容器的网络流量（包含所有 Chrome、引擎进程和访问本页面的流量）",
  host: "统计范围：本机所有物理网卡（也包含这台机器上其他程序的流量）",
  engines: "统计范围：仅引擎上报的流量（当前系统不支持读取网卡计数，不含网页访问和其他程序）",
};

const ACTION_TEXT: Record<string, string> = { run: "刷课", login: "登录", list_courses: "获取课程", check: "检查登录" };

function Tile({ title, value, sub }: { title: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <Card size="small" style={{ height: "100%" }}>
      <Statistic title={title} value={value as string} valueStyle={{ fontSize: 22, fontVariantNumeric: "tabular-nums" }} />
      {sub && <Text type="secondary" style={{ fontSize: 12 }}>{sub}</Text>}
    </Card>
  );
}

export default function TrafficPage({ openTask }: { openTask: (id: string) => void }) {
  const { scope, interfaces, samples, latest, days, liveToday, loaded } = useTraffic();
  const tasks = useApp((s) => s.tasks);
  const accounts = useApp((s) => s.accounts);

  const allDays = useMemo(() => daysWithLive(days, liveToday), [days, liveToday]);
  const todayKey = trafficToday();
  const todayRow = allDays.find((d) => d.day === todayKey);
  const month = todayKey.slice(0, 7);
  const monthTotal = allDays.filter((d) => d.day.startsWith(month)).reduce((a, d) => a + d.rx + d.tx, 0);
  const total30 = allDays.reduce((a, d) => a + d.rx + d.tx, 0);

  const platforms = useMemo(() => {
    const m = new Map<string, { today: number; d30: number }>();
    for (const d of allDays) {
      for (const [p, v] of Object.entries(d.platforms)) {
        const cur = m.get(p) ?? { today: 0, d30: 0 };
        cur.d30 += v[0] + v[1];
        if (d.day === todayKey) cur.today += v[0] + v[1];
        m.set(p, cur);
      }
    }
    const sum = [...m.values()].reduce((a, v) => a + v.d30, 0) || 1;
    return [...m.entries()].map(([id, v]) => ({ id, ...v, share: v.d30 / sum })).sort((a, b) => b.d30 - a.d30);
  }, [allDays, todayKey]);

  const jobs = latest?.jobs ?? [];
  const jobLabel = (j: JobTraffic) => {
    const t = j.taskId ? tasks.find((x) => x.id === j.taskId) : undefined;
    if (t) return t.title || t.id;
    const a = accounts.find((x) => x.id === j.accountId);
    return `${a?.name || "账号"} · ${ACTION_TEXT[j.action] ?? j.action}`;
  };

  if (!loaded && !latest) {
    return <Card><Empty description="正在加载流量数据…（如果一直为空，说明后端版本还不支持流量统计）" /></Card>;
  }

  return (
    <Flex vertical gap={16}>
      <Row gutter={[16, 16]}>
        <Col xs={12} lg={6}>
          <Tile title="当前下行" value={formatRate(latest?.rxRate)} sub={<><ArrowDownOutlined /> {formatMbps(latest?.rxRate)}</>} />
        </Col>
        <Col xs={12} lg={6}>
          <Tile title="当前上行" value={formatRate(latest?.txRate)} sub={<><ArrowUpOutlined /> {formatMbps(latest?.txRate)}</>} />
        </Col>
        <Col xs={12} lg={6}>
          <Tile title="今日流量" value={formatBytes((todayRow?.rx ?? 0) + (todayRow?.tx ?? 0))}
            sub={`下行 ${formatBytes(todayRow?.rx)} · 上行 ${formatBytes(todayRow?.tx)}`} />
        </Col>
        <Col xs={12} lg={6}>
          <Tile title="本月流量" value={formatBytes(monthTotal)} sub={`近 30 天 ${formatBytes(total30)}`} />
        </Col>
      </Row>

      <Card title="实时网速" extra={<Text type="secondary">最近 10 分钟 · 每 2 秒刷新</Text>}>
        <RateChart samples={samples} />
        <Text type="secondary" style={{ fontSize: 12 }}>
          {scope ? SCOPE_TEXT[scope] : ""}
          {scope !== "engines" && interfaces.length > 0 && `（网卡：${interfaces.join("、")}）`}
        </Text>
      </Card>

      <Card title="正在产生流量的任务" extra={<Text type="secondary">按引擎上报统计，不含 TLS/TCP 开销，略低于网卡读数</Text>}>
        <Table<JobTraffic>
          size="small"
          rowKey="jobId"
          dataSource={jobs}
          pagination={false}
          locale={{ emptyText: "当前没有运行中的引擎" }}
          columns={[
            {
              title: "任务", render: (_, j) => (
                <Flex gap={8} align="center">
                  <PlatformTag id={j.platform} />
                  {j.taskId ? <a onClick={() => openTask(j.taskId!)}>{jobLabel(j)}</a> : <Text>{jobLabel(j)}</Text>}
                </Flex>
              ),
            },
            { title: "下行速率", width: 130, align: "right", render: (_, j) => formatRate(j.rxRate) },
            { title: "上行速率", width: 130, align: "right", render: (_, j) => formatRate(j.txRate) },
            { title: "本次累计", width: 130, align: "right", render: (_, j) => <Tooltip title={`下行 ${formatBytes(j.rx)} · 上行 ${formatBytes(j.tx)}`}>{formatBytes(j.rx + j.tx)}</Tooltip> },
          ]}
        />
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={15}>
          <Card title="每日流量" extra={<Text type="secondary">最近 30 天</Text>} style={{ height: "100%" }}>
            <DailyChart days={allDays} />
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card title="各平台用量" extra={<Text type="secondary">按引擎上报</Text>} style={{ height: "100%" }}>
            <Table
              size="small"
              rowKey="id"
              dataSource={platforms}
              pagination={false}
              locale={{ emptyText: "还没有任务产生流量" }}
              columns={[
                { title: "平台", render: (_, p) => <Flex gap={8} align="center"><PlatformTag id={p.id} /><span>{platformById(p.id).short}</span></Flex> },
                { title: "今日", align: "right", render: (_, p) => formatBytes(p.today) },
                { title: "近 30 天", align: "right", render: (_, p) => formatBytes(p.d30) },
                { title: "占比", align: "right", width: 70, render: (_, p) => <Tag bordered={false}>{Math.round(p.share * 100)}%</Tag> },
              ]}
            />
          </Card>
        </Col>
      </Row>
    </Flex>
  );
}
