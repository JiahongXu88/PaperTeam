#!/usr/bin/env node
/**
 * M12.2.5 Linux 图表编译 smoke（容器内执行；CI docker cp 进去后 node 运行）。
 *
 * 验证 backend 镜像（TeX Live + texlive-latex-extra/texlive-pictures）真实链路：
 *   structured spec → pgfplots/TikZ codegen → xelatex → vector PDF
 * - line / grouped bar / scatter（pgfplots）+ pipeline 图（TikZ）
 * - CJK spec（ctex 导言 + Fandol 字体，Linux 中文本地渲染路径）
 * - specHash 缓存：同 spec 二次 generate → cached=true（零编译）
 * - 产物语义断言：figId 形态 / PDF %PDF- 魔数（不比对二进制 hash——TeX 元数据
 *   时间戳天然不同，语义一致即过）
 *
 * 运行环境假定：容器 /app/backend/dist 已构建（backend / backend-docling 目标均可）。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DIST = process.env.PAPERTEAM_FIGURE_SMOKE_DIST ?? "/app/backend/dist";
const url = (p) => pathToFileURL(join(DIST, p)).href;

const { FigureCompiler } = await import(url("figures/FigureCompiler.js"));
const { FigureStore } = await import(url("figures/figureStore.js"));
const { computeDatasetHash, validatePlotSpec, validateDiagramSpec } = await import(url("figures/spec.js"));

function normalizePlot(rawSpec) {
  const result = validatePlotSpec(rawSpec);
  if (!result.ok || result.spec === undefined) {
    throw new Error(`plot spec 非法：${result.errors.join("；")}`);
  }
  return result.spec;
}

function normalizeDiagram(rawSpec) {
  const result = validateDiagramSpec(rawSpec);
  if (!result.ok || result.spec === undefined) {
    throw new Error(`diagram spec 非法：${result.errors.join("；")}`);
  }
  return result.spec;
}

const cases = [];

// line：数值 x 多 series
{
  const dataset = {
    columns: ["x", "ours", "baseline"],
    rows: [
      [1, 3.5, 2.1],
      [2, 4.25, 2.8],
      [3, 5.5, 3.9],
    ],
  };
  cases.push({
    name: "line",
    kind: "plot",
    spec: normalizePlot({
      plotType: "line",
      data: {
        origin: { sourceId: "S001" },
        datasetHash: computeDatasetHash(dataset),
        x: ["x"],
        series: [
          { name: "Ours", column: "ours" },
          { name: "Baseline", column: "baseline" },
        ],
        inlineDataset: dataset,
      },
      axis: {},
    }),
  });
}

// grouped bar：类目轴
{
  const dataset = {
    columns: ["variant", "mota", "idsw"],
    rows: [
      ["baseline", 62.4, 118],
      ["w/o memory", 63.0, 101],
      ["full", 64.2, 87],
    ],
  };
  cases.push({
    name: "grouped_bar",
    kind: "plot",
    spec: normalizePlot({
      plotType: "grouped_bar",
      data: {
        origin: { sourceId: "S002" },
        datasetHash: computeDatasetHash(dataset),
        x: ["variant"],
        series: [
          { name: "MOTA", column: "mota" },
          { name: "IDSW", column: "idsw" },
        ],
        inlineDataset: dataset,
      },
      axis: {},
    }),
  });
}

// scatter
{
  const dataset = {
    columns: ["latency", "throughput"],
    rows: [
      [12.5, 3.1],
      [18.2, 4.4],
      [25.0, 5.9],
    ],
  };
  cases.push({
    name: "scatter",
    kind: "plot",
    spec: normalizePlot({
      plotType: "scatter",
      data: {
        origin: { sourceId: "S003" },
        datasetHash: computeDatasetHash(dataset),
        x: ["latency"],
        series: [{ name: "Serving", column: "throughput" }],
        inlineDataset: dataset,
      },
      axis: {},
    }),
  });
}

// TikZ pipeline 图（group 背景框必填至少一组）
cases.push({
  name: "tikz-pipeline",
  kind: "diagram",
  spec: normalizeDiagram({
    variant: "pipeline",
    layout: "vertical",
    title: "Pipeline",
    nodes: [
      { id: "input", label: "Input" },
      { id: "encoder", label: "Encoder", group: "core" },
      { id: "decoder", label: "Decoder", group: "core" },
      { id: "output", label: "Output" },
    ],
    edges: [
      { from: "input", to: "encoder" },
      { from: "encoder", to: "decoder" },
      { from: "decoder", to: "output" },
    ],
    groups: [{ id: "core", label: "Core" }],
  }),
});

// CJK：中文标题 + 中文 series 名 + 中文轴名（ctex 导言 + Fandol）
{
  const dataset = {
    columns: ["epoch", "loss"],
    rows: [
      [1, 2.8],
      [2, 2.1],
      [3, 1.6],
    ],
  };
  cases.push({
    name: "cjk-line",
    kind: "plot",
    spec: normalizePlot({
      plotType: "line",
      title: "训练损失曲线",
      data: {
        origin: { sourceId: "S004" },
        datasetHash: computeDatasetHash(dataset),
        x: ["epoch"],
        series: [{ name: "本文方法", column: "loss" }],
        inlineDataset: dataset,
      },
      axis: { xLabel: "轮次", yLabel: "损失" },
    }),
  });
}

// ---- 执行 ----

const root = await mkdtemp(join(tmpdir(), "pt-figure-smoke-"));
const storeDir = join(root, "figs", "generated");
const store = new FigureStore(storeDir);
const compiler = new FigureCompiler({ timeoutMs: 120_000 });
let failures = 0;

try {
  for (const testCase of cases) {
    const first = await compiler.generate({ kind: testCase.kind, spec: testCase.spec, store });
    if (!first.ok) {
      console.error(`[FAIL] ${testCase.name}: ${first.failure.kind} ${first.failure.message}`);
      failures += 1;
      continue;
    }
    const second = await compiler.generate({ kind: testCase.kind, spec: testCase.spec, store });
    const cachedOk = second.ok === true && second.cached === true;
    const pdfBytes = await readFile(join(storeDir, first.record.assets.pdf)).catch(() => null);
    const magicOk = pdfBytes !== null && pdfBytes.subarray(0, 5).toString("latin1") === "%PDF-";
    const figIdOk = /^fig-[0-9a-f]{12,64}$/.test(first.record.figId);
    if (!cachedOk || !magicOk || !figIdOk) {
      console.error(`[FAIL] ${testCase.name}: cached=${cachedOk} pdfMagic=${magicOk} figId=${figIdOk}`);
      failures += 1;
      continue;
    }
    console.log(`[PASS] ${testCase.name}: ${first.record.figId}（缓存二次命中 ✓ / %PDF- 魔数 ✓）`);
  }
  const manifest = await store.loadManifest();
  console.log(`manifest 收录 ${manifest.figures.length} 张图`);
  if (manifest.figures.length !== cases.length) {
    console.error(`[FAIL] manifest 数量 ${manifest.figures.length} ≠ 用例数 ${cases.length}`);
    failures += 1;
  }
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

if (failures > 0) {
  console.error(`\n${failures}/${cases.length} 用例失败`);
  process.exit(1);
}
console.log(`\n全部 ${cases.length} 个图表用例通过（真实 xelatex 编译 + 缓存 + 产物断言）。`);
