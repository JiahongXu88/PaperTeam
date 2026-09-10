/**
 * Manuscript Version Service（M4.8）。
 *
 * 把分散的版本事实组装成面向用户的 ManuscriptVersionDTO：
 *   ManuscriptRevisionStore   修订链（revision / reason / restoredFrom）
 *   ReviewArtifactStore       review summaries / quality gate rounds / iteration history / revision plans
 *   PaperArtifactStore        Draft / Final 产物
 *   build/build-gate.json     最新构建记录
 *
 * 纪律：
 * - 关联（哪轮 review / gate / artifact 对应哪个 revision）只在本层做，
 *   前端拿到即展示、绝不自行拼装猜测（M4.8 §9）；
 * - 对齐口径与 FinalizeService 一致：review/gate 以 reviewedRevision 对齐，
 *   build 以 build.revision 对齐，artifact 以 revision 对齐；
 *   旧产物缺 reviewedRevision → 按未对齐处理（不盲信）；
 * - 列表只读元数据（登记表 / 轮次清单），不读快照内容——快照读取只发生在
 *   compare（确定性 diff）与 restore（RevisionStore 内部）。
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError } from "../errors.js";
import type { ManuscriptRevisionStore } from "../manuscript/RevisionStore.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { PaperArtifactStore } from "../artifacts/ArtifactStore.js";
import type { ReviewArtifactStore } from "../review/reviewArtifacts.js";
import type { IterationRecord } from "../review/revisionOutcome.js";
import type { RevisionPlan } from "../review/revisionPlan.js";
import { loadBuildGateRecord } from "../quality/gates.js";

/** 修订来源的中文标签由前端注册表维护；这里只回传稳定的 reason 字符串 */

export interface VersionReviewFact {
  round: number;
  reviewedRevision: number | null;
  critical: number;
  major: number;
  blocking: number;
  academicScore: number | null;
}

export interface VersionGateFact {
  round: number;
  passed: boolean;
  /** gate 对齐的修订（内嵌同轮 summary 的 reviewedRevision；null = 旧产物未携带） */
  reviewedRevision: number | null;
  failedRuleIds: string[];
}

export interface VersionBuildFact {
  passed: boolean;
  checkedAt: string;
  revision: number;
}

export interface ManuscriptVersionDTO {
  revision: number;
  createdAt: string;
  /** 产生本修订的业务动作（outline.plan / writing.sections / review.snapshot / revision.revise / revision.apply / revision.repair_latex / revision.restore / baseline） */
  source: string;
  runId?: string;
  /** source=revision.restore 时的恢复来源 */
  restoredFrom?: number;
  isCurrent: boolean;
  /** 本修订存在 Final 产物（历史 Final 不会被新 Draft 覆盖） */
  isFinal: boolean;
  /** 本修订存在 Draft 产物 */
  hasDraft: boolean;
  review: VersionReviewFact | null;
  qualityGate: VersionGateFact | null;
  build: VersionBuildFact | null;
  artifacts: { artifactId: string; kind: "draft" | "final" }[];
  revisionPlan: { planId: string; round: number; planned: number; skipped: number } | null;
  iteration: { outcome: string | null; gateRound: number } | null;
}

export interface VersionListResult {
  current: number;
  versions: ManuscriptVersionDTO[];
}

export interface CompareSectionEntry {
  path: string;
  /** 展示名（outline 章节标题；无 outline 时用路径） */
  title: string;
  status: "unchanged" | "modified" | "added" | "removed";
  fromLines: number | null;
  toLines: number | null;
  added: number | null;
  removed: number | null;
}

export interface VersionCompareResult {
  from: { revision: number; createdAt: string; source: string };
  to: { revision: number; createdAt: string; source: string };
  sections: CompareSectionEntry[];
  summary: { unchanged: number; modified: number; added: number; removed: number };
  /** 两端 review / gate 事实的确定性对照（均为 null 时省略） */
  reviewDelta: {
    from: VersionReviewFact | null;
    to: VersionReviewFact | null;
    fromGate: VersionGateFact | null;
    toGate: VersionGateFact | null;
  };
}

