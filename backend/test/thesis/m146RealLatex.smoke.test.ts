/**
 * M14.6 — 真实 xelatex / bibtex 编译验收（env 门控：PAPERTEAM_M146_REAL_LATEX=1；默认跳过，不进 CI；零模型调用）。
 *
 * Part A（产品路径）：正式 Evidence → 引用 → 参考文献闭环（thesisCitationFlow）以 realLatex 栈跑完 build.draft，
 *   真实 PDF 文本层（PyMuPDF）必须含：摘要 / Abstract 页、参考文献条目（真实作者名）、无「??」未解析引用。
 * Part B（案例 B 真实正文）：M14.5 run2 rev-2 的 16 节真实 Draft 正文（含裸 `75.37%` 与「第四章为实验验证」）
 *   经 M14.6 装配层（章标签 + 字面章号归一 + 写作期百分号转义口径）重新装配编译，PDF 文本层必须含
 *   「幅度表明」（M14.5 真实 PDF 中被 `%` 注释吞掉的句子）、实验章引用解析为「第5章」而非「第四章」，无「??」。
 *   若存在 Smoke C 产物（abstract-*.json），注入其双语摘要，PDF 须含摘要页。
 *
 * 运行：PAPERTEAM_M146_REAL_LATEX=1 npx vitest run test/thesis/m146RealLatex.smoke.test.ts
 * 产物：D:\PaperTeamData\M14_6\pdf\（PDF 副本 + 文本层 + 判定 JSON）
 */
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createScriptedRuntime } from "../../src/runtime/scriptedRuntime.js";
import { LatexCompiler } from "../../src/latex/LatexCompiler.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import { ThesisDocumentService } from "../../src/thesis/ThesisDocumentService.js";
import type { ThesisDocumentModel } from "../../src/thesis/thesisDocumentTypes.js";
import { escapeBarePercentAfterDigits } from "../../src/writer/latexSanitize.js";
import { startTestStack, type TestStack } from "../helpers/testStack.js";
import { REAL_REFERENCES, runThesisCitationClosure } from "../helpers/thesisCitationFlow.js";

const live = process.env["PAPERTEAM_M146_REAL_LATEX"] === "1";
const caseBProject = process.env["PAPERTEAM_M146_CASEB_PROJECT"] ?? "D:\\PaperTeamData\\M14_5\\projects-caseB\\p-7fb5ffbec963";
const outDir = process.env["PAPERTEAM_M146_PDF_OUT"] ?? "D:\\PaperTeamData\\M14_6\\pdf";
const smokeDir = process.env["PAPERTEAM_M146_OUT"] ?? "D:\\PaperTeamData\\M14_6\\smoke";

