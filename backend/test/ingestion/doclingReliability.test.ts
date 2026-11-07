/**
 * M17.2.2 DoclingParser 可靠性测试（fake python 脚本 + probeImport=json，与
 * doclingParser.test.ts 同模式解耦 docling 安装状态）：
 * - 分层超时：有真实进度的长解析不被误杀；无进展 → 有界失败；持续进度但超总上限 → 有界失败；
 * - 三类终止都 kill 子进程（pid 探活），promise 在子进程退出后才 settle；
 * - 取消：在跑 / 排队中取消都以 signal.reason 拒绝，不影响其他解析；
 * - 模型预检：命中 → 离线解析（HF_HUB_OFFLINE=1）且并发只预检一次；缺失 → 单独 warmup；
 *   warmup 失败 → INGESTION_PARSER_UNAVAILABLE（依赖问题，非内容问题），文档解析不执行，失败不缓存；
 *   解析期 model_unavailable → 不可用错误并重新预检；旧脚本不懂 --preflight → 按旧行为联网解析。
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DoclingParser, defaultDoclingScriptPath, type DoclingParserOptions } from "../../src/ingestion/DoclingParser.js";
import type { DocumentParseProgress } from "../../src/ingestion/types.js";

let tmp: string;
let marker: string;
let counter = 0;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "paperteam-docling-rel-"));
});
afterAll(async () => {
  delete process.env.DOCLING_TEST_MARKER;
  await rm(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  counter += 1;
  marker = join(tmp, `marker-${counter}.log`);
  process.env.DOCLING_TEST_MARKER = marker;
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

/**
 * fake 解析脚本骨架：marker 记录调用（模式 + pid + HF_HUB_OFFLINE）；body 决定行为。
 * progress(phase) 与生产脚本同协议（stderr `PAPERTEAM_PROGRESS {json}`）。
 */
function fakeScript(body: string, modes: { preflight?: string; warmup?: string } = {}): string {
  return [
    "import json, os, sys, time",
    "marker = os.environ['DOCLING_TEST_MARKER']",
    "def mark(kind):",
    "    with open(marker, 'a', encoding='utf8') as fh:",
    "        fh.write(f\"{kind} {os.getpid()} {os.environ.get('HF_HUB_OFFLINE', '-')}\\n\")",
    "def progress(phase, **kw):",
    "    sys.stderr.write('\\nPAPERTEAM_PROGRESS ' + json.dumps({'phase': phase, **kw}) + '\\n'); sys.stderr.flush()",
    "def ok(notes=None):",
    "    print(json.dumps({'ok': True, 'parser': {'id': 'docling'}, 'pageCount': 2, 'blocks': [{'type': 'text', 'text': 'Synthetic body text.', 'page': 1}], 'notes': notes or []}))",
    "args = sys.argv[1:]",
    "if '--preflight' in args:",
    "    mark('PREFLIGHT')",
    ...(modes.preflight ?? "    print(json.dumps({'ok': True, 'code': 'models_ready', 'models': [{'repo': 'fake/layout', 'cached': True}]}))")
      .split("\n"),
    "    sys.exit(0)",
    "if '--warmup' in args:",
    "    mark('WARMUP')",
    ...(modes.warmup ?? "    print(json.dumps({'ok': True, 'code': 'models_ready', 'models': [{'repo': 'fake/layout', 'cached': True}]}))")
      .split("\n"),
    "    sys.exit(0)",
    "mark('PARSE')",
    body,
  ].join("\n");
}

async function makeParser(script: string, options: Partial<DoclingParserOptions> = {}): Promise<DoclingParser> {
  const scriptPath = join(tmp, `fake-${counter}-${Math.random().toString(36).slice(2)}.py`);
  await writeFile(scriptPath, script, "utf8");
  return new DoclingParser({ pythonCommand: pythonCommand(), probeImport: "json", scriptPath, ...options });
}

