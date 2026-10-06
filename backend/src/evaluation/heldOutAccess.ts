import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface EvaluationSetManifest {
  generationPaths: string[];
  heldOutPaths: string[];
  reviewerCommentPaths?: string[];
  candidateFrozenAt?: string;
}

export interface ReviewerCommentBlock { heading: string; content: string }

export class HeldOutAccessError extends Error {
  readonly code = "HELD_OUT_ACCESS_BLOCKED";
  constructor(message: string) { super(message); this.name = "HeldOutAccessError"; }
}

/** Path-scoped read boundary for acceptance tooling. Held-out bytes are unavailable until freeze. */
export async function readEvaluationPath(root: string, requestedPath: string, manifest: EvaluationSetManifest): Promise<string> {
  if (isAbsolute(requestedPath)) throw new HeldOutAccessError("evaluation reader accepts project-relative paths only");
  const normalized = requestedPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const heldOut = new Set(manifest.heldOutPaths.map((item) => item.replace(/\\/g, "/").toLocaleLowerCase()));
  const resolvedRoot = await realpath(root);
  const lexicalCandidate = resolve(resolvedRoot, requestedPath);
  const lexicalRelative = relative(resolvedRoot, lexicalCandidate);
  if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) throw new HeldOutAccessError("path escapes evaluation project root");
  const candidate = await realpath(lexicalCandidate);
  const rel = relative(resolvedRoot, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new HeldOutAccessError("path escapes evaluation project root");
  const canonicalRelative = rel.replace(/\\/g, "/").toLocaleLowerCase();
  if ((heldOut.has(normalized.toLocaleLowerCase()) || heldOut.has(canonicalRelative)) && !manifest.candidateFrozenAt) {
    throw new HeldOutAccessError("held-out evaluation path is blocked until Candidate Freeze");
  }
  return readFile(candidate, "utf8");
}

/** Acceptance workflow's sole reader: it owns freeze state and only exposes parsed reviewer blocks. */
export class AcceptanceEvaluationReader {
  private readonly manifest: EvaluationSetManifest;
  constructor(private readonly root: string, manifest: EvaluationSetManifest) {
    this.manifest = { ...manifest, generationPaths: [...manifest.generationPaths], heldOutPaths: [...manifest.heldOutPaths], reviewerCommentPaths: [...(manifest.reviewerCommentPaths ?? [])] };
  }

  async read(path: string): Promise<string> { return readEvaluationPath(this.root, path, this.manifest); }

  /** Reviewer comments may share a source file with author responses; parse before returning text. */
  async readReviewerComments(path: string): Promise<ReviewerCommentBlock[]> {
    const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "").toLocaleLowerCase();
    if (!(this.manifest.reviewerCommentPaths ?? []).some((entry) => entry.replace(/\\/g, "/").replace(/^\.\//, "").toLocaleLowerCase() === normalized)) {
      throw new HeldOutAccessError("path is not an approved reviewer-comment source");
    }
    const source = await readContainedPath(this.root, path);
    const headings = [...source.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)];
    const blocks: ReviewerCommentBlock[] = [];
    for (let i = 0; i < headings.length; i += 1) {
      const heading = headings[i]![2]!.trim();
      const reviewerMatch = /^(?:reviewer\s*#?\s*(\d+)?|(?:外审|审稿|评审)(?:意见|人|专家)\s*[#＃：:]?\s*(\d+))(?=$|[\s：:])/i.exec(heading);
      const editorMatch = /^(?:editor(?:\s+comments?)?|编辑(?:意见)?|主编意见)(?:\s*[:：].*)?$/i.test(heading);
      if (reviewerMatch === null && !editorMatch) continue;
      const start = headings[i]!.index! + headings[i]![0].length;
      let end = i + 1 < headings.length ? headings[i + 1]!.index! : source.length;
      for (let j = i + 1; j < headings.length; j += 1) {
        if (/^(?:author(?:s)?\s+(?:response|reply)|response\s+to\s+(?:reviewer|editor)|作者(?:回复|答复)|(?:审稿|编辑)回复)/i.test(headings[j]![2]!.trim())) { end = headings[j]!.index!; break; }
      }
      const segment = source.slice(start, end);
      const authorMarker = /^(?:\*{0,2}\s*)?(?:author(?:s)?\s+(?:response|reply)|response\s+from\s+author(?:s)?|作者(?:回复|答复)|(?:审稿|编辑)回复)\s*[:：]?(?:\s*\*{0,2})?/im.exec(segment);
      if (authorMarker !== null) end = start + authorMarker.index;
      const content = source.slice(start, end).trim();
      if (content) {
        const reviewerNumber = reviewerMatch?.[1] ?? reviewerMatch?.[2];
        const label = editorMatch ? "Editor" : reviewerNumber ? `Reviewer ${reviewerNumber}` : heading;
        blocks.push({ heading: label, content });
      }
    }
    if (blocks.length === 0) throw new HeldOutAccessError("no parseable Editor/Reviewer comment blocks found");
    return blocks;
  }

  freezeCandidate(input: {
    publishable: boolean;
    candidateId: string;
    frozenAt?: string;
    /**
     * M11.4 Product Closure：冻结层级登记（不改变解锁行为，只让验收协议可区分）。
     * - revision_candidate：Revision Task Success 后冻结修订候选（任务层全过，
     *   投稿就绪性风险随报告交作者）；
     * - publication_candidate（缺省，兼容既有调用）：全部验收 gate 通过。
     * 两层都解锁 held-out 读取（评估纪律：冻结是解锁前提，层级是协议语义）。
     */
    layer?: "revision_candidate" | "publication_candidate";
  }): void {
    if (!input.publishable) throw new HeldOutAccessError("Candidate Freeze requires every acceptance gate to pass");
    if (!input.candidateId.trim()) throw new HeldOutAccessError("Candidate Freeze requires a candidate ID");
    this.manifest.candidateFrozenAt = input.frozenAt ?? new Date().toISOString();
  }

  isFrozen(): boolean { return this.manifest.candidateFrozenAt !== undefined; }
}

async function readContainedPath(root: string, requestedPath: string): Promise<string> {
  if (isAbsolute(requestedPath)) throw new HeldOutAccessError("evaluation reader accepts project-relative paths only");
  const resolvedRoot = await realpath(root);
  const candidate = await realpath(resolve(resolvedRoot, requestedPath));
  const rel = relative(resolvedRoot, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new HeldOutAccessError("path escapes evaluation project root");
  return readFile(candidate, "utf8");
}
