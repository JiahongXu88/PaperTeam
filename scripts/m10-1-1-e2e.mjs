/**
 * M10.1.1 真实服务端到端验证（node dist 生产构建；本地 deterministic fixtures）。
 * 用法：node scripts/m10-1-1-e2e.mjs（需先 npm --prefix backend run build）
 *
 * 覆盖：MOT17 mini 工程项目（README.md / notes.txt / paper.tex / config.json /
 * experiment.yaml / train.py / helper.cpp / analysis.ipynb / results.csv /
 * results.xlsx / figure.png / sample.pdf）→ 统一上传（PDF 后台 docling、其余
 * 内联）→ ParsedDocument → chunk/index → 跨格式检索 + provenance →
 * JSON path 寻址 user_confirmed 确认。
 */

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createRequire } from "node:module";

const BASE = "http://127.0.0.1:8766";
const root = await mkdtemp(join(tmpdir(), "paperteam-m1011-e2e-"));
const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: new URL("../backend/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  env: {
    ...process.env,
    PAPERTEAM_PORT: "8766",
    PROJECTS_ROOT: join(root, "projects"),
    PAPERTEAM_TEST_RUNTIME: "scripted",
    PAPERTEAM_RUNTIME_ROOT: join(root, "runtime-root"),
    HF_ENDPOINT: process.env.HF_ENDPOINT ?? "https://hf-mirror.com",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logBuffer = "";
child.stdout.on("data", (d) => (logBuffer += d));
child.stderr.on("data", (d) => (logBuffer += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const busyWait = sleep;

async function api(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, body: json };
}

async function waitForServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch {}
    await busyWait(500);
  }
  throw new Error(`server not ready. log:\n${logBuffer.slice(-2000)}`);
}

let failed = false;
function check(name, condition, detail) {
  const mark = condition ? "PASS" : "FAIL";
  if (!condition) failed = true;
  console.log(`[${mark}] ${name}${condition ? "" : ` — ${detail ?? ""}`}`);
}

// ---- deterministic fixtures（全部本地生成；相互关联的 MOT17 迷你工程） ----

const README_MD = [
  "# MOT17 Tracking Experiment",
  "",
  "我们在 MOT17 数据集上复现 ByteTrack 基线并做了改进。",
  "训练配置见 config.json 与 experiment.yaml；入口脚本 train.py。",
  "最终结果：MOTA 从 78.2 提升到 82.4。",
  "",
  "## Setup",
  "",
  "PyTorch 2.x；结果表格见 results.csv。",
  "",
].join("\n");

const NOTES_TXT = ["实验日志", "", "backbone 使用 resnet50，输入分辨率 1088x608。", ""].join("\n");

const PAPER_TEX = [
  "\\documentclass{article}",
  "\\begin{document}",
  "\\section{Results}",
  "Our tracker reaches MOTA 82.4 on MOT17.",
  "\\section{Ablation}",
  "The learning rate schedule matters.",
  "\\end{document}",
  "",
].join("\n");

const CONFIG_JSON = JSON.stringify({
  dataset: "MOT17",
  seed: 42,
  training: { epochs: 100, batch_size: 8 },
});

const EXPERIMENT_YAML = ["dataset: MOT17", "training:", "  epochs: 100", "  batch_size: 8", "notes: baseline run", ""].join("\n");

const TRAIN_PY = [
  "# MOT17 training script",
  "import torch",
  "",
  "def main():",
  "    learning_rate = 0.001",
  "    weight_decay = 0.0005",
  "    print('training starts')",
  "",
].join("\n");

const HELPER_CPP = [
  "#include <vector>",
  "float iou(const Box& a, const Box& b) {",
  "    return a.area() > 0 ? overlap(a, b) / a.area() : 0.0f;",
  "}",
  "",
].join("\n");

const RESULTS_CSV = "Method,MOTA,IDF1\nOurs,82.4,79.1\nBaseline,78.2,75.0\n";

