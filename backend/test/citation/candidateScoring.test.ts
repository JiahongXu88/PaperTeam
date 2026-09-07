/**
 * candidateScoring：确定性候选打分（tier / 多版本同一作品 / 字段比对）。无网络。
 */

import { describe, expect, it } from "vitest";

import { compareFields, isPreprintDoi, sameWork, scoreCandidate, surnamesShare } from "../../src/citation/candidateScoring.js";
import type { CanonicalPaperRecord } from "../../src/citation/integrity.js";

const NOW = "2026-09-07T00:00:00.000Z";

function rec(overrides: Partial<CanonicalPaperRecord>): CanonicalPaperRecord {
  return { provider: "openalex", recordId: "W1", retrievedAt: NOW, ...overrides };
}

const DEEP_SORT = rec({
  title: "Simple online and realtime tracking with a deep association metric",
  authors: ["Nicolai Wojke", "Alex Bewley", "Dietrich Paulus"],
  year: 2017,
  doi: "10.1109/icip.2017.8296962",
});
const SORT = rec({
  title: "Simple online and realtime tracking",
  authors: ["Alex Bewley", "Zongyuan Ge", "Lionel Ott", "Fabio Ramos", "Ben Upcroft"],
  year: 2016,
  doi: "10.1109/icip.2016.7533003",
});

describe("scoreCandidate：tier", () => {
  it("DOI 精确相等 → doi tier（标题不同也成立，差异进 mismatch）", () => {
    const score = scoreCandidate({ doi: "10.1109/ICIP.2017.8296962", title: "Totally different title" }, DEEP_SORT);
    expect(score.tier).toBe("doi");
    expect(compareFields({ doi: "10.1109/ICIP.2017.8296962", title: "Totally different title" }, DEEP_SORT).map((m) => m.field)).toEqual(["title"]);
  });

  it("PDF 污染标题 + 缩写作者 + 年份 → strong", () => {
    const score = scoreCandidate(
      { title: "Simple online and realtime tracking with a deep as- sociation metric", authors: ["N. Wojke", "A. Bewley"], year: 2017 },
      DEEP_SORT,
    );
    expect(score.tier).toBe("strong");
    expect(score.titleSimilarity).toBe(1);
    expect(score.firstAuthorMatch).toBe(true);
    expect(score.yearDelta).toBe(0);
  });

  it("【假阳性防线】SORT 查询不能接受 Deep SORT（前缀包含 + 共同作者 + 年份 ±1）", () => {
    const score = scoreCandidate({ title: "Simple online and realtime tracking", authors: ["A. Bewley", "Z. Ge"], year: 2016 }, DEEP_SORT);
    expect(score.tier).toBe("reject");
    expect(score.authorOverlap).toBe(true); // 有作者重合也不够
    expect(score.firstAuthorMatch).toBe(false);
  });

  it("【假阳性防线】ByteTrack 查询不能接受仅含 ByteTrack 关键词的其它论文", () => {
    const other = rec({ title: "ByteTrack for Single Object Segmentation", authors: ["Some One"], year: 2022 });
    const score = scoreCandidate(
      { title: "Byte- track: Multi-object tracking by associating every detection box", authors: ["Y. Zhang"], year: 2022 },
      other,
    );
    expect(score.tier).toBe("reject");
  });

  it("medium：标题 0.8–0.92 需第一作者 + 年份 ±1 同时成立", () => {
    // 标题差一个词（"realtime" → "real time online"）：相似度落在 medium 区间
    const query = { title: "Simple online and realtime tracking with a deep association metrics", authors: ["Wojke N"], year: 2018 };
    const withAuthor = scoreCandidate(query, DEEP_SORT);
    expect(withAuthor.titleSimilarity).toBeGreaterThanOrEqual(0.92); // 只差 1 个字符仍 strong
    const farther = { title: "Online realtime tracking with a deep association metric", authors: ["Wojke N"], year: 2017 };
    const scored = scoreCandidate(farther, DEEP_SORT);
    expect(scored.titleSimilarity).toBeGreaterThanOrEqual(0.8);
    expect(scored.titleSimilarity).toBeLessThan(0.92);
    expect(scored.tier).toBe("medium");
    expect(scoreCandidate({ ...farther, authors: ["Bewley A"] }, DEEP_SORT).tier).toBe("reject"); // 第一作者不符
    expect(scoreCandidate({ ...farther, year: 2020 }, DEEP_SORT).tier).toBe("reject"); // 年份差太多
    expect(scoreCandidate({ ...farther, authors: undefined }, DEEP_SORT).tier).toBe("reject"); // 无作者不能 medium
  });

  it("无标题查询只能靠 DOI 命中", () => {
    expect(scoreCandidate({ authors: ["Wojke"], year: 2017 }, DEEP_SORT).tier).toBe("reject");
    expect(scoreCandidate({ doi: "10.1109/icip.2017.8296962" }, DEEP_SORT).tier).toBe("doi");
  });

  it("rank：年份精确 > 第一作者 > 正式 DOI > 预印本 DOI", () => {
    const query = { title: DEEP_SORT.title!, authors: ["N. Wojke"], year: 2017 };
    const preprint = rec({ ...DEEP_SORT, doi: "10.48550/arxiv.1703.07402", year: 2017 });
    expect(scoreCandidate(query, DEEP_SORT).rank).toBeGreaterThan(scoreCandidate(query, preprint).rank);
    const wrongYear = rec({ ...DEEP_SORT, year: 2018 });
    expect(scoreCandidate(query, DEEP_SORT).rank).toBeGreaterThan(scoreCandidate(query, wrongYear).rank);
    expect(isPreprintDoi("10.48550/arXiv.1703.07402")).toBe(true);
    expect(isPreprintDoi("10.1109/icip.2017.8296962")).toBe(false);
  });
});

