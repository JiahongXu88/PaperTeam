/**
 * M14.9.1 Review Neutrality A/B 实验 CLI（--dry-run / --run / --compare）。
 *
 *   node scripts/m1491-review-neutrality.mjs --config <experiment-config.json> --dry-run
 *
 * 配置与全部语料 / 产物都在仓库外（论文全文、受版权保护 PDF 文本、审稿输出不入库）。
 * --dry-run：构建投影臂 + 内容等价门 + 调用计划 + 预算上界，零模型调用；
 * --run：按计划执行（生产 Reviewer 业务逻辑 + 生产模型路由 + 生产 Skill 注入），任务级账本调用前预留；
 * --compare：成对差值、重复采样噪声、元数据 / 格式类 finding 计数。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { ReviewerService } from "../agents/ReviewerService.js";
import { loadConfig } from "../config/config.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { flattenLatexInputs, projectNaive, projectPdfTextBlind, projectPdfTextNaive, projectRaw, projectStructuredBlind, type LatexSourceBundle, type ProjectionOutput } from "../review/blindReviewInput.js";
import { checkEquivalence, latexInventory, pdfTextInventory, type EquivalenceReport } from "../review/reviewInputEquivalence.js";
import { GlobalBudgetLedger } from "../runtime/globalBudgetLedger.js";
import { PiRuntimeAdapter } from "../runtime/PiRuntimeAdapter.js";
import { createWorkspaceGuardPolicy, createWorkspaceGuardTools } from "../runtime/pi/workspaceGuard.js";
import { RunBudgetLedgerRuntime } from "../runtime/runBudget.js";
import type { AgentRuntime, AgentTask, RunAgentInput } from "../runtime/types.js";
import { applyStoredApiChannels } from "../settings/apiChannels.js";
import { CustomProviderStore } from "../settings/CustomProviderStore.js";
import { registerStoredCustomProviders } from "../settings/ModelSettingsService.js";
import { ModelSettingsStore } from "../settings/ModelSettingsStore.js";
import { SkillRegistry } from "../skills/SkillRegistry.js";
import {
  compareNeutrality, planNeutralityCalls, resultFromReview,
  type NeutralityArm, type NeutralityArmInput, type NeutralityCallResult, type PlannedCall,
} from "./reviewNeutrality.js";

interface FamilyConfig {
  id: string;
  kind: "latex" | "pdf_text";
  language: "zh" | "en";
  main: string;
  bib?: { kind: "bbl" | "bib"; path: string };
  /** 要进入评分的臂与优先级（未列 = 只做零模型 QA） */
  arms: Partial<Record<NeutralityArm, 1 | 2 | 3>>;
  /** identity_swap：在盲化文本题名后插入的合成身份块（反例：内容不变，只换身份） */
  identitySwap?: string;
}

interface ExperimentConfig {
  outRoot: string;
  ledgerPath: string;
  limits: { maxCalls: number; maxTokens: number };
  outputReserveTokens: number;
  reps: number;
  seed: number;
  targetProfile: string;
  concurrency: number;
  modelSpec: string;
  families: FamilyConfig[];
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 1) + "\n", "utf8");
}

function latexBundle(family: FamilyConfig): LatexSourceBundle {
  const dir = dirname(family.main);
  const main = flattenLatexInputs(readFileSync(family.main, "utf8"), (name) => {
    for (const candidate of [join(dir, name), join(dir, `${name}.tex`)]) if (existsSync(candidate)) return readFileSync(candidate, "utf8");
    return null;
  });
  return { main, ...(family.bib !== undefined ? { bibliography: { kind: family.bib.kind, content: readFileSync(family.bib.path, "utf8") } } : {}) };
}

