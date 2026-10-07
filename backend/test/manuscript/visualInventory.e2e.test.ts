/**
 * M12 Batch 1 Smoke B：真实 fixture 手稿 → visualInventory → VisualArtifactView。
 *
 * 与 unit 层（visualInventory.test.ts 内联字符串）的区别：本文件走完整磁盘链——
 * collectLatexFiles 从 fixtures/manuscript/visual-sample/ 读真实 .tex（含
 * \input 子文件），buildVisualInventory 解析，persistVisualInventory 落盘
 * research/manuscript-visuals.json，loadVisualInventory 读回，fromVisualInventory
 * 投影为 VisualArtifactView。验证的是「仓库内 fixture 上的端到端确定性」，
 * 不依赖网络 / LLM / 真实 Docling。
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { collectLatexFiles } from "../../src/manuscript/LatexFiles.js";
import {
  buildVisualInventory,
  loadVisualInventory,
  persistVisualInventory,
} from "../../src/manuscript/visualInventory.js";
import { fromVisualInventory } from "../../src/review/visualArtifactView.js";

const FIXTURE_DIR = join(import.meta.dirname, "..", "fixtures", "manuscript", "visual-sample");

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("M12 Batch 1 Smoke B：fixture 手稿 → inventory → VisualArtifactView", () => {
  it("collectLatexFiles → buildVisualInventory → persist → load → 投影（figure/table/caption/label/refs 全链）", async () => {
    const files = await collectLatexFiles(FIXTURE_DIR);
    expect(files.mainTex).not.toBeNull();
    expect(files.allTex.map((file) => file.relativePath).sort()).toEqual(
      ["main.tex", "sections/method.tex"].sort(),
    );

    const inventory = buildVisualInventory(
      files.allTex.map((file) => ({ file: file.relativePath, content: file.content })),
    );

    // ---- figure 断言（main.tex：3 个 figure 环境；sections/method.tex：0 个）----
    const main = inventory.files.find((file) => file.file === "main.tex")!;
    expect(main.figures).toHaveLength(3);
    const [arch, qualitative, noCaption] = main.figures;
    expect(arch).toMatchObject({
      environment: "figure",
      label: "fig:arch",
      caption: "Overview of the proposed tracking pipeline.",
      includegraphicsPath: "figs/architecture.pdf",
      linkedSection: "Introduction",
    });
    expect(qualitative).toMatchObject({
      environment: "figure*",
      label: "fig:qualitative",
      includegraphicsPath: "figs/qualitative.png",
      linkedSection: "Introduction",
    });
    // 第三个 figure：无 label 无 caption —— 如实缺省，不伪造
    expect(noCaption?.label).toBeUndefined();
    expect(noCaption?.caption).toBeUndefined();
    expect(noCaption?.includegraphicsPath).toBe("figs/no-caption.pdf");

    // ---- table 断言（main.tex：3 个；sections/method.tex：1 个）----
    expect(main.tables).toHaveLength(3);
    const [mainTable, ablationTable, extraTable] = main.tables;
    expect(mainTable).toMatchObject({
      environment: "table",
      label: "tab:main",
      caption: "Main results on the benchmark.",
      linkedSection: "Method",
      hasTabular: true,
    });
    expect(mainTable!.headers).toEqual(["Method", "MOTA", "IDS"]);
    expect(mainTable!.rows).toEqual([
      ["Baseline", "62.4", "118"],
      ["Ours", "65.1", "79"],
    ]);
    expect(ablationTable).toMatchObject({ environment: "table*", label: "tab:ablation" });
    // 第三个 table：无 caption（进 captionMissing）
    expect(extraTable?.caption).toBeUndefined();

    const method = inventory.files.find((file) => file.file === "sections/method.tex")!;
    expect(method.tables).toHaveLength(1);
    expect(method.tables[0]).toMatchObject({
      label: "tab:assoc-cost",
      caption: "Association cost components.",
      linkedSection: "Association Details",
    });

    // ---- 引用域：unresolved + 重复引用 + 跨文件引用 ----
    expect(inventory.unresolvedRefs).toEqual(["fig:missing-asset"]);
    const archRefs = inventory.references.filter((ref) => ref.label === "fig:arch");
    // main.tex Introduction 两处 + sections/method.tex 一处
    expect(archRefs).toHaveLength(3);
    expect(archRefs.some((ref) => ref.file === "sections/method.tex")).toBe(true);
    const mainTableRefs = inventory.references.filter((ref) => ref.label === "tab:main");
    expect(mainTableRefs).toHaveLength(2); // main.tex 一处 + method.tex 一处
    expect(inventory.captionMissing.length).toBeGreaterThan(0);

    // ---- 持久化：research/manuscript-visuals.json 落盘 + 读回等价 ----
    const root = await mkdtemp(join(tmpdir(), "paperteam-smokeb-"));
    roots.push(root);
    const projects = new ProjectStore({ root });
    const project = await projects.create("Smoke B visual inventory");
    await persistVisualInventory(projects, project.id, inventory);
    const reloaded = await loadVisualInventory(projects, project.id);
    expect(reloaded).toEqual(inventory);

    // ---- 投影：VisualArtifactView 统一形状 ----
    const views = fromVisualInventory(reloaded!);
    expect(views).toHaveLength(7); // 3 figure + 4 table
    const byId = new Map(views.map((view) => [view.id, view]));
    const archView = byId.get("tex:main.tex:figure-1")!;
    expect(archView).toMatchObject({
      kind: "figure",
      sourceKind: "latex_env",
      label: "fig:arch",
      caption: "Overview of the proposed tracking pipeline.",
      assetRef: "figs/architecture.pdf",
      linkedSection: "Introduction",
    });
    expect(archView.referencedBy).toHaveLength(3);
    const mainTableView = byId.get("tex:main.tex:table-1")!;
    expect(mainTableView).toMatchObject({
      kind: "table",
      sourceKind: "latex_env",
      tableGrid: { headers: ["Method", "MOTA", "IDS"] },
    });
    // 确定性：同输入二次投影 id 稳定且 deep-equal
    expect(fromVisualInventory(buildVisualInventory(
      files.allTex.map((file) => ({ file: file.relativePath, content: file.content })),
    ))).toEqual(views);
  });
});
