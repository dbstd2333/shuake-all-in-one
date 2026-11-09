// SPDX-License-Identifier: AGPL-3.0-or-later
import { ArrowDownOutlined, ArrowUpOutlined, DashboardOutlined, HistoryOutlined, LineChartOutlined, LogoutOutlined, PlusCircleOutlined, SettingOutlined, TeamOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { App as AntApp, Alert, Badge, Button, Layout, Menu, Typography } from "antd";
import { useEffect, useState } from "react";
import { SERVER, onEvent, openURL } from "./api";
import { logout } from "./components/AuthGate";
import InteractionCenter from "./components/InteractionCenter";
import JobLogsModal from "./components/JobLogs";
import AccountsPage from "./pages/Accounts";
import BatchPage from "./pages/Batch";
import Dashboard from "./pages/Dashboard";
import NewTaskPage from "./pages/NewTask";
import SettingsPage from "./pages/Settings";
import TasksPage, { TaskDetail } from "./pages/Tasks";
import TrafficPage from "./pages/Traffic";
import { isActive, useApp } from "./stores/app";
import { formatRate, useTraffic } from "./stores/traffic";

type Page = "dashboard" | "accounts" | "new" | "batch" | "tasks" | "traffic" | "settings";

function NetMeter({ onClick }: { onClick: () => void }) {
  const latest = useTraffic((s) => s.latest);
  return (
    <div className="net-meter" onClick={onClick} title="查看流量统计">
      <span><ArrowDownOutlined /> {formatRate(latest?.rxRate)}</span>
      <span><ArrowUpOutlined /> {formatRate(latest?.txRate)}</span>
    </div>
  );
}

export default function App() {
  const init = useApp((s) => s.init);
  const runningCount = useApp((s) => s.tasks.filter(isActive).length);
  const [page, setPage] = useState<Page>("dashboard");
  const [taskAccount, setTaskAccount] = useState<string>();
  const [openTask, setOpenTask] = useState<string>();
  const [batchAccounts, setBatchAccounts] = useState<string[]>();
  const connected = useApp((s) => s.connected);
  const { notification } = AntApp.useApp();

  useEffect(() => init(), [init]);
  const initTraffic = useTraffic((s) => s.init);
  useEffect(() => initTraffic(), [initTraffic]);

  // Server build: the engine wants a page opened, but only the browser can.
  useEffect(
    () =>
      onEvent("app:open_url", (d: { url: string }) => {
        const key = `open-${d.url}`;
        notification.info({
          key,
          message: "需要在浏览器中打开页面",
          description: <Typography.Text ellipsis style={{ maxWidth: 300 }}>{d.url}</Typography.Text>,
          duration: 0,
          btn: <Button type="primary" size="small" onClick={() => { openURL(d.url); notification.destroy(key); }}>打开</Button>,
        });
      }),
    [notification],
  );

  const content = {
    dashboard: <Dashboard openTask={setOpenTask} goAccounts={() => setPage("accounts")} goNewTask={() => setPage("new")} />,
    accounts: <AccountsPage onStartTask={(id) => { setTaskAccount(id); setPage("new"); }} onBatch={(ids) => { setBatchAccounts(ids); setPage("batch"); }} />,
    batch: <BatchPage accountIds={batchAccounts} openTask={setOpenTask} />,
    new: <NewTaskPage accountId={taskAccount} onStarted={(id) => { setPage("dashboard"); setOpenTask(id); }} />,
    tasks: <TasksPage openTask={setOpenTask} />,
    traffic: <TrafficPage openTask={setOpenTask} />,
    settings: <SettingsPage />,
  }[page];

  return (
    <Layout style={{ height: "100vh" }}>
      <Layout.Sider width={208} theme="light" className="app-sider">
        <div className="app-brand">
          <div className="app-logo">刷</div>
          <div>
            <Typography.Text strong>刷课 All-in-One</Typography.Text>
            <div className="app-sub">学堂 · 职教 · 微伴 · 智慧树</div>
          </div>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[page]}
          onClick={(e) => setPage(e.key as Page)}
          items={[
            { key: "dashboard", icon: <DashboardOutlined />, label: <span>总览 <Badge count={runningCount} size="small" offset={[6, -2]} /></span> },
            { key: "new", icon: <PlusCircleOutlined />, label: "新建任务" },
            { key: "batch", icon: <ThunderboltOutlined />, label: "批量任务" },
            { key: "accounts", icon: <TeamOutlined />, label: "账号" },
            { key: "tasks", icon: <HistoryOutlined />, label: "任务记录" },
            { key: "traffic", icon: <LineChartOutlined />, label: "流量" },
            { key: "settings", icon: <SettingOutlined />, label: "设置" },
          ]}
        />
        <div className="sider-bottom">
          <NetMeter onClick={() => setPage("traffic")} />
          {SERVER && (
            <div className="sider-footer">
              <Button type="text" block icon={<LogoutOutlined />} onClick={() => logout()} style={{ textAlign: "left" }}>退出登录</Button>
            </div>
          )}
        </div>
      </Layout.Sider>
      <Layout.Content className="app-content">
        {SERVER && !connected && <Alert className="conn-lost" type="warning" showIcon banner message="与服务器的实时连接已断开，正在重连…（进度暂停刷新，任务仍在服务器上运行）" />}
        {content}
      </Layout.Content>
      <TaskDetail taskId={openTask} onClose={() => setOpenTask(undefined)} />
      <InteractionCenter />
      <JobLogsModal />
    </Layout>
  );
}
