/**
 * M14.6 Smoke C — 学位论文双语摘要生成（env 门控：PAPERTEAM_M146_ABSTRACT_SMOKE=1；默认跳过，不进 CI）。
 *
 * 用案例 B（M14.5 run2）rev-2 的 16 节真实正文 + 已确认 11 条事实 + 8 条贡献 + 主线 →
 * ThesisAbstractService.generate（1 次调用 + ≤1 次修复）→ 确定性事实守卫 checkThesisAbstractFacts。
 * 断言：零阻断违规（摘要数值必须出自事实表 / 正文；中英文数值一致；无 LaTeX / 元注记；关键词 3–6）；
 * 若首轮违规、修复后仍违规 → 测试失败并保留全部证据（不为过关放宽守卫）。
 * 额外：75.37% 若出现在摘要中，中英文须同时出现；held-out 独有主题不得以完成时态出现。
 *
 * 运行：PAPERTEAM_M146_ABSTRACT_SMOKE=1 PAPERTEAM_M146_MODEL=zai-coding-cn/glm-5.3 npx vitest run test/thesis/m146Abstract.smoke.test.ts
 * 产物：D:\PaperTeamData\M14_6\smoke\abstract-<ts>.json
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiRuntimeAdapter } from "../../src/runtime/PiRuntimeAdapter.js";
import type { AgentRuntime } from "../../src/runtime/types.js";
import { CustomProviderStore } from "../../src/settings/CustomProviderStore.js";
import { registerStoredCustomProviders } from "../../src/settings/ModelSettingsService.js";
import { ModelSettingsStore, resolveStartupModelSpec } from "../../src/settings/ModelSettingsStore.js";
import { ThesisAbstractService, checkThesisAbstractFacts, type ThesisAbstractInput } from "../../src/thesis/thesisAbstract.js";
import type { ChapterMappingFile, ThesisContributionFile, ThesisStorylineFile } from "../../src/thesis/thesisWorkflowTypes.js";
import type { FactView, ScientificFact } from "../../src/thesis/researchInputTypes.js";
import { describeFactLocation } from "../../src/thesis/tableAlignment.js";
import { GlobalBudgetLedger } from "../helpers/globalBudgetLedger.js";

const live = process.env["PAPERTEAM_M146_ABSTRACT_SMOKE"] === "1";
const caseBProject = process.env["PAPERTEAM_M146_CASEB_PROJECT"] ?? "D:\\PaperTeamData\\M14_5\\projects-caseB\\p-7fb5ffbec963";
const revision = process.env["PAPERTEAM_M146_CASEB_REVISION"] ?? "rev-2";
const outDir = process.env["PAPERTEAM_M146_OUT"] ?? "D:\\PaperTeamData\\M14_6\\smoke";
const ledgerPath = process.env["PAPERTEAM_M146_GLOBAL_LEDGER"] ?? "D:\\PaperTeamData\\M14_6\\m146-global-budget.json";

const HELDOUT_ONLY_TOPICS = ["分布式编队", "六自由度", "ROS", "参数辨识", "Minimum Snap", "微分平坦", "悬停油门", "多机仿真"];
const DONE_TENSE = /(已|已经)(完成|开展|实现|建立|搭建|进行|给出)/;

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

describe.skipIf(!live)("M14.6 Smoke C — 双语摘要生成（案例 B rev-2 真实正文）", () => {
  let adapter: PiRuntimeAdapter | undefined;
  afterAll(async () => {
    await adapter?.close().catch(() => undefined);
  });

  it("generate：事实守卫零违规；中英文数值一致；无虚构数值", { timeout: 900_000 }, async () => {
    const runtimeRoot = process.env["PAPERTEAM_M146_RUNTIME_ROOT"] ?? join(process.env["USERPROFILE"] ?? process.env["HOME"] ?? tmpdir(), ".paperteam");
    const agentDir = join(runtimeRoot, "runtime", "pi", "agent");
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
    await registerStoredCustomProviders(modelRuntime, new CustomProviderStore({ settingsDir: join(runtimeRoot, "settings") }), () => {});
    const startupSpec = await resolveStartupModelSpec(process.env["PAPERTEAM_M146_MODEL"], new ModelSettingsStore({ settingsDir: join(runtimeRoot, "settings") }));
    expect(startupSpec).toBeDefined();
    adapter = new PiRuntimeAdapter({ modelSpec: startupSpec!, agentDir, workspaceRoot: tmpdir(), runTimeoutMs: 300_000, modelRuntime });
    const ledger = new GlobalBudgetLedger(ledgerPath, "m146-abstract", { maxCalls: 10, maxTokens: 600_000 });
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

    const read = async <T,>(rel: string): Promise<T> => JSON.parse(await readFile(join(caseBProject, rel), "utf8")) as T;
    const mapping = await read<ChapterMappingFile>("research/chapter-mapping.json");
    const contributions = (await read<ThesisContributionFile>("research/thesis-contributions.json")).items.filter((item) => item.status === "confirmed");
    const storyline = (await read<ThesisStorylineFile>("research/thesis-storyline.json")).storyline;
    const facts = (await read<{ facts: ScientificFact[] }>("research/scientific-facts.json")).facts.map(toFactView).filter((f) => f.verification === "author_confirmed");
    const outline = await read<{ title: string; sections: Array<{ file: string; title: string }> }>(`manuscript-thesis/revisions/${revision}/outline.json`);
    const sectionsDir = join(caseBProject, "manuscript-thesis", "revisions", revision, "sections");
    const files = (await readdir(sectionsDir)).filter((name) => name.endsWith(".tex"));
    const sections: Array<{ file: string; chapterId: string; title: string; content: string }> = [];
    for (const chapter of mapping.chapters) {
      for (const file of chapter.sectionFiles) {
        if (!files.includes(file)) continue;
        sections.push({ file, chapterId: chapter.chapterId, title: outline.sections.find((section) => section.file === file)?.title ?? file, content: await readFile(join(sectionsDir, file), "utf8") });
      }
    }
    expect(sections.length).toBeGreaterThanOrEqual(10);
    const input: ThesisAbstractInput = {
      projectTitle: "基于神经网络下洗预测的四旋翼近距飞行非线性模型预测控制研究（案例 B 第三方公开案例研究验证 Draft）",
      documentType: "master_thesis",
      language: "zh",
      storyline,
      chapters: mapping.chapters.map((chapter) => ({ ...chapter, limitationMode: false })),
      contributions,
      confirmedFacts: facts,
      sections,
    };

    const service = new ThesisAbstractService({ runtime: counting, agentId: "writer", log: (message) => console.log(message) });
    const result = await service.generate(input, { projectId: "p-m146-abstract-smoke", maxRepairAttempts: 1 });
    const recheck = checkThesisAbstractFacts(result.draft, input);
    const zhHas7537 = result.draft.abstractZh.includes("75.37");
    const enHas7537 = result.draft.abstractEn.includes("75.37");
    const heldout = HELDOUT_ONLY_TOPICS.filter((topic) => result.draft.abstractZh.includes(topic)).map((topic) => ({ topic, doneTense: DONE_TENSE.test(result.draft.abstractZh) }));
    console.log(`[m146-abstract] attempts=${result.attempts} violations=${result.violations.length} advisories=${result.advisories.length} zhChars=${result.draft.abstractZh.length} enWords=${result.draft.abstractEn.split(/\s+/).filter(Boolean).length} kw=${result.draft.keywordsZh.length}/${result.draft.keywordsEn.length} 75.37 zh=${zhHas7537} en=${enHas7537}`);
    for (const violation of result.violations) console.log(`  [violation] ${violation.code}: ${violation.detail}`);
    for (const advisory of result.advisories) console.log(`  [advisory] ${advisory.code}: ${advisory.detail}`);
    console.log(`  [zh] ${result.draft.abstractZh.slice(0, 300)}`);
    console.log(`  [en] ${result.draft.abstractEn.slice(0, 300)}`);
    console.log(`  [kw] ${result.draft.keywordsZh.join("；")} | ${result.draft.keywordsEn.join("; ")}`);

    await mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const outPath = join(outDir, `abstract-${stamp}.json`);
    await writeFile(outPath, JSON.stringify({ model: startupSpec, caseBProject, revision, inputSummary: { sections: sections.length, confirmedFacts: facts.length, contributions: contributions.length }, result, recheck, heldout, calls: calls.map((call) => ({ ...call, promptChars: call.prompt.length })), budget: ledger.snapshot(), finishedAt: new Date().toISOString() }, null, 2), "utf8");
    console.log(`[m146-abstract] 产物：${outPath}；账本 calls=${ledger.snapshot().totals.calls}`);

    expect(result.violations, "事实守卫阻断违规必须为 0（不为过关放宽守卫）").toHaveLength(0);
    expect(recheck.ok).toBe(true);
    expect(zhHas7537).toBe(enHas7537);
    expect(result.draft.keywordsZh.length).toBeGreaterThanOrEqual(3);
    expect(result.draft.keywordsEn.length).toBeGreaterThanOrEqual(3);
    for (const entry of heldout) expect(entry.doneTense, `摘要把 held-out 主题「${entry.topic}」写成已完成`).toBe(false);
    expect(calls.length).toBeLessThanOrEqual(2);
  });
});
