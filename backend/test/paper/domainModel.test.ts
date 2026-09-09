/**
 * M4.3.0 Review Domain Model 测试：schema 完整性 / JSON roundtrip /
 * provenance 强制 / 确定性 severity 派生 / frontmatter 解析。
 */

import { describe, expect, it } from "vitest";

import {
  type PaperDocument,
  readPaperDocument,
  readPaperMap,
  type PaperMap,
} from "../../src/paper/types.js";
import { summaryNeedsRefresh, type PaperSectionSummary } from "../../src/paper/sectionSummary.js";
import {
  type CitationCallout,
  type CitationVerificationRecord,
  type ClaimCitationRecord,
  deriveClaimSeverity,
} from "../../src/citation/integrity.js";
import { createFinding, readFinding, type ReviewFinding } from "../../src/review/finding.js";
import {
  parseSkillFrontmatter,
  readSkillMetadata,
  type SkillMetadata,
} from "../../src/skills/types.js";
import { fingerprintJson } from "../../src/util/hash.js";

// ---- fixture 构造（覆盖全部必填 provenance 字段） ----

function sampleDocument(): PaperDocument {
  return {
    schemaVersion: 1,
    projectId: "p-test",
    documentId: "paper-1",
    title: "Attention Is All You Need",
    originalFileName: "attention.pdf",
    bytes: 2215244,
    sha256: "a".repeat(64),
    parse: {
      parserId: "pymupdf",
      parserVersion: "1.28.2",
      parsedAt: "2026-09-06T00:00:00.000Z",
      durationMs: 850,
      pageCount: 15,
      extractionQuality: "good",
    },
    pages: [
      { pageId: "P001", pageNumber: 1, text: "Attention Is All You Need…", charCount: 28 },
      { pageId: "P002", pageNumber: 2, text: "In this work…", charCount: 15 },
    ],
    sections: [
      {
        sectionId: "SEC01",
        title: "Introduction",
        level: 1,
        pageStart: 1,
        pageEnd: 2,
        charCount: 4300,
        source: "toc",
      },
      {
        sectionId: "SEC02",
        title: "References",
        level: 1,
        pageStart: 10,
        pageEnd: 11,
        charCount: 5200,
        source: "heading-pattern",
      },
    ],
    chunks: [
      {
        chunkId: "C0001",
        sequence: 1,
        pageStart: 1,
        pageEnd: 1,
        sectionId: "SEC01",
        text: "The dominant sequence transduction models…",
        charCount: 45,
      },
    ],
    abstractSectionId: "SEC01",
    referencesSectionId: "SEC02",
    ingestedAt: "2026-09-06T00:00:00.000Z",
  };
}

function sampleCallout(): CitationCallout {
  return {
    citationId: "CT001",
    style: "numeric",
    references: [
      { referenceId: "R001", label: "2", status: "resolved" },
      { referenceId: "R005", label: "6", status: "resolved" },
    ],
    page: 1,
    sectionId: "SEC01",
    chunkId: "C0001",
    sentence: "Convolutional approaches [2, 6] dominated previous work.",
    contextBefore: "Prior to transformers,",
    contextAfter: "However,",
  };
}

function sampleVerification(): CitationVerificationRecord {
  return {
    referenceId: "R001",
    status: "VERIFIED",
    probableFabrication: false,
    canonical: {
      provider: "crossref",
      recordId: "10.5555/1409.0473",
      title: "Neural machine translation by jointly learning to align and translate",
      authors: ["Dzmitry Bahdanau", "Kyunghyun Cho", "Yoshua Bengio"],
      year: 2014,
      doi: "10.5555/1409.0473",
      retrievedAt: "2026-09-06T00:00:00.000Z",
    },
    attempts: [{ provider: "crossref", outcome: "match" }],
    checkedAt: "2026-09-06T00:00:00.000Z",
    fingerprint: fingerprintJson({ rawText: "[1] sample" }),
  };
}

