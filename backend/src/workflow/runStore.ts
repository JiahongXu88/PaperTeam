/**
 * WorkflowRun 持久化（M3.0，file-first）。
 *
 * 每个 run 一个目录（project-scoped，PRD §5.5 workflow/）：
 *   projects/<projectId>/workflow/runs/<runId>/
 *   ├── checkpoint.json   当前 WorkflowState（原子写：tmp → fsync → rename）
 *   ├── events.jsonl      Domain Event 追加日志
 *   └── stages/           每次 Stage 尝试的运行记录
 *
 * 恢复依据是 checkpoint 与 Workspace 状态，不依赖 OpenClaw Chat History（D-0013）。
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";

import type { ProjectStore } from "../project/ProjectStore.js";
import { writeJsonAtomic } from "../util/atomic.js";
import type { StageRecord, WorkflowState } from "./types.js";

/** 合法 runId：与 projectId 同一字符集（w-<12 hex>） */
export const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class WorkflowRunStore {
  private readonly projects: ProjectStore;

  constructor(projects: ProjectStore) {
    this.projects = projects;
  }

  /** run 目录（校验 runId，防路径穿越） */
  runDir(projectId: string, runId: string): string {
    if (!RUN_ID_PATTERN.test(runId)) {
      throw new Error(`WorkflowRunStore: 非法 runId："${runId}"`);
    }
    // projectDir 已校验 projectId 并做包含性检查
    return join(this.projects.workflowDir(projectId), "runs", runId);
  }

  checkpointPath(projectId: string, runId: string): string {
    return join(this.runDir(projectId, runId), "checkpoint.json");
  }

  eventsPath(projectId: string, runId: string): string {
    return join(this.runDir(projectId, runId), "events.jsonl");
  }

  stagesDir(projectId: string, runId: string): string {
    return join(this.runDir(projectId, runId), "stages");
  }

  /** 原子写 checkpoint（run 目录按需创建） */
  async saveCheckpoint(state: WorkflowState): Promise<void> {
    const path = this.checkpointPath(state.projectId, state.runId);
    await mkdir(dirname(path), { recursive: true });
    await writeJsonAtomic(path, state);
  }

  /** 读取 checkpoint；不存在 / 损坏返回 null */
  async loadCheckpoint(projectId: string, runId: string): Promise<WorkflowState | null> {
    let raw: string;
    try {
      raw = await readFile(this.checkpointPath(projectId, runId), "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as WorkflowState;
      if (typeof parsed === "object" && parsed !== null && parsed.runId === runId) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** 追加 Stage 尝试记录（stages/<序号>-<stageId>.json） */
  async saveStageRecord(
    projectId: string,
    runId: string,
    sequence: number,
    record: StageRecord,
  ): Promise<void> {
    const dir = this.stagesDir(projectId, runId);
    await mkdir(dir, { recursive: true });
    const safeStageId = record.stageId.replaceAll(/[^a-zA-Z0-9_.-]/g, "_");
    const file = join(dir, `${String(sequence).padStart(4, "0")}-${safeStageId}-a${record.attempt}.json`);
    await writeFile(file, JSON.stringify(record, null, 2) + "\n", "utf8");
  }

  /** 列出项目的全部 runId */
  async listRunIds(projectId: string): Promise<string[]> {
    const runsRoot = join(this.projects.workflowDir(projectId), "runs");
    let entries: readonly string[];
    try {
      entries = await readdir(runsRoot);
    } catch {
      return [];
    }
    return entries.filter((entry) => RUN_ID_PATTERN.test(entry)).sort();
  }

  /** 跨项目查找 run（projectId 未知时；线性扫描，规模内可接受） */
  async findRunLocation(runId: string): Promise<{ projectId: string; state: WorkflowState } | null> {
    for (const projectId of await this.projects.list()) {
      const state = await this.loadCheckpoint(projectId, runId);
      if (state !== null) {
        return { projectId, state };
      }
    }
    return null;
  }
}
