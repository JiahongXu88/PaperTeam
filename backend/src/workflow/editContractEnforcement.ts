/**
 * M15.20 P0：修订写入的编辑契约执行层（workflow 侧胶水；判定本身在 quality/editContract.ts）。
 *
 * - resolveAuditRewriteContracts：派发前为已批准审计改写意见装载冻结契约；旧审批 / 契约缺失 / 批准后
 *   目标变化 / 不可执行 → 本轮不派发（fail closed）并如实写回指令状态。
 * - resolveImprovementContracts：plan_confirm 批准时冻结的改进计划条目契约（仅本 run、计划内容未变）。
 * - ValidatedWriteRegistry + guardedRevisionCommit：提交边界的纵深防御——工作树中任何相对上一修订的
 *   改动都必须恰好等于某条已通过契约校验的写入，否则恢复为上一修订内容；校验后以工作树指纹提交，
 *   校验与提交之间的改动（竞态）被 RevisionStore 拒绝。
 */

import { readFile, readdir, unlink } from "node:fs/promises";
import { join, relative } from "node:path";

import type { ProjectStore } from "../project/ProjectStore.js";
import type { ManuscriptRevisionStore } from "../manuscript/RevisionStore.js";
import { escapeAbstractPlainText } from "../manuscript/ManuscriptService.js";
import {
  buildEditContract,
  extractValueTokens,
  isContractFresh,
  preservingPolicyContract,
  sha256,
  systemRevisionPolicyContract,
  validateCandidateEdit,
  type EditContract,
  type EditContractVerdict,
} from "../quality/editContract.js";
import { recordEditContractEvents, type EditContractEvent, type EditContractStoreFile } from "../quality/editContractStore.js";
import { isApprovedAuditRewrite, type ExternalInstruction } from "../review/externalInstructions.js";
import { writeFileAtomic } from "../util/atomic.js";

export const ABSTRACT_TARGET = "abstract";

