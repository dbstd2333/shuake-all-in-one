// SPDX-License-Identifier: AGPL-3.0-or-later
import { CheckCircleFilled, CloseCircleFilled, FolderOpenOutlined, GithubOutlined } from "@ant-design/icons";
import { App as AntApp, Alert, Button, Card, Descriptions, Flex, Form, Input, InputNumber, Space, Switch, Tag, Typography } from "antd";
import { useEffect, useState } from "react";
import { AppAPI, errText, type Info, type Settings } from "../api";
import { useJobLogs } from "../components/JobLogs";

const { Text, Paragraph, Link } = Typography;

interface EnvResult {
  python: string;
  engine: string;
  platform: string;
  browser?: string | null;
  modules: { name: string; ok: boolean; version?: string; error?: string }[];
}

const UPSTREAMS = [
  { name: "dbstd2333/xuetangx-js", url: "https://github.com/dbstd2333/xuetangx-js", license: "AGPL-3.0", note: "学堂在线，已移植为 Python" },
  { name: "11273/mooc-work-answer", url: "https://github.com/11273/mooc-work-answer", license: "经作者授权", note: "智慧职教" },
  { name: "hangone/WeBan", url: "https://github.com/hangone/WeBan", license: "GPL-3.0", note: "安全微伴" },
  { name: "python-build-standalone", url: "https://github.com/astral-sh/python-build-standalone", license: "PSF / 多种", note: "内置 Python 运行时" },
];

