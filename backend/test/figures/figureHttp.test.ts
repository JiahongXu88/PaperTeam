/**
 * M12 Batch 3 C4/C5 HTTP 集成测试：figures 产品 API 全链（scripted runtime +
 * fakeFigureRunner——离线可测「数据集 → spec 校验 → 编译 → 列表 → 受控插入」）。
 *
 * 覆盖：
 * - datasets 列表 / 单集载荷（parsed document 提取）；
 * - validate / generate（含来源锚反查防篡改）；
 * - list / get（assetPresent / insertedIn / stale）；
 * - insert append（outline 章节目标 + 引用句 + label 派生）；
 * - caption 守卫硬闸（violation 422 / unverified 需 confirmUnverified）；
 * - label 冲突 409 / 重复插入 409；
 * - replace（label 保持 + supersededBy lineage + graphicx 注入）；
 * - 修订安全边界（已有论文 append 403 / replace 放行）；
 * - 数据陈旧（来源重解析后 datasetHash 变化 → 插入 409）；
 * - inventory 重建（research/manuscript-visuals.json 的 generatedFiguresUsed）。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { startTestStack, scriptedIdeaRuntime, type TestStack } from "../helpers/testStack.js";
import type { ParsedDocument } from "../../src/ingestion/types.js";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
});

async function newStack(): Promise<TestStack> {
  const scripted = scriptedIdeaRuntime();
  return startTestStack(scripted.runtime, {
    registerCleanup: (cleanup) => cleanups.push(cleanup),
  });
}

/** 实验数据 fixture：3 行 × 3 列（epoch / loss / val_loss） */
function experimentDocument(sourceId: string, contentHash: string): ParsedDocument {
  const rows = [
    [["epoch", "1"], ["loss", "0.50"], ["val_loss", "0.62"]],
    [["epoch", "2"], ["loss", "0.30"], ["val_loss", "0.44"]],
    [["epoch", "3"], ["loss", "0.20"], ["val_loss", "0.38"]],
  ] as const;
  return {
    schemaVersion: 1,
    sourceId,
    fileName: "experiment.csv",
    storedFileName: `${sourceId}-experiment.csv`,
    kind: "tabular",
    mimeType: "text/csv",
    parser: { id: "fixture" },
    parseMode: "structured",
    status: "ok",
    blocks: rows.map((cells, index) => ({
      blockId: `B${String(index + 1).padStart(4, "0")}`,
      type: "structured_record" as const,
      cells: cells.map(([header, value]) => ({ header, value })),
      provenance: { fileName: `${sourceId}-experiment.csv`, row: index + 2 },
    })),
    counts: { text: 0, table: 0, figure: 0, formula: 0, structured_record: 3, code: 0, output: 0 },
    notes: [],
    contentHash,
    parsedAt: "2026-10-08T00:00:00Z",
  };
}

async function seedDatasetSource(stack: TestStack, projectId: string): Promise<{ sourceId: string; contentHash: string }> {
  const uploaded = await stack.request("POST", `/api/projects/${projectId}/sources`, {
    fileName: "experiment.csv",
    contentBase64: Buffer.from("epoch,loss,val_loss\n1,0.50,0.62\n2,0.30,0.44\n3,0.20,0.38\n", "utf8").toString("base64"),
    sourceRole: "evidence",
  });
  expect(uploaded.status).toBe(201);
  const source = uploaded.body["source"] as { sourceId: string; contentHash?: string };
  await stack.stack.ingestion.drainBackground();
  await stack.stack.parsedDocuments.save(projectId, experimentDocument(source.sourceId, source.contentHash ?? "hash"));
  return { sourceId: source.sourceId, contentHash: source.contentHash ?? "hash" };
}

