/**
 * Round 2 真实 run 回归（w-43cfc5703257 r6）：在已有稿件的项目上再次运行 idea_to_paper。
 *
 * - 新 run 的 outline.plan / writing.sections 提交整体重写章节文件——不是修订，
 *   Fact / Citation Preservation 对这类提交必须返回「不可比较」(null)，而不是把整篇
 *   重写判成「事实被删 / 占位替换 / 引用无依据删除」；
 * - 随后同一 run 内的 revision.revise 仍照常比较（守卫不放松）；
 * - iteration-history 跨 run 累积：收敛判定只在同一 run 内比较（iterationsForRun），
 *   旧记录（无 runId）不参与。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { EvidenceStore } from "../../src/evidence/EvidenceStore.js";
import { ManuscriptRevisionStore } from "../../src/manuscript/RevisionStore.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import { computeCitationPreservation } from "../../src/quality/citationPreservation.js";
import { computeFactPreservation, isFreshDraftCommit } from "../../src/quality/factPreservation.js";
import { ReviewArtifactStore } from "../../src/review/reviewArtifacts.js";
import { iterationsForRun, judgeConvergence, type IterationScorecard } from "../../src/review/revisionOutcome.js";

const tempRoots: string[] = [];
afterAll(async () => {
  for (const root of tempRoots.reverse()) await rm(root, { recursive: true, force: true });
});

const RUN6_RESULTS = [
  "\\section{实验结果}",
  "表~\\ref{tab:main}给出 Dev25 对比：IDSW 由 79 降至 67，HOTA 0.626126→0.628030。\\cite{k01} \\cite{k02}",
  "\\begin{table}[t]\\centering\\caption{主结果}\\label{tab:main}",
  "\\begin{tabular}{lcc}\\hline 配置 & IDSW & HOTA \\\\ \\hline 基座系统（对照） & 79 & 0.626126 \\\\ 完整系统 & 67 & 0.628030 \\\\ \\hline\\end{tabular}\\end{table}",
].join("\n");

/** 新 run 整体重写：同一事实换了表名 / 行标签 / 引用集合（这正是 r6 被判「删事实 + 删 key」的形态） */
const RUN7_RESULTS = [
  "\\section{实验结果与分析}",
  "\\subsection{Dev25 主结果}",
  "表~\\ref{tab:main-dev25} 列出两组配置的 IDSW 与 HOTA。\\cite{k01}",
  "\\begin{table}[t]\\centering\\caption{Dev25 主结果}\\label{tab:main-dev25}",
  "\\begin{tabular}{lcc}\\hline 配置 & IDSW & HOTA \\\\ \\hline 配置一 & 79 & 0.626126 \\\\ 配置二 & 67 & 0.628030 \\\\ \\hline\\end{tabular}\\end{table}",
].join("\n");

const MAIN_TEX = (marker: string): string =>
  `\\documentclass{ctexart}\n% ${marker}\n\\begin{document}\n\\input{sections/results}\n\\bibliography{references}\n\\end{document}\n`;

/** 每次提交都改动内容（RevisionStore.commit 对完全相同的内容幂等，不产生新修订） */
async function projectWithRevisions(revisions: { results: string; reason: string; main?: string }[]) {
  const root = await mkdtemp(join(tmpdir(), "paperteam-freshdraft-"));
  tempRoots.push(root);
  const projects = new ProjectStore({ root });
  const project = await projects.create("跨 run 新草稿");
  const store = new ManuscriptRevisionStore({ projects });
  const manuscriptDir = projects.manuscriptDir(project.id);
  await mkdir(join(manuscriptDir, "sections"), { recursive: true });
  await writeFile(join(manuscriptDir, "main.tex"), MAIN_TEX("v0"), "utf8");
  await writeFile(join(manuscriptDir, "references.bib"), "@article{k01, title={A}}\n@article{k02, title={B}}\n", "utf8");
  for (const entry of revisions) {
    if (entry.main !== undefined) {
      await writeFile(join(manuscriptDir, "main.tex"), entry.main, "utf8");
    }
    await writeFile(join(manuscriptDir, "sections", "results.tex"), entry.results, "utf8");
    const committed = await store.commit(project.id, entry.reason);
    if (!committed.created) {
      throw new Error(`test fixture: commit "${entry.reason}" did not create a revision (identical content)`);
    }
  }
  return {
    projects,
    revisions: store,
    reviewArtifacts: new ReviewArtifactStore(projects),
    evidence: new EvidenceStore(projects),
    projectId: project.id,
  };
}

