// SPDX-License-Identifier: AGPL-3.0-or-later
import { SERVER } from "./api";

export type LoginKind = "qrcode" | "sso" | "password" | "diagnostic";

export type OptionField =
  | { key: string; label: string; type: "switch"; default: boolean; help?: string }
  | { key: string; label: string; type: "number"; default: number; min?: number; max?: number; help?: string; suffix?: string }
  | { key: string; label: string; type: "text"; default: string; help?: string; placeholder?: string }
  | { key: string; label: string; type: "tags"; default: string[]; help?: string }
  | { key: string; label: string; type: "select"; default: string; options: { value: string; label: string }[]; help?: string };

export interface PlatformMeta {
  id: string;
  name: string;
  short: string;
  color: string;
  login: LoginKind;
  loginHint: string;
  courseNoun: string;
  usesAI: boolean;
  options: OptionField[];
  hidden?: boolean;
}

const ICVE_HINT = SERVER
  ? "会给出智慧职教统一登录链接：在新标签页登录后，把跳转后的地址粘贴回来"
  : "将在系统浏览器中打开智慧职教统一登录页面，登录完成后自动返回";

export const PLATFORMS: PlatformMeta[] = [
  {
    id: "xuetangx",
    name: "学堂在线",
    short: "学堂",
    color: "#1f6feb",
    login: "qrcode",
    loginHint: "使用微信扫描二维码登录学堂在线",
    courseNoun: "课程",
    usesAI: true,
    options: [
      { key: "skip_audio", label: "跳过音频", type: "switch", default: false },
      { key: "do_exercise", label: "完成习题", type: "switch", default: true, help: "已配置 AI 时由 AI 作答，否则随机选择" },
      { key: "do_discussion", label: "完成讨论", type: "switch", default: true },
      { key: "discussion_text", label: "讨论回复内容", type: "text", default: "很有启发性的讨论，让我对这个问题有了更深入的思考。" },
      { key: "heartbeat_interval", label: "心跳间隔", type: "number", default: 5, min: 1, max: 60, suffix: "秒", help: "数值越大越接近真实观看，耗时越长" },
      { key: "replay_incomplete", label: "未完成时重播次数", type: "number", default: 1, min: 0, max: 5 },
    ],
  },
  {
    id: "icve_ai",
    name: "智慧职教 · AI优课/常规MOOC",
    short: "职教AI",
    color: "#0e9f6e",
    login: "sso",
    loginHint: ICVE_HINT,
    courseNoun: "课程",
    usesAI: false,
    options: [],
  },
  {
    id: "icve_mooc",
    name: "智慧职教 · MOOC学院",
    short: "职教MOOC",
    color: "#047857",
    login: "sso",
    loginHint: ICVE_HINT,
    courseNoun: "课程",
    usesAI: true,
    options: [
      { key: "topic_replies", label: "讨论回复（随机选一条）", type: "tags", default: ["好", "加油", "积极响应"] },
      { key: "ai_answer", label: "AI 答题", type: "switch", default: false, help: "需要先在设置中配置 AI 接口" },
      { key: "auto_submit", label: "AI 答题后自动交卷", type: "switch", default: false },
    ],
  },
  {
    id: "weban",
    name: "安全微伴",
    short: "微伴",
    color: "#d97706",
    login: "password",
    loginHint: "选择学校并输入学号与密码，验证码会自动识别",
    courseNoun: "项目",
    usesAI: true,
    options: [
      {
        key: "study_mode", label: "学习模式", type: "select", default: "true",
        options: [{ value: "true", label: "正常学习" }, { value: "force", label: "强制重新学习" }, { value: "false", label: "不学习" }],
      },
      {
        key: "exam_mode", label: "考试模式", type: "select", default: "true",
        options: [{ value: "true", label: "正常考试" }, { value: "perfect", label: "追求满分" }, { value: "force", label: "强制重考" }, { value: "false", label: "不考试" }],
      },
      { key: "random_answer", label: "题库外题目随机作答", type: "switch", default: true, help: "AI 作答失败后的兜底方式" },
      { key: "manual_answer", label: "题库外题目手动作答", type: "switch", default: false, help: "开启后会弹窗让你选择答案（优先于随机）" },
      { key: "study_time", label: "每门课学习时长", type: "text", default: "20,10", help: "格式：基础秒数,随机上限秒数" },
      {
        key: "video_speed", label: "视频课等待", type: "select", default: "1",
        options: [{ value: "1", label: "按视频时长" }, { value: "2", label: "按视频时长的一半" }, { value: "0", label: "不按视频时长" }],
      },
      { key: "exam_question_time", label: "每题作答时间", type: "text", default: "3,3", help: "格式：基础秒数,随机上限秒数" },
      { key: "exam_submit_match_rate", label: "交卷最低题库匹配率", type: "number", default: 90, min: 0, max: 100, suffix: "%" },
      { key: "jupiter_fallback", label: "补发翻页轨迹", type: "switch", default: false, help: "个别学校报 10018 时开启" },
    ],
  },
  {
    id: "zhihuishu",
    name: "智慧树",
    short: "智慧树",
    color: "#7c3aed",
    login: "qrcode",
    loginHint: "使用「知到」App 扫码登录（服务器上的无头浏览器会显示二维码）；也可以粘贴从浏览器导出的 Cookie",
    courseNoun: "课程",
    usesAI: false,
    options: [
      {
        key: "playback_rate", label: "播放倍速", type: "select", default: "2", help: "使用播放器自带的倍速按钮；课程没开放这一档时自动降到可选的最高档（多数课程最高 1.5×）",
        options: [{ value: "1", label: "1.0×" }, { value: "1.25", label: "1.25×" }, { value: "1.5", label: "1.5×" }, { value: "2", label: "2.0×" }, { value: "2.5", label: "2.5×" }, { value: "3", label: "3.0×" }],
      },
      {
        key: "quality", label: "清晰度", type: "select", default: "480p", help: "480P 省带宽和服务器资源；选「不调整」则保持播放器默认",
        options: [{ value: "480p", label: "480P（流畅）" }, { value: "720p", label: "720P（高清）" }, { value: "keep", label: "不调整" }],
      },
      { key: "skip_keywords", label: "跳过章节关键词", type: "tags", default: ["测试", "考试", "作业", "讨论", "答疑"], help: "章节名包含这些词时跳过" },
      { key: "max_sections", label: "每门课最多推进", type: "number", default: 0, min: 0, max: 1000, suffix: "节", help: "0 表示不限。视频真实播放，每节耗时约等于视频时长" },
      { key: "force", label: "重跑已完成的课程", type: "switch", default: false },
    ],
  },
  {
    id: "diagnostic",
    name: "诊断（测试用）",
    short: "诊断",
    color: "#6b7280",
    login: "diagnostic",
    loginHint: "不访问任何网站，用于测试界面与引擎通信",
    courseNoun: "课程",
    usesAI: false,
    options: [
      { key: "steps", label: "每门课步骤数", type: "number", default: 5, min: 1, max: 200 },
      { key: "ask", label: "测试手动答题弹窗", type: "switch", default: true },
    ],
  },
];

export const platformById = (id: string): PlatformMeta =>
  PLATFORMS.find((p) => p.id === id) ?? { ...PLATFORMS[PLATFORMS.length - 1], id, name: id, short: id };

export function defaultOptions(p: PlatformMeta): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const f of p.options) o[f.key] = f.type === "select" && /^\d+$/.test(f.default) && f.key === "video_speed" ? Number(f.default) : f.default;
  return o;
}
