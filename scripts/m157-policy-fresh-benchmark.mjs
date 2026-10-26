#!/usr/bin/env node
/**
 * M15.7 阶段 C：fresh 模型腿——生产只读评估路径在真实稿件上的三臂政策对照。
 *
 * 与 m157-policy-shadow-replay（零模型重放）互补：重放语料全部是 published 分支（3400f87 引擎、
 * required NOT_EVALUATED 常驻），测不到「分数阈值单独阻断」场景；本脚本用真实作者稿件跑生产管线
 * （idea_to_paper → review.run → quality.gate，干净副本、不继承任何 evidence store），拿到真实
 * Legacy Gate 后应用三臂（legacy_v1 / score_style_advisory / policy_aware）记录差分。
 *
 * 样本（预登记协议 §2.3，优先级顺序）：
 *   1. mot-zh-author      MOT R5.1 中文投稿候选稿（author_manuscript——分数单独阻断的目标场景）
 *   2. mot-zh-mutated     同稿确定性变异：中文摘要首个「降至 497」→「降至 431」（摘要↔正文/表格
 *                         数值矛盾，HEADLINE_CROSS fresh 替代；变异登记落盘 evaluation/）
 *   3. mot-zh-published   同稿 published_paper_assessment（Candidate B 评估完成语义端到端）
 *   4. en-arxiv-published arXiv 1506.01498（Faster R-CNN，未参与任何 M11.4/M15.x 调参；EN 家族）
 *   同一原文最多 2 次重复评审：MOT 原稿恰好 2 次（author + published），变异稿内容不同不占额。
 *
 * 预算纪律（协议 §5）：
 *   - PAPERTEAM_GLOBAL_BUDGET_LEDGER + PAPERTEAM_GLOBAL_MAX_MODEL_CALLS 双 env 必设，并显式把
 *     GlobalBudgetLedger 接进 buildServiceStack（修 m156 审计缺口：独立脚本从此有系统级硬停）。
 *   - 账本上限恒为本轮全局硬上限 48（tighten 只紧不松——若把 preflight 的小值写进账本将永久无法回 48）；
 *     --max-model-calls N 只是本次调用的驱动级余量闸（1 ≤ N ≤ 48）。
 *   - 连通性 ping 计入预算（不回减）；只在首个有效调用（无已完成样本）时执行，resume 不重复计费。
 *   - RUN_INTENT 原子写（tmp+rename）run-intents/<sampleId>.json，含预算快照；完成后写 .result.json。
 *
 * CLI（协议 §5，缺省拒绝执行）：
 *   --list                    只枚举样本与账本/报告状态（零模型、零 env 变更）
 *   --dry-run                 离线校验样本源与变异确定性，不写任何文件（零模型）
 *   --fresh                   显式新建报告（报告已存在即拒绝，防无意重跑）
 *   --resume                  在既有报告上续跑（跳过已完成 sampleId）
 *   --only=<sampleId>         只跑一个样本（preflight 用；需与 --fresh/--resume 之一同时给出）
 *   --max-model-calls N       模型模式必填（1 ≤ N ≤ 48；本次调用的驱动级余量闸——账本上限恒 48）
 *
 * 产物（全部在仓库外 D:\PaperTeamData\M15\M15_7\）：
 *   evaluation/m157-fresh-report.json（逐样本增量落盘）
 *   evaluation/m157-fresh-driver-log.txt（追加）
 *   evaluation/m157-fresh-mutation-register.json（变异登记）
 *   run-intents/<sampleId>.json / <sampleId>.result.json
 *   budget-ledger.json（GlobalBudgetLedger 自管）
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const WORK_DIR = "D:/PaperTeamData/M15/M15_7";
const EVAL_DIR = join(WORK_DIR, "evaluation");
const INTENT_DIR = join(WORK_DIR, "run-intents");
const FRESH_ROOT = join(WORK_DIR, "fresh-projects");
const LEDGER_PATH = join(WORK_DIR, "budget-ledger.json");
const REPORT_PATH = join(EVAL_DIR, "m157-fresh-report.json");
const DRIVER_LOG_PATH = join(EVAL_DIR, "m157-fresh-driver-log.txt");
const MUTATION_REGISTER_PATH = join(EVAL_DIR, "m157-fresh-mutation-register.json");

const MOT_TEX = "D:/Projects/vehicle-mot-research/mot_revival/paper/paper_submission_candidate.tex";
const ARXIV_ID = "1506.01498"; // Faster R-CNN（EN 家族；未参与任何 M11.4/M15.x 调参）
const ARXIV_CACHE_DIR = join(WORK_DIR, "en-arxiv");

const SESSION_MAX_CALLS = 48; // 任务书：本轮真实模型调用全局硬上限
const EXPECTED_CALLS_PER_SAMPLE = 8; // 启动新样本的最小预算余量（units 模式评审的下界估计）

// ---- CLI ----

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const listOnly = has("--list");
const dryRun = has("--dry-run");
const fresh = has("--fresh");
const resume = has("--resume");
const onlySample = valueOf("--only") ?? args.find((a) => a.startsWith("--only="))?.slice(7);
const reuseProjectId =
  valueOf("--reuse-project") ?? args.find((a) => a.startsWith("--reuse-project="))?.slice("--reuse-project=".length);
const maxModelCallsRaw = valueOf("--max-model-calls");

if (!listOnly && !dryRun && !fresh && !resume) {
  console.error("[refuse] 缺省拒绝执行：用 --list / --dry-run 只读查看，或 --fresh / --resume 显式选择运行模式（协议 §5）");
  process.exit(2);
}
if (fresh && resume) {
  console.error("[refuse] --fresh 与 --resume 互斥");
  process.exit(2);
}
if (reuseProjectId !== undefined && (onlySample === undefined || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(reuseProjectId))) {
  console.error("[refuse] --reuse-project 必须与 --only（恰好一个样本）同用，且 projectId 形如 p-xxxx");
  process.exit(2);
}

// ---- 样本定义（预登记协议 §2.3） ----

const SAMPLES = [
  {
    sampleId: "mot-zh-author",
    language: "zh",
    reviewPurpose: "author_manuscript",
    family: "ZH-MOT-R5.1-AUTHOR",
    qualityClass: "author-submission-candidate",
    source: { kind: "local-file", path: MOT_TEX, provenance: "MOT Revival R5.1 投稿候选稿（D:\\Projects\\vehicle-mot-research，只读）" },
    mutation: null,
  },
  {
    sampleId: "mot-zh-mutated",
    language: "zh",
    reviewPurpose: "author_manuscript",
    family: "ZH-MOT-R5.1-MUTATED",
    qualityClass: "controlled-numeric-contradiction",
    source: { kind: "local-file", path: MOT_TEX, provenance: "同 mot-zh-author 源 + 确定性变异" },
    mutation: {
      find: "降至 497",
      replace: "降至 431",
      occurrence: "first",
      note: "中文摘要「H1+H4 使身份切换由 700 降至 497」首个出现改为 431；正文 :397 与表 tab:official(:425) 保持 497——注入摘要↔正文数值矛盾（HEADLINE_CROSS fresh 替代锚）",
    },
  },
  {
    sampleId: "mot-zh-published",
    language: "zh",
    reviewPurpose: "published_paper_assessment",
    family: "ZH-MOT-R5.1-PUBLISHED",
    qualityClass: "author-submission-candidate",
    source: { kind: "local-file", path: MOT_TEX, provenance: "同 mot-zh-author 源（同一原文第 2 次、也是最后一次评审）" },
    mutation: null,
  },
  {
    sampleId: "en-arxiv-published",
    language: "en",
    reviewPurpose: "published_paper_assessment",
    family: "EN-ARXIV-FASTER-RCNN",
    qualityClass: "known-good-published",
    source: { kind: "arxiv-eprint", arxivId: ARXIV_ID, provenance: "arXiv 1506.01498 e-print（EN 家族；获取失败记 EN_FAMILY_FETCH_FAILED 优雅跳过）" },
    mutation: null,
  },
];

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** 确定性变异：替换首个出现；返回替换位置与全文出现次数供登记校验 */
const applyMutation = (content, mutation) => {
  const first = content.indexOf(mutation.find);
  if (first < 0) return { ok: false, error: "pattern-not-found" };
  const total = content.split(mutation.find).length - 1;
  return {
    ok: true,
    content: content.slice(0, first) + mutation.replace + content.slice(first + mutation.find.length),
    firstIndex: first,
    occurrencesTotal: total,
  };
};