function sampleClaimRecord(): ClaimCitationRecord {
  return {
    claimCitationId: "CC0001",
    citationId: "CT001",
    referenceId: "R001",
    referenceIds: ["R001"],
    claimText: "Convolutional approaches dominated previous work.",
    sectionId: "SEC01",
    page: 1,
    chunkId: "C0001",
    priority: "helpful",
    metadataStatus: "VERIFIED",
    verdict: "SUPPORTED",
    reason: "Abstract states convolutional seq2seq was dominant.",
    evidence: [
      {
        source: "crossref:10.5555/1409.0473",
        text: "…translation performance…",
        evidenceLevel: "abstract",
        doi: "10.5555/1409.0473",
        retrievedAt: "2026-09-06T00:00:00.000Z",
      },
    ],
    severity: "info",
    status: "verified",
    fingerprint: fingerprintJson({ claimText: "c", referenceId: "R001" }),
    verifiedAt: "2026-09-06T00:00:00.000Z",
  };
}

function sampleFinding(): ReviewFinding {
  return createFinding({
    findingId: "F0001",
    category: "citation",
    severity: "major",
    message: "引用 [7] 的年份与原文不符（2014 vs 2015）",
    source: "citation-integrity",
    now: "2026-09-06T00:00:00.000Z",
    sectionId: "SEC02",
    page: 10,
    chunkId: "C0012",
    citationIds: ["CT003"],
    referenceId: "R007",
    suggestion: "改为 2014（arXiv v1）",
  });
}

function sampleSkill(): SkillMetadata {
  return {
    id: "verify-citations",
    name: "verify-citations",
    originalDescription: "Use when asked to verify, check, or audit citations…",
    chineseSummary: "引用真实性与语义一致性核验。",
    sourceType: "external",
    sourceRepo: "Agents4Academia-AI/citation_verification",
    sourceRevision: "ae85ae3d51a275a57f7aa80db22870995e3d0275",
    license: "MIT",
    installedPath: "installed/verify-citations",
    contentHash: "b".repeat(64),
    status: "installed",
    installedAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    assignedAgents: ["citation", "reviewer"],
    allowedTools: [],
    summaryStatus: "ok",
  };
}

// ---- JSON roundtrip：全部领域类型序列化-反序列化无损 ----

