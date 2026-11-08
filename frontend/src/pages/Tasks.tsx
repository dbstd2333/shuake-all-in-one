// SPDX-License-Identifier: AGPL-3.0-or-later
import { DeleteOutlined, StopOutlined } from "@ant-design/icons";
import { App as AntApp, Button, Card, Descriptions, Drawer, Empty, Flex, Popconfirm, Segmented, Space, Table, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import { TaskAPI, errText, type Task } from "../api";
import LogView from "../components/LogView";
import { PlatformTag, TaskProgressBars, TaskStatus, formatDuration, formatTime } from "../components/common";
import { isActive, useApp, type LogLine } from "../stores/app";

const { Text } = Typography;

export function useAccountName() {
  const accounts = useApp((s) => s.accounts);
  return (id: string) => {
    const a = accounts.find((x) => x.id === id);
    return a ? a.name || (a.user?.name as string) || (a.fields?.username as string) || "未命名" : "已删除的账号";
  };
}

export function TaskDetail({ taskId, onClose }: { taskId?: string; onClose: () => void }) {
  const task = useApp((s) => s.tasks.find((t) => t.id === taskId));
  const progress = useApp((s) => (taskId ? s.progress[taskId] : undefined));
  const lines = useApp((s) => (taskId ? s.logs[taskId] : undefined));
  const setLogs = useApp((s) => s.setLogs);
  const accountName = useAccountName();

  useEffect(() => {
    if (!taskId) return;
    // Load history from disk once (live lines keep streaming in afterwards).
    TaskAPI.Logs(taskId, 3000).then((recs) => {
      const hist: LogLine[] = (recs ?? [])
        .filter((r): r is Record<string, any> => !!r && (r.type === "log" || r.type === "error"))
        .map((r) => ({ ts: Number(r.ts ?? 0), level: r.type === "error" ? "error" : String(r.level ?? "info"), msg: String(r.msg ?? r.code ?? "") }));
      const live = useApp.getState().logs[taskId] ?? [];
      const lastTs = hist.length ? hist[hist.length - 1].ts : 0;
      setLogs(taskId, [...hist, ...live.filter((l) => l.ts > lastTs)]);
    });
  }, [taskId, setLogs]);

  const elapsed = task && task.startedAt ? (task.finishedAt || Date.now() / 1000) - task.startedAt : undefined;

  return (
    <Drawer
      open={!!taskId}
      onClose={onClose}
      width={760}
      title={task ? <Flex gap={8} align="center"><PlatformTag id={task.platform} /><span>{task.title}</span><TaskStatus status={task.status} /></Flex> : "任务"}
      extra={task && isActive(task) && <Button danger icon={<StopOutlined />} onClick={() => TaskAPI.Cancel(task.id)}>停止</Button>}
    >
      {task && (
        <Flex vertical gap={16}>
          <Descriptions size="small" column={2} items={[
            { label: "账号", children: accountName(task.accountId) },
            { label: "创建时间", children: formatTime(task.createdAt) },
            { label: "用时", children: elapsed ? formatDuration(elapsed) : "-" },
            { label: "结果", children: task.error ? <Text type="danger">{task.error}</Text> : task.summary && Object.keys(task.summary).length ? <Text code>{JSON.stringify(task.summary)}</Text> : "-" },
          ]} />
          <TaskProgressBars progress={progress} task={task} />
          <LogView lines={lines ?? []} height="calc(100vh - 360px)" />
        </Flex>
      )}
    </Drawer>
  );
}

export default function TasksPage({ openTask }: { openTask: (id: string) => void }) {
  const tasks = useApp((s) => s.tasks);
  const progress = useApp((s) => s.progress);
  const loadTasks = useApp((s) => s.loadTasks);
  const [filter, setFilter] = useState("all");
  const { message } = AntApp.useApp();
  const accountName = useAccountName();

  const shown = useMemo(() => tasks.filter((t) => filter === "all" || (filter === "active" ? isActive(t) : !isActive(t))), [tasks, filter]);

  const remove = async (t: Task) => {
    try {
      await TaskAPI.Delete(t.id);
      await loadTasks();
    } catch (e) {
      message.error(errText(e));
    }
  };

  return (
    <Card title="任务记录" extra={<Segmented value={filter} onChange={(v) => setFilter(v as string)} options={[{ label: "全部", value: "all" }, { label: "进行中", value: "active" }, { label: "已结束", value: "done" }]} />}>
      <Table<Task>
        rowKey="id"
        dataSource={shown}
        pagination={{ pageSize: 15, hideOnSinglePage: true }}
        locale={{ emptyText: <Empty description="暂无任务" /> }}
        onRow={(t) => ({ onClick: () => openTask(t.id), style: { cursor: "pointer" } })}
        columns={[
          { title: "平台", dataIndex: "platform", width: 90, render: (p: string) => <PlatformTag id={p} /> },
          { title: "任务", render: (_, t) => <Flex vertical><Text strong ellipsis style={{ maxWidth: 320 }}>{t.title}</Text><Text type="secondary" style={{ fontSize: 12 }}>{accountName(t.accountId)}</Text></Flex> },
          { title: "进度", width: 220, render: (_, t) => <TaskProgressBars task={t} progress={progress[t.id]} compact /> },
          { title: "状态", dataIndex: "status", width: 100, render: (s: string) => <TaskStatus status={s} /> },
          { title: "开始时间", dataIndex: "createdAt", width: 170, render: (v: number) => <Text type="secondary">{formatTime(v)}</Text> },
          {
            title: "",
            width: 60,
            render: (_, t) => (
              <Space onClick={(e) => e.stopPropagation()}>
                {isActive(t) ? (
                  <Button size="small" danger icon={<StopOutlined />} onClick={() => TaskAPI.Cancel(t.id)} />
                ) : (
                  <Popconfirm title="删除这条记录？" onConfirm={() => remove(t)}>
                    <Button size="small" icon={<DeleteOutlined />} />
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
      />
    </Card>
  );
}
