/**
 * M14.1c：ThesisDocumentModel + generic-ctexbook 适配器 + 确定性装配测试。
 *
 * 覆盖：
 *   - 模型校验（未映射 section / 重复映射 / 未实现模板 / 单节章标题一致性）；
 *   - shiftHeadingLevels：同行原地改名（行数 / 行号不变，标签与正文原样）；
 *   - 装配：wrapper / promoted 双模式、双语摘要、目录、参考文献、附录、致谢；
 *   - 不伪造：未提供作者 / 学位信息时封面留空；
 *   - 确定性：同输入两次装配 byte-identical；
 *   - 源目录只读（装配后 manuscript/ 无新增文件）。
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { Outline } from "../../src/manuscript/ManuscriptService.js";
import { assembleThesisManuscript, shiftHeadingLevels } from "../../src/thesis/thesisAssembler.js";
import {
  chapterAssemblyMode,
  validateThesisDocumentModel,
  type ThesisDocumentModel,
} from "../../src/thesis/thesisDocumentTypes.js";

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3 })));
});

function outlineOf(files: string[]): Outline {
  return {
    title: "测试论文",
    sections: files.map((file, index) => ({ id: `s${index + 1}`, file, title: file.replace(/\.tex$/, "") })),
  };
}

function modelOver(sections: string[]): ThesisDocumentModel {
  return {
    schemaVersion: 1,
    templateId: "generic-ctexbook",
    titleZh: "合成测试学位论文：目标检测方法研究",
    titleEn: "Synthetic Test Thesis",
    abstractZh: "本论文为合成测试内容，不代表真实研究成果。",
    abstractEn: "This thesis is synthetic test material.",
    keywordsZh: ["目标检测", "合成测试"],
    keywordsEn: ["object detection", "synthetic test"],
    chapters: [
      { chapterId: "ch01", titleZh: sections[0]!.replace(/\.tex$/, ""), sections: [sections[0]!] },
      { chapterId: "ch02", titleZh: "第二章", sections: sections.slice(1, sections.length > 3 ? 3 : undefined) },
    ],
    appendix: sections.length > 3 ? [{ chapterId: "appA", titleZh: "附录材料", sections: [sections[3]!] }] : undefined,
    acknowledgmentsZh: "感谢合成测试环境的支持。",
  };
}

describe("validateThesisDocumentModel", () => {
  const shape = (files: string[]) => ({
    sectionFiles: files,
    sectionTitles: new Map(files.map((f) => [f, f.replace(/\.tex$/, "")])),
  });

  it("完整映射的模型通过校验", () => {
    const files = ["intro.tex", "method.tex", "experiment.tex", "appendix.tex"];
    expect(validateThesisDocumentModel(modelOver(files), shape(files))).toEqual([]);
  });

  it("未映射的 outline section 报违规（正文丢失防护）", () => {
    const files = ["intro.tex", "method.tex", "experiment.tex", "appendix.tex", "extra.tex"];
    const violations = validateThesisDocumentModel(modelOver(files), shape(files));
    expect(violations.some((v) => v.includes("extra.tex") && v.includes("未映射"))).toBe(true);
  });

  it("同一 section 被映射两次报违规（正文重复防护）", () => {
    const model = modelOver(["intro.tex", "method.tex", "experiment.tex", "appendix.tex"]);
    model.chapters[1]!.sections.push("intro.tex");
    const violations = validateThesisDocumentModel(model, shape(["intro.tex", "method.tex", "experiment.tex", "appendix.tex"]));
    expect(violations.some((v) => v.includes("intro.tex") && v.includes("重复"))).toBe(true);
  });

  it("未实现模板报违规", () => {
    const files = ["intro.tex", "method.tex"];
    const model = modelOver(files);
    (model as { templateId: string }).templateId = "thuthesis";
    const violations = validateThesisDocumentModel(model, shape(files));
    expect(violations.some((v) => v.includes("未实现"))).toBe(true);
  });

  it("单节章标题与节标题不一致报违规（promoted 模式一致性）", () => {
    const files = ["intro.tex", "method.tex"];
    const model = modelOver(files);
    model.chapters[0]!.titleZh = "与节标题不同的章标题";
    const violations = validateThesisDocumentModel(model, shape(files));
    expect(violations.some((v) => v.includes("promoted"))).toBe(true);
  });
});

describe("shiftHeadingLevels（编译期标题层级变换）", () => {
  it("层级 +1：section→chapter、subsection→section、subsubsection→subsection（同在原行）", () => {
    const tex = [
      "\\section{引言}",
      "正文第一段。",
      "\\subsection{研究背景}",
      "\\label{sec:background}",
      "\\subsubsection{小节}",
      "\\paragraph{段落级}",
      "见第~\\ref{sec:background}~节。",
    ].join("\n");
    const shifted = shiftHeadingLevels(tex, 1);
    const lines = shifted.split("\n");
    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe("\\chapter{引言}");
    expect(lines[1]).toBe("正文第一段。");
    expect(lines[2]).toBe("\\section{研究背景}");
    expect(lines[3]).toBe("\\label{sec:background}");
    expect(lines[4]).toBe("\\subsection{小节}");
    expect(lines[5]).toBe("\\subsubsection{段落级}");
    expect(lines[6]).toBe("见第~\\ref{sec:background}~节。");
  });

  it("星号与可选参数形态保留", () => {
    const shifted = shiftHeadingLevels("\\section*{无编号}\\subsection[short]{长标题}", 1);
    expect(shifted).toBe("\\chapter*{无编号}\\section[short]{长标题}");
  });

  it("chapter 已是顶层：钳制不再升级", () => {
    expect(shiftHeadingLevels("\\chapter{顶}", 1)).toBe("\\chapter{顶}");
  });

  it("标题行内文本 / cite / label 完全不动（正文不丢失）", () => {
    const tex = "\\section{方法与 \\cite{kim2019} 的对比}\\label{sec:m}";
    const shifted = shiftHeadingLevels(tex, 1);
    expect(shifted).toBe("\\chapter{方法与 \\cite{kim2019} 的对比}\\label{sec:m}");
  });
});

describe("assembleThesisManuscript（generic-ctexbook 确定性装配）", () => {
  async function newWorkspace() {
    const root = await mkdtemp(join(tmpdir(), "paperteam-thesis-asm-"));
    tempDirs.push(root);
    const manuscriptDir = join(root, "manuscript");
    const targetDir = join(root, "manuscript-thesis");
    await mkdir(join(manuscriptDir, "sections"), { recursive: true });
    const files = ["intro.tex", "method.tex", "experiment.tex", "appendix.tex"];
    for (const file of files) {
      await writeFile(
        join(manuscriptDir, "sections", file),
        `\\section{${file.replace(/\.tex$/, "")}}\n正文：${file} 的内容，包含 \\label{lbl:${file}} 与引用 \\cite{ref1}。\n\\subsection{细节}\n更多内容。\n`,
        "utf8",
      );
    }
    await writeFile(
      join(manuscriptDir, "references.bib"),
      "@misc{ref1,\n  author = {Test Author},\n  title = {Synthetic Reference},\n  year = {2026},\n}\n",
      "utf8",
    );
    return { root, manuscriptDir, targetDir, files };
  }

  it("完整装配：wrapper + promoted 双模式、ctexbook、双语摘要、目录、gbt7714、附录、致谢", async () => {
    const ws = await newWorkspace();
    const model = modelOver(ws.files);
    const outline = outlineOf(ws.files);
    const result = await assembleThesisManuscript({ model, outline, manuscriptDir: ws.manuscriptDir, targetDir: ws.targetDir });

    // 模式判定：ch01 单节 = promoted；ch02 三节 = wrapper
    expect(result.chapters.map((c) => `${c.chapterId}:${c.mode}`)).toEqual(["ch01:promoted", "ch02:wrapper", "appA:promoted"]);
    expect(result.bibliography).toBe("bibtex");
    // promoted 的 intro.tex 副本被改写（\section→\chapter）；wrapper 的原样
    expect(result.transformedFiles).toEqual(["intro.tex", "appendix.tex"]);

    const main = result.mainTex;
    expect(main).toContain("\\documentclass[UTF8,fontset=fandol]{ctexbook}");
    expect(main).toContain("\\usepackage{gbt7714}");
    expect(main).toContain("Synthetic Test Thesis");
    expect(main).toContain("\\chapter*{摘要}");
    expect(main).toContain("\\chapter*{Abstract}");
    expect(main).toContain("关键词：目标检测；合成测试");
    expect(main).toContain("\\tableofcontents");
    expect(main).toContain("\\listoffigures");
    expect(main).toContain("\\chapter{第二章}"); // wrapper 章标题
    expect(main).toContain("\\input{sections/method}");
    expect(main).toContain("\\bibliographystyle{gbt7714-numerical}");
    expect(main).toContain("\\appendix");
    expect(main).toContain("\\chapter*{致谢}");

    // promoted 副本：行数不变 + 首行已是 \chapter + 正文原样
    const introTarget = await readFile(join(ws.targetDir, "sections", "intro.tex"), "utf8");
    const introSource = await readFile(join(ws.manuscriptDir, "sections", "intro.tex"), "utf8");
    expect(introTarget.split("\n")).toHaveLength(introSource.split("\n").length);
    expect(introTarget.split("\n")[0]).toBe("\\chapter{intro}");
    expect(introTarget).toContain("\\label{lbl:intro.tex}");
    // wrapper 副本：逐字原样（与源 method.tex 完全一致）
    const methodTarget = await readFile(join(ws.targetDir, "sections", "method.tex"), "utf8");
    const methodSource = await readFile(join(ws.manuscriptDir, "sections", "method.tex"), "utf8");
    expect(methodTarget).toBe(methodSource);
    // references.bib 已复制
    expect(await readFile(join(ws.targetDir, "references.bib"), "utf8")).toContain("Synthetic Reference");
  });

  it("biber 后端模型：preamble 加载 biblatex + bcf 后端，backmatter 用 printbibliography", async () => {
    const ws = await newWorkspace();
    const model = modelOver(ws.files);
    model.bibliography = "biber";
    const result = await assembleThesisManuscript({ model, outline: outlineOf(ws.files), manuscriptDir: ws.manuscriptDir, targetDir: ws.targetDir });
    expect(result.bibliography).toBe("biber");
    expect(result.mainTex).toContain("\\usepackage[backend=biber,style=numeric]{biblatex}");
    expect(result.mainTex).toContain("\\addbibresource{references.bib}");
    expect(result.mainTex).toContain("\\printbibliography[heading=bibintoc]");
    expect(result.mainTex).not.toContain("gbt7714");
  });

  it("无 references.bib：不加载参考文献宏包，bibliography=null", async () => {
    const ws = await newWorkspace();
    const { rm } = await import("node:fs/promises");
    await rm(join(ws.manuscriptDir, "references.bib"));
    const model = modelOver(ws.files);
    const result = await assembleThesisManuscript({ model, outline: outlineOf(ws.files), manuscriptDir: ws.manuscriptDir, targetDir: ws.targetDir });
    expect(result.bibliography).toBe(null);
    expect(result.mainTex).not.toContain("gbt7714");
    expect(result.mainTex).not.toContain("biblatex");
  });

  it("不伪造：未提供作者 / 学位信息 → 封面无作者行与学位行", async () => {
    const ws = await newWorkspace();
    const model = modelOver(ws.files);
    delete model.author;
    delete model.degree;
    const result = await assembleThesisManuscript({ model, outline: outlineOf(ws.files), manuscriptDir: ws.manuscriptDir, targetDir: ws.targetDir });
    expect(result.mainTex).not.toContain("学号：");
    expect(result.mainTex).not.toContain("专业：");
    // 未提供学位级别 → 无「博士/硕士学位论文」行（titleZh 中的通用词不算伪造）
    expect(result.mainTex).not.toMatch(/(?:博士|硕士|学士)学位论文\\\\/);
  });

  it("确定性：同输入两次装配 main.tex 与 sections/ byte-identical", async () => {
    const ws = await newWorkspace();
    const model = modelOver(ws.files);
    const outline = outlineOf(ws.files);
    const first = await assembleThesisManuscript({ model, outline, manuscriptDir: ws.manuscriptDir, targetDir: ws.targetDir });
    const firstIntro = await readFile(join(ws.targetDir, "sections", "intro.tex"), "utf8");
    const second = await assembleThesisManuscript({ model, outline, manuscriptDir: ws.manuscriptDir, targetDir: ws.targetDir });
    expect(second.mainTex).toBe(first.mainTex);
    expect(await readFile(join(ws.targetDir, "sections", "intro.tex"), "utf8")).toBe(firstIntro);
  });

  it("源目录只读：装配后 manuscript/ 无任何新增文件", async () => {
    const ws = await newWorkspace();
    const before = new Set(await readdir(join(ws.manuscriptDir, "sections")));
    await assembleThesisManuscript({
      model: modelOver(ws.files),
      outline: outlineOf(ws.files),
      manuscriptDir: ws.manuscriptDir,
      targetDir: ws.targetDir,
    });
    expect(await readdir(join(ws.manuscriptDir, "sections"))).toEqual([...before]);
    const root = await readdir(ws.manuscriptDir);
    expect(root).not.toContain("main.tex");
  });

  it("校验失败（未映射 section）抛 STAGE_CONTRACT_VIOLATION，不产出", async () => {
    const ws = await newWorkspace();
    const model = modelOver(ws.files);
    const outline = outlineOf([...ws.files, "orphan.tex"]);
    await expect(
      assembleThesisManuscript({ model, outline, manuscriptDir: ws.manuscriptDir, targetDir: ws.targetDir }),
    ).rejects.toMatchObject({ code: "STAGE_CONTRACT_VIOLATION" });
  });
});

describe("chapterAssemblyMode", () => {
  it("单节章 = promoted；多节章 = wrapper", () => {
    expect(chapterAssemblyMode({ chapterId: "a", titleZh: "t", sections: ["only.tex"] })).toBe("promoted");
    expect(chapterAssemblyMode({ chapterId: "b", titleZh: "t", sections: ["one.tex", "two.tex"] })).toBe("wrapper");
  });
});
