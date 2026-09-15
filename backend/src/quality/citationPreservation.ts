/**
 * Citation Preservation Gate（M5.6 验收驱动，确定性、无 LLM）。
 *
 * 真实 A/B 验收暴露：Writer 一次修订把重建稿全部 \cite 删光，而既有 Quality Gate 的
 * 引用规则（hallucinated=0 / 结构合法）照常通过——「引用保持」不在 Gate 口径内。
 * Prompt 不是 Gate：本模块把「修订前后实际被引用的 key 集合」变成可判定的规则。
 *
 * 口径：
 *   * 事实源是不可变修订快照（manuscript/revisions/rev-{n}/）：previous = 被审阅修订的
 *     前一个修订，current = 被审阅修订；比较的是**实际被引用的 key**（按 key 语义，
 *     同 key 引用次数变化不算删除），不是 references.bib 里「可用」的 key。
 *   * 默认：previous 存在的 key 不得在 current 中无依据消失。
 *   * 有依据的删除只承认结构化计划：该 previous 修订对应的确定性 RevisionPlan
 *     （sourceRevision == previous）中 status=planned 的条目——
 *       - kind=citation_missing（key 不在 bib 中，计划就是删它）；
 *       - 条目文本（problem / instruction / expectedOutcome）显式点名 \cite{key}；
 *       - needsEvidence 条目（证据不足：允许弱化 / 删除论述）命中的章节内，该 key 在
 *         previous 的全部出现都落在这些章节里。
 *     Existing-Paper 的改进计划（research/improvement-plan.json）只承认显式点名。
 *   * catastrophic：previous 有引用、current 一处都没有 → hard fail，除非**每个** key 的删除都有
 *     显式依据（citation_missing / 条目显式点名 \cite{key}）。章节级的证据不足条目不是「全量
 *     引用移除」的明确依据：不能用一条「该节缺证据」把整篇引用删光洗白。
 *   * 历史回归：previous 与 current 都没有引用，但更早的基线修订有 → 同样 FAIL
 *     （不能用「本轮没再删」掩盖更早丢光引用的事实）。
 *   * 不可比较（无前序修订 / 快照缺失 / 用户显式恢复历史修订）→ 规则不参与，
 *     以独立 rule id 中性呈现，绝不伪造 PASS。
 */

import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { extractCitationOccurrences } from "../citation/StaticCitationChecker.js";
import { collectLatexFiles } from "../manuscript/LatexFiles.js";
import type { ManuscriptRevisionStore } from "../manuscript/RevisionStore.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { ReviewArtifactStore } from "../review/reviewArtifacts.js";
import type { RevisionPlan, RevisionPlanItem } from "../review/revisionPlan.js";

export interface CitationTexFile {
  /** 相对 manuscript 目录的 POSIX 路径 */
  file: string;
  content: string;
}

export interface CitationSnapshot {
  revision: number;
  files: CitationTexFile[];
}

export type CitationRemovalBasis =
  | "planned_citation_missing"
  | "planned_explicit_mention"
  | "planned_evidence_removal"
  | "improvement_plan_explicit_mention";

export interface AllowedCitationRemoval {
  key: string;
  basis: CitationRemovalBasis;
  planItemId: string;
  section: string;
}

export interface RemovedCitation {
  key: string;
  /** previous 中出现该 key 的文件（修订计划 / Writer 恢复的定位依据） */
  files: string[];
}

export interface CitationPreservationSummary {
  previousRevision: number;
  currentRevision: number;
  /** 引用出现次数（多重集大小） */
  previousCount: number;
  currentCount: number;
  /** 去重后的 key 集合（排序） */
  previousKeys: string[];
  currentKeys: string[];
  removedKeys: string[];
  addedKeys: string[];
  allowedRemovedKeys: AllowedCitationRemoval[];
  unexpectedRemovedKeys: string[];
  /** 无依据被删的 key 及其在 previous 中的位置 */
  unexpectedRemoved: RemovedCitation[];
  /** previous 有引用、current 为 0、且存在无依据删除 */
  catastrophic: boolean;
  /** previous / current 都为 0，但更早基线修订有引用 */
  historicalRegression: { baselineRevision: number; baselineCount: number } | null;
  /** 承认删除依据的计划（无则 null） */
  planId: string | null;
  /** 规则是否通过（unexpectedRemovedKeys 为空且无历史回归） */
  ok: boolean;
}

