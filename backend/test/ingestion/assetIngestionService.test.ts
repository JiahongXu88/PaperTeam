/**
 * M10.1.1 资产 ingestion 服务级测试：统一入口分派（registry）、
 * JSON/YAML path 寻址确认（user_confirmed 语义边界回归）、
 * 不支持类型前置拒绝、图片登记落盘。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { BusinessError } from "../../src/errors.js";
import { classifyEvidence, isFormalEvidence } from "../../src/evidence/EvidenceSelectionService.js";
import type { ParsedCodeBlock, ParsedFigureBlock, ParsedRecordBlock, ParsedTextBlock } from "../../src/ingestion/types.js";
import { cleanupIngestionFixtures, newIngestionFixture } from "./fixtures.js";
import { makePng } from "./binaryFixtures.js";

afterAll(cleanupIngestionFixtures);

describe("M10.1.1 资产 ingestion：统一入口分派", () => {
  it("TXT / Markdown / LaTeX / 源码 → ParsedDocument（kind / 行 provenance / language）", async () => {
    const f = await newIngestionFixture();
    const txt = await f.addFileSource("notes.txt", "tracking notes\n\nMOT17 benchmark\n");
    const txtDoc = await f.ingestion.ingest(f.projectId, txt.sourceId);
    expect(txtDoc.kind).toBe("text");
    expect(txtDoc.status).toBe("ok");
    expect((txtDoc.blocks[0] as ParsedTextBlock).provenance.lineStart).toBe(1);

    const md = await f.addFileSource("README.md", "# MOT17 Tracking\n\nWe reproduce the baseline.\n");
    const mdDoc = await f.ingestion.ingest(f.projectId, md.sourceId);
    expect(mdDoc.kind).toBe("markdown");
    const mdHeader = mdDoc.blocks.find((b) => b.type === "text" && b.text === "MOT17 Tracking");
    expect((mdHeader as ParsedTextBlock).textKind).toBe("section_header");

    const tex = await f.addFileSource("paper.tex", "\\section{Results}\nMOTA reaches 82.4.\n");
    const texDoc = await f.ingestion.ingest(f.projectId, tex.sourceId);
    expect(texDoc.kind).toBe("latex");
    expect(
      (texDoc.blocks.find((b) => b.type === "text" && b.text.includes("MOTA")) as ParsedTextBlock)
        ?.provenance.section,
    ).toBe("Results");

    const py = await f.addFileSource("train.py", "learning_rate = 0.001\nepochs = 100\n");
    const pyDoc = await f.ingestion.ingest(f.projectId, py.sourceId);
    expect(pyDoc.kind).toBe("code");
    expect(pyDoc.mimeType).toBe("text/plain");
    expect((pyDoc.blocks[0] as ParsedCodeBlock).language).toBe("python");
    expect((pyDoc.blocks[0] as ParsedCodeBlock).provenance.lineStart).toBe(1);
  });

  it("JSON → structured_record 路径投影；path 寻址确认 → user_confirmed（值校验 + 语义边界）", async () => {
    const f = await newIngestionFixture();
    const json = await f.addFileSource(
      "config.json",
      JSON.stringify({ dataset: "MOT17", training: { epochs: 100, batch_size: 8 } }),
    );
    const doc = await f.ingestion.ingest(f.projectId, json.sourceId);
    expect(doc.kind).toBe("json");
    expect(doc.counts.structured_record).toBe(3);
    const epochs = doc.blocks.find(
      (b) => b.type === "structured_record" && b.provenance.jsonPath === "$.training.epochs",
    ) as ParsedRecordBlock;
    expect(epochs.cells[0]!.value).toBe("100");

    // path 寻址确认：值匹配
    const confirmed = await f.ingestion.confirmRecordEvidence(f.projectId, json.sourceId, {
      path: "$.training.epochs",
      claim: "训练轮数为 100 epochs",
    });
    expect(confirmed.evidence.verificationLevel).toBe("user_confirmed");
    expect(confirmed.evidence.verificationStatus).toBe("unverified");
    expect(confirmed.evidence.location?.path).toBe("$.training.epochs");
    expect(confirmed.evidence.quote).toBe("100");

    // 语义边界：user_confirmed ≠ grounded_verified（formal 池排除，与 CSV 同口径）
    expect(isFormalEvidence(confirmed.evidence)).toBe(false);
    expect(classifyEvidence(confirmed.evidence)).not.toBe("grounded_verified");

    // 值不匹配 → EVIDENCE_VALUE_MISMATCH（数值等价除外）
    await expect(
      f.ingestion.confirmRecordEvidence(f.projectId, json.sourceId, {
        path: "$.training.epochs",
        claim: "训练轮数为 50",
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_VALUE_MISMATCH" });

    // path 不存在 → NOT_FOUND
    await expect(
      f.ingestion.confirmRecordEvidence(f.projectId, json.sourceId, {
        path: "$.training.missing",
        claim: "x 100",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("YAML → 投影带行号（row）；row/column 寻址仍可用", async () => {
    const f = await newIngestionFixture();
    const yaml = await f.addFileSource("experiment.yaml", "dataset: MOT17\ntraining:\n  epochs: 100\n");
    const doc = await f.ingestion.ingest(f.projectId, yaml.sourceId);
    expect(doc.kind).toBe("yaml");
    const epochs = doc.blocks.find(
      (b) => b.type === "structured_record" && b.provenance.jsonPath === "$.training.epochs",
    ) as ParsedRecordBlock;
    expect(epochs.provenance.row).toBe(3);
    const confirmed = await f.ingestion.confirmRecordEvidence(f.projectId, yaml.sourceId, {
      path: "$.training.epochs",
      claim: "epochs 设置为 100",
    });
    expect(confirmed.evidence.location?.row).toBe(3);
  });

  it("Notebook → cell 块 + 输出块 + 图片资产落 figures 目录", async () => {
    const f = await newIngestionFixture();
    const png = makePng(32, 32);
    const nb = JSON.stringify({
      cells: [
        { cell_type: "markdown", id: "c1", source: ["# Analysis\n", "结论：MOTA 82.4。\n"] },
        {
          cell_type: "code",
          execution_count: 2,
          source: "print('done')",
          outputs: [
            { output_type: "stream", name: "stdout", text: "done\n" },
            { output_type: "display_data", data: { "image/png": png.toString("base64") } },
          ],
        },
      ],
      metadata: { kernelspec: { language: "python" } },
      nbformat: 4,
    });
    const nbSource = await f.addFileSource("analysis.ipynb", nb);
    const doc = await f.ingestion.ingest(f.projectId, nbSource.sourceId);
    expect(doc.kind).toBe("notebook");
    expect(doc.counts.text).toBeGreaterThanOrEqual(2);
    expect(doc.counts.code).toBe(1);
    expect(doc.counts.output).toBe(1);
    expect(doc.counts.figure).toBe(1);
    const figure = doc.blocks.find((b) => b.type === "figure") as ParsedFigureBlock;
    expect(figure.assetName).toBe("cell-1-output-1.png");
    const assetPath = join(f.documents.figuresDir(f.projectId, nbSource.sourceId), figure.assetName!);
    expect((await readFile(assetPath)).equals(png)).toBe(true);
  });

  it("图片 → 登记文档（figure 块 + 尺寸 + 资产）", async () => {
    const f = await newIngestionFixture();
    const png = makePng(120, 90);
    const image = await f.addFileSource("figure.png", png);
    const doc = await f.ingestion.ingest(f.projectId, image.sourceId);
    expect(doc.kind).toBe("image");
    expect(doc.mimeType).toBe("image/png");
    expect(doc.counts.figure).toBe(1);
    const block = doc.blocks[0] as ParsedFigureBlock;
    expect(block.width).toBe(120);
    expect(block.height).toBe(90);
    const assetPath = join(f.documents.figuresDir(f.projectId, image.sourceId), block.assetName!);
    expect((await readFile(assetPath)).equals(png)).toBe(true);
  });

  it("不支持类型（bib = 能力边界外）→ INVALID_REQUEST 前置拒绝", async () => {
    const f = await newIngestionFixture();
    const bib = await f.addFileSource("references.bib", "@article{a, title={A}}");
    await expect(f.ingestion.ingest(f.projectId, bib.sourceId)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(f.ingestion.ingest(f.projectId, bib.sourceId)).rejects.toThrow(/不支持结构化解析/);
  });

  it("malformed JSON → status=failed 文档落盘（上传链路可见，可重试）", async () => {
    const f = await newIngestionFixture();
    const bad = await f.addFileSource("bad.json", "{ not json");
    const doc = await f.ingestion.ingest(f.projectId, bad.sourceId);
    expect(doc.status).toBe("failed");
    expect(doc.kind).toBe("json");
    expect(doc.notes[0]).toContain("解析失败");
    // 修复后的内容是新的条目（contentHash 判定）；重新上传 → 解析成功
    const fixed = await f.addFileSource("bad-fixed.json", "{\"ok\": true}");
    const retry = await f.ingestion.ingest(f.projectId, fixed.sourceId);
    expect(retry.status).toBe("ok");
    expect(retry.counts.structured_record).toBe(1);
  });

  it("business error 形态：不支持类型抛 BusinessError", async () => {
    const f = await newIngestionFixture();
    const bib = await f.addFileSource("x.bib", "@book{b}");
    const error = await f.ingestion.ingest(f.projectId, bib.sourceId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BusinessError);
  });
});
