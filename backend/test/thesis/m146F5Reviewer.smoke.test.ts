/**
 * M14.6 Smoke A — F5 Reviewer 科研事实口径真实模型复验（env 门控：PAPERTEAM_M146_F5_SMOKE=1；默认跳过，不进 CI）。
 *
 * 背景（M14.5 §17 F5）：真实 run 中 reviewer 把作者已确认的研究输入事实（小论文的
 * 「高度跟踪误差降低 75.37%」）判为「本项目没有已导入的实验数据 / 未授权 / 仅见于外部来源」
 * 并 blocking，修订随之把合法数值弱化为「显著降低」。M14.5 注入了已确认事实表，但只有
 * 确定性测试（预算 50/50 用满）。本 smoke 以**产品同一调用路径**（ReviewerService.reviewMode
 * fact 模式 + review.run 同款 digest / policy 组合）复现该场景：
 *
 *   场景 legit   ：run2 rev-1 的实验结果节 + 总结节（含 75.37%），事实表 = run2 已确认 11 条
 *   场景 counter ：同一稿件注入一条无来源数值句（62.4% / 3.8 ms），reviewer 仍应报告支撑缺口
 *
 * 模式（PAPERTEAM_M146_F5_MODE）：
 *   baseline ：按 M14.5 当时的 policy 组合（Experiment Policy 零包行 + 事实表）——只记录不断言
 *   verify   ：按 M14.6 统一事实口径（composeExperimentAndResearchFactPolicyLines）——断言：
 *              legit 中不得出现把 75.37% 判为无来源/未授权的 issue、不得要求删除 / 弱化 75.37% 本身；
 *              counter 中必须有 issue / claim 指向 62.4%（或 3.8 ms），且 75.37% 仍不被误判。
 *
 * 预算：所有调用经跨实验总账本（PAPERTEAM_M146_GLOBAL_LEDGER，默认上限 10 次）硬拦截。
 * 运行（Windows 本机）：
 *   PAPERTEAM_M146_F5_SMOKE=1 PAPERTEAM_M146_F5_MODE=verify PAPERTEAM_M146_F5_SCENARIOS=legit,counter \
 *   PAPERTEAM_M146_MODEL=zai-coding-cn/glm-5.3 npx vitest run test/thesis/m146F5Reviewer.smoke.test.ts
 *
 * 产物：PAPERTEAM_M146_OUT（默认 D:\PaperTeamData\M14_6\smoke）下 f5-<scenario>-<mode>-<ts>.json
 * （完整 prompt、模型原始 issues/claims、usage、判定）——先落盘再断言，失败证据不丢。不写入仓库。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiRuntimeAdapter } from "../../src/runtime/PiRuntimeAdapter.js";
import type { AgentRuntime } from "../../src/runtime/types.js";
import { CustomProviderStore } from "../../src/settings/CustomProviderStore.js";
import { registerStoredCustomProviders } from "../../src/settings/ModelSettingsService.js";
import { ModelSettingsStore, resolveStartupModelSpec } from "../../src/settings/ModelSettingsStore.js";
import { ReviewerService, type ReviewIssue } from "../../src/agents/ReviewerService.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import { renderExperimentPolicyLines } from "../../src/experiments/experimentPolicy.js";
import { renderThesisFactPolicyLines } from "../../src/thesis/thesisWritingContext.js";
import { composeExperimentAndResearchFactPolicyLines } from "../../src/thesis/researchFactPolicy.js";
import { describeFactLocation } from "../../src/thesis/tableAlignment.js";
import { disconfirmFactFindingsAgainstResearchFacts } from "../../src/thesis/factFindingDisconfirmation.js";
import type { FactView, ScientificFact } from "../../src/thesis/researchInputTypes.js";
import { sliceForDigest } from "../../src/workflow/definitions.js";
import { GlobalBudgetLedger } from "../helpers/globalBudgetLedger.js";

const live = process.env["PAPERTEAM_M146_F5_SMOKE"] === "1";
/** 回放模式：对既有产物 JSON（真实模型原始输出）重新执行判定与断言，零模型调用 */
const replayPath = process.env["PAPERTEAM_M146_F5_REPLAY"];
const mode = process.env["PAPERTEAM_M146_F5_MODE"] === "verify" ? "verify" : "baseline";
const scenarios = (process.env["PAPERTEAM_M146_F5_SCENARIOS"] ?? "legit").split(",").map((s) => s.trim()).filter(Boolean);
const caseBProject = process.env["PAPERTEAM_M146_CASEB_PROJECT"] ?? "D:\\PaperTeamData\\M14_5\\projects-caseB\\p-7fb5ffbec963";
const outDir = process.env["PAPERTEAM_M146_OUT"] ?? "D:\\PaperTeamData\\M14_6\\smoke";
const ledgerPath = process.env["PAPERTEAM_M146_GLOBAL_LEDGER"] ?? "D:\\PaperTeamData\\M14_6\\m146-global-budget.json";
const ledgerMaxCalls = Number(process.env["PAPERTEAM_M146_GLOBAL_MAX_CALLS"] ?? "10");
const ledgerMaxTokens = Number(process.env["PAPERTEAM_M146_GLOBAL_MAX_TOKENS"] ?? "600000");

