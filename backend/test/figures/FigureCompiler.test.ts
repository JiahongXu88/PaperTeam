import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  FigureCompiler,
  figureFailureToBusinessError,
  type CommandResult,
  type CommandRunner,
} from "../../src/figures/FigureCompiler.js";
import {
  FigureStore,
  computeSpecHash,
  deriveFigId,
} from "../../src/figures/figureStore.js";
import { computeDatasetHash, validatePlotSpec } from "../../src/figures/spec.js";

/**
 * C3 FigureCompiler / FigureStore 测试（fake xelatex，零本机 TeX 依赖——
 * 手法复用 LatexCompiler.test.ts 的可编程 runner：按 cwd 读写文件系统效应）。
 *
 * 真实编译 smoke 由主 agent 在有 TeX 的环境执行（任务书约定）。
 */

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

async function newEnv(): Promise<{
  root: string;
  store: FigureStore;
  buildRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-figures-"));
  tempDirs.push(root);
  const buildRoot = join(root, "buildtmp");
  const store = new FigureStore(join(root, "manuscript", "figs", "generated"));
  return { root, store, buildRoot };
}

// ---- fake 工具链 ----

interface FakeXelatex {
  unavailable?: boolean;
  /** 非零退出码（此时不写 PDF） */
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** 写入 <figId>.log 的内容（package_missing 的 TeX Live 形态注入用） */
  logContent?: string;
  noPdf?: boolean;
  /** 产物字节（缺省 %PDF 魔数；坏魔数注入用） */
  pdfBytes?: Buffer;
  /** xelatex 编译调用按超时返回 */
  timeoutOnCompile?: boolean;
}

function makeFigureRunner(fake: FakeXelatex = {}): {
  runner: CommandRunner;
  calls: Array<{ command: string; args: readonly string[]; cwd: string }>;
} {
  const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  const runner: CommandRunner = async (command, args, opts): Promise<CommandResult> => {
    calls.push({ command, args, cwd: opts.cwd });
    if (fake.timeoutOnCompile === true && !args.includes("--version")) {
      return { code: null, stdout: "", stderr: "", timedOut: true };
    }
    if (args.includes("--version")) {
      if (fake.unavailable === true) {
        return { code: -1, stdout: "", stderr: "", spawnError: "ENOENT: xelatex not found" };
      }
      return { code: 0, stdout: "XeTeX 1.0 (fake)", stderr: "" };
    }
    // xelatex -interaction=nonstopmode -halt-on-error <figId>.tex
    const texArg = args.find((arg) => arg.endsWith(".tex"));
    if (texArg === undefined) {
      return { code: 99, stdout: "", stderr: "unexpected invocation" };
    }
    const figId = texArg.slice(0, -4);
    await readFile(join(opts.cwd, texArg), "utf8"); // tex 文件必须真实写入
    await writeFile(join(opts.cwd, `${figId}.log`), fake.logContent ?? "This is XeTeX (fake)", "utf8");
    const exit = fake.exitCode ?? 0;
    if (exit === 0 && fake.noPdf !== true) {
      await writeFile(
        join(opts.cwd, `${figId}.pdf`),
        fake.pdfBytes ?? Buffer.from("%PDF-1.5 fake", "latin1"),
      );
    }
    return { code: exit, stdout: fake.stdout ?? "fake xelatex: done", stderr: fake.stderr ?? "" };
  };
  return { runner, calls };
}

/** 过滤 --version 探测后的真实编译调用数 */
function compileCalls(calls: ReadonlyArray<{ args: readonly string[] }>): number {
  return calls.filter((call) => !call.args.includes("--version")).length;
}

// ---- spec 工厂 ----

const BASE_DATASET = {
  columns: ["x", "ours"],
  rows: [
    [1, 3.5],
    [2, 4.25],
    [3, 5.5],
  ],
};

function basePlotSpec(): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify({
      plotType: "line",
      title: "Throughput",
      caption: "Caption candidate 100%",
      data: {
        origin: { sourceId: "S001", blockId: "tbl-001" },
        datasetHash: computeDatasetHash(BASE_DATASET),
        x: ["x"],
        series: [{ name: "Ours", column: "ours" }],
        inlineDataset: BASE_DATASET,
      },
      axis: { xLabel: "Batch" },
    }),
  );
}

