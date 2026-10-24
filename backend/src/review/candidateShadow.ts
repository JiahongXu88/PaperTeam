/**
 * M15.4.3（P1）CandidateProposer Shadow 旁路：在正常 Review 的 claim-audit 账本构建完成后，
 * 消费已产出的 Reviewer claim（quote / 定位 span / claimValue / check），为有界子集逐条运行
 * CandidateProposer（模型提案 + 确定性核验），产出独立的 candidate-shadow/v1 对照产物。
 *
 * 边界（任务书 §六）：
 *  - 默认 OFF（PAPERTEAM_CANDIDATE_SHADOW=off|on）；OFF = 零额外模型调用、零产物、零行为差异；
 *  - 不改 Review prompt、不重跑 Reviewer、不造新 claim；无可用 claim → NO_CLAIMS / NOT_EVALUATED；
 *  - 每轮 ≤4 claim、每 claim ≤2 次调用（1 提案 + 仅解析失败重试）、整轮硬上限 8 调用、并发 1（顺序）；
 *  - 模型调用经 ReviewerService.proposeClaimCandidate（Pi runtime sealed 通道，复用排队 / 超时 / 取消）；
 *  - 请求身份 = sha256(projectId|round|claimId|documentFingerprint|quoteSha|claimValue|prompt/adapter 版本|model)：
 *    同身份 terminal 结果复用（resume / 重试不重付）；输入变更（文档 / 引文 / 值 / 协议版本）→ 新身份重跑；
 *  - 只提出候选与映射见证：verifyProposal.ACCEPTED ≠ Claim Certificate 的 VERIFIED_*，不签发
 *    claim-certificate/v1，不进入 Quality Gate / Finding / HITL / 终态 / Review 评分；
 *  - 影子失败只记 FAILED / SKIPPED 状态，绝不影响主审稿（调用方对整体异常另行兜底）。
 */

import { createHash } from "node:crypto";
import type { ClaimAuditArtifact, ReviewClaimRecord } from "./claimAudit.js";
import { buildCertificateDocument, locateAtom, bindTextAtom, type CertificateDocument } from "./claimCertificate.js";
import { parseNumbers } from "./claimAuditText.js";
import {
  buildTableAllowlist, buildProposerPrompt, parseProposerResponse, resolveProposal, verifyProposal,
  PROPOSER_PROMPT_VERSION, PROPOSER_ADAPTER_VERSION, type MappingWitness, type ProposalVerification, type RawProposal, type ResolvedCell,
} from "./candidateProposer.js";

export const CANDIDATE_SHADOW_SCHEMA = "candidate-shadow/v1";
export const CANDIDATE_SHADOW_KIND = "candidate-shadow" as const;
export const CANDIDATE_SHADOW_OBSERVER = "candidate-shadow-observer/v1";

export const CANDIDATE_SHADOW_LIMITS = { maxClaims: 4, maxAttemptsPerClaim: 2, maxCallsPerRun: 8 } as const;

/** 论断句上下文窗口（字符；claim 句两侧，供回指 / 指代语境） */
const CONTEXT_CHARS = 600;

export type ShadowClaimStatus = "EVALUATED" | "REUSED" | "SKIPPED" | "FAILED";

export interface ShadowRuleBaseline {
  atomLocated: boolean;
  atomLocateReason?: string;
  bindingStatus: "UNIQUE" | "AMBIGUOUS" | "UNBOUND" | "NOT_RUN";
  bindingRule?: string;
  boundCell?: { file: string; tableId: string; row: number; col: number };
}