const normalizePath = (path: string): string => path.replaceAll("\\", "/").replace(/^\.\//, "");

/** 目标在冻结基线（最早修订快照）中的内容；无快照 / 新文件 → undefined（系统策略据此保护当前全部数值） */
export async function loadFrozenTargetContent(
  revisions: Pick<ManuscriptRevisionStore, "load" | "snapshotDir">,
  projectId: string,
): Promise<(target: string) => Promise<string | undefined>> {
  const state = await revisions.load(projectId);
  const frozen = [...state.revisions].sort((a, b) => a.revision - b.revision)[0];
  const cache = new Map<string, string | undefined>();
  return async (target: string) => {
    if (frozen === undefined) return undefined;
    if (cache.has(target)) return cache.get(target);
    const dir = revisions.snapshotDir(projectId, frozen.revision);
    let content: string | undefined;
    try {
      content = target === ABSTRACT_TARGET
        ? (JSON.parse(await readFile(join(dir, "outline.json"), "utf8")) as { abstract?: string }).abstract
        : await readFile(join(dir, target), "utf8");
    } catch {
      content = undefined;
    }
    cache.set(target, content);
    return content;
  };
}

export interface AuditContractResolution {
  /** instructionId → 已装载（新鲜、可执行）的冻结契约 */
  armed: Map<string, EditContract>;
  /** instructionId → 不派发原因（写回指令 statusNote） */
  blocked: Map<string, { code: "EDIT_CONTRACT_REAPPROVAL_REQUIRED" | "EDIT_CONTRACT_MISSING" | "EDIT_CONTRACT_NOT_EXECUTABLE" | "EDIT_CONTRACT_STALE"; note: string; contractId?: string }>;
}

/** 已批准审计改写意见 → 冻结契约（派发前确定性装载） */
export async function resolveAuditRewriteContracts(input: {
  instructions: readonly ExternalInstruction[];
  store: EditContractStoreFile;
  readTarget: (target: string) => Promise<string | undefined>;
  skip?: ReadonlySet<string>;
}): Promise<AuditContractResolution> {
  const armed = new Map<string, EditContract>();
  const blocked: AuditContractResolution["blocked"] = new Map();
  for (const instruction of input.instructions) {
    if (!isApprovedAuditRewrite(instruction)) continue;
    if (instruction.status !== "pending" && instruction.status !== "unresolved" && instruction.status !== "partially_handled") continue;
    if (input.skip?.has(instruction.instructionId) === true) continue;
    const contractId = instruction.origin?.contractId;
    if (contractId === undefined) {
      blocked.set(instruction.instructionId, {
        code: "EDIT_CONTRACT_REAPPROVAL_REQUIRED",
        note: "EDIT_CONTRACT_REAPPROVAL_REQUIRED: 该审计改写意见的批准早于结构化编辑契约（旧审批只含自然语言约束，不可升级为写入授权）——请在审计修改计划中重新批准后再派发",
      });
      continue;
    }
    const contract = input.store.contracts.find((entry) => entry.contractId === contractId);
    if (contract === undefined) {
      blocked.set(instruction.instructionId, { code: "EDIT_CONTRACT_MISSING", contractId, note: `EDIT_CONTRACT_MISSING: 指令引用的编辑契约 ${contractId} 不存在——不派发（fail closed）` });
      continue;
    }
    if (contract.status !== "executable") {
      blocked.set(instruction.instructionId, {
        code: "EDIT_CONTRACT_NOT_EXECUTABLE",
        contractId,
        note: `EDIT_CONTRACT_NOT_EXECUTABLE: 编辑契约 ${contractId} 状态 ${contract.status}${contract.constraints.unenforceable.length > 0 ? `（${contract.constraints.unenforceable.join("；")}）` : ""}——需作者决定`,
      });
      continue;
    }
    const current = await input.readTarget(contract.target.file);
    if (current === undefined || !isContractFresh(contract, current)) {
      blocked.set(instruction.instructionId, {
        code: "EDIT_CONTRACT_STALE",
        contractId,
        note: `EDIT_CONTRACT_STALE: 批准后目标 ${contract.target.file} 内容已变化（契约绑定批准时内容）——不派发、不复用旧批准；请重新审计 / 重新批准`,
      });
      continue;
    }
    armed.set(instruction.instructionId, contract);
  }
  return { armed, blocked };
}

/** 改进计划内容哈希（plan_confirm 批准绑定；计划被重新生成 → 旧契约不再匹配） */
export function improvementPlanContentHash(items: readonly unknown[]): string {
  return sha256(JSON.stringify(items));
}

/** plan_confirm 冻结的改进计划条目契约（同 run + 同计划哈希；planItemId → 契约） */
export function resolveImprovementContracts(store: EditContractStoreFile, runId: string, planHash: string | undefined): Map<string, EditContract[]> {
  const out = new Map<string, EditContract[]>();
  if (planHash === undefined) return out;
  for (const contract of store.contracts) {
    if (contract.source.kind !== "improvement_plan_item" || contract.runId !== runId || contract.source.planHash !== planHash) continue;
    const id = contract.source.planItemId;
    if (id === undefined) continue;
    out.set(id, [...(out.get(id) ?? []), contract]);
  }
  return out;
}

/**
 * 单次写入的契约集合：系统修订策略（底线）+ 驱动该目标的审计契约（无论目标是否一致——目标不符即拒绝，
 * 收窄不可放宽）+ 目标一致的改进计划条目契约（携带作者结构化批准的值对）。
 */
export function contractsForWrite(input: {
  projectId: string;
  runId: string;
  stageId: string;
  target: string;
  carrier: "abstract" | "file";
  baseContent: string;
  frozenContent: string | undefined;
  auditContracts: readonly EditContract[];
  improvementContracts: readonly EditContract[];
}): EditContract[] {
  return [
    systemRevisionPolicyContract({
      projectId: input.projectId,
      runId: input.runId,
      file: input.target,
      carrier: input.carrier,
      baseContent: input.baseContent,
      frozenContent: input.frozenContent,
      stageId: input.stageId,
    }),
    ...input.auditContracts,
    ...input.improvementContracts.filter((contract) => contract.target.file === input.target),
  ];
}

/** 摘要候选 → main.tex 候选（\begin{abstract} 块内文替换；与 writeMainTex 同一转义口径） */
export function replaceAbstractInMainTex(mainTex: string, abstract: string): string | null {
  const match = /\\begin\{abstract\}[\s\S]*?\\end\{abstract\}/.exec(mainTex);
  if (match === null) return null;
  const block = `\\begin{abstract}\n${escapeAbstractPlainText(abstract.trim())}\n\\end{abstract}`;
  return mainTex.slice(0, match.index) + block + mainTex.slice(match.index + match[0].length);
}

/** 本 stage 已通过契约校验并落盘的写入（目标 → 落盘内容哈希） */
export class ValidatedWriteRegistry {
  private readonly hashes = new Map<string, string>();
  readonly verdicts: EditContractVerdict[] = [];

  register(target: string, content: string, verdict?: EditContractVerdict): void {
    this.hashes.set(normalizePath(target), sha256(target === ABSTRACT_TARGET ? content.trim() : content));
    if (verdict !== undefined) this.verdicts.push(verdict);
  }

  matches(target: string, content: string): boolean {
    const expected = this.hashes.get(normalizePath(target));
    return expected !== undefined && expected === sha256(target === ABSTRACT_TARGET ? content.trim() : content);
  }
}

async function listTexFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (dir === root && entry.name === "revisions") continue;
        await walk(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".tex")) {
        out.push(normalizePath(relative(root, absolute)));
      }
    }
  };
  await walk(root);
  return out.sort();
}

