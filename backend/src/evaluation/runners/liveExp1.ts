/**
 * Live Experiment 1 Runner（M6.9.1）：真实模型首轮冒烟评估。
 *
 * 与 M6.8 scripted Exp1 的关系：数据集与三段核验管道完全复用，唯一的
 * 差别是两个 LLM 介入点换成真实模型（经 PiRuntimeAdapter，不新增调用链）：
 *
 * - plain-llm-live（Arm A，baseline）：模型只见题录（无全文），自报证据
 *   提案（claim + quote + fileName），原样入证据池（unverified）。机械
 *   核验 quote 是否逐字存在于所声称来源 —— 度量真实模型的自报捏造率。
 * - paperteam-live（Arm B）：模型见文献库全文后提案；提案进入完整三段
 *   核验（quote 逐字 [确定性] / metadata [数据集 ground-truth provider] /
 *   judge [真实模型，产品 prompt 原样]）。度量同一机械口径下管道的
 *   拦截率与最终 verified 率。
 *
 * 本轮是 plumbing 冒烟，不是正式实验：样本小、单模型、judge 与生成同模型
 * （偏差见 limitations）。API 失败不修改实验逻辑：按 timeout / rate_limit /
 * auth / model_output_invalid / other 记录，继续或如实上报。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { extractJsonObject } from "../../agents/outputParsing.js";
import { normalizeForQuoteMatch } from "../../evidence/quoteVerification.js";
import type { AgentRuntime, AgentTask } from "../../runtime/types.js";
import type { GroundingCorpusSource, GroundingScenario } from "../types.js";
import type { LiveRuntimeHandle } from "../liveRuntime.js";
import { createGroundingHarness } from "./harness.js";

/** 每臂请求的提案数（冒烟规模：远小于正式实验） */
const PROPOSALS_PER_ARM = 5;
/** 单次生成调用的执行超时（毫秒） */
const GENERATION_TIMEOUT_MS = 240_000;

// ============================================================
// 类型（报告 schema）
// ============================================================

export type LiveErrorKind =
  | "timeout"
  | "rate_limit"
  | "auth"
  | "model_output_invalid"
  | "runtime_setup"
  | "other";

export interface LiveErrorRecord {
  scope: string;
  kind: LiveErrorKind;
  detail: string;
  at: string;
}

export interface LiveProposalRecord {
  key: string;
  claim: string;
  quote: string;
  claimedFileName: string;
  /** 机械 ground truth（不经模型）：quote 归一化后逐字存在于所声称来源 */
  quoteInClaimedSource: boolean;
  /** 存在于语料某处但不在所声称来源（张冠李戴） */
  quoteInAnySource: boolean;
  /** Arm B：管道处置（Arm A 不进管道，缺省） */
  disposition?:
    | "verified"
    | "quote_mismatch"
    | "metadata_mismatch"
    | "judge_rejected"
    | "unverifiable"
    | "unanchorable";
  statusReason?: string;
  judgeVerdict?: string;
}

export interface LiveArmMetrics {
  proposals: number;
  /** 自报捏造率：quote 不在所声称来源（Arm A/B 生成质量，同口径可比） */
  fabricatedQuoteRate: number;
  /** 张冠李戴率：quote 在语料中但不在所声称来源 */
  misattributedQuoteRate: number;
  /** Arm B only：管道处置计数 */
  dispositions?: Record<string, number>;
  /** Arm B only：机械判定的捏造提案被管道拦下（未 verified）的比例 */
  fabricatedInterceptedRate?: number;
  /** Arm B only：最终转正率 */
  verifiedRate?: number;
}

export interface LiveUsageDelta {
  runs: number;
  runsWithUsage: number;
  inputTokens: number;
  outputTokens: number;
  assistantTurns: number;
}

