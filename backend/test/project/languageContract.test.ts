/**
 * M9.7.4 P0-1 Project Language Contract 测试。
 *
 * 覆盖：
 * 1. zh project → zh prompt 注入 + zh skill 路由不过滤
 * 2. en project → en prompt 注入 + zh-only skill 被剔除 + style 文案语言化
 * 3. legacy（language 缺失 / 无法识别）→ 不注入语言行、skill 不过滤（现状默认）
 */

import { describe, expect, it } from "vitest";

import {
  languageDisplayName,
  normalizeManuscriptLanguage,
  targetLanguageLines,
} from "../../src/project/language.js";
import type { ProjectMetadata } from "../../src/project/ProjectStore.js";
import { buildResearchPrompt } from "../../src/agents/ResearcherService.js";
import { buildReviewPrompt } from "../../src/agents/ReviewerService.js";
import { buildOutlinePrompt, buildSectionPrompt } from "../../src/writer/WriterService.js";
import { resolveSkillIds, ZH_ONLY_SKILL_IDS } from "../../src/skills/routing.js";

function projectOf(language: string | undefined): ProjectMetadata {
  return {
    schemaVersion: 1,
    id: "p-test",
    title: "Test Project",
    createdAt: "2026-09-23T00:00:00Z",
    updatedAt: "2026-09-23T00:00:00Z",
    status: "created",
    ...(language !== undefined ? { language } : {}),
  };
}

const OUTLINE_ARGS: Parameters<typeof buildOutlinePrompt>[0] = {
  researchDigest: {
    domainOverview: "领域现状",
    researchGaps: ["gap"],
    potentialContributions: ["contribution"],
  },
  evidence: [],
  bibliography: [],
};

const SECTION_ARGS = {
  section: { id: "intro", file: "introduction.tex", title: "Introduction" },
  outline: { title: "Paper", sections: [] },
  evidence: [],
  bibliography: [],
} as unknown as Parameters<typeof buildSectionPrompt>[0];

const REVIEW_ARGS: { projectId: string; manuscriptDigest: string; evidence: [] } = {
  projectId: "p-test",
  manuscriptDigest: "digest",
  evidence: [],
};

describe("normalizeManuscriptLanguage", () => {
  it("识别常见中文写法", () => {
    for (const value of ["Chinese", "chinese", "中文", "汉语", "zh", "ZH", "zh-CN", "zh-hans", "Simplified Chinese"]) {
      expect(normalizeManuscriptLanguage(value)).toBe("zh");
    }
  });

  it("识别常见英文写法", () => {
    for (const value of ["English", "english", "英文", "英语", "en", "EN", "en-US", "en_gb"]) {
      expect(normalizeManuscriptLanguage(value)).toBe("en");
    }
  });

  it("缺失 / 空串 / 无法识别 → undefined（legacy 语义）", () => {
    expect(normalizeManuscriptLanguage(undefined)).toBeUndefined();
    expect(normalizeManuscriptLanguage("")).toBeUndefined();
    expect(normalizeManuscriptLanguage("  ")).toBeUndefined();
    expect(normalizeManuscriptLanguage("Klingon")).toBeUndefined();
    expect(normalizeManuscriptLanguage("翻译成法语")).toBeUndefined();
  });

  it("languageDisplayName / targetLanguageLines 确定性", () => {
    expect(languageDisplayName("zh")).toContain("中文");
    expect(languageDisplayName("en")).toContain("English");
    expect(targetLanguageLines(undefined)).toEqual([]);
    expect(targetLanguageLines("zh")[0]).toContain("中文");
    expect(targetLanguageLines("en")[0]).toContain("English");
  });
});

