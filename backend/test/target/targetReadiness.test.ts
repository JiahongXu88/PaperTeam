/**
 * TargetGapService（M12 Batch 2 · A8）单元测试。
 *
 * 覆盖：四档判决正确性（MEETS / PARTIALLY / BELOW / INSUFFICIENT——含语料
 * 不足与无手稿路径）/ gap-vs-defect 分离（差距恒为距离语义，不构成事实错误
 * 指控）/ 无手稿不 crash / provenance 区分 benchmark 观测与官方要求 /
 * 无数值分数门 / 观测口径披露（.tex 直接回退）/ get 容错。
 *
 * 断言策略：可精确控制的计数指标（表/图/引用 key/章节存在性）直接断言档位；
 * 词数类指标（受命令剥离口径影响）用 bandPosition 自洽断言（分位带语义本体
 * 另由 targetProfile golden 锁定）。
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ProjectStore } from "../../src/project/ProjectStore.js";
import type { TargetSummaryModel } from "../../src/target/TargetProfileService.js";
import { bandPosition } from "../../src/target/quantiles.js";
import type { TargetReadinessArtifact, TargetVerdict } from "../../src/target/types.js";
import { EIGHT_PAPERS, SIX_PAPERS, VALID_SUMMARY_JSON, setupTargetHarness } from "./profileFixtures.js";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function summaryModel(): TargetSummaryModel {
  return {
    caller: {
      async completeSimple() {
        return { content: [{ type: "text", text: VALID_SUMMARY_JSON }], stopReason: "stop" };
      },
    },
    catalogEntry: {},
    spec: "fake@test",
  };
}

function words(count: number): string {
  return Array.from({ length: count }, (_, index) => `t${index}`).join(" ");
}

interface ManuscriptSpec {
  abstractWords: number;
  /** intro / method / experiments / conclusion 词数；0 = 不写该 \section */
  sections: [number, number, number, number];
  citeKeys: number;
  tables: number;
  figures: number;
  figureCaptionOverview?: boolean;
  limitations?: boolean;
  ablation?: boolean;
}

async function writeManuscript(
  projects: ProjectStore,
  projectId: string,
  spec: ManuscriptSpec,
): Promise<void> {
  const dir = projects.manuscriptDir(projectId);
  await mkdir(dir, { recursive: true });
  const [w1, w2, w3, w4] = spec.sections;
  const cites = Array.from({ length: spec.citeKeys }, (_, index) => `k${index + 1}`).join(", ");
  const figures = Array.from(
    { length: spec.figures },
    (_, index) =>
      `\\begin{figure}\\includegraphics{fig${index + 1}.pdf}\\caption{${spec.figureCaptionOverview === true && index === 0 ? "Overview of the framework." : `Result ${index + 1}.`}}\\label{fig:f${index + 1}}\\end{figure}`,
  ).join("\n");
  const tables = Array.from(
    { length: spec.tables },
    (_, index) =>
      `\\begin{table}\\caption{Data ${index + 1}}\\label{tab:t${index + 1}}\\begin{tabular}{ll}a & b\\\\\\end{tabular}\\end{table}`,
  ).join("\n");
  const content = [
    "\\documentclass{article}",
    "\\begin{document}",
    `\\begin{abstract}${words(spec.abstractWords)}\\end{abstract}`,
    `\\section{Introduction}${words(w1)} \\cite{${cites}}`,
    ...(w2 > 0 ? [`\\section{Method}\\label{sec:method}${words(w2)}`] : []),
    `\\section{Experiments}${words(w3)}${spec.ablation ? " An ablation study follows." : ""}${spec.limitations ? " Limitations are discussed." : ""}`,
    figures,
    tables,
    ...(w4 > 0 ? [`\\section{Conclusion}${words(w4)}`] : []),
    "\\end{document}",
  ].join("\n");
  await writeFile(join(dir, "main.tex"), content, "utf8");
}

function entryOf(artifact: TargetReadinessArtifact, dimension: string) {
  const entry = artifact.dimensions.find((candidate) => candidate.dimension === dimension);
  if (entry === undefined) {
    throw new Error(`缺少维度 ${dimension}`);
  }
  return entry;
}