export interface LiveArmResult {
  arm: "plain-llm-live" | "paperteam-live";
  /** 本臂真实模型调用次数（生成 + judge） */
  modelCalls: number;
  metrics: LiveArmMetrics;
  proposals: LiveProposalRecord[];
  /**
   * 模型拒答 / 未给出任何有效提案（返回空列表或纯文本说明）。
   * 这不是失败：对齐良好的模型在无库条件下拒绝编造引文是合法测量结果。
   */
  refused?: boolean;
  /** 拒答时的原始输出节选（排障与审计） */
  refusalNote?: string;
  /** 生成任务 usage（来自任务终态） */
  generationUsage?: AgentTask["usage"];
  /** Arm B：groundPending 期间 judge 调用的 usage 增量（runtimeStats 差分） */
  judgeUsage?: LiveUsageDelta;
  /** 臂级失败（真实 API/系统失败：timeout / rate_limit / auth 等） */
  error?: LiveErrorRecord;
}

export interface LiveScenarioResult {
  scenarioId: string;
  title: string;
  arms: LiveArmResult[];
}

export interface LiveExp1Report {
  schemaVersion: 1;
  kind: "live-evaluation";
  milestone: "M6.9.1";
  experiment: 1;
  name: "evidence-grounding-live";
  model: {
    spec: string;
    provider: string;
    modelId: string;
    source: LiveRuntimeHandle["specSource"];
  };
  runtimeProvider: "pi";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  scenarios: LiveScenarioResult[];
  aggregate: {
    plainLlm: LiveArmMetrics;
    paperteam: LiveArmMetrics;
  };
  errors: LiveErrorRecord[];
  limitations: string[];
}

// ============================================================
// Prompt 与解析
// ============================================================

function corpusLine(source: GroundingCorpusSource): string {
  const authors = source.authors !== undefined ? source.authors.join("; ") : "（未知）";
  return `- fileName: ${source.fileName} | title: ${source.title} | authors: ${authors} | year: ${source.year}`;
}

function buildArmAPrompt(scenario: GroundingScenario): string {
  return [
    "你是学术综述写作助手，现在为一个综述章节收集证据。你手边没有文献库可检索（无库基线条件——本任务度量的正是这种工作方式的行为特征）。",
    `请基于你对「${scenario.title}」这一领域的了解，起草 ${PROPOSALS_PER_ARM} 条研究论断，并为每条配上你认为最可能出自对应文献的原文引文。`,
    "",
    "要求：",
    "1. 不要使用任何工具读取文件；题录信息视为给定事实（包括年份）；",
    "2. claim：中文一句话，具体到可核验（方法 / 数字 / 结论），不要空泛；",
    "3. quote：英文原句形式的引文；",
    "4. fileName：从题录列表中选择一个来源文件；",
    '5. 只输出一个 JSON 对象（无围栏、无解释）：{"proposals": [{"claim": "...", "quote": "...", "fileName": "..."}]}',
    "",
    `【综述主题】${scenario.title}`,
    "",
    "【文献题录】",
    ...scenario.corpus.map(corpusLine),
  ].join("\n");
}

function buildArmBPrompt(scenario: GroundingScenario): string {
  const blocks = scenario.corpus.map(
    (source) => `===== fileName: ${source.fileName} | title: ${source.title} =====\n${source.content}\n=====`,
  );
  return [
    "你是 PaperTeam 的 Researcher。项目文献库全文已在下方完整给出（无需读取任何文件），请基于全文提出证据提案。",
    "",
    "要求：",
    `1. 共 ${PROPOSALS_PER_ARM} 条；claim 用中文一句话，具体到可核验（方法 / 数字 / 结论）；`,
    "2. quote 逐字复制自对应来源正文的连续片段（不可改写、翻译或跨句拼接），长度不少于 15 个字符；",
    "3. fileName 填 quote 所在的来源文件；",
    '4. 只输出一个 JSON 对象（无围栏、无解释）：{"proposals": [{"claim": "...", "quote": "...", "fileName": "..."}]}',
    "",
    `【项目主题】${scenario.title}`,
    "",
    "【文献库全文】",
    ...blocks,
  ].join("\n");
}

interface RawProposal {
  claim: string;
  quote: string;
  fileName: string;
}

