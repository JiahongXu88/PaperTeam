/**
 * M15 长程 A3（R4）：审稿驱动修订（尾段 revision.revise / apply）改动作者冻结数值的逐项结构化授权入口。
 *
 * P0 之后，尾段候选若改 / 删作者冻结基线中的数值且没有结构化批准，会被编辑契约拒绝——正确但没有出路。
 * 本模块把这类被拒候选中**可确定配对**的数值变更登记为「数值修改请求」：旧值 / 新值 / 目标文件 / 所在句 /
 * 基线哈希 / 来源（run、stage、驱动的指令与计划条目、违规说明）。作者经 HTTP 决策通道逐项批准（请求体须回传
 * 所见请求的 boundHash，计划外 / 陈旧 / 伪造的请求一律 409），批准事件进入 edit-contracts.json approvals；
 * 后续写入的系统修订契约只在「目标一致、旧值仍唯一出现在基线中、批准未失效」时把该值对作为 allowedValueChange。
 *
 * 不生成请求（必须作者自己处理）：硬禁改契约（审计「不得改变既有数字」）、候选还有其它违规（越界 / 引用等）、
 * 无法确定配对（缺失值与新增值数量不等）、旧值在基线中出现多次（批准范围不唯一）、数值互换（REBOUND）。
 * 模型文本永远不能创建批准：请求只是「待批准的事实」，批准只来自 decide 接口。
 */
import { BusinessError } from "../errors.js";
import { extractValueTokens, sha256, type ApprovedValueChange, type EditContract, type EditContractVerdict } from "./editContract.js";

export const VALUE_CHANGE_REQUEST_SCHEMA_VERSION = "value-change-request/v1" as const;

export interface ValueChangeRequest {
  schemaVersion: typeof VALUE_CHANGE_REQUEST_SCHEMA_VERSION;
  requestId: string;
  target: string;
  before: string;
  /** 空串 = 删除该值 */
  after: string;
  /** 基线中包含旧值的句子（截断；作者批准时看到的上下文） */
  context: string;
  /** 被拒候选中对应位置的句子（截断） */
  proposedContext: string;
  baselineHash: string;
  baseRevision: number | null;
  source: { runId: string; stageId: string; instructionIds: string[]; planItemIds: string[]; violation: string };
  createdAt: string;
  status: "pending" | "approved" | "rejected" | "superseded";
  decidedAt?: string;
  approvalId?: string;
  /** 请求展示内容的哈希（批准须回传，防计划外 / 陈旧批准） */
  boundHash: string;
}

const APPROVABLE_CODES = new Set(["EDIT_CONTRACT_PROTECTED_VALUE_CHANGED", "EDIT_CONTRACT_PROTECTED_VALUE_REMOVED", "EDIT_CONTRACT_NEW_VALUE"]);

const truncate = (text: string, max = 240): string => (text.length > max ? `${text.slice(0, max)}…` : text);

function sentenceContaining(text: string, raw: string): string {
  const collapsed = text.replace(/\s+/g, " ");
  const index = collapsed.indexOf(raw);
  if (index < 0) return "";
  const start = Math.max(collapsed.lastIndexOf(". ", index) + 1, collapsed.lastIndexOf("。", index) + 1, 0);
  const endDot = collapsed.indexOf(". ", index);
  const endCn = collapsed.indexOf("。", index);
  const ends = [endDot, endCn].filter((value) => value >= 0);
  const end = ends.length > 0 ? Math.min(...ends) + 1 : collapsed.length;
  return truncate(collapsed.slice(start, end).trim());
}

export function valueChangeRequestBoundHash(request: Pick<ValueChangeRequest, "requestId" | "target" | "before" | "after" | "context" | "baselineHash">): string {
  return sha256(JSON.stringify([request.requestId, request.target, request.before, request.after, request.context, request.baselineHash]));
}