function verdictOf(artifact: TargetReadinessArtifact, dimension: string): TargetVerdict {
  return entryOf(artifact, dimension).verdict;
}

/** 词数类指标的自洽期望档位（inner→MEETS / outer→PARTIALLY / 越带→BELOW） */
function expectedBandVerdict(observed: number, band: { min: number; p25: number; p75: number; max: number }): TargetVerdict {
  const position = bandPosition(observed, { ...band, n: 1, median: band.p25 });
  if (position === "inner") {
    return "MEETS_TARGET";
  }
  if (position === "outer") {
    return "PARTIALLY_MEETS_TARGET";
  }
  return "BELOW_TARGET";
}

async function prepareHarness() {
  const harness = await setupTargetHarness(EIGHT_PAPERS, { summaryModel: summaryModel(), roots });
  const profile = await harness.profile.generate(harness.projectId);
  return { harness, profile };
}

describe("TargetGapService（A8）四档判决", () => {
  it("带内观测：计数指标 MEETS；词数指标与 bandPosition 一致；整体 PARTIALLY（定性维不判 MEETS）", async () => {
    const { harness, profile } = await prepareHarness();
    await writeManuscript(harness.projects, harness.projectId, {
      abstractWords: 200,
      sections: [1200, 1800, 1400, 1100],
      citeKeys: 27,
      tables: 5,
      figures: 7,
      figureCaptionOverview: true,
      limitations: true,
      ablation: true,
    });
    const artifact = await harness.gap.evaluate(harness.projectId);
    // 计数指标（可精确控制）：
    // tables 5 ∈ band [4..7] p25=4.75/p75=6.25 → MEETS
    expect(verdictOf(artifact, "experiments")).toBe("MEETS_TARGET");
    // figures 7 ∈ band [6..9] p25=6.75/p75=8.25 → MEETS（方法总览图存在）
    expect(verdictOf(artifact, "visuals")).toBe("MEETS_TARGET");
    // 引用 key 数 27 ∈ [20..34] 内带 → literature 由 density 决定，自洽断言：
    const literature = entryOf(artifact, "literature");
    const densityBand = profile.dimensions.literature.citationDensity!;
    const observedDensity = Number(/密度 ([\d.]+) key\/百词/.exec(literature.observed)?.[1] ?? NaN);
    expect(Number.isNaN(observedDensity)).toBe(false);
    expect(literature.verdict).toBe(expectedBandVerdict(observedDensity, densityBand));
    // 词数自洽：
    const structure = entryOf(artifact, "structure");
    const totalBand = profile.dimensions.structure.totalLengthWords!;
    const observedTotal = Number(/正文 (\d+) 词/.exec(structure.observed)?.[1] ?? NaN);
    expect(Number.isNaN(observedTotal)).toBe(false);
    expect(structure.verdict).toBe(expectedBandVerdict(observedTotal, totalBand));
    // 定性维度（method/writing）：确定性纪律不判 MEETS
    expect(verdictOf(artifact, "method")).toBe("PARTIALLY_MEETS_TARGET");
    expect(verdictOf(artifact, "writing")).toBe("PARTIALLY_MEETS_TARGET");
    // 整体：无 BELOW / 无 INSUFFICIENT，有 PARTIALLY → PARTIALLY
    expect(artifact.overall.verdict).toBe("PARTIALLY_MEETS_TARGET");
    expect(artifact.overall.summary).toContain("advisory");
  });

  it("BELOW：观测越出 min–max（正文极短 + 引用稀少 + 图表为零）", async () => {
    const { harness } = await prepareHarness();
    await writeManuscript(harness.projects, harness.projectId, {
      abstractWords: 30,
      sections: [50, 60, 50, 30],
      citeKeys: 2,
      tables: 0,
      figures: 0,
    });
    const artifact = await harness.gap.evaluate(harness.projectId);
    expect(verdictOf(artifact, "structure")).toBe("BELOW_TARGET");
    expect(verdictOf(artifact, "literature")).toBe("BELOW_TARGET");
    expect(verdictOf(artifact, "experiments")).toBe("BELOW_TARGET");
    expect(verdictOf(artifact, "visuals")).toBe("BELOW_TARGET");
    expect(artifact.overall.verdict).toBe("BELOW_TARGET");
    const structureGaps = entryOf(artifact, "structure").gaps;
    expect(structureGaps.some((gap) => gap.includes("totalLengthWords") && gap.includes("p25–p75"))).toBe(true);
  });

  it("PARTIALLY：正文落在 min–p25 之间（带内但低于中位带）", async () => {
    const { harness, profile } = await prepareHarness();
    const band = profile.dimensions.structure.totalLengthWords!;
    // 目标全文 ≈ (min+p25)/2 ≈ 4437 → outer 带 → PARTIALLY（其余计数指标内带）
    const target = Math.round((band.min + band.p25) / 2);
    await writeManuscript(harness.projects, harness.projectId, {
      abstractWords: 150,
      sections: [1100, 1500, 1000, Math.max(target - 150 - 3600 - 60, 100)],
      citeKeys: 27,
      tables: 5,
      figures: 7,
      figureCaptionOverview: true,
      limitations: true,
      ablation: true,
    });
    const artifact = await harness.gap.evaluate(harness.projectId);
    const structure = entryOf(artifact, "structure");
    const observedTotal = Number(/正文 (\d+) 词/.exec(structure.observed)?.[1] ?? NaN);
    expect(structure.verdict).toBe(expectedBandVerdict(observedTotal, band));
    expect(structure.verdict).toBe("PARTIALLY_MEETS_TARGET");
    expect(structure.gaps.some((gap) => gap.includes("目标带内但不在中位带") || gap.includes("低于目标带下限"))).toBe(true);
  });

  it("INSUFFICIENT_EVIDENCE：语料 n<5 → 全维带原因；产物无数值分数门", async () => {
    const harness = await setupTargetHarness(SIX_PAPERS.slice(0, 3), { summaryModel: summaryModel(), roots });
    await harness.profile.generate(harness.projectId);
    await writeManuscript(harness.projects, harness.projectId, {
      abstractWords: 150,
      sections: [500, 800, 600, 300],
      citeKeys: 20,
      tables: 4,
      figures: 6,
    });
    const artifact = await harness.gap.evaluate(harness.projectId);
    for (const dimension of ["structure", "literature", "experiments", "visuals", "method", "writing"]) {
      expect(verdictOf(artifact, dimension)).toBe("INSUFFICIENT_EVIDENCE");
      expect(entryOf(artifact, dimension).evidenceBasis).toContain("insufficient");
    }
    expect(artifact.overall.verdict).toBe("INSUFFICIENT_EVIDENCE");
    const serialized = JSON.stringify(artifact);
    expect(serialized).not.toMatch(/"targetScore"|"score"\s*:\s*\d/);
  });

  it("无手稿：全维 INSUFFICIENT_EVIDENCE、不 crash、observed 明示无观测点", async () => {
    const harness = await setupTargetHarness(EIGHT_PAPERS, { summaryModel: summaryModel(), roots });
    await harness.profile.generate(harness.projectId);
    const artifact = await harness.gap.evaluate(harness.projectId, { manuscriptRevision: null });
    expect(artifact.manuscriptRevision).toBeNull();
    for (const entry of artifact.dimensions) {
      expect(entry.verdict).toBe("INSUFFICIENT_EVIDENCE");
      expect(entry.observed).toContain("尚无手稿");
      expect(entry.gaps).toEqual([]);
    }
    expect(artifact.overall.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(artifact.overall.summary).toContain("当前无手稿");
  });

  it("缺方法章（带内 8/8 设方法章）→ method BELOW + 结构化 gap；structure 亦记差距", async () => {
    const { harness } = await prepareHarness();
    await writeManuscript(harness.projects, harness.projectId, {
      abstractWords: 180,
      sections: [1200, 0, 1600, 900], // 不写 Method 节
      citeKeys: 27,
      tables: 5,
      figures: 7,
      figureCaptionOverview: true,
      limitations: true,
      ablation: true,
    });
    const artifact = await harness.gap.evaluate(harness.projectId);
    expect(verdictOf(artifact, "method")).toBe("BELOW_TARGET");
    expect(entryOf(artifact, "method").gaps.some((gap) => gap.includes("[method/section:method]"))).toBe(true);
    expect(entryOf(artifact, "structure").gaps.some((gap) => gap.includes("section:method"))).toBe(true);
  });

  it("benchmark 未冻结 → NotFoundError（调用方决定 no-target 呈现）", async () => {
    const harness = await setupTargetHarness(EIGHT_PAPERS, { roots });
    await rm(join(harness.projects.researchDir(harness.projectId), "target-benchmark.json"), { force: true });
    await expect(harness.gap.evaluate(harness.projectId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("TargetGapService（A8）gap-vs-defect 分离与 provenance", () => {
  it("全部 gap 恒为距离语义（含「不构成稿件事实错误」限定语），无缺陷指控", async () => {
    const { harness } = await prepareHarness();
    await writeManuscript(harness.projects, harness.projectId, {
      abstractWords: 40,
      sections: [100, 120, 100, 60],
      citeKeys: 3,
      tables: 0,
      figures: 0,
    });
    const artifact = await harness.gap.evaluate(harness.projectId);
    const allGaps = artifact.dimensions.flatMap((entry) => entry.gaps);
    expect(allGaps.length).toBeGreaterThanOrEqual(4);
    for (const gap of allGaps) {
      expect(gap).toContain("不构成稿件事实错误");
      expect(gap).toContain("目标带");
      expect(gap).not.toMatch(/事实错误：|违规|缺陷/);
    }
  });

  it("provenance：明示 benchmark 观测 vs 官方要求（不冒充 guideline）", async () => {
    const { harness } = await prepareHarness();
    await writeManuscript(harness.projects, harness.projectId, {
      abstractWords: 150,
      sections: [800, 1000, 800, 400],
      citeKeys: 27,
      tables: 5,
      figures: 7,
    });
    const artifact = await harness.gap.evaluate(harness.projectId);
    expect(artifact.provenance.basis).toBe("benchmark_observation");
    expect(artifact.provenance.disclaimer).toContain("不是期刊/会议官方投稿要求");
    expect(artifact.overall.summary).toContain("benchmark 观测，非官方投稿要求");
    // targetRange 来自 profile 分位带
    expect(entryOf(artifact, "structure").targetRange).toContain("p25–p75");
  });

  it("观测口径披露：visualInventory 缺省时回退 .tex 计数且 evidenceBasis 如实说明", async () => {
    const { harness } = await prepareHarness();
    await writeManuscript(harness.projects, harness.projectId, {
      abstractWords: 150,
      sections: [800, 1000, 800, 400],
      citeKeys: 27,
      tables: 5,
      figures: 7,
    });
    const artifact = await harness.gap.evaluate(harness.projectId);
    expect(entryOf(artifact, "visuals").evidenceBasis).toContain("includegraphics");
    expect(entryOf(artifact, "visuals").observed).toContain("图 7 个");
    expect(entryOf(artifact, "experiments").observed).toContain("表 5 个");
  });

  it("get：未评估 → null；评估后可读回（含显式 manuscriptRevision）；损坏 → fail-closed", async () => {
    const harness = await setupTargetHarness(EIGHT_PAPERS, { summaryModel: summaryModel(), roots });
    expect(await harness.gap.get(harness.projectId)).toBeNull();
    await harness.profile.generate(harness.projectId);
    const artifact = await harness.gap.evaluate(harness.projectId, { manuscriptRevision: 3 });
    expect(artifact.manuscriptRevision).toBe(3);
    expect(await harness.gap.get(harness.projectId)).toEqual(artifact);
    await writeFile(join(harness.projects.researchDir(harness.projectId), "target-readiness.json"), "{broken", "utf8");
    await expect(harness.gap.get(harness.projectId)).rejects.toThrow(/损坏/);
  });
});