export interface VersionServiceOptions {
  projects: ProjectStore;
  revisions: ManuscriptRevisionStore;
  artifacts: PaperArtifactStore;
  reviewArtifacts: ReviewArtifactStore;
}

export class VersionService {
  private readonly projects: ProjectStore;
  private readonly revisions: ManuscriptRevisionStore;
  private readonly artifacts: PaperArtifactStore;
  private readonly reviewArtifacts: ReviewArtifactStore;

  constructor(options: VersionServiceOptions) {
    this.projects = options.projects;
    this.revisions = options.revisions;
    this.artifacts = options.artifacts;
    this.reviewArtifacts = options.reviewArtifacts;
  }

  /** 版本历史（降序；只读元数据，不触碰快照内容） */
  async listVersions(projectId: string): Promise<VersionListResult> {
    const state = await this.revisions.load(projectId);
    if (state.current === 0 || state.revisions.length === 0) {
      return { current: state.current, versions: [] };
    }
    const summaries = await this.reviewArtifacts.listSummaries(projectId);
    const gates = await this.reviewArtifacts.listGates(projectId);
    const iterations = await this.reviewArtifacts.loadIterations(projectId);
    const artifacts = await this.artifacts.list(projectId);
    const buildRecord = await loadBuildGateRecord(this.projects, projectId);

    // 按 reviewedRevision 索引：同一 revision 被多轮 review 时取最新轮
    const reviewByRevision = new Map<number, VersionReviewFact>();
    for (const summary of summaries) {
      if (summary.reviewedRevision === undefined) {
        continue;
      }
      reviewByRevision.set(summary.reviewedRevision, {
        round: summary.round,
        reviewedRevision: summary.reviewedRevision,
        critical: summary.counts.critical,
        major: summary.counts.major,
        blocking: summary.counts.blocking,
        academicScore: summary.scores.academicScore,
      });
    }
    const gateByRevision = new Map<number, VersionGateFact>();
    for (const gate of gates) {
      if (gate.reviewedRevision === undefined) {
        continue;
      }
      if (!gate.gate.rules.every((rule) => typeof rule?.rule === "string")) {
        continue;
      }
      gateByRevision.set(gate.reviewedRevision, {
        round: gate.round,
        passed: gate.gate.passed,
        reviewedRevision: gate.reviewedRevision,
        failedRuleIds: gate.gate.rules.filter((rule) => !rule.passed).map((rule) => rule.rule),
      });
    }
    const iterationByRevision = new Map<number, IterationRecord>();
    for (const record of iterations) {
      iterationByRevision.set(record.revision, record);
    }
    const plansByRevision = new Map<number, RevisionPlan>();
    for (const summary of summaries) {
      const plan = await this.reviewArtifacts.loadPlan(projectId, summary.round);
      if (plan !== null && !plansByRevision.has(plan.sourceRevision)) {
        plansByRevision.set(plan.sourceRevision, plan);
      }
    }

    const versions: ManuscriptVersionDTO[] = state.revisions.map((record) => {
      const artifactsForRevision = artifacts.filter((artifact) => artifact.revision === record.revision);
      const review = reviewByRevision.get(record.revision) ?? null;
      const gate = gateByRevision.get(record.revision) ?? null;
      const plan = plansByRevision.get(record.revision) ?? null;
      const iteration = iterationByRevision.get(record.revision) ?? null;
      return {
        revision: record.revision,
        createdAt: record.createdAt,
        source: record.reason,
        ...(record.runId !== undefined ? { runId: record.runId } : {}),
        ...(record.restoredFrom !== undefined ? { restoredFrom: record.restoredFrom } : {}),
        isCurrent: record.revision === state.current,
        isFinal: artifactsForRevision.some((artifact) => artifact.kind === "final"),
        hasDraft: artifactsForRevision.some((artifact) => artifact.kind === "draft"),
        review,
        qualityGate: gate,
        build:
          buildRecord !== null && buildRecord.revision === record.revision
            ? { passed: buildRecord.passed, checkedAt: buildRecord.checkedAt, revision: buildRecord.revision }
            : null,
        artifacts: artifactsForRevision.map((artifact) => ({
          artifactId: artifact.artifactId,
          kind: artifact.kind,
        })),
        revisionPlan:
          plan !== null
            ? {
                planId: plan.planId,
                round: plan.reviewRound,
                planned: plan.items.filter((item) => item.status === "planned").length,
                skipped: plan.items.filter((item) => item.status !== "planned").length,
              }
            : null,
        iteration: iteration !== null ? { outcome: iteration.outcome, gateRound: iteration.gateRound } : null,
      };
    });
    versions.reverse(); // 最新在前
    return { current: state.current, versions };
  }

