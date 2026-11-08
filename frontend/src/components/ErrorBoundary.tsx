// SPDX-License-Identifier: AGPL-3.0-or-later
import { Button, Result, Typography } from "antd";
import { Component, type ReactNode } from "react";

/** Shows frontend crashes instead of a blank window, with the stack for debugging. */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error; info?: string }> {
  state: { error?: Error; info?: string } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    this.setState({ info: info.componentStack ?? "" });
    console.error(error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const text = `${this.state.error.name}: ${this.state.error.message}\n\n${this.state.error.stack ?? ""}\n${this.state.info ?? ""}`;
    return (
      <Result
        status="error"
        title="界面出错了"
        subTitle="后台任务不受影响，仍在继续运行。可以复制下面的错误信息反馈问题。"
        extra={[
          <Button key="reload" type="primary" onClick={() => location.reload()}>重新加载界面</Button>,
          <Button key="back" onClick={() => this.setState({ error: undefined, info: undefined })}>尝试返回</Button>,
        ]}
      >
        <Typography.Paragraph copyable={{ text }}>
          <pre style={{ maxHeight: 360, overflow: "auto", fontSize: 12, whiteSpace: "pre-wrap", userSelect: "text" }}>{text}</pre>
        </Typography.Paragraph>
      </Result>
    );
  }
}
