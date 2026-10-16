/**
 * M14.6 Smoke D — 真实模型小范围 Revision：合法审稿意见 + 学位论文修订纪律 → 75.37% 保留（env 门控：
 * PAPERTEAM_M146_REVISION_SMOKE=1；默认跳过，不进 CI；1 次模型调用）。
 *
 * 场景取自 M14.6 Smoke A verify 的真实 reviewer 输出：对案例 B 实验结果节的合法 finding
 * 「『误差降低 75.37% 的幅度表明前瞻性补偿收益远大于额外计算与信息交换开销』为效益对比性结论，未核验任何
 * 开销对比数据 → 删除或弱化『远大于开销』的对比性判断，保留误差降低事实本身」。
 * Writer 以 reviseSection（产品同一入口）执行，携带 M14.6 统一事实行与修订纪律（禁止删值）。断言（确定性）：
 *   - detectConfirmedFactRemoval(before, after, 已确认事实) 为空（75.37% 等全部保留）；
 *   - 候选经写作期百分号转义后不含裸 `75.37%`；
 *   - 候选不含工作流元注记（detectWorkflowMetaNotes 高置信 = 0）；
 *   - 「远大于」对比断言被弱化或删除（记录，软断言：若仍存在则记录为模型未执行该意见，不判失败——
 *     修订是否采纳意见属 reviewer/Writer 循环范畴，本 smoke 只守事实）。
 *
 * 运行：PAPERTEAM_M146_REVISION_SMOKE=1 PAPERTEAM_M146_MODEL=zai-coding-cn/glm-5.3 npx vitest run test/thesis/m146Revision.smoke.test.ts
 * 产物：D:\PaperTeamData\M14_6\smoke\revision-<ts>.json
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
import { WriterService } from "../../src/writer/WriterService.js";
import type { ReviewIssue } from "../../src/agents/ReviewerService.js";
import { renderResearchFactLine } from "../../src/thesis/researchFactPolicy.js";
import { detectConfirmedFactRemoval } from "../../src/thesis/factFindingDisconfirmation.js";
import { detectWorkflowMetaNotes } from "../../src/thesis/workflowMetaNotes.js";
import { countBarePercentAfterDigits } from "../../src/writer/latexSanitize.js";
import { describeFactLocation } from "../../src/thesis/tableAlignment.js";
import type { FactView, ScientificFact } from "../../src/thesis/researchInputTypes.js";
import { GlobalBudgetLedger } from "../helpers/globalBudgetLedger.js";

const live = process.env["PAPERTEAM_M146_REVISION_SMOKE"] === "1";
const caseBProject = process.env["PAPERTEAM_M146_CASEB_PROJECT"] ?? "D:\\PaperTeamData\\M14_5\\projects-caseB\\p-7fb5ffbec963";
const outDir = process.env["PAPERTEAM_M146_OUT"] ?? "D:\\PaperTeamData\\M14_6\\smoke";
const ledgerPath = process.env["PAPERTEAM_M146_GLOBAL_LEDGER"] ?? "D:\\PaperTeamData\\M14_6\\m146-global-budget.json";

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

describe.skipIf(!live)("M14.6 Smoke D — 真实 Revision 保留已确认事实", () => {
  let adapter: PiRuntimeAdapter | undefined;
  afterAll(async () => {
    await adapter?.close().catch(() => undefined);
  });

  it("合法意见（弱化『远大于开销』）→ Writer 修订 → 75.37% 保留、无裸百分号、无元注记", { timeout: 600_000 }, async () => {
    const runtimeRoot = process.env["PAPERTEAM_M146_RUNTIME_ROOT"] ?? join(process.env["USERPROFILE"] ?? process.env["HOME"] ?? tmpdir(), ".paperteam");
    const agentDir = join(runtimeRoot, "runtime", "pi", "agent");
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
    await registerStoredCustomProviders(modelRuntime, new CustomProviderStore({ settingsDir: join(runtimeRoot, "settings") }), () => {});
    const startupSpec = await resolveStartupModelSpec(process.env["PAPERTEAM_M146_MODEL"], new ModelSettingsStore({ settingsDir: join(runtimeRoot, "settings") }));
    expect(startupSpec).toBeDefined();
    adapter = new PiRuntimeAdapter({ modelSpec: startupSpec!, agentDir, workspaceRoot: tmpdir(), runTimeoutMs: 300_000, modelRuntime });
    const ledger = new GlobalBudgetLedger(ledgerPath, "m146-revision", { maxCalls: 10, maxTokens: 600_000 });
    const calls: Array<{ prompt: string; output: string; usage?: Record<string, number>; durationMs: number }> = [];
    const target = adapter;
    const counting = new Proxy(target, {
      get(obj, prop) {
        const value = Reflect.get(obj, prop, obj);
        if (prop === "runAgent" && typeof value === "function") {
          return async (input: { task: string }) => {
            ledger.chargeCall();
            const startedAt = Date.now();
            const task = (await (value as (...a: unknown[]) => Promise<unknown>).apply(obj, [input])) as { output?: string; usage?: Record<string, number> };
            ledger.chargeUsage(task.usage);
            calls.push({ prompt: input.task, output: task.output ?? "", ...(task.usage !== undefined ? { usage: task.usage } : {}), durationMs: Date.now() - startedAt });
            return task;
          };
        }
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(obj) : value;
      },
    }) as unknown as AgentRuntime;

    const facts = (JSON.parse(await readFile(join(caseBProject, "research", "scientific-facts.json"), "utf8")) as { facts: ScientificFact[] }).facts.map(toFactView).filter((f) => f.verification === "author_confirmed");
    const current = await readFile(join(caseBProject, "manuscript-thesis", "revisions", "rev-1", "sections", "exp-tracking-results.tex"), "utf8");
    const outline = JSON.parse(await readFile(join(caseBProject, "manuscript-thesis", "revisions", "rev-1", "outline.json"), "utf8")) as import("../../src/manuscript/ManuscriptService.js").Outline;
    const section = outline.sections.find((entry) => entry.file === "exp-tracking-results.tex");
    expect(section).toBeDefined();
    const issue: ReviewIssue = {
      category: "fact",
      severity: "major",
      section: "sections/exp-tracking-results.tex",
      description: "「误差降低 75.37% 的幅度表明前瞻性补偿收益远大于额外计算与信息交换开销」为效益对比性结论，未核验任何开销对比数据。",
      suggestedAction: "删除或弱化「远大于开销」的对比性判断，保留误差降低事实本身。",
      reason: "开销对比无数据支撑；75.37% 本身属已确认事实，不得删除。",
      evidenceRequirement: "required",
      blocking: false,
    };
    const discipline = [
      "【学位论文修订纪律】本次修订对象是学位论文章节，科研事实纪律与写作阶段完全一致：",
      `本章「实时轨迹跟踪实验与结果分析」的实验指标/参数/数据集数值只能来自以下作者已确认事实（共 ${facts.length} 条）：`,
      ...facts.map((fact) => renderResearchFactLine(fact)),
      "修订只允许改善语言、结构、逻辑衔接；禁止改动上述数值（含等价换算须保持原值口径）、禁止删除上述数值、禁止新增任何未列出的具体实验数值、禁止把待确认或冲突数值写成定论。",
      "审稿意见若以「无实验数据 / 未授权 / 仅见于外部来源」为由要求删除或弱化上述数值，该意见不成立：上表事实经来源核验并由作者确认，是本论文合法的实验数据来源；不得据此删值或改为定性表述。",
    ].join("\n");

    const writer = new WriterService({ runtime: counting, agentId: "writer" });
    const result = await writer.reviseSection({
      projectId: "p-m146-revision-smoke",
      section: section!,
      outline,
      currentLatex: current,
      issues: [issue],
      evidence: [],
      bibliography: [],
      language: "zh",
      extraInstructions: discipline,
    });
    const after = result.latex;
    const removed = detectConfirmedFactRemoval(current, after, facts);
    const metaNotes = detectWorkflowMetaNotes(after).filter((hit) => hit.confidence === "high");
    const verdict = {
      beforeChars: current.length,
      afterChars: after.length,
      removedFacts: removed,
      has7537: after.includes("75.37"),
      count7537Before: (current.match(/75\.37/g) ?? []).length,
      count7537After: (after.match(/75\.37/g) ?? []).length,
      barePercentAfter: countBarePercentAfterDigits(after),
      stillHasComparativeClaim: /远大于/.test(after),
      metaNoteHits: metaNotes.map((hit) => hit.sentence.slice(0, 80)),
      calls: calls.length,
    };
    console.log(`[m146-revision] ${JSON.stringify(verdict)}`);
    await mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const outPath = join(outDir, `revision-${stamp}.json`);
    await writeFile(outPath, JSON.stringify({ model: startupSpec, issue, discipline, before: current, after, verdict, calls: calls.map((call) => ({ ...call, promptChars: call.prompt.length })), budget: ledger.snapshot(), finishedAt: new Date().toISOString() }, null, 2), "utf8");
    console.log(`[m146-revision] 产物：${outPath}；账本 calls=${ledger.snapshot().totals.calls}`);

    expect(removed, "已确认事实不得被修订删除").toEqual([]);
    expect(verdict.has7537).toBe(true);
    // 被弱化 / 删除的对比句本身含一次 75.37%（「误差降低 75.37% 的幅度表明…远大于…」）——删句不等于删事实：
    // 事实表面在节内仍至少保留一次（detectConfirmedFactRemoval 为空已断言）；首跑实录 3 → 2
    expect(verdict.count7537After).toBeGreaterThanOrEqual(1);
    expect(verdict.barePercentAfter).toBe(0);
    expect(metaNotes).toHaveLength(0);
    expect(calls.length).toBeLessThanOrEqual(3);
  });
});
