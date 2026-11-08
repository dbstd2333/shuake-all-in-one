// SPDX-License-Identifier: AGPL-3.0-or-later
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
    loginHint: "将在系统浏览器中打开智慧职教统一登录页面，登录完成后自动返回",
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
    loginHint: "将在系统浏览器中打开智慧职教统一登录页面，登录完成后自动返回",
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
