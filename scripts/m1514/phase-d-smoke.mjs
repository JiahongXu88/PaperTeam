#!/usr/bin/env node
/**
 * M15.14 Phase D — 真实目标期刊（CJIG）产品链路 smoke（只读展示，不接生产）。
 *
 * 案例：
 *   R = CJIG 已发表 research_article（场景文本检测 2023，M15.10 未消费 OA 语料）
 *   S = CJIG 已发表 survey（视觉信息抽取综述 2023，同上）
 *   b1 = 作者综述稿（M15_9 b1-original 编译 PDF，授权环境；与 Phase C 隔离）
 *
 * 每案例：import-pdf → 确定性 pool（复用 buildPoolForDocument，cutoff=发表年/
 *   2026-10）→ ContributionAuditService（venueId=cjig）→ 三层并列报告：
 *   ① 官方 guideline 合规（引用 M15_9 已算 b1 合规结果 + 对 PDF-only 案例如实
 *      NOT_EVALUATED——compliance facts 需要 LaTeX）
 *   ② benchmark 观测带（引用 M15_9 CJIG profile 快照，非官方）
 *   ③ 贡献/证据学术风险（本轮 audit，advisory）
 * 不产生单一投稿分数。
 *
 * 用法：node scripts/m1514/phase-d-smoke.mjs [--cases R,S,b1]
 */
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1514_ROOT ? resolve(process.env.M1514_ROOT) : resolve("D:\\PaperTeamData\\M15\\M15_14");
const REPO = resolve(here, "..", "..");
const PROJECTS_ROOT = join(ROOT, "phase-d", "projects-root");
const OUT_DIR = join(ROOT, "phase-d-journal");
const MATERIALS = join(ROOT, "phase-d-draft-materials");

process.env["PROJECTS_ROOT"] = PROJECTS_ROOT;
process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
process.env["PAPERTEAM_GLOBAL_BUDGET_LEDGER"] = join(ROOT, "phase-d", "budget-ledger.json");
process.env["PAPERTEAM_GLOBAL_MAX_MODEL_CALLS"] = process.env.M1514_BUDGET_CAP ?? "300";
process.env["PAPERTEAM_GLOBAL_MAX_TOKENS"] = "0";

await mkdir(OUT_DIR, { recursive: true });

