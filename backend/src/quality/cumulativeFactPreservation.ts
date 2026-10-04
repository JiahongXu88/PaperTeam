/**
 * Cumulative Fact Preservation（M10.3.1 G1：累计事实保持）。
 *
 * M10.3 真实 E2E 暴露的漂移「洗白」路径：
 *   rev-2 引入未授权事实改写（λ_smooth 段）→ gate r2 的 pairwise
 *   Fact Preservation（previous → current）正确标记 → 但后续轮次 Writer
 *   把 rev-2 当作既有稿件，rev-3…rev-10 不再触碰该段 → 每轮 pairwise
 *   （rev-N → rev-N+1）都 clean → 最终稿相对冻结基线的累计漂移从未被
 *   任何 gate 规则呈现。
 *
 * 修复原则（任务 §4-§6）：事实裁决依据永远是
 *   Frozen Baseline（导入时的 rev-1，reason=baseline）
 *     + Approved ImprovementPlanItems（含 expectedFactChanges）
 *     + Evidence authorized values
 *     → Expected Fact State → vs Current Manuscript
 *
 * - unresolvedViolations 由 Frozen → Current 得出（不是 Previous → Current）；
 * - 任何历史未解决的 unauthorized drift 跨轮保持 unresolved——不能因为
 *   下一轮没继续改它就「洗白」；
 * - 只有两条出路：(A) 当前稿恢复冻结基线值；(B) 已批准计划（expectedFactChanges
 *   / 条目文本点名）或 Evidence 明确授权新值；
 * - 授权台账（research/fact-authorizations.json）append-only：hitl.plan_confirm
 *   approve 时把改进计划条目固化登记——后续 run 覆盖 improvement-plan.json 也
 *   不丢失已授予的授权（漂移判定不因计划文件被覆盖而误报）。
 *
 * 诚实边界：与 pairwise Fact Preservation 同源的保守必要条件守卫；授权匹配
 * 复用同一套确定性规则（mentionsValue / 归一化），不做语义等价证明。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { FactFinding, FactPreservationSummary, FactTexFile } from "./factPreservation.js";
import { evaluateFactPreservation } from "./factPreservation.js";
import { readSnapshotTex } from "./citationPreservation.js";
import type { EvidenceStore } from "../evidence/EvidenceStore.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { ManuscriptRevisionStore } from "../manuscript/RevisionStore.js";
import type { ReviewArtifactStore } from "../review/reviewArtifacts.js";
import { writeJsonAtomic } from "../util/atomic.js";

// ---- 授权台账（append-only） ----

export interface ExpectedFactChange {
  before: string;
  after: string;
  basis?: string;
}

/**
 * 台账条目：一次已批准的改进计划条目（授权事实 = 条目文本 + expectedFactChanges）。
 * M11.2.1：授权来源扩展两类 typed weakening（Reviewer Finding → Revision Plan /
 * Claim Grounding UNSUPPORTED），经 authorizationKind 走独立的类型化核验通道，
 * 不进 improvementTexts 通用授权（防「弱化授权点名过的数值」反向洗白重加）。
 */
export interface FactAuthorizationEntry {
  recordedAt: string;
  /** 批准来源（M11.2.1 前唯一通道：hitl.plan_confirm approve） */
  source: "improvement_plan_approved" | "revision_plan_weakening" | "claim_grounding_unsupported";
  runId?: string;
  /** improvement-plan 条目的稳定标识（improvement:{index}；同轮重复登记按 id+文本去重） */
  itemId: string;
  section: string;
  /** 授权文本（action + rationale + expectedFactChanges 渲染；与 pairwise 授权同口径） */
  text: string;
  expectedFactChanges?: ExpectedFactChange[];
  relatedEvidenceIds?: string[];
  instructionId?: string;
  /** M11.2.1 typed weakening：类型（存在即走类型化通道，text 即 targetSpan） */
  authorizationKind?: "weaken_claim_strength" | "remove_unsupported_detail" | "remove_claim";
  /** targetSpan 追溯（finding / claim 原文指纹；findingId / claimId 二选一） */
  findingId?: string;
  claimId?: string;
  /** 创建轮次（review round；审计追溯） */
  round?: number;
  /** 授权理由（人读；来自派生函数） */
  reason?: string;
}

export interface FactAuthorizationLedger {
  schemaVersion: 1;
  entries: FactAuthorizationEntry[];
}

export const FACT_AUTHORIZATIONS_FILE = "fact-authorizations.json";

