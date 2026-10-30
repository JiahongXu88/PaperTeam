/**
 * TargetGuidelineService / guidelineFacts / TargetRubricService（M15.9 G1/G2）单元测试。
 *
 * 覆盖：
 * - guidelineFacts 确定性提取（题目/关键词/摘要结构/bib 统计；观测缺失如实 null）；
 * - evaluateCompliance 逐字段 PASS/VIOLATION/NOT_EVALUATED/ADVISORY + venue 差分
 *   （22 字标题：CJIG(≤20) VIOLATION / CEA(≤25) PASS）；
 * - import_ 校验（无 officialQuote 拒绝；accessDate 非法拒绝）+ 覆盖式冻结；
 * - 损坏工件 fail-closed；
 * - rubric：scripted 模型（成功/repair/失败转整体 INSUFFICIENT/未配置）；
 *   prompt 泄漏守卫（不含 mutation/变异 字样）；A2/A3 带差分；fingerprint 稳定。
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { TargetGuidelineService, evaluateCompliance } from "../../src/target/TargetGuidelineService.js";
import { TargetRubricService } from "../../src/target/TargetRubricService.js";
import { bibStatsOf, extractKeywords, extractTitle, observeGuidelineFacts } from "../../src/target/guidelineFacts.js";
import type { GuidelineComplianceReport, VenueGuidelineArtifact, VenueGuidelineRequirement } from "../../src/target/guidelineTypes.js";
import type { GuidelineFacts } from "../../src/target/guidelineFacts.js";
import type { TargetSummaryModel } from "../../src/target/TargetProfileService.js";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

// ---- 测试指南工件（数值全部来自 phase-b 冻结证据的官方明文）----

function cjigGuideline(): VenueGuidelineArtifact {
  return {
    schemaVersion: 1,
    venueId: "cjig",
    displayName: "中国图象图形学报",
    identity: { issnPrint: "1006-8961", officialSite: "http://www.cjig.cn/" },
    scope: {
      scopeStatement: "国内唯一一本全面报道与计算机图像图形学相关研究成果的专业学术期刊",
      columnsZh: ["图像处理与编码", "图像分析与识别", "图像理解与计算机视觉"],
      quote: "常设栏目：图像处理与编码、图像分析与识别、图像理解与计算机视觉…",
      sourceUrl: "http://www.cjig.cn/zh/info/24920/",
    },
    requirements: [
      { id: "cjig-title-20", field: "title.maxLengthZh", operator: "max", value: 20, unit: "汉字", hard: true, officialQuote: "中文题目的字数一般不多于 20 个汉字", sourceUrl: "http://www.cjig.cn/zh/info/13448/", confidence: "high" },
      { id: "cjig-kw-58", field: "keywords.count", operator: "presence", hard: true, officialQuote: "一般可选 5～8 个关键词", sourceUrl: "http://www.cjig.cn/zh/info/13448/", confidence: "high" },
      { id: "cjig-abs-struct", field: "abstract.structuredZh4", operator: "presence_all", hard: true, officialQuote: "中文摘要请按照“目的”、“方法”、“结果”、“结论”为小标题逐项撰写", sourceUrl: "http://www.cjig.cn/zh/info/13448/", confidence: "high" },
      { id: "cjig-abs-500", field: "abstract.lengthZh", operator: "approx_range", value: 500, unit: "字", hard: false, officialQuote: "字数在 500 字左右", sourceUrl: "http://www.cjig.cn/zh/info/13448/", confidence: "high" },
      { id: "cjig-refs-15", field: "references.count", operator: "min", value: 15, unit: "条", hard: true, officialQuote: "数量要求 15 篇以上", sourceUrl: "http://www.cjig.cn/zh/info/13448/", confidence: "high" },
      { id: "cjig-refs-recent", field: "references.recent10yRatio", operator: "ratio_min", value: 0.6, hard: true, officialQuote: "近 10 年的参考文献应占 60% 以上", sourceUrl: "http://www.cjig.cn/zh/info/13448/", confidence: "high" },
      { id: "cjig-refs-doi", field: "references.doiCoverage", operator: "presence_all", hard: true, officialQuote: "所有参考文献请提供 DOI", sourceUrl: "http://www.cjig.cn/zh/info/13448/", confidence: "high" },
      { id: "cjig-fig-300dpi", field: "figures.resolutionDpi", operator: "min", value: 300, hard: true, officialQuote: "分辨率在 300dpi 以上", sourceUrl: "http://www.cjig.cn/zh/info/13448/", confidence: "high" },
    ],
    provenance: { sourceUrls: ["http://www.cjig.cn/zh/info/13448/"], accessDate: "2026-10-28", confidence: "high" },
    frozenAt: "2026-10-28T00:00:00.000Z",
  };
}

function ceaGuideline(): VenueGuidelineArtifact {
  return {
    schemaVersion: 1,
    venueId: "cea",
    displayName: "计算机工程与应用",
    identity: { issnPrint: "1002-8331", officialSite: "http://cea.ceaj.org/" },
    scope: {
      scopeStatement: "面向计算机全行业的综合性学术期刊",
      columnsZh: ["热点与综述", "理论与研发", "模式识别与人工智能", "图形图像处理", "网络、通信与安全", "工程与应用"],
      quote: "主要栏目：热点与综述，理论与研发，模式识别与人工智能，图形图像处理，大数据与云计算，网络、通信与安全，工程与应用等",
      sourceUrl: "http://cea.ceaj.org/CN/column/column16.shtml",
    },
    requirements: [
      { id: "cea-title-25", field: "title.maxLengthZh", operator: "max", value: 25, unit: "字", hard: true, officialQuote: "题名（一般不宜超过25字）", sourceUrl: "http://cea.ceaj.org/CN/column/column16.shtml", confidence: "high" },
      { id: "cea-len-7500", field: "manuscript.lengthWords", operator: "min", value: 7500, unit: "字", hard: false, officialQuote: "对于一般论文建议 7500 字以上为宜", sourceUrl: "http://cea.ceaj.org/CN/column/column16.shtml", confidence: "high" },
    ],
    provenance: { sourceUrls: ["http://cea.ceaj.org/CN/column/column16.shtml"], accessDate: "2026-10-28", confidence: "high" },
    frozenAt: "2026-10-28T00:00:00.000Z",
  };
}

// ---- 手稿工厂 ----

interface ManuscriptSpec {
  title: string;
  keywords?: string;
  abstract?: string;
  bodyWords?: number;
  bib: string[];
}

async function setupProjectWithManuscript(spec: ManuscriptSpec): Promise<{ store: ProjectStore; projectId: string }> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-guid-"));
  roots.push(root);
  const store = new ProjectStore({ root });
  const project = await store.create("指南符合度测试", { documentType: "survey" });
  const manuscriptDir = store.manuscriptDir(project.id);
  await mkdir(join(manuscriptDir, "sections"), { recursive: true });
  await writeFile(
    join(manuscriptDir, "main.tex"),
    [
      "\\documentclass[UTF8]{ctexart}",
      `\\title{${spec.title}}`,
      "\\begin{document}",
      "\\maketitle",
      spec.abstract !== undefined ? "\\begin{abstract}\n" + spec.abstract + "\n\\end{abstract}" : "",
      spec.keywords !== undefined ? `\\keywords{${spec.keywords}}` : "",
      "\\input{sections/introduction}",
      "\\bibliographystyle{unsrt}",
      "\\bibliography{references}",
      "\\end{document}",
    ]
      .filter((line) => line !== "")
      .join("\n"),
    "utf8",
  );
  const filler = "多目标跟踪评测需要覆盖检测与关联两个子任务的误差度量。".repeat(Math.max(1, Math.ceil((spec.bodyWords ?? 400) / 30)));
  await writeFile(join(manuscriptDir, "sections", "introduction.tex"), `${filler}\n`, "utf8");
  await writeFile(join(manuscriptDir, "references.bib"), spec.bib.join("\n"), "utf8");
  return { store, projectId: project.id };
}

function bibEntries(count: number, options: { recentRatio?: number; withDoi?: boolean } = {}): string[] {
  const recentRatio = options.recentRatio ?? 1;
  const withDoi = options.withDoi ?? true;
  const entries: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const recent = index < Math.round(count * recentRatio);
    const year = recent ? 2023 : 2010;
    entries.push(
      [
        `@article{k${index},`,
        `  title = {Reference ${index}},`,
        `  journal = {Journal},`,
        `  year = {${year}},`,
        withDoi ? `  doi = {10.1/x${index}}` : "",
        "}",
      ]
        .filter((line) => line !== "")
        .join("\n"),
    );
  }
  return entries;
}

const STRUCTURED_ABSTRACT = [
  "【目的】梳理多目标跟踪评测指标体系。",
  "【方法】对照分析经典指标与分解指标。",
  "【结果】给出各指标的互补性定量比较结果与适用边界。",
  "【结论】标准化指标元评估是未来方向。",
].join("\n");

// ============================================================

describe("guidelineFacts 确定性提取", () => {
  it("题目/关键词/摘要结构/bib 统计全部可提取；口径披露", async () => {
    const { store, projectId } = await setupProjectWithManuscript({
      title: "多目标跟踪评测指标综述",
      keywords: "多目标跟踪；评测指标；基准协议",
      abstract: STRUCTURED_ABSTRACT,
      bib: bibEntries(6),
    });
    const facts = await observeGuidelineFacts(store, projectId, { evalYear: 2026 });
    expect(facts.exists).toBe(true);
    expect(facts.titleCjkChars).toBe(11);
    expect(facts.keywordCount).toBe(3);
    expect(facts.keywords).toEqual(["多目标跟踪", "评测指标", "基准协议"]);
    expect(facts.abstractStructured).toEqual({ purpose: true, method: true, result: true, conclusion: true });
    expect(facts.abstractCjkChars).toBeGreaterThan(30);
    expect(facts.references).toMatchObject({ entryCount: 6, recent10yRatio: 1, doiCoverageRatio: 1 });
    expect(facts.bibSource).toBe("file");
  });

  it("观测缺失如实 null（无 abstract 环境 / 无关键词块 / 无 bib）", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperteam-guid-"));
    roots.push(root);
    const store = new ProjectStore({ root });
    const project = await store.create("空手稿");
    await mkdir(join(store.manuscriptDir(project.id)), { recursive: true });
    await writeFile(join(store.manuscriptDir(project.id), "main.tex"), "\\title{空}\n\\begin{document}\\end{document}", "utf8");
    const facts = await observeGuidelineFacts(store, project.id);
    expect(facts.exists).toBe(true);
    expect(facts.abstractStructured).toBeNull();
    expect(facts.keywordCount).toBeNull();
    expect(facts.references).toBeNull();
  });

  it("无 .tex → exists=false（不 crash）", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperteam-guid-"));
    roots.push(root);
    const store = new ProjectStore({ root });
    const project = await store.create("无手稿");
    const facts = await observeGuidelineFacts(store, project.id);
    expect(facts.exists).toBe(false);
  });

  it("纯函数：extractTitle/extractKeywords/bibStatsOf", () => {
    expect(extractTitle([{ content: "\\title{基于深度学习的图像分割方法研究}" }])).toBe("基于深度学习的图像分割方法研究");
    expect(extractKeywords([{ content: "\\keywords{图像分割, 深度学习; 卷积神经网络}" }])).toEqual(["图像分割", "深度学习", "卷积神经网络"]);
    expect(extractKeywords([{ content: "关键词：图像分割；深度学习\n" }])).toEqual(["图像分割", "深度学习"]);
    const stats = bibStatsOf(bibEntries(10, { recentRatio: 0.5, withDoi: false }).join("\n"), 2026);
    expect(stats.entryCount).toBe(10);
    expect(stats.recent10yRatio).toBe(0.5);
    expect(stats.doiCoverageRatio).toBe(0);
  });
});

// ---- M15.16 P0-B：PDF-only 参考文献机检（区间分析 / DOI 不可辨不误判 / 字段无观测点）----

describe("evaluateCompliance PDF-only 参考文献（M15.16）", () => {
  function pdfFacts(references: Partial<NonNullable<GuidelineFacts["references"]>>): GuidelineFacts {
    return {
      exists: true,
      source: "pdf",
      titleRaw: null,
      titleCjkChars: null,
      titleEnWords: null,
      keywordCount: null,
      keywords: null,
      abstractStructured: null,
      abstractCjkChars: null,
      bodyCjkAndWordChars: null,
      references: {
        entryCount: 20,
        withYearCount: 20,
        recent10yCount: 15,
        recent10yRatio: 0.75,
        withDoiCount: 20,
        doiCoverageRatio: 1,
        yearUnparsedCount: 0,
        doiUnidentifiableCount: 0,
        basis: "pdf",
        style: "numeric",
        ...references,
      } as NonNullable<GuidelineFacts["references"]>,
      bibSource: null,
    };
  }

  it("数量/年份/DOI 全覆盖 → 三条 PASS；非参考文献字段 → NOT_EVALUATED（pdf_no_observation_point）", () => {
    const report = evaluateCompliance(cjigGuideline(), pdfFacts({}), {
      evaluatedAt: "2026-10-31T00:00:00.000Z",
      manuscriptRevision: null,
    });
    const byId = new Map(report.checks.map((check) => [check.requirementId, check]));
    expect(byId.get("cjig-refs-15")?.status).toBe("PASS");
    expect(byId.get("cjig-refs-15")?.observed).toContain("PDF ReferenceExtractor 条目口径");
    expect(byId.get("cjig-refs-recent")?.status).toBe("PASS");
    expect(byId.get("cjig-refs-recent")?.observed).toContain("区间分析");
    expect(byId.get("cjig-refs-doi")?.status).toBe("PASS");
    expect(byId.get("cjig-refs-doi")?.observed).toContain("全部辨识出 DOI");
    // 题目/关键词/摘要/正文字段：PDF-only 无观测点（缺要素 ≠ 违规）
    for (const id of ["cjig-title-20", "cjig-kw-58", "cjig-abs-struct", "cjig-abs-500"]) {
      expect(byId.get(id)?.status).toBe("NOT_EVALUATED");
      expect(byId.get(id)?.reason).toBe("pdf_no_observation_point");
    }
  });

  it("年份区间跨越阈值 → NOT_EVALUATED（pdf_year_parse_indeterminate）；区间全低 → VIOLATION；区间全高 → PASS", () => {
    // 20 条：8 条近年可析 + 8 条旧 + 4 条年份未解析 → low=0.4, high=0.6 → 跨越 0.6
    const crossing = evaluateCompliance(
      cjigGuideline(),
      pdfFacts({ entryCount: 20, withYearCount: 16, recent10yCount: 8, recent10yRatio: 0.5, yearUnparsedCount: 4 }),
      { evaluatedAt: "2026-10-31T00:00:00.000Z", manuscriptRevision: null },
    );
    const recentCheck = crossing.checks.find((check) => check.requirementId === "cjig-refs-recent");
    expect(recentCheck?.status).toBe("NOT_EVALUATED");
    expect(recentCheck?.reason).toBe("pdf_year_parse_indeterminate");
    expect(recentCheck?.observed).toContain("[40%, 60%]");
    // 15 条：3 近年 + 12 旧（无未解析）→ 0.2 < 0.6 全区间低于阈值 → VIOLATION
    const allOld = evaluateCompliance(
      cjigGuideline(),
      pdfFacts({ entryCount: 15, withYearCount: 15, recent10yCount: 3, recent10yRatio: 0.2, yearUnparsedCount: 0 }),
      { evaluatedAt: "2026-10-31T00:00:00.000Z", manuscriptRevision: null },
    );
    expect(allOld.checks.find((check) => check.requirementId === "cjig-refs-recent")?.status).toBe("VIOLATION");
    // 10 条：8 近年可析 + 0 近年未解析 2 条 → low=0.8 ≥ 0.6 → PASS（任意取值均达标）
    const allHigh = evaluateCompliance(
      cjigGuideline(),
      pdfFacts({ entryCount: 10, withYearCount: 8, recent10yCount: 8, recent10yRatio: 1, yearUnparsedCount: 2 }),
      { evaluatedAt: "2026-10-31T00:00:00.000Z", manuscriptRevision: null },
    );
    const high = allHigh.checks.find((check) => check.requirementId === "cjig-refs-recent");
    expect(high?.status).toBe("PASS");
    expect(high?.observed).toContain("任意取值均 ≥ 60%");
  });

  it("DOI 部分可辨识 → NOT_EVALUATED（不把解析失败当作者未提供判 VIOLATION）", () => {
    const report = evaluateCompliance(
      cjigGuideline(),
      pdfFacts({ entryCount: 20, withDoiCount: 18, doiCoverageRatio: 0.9, doiUnidentifiableCount: 2 }),
      { evaluatedAt: "2026-10-31T00:00:00.000Z", manuscriptRevision: null },
    );
    const doi = report.checks.find((check) => check.requirementId === "cjig-refs-doi");
    expect(doi?.status).toBe("NOT_EVALUATED");
    expect(doi?.reason).toBe("pdf_doi_coverage_indeterminate");
    expect(doi?.observed).toContain("18/20");
  });

  it("数量不足（PDF 条目口径）→ VIOLATION；参考文献节缺失 → NOT_EVALUATED（no_references_section_on_pdf）", () => {
    const few = evaluateCompliance(
      cjigGuideline(),
      pdfFacts({ entryCount: 10 }),
      { evaluatedAt: "2026-10-31T00:00:00.000Z", manuscriptRevision: null },
    );
    expect(few.checks.find((check) => check.requirementId === "cjig-refs-15")?.status).toBe("VIOLATION");
    const none = evaluateCompliance(
      cjigGuideline(),
      { exists: false, source: null, titleRaw: null, titleCjkChars: null, titleEnWords: null, keywordCount: null, keywords: null, abstractStructured: null, abstractCjkChars: null, bodyCjkAndWordChars: null, references: null, bibSource: null },
      { evaluatedAt: "2026-10-31T00:00:00.000Z", manuscriptRevision: null },
    );
    const refsCheck = none.checks.find((check) => check.requirementId === "cjig-refs-15");
    expect(refsCheck?.status).toBe("NOT_EVALUATED");
    expect(refsCheck?.reason).toBe("no_manuscript_facts");
  });

  it("TeX 存在时 PDF 观测不参与（双输入优先级）：latex facts 走 bib 口径", () => {
    const latexFacts: GuidelineFacts = {
      exists: true,
      source: "latex",
      titleRaw: "多目标跟踪综述",
      titleCjkChars: 8,
      titleEnWords: null,
      keywordCount: 6,
      keywords: ["a", "b", "c", "d", "e", "f"],
      abstractStructured: { purpose: true, method: true, result: true, conclusion: true },
      abstractCjkChars: 500,
      bodyCjkAndWordChars: 9000,
      references: bibStatsOf(
        ["@article{a, title={A}, year={2024}, doi={10.1/x}}", "@article{b, title={B}, year={2020}}"].join("\n"),
        2026,
      ),
      bibSource: "file",
    };
    const report = evaluateCompliance(cjigGuideline(), latexFacts, {
      evaluatedAt: "2026-10-31T00:00:00.000Z",
      manuscriptRevision: null,
    });
    const doi = report.checks.find((check) => check.requirementId === "cjig-refs-doi");
    // bib 口径：1/2 有 doi 字段 → 精确判定 VIOLATION（非 PDF 的 NOT_EVALUATED）
    expect(doi?.status).toBe("VIOLATION");
    expect(doi?.observed).not.toContain("不可区分");
  });
});

describe("evaluateCompliance 逐字段判定 + venue 差分", () => {
  function factsOf(overrides: Partial<GuidelineFacts>): GuidelineFacts {
    return {
      exists: true,
      source: "latex",
      titleRaw: "多目标跟踪评测指标综述",
      titleCjkChars: 11,
      titleEnWords: null,
      keywordCount: 5,
      keywords: ["a", "b", "c", "d", "e"],
      abstractStructured: { purpose: true, method: true, result: true, conclusion: true },
      abstractCjkChars: 480,
      bodyCjkAndWordChars: 8000,
      references: { entryCount: 20, withYearCount: 20, recent10yCount: 18, recent10yRatio: 0.9, withDoiCount: 20, doiCoverageRatio: 1 },
      bibSource: "file",
      ...overrides,
    };
  }

  it("合规稿：CJIG 全 PASS（300dpi 等无检查器字段 NOT_EVALUATED）", () => {
    const report = evaluatePure(cjigGuideline(), factsOf({}));
    expect(report.summary.hardViolations).toBe(0);
    expect(report.summary.topStatus).toBe("COMPLIANT");
    const byId = new Map(report.checks.map((check) => [check.requirementId, check.status]));
    expect(byId.get("cjig-title-20")).toBe("PASS");
    expect(byId.get("cjig-refs-15")).toBe("PASS");
    expect(byId.get("cjig-fig-300dpi")).toBe("NOT_EVALUATED");
    const dpi = report.checks.find((check) => check.requirementId === "cjig-fig-300dpi");
    expect(dpi?.reason).toBe("no_deterministic_checker");
  });

  it("venue 差分：22 字标题 → CJIG VIOLATION / CEA PASS（F1 预期锁定）", () => {
    const facts = factsOf({ titleRaw: "多目标跟踪评测指标体系演进与适用边界研究综述", titleCjkChars: 22 });
    const cjig = evaluatePure(cjigGuideline(), facts);
    const cea = evaluatePure(ceaGuideline(), facts);
    expect(cjig.summary.hardViolations).toBe(1);
    expect(cjig.checks.find((check) => check.requirementId === "cjig-title-20")?.status).toBe("VIOLATION");
    expect(cea.summary.hardViolations).toBe(0);
    expect(cea.checks.find((check) => check.requirementId === "cea-title-25")?.status).toBe("PASS");
  });

  it("关键词 3 个 → CJIG VIOLATION（hard）；要素缺失（无关键词块）→ 硬性要求判 VIOLATION、软性保持 NOT_EVALUATED", () => {
    const tooFew = evaluatePure(cjigGuideline(), factsOf({ keywordCount: 3 }));
    expect(tooFew.checks.find((check) => check.requirementId === "cjig-kw-58")?.status).toBe("VIOLATION");
    const none = evaluatePure(cjigGuideline(), factsOf({ keywordCount: null, keywords: null }));
    expect(none.checks.find((check) => check.requirementId === "cjig-kw-58")?.status).toBe("VIOLATION");
    expect(none.checks.find((check) => check.requirementId === "cjig-kw-58")?.observed).toContain("论文要素缺失");
    const softGuideline = cjigGuideline();
    softGuideline.requirements = softGuideline.requirements.map((r) => (r.id === "cjig-kw-58" ? { ...r, hard: false } : r));
    const softNone = evaluatePure(softGuideline, factsOf({ keywordCount: null, keywords: null }));
    expect(softNone.checks.find((check) => check.requirementId === "cjig-kw-58")?.status).toBe("NOT_EVALUATED");
  });

  it("摘要非结构化 → VIOLATION；摘要 900 字（超建议带）→ ADVISORY 不 VIOLATION", () => {
    const unstructured = evaluatePure(cjigGuideline(), factsOf({ abstractStructured: { purpose: false, method: false, result: false, conclusion: false } }));
    expect(unstructured.checks.find((check) => check.requirementId === "cjig-abs-struct")?.status).toBe("VIOLATION");
    const long = evaluatePure(cjigGuideline(), factsOf({ abstractCjkChars: 900 }));
    const absLength = long.checks.find((check) => check.requirementId === "cjig-abs-500");
    expect(absLength?.status).toBe("ADVISORY");
  });

  it("参考文献 8 条 / 近 10 年 45% / DOI 覆盖 50% → 三个 VIOLATION", () => {
    const report = evaluatePure(
      cjigGuideline(),
      factsOf({ references: { entryCount: 8, withYearCount: 8, recent10yCount: 3, recent10yRatio: 0.38, withDoiCount: 4, doiCoverageRatio: 0.5 } }),
    );
    expect(report.summary.hardViolations).toBeGreaterThanOrEqual(3);
    expect(report.checks.find((check) => check.requirementId === "cjig-refs-15")?.status).toBe("VIOLATION");
    expect(report.checks.find((check) => check.requirementId === "cjig-refs-recent")?.status).toBe("VIOLATION");
    expect(report.checks.find((check) => check.requirementId === "cjig-refs-doi")?.status).toBe("VIOLATION");
  });

  it("无手稿 → 全部 NOT_EVALUATED → topStatus=NOT_EVALUATED_ONLY", () => {
    const report = evaluatePure(cjigGuideline(), { exists: false, source: null, titleRaw: null, titleCjkChars: null, titleEnWords: null, keywordCount: null, keywords: null, abstractStructured: null, abstractCjkChars: null, bodyCjkAndWordChars: null, references: null, bibSource: null });
    expect(report.summary.notEvaluatedCount).toBe(report.checks.length);
    expect(report.summary.topStatus).toBe("NOT_EVALUATED_ONLY");
  });

  it("中文题目 → 英文实词条款 NOT_EVALUATED（not_applicable_zh_title）", () => {
    void evaluatePure(cjigGuideline(), factsOf({}));
    // cjigGuideline 未含英文条款；补一条内联验证
    const withEn: VenueGuidelineArtifact = {
      ...cjigGuideline(),
      requirements: [
        ...cjigGuideline().requirements,
        { id: "cjig-title-en", field: "title.maxLengthEnWords", operator: "max", value: 10, hard: true, officialQuote: "英文题目的字数一般不超过 10 个实词", sourceUrl: "http://www.cjig.cn/zh/info/13448/", confidence: "high" },
      ],
    };
    const zh = evaluatePure(withEn, factsOf({}));
    expect(zh.checks.find((check) => check.requirementId === "cjig-title-en")?.reason).toBe("not_applicable_zh_title");
    const en = evaluatePure(withEn, factsOf({ titleCjkChars: 0, titleRaw: "Deep Survey of Multi Object Tracking Metrics", titleEnWords: 7 }));
    expect(en.checks.find((check) => check.requirementId === "cjig-title-en")?.status).toBe("PASS");
  });
});

function evaluatePure(guideline: VenueGuidelineArtifact, facts: GuidelineFacts): GuidelineComplianceReport {
  return evaluateCompliance(guideline, facts, { evaluatedAt: "2026-10-28T00:00:00.000Z", manuscriptRevision: 1 });
}

describe("TargetGuidelineService 工件生命周期", () => {
  it("import_ 校验：无 officialQuote / 非法 accessDate → INVALID_REQUEST", async () => {
    const { store, projectId } = await setupProjectWithManuscript({ title: "t", bib: bibEntries(2) });
    const service = new TargetGuidelineService({ projects: store });
    const bad = cjigGuideline();
    bad.requirements = [{ ...(bad.requirements[0] as VenueGuidelineRequirement), officialQuote: "" }];
    await expect(service.import_(projectId, bad)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const badDate = cjigGuideline();
    badDate.provenance = { ...badDate.provenance, accessDate: "yesterday" };
    await expect(service.import_(projectId, badDate)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("import → get 幂等读；evaluate 落盘报告；损坏 fail-closed", async () => {
    const { store, projectId } = await setupProjectWithManuscript({
      title: "多目标跟踪评测指标综述",
      keywords: "多目标跟踪；评测指标；基准协议；多目标跟踪精度；身份一致性",
      abstract: STRUCTURED_ABSTRACT,
      bib: bibEntries(18),
    });
    const service = new TargetGuidelineService({ projects: store });
    await service.import_(projectId, cjigGuideline());
    const stored = await service.get(projectId);
    expect(stored?.venueId).toBe("cjig");
    expect((await service.getReport(projectId))).toBeNull();
    const report = await service.evaluate(projectId, { manuscriptRevision: 3 });
    expect(report.summary.hardViolations).toBe(0);
    expect(report.manuscriptRevision).toBe(3);
    expect((await service.getReport(projectId))?.summary.topStatus).toBe("COMPLIANT");
    // 损坏 fail-closed
    const { writeFile: write } = await import("node:fs/promises");
    await write(join(store.researchDir(projectId), "target-guideline.json"), "{oops", "utf8");
    await expect(service.get(projectId)).rejects.toMatchObject({ code: "TARGET_GUIDELINE_CORRUPTED" });
  });

  it("未导入 → get null / evaluate NotFound", async () => {
    const { store, projectId } = await setupProjectWithManuscript({ title: "t", bib: bibEntries(2) });
    const service = new TargetGuidelineService({ projects: store });
    expect(await service.get(projectId)).toBeNull();
    await expect(service.evaluate(projectId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ============================================================

const VALID_RUBRIC_JSON = JSON.stringify({
  dimensions: [
    { dimension: "novelty", verdict: "ADEQUATE", evidenceQuotes: ["本文系统梳理 2015—2025 年 MOT 评测体系的发展脉络"], gaps: [], needsExpertReview: true },
    { dimension: "contribution", verdict: "ADEQUATE", evidenceQuotes: ["归纳经典指标与分解指标研究的覆盖空缺"], gaps: [], needsExpertReview: true },
    { dimension: "technicalSoundness", verdict: "ADEQUATE", evidenceQuotes: ["对照分析"], gaps: [], needsExpertReview: false },
    { dimension: "experimentalAdequacy", verdict: "ADEQUATE", evidenceQuotes: ["综述围绕基准协议构建"], gaps: [], needsExpertReview: false },
    { dimension: "relevance", verdict: "STRONG", evidenceQuotes: ["多目标跟踪"], gaps: [], needsExpertReview: false },
    { dimension: "clarity", verdict: "ADEQUATE", evidenceQuotes: ["对照分析"], gaps: [], needsExpertReview: false },
  ],
  scopeRelevance: { inScope: true, evidence: "图像理解与计算机视觉栏目覆盖跟踪评测", columnMatch: "图像理解与计算机视觉" },
  overall: { verdict: "NEEDS_EXPERT_REVIEW", rationale: "综述覆盖充分，创新性需专家复核" },
});

function scriptedRubricModel(outputs: readonly string[]): TargetSummaryModel & { prompts(): string[] } {
  const prompts: string[] = [];
  const model = {
    caller: {
      async completeSimple(_model: unknown, context: { messages: unknown[] }) {
        const text = JSON.stringify(context.messages);
        prompts.push(text);
        const output = outputs[Math.min(prompts.length - 1, outputs.length - 1)] ?? "";
        return { content: [{ type: "text", text: output }], stopReason: "stop" };
      },
    },
    catalogEntry: { id: "fake-rubric-model" },
    spec: "fake-rubric-model@test",
    prompts: () => prompts,
  };
  return model as TargetSummaryModel & { prompts(): string[] };
}

describe("TargetRubricService（G2，advisory）", () => {
  it("成功：六维 + scope + overall 落盘；novelty/contribution 强制 needsExpertReview", async () => {
    const model = scriptedRubricModel([VALID_RUBRIC_JSON]);
    const { store, projectId } = await setupProjectWithManuscript({
      title: "多目标跟踪评测指标综述",
      abstract: STRUCTURED_ABSTRACT,
      bib: bibEntries(4),
    });
    const service = new TargetRubricService({ projects: store, rubricModel: model });
    const artifact = await service.evaluate(projectId, cjigGuideline(), { manuscriptRevision: 2 });
    expect(artifact.dimensions).toHaveLength(6);
    const novelty = artifact.dimensions.find((dim) => dim.dimension === "novelty");
    expect(novelty?.needsExpertReview).toBe(true);
    expect(artifact.scopeRelevance.inScope).toBe(true);
    expect(artifact.provenance.basis).toBe("model_judgment_advisory");
    expect(artifact.withBenchmarkBands).toBe(true);
    expect(await service.get(projectId)).not.toBeNull();
  });

  it("prompt 泄漏守卫：不含变异/mutation/family 字样；携带范围陈述与栏目；A3 不带 benchmark 块", async () => {
    const model = scriptedRubricModel([VALID_RUBRIC_JSON, VALID_RUBRIC_JSON]);
    const { store, projectId } = await setupProjectWithManuscript({ title: "多目标跟踪评测指标综述", bib: bibEntries(4) });
    const service = new TargetRubricService({ projects: store, rubricModel: model });
    await service.evaluate(projectId, cjigGuideline());
    const a2Prompt = model.prompts()[0] ?? "";
    expect(a2Prompt).toContain("图像理解与计算机视觉");
    expect(a2Prompt).toContain("文章类型：survey");
    expect(/变异|mutation|family/.test(a2Prompt)).toBe(false);
    // A3：omitBenchmarkBands → prompt 不含 benchmark 带节（稿件摘录节保留）
    await service.evaluate(projectId, cjigGuideline(), { omitBenchmarkBands: true });
    const a3Prompt = model.prompts()[1] ?? "";
    expect(a3Prompt.includes("目标带参照")).toBe(false);
    expect(a3Prompt.includes("benchmark profile 不存在")).toBe(false);
    const a3Artifact = await service.get(projectId);
    expect(a3Artifact?.withBenchmarkBands).toBe(false);
  });

  it("结构化校验失败 1 次 repair 成功 / 两次失败 → 整体 INSUFFICIENT_EVIDENCE + summaryFailure", async () => {
    const repair = scriptedRubricModel(["not-json", VALID_RUBRIC_JSON]);
    const fail = scriptedRubricModel(["not-json", "still-not-json"]);
    const { store, projectId } = await setupProjectWithManuscript({ title: "多目标跟踪评测指标综述", bib: bibEntries(4) });
    const ok = await new TargetRubricService({ projects: store, rubricModel: repair }).evaluate(projectId, cjigGuideline());
    expect(ok.dimensions).toHaveLength(6);
    const root2 = await mkdtemp(join(tmpdir(), "paperteam-guid-"));
    roots.push(root2);
    const store2 = new ProjectStore({ root: root2 });
    const project2 = await store2.create("失败腿", { documentType: "survey" });
    const manuscriptDir = store2.manuscriptDir(project2.id);
    await mkdir(manuscriptDir, { recursive: true });
    await writeFile(join(manuscriptDir, "main.tex"), "\\title{x}\n\\begin{document}y\\end{document}", "utf8");
    const failed = await new TargetRubricService({ projects: store2, rubricModel: fail }).evaluate(project2.id, cjigGuideline());
    expect(failed.overall.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(failed.summaryFailure).toBeTruthy();
  });

  it("未配置模型 → 整体 INSUFFICIENT_EVIDENCE（不伪造）；无手稿 → NotFound", async () => {
    const { store, projectId } = await setupProjectWithManuscript({ title: "多目标跟踪评测指标综述", bib: bibEntries(4) });
    const none = await new TargetRubricService({ projects: store }).evaluate(projectId, cjigGuideline());
    expect(none.overall.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(none.summaryFailure).toContain("未配置");
    const root2 = await mkdtemp(join(tmpdir(), "paperteam-guid-"));
    roots.push(root2);
    const store2 = new ProjectStore({ root: root2 });
    const project2 = await store2.create("无手稿");
    await expect(new TargetRubricService({ projects: store2 }).evaluate(project2.id, cjigGuideline())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("输出缺维 → 如实补 INSUFFICIENT_EVIDENCE（不发明）", async () => {
    const partial = JSON.stringify({
      dimensions: [JSON.parse(VALID_RUBRIC_JSON).dimensions[0]],
      scopeRelevance: { inScope: null, evidence: "范围陈述缺失" },
      overall: { verdict: "INSUFFICIENT_EVIDENCE", rationale: "证据不足" },
    });
    const model = scriptedRubricModel([partial]);
    const { store, projectId } = await setupProjectWithManuscript({ title: "多目标跟踪评测指标综述", bib: bibEntries(4) });
    const artifact = await new TargetRubricService({ projects: store, rubricModel: model }).evaluate(projectId, cjigGuideline());
    expect(artifact.dimensions).toHaveLength(6);
    const filled = artifact.dimensions.filter((dim) => dim.verdict === "INSUFFICIENT_EVIDENCE");
    expect(filled.length).toBeGreaterThanOrEqual(5);
  });
});
