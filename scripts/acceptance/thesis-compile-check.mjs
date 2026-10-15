#!/usr/bin/env node
/**
 * M14.1c 服务器真实编译验收：学位论文 fixture → generic-ctexbook → PDF。
 *
 * 在有 XeLaTeX 的环境执行（新加坡服务器 TeX Live；本机缺 TeX 时明确 SKIP）。
 * 验收项（对应任务 9.2）：
 *   1. 默认 generic-ctexbook 编译（bibtex + gbt7714 路径）
 *   2. Biber 路径（biblatex + biber 编译）
 *   3. 缺失引用时正确失败（\cite{missing} → 明确错误，PDF 不得宣称成功）
 *   4. 多轮编译后引用解析（PDF 文本含 [1] [2] 编号）
 *   5. 冷启动 vs 热启动耗时
 *   6. PDF 页面 / 目录 / 章节层级 / 双语摘要检查（pdftotext 文本级验证）
 *   7. 长章节内容不丢失（每章哨兵字符串在 PDF 文本中可检）
 *
 * 内容纪律：fixture 全部为明确标注的合成测试材料，不冒充真实学术成果。
 */

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

async function importBackend(rel) {
  return import(`file://${join(repoRoot, "backend", rel).replaceAll("\\", "/")}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (error) => resolve({ code: -1, stdout, stderr, error: error.message }));
  });
}

const CHAPTER_COUNT = 10;

const sectionFile = (chapter, section) => `ch${String(chapter).padStart(2, "0")}-s${section}.tex`;

/** 合成章节正文：\section 开头（Writer 契约）+ 公式 + 表格 + 交叉引用 + 文献引用 */
function sectionContent(chapter, section) {
  const label = `sec:c${chapter}s${section}`;
  // 偶数章有表；奇数章引用前一个偶数章的表（第 1 章 → 第 2 章的表）
  const tableTarget = chapter === 1 ? 2 : chapter - (chapter % 2);
  const lines = [
    `\\section{第${chapter}章第${section}节 合成测试节}\\label{${label}}`,
    `本节为合成测试内容（sentinel-ch${chapter}-s${section}），不代表真实研究成果。`,
    `文中公式：$E = \\alpha \\cdot L_{\\mathrm{cls}} + (1-\\alpha) \\cdot L_{\\mathrm{reg}}$。`,
    `如式~\\ref{eq:c${chapter}}~所示，混合损失在合成数据上收敛：`,
    `\\begin{equation}\\label{eq:c${chapter}}`,
    `L = \\sum_{i=1}^{N} \\left| y_i - \\hat{y}_i \\right|^2`,
    `\\end{equation}`,
    `本方法与文献~\\cite{synthetic-a}、\\cite{synthetic-b}~在合成协议下对照。`,
    `同章交叉引用见第~\\ref{sec:c${chapter}s1}~节。`,
  ];
  if (chapter % 2 === 0) {
    lines.push(
      `\\begin{table}[htbp]\\centering`,
      `\\caption{合成数据表（第${chapter}章）}\\label{tab:c${chapter}}`,
      `\\begin{tabular}{lc}\\hline 配置 & 数值 \\\\\\hline A & 12.3 \\\\ B & 45.6 \\\\\\hline\\end{tabular}`,
      `\\end{table}`,
    );
  }
  lines.push(`表~\\ref{tab:c${tableTarget}}~给出合成对照（交叉引用验证）。`);
  // 增加篇幅（长章节不丢失验收）：合成段落数组
  for (let i = 0; i < 6; i += 1) {
    lines.push(`合成段落 ${i + 1}：该段用于验证长章节在文档装配与多轮编译后完整保留，内容无学术含义（filler-${chapter}-${section}-${i}）。`);
  }
  return lines.join("\n") + "\n";
}

async function buildFixtureManuscript(root, { missingCitation = false } = {}) {
  const manuscriptDir = join(root, "manuscript");
  await mkdir(join(manuscriptDir, "sections"), { recursive: true });
  const sections = [];
  for (let chapter = 1; chapter <= CHAPTER_COUNT; chapter += 1) {
    // 第 10 章 = 单节 promoted 模式（节标题即章标题）；其余章 3 节 wrapper 模式
    const sectionCount = chapter === CHAPTER_COUNT ? 1 : 3;
    for (let s = 1; s <= sectionCount; s += 1) {
      const file = sectionFile(chapter, s);
      await writeFile(join(manuscriptDir, "sections", file), sectionContent(chapter, s), "utf8");
      sections.push({ file, title: file.replace(/\.tex$/, "") });
    }
  }
  await writeFile(
    join(manuscriptDir, "sections", "appendix-detail.tex"),
    "\\section{appendix-detail}\n附录合成内容（sentinel-appendix）：推导与补充材料，不代表真实研究成果。\n\\subsection{合成推导}\n合成推导内容（sentinel-appendix-derivation）。\n",
    "utf8",
  );
  sections.push({ file: "appendix-detail.tex", title: "appendix-detail" });
  if (missingCitation) {
    await writeFile(
      join(manuscriptDir, "sections", "bad-cite.tex"),
      "\\section{bad-cite}\n正文引用不存在的条目~\\cite{missing-entry-2026}。\n",
      "utf8",
    );
    sections.push({ file: "bad-cite.tex", title: "bad-cite" });
  }
  await writeFile(
    join(manuscriptDir, "references.bib"),
    [
      "@article{synthetic-a,",
      "  author = {Test, Author A},",
      "  title = {Synthetic Reference A for Compile Check},",
      "  journal = {Journal of Synthetic Testing},",
      "  year = {2026},",
      "}",
      "@article{synthetic-b,",
      "  author = {Test, Author B},",
      "  title = {Synthetic Reference B for Compile Check},",
      "  journal = {Journal of Synthetic Testing},",
      "  year = {2026},",
      "}",
    ].join("\n") + "\n",
    "utf8",
  );

  const outline = {
    title: "合成测试学位论文",
    sections: sections.map((entry, index) => ({ id: `s${index + 1}`, file: entry.file, title: entry.title })),
  };
  const chapters = [];
  for (let chapter = 1; chapter < CHAPTER_COUNT; chapter += 1) {
    chapters.push({
      chapterId: `ch${String(chapter).padStart(2, "0")}`,
      titleZh: `第${chapter}章 合成测试章`,
      sections: [1, 2, 3].map((s) => sectionFile(chapter, s)),
    });
  }
  // 第 10 章单节：promoted 模式要求章标题 = 节标题（outline title）
  chapters.push({ chapterId: "ch10", titleZh: "ch10-s1", sections: [sectionFile(CHAPTER_COUNT, 1)] });

  const model = {
    schemaVersion: 1,
    templateId: "generic-ctexbook",
    titleZh: "合成测试学位论文：模板与编译链验收",
    titleEn: "Synthetic Test Thesis for Template and Compile Chain Acceptance",
    abstractZh: "本论文为 PaperTeam M14.1c 编译验收的合成测试材料，全部内容不代表真实研究成果。关键词覆盖、双语摘要与多章结构均用于验收检查。",
    abstractEn: "This thesis is synthetic test material for the PaperTeam M14.1c compile acceptance. It does not represent real research.",
    keywordsZh: ["合成测试", "编译验收"],
    keywordsEn: ["synthetic test", "compile acceptance"],
    chapters,
    appendix: [{ chapterId: "appx", titleZh: "appendix-detail", sections: ["appendix-detail.tex"] }],
    acknowledgmentsZh: "感谢合成测试环境与开源工具链。",
  };
  if (missingCitation) {
    model.chapters.push({ chapterId: "chbad", titleZh: "bad-cite", sections: ["bad-cite.tex"] });
  }
  return { manuscriptDir, outline, model };
}

async function main() {
  const results = [];
  const record = (name, pass, detail = "") => {
    results.push({ name, pass, detail });
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  const xelatex = await run("xelatex", ["--version"]);
  if (xelatex.code !== 0) {
    console.error("SKIP：本机无 xelatex（此验收须在有 TeX Live 的环境执行）");
    process.exit(0);
  }
  const biber = await run("biber", ["--version"]);
  const bibtex = await run("bibtex", ["--version"]);
  record("工具链探测", true, `xelatex ✓ / bibtex ${bibtex.code === 0 ? "✓" : "✗"} / biber ${biber.code === 0 ? "✓" : "✗"}`);

  const { LatexCompiler } = await importBackend("dist/latex/LatexCompiler.js");
  const { assembleThesisManuscript } = await importBackend("dist/thesis/thesisAssembler.js");

  const root = await mkdtemp(join(tmpdir(), "thesis-accept-"));
  try {
    // ---- 1+4+5+6+7. bibtex 路径（默认模板）：装配 → 冷/热编译 → PDF 文本检查 ----
    const fx = await buildFixtureManuscript(join(root, "main-ws"));
    const targetDir = join(root, "main-ws", "manuscript-thesis");
    const assembled = await assembleThesisManuscript({
      model: fx.model,
      outline: fx.outline,
      manuscriptDir: fx.manuscriptDir,
      targetDir,
    });
    record(
      "装配（generic-ctexbook）",
      assembled.bibliography === "bibtex" &&
        assembled.mainTex.includes("ctexbook") &&
        assembled.chapters.filter((c) => c.part === "main").length === CHAPTER_COUNT,
      `chapters=${assembled.chapters.filter((c) => c.part === "main").length}+appendix=${assembled.chapters.filter((c) => c.part === "appendix").length}（promoted=${assembled.chapters.filter((c) => c.mode === "promoted").length}, wrapper=${assembled.chapters.filter((c) => c.mode === "wrapper").length}）`,
    );

    const compiler = new LatexCompiler({ timeoutMs: 600_000 });
    const coldStart = Date.now();
    const cold = await compiler.compile({ manuscriptDir: targetDir, buildDir: join(root, "main-ws", "build") });
    const coldMs = Date.now() - coldStart;
    record(
      "编译 bibtex 路径（冷启动）",
      cold.ok,
      cold.ok ? `${cold.tool}, ${coldMs}ms, PDF=${(await readFile(cold.pdfPath)).length}B` : cold.error,
    );

    const warmStart = Date.now();
    const warm = await compiler.compile({ manuscriptDir: targetDir, buildDir: join(root, "main-ws", "build") });
    const warmMs = Date.now() - warmStart;
    record("编译 bibtex 路径（热启动）", warm.ok, `${warmMs}ms（冷启动 ${coldMs}ms）`);

    // PDF 文本级验证（pdftotext）
    const probe = await run("pdftotext", ["-v"]);
    if (probe.code === 0 || /pdftotext/i.test(probe.stderr)) {
      const extracted = await run("pdftotext", [join(root, "main-ws", "build", "paper.pdf"), "-"]);
      const text = extracted.stdout;
      const sentinels = ["sentinel-ch1-s1", "sentinel-ch5-s2", "sentinel-ch10-s1", "sentinel-appendix", "sentinel-appendix-derivation"];
      const missing = sentinels.filter((s) => !text.includes(s));
      record(
        "长章节内容不丢失（哨兵字符串）",
        missing.length === 0,
        missing.length === 0 ? `${sentinels.length}/${sentinels.length} 命中` : `缺失: ${missing.join(", ")}`,
      );
      const hasToc = text.includes("目 录") || text.includes("目录");
      // gbt7714 样式对英文题名做大小写归一（title case → sentence case）
      const hasBib = /synthetic reference a/i.test(text);
      const hasCiteNumber = text.includes("[1]") && text.includes("[2]");
      const hasAbstractZh = text.includes("合成测试材料");
      const hasAbstractEn = /synthetic test material/i.test(text);
      const hasChapterHeading = text.includes("第5章") || /第\s*5\s*章/.test(text);
      record(
        "PDF 目录 / 章节层级 / 参考文献解析",
        hasToc && hasBib && hasCiteNumber && hasChapterHeading,
        `目录${hasToc ? "✓" : "✗"} 章节${hasChapterHeading ? "✓" : "✗"} 参考文献${hasBib ? "✓" : "✗"} 引用编号${hasCiteNumber ? "✓" : "✗"}`,
      );
      record("PDF 双语摘要", hasAbstractZh && hasAbstractEn, `zh${hasAbstractZh ? "✓" : "✗"} en${hasAbstractEn ? "✓" : "✗"}`);
      const pages = await run("pdfinfo", [join(root, "main-ws", "build", "paper.pdf")]);
      const pageCount = /Pages:\s+(\d+)/.exec(pages.stdout)?.[1] ?? "?";
      record("PDF 页数（长文档形态 ≥ 15）", Number(pageCount) >= 15, `pages=${pageCount}`);
    } else {
      record("PDF 文本检查", false, "pdftotext 不可用（apt install poppler-utils 后复跑）");
    }

    // ---- 2. biber 路径 ----
    const fxBiber = await buildFixtureManuscript(join(root, "biber-ws"));
    fxBiber.model.bibliography = "biber";
    const biberTarget = join(root, "biber-ws", "manuscript-thesis");
    await assembleThesisManuscript({
      model: fxBiber.model,
      outline: fxBiber.outline,
      manuscriptDir: fxBiber.manuscriptDir,
      targetDir: biberTarget,
    });
    const biberResult = await compiler.compile({
      manuscriptDir: biberTarget,
      buildDir: join(root, "biber-ws", "build"),
    });
    record("编译 biber 路径（biblatex）", biberResult.ok, biberResult.ok ? `${biberResult.tool}, ${biberResult.durationMs}ms` : biberResult.error);

    // ---- 3. 缺失引用 → 必须失败 ----
    const fxMissing = await buildFixtureManuscript(join(root, "missing-ws"), { missingCitation: true });
    const missingTarget = join(root, "missing-ws", "manuscript-thesis");
    await assembleThesisManuscript({
      model: fxMissing.model,
      outline: fxMissing.outline,
      manuscriptDir: fxMissing.manuscriptDir,
      targetDir: missingTarget,
    });
    let failedAsExpected = false;
    let failDetail = "";
    try {
      await compiler.compile({ manuscriptDir: missingTarget, buildDir: join(root, "missing-ws", "build") });
      failDetail = "编译未失败（未定义引用漏检回归！）";
    } catch (error) {
      failedAsExpected = true;
      failDetail = String(error.detail ?? error.message).slice(0, 200);
    }
    record("缺失引用正确失败（[?] 回归守卫）", failedAsExpected, failDetail);

    const failed = results.filter((entry) => !entry.pass);
    console.log(`\n==== M14.1c 编译验收：${results.length - failed.length}/${results.length} PASS ====`);
    if (failed.length > 0 && process.env["KEEP_WS"] === "1") {
      console.log(`KEEP_WS=1：验收失败，保留工作区 ${root} 供诊断`);
      process.exit(1);
    }
    process.exit(failed.length > 0 ? 1 : 0);
  } finally {
    if (process.env["KEEP_WS"] !== "1") {
      await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error("验收脚本执行失败：", error);
  process.exit(2);
});
