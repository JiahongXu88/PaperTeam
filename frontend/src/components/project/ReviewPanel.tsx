import { Link } from "react-router-dom";

import { Loading } from "../common/StateViews.js";
import { RunStatusBadge } from "./Badges.js";
import {
  useCreateWorkflowRun,
  usePaper,
  usePaperReviewReport,
  useProjectRuns,
  useRuntimeStatus,
} from "../../hooks/queries.js";
import { formatApiError } from "../../utils/errors.js";
import { formatDateTime } from "../../utils/format.js";
import type {
  ExistingReviewReportView,
  ReviewFindingView,
  WorkflowRunView,
} from "../../types/api.js";

/**
 * 快速 Review 面板（existing_paper_review，Project Entry & Lifecycle UX 2026-09）。
 *
 * 状态机：未上传 PDF → 引导上传；未开始 → 主 CTA「开始 Review」（模型未配置
 * 时给出引导，不丢项目）；运行中 → 实时阶段进度；完成 → 聚合审阅报告；
 * 失败 → 错误与重试。不执行论文重写 / 修订。
 */

const STAGE_LABELS: Record<string, string> = {
  "paper.ensure": "解析论文结构（PaperMap）",
  "citation.extract": "提取引用",
  "citation.metadata": "引用真实性核验",
  "citation.claims": "论断-引用一致性核验",
  "review.sections": "分章节审阅",
  "review.aggregate": "汇总审阅报告",
};

const SEVERITY_LABELS: Record<string, string> = {
  critical: "严重",
  major: "主要",
  minor: "次要",
  info: "提示",
};

const CATEGORY_LABELS: Record<string, string> = {
  fact: "事实",
  academic: "学术",
  style: "风格",
  citation: "引用",
  consistency: "一致性",
};

const SEVERITY_ORDER: ReviewFindingView["severity"][] = ["critical", "major", "minor", "info"];

function severityTone(severity: string): string {
  return severity === "critical" ? "danger" : severity === "major" ? "warn" : "neutral";
}

function isRunActive(run: WorkflowRunView | undefined): boolean {
  return (
    run !== undefined &&
    (run.status === "pending" || run.status === "running" || run.status === "awaiting_input")
  );
}