async function readOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** stage 开始时的工作区状态（提交边界的比较基准：只追究本 stage 期间产生的未校验改动） */
export interface WorkspaceState {
  files: Map<string, string>;
  abstract: string | undefined;
}

export async function captureWorkspaceState(
  services: Pick<GuardedCommitServices, "projects" | "manuscript">,
  projectId: string,
): Promise<WorkspaceState> {
  const manuscriptDir = services.projects.manuscriptDir(projectId);
  const files = new Map<string, string>();
  for (const file of await listTexFiles(manuscriptDir)) {
    const content = await readOrUndefined(join(manuscriptDir, file));
    if (content !== undefined) files.set(file, content);
  }
  return { files, abstract: (await services.manuscript.loadOutline(projectId))?.abstract };
}

export interface GuardedCommitServices {
  projects: Pick<ProjectStore, "manuscriptDir" | "researchDir">;
  revisions: Pick<ManuscriptRevisionStore, "currentRevision" | "snapshotDir" | "commit" | "workTreeFingerprint">;
  manuscript: {
    loadOutline(projectId: string): Promise<import("../manuscript/ManuscriptService.js").Outline | null>;
    saveOutline(projectId: string, outline: import("../manuscript/ManuscriptService.js").Outline): Promise<unknown>;
    writeMainTex(projectId: string, outline: import("../manuscript/ManuscriptService.js").Outline, withBibliography: boolean): Promise<unknown>;
  };
}

/**
 * 提交边界：相对上一修订的每个 .tex / 摘要改动都必须由已校验写入登记；未登记改动（Writer 工具直写
 * 其它文件、遗漏校验的路径、校验后被改动）恢复为上一修订内容并记录事件。随后以工作树指纹提交。
 * 有大纲时 main.tex 是组装产物：任何恢复后按大纲重新组装（确定性派生，不视为独立写入）。
 */
