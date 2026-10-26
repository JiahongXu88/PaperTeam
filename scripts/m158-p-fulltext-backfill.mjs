#!/usr/bin/env node
/**
 * M15.8 受控 Repair（任务书 §5.D Evidence gap 分支）—— 已批准文献的全文补齐。
 *
 * 语义：P 的 25 篇入选文献中 19 篇因当时网络瞬断（arxiv 熔断）全文未落地
 * （metadata_only）→ targeted grounding 无法为文献性论断取证 → rule 4 如实阻断。
 * 本脚本用产品自身 API（resolveFullTextBatch + ingestion.ingest）对【已批准
 * 入库的既有文献】重试全文解析——不新增文献、不碰冻结语料的 matrix/synthesis
 * 绑定、零模型调用（纯 HTTP + docling）。修复后由 workflow 续跑的
 * evidence.ground_claims 正常取证。
 *
 * 用法：node scripts/m158-p-fulltext-backfill.mjs   （幂等：已有全文的跳过）
 */

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const DATA_ROOT = process.env["M158_DATA_ROOT"] ?? "D:\\PaperTeamData\\M15\\M15_8";
const EVAL_DIR = join(DATA_ROOT, "evaluation");
const P_ROOT = join(DATA_ROOT, "projects-root");

process.env["PROJECTS_ROOT"] = P_ROOT;
process.env["PAPERTEAM_GLOBAL_BUDGET_LEDGER"] = join(EVAL_DIR, "budget-ledger-backfill.json");
process.env["PAPERTEAM_GLOBAL_MAX_MODEL_CALLS"] = "1"; // 硬顶 1：本脚本必须零模型
process.env["PAPERTEAM_GLOBAL_MAX_TOKENS"] = "0";

const projectId = JSON.parse(await readFile(join(EVAL_DIR, "m158-p-journal.json"), "utf8")).projectId;
console.log(`[backfill] project=${projectId}`);

const { loadConfig } = await import(distUrl("config", "config.js"));
const { PiRuntimeAdapter } = await import(distUrl("runtime", "PiRuntimeAdapter.js"));
const { SkillRegistry } = await import(distUrl("skills", "SkillRegistry.js"));
const { ModelSettingsStore, resolveStartupModelSpec } = await import(distUrl("settings", "ModelSettingsStore.js"));
const { buildServiceStack } = await import(distUrl("serviceStack.js"));
const { ProjectStore } = await import(distUrl("project", "ProjectStore.js"));
const { LatexCompiler } = await import(distUrl("latex", "LatexCompiler.js"));
const { GlobalBudgetLedger } = await import(distUrl("runtime", "globalBudgetLedger.js"));

const config = loadConfig();
const budgetLedger = new GlobalBudgetLedger({
  path: config.workflow.globalBudget.ledgerPath,
  limits: { maxCalls: config.workflow.globalBudget.maxCalls, maxTokens: config.workflow.globalBudget.maxTokens },
  label: "M15.8 backfill (must stay 0)",
});
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
  log: (m) => console.log(m),
});

const sources = await stack.sources.list(projectId);
const need = sources.filter((s) => s.status === "metadata_only");
console.log(`[backfill] sources=${sources.length} metadata_only=${need.length}`);
if (need.length === 0) {
  console.log("[backfill] nothing to do");
  process.exit(0);
}

