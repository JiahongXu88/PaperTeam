/**
 * ManuscriptService + 分节写作测试（M3.1）：
 * 大纲校验、main.tex \input 组装、章节状态、references.bib 生成、
 * Derived Context（context.yaml）可重建、WriterService 分节输出校验。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import {
  ManuscriptService,
  validateOutline,
  type Outline,
} from "../../src/manuscript/ManuscriptService.js";
import { collectLatexFiles } from "../../src/manuscript/LatexFiles.js";
import { WriterService } from "../../src/writer/WriterService.js";
import { EvidenceStore } from "../../src/evidence/EvidenceStore.js";
import type { AgentRuntime, AgentTask } from "../../src/runtime/types.js";

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function newProject(): Promise<{ store: ProjectStore; manuscript: ManuscriptService; projectId: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-ms-"));
  tempRoots.push(root);
  const store = new ProjectStore({ root });
  const project = await store.create("手稿测试");
  return { store, manuscript: new ManuscriptService(store), projectId: project.id, root };
}

const OUTLINE: Outline = {
  title: "小语料 RAG 评估",
  abstract: "提出评估协议。",
  sections: [
    { id: "introduction", file: "introduction.tex", title: "引言" },
    { id: "method", file: "method.tex", title: "方法" },
    { id: "conclusion", file: "conclusion.tex", title: "结论" },
  ],
};

describe("validateOutline", () => {
  it("合法大纲通过；节数不足 / 非法文件名 / 重复 id 拒绝", () => {
    expect(validateOutline(OUTLINE)).toEqual([]);
    expect(validateOutline({ ...OUTLINE, sections: OUTLINE.sections.slice(0, 2) })).not.toEqual([]);
    expect(
      validateOutline({
        ...OUTLINE,
        sections: [{ id: "a", file: "../evil.tex", title: "T" }, ...OUTLINE.sections],
      }),
    ).not.toEqual([]);
    expect(
      validateOutline({
        ...OUTLINE,
        sections: [
          ...OUTLINE.sections,
          { id: "introduction", file: "intro2.tex", title: "重复 id" },
        ],
      }),
    ).not.toEqual([]);
  });
});

describe("ManuscriptService", () => {
  it("saveOutline + writeMainTex：main.tex \\input 全部章节；有文献时含 bibliography", async () => {
    const { manuscript, projectId } = await newProject();
    await manuscript.saveOutline(projectId, OUTLINE);
    await manuscript.writeBibliography(projectId, [
      { key: "gao2023survey", title: "RAG Survey", authors: ["Gao"], year: 2023 },
    ]);
    await manuscript.writeMainTex(projectId, OUTLINE, true);

    const main = await readFile(mainPath(manuscript, projectId), "utf8");
    expect(main).toContain("\\documentclass[UTF8]{ctexart}");
    expect(main).toContain("\\input{sections/introduction}");
    expect(main).toContain("\\input{sections/method}");
    expect(main).toContain("\\input{sections/conclusion}");
    expect(main).toContain("\\bibliography{references}");

    const bib = await readFile(join(projectRoot(manuscript, projectId), "manuscript", "references.bib"), "utf8");
    expect(bib).toContain("@article{gao2023survey,");
    expect(bib).toContain("title = {RAG Survey}");
  });

  it("writeSection 落盘 + sectionStatuses 反映事实状态", async () => {
    const { manuscript, projectId } = await newProject();
    await manuscript.saveOutline(projectId, OUTLINE);
    await manuscript.writeSection(projectId, OUTLINE.sections[0]!, "\\section{引言}\n内容。");
    await manuscript.writeSection(projectId, OUTLINE.sections[1]!, "\\section{方法}\n内容。");

    let statuses = await manuscript.sectionStatuses(projectId);
    expect(statuses.find((s) => s.id === "introduction")?.nonEmpty).toBe(true);
    expect(statuses.find((s) => s.id === "conclusion")?.exists).toBe(false);

    await manuscript.writeSection(projectId, OUTLINE.sections[2]!, "\\section{结论}\n总结。");
    statuses = await manuscript.sectionStatuses(projectId);
    expect(statuses.every((status) => status.nonEmpty)).toBe(true);
  });

  it("Derived Context：context.yaml 可从事实来源重建（删除后 rebuild 内容等价）", async () => {
    const { store, manuscript, projectId } = await newProject();
    const evidence = new EvidenceStore(store);
    await evidence.append(projectId, { claim: "证据 1" }, "researcher");
    await manuscript.saveOutline(projectId, OUTLINE);
    await manuscript.writeSection(projectId, OUTLINE.sections[0]!, "\\section{引言}\n内容。");

    const first = await manuscript.rebuildContext(projectId, {
      evidenceStats: await evidence.stats(projectId),
    });
    expect(first).toContain("Derived Context");
    expect(first).toContain("introduction");

    // 删除后重建（Derived ≠ authoritative）
    await rm(manuscript.contextPath(projectId), { force: true });
    const second = await manuscript.rebuildContext(projectId, {
      evidenceStats: await evidence.stats(projectId),
    });
    expect(second).toContain("outline:");
    expect(second).toContain("evidence:");
    // 除时间戳外内容一致
    const strip = (text: string) => text.replace(/generatedAt: .*/g, "");
    expect(strip(second)).toBe(strip(first));
  });
});

