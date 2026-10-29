/**
 * FullPaperReviewService（M15.12 B2）：全文级 Goal–Method–Claim–Evidence 审查 pass。
 *
 * 背景（M15.11 结论）：分节审阅与 one-shot 全文审稿的共同盲区 = 整稿级 meta 批评
 * （目标-方法错位、claim-evidence 支撑不足、过度声称 vs 实际交付范围）——这类判断
 * 需要跨节综合；分节上下文（导航 ≤3000 字符）与单次全文调用都难以稳定做出。
 *
 * 机制：两次有界调用，判断可追溯到真实被审文本：
 *   1. extract（scope review/fullpaper/extract）：论文概览 + 全节导航摘要索引（放宽带宽）
 *      + intro/conclusion/contributions 类节全文（标题确定性匹配）→ 论证结构 JSON
 *      （研究目标/任务/贡献声称/方法模块/关键 claims/证据映射，带 sectionId 锚）。
 *   2. critique（scope review/fullpaper/critique）：概览 + 论证图 + 被引用节全文
 *      （抽取输出提到的 sectionId 并集，按文档序，超限截断如实登记）+ 既有分节
 *      findings 摘要（去重聚焦，不重复报告）→ 全局 findings。
 *
 * 纪律（与 SectionReviewService 同源）：
 * - 每次调用一个短生命周期任务（独立 contextScope），不建长会话；
 * - 输出必须解析为结构化 findings（sectionId 必须存在于文档——createFinding 级
 *   provenance 硬约束）；解析失败/非法条目如实计数（dropped），不带病入报告；
 * - 证据不足写 INSUFFICIENT_EVIDENCE / AUTHOR_DECISION_REQUIRED 语义，不伪造论文内容；
 * - 未覆盖部分（索引/引用节截断）显式登记，绝不冒充全文已读。
 */

import { AgentRunFailedError } from "../errors.js";
import type { AgentRuntime } from "../runtime/types.js";
import {
  createFinding,
  FINDING_CATEGORIES,
  FINDING_SEVERITIES,
  severityRank,
  type FindingCategory,
  type FindingSeverity,
  type ReviewFinding,
} from "../review/finding.js";
import type { PaperStore } from "./PaperStore.js";

/** 概览（标题+摘要）截断 */
const OVERVIEW_MAX_CHARS = 2000;
/** 导航摘要索引：单条/总量截断（分节审阅为 400/3000——全局 pass 放宽以修复长文可见性偏倚） */
const INDEX_ENTRY_MAX_CHARS = 600;
const INDEX_TOTAL_MAX_CHARS = 12_000;
/** intro/conclusion/contributions 类节全文：单节截断 */
const KEY_SECTION_MAX_CHARS = 10_000;
/** 关键节标题确定性匹配（大小写不敏感） */
const KEY_SECTION_TITLE_PATTERN = /intro|conclu|contribut|abstract|summar/i;
/** critique 调用：被引用节全文总量上限 */
const REFERENCED_TOTAL_MAX_CHARS = 35_000;
/** critique 调用：论证图回注上限 */
const EXTRACTION_MAX_CHARS = 8000;
/** critique 调用：分节 findings 摘要（条数×单条字符） */
const FINDINGS_DIGEST_MAX_ITEMS = 60;
const FINDINGS_DIGEST_ITEM_CHARS = 150;
/**
 * 解析失败的有界重试上限（含首次共 2 次调用）。M15.12 fam-cand-23 教训：
 * critique 长输出 JSON 解析失败当时只能离线人工修复——同输入重跑即成功
 * （瞬态格式漂移，非确定性截断）。重试是物理调用，如实计入 telemetry.calls。
 */
const PARSE_ATTEMPTS = 2;
/** 重试时附加的最小格式修复指令（只在上一次输出不可解析时出现） */
const FORMAT_REMINDER =
  "注意：上一次输出无法解析为 JSON。请严格输出单个 JSON 对象：不要代码围栏、不要 JSON 之外的任何文字，也不要在对象内部留注释。";

export interface FullPaperReviewServiceOptions {
  store: PaperStore;
  runtime: AgentRuntime;
  reviewerAgentId: string;
  /** 逐 run 执行超时覆盖（毫秒；缺省沿用 Runtime 默认） */
  runTimeoutMs?: number;
  now?: () => Date;
}