  /**
   * 两个修订的确定性比较（零 LLM）：
   * 快照逐文件内容对比（modified/added/removed/unchanged）+ 行级增删规模
   * （LCS，超界文件退化为行数）+ 两端 review/gate 事实对照。
   */
  async compare(projectId: string, fromRevision: number, toRevision: number): Promise<VersionCompareResult> {
    if (!Number.isInteger(fromRevision) || !Number.isInteger(toRevision)) {
      throw new BusinessError("INVALID_REQUEST", "from / to 必须是修订编号（整数）");
    }
    if (fromRevision === toRevision) {
      throw new BusinessError("INVALID_REQUEST", "请选择两个不同的修订进行比较");
    }
    const state = await this.revisions.load(projectId);
    const fromRecord = state.revisions.find((record) => record.revision === fromRevision);
    const toRecord = state.revisions.find((record) => record.revision === toRevision);
    if (fromRecord === undefined || toRecord === undefined) {
      throw new BusinessError("NOT_FOUND", `修订 ${fromRevision} 或 ${toRevision} 不存在`);
    }

    const fromFiles = await readSnapshot(this.revisions.snapshotDir(projectId, fromRevision));
    const toFiles = await readSnapshot(this.revisions.snapshotDir(projectId, toRevision));
    const outline = await readOutlineTitles(join(this.revisions.snapshotDir(projectId, toRevision), "outline.json"));

    const paths = [...new Set([...fromFiles.keys(), ...toFiles.keys()])].sort();
    const sections: CompareSectionEntry[] = [];
    let unchanged = 0;
    let modified = 0;
    let added = 0;
    let removed = 0;
    for (const path of paths) {
      const from = fromFiles.get(path);
      const to = toFiles.get(path);
      if (from !== undefined && to !== undefined) {
        if (from === to) {
          unchanged += 1;
          sections.push(entry(path, outline, "unchanged", from, to, 0, 0));
        } else {
          modified += 1;
          const { added: plus, removed: minus } = lineDelta(from, to);
          sections.push(entry(path, outline, "modified", from, to, plus, minus));
        }
      } else if (to !== undefined) {
        added += 1;
        sections.push(entry(path, outline, "added", undefined, to, countLines(to), 0));
      } else if (from !== undefined) {
        removed += 1;
        sections.push(entry(path, outline, "removed", from, undefined, 0, countLines(from)));
      }
    }

    const { versions } = await this.listVersions(projectId);
    const fromVersion = versions.find((version) => version.revision === fromRevision);
    const toVersion = versions.find((version) => version.revision === toRevision);
    return {
      from: { revision: fromRecord.revision, createdAt: fromRecord.createdAt, source: fromRecord.reason },
      to: { revision: toRecord.revision, createdAt: toRecord.createdAt, source: toRecord.reason },
      sections,
      summary: { unchanged, modified, added, removed },
      reviewDelta: {
        from: fromVersion?.review ?? null,
        to: toVersion?.review ?? null,
        fromGate: fromVersion?.qualityGate ?? null,
        toGate: toVersion?.qualityGate ?? null,
      },
    };
  }

  /**
   * 恢复历史修订（M4.8）：创建新的不可变修订，历史不动。
   * 旧 review / gate / build 结论随 revision 前进自然 stale。
   */
  async restore(
    projectId: string,
    revision: number,
  ): Promise<{ revision: number; created: boolean; restoredFrom: number; current: number }> {
    if (!Number.isInteger(revision) || revision < 1) {
      throw new BusinessError("INVALID_REQUEST", "revision 必须是正整数");
    }
    const result = await this.revisions.restore(projectId, revision);
    return { ...result, current: result.revision };
  }
}