// URL 提取：fullText.note「下载失败（<url>）」内嵌 oa-url（网络层 curl 可达而 undici 被
// arXiv CDN 间歇节流——M15.8 实测同 URL curl 3/3 成功、node fetch 超时）。经产品自身
// attachManualFullText（M9.3 人工 fallback 通道，provenance=manual-upload 可审计）挂载。
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const execFileAsync = promisify(execFile);
const { mkdtemp, readFile: readBin } = await import("node:fs/promises");
const urlFromNote = (note) => {
  const m = /下载失败（(https?:\/\/[^）]+)）/.exec(String(note ?? ""));
  const raw = m?.[1] ?? null;
  if (raw === null) return null;
  // arxiv.org/pdf（主 CDN）对本机网络呈长波节流；export.arxiv.org 镜像同库且可达（实测 200/%PDF-）
  return raw.replace(/^https:\/\/arxiv\.org\/pdf\//, "https://export.arxiv.org/pdf/");
};
const curlDownload = async (url, dest) => {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      // curl 自限：--max-time 45（单次）；重试交给外层 sweep 轮次（网络长波 → 多轮比内联重试高效）
      const { stdout, stderr } = await execFileAsync("curl", ["-sL", "--max-time", "45", "-o", dest, "-w", "%{http_code}", url], { timeout: 60_000, maxBuffer: 10 });
      const code = stdout.trim();
      let size = 0;
      try { size = (await readBin(dest)).byteLength; } catch { /* 未落盘 */ }
      if (code === "200" && size > 1000) return true;
      console.log(`  curl HTTP=${code} size=${size}（attempt ${attempt}）${stderr ? ` stderr=${String(stderr).slice(0, 60)}` : ""}`);
    } catch (error) {
      console.log(`  curl 异常（attempt ${attempt}）：${String(error.code ?? error.message ?? error).slice(0, 120)}`);
    }
    await new Promise((r) => setTimeout(r, 6_000 * attempt));
  }
  return false;
};

const { tmpdir } = await import("node:os");
const tmp = await mkdtemp(join(tmpdir(), "m158-backfill-"));
let attached = 0;
let attachSkipped = 0;
let attachFailed = 0;
const failures = [];
for (const [index, item] of need.entries()) {
  const url = urlFromNote(item.fullText?.note) ?? (typeof item.fullText?.url === "string" ? item.fullText.url : null);
  console.log(`[backfill] ${item.sourceId} (${index + 1}/${need.length}) ${url ?? "(no url)"}`);
  if (url === null) { failures.push({ id: item.sourceId, reason: "no-url-in-note" }); attachFailed += 1; continue; }
  const dest = join(tmp, `${item.sourceId}.pdf`);
  if (!(await curlDownload(url, dest))) { failures.push({ id: item.sourceId, url, reason: "curl-failed" }); attachFailed += 1; continue; }
  const content = await readBin(dest);
  try {
    const result = await stack.sourceImport.attachManualFullText(projectId, item.sourceId, { fileName: `${item.sourceId}.pdf`, content });
    if (result.outcome === "skipped_has_file") { attachSkipped += 1; continue; }
    attached += 1;
    // 结构化解析（docling）
    try {
      if ((await stack.ingestion.getDocument(projectId, item.sourceId)) === null) {
        await stack.ingestion.ingest(projectId, item.sourceId);
      }
    } catch (error) {
      console.log(`  ingest 失败（挂载保留）：${error.message.slice(0, 100)}`);
    }
  } catch (error) {
    failures.push({ id: item.sourceId, url, reason: error.message.slice(0, 120) });
    attachFailed += 1;
  }
}
const after = (await stack.sources.list(projectId));
const report = {
  schema: "m158-backfill/v2",
  projectId,
  attempted: need.map((s) => s.sourceId),
  attached,
  attachSkipped,
  attachFailed,
  failures,
  metadataOnlyAfter: after.filter((s) => s.status === "metadata_only").length,
  budgetCalls: budgetLedger.snapshot().calls,
};
const outPath = join(EVAL_DIR, "m158-p-backfill-report.json");
const tmp2 = `${outPath}.tmp`;
await writeFile(tmp2, JSON.stringify(report, null, 2), "utf8");
await rename(tmp2, outPath);
console.log(`DONE backfill: attached=${attached} skipped=${attachSkipped} failed=${attachFailed} metadataOnlyAfter=${report.metadataOnlyAfter} budgetCalls=${report.budgetCalls}`);
process.exit(0);
