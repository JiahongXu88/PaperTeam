#!/usr/bin/env node
/**
 * Review 并发基准测试（可重复；不依赖一次性脚本环境）。
 *
 * 用法（在仓库根执行；backend 需先 npm run build）：
 *   node scripts/benchmark-review.mjs
 *   node scripts/benchmark-review.mjs --pdf D:/Tmp/paper.pdf --levels 1,2,3,4 --limit 12
 *   node scripts/benchmark-review.mjs --full --concurrency 3        # 全量 33 节（选定默认后验证）
 *
 * 每个并发档：
 *   1. 起独立 backend（独立 PROJECTS_ROOT 命名空间，不污染用户正式项目）
 *      env：PAPERTEAM_REVIEW_CONCURRENCY=<c>、PAPERTEAM_SUMMARY_CONCURRENCY、
 *      PAPERTEAM_REVIEW_SECTION_LIMIT（A/B 阶段固定代表章节子集）
 *   2. import-pdf（真实解析）→ 从 seed 项目复制 paper-map.json + citation/
 *      （摘要指纹缓存命中、引用记录复用：把测量窗口隔离到 review.sections）
 *   3. 跑 existing_paper_review → 轮询终态 → 读 checkpoint 提取
 *      stage 耗时与 concurrencyTelemetry / modelTelemetry
 *   4. 关进程，输出 JSON + Markdown 汇总（结果写在 --out 目录，默认
 *      D:/Tmp/pt-benchmark/<timestamp>；报告含模型 findings 摘录，不入 Git）
 *
 * 真实 LLM 调用（每档 12-33 次）：费用与时长在启动前打印预算，Ctrl+C 可中止。
 */

import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index !== -1 && index + 1 < args.length ? args[index + 1] : fallback;
}
function argFlag(name) {
  return args.includes(name);
}

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const pdfPath = resolve(argValue("--pdf", "D:/Tmp/paper.pdf"));
const levels = argValue("--levels", "1,2,3,4")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isInteger(value) && value >= 1 && value <= 8);
const fullMode = argFlag("--full");
const fullConcurrency = Number.parseInt(argValue("--concurrency", "3"), 10);
const sectionLimit = fullMode ? 0 : Number.parseInt(argValue("--limit", "12"), 10);
const summaryConcurrency = Number.parseInt(argValue("--summary-concurrency", "3"), 10);
// Windows 文件名不能含冒号：ISO 时间戳先消毒
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const outRoot = resolve(argValue("--out", `D:/Tmp/pt-benchmark/${stamp}`));
const runBudgetMs = Number.parseInt(argValue("--budget-min", "90"), 10) * 60_000;

if (!existsSync(pdfPath)) {
  console.error(`[benchmark] PDF 不存在：${pdfPath}`);
  process.exit(1);
}
if (!existsSync(join(repoRoot, "backend", "dist", "index.js"))) {
  console.error("[benchmark] backend/dist/index.js 不存在：先 npm run build");
  process.exit(1);
}

const distEntry = join(repoRoot, "backend", "dist", "index.js");
const pdfBase64 = (await readFile(pdfPath)).toString("base64");

