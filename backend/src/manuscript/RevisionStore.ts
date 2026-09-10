/**
 * Manuscript Revision Store（M4.7）。
 *
 * 把「manuscript/ 工作树」升级为有版本事实的修订模型：
 *   manuscript/revisions.json             修订登记表（Authoritative）
 *   manuscript/revisions/rev-{n}/...      每个修订的完整快照（含 figures 等资产）
 *
 * 语义：
 * - commit() 基于内容指纹幂等：内容未变不产生新修订；
 * - 每次 Writer 写作 / 修订 / 编译修复产生真实内容变化后 commit，
 *   旧修订永不覆盖（完整版本管理 UI 属 M4.8，本轮只保证后端版本事实）；
 * - Review round / Quality Gate round / Final artifact 都引用 revision 编号，
 *   Finalize 时据此做 stale 防护（gate 评的不是当前 revision → 拒绝）。
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { BusinessError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { writeJsonAtomic } from "../util/atomic.js";

/** 快照目录名（同时是 revisions.json 所在 manuscript/ 下的排除项） */
const REVISIONS_DIR = "revisions";
const REVISIONS_FILE = "revisions.json";

export interface RevisionRecord {
  revision: number;
  createdAt: string;
  /** 产生本修订的业务动作（writing.sections / revision.revise / revision.apply / revision.repair_latex / baseline） */
  reason: string;
  runId?: string;
  /** manuscript 工作树内容指纹（幂等判断用） */
  fingerprint: string;
}

export interface RevisionState {
  schemaVersion: 1;
  /** 当前修订编号（0 = 尚无版本事实，如刚创建 / 只导入未提交） */
  current: number;
  revisions: RevisionRecord[];
}

/** 一条修订的只读视图（API / 阶段结果用） */
export interface RevisionView {
  revision: number;
  createdAt: string;
  reason: string;
  runId?: string;
}

export interface ManuscriptRevisionStoreOptions {
  projects: ProjectStore;
  /** 可注入时钟（测试） */
  now?: () => Date;
}

export class ManuscriptRevisionStore {
  private readonly projects: ProjectStore;
  private readonly now: () => Date;
  /** 每项目串行化 commit（并发 commit 不产生重复 / 交叉快照） */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(options: ManuscriptRevisionStoreOptions) {
    this.projects = options.projects;
    this.now = options.now ?? (() => new Date());
  }

  /** 当前修订状态（无 revisions.json → current 0；损坏 → 防御性视为 0 并如实记录） */
  async load(projectId: string): Promise<RevisionState> {
    try {
      const raw = await readFile(this.revisionsPath(projectId), "utf8");
      const parsed = JSON.parse(raw) as Partial<RevisionState>;
      if (
        typeof parsed["current"] !== "number" ||
        !Array.isArray(parsed["revisions"]) ||
        !parsed["revisions"].every(
          (record) =>
            typeof record === "object" &&
            record !== null &&
            typeof (record as RevisionRecord)["revision"] === "number" &&
            typeof (record as RevisionRecord)["fingerprint"] === "string",
        )
      ) {
        return emptyState();
      }
      return {
        schemaVersion: 1,
        current: parsed["current"],
        revisions: parsed["revisions"] as RevisionRecord[],
      };
    } catch {
      return emptyState();
    }
  }

  async currentRevision(projectId: string): Promise<number> {
    return (await this.load(projectId)).current;
  }

