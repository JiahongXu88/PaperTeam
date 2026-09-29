/**
 * M10.3 确定性 E2E（node dist 生产构建；scripted Runtime / Vision / 离线检索；
 * ingestion / workflow / 产物全真实）。用法：node scripts/m10-3-e2e.mjs
 * （需先 npm --prefix backend run build）
 *
 * 覆盖（任务 §18 Stage A–H 的确定性投影）：
 *   Stage A Import：单文件 LaTeX（真实案例形态 paper.tex + refs.bib）导入 +
 *     MANIFEST + current/historical 实验数据 → asset-inventory（角色 + 域隔离）
 *   Stage B Ingestion：JSON/CSV 结构化解析 + provenance 检索
 *   Stage C Baseline：revision-baseline.json（表格 / 数字 / 引用 / 硬件）
 *   Stage D Research：research.plan → HITL 批准 → execute → evidence_supply HITL
 *     → propose → ground（requirement-driven；scripted）
 *   Stage E Revision Plan：improvement-plan.json（条目指向 main.tex）
 *   Stage F Revision：revision.apply（整文件修订；事实 / 引用逐字保留）
 *   Stage G Validation：citation verify / review / quality gate / build（fake LaTeX）
 *   Stage H Artifacts：revision-response.md + Draft/Final 产物
 *   user_confirmed ≠ grounded_verified；already_satisfied 意见不派发。
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

const BASE = "http://127.0.0.1:8771";
const root = await mkdtemp(join(tmpdir(), "paperteam-m103-e2e-"));
const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: new URL("../backend/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  env: {
    ...process.env,
    PAPERTEAM_PORT: "8771",
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

async function pollRun(runId, statuses, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api("GET", `/api/runs/${runId}`);
    const run = body["run"];
    if (statuses.includes(run?.status)) return run;
    if (run?.status === "failed") {
      throw new Error(`run 失败：${run.error?.code} ${run.error?.message}（stage ${run.error?.stageId}）\n${logBuffer.slice(-3000)}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 ${statuses.join("|")} 超时（当前 ${run?.status}，stage ${run?.currentStage}）\n${logBuffer.slice(-2000)}`);
    }
    await sleep(300);
  }
}

/** 轮询到目标 HITL（中途遇到的决策点显式处理） */
async function pollUntilAwaiting(runId, targetStage) {
  for (;;) {
    const run = await pollRun(runId, ["awaiting_input"]);
    if (run.awaiting?.stageId === targetStage) return run;
    const stageId = run.awaiting?.stageId ?? "";
    if (stageId === "hitl.research_plan" || stageId === "hitl.evidence_supply") {
      await api("POST", `/api/runs/${runId}/resume`, {
        decision: stageId === "hitl.research_plan" ? "approve" : "continue",
      });
      continue;
    }
    throw new Error(`未预期的待办节点 ${stageId}（期望 ${targetStage}）`);
  }
}

function buildZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBytes, compressed);
    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(0x02014b50, 0);
    centralEntry.writeUInt16LE(20, 4);
    centralEntry.writeUInt16LE(20, 6);
    centralEntry.writeUInt16LE(8, 10);
    centralEntry.writeUInt32LE(compressed.length, 20);
    centralEntry.writeUInt32LE(entry.data.length, 24);
    centralEntry.writeUInt16LE(nameBytes.length, 28);
    centralEntry.writeUInt32LE(offset, 42);
    central.push(centralEntry, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}

// ---- fixtures（真实案例的最小确定性投影）----

const PAPER_TEX = [
  "\\documentclass[UTF8]{ctexart}",
  "\\usepackage{cite}",
  "\\begin{document}",
  "\\section{引言}",
  "本文方法在两个数据集上验证，MOTA 提升 12.4\\%。\\cite{a}",
  "\\section{方法}",
  "运动残差门控模板记忆。",
  "\\section{实验}",
  "\\begin{table}[h]",
  "\\caption{主结果}",
  "\\label{tab:main}",
  "\\begin{tabular}{ll}",
  "方法 & MOTA \\\\",
  "Ours & 82.4 \\\\",
  "\\end{tabular}",
  "\\end{table}",
  "板端部署于 RDK X3 平台，E2E 延迟 1495.63 ms。",
  "\\bibliographystyle{unsrt}",
  "\\bibliography{refs}",
  "\\end{document}",
].join("\n");

const LATEX_ZIP = buildZip([
  { name: "paper.tex", data: Buffer.from(PAPER_TEX, "utf8") },
  { name: "refs.bib", data: Buffer.from("@article{a, title={A Good Paper}, year={2020}}", "utf8") },
]);

const MANIFEST = JSON.stringify({
  caseVersion: 1,
  currentManuscript: { packagedPath: "manuscript/source/paper.tex" },
  assets: [
    { packagedPath: "manuscript/source/paper.tex", role: "current_manuscript", confidence: "high" },
    { packagedPath: "experiments/data/battery.json", role: "current_experiment" },
    { packagedPath: "experiments/data/board_aggregate.json", role: "historical_board_experiment" },
  ],
});

