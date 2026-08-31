import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { LatexCompiler, type CommandResult, type CommandRunner } from "../src/latex/LatexCompiler.js";

/** 真实临时目录 + 可注入 runner 的测试环境 */
const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface ScriptedRunner {
  runner: CommandRunner;
  calls: { command: string; args: readonly string[]; cwd: string }[];
}

/**
 * 可编程 runner：
 * - probeResponses: --version 探测的返回（按工具名）
 * - compileResponse(args): 编译命令的返回；可创建 build/main.pdf 模拟产物
 */
function makeRunner(options: {
  probe: Record<string, CommandResult | null>;
  compile: (args: readonly string[], cwd: string) => CommandResult | Promise<CommandResult>;
}): ScriptedRunner {
  const calls: { command: string; args: readonly string[]; cwd: string }[] = [];
  const runner: CommandRunner = async (command, args, opts) => {
    calls.push({ command, args, cwd: opts.cwd });
    if (args.includes("--version")) {
      const probe = options.probe[command];
      if (probe === null || probe === undefined) {
        return { code: -1, stdout: "", stderr: "", spawnError: `ENOENT: ${command} not found` };
      }
      return probe;
    }
    return options.compile(args, opts.cwd);
  };
  return { runner, calls };
}

function okProbe(output: string): CommandResult {
  return { code: 0, stdout: output, stderr: "" };
}

async function newProjectDirs(): Promise<{ manuscriptDir: string; buildDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-latex-"));
  tempDirs.push(root);
  const manuscriptDir = join(root, "manuscript");
  const buildDir = join(root, "build");
  await mkdir(manuscriptDir, { recursive: true });
  await mkdir(buildDir, { recursive: true });
  await writeFile(join(manuscriptDir, "main.tex"), "\\documentclass{article}\n", "utf8");
  return { manuscriptDir, buildDir };
}

/** 模拟编译成功：在输出目录创建 main.pdf */
async function fakeSuccessfulCompile(
  args: readonly string[],
  _cwd: string,
): Promise<CommandResult> {
  const outputDir = args.find((arg) => arg.startsWith("-output-directory="));
  if (outputDir === undefined) {
    throw new Error("no output-directory arg");
  }
  const dir = outputDir.slice("-output-directory=".length);
  await writeFile(join(dir, "main.pdf"), Buffer.from("%PDF-1.5 fake"));
  return { code: 0, stdout: "Latexmk: all targets () are up-to-date", stderr: "" };
}

