/**
 * Deterministic Bibliography 单元测试（M9.5 §14-1~8）：
 * 1. 同 SourceIdentity 多次生成 citation key 结果一致；
 * 2. 不同论文同作者同年份 collision deterministic（wang2024a / wang2024b）；
 * 3. BibTeX rendering deterministic（byte identical）；
 * 4. DOI metadata 正确输出；
 * 5. arXiv 正确输出（@misc + eprint + archivePrefix）；
 * 6. missing metadata graceful fallback（无作者 / 无年份 / 无标题）；
 * 7. Verified Evidence 可以绑定 citation key（sourceId 精确 → DOI/标题降级）；
 * 8. Legacy（unverified）evidence 不进入正式 citation 绑定通道（Writer formalOnly）。
 */

import { describe, expect, it } from "vitest";

import {
  assignCitationKeys,
  baseCitationKey,
  buildBibliographyFromSources,
  filterByCitedKeys,
  mergeArtifactBibliography,
  renderBibEntry,
  renderBibliographyFile,
  resolveEvidenceCitationKey,
  type BibliographySeed,
} from "../../src/citation/bibliography.js";
import type { SourceItem } from "../../src/sources/SourceStore.js";
import type { EvidenceRecord } from "../../src/evidence/EvidenceStore.js";

// ---- fixtures ----