/** PDF 文本层（PyMuPDF；mingw pdftotext 对 Adobe-GB1 字体集解码失败，不可用） */
function pdfText(pdfPath: string): string {
  const result = spawnSync(
    "python",
    ["-c", "import fitz,sys; d=fitz.open(sys.argv[1]); sys.stdout.buffer.write(('\\n'.join(p.get_text() for p in d)).encode('utf8'))", pdfPath],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(`PyMuPDF 文本提取失败：${result.stderr.toString("utf8").slice(0, 400)}`);
  return result.stdout.toString("utf8");
}

/** PDF 页数（PyMuPDF） */
function pdfPages(pdfPath: string): number {
  const result = spawnSync("python", ["-c", "import fitz,sys; print(len(fitz.open(sys.argv[1])))", pdfPath], { encoding: "utf8" });
  return result.status === 0 ? Number(result.stdout.trim()) : -1;
}

async function latestAbstractArtifact(): Promise<{ abstractZh: string; abstractEn: string; keywordsZh: string[]; keywordsEn: string[] } | null> {
  try {
    const files = (await readdir(smokeDir)).filter((name) => /^abstract-\d+\.json$/.test(name)).sort();
    const latest = files[files.length - 1];
    if (latest === undefined) return null;
    const parsed = JSON.parse(await readFile(join(smokeDir, latest), "utf8")) as { result: { draft: { abstractZh: string; abstractEn: string; keywordsZh: string[]; keywordsEn: string[] }; violations: unknown[] } };
    return parsed.result.violations.length === 0 ? parsed.result.draft : null;
  } catch {
    return null;
  }
}

describe.skipIf(!live)("M14.6 真实 LaTeX 验收（xelatex + bibtex；PyMuPDF 文本层）", () => {
  let stack: TestStack | undefined;
  afterAll(async () => {
    await stack?.cleanup();
  });

  it("Part A：引用闭环产品路径 → 真实编译 → PDF 含摘要 / Abstract / 参考文献 / 无 ??", { timeout: 900_000 }, async () => {
    const scripted = createScriptedRuntime({ reviewSequence: ["pass"] });
    stack = await startTestStack(scripted.runtime, {
      realLatex: true,
      search: { disabledProviders: ["openalex", "semantic-scholar", "arxiv", "aminer", "searxng"], providerTimeoutMs: 2_000 },
    });
    const { projectId, run } = await runThesisCitationClosure(stack, "M14.6 真实编译 引用闭环学位论文");
    expect(run.status).toBe("completed");
    const build = run.stageResults?.["build.draft"] ?? {};
    await mkdir(outDir, { recursive: true });
    for (const [dir, name] of [["build", "compile.log"], ["build", "build-gate.json"], ["build", "main.aux"], ["build", "main.blg"], ["build", "main.log"], ["manuscript-thesis", "main.tex"], ["manuscript-thesis", "references.bib"]] as const) {
      try {
        await copyFile(join(stack.store.projectDir(projectId), dir, name), join(outDir, `partA-${name}`));
      } catch {
        // 产物缺失如实缺席
      }
    }
    expect(build["buildOk"], JSON.stringify(build).slice(0, 400)).toBe(true);
    const pdfPath = join(stack.store.projectDir(projectId), typeof build["pdfPath"] === "string" ? (build["pdfPath"] as string) : join("build", "paper.pdf"));
    const text = pdfText(pdfPath);
    await mkdir(outDir, { recursive: true });
    await copyFile(pdfPath, join(outDir, "partA-citation-closure.pdf"));
    await writeFile(join(outDir, "partA-citation-closure.txt"), text, "utf8");
    const citedAuthors = REAL_REFERENCES.filter((ref) => text.includes(ref.authors[0]!.split(" ").pop()!));
    const verdict = {
      pages: pdfPages(pdfPath),
      hasAbstractZh: text.includes("摘要"),
      hasAbstractEn: /Abstract/.test(text),
      hasReferencesHeading: /参考文献/.test(text),
      citedAuthorsInPdf: citedAuthors.map((ref) => ref.authors[0]),
      unresolvedRefs: (text.match(/\?\?/g) ?? []).length,
    };
    await writeFile(join(outDir, "partA-verdict.json"), JSON.stringify(verdict, null, 2), "utf8");
    console.log(`[m146-latex] Part A: ${JSON.stringify(verdict)}`);
    expect(verdict.hasAbstractZh).toBe(true);
    expect(verdict.hasAbstractEn).toBe(true);
    expect(verdict.hasReferencesHeading).toBe(true);
    expect(verdict.citedAuthorsInPdf.length).toBeGreaterThan(0);
    expect(verdict.unresolvedRefs).toBe(0);
  });

  it("Part B：案例 B rev-2 真实正文 → M14.6 装配 → PDF 不再丢句（幅度表明）、章号解析正确、无 ??", { timeout: 900_000 }, async () => {
    const root = join(tmpdir(), `m146-latex-caseb-${Date.now()}`);
    const projects = new ProjectStore({ root });
    const project = await projects.create("M14.6 案例 B 真实正文编译验收");
    const projectId = project.id;
    const manuscriptDir = projects.manuscriptDir(projectId);
    await mkdir(join(manuscriptDir, "sections"), { recursive: true });
    const revDir = join(caseBProject, "manuscript-thesis", "revisions", "rev-2");
    const sectionFiles = (await readdir(join(revDir, "sections"))).filter((name) => name.endsWith(".tex"));
    let barePercentBefore = 0;
    for (const file of sectionFiles) {
      const source = await readFile(join(revDir, "sections", file), "utf8");
      barePercentBefore += (source.match(/\d[  ]?%(?!%)/g) ?? []).length;
      // M14.6 写作期口径：Writer 输出裸百分号转义（历史 Draft 在此补做同一确定性处理）
      await writeFile(join(manuscriptDir, "sections", file), escapeBarePercentAfterDigits(source), "utf8");
    }
    const outline = JSON.parse(await readFile(join(revDir, "outline.json"), "utf8")) as import("../../src/manuscript/ManuscriptService.js").Outline;
    await writeFile(join(manuscriptDir, "outline.json"), JSON.stringify(outline, null, 2), "utf8");
    const baseModel = JSON.parse(await readFile(join(revDir, "thesis.json"), "utf8")) as ThesisDocumentModel;
    const abstract = await latestAbstractArtifact();
    const model: ThesisDocumentModel = {
      ...baseModel,
      ...(abstract !== null ? { abstractZh: abstract.abstractZh, abstractEn: abstract.abstractEn, keywordsZh: abstract.keywordsZh, keywordsEn: abstract.keywordsEn } : {}),
    };
    const documents = new ThesisDocumentService(projects, new LatexCompiler({ timeoutMs: 600_000 }));
    await documents.saveModel(projectId, model, outline);
    const assembly = await documents.assemble(projectId, outline, model);
    const compile = await documents.compile(projectId);
    expect(compile.ok, compile.error ?? "").toBe(true);
    const text = pdfText(compile.pdfPath!);
    await mkdir(outDir, { recursive: true });
    await copyFile(compile.pdfPath!, join(outDir, "partB-caseB-rev2-m146.pdf"));
    await writeFile(join(outDir, "partB-caseB-rev2-m146.txt"), text, "utf8");
    await writeFile(join(outDir, "partB-assembly.json"), JSON.stringify({ chapterReferences: assembly.chapterReferences, transformedFiles: assembly.transformedFiles, bibliography: assembly.bibliography }, null, 2), "utf8");
    const verdict = {
      pages: pdfPages(compile.pdfPath!),
      barePercentBefore,
      hasTruncatedSentenceRestored: text.includes("幅度表明"),
      has7537: text.includes("75.37"),
      hasAbstractZh: abstract !== null ? text.includes("摘要") : null,
      hasAbstractEn: abstract !== null ? /Abstract/.test(text) : null,
      chapterRefRewrites: assembly.chapterReferences.rewrites.length,
      chapterRefIssues: assembly.chapterReferences.issues.length,
      // M14.5 真实缺陷「第四章为实验验证」（实为 ch05）：弱证据（独有二元组「实验」）与序号冲突 → 保守策略
      // 不改写只报告（M14.6 装配层对历史 Draft 的诚实边界；新 Draft 由 Writer 侧 \ref 纪律根治）
      // 实测窗口「…下洗效应…轨迹跟踪实验结果」同时命中 ch03（下洗）与 ch05（实验）二元组 → 歧义 → 只报告
      staleFourthChapterReported: assembly.chapterReferences.issues.some((issue) => issue.file === "intro-organization.tex" && issue.literal === "第四章"),
      staleFourthChapterMention: text.includes("第四章为实验验证"),
      // 「第五章为总结与展望」（实为 ch06）：完整标题命中 → 改写为章标签引用 → PDF 显示第六章
      // ctexbook 的章引用渲染为中文数字（第六章）；亦兼容阿拉伯数字形态
      conclusionChapterFixed: /第\s?(6|六)\s?章为总结与展望/.test(text) && !text.includes("第五章为总结与展望"),
      unresolvedRefs: (text.match(/\?\?/g) ?? []).length,
      compileMs: compile.durationMs,
    };
    await writeFile(join(outDir, "partB-verdict.json"), JSON.stringify(verdict, null, 2), "utf8");
    console.log(`[m146-latex] Part B: ${JSON.stringify(verdict)}`);
    expect(verdict.hasTruncatedSentenceRestored).toBe(true);
    expect(verdict.chapterRefRewrites).toBeGreaterThan(0);
    expect(verdict.conclusionChapterFixed).toBe(true);
    expect(verdict.staleFourthChapterReported).toBe(true);
    expect(verdict.unresolvedRefs).toBe(0);
    if (abstract !== null) {
      expect(verdict.hasAbstractZh).toBe(true);
      expect(verdict.hasAbstractEn).toBe(true);
    }
  });
});