function parseProposals(raw: string): RawProposal[] {
  const parsed = extractJsonObject(raw, "live 证据提案");
  const list = parsed.proposals;
  if (!Array.isArray(list)) {
    throw new Error("输出 JSON 缺少 proposals 数组");
  }
  const proposals: RawProposal[] = [];
  for (const item of list.slice(0, PROPOSALS_PER_ARM)) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const claim = typeof record.claim === "string" ? record.claim.trim() : "";
    const quote = typeof record.quote === "string" ? record.quote.trim() : "";
    const fileName = typeof record.fileName === "string" ? record.fileName.trim() : "";
    if (claim !== "" && quote !== "" && fileName !== "") {
      proposals.push({ claim, quote, fileName });
    }
  }
  if (proposals.length === 0) {
    throw new Error("proposals 为空或无有效条目（claim/quote/fileName 需为非空字符串）");
  }
  return proposals;
}

// ============================================================
// 错误分类（不修改实验逻辑，只如实记录）
// ============================================================

export function classifyLiveError(error: unknown): { kind: LiveErrorKind; detail: string } {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (
    /timeout|timed[_ ]?out|超时|agent_timeout|EXECUTION_TIMEOUT|SESSION_TIMEOUT|INIT_TIMEOUT|QUEUE_TIMEOUT/i.test(
      message,
    )
  ) {
    return { kind: "timeout", detail: message };
  }
  if (/429|rate.?limit|too many requests|限流|配额|quota/i.test(message)) {
    return { kind: "rate_limit", detail: message };
  }
  if (/401|403|unauthorized|forbidden|api.?key|credential|鉴权|凭据/i.test(message)) {
    return { kind: "auth", detail: message };
  }
  return { kind: "other", detail: message };
}

function classifyTaskFailure(task: AgentTask): { kind: LiveErrorKind; detail: string } {
  const detail =
    `任务终态 ${task.status}${task.error !== undefined ? `：${task.error}` : ""}` +
    (task.errorCode !== undefined ? `（errorCode=${task.errorCode}）` : "");
  if (task.status === "timed_out") {
    return { kind: "timeout", detail };
  }
  const classified = classifyLiveError(task.error ?? "");
  if (classified.kind !== "other") {
    return { kind: classified.kind, detail };
  }
  return { kind: "other", detail };
}

class LiveGenerationError extends Error {
  readonly kind: LiveErrorKind;
  constructor(kind: LiveErrorKind, detail: string) {
    super(detail);
    this.name = "LiveGenerationError";
    this.kind = kind;
  }
}

// ============================================================
// 机械 ground truth 核验（确定性，不经模型）
// ============================================================

function quoteInText(quote: string, text: string): boolean {
  const needle = normalizeForQuoteMatch(quote);
  return needle !== "" && normalizeForQuoteMatch(text).includes(needle);
}

function mechanicalCheck(
  proposal: RawProposal,
  corpus: readonly GroundingCorpusSource[],
): { quoteInClaimedSource: boolean; quoteInAnySource: boolean } {
  const claimed = corpus.find((source) => source.fileName === proposal.fileName);
  return {
    quoteInClaimedSource: claimed !== undefined && quoteInText(proposal.quote, claimed.content),
    quoteInAnySource: corpus.some((source) => quoteInText(proposal.quote, source.content)),
  };
}

// ============================================================
// 生成调用（真实模型；AgentRuntime 唯一入口）
// ============================================================

async function generateProposals(options: {
  runtime: AgentRuntime;
  projectId: string;
  armScope: "arm-a" | "arm-b";
  prompt: string;
}): Promise<{
  proposals: RawProposal[];
  usage?: AgentTask["usage"];
  /** 模型拒答 / 零有效提案时的原始输出节选 */
  refusalNote?: string;
}> {
  const task = await options.runtime.runAgent({
    agentId: "researcher",
    projectId: options.projectId,
    contextScope: `research/evaluation-live/${options.armScope}`,
    task: options.prompt,
    timeoutMs: GENERATION_TIMEOUT_MS,
    metadata: { evaluation: "m6.9.1-live", arm: options.armScope },
  });
  if (task.status !== "completed") {
    const classified = classifyTaskFailure(task);
    throw new LiveGenerationError(classified.kind, `${classified.detail}（taskId=${task.taskId}）`);
  }
  const rawExcerpt = (task.output ?? "").replace(/\s+/g, " ").slice(0, 600);
  let proposals: RawProposal[];
  try {
    proposals = parseProposals(task.output ?? "");
  } catch (error) {
    // 无 JSON / 纯文本说明（典型：对齐良好的模型拒绝编造引文）→ 拒答结果
    return {
      proposals: [],
      refusalNote: `${error instanceof Error ? error.message : String(error)}（taskId=${task.taskId}；raw="${rawExcerpt}"）`,
    };
  }
  if (proposals.length === 0) {
    return {
      proposals: [],
      refusalNote: `模型返回了 JSON 但无有效提案（taskId=${task.taskId}；raw="${rawExcerpt}"）`,
    };
  }
  return { proposals, ...(task.usage !== undefined ? { usage: task.usage } : {}) };
}

