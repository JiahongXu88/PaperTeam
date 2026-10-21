/**
 * M14.9.5.4 受控的隐式依赖（review/implicitContext.ts + resolveUnitDependencies 集成）——纯函数、合成夹具。
 *
 *   - reverse_reference：表格单元的解读写在引用它的其他单元 → 附上引用句；
 *   - entity_cooccurrence：桥接句（同时含本单元数值与被引表格数值）优先；全文普遍的数值不牵出无关句；
 *   - protocol_convention：文档顺序在前的统计方法 / 记号单元整段附上，在后的不附；
 *   - 确定性 / 预算 / 不截断半句；源段落改动 → 依赖指纹变化（引用它的单元缓存失效）；isolated_no_dependencies 不附。
 */
import { describe, expect, it } from "vitest";

import { anchorsOf, indexImplicitContext, resolveImplicitContext } from "../../src/review/implicitContext.js";
import { buildContextSnapshotRecord, indexDependencyTargets, renderDependencyBlock, resolveUnitDependencies } from "../../src/review/reviewContextSnapshot.js";

const filler = (tag: string, count: number) => Array.from({ length: count }, (_, i) => `${tag} 第 ${i + 1} 句讨论 40 条序列与 23 条同源视频的一般情况。`).join("\n");

function units(overrides: Partial<Record<"protocol" | "forensics" | "events" | "discussion" | "table", string>> = {}) {
  return [
    { unitId: "m::protocol", file: "m", heading: "评测器与统计方法", text: overrides.protocol ?? "\\subsection{评测器与统计方法}\n配对统计的估计量为每个聚类单位的平均差值；“优/劣/平”按前者计；比较族 F1 为主比较，F2 为组成成分对基座；区间为 20,000 次配对聚类 bootstrap 的百分位区间，符号检验为精确双侧检验。" },
    { unitId: "m::forensics", file: "m", heading: "取证方法", text: overrides.forensics ?? `\\subsection{取证方法}\n逐真值目标的身份变化与 IDSW 指标事件一致（两口径事件数 118 对 121，相差的 3 起为同帧双切换）。\n${filler("取证", 12)}` },
    { unitId: "m::events", file: "m", heading: "事件层次", text: overrides.events ?? "\\subsection{事件层次}\n\\begin{table}\n\\caption{表 2 事件层次}\\label{tab:levels}\n\\begin{tabular}{ll}基座事件 & 118 \\\\ L1 & 14 \\\\\\end{tabular}\n\\end{table}" },
    { unitId: "m::discussion", file: "m", heading: "讨论", text: overrides.discussion ?? `\\subsection{讨论}\n表~\\ref{tab:levels} 显示 H1+H4 把 IDSW 从 121 降到 80。\n${filler("讨论", 12)}` },
    { unitId: "m::table", file: "m", heading: "整段结果", text: overrides.table ?? `\\subsection{整段结果}\n\\begin{table}\n\\caption{表 3 整段}\\label{tab:official}\n\\begin{tabular}{ll}H1+H4 & 497 \\\\\\end{tabular}\n\\end{table}\n${filler("整段", 4)}` },
    { unitId: "m::interp", file: "m", heading: "整段解读", text: `\\subsection{整段解读}\n表~\\ref{tab:official} 中 H1+H4 的 HOTA 仍低于 BoT-SORT（描述性）。\n${filler("解读", 12)}` },
  ];
}

describe("implicitContext：受控的隐式依赖", () => {
  it("anchorsOf：数值归一千分位 / 标识符；LaTeX 命令名与 \\ref 标签不算实体", () => {
    const anchors = anchorsOf("共 56{,}334 帧，QD(120) 与 H1+H4 在 MVI\\_40775\\_1\\_200 上 $\\le 0$，见表~\\ref{tab:x12}");
    expect([...anchors]).toEqual(expect.arrayContaining(["#56334", "@QD120", "@H1+H4", "@MVI_40775_1_200"]));
    expect([...anchors].some((anchor) => anchor.includes("le0") || anchor.includes("x12"))).toBe(false);
  });

  it("reverse_reference：只有表格的单元附上引用它的解读句；entity_cooccurrence：桥接句（121 与被引表格里的 118）优先", () => {
    const all = units();
    const index = indexImplicitContext(all);
    const table = resolveImplicitContext({ unitId: "m::table", text: all[4]!.text, attachedTexts: [], index });
    expect(table.snippets.map((snippet) => [snippet.via, snippet.sourceUnitId])).toContainEqual(["reverse_reference", "m::interp"]);
    expect(table.snippets.find((snippet) => snippet.via === "reverse_reference")!.text).toContain("仍低于 BoT-SORT");
    const discussion = resolveImplicitContext({ unitId: "m::discussion", text: all[3]!.text, attachedTexts: [all[2]!.text], index });
    const bridge = discussion.snippets.find((snippet) => snippet.sourceUnitId === "m::forensics");
    expect(bridge?.via).toBe("entity_cooccurrence");
    expect(bridge?.text).toContain("两口径事件数 118 对 121");
    // 普遍实体（40 / 23 出现在几十句里）不牵出无关句
    expect(discussion.snippets.every((snippet) => !snippet.text.includes("一般情况"))).toBe(true);
  });

  it("protocol_convention：文档顺序在前的统计方法单元整段附给其后的单元，不附给在前的单元", () => {
    const all = units();
    const index = indexImplicitContext(all);
    const later = resolveImplicitContext({ unitId: "m::interp", text: all[5]!.text, attachedTexts: [], index });
    expect(later.snippets.map((snippet) => snippet.via)).toContain("protocol_convention");
    expect(later.snippets.find((snippet) => snippet.via === "protocol_convention")!.text).toContain("“优/劣/平”按前者计");
    const reordered = [all[5]!, ...all.slice(0, 5)];
    const earlier = resolveImplicitContext({ unitId: "m::interp", text: all[5]!.text, attachedTexts: [], index: indexImplicitContext(reordered) });
    expect(earlier.snippets.map((snippet) => snippet.via)).not.toContain("protocol_convention");
  });

  it("确定性 + 预算：同一输入同一结果；片段是整句拼接，超出预算整段不附", () => {
    const all = units();
    const index = indexImplicitContext(all);
    const first = resolveImplicitContext({ unitId: "m::discussion", text: all[3]!.text, attachedTexts: [all[2]!.text], index });
    const second = resolveImplicitContext({ unitId: "m::discussion", text: all[3]!.text, attachedTexts: [all[2]!.text], index: indexImplicitContext(all.map((unit) => ({ ...unit }))) });
    expect(second).toEqual(first);
    const tight = resolveImplicitContext({ unitId: "m::discussion", text: all[3]!.text, attachedTexts: [all[2]!.text], index, options: { budgetChars: 10, maxSnippets: 6, maxSegmentsPerSnippet: 3, minSharedAnchors: 2, conventionBudgetChars: 5_000, conventionMaxUnitChars: 2_500 } });
    expect(tight.snippets.every((snippet) => snippet.via === "protocol_convention")).toBe(true);
    expect(tight.skippedOverBudget).toBeGreaterThan(0);
  });
});

