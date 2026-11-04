/**
 * M17.1：风格审查发现 → 受控定点修订（纯函数；IO 与提交边界在 workflow 的 revision.style_audit_apply）。
 *
 * 一条风格发现只有同时满足以下全部条件才会落盘（任一不满足 → 原文保留，状态与原因写入修订记录）：
 *   1. 机器分级 AUTO_REWRITE_ELIGIBLE（见 academicStyleAudit.classifyStyleFinding）；本 run 未处理过；未超出条数上限；
 *   2. 原句在**当前**目标内容中唯一定位（ANCHOR_LOST：已被改动 / 不唯一 / 组装根上无法定位到摘要载体）；
 *   3. 锚内确定性守卫（checkStyleRewrite）再次通过；
 *   4. EditContract（academic_style_rewrite：锚内替换 / 删除，数值与引用硬冻结）对**整份目标**校验通过（锚外逐字保留）；
 *   5. 整份目标的论断强度升级 / 结论翻转检测无新增；
 *   6. 只可否决的语义复核判 EQUIVALENT（UNSURE / CHANGED / 调用失败 = 保持原文，交作者）。
 * 同一目标的多处补丁按位置合并后整体再校验一次（契约 + 强度 + 翻转），任一失败则该目标全部补丁不落盘。
 */

import { checkClaimStrengthEscalation } from "../quality/claimStrength.js";
import { academicStyleRewriteContract, describeEditContractVerdict, validateCandidateEdit } from "../quality/editContract.js";
import { detectClauseConclusionFlips } from "../quality/factPreservation.js";
import {
  checkStyleRewrite,
  locateStyleQuote,
  type StyleFinding,
  type StyleRevisionItem,
  type StyleRewriteCheckItem,
  type StyleSemanticVerdict,
} from "./academicStyleAudit.js";

export interface StyleRevisionTarget {
  /** manuscript 相对路径或 "abstract" */
  target: string;
  carrier: "abstract" | "file";
  content: string;
}

export interface StyleRevisionCandidate {
  finding: StyleFinding;
  target: StyleRevisionTarget;
  start: number;
  end: number;
  /** 原文中实际匹配到的片段（含原有换行等空白） */
  matched: string;
  rewrite: string;
  /** 语义复核上下文（原句所在段落，≤ 400 字） */
  context: string;
}

export interface PrepareStyleRevisionInput {
  findings: readonly StyleFinding[];
  /** 已在本 run 中处理过的 finding id（不重复派发——防无界循环） */
  attempted: ReadonlySet<string>;
  maxAutoRewrites: number;
  resolveTarget: (finding: StyleFinding) => StyleRevisionTarget | { error: string };
}

export interface PreparedStyleRevision {
  candidates: StyleRevisionCandidate[];
  /** 未进入语义复核的条目（已有终态） */
  settled: StyleRevisionItem[];
}

function paragraphContext(content: string, start: number, end: number): string {
  const left = content.lastIndexOf("\n\n", start);
  const right = content.indexOf("\n\n", end);
  const paragraph = content.slice(left === -1 ? 0 : left + 2, right === -1 ? content.length : right).replace(/\s+/g, " ").trim();
  if (paragraph.length <= 400) return paragraph;
  const offset = Math.max(0, start - (left === -1 ? 0 : left + 2) - 150);
  return `…${paragraph.slice(offset, offset + 400)}…`;
}

const itemOf = (finding: StyleFinding, status: StyleRevisionItem["status"], detail: string, extra: Partial<StyleRevisionItem> = {}): StyleRevisionItem => ({
  findingId: finding.id,
  file: finding.file,
  heading: finding.heading,
  styleCategory: finding.styleCategory,
  before: finding.originalQuote,
  after: finding.proposedRewrite ?? "",
  status,
  detail,
  ...extra,
});