export interface FullPaperCoverageLedger {
  /** 导航索引：总节数 / 实际纳入数（截断或预算耗尽时 included < total） */
  indexEntriesTotal: number;
  indexEntriesIncluded: number;
  /** 关键节（intro/conclusion/... 全文纳入）数 */
  keySectionsIncluded: number;
  /** critique：抽取引用节数 / 实际纳入字符（含截断标记） */
  referencedSections: number;
  referencedChars: number;
  referencedTruncated: boolean;
  /** 分节 findings 摘要：纳入条数 / 总条数 */
  findingsDigestIncluded: number;
  findingsDigestTotal: number;
}

export interface FullPaperReviewOutcome {
  findings: ReviewFinding[];
  /** 任一调用整体解析失败（两次尝试后仍失败才置 true；findings 可能为空） */
  extractParseFailed: boolean;
  critiqueParseFailed: boolean;
  /** 解析失败触发过重试（第一次失败、第二次成功时 false 失败标志 + true 重试标志） */
  extractRetried: boolean;
  critiqueRetried: boolean;
  /** 结构非法被丢弃的 finding 条数 */
  dropped: number;
  telemetry: { calls: number; failed: number; totalMs: number; approxPromptChars: number; outputChars: number };
  coverage: FullPaperCoverageLedger;
  /** extract 调用的解析结果（审计/复现用；不进入 findings） */
  extraction: unknown;
}

/** critique finding 候选（解析后、锚校验前；sectionId 为必填——provenance 硬约束） */
export interface ParsedFullPaperFinding {
  category: FindingCategory;
  severity: FindingSeverity;
  message: string;
  sectionId: string;
  claimText?: string;
  evidenceGap?: string;
  confidence?: "high" | "medium" | "low";
  suggestion?: string;
}

const VALID_CATEGORIES: ReadonlySet<string> = new Set(FINDING_CATEGORIES);
const VALID_SEVERITIES: ReadonlySet<string> = new Set(FINDING_SEVERITIES);
const VALID_CONFIDENCES = new Set(["high", "medium", "low"]);

function stripCodeFence(text: string): string {
  const fenced = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(text);
  return fenced !== null ? fenced[1] ?? text : text;
}

/** 宽容 JSON 提取（围栏/前后噪声；与 parseSectionFindingsOutput 同容忍度） */
function parseLenientJson(raw: string): unknown | undefined {
  const text = raw.trim();
  if (text === "") {
    return undefined;
  }
  try {
    return JSON.parse(stripCodeFence(text));
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) {
      return undefined;
    }
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

/** critique 输出 → finding 候选（纯函数；非法条目计入 dropped） */
export function parseFullPaperFindingsOutput(raw: string): {
  findings: ParsedFullPaperFinding[];
  dropped: number;
  parseFailed: boolean;
} {
  const parsed = parseLenientJson(raw);
  if (parsed === undefined) {
    return { findings: [], dropped: 0, parseFailed: true };
  }
  const container = parsed as { findings?: unknown };
  const list = Array.isArray(container?.findings) ? container.findings : undefined;
  if (list === undefined) {
    return { findings: [], dropped: 0, parseFailed: true };
  }
  const findings: ParsedFullPaperFinding[] = [];
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
    const sectionId = typeof record["sectionId"] === "string" ? record["sectionId"].trim() : undefined;
    if (
      typeof category !== "string" ||
      !VALID_CATEGORIES.has(category) ||
      typeof severity !== "string" ||
      !VALID_SEVERITIES.has(severity) ||
      message === "" ||
      sectionId === undefined ||
      sectionId === ""
    ) {
      // sectionId 为 provenance 硬约束（createFinding 级）：缺失即整条非法
      dropped += 1;
      continue;
    }
    const confidence = record["confidence"];
    findings.push({
      category: category as FindingCategory,
      severity: severity as FindingSeverity,
      message: message.slice(0, 2000),
      sectionId: sectionId.slice(0, 64),
      ...(typeof record["claimText"] === "string" && record["claimText"].trim() !== ""
        ? { claimText: record["claimText"].trim().slice(0, 1000) }
        : {}),
      ...(typeof record["evidenceGap"] === "string" && record["evidenceGap"].trim() !== ""
        ? { evidenceGap: record["evidenceGap"].trim().slice(0, 1000) }
        : {}),
      ...(typeof confidence === "string" && VALID_CONFIDENCES.has(confidence)
        ? { confidence: confidence as "high" | "medium" | "low" }
        : {}),
      ...(typeof record["suggestion"] === "string" && record["suggestion"].trim() !== ""
        ? { suggestion: record["suggestion"].trim().slice(0, 1000) }
        : {}),
    });
  }
  return { findings, dropped, parseFailed: false };
}

