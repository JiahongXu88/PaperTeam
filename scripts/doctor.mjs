#!/usr/bin/env node
/**
 * PaperTeam 部署环境自检（`npm run doctor`）。
 *
 * M12 Batch 3 起区分两种形态（development / deployment）：
 *   development（默认）——本机开发：宿主机依赖逐项 FAIL 级检查（原语义不变）；
 *   deployment=docker   ——Docker 生产部署（PAPERTEAM_DEPLOYMENT=docker 显式，
 *                          或自动检测到本仓库 compose 服务在运行）：宿主机
 *                          node_modules / TeX / Python 不是运行时依赖（前端已
 *                          预编译进 web 镜像、后端依赖与工具链在 backend 镜像
 *                          内，镜像构建期已 kpsewhich 三验），改为检查真正必要
 *                          的运行时事实：docker CLI / compose 服务健康 / 同源
 *                          /health+/ready / 数据 volume 在位；
 *   deployment=native   ——原生 systemd 部署：后端依赖仍 FAIL 级（真实运行时），
 *                          前端构建依赖降为 WARN（静态产物可在他处构建）。
 *
 * 逐项检查并给出可操作的修复建议，不修改任何东西（探测文件写后即删）：
 *   1. Node 版本（复用根 package.json engines.node）
 *   2. 依赖：development = backend/frontend node_modules；deployment 按上述降级
 *   3. 数据根可写（development/native；docker 形态查 named volume）
 *   4. TeX 工具链：xelatex / bibtex（FAIL）+ kpsewhich 五包（WARN）
 *      + FigureCompiler 真实编译探针（standalone+pgfplots 最小图；dev/native）
 *   5. PDF 解析工具链：Python 3 + pymupdf（development/native FAIL；docker 跳过）
 *   6. docling（可选；WARN）
 *   7. 模型配置（development/native；docker 形态由 /ready 覆盖，跳过）
 *   8. deployment=docker：docker CLI / compose 服务 / /health /ready / volumes
 *
 * 三档结论（optional capability 不阻断）：
 *   PASS  正常
 *   WARN  可选能力缺失 / 降级——可运行，按需修复
 *   FAIL  阻断（核心能力不可用）
 *
 * 退出码：无 FAIL = 0（允许有 WARN）；有 FAIL = 1。
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
function run(command, args, timeoutMs = 20_000, cwd = process.cwd()) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

// ---- 部署形态检测（M12 Batch 3：development / deployment=docker / deployment=native） ----

/**
 * 形态判定（优先级）：PAPERTEAM_DEPLOYMENT 显式 > 自动检测（本仓库 compose
 * 有正在运行的 paperteam 服务）> development。docker CLI 不可用 / 无 compose
 * 文件 / 服务未运行 → 一律落回 development（保守——不因检测失败改变检查语义）。
 */