function baseDiagramSpec(): Record<string, unknown> {
  return {
    layout: "vertical",
    title: "Pipeline",
    nodes: [
      { id: "input", label: "Input" },
      { id: "encoder", label: "Encoder" },
    ],
    edges: [{ from: "input", to: "encoder" }],
  };
}

function makeCompiler(runner: CommandRunner, buildRoot: string): FigureCompiler {
  return new FigureCompiler({ runner, buildRootDir: buildRoot, timeoutMs: 5_000 });
}

describe("FigureCompiler（fake xelatex）", () => {
  it("成功路径（plot）：spec/tex/pdf/manifest 落盘，figId 确定性，runner 编排正确", async () => {
    const env = await newEnv();
    const scripted = makeFigureRunner();
    const compiler = makeCompiler(scripted.runner, env.buildRoot);

    const outcome = await compiler.generate({
      kind: "plot",
      spec: basePlotSpec(),
      store: env.store,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.cached).toBe(false);
    expect(outcome.record.figId).toMatch(/^fig-[0-9a-f]{12}$/);
    expect(outcome.record.kind).toBe("plot");
    expect(outcome.record.datasetHash).toBe(computeDatasetHash(BASE_DATASET));
    expect(outcome.record.dataOrigin).toEqual({ sourceId: "S001", blockId: "tbl-001" });
    expect(outcome.record.caption).toBe("Caption candidate 100%");
    expect(outcome.record.insertedIn).toBeUndefined();
    expect(typeof outcome.record.compiler?.durationMs).toBe("number");

    // 编排：--version 探测一次 + xelatex 单遍一次
    expect(scripted.calls).toHaveLength(2);
    expect(compileCalls(scripted.calls)).toBe(1);
    expect(scripted.calls[1]?.args).toEqual([
      "-interaction=nonstopmode",
      "-halt-on-error",
      `${outcome.record.figId}.tex`,
    ]);
    expect(scripted.calls[1]?.cwd.startsWith(env.buildRoot)).toBe(true);

    // 资产落盘
    const specJson = JSON.parse(await readFile(env.store.assetPath(outcome.record, "spec"), "utf8"));
    expect(specJson.plotType).toBe("line");
    const tex = await readFile(env.store.assetPath(outcome.record, "tex"), "utf8");
    expect(tex).toContain("\\addplot");
    expect(tex).toContain("\\pgfplotsset{compat=1.18}");
    const pdf = await readFile(env.store.assetPath(outcome.record, "pdf"));
    expect(pdf.toString("latin1")).toContain("%PDF-1.5");

    // manifest lineage
    const manifest = await env.store.loadManifest();
    expect(manifest.figures).toHaveLength(1);
    expect(manifest.figures[0]?.specHash).toBe(outcome.record.specHash);

    // 临时构建目录已清理
    expect(await readdir(env.buildRoot)).toEqual([]);
  });

  it("缓存命中：同 spec 第二次不跑 xelatex（runner 调用计数不变）", async () => {
    const env = await newEnv();
    const scripted = makeFigureRunner();
    const compiler = makeCompiler(scripted.runner, env.buildRoot);

    const first = await compiler.generate({ kind: "plot", spec: basePlotSpec(), store: env.store });
    const callsAfterFirst = scripted.calls.length;
    expect(first.ok).toBe(true);

    const second = await compiler.generate({ kind: "plot", spec: basePlotSpec(), store: env.store });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.cached).toBe(true);
      expect(second.record.figId).toBe(first.ok ? first.record.figId : "");
    }
    // 连 --version 探测都没有（缓存检查先于探测）
    expect(scripted.calls).toHaveLength(callsAfterFirst);
  });

  it("figId 跨 store 确定：同 spec 在两个项目目录生成同 id", async () => {
    const envA = await newEnv();
    const envB = await newEnv();
    const scripted = makeFigureRunner();
    const a = await makeCompiler(scripted.runner, envA.buildRoot).generate({
      kind: "plot",
      spec: basePlotSpec(),
      store: envA.store,
    });
    const b = await makeCompiler(scripted.runner, envB.buildRoot).generate({
      kind: "plot",
      spec: basePlotSpec(),
      store: envB.store,
    });
    expect(a.ok && b.ok && a.record.figId === b.record.figId).toBe(true);
  });

  it("数据变化（datasetHash 同步重算）→ 新 specHash/新 figId，重编译", async () => {
    const env = await newEnv();
    const scripted = makeFigureRunner();
    const compiler = makeCompiler(scripted.runner, env.buildRoot);

    const first = await compiler.generate({ kind: "plot", spec: basePlotSpec(), store: env.store });
    expect(first.ok).toBe(true);

    const changedDataset = {
      columns: ["x", "ours"],
      rows: [
        [1, 3.5],
        [2, 4.9],
        [3, 5.5],
      ],
    };
    const spec = basePlotSpec();
    (spec.data as Record<string, unknown>).inlineDataset = changedDataset;
    (spec.data as Record<string, unknown>).datasetHash = computeDatasetHash(changedDataset);
    const second = await compiler.generate({ kind: "plot", spec, store: env.store });

    expect(second.ok).toBe(true);
    if (second.ok && first.ok) {
      expect(second.record.figId).not.toBe(first.record.figId);
      expect(second.record.specHash).not.toBe(first.record.specHash);
      expect(second.record.datasetHash).toBe(computeDatasetHash(changedDataset));
    }
    expect(compileCalls(scripted.calls)).toBe(2);
    const manifest = await env.store.loadManifest();
    expect(manifest.figures).toHaveLength(2);
  });

  it("数据变化但 datasetHash 未重算 → invalid_spec（零 runner 调用）", async () => {
    const env = await newEnv();
    const scripted = makeFigureRunner();
    const compiler = makeCompiler(scripted.runner, env.buildRoot);

    const spec = basePlotSpec();
    const rows = (spec.data as { inlineDataset: { rows: number[][] } }).inlineDataset.rows;
    rows[0]![1] = 99; // 数据改了，hash 没改
    const outcome = await compiler.generate({ kind: "plot", spec, store: env.store });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe("invalid_spec");
      expect(outcome.failure.message).toContain("datasetHash");
    }
    expect(scripted.calls).toHaveLength(0);
  });

  it("invalid spec（结构非法）与 kind 不匹配 → invalid_spec，不探测工具", async () => {
    const env = await newEnv();
    const scripted = makeFigureRunner();
    const compiler = makeCompiler(scripted.runner, env.buildRoot);

    const bad = basePlotSpec();
    bad.plotType = "pie";
    const outcome1 = await compiler.generate({ kind: "plot", spec: bad, store: env.store });
    expect(outcome1.ok).toBe(false);
    if (!outcome1.ok) {
      expect(outcome1.failure.kind).toBe("invalid_spec");
    }

    const outcome2 = await compiler.generate({
      kind: "plot",
      spec: baseDiagramSpec(),
      store: env.store,
    });
    expect(outcome2.ok).toBe(false);
    if (!outcome2.ok) {
      expect(outcome2.failure.kind).toBe("invalid_spec");
    }
    expect(scripted.calls).toHaveLength(0);
  });

  it("xelatex 缺失 → tool_unavailable（只有 --version 探测，无编译调用）", async () => {
    const env = await newEnv();
    const scripted = makeFigureRunner({ unavailable: true });
    const compiler = makeCompiler(scripted.runner, env.buildRoot);

    const outcome = await compiler.generate({ kind: "plot", spec: basePlotSpec(), store: env.store });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe("tool_unavailable");
    }
    expect(compileCalls(scripted.calls)).toBe(0);
  });

  it("编译失败（非零退出）：compile_failed + log 中 '!'-行摘要", async () => {
    const env = await newEnv();
    const scripted = makeFigureRunner({
      exitCode: 1,
      stdout: "...",
      logContent:
        "This is XeTeX (fake)\n! Undefined control sequence.\nl.5 \\badcommand\n...",
    });
    const compiler = makeCompiler(scripted.runner, env.buildRoot);

    const outcome = await compiler.generate({ kind: "plot", spec: basePlotSpec(), store: env.store });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe("compile_failed");
      expect(outcome.failure.message).toContain("exitCode=1");
      expect(outcome.failure.logExcerpt).toContain("! Undefined control sequence");
    }
  });

  it("超时 → timeout", async () => {
    const env = await newEnv();
    const scripted = makeFigureRunner({ timeoutOnCompile: true });
    const compiler = makeCompiler(scripted.runner, env.buildRoot);

    const outcome = await compiler.generate({ kind: "plot", spec: basePlotSpec(), store: env.store });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe("timeout");
    }
  });

  it("package_missing（MiKTeX 形态：File 'pgfplots.sty' not found）→ 附宏包名", async () => {
    const env = await newEnv();
    const scripted = makeFigureRunner({
      exitCode: 1,
      stdout: "! LaTeX Error: File 'pgfplots.sty' not found.\n...",
    });
    const compiler = makeCompiler(scripted.runner, env.buildRoot);

    const outcome = await compiler.generate({ kind: "plot", spec: basePlotSpec(), store: env.store });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe("package_missing");
      expect(outcome.failure.packageName).toBe("pgfplots");
    }
  });

  it("package_missing（TeX Live 形态：Environment axis undefined）→ pgfplots", async () => {
    const env = await newEnv();
    const scripted = makeFigureRunner({
      exitCode: 1,
      logContent: "! LaTeX Error: Environment axis undefined.\nl.12 \\begin{axis}",
    });
    const compiler = makeCompiler(scripted.runner, env.buildRoot);

    const outcome = await compiler.generate({ kind: "plot", spec: basePlotSpec(), store: env.store });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe("package_missing");
      expect(outcome.failure.packageName).toBe("pgfplots");
    }
  });

  it("退出码 0 但没有生成 PDF → compile_failed", async () => {
    const env = await newEnv();
    const scripted = makeFigureRunner({ noPdf: true });
    const compiler = makeCompiler(scripted.runner, env.buildRoot);

    const outcome = await compiler.generate({ kind: "plot", spec: basePlotSpec(), store: env.store });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe("compile_failed");
      expect(outcome.failure.message).toContain("没有生成");
    }
  });

  it("产物非 PDF（魔数缺失）→ compile_failed", async () => {
    const env = await newEnv();
    const scripted = makeFigureRunner({ pdfBytes: Buffer.from("this is not a pdf", "latin1") });
    const compiler = makeCompiler(scripted.runner, env.buildRoot);

    const outcome = await compiler.generate({ kind: "plot", spec: basePlotSpec(), store: env.store });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe("compile_failed");
      expect(outcome.failure.message).toContain("魔数");
    }
  });

  it("diagram 成功路径：TikZ 模板 + manual dataOrigin + 无 datasetHash", async () => {
    const env = await newEnv();
    const scripted = makeFigureRunner();
    const compiler = makeCompiler(scripted.runner, env.buildRoot);

    const outcome = await compiler.generate({
      kind: "diagram",
      spec: baseDiagramSpec(),
      store: env.store,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.record.kind).toBe("diagram");
    expect(outcome.record.datasetHash).toBeUndefined();
    expect(outcome.record.dataOrigin).toEqual({
      origin: "manual",
      note: expect.stringContaining("DiagramSpec"),
    });
    expect(outcome.record.caption).toBe("Pipeline");
    const tex = await readFile(env.store.assetPath(outcome.record, "tex"), "utf8");
    expect(tex).toContain("\\begin{tikzpicture}");
    expect(tex).toContain("\\usetikzlibrary{positioning,arrows.meta,fit,backgrounds}");
  });

  it("PDF 资产丢失 → 缓存视为 miss 重编译，manifest 不重复，createdAt 保留", async () => {
    const env = await newEnv();
    const scripted = makeFigureRunner();
    const compiler = makeCompiler(scripted.runner, env.buildRoot);

    const first = await compiler.generate({ kind: "plot", spec: basePlotSpec(), store: env.store });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    await rm(env.store.assetPath(first.record, "pdf"), { force: true });

    const second = await compiler.generate({ kind: "plot", spec: basePlotSpec(), store: env.store });
    expect(second.ok).toBe(true);
    if (second.ok && first.ok) {
      expect(second.cached).toBe(false);
      expect(second.record.figId).toBe(first.record.figId);
      expect(second.record.createdAt).toBe(first.record.createdAt);
    }
    expect(compileCalls(scripted.calls)).toBe(2);
    const manifest = await env.store.loadManifest();
    expect(manifest.figures).toHaveLength(1);
  });

  it("figId 前缀碰撞回退：同 figId 不同 specHash → 退化为全 hash 形态", async () => {
    const env = await newEnv();
    // 预置一条同 figId、不同 specHash 的记录（模拟 48bit 前缀碰撞）
    const normalized = validatePlotSpec(basePlotSpec()).spec;
    const specHash = computeSpecHash(normalized);
    await env.store.persistFigure({
      record: {
        figId: deriveFigId(specHash),
        kind: "plot",
        specHash: "ff".repeat(32),
        dataOrigin: { origin: "manual", note: "seed" },
        assets: { tex: "seed.tex", pdf: "seed.pdf" },
        caption: "",
        createdAt: "2020-01-01T00:00:00.000Z",
      },
      spec: {},
      tex: "",
      pdfBytes: Buffer.from("%PDF-1.5 seed", "latin1"),
    });

    const scripted = makeFigureRunner();
    const compiler = makeCompiler(scripted.runner, env.buildRoot);
    const outcome = await compiler.generate({ kind: "plot", spec: basePlotSpec(), store: env.store });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.record.figId).toBe(`fig-${specHash}`);
    }
    const manifest = await env.store.loadManifest();
    expect(manifest.figures).toHaveLength(2);
  });

  it("failure → BusinessError 映射（五类各有稳定 code）", () => {
    expect(figureFailureToBusinessError({ kind: "invalid_spec", message: "x" }).code).toBe(
      "FIGURE_SPEC_INVALID",
    );
    expect(figureFailureToBusinessError({ kind: "tool_unavailable", message: "x" }).code).toBe(
      "LATEX_TOOL_UNAVAILABLE",
    );
    expect(
      figureFailureToBusinessError({ kind: "package_missing", message: "x", packageName: "pgfplots" }).code,
    ).toBe("FIGURE_PACKAGE_MISSING");
    expect(figureFailureToBusinessError({ kind: "compile_failed", message: "x" }).code).toBe(
      "FIGURE_COMPILE_FAILED",
    );
    expect(figureFailureToBusinessError({ kind: "timeout", message: "x" }).code).toBe(
      "FIGURE_COMPILE_TIMEOUT",
    );
  });
});

