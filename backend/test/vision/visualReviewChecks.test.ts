/**
 * M12 Batch 2 · B3：确定性视觉检查核心（vision/visualChecks.ts 纯函数）。
 *
 * 分两层：
 * 1. 内联构造的最小用例——逐条锁定检查规则（label/ref、caption、数值一致
 *    性的 TP 与三类假阳性守卫、题注-描述匹配的 TP/Skip、pdf 分组隔离）；
 * 2. fixture（test/fixtures/manuscript/visual-review-sample/）端到端——
 *    收敛同一入口（inventory → 投影 → prose → checks），本批 Smoke B 的
 *    断言面（预期 finding 集合逐一锁定）。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildVisualInventory, type VisualInventoryTexFile } from "../../src/manuscript/visualInventory.js";
import { fromParsedBlocks, fromVisualInventory } from "../../src/review/visualArtifactView.js";
import {
  runDeterministicVisualChecks,
  stripLatexVisualAndMath,
  type ProseUnit,
} from "../../src/vision/visualChecks.js";
import { emptyCounts, type ParsedBlock, type ParsedDocument } from "../../src/ingestion/types.js";

const NOW = "2026-10-07T10:00:00.000Z";
const FIXTURE_DIR = join(import.meta.dirname, "..", "fixtures", "manuscript", "visual-review-sample");

function texUnit(file: string, content: string): VisualInventoryTexFile {
  return { file, content };
}

function latexProse(files: VisualInventoryTexFile[]): ProseUnit[] {
  return files.map((file) => ({
    sourceKey: `tex:${file.file}`,
    file: file.file,
    text: stripLatexVisualAndMath(file.content),
  }));
}

/** 内联 latex：单表 + 可配正文句 */
function inlineSetup(prose: string) {
  const tex = texUnit(
    "main.tex",
    [
      "\\section{Experiments}",
      ...prose.split("\n").map((line) => line.trim()),
      "\\begin{table}[t]",
      "  \\caption{Main results on the benchmark.}",
      "  \\label{tab:main}",
      "  \\begin{tabular}{lcc}",
      "    Method & MOTA & IDS \\\\",
      "    MOT tracklet & 78.2 & 101 \\\\",
      "    Ours & 81.6 & 79 \\\\",
      "  \\end{tabular}",
      "\\end{table}",
      "As shown in Table~\\ref{tab:main}.",
    ].join("\n"),
  );
  const inventory = buildVisualInventory([tex]);
  return {
    inventory,
    views: fromVisualInventory(inventory),
    prose: latexProse([tex]),
  };
}

function numericFindings(prose: string) {
  const setup = inlineSetup(prose);
  return runDeterministicVisualChecks({ ...setup, now: NOW }).findings.filter(
    (finding) => finding.findingId.includes("table-text-numeric"),
  );
}

// ---- 1. label / ref / caption / unreferenced ----

