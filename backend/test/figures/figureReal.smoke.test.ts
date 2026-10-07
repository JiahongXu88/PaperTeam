/**
 * M12 Batch 1 Smoke C：真实 xelatex + pgfplots/TikZ 编译集成。
 *
 * 与 FigureCompiler.test.ts（fake CommandRunner）的区别：本文件跑真实工具链
 * （本机 / CI 镜像有 xelatex 时执行；无 TeX 环境时整体 skip，不算失败——
 * 与 LatexCompiler.test.ts 的「真实编译集成」同款门控）。验证：
 * - PlotSpec（line 数值 x 多 series）+（grouped_bar 类目轴 semantic=ablation）
 *   → pgfplots → 真实 vector PDF（%PDF- 魔数）
 * - DiagramSpec（pipeline DAG + annotation + group）→ TikZ → 真实 vector PDF
 * - specHash 缓存：第二次 generate 同 spec → cached=true（零编译）
 * - manifest lineage：spec.json / .tex / .pdf 三资产 + datasetHash/dataOrigin
 *
 * Spec 合法性边界顺带被锁定：line 不接受字符串 x（类目轴须 bar/grouped_bar）、
 * edges 成环被显式拒绝（v1 只支持 DAG）——见文末两个负例断言。
 */

import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { FigureCompiler } from "../../src/figures/FigureCompiler.js";
import { FigureStore } from "../../src/figures/figureStore.js";
import { validatePlotSpec, validateDiagramSpec } from "../../src/figures/spec.js";
import { fingerprintJson } from "../../src/util/hash.js";

const execFileAsync = promisify(execFile);