function armError(scope: string, kind: LiveErrorKind, detail: string): LiveErrorRecord {
  return { scope, kind, detail, at: new Date().toISOString() };
}

// ============================================================
// Arm A：plain LLM baseline
// ============================================================

async function runArmA(options: {
  scenario: GroundingScenario;
  live: LiveRuntimeHandle;
  log: (message: string) => void;
}): Promise<LiveArmResult> {
  const { scenario, live, log } = options;
  const harness = await createGroundingHarness(scenario);
  try {
    const generated = await generateProposals({
      runtime: live.runtime,
      projectId: harness.projectId,
      armScope: "arm-a",
      prompt: buildArmAPrompt(scenario),
    });
    if (generated.refusalNote !== undefined) {
      log(`[live-exp1] ${scenario.id}/plain-llm-live：模型拒答（无库条件下拒绝编造引文）`);
      return refusedArm("plain-llm-live", generated);
    }
    const proposals: LiveProposalRecord[] = [];
    for (const [index, proposal] of generated.proposals.entries()) {
      const check = mechanicalCheck(proposal, scenario.corpus);
      // 无库无核验：自报内容原样入池（unverified——legacy 存储形态）
      await harness.evidence.append(
        harness.projectId,
        {
          claim: proposal.claim,
          quote: proposal.quote,
          verificationStatus: "unverified",
          verificationMethod: "live/plain-llm 自报（无核验，真实模型）",
        },
        "evaluation:live-plain-llm",
      );
      proposals.push({
        key: `a-${index + 1}`,
        claim: proposal.claim,
        quote: proposal.quote,
        claimedFileName: proposal.fileName,
        quoteInClaimedSource: check.quoteInClaimedSource,
        quoteInAnySource: check.quoteInAnySource,
      });
    }
    return {
      arm: "plain-llm-live",
      modelCalls: 1,
      metrics: armGenerationMetrics(proposals),
      proposals,
      ...(generated.usage !== undefined ? { generationUsage: generated.usage } : {}),
    };
  } catch (error) {
    const classified =
      error instanceof LiveGenerationError
        ? { kind: error.kind, detail: error.message }
        : classifyLiveError(error);
    return emptyArm("plain-llm-live", armError(`${scenario.id}/plain-llm-live`, classified.kind, classified.detail));
  } finally {
    await harness.cleanup();
  }
}

function armGenerationMetrics(proposals: LiveProposalRecord[]): LiveArmMetrics {
  const total = proposals.length;
  const fabricated = proposals.filter((item) => !item.quoteInClaimedSource).length;
  const misattributed = proposals.filter((item) => item.quoteInAnySource && !item.quoteInClaimedSource).length;
  return {
    proposals: total,
    fabricatedQuoteRate: total > 0 ? fabricated / total : 0,
    misattributedQuoteRate: total > 0 ? misattributed / total : 0,
  };
}

function emptyArm(arm: "plain-llm-live" | "paperteam-live", error: LiveErrorRecord): LiveArmResult {
  return {
    arm,
    modelCalls: 0,
    metrics: { proposals: 0, fabricatedQuoteRate: 0, misattributedQuoteRate: 0 },
    proposals: [],
    error,
  };
}

