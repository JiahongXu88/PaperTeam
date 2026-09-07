/**
 * 引用条目类型推断（确定性启发；Layer 1 核验的语义分派依据）。
 *
 * 核心场景：Ultralytics YOLO11 这类软件/模型引用——没有正式 research paper，
 * 学术库（Crossref/OpenAlex/arXiv）未收录是事实而不是"文献不存在"。
 * 条目自带官方 repository 链接（IEEE 风格 "[Online]. Available: https://github.com/…"）
 * 是最强的软件信号；推断保持保守：
 *   - github/gitlab 链接 → software（repository 本身就是 authoritative source）
 *   - 其它一律 → scholarly_paper（默认；论文数据集如 BDD100K 有正式 paper，不能误标）
 * dataset / documentation / web_resource 属于 Domain Model 的预留类型，
 * 等有独立的 authoritative source 后再启用推断，不猜。
 */

import type { ReferenceEntry, ReferenceKind } from "./integrity.js";
import { stripHyphenationMarkers } from "./referenceText.js";

/** 代码托管平台的 repository 链接（owner/repo；忽略尾随路径与 .git） */
const REPOSITORY_URL_PATTERN =
  /https?:\/\/(?:www\.)?(github\.com|gitlab\.com)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?]|$)/;

export interface RepositoryRef {
  /** github.com / gitlab.com */
  host: string;
  /** owner/org（如 ultralytics） */
  owner: string;
  /** repo 名（如 ultralytics） */
  repo: string;
  /** 规范化 URL（https://github.com/owner/repo） */
  url: string;
}

/** 从条目文本提取官方 repository 链接（url 字段优先，rawText 兜底） */
export function extractRepositoryRef(reference: {
  url?: string;
  rawText: string;
}): RepositoryRef | undefined {
  for (const text of [reference.url, stripHyphenationMarkers(reference.rawText)]) {
    if (text === undefined || text === "") {
      continue;
    }
    const match = REPOSITORY_URL_PATTERN.exec(text);
    if (match !== null) {
      const host = match[1]!.toLowerCase();
      const owner = match[2]!;
      const repo = match[3]!;
      return { host, owner, repo, url: `https://${host}/${owner}/${repo}` };
    }
  }
  return undefined;
}

/**
 * 推断条目类型（保守）：
 *   repository 链接 → software；否则 scholarly_paper。
 * unknown 仅在完全无文本时出现（实际条目都有 rawText，防御性兜底）。
 */
export function inferReferenceKind(reference: ReferenceEntry): ReferenceKind {
  if (reference.rawText.trim() === "") {
    return "unknown";
  }
  return extractRepositoryRef(reference) !== undefined ? "software" : "scholarly_paper";
}

/** software 推断是否启用权威源核验（repository 链接在手才算可核验） */
export function isSoftwareVerifiable(reference: ReferenceEntry): boolean {
  return inferReferenceKind(reference) === "software";
}