export default function SettingsPage() {
  const [form] = Form.useForm();
  const { message } = AntApp.useApp();
  const showLogs = useJobLogs((s) => s.show);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [env, setEnv] = useState<EnvResult | null>(null);
  const [envJob, setEnvJob] = useState<{ id: string; error: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    AppAPI.GetSettings().then((s) => {
      setSettings(s);
      form.setFieldsValue({ ...s, aiKey: "" });
    });
    AppAPI.Info().then(setInfo);
  }, [form]);

  const save = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const { aiKey, ...rest } = v;
      const s = await AppAPI.SaveSettings({ ...settings!, ...rest }, aiKey || "", false);
      setSettings(s);
      form.setFieldsValue({ aiKey: "" });
      message.success("设置已保存");
    } catch (e) {
      message.error(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async () => {
    const s = await AppAPI.SaveSettings({ ...settings!, ...form.getFieldsValue(["aiEnabled", "aiBaseUrl", "aiModel", "concurrency", "browserPath", "debug"]) }, "", true);
    setSettings(s);
    message.success("已清除 API Key");
  };

  const testAI = async () => {
    const v = form.getFieldsValue();
    setTesting(true);
    try {
      const res = await AppAPI.TestAI(v.aiBaseUrl, v.aiModel, v.aiKey || "");
      if (res?.code === 0) message.success(`连接成功，模型回复：${res.data?.reply ?? ""}`);
      else message.error(`连接失败：${res?.error ?? ""}`);
    } catch (e) {
      message.error(errText(e));
    } finally {
      setTesting(false);
    }
  };

  const checkEnv = async () => {
    setChecking(true);
    setEnvJob(null);
    try {
      const res = await AppAPI.CheckEnv();
      if (res?.code === 0) setEnv(res.data as unknown as EnvResult);
      else setEnvJob({ id: res?.jobId ?? "", error: res?.error ?? "检测失败" });
    } catch (e) {
      setEnvJob({ id: "", error: errText(e) });
    } finally {
      setChecking(false);
    }
  };

  return (
    <Flex vertical gap={16}>
      <Card title="AI 答题" extra={<Text type="secondary">兼容 OpenAI 接口（DeepSeek、通义、Kimi、本地 Ollama 等）</Text>}>
        <Form form={form} layout="horizontal" labelCol={{ flex: "140px" }} colon={false} disabled={!settings}>
          <Form.Item name="aiEnabled" label="启用 AI 答题" valuePropName="checked"><Switch /></Form.Item>
          <Form.Item name="aiBaseUrl" label="接口地址" extra="例如 https://api.deepseek.com 或 https://api.openai.com/v1"><Input /></Form.Item>
          <Form.Item name="aiModel" label="模型"><Input placeholder="deepseek-chat" /></Form.Item>
          <Form.Item label="API Key" extra={settings?.aiHasKey ? "已保存（加密存储）。输入新值可替换。" : "未设置"}>
            <Space.Compact style={{ width: "100%" }}>
              <Form.Item name="aiKey" noStyle><Input.Password placeholder={settings?.aiHasKey ? "••••••••（已保存）" : "sk-..."} autoComplete="off" /></Form.Item>
              {settings?.aiHasKey && <Button onClick={clearKey}>清除</Button>}
            </Space.Compact>
          </Form.Item>
          <Form.Item label=" ">
            <Button onClick={testAI} loading={testing}>测试连接</Button>
          </Form.Item>

          <Typography.Title level={5} style={{ marginTop: 8 }}>运行</Typography.Title>
          <Form.Item name="concurrency" label="同时运行任务数" extra="每个任务是一个独立进程；同一平台多账号同时运行可能触发风控"><InputNumber min={1} max={10} /></Form.Item>
          <Form.Item name="browserPath" label="浏览器路径" extra="安全微伴的课程验证码需要 Chrome / Edge。留空则自动检测。"><Input placeholder="自动检测" /></Form.Item>
          <Form.Item name="debug" label="调试模式" valuePropName="checked" extra="输出更详细的日志（包括网络请求），排查问题时开启"><Switch /></Form.Item>
          <Form.Item label=" ">
            <Button type="primary" onClick={save} loading={saving}>保存设置</Button>
          </Form.Item>
        </Form>
      </Card>

      <Card title="运行环境" extra={<Button onClick={checkEnv} loading={checking}>检测环境</Button>}>
        <Descriptions size="small" column={1} items={[
          { label: "版本", children: info?.version },
          { label: "数据目录", children: <Flex gap={8} align="center"><Text code copyable>{info?.dataDir}</Text><Button size="small" icon={<FolderOpenOutlined />} onClick={() => AppAPI.OpenDataDir()}>打开</Button></Flex> },
          { label: "Python", children: info?.envError ? <Text type="danger">{info.envError}</Text> : <Text code>{info?.python}</Text> },
          { label: "凭证加密", children: info?.keyBackend === "keychain" ? "系统钥匙串" : "本地密钥文件" },
        ]} />
        {envJob && (
          <Alert type="error" showIcon style={{ marginTop: 12 }} message={envJob.error}
            action={envJob.id && <Button size="small" onClick={() => showLogs(envJob.id, "环境检测日志")}>查看日志</Button>} />
        )}
        {env && (
          <Flex vertical gap={8} style={{ marginTop: 12 }}>
            <Text>Python {env.python} · 引擎 {env.engine} · {env.platform}</Text>
            <Flex wrap gap={6}>
              {env.modules.map((m) => (
                <Tag key={m.name} color={m.ok ? "success" : "error"} icon={m.ok ? <CheckCircleFilled /> : <CloseCircleFilled />} title={m.error}>
                  {m.name} {m.version}
                </Tag>
              ))}
            </Flex>
            <Text>
              浏览器：{env.browser ? <Text code>{env.browser}</Text> : <Text type="warning">未检测到 Chrome / Edge，安全微伴的课程验证码将无法处理</Text>}
            </Text>
          </Flex>
        )}
      </Card>

      <Card title="关于">
        <Paragraph>
          刷课 All-in-One 以 <Text strong>GNU AGPL-3.0</Text> 协议开源。本软件整合了以下项目，并在此致谢：
        </Paragraph>
        <Flex vertical gap={4}>
          {UPSTREAMS.map((u) => (
            <Text key={u.name}>
              <GithubOutlined /> <Link onClick={() => AppAPI.OpenURL(u.url)}>{u.name}</Link> <Tag>{u.license}</Tag><Text type="secondary">{u.note}</Text>
            </Text>
          ))}
        </Flex>
        <Alert style={{ marginTop: 16 }} type="warning" showIcon message="使用须知" description="自动化学习与答题可能违反相关平台的用户协议，存在账号被限制的风险。请仅用于学习研究，并自行承担使用后果。" />
      </Card>
    </Flex>
  );
}