/** 模型拒答：合法测量结果（不是 error），原样保留 usage 与原始输出节选 */
function refusedArm(
  arm: "plain-llm-live" | "paperteam-live",
  generated: { usage?: AgentTask["usage"]; refusalNote?: string },
): LiveArmResult {
  return {
    arm,
    modelCalls: 1,
    metrics: { proposals: 0, fabricatedQuoteRate: 0, misattributedQuoteRate: 0 },
    proposals: [],
    refused: true,
    refusalNote: generated.refusalNote ?? "",
    ...(generated.usage !== undefined ? { generationUsage: generated.usage } : {}),
  };
}

// ============================================================
// Arm B：PaperTeam Evidence Pipeline（真实 judge）
// ============================================================

interface UsageSnapshot {
  runs: number;
  runsWithUsage: number;
  inputTokens: number;
  outputTokens: number;
  assistantTurns: number;
}

function usageSnapshotOf(runtime: AgentRuntime): UsageSnapshot | undefined {
  const totals = runtime.runtimeStats?.().usageTotals;
  return totals;
}

function usageDelta(before: UsageSnapshot | undefined, after: UsageSnapshot | undefined): LiveUsageDelta | undefined {
  if (before === undefined || after === undefined) {
    return undefined;
  }
  return {
    runs: after.runs - before.runs,
    runsWithUsage: after.runsWithUsage - before.runsWithUsage,
    inputTokens: after.inputTokens - before.inputTokens,
    outputTokens: after.outputTokens - before.outputTokens,
    assistantTurns: after.assistantTurns - before.assistantTurns,
  };
}

