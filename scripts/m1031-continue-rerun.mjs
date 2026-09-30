/**
 * M10.3.1 恢复 rerun 续跑脚本：对既有项目（run 因 rev-4 pairwise 违规
 * FACT_PRESERVATION_FAILED 终止后）执行系统内建恢复路径——
 *   revisions restore（rev-4 → rev-5，内容幂等）→ 新 run（existing_paper_improvement）
 * 前段 import.* 确定性 stage 复用磁盘状态快速越过；review/gate 对 restore
 * 修订 pairwise 中性（reason=revision.restore 不比较）；累计守卫继续裁决
 * 冻结基线 → 当前。HITL 驱动与主驱动同策略（revise 轮 stalled/overflow
 * → accept_draft 产出 Draft）。
 * 用法：node scripts/m1031-continue-rerun.mjs <projectId> <projectsRoot>
 */
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ID = process.argv[2];
const PROJECTS_ROOT = process.argv[3];
if (PROJECT_ID === undefined || PROJECTS_ROOT === undefined) {
  console.error("usage: node scripts/m1031-continue-rerun.mjs <projectId> <projectsRoot>");
  process.exit(2);
}
const BASE = "http://127.0.0.1:8777";
const PORT = 8777;
const startedAt = Date.now();
const log = (m) => console.log(`[${Math.round((Date.now() - startedAt) / 1000)}s] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (method, path, body) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, body: json };
};

// 1. 端口守卫 + 启动服务（复用既有 PROJECTS_ROOT）
try {
  const probe = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
  if (probe.ok) throw new Error(`端口 ${PORT} 已被占用——先清理旧进程`);
} catch (error) {
  if (String(error).includes("fetch failed") || String(error).includes("aborted") || String(error).includes("Timeout")) {
    // 空闲，继续
  } else {
    throw error;
  }
}
const server = spawn(process.execPath, ["dist/index.js"], {
  cwd: new URL("../backend/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  env: {
    ...process.env,
    PAPERTEAM_PORT: String(PORT),
    PROJECTS_ROOT: PROJECTS_ROOT,
    PAPERTEAM_RUNTIME_ROOT: process.env.PAPERTEAM_RUNTIME_ROOT ?? "C:\\Users\\Administrator\\.paperteam",
    HF_ENDPOINT: process.env.HF_ENDPOINT ?? "https://hf-mirror.com",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logBuffer = "";
server.stdout.on("data", (d) => (logBuffer += d));
server.stderr.on("data", (d) => (logBuffer += d));
{
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`server not ready:\n${logBuffer.slice(-2000)}`);
    await sleep(1000);
  }
}
await api("PUT", "/api/settings/model", { model: "zai-coding-cn/glm-5.3", visionModel: "zai-coding-cn/glm-5.3-flash" });
log("server up（既有项目工作区）");

// 2. 恢复当前修订（内容幂等：指纹相同则 created=false，不产生新修订）
const before = await api("GET", `/api/projects/${PROJECT_ID}/revisions`);
const currentRev = before.body["current"];
log(`当前修订 rev-${currentRev}`);
const restore = await api("POST", `/api/projects/${PROJECT_ID}/revisions/${currentRev}/restore`);
if (restore.status !== 200) {
  console.error("restore 失败:", restore.status, JSON.stringify(restore.body).slice(0, 200));
  server.kill();
  process.exit(1);
}
log(`restore rev-${currentRev} → rev-${restore.body["revision"] ?? "?"}（created=${restore.body["created"]}）`);

// 3. 新 run（作者目标与主驱动一致；声明边界不变）
const created = await api("POST", `/api/projects/${PROJECT_ID}/workflows`, {
  kind: "existing_paper_improvement",
  prompt: [
    "作者修订目标（README §6 / Phase5 贡献草案）：把投稿后的身份可靠性研究链接入 CEA 返修稿——",
    "1) 方法新增身份记忆可靠性门控更新小节（rgate 零参数门控 EMA：R=Q·C、η=0.05+0.20R）；",
    "2) 实验新增 38-clip 预注册电池结果与归因；3) 讨论新增传递边界与局限（短程检索代价、低照度缺口、transductive 标定）。",
    "声明边界：rgate 只允许零成本零训练身份记忆层陈述，禁止 HOTA/IDSW/IDF1 改善声明；负面结果（Phase4.2/4.3）如实呈现；",
    "不虚构第二轮审稿意见；不声称 rgate 板端验证完成；表 11 C0 板端数据不变；基金/作者简介/邮箱不动；不改投稿目标。",
    "数值纪律：正文不得新增任何无 Evidence / 计划授权的实验数字或协议细节（含置信度阈值、超参数默认值）；不确定的表述一律不写数字。",
  ].join("\n"),
});
if (created.status !== 202) {
  console.error("run 启动失败:", created.status, JSON.stringify(created.body).slice(0, 200));
  server.kill();
  process.exit(1);
}
const runId = created.body["runId"];
log(`续跑 run ${runId}`);

async function pollRun(statuses, timeoutMs = 90 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api("GET", `/api/runs/${runId}`);
    const run = body["run"];
    if (statuses.includes(run?.status)) return run;
    if (run?.status === "failed") {
      throw new Error(`run 失败：${run.error?.code} ${run.error?.message}（stage ${run.error?.stageId}）\n${logBuffer.slice(-2500)}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 ${statuses.join("|")} 超时（当前 ${run?.status}，stage ${run?.currentStage}）\n${logBuffer.slice(-2000)}`);
    }
    await sleep(2000);
  }
}

// 4. HITL 驱动（与主驱动同策略）
let run = await pollRun(["awaiting_input"]);
let enteredRevisionLoop = false;
for (;;) {
  const stageId = run.awaiting?.stageId ?? "";
  log(`HITL：${stageId}`);
  if (stageId === "hitl.revision_validation") {
    const payload = run.awaiting?.payload ?? {};
    const rejected = (payload.items ?? []).filter((i) => i.status === "rejected");
    await api("POST", `/api/runs/${runId}/resume`, { decision: rejected.length > 0 || payload.blocked === true ? "needs_review" : "approve" });
  } else if (stageId === "hitl.revision_stalled" || stageId === "hitl.revision_overflow") {
    enteredRevisionLoop = true;
    await api("POST", `/api/runs/${runId}/resume`, { decision: "accept_draft" });
  } else if (stageId === "hitl.style_polish") {
    await api("POST", `/api/runs/${runId}/resume`, { decision: "skip" });
  } else if (stageId === "hitl.evidence_supply") {
    await api("POST", `/api/runs/${runId}/resume`, { decision: "continue" });
  } else {
    await api("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
  }
  run = await pollRun(["awaiting_input", "completed"]);
  if (run.status === "completed") break;
}
log(`run 完成（${run.completion?.label}）`);
console.log(`COMPLETION=${run.completion?.label}`);
console.log(`RUN_ID=${runId}`);
server.kill();
await sleep(1000);
process.exit(0);