/** 写一个「新论文」形态的手稿：outline + main.tex + sections（文档图连通） */
async function seedNewPaperManuscript(stack: TestStack, projectId: string): Promise<void> {
  const manuscriptDir = stack.stack.projects.manuscriptDir(projectId);
  await mkdir(join(manuscriptDir, "sections"), { recursive: true });
  await writeFile(
    join(manuscriptDir, "outline.json"),
    JSON.stringify({
      title: "Fixture Paper",
      sections: [
        { id: "intro", file: "intro.tex", title: "引言" },
        { id: "method", file: "method.tex", title: "方法" },
        { id: "results", file: "results.tex", title: "实验" },
      ],
    }),
    "utf8",
  );
  await writeFile(
    join(manuscriptDir, "main.tex"),
    [
      "\\documentclass[UTF8]{ctexart}",
      "\\usepackage{amsmath}",
      "\\begin{document}",
      "\\input{sections/intro}",
      "\\input{sections/method}",
      "\\input{sections/results}",
      "\\end{document}",
      "",
    ].join("\n"),
    "utf8",
  );
  for (const [file, text] of [
    ["intro.tex", "\\section{引言}\n本文研究图表插入。\n"],
    ["method.tex", "\\section{方法}\n方法细节如 \\ref{fig:placeholder} 待插入。\n"],
    ["results.tex", "\\section{实验}\n实验结果如下。\n"],
  ] as const) {
    await writeFile(join(manuscriptDir, "sections", file), text, "utf8");
  }
}

async function createProject(stack: TestStack, workflowKind: string): Promise<string> {
  const created = await stack.request("POST", "/api/projects", {
    title: "图表 API 测试",
    researchIdea: "idea",
    workflowKind,
  });
  expect(created.status).toBe(201);
  return (created.body["project"] as { id: string }).id;
}

/** 从 datasets 端点取真实 datasetHash / 列，拼一个合法 plot spec */
async function buildPlotSpec(
  stack: TestStack,
  projectId: string,
  sourceId: string,
  blockId: string,
  overrides: { caption?: string; rows?: (number | string | null)[][] } = {},
): Promise<Record<string, unknown>> {
  const payload = await stack.request(
    "GET",
    `/api/projects/${projectId}/figures/datasets/${encodeURIComponent(sourceId)}/${encodeURIComponent(blockId)}`,
  );
  expect(payload.status).toBe(200);
  const dataset = payload.body["dataset"] as {
    columns: string[];
    datasetHash: string;
    inlineDataset: { columns: string[]; rows: (number | string | null)[][] };
  };
  // 需要重算 hash 时（篡改行）用同源函数口径——这里直接用 spec 校验器一致性
  return {
    plotType: "line",
    ...(overrides.caption !== undefined ? { caption: overrides.caption } : {}),
    data: {
      origin: { sourceId, blockId },
      datasetHash: dataset.datasetHash,
      x: [dataset.columns[0]!],
      series: dataset.columns.slice(1).map((column) => ({ name: column, column })),
      inlineDataset:
        overrides.rows !== undefined
          ? { columns: dataset.columns, rows: overrides.rows }
          : dataset.inlineDataset,
    },
    axis: { xLabel: "epoch", yLabel: "loss" },
  };
}