function ledgerPath(projects: ProjectStore, projectId: string): string {
  return join(projects.researchDir(projectId), FACT_AUTHORIZATIONS_FILE);
}

/** 读取授权台账（缺失 / 损坏 → 空台账，防御性） */
export async function readFactAuthorizations(
  projects: ProjectStore,
  projectId: string,
): Promise<FactAuthorizationEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(ledgerPath(projects, projectId), "utf8")) as {
      entries?: unknown;
    };
    return Array.isArray(parsed.entries)
      ? (parsed.entries as FactAuthorizationEntry[]).filter(
          (entry) => typeof entry === "object" && entry !== null && typeof entry.itemId === "string",
        )
      : [];
  } catch {
    return [];
  }
}

/** 追加授权（append-only；按 itemId+文本指纹幂等去重，重复 approve 不膨胀） */
export async function appendFactAuthorizations(
  projects: ProjectStore,
  projectId: string,
  entries: FactAuthorizationEntry[],
): Promise<number> {
  if (entries.length === 0) {
    return 0;
  }
  const existing = await readFactAuthorizations(projects, projectId);
  const seen = new Set(existing.map((entry) => entryFingerprint(entry)));
  const added: FactAuthorizationEntry[] = [];
  for (const entry of entries) {
    const fingerprint = entryFingerprint(entry);
    if (!seen.has(fingerprint)) {
      seen.add(fingerprint);
      added.push(entry);
    }
  }
  if (added.length === 0) {
    return 0;
  }
  const ledger: FactAuthorizationLedger = {
    schemaVersion: 1,
    entries: [...existing, ...added],
  };
  await mkdir(projects.researchDir(projectId), { recursive: true });
  await writeJsonAtomic(ledgerPath(projects, projectId), ledger);
  return added.length;
}