export function prepareStyleRevisions(input: PrepareStyleRevisionInput): PreparedStyleRevision {
  const candidates: StyleRevisionCandidate[] = [];
  const settled: StyleRevisionItem[] = [];
  for (const finding of input.findings) {
    if (finding.disposition !== "AUTO_REWRITE_ELIGIBLE" || finding.proposedRewrite === undefined) continue;
    if (input.attempted.has(finding.id)) continue;
    if (candidates.length >= input.maxAutoRewrites) {
      settled.push(itemOf(finding, "NOT_DISPATCHED", `本 run 自动风格修订上限 ${input.maxAutoRewrites} 条已用满：保留原文，见风格报告`));
      continue;
    }
    const resolved = input.resolveTarget(finding);
    if ("error" in resolved) {
      settled.push(itemOf(finding, "ANCHOR_LOST", resolved.error));
      continue;
    }
    const location = locateStyleQuote(resolved.content, finding.originalQuote);
    if (location.count !== 1) {
      settled.push(itemOf(finding, "ANCHOR_LOST", location.count === 0 ? "原句已不在当前稿件中（可能已被其他修订改动）：不改写" : `原句在目标中出现 ${location.count} 次：锚点不唯一，不改写`));
      continue;
    }
    const matched = resolved.content.slice(location.start, location.end);
    const guard = checkStyleRewrite(matched, finding.proposedRewrite, finding.styleCategory);
    if (!guard.ok) {
      settled.push(itemOf(finding, "GUARD_REJECTED", `锚内守卫未通过：${guard.violations.map((violation) => violation.detail).join("；")}`, { guard }));
      continue;
    }
    const after = `${resolved.content.slice(0, location.start)}${finding.proposedRewrite}${resolved.content.slice(location.end)}`;
    const verdict = validateCandidateEdit({
      target: resolved.target,
      baseline: resolved.content,
      candidate: after,
      contracts: [academicStyleRewriteContract({ projectId: "-", file: resolved.target, carrier: resolved.carrier, baseContent: resolved.content, anchors: [matched] })],
    });
    if (!verdict.ok) {
      settled.push(itemOf(finding, "GUARD_REJECTED", `编辑契约拒绝：${describeEditContractVerdict(verdict)}`, { guard, editContract: { ok: false, detail: describeEditContractVerdict(verdict) } }));
      continue;
    }
    candidates.push({
      finding, target: resolved, start: location.start, end: location.end, matched, rewrite: finding.proposedRewrite,
      context: paragraphContext(resolved.content, location.start, location.end),
    });
  }
  return { candidates, settled };
}

export function styleRewriteCheckItems(candidates: readonly StyleRevisionCandidate[]): StyleRewriteCheckItem[] {
  return candidates.map((candidate) => ({
    id: candidate.finding.id,
    category: candidate.finding.styleCategory,
    original: candidate.matched.replace(/\s+/g, " ").trim(),
    rewrite: candidate.rewrite,
    context: candidate.context,
  }));
}

export interface StyleRevisionWrite {
  target: StyleRevisionTarget;
  after: string;
  verdict: ReturnType<typeof validateCandidateEdit>;
}

/**
 * 语义复核之后的合并与整体校验。verdicts 缺失的条目视为 UNAVAILABLE（保持原文）。
 * 返回待写入的目标（已整体通过契约 + 强度 + 翻转检测）与全部条目的终态。
 */
