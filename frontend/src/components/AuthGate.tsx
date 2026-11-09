// SPDX-License-Identifier: AGPL-3.0-or-later
import { LockOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Flex, Form, Input, Spin, Typography } from "antd";
import { useEffect, useState, type ReactNode } from "react";
import { SERVER, closeEvents, errText, httpJSON, setUnauthorizedHandler } from "../api";

interface Session {
  authed: boolean;
  authRequired: boolean;
  version: string;
}

/** Signs the user out of the web build and returns to the password page. */
export async function logout() {
  try {
    await httpJSON("/api/logout", {});
  } finally {
    closeEvents();
    window.location.reload();
  }
}

/** Server build only: asks for the admin password before showing the app. */
export default function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"loading" | "login" | "ok">(SERVER ? "loading" : "ok");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!SERVER) return;
    setUnauthorizedHandler(() => {
      closeEvents();
      setState("login");
    });
    httpJSON<Session>("/api/session")
      .then((s) => setState(s.authed ? "ok" : "login"))
      .catch((e) => {
        setError(errText(e));
        setState("login");
      });
  }, []);

  if (state === "ok") return <>{children}</>;
  if (state === "loading") {
    return (
      <Flex style={{ height: "100vh" }} align="center" justify="center">
        <Spin size="large" />
      </Flex>
    );
  }

  const submit = async (v: { password: string }) => {
    setBusy(true);
    setError(undefined);
    try {
      await httpJSON("/api/login", { password: v.password });
      setState("ok");
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Flex className="auth-page" align="center" justify="center">
      <Card style={{ width: 360, maxWidth: "calc(100vw - 32px)" }}>
        <Flex vertical align="center" gap={4} style={{ marginBottom: 24 }}>
          <div className="app-logo" style={{ width: 44, height: 44, fontSize: 22 }}>刷</div>
          <Typography.Title level={4} style={{ margin: "8px 0 0" }}>刷课 All-in-One</Typography.Title>
          <Typography.Text type="secondary">请输入管理员密码</Typography.Text>
        </Flex>
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
        <Form onFinish={submit} layout="vertical">
          <Form.Item name="password" rules={[{ required: true, message: "请输入密码" }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码" size="large" autoFocus autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block size="large" loading={busy}>
            登录
          </Button>
        </Form>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 16, marginBottom: 0 }}>
          密码由环境变量 SHUAKE_ADMIN_PASSWORD 设置；未设置时首次启动会自动生成，并打印在容器日志中。
        </Typography.Paragraph>
      </Card>
    </Flex>
  );
}