  /**
   * 提交一个修订（内容指纹幂等）。
   * 返回受影响的修订编号：内容未变时返回当前编号（不新增）。
   */
  async commit(
    projectId: string,
    reason: string,
    runId?: string,
  ): Promise<{ revision: number; created: boolean }> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const task = previous.then(() => this.commitInner(projectId, reason, runId));
    // 队列只保序，失败不阻塞后续 commit
    this.queues.set(
      projectId,
      task.catch(() => undefined),
    );
    return task;
  }

  /**
   * 确保存在基线修订（current=0 且 manuscript 有内容时提交 baseline）。
   * review.run 前调用：保证每个被审阅的 manuscript 都有修订编号可对齐。
   */
  async ensureBaseline(projectId: string, runId?: string): Promise<number> {
    const state = await this.load(projectId);
    if (state.current > 0) {
      return state.current;
    }
    const files = await this.listWorkTreeFiles(projectId);
    if (files.length === 0) {
      throw new BusinessError(
        "STAGE_CONTRACT_VIOLATION",
        "manuscript 目录没有任何文件（无基线可提交）",
      );
    }
    const { revision } = await this.commit(projectId, "baseline", runId);
    return revision;
  }

  /** 修订快照目录（绝对路径） */
  snapshotDir(projectId: string, revision: number): string {
    return join(this.projects.manuscriptDir(projectId), REVISIONS_DIR, `rev-${revision}`);
  }

  private async commitInner(
    projectId: string,
    reason: string,
    runId?: string,
  ): Promise<{ revision: number; created: boolean }> {
    const state = await this.load(projectId);
    const files = await this.listWorkTreeFiles(projectId);
    if (files.length === 0) {
      // 空工作树没有可版本化的事实；如实返回当前（不制造空修订）
      return { revision: state.current, created: false };
    }
    const fingerprint = await fingerprintFiles(projectId, files);
    const latest = state.revisions[state.revisions.length - 1];
    if (latest !== undefined && latest.fingerprint === fingerprint) {
      return { revision: state.current, created: false };
    }
    const revision = state.current + 1;
    const snapshotDir = this.snapshotDir(projectId, revision);
    await mkdir(snapshotDir, { recursive: true });
    for (const file of files) {
      const target = join(snapshotDir, file.relativePath);
      await mkdir(join(target, ".."), { recursive: true });
      await copyFile(file.absolutePath, target);
    }
    const record: RevisionRecord = {
      revision,
      createdAt: this.now().toISOString(),
      reason,
      ...(runId !== undefined ? { runId } : {}),
      fingerprint,
    };
    const next: RevisionState = {
      schemaVersion: 1,
      current: revision,
      revisions: [...state.revisions, record],
    };
    await writeJsonAtomic(this.revisionsPath(projectId), next);
    return { revision, created: true };
  }

  private revisionsPath(projectId: string): string {
    return join(this.projects.manuscriptDir(projectId), REVISIONS_FILE);
  }

  /** manuscript 工作树文件清单（排除 revisions/；相对 manuscript/ 的 POSIX 风格路径） */
  private async listWorkTreeFiles(projectId: string): Promise<WorkTreeFile[]> {
    const manuscriptDir = this.projects.manuscriptDir(projectId);
    const out: WorkTreeFile[] = [];
    await walk(manuscriptDir, manuscriptDir, out);
    return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    async function walk(dir: string, root: string, acc: WorkTreeFile[]): Promise<void> {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (dir === root && name === REVISIONS_DIR) {
          continue;
        }
        if (dir === root && name === REVISIONS_FILE) {
          continue;
        }
        const absolutePath = join(dir, name);
        let info;
        try {
          info = await stat(absolutePath);
        } catch {
          continue;
        }
        if (info.isDirectory()) {
          await walk(absolutePath, root, acc);
        } else if (info.isFile()) {
          acc.push({ absolutePath, relativePath: relative(root, absolutePath).split(sep).join("/") });
        }
      }
    }
  }
}

interface WorkTreeFile {
  absolutePath: string;
  relativePath: string;
}

async function fingerprintFiles(projectId: string, files: WorkTreeFile[]): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`paperteam-manuscript-v1:${projectId}`);
  for (const file of files) {
    const content = await readFile(file.absolutePath);
    hash.update(`\n${file.relativePath}\0`);
    hash.update(content);
  }
  return hash.digest("hex");
}

function emptyState(): RevisionState {
  return { schemaVersion: 1, current: 0, revisions: [] };
}

/** RevisionState → API 视图（不含指纹） */
export function revisionViews(state: RevisionState): RevisionView[] {
  return state.revisions.map((record) => ({
    revision: record.revision,
    createdAt: record.createdAt,
    reason: record.reason,
    ...(record.runId !== undefined ? { runId: record.runId } : {}),
  }));
}
