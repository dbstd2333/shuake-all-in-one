// SPDX-License-Identifier: AGPL-3.0-or-later
import { App as AntApp, Alert, Button, Checkbox, Flex, Image, Input, Modal, QRCode, Radio, Space, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import { TaskAPI, errText, openURL } from "../api";
import { platformById } from "../platforms";
import { useApp, type EngineRequest } from "../stores/app";

const { Text, Paragraph } = Typography;

/**
 * Shows whatever the engine is asking the user for: captcha, QR code, manual
 * answers, notices. Requests from every job are queued; the oldest is shown.
 */
export default function InteractionCenter() {
  const requests = useApp((s) => s.requests);
  const req = requests[0];
  if (!req) return null;
  return <RequestModal key={`${req.jobId}/${req.id}`} req={req} queued={requests.length - 1} />;
}

function RequestModal({ req, queued }: { req: EngineRequest; queued: number }) {
  const { message } = AntApp.useApp();
  const remove = useApp((s) => s.removeRequest);
  const accounts = useApp((s) => s.accounts);
  const [text, setText] = useState<string>(req.payload.default ?? "");
  const [picks, setPicks] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const p = req.payload;
  const platform = platformById(req.platform);
  const account = accounts.find((a) => a.id === req.accountId);

  useEffect(() => setText(req.payload.default ?? ""), [req]);

  const reply = async (value: unknown) => {
    if (!req.blocking) {
      remove(req.id, req.jobId);
      return;
    }
    setBusy(true);
    try {
      await TaskAPI.Reply(req.jobId, req.id, value);
      remove(req.id, req.jobId);
    } catch (e) {
      message.error(errText(e));
      remove(req.id, req.jobId);
    } finally {
      setBusy(false);
    }
  };

  const abort = async () => {
    if (req.taskId) await TaskAPI.Cancel(req.taskId);
    else await TaskAPI.CancelJob(req.jobId);
    remove(req.id, req.jobId);
  };

  const subtitle = useMemo(() => {
    const who = account?.name || (account?.fields?.username as string) || "";
    return [platform.name, who].filter(Boolean).join(" · ");
  }, [platform, account]);

  let title: string = p.title || "需要你的操作";
  let body: React.ReactNode = null;
  let okDisabled = false;
  let onOk: (() => void) | undefined;
  let okText = "确定";
  let showCancelTask = true;

  switch (req.kind) {
    case "captcha_image":
      title = p.title || "请输入验证码";
      onOk = () => reply(text.trim());
      okDisabled = !text.trim();
      body = (
        <Flex vertical gap={12} align="center">
          {p.hint && <Text type="secondary">{p.hint}</Text>}
          <Image src={p.image} alt="验证码" preview={false} style={{ minWidth: 160, imageRendering: "pixelated", border: "1px solid var(--ant-color-border)", borderRadius: 6 }} />
          <Input autoFocus size="large" value={text} onChange={(e) => setText(e.target.value)} onPressEnter={() => text.trim() && onOk?.()} placeholder="验证码" style={{ width: 220, textAlign: "center", letterSpacing: 4 }} />
        </Flex>
      );
      break;
    case "text":
      title = p.title || "请输入";
      onOk = () => reply(text);
      body = (
        <Flex vertical gap={8}>
          <Paragraph style={{ whiteSpace: "pre-wrap", marginBottom: 4 }}>{p.prompt}</Paragraph>
          {p.url && (
            <Button type="primary" ghost onClick={() => openURL(p.url)} style={{ alignSelf: "flex-start" }}>
              打开登录页面
            </Button>
          )}
          {p.multiline ? (
            <Input.TextArea autoFocus rows={4} value={text} onChange={(e) => setText(e.target.value)} />
          ) : (
            <Input autoFocus value={text} placeholder={p.placeholder} onChange={(e) => setText(e.target.value)} onPressEnter={() => onOk?.()} />
          )}
        </Flex>
      );
      break;
    case "choice": {
      const opts: string[] = p.options ?? [];
      title = p.title || "请选择答案";
      onOk = () => reply(picks);
      okDisabled = picks.length === 0;
      body = (
        <Flex vertical gap={12}>
          {p.kind && <Text type="secondary">{p.kind}</Text>}
          <Paragraph strong style={{ fontSize: 15, marginBottom: 0 }}>{p.question}</Paragraph>
          {p.multiple ? (
            <Checkbox.Group value={picks} onChange={(v) => setPicks(v as number[])}>
              <Space direction="vertical">
                {opts.map((o, i) => <Checkbox key={i} value={i}>{String.fromCharCode(65 + i)}. {o}</Checkbox>)}
              </Space>
            </Checkbox.Group>
          ) : (
            <Radio.Group value={picks[0]} onChange={(e) => setPicks([e.target.value])}>
              <Space direction="vertical">
                {opts.map((o, i) => <Radio key={i} value={i}>{String.fromCharCode(65 + i)}. {o}</Radio>)}
              </Space>
            </Radio.Group>
          )}
        </Flex>
      );
      break;
    }
    case "confirm":
      title = p.title || "请确认";
      onOk = () => reply(true);
      body = <Paragraph style={{ whiteSpace: "pre-wrap" }}>{p.message}</Paragraph>;
      break;
    case "qrcode":
      title = p.title || "扫码登录";
      onOk = undefined;
      body = (
        <Flex vertical gap={12} align="center">
          {p.image ? (
            <Image src={p.image} alt="二维码" preview={false} width={220} />
          ) : p.url ? (
            <QRCode value={p.url} size={220} />
          ) : null}
          <Text type="secondary">{p.hint || "请使用微信扫描二维码，完成后会自动继续"}</Text>
          {p.expires_in ? <Text type="secondary">二维码 {p.expires_in} 秒内有效，过期会自动刷新</Text> : null}
        </Flex>
      );
      break;
    case "notice":
    case "image":
    default:
      title = p.title || "提示";
      okText = "知道了";
      onOk = () => reply(req.blocking ? true : null);
      body = (
        <Flex vertical gap={12}>
          {p.message && <Paragraph style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>{p.message}</Paragraph>}
          {p.image && <Image src={p.image} alt="" preview={false} />}
          {p.url && (
            <Button type="link" style={{ padding: 0 }} onClick={() => openURL(p.url)}>
              没有自动打开？点此在浏览器中打开
            </Button>
          )}
        </Flex>
      );
  }

  return (
    <Modal
      open
      centered
      maskClosable={false}
      keyboard={false}
      closable={false}
      width={req.kind === "choice" ? 560 : 420}
      title={
        <Flex vertical gap={2}>
          <span>{title}</span>
          <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>{subtitle}</Text>
        </Flex>
      }
      footer={
        <Flex justify="space-between" align="center">
          <span>
            {showCancelTask && (
              <Button danger type="text" onClick={abort}>
                {req.taskId ? "停止任务" : "取消"}
              </Button>
            )}
          </span>
          <Space>
            {queued > 0 && <Text type="secondary">还有 {queued} 个待处理</Text>}
            {onOk && <Button type="primary" loading={busy} disabled={okDisabled} onClick={onOk}>{okText}</Button>}
          </Space>
        </Flex>
      }
    >
      {req.kind === "qrcode" || req.kind === "notice" ? null : !req.blocking && <Alert type="info" showIcon message="任务正在后台继续" style={{ marginBottom: 12 }} />}
      {body}
    </Modal>
  );
}