async function markerLines(): Promise<string[]> {
  try {
    return (await readFile(marker, "utf8")).split(/\r?\n/).filter((line) => line !== "");
  } catch {
    return [];
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function parsePids(): Promise<number[]> {
  return (await markerLines()).filter((line) => line.startsWith("PARSE ")).map((line) => Number(line.split(" ")[1]));
}

const pdf = () => join(tmp, "synthetic.pdf");

describe("M17.2.2 DoclingParser 分层超时与进程回收", () => {
  it("持续报告进度的解析超过无进展上限也能完成，进度经 onProgress 上报", { timeout: 30_000 }, async () => {
    const parser = await makeParser(
      fakeScript(["for i in range(8):", "    time.sleep(0.25)", "    progress('pipeline', stage='layout', pages=[i + 1])", "ok()"].join("\n")),
      { idleTimeoutMs: 900, timeoutMs: 20_000 },
    );
    const events: DocumentParseProgress[] = [];
    const extraction = await parser.parseFile(pdf(), { onProgress: (event) => events.push(event) });
    expect(extraction.blocks).toHaveLength(1);
    expect(events.length).toBeGreaterThanOrEqual(8);
    expect(events.every((event) => event.state === "parsing")).toBe(true);
    expect(events.at(-1)?.detail).toBe("pipeline layout p8");
  });

  it("无进展 → 有界失败（INGESTION_PARSE_FAILED，消息含最后进度），子进程被终止", { timeout: 30_000 }, async () => {
    const parser = await makeParser(
      fakeScript(["progress('pipeline', stage='table', pages=[3])", "time.sleep(60)", "ok()"].join("\n")),
      { idleTimeoutMs: 1_000, timeoutMs: 20_000 },
    );
    const startedAt = Date.now();
    const failure = await parser.parseFile(pdf()).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "INGESTION_PARSE_FAILED" });
    expect((failure as Error).message).toContain("无进展");
    expect((failure as Error).message).toContain("pipeline table p3");
    expect((failure as Error).message).not.toContain("模型下载");
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    const [pid] = await parsePids();
    expect(pid).toBeGreaterThan(0);
    expect(isAlive(pid!)).toBe(false);
  });

  it("持续进度但超过总时长上限 → 有界失败，子进程被终止", { timeout: 30_000 }, async () => {
    const parser = await makeParser(
      fakeScript(["while True:", "    progress('pipeline', stage='layout', pages=[1])", "    time.sleep(0.2)"].join("\n")),
      { idleTimeoutMs: 1_000, timeoutMs: 2_000 },
    );
    const failure = await parser.parseFile(pdf()).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "INGESTION_PARSE_FAILED" });
    expect((failure as Error).message).toContain("总时长超过上限");
    const [pid] = await parsePids();
    expect(isAlive(pid!)).toBe(false);
  });

  it("取消：在跑的解析以 signal.reason 拒绝并终止子进程；排队中的解析取消后立即退出且不 spawn", { timeout: 30_000 }, async () => {
    const parser = await makeParser(
      fakeScript(["progress('loading')", "time.sleep(1.2)", "ok()"].join("\n")),
      { idleTimeoutMs: 10_000, timeoutMs: 20_000 },
    );
    const first = parser.parseFile(pdf());
    const queuedController = new AbortController();
    const queued = parser.parseFile(join(tmp, "queued.pdf"), { signal: queuedController.signal });
    queuedController.abort(new Error("queued-cancelled"));
    await expect(queued).rejects.toThrow("queued-cancelled");
    await expect(first).resolves.toMatchObject({ blocks: [{ type: "text" }] });
    expect(await parsePids()).toHaveLength(1);

    const runningController = new AbortController();
    const running = parser.parseFile(pdf(), { signal: runningController.signal });
    setTimeout(() => runningController.abort(new Error("stage-cancelled")), 400);
    await expect(running).rejects.toThrow("stage-cancelled");
    const pids = await parsePids();
    expect(pids).toHaveLength(2);
    expect(isAlive(pids[1]!)).toBe(false);
  });
});

