/**
 * M10.2 真实服务端到端验证（node dist 生产构建；deterministic fixtures +
 * scripted Vision 假模型；ingestion / docling / 检索 / Evidence 全真实）。
 * 用法：node scripts/m10-2-e2e.mjs（需先 npm --prefix backend run build）
 *
 * 覆盖（§28）：sample.pdf（PyMuPDF 生成，内嵌折线图 + caption + 前后文）/
 * plot.png（上传图片）/ analysis.ipynb（Notebook 图片输出）→ upload →
 * ingest（PDF 真实 docling）→ vision analyze → 状态轮询 → FigureAnalysis →
 * search（provenance）→ candidate fact → user confirm → user_confirmed
 * Evidence（≠ grounded_verified）→ 重复 analyze 命中 freshness。
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "http://127.0.0.1:8769";
const root = await mkdtemp(join(tmpdir(), "paperteam-m102-e2e-"));
const fixturesDir = join(root, "fixtures");
const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: new URL("../backend/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  env: {
    ...process.env,
    PAPERTEAM_PORT: "8769",
    PROJECTS_ROOT: join(root, "projects"),
    PAPERTEAM_RUNTIME_ROOT: join(root, "runtime-root"),
    PAPERTEAM_TEST_RUNTIME: "scripted",
    PAPERTEAM_TEST_VISION: "scripted",
    HF_ENDPOINT: process.env.HF_ENDPOINT ?? "https://hf-mirror.com",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logBuffer = "";
child.stdout.on("data", (d) => (logBuffer += d));
child.stderr.on("data", (d) => (logBuffer += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    await sleep(500);
  }
  throw new Error(`server not ready. log:\n${logBuffer.slice(-2000)}`);
}

let failed = false;
function check(name, condition, detail) {
  const mark = condition ? "PASS" : "FAIL";
  if (!condition) failed = true;
  console.log(`[${mark}] ${name}${condition ? "" : ` — ${detail ?? ""}`}`);
}

// ---- 1. deterministic fixtures（PyMuPDF 生成真实图表 + 内嵌 PDF）----

const gen = spawn("python", [new URL("./gen_m10_2_fixtures.py", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), fixturesDir], {
  stdio: ["ignore", "pipe", "pipe"],
});
let genError = "";
gen.stderr.on("data", (d) => (genError += d));
const genCode = await new Promise((resolve) => gen.on("close", resolve));
check("fixtures 生成（PyMuPDF 图表 + sample.pdf）", genCode === 0, genError.slice(0, 300));

const lineChartPng = await readFile(join(fixturesDir, "line-chart.png"));
const barChartPng = await readFile(join(fixturesDir, "bar-chart.png"));
const samplePdf = await readFile(join(fixturesDir, "sample.pdf"));

// Notebook：bar-chart 输出嵌入 code cell 的 image/png output（静态，不执行）
const notebook = {
  cells: [
    {
      cell_type: "markdown",
      id: "intro",
      metadata: {},
      source: ["# MOT17 experiment analysis\n", "Bar chart compares Baseline vs Ours MOTA."],
    },
    {
      cell_type: "code",
      id: "plot-cell",
      metadata: {},
      execution_count: 1,
      source: ["import matplotlib.pyplot as plt\n", "plt.show()"],
      outputs: [
        {
          output_type: "execute_result",
          execution_count: 1,
          metadata: {},
          data: {
            "text/plain": ["<Figure size 640x480>"],
            "image/png": barChartPng.toString("base64"),
          },
        },
      ],
    },
  ],
  metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" } },
  nbformat: 4,
  nbformat_minor: 5,
};

// ---- 2. upload → ingest ----

await waitForServer();
const project = await api("POST", "/api/projects", { title: "M10.2 multimodal e2e" });
if (!project.body["project"]?.id) {
  console.log(`[FAIL] 项目创建 — ${JSON.stringify(project.body).slice(0, 200)}`);
  child.kill();
  process.exit(1);
}
const projectId = project.body["project"]?.id;
console.log("[PASS] 项目创建");

async function upload(name, content) {
  const response = await api("POST", `/api/projects/${projectId}/sources`, {
    fileName: name,
    contentBase64: content.toString("base64"),
  });
  return response.body["source"]?.sourceId;
}

const pdfId = await upload("sample.pdf", samplePdf);
const plotId = await upload("line-chart.png", lineChartPng);
const notebookId = await upload("analysis.ipynb", Buffer.from(JSON.stringify(notebook)));
check("三个 source 上传（PDF / PNG / ipynb）", Boolean(pdfId && plotId && notebookId), `${pdfId} ${plotId} ${notebookId}`);

// PDF 后台 docling（真实解析）；其余内联完成。轮询 PDF 文档产物。
let pdfDocument = null;
const deadline = Date.now() + 300_000;
while (Date.now() < deadline) {
  const doc = await api("GET", `/api/projects/${projectId}/sources/${pdfId}/document?blocks=true`);
  pdfDocument = doc.body["document"];
  if (pdfDocument !== null && pdfDocument !== undefined) break;
  await sleep(2_000);
}
check(
  "PDF docling 解析完成（真实 docling）",
  pdfDocument?.status === "ok" || pdfDocument?.status === "partial",
  `status=${pdfDocument?.status}`,
);
const pdfFigures = (pdfDocument?.blocks ?? []).filter((block) => block.type === "figure");
check("PDF figure 块登记（含资产）", pdfFigures.length >= 1, JSON.stringify(pdfDocument?.counts ?? {}));

// ---- 3. vision analyze（scripted 假模型；链路全真实）----

async function analyzeSource(sourceId, label) {
  const response = await api("POST", `/api/projects/${projectId}/sources/${sourceId}/vision/analyze?inline=true`);
  const vision = response.body["vision"];
  const actions = response.body["actions"] ?? [];
  check(`${label} 分析完成（全部 completed）`, vision?.counts?.completed >= 1 && vision?.counts?.failed === 0, JSON.stringify(vision?.counts));
  return { vision, actions };
}

const pdfAnalysis = await analyzeSource(pdfId, "PDF figure");
const plotAnalysis = await analyzeSource(plotId, "standalone image");
const notebookAnalysis = await analyzeSource(notebookId, "Notebook image");

// 关联正确 figureBlock + provenance
const pdfFigureEntry = pdfAnalysis.vision.figures.find((f) => f.status === "completed");
check("analysis 关联 figureBlockId", Boolean(pdfFigureEntry?.analysisId?.endsWith(pdfFigureEntry.figureBlockId)), JSON.stringify(pdfFigureEntry).slice(0, 120));
check("PDF figure provenance（page + assetName）", pdfFigureEntry?.page !== undefined && Boolean(pdfFigureEntry?.assetName), JSON.stringify(pdfFigureEntry?.provenance ?? pdfFigureEntry).slice(0, 160));
const notebookFigureEntry = notebookAnalysis.vision.figures.find((f) => f.status === "completed");
check("Notebook provenance（cellIndex/outputIndex）", notebookFigureEntry?.cellIndex !== undefined && notebookFigureEntry?.outputIndex !== undefined, JSON.stringify(notebookFigureEntry).slice(0, 160));

// 分析落盘核对（FigureAnalysis 文件存在且 schema 正确）
const visionFile = join(root, "projects", projectId, "sources", "analysis", `${pdfId}.vision.json`);
let storedAnalyses = null;
try {
  storedAnalyses = JSON.parse(await readFile(visionFile, "utf8"));
} catch {}
check(
  "FigureAnalysis 落盘（sources/analysis/<id>.vision.json）",
  Array.isArray(storedAnalyses?.analyses) && storedAnalyses.analyses.some((a) => a.status === "completed" && Array.isArray(a.candidateFacts) && a.candidateFacts.length > 0),
  visionFile,
);
const completedAnalysis = storedAnalyses?.analyses.find((a) => a.status === "completed");
check(
  "分析含 usage + freshness 键",
  completedAnalysis?.usage?.totalTokens > 0 && typeof completedAnalysis?.imageHash === "string" && completedAnalysis?.analyzedModelSpec !== undefined,
  JSON.stringify(completedAnalysis).slice(0, 200),
);

// Parser Fact ≠ Vision Interpretation：原始 document 块无任何 vision 字段
const docAfter = await api("GET", `/api/projects/${projectId}/sources/${pdfId}/document?blocks=true`);
const figureBlockAfter = (docAfter.body["document"]?.blocks ?? []).find((block) => block.type === "figure");
check(
  "ParsedDocument 不被 Vision 污染（figure 块无 description / model 字段）",
  figureBlockAfter !== undefined && figureBlockAfter.description === undefined && figureBlockAfter.model === undefined,
  JSON.stringify(figureBlockAfter).slice(0, 160),
);

// ---- 4. search：Vision 描述可检索 + provenance ----

async function search(query) {
  const response = await api("POST", `/api/projects/${projectId}/retrieval/search`, { query, topK: 10 });
  return response.body["results"] ?? [];
}

const figureResults = await search("threshold MOTA 变化");
const figureHit = figureResults.find((entry) => entry.chunk.text.includes("[figure"));
check("搜索命中 figure 分析 chunk", Boolean(figureHit), JSON.stringify(figureResults.map((e) => e.chunk.sectionTitle)).slice(0, 200));
check(
  "figure chunk 带视觉 provenance（block / page / asset / model）",
  Boolean(figureHit) && figureHit.chunk.text.includes(pdfFigureEntry.figureBlockId) && figureHit.chunk.text.includes(".png") && figureHit.chunk.text.includes("vision ") && figureHit.chunk.pageStart !== undefined,
  figureHit?.chunk.text.slice(0, 200),
);

const imageResults = await search("指标随参数变化");
const imageHit = imageResults.find((entry) => entry.chunk.text.includes("[figure") && entry.chunk.text.includes("img-001.png"));
check("standalone 图片条目可检索（唯一通道）", Boolean(imageHit), JSON.stringify(imageResults.map((e) => e.chunk.sectionTitle)).slice(0, 200));

// ---- 5. candidate fact → user confirm → user_confirmed Evidence ----

const factsResponse = await api("GET", `/api/projects/${projectId}/sources/${pdfId}/vision?facts=true`);
const facts = factsResponse.body["vision"]?.figures?.find((f) => f.status === "completed")?.facts ?? [];
check("候选事实可见（facts=true）", facts.length >= 1, JSON.stringify(factsResponse.body["vision"]?.counts ?? {}));
const targetFact = facts[0];

const confirm = await api("POST", `/api/projects/${projectId}/sources/${pdfId}/vision/facts/${targetFact.factId}/evidence`, {
  claim: `论文图 1 显示 MOTA 在 threshold=0.5 时达到 82.4`,
});
const evidence = confirm.body["evidence"];
check("事实确认 → 201 user_confirmed", confirm.status === 201 && evidence?.verificationLevel === "user_confirmed", JSON.stringify(confirm.body).slice(0, 200));
check(
  "verificationStatus=unverified（≠ grounded_verified）",
  evidence?.verificationStatus === "unverified" && evidence?.location?.chunk === undefined,
  JSON.stringify(evidence?.verificationStatus),
);
check(
  "Evidence 视觉 provenance（figureBlockId / assetName / visionFactRef）",
  Boolean(evidence?.location?.figureBlockId) && Boolean(evidence?.location?.assetName) && Boolean(evidence?.location?.visionFactRef),
  JSON.stringify(evidence?.location),
);

// 值不匹配 → 422（机械校验）
const mismatch = await api("POST", `/api/projects/${projectId}/sources/${pdfId}/vision/facts/${targetFact.factId}/evidence`, {
  claim: "图中曲线呈上升趋势",
});
check("claim 未含值 → 422", mismatch.status === 422, `status=${mismatch.status}`);

// ---- 6. freshness：重复 analyze 命中缓存（不再调用模型）----

const rerun = await api("POST", `/api/projects/${projectId}/sources/${pdfId}/vision/analyze?inline=true`);
const rerunActions = rerun.body["actions"] ?? [];
check("重复 analyze 全部 reused（freshness 命中）", rerunActions.length > 0 && rerunActions.every((a) => a.action === "reused"), JSON.stringify(rerunActions));

// ---- 收尾 ----

child.kill();
await sleep(500);
await rm(root, { recursive: true, force: true }).catch(() => {});
console.log(failed ? "\nM10.2 E2E: FAIL" : "\nM10.2 E2E: ALL PASS");
process.exit(failed ? 1 : 0);
