import { describe, expect, it } from "vitest";

import { renderDiagramTeX } from "../../src/figures/tikzCodeGen.js";
import { validateDiagramSpec } from "../../src/figures/spec.js";

/**
 * C2 TikZ codegen golden 测试。
 *
 * golden 方式选择：显式 golden 字符串断言（理由同 pgfplotsCodeGen.test.ts——
 * 快照重跑 -U 会静默吞掉模板漂移；布局是 TS 侧确定性计算，输出完全可预测，
 * 适合整文档 golden）。重点覆盖：分层坐标、注释挂靠、fit 分组、受控换行、
 * 注入转义、comparison 双列、布局方向转置。
 */

function compileDiagramTeX(rawSpec: Record<string, unknown>): string {
  const result = validateDiagramSpec(rawSpec);
  if (!result.ok || result.spec === undefined) {
    throw new Error(`spec 应合法：${result.errors.join("；")}`);
  }
  return renderDiagramTeX(result.spec);
}

function chainSpec(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    layout: "vertical",
    nodes: [
      { id: "input", label: "Input" },
      { id: "encoder", label: "Encoder" },
      { id: "decoder", label: "Decoder" },
    ],
    edges: [
      { from: "input", to: "encoder" },
      { from: "encoder", to: "decoder" },
    ],
    ...extra,
  };
}

