/**
 * M9.7.4 P1-2 Bibliography Growth Hardening 测试。
 *
 * 覆盖（任务书 §8-14~16）：
 * 14. research 重跑不产生 identity duplicate（同轮内同文献跨 key/跨 title 形态折叠；
 *     重跑 prompt 注入上一轮清单 + 总量纪律）
 * 15. canonical DOI dedupe（DOI 归一形态精确判等——大写/URL 前缀变体折叠）
 * 16. normalized title fallback dedupe（title variant + 年份兼容 → 不与库内成对存活；
 *     artifact 条目有界，source-library 永不因上限被裁）
 */

import { describe, expect, it } from "vitest";

import {
  MAX_ARTIFACT_BIBLIOGRAPHY_ENTRIES,
  buildBibliographyFromSources,
  mergeArtifactBibliography,
} from "../../src/citation/bibliography.js";
import { buildResearchPrompt, readBibliography } from "../../src/agents/ResearcherService.js";
import type { BibliographyEntryInput } from "../../src/agents/ResearcherService.js";
import type { ProjectMetadata } from "../../src/project/ProjectStore.js";
import type { SourceItem } from "../../src/sources/SourceStore.js";

function projectOf(): ProjectMetadata {
  return {
    schemaVersion: 1,
    id: "p-test",
    title: "Bib Lifecycle",
    createdAt: "2026-09-23T00:00:00Z",
    updatedAt: "2026-09-23T00:00:00Z",
    status: "created",
  };
}

const sourceItemOf = (sourceId: string, title: string, doi?: string, year = 2023): SourceItem =>
  ({
    sourceId,
    sourceType: "pdf",
    origin: "USER_ADDED",
    status: "available",
    createdAt: "2026-09-23T00:00:00Z",
    updatedAt: "2026-09-23T00:00:00Z",
    metadata: { title, ...(doi !== undefined ? { doi } : {}), year },
    identity: {
      normalizedTitleFingerprint: title.toLowerCase().replace(/[^a-z0-9]/g, ""),
      ...(doi !== undefined ? { doi: doi.toLowerCase() } : {}),
      year,
    },
  }) as unknown as SourceItem;

describe("research prompt：上一轮 bibliography 注入（膨胀治理的 prompt 侧）", () => {
  const previous: BibliographyEntryInput[] = [
    { key: "yao2023react", title: "ReAct: Synergizing Reasoning and Acting in Language Models", year: 2023 },
    { key: "shinn2023reflexion", title: "Reflexion: Language Agents with Verbal Reinforcement Learning", year: 2023 },
  ];

  it("重跑时注入上一轮清单（title | year）与总量纪律", () => {
    const prompt = buildResearchPrompt(projectOf(), "(digest)", undefined, previous);
    expect(prompt).toContain("上一轮调研已列出 2 条参考文献");
    expect(prompt).toContain("ReAct: Synergizing Reasoning and Acting in Language Models | 2023");
    expect(prompt).toContain("仅补充本轮真实新发现的重要文献");
    expect(prompt).toContain("总量控制在 30 条以内");
  });

  it("首轮（无上一轮）不注入清单区块", () => {
    const prompt = buildResearchPrompt(projectOf(), "(digest)");
    expect(prompt).not.toContain("上一轮调研已列出");
    expect(prompt).toContain("总量控制在 30 条以内");
  });
});