export async function guardedRevisionCommit(
  services: GuardedCommitServices,
  input: { projectId: string; runId: string; stageId: string; registry: ValidatedWriteRegistry; withBibliography: boolean; stageStart: WorkspaceState },
): Promise<{ revision: number; created: boolean; reverted: string[] }> {
  const { projectId } = input;
  const manuscriptDir = services.projects.manuscriptDir(projectId);
  const current = await services.revisions.currentRevision(projectId);
  const reverted: string[] = [];
  if (current > 0) {
    const outline = await services.manuscript.loadOutline(projectId);
    const assembledRoot = outline !== null ? "main.tex" : undefined;
    // 基准 = stage 开始时的工作区（stage 之前已存在的工作区改动——如用户在 run 外的编辑——不归本 stage，
    // 不被回退；只有 stage 期间产生且未登记为已校验写入的改动被恢复为 stage 开始时的内容）
    const files = new Set([...(await listTexFiles(manuscriptDir)), ...input.stageStart.files.keys()]);
    for (const file of files) {
      if (file === assembledRoot) continue;
      const before = input.stageStart.files.get(file);
      const now = await readOrUndefined(join(manuscriptDir, file));
      if (before === now) continue;
      if (now !== undefined && input.registry.matches(file, now)) continue;
      if (before !== undefined) await writeFileAtomic(join(manuscriptDir, file), before);
      else if (now !== undefined) await unlink(join(manuscriptDir, file));
      reverted.push(file);
    }
    if (outline !== null) {
      const previousAbstract = input.stageStart.abstract;
      const currentAbstract = outline.abstract;
      if ((previousAbstract ?? "").trim() !== (currentAbstract ?? "").trim() && !input.registry.matches(ABSTRACT_TARGET, currentAbstract ?? "")) {
        const restored = { ...outline };
        if (previousAbstract === undefined) delete restored.abstract;
        else restored.abstract = previousAbstract;
        await services.manuscript.saveOutline(projectId, restored);
        reverted.push(ABSTRACT_TARGET);
      }
      if (reverted.length > 0) {
        const latest = await services.manuscript.loadOutline(projectId);
        if (latest !== null) await services.manuscript.writeMainTex(projectId, latest, input.withBibliography);
      }
    }
    if (reverted.length > 0) {
      const event: EditContractEvent = {
        at: new Date().toISOString(),
        kind: "unvalidated_write_reverted",
        stageId: input.stageId,
        runId: input.runId,
        contractIds: [],
        codes: ["EDIT_CONTRACT_MISSING"],
        detail: `提交边界发现未经契约校验的改动并已恢复：${reverted.join(", ")}`,
      };
      await recordEditContractEvents(services.projects as ProjectStore, projectId, [event]);
    }
  }
  const fingerprint = await services.revisions.workTreeFingerprint(projectId);
  const commit = await services.revisions.commit(projectId, input.stageId, input.runId, { expectedFingerprint: fingerprint });
  return { ...commit, reverted };
}

/** 纯表述系统写入（润色 / 编译修复 / 引用语法归一）的契约校验 */
export function validatePreservingWrite(input: {
  projectId: string;
  runId: string;
  target: string;
  baseline: string;
  candidate: string;
  kind: "style_polish_policy" | "latex_repair_policy";
}): EditContractVerdict {
  return validateCandidateEdit({
    target: input.target,
    baseline: input.baseline,
    candidate: input.candidate,
    contracts: [preservingPolicyContract({
      projectId: input.projectId,
      runId: input.runId,
      file: input.target,
      carrier: input.target === ABSTRACT_TARGET ? "abstract" : "file",
      baseContent: input.baseline,
      kind: input.kind,
    })],
  });
}

// ---------------------------------------------------------------------------
// hitl.plan_confirm：展示可写范围 / 受保护值 / 结构化值变更，并把批准冻结为契约
// ---------------------------------------------------------------------------

export interface PlanItemForContract {
  id?: string;
  section?: string;
  logicalSection?: string;
  targetQuote?: string;
  action?: string;
  rationale?: string;
  actionType?: string;
  instructionId?: string;
  expectedFactChanges?: Array<{ before?: unknown; after?: unknown; basis?: unknown }>;
}

