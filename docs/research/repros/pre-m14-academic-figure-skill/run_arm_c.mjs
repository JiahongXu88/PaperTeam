// Arm C — PaperTeam's existing deterministic FigureCompiler (pgfplots/TikZ via xelatex), zero model calls.
// Uses the built backend (backend/dist) read-only; writes only under this evaluation directory.
// Run:  node run_arm_c.mjs
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL_ROOT = join(HERE, "..");
const BACKEND_DIST = "D:/Projects/PaperTeam/backend/dist";
const TASKS = join(EVAL_ROOT, "tasks");
const OUT = join(HERE, "out");

const { FigureCompiler } = await import(pathToFileURL(join(BACKEND_DIST, "figures/FigureCompiler.js")).href);
const { FigureStore } = await import(pathToFileURL(join(BACKEND_DIST, "figures/figureStore.js")).href);
const { computeDatasetHash } = await import(pathToFileURL(join(BACKEND_DIST, "figures/spec.js")).href);

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  const header = lines[0].split(",");
  return lines.slice(1).map((l) => Object.fromEntries(l.split(",").map((v, i) => [header[i], v])));
}
const num = (v) => (v === "" || v === undefined ? null : Number(v));

async function csv(task, file = "data.csv") {
  return parseCsv(await readFile(join(TASKS, task, file), "utf8"));
}

function manual(note) {
  return { origin: "manual", note };
}

function plotSpec({ plotType, title, caption, columns, rows, x, series, xLabel, yLabel, widthCm, heightCm, semantic }) {
  const inlineDataset = { columns, rows };
  return {
    plotType,
    ...(semantic ? { semantic } : {}),
    title,
    caption,
    data: {
      origin: manual("Pre-M14 evaluation arm C: synthetic benchmark dataset copied verbatim from tasks/<id>/ (operator-pivoted to wide form where required)"),
      datasetHash: computeDatasetHash(inlineDataset),
      x: [x],
      series,
      missingPolicy: "reject",
      inlineDataset,
    },
    axis: { xLabel, yLabel, legend: true, renderOptions: { widthCm, heightCm, markSizePt: 1.5 } },
  };
}

