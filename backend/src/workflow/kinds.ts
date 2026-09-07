/**
 * 一级工作流类型（PRD §9.1）。纯常量模块：ProjectStore / HTTP 校验 / 编排层共用，
 * 避免同一组字面量在多处重复拼写。
 *
 * - idea_to_paper               从研究想法到论文
 * - existing_paper_improvement  已有 LaTeX / PDF 论文的系统性改进
 * - existing_paper_review       已有论文只读 Review（2026-09）
 */
export const WORKFLOW_KINDS = [
  "idea_to_paper",
  "existing_paper_improvement",
  "existing_paper_review",
] as const;

export type WorkflowKind = (typeof WORKFLOW_KINDS)[number];

export function isWorkflowKind(value: unknown): value is WorkflowKind {
  return typeof value === "string" && (WORKFLOW_KINDS as readonly string[]).includes(value);
}

/** 以已有论文为输入的工作流（PDF / Review Tab 等能力只对这类项目开放） */
export function isExistingPaperKind(kind: WorkflowKind | undefined): boolean {
  return kind === "existing_paper_improvement" || kind === "existing_paper_review";
}
