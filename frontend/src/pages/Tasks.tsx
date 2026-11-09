// SPDX-License-Identifier: AGPL-3.0-or-later
import { DeleteOutlined, RedoOutlined, StopOutlined } from "@ant-design/icons";
import { App as AntApp, Button, Card, Descriptions, Drawer, Empty, Flex, Popconfirm, Segmented, Select, Space, Table, Tooltip, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import { TaskAPI, errText, type Task } from "../api";
import LogView from "../components/LogView";
import { PlatformTag, TaskProgressBars, TaskStatus, formatDuration, formatTime } from "../components/common";
import { PLATFORMS } from "../platforms";
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
      extra={task && (isActive(task)
        ? <Button danger icon={<StopOutlined />} onClick={() => TaskAPI.Cancel(task.id)}>停止</Button>
        : <Button icon={<RedoOutlined />} onClick={() => TaskAPI.Retry(task.id)}>重新运行</Button>)}
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
  const [platform, setPlatform] = useState<string>("all");
  const [selected, setSelected] = useState<string[]>([]);
  const { message } = AntApp.useApp();
  const accountName = useAccountName();

  const shown = useMemo(
    () => tasks.filter((t) =>
      (platform === "all" || t.platform === platform) &&
      (filter === "all" || (filter === "active" ? isActive(t) : filter === "failed" ? t.status === "failed" || t.status === "cancelled" : !isActive(t)))),
    [tasks, filter, platform],
  );
  useEffect(() => setSelected((sel) => sel.filter((id) => shown.some((t) => t.id === id))), [shown]);
  const picked = shown.filter((t) => selected.includes(t.id));

  const remove = async (t: Task) => {
    try {
      await TaskAPI.Delete(t.id);
      await loadTasks();
    } catch (e) {
      message.error(errText(e));
    }
  };

  const bulk = async (label: string, list: Task[], fn: (t: Task) => Promise<unknown>) => {
    let ok = 0;
    const errs: string[] = [];
    for (const t of list) {
      try {
        await fn(t);
        ok++;
      } catch (e) {
        errs.push(errText(e));
      }
    }
    await loadTasks();
    setSelected([]);
    if (errs.length) message.warning(`${label} ${ok} 个，${errs.length} 个失败：${errs[0]}`);
    else message.success(`已${label} ${ok} 个任务`);
  };

  const active = picked.filter(isActive);
  const finished = picked.filter((t) => !isActive(t));

  return (
    <Card
      title="任务记录"
      extra={
        <Space wrap>
          <Select size="middle" value={platform} onChange={setPlatform} style={{ width: 150 }}
            options={[{ value: "all", label: "全部平台" }, ...PLATFORMS.map((p) => ({ value: p.id, label: p.short }))]} />
          <Segmented value={filter} onChange={(v) => setFilter(v as string)} options={[{ label: "全部", value: "all" }, { label: "进行中", value: "active" }, { label: "失败/停止", value: "failed" }, { label: "已结束", value: "done" }]} />
        </Space>
      }
    >
      {picked.length > 0 && (
        <Flex className="batch-bar" gap={8} align="center" wrap>
          <Text strong>已选 {picked.length} 个</Text>
          <Button size="small" danger icon={<StopOutlined />} disabled={active.length === 0} onClick={() => bulk("停止", active, (t) => TaskAPI.Cancel(t.id))}>停止 {active.length || ""}</Button>
          <Button size="small" icon={<RedoOutlined />} disabled={finished.length === 0} onClick={() => bulk("重新运行", finished, (t) => TaskAPI.Retry(t.id))}>重新运行 {finished.length || ""}</Button>
          <Popconfirm title={`删除 ${finished.length} 条已结束的记录？`} disabled={finished.length === 0} onConfirm={() => bulk("删除", finished, (t) => TaskAPI.Delete(t.id))}>
            <Button size="small" icon={<DeleteOutlined />} disabled={finished.length === 0}>删除 {finished.length || ""}</Button>
          </Popconfirm>
          <Button size="small" type="text" onClick={() => setSelected([])}>取消选择</Button>
        </Flex>
      )}
      <Table<Task>
        rowKey="id"
        dataSource={shown}
        pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
        locale={{ emptyText: <Empty description="暂无任务" /> }}
        rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected(keys as string[]) }}
        onRow={(t) => ({ onClick: () => openTask(t.id), style: { cursor: "pointer" } })}
        scroll={{ x: 820 }}
        columns={[
          { title: "平台", dataIndex: "platform", width: 90, render: (p: string) => <PlatformTag id={p} /> },
          { title: "任务", render: (_, t) => <Flex vertical><Text strong ellipsis style={{ maxWidth: 320 }}>{t.title}</Text><Text type="secondary" style={{ fontSize: 12 }}>{accountName(t.accountId)}</Text></Flex> },
          { title: "进度", width: 200, render: (_, t) => <TaskProgressBars task={t} progress={progress[t.id]} compact /> },
          {
            title: "状态", dataIndex: "status", width: 100,
            render: (s: string, t) => (t.error ? <Tooltip title={t.error}><span><TaskStatus status={s} /></span></Tooltip> : <TaskStatus status={s} />),
          },
          { title: "开始时间", dataIndex: "createdAt", width: 170, render: (v: number) => <Text type="secondary">{formatTime(v)}</Text> },
          {
            title: "",
            width: 90,
            render: (_, t) => (
              <Space onClick={(e) => e.stopPropagation()}>
                {isActive(t) ? (
                  <Button size="small" danger icon={<StopOutlined />} onClick={() => TaskAPI.Cancel(t.id)} />
                ) : (
                  <>
                    <Tooltip title="重新运行"><Button size="small" icon={<RedoOutlined />} onClick={() => TaskAPI.Retry(t.id).catch((e) => message.error(errText(e)))} /></Tooltip>
                    <Popconfirm title="删除这条记录？" onConfirm={() => remove(t)}>
                      <Button size="small" icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </>
                )}
              </Space>
            ),
          },
        ]}
      />
    </Card>
  );
}