/** 构建一个家族的全部臂 + 等价门（零模型） */
export function buildFamilyArms(family: FamilyConfig): { arms: Array<{ projection: ProjectionOutput; report: EquivalenceReport }>; inputs: NeutralityArmInput[] } {
  const arms: Array<{ projection: ProjectionOutput; report: EquivalenceReport }> = [];
  if (family.kind === "latex") {
    const bundle = latexBundle(family);
    const inventory = latexInventory(bundle);
    const blind = projectStructuredBlind(bundle);
    const projections = [projectRaw(bundle), projectNaive(bundle), blind, projectStructuredBlind(bundle, { keepIdentity: true })];
    for (const projection of projections) arms.push({ projection, report: checkEquivalence(inventory, projection) });
    if (family.identitySwap !== undefined) {
      const swapped: ProjectionOutput = { ...blind, arm: "structured_blind_md", text: insertAfterTitle(blind.text, family.identitySwap) };
      arms.push({ projection: { ...swapped, arm: "identity_swap" as never }, report: { ...checkEquivalence(inventory, swapped), arm: "identity_swap" } });
    }
  } else {
    const raw = readFileSync(family.main, "utf8");
    const blind = projectPdfTextBlind(raw);
    const inventory = pdfTextInventory(raw, new Set(blind.redactions.map((entry) => entry.line)));
    const rawProjection: ProjectionOutput = { arm: "raw", text: raw, redactions: [], figuresNotEvaluated: 0, notes: ["pdf_text_basis"] };
    for (const projection of [rawProjection, projectPdfTextNaive(raw), blind]) arms.push({ projection, report: checkEquivalence(inventory, projection) });
    if (family.identitySwap !== undefined) {
      const swapped: ProjectionOutput = { ...blind, text: insertAfterTitle(blind.text, family.identitySwap) };
      arms.push({ projection: { ...swapped, arm: "identity_swap" as never }, report: { ...checkEquivalence(inventory, swapped), arm: "identity_swap" } });
    }
  }
  const inputs: NeutralityArmInput[] = [];
  for (const { projection, report } of arms) {
    const arm = projection.arm as NeutralityArm;
    const tier = family.arms[arm];
    if (tier === undefined) continue;
    inputs.push({ familyId: family.id, arm, language: family.language, text: projection.text, equivalence: report.status, conversionLoss: report.conversionLoss, tier });
  }
  return { arms, inputs };
}

function insertAfterTitle(text: string, block: string): string {
  const lines = text.split("\n");
  const titleIndex = lines.findIndex((line) => line.trim() !== "" && !/^-{2,}\s*page/i.test(line));
  // Markdown：题名是首个 # 行；PDF 文本：首页卷期行之后的第一条非空行之后
  const at = lines.findIndex((line) => line.startsWith("# "));
  const index = at >= 0 ? at : titleIndex;
  return [...lines.slice(0, index + 1), "", block, "", ...lines.slice(index + 1)].join("\n");
}

/** 身份残留审计：被字段移除的身份词（姓名 / 单位 / 邮箱）在投影中是否仍出现 */
function identityResidue(arms: Array<{ projection: ProjectionOutput }>, terms: string[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const { projection } of arms) {
    const counts: Record<string, number> = {};
    for (const term of terms) {
      const count = projection.text.split(term).length - 1;
      if (count > 0) counts[term] = count;
    }
    out[projection.arm] = counts;
  }
  return out;
}