describe("collectLatexFiles（\\input 递归收集）", () => {
  it("沿 \\input 收集章节与 bib；缺失文件记入 warnings 不中断", async () => {
    const { manuscript, projectId } = await newProject();
    const dir = join(projectRoot(manuscript, projectId), "manuscript");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "sections"), { recursive: true });
    await writeFile(
      join(dir, "main.tex"),
      [
        "\\documentclass{ctexart}",
        "\\begin{document}",
        "\\input{sections/introduction}",
        "\\input{sections/missing}",
        "\\bibliography{references}",
        "\\end{document}",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(dir, "sections", "introduction.tex"), "如 \\cite{a} 所示。", "utf8");
    await writeFile(join(dir, "references.bib"), "@article{a, title={A}, year={2020}}", "utf8");

    const files = await collectLatexFiles(dir);
    expect(files.mainTex?.relativePath).toBe("main.tex");
    expect(files.allTex.map((file) => file.relativePath)).toEqual([
      "main.tex",
      "sections/introduction.tex",
    ]);
    expect(files.bibPath).toBe("references.bib");
    expect(files.bibContent).toContain("@article{a,");
    expect(files.warnings.some((warning) => warning.includes("missing.tex"))).toBe(true);
  });

  it("路径穿越引用被拦截（不越出 manuscript 目录）", async () => {
    const { manuscript, projectId } = await newProject();
    const dir = join(projectRoot(manuscript, projectId), "manuscript");
    await writeFile(
      join(dir, "main.tex"),
      "\\input{../../etc/passwd}\n正文",
      "utf8",
    );
    const files = await collectLatexFiles(dir);
    expect(files.allTex).toHaveLength(1); // 只有 main.tex
    expect(files.warnings.length).toBeGreaterThan(0);
  });
});

// ---- WriterService 分节输出校验 ----

function runtimeReturning(output: string): AgentRuntime {
  return {
    provider: "pi",
    healthCheck: async () => ({
      ok: true,
      provider: "pi",
      status: "healthy",
      detail: "ok",
      latencyMs: 1,
      checkedAt: new Date().toISOString(),
    }),
    startAgent: async (input) => {
      const now = new Date().toISOString();
      const task: AgentTask = {
        taskId: "run-w",
        agentId: input.agentId,
        status: "completed",
        createdAt: now,
        updatedAt: now,
        output,
      };
      return {
        taskId: task.taskId,
        sessionKey: `agent:${input.agentId}:paperteam-fake`,
        events: async function* () {},
        cancel: async () => {},
        result: async () => task,
      };
    },
    runAgent: async (input) => {
      const now = new Date().toISOString();
      const task: AgentTask = {
        taskId: "run-w",
        agentId: input.agentId,
        status: "completed",
        createdAt: now,
        updatedAt: now,
        output,
      };
      return task;
    },
    getTask: () => {
      throw new Error("not implemented");
    },
    close: async () => {},
  };
}

describe("WriterService（分节）", () => {
  const writer = (output: string) => new WriterService({ runtime: runtimeReturning(output), agentId: "writer", log: () => {} });

  it("合法片段通过；返回完整文档骨架 / 花括号不配对 / 空输出被拒绝", async () => {
    const ok = await writer("\\section{引言}\n如 \\cite{g} 所示 {有序列表}。").writeSection({
      projectId: "p-x",
      section: { id: "introduction", file: "introduction.tex", title: "引言" },
      outline: OUTLINE,
      evidence: [],
      bibliography: [],
    });
    expect(ok.latex).toContain("\\section");

    await expect(
      writer("\\documentclass{ctexart}\\begin{document}x\\end{document}").writeSection({
        projectId: "p-x",
        section: { id: "a", file: "a.tex", title: "A" },
        outline: OUTLINE,
        evidence: [],
        bibliography: [],
      }),
    ).rejects.toMatchObject({ code: "INVALID_LATEX_OUTPUT" });

    await expect(
      writer("\\section{引言}{ 未闭合").writeSection({
        projectId: "p-x",
        section: { id: "a", file: "a.tex", title: "A" },
        outline: OUTLINE,
        evidence: [],
        bibliography: [],
      }),
    ).rejects.toMatchObject({ code: "INVALID_LATEX_OUTPUT" });

    await expect(
      writer("   ").writeSection({
        projectId: "p-x",
        section: { id: "a", file: "a.tex", title: "A" },
        outline: OUTLINE,
        evidence: [],
        bibliography: [],
      }),
    ).rejects.toMatchObject({ code: "AGENT_RUN_FAILED" });
  });

  it("planOutline：输出经围栏包裹也能解析并校验（少于 3 节被拒）", async () => {
    const outlineJson = JSON.stringify({
      title: "T",
      sections: [
        { id: "introduction", file: "introduction.tex", title: "引言" },
        { id: "method", file: "method.tex", title: "方法" },
        { id: "conclusion", file: "conclusion.tex", title: "结论" },
      ],
    });
    const outline = await writer(`\`\`\`json\n${outlineJson}\n\`\`\``).planOutline({
      projectId: "p-x",
      researchDigest: {
        domainOverview: "概述",
        researchGaps: ["gap"],
        potentialContributions: ["c"],
      },
      evidence: [],
      bibliography: [],
    });
    expect(outline.sections).toHaveLength(3);

    const tooFew = JSON.stringify({
      title: "T",
      sections: [{ id: "a", file: "a.tex", title: "A" }],
    });
    await expect(
      writer(tooFew).planOutline({
        projectId: "p-x",
        researchDigest: { domainOverview: "o", researchGaps: [], potentialContributions: [] },
        evidence: [],
        bibliography: [],
      }),
    ).rejects.toMatchObject({ code: "INVALID_LATEX_OUTPUT" });
  });
});

// ---- 路径辅助（测试内取项目根） ----

function projectRoot(manuscript: ManuscriptService, projectId: string): string {
  // ManuscriptService 不暴露根路径；通过 outlinePath 反推
  return join(manuscript.outlinePath(projectId), "..", "..");
}

function mainPath(manuscript: ManuscriptService, projectId: string): string {
  return join(projectRoot(manuscript, projectId), "manuscript", "main.tex");
}
