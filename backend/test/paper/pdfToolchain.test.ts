/**
 * PDF 解析工具链加固测试：
 * - stdout 协议容忍非 JSON 前缀（MuPDF C 层告警直接写 fd 1 的真实场景）
 * - 解释器缺失 / pymupdf 缺失 → PDF_PARSER_UNAVAILABLE（503 + 安装指引），不是 spawn ENOENT
 * - 中文 PDF（pymupdf 现场生成）：标题 / 摘要 / 参考文献章节提取
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PyMuPdfParser } from "../../src/paper/PdfParser.js";
import { PdfToolchain } from "../../src/paper/pdfToolchain.js";
import { assemblePaper } from "../../src/paper/sectionChunking.js";

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "paperteam-pdf-toolchain-"));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** 模拟解析器：先往 stdout 写入 MuPDF 风格告警，再输出协议 JSON */
const NOISY_SCRIPT = [
  "import json, sys",
  "sys.stdout.write(\"MuPDF error: syntax error: unknown keyword: 'Qq'\\n\")",
  "sys.stdout.write('MuPDF error: encountered syntax errors; page may not be correct\\n')",
  "payload = {'ok': True, 'parser': {'id': 'fake', 'version': '0'}, 'pageCount': 2, 'title': '噪声测试',",
  "  'abstract': '', 'toc': [], 'blocks': [{'page': 1, 'text': '正文 ' * 40}, {'page': 2, 'text': 'References'}, {'page': 2, 'text': '[1] A. 作者. 标题. 2020.'}],",
  "  'totalChars': 100, 'notes': []}",
  "print(json.dumps(payload, ensure_ascii=False))",
].join("\n");

describe("PyMuPdfParser 协议容错", () => {
  it("stdout 含非 JSON 前缀（MuPDF 告警）时仍取最后一行 JSON 解析成功", { timeout: 30_000 }, async () => {
    const scriptPath = join(tmp, "noisy_parser.py");
    await writeFile(scriptPath, NOISY_SCRIPT, "utf8");
    const logs: string[] = [];
    const parser = new PyMuPdfParser({ scriptPath, log: (message) => logs.push(message) });
    const extraction = await parser.parseFile(join(tmp, "whatever.pdf"));
    expect(extraction.title).toBe("噪声测试");
    expect(extraction.blocks).toHaveLength(3);
    expect(logs.some((line) => line.includes("非协议输出已忽略") && line.includes("Qq"))).toBe(true);
  });

  it("解释器不存在 → PDF_PARSER_UNAVAILABLE（503）且带安装指引；checkAvailability 不抛", async () => {
    const parser = new PyMuPdfParser({ pythonCommand: "paperteam-definitely-missing-python" });
    const status = await parser.checkAvailability();
    expect(status.available).toBe(false);
    if (!status.available) {
      expect(status.reason).toBe("python_missing");
      expect(status.detail).toContain("pip install pymupdf");
    }
    await expect(parser.parseFile(join(tmp, "x.pdf"))).rejects.toMatchObject({
      code: "PDF_PARSER_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("工具脚本自报 dependency_missing → PDF_PARSER_UNAVAILABLE；其它失败 → PDF_PARSE_FAILED（422）", { timeout: 30_000 }, async () => {
    const missingDep = join(tmp, "missing_dep.py");
    await writeFile(
      missingDep,
      "import json; print(json.dumps({'ok': False, 'code': 'dependency_missing', 'error': 'pymupdf 未安装'})); raise SystemExit(3)",
      "utf8",
    );
    await expect(new PyMuPdfParser({ scriptPath: missingDep }).parseFile(join(tmp, "x.pdf"))).rejects.toMatchObject({
      code: "PDF_PARSER_UNAVAILABLE",
    });

    const openFailed = join(tmp, "open_failed.py");
    await writeFile(
      openFailed,
      "import json; print(json.dumps({'ok': False, 'code': 'open_failed', 'error': '无法打开 PDF'})); raise SystemExit(4)",
      "utf8",
    );
    await expect(new PyMuPdfParser({ scriptPath: openFailed }).parseFile(join(tmp, "x.pdf"))).rejects.toMatchObject({
      code: "PDF_PARSE_FAILED",
      httpStatus: 422,
    });
  });

  it("PdfToolchain：失败结果短期缓存，探测只 spawn 一次", async () => {
    const logs: string[] = [];
    const toolchain = new PdfToolchain({ pythonCommand: "paperteam-definitely-missing-python", log: (m) => logs.push(m) });
    const [a, b] = await Promise.all([toolchain.resolve(), toolchain.resolve()]);
    expect(a.available).toBe(false);
    expect(b).toEqual(a);
    expect(logs.filter((line) => line.includes("不可用")).length).toBe(1);
  });
});

describe("中文 PDF 提取（pymupdf 现场生成，不依赖仓库外文件）", () => {
  it("标题 / 摘要 / 参考文献章节可识别", { timeout: 60_000 }, async () => {
    const pdfPath = join(tmp, "zh-paper.pdf");
    const generator = [
      "import pymupdf, sys",
      "doc = pymupdf.open()",
      "page = doc.new_page()",
      "font = pymupdf.Font('cjk')",
      "tw = pymupdf.TextWriter(page.rect)",
      "tw.append((72, 90), '运动残差门控记忆的多目标跟踪方法', font=font, fontsize=20)",
      "tw.append((72, 130), '摘要：为提升复杂场景下多目标跟踪的身份一致性，本文提出一种融合运动残差门控记忆与轨迹稳定约束的方法，在公开数据集上验证了有效性。', font=font, fontsize=10)",
      "tw.append((72, 170), '1 引言', font=font, fontsize=14)",
      "tw.append((72, 190), '多目标跟踪是自动驾驶感知的核心任务之一，近年来基于检测的跟踪范式取得了显著进展[1]。', font=font, fontsize=10)",
      "tw.write_text(page)",
      "page2 = doc.new_page()",
      "tw2 = pymupdf.TextWriter(page2.rect)",
      "tw2.append((72, 90), '参考文献', font=font, fontsize=14)",
      "tw2.append((72, 120), '[1] 张三, 李四. 基于检测的多目标跟踪综述[J]. 计算机学报, 2021, 44(3): 1-20.', font=font, fontsize=10)",
      "tw2.append((72, 140), '[2] Wang X, et al. Tracking objects as points. ECCV, 2020.', font=font, fontsize=10)",
      "tw2.write_text(page2)",
      "doc.set_metadata({'title': ''})",
      "doc.save(sys.argv[1])",
    ].join("\n");
    const generatorPath = join(tmp, "gen_zh.py");
    await writeFile(generatorPath, generator, "utf8");
    const toolchain = await new PdfToolchain().resolve();
    if (!toolchain.available) {
      throw new Error(`本机缺少 PDF 解析工具链：${toolchain.detail}`);
    }
    execFileSync(toolchain.command, [...toolchain.args, generatorPath, pdfPath], {
      env: { ...process.env, PYTHONIOENCODING: "utf8" },
    });

    const extraction = await new PyMuPdfParser().parseFile(pdfPath);
    expect(extraction.pageCount).toBe(2);
    expect(extraction.title).toContain("多目标跟踪");
    expect(extraction.abstract).toContain("身份一致性");

    const assembled = assemblePaper(extraction);
    expect(assembled.chunks.length).toBeGreaterThan(0);
    const references = assembled.sections.find((section) => section.sectionId === assembled.referencesSectionId);
    expect(references?.title).toContain("参考文献");
  });
});