export function ReviewPanel({
  projectId,
  onOpenTab,
}: {
  projectId: string;
  onOpenTab: (tab: "pdf" | "citations") => void;
}) {
  const paper = usePaper(projectId);
  const runs = useProjectRuns(projectId, 3000);
  const report = usePaperReviewReport(projectId);
  const runtimeStatus = useRuntimeStatus();
  const startReview = useCreateWorkflowRun(projectId);

  const reviewRun = runs.data?.find((run) => run.workflowKind === "existing_paper_review");
  const active = isRunActive(reviewRun);
  const doc = paper.data?.document;

  if (paper.isPending || runs.isPending) {
    return <Loading label="加载 Review 状态…" />;
  }

  const onStart = () => {
    startReview.mutate("existing_paper_review");
  };

  // 1. 没有论文 → 引导上传（不出现死胡同）
  if (doc === null || doc === undefined) {
    return (
      <section data-testid="review-panel">
        <div className="section-head">
          <h2>快速 Review</h2>
        </div>
        <p className="panel-empty">尚未导入论文 PDF。</p>
        <div className="action-row" style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-primary" onClick={() => onOpenTab("pdf")}>
            前往上传 PDF
          </button>
        </div>
      </section>
    );
  }

  const modelNotConfigured = runtimeStatus.data?.model.phase === "not_configured";

  return (
    <section className="review-panel" data-testid="review-panel">
      <div className="section-head">
        <h2>快速 Review</h2>
        {reviewRun !== undefined ? (
          <span className="action-row">
            <RunStatusBadge status={reviewRun.status} />
          </span>
        ) : null}
      </div>
      <p className="panel-sub">
        只读分析现有论文：引用真实性核验 → 论断-引用一致性 → 分章节审阅 → 汇总审阅报告。不修改论文正文。
      </p>

      {/* 2. 运行中：阶段进度（自动刷新） */}
      {active ? (
        <div className="note note-info" role="status" data-testid="review-running">
          <span>
            Review 进行中{reviewRun!.currentStage !== undefined
              ? `：${STAGE_LABELS[reviewRun!.currentStage] ?? reviewRun!.currentStage}`
              : ""}
            （自动刷新）
          </span>
        </div>
      ) : null}

      {/* 3. 失败：如实展示错误 + 重试 */}
      {reviewRun?.status === "failed" ? (
        <div className="note note-error" role="alert">
          <span>
            <span className="note-mark">✗</span> Review 失败：
            {reviewRun.error?.message ?? formatApiError(reviewRun.error)}
          </span>
        </div>
      ) : null}

      {/* 4. 模型未配置：导入不受影响，配置后即可开始 */}
      {modelNotConfigured ? (
        <div className="note note-warn" role="status" data-testid="review-model-missing">
          <span>
            论文已导入。配置模型后即可开始 Review——可前往
            <Link to="/settings/model">「模型设置」</Link>
            保存模型与 API Key。
          </span>
        </div>
      ) : null}

      {report.data !== null && report.data !== undefined ? (
        <ReportBlock report={report.data} onOpenTab={onOpenTab} />
      ) : !active ? (
        <p className="panel-empty" style={{ marginTop: 12 }}>
          {reviewRun?.status === "completed"
            ? "审阅已完成，报告生成中…"
            : "尚未开始 Review。"}
        </p>
      ) : null}

      {!active ? (
        <div className="action-row" style={{ marginTop: 16 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onStart}
            disabled={startReview.isPending || modelNotConfigured}
            data-testid="start-review"
          >
            {startReview.isPending
              ? "启动中…"
              : report.data !== null && report.data !== undefined
                ? "重新 Review"
                : "开始 Review"}
          </button>
          {startReview.isError ? (
            <span className="form-error" role="alert">
              启动失败：{formatApiError(startReview.error)}
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** 聚合报告展示：规模统计 + 分级 findings 列表 */
function ReportBlock({
  report,
  onOpenTab,
}: {
  report: ExistingReviewReportView;
  onOpenTab: (tab: "pdf" | "citations") => void;
}) {
  const { review, findings, paper: paperMeta } = report;
  const sorted = [...findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  const fabrications = report.citationIntegrity.probableFabrications ?? [];

  return (
    <div className="review-report" data-testid="review-report">
      <div className="review-stats">
        <div className="review-stat">
          <span className="review-stat-value">{review.sectionsReviewed}</span>
          <span className="review-stat-label">已审章节 / 共 {review.sectionsTotal}</span>
        </div>
        {(["critical", "major", "minor", "info"] as const).map((severity) => (
          <div className="review-stat" key={severity}>
            <span className={`review-stat-value tone-${severityTone(severity)}`}>
              {review.bySeverity[severity] ?? 0}
            </span>
            <span className="review-stat-label">{SEVERITY_LABELS[severity]}</span>
          </div>
        ))}
        <div className="review-stat">
          <span className="review-stat-value">{fabrications.length}</span>
          <span className="review-stat-label">疑似虚构引用</span>
        </div>
      </div>

      <p className="muted" style={{ margin: "12px 0" }}>
        {paperMeta.title}
        {paperMeta.pageCount !== undefined ? ` · ${paperMeta.pageCount} 页` : ""} · 第 {report.round} 轮 ·{" "}
        {formatDateTime(report.generatedAt)}
        {fabrications.length > 0 ? (
          <>
            {" · "}
            <button type="button" className="link-like" onClick={() => onOpenTab("citations")}>
              查看引用核验明细
            </button>
          </>
        ) : null}
      </p>

      {sorted.length > 0 ? (
        <ul className="review-findings">
          {sorted.map((finding) => (
            <li key={finding.findingId} className="review-finding">
              <span className={`chip chip-tone-${severityTone(finding.severity)}`}>
                {SEVERITY_LABELS[finding.severity]}
              </span>
              <span className="chip">{CATEGORY_LABELS[finding.category] ?? finding.category}</span>
              <span className="review-finding-loc">
                {finding.sectionId ?? "—"}
                {finding.page !== undefined ? ` · p${finding.page}` : ""}
              </span>
              <p className="review-finding-message">{finding.message}</p>
              {finding.claimText !== undefined ? (
                <p className="review-finding-claim">相关论断：{finding.claimText}</p>
              ) : null}
              {finding.suggestion !== undefined ? (
                <p className="review-finding-suggestion">建议：{finding.suggestion}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="note note-success" role="status">
          <span>
            <span className="note-mark">✓</span> 本轮审阅未发现问题。
          </span>
        </p>
      )}
      {review.parseFailures !== undefined && review.parseFailures > 0 ? (
        <p className="faint" style={{ marginTop: 8 }}>
          {review.parseFailures} 个章节的审阅输出无法解析，已跳过（可重新 Review 补齐）。
        </p>
      ) : null}
    </div>
  );
}