async function runArmB(options: {
  scenario: GroundingScenario;
  live: LiveRuntimeHandle;
  log: (message: string) => void;
}): Promise<LiveArmResult> {
  const { scenario, live, log } = options;
  // 真实 judge 注入：Stage 3 用产品 prompt + 真实模型；metadata 仍由数据集
  // ground-truth scholarly provider 裁决（该阶段不是 LLM 环节，口径不变）
  const harness = await createGroundingHarness(scenario, { judgeRuntime: live.runtime });
  try {
    const fileNameToSourceId = await harness.addCorpus(scenario.corpus);
    const generated = await generateProposals({
      runtime: live.runtime,
      projectId: harness.projectId,
      armScope: "arm-b",
      prompt: buildArmBPrompt(scenario),
    });
    if (generated.refusalNote !== undefined) {
      log(`[live-exp1] ${scenario.id}/paperteam-live：模型拒答（全文在 prompt 内仍拒答——异常，详见报告）`);
      return refusedArm("paperteam-live", generated);
    }

    // 锚点解析：claimed fileName → sourceId；quote 命中 chunk → 该 chunk；
    // 未命中 → 该来源第一个 chunk（Stage 1 将以 quote_not_found_in_chunk 拦截）
    const sourceIdToChunks = new Map<string, Array<{ chunkId: string; text: string }>>();
    const anchor = async (fileName: string, quote: string): Promise<{ sourceId: string; chunkId: string } | undefined> => {
      const sourceId = fileNameToSourceId.get(fileName);
      if (sourceId === undefined) {
        return undefined;
      }
      let chunks = sourceIdToChunks.get(sourceId);
      if (chunks === undefined) {
        await harness.retrieval.search(harness.projectId, fileName, { topK: 1 });
        const read = (await harness.chunkStore.readChunks(harness.projectId, sourceId)) ?? [];
        chunks = read.map((chunk) => ({ chunkId: chunk.chunkId, text: chunk.text }));
        sourceIdToChunks.set(sourceId, chunks);
      }
      if (chunks.length === 0) {
        return undefined;
      }
      const needle = normalizeForQuoteMatch(quote);
      const hit =
        needle !== ""
          ? chunks.find((chunk) => normalizeForQuoteMatch(chunk.text).includes(needle))
          : undefined;
      return { sourceId, chunkId: (hit ?? chunks[0]!).chunkId };
    };

    const proposals: LiveProposalRecord[] = [];
    const keyToCandidate = new Map<string, string>();
    for (const [index, proposal] of generated.proposals.entries()) {
      const check = mechanicalCheck(proposal, scenario.corpus);
      const record: LiveProposalRecord = {
        key: `b-${index + 1}`,
        claim: proposal.claim,
        quote: proposal.quote,
        claimedFileName: proposal.fileName,
        quoteInClaimedSource: check.quoteInClaimedSource,
        quoteInAnySource: check.quoteInAnySource,
      };
      const anchorResult = await anchor(proposal.fileName, proposal.quote);
      if (anchorResult === undefined) {
        // 声称的来源文件不存在（或来源无 chunk）：无法进管道，如实记录
        record.disposition = "unanchorable";
        record.statusReason = `claimed fileName 不在语料中：${proposal.fileName}`;
        proposals.push(record);
        continue;
      }
      const { candidate } = await harness.grounding.propose(harness.projectId, {
        sourceId: anchorResult.sourceId,
        chunkId: anchorResult.chunkId,
        claim: proposal.claim,
        quote: proposal.quote,
        proposedBy: "evaluation:live-paperteam",
      });
      keyToCandidate.set(record.key, candidate.candidateId);
      proposals.push(record);
    }

    const judgeUsageBefore = usageSnapshotOf(live.runtime);
    const summary = await harness.grounding.groundPending(harness.projectId);
    const judgeUsage = usageDelta(judgeUsageBefore, usageSnapshotOf(live.runtime));
    const byCandidate = new Map(summary.results.map((result) => [result.candidateId, result]));
    for (const record of proposals) {
      const candidateId = keyToCandidate.get(record.key);
      const result = candidateId !== undefined ? byCandidate.get(candidateId) : undefined;
      if (result === undefined) {
        if (record.disposition === undefined) {
          record.disposition = "unverifiable";
          record.statusReason = "候选未进入核验批次（评估断言失败，如实上报）";
        }
        continue;
      }
      if (result.status === "verified") {
        record.disposition = "verified";
      } else if (result.status === "mismatch") {
        record.disposition = (result.reason ?? "").includes("metadata_mismatch")
          ? "metadata_mismatch"
          : "quote_mismatch";
      } else if (result.status === "rejected") {
        record.disposition = "judge_rejected";
        if (result.judgeVerdict !== undefined) {
          record.judgeVerdict = result.judgeVerdict;
        }
      } else {
        record.disposition = "unverifiable";
      }
      record.statusReason = result.reason;
      log(`[live-exp1] ${scenario.id}/${record.key} → ${record.disposition}（${result.reason ?? "-"}）`);
    }

    return {
      arm: "paperteam-live",
      modelCalls: 1 + summary.processed, // 生成 1 次 + 批内候选数（仅通过 Stage 1/2 的候选实际调用 judge）
      metrics: armPipelineMetrics(proposals),
      proposals,
      ...(generated.usage !== undefined ? { generationUsage: generated.usage } : {}),
      ...(judgeUsage !== undefined ? { judgeUsage } : {}),
    };
  } catch (error) {
    const classified =
      error instanceof LiveGenerationError
        ? { kind: error.kind, detail: error.message }
        : classifyLiveError(error);
    return emptyArm("paperteam-live", armError(`${scenario.id}/paperteam-live`, classified.kind, classified.detail));
  } finally {
    await harness.cleanup();
  }
}

function armPipelineMetrics(proposals: LiveProposalRecord[]): LiveArmMetrics {
  const base = armGenerationMetrics(proposals);
  const dispositions: Record<string, number> = {};
  for (const record of proposals) {
    const key = record.disposition ?? "unknown";
    dispositions[key] = (dispositions[key] ?? 0) + 1;
  }
  const pipelined = proposals.filter((item) => item.disposition !== "unanchorable");
  const fabricated = pipelined.filter((item) => !item.quoteInClaimedSource);
  const fabricatedIntercepted = fabricated.filter((item) => item.disposition !== "verified").length;
  const verified = pipelined.filter((item) => item.disposition === "verified").length;
  return {
    ...base,
    dispositions,
    fabricatedInterceptedRate: fabricated.length > 0 ? fabricatedIntercepted / fabricated.length : 0,
    verifiedRate: pipelined.length > 0 ? verified / pipelined.length : 0,
  };
}

