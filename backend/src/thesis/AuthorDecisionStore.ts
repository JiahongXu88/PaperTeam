/**
 * M14.1b：作者决定账本（research/author-decisions.jsonl，append-only）。
 *
 * 只记录；应用效果由 ResearchInputService.submitDecision 完成。幂等：同 decisionId
 * 重复提交返回既有记录且不再应用。actor 只允许 user（HTTP 真实操作）或 test_fixture
 * （测试显式模拟）——不存在 "model" 行为人。
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { BusinessError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { fingerprintJson } from "../util/hash.js";
import { AUTHOR_DECISION_TYPES, type AuthorDecision, type AuthorDecisionPayload, type DecisionActor } from "./researchInputTypes.js";

export class AuthorDecisionStore {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly now: () => Date;

  constructor(private readonly projects: ProjectStore, options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  filePath(projectId: string): string {
    return join(this.projects.researchDir(projectId), "author-decisions.jsonl");
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

  async list(projectId: string): Promise<AuthorDecision[]> {
    await this.projects.getRequired(projectId);
    let raw: string;
    try {
      raw = await readFile(this.filePath(projectId), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return [];
      throw error;
    }
    const decisions: AuthorDecision[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as AuthorDecision;
        if (parsed.schemaVersion === 1 && typeof parsed.decisionId === "string") decisions.push(parsed);
      } catch {
        // 损坏行跳过（append-only 账本：不改写既有内容）
      }
    }
    return decisions;
  }

  async get(projectId: string, decisionId: string): Promise<AuthorDecision | undefined> {
    return (await this.list(projectId)).find((decision) => decision.decisionId === decisionId);
  }

  /**
   * 在队列内执行「查重 → 应用 → 追加」：apply 抛错则不落账（账本只记已生效决定）。
   */
  async record(
    projectId: string,
    input: { decisionId?: string; actor: DecisionActor; payload: AuthorDecisionPayload },
    apply: (decision: AuthorDecision) => Promise<string[]>,
  ): Promise<{ decision: AuthorDecision; duplicate: boolean }> {
    validateActor(input.actor);
    if (!AUTHOR_DECISION_TYPES.includes(input.payload.type)) {
      throw new BusinessError("INVALID_REQUEST", `决定类型只能是 ${AUTHOR_DECISION_TYPES.join(" / ")}`);
    }
    const decisionId = input.decisionId ?? `D${fingerprintJson(input.payload).slice(0, 16)}`;
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(decisionId)) {
      throw new BusinessError("INVALID_REQUEST", "decisionId 只允许字母 / 数字 / _ . -（≤80）");
    }
    return this.enqueue(projectId, async () => {
      const existing = await this.get(projectId, decisionId);
      if (existing !== undefined) {
        return { decision: existing, duplicate: true };
      }
      const createdAt = this.now().toISOString();
      const decision: AuthorDecision = {
        schemaVersion: 1,
        decisionId,
        projectId,
        type: input.payload.type,
        actor: input.actor,
        payload: input.payload,
        createdAt,
        applied: { at: createdAt, effects: [] },
      };
      decision.applied.effects = await apply(decision);
      decision.applied.at = this.now().toISOString();
      const path = this.filePath(projectId);
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(decision)}\n`, "utf8");
      return { decision, duplicate: false };
    });
  }
}

function validateActor(actor: DecisionActor): void {
  if (actor === null || typeof actor !== "object" || (actor.kind !== "user" && actor.kind !== "test_fixture")) {
    throw new BusinessError("INVALID_REQUEST", "actor.kind 只能是 user 或 test_fixture（模型不能生成作者确认）");
  }
}
