/**
 * Review Markdown 导出测试（ReviewReportExporter + HTTP 路由）。
 * 覆盖：中文 UTF-8、异常引用展开、INSUFFICIENT_EVIDENCE 全量保留、ReviewFinding、
 * Quality Gate（有/无）、密钥与内部路径不泄漏、filename sanitize、无报告 404。
 */

import { afterAll, describe, expect, it } from "vitest";

import {
  ReviewReportExporter,
  contentDisposition,
  sanitizeFileName,
  type ReviewExportInput,
} from "../../src/review/ReviewReportExporter.js";
import type {
  CitationVerificationRecord,
  ClaimCitationRecord,
  ReferenceEntry,
} from "../../src/citation/integrity.js";
import { startTestStack, scriptedIdeaRuntime } from "../helpers/testStack.js";

const NOW = "2026-09-07T00:00:00.000Z";

// ---- fixtures ----

function referenceFixture(id: string, number: number, overrides: Partial<ReferenceEntry> = {}): ReferenceEntry {
  return {
    referenceId: id,
    number,
    rawText: `[${number}] Some reference text ${id}`,
    title: `Reference Title ${id}`,
    authors: ["A. Author"],
    year: 2024,
    page: 10,
    sectionId: "SEC99",
    fingerprint: `fp-${id}`,
    ...overrides,
  };
}

function metadataFixture(
  referenceId: string,
  status: CitationVerificationRecord["status"],
  overrides: Partial<CitationVerificationRecord> = {},
): CitationVerificationRecord {
  return {
    referenceId,
    status,
    probableFabrication: false,
    attempts: [{ provider: "crossref", outcome: status === "VERIFIED" ? "match" : "not_found" }],
    checkedAt: NOW,
    fingerprint: `fp-${referenceId}`,
    algorithmVersion: "v3.n2",
    ...overrides,
  };
}

function claimFixture(id: string, referenceId: string, overrides: Partial<ClaimCitationRecord> = {}): ClaimCitationRecord {
  return {
    claimCitationId: id,
    citationId: id.split("-")[0]!,
    referenceId,
    referenceIds: [referenceId],
    claimText: `正文论断 ${id}`,
    sectionId: "SEC02",
    page: 3,
    chunkId: "C0002",
    priority: "helpful",
    metadataStatus: "VERIFIED",
    verdict: "SUPPORTED",
    reason: "证据支持该论断",
    evidence: [],
    severity: "info",
    status: "verified",
    fingerprint: `fp-${id}`,
    verifiedAt: NOW,
    ...overrides,
  };
}

