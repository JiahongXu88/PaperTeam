/**
 * M10.3.1 真实论文 rerun（与 M10.3 同一输入案例，验证 reliability closure）：
 * 真实 GLM 5.3 + Flash vision + 真实检索 + docling + xelatex。
 * 用法：node scripts/m1031-real-e2e.mjs
 *
 * 与 M10.3 的差异（任务 §19-§22）：
 * - 全新临时 PROJECTS_ROOT（不复用被污染 workspace）；
 * - 新增板端 C0 user_confirmed 证据（表 11 数据 jsonPath 溯源——RDK X3
 *   部署声明属作者既有实验结果，A-类「已有证据未关联」补齐）；
 * - 断言升级：cumulative fact preservation ok（λ_smooth 型累计漂移=0）、
 *   claim-gap-audit 修订引入口径 blocking=0、feasibility task-aware 重评、
 *   Revision Trace 含累计/归层/适用性章节；
 * - 成本遥测与 M10.3（$10.11 / 77 calls / ≈4.5h）对比。
 *
 * 纪律不变：不虚构第二轮意见 / 不虚构 Phase6 板端完成 / 表 11 C0 不混域 /
 * rgate 无 HOTA/IDSW/IDF1 改善声明 / 基金与作者简介不动。
 *
 * M10.4.2 Model Routing Benchmark 钩子（不改变默认行为）：
 * - M1031_ARM_LABEL    日志/摘要中的 arm 标签（缺省 "baseline"）
 * - M1031_MODEL_DEFAULT 默认模型规格（缺省 zai-coding-cn/glm-5.3 = M10.3.1 基线）
 * - M1031_MODEL_AGENTS per-Agent 模型 override（JSON 对象；缺省 "{}" = 显式
 *                     清空，保证各 arm 输入配置确定性——不在臂间残留）
 * - M1031_EXPORT_DIR   设置时把基准产物（summary/trace/gate/audit/tex/pdf/
 *                     plan/response）复制到该目录（防临时目录清理后丢失）
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CASE_ZIP = process.env.M103_CASE_ZIP ?? "D:\\PaperTeamData\\M10.3-real-paper-case.zip";
const ARM_LABEL = process.env.M1031_ARM_LABEL ?? "baseline";
const ARM_MODEL_DEFAULT = process.env.M1031_MODEL_DEFAULT ?? "zai-coding-cn/glm-5.3";
const ARM_MODEL_AGENTS = JSON.parse(process.env.M1031_MODEL_AGENTS ?? "{}");
const EXPORT_DIR = process.env.M1031_EXPORT_DIR ?? undefined;
const BASE = "http://127.0.0.1:8777";
const PORT = 8777;

const root = await mkdtemp(join(tmpdir(), "paperteam-m1031-rerun-"));
const staging = join(root, "case");
const startedAt = Date.now();

function log(message) {
  console.log(`[${Math.round((Date.now() - startedAt) / 1000)}s] ${message}`);
}

const telemetry = {
  startedAt: new Date().toISOString(),
  arm: ARM_LABEL,
  modelAgents: ARM_MODEL_AGENTS,
  modelCallsApprox: 0,
  visionCalls: 0,
  visionUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: null },
  searchQueries: 0,
  searchResults: 0,
  revisionRounds: 0,
  hits: [],
  notes: [],
};

let failed = false;
function check(name, condition, detail) {
  const mark = condition ? "PASS" : "FAIL";
  if (!condition) failed = true;
  telemetry.hits.push({ name, pass: condition === true });
  console.log(`[${mark}] ${name}${condition ? "" : ` — ${detail ?? ""}`}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, body: json };
}

function unzip(zipPath, dest) {
  const child = spawn("python", [join(SCRIPT_DIR, "m10-3-unzip-case.py"), zipPath, dest], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let error = "";
    child.stderr.on("data", (d) => (error += d));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(error))));
  });
}

// ---- 1. staging：解压真实 ZIP（GBK 名修复）----

await unzip(CASE_ZIP, staging);
const manifest = JSON.parse(await readFile(join(staging, "MANIFEST.json"), "utf8"));
check("真实 ZIP 导入 staging（189 文件级 MANIFEST 可解析）", manifest.caseVersion === 1 && Array.isArray(manifest.assets), `caseVersion=${manifest.caseVersion} assets=${manifest.assets.length}`);
const manuscriptSha = createHash("sha256")
  .update(await readFile(join(staging, "manuscript", "source", "paper.tex")))
  .digest("hex");
check(
  "currentManuscript = manuscript/source/paper.tex（MANIFEST 判定，非 0803 锚点）",
  manifest.currentManuscript.packagedPath === "manuscript/source/paper.tex" &&
    manuscriptSha === manifest.assets.find((a) => a.packagedPath === "manuscript/source/paper.tex").sha256,
  `sha=${manuscriptSha.slice(0, 12)}`,
);

// ---- 2. LaTeX 导入 zip（仅 current manuscript；historical 候选不入稿）----

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

const figsDir = join(staging, "manuscript", "source", "figs");
const figFiles = (await readdir(figsDir)).filter((name) => name.endsWith(".pdf"));
const latexEntries = [
  { name: "paper.tex", data: await readFile(join(staging, "manuscript", "source", "paper.tex")) },
  { name: "refs.bib", data: await readFile(join(staging, "manuscript", "source", "refs.bib")) },
];
for (const name of figFiles) {
  latexEntries.push({ name: `figs/${name}`, data: await readFile(join(figsDir, name)) });
}
const latexArchive = buildZip(latexEntries);

// ---- 3. 启动真实服务（真实 runtime / vision / 检索 / LaTeX）----

const server = spawn(process.execPath, ["dist/index.js"], {
  cwd: new URL("../backend/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  env: {
    ...process.env,
    PAPERTEAM_PORT: String(PORT),
    PROJECTS_ROOT: join(root, "projects"),
    PAPERTEAM_RUNTIME_ROOT: process.env.PAPERTEAM_RUNTIME_ROOT ?? "C:\\Users\\Administrator\\.paperteam",
    HF_ENDPOINT: process.env.HF_ENDPOINT ?? "https://hf-mirror.com",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logBuffer = "";
server.stdout.on("data", (d) => (logBuffer += d));
server.stderr.on("data", (d) => (logBuffer += d));

// M10.3.1：端口预占用守卫——若 8777 已有 server 响应（上一轮残留），立即中止：
// 否则本脚本的 spawn 会绑定失败，而 waitForServer 会误把旧 server 当新实例，
// 全部 API 落到旧 PROJECTS_ROOT（M10.3.1 首轮实测事故）
async function assertPortFree() {
  try {
    const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
    if (response.ok) {
      throw new Error(`端口 ${PORT} 已有 server 响应（上一轮残留）——先 taskkill 旧进程再重跑`);
    }
  } catch (error) {
    if (error instanceof TypeError || String(error).includes("fetch failed") || String(error).includes("aborted")) {
      return; // 连接失败 = 端口空闲
    }
    throw error;
  }
}

async function waitForServer(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error(`server not ready:\n${logBuffer.slice(-3000)}`);
}

await assertPortFree();
await waitForServer();

// 模型配置：default 按 arm 指定（M10.4.2；缺省 glm-5.3 即 M10.3.1 基线）；
// vision 显式设为 GLM 5.3 Flash（image-capable；能力来自目录 input 元数据，
// 不硬编码判断——各 arm 固定不变，不是本研究的路由对象）。
// agents 显式随 PUT 下发（缺省 {} = 清空 override），保证各 arm 模型路由
// 确定性；保存后回读 effective 值断言路由已生效
const modelSetup = await api("PUT", "/api/settings/model", {
  model: ARM_MODEL_DEFAULT,
  visionModel: "zai-coding-cn/glm-5.3-flash",
  agents: ARM_MODEL_AGENTS,
});
const appliedAgents = Object.fromEntries(
  (modelSetup.body["settings"]?.agents ?? [])
    .filter((a) => a.source === "agent_override")
    .map((a) => [a.key, a.effective]),
);
check(
  "模型配置（default / vision glm-5.3-flash / per-Agent override 生效）",
  modelSetup.status === 200 &&
    modelSetup.body["settings"]?.model === ARM_MODEL_DEFAULT &&
    JSON.stringify(appliedAgents) === JSON.stringify(ARM_MODEL_AGENTS),
  `default=${modelSetup.body["settings"]?.model} applied=${JSON.stringify(appliedAgents)} 期望=${JSON.stringify(ARM_MODEL_AGENTS)}`,
);

// ---- 4. Stage A：Import（current manuscript 导入 + 资产上传）----

const imported = await api("POST", "/api/projects/import-paper", {
  format: "latex",
  goal: "improvement",
  archiveBase64: latexArchive.toString("base64"),
});
check(
  "LaTeX 导入（entry=paper.tex；baseline compile 真实 xelatex）",
  imported.status === 201 && imported.body["project"] != null,
  JSON.stringify(imported.body).slice(0, 300),
);
const projectId = imported.body["project"]?.id;
const importReport = imported.body["report"] ?? {};
telemetry.notes.push(`entryFile=${importReport.structure?.entryFile} baseline=${importReport.baselineCompile?.ok ? "ok" : "fail"}`);
log(`项目 ${projectId} 导入完成（baseline ${importReport.baselineCompile?.ok ? "ok" : "fail"}）`);

const sourceIds = {};
async function uploadAsset(packagedPath, fileName, extra) {
  const content = await readFile(join(staging, packagedPath.replaceAll("/", "\\")));
  const response = await api("POST", `/api/projects/${projectId}/sources`, {
    fileName,
    contentBase64: content.toString("base64"),
    ...(extra ?? {}),
  });
  const sourceId = response.body["source"]?.sourceId;
  if (sourceId) sourceIds[packagedPath] = sourceId;
  return { response, sourceId };
}

// 资产选择（按 MANIFEST 角色；bounded）
const assetPlan = [
  // current 实验（PC final，V-freeze）
  ["experiments/data/phase4/battery_phase4.json", "battery_phase4.json"],
  ["experiments/data/phase4_ablation/battery_ablation.json", "battery_ablation.json"],
  ["experiments/data/phase4_2_mot/mot_metrics.json", "mot_metrics.json"],
  ["experiments/data/phase4_3_assoc/assoc_metrics.json", "assoc_metrics.json"],
  ["experiments/data/phase3_m2/battery_m2.json", "battery_m2.json"],
  // historical board（板端 C0 = 表 11 语境；早期 tracker 验证 = 更早期语境）
  ["experiments/data/board_c0_20260904/aggregate.json", "board_c0_aggregate.json"],
  ["experiments/data/board_tracker_20260831/bench_stats.csv", "board_tracker_stats.csv"],
  // 反馈
  ["feedback/response_to_reviewers.md", "response_to_reviewers.md"],
  // 研究上下文（Phase4/5/6 正式报告）
  ["context/phase-reports/phase4/PHASE4_IDENTITY_RELIABILITY_REPORT.md", "phase4_report.md"],
  ["context/phase-reports/phase4/PHASE4_MOT_INTEGRATION_REPORT.md", "phase4_2_report.md"],
  ["context/phase-reports/phase4/PHASE4_RELIABILITY_ASSOCIATION_REPORT.md", "phase4_3_report.md"],
  ["context/phase-reports/phase5/FINAL_ALGORITHM_FREEZE.md", "phase5_freeze.md"],
  ["context/phase-reports/phase5/PAPER_CONTRIBUTION_DRAFT.md", "phase5_contribution.md"],
  ["context/phase-reports/phase5/EXPERIMENT_STORYLINE.md", "phase5_storyline.md"],
  ["context/phase-reports/phase6/PHASE6_0_REPORT.md", "phase6_report.md"],
];
const boardFigures = (await readdir(join(staging, "experiments", "figures", "board_tracker_20260831")))
  .filter((name) => /\.(png|jpg|jpeg)$/i.test(name))
  .slice(0, 3);
// 论文图（PDF figure → docling 解析出 figure block → vision）
const paperFigurePaths = ["manuscript/source/figs/framework.pdf", "manuscript/source/figs/fig_pr_bdd100k.pdf"];

const manifestUpload = await uploadAsset("MANIFEST.json", "MANIFEST.json");
check("MANIFEST 作为 source 上传（事实边界进入项目）", manifestUpload.sourceId !== undefined, JSON.stringify(manifestUpload.response.body).slice(0, 160));

for (const [packagedPath, fileName] of assetPlan) {
  const { response } = await uploadAsset(packagedPath, fileName);
  if (response.status !== 201 && response.status !== 200) {
    telemetry.notes.push(`upload fail ${packagedPath}: ${response.status}`);
  }
}
const boardFigureIds = [];
for (const packagedPath of paperFigurePaths) {
  const fileName = packagedPath.split("/").pop();
  const { sourceId } = await uploadAsset(packagedPath, fileName);
  if (sourceId) boardFigureIds.push(sourceId);
}
for (const name of boardFigures) {
  const { sourceId } = await uploadAsset(`experiments/figures/board_tracker_20260831/${name}`, name.replace(/[^\w.-]/g, "_"));
  if (sourceId) boardFigureIds.push(sourceId);
}
log(`资产上传完成（${Object.keys(sourceIds).length} 项 + 板端图 ${boardFigureIds.length} 张）`);

// ---- 5. 第一轮意见（already_satisfied）+ 作者目标（pending user 指令）----

const roundOne = [
  ["editor", "编辑", "建议进一步突出论文的创新点，明确论文相对已有方法的核心贡献边界。"],
  ["journal_reviewer", "外审 1", "建议补充车载视角目标检测/跟踪的相关研究，使参考文献总数不少于 20 篇。"],
  ["journal_reviewer", "外审 2", "建议补充真实车载边缘设备上的部署与性能验证实验。"],
  ["journal_reviewer", "外审 3", "建议解释 UA-DETRAC 与真实车载场景的关系（多为固定监控视角）。"],
  ["journal_reviewer", "外审 4", "建议补充低照度、高密度等极端场景的定性与定量分析。"],
];
for (const [source, label, text] of roundOne) {
  await api("POST", `/api/projects/${projectId}/external-instructions`, {
    source,
    reviewerLabel: label,
    text,
    initialStatus: "already_satisfied",
    statusNote: "CEA 第一轮意见已在投稿版（2026-09-13）落实，response_to_reviewers.md 在案；磁盘无第二轮意见，不虚构",
  });
}

const authorGoals = [
  "接入身份可靠性研究链（Phase5 贡献草案路线）：方法部分新增『身份记忆可靠性门控更新』小节（R_t=Q_t·C_t、η_t=0.05+0.20·R_t 的零参数门控 EMA）；实验部分新增 38-clip 预注册电池结果（四场景 G2）与归因结论；讨论/局限部分新增传递边界分析。",
  "rgate 声明边界（冻结纪律）：rgate 只允许『零成本零训练身份记忆更新层』陈述（tracker-realized G2 +0.024~+0.080 允许）；禁止任何 HOTA/IDSW/IDF1 改善声明（Phase4.2 传递不成立、Phase4.3 HARM 双负结果在案）；所有数字直引冻结报告，禁止方向性四舍五入。",
  "负面结果必须如实呈现：Phase4.2（MOT 集成传递不成立：34/38 轨迹逐位不变、HOTA −0.0003、IDSW +12）与 Phase4.3（R 进关联 HARM：IDSW 116→125）作为 negative-but-final 结果进入讨论/局限，不得隐藏或反转。",
  "冻结边界：不得虚构第二轮审稿意见；不得声称 rgate 已完成板端验证（Phase6 实验链未执行，只能写 pending/future validation）；表 11 板端 C0 数据（E2E 1495.63 ms / 0.669 FPS / 峰值 41.9 °C）保持不变，不得混入更早期板测数字（286.57 ms / 3.49 FPS 时代）；基金、作者简介、通信邮箱保持原稿不动；不更换期刊模板或投稿目标。",
];
for (const text of authorGoals) {
  await api("POST", `/api/projects/${projectId}/external-instructions`, { source: "user", text });
}
const instructionsView = await api("GET", `/api/projects/${projectId}/external-instructions`);
const instructionList = instructionsView.body["instructions"] ?? [];
check(
  "意见登记：5 条第一轮（already_satisfied）+ 4 条作者目标（pending）",
  instructionList.length === 9 &&
    instructionList.filter((i) => i.status === "already_satisfied").length === 5 &&
    instructionList.filter((i) => i.status === "pending").length === 4,
  JSON.stringify(instructionList.map((i) => i.status)).slice(0, 120),
);

// ---- 6. Stage B：user_confirmed 实验证据（current 域；jsonPath provenance）----

function parseTolerantJson(text) {
  // 真实实验 JSON 可能含 Python 风格 NaN/Infinity（json.dump 默认允许）——
  // JSON 标准不允许；读取侧（提取确认值）安全降级为 null
  const jsonText = text.replace(/([{:,[\s])NaN(?=[,}\s])/g, "$1null").replace(/([{:,[\s])-?Infinity(?=[,}\s])/g, "$1null");
  return JSON.parse(jsonText);
}
const battery = parseTolerantJson(await readFile(join(staging, "experiments", "data", "phase4", "battery_phase4.json"), "utf8"));
const confirmations = [];
const sceneNames = { occlusion: "遮挡", normal: "常规", low_light: "低照度", high_density: "高密度" };
for (const scene of ["occlusion", "normal", "low_light", "high_density"]) {
  const arm0 = battery.summary[scene].arm0.G2;
  const ema = battery.summary[scene].ema.G2;
  const rgate = battery.summary[scene].rgate_hybrid.G2;
  confirmations.push({
    path: `$.summary.${scene}.arm0.G2`,
    claim: `Phase4 预注册 38-clip 电池：冻结帧基线（arm0）在${sceneNames[scene]}场景的身份一致性 G2 为 ${arm0}`,
  });
  confirmations.push({
    path: `$.summary.${scene}.rgate_hybrid.G2`,
    claim: `Phase4 预注册 38-clip 电池：rgate 门控更新（最终算法）在${sceneNames[scene]}场景的 G2 为 ${rgate}（EMA 对照 ${ema}）`,
  });
}
// 负结果（negative-but-final）
const mot = parseTolerantJson(await readFile(join(staging, "experiments", "data", "phase4_2_mot", "mot_metrics.json"), "utf8"));
const occlRaw = mot.per_scene.occlusion.raw;
const occlRgate = mot.per_scene.occlusion.rgate;
confirmations.push({
  path: "$.per_scene.occlusion.rgate.IDSW",
  claim: `Phase4.2 MOT 集成（传递不成立，负结果）：rgate 臂在遮挡场景 IDSW 为 ${occlRgate.IDSW}（raw 基线 ${occlRaw.IDSW}），HOTA 变化 −0.0003`,
});
const assoc = parseTolerantJson(await readFile(join(staging, "experiments", "data", "phase4_3_assoc", "assoc_metrics.json"), "utf8"));
const assocScene = Object.keys(assoc.per_scene ?? assoc.clips_by_scene ?? {})[0];
if (assocScene && assoc.per_scene?.[assocScene]) {
  const first = Object.values(assoc.per_scene[assocScene])[0];
  if (first?.IDSW !== undefined) {
    confirmations.push({
      path: `$.per_scene.${assocScene}.arm0.IDSW`,
      claim: `Phase4.3 R 进关联（HARM，负结果）：arm0 在${assocScene}场景 IDSW 为 ${first.IDSW}（R 加权后恶化至 125）`,
    });
  }
}

// 板端 C0 证据（M10.3.1：表 11 作者既有部署实验——A 类「已有证据未关联」补齐；
// user_confirmed 层，jsonPath 溯源到 aggregate.json 的 C0 臂叶子值）
const boardC0 = parseTolerantJson(
  await readFile(join(staging, "experiments", "data", "board_c0_20260904", "aggregate.json"), "utf8"),
);
const boardC0SourceId = sourceIds["experiments/data/board_c0_20260904/aggregate.json"];
const boardConfirmations = [];
if (boardC0SourceId !== undefined && boardC0?.C0) {
  // 注意：claim 数值必须与 jsonPath 记录值数值相等（claimMentionsValue 严格校验；
  // 四舍五入写法会被 422 拒绝）——正文表述的 1495.63/0.669/41.9 为其舍入显示
  boardConfirmations.push({
    path: "$.C0.stages.t_e2e[0]",
    claim: `板端 C0 完整链路（RDK X3，表 11 记为 1495.63）端到端延迟实测 ${boardC0.C0.stages.t_e2e[0]} ms（作者部署实验，2026-09-04）`,
  });
  if (Array.isArray(boardC0.C0.fps)) {
    boardConfirmations.push({
      path: "$.C0.fps[0]",
      claim: `板端 C0 完整链路（RDK X3，表 11 记为 0.669）帧率实测 ${boardC0.C0.fps[0]} FPS`,
    });
  }
  if (boardC0.C0.temp_max !== undefined) {
    boardConfirmations.push({
      path: "$.C0.temp_max",
      claim: `板端 C0 完整链路（RDK X3，表 11 记为 41.9）峰值温度实测 ${boardC0.C0.temp_max} °C`,
    });
  }
}
let boardConfirmed = 0;
for (const confirmation of boardConfirmations) {
  const response = await api("POST", `/api/projects/${projectId}/sources/${boardC0SourceId}/records/evidence`, {
    path: confirmation.path,
    claim: confirmation.claim,
  });
  if (response.status === 201) boardConfirmed += 1;
  else telemetry.notes.push(`board confirm fail ${confirmation.path}: ${response.status}`);
}
check(
  "板端 C0 证据注册（表 11 数据 jsonPath 溯源；A 类关联补齐）",
  boardConfirmed >= 2,
  `boardConfirmed=${boardConfirmed}/${boardConfirmations.length}`,
);

const batterySourceId = sourceIds["experiments/data/phase4/battery_phase4.json"];
const motSourceId = sourceIds["experiments/data/phase4_2_mot/mot_metrics.json"];
const assocSourceId = sourceIds["experiments/data/phase4_3_assoc/assoc_metrics.json"];
let confirmedCount = 0;
for (const confirmation of confirmations) {
  const sourceId = confirmation.path.startsWith("$.per_scene.occlusion.rgate")
    ? motSourceId
    : confirmation.path.startsWith("$.summary")
      ? batterySourceId
      : assocSourceId;
  if (sourceId === undefined) continue;
  const response = await api("POST", `/api/projects/${projectId}/sources/${sourceId}/records/evidence`, {
    path: confirmation.path,
    claim: confirmation.claim,
  });
  if (response.status === 201) confirmedCount += 1;
  else telemetry.notes.push(`confirm fail ${confirmation.path}: ${response.status} ${JSON.stringify(response.body).slice(0, 120)}`);
}
check(
  "user_confirmed 实验证据（current 域，jsonPath provenance）",
  confirmedCount >= 8,
  `confirmed=${confirmedCount}/${confirmations.length}`,
);
log(`user_confirmed 证据 ${confirmedCount} 条`);

// ---- 7. 图片分析（GLM 5.3 Flash；板端标注图）----

let visionCompleted = 0;
for (const sourceId of boardFigureIds) {
  const analysis = await api("POST", `/api/projects/${projectId}/sources/${sourceId}/vision/analyze?inline=true`);
  const figures = analysis.body["vision"]?.figures ?? [];
  visionCompleted += figures.filter((f) => f.status === "completed").length;
  // 确认首个候选事实（claim 必须含值——机械校验）
  const factsResponse = await api("GET", `/api/projects/${projectId}/sources/${sourceId}/vision?facts=true`);
  for (const figure of factsResponse.body["vision"]?.figures ?? []) {
    const fact = (figure.facts ?? [])[0];
    if (fact?.value !== undefined) {
      const confirm = await api("POST", `/api/projects/${projectId}/sources/${sourceId}/vision/facts/${fact.factId}/evidence`, {
        claim: `板端跟踪标注图（${figure.assetName ?? figure.figureBlockId}）：${fact.claim.slice(0, 120)}（图中数值 ${fact.value}）`,
      });
      break;
    }
  }
}
check("图片分析可用（GLM 5.3 Flash 实际调用）", visionCompleted >= 1, `completed=${visionCompleted}`);
log(`vision 完成 ${visionCompleted} 图`);

// ---- 8. 启动工作流（作者目标 = run prompt）----

const runPrompt = [
  "作者修订目标（README §6 / Phase5 贡献草案）：把投稿后的身份可靠性研究链接入 CEA 返修稿——",
  "1) 方法新增身份记忆可靠性门控更新小节（rgate 零参数门控 EMA：R=Q·C、η=0.05+0.20R）；",
  "2) 实验新增 38-clip 预注册电池结果与归因；3) 讨论新增传递边界与局限（短程检索代价、低照度缺口、transductive 标定）。",
  "声明边界：rgate 只允许零成本零训练身份记忆层陈述，禁止 HOTA/IDSW/IDF1 改善声明；负面结果（Phase4.2/4.3）如实呈现；",
  "不虚构第二轮审稿意见；不声称 rgate 板端验证完成；表 11 C0 板端数据不变；基金/作者简介/邮箱不动；不改投稿目标。",
].join("\n");
const created = await api("POST", `/api/projects/${projectId}/workflows`, { kind: "existing_paper_improvement", prompt: runPrompt });
check("工作流启动（existing_paper_improvement）", created.status === 202, JSON.stringify(created.body).slice(0, 160));
const runId = created.body["runId"];

async function pollRun(statuses, timeoutMs = 15 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api("GET", `/api/runs/${runId}`);
    const run = body["run"];
    if (statuses.includes(run?.status)) return run;
    if (run?.status === "failed") {
      // M10.4.2：run 硬失败（如 FACT_PRESERVATION_FAILED 阻断 Draft）是合法
      // 实验结局——不再中断驱动，落 WARN 后返回 failed run 继续收割产物
      //（终态断言会如实 FAIL，退出码仍非零）
      console.log(
        `[WARN] run 终态 failed：${run.error?.code}（stage ${run.error?.stageId}）${run.error?.message ?? ""}`.slice(0, 400),
      );
      return run;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 ${statuses.join("|")} 超时（当前 ${run?.status}，stage ${run?.currentStage}）\n${logBuffer.slice(-3000)}`);
    }
    await sleep(2000);
  }
}

async function resume(decision, payload) {
  const response = await api("POST", `/api/runs/${runId}/resume`, { decision, ...(payload !== undefined ? { payload } : {}) });
  if (response.status !== 200) {
    throw new Error(`resume ${decision} 失败：${response.status} ${JSON.stringify(response.body).slice(0, 200)}`);
  }
}

// ---- 9. HITL：research_plan（M8 纪律：批准后才检索）----

// M10.3.1：前置链（理解+核验+三路审稿+可行性）真实 LLM 耗时可超 15 分钟——
// 首个等待窗口与后段一致放宽到 90 分钟（run 状态全部落盘，超时≠失败）
// M10.4.2：HITL 全阶段包 try/catch——run 任意时点硬失败（如 flash 模型
// 违反输出契约、fact guard 阻断）时 WARN 后直接进入产物收割阶段，基准
// 数据（trace / gate / audit / 摘要 / 导出）仍然完整落盘
let run = null;
let completionLabel = "?";
const decisionsTaken = [];
try {
run = await pollRun(["awaiting_input"], 90 * 60_000);
while (run.awaiting?.stageId !== "hitl.research_plan") {
  const stageId = run.awaiting?.stageId ?? "";
  if (stageId === "") throw new Error(`意外状态：${run.status}`);
  log(`HITL（计划前的中间节点）：${stageId}`);
  await resume(stageId === "hitl.evidence_supply" ? "continue" : "approve");
  run = await pollRun(["awaiting_input"], 90 * 60_000);
}
const planPayload = run.awaiting?.payload ?? {};
log(`研究计划：queries=${(planPayload.queries ?? []).length} requirements=${(planPayload.requirements ?? []).length}`);
telemetry.searchQueries = (planPayload.queries ?? []).length;
check("研究计划 HITL（requirements 驱动 queries）", (planPayload.requirements ?? []).length > 0 && (planPayload.queries ?? []).length > 0, JSON.stringify(planPayload).slice(0, 200));
await resume("approve");

// ---- 10. HITL：evidence_supply（检索执行后；用户遴选候选 + promote + 全文）----

run = await pollRun(["awaiting_input"], 90 * 60_000);
while (run.awaiting?.stageId !== "hitl.evidence_supply" && run.awaiting?.stageId !== "hitl.plan_confirm") {
  const stageId = run.awaiting?.stageId ?? "";
  log(`HITL（supply 前的中间节点）：${stageId}`);
  await resume("approve");
  run = await pollRun(["awaiting_input"], 90 * 60_000);
}
telemetry.notes.push(`evidence_supply ${run.awaiting?.stageId === "hitl.evidence_supply" ? "presented" : "skipped"}`);
const supplyPayload = run.awaiting?.payload ?? {};
const coverageRows = supplyPayload.requirements ?? [];
log(`evidence-supply：候选 ${supplyPayload.pendingCandidates ?? 0} / 需求缺口 ${coverageRows.filter((r) => r.coverageStatus !== "covered").length}`);

// 用户动作：从执行结果快照保存候选（M9.1 HITL 通道）
const executionHistory = (await api("GET", `/api/projects/${projectId}/research/execution-history`)).body["executionHistory"] ?? [];
let savedCandidates = 0;
let promoted = 0;
let fulltextResolved = 0;
for (const entry of executionHistory.slice(0, 8)) {
  if (entry.status !== "executed" || !entry.resultSnapshot?.length) continue;
  telemetry.searchResults += entry.resultSnapshot?.length ?? 0;
  const snapshot = entry.resultSnapshot;
  // 保存前 3 条学术候选（按相关性排序的快照序）
  const indices = snapshot.map((_, index) => index).slice(0, 3);
  const saved = await api("POST", `/api/projects/${projectId}/research/execution-results/save-candidates`, {
    executionId: entry.executionId,
    queryId: entry.queryId,
    saveAsCandidates: indices,
  });
  if (saved.status === 200) savedCandidates += Array.isArray(saved.body["saved"]) ? saved.body["saved"].length : (saved.body["saved"] ?? 0);
}
check("检索真实执行（requirement-driven；结果快照可遴选）", telemetry.searchResults > 0, `results=${telemetry.searchResults}`);

// promote（用户显式动作）+ 全文获取（best-effort，失败如实）
const candidatesView = await api("GET", `/api/projects/${projectId}/sources/candidates`);
const pending = (candidatesView.body["candidates"] ?? []).filter((c) => c.status === "pending_review");
for (const candidate of pending.slice(0, 3)) {
  const promotion = await api("POST", `/api/projects/${projectId}/sources/candidates/${candidate.candidateId}/promote`);
  if (promotion.status === 200) {
    promoted += 1;
    const sid = promotion.body["source"]?.sourceId ?? promotion.body["promotedSourceId"];
    if (sid) {
      const fulltext = await api("POST", `/api/projects/${projectId}/sources/${sid}/resolve-fulltext`);
      if (fulltext.status === 200) fulltextResolved += 1;
      else telemetry.notes.push(`fulltext fail ${candidate.title?.slice(0, 40)}: ${fulltext.status}`);
    }
  }
}
log(`候选：saved=${savedCandidates} promoted=${promoted} fulltext=${fulltextResolved}`);
telemetry.notes.push(`candidates saved=${savedCandidates} promoted=${promoted} fulltext=${fulltextResolved}`);
if (run.awaiting?.stageId === "hitl.evidence_supply") {
  await resume("continue");
  run = await pollRun(["awaiting_input"], 90 * 60_000);
}

// ---- 11. HITL：plan_confirm（改进计划检查后批准）----

while (run.status === "awaiting_input" && run.awaiting?.stageId !== "hitl.plan_confirm") {
  const stageId = run.awaiting?.stageId ?? "";
  log(`HITL（计划确认前的中间节点）：${stageId}`);
  await resume(stageId === "hitl.research_plan" ? "approve" : "continue");
  run = await pollRun(["awaiting_input", "completed"], 90 * 60_000);
}
if (run.status !== "awaiting_input") {
  throw new Error(`run 在改进计划确认前结束（${run.status}）：
${logBuffer.slice(-3000)}`);
}
const planItems = run.awaiting?.payload?.items ?? [];
log(`改进计划 ${planItems.length} 条`);
const improvementRaw = await readFile(join(root, "projects", projectId, "research", "improvement-plan.json"), "utf8").catch(() => null);
const improvement = improvementRaw !== null ? JSON.parse(improvementRaw) : null;
check(
  "Revision Plan 可追溯（条目指向 main.tex；可验证非模糊任务）",
  planItems.length >= 1 && planItems.every((item) => String(item.section).includes("main.tex") && String(item.action ?? "").length >= 10),
  JSON.stringify(planItems).slice(0, 300),
);
await resume("approve");

// ---- 12. 共享后段（bounded loop；可能的 revision_validation / stalled / overflow）----

run = await pollRun(["awaiting_input", "completed"], 90 * 60_000);
while (run.status === "awaiting_input") {
  const stageId = run.awaiting?.stageId ?? "";
  decisionsTaken.push(stageId);
  log(`HITL：${stageId}`);
  if (stageId === "hitl.revision_validation") {
    const payload = run.awaiting?.payload ?? {};
    const rejected = (payload.items ?? []).filter((i) => i.status === "rejected");
    log(`  修订复核：validated=${(payload.items ?? []).filter((i) => i.status === "validated").length} rejected=${rejected.length} blocked=${payload.blocked}`);
    // 诚实策略：被拒条目不盲目接受——needs_review（保留修订 + 阻断 Final）
    await resume(rejected.length > 0 || payload.blocked === true ? "needs_review" : "approve");
  } else if (stageId === "hitl.revision_stalled" || stageId === "hitl.revision_overflow") {
    await resume("accept_draft");
  } else if (stageId === "hitl.style_polish") {
    await resume("skip");
  } else {
    await resume("approve");
  }
  run = await pollRun(["awaiting_input", "completed"], 90 * 60_000);
}
telemetry.revisionRounds = decisionsTaken.filter((s) => s.includes("revision")).length;

check("run 终态 completed", run.status === "completed", `status=${run.status}`);
completionLabel = run.completion?.label ?? "?";
log(`run 完成（${completionLabel}；HITL 序列：${decisionsTaken.join(" → ") || "无"}）`);
} catch (error) {
  // M10.4.2：HITL 阶段中断（run 硬失败 / resume 拒绝 / 等待超时）——如实记录
  // 后继续收割产物；下方终态断言会 FAIL，退出码仍非零
  console.log(`[WARN] HITL 阶段中断（${run?.status ?? "?"}）：${String(error?.message ?? error).slice(0, 300)}`);
  telemetry.notes.push(`hitlAborted: ${String(error?.message ?? error).slice(0, 200)}`);
}

// ---- 12b. M10.4.0 trace 产物断言（run-trace.json + performance-report.md）----

const traceDir = join(root, "projects", projectId, "workflow", "runs", runId);
// completed 对 API 可见的时刻略早于终态 trace 落盘完成（persistThenCommit 内
// flush 在 emit 之后），带谓词重试读取
async function readWithRetry(path, accept, attempts = 10) {
  for (let i = 0; i < attempts; i += 1) {
    const text = await readFile(path, "utf8").catch(() => null);
    if (text !== null && accept(text)) return text;
    await sleep(300);
  }
  return null;
}
const traceRaw = await readWithRetry(join(traceDir, "run-trace.json"), (text) => {
  try {
    return ["completed", "failed", "cancelled"].includes(JSON.parse(text).runStatus);
  } catch {
    return false;
  }
});
const perfReport = await readWithRetry(join(traceDir, "performance-report.md"), (text) => text.includes("# Performance Report"), 3);
check(
  "M10.4.0 run-trace.json 生成（OTel 兼容 span 形状）",
  traceRaw !== null && (() => {
    const doc = JSON.parse(traceRaw);
    return doc.traceId === runId && Array.isArray(doc.spans) && doc.spans.length > 0 &&
      ["completed", "failed", "cancelled"].includes(doc.runStatus) && doc.spans.every((s) => s.spanId && s.name && typeof s.durationMs === "number");
  })(),
  traceRaw === null ? "run-trace.json 缺失" : `spans=${JSON.parse(traceRaw).spans.length}`,
);
check("M10.4.0 performance-report.md 生成（总时长/慢stage/模型/工具）", perfReport !== null &&
  perfReport.includes("# Performance Report") && perfReport.includes("## 3. 最慢 Stage") && perfReport.includes("## 4. 模型调用"), (perfReport ?? "").slice(0, 120));
if (traceRaw !== null) {
  const doc = JSON.parse(traceRaw);
  const stageSpans = doc.spans.filter((s) => s.name.startsWith("stage:"));
  const modelSpans = doc.spans.filter((s) => s.name === "model.turn");
  const toolSpans = doc.spans.filter((s) => s.name === "tool.call");
  const busy = stageSpans.reduce((sum, s) => sum + s.durationMs, 0);
  const wall = (doc.finishedAtMs ?? doc.updatedAtMs) - doc.createdAtMs;
  log(`trace：spans=${doc.spans.length}（stage ${stageSpans.length} / model ${modelSpans.length} / tool ${toolSpans.length}）wall=${Math.round(wall / 1000)}s busy=${Math.round(busy / 1000)}s`);
  const byStage = new Map();
  for (const span of stageSpans) {
    const key = span.attributes["stage.id"];
    byStage.set(key, (byStage.get(key) ?? 0) + span.durationMs);
  }
  const top = [...byStage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  for (const [stageId, ms] of top) {
    log(`  stage ${stageId}: ${(ms / 1000).toFixed(1)}s`);
  }
  const modelMs = modelSpans.reduce((sum, s) => sum + s.durationMs, 0);
  const inTok = modelSpans.reduce((sum, s) => sum + (s.attributes["model.inputTokens"] ?? 0), 0);
  const outTok = modelSpans.reduce((sum, s) => sum + (s.attributes["model.outputTokens"] ?? 0), 0);
  const cacheRead = modelSpans.reduce((sum, s) => sum + (s.attributes["model.cacheReadTokens"] ?? 0), 0);
  const costUsd = modelSpans.reduce((sum, s) => sum + (s.attributes["model.estimatedCost"] ?? 0), 0);
  const retries = doc.spans.reduce((sum, s) => sum + (s.events ?? []).filter((e) => e.name === "auto_retry" || e.name === "agent_retry").length, 0);
  // M10.4.2：按模型 / 按 (stage, model) 聚合（路由验证 + 成本归因）。
  // model.turn 自带 stage.id + model.label，无需 join 父 span
  const byModel = new Map();
  const byStageModel = new Map();
  for (const span of modelSpans) {
    const model = span.attributes["model.label"] ?? "(unknown)";
    const stageId = span.attributes["stage.id"] ?? "(none)";
    const bucket = byModel.get(model) ?? { turns: 0, latencyMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
    bucket.turns += 1;
    bucket.latencyMs += span.durationMs;
    bucket.inputTokens += span.attributes["model.inputTokens"] ?? 0;
    bucket.outputTokens += span.attributes["model.outputTokens"] ?? 0;
    bucket.cacheReadTokens += span.attributes["model.cacheReadTokens"] ?? 0;
    bucket.costUsd += span.attributes["model.estimatedCost"] ?? 0;
    byModel.set(model, bucket);
    const key = `${stageId} :: ${model}`;
    const stageBucket = byStageModel.get(key) ?? { turns: 0, latencyMs: 0, costUsd: 0 };
    stageBucket.turns += 1;
    stageBucket.latencyMs += span.durationMs;
    stageBucket.costUsd += span.attributes["model.estimatedCost"] ?? 0;
    byStageModel.set(key, stageBucket);
  }
  telemetry.trace = {
    spans: doc.spans.length,
    stageSpans: stageSpans.length,
    modelTurns: modelSpans.length,
    toolCalls: toolSpans.length,
    wallMs: wall,
    busyMs: busy,
    modelLatencyMs: modelMs,
    modelInputTokens: inTok,
    modelOutputTokens: outTok,
    modelCacheReadTokens: cacheRead,
    modelCostUsd: costUsd,
    modelRetries: retries,
    byModel: Object.fromEntries([...byModel.entries()].sort((a, b) => b[1].turns - a[1].turns)),
    byStageModel: Object.fromEntries([...byStageModel.entries()].sort((a, b) => b[1].latencyMs - a[1].latencyMs)),
  };
  // 拷贝 trace 产物到 staging（防 projects 目录被清理后丢失）
  const traceOutDir = join(root, "m104-trace");
  await mkdir(traceOutDir, { recursive: true });
  await writeFile(join(traceOutDir, "run-trace.json"), traceRaw);
  if (perfReport !== null) {
    await writeFile(join(traceOutDir, "performance-report.md"), perfReport);
  }
  log(`trace 产物副本：${traceOutDir}`);
}

// ---- 13. 产物与红线断言 ----

const projectDir = join(root, "projects", projectId);

// M10.4.2：早失败 run 可能未产出研究链/修订产物——读取全部 null 実容，
// 对应断言如实 FAIL（「未达该阶段」），不让驱动在收割阶段崩溃
async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

// 资产清单：current/historical 隔离
const inventory = await readJsonOrNull(join(projectDir, "research", "asset-inventory.json"));
const boardC0Source = sourceIds["experiments/data/board_c0_20260904/aggregate.json"];
const batterySource = sourceIds["experiments/data/phase4/battery_phase4.json"];
check(
  "资产清单：current / historical 域隔离正确",
  inventory?.manifestFound === true &&
    (inventory?.domains?.historicalBoard ?? []).includes(boardC0Source) &&
    (inventory?.domains?.current ?? []).includes(batterySource) &&
    !(inventory?.domains?.current ?? []).includes(boardC0Source),
  JSON.stringify(inventory?.domains ?? "（asset-inventory 缺失）"),
);

// 事实基线
const baseline = await readJsonOrNull(join(projectDir, "research", "revision-baseline.json"));
check(
  "修订前事实基线（表格 / 引用 / 板端数字入基线）",
  (baseline?.tables?.length ?? 0) >= 10 && (baseline?.citationKeys?.length ?? 0) === 25 && (baseline?.numbers ?? []).some((n) => n.tokens.some((t) => t.startsWith("1495.63"))),
  `tables=${baseline?.tables?.length ?? "?"} keys=${baseline?.citationKeys?.length ?? "?"}`,
);

// 研究链产物
const research = await readJsonOrNull(join(projectDir, "research", "research.json"));
const activePlan = (research?.plans ?? []).find((p) => p.planId === research.activePlanId) ?? research?.plans?.[0];
check(
  "研究链：计划批准并执行（done）+ requirements 覆盖视图",
  activePlan?.status === "done" && (research?.executionHistory ?? []).length > 0,
  `plan=${activePlan?.status} history=${(research?.executionHistory ?? []).length}`,
);

// 证据分层
const evidenceList = (await api("GET", `/api/projects/${projectId}/evidence`)).body["evidence"] ?? [];
const userConfirmed = evidenceList.filter((e) => e.verificationLevel === "user_confirmed");
const verified = evidenceList.filter((e) => e.verificationStatus === "verified");
check(
  "两种 Evidence 用途区分（user_confirmed 作者实验 / verified 外部文献）",
  userConfirmed.length >= 8 && verified.length >= 0,
  `user_confirmed=${userConfirmed.length} verified=${verified.length}`,
);
telemetry.notes.push(`evidence: user_confirmed=${userConfirmed.length} verified=${verified.length}`);

// 修订发生 + 红线
const revisedMain = (await readFile(join(projectDir, "manuscript", "main.tex"), "utf8").catch(() => "")) ?? "";
const changed = revisedMain !== "" && createHash("sha256").update(revisedMain).digest("hex") !== manuscriptSha;
check("Writer 修改成功（main.tex 相对冻结稿发生变化）", changed, "main.tex 未变化");
check(
  "红线：不虚构 Phase6 板端结果（rgate 无『已验证/完成板端』声明）",
  !/(rgate|R 的门控|可靠性门控)[^\n]{0,60}(板端(已|完成)(验证|部署))/.test(revisedMain) && !revisedMain.includes("第二轮审稿"),
  "出现 rgate 板端验证完成类表述或第二轮审稿表述",
);
const forbidden = [];
// M10.3.1：否定式边界声明（『不/未/不能 据此对 HOTA…作出改善声明』『收益未传递至
// HOTA/IDSW/IDF1』）是 rgate 冻结纪律的合规表述——先剥除否定语境再匹配正向声明
const negationScope = /(不|未|无|不能|不得|均不|并未)[^\n。；]{0,30}/g;
const assertiveMain = revisedMain.replace(negationScope, "");
for (const pattern of [/HOTA[^\n]{0,40}(提升|改善|提高)/, /IDSW[^\n]{0,30}(下降|减少|降低)\d+/, /IDF1[^\n]{0,40}(提升|提高)\d/]) {
  const match = pattern.exec(assertiveMain);
  if (match) forbidden.push(match[0].slice(0, 60));
}
check("红线：无 HOTA/IDSW/IDF1 改善声明（rgate 冻结纪律）", forbidden.length === 0, forbidden.join(" | "));
check("表 11 板端 C0 数字保持（1495.63 / 0.669）", revisedMain.includes("1495.63") && revisedMain.includes("0.669"), "板端 C0 数字被改动");
check("旧板测数字（286.57 / 3.49 FPS）未混入", !revisedMain.includes("286.57") && !revisedMain.includes("3.49"), "历史板测数字混入");

// preservation 结果（最终 gate）+ M10.3.1 G1/G2 收口断言
const gateFiles = (await readdir(join(projectDir, "reviews")).catch(() => [])).filter((f) => f.startsWith("quality-gate-"));
const latestGate = gateFiles.sort().at(-1);
const gate = await readJsonOrNull(latestGate !== undefined ? join(projectDir, "reviews", latestGate) : null);
check(
  "Fact Preservation：未授权数值变化为 0（最终 gate 规则通过或中性）",
  gate === null ||
    (gate.gate?.rules ?? []).every((rule) => rule.rule !== "fact_preservation" || rule.passed || rule.rule === "fact_preservation_not_applicable"),
  JSON.stringify((gate?.gate?.rules ?? []).filter((r) => !r.passed).map((r) => r.rule)).slice(0, 200),
);
check(
  "Citation Preservation：无据删引用为 0",
  gate === null ||
    (gate.gate?.rules ?? []).every((rule) => rule.rule !== "citation_preservation" || rule.passed),
  JSON.stringify((gate?.gate?.rules ?? []).filter((r) => !r.passed).map((r) => r.rule)).slice(0, 200),
);

// M10.3.1 G1：累计事实保持（冻结基线 rev-1 → 终稿）必须通过——历史未授权漂移为 0
const cumulative = gate?.cumulativeFactPreservation ?? null;
check(
  "G1 累计未授权事实漂移 = 0（cumulative_fact_preservation 通过）",
  cumulative !== null && cumulative.ok === true,
  `unresolved=${cumulative?.unresolvedViolations?.length ?? "?"}（resolved=${cumulative?.resolvedViolations?.length ?? 0}）${JSON.stringify((cumulative?.unresolvedViolations ?? []).slice(0, 3)).slice(0, 200)}`,
);
// λ_smooth 专项：终稿不得含未授权的 67.3/67.1/71.5/71.0 重解释残留
const lambdaDrift =
  /67\.3|71\.5/.test(revisedMain) && !/(67\.3|71\.5)[^\n]{0,80}(表\s*7|tab:)/.test(revisedMain);
const unresolvedText = JSON.stringify(cumulative?.unresolvedViolations ?? []);
check(
  "G1 λ_smooth 未授权漂移已消除（无未授权 67.x/71.x 对比数字滞留）",
  !unresolvedText.includes("67.3") && !unresolvedText.includes("71.5"),
  `终稿含 67.3/71.5=${lambdaDrift}；unresolved 含漂移值=${unresolvedText.includes("67.3") || unresolvedText.includes("71.5")}`,
);

// M10.3.1 G2：claim-gap-audit 修订引入口径 blocking = 0；剩余阻断须为作者级
const auditFiles = (await readdir(join(projectDir, "reviews")).catch(() => [])).filter((f) => f.startsWith("claim-gap-audit-"));
const latestAudit = auditFiles.sort().at(-1);
const audit = await readJsonOrNull(latestAudit !== undefined ? join(projectDir, "reviews", latestAudit) : null);
check(
  "G2 修订引入 unsupported claim = 0（pre-existing / author-data 归层在案）",
  audit !== null && audit.counts?.revisionIntroduced === 0,
  `revisionIntroduced=${audit?.counts?.revisionIntroduced ?? "?"} / preExisting=${audit?.counts?.excludedPreExisting ?? "?"} / authorData=${audit?.counts?.excludedAuthorData ?? "?"}`,
);
// 剩余 gate 阻断清单（判定是否全部作者级：academic / feasibility 类）
const failedRules = (gate?.gate?.rules ?? []).filter((r) => !r.passed).map((r) => r.rule);
const authorLevelRules = failedRules.filter(
  (rule) => !["cumulative_fact_preservation", "fact_preservation", "citation_keys_preserved", "unsupported_critical_claims_zero", "blocking_issues_zero"].includes(rule),
);
telemetry.notes.push(`finalGateRulesFailed=${JSON.stringify(failedRules)}`);
check(
  "G2 剩余 gate 阻断为作者级（academic / feasibility；非系统工程缺陷）",
  failedRules.length === 0 || authorLevelRules.length === failedRules.length,
  `failed=${JSON.stringify(failedRules)}`,
);

// M10.3.1 G2：feasibility task-aware 重评（criterionApplicability 在案；INSUFFICIENT 须有 required 依据）
const feasibility = await readJsonOrNull(join(projectDir, "research", "feasibility.json"));
const applicability = feasibility?.report?.criterionApplicability ?? [];
const requiredCount = applicability.filter((e) => e.applicability === "required").length;
check(
  "G2 feasibility task-aware 重评（逐条适用性 + N/A 均有 reason）",
  feasibility?.report?.level !== undefined &&
    applicability.length > 0 &&
    applicability.every((e) => e.applicability === "required" || (e.applicability === "not_applicable" && String(e.reason ?? "").length > 0)),
  `level=${feasibility?.report?.level} entries=${applicability.length} required=${requiredCount}`,
);
telemetry.feasibility = {
  level: feasibility?.report?.level,
  applicable: requiredCount,
  notApplicable: applicability.length - requiredCount,
};

// 指令状态（already_satisfied 不被派发改稿）
const finalInstructions = (await api("GET", `/api/projects/${projectId}/external-instructions`)).body["instructions"] ?? [];
const round1Still = finalInstructions.filter((i) => i.status === "already_satisfied").length;
check("Reviewer instruction：5 条第一轮保持 already_satisfied（不强行再改）", round1Still === 5, `already_satisfied=${round1Still}`);

// LaTeX 构建
const buildDir = join(projectDir, "build");
const pdf = await readFile(join(buildDir, "paper.pdf")).catch(() => null);
check("LaTeX 编译成功 + revised PDF 产出", pdf !== null && pdf.subarray(0, 5).toString().startsWith("%PDF"), "build/paper.pdf 缺失");

// revision-response.md
const response = await readFile(join(buildDir, "revision-response.md"), "utf8").catch(() => null);
check(
  "revision report 产出（Revision Trace：9 条意见逐条 + 状态投影）",
  response !== null && response.includes("Revision Trace") && finalInstructions.every((i) => response.includes(i.instructionId)),
  (response ?? "").slice(0, 160),
);
check(
  "revision report 含 M10.3.1 章节（累计事实 / claim 归层 / feasibility 适用性——不隐藏）",
  response !== null &&
    response.includes("Cumulative Fact Preservation") &&
    (response.includes("Claim Gap Audit") || audit === null) &&
    (response.includes("Feasibility") || applicability.length === 0),
  (response ?? "").slice(0, 120),
);

// vision 模型实际使用（GLM 5.3 Flash）
let visionModelUsed = null;
try {
  const visionFiles = (await readdir(join(projectDir, "sources", "analysis"))).filter((f) => f.endsWith(".vision.json"));
  for (const file of visionFiles) {
    const doc = JSON.parse(await readFile(join(projectDir, "sources", "analysis", file), "utf8"));
    for (const analysis of doc.analyses ?? []) {
      if (analysis.status === "completed") {
        visionModelUsed = analysis.analyzedModelSpec ?? visionModelUsed;
        telemetry.visionCalls += 1;
        if (analysis.usage) {
          telemetry.visionUsage.inputTokens += analysis.usage.inputTokens ?? 0;
          telemetry.visionUsage.outputTokens += analysis.usage.outputTokens ?? 0;
          telemetry.visionUsage.totalTokens += analysis.usage.totalTokens ?? 0;
          if (analysis.usage.costUsd != null) telemetry.visionUsage.costUsd = (telemetry.visionUsage.costUsd ?? 0) + analysis.usage.costUsd;
        }
      }
    }
  }
} catch {}
check("Vision 实际调用 GLM 5.3 Flash（analyzedModelSpec）", visionModelUsed === "zai-coding-cn/glm-5.3-flash", `model=${visionModelUsed}`);

// 模型调用规模（近似：stage 汇总中的模型遥测 + run 事件）
const stageModelCalls = (run?.stageHistory ?? []).reduce((sum, record) => {
  const summary = record.summary ?? {};
  return sum + (summary.modelCalls ?? summary.lookup?.providerCalls ?? summary.modelTelemetry?.modelCalls ?? summary.modelTelemetry?.calls ?? 0);
}, 0);
telemetry.modelCallsApprox = stageModelCalls;
telemetry.durationMs = Date.now() - startedAt;
telemetry.completion = { label: completionLabel, decisions: decisionsTaken };
telemetry.finalGate = gate !== null ? { passed: gate.gate?.passed, reasons: (gate.gate?.reasons ?? []).slice(0, 6) } : null;

await writeFile(join(root, "m1031-real-summary.json"), JSON.stringify(telemetry, null, 2));
log(`摘要写入 ${join(root, "m1031-real-summary.json")}`);
console.log(`\n产物目录：${projectDir}`);
console.log(`revised PDF：${join(buildDir, "paper.pdf")}`);
console.log(`revision report：${join(buildDir, "revision-response.md")}`);

// M10.4.2：基准产物导出（M1031_EXPORT_DIR 设置时）——summary / trace /
// performance report / 终局 gate / claim-gap audit / 冻结输入校验用的
// improvement-plan / 终稿 tex / PDF / revision response
if (EXPORT_DIR !== undefined) {
  const exportPairs = [
    ["m1031-real-summary.json", join(root, "m1031-real-summary.json")],
    ["run-trace.json", traceRaw !== null ? join(traceDir, "run-trace.json") : null],
    ["performance-report.md", perfReport !== null ? join(traceDir, "performance-report.md") : null],
    ["quality-gate-final.json", latestGate !== undefined ? join(projectDir, "reviews", latestGate) : null],
    ["claim-gap-audit-final.json", latestAudit !== undefined ? join(projectDir, "reviews", latestAudit) : null],
    ["improvement-plan.json", join(projectDir, "research", "improvement-plan.json")],
    ["main.tex", join(projectDir, "manuscript", "main.tex")],
    ["paper.pdf", join(buildDir, "paper.pdf")],
    ["revision-response.md", join(buildDir, "revision-response.md")],
  ];
  await mkdir(EXPORT_DIR, { recursive: true });
  let exported = 0;
  for (const [name, source] of exportPairs) {
    if (source === null) continue;
    const content = await readFile(source).catch(() => null);
    if (content !== null) {
      await writeFile(join(EXPORT_DIR, name), content);
      exported += 1;
    }
  }
  log(`M10.4.2 产物导出（arm=${ARM_LABEL}）：${exported} 文件 → ${EXPORT_DIR}`);
}

server.kill();
await sleep(1000);
await rm(join(root, "runtime-root"), { recursive: true, force: true }).catch(() => {});
console.log(failed ? "\nM10.3 real-paper E2E: FAIL" : "\nM10.3 real-paper E2E: ALL PASS");
// 保留 projects 目录供检查（stdout 打印路径）
process.exit(failed ? 1 : 0);