const BATTERY_JSON = JSON.stringify({
  what: "phase4 battery",
  readouts: { rgate_hybrid: { ll_dG2: 0.0218, verdict: "GO" } },
});
const BOARD_JSON = JSON.stringify({ board: { e2e_ms: 1495.63, fps: 0.669 } });

// ---- Stage A：Import ----

await waitForServer();
const project = await api("POST", "/api/projects", { title: "M10.3 deterministic e2e", targetProfile: "core_journal" });
const projectId = project.body["project"]?.id;
check("项目创建", Boolean(projectId), JSON.stringify(project.body).slice(0, 200));

const imported = await api("POST", `/api/projects/${projectId}/import`, {
  archiveBase64: LATEX_ZIP.toString("base64"),
});
check("LaTeX 单文件导入（entry=paper.tex）", imported.status === 200 && imported.body["report"]?.structure?.entryFile === "paper.tex", JSON.stringify(imported.body).slice(0, 200));

async function upload(name, content, extra) {
  const response = await api("POST", `/api/projects/${projectId}/sources`, {
    fileName: name,
    contentBase64: Buffer.from(content).toString("base64"),
    ...(extra ?? {}),
  });
  return response.body["source"]?.sourceId;
}

const manifestId = await upload("MANIFEST.json", MANIFEST);
const batteryId = await upload("battery.json", BATTERY_JSON);
const boardId = await upload("board_aggregate.json", BOARD_JSON);
check("资产上传（MANIFEST + current + historical）", Boolean(manifestId && batteryId && boardId), `${manifestId} ${batteryId} ${boardId}`);

// already_satisfied 第一轮意见登记
const instruction = await api("POST", `/api/projects/${projectId}/external-instructions`, {
  source: "journal_reviewer",
  reviewerLabel: "外审 1",
  text: "建议补充车载视角目标检测/跟踪的相关研究。",
  initialStatus: "already_satisfied",
  statusNote: "投稿版（2026-09-13）引言已补充 6 篇近年文献，response 在案",
});
check("already_satisfied 意见登记", instruction.status === 200 && instruction.body["instruction"]?.status === "already_satisfied", JSON.stringify(instruction.body).slice(0, 200));

// ---- Stage B：Ingestion + user_confirmed Evidence ----

const batteryDoc = await api("GET", `/api/projects/${projectId}/sources/${batteryId}/document`);
check("JSON ingestion 结构化解析", batteryDoc.body["document"]?.status === "ok", JSON.stringify(batteryDoc.body["document"]?.counts ?? {}).slice(0, 120));

const confirm = await api("POST", `/api/projects/${projectId}/sources/${batteryId}/records/evidence`, {
  path: "$.readouts.rgate_hybrid.ll_dG2",
  claim: "rgate_hybrid 在低照度场景的 G2 增益为 0.0218",
});
const evidence = confirm.body["evidence"];
check(
  "user_confirmed Evidence（verificationLevel=user_confirmed ≠ verified）",
  confirm.status === 201 && evidence?.verificationLevel === "user_confirmed" && evidence?.verificationStatus === "unverified",
  JSON.stringify(evidence).slice(0, 200),
);
check(
  "Evidence provenance（jsonPath + sourceId）",
  evidence?.location?.path === "$.readouts.rgate_hybrid.ll_dG2" && evidence?.source?.sourceId === batteryId,
  JSON.stringify(evidence?.location),
);

const mismatch = await api("POST", `/api/projects/${projectId}/sources/${batteryId}/records/evidence`, {
  path: "$.readouts.rgate_hybrid.ll_dG2",
  claim: "增益约为 0.05（与记录值不符）",
});
check("claim 值不符 → 422（防手填报错值）", mismatch.status === 422, `status=${mismatch.status}`);

// 检索命中结构化记录（provenance 链路）
const search = await api("POST", `/api/projects/${projectId}/retrieval/search`, { query: "rgate_hybrid ll_dG2", topK: 5 });
check("检索命中实验记录 chunk", (search.body["results"] ?? []).length > 0, JSON.stringify(search.body).slice(0, 160));

// ---- Stage C–H：工作流全链路 ----

const created = await api("POST", `/api/projects/${projectId}/workflows`, {
  kind: "existing_paper_improvement",
  prompt: "基于 Phase5 贡献草案扩展返修稿：接入身份可靠性研究链（rgate 零参数门控，禁止 HOTA/IDSW 声明）",
});
check("工作流启动", created.status === 202, JSON.stringify(created.body).slice(0, 160));
const runId = created.body["runId"];