function exportInput(overrides: Partial<ReviewExportInput> = {}): ReviewExportInput {
  return {
    report: {
      round: 2,
      generatedAt: NOW,
      paper: { title: "多目标跟踪中的遮挡恢复研究", pageCount: 25, sections: 8 },
      review: {
        sectionsReviewed: 7,
        sectionsTotal: 9,
        skippedSections: 1,
        emptySections: 1,
        failedSections: 1,
        findingsTotal: 2,
        parseFailures: 0,
        bySeverity: { critical: 1, major: 0, minor: 1, info: 0 },
        byCategory: { fact: 1, academic: 1 },
      },
      citationIntegrity: { metadataByStatus: { VERIFIED: 2, NOT_FOUND: 1 } },
      findings: [
        {
          findingId: "f-1",
          category: "fact",
          severity: "critical",
          sectionId: "SEC02",
          page: 3,
          claimText: "遮挡恢复率提升 50%",
          message: "该论断与引用证据不符",
          suggestion: "核对实验数字",
          status: "open",
          source: "section-review",
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          findingId: "f-2",
          category: "academic",
          severity: "minor",
          sectionId: "SEC01",
          message: "相关工作覆盖不足",
          status: "open",
          source: "section-review",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    },
    project: { title: "多目标跟踪中的遮挡恢复研究" },
    document: {
      originalFileName: "paper.pdf",
      pageCount: 25,
      parse: { parserId: "pymupdf", durationMs: 901, extractionQuality: "good", parsedAt: NOW },
      sections: [
        { sectionId: "SEC01", title: "引言" },
        { sectionId: "SEC02", title: "方法" },
      ],
    },
    references: [
      referenceFixture("R001", 1),
      referenceFixture("R002", 2, {
        title: "Ultralytics yolo11",
        rawText: "[2] G. Jocher and J. Qiu, “Ultralytics yolo11,” 2024. [Online]. Available: https://github.com/ultralytics/ultralytics",
      }),
      referenceFixture("R003", 3, { title: "Ghost Paper" }),
    ],
    metadataRecords: [
      metadataFixture("R001", "VERIFIED", {
        canonical: {
          provider: "crossref",
          recordId: "10.1000/real",
          title: "Reference Title R001",
          year: 2024,
          doi: "10.1000/real",
          abstract: "A real abstract",
          retrievedAt: NOW,
        },
      }),
      metadataFixture("R002", "VERIFIED", {
        kind: "software",
        canonical: {
          provider: "github",
          recordId: "ultralytics/ultralytics",
          title: "ultralytics",
          authors: ["ultralytics"],
          url: "https://github.com/ultralytics/ultralytics",
          abstract: "Ultralytics YOLO11 object detection toolkit",
          software: {
            repositoryUrl: "https://github.com/ultralytics/ultralytics",
            homepage: "https://docs.ultralytics.com",
            description: "Ultralytics YOLO11 object detection toolkit",
          },
          retrievedAt: NOW,
        },
        attempts: [{ provider: "github", outcome: "match", note: "官方仓库：https://github.com/ultralytics/ultralytics" }],
      }),
      metadataFixture("R003", "NOT_FOUND", {
        probableFabrication: true,
        attempts: [
          { provider: "crossref", outcome: "not_found" },
          { provider: "openalex", outcome: "not_found" },
          { provider: "arxiv", outcome: "not_found" },
        ],
      }),
    ],
    claims: [
      claimFixture("CT001-R001", "R001", {
        verdict: "SUPPORTED",
        evidence: [
          { source: "crossref:10.1000/real", text: "A real abstract supporting the claim", evidenceLevel: "abstract", doi: "10.1000/real", retrievedAt: NOW },
        ],
      }),
      claimFixture("CT002-R001", "R001", {
        verdict: "UNSUPPORTED",
        reason: "证据没有提及该数字",
        severity: "minor",
        evidence: [
          { source: "crossref:10.1000/real", text: "A real abstract", evidenceLevel: "abstract", doi: "10.1000/real", retrievedAt: NOW },
        ],
      }),
      claimFixture("CT003-R002", "R002", {
        verdict: "INSUFFICIENT_EVIDENCE",
        reason: "只获取到书目 metadata，证据不足",
        reasonCode: "NO_EVIDENCE",
        evidence: [],
        severity: "minor",
      }),
      claimFixture("CT004-R003", "R003", {
        verdict: "SKIPPED",
        reason: "文献真实性未确立",
        reasonCode: "REFERENCE_UNVERIFIED",
        status: "skipped",
        severity: "info",
      }),
    ],
    calloutCount: 12,
    run: {
      runId: "w-test",
      status: "completed",
      startedAt: "2026-09-07T00:00:00.000Z",
      finishedAt: "2026-09-07T00:10:00.000Z",
      stageHistory: [
        { stageId: "paper.ensure", status: "completed", startedAt: "2026-09-07T00:00:00.000Z", finishedAt: "2026-09-07T00:01:00.000Z" },
        { stageId: "review.sections", status: "completed", startedAt: "2026-09-07T00:01:00.000Z", finishedAt: "2026-09-07T00:10:00.000Z" },
      ],
    },
    gate: null,
    ...overrides,
  };
}

// ---- service 层 ----

describe("ReviewReportExporter：citationSemanticMode 三种模式", () => {
  const exporter = new ReviewReportExporter();

  it("off：写明本轮未开启；不输出语义统计、不混入历史 claims", () => {
    const { markdown } = exporter.export(exportInput({ citationSemanticMode: "off" }));
    expect(markdown).toContain("## 引用语义核验");
    expect(markdown).toContain("本轮未开启引用语义核验");
    expect(markdown).toContain("引用语义核验：未开启（语义模型调用 0 次）");
    expect(markdown).not.toContain("## 语义核验（Layer 2");
    expect(markdown).not.toContain("| ✅ 支持 |");
    expect(markdown).not.toContain("证据不足（");
    expect(markdown).not.toContain("正文论断 CT001"); // 历史 claims 不进 off 轮报告
  });

  it("contradiction_only：标注模式；只展开明确矛盾", () => {
    const { markdown } = exporter.export(
      exportInput({
        citationSemanticMode: "contradiction_only",
        claims: [
          claimFixture("CT001-R001", "R001", {
            verdict: "NO_CONTRADICTION_DETECTED",
            reason: "证据未发现与论断相反的结论",
          }),
          claimFixture("CT002-R001", "R001", {
            verdict: "CONTRADICTED",
            reason: "证据明确报告相反结论",
            severity: "critical",
          }),
        ],
      }),
    );
    expect(markdown).toContain("## 语义核验（Layer 2：仅检查明显冲突）");
    expect(markdown).toContain("模式：仅检查明显冲突");
    expect(markdown).toContain("| ✅ 未发现明显矛盾 | 1 |");
    expect(markdown).toContain("### 存在矛盾（1 条）");
    expect(markdown).toContain("证据明确报告相反结论");
    expect(markdown).not.toContain("### 无法自动判断（证据不足，");
    expect(markdown).not.toContain("### 不支持（");
  });

  it("full（缺省）：旧输入无 mode 字段按 full——完整统计与明细不变", () => {
    const { markdown } = exporter.export(exportInput());
    expect(markdown).toContain("## 语义核验（Layer 2：论断与引用一致性）");
    expect(markdown).toContain("### 不支持（1 条）");
    expect(markdown).toContain("### 无法自动判断（证据不足，1 条");
  });
});

describe("ReviewReportExporter（service 层）", () => {
  const exporter = new ReviewReportExporter();

  it("结构完整：标题 / 基本信息 / 摘要 / 引用核验 / 语义核验 / findings / Gate / 运行信息", () => {
    const { markdown } = exporter.export(exportInput());
    expect(markdown).toContain("# PaperTeam Review Report");
    expect(markdown).toContain("## 基本信息");
    expect(markdown).toContain("多目标跟踪中的遮挡恢复研究");
    expect(markdown).toContain("## 总体摘要");
    expect(markdown).toContain("## 引用真实性核验");
    expect(markdown).toContain("## 语义核验");
    expect(markdown).toContain("## Review Findings");
    expect(markdown).toContain("## 章节 Review");
    expect(markdown).toContain("## Quality Gate");
    expect(markdown).toContain("## 未解决问题");
    expect(markdown).toContain("## 运行信息");
    // 面向 AI 的文字语义（不是只有 emoji/颜色）
    expect(markdown).toContain("✅ 已验证");
    expect(markdown).toContain("状态：❌ 未找到");
    expect(markdown).toContain("状态：❌ 不支持");
    expect(markdown).toContain("状态：❔ 无法自动判断（证据不足）");
    expect(markdown).toContain("⏭️ 跳过");
  });

  it("异常引用详细展开（NOT_FOUND / 疑似虚构）；software 显示 Repository 与官方文档", () => {
    const { markdown } = exporter.export(exportInput());
    expect(markdown).toContain("### 需要注意的引用");
    expect(markdown).toContain("疑似虚构");
    // 正常引用压缩表：software 的 repository + 官方文档
    expect(markdown).toContain("### 正常引用");
    expect(markdown).toContain("https://github.com/ultralytics/ultralytics（官方文档：https://docs.ultralytics.com）");
    expect(markdown).toContain("| 软件 |");
  });

  it("INSUFFICIENT_EVIDENCE 全量保留 + 无证据明示；UNSUPPORTED 逐条详细", () => {
    const { markdown } = exporter.export(exportInput());
    expect(markdown).toContain("### 无法自动判断（证据不足，1 条——只表示未获取到足够摘要/正文证据，不代表引用存在问题）");
    expect(markdown).toContain("当前未获得足够可核验的原文证据（自动核验无法判断，不代表引用存在错误）。");
    expect(markdown).toContain("只获取到书目 metadata，没有摘要/正文等可判证据");
    expect(markdown).toContain("### 不支持（1 条）");
    expect(markdown).toContain("证据没有提及该数字");
  });

  it("ReviewFinding 按 severity 分组输出（page/section/category/message/suggestion）", () => {
    const { markdown } = exporter.export(exportInput());
    expect(markdown).toContain("### 严重（Critical）（1 条）");
    expect(markdown).toContain("第 3 页（方法）｜事实");
    expect(markdown).toContain("该论断与引用证据不符");
    expect(markdown).toContain("建议：核对实验数字");
    expect(markdown).toContain("### 次要（Minor）（1 条）");
  });

  it("Quality Gate：无 → 明确说明；有 → PASS/FAIL + 规则表", () => {
    const without = exporter.export(exportInput());
    expect(without.markdown).toContain("本轮快速 Review 不包含 Quality Gate");
    const withGate = exporter.export(
      exportInput({
        gate: {
          passed: false,
          reasons: ["citation_fabrication_zero：疑似虚构引用 1 条"],
          rules: [
            { rule: "citation_fabrication_zero", passed: false, detail: "fabricated=1" },
            { rule: "academic_score_threshold", passed: true, detail: "score=86" },
          ],
        },
      }),
    );
    expect(withGate.markdown).toContain("❌ FAIL（未通过）");
    expect(withGate.markdown).toContain("citation_fabrication_zero");
  });

  it("运行信息：阶段耗时表 + 总耗时 + 模型/查询计数；不含密钥与内部绝对路径", () => {
    const { markdown } = exporter.export(exportInput());
    expect(markdown).toContain("Review 总耗时：600.0 秒");
    expect(markdown).toContain("| paper.ensure | 完成 | 60.0s |");
    expect(markdown).toContain("| review.sections | 完成 | 540.0s |");
    expect(markdown).toContain("外部权威源查询：5 次");
    // 安全：无 API key 形态、无盘符绝对路径、无 prompt 内容
    expect(markdown).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(markdown).not.toMatch(/[A-Z]:\\\\/);
    expect(markdown).not.toMatch(/[A-Z]:\/Users\//);
    expect(markdown).not.toContain("你是引用语义核验员");
  });

  it("filename sanitize：非法字符替换（全角冒号合法保留）、中文保留、RFC 5987 编码", () => {
    expect(sanitizeFileName("多目标跟踪：遮挡/恢复*研究?", 2)).toBe("多目标跟踪：遮挡-恢复-研究-r2.md");
    expect(sanitizeFileName('a\\b/c:d*e?f"g<h>i|j', 1)).toBe("a-b-c-d-e-f-g-h-i-j-r1.md");
    expect(sanitizeFileName("", 3)).toBe("PaperTeam-Review-r3.md");
    const disposition = contentDisposition("多目标跟踪-r2.md");
    expect(disposition).toContain("filename*=UTF-8''");
    expect(disposition).toContain(encodeURIComponent("多目标跟踪-r2.md"));
    // ASCII fallback 不含引号/控制字符
    expect(disposition).toMatch(/filename="[^"]*"/);
  });
});

// ---- HTTP 层 ----

describe("GET /api/projects/:id/paper-review/export.md（HTTP 层）", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup();
    }
  });

  it("无报告 → 404（不导出空文件）；有报告 → text/markdown + UTF-8 Content-Disposition", async () => {
    const scripted = scriptedIdeaRuntime();
    const stack = await startTestStack(scripted.runtime, {
      registerCleanup: (cleanup) => cleanups.push(cleanup),
      citation: { metadataEnabled: false, scholarly: { providers: [] } },
    });
    const project = await stack.store.create("导出测试项目");
    const projectId = project.id;

    // 尚无报告：明确 404
    const missing = await fetch(`http://127.0.0.1:${stack.port()}/api/projects/${projectId}/paper-review/export.md`);
    expect(missing.status).toBe(404);
    await missing.json();

    // 落一份报告 + 引用产物（与真实 review.aggregate 产物同构）
    await stack.stack.reviewArtifacts.saveExistingReview(projectId, 1, exportInput().report);
    const response = await fetch(`http://127.0.0.1:${stack.port()}/api/projects/${projectId}/paper-review/export.md`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    const disposition = response.headers.get("Content-Disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain("filename*=UTF-8''");
    const markdown = await response.text();
    expect(markdown).toContain("# PaperTeam Review Report");
    expect(markdown).toContain("多目标跟踪中的遮挡恢复研究");
    // 报告本体内容（该测试项目没有引用产物，Layer 1 区为空——如实，不编造）
    expect(markdown).toContain("已审阅章节：7 / 9 节");
    expect(markdown).toContain("### 严重（Critical）（1 条）");
    // 405：POST 不允许
    const wrongMethod = await fetch(`http://127.0.0.1:${stack.port()}/api/projects/${projectId}/paper-review/export.md`, {
      method: "POST",
    });
    expect(wrongMethod.status).toBe(405);
  });
});