describe("Language Contract：prompt 注入", () => {
  it("zh project → Research/Outline/Section prompt 均携带中文写作语言指令", () => {
    const research = buildResearchPrompt(projectOf("Chinese"), "(文献库摘要)");
    expect(research).toContain("写作语言（不可违反）：中文");

    const outline = buildOutlinePrompt({ ...OUTLINE_ARGS, language: "zh" });
    expect(outline).toContain("写作语言（不可违反）：中文");

    const section = buildSectionPrompt({ ...SECTION_ARGS, language: "zh" });
    expect(section).toContain("写作语言（不可违反）：中文");
  });

  it("en project → 各 prompt 携带 English 指令；style review 文案为英文版", () => {
    const research = buildResearchPrompt(projectOf("English"), "(library digest)");
    expect(research).toContain("Writing language (must be followed): English");

    const outline = buildOutlinePrompt({ ...OUTLINE_ARGS, language: "en" });
    expect(outline).toContain("Writing language (must be followed): English");

    const section = buildSectionPrompt({ ...SECTION_ARGS, language: "en" });
    expect(section).toContain("Writing language (must be followed): English");

    const review = buildReviewPrompt({ ...REVIEW_ARGS, mode: "style", language: "en" });
    expect(review).toContain("Manuscript language: English");
    expect(review).toContain("academic writing quality, NOT AI detection");
    expect(review).not.toContain("中文学术表达质量");

    // fact / academic 指令保持中文（M9.7.3 实测可正常工作），但要求 finding 跟随稿件语言
    const fact = buildReviewPrompt({ ...REVIEW_ARGS, mode: "fact", language: "en" });
    expect(fact).toContain("Manuscript language: English");
    expect(fact).toContain("Write the \"summary\"");
  });

  it("legacy（无 language）→ prompts 不含语言指令行（零行为变化）", () => {
    const research = buildResearchPrompt(projectOf(undefined), "(文献库摘要)");
    expect(research).not.toContain("写作语言");
    expect(research).not.toContain("Writing language");

    const outline = buildOutlinePrompt({ ...OUTLINE_ARGS });
    expect(outline).not.toContain("写作语言");
    expect(outline).not.toContain("Writing language");

    const section = buildSectionPrompt({ ...SECTION_ARGS });
    expect(section).not.toContain("Writing language");

    const review = buildReviewPrompt({ ...REVIEW_ARGS, mode: "style" });
    expect(review).not.toContain("Manuscript language");
    expect(review).toContain("中文学术表达质量");
  });
});

describe("Language Contract：skill 路由", () => {
  it("zh / undefined → zh-only skill 照常注入（现状默认）", () => {
    expect(resolveSkillIds("writer", "writing/sections", "zh")).toEqual(["academic-writing-zh"]);
    expect(resolveSkillIds("reviewer", "review/style", "zh")).toEqual(["academic-style-zh"]);
    // legacy：不过滤
    expect(resolveSkillIds("writer", "writing/sections")).toEqual(["academic-writing-zh"]);
    expect(resolveSkillIds("reviewer", "review/style")).toEqual(["academic-style-zh"]);
  });

  it("en → zh-only skill 全部剔除（writer 写作 / reviewer style / style-polish）", () => {
    expect(resolveSkillIds("writer", "writing/outline", "en")).toEqual([]);
    expect(resolveSkillIds("writer", "writing/sections", "en")).toEqual([]);
    expect(resolveSkillIds("writer", "writing/revision", "en")).toEqual([]);
    expect(resolveSkillIds("writer", "writing/style-polish", "en")).toEqual([]);
    expect(resolveSkillIds("reviewer", "review/style", "en")).toEqual([]);
    // 语言无关 skill 不受影响
    expect(resolveSkillIds("reviewer", "review/academic", "en")).toEqual(["academic-review"]);
    expect(resolveSkillIds("reviewer", "review/fact", "en")).toEqual(["verify-citations"]);
    expect(resolveSkillIds("researcher", "research", "en")).toEqual(["paper-search"]);
    expect(resolveSkillIds("citation", "citation/verify", "en")).toEqual(["paper-search", "verify-citations"]);
  });

  it("ZH_ONLY_SKILL_IDS 恰为 seed 中的两个 zh-only skill", () => {
    expect(ZH_ONLY_SKILL_IDS).toEqual(["academic-writing-zh", "academic-style-zh"]);
  });
});
