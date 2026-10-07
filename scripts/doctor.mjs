#!/usr/bin/env node
/**
 * PaperTeam 部署环境自检（`npm run doctor`；M12.2.5 扩展为 dual-runtime doctor）。
 *
 * 逐项检查并给出可操作的修复建议，不修改任何东西（探测文件写后即删）：
 *   1. Node 版本（复用根 package.json engines.node）
 *   2. backend / frontend 依赖是否已安装
 *   3. 数据根可写：PROJECTS_ROOT（默认 ./projects，与 backend config 同解析
 *      规则）+ PAPERTEAM_RUNTIME_ROOT（默认 ~/.paperteam）
 *   4. TeX 工具链：xelatex / bibtex（缺 = FAIL——手稿 PDF 生成必需）+
 *      kpsewhich 探测 standalone / pgfplots / tikz / ctexart / Fandol 字体
 *      （缺 = WARN——图表 / 中文能力降级，附平台安装建议）
 *   5. PDF 解析工具链：Python 3 + pymupdf（与 Backend PdfToolchain 同候选：
 *      PAPERTEAM_PDF_PYTHON > python > python3 > py -3）
 *   6. docling（可选；缺 = WARN——结构化解析自动降级 pymupdf 文本层）
 *   7. 模型配置：PAPERTEAM_PI_MODEL 环境变量或 <runtimeRoot>/settings/model.json；
 *      只报「已配置/未配置」与配置来源，绝不打印 Key 或文件内容
 *
 * 三档结论（optional capability 不阻断）：
 *   PASS  正常
 *   WARN  可选能力缺失 / 降级——可运行，按需修复
 *   FAIL  阻断（核心能力不可用）
 *
 * 退出码：无 FAIL = 0（允许有 WARN）；有 FAIL = 1。
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const PYTHON_CANDIDATES = [
  { command: "python", args: [] },
  { command: "python3", args: [] },
  { command: "py", args: ["-3"] },
];

/** 三档检查项（结构化输出；hint 只在非 PASS 时有意义） */
const results = [];

function report(name, status, detail, hint) {
  results.push({ name, status, detail, hint });
  const mark = status === "PASS" ? "OK  " : status === "WARN" ? "WARN" : "FAIL";
  console.log(`[${mark}] ${name}：${detail.trimEnd()}`);
  if (status !== "PASS" && hint) {
    console.log(`       → ${hint}`);
  }
}

/** 同步跑外部命令；失败返回 null（探测类检查不区分失败原因；stderr 静默） */
function run(command, args, timeoutMs = 20_000) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function checkNode() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const engines = pkg?.engines?.node ?? "(未声明)";
  // 只做主版本粗检：细粒度范围由 dev.mjs 的解析器负责
  const major = Number(process.versions.node.split(".")[0]);
  const ok = major >= 22;
  report("Node.js", ok ? "PASS" : "FAIL", `当前 ${process.versions.node}（要求 ${engines}）`, ok ? undefined : "请安装 Node 22 LTS 或更高版本");
}

function checkDeps() {
  const backendOk = existsSync(join(repoRoot, "backend", "node_modules", "@earendil-works"));
  report("backend 依赖", backendOk ? "PASS" : "FAIL", backendOk ? "已安装" : "缺失", backendOk ? undefined : "cd backend && npm install");
  const frontendOk = existsSync(join(repoRoot, "frontend", "node_modules", "vite"));
  report("frontend 依赖", frontendOk ? "PASS" : "FAIL", frontendOk ? "已安装" : "缺失", frontendOk ? undefined : "cd frontend && npm install");
}

