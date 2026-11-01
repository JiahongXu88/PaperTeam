/**
 * EditContract 持久化（M15.20 P0）：research/edit-contracts.json。
 *
 * - contracts：结构化编辑契约（只追加；同 contractId 内容不可变——批准后如需改动须生成新契约 + 新批准事件）
 * - approvals：真实用户（或测试中显式标注的合成主体）批准事件，绑定所见内容哈希
 * - events：校验 lineage（accepted / rejected / stale / reapproval_required …），供复评与审计追溯
 *
 * 损坏的存储 fail closed：读取抛错，任何依赖契约的写入因此不会发生（绝不按「无契约」放行）。
 * 不记录密钥 / 模型原始输出；事件只含哈希、违规码与截断说明。
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { writeJsonAtomic } from "../util/atomic.js";
import type { EditContract, EditContractVerdict, EditContractViolationCode } from "./editContract.js";
import { mergeValueChangeRequests, type ValueChangeRequest } from "./valueChangeRequests.js";

export const EDIT_CONTRACTS_FILE = "edit-contracts.json";
export const EDIT_CONTRACT_STORE_SCHEMA_VERSION = "edit-contract-store/v1" as const;

export interface EditApprovalEvent {
  approvalId: string;
  kind: "target_audit_item_approve" | "plan_confirm_approve" | "value_change_request_approve";
  /** author = 真实用户经 HTTP 决策通道；synthetic_test_actor = 测试夹具 */
  actor: "author" | "synthetic_test_actor";
  channel: string;
  runId?: string;
  at: string;
  /** 批准时展示内容（计划 / 契约草案）的哈希 */
  boundContentHash: string;
  /** 本次批准中用户逐项勾选的结构化值变更（未勾选 = 未批准） */
  approvedValueChanges?: Array<{ planItemId: string; before: string; after: string }>;
  contractIds: string[];
}

export interface EditContractEvent {
  at: string;
  kind: "candidate_accepted" | "candidate_rejected" | "contract_stale" | "reapproval_required" | "unvalidated_write_reverted" | "commit_race_rejected";
  stageId?: string;
  runId?: string;
  target?: string;
  contractIds: string[];
  instructionIds?: string[];
  planItemIds?: string[];
  baselineHash?: string;
  candidateHash?: string;
  /** 落盘后内容哈希（accepted；与 lineage afterSha256 对齐） */
  appliedHash?: string;
  codes: EditContractViolationCode[] | string[];
  detail?: string;
}

export interface EditContractStoreFile {
  schemaVersion: typeof EDIT_CONTRACT_STORE_SCHEMA_VERSION;
  contracts: EditContract[];
  approvals: EditApprovalEvent[];
  events: EditContractEvent[];
  /** M15 长程 A3（R4）：审稿驱动修订的数值修改请求（旧存储无此字段 = 空） */
  valueChangeRequests?: ValueChangeRequest[];
}

const MAX_EVENTS = 2000;
const queues = new Map<string, Promise<unknown>>();

function storePath(projects: ProjectStore, projectId: string): string {
  return join(projects.researchDir(projectId), EDIT_CONTRACTS_FILE);
}

function enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const task = previous.then(operation);
  queues.set(key, task.catch(() => undefined));
  return task;
}

export async function loadEditContractStore(projects: ProjectStore, projectId: string): Promise<EditContractStoreFile> {
  let text: string;
  try {
    text = await readFile(storePath(projects, projectId), "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return { schemaVersion: EDIT_CONTRACT_STORE_SCHEMA_VERSION, contracts: [], approvals: [], events: [] };
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as Partial<EditContractStoreFile>;
    if (parsed.schemaVersion !== EDIT_CONTRACT_STORE_SCHEMA_VERSION || !Array.isArray(parsed.contracts) || !Array.isArray(parsed.approvals) || !Array.isArray(parsed.events)) {
      throw new Error("schema");
    }
    return parsed as EditContractStoreFile;
  } catch {
    throw new BusinessError("INTERNAL_ERROR", "research/edit-contracts.json 损坏——编辑契约不可读，拒绝任何依赖契约的写入（fail closed）");
  }
}

export async function updateEditContractStore(
  projects: ProjectStore,
  projectId: string,
  transform: (store: EditContractStoreFile) => EditContractStoreFile,
): Promise<EditContractStoreFile> {
  return enqueue(storePath(projects, projectId), async () => {
    const current = await loadEditContractStore(projects, projectId);
    const next = transform({ ...current, contracts: [...current.contracts], approvals: [...current.approvals], events: [...current.events] });
    // 契约不可变：同 id 已存在则保留原内容（重放 / 重复批准不覆盖）
    const seen = new Map<string, EditContract>();
    for (const contract of next.contracts) if (!seen.has(contract.contractId)) seen.set(contract.contractId, contract);
    const normalized: EditContractStoreFile = {
      schemaVersion: EDIT_CONTRACT_STORE_SCHEMA_VERSION,
      contracts: [...seen.values()],
      approvals: next.approvals.filter((approval, index, all) => all.findIndex((other) => other.approvalId === approval.approvalId) === index),
      events: next.events.slice(-MAX_EVENTS),
      ...(next.valueChangeRequests !== undefined && next.valueChangeRequests.length > 0 ? { valueChangeRequests: next.valueChangeRequests } : {}),
    };
    await mkdir(projects.researchDir(projectId), { recursive: true });
    await writeJsonAtomic(storePath(projects, projectId), normalized);
    return normalized;
  });
}

export async function saveEditContracts(
  projects: ProjectStore,
  projectId: string,
  contracts: readonly EditContract[],
  approval?: EditApprovalEvent,
): Promise<EditContractStoreFile> {
  return updateEditContractStore(projects, projectId, (store) => ({
    ...store,
    contracts: [...store.contracts, ...contracts],
    approvals: approval !== undefined ? [...store.approvals, approval] : store.approvals,
  }));
}

export async function recordEditContractEvents(
  projects: ProjectStore,
  projectId: string,
  events: readonly EditContractEvent[],
  valueChangeRequests: readonly ValueChangeRequest[] = [],
): Promise<void> {
  if (events.length === 0 && valueChangeRequests.length === 0) return;
  await updateEditContractStore(projects, projectId, (store) => ({
    ...store,
    events: [...store.events, ...events],
    valueChangeRequests: mergeValueChangeRequests(store.valueChangeRequests ?? [], valueChangeRequests),
  }));
}

export function eventFromVerdict(
  verdict: EditContractVerdict,
  input: { stageId?: string; runId?: string; instructionIds?: string[]; planItemIds?: string[]; appliedHash?: string; at?: string },
): EditContractEvent {
  return {
    at: input.at ?? new Date().toISOString(),
    kind: verdict.ok ? "candidate_accepted" : "candidate_rejected",
    ...(input.stageId !== undefined ? { stageId: input.stageId } : {}),
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    target: verdict.target,
    contractIds: verdict.contractIds,
    ...(input.instructionIds !== undefined && input.instructionIds.length > 0 ? { instructionIds: input.instructionIds } : {}),
    ...(input.planItemIds !== undefined && input.planItemIds.length > 0 ? { planItemIds: input.planItemIds } : {}),
    baselineHash: verdict.baselineHash,
    candidateHash: verdict.candidateHash,
    ...(input.appliedHash !== undefined ? { appliedHash: input.appliedHash } : {}),
    codes: [...new Set(verdict.violations.map((violation) => violation.code))],
    ...(verdict.violations.length > 0 ? { detail: verdict.violations.slice(0, 4).map((violation) => violation.detail).join("；").slice(0, 600) } : {}),
  };
}