// ---- 确定性 diff 辅助 ----

/** 单文件行数上限：超过后 LCS 退化为总行数对比（防大文件 O(n·m) 失控） */
const DIFF_LINE_LIMIT = 2000;

async function readSnapshot(snapshotDir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  let names: string[];
  try {
    names = await readdir(snapshotDir);
  } catch {
    return files;
  }
  await collect(snapshotDir, "", names, files);
  return files;

  async function collect(dir: string, prefix: string, names: string[], acc: Map<string, string>): Promise<void> {
    for (const name of names) {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      const absolute = join(dir, path);
      if (await isDirectory(absolute)) {
        await collect(dir, path, await readdirSafe(absolute), acc);
      } else {
        try {
          acc.set(path, await readFile(absolute, "utf8"));
        } catch {
          // 二进制 / 不可读文件：内容以占位符参与对比（同路径同占位 → unchanged）
          acc.set(path, `(binary:${await fileSize(absolute)})`);
        }
      }
    }
  }
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function isDirectory(absolute: string): Promise<boolean> {
  try {
    return (await stat(absolute)).isDirectory();
  } catch {
    return false;
  }
}

async function fileSize(absolute: string): Promise<number> {
  try {
    return (await stat(absolute)).size;
  } catch {
    return -1;
  }
}

/** outline.json → 文件路径 → 章节标题（快照内的 outline 反映该修订当时的结构） */
async function readOutlineTitles(outlinePath: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  try {
    const parsed = JSON.parse(await readFile(outlinePath, "utf8")) as {
      abstract?: string;
      sections?: { file: string; title: string }[];
    };
    if ((parsed.abstract ?? "").trim() !== "") {
      titles.set("abstract", "摘要");
    }
    for (const section of parsed.sections ?? []) {
      if (typeof section?.file === "string" && typeof section?.title === "string") {
        titles.set(`sections/${section.file}`, section.title);
      }
    }
  } catch {
    // 无 outline / 损坏 → 用路径展示
  }
  return titles;
}

function entry(
  path: string,
  outline: Map<string, string>,
  status: CompareSectionEntry["status"],
  from: string | undefined,
  to: string | undefined,
  added: number,
  removed: number,
): CompareSectionEntry {
  const isText = (from ?? to) !== undefined && !(from ?? to)!.startsWith("(binary:");
  return {
    path,
    title: outline.get(path) ?? displayPath(path),
    status,
    fromLines: from !== undefined && isText ? countLines(from) : null,
    toLines: to !== undefined && isText ? countLines(to) : null,
    added: isText ? added : null,
    removed: isText ? removed : null,
  };
}

function displayPath(path: string): string {
  if (path === "outline.json") return "大纲";
  if (path === "references.bib") return "参考文献库";
  if (path === "main.tex") return "main.tex（组装根）";
  return path;
}

function countLines(content: string): number {
  return content === "" ? 0 : content.split("\n").length;
}

/** 行级增删规模：小文件用 LCS；超界退化为行数差 */
function lineDelta(from: string, to: string): { added: number; removed: number } {
  const fromLines = from.split("\n");
  const toLines = to.split("\n");
  if (fromLines.length > DIFF_LINE_LIMIT || toLines.length > DIFF_LINE_LIMIT) {
    return { added: Math.max(toLines.length - fromLines.length, 0), removed: Math.max(fromLines.length - toLines.length, 0) };
  }
  // 经典 LCS 表（行相等到处缩短）
  const table: number[][] = Array.from({ length: fromLines.length + 1 }, () =>
    new Array<number>(toLines.length + 1).fill(0),
  );
  for (let i = fromLines.length - 1; i >= 0; i -= 1) {
    for (let j = toLines.length - 1; j >= 0; j -= 1) {
      const fromLine = fromLines[i] ?? "";
      const toLine = toLines[j] ?? "";
      table[i]![j] =
        fromLine === toLine
          ? (table[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(table[i + 1]?.[j] ?? 0, table[i]?.[j + 1] ?? 0);
    }
  }
  const common = table[0]?.[0] ?? 0;
  return { added: toLines.length - common, removed: fromLines.length - common };
}