function buildNotebook(pngBase64) {
  return JSON.stringify({
    cells: [
      {
        cell_type: "markdown",
        id: "intro",
        source: ["# Result Analysis\n", "训练完成后分析 MOT17 结果。\n"],
      },
      {
        cell_type: "code",
        execution_count: 5,
        source: "import json\nwith open('config.json') as f:\n    cfg = json.load(f)\nprint('epochs =', cfg['training']['epochs'])",
        outputs: [{ output_type: "stream", name: "stdout", text: "epochs = 100\n" }],
      },
      {
        cell_type: "code",
        execution_count: 6,
        source: "print('final MOTA = 82.4')",
        outputs: [
          { output_type: "stream", name: "stdout", text: "final MOTA = 82.4\n" },
          { output_type: "display_data", data: { "image/png": pngBase64, "text/plain": "<Figure 640x480>" } },
        ],
      },
    ],
    metadata: { kernelspec: { name: "python3", language: "python" } },
    nbformat: 4,
    nbformat_minor: 5,
  });
}

async function buildXlsx() {
  // exceljs 是 backend 依赖（CJS）；E2E 从 backend 目录 resolve
  const require = createRequire(new URL("../backend/package.json", import.meta.url));
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(["Method", "MOTA", "IDF1"]);
  sheet.addRow(["Ours", 82.4, 79.1]);
  sheet.addRow(["Baseline", 78.2, 75.0]);
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function crc32(buffer) {
  let c = ~0;
  for (const byte of buffer) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function makePng(width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 2;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * stride + 1 + x * 3;
      raw[offset] = 30;
      raw[offset + 1] = (x * 255) / width | 0;
      raw[offset + 2] = (y * 255) / height | 0;
    }
  }
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdrData),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function upload(projectId, fileName, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  return api("POST", `/api/projects/${projectId}/sources`, {
    fileName,
    contentBase64: body.toString("base64"),
  });
}

async function search(projectId, query, topK = 10) {
  return api("POST", `/api/projects/${projectId}/retrieval/search`, { query, topK });
}