async function createProductionReviewer(config: ExperimentConfig, ledger: GlobalBudgetLedger, recorder: Map<string, AgentTask>) {
  const app = loadConfig();
  const skillRegistry = new SkillRegistry({ storeRoot: join(app.runtimeRoot, "skills"), disabledSkillIds: app.skills.disabledSkillIds, log: () => {} });
  const installed = await skillRegistry.ensureInstalled();
  const modelSettingsStore = new ModelSettingsStore({ settingsDir: join(app.runtimeRoot, "settings") });
  const modelRuntime = await ModelRuntime.create({ authPath: join(app.pi.agentDir, "auth.json"), modelsPath: join(app.pi.agentDir, "models.json") });
  await registerStoredCustomProviders(modelRuntime, new CustomProviderStore({ settingsDir: join(app.runtimeRoot, "settings") }), () => {});
  await applyStoredApiChannels(modelRuntime, modelSettingsStore, () => {});
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pt-m1491-"));
  const adapter = new PiRuntimeAdapter({
    modelSpec: config.modelSpec,
    ...(app.pi.apiKey !== undefined ? { apiKey: app.pi.apiKey } : {}),
    agentDir: app.pi.agentDir,
    workspaceRoot,
    runTimeoutMs: Math.max(app.pi.runTimeoutMs, 1_800_000),
    firstActivityTimeoutMs: app.pi.firstActivityTimeoutMs,
    modelRuntime,
    agentModelSpecs: async () => (await modelSettingsStore.load()).agents ?? {},
    roleSkills: (role, scope, language) => skillRegistry.skillAssignmentsFor(role, scope, language),
    // 影子比较器的工作区只有空目录：Agent 工具面与生产同一守卫，所有来源不可见
    workspaceGuard: async ({ cwd, skillDirs, toolNames }) =>
      createWorkspaceGuardTools(createWorkspaceGuardPolicy({ projectDir: cwd, readOnlyRoots: skillDirs, protectedSourceIds: [], protectAllSources: true }), { cwd, toolNames }),
    log: () => {},
  });
  const budgeted = new RunBudgetLedgerRuntime({
    runtime: adapter,
    limits: { maxModelCallsPerRun: 0, maxRunTokensPerRun: 0 },
    resolveLedgerDir: () => join(config.outRoot, "experiments"),
    global: { ledger, outputReserveTokens: config.outputReserveTokens, experimentId: "m1491-review-neutrality" },
  });
  const recording: AgentRuntime = {
    provider: budgeted.provider,
    resolvedModel: budgeted.resolvedModel,
    startAgent: (input) => budgeted.startAgent(input),
    runAgent: async (input: RunAgentInput) => {
      const task = await budgeted.runAgent(input);
      if (input.projectId !== undefined) recorder.set(`${input.projectId}#${recorder.size}`, task);
      return task;
    },
    getTask: (taskId) => budgeted.getTask(taskId),
    healthCheck: () => budgeted.healthCheck(),
    close: () => budgeted.close(),
  };
  const reviewer = new ReviewerService({
    runtime: recording,
    agentId: app.agents.reviewer,
    projects: {} as ProjectStore,
    runTimeoutMs: Math.max(app.pi.longRunTimeoutMs ?? 0, 1_800_000),
  });
  return {
    reviewer,
    skills: installed.map((skill) => `${skill.id}@${skill.contentHash.slice(0, 12)}`),
    close: async () => {
      await adapter.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    },
  };
}