describe("M12 B3 确定性检查：label/ref/caption/unreferenced", () => {
  it("unresolved ref → major + verified_deterministic + 引用位置 chunkId", () => {
    const tex = texUnit(
      "main.tex",
      [
        "See Figure~\\ref{fig:missing} and Table~\\ref{tab:missing}.",
        "\\begin{figure}[t]\\caption{C.}\\label{fig:real}\\end{figure}",
      ].join("\n"),
    );
    const inventory = buildVisualInventory([tex]);
    const result = runDeterministicVisualChecks({
      views: fromVisualInventory(inventory),
      inventory,
      prose: latexProse([tex]),
      now: NOW,
    });
    const unresolved = result.findings.filter((f) => f.findingId.includes("unresolved-ref"));
    expect(unresolved).toHaveLength(2);
    expect(unresolved[0]).toMatchObject({
      category: "visual",
      severity: "major",
      source: "deterministic-visual",
      verificationStatus: "verified_deterministic",
      chunkId: "tex:main.tex#L1",
    });
    expect(result.checks.find((c) => c.checkId === "label-ref-resolution")?.status).toBe("finding");
  });

  it("duplicate label → major（列出全部环境）", () => {
    const tex = texUnit(
      "main.tex",
      [
        "\\begin{table}[t]\\caption{A.}\\label{tab:dup}\\end{table}",
        "\\begin{table}[t]\\caption{B.}\\label{tab:dup}\\end{table}",
        "Ref Table~\\ref{tab:dup}.",
      ].join("\n"),
    );
    const inventory = buildVisualInventory([tex]);
    const result = runDeterministicVisualChecks({
      views: fromVisualInventory(inventory),
      inventory,
      prose: latexProse([tex]),
      now: NOW,
    });
    const dup = result.findings.find((f) => f.findingId.includes("duplicate-label"));
    expect(dup).toMatchObject({ severity: "major", verificationStatus: "verified_deterministic" });
    expect(dup?.message).toContain("tex:main.tex:table-1");
    expect(dup?.message).toContain("tex:main.tex:table-2");
  });

  it("缺 caption → minor（锚定 view id）；inventory 为 null → 对应检查 skipped", () => {
    const tex = texUnit(
      "main.tex",
      [
        "\\begin{figure}[t]\\caption{C.}\\label{fig:a}\\end{figure}",
        "\\begin{figure}[t]\\includegraphics{x.pdf}\\end{figure}",
        "Ref Figure~\\ref{fig:a}.",
      ].join("\n"),
    );
    const inventory = buildVisualInventory([tex]);
    const withInventory = runDeterministicVisualChecks({
      views: fromVisualInventory(inventory),
      inventory,
      prose: latexProse([tex]),
      now: NOW,
    });
    expect(withInventory.findings.find((f) => f.findingId.includes("missing-caption"))).toMatchObject({
      severity: "minor",
      figureEnvRef: "tex:main.tex:figure-2",
    });
    expect(withInventory.checks.find((c) => c.checkId === "missing-caption")?.visualArtifactIds).toEqual([
      "tex:main.tex:figure-2",
    ]);

    const noInventory = runDeterministicVisualChecks({ views: [], inventory: null, prose: [], now: NOW });
    expect(noInventory.checks.find((c) => c.checkId === "label-ref-resolution")?.status).toBe("skipped");
    expect(noInventory.checks.find((c) => c.checkId === "missing-caption")?.status).toBe("passed");
    expect(noInventory.findings).toHaveLength(0);
  });

  it("unreferenced：全文无 \\ref 引用 → skipped（字面引用风格手稿不误报）", () => {
    const tex = texUnit(
      "main.tex",
      ["\\begin{figure}[t]\\caption{C.}\\label{fig:a}\\end{figure}", "Plain literal style."].join("\n"),
    );
    const inventory = buildVisualInventory([tex]);
    const result = runDeterministicVisualChecks({
      views: fromVisualInventory(inventory),
      inventory,
      prose: latexProse([tex]),
      now: NOW,
    });
    expect(result.checks.find((c) => c.checkId === "unreferenced-artifact")?.status).toBe("skipped");
  });
});

// ---- 2. 数值一致性（TP 与假阳性守卫） ----

describe("M12 B3 确定性检查：表-文数值一致性", () => {
  it("TP：同指标 + 同行标签 + 数值邻近 → 冲突 finding（major/high/verified）", () => {
    const findings = numericFindings("MOT tracklet achieves a MOTA of 76.3 on this benchmark.");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      category: "visual",
      severity: "major",
      source: "deterministic-visual",
      visualConfidence: "high",
      verificationStatus: "verified_deterministic",
      figureEnvRef: "tex:main.tex:table-1",
    });
    expect(findings[0]?.message).toContain("76.3");
    expect(findings[0]?.message).toContain("78.2");
    expect(findings[0]?.claimText).toContain("MOTA of 76.3");
  });

  it("一致：正文数值与表值相同 → 无 finding", () => {
    expect(numericFindings("Ours attains a MOTA of 81.6 with only 79 IDS errors.")).toHaveLength(0);
    expect(numericFindings("MOT tracklet reaches 78.2 on the MOTA metric.")).toHaveLength(0);
  });

  it("FP 守卫 1（同数异境）：数值与表值相同但句子无指标/行绑定 → 不比较", () => {
    expect(numericFindings("Each sequence contains at most 101 frames for capture.")).toHaveLength(0);
  });

  it("FP 守卫 2（指标缺行）：只提指标、无行标签 → 不比较（裸数字不是 finding）", () => {
    expect(numericFindings("The MOTA of 76.3 appears in an internal note.")).toHaveLength(0);
  });

  it("FP 守卫 3（他指标）：数值等于别列值但句中指标不是表头 → 不比较", () => {
    expect(numericFindings("Ours runs at 79 FPS on the edge device.")).toHaveLength(0);
  });

  it("FP 守卫 4（增量语）：by/± 前缀的差值不当作取值", () => {
    expect(numericFindings("Ours improves MOTA by 12 points over the baseline variant.")).toHaveLength(0);
  });

  it("FP 守卫 5（标识符数字）：MOT17 等字母相邻数字不参与比对", () => {
    expect(numericFindings("Ours evaluates on MOT17 where MOTA reaches 81.6.")).toHaveLength(0);
  });

  it("多表消歧：同 (行, 指标) 在两表出现，数值匹配任一表即一致", () => {
    const tex = texUnit(
      "main.tex",
      [
        "\\section{Exp}",
        "MOT tracklet achieves a MOTA of 78.2 overall.",
        "\\begin{table}[t]\\caption{Main.}\\label{tab:a}\\begin{tabular}{lc}Method & MOTA \\\\ MOT tracklet & 78.2 \\\\\\end{tabular}\\end{table}",
        "\\begin{table}[t]\\caption{Ablation.}\\label{tab:b}\\begin{tabular}{lc}Variant & MOTA \\\\ MOT tracklet & 76.0 \\\\\\end{tabular}\\end{table}",
      ].join("\n"),
    );
    const inventory = buildVisualInventory([tex]);
    const result = runDeterministicVisualChecks({
      views: fromVisualInventory(inventory),
      inventory,
      prose: latexProse([tex]),
      now: NOW,
    });
    expect(result.findings.filter((f) => f.findingId.includes("table-text-numeric"))).toHaveLength(0);
  });

  it("± 形态：表值 \"78.2 ± 0.3\" 的任一分量命中即一致", () => {
    const tex = texUnit(
      "main.tex",
      [
        "\\section{Exp}",
        "MOT tracklet achieves a MOTA of 0.3 spread.",
        "\\begin{table}[t]\\caption{Main.}\\label{tab:a}\\begin{tabular}{lc}Method & MOTA \\\\ MOT tracklet & 78.2 $\\pm$ 0.3 \\\\\\end{tabular}\\end{table}",
      ].join("\n"),
    );
    const inventory = buildVisualInventory([tex]);
    const result = runDeterministicVisualChecks({
      views: fromVisualInventory(inventory),
      inventory,
      prose: latexProse([tex]),
      now: NOW,
    });
    expect(result.findings.filter((f) => f.findingId.includes("table-text-numeric"))).toHaveLength(0);
  });
});

