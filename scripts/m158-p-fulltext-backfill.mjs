#!/usr/bin/env node
/**
 * M15.8.1 受控全文恢复（M15.8 §5.D backfill 的正规化重写）。
 *
 * 语义变化（对照旧 m158-p-fulltext-backfill.mjs）：
 *  - 出口修复：ResearchFetchRouter 正确装配（env > network.json > 直连），
 *    researchFetch 注入 buildServiceStack——resolver 元数据查询与 PDF 下载真正
 *    走代理；旧版漏配 researchFetch 全程直连，公司网络下 arXiv 不可达，19 篇
 *    全文失败（proxy-diagnosis.json：直连 30s 超时 / 代理 2.2MB 2.5s）；
 *  - 正规通道优先且唯一：resolveFullTextBatch（resolver 链 → downloadPdf 的
 *    SSRF 逐跳护栏 / 20MB 帽 / %PDF- 魔数 / 主机节流 → attachFile →
 *    provenance=resolver 名）。移除旧版「curl 下载 + attachManualFullText
 *    (manual-upload)」回退——自动下载冒称用户手动上传违反 provenance 诚实性，
 *    且 curl 的网络优势已被代理路径覆盖；
 *  - fail-fast：代理已配置但核心学术路径（代理可达 / arXiv API / arXiv PDF）
 *    不可用 → 结构化退出（PROXY_UNREACHABLE / ARXIV_PDF_TIMEOUT /
 *    TARGET_RATE_LIMITED），不静默降级直连、不空转重试；
 *  - 0 模型：预算账本硬顶 1，结束断言 calls === 0；
 *  - 分层如实记账：downloaded（文件 + resolver provenance）/ parsed（docling
 *    结构化产物）/ chunked（检索 chunk 可用）三层落 manifest；grounded/verified
 *    属 Evidence 核验管道（模型调用），本脚本不触碰、不代答。
 *
 * 用法：node scripts/m158-p-fulltext-backfill.mjs [--sweeps N]（幂等：已有全文
 *   的 skipped_has_file；--sweeps 缺省 2，相邻 sweep 间隔 10s——网络长波用多轮
 *   比内联重试高效）
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const DATA_ROOT = process.env["M158_DATA_ROOT"] ?? "D:\\PaperTeamData\\M15\\M15_8";
const EVAL_DIR = join(DATA_ROOT, "evaluation");
const P_ROOT = join(DATA_ROOT, "projects-root");
const REPAIR_DIR = join(DATA_ROOT, "network-repair");
const MANIFEST_PATH = join(REPAIR_DIR, "fulltext-recovery-manifest.json");
const SUMMARY_PATH = join(REPAIR_DIR, "fulltext-recovery-summary.md");

const sweeps = Number(process.argv.filter((a) => a.startsWith("--sweeps="))[0]?.split("=")[1] ?? process.env["M158_BACKFILL_SWEEPS"] ?? "2");
const reportOnly = process.argv.includes("--report-only");
const targetsArg = process.argv.filter((a) => a.startsWith("--targets="))[0]?.split("=")[1];

process.env["PROJECTS_ROOT"] = P_ROOT;
process.env["PAPERTEAM_GLOBAL_BUDGET_LEDGER"] = join(EVAL_DIR, "budget-ledger-backfill.json");
process.env["PAPERTEAM_GLOBAL_MAX_MODEL_CALLS"] = "1"; // 硬顶 1：本脚本必须零模型
process.env["PAPERTEAM_GLOBAL_MAX_TOKENS"] = "0";

const journalPath = join(EVAL_DIR, "m158-p-journal.json");
const projectId = process.env["M158_PROJECT_ID"] ?? JSON.parse(await readFile(journalPath, "utf8")).projectId;
console.log(`[backfill] project=${projectId} sweeps=${sweeps}`);

const { loadConfig } = await import(distUrl("config", "config.js"));
const { PiRuntimeAdapter } = await import(distUrl("runtime", "PiRuntimeAdapter.js"));
const { SkillRegistry } = await import(distUrl("skills", "SkillRegistry.js"));
const { ModelSettingsStore, resolveStartupModelSpec } = await import(distUrl("settings", "ModelSettingsStore.js"));
const { buildServiceStack } = await import(distUrl("serviceStack.js"));
const { ProjectStore } = await import(distUrl("project", "ProjectStore.js"));
const { LatexCompiler } = await import(distUrl("latex", "LatexCompiler.js"));
const { GlobalBudgetLedger } = await import(distUrl("runtime", "globalBudgetLedger.js"));
const { initResearchNetwork, probeResearchNetwork } = await import(distUrl("network", "researchNetworkBootstrap.js"));

const config = loadConfig();
const budgetLedger = new GlobalBudgetLedger({
  path: config.workflow.globalBudget.ledgerPath,
  limits: { maxCalls: config.workflow.globalBudget.maxCalls, maxTokens: config.workflow.globalBudget.maxTokens },
  label: "M15.8.1 backfill (must stay 0)",
});

// M15.8.1：与生产 index.ts 同一装配 helper（env > network.json > 直连）
const researchNet = await initResearchNetwork({
  settingsDir: join(config.runtimeRoot, "settings"),
  ...(config.research.proxyUrl !== undefined ? { envProxyUrl: config.research.proxyUrl } : {}),
  hints: {
    ...(config.search.openalexMailto !== undefined ? { openalexMailto: config.search.openalexMailto } : {}),
    ...(config.search.semanticScholarApiKey !== undefined
      ? { semanticScholarApiKey: config.search.semanticScholarApiKey }
      : {}),
    ...(config.citation.contactEmail !== undefined ? { crossrefMailto: config.citation.contactEmail } : {}),
  },
  log: (m) => console.log(m),
});

async function finish(code) {
  await researchNet.router.close().catch(() => {});
  process.exit(code);
}

// fail-fast：代理已配置（env 或 network.json enabled）但核心学术路径不可用 → 结构化退出
if (researchNet.effective !== null) {
  const diagnosis = await probeResearchNetwork(researchNet);
  console.log(`[backfill] preflight ${diagnosis.status}（mode=${diagnosis.mode} proxy=${diagnosis.proxyUrl}）：${diagnosis.detail}`);
  if (diagnosis.status !== "PASS") {
    console.error(`[prefail] ${diagnosis.status}：${diagnosis.detail}（代理已配置，不降级直连）`);
    await finish(4);
  }
}

const skillRegistry = new SkillRegistry({ storeRoot: join(config.runtimeRoot, "skills"), disabledSkillIds: config.skills.disabledSkillIds, log: () => {} });
await skillRegistry.ensureInstalled();
const adapter = new PiRuntimeAdapter({
  modelSpec: config.pi.model ?? (await resolveStartupModelSpec(undefined, new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") }))),
  ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
  agentDir: config.pi.agentDir,
  workspaceRoot: P_ROOT,
  runTimeoutMs: config.pi.runTimeoutMs,
  roleSkills: (role, scope) => skillRegistry.skillAssignmentsFor(role, scope),
  roleCustomTools: () => [],
  log: () => {},
});
const projects = new ProjectStore({ root: P_ROOT });
const stack = buildServiceStack({
  runtime: adapter,
  projects,
  latex: new LatexCompiler({ timeoutMs: config.latex.compileTimeoutMs }),
  agentIds: config.agents,
  stageTimeoutMs: config.stageTimeoutMs,
  stageMaxAttempts: config.stageMaxAttempts,
  globalBudget: { ledger: budgetLedger, outputReserveTokens: config.workflow.globalBudget.outputReserveTokens },
  ...(config.search !== undefined ? { search: config.search } : {}),
  ...(config.fullText !== undefined ? { fullText: config.fullText } : {}),
  // M15.8.1：学术出口统一经 ResearchFetchRouter（旧版缺省直连是 19 篇失败根因）
  researchFetch: researchNet.router.fetch,
  log: (m) => console.log(m),
});

const before = await stack.sources.list(projectId);
const beforeStatus = new Map(before.map((s) => [s.sourceId, s]));
// --targets= 显式给定盘点集合（合并报告用：覆盖历史多轮恢复的原目标）；
// 缺省 = 当前 metadata_only（常规恢复语义）
const targetIds = reportOnly
  ? (targetsArg !== undefined ? targetsArg.split(",").map((s) => s.trim()).filter(Boolean) : before.map((s) => s.sourceId))
  : undefined;
const need0 = targetIds !== undefined ? before.filter((s) => targetIds.includes(s.sourceId)) : before.filter((s) => s.status === "metadata_only");
console.log(`[backfill] sources=${before.length} targets=${need0.length} mode=${reportOnly ? "report-only" : `recover sweeps=${sweeps}`} proxy=${researchNet.effectiveUrl ?? "direct"}(${researchNet.source})`);
if (need0.length === 0) {
  console.log("[backfill] nothing to do");
  await finish(0);
}

// ---- 有界多轮 sweep：每轮 = resolveFullTextBatch 一轮有界尝试（resolver 链 ≤3 +
// 每命中 URL 一次下载；无内层重试风暴）；轮间间隔留给网络长波 / 限流恢复 ----
const sweepLog = [];
if (!reportOnly) {
  for (let sweep = 1; sweep <= sweeps && (await stack.sources.list(projectId)).some((s) => s.status === "metadata_only"); sweep += 1) {
    const current = (await stack.sources.list(projectId)).filter((s) => s.status === "metadata_only");
    console.log(`[backfill] sweep ${sweep}/${sweeps}: ${current.length} metadata_only`);
    const batch = await stack.sourceImport.resolveFullTextBatch(
      projectId,
      current.map((s) => s.sourceId),
    );
    sweepLog.push({ sweep, summary: batch.summary, results: batch.results.map((r) => ({ sourceId: r.sourceId, outcome: r.outcome, note: r.note?.slice(0, 200) })) });
    console.log(`  resolved=${batch.summary.resolved} notFound=${batch.summary.notFound} failed=${batch.summary.failed} skipped=${batch.summary.skipped}`);
    if (sweep < sweeps) await new Promise((r) => setTimeout(r, 10_000));
  }
}

// ---- 显式 docling 收尾：onFullTextAttached 的 ingestInBackground 是进程内后台
// 任务，脚本退出即被杀（M15.8.1 实测 parsed=0 的原因）；这里对已挂载但无结构化
// 产物的条目做有界同步解析（幂等：已有产物跳过；report-only 合并盘点同样执行）----
{
  const downloadedItems = (await stack.sources.list(projectId)).filter(
    (s) => need0.some((n) => n.sourceId === s.sourceId) && s.fileName !== undefined,
  );
  for (const item of downloadedItems) {
    try {
      if ((await stack.ingestion.getDocument(projectId, item.sourceId)) === null) {
        console.log(`[backfill] docling parse ${item.sourceId}…`);
        await stack.ingestion.ingest(projectId, item.sourceId);
      }
    } catch (error) {
      console.log(`  ingest 失败（挂载保留）：${String(error.message ?? error).slice(0, 120)}`);
    }
  }
}

// ---- 结局分层盘点（downloaded / parsed / chunked；grounded/verified 不在本脚本范围）----
const after = await stack.sources.list(projectId);
const sha256File = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const entries = [];
for (const item of after) {
  if (!need0.some((n) => n.sourceId === item.sourceId)) continue; // 只记账目标集合
  const entry = {
    sourceId: item.sourceId,
    title: item.title?.slice(0, 80),
    beforeStatus: beforeStatus.get(item.sourceId)?.status ?? "unknown",
    afterStatus: item.status,
    downloaded: item.fileName !== undefined,
    fullText: item.fullText ?? null,
  };
  if (item.fileName !== undefined) {
    try {
      const path = await stack.sources.filePath(projectId, item.sourceId);
      const info = await stat(path);
      entry.file = {
        path: relativeForReport(path),
        bytes: info.size,
        sha256: await sha256File(path),
        head: (await readFile(path)).subarray(0, 5).toString("latin1"),
      };
    } catch (error) {
      entry.file = { error: String(error.message ?? error).slice(0, 120) };
    }
  }
  try {
    entry.parsed = (await stack.ingestion.getDocument(projectId, item.sourceId)) !== null;
  } catch {
    entry.parsed = false;
  }
  try {
    const chunks = await stack.workflowServices.chunkStore.readChunks(projectId, item.sourceId);
    entry.chunked = chunks !== null ? chunks.length : 0;
  } catch {
    entry.chunked = 0;
  }
  entry.analysis = item.analysis !== undefined;
  entries.push(entry);
}

function relativeForReport(path) {
  return String(path).replaceAll("\\", "/");
}

const metadataOnlyAfter = after.filter((s) => s.status === "metadata_only").length;
const budgetCalls = budgetLedger.snapshot().calls;
const manifest = {
  schema: "m158-fulltext-recovery/v3",
  at: new Date().toISOString(),
  codeVersion: process.env["M158_CODE_VERSION"] ?? "unknown",
  projectId,
  proxy: { effectiveUrl: researchNet.effectiveUrl, source: researchNet.source, stats: researchNet.router.stats() },
  attempted: need0.map((s) => s.sourceId),
  counts: {
    attempted: entries.length,
    downloaded: entries.filter((e) => e.downloaded).length,
    parsed: entries.filter((e) => e.parsed).length,
    chunked: entries.filter((e) => (e.chunked ?? 0) > 0).length,
    metadataOnlyBefore: need0.length,
    metadataOnlyAfter,
    stillMissing: entries.filter((e) => !e.downloaded).map((e) => e.sourceId),
  },
  sweepLog,
  entries,
  evidenceBoundary: "grounded / verified 由 Evidence 核验管道（模型调用）产出；本脚本 0 模型，不创建 / 不改写 Evidence",
  budgetCalls,
};
await mkdir(REPAIR_DIR, { recursive: true });
await writeFileAtomic(MANIFEST_PATH, manifest);

// 人类可读摘要
const lines = [
  `# M15.8.1 全文恢复摘要（${manifest.at}）`,
  "",
  `- 项目：\`${projectId}\`（M15.8 P 既有项目；零模型、幂等补齐）`,
  `- 出口：${researchNet.effectiveUrl ?? "直连"}（来源 ${researchNet.source}；router proxied=${researchNet.router.stats().proxied} direct=${researchNet.router.stats().direct} bypassed=${researchNet.router.stats().bypassed}）`,
  `- metadata_only：${need0.length} → ${metadataOnlyAfter}（downloaded=${manifest.counts.downloaded} / parsed=${manifest.counts.parsed} / chunked=${manifest.counts.chunked}）`,
  `- 预算模型调用：${budgetCalls}（硬顶 1，必须为 0）`,
  "",
  "| sourceId | 结果 | resolver | bytes | sha256(前12) | parsed | chunked |",
  "| --- | --- | --- | --- | --- | --- | --- |",
];
for (const e of entries) {
  lines.push(
    `| ${e.sourceId} | ${e.downloaded ? "✅ downloaded" : `❌ ${e.fullText?.status ?? "failed"}`} | ${e.fullText?.resolver ?? "-"} | ${e.file?.bytes ?? "-"} | ${e.file?.sha256?.slice(0, 12) ?? "-"} | ${e.parsed ? "yes" : "no"} | ${e.chunked ?? 0} |`,
  );
}
const missing = entries.filter((e) => !e.downloaded);
if (missing.length > 0) {
  lines.push("", "## 未恢复（如实列明原因）", "");
  for (const e of missing) {
    lines.push(`- ${e.sourceId}: fullText.status=${e.fullText?.status ?? "unknown"}; note=${String(e.fullText?.note ?? "").slice(0, 180)}`);
  }
}
await writeFile(SUMMARY_PATH, lines.join("\n") + "\n", "utf8");

// 旧报告路径兼容（M15.8 evaluation 目录的机器可读账）
await writeFileAtomic(join(EVAL_DIR, "m158-p-backfill-report.json"), {
  schema: "m158-backfill/v3",
  projectId,
  attempted: manifest.attempted,
  resolved: manifest.counts.downloaded,
  attachFailed: missing.length,
  failures: missing.map((e) => ({ id: e.sourceId, reason: String(e.fullText?.note ?? "unknown").slice(0, 160) })),
  metadataOnlyAfter,
  budgetCalls,
  routerStats: researchNet.router.stats(),
});

console.log(
  `DONE backfill: downloaded=${manifest.counts.downloaded}/${entries.length} parsed=${manifest.counts.parsed} chunked=${manifest.counts.chunked} metadataOnlyAfter=${metadataOnlyAfter} budgetCalls=${budgetCalls} routerProxied=${researchNet.router.stats().proxied}`,
);
if (budgetCalls !== 0) {
  console.error("[fatal] 预算账本非零——违反 0 模型约束");
  await finish(5);
}
await finish(0);

async function writeFileAtomic(path, value) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}
