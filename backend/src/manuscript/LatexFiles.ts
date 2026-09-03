/**
 * LaTeX 项目文件收集（M3.1）。
 *
 * 从 manuscript/main.tex 出发，沿 \input / \include 递归收集全部 .tex，
 * 并定位 references.bib。供 Citation 核验、Build Gate、导入解析共用。
 * 循环引用与缺失文件记录为 warnings（不中断收集）。
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

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

  return {
    mainTex: main,
    sections: collected.filter((file) => file.relativePath !== "main.tex"),
    allTex: collected,
    bibPath,
    bibContent,
    figures,
    warnings,
  };
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