export interface CitationPreservationInput {
  previous: CitationSnapshot;
  current: CitationSnapshot;
  /** 更早的基线修订（历史回归检查；缺省不检查） */
  baseline?: CitationSnapshot;
  /** sourceRevision == previous.revision 的确定性修订计划（无则 null） */
  plan: RevisionPlan | null;
  /** Existing-Paper 改进计划条目（只承认显式点名 \cite{key}） */
  improvementPlanItems?: { section: string; action: string; rationale?: string }[];
}

const CITE_MENTION_PATTERN =
  /\\(?:cite|citep|citet|citealp|citealt|parencite|textcite|autocite|nocite)\*?(?:\[[^\]\n]*\])*\{([^{}]*)\}/g;

/** 文本中显式点名的 key（\cite{a,b} 等；纯函数） */
function mentionedKeys(text: string): string[] {
  const keys: string[] = [];
  CITE_MENTION_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CITE_MENTION_PATTERN.exec(text)) !== null) {
    for (const part of (match[1] ?? "").split(",")) {
      const key = part.trim();
      if (key !== "") {
        keys.push(key);
      }
    }
  }
  return keys;
}

/** 与 workflow sectionMatches 同口径的宽松章节匹配（路径 / 文件名 / stem / 包含） */
function sectionRefMatchesFile(sectionRef: string, file: string): boolean {
  const ref = sectionRef.trim().replaceAll("\\", "/").toLowerCase();
  if (ref === "" || ref === "(global)" || ref === "(unknown)") {
    return false;
  }
  const path = file.replaceAll("\\", "/").toLowerCase();
  const fileName = path.split("/").pop() ?? path;
  const stem = fileName.replace(/\.tex$/, "");
  return (
    ref === path ||
    ref === fileName ||
    ref === stem ||
    ref.endsWith(`/${path}`) ||
    path.endsWith(ref) ||
    (stem !== "" && ref.includes(stem))
  );
}

function keyLocations(files: CitationTexFile[]): Map<string, Set<string>> {
  const locations = new Map<string, Set<string>>();
  for (const file of files) {
    for (const key of extractCitationOccurrences(file.content)) {
      const set = locations.get(key) ?? new Set<string>();
      set.add(file.file);
      locations.set(key, set);
    }
  }
  return locations;
}

function countOccurrences(files: CitationTexFile[]): number {
  return files.reduce((sum, file) => sum + extractCitationOccurrences(file.content).length, 0);
}