async function xelatexAvailable(): Promise<boolean> {
  try {
    await execFileAsync("xelatex", ["--version"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const hasTex = await xelatexAvailable();

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

async function newStore(prefix: string): Promise<FigureStore> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(root);
  return new FigureStore(join(root, "figs", "generated"));
}

/** 消融数据集（类目轴：variant；grouped_bar 用） */
const ABLATION_DATASET = {
  columns: ["variant", "mota", "idsw"],
  rows: [
    ["baseline", 62.4, 118],
    ["w/o memory", 63.0, 101],
    ["full model", 65.1, 79],
  ],
} as const;

/** 收敛数据集（数值 x：epoch；line 用） */
const CONVERGENCE_DATASET = {
  columns: ["epoch", "trainLoss", "valLoss"],
  rows: [
    [1, 2.31, 2.42],
    [5, 1.02, 1.31],
    [10, 0.61, 0.88],
    [20, 0.42, 0.71],
    [30, 0.35, 0.69],
  ],
} as const;

const LINE_PLOT_SPEC = {
  plotType: "line",
  title: "Training convergence",
  data: {
    origin: { origin: "manual", note: "smoke fixture：收敛曲线数据" },
    datasetHash: fingerprintJson(CONVERGENCE_DATASET),
    x: ["epoch"],
    series: [
      { name: "Train loss", column: "trainLoss" },
      { name: "Val loss", column: "valLoss" },
    ],
    inlineDataset: CONVERGENCE_DATASET,
  },
  axis: { xLabel: "Epoch", yLabel: "Loss" },
};

const GROUPED_BAR_SPEC = {
  plotType: "grouped_bar",
  semantic: "ablation",
  title: "Ablation: MOTA vs IDS by variant",
  data: {
    origin: { origin: "manual", note: "smoke fixture：消融实验汇总表" },
    datasetHash: fingerprintJson(ABLATION_DATASET),
    x: ["variant"],
    series: [
      { name: "MOTA", column: "mota" },
      { name: "IDS", column: "idsw" },
    ],
    inlineDataset: ABLATION_DATASET,
  },
  axis: { xLabel: "Variant", yLabel: "Score / Count" },
};

const PIPELINE_DIAGRAM_SPEC = {
  layout: "horizontal",
  variant: "pipeline",
  title: "Tracking pipeline overview",
  nodes: [
    { id: "detect", label: "Detector" },
    { id: "embed", label: "ReID Embedding" },
    { id: "assoc", label: "Association" },
    { id: "track", label: "Track Memory", group: "core" },
    { id: "note1", label: "EMA gated", role: "annotation" },
  ],
  edges: [
    { from: "detect", to: "embed" },
    { from: "embed", to: "assoc" },
    { from: "assoc", to: "track" },
    { from: "note1", to: "track" },
  ],
  groups: [{ id: "core", label: "Core" }],
};

describe.skipIf(!hasTex)("M12 Batch 1 Smoke C：FigureCompiler 真实编译（xelatex + pgfplots/tikz）", () => {
  it(
    "PlotSpec → pgfplots → 真实 vector PDF；同 spec 二次生成 cache 命中零编译",
    { timeout: 180_000 },
    async () => {
      const store = await newStore("paperteam-figsmoke1-");
      const compiler = new FigureCompiler({ timeoutMs: 120_000 });

      const first = await compiler.generate({ kind: "plot", spec: LINE_PLOT_SPEC, store });
      expect(first.ok).toBe(true);
      if (!first.ok) {
        throw new Error(first.failure.message);
      }
      expect(first.cached).toBe(false);
      expect(first.record.figId).toMatch(/^fig-[0-9a-f]{12}$/);

      const pdfBytes = await readFile(store.assetPath(first.record, "pdf"));
      expect(pdfBytes.subarray(0, 4).toString("latin1")).toBe("%PDF"); // vector PDF 魔数
      const tex = await readFile(store.assetPath(first.record, "tex"), "utf8");
      expect(tex).toContain("\\usepackage{pgfplots}");
      expect(tex).toContain("\\pgfplotsset{compat=1.18}");
      expect(first.record.datasetHash).toBe(fingerprintJson(CONVERGENCE_DATASET));

      // ---- 缓存：同 spec → cached=true（不重编译） ----
      const second = await compiler.generate({ kind: "plot", spec: LINE_PLOT_SPEC, store });
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.cached).toBe(true);
        expect(second.record.figId).toBe(first.record.figId);
      }

      // ---- manifest lineage ----
      const manifest = JSON.parse(await readFile(store.manifestPath, "utf8"));
      const entry = manifest.figures.find(
        (figure: { figId: string }) => figure.figId === first.record.figId,
      );
      expect(entry).toMatchObject({
        kind: "plot",
        datasetHash: fingerprintJson(CONVERGENCE_DATASET),
        dataOrigin: { origin: "manual" },
      });
    },
  );

  it(
    "grouped_bar（类目轴 + semantic=ablation）→ 真实 vector PDF",
    { timeout: 180_000 },
    async () => {
      const store = await newStore("paperteam-figsmoke2-");
      const compiler = new FigureCompiler({ timeoutMs: 120_000 });
      const outcome = await compiler.generate({ kind: "plot", spec: GROUPED_BAR_SPEC, store });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        throw new Error(outcome.failure.message);
      }
      const pdfBytes = await readFile(store.assetPath(outcome.record, "pdf"));
      expect(pdfBytes.subarray(0, 4).toString("latin1")).toBe("%PDF");
    },
  );

  it(
    "DiagramSpec → TikZ → 真实 vector PDF（pipeline DAG + annotation + group）",
    { timeout: 180_000 },
    async () => {
      const store = await newStore("paperteam-figsmoke3-");
      const compiler = new FigureCompiler({ timeoutMs: 120_000 });
      const outcome = await compiler.generate({ kind: "diagram", spec: PIPELINE_DIAGRAM_SPEC, store });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        throw new Error(`${outcome.failure.kind}: ${outcome.failure.message}`);
      }
      const pdfBytes = await readFile(store.assetPath(outcome.record, "pdf"));
      expect(pdfBytes.subarray(0, 4).toString("latin1")).toBe("%PDF");
      const tex = await readFile(store.assetPath(outcome.record, "tex"), "utf8");
      expect(tex).toContain("\\usetikzlibrary{positioning");
    },
  );
});

describe("Smoke C 附带：spec 合法性边界（无 TeX 环境也运行）", () => {
  it("line 拒绝字符串 x（类目轴须 bar / grouped_bar）", () => {
    const bad = validatePlotSpec({
      ...LINE_PLOT_SPEC,
      data: {
        ...LINE_PLOT_SPEC.data,
        x: ["variant"],
        datasetHash: fingerprintJson(ABLATION_DATASET),
        inlineDataset: ABLATION_DATASET,
      },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.some((error) => error.includes("不支持字符串 x"))).toBe(true);
    }
  });

  it("edges 成环被显式拒绝（v1 只支持 DAG）", () => {
    const cyclic = validateDiagramSpec({
      ...PIPELINE_DIAGRAM_SPEC,
      edges: [...PIPELINE_DIAGRAM_SPEC.edges, { from: "track", to: "assoc", label: "feedback" }],
    });
    expect(cyclic.ok).toBe(false);
    if (!cyclic.ok) {
      expect(cyclic.errors.some((error) => error.includes("环"))).toBe(true);
    }
  });
});
