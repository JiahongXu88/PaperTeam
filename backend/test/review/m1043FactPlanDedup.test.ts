/**
 * M10.4.3 单元测试（确定性，无 LLM）：fact-preserve 计划派生去重。
 *
 * 根因（M10.4.2 A1·2/A2·1 实证）：violationKey 是内容指纹
 * （sha256(file|reason|before|after)[0:16]），同一内容漂移在稿内多处发生时
 * gate 如实产出多条同 key 违规；revisionPlan 主路径把 key 直接当条目 id，
 * 无出现次数消歧 → M9.10 duplicate_item_id 构建期断言 fail-closed 杀死整 run。
 *
 * 修复：同一 violationKey 的第 N 次出现 → fact-preserve:<key>:<N>（0 基，
 * 按输入顺序确定性计数——无随机 / 时间源，同输入同输出）。
 *
 * Cases A–D（任务 §第二阶段）：
 *   A：单个 violationKey 单次出现 → fact-preserve:<key>:0，字段完整
 *   B：同一 violationKey ×3 → :0/:1/:2 互异，全部违规信息保留（不覆盖）
 *   C：多个不同 violationKey（混无 key fallback）→ id 全局唯一
 *   D：同输入重复派生 → items 完全一致（确定性）
 */

import { describe, expect, it } from "vitest";

import { buildRevisionPlan } from "../../src/review/revisionPlan.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";

function emptyPassSummary(): ReviewSummary {
  return {
    generatedAt: new Date().toISOString(),
    round: 1,
    issues: [],
    counts: { critical: 0, major: 0, minor: 0, byCategory: {}, blocking: 0 },
    scores: { academicScore: 88, styleRisk: 10, factVerdicts: null },
    openCritical: 0,
    openMajor: 0,
    unsupportedCriticalClaims: 0,
    reportPaths: [],
  };
}

const INPUT_BASE = {
  projectId: "p",
  sourceRevision: 3,
  reviewRound: 2,
  createdAt: "2026-10-02T00:00:00.000Z",
} as const;

/** A1·2 现场形态：同 key 双出现（prose_number，同内容行多处删除） */
const SAME_KEY_REGRESSIONS = [
  {
    file: "main.tex",
    detail: "prose_number：\\includegraphics[width=0.75\\linewidth]{figs/fig_pr_bdd100k.pdf}（被删除）",
    violationKey: "49742c0c9bd329e8",
    restoreValues: ["0.75"],
    restorable: false,
  },
  {
    file: "main.tex",
    detail: "prose_number：\\includegraphics[width=0.75\\linewidth]{figs/fig_pr_bdd100k.pdf}（被删除）",
    violationKey: "49742c0c9bd329e8",
    restoreValues: ["0.75"],
    restorable: false,
  },
  {
    file: "main.tex",
    detail: "prose_number：\\includegraphics[width=0.75\\linewidth]{figs/fig_pr_bdd100k.pdf}（被删除）",
    violationKey: "49742c0c9bd329e8",
    restoreValues: ["0.75"],
    restorable: false,
  },
];

