import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { Icon, type IconName } from "../common/Icon.js";
import { Loading } from "../common/StateViews.js";
import { RunStatusBadge } from "./Badges.js";
import { FINDING_CATEGORY_LABELS, SEVERITY_ORDER, SEVERITY_STYLES, stageLabel, statusStyleOf } from "../common/status.js";
import {
  isRunActive,
  useCreateWorkflowRun,
  useExportReviewReport,
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
 * 完成 → 报告（进度环 + 严重度统计 + 可筛选 / 搜索 / 排序的发现列表）；失败 → 原因与重试。
 * 只读，不改论文。筛选、搜索、排序都在已加载的报告数据上完成（后端只提供整份报告）。
 *
 * run 从活跃变为终态时刷新报告 / 引用 / 项目状态（报告由后端在 review.aggregate 落盘）。
 */

const REVIEW_STAGES = ["paper.ensure", "citation.extract", "citation.metadata", "citation.claims", "review.sections", "review.aggregate"] as const;

type Severity = ReviewFindingView["severity"];
type SeverityFilter = "all" | Severity;
type CategoryFilter = "all" | ReviewFindingView["category"];
type SortMode = "paper" | "severity" | "page";

const SEVERITY_ICONS: Record<Severity, IconName> = {
  critical: "alert-circle",
  major: "alert-triangle",
  minor: "info-circle",
  info: "minus-circle",
};

const CATEGORY_ORDER: ReadonlyArray<ReviewFindingView["category"]> = ["fact", "academic", "style", "citation", "consistency"];

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
  const total = data?.["total"];
  // 并发审阅后进度口径是「已完成节数」（completed）；index 为旧串行版的字段名，兼容读取
  const index = data?.["completed"] ?? data?.["index"];
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
  const exportReport = useExportReviewReport(projectId);

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
            <Icon name="upload" />
            前往上传 PDF
          </button>
        </div>
      </section>
    );
  }

  const modelNotConfigured = runtimeStatus.data?.model.phase === "not_configured";
  const hasReport = report.data !== null && report.data !== undefined;

  const actions = !active ? (
          <div className="action-row">
            {hasReport ? (
              <button
                type="button"
                className="btn"
                onClick={() => exportReport.mutate()}
                disabled={exportReport.isPending}
                title="下载完整 Review 报告（Markdown，UTF-8；与页面同一套结构化数据，不受筛选影响）"
                data-testid="export-report"
              >
                <Icon name="download" />
                {exportReport.isPending ? "导出中…" : "导出报告"}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => startReview.mutate({ projectId, kind: "existing_paper_review" })}
              disabled={startReview.isPending || modelNotConfigured}
              data-testid="start-review"
            >
              <Icon name={hasReport ? "refresh" : "play"} />
              {startReview.isPending ? "启动中…" : hasReport ? "重新 Review" : "开始 Review"}
            </button>
          </div>
        ) : null;

  return (
    <section className="review-panel" data-testid="review-panel">
      {!hasReport && <div className="review-intro">
        <div className="review-intro-text">
          <div className="review-intro-title">
            <h2>快速 Review</h2>
            {reviewRun !== undefined ? <RunStatusBadge status={reviewRun.status} /> : null}
          </div>
          <p className="panel-sub">只读分析：引用真实性核验 → 论断与引用一致性 → 分章节审阅 → Review 报告。不修改论文正文。</p>
        </div>
        {actions}
      </div>}

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

      {startReview.isError ? (
        <p className="form-error" role="alert">
          启动失败：{formatApiError(startReview.error)}
        </p>
      ) : null}
      {exportReport.isError ? (
        <p className="form-error" role="alert">
          导出失败：{formatApiError(exportReport.error)}
        </p>
      ) : null}

      {hasReport && report.data !== null && report.data !== undefined ? (
        <ReportBlock actions={actions} report={report.data} sections={paper.data?.sections ?? []} onOpenTab={onOpenTab} />
      ) : !active ? (
        <p className="panel-empty">{reviewRun?.status === "completed" ? "Review 已完成，正在载入报告…" : "尚未开始 Review。"}</p>
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

/** 进度环：value / total，中心显示数字与说明 */
function ProgressRing({ value, total, caption }: { value: number; total: number; caption: string }) {
  const gradientId = useId();
  const size = 128;
  const stroke = 12;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = total > 0 ? Math.min(1, Math.max(0, value / total)) : 0;
  return (
    <div className="ring" role="img" aria-label={`${caption} ${value} / ${total}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <defs><linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="var(--accent-primary)" /><stop offset="100%" stopColor="var(--warning)" /></linearGradient></defs>
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} />
        <circle
          className="ring-value"
          style={{ stroke: `url(#${gradientId})` }}
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeDasharray={`${circumference * ratio} ${circumference}`}
        />
      </svg>
      <div className="ring-center">
        <span className="ring-number">
          {value}
          <small> / {total}</small>
        </span>
        <span className="ring-caption">{caption}</span>
      </div>
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
      <ProgressRing value={progress?.index ?? 0} total={progress?.total ?? 0} caption="章节完成" />
      <div>
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
        <p className="faint" style={{ marginTop: "var(--s-3)" }}>
          页面每 3 秒自动刷新；离开页面不影响后台任务。
        </p>
      </div>
    </div>
  );
}

function matchesQuery(finding: ReviewFindingView, query: string, sectionTitle: string | undefined): boolean {
  if (query === "") {
    return true;
  }
  const haystack = [finding.message, finding.suggestion, finding.claimText, sectionTitle, finding.page !== undefined ? `p${finding.page}` : undefined]
    .filter((part): part is string => part !== undefined)
    .join("\n")
    .toLowerCase();
  return haystack.includes(query);
}

function ReportBlock({
  actions,
  report,
  sections,
  onOpenTab,
}: {
  actions: ReactNode;
  report: ExistingReviewReportView;
  sections: PaperSectionView[];
  onOpenTab: (tab: "pdf" | "citations") => void;
}) {
  const [severity, setSeverity] = useState<SeverityFilter>("all");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [sort, setSort] = useState<SortMode>("paper");
  const [query, setQuery] = useState("");
  const { review, findings, paper: paperMeta } = report;
  const fabrications = report.citationIntegrity.probableFabrications ?? [];
  const sectionTitle = useMemo(() => new Map(sections.map((section) => [section.sectionId, section.title])), [sections]);
  const sectionOrder = useMemo(() => new Map(sections.map((section, index) => [section.sectionId, index])), [sections]);

  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const list = findings.filter(
      (finding) =>
        (severity === "all" || finding.severity === severity) &&
        (category === "all" || finding.category === category) &&
        matchesQuery(finding, normalized, finding.sectionId !== undefined ? sectionTitle.get(finding.sectionId) : undefined),
    );
    const paperOrder = (a: ReviewFindingView, b: ReviewFindingView) =>
      (sectionOrder.get(a.sectionId ?? "") ?? Number.MAX_SAFE_INTEGER) - (sectionOrder.get(b.sectionId ?? "") ?? Number.MAX_SAFE_INTEGER) ||
      (a.page ?? Number.MAX_SAFE_INTEGER) - (b.page ?? Number.MAX_SAFE_INTEGER);
    const severityOrder = (a: ReviewFindingView, b: ReviewFindingView) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    const pageOrder = (a: ReviewFindingView, b: ReviewFindingView) => (a.page ?? Number.MAX_SAFE_INTEGER) - (b.page ?? Number.MAX_SAFE_INTEGER);
    // 稳定排序：同序元素保持后端给出的顺序
    return list
      .map((finding, index) => ({ finding, index }))
      .sort((a, b) => {
        const primary = sort === "severity" ? severityOrder(a.finding, b.finding) || paperOrder(a.finding, b.finding) : sort === "page" ? pageOrder(a.finding, b.finding) || severityOrder(a.finding, b.finding) : paperOrder(a.finding, b.finding);
        return primary || a.index - b.index;
      })
      .map((entry) => entry.finding);
  }, [findings, severity, category, query, sort, sectionTitle, sectionOrder]);

  const severityCounts = SEVERITY_ORDER.map((key) => ({ key, count: review.bySeverity[key] ?? 0 }));
  const categoryCounts = CATEGORY_ORDER.filter((key) => (review.byCategory[key] ?? 0) > 0);
  const sortLabel = sort === "paper" ? "按论文顺序展示" : sort === "severity" ? "按严重度展示" : "按页码展示";
  const filtered = visible.length !== findings.length;

  return (
    <div className="review-report" data-testid="review-report">
      <div className="review-summary">
        <ProgressRing value={review.sectionsReviewed} total={review.sectionsTotal} caption="章节完成" />
        <div className="review-summary-text">
          <span className="status status-tone-ok">审阅报告已生成</span>
          <span className="review-summary-scope">
            已审阅 {review.sectionsReviewed} / {review.sectionsTotal} 节
            {(review.skippedSections ?? 0) + (review.failedSections ?? 0) > 0
              ? `（${describeSkipped(review.skippedSections ?? 0, review.emptySections ?? 0, review.failedSections ?? 0)}）`
              : ""}
          </span>
          <span className="review-summary-meta review-summary-title" title={paperMeta.title}>
            {paperMeta.title}
            {paperMeta.pageCount !== undefined ? ` · ${paperMeta.pageCount} 页` : ""}
          </span>
          <span className="review-summary-meta">
            第 {report.round} 轮 · {formatDateTime(report.generatedAt)}
          </span>
          <span className={`review-summary-meta${fabrications.length > 0 ? " run-error" : ""}`}>
            疑似虚构引用 {fabrications.length}
            {fabrications.length > 0 ? (
              <>
                {" · "}
                <button type="button" className="btn-link" onClick={() => onOpenTab("citations")}>
                  查看引用核验明细
                </button>
              </>
            ) : null}
          </span>
          <div className="review-summary-actions">{actions}</div>
        </div>
        <div className="review-summary-stats">
          <div className="review-stat-grid">
            {severityCounts.map(({ key, count }) => (
              <div key={key} className={`stat-block stat-block-${key}`}>
                <span className="stat-block-label">
                  <Icon name={SEVERITY_ICONS[key]} />
                  {statusStyleOf(SEVERITY_STYLES, key).label}
                </span>
                <span className="stat-block-value">{count}</span>
              </div>
            ))}
          </div>
          <SeverityDistribution counts={severityCounts} total={review.findingsTotal} />
        </div>
      </div>

      {findings.length > 0 ? (
        <>
          <div className="review-toolbar">
            <div className="pill-group" role="radiogroup" aria-label="按严重度筛选">
              {(["all", ...SEVERITY_ORDER] as const).map((value) => {
                const count = value === "all" ? findings.length : (review.bySeverity[value] ?? 0);
                const label = value === "all" ? "全部" : statusStyleOf(SEVERITY_STYLES, value).label;
                return (
                  <label key={value} className="pill">
                    <input type="radio" name="severity-filter" value={value} checked={severity === value} onChange={() => setSeverity(value)} />
                    {label} <span className="pill-count">{count}</span>
                  </label>
                );
              })}
            </div>
            <div className="review-toolbar-tools">
              <label className="search-field">
                <Icon name="search" />
                <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索审阅发现…" aria-label="搜索审阅发现" />
              </label>
              <select value={category} onChange={(event) => setCategory(event.target.value as CategoryFilter)} aria-label="按类别筛选">
                <option value="all">全部类别</option>
                {categoryCounts.map((key) => (
                  <option key={key} value={key}>
                    {FINDING_CATEGORY_LABELS[key] ?? key} {review.byCategory[key] ?? 0}
                  </option>
                ))}
              </select>
              <select value={sort} onChange={(event) => setSort(event.target.value as SortMode)} aria-label="排序">
                <option value="paper">论文顺序</option>
                <option value="severity">严重度优先</option>
                <option value="page">页码</option>
              </select>
            </div>
          </div>

          <div className="review-list-head">
            <h3>审阅发现</h3>
            <span className="review-list-note">
              共 {findings.length} 条 · {sortLabel}
              {filtered ? ` · 当前显示 ${visible.length} 条` : ""}
            </span>
          </div>

          {visible.length === 0 ? (
            <p className="panel-empty">当前筛选下没有发现。</p>
          ) : (
            <div className="finding-list">
              {visible.map((finding) => (
                <FindingCard key={finding.findingId} finding={finding} sectionTitle={finding.sectionId !== undefined ? sectionTitle.get(finding.sectionId) : undefined} />
              ))}
            </div>
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
        <p className="faint">{review.parseFailures} 个章节的模型输出无法解析，已跳过；重新 Review 可补齐。</p>
      ) : null}
    </div>
  );
}

/** 严重度分布：比例条 + 图例（百分比按发现总数） */
function SeverityDistribution({ counts, total }: { counts: Array<{ key: Severity; count: number }>; total: number }) {
  const sum = counts.reduce((acc, item) => acc + item.count, 0);
  const denominator = total > 0 ? total : sum;
  return (
    <div className="aside-section">
      <div className="dist-bar" aria-hidden="true">
        {counts
          .filter((item) => item.count > 0)
          .map((item) => (
            <span key={item.key} className={`dist-bar-seg sev-fill-${item.key}`} style={{ width: `${sum > 0 ? (item.count / sum) * 100 : 0}%` }} />
          ))}
      </div>
      <div className="dist-legend">
        {counts.map((item) => (
          <span key={item.key} className="dist-legend-item">
            <span className={`dot sev-fill-${item.key}`} aria-hidden="true" />
            {statusStyleOf(SEVERITY_STYLES, item.key).label} {item.count}
            {denominator > 0 ? ` (${Math.round((item.count / denominator) * 100)}%)` : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

function FindingCard({ finding, sectionTitle }: { finding: ReviewFindingView; sectionTitle: string | undefined }) {
  const severity = statusStyleOf(SEVERITY_STYLES, finding.severity);
  return (
    <article className={`finding-card finding-${finding.severity}`} data-testid="finding-card">
      <span className={`finding-page${finding.page === undefined ? " finding-page-empty" : ""}`} title={finding.page !== undefined ? `第 ${finding.page} 页` : "未定位到页码"}>
        {finding.page !== undefined ? `p${finding.page}` : "—"}
      </span>
      <div className="finding-body">
        <div className="finding-tags">
          <span className={`sev-badge sev-badge-${finding.severity}`}>{severity.label}</span>
          <span className="chip chip-tone-info">{FINDING_CATEGORY_LABELS[finding.category] ?? finding.category}</span>
          <span className="finding-section">{sectionTitle ?? (finding.sectionId !== undefined ? finding.sectionId : "未定位到章节")}</span>
        </div>
        <p className="finding-message">{finding.message}</p>
        {finding.claimText !== undefined ? (
          <blockquote className="finding-claim">
            <Icon name="quote" />
            <span>{finding.claimText}</span>
          </blockquote>
        ) : null}
        {finding.suggestion !== undefined ? (
          <div className="finding-suggestion">
            <span className="finding-suggestion-label">建议</span>
            <span>{finding.suggestion}</span>
          </div>
        ) : null}
      </div>
    </article>
  );
}