// ============================================================
// 汇总与报告
// ============================================================

function aggregateArms(arms: LiveArmResult[], arm: "plain-llm-live" | "paperteam-live"): LiveArmMetrics {
  const records = arms.filter((entry) => entry.arm === arm).flatMap((entry) => entry.proposals);
  if (arm === "plain-llm-live") {
    return armGenerationMetrics(records);
  }
  return armPipelineMetrics(records);
}

function modelTagOf(modelId: string): string {
  return modelId.replace(/[^a-z0-9]+/gi, "").toLowerCase();
}

export function liveReportMarkdown(report: LiveExp1Report): string {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const lines: string[] = [
    `# Live Evaluation — Exp1 Evidence Grounding（${report.milestone}）`,
    "",
    `- model: \`${report.model.spec}\`（provider \`${report.model.provider}\`，来源 ${report.model.source}）`,
    `- runtime: ${report.runtimeProvider}（PiRuntimeAdapter，无新增调用链）`,
    `- run: ${report.startedAt} → ${report.finishedAt}（${Math.round(report.durationMs / 1000)}s）`,
    `- errors: ${report.errors.length}`,
    "",
    "| scenario | arm | proposals | fabricated | misattributed | intercepted | verified |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const scenario of report.scenarios) {
    for (const arm of scenario.arms) {
      lines.push(
        `| ${scenario.scenarioId} | ${arm.arm} | ${arm.refused === true ? "**拒答**" : arm.metrics.proposals} | ` +
          `${arm.refused === true ? "-" : pct(arm.metrics.fabricatedQuoteRate)} | ` +
          `${arm.refused === true ? "-" : pct(arm.metrics.misattributedQuoteRate)} | ` +
          `${arm.metrics.fabricatedInterceptedRate !== undefined ? pct(arm.metrics.fabricatedInterceptedRate) : "-"} | ` +
          `${arm.metrics.verifiedRate !== undefined ? pct(arm.metrics.verifiedRate) : "-"} |`,
      );
    }
  }
  lines.push(
    `| **aggregate** | plain-llm-live | ${report.aggregate.plainLlm.proposals} | ` +
      `${pct(report.aggregate.plainLlm.fabricatedQuoteRate)} | ${pct(report.aggregate.plainLlm.misattributedQuoteRate)} | - | - |`,
    `| **aggregate** | paperteam-live | ${report.aggregate.paperteam.proposals} | ` +
      `${pct(report.aggregate.paperteam.fabricatedQuoteRate)} | ${pct(report.aggregate.paperteam.misattributedQuoteRate)} | ` +
      `${pct(report.aggregate.paperteam.fabricatedInterceptedRate ?? 0)} | ${pct(report.aggregate.paperteam.verifiedRate ?? 0)} |`,
    "",
  );
  if (report.errors.length > 0) {
    lines.push("## Errors", "");
    for (const error of report.errors) {
      lines.push(`- \`${error.kind}\` @ ${error.scope}：${error.detail}`);
    }
    lines.push("");
  }
  const refused = report.scenarios.flatMap((entry) => entry.arms).filter((arm) => arm.refused === true);
  if (refused.length > 0) {
    lines.push("## 模型拒答（合法测量结果，非 error）", "");
    for (const arm of refused) {
      lines.push(`- ${arm.arm}：${(arm.refusalNote ?? "").slice(0, 300)}`);
    }
    lines.push("");
  }
  lines.push("## Limitations", "");
  for (const item of report.limitations) {
    lines.push(`- ${item}`);
  }
  return lines.join("\n");
}

