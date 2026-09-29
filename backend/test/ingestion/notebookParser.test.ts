/**
 * M10.1.1 Notebook parser 单测（静态解析；绝不执行）。
 * 覆盖：markdown cell、code cell（语言 / executionCount）、文本输出、
 * error 输出、图片输出登记（资产 + 尺寸）、超限 visualOutputPresent、
 * 超长输出截断、malformed ipynb。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { DocumentParseFailedError } from "../../src/errors.js";
import { NotebookParser } from "../../src/ingestion/notebookParser.js";
import type {
  ParsedCodeBlock,
  ParsedFigureBlock,
  ParsedOutputBlock,
  ParsedTextBlock,
} from "../../src/ingestion/types.js";
import { makePng } from "./binaryFixtures.js";

const PARSER = new NotebookParser();
const ESC = String.fromCharCode(27); // ANSI 转义前缀（traceback fixture 用）
const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function notebook(cells: unknown[], metadata?: unknown): string {
  return JSON.stringify({
    cells,
    metadata: metadata ?? { kernelspec: { name: "python3", language: "python" } },
    nbformat: 4,
    nbformat_minor: 5,
  });
}

describe("M10.1.1 NotebookParser（静态解析）", () => {
  it("markdown cell → text 块（cell 内行 provenance + cellIndex + 标题 section）", async () => {
    const nb = notebook([
      {
        cell_type: "markdown",
        id: "intro-cell",
        source: ["# Analysis\n", "\n", "MOTA improved from 78.2 to 82.4 on MOT17."],
      },
    ]);
    const extraction = await PARSER.parseBuffer(Buffer.from(nb, "utf8"), "analysis.ipynb");
    const blocks = extraction.blocks as ParsedTextBlock[];
    expect(blocks.filter((b) => b.type === "text")).toHaveLength(2);
    const header = blocks.find((b) => b.textKind === "section_header")!;
    expect(header.text).toBe("Analysis");
    expect(header.provenance.cellIndex).toBe(0);
    expect(header.provenance.cellId).toBe("intro-cell");
    expect(header.provenance.lineStart).toBe(1);
    const body = blocks.find((b) => b.text.includes("MOTA"))!;
    expect(body.provenance.cellIndex).toBe(0);
    expect(body.provenance.section).toBe("Analysis");
    expect(body.provenance.lineStart).toBe(3);
  });

  it("code cell → code 块（python 语言 / executionCount / cell 行窗口）", async () => {
    const nb = notebook([
      {
        cell_type: "code",
        execution_count: 7,
        source: "import json\nwith open('config.json') as f:\n    config = json.load(f)\nprint(config['training']['epochs'])",
      },
    ]);
    const extraction = await PARSER.parseBuffer(Buffer.from(nb, "utf8"), "analysis.ipynb");
    const code = extraction.blocks[0] as ParsedCodeBlock;
    expect(code.type).toBe("code");
    expect(code.language).toBe("python");
    expect(code.executionCount).toBe(7);
    expect(code.provenance.cellIndex).toBe(0);
    expect(code.text).toContain("config['training']['epochs']");
  });

  it("语言推断：kernelspec.language 缺省走 language_info.name；无 metadata → python", async () => {
    const viaLanguageInfo = await PARSER.parseBuffer(
      Buffer.from(notebook([{ cell_type: "code", source: "SELECT 1" }], { language_info: { name: "C++" } }), "utf8"),
      "a.ipynb",
    );
    expect((viaLanguageInfo.blocks[0] as ParsedCodeBlock).language).toBe("cpp");
    const none = await PARSER.parseBuffer(
      Buffer.from(notebook([{ cell_type: "code", source: "x = 1" }], undefined), "utf8"),
      "a.ipynb",
    );
    expect((none.blocks[0] as ParsedCodeBlock).language).toBe("python");
  });

  it("stream / execute_result 文本输出 → output 块（cellIndex + outputIndex）", async () => {
    const nb = notebook([
      {
        cell_type: "code",
        execution_count: 3,
        source: "print('MOTA = 82.4')",
        outputs: [
          { output_type: "stream", name: "stdout", text: ["MOTA = 82.4\n"] },
          {
            output_type: "execute_result",
            execution_count: 3,
            data: { "text/plain": "{'mota': 82.4}" },
          },
        ],
      },
    ]);
    const extraction = await PARSER.parseBuffer(Buffer.from(nb, "utf8"), "analysis.ipynb");
    const outputs = extraction.blocks.filter((b) => b.type === "output") as ParsedOutputBlock[];
    expect(outputs).toHaveLength(2);
    expect(outputs[0]!.outputKind).toBe("stream");
    expect(outputs[0]!.stream).toBe("stdout");
    expect(outputs[0]!.text).toContain("MOTA = 82.4");
    expect(outputs[0]!.provenance.cellIndex).toBe(0);
    expect(outputs[0]!.provenance.outputIndex).toBe(0);
    expect(outputs[1]!.outputKind).toBe("execute_result");
    expect(outputs[1]!.text).toContain("mota");
    expect(outputs[1]!.provenance.outputIndex).toBe(1);
  });

  it("error 输出 → traceback 文本（ANSI 剥离）", async () => {
    const nb = notebook([
      {
        cell_type: "code",
        source: "1/0",
        outputs: [
          {
            output_type: "error",
            ename: "ZeroDivisionError",
            evalue: "division by zero",
            traceback: [
              ESC + "[0;31m" + "-".repeat(40) + ESC + "[0m",
              "ZeroDivisionError: division by zero",
            ],
          },
        ],
      },
    ]);
    const extraction = await PARSER.parseBuffer(Buffer.from(nb, "utf8"), "analysis.ipynb");
    const error = extraction.blocks.find((b) => b.type === "output") as ParsedOutputBlock;
    expect(error.outputKind).toBe("error");
    expect(error.text).toContain("ZeroDivisionError: division by zero");
    expect(error.text).not.toContain("[0;31m");
  });

  it("图片输出 → figure 块 + 资产落盘 + 尺寸（figure + text/plain 并存）", async () => {
    const figuresDir = join(await mkdtemp(join(tmpdir(), "nb-fig-")), "");
    tempDirs.push(figuresDir);
    const png = makePng(64, 48);
    const nb = notebook([
      {
        cell_type: "code",
        source: "plt.plot(loss)",
        outputs: [
          {
            output_type: "display_data",
            data: { "image/png": png.toString("base64"), "text/plain": "<Figure size 640x480>" },
          },
        ],
      },
    ]);
    const extraction = await PARSER.parseBuffer(Buffer.from(nb, "utf8"), "analysis.ipynb", figuresDir);
    const figure = extraction.blocks.find((b) => b.type === "figure") as ParsedFigureBlock;
    expect(figure).toBeDefined();
    expect(figure.assetName).toBe("cell-0-output-0.png");
    expect(figure.width).toBe(64);
    expect(figure.height).toBe(48);
    expect(figure.provenance.cellIndex).toBe(0);
    expect(figure.provenance.outputIndex).toBe(0);
    const asset = await readFile(join(figuresDir, figure.assetName!));
    expect(asset.equals(png)).toBe(true);
    // text/plain 同时保留
    const plain = extraction.blocks.find((b) => b.type === "output") as ParsedOutputBlock;
    expect(plain?.text).toContain("Figure size");
    expect(extraction.quality).toBe("full");
  });

  it("超大 base64 图片输出 → 不解码不落盘；登记 visualOutputPresent=true", async () => {
    const figuresDir = join(await mkdtemp(join(tmpdir(), "nb-fig-")), "");
    tempDirs.push(figuresDir);
    // 声称超上限（base64 长度 > 8MB * 4/3），内容用占位——上限判断先于解码
    const hugeBase64 = "A".repeat(12 * 1024 * 1024);
    const nb = notebook([
      { cell_type: "code", source: "big", outputs: [{ output_type: "display_data", data: { "image/png": hugeBase64 } }] },
    ]);
    const extraction = await PARSER.parseBuffer(Buffer.from(nb, "utf8"), "analysis.ipynb", figuresDir);
    const figure = extraction.blocks.find((b) => b.type === "figure") as ParsedFigureBlock;
    expect(figure?.visualOutputPresent).toBe(true);
    expect(figure?.truncated).toBe(true);
    expect(figure.assetName).toBeUndefined();
    expect(extraction.quality).toBe("partial");
  });

  it("超长文本输出 → 截断 + truncated + note（不静默）", async () => {
    const nb = notebook([
      { cell_type: "code", source: "print(big)", outputs: [{ output_type: "stream", name: "stdout", text: "x".repeat(30_000) }] },
    ]);
    const extraction = await PARSER.parseBuffer(Buffer.from(nb, "utf8"), "analysis.ipynb");
    const output = extraction.blocks.find((b) => b.type === "output") as ParsedOutputBlock;
    expect(output.text.length).toBe(20_000);
    expect(output.truncated).toBe(true);
    expect(extraction.quality).toBe("partial");
  });

  it("HTML 输出：无 text/plain → 登记类型标记（不执行不猜测）", async () => {
    const nb = notebook([
      { cell_type: "code", source: "HTML('<script>bad()</script>')", outputs: [{ output_type: "display_data", data: { "text/html": "<b>hi</b>" } }] },
    ]);
    const extraction = await PARSER.parseBuffer(Buffer.from(nb, "utf8"), "analysis.ipynb");
    const output = extraction.blocks.find((b) => b.type === "output") as ParsedOutputBlock;
    expect(output.text).toContain("text/html");
    expect(output.text).not.toContain("<script>");
  });

  it("malformed ipynb → 明确失败（JSON / 结构缺失）", async () => {
    await expect(
      PARSER.parseBuffer(Buffer.from("{ not json", "utf8"), "bad.ipynb"),
    ).rejects.toThrow(DocumentParseFailedError);
    await expect(
      PARSER.parseBuffer(Buffer.from(JSON.stringify({ nope: 1 }), "utf8"), "bad.ipynb"),
    ).rejects.toThrow(/缺少 cells/);
    await expect(
      PARSER.parseBuffer(
        Buffer.from(JSON.stringify({ cells: [{ source: "x" }] }), "utf8"),
        "bad.ipynb",
      ),
    ).rejects.toThrow(/cell_type/);
    await expect(PARSER.parseBuffer(Buffer.from("", "utf8"), "empty.ipynb")).rejects.toThrow(
      /内容为空/,
    );
  });

  it("raw cell 按文本投影；空 cells 数组 → 明确失败", async () => {
    const raw = await PARSER.parseBuffer(
      Buffer.from(notebook([{ cell_type: "raw", source: "raw notes" }]), "utf8"),
      "a.ipynb",
    );
    expect((raw.blocks[0] as ParsedTextBlock).text).toBe("raw notes");
    await expect(
      PARSER.parseBuffer(Buffer.from(notebook([]), "utf8"), "empty.ipynb"),
    ).rejects.toThrow(/任何内容块/);
  });
});