describe("M4.3.0 domain model", () => {
  it("PaperDocument / callout / verification / claim / finding / skill JSON roundtrip 无损", () => {
    const objects = [
      sampleDocument(),
      sampleCallout(),
      sampleVerification(),
      sampleClaimRecord(),
      sampleFinding(),
      sampleSkill(),
    ];
    for (const object of objects) {
      const roundtrip = JSON.parse(JSON.stringify(object));
      expect(roundtrip).toEqual(object);
    }
  });

  it("readPaperDocument 接受合法文档；缺 provenance 结构拒绝", () => {
    expect(readPaperDocument(JSON.parse(JSON.stringify(sampleDocument())))).not.toBeNull();
    // chunks 为空 → 无法作为 review 输入
    const noChunks = sampleDocument();
    noChunks.chunks = [];
    expect(readPaperDocument(JSON.parse(JSON.stringify(noChunks)))).toBeNull();
    // schemaVersion 不符
    const wrongVersion = sampleDocument() as unknown as Record<string, unknown>;
    wrongVersion["schemaVersion"] = 2;
    expect(readPaperDocument(wrongVersion)).toBeNull();
    // 完全损坏
    expect(readPaperDocument("not-an-object")).toBeNull();
  });

  it("readPaperMap 接受合法 Map；sections 结构损坏拒绝", () => {
    const map: PaperMap = {
      schemaVersion: 1,
      documentTitle: "Attention Is All You Need",
      pageCount: 15,
      sections: [
        {
          sectionId: "SEC01",
          title: "Introduction",
          level: 1,
          pageStart: 1,
          pageEnd: 2,
          chunkCount: 3,
          charCount: 4300,
        },
      ],
      referencesIndex: { referenceCount: 15, calloutCount: 50, unresolvedCallouts: 0 },
      generatedAt: "2026-09-06T00:00:00.000Z",
      sourceFingerprint: "c".repeat(64),
    };
    expect(readPaperMap(JSON.parse(JSON.stringify(map)))).not.toBeNull();
    const broken = map as unknown as Record<string, unknown>;
    broken["sections"] = [{ noTitle: true }];
    expect(readPaperMap(broken)).toBeNull();
  });

  it("createFinding 强制 provenance 与非空 message", () => {
    expect(() =>
      createFinding({
        findingId: "F9999",
        category: "fact",
        severity: "minor",
        message: "x",
        source: "test",
        now: "2026-09-06T00:00:00.000Z",
      }),
    ).toThrow(/provenance/);
    expect(() =>
      createFinding({
        findingId: "F9999",
        category: "fact",
        severity: "minor",
        message: "  ",
        source: "test",
        now: "2026-09-06T00:00:00.000Z",
        page: 1,
      }),
    ).toThrow(/message/);
    const finding = sampleFinding();
    expect(finding.status).toBe("open");
    expect(readFinding(JSON.parse(JSON.stringify(finding)))).toEqual(finding);
    expect(readFinding({ message: "no ids" })).toBeUndefined();
  });

  it("deriveClaimSeverity 全规则表（RefWarden 确定性派生）", () => {
    expect(
      deriveClaimSeverity({ probableFabrication: true, verdict: "SKIPPED", priority: "helpful" }),
    ).toBe("critical");
    expect(
      deriveClaimSeverity({ probableFabrication: false, verdict: "UNSUPPORTED", priority: "obligatory" }),
    ).toBe("critical");
    expect(
      deriveClaimSeverity({ probableFabrication: false, verdict: "CONTRADICTED", priority: "obligatory" }),
    ).toBe("critical");
    expect(
      deriveClaimSeverity({ probableFabrication: false, verdict: "UNSUPPORTED", priority: "helpful" }),
    ).toBe("minor");
    expect(
      deriveClaimSeverity({
        probableFabrication: false,
        verdict: "PARTIALLY_SUPPORTED",
        priority: "obligatory",
      }),
    ).toBe("major");
    expect(
      deriveClaimSeverity({ probableFabrication: false, verdict: "PARTIALLY_SUPPORTED", priority: "helpful" }),
    ).toBe("minor");
    // INSUFFICIENT_EVIDENCE 不是论文问题：info——不构成 Finding，只作诊断展示
    expect(
      deriveClaimSeverity({
        probableFabrication: false,
        verdict: "INSUFFICIENT_EVIDENCE",
        priority: "obligatory",
      }),
    ).toBe("info");
    expect(
      deriveClaimSeverity({ probableFabrication: false, verdict: "SUPPORTED", priority: "obligatory" }),
    ).toBe("info");
  });

  it("parseSkillFrontmatter：name/description/多行折叠/正文分离", () => {
    const skill = parseSkillFrontmatter(
      ["---", "name: verify-citations", "description: Use when asked to verify,", "  check, or audit citations.", "license: MIT", "---", "# Heading", "Body text."].join(
        "\n",
      ),
    );
    expect(skill.name).toBe("verify-citations");
    expect(skill.description).toBe("Use when asked to verify, check, or audit citations.");
    expect(skill.license).toBe("MIT");
    expect(skill.body).toContain("# Heading");
    expect(skill.raw["name"]).toBe("verify-citations");
    // 无 frontmatter：整体作为 body
    const noFm = parseSkillFrontmatter("# Just body");
    expect(noFm.name).toBeUndefined();
    expect(noFm.body).toBe("# Just body");
  });

  it("readSkillMetadata 防御性读取", () => {
    expect(readSkillMetadata(JSON.parse(JSON.stringify(sampleSkill())))).toEqual(sampleSkill());
    expect(readSkillMetadata({ id: "broken" })).toBeUndefined();
  });

  it("summaryNeedsRefresh：无摘要 / failed / 指纹漂移 → true", () => {
    const fp = fingerprintJson({ chunks: ["a"] });
    expect(summaryNeedsRefresh(undefined, fp)).toBe(true);
    const failed: PaperSectionSummary = { sectionId: "SEC01", status: "failed", error: "x" };
    expect(summaryNeedsRefresh(failed, fp)).toBe(true);
    const ok: PaperSectionSummary = {
      sectionId: "SEC01",
      status: "ok",
      summary: "摘要",
      sourceFingerprint: fp,
    };
    expect(summaryNeedsRefresh(ok, fp)).toBe(false);
    expect(summaryNeedsRefresh(ok, fingerprintJson({ chunks: ["changed"] }))).toBe(true);
  });

  it("fingerprintJson 键序无关、内容敏感", () => {
    expect(fingerprintJson({ a: 1, b: [2, 3] })).toBe(fingerprintJson({ b: [2, 3], a: 1 }));
    expect(fingerprintJson({ a: 1 })).not.toBe(fingerprintJson({ a: 2 }));
  });
});