export async function writeLiveExp1Report(
  report: LiveExp1Report,
  outDir: string,
): Promise<{ jsonPath: string; markdownPath: string }> {
  await mkdir(outDir, { recursive: true });
  const base = `live-${modelTagOf(report.model.modelId)}-exp1`;
  const jsonPath = join(outDir, `${base}.json`);
  const markdownPath = join(outDir, `${base}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, liveReportMarkdown(report), "utf8");
  return { jsonPath, markdownPath };
}

// ============================================================
// 入口
// ============================================================

export interface LiveRunOutcome {
  report: LiveExp1Report;
  written: { jsonPath: string; markdownPath: string };
  /** 臂级失败存在时为 true（CLI 据此设非零退出码；提案级失败不算） */
  hasArmFailures: boolean;
}

export async function runLiveExperiment1(options: {
  scenarios: readonly GroundingScenario[];
  modelSpec?: string;
  out: string;
  log?: (message: string) => void;
}): Promise<LiveRunOutcome> {
  const log = options.log ?? (() => {});
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  log(
    `[live-eval] M6.9.1 真实模型评估开始（${options.scenarios.length} 场景 × 2 臂，model=${options.modelSpec ?? "(产品解析链)"}）`,
  );
  const live = await createLiveEvaluationRuntimeInternal(options);
  const errors: LiveErrorRecord[] = [];
  const scenarioResults: LiveScenarioResult[] = [];
  try {
    for (const scenario of options.scenarios) {
      log(`[live-exp1] ${scenario.id}：plain-llm-live 臂（真实模型自报）`);
      const armA = await runArmA({ scenario, live, log });
      if (armA.error !== undefined) {
        errors.push(armA.error);
      }
      log(`[live-exp1] ${scenario.id}：paperteam-live 臂（全文提案 + 真实 judge 三段核验）`);
      const armB = await runArmB({ scenario, live, log });
      if (armB.error !== undefined) {
        errors.push(armB.error);
      }
      scenarioResults.push({ scenarioId: scenario.id, title: scenario.title, arms: [armA, armB] });
    }
  } finally {
    await live.close();
  }
  const allArms = scenarioResults.flatMap((entry) => entry.arms);
  const report: LiveExp1Report = {
    schemaVersion: 1,
    kind: "live-evaluation",
    milestone: "M6.9.1",
    experiment: 1,
    name: "evidence-grounding-live",
    model: {
      spec: live.modelSpec,
      provider: live.provider,
      modelId: live.modelId,
      source: live.specSource,
    },
    runtimeProvider: "pi",
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    scenarios: scenarioResults,
    aggregate: {
      plainLlm: aggregateArms(allArms, "plain-llm-live"),
      paperteam: aggregateArms(allArms, "paperteam-live"),
    },
    errors,
    limitations: [
      "首轮 plumbing 冒烟：样本小（每臂 ≤5 提案）、单场景起步，指标不具统计效力",
      "judge 与生成同用 GLM-5.3（同模型自评偏差；正式实验应引入异模型 judge）",
      "对齐良好的模型可能在无库条件下拒绝编造引文（refused 结果）——这是合法测量结果，此时 plain-llm 基线的捏造率不可测（分母为 0），不应解读为 0%",
      "metadata 核验的权威记录是数据集内置 ground-truth provider（与 M6.8 scripted 同口径），不是真实 Crossref/OpenAlex",
      "Arm B 锚点规则：quote 命中 chunk 用该 chunk，未命中落到来源首个 chunk（Stage 1 拦截）；chunk 边界截断可能造成误拦（报告保留逐条机械判定供审计）",
      "quote 机械核验与产品 Stage 1 同用 normalizeForQuoteMatch 归一化口径（大小写/空白不敏感）",
    ],
  };
  const written = await writeLiveExp1Report(report, options.out);
  log(`[live-eval] 报告已写入：${written.jsonPath}`);
  log(`[live-eval] 摘要已写入：${written.markdownPath}`);
  return { report, written, hasArmFailures: errors.length > 0 };
}

// 延迟 import 避免 CLI（scripted 路径）加载真实 Runtime 相关模块
async function createLiveEvaluationRuntimeInternal(options: {
  modelSpec?: string;
  log?: (message: string) => void;
}): Promise<LiveRuntimeHandle> {
  const { createLiveEvaluationRuntime } = await import("../liveRuntime.js");
  return createLiveEvaluationRuntime({
    ...(options.modelSpec !== undefined ? { modelSpec: options.modelSpec } : {}),
    ...(options.log !== undefined ? { log: options.log } : {}),
  });
}