export interface PlanItemContractPreview {
  itemId: string;
  target: string;
  scope: "anchors" | "whole_target";
  anchor?: string;
  protectedValueCount: number;
  protectedValuesSample: string[];
  /** 结构化值变更提案（只有作者逐项勾选的会被授权） */
  proposedValueChanges: Array<{ before: string; after: string; basis?: string; blockedByHardFreeze: boolean }>;
  /** 关联的已批准审计改写契约（硬禁改：计划批准不能解除） */
  linkedAuditContract?: { contractId: string; hardNumericFreeze: boolean; anchors: string[]; conflicts: string[] };
  /** 计划文本点名受保护数值且出现新值 —— 文本不构成授权（确定性告警） */
  unstructuredValueChangeWarning?: string;
  /** 目标内容不可读 / 计划条目无法结构化 → 不可执行 */
  unenforceable?: string;
}

export const PLAN_CONFIRM_APPROVAL_SCOPE = "hitl.plan_confirm";

/** 计划批准令牌：绑定 run + 计划内容哈希（完整性绑定，防止对已变化计划的旧批准；不是认证密钥） */
export function planApprovalToken(runId: string, planHash: string): string {
  return sha256(`${runId}|${PLAN_CONFIRM_APPROVAL_SCOPE}|${planHash}`).slice(0, 24);
}

export function planItemTarget(item: PlanItemForContract): string | undefined {
  if (item.logicalSection === ABSTRACT_TARGET || item.section === ABSTRACT_TARGET) return ABSTRACT_TARGET;
  return typeof item.section === "string" && item.section.trim() !== "" ? normalizePath(item.section.trim()) : undefined;
}

function structuredChanges(item: PlanItemForContract): Array<{ before: string; after: string; basis?: string }> {
  return (item.expectedFactChanges ?? []).flatMap((change) =>
    typeof change.before === "string" && typeof change.after === "string" && change.before.trim() !== ""
      ? [{ before: change.before, after: change.after, ...(typeof change.basis === "string" ? { basis: change.basis } : {}) }]
      : []);
}

const itemIdOf = (item: PlanItemForContract, index: number): string => item.id ?? `improvement:${index + 1}`;

export async function buildPlanContractPreviews(input: {
  items: readonly PlanItemForContract[];
  readTarget: (target: string) => Promise<string | undefined>;
  frozenTarget: (target: string) => Promise<string | undefined>;
  auditContractFor: (instructionId: string) => EditContract | undefined;
}): Promise<PlanItemContractPreview[]> {
  const previews: PlanItemContractPreview[] = [];
  for (const [index, item] of input.items.entries()) {
    if ((item.actionType ?? "modify") !== "modify") continue;
    const target = planItemTarget(item);
    const content = target !== undefined ? await input.readTarget(target) : undefined;
    const audit = item.instructionId !== undefined ? input.auditContractFor(item.instructionId) : undefined;
    const frozen = target !== undefined ? await input.frozenTarget(target) : undefined;
    const frozenValues = new Map<string, number>();
    for (const token of extractValueTokens(frozen ?? content ?? "")) frozenValues.set(token.norm, (frozenValues.get(token.norm) ?? 0) + 1);
    const protectedTokens = extractValueTokens(content ?? "").filter((token) => {
      const left = frozenValues.get(token.norm) ?? 0;
      if (left <= 0) return false;
      frozenValues.set(token.norm, left - 1);
      return true;
    });
    const protectedSet = new Set(protectedTokens.map((token) => token.norm));
    const contentSet = new Set(extractValueTokens(content ?? "").map((token) => token.norm));
    const mentioned = extractValueTokens(`${item.action ?? ""}\n${item.rationale ?? ""}`).filter((token) => token.kind === "number");
    const mentionedProtected = [...new Set(mentioned.filter((token) => protectedSet.has(token.norm)).map((token) => token.raw))];
    const mentionedNew = [...new Set(mentioned.filter((token) => !contentSet.has(token.norm)).map((token) => token.raw))];
    const hardFreeze = audit?.constraints.hardNumericFreeze === true;
    const anchor = item.targetQuote !== undefined && item.targetQuote.trim() !== "" ? item.targetQuote : undefined;
    previews.push({
      itemId: itemIdOf(item, index),
      target: target ?? "(unresolved)",
      scope: anchor !== undefined ? "anchors" : "whole_target",
      ...(anchor !== undefined ? { anchor } : {}),
      protectedValueCount: protectedTokens.length,
      protectedValuesSample: [...new Set(protectedTokens.map((token) => token.raw))].slice(0, 12),
      proposedValueChanges: structuredChanges(item).map((change) => ({ ...change, blockedByHardFreeze: hardFreeze })),
      ...(audit !== undefined
        ? { linkedAuditContract: { contractId: audit.contractId, hardNumericFreeze: hardFreeze, anchors: audit.scope.anchors.map((entry) => entry.text), conflicts: audit.conflicts.map((conflict) => conflict.detail) } }
        : {}),
      ...(mentionedProtected.length > 0 && mentionedNew.length > 0
        ? { unstructuredValueChangeWarning: `计划文本点名了受保护数值（${mentionedProtected.slice(0, 6).join("、")}）并出现目标中没有的数值（${mentionedNew.slice(0, 6).join("、")}）——计划文字不构成改数授权；${hardFreeze ? "该条目受审计硬禁改约束，任何批准都不能改动这些数值" : "只有下方结构化列出并被你逐项勾选的值变更会被授权"}` }
        : {}),
      ...(target === undefined || content === undefined ? { unenforceable: "计划条目的目标在稿件中不可读——不可执行（不会改稿）" } : {}),
    });
  }
  return previews;
}

