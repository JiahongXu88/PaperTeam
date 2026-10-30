/**
 * M15.16 P0-B — CJIG 7 份 PDF 参考文献统计回归。
 *
 * fixture（fixtures/cjigPdfReferenceStats.json，脱敏：无 rawText/title）由
 * scripts/m1516/build-cjig-fixture.mjs 从 M15.15 许可样本生成；金标准 =
 * M15.15 phase-b GOLD_STANDARD.md（465 条 / DOI 405/407）。
 *
 * - 确定性部分（恒跑）：fixture 与金标准一致、逐条数据与聚合口径自洽、
 *   区间判定（checkRequirement pdf 口径）在真实统计上行为正确；
 * - 本地样本存在时（D:\PaperTeamData\M15\M15_15）：重跑生产链路对拍 fixture
 *   （CI 无样本 → skip，不伪造通过）。
 */

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { evaluateCompliance } from "../../src/target/TargetGuidelineService.js";
import type { GuidelineFacts, ReferenceObservation } from "../../src/target/guidelineFacts.js";
import type { VenueGuidelineArtifact } from "../../src/target/guidelineTypes.js";

const execFileAsync = promisify(execFile);
const FIXTURE_PATH = resolve(import.meta.dirname, "fixtures", "cjigPdfReferenceStats.json");
const SAMPLES_DIR = "D:\\PaperTeamData\\M15\\M15_15\\phase-b\\samples";

interface FixtureEntry {
  number: number | null;
  year: number | null;
  hasDoi: boolean;
  hasArxiv: boolean;
}

interface FixtureSample {
  sample: string;
  entries: FixtureEntry[];
  stats: ReferenceObservation | null;
  extractorNotes: string[];
}

const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as {
  samples: FixtureSample[];
  extractorVersion: string;
  evalYear: number;
};

function cjigGuideline(): VenueGuidelineArtifact {
  return {
    schemaVersion: 1,
    venueId: "cjig",
    displayName: "中国图象图形学报",
    identity: { issnPrint: "1006-8961", officialSite: "http://www.cjig.cn/" },
    scope: {},
    requirements: [
      { id: "cjig-refs-15", field: "references.count", operator: "min", value: 15, unit: "条", hard: true, officialQuote: "数量要求 15 篇以上", sourceUrl: "http://www.cjig.cn/zh/info/13448/", confidence: "high" },
      { id: "cjig-refs-recent", field: "references.recent10yRatio", operator: "ratio_min", value: 0.6, hard: true, officialQuote: "近 10 年的参考文献应占 60% 以上", sourceUrl: "http://www.cjig.cn/zh/info/13448/", confidence: "high" },
      { id: "cjig-refs-doi", field: "references.doiCoverage", operator: "presence_all", hard: true, officialQuote: "所有参考文献请提供 DOI", sourceUrl: "http://www.cjig.cn/zh/info/13448/", confidence: "high" },
    ],
    provenance: { sourceUrls: ["http://www.cjig.cn/zh/info/13448/"], accessDate: "2026-10-28", confidence: "high" },
    frozenAt: "2026-10-28T00:00:00.000Z",
  };
}

function pdfFactsOf(stats: ReferenceObservation): GuidelineFacts {
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
    references: stats,
    bibSource: null,
  };
}