describe("sameWork / compareFields / 作者", () => {
  it("预印本与正式发表（同标题 + 同第一作者，年份差 1）是同一作品", () => {
    const preprint = rec({ ...DEEP_SORT, doi: "10.48550/arxiv.1703.07402", year: 2017, provider: "openalex", recordId: "W2" });
    expect(sameWork(DEEP_SORT, preprint)).toBe(true);
    expect(sameWork(DEEP_SORT, SORT)).toBe(false);
    const noAuthors = rec({ title: "Simple Online and Realtime Tracking with a Deep Association Metric", year: 2018 });
    expect(sameWork(DEEP_SORT, noAuthors)).toBe(true);
    expect(sameWork(DEEP_SORT, rec({ ...noAuthors, year: 2020 }))).toBe(false);
  });

  it("compareFields：年份 ±1 容忍，>1 记 mismatch；DOI 大小写无关", () => {
    expect(compareFields({ title: DEEP_SORT.title!, year: 2018 }, DEEP_SORT)).toEqual([]);
    expect(compareFields({ title: DEEP_SORT.title!, year: 2015 }, DEEP_SORT)).toEqual([
      { field: "year", expected: "2015", actual: "2017" },
    ]);
    expect(compareFields({ doi: "10.1109/ICIP.2017.8296962" }, DEEP_SORT)).toEqual([]);
    expect(compareFields({ doi: "10.1109/icip.2016.7533003" }, DEEP_SORT).map((m) => m.field)).toEqual(["doi"]);
  });

  it("姓氏比对：缩写 / 姓前姓后 / 带点", () => {
    expect(surnamesShare("Y. Zhang", "Yifu Zhang")).toBe(true);
    expect(surnamesShare("Zhang Y", "Yifu Zhang")).toBe(true);
    expect(surnamesShare("J. Cao", "Jinkun Cao")).toBe(true);
    expect(surnamesShare("N. Wojke", "Alex Bewley")).toBe(false);
    expect(surnamesShare("A.", "Alex Bewley")).toBe(false); // 只有首字母：没有可比的姓
  });
});
