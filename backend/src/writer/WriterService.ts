/**
 * Writer Agent（M2 基础 + M3.1 分节扩展）。
 *
 * - write()：M2 完整文档形态（legacy generate API 使用）
 * - planOutline()：基于调研与 Evidence 产出结构化大纲（JSON，经确定性校验）
 * - writeSection()：逐节写作（LaTeX 片段，禁止 \documentclass / \begin{document}）
 *
 * 输出校验失败抛业务错误（Agent 返回文本 ≠ 成功）。
 */

import { AgentRunFailedError, InvalidLatexOutputError } from "../errors.js";
import type { AgentRuntime, AgentTask } from "../runtime/types.js";
import type { BibliographyEntryInput } from "../agents/ResearcherService.js";
import type { EvidenceRecord } from "../evidence/EvidenceStore.js";
import type { Outline, OutlineSection } from "../manuscript/ManuscriptService.js";
import { validateOutline } from "../manuscript/ManuscriptService.js";
import { extractJsonObject } from "../agents/outputParsing.js";

export interface WriterServiceOptions {
  runtime: AgentRuntime;
  /** Writer 对应的 OpenClaw agent id */
  agentId: string;
  /** 诊断日志 */
  log?: (message: string) => void;
}

export interface WriterResult {
  task: AgentTask;
  /** 校验后的 LaTeX 文档全文 */
  latex: string;
}

/** Markdown 代码围栏（模型偶尔会无视指令包裹输出，做防御性剥离） */
const FENCE_PATTERN = /^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/;

export class WriterService {
  private readonly runtime: AgentRuntime;
  private readonly agentId: string;
  private readonly log: (message: string) => void;

  constructor(options: WriterServiceOptions) {
    this.runtime = options.runtime;
    this.agentId = options.agentId;
    this.log = options.log ?? (() => {});
  }

  /**
   * 执行一次写作任务。
   * 输入是用户的自然语言写作要求；输出是完整 LaTeX 文档。
   * sessionKey（可选）是该项目上次任务返回的 Runtime 会话引用，原样透传以复用上下文。
   */
  async write(params: {
    projectId: string;
    prompt: string;
    sessionKey?: string;
  }): Promise<WriterResult> {
    const prompt = params.prompt.trim();
    if (prompt === "") {
      throw new AgentRunFailedError("写作任务（prompt）不能为空");
    }

    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      task: buildWriterPrompt(prompt),
      projectId: params.projectId,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      metadata: { role: "writer", milestone: "M2" },
    });

    if (task.status !== "completed") {
      throw new AgentRunFailedError(task.error ?? `Writer 任务以 ${task.status} 状态结束`);
    }
    const output = task.output?.trim();
    if (!output) {
      throw new AgentRunFailedError("Writer 没有返回任何文本");
    }

    const latex = stripCodeFence(output);
    if (!latex.includes("\\documentclass")) {
      throw new InvalidLatexOutputError(
        "返回内容中没有 \\documentclass 命令（应为完整 LaTeX 文档）",
      );
    }
    if (!latex.includes("\\begin{document}")) {
      throw new InvalidLatexOutputError("返回内容中没有 \\begin{document}");
    }

    this.log(`[writer] projectId=${params.projectId} taskId=${task.taskId} 产出 LaTeX ${latex.length} 字符`);
    return { task, latex };
  }

  // ---- M3.1：分节写作 ----

  /**
   * 产出结构化大纲（JSON）。校验：至少 3 节、文件名合法、id 唯一。
   * feedback 用于 HITL 修订轮（用户对上一版大纲的修改意见）。
   */
  async planOutline(params: {
    projectId: string;
    researchDigest: {
      domainOverview: string;
      researchGaps: string[];
      potentialContributions: string[];
    };
    evidence: EvidenceRecord[];
    bibliography: BibliographyEntryInput[];
    targetProfile?: string;
    documentType?: string;
    feedback?: string;
  }): Promise<Outline> {
    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      task: buildOutlinePrompt(params),
      projectId: params.projectId,
      contextScope: "writing/outline",
      metadata: { role: "writer", skill: "outline", milestone: "M3.1" },
    });
    if (task.status !== "completed") {
      throw new AgentRunFailedError(task.error ?? `大纲任务以 ${task.status} 状态结束`);
    }
    const parsed = extractJsonObject(task.output ?? "", "大纲结果");
    const outline: Outline = {
      title:
        typeof parsed["title"] === "string" && parsed["title"].trim() !== ""
          ? parsed["title"].trim()
          : "Untitled",
      ...(typeof parsed["abstract"] === "string" && parsed["abstract"].trim() !== ""
        ? { abstract: parsed["abstract"].trim() }
        : {}),
      sections: readOutlineSections(parsed),
    };
    const violations = validateOutline(outline);
    if (violations.length > 0) {
      throw new InvalidLatexOutputError(`大纲未通过校验：${violations.join("；")}`);
    }
    this.log(`[writer] projectId=${params.projectId} 大纲完成：${outline.sections.length} 节`);
    return outline;
  }

  /**
   * 写作单个章节（LaTeX 片段，不含文档骨架）。
   * 校验：非空、不含 \documentclass / \begin{document}（骨架由确定性代码生成）。
   */
  async writeSection(params: {
    projectId: string;
    section: OutlineSection;
    outline: Outline;
    evidence: EvidenceRecord[];
    bibliography: BibliographyEntryInput[];
    styleProfile?: Record<string, unknown>;
    extraInstructions?: string;
  }): Promise<{ latex: string; taskId: string }> {
    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      task: buildSectionPrompt(params),
      projectId: params.projectId,
      contextScope: "writing/sections",
      metadata: { role: "writer", skill: "section", milestone: "M3.1" },
    });
    if (task.status !== "completed") {
      throw new AgentRunFailedError(
        task.error ?? `章节 ${params.section.id} 写作任务以 ${task.status} 状态结束`,
      );
    }
    const latex = stripCodeFence(task.output ?? "").trim();
    if (latex === "") {
      throw new AgentRunFailedError(`章节 ${params.section.id} 没有返回内容`);
    }
    if (latex.includes("\\documentclass") || latex.includes("\\begin{document}")) {
      throw new InvalidLatexOutputError(
        `章节 ${params.section.id} 返回了完整文档骨架（应为正文片段；骨架由系统生成）`,
      );
    }
    if (!hasBalancedBraces(latex)) {
      throw new InvalidLatexOutputError(`章节 ${params.section.id} 花括号不配对`);
    }
    return { latex, taskId: task.taskId };
  }
}