describe("M17.2.2 DoclingParser 模型资源预检与 warmup", () => {
  const okBody = ["progress('converting')", "ok([os.environ.get('HF_HUB_OFFLINE', '-')])"].join("\n");

  it("缓存命中 → 离线解析；并发解析只预检一次", { timeout: 30_000 }, async () => {
    const parser = await makeParser(fakeScript(okBody), { modelPreflight: true, maxConcurrency: 2 });
    const results = await Promise.all([parser.parseFile(pdf()), parser.parseFile(pdf()), parser.parseFile(pdf())]);
    const lines = await markerLines();
    expect(lines.filter((line) => line.startsWith("PREFLIGHT ")).length).toBe(1);
    expect(lines.filter((line) => line.startsWith("WARMUP ")).length).toBe(0);
    expect(lines.filter((line) => line.startsWith("PARSE ")).every((line) => line.endsWith(" 1"))).toBe(true);
    expect(parser.modelResourceState).toBe("ready");
    expect(results.map((result) => result.notes[0])).toEqual(["1", "1", "1"]);
  });

  it("缓存缺失 → 单独 warmup（waiting_for_dependency 心跳）后离线解析", { timeout: 30_000 }, async () => {
    const parser = await makeParser(
      fakeScript(okBody, {
        preflight: "    print(json.dumps({'ok': True, 'code': 'models_missing', 'models': [{'repo': 'fake/layout', 'cached': False}]}))",
        warmup: [
          "    progress('warmup', model='fake/layout')",
          "    print(json.dumps({'ok': True, 'code': 'models_ready', 'models': [{'repo': 'fake/layout', 'cached': True}]}))",
        ].join("\n"),
      }),
      { modelPreflight: true },
    );
    const events: DocumentParseProgress[] = [];
    await parser.parseFile(pdf(), { onProgress: (event) => events.push(event) });
    const kinds = (await markerLines()).map((line) => line.split(" ")[0]);
    expect(kinds).toEqual(["PREFLIGHT", "WARMUP", "PARSE"]);
    expect((await markerLines())[2]!.endsWith(" 1")).toBe(true);
    expect(events.some((event) => event.state === "waiting_for_dependency" && event.detail?.includes("fake/layout"))).toBe(true);
    expect(events.some((event) => event.state === "parsing")).toBe(true);
  });

  it("warmup 失败 → INGESTION_PARSER_UNAVAILABLE（依赖问题），不执行文档解析，失败不缓存", { timeout: 30_000 }, async () => {
    const parser = await makeParser(
      fakeScript(okBody, {
        preflight: "    print(json.dumps({'ok': True, 'code': 'models_missing', 'models': [{'repo': 'fake/layout', 'cached': False}]}))",
        warmup: "    print(json.dumps({'ok': False, 'code': 'model_download_failed', 'error': 'fake/layout 下载失败：ConnectError'}))",
      }),
      { modelPreflight: true },
    );
    const failure = await parser.parseFile(pdf()).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "INGESTION_PARSER_UNAVAILABLE" });
    expect((failure as Error).message).toContain("不是文档内容问题");
    expect((failure as Error).message).toContain("ConnectError");
    await parser.parseFile(pdf()).catch(() => undefined);
    const kinds = (await markerLines()).map((line) => line.split(" ")[0]);
    expect(kinds).toEqual(["PREFLIGHT", "WARMUP", "PREFLIGHT", "WARMUP"]);
  });

  it("warmup 超过独立上限 → 不可用错误（不消耗文档解析预算）", { timeout: 30_000 }, async () => {
    const parser = await makeParser(
      fakeScript(okBody, {
        preflight: "    print(json.dumps({'ok': True, 'code': 'models_missing', 'models': []}))",
        warmup: "    time.sleep(60)",
      }),
      { modelPreflight: true, warmupTimeoutMs: 1_000 },
    );
    const failure = await parser.parseFile(pdf()).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "INGESTION_PARSER_UNAVAILABLE" });
    expect((failure as Error).message).toContain("首次下载失败");
    expect(await parsePids()).toHaveLength(0);
  });

  it("离线解析期 model_unavailable → 不可用错误，下次解析重新预检", { timeout: 30_000 }, async () => {
    const parser = await makeParser(
      fakeScript("print(json.dumps({'ok': False, 'code': 'model_unavailable', 'error': 'LocalEntryNotFoundError: cache missing'}))"),
      { modelPreflight: true },
    );
    await expect(parser.parseFile(pdf())).rejects.toMatchObject({ code: "INGESTION_PARSER_UNAVAILABLE" });
    expect(parser.modelResourceState).toBe("unchecked");
    await parser.parseFile(pdf()).catch(() => undefined);
    const kinds = (await markerLines()).map((line) => line.split(" ")[0]);
    expect(kinds).toEqual(["PREFLIGHT", "PARSE", "PREFLIGHT", "PARSE"]);
  });

  it("旧脚本不懂 --preflight（协议外输出）→ 预检不可判定，按旧行为联网解析", { timeout: 30_000 }, async () => {
    const parser = await makeParser(fakeScript(okBody, { preflight: "    print('legacy output')" }), { modelPreflight: true });
    const result = await parser.parseFile(pdf());
    expect(parser.modelResourceState).toBe("unknown");
    expect(result.notes[0]).toBe(process.env.HF_HUB_OFFLINE ?? "-");
  });

  it("预检自身超时 → 不当作文档失败：本次联网解析成功，状态保持 unchecked（下次重新预检）", { timeout: 30_000 }, async () => {
    const parser = await makeParser(fakeScript(okBody, { preflight: "    time.sleep(60)" }), {
      modelPreflight: true,
      preflightTimeoutMs: 800,
    });
    const result = await parser.parseFile(pdf());
    expect(result.blocks).toHaveLength(1);
    expect(result.notes[0]).toBe(process.env.HF_HUB_OFFLINE ?? "-");
    expect(parser.modelResourceState).toBe("unchecked");
    const lines = await markerLines();
    expect(lines.map((line) => line.split(" ")[0])).toEqual(["PREFLIGHT", "PARSE"]);
    expect(isAlive(Number(lines[0]!.split(" ")[1]))).toBe(false);
  });

  it("modelPreflight 关闭（缺省）→ 不预检、联网解析（旧行为）", { timeout: 30_000 }, async () => {
    const parser = await makeParser(fakeScript(okBody));
    await parser.parseFile(pdf());
    const kinds = (await markerLines()).map((line) => line.split(" ")[0]);
    expect(kinds).toEqual(["PARSE"]);
  });
});

