/**
 * M15.19 Phase D — 候选级冻结口径只追究候选自身引入的违规。
 *
 * 真实来源（M15.18 S2 p-724f527d6766，replay 见 scripts/m1519/replay-candidate-facts.mjs）：rev-2 文件级路径删除了
 * sec01 的 PDF 封面 / 单位块（含邮编、单位上标等数值）；rev-3 的 sec02–sec05 span 候选在冻结口径（rev-1 → 候选）
 * 下全部继承这些删除，被判 unauthorized_fact_removal——候选本身与 sec01 无关。修复：冻结口径对「源修订、无候选」
 * 再评一次并多重集扣减；候选自身的删除 / 改值照常拦截；Quality Gate 的 cumulative 口径不变。
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { ManuscriptRevisionStore } from "../../src/manuscript/RevisionStore.js";
import { ReviewArtifactStore } from "../../src/review/reviewArtifacts.js";
import { EvidenceStore } from "../../src/evidence/EvidenceStore.js";
import {
  computeFactPreservationForCandidate,
  evaluateFactPreservation,
  ownFrozenFindings,
  subtractPreexistingFindings,
  type FactFinding,
} from "../../src/quality/factPreservation.js";
import { readSnapshotTex } from "../../src/quality/citationPreservation.js";

const SEC01_FROZEN = [
  "\\section{1 Introduction}",
  "",
  "Gioele Ciaparrone1,2, Francisco Herrera2",
  "1Department of Management and Innovation Systems, University of Salerno, 84084 Fisciano (SA), Italy",
  "2Andalusian Research Institute in Data Science, University of Granada, 18071 Granada, Spain",
  "",
  "Multiple Object Tracking is a computer vision task.",
  "",
].join("\n");
const SEC01_COVER_REMOVED = ["\\section{1 Introduction}", "", "Multiple Object Tracking is a computer vision task.", ""].join("\n");
const SEC02 = [
  "\\section{2 Method}",
  "",
  "Our tracker reaches 71.2 MOTA on MOT17 and runs at 25 FPS.",
  "",
  "The association step is described below.",
  "",
].join("\n");

describe("subtractPreexistingFindings（多重集扣减 + fail-closed）", () => {
  const finding = (before: string, file = "sections/sec01.tex"): FactFinding => ({ kind: "removed", file, section: "s", before, after: "", reason: "prose_number" });

  it("只扣减与源修订完全相同的既有违规；同片段多次出现按次数扣减", () => {
    const pre = [finding("84084 Fisciano"), finding("84084 Fisciano")];
    const candidate = [finding("84084 Fisciano"), finding("84084 Fisciano"), finding("84084 Fisciano"), finding("71.2 MOTA", "sections/sec02.tex")];
    expect(subtractPreexistingFindings(candidate, pre).map((entry) => entry.before)).toEqual(["84084 Fisciano", "71.2 MOTA"]);
  });

  it("片段不同（候选改动了既有违规附近文字）→ 不扣减（宁可多报）", () => {
    expect(subtractPreexistingFindings([finding("84084 Fisciano, Italy")], [finding("84084 Fisciano")])).toHaveLength(1);
  });

  it("候选口径桶已达上限（可能截断了候选自身违规）→ 不扣减（保持旧口径）", () => {
    const full = Array.from({ length: 30 }, (_, index) => finding(`n${index}`));
    expect(subtractPreexistingFindings(full, full)).toHaveLength(30);
  });

  it("ownFrozenFindings：无源修订口径 → 原样", () => {
    const summary = evaluateFactPreservation({
      previous: { revision: 1, files: [{ file: "sections/sec01.tex", content: SEC01_FROZEN }] },
      current: { revision: 2, files: [{ file: "sections/sec01.tex", content: SEC01_COVER_REMOVED }] },
      plan: null,
      evidenceTexts: [],
      weakeningAuthorizations: [],
    });
    expect(summary.removedFacts.length).toBeGreaterThan(0);
    expect(ownFrozenFindings(summary, null).removedFacts).toEqual(summary.removedFacts);
  });
});

describe("computeFactPreservationForCandidate：其他文件既有累计漂移不再归因到候选（真实 S2 形态）", () => {
  let root: string;
  let projects: ProjectStore;
  let revisions: ManuscriptRevisionStore;
  let deps: Parameters<typeof computeFactPreservationForCandidate>[0];
  let projectId: string;
  const write = async (sec01: string, sec02: string) => {
    const dir = join(projects.manuscriptDir(projectId), "sections");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "sec01.tex"), sec01, "utf8");
    await writeFile(join(dir, "sec02.tex"), sec02, "utf8");
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperteam-m1519-fact-"));
    projects = new ProjectStore({ root });
    revisions = new ManuscriptRevisionStore({ projects });
    deps = { projects, revisions, reviewArtifacts: new ReviewArtifactStore(projects), evidence: new EvidenceStore(projects) };
    projectId = (await projects.create("m1519 fact", { documentType: "research_article" })).id;
    await write(SEC01_FROZEN, SEC02);
    expect((await revisions.commit(projectId, "import.baseline")).revision).toBe(1); // 冻结基线
    await write(SEC01_COVER_REMOVED, SEC02); // 文件级路径已落盘的 sec01 封面删除（既有漂移）
    expect((await revisions.commit(projectId, "revision.apply")).revision).toBe(2);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const candidateFiles = async (sec02: string) => {
    const source = (await readSnapshotTex(revisions.snapshotDir(projectId, 2)))!;
    return source.map((file) => (file.file === "sections/sec02.tex" ? { ...file, content: sec02 } : file));
  };

  it("红 → 绿：源修订已有 sec01 删除；sec02 的无事实变化候选不再被这些删除拒绝", async () => {
    // 修复前口径（冻结 rev1 → 候选，无扣减）确实包含 sec01 的删除——即 M15.18 21 个候选被拒的形态
    const frozenFiles = (await readSnapshotTex(revisions.snapshotDir(projectId, 1)))!;
    const benign = await candidateFiles(SEC02.replace("The association step is described below.", "The association step is detailed in the next paragraph."));
    const unsubtracted = evaluateFactPreservation({ previous: { revision: 1, files: frozenFiles }, current: { revision: 3, files: benign }, plan: null, evidenceTexts: [], weakeningAuthorizations: [], strictPlanTextAuthorization: true });
    expect(unsubtracted.removedFacts.some((entry) => entry.file === "sections/sec01.tex")).toBe(true);
    // 修复后：候选只为自身负责
    const fact = await computeFactPreservationForCandidate(deps, projectId, 2, benign);
    expect(fact?.removedFacts.filter((entry) => entry.file === "sections/sec01.tex")).toEqual([]);
    expect(fact?.ok).toBe(true);
  });

  it("候选自身删除数值事实 → 仍被拦截（守卫强度不变）", async () => {
    const removing = await candidateFiles(SEC02.replace("reaches 71.2 MOTA on MOT17 and runs at 25 FPS", "reaches strong MOTA on MOT17 and runs in real time"));
    const fact = await computeFactPreservationForCandidate(deps, projectId, 2, removing);
    expect(fact?.ok).toBe(false);
    expect(fact?.removedFacts.some((entry) => entry.file === "sections/sec02.tex")).toBe(true);
    expect(fact?.removedFacts.some((entry) => entry.file === "sections/sec01.tex")).toBe(false);
  });

  it("候选把既有删除的封面数值写回到 sec02（M15.18 修复轮真实形态）→ added 违规照常拦截", async () => {
    const pasting = await candidateFiles(`${SEC02}\n2Andalusian Research Institute in Data Science, University of Granada, 18071 Granada, Spain\n`);
    const fact = await computeFactPreservationForCandidate(deps, projectId, 2, pasting);
    expect(fact?.ok).toBe(false);
  });
});