/** 从抽取输出中收集被引用的 sectionId（确定性：字段值以 sec 开头） */
export function collectReferencedSectionIds(extraction: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      const match = /^(sec\d+)$/i.exec(value.trim());
      if (match !== null) {
        found.push(match[1]!.toUpperCase());
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const item of Object.values(value as Record<string, unknown>)) {
        visit(item);
      }
    }
  };
  visit(extraction);
  return Array.from(new Set(found));
}

const EXTRACT_INSTRUCTION = [
  "你是论文审稿助手。先只做客观抽取（不评价、不建议）：从下面给出的材料中提取论文自身的论证结构。",
  "材料包含：论文概览、全部章节的导航摘要索引、以及部分关键章节（引言/结论/贡献等）的全文。",
  "输出一个 JSON 对象（不要代码围栏、不要多余文字），字段：",
  '{"research_goal": "论文声称的研究目标/要解决的问题（尽量贴近作者原话）",',
  ' "task_definition": "论文实际使用的评测任务",',
  ' "claimed_contributions": ["各条贡献声称（简短转述）"],',
  ' "method_modules": [{"name": "方法模块名", "claimed_mechanism": "论文声称其起作用的机制", "sectionId": "所在章节 id"}],',
  ' "key_claims": [{"claim": "结果/性能/适用性声称", "where": "声称位置（引用或定位）", "sectionId": "所在章节 id"}],',
  ' "evidence_map": [{"claim": "对应声称", "evidence": "论文提供的实验/基线/消融/数据集/指标（或 none stated）", "sectionId": "证据所在章节 id"}]}',
  "只写材料中明确陈述的内容；材料未覆盖的部分不要臆造；sectionId 用材料中给出的章节编号（如 SEC03），无法确定时省略该字段。",
].join("\n");

const CRITIQUE_INSTRUCTION = [
  "你是论文审稿 Agent。基于下面给出的材料做全文级（跨章节）学术审查。",
  "材料包含：论文概览、第一步抽取的论证结构（EXTRACTION）、被引用章节的全文（REFERENCED SECTIONS）、以及既有分节审阅已报告的问题摘要（EXISTING SECTION FINDINGS）。",
  "聚焦以下全局问题（分节审阅难以覆盖的整稿级判断）：",
  "1. 目标-方法-任务一致性：论文声称的研究目标与评测任务是否一致；提出的方法是否真正针对该目标，论证是否循环或跳步；",
  "2. claim-evidence 支撑：摘要/引言/结论中的关键声称是否被实验对照、消融、数据集、指标充分支撑；证据是否真的回答了研究问题；",
  "3. 过度声称：声称的适用范围/性能是否超出实际交付与实验覆盖；",
  "4. 跨节矛盾：不同章节的声称或与报告结果之间的不一致。",
  "规则：",
  "- 只报告能在材料中定位的问题；每条 finding 给出 sectionId（问题锚定的章节，优先用声称所在章节）；无法核验的内容在 message 中明确写「无法核验」；",
  "- 稿件材料不足以判断某点时，在该条 message 中写 INSUFFICIENT_EVIDENCE 并说明缺什么，不要臆断；需要作者决策的写 AUTHOR_DECISION_REQUIRED；",
  "- 不要重复 EXISTING SECTION FINDINGS 已覆盖的具体问题（可做跨节综合后引用性地上位概括）；不要报告纯排版/错字问题；",
  "- 不发明材料中不存在的引用或事实；不得建议伪造实验——缺实验就是 evidence gap。",
  "输出一个 JSON 对象（不要代码围栏、不要多余文字）：",
  '{"findings": [{"category": "fact|academic|style|citation|consistency|visual", "severity": "critical|major|minor|info",',
  ' "sectionId": "SEC01", "claimText": "相关原文论断（可空）", "message": "问题描述（中文，1-3 句，具体可定位）",',
  ' "evidenceGap": "缺失/不足的证据（可空）", "confidence": "high|medium|low", "suggestion": "建议作者做什么（可空）"}]}',
  '按严重程度从高到低排序；没有可报告的全局问题输出 {"findings": []}。',
].join("\n");

