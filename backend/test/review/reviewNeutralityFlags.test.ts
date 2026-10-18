/**
 * M14.9.1：两个实验开关（缺省关闭）的回归。
 * - PAPERTEAM_REVIEW_NEUTRALITY_POLICY：关闭时三路 / 单元 / 跨章 prompt 逐字节不变；开启时追加中立条款；
 * - PAPERTEAM_REVIEW_INPUT_MODE=metadata_blind：digest 视图按字段去掉作者 / 单位 / 邮箱 / 注释，正文
 *   （含「清华大学发布的公开数据集」这类有学术意义的机构名）保持不变；缺省 production 原样；非法值拒绝启动。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { buildReviewPrompt, REVIEW_NEUTRALITY_CLAUSE, ReviewerService } from "../../src/agents/ReviewerService.js";
import { ConfigError, loadConfig } from "../../src/config/config.js";
import type { ProjectStore } from "../../src/project/ProjectStore.js";
import { stripLatexReviewMetadata } from "../../src/review/blindReviewInput.js";
import type { AgentRuntime, RunAgentInput } from "../../src/runtime/types.js";
import { buildManuscriptDigest } from "../../src/workflow/definitions.js";
import { scriptedIdeaRuntime, startTestStack } from "../helpers/testStack.js";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

const SOURCE = [
  "\\documentclass{article}",
  "% 基金项目：待作者确认",
  "\\title{单文件稿件}",
  "\\author{徐某\\thanks{通信作者 E-mail: x@example.edu}\\\\ 某某大学，合肥 230601}",
  "\\begin{document}",
  "\\maketitle",
  "\\section{引言}",
  "实验使用清华大学发布的公开数据集，IDSW 由 700 降至 497。",
  "\\end{document}",
].join("\n");

describe("元数据中立条款（实验开关）", () => {
  const base = { projectId: "p", manuscriptDigest: "正文", evidence: [], targetProfile: "core_journal", language: "zh" as const };
  it("关闭：prompt 不含条款（与不传该键逐字节相同）；开启：三路 prompt 均追加条款", () => {
    for (const mode of ["fact", "academic", "style"] as const) {
      expect(buildReviewPrompt({ ...base, mode, neutralityPolicy: false })).toBe(buildReviewPrompt({ ...base, mode }));
      expect(buildReviewPrompt({ ...base, mode })).not.toContain("中立条款");
      expect(buildReviewPrompt({ ...base, mode, neutralityPolicy: true })).toContain(REVIEW_NEUTRALITY_CLAUSE);
    }
  });

  it("单元 / 跨章 prompt 同样受开关控制", async () => {
    const tasks: string[] = [];
    const runtime = {
      runAgent: async (input: RunAgentInput) => {
        tasks.push(input.task);
        const now = new Date().toISOString();
        return { taskId: "t", agentId: "reviewer", status: "completed", createdAt: now, updatedAt: now, events: [],
          output: JSON.stringify({ summary: "ok", issues: [{ category: "academic", severity: "minor", section: "a", description: "x", relatedSections: ["b"], blocking: false }], academicScore: 70, riskScore: 20 }) };
      },
    } as unknown as AgentRuntime;
    const reviewer = new ReviewerService({ runtime, agentId: "reviewer", projects: {} as ProjectStore });
    const unit = { unitId: "main.tex::sec:a", file: "main.tex", heading: "引言", unitIndex: 1, unitCount: 1, text: "正文" };
    await reviewer.reviewUnit({ projectId: "p", unit, chapterIndex: ["引言"] });
    await reviewer.reviewUnit({ projectId: "p", unit, chapterIndex: ["引言"], neutralityPolicy: true });
    await reviewer.reviewCrossChapter({ projectId: "p", chapters: [{ heading: "a", file: "main.tex", digest: "x" }, { heading: "b", file: "main.tex", digest: "y" }] });
    await reviewer.reviewCrossChapter({ projectId: "p", chapters: [{ heading: "a", file: "main.tex", digest: "x" }, { heading: "b", file: "main.tex", digest: "y" }], neutralityPolicy: true });
    expect(tasks.map((task) => task.includes(REVIEW_NEUTRALITY_CLAUSE))).toEqual([false, true, false, true]);
  });
});

describe("metadata_blind 审稿输入（实验开关）", () => {
  it("stripLatexReviewMetadata：去掉作者 / \\thanks / 注释，保留正文与有学术意义的机构名；行号不漂移", () => {
    const { text, redactions } = stripLatexReviewMetadata(SOURCE);
    expect(text).not.toMatch(/徐某|x@example\.edu|某某大学|230601|基金项目/);
    expect(text).toContain("清华大学发布的公开数据集，IDSW 由 700 降至 497。");
    expect(text.split("\n")).toHaveLength(SOURCE.split("\n").length);
    expect(redactions.map((entry) => entry.kind).sort()).toEqual(["author", "comment"]);
  });

  async function digestWith(inputMode: "production" | "metadata_blind" | undefined) {
    const stack = await startTestStack(scriptedIdeaRuntime().runtime, {
      registerCleanup: (cleanup) => cleanups.push(cleanup),
      ...(inputMode !== undefined ? { review: { inputMode } } : {}),
    });
    const projectId = (await stack.store.create("Digest fixture", { language: "zh" })).id;
    const dir = stack.store.manuscriptDir(projectId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "main.tex"), SOURCE, "utf8");
    return buildManuscriptDigest(stack.stack.workflowServices, projectId);
  }

  it("缺省（production）digest 原样包含作者块；metadata_blind 只去掉身份字段", async () => {
    const production = await digestWith(undefined);
    expect(production).toContain("徐某");
    expect(await digestWith("production")).toBe(production);
    const blind = await digestWith("metadata_blind");
    expect(blind).not.toMatch(/徐某|x@example\.edu|某某大学/);
    expect(blind).toContain("清华大学发布的公开数据集，IDSW 由 700 降至 497。");
  });

  it("配置：缺省 production / false；非法输入模式拒绝启动", () => {
    const config = loadConfig({});
    expect(config.review.inputMode).toBe("production");
    expect(config.review.neutralityPolicy).toBe(false);
    expect(loadConfig({ PAPERTEAM_REVIEW_INPUT_MODE: "metadata_blind", PAPERTEAM_REVIEW_NEUTRALITY_POLICY: "true" }).review).toMatchObject({ inputMode: "metadata_blind", neutralityPolicy: true });
    expect(() => loadConfig({ PAPERTEAM_REVIEW_INPUT_MODE: "blind" })).toThrow(ConfigError);
  });
});

describe("任务级预算配置", () => {
  it("账本路径必须是绝对路径且至少一个上限；缺省不启用", () => {
    expect(loadConfig({}).workflow.globalBudget).toBeUndefined();
    expect(() => loadConfig({ PAPERTEAM_GLOBAL_BUDGET_LEDGER: "relative/ledger.json", PAPERTEAM_GLOBAL_MAX_MODEL_CALLS: "10" })).toThrow(ConfigError);
    expect(() => loadConfig({ PAPERTEAM_GLOBAL_BUDGET_LEDGER: join(process.cwd(), "ledger.json") })).toThrow(ConfigError);
    expect(loadConfig({ PAPERTEAM_GLOBAL_BUDGET_LEDGER: join(process.cwd(), "ledger.json"), PAPERTEAM_GLOBAL_MAX_MODEL_CALLS: "110" }).workflow.globalBudget).toMatchObject({ maxCalls: 110, maxTokens: 0, outputReserveTokens: 16000 });
  });
});