function entryFingerprint(entry: FactAuthorizationEntry): string {
  return createHash("sha256")
    .update(`${entry.itemId}|${entry.section}|${entry.text}|${entry.authorizationKind ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * M11.2.1：台账中的 typed weakening 条目 → Fact Preservation 类型化输入口径。
 * 与 improvement 通道互斥（见 ledgerToImprovementItems 的过滤）。
 */
export function readWeakeningAuthorizations(
  projects: ProjectStore,
  projectId: string,
): Promise<import("../review/weakeningAuthorization.js").WeakeningAuthorizationInput[]> {
  return readFactAuthorizations(projects, projectId).then((entries) =>
    entries
      .filter((entry) => entry.authorizationKind !== undefined)
      .map((entry) => ({
        kind: entry.authorizationKind as NonNullable<FactAuthorizationEntry["authorizationKind"]>,
        section: entry.section,
        targetSpan: entry.text,
        itemId: entry.itemId,
        ...(entry.findingId !== undefined ? { findingId: entry.findingId } : {}),
        ...(entry.claimId !== undefined ? { claimId: entry.claimId } : {}),
        ...(entry.round !== undefined ? { round: entry.round } : {}),
        ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
      })),
  );
}

/**
 * M11.2.1：typed weakening 授权入账（append-only；与 appendFactAuthorizations
 * 同指纹幂等去重）。调用点 = revision.plan 落盘后（计划条目 + 同轮 claim
 * grounding 的确定性派生）。
 */
export async function appendWeakeningAuthorizations(
  projects: ProjectStore,
  projectId: string,
  authorizations: readonly import("../review/weakeningAuthorization.js").WeakeningAuthorizationInput[],
  options: { runId?: string; now?: string } = {},
): Promise<number> {
  if (authorizations.length === 0) {
    return 0;
  }
  const now = options.now ?? new Date().toISOString();
  const entries: FactAuthorizationEntry[] = authorizations.map((authorization) => ({
    recordedAt: now,
    source: authorization.claimId !== undefined ? "claim_grounding_unsupported" : "revision_plan_weakening",
    ...(options.runId !== undefined ? { runId: options.runId } : {}),
    itemId: `${authorization.kind}:${authorization.itemId}`,
    section: authorization.section,
    text: authorization.targetSpan,
    authorizationKind: authorization.kind,
    ...(authorization.findingId !== undefined ? { findingId: authorization.findingId } : {}),
    ...(authorization.claimId !== undefined ? { claimId: authorization.claimId } : {}),
    ...(authorization.round !== undefined ? { round: authorization.round } : {}),
    ...(authorization.reason !== undefined ? { reason: authorization.reason } : {}),
  }));
  return appendFactAuthorizations(projects, projectId, entries);
}

/** 台账 → evaluateFactPreservation 的 improvementPlanItems 输入口径（与 pairwise 同构） */
function ledgerToImprovementItems(
  entries: readonly FactAuthorizationEntry[],
): { section: string; action: string; rationale?: string }[] {
  return entries
    // M11.2.1：typed weakening 走独立类型化通道——其 targetSpan 点名过的数值若
    // 进入通用授权，会被 valueAdditionAuthorized 反向放行（弱化删除过的值重新
    // 加回 = 洗白）。类型化通道只放行「弱化 / 删除」两个方向。
    .filter((entry) => entry.authorizationKind === undefined)
    .map((entry) => ({
    section: entry.section,
    action: entry.text,
    ...(entry.expectedFactChanges !== undefined && entry.expectedFactChanges.length > 0
      ? {
          rationale: [
            entry.text,
            ...entry.expectedFactChanges.map(
              (change) =>
                `${change.before} → ${change.after}${change.basis !== undefined ? `（依据：${change.basis}）` : ""}`,
            ),
          ].join("\n"),
        }
      : {}),
  }));
}


/**
 * M10.3.1：当前 manuscript bib key 清单（bib-keyed 方法论行授权通道；
 * 与 pairwise 的 readBibliographyKeys 同口径）。
 */
async function readBibliographyKeys(
  projects: ProjectStore,
  projectId: string,
): Promise<string[]> {
  const { readFile } = await import("node:fs/promises");
  for (const name of ["references.bib", "refs.bib"]) {
    try {
      const raw = await readFile(join(projects.manuscriptDir(projectId), name), "utf8");
      return [...raw.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)].map((match) => match[1] ?? "");
    } catch {
      // 尝试下一个名字
    }
  }
  return [];
}

// ---- 累计校验 ----

/** 违规的稳定指纹（跨轮跟踪同一漂移；文本不变则指纹不变） */
export function cumulativeViolationKey(finding: FactFinding): string {
  return createHash("sha256")
    .update(`${finding.file}|${finding.reason}|${finding.before}|${finding.after}`)
    .digest("hex")
    .slice(0, 16);
}

export interface CumulativeFactValidation {
  /** 全部违规桶为空（Frozen → Current 无未授权漂移） */
  ok: boolean;
  /** 冻结基线修订号（reason=baseline 的最早修订） */
  baselineRevision: number;
  currentRevision: number;
  /** Frozen → Current 的未授权违规（跨轮 carry-forward；不为空 → Final 阻断） */
  unresolvedViolations: (FactFinding & { violationKey: string })[];
  /** 历史上出现过、当前已消失（恢复基线或获授权）的违规（审计轨迹） */
  resolvedViolations: { violationKey: string; file: string; reason: string; before: string; after: string }[];
  /** 有授权被放行的变更数（台账 / Evidence 口径） */
  authorizedChanges: number;
  authorizedRemovals: number;
  /** M11.2.1：typed weakening（类别核验通过）放行的弱化数 */
  authorizedWeakenings: number;
  formatChanges: number;
  /** 授权来源统计（审计：台账几条 / 证据几条） */
  authorizationSources: { ledgerEntries: number; evidenceRecords: number };
}

export interface CumulativeFactDeps {
  projects: ProjectStore;
  revisions: ManuscriptRevisionStore;
  reviewArtifacts: ReviewArtifactStore;
  evidence: EvidenceStore;
}

/**
 * 冻结基线修订的判定：
 * - existing_paper 工作流：最早修订（rev-1）即导入冻结稿——导入链路的首个修订
 *   由 review.snapshot 幂等提交（M10.3 真实项目实测），reason 不一定是 baseline；
 * - 其它（idea_to_paper）：只认显式 reason=baseline（手动构建路径）——首稿是
 *   Writer 自己的输出，不构成「冻结导入基线」，累计口径不适用（中性 null）。
 */
export function findFrozenBaselineRevision(
  revisions: readonly { revision: number; reason: string }[],
  existingPaper: boolean,
): { revision: number; reason: string } | undefined {
  const ordered = [...revisions].sort((a, b) => a.revision - b.revision);
  if (existingPaper) {
    return ordered[0];
  }
  return ordered.find((record) => record.reason === "baseline");
}

/**
 * 累计事实校验（Frozen Baseline → reviewedRevision）。
 * 返回 null = 不可比较（无冻结基线 / 快照缺失）——
 * idea_to_paper 项目（rev-1 是首稿而非冻结导入稿）天然 null，规则中性。
 */
export async function computeCumulativeFactPreservation(
  deps: CumulativeFactDeps,
  projectId: string,
  reviewedRevision: number | undefined,
  options: { existingPaper?: boolean } = {},
): Promise<CumulativeFactValidation | null> {
  const state = await deps.revisions.load(projectId);
  const baseline = findFrozenBaselineRevision(state.revisions, options.existingPaper === true);
  if (baseline === undefined) {
    return null; // 无冻结基线：累计口径不适用
  }
  const current =
    typeof reviewedRevision === "number" && reviewedRevision > 0
      ? reviewedRevision
      : state.current;
  if (current <= baseline.revision) {
    return null; // 尚未产生基线之后的修订
  }
  if (!state.revisions.some((record) => record.revision === current)) {
    return null;
  }
  const [baselineFiles, currentFiles] = await Promise.all([
    readSnapshotTex(deps.revisions.snapshotDir(projectId, baseline.revision)),
    readSnapshotTex(deps.revisions.snapshotDir(projectId, current)),
  ]);
  if (baselineFiles === null || currentFiles === null || baselineFiles.length === 0) {
    return null; // 快照缺失：如实不可比较
  }
  const ledger = await readFactAuthorizations(deps.projects, projectId);
  const evidenceRecords = await deps.evidence.list(projectId);
  const evidenceTexts = evidenceRecords.flatMap((record) => [
    record.claim,
    record.summary ?? "",
    record.quote ?? "",
  ]);
  // 授权只认：已批准改进计划台账 + Evidence。reviews/revision-plan 的
  // fact_preserve 条目是恢复指令（其 problem 文本包含 before → after 片段），
  // 绝不进入累计授权——否则漂移会被「要求恢复它的计划」洗白。
  const bibliographyKeys = await readBibliographyKeys(deps.projects, projectId);
  // M11.2.1：typed weakening 走独立通道（弱化 / 删除方向 + 类别核验），与
  // improvement 通用授权互斥（见 ledgerToImprovementItems 过滤）
  const weakeningEntries = ledger
    .filter((entry) => entry.authorizationKind !== undefined)
    .map((entry) => ({
      kind: entry.authorizationKind as NonNullable<FactAuthorizationEntry["authorizationKind"]>,
      section: entry.section,
      targetSpan: entry.text,
      itemId: entry.itemId,
      ...(entry.findingId !== undefined ? { findingId: entry.findingId } : {}),
      ...(entry.claimId !== undefined ? { claimId: entry.claimId } : {}),
      ...(entry.round !== undefined ? { round: entry.round } : {}),
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    }));
  const summary: FactPreservationSummary = evaluateFactPreservation({
    previous: { revision: baseline.revision, files: baselineFiles as FactTexFile[] },
    current: { revision: current, files: currentFiles as FactTexFile[] },
    plan: null,
    improvementPlanItems: ledgerToImprovementItems(ledger),
    evidenceTexts,
    ...(bibliographyKeys.length > 0 ? { bibliographyKeys } : {}),
    weakeningAuthorizations: weakeningEntries,
  });
  const unresolved = [
    ...summary.changedFacts,
    ...summary.removedFacts,
    ...summary.addedUnsupportedFacts,
    ...summary.directionalChanges,
    ...summary.formulaChanges,
    ...summary.placeholderRegressions,
  ].map((finding) => ({ ...finding, violationKey: cumulativeViolationKey(finding) }));
  // resolved = 历史任何一轮 gate 记录过、本轮已消失（恢复基线或获授权）
  const currentKeys = new Set(unresolved.map((finding) => finding.violationKey));
  const historicalKeys = await collectHistoricalViolationKeys(deps, projectId, baseline.revision);
  const resolvedViolations = [...historicalKeys.entries()]
    .filter(([key]) => !currentKeys.has(key))
    .map(([key, finding]) => ({
      violationKey: key,
      file: finding.file,
      reason: finding.reason,
      before: finding.before,
      after: finding.after,
    }));
  return {
    ok: unresolved.length === 0,
    baselineRevision: baseline.revision,
    currentRevision: current,
    unresolvedViolations: unresolved,
    resolvedViolations,
    authorizedChanges: summary.allowedChanges,
    authorizedRemovals: summary.allowedRemovals,
    authorizedWeakenings: summary.allowedWeakenings,
    formatChanges: summary.formatChanges.length,
    authorizationSources: {
      ledgerEntries: ledger.length,
      evidenceRecords: evidenceRecords.length,
    },
  };
}

/** 历史各轮 gate 产物中登记过的累计违规（key → 代表性 finding） */
async function collectHistoricalViolationKeys(
  deps: CumulativeFactDeps,
  projectId: string,
  _baselineRevision: number,
): Promise<Map<string, { file: string; reason: string; before: string; after: string }>> {
  const map = new Map<string, { file: string; reason: string; before: string; after: string }>();
  for (const round of await deps.reviewArtifacts.gateRounds(projectId)) {
    const artifact = await deps.reviewArtifacts.loadGate(projectId, round);
    const cumulative = artifact?.cumulativeFactPreservation;
    if (cumulative === null || cumulative === undefined) {
      continue;
    }
    for (const finding of (cumulative as CumulativeFactValidation).unresolvedViolations ?? []) {
      map.set(finding.violationKey, {
        file: finding.file,
        reason: finding.reason,
        before: finding.before,
        after: finding.after,
      });
    }
  }
  return map;
}

/** Gate 规则 detail（有界样本） */
export function describeCumulativeFactPreservation(validation: CumulativeFactValidation): string {
  const base = `冻结基线 rev-${validation.baselineRevision}→rev-${validation.currentRevision}`;
  if (validation.ok) {
    return `${base} 累计事实保持通过（授权变更 ${validation.authorizedChanges} 项 / 授权删除 ${validation.authorizedRemovals} 项 / 格式等价 ${validation.formatChanges} 项；授权来源：计划台账 ${validation.authorizationSources.ledgerEntries} 条 + 证据 ${validation.authorizationSources.evidenceRecords} 条；历史违规已解决 ${validation.resolvedViolations.length} 项）`;
  }
  const sample = validation.unresolvedViolations
    .slice(0, 3)
    .map((finding) => `${finding.reason}：${finding.before}${finding.after !== "" ? ` → ${finding.after}` : "（被删除）"}`)
    .join("；");
  return `${base} 累计事实保持失败：未授权漂移 ${validation.unresolvedViolations.length} 项跨轮未解决（如 ${sample.slice(0, 140)}）——须恢复冻结基线值，或以已批准计划 / Evidence 授权新值`;
}

/**
 * improvement-plan.json（已批准当轮）→ 台账条目（确定性渲染；调用点 =
 * hitl.plan_confirm approve）。expectedFactChanges 与条目文本一并入账。
 */
export async function recordImprovementPlanApproval(
  projects: ProjectStore,
  projectId: string,
  runId: string | undefined,
  now = new Date().toISOString(),
): Promise<number> {
  let parsed: {
    plan?: {
      items?: {
        section?: unknown;
        action?: unknown;
        rationale?: unknown;
        expectedFactChanges?: unknown;
        relatedEvidenceIds?: unknown;
        instructionId?: unknown;
      }[];
    };
  };
  try {
    parsed = JSON.parse(
      await readFile(join(projects.researchDir(projectId), "improvement-plan.json"), "utf8"),
    );
  } catch {
    return 0; // 计划文件不可读：无授权可登记（如实）
  }
  const entries: FactAuthorizationEntry[] = [];
  for (const [index, item] of (parsed.plan?.items ?? []).entries()) {
    if (typeof item.section !== "string" || typeof item.action !== "string") {
      continue;
    }
    const expected = Array.isArray(item.expectedFactChanges)
      ? (item.expectedFactChanges as unknown[]).filter(
          (change): change is ExpectedFactChange =>
            typeof change === "object" &&
            change !== null &&
            typeof (change as Record<string, unknown>)["before"] === "string" &&
            typeof (change as Record<string, unknown>)["after"] === "string",
        )
      : [];
    const text = [
      item.action,
      typeof item.rationale === "string" ? item.rationale : "",
      ...expected.map(
        (change) =>
          `${change.before} → ${change.after}${change.basis !== undefined ? `（依据：${change.basis}）` : ""}`,
      ),
    ]
      .filter((part) => part !== "")
      .join("\n");
    entries.push({
      recordedAt: now,
      source: "improvement_plan_approved",
      ...(runId !== undefined ? { runId } : {}),
      itemId: `improvement:${index + 1}`,
      section: item.section,
      text,
      ...(expected.length > 0 ? { expectedFactChanges: expected } : {}),
      ...(Array.isArray(item.relatedEvidenceIds) &&
      (item.relatedEvidenceIds as unknown[]).every((id) => typeof id === "string")
        ? { relatedEvidenceIds: item.relatedEvidenceIds as string[] }
        : {}),
      ...(typeof item.instructionId === "string" ? { instructionId: item.instructionId } : {}),
    });
  }
  return appendFactAuthorizations(projects, projectId, entries);
}
