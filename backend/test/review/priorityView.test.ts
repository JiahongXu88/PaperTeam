/**
 * M15.12 B3 — priorityView（top-K 优先视图）单元测试：
 * 确定性排序、精确/语义去重折叠、serious/meta 标记、k 截断、不改输入 findings。
 */

import { describe, expect, it } from "vitest";
import { buildPriorityView } from "../../src/review/priorityView.js";
import { createFinding, type ReviewFinding } from "../../src/review/finding.js";

let seq = 0;
function finding(input: Partial<Parameters<typeof createFinding>[0]>): ReviewFinding {
  seq += 1;
  return createFinding({
    findingId: `f-test-${String(seq).padStart(3, "0")}`,
    category: "academic",
    severity: "minor",
    message: "m",
    source: "section-review",
    now: "2026-10-29T00:00:00.000Z",
    sectionId: "SEC01",
    ...input,
  });
}

describe("buildPriorityView", () => {
  it("severity 降序 → 类目权重降序 → findingId 升序（全确定性）", () => {
    const styleMajor = finding({ category: "style", severity: "major", message: "风格问题" });
    const academicMajor = finding({ category: "academic", severity: "major", message: "学术问题" });
    const academicCritical = finding({ category: "academic", severity: "critical", message: "严重学术问题" });
    const view = buildPriorityView([styleMajor, academicMajor, academicCritical], 10);
    expect(view.items.map((i) => i.findingId)).toEqual([
      academicCritical.findingId,
      academicMajor.findingId,
      styleMajor.findingId,
    ]);
  });

  it("同类目同义 message（Jaccard ≥0.8）折叠；折叠数登记", () => {
    const a = finding({ category: "academic", severity: "major", message: "消融实验不足，缺少关键组件的对照" });
    const b = finding({ category: "academic", severity: "major", message: "消融实验不足，缺少关键组件的对照！" });
    const c = finding({ category: "academic", severity: "minor", message: "完全不同的另一个问题：数据集划分未说明" });
    const view = buildPriorityView([a, b, c], 10);
    expect(view.items).toHaveLength(2);
    expect(view.dedupCollapsed).toBe(1);
  });

  it("精确重复折叠保留 severity 更高者", () => {
    const minor = finding({ category: "style", severity: "minor", message: "术语大小写不一致" });
    const critical = finding({ category: "style", severity: "critical", message: "术语大小写不一致" });
    const view = buildPriorityView([minor, critical], 10);
    expect(view.items).toHaveLength(1);
    expect(view.items[0]!.severity).toBe("critical");
    expect(view.dedupCollapsed).toBe(1);
  });

  it("serious = critical/major；meta = fullpaper-review 来源", () => {
    const meta = finding({
      category: "academic",
      severity: "critical",
      message: "目标与实验错位",
      source: "fullpaper-review",
    });
    const small = finding({ category: "style", severity: "info", message: "排版小问题" });
    const view = buildPriorityView([meta, small], 10);
    expect(view.items[0]!.serious).toBe(true);
    expect(view.items[0]!.meta).toBe(true);
    expect(view.items[1]!.serious).toBe(false);
    expect(view.items[1]!.meta).toBe(false);
    expect(view.seriousCount).toBe(1);
    expect(view.metaCount).toBe(1);
  });

  it("k 截断；风格小项不挤占前排（severity 优先）", () => {
    const findings = [
      ...Array.from({ length: 12 }, (_, i) => finding({ category: "style", severity: "info", message: `风格问题 ${i}` })),
      finding({ category: "academic", severity: "critical", message: "严重问题" }),
    ];
    const view = buildPriorityView(findings, 10);
    expect(view.items).toHaveLength(10);
    expect(view.items[0]!.severity).toBe("critical");
    expect(view.items.filter((i) => i.severity === "info")).toHaveLength(9);
  });

  it("确定性：输入顺序打乱结果不变；不改输入数组", () => {
    const findings = [
      finding({ category: "academic", severity: "major", message: "A 问题" }),
      finding({ category: "fact", severity: "critical", message: "B 问题" }),
      finding({ category: "consistency", severity: "major", message: "C 问题" }),
    ];
    const view1 = buildPriorityView(findings, 10);
    const view2 = buildPriorityView([...findings].reverse(), 10);
    expect(view1.items.map((i) => i.findingId)).toEqual(view2.items.map((i) => i.findingId));
    expect(findings).toHaveLength(3);
  });
});

describe("M15.13 A3：retention 诚实分母字段（poolSize/seriousPool/metaPool）", () => {
  it("top-K 截断时池计数 = 去重池全量；seriousPool/metaPool 与池口径一致", () => {
    const findings = [
      ...Array.from({ length: 8 }, (_, i) => finding({ category: "style", severity: "info", message: `风格问题 ${i}` })),
      finding({ category: "academic", severity: "critical", message: "严重学术问题" }),
      finding({ category: "academic", severity: "major", message: "目标与实验错位", source: "fullpaper-review" }),
    ];
    const view = buildPriorityView(findings, 5);
    expect(view.items).toHaveLength(5);
    expect(view.poolSize).toBe(10); // 无重复 → 池 = 全量 findings
    expect(view.seriousPoolCount).toBe(2);
    expect(view.metaPoolCount).toBe(1);
    // top-K 内 serious 计数 ≤ 池内 serious 计数（分母/分子口径分离可审计）
    expect(view.seriousCount).toBeLessThanOrEqual(view.seriousPoolCount);
    expect(view.metaCount).toBeLessThanOrEqual(view.metaPoolCount);
  });
});