describe("renderDiagramTeX", () => {
  it("纵向链式 DAG：整文档 golden（分层坐标 18mm 层距 + 箭头 + 标题）", () => {
    const tex = compileDiagramTeX(chainSpec({ title: "Tracker Pipeline" }));
    const expected = [
      "\\documentclass[border=2pt]{standalone}",
      "\\usepackage{tikz}",
      "\\usetikzlibrary{positioning,arrows.meta,fit,backgrounds}",
      "\\begin{document}",
      "\\begin{tikzpicture}[",
      "  stage/.style={rectangle, draw, thick, rounded corners=2pt, align=center, font=\\small, minimum height=9mm, minimum width=24mm, fill=black!4},",
      "  annotation/.style={rectangle, draw=black!60, dashed, align=center, font=\\footnotesize\\itshape, text=black!75, inner sep=2pt},",
      "  leftbox/.style={rectangle, draw, thick, rounded corners=2pt, align=center, font=\\small, minimum height=9mm, minimum width=24mm, fill=black!8},",
      "  rightbox/.style={rectangle, draw, thick, rounded corners=2pt, align=center, font=\\small, minimum height=9mm, minimum width=24mm, fill=black!16},",
      "  arr/.style={-{Stealth[length=2.4mm]}, thick},",
      "  annotarr/.style={-{Stealth[length=2mm]}, thin, dashed, black!60},",
      "  grplab/.style={font=\\footnotesize\\bfseries, text=black!60},",
      "  figtitle/.style={font=\\normalsize\\bfseries},",
      "  edge label/.style={font=\\footnotesize, fill=white, inner sep=1pt},",
      "  grpbox/.style={rectangle, rounded corners=3pt, draw=black!50, dashed, inner sep=5mm}",
      "]",
      "\\node[stage] (input) at (0mm,0mm) {Input};",
      "\\node[stage] (encoder) at (0mm,-18mm) {Encoder};",
      "\\node[stage] (decoder) at (0mm,-36mm) {Decoder};",
      "\\draw[arr] (input) -- (encoder);",
      "\\draw[arr] (encoder) -- (decoder);",
      "\\node[figtitle, anchor=south] at (0mm,8mm) {Tracker Pipeline};",
      "\\end{tikzpicture}",
      "\\end{document}",
      "",
    ].join("\n");
    expect(tex).toBe(expected);
  });

  it("分叉 DAG：同层节点横向展开（±22.5mm），最长路径分层", () => {
    const tex = compileDiagramTeX({
      layout: "vertical",
      nodes: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
        { id: "d", label: "D" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
        { from: "b", to: "d" },
        { from: "c", to: "d" },
      ],
    });
    expect(tex).toContain("\\node[stage] (a) at (0mm,0mm) {A};");
    expect(tex).toContain("\\node[stage] (b) at (-22.5mm,-18mm) {B};");
    expect(tex).toContain("\\node[stage] (c) at (22.5mm,-18mm) {C};");
    expect(tex).toContain("\\node[stage] (d) at (0mm,-36mm) {D};");
  });

  it("横向布局：主轴转置（层沿 x，层内沿 y）", () => {
    const tex = compileDiagramTeX(chainSpec({ layout: "horizontal" }));
    expect(tex).toContain("\\node[stage] (input) at (0mm,0mm) {Input};");
    expect(tex).toContain("\\node[stage] (encoder) at (45mm,0mm) {Encoder};");
    expect(tex).toContain("\\node[stage] (decoder) at (90mm,0mm) {Decoder};");
  });

  it("annotation：挂在连接对象旁（虚线细箭头 + 右侧偏移 + 同对象堆叠）", () => {
    const tex = compileDiagramTeX({
      layout: "vertical",
      nodes: [
        { id: "input", label: "Input" },
        { id: "encoder", label: "Encoder" },
        { id: "note1", label: "Gated EMA", role: "annotation" },
        { id: "note2", label: "Frozen encoder", role: "annotation" },
      ],
      edges: [
        { from: "input", to: "encoder" },
        { from: "note1", to: "encoder" },
        { from: "note2", to: "encoder" },
      ],
    });
    expect(tex).toContain("\\node[annotation] (note1) at (55mm,-18mm) {Gated EMA};");
    expect(tex).toContain("\\node[annotation] (note2) at (55mm,-30mm) {Frozen encoder};");
    expect(tex).toContain("\\draw[annotarr] (note1) -- (encoder);");
    expect(tex).toContain("\\draw[annotarr] (note2) -- (encoder);");
  });

  it("group：背景层 fit 框 + 组标签（框外左上）", () => {
    const spec = chainSpec();
    (spec.nodes as Array<Record<string, unknown>>)[0]!.group = "mod";
    (spec.nodes as Array<Record<string, unknown>>)[1]!.group = "mod";
    spec.groups = [{ id: "mod", label: "Motion Model 100%" }];
    const tex = compileDiagramTeX(spec);
    expect(tex).toContain("\\begin{scope}[on background layer]");
    expect(tex).toContain("\\node[grpbox, fit=(input)(encoder)] (mod) {};");
    expect(tex).toContain(
      "\\node[grplab, anchor=south west] at ([xshift=2mm,yshift=2mm]mod.north west) {Motion Model 100\\%};",
    );
    expect(tex).toContain("\\end{scope}");
  });

  it("受控换行：label 的 LF → TikZ 行分隔（align=center 样式配套）", () => {
    const spec = chainSpec();
    (spec.nodes as Array<Record<string, unknown>>)[0]!.label = "Input\nFrames";
    const tex = compileDiagramTeX(spec);
    expect(tex).toContain("{Input\\\\Frames}");
  });

  it("注入安全：恶意 TeX 输入全部转义为无害文本", () => {
    const spec = chainSpec({ title: "\\write18{rm -rf}" });
    (spec.nodes as Array<Record<string, unknown>>)[0]!.label = "\\input{/etc/passwd}\n$_#%^&";
    (spec.edges as Array<Record<string, unknown>>)[0]!.label = "$x^2$ & 100%";
    const tex = compileDiagramTeX(spec);
    expect(tex).toContain(
      "{\\textbackslash{}input\\{/etc/passwd\\}\\\\\\$\\_\\#\\%\\textasciicircum{}\\&}",
    );
    expect(tex).toContain("node[midway, right=1mm, edge label] {\\$x\\textasciicircum{}2\\$ \\& 100\\%}");
    expect(tex).toContain("{\\textbackslash{}write18\\{rm -rf\\}}");
    // 输出中不存在未转义的原始 TeX 控制序列
    expect(tex).not.toMatch(/[^\\}]\\input\{/);
    expect(tex).not.toMatch(/[^\\}]\\write18\{/);
  });

  it("comparison：left/right 双列（60mm 列距）+ 跨列边", () => {
    const tex = compileDiagramTeX({
      layout: "horizontal",
      variant: "comparison",
      nodes: [
        { id: "a1", label: "MRG-DTM", role: "left" },
        { id: "b1", label: "IoU only", role: "left" },
        { id: "c1", label: "Proposed", role: "right" },
      ],
      edges: [
        { from: "a1", to: "b1" },
        { from: "b1", to: "c1", label: "+9.6 IDSW" },
      ],
    });
    expect(tex).toContain("\\node[leftbox] (a1) at (0mm,9mm) {MRG-DTM};");
    expect(tex).toContain("\\node[leftbox] (b1) at (0mm,-9mm) {IoU only};");
    expect(tex).toContain("\\node[rightbox] (c1) at (60mm,0mm) {Proposed};");
    expect(tex).toContain("\\draw[arr] (b1) -- (c1) node[midway, above=1mm, edge label] {+9.6 IDSW};");
  });

  it("comparison 纵向：两组上下排布", () => {
    const tex = compileDiagramTeX({
      layout: "vertical",
      variant: "comparison",
      nodes: [
        { id: "a1", label: "A1", role: "left" },
        { id: "a2", label: "A2", role: "left" },
        { id: "b1", label: "B1", role: "right" },
      ],
      edges: [{ from: "a2", to: "b1" }],
    });
    expect(tex).toContain("\\node[leftbox] (a1) at (-22.5mm,0mm) {A1};");
    expect(tex).toContain("\\node[leftbox] (a2) at (22.5mm,0mm) {A2};");
    expect(tex).toContain("\\node[rightbox] (b1) at (0mm,-60mm) {B1};");
  });

  it("确定性：同 spec 两次渲染字节级一致；拓扑等价但声明序不同的 spec 坐标相同、行序不同", () => {
    const first = compileDiagramTeX(chainSpec());
    expect(compileDiagramTeX(chainSpec())).toBe(first);

    const edges = [
      { from: "a", to: "b" },
      { from: "a", to: "c" },
      { from: "b", to: "d" },
      { from: "c", to: "d" },
    ];
    const declared = compileDiagramTeX({
      layout: "vertical",
      nodes: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
        { id: "d", label: "D" },
      ],
      edges,
    });
    const permuted = compileDiagramTeX({
      layout: "vertical",
      nodes: [
        { id: "c", label: "C" },
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "d", label: "D" },
      ],
      edges,
    });
    // 层内顺序由「声明序过滤」决定：两个 spec 的层 1 都是 [b, c] → 坐标一致
    expect(declared).toContain("\\node[stage] (b) at (-22.5mm,-18mm) {B};");
    expect(permuted).toContain("\\node[stage] (b) at (-22.5mm,-18mm) {B};");
    expect(permuted).toContain("\\node[stage] (c) at (22.5mm,-18mm) {C};");
    // 但节点行输出序 = 声明序 → 整文档不同（确定性规则：同 spec 字节一致；
    // 声明序是 spec 内容的一部分）
    expect(permuted).not.toBe(declared);
    expect(declared.indexOf("{A};")).toBeLessThan(declared.indexOf("{B};"));
    expect(permuted.indexOf("{C};")).toBeLessThan(permuted.indexOf("{A};"));
  });

  it("M12.2.5 CJK 探测：中文标签插入 ctex 导言；纯 ASCII 不插入", () => {
    const base = {
      variant: "pipeline",
      layout: "vertical",
      nodes: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      edges: [{ from: "a", to: "b" }],
    };
    const ascii = compileDiagramTeX(base);
    expect(ascii).not.toContain("ctex");

    const cjk = compileDiagramTeX({ ...base, nodes: [{ id: "a", label: "特征提取" }, { id: "b", label: "B" }] });
    expect(cjk).toContain("\\usepackage[UTF8]{ctex}");
    expect(cjk.indexOf("ctex}")).toBeGreaterThan(cjk.indexOf("standalone}"));
    expect(cjk.indexOf("ctex}")).toBeLessThan(cjk.indexOf("tikz}"));

    const cjkEdge = compileDiagramTeX({ ...base, edges: [{ from: "a", to: "b", label: "损失回传" }] });
    expect(cjkEdge).toContain("\\usepackage[UTF8]{ctex}");

    const cjkTitle = compileDiagramTeX({ ...base, title: "总体框架" });
    expect(cjkTitle).toContain("\\usepackage[UTF8]{ctex}");
  });
});
