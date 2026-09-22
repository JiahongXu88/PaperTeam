import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { LatexCompiler, type CommandRunner } from "../src/latex/LatexCompiler.js";

/**
 * M9.5.1 编排式编译器测试。
 *
 * 单元层：注入可编程 runner + 真实临时目录（staging 复制真实发生）。
 * fake 工具链按命令模拟文件系统效应（xelatex 写 aux/log/pdf，bibtex 写
 * blg/bbl），覆盖任务要求的五类行为：bib 存在编译通过、\cite 渲染链、
 * references section 产出、重复 build 一致、零本机环境依赖。
 * 真实渲染链由末尾「真实编译集成」用例守住（本机/CI 镜像有 TeX 时执行）。
 */

const tempDirs: string[] = [];

afterAll(async () => {
  // Windows 下真实编译的子进程句柄可能延迟释放（EBUSY）；force + 重试兜底
  await Promise.all(
    tempDirs.map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    ),
  );
});

interface ScriptedRunner {
  runner: CommandRunner;
  calls: { command: string; args: readonly string[]; cwd: string }[];
}

/** fake 工具链的可编程行为 */
interface FakeToolchain {
  /** 工具可用性（--version 探测；缺省视为可用） */
  unavailable?: readonly string[];
  /** xelatex 退出码（缺省 0） */
  xelatexExit?: number;
  /** xelatex stdout（错误注入用） */
  xelatexStdout?: string;
  /** xelatex stderr（错误注入用） */
  xelatexStderr?: string;
  /** 不写 main.pdf（缺省写） */
  noPdf?: boolean;
  /** bibtex 退出码（缺省 0） */
  bibtexExit?: number;
  /** .blg 报告的条目数；0 复现 M9.5 事故形态（缺省 2） */
  blgEntries?: number;
  /** 第 N 轮 xelatex 的 main.log 是否提示 Rerun（1-based；缺省全 false） */
  rerunAfter?: readonly boolean[];
  /** Rerun 提示的措辞（缺省 LaTeX 形态；natbib 形态 = "citations correct"） */
  rerunHint?: string;
  /** 最终 main.log 是否含未解析引用警告 */
  undefinedCitations?: boolean;
  /** 该命令的执行结果按超时（被终止）返回 */
  timeoutOn?: string;
}

/**
 * 可编程 fake 工具链：
 * - --version → unavailable 名单外 exit 0；
 * - xelatex → 按 cwd/main.tex 内容写 main.aux（\bibdata/\citation 与源一致）、
 *   main.log（Rerun / undefined 提示可编程）、main.pdf；
 * - bibtex → 写 main.blg（条目数可编程）与 main.bbl。
 */