function detectDeploymentMode() {
  const explicit = process.env.PAPERTEAM_DEPLOYMENT?.trim();
  if (explicit === "docker" || explicit === "native") {
    return explicit;
  }
  if (explicit !== undefined && explicit !== "") {
    // 显式给了非法值：如实按未知处理（不静默吞），回落 development 并提示
    // （显式设置过形态就不再自动检测——提示语与行为必须一致）
    console.log(`[WARN] PAPERTEAM_DEPLOYMENT="${explicit}" 不是合法值（docker | native）——按 development 检查`);
    return "development";
  }
  if (!existsSync(join(repoRoot, "compose.yml"))) {
    return "development";
  }
  const compose = run("docker", ["compose", "ps", "--format", "json"], 15_000, repoRoot);
  if (compose === null || compose.trim() === "") {
    return "development";
  }
  try {
    // compose v2 --format json：多服务时逐行 JSON（json-lines），单服务时单个对象
    const services = compose
      .trim()
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
    const paperteamRunning = services.some(
      (service) =>
        typeof service.Name === "string" &&
        service.Name.includes("paperteam") &&
        (service.State === "running" || String(service.Status ?? "").toLowerCase().includes("up")),
    );
    return paperteamRunning ? "docker" : "development";
  } catch {
    return "development";
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

/**
 * 依赖检查（形态感知）：
 * - development：backend / frontend node_modules 均为 FAIL 级（本机开发需要）；
 * - deployment=docker：宿主机依赖不是运行时事实（前端预编译进 web 镜像，
 *   后端依赖在 backend 镜像）→ PASS 说明项，不再误报；
 * - deployment=native：backend 依赖仍 FAIL（dist 运行时）；frontend 依赖降
 *   WARN（静态产物可在他处构建后拷入）。
 */
function checkDeps(mode) {
  if (mode === "docker") {
    report(
      "backend / frontend 依赖",
      "PASS",
      "部署模式（docker）：前端已预编译进独立 web 镜像、后端依赖与工具链在 backend 镜像内——宿主机无需 node_modules",
    );
    return;
  }
  const backendOk = existsSync(join(repoRoot, "backend", "node_modules", "@earendil-works"));
  report("backend 依赖", backendOk ? "PASS" : "FAIL", backendOk ? "已安装" : "缺失", backendOk ? undefined : "cd backend && npm install");
  const frontendOk = existsSync(join(repoRoot, "frontend", "node_modules", "vite"));
  if (mode === "native") {
    report(
      "frontend 依赖",
      frontendOk ? "PASS" : "WARN",
      frontendOk ? "已安装" : "缺失（原生部署的运行时不需要——仅在本机构建前端产物时需要）",
      frontendOk ? undefined : "如需本机构建：cd frontend && npm install && npm run build",
    );
    return;
  }
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

function checkDataRoots(mode) {
  if (mode === "docker") {
    // docker 形态：事实源是 named volume（宿主机路径无意义）；检查 volume 在位
    const volumes = run("docker", ["volume", "ls", "--format", "{{.Name}}"], 15_000);
    if (volumes === null) {
      report("数据 volume", "WARN", "docker CLI 不可用，无法检查 named volume（容器 /ready 会做可写探测兜底）");
      return;
    }
    const names = volumes.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
    const project = names.find((name) => /paperteam.*projects/.test(name));
    const runtime = names.find((name) => /paperteam.*runtime/.test(name));
    if (project !== undefined && runtime !== undefined) {
      report("数据 volume", "PASS", `${project} + ${runtime} 在位`);
    } else {
      report(
        "数据 volume",
        "WARN",
        `未找到 paperteam projects/runtime volume（现有：${names.filter((n) => n.includes("paperteam")).join("、") || "无"}）——若使用宿主机 bind mount 可忽略本项`,
      );
    }
    return;
  }
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
function checkTexToolchain(mode) {
  if (mode === "docker") {
    report(
      "TeX 工具链",
      "PASS",
      "部署模式（docker）：xelatex / bibtex / pgfplots / tikz / standalone 在 backend 镜像内（构建期 kpsewhich 三验 + CI 图表编译 smoke）",
    );
    return;
  }
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

/**
 * FigureCompiler 真实编译探针（M12 Batch 3 C6 补齐）：standalone + pgfplots
 * 最小数据图真实编译一次（dev / native；docker 形态由镜像构建期验证 + CI
 * figure-smoke 覆盖）。宏包探测只能证明文件在位——真实编译才能发现格式
 * 版本 / 字体 / 权限类问题。失败 = WARN（图表能力降级，手稿链路不受影响）。
 */
function checkFigureCompileProbe(mode) {
  if (mode === "docker") {
    report(
      "图表编译探针",
      "PASS",
      "部署模式（docker）：图表编译能力由镜像构建期 kpsewhich 三验 + CI figure-smoke（5 用例含 CJK）覆盖",
    );
    return;
  }
  if (run("xelatex", ["--version"]) === null) {
    return; // 无 xelatex 时上面的 FAIL 已覆盖，不重复报
  }
  let buildDir;
  try {
    buildDir = mkdtempSync(join(tmpdir(), "paperteam-doctor-figure-"));
    const tex = [
      "\\documentclass[border=2pt]{standalone}",
      "\\usepackage{pgfplots}",
      "\\pgfplotsset{compat=1.18}",
      "\\begin{document}",
      "\\begin{tikzpicture}",
      "\\begin{axis}[xlabel={x}, ylabel={y}]",
      "\\addplot+ coordinates {(0,0) (1,2) (2,1)};",
      "\\end{axis}",
      "\\end{tikzpicture}",
      "\\end{document}",
    ].join("\n");
    writeFileSync(join(buildDir, "probe.tex"), tex, "utf8");
    const result = run("xelatex", ["-interaction=nonstopmode", "-halt-on-error", "probe.tex"], 60_000, buildDir);
    const pdfOk = existsSync(join(buildDir, "probe.pdf"));
    if (result !== null && pdfOk) {
      report("图表编译探针", "PASS", "standalone + pgfplots 最小图真实编译通过（FigureCompiler 同链路）");
    } else {
      const logLines = result?.split(/\r?\n/).filter((line) => line.trim().startsWith("!")).slice(0, 3).join(" | ") ?? "无错误行输出";
      report(
        "图表编译探针",
        "WARN",
        `真实编译未产出 PDF（${logLines}）——图表生成不可用，手稿 PDF 不受影响`,
        "按上方 TeX 宏包 WARN 的安装建议修复（texlive-pictures / texlive-latex-extra）",
      );
    }
  } catch (error) {
    report("图表编译探针", "WARN", `探针执行失败：${String(error)}`);
  } finally {
    if (buildDir !== undefined) {
      rmSync(buildDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
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

function checkPdfToolchain(mode) {
  if (mode === "docker") {
    report("PDF 解析工具链", "PASS", "部署模式（docker）：python3 + pymupdf 在 backend 镜像内（构建期 import 验证）");
    return null;
  }
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
function checkDocling(pdfInterpreter, mode) {
  if (mode === "docker") {
    const doclingPython = process.env.PAPERTEAM_DOCLING_PYTHON?.trim();
    // 宿主机 doctor 看不到容器内 venv——用容器内解释器探测判定（镜像名字段
    // 可能是 sha256 digest，不可靠；backend-docling 镜像的 venv 路径是事实源）
    const probe = run(
      "docker",
      ["compose", "exec", "-T", "backend", "sh", "-c", "test -x /opt/paperteam-docling-venv/bin/python && echo yes"],
      20_000,
      repoRoot,
    );
    const doclingAvailable = probe !== null && probe.trim() === "yes";
    report(
      "docling 结构化解析",
      "PASS",
      doclingPython !== undefined
        ? `部署模式（docker）：PAPERTEAM_DOCLING_PYTHON=${doclingPython}（镜像内置）`
        : doclingAvailable
          ? "部署模式（docker）：backend-docling 镜像在运行（容器内 docling venv 在位，结构化解析可用）"
          : "部署模式（docker）：backend 基镜像为 pymupdf 文本层（结构化解析用 backend-docling 镜像）",
    );
    return;
  }
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
function checkModelConfig(mode) {
  if (mode === "docker") {
    report(
      "模型配置",
      "PASS",
      "部署模式（docker）：模型配置保存在容器 volume（runtime）内——由 /ready 与浏览器 Settings → 测试连接 验证",
    );
    return;
  }
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

/** deployment=docker：真正必要的运行时事实——compose 服务 + 同源 /health + /ready */
async function checkDockerServices(mode) {
  if (mode !== "docker") {
    return;
  }
  const dockerAvailable = run("docker", ["--version"], 10_000) !== null;
  if (!dockerAvailable) {
    report("docker CLI", "WARN", "不可用——无法检查 compose 服务与容器健康（docker compose ps / logs 自行确认）");
    return;
  }
  ;
  const compose = run("docker", ["compose", "ps", "--format", "json"], 15_000, repoRoot);
  if (compose === null) {
    report("compose 服务", "FAIL", "docker compose ps 失败（compose 文件损坏或 docker daemon 未运行）", "docker compose ps / docker compose logs backend 排查");
    return;
  }
  const services = compose
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((service) => service !== null);
  if (services.length === 0) {
    report("compose 服务", "FAIL", "compose 项目内没有运行中的服务（docker compose up -d）", "docker compose up -d && docker compose ps");
    return;
  }
  const unhealthy = services.filter(
    (service) => service.State !== "running" || String(service.Health ?? service.Status ?? "").toLowerCase().includes("unhealthy"),
  );
  if (unhealthy.length > 0) {
    report(
      "compose 服务",
      "FAIL",
      `${unhealthy.length}/${services.length} 服务不在运行态：${unhealthy.map((s) => `${s.Name}(${s.State}${s.Health ? "/" + s.Health : ""})`).join("、")}`,
      "docker compose logs <service> 查看原因",
    );
  } else {
    report("compose 服务", "PASS", services.map((service) => `${service.Name}(${service.State}${service.Health ? "/" + service.Health : ""})`).join("、"));
  }

  // 同源 web 端点（PAPERTEAM_WEB_PORT 允许 "127.0.0.1:8080" 形态）
  const webPortRaw = process.env.PAPERTEAM_WEB_PORT?.trim() || "8080";
  const port = webPortRaw.split(":").pop() ?? "8080";
  const endpoints = [
    ["/health", '"status":"ok"'],
    ["/ready", '"ready":true'],
  ];
  for (const [path, expect] of endpoints) {
    const url = `http://127.0.0.1:${port}${path}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      const body = await response.text();
      if (response.ok && body.includes(expect.replace(/\s/g, ""))) {
        report(`web ${path}`, "PASS", `${url} → ${body.slice(0, 80)}`);
      } else if (response.ok) {
        report(`web ${path}`, "WARN", `${url} → ${body.slice(0, 120)}（未含期望字段 ${expect}；ready 降级详见 body 的 degraded 说明）`);
      } else {
        report(`web ${path}`, "FAIL", `${url} → HTTP ${response.status}`, "docker compose logs backend / web 排查");
      }
    } catch (error) {
      report(`web ${path}`, "FAIL", `${url} 不可达（${String(error).slice(0, 80)}）`, "SSH 隧道 -L 8080:127.0.0.1:8080 后再访问；或检查 PAPERTEAM_WEB_PORT");
    }
  }
}

function checkGit() {
  try {
    const head = run("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"]);
    report("Git", "PASS", head === null ? "非 git 工作区（不影响运行）" : `HEAD ${head.trim()}`);
  } catch {
    report("Git", "PASS", "非 git 工作区（不影响运行）");
  }
}

const mode = detectDeploymentMode();
console.log(`PaperTeam doctor（${repoRoot}）`);
console.log(`平台 ${process.platform}；检查形态 ${mode}${mode === "docker" ? "（deployment；PAPERTEAM_DEPLOYMENT=docker 可显式锁定）" : ""}；数据根解析基于当前目录 ${process.cwd()}\n`);
checkNode();
checkDeps(mode);
checkDataRoots(mode);
checkTexToolchain(mode);
checkFigureCompileProbe(mode);
const pdfInterpreter = checkPdfToolchain(mode);
checkDocling(pdfInterpreter, mode);
checkModelConfig(mode);
await checkDockerServices(mode);
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
