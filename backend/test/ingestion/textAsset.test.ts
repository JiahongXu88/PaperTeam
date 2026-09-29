/**
 * M10.1.1 文本资产 parser 单测：TXT / Markdown / LaTeX / 源码。
 * 覆盖：段落 + 行 provenance、MD 标题 → section、LaTeX 分节命令、
 * 代码行窗口（不截断单行）、二进制伪装拒绝、空文件、CRLF 归一。
 */

import { describe, expect, it } from "vitest";

import { DocumentParseFailedError } from "../../src/errors.js";
import { TextAssetParser } from "../../src/ingestion/textAsset.js";
import type { ParsedCodeBlock, ParsedTextBlock } from "../../src/ingestion/types.js";

const TEXT = new TextAssetParser("text");
const MARKDOWN = new TextAssetParser("markdown");
const LATEX = new TextAssetParser("latex");
const CODE = new TextAssetParser("code");

function textBlocksOf(buffer: Buffer, fileName: string): ParsedTextBlock[] {
  // parseBuffer 是同步路径（readFile 在 parseFile 内）；直接调用
  const extraction = TEXT.parseBuffer(buffer, fileName);
  return extraction.blocks.filter((b): b is ParsedTextBlock => b.type === "text");
}

describe("M10.1.1 TextAssetParser（txt / markdown / latex / code）", () => {
  it("TXT：空行分段，块带 lineStart/lineEnd 物理行 provenance", () => {
    const source = "第一段第一行\n第一段第二行\n\n第二段内容\n";
    const blocks = textBlocksOf(Buffer.from(source, "utf8"), "notes.txt");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.text).toBe("第一段第一行\n第一段第二行");
    expect(blocks[0]!.provenance.lineStart).toBe(1);
    expect(blocks[0]!.provenance.lineEnd).toBe(2);
    expect(blocks[0]!.provenance.section).toBeUndefined();
    expect(blocks[1]!.text).toBe("第二段内容");
    expect(blocks[1]!.provenance.lineStart).toBe(4);
    expect(blocks[1]!.provenance.lineEnd).toBe(4);
  });

  it("TXT：CRLF 归一为 LF（行号不受影响）", () => {
    const blocks = textBlocksOf(Buffer.from("alpha\r\nbeta\r\n\r\ngamma", "utf8"), "notes.txt");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.text).toBe("alpha\nbeta");
    expect(blocks[0]!.provenance.lineStart).toBe(1);
    expect(blocks[0]!.provenance.lineEnd).toBe(2);
    expect(blocks[1]!.provenance.lineStart).toBe(4);
  });

  it("TXT：列表段落标记 list_item", () => {
    const blocks = textBlocksOf(Buffer.from("- item one\n- item two\n\n普通段落", "utf8"), "notes.txt");
    expect(blocks[0]!.textKind).toBe("list_item");
    expect(blocks[1]!.textKind).toBeUndefined();
  });

  it("Markdown：ATX 标题 → section_header 块 + 后续块 section 上下文", () => {
    const source = "# MOT17 Tracking\n\nWe evaluate on MOT17.\n\n## Setup\n\nBatch size 8.\n";
    const extraction = MARKDOWN.parseBuffer(Buffer.from(source, "utf8"), "README.md");
    const blocks = extraction.blocks as ParsedTextBlock[];
    const header = blocks.find((b) => b.textKind === "section_header");
    expect(header?.text).toBe("MOT17 Tracking");
    expect(header?.provenance.lineStart).toBe(1);
    const body1 = blocks.find((b) => b.text.includes("evaluate"));
    expect(body1?.provenance.section).toBe("MOT17 Tracking");
    const body2 = blocks.find((b) => b.text.includes("Batch size"));
    expect(body2?.provenance.section).toBe("Setup");
    expect(extraction.parser.id).toBe("markdown");
    expect(extraction.quality).toBe("full");
  });

  it("LaTeX：\\section / \\subsection 命令行 → section（源文本原样保留）", () => {
    const source = [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section{Introduction}",
      "Multiple object tracking is important.",
      "\\subsection{Dataset}",
      "We use MOT17.",
      "\\end{document}",
      "",
    ].join("\n");
    const extraction = LATEX.parseBuffer(Buffer.from(source, "utf8"), "paper.tex");
    const blocks = extraction.blocks as ParsedTextBlock[];
    const intro = blocks.find((b) => b.text.includes("Multiple object tracking"));
    expect(intro?.provenance.section).toBe("Introduction");
    const dataset = blocks.find((b) => b.text.includes("We use MOT17"));
    expect(dataset?.provenance.section).toBe("Dataset");
    // 命令行本身保留为源文本（不删命令、不展开宏）
    expect(blocks.some((b) => b.text.includes("\\documentclass{article}"))).toBe(true);
    // intro 段块在第 4 行
    expect(intro?.provenance.lineStart).toBe(4);
  });

  it("源码：language 由扩展名映射；行窗口块带行范围；单行永不截断", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 120; i += 1) {
      lines.push(`# line ${i} ${"x".repeat(20)}`);
    }
    const extraction = CODE.parseBuffer(Buffer.from(lines.join("\n"), "utf8"), "train.py");
    const blocks = extraction.blocks as ParsedCodeBlock[];
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks[0]!.type).toBe("code");
    expect(blocks[0]!.language).toBe("python");
    expect(blocks[0]!.provenance.lineStart).toBe(1);
    // 行连续覆盖：上一块 lineEnd + 1 = 下一块 lineStart
    for (let i = 1; i < blocks.length; i += 1) {
      expect(blocks[i]!.provenance.lineStart).toBe(blocks[i - 1]!.provenance.lineEnd! + 1);
    }
    expect(blocks[blocks.length - 1]!.provenance.lineEnd).toBe(120);
    // 单行完整性：每块按行重组后与原行序列一致
    const reassembled = blocks.map((b) => b.text.split("\n")).flat();
    expect(reassembled).toEqual(lines);
  });

  it("源码：cpp / ts / sh 语言映射", () => {
    for (const [name, language] of [
      ["helper.cpp", "cpp"],
      ["hook.hpp", "cpp"],
      ["main.c", "c"],
      ["app.ts", "typescript"],
      ["widget.tsx", "typescript"],
      ["run.sh", "shell"],
      ["deploy.ps1", "powershell"],
      ["main.rs", "rust"],
      ["main.go", "go"],
      ["Main.java", "java"],
    ] as const) {
      const extraction = CODE.parseBuffer(Buffer.from("int x = 1;\n", "utf8"), name);
      expect((extraction.blocks[0] as ParsedCodeBlock).language).toBe(language);
    }
  });

  it("二进制伪装成文本（NUL）→ 明确失败", () => {
    const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0xff, 0xfe]);
    expect(() => TEXT.parseBuffer(binary, "fake.txt")).toThrow(DocumentParseFailedError);
    expect(() => TEXT.parseBuffer(binary, "fake.txt")).toThrow(/NUL/);
  });

  it("非 UTF-8（大量不可解码字节）→ 明确失败", () => {
    // GBK 编码的中文（UTF-8 解码产生大量 U+FFFD）
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0xd5, 0xfd, 0xce, 0xc4, 0xb1, 0xbe]);
    expect(() => TEXT.parseBuffer(gbk, "gbk.txt")).toThrow(/UTF-8/);
  });

  it("空文件 / 纯空白 → 明确失败（不静默成功）", () => {
    expect(() => TEXT.parseBuffer(Buffer.from("", "utf8"), "empty.txt")).toThrow(/内容为空/);
    expect(() => TEXT.parseBuffer(Buffer.from("\n\n  \n", "utf8"), "blank.txt")).toThrow(/内容为空/);
    expect(() => MARKDOWN.parseBuffer(Buffer.from("", "utf8"), "empty.md")).toThrow(/内容为空/);
  });

  it("超大文本触顶 → 截断进 notes、quality=partial（不静默）", () => {
    const huge = "alpha beta\n".repeat(300_000); // ~3.3M chars > 2M 上限
    const extraction = TEXT.parseBuffer(Buffer.from(huge, "utf8"), "huge.txt");
    expect(extraction.quality).toBe("partial");
    expect(extraction.notes.some((note) => note.includes("已截断"))).toBe(true);
  });
});
