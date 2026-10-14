/**
 * M14.1b：科研事实 + 冲突存储（research/scientific-facts.json）。
 *
 * 状态纪律：
 *   - 验证三态只能由：确定性来源核验（extracted → source_verified）或作者决定
 *     （→ author_confirmed）推进；模型输出不能改状态；
 *   - 冲突状态与验证状态解耦；处于 unresolved 冲突的事实禁止 author_confirmed；
 *   - 事实不删除：重放幂等（factId 确定性），版本变化产生新事实，旧事实保留。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError, NotFoundError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { writeJsonAtomic } from "../util/atomic.js";
import type {
  ConflictResolutionDecision,
  DecisionActor,
  FactConflict,
  ScientificFact,
} from "./researchInputTypes.js";
import type { SourceCheckOutcome } from "./sourceVerification.js";

export interface ScientificFactFile {
  schemaVersion: 1;
  facts: ScientificFact[];
  conflicts: FactConflict[];
  updatedAt: string;
}

export interface FactFilter {
  researchInputId?: string;
  kind?: ScientificFact["kind"];
  verification?: ScientificFact["verification"]["status"];
  conflictStatus?: ScientificFact["conflict"]["status"];
}

export class ScientificFactStore {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly now: () => Date;

  constructor(private readonly projects: ProjectStore, options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  filePath(projectId: string): string {
    return join(this.projects.researchDir(projectId), "scientific-facts.json");
  }

  private enqueue<T>(projectId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(run);
    this.queues.set(projectId, task);
    task.finally(() => {
      if (this.queues.get(projectId) === task) this.queues.delete(projectId);
    }).catch(() => {});
    return task;
  }

  async load(projectId: string): Promise<ScientificFactFile> {
    await this.projects.getRequired(projectId);
    let raw: string;
    try {
      raw = await readFile(this.filePath(projectId), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return { schemaVersion: 1, facts: [], conflicts: [], updatedAt: this.now().toISOString() };
      }
      throw error;
    }
    let parsed: ScientificFactFile;
    try {
      parsed = JSON.parse(raw) as ScientificFactFile;
    } catch {
      throw new BusinessError("STAGE_CONTRACT_VIOLATION", "scientific-facts.json 损坏，已停止读写（不自动覆盖）");
    }
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.facts) || !Array.isArray(parsed.conflicts)) {
      throw new BusinessError("STAGE_CONTRACT_VIOLATION", "scientific-facts.json 结构不合法");
    }
    return parsed;
  }

  async update<T>(projectId: string, mutate: (file: ScientificFactFile) => Promise<T> | T): Promise<T> {
    return this.enqueue(projectId, async () => {
      const file = await this.load(projectId);
      const result = await mutate(file);
      await writeJsonAtomic(this.filePath(projectId), { ...file, updatedAt: this.now().toISOString() });
      return result;
    });
  }

  async list(projectId: string, filter: FactFilter = {}): Promise<ScientificFact[]> {
    return (await this.load(projectId)).facts.filter(
      (fact) =>
        (filter.researchInputId === undefined || fact.researchInputId === filter.researchInputId) &&
        (filter.kind === undefined || fact.kind === filter.kind) &&
        (filter.verification === undefined || fact.verification.status === filter.verification) &&
        (filter.conflictStatus === undefined || fact.conflict.status === filter.conflictStatus),
    );
  }

  async get(projectId: string, factId: string): Promise<ScientificFact> {
    const fact = (await this.load(projectId)).facts.find((entry) => entry.factId === factId);
    if (fact === undefined) throw new NotFoundError("科研事实", factId);
    return fact;
  }

  async listConflicts(projectId: string, status?: FactConflict["status"]): Promise<FactConflict[]> {
    return (await this.load(projectId)).conflicts.filter((conflict) => status === undefined || conflict.status === status);
  }

  /**
   * 幂等写入抽取结果：已存在的 factId 保留其验证 / 冲突状态与确认记录，只刷新
   * surface/value/provenance（抽取算法同版本下应完全一致）。
   */
  async upsertFacts(projectId: string, facts: ScientificFact[]): Promise<{ created: number; unchanged: number }> {
    return this.update(projectId, (file) => {
      let created = 0;
      let unchanged = 0;
      const byId = new Map(file.facts.map((fact) => [fact.factId, fact]));
      for (const fact of facts) {
        const existing = byId.get(fact.factId);
        if (existing === undefined) {
          file.facts.push(fact);
          byId.set(fact.factId, fact);
          created += 1;
        } else {
          unchanged += 1;
          if (existing.extraction.method === fact.extraction.method && existing.provenance.surfaceHash !== fact.provenance.surfaceHash) {
            // 同 id 不同 surface：抽取器变化 → 不覆盖已验证内容，记入 note
            existing.verification.sourceCheckNote = `重抽取 surface 变化（${existing.surface} → ${fact.surface}），需重新核验`;
            existing.verification.sourceCheck = "unchecked";
            if (existing.verification.status === "source_verified") existing.verification.status = "extracted";
            existing.surface = fact.surface;
            existing.value = fact.value;
            existing.provenance = fact.provenance;
            existing.updatedAt = this.now().toISOString();
          }
        }
      }
      return { created, unchanged };
    });
  }

  /** 来源核验结果写回（只能 extracted → source_verified；author_confirmed 不降级，只记 sourceCheck） */
  async applySourceChecks(projectId: string, outcomes: Array<{ factId: string; outcome: SourceCheckOutcome }>): Promise<void> {
    await this.update(projectId, (file) => {
      const now = this.now().toISOString();
      for (const entry of outcomes) {
        const fact = file.facts.find((candidate) => candidate.factId === entry.factId);
        if (fact === undefined) continue;
        fact.verification.sourceCheck = entry.outcome.verified ? "verified" : "failed";
        fact.verification.sourceCheckNote = entry.outcome.note;
        if (entry.outcome.method !== undefined) fact.verification.sourceCheckMethod = entry.outcome.method;
        if (entry.outcome.verified) {
          fact.verification.verifiedAt = now;
          if (fact.verification.status === "extracted") fact.verification.status = "source_verified";
        } else if (fact.verification.status === "source_verified") {
          fact.verification.status = "extracted";
        }
        fact.updatedAt = now;
      }
    });
  }

  /** 作者确认（唯一通往 author_confirmed 的路径）；未决冲突事实拒绝确认 */
  async applyFactConfirmation(
    projectId: string,
    factIds: string[],
    outcome: "confirmed" | "revoked",
    decisionId: string,
    actor: DecisionActor,
  ): Promise<ScientificFact[]> {
    return this.update(projectId, (file) => {
      const now = this.now().toISOString();
      const updated: ScientificFact[] = [];
      for (const factId of factIds) {
        const fact = file.facts.find((candidate) => candidate.factId === factId);
        if (fact === undefined) throw new NotFoundError("科研事实", factId);
        if (outcome === "confirmed") {
          if (fact.conflict.status === "unresolved") {
            throw new BusinessError("INVALID_REQUEST", `事实 ${factId} 处于未裁决冲突（${fact.conflict.conflictIds.join(", ")}），须先裁决冲突`);
          }
          if (fact.supersededBy !== undefined) {
            throw new BusinessError("INVALID_REQUEST", `事实 ${factId} 已被 ${fact.supersededBy} 取代`);
          }
          fact.verification.status = "author_confirmed";
          fact.verification.confirmedAt = now;
          fact.verification.confirmation = { decisionId, actor };
        } else {
          fact.verification.status = fact.verification.sourceCheck === "verified" ? "source_verified" : "extracted";
          delete fact.verification.confirmedAt;
          delete fact.verification.confirmation;
        }
        fact.updatedAt = now;
        updated.push(fact);
      }
      return updated;
    });
  }

  /**
   * 幂等合并冲突：已存在（同 conflictId）保留 status / resolution；若裁决适用的
   * 内容版本与当前双方不一致 → 退回 unresolved（旧裁决不适用新版本）。
   * 同时同步事实的 conflict 状态。
   */
  async upsertConflicts(projectId: string, conflicts: FactConflict[]): Promise<{ created: number; existing: number; reopened: number }> {
    return this.update(projectId, (file) => {
      let created = 0;
      let existing = 0;
      let reopened = 0;
      const now = this.now().toISOString();
      for (const conflict of conflicts) {
        const index = file.conflicts.findIndex((entry) => entry.conflictId === conflict.conflictId);
        let stored: FactConflict;
        if (index < 0) {
          file.conflicts.push(conflict);
          stored = conflict;
          created += 1;
        } else {
          stored = file.conflicts[index]!;
          existing += 1;
          const hashes = new Set(conflict.parties.map((party) => party.contentHash));
          if (stored.resolution !== undefined && ![...hashes].every((hash) => stored.resolution!.appliesToContentHashes.includes(hash))) {
            stored.status = "unresolved";
            stored.updatedAt = now;
            reopened += 1;
          }
        }
        syncFactConflictState(file, stored);
      }
      return { created, existing, reopened };
    });
  }

  async applyConflictResolution(
    projectId: string,
    conflictId: string,
    decision: ConflictResolutionDecision,
    decisionId: string,
    actor: DecisionActor,
    options: { adoptedFactId?: string; rationale?: string } = {},
  ): Promise<FactConflict> {
    return this.update(projectId, (file) => {
      const conflict = file.conflicts.find((entry) => entry.conflictId === conflictId);
      if (conflict === undefined) throw new NotFoundError("事实冲突", conflictId);
      if (decision === "adopt_fact") {
        if (options.adoptedFactId === undefined || !conflict.parties.some((party) => party.factId === options.adoptedFactId)) {
          throw new BusinessError("INVALID_REQUEST", "adopt_fact 必须指定冲突双方之一的 adoptedFactId");
        }
      }
      const now = this.now().toISOString();
      conflict.resolution = {
        decision,
        ...(options.adoptedFactId !== undefined ? { adoptedFactId: options.adoptedFactId } : {}),
        ...(options.rationale !== undefined ? { rationale: options.rationale } : {}),
        decisionId,
        actor,
        decidedAt: now,
        appliesToContentHashes: [...new Set(conflict.parties.map((party) => party.contentHash))],
      };
      conflict.status = decision === "defer" ? "deferred" : "resolved";
      conflict.updatedAt = now;
      syncFactConflictState(file, conflict);
      // 被排除版本的原始事实**不删除、不改值**，只在 conflict.status 上反映 resolved
      return conflict;
    });
  }
}

function syncFactConflictState(file: ScientificFactFile, conflict: FactConflict): void {
  for (const party of conflict.parties) {
    const fact = file.facts.find((entry) => entry.factId === party.factId);
    if (fact === undefined) continue;
    if (!fact.conflict.conflictIds.includes(conflict.conflictId)) {
      fact.conflict.conflictIds.push(conflict.conflictId);
    }
    const related = file.conflicts.filter((entry) => fact.conflict.conflictIds.includes(entry.conflictId));
    const blockingOpen = related.some((entry) => entry.severity === "blocking" && (entry.status === "unresolved" || entry.status === "deferred"));
    if (blockingOpen) {
      fact.conflict.status = "unresolved";
    } else if (related.some((entry) => entry.status === "resolved")) {
      fact.conflict.status = "resolved";
    } else if (related.length > 0) {
      // 只剩 advisory（舍入 / 单位不可比）：不阻断，但标 not_comparable 供下游显示
      fact.conflict.status = related.some((entry) => entry.classification === "unit_incomparable") ? "not_comparable" : "none";
    }
  }
}
