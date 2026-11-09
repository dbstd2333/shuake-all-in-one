// SPDX-License-Identifier: AGPL-3.0-or-later
import { ThunderboltOutlined } from "@ant-design/icons";
import { App as AntApp, Alert, Button, Card, Collapse, Empty, Flex, Form, Input, Radio, Select, Space, Table, Tag, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import { TaskAPI, errText, type Account, type Batch, type BatchItem, type BatchRequest } from "../api";
import { PlatformTag, TaskStatus, formatTime } from "../components/common";
import { PLATFORMS, defaultOptions, platformById } from "../platforms";
import { useApp } from "../stores/app";
import { LoginStateTagFor, accountLabel } from "./Accounts";
import { OptionInput, collectOptions, loadSavedOptions } from "./NewTask";

const { Text } = Typography;

const ITEM_STATE: Record<string, { color: string; text: string }> = {
  pending: { color: "default", text: "等待" },
  listing: { color: "processing", text: "获取课程" },
  queued: { color: "success", text: "已建任务" },
  skipped: { color: "warning", text: "已跳过" },
  failed: { color: "error", text: "失败" },
};

const MODE_TEXT: Record<string, string> = { unfinished: "未完成的课程", all: "全部课程", keyword: "按关键词" };

function BatchItems({ batch, openTask }: { batch: Batch; openTask: (id: string) => void }) {
  const tasks = useApp((s) => s.tasks);
  return (
    <Table<BatchItem>
      size="small"
      rowKey="accountId"
      dataSource={batch.items ?? []}
      pagination={(batch.items?.length ?? 0) > 20 ? { pageSize: 20, size: "small" } : false}
      columns={[
        { title: "账号", dataIndex: "accountName", width: 180, ellipsis: true },
        { title: "准备", dataIndex: "state", width: 100, render: (s: string) => <Tag color={ITEM_STATE[s]?.color}>{ITEM_STATE[s]?.text ?? s}</Tag> },
        {
          title: "任务",
          width: 110,
          render: (_, it) => {
            const t = it.taskId ? tasks.find((x) => x.id === it.taskId) : undefined;
            return t ? <a onClick={() => openTask(t.id)}><TaskStatus status={t.status} /></a> : <Text type="secondary">-</Text>;
          },
        },
        { title: "说明", dataIndex: "message", ellipsis: true, render: (m?: string) => <Text type="secondary">{m}</Text> },
      ]}
    />
  );
}

function batchSummary(b: Batch, statusOf: (id?: string) => string | undefined) {
  const items = b.items ?? [];
  const count = (fn: (it: BatchItem) => boolean) => items.filter(fn).length;
  const running = count((it) => ["running", "queued"].includes(statusOf(it.taskId) ?? ""));
  const success = count((it) => statusOf(it.taskId) === "success");
  const failed = count((it) => it.state === "failed" || statusOf(it.taskId) === "failed");
  const skipped = count((it) => it.state === "skipped");
  return { total: items.length, running, success, failed, skipped };
}

export default function BatchPage({ accountIds, openTask }: { accountIds?: string[]; openTask: (id: string) => void }) {
  const accounts = useApp((s) => s.accounts);
  const batches = useApp((s) => s.batches);
  const tasks = useApp((s) => s.tasks);
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const initialPlatform = useMemo(() => {
    const first = accounts.find((a) => accountIds?.includes(a.id));
    return first?.platform ?? accounts.find((a) => !platformById(a.platform).hidden)?.platform ?? PLATFORMS[0].id;
  }, [accounts, accountIds]);
  const [platformId, setPlatformId] = useState(initialPlatform);
  const [selected, setSelected] = useState<string[]>(accountIds ?? []);
  const [mode, setMode] = useState<BatchRequest["mode"]>("unfinished");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    setPlatformId(initialPlatform);
    if (accountIds?.length) setSelected(accountIds);
  }, [initialPlatform, accountIds]);

  const platform = platformById(platformId);
  const list = useMemo(() => accounts.filter((a) => a.platform === platformId), [accounts, platformId]);
  const picked = selected.filter((id) => list.some((a) => a.id === id));
  const notLoggedIn = list.filter((a) => picked.includes(a.id) && a.status !== "ok").length;
  const statusOf = (id?: string) => (id ? tasks.find((t) => t.id === id)?.status : undefined);

  const start = async () => {
    const opts = collectOptions(platform, await form.validateFields());
    setStarting(true);
    try {
      await TaskAPI.StartBatch({ accountIds: picked, options: opts, mode, keywords, title: title.trim() });
      message.success(`已开始为 ${picked.length} 个账号准备任务`);
    } catch (e) {
      message.error(errText(e));
    } finally {
      setStarting(false);
    }
  };

  const platformsWithAccounts = PLATFORMS.filter((p) => accounts.some((a) => a.platform === p.id));

  return (
    <Flex vertical gap={16}>
      <Card title="批量建任务" extra={<Text type="secondary">为多个账号一键获取课程并加入任务队列</Text>}>
        {platformsWithAccounts.length === 0 ? (
          <Empty description="还没有账号，先到「账号」页添加或批量导入" />
        ) : (
          <Flex vertical gap={20}>
            <Flex gap={12} align="center" wrap>
              <Text strong>平台</Text>
              <Select
                style={{ minWidth: 240 }}
                value={platformId}
                onChange={(v) => setPlatformId(v)}
                options={platformsWithAccounts.map((p) => ({ value: p.id, label: <Flex gap={8} align="center"><PlatformTag id={p.id} />{p.name}</Flex> }))}
              />
            </Flex>

            <div>
              <Flex justify="space-between" align="center" style={{ marginBottom: 8 }} wrap gap={8}>
                <Text strong>账号（已选 {picked.length} / {list.length}）</Text>
                <Space>
                  <Button size="small" onClick={() => setSelected(list.filter((a) => a.status === "ok").map((a) => a.id))}>选择已登录的</Button>
                  <Button size="small" onClick={() => setSelected(list.map((a) => a.id))}>全选</Button>
                  <Button size="small" type="text" onClick={() => setSelected([])}>清空</Button>
                </Space>
              </Flex>
              <Table<Account>
                size="small"
                rowKey="id"
                dataSource={list}
                pagination={list.length > 10 ? { pageSize: 10, size: "small" } : false}
                rowSelection={{ selectedRowKeys: picked, onChange: (keys) => setSelected(keys as string[]) }}
                columns={[
                  { title: "账号", render: (_, a) => accountLabel(a) },
                  { title: "学校 / 用户名", render: (_, a) => <Text type="secondary">{[a.fields?.tenant_name, a.fields?.username].filter(Boolean).join(" · ") || "-"}</Text> },
                  { title: "状态", width: 110, render: (_, a) => <LoginStateTagFor account={a} /> },
                ]}
              />
              {notLoggedIn > 0 && (
                <Alert style={{ marginTop: 8 }} type="info" showIcon
                  message={`有 ${notLoggedIn} 个选中的账号还没有登录：获取课程时会尝试登录，需要扫码或验证码时会依次弹出。`} />
              )}
            </div>

            <Flex vertical gap={8}>
              <Text strong>选课方式</Text>
              <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)}>
                <Radio value="unfinished">未完成的课程（进度不足 100%）</Radio>
                <Radio value="all">全部课程</Radio>
                <Radio value="keyword">名称包含关键词</Radio>
              </Radio.Group>
              {mode === "keyword" && (
                <Select mode="tags" value={keywords} onChange={setKeywords} tokenSeparators={[",", "，", " "]} placeholder="输入关键词后回车，任意一个匹配即可" style={{ maxWidth: 480 }} />
              )}
            </Flex>

            <Card size="small" title={`${platform.name} · 任务设置`}>
              <Form form={form} key={platform.id} initialValues={{ ...defaultOptions(platform), ...loadSavedOptions(platform.id) }} layout="horizontal" labelCol={{ flex: "180px" }} labelWrap colon={false}>
                {platform.options.length === 0 && <Text type="secondary">该平台没有额外设置</Text>}
                {platform.options.map((f) => (
                  <Form.Item key={f.key} name={f.key} label={f.label} extra={f.help} valuePropName={f.type === "switch" ? "checked" : "value"}>
                    <OptionInput f={f} />
                  </Form.Item>
                ))}
                <Form.Item label="任务名前缀" extra="可选；留空时使用「账号 · 课程名」">
                  <Input value={title} onChange={(e) => setTitle(e.target.value)} style={{ maxWidth: 320 }} />
                </Form.Item>
              </Form>
            </Card>

            <Flex justify="flex-end" gap={12} align="center">
              <Text type="secondary">任务会按「设置」里的并发数排队执行</Text>
              <Button type="primary" size="large" icon={<ThunderboltOutlined />} loading={starting}
                disabled={picked.length === 0 || (mode === "keyword" && keywords.length === 0)} onClick={start}>
                为 {picked.length} 个账号开始
              </Button>
            </Flex>
          </Flex>
        )}
      </Card>

      <Card title="最近的批量任务">
        {batches.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无（服务重启后清空）" />
        ) : (
          <Collapse
            defaultActiveKey={[batches[0].id]}
            items={batches.map((b) => {
              const s = batchSummary(b, statusOf);
              const first = b.items?.[0];
              const pid = first ? accounts.find((a) => a.id === first.accountId)?.platform : undefined;
              return {
                key: b.id,
                label: (
                  <Flex gap={8} align="center" wrap>
                    {pid && <PlatformTag id={pid} />}
                    <Text strong>{b.title || MODE_TEXT[b.mode] || "批量任务"}</Text>
                    <Text type="secondary">{formatTime(b.createdAt)} · {s.total} 个账号</Text>
                    {!b.done && <Tag color="processing">准备中</Tag>}
                    {s.running > 0 && <Tag color="blue">进行中 {s.running}</Tag>}
                    {s.success > 0 && <Tag color="success">完成 {s.success}</Tag>}
                    {s.failed > 0 && <Tag color="error">失败 {s.failed}</Tag>}
                    {s.skipped > 0 && <Tag color="warning">跳过 {s.skipped}</Tag>}
                  </Flex>
                ),
                children: <BatchItems batch={b} openTask={openTask} />,
              };
            })}
          />
        )}
      </Card>
    </Flex>
  );
}
