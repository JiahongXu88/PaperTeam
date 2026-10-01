/**
 * M10.4.2 Model Routing Benchmark 编排器（可重复 A/B 基准）：
 * 同一 M10.3 real case 输入（manuscript / evidence / reviewer instructions /
 * revision plan 输入全部固定），仅改模型路由配置，逐 arm 顺序真实运行
 * scripts/m1031-real-e2e.mjs（真实模型 / 检索 / docling / xelatex）。
 *
 * Arms（模型规格均为 zai-coding-cn registry 内）：
 *   A1 all_strong        default=glm-5.3，无 override
 *   A2 planner_strong    default=glm-5.3（planner/reviewer 继承 strong），
 *                        writer=glm-5.3-flash
 *   A3 reviewer_strong   default=glm-5.3-flash（planner/writer/researcher 全
 *                        flash），四路 reviewer=glm-5.3
 *   A4 strict_harness    default=glm-5.3（同 A1），harness 更严：
 *                        WORKFLOW_MAX_REVISION_ROUNDS=1（默认 2）——只动循环
 *                        预算，不动 Fact Gate / Quality Gate
 *
 * 用法：
 *   node scripts/m1042-model-routing-benchmark.mjs [--arm A1|A2|A3|A4|all]
 *        [--out DIR]（默认 D:\PaperTeamData\M10.4.2-outputs）
 *
 * 每 arm 产物导出到 <out>/<arm>/（由 m1031-real-e2e.mjs 的 M1031_EXPORT_DIR
 * 完成）；本脚本聚合 <out>/benchmark-results.json（重复运行同 arm = 覆盖该 arm
 * 条目，其余保留）。arm 顺序 A1→A2→A3→A4 故意把「全 strong 无 override」放
 * 最后收尾——基准结束后磁盘模型偏好自动回到基线。
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CASE_ZIP = process.env.M103_CASE_ZIP ?? "D:\\PaperTeamData\\M10.3-real-paper-case.zip";
const STRONG = "zai-coding-cn/glm-5.3";
const FLASH = "zai-coding-cn/glm-5.3-flash";
const REVIEWER_KEYS = ["academicReviewer", "factReviewer", "styleReviewer", "citationReviewer"];
const ARM_TIMEOUT_MS = 150 * 60_000; // 单 arm 硬上限 150min（基线 ~52-60min）
const BASE = "http://127.0.0.1:8777";

/** 实验臂定义：模型路由 + harness env（env 只作用于该 arm 的 server 进程） */
const ARMS = {
  A1: {
    label: "all_strong",
    description: "全部 strong（glm-5.3；与 M10.3.1/M10.4.0 基线同配置）",
    modelDefault: STRONG,
    agents: {},
    env: {},
    expect: { planner: STRONG, writer: STRONG, reviewer: STRONG, other: STRONG },
  },
  A2: {
    label: "planner_strong_writer_flash",
    description: "strong planner + flash writer + strong reviewer（planner/reviewer 继承 strong 默认）",
    modelDefault: STRONG,
    agents: { writer: FLASH },
    env: {},
    expect: { planner: STRONG, writer: FLASH, reviewer: STRONG, other: STRONG },
  },
  A3: {
    label: "all_flash_except_reviewer",
    description: "全 flash 除 reviewer（default=flash；四路 reviewer + citation override strong）",
    modelDefault: FLASH,
    agents: Object.fromEntries(REVIEWER_KEYS.map((key) => [key, STRONG])),
    env: {},
    expect: { planner: FLASH, writer: FLASH, reviewer: STRONG, other: FLASH },
  },
  A4: {
    label: "strict_harness_strong_writer",
    description: "strong writer（全 strong 模型，同 A1）+ 更严 harness：WORKFLOW_MAX_REVISION_ROUNDS=1（默认 2）",
    modelDefault: STRONG,
    agents: {},
    env: { WORKFLOW_MAX_REVISION_ROUNDS: "1" },
    expect: { planner: STRONG, writer: STRONG, reviewer: STRONG, other: STRONG },
  },
};

// ---- 参数解析 ----