/** 纯函数：修订前后引用保持判定（同输入同输出，可测试） */
export function evaluateCitationPreservation(input: CitationPreservationInput): CitationPreservationSummary {
  const previousLocations = keyLocations(input.previous.files);
  const currentLocations = keyLocations(input.current.files);
  const previousKeys = [...previousLocations.keys()].sort();
  const currentKeys = [...currentLocations.keys()].sort();
  const removedKeys = previousKeys.filter((key) => !currentLocations.has(key));
  const addedKeys = currentKeys.filter((key) => !previousLocations.has(key));

  const allowed = new Map<string, AllowedCitationRemoval>();
  const planned: RevisionPlanItem[] = (input.plan?.items ?? []).filter((item) => item.status === "planned");
  const evidenceItems = planned.filter((item) => item.needsEvidence === true);
  for (const key of removedKeys) {
    const files = [...(previousLocations.get(key) ?? [])];
    for (const item of planned) {
      if (item.kind === "citation_missing" && item.id.startsWith(`citation-missing:${key}:`)) {
        allowed.set(key, { key, basis: "planned_citation_missing", planItemId: item.id, section: item.section });
        break;
      }
      if (mentionedKeys(`${item.problem}\n${item.instruction}\n${item.expectedOutcome}`).includes(key)) {
        allowed.set(key, { key, basis: "planned_explicit_mention", planItemId: item.id, section: item.section });
        break;
      }
    }
    if (allowed.has(key)) {
      continue;
    }
    // 证据不足条目：计划明确允许弱化 / 删除论述——只承认 key 在 previous 中的全部出现
    // 都位于这类条目命中的章节内（删掉论述连带删掉其引用是合理的）
    if (evidenceItems.length > 0 && files.length > 0) {
      const covering = files.every((file) => evidenceItems.some((item) => sectionRefMatchesFile(item.section, file)));
      const item = evidenceItems.find((candidate) => sectionRefMatchesFile(candidate.section, files[0] ?? ""));
      if (covering && item !== undefined) {
        allowed.set(key, { key, basis: "planned_evidence_removal", planItemId: item.id, section: item.section });
        continue;
      }
    }
    for (const [index, item] of (input.improvementPlanItems ?? []).entries()) {
      if (mentionedKeys(`${item.action}\n${item.rationale ?? ""}`).includes(key)) {
        allowed.set(key, {
          key,
          basis: "improvement_plan_explicit_mention",
          planItemId: `improvement-plan:${index}`,
          section: item.section,
        });
        break;
      }
    }
  }

  const previousCount = countOccurrences(input.previous.files);
  const currentCount = countOccurrences(input.current.files);
  // 全部删光：只有显式依据（key 被点名）才算有计划；章节级证据条目不足以解释「一处引用都不剩」
  const explicitOnly = previousCount > 0 && currentCount === 0;
  if (explicitOnly) {
    for (const [key, entry] of [...allowed]) {
      if (entry.basis === "planned_evidence_removal") {
        allowed.delete(key);
      }
    }
  }
  const unexpectedRemovedKeys = removedKeys.filter((key) => !allowed.has(key));
  const catastrophic = explicitOnly && unexpectedRemovedKeys.length > 0;
  let historicalRegression: CitationPreservationSummary["historicalRegression"] = null;
  if (previousCount === 0 && currentCount === 0 && input.baseline !== undefined) {
    const baselineCount = countOccurrences(input.baseline.files);
    if (baselineCount > 0) {
      historicalRegression = { baselineRevision: input.baseline.revision, baselineCount };
    }
  }
  return {
    previousRevision: input.previous.revision,
    currentRevision: input.current.revision,
    previousCount,
    currentCount,
    previousKeys,
    currentKeys,
    removedKeys,
    addedKeys,
    allowedRemovedKeys: [...allowed.values()],
    unexpectedRemovedKeys,
    unexpectedRemoved: unexpectedRemovedKeys.map((key) => ({
      key,
      files: [...(previousLocations.get(key) ?? [])].sort(),
    })),
    catastrophic,
    historicalRegression,
    planId: input.plan?.planId ?? null,
    ok: unexpectedRemovedKeys.length === 0 && historicalRegression === null,
  };
}

/** Gate 规则 detail（不输出整篇论文；key 最多列 8 个） */
export function describeCitationPreservation(summary: CitationPreservationSummary): string {
  const sample = (keys: string[]) => (keys.length > 8 ? `${keys.slice(0, 8).join(",")},…` : keys.join(","));
  const base = `rev-${summary.previousRevision}→rev-${summary.currentRevision} 引用 ${summary.previousCount}→${summary.currentCount} 处，key ${summary.previousKeys.length}→${summary.currentKeys.length}`;
  if (summary.catastrophic) {
    return `${base}：全部引用被删除且无计划依据（无依据删除 ${summary.unexpectedRemovedKeys.length} 个 key：${sample(summary.unexpectedRemovedKeys)}）`;
  }
  if (summary.historicalRegression !== null) {
    return `${base}：历史回归——基线 rev-${summary.historicalRegression.baselineRevision} 有 ${summary.historicalRegression.baselineCount} 处引用，当前 0 处且未恢复`;
  }
  if (summary.unexpectedRemovedKeys.length > 0) {
    return `${base}：无依据删除 ${summary.unexpectedRemovedKeys.length} 个 key（${sample(summary.unexpectedRemovedKeys)}）；有计划删除 ${summary.allowedRemovedKeys.length} 个`;
  }
  const extras: string[] = [];
  if (summary.allowedRemovedKeys.length > 0) {
    extras.push(`有计划删除 ${summary.allowedRemovedKeys.length} 个`);
  }
  if (summary.addedKeys.length > 0) {
    extras.push(`新增 ${summary.addedKeys.length} 个（真实性由引用核验判定）`);
  }
  return extras.length > 0 ? `${base}；${extras.join("；")}` : `${base}；无 key 丢失`;
}

// ---- 工作流 / HTTP 共用的加载器 ----

export interface CitationPreservationDeps {
  projects: ProjectStore;
  revisions: ManuscriptRevisionStore;
  reviewArtifacts: ReviewArtifactStore;
}

