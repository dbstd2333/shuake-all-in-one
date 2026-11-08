// SPDX-License-Identifier: AGPL-3.0-or-later
import { DeleteOutlined, LoginOutlined, PlayCircleOutlined, PlusOutlined, EditOutlined } from "@ant-design/icons";
import { App as AntApp, Button, Card, Empty, Flex, Form, Input, Modal, Popconfirm, Segmented, Select, Space, Table, Tabs, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import { AccountAPI, AppAPI, errText, type Account } from "../api";
import { AccountStatus, PlatformTag, formatTime } from "../components/common";
import { PLATFORMS, platformById, type PlatformMeta } from "../platforms";
import { useApp } from "../stores/app";
import { useJobLogs } from "../components/JobLogs";

const { Text } = Typography;

interface Tenant {
  code: string;
  name: string;
  letter?: string;
}

let tenantCache: Tenant[] | null = null;

export function useLogin() {
  const { message, notification } = AntApp.useApp();
  const showLogs = useJobLogs((s) => s.show);
  const [busy, setBusy] = useState<string | null>(null);
  const login = async (acc: Account): Promise<boolean> => {
    setBusy(acc.id);
    try {
      const res = await AccountAPI.Login(acc.id);
      if (res && res.code === 0) {
        const name = res.data?.user?.name;
        message.success(name ? `登录成功：${name}` : "登录成功");
        return true;
      }
      if (res && res.code !== 3) {
        const key = `login-${res.jobId}`;
        notification.error({
          key,
          message: "登录失败",
          description: res.error || "未知错误",
          duration: 0,
          btn: <Button size="small" onClick={() => { notification.destroy(key); showLogs(res.jobId, "登录日志"); }}>查看日志</Button>,
        });
      }
      return false;
    } catch (e) {
      message.error(errText(e));
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { login, busy };
}

function AccountForm({ platform, editing }: { platform: PlatformMeta; editing?: Account }) {
  const [tenants, setTenants] = useState<Tenant[]>(tenantCache ?? []);
  const [loading, setLoading] = useState(false);
  const mode = Form.useWatch("mode");
  const { message } = AntApp.useApp();

  useEffect(() => {
    if (platform.id !== "weban" || tenantCache) return;
    setLoading(true);
    AppAPI.ListTenants()
      .then((res) => {
        if (res?.code === 0) {
          tenantCache = (res.data?.tenants ?? []) as Tenant[];
          setTenants(tenantCache);
        } else {
          message.error(`获取学校列表失败：${res?.error ?? ""}`);
        }
      })
      .catch((e) => message.error(errText(e)))
      .finally(() => setLoading(false));
  }, [platform.id, message]);

  return (
    <>
      <Form.Item name="name" label="备注名" tooltip="可选，便于区分多个账号">
        <Input placeholder={platform.login === "password" ? "默认使用姓名" : "默认使用平台昵称"} />
      </Form.Item>
      {platform.id === "weban" && (
        <>
          <Form.Item name="mode" label="登录方式" initialValue="browser">
            <Segmented options={[{ label: "浏览器登录（推荐）", value: "browser" }, { label: "学号密码", value: "password" }, { label: "手动填 Token", value: "token" }]} />
          </Form.Item>
          {mode === "browser" && (
            <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
              点击“添加并登录”后会打开一个浏览器窗口进入安全微伴官网，按平时的方式登录（支持扫码），登录成功后程序会自动读取 Token 和学校信息，无需手动复制。
            </Typography.Paragraph>
          )}
          <Form.Item name="tenant_name" label="学校" rules={[{ required: mode !== "browser", message: "请选择学校" }]} hidden={mode === "browser"}>
            <Select
              showSearch
              loading={loading}
              placeholder="输入学校名称搜索"
              options={tenants.map((t) => ({ value: t.name, label: t.name }))}
              filterOption={(input, opt) => String(opt?.label ?? "").includes(input.trim())}
              virtual
            />
          </Form.Item>
          {mode === "browser" ? null : mode !== "token" ? (
            <>
              <Form.Item name="username" label="学号 / 账号" rules={[{ required: true, message: "请输入账号" }]}>
                <Input autoComplete="off" />
              </Form.Item>
              <Form.Item name="password" label="密码" tooltip="留空则使用学号作为密码" extra={editing ? "留空表示不修改" : undefined}>
                <Input.Password autoComplete="new-password" />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item name="user_id" label="userId" rules={[{ required: !editing, message: "请输入 userId" }]}>
                <Input autoComplete="off" />
              </Form.Item>
              <Form.Item name="token" label="token" rules={[{ required: !editing, message: "请输入 token" }]} extra="在官网登录后，从浏览器开发者工具 → Local Storage → user 中获取">
                <Input.Password autoComplete="off" />
              </Form.Item>
            </>
          )}
        </>
      )}
      {platform.id === "diagnostic" && (
        <Form.Item name="username" label="用户名">
          <Input />
        </Form.Item>
      )}
      {!(platform.id === "weban" && mode === "browser") && <Text type="secondary">{platform.loginHint}</Text>}
    </>
  );
}

function AccountModal({ open, onClose, platformId, editing }: { open: boolean; onClose: () => void; platformId: string; editing?: Account }) {
  const [form] = Form.useForm();
  const { message } = AntApp.useApp();
  const { login } = useLogin();
  const [saving, setSaving] = useState(false);
  const [pid, setPid] = useState(platformId);
  const platform = platformById(editing?.platform ?? pid);

  useEffect(() => {
    if (!open) return;
    setPid(platformId);
    form.resetFields();
    if (editing) {
      form.setFieldsValue({ name: editing.name, ...editing.fields, mode: editing.fields?.login_mode === "browser" ? "browser" : editing.fields?.username ? "password" : "token" });
    }
  }, [open, editing, platformId, form]);

  const submit = async () => {
    const v = await form.validateFields();
    const fields: Record<string, unknown> = {};
    const secret: Record<string, unknown> = {};
    if (platform.id === "weban") {
      fields.tenant_name = v.tenant_name ?? "";
      if (v.mode === "browser") {
        fields.login_mode = "browser";
      } else if (v.mode === "token") {
        fields.user_id = v.user_id;
        secret.user_id = v.user_id;
        secret.token = v.token;
      } else {
        fields.username = String(v.username).trim();
        secret.password = v.password || "";
      }
    } else if (platform.id === "diagnostic") {
      fields.username = v.username;
    }
    setSaving(true);
    try {
      if (editing) {
        await AccountAPI.Update(editing.id, v.name ?? "", fields, secret);
        message.success("已保存");
        onClose();
        return;
      }
      const acc = await AccountAPI.Create(platform.id, v.name ?? "", fields, secret);
      onClose();
      if (acc) {
        const ok = await login(acc);
        if (!ok) message.info("账号已保存，可稍后在账号列表中点击“登录”重试");
      }
    } catch (e) {
      message.error(errText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onCancel={onClose} onOk={submit} confirmLoading={saving} title={editing ? "编辑账号" : "添加账号"} okText={editing ? "保存" : "添加并登录"} destroyOnHidden>
      {!editing && (
        <Flex vertical gap={6} style={{ marginBottom: 16 }}>
          <Text type="secondary">平台</Text>
          <Segmented block value={pid} onChange={(v) => setPid(v as string)} options={PLATFORMS.filter((p) => !p.hidden || p.id === platformId).map((p) => ({ label: p.short, value: p.id }))} />
        </Flex>
      )}
      <Form form={form} layout="vertical" preserve={false} key={platform.id}>
        <AccountForm platform={platform} editing={editing} />
      </Form>
    </Modal>
  );
}

export default function AccountsPage({ onStartTask }: { onStartTask: (accountId: string) => void }) {
  const accounts = useApp((s) => s.accounts);
  const loadAccounts = useApp((s) => s.loadAccounts);
  const [tab, setTab] = useState<string>("all");
  const [modal, setModal] = useState<{ open: boolean; editing?: Account }>({ open: false });
  const { message } = AntApp.useApp();
  const { login, busy } = useLogin();

  const shown = useMemo(() => (tab === "all" ? accounts : accounts.filter((a) => a.platform === tab)), [accounts, tab]);

  const remove = async (a: Account) => {
    try {
      await AccountAPI.Delete(a.id);
      await loadAccounts();
      message.success("已删除");
    } catch (e) {
      message.error(errText(e));
    }
  };

  const tabs = [{ key: "all", label: `全部 (${accounts.length})` }, ...PLATFORMS.filter((p) => !p.hidden || accounts.some((a) => a.platform === p.id)).map((p) => ({ key: p.id, label: `${p.name} (${accounts.filter((a) => a.platform === p.id).length})` }))];

  return (
    <Card
      title="账号管理"
      extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => setModal({ open: true })}>添加账号</Button>}
    >
      <Tabs activeKey={tab} onChange={setTab} items={tabs} />
      {shown.length === 0 ? (
        <Empty description="还没有账号，先添加一个吧">
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setModal({ open: true })}>添加账号</Button>
        </Empty>
      ) : (
        <Table<Account>
          rowKey="id"
          dataSource={shown}
          pagination={false}
          columns={[
            { title: "平台", dataIndex: "platform", width: 100, render: (p: string) => <PlatformTag id={p} /> },
            {
              title: "账号",
              render: (_, a) => (
                <Flex vertical>
                  <Text strong>{a.name || (a.user?.name as string) || (a.fields?.username as string) || "未命名"}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {[a.fields?.tenant_name, a.fields?.username].filter(Boolean).join(" · ") || (a.user?.id ? `ID ${a.user.id}` : "")}
                  </Text>
                </Flex>
              ),
            },
            { title: "状态", dataIndex: "status", width: 120, render: (s: string) => <AccountStatus status={s} /> },
            { title: "更新时间", dataIndex: "updatedAt", width: 180, render: (t: number) => <Text type="secondary">{formatTime(t)}</Text> },
            {
              title: "操作",
              width: 300,
              render: (_, a) => (
                <Space>
                  <Button size="small" icon={<PlayCircleOutlined />} type="primary" ghost onClick={() => onStartTask(a.id)}>新建任务</Button>
                  <Button size="small" icon={<LoginOutlined />} loading={busy === a.id} onClick={() => login(a)}>
                    {a.status === "ok" ? "重新登录" : "登录"}
                  </Button>
                  <Button size="small" icon={<EditOutlined />} onClick={() => setModal({ open: true, editing: a })} />
                  <Popconfirm title="删除这个账号？" description="会同时删除保存的登录信息和任务记录" onConfirm={() => remove(a)} okButtonProps={{ danger: true }}>
                    <Button size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      )}
      <AccountModal open={modal.open} editing={modal.editing} platformId={tab === "all" ? "xuetangx" : tab} onClose={() => setModal({ open: false })} />
    </Card>
  );
}
