/**
 * Section Review 消费者：把 ReviewContextBuilder
 * 组装好的受控上下文交给 Reviewer Agent，输出结构化 ReviewFinding。
 *
 * 纪律：
 * - 每节一个短生命周期任务（独立 contextScope：review/section/{id}），
 *   绝不把全文塞进一个不断增长的会话；
 * - 模型输出必须解析为结构化 findings（createFinding 强制 provenance），
 *   解析失败如实计数，不把 Markdown 当事实源；
 * - 本服务不读磁盘、不编排流程——只做「context → agent → findings」。
 */

import { AgentRunFailedError } from "../errors.js";
import type { AgentRuntime } from "../runtime/types.js";
import {
  createFinding,
  FINDING_CATEGORIES,
  FINDING_SEVERITIES,
  type FindingCategory,
  type FindingSeverity,
  type ReviewFinding,
} from "../review/finding.js";
import type { SectionReviewContext } from "./ReviewContextBuilder.js";

/** 单次 section review 的任务指令（附加在 context 之后；要求 JSON 输出） */
export const SECTION_REVIEW_INSTRUCTION = [
  "你是论文审稿 Agent。只审阅上面给出的当前章节文本，基于上下文中给出的材料输出审阅结论。",
  "输出必须是单个 JSON 对象（不要 Markdown 代码块、不要多余文字），格式：",
  '{"findings": [{"category": "fact|academic|style|citation|consistency", "severity": "critical|major|minor|info", "page": 页码数字(可选), "chunkId": "来源 chunk id(可选)", "claimText": "相关原文论断(可选)", "message": "问题描述（中文）", "suggestion": "改进建议(可选)"}]}',
  "只报告能在当前章节文本中定位的问题；无法核验的内容明确写「无法核验」；无问题输出 {\"findings\": []}。",
].join("\n");

const VALID_CATEGORIES: ReadonlySet<string> = new Set(FINDING_CATEGORIES);
const VALID_SEVERITIES: ReadonlySet<string> = new Set(FINDING_SEVERITIES);

/** 模型原始输出 → 规范化 finding 候选（纯函数，测试直接覆盖） */
export interface ParsedFindingCandidate {
  category: FindingCategory;
  severity: FindingSeverity;
  message: string;
  suggestion?: string;
  page?: number;
  chunkId?: string;
  claimText?: string;
}

export interface ParseFindingsResult {
  findings: ParsedFindingCandidate[];
  /** 结构非法被丢弃的条数（如实计数，不静默吞掉） */
  dropped: number;
  /** 整体解析失败（非 JSON / 非 {}） */
  parseFailed: boolean;
}

/** 解析模型输出（容忍 ```json 围栏与前后噪声；严格校验字段） */
export function parseSectionFindingsOutput(raw: string): ParseFindingsResult {
  const empty: ParseFindingsResult = { findings: [], dropped: 0, parseFailed: false };
  const text = raw.trim();
  if (text === "") {
    return { ...empty, parseFailed: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(text));
  } catch {
    // 容忍：模型在 JSON 前后加了说明文字 → 截取首个 { 到最后一个 }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) {
      return { ...empty, parseFailed: true };
    }
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      return { ...empty, parseFailed: true };
    }
  }
  const container = parsed as { findings?: unknown };
  const list = Array.isArray(container?.findings) ? container.findings : undefined;
  if (list === undefined) {
    return { ...empty, parseFailed: true };
  }
  const findings: ParsedFindingCandidate[] = [];
  let dropped = 0;
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) {
      dropped += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const category = record["category"];
    const severity = record["severity"];
    const message = typeof record["message"] === "string" ? record["message"].trim() : "";
    if (
      typeof category !== "string" ||
      !VALID_CATEGORIES.has(category) ||
      typeof severity !== "string" ||
      !VALID_SEVERITIES.has(severity) ||
      message === ""
    ) {
      dropped += 1;
      continue;
    }
    findings.push({
      category: category as FindingCategory,
      severity: severity as FindingSeverity,
      message: message.slice(0, 2000),
      ...(typeof record["suggestion"] === "string" && record["suggestion"].trim() !== ""
        ? { suggestion: record["suggestion"].trim().slice(0, 1000) }
        : {}),
      ...(typeof record["page"] === "number" && Number.isInteger(record["page"]) && record["page"] > 0
        ? { page: record["page"] }
        : {}),
      ...(typeof record["chunkId"] === "string" && record["chunkId"].trim() !== ""
        ? { chunkId: record["chunkId"].trim().slice(0, 64) }
        : {}),
      ...(typeof record["claimText"] === "string" && record["claimText"].trim() !== ""
        ? { claimText: record["claimText"].trim().slice(0, 1000) }
        : {}),
    });
  }
  return { findings, dropped, parseFailed: false };
}

function stripCodeFence(text: string): string {
  const fenced = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(text);
  return fenced !== null ? fenced[1] ?? text : text;
}

export interface SectionReviewServiceOptions {
  runtime: AgentRuntime;
  reviewerAgentId: string;
  now?: () => Date;
}

export interface SectionReviewOutcome {
  sectionId: string;
  findings: ReviewFinding[];
  /** 模型输出不可解析（如实计数；不判失败——单节噪声不应推翻整个 run） */
  parseFailed: boolean;
  dropped: number;
}

/** 单节审阅：context（含受控预算的 prompt）→ Reviewer Agent → ReviewFinding[] */
export class SectionReviewService {
  private readonly runtime: AgentRuntime;
  private readonly reviewerAgentId: string;
  private readonly now: () => Date;

  constructor(options: SectionReviewServiceOptions) {
    this.runtime = options.runtime;
    this.reviewerAgentId = options.reviewerAgentId;
    this.now = options.now ?? (() => new Date());
  }

  async reviewSection(input: {
    projectId: string;
    runId: string;
    context: SectionReviewContext;
    /** Workflow 取消信号：中断在途模型调用 */
    signal?: AbortSignal;
  }): Promise<SectionReviewOutcome> {
    const task = await this.runtime.runAgent({
      agentId: this.reviewerAgentId,
      projectId: input.projectId,
      contextScope: input.context.contextScope,
      task: input.context.prompt,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      metadata: { role: "reviewer", pass: "section-review" },
    });
    const output = task.output ?? "";
    if (task.status !== "completed" || output.trim() === "") {
      throw new AgentRunFailedError(task.error ?? "审阅任务未返回结果");
    }
    const parsed = parseSectionFindingsOutput(output);
    const timestamp = this.now().toISOString();
    const findings = parsed.findings.map((candidate, index) =>
      createFinding({
        findingId: `f-${input.runId}-${input.context.sectionId}-${index + 1}`.toLowerCase(),
        category: candidate.category,
        severity: candidate.severity,
        message: candidate.message,
        source: "section-review",
        now: timestamp,
        sectionId: input.context.sectionId,
        ...(candidate.page !== undefined ? { page: candidate.page } : {}),
        ...(candidate.chunkId !== undefined ? { chunkId: candidate.chunkId } : {}),
        ...(candidate.claimText !== undefined ? { claimText: candidate.claimText } : {}),
        ...(candidate.suggestion !== undefined ? { suggestion: candidate.suggestion } : {}),
      }),
    );
    return {
      sectionId: input.context.sectionId,
      findings,
      parseFailed: parsed.parseFailed,
      dropped: parsed.dropped,
    };
  }
}