describe("M10.4.3 fact-preserve 派生去重", () => {
  it("Case A：单个 violationKey 单次出现 → fact-preserve:<key>:0，字段完整", () => {
    const plan = buildRevisionPlan({
      ...INPUT_BASE,
      summary: emptyPassSummary(),
      factRegressions: [
        {
          file: "main.tex",
          detail: "prose_number：0.5 → 0.3",
          violationKey: "aaaaaaaaaaaaaaaa",
          restoreValues: ["0.5"],
          removeValues: ["0.3"],
          restorable: true,
        },
      ],
    });
    const factItems = plan.items.filter((item) => item.kind === "fact_preserve");
    expect(factItems).toHaveLength(1);
    expect(factItems[0]!.id).toBe("fact-preserve:aaaaaaaaaaaaaaaa:0");
    expect(factItems[0]!.status).toBe("planned");
    expect(factItems[0]!.section).toBe("main.tex");
    expect(factItems[0]!.factRestore).toEqual({ restoreValues: ["0.5"], removeValues: ["0.3"] });
    expect(factItems[0]!.note).toContain("revision.restore_facts");
  });

  it("Case B：同一 violationKey ×3 → :0/:1/:2 互异，全部违规信息保留（修复前此处抛 duplicate_item_id）", () => {
    const plan = buildRevisionPlan({
      ...INPUT_BASE,
      summary: emptyPassSummary(),
      factRegressions: SAME_KEY_REGRESSIONS,
    });
    expect(plan.summary.planned).toBe(3);
    const factItems = plan.items.filter((item) => item.kind === "fact_preserve");
    expect(factItems).toHaveLength(3);
    expect(factItems.map((item) => item.id)).toEqual([
      "fact-preserve:49742c0c9bd329e8:0",
      "fact-preserve:49742c0c9bd329e8:1",
      "fact-preserve:49742c0c9bd329e8:2",
    ]);
    // 不允许覆盖：三条违规的 detail / factRestore 逐条保留
    for (const item of factItems) {
      expect(item.problem).toContain("fig_pr_bdd100k.pdf");
      expect(item.factRestore?.restoreValues).toEqual(["0.75"]);
      expect(item.status).toBe("planned");
    }
  });

  it("Case C：多个不同 violationKey（混无 key fallback）→ id 全局唯一", () => {
    const plan = buildRevisionPlan({
      ...INPUT_BASE,
      summary: emptyPassSummary(),
      factRegressions: [
        { file: "main.tex", detail: "d1", violationKey: "bbbbbbbbbbbbbbbb" },
        { file: "main.tex", detail: "d2", violationKey: "cccccccccccccccc" },
        { file: "sections/exp.tex", detail: "d3", violationKey: "dddddddddddddddd" },
        // 同 key 再现（跨 key 交错的第 2 次出现）
        { file: "main.tex", detail: "d1-again", violationKey: "bbbbbbbbbbbbbbbb" },
        // 无 key fallback（pairwise 路径）：同文件两条 → :1/:2 计数消歧
        { file: "main.tex", detail: "d4" },
        { file: "main.tex", detail: "d5" },
      ],
    });
    const ids = plan.items.filter((item) => item.kind === "fact_preserve").map((item) => item.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    expect(ids).toContain("fact-preserve:bbbbbbbbbbbbbbbb:0");
    expect(ids).toContain("fact-preserve:bbbbbbbbbbbbbbbb:1");
    expect(ids).toContain("fact-preserve:cccccccccccccccc:0");
    expect(ids).toContain("fact-preserve:dddddddddddddddd:0");
    // fallback 计数包含同文件既有 keyed 条目（findingCount 按 section 计数）
    expect(ids).toContain("fact-preserve:main.tex:4");
    expect(ids).toContain("fact-preserve:main.tex:5");
  });

  it("Case D：同输入重复派生 → items 完全一致（确定性，无随机 / 时间源）", () => {
    const derive = () =>
      buildRevisionPlan({
        ...INPUT_BASE,
        summary: emptyPassSummary(),
        factRegressions: SAME_KEY_REGRESSIONS,
      });
    const first = derive();
    const second = derive();
    expect(second).toEqual(first);
    // 序号稳定复现（非只比较集合）
    expect(second.items.map((item) => item.id)).toEqual(
      first.items.map((item) => item.id),
    );
  });

  it("restore 回写兼容：新 id 格式可反解 violationKey（fact-preserve:<key>:<n> 与裸 <key> 同道）", () => {
    // definitions.ts restore stage 的匹配规则：strip 前缀后取第一段（violationKey
    // 为 16 位 hex 不含冒号）。新旧格式与 fallback 都走同一解析，不误命中。
    const parse = (id: string): string => id.slice("fact-preserve:".length).split(":")[0] ?? "";
    expect(parse("fact-preserve:49742c0c9bd329e8:0")).toBe("49742c0c9bd329e8");
    expect(parse("fact-preserve:49742c0c9bd329e8:12")).toBe("49742c0c9bd329e8");
    expect(parse("fact-preserve:49742c0c9bd329e8")).toBe("49742c0c9bd329e8"); // 旧计划格式
    expect(parse("fact-preserve:main.tex:2")).toBe("main.tex"); // fallback：不命中 hex key 集合
  });
});
