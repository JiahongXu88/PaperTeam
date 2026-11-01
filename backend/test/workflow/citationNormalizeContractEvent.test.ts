/**
 * M15 长程 E2（真实运行暴露的同根因修复）：确定性引用语法归一的写入必须进入编辑契约事件（candidate_accepted + appliedHash），
 * 否则修订 lineage 无法从事件审计追溯（真实运行 w-bb298c6e52fc：rev-2 的 4 个文件改动只有 registry 登记、无事件）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { EditContractEvent } from "../../src/quality/editContractStore.js";
import { revisionSourceHash } from "../../src/review/revisionScope.js";
import { normalizeManuscriptCitationSyntax } from "../../src/workflow/definitions.js";
import { ValidatedWriteRegistry } from "../../src/workflow/editContractEnforcement.js";
import { scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";

vi.setConfig({ testTimeout: 60_000 });

let t: TestStack;
afterAll(async () => t?.cleanup());

describe("引用语法归一 → 契约事件", () => {
  it("归一写入经契约校验后记录 candidate_accepted（appliedHash = 落盘内容哈希）；数值守恒", async () => {
    t = await startTestStack(scriptedIdeaRuntime().runtime);
    const project = await t.store.create("归一事件", {});
    const dir = t.store.manuscriptDir(project.id);
    await mkdir(join(dir, "sections"), { recursive: true });
    await writeFile(join(dir, "main.tex"), "\\documentclass{article}\\begin{document}\\input{sections/intro}\\bibliography{references}\\end{document}\n", "utf8");
    await writeFile(join(dir, "sections", "intro.tex"), "\\section{Intro}\nWe reach 28.4 BLEU \\cite{a, b}.\n", "utf8");
    await writeFile(join(dir, "references.bib"), "@article{a, title={A}, year={2020}}\n@article{b, title={B}, year={2021}}\n", "utf8");
    const events: EditContractEvent[] = [];
    const registry = new ValidatedWriteRegistry();
    const result = await normalizeManuscriptCitationSyntax(t.stack.workflowServices, project.id, { registry, runId: "w-1", events });
    const written = await readFile(join(dir, "sections", "intro.tex"), "utf8");
    expect(result.fixed).toBeGreaterThan(0);
    expect(written).toContain("\\cite{a,b}");
    expect(written).toContain("28.4");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "candidate_accepted", stageId: "revision.citation_syntax_normalize", appliedHash: revisionSourceHash(written) });
    expect(registry.matches("sections/intro.tex", written)).toBe(true);
  });
});
