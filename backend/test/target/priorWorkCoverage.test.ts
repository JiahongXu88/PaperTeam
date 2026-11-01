/**
 * M15.19 Phase C — 先前工作 pool 的有界定向优先级与覆盖诊断：
 * - 参考文献解析上限（20）内优先「在声称所在节被引用」的条目（旧口径按年份取最新 20 条，
 *   M15.18 S2：模型给出的最近先前工作均未进入 pool）；上限不变、不扩大检索；
 * - 审计点名的最近先前工作逐条诊断为何未达已核验全文（在参考文献但未解析 / 被 pool 上限截掉 /
 *   在库未升级 / 仅模型记忆且不在参考文献），只做诊断与提示，不升格任何候选。
 */

import { describe, expect, it } from "vitest";

import type { PaperDocument } from "../../src/paper/types.js";
import type { ResolverVerdict, ScholarlyQuery } from "../../src/citation/scholarly.js";
import type { AcademicSearchResponse } from "../../src/search/academicSearchService.js";
import type { SourceItem } from "../../src/sources/SourceStore.js";
import {
  EVIDENCE_AUDIT_MAX_REFS,
  buildPriorWorkPool,
  diagnosePriorWorkCoverage,
} from "../../src/target/TargetEvidenceAuditService.js";
import type { ContributionComparison } from "../../src/target/ContributionAuditService.js";

const TOPICS = [
  "graph neural association", "transformer query tracking", "kalman motion filtering", "appearance embedding learning",
  "occlusion aware matching", "camera motion compensation", "detection confidence scheduling", "trajectory interpolation methods",
  "crowd density estimation", "pedestrian reidentification features", "optical flow propagation", "segmentation guided tracking",
  "lidar point fusion", "temporal attention modules", "anchor free detection", "hungarian assignment variants",
  "online learning trackers", "benchmark protocol design", "synthetic data generation", "lightweight edge deployment",
  "sports player tracking", "dance motion datasets",
];

/** 24 条参考文献：[1]–[22] 年份新（2020–2023）但只在实验节被引；[23][24] 年份旧（2005/2008）但在引言 / 相关工作被引 */
function makeDocument(): PaperDocument {
  const section = (id: string, title: string) => ({ sectionId: id, title, level: 1, pageStart: 1, pageEnd: 2, charCount: 400, source: "toc" as const });
  const chunk = (id: string, sequence: number, sectionId: string, text: string) => ({ chunkId: id, sequence, pageStart: 1, pageEnd: 2, sectionId, text, charCount: text.length });
  const recent = TOPICS.map((topic, index) => `[${index + 1}] Author${index} A, Writer B. A study of ${topic} for multi object tracking//CVPR. ${2020 + (index % 4)}.`);
  const old = [
    "[23] Smith J, Doe K. Joint probabilistic data association for multiple target tracking//IEEE TAC. 2005.",
    "[24] Brown L, Green M. Multiple hypothesis tracking revisited with deep features//ICCV. 2008.",
  ];
  const experimentCites = TOPICS.map((_, index) => `[${index + 1}]`).join(", ");
  return {
    schemaVersion: 1,
    projectId: "p-fixture",
    documentId: "paper-1",
    title: "A Tracker",
    abstract: "We propose a tracker.",
    originalFileName: "fixture.pdf",
    bytes: 1,
    sha256: "c".repeat(64),
    parse: { parserId: "test", parsedAt: "2026-11-01T00:00:00.000Z", durationMs: 1, pageCount: 8, extractionQuality: "good" },
    pages: [],
    sections: [section("SEC01", "Introduction"), section("SEC02", "Related Work"), section("SEC03", "Experiments"), section("SEC09", "References")],
    chunks: [
      chunk("C1", 1, "SEC01", `Our association extends joint probabilistic data association [23] and improves over the classical baseline. ${"i".repeat(120)}`),
      chunk("C2", 2, "SEC02", `Multiple hypothesis tracking [24] remains the closest prior design to ours. ${"r".repeat(120)}`),
      chunk("C3", 3, "SEC03", `We compare with recent trackers ${experimentCites}. ${"e".repeat(120)}`),
      chunk("C9", 9, "SEC09", [...recent, ...old].join("\n\n")),
    ],
    abstractSectionId: undefined,
    referencesSectionId: "SEC09",
    ingestedAt: "2026-11-01T00:00:00.000Z",
  };
}

