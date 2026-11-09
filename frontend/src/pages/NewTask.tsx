// SPDX-License-Identifier: AGPL-3.0-or-later
import { ReloadOutlined, RocketOutlined } from "@ant-design/icons";
import { App as AntApp, Alert, Button, Card, Empty, Flex, Form, Input, InputNumber, Progress, Select, Space, Steps, Switch, Table, Typography } from "antd";
import { useEffect, useState } from "react";
import { AppAPI, TaskAPI, errText, type Account } from "../api";
import { AccountStatus, PlatformTag } from "../components/common";
import { defaultOptions, platformById, type OptionField, type PlatformMeta } from "../platforms";
import { useApp } from "../stores/app";
import { useLogin } from "./Accounts";
import { useJobLogs } from "../components/JobLogs";

const { Text } = Typography;

interface Course {
  id: string;
  name: string;
  progress?: number | null;
  extra?: Record<string, unknown>;
}

const OPTIONS_KEY = "shuake.taskOptions.";

export function loadSavedOptions(platform: string): Record<string, unknown> {
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY + platform) || "{}") as Record<string, unknown>;
    // Empty fields must not override the defaults.
    return Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== null && v !== undefined && v !== ""));
  } catch {
    return {};
  }
}

/** Form control for a platform option. Form.Item injects value/onChange/id, which must reach the control. */
export function OptionInput({ f, ...control }: { f: OptionField; [prop: string]: any }) {
  switch (f.type) {
    case "switch":
      return <Switch {...control} />;
    case "number":
      return <InputNumber {...control} min={f.min} max={f.max} addonAfter={f.suffix} style={{ width: 180 }} />;
    case "select":
      return <Select {...control} options={f.options} style={{ width: 220 }} />;
    case "tags":
      return <Select {...control} mode="tags" style={{ width: "100%" }} tokenSeparators={[",", "，"]} />;
    default:
      return <Input {...control} placeholder={f.placeholder} />;
  }
}

/** Merges form values with defaults, remembers them per platform and normalizes types. */
export function collectOptions(platform: PlatformMeta, values: Record<string, unknown>): Record<string, unknown> {
  const opts = { ...defaultOptions(platform), ...values } as Record<string, unknown>;
  for (const [k, v] of Object.entries(opts)) if (v === null || v === undefined || v === "") opts[k] = defaultOptions(platform)[k];
  try {
    localStorage.setItem(OPTIONS_KEY + platform.id, JSON.stringify(opts));
  } catch {
    /* ignore */
  }
  if (platform.id === "weban" && typeof opts.video_speed === "string") opts.video_speed = Number(opts.video_speed);
  return opts;
}