export interface PlanApprovalSelection {
  planHash?: string;
  approvalToken?: string;
  approvedFactChanges: Array<{ itemId: string; before: string; after: string }>;
}

/** 读取 resume payload 中的结构化批准字段（类型不符 → 视为未提供，绝不猜测） */
export function readPlanApprovalSelection(payload: Record<string, unknown> | undefined): PlanApprovalSelection {
  const raw = payload?.["approvedFactChanges"];
  const approvedFactChanges = Array.isArray(raw)
    ? raw.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const record = entry as Record<string, unknown>;
        return typeof record["itemId"] === "string" && typeof record["before"] === "string" && typeof record["after"] === "string"
          ? [{ itemId: record["itemId"], before: record["before"], after: record["after"] }]
          : [];
      })
    : [];
  return {
    ...(typeof payload?.["planHash"] === "string" ? { planHash: payload["planHash"] } : {}),
    ...(typeof payload?.["approvalToken"] === "string" ? { approvalToken: payload["approvalToken"] } : {}),
    approvedFactChanges,
  };
}

/**
 * 服务端独立校验计划批准（不依赖前端展示正确）：
 * - planHash / approvalToken 提供时必须与当前计划一致（旧批准 / 计划已重做 → 拒绝）；
 * - 每条勾选的值变更必须逐字对应某 modify 条目的结构化 expectedFactChanges（伪造 / 计划外 → 拒绝）；
 * - 关联审计硬禁改的条目不能经计划批准改数（禁改优先 → 拒绝请求，提示作者）。
 * 未提供任何结构化字段的旧客户端批准 = 只批准范围，零值变更授权。
 */
