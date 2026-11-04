/**
 * M17.1：review.run 内的默认风格审查调度（每个 Review Unit 一次 sealed 调用；不改动学术单元审稿）。
 *
 * 覆盖纪律（与 coverageLedger 同口径：账本而非模型自述）：
 *   - 每个计划单元恰有一条记录：COMPLETE（本轮执行）/ REUSED（同内容同政策版本的往轮完成结果）/ FAILED（重试后仍失败，
 *     含非法 JSON、缺 styleFindings、超时）/ SKIPPED_BUDGET（模型预算或本轮调用上限）/ NOT_APPLICABLE（纯标题 / 非中文正文）。
 *   - 空 styleFindings 只在调用成功且结构合法时才代表「已审查、未发现问题」。
 *   - 失败不抛出、不影响学术审稿与覆盖率；只在风格覆盖状态中如实呈现（PARTIAL / FAILED）。
 *
 * 跨轮复用：单元内容哈希 + 政策版本相同即复用（finding 原样带 lineage.reusedFromRound）——修订后的复审只对改动单元
 * 重新审查，不会对未改动文本反复产生新建议。
 */

import { randomUUID } from "node:crypto";

import {
  ACADEMIC_STYLE_POLICY_VERSION,
  ACADEMIC_STYLE_REPORT_SCHEMA,
  STYLE_AUDIT_DISCLAIMER,
  classifyStyleFinding,
  computeStyleRevisionClosure,
  countStyleFindings,
  countUnaddressedCandidates,
  isChineseText,
  scanStyleCandidates,
  summarizeStyleAuditCoverage,
  type ParsedUnitStyleAudit,
  type StyleAuditReport,
  type StyleAuditUnitRecord,
  type StyleCandidate,
  type StyleFinding,
  type StyleRevisionRecord,
} from "./academicStyleAudit.js";
import { mapWithConcurrency } from "../util/concurrency.js";

export interface StyleAuditUnitInput {
  unitId: string;
  file: string;
  /** 章节 span id（finding 的 logicalSection） */
  spanId: string;
  heading: string;
  unitIndex: number;
  unitCount: number;
  chars: number;
  contentHash: string;
  text: string;
}

export interface StyleAuditCallResult {
  parsed: ParsedUnitStyleAudit;
  taskId: string;
  promptSha256: string;
  model?: string;
  usage?: Record<string, unknown>;
}

