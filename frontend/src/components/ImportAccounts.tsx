// SPDX-License-Identifier: AGPL-3.0-or-later
import { App as AntApp, Alert, Checkbox, Flex, Input, Modal, Segmented, Table, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import { AccountAPI, AppAPI, errText, type ImportRow } from "../api";
import { PLATFORMS, platformById } from "../platforms";

const { Text, Paragraph } = Typography;

interface Parsed {
  line: number;
  row?: ImportRow;
  label: string;
  error?: string;
}

const FORMATS: Record<string, { help: string; example: string }> = {
  weban: {
    help: "每行一个：学校名称,学号,密码[,备注名]。密码留空则使用学号。学校名称需与官网一致。",
    example: "某某大学,20240001,mypassword\n某某大学,20240002,,张三",
  },
  zhihuishu: {
    help: "每行一个：备注名[,Cookie]。Cookie 可省略，导入后用「批量登录」逐个扫码即可。",
    example: "张三\n李四,CASTGC=...; CASLOGC=...",
  },
  default: {
    help: "每行一个备注名。该平台需要扫码或网页登录，导入后用「批量登录」依次完成。",
    example: "张三\n李四\n王五",
  },
};

const split = (line: string) => line.split(/[,，\t]/).map((s) => s.trim());

function parse(platform: string, text: string, tenants: Set<string> | null): Parsed[] {
  const out: Parsed[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const n = i + 1;
    if (platform === "weban") {
      const [tenant, username, password = "", name = ""] = split(line);
      if (!tenant || !username) {
        out.push({ line: n, label: line, error: "格式应为：学校,学号,密码[,备注名]" });
        return;
      }
      const err = tenants && tenants.size > 0 && !tenants.has(tenant) ? "学校名称不在安全微伴的学校列表中" : undefined;
      out.push({ line: n, label: `${tenant} · ${username}${name ? ` (${name})` : ""}`, error: err,
        row: { name, fields: { tenant_name: tenant, username }, secret: { password } } });
    } else if (platform === "zhihuishu") {
      const idx = line.search(/[,，\t]/);
      const name = (idx < 0 ? line : line.slice(0, idx)).trim();
      const cookie = idx < 0 ? "" : line.slice(idx + 1).trim();
      out.push({ line: n, label: name + (cookie ? "（含 Cookie）" : ""),
        row: { name, fields: { course_urls: "" }, secret: cookie ? { cookies: cookie } : {} } });
    } else {
      const name = split(line)[0];
      out.push({ line: n, label: name, row: { name, fields: platform === "diagnostic" ? { username: name } : {}, secret: {} } });
    }
  });
  return out;
}

export default function ImportAccountsModal({ open, onClose, defaultPlatform, onImported }: {
  open: boolean;
  onClose: () => void;
  defaultPlatform: string;
  onImported: (ids: string[], loginNow: boolean) => void;
}) {
  const { message } = AntApp.useApp();
  const [platform, setPlatform] = useState(defaultPlatform);
  const [text, setText] = useState("");
  const [loginNow, setLoginNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tenants, setTenants] = useState<Set<string> | null>(null);

  useEffect(() => {
    if (open) {
      setPlatform(defaultPlatform);
      setText("");
    }
  }, [open, defaultPlatform]);

  useEffect(() => {
    if (!open || platform !== "weban" || tenants) return;
    AppAPI.ListTenants()
      .then((res) => {
        if (res?.code === 0) setTenants(new Set(((res.data?.tenants ?? []) as { name: string }[]).map((t) => t.name)));
      })
      .catch(() => {});
  }, [open, platform, tenants]);

  const fmt = FORMATS[platform] ?? FORMATS.default;
  const rows = useMemo(() => parse(platform, text, tenants), [platform, text, tenants]);
  const valid = rows.filter((r) => r.row && !r.error);

  const submit = async () => {
    if (valid.length === 0) return;
    setBusy(true);
    try {
      const res = await AccountAPI.Import(platform, valid.map((r) => r.row!));
      const parts = [`已导入 ${res?.created ?? 0} 个账号`];
      if (res?.skipped) parts.push(`跳过 ${res.skipped} 个重复账号`);
      if (res?.errors?.length) parts.push(`${res.errors.length} 个失败`);
      message.success(parts.join("，"));
      onImported(res?.ids ?? [], loginNow);
      onClose();
    } catch (e) {
      message.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onCancel={onClose} onOk={submit} title="批量导入账号" okText={`导入 ${valid.length} 个`} okButtonProps={{ disabled: valid.length === 0 }} confirmLoading={busy} width={680} destroyOnHidden>
      <Flex vertical gap={12}>
        <Segmented block value={platform} onChange={(v) => setPlatform(v as string)}
          options={PLATFORMS.filter((p) => !p.hidden).map((p) => ({ label: p.short, value: p.id }))} />
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>{fmt.help}</Paragraph>
        <Input.TextArea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={fmt.example}
          style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }} />
        {rows.length > 0 && (
          <Table<Parsed>
            size="small"
            rowKey="line"
            dataSource={rows}
            pagination={rows.length > 8 ? { pageSize: 8, size: "small" } : false}
            columns={[
              { title: "行", dataIndex: "line", width: 56 },
              { title: platformById(platform).name, dataIndex: "label", ellipsis: true },
              { title: "检查", width: 220, render: (_, r) => (r.error ? <Text type="danger">{r.error}</Text> : <Text type="success">可导入</Text>) },
            ]}
          />
        )}
        {rows.some((r) => r.error) && <Alert type="warning" showIcon message="有错误的行不会被导入" />}
        <Checkbox checked={loginNow} onChange={(e) => setLoginNow(e.target.checked)}>
          导入后立即批量登录（需要扫码或输入验证码时会依次弹出）
        </Checkbox>
      </Flex>
    </Modal>
  );
}