// ---- 3. pdf 分组与隔离 ----

function pdfDoc(sourceId: string): ParsedDocument {
  const blocks: ParsedBlock[] = [
    {
      blockId: "B0001",
      type: "table",
      provenance: { fileName: `${sourceId}-paper.pdf`, page: 2 },
      caption: "Table 1: results",
      headers: ["Method", "MOTA"],
      rows: [["MOT tracklet", "78.2"]],
      rowCount: 1,
      columnCount: 2,
    },
    {
      blockId: "B0002",
      type: "text",
      provenance: { fileName: `${sourceId}-paper.pdf`, page: 3 },
      text: "MOT tracklet achieves a MOTA of 76.3 in the evaluation.",
      textKind: "paragraph",
    },
  ];
  return {
    schemaVersion: 1,
    sourceId,
    fileName: `${sourceId}-paper.pdf`,
    storedFileName: `${sourceId}-paper.pdf`,
    kind: "pdf",
    mimeType: "application/pdf",
    parser: { id: "docling", version: "test" },
    parseMode: "structured",
    status: "ok",
    pageCount: 3,
    blocks,
    counts: emptyCounts(),
    notes: [],
    contentHash: "a".repeat(64),
    parsedAt: NOW,
  };
}

describe("M12 B3 确定性检查：pdf_parsed 分组", () => {
  it("pdf 表 × pdf 正文：冲突照常检出（page 定位）", () => {
    const doc = pdfDoc("S0001");
    const result = runDeterministicVisualChecks({
      views: fromParsedBlocks("S0001", doc),
      inventory: null,
      prose: [
        {
          sourceKey: "pdf:S0001",
          text: (doc.blocks[1] as { text: string }).text,
          page: 3,
          sourceId: "S0001",
        },
      ],
      now: NOW,
    });
    const conflict = result.findings.find((f) => f.findingId.includes("table-text-numeric"));
    expect(conflict).toBeDefined();
    expect(conflict?.figureEnvRef).toBe("pdf:S0001:B0001");
    expect(conflict?.page).toBe(3);
  });

  it("分组隔离：latex 表不与 pdf 正文交叉比较（反之亦然）", () => {
    const doc = pdfDoc("S0001");
    const latex = inlineSetup("MOT tracklet achieves a MOTA of 76.3 today.");
    const result = runDeterministicVisualChecks({
      views: [...latex.views, ...fromParsedBlocks("S0001", doc)],
      inventory: latex.inventory,
      prose: [
        {
          sourceKey: "pdf:S0001",
          text: "MOT tracklet achieves a MOTA of 81.6 in the evaluation.",
          page: 3,
          sourceId: "S0001",
        },
        ...latex.prose,
      ],
      now: NOW,
    });
    const conflicts = result.findings.filter((f) => f.findingId.includes("table-text-numeric"));
    // latex 表（78.2）只与 latex 正文（76.3）比 → 1 条；pdf 表（78.2）与 pdf 正文（81.6）比 → 1 条；
    // 但绝不出现 latex 表 × pdf 正文 / pdf 表 × latex 正文的交叉比对（总数恰为 2 且锚定各自 view）
    expect(conflicts).toHaveLength(2);
    expect(new Set(conflicts.map((f) => f.figureEnvRef))).toEqual(
      new Set(["tex:main.tex:table-1", "pdf:S0001:B0001"]),
    );
  });
});

