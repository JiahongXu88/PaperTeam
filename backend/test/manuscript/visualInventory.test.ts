/**
 * M12 Batch 1 · B1 Manuscript Visual Inventory 测试（确定性、无 LLM、无网络）。
 *
 * 覆盖任务书 §7 明确清单：caption before/after label、figure*、table*、
 * 同 label 多处 \ref（重复引用计数）、missing label、missing caption、
 * 相对路径 includegraphics、跨文件 \ref、unresolved ref、linkedSection
 * 归属、同输入两次构建 byte 级一致、CRLF/LF 等价；外加 placement、
 * 表格行列与网格、无 tabular 表、manuscriptRevision 透传、持久化
 * roundtrip / ENOENT / 损坏 fail-closed。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { BusinessError } from "../../src/errors.js";
import {
  buildVisualInventory,
  loadVisualInventory,
  persistVisualInventory,
  visualInventoryPath,
  type VisualInventoryTexFile,
} from "../../src/manuscript/visualInventory.js";

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function newProjectStore(): Promise<ProjectStore> {
  const root = await mkdtemp(join(tmpdir(), "visual-inv-"));
  tempRoots.push(root);
  return new ProjectStore({ root });
}

// ---- 内联 LaTeX 夹具（多文件数组；行号断言按此处字面行计）----

const MAIN_TEX = [
  "\\documentclass{article}",
  "\\section{Introduction}",
  "As shown in Figure~\\ref{fig:arch} and Table~\\ref{tab:mota}.",
  "It is shown again in \\ref{fig:arch}.",
  "\\begin{figure}[htbp]",
  "  \\centering",
  "  \\includegraphics[width=0.8\\linewidth]{figs\\overview.pdf}",
  "  \\caption{系统总体架构。}",
  "  \\label{fig:arch}",
  "\\end{figure}",
  "\\begin{table}[ht]",
  "  \\caption{跟踪结果。}\\label{tab:mota}",
  "  \\begin{tabular}{lcc}",
  "    \\hline",
  "    Method & MOTA & IDF1 \\\\",
  "    Ours & 82.4 & 79.1 \\\\",
  "    Base & 78.2 & 75.0 \\\\",
  "    \\hline",
  "  \\end{tabular}",
  "\\end{table}",
  "\\subsection{Ablation}",
  "\\begin{figure*}[t]",
  "  \\includegraphics{../assets/wide.png}",
  "  \\caption{Wide figure.}",
  "  \\label{fig:wide}",
  "\\end{figure*}",
  "\\begin{table*}",
  "  \\begin{tabular}{ll}",
  "    A & B \\\\",
  "    1 & 2 \\\\",
  "  \\end{tabular}",
  "\\end{table*}",
  "",
].join("\n");

const EXPERIMENTS_TEX = [
  "\\section{Experiments}",
  "\\begin{figure}",
  "  \\label{fig:nocaption-before}",
  "  \\includegraphics{figs/generated/fig-abc123.pdf}",
  "\\end{figure}",
  "\\begin{figure}",
  "  \\centering",
  "  \\label{fig:caption-after}",
  "  \\caption{Caption placed after label.}",
  "  \\includegraphics{figs/ratio.pdf}",
  "\\end{figure}",
  "See \\cref{fig:wide,fig:nocaption-before} and \\ref{fig:ghost} and \\autoref{tab:mota}.",
  "Repeated: \\ref{fig:arch} \\ref{fig:arch}.",
  "\\begin{table}",
  "  \\caption{No tabular here.}",
  "\\end{table}",
  "",
].join("\n");

const FILES: VisualInventoryTexFile[] = [
  { file: "main.tex", content: MAIN_TEX },
  { file: "sections/experiments.tex", content: EXPERIMENTS_TEX },
];

const inventory = buildVisualInventory(FILES);

describe("M12 B1 buildVisualInventory：环境解析", () => {
  it("文件清单保留全部输入文件（含无环境文件）", () => {
    expect(inventory.files.map((entry) => entry.file)).toEqual([
      "main.tex",
      "sections/experiments.tex",
    ]);
  });

  it("figure：caption before label + placement + includegraphics 归一 + 行号 + linkedSection", () => {
    const figure = inventory.files[0]!.figures[0]!;
    expect(figure).toMatchObject({
      envIndex: 1,
      environment: "figure",
      label: "fig:arch",
      caption: "系统总体架构。",
      includegraphicsPath: "figs/overview.pdf", // 反斜杠归一为 /
      placement: "htbp",
      lineStart: 5,
      lineEnd: 10,
      linkedSection: "Introduction",
    });
  });

  it("figure*：双栏环境与相对路径 ../ 保留原文", () => {
    const figure = inventory.files[0]!.figures[1]!;
    expect(figure).toMatchObject({
      envIndex: 2,
      environment: "figure*",
      label: "fig:wide",
      caption: "Wide figure.",
      includegraphicsPath: "../assets/wide.png",
      placement: "t",
      lineStart: 22,
      lineEnd: 26,
      linkedSection: "Ablation", // 最近 \subsection，非 \section
    });
  });

  it("caption after label 顺序同样命中；missing caption 如实缺省并登记", () => {
    const afterLabel = inventory.files[1]!.figures[1]!;
    expect(afterLabel).toMatchObject({
      label: "fig:caption-after",
      caption: "Caption placed after label.",
      includegraphicsPath: "figs/ratio.pdf",
      lineStart: 6,
      lineEnd: 11,
    });
    const noCaption = inventory.files[1]!.figures[0]!;
    expect(noCaption.caption).toBeUndefined();
    expect(noCaption.label).toBe("fig:nocaption-before");
    expect(inventory.captionMissing).toContain("sections/experiments.tex#figure-1");
  });

  it("table / table*：caption、行列与网格（cleanCell 同款清洗）", () => {
    const table = inventory.files[0]!.tables[0]!;
    expect(table).toMatchObject({
      envIndex: 1,
      environment: "table",
      label: "tab:mota",
      caption: "跟踪结果。",
      rowCount: 3,
      columnCount: 3,
      lineStart: 11,
      lineEnd: 20,
      linkedSection: "Introduction",
      hasTabular: true,
    });
    expect(table.headers).toEqual(["Method", "MOTA", "IDF1"]);
    expect(table.rows).toEqual([
      ["Ours", "82.4", "79.1"],
      ["Base", "78.2", "75.0"],
    ]);

    const starTable = inventory.files[0]!.tables[1]!;
    expect(starTable).toMatchObject({
      envIndex: 2,
      environment: "table*",
      rowCount: 2,
      columnCount: 2,
      linkedSection: "Ablation",
      hasTabular: true,
    });
    expect(starTable.headers).toEqual(["A", "B"]);
    expect(starTable.rows).toEqual([["1", "2"]]);
    // 无 label（missing label）→ 字段缺省，不伪造
    expect(starTable.label).toBeUndefined();
  });

  it("无 tabular 的 table：hasTabular=false、行列 0、caption 不算缺失", () => {
    const table = inventory.files[1]!.tables[0]!;
    expect(table).toMatchObject({
      environment: "table",
      caption: "No tabular here.",
      hasTabular: false,
      rowCount: 0,
      columnCount: 0,
      lineStart: 14,
      lineEnd: 16,
    });
    expect(table.headers).toBeUndefined();
    expect(table.rows).toBeUndefined();
  });

  it("captionMissing 汇总（main.tex table-2 无 caption）", () => {
    expect(inventory.captionMissing).toEqual([
      "main.tex#table-2",
      "sections/experiments.tex#figure-1",
    ]);
  });
});

describe("M12 B1 buildVisualInventory：引用域", () => {
  it("references：位置清单 + 同 label 多处引用与同行重复计数", () => {
    expect(inventory.references).toEqual([
      { label: "fig:arch", file: "main.tex", line: 3, count: 1 },
      { label: "tab:mota", file: "main.tex", line: 3, count: 1 },
      { label: "fig:arch", file: "main.tex", line: 4, count: 1 },
      // \cref 逗号多 key 拆分 + \autoref / \ref 均纳入
      { label: "fig:wide", file: "sections/experiments.tex", line: 12, count: 1 },
      { label: "fig:nocaption-before", file: "sections/experiments.tex", line: 12, count: 1 },
      { label: "fig:ghost", file: "sections/experiments.tex", line: 12, count: 1 },
      { label: "tab:mota", file: "sections/experiments.tex", line: 12, count: 1 }, // 跨文件 \ref
      { label: "fig:arch", file: "sections/experiments.tex", line: 13, count: 2 }, // 同行两次
    ]);
  });

  it("unresolvedRefs：仅 fig:/tab: 域内不存在的 label（去重）", () => {
    expect(inventory.unresolvedRefs).toEqual(["fig:ghost"]);
  });

  it("generatedFiguresUsed：figs/generated/ 前缀识别", () => {
    expect(inventory.generatedFiguresUsed).toEqual(["figs/generated/fig-abc123.pdf"]);
  });
});

describe("M12 B1 buildVisualInventory：确定性与等价", () => {
  it("同输入两次构建 byte 级一致（无时间戳 / 无随机）", () => {
    expect(JSON.stringify(buildVisualInventory(FILES))).toBe(JSON.stringify(inventory));
  });

  it("CRLF 输入与 LF 输入产出等价 inventory", () => {
    const crlfFiles = FILES.map((entry) => ({
      file: entry.file,
      content: entry.content.replaceAll("\n", "\r\n"),
    }));
    expect(JSON.stringify(buildVisualInventory(crlfFiles))).toBe(JSON.stringify(inventory));
  });

  it("manuscriptRevision：调用方提供才写入，缺省不伪造", () => {
    expect("manuscriptRevision" in inventory).toBe(false);
    expect(buildVisualInventory(FILES, { manuscriptRevision: 7 }).manuscriptRevision).toBe(7);
  });

  it("花括号不闭合的 caption：fail-soft 缺省 + note，不伪造", () => {
    const broken = buildVisualInventory([
      { file: "broken.tex", content: "\\section{S}\n\\begin{figure}\n\\caption{未闭合\n\\end{figure}\n" },
    ]);
    const figure = broken.files[0]!.figures[0]!;
    expect(figure.caption).toBeUndefined();
    expect(broken.captionMissing).toEqual(["broken.tex#figure-1"]);
    expect(broken.notes.some((note) => note.includes("caption 花括号不闭合"))).toBe(true);
  });

  it("超过行上限的表：截断并显式 note", () => {
    const rows = Array.from({ length: 90 }, (_, index) => `R${index} & ${index} \\\\`).join("\n");
    const big = buildVisualInventory([
      { file: "big.tex", content: `\\begin{table}\\begin{tabular}{ll}\n${rows}\n\\end{tabular}\\end{table}\n` },
    ]);
    const table = big.files[0]!.tables[0]!;
    expect(table.rowCount).toBe(80);
    expect(big.notes.some((note) => note.includes("超过 80 行"))).toBe(true);
  });
});

describe("M12 B1 持久化（research/manuscript-visuals.json）", () => {
  it("persist → load roundtrip；未构建 → null；损坏 / 版本不符 → fail-closed", async () => {
    const projects = await newProjectStore();
    const project = await projects.create("visual inventory 测试");

    expect(await loadVisualInventory(projects, project.id)).toBeNull();

    const withRevision = buildVisualInventory(FILES, { manuscriptRevision: 3 });
    await persistVisualInventory(projects, project.id, withRevision);
    expect(await loadVisualInventory(projects, project.id)).toEqual(withRevision);

    const path = visualInventoryPath(projects, project.id);
    expect(path).toBe(join(projects.researchDir(project.id), "manuscript-visuals.json"));

    await writeFile(path, "{corrupted", "utf8");
    const error = await loadVisualInventory(projects, project.id).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BusinessError);
    expect((error as BusinessError).code).toBe("VISUAL_INVENTORY_CORRUPTED");

    await writeFile(path, JSON.stringify({ schemaVersion: 2, files: [] }), "utf8");
    await expect(loadVisualInventory(projects, project.id)).rejects.toBeInstanceOf(BusinessError);
  });
});
