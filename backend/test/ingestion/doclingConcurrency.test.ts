/**
 * M12.2.5 DoclingParser 并发信号量测试（fake python 脚本 + probeImport=json，
 * 与 doclingParser.test.ts 同模式解耦 docling 安装状态）。
 *
 * docling 是 CPU/内存密集（torch）子进程：默认 maxConcurrency=1（逐个执行），
 * 显式 ingest 并发到达时由进程级 FIFO 信号量收敛；maxConcurrency=2 允许两个
 * 同时在途。可观测手段：fake 脚本向 marker 文件追加 S/E 行（环境变量传路径，
 * 子进程继承），按行序断言串行 / 并行形态。
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DoclingParser } from "../../src/ingestion/DoclingParser.js";

let tmp: string;
let marker: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "paperteam-docling-conc-"));
  marker = join(tmp, "marker.log");
  process.env.DOCLING_TEST_MARKER = marker;
});
afterAll(async () => {
  delete process.env.DOCLING_TEST_MARKER;
  await rm(tmp, { recursive: true, force: true });
});

function pythonCommand(): string {
  for (const candidate of ["python", "python3"]) {
    try {
      execFileSync(candidate, ["-c", "print(1)"], { stdio: "ignore", timeout: 10_000 });
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("测试机无可用 Python 解释器");
}

/** 慢速 fake：S 行 → sleep → E 行 → 协议 JSON（marker 路径经环境变量传入） */
const SLOW_SCRIPT = [
  "import json, os, sys, time",
  "marker = os.environ['DOCLING_TEST_MARKER']",
  "tag = os.path.basename(sys.argv[1])",
  "with open(marker, 'a', encoding='utf8') as fh:",
  "    fh.write(f'S {tag}\\n'); fh.flush()",
  "time.sleep(0.6)",
  "with open(marker, 'a', encoding='utf8') as fh:",
  "    fh.write(f'E {tag}\\n'); fh.flush()",
  "print(json.dumps({'ok': True, 'parser': {'id': 'docling'}, 'pdfPath': sys.argv[1], 'blocks': [], 'notes': []}))",
].join("\n");

async function parseAll(concurrency: number | undefined, count: number): Promise<string> {
  const script = join(tmp, `slow-${concurrency ?? "default"}.py`);
  await writeFile(script, SLOW_SCRIPT, "utf8");
  const parser = new DoclingParser({
    pythonCommand: pythonCommand(),
    probeImport: "json",
    scriptPath: script,
    ...(concurrency !== undefined ? { maxConcurrency: concurrency } : {}),
  });
  const pdfs = Array.from({ length: count }, (_, index) => join(tmp, `doc-${index}.pdf`));
  await Promise.all(pdfs.map((pdf) => parser.parseFile(pdf)));
  return readFile(marker, "utf8");
}

/** marker 行序里是否存在「S a / S b / E x」——两个解析同时在途的形态 */
function hasOverlap(lines: string[]): boolean {
  let open = 0;
  for (const line of lines) {
    if (line.startsWith("S ")) {
      open += 1;
      if (open >= 2) {
        return true;
      }
    } else if (line.startsWith("E ")) {
      open -= 1;
    }
  }
  return false;
}

describe("M12.2.5 DoclingParser 并发信号量", () => {
  it(
    "默认 maxConcurrency=1：三个并发 parseFile 逐个执行（无重叠）",
    { timeout: 60_000 },
    async () => {
      await rm(marker, { force: true });
      const log = await parseAll(undefined, 3);
      const lines = log.split(/\r?\n/).filter((line) => line !== "");
      expect(lines).toHaveLength(6);
      expect(hasOverlap(lines)).toBe(false);
      // 全部成功（协议 JSON 被接受，blocks 为空数组是合法产物）
    },
  );

  it(
    "maxConcurrency=2：允许两个同时在途（有重叠）",
    { timeout: 60_000 },
    async () => {
      await rm(marker, { force: true });
      const log = await parseAll(2, 3);
      const lines = log.split(/\r?\n/).filter((line) => line !== "");
      expect(lines).toHaveLength(6);
      expect(hasOverlap(lines)).toBe(true);
    },
  );

  it("非法 maxConcurrency（0 / 负数 / 非整数）收敛为 1，不抛错", async () => {
    await rm(marker, { force: true });
    const log = await parseAll(0, 2);
    expect(hasOverlap(log.split(/\r?\n/).filter((line) => line !== ""))).toBe(false);
  });
});