/** 解析大纲 sections 数组（防御性） */
function readOutlineSections(parsed: Record<string, unknown>): OutlineSection[] {
  const value = parsed["sections"];
  if (!Array.isArray(value)) {
    return [];
  }
  const sections: OutlineSection[] = [];
  for (const raw of value.slice(0, 20)) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const record = raw as Record<string, unknown>;
    if (typeof record["id"] !== "string" || typeof record["file"] !== "string") {
      continue;
    }
    sections.push({
      id: record["id"].trim().toLowerCase().replaceAll(/[^a-z0-9-]/g, "-").slice(0, 40),
      file: record["file"].trim().toLowerCase(),
      ...(typeof record["title"] === "string" ? { title: record["title"].trim() } : { title: record["id"] }),
      ...(typeof record["targetLengthWords"] === "number"
        ? { targetLengthWords: Math.max(50, Math.min(5000, Math.round(record["targetLengthWords"]))) }
        : {}),
      ...(Array.isArray(record["keyPoints"])
        ? {
            keyPoints: record["keyPoints"]
              .filter((point): point is string => typeof point === "string" && point.trim() !== "")
              .slice(0, 10)
              .map((point) => point.trim()),
          }
        : {}),
    });
  }
  return sections;
}

/** 粗粒度花括号配对检查（忽略 \{ 转义） */
function hasBalancedBraces(latex: string): boolean {
  let depth = 0;
  for (let index = 0; index < latex.length; index += 1) {
    const ch = latex[index];
    if (ch === "\\") {
      index += 1; // 跳过转义字符
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0;
}

function buildOutlinePrompt(params: {
  researchDigest: {
    domainOverview: string;
    researchGaps: string[];
    potentialContributions: string[];
  };
  evidence: EvidenceRecord[];
  bibliography: BibliographyEntryInput[];
  targetProfile?: string;
  documentType?: string;
  feedback?: string;
}): string {
  return [
    "你是一名学术论文写手（Writer）。请基于调研结果与 Evidence 规划论文大纲（只规划，不写正文）。",
    "",
    "只输出一个 JSON 对象（不要 Markdown 围栏），字段：",
    '{"title": "论文标题", "abstract": "摘要（100-200 字）",',
    ' "sections": [{"id": "introduction", "file": "introduction.tex", "title": "引言",',
    '   "targetLengthWords": 400, "keyPoints": ["要点 1"]}],',
    ' "references": []}',
    "",
    "要求：",
    "1. sections 至少 4 节（含 introduction 与 conclusion），至多 12 节；file 使用小写字母数字连字符加 .tex。",
    "2. 大纲必须与研究空白、潜在贡献对应；Evidence 不足的章节在 keyPoints 中明确标注「证据不足」。",
    "3. 可引用的参考文献 key：" +
      (params.bibliography.length > 0
        ? params.bibliography.map((entry) => entry.key).join(", ")
        : "（暂无；正文中不要使用 \\cite）"),
    ...(params.feedback ? ["", "用户对上一版大纲的修改意见（必须落实）：", params.feedback] : []),
    "",
    "===== 调研摘要 =====",
    `领域现状：${params.researchDigest.domainOverview.slice(0, 400)}`,
    `研究空白：${params.researchDigest.researchGaps.slice(0, 5).join("；")}`,
    `潜在贡献：${params.researchDigest.potentialContributions.slice(0, 5).join("；")}`,
    `目标类型：${params.documentType ?? "（未填写）"}；目标档次：${params.targetProfile ?? "（未填写）"}`,
    "",
    "===== 可用 Evidence（用于判断哪些论点有支撑）=====",
    ...params.evidence
      .slice(0, 20)
      .map((record) => `- [${record.id}] ${record.claim.slice(0, 120)}`),
  ].join("\n");
}

function buildSectionPrompt(params: {
  section: OutlineSection;
  outline: Outline;
  evidence: EvidenceRecord[];
  bibliography: BibliographyEntryInput[];
  styleProfile?: Record<string, unknown>;
  extraInstructions?: string;
}): string {
  return [
    `你是一名学术论文写手（Writer）。请撰写论文章节「${params.section.title}」。`,
    "",
    "输出要求：",
    "1. 只输出该章节的 LaTeX 正文片段：以 \\section{标题} 开始；不要 \\documentclass、\\begin{document}、导言区、文档骨架。",
    "2. 不要用 Markdown 代码块包裹，不要解释文字。",
    "3. 论述优先使用下方 Evidence 支撑；证据不足时显式弱化表述或标注，不为凑字虚构数据、结论或引用。",
    "4. 只允许引用以下参考文献 key：" +
      (params.bibliography.length > 0
        ? params.bibliography.map((entry) => entry.key).join(", ")
        : "（无可用文献：不要使用 \\cite）"),
    "5. 保持与其他章节的术语一致。",
    ...(params.styleProfile
      ? ["6. 参考论文的结构与呈现模式（只学结构，不复制内容）：" + JSON.stringify(params.styleProfile).slice(0, 600)]
      : []),
    ...(params.extraInstructions ? ["", "补充要求：", params.extraInstructions] : []),
    "",
    "===== 论文大纲（全文结构）=====",
    `标题：${params.outline.title}`,
    ...params.outline.sections.map((section) => `- ${section.title}（${section.id}）`),
    "",
    `===== 本章节要求 =====`,
    `章节：${params.section.title}（${params.section.file}）`,
    `目标长度：约 ${params.section.targetLengthWords ?? 400} 字`,
    ...(params.section.keyPoints?.length
      ? ["要点：", ...params.section.keyPoints.map((point) => `- ${point}`)]
      : []),
    "",
    "===== 可用 Evidence =====",
    ...params.evidence
      .slice(0, 20)
      .map(
        (record) =>
          `- [${record.id}] ${record.claim.slice(0, 150)}${record.quote ? `（引文："${record.quote.slice(0, 120)}"）` : ""}`,
      ),
    ...(params.evidence.length === 0 ? ["（无 Evidence：本章节避免需要外部证据的强论断）"] : []),
  ].join("\n");
}

/**
 * Writer Prompt（M2 有意保持简单）：
 * 要求完整 LaTeX、中文可用、无 Markdown 围栏、不虚构引用、优先保证可编译。
 */
export function buildWriterPrompt(userPrompt: string): string {
  return [
    "你是一名学术论文写手（Writer）。请根据下面的写作任务撰写一篇简短的学术论文，直接返回完整的 LaTeX 文档。",
    "",
    "要求：",
    "1. 只返回一个完整、可直接编译的 LaTeX 文档：从 \\documentclass 开始，到 \\end{document} 结束。",
    "2. 使用 \\documentclass[UTF8]{ctexart} 支持中文。",
    "3. 不要用 Markdown 代码块（```）包裹输出，不要输出任何解释、前言或结尾说明。",
    "4. 论文结构包含：标题、摘要、引言、结论。",
    "5. 不要虚构参考文献，不需要 \\cite 和参考文献列表。",
    "6. 优先保证能通过 XeLaTeX 编译：只使用基础宏包（amsmath、amssymb 等），不使用生僻宏包。",
    "",
    "写作任务：",
    userPrompt,
  ].join("\n");
}

/** 剥离模型可能误加的 Markdown 代码围栏 */
function stripCodeFence(text: string): string {
  const match = FENCE_PATTERN.exec(text);
  if (match?.[1]) {
    return match[1].trim();
  }
  return text.trim();
}