describe("CJIG 7 份 PDF 参考文献统计回归（M15.16 fixture）", () => {
  it("合计口径与 M15.15 金标准一致：465 条 / DOI 405（已知 2 条缺失见金标准）", () => {
    expect(fixture.samples).toHaveLength(7);
    const totalEntries = fixture.samples.reduce((sum, s) => sum + s.entries.length, 0);
    const totalDoi = fixture.samples.reduce((sum, s) => sum + s.entries.filter((e) => e.hasDoi).length, 0);
    expect(totalEntries).toBe(465);
    expect(totalDoi).toBe(405);
  });

  it("逐条数据与聚合 stats 自洽（entryCount/withDoi/withYear/yearUnparsed 分母口径）", () => {
    for (const sample of fixture.samples) {
      const stats = sample.stats;
      expect(stats, sample.sample).not.toBeNull();
      expect(stats?.entryCount, sample.sample).toBe(sample.entries.length);
      expect(stats?.withDoiCount, sample.sample).toBe(sample.entries.filter((e) => e.hasDoi).length);
      const withYear = sample.entries.filter((e) => e.year !== null);
      expect(stats?.withYearCount, sample.sample).toBe(withYear.length);
      expect(stats?.yearUnparsedCount, sample.sample).toBe(sample.entries.length - withYear.length);
      expect(stats?.doiUnidentifiableCount, sample.sample).toBe(
        sample.entries.length - sample.entries.filter((e) => e.hasDoi).length,
      );
      // CJIG author-year 著录年份解析全覆盖（M15.15 版式实测——回归锁定的关键事实）
      expect(stats?.style, sample.sample).toBe("author-year");
      expect(stats?.withYearCount, sample.sample).toBe(sample.entries.length);
    }
  });

  it("真实统计上的官方条款判定：数量 PASS；年份全解析 → 区间退化点估计；DOI 缺 2 类 → NOT_EVALUATED 不误判", () => {
    // case-R：41 条 / 39 DOI / recent 33（80%）——数量与年份 PASS；DOI 39/41 → NOT_EVALUATED
    const caseR = fixture.samples.find((s) => s.sample === "case-R")!.stats!;
    const report = evaluateCompliance(cjigGuideline(), pdfFactsOf(caseR), {
      evaluatedAt: "2026-10-31T00:00:00.000Z",
      manuscriptRevision: null,
    });
    const byId = new Map(report.checks.map((check) => [check.requirementId, check.status]));
    expect(byId.get("cjig-refs-15")).toBe("PASS");
    expect(byId.get("cjig-refs-recent")).toBe("PASS");
    expect(byId.get("cjig-refs-doi")).toBe("NOT_EVALUATED");
    const doiCheck = report.checks.find((check) => check.requirementId === "cjig-refs-doi");
    expect(doiCheck?.reason).toBe("pdf_doi_coverage_indeterminate");
    expect(doiCheck?.observed).toContain("39/41");
  });

  it("已知 DOI 未识别 2 条形态如实呈现（200544 一条机构作者条目 / 220670 一条断行并入）", () => {
    const s200544 = fixture.samples.find((s) => s.sample === "10_11834_jig_200544")!.stats!;
    expect(s200544.entryCount).toBe(19);
    expect(s200544.withDoiCount).toBe(15); // 金标准 DOI 终止符 16——1 条机构作者条目未并入（精度优先，不放宽）
    const s220670 = fixture.samples.find((s) => s.sample === "10_11834_jig_220670")!.stats!;
    expect(s220670.withDoiCount).toBe(87); // 金标准 88——1 条断行并入（已知形态）
  });
});

describe.skipIf(!existsSync(SAMPLES_DIR))("CJIG PDF 本地对拍（样本存在时重跑生产链路）", () => {
  it("代表样本（case-R author-year / 200544 DOI 缺失形态）重提取统计与 fixture 一致", async () => {
    const { assemblePaper } = await import("../../src/paper/sectionChunking.js");
    const { PyMuPdfParser } = await import("../../src/paper/PdfParser.js");
    const { pdfReferenceStatsOf } = await import("../../src/target/guidelineFacts.js");
    const parser = new PyMuPdfParser({ log: () => {} });
    for (const name of ["case-R.pdf", "10_11834_jig_200544.pdf"]) {
      const extraction = await parser.parseFile(join(SAMPLES_DIR, name));
      const assembled = assemblePaper(extraction);
      const { references } = pdfReferenceStatsOf(assembled, fixture.evalYear);
      const expected = fixture.samples.find((s) => s.sample === name.replace(/\.pdf$/, ""))!.stats!;
      expect(references?.entryCount, name).toBe(expected.entryCount);
      expect(references?.withDoiCount, name).toBe(expected.withDoiCount);
      expect(references?.withYearCount, name).toBe(expected.withYearCount);
      expect(references?.recent10yCount, name).toBe(expected.recent10yCount);
    }
    void execFileAsync;
  });
});