describe("canonical 合并：同文献跨形态去重", () => {
  it("15. canonical DOI dedupe：大小写 / URL 前缀变体的 artifact 条目被丢弃", () => {
    const library = [sourceItemOf("S001", "Attention Is All You Need", "10.5555/nn.2017", 2017)];
    const artifact: BibliographyEntryInput[] = [
      // 同 DOI 大写形态
      { key: "a1", title: "Attention Is All You Need (arXiv version)", year: 2017, doi: "10.5555/NN.2017" },
    ];
    const merged = mergeArtifactBibliography(buildBibliographyFromSources(library), artifact);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.origin).toBe("source-library");
  });

  it("16. normalized title fallback：title variant + 年份兼容 → 不与库内条目成对存活", () => {
    const library = [sourceItemOf("S001", "ReAct: Synergizing Reasoning and Acting in Language Models", undefined, 2022)];
    const artifact: BibliographyEntryInput[] = [
      // 同论文的 title variant（副标题形态差异逃过 compactTitle 全等，相似度仍 ≥0.92）
      {
        key: "yao2022react",
        title: "ReAct: Synergizing Reasoning and Acting in Language Models.",
        year: 2022,
      },
    ];
    const merged = mergeArtifactBibliography(buildBibliographyFromSources(library), artifact);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.origin).toBe("source-library"); // 库内 authoritative 胜出
  });

  it("16b. 年份冲突（相差 ≥1）时不折叠——不同年份的同名文献保持独立", () => {
    const library = [sourceItemOf("S001", "A Survey of Agents", undefined, 2023)];
    const artifact: BibliographyEntryInput[] = [
      { key: "x2025", title: "A Survey of Agents", year: 2025 }, // 年份冲突 → 视为不同文献
    ];
    const merged = mergeArtifactBibliography(buildBibliographyFromSources(library), artifact);
    expect(merged).toHaveLength(2);
  });

  it("16c. artifact 条目有界：超出上限裁尾（LLM 输出序尾部）；source-library 永不被裁", () => {
    const library = [
      sourceItemOf("S001", "Library Paper One", undefined, 2023),
      sourceItemOf("S002", "Library Paper Two", undefined, 2023),
    ];
    const artifact: BibliographyEntryInput[] = Array.from({ length: MAX_ARTIFACT_BIBLIOGRAPHY_ENTRIES + 10 }, (_, i) => ({
      key: `k${i}`,
      title: `Recalled Background Paper Number ${i}`,
      year: 2020 + (i % 5),
    }));
    const merged = mergeArtifactBibliography(buildBibliographyFromSources(library), artifact);
    expect(merged).toHaveLength(MAX_ARTIFACT_BIBLIOGRAPHY_ENTRIES + 2);
    expect(merged.filter((entry) => entry.origin === "source-library")).toHaveLength(2);
    // 保留的是 LLM 输出序的前 MAX 条（Recalled 0..MAX-1）
    const recalledTitles = merged
      .filter((entry) => entry.origin === "artifact")
      .map((entry) => entry.title);
    expect(recalledTitles).toContain("Recalled Background Paper Number 0");
    expect(recalledTitles).not.toContain(
      `Recalled Background Paper Number ${MAX_ARTIFACT_BIBLIOGRAPHY_ENTRIES + 9}`,
    );
  });

  it("14. 同轮 artifact 内部：不同 key 指向同文献（同 title+year）→ assignCitationKeys 折叠", () => {
    const artifact: BibliographyEntryInput[] = [
      { key: "yao2023react", title: "ReAct: Synergizing Reasoning and Acting in Language Models", year: 2023 },
      { key: "yao2023react_a", title: "ReAct: Synergizing Reasoning and Acting in Language Models", year: 2023 },
    ];
    const merged = mergeArtifactBibliography([], artifact);
    expect(merged).toHaveLength(1);
  });
});

describe("readBibliography：同轮内跨形态去重（retry 不产生 identity duplicate）", () => {
  it("同 title 不同 key / 不同 title 写法（归一后同形）同 year → 折叠，先出现者保留", () => {
    const parsed = {
      bibliography: [
        { key: "yao2023react", title: "ReAct: Synergizing Reasoning and Acting in Language Models", year: 2023 },
        // 同文献不同 key
        { key: "yao22react", title: "ReAct: Synergizing Reasoning and Acting in Language Models", year: 2023 },
        // 同文献不同 title 写法（标点差异）
        {
          key: "yao2023reactb",
          title: "ReAct: Synergizing Reasoning and Acting in Language Models!",
          year: 2023,
        },
        // 真实不同文献（保留）
        { key: "shinn2023reflexion", title: "Reflexion: Language Agents with Verbal Reinforcement Learning", year: 2023 },
        // 缺 year 的同 title（与带 year 的不折叠——年份未知不构成同一性）
        { key: "noYear", title: "ReAct: Synergizing Reasoning and Acting in Language Models" },
      ],
    };
    const entries = readBibliography(parsed);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.key)).toEqual(["yao2023react", "shinn2023reflexion", "noYear"]);
  });
});
