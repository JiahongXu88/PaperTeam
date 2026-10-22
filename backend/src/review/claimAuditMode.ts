/**
 * M15.1 Review Claim Ledger 的运行模式（独立小模块：config 只依赖它，不牵入审计实现）。
 *   auto      缺省：只读评估（published_paper_assessment）= extended；作者稿件工作流 = shadow
 *   off       不产出账本（回滚口径）
 *   shadow    不改任何 prompt，只从既有审稿输出确定性整理账本（单元模式下抽取状态如实为 NOT_REQUESTED）
 *   extended  单元 / digest fact prompt 追加论断账本契约（requestFingerprint 随之变化）
 */
export type ClaimAuditMode = "auto" | "off" | "shadow" | "extended";
export type ResolvedClaimAuditMode = "off" | "shadow" | "extended";
export const CLAIM_AUDIT_MODES: readonly ClaimAuditMode[] = ["auto", "off", "shadow", "extended"];

export function resolveClaimAuditMode(mode: ClaimAuditMode | undefined, publishedAssessment: boolean): ResolvedClaimAuditMode {
  const value = mode ?? "auto";
  if (value === "auto") return publishedAssessment ? "extended" : "shadow";
  return value;
}

export function parseClaimAuditMode(raw: string | undefined): ClaimAuditMode | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === "") return undefined;
  return (CLAIM_AUDIT_MODES as readonly string[]).includes(value) ? (value as ClaimAuditMode) : undefined;
}