/** 被拒候选 → 可逐项批准的数值修改请求（确定性；不可确定配对时返回空） */
export function deriveValueChangeRequests(input: {
  target: string;
  baseline: string;
  candidate: string;
  verdict: EditContractVerdict;
  contracts: readonly EditContract[];
  runId: string;
  stageId: string;
  baseRevision: number | null;
  instructionIds?: readonly string[];
  planItemIds?: readonly string[];
  now?: string;
}): ValueChangeRequest[] {
  const { verdict } = input;
  if (verdict.ok || verdict.violations.length === 0) return [];
  if (!verdict.violations.every((violation) => APPROVABLE_CODES.has(violation.code))) return [];
  if (input.contracts.some((contract) => contract.constraints.hardNumericFreeze)) return [];
  const baselineTokens = extractValueTokens(input.baseline).filter((token) => token.kind === "number");
  const candidateTokens = extractValueTokens(input.candidate).filter((token) => token.kind === "number");
  const count = (tokens: typeof baselineTokens) => {
    const map = new Map<string, number>();
    for (const token of tokens) map.set(token.norm, (map.get(token.norm) ?? 0) + 1);
    return map;
  };
  const baseCounts = count(baselineTokens);
  const candCounts = count(candidateTokens);
  const missing: typeof baselineTokens = [];
  const remaining = new Map(candCounts);
  for (const token of baselineTokens) {
    const left = remaining.get(token.norm) ?? 0;
    if (left > 0) remaining.set(token.norm, left - 1);
    else missing.push(token);
  }
  const introducedLeft = new Map(baseCounts);
  const introduced: typeof candidateTokens = [];
  for (const token of candidateTokens) {
    const left = introducedLeft.get(token.norm) ?? 0;
    if (left > 0) introducedLeft.set(token.norm, left - 1);
    else introduced.push(token);
  }
  if (missing.length === 0) return [];
  if (introduced.length !== 0 && introduced.length !== missing.length) return [];
  if (missing.some((token) => baseCounts.get(token.norm) !== 1)) return [];
  const baselineHash = sha256(input.baseline);
  const createdAt = input.now ?? new Date().toISOString();
  const violation = verdict.violations.map((entry) => entry.detail).join("；").slice(0, 400);
  return missing.map((token, index) => {
    const after = introduced.length === 0 ? "" : introduced[index]!.norm;
    const requestId = `vcr-${sha256([input.target, token.norm, after, baselineHash].join("\u0000")).slice(0, 16)}`;
    const context = sentenceContaining(input.baseline, token.raw);
    const partial = { requestId, target: input.target, before: token.norm, after, context, baselineHash };
    return {
      schemaVersion: VALUE_CHANGE_REQUEST_SCHEMA_VERSION,
      ...partial,
      proposedContext: after === "" ? "" : sentenceContaining(input.candidate, introduced[index]!.raw),
      baseRevision: input.baseRevision,
      source: {
        runId: input.runId,
        stageId: input.stageId,
        instructionIds: [...(input.instructionIds ?? [])],
        planItemIds: [...(input.planItemIds ?? [])],
        violation,
      },
      createdAt,
      status: "pending" as const,
      boundHash: valueChangeRequestBoundHash(partial),
    };
  });
}

/** 合并新请求（同 requestId 保留既有决策；同目标同旧值的旧 pending 请求被新请求取代） */
export function mergeValueChangeRequests(existing: readonly ValueChangeRequest[], incoming: readonly ValueChangeRequest[]): ValueChangeRequest[] {
  const out = [...existing];
  for (const request of incoming) {
    if (out.some((entry) => entry.requestId === request.requestId)) continue;
    for (const [index, entry] of out.entries()) {
      if (entry.status === "pending" && entry.target === request.target && entry.before === request.before) out[index] = { ...entry, status: "superseded" };
    }
    out.push(request);
  }
  return out;
}

/**
 * 已批准、对本次写入仍有效的值对：目标一致、旧值仍在当前基线中唯一出现。
 * （批准后旧值已被改掉 → 自然失效；旧值变为多次出现 → 批准范围不再唯一，失效。）
 */
export function approvedValueChangesForWrite(requests: readonly ValueChangeRequest[], target: string, baseline: string): ApprovedValueChange[] {
  const counts = new Map<string, number>();
  for (const token of extractValueTokens(baseline)) if (token.kind === "number") counts.set(token.norm, (counts.get(token.norm) ?? 0) + 1);
  return requests
    .filter((request) => request.status === "approved" && request.approvalId !== undefined && request.target === target && counts.get(request.before) === 1)
    .map((request) => ({ before: request.before, after: request.after, approvalId: request.approvalId!, basis: `value-change-request:${request.requestId}` }));
}

export interface ValueChangeDecision {
  requestId: string;
  decision: "approve" | "reject";
  boundHash: string;
}

/** 作者决策（纯函数；调用方负责持久化与批准事件）。任何一条不合法 → 整批 409，不部分生效。 */
export function applyValueChangeDecisions(
  requests: readonly ValueChangeRequest[],
  decisions: readonly ValueChangeDecision[],
  approvalId: string,
  at: string,
): ValueChangeRequest[] {
  const next = [...requests];
  for (const decision of decisions) {
    const index = next.findIndex((request) => request.requestId === decision.requestId);
    const request = index >= 0 ? next[index] : undefined;
    if (request === undefined) throw new BusinessError("EDIT_CONTRACT_VIOLATION", `数值修改请求 ${decision.requestId} 不存在（计划外的批准不生效）`);
    if (request.status !== "pending") throw new BusinessError("EDIT_CONTRACT_VIOLATION", `数值修改请求 ${decision.requestId} 当前状态 ${request.status}，不可再决策`);
    if (decision.boundHash !== request.boundHash || valueChangeRequestBoundHash(request) !== request.boundHash) {
      throw new BusinessError("EDIT_CONTRACT_VIOLATION", `数值修改请求 ${decision.requestId} 的内容哈希不符（陈旧或伪造的批准）`);
    }
    next[index] = decision.decision === "approve"
      ? { ...request, status: "approved", decidedAt: at, approvalId }
      : { ...request, status: "rejected", decidedAt: at };
  }
  return next;
}