console.log(`[benchmark] PDF: ${pdfPath}`);
console.log(`[benchmark] 档位: ${fullMode ? `全量（concurrency=${fullConcurrency}）` : levels.join(" / ")}${sectionLimit > 0 ? `（每档前 ${sectionLimit} 节）` : ""}`);
console.log(`[benchmark] 输出: ${outRoot}`);
await mkdir(outRoot, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startBackend(level, projectsRoot) {
  const port = 3910 + level;
  const child = spawn(process.execPath, [distEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PAPERTEAM_PORT: String(port),
      PROJECTS_ROOT: projectsRoot,
      PAPERTEAM_REVIEW_CONCURRENCY: String(level),
      PAPERTEAM_SUMMARY_CONCURRENCY: String(summaryConcurrency),
      ...(sectionLimit > 0 ? { PAPERTEAM_REVIEW_SECTION_LIMIT: String(sectionLimit) } : {}),
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logPath = join(outRoot, `backend-c${level}.log`);
  const { createWriteStream } = await import("node:fs");
  const logStream = createWriteStream(logPath, { flags: "w" });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  const base = `http://127.0.0.1:${port}`;
  // 健康等待（进程起来 + runtime 初始化）
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) {
        break;
      }
    } catch {
      // 未就绪
    }
    if (child.exitCode !== null) {
      throw new Error(`backend c=${level} 提前退出（code=${child.exitCode}），日志：${logPath}`);
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`backend c=${level} 60s 内未就绪，日志：${logPath}`);
    }
    await sleep(500);
  }
  return { child, base, logPath };
}

function stopBackend(child) {
  if (child.exitCode !== null) {
    return;
  }
  // Windows：杀整棵进程树（backend 无子进程，但保持防御性）
  spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  child.kill();
}

