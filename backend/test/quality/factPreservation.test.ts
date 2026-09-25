/**
 * Fact Preservation Gate（M5.6 第二层，pair-02 盲评驱动）单元测试。
 *
 * 用例对应 M5.6 验收清单（修订事实安全）：
 *   1 表格单元格不变 PASS；2 45→28 FAIL；3 47→19 FAIL；4 Frag 102→51 FAIL；
 *   5 35.9%→38.7% FAIL；6 基本一致→保持优势 FAIL；7 负结果→优势 FAIL（hard）；
 *   8 500帧×3次→单次窗口 FAIL；9 18min/621帧/309MB→15–20min FAIL；
 *   10 具体数值→待回填 FAIL；11 公式项替换 FAIL；12 official split→custom split FAIL；
 *   13 新增 r=16 无 Evidence FAIL；14 计划+Evidence 授权 45→44 PASS；
 *   15 只改中文措辞 PASS；16-18（引用保持 / style invariant / Quick Review）
 *   由既有测试与本套件 e2e（workflow/factPreservationGate）覆盖。
 */

import { describe, expect, it } from "vitest";

import {
  evaluateFactPreservation,
  describeFactPreservation,
  type FactSnapshot,
} from "../../src/quality/factPreservation.js";
import { DEFAULT_QUALITY_THRESHOLDS, evaluateQualityGate } from "../../src/quality/gates.js";
import type { RevisionPlan, RevisionPlanItem } from "../../src/review/revisionPlan.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";

// ---- 工厂 ----

function snapshot(revision: number, files: Record<string, string>): FactSnapshot {
  return {
    revision,
    files: Object.entries(files).map(([file, content]) => ({ file, content })),
  };
}

const emptySummary: ReviewSummary = {
  generatedAt: "2026-09-15T00:00:00Z",
  round: 1,
  reviewedRevision: 1,
  issues: [],
  counts: { critical: 0, major: 0, minor: 0, byCategory: {}, blocking: 0 },
  scores: { academicScore: 88, styleRisk: 20, factVerdicts: { SUPPORTED: 1, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 0, CONTRADICTED: 0 } },
  openCritical: 0,
  openMajor: 0,
  unsupportedCriticalClaims: 0,
  reportPaths: [],
};

function planWithItems(items: Partial<RevisionPlanItem>[], sourceRevision = 1): RevisionPlan {
  return {
    schemaVersion: 1,
    planId: `plan-r1-rev${sourceRevision}`,
    projectId: "p-test",
    sourceRevision,
    reviewRound: 1,
    createdAt: "2026-09-15T00:00:00Z",
    summary: { critical: 0, major: 0, blocking: 0, minorRecorded: 0, planned: items.length, skipped: 0 },
    items: items.map(
      (item, index): RevisionPlanItem => ({
        id: item.id ?? `item-${index}`,
        kind: item.kind ?? "review_finding",
        priority: item.priority ?? "high",
        section: item.section ?? "sections/experiments.tex",
        problem: item.problem ?? "",
        instruction: item.instruction ?? "",
        expectedOutcome: item.expectedOutcome ?? "",
        status: item.status ?? "planned",
        ...(item.needsEvidence !== undefined ? { needsEvidence: item.needsEvidence } : {}),
      }),
    ),
  };
}

/** 带表格与正文的实验章节（pair-02 形态的 sanitized 版） */
const EXPERIMENT_TEX = [
  "\\section{实验结果与分析}",
  "\\begin{table}",
  "\\caption{极端场景对比}",
  "\\label{tab:extreme}",
  "\\begin{tabular}{lccc}",
  "场景 & 方法 & IDS & Frag \\\\",
  "低照度 & 纯IoU基线 & 24 & 23 \\\\",
  "低照度 & 本文方法 & 35 & 102 \\\\",
  "高密度 & 本文方法 & 47 & 103 \\\\",
  "\\end{tabular}",
  "\\end{table}",
  "漏检占GT目标帧的比例由24.9\\%升至35.9\\%。",
  "本文方法在低照度场景下出现额外的身份切换（IDS 35 对 24），对检测框扰动仍较敏感。",
  "普通与高密度场景下两者指标基本一致。",
  "数据集采用官方划分，测试段共 500 帧重复 3 次。",
  "部署测试持续 18 min，采集 621 frames，RSS 峰值 309MB。",
  "\\begin{equation}",
  "  L = L_{cls} + \\alpha L_{objness}",
  "\\end{equation}",
].join("\n");

