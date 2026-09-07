import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { Loading } from "../common/StateViews.js";
import { RunStatusBadge } from "./Badges.js";
import { FINDING_CATEGORY_LABELS, SEVERITY_ORDER, SEVERITY_STYLES, stageLabel, statusStyleOf } from "../common/status.js";
import {
  isRunActive,
  useCreateWorkflowRun,
  useInvalidateReviewOutputs,
  usePaper,
  usePaperReviewReport,
  useProjectRuns,
  useRuntimeStatus,
} from "../../hooks/queries.js";
import { formatApiError, summarizeRunError } from "../../utils/errors.js";
import { formatDateTime } from "../../utils/format.js";
import type { ExistingReviewReportView, ReviewFindingView, WorkflowRunView } from "../../types/api.js";
import type { PaperSectionView } from "../../types/paper.js";

/**
 * 快速 Review：未上传 PDF → 引导；未开始 → 「开始 Review」；运行中 → 阶段与章节进度；
 * 完成 → 报告（按章节分组的 findings，页码落在左侧栏位）；失败 → 原因与重试。只读，不改论文。
 *
 * run 从活跃变为终态时刷新报告 / 引用 / 项目状态（报告由后端在 review.aggregate 落盘）。
 */

const REVIEW_STAGES = ["paper.ensure", "citation.extract", "citation.metadata", "citation.claims", "review.sections", "review.aggregate"] as const;

type SeverityFilter = "all" | ReviewFindingView["severity"];

/** 未审阅章节的原因说明：只有标题 / 超出单轮上限 / 模型调用失败 */
function describeSkipped(skipped: number, empty: number, failed: number): string {
  const overCap = skipped - empty;
  const parts = [
    empty > 0 ? `${empty} 节只有标题没有正文` : undefined,
    overCap > 0 ? `${overCap} 节超出单轮上限` : undefined,
    failed > 0 ? `${failed} 节模型调用失败，可重新 Review 补齐` : undefined,
  ];
  return parts.filter((part): part is string => part !== undefined).join("，");
}

function progressOf(run: WorkflowRunView): { index: number; total: number } | undefined {
  const data = run.progress?.data;
  const index = data?.["index"];
  const total = data?.["total"];
  return typeof index === "number" && typeof total === "number" && total > 0 ? { index, total } : undefined;
}