// Stage D：research.plan → HITL 批准（M8 纪律）
const researchPlan = await pollUntilAwaiting(runId, "hitl.research_plan");
const planPayload = researchPlan.awaiting?.payload ?? {};
check(
  "研究计划 HITL（requirements + queries）",
  (planPayload.requirements ?? []).length > 0 && (planPayload.queries ?? []).length > 0,
  JSON.stringify(planPayload).slice(0, 200),
);
await api("POST", `/api/runs/${runId}/resume`, { decision: "approve" });

// evidence_supply HITL（requirement 缺口触发）
const supply = await pollUntilAwaiting(runId, "hitl.evidence_supply");
check(
  "evidence-supply HITL（requirement coverage 呈现）",
  (supply.awaiting?.payload?.requirements ?? []).length > 0,
  JSON.stringify(supply.awaiting?.payload ?? {}).slice(0, 200),
);
await api("POST", `/api/runs/${runId}/resume`, { decision: "continue" });

// Stage E：plan_confirm（单文件条目指向 main.tex）
const planConfirm = await pollUntilAwaiting(runId, "hitl.plan_confirm");
const items = planConfirm.awaiting?.payload?.items ?? [];
check("改进计划条目指向 main.tex（单文件项目）", items.length > 0 && items[0]?.section === "main.tex", JSON.stringify(items).slice(0, 200));
await api("POST", `/api/runs/${runId}/resume`, { decision: "approve" });

const finished = await pollRun(runId, ["completed"]);
check("run 完成（Final）", finished.completion?.label === "final", JSON.stringify(finished.completion ?? {}).slice(0, 200));
check(
  "全链路 stage 覆盖（A–H）",
  ["import.inventory", "import.baseline", "research.plan", "research.execute", "research.propose", "evidence.ground", "revision.apply", "revision.report"].every((stage) =>
    finished.completedStages?.includes(stage),
  ),
  JSON.stringify(finished.completedStages),
);

// ---- 产物断言 ----

const inventory = JSON.parse(await readFile(join(root, "projects", projectId, "research", "asset-inventory.json"), "utf8"));
check("asset-inventory：MANIFEST 角色映射 + 域隔离", inventory.manifestFound === true && inventory.domains.historicalBoard.length === 1 && !inventory.domains.current.includes(inventory.domains.historicalBoard[0]), JSON.stringify(inventory.domains));

const baseline = JSON.parse(await readFile(join(root, "projects", projectId, "research", "revision-baseline.json"), "utf8"));
check(
  "revision-baseline：表格 / 引用 / 硬件 / 板端数字",
  baseline.tables?.length > 0 && baseline.citationKeys?.includes("a") && (baseline.hardware ?? []).some((h) => h.includes("RDK")) && (baseline.numbers ?? []).some((n) => n.tokens.some((t) => t.startsWith("1495.63"))),
  JSON.stringify({ tables: baseline.tables?.length, keys: baseline.citationKeys, hw: baseline.hardware }),
);

const research = JSON.parse(await readFile(join(root, "projects", projectId, "research", "research.json"), "utf8"));
check(
  "研究计划链（draft→approved→done + requirements 保留）",
  (research.plans ?? []).length > 0 && research.plans.every((p) => p.status === "done") && (research.plans[0]?.requirements ?? []).length > 0,
  JSON.stringify((research.plans ?? []).map((p) => p.status)),
);

const revised = await readFile(join(root, "projects", projectId, "manuscript", "main.tex"), "utf8");
check(
  "整文件修订：事实 / 引用 / 部署数字逐字保留",
  revised.includes("12.4") && revised.includes("82.4") && revised.includes("RDK X3") && revised.includes("1495.63") && revised.includes("\\cite{a}"),
  revised.slice(0, 200),
);

const instructions = await api("GET", `/api/projects/${projectId}/external-instructions`);
const round1 = (instructions.body["instructions"] ?? []).find((entry) => entry.status === "already_satisfied");
check("already_satisfied 意见未被重复派发（状态保持）", Boolean(round1), JSON.stringify(instructions.body["instructions"] ?? []).slice(0, 200));

const response = await readFile(join(root, "projects", projectId, "build", "revision-response.md"), "utf8");
check(
  "revision-response.md（Revision Trace：意见投影 + 不虚构）",
  response.includes("Revision Trace") && response.includes("已在当前稿落实") && response.includes("确定性投影"),
  response.slice(0, 160),
);

const pdf = await readFile(join(root, "projects", projectId, "build", "paper.pdf"), "utf8").catch(() => null);
check("LaTeX 构建 PDF 产出", pdf !== null && pdf.includes("%PDF"), "build/paper.pdf");

// ---- 收尾 ----

child.kill();
await sleep(500);
await rm(root, { recursive: true, force: true }).catch(() => {});
console.log(failed ? "\nM10.3 E2E: FAIL" : "\nM10.3 E2E: ALL PASS");
process.exit(failed ? 1 : 0);
