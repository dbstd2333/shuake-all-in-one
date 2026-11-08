// SPDX-License-Identifier: AGPL-3.0-or-later
import { DashboardOutlined, HistoryOutlined, PlusCircleOutlined, SettingOutlined, TeamOutlined } from "@ant-design/icons";
import { Badge, Layout, Menu, Typography } from "antd";
import { useEffect, useState } from "react";
import InteractionCenter from "./components/InteractionCenter";
import JobLogsModal from "./components/JobLogs";
import AccountsPage from "./pages/Accounts";
import Dashboard from "./pages/Dashboard";
import NewTaskPage from "./pages/NewTask";
import SettingsPage from "./pages/Settings";
import TasksPage, { TaskDetail } from "./pages/Tasks";
import { isActive, useApp } from "./stores/app";

type Page = "dashboard" | "accounts" | "new" | "tasks" | "settings";

export default function App() {
  const init = useApp((s) => s.init);
  const runningCount = useApp((s) => s.tasks.filter(isActive).length);
  const [page, setPage] = useState<Page>("dashboard");
  const [taskAccount, setTaskAccount] = useState<string>();
  const [openTask, setOpenTask] = useState<string>();

  useEffect(() => init(), [init]);

  const content = {
    dashboard: <Dashboard openTask={setOpenTask} goAccounts={() => setPage("accounts")} goNewTask={() => setPage("new")} />,
    accounts: <AccountsPage onStartTask={(id) => { setTaskAccount(id); setPage("new"); }} />,
    new: <NewTaskPage accountId={taskAccount} onStarted={(id) => { setPage("dashboard"); setOpenTask(id); }} />,
    tasks: <TasksPage openTask={setOpenTask} />,
    settings: <SettingsPage />,
  }[page];

  return (
    <Layout style={{ height: "100vh" }}>
      <Layout.Sider width={208} theme="light" className="app-sider">
        <div className="app-brand">
          <div className="app-logo">刷</div>
          <div>
            <Typography.Text strong>刷课 All-in-One</Typography.Text>
            <div className="app-sub">学堂在线 · 职教 · 微伴</div>
          </div>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[page]}
          onClick={(e) => setPage(e.key as Page)}
          items={[
            { key: "dashboard", icon: <DashboardOutlined />, label: <span>总览 <Badge count={runningCount} size="small" offset={[6, -2]} /></span> },
            { key: "new", icon: <PlusCircleOutlined />, label: "新建任务" },
            { key: "accounts", icon: <TeamOutlined />, label: "账号" },
            { key: "tasks", icon: <HistoryOutlined />, label: "任务记录" },
            { key: "settings", icon: <SettingOutlined />, label: "设置" },
          ]}
        />
      </Layout.Sider>
      <Layout.Content className="app-content">{content}</Layout.Content>
      <TaskDetail taskId={openTask} onClose={() => setOpenTask(undefined)} />
      <InteractionCenter />
      <JobLogsModal />
    </Layout>
  );
}