export function ReviewPanel({ projectId, onOpenTab }: { projectId: string; onOpenTab: (tab: "pdf" | "citations") => void }) {
  const paper = usePaper(projectId);
  const runs = useProjectRuns(projectId);
  const report = usePaperReviewReport(projectId);
  const runtimeStatus = useRuntimeStatus();
  const startReview = useCreateWorkflowRun();
  const invalidateOutputs = useInvalidateReviewOutputs(projectId);

  const reviewRun = runs.data?.find((run) => run.workflowKind === "existing_paper_review");
  const active = isRunActive(reviewRun);

  // 活跃 → 终态的边沿：刷新派生数据
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active) {
      invalidateOutputs();
    }
    wasActive.current = active;
  }, [active, invalidateOutputs]);

  const doc = paper.data?.document;
  if (paper.isPending || runs.isPending) {
    return <Loading label="加载 Review 状态…" />;
  }

  if (doc === null || doc === undefined) {
    return (
      <section className="section-block" data-testid="review-panel">
        <div className="section-head">
          <h2>快速 Review</h2>
        </div>
        <div className="state-block state-empty">
          <strong>尚未导入论文 PDF</strong>
          <span>Review 以论文 PDF 为输入：先上传，再开始引用核验与分章节审阅。</span>
          <button type="button" className="btn btn-primary" onClick={() => onOpenTab("pdf")}>
            前往上传 PDF
          </button>
        </div>
      </section>
    );
  }

  const modelNotConfigured = runtimeStatus.data?.model.phase === "not_configured";
  const hasReport = report.data !== null && report.data !== undefined;

  return (
    <section className="review-panel" data-testid="review-panel">
      <div className="section-head">
        <h2>快速 Review</h2>
        {reviewRun !== undefined ? <RunStatusBadge status={reviewRun.status} /> : null}
      </div>
      <p className="panel-sub">只读分析：引用真实性核验 → 论断与引用一致性 → 分章节审阅 → Review 报告。不修改论文正文。</p>

      {active && reviewRun !== undefined ? <RunProgress run={reviewRun} /> : null}

      {reviewRun?.status === "failed" ? <RunFailure run={reviewRun} /> : null}
      {reviewRun?.status === "cancelled" && !hasReport ? (
        <p className="note note-info" role="status">
          <span>上一次 Review 已取消，可以重新开始。</span>
        </p>
      ) : null}

      {modelNotConfigured ? (
        <div className="note note-warn" role="status" data-testid="review-model-missing">
          <span>
            论文已导入。配置模型后即可开始 Review：前往<Link to="/settings/model">模型设置</Link>保存模型与 API Key。
          </span>
        </div>
      ) : null}

      {hasReport && report.data !== null && report.data !== undefined ? (
        <ReportBlock report={report.data} sections={paper.data?.sections ?? []} onOpenTab={onOpenTab} />
      ) : !active ? (
        <p className="panel-empty">{reviewRun?.status === "completed" ? "Review 已完成，正在载入报告…" : "尚未开始 Review。"}</p>
      ) : null}

      {!active ? (
        <div className="action-row" style={{ marginTop: "var(--s-4)" }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => startReview.mutate({ projectId, kind: "existing_paper_review" })}
            disabled={startReview.isPending || modelNotConfigured}
            data-testid="start-review"
          >
            {startReview.isPending ? "启动中…" : hasReport ? "重新 Review" : "开始 Review"}
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

/** 失败：一行稳定文案 + 阶段名；Provider 原始响应折叠 */
function RunFailure({ run }: { run: WorkflowRunView }) {
  const { summary, detail } = summarizeRunError(run.error?.message ?? "未知原因");
  return (
    <div className="note note-error" role="alert">
      <span>
        <span className="note-mark">✗</span> Review 失败：{summary}
        {run.currentStage !== undefined ? <span className="muted">（阶段：{stageLabel(run.currentStage)}）</span> : null}
        {detail !== undefined ? (
          <details className="details-block" style={{ marginTop: "var(--s-2)" }}>
            <summary>技术细节</summary>
            <div className="details-body mono">{detail}</div>
          </details>
        ) : null}
      </span>
    </div>
  );
}

/** 运行中：阶段清单（已完成 / 当前 / 待执行）+ 章节进度 */
function RunProgress({ run }: { run: WorkflowRunView }) {
  const currentIndex = REVIEW_STAGES.indexOf((run.currentStage ?? "") as (typeof REVIEW_STAGES)[number]);
  const progress = progressOf(run);
  const findings = run.progress?.data["findings"];
  return (
    <div className="review-progress" role="status" data-testid="review-running" aria-live="polite">
      <ol className="stage-list">
        {REVIEW_STAGES.map((stage, index) => {
          const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "todo";
          return (
            <li key={stage} className={`stage-item stage-${state}`}>
              <span className="stage-mark" aria-hidden="true" />
              <span className="stage-name">{stageLabel(stage)}</span>
              {state === "current" && stage === "review.sections" && progress !== undefined ? (
                <span className="stage-detail">
                  第 {progress.index} / {progress.total} 节{typeof findings === "number" ? `，已记录 ${findings} 条发现` : ""}
                </span>
              ) : state === "current" ? (
                <span className="stage-detail">进行中…</span>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="faint">页面每 3 秒自动刷新；离开页面不影响后台任务。</p>
    </div>
  );
}

function ReportBlock({
  report,
  sections,
  onOpenTab,
}: {
  report: ExistingReviewReportView;
  sections: PaperSectionView[];
  onOpenTab: (tab: "pdf" | "citations") => void;
}) {
  const [filter, setFilter] = useState<SeverityFilter>("all");
  const { review, findings, paper: paperMeta } = report;
  const fabrications = report.citationIntegrity.probableFabrications ?? [];
  const sectionTitle = useMemo(() => new Map(sections.map((section) => [section.sectionId, section.title])), [sections]);

  const filtered = filter === "all" ? findings : findings.filter((finding) => finding.severity === filter);
  const groups = useMemo(() => {
    const bySection = new Map<string, ReviewFindingView[]>();
    for (const finding of filtered) {
      const key = finding.sectionId ?? "";
      bySection.set(key, [...(bySection.get(key) ?? []), finding]);
    }
    for (const list of bySection.values()) {
      list.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
    }
    // 按论文章节顺序排列；没有章节的放最后
    const order = new Map(sections.map((section, index) => [section.sectionId, index]));
    return [...bySection.entries()].sort(([a], [b]) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER));
  }, [filtered, sections]);

  return (
    <div className="review-report" data-testid="review-report">
      <div className="review-summary">
        <span className="review-summary-scope">
          已审阅 {review.sectionsReviewed} / {review.sectionsTotal} 节
          {(review.skippedSections ?? 0) + (review.failedSections ?? 0) > 0
            ? `（${describeSkipped(review.skippedSections ?? 0, review.emptySections ?? 0, review.failedSections ?? 0)}）`
            : ""}
        </span>
        <div className="ledger">
          {SEVERITY_ORDER.map((severity) => {
            const style = statusStyleOf(SEVERITY_STYLES, severity);
            return (
              <span key={severity} className={`ledger-item status status-tone-${style.tone}`}>
                {style.label} {review.bySeverity[severity] ?? 0}
              </span>
            );
          })}
          <span className={`ledger-item status status-tone-${fabrications.length > 0 ? "danger" : "neutral"}`}>疑似虚构引用 {fabrications.length}</span>
        </div>
        <p className="review-summary-meta muted">
          {paperMeta.title}
          {paperMeta.pageCount !== undefined ? `，${paperMeta.pageCount} 页` : ""}；第 {report.round} 轮，{formatDateTime(report.generatedAt)}
          {fabrications.length > 0 ? (
            <>
              {" "}
              <button type="button" className="btn-link" onClick={() => onOpenTab("citations")}>
                查看引用核验明细
              </button>
            </>
          ) : null}
        </p>
      </div>

      {findings.length > 0 ? (
        <>
          <div className="section-head">
            <h3>审阅发现</h3>
            <div className="segmented" role="radiogroup" aria-label="按严重度筛选">
              {(["all", ...SEVERITY_ORDER] as const).map((value) => {
                const count = value === "all" ? findings.length : (review.bySeverity[value] ?? 0);
                const label = value === "all" ? "全部" : statusStyleOf(SEVERITY_STYLES, value).label;
                return (
                  <label key={value} className="segmented-option">
                    <input type="radio" name="severity-filter" value={value} checked={filter === value} onChange={() => setFilter(value)} />
                    {label} {count}
                  </label>
                );
              })}
            </div>
          </div>
          {groups.length === 0 ? (
            <p className="panel-empty">当前筛选下没有发现。</p>
          ) : (
            groups.map(([sectionId, list]) => (
              <section key={sectionId || "none"} className="finding-group">
                <h4 className="finding-group-title">
                  {sectionId === "" ? "未定位到章节" : (sectionTitle.get(sectionId) ?? sectionId)}
                  <span className="muted"> {list.length} 条</span>
                </h4>
                <div className="gutter-list">
                  {list.map((finding) => (
                    <FindingRow key={finding.findingId} finding={finding} />
                  ))}
                </div>
              </section>
            ))
          )}
        </>
      ) : (
        <p className="note note-success" role="status">
          <span>
            <span className="note-mark">✓</span> 本轮审阅未记录问题。
          </span>
        </p>
      )}
      {review.parseFailures !== undefined && review.parseFailures > 0 ? (
        <p className="faint" style={{ marginTop: "var(--s-2)" }}>
          {review.parseFailures} 个章节的模型输出无法解析，已跳过；重新 Review 可补齐。
        </p>
      ) : null}
    </div>
  );
}

function FindingRow({ finding }: { finding: ReviewFindingView }) {
  const severity = statusStyleOf(SEVERITY_STYLES, finding.severity);
  return (
    <article className={`gutter-row finding-row finding-${finding.severity}`}>
      <span className="gutter-num">{finding.page !== undefined ? `p${finding.page}` : ""}</span>
      <div className="gutter-body">
        <div className="finding-tags">
          <span className={`chip chip-tone-${severity.tone === "danger" ? "danger" : severity.tone === "warn" ? "warn" : "neutral"}`}>{severity.label}</span>
          <span className="chip">{FINDING_CATEGORY_LABELS[finding.category] ?? finding.category}</span>
        </div>
        <p className="finding-message">{finding.message}</p>
        {finding.claimText !== undefined ? <blockquote className="finding-claim reading">{finding.claimText}</blockquote> : null}
        {finding.suggestion !== undefined ? <p className="finding-suggestion">建议：{finding.suggestion}</p> : null}
      </div>
      <span className="gutter-side" />
    </article>
  );
}
