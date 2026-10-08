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
import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { BusinessError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { writeFileAtomic, writeJsonAtomic } from "../util/atomic.js";

/** 快照目录名（同时是 revisions.json 所在 manuscript/ 下的排除项） */
const REVISIONS_DIR = "revisions";
const REVISIONS_FILE = "revisions.json";
const RESTORE_INTENT_FILE = "restore-intent.json";

interface RestoreIntent {
  schemaVersion: 1;
  status: "pending" | "complete";
  sourceRevision: number;
  baseRevision: number;
  targetRevision: number;
  targetFingerprint: string;
  createdAt: string;
  /** null means the path does not exist at that end of the operation. */
  files: { path: string; before: string | null; after: string | null }[];
}

function hashBytes(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function recoveryRequired(detail: string): never {
  throw new BusinessError("REVISION_RECOVERY_REQUIRED", `Manuscript restore 需要人工对账：${detail}`);
}

export interface RevisionRecord {
  revision: number;
  createdAt: string;
  /** 产生本修订的业务动作（writing.sections / revision.revise / revision.apply / revision.repair_latex / revision.restore / baseline） */
  reason: string;
  runId?: string;
  /** reason=revision.restore 时：恢复来源的修订编号（M4.8） */
  restoredFrom?: number;
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
  restoredFrom?: number;
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

  /** 未完成 restore 会阻断只读版本判断，避免把半恢复稿当成当前修订。 */
  async load(projectId: string): Promise<RevisionState> {
    const intent = await this.readRestoreIntent(projectId);
    if (intent?.status === "pending") recoveryRequired("存在未完成的 restore；请重试 restore 或 commit 以恢复");
    return this.loadState(projectId);
  }

  private async loadState(projectId: string): Promise<RevisionState> {
    let raw: string;
    try {
      raw = await readFile(this.revisionsPath(projectId), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return emptyState();
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<RevisionState>;
      if (
        parsed["schemaVersion"] !== 1 ||
        !Number.isSafeInteger(parsed["current"]) || parsed["current"]! < 0 ||
        !Array.isArray(parsed["revisions"]) ||
        !parsed["revisions"].every(
          (record) =>
            typeof record === "object" &&
            record !== null &&
            Number.isSafeInteger((record as RevisionRecord)["revision"]) &&
            /^[0-9a-f]{64}$/.test((record as RevisionRecord)["fingerprint"]),
        ) ||
        parsed["revisions"].length !== parsed["current"] ||
        !parsed["revisions"].every((record, index) => record.revision === index + 1)
      ) {
        throw new Error("invalid revision registry");
      }
      return {
        schemaVersion: 1,
        current: parsed["current"],
        revisions: parsed["revisions"] as RevisionRecord[],
      };
    } catch {
      throw new BusinessError("REVISION_STORE_CORRUPTED", "revisions.json 损坏；禁止将历史当作空修订重写");
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

  /**
   * 恢复到历史修订（M4.8）：把 rev-{n} 快照内容复制回工作树，然后以
   * reason=revision.restore 提交**新的**不可变修订。历史修订永不改动；
   * 旧 review / gate / build 结论因 revision 前进而自然 stale。
   * 与 commit 共用同一每项目串行队列（不与在途 commit 交叉）。
   */
  async restore(
    projectId: string,
    revision: number,
  ): Promise<{ revision: number; created: boolean; restoredFrom: number }> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const task = previous.then(() => this.restoreInner(projectId, revision));
    this.queues.set(
      projectId,
      task.catch(() => undefined),
    );
    return task;
  }

  private async restoreInner(
    projectId: string,
    revision: number,
  ): Promise<{ revision: number; created: boolean; restoredFrom: number }> {
    const recovered = await this.recoverRestore(projectId);
    if (recovered !== null && recovered.restoredFrom === revision) return recovered;
    const state = await this.loadState(projectId);
    const source = state.revisions.find((record) => record.revision === revision);
    if (source === undefined) {
      throw new BusinessError("NOT_FOUND", `修订 ${revision} 不存在`);
    }
    const snapshotDir = this.snapshotDir(projectId, revision);
    const snapshotFiles = await listSnapshotFiles(snapshotDir);
    if (snapshotFiles.length === 0) {
      throw new BusinessError("STAGE_CONTRACT_VIOLATION", `修订 ${revision} 快照为空（无法恢复）`);
    }
    const snapshotFingerprint = await fingerprintFiles(projectId, snapshotFiles.map((file) => ({
      relativePath: file.relativePath, absolutePath: join(snapshotDir, file.relativePath),
    })));
    if (snapshotFingerprint !== source.fingerprint) {
      throw new BusinessError("REVISION_STORE_CORRUPTED", `修订 ${revision} 快照与登记指纹不一致；工作树未修改`);
    }
    const currentFiles = await this.listWorkTreeFiles(projectId);
    const currentFingerprint = await fingerprintFiles(projectId, currentFiles);
    if (currentFingerprint === source.fingerprint) {
      return { revision: state.current, created: false, restoredFrom: revision };
    }
    // Do not reuse an orphan rev-N directory from an interrupted ordinary commit.
    const nextDir = this.snapshotDir(projectId, state.current + 1);
    if ((await listSnapshotFiles(nextDir)).length > 0) recoveryRequired(`rev-${state.current + 1} 存在未登记文件`);
    const before = new Map(await Promise.all(currentFiles.map(async (file) =>
      [file.relativePath, hashBytes(await readFile(file.absolutePath))] as const)));
    const after = new Map(await Promise.all(snapshotFiles.map(async (file) =>
      [file.relativePath, hashBytes(await readFile(join(snapshotDir, file.relativePath)))] as const)));
    const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
    const intent: RestoreIntent = {
      schemaVersion: 1, status: "pending", sourceRevision: revision,
      baseRevision: state.current, targetRevision: state.current + 1,
      targetFingerprint: source.fingerprint, createdAt: this.now().toISOString(),
      files: paths.map((path) => ({ path, before: before.get(path) ?? null, after: after.get(path) ?? null })),
    };
    await writeJsonAtomic(this.restoreIntentPath(projectId), intent, { tempDir: join(this.projects.manuscriptDir(projectId), REVISIONS_DIR) });
    await testBoundary("intent");
    return this.applyRestore(projectId, intent);
  }

  private restoreIntentPath(projectId: string): string {
    return join(this.projects.manuscriptDir(projectId), RESTORE_INTENT_FILE);
  }

  private async readRestoreIntent(projectId: string): Promise<RestoreIntent | null> {
    let raw: string;
    try { raw = await readFile(this.restoreIntentPath(projectId), "utf8"); }
    catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw error;
    }
    let intent: RestoreIntent;
    try { intent = JSON.parse(raw) as RestoreIntent; } catch { return recoveryRequired("restore intent JSON 损坏"); }
    const validHash = (value: unknown) => value === null || (typeof value === "string" && /^[0-9a-f]{64}$/.test(value));
    if (intent === null || typeof intent !== "object" || intent.schemaVersion !== 1 || !["pending", "complete"].includes(intent.status) ||
      !Number.isSafeInteger(intent.sourceRevision) || intent.sourceRevision < 1 ||
      !Number.isSafeInteger(intent.baseRevision) || intent.baseRevision < 0 ||
      intent.targetRevision !== intent.baseRevision + 1 ||
      !validHash(intent.targetFingerprint) || typeof intent.targetFingerprint !== "string" ||
      typeof intent.createdAt !== "string" || !Array.isArray(intent.files) || intent.files.length === 0 ||
      !intent.files.every((file) => file !== null && typeof file === "object" && typeof file.path === "string" &&
        !file.path.startsWith("/") && !file.path.includes("\\") &&
        file.path.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
        ![REVISIONS_DIR, REVISIONS_FILE, RESTORE_INTENT_FILE].includes(file.path.split("/")[0]!) &&
        validHash(file.before) && validHash(file.after)) ||
      new Set(intent.files.map((file) => file.path)).size !== intent.files.length) {
      return recoveryRequired("restore intent 结构或路径无效");
    }
    return intent;
  }

  private async recoverRestore(projectId: string): Promise<{ revision: number; created: boolean; restoredFrom: number } | null> {
    const intent = await this.readRestoreIntent(projectId);
    if (intent?.status !== "pending") return null;
    return this.applyRestore(projectId, intent);
  }

  private async applyRestore(projectId: string, intent: RestoreIntent): Promise<{ revision: number; created: boolean; restoredFrom: number }> {
    const state = await this.loadState(projectId);
    const committed = state.revisions.at(-1);
    if (state.current === intent.targetRevision) {
      if (committed?.reason !== "revision.restore" || committed.restoredFrom !== intent.sourceRevision ||
          committed.fingerprint !== intent.targetFingerprint) recoveryRequired("版本登记已前进，但与 restore intent 不符");
      await writeJsonAtomic(this.restoreIntentPath(projectId), { ...intent, status: "complete" }, { tempDir: join(this.projects.manuscriptDir(projectId), REVISIONS_DIR) });
      return { revision: intent.targetRevision, created: true, restoredFrom: intent.sourceRevision };
    }
    if (state.current !== intent.baseRevision) recoveryRequired("版本登记在恢复期间发生变化");
    const source = state.revisions.find((record) => record.revision === intent.sourceRevision);
    if (source?.fingerprint !== intent.targetFingerprint) recoveryRequired("源修订指纹与 intent 不符");
    const snapshotDir = this.snapshotDir(projectId, intent.sourceRevision);
    const snapshotFiles = await listSnapshotFiles(snapshotDir);
    if (snapshotFiles.length === 0 ||
        await fingerprintFiles(projectId, snapshotFiles.map((file) => ({
          relativePath: file.relativePath, absolutePath: join(snapshotDir, file.relativePath),
        }))) !== intent.targetFingerprint) recoveryRequired("源快照在恢复期间变化或损坏");
    const expectedAfter = intent.files.filter((file) => file.after !== null).map((file) => file.path).sort();
    if (JSON.stringify(snapshotFiles.map((file) => file.relativePath)) !== JSON.stringify(expectedAfter))
      recoveryRequired("源快照文件集合与 intent 不符");
    const manuscriptDir = this.projects.manuscriptDir(projectId);
    const actual = await this.listWorkTreeFiles(projectId);
    if (actual.some((file) => !intent.files.some((change) => change.path === file.relativePath)))
      recoveryRequired("恢复后工作树出现额外文件；保留外部修改");
    // Whole-tree preflight before any write; each file accepts only the original or intended bytes.
    for (const change of intent.files) {
      const observed = await optionalHash(join(manuscriptDir, change.path));
      if (observed !== change.before && observed !== change.after)
        recoveryRequired(`${change.path} 与恢复前后指纹均不一致；保留外部修改`);
    }
    for (const change of intent.files) {
      const path = join(manuscriptDir, change.path);
      const observed = await optionalHash(path);
      if (observed === change.after) continue;
      if (observed !== change.before) recoveryRequired(`${change.path} 在恢复期间变化`);
      if (change.after === null) await rm(path, { force: true });
      else {
        const content = await readFile(join(snapshotDir, change.path));
        if (hashBytes(content) !== change.after) recoveryRequired(`${change.path} 源快照在写入前变化`);
        await mkdir(join(path, ".."), { recursive: true });
        await writeFileAtomic(path, content, { tempDir: join(manuscriptDir, REVISIONS_DIR) });
      }
      await testBoundary("workspace");
    }
    const finalFiles = await this.listWorkTreeFiles(projectId);
    if (await fingerprintFiles(projectId, finalFiles) !== intent.targetFingerprint)
      recoveryRequired("恢复后的工作树指纹不匹配");
    const nextDir = this.snapshotDir(projectId, intent.targetRevision);
    const existingNext = await listSnapshotFiles(nextDir);
    if (existingNext.some((file) => !expectedAfter.includes(file.relativePath)))
      recoveryRequired("新修订快照存在意外文件");
    for (const change of intent.files.filter((file) => file.after !== null)) {
      const target = join(nextDir, change.path);
      const observed = await optionalHash(target);
      if (observed === change.after) continue;
      if (observed !== null) recoveryRequired(`新修订快照 ${change.path} 与目标不符`);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFileAtomic(target, await readFile(join(snapshotDir, change.path)), { tempDir: join(manuscriptDir, REVISIONS_DIR) });
      await testBoundary("snapshot");
    }
    const newFiles = await listSnapshotFiles(nextDir);
    if (await fingerprintFiles(projectId, newFiles.map((file) => ({
      relativePath: file.relativePath, absolutePath: join(nextDir, file.relativePath),
    }))) !== intent.targetFingerprint) recoveryRequired("新修订快照指纹不匹配");
    const record: RevisionRecord = {
      revision: intent.targetRevision, createdAt: intent.createdAt, reason: "revision.restore",
      restoredFrom: intent.sourceRevision, fingerprint: intent.targetFingerprint,
    };
    await testBoundary("before-commit");
    await writeJsonAtomic(this.revisionsPath(projectId), {
      schemaVersion: 1, current: intent.targetRevision, revisions: [...state.revisions, record],
    } satisfies RevisionState, { tempDir: join(manuscriptDir, REVISIONS_DIR) });
    await testBoundary("commit");
    await writeJsonAtomic(this.restoreIntentPath(projectId), { ...intent, status: "complete" }, { tempDir: join(manuscriptDir, REVISIONS_DIR) });
    return { revision: intent.targetRevision, created: true, restoredFrom: intent.sourceRevision };
  }

  private async commitInner(
    projectId: string,
    reason: string,
    runId?: string,
  ): Promise<{ revision: number; created: boolean }> {
    await this.recoverRestore(projectId);
    const state = await this.loadState(projectId);
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
    const existing = await listSnapshotFiles(snapshotDir);
    if (existing.length > 0) {
      if (JSON.stringify(existing.map((file) => file.relativePath)) !== JSON.stringify(files.map((file) => file.relativePath)) ||
          await fingerprintFiles(projectId, existing.map((file) => ({
            relativePath: file.relativePath, absolutePath: join(snapshotDir, file.relativePath),
          }))) !== fingerprint) recoveryRequired(`rev-${revision} 存在不完整或不匹配的未登记快照`);
    } else {
      await mkdir(snapshotDir, { recursive: true });
      for (const file of files) {
        const target = join(snapshotDir, file.relativePath);
        await mkdir(join(target, ".."), { recursive: true });
        await copyFile(file.absolutePath, target);
      }
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
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT" && dir === root) return;
        throw error;
      }
      for (const name of names) {
        if (dir === root && name === REVISIONS_DIR) {
          continue;
        }
        if (dir === root && name === REVISIONS_FILE) {
          continue;
        }
        if (dir === root && name === RESTORE_INTENT_FILE) {
          continue;
        }
        const absolutePath = join(dir, name);
        let info;
        try {
          info = await stat(absolutePath);
        } catch (error) {
          if ((error as { code?: string }).code === "ENOENT") continue;
          throw error;
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

/** 快照目录内容清单（相对快照根的 POSIX 路径；无子目录排除项） */
async function listSnapshotFiles(snapshotDir: string): Promise<{ relativePath: string }[]> {
  const out: { relativePath: string }[] = [];
  await walk(snapshotDir, snapshotDir, out);
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  async function walk(dir: string, root: string, acc: { relativePath: string }[]): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
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
        acc.push({ relativePath: relative(root, absolutePath).split(sep).join("/") });
      }
    }
  }
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

async function optionalHash(path: string): Promise<string | null> {
  try { return hashBytes(await readFile(path)); }
  catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

/** Deterministic test seam; the child process uses SIGKILL at a real disk boundary. */
let testBoundaryHits = 0;
let previousTestBoundary: string | undefined;
async function testBoundary(name: string): Promise<void> {
  const configured = process.env["PAPERTEAM_RESTORE_TEST_FAILURE"];
  if (configured !== previousTestBoundary) { testBoundaryHits = 0; previousTestBoundary = configured; }
  if (process.env["NODE_ENV"] !== "test" || configured !== name) return;
  testBoundaryHits += 1;
  if (testBoundaryHits !== Number(process.env["PAPERTEAM_RESTORE_TEST_HIT"] ?? "1")) return;
  if (process.env["PAPERTEAM_RESTORE_TEST_EXIT"] === "1") {
    process.kill(process.pid, "SIGKILL");
    process.exit(73);
  }
  throw Object.assign(new Error(`RESTORE_TEST_INTERRUPTED:${name}`), { code: "EIO" });
}

/** RevisionState → API 视图（不含指纹） */
export function revisionViews(state: RevisionState): RevisionView[] {
  return state.revisions.map((record) => ({
    revision: record.revision,
    createdAt: record.createdAt,
    reason: record.reason,
    ...(record.runId !== undefined ? { runId: record.runId } : {}),
    ...(record.restoredFrom !== undefined ? { restoredFrom: record.restoredFrom } : {}),
  }));
}