function makeRunner(fake: FakeToolchain = {}): ScriptedRunner {
  const calls: { command: string; args: readonly string[]; cwd: string }[] = [];
  let xelatexRound = 0;
  const runner: CommandRunner = async (command, args, opts) => {
    calls.push({ command, args, cwd: opts.cwd });
    if (fake.timeoutOn === command && !args.includes("--version")) {
      return { code: null, stdout: "", stderr: "", timedOut: true };
    }
    if (args.includes("--version")) {
      if (fake.unavailable?.includes(command)) {
        return { code: -1, stdout: "", stderr: "", spawnError: `ENOENT: ${command} not found` };
      }
      return { code: 0, stdout: `${command} 1.0 (fake)`, stderr: "" };
    }

    if (command === "xelatex") {
      xelatexRound += 1;
      const tex = await readFile(join(opts.cwd, "main.tex"), "utf8");
      const cites = [...tex.matchAll(/\\cite\{([^}]*)\}/g)].flatMap((m) => (m[1] ?? "").split(","));
      const auxLines = [
        "\\relax",
        ...cites.map((key) => `\\citation{${key.trim()}}`),
      ];
      if (/\\bibliography\{|\\addbibresource\{/.test(tex)) {
        auxLines.push("\\bibdata{references}", "\\bibstyle{unsrt}");
      }
      await writeFile(join(opts.cwd, "main.aux"), auxLines.join("\n"), "utf8");

      const logLines = ["This is XeTeX (fake)"];
      if (fake.rerunAfter?.[xelatexRound - 1] === true) {
        logLines.push(
          fake.rerunHint === undefined
            ? "LaTeX Warning: Rerun to get cross-references right."
            : fake.rerunHint,
        );
      }
      if (fake.undefinedCitations) {
        logLines.push("LaTeX Warning: Citation `kim2019comparison' on page 1 undefined on input line 3.");
      }
      await writeFile(join(opts.cwd, "main.log"), logLines.join("\n"), "utf8");

      if (!fake.noPdf) {
        await writeFile(join(opts.cwd, "main.pdf"), Buffer.from("%PDF-1.5 fake"));
      }
      return {
        code: fake.xelatexExit ?? 0,
        stdout: fake.xelatexStdout ?? "fake xelatex: done",
        stderr: fake.xelatexStderr ?? "",
      };
    }

    if (command === "bibtex") {
      const entries = fake.blgEntries ?? 2;
      await writeFile(
        join(opts.cwd, "main.blg"),
        entries === 0 ? "You've used 0 entries," : `You've used ${entries} entries,`,
        "utf8",
      );
      await writeFile(
        join(opts.cwd, "main.bbl"),
        entries === 0 ? "" : "\\bibitem{kim2019comparison}fake entry",
        "utf8",
      );
      return { code: fake.bibtexExit ?? 0, stdout: "fake bibtex: done", stderr: "" };
    }

    return { code: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

/** 编译调用（过滤 --version 探测） */
function compileCalls(scripted: ScriptedRunner): { command: string; args: readonly string[] }[] {
  return scripted.calls
    .filter((call) => !call.args.includes("--version"))
    .map((call) => ({ command: call.command, args: call.args }));
}

async function newProjectDirs(options?: { bib?: boolean }): Promise<{
  manuscriptDir: string;
  buildDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-latex-"));
  tempDirs.push(root);
  const manuscriptDir = join(root, "manuscript");
  const buildDir = join(root, "build");
  await mkdir(join(manuscriptDir, "sections"), { recursive: true });
  await mkdir(buildDir, { recursive: true });
  if (options?.bib === false) {
    await writeFile(
      join(manuscriptDir, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nPlain text, no bibliography.\n\\end{document}\n",
      "utf8",
    );
  } else {
    await writeFile(
      join(manuscriptDir, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\n" +
        "Cite~\\cite{kim2019comparison} and~\\cite{vaswani2017attention}.\n" +
        "\\bibliographystyle{unsrt}\n\\bibliography{references}\n\\end{document}\n",
      "utf8",
    );
    await writeFile(
      join(manuscriptDir, "references.bib"),
      "@misc{kim2019comparison,\n  author = {Kim},\n  title = {T},\n  year = {2019},\n}\n" +
        "@article{vaswani2017attention,\n  author = {Vaswani},\n  title = {A},\n  journal = {N},\n  year = {2017},\n}\n",
      "utf8",
    );
  }
  await writeFile(join(manuscriptDir, "sections", "intro.tex"), "Intro.\n", "utf8");
  return { manuscriptDir, buildDir };
}

describe("LatexCompiler（xelatex + bibtex 显式编排）", () => {
  it("成功路径（含 references.bib）：xelatex → bibtex → xelatex × 2，产出 paper.pdf", async () => {
    const dirs = await newProjectDirs();
    const scripted = makeRunner({ rerunAfter: [false, true, false] });
    const compiler = new LatexCompiler({ timeoutMs: 5_000, runner: scripted.runner });

    const result = await compiler.compile(dirs);

    expect(result.ok).toBe(true);
    expect(result.tool).toBe("xelatex+bibtex");
    expect(result.exitCode).toBe(0);
    expect(result.pdfPath).toBe(join(dirs.buildDir, "paper.pdf"));

    // 编排顺序：pass1 → bibtex → pass2 → pass3（pass2 后 log 提示 Rerun → pass3）
    const commands = compileCalls(scripted).map((call) => call.command);
    expect(commands).toEqual(["xelatex", "bibtex", "xelatex", "xelatex"]);
    // 全部命令在 buildDir 内执行（staging 统一工作目录）
    for (const call of scripted.calls) {
      if (!call.args.includes("--version")) {
        expect(call.cwd).toBe(dirs.buildDir);
      }
    }

    // staging：references.bib 与 sections/ 已复制进 buildDir
    const bib = await readFile(join(dirs.buildDir, "references.bib"), "utf8");
    expect(bib).toContain("kim2019comparison");
    await readFile(join(dirs.buildDir, "sections", "intro.tex"));

    // PDF 真实存在
    const pdf = await readFile(result.pdfPath!);
    expect(pdf.toString()).toContain("%PDF-1.5");

    // compile.log 记录全部步骤
    const log = await readFile(result.logPath!, "utf8");
    expect(log).toContain("# bibtex");
    expect(log).toContain("# xelatex pass 1");
    expect(log).toContain("# xelatex pass 3");
  });

  it("成功路径不污染 manuscript/：编译产物全部落在 buildDir", async () => {
    const dirs = await newProjectDirs();
    const scripted = makeRunner();
    const compiler = new LatexCompiler({ timeoutMs: 5_000, runner: scripted.runner });

    await compiler.compile(dirs);

    const manuscriptFiles = await readdir(dirs.manuscriptDir, { recursive: true });
    const products = manuscriptFiles.filter((name) =>
      /\.(aux|bbl|blg|log|pdf)$/i.test(name),
    );
    expect(products).toEqual([]);
  });

  it("无 \\bibliography 的文档：跳过 bibtex，tool=xelatex", async () => {
    const dirs = await newProjectDirs({ bib: false });
    const scripted = makeRunner();
    const compiler = new LatexCompiler({ timeoutMs: 5_000, runner: scripted.runner });

    const result = await compiler.compile(dirs);

    expect(result.ok).toBe(true);
    expect(result.tool).toBe("xelatex");
    // 无 bibtex 调用（连探测都没有——探测发生在确认 aux 有 \bibdata 之后）
    expect(scripted.calls.filter((call) => call.command === "bibtex")).toHaveLength(0);
  });

  it("xelatex 缺失：抛 LatexToolUnavailableError，不执行任何编译命令", async () => {
    const dirs = await newProjectDirs();
    const scripted = makeRunner({ unavailable: ["xelatex"] });
    const compiler = new LatexCompiler({ timeoutMs: 5_000, runner: scripted.runner });

    await expect(compiler.compile(dirs)).rejects.toMatchObject({
      code: "LATEX_TOOL_UNAVAILABLE",
    });
    expect(compileCalls(scripted)).toHaveLength(0);
  });

  it("文档声明参考文献但 bibtex 缺失：抛 LatexToolUnavailableError（消息指明 bibtex）", async () => {
    const dirs = await newProjectDirs();
    const scripted = makeRunner({ unavailable: ["bibtex"] });
    const compiler = new LatexCompiler({ timeoutMs: 5_000, runner: scripted.runner });

    await expect(compiler.compile(dirs)).rejects.toMatchObject({
      code: "LATEX_TOOL_UNAVAILABLE",
      detail: expect.stringContaining("bibtex"),
    });
  });

  it("xelatex 编译失败（exitCode != 0）：短错误来自 '!'-行", async () => {
    const dirs = await newProjectDirs();
    const scripted = makeRunner({
      xelatexExit: 1,
      xelatexStdout: "...\n! Undefined control sequence.\nl.5 \\badcommand\n...",
    });
    const compiler = new LatexCompiler({ timeoutMs: 5_000, runner: scripted.runner });

    await expect(compiler.compile(dirs)).rejects.toMatchObject({
      code: "LATEX_COMPILE_FAILED",
      detail: expect.stringContaining("! Undefined control sequence"),
    });
  });

  it("bibtex 失败（exitCode != 0）：抛 LatexCompileFailedError，detail 含 exitCode", async () => {
    const dirs = await newProjectDirs();
    const scripted = makeRunner({ bibtexExit: 2 });
    const compiler = new LatexCompiler({ timeoutMs: 5_000, runner: scripted.runner });

    await expect(compiler.compile(dirs)).rejects.toMatchObject({
      code: "LATEX_COMPILE_FAILED",
      detail: expect.stringContaining("bibtex exitCode=2"),
    });
  });

  it("M9.5 事故回归：bibtex exit 0 但 0 entries（读到错误的 references.bib）→ 编译失败", async () => {
    const dirs = await newProjectDirs();
    const scripted = makeRunner({ blgEntries: 0 });
    const compiler = new LatexCompiler({ timeoutMs: 5_000, runner: scripted.runner });

    await expect(compiler.compile(dirs)).rejects.toMatchObject({
      code: "LATEX_COMPILE_FAILED",
      detail: expect.stringContaining("0 条文献"),
    });
  });

  it("最终 log 存在未解析引用：编译失败（references 空的 PDF 不静默通过）", async () => {
    const dirs = await newProjectDirs();
    const scripted = makeRunner({ undefinedCitations: true });
    const compiler = new LatexCompiler({ timeoutMs: 5_000, runner: scripted.runner });

    await expect(compiler.compile(dirs)).rejects.toMatchObject({
      code: "LATEX_COMPILE_FAILED",
      detail: expect.stringContaining("未解析"),
    });
  });

  it("编译超时（进程被终止）：抛 LatexCompileTimeoutError", async () => {
    const dirs = await newProjectDirs();
    const scripted = makeRunner({ timeoutOn: "xelatex" });
    const compiler = new LatexCompiler({ timeoutMs: 5_000, runner: scripted.runner });

    await expect(compiler.compile(dirs)).rejects.toMatchObject({ code: "LATEX_COMPILE_TIMEOUT" });
  });

  it("退出码 0 但没有生成 PDF：抛 LatexCompileFailedError", async () => {
    const dirs = await newProjectDirs();
    const scripted = makeRunner({ noPdf: true });
    const compiler = new LatexCompiler({ timeoutMs: 5_000, runner: scripted.runner });

    await expect(compiler.compile(dirs)).rejects.toMatchObject({
      code: "LATEX_COMPILE_FAILED",
      detail: expect.stringContaining("没有生成 main.pdf"),
    });
  });

  it("stderr 提供 fallback 短错误（无 '!'-行时）", async () => {
    const dirs = await newProjectDirs();
    const scripted = makeRunner({
      xelatexExit: 2,
      xelatexStdout: "nothing",
      xelatexStderr: "kludge font map error",
    });
    const compiler = new LatexCompiler({ timeoutMs: 5_000, runner: scripted.runner });

    await expect(compiler.compile(dirs)).rejects.toMatchObject({
      code: "LATEX_COMPILE_FAILED",
      detail: expect.stringContaining("kludge font map error"),
    });
  });

  it("Rerun 提示持续出现时追加轮次有上限（pass2 后最多追加 2 轮，共 4 轮 xelatex）", async () => {
    const dirs = await newProjectDirs();
    const scripted = makeRunner({ rerunAfter: [false, true, true, true, true] });
    const compiler = new LatexCompiler({ timeoutMs: 5_000, runner: scripted.runner });

    const result = await compiler.compile(dirs);
    expect(result.ok).toBe(true);
    const xelatexCount = compileCalls(scripted).filter((call) => call.command === "xelatex").length;
    expect(xelatexCount).toBe(4);
  });

  it("natbib 措辞的 Rerun 提示（Rerun to get citations correct）同样触发追加轮次", async () => {
    const dirs = await newProjectDirs();
    // M9.5.1 实测：natbib 用自己的措辞，只匹配 cross-references 会漏判 → 提前收敛
    const scripted = makeRunner({
      rerunAfter: [false, true, false],
      rerunHint: "Package natbib Warning: There were undefined citations.\n(natbib)                Rerun to get citations correct.",
    });
    const compiler = new LatexCompiler({ timeoutMs: 5_000, runner: scripted.runner });

    const result = await compiler.compile(dirs);
    expect(result.ok).toBe(true);
    const commands = compileCalls(scripted).map((call) => call.command);
    expect(commands).toEqual(["xelatex", "bibtex", "xelatex", "xelatex"]);
  });

  it("重复 build：两次编译的命令序列完全一致，staging 清理旧 TeX 产物", async () => {
    const dirs = await newProjectDirs();
    // 不编程 Rerun（fake 的 rerunAfter 按全局轮次计数，跨 compile 有状态）：
    // 序列 pass1 → bibtex → pass2 收敛，两次完全一致
    const scripted = makeRunner();
    const compiler = new LatexCompiler({ timeoutMs: 5_000, runner: scripted.runner });

    await compiler.compile(dirs);
    const firstRun = [...scripted.calls];

    // 留下「过期产物」：白名单内的 stale.pdf 应在第二次编译前被清理；非 TeX 文件保留
    await writeFile(join(dirs.buildDir, "stale.pdf"), Buffer.from("stale"));
    await writeFile(join(dirs.buildDir, "keep.json"), "{}", "utf8");

    const result2 = await compiler.compile(dirs);
    expect(result2.ok).toBe(true);

    // 第二次调用序列与第一次逐项一致（确定性编排，不受残留影响）
    const firstSequence = firstRun.map((call) => `${call.command} ${call.args.join(" ")}`);
    const secondSequence = scripted.calls
      .slice(firstRun.length)
      .map((call) => `${call.command} ${call.args.join(" ")}`);
    expect(secondSequence).toEqual(firstSequence);

    // stale.pdf 已清理；keep.json 保留
    await expect(readFile(join(dirs.buildDir, "stale.pdf"))).rejects.toBeTruthy();
    await expect(readFile(join(dirs.buildDir, "keep.json"))).resolves.toBeTruthy();
  });

  it(
    "真实编译集成（本机/CI 镜像有 xelatex+bibtex 时执行）：最小 bib 项目渲染出参考文献",
    { timeout: 120_000 },
    async () => {
    const dirs = await newProjectDirs();
    // 真实 spawn：探测本机工具链，缺 TeX 的环境跳过（行为明确，不假失败）
    const probeCompiler = new LatexCompiler({ timeoutMs: 10_000 });
    let toolsAvailable = true;
    try {
      const tool = await probeCompiler.detectTool();
      toolsAvailable = tool === "xelatex+bibtex";
    } catch {
      toolsAvailable = false;
    }
    if (!toolsAvailable) {
      return;
    }

    const compiler = new LatexCompiler({ timeoutMs: 120_000 });
    const result = await compiler.compile(dirs);

    expect(result.ok).toBe(true);
    expect(result.tool).toBe("xelatex+bibtex");

    // bbl 真实生成且含条目
    const bbl = await readFile(join(dirs.buildDir, "main.bbl"), "utf8");
    expect(bbl).toContain("bibitem");
    expect(bbl).toContain("kim2019comparison");

    // main.log 无未解析引用（citation 编号全部落定）
    const texLog = await readFile(join(dirs.buildDir, "main.log"), "utf8");
    expect(texLog).not.toMatch(/Citation `[^']+' on page \d+ undefined/);

    // PDF 真实存在且非空
    const pdfStat = await readFile(result.pdfPath!);
    expect(pdfStat.length).toBeGreaterThan(1000);
    },
  );
});
