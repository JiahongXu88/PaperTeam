/**
 * PaperTeam 业务角色 → Pi AgentSession 配置映射（M3.7）。
 *
 * 设计原则（对照 OpenClaw 方案 A，docs/DECISIONS.md D-0018）：
 * - OpenClaw 路径下所有角色共用默认 agent（main），靠 prompt + contextScope
 *   隔离会话；Pi 没有 agent 注册表，因此"角色"落到 Adapter 内部的
 *   最小配置映射：systemPrompt + 工具白名单。
 * - 角色判定依据 contextScope 前缀（PaperTeam 代码内控的固定常量，
 *   见 sanitizeContextScope 的约束说明）：research* → researcher、
 *   writing* → writer、review* → reviewer；无 scope 时用 default。
 * - 任务级指令（真正的角色提示词）由上层业务 prompt 内联携带
 *   （与 OpenClaw 路径一致），这里的 systemPrompt 只做最小角色框架，
 *   不复制一套 Workflow Agent 层。
 * - 工具白名单按最小必要原则：M3 各角色的真实工作面是
 *   「读 workspace / 写 LaTeX」，shell 类工具（bash/powershell）默认
 *   不授予任何角色（LaTeX 编译由 PaperTeam 自己的 LatexCompiler 执行，
 *   不经过 Agent）。需要时可在 PiRuntimeAdapterOptions 覆盖。
 */

export type PiRoleKey = "researcher" | "writer" | "reviewer" | "default";

export interface PiRoleConfig {
  /** 角色键（诊断用） */
  role: PiRoleKey;
  /** 最小系统提示词（角色框架；任务指令由 prompt 内联） */
  systemPrompt: string;
  /** 内置工具白名单（createAgentSession 的 tools 参数） */
  tools: string[];
}

const COMMON_DISCIPLINE = [
  "你的任务指令会在每条用户消息中完整给出，严格按其要求输出。",
  "不要输出任务要求之外的解释、寒暄或 Markdown 围栏，除非任务明确要求。",
].join("\n");

const ROLE_CONFIGS: Record<PiRoleKey, PiRoleConfig> = {
  researcher: {
    role: "researcher",
    systemPrompt: [
      "你是 PaperTeam 的学术调研 Agent（Researcher）。",
      "工作目录是论文项目 workspace；你只读取项目内材料做调研与证据整理，不修改正文。",
      COMMON_DISCIPLINE,
    ].join("\n"),
    tools: ["read", "grep", "find", "ls"],
  },
  writer: {
    role: "writer",
    systemPrompt: [
      "你是 PaperTeam 的论文写作 Agent（Writer）。",
      "工作目录是论文项目 workspace；你按任务指令读取材料并产出/修改 LaTeX 稿件文件。",
      COMMON_DISCIPLINE,
    ].join("\n"),
    tools: ["read", "write", "edit", "grep", "find", "ls"],
  },
  reviewer: {
    role: "reviewer",
    systemPrompt: [
      "你是 PaperTeam 的论文审稿 Agent（Reviewer）。",
      "工作目录是论文项目 workspace；你只读取稿件与证据材料并输出结构化审稿结论。",
      COMMON_DISCIPLINE,
    ].join("\n"),
    tools: ["read", "grep", "find", "ls"],
  },
  default: {
    role: "default",
    systemPrompt: ["你是 PaperTeam 的 Agent。", COMMON_DISCIPLINE].join("\n"),
    tools: ["read", "grep", "find", "ls"],
  },
};

/** contextScope 前缀 → 角色键（scope 已经过 sanitizeContextScope 归一化） */
function roleKeyForScope(scope: string | undefined): PiRoleKey {
  if (!scope) {
    return "default";
  }
  if (scope === "research" || scope.startsWith("research/")) {
    return "researcher";
  }
  if (scope === "writing" || scope.startsWith("writing/")) {
    return "writer";
  }
  if (scope === "review" || scope.startsWith("review/")) {
    return "reviewer";
  }
  return "default";
}

/** 按归一化后的 contextScope 解析角色配置 */
export function resolveRoleConfig(contextScope: string | undefined): PiRoleConfig {
  return ROLE_CONFIGS[roleKeyForScope(contextScope)];
}

/** 全部角色配置（诊断/测试用） */
export function allRoleConfigs(): Record<PiRoleKey, PiRoleConfig> {
  return { ...ROLE_CONFIGS };
}