const argv = process.argv.slice(2);
function argValue(flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}
const armArg = argValue("--arm") ?? "all";
const OUT_ROOT = resolve(argValue("--out") ?? "D:\\PaperTeamData\\M10.4.2-outputs");
const armIds = armArg === "all" ? Object.keys(ARMS) : [armArg];
for (const id of armIds) {
  if (!(id in ARMS)) {
    console.error(`未知 arm：${id}（可选 ${Object.keys(ARMS).join("/")} 或 all）`);
    process.exit(2);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const startedAt = new Date();

function log(message) {
  console.log(`[${Math.round((Date.now() - startedAt.getTime()) / 1000)}s] ${message}`);
}

// ---- 输入身份固定 ----

const caseSha = createHash("sha256").update(await readFile(CASE_ZIP)).digest("hex");
log(`输入 ZIP：${CASE_ZIP}`);
log(`输入 SHA256：${caseSha}`);

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** 路由验证：按 (stage → 角色族) 检查 model.turn 实际使用的模型 */
function verifyRouting(byStageModel, expect) {
  const mismatches = [];
  const seen = { planner: 0, writer: 0, reviewer: 0, other: 0 };
  for (const [key, value] of Object.entries(byStageModel ?? {})) {
    const stageId = key.split(" :: ")[0];
    const model = key.split(" :: ")[1];
    const family = stageId === "plan.improvement"
      ? "planner"
      : stageId.startsWith("revision.")
        ? "writer"
        : stageId.startsWith("review.") || stageId.startsWith("citation.")
          ? "reviewer"
          : "other";
    seen[family] += value.turns ?? 0;
    if (model !== expect[family]) {
      mismatches.push(`${stageId} 期望 ${expect[family]} 实际 ${model}（${value.turns} turns）`);
    }
  }
  return { ok: mismatches.length === 0, mismatches, turnsByFamily: seen };
}

async function pdfPageCount(path) {
  try {
    const buffer = await readFile(path);
    const text = buffer.toString("latin1");
    const matches = text.match(/\/Type\s*\/Page[^s]/g);
    return matches ? matches.length : null;
  } catch {
    return null;
  }
}

/** 端口守卫：若 8777 仍有响应（异常残留 server），netstat+taskkill 强制清理 */
async function ensurePortFree() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) return;
    } catch {
      return; // 连接失败 = 端口空闲
    }
    log(`端口 8777 仍被占用（尝试 ${attempt + 1}/3）——netstat 定位并 taskkill`);
    const child = spawn("cmd", ["/c", "netstat -ano | findstr :8777"], { shell: false });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    await new Promise((resolveExit) => child.on("close", resolveExit));
    const pids = [...new Set(
      output
        .split("\n")
        .filter((line) => line.includes("LISTENING"))
        .map((line) => line.trim().split(/\s+/).at(-1)),
    )];
    for (const pid of pids) {
      if (pid && pid !== "0") {
        spawn("taskkill", ["//PID", pid, "//T", "//F"]);
        log(`taskkill //PID ${pid} //T //F`);
      }
    }
    await sleep(5000);
  }
}

// ---- 主循环：逐 arm 运行 ----

await mkdir(OUT_ROOT, { recursive: true });
const resultsPath = join(OUT_ROOT, "benchmark-results.json");
const results = (await readJson(resultsPath)) ?? {};
results.benchmark = {
  caseZip: CASE_ZIP,
  caseSha256: caseSha,
  startedAt: startedAt.toISOString(),
  updatedAt: new Date().toISOString(),
};
results.arms ??= {};