/** 无来源反例句（数值均不在案例 B 事实集中） */
const COUNTER_SENTENCE = "此外，横向位置跟踪误差亦降低了 62.4%，NMPC 单步平均求解时间为 3.8 ms。";

const UNAUTHORIZED_PATTERN = /无授权|未授权|没有已导入|无实验数据|没有实验数据|无任何已核验|仅见于外部|证据库无|不在授权范围|无证据支撑|未经授权|无已核验|无来源|来源不明/;
const REMOVAL_PATTERN = /删除|弱化|改为定性|去掉|移除|替换为定性|定性表述/;

type UsageShape = Partial<Record<"inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "estimatedCost", number>>;

function toFactView(fact: ScientificFact): FactView {
  return {
    factId: fact.factId,
    researchInputId: fact.researchInputId,
    kind: fact.kind,
    key: fact.key,
    surface: fact.surface,
    value: fact.value,
    verification: fact.verification.status,
    sourceCheck: fact.verification.sourceCheck,
    conflictStatus: fact.conflict.status,
    location: describeFactLocation(fact),
  };
}

function mentions(issue: ReviewIssue, token: string): boolean {
  return `${issue.description}\n${issue.suggestedAction ?? ""}\n${issue.reason ?? ""}`.includes(token);
}

function issueText(issue: ReviewIssue): string {
  return `${issue.description}\n${issue.suggestedAction ?? ""}\n${issue.reason ?? ""}`;
}

const ACKNOWLEDGE_PATTERN = /保留.{0,12}(75\.37|数值|事实本身)|数值本身|属授权|已确认事实|表中(仅)?有|事实表(内|中)|与.{0,8}事实一致|已授权数值/;

/**
 * 把 75.37% 判为无来源/未授权的 issue（F5 的失败形态）：**同一句**内同时出现 75.37 与来源 / 授权缺失措辞，
 * 且该句未承认该数值合法（「表中仅有 75.37%」「保留 75.37%」「与已确认事实一致」）。
 * 只要求弱化同句中**另一个**论断（如「收益远大于开销」「完成即满足实时性要求」）的 finding 不算误判——
 * 那是合法的审稿意见（M14.6 verify 实录）。与产品侧 disconfirmFactFindingsAgainstResearchFacts 的 D 条件同口径。
 */
function misjudges7537(issue: ReviewIssue): boolean {
  if (!mentions(issue, "75.37")) return false;
  const sentences = issueText(issue).split(/(?<=[。；;！？!?\n])/);
  return sentences.some((sentence) => sentence.includes("75.37") && UNAUTHORIZED_PATTERN.test(sentence) && !ACKNOWLEDGE_PATTERN.test(sentence));
}

/** 要求删除 / 弱化 75.37% 本身（无论理由）——单独统计并断言 */
function asksToRemove7537(issue: ReviewIssue): boolean {
  if (!mentions(issue, "75.37")) return false;
  const action = issue.suggestedAction ?? "";
  return REMOVAL_PATTERN.test(action) && /75\.37|该数值|具体数值|百分比/.test(action) && !/保留.{0,12}(75\.37|数值|事实本身)/.test(action);
}