describe("figures datasets / validate / generate", () => {
  it("datasets 列表 + 单集载荷：structured_record 游程 → 候选（列/行/hash）", async () => {
    const stack = await newStack();
    const projectId = await createProject(stack, "idea_to_paper");
    const { sourceId } = await seedDatasetSource(stack, projectId);

    const list = await stack.request("GET", `/api/projects/${projectId}/figures/datasets`);
    expect(list.status).toBe(200);
    const datasets = list.body["datasets"] as Array<{ sourceId: string; blockId: string; columns: string[]; rowCount: number; kind: string; sourceRole: string }>;
    expect(datasets.length).toBe(1);
    expect(datasets[0]!.sourceId).toBe(sourceId);
    expect(datasets[0]!.blockId).toBe("B0001-B0003");
    expect(datasets[0]!.columns).toEqual(["epoch", "loss", "val_loss"]);
    expect(datasets[0]!.rowCount).toBe(3);
    expect(datasets[0]!.kind).toBe("records");
    expect(datasets[0]!.sourceRole).toBe("evidence");

    const missing = await stack.request("GET", `/api/projects/${projectId}/figures/datasets/${sourceId}/B9999`);
    expect(missing.status).toBe(400);
  });

  it("validate：非法 spec（x 列不存在）→ errors；合法 spec + 编造 caption → captionValidation=violation（advisory 不阻断）", async () => {
    const stack = await newStack();
    const projectId = await createProject(stack, "idea_to_paper");
    const { sourceId } = await seedDatasetSource(stack, projectId);

    const invalid = await stack.request("POST", `/api/projects/${projectId}/figures/validate`, {
      kind: "plot",
      spec: await buildPlotSpec(stack, projectId, sourceId, "B0001-B0003", { caption: "c" }).then((spec) => ({
        ...spec,
        data: { ...(spec.data as Record<string, unknown>), x: ["nope"] },
      })),
    });
    expect(invalid.status).toBe(200);
    const invalidResult = (invalid.body["result"] as { ok: boolean; errors: string[] });
    expect(invalidResult.ok).toBe(false);
    expect(invalidResult.errors.some((error) => error.includes("nope"))).toBe(true);

    const fabricated = await stack.request("POST", `/api/projects/${projectId}/figures/validate`, {
      kind: "plot",
      spec: await buildPlotSpec(stack, projectId, sourceId, "B0001-B0003", { caption: "loss 从 0.50 下降了 0.9（编造）" }),
    });
    expect(fabricated.status).toBe(200);
    const fabricatedResult = fabricated.body["result"] as { ok: boolean; captionValidation?: { verdict: string } };
    expect(fabricatedResult.ok).toBe(true);
    expect(fabricatedResult.captionValidation?.verdict).toBe("violation");
  });

  it("generate：合法 → record（fake 编译出 %PDF）+ captionValidation 附带；篡改 inlineDataset（hash 不匹配）→ 422", async () => {
    const stack = await newStack();
    const projectId = await createProject(stack, "idea_to_paper");
    const { sourceId } = await seedDatasetSource(stack, projectId);

    const ok = await stack.request("POST", `/api/projects/${projectId}/figures/generate`, {
      kind: "plot",
      spec: await buildPlotSpec(stack, projectId, sourceId, "B0001-B0003", { caption: "训练 loss 随 epoch 收敛（0.50 → 0.20）。" }),
    });
    expect(ok.status).toBe(200);
    const figure = ok.body["figure"] as {
      record: { figId: string; caption: string; dataOrigin: { sourceId: string } };
      cached: boolean;
      captionValidation?: { verdict: string };
    };
    expect(figure.record.figId).toMatch(/^fig-[0-9a-f]{12,}$/);
    expect(figure.record.dataOrigin.sourceId).toBe(sourceId);
    expect(figure.cached).toBe(false);
    expect(figure.captionValidation?.verdict).toBe("pass");

    // PDF 资产路由（manifest 登记 + fake %PDF）
    const pdf = await fetch(`http://127.0.0.1:${stack.port()}/api/projects/${projectId}/figures/generated/${figure.record.figId}.pdf`);
    expect(pdf.status).toBe(200);
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString("latin1")).toBe("%PDF-");

    // 篡改：行内容变化但沿用原 datasetHash → spec 校验拒绝
    const tampered = await buildPlotSpec(stack, projectId, sourceId, "B0001-B0003");
    (tampered.data as { inlineDataset: { rows: (number | string | null)[][] } }).inlineDataset.rows[0]![1] = 0.05;
    const tamperedResponse = await stack.request("POST", `/api/projects/${projectId}/figures/generate`, {
      kind: "plot",
      spec: tampered,
    });
    expect(tamperedResponse.status).toBe(422);
    expect((tamperedResponse.body["error"] as { code: string }).code).toBe("FIGURE_SPEC_INVALID");

    // 篡改进阶：重算 hash 绕过自洽校验，但与来源数据不一致 → 来源锚反查拒绝
    const { computeDatasetHash } = await import("../../src/figures/spec.js");
    const mismatch = await buildPlotSpec(stack, projectId, sourceId, "B0001-B0003");
    const data = mismatch.data as {
      datasetHash: string;
      inlineDataset: { columns: string[]; rows: (number | string | null)[][] };
    };
    data.inlineDataset.rows[0]![1] = 0.05;
    data.datasetHash = computeDatasetHash(data.inlineDataset);
    const mismatchResponse = await stack.request("POST", `/api/projects/${projectId}/figures/generate`, {
      kind: "plot",
      spec: mismatch,
    });
    expect(mismatchResponse.status).toBe(409);
    expect((mismatchResponse.body["error"] as { code: string }).code).toBe("FIGURE_DATASET_STALE");
  });

  it("diagram generate：合法 DAG → record；不存在的 source 锚 → 拒绝", async () => {
    const stack = await newStack();
    const projectId = await createProject(stack, "idea_to_paper");
    const diagram = await stack.request("POST", `/api/projects/${projectId}/figures/generate`, {
      kind: "diagram",
      spec: {
        layout: "vertical",
        title: "Pipeline",
        nodes: [
          { id: "a", label: "输入" },
          { id: "b", label: "检测" },
          { id: "c", label: "跟踪" },
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "c" },
        ],
      },
    });
    expect(diagram.status).toBe(200);
    expect(((diagram.body["figure"] as { record: { kind: string } }).record.kind)).toBe("diagram");

    const { computeDatasetHash } = await import("../../src/figures/spec.js");
    const plotFromMissingSource = await stack.request("POST", `/api/projects/${projectId}/figures/generate`, {
      kind: "plot",
      spec: {
        plotType: "line",
        data: {
          origin: { sourceId: "S99", blockId: "B0001-B0003" },
          datasetHash: computeDatasetHash({ columns: ["x", "y"], rows: [[1, 2]] }),
          x: ["x"],
          series: [{ name: "y", column: "y" }],
          inlineDataset: { columns: ["x", "y"], rows: [[1, 2]] },
        },
        axis: {},
      },
    });
    expect(plotFromMissingSource.status).toBe(409);
    expect((plotFromMissingSource.body["error"] as { code: string }).code).toBe("FIGURE_SOURCE_MISSING");
  });
});