export interface ShadowClaimEntry {
  claimId: string;
  requestId: string;
  status: ShadowClaimStatus;
  /** EVALUATED/REUSED：提案→核验全链；SKIPPED/FAILED：原因（无论文原文） */
  skipReason?: "NO_CLAIMS" | "NOT_EVALUATED" | "CLAIM_VALUE_UNPARSEABLE" | "BUDGET_EXHAUSTED" | "DOCUMENT_MISSING" | "ERROR";
  error?: string;
  selection: { order: number; reviewerCheck: string; hadCertificate: boolean };
  claim: { file: string; start: number; end: number; claimValue: string };
  promptChars?: number;
  attempts?: number;
  proposalEcho?: { subject: string; metric: string; dataset: string; conditions: string[]; comparison: string; abstainReason?: string; topCandidate: { tableAlias: string; rowAlias: string; colAlias: string } | null; resolvedCell: ResolvedCell | null };
  parseError?: string | null;
  verification?: ProposalVerification;
  /** 规则基线（零模型）：同一 atom 上 bindTextAtom 的结果，供协议对照 */
  ruleBaseline?: ShadowRuleBaseline;
  witness?: MappingWitness;
  trace?: { taskId?: string; promptSha256?: string; model?: string };
  usage?: { calls: number; inputTokens?: number; outputTokens?: number; durationMs: number };
}

export interface CandidateShadowArtifact {
  schema: typeof CANDIDATE_SHADOW_SCHEMA;
  observer: typeof CANDIDATE_SHADOW_OBSERVER;
  generatedAt: string;
  projectId: string;
  round: number;
  revision: number | null;
  documentFingerprint: string;
  promptVersion: typeof PROPOSER_PROMPT_VERSION;
  adapterVersion: typeof PROPOSER_ADAPTER_VERSION;
  limits: { maxClaims: number; maxAttemptsPerClaim: number; maxCallsPerRun: number };
  /** SHADOW_ONLY 声明：本产物不进入任何生产 Gate / Finding / HITL / 评分 */
  authority: "SHADOW_OBSERVATION_ONLY";
  status: "COMPLETED" | "PARTIAL" | "SKIPPED" | "FAILED";
  statusReason?: string;
  claims: ShadowClaimEntry[];
  summary: {
    claimsInLedger: number;
    eligible: number;
    selected: number;
    evaluated: number;
    reused: number;
    skipped: number;
    failed: number;
    accepted: number;
    acceptedSupported: number;
    acceptedContradicted: number;
    abstained: number;
    calls: number;
    inputTokens?: number;
    outputTokens?: number;
    durationMs: number;
  };
}

export interface CandidateShadowServices {
  /** ReviewerService.proposeClaimCandidate（sealed 单 claim 提案调用） */
  proposeClaimCandidate: (params: { projectId: string; prompt: string; sessionLabel: string; signal?: AbortSignal }) => Promise<{ text: string; taskId: string; promptSha256: string; model?: string; usage?: Record<string, unknown> }>;
}

export interface CandidateShadowInput {
  projectId: string;
  round: number;
  revision: number | null;
  documentFingerprint: string;
  claimAudit: ClaimAuditArtifact;
  certificateFiles: ReadonlyArray<{ file: string; content: string }>;
  signal?: AbortSignal;
  now?: () => Date;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

function numericClaimValue(value: string | undefined): { raw: string; value: number } | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = parseNumbers(value)[0];
  if (parsed === undefined) return null;
  return { raw: value.trim(), value: parsed.value };
}

/**
 * 确定性选取：账本中「已定位 + 审稿模型已给出 CONSISTENT/INCONSISTENT 双钥匙结论 + claimValue 可解析」
 * 的论断，按（未出具证书优先 → claimId 字典序）取前 N 条。选择只降不升：不满足条件的论断记入落选数。
 */
export function selectShadowClaims(claimAudit: ClaimAuditArtifact, maxClaims: number): { selected: Array<{ record: ReviewClaimRecord; order: number }>; eligible: number } {
  const eligible = claimAudit.claims.filter((record) =>
    record.location.start !== null && record.location.end !== null
    && (record.reviewer.check === "CONSISTENT" || record.reviewer.check === "INCONSISTENT")
    && numericClaimValue(record.reviewer.claimValue) !== null);
  const ordered = [...eligible].sort((a, b) => {
    const certA = a.certificate !== undefined && a.certificate.outcome !== "NOT_CERTIFIED" ? 1 : 0;
    const certB = b.certificate !== undefined && b.certificate.outcome !== "NOT_CERTIFIED" ? 1 : 0;
    if (certA !== certB) return certA - certB;
    return a.claimId < b.claimId ? -1 : 1;
  });
  return { selected: ordered.slice(0, maxClaims).map((record, index) => ({ record, order: index + 1 })), eligible: eligible.length };
}