try {
  await waitForServer();
  console.log("server ready");

  // 1. 建项目
  const created = await api("POST", "/api/projects", { title: "M10.1.1 E2E" });
  check("create project", created.status === 201, JSON.stringify(created.body).slice(0, 200));
  const projectId = created.body.project?.id;

  // 2. 上传 MOT17 迷你工程（非 PDF 内联解析；PDF 后台）
  const png = makePng(96, 64);
  const notebook = buildNotebook(png.toString("base64"));
  const xlsx = await buildXlsx();
  const samplePdf = await readFile(
    new URL("../backend/test/fixtures/pdf/attention.pdf", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  );

  const uploads = [
    { fileName: "README.md", content: README_MD, kind: "markdown", minBlocks: 4 },
    { fileName: "notes.txt", content: NOTES_TXT, kind: "text", minBlocks: 2 },
    { fileName: "paper.tex", content: PAPER_TEX, kind: "latex", minBlocks: 5 },
    { fileName: "config.json", content: CONFIG_JSON, kind: "json", minBlocks: 4 },
    { fileName: "experiment.yaml", content: EXPERIMENT_YAML, kind: "yaml", minBlocks: 4 },
    { fileName: "train.py", content: TRAIN_PY, kind: "code", minBlocks: 1 },
    { fileName: "helper.cpp", content: HELPER_CPP, kind: "code", minBlocks: 1 },
    { fileName: "analysis.ipynb", content: notebook, kind: "notebook", minBlocks: 7 },
    { fileName: "results.csv", content: RESULTS_CSV, kind: "tabular", minBlocks: 2 },
    { fileName: "results.xlsx", content: xlsx, kind: "tabular", minBlocks: 2 },
    { fileName: "figure.png", content: png, kind: "image", minBlocks: 1 },
  ];
  const sourceIds = {};
  for (const item of uploads) {
    const response = await upload(projectId, item.fileName, item.content);
    const summary = response.body.ingestion;
    check(
      `upload ${item.fileName} → 201 inline ingestion ok`,
      response.status === 201 &&
        summary?.status === "ok" &&
        summary?.kind === item.kind &&
        summary?.blockCount >= item.minBlocks,
      `status=${response.status} ingestion=${JSON.stringify(summary).slice(0, 200)}`,
    );
    sourceIds[item.fileName] = response.body.source?.sourceId;
  }

  // 3. PDF 上传（后台 docling；轮询 document）
  const pdfUpload = await upload(projectId, "sample.pdf", samplePdf);
  check("upload sample.pdf → 201 pending", pdfUpload.status === 201 && pdfUpload.body.ingestion?.status === "pending");
  const pdfSourceId = pdfUpload.body.source?.sourceId;

  // 4. 结构保持断言（GET document blocks）
  const jsonDoc = await api(
    "GET",
    `/api/projects/${projectId}/sources/${sourceIds["config.json"]}/document?blocks=true`,
  );
  const jsonBlock = (jsonDoc.body.document?.blocks ?? []).find(
    (block) => block.provenance?.jsonPath === "$.training.epochs",
  );
  check(
    "config.json structured: $.training.epochs = 100",
    jsonBlock?.cells?.[0]?.value === "100",
    JSON.stringify(jsonDoc.body.document?.counts),
  );

  const pyDoc = await api(
    "GET",
    `/api/projects/${projectId}/sources/${sourceIds["train.py"]}/document?blocks=true`,
  );
  const codeBlock = (pyDoc.body.document?.blocks ?? []).find((block) => block.type === "code");
  check(
    "train.py code block: language=python + line provenance",
    codeBlock?.language === "python" && codeBlock?.provenance?.lineStart === 1 && codeBlock?.text.includes("learning_rate = 0.001"),
    JSON.stringify(codeBlock).slice(0, 200),
  );

  const nbDoc = await api(
    "GET",
    `/api/projects/${projectId}/sources/${sourceIds["analysis.ipynb"]}/document?blocks=true`,
  );
  const nbCounts = nbDoc.body.document?.counts ?? {};
  const nbFigure = (nbDoc.body.document?.blocks ?? []).find((block) => block.type === "figure");
  check(
    "notebook cells preserved: md/code/output counts + image output asset",
    (nbCounts.text ?? 0) >= 2 && (nbCounts.code ?? 0) >= 2 && (nbCounts.output ?? 0) >= 2 && (nbCounts.figure ?? 0) === 1 &&
      nbFigure?.assetName === "cell-2-output-1.png" && nbFigure?.width === 96,
    JSON.stringify(nbCounts) + JSON.stringify(nbFigure).slice(0, 120),
  );

  const imgDoc = await api(
    "GET",
    `/api/projects/${projectId}/sources/${sourceIds["figure.png"]}/document?blocks=true`,
  );
  const imgBlock = (imgDoc.body.document?.blocks ?? [])[0];
  check(
    "figure.png registered: image/png + 96x64 + asset",
    imgDoc.body.document?.mimeType === "image/png" && imgBlock?.width === 96 && imgBlock?.height === 64 && imgBlock?.assetName === "img-001.png",
    JSON.stringify(imgBlock).slice(0, 160),
  );

  // 5. 跨格式检索（upload 内联 ingest 后 chunk 已重建）
  const byQuery = {};
  for (const [label, query, expectText] of [
    ["epochs 定位 config.json", "epochs", "$.training.epochs=100"],
    ["learning rate 定位 train.py", "learning_rate", "learning_rate = 0.001"],
    ["MOTA 定位 CSV", "MOTA 82.4", "MOTA=82.4"],
    ["MOTA 定位 XLSX", "IDF1", "IDF1"],
    ["YAML batch_size 定位", "batch_size", "$.training.batch_size=8"],
    ["Notebook 结论定位 cell", "final MOTA", "final MOTA = 82.4"],
    ["README 事实定位", "ByteTrack 基线", "ByteTrack"],
    ["TXT 工程细节定位", "resnet50", "1088x608"],
    ["LaTeX 定位", "MOTA 82.4 on MOT17", "82.4"],
    ["C++ helper 定位", "iou", "iou"],
  ]) {
    const result = await search(projectId, query, 12);
    const results = result.body.results ?? [];
    byQuery[label] = results;
    const textHit = results.find((entry) => (entry.chunk?.text ?? "").includes(expectText));
    check(
      `search「${label}」命中期望内容`,
      result.status === 200 && textHit !== undefined,
      `results=${JSON.stringify(results.map((r) => r.chunk?.text?.slice(0, 60))).slice(0, 300)}`,
    );
  }

  // 6. provenance 断言：train.py 的命中 chunk 覆盖 learning_rate 行（第 5 行）
  const lrResults = byQuery["learning rate 定位 train.py"];
  const lrHit = (lrResults ?? []).find((entry) => (entry.chunk?.text ?? "").includes("learning_rate = 0.001"));
  check(
    "train.py chunk line provenance covers line 5",
    lrHit?.chunk?.lineStart !== undefined &&
      lrHit.chunk.lineStart <= 5 &&
      (lrHit.chunk.lineEnd ?? 0) >= 5,
    JSON.stringify(lrHit?.chunk?.lineStart) + "-" + JSON.stringify(lrHit?.chunk?.lineEnd),
  );

  // 7. JSON path 寻址 → user_confirmed Evidence（语义边界保持）
  const confirm = await api("POST", `/api/projects/${projectId}/sources/${sourceIds["config.json"]}/records/evidence`, {
    path: "$.training.epochs",
    claim: "训练轮数为 100 epochs",
  });
  check(
    "path confirm → 201 user_confirmed (unverified)",
    confirm.status === 201 &&
      confirm.body.evidence?.verificationLevel === "user_confirmed" &&
      confirm.body.evidence?.verificationStatus === "unverified" &&
      confirm.body.evidence?.location?.path === "$.training.epochs" &&
      confirm.body.evidence?.quote === "100",
    JSON.stringify(confirm.body).slice(0, 300),
  );
  const mismatch = await api("POST", `/api/projects/${projectId}/sources/${sourceIds["config.json"]}/records/evidence`, {
    path: "$.training.epochs",
    claim: "训练轮数其实是 50",
  });
  check("path mismatch → 422 EVIDENCE_VALUE_MISMATCH", mismatch.status === 422 && mismatch.body.error?.code === "EVIDENCE_VALUE_MISMATCH");

  // 8. PDF 后台 docling 完成轮询（15 页 ~40-90s）
  let pdfDocument = null;
  for (let i = 0; i < 120; i += 1) {
    await busyWait(2000);
    const response = await api("GET", `/api/projects/${projectId}/sources/${pdfSourceId}/document`);
    pdfDocument = response.body.document;
    if (pdfDocument !== null) break;
  }
  check(
    "sample.pdf structured docling document (table + figure + pages)",
    pdfDocument?.parser?.id === "docling" &&
      pdfDocument?.status === "ok" &&
      (pdfDocument?.counts?.table ?? 0) >= 1 &&
      (pdfDocument?.counts?.figure ?? 0) >= 1 &&
      pdfDocument?.pageCount === 15,
    JSON.stringify(pdfDocument).slice(0, 300),
  );
  const pdfSearch = await search(projectId, "attention", 8);
  const pdfHit = (pdfSearch.body.results ?? []).find((entry) => (entry.chunk?.pageStart ?? 0) >= 1);
  check(
    "PDF regression: searchable with page provenance",
    pdfSearch.status === 200 && pdfHit !== undefined,
    JSON.stringify((pdfSearch.body.results ?? [])[0]?.chunk?.text ?? "").slice(0, 120),
  );

  // 9. 全库 stats：12 个 source = 11 indexed（图片无文本层如实 skipped）
  const stats = await api("GET", `/api/projects/${projectId}/retrieval/stats`);
  const sourcesStats = stats.body.sources ?? {};
  check(
    "12 sources: 11 indexed + image skipped (honest)",
    (sourcesStats.total ?? 0) === 12 && sourcesStats.indexed === 11 && (sourcesStats.skipped ?? 0) === 1,
    JSON.stringify(sourcesStats),
  );

  console.log(failed ? "\nE2E: FAILED" : "\nE2E: ALL PASS");
} catch (error) {
  console.error("E2E crashed:", error);
  failed = true;
} finally {
  child.kill();
  await busyWait(1000);
  await rm(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