function revised(replacements: Record<string, string>): string {
  let tex = EXPERIMENT_TEX;
  for (const [from, to] of Object.entries(replacements)) {
    tex = tex.split(from).join(to);
  }
  return tex;
}

function evaluate(previousFiles: Record<string, string>, currentFiles: Record<string, string>) {
  return evaluateFactPreservation({
    previous: snapshot(1, previousFiles),
    current: snapshot(2, currentFiles),
    plan: null,
  });
}

// ---- 表格 ----

describe("Fact Preservation：表格数值", () => {
  it("表格单元格不变（只改措辞段）→ PASS", () => {
    const summary = evaluate(
      { "sections/experiments.tex": EXPERIMENT_TEX },
      { "sections/experiments.tex": revised({ "漏检占GT目标帧的比例": "漏检比例统计结果" }) },
    );
    expect(summary.ok).toBe(true);
    expect(summary.changedFacts).toHaveLength(0);
  });

  it("45 → 28（无授权）→ FAIL：changedFacts 含 table_cell", () => {
    const previous = EXPERIMENT_TEX.replace("本文方法 & 35", "本文方法 & 45");
    const current = previous.replace("本文方法 & 45", "本文方法 & 28");
    const summary = evaluate(
      { "sections/experiments.tex": previous },
      { "sections/experiments.tex": current },
    );
    expect(summary.ok).toBe(false);
    expect(summary.changedFacts.some((finding) => finding.reason === "table_cell")).toBe(true);
    expect(summary.changedFacts[0]?.before).toContain("45");
    expect(summary.changedFacts[0]?.after).toContain("28");
  });

  it("47 → 19（高密度 本文方法 行）→ FAIL", () => {
    const summary = evaluate(
      { "sections/experiments.tex": EXPERIMENT_TEX },
      { "sections/experiments.tex": revised({ "本文方法 & 47 & 103": "本文方法 & 19 & 103" }) },
    );
    expect(summary.ok).toBe(false);
    expect(summary.changedFacts.some((finding) => finding.before.includes("47"))).toBe(true);
  });

  it("Frag 102 → 51 → FAIL", () => {
    const summary = evaluate(
      { "sections/experiments.tex": EXPERIMENT_TEX },
      { "sections/experiments.tex": revised({ "本文方法 & 35 & 102": "本文方法 & 35 & 51" }) },
    );
    expect(summary.ok).toBe(false);
    expect(summary.changedFacts.some((finding) => finding.before.includes("102"))).toBe(true);
  });

  it("整表删除 → removedFacts（table_removed）", () => {
    const current = revised({
      "\\begin{table}\n\\caption{极端场景对比}\n\\label{tab:extreme}\n\\begin{tabular}{lccc}\n场景 & 方法 & IDS & Frag \\\\\n低照度 & 纯IoU基线 & 24 & 23 \\\\\n低照度 & 本文方法 & 35 & 102 \\\\\n高密度 & 本文方法 & 47 & 103 \\\\\n\\end{tabular}\n\\end{table}\n": "",
    });
    const summary = evaluate({ "sections/experiments.tex": EXPERIMENT_TEX }, { "sections/experiments.tex": current });
    expect(summary.ok).toBe(false);
    expect(summary.removedFacts.some((finding) => finding.reason === "table_removed")).toBe(true);
  });
});

// ---- 正文数值 ----