for (const armId of armIds) {
  const arm = ARMS[armId];
  const exportDir = join(OUT_ROOT, armId);
  const armStartedAt = new Date();
  log(`=== Arm ${armId}（${arm.label}）：${arm.description} ===`);
  await ensurePortFree();

  const child = spawn(process.execPath, [join(SCRIPT_DIR, "m1031-real-e2e.mjs")], {
    cwd: SCRIPT_DIR,
    env: {
      ...process.env,
      M1031_ARM_LABEL: arm.label,
      M1031_MODEL_DEFAULT: arm.modelDefault,
      M1031_MODEL_AGENTS: JSON.stringify(arm.agents),
      M1031_EXPORT_DIR: exportDir,
      ...arm.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let consoleTail = "";
  const pushOutput = (chunk) => {
    const text = chunk.toString();
    consoleTail = (consoleTail + text).slice(-8000);
    process.stdout.write(`[A${armId}] ${text}`);
  };
  child.stdout.on("data", pushOutput);
  child.stderr.on("data", pushOutput);

  const exitCode = await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      log(`Arm ${armId} 超时（${ARM_TIMEOUT_MS / 60000}min）——强杀`);
      child.kill();
      resolveExit(null);
    }, ARM_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
  const durationMs = Date.now() - armStartedAt.getTime();
  await ensurePortFree();

  // 结果聚合（exit code 非零不阻断——论文内容级 gate FAIL 属预期记录项）
  const summary = await readJson(join(exportDir, "m1031-real-summary.json"));
  const gate = await readJson(join(exportDir, "quality-gate-final.json"));
  const audit = await readJson(join(exportDir, "claim-gap-audit-final.json"));
  const trace = summary?.trace ?? null;
  const routing = trace ? verifyRouting(trace.byStageModel, arm.expect) : { ok: null, mismatches: ["trace 缺失"], turnsByFamily: {} };
  const pdfBytes = await stat(join(exportDir, "paper.pdf")).then((s) => s.size, () => null);
  const pdfPages = pdfBytes !== null ? await pdfPageCount(join(exportDir, "paper.pdf")) : null;

  results.arms[armId] = {
    label: arm.label,
    description: arm.description,
    config: { modelDefault: arm.modelDefault, agents: arm.agents, env: arm.env },
    run: {
      startedAt: armStartedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      driverDurationMs: durationMs,
      exitCode,
      consoleTail: consoleTail.slice(-2000),
    },
    performance: trace
      ? {
          wallMs: trace.wallMs,
          busyMs: trace.busyMs,
          modelTurns: trace.modelTurns,
          modelLatencyMs: trace.modelLatencyMs,
          inputTokens: trace.modelInputTokens,
          outputTokens: trace.modelOutputTokens,
          cacheReadTokens: trace.modelCacheReadTokens,
          costUsd: trace.modelCostUsd,
          toolCalls: trace.toolCalls,
          retries: trace.modelRetries,
          byModel: trace.byModel,
          byStageModel: trace.byStageModel,
        }
      : null,
    quality: summary
      ? {
          factViolations: {
            cumulativeUnresolved: gate?.cumulativeFactPreservation?.unresolvedViolations?.length ?? null,
            cumulativeOk: gate?.cumulativeFactPreservation?.ok ?? null,
          },
          citationPreservationPassed:
            (gate?.gate?.rules ?? []).every(
              (r) => r.rule !== "citation_preservation" && r.rule !== "citation_keys_preserved" || r.passed,
            ),
          unsupportedRevisionIntroduced: audit?.counts?.revisionIntroduced ?? null,
          qualityGatePassed: gate?.gate?.passed ?? null,
          qualityGateFailedRules: (gate?.gate?.rules ?? []).filter((r) => !r.passed).map((r) => r.rule),
          latexBuildOk: pdfBytes !== null,
          pdfPages,
          completion: summary.completion ?? null,
          revisionRounds: summary.revisionRounds ?? null,
          visionCalls: summary.visionCalls ?? null,
        }
      : null,
    routingVerification: routing,
  };
  results.benchmark.updatedAt = new Date().toISOString();
  await writeFile(resultsPath, JSON.stringify(results, null, 2));
  log(`Arm ${armId} 完成（exit=${exitCode}，driver ${Math.round(durationMs / 1000)}s）→ ${resultsPath}`);
}

// ---- 汇总表 ----

console.log(`\n===== M10.4.2 Model Routing Benchmark 汇总 =====`);
console.log(`输入 SHA256：${caseSha}`);
const header = ["arm", "label", "wall(s)", "turns", "inTok", "outTok", "cost($)", "cumFact", "cita", "unsup", "gate", "pdf", "routing"];
console.log(header.join("\t"));
for (const armId of Object.keys(results.arms)) {
  const entry = results.arms[armId];
  const perf = entry.performance;
  const quality = entry.quality;
  console.log(
    [
      armId,
      entry.label,
      perf ? Math.round(perf.wallMs / 1000) : "-",
      perf?.modelTurns ?? "-",
      perf?.inputTokens ?? "-",
      perf?.outputTokens ?? "-",
      perf ? perf.costUsd.toFixed(2) : "-",
      quality ? `${quality.factViolations.cumulativeUnresolved ?? "?"}` : "-",
      quality ? (quality.citationPreservationPassed ? "ok" : "FAIL") : "-",
      quality ? `${quality.unsupportedRevisionIntroduced ?? "?"}` : "-",
      quality ? (quality.qualityGatePassed ? "PASS" : "FAIL") : "-",
      quality ? (quality.latexBuildOk ? `${quality.pdfPages ?? "?"}p` : "-") : "-",
      entry.routingVerification.ok === null ? "?" : entry.routingVerification.ok ? "ok" : "MISMATCH",
    ].join("\t"),
  );
}
console.log(`\n明细：${resultsPath}`);
