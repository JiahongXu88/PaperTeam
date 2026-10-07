import { describe, expect, it } from "vitest";

import {
  computeDatasetHash,
  validateDiagramSpec,
  validatePlotSpec,
} from "../../src/figures/spec.js";

/**
 * C1 校验测试（zero LLM：全部确定性断言）。
 *
 * 覆盖：schema 层（结构/枚举/长度/字符白名单）与语义层（列引用/数值/缺失
 * 策略/datasetHash 一致性/DAG）双层拒绝路径 + 规范化默认值物化。
 */

const BASE_DATASET = {
  columns: ["x", "ours", "baseline"],
  rows: [
    [1, 3.5, 2.1],
    [2, 4.25, 2.8],
    [3, 5.5, 3.9],
  ],
};

function basePlotSpec(): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify({
      plotType: "line",
      data: {
        origin: { sourceId: "S001", blockId: "tbl-001" },
        datasetHash: computeDatasetHash(BASE_DATASET),
        x: ["x"],
        series: [
          { name: "Ours", column: "ours" },
          { name: "Baseline", column: "baseline" },
        ],
        inlineDataset: BASE_DATASET,
      },
      axis: {},
    }),
  );
}

describe("PlotSpec 校验", () => {
  it("合法 line spec：ok 且默认值物化（missingPolicy=reject / 多系列 legend=true / renderOptions 默认）", () => {
    const result = validatePlotSpec(basePlotSpec());
    expect(result.ok).toBe(true);
    expect(result.spec?.data.missingPolicy).toBe("reject");
    expect(result.spec?.axis.legend).toBe(true);
    expect(result.spec?.axis.renderOptions).toEqual({ widthCm: 12, heightCm: 8, markSizePt: 1.5 });
    expect(result.spec?.data.x).toEqual(["x"]);
  });

  it("单系列默认 legend=false；显式 legend=false 恒不显示", () => {
    const single = basePlotSpec();
    (single.data as Record<string, unknown>).series = [{ name: "Ours", column: "ours" }];
    expect(validatePlotSpec(single).spec?.axis.legend).toBe(false);

    const explicit = basePlotSpec();
    (explicit.axis as Record<string, unknown>).legend = false;
    expect(validatePlotSpec(explicit).spec?.axis.legend).toBe(false);
  });

  it("semantic 元数据通过（benchmark_comparison / ablation）且不触发新 renderer 语义", () => {
    const spec = basePlotSpec();
    spec.semantic = "benchmark_comparison";
    const result = validatePlotSpec(spec);
    expect(result.ok).toBe(true);
    expect(result.spec?.semantic).toBe("benchmark_comparison");
    expect(result.spec?.plotType).toBe("line");
  });

  it("manual origin 通过并如实保留 note", () => {
    const spec = basePlotSpec();
    (spec.data as Record<string, unknown>).origin = { origin: "manual", note: "手工录入消融数据" };
    const result = validatePlotSpec(spec);
    expect(result.ok).toBe(true);
    expect(result.spec?.data.origin).toEqual({ origin: "manual", note: "手工录入消融数据" });
  });

  it("未知 plotType 拒绝", () => {
    const spec = basePlotSpec();
    spec.plotType = "pie";
    const result = validatePlotSpec(spec);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("plotType");
  });

  it("data.x 引用不存在的列拒绝", () => {
    const spec = basePlotSpec();
    (spec.data as Record<string, unknown>).x = ["nope"];
    const result = validatePlotSpec(spec);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("nope");
  });

  it("series 引用不存在的列拒绝", () => {
    const spec = basePlotSpec();
    (spec.data as Record<string, unknown>).series = [{ name: "S", column: "ghost" }];
    const result = validatePlotSpec(spec);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("ghost");
  });

  it("series 空数组拒绝", () => {
    const spec = basePlotSpec();
    (spec.data as Record<string, unknown>).series = [];
    expect(validatePlotSpec(spec).ok).toBe(false);
  });

  it("数值列含 NaN 拒绝（schema 层 number 类型不含 NaN）", () => {
    const dataset = {
      columns: ["x", "y"],
      rows: [
        [1, 2],
        [2, Number.NaN],
      ],
    };
    const spec = basePlotSpec();
    (spec.data as Record<string, unknown>).inlineDataset = dataset;
    (spec.data as Record<string, unknown>).datasetHash = computeDatasetHash(dataset);
    (spec.data as Record<string, unknown>).series = [{ name: "Y", column: "y" }];
    const result = validatePlotSpec(spec);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/NaN|number/i);
  });

  it("数值列含 Infinity 拒绝", () => {
    const dataset = { columns: ["x", "y"], rows: [[1, Number.POSITIVE_INFINITY]] };
    const spec = basePlotSpec();
    (spec.data as Record<string, unknown>).inlineDataset = dataset;
    (spec.data as Record<string, unknown>).datasetHash = computeDatasetHash(dataset);
    (spec.data as Record<string, unknown>).series = [{ name: "Y", column: "y" }];
    expect(validatePlotSpec(spec).ok).toBe(false);
  });

  it("series 列含字符串拒绝", () => {
    const dataset = { columns: ["x", "y"], rows: [[1, "high"]] };
    const spec = basePlotSpec();
    (spec.data as Record<string, unknown>).inlineDataset = dataset;
    (spec.data as Record<string, unknown>).datasetHash = computeDatasetHash(dataset);
    (spec.data as Record<string, unknown>).series = [{ name: "Y", column: "y" }];
    const result = validatePlotSpec(spec);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("必须是数值");
  });

  it("line 的 x 为字符串拒绝；bar 的字符串 x 通过（类目轴）", () => {
    const dataset = { columns: ["x", "y"], rows: [["alpha", 1], ["beta", 2]] };
    const spec = basePlotSpec();
    (spec.data as Record<string, unknown>).inlineDataset = dataset;
    (spec.data as Record<string, unknown>).datasetHash = computeDatasetHash(dataset);
    (spec.data as Record<string, unknown>).series = [{ name: "Y", column: "y" }];

    spec.plotType = "line";
    expect(validatePlotSpec(spec).ok).toBe(false);

    spec.plotType = "bar";
    expect(validatePlotSpec(spec).ok).toBe(true);
  });

  it("缺失值默认 reject：错误信息含行号与策略指引", () => {
    const dataset = {
      columns: ["x", "y"],
      rows: [
        [1, 2],
        [2, null],
        [3, 4],
      ],
    };
    const spec = basePlotSpec();
    (spec.data as Record<string, unknown>).inlineDataset = dataset;
    (spec.data as Record<string, unknown>).datasetHash = computeDatasetHash(dataset);
    (spec.data as Record<string, unknown>).series = [{ name: "Y", column: "y" }];
    const result = validatePlotSpec(spec);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("第 1 行");
    expect(result.errors.join(" ")).toContain("skip_row");
  });

  it("缺失值显式 skip_row 通过（不静默填 0）", () => {
    const dataset = {
      columns: ["x", "y"],
      rows: [
        [1, 2],
        [2, null],
      ],
    };
    const spec = basePlotSpec();
    (spec.data as Record<string, unknown>).inlineDataset = dataset;
    (spec.data as Record<string, unknown>).datasetHash = computeDatasetHash(dataset);
    (spec.data as Record<string, unknown>).series = [{ name: "Y", column: "y" }];
    (spec.data as Record<string, unknown>).missingPolicy = "skip_row";
    const result = validatePlotSpec(spec);
    expect(result.ok).toBe(true);
    expect(result.spec?.data.missingPolicy).toBe("skip_row");
  });

  it("datasetHash 与 inlineDataset 不一致拒绝（数据变更必须显式重生成）", () => {
    const spec = basePlotSpec();
    (spec.data as Record<string, unknown>).datasetHash = "0".repeat(64);
    const result = validatePlotSpec(spec);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("datasetHash");
  });

  it("datasetHash 非 64 位 hex 拒绝", () => {
    const spec = basePlotSpec();
    (spec.data as Record<string, unknown>).datasetHash = "zz";
    expect(validatePlotSpec(spec).ok).toBe(false);
  });

  it("重复列名 / 重复 series 列 / 重复 series 名拒绝", () => {
    const dupColumns = { columns: ["x", "x"], rows: [[1, 2]] };
    const spec1 = basePlotSpec();
    (spec1.data as Record<string, unknown>).inlineDataset = dupColumns;
    (spec1.data as Record<string, unknown>).datasetHash = computeDatasetHash(dupColumns);
    (spec1.data as Record<string, unknown>).series = [{ name: "Y", column: "x" }];
    expect(validatePlotSpec(spec1).ok).toBe(false);

    const spec2 = basePlotSpec();
    (spec2.data as Record<string, unknown>).series = [
      { name: "A", column: "ours" },
      { name: "B", column: "ours" },
    ];
    const result2 = validatePlotSpec(spec2);
    expect(result2.ok).toBe(false);
    expect(result2.errors.join(" ")).toContain("重复引用列");

    const spec3 = basePlotSpec();
    (spec3.data as Record<string, unknown>).series = [
      { name: "Same", column: "ours" },
      { name: "Same", column: "baseline" },
    ];
    const result3 = validatePlotSpec(spec3);
    expect(result3.ok).toBe(false);
    expect(result3.errors.join(" ")).toContain("名称重复");
  });

  it("行宽与列数不一致拒绝", () => {
    const dataset = { columns: ["x", "y"], rows: [[1]] };
    const spec = basePlotSpec();
    (spec.data as Record<string, unknown>).inlineDataset = dataset;
    (spec.data as Record<string, unknown>).datasetHash = computeDatasetHash(dataset);
    (spec.data as Record<string, unknown>).series = [{ name: "Y", column: "y" }];
    const result = validatePlotSpec(spec);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("宽度");
  });

  it("data.x 多列拒绝（v1 仅支持单 x 列）", () => {
    const spec = basePlotSpec();
    (spec.data as Record<string, unknown>).x = ["x", "ours"];
    const result = validatePlotSpec(spec);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("1 个 x 列");
  });

  it("文本字段含控制字符拒绝（注入宽校验）", () => {
    const spec = basePlotSpec();
    spec.title = "bad" + String.fromCharCode(1) + "title";
    expect(validatePlotSpec(spec).ok).toBe(false);

    const spec2 = basePlotSpec();
    spec2.title = "line\nbreak";
    expect(validatePlotSpec(spec2).ok).toBe(false);
  });

  it("LaTeX 特殊字符在文本中允许（转义责任在 codegen）", () => {
    const spec = basePlotSpec();
    spec.title = "100% of $x^2$ & #4 {_~}\\input{/etc/passwd}";
    const result = validatePlotSpec(spec);
    expect(result.ok).toBe(true);
    expect(result.spec?.title).toBe("100% of $x^2$ & #4 {_~}\\input{/etc/passwd}");
  });

  it("规范化确定性：同 spec 两次校验产出深度相等；显式默认值与缺省同形", () => {
    const a = validatePlotSpec(basePlotSpec()).spec;
    const b = validatePlotSpec(basePlotSpec()).spec;
    expect(a).toEqual(b);

    const explicit = basePlotSpec();
    (explicit.data as Record<string, unknown>).missingPolicy = "reject";
    (explicit.axis as Record<string, unknown>).renderOptions = {
      widthCm: 12,
      heightCm: 8,
      markSizePt: 1.5,
    };
    expect(validatePlotSpec(explicit).spec).toEqual(a);
  });

  it("非对象输入拒绝且错误可读", () => {
    const result = validatePlotSpec("not a spec");
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ---- DiagramSpec ----

function baseDiagramSpec(): Record<string, unknown> {
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
  };
}

describe("DiagramSpec 校验", () => {
  it("合法 pipeline：variant 与 role 默认物化（pipeline / stage）", () => {
    const result = validateDiagramSpec(baseDiagramSpec());
    expect(result.ok).toBe(true);
    expect(result.spec?.variant).toBe("pipeline");
    expect(result.spec?.nodes.every((node) => node.role === "stage")).toBe(true);
    expect(result.spec?.groups).toEqual([]);
  });

  it("annotation 角色与 group 通过", () => {
    const spec = baseDiagramSpec();
    (spec.nodes as Array<Record<string, unknown>>).push({
      id: "note1",
      label: "Gated EMA",
      role: "annotation",
    });
    (spec.edges as Array<Record<string, unknown>>).push({ from: "note1", to: "decoder" });
    spec.groups = [{ id: "core", label: "Core" }];
    (spec.nodes as Array<Record<string, unknown>>)[1]!.group = "core";
    const result = validateDiagramSpec(spec);
    expect(result.ok).toBe(true);
    expect(result.spec?.nodes.find((node) => node.id === "note1")?.role).toBe("annotation");
  });

  it("节点 label 允许受控换行（多行文本白名单）", () => {
    const spec = baseDiagramSpec();
    (spec.nodes as Array<Record<string, unknown>>)[0]!.label = "Input\nFrames";
    expect(validateDiagramSpec(spec).ok).toBe(true);
  });

  it("节点 id 非安全 slug 拒绝（空格 / 非法字符 / 空）", () => {
    for (const badId of ["bad id", "a.b!", "节点", ""]) {
      const spec = baseDiagramSpec();
      (spec.nodes as Array<Record<string, unknown>>)[0]!.id = badId;
      expect(validateDiagramSpec(spec).ok).toBe(false);
    }
  });

  it("节点 id 重复拒绝", () => {
    const spec = baseDiagramSpec();
    (spec.nodes as Array<Record<string, unknown>>)[1]!.id = "input";
    const result = validateDiagramSpec(spec);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("重复");
  });

  it("edge 端点不存在 / 自环 / 重复边拒绝", () => {
    const spec1 = baseDiagramSpec();
    (spec1.edges as Array<Record<string, unknown>>)[0]!.from = "ghost";
    expect(validateDiagramSpec(spec1).ok).toBe(false);

    const spec2 = baseDiagramSpec();
    (spec2.edges as Array<Record<string, unknown>>)[0]!.to = "input";
    const result2 = validateDiagramSpec(spec2);
    expect(result2.ok).toBe(false);
    expect(result2.errors.join(" ")).toContain("自环");

    const spec3 = baseDiagramSpec();
    (spec3.edges as Array<Record<string, unknown>>).push({ from: "input", to: "encoder" });
    const result3 = validateDiagramSpec(spec3);
    expect(result3.ok).toBe(false);
    expect(result3.errors.join(" ")).toContain("重复");
  });

  it("环拒绝（DAG 纪律）", () => {
    const spec = baseDiagramSpec();
    (spec.edges as Array<Record<string, unknown>>).push({ from: "decoder", to: "input" });
    const result = validateDiagramSpec(spec);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("环");
  });

  it("pipeline 不允许 left/right 角色", () => {
    const spec = baseDiagramSpec();
    (spec.nodes as Array<Record<string, unknown>>)[0]!.role = "left";
    const result = validateDiagramSpec(spec);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("left/right");
  });

  it("annotation 无边拒绝（缺布局锚点）", () => {
    const spec = baseDiagramSpec();
    (spec.nodes as Array<Record<string, unknown>>).push({
      id: "lonely",
      label: "Lonely note",
      role: "annotation",
    });
    const result = validateDiagramSpec(spec);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("lonely");
  });

  it("annotation 之间互连拒绝", () => {
    const spec = baseDiagramSpec();
    (spec.nodes as Array<Record<string, unknown>>).push(
      { id: "n1", label: "Note 1", role: "annotation" },
      { id: "n2", label: "Note 2", role: "annotation" },
    );
    (spec.edges as Array<Record<string, unknown>>).push({ from: "n1", to: "n2" });
    const result = validateDiagramSpec(spec);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("annotation");
  });

  it("comparison：合法 left/right 通过；缺 role / stage 角色 / 单侧 拒绝", () => {
    const comparison = {
      layout: "horizontal",
      variant: "comparison",
      nodes: [
        { id: "a1", label: "MRG-DTM", role: "left" },
        { id: "a2", label: "IoU only", role: "left" },
        { id: "b1", label: "Proposed", role: "right" },
      ],
      edges: [
        { from: "a1", to: "a2" },
        { from: "a2", to: "b1" },
      ],
    };
    expect(validateDiagramSpec(comparison).ok).toBe(true);

    const noRole = JSON.parse(JSON.stringify(comparison));
    delete noRole.nodes[0].role;
    expect(validateDiagramSpec(noRole).ok).toBe(false);

    const stageRole = JSON.parse(JSON.stringify(comparison));
    stageRole.nodes[0].role = "stage";
    expect(validateDiagramSpec(stageRole).ok).toBe(false);

    const singleSide = JSON.parse(JSON.stringify(comparison));
    singleSide.nodes[2].role = "left";
    const result = validateDiagramSpec(singleSide);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("right");
  });

  it("group 引用未声明 / 空成员 拒绝", () => {
    const spec = baseDiagramSpec();
    (spec.nodes as Array<Record<string, unknown>>)[0]!.group = "undeclared";
    const result = validateDiagramSpec(spec);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("undeclared");

    const spec2 = baseDiagramSpec();
    spec2.groups = [{ id: "empty", label: "Empty" }];
    const result2 = validateDiagramSpec(spec2);
    expect(result2.ok).toBe(false);
    expect(result2.errors.join(" ")).toContain("empty");
  });

  it("节点 label 含换行外控制字符拒绝；超长拒绝", () => {
    const spec = baseDiagramSpec();
    (spec.nodes as Array<Record<string, unknown>>)[0]!.label = "bad" + String.fromCharCode(1) + "label";
    expect(validateDiagramSpec(spec).ok).toBe(false);

    const spec2 = baseDiagramSpec();
    (spec2.nodes as Array<Record<string, unknown>>)[0]!.label = "x".repeat(401);
    expect(validateDiagramSpec(spec2).ok).toBe(false);
  });

  it("规范化确定性：同 spec 两次深度相等；显式 variant=pipeline 与缺省同形", () => {
    const a = validateDiagramSpec(baseDiagramSpec()).spec;
    const b = validateDiagramSpec(baseDiagramSpec()).spec;
    expect(a).toEqual(b);

    const explicit = baseDiagramSpec();
    explicit.variant = "pipeline";
    (explicit.nodes as Array<Record<string, unknown>>).forEach((node) => {
      node.role = "stage";
    });
    expect(validateDiagramSpec(explicit).spec).toEqual(a);
  });
});