describe.skipIf(!live)("M14.6 Smoke A — F5 Reviewer 科研事实口径真实复验", () => {
  let adapter: PiRuntimeAdapter | undefined;
  afterAll(async () => {
    await adapter?.close().catch(() => undefined);
  });

  it(`reviewMode(fact) 真实复验（mode=${mode}；scenarios=${scenarios.join("+")}）`, { timeout: 900_000 }, async () => {
    const runtimeRoot =
      process.env["PAPERTEAM_M146_RUNTIME_ROOT"] ?? join(process.env["USERPROFILE"] ?? process.env["HOME"] ?? tmpdir(), ".paperteam");
    const agentDir = join(runtimeRoot, "runtime", "pi", "agent");
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
    const customProviderStore = new CustomProviderStore({ settingsDir: join(runtimeRoot, "settings") });
    await registerStoredCustomProviders(modelRuntime, customProviderStore, () => {});
    const startupSpec = await resolveStartupModelSpec(process.env["PAPERTEAM_M146_MODEL"], new ModelSettingsStore({ settingsDir: join(runtimeRoot, "settings") }));
    expect(startupSpec).toBeDefined();
    adapter = new PiRuntimeAdapter({ modelSpec: startupSpec!, agentDir, workspaceRoot: tmpdir(), runTimeoutMs: 300_000, modelRuntime });

    const ledger = new GlobalBudgetLedger(ledgerPath, `m146-f5-${mode}`, { maxCalls: ledgerMaxCalls, maxTokens: ledgerMaxTokens });
    const calls: Array<{ scenario: string; prompt: string; output: string; usage?: UsageShape; durationMs: number }> = [];
    let currentScenario = "";
    const target = adapter;
    const counting: AgentRuntime = new Proxy(target, {
      get(obj, prop) {
        const value = Reflect.get(obj, prop, obj);
        if (prop === "runAgent" && typeof value === "function") {
          return async (input: { task: string }) => {
            ledger.chargeCall();
            const startedAt = Date.now();
            const task = (await (value as (...a: unknown[]) => Promise<unknown>).apply(obj, [input])) as { output?: string; usage?: UsageShape };
            ledger.chargeUsage(task.usage);
            calls.push({ scenario: currentScenario, prompt: input.task, output: task.output ?? "", ...(task.usage !== undefined ? { usage: task.usage } : {}), durationMs: Date.now() - startedAt });
            return task;
          };
        }
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(obj) : value;
      },
    }) as unknown as AgentRuntime;

    const projects = new ProjectStore({ root: join(tmpdir(), `m146-f5-${Date.now()}`) });
    const reviewer = new ReviewerService({ runtime: counting, agentId: "reviewer", projects, runTimeoutMs: 300_000 });

    // ---- 案例 B run2 真实材料：已确认事实 + rev-1 正文 ----
    const factsFile = JSON.parse(await readFile(join(caseBProject, "research", "scientific-facts.json"), "utf8")) as { facts: ScientificFact[] };
    const views = factsFile.facts.map(toFactView);
    const factContext = {
      facts: {
        authorConfirmed: views.filter((f) => f.verification === "author_confirmed" && f.conflictStatus === "none"),
        sourceVerifiedUnconfirmed: views.filter((f) => f.verification === "source_verified"),
        extractedOnly: views.filter((f) => f.verification === "extracted"),
        conflicted: views.filter((f) => f.conflictStatus !== "none"),
      },
    };
    expect(factContext.facts.authorConfirmed.some((f) => f.surface === "75.37%")).toBe(true);
    const sectionsDir = join(caseBProject, "manuscript-thesis", "revisions", "rev-1", "sections");
    const expResults = await readFile(join(sectionsDir, "exp-tracking-results.tex"), "utf8");
    const conclSummary = await readFile(join(sectionsDir, "concl-summary.tex"), "utf8");
    expect(expResults).toContain("75.37%");

    const emptyPolicy = { entries: [], legacyConfirmedGroupIds: [] };
    const policyLines =
      mode === "verify"
        ? composeExperimentAndResearchFactPolicyLines(emptyPolicy, factContext)
        : [...renderExperimentPolicyLines(emptyPolicy), ...renderThesisFactPolicyLines(factContext)];

    const results: Record<string, unknown> = {};
    const deferredAssertions: Array<() => void> = [];
    for (const scenario of scenarios) {
      currentScenario = scenario;
      const expBody = scenario === "counter"
        ? expResults.replace("高度跟踪误差降低了 75.37%。", `高度跟踪误差降低了 75.37%。${COUNTER_SENTENCE}`)
        : expResults;
      if (scenario === "counter") expect(expBody).toContain("62.4%");
      const digest = sliceForDigest(
        [
          "[main.tex]（组装根：\\documentclass + 标题 + 摘要 + \\input 各节；由系统生成，不要把问题归到这里）\n\\input 清单：sections/exp-tracking-results、sections/concl-summary",
          `[sections/exp-tracking-results.tex]\n${sliceForDigest(expBody, 3600)}`,
          `[sections/concl-summary.tex]\n${sliceForDigest(conclSummary, 3600)}`,
        ].join("\n\n"),
        60_000,
      );
      const review = await reviewer.reviewMode({
        projectId: "p-m146-f5-smoke",
        mode: "fact",
        manuscriptDigest: digest,
        evidence: [],
        language: "zh",
        targetProfile: "master_thesis",
        citationDigest: "cited=0 missing=0 hallucinated=0 mismatched=0",
        experimentPolicyLines: policyLines,
      });
      const misjudged = review.issues.filter(misjudges7537);
      const removal7537 = review.issues.filter(asksToRemove7537);
      const productionDisconfirm = disconfirmFactFindingsAgainstResearchFacts(review.issues, factContext.facts.authorConfirmed);
      const mentions7537 = review.issues.filter((issue) => mentions(issue, "75.37"));
      const counterHits = review.issues.filter((issue) => mentions(issue, "62.4") || mentions(issue, "3.8 ms") || mentions(issue, "3.8ms"));
      const claims7537 = (review.claims ?? []).filter((claim) => claim.claim.includes("75.37"));
      const counterClaims = (review.claims ?? []).filter((claim) => claim.claim.includes("62.4") || claim.claim.includes("3.8"));
      results[scenario] = {
        taskId: review.taskId,
        summary: review.summary,
        issues: review.issues,
        claims: review.claims ?? [],
        repair: review.repair ?? null,
        verdict: {
          mentions7537: mentions7537.length,
          misjudged7537: misjudged.length,
          asksToRemove7537: removal7537.length,
          productionDisconfirmed: productionDisconfirm.disconfirmed.map((entry) => ({ description: entry.issue.description.slice(0, 160), matched: entry.matchedFacts })),
          claims7537: claims7537.map((c) => ({ verdict: c.verdict, claim: c.claim, note: c.note ?? null })),
          counterHits: counterHits.length,
          counterClaims: counterClaims.map((c) => ({ verdict: c.verdict, claim: c.claim })),
        },
      };
      console.log(
        `[m146-f5] scenario=${scenario} mode=${mode} issues=${review.issues.length} mentions7537=${mentions7537.length} misjudged7537=${misjudged.length} asksToRemove7537=${removal7537.length} productionDisconfirmed=${productionDisconfirm.disconfirmedCount} counterHits=${counterHits.length} claims7537=${JSON.stringify(claims7537.map((c) => `${c.verdict}${c.note ? `:${c.note.slice(0, 60)}` : ""}`))}`,
      );
      for (const issue of mentions7537) {
        console.log(`  [75.37 issue] ${issue.category}/${issue.severity}/blocking=${issue.blocking} ${issue.description.slice(0, 160)} → ${(issue.suggestedAction ?? "").slice(0, 120)}`);
      }
      for (const issue of counterHits) {
        console.log(`  [counter issue] ${issue.category}/${issue.severity}/blocking=${issue.blocking} ${issue.description.slice(0, 160)}`);
      }
      if (mode === "verify") {
        deferredAssertions.push(() => {
          expect(misjudged, `[${scenario}] verify：75.37% 不得被判为无来源/未授权`).toHaveLength(0);
          expect(removal7537, `[${scenario}] verify：不得要求删除 / 弱化 75.37% 本身`).toHaveLength(0);
          const supportedClaims = claims7537.filter((c) => c.verdict === "SUPPORTED" || c.verdict === "PARTIALLY_SUPPORTED");
          expect(claims7537.length === 0 || supportedClaims.length > 0, `[${scenario}] verify：75.37% 的 claim 不得全部 UNSUPPORTED（${JSON.stringify(claims7537.map((c) => c.verdict))}）`).toBe(true);
          for (const claim of claims7537.filter((c) => c.verdict === "UNSUPPORTED" || c.verdict === "CONTRADICTED")) {
            expect(UNAUTHORIZED_PATTERN.test(claim.note ?? ""), `[${scenario}] verify：75.37% 的 UNSUPPORTED claim 不得以来源缺失为由（${claim.note ?? ""}）`).toBe(false);
          }
          if (scenario === "counter") {
            const counterClaimUnsupported = counterClaims.some((c) => c.verdict === "UNSUPPORTED" || c.verdict === "CONTRADICTED");
            expect(counterHits.length > 0 || counterClaimUnsupported, "[counter] verify：无来源数值 62.4% / 3.8 ms 必须被报告为支撑缺口").toBe(true);
          }
        });
      }
    }

    await mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const outPath = join(outDir, `f5-${scenarios.join("+")}-${mode}-${stamp}.json`);
    await writeFile(
      outPath,
      JSON.stringify(
        {
          mode,
          scenarios,
          model: startupSpec,
          caseBProject,
          policyLines,
          results,
          calls: calls.map((call) => ({ ...call, promptChars: call.prompt.length, outputChars: call.output.length })),
          ledger: ledger.snapshot(),
          finishedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
    console.log(`[m146-f5] 产物：${outPath}；账本：calls=${ledger.snapshot().totals.calls}/${ledgerMaxCalls}`);
    for (const assertion of deferredAssertions) assertion();
  });
});

describe.skipIf(replayPath === undefined)("M14.6 Smoke A — F5 回放判定（零模型调用）", () => {
  it("对已保存的真实模型输出重新执行 verify 判定", async () => {
    const saved = JSON.parse(await readFile(replayPath!, "utf8")) as {
      mode: string;
      results: Record<string, { issues: ReviewIssue[]; claims: Array<{ claim: string; verdict: string; note?: string }> }>;
    };
    const factsFile = JSON.parse(await readFile(join(caseBProject, "research", "scientific-facts.json"), "utf8")) as { facts: ScientificFact[] };
    const confirmed = factsFile.facts.map(toFactView).filter((f) => f.verification === "author_confirmed" && f.conflictStatus === "none");
    const verdicts: Record<string, unknown> = {};
    for (const [scenario, review] of Object.entries(saved.results)) {
      const misjudged = review.issues.filter(misjudges7537);
      const removal7537 = review.issues.filter(asksToRemove7537);
      const productionDisconfirm = disconfirmFactFindingsAgainstResearchFacts(review.issues, confirmed);
      const claims7537 = review.claims.filter((claim) => claim.claim.includes("75.37"));
      const counterHits = review.issues.filter((issue) => mentions(issue, "62.4") || mentions(issue, "3.8 ms") || mentions(issue, "3.8ms"));
      const counterClaims = review.claims.filter((claim) => claim.claim.includes("62.4") || claim.claim.includes("3.8"));
      verdicts[scenario] = {
        issues: review.issues.length,
        misjudged7537: misjudged.length,
        asksToRemove7537: removal7537.length,
        productionDisconfirmed: productionDisconfirm.disconfirmedCount,
        claims7537: claims7537.map((claim) => claim.verdict),
        counterHits: counterHits.length,
        counterClaims: counterClaims.map((claim) => claim.verdict),
      };
      console.log(`[m146-f5-replay] ${scenario}: ${JSON.stringify(verdicts[scenario])}`);
      expect(misjudged, `[${scenario}] 75.37% 不得被判为无来源/未授权`).toHaveLength(0);
      expect(removal7537, `[${scenario}] 不得要求删除 / 弱化 75.37% 本身`).toHaveLength(0);
      expect(productionDisconfirm.disconfirmedCount, `[${scenario}] 产品反证器不应需要介入（模型自身判断正确）`).toBe(0);
      const supported = claims7537.filter((claim) => claim.verdict === "SUPPORTED" || claim.verdict === "PARTIALLY_SUPPORTED");
      expect(claims7537.length === 0 || supported.length > 0).toBe(true);
      if (scenario === "counter") {
        expect(counterHits.length > 0 || counterClaims.some((claim) => claim.verdict === "UNSUPPORTED" || claim.verdict === "CONTRADICTED")).toBe(true);
      }
    }
    await mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const outPath = join(outDir, `f5-replay-${stamp}.json`);
    await writeFile(outPath, JSON.stringify({ replayOf: replayPath, verdicts, finishedAt: new Date().toISOString() }, null, 2), "utf8");
    console.log(`[m146-f5-replay] 产物：${outPath}`);
  });
});
