/**
 * M10.1 真实服务端到端验证（node dist 生产构建 + 真实 docling）。
 * 用法：node scripts/m10-1-e2e.mjs（需先 npm --prefix backend run build）
 * 覆盖：建项目 → PDF 上传（后台 docling ingest）→ document 轮询 →
 * CSV 上传（内联 ingest）→ records → 确认 → evidence → formal 隔离 → 清理。
 */

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "http://127.0.0.1:8765";
const root = await mkdtemp(join(tmpdir(), "paperteam-m101-e2e-"));
const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: new URL("../backend/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  env: {
    ...process.env,
    PAPERTEAM_PORT: "8765",
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

try {
  await waitForServer();
  console.log("server ready");

  // 1. 建项目
  const created = await api("POST", "/api/projects", { title: "M10.1 E2E" });
  check("create project", created.status === 201, JSON.stringify(created.body).slice(0, 200));
  const projectId = created.body.project?.id;

  // 2. CSV 上传（内联 ingest）
  const csv = "Method,MOTA,IDF1\nOurs,82.4,79.1\nBaseline,78.2,75.0\n";
  const csvUpload = await api("POST", `/api/projects/${projectId}/sources`, {
    fileName: "experiment.csv",
    contentBase64: Buffer.from(csv, "utf8").toString("base64"),
  });
  check("csv upload 201", csvUpload.status === 201);
  check(
    "csv inline ingestion structured",
    csvUpload.body.ingestion?.status === "ok" && csvUpload.body.ingestion?.counts?.structured_record === 2,
    JSON.stringify(csvUpload.body.ingestion).slice(0, 200),
  );
  const csvSourceId = csvUpload.body.source?.sourceId;

  // 3. CSV records → 确认 → evidence
  const records = await api("GET", `/api/projects/${projectId}/sources/${csvSourceId}/records`);
  check("records listed", records.status === 200 && records.body.records?.length === 2);
  const confirm = await api("POST", `/api/projects/${projectId}/sources/${csvSourceId}/records/evidence`, {
    row: 2,
    column: "MOTA",
    claim: "Ours 在 MOT17 上 MOTA = 82.4",
  });
  check("confirm 201 user_confirmed", confirm.status === 201 && confirm.body.evidence?.verificationLevel === "user_confirmed");
  const mismatch = await api("POST", `/api/projects/${projectId}/sources/${csvSourceId}/records/evidence`, {
    row: 2,
    column: "MOTA",
    claim: "MOTA 是 99.9",
  });
  check("value mismatch 422", mismatch.status === 422 && mismatch.body.error?.code === "EVIDENCE_VALUE_MISMATCH");

  const evidence = await api("GET", `/api/projects/${projectId}/evidence`);
  const record = evidence.body.evidence?.[0];
  check(
    "evidence persisted with provenance",
    evidence.body.evidence?.length === 1 &&
      record?.verificationStatus === "unverified" &&
      record?.location?.row === 2 &&
      record?.location?.column === "MOTA" &&
      record?.quote === "82.4",
    JSON.stringify(record).slice(0, 300),
  );

  // 4. PDF 上传（真实 attention.pdf；后台 docling）
  const pdfBytes = await readFile(
    new URL("../backend/test/fixtures/pdf/attention.pdf", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  );
  const pdfUpload = await api("POST", `/api/projects/${projectId}/sources`, {
    fileName: "attention.pdf",
    contentBase64: pdfBytes.toString("base64"),
  });
  check("pdf upload 201 pending", pdfUpload.status === 201 && pdfUpload.body.ingestion?.status === "pending");
  const pdfSourceId = pdfUpload.body.source?.sourceId;

  // 5. 轮询 document（docling ~40-60s）
  let document = null;
  for (let i = 0; i < 90; i += 1) {
    await sleep(2000);
    const response = await api("GET", `/api/projects/${projectId}/sources/${pdfSourceId}/document`);
    document = response.body.document;
    if (document !== null) break;
  }
  check(
    "pdf structured docling document",
    document?.parser?.id === "docling" &&
      document?.parseMode === "structured" &&
      document?.status === "ok" &&
      document?.counts?.table >= 1 &&
      document?.counts?.figure >= 1 &&
      document?.pageCount === 15,
    JSON.stringify(document).slice(0, 300),
  );

  // 6. 检索消费（后台 hook 重建后 docling/tabular chunk 可检索）
  const retrieval = await api("POST", `/api/projects/${projectId}/retrieval/search`, {
    query: "attention",
    topK: 5,
  });
  const stats = await api("GET", `/api/projects/${projectId}/retrieval/stats`);
  const indexedCount = stats.body.sources?.indexed;
  check(
    "retrieval search ok + both sources indexed",
    retrieval.status === 200 && indexedCount >= 2,
    `indexed=${indexedCount} search=${JSON.stringify(retrieval.body).slice(0, 200)} log=${logBuffer.slice(-500)}`,
  );

  console.log(failed ? "\nE2E: FAILED" : "\nE2E: ALL PASS");
} finally {
  child.kill();
  await sleep(1000);
  await rm(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