describe("figures insert（C5 受控插入）", () => {
  async function prepareFigure(
    stack: TestStack,
    options: { caption?: string } = {},
  ): Promise<{ projectId: string; figId: string }> {
    const projectId = await createProject(stack, "idea_to_paper");
    await seedDatasetSource(stack, projectId);
    await seedNewPaperManuscript(stack, projectId);
    const generated = await stack.request("POST", `/api/projects/${projectId}/figures/generate`, {
      kind: "plot",
      spec: await buildPlotSpec(stack, projectId, ...(await datasetAnchorOf(stack, projectId)), { caption: options.caption ?? "训练 loss 随 epoch 收敛（0.50 → 0.20）。" }),
    });
    expect(generated.status).toBe(200);
    return { projectId, figId: (generated.body["figure"] as { record: { figId: string } }).record.figId };
  }

  async function datasetAnchorOf(stack: TestStack, projectId: string): Promise<[string, string]> {
    const list = await stack.request("GET", `/api/projects/${projectId}/figures/datasets`);
    const dataset = (list.body["datasets"] as Array<{ sourceId: string; blockId: string }>)[0]!;
    return [dataset.sourceId, dataset.blockId];
  }

  it("append：outline 章节目标 + 引用句 + label 派生 + inventory 重建 + graphicx 注入", async () => {
    const stack = await newStack();
    const { projectId, figId } = await prepareFigure(stack);
    const insert = await stack.request("POST", `/api/projects/${projectId}/figures/insert`, {
      figId,
      mode: "append",
      sectionId: "results",
      caption: "训练 loss 随 epoch 收敛（0.50 → 0.20）。",
      label: "convergence",
      referenceSentence: "训练收敛过程如 \\ref{fig:convergence} 所示。",
    });
    expect(insert.status).toBe(200);
    const insertion = insert.body["insertion"] as {
      file: string;
      label: string;
      graphicxInjected: boolean;
      environment: string;
    };
    expect(insertion.file).toBe("sections/results.tex");
    expect(insertion.label).toBe("fig:convergence");
    expect(insertion.graphicxInjected).toBe(true);
    expect(insertion.environment).toContain(`figs/generated/${figId}.pdf`);

    // 文件事实：环境 + 引用句在盘
    const section = await readFile(
      join(stack.stack.projects.manuscriptDir(projectId), "sections", "results.tex"),
      "utf8",
    );
    expect(section).toContain(`\\includegraphics[width=0.85\\textwidth]{figs/generated/${figId}.pdf}`);
    expect(section).toContain(`\\ref{${insertion.label}}`);
    // main.tex 注入了 graphicx
    const main = await readFile(join(stack.stack.projects.manuscriptDir(projectId), "main.tex"), "utf8");
    expect(main).toContain("\\usepackage{graphicx}");
    // inventory 重建：generatedFiguresUsed 含新资产
    const inventory = JSON.parse(
      await readFile(join(stack.stack.projects.researchDir(projectId), "manuscript-visuals.json"), "utf8"),
    ) as { generatedFiguresUsed: string[] };
    expect(inventory.generatedFiguresUsed).toContain(`figs/generated/${figId}.pdf`);
    // 重复插入 → 409
    const duplicate = await stack.request("POST", `/api/projects/${projectId}/figures/insert`, {
      figId,
      mode: "append",
      sectionId: "method",
      caption: "训练 loss 随 epoch 收敛（0.50 → 0.20）。",
    });
    expect(duplicate.status).toBe(409);
    expect((duplicate.body["error"] as { code: string }).code).toBe("FIGURE_ALREADY_INSERTED");
  });

  it("caption 守卫硬闸：violation → 422；unverified → 422，confirmUnverified 后放行", async () => {
    const stack = await newStack();
    const { projectId, figId } = await prepareFigure(stack);
    const violation = await stack.request("POST", `/api/projects/${projectId}/figures/insert`, {
      figId,
      mode: "append",
      sectionId: "results",
      caption: "loss 下降了 0.9。", // 数据差值 0.3/0.2/0.24——0.9 无支撑
    });
    expect(violation.status).toBe(422);
    expect((violation.body["error"] as { code: string }).code).toBe("FIGURE_CAPTION_UNSUPPORTED");

    const unverified = await stack.request("POST", `/api/projects/${projectId}/figures/insert`, {
      figId,
      mode: "append",
      sectionId: "results",
      caption: "loss 在所有设置下都单调下降 0.3。", // 全称量词 → unverified
    });
    expect(unverified.status).toBe(422);
    expect((unverified.body["error"] as { code: string }).code).toBe("FIGURE_CAPTION_UNVERIFIED");

    const confirmed = await stack.request("POST", `/api/projects/${projectId}/figures/insert`, {
      figId,
      mode: "append",
      sectionId: "results",
      caption: "loss 在所有设置下都单调下降 0.3。",
      confirmUnverified: true,
    });
    expect(confirmed.status).toBe(200);
    expect((confirmed.body["insertion"] as { authorConfirmedUnverified: boolean }).authorConfirmedUnverified).toBe(true);
  });

  it("显式 label 冲突 → 409；未登记 figId → 404；空 caption → 400", async () => {
    const stack = await newStack();
    const { projectId, figId } = await prepareFigure(stack);
    const first = await stack.request("POST", `/api/projects/${projectId}/figures/insert`, {
      figId,
      mode: "append",
      sectionId: "results",
      caption: "训练 loss 随 epoch 收敛（0.50 → 0.20）。",
      label: "convergence",
    });
    expect(first.status).toBe(200);
    expect((first.body["insertion"] as { label: string }).label).toBe("fig:convergence");

    // 同 label 再插一张（用 diagram 图）→ 冲突
    const diagram = await stack.request("POST", `/api/projects/${projectId}/figures/generate`, {
      kind: "diagram",
      spec: { layout: "horizontal", nodes: [{ id: "a", label: "x" }], edges: [] },
    });
    const diagramFigId = (diagram.body["figure"] as { record: { figId: string } }).record.figId;
    const conflict = await stack.request("POST", `/api/projects/${projectId}/figures/insert`, {
      figId: diagramFigId,
      mode: "append",
      sectionId: "method",
      caption: "方法结构图。",
      label: "convergence",
    });
    expect(conflict.status).toBe(409);
    expect((conflict.body["error"] as { code: string }).code).toBe("FIGURE_LABEL_CONFLICT");

    const missing = await stack.request("POST", `/api/projects/${projectId}/figures/insert`, {
      figId: "fig-000000000000",
      mode: "append",
      sectionId: "results",
      caption: "c",
    });
    expect(missing.status).toBe(404);

    // 无题注的图（titleless diagram → record.caption 空）且请求不带 caption → 400
    const titleless = await stack.request("POST", `/api/projects/${projectId}/figures/generate`, {
      kind: "diagram",
      spec: { layout: "vertical", nodes: [{ id: "solo", label: "独节点" }], edges: [] },
    });
    const titlelessFigId = (titleless.body["figure"] as { record: { figId: string; caption: string } }).record.figId;
    const empty = await stack.request("POST", `/api/projects/${projectId}/figures/insert`, {
      figId: titlelessFigId,
      mode: "append",
      sectionId: "method",
    });
    expect(empty.status).toBe(400);
  });

  it("replace：新图替换既有 label（label 保持 / 旧 record supersededBy / 区间外不动）", async () => {
    const stack = await newStack();
    const { projectId, figId } = await prepareFigure(stack);
    const first = await stack.request("POST", `/api/projects/${projectId}/figures/insert`, {
      figId,
      mode: "append",
      sectionId: "results",
      caption: "训练 loss 随 epoch 收敛（0.50 → 0.20）。",
      label: "convergence",
    });
    expect(first.status).toBe(200);

    // 生成第二张（不同数据 → 不同 figId）
    const second = await stack.request("POST", `/api/projects/${projectId}/figures/generate`, {
      kind: "diagram",
      spec: {
        layout: "vertical",
        nodes: [
          { id: "i", label: "输入" },
          { id: "o", label: "输出" },
        ],
        edges: [{ from: "i", to: "o" }],
      },
    });
    const secondFigId = (second.body["figure"] as { record: { figId: string } }).record.figId;

    const replace = await stack.request("POST", `/api/projects/${projectId}/figures/insert`, {
      figId: secondFigId,
      mode: "replace",
      file: "sections/results.tex",
      replaceLabel: "fig:convergence",
      caption: "系统结构（替换图）。",
    });
    expect(replace.status).toBe(200);
    const insertion = replace.body["insertion"] as { label: string; previousPath?: string };
    expect(insertion.label).toBe("fig:convergence"); // label 保持 → 正文 \ref 不动
    expect(insertion.previousPath).toBe(`figs/generated/${figId}.pdf`);

    const section = await readFile(
      join(stack.stack.projects.manuscriptDir(projectId), "sections", "results.tex"),
      "utf8",
    );
    expect(section).toContain(`figs/generated/${secondFigId}.pdf`);
    expect(section).not.toContain(`figs/generated/${figId}.pdf`);
    expect(section).toContain("实验结果如下。"); // 环境外文字不动

    // manifest lineage：旧 record 被标记 supersededBy、新 record insertedIn
    const list = await stack.request("GET", `/api/projects/${projectId}/figures`);
    const figures = list.body["figures"] as Array<{ figId: string; supersededBy?: string; insertedIn?: { label: string } }>;
    const old = figures.find((entry) => entry.figId === figId);
    const updated = figures.find((entry) => entry.figId === secondFigId);
    expect(old?.supersededBy).toBe(secondFigId);
    expect(old?.insertedIn).toBeUndefined();
    expect(updated?.insertedIn?.label).toBe("fig:convergence");

    // 幂等替换（同 figId 同 label）→ 200 直接返回
    const idempotent = await stack.request("POST", `/api/projects/${projectId}/figures/insert`, {
      figId: secondFigId,
      mode: "replace",
      file: "sections/results.tex",
      replaceLabel: "fig:convergence",
      caption: "系统结构（替换图）。",
    });
    expect(idempotent.status).toBe(200);

    // 被替换的历史资产 → 再插入被拒
    const staleInsert = await stack.request("POST", `/api/projects/${projectId}/figures/insert`, {
      figId,
      mode: "append",
      sectionId: "method",
      caption: "旧图。",
    });
    expect(staleInsert.status).toBe(409);
  });

  it("修订安全边界：已有论文项目 append → 403；replace（既有作者图）→ 放行", async () => {
    const stack = await newStack();
    const projectId = await createProject(stack, "existing_paper_improvement");
    await seedDatasetSource(stack, projectId);
    // 已有论文形态：作者自己的 main.tex（含一张老图）
    const manuscriptDir = stack.stack.projects.manuscriptDir(projectId);
    await mkdir(join(manuscriptDir, "sections"), { recursive: true });
    await writeFile(
      join(manuscriptDir, "main.tex"),
      [
        "\\documentclass[UTF8]{ctexart}",
        "\\usepackage{graphicx}",
        "\\begin{document}",
        "\\input{sections/results}",
        "\\end{document}",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(manuscriptDir, "sections", "results.tex"),
      [
        "\\section{实验}",
        "\\begin{figure}[htbp]",
        "  \\centering",
        "  \\includegraphics[width=0.8\\textwidth]{figures/author-plot.pdf}",
        "  \\caption{Author plot.}",
        "  \\label{fig:author-results}",
        "\\end{figure}",
        "结果如 \\ref{fig:author-results} 所示。",
        "",
      ].join("\n"),
      "utf8",
    );

    const generated = await stack.request("POST", `/api/projects/${projectId}/figures/generate`, {
      kind: "plot",
      spec: await buildPlotSpec(stack, projectId, ...(await (async () => {
        const list = await stack.request("GET", `/api/projects/${projectId}/figures/datasets`);
        const dataset = (list.body["datasets"] as Array<{ sourceId: string; blockId: string }>)[0]!;
        return [dataset.sourceId, dataset.blockId] as [string, string];
      })()), { caption: "训练 loss 随 epoch 收敛（0.50 → 0.20）。" }),
    });
    const figId = (generated.body["figure"] as { record: { figId: string } }).record.figId;

    // append 被修订安全边界拒绝
    const append = await stack.request("POST", `/api/projects/${projectId}/figures/insert`, {
      figId,
      mode: "append",
      file: "sections/results.tex",
      caption: "训练 loss 随 epoch 收敛（0.50 → 0.20）。",
    });
    expect(append.status).toBe(403);
    expect((append.body["error"] as { code: string }).code).toBe("FIGURE_SCOPE_VIOLATION");

    // replace（作者既有图的受控替换）放行：label 保持、位置不动
    const replace = await stack.request("POST", `/api/projects/${projectId}/figures/insert`, {
      figId,
      mode: "replace",
      file: "sections/results.tex",
      replaceLabel: "fig:author-results",
      caption: "训练 loss 随 epoch 收敛（0.50 → 0.20）。",
    });
    expect(replace.status).toBe(200);
    const section = await readFile(join(manuscriptDir, "sections", "results.tex"), "utf8");
    expect(section).toContain(`figs/generated/${figId}.pdf`);
    expect(section).toContain("\\label{fig:author-results}");
    expect(section).toContain("结果如 \\ref{fig:author-results} 所示。");
    // graphicx 已存在 → 不重复注入
    expect(section.match(/usepackage/g)).toBeNull();
    const main = await readFile(join(manuscriptDir, "main.tex"), "utf8");
    expect(main.match(/\\usepackage\{graphicx\}/g)?.length).toBe(1);
  });

  it("数据陈旧：来源重解析后 datasetHash 变化 → list 标 stale + insert 409", async () => {
    const stack = await newStack();
    const projectId = await createProject(stack, "idea_to_paper");
    const { sourceId, contentHash } = await seedDatasetSource(stack, projectId);
    await seedNewPaperManuscript(stack, projectId);
    const generated = await stack.request("POST", `/api/projects/${projectId}/figures/generate`, {
      kind: "plot",
      spec: await buildPlotSpec(stack, projectId, sourceId, "B0001-B0003", { caption: "训练 loss 随 epoch 收敛（0.50 → 0.20）。" }),
    });
    const figId = (generated.body["figure"] as { record: { figId: string } }).record.figId;

    // 来源数据变化（重解析：第 3 行 loss 0.2 → 0.15）后重新保存 parsed doc
    const changed = experimentDocument(sourceId, contentHash);
    const thirdBlock = changed.blocks[2] as { cells: Array<{ value: string }> };
    thirdBlock.cells[1]!.value = "0.15";
    await stack.stack.parsedDocuments.save(projectId, changed);

    const list = await stack.request("GET", `/api/projects/${projectId}/figures`);
    const view = (list.body["figures"] as Array<{ figId: string; stale?: { reason: string } }>).find((entry) => entry.figId === figId);
    expect(view?.stale?.reason).toBe("dataset_changed");

    const insert = await stack.request("POST", `/api/projects/${projectId}/figures/insert`, {
      figId,
      mode: "append",
      sectionId: "results",
      caption: "训练 loss 随 epoch 收敛（0.50 → 0.20）。",
    });
    expect(insert.status).toBe(409);
    expect((insert.body["error"] as { code: string }).code).toBe("FIGURE_DATASET_STALE");
  });
});