describe("LatexCompiler", () => {
  it("成功路径：latexmk 可用时优先使用，产出 build/paper.pdf 与 compile.log", async () => {
    const dirs = await newProjectDirs();
    const scripted = makeRunner({
      probe: { latexmk: okProbe("Latexmk, John Collins"), xelatex: okProbe("XeTeX 3.14") },
      compile: fakeSuccessfulCompile,
    });
    const compiler = new LatexCompiler({ timeoutMs: 5_000, runner: scripted.runner });

    const result = await compiler.compile(dirs);

    expect(result.ok).toBe(true);
    expect(result.tool).toBe("latexmk");
    expect(result.exitCode).toBe(0);
    expect(result.pdfPath).toBe(join(dirs.buildDir, "paper.pdf"));
    expect(result.logPath).toBe(join(dirs.buildDir, "compile.log"));
    // paper.pdf 真实存在且 main.pdf 已被重命名消失
    const pdf = await readFile(result.pdfPath!);
    expect(pdf.toString()).toContain("%PDF-1.5");
    // 编译命令正确
    const compileCall = scripted.calls.find((call) => !call.args.includes("--version"))!;
    expect(compileCall.command).toBe("latexmk");
    expect(compileCall.args).toContain("-xelatex");
    expect(compileCall.args).toContain("main.tex");
    expect(compileCall.cwd).toBe(dirs.manuscriptDir);
    // 日志包含命令行
    const log = await readFile(result.logPath!, "utf8");
    expect(log).toContain("latexmk");
  });

  it("latexmk 缺失时回退到 xelatex", async () => {
    const dirs = await newProjectDirs();
    const scripted = makeRunner({
      probe: { latexmk: null, xelatex: okProbe("XeTeX 3.14") },
      compile: async (args, cwd) => {
        // xelatex 单轮路径不含 -xelatex 参数
        expect(args).not.toContain("-xelatex");
        return fakeSuccessfulCompile(args, cwd);
      },
    });
    const compiler = new LatexCompiler({ timeoutMs: 5_000, runner: scripted.runner });

    const result = await compiler.compile(dirs);
    expect(result.ok).toBe(true);
    expect(result.tool).toBe("xelatex");
  });

  it("两个工具都缺失：抛 LatexToolUnavailableError", async () => {
    const dirs = await newProjectDirs();
    const scripted = makeRunner({
      probe: { latexmk: null, xelatex: null },
      compile: () => ({ code: 0, stdout: "", stderr: "" }),
    });
    const compiler = new LatexCompiler({ timeoutMs: 5_000, runner: scripted.runner });

    await expect(compiler.compile(dirs)).rejects.toMatchObject({
      code: "LATEX_TOOL_UNAVAILABLE",
    });
    // 不应执行任何编译命令（只有两次 --version 探测）
    expect(scripted.calls.filter((call) => !call.args.includes("--version"))).toHaveLength(0);
  });

  it("编译失败（exitCode != 0）：抛 LatexCompileFailedError，短错误来自 '!'-行", async () => {
    const dirs = await newProjectDirs();
    const scripted = makeRunner({
      probe: { latexmk: okProbe("v"), xelatex: okProbe("v") },
      compile: async () => ({
        code: 1,
        stdout: "...\n! Undefined control sequence.\nl.5 \\badcommand\n...",
        stderr: "",
      }),
    });
    const compiler = new LatexCompiler({ timeoutMs: 5_000, runner: scripted.runner });

    await expect(compiler.compile(dirs)).rejects.toMatchObject({
      code: "LATEX_COMPILE_FAILED",
      detail: expect.stringContaining("! Undefined control sequence"),
    });
  });

  it("编译超时（进程被终止，code=null）：抛 LatexCompileTimeoutError", async () => {
    const dirs = await newProjectDirs();
    const scripted = makeRunner({
      probe: { latexmk: okProbe("v"), xelatex: okProbe("v") },
      compile: () => ({ code: null, stdout: "", stderr: "", timedOut: true }),
    });
    const compiler = new LatexCompiler({ timeoutMs: 5_000, runner: scripted.runner });

    await expect(compiler.compile(dirs)).rejects.toMatchObject({ code: "LATEX_COMPILE_TIMEOUT" });
  });

  it("退出码 0 但没有生成 PDF：抛 LatexCompileFailedError", async () => {
    const dirs = await newProjectDirs();
    const scripted = makeRunner({
      probe: { latexmk: okProbe("v"), xelatex: okProbe("v") },
      compile: () => ({ code: 0, stdout: "done", stderr: "" }),
    });
    const compiler = new LatexCompiler({ timeoutMs: 5_000, runner: scripted.runner });

    await expect(compiler.compile(dirs)).rejects.toMatchObject({
      code: "LATEX_COMPILE_FAILED",
      detail: expect.stringContaining("没有生成 main.pdf"),
    });
  });

  it("stderr 提供 fallback 短错误（无 '!'-行时）", async () => {
    const dirs = await newProjectDirs();
    const scripted = makeRunner({
      probe: { latexmk: okProbe("v"), xelatex: okProbe("v") },
      compile: () => ({ code: 2, stdout: "nothing", stderr: "kludge font map error" }),
    });
    const compiler = new LatexCompiler({ timeoutMs: 5_000, runner: scripted.runner });

    await expect(compiler.compile(dirs)).rejects.toMatchObject({
      code: "LATEX_COMPILE_FAILED",
      detail: expect.stringContaining("kludge font map error"),
    });
  });
});