describe("FigureStore / 身份派生", () => {
  it("computeSpecHash：规范化 spec 稳定；数据变化必改 specHash", () => {
    const a = validatePlotSpec(basePlotSpec()).spec;
    const b = validatePlotSpec(basePlotSpec()).spec;
    expect(computeSpecHash(a)).toBe(computeSpecHash(b));
    expect(deriveFigId(computeSpecHash(a))).toMatch(/^fig-[0-9a-f]{12}$/);

    const changed = JSON.parse(JSON.stringify(basePlotSpec())) as Record<string, unknown>;
    const dataset = (changed.data as { inlineDataset: { columns: string[]; rows: (number | string | null)[][] } })
      .inlineDataset;
    dataset.rows[0]![1] = 99;
    (changed.data as Record<string, unknown>).datasetHash = computeDatasetHash(dataset);
    const c = validatePlotSpec(changed).spec;
    expect(computeSpecHash(c)).not.toBe(computeSpecHash(a));
  });

  it("manifest 损坏 → 显式抛错（不静默重建）", async () => {
    const env = await newEnv();
    await mkdir(join(env.root, "manuscript", "figs", "generated"), { recursive: true });
    await writeFile(env.store.manifestPath, "{ not json", "utf8");
    await expect(env.store.loadManifest()).rejects.toThrow(/损坏/);
  });

  it("manifest schemaVersion 不符 → 显式抛错", async () => {
    const env = await newEnv();
    await mkdir(join(env.root, "manuscript", "figs", "generated"), { recursive: true });
    await writeFile(env.store.manifestPath, JSON.stringify({ schemaVersion: 99, figures: [] }), "utf8");
    await expect(env.store.loadManifest()).rejects.toThrow(/损坏/);
  });

  it("空目录 → 空 manifest；findBySpecHash / pdfAssetExists 语义正确", async () => {
    const env = await newEnv();
    expect(await env.store.list()).toEqual([]);
    expect(await env.store.findBySpecHash("ab".repeat(32))).toBeUndefined();

    await env.store.persistFigure({
      record: {
        figId: "fig-abc123000000",
        kind: "diagram",
        specHash: "ab".repeat(32),
        dataOrigin: { origin: "manual", note: "n" },
        assets: { tex: "fig-abc123000000.tex", pdf: "fig-abc123000000.pdf" },
        caption: "",
        createdAt: "2026-10-07T00:00:00.000Z",
      },
      spec: { any: "thing" },
      tex: "\\documentclass{standalone}",
      pdfBytes: Buffer.from("%PDF-1.5", "latin1"),
    });
    const record = await env.store.findBySpecHash("ab".repeat(32));
    expect(record?.figId).toBe("fig-abc123000000");
    expect(await env.store.pdfAssetExists(record!)).toBe(true);
    await rm(env.store.assetPath(record!, "pdf"), { force: true });
    expect(await env.store.pdfAssetExists(record!)).toBe(false);
  });
});
