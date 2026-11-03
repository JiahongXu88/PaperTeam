/**
 * 项目设置 → 审稿政策快照（WorkflowOrchestrator.createRun 冻结 / 手动审稿入口即时构建）。
 * 与 publicationPolicy.ts 分开：本文件可以依赖 ProjectStore 与期刊 registry，政策模块保持纯函数。
 */
import { workflowKindForDocumentType, type ProjectMetadata } from "../project/ProjectStore.js";
import { resolveJournalProfile } from "../target/journal/profileRegistry.js";
import { buildReviewPolicySnapshot, type ReviewPolicySnapshot } from "./publicationPolicy.js";

export function freezeReviewPolicy(
  project: Pick<ProjectMetadata, "documentType" | "publicationTarget" | "workflowKind">,
  workflowKind: string,
  now: Date,
): ReviewPolicySnapshot {
  const target = project.publicationTarget ?? null;
  const profile = target?.targetJournalId !== undefined ? resolveJournalProfile({ journalId: target.targetJournalId }).profile : null;
  return buildReviewPolicySnapshot({
    workflowKind,
    ...(project.documentType !== undefined ? { documentType: project.documentType } : {}),
    documentTypeKind: project.documentType !== undefined ? workflowKindForDocumentType(project.documentType) : (project.workflowKind ?? "idea_to_paper"),
    target,
    profile,
    now,
  });
}