describe("跨 run 新草稿提交不按修订语义做保持比较", () => {
  it("isFreshDraftCommit：outline.plan / writing.sections 为新草稿；修订类 reason 不是", () => {
    expect(isFreshDraftCommit("writing.sections")).toBe(true);
    expect(isFreshDraftCommit("outline.plan")).toBe(true);
    expect(isFreshDraftCommit("revision.revise")).toBe(false);
    expect(isFreshDraftCommit("revision.restore")).toBe(false);
    expect(isFreshDraftCommit("style_polish")).toBe(false);
    expect(isFreshDraftCommit(undefined)).toBe(false);
  });

  it("上一 run 终稿 → 新 run outline.plan / writing.sections 整体重写：Fact / Citation Preservation 均为 null（不可比较）", async () => {
    const deps = await projectWithRevisions([
      { results: RUN6_RESULTS, reason: "writing.sections" }, // run 6 终稿
      { results: RUN6_RESULTS, reason: "outline.plan", main: MAIN_TEX("run7-outline") }, // run 7 大纲（只动骨架）
      { results: RUN7_RESULTS, reason: "writing.sections" }, // run 7 写作：整体重写
    ]);
    const state = await deps.revisions.load(deps.projectId);
    expect(state.current).toBe(3);
    expect(await computeFactPreservation(deps, deps.projectId, 2)).toBeNull();
    expect(await computeCitationPreservation(deps, deps.projectId, 2)).toBeNull();
    expect(await computeFactPreservation(deps, deps.projectId, 3)).toBeNull();
    expect(await computeCitationPreservation(deps, deps.projectId, 3)).toBeNull();
  });

  it("同一 run 内随后的 revision.revise 仍照常比较（守卫不放松）：删表行 → 违规；删 key → unexpectedRemoved", async () => {
    const deps = await projectWithRevisions([
      { results: RUN6_RESULTS, reason: "writing.sections" },
      { results: RUN7_RESULTS, reason: "writing.sections" },
      {
        results: ["\\section{实验结果与分析}", "\\subsection{Dev25 主结果}", "本节数值待补。"].join("\n"),
        reason: "revision.revise",
      },
    ]);
    const fact = await computeFactPreservation(deps, deps.projectId, 3);
    expect(fact).not.toBeNull();
    expect(fact!.ok).toBe(false);
    expect(fact!.previousRevision).toBe(2);
    expect(fact!.removedFacts.length + fact!.placeholderRegressions.length).toBeGreaterThan(0);
    const citation = await computeCitationPreservation(deps, deps.projectId, 3);
    expect(citation).not.toBeNull();
    expect(citation!.unexpectedRemoved.map((entry) => entry.key)).toEqual(["k01"]);
  });
});

describe("iterationsForRun：收敛只在同一 run 内比较", () => {
  const card = (overrides: { critical?: number; factViolations?: number; citationViolations?: number } = {}): IterationScorecard => ({
    gatePassed: false,
    failedRuleIds: ["academic_score_threshold"],
    critical: overrides.critical ?? 0,
    major: 4,
    blocking: 1,
    academicScore: 54,
    styleRisk: 30,
    ...(overrides.factViolations !== undefined ? { factViolations: overrides.factViolations } : {}),
    ...(overrides.citationViolations !== undefined ? { citationViolations: overrides.citationViolations } : {}),
  });

  it("上一 run 的记录（含无 runId 的旧记录）不参与；新 run 首轮无上一轮 → convergence null", () => {
    const history = [
      { revision: 6, reviewRound: 3, gateRound: 3, outcome: null, completedAt: "t", scorecard: card() }, // 旧记录（无 runId）
      { revision: 7, reviewRound: 4, gateRound: 4, runId: "w-run6", outcome: null, completedAt: "t", scorecard: card() },
      { revision: 9, reviewRound: 5, gateRound: 5, runId: "w-run6", outcome: null, completedAt: "t", scorecard: card() },
    ];
    const own = iterationsForRun(history, "w-run7");
    expect(own).toEqual([]);
    const fresh = card({ critical: 2, factViolations: 22, citationViolations: 24 });
    expect(judgeConvergence([...own.map((record) => record.scorecard), fresh])).toBeNull();
    // 对照：若错误地混入上一 run 的记录，整篇重写会被判 REGRESSED
    expect(judgeConvergence([...history.map((record) => record.scorecard), fresh])).toBe("REGRESSED");
  });

  it("同一 run 的记录照常参与", () => {
    const history = [
      { revision: 11, reviewRound: 6, gateRound: 6, runId: "w-run7", outcome: null, completedAt: "t", scorecard: card({ critical: 2 }) },
      { revision: 12, reviewRound: 7, gateRound: 7, runId: "w-run7", outcome: null, completedAt: "t", scorecard: card({ critical: 1 }) },
    ];
    const own = iterationsForRun(history, "w-run7");
    expect(own).toHaveLength(2);
    expect(judgeConvergence([...own.map((record) => record.scorecard), card({ critical: 0 })])).toBe("PROGRESS");
  });
});