function ruleBaselineOf(document: CertificateDocument, claim: { file: string; start: number; end: number; claimValue: string }): ShadowRuleBaseline {
  const located = locateAtom(document, claim.file, claim.start, claim.end, claim.claimValue);
  if (located.atom === null) return { atomLocated: false, atomLocateReason: located.reason ?? "unknown", bindingStatus: "NOT_RUN" };
  const binding = bindTextAtom(document, located.atom);
  return {
    atomLocated: true,
    bindingStatus: binding.status,
    ...(binding.rule !== "" ? { bindingRule: binding.rule } : {}),
    ...(binding.bound !== undefined ? { boundCell: { file: binding.bound.file, tableId: binding.bound.tableId, row: binding.bound.row, col: binding.bound.col } } : {}),
  };
}

function echoOf(raw: RawProposal | null, top: ResolvedCell | null): ShadowClaimEntry["proposalEcho"] | undefined {
  if (raw === null) return undefined;
  return {
    subject: raw.subject, metric: raw.metric, dataset: raw.dataset, conditions: raw.conditions, comparison: raw.comparison,
    ...(raw.abstain !== undefined ? { abstainReason: raw.abstain.reason } : {}),
    topCandidate: raw.candidates[0] === undefined ? null : { tableAlias: raw.candidates[0].tableAlias, rowAlias: raw.candidates[0].rowAlias, colAlias: raw.candidates[0].colAlias },
    resolvedCell: top,
  };
}

function usageOf(calls: Array<{ inputTokens?: number; outputTokens?: number } | undefined>, durationMs: number): ShadowClaimEntry["usage"] {
  const usage: ShadowClaimEntry["usage"] = { calls: calls.length, durationMs };
  const inputTokens = calls.reduce((sum, call) => sum + (call?.inputTokens ?? 0), 0);
  const outputTokens = calls.reduce((sum, call) => sum + (call?.outputTokens ?? 0), 0);
  if (inputTokens > 0) usage.inputTokens = inputTokens;
  if (outputTokens > 0) usage.outputTokens = outputTokens;
  return usage;
}

/**
 * Shadow 主入口（调用方已确认开关为 on）。全链失败隔离：单 claim 异常 → FAILED 条目；
 * 整体异常由调用方兜底记录（本函数对非取消异常尽量返回 PARTIAL/FAILED 产物而非上抛）。
 * 已存在的同请求身份 terminal 条目直接复用（resume / 重试零额外调用）。
 */