export function finalizeStyleRevisions(input: {
  projectId: string;
  runId: string;
  candidates: readonly StyleRevisionCandidate[];
  verdicts: ReadonlyMap<string, { verdict: StyleSemanticVerdict; reason: string }> | null;
  semanticUnavailableReason?: string;
}): { writes: StyleRevisionWrite[]; items: StyleRevisionItem[] } {
  const items: StyleRevisionItem[] = [];
  const passed: StyleRevisionCandidate[] = [];
  for (const candidate of input.candidates) {
    const guard = checkStyleRewrite(candidate.matched, candidate.rewrite, candidate.finding.styleCategory);
    const verdict = input.verdicts?.get(candidate.finding.id);
    if (verdict === undefined) {
      items.push(itemOf(candidate.finding, "AUTHOR_DECISION", `语义复核不可用（${input.semanticUnavailableReason ?? "复核未返回该条目"}）：无法确认语义不变，保持原文、交作者决定`, {
        guard, semantic: { verdict: "UNAVAILABLE", reason: input.semanticUnavailableReason ?? "复核未返回该条目" },
      }));
      continue;
    }
    if (verdict.verdict !== "EQUIVALENT") {
      items.push(itemOf(candidate.finding, verdict.verdict === "CHANGED" ? "SEMANTIC_REJECTED" : "AUTHOR_DECISION",
        verdict.verdict === "CHANGED" ? `语义复核判定改写改变了科学命题：${verdict.reason}——保持原文` : `语义复核无法确定等价：${verdict.reason}——保持原文、交作者决定`,
        { guard, semantic: verdict }));
      continue;
    }
    passed.push(candidate);
  }
  const byTarget = new Map<string, StyleRevisionCandidate[]>();
  for (const candidate of passed) byTarget.set(candidate.target.target, [...(byTarget.get(candidate.target.target) ?? []), candidate]);
  const writes: StyleRevisionWrite[] = [];
  for (const [, group] of byTarget) {
    const target = group[0]!.target;
    const ordered = [...group].sort((a, b) => a.start - b.start);
    const kept: StyleRevisionCandidate[] = [];
    for (const candidate of ordered) {
      const previous = kept[kept.length - 1];
      if (previous !== undefined && candidate.start < previous.end) {
        items.push(itemOf(candidate.finding, "AUTHOR_DECISION", "与同一目标中另一处风格改写的原文区间重叠：只执行前者，本条保留原文", { semantic: input.verdicts!.get(candidate.finding.id)! }));
        continue;
      }
      kept.push(candidate);
    }
    let after = target.content;
    for (const candidate of [...kept].reverse()) after = `${after.slice(0, candidate.start)}${candidate.rewrite}${after.slice(candidate.end)}`;
    const verdict = validateCandidateEdit({
      target: target.target,
      baseline: target.content,
      candidate: after,
      contracts: [academicStyleRewriteContract({ projectId: input.projectId, runId: input.runId, file: target.target, carrier: target.carrier, baseContent: target.content, anchors: kept.map((candidate) => candidate.matched) })],
    });
    const escalations = checkClaimStrengthEscalation({ file: target.target, before: target.content, after, relatedEvidence: [] });
    const flips = detectClauseConclusionFlips(target.content, after);
    const failure = !verdict.ok
      ? `合并后编辑契约拒绝：${describeEditContractVerdict(verdict)}`
      : escalations.length > 0
        ? `合并后检测到论断强度升级：${escalations.map((finding) => finding.after).join("；").slice(0, 200)}`
        : flips.length > 0
          ? `合并后检测到结论 / 比较方向翻转：${flips.map((flip) => `${flip.before} → ${flip.after}`).join("；").slice(0, 200)}`
          : null;
    for (const candidate of kept) {
      const semantic = input.verdicts!.get(candidate.finding.id)!;
      items.push(failure === null
        ? itemOf(candidate.finding, "AUTO_FIXED", "纯措辞修订已落盘：锚内守卫、编辑契约、强度 / 翻转检测与语义复核均通过", {
            after: candidate.rewrite, guard: checkStyleRewrite(candidate.matched, candidate.rewrite, candidate.finding.styleCategory),
            editContract: { ok: true, contractId: verdict.contractIds[0] ?? "" }, semantic,
          })
        : itemOf(candidate.finding, "GUARD_REJECTED", `${failure}（该目标全部风格改写保持原文）`, { semantic, editContract: { ok: verdict.ok, detail: failure } }));
    }
    if (failure === null) writes.push({ target, after, verdict });
  }
  return { writes, items };
}