const noResolve = { resolve: async (_query: ScholarlyQuery): Promise<ResolverVerdict> => ({ outcome: "not_found", attempts: [], cacheHits: 0 }) as unknown as ResolverVerdict };
const noSearch = { search: async (_query: string): Promise<AcademicSearchResponse> => ({ results: [] }) as unknown as AcademicSearchResponse };

describe("buildPriorWorkPool：解析上限内优先声称所在节被引的参考文献", () => {
  it("年份旧但在引言 / 相关工作被引的 [23][24] 进入解析（旧口径按年份会被挤出）；超限条目如实登记", async () => {
    const document = makeDocument();
    const { stats } = await buildPriorWorkPool(document, "2026-11-01", { scholarly: noResolve, academic: noSearch, librarySources: [], readSourceChunks: async () => null });
    expect(stats.referenceEntriesEligible).toBe(EVIDENCE_AUDIT_MAX_REFS);
    const cut = stats.cutFromPool ?? []; // pool cap 12: remaining candidates are cut
    expect(stats.refSelectionBasis).toBe("claim-section-callouts");
    expect(stats.refsWithClaimSectionCallouts).toBe(2);
    const queried = (await buildPriorWorkPool(document, "2026-11-01", { scholarly: noResolve, academic: noSearch, librarySources: [], readSourceChunks: async () => null })).pool.queriesUsed;
    expect(queried.some((query) => /joint probabilistic data association/i.test(query))).toBe(true);
    expect(queried.some((query) => /multiple hypothesis tracking revisited/i.test(query))).toBe(true);
    expect(stats.refsNotSelected).toHaveLength(24 - EVIDENCE_AUDIT_MAX_REFS);
    expect(cut.length).toBeGreaterThan(0);
  });
});

describe("diagnosePriorWorkCoverage：为何未达已核验全文（确定性，零网络）", () => {
  it("区分：在参考文献但未解析 / 被 pool 上限截掉 / 在库未升级 / 仅模型记忆且不在参考文献 / pool 内摘要级", async () => {
    const document = makeDocument();
    const { stats } = await buildPriorWorkPool(document, "2026-11-01", { scholarly: noResolve, academic: noSearch, librarySources: [], readSourceChunks: async () => null });
    const cut = stats.cutFromPool![0]!;
    const notSelected = stats.refsNotSelected![0]!;
    const library: SourceItem = {
      sourceId: "src-1",
      sourceRole: "reference",
      origin: "USER_ADDED",
      status: "available",
      preferred: false,
      metadata: { title: "Deep SORT with library full text", year: 2017 },
      identity: { normalizedTitleFingerprint: "deepsortwithlibraryfulltext", year: 2017 },
      bytes: 1,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    };
    const comparisons: ContributionComparison[] = [
      {
        contributionId: "C1",
        nearestPriorWorks: [
          { title: notSelected.title, year: notSelected.year, sourceLevel: "model_memory", resolvesToPool: false },
          { title: cut.title, year: cut.year, sourceLevel: "model_memory", resolvesToPool: false },
          { title: "Deep SORT with library full text", year: 2017, sourceLevel: "model_memory", resolvesToPool: false },
          { title: "A survey that the manuscript never cites", year: 2019, sourceLevel: "model_memory", resolvesToPool: false },
          { candidateId: "P01", title: "In pool abstract", sourceLevel: "pool_abstract", resolvesToPool: true },
        ],
        commonMechanism: "", substantiveDifference: "", differenceBasis: "abstract", completedVerification: "", missingVerification: "", status: "INSUFFICIENT_EVIDENCE",
      },
    ];
    const entries = diagnosePriorWorkCoverage({ comparisons }, document, stats, [library]);
    expect(entries.map((entry) => entry.diagnosis)).toEqual([
      "reference_not_resolved",
      "cut_by_pool_cap",
      "in_library_not_upgraded",
      "model_memory_not_in_references",
      "in_pool_abstract_or_metadata",
    ]);
    expect(entries[0]).toMatchObject({ inManuscriptReferences: true, referenceNotSelected: true });
    expect(entries[1]).toMatchObject({ retrievedButCut: true, inManuscriptReferences: true });
    expect(entries[3]).toMatchObject({ inManuscriptReferences: false, inLibrary: false });
  });
});