describe("M17.2.2 生产解析脚本 CPU 存活心跳（真实 tools/parse_document_docling.py，不需要 docling）", () => {
  /** 载入生产脚本模块，缩短心跳周期，运行 body 秒数，返回 stderr 中的 working 心跳行数 */
  function beats(body: "busy" | "idle"): number {
    const program = [
      "import importlib.util, sys, time",
      "spec = importlib.util.spec_from_file_location('pt_docling', sys.argv[1])",
      "mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)",
      "mod.CPU_BEAT_INTERVAL = 0.5; mod.CPU_BEAT_MIN_SECONDS = 0.2",
      "mod.start_cpu_heartbeat()",
      "end = time.time() + 3.0",
      body === "busy" ? "while time.time() < end: sum(i * i for i in range(10000))" : "time.sleep(3.0)",
    ].join("\n");
    const result = spawnSync(pythonCommand(), ["-c", program, defaultDoclingScriptPath()], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, PYTHONIOENCODING: "utf8" },
    });
    expect(result.status).toBe(0);
    return result.stderr.split(/\r?\n/).filter((line) => line.startsWith('PAPERTEAM_PROGRESS {"phase": "working"')).length;
  }

  it("持续消耗 CPU → 发 working 心跳；挂起（不耗 CPU）→ 不发心跳（无进展上限照常触发）", { timeout: 60_000 }, () => {
    expect(beats("busy")).toBeGreaterThanOrEqual(2);
    expect(beats("idle")).toBe(0);
  });
});