/** 目录可写探测：mkdir -p + 写探测文件 + 删除（与 /ready 的 ReadinessProbe 同口径） */
function dirWritable(path) {
  try {
    mkdirSync(path, { recursive: true });
    const probe = join(path, `.paperteam-doctor-${process.pid}`);
    writeFileSync(probe, "ok", "utf8");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 与 backend/src/config/config.ts 同解析规则的两个数据根 */
function resolveDataRoots() {
  const projectsRaw = process.env.PROJECTS_ROOT?.trim() || "./projects";
  const projectsRoot = resolve(process.cwd(), projectsRaw);
  const runtimeOverride = process.env.PAPERTEAM_RUNTIME_ROOT?.trim();
  let runtimeRoot;
  if (runtimeOverride) {
    runtimeRoot = isAbsolute(runtimeOverride) ? resolve(runtimeOverride) : null; // 后端会拒绝相对路径
  } else {
    runtimeRoot = join(homedir(), ".paperteam");
  }
  return { projectsRoot, runtimeRoot, runtimeOverride };
}

function checkDataRoots() {
  const { projectsRoot, runtimeRoot, runtimeOverride } = resolveDataRoots();
  const projectsOk = dirWritable(projectsRoot);
  report(
    "数据根 PROJECTS_ROOT",
    projectsOk ? "PASS" : "FAIL",
    `${projectsRoot}${projectsOk ? "（可写）" : "（不可写）"}`,
    projectsOk ? undefined : "检查目录权限，或在 .env 设置 PROJECTS_ROOT 指向可写目录（绝对路径）",
  );
  if (runtimeRoot === null) {
    report("数据根 PAPERTEAM_RUNTIME_ROOT", "FAIL", `相对路径 "${runtimeOverride}"（后端要求绝对路径）`, "设置 PAPERTEAM_RUNTIME_ROOT 为绝对路径");
    return;
  }
  const runtimeOk = dirWritable(runtimeRoot);
  report(
    "数据根 PAPERTEAM_RUNTIME_ROOT",
    runtimeOk ? "PASS" : "FAIL",
    `${runtimeRoot}${runtimeOk ? "（可写）" : "（不可写）"}`,
    runtimeOk ? undefined : "检查目录权限，或设置 PAPERTEAM_RUNTIME_ROOT 指向可写目录（绝对路径）",
  );
}

/** xelatex / bibtex（FAIL 级）+ 图表/中文宏包与字体（WARN 级） */
function checkTexToolchain() {
  const xelatexVersion = run("xelatex", ["--version"]);
  report(
    "xelatex",
    xelatexVersion === null ? "FAIL" : "PASS",
    xelatexVersion === null ? "PATH 中未找到" : xelatexVersion.split(/\r?\n/)[0]?.slice(0, 80) ?? "可用",
    xelatexVersion === null
      ? "Windows 安装 MiKTeX（https://miktex.org）；Linux/Ubuntu 安装 texlive-xetex（apt install texlive-xetex）；Docker 镜像已内置"
      : undefined,
  );
  const bibtexVersion = run("bibtex", ["--version"]);
  report(
    "bibtex",
    bibtexVersion === null ? "FAIL" : "PASS",
    bibtexVersion === null ? "PATH 中未找到" : bibtexVersion.split(/\r?\n/)[0]?.slice(0, 80) ?? "可用",
    bibtexVersion === null ? "MiKTeX / texlive-bibtex-base 均随主发行版安装" : undefined,
  );
  if (xelatexVersion === null) {
    return; // 无 TeX 时宏包探测无意义（kpsewhich 同样缺失）
  }
  // 宏包 / 字体（kpsewhich；缺 = WARN——核心手稿链路不依赖这些）
  const packages = [
    { file: "standalone.cls", label: "standalone（图表模板）", hint: "TeX Live/Ubuntu: apt install texlive-latex-extra；MiKTeX 首次编译自动安装" },
    { file: "pgfplots.sty", label: "pgfplots（数据图）", hint: "TeX Live/Ubuntu: apt install texlive-pictures；MiKTeX 自动安装" },
    { file: "tikz.sty", label: "tikz（结构图）", hint: "TeX Live/Ubuntu: apt install texlive-pictures；MiKTeX 自动安装" },
    { file: "ctexart.cls", label: "ctexart（中文手稿模板）", hint: "TeX Live/Ubuntu: apt install texlive-lang-chinese；MiKTeX 自动安装" },
    { file: "FandolSong-Regular.otf", label: "Fandol 中文字体（Linux 中文渲染）", hint: "TeX Live/Ubuntu: apt install texlive-lang-chinese；MiKTeX/Windows 用系统字体不受影响" },
  ];
  for (const pkg of packages) {
    const found = run("kpsewhich", [pkg.file], 15_000);
    report(`TeX ${pkg.label}`, found === null ? "WARN" : "PASS", found === null ? `kpsewhich 未找到 ${pkg.file}` : `kpsewhich ${found.trim().split(/\r?\n/)[0]}`, found === null ? pkg.hint : undefined);
  }
}

const PDF_PROBE =
  "import sys, json\n" +
  "info = {'python': sys.version.split()[0]}\n" +
  "try:\n    import pymupdf\n    info['pymupdf'] = getattr(pymupdf, '__version__', 'unknown')\n" +
  "except ImportError:\n    info['pymupdf'] = None\n" +
  "print(json.dumps(info))\n";

const DOCLING_PROBE = "import docling, json\nprint(json.dumps({'docling': getattr(docling, '__version__', 'unknown')}))\n";

function probePython(command, args, script) {
  const result = spawnSync(command, [...args, "-c", script], {
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf8" },
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  const last = result.stdout.trim().split(/\r?\n/).pop() ?? "";
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}

function checkPdfToolchain() {
  const explicit = process.env.PAPERTEAM_PDF_PYTHON?.trim();
  const candidates = explicit ? [{ command: explicit, args: [] }] : PYTHON_CANDIDATES;
  let pythonWithoutPymupdf = null;
  for (const candidate of candidates) {
    const info = probePython(candidate.command, candidate.args, PDF_PROBE);
    if (info === null || typeof info.python !== "string") {
      continue;
    }
    if (info.pymupdf) {
      report(
        "PDF 解析工具链",
        "PASS",
        `${candidate.command} ${candidate.args.join(" ")}（Python ${info.python}，pymupdf ${info.pymupdf}）`,
      );
      return { command: candidate.command, args: candidate.args };
    }
    pythonWithoutPymupdf ??= { ...candidate, version: info.python };
  }
  if (pythonWithoutPymupdf !== null) {
    const py = [pythonWithoutPymupdf.command, ...pythonWithoutPymupdf.args].join(" ");
    report(
      "PDF 解析工具链",
      "FAIL",
      `找到 Python ${pythonWithoutPymupdf.version}（${py}）但缺少 pymupdf`,
      `${py} -m pip install pymupdf`,
    );
    return null;
  }
  report(
    "PDF 解析工具链",
    "FAIL",
    explicit ? `PAPERTEAM_PDF_PYTHON=${explicit} 无法执行` : "未找到 python / python3 / py 解释器",
    "安装 Python 3.10+（https://www.python.org/downloads/，勾选 Add to PATH）后执行 pip install pymupdf；或设置 PAPERTEAM_PDF_PYTHON 指向解释器",
  );
  return null;
}

/** docling 是可选能力：缺 = WARN（结构化解析自动降级 pymupdf 文本层） */
function checkDocling(pdfInterpreter) {
  const explicit = process.env.PAPERTEAM_DOCLING_PYTHON?.trim();
  const candidates = [];
  if (explicit) {
    candidates.push({ command: explicit, args: [] });
  } else if (pdfInterpreter !== null) {
    candidates.push(pdfInterpreter);
  }
  candidates.push(...PYTHON_CANDIDATES);
  for (const candidate of candidates) {
    const info = probePython(candidate.command, candidate.args, DOCLING_PROBE);
    if (info !== null && typeof info.docling === "string") {
      report(
        "docling 结构化解析",
        "PASS",
        `${candidate.command} ${candidate.args.join(" ")}（docling ${info.docling}）`,
      );
      return;
    }
  }
  report(
    "docling 结构化解析",
    "WARN",
    "未安装（PDF 解析将降级 pymupdf 文本层：无版面 / 表格结构 / 图片抽取）",
    "pip install docling（约 4GB，含 torch）；Docker 用 backend-docling 镜像（compose 设置 PAPERTEAM_BACKEND_IMAGE）；首次解析从 HuggingFace 下载模型，国内可设 HF_ENDPOINT=https://hf-mirror.com",
  );
}

/** 模型配置只报状态与来源；绝不读取 / 打印 auth.json 内容或任何 Key */
function checkModelConfig() {
  const { runtimeRoot } = resolveDataRoots();
  if (runtimeRoot === null) {
    return; // 相对路径错误已在数据根检查 FAIL，这里不重复
  }
  const envModel = process.env.PAPERTEAM_PI_MODEL?.trim();
  let storedModel = null;
  try {
    const settings = JSON.parse(readFileSync(join(runtimeRoot, "settings", "model.json"), "utf8"));
    storedModel = typeof settings.model === "string" && settings.model !== "" ? settings.model : null;
  } catch {
    storedModel = null; // 未配置 / 文件不存在都归一为 null
  }
  if (envModel !== undefined && envModel !== "") {
    report("模型配置", "PASS", `PAPERTEAM_PI_MODEL=${envModel}（环境变量优先）`);
    return;
  }
  if (storedModel !== null) {
    const authConfigured = existsSync(join(runtimeRoot, "runtime", "pi", "agent", "auth.json"));
    report(
      "模型配置",
      "PASS",
      `${storedModel}（${runtimeRoot} 本地保存${authConfigured ? "；auth.json 已配置" : "；auth.json 未配置——Settings → 模型设置 保存 Key"}）`,
    );
    return;
  }
  report(
    "模型配置",
    "WARN",
    "未配置（Runtime 健康，但 Agent 调用会 not_configured）",
    "前端 Settings → 模型设置 保存（推荐；落到本机 runtime root），或设置 PAPERTEAM_PI_MODEL / PAPERTEAM_PI_API_KEY 环境变量",
  );
}

function checkGit() {
  try {
    const head = run("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"]);
    report("Git", "PASS", head === null ? "非 git 工作区（不影响运行）" : `HEAD ${head.trim()}`);
  } catch {
    report("Git", "PASS", "非 git 工作区（不影响运行）");
  }
}

console.log(`PaperTeam doctor（${repoRoot}）`);
console.log(`平台 ${process.platform}；数据根解析基于当前目录 ${process.cwd()}\n`);
checkNode();
checkDeps();
checkDataRoots();
checkTexToolchain();
const pdfInterpreter = checkPdfToolchain();
checkDocling(pdfInterpreter);
checkModelConfig();
checkGit();

const failures = results.filter((item) => item.status === "FAIL");
const warnings = results.filter((item) => item.status === "WARN");
if (failures.length === 0 && warnings.length === 0) {
  console.log("\n全部检查通过。");
} else if (failures.length === 0) {
  console.log(`\n无阻断项；${warnings.length} 项 WARN（可选能力降级，可运行）。`);
} else {
  console.log(`\n${failures.length} 项 FAIL 需要处理${warnings.length > 0 ? `；另有 ${warnings.length} 项 WARN` : ""}（见上方建议）。`);
}
process.exit(failures.length === 0 ? 0 : 1);