// ---- 账本读取（只读 JSON，不构造 ledger——构造会收紧上限，零模型模式不允许触碰） ----

const readLedgerTotals = () => {
  try {
    const parsed = JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
    if (parsed?.schemaVersion !== 2) return { exists: true, malformed: true };
    return {
      exists: true,
      status: parsed.status,
      limits: parsed.limits,
      totalsCalls: parsed.totals.calls,
      totalsTokens: parsed.totals.inputTokens + parsed.totals.outputTokens + parsed.totals.cacheWriteTokens,
      stops: parsed.stops?.length ?? 0,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    return { exists: true, malformed: true, error: String(error?.message ?? error) };
  }
};

// ---- 零模型路径：--list / --dry-run ----

const readSourceFiles = async (sample) => {
  if (sample.source.kind === "local-file") {
    const content = await readFile(sample.source.path, "utf8");
    return { files: { "main.tex": content }, note: sample.source.path };
  }
  return null; // arxiv 运行时获取；dry-run 只检查缓存
};

const walkDir = async (dir, base = "") => {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkDir(full, base ? `${base}/${entry.name}` : entry.name)));
    else out.push({ path: base ? `${base}/${entry.name}` : entry.name, full });
  }
  return out;
};

/** 把已解包的 e-print 目录扁平化为项目文件（主 tex → main.tex；其余路径斜线转下划线） */
const flattenEprint = async (extractDir) => {
  const entries = await walkDir(extractDir);
  const texFiles = [];
  for (const entry of entries) {
    if (/\.(tex|bbl)$/i.test(entry.path)) {
      const content = await readFile(entry.full, "utf8");
      if (/\.(tex)$/i.test(entry.path)) texFiles.push({ path: entry.path, content });
      else texFiles.push({ path: entry.path, content, bbl: true });
    }
  }
  if (texFiles.length === 0) throw new Error("e-print 中没有 .tex/.bbl 文件");
  const docClass = texFiles.filter((f) => !f.bbl && /\\documentclass/.test(f.content));
  if (docClass.length === 0) throw new Error("e-print 中没有 \\documentclass 主文件");
  docClass.sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path));
  const main = docClass[0];
  const files = {};
  for (const f of texFiles) {
    const name = f === main ? "main.tex" : f.path.replace(/\//g, "_");
    files[name] = f.content;
  }
  return { files, mainPath: main.path, fileCount: texFiles.length };
};