/** 快照目录 → tex 文件（沿 main.tex \input 收集；无 main.tex 时退化为目录内全部 .tex） */
export async function readSnapshotTex(dir: string): Promise<CitationTexFile[] | null> {
  const collected = await collectLatexFiles(dir);
  if (collected.mainTex !== null) {
    return collected.allTex.map((file) => ({ file: file.relativePath, content: file.content }));
  }
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return null;
  }
  const files: CitationTexFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".tex")) {
      continue;
    }
    const parent = entry.parentPath ?? entry.path ?? dir;
    const relativePath = relative(dir, join(parent, entry.name)).replaceAll("\\", "/");
    try {
      files.push({ file: relativePath, content: await readFile(join(parent, entry.name), "utf8") });
    } catch {
      // 不可读文件跳过
    }
  }
  return files;
}

/**
 * 计算被审阅修订相对其前一修订的引用保持结果。
 * 返回 null = 不可比较（无前序修订 / 快照缺失 / reason=revision.restore），规则中性不参与。
 */
export async function computeCitationPreservation(
  deps: CitationPreservationDeps,
  projectId: string,
  reviewedRevision: number | undefined,
): Promise<CitationPreservationSummary | null> {
  const state = await deps.revisions.load(projectId);
  const current = typeof reviewedRevision === "number" && reviewedRevision > 0 ? reviewedRevision : state.current;
  if (current <= 0) {
    return null;
  }
  const ordered = [...state.revisions].sort((a, b) => a.revision - b.revision);
  const index = ordered.findIndex((record) => record.revision === current);
  if (index <= 0) {
    return null; // 无前序修订
  }
  const currentRecord = ordered[index]!;
  const previousRecord = ordered[index - 1]!;
  if (currentRecord.reason === "revision.restore") {
    return null; // 用户显式恢复历史修订：不是 Writer 改稿，不做保持比较
  }
  const [previousFiles, currentFiles] = await Promise.all([
    readSnapshotTex(deps.revisions.snapshotDir(projectId, previousRecord.revision)),
    readSnapshotTex(deps.revisions.snapshotDir(projectId, currentRecord.revision)),
  ]);
  if (previousFiles === null || currentFiles === null || previousFiles.length === 0) {
    return null; // 快照缺失（旧项目）：如实不可比较
  }
  const baselineRecord = ordered[0]!;
  const baselineFiles =
    baselineRecord.revision !== previousRecord.revision
      ? await readSnapshotTex(deps.revisions.snapshotDir(projectId, baselineRecord.revision))
      : null;
  // 承认删除依据的计划：sourceRevision == previous 的 quality 修订计划（最新轮优先）
  let plan: RevisionPlan | null = null;
  for (const round of await deps.reviewArtifacts.planRounds(projectId)) {
    const candidate = await deps.reviewArtifacts.loadPlan(projectId, round);
    if (
      candidate !== null &&
      candidate.sourceRevision === previousRecord.revision &&
      candidate.revisionReason !== "style_polish"
    ) {
      plan = candidate;
      break;
    }
  }
  const improvementPlanItems = await readImprovementPlanItems(deps.projects, projectId);
  return evaluateCitationPreservation({
    previous: { revision: previousRecord.revision, files: previousFiles },
    current: { revision: currentRecord.revision, files: currentFiles },
    ...(baselineFiles !== null && baselineFiles.length > 0
      ? { baseline: { revision: baselineRecord.revision, files: baselineFiles } }
      : {}),
    plan,
    ...(improvementPlanItems.length > 0 ? { improvementPlanItems } : {}),
  });
}

async function readImprovementPlanItems(
  projects: ProjectStore,
  projectId: string,
): Promise<{ section: string; action: string; rationale?: string }[]> {
  try {
    const parsed = JSON.parse(
      await readFile(join(projects.researchDir(projectId), "improvement-plan.json"), "utf8"),
    ) as { plan?: { items?: { section?: unknown; action?: unknown; rationale?: unknown }[] } };
    return (parsed.plan?.items ?? [])
      .filter((item) => typeof item.section === "string" && typeof item.action === "string")
      .map((item) => ({
        section: item.section as string,
        action: item.action as string,
        ...(typeof item.rationale === "string" ? { rationale: item.rationale } : {}),
      }));
  } catch {
    return [];
  }
}