async function buildSpecs() {
  const specs = [];
  // t1 grouped_bar: wide pivot dataset × method
  {
    const rows = await csv("t1_grouped_bar_en");
    const methods = ["SORT", "DeepSORT", "ByteTrack", "Ours"];
    const datasets = ["MOT17", "MOT20", "DanceTrack"];
    const wide = datasets.map((d) => [d, ...methods.map((m) => num(rows.find((r) => r.dataset === d && r.method === m).hota_mean))]);
    specs.push({
      task: "t1_grouped_bar_en", kind: "plot",
      note: "hota_std (error bars) cannot be expressed: PlotSpec has no error column; n_seeds dropped.",
      spec: plotSpec({ plotType: "grouped_bar", semantic: "benchmark_comparison", title: undefined, caption: "HOTA of four trackers on three benchmarks (mean over 3 seeds).", columns: ["dataset", ...methods], rows: wide, x: "dataset", series: methods.map((m) => ({ name: m, column: m })), xLabel: "Benchmark", yLabel: "HOTA (%)", widthCm: 8.6, heightCm: 6 }),
    });
  }
  // t2 bar zh
  {
    const rows = await csv("t2_ablation_zh");
    specs.push({
      task: "t2_ablation_zh", kind: "plot",
      note: "idf1_std (误差棒) 无法表达；n_runs 丢弃。",
      spec: plotSpec({ plotType: "bar", semantic: "ablation", caption: "消融实验：去除各模块后的 IDF1。", columns: ["variant", "idf1_mean"], rows: rows.map((r) => [r.variant, num(r.idf1_mean)]), x: "variant", series: [{ name: "IDF1", column: "idf1_mean" }], xLabel: "模型变体", yLabel: "IDF1 (%)", widthCm: 14, heightCm: 7.5 }),
    });
  }
  // t3 line: per-epoch mean across seeds (operator aggregation — PlotSpec cannot aggregate or draw bands)
  {
    const rows = await csv("t3_training_curves_en");
    const methods = ["Baseline", "Baseline+Aug", "Ours"];
    const epochs = [...new Set(rows.map((r) => Number(r.epoch)))].sort((a, b) => a - b);
    const mean = (m, e) => {
      const v = rows.filter((r) => r.method === m && Number(r.epoch) === e).map((r) => Number(r.val_map));
      return Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100;
    };
    const wide = epochs.map((e) => [e, ...methods.map((m) => mean(m, e))]);
    specs.push({
      task: "t3_training_curves_en", kind: "plot",
      note: "Operator pre-aggregated seed means (PlotSpec has no groupby); ±1 std band cannot be expressed.",
      spec: plotSpec({ plotType: "line", caption: "Validation mAP vs epoch (mean over 3 seeds).", columns: ["epoch", ...methods], rows: wide, x: "epoch", series: methods.map((m) => ({ name: m, column: m })), xLabel: "Epoch", yLabel: "Validation mAP (%)", widthCm: 8.6, heightCm: 6 }),
    });
  }
  // t7 diagram
  {
    const d = JSON.parse(await readFile(join(TASKS, "t7_pipeline_diagram_en", "diagram.json"), "utf8"));
    specs.push({
      task: "t7_pipeline_diagram_en", kind: "diagram",
      note: "DiagramSpec pipeline variant; side module (memory bank) has no dedicated role → rendered as a stage; bidirectional edge pair preserved as two edges.",
      spec: { layout: "horizontal", variant: "pipeline", title: d.title, groups: d.groups, nodes: d.nodes.map((n) => ({ id: n.id, label: n.label, ...(n.group ? { group: n.group } : {}) })), edges: d.edges },
    });
    // Variant with the feedback edge (mgmt -> mem) removed, to show what the v1 DAG-only template renders.
    specs.push({
      task: "t7_pipeline_diagram_en__nocycle", kind: "diagram",
      note: "MODIFIED SPEC: feedback edge mgmt->mem dropped so the DAG constraint holds; not the author's diagram.",
      spec: { layout: "horizontal", variant: "pipeline", title: d.title, groups: d.groups, nodes: d.nodes.map((n) => ({ id: n.id, label: n.label, ...(n.group ? { group: n.group } : {}) })), edges: d.edges.filter((e) => !(e.from === "mgmt" && e.to === "mem")) },
    });
  }
  // t8 scatter
  {
    const rows = await csv("t8_pareto_scatter_en");
    specs.push({
      task: "t8_pareto_scatter_en", kind: "plot",
      note: "No point labels, no Pareto frontier, no log axis in PlotSpec; params_m dropped.",
      spec: plotSpec({ plotType: "scatter", caption: "Speed–accuracy scatter of 12 trackers.", columns: ["fps", "hota"], rows: rows.map((r) => [num(r.fps), num(r.hota)]), x: "fps", series: [{ name: "HOTA", column: "hota" }], xLabel: "Speed (FPS)", yLabel: "HOTA (%)", widthCm: 8.6, heightCm: 6.5 }),
    });
  }
  return specs;
}

async function main() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const store = new FigureStore(join(OUT, "store"));
  const compiler = new FigureCompiler({ timeoutMs: 180_000, buildRootDir: join(OUT, "buildtmp") });
  const results = [];
  for (const s of await buildSpecs()) {
    const t0 = Date.now();
    const outcome = await compiler.generate({ kind: s.kind, spec: s.spec, store });
    const ms = Date.now() - t0;
    const entry = { task: s.task, kind: s.kind, note: s.note, ok: outcome.ok, ms };
    if (outcome.ok) {
      entry.figId = outcome.record.figId;
      entry.cached = outcome.cached;
      entry.pdf = join(OUT, "store", outcome.record.assets.pdf);
      entry.tex = join(OUT, "store", outcome.record.assets.tex);
      entry.compileMs = outcome.record.compileMs ?? null;
    } else {
      entry.failure = outcome.failure;
    }
    await writeFile(join(OUT, `${s.task}.spec.json`), JSON.stringify(s.spec, null, 2), "utf8");
    results.push(entry);
    console.log(JSON.stringify(entry));
  }
  for (const t of ["t4_confusion_heatmap_en", "t5_distribution_en", "t6_multipanel_zh"]) {
    results.push({ task: t, ok: false, unsupported: true, note: "No PlotSpec plotType for heatmap / box-violin / multi-panel composition." });
  }
  await writeFile(join(OUT, "arm_c_results.json"), JSON.stringify(results, null, 2), "utf8");
}
await main();
