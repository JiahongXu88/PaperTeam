#!/usr/bin/env node
/**
 * PaperTeam 环境自检（`npm run doctor`）。
 *
 * 逐项检查并给出可操作的修复建议，不修改任何东西：
 *   1. Node 版本（复用根 package.json engines.node）
 *   2. backend / frontend 依赖是否已安装
 *   3. PDF 解析工具链：Python 3 解释器 + pymupdf（Backend 的 PdfToolchain 用同一组候选：
 *      PAPERTEAM_PDF_PYTHON > python > python3 > py -3）
 *
 * 退出码：全部通过 0；有阻塞项 1。
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const PYTHON_CANDIDATES = [
  { command: "python", args: [] },
  { command: "python3", args: [] },
  { command: "py", args: ["-3"] },
];

const PROBE =
  "import sys, json\n" +
  "info = {'python': sys.version.split()[0]}\n" +
  "try:\n    import pymupdf\n    info['pymupdf'] = getattr(pymupdf, '__version__', 'unknown')\n" +
  "except ImportError:\n    info['pymupdf'] = None\n" +
  "print(json.dumps(info))\n";

const results = [];

function report(name, ok, detail, hint) {
  results.push({ name, ok, detail, hint });
  const mark = ok ? "OK  " : "FAIL";
  console.log(`[${mark}] ${name}：${detail}`);
  if (!ok && hint) {
    console.log(`       → ${hint}`);
  }
}

function checkNode() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const engines = pkg?.engines?.node ?? "(未声明)";
  // 只做主版本粗检：细粒度范围由 dev.mjs 的解析器负责
  const major = Number(process.versions.node.split(".")[0]);
  const ok = major >= 22;
  report("Node.js", ok, `当前 ${process.versions.node}（要求 ${engines}）`, ok ? undefined : "请安装 Node 22 LTS 或更高版本");
}

function checkDeps() {
  const backendOk = existsSync(join(repoRoot, "backend", "node_modules", "@earendil-works"));
  report("backend 依赖", backendOk, backendOk ? "已安装" : "缺失", backendOk ? undefined : "cd backend && npm install");
  const frontendOk = existsSync(join(repoRoot, "frontend", "node_modules", "vite"));
  report("frontend 依赖", frontendOk, frontendOk ? "已安装" : "缺失", frontendOk ? undefined : "cd frontend && npm install");
}

function probe(command, args) {
  const result = spawnSync(command, [...args, "-c", PROBE], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf8" },
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  const last = result.stdout.trim().split(/\r?\n/).pop() ?? "";
  try {
    const parsed = JSON.parse(last);
    return typeof parsed.python === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function checkPdfToolchain() {
  const explicit = process.env.PAPERTEAM_PDF_PYTHON?.trim();
  const candidates = explicit ? [{ command: explicit, args: [] }] : PYTHON_CANDIDATES;
  let pythonWithoutPymupdf = null;
  for (const candidate of candidates) {
    const info = probe(candidate.command, candidate.args);
    if (info === null) {
      continue;
    }
    if (info.pymupdf) {
      report(
        "PDF 解析工具链",
        true,
        `${candidate.command} ${candidate.args.join(" ")}（Python ${info.python}，pymupdf ${info.pymupdf}）`,
      );
      return;
    }
    pythonWithoutPymupdf ??= { ...candidate, version: info.python };
  }
  if (pythonWithoutPymupdf !== null) {
    const py = [pythonWithoutPymupdf.command, ...pythonWithoutPymupdf.args].join(" ");
    report(
      "PDF 解析工具链",
      false,
      `找到 Python ${pythonWithoutPymupdf.version}（${py}）但缺少 pymupdf`,
      `${py} -m pip install pymupdf`,
    );
    return;
  }
  report(
    "PDF 解析工具链",
    false,
    explicit ? `PAPERTEAM_PDF_PYTHON=${explicit} 无法执行` : "未找到 python / python3 / py 解释器",
    "安装 Python 3.10+（https://www.python.org/downloads/，勾选 Add to PATH）后执行 pip install pymupdf；或设置 PAPERTEAM_PDF_PYTHON 指向解释器",
  );
}

function checkGit() {
  try {
    const head = execFileSync("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    report("Git", true, `HEAD ${head}`);
  } catch {
    report("Git", true, "非 git 工作区（不影响运行）");
  }
}

console.log(`PaperTeam doctor（${repoRoot}）`);
checkNode();
checkDeps();
checkPdfToolchain();
checkGit();

const failures = results.filter((item) => !item.ok);
console.log(failures.length === 0 ? "\n全部检查通过。" : `\n${failures.length} 项需要处理（见上方建议）。`);
process.exit(failures.length === 0 ? 0 : 1);