if (listOnly || dryRun) {
  const ledger = readLedgerTotals();
  const reportExists = existsSync(REPORT_PATH);
  console.log(`[ledger] ${JSON.stringify(ledger)}`);
  console.log(`[report] ${REPORT_PATH} → ${reportExists ? "已存在（续跑用 --resume）" : "不存在"}`);
  for (const sample of SAMPLES) {
    const lines = [`sample=${sample.sampleId}\tlang=${sample.language}\tpurpose=${sample.reviewPurpose}\tfamily=${sample.family}\tsource=${sample.source.kind}`];
    if (sample.source.kind === "local-file") {
      try {
        const { files } = await readSourceFiles(sample);
        const content = files["main.tex"];
        let mutationNote = "";
        if (sample.mutation) {
          const applied = applyMutation(content, sample.mutation);
          mutationNote = applied.ok
            ? `\tmutation: firstIndex=${applied.firstIndex} occurrences=${applied.occurrencesTotal} → ${applied.ok ? "OK" : applied.error}`
            : `\tmutation: ${applied.error}`;
        }
        lines.push(`  main.tex chars=${content.length} sha256=${sha256(content).slice(0, 16)}…${mutationNote}`);
      } catch (error) {
        lines.push(`  [missing] ${String(error?.message ?? error)}`);
      }
    } else {
      const cached = existsSync(join(ARXIV_CACHE_DIR, "extracted"));
      lines.push(`  arXiv ${sample.source.arxivId} → ${cached ? "已有本地解包缓存" : "运行时获取（dry-run 不下载）"}`);
    }
    console.log(lines.join("\n"));
  }
  if (dryRun) {
    // 变异确定性断言：恰好 2 处「降至 497」，首处位于中文摘要区（文件头部 10k 字符内）
    const content = await readFile(MOT_TEX, "utf8");
    const applied = applyMutation(content, SAMPLES[1].mutation);
    if (!applied.ok || applied.occurrencesTotal !== 2) {
      console.error(`[dry-run][fail] 变异前提不成立：ok=${applied.ok} occurrences=${applied.occurrencesTotal}（预期 2：摘要 :54 + 正文 :397）`);
      process.exit(2);
    }
    if (applied.firstIndex > 10_000) {
      console.error(`[dry-run][fail] 首个「降至 497」不在摘要区（firstIndex=${applied.firstIndex} > 10000）`);
      process.exit(2);
    }
    const again = applyMutation(content, SAMPLES[1].mutation);
    if (sha256(again.content) !== sha256(applied.content)) {
      console.error("[dry-run][fail] 变异非确定性");
      process.exit(2);
    }
    console.log(`[dry-run] 变异确定性 OK：firstIndex=${applied.firstIndex}、occurrences=2、mutatedSha256=${sha256(applied.content).slice(0, 16)}…`);
    console.log("[dry-run] 不写任何文件、不设 env、不构造账本、零模型调用");
  }
  process.exit(0);
}

// ---- 模型模式（--fresh / --resume） ----

const maxModelCalls = Number(maxModelCallsRaw);
if (!Number.isInteger(maxModelCalls) || maxModelCalls <= 0 || maxModelCalls > SESSION_MAX_CALLS) {
  console.error(`[refuse] 模型模式必须显式 --max-model-calls N（1 ≤ N ≤ ${SESSION_MAX_CALLS}，收到 ${maxModelCallsRaw}）`);
  process.exit(2);
}

process.env["PROJECTS_ROOT"] = FRESH_ROOT;
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
process.env["PAPERTEAM_GLOBAL_BUDGET_LEDGER"] = LEDGER_PATH;
// 账本上限恒为全局硬上限（tighten 只紧不松：preflight 的小 N 绝不能写进账本）
process.env["PAPERTEAM_GLOBAL_MAX_MODEL_CALLS"] = String(SESSION_MAX_CALLS);
// M15.7 预算纪律：跨单元/finding 复核调用置 0（独立有界特性，M15.1 已验；本轮目标是政策语义）
process.env["PAPERTEAM_REVIEW_CLAIM_RECHECK_CALLS"] = "0";
process.env["PAPERTEAM_REVIEW_FINDING_RECHECK_CALLS"] = "0";