async function api(base, method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

async function importPaper(base) {
  const created = await api(base, "POST", "/api/projects/import-pdf", {
    fileName: "benchmark.pdf",
    contentBase64: pdfBase64,
    goal: "review_only",
  });
  return created.project.id;
}

/** 从 seed 项目复制摘要/引用产物：隔离测量窗口到 review.sections（摘要指纹命中 → paper.ensure 秒级） */
async function prewarmFromSeed(projectsRoot, projectId, seedPaperDir) {
  if (seedPaperDir === null) {
    return;
  }
  const targetPaper = join(projectsRoot, projectId, "paper");
  await cp(join(seedPaperDir, "paper-map.json"), join(targetPaper, "paper-map.json"));
  await cp(join(seedPaperDir, "citation"), join(targetPaper, "citation"), { recursive: true });
}

async function waitForRun(base, runId, budgetMs) {
  const startedAt = Date.now();
  let lastStatus = "pending";
  let lastProgress = "";
  for (;;) {
    const { run } = await api(base, "GET", `/api/runs/${runId}`);
    lastStatus = run.status;
    const progress = run.progress ? `${run.progress.stageId ?? ""} ${JSON.stringify(run.progress.data ?? {}).slice(0, 120)}` : "";
    if (progress !== lastProgress) {
      console.log(`    [run] ${lastStatus} ${progress}`);
      lastProgress = progress;
    }
    if (["completed", "failed", "cancelled"].includes(run.status)) {
      return run;
    }
    if (Date.now() - startedAt > budgetMs) {
      throw new Error(`run ${runId} 超时（${Math.round(budgetMs / 60_000)}min，status=${lastStatus}）`);
    }
    await sleep(2_000);
  }
}

function readStageTiming(run, stageId) {
  const records = (run.stageHistory ?? []).filter((record) => record.stageId === stageId && record.status === "completed");
  if (records.length === 0) {
    return null;
  }
  const record = records.at(-1);
  const durationMs = new Date(record.finishedAt).getTime() - new Date(record.startedAt).getTime();
  return { durationMs, record };
}

async function runLevel(level, label, seedPaperDir) {
  const projectsRoot = join(outRoot, `projects-c${level}`);
  await rm(projectsRoot, { recursive: true, force: true });
  console.log(`\n[benchmark] === ${label}（concurrency=${level}）===`);
  const { child, base } = await startBackend(level, projectsRoot);
  try {
    const projectId = await importPaper(base);
    await prewarmFromSeed(projectsRoot, projectId, seedPaperDir);
    const { runId } = await api(base, "POST", `/api/projects/${projectId}/workflows`, {
      kind: "existing_paper_review",
    });
    console.log(`    projectId=${projectId} runId=${runId}`);
    const run = await waitForRun(base, runId, runBudgetMs);
    if (run.status !== "completed") {
      throw new Error(`run 未完成：status=${run.status} error=${JSON.stringify(run.error ?? null)}`);
    }
    const sections = run.stageResults["review.sections"] ?? {};
    const paperEnsure = readStageTiming(run, "paper.ensure");
    const sectionsTiming = readStageTiming(run, "review.sections");
    const row = {
      label,
      concurrency: level,
      projectId,
      runId,
      runTotalMs: run.finishedAt !== undefined ? new Date(run.finishedAt).getTime() - new Date(run.createdAt).getTime() : null,
      sectionsTotal: sections.sectionsTotal ?? null,
      sectionsReviewed: sections.sectionsReviewed ?? null,
      failedSections: sections.failedSections ?? [],
      findingsTotal: sections.findingsTotal ?? null,
      paperEnsureMs: paperEnsure?.durationMs ?? null,
      reviewSectionsWallMs: sectionsTiming?.durationMs ?? null,
      concurrencyTelemetry: sections.concurrencyTelemetry ?? null,
      modelTelemetry: sections.modelTelemetry ?? null,
      startedAt: sectionsTiming?.record.startedAt ?? null,
      finishedAt: sectionsTiming?.record.finishedAt ?? null,
    };
    console.log(`    完成：review.sections=${Math.round(row.reviewSectionsWallMs / 1000)}s，findings=${row.findingsTotal}`);
    return { row, paperDir: join(projectsRoot, projectId, "paper") };
  } finally {
    stopBackend(child);
    await sleep(1_000);
  }
}

const rows = [];
let seedPaperDir = null;
const plan = fullMode ? [{ level: fullConcurrency, label: `full-c${fullConcurrency}` }] : levels.map((level) => ({ level, label: `c${level}` }));
for (const { level, label } of plan) {
  const { row, paperDir } = await runLevel(level, label, seedPaperDir);
  rows.push(row);
  if (seedPaperDir === null) {
    seedPaperDir = paperDir; // 首档作为 seed（摘要/引用产物来源）
  }
}

// ---- 汇总输出（JSON 全量 + Markdown 表格） ----
const benchmarkJson = { generatedAt: new Date().toISOString(), pdfPath, sectionLimit, rows };
await writeFile(join(outRoot, "benchmark.json"), JSON.stringify(benchmarkJson, null, 2), "utf8");

const lines = [
  "# Review Concurrency Benchmark",
  "",
  `- PDF：${pdfPath}`,
  `- 章节子集：${sectionLimit > 0 ? `前 ${sectionLimit} 节` : "全量"}`,
  `- 生成：${benchmarkJson.generatedAt}`,
  "",
  "| C | sections | wall(s) | sum(s) | avg(s) | p95 queueWait(s) | maxConc | calls | retries | 429hint | failures | findings |",
  "| --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |",
];
for (const row of rows) {
  const t = row.concurrencyTelemetry ?? {};
  const m = row.modelTelemetry ?? {};
  const calls = m.calls ?? 0;
  const avg = calls > 0 ? (m.totalMs ?? 0) / calls / 1000 : 0;
  lines.push(
    `| ${row.concurrency} | ${row.sectionsReviewed ?? "-"}/${row.sectionsTotal ?? "-"} | ${Math.round((row.reviewSectionsWallMs ?? 0) / 1000)} | ${Math.round((t.sumSectionDurationMs ?? 0) / 1000)} | ${avg.toFixed(1)} | ${Math.round((t.queueWaitMs?.p95 ?? 0) / 1000)} | ${t.maxObservedConcurrency ?? "-"} | ${calls} | ${t.sectionsRetried ?? 0} | ${t.rateLimitedHint ?? 0} | ${(row.failedSections ?? []).length} | ${row.findingsTotal ?? "-"} |`,
  );
}
const markdown = lines.join("\n") + "\n";
await writeFile(join(outRoot, "benchmark.md"), markdown, "utf8");
console.log(`\n[benchmark] 结果已写入 ${outRoot}`);
console.log(markdown);