function makeSourceItem(overrides: Partial<SourceItem> & { sourceId: string }): SourceItem {
  return {
    sourceRole: "evidence",
    origin: "USER_ADDED",
    status: "metadata_only",
    preferred: false,
    metadata: {},
    bytes: 0,
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

function seedOf(overrides: Partial<BibliographySeed> & { identityKey: string }): BibliographySeed {
  return {
    title: "Untitled",
    type: "misc",
    origin: "source-library",
    ...overrides,
  };
}

function evidenceOf(overrides: Partial<EvidenceRecord> & { id: string }): EvidenceRecord {
  return {
    claim: "测试论断",
    verificationStatus: "verified",
    createdBy: "researcher",
    createdAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

const GAO_SEED = seedOf({
  title: "Retrieval-Augmented Generation for Large Language Models: A Survey",
  authors: ["Gao, Yunfan", "Xiong, Yun"],
  year: 2023,
  venue: "ACM Computing Surveys",
  doi: "10.1145/3578937",
  type: "article",
  sourceId: "S001",
  identityKey: "doi:10.1145/3578937",
});

// ---- 1. key 确定性 ----

describe("citation key 确定性", () => {
  it("同一 SourceIdentity 多次生成 key 结果一致（含重复集合重算）", () => {
    const once = assignCitationKeys([GAO_SEED]);
    for (let i = 0; i < 5; i += 1) {
      expect(assignCitationKeys([GAO_SEED])).toEqual(once);
    }
    expect(once[0]?.key).toBe("gao2023retrieval");
    // 独立构造的等价 seed（字段顺序不同）→ 同 key
    const equivalent = assignCitationKeys([
      seedOf({
        identityKey: "doi:10.1145/3578937",
        type: "article",
        year: 2023,
        venue: "ACM Computing Surveys",
        authors: ["Gao, Yunfan", "Xiong, Yun"],
        title: "Retrieval-Augmented Generation for Large Language Models: A Survey",
        sourceId: "S001",
        doi: "10.1145/3578937",
      }),
    ]);
    expect(equivalent[0]?.key).toBe(once[0]?.key);
  });

  it("基础 key = 一作 family + 年份 + 首个有效标题词（跳过功能词）", () => {
    expect(
      baseCitationKey({
        authors: ["Vaswani, Ashish"],
        year: 2017,
        title: "Attention Is All You Need",
      }),
    ).toBe("vaswani2017attention");
    // "On the Convergence of ..." 不取 on / the
    expect(
      baseCitationKey({ authors: ["Wang, Lei"], year: 2024, title: "On the Convergence of Adam" }),
    ).toBe("wang2024convergence");
  });
});

// ---- 2. 冲突消解 ----

describe("同作者同年份冲突消解", () => {
  const wangA = seedOf({
    title: "Deep Learning Approaches for Tracking",
    authors: ["Wang, Lei"],
    year: 2024,
    identityKey: "doi:10.1000/aaa",
  });
  const wangB = seedOf({
    title: "Deep Learning Approaches for Detection",
    authors: ["Wang, Lei"],
    year: 2024,
    identityKey: "doi:10.1000/bbb",
  });
  const wangC = seedOf({
    title: "Deep Learning Approaches for Segmentation",
    authors: ["Wang, Lei"],
    year: 2024,
    identityKey: "doi:10.1000/ccc",
  });

  it("两篇同基础 key → 首条无后缀、其后 a/b 递增（按 identityKey 排序）；单独一篇无后缀", () => {
    const both = assignCitationKeys([wangA, wangB]);
    expect(both.map((entry) => entry.key).sort()).toEqual(["wang2024deep", "wang2024deepa"]);
    const alone = assignCitationKeys([wangB]);
    expect(alone[0]?.key).toBe("wang2024deep");
  });

  it("三篇 → 裸 / a / b；任意输入顺序结果一致（deterministic）", () => {
    const sorted = assignCitationKeys([wangA, wangB, wangC]).map((entry) => entry.key);
    expect(sorted).toEqual(["wang2024deep", "wang2024deepa", "wang2024deepb"]);
    for (const order of [
      [wangC, wangA, wangB],
      [wangB, wangC, wangA],
    ]) {
      expect(assignCitationKeys(order).map((entry) => entry.key)).toEqual(sorted);
    }
  });

  it("同 identityKey 去重：source-library 胜过 artifact", () => {
    const artifactDupe: BibliographySeed = {
      ...wangA,
      origin: "artifact",
      sourceId: undefined,
    };
    const merged = assignCitationKeys([artifactDupe, wangA]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.origin).toBe("source-library");
  });
});

// ---- 3 / 4 / 5 / 6. 渲染 ----

describe("BibTeX 确定性渲染", () => {
  it("重复渲染 byte identical；字段顺序固定；按 key 排序", () => {
    const entries = assignCitationKeys([
      GAO_SEED,
      seedOf({
        title: "Attention Is All You Need",
        authors: ["Vaswani, Ashish"],
        year: 2017,
        type: "inproceedings",
        venue: "NeurIPS",
        identityKey: "arxiv:1706.03762",
        arxivId: "1706.03762",
        sourceId: "S002",
      }),
    ]);
    const first = renderBibliographyFile(entries);
    const second = renderBibliographyFile([...entries].reverse());
    expect(second).toBe(first);
    expect(first.indexOf("gao2023retrieval")).toBeLessThan(first.indexOf("vaswani2017attention"));
  });

  it("DOI 正确输出（article + journal + doi 字段）", () => {
    const rendered = renderBibEntry({
      key: "gao2023retrieval",
      title: "A Survey",
      authors: ["Gao, Yunfan"],
      year: 2023,
      venue: "ACM Computing Surveys",
      doi: "10.1145/3578937",
      type: "article",
    });
    expect(rendered).toContain("@article{gao2023retrieval,");
    expect(rendered).toContain("journal = {ACM Computing Surveys}");
    expect(rendered).toContain("doi = {10.1145/3578937}");
    expect(rendered).toContain("author = {Gao, Yunfan}");
  });

  it("arXiv 正确输出（misc + eprint + archivePrefix；preprint 类型）", () => {
    const rendered = renderBibEntry({
      key: "vaswani2017attention",
      title: "Attention Is All You Need",
      authors: ["Vaswani, Ashish"],
      year: 2017,
      arxivId: "1706.03762",
      type: "misc",
      sourceId: "S002",
    });
    expect(rendered).toContain("@misc{vaswani2017attention,");
    expect(rendered).toContain("eprint = {1706.03762}");
    expect(rendered).toContain("archivePrefix = {arXiv}");
    expect(rendered).toContain("sourceId = {S002}");
    expect(rendered).not.toContain("journal =");
  });

  it("conference → inproceedings + booktitle；LaTeX 特殊字符转义；作者 Family, Given 归一", () => {
    const rendered = renderBibEntry({
      key: "x2024t",
      title: "A 100% Robust & Stable Method",
      authors: ["Ashish Vaswani", "王力"],
      year: 2024,
      venue: "CVPR",
      type: "inproceedings",
    });
    expect(rendered).toContain("@inproceedings{x2024t,");
    expect(rendered).toContain("booktitle = {CVPR}");
    expect(rendered).toContain("title = {A 100\\% Robust \\& Stable Method}");
    // 自然序作者转 Family, Given；单 token（中文姓名）原样
    expect(rendered).toContain("author = {Vaswani, Ashish and 王力}");
  });

  it("missing metadata graceful fallback：无作者用标题词、无年份用 nd、无 venue 用 misc", () => {
    expect(baseCitationKey({ title: "Anonymous Study", year: 2024 })).toBe("anonymous2024");
    expect(baseCitationKey({ authors: ["Gao, Yun"], title: "Some Study" })).toBe("gaondsome");
    expect(baseCitationKey({})).toBe("sourcend");
    const rendered = renderBibEntry({ key: baseCitationKey({ title: "Anonymous Study", year: 2024 }), title: "Anonymous Study" });
    expect(rendered).toContain("@misc{anonymous2024,");
    expect(rendered).not.toContain("author =");
    expect(rendered).not.toContain("year =");
    // 无 title 的 SourceItem 在 build 阶段跳过（渲染不出可辨识条目）
    expect(buildBibliographyFromSources([makeSourceItem({ sourceId: "S009", metadata: {} })])).toHaveLength(0);
  });

  it("SourceItem → seed：versionType 决定类型；identity 归一 DOI/arXiv", () => {
    const seeds = buildBibliographyFromSources([
      makeSourceItem({
        sourceId: "S001",
        versionType: "conference",
        metadata: {
          title: "Attention Is All You Need",
          authors: ["Vaswani, Ashish"],
          year: 2017,
          venue: "NeurIPS",
        },
        identity: {
          doi: "10.5555/3295222",
          arxivId: "1706.03762",
          normalizedTitleFingerprint: "attentionisallyouneed",
        },
      }),
      makeSourceItem({
        sourceId: "S002",
        versionType: "preprint",
        metadata: { title: "Some Preprint", authors: ["Li, Ming"], year: 2025 },
      }),
    ]);
    expect(seeds).toHaveLength(2);
    expect(seeds[0]).toMatchObject({
      type: "inproceedings",
      doi: "10.5555/3295222",
      arxivId: "1706.03762",
      sourceId: "S001",
      identityKey: "doi:10.5555/3295222",
    });
    expect(seeds[1]?.type).toBe("misc");
  });
});

// ---- SourceStore ∪ artifact 合并 ----

describe("mergeArtifactBibliography", () => {
  it("同身份（标题+年份）的 LLM 条目丢弃；不同条目确定性重 key（LLM key 不进下游）", () => {
    const merged = mergeArtifactBibliography(
      [GAO_SEED],
      [
        {
          key: "llmInventedKey",
          title: "Retrieval-Augmented Generation for Large Language Models: A Survey",
          authors: ["Gao"],
          year: 2023, // 与文献库条目同标题同年份 → 丢弃
        },
        {
          key: "anotherLlmKey",
          title: "Knowledge-Intensive NLP Tasks",
          authors: ["Lewis, Patrick"],
          year: 2020,
        },
      ],
    );
    expect(merged.map((entry) => entry.key).sort()).toEqual(["gao2023retrieval", "lewis2020knowledge"]);
    expect(merged.every((entry) => entry.key !== "llmInventedKey" && entry.key !== "anotherLlmKey")).toBe(true);
    expect(merged.find((entry) => entry.origin === "artifact")?.venue).toBeUndefined();
  });
});

// ---- 7 / 8. Evidence → Citation 追溯 ----

describe("Evidence → citation key 追溯", () => {
  const entries = assignCitationKeys([GAO_SEED]);

  it("verified evidence 经 sourceId 精确绑定 citation key", () => {
    const record = evidenceOf({
      id: "E001",
      source: { sourceId: "S001", title: "略不同的标题写法（sourceId 优先）", year: 2023 },
      location: { chunk: "S001:SEC01:0001:abcd1234" },
    });
    expect(resolveEvidenceCitationKey(record, entries)).toBe("gao2023retrieval");
  });

  it("无 sourceId 时降级 DOI → 标题（+年份）匹配；无匹配返回 null", () => {
    const byDoi = evidenceOf({
      id: "E002",
      source: { title: "Unknown Title", doi: "10.1145/3578937", year: 2023 },
      location: { chunk: "S001:SEC01:0002:abcd1234" },
    });
    expect(resolveEvidenceCitationKey(byDoi, entries)).toBe("gao2023retrieval");
    const byTitle = evidenceOf({
      id: "E003",
      source: { title: "Retrieval-Augmented Generation for Large Language Models: A Survey", year: 2023 },
      location: { chunk: "S001:SEC01:0003:abcd1234" },
    });
    expect(resolveEvidenceCitationKey(byTitle, entries)).toBe("gao2023retrieval");
    const noMatch = evidenceOf({
      id: "E004",
      source: { title: "Something Else Entirely", year: 1999 },
      location: { chunk: "S009:SEC01:0004:abcd1234" },
    });
    expect(resolveEvidenceCitationKey(noMatch, entries)).toBeNull();
  });
});

// ---- 10 / 11. references.bib 裁剪与字节稳定 ----

describe("references.bib 生命周期辅助", () => {
  it("filterByCitedKeys 只保留实际引用条目；重复生成 byte identical", () => {
    const entries = assignCitationKeys([
      GAO_SEED,
      seedOf({
        title: "Attention Is All You Need",
        authors: ["Vaswani, Ashish"],
        year: 2017,
        identityKey: "arxiv:1706.03762",
      }),
      seedOf({
        title: "Never Cited Paper",
        authors: ["Nobody, Alan"],
        year: 2020,
        identityKey: "doi:10.1000/never",
      }),
    ]);
    const kept = filterByCitedKeys(entries, ["gao2023retrieval"]);
    expect(kept.map((entry) => entry.key)).toEqual(["gao2023retrieval"]);
    // 未使用 source 不出现在渲染产物里；同输入两次渲染字节一致
    expect(renderBibliographyFile(kept)).toBe(renderBibliographyFile(filterByCitedKeys(entries, ["gao2023retrieval"])));
    expect(renderBibliographyFile(kept)).not.toContain("Never Cited Paper");
    // 空引用集 → 空文件（可编译）
    expect(renderBibliographyFile(filterByCitedKeys(entries, []))).toBe("");
  });
});