export interface RunStyleAuditInput {
  projectId: string;
  round: number;
  reviewedRevision?: number;
  paperTitle?: string;
  /** 项目声明的稿件语言；en = 中文风格审查不适用（如实 NOT_APPLICABLE） */
  language?: "zh" | "en";
  units: readonly StyleAuditUnitInput[];
  /** 纯标题单元判定（与学术单元审稿同一谓词，由 workflow 注入） */
  isHeadingOnly: (text: string) => boolean;
  /** 诊断开关关闭时的原因（只用于开发 / 故障排查；状态 DISABLED 可见，不冒充已审） */
  disabledReason?: string;
  /** 整轮不适用（如第三方已发表论文只读评估）：全部单元 NOT_APPLICABLE，原因可见 */
  notApplicableReason?: string;
  previous: StyleAuditReport | null;
  previousRevision: StyleRevisionRecord | null;
  callAudit: (input: { unit: StyleAuditUnitInput; candidates: readonly StyleCandidate[]; sessionLabel: string }) => Promise<StyleAuditCallResult>;
  /** 每次调用前的预算准入（false = SKIPPED_BUDGET） */
  admitCall: () => boolean;
  concurrency: number;
  /** 本轮风格审查调用上限（含重试） */
  maxCalls: number;
  attempts?: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

const DEFAULT_ATTEMPTS = 2;

export async function runAcademicStyleAudit(input: RunStyleAuditInput): Promise<StyleAuditReport> {
  const attemptsPerUnit = Math.max(1, input.attempts ?? DEFAULT_ATTEMPTS);
  const calls = { audit: 0, retries: 0, failures: 0 };
  const previousUnits = new Map<string, StyleAuditUnitRecord>();
  const previousFindings = new Map<string, StyleFinding[]>();
  if (input.previous !== null && input.previous.policyVersion === ACADEMIC_STYLE_POLICY_VERSION) {
    for (const unit of input.previous.units) {
      if (unit.status === "COMPLETE" || unit.status === "REUSED") previousUnits.set(unit.unitId, unit);
    }
    for (const finding of input.previous.findings) {
      previousFindings.set(finding.unitId, [...(previousFindings.get(finding.unitId) ?? []), finding]);
    }
  }
  const findings: StyleFinding[] = [];
  const unanchored: StyleAuditReport["unanchored"] = [];

  const base = (unit: StyleAuditUnitInput): Omit<StyleAuditUnitRecord, "status" | "attempts" | "findings" | "candidates"> => ({
    unitId: unit.unitId, file: unit.file, heading: unit.heading, chars: unit.chars, unitFingerprint: unit.contentHash,
  });

  const records = input.disabledReason !== undefined
    ? input.units.map((unit): StyleAuditUnitRecord => ({ ...base(unit), status: "SKIPPED_BUDGET", reason: input.disabledReason, attempts: 0, findings: 0, candidates: 0 }))
    : await (async () => {
        const outcomes = await mapWithConcurrency(input.units, Math.max(1, input.concurrency), async (unit): Promise<StyleAuditUnitRecord> => {
          if (input.notApplicableReason !== undefined) {
            return { ...base(unit), status: "NOT_APPLICABLE", reason: input.notApplicableReason, attempts: 0, findings: 0, candidates: 0 };
          }
          if (input.isHeadingOnly(unit.text)) {
            return { ...base(unit), status: "NOT_APPLICABLE", reason: "HEADING_ONLY（仅章节标题，无正文）", attempts: 0, findings: 0, candidates: 0 };
          }
          if (input.language === "en" || !isChineseText(unit.text)) {
            return { ...base(unit), status: "NOT_APPLICABLE", reason: input.language === "en" ? "LANGUAGE_EN（M17.1 风格审查政策为中文；英文稿件未审查）" : "NON_CHINESE_UNIT（单元正文非中文）", attempts: 0, findings: 0, candidates: 0 };
          }
          const prior = previousUnits.get(unit.unitId);
          if (prior !== undefined && prior.unitFingerprint === unit.contentHash) {
            const reused = (previousFindings.get(unit.unitId) ?? []).map((finding): StyleFinding => ({
              ...finding,
              revisionStatus: finding.disposition === "KEEP" ? "KEPT" : finding.disposition === "AUTHOR_DECISION" ? "AUTHOR_DECISION" : "NOT_DISPATCHED",
              lineage: { ...finding.lineage, round: input.round, reusedFromRound: finding.lineage.reusedFromRound ?? finding.lineage.round },
            }));
            findings.push(...reused);
            return {
              ...base(unit), status: "REUSED", attempts: 0, findings: reused.length, candidates: prior.candidates,
              reusedFromRound: prior.reusedFromRound ?? input.previous!.round,
              ...(prior.model !== undefined ? { model: prior.model } : {}),
            };
          }
          const candidates = scanStyleCandidates(unit.text);
          let lastError = "";
          let attempts = 0;
          for (let attempt = 1; attempt <= attemptsPerUnit; attempt += 1) {
            if (input.signal?.aborted === true) {
              return { ...base(unit), status: "FAILED", reason: "CANCELLED", attempts, findings: 0, candidates: candidates.length, error: "审稿已取消" };
            }
            if (calls.audit + calls.retries >= input.maxCalls || !input.admitCall()) {
              return {
                ...base(unit), status: "SKIPPED_BUDGET", attempts, findings: 0, candidates: candidates.length,
                reason: calls.audit + calls.retries >= input.maxCalls ? `本轮风格审查调用上限 ${input.maxCalls} 已用尽` : "模型预算不足（run 级预算耗尽或为必需审稿阶段预留）",
                ...(lastError !== "" ? { error: lastError } : {}),
              };
            }
            attempts = attempt;
            if (attempt === 1) calls.audit += 1;
            else calls.retries += 1;
            const startedAt = Date.now();
            try {
              const result = await input.callAudit({ unit, candidates, sessionLabel: `${unit.contentHash.slice(0, 12)}-r${input.round}-a${attempt}-${randomUUID().slice(0, 8)}` });
              const unitFindings = result.parsed.findings.map((raw) => classifyStyleFinding(raw, {
                unitId: unit.unitId, file: unit.file, logicalSection: unit.spanId, heading: unit.heading, unitText: unit.text,
                round: input.round, unitFingerprint: unit.contentHash, taskId: result.taskId, promptSha256: result.promptSha256,
                ...(result.model !== undefined ? { model: result.model } : {}),
              }));
              findings.push(...unitFindings);
              unanchored.push(...result.parsed.unanchored.map((entry) => ({ unitId: unit.unitId, ...entry })));
              return {
                ...base(unit), status: "COMPLETE", attempts, findings: unitFindings.length, candidates: candidates.length,
                candidatesUnaddressed: countUnaddressedCandidates(candidates, result.parsed.findings),
                ...(result.parsed.unanchored.length + result.parsed.truncated > 0 ? { droppedFindings: result.parsed.unanchored.length + result.parsed.truncated } : {}),
                taskId: result.taskId, promptSha256: result.promptSha256,
                ...(result.model !== undefined ? { model: result.model } : {}),
                ...(result.usage !== undefined ? { usage: result.usage } : {}),
                ms: Date.now() - startedAt,
              };
            } catch (error) {
              lastError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
              input.log?.(`[style-audit] ${unit.unitId} 第 ${attempt} 次失败：${lastError.slice(0, 160)}`);
            }
          }
          calls.failures += 1;
          return { ...base(unit), status: "FAILED", reason: "MODEL_CALL_OR_CONTRACT_FAILED", attempts, findings: 0, candidates: candidates.length, error: lastError };
        }, { ...(input.signal !== undefined ? { signal: input.signal } : {}) });
        return outcomes.map((outcome, index): StyleAuditUnitRecord => outcome.ok
          ? outcome.value
          : { ...base(input.units[index]!), status: "FAILED", reason: "CANCELLED_OR_SCHEDULER_ERROR", attempts: 0, findings: 0, candidates: 0, error: (outcome.error instanceof Error ? outcome.error.message : String(outcome.error)).slice(0, 300) });
      })();

  // 单元顺序稳定（并发完成顺序不影响产物）
  const unitOrder = new Map(input.units.map((unit, index) => [unit.unitId, index]));
  findings.sort((a, b) => (unitOrder.get(a.unitId) ?? 0) - (unitOrder.get(b.unitId) ?? 0));
  const coverage = summarizeStyleAuditCoverage(records, input.disabledReason);
  const textByFile = new Map<string, string>();
  for (const unit of input.units) textByFile.set(unit.file, `${textByFile.get(unit.file) ?? ""}\n${unit.text}`);
  const closure = input.previousRevision !== null && input.previousRevision.status === "applied"
    ? computeStyleRevisionClosure(input.previousRevision, (file) => textByFile.get(file), findings)
    : null;
  return {
    schemaVersion: ACADEMIC_STYLE_REPORT_SCHEMA,
    policyVersion: ACADEMIC_STYLE_POLICY_VERSION,
    projectId: input.projectId,
    round: input.round,
    ...(input.reviewedRevision !== undefined ? { reviewedRevision: input.reviewedRevision } : {}),
    generatedAt: new Date().toISOString(),
    coverage,
    units: records,
    findings,
    unanchored,
    counts: countStyleFindings(findings, unanchored.length),
    calls,
    ...(closure !== null && closure.items.length > 0 ? { previousRevisionClosure: closure } : {}),
    disclaimer: STYLE_AUDIT_DISCLAIMER,
  };
}