export async function main(argv: string[]): Promise<void> {
  const configPath = argv[argv.indexOf("--config") + 1];
  if (configPath === undefined || !argv.includes("--config")) throw new Error("用法：--config <experiment-config.json> (--dry-run | --run | --compare)");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as ExperimentConfig;
  const out = (...parts: string[]) => join(config.outRoot, ...parts);

  // ---- 投影 + 等价门（每种模式都先做；零模型）----
  const allInputs: NeutralityArmInput[] = [];
  const coverage: Record<string, unknown> = {};
  const redaction: Record<string, unknown> = {};
  for (const family of config.families) {
    const built = buildFamilyArms(family);
    allInputs.push(...built.inputs);
    const removedIdentity = built.arms.find((entry) => entry.projection.arm === "structured_blind_md")?.projection.redactions
      .filter((entry) => entry.kind === "author" || entry.kind === "affiliation" || entry.kind === "email") ?? [];
    const terms = [...new Set(removedIdentity.flatMap((entry) => entry.excerpt.split(/[\\{}$^,，、\s~]+|quad|small|and/).map((piece) => piece.replace(/[0-9*+]/g, "").trim())))]
      .filter((term) => term.length >= (/[一-鿿]/.test(term) ? 2 : 4) && !/^(author|tt|E-mail|mail|par|centering|color|red|linewidth|parbox|dag)$/i.test(term)).slice(0, 40);
    coverage[family.id] = built.arms.map(({ projection, report }) => ({
      arm: projection.arm, textSha256: sha256(projection.text), chars: projection.text.length, figuresNotEvaluated: projection.figuresNotEvaluated,
      status: report.status, reasons: report.reasons, conversionLoss: report.conversionLoss, metrics: report.metrics, missing: report.missing,
      lineageSummary: { retained: report.lineage.filter((entry) => entry.status === "retained").length, missing: report.lineage.filter((entry) => entry.status === "missing").length },
    }));
    redaction[family.id] = {
      identityTermsProbed: terms,
      identityResidue: identityResidue(built.arms, terms),
      arms: Object.fromEntries(built.arms.map(({ projection }) => [projection.arm, projection.redactions])),
    };
    for (const { projection } of built.arms) {
      mkdirSync(out("projection", "arms"), { recursive: true });
      writeFileSync(out("projection", "arms", `${family.id}.${projection.arm}.txt`), projection.text, "utf8");
    }
  }
  writeJson(out("projection", "a-b-c-coverage.json"), { generatedAt: new Date().toISOString(), families: coverage });
  writeJson(out("projection", "redaction-audit.json"), { generatedAt: new Date().toISOString(), families: redaction });

  const plan = planNeutralityCalls(allInputs, { reps: config.reps, seed: config.seed, targetProfile: config.targetProfile, outputReserveTokens: config.outputReserveTokens });
  const worstCase = plan.reduce((sum, call) => sum + call.reservedTokens, 0);
  const promptTotal = plan.reduce((sum, call) => sum + call.estimatedPromptTokens, 0);
  const skipped = allInputs.filter((input) => input.equivalence !== "VALID").map((input) => `${input.familyId}.${input.arm}`);

  if (argv.includes("--dry-run")) {
    const ledger = new GlobalBudgetLedger({ path: config.ledgerPath, limits: config.limits, label: "M14.9.1 review neutrality (task-level)" });
    writeJson(out("experiments", "dry-run-plan.json"), {
      generatedAt: new Date().toISOString(), modelSpec: config.modelSpec, reps: config.reps, seed: config.seed, targetProfile: config.targetProfile,
      limits: config.limits, ledgerSnapshot: ledger.snapshot(), plannedCalls: plan.length, estimatedPromptTokensTotal: promptTotal,
      worstCaseReservedTokens: worstCase, skippedInvalidInputArms: skipped, plan,
      note: "worstCase = Σ(保守 prompt 预估 + outputReserveTokens)；真实执行时每次调用前按已用 + 在途预留检查，超限拒绝启动",
    });
    console.log(JSON.stringify({ plannedCalls: plan.length, promptTotal, worstCase, skipped, limits: config.limits, ledger: ledger.snapshot() }, null, 1));
    for (const call of plan) console.log(`${String(call.order).padStart(2)} t${call.tier} ${call.callId.padEnd(44)} prompt≈${call.estimatedPromptTokens} reserve=${call.reservedTokens}`);
    return;
  }

  if (argv.includes("--run")) {
    const ledger = new GlobalBudgetLedger({ path: config.ledgerPath, limits: config.limits, label: "M14.9.1 review neutrality (task-level)" });
    const resultsPath = out("experiments", "raw-results.json");
    const existing = existsSync(resultsPath) ? (JSON.parse(readFileSync(resultsPath, "utf8")) as { results: NeutralityCallResult[] }).results : [];
    const done = new Set(existing.filter((result) => result.status === "completed").map((result) => result.callId));
    const results: NeutralityCallResult[] = existing.filter((result) => result.status === "completed");
    const recorder = new Map<string, AgentTask>();
    const production = await createProductionReviewer(config, ledger, recorder);
    const inputByKey = new Map(allInputs.map((input) => [`${input.familyId}.${input.arm}`, input]));
    const save = () => writeJson(resultsPath, { generatedAt: new Date().toISOString(), modelSpec: config.modelSpec, skills: production.skills, ledger: config.ledgerPath, results });
    const queue = plan.filter((call) => !done.has(call.callId));
    let stop = false;
    const worker = async () => {
      for (;;) {
        const call = queue.shift();
        if (call === undefined || stop) return;
        const input = inputByKey.get(`${call.familyId}.${call.arm}`)!;
        const projectId = `nx-${call.callId.replace(/[^A-Za-z0-9-]/g, "-")}-${Date.now().toString(36)}`;
        const startedAt = new Date().toISOString();
        const t0 = Date.now();
        try {
          const review = await production.reviewer.reviewMode({ projectId, mode: "academic", manuscriptDigest: input.text, evidence: [], targetProfile: config.targetProfile, language: input.language });
          const tasks = [...recorder.entries()].filter(([key]) => key.startsWith(`${projectId}#`)).map(([, task]) => task);
          const usage = tasks.reduce((sum, task) => ({
            inputTokens: sum.inputTokens + (task.usage?.inputTokens ?? 0), outputTokens: sum.outputTokens + (task.usage?.outputTokens ?? 0),
            cacheReadTokens: sum.cacheReadTokens + (task.usage?.cacheReadTokens ?? 0), cacheWriteTokens: sum.cacheWriteTokens + (task.usage?.cacheWriteTokens ?? 0),
            estimatedCost: sum.estimatedCost + (task.usage?.estimatedCost ?? 0),
          }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCost: 0 });
          const last = tasks[tasks.length - 1];
          const rawOutput = tasks.map((task) => task.output ?? "").join("\n\n=====\n\n");
          mkdirSync(out("experiments", "raw-outputs"), { recursive: true });
          writeFileSync(out("experiments", "raw-outputs", `${call.callId}.txt`), rawOutput, "utf8");
          results.push(resultFromReview(call, review, {
            durationMs: Date.now() - t0, startedAt,
            ...(typeof last?.metadata?.["model"] === "string" ? { model: last.metadata["model"] as string } : {}),
            usage, rawOutputSha256: sha256(rawOutput),
          }));
          console.log(`[ok] ${call.callId} overall=${review.overallScore} scores=${JSON.stringify(review.scores)} issues=${review.issues.length} usage=${JSON.stringify(usage)}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const refused = /MODEL_BUDGET_EXCEEDED|任务级模型预算/.test(message) || (error as { code?: string }).code === "MODEL_BUDGET_EXCEEDED";
          results.push({ callId: call.callId, familyId: call.familyId, arm: call.arm, rep: call.rep, status: refused ? "refused_budget" : "failed", error: message.slice(0, 500), startedAt, durationMs: Date.now() - t0 });
          console.log(`[${refused ? "refused" : "failed"}] ${call.callId}: ${message.slice(0, 200)}`);
          if (refused) stop = true;
        }
        save();
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.max(1, config.concurrency) }, () => worker()));
    } finally {
      save();
      await production.close();
    }
    console.log(JSON.stringify(ledger.snapshot()));
    return;
  }

  if (argv.includes("--compare")) {
    const results = (JSON.parse(readFileSync(out("experiments", "raw-results.json"), "utf8")) as { results: NeutralityCallResult[] }).results;
    writeJson(out("experiments", "comparison.json"), { generatedAt: new Date().toISOString(), plannedCalls: plan.length, skippedInvalidInputArms: skipped, ...compareNeutrality(results) });
    return;
  }
  throw new Error("需要 --dry-run / --run / --compare 之一");
}

export type { PlannedCall };
