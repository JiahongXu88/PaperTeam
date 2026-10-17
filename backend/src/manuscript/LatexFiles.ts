/**
 * LaTeX 项目文件收集。
 *
 * 从 manuscript/main.tex 出发，沿 \input / \include 递归收集全部 .tex，
 * 并定位 references.bib。供 Citation 核验、Build Gate、导入解析共用。
 * 循环引用与缺失文件记录为 warnings（不中断收集）。
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { extractInlineBibliography, hasInlineBibliography, renderInlineBibliographyAsBib } from "./inlineBibliography.js";

export interface TexFile {
  /** 相对 manuscript 目录的路径（POSIX 风格） */
  relativePath: string;
  content: string;
}

export interface LatexProjectFiles {
  mainTex: TexFile | null;
  sections: TexFile[];
  allTex: TexFile[];
  /** 解析到的 bib 文件（相对路径） */
  bibPath: string | null;
  bibContent: string | null;
  /**
   * 参考文献来源：file = bibPath 指向的 .bib；thebibliography = 正文内联的
   * \bibitem（bibContent 为内存中渲染的等价 BibTeX，**不对应任何文件、不得写回**）；
   * null = 未找到参考文献。
   */
  bibSource?: "file" | "thebibliography" | null;
  /** \includegraphics 等引用的图片相对路径 */
  figures: string[];
  warnings: string[];
}

export async function collectLatexFiles(manuscriptDir: string): Promise<LatexProjectFiles> {
  const warnings: string[] = [];
  const visited = new Set<string>();
  const collected: TexFile[] = [];

  async function load(relativePath: string): Promise<TexFile | null> {
    if (visited.has(relativePath)) {
      return null; // 循环引用防御
    }
    visited.add(relativePath);
    try {
      const content = await readFile(join(manuscriptDir, relativePath), "utf8");
      return { relativePath, content };
    } catch {
      warnings.push(`无法读取 ${relativePath}（缺失或不可读）`);
      return null;
    }
  }

  const main = await load("main.tex");
  if (main === null) {
    // M14.3 thesis 布局回退：thesis_from_papers 项目的 manuscript/ 没有 main.tex
    //（装配根 main.tex 在 manuscript-thesis/），但 outline 驱动的 sections/*.tex
    // 是权威稿件集——review / revision / citation 共享后段依赖本函数提供它们。
    // 真实运行实锤（M14.3 案例 A）：缺这一回退时 reviewer 看到空稿件集 →
    // 幻觉 section + academicScore=0，修订指令零绑定 → run 烧毁。
    const sectionFiles = await listSectionFiles(manuscriptDir);
    if (sectionFiles.length === 0) {
      return {
        mainTex: null,
        sections: [],
        allTex: [],
        bibPath: null,
        bibContent: null,
        figures: [],
        warnings,
      };
    }
    const referencesBib = await load("references.bib");
    return {
      mainTex: null,
      sections: sectionFiles,
      allTex: sectionFiles,
      bibPath: referencesBib !== null ? "references.bib" : null,
      bibContent: referencesBib?.content ?? null,
      figures: [...new Set(sectionFiles.flatMap((file) => extractFigureReferences(file.content)))],
      warnings,
    };
  }
  collected.push(main);

  // 沿 \input{…} / \include{…} 收集（BFS，保持出现顺序）
  // 沿 \input{…} / \include{…} 收集（BFS，保持出现顺序）
  const queue: TexFile[] = [main];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const referenced of extractInputReferences(current.content)) {
      const normalized = normalizeTexPath(referenced);
      if (visited.has(normalized)) {
        continue;
      }
      const file = await load(normalized);
      if (file !== null) {
        collected.push(file);
        queue.push(file);
      }
    }
  }

  // bib：\bibliography{refs} / \addbibresource{refs.bib}
  let bibPath: string | null = null;
  let bibContent: string | null = null;
  for (const candidate of extractBibReferences(main.content)) {
    const normalized = candidate.endsWith(".bib") ? candidate : `${candidate}.bib`;
    try {
      const info = await stat(join(manuscriptDir, normalized));
      if (info.isFile()) {
        bibPath = normalized;
        bibContent = await readFile(join(manuscriptDir, normalized), "utf8");
        break;
      }
    } catch {
      // 尝试下一个候选
    }
  }

  const figures = [...new Set(collected.flatMap((file) => extractFigureReferences(file.content)))];

  // GB/T 7714 中文期刊常见：无 .bib，参考文献内联在 thebibliography 环境
  let bibSource: "file" | "thebibliography" | null = bibPath !== null ? "file" : null;
  if (bibPath === null) {
    const inline = collected.flatMap((file) => (hasInlineBibliography(file.content) ? extractInlineBibliography(file.content) : []));
    if (inline.length > 0) {
      bibContent = renderInlineBibliographyAsBib(inline);
      bibSource = "thebibliography";
    }
  }

  return {
    mainTex: main,
    sections: collected.filter((file) => file.relativePath !== "main.tex"),
    allTex: collected,
    bibPath,
    bibContent,
    bibSource,
    figures,
    warnings,
  };
}

/** thesis 布局：manuscript/sections/*.tex 目录列举（排序稳定；读取失败跳过） */
async function listSectionFiles(manuscriptDir: string): Promise<TexFile[]> {
  const sectionsDir = join(manuscriptDir, "sections");
  let names: string[];
  try {
    names = (await readdir(sectionsDir)).filter((name) => name.endsWith(".tex")).sort();
  } catch {
    return [];
  }
  const files: TexFile[] = [];
  for (const name of names) {
    try {
      const content = await readFile(join(sectionsDir, name), "utf8");
      files.push({ relativePath: `sections/${name}`, content });
    } catch {
      // 单文件不可读跳过（其余节仍可审）
    }
  }
  return files;
}

/** 提取 \input{…} / \include{…} 引用（不含扩展名时补 .tex） */
export function extractInputReferences(tex: string): string[] {
  const references: string[] = [];
  const pattern = /\\(?:input|include)\s*\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tex)) !== null) {
    const raw = (match[1] ?? "").trim();
    if (raw === "") {
      continue;
    }
    references.push(normalizeTexPath(raw));
  }
  return references;
}

export function extractBibReferences(tex: string): string[] {
  const references: string[] = [];
  const patterns = [/\\bibliography\{([^}]+)\}/g, /\\addbibresource\{([^}]+)\}/g];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(tex)) !== null) {
      // \bibliography{a,b} 可逗号分隔
      for (const part of (match[1] ?? "").split(",")) {
        const trimmed = part.trim();
        if (trimmed !== "") {
          references.push(trimmed);
        }
      }
    }
  }
  return references;
}

/** 提取 \includegraphics[…]{…} 引用 */
export function extractFigureReferences(tex: string): string[] {
  const references: string[] = [];
  const pattern = /\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tex)) !== null) {
    const raw = (match[1] ?? "").trim();
    if (raw !== "") {
      references.push(raw.replaceAll("\\", "/"));
    }
  }
  return references;
}

/** 归一化 tex 路径：反斜杠 → 正斜杠；禁止 ../ 与绝对路径；无扩展名补 .tex */
export function normalizeTexPath(raw: string): string {
  const normalized = raw.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  const withoutExt = normalized.endsWith(".tex") ? normalized : `${normalized}.tex`;
  const segments = withoutExt.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    return "ignored-path-traversal"; // 会被读取失败记入 warnings，不越出目录
  }
  return segments.join("/");
}