export function checkPlanApproval(input: {
  runId: string;
  planHash: string;
  items: readonly PlanItemForContract[];
  selection: PlanApprovalSelection;
  auditContractFor: (instructionId: string) => EditContract | undefined;
}): { ok: true } | { ok: false; code: "EDIT_CONTRACT_STALE" | "EDIT_CONTRACT_VIOLATION"; message: string } {
  const { selection } = input;
  if (selection.planHash !== undefined && selection.planHash !== input.planHash) {
    return { ok: false, code: "EDIT_CONTRACT_STALE", message: "EDIT_CONTRACT_STALE: 批准所依据的计划版本已变化（planHash 不一致）——请刷新后重新确认" };
  }
  if (selection.approvalToken !== undefined && selection.approvalToken !== planApprovalToken(input.runId, input.planHash)) {
    return { ok: false, code: "EDIT_CONTRACT_STALE", message: "EDIT_CONTRACT_STALE: 批准令牌与当前 run / 计划不匹配——拒绝旧审批重放" };
  }
  if (selection.approvedFactChanges.length > 0 && (selection.planHash === undefined || selection.approvalToken === undefined)) {
    return { ok: false, code: "EDIT_CONTRACT_VIOLATION", message: "EDIT_CONTRACT_VIOLATION: 值变更批准必须携带计划哈希与批准令牌（绑定所见计划版本）" };
  }
  for (const change of selection.approvedFactChanges) {
    const index = input.items.findIndex((candidate, position) => itemIdOf(candidate, position) === change.itemId);
    const item = index >= 0 ? input.items[index] : undefined;
    if (item === undefined || (item.actionType ?? "modify") !== "modify") {
      return { ok: false, code: "EDIT_CONTRACT_VIOLATION", message: `EDIT_CONTRACT_VIOLATION: 批准的值变更指向不存在 / 非 modify 的计划条目 ${change.itemId}` };
    }
    if (!structuredChanges(item).some((proposal) => proposal.before === change.before && proposal.after === change.after)) {
      return { ok: false, code: "EDIT_CONTRACT_VIOLATION", message: `EDIT_CONTRACT_VIOLATION: 条目 ${change.itemId} 的结构化提案中没有「${change.before} → ${change.after}」——计划文本或请求体不能凭空产生值变更授权` };
    }
    const audit = item.instructionId !== undefined ? input.auditContractFor(item.instructionId) : undefined;
    if (audit?.constraints.hardNumericFreeze === true) {
      return { ok: false, code: "EDIT_CONTRACT_VIOLATION", message: `EDIT_CONTRACT_VIOLATION: 条目 ${change.itemId} 关联审计改写意见的硬禁改约束（契约 ${audit.contractId}）——计划批准不能解除，禁改优先` };
    }
  }
  return { ok: true };
}

/** plan_confirm 批准 → 每个 modify 条目一份契约（范围 = targetQuote 或整目标；值变更 = 作者逐项勾选的结构化值对） */
export function mintPlanItemContracts(input: {
  projectId: string;
  runId: string;
  planHash: string;
  items: readonly PlanItemForContract[];
  selection: PlanApprovalSelection;
  approvalId: string;
  at: string;
  targetContent: ReadonlyMap<string, string>;
}): EditContract[] {
  const contracts: EditContract[] = [];
  for (const [index, item] of input.items.entries()) {
    if ((item.actionType ?? "modify") !== "modify") continue;
    const itemId = itemIdOf(item, index);
    const target = planItemTarget(item);
    const content = target !== undefined ? input.targetContent.get(target) : undefined;
    const approved = input.selection.approvedFactChanges.filter((change) => change.itemId === itemId);
    const anchor = item.targetQuote !== undefined && item.targetQuote.trim() !== "" ? item.targetQuote : undefined;
    contracts.push(buildEditContract({
      projectId: input.projectId,
      runId: input.runId,
      source: {
        kind: "improvement_plan_item",
        ref: `${input.runId}:${itemId}`,
        planItemId: itemId,
        planHash: input.planHash,
        ...(item.instructionId !== undefined ? { instructionId: item.instructionId } : {}),
      },
      authority: [{
        kind: "user_approval",
        ref: input.approvalId,
        actor: "author",
        channel: "http:POST /api/runs/:runId/resume (hitl.plan_confirm approve)",
        at: input.at,
        boundContentHash: input.planHash,
      }],
      target: { carrier: target === ABSTRACT_TARGET ? "abstract" : "file", file: target ?? "(unresolved)", baseContent: content ?? "" },
      ...(anchor !== undefined ? { anchors: [anchor] } : {}),
      constraints: {
        numericProtect: "listed",
        protectedValues: [],
        allowNewValues: true,
        hardNumericFreeze: false,
        citationPolicy: "unrestricted",
        unenforceable: target === undefined || content === undefined ? ["计划条目目标在稿件中不可读，无法冻结基线"] : [],
      },
      allowedValueChanges: approved.map((change) => ({ before: change.before, after: change.after, approvalId: input.approvalId, basis: "plan_confirm structured approval" })),
      now: new Date(input.at),
    }));
  }
  return contracts;
}