const dist = (...p) => join(REPO, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;
const { loadConfig } = await import(distUrl("config", "config.js"));
const { PiRuntimeAdapter } = await import(distUrl("runtime", "PiRuntimeAdapter.js"));
const { SkillRegistry } = await import(distUrl("skills", "SkillRegistry.js"));
const { ModelSettingsStore, resolveStartupModelSpec } = await import(distUrl("settings", "ModelSettingsStore.js"));
const { ProjectStore } = await import(distUrl("project", "ProjectStore.js"));
const { PaperStore } = await import(distUrl("paper", "PaperStore.js"));
const { GlobalBudgetLedger } = await import(distUrl("runtime", "globalBudgetLedger.js"));
const { ContributionAuditService } = await import(distUrl("target", "ContributionAuditService.js"));
const { buildPoolForDocument } = await import("./build-pool.mjs");

const CASES = [
  {
    tag: "R",
    pdf: join(MATERIALS, "case-R.pdf"),
    documentType: "research_article",
    cutoffYear: 2023,
    meta: { doi: "10.11834/jig.220902", title: "层级语义融合的场景文本检测", year: 2023, source: "CJIG OA (M15.10 未消费语料)" },
  },
  {
    tag: "S",
    pdf: join(MATERIALS, "case-S.pdf"),
    documentType: "survey",
    cutoffYear: 2023,
    meta: { doi: "10.11834/jig.220904", title: "视觉信息抽取的深度学习方法综述", year: 2023, source: "CJIG OA (M15.10 未消费语料)" },
  },
  {
    tag: "b1",
    pdf: join(MATERIALS, "b1-original.pdf"),
    documentType: "survey",
    cutoffYear: 2025,
    meta: { doi: null, title: "多目标跟踪评测指标体系综述（作者稿 b1-original）", year: 2025, source: "M15_9 作者稿（授权环境）" },
  },
];

const config = loadConfig();
const budgetLedger = new GlobalBudgetLedger({ path: process.env.PAPERTEAM_GLOBAL_BUDGET_LEDGER, limits: { maxCalls: 300, maxTokens: 0 }, label: "M15.14 phaseD" });
const skillRegistry = new SkillRegistry({ storeRoot: join(config.runtimeRoot, "skills"), disabledSkillIds: config.skills.disabledSkillIds, log: () => {} });
await skillRegistry.ensureInstalled();
const adapter = new PiRuntimeAdapter({
  modelSpec: config.pi.model ?? (await resolveStartupModelSpec(undefined, new ModelSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") }))),
  ...(config.pi.apiKey !== undefined ? { apiKey: config.pi.apiKey } : {}),
  agentDir: config.pi.agentDir,
  workspaceRoot: PROJECTS_ROOT,
  runTimeoutMs: config.pi.runTimeoutMs,
  roleSkills: (role, scope) => skillRegistry.skillAssignmentsFor(role, scope),
  log: () => {},
});
// 物理调用台账（与 run-arms 同一 jsonl，armHint=phase-d）
const CALLS_LOG = join(ROOT, "phase-d", "model-calls.jsonl");
const { appendFile } = await import("node:fs/promises");
const originalRunAgentPd = adapter.runAgent.bind(adapter);
adapter.runAgent = async (...callArgs) => {
  const t0 = Date.now();
  const scopeHint = callArgs[0]?.contextScope ?? "";
  const result = await originalRunAgentPd(...callArgs);
  await appendFile(
    CALLS_LOG,
    JSON.stringify({
      ts: new Date().toISOString(),
      callIndex: 0,
      familyId: `phaseD-${callArgs[0]?.metadata?.pass ?? scopeHint}`,
      contextScope: scopeHint,
      armHint: "phase-d",
      status: result.status,
      ms: Date.now() - t0,
      usage: result.usage ?? null,
      taskId: result.taskId,
    }) + "\n",
    "utf8",
  ).catch(() => {});
  return result;
};
const projects = new ProjectStore({ root: PROJECTS_ROOT });
const paperStore = new PaperStore(projects);
const auditService = new ContributionAuditService({
  store: paperStore,
  runtime: adapter,
  reviewerAgentId: "main",
  researchDir: (id) => projects.researchDir(id),
});

// M15_9 参照工件（只读引用）
const guideline = JSON.parse(await readFile("D:\\PaperTeamData\\M15\\M15_9\\phase-c\\guideline-artifacts\\cjig.json", "utf8"));
const guidelineCount = Array.isArray(guideline.requirements) ? guideline.requirements.length : 0;

const caseArg = process.argv.includes("--cases") ? process.argv[process.argv.indexOf("--cases") + 1] : null;
const selected = caseArg !== null ? CASES.filter((c) => caseArg.split(",").includes(c.tag)) : CASES;

// 简易 import：直接调 PaperIngestService（不经 HTTP，避免整套 stack）
const { PaperIngestService } = await import(distUrl("paper", "PaperIngestService.js"));
const { PyMuPdfParser } = await import(distUrl("paper", "PdfParser.js"));
const ingest = new PaperIngestService({ projects, store: paperStore, parser: new PyMuPdfParser(), log: () => {} });

for (const testCase of selected) {
  const outJson = join(OUT_DIR, `case-${testCase.tag}.json`);
  if (existsSync(outJson)) {
    console.log(`[skip] case-${testCase.tag} exists`);
    continue;
  }
  console.log(`[case-${testCase.tag}] import + pool + audit ...`);
  const project = await projects.create(`M15.14 PhaseD case-${testCase.tag}`);
  const projectId = project.id;
  const content = await readFile(testCase.pdf);
  await ingest.ingest(projectId, { fileName: `case-${testCase.tag}.pdf`, content });
  // 无摘要 PaperMap 不需要（A2 直读 document）；直接构建 pool
  const document = await paperStore.loadDocument(projectId);
  const pool = await buildPoolForDocument(document, {
    familyId: `case-${testCase.tag}`,
    cutoffYear: testCase.cutoffYear,
    titleOverride: testCase.meta.titleEn ?? undefined,
  });
  const outcome = await auditService.audit({
    projectId,
    runId: `m1514-pd-${testCase.tag}`,
    pool,
    documentType: testCase.documentType,
    venueId: "cjig",
    toolPolicy: "read_only",
  });
  const record = {
    case: testCase.tag,
    meta: testCase.meta,
    documentType: testCase.documentType,
    venue: "cjig",
    projectId,
    pool: { cutoffDate: pool.cutoffDate, size: pool.candidates.length, levels: pool.buildStats.contentLevels, buildStats: pool.buildStats },
    audit: outcome.artifact,
    telemetry: outcome.telemetry,
    parseFailures: { extract: outcome.extractParseFailed, compare: outcome.compareParseFailed, synthesize: outcome.synthesizeParseFailed },
    layers: {
      officialGuideline: {
        status: testCase.tag === "b1" ? "M15_9 已评估（3 项违规：题目字数/关键词要素/摘要四要素）" : "NOT_EVALUATED（PDF-only 稿件；compliance facts 需要 LaTeX——既有产品约束，如实呈现）",
        guidelineRequirements: guidelineCount,
        provenance: "M15_9 phase-c/guideline-artifacts/cjig.json（官方逐字摘录+URL+SHA256）",
      },
      benchmarkBands: {
        status: "参照 M15_9 CJIG 24 篇冻结语料观测带（正文词数 p25-p75=4577-10063 等）——benchmark 观测，非官方投稿要求",
      },
      contributionRisk: {
        status: "本轮 ContributionAuditService advisory（四态局部风险语义；不构成录用判断）",
      },
    },
  };
  await writeFile(outJson, JSON.stringify(record, null, 1), "utf8");
  console.log(
    `[case-${testCase.tag}] contributions=${outcome.artifact.inventory.length} comparisons=${outcome.artifact.comparisons.length} findings=${outcome.artifact.findings.length} gapPlan=${outcome.artifact.gapPlan.length} pool=${pool.candidates.length}(abs ${pool.buildStats.contentLevels.abstract}) calls=${outcome.telemetry.calls} guards=${JSON.stringify(outcome.artifact.guards)}`,
  );
}
console.log("phase-d smoke done");
process.exit(0);
