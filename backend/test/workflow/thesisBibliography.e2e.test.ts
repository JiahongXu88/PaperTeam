/**
 * M14.6 — 学位论文正式 Evidence → 引用 → references.bib → 装配 → citation.verify 闭环 E2E（确定性）。
 *
 * M14.5 真实案例 B：testStack 缺省禁用全部学术 provider → thesis.evidence_supply 降级 → 正式 Evidence 0 →
 * Writer 无可引用 key → citedCount=0 且 hallucinated=0 被当作「引用无问题」。本测试证明：
 *   当项目已有**正式 Evidence**（verified + sourceId + chunk 锚点；来源元数据为 Crossref 实时核验过的
 *   真实 DOI——Hewing 2020 / Shi 2022 / Preiss 2017 / Li 2023）时，thesis_from_papers 的 Writer 得到可引用
 *   key、正文引用、references.bib 同步真实条目、装配产物含 \bibliography、citation.verify citedCount>0 /
 *   missing 0 / hallucinated 0，Gate 规则 thesis_citations_present 通过；同时 thesis.abstract 落盘双语摘要、
 *   装配产物含 \chapter*{摘要} / \chapter*{Abstract} 与 \label{ch:…}，workflow_meta_notes_absent 通过。
 * 真实实时检索（OpenAlex / arXiv 直连）在 m146LiveSearch.smoke 中单独探测；真实 xelatex 编译在
 * m146RealLatex.smoke 中验收。本文件只证明「正式 Evidence 存在时的引用与参考文献闭环」。
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createScriptedRuntime } from "../../src/runtime/scriptedRuntime.js";
import type { AgentRuntime, RunAgentInput, AgentTask } from "../../src/runtime/types.js";
import { startTestStack, type TestStack } from "../helpers/testStack.js";
import { REAL_REFERENCES, runThesisCitationClosure } from "../helpers/thesisCitationFlow.js";

describe("M14.6 thesis 正式 Evidence → 引用 → 参考文献闭环 E2E", () => {
  let stack: TestStack;
  let scripted: ReturnType<typeof createScriptedRuntime>;
  const writerPrompts: string[] = [];

  beforeAll(async () => {
    scripted = createScriptedRuntime({ reviewSequence: ["pass"] });
    const base = scripted.runtime;
    const wrapped: AgentRuntime = {
      ...base,
      runAgent: async (input: RunAgentInput): Promise<AgentTask> => {
        if (input.contextScope === "writing/sections") writerPrompts.push(input.task);
        return base.runAgent(input);
      },
    };
    stack = await startTestStack(wrapped, {
      search: { disabledProviders: ["openalex", "semantic-scholar", "arxiv", "aminer", "searxng"], providerTimeoutMs: 2_000 },
    });
  });

  afterAll(async () => {
    await stack.cleanup();
  });

  it("正式 Evidence 存在 → Writer 引用真实 key → references.bib → \\bibliography → citedCount>0 → Gate 引用规则通过；摘要 + 章标签落盘", { timeout: 240_000 }, async () => {
    const { projectId, run } = await runThesisCitationClosure(stack, "引用闭环学位论文");
    expect(run.status).toBe("completed");

    const projectDir = stack.store.projectDir(projectId);
    // 1) Writer 收到可引用 key（A 组 = 有 verified evidence 支撑）
    expect(writerPrompts.length).toBeGreaterThan(0);
    expect(writerPrompts.some((prompt) => /A 组（有 verified evidence 支撑[^）]*）：\s*\S/.test(prompt))).toBe(true);
    // 2) references.bib 含真实 DOI 条目；正文引用这些 key
    const bib = await readFile(join(projectDir, "manuscript", "references.bib"), "utf8");
    expect(REAL_REFERENCES.filter((ref) => bib.includes(ref.doi)).length).toBeGreaterThan(0);
    expect(bib).not.toMatch(/10\.1234\//); // 无合成 DOI
    const sectionFiles = (await readdir(join(projectDir, "manuscript", "sections"))).filter((name) => name.endsWith(".tex"));
    const sectionsText = (await Promise.all(sectionFiles.map((name) => readFile(join(projectDir, "manuscript", "sections", name), "utf8")))).join("\n");
    const citedKeys = [...new Set([...sectionsText.matchAll(/\\cite\{([^}]+)\}/g)].flatMap((match) => match[1]!.split(",").map((key) => key.trim())))];
    expect(citedKeys.length).toBeGreaterThan(0);
    for (const key of citedKeys) expect(bib).toContain(`{${key},`);
    // 3) 装配产物：\bibliography + 双语摘要 + 章标签
    const mainTex = await readFile(join(projectDir, "manuscript-thesis", "main.tex"), "utf8");
    expect(mainTex).toContain("\\bibliography{references}");
    expect(mainTex).toContain("\\chapter*{摘要}");
    expect(mainTex).toContain("\\chapter*{Abstract}");
    expect(mainTex).toMatch(/\\label\{ch:/);
    const thesisModel = JSON.parse(await readFile(join(projectDir, "manuscript", "thesis.json"), "utf8")) as { abstractZh?: string; abstractEn?: string; keywordsZh?: string[] };
    expect((thesisModel.abstractZh ?? "").length).toBeGreaterThan(100);
    expect((thesisModel.abstractEn ?? "").split(/\s+/).length).toBeGreaterThan(50);
    expect(thesisModel.keywordsZh?.length ?? 0).toBeGreaterThanOrEqual(3);
    // 4) citation.verify：cited>0 / missing 0 / hallucinated 0
    const citationReport = JSON.parse(await readFile(join(projectDir, "reviews", "citation-report.json"), "utf8")) as { summary: { citedCount: number; missingKeys: number; hallucinated: number } };
    expect(citationReport.summary.citedCount).toBeGreaterThan(0);
    expect(citationReport.summary.missingKeys).toBe(0);
    expect(citationReport.summary.hallucinated).toBe(0);
    // 5) Gate：引用规则 / 摘要规则 / 元注记规则
    const gateFiles = (await readdir(join(projectDir, "reviews"))).filter((name) => /^quality-gate-r\d+\.json$/.test(name)).sort();
    const gate = JSON.parse(await readFile(join(projectDir, "reviews", gateFiles[gateFiles.length - 1]!), "utf8")) as { gate: { passed: boolean; rules: Array<{ rule: string; passed: boolean; detail: string }> } };
    const rule = (id: string) => gate.gate.rules.find((entry) => entry.rule === id);
    expect(rule("thesis_citations_present")?.passed, rule("thesis_citations_present")?.detail).toBe(true);
    expect(rule("thesis_citations_present")?.detail).toMatch(/正文引用 \d+ 个 bib key/);
    expect(rule("thesis_abstract_complete")?.passed, rule("thesis_abstract_complete")?.detail).toBe(true);
    expect(rule("workflow_meta_notes_absent")?.passed, rule("workflow_meta_notes_absent")?.detail).toBe(true);
    expect(rule("templated_phrasing_reported")).toBeDefined();
    // 6) thesis.abstract stage 结果与产物
    expect(run.stageResults?.["thesis.abstract"]?.["saved"]).toBe(true);
    const abstractArtifact = JSON.parse(await readFile(join(projectDir, "research", "thesis-abstract.json"), "utf8")) as { saved: boolean; violations: unknown[] };
    expect(abstractArtifact.saved).toBe(true);
    expect(abstractArtifact.violations).toHaveLength(0);
  });
});
