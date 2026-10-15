/**
 * M14.2：研究输入（ResearchInput）视图类型（Backend thesis/researchInputTypes.ts 投影）。
 * 只声明面板消费的字段；完整契约以 Backend 为准。
 */

export type ResearchInputType =
  | "published_paper"
  | "preprint"
  | "submitted_manuscript"
  | "unpublished_manuscript"
  | "experiment_report";

export const RESEARCH_INPUT_TYPE_OPTIONS: ReadonlyArray<{ value: ResearchInputType; label: string }> = [
  { value: "published_paper", label: "已发表论文" },
  { value: "preprint", label: "预印本" },
  { value: "submitted_manuscript", label: "在投稿件" },
  { value: "unpublished_manuscript", label: "未发表手稿" },
  { value: "experiment_report", label: "实验报告" },
];

export interface ResearchInputSummaryView {
  inputId: string;
  inputType: ResearchInputType;
  title: string;
  workId: string;
  contentHash: string;
  versionLabel?: string;
  /** proposed / included / excluded / superseded */
  scope: string;
  /** pending / full_text / partial / failed / metadata_only / unsupported */
  parseStatus: string;
  publicationStatus?: string;
  unpublishedMaterialAllowed?: boolean;
}

export interface ResearchInputsFileView {
  inputs: ResearchInputSummaryView[];
  workGroups: Array<{ workId: string; inputIds: string[]; preferredInputId?: string }>;
}

export interface ResearchInputFactView {
  factId: string;
  kind: string;
  surface: string;
  /** extracted / source_verified / author_confirmed */
  verification: string;
  /** none / unresolved / resolved / deferred */
  conflictStatus: string;
}

export interface ResearchConflictView {
  conflictId: string;
  classification: string;
  severity: string;
  parties: Array<{ factId: string; raw: string; location: string; researchInputId?: string }>;
}

export interface ResearchDecisionResult {
  decisionId: string;
  duplicate: boolean;
}