export async function runCandidateShadowStage(
  input: CandidateShadowInput,
  services: CandidateShadowServices,
  previous: CandidateShadowArtifact | null,
  limits: { maxClaims?: number; maxAttemptsPerClaim?: number; maxCallsPerRun?: number } = {},
): Promise<CandidateShadowArtifact> {
  const maxClaims = limits.maxClaims ?? CANDIDATE_SHADOW_LIMITS.maxClaims;
  const maxAttemptsPerClaim = limits.maxAttemptsPerClaim ?? CANDIDATE_SHADOW_LIMITS.maxAttemptsPerClaim;
  const maxCallsPerRun = limits.maxCallsPerRun ?? CANDIDATE_SHADOW_LIMITS.maxCallsPerRun;
  const startedAt = Date.now();
  const now = input.now ?? (() => new Date());
  const artifact: CandidateShadowArtifact = {
    schema: CANDIDATE_SHADOW_SCHEMA,
    observer: CANDIDATE_SHADOW_OBSERVER,
    generatedAt: now().toISOString(),
    projectId: input.projectId,
    round: input.round,
    revision: input.revision,
    documentFingerprint: input.documentFingerprint,
    promptVersion: PROPOSER_PROMPT_VERSION,
    adapterVersion: PROPOSER_ADAPTER_VERSION,
    limits: { maxClaims, maxAttemptsPerClaim, maxCallsPerRun },
    authority: "SHADOW_OBSERVATION_ONLY",
    status: "SKIPPED",
    claims: [],
    summary: {
      claimsInLedger: input.claimAudit.claims.length, eligible: 0, selected: 0, evaluated: 0, reused: 0, skipped: 0, failed: 0,
      accepted: 0, acceptedSupported: 0, acceptedContradicted: 0, abstained: 0, calls: 0, durationMs: 0,
    },
  };
  if (input.claimAudit.claims.length === 0) {
    artifact.statusReason = "NO_CLAIMS：claim-audit 账本无论断（影子旁路无输入，NOT_EVALUATED）";
    return artifact;
  }
  const { selected, eligible } = selectShadowClaims(input.claimAudit, maxClaims);
  artifact.summary.eligible = eligible;
  if (selected.length === 0) {
    artifact.statusReason = "NOT_EVALUATED：无可选论断（无已定位 + 双钥匙结论 + 可解析 claimValue 的条目）";
    return artifact;
  }
  artifact.summary.selected = selected.length;
  const document = buildCertificateDocument(input.certificateFiles.map((file) => ({ file: file.file, content: file.content })));
  const fileOf = (name: string) => document.files.find((file) => file.file === name);
  let callsUsed = 0;
  for (const { record, order } of selected) {
    if (callsUsed >= maxCallsPerRun) {
      artifact.claims.push({
        claimId: record.claimId, requestId: "", status: "SKIPPED", skipReason: "BUDGET_EXHAUSTED",
        selection: { order, reviewerCheck: record.reviewer.check ?? "", hadCertificate: record.certificate !== undefined },
        claim: { file: record.file, start: record.location.start ?? 0, end: record.location.end ?? 0, claimValue: record.reviewer.claimValue ?? "" },
      });
      artifact.summary.skipped += 1;
      continue;
    }
    const value = numericClaimValue(record.reviewer.claimValue)!;
    const requestId = sha256([input.projectId, input.round, record.claimId, input.documentFingerprint, record.quoteSha256, value.raw, PROPOSER_PROMPT_VERSION, PROPOSER_ADAPTER_VERSION].join("|"));
    const entry: ShadowClaimEntry = {
      claimId: record.claimId,
      requestId,
      status: "EVALUATED",
      selection: { order, reviewerCheck: record.reviewer.check ?? "", hadCertificate: record.certificate !== undefined },
      claim: { file: record.file, start: record.location.start ?? 0, end: record.location.end ?? 0, claimValue: value.raw },
    };
    const reused = previous?.claims.find((candidate) => candidate.requestId === requestId && (candidate.status === "EVALUATED" || candidate.status === "REUSED"));
    if (reused !== undefined) {
      artifact.claims.push({ ...reused, status: "REUSED", selection: entry.selection });
      artifact.summary.reused += 1;
      callsUsed += reused.usage?.calls ?? 0;
      continue;
    }
    const file = fileOf(record.file);
    if (file === undefined) {
      artifact.claims.push({ ...entry, status: "SKIPPED", skipReason: "DOCUMENT_MISSING" });
      artifact.summary.skipped += 1;
      continue;
    }
    try {
      const claimSpanStart = record.location.start!;
      const claimSpanEnd = record.location.end!;
      const claimSentence = record.quote;
      const contextBefore = file.content.slice(Math.max(0, claimSpanStart - CONTEXT_CHARS), claimSpanStart);
      const contextAfter = file.content.slice(claimSpanEnd, Math.min(file.content.length, claimSpanEnd + CONTEXT_CHARS));
      const allowlist = buildTableAllowlist(document);
      const basePrompt = buildProposerPrompt(
        { claimId: record.claimId, file: record.file, claimSentence, contextBefore, contextAfter, claimValue: value.raw },
        allowlist,
        document.ownTerms.join(" ") || "(untitled)",
      );
      const claimStartedAt = Date.now();
      const callUsages: Array<{ inputTokens?: number; outputTokens?: number } | undefined> = [];
      let raw: RawProposal | null = null;
      let parseError: string | null = null;
      let trace: ShadowClaimEntry["trace"] | undefined;
      let attempts = 0;
      for (let attempt = 1; attempt <= maxAttemptsPerClaim && callsUsed < maxCallsPerRun; attempt += 1) {
        attempts = attempt;
        callsUsed += 1;
        const response = await services.proposeClaimCandidate({
          projectId: input.projectId,
          prompt: attempt > 1 ? `${basePrompt}\n\nYour previous reply was not valid JSON for this schema. Reply again with STRICT JSON only.` : basePrompt,
          sessionLabel: `r${input.round}-${record.claimId}-a${attempt}`,
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        });
        trace = { taskId: response.taskId, promptSha256: response.promptSha256, ...(response.model !== undefined ? { model: response.model } : {}) };
        const usage = response.usage as { inputTokens?: number; outputTokens?: number } | undefined;
        callUsages.push(usage);
        const parsed = parseProposerResponse(response.text);
        raw = parsed.proposal;
        parseError = parsed.error;
        if (raw !== null) break;
      }
      const resolved = raw === null ? null : resolveProposal(document, raw, allowlist);
      const validTop = resolved?.candidates.find((candidate) => candidate.status === "RESOLVED" && candidate.cell !== undefined);
      const verification = resolved === null ? null : verifyProposal({
        document,
        claim: { file: record.file, start: claimSpanStart, end: claimSpanEnd, value: value.raw },
        resolved,
      });
      artifact.claims.push({
        ...entry,
        promptChars: basePrompt.length,
        attempts,
        proposalEcho: echoOf(raw, validTop?.cell ?? null),
        parseError,
        ...(verification !== null ? { verification } : {}),
        ...(verification?.status === "ACCEPTED" ? { witness: verification.witness } : {}),
        ruleBaseline: ruleBaselineOf(document, { file: record.file, start: claimSpanStart, end: claimSpanEnd, claimValue: value.raw }),
        ...(trace !== undefined ? { trace } : {}),
        usage: usageOf(callUsages, Date.now() - claimStartedAt),
      });
      artifact.summary.evaluated += 1;
    } catch (error) {
      if (input.signal?.aborted) throw error;
      artifact.claims.push({
        ...entry,
        status: "FAILED",
        skipReason: "ERROR",
        error: `${error instanceof Error ? error.constructor.name : "Error"}: ${(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 160)}`,
      });
      artifact.summary.failed += 1;
    }
  }
  const evaluatedEntries = artifact.claims.filter((entry) => entry.status === "EVALUATED" || entry.status === "REUSED");
  artifact.summary.accepted = evaluatedEntries.filter((entry) => entry.verification?.status === "ACCEPTED").length;
  artifact.summary.acceptedSupported = evaluatedEntries.filter((entry) => entry.verification?.status === "ACCEPTED" && entry.verification.outcome === "SUPPORTED").length;
  artifact.summary.acceptedContradicted = evaluatedEntries.filter((entry) => entry.verification?.status === "ACCEPTED" && entry.verification.outcome === "CONTRADICTED").length;
  artifact.summary.abstained = evaluatedEntries.filter((entry) => entry.verification?.status === "ABSTAIN").length;
  artifact.summary.calls = artifact.claims.reduce((sum, entry) => sum + (entry.usage?.calls ?? 0), 0);
  const inputTokens = artifact.claims.reduce((sum, entry) => sum + (entry.usage?.inputTokens ?? 0), 0);
  const outputTokens = artifact.claims.reduce((sum, entry) => sum + (entry.usage?.outputTokens ?? 0), 0);
  if (inputTokens > 0) artifact.summary.inputTokens = inputTokens;
  if (outputTokens > 0) artifact.summary.outputTokens = outputTokens;
  artifact.summary.durationMs = Date.now() - startedAt;
  artifact.status = artifact.summary.failed > 0 ? "PARTIAL" : "COMPLETED";
  artifact.generatedAt = now().toISOString();
  return artifact;
}
