import { describe, expect, it } from "vitest";
import {
  buildReviewCoveragePlan,
  computeReviewCoverage,
  digestIsLossy,
  reviewUnitFileName,
  type ReviewUnitRecord,
} from "../../src/review/coverageLedger.js";
import { chapterBody } from "./logicalSpan.test.js";

function chapter(title: string, chars: number, marker = title): { file: string; content: string } {
  return { file: `sections/${marker}.tex`, content: `\\section{${title}}\n` + chapterBody(chars, marker) };
}

describe("M14.1a digestIsLossy（长文档模式触发判定）", () => {
  it("10 章 × 9k → 有损（总量超 60k）", () => {
    const files = Array.from({ length: 10 }, (_, index) => chapter(`Chapter ${index + 1}`, 9_000, `ch${index + 1}`));
    expect(digestIsLossy(files)).toBe(true);
  });

  it("短文档（3 节 × 1k）→ 无损，维持 digest 路径", () => {
    const files = Array.from({ length: 3 }, (_, index) => chapter(`Section ${index + 1}`, 1_000, `s${index + 1}`));
    expect(digestIsLossy(files)).toBe(false);
  });

  it("单节 >3600 → 有损（digest 节预算截断即丢正文）", () => {
    expect(digestIsLossy([chapter("Big", 4_000, "big")])).toBe(true);
  });

  it("文件数 >24 → 有损（静默丢弃即丢正文）", () => {
    const files = Array.from({ length: 25 }, (_, index) => chapter(`S${index}`, 100, `s${index}`));
    expect(digestIsLossy(files)).toBe(true);
  });
});

describe("M14.1a buildReviewCoveragePlan", () => {
  const files = [chapter("Method", 20_000, "method"), chapter("Results", 3_000, "results")];
  const plan = buildReviewCoveragePlan(files, 9_000);

  it("超长章节切多个单元，短章节单单元；targetChars = 全部正文（含标题命令）", () => {
    expect(plan.units.filter((unit) => unit.spanId === "section:Method")).toHaveLength(3);
    expect(plan.units.filter((unit) => unit.spanId === "section:Results")).toHaveLength(1);
    const totalFileChars = files.reduce((sum, file) => sum + file.content.length, 0);
    expect(plan.targetChars).toBe(totalFileChars);
    expect(plan.files.map((file) => file.chars)).toEqual([20_000 + 21, 3_000 + 19].map(() => expect.any(Number)));
  });

  it("snapshotId 由文件内容决定（改一个字符即变化）", () => {
    const mutated = buildReviewCoveragePlan(
      [{ file: files[0]!.file, content: files[0]!.content.replace("Paragraph 1", "Paragraph X") }, files[1]!],
      9_000,
    );
    expect(mutated.snapshotId).not.toBe(plan.snapshotId);
  });

  it("单元 id 稳定且唯一（file::spanId#uN）", () => {
    const ids = plan.units.map((unit) => unit.unitId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("sections/method.tex::section:Method#u1");
  });
});

describe("M14.1a computeReviewCoverage（只计实际完成的审查）", () => {
  const files = [chapter("Method", 20_000, "method")];
  const plan = buildReviewCoveragePlan(files, 9_000);
  const now = new Date().toISOString();
  const completed = (unitId: string, overrides: Partial<ReviewUnitRecord> = {}): ReviewUnitRecord => ({
    unitId, round: 1, snapshotId: plan.snapshotId,
    unitFingerprint: plan.units.find((unit) => unit.unitId === unitId)!.contentHash,
    status: "completed", updatedAt: now, ...overrides,
  });

  it("全部完成 → ratio 1 / complete true", () => {
    const coverage = computeReviewCoverage(plan, 1, plan.units.map((unit) => completed(unit.unitId)));
    expect(coverage.complete).toBe(true);
    expect(coverage.ratio).toBe(1);
    expect(coverage.reviewedChars).toBe(plan.targetChars);
  });

  it("一个单元失败 → 覆盖率如实下降、complete false、failedUnitIds 记录", () => {
    const failedUnit = plan.units[2]!;
    const records = [
      ...plan.units.slice(0, 2).map((unit) => completed(unit.unitId)),
      { ...completed(failedUnit.unitId), status: "failed" as const, error: "model timeout" },
    ];
    const coverage = computeReviewCoverage(plan, 1, records);
    expect(coverage.complete).toBe(false);
    expect(coverage.completedUnits).toBe(2);
    expect(coverage.failedUnits).toBe(1);
    expect(coverage.failedUnitIds).toEqual([failedUnit.unitId]);
    expect(coverage.reviewedChars).toBe(plan.units[0]!.chars + plan.units[1]!.chars);
    expect(coverage.ratio).toBeCloseTo((plan.units[0]!.chars + plan.units[1]!.chars) / plan.targetChars, 8);
  });

  it("旧 snapshot 的完成记录不计入（文档变了 → 旧 review 不被误用）", () => {
    const stale = plan.units.map((unit) => completed(unit.unitId, { snapshotId: "older-snapshot" }));
    const coverage = computeReviewCoverage(plan, 1, stale);
    expect(coverage.completedUnits).toBe(0);
    expect(coverage.ratio).toBe(0);
    expect(coverage.complete).toBe(false);
  });

  it("单元内容指纹变化（文档局部修改）→ 该单元旧记录不计入", () => {
    const records = [
      completed(plan.units[0]!.unitId),
      completed(plan.units[1]!.unitId, { unitFingerprint: "changed-content" }),
      completed(plan.units[2]!.unitId),
    ];
    const coverage = computeReviewCoverage(plan, 1, records);
    expect(coverage.completedUnits).toBe(2);
    expect(coverage.complete).toBe(false);
  });

  it("跨轮记录标记 reused（同 snapshot 复用既往成功审查）", () => {
    const coverage = computeReviewCoverage(plan, 2, plan.units.map((unit) => completed(unit.unitId, { round: 1 })));
    expect(coverage.complete).toBe(true);
    expect(coverage.reusedUnits).toBe(3);
  });
});

describe("M14.1a reviewUnitFileName", () => {
  it("路径安全且稳定（同 id 同名，不同 id 不同名）", () => {
    const a = reviewUnitFileName("sections/method.tex::section:Method#u1");
    expect(a).toMatch(/^[a-zA-Z0-9_.-]+\.json$/);
    expect(reviewUnitFileName("sections/method.tex::section:Method#u1")).toBe(a);
    expect(reviewUnitFileName("sections/method.tex::section:Method#u2")).not.toBe(a);
  });
});