// ---- 4. 题注-描述匹配 ----

describe("M12 B3 确定性检查：题注-描述匹配（启发式）", () => {
  function mismatchFindings(prose: string) {
    const tex = texUnit(
      "main.tex",
      [
        "\\section{Exp}",
        prose,
        "\\begin{table}[t]\\caption{Association cost components.}\\label{tab:assoc}\\begin{tabular}{lc}C & W \\\\ IoU & 0.4 \\\\\\end{tabular}\\end{table}",
      ].join("\n"),
    );
    const inventory = buildVisualInventory([tex]);
    return runDeterministicVisualChecks({
      views: fromVisualInventory(inventory),
      inventory,
      prose: latexProse([tex]),
      now: NOW,
    }).findings.filter((f) => f.findingId.includes("caption-ref-mismatch"));
  }

  it("TP：字面编号描述与题注词面不符 → minor / medium / needs_author_review", () => {
    const findings = mismatchFindings("Table 1 shows the per-sequence ablation results in detail.");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: "minor",
      visualConfidence: "medium",
      verificationStatus: "needs_author_review",
      figureEnvRef: "tex:main.tex:table-1",
    });
    expect(findings[0]?.message).toContain("Association cost components");
  });

  it("词面重叠（\\ref 形态）→ 无 finding；全泛词描述 → 不可判（skip）", () => {
    expect(mismatchFindings("Table~\\ref{tab:assoc} lists the association cost components.")).toHaveLength(0);
    expect(mismatchFindings("Table 1 shows the results of the experiments.")).toHaveLength(0);
  });

  it("无动词提及（不可靠解析）→ 不判", () => {
    expect(mismatchFindings("As shown in Table 1, the trend is clear.")).toHaveLength(0);
  });
});

// ---- 5. fixture 端到端（本批 Smoke B 断言面） ----

describe("M12 B3 fixture 端到端：visual-review-sample", () => {
  it("预期 finding 集合逐一锁定（1 数值冲突 + 1 题注不符 + 1 未解析引用 + 1 缺 caption + 1 未引用）", async () => {
    const content = await readFile(join(FIXTURE_DIR, "main.tex"), "utf8");
    const tex = texUnit("main.tex", content);
    const inventory = buildVisualInventory([tex]);
    const result = runDeterministicVisualChecks({
      views: fromVisualInventory(inventory),
      inventory,
      prose: latexProse([tex]),
      now: NOW,
    });

    const byCheck = (prefix: string) => result.findings.filter((f) => f.findingId.includes(prefix));
    // 数值冲突：恰 1 条（76.3 vs 78.2）——其余全部一致/守卫跳过
    const numeric = byCheck("table-text-numeric");
    expect(numeric).toHaveLength(1);
    expect(numeric[0]?.message).toContain("76.3");
    expect(numeric[0]?.message).toContain("78.2");
    // 题注不符：恰 1 条（Table 2 字面描述 vs cost components 题注）
    const caption = byCheck("caption-ref-mismatch");
    expect(caption).toHaveLength(1);
    expect(caption[0]?.figureEnvRef).toBe("tex:main.tex:table-2");
    // 未解析引用：恰 1 条
    expect(byCheck("unresolved-ref")).toHaveLength(1);
    // 缺 caption：恰 1 条（第二个 figure）
    expect(byCheck("missing-caption")).toHaveLength(1);
    // 未引用（info）：恰 1 条（tab:ablation 仅字面提及）
    const unreferenced = byCheck("unreferenced");
    expect(unreferenced).toHaveLength(1);
    expect(unreferenced[0]?.figureEnvRef).toBe("tex:main.tex:table-3");
    expect(unreferenced[0]?.severity).toBe("info");

    // 总数锁定：无任何额外 finding（假阳性守卫的可执行证明）
    expect(result.findings).toHaveLength(5);

    // 检查项状态
    const statusOf = (checkId: string) => result.checks.find((c) => c.checkId === checkId)?.status;
    expect(statusOf("label-ref-resolution")).toBe("finding");
    expect(statusOf("duplicate-label")).toBe("passed");
    expect(statusOf("missing-caption")).toBe("finding");
    expect(statusOf("unreferenced-artifact")).toBe("finding");
    expect(statusOf("table-text-numeric")).toBe("finding");
    expect(statusOf("caption-reference-mismatch")).toBe("finding");
  });
});
