// SPDX-License-Identifier: AGPL-3.0-or-later
import { ExclamationCircleFilled, PlusOutlined, StopOutlined, UserAddOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Col, Empty, Flex, Row, Statistic, Typography } from "antd";
import { useMemo } from "react";
import { TaskAPI, type Task } from "../api";
import { PlatformTag, TaskProgressBars, TaskStatus, formatTime } from "../components/common";
import { isActive, useApp } from "../stores/app";
import { useAccountName } from "./Tasks";

const { Text, Paragraph } = Typography;

const LEVEL_COLOR: Record<string, string> = { warn: "var(--ant-color-warning)", error: "var(--ant-color-error)", success: "var(--ant-color-success)" };

function LiveTaskCard({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const progress = useApp((s) => s.progress[task.id]);
  const current = useApp((s) => s.current[task.id]);
  const logs = useApp((s) => s.logs[task.id]);
  const tail = useMemo(() => (logs ? logs.slice(-3) : []), [logs]);
  const waiting = useApp((s) => s.requests.some((r) => r.taskId === task.id && r.blocking));
  const errors = useMemo(() => (logs ?? []).filter((l) => l.level === "error").length, [logs]);
  const accountName = useAccountName();

  return (
    <Card
      size="small"
      hoverable
      onClick={onOpen}
      title={<Flex gap={8} align="center"><PlatformTag id={task.platform} /><Text strong ellipsis style={{ maxWidth: 260 }}>{task.title}</Text></Flex>}
      extra={
        <Flex gap={6} align="center" onClick={(e) => e.stopPropagation()}>
          <TaskStatus status={task.status} />
          <Button size="small" danger type="text" icon={<StopOutlined />} onClick={() => TaskAPI.Cancel(task.id)}>停止</Button>
        </Flex>
      }
    >
      <Flex vertical gap={10}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {accountName(task.accountId)}{current ? ` · 正在处理：${current}` : ""}
        </Text>
        {waiting && <Alert type="warning" showIcon message="等待你的操作（验证码 / 扫码 / 答题）" />}
        <TaskProgressBars progress={progress} task={task} />
        <div className="log-tail">
          {tail.length === 0 ? (
            <Text type="secondary">{task.status === "queued" ? "排队中，等待空闲名额…" : "等待输出…"}</Text>
          ) : (
            tail.map((l, i) => (
              <div key={i} style={{ color: LEVEL_COLOR[l.level] }} className="log-tail-line">{l.msg.split("\n")[0]}</div>
            ))
          )}
        </div>
        {errors > 0 && (
          <Text type="danger" style={{ fontSize: 12 }}><ExclamationCircleFilled /> 已出现 {errors} 条错误，点击卡片查看详情</Text>
        )}
      </Flex>
    </Card>
  );
}

export default function Dashboard({ openTask, goAccounts, goNewTask }: { openTask: (id: string) => void; goAccounts: () => void; goNewTask: () => void }) {
  const tasks = useApp((s) => s.tasks);
  const accounts = useApp((s) => s.accounts);
  const accountName = useAccountName();
  const active = useMemo(() => tasks.filter(isActive), [tasks]);
  const recentFailed = useMemo(() => tasks.filter((t) => t.status === "failed").slice(0, 5), [tasks]);
  const done = tasks.filter((t) => t.status === "success").length;

  return (
    <Flex vertical gap={16}>
      <Row gutter={16}>
        <Col span={6}><Card size="small"><Statistic title="账号" value={accounts.length} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="运行中" value={active.filter((t) => t.status === "running").length} valueStyle={{ color: "var(--ant-color-primary)" }} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="排队中" value={active.filter((t) => t.status === "queued").length} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="已完成" value={done} valueStyle={{ color: "var(--ant-color-success)" }} /></Card></Col>
      </Row>

      <Card title="正在运行" extra={<Button type="primary" icon={<PlusOutlined />} onClick={goNewTask}>新建任务</Button>}>
        {active.length === 0 ? (
          <Empty description={accounts.length ? "当前没有运行中的任务" : "先添加一个平台账号，然后就可以开始刷课了"}>
            {accounts.length ? (
              <Button type="primary" icon={<PlusOutlined />} onClick={goNewTask}>新建任务</Button>
            ) : (
              <Button type="primary" icon={<UserAddOutlined />} onClick={goAccounts}>添加账号</Button>
            )}
          </Empty>
        ) : (
          <Row gutter={[16, 16]}>
            {active.map((t) => (
              <Col key={t.id} xs={24} xl={12}>
                <LiveTaskCard task={t} onOpen={() => openTask(t.id)} />
              </Col>
            ))}
          </Row>
        )}
      </Card>

      {recentFailed.length > 0 && (
        <Card title="最近失败的任务" size="small">
          <Flex vertical gap={8}>
            {recentFailed.map((t) => (
              <Alert
                key={t.id}
                type="error"
                showIcon
                message={<Flex gap={8} align="center"><PlatformTag id={t.platform} /><Text strong>{t.title}</Text><Text type="secondary">{accountName(t.accountId)} · {formatTime(t.finishedAt)}</Text></Flex>}
                description={<Paragraph ellipsis={{ rows: 2 }} style={{ marginBottom: 0 }}>{t.error || "未知错误"}</Paragraph>}
                action={<Button size="small" onClick={() => openTask(t.id)}>查看日志</Button>}
              />
            ))}
          </Flex>
        </Card>
      )}
    </Flex>
  );
}
