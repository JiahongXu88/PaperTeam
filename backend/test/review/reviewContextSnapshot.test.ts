/**
 * M14.9.5.1 Review Context Snapshot（纯函数）：跨单元依赖定位、防错配与 fail-closed、预算、指纹。
 * 夹具是合成稿件（不含第三方论文原文 / 数值）；真实冻结样本的零模型回放在仓库外数据目录执行。
 */
import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../../src/config/config.js";
import { evaluateQualityGate } from "../../src/quality/gates.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";
import { buildPublishedAssessmentView } from "../../src/review/reviewPurpose.js";

import {
  buildContextSnapshotRecord,
  dependencyFingerprint,
  indexDependencyTargets,
  locateAbstractAnchor,
  parseReviewUnitContextPolicy,
  referenceOnlyQuoteIndices,
  renderDependencyBlock,
  resolveUnitDependencies,
} from "../../src/review/reviewContextSnapshot.js";

type Unit = { unitId: string; file: string; heading: string; text: string };
const unit = (id: string, text: string, file = "main.tex"): Unit => ({ unitId: `${file}::${id}`, file, heading: id, text });

const tabular = (rows: string[]): string => ["\\begin{table}[htbp]\\centering", "\\begin{tabular}{lll}", ...rows.map((row) => `${row} \\\\`), "\\end{tabular}", "\\end{table}"].join("\n");

/** 转写稿形态：中文标题在上、英文标题与注释在下（与 PDF 转写投影同构，数值为虚构） */
const RESULTS = [
  "\\section*{2 结果}",
  "",
  "\\textbf{表 1 两组基本特征}",
  "",
  tabular(["组别 & 例数 & 构成比", "A & 410 & 41.0", "B & 590 & 59.0"]),
  "",
  "\\textbf{Table 1 Baseline characteristics}",
  "",
  "注：①以人数（占比/\\%）表示。",
  "",
  "\\textbf{表 2 不同收入组患病率}",
  "",
  tabular(["收入 & 患病 & 患病率", "低 & 120 & 24.0", "高 & 126 & 25.2"]),
  "",
  "\\textbf{Table 2 Prevalence by income}",
  "",
  "注：①以人数（患病率/\\%）表示。",
  "",
  "2.1 基本情况见表1。",
].join("\n");
const ANALYSIS = "\\subsection*{2.2 影响因素}\n\n以经单因素分析后有统计学意义的收入等变量为自变量（见表2），结果见表3。\n\n\\textbf{表3 多因素分析}\n\n" + tabular(["变量 & OR & P", "收入 & 1.10 & 0.40"]);

