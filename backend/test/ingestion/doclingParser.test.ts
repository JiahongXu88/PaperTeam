/**
 * M10.1B DoclingAdapter 协议测试（fake python 脚本 + probeImport=json 解耦
 * docling 安装状态；与 paper/pdfToolchain.test.ts 同模式）：
 * - 正常输出映射（text/table/figure/formula/bbox/page/section → blocks）
 * - stdout 噪声前缀容忍
 * - 非法 JSON / 缺字段 → INGESTION_PARSE_FAILED
 * - dependency_missing → INGESTION_PARSER_UNAVAILABLE
 * - 进程异常退出（无 stdout）→ INGESTION_PARSE_FAILED
 * - 解释器缺失 → INGESTION_PARSER_UNAVAILABLE（不抛裸 ENOENT）
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DoclingParser } from "../../src/ingestion/DoclingParser.js";

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "paperteam-docling-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function pythonCommand(): string {
  const candidates = ["python", "python3"];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["-c", "print(1)"], { stdio: "ignore", timeout: 10_000 });
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("测试机无可用 Python 解释器");
}

/** 协议样例（docling 工具的真实输出形状） */
const OK_PAYLOAD = {
  ok: true,
  parser: { id: "docling", version: "2.x-test" },
  pdfPath: "whatever.pdf",
  pageCount: 3,
  blocks: [
    { type: "text", textKind: "paragraph", text: "Attention is all you need.", page: 1, bbox: [10, 20, 90, 30], ref: "/texts/1" },
    { type: "text", textKind: "section_header", text: "Introduction", page: 1, ref: "/texts/2" },
    { type: "text", textKind: "paragraph", text: "After the header.", page: 1, section: "Introduction" },
    {
      type: "table",
      page: 2,
      section: "Experiments",
      caption: "Table 1: results",
      headers: ["Method", "MOTA"],
      rows: [["Ours", "82.4"]],
      rowCount: 1,
      columnCount: 2,
      ref: "/tables/0",
    },
    { type: "figure", page: 3, caption: "Figure 1", imageFile: "fig-001.png", bbox: [1, 2, 3, 4] },
    { type: "formula", page: 2, latex: "L = 1" },
    { type: "unknown_type", text: "应被跳过" },
    { type: "text", text: "   " },
  ],
  notes: [],
};

const scripts = {
  ok: [
    "import json, sys",
    "sys.stdout.write('docling fallback warnings on stdout\\n')",
    // JSON 字面量经 json.loads 载入（JSON 的 true/false/null 不是 Python 字面量）
    `payload = json.loads(r'''${JSON.stringify(OK_PAYLOAD)}''')`,
    "print(json.dumps(payload, ensure_ascii=False))",
  ].join("\n"),
  dependencyMissing: [
    "import json",
    "print(json.dumps({'ok': False, 'code': 'dependency_missing', 'error': 'docling 未安装（请运行: pip install docling）'}))",
  ].join("\n"),
  badJson: "print('this is definitely not json')",
  crashNoStdout: "import sys; sys.stderr.write('boom\\n'); sys.exit(1)",
};

function makeParser(script: string): DoclingParser {
  return new DoclingParser({
    pythonCommand: pythonCommand(),
    probeImport: "json", // 探测只要求 python 可执行——解耦 docling 安装状态
    scriptPath: script,
  });
}

describe("M10.1B DoclingParser 协议", () => {
  it("正常输出 → DocumentExtraction（块映射 / bbox / section / 噪声行忽略）", { timeout: 30_000 }, async () => {
    const scriptPath = join(tmp, "ok_stub.py");
    await writeFile(scriptPath, scripts.ok, "utf8");
    const logs: string[] = [];
    const parser = makeParser(scriptPath);
    const extraction = await parser.parseFile(join(tmp, "paper.pdf"));
    expect(extraction.parser).toEqual({ id: "docling", version: "2.x-test" });
    expect(extraction.mode).toBe("structured");
    expect(extraction.pageCount).toBe(3);
    // unknown_type 与空白文本块被跳过；其余 6 块按序映射
    expect(extraction.blocks).toHaveLength(6);
    const text = extraction.blocks[0]!;
    expect(text).toMatchObject({ type: "text", textKind: "paragraph", text: "Attention is all you need." });
    expect(text.provenance.page).toBe(1);
    expect(text.provenance.bbox).toEqual({ x0: 10, y0: 20, x1: 90, y1: 30 });
    expect(text.provenance.parserBlockId).toBe("/texts/1");
    const afterHeader = extraction.blocks[2]!;
    expect(afterHeader.provenance.section).toBe("Introduction");
    const table = extraction.blocks[3]!;
    if (table.type !== "table") {
      throw new Error("expected table block");
    }
    expect(table.headers).toEqual(["Method", "MOTA"]);
    expect(table.rows).toEqual([["Ours", "82.4"]]);
    expect(table.caption).toBe("Table 1: results");
    const figure = extraction.blocks[4]!;
    expect(figure.type === "figure" && figure.assetName).toBe("fig-001.png");
    const formula = extraction.blocks[5]!;
    expect(formula.type === "formula" && formula.latex).toBe("L = 1");
    void logs;
    void parser;
  });

  it("dependency_missing → INGESTION_PARSER_UNAVAILABLE（503）", { timeout: 30_000 }, async () => {
    const scriptPath = join(tmp, "dep_missing.py");
    await writeFile(scriptPath, scripts.dependencyMissing, "utf8");
    const parser = makeParser(scriptPath);
    await expect(parser.parseFile(join(tmp, "x.pdf"))).rejects.toMatchObject({
      code: "INGESTION_PARSER_UNAVAILABLE",
    });
  });

  it("非法 JSON → INGESTION_PARSE_FAILED（协议错误）", { timeout: 30_000 }, async () => {
    const scriptPath = join(tmp, "bad_json.py");
    await writeFile(scriptPath, scripts.badJson, "utf8");
    const parser = makeParser(scriptPath);
    await expect(parser.parseFile(join(tmp, "x.pdf"))).rejects.toMatchObject({
      code: "INGESTION_PARSE_FAILED",
    });
  });

  it("进程异常退出（无 stdout）→ INGESTION_PARSE_FAILED", { timeout: 30_000 }, async () => {
    const scriptPath = join(tmp, "crash.py");
    await writeFile(scriptPath, scripts.crashNoStdout, "utf8");
    const parser = makeParser(scriptPath);
    await expect(parser.parseFile(join(tmp, "x.pdf"))).rejects.toMatchObject({
      code: "INGESTION_PARSE_FAILED",
    });
  });

  it("解释器不存在 → INGESTION_PARSER_UNAVAILABLE（不是 spawn ENOENT）", { timeout: 30_000 }, async () => {
    const scriptPath = join(tmp, "ok_stub.py");
    const parser = new DoclingParser({
      pythonCommand: "paperteam-definitely-missing-python",
      probeImport: "json",
      scriptPath,
    });
    const status = await parser.checkAvailability();
    expect(status.available).toBe(false);
    await expect(parser.parseFile(join(tmp, "x.pdf"))).rejects.toMatchObject({
      code: "INGESTION_PARSER_UNAVAILABLE",
    });
  });
});