export default function NewTaskPage({ accountId, onStarted }: { accountId?: string; onStarted: (taskId: string) => void }) {
  const accounts = useApp((s) => s.accounts);
  const { message } = AntApp.useApp();
  const { login, busy: loginBusy } = useLogin();
  const [selected, setSelected] = useState<string | undefined>(accountId);
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [jobId, setJobId] = useState<string>();
  const [error, setError] = useState<string>();
  const [urls, setUrls] = useState("");
  const [starting, setStarting] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [form] = Form.useForm();
  const showLogs = useJobLogs((s) => s.show);

  const account: Account | undefined = accounts.find((a) => a.id === selected);
  const platform = account ? platformById(account.platform) : undefined;

  useEffect(() => setSelected(accountId), [accountId]);
  useEffect(() => {
    if (!selected && accounts.length === 1) setSelected(accounts[0].id);
  }, [accounts, selected]);
  useEffect(() => {
    AppAPI.GetSettings().then((s) => setAiEnabled(!!s?.aiEnabled));
  }, []);

  useEffect(() => {
    setCourses(null);
    setPicked([]);
    setError(undefined);
  }, [selected]);

  const fetchCourses = async () => {
    if (!account) return;
    setLoading(true);
    setError(undefined);
    try {
      const opts: Record<string, unknown> = {};
      const list = urls.split(/\s+/).map((s) => s.trim()).filter(Boolean);
      if (list.length) opts.course_urls = list;
      const res = await TaskAPI.ListCourses(account.id, opts);
      setJobId(res?.jobId);
      if (res?.code === 0) {
        const cs = ((res.data?.courses ?? []) as Course[]).map((c) => ({ ...c, id: String(c.id) }));
        setCourses(cs);
        setPicked(cs.filter((c) => c.progress == null || c.progress < 100).map((c) => c.id));
      } else if (res?.code !== 3) {
        setError(res?.error || "获取失败");
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  };

  const start = async () => {
    if (!account || !platform) return;
    const opts = collectOptions(platform, await form.validateFields());
    const names = (courses ?? []).filter((c) => picked.includes(c.id)).map((c) => c.name);
    const extra = (courses ?? []).filter((c) => picked.includes(c.id));
    const title = names.length === 0 ? "全部" : names.length === 1 ? names[0] : `${names[0]} 等 ${names.length} 门`;
    setStarting(true);
    try {
      const t = await TaskAPI.Start(account.id, title, { ...opts, course_ids: picked, courses: extra });
      message.success("任务已开始");
      if (t) onStarted(t.id);
    } catch (e) {
      message.error(errText(e));
    } finally {
      setStarting(false);
    }
  };

  const step = !account ? 0 : !courses ? 1 : 2;
  const visibleAccounts = accounts.filter((a) => !platformById(a.platform).hidden || a.platform === account?.platform || true);

  const allowEmptySelection = platform?.id === "weban";
  const needsAI = platform && ((platform.id === "icve_mooc" && form.getFieldValue("ai_answer")) || platform.id === "xuetangx");

  return (
    <Card title="新建任务">
      <Steps
        current={step}
        size="small"
        style={{ marginBottom: 24 }}
        items={[{ title: "选择账号" }, { title: `选择${platform?.courseNoun ?? "课程"}` }, { title: "设置并开始" }]}
      />
      <Flex vertical gap={20}>
        <Flex gap={12} align="center" wrap>
          <Select
            style={{ minWidth: 360 }}
            placeholder="选择账号"
            value={selected}
            onChange={setSelected}
            options={visibleAccounts.map((a) => ({
              value: a.id,
              label: (
                <Flex gap={8} align="center">
                  <PlatformTag id={a.platform} />
                  <span>{a.name || (a.user?.name as string) || (a.fields?.username as string) || "未命名"}</span>
                </Flex>
              ),
            }))}
            notFoundContent={<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请先在“账号”页添加账号" />}
          />
          {account && <AccountStatus status={account.status} />}
          {account && account.status !== "ok" && (
            <Button loading={loginBusy === account.id} onClick={() => login(account)}>登录</Button>
          )}
        </Flex>

        {account && platform && (
          <Card size="small" title={`${platform.courseNoun}列表`} extra={<Button icon={<ReloadOutlined />} loading={loading} onClick={fetchCourses}>{courses ? "刷新" : `获取${platform.courseNoun}`}</Button>}>
            {platform.id === "xuetangx" && (
              <Flex vertical gap={6} style={{ marginBottom: 12 }}>
                <Text type="secondary">如果列表中缺少课程，可以粘贴课程链接（每行一个），再点击获取：</Text>
                <Input.TextArea rows={2} value={urls} onChange={(e) => setUrls(e.target.value)} placeholder="https://www.xuetangx.com/learn/xxx/xxx/1234567/video/..." />
              </Flex>
            )}
            {error && (
              <Alert
                type="error"
                showIcon
                message={error}
                style={{ marginBottom: 12 }}
                action={jobId && <Button size="small" onClick={() => showLogs(jobId, "获取课程日志")}>查看日志</Button>}
              />
            )}
            {loading && <Text type="secondary">正在获取，如需登录请按弹窗提示操作…</Text>}
            {courses && (
              <Table<Course>
                size="small"
                rowKey="id"
                dataSource={courses}
                pagination={courses.length > 10 ? { pageSize: 10 } : false}
                rowSelection={{ selectedRowKeys: picked, onChange: (keys) => setPicked(keys as string[]) }}
                locale={{ emptyText: <Empty description={`没有找到${platform.courseNoun}`} /> }}
                columns={[
                  { title: "名称", dataIndex: "name" },
                  {
                    title: "进度",
                    dataIndex: "progress",
                    width: 200,
                    render: (p?: number | null) => (p == null ? <Text type="secondary">-</Text> : <Progress percent={Math.round(p)} size="small" />),
                  },
                ]}
              />
            )}
          </Card>
        )}

        {account && platform && courses && (
          <Card size="small" title="任务设置">
            {needsAI && !aiEnabled && (
              <Alert type="info" showIcon style={{ marginBottom: 16 }} message="尚未启用 AI 答题，题目会随机作答。可以在“设置”中配置 AI 接口。" />
            )}
            <Form form={form} key={platform.id} initialValues={{ ...defaultOptions(platform), ...loadSavedOptions(platform.id) }} layout="horizontal" labelCol={{ flex: "180px" }} labelWrap colon={false}>
              {platform.options.length === 0 && <Text type="secondary">该平台没有额外设置</Text>}
              {platform.options.map((f) => (
                <Form.Item key={f.key} name={f.key} label={f.label} extra={f.help} valuePropName={f.type === "switch" ? "checked" : "value"}>
                  <OptionInput f={f} />
                </Form.Item>
              ))}
            </Form>
            <Flex justify="flex-end" gap={12} align="center">
              <Text type="secondary">已选 {picked.length} 个{platform.courseNoun}{allowEmptySelection && picked.length === 0 ? "（将处理全部）" : ""}</Text>
              <Space>
                <Button type="primary" size="large" icon={<RocketOutlined />} loading={starting} disabled={!allowEmptySelection && picked.length === 0} onClick={start}>
                  开始任务
                </Button>
              </Space>
            </Flex>
          </Card>
        )}
      </Flex>
    </Card>
  );
}
