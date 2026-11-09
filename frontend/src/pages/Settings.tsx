// SPDX-License-Identifier: AGPL-3.0-or-later
import { CheckCircleFilled, CloseCircleFilled, FolderOpenOutlined, GithubOutlined } from "@ant-design/icons";
import { App as AntApp, Alert, AutoComplete, Button, Card, Descriptions, Flex, Form, Input, InputNumber, Radio, Space, Switch, Tag, Typography } from "antd";
import { useEffect, useState } from "react";
import { AppAPI, SERVER, errText, openURL, type AIProvider, type AIThinking, type Info, type Settings } from "../api";
import { PLATFORMS } from "../platforms";
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

interface ProviderPreset {
  label: string;
  baseUrl: string;
  model: string;
  models: { value: string; label?: string }[];
  urlHint: string;
  keyUrl?: string;
  thinking: { value: AIThinking; label: string }[];
}

const PROVIDERS: Record<AIProvider, ProviderPreset> = {
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
    models: [{ value: "deepseek-flash", label: "deepseek-flash（快、便宜，推荐）" }, { value: "deepseek-v4-pro", label: "deepseek-v4-pro" }],
    urlHint: "一般不用改",
    keyUrl: "https://platform.deepseek.com/api_keys",
    thinking: [
      { value: "off", label: "关闭" },
      { value: "low", label: "低" },
      { value: "high", label: "高" },
      { value: "max", label: "最高" },
    ],
  },
  aliyun: {
    label: "阿里云百炼",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.8-flash",
    models: [{ value: "qwen3.8-flash", label: "qwen3.8-flash（快、便宜，推荐）" }, { value: "qwen-flash" }, { value: "qwen-plus" }],
    urlHint: "新加坡等海外地域、或使用工作空间专属地址（https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1）时请改成控制台给出的地址",
    keyUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key",
    thinking: [
      { value: "off", label: "关闭" },
      { value: "low", label: "低" },
      { value: "medium", label: "中" },
      { value: "high", label: "高" },
      { value: "max", label: "不限" },
    ],
  },
  custom: {
    label: "自定义",
    baseUrl: "",
    model: "",
    models: [],
    urlHint: "任何兼容 OpenAI 接口的服务，例如 https://api.openai.com/v1、Kimi、本地 Ollama（http://127.0.0.1:11434/v1）",
    thinking: [
      { value: "", label: "不设置" },
      { value: "off", label: "关闭" },
      { value: "low", label: "低" },
      { value: "medium", label: "中" },
      { value: "high", label: "高" },
    ],
  },
};