describe("resolveUnitDependencies × 隐式依赖：快照、指纹、渲染", () => {
  const resolveFor = (all: ReturnType<typeof units>, unitId: string, attach = true) => {
    const unit = all.find((entry) => entry.unitId === unitId)!;
    return resolveUnitDependencies({
      unitId, text: unit.text, index: indexDependencyTargets(all, { documentOrderProven: true }), budgetChars: 12_000, attach,
      implicit: { index: indexImplicitContext(all) },
    });
  };

  it("隐式片段作为 kind=context 附上、计入依赖字符但不改主单元原文；渲染为「相关上下文」块", () => {
    const resolution = resolveFor(units(), "m::discussion");
    const contexts = resolution.attached.filter((dep) => dep.kind === "context");
    expect(contexts.length).toBeGreaterThan(0);
    expect(contexts.every((dep) => /^C\d+$/.test(dep.refId) && dep.sha256.length === 64)).toBe(true);
    const block = renderDependencyBlock({ attached: resolution.attached, gaps: resolution.gaps, sourceVerification: "AUTHOR_SOURCE" }).join("\n");
    expect(block).toContain("===== 相关上下文（隐式依赖");
    expect(block).toContain("两口径事件数 118 对 121");
    const record = buildContextSnapshotRecord({ policy: "isolated_snapshot", unitId: "m::discussion", text: units()[3]!.text, resolution, sourceVerification: "AUTHOR_SOURCE", budgetChars: 12_000 });
    expect(record.schema).toBe("paperteam.review-context-snapshot/v3");
    expect(record.unitChars).toBe(units()[3]!.text.length);
  });

  it("源段落改动 → 依赖指纹变化（引用它的单元缓存失效）；无关单元改动不影响", () => {
    const base = buildContextSnapshotRecord({ policy: "isolated_snapshot", unitId: "m::discussion", text: units()[3]!.text, resolution: resolveFor(units(), "m::discussion"), sourceVerification: "AUTHOR_SOURCE", budgetChars: 12_000 });
    const changedSource = units({ forensics: `\\subsection{取证方法}\n逐真值目标的身份变化与 IDSW 指标事件一致（两口径事件数 118 对 121，相差的 3 起为同帧三切换）。\n${filler("取证", 12)}` });
    const changed = buildContextSnapshotRecord({ policy: "isolated_snapshot", unitId: "m::discussion", text: units()[3]!.text, resolution: resolveFor(changedSource, "m::discussion"), sourceVerification: "AUTHOR_SOURCE", budgetChars: 12_000 });
    expect(changed.dependencyFingerprint).not.toBe(base.dependencyFingerprint);
    const unrelated = units({ table: `\\subsection{整段结果}\n\\begin{table}\n\\caption{表 3 整段}\\label{tab:official}\n\\begin{tabular}{ll}H1+H4 & 498 \\\\\\end{tabular}\n\\end{table}\n${filler("整段", 4)}` });
    const same = buildContextSnapshotRecord({ policy: "isolated_snapshot", unitId: "m::discussion", text: units()[3]!.text, resolution: resolveFor(unrelated, "m::discussion"), sourceVerification: "AUTHOR_SOURCE", budgetChars: 12_000 });
    expect(same.dependencyFingerprint).toBe(base.dependencyFingerprint);
  });

  it("isolated_no_dependencies（attach=false）不附任何隐式片段", () => {
    expect(resolveFor(units(), "m::discussion", false).attached.filter((dep) => dep.kind === "context")).toEqual([]);
  });
});