/** 全文级 pass：两步调用 → 全局 ReviewFinding[] */
export class FullPaperReviewService {
  private readonly store: PaperStore;
  private readonly runtime: AgentRuntime;
  private readonly reviewerAgentId: string;
  private readonly now: () => Date;
  private readonly timeoutOverride: { timeoutMs: number } | Record<string, never>;

  constructor(options: FullPaperReviewServiceOptions) {
    this.store = options.store;
    this.runtime = options.runtime;
    this.reviewerAgentId = options.reviewerAgentId;
    this.now = options.now ?? (() => new Date());
    this.timeoutOverride = options.runTimeoutMs !== undefined ? { timeoutMs: options.runTimeoutMs } : {};
  }

  async reviewFullPaper(input: {
    projectId: string;
    runId: string;
    /** 既有分节审阅 findings（摘要注入 critique，聚焦去重） */
    sectionFindings: readonly ReviewFinding[];
    signal?: AbortSignal;
  }): Promise<FullPaperReviewOutcome> {
    const document = await this.store.loadDocument(input.projectId);
    const map = await this.store.loadMap(input.projectId);
    if (document === null || map === null) {
      throw new AgentRunFailedError("尚未构建 PaperMap（先完成 paper.ensure）");
    }

    // ---- 事实源组装（确定性；截断全部登记） ----
    const overviewParts: string[] = [];
    if (map.documentTitle !== undefined) {
      overviewParts.push(`标题：${map.documentTitle}`);
    }
    if (map.abstract !== undefined && map.abstract !== "") {
      overviewParts.push(`摘要：${map.abstract.slice(0, OVERVIEW_MAX_CHARS)}`);
    }
    const overview = overviewParts.join("\n");

    const indexLines: string[] = [];
    let indexChars = 0;
    let indexIncluded = 0;
    for (const entry of map.sections) {
      const summary = entry.summary;
      const summaryText =
        summary !== undefined && summary.status === "ok" && summary.summary
          ? summary.summary
          : "（摘要未生成）";
      const line = `- ${entry.sectionId} ${entry.title}（p${entry.pageStart}-${entry.pageEnd}）：${summaryText}`.slice(
        0,
        INDEX_ENTRY_MAX_CHARS,
      );
      if (indexChars + line.length > INDEX_TOTAL_MAX_CHARS) {
        break;
      }
      indexLines.push(line);
      indexChars += line.length;
      indexIncluded += 1;
    }
    const sectionIndex = indexLines.join("\n");

    const chunksBySection = new Map<string, string[]>();
    for (const chunk of document.chunks) {
      const list = chunksBySection.get(chunk.sectionId) ?? [];
      list.push(chunk.text);
      chunksBySection.set(chunk.sectionId, list);
    }
    const fullTextOf = (sectionId: string): string =>
      (chunksBySection.get(sectionId) ?? []).join("\n\n");

    // 关键节全文（intro/conclusion/contributions/abstract/summary——标题确定性匹配）
    const keySections = map.sections.filter((entry) =>
      KEY_SECTION_TITLE_PATTERN.test(entry.title),
    );
    const keySectionBlocks = keySections.map((entry) =>
      [`【${entry.sectionId} ${entry.title} 全文】`, fullTextOf(entry.sectionId).slice(0, KEY_SECTION_MAX_CHARS)].join("\n"),
    );

    const extractPrompt = [
      ...(overview !== "" ? [`【论文概览】\n${overview}`] : []),
      `【全文导航（全部章节摘要索引）】\n${sectionIndex}`,
      ...(keySectionBlocks.length > 0 ? [`【关键章节全文】\n${keySectionBlocks.join("\n\n")}`] : []),
      `【任务】\n${EXTRACT_INSTRUCTION}`,
    ].join("\n\n");

    // ---- Call 1：论证结构抽取（解析失败有界重试 1 次） ----
    const telemetry = { calls: 0, failed: 0, totalMs: 0, approxPromptChars: 0, outputChars: 0 };
    const callAgent = async (args: {
      prompt: string;
      contextScope: string;
      pass: string;
    }): Promise<string> => {
      const prompt = args.prompt;
      telemetry.calls += 1;
      telemetry.approxPromptChars += prompt.length;
      const startedAt = Date.now();
      const task = await this.runtime.runAgent({
        agentId: this.reviewerAgentId,
        ...this.timeoutOverride,
        projectId: input.projectId,
        contextScope: args.contextScope,
        task: prompt,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        metadata: { role: "reviewer", pass: args.pass },
      });
      const output = task.status === "completed" ? task.output ?? "" : "";
      telemetry.totalMs += Date.now() - startedAt;
      telemetry.outputChars += output.length;
      if (output.trim() === "") {
        telemetry.failed += 1;
      }
      return output;
    };

    const extractOutcome = await this.withParseRetry(
      (retry) =>
        callAgent({
          prompt: retry ? `${extractPrompt}\n\n${FORMAT_REMINDER}` : extractPrompt,
          contextScope: "review/fullpaper/extract",
          pass: "fullpaper-extract",
        }),
      (output) => parseLenientJson(output),
    );
    const extraction = extractOutcome.value;
    const extractParseFailed = extractOutcome.parseFailed;
    const extractionJson =
      !extractParseFailed && extraction !== undefined
        ? JSON.stringify(extraction).slice(0, EXTRACTION_MAX_CHARS)
        : "";

    // ---- Call 2：全局批判（被引用节全文 + 分节 findings 摘要） ----
    const referencedIds = extractParseFailed
      ? keySections.map((entry) => entry.sectionId) // 抽取失败的确定性回退：关键节全文
      : collectReferencedSectionIds(extraction);
    const referencedBlocks: string[] = [];
    let referencedChars = 0;
    let referencedIncluded = 0;
    let referencedTruncated = false;
    for (const sectionId of referencedIds) {
      const entry = map.sections.find((candidate) => candidate.sectionId === sectionId);
      if (entry === undefined) {
        continue;
      }
      let text = fullTextOf(sectionId);
      if (referencedChars + text.length > REFERENCED_TOTAL_MAX_CHARS) {
        const remaining = REFERENCED_TOTAL_MAX_CHARS - referencedChars;
        if (remaining <= 200) {
          referencedTruncated = true;
          break;
        }
        text = text.slice(0, remaining);
        referencedTruncated = true;
      }
      referencedBlocks.push(
        [`【${entry.sectionId} ${entry.title} 全文】`, text].join("\n"),
      );
      referencedChars += text.length;
      referencedIncluded += 1;
    }
    if (referencedIncluded === 0 && keySections.length > 0) {
      // 抽取未引用任何有效节：回退关键节（保证 critique 有真实全文可锚）
      for (const entry of keySections) {
        const text = fullTextOf(entry.sectionId).slice(0, KEY_SECTION_MAX_CHARS);
        referencedBlocks.push([`【${entry.sectionId} ${entry.title} 全文】`, text].join("\n"));
        referencedIncluded += 1;
      }
    }

    const orderedFindings = [...input.sectionFindings].sort(
      (a, b) => severityRank(b.severity) - severityRank(a.severity) || a.findingId.localeCompare(b.findingId),
    );
    const digestTotal = orderedFindings.length;
    const digest = orderedFindings
      .slice(0, FINDINGS_DIGEST_MAX_ITEMS)
      .map((finding) =>
        `- [${finding.severity}/${finding.category}] ${finding.message.replace(/\s+/g, " ")}`.slice(
          0,
          FINDINGS_DIGEST_ITEM_CHARS,
        ),
      )
      .join("\n");
    const digestIncluded = Math.min(digestTotal, FINDINGS_DIGEST_MAX_ITEMS);

    const critiquePrompt = [
      ...(overview !== "" ? [`【论文概览】\n${overview}`] : []),
      ...(extractionJson !== ""
        ? [`【EXTRACTION（第一步抽取的论证结构）】\n${extractionJson}`]
        : []),
      ...(referencedBlocks.length > 0
        ? [`【REFERENCED SECTIONS（被引用章节全文）】\n${referencedBlocks.join("\n\n")}`]
        : []),
      ...(digest !== ""
        ? [
            `【EXISTING SECTION FINDINGS（分节审阅已报告问题摘要，仅去重参考）】\n${digest}`,
          ]
        : []),
      `【任务】\n${CRITIQUE_INSTRUCTION}`,
    ].join("\n\n");

    const critiqueOutcome = await this.withParseRetry(
      (retry) =>
        callAgent({
          prompt: retry ? `${critiquePrompt}\n\n${FORMAT_REMINDER}` : critiquePrompt,
          contextScope: "review/fullpaper/critique",
          pass: "fullpaper-critique",
        }),
      (output) => {
        const parsed = parseFullPaperFindingsOutput(output);
        return parsed.parseFailed ? undefined : parsed;
      },
    );
    const parsed =
      critiqueOutcome.value ?? { findings: [], dropped: 0, parseFailed: true };

    const validSectionIds = new Set(map.sections.map((entry) => entry.sectionId));
    const findings: ReviewFinding[] = [];
    let dropped = parsed.dropped;
    const timestamp = this.now().toISOString();
    for (const candidate of parsed.findings) {
      if (!validSectionIds.has(candidate.sectionId)) {
        // provenance 锚校验：sectionId 不存在于文档 → 整条丢弃（如实计数）
        dropped += 1;
        continue;
      }
      const base = createFinding({
        findingId: `f-${input.runId}-fullpaper-${findings.length + 1}`.toLowerCase(),
        category: candidate.category,
        severity: candidate.severity,
        message: candidate.message,
        source: "fullpaper-review",
        now: timestamp,
        sectionId: candidate.sectionId,
        ...(candidate.claimText !== undefined ? { claimText: candidate.claimText } : {}),
        ...(candidate.suggestion !== undefined ? { suggestion: candidate.suggestion } : {}),
      });
      findings.push({
        ...base,
        ...(candidate.evidenceGap !== undefined ? { evidenceGap: candidate.evidenceGap } : {}),
        ...(candidate.confidence !== undefined ? { confidence: candidate.confidence } : {}),
      });
    }

    return {
      findings,
      extractParseFailed,
      critiqueParseFailed: parsed.parseFailed,
      extractRetried: extractOutcome.retried,
      critiqueRetried: critiqueOutcome.retried,
      dropped,
      telemetry,
      coverage: {
        indexEntriesTotal: map.sections.length,
        indexEntriesIncluded: indexIncluded,
        keySectionsIncluded: keySections.length,
        referencedSections: referencedIncluded,
        referencedChars,
        referencedTruncated,
        findingsDigestIncluded: digestIncluded,
        findingsDigestTotal: digestTotal,
      },
      extraction,
    };
  }

  /**
   * 解析失败的有界重试（PARSE_ATTEMPTS=2）：第一次输出不可解析（含 agent
   * 失败/空输出）→ 同输入 + FORMAT_REMINDER 再试一次；两次都失败才置
   * parseFailed（如实降级，绝不把失败静默记为成功）。取消信号经 runAgent
   * 自然上抛（不吞）。每次调用都是物理调用（由 callAgent 计入 telemetry）。
   */
  private async withParseRetry<T>(
    call: (retryAttempt: boolean) => Promise<string>,
    parse: (output: string) => T | undefined,
  ): Promise<{ value: T | undefined; parseFailed: boolean; retried: boolean }> {
    let retried = false;
    for (let attempt = 1; attempt <= PARSE_ATTEMPTS; attempt += 1) {
      const isRetry = attempt > 1;
      const value = parse(await call(isRetry));
      if (value !== undefined) {
        return { value, parseFailed: false, retried: isRetry || retried };
      }
      retried = retried || isRetry;
    }
    return { value: undefined, parseFailed: true, retried };
  }
}