describe("indexDependencyTargets / resolveUnitDependencies", () => {
  it("跨单元表格：取到正确表的标题、全部单元格、英文题注与注释；本单元的表不重复附上", () => {
    const units = [unit("2 结果", RESULTS), unit("2.2", ANALYSIS)];
    const index = indexDependencyTargets(units, { documentOrderProven: true });
    expect(index.targets.filter((target) => target.kind === "table").map((target) => target.numbers)).toEqual([["1"], ["2"], ["3"]]);
    const resolution = resolveUnitDependencies({ unitId: units[1]!.unitId, text: ANALYSIS, index, budgetChars: 12_000, attach: true });
    expect(resolution.attached).toHaveLength(1);
    const dep = resolution.attached[0]!;
    expect(dep.sourceUnitId).toBe(units[0]!.unitId);
    expect(dep.via).toBe("caption_number");
    expect(dep.text).toContain("表 2 不同收入组患病率");
    expect(dep.text).toContain("低 & 120 & 24.0");
    expect(dep.text).toContain("高 & 126 & 25.2");
    expect(dep.text).toContain("Table 2 Prevalence by income");
    expect(dep.text).toContain("注：①以人数（患病率");
    expect(dep.text).not.toContain("两组基本特征"); // 不混入表 1
    expect(dep.text).not.toContain("2.1 基本情况"); // 不混入正文
    expect(resolution.inUnit).toEqual(["表3"]);
    expect(resolution.gaps).toEqual([]);
    expect(dep.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("标题在表下方（转写稿常见）：按全篇约定归属，夹在两表之间的标题不被上一张表吞掉", () => {
    const below = [
      "\\section*{2 结果}", "",
      tabular(["组别 & 例数 & 构成比", "A & 300 & 30.0"]), "",
      "\\textbf{表1 基本特征}", "",
      tabular(["模式 & 例数 & 占比", "M1 & 88 & 8.8"]), "",
      "\\textbf{表2 共病模式}", "",
      "2.3 正文段落。",
    ].join("\n");
    const discussion = "\\section*{3 讨论}\n\n如表2所示，M1 模式最常见。";
    const units = [unit("2 结果", below), unit("3 讨论", discussion)];
    const index = indexDependencyTargets(units, { documentOrderProven: true });
    expect(index.targets.map((target) => target.numbers)).toEqual([["1"], ["2"]]);
    const resolution = resolveUnitDependencies({ unitId: units[1]!.unitId, text: discussion, index, budgetChars: 12_000, attach: true });
    expect(resolution.attached.map((dep) => dep.text)).toHaveLength(1);
    expect(resolution.attached[0]!.text).toContain("M1 & 88 & 8.8");
    expect(resolution.attached[0]!.text).toContain("表2 共病模式");
    expect(resolution.attached[0]!.text).not.toContain("A & 300");
  });

  it("同号多表：DEPENDENCY_AMBIGUOUS，不附任何一张", () => {
    const a = unit("A", `\\textbf{表 2 甲}\n\n${tabular(["x & 1 & 2"])}`);
    const b = unit("B", `\\textbf{表 2 乙}\n\n${tabular(["y & 3 & 4"])}`);
    const c = unit("C", "正文引用见表 2。");
    const index = indexDependencyTargets([a, b, c], { documentOrderProven: true });
    const resolution = resolveUnitDependencies({ unitId: c.unitId, text: c.text, index, budgetChars: 12_000, attach: true });
    expect(resolution.attached).toEqual([]);
    expect(resolution.gaps).toMatchObject([{ status: "DEPENDENCY_AMBIGUOUS", mention: "表 2", checkStatus: "NOT_EVALUATED" }]);
    expect(resolution.gaps[0]!.candidates).toHaveLength(2);
  });

  it("\\ref 精确优先；label 重复定义 = 歧义；label 不存在 = 未解析；章节 label 只是导航", () => {
    const tables = unit("T", [
      "\\section{Results}\\label{sec:res}",
      "\\begin{table}\\caption{Main results}\\label{tab:main}\n\\begin{tabular}{ll}\nA & 0.71 \\\\\n\\end{tabular}\\end{table}",
      "\\begin{table}\\caption{Ablation}\\label{tab:dup}\n\\begin{tabular}{ll}\nB & 0.5 \\\\\n\\end{tabular}\\end{table}",
    ].join("\n\n"), "sections/results.tex");
    const other = unit("O", "\\begin{table}\\caption{Other}\\label{tab:dup}\n\\begin{tabular}{ll}\nC & 0.1 \\\\\n\\end{tabular}\\end{table}", "sections/other.tex");
    const text = "As Table~\\ref{tab:main} shows (see Section~\\ref{sec:res}), and \\cref{tab:dup,tab:missing}.";
    const citing = unit("D", text, "sections/discussion.tex");
    const index = indexDependencyTargets([tables, other, citing], { documentOrderProven: false });
    const resolution = resolveUnitDependencies({ unitId: citing.unitId, text, index, budgetChars: 12_000, attach: true });
    expect(resolution.attached.map((dep) => [dep.via, dep.labels])).toEqual([["label", ["tab:main"]]]);
    expect(resolution.attached[0]!.text).toContain("A & 0.71");
    expect(resolution.navigational).toEqual(["\\ref{sec:res}"]);
    expect(resolution.gaps.map((gap) => [gap.mention, gap.status])).toEqual([
      ["\\ref{tab:dup}", "DEPENDENCY_AMBIGUOUS"],
      ["\\ref{tab:missing}", "DEPENDENCY_UNRESOLVED"],
    ]);
    expect(resolution.gaps[0]!.reason).toContain("定义了 2 次");
    expect(resolution.gaps[0]!.candidates).toHaveLength(2);
  });

  it("多文件（顺序不可证明）不按计数器推断编号：文本「Table 2」fail closed；单文件且无 \\chapter 时才推断", () => {
    const body = (n: number) => `\\begin{table}\\caption{Result ${n}}\n\\begin{tabular}{ll}\nv & ${n} \\\\\n\\end{tabular}\\end{table}`;
    const multi = [unit("A", body(1), "sections/a.tex"), unit("B", body(2), "sections/b.tex"), unit("C", "See Table 2.", "sections/c.tex")];
    const multiIndex = indexDependencyTargets(multi, { documentOrderProven: false });
    expect(resolveUnitDependencies({ unitId: multi[2]!.unitId, text: "See Table 2.", index: multiIndex, budgetChars: 9_999, attach: true }).gaps[0]!.status).toBe("DEPENDENCY_UNRESOLVED");
    const single = [unit("A", body(1)), unit("B", body(2)), unit("C", "See Table 2.")];
    const singleIndex = indexDependencyTargets(single, { documentOrderProven: true });
    const resolved = resolveUnitDependencies({ unitId: single[2]!.unitId, text: "See Table 2.", index: singleIndex, budgetChars: 9_999, attach: true });
    expect(resolved.attached.map((dep) => [dep.via, dep.text.includes("v & 2")])).toEqual([["latex_counter", true]]);
    const chaptered = [unit("A", `\\chapter{X}\n${body(1)}`), unit("B", body(2)), unit("C", "See Table 2.")];
    expect(resolveUnitDependencies({ unitId: "main.tex::C", text: "See Table 2.", index: indexDependencyTargets(chaptered, { documentOrderProven: true }), budgetChars: 9_999, attach: true }).gaps[0]!.status).toBe("DEPENDENCY_UNRESOLVED");
  });

  it("公式：只认 \\label / \\tag；纯文本「式(3)」无可证明编号 → 未解析，不按 LaTeX 自动编号猜", () => {
    const eqUnit = unit("M", "\\begin{equation}\\label{eq:loss}\nL = a + b\n\\end{equation}\n\n\\begin{equation}\nR = c\\tag{3}\n\\end{equation}");
    const text = "由 \\eqref{eq:loss} 与式(3)，再结合公式（4）可得。";
    const citing = unit("N", text);
    const index = indexDependencyTargets([eqUnit, citing], { documentOrderProven: true });
    const resolution = resolveUnitDependencies({ unitId: citing.unitId, text, index, budgetChars: 9_999, attach: true });
    expect(resolution.attached.map((dep) => dep.via)).toEqual(["label", "tag"]);
    expect(resolution.gaps).toMatchObject([{ kind: "equation", status: "DEPENDENCY_UNRESOLVED", mention: "公式（4）" }]);
  });

  it("无表 / 非引用词（代表 2 / 试图 3）/ 表号在题注里：不产生依赖", () => {
    const citing = unit("X", "这代表 2 种情况，作者试图 3 次复核。全文没有表格。");
    const index = indexDependencyTargets([citing], { documentOrderProven: true });
    const resolution = resolveUnitDependencies({ unitId: citing.unitId, text: citing.text, index, budgetChars: 9_999, attach: true });
    expect(resolution).toMatchObject({ attached: [], gaps: [], inUnit: [] });
  });

  it("预算：依赖整块附上或 CONTEXT_OVERFLOW（不截断表格）；\\ref 优先于文本编号", () => {
    const big = unit("BIG", `\\textbf{表 5 大表}\n\n${tabular(Array.from({ length: 60 }, (_, i) => `r${i} & ${i} & ${i * 2}`))}`);
    const small = unit("S", "\\begin{table}\\caption{表 6 小表}\\label{tab:small}\n\\begin{tabular}{ll}\nq & 1 \\\\\n\\end{tabular}\\end{table}");
    const text = "见表 5，另见 \\ref{tab:small}。";
    const citing = unit("C", text);
    const index = indexDependencyTargets([big, small, citing], { documentOrderProven: true });
    const bigChars = index.targets.find((target) => target.unitId === big.unitId)!.text.length;
    const resolution = resolveUnitDependencies({ unitId: citing.unitId, text, index, budgetChars: bigChars - 1, attach: true });
    expect(resolution.attached.map((dep) => dep.labels)).toEqual([["tab:small"]]);
    expect(resolution.gaps).toMatchObject([{ mention: "表 5", status: "CONTEXT_OVERFLOW" }]);
    expect(resolution.dependencyChars).toBeLessThan(bigChars);
  });

  it("isolated_no_dependencies：照样解析但一律 NOT_ATTACHED_BY_POLICY（trace 可见缺什么），prompt 块为空", () => {
    const units = [unit("2 结果", RESULTS), unit("2.2", ANALYSIS)];
    const index = indexDependencyTargets(units, { documentOrderProven: true });
    const resolution = resolveUnitDependencies({ unitId: units[1]!.unitId, text: ANALYSIS, index, budgetChars: 12_000, attach: false });
    expect(resolution.attached).toEqual([]);
    expect(resolution.gaps).toMatchObject([{ mention: "表2", status: "NOT_ATTACHED_BY_POLICY" }]);
    expect(renderDependencyBlock({ attached: [], gaps: resolution.gaps, sourceVerification: "SOURCE_UNVERIFIED" })).toEqual([]);
    const record = buildContextSnapshotRecord({ policy: "isolated_no_dependencies", unitId: units[1]!.unitId, text: ANALYSIS, resolution, sourceVerification: "SOURCE_UNVERIFIED", budgetChars: 12_000 });
    expect(record.contextComplete).toBe(false);
  });

  it("指纹：只改被引表的一个数值 → 依赖指纹变化；改无关单元 → 不变；渲染块标明来源核验等级", () => {
    const build = (results: string, unrelated: string) => {
      const units = [unit("2 结果", results), unit("2.2", ANALYSIS), unit("3 讨论", unrelated)];
      const index = indexDependencyTargets(units, { documentOrderProven: true });
      return resolveUnitDependencies({ unitId: units[1]!.unitId, text: ANALYSIS, index, budgetChars: 12_000, attach: true });
    };
    const base = build(RESULTS, "讨论 A。");
    expect(dependencyFingerprint(build(RESULTS, "讨论 B（改动）。"))).toBe(dependencyFingerprint(base));
    expect(dependencyFingerprint(build(RESULTS.replace("高 & 126 & 25.2", "高 & 126 & 26.2"), "讨论 A。"))).not.toBe(dependencyFingerprint(base));
    const lines = renderDependencyBlock({ attached: base.attached, gaps: [], sourceVerification: "SOURCE_UNVERIFIED" });
    expect(lines.join("\n")).toContain("SOURCE_UNVERIFIED");
    expect(lines.join("\n")).toContain("来源单元「2 结果」");
  });

  it("quote 只出现在依赖参考中的 finding 被标注（不删除）", () => {
    const indices = referenceOnlyQuoteIndices("本单元原文：收入有统计学意义。", ["低 & 120 & 24.0 \\\\ 高 & 126 & 25.2"], [
      { quote: "收入有统计学意义" }, { quote: "高 & 126 & 25.2" }, { quote: "不存在的句子片段啊" },
    ]);
    expect(indices).toEqual([1]);
  });

  it("策略解析", () => {
    expect(parseReviewUnitContextPolicy("isolated_snapshot")).toBe("isolated_snapshot");
    expect(parseReviewUnitContextPolicy(" Shared_Session ")).toBe("shared_session");
    expect(parseReviewUnitContextPolicy("isolated")).toBeUndefined();
  });
});

describe("摘要锚点（只读口径 blocking 以「摘要所述核心结论」为准）", () => {
  const FRONT = [
    "\\maketitle", "",
    "\\textbf{摘要}：目的 了解两组差异。结果 A 组风险更高（OR=1.50）。结论 应优先干预 A 组。", "",
    "\\textbf{关键词}：两组；风险", "",
    "\\textbf{Abstract}: Objective To compare groups. Results Group A had higher risk.", "",
    "随着人口老龄化（引言正文，不属于摘要）……",
  ].join("\n");
  const units = [unit("frontmatter", FRONT), unit("2 结果", RESULTS), unit("2.2", ANALYSIS), unit("3 讨论", "\\section*{3 讨论}\n\n讨论正文。")];

  it("只取摘要段（中英文），不含关键词与引言；其他单元附为 D1，摘要所在单元记 inUnit", () => {
    const anchor = locateAbstractAnchor(units);
    expect(anchor.found).toBe(true);
    if (!anchor.found) return;
    expect(anchor.text).toContain("结论 应优先干预 A 组");
    expect(anchor.text).toContain("Group A had higher risk");
    expect(anchor.text).not.toContain("关键词");
    expect(anchor.text).not.toContain("引言正文");
    const index = indexDependencyTargets(units, { documentOrderProven: true });
    const analysis = resolveUnitDependencies({ unitId: units[2]!.unitId, text: ANALYSIS, index, budgetChars: 12_000, attach: true, rubricAnchor: anchor });
    expect(analysis.attached.map((dep) => [dep.refId, dep.kind])).toEqual([["D1", "abstract"], ["D2", "table"]]);
    expect(analysis.dependencyChars).toBe(anchor.text.length + analysis.attached[1]!.chars);
    const front = resolveUnitDependencies({ unitId: units[0]!.unitId, text: FRONT, index, budgetChars: 12_000, attach: true, rubricAnchor: anchor });
    expect(front.attached).toEqual([]);
    expect(front.inUnit).toEqual(["论文摘要"]);
    const lines = renderDependencyBlock({ attached: analysis.attached, gaps: analysis.gaps, sourceVerification: "SOURCE_UNVERIFIED" }).join("\n");
    expect(lines.indexOf("===== 论文摘要")).toBeLessThan(lines.indexOf("===== 跨单元依赖"));
    // 没有表格依赖的单元：只有摘要块，没有空的「跨单元依赖」块
    const discussion = resolveUnitDependencies({ unitId: units[3]!.unitId, text: units[3]!.text, index, budgetChars: 12_000, attach: true, rubricAnchor: anchor });
    const onlyAnchor = renderDependencyBlock({ attached: discussion.attached, gaps: discussion.gaps, sourceVerification: "AUTHOR_SOURCE" }).join("\n");
    expect(onlyAnchor).toContain("===== 论文摘要");
    expect(onlyAnchor).not.toContain("跨单元依赖");
  });

  it("摘要改动 → 所有引用它的单元依赖指纹变化；B 策略只记 NOT_ATTACHED_BY_POLICY（prompt 块为空）", () => {
    const index = indexDependencyTargets(units, { documentOrderProven: true });
    const fp = (front: string) => {
      const changed = [unit("frontmatter", front), ...units.slice(1)];
      return dependencyFingerprint(resolveUnitDependencies({ unitId: units[3]!.unitId, text: units[3]!.text, index, budgetChars: 12_000, attach: true, rubricAnchor: locateAbstractAnchor(changed) }));
    };
    expect(fp(FRONT.replace("OR=1.50", "OR=1.05"))).not.toBe(fp(FRONT));
    const b = resolveUnitDependencies({ unitId: units[3]!.unitId, text: units[3]!.text, index, budgetChars: 12_000, attach: false, rubricAnchor: locateAbstractAnchor(units) });
    expect(b.gaps).toMatchObject([{ kind: "abstract", status: "NOT_ATTACHED_BY_POLICY", check: "BLOCKING_DETERMINATION" }]);
    expect(renderDependencyBlock({ attached: b.attached, gaps: b.gaps, sourceVerification: "AUTHOR_SOURCE" })).toEqual([]);
  });

  it("\\begin{abstract} 优先；找不到 / 超限 → blocking 判断 NOT_EVALUATED（不截断）", () => {
    const env = [unit("front", "\\begin{abstract}\nWe find X.\n\\end{abstract}\n\n\\textbf{Abstract}: other"), unit("body", "Body.")];
    const anchor = locateAbstractAnchor(env);
    expect(anchor.found && anchor.text).toBe("\\begin{abstract}\nWe find X.\n\\end{abstract}");
    const none = locateAbstractAnchor([unit("body", "No abstract here.")]);
    expect(none).toMatchObject({ found: false, status: "DEPENDENCY_UNRESOLVED" });
    const index = indexDependencyTargets([unit("body", "No abstract here.")], { documentOrderProven: true });
    expect(resolveUnitDependencies({ unitId: "main.tex::body", text: "No abstract here.", index, budgetChars: 100, attach: true, rubricAnchor: none }).gaps)
      .toMatchObject([{ mention: "论文摘要", status: "DEPENDENCY_UNRESOLVED", check: "BLOCKING_DETERMINATION", checkStatus: "NOT_EVALUATED" }]);
    expect(locateAbstractAnchor([unit("front", `\\textbf{摘要}：${"长".repeat(50)}`)], 20)).toMatchObject({ found: false, status: "CONTEXT_OVERFLOW" });
  });
});

describe("配置：PAPERTEAM_REVIEW_UNIT_CONTEXT（缺省 shared_session；旧开关映射；非法值拒绝启动）", () => {
  it("缺省 / 新键 / 旧键 / 冲突以新键为准 / 非法值", () => {
    expect(loadConfig({}).review).toMatchObject({ unitContextPolicy: "shared_session", unitDependencyBudgetChars: 12_000 });
    expect(loadConfig({ PAPERTEAM_REVIEW_UNIT_CONTEXT: "isolated_no_dependencies" }).review.unitContextPolicy).toBe("isolated_no_dependencies");
    expect(loadConfig({ PAPERTEAM_REVIEW_UNIT_ISOLATION: "1" }).review.unitContextPolicy).toBe("isolated_snapshot");
    expect(loadConfig({ PAPERTEAM_REVIEW_UNIT_ISOLATION: "1", PAPERTEAM_REVIEW_UNIT_CONTEXT: "shared_session" }).review.unitContextPolicy).toBe("shared_session");
    expect(loadConfig({ PAPERTEAM_REVIEW_UNIT_DEPENDENCY_CHARS: "4000" }).review.unitDependencyBudgetChars).toBe(4000);
    expect(() => loadConfig({ PAPERTEAM_REVIEW_UNIT_CONTEXT: "isolated" })).toThrow(ConfigError);
  });
});

describe("只读评估视图：单元上下文如实呈现（不改生产 Gate）", () => {
  const base = {
    generatedAt: "2026-10-20T00:00:00.000Z", round: 1, issues: [],
    counts: { critical: 0, major: 0, minor: 0, byCategory: {}, blocking: 0 },
    scores: { academicScore: 70, styleRisk: 10, factVerdicts: null },
    openCritical: 0, openMajor: 0, unsupportedCriticalClaims: 0, reportPaths: [],
  };
  const coverage = { mode: "units", snapshotId: "s", round: 1, targetUnits: 2, completedUnits: 2, failedUnits: 0, reusedUnits: 0, targetChars: 10, reviewedChars: 10, ratio: 1, complete: true, failedUnitIds: [] };
  const evidence = { total: 0, byStatus: { verified: 0, unverified: 0, contradictory: 0, not_found: 0, plausible: 0, mismatch: 0, unverifiable: 0 }, contradictory: 0, skippedLines: 0 } as never;
  const view = (review: ReviewSummary) => buildPublishedAssessmentView({
    gate: evaluateQualityGate({ review, citation: null, evidence, feasibility: null }), review, citationReportAvailable: false, evidenceRecords: 0, feasibilityEvaluated: false,
  });

  it("共享会话：标明跨单元核对不可复现；隔离快照：依赖缺口逐条 NOT_EVALUATED（BLOCKED_BY_CONTEXT）", () => {
    const shared = view({ ...base, coverage } as unknown as ReviewSummary);
    expect(shared.notEvaluated.map((entry) => entry.item)).toContain("unit_context_reproducibility");
    const isolated = view({
      ...base,
      coverage: {
        ...coverage,
        context: {
          policy: "isolated_snapshot", sourceVerification: "SOURCE_UNVERIFIED", dependencyBudgetChars: 12_000, unitsWithDependencies: 1, attachedDependencies: 1, dependencyChars: 900,
          contextIncompleteUnits: [{ unitId: "main.tex::sec:a", gaps: [{ mention: "表 5", status: "DEPENDENCY_AMBIGUOUS", reason: "2 个候选，不选择" }] }],
          referenceOnlyQuoteFindings: 0, cacheIncompatibleUnitIds: [],
        },
      },
    } as unknown as ReviewSummary);
    const items = isolated.notEvaluated.map((entry) => entry.item);
    expect(items).not.toContain("unit_context_reproducibility");
    expect(isolated.notEvaluated.find((entry) => entry.item === "cross_unit_reference:main.tex::sec:a:表 5")?.reason).toContain("BLOCKED_BY_CONTEXT");
  });

  it("M14.9.5.2：跨章一致性审查失败 → notEvaluated 列出 cross_chapter_consistency；新增 informational 规则为 REPORTED_ONLY", () => {
    const failed = view({ ...base, coverage: { ...coverage, crossChapter: { status: "failed", error: "503" } } } as unknown as ReviewSummary);
    expect(failed.notEvaluated.map((entry) => entry.item)).toContain("cross_chapter_consistency");
    expect(failed.ruleApplicability.find((entry) => entry.rule === "review_cross_chapter_reported")?.applicability).toBe("REPORTED_ONLY");
    expect(failed.ruleApplicability.find((entry) => entry.rule === "review_unit_context_reported")?.applicability).toBe("REPORTED_ONLY");
    const ok = view({ ...base, coverage: { ...coverage, crossChapter: { status: "completed" } } } as unknown as ReviewSummary);
    expect(ok.notEvaluated.map((entry) => entry.item)).not.toContain("cross_chapter_consistency");
  });
});

describe("M14.9.5.2 跨页续表 / 图 / 跨文件引用", () => {
  const tab = (rows: string[]): string => ["\\begin{table}[htbp]\\centering", "\\begin{tabular}{ll}", ...rows.map((row) => `${row} \\\\`), "\\end{tabular}", "\\end{table}"].join("\n");
  const floatWithCaption = (caption: string, rows: string[], extra = ""): string =>
    ["\\begin{table}[t]", ...(extra !== "" ? [extra] : []), `\\caption{${caption}}`, "\\begin{tabular}{ll}", ...rows.map((row) => `${row} \\\\`), "\\end{tabular}", "\\end{table}"].join("\n");

  it("转写稿「续表 2」：与表 2 合为一个依赖（含两部分全部行）；不吞掉表 3 的编号", () => {
    const results = [
      "\\section*{结果}", "", "\\textbf{表 1 基本特征}", "", tab(["A & 1"]), "", "正文一段。", "",
      "\\textbf{表 2 分层患病率}", "", tab(["低 & 24.0"]), "", "\\textbf{续表 2}", "", tab(["高 & 25.2"]), "",
      "\\textbf{表 3 多因素}", "", tab(["OR & 1.1"]),
    ].join("\n");
    const units = [unit("结果", results), unit("分析", "见表2与表3。")];
    const index = indexDependencyTargets(units, { documentOrderProven: true });
    const resolution = resolveUnitDependencies({ unitId: units[1]!.unitId, text: units[1]!.text, index, budgetChars: 12_000, attach: true });
    expect(resolution.gaps).toEqual([]);
    const t2 = resolution.attached.find((dep) => dep.mentions.includes("表2"))!;
    expect(t2.parts).toHaveLength(2);
    expect(t2.text).toContain("低 & 24.0");
    expect(t2.text).toContain("高 & 25.2");
    expect(t2.text).not.toContain("OR & 1.1");
    const t3 = resolution.attached.find((dep) => dep.mentions.includes("表3"))!;
    expect(t3.parts).toBeUndefined();
    expect(t3.text).toContain("OR & 1.1");
    expect(t3.text).not.toContain("续表");
    const block = renderDependencyBlock({ attached: resolution.attached, gaps: resolution.gaps, sourceVerification: "SOURCE_UNVERIFIED" }).join("\n");
    expect(block).toContain("含跨页续表 / 续图（2 部分");
  });

  it("作者 LaTeX \\ContinuedFloat：计数器不递增——「Table 3」是 Ablation 而不是 Table 2 的续表；\\label 只在主表上也带上续表", () => {
    const results = [
      "\\section{Results}", "", floatWithCaption("Baseline", ["A & 1"]), "",
      floatWithCaption("Main results\\label{tab:main}", ["x & 24.0"]), "",
      floatWithCaption("Main results (continued)", ["y & 25.2"], "\\ContinuedFloat"), "",
      floatWithCaption("Ablation", ["z & 9.9"]),
    ].join("\n");
    const units = [unit("Results", results), unit("Analysis", "As Table 3 shows, ablation helps; Table~\\ref{tab:main} lists main results.")];
    const index = indexDependencyTargets(units, { documentOrderProven: true });
    expect(index.targets.filter((target) => target.kind === "table").map((target) => [target.numbers, target.continued === true])).toEqual([[["1"], false], [["2"], false], [["2"], true], [["3"], false]]);
    const resolution = resolveUnitDependencies({ unitId: units[1]!.unitId, text: units[1]!.text, index, budgetChars: 12_000, attach: true });
    expect(resolution.gaps).toEqual([]);
    const t3 = resolution.attached.find((dep) => dep.mentions.includes("Table 3"))!;
    expect(t3.text).toContain("z & 9.9");
    expect(t3.text).not.toContain("25.2");
    const main = resolution.attached.find((dep) => dep.mentions.includes("\\ref{tab:main}"))!;
    expect(main.via).toBe("label");
    expect(main.text).toContain("x & 24.0");
    expect(main.text).toContain("y & 25.2");
  });

  it("英文转写「Table 2 (continued)」不再歧义；续表超预算时整体 CONTEXT_OVERFLOW（不只附半张）", () => {
    const results = [
      "\\section*{Results}", "", "\\textbf{Table 1 Baseline}", "", tab(["A & 1"]), "", "Body paragraph.", "",
      "\\textbf{Table 2 Main results}", "", tab(["x & 24.0"]), "", "\\textbf{Table 2 (continued)}", "", tab(["y & 25.2"]),
    ].join("\n");
    const units = [unit("Results", results), unit("Analysis", "Table 2 lists main results.")];
    const index = indexDependencyTargets(units, { documentOrderProven: true });
    const ok = resolveUnitDependencies({ unitId: units[1]!.unitId, text: units[1]!.text, index, budgetChars: 12_000, attach: true });
    expect(ok.attached).toHaveLength(1);
    expect(ok.attached[0]!.text).toContain("y & 25.2");
    const firstPartChars = index.targets.find((target) => target.numbers[0] === "2" && target.continued !== true)!.text.length;
    const tight = resolveUnitDependencies({ unitId: units[1]!.unitId, text: units[1]!.text, index, budgetChars: firstPartChars + 5, attach: true });
    expect(tight.attached).toEqual([]);
    expect(tight.gaps).toMatchObject([{ mention: "Table 2", status: "CONTEXT_OVERFLOW" }]);
    expect(tight.gaps[0]!.candidates).toHaveLength(2);
  });

  it("下方标题约定（英文题注全在表下）时，紧邻上方的同号中文标题一并纳入；上一张表的下方标题不被吞入", () => {
    const results = [
      "\\section*{结果}", "", tab(["a & 1"]), "", "\\textbf{Tab. 1 Baseline}", "", "正文一段。", "",
      "\\textbf{表2 精度对比}", "", tab(["b & 83.8"]), "", "\\textbf{Tab. 2 Accuracy comparison}",
    ].join("\n");
    const units = [unit("结果", results), unit("分析", "见表2与表1。")];
    const index = indexDependencyTargets(units, { documentOrderProven: true });
    const resolution = resolveUnitDependencies({ unitId: units[1]!.unitId, text: units[1]!.text, index, budgetChars: 12_000, attach: true });
    expect(resolution.gaps).toEqual([]);
    const t2 = resolution.attached.find((dep) => dep.mentions.includes("表2"))!;
    expect(t2.text).toContain("表2 精度对比");
    expect(t2.text).toContain("Tab. 2 Accuracy comparison");
    const t1 = resolution.attached.find((dep) => dep.mentions.includes("表1"))!;
    expect(t1.text).not.toContain("精度对比");
    expect(t1.text).toContain("Tab. 1 Baseline");
  });

  it("两张都标「表 2」且都不是续表：仍是 DEPENDENCY_AMBIGUOUS（续表规则不放宽同号多表）", () => {
    const results = ["\\section*{结果}", "", "\\textbf{表 2 甲}", "", tab(["a & 1"]), "", "正文。", "", "\\textbf{表 2 乙}", "", tab(["b & 2"])].join("\n");
    const units = [unit("结果", results), unit("分析", "见表2。")];
    const index = indexDependencyTargets(units, { documentOrderProven: true });
    const resolution = resolveUnitDependencies({ unitId: units[1]!.unitId, text: units[1]!.text, index, budgetChars: 12_000, attach: true });
    expect(resolution.attached).toEqual([]);
    expect(resolution.gaps).toMatchObject([{ mention: "表2", status: "DEPENDENCY_AMBIGUOUS" }]);
  });

  it("图：跨文件 \\ref 经 \\label 定位，附题注与 includegraphics 路径（不含图像内容）；主表在本单元、续表在其他单元时只附续表部分", () => {
    const fig = ["\\begin{figure}[t]", "\\includegraphics{figs/a.png}", "\\caption{Throughput vs. load}\\label{fig:tp}", "\\end{figure}"].join("\n");
    const units = [unit("Results", `\\section{Results}\n\n${fig}`, "sections/results.tex"), unit("Discussion", "Figure~\\ref{fig:tp} shows saturation.", "sections/discussion.tex")];
    const index = indexDependencyTargets(units, { documentOrderProven: false });
    const resolution = resolveUnitDependencies({ unitId: units[1]!.unitId, text: units[1]!.text, index, budgetChars: 12_000, attach: true });
    expect(resolution.attached).toHaveLength(1);
    expect(resolution.attached[0]!).toMatchObject({ kind: "figure", via: "label", sourceFile: "sections/results.tex" });
    expect(resolution.attached[0]!.text).toContain("figs/a.png");
    // 主表在本单元、续表落在下一单元：引用主表的单元只需附上续表部分
    const split = [
      unit("A", ["\\section*{结果}", "", "\\textbf{表 1 主表}", "", tab(["x & 1"]), "", "如表1所示。"].join("\n")),
      unit("B", ["\\textbf{续表 1}", "", tab(["y & 2"]), "", "正文。"].join("\n")),
    ];
    const splitIndex = indexDependencyTargets(split, { documentOrderProven: true });
    const own = resolveUnitDependencies({ unitId: split[0]!.unitId, text: split[0]!.text, index: splitIndex, budgetChars: 12_000, attach: true });
    expect(own.attached).toHaveLength(1);
    expect(own.attached[0]!.text).toContain("y & 2");
    expect(own.attached[0]!.text).not.toContain("x & 1");
  });
});