const THINKING_HINT: Record<AIProvider, string> = {
  deepseek: "思考越深越准，但每题更慢、更贵（思考内容按输出 token 计费）。选择题建议「低」，题目难再调高",
  aliyun: "低 / 中 / 高分别限制思考约 1K / 4K / 16K token，「不限」由模型自己决定。思考越深越准，但每题更慢、更贵。选择题建议「低」",
  custom: "以 OpenAI 的 reasoning_effort 参数发送；「不设置」则什么都不传，按模型默认。接口不支持时会自动去掉",
};

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
  const [keyStatus, setKeyStatus] = useState<Partial<Record<AIProvider, boolean>>>({});
  const provider: AIProvider = Form.useWatch("aiProvider", form) ?? settings?.aiProvider ?? "deepseek";
  const preset = PROVIDERS[provider] ?? PROVIDERS.custom;
  const hasKey = keyStatus[provider] ?? (provider === settings?.aiProvider && settings?.aiHasKey);

  const refreshKeys = () => AppAPI.AIKeyStatus().then(setKeyStatus).catch(() => {});

  const changeProvider = (p: AIProvider) => {
    const next = PROVIDERS[p];
    const patch: Partial<Settings> = {};
    if (p !== "custom") {
      patch.aiBaseUrl = next.baseUrl;
      patch.aiModel = next.model;
    } else if (settings?.aiProvider === "custom") {
      patch.aiBaseUrl = settings.aiBaseUrl;
      patch.aiModel = settings.aiModel;
    } else {
      patch.aiBaseUrl = "";
      patch.aiModel = "";
    }
    if (!next.thinking.some((t) => t.value === form.getFieldValue("aiThinking"))) {
      patch.aiThinking = p === "custom" ? "" : "low";
    }
    form.setFieldsValue(patch);
  };

  useEffect(() => {
    AppAPI.GetSettings().then((s) => {
      setSettings(s);
      form.setFieldsValue({ ...s, aiKey: "" });
    });
    refreshKeys();
    AppAPI.Info().then(setInfo);
  }, [form]);

  const save = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const { aiKey, ...rest } = v;
      const s = await AppAPI.SaveSettings({ ...settings!, ...rest }, aiKey || "", false);
      setSettings(s);
      form.setFieldsValue({ aiKey: "", aiBaseUrl: s.aiBaseUrl, aiModel: s.aiModel });
      refreshKeys();
      message.success("设置已保存");
    } catch (e) {
      message.error(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async () => {
    const { aiKey: _ignored, ...rest } = form.getFieldsValue();
    const s = await AppAPI.SaveSettings({ ...settings!, ...rest }, "", true);
    setSettings(s);
    refreshKeys();
    message.success("已清除 API Key");
  };

  const testAI = async () => {
    const { aiKey, ...rest } = form.getFieldsValue();
    setTesting(true);
    try {
      const res = await AppAPI.TestAI({ ...settings!, ...rest }, aiKey || "");
      if (res?.code === 0) message.success(`连接成功（${res.data?.seconds ?? "?"} 秒），模型回复：${res.data?.reply ?? ""}`);
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
      <Card title="AI 答题" extra={<Text type="secondary">题库没有答案时由 AI 作答（学堂在线、智慧职教、安全微伴）</Text>}>
        <Form form={form} layout="horizontal" labelCol={{ flex: "140px" }} colon={false} disabled={!settings}>
          <Form.Item name="aiEnabled" label="启用 AI 答题" valuePropName="checked"><Switch /></Form.Item>
          <Form.Item name="aiProvider" label="服务商">
            <Radio.Group optionType="button" onChange={(e) => changeProvider(e.target.value)}
              options={(Object.keys(PROVIDERS) as AIProvider[]).map((p) => ({ value: p, label: PROVIDERS[p].label }))} />
          </Form.Item>
          <Form.Item name="aiModel" label="模型" rules={[{ required: true, message: "请填写模型名称" }]}>
            <AutoComplete options={preset.models} placeholder={provider === "custom" ? "例如 gpt-5-mini" : preset.model}
              filterOption={false} />
          </Form.Item>
          <Form.Item name="aiThinking" label="思考强度" extra={THINKING_HINT[provider]}>
            <Radio.Group optionType="button" options={preset.thinking} />
          </Form.Item>
          <Form.Item name="aiBaseUrl" label="接口地址" extra={preset.urlHint} rules={[{ required: true, message: "请填写接口地址" }]}>
            <Input placeholder={preset.baseUrl || "https://..."} />
          </Form.Item>
          <Form.Item label="API Key" extra={<>
            {hasKey ? `已保存 ${preset.label} 的 Key（加密存储）。输入新值可替换。` : provider === "custom" ? "未设置" : `未设置 ${preset.label} 的 Key`}
            {preset.keyUrl && <> · <Link onClick={() => openURL(preset.keyUrl!)}>去获取</Link></>}
            {provider !== "custom" && " · 每个服务商的 Key 分开保存，切换不会丢失"}
          </>}>
            <Space.Compact style={{ width: "100%" }}>
              <Form.Item name="aiKey" noStyle><Input.Password placeholder={hasKey ? "••••••••（已保存）" : "sk-..."} autoComplete="off" /></Form.Item>
              {hasKey && <Button onClick={clearKey}>清除</Button>}
            </Space.Compact>
          </Form.Item>
          <Form.Item label=" ">
            <Button onClick={testAI} loading={testing}>测试连接</Button>
          </Form.Item>

          <Typography.Title level={5} style={{ marginTop: 8 }}>运行</Typography.Title>
          <Form.Item name="concurrency" label="同时运行任务数" extra="所有平台合计。每个任务是一个独立进程；同一平台多账号同时运行可能触发风控"><InputNumber min={1} max={50} /></Form.Item>
          <Form.Item label="单平台上限" extra="0 表示只受上面的总数限制。智慧树每个任务会开一个真实 Chrome（约 300~500MB 内存），建议按服务器内存设置">
            <Flex wrap gap={12}>
              {PLATFORMS.filter((p) => !p.hidden && p.id !== "diagnostic").map((p) => (
                <Form.Item key={p.id} name={["platformLimits", p.id]} noStyle>
                  <InputNumber min={0} max={50} addonBefore={p.short} style={{ width: 150 }} />
                </Form.Item>
              ))}
            </Flex>
          </Form.Item>
          {!SERVER && <Form.Item name="browserPath" label="浏览器路径" extra="安全微伴的课程验证码需要 Chrome / Edge。留空则自动检测。"><Input placeholder="自动检测" /></Form.Item>}
          <Form.Item name="debug" label="调试模式" valuePropName="checked" extra="输出更详细的日志（包括网络请求），排查问题时开启"><Switch /></Form.Item>
          <Form.Item label=" ">
            <Button type="primary" onClick={save} loading={saving}>保存设置</Button>
          </Form.Item>
        </Form>
      </Card>

      <Card title="运行环境" extra={<Button onClick={checkEnv} loading={checking}>检测环境</Button>}>
        <Descriptions size="small" column={1} items={[
          { label: "版本", children: info?.version },
          { label: "数据目录", children: <Flex gap={8} align="center"><Text code copyable>{info?.dataDir}</Text>{!SERVER && <Button size="small" icon={<FolderOpenOutlined />} onClick={() => AppAPI.OpenDataDir()}>打开</Button>}</Flex> },
          { label: "Python", children: info?.envError ? <Text type="danger">{info.envError}</Text> : <Text code>{info?.python}</Text> },
          { label: "智慧树引擎", children: info?.nodeError ? <Text type="warning">{info.nodeError}</Text> : <Text code>{info?.node}</Text> },
          { label: "凭证加密", children: info?.keyBackend === "keychain" ? "系统钥匙串" : info?.keyBackend === "env" ? "环境变量 SHUAKE_MASTER_KEY" : "本地密钥文件" },
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
              <GithubOutlined /> <Link onClick={() => openURL(u.url)}>{u.name}</Link> <Tag>{u.license}</Tag><Text type="secondary">{u.note}</Text>
            </Text>
          ))}
        </Flex>
        <Alert style={{ marginTop: 16 }} type="warning" showIcon message="使用须知" description="自动化学习与答题可能违反相关平台的用户协议，存在账号被限制的风险。请仅用于学习研究，并自行承担使用后果。" />
      </Card>
    </Flex>
  );
}