const logLines = [];
const appendDriverLog = async (line) => {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  logLines.push(stamped);
  // 追加式驱动日志（resume 跨调用保留）；日志失败绝不中断主流程（首轮教训：D: 瞬态 errno -4094
  // 曾让 catch 内的日志调用把进程带走，ERROR 记录都没落盘）
  try {
    await mkdir(EVAL_DIR, { recursive: true });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(DRIVER_LOG_PATH, stamped + "\n", "utf8");
  } catch (error) {
    console.error(`[driver-log-degraded] ${String(error?.message ?? error)}`);
  }
};

const atomicWriteJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
};

// dist 动态 import（env 已设；与 m156-fresh 相同的接线样板）
const dist = (...p) => join(REPO_ROOT, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const { loadConfig } = await import(distUrl("config", "config.js"));
const { PiRuntimeAdapter } = await import(distUrl("runtime", "PiRuntimeAdapter.js"));
const { SkillRegistry } = await import(distUrl("skills", "SkillRegistry.js"));
const { ModelSettingsStore, resolveStartupModelSpec } = await import(distUrl("settings", "ModelSettingsStore.js"));
const { buildServiceStack } = await import(distUrl("serviceStack.js"));
const { GlobalBudgetLedger } = await import(distUrl("runtime", "globalBudgetLedger.js"));
const { ProjectStore } = await import(distUrl("project", "ProjectStore.js"));
const { LatexCompiler } = await import(distUrl("latex", "LatexCompiler.js"));
const { createIdeaToPaperDefinition } = await import(distUrl("workflow", "definitions.js"));
// 政策层同样从 dist 导入（构建后与 gates.js 同源；整个脚本在 node 下运行，与 m156 接线完全一致）
const { applyQualityPolicy, QUALITY_POLICY_VERSION } = await import(distUrl("quality", "qualityPolicyV2.js"));

const config = loadConfig();
const projectsRoot = process.env["PROJECTS_ROOT"];
const skillRegistry = new SkillRegistry({
  storeRoot: join(config.runtimeRoot, "skills"),
  disabledSkillIds: config.skills.disabledSkillIds,
  log: () => {},
});
await skillRegistry.ensureInstalled();
const modelSettingsStore = new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") });
const modelSpec = config.pi.model ?? (await resolveStartupModelSpec(undefined, modelSettingsStore));
if (modelSpec === undefined) {
  console.error("[fatal] 未解析到模型（PAPERTEAM_PI_MODEL / settings 均无）");
  process.exit(1);
}

// 预算账本：显式构造并接进 buildServiceStack（m156 审计缺口修复——系统级硬停）
if (config.workflow.globalBudget === undefined) {
  console.error("[fatal] config 未读到 globalBudget（PAPERTEAM_GLOBAL_BUDGET_LEDGER 未生效）");
  process.exit(1);
}
const budgetLedger = new GlobalBudgetLedger({
  path: config.workflow.globalBudget.ledgerPath,
  limits: { maxCalls: config.workflow.globalBudget.maxCalls, maxTokens: config.workflow.globalBudget.maxTokens },
  label: "M15.7 fresh benchmark",
});

/** 物理 runAgent 计数（含重试/修复/失败；ping 不回减——协议 §5 全计口径） */
let physicalCalls = 0;
const taskUsage = [];
let stackRef;
const adapter = new PiRuntimeAdapter({
  modelSpec,
  ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
  agentDir: config.pi.agentDir,
  workspaceRoot: projectsRoot,
  runTimeoutMs: config.pi.runTimeoutMs,
  roleSkills: (role, scope) => skillRegistry.skillAssignmentsFor(role, scope),
  roleCustomTools: () => [], // 干净副本：不挂 evidence 检索工具（库为空；杜绝骨架污染路径）
  log: () => {},
});
const originalRunAgent = adapter.runAgent.bind(adapter);
adapter.runAgent = async (...callArgs) => {
  physicalCalls += 1;
  const startedAt = Date.now();
  const result = await originalRunAgent(...callArgs);
  taskUsage.push({
    call: physicalCalls,
    scope: callArgs[0]?.contextScope ?? null,
    status: result.status,
    durationMs: Date.now() - startedAt,
    ...(result.usage ?? {}),
  });
  if (result.status !== "completed") {
    await appendDriverLog(`runAgent #${physicalCalls} → ${result.status}: ${String(result.error ?? "").slice(0, 160)}`);
  }
  return result;
};

const projects = new ProjectStore({ root: projectsRoot });
const stack = buildServiceStack({
  runtime: adapter,
  projects,
  latex: new LatexCompiler({ timeoutMs: config.latex.compileTimeoutMs }),
  agentIds: config.agents,
  stageTimeoutMs: config.stageTimeoutMs,
  stageMaxAttempts: config.stageMaxAttempts,
  ...(config.pi.longRunTimeoutMs !== undefined
    ? { longRunTimeoutMs: Math.max(config.pi.longRunTimeoutMs, 600_000) }
    : { longRunTimeoutMs: 900_000 }),
  globalBudget: {
    ledger: budgetLedger,
    outputReserveTokens: config.workflow.globalBudget.outputReserveTokens,
  },
  log: (message) => console.log(message),
});
stackRef = stack;
const services = stack.workflowServices;
const definition = createIdeaToPaperDefinition(services);

// ---- 报告状态 ----

const reportExists = existsSync(REPORT_PATH);
if (reportExists && fresh) {
  await appendDriverLog(`--fresh 覆盖既有报告 ${REPORT_PATH}（显式选择）`);
}
if (reportExists && !fresh && !resume) {
  console.error(`[refuse] 报告已存在 ${REPORT_PATH}：用 --resume 续跑或 --fresh 显式覆盖`);
  process.exit(2);
}
if (!reportExists && resume) {
  await appendDriverLog(`--resume 但报告不存在，视为新建 ${REPORT_PATH}`);
}

let report = {
  schema: "m157-fresh/v1",
  policyVersion: QUALITY_POLICY_VERSION,
  createdAt: new Date().toISOString(),
  updatedAt: null,
  maxModelCalls,
  sessionMaxCalls: SESSION_MAX_CALLS,
  budgetLedgerPath: LEDGER_PATH,
  budgetTotalsStart: budgetLedger.snapshot(),
  samples: [],
  usage: taskUsage,
};
if (reportExists && resume) {
  const previous = JSON.parse(readFileSync(REPORT_PATH, "utf8"));
  if (previous?.schema !== "m157-fresh/v1") {
    console.error(`[refuse] 既有报告 schema 不识别（${previous?.schema}）——拒绝续跑`);
    process.exit(2);
  }
  report = previous;
  report.usage = Array.isArray(previous.usage) ? previous.usage : [];
  report.usage.push({ invocationStart: new Date().toISOString(), note: "resume invocation usage below" });
}
// 已知未计量缺口（2026-10-26 首次 preflight：ping 经包装 adapter 未过账本 reserve，物理 1 / 账本 0）。
// 全计口径下从有效余量中扣除——不因账本未记录而视为免费（协议 §5）。
const KNOWN_UNMETERED_CALLS = 1;
const effectiveUsedCalls = () => budgetLedger.snapshot().calls + KNOWN_UNMETERED_CALLS;
const completedSampleIds = new Set(report.samples.filter((s) => s.status === "COMPLETED").map((s) => s.sampleId));

const persistReport = async () => {
  report.updatedAt = new Date().toISOString();
  report.budgetTotalsLatest = budgetLedger.snapshot();
  report.physicalModelCalls = physicalCalls;
  report.knownUnmeteredCalls = KNOWN_UNMETERED_CALLS;
  report.effectiveUsedCalls = effectiveUsedCalls();
  // usage = 历次调用的 invocation 标记 + 本次调用至今的物理调用流水
  report.usage = [...report.usage.filter((entry) => entry.invocationStart !== undefined), ...taskUsage];
  atomicWriteJson(REPORT_PATH, report);
};

// ---- 样本源准备 ----

const prepareSource = async (sample) => {
  if (sample.source.kind === "local-file") {
    const original = await readFile(sample.source.path, "utf8");
    const originalSha256 = sha256(original);
    let files = { "main.tex": original };
    let mutationRegister = null;
    if (sample.mutation) {
      const applied = applyMutation(original, sample.mutation);
      if (!applied.ok) throw new Error(`变异失败：${applied.error}`);
      if (applied.occurrencesTotal !== 2 || applied.firstIndex > 10_000) {
        throw new Error(`变异前提漂移：occurrences=${applied.occurrencesTotal} firstIndex=${applied.firstIndex}`);
      }
      files = { "main.tex": applied.content };
      mutationRegister = {
        sampleId: sample.sampleId,
        sourceFile: sample.source.path,
        originalSha256,
        mutatedSha256: sha256(applied.content),
        find: sample.mutation.find,
        replace: sample.mutation.replace,
        occurrence: sample.mutation.occurrence,
        firstIndex: applied.firstIndex,
        occurrencesTotal: applied.occurrencesTotal,
        note: sample.mutation.note,
        registeredAt: new Date().toISOString(),
      };
    }
    return {
      files,
      provenance: {
        kind: "author_latex",
        path: sample.source.path,
        sha256: originalSha256,
        ...(mutationRegister ? { mutatedSha256: mutationRegister.mutatedSha256 } : {}),
      },
      mutationRegister,
    };
  }
  // arXiv e-print：下载 → tar 解包 → 扁平化；失败记 EN_FAMILY_FETCH_FAILED（不中断其余样本）
  const tarPath = join(ARXIV_CACHE_DIR, `${ARXIV_ID}.tar.gz`);
  const extractDir = join(ARXIV_CACHE_DIR, "extracted");
  if (!existsSync(extractDir)) {
    await mkdir(ARXIV_CACHE_DIR, { recursive: true });
    if (!existsSync(tarPath)) {
      const response = await fetch(`https://arxiv.org/e-print/${ARXIV_ID}`, {
        headers: { "User-Agent": "PaperTeam-M15.7-benchmark/1.0 (research benchmark; local run)" },
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw Object.assign(new Error(`arXiv HTTP ${response.status}`), { code: "EN_FAMILY_FETCH_FAILED" });
      const { writeFile: wf } = await import("node:fs/promises");
      await wf(tarPath, Buffer.from(await response.arrayBuffer()));
    }
    await mkdir(extractDir, { recursive: true });
    await execFileAsync("tar", ["-xzf", tarPath, "-C", extractDir]);
  }
  const flat = await flattenEprint(extractDir);
  const tarBuffer = await readFile(tarPath);
  return {
    files: flat.files,
    provenance: { kind: "arxiv_eprint", arxivId: ARXIV_ID, mainPath: flat.mainPath, files: flat.fileCount, tarSha256: createHash("sha256").update(tarBuffer).digest("hex") },
    mutationRegister: null,
  };
};

// ---- 单样本执行 ----

const runSample = async (sample) => {
  const startedAt = Date.now();
  const snapshotBefore = budgetLedger.snapshot();
  const intent = {
    schema: "m157-run-intent/v1",
    sampleId: sample.sampleId,
    mode: "model-fresh",
    language: sample.language,
    reviewPurpose: sample.reviewPurpose,
    family: sample.family,
    modelSpec: String(modelSpec?.id ?? modelSpec ?? null),
    policyVersion: QUALITY_POLICY_VERSION,
    budgetBefore: snapshotBefore,
    startedAt: new Date(startedAt).toISOString(),
  };
  atomicWriteJson(join(INTENT_DIR, `${sample.sampleId}.json`), intent);
  await appendDriverLog(`RUN_INTENT ${sample.sampleId}（账本已用 ${snapshotBefore.calls}/${snapshotBefore.limits.maxCalls}）`);

  const source = await prepareSource(sample);
  if (source.mutationRegister) atomicWriteJson(MUTATION_REGISTER_PATH, source.mutationRegister);

  // 补救/增量模式（--reuse-project）：复用既有项目目录——
  //  - 无变异样本：跳过文件写入，同轮 journal 恢复（D: 瞬态故障中断的 run）；
  //  - 有变异样本（mutated r2）：写入变异稿触发 M14.8.1 跨轮增量复审——未变单元按
  //    unitFingerprint+requestFingerprint 合法缓存，只有改动/汇总型/引用依赖单元真实重审。
  const projectId =
    reuseProjectId ?? (await projects.create(`M15.7 fresh ${sample.sampleId}`, { language: sample.language })).id;
  const manuscriptDir = projects.manuscriptDir(projectId);
  await mkdir(manuscriptDir, { recursive: true });
  const artifactsDir = join(projects.projectDir(projectId), "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  if (reuseProjectId === undefined || sample.mutation !== null) {
    for (const [path, content] of Object.entries(source.files)) {
      const target = join(manuscriptDir, ...path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
  }
  const mainTex = source.files["main.tex"] ?? Object.values(source.files)[0];
  atomicWriteJson(join(artifactsDir, "input-provenance.json"), {
    sourceKind: sample.reviewPurpose === "published_paper_assessment" && sample.source.kind === "arxiv-eprint" ? "arxiv_eprint" : "author_latex",
    manuscriptSha256: sha256(mainTex),
    reviewPurpose: sample.reviewPurpose,
    note: "M15.7 fresh 三臂政策对照运行（干净副本，不继承 evidence store）",
  });

  const state = {
    workflowKind: "idea_to_paper",
    stageResults: {},
    stageHistory: [],
    completedStages: [],
    inputs: {},
    request: { reviewPurpose: sample.reviewPurpose },
  };
  const runStage = async (stageId) => {
    const stage = definition.stages.find((s) => s.id === stageId);
    if (stage === undefined) throw new Error(`stage ${stageId} 不存在`);
    const ctx = {
      projectId,
      runId: `m157-${sample.sampleId}`,
      attempt: 1,
      signal: new AbortController().signal,
      state,
      emitProgress: async () => {},
      emitDomain: async () => {},
      log: (message) => console.log(`  [${stageId}] ${String(message).slice(0, 200)}`),
    };
    const out = await stage.execute(ctx);
    state.stageResults[stageId] = out;
    return out;
  };
  const callsBefore = physicalCalls;
  const reviewStage = await runStage("review.run");
  const gateStage = await runStage("quality.gate");
  const callsUsed = physicalCalls - callsBefore;
  const round = reviewStage["round"];

  const summary = JSON.parse(await readFile(join(projects.reviewsDir(projectId), `review-summary-r${round}.json`), "utf8"));
  const gateArtifact = JSON.parse(await readFile(join(projects.reviewsDir(projectId), `quality-gate-r${round}.json`), "utf8"));
  const gate = gateArtifact.gate ?? gateArtifact;
  const scores = { academicScore: summary.scores?.academicScore ?? null, styleRisk: summary.scores?.styleRisk ?? null };
  const scenario = { reviewPurpose: sample.reviewPurpose, workflowKind: "idea_to_paper" };

  const legacy = applyQualityPolicy({ gate, arm: "legacy_v1", scores, scenario });
  const candidateA = applyQualityPolicy({ gate, arm: "score_style_advisory", scores, scenario });
  const candidateB = applyQualityPolicy({ gate, arm: "policy_aware", scores, scenario });
  const legacyIdentityMatch =
    JSON.stringify(legacy.gate.rules) === JSON.stringify(gate.rules) && legacy.gate.passed === gate.passed;

  const record = {
    sampleId: sample.sampleId,
    family: sample.family,
    qualityClass: sample.qualityClass,
    language: sample.language,
    reviewPurpose: sample.reviewPurpose,
    status: "COMPLETED",
    projectId,
    round,
    ...(reuseProjectId !== undefined ? { salvagedFromProject: reuseProjectId } : {}),
    durationMs: Date.now() - startedAt,
    physicalModelCalls: callsUsed,
    source: source.provenance,
    review: {
      coverage: summary.coverage
        ? { mode: summary.coverage.mode, complete: summary.coverage.complete, ratio: summary.coverage.ratio, units: `${summary.coverage.completedUnits}/${summary.coverage.targetUnits}` }
        : null,
      counts: summary.counts,
      factVerdicts: summary.scores?.factVerdicts ?? null,
      academicScore: scores.academicScore,
      styleRisk: scores.styleRisk,
    },
    legacyGate: {
      passed: gate.passed,
      failedRules: gate.rules.filter((r) => !r.passed).map((r) => r.rule),
      rules: gate.rules.map((r) => ({
        rule: r.rule,
        status: r.status ?? (r.passed ? "PASS" : "FAIL"),
        required: r.required === true,
        detail: r.detail.slice(0, 240),
      })),
      evaluation: gate.evaluation ?? null,
    },
    arms: {
      legacy: { identityMatch: legacyIdentityMatch, passed: legacy.gate.passed },
      candidateA: {
        passed: candidateA.outcome.candidatePassed,
        reasonCode: candidateA.outcome.reasonCode,
        unblocked: candidateA.outcome.unblocked,
        remainingBlockers: candidateA.outcome.remainingBlockers,
        ruleDiffs: candidateA.ruleDiffs,
      },
      candidateB: {
        passed: candidateB.outcome.candidatePassed,
        reasonCode: candidateB.outcome.reasonCode,
        assessment: candidateB.assessment ?? null,
        quickReview: candidateB.quickReview ?? null,
      },
    },
    falseReadyCandidate:
      sample.sampleId === "mot-zh-mutated" && legacy.gate.passed === false && candidateA.outcome.candidatePassed === true,
    monotonicityViolation: legacy.gate.passed === true && candidateA.outcome.candidatePassed === false,
    gateArtifactPath: join(projects.reviewsDir(projectId), `quality-gate-r${round}.json`),
  };

  atomicWriteJson(join(INTENT_DIR, `${sample.sampleId}.result.json`), {
    schema: "m157-run-result/v1",
    sampleId: sample.sampleId,
    finishedAt: new Date().toISOString(),
    physicalModelCalls: callsUsed,
    legacyPassed: gate.passed,
    candidateAPassed: candidateA.outcome.candidatePassed,
    candidateAReasonCode: candidateA.outcome.reasonCode,
    legacyIdentityMatch,
    budgetAfter: budgetLedger.snapshot(),
  });
  return record;
};

// ---- 主循环 ----

const queue = SAMPLES.filter((s) => onlySample === undefined || s.sampleId === onlySample);
if (queue.length === 0) {
  console.error(`[refuse] --only 未匹配任何样本（${onlySample}）`);
  process.exit(2);
}
for (const sample of queue) {
  if (completedSampleIds.has(sample.sampleId)) continue;
  const headroom = maxModelCalls - effectiveUsedCalls();
  if (headroom < EXPECTED_CALLS_PER_SAMPLE) {
    report.samples.push({ sampleId: sample.sampleId, status: "PENDING_BUDGET", note: `有效余量 ${headroom} < 启动下界 ${EXPECTED_CALLS_PER_SAMPLE}（含已知未计量 ${KNOWN_UNMETERED_CALLS}）` });
    await persistReport();
    await appendDriverLog(`${sample.sampleId} STOP_BUDGET_HEADROOM（有效余量 ${headroom}）`);
  }
}

// 连通性 ping（1 次调用，计入账本与预算；仅首个有效调用执行，report.pingDone 防止 resume 重复计费）
if (report.pingDone !== true) {
  if (effectiveUsedCalls() >= maxModelCalls) {
    console.error("[fatal] 有效预算已到上限，拒绝 ping");
    process.exit(1);
  }
  const pingReserveId = budgetLedger.reserve({ label: "m157-ping", estimatedTokens: 200 });
  const ping = await adapter.runAgent({
    agentId: config.agents.reviewer,
    timeoutMs: 120_000,
    task: '回复 JSON：{"ok":true}（连通性检查，不要做任何其他事）',
    projectId: "m157-ping",
    contextScope: "review/m157-ping",
    metadata: { role: "reviewer" },
  });
  budgetLedger.settle(pingReserveId, ping.usage);
  report.pingDone = ping.status === "completed";
  if (ping.status !== "completed") {
    await appendDriverLog(`ping ✘ ${ping.status}（已计入账本，物理调用 ${physicalCalls}）`);
    process.exit(1);
  }
  await appendDriverLog(`ping ✔（已计入账本；账本 ${budgetLedger.snapshot().calls}/${SESSION_MAX_CALLS}，物理计数 ${physicalCalls}）`);
}

let stopAll = false;
for (const sample of queue) {
  if (stopAll) {
    report.samples.push({ sampleId: sample.sampleId, status: "PENDING_STOPPED", note: "先前样本异常终止" });
    continue;
  }
  if (completedSampleIds.has(sample.sampleId)) continue;
  // 跑前复查有效余量（ping 已计账后的真实值；账本 reserve 是最后防线）
  const headroomNow = maxModelCalls - effectiveUsedCalls();
  if (headroomNow < EXPECTED_CALLS_PER_SAMPLE) {
    report.samples = report.samples.filter((s) => !(s.sampleId === sample.sampleId && s.status.startsWith("PENDING")));
    report.samples.push({ sampleId: sample.sampleId, status: "PENDING_BUDGET", note: `跑前有效余量 ${headroomNow} < 启动下界 ${EXPECTED_CALLS_PER_SAMPLE}` });
    await appendDriverLog(`${sample.sampleId} STOP_BUDGET_HEADROOM（跑前有效余量 ${headroomNow}）`);
    continue;
  }
  if (report.samples.some((s) => s.sampleId === sample.sampleId && s.status.startsWith("PENDING"))) {
    report.samples = report.samples.filter((s) => !(s.sampleId === sample.sampleId && s.status.startsWith("PENDING")));
  }
  try {
    const record = await runSample(sample);
    report.samples = report.samples.filter((s) => s.sampleId !== sample.sampleId);
    report.samples.push(record);
    completedSampleIds.add(sample.sampleId);
    await appendDriverLog(
      `${sample.sampleId} ✔ calls=${record.physicalModelCalls} coverage=${record.review.coverage ? `${record.review.coverage.mode}@${(record.review.coverage.ratio * 100).toFixed(0)}%(${record.review.coverage.units})` : "?"} scores=${record.review.academicScore}/${record.review.styleRisk} legacy=${record.legacyGate.passed ? "PASS" : `FAIL(${record.legacyGate.failedRules.slice(0, 4).join(",")})`} A=${record.arms.candidateA.reasonCode} [${Math.round(record.durationMs / 1000)}s]`,
    );
  } catch (error) {
    const fetchFailed = error?.code === "EN_FAMILY_FETCH_FAILED";
    report.samples.push({
      sampleId: sample.sampleId,
      status: fetchFailed ? "EN_FAMILY_FETCH_FAILED" : "ERROR",
      error: String(error?.message ?? error).slice(0, 500),
      physicalModelCallsAtFailure: physicalCalls,
      budgetAfter: budgetLedger.snapshot(),
    });
    await appendDriverLog(`${sample.sampleId} ✘ ${fetchFailed ? "EN_FAMILY_FETCH_FAILED" : "ERROR"}：${String(error?.message ?? error).slice(0, 300)}`);
    if (!fetchFailed) stopAll = true; // 非获取类失败：停止后续样本，保留预算与现场（协议失败停止条件）
  }
  await persistReport();
}

// ---- 聚合安全指标 ----

const completed = report.samples.filter((s) => s.status === "COMPLETED");
report.aggregate = {
  completed: completed.length,
  legacyIdentityViolations: completed.filter((s) => s.arms.legacy.identityMatch !== true).map((s) => s.sampleId),
  monotonicityViolations: completed.filter((s) => s.monotonicityViolation === true).map((s) => s.sampleId),
  unblockedSamples: completed.filter((s) => s.arms.legacy.passed === false && s.arms.candidateA.passed === true).map((s) => ({
    sampleId: s.sampleId,
    reasonCode: s.arms.candidateA.reasonCode,
    remainingBlockers: s.arms.candidateA.remainingBlockers,
  })),
  falseReadyCandidates: completed.filter((s) => s.falseReadyCandidate === true).map((s) => s.sampleId),
  reasonCodes: completed.reduce((table, s) => {
    table[s.arms.candidateA.reasonCode] = (table[s.arms.candidateA.reasonCode] ?? 0) + 1;
    return table;
  }, {}),
  assessmentCompletionB: completed.reduce((table, s) => {
    const key = s.arms.candidateB.assessment?.completion ?? "NO_ASSESSMENT_BLOCK";
    table[key] = (table[key] ?? 0) + 1;
    return table;
  }, {}),
};
await persistReport();
await appendDriverLog(
  `DONE. 完成 ${completed.length}/${queue.length}；identity=${report.aggregate.legacyIdentityViolations.length} 单调=${report.aggregate.monotonicityViolations.length} 解锁=${report.aggregate.unblockedSamples.length} falseReady=${report.aggregate.falseReadyCandidates.length}；物理调用 ${physicalCalls}（本次）；有效已用 ${effectiveUsedCalls()}/48（账本 ${budgetLedger.snapshot().calls} + 已知未计量 ${KNOWN_UNMETERED_CALLS}）`,
);