describe("Fact Preservation：正文数值", () => {
  it("35.9% → 38.7% → FAIL（prose_number 变更）", () => {
    const summary = evaluate(
      { "sections/experiments.tex": EXPERIMENT_TEX },
      { "sections/experiments.tex": revised({ "35.9\\%": "38.7\\%" }) },
    );
    expect(summary.ok).toBe(false);
    expect(summary.changedFacts.some((finding) => finding.reason === "prose_number")).toBe(true);
  });

  it("500 帧 × 3 次 → 单次窗口 → FAIL（数值被删）", () => {
    const summary = evaluate(
      { "sections/experiments.tex": EXPERIMENT_TEX },
      { "sections/experiments.tex": revised({ "测试段共 500 帧重复 3 次": "测试段采用单次窗口" }) },
    );
    expect(summary.ok).toBe(false);
    expect(summary.removedFacts.length + summary.changedFacts.length).toBeGreaterThanOrEqual(2);
  });

  it("18 min / 621 frames / 309MB → 15–20 min → FAIL（部署事实弱化）", () => {
    const summary = evaluate(
      { "sections/experiments.tex": EXPERIMENT_TEX },
      { "sections/experiments.tex": revised({ "持续 18 min，采集 621 frames，RSS 峰值 309MB": "持续约 15–20 min" }) },
    );
    expect(summary.ok).toBe(false);
    expect(
      summary.removedFacts.length +
        summary.changedFacts.length +
        summary.addedUnsupportedFacts.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("具体数值 → 待回填 → FAIL（placeholderRegressions）", () => {
    const summary = evaluate(
      { "sections/experiments.tex": EXPERIMENT_TEX },
      { "sections/experiments.tex": revised({ "持续 18 min，采集 621 frames，RSS 峰值 309MB": "部署数据待回填" }) },
    );
    expect(summary.ok).toBe(false);
    expect(summary.placeholderRegressions.length).toBeGreaterThanOrEqual(1);
  });

  it("previous 本来就缺的占位允许继续存在（无事实可替换 → 不 FAIL）", () => {
    const previous = "\\section{实验}\n极端场景数据待回填。\n";
    const summary = evaluate(
      { "sections/experiments.tex": previous },
      { "sections/experiments.tex": previous },
    );
    expect(summary.ok).toBe(true);
  });

  it("表格数值 → 待回填 → FAIL（table_cell_placeholder）", () => {
    const summary = evaluate(
      { "sections/experiments.tex": EXPERIMENT_TEX },
      { "sections/experiments.tex": revised({ "本文方法 & 47 & 103": "本文方法 & 待回填 & 103" }) },
    );
    expect(summary.ok).toBe(false);
    expect(summary.placeholderRegressions.some((finding) => finding.reason === "table_cell_placeholder")).toBe(true);
  });
});

// ---- 方向性结论 ----

describe("Fact Preservation：方向性结论", () => {
  it("基本一致 → 本文保持优势 → FAIL（parity_to_advantage）", () => {
    const summary = evaluate(
      { "sections/experiments.tex": EXPERIMENT_TEX },
      { "sections/experiments.tex": revised({ "普通与高密度场景下两者指标基本一致。": "普通与高密度场景下本文方法保持优势。" }) },
    );
    expect(summary.ok).toBe(false);
    expect(summary.directionalChanges.some((finding) => finding.reason === "parity_to_advantage")).toBe(true);
    expect(summary.directionalChanges[0]?.before).toContain("基本一致");
    expect(summary.directionalChanges[0]?.after).toContain("保持优势");
  });

  it("负结果（本文更差）→ 优于基线 → FAIL（negative_to_advantage，hard rule）", () => {
    const summary = evaluate(
      { "sections/experiments.tex": EXPERIMENT_TEX },
      {
        "sections/experiments.tex": revised({
          "本文方法在低照度场景下出现额外的身份切换（IDS 35 对 24），对检测框扰动仍较敏感。":
            "本文方法在低照度场景下优于基线，关联机制表现稳健。",
        }),
      },
    );
    expect(summary.ok).toBe(false);
    expect(summary.directionalChanges.some((finding) => finding.reason === "negative_to_advantage")).toBe(true);
  });

  it("同指标比较方向对调（高于→低于）→ FAIL（metric_direction_flip）", () => {
    const previous = "\\section{对比}\n本文方法的 FPS 高于基线 15\\%。";
    const current = "\\section{对比}\n本文方法的 FPS 低于基线 15\\%。";
    const summary = evaluate({ "sections/experiments.tex": previous }, { "sections/experiments.tex": current });
    expect(summary.ok).toBe(false);
    expect(summary.directionalChanges.some((finding) => finding.reason === "metric_direction_flip")).toBe(true);
  });
});

// ---- 公式 / 方法事实 ----

describe("Fact Preservation：公式与方法配置", () => {
  it("公式项替换（objness → DFL）→ FAIL（formulaChanges）", () => {
    const summary = evaluate(
      { "sections/experiments.tex": EXPERIMENT_TEX },
      { "sections/experiments.tex": revised({ "L_{objness}": "L_{DFL}" }) },
    );
    expect(summary.ok).toBe(false);
    expect(summary.formulaChanges).toHaveLength(1);
    expect(summary.formulaChanges[0]?.before).toContain("objness");
  });

  it("官方划分 → 自定义划分 → FAIL（dataset_split_changed）", () => {
    const summary = evaluate(
      { "sections/experiments.tex": EXPERIMENT_TEX },
      { "sections/experiments.tex": revised({ "数据集采用官方划分": "数据集采用自定义划分" }) },
    );
    expect(summary.ok).toBe(false);
    expect(summary.changedFacts.some((finding) => finding.reason === "dataset_split_changed")).toBe(true);
  });

  it("硬件型号消失 → FAIL（hardware_removed）", () => {
    const previous = "\\section{部署}\n算法部署于 RDK X3 边缘平台。\n";
    const current = "\\section{部署}\n算法部署于车载边缘平台。\n";
    const summary = evaluate({ "sections/deploy.tex": previous }, { "sections/deploy.tex": current });
    expect(summary.ok).toBe(false);
    expect(summary.removedFacts.some((finding) => finding.reason === "hardware_removed")).toBe(true);
  });
});

// ---- 无依据新增 ----

describe("Fact Preservation：无依据新增", () => {
  it("新增 r=16 等超参数（无 Evidence）→ FAIL（hyperparameter_assignment）", () => {
    const previous = "\\section{方法}\n记忆库容量按轨迹长度自适应。\n";
    const current = "\\section{方法}\n记忆库容量按轨迹长度自适应，r=16，特征维数为71维，$\\lambda=0.5$。\n";
    const summary = evaluate({ "sections/method.tex": previous }, { "sections/method.tex": current });
    expect(summary.ok).toBe(false);
    expect(summary.addedUnsupportedFacts.some((finding) => finding.reason === "hyperparameter_assignment")).toBe(true);
    expect(summary.addedUnsupportedFacts.some((finding) => finding.reason === "added_number")).toBe(true);
  });
});

// ---- 授权变更 ----

describe("Fact Preservation：授权的事实修正", () => {
  it("计划点名 45→44 且 Evidence 含 44 → PASS（plan_value_correction）", () => {
    const previous = EXPERIMENT_TEX.replace("本文方法 & 35", "本文方法 & 45");
    const current = previous.replace("本文方法 & 45", "本文方法 & 44");
    const summary = evaluateFactPreservation({
      previous: snapshot(1, { "sections/experiments.tex": previous }),
      current: snapshot(2, { "sections/experiments.tex": current }),
      plan: planWithItems([
        {
          id: "f-fix-45",
          kind: "review_finding",
          section: "sections/experiments.tex",
          problem: "表 tab:extreme 低照度 本文方法 行 IDS 数值 45 与实验记录不符，应为 44",
          instruction: "依据 Evidence E012 将 45 修正为 44",
        },
      ]),
      evidenceTexts: ["E012：复测记录 低照度场景 本文方法 IDS=44"],
    });
    expect(summary.ok).toBe(true);
    expect(summary.allowedChanges).toBeGreaterThanOrEqual(1);
  });

  it("计划只点名旧值、Evidence 无新值 → 仍 FAIL（不能模糊授权）", () => {
    const summary = evaluateFactPreservation({
      previous: snapshot(1, { "sections/experiments.tex": EXPERIMENT_TEX }),
      current: snapshot(2, { "sections/experiments.tex": revised({ "本文方法 & 47 & 103": "本文方法 & 42 & 103" }) }),
      plan: planWithItems([
        {
          id: "f-vague",
          kind: "review_finding",
          section: "sections/experiments.tex",
          problem: "优化实验描述，提升表格可读性",
          instruction: "优化实验章节的表述",
        },
      ]),
    });
    expect(summary.ok).toBe(false);
  });

  it("needsEvidence 条目命中章节：prose 数字删除放行，表格数值修改不放行", () => {
    const current = revised({
      "测试段共 500 帧重复 3 次。": "（该论述证据不足，已弱化。）",
      "本文方法 & 47 & 103": "本文方法 & 42 & 103",
    });
    const summary = evaluateFactPreservation({
      previous: snapshot(1, { "sections/experiments.tex": EXPERIMENT_TEX }),
      current: snapshot(2, { "sections/experiments.tex": current }),
      plan: planWithItems([
        {
          id: "f-evidence",
          kind: "review_finding",
          section: "sections/experiments.tex",
          needsEvidence: true,
          problem: "测试协议论述缺乏 Evidence 支撑",
          instruction: "弱化或删除该论述",
        },
      ]),
    });
    expect(summary.ok).toBe(false); // 表格改值未授权
    expect(summary.allowedRemovals).toBeGreaterThanOrEqual(1); // prose 删除被放行
    expect(summary.changedFacts.some((finding) => finding.reason === "table_cell")).toBe(true);
  });
});

// ---- 合法修订 ----

describe("Fact Preservation：合法修订不误伤", () => {
  it("只改中文措辞（全部事实不变）→ PASS", () => {
    const summary = evaluate(
      { "sections/experiments.tex": EXPERIMENT_TEX },
      {
        "sections/experiments.tex": revised({
          "漏检占GT目标帧的比例由": "漏检目标帧占比从",
          "本文方法在低照度场景下出现额外的身份切换": "低照度场景下本文方法出现额外的身份切换",
        }),
      },
    );
    expect(summary.ok).toBe(true);
  });

  it("新章节文件出现（previous 无该文件）→ 不产生 finding", () => {
    const summary = evaluate(
      { "sections/intro.tex": "\\section{引言}\n本文方法有效。\n" },
      {
        "sections/intro.tex": "\\section{引言}\n本文方法有效。\n",
        "sections/new-section.tex": "\\section{消融}\n消融实验 IDS 下降 3\\%。\n",
      },
    );
    expect(summary.ok).toBe(true);
  });
});

// ---- Gate 集成 ----

describe("Fact Preservation：Quality Gate 集成", () => {
  const gateInput = {
    review: emptySummary,
    citation: null,
    evidence: { contradictory: 0 } as never,
    feasibility: null,
  };

  it("undefined → 规则不出现（兼容纯单元输入）", () => {
    const result = evaluateQualityGate(gateInput, DEFAULT_QUALITY_THRESHOLDS);
    expect(result.rules.some((rule) => rule.rule.startsWith("fact_preservation"))).toBe(false);
  });

  it("null → fact_preservation_not_applicable 中性呈现（passed: true）", () => {
    const result = evaluateQualityGate({ ...gateInput, factPreservation: null }, DEFAULT_QUALITY_THRESHOLDS);
    const rule = result.rules.find((entry) => entry.rule === "fact_preservation_not_applicable");
    expect(rule?.passed).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("summary.ok=false → fact_preservation FAIL 且整体 FAIL", () => {
    const failed = evaluate(
      { "sections/experiments.tex": EXPERIMENT_TEX },
      { "sections/experiments.tex": revised({ "本文方法 & 47 & 103": "本文方法 & 19 & 103" }) },
    );
    const result = evaluateQualityGate({ ...gateInput, factPreservation: failed }, DEFAULT_QUALITY_THRESHOLDS);
    const rule = result.rules.find((entry) => entry.rule === "fact_preservation");
    expect(rule?.passed).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.reasons.join("\n")).toContain("fact_preservation");
    expect(describeFactPreservation(failed)).toContain("实验事实保持失败");
  });
});

// ---- M9.10 Phase 3：数值归一化 + 事实变化分类（A/B/C/D） ----

describe("Fact Preservation：格式等价差异（B/C 类，M9.10）", () => {
  it("千分位写法差异（1446 → 1,446）→ formatChanges（B），不计违规", () => {
    const summary = evaluate(
      { "sections/experiments.tex": "样本总量 1446 条，覆盖 3 个场景。\n" },
      { "sections/experiments.tex": "样本总量 1,446 条，覆盖 3 个场景。\n" },
    );
    expect(summary.ok).toBe(true);
    expect(summary.changedFacts).toHaveLength(0);
    expect(summary.formatChanges).toHaveLength(1);
    expect(summary.formatChanges[0]?.classification).toMatchObject({
      category: "B",
      type: "number_formatted",
      severity: "low",
    });
  });

  it("全角数字（2022 → ２０２２）→ 提取层归一，不产生任何 finding", () => {
    const summary = evaluate(
      { "sections/experiments.tex": "该方法于 2022 年提出，参数量 8.9M。\n" },
      { "sections/experiments.tex": "该方法于 ２０２２ 年提出，参数量 8.9M。\n" },
    );
    expect(summary.ok).toBe(true);
    expect(summary.formatChanges).toHaveLength(0);
    expect(summary.removedFacts).toHaveLength(0);
    expect(summary.addedUnsupportedFacts).toHaveLength(0);
  });

  it("小数尾零（0.680 → 0.68）→ formatChanges（B）", () => {
    const summary = evaluate(
      { "sections/experiments.tex": "低照度场景 MOTA 为 0.680，其余场景正常。\n" },
      { "sections/experiments.tex": "低照度场景 MOTA 为 0.68，其余场景正常。\n" },
    );
    expect(summary.ok).toBe(true);
    expect(summary.formatChanges[0]?.classification?.category).toBe("B");
  });

  it("单位大小写（3.31FPS → 3.31fps）→ formatChanges（B）", () => {
    const summary = evaluate(
      { "sections/experiments.tex": "端到端帧率为 3.31FPS，延迟满足约束。\n" },
      { "sections/experiments.tex": "端到端帧率为 3.31fps，延迟满足约束。\n" },
    );
    expect(summary.ok).toBe(true);
    expect(summary.formatChanges[0]?.classification?.category).toBe("B");
  });

  it("表格单元格措辞变化（数字未动）→ C 类 language_rewritten，不计违规", () => {
    const previous = EXPERIMENT_TEX.replace("纯IoU基线", "纯IoU基线(基线24)");
    const current = previous.replace("纯IoU基线(基线24)", "IoU-only baseline(基线24)");
    const summary = evaluate(
      { "sections/experiments.tex": previous },
      { "sections/experiments.tex": current },
    );
    expect(summary.ok).toBe(true);
    expect(summary.changedFacts).toHaveLength(0);
    expect(summary.formatChanges.length).toBeGreaterThanOrEqual(1);
    expect(
      summary.formatChanges.some((finding) => finding.classification?.category === "C"),
    ).toBe(true);
  });

  it("真实数值漂移（35 → 28）仍为 A 类违规，分类 severity=high", () => {
    const summary = evaluate(
      { "sections/experiments.tex": EXPERIMENT_TEX },
      { "sections/experiments.tex": revised({ "本文方法 & 35 & 102": "本文方法 & 28 & 102" }) },
    );
    expect(summary.ok).toBe(false);
    expect(summary.changedFacts.length).toBeGreaterThanOrEqual(1);
    expect(summary.changedFacts[0]?.classification).toMatchObject({
      category: "A",
      type: "number_changed",
      severity: "high",
      oldValue: expect.stringContaining("35"),
      newValue: expect.stringContaining("28"),
    });
  });

  it("describeFactPreservation：通过 / 失败都呈现格式等价计数（审计可见）", () => {
    const withFormat = evaluate(
      { "sections/experiments.tex": "样本总量 1446 条。\n" },
      { "sections/experiments.tex": "样本总量 1,446 条。\n" },
    );
    expect(describeFactPreservation(withFormat)).toContain("格式等价差异 1 项");
    const drifted = evaluate(
      { "sections/experiments.tex": EXPERIMENT_TEX },
      { "sections/experiments.tex": revised({ "本文方法 & 35 & 102": "本文方法 & 28 & 102" }) },
    );
    expect(describeFactPreservation(drifted)).toContain("实验事实保持失败");
  });

  it("授权匹配跨格式：计划点名 1,446 → 改为 1500 时 token 1446 命中（不再 miss 成 FP）", () => {
    const plan = planWithItems([
      {
        id: "fact-fix-1",
        kind: "fact_preserve",
        problem: "样本总量应为 1,446，需更正为 1500",
        instruction: "将样本总量 1,446 更正为 1500（新统计口径）",
      },
    ]);
    const summary = evaluateFactPreservation({
      previous: snapshot(1, { "sections/experiments.tex": "样本总量 1446 条。\n" }),
      current: snapshot(2, { "sections/experiments.tex": "样本总量 1500 条。\n" }),
      plan,
    });
    expect(summary.ok).toBe(true);
    expect(summary.changedFacts).toHaveLength(0);
    expect(summary.allowedChanges).toBe(1);
  });
});
