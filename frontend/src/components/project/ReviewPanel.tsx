import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Icon, type IconName } from "../common/Icon.js";
import { Loading } from "../common/StateViews.js";
import { RunStatusBadge } from "./Badges.js";
import { QualityGateSummaryLink } from "./QualityGatePanel.js";
import { ExternalInstructionsPanel } from "./ExternalInstructionsPanel.js";
import { RevisionPlanPanel } from "./RevisionPlanPanel.js";
import {
  CITATION_SEMANTIC_MODE_LABELS,
  CITATION_SEMANTIC_MODE_OPTIONS,
  FINDING_CATEGORY_LABELS,
  SEVERITY_ORDER,
  SEVERITY_STYLES,
  STYLE_POLICY_OPTIONS,
  stageLabel,
  statusStyleOf,
} from "../common/status.js";
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
import {
  assetPreviewOf,
  getVisualReviewReport,
  runVisualReview,
  type VisualReviewFindingView,
  type VisualReviewReportView,
  type VisualVerificationStatus,
} from "../../api/visuals.js";
import type { CitationSemanticMode, ExistingReviewReportView, ReviewFindingView, StylePolicy, WorkflowKind, WorkflowRunView } from "../../types/api.js";
import type { PaperSectionView } from "../../types/paper.js";

/**
 * 快速 Review：未上传 PDF → 引导；未开始 → 「开始 Review」；运行中 → 阶段与章节进度；
 * 完成 → 报告（进度环 + 严重度统计 + 可筛选 / 搜索 / 排序的发现列表）；失败 → 原因与重试。
 * 只读，不改论文。筛选、搜索、排序都在已加载的报告数据上完成（后端只提供整份报告）。
 *
 * run 从活跃变为终态时刷新报告 / 引用 / 项目状态（报告由后端在 review.aggregate 落盘）。
 */

const REVIEW_STAGES = ["paper.ensure", "citation.extract", "citation.metadata", "citation.claims", "review.sections", "review.aggregate"] as const;

/** off 模式不进入 citation.claims stage——进度清单与实际执行保持一致 */
function stagesForMode(mode: CitationSemanticMode | undefined): readonly string[] {
  return mode === "off" ? REVIEW_STAGES.filter((stage) => stage !== "citation.claims") : REVIEW_STAGES;
}

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

export function ReviewPanel({ projectId, workflowKind, onOpenTab }: { projectId: string; workflowKind?: WorkflowKind; onOpenTab: (tab: "pdf" | "citations" | "workflow") => void }) {
  const paper = usePaper(projectId);
  const runs = useProjectRuns(projectId);
  const report = usePaperReviewReport(projectId);
  const runtimeStatus = useRuntimeStatus();
  const startReview = useCreateWorkflowRun();
  const invalidateOutputs = useInvalidateReviewOutputs(projectId);
  // 语义核验模式（Review 高级选项）：每次进入默认关闭，不跨项目/会话沿用
  const [semanticMode, setSemanticMode] = useState<CitationSemanticMode>("off");
  // M5.4 语言润色策略：只随「开始系统性改进」发送；快速 Review 只读，不发送
  const [stylePolicy, setStylePolicy] = useState<StylePolicy>("suggest_only");

  const reviewRun = runs.data?.find((run) => run.workflowKind === "existing_paper_review");
  const active = isRunActive(reviewRun);
  // 其它工作流（如系统性改进）停在 HITL 时：本页只做提醒 + 跳转，决策统一在工作流页
  const awaitingRun = runs.data?.find(
    (run) => isRunActive(run) && run.status === "awaiting_input" && run.runId !== reviewRun?.runId,
  );
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

  // 系统性改进项目：顶部克制门禁状态（完整规则在工作流页）；快速 Review 流程不运行门禁，不显示
  const gateStrip = workflowKind === "existing_paper_improvement" ? (
    <QualityGateSummaryLink projectId={projectId} onOpenTab={() => onOpenTab("workflow")} />
  ) : null;

  if (doc === null || doc === undefined) {
    return (
      <>
        {gateStrip}
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
      </>
    );
  }

  const modelNotConfigured = runtimeStatus.data?.model.phase === "not_configured";
  const hasReport = report.data !== null && report.data !== undefined;

  const actions = !active ? (
          <div className="review-start-controls">
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
                onClick={() => startReview.mutate({ projectId, kind: "existing_paper_review", citationSemanticMode: semanticMode })}
                disabled={startReview.isPending || modelNotConfigured}
                data-testid="start-review"
              >
                <Icon name={hasReport ? "refresh" : "play"} />
                {startReview.isPending ? "启动中…" : hasReport ? "重新 Review" : "开始 Review"}
              </button>
              {workflowKind === "existing_paper_improvement" ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => startReview.mutate({ projectId, kind: "existing_paper_improvement", stylePolicy })}
                  disabled={startReview.isPending || modelNotConfigured}
                  title="系统性改进：PDF 重建为可修订稿件（文本级）→ 审稿 → 改进计划确认 → 逐节修订 → 质量门禁 → Draft / Final"
                  data-testid="start-improvement"
                >
                  <Icon name="play" />
                  开始系统性改进
                </button>
              ) : null}
            </div>
            {workflowKind === "existing_paper_improvement" ? (
              <p className="field-help">
                「开始 Review」是只读分析；「开始系统性改进」会把论文 PDF 重建为可修订稿件（文本级，
                不含原图），经审稿与确认后逐节修订，最终产出 Draft / Final。
              </p>
            ) : null}
            <details className="advanced-options review-start-advanced">
              <summary>高级选项</summary>
              <div className="review-semantic-mode-field">
                <label htmlFor="review-semantic-mode">引用语义核验</label>
                <select
                  id="review-semantic-mode"
                  value={semanticMode}
                  onChange={(event) => setSemanticMode(event.target.value as CitationSemanticMode)}
                  data-testid="semantic-mode-select"
                >
                  {CITATION_SEMANTIC_MODE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <span className="field-help">
                  {CITATION_SEMANTIC_MODE_OPTIONS.find((option) => option.value === semanticMode)?.help}
                </span>
              </div>
              {workflowKind === "existing_paper_improvement" ? (
                <div className="review-semantic-mode-field">
                  <label htmlFor="review-style-policy">语言风格建议（仅系统性改进）</label>
                  <select
                    id="review-style-policy"
                    value={stylePolicy}
                    onChange={(event) => setStylePolicy(event.target.value as StylePolicy)}
                    data-testid="style-policy-select"
                  >
                    {STYLE_POLICY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <span className="field-help">
                    {STYLE_POLICY_OPTIONS.find((option) => option.value === stylePolicy)?.help}
                    「开始 Review」（快速 Review）始终只读，不受此项影响。
                  </span>
                </div>
              ) : null}
            </details>
          </div>
        ) : null;

  return (
    <section className="review-panel" data-testid="review-panel">
      {gateStrip}
      {!hasReport && <div className="review-intro">
        <div className="review-intro-text">
          <div className="review-intro-title">
            <h2>快速 Review</h2>
            {reviewRun !== undefined ? <RunStatusBadge status={reviewRun.status} /> : null}
          </div>
          <p className="panel-sub">只读分析：引用真实性核验 → 分章节审阅 → Review 报告。不修改论文正文。引用语义核验默认关闭，可在高级选项中开启。</p>
        </div>
        {actions}
      </div>}

      {active && reviewRun !== undefined ? <RunProgress run={reviewRun} onOpenTab={onOpenTab} /> : null}

      {awaitingRun !== undefined ? (
        <div className="note note-warn" role="status" data-testid="review-awaiting">
          <span>
            <span className="note-mark">●</span> 当前任务正在等待确认
            {stageLabel(awaitingRun.awaiting?.stageId) !== undefined
              ? `（${stageLabel(awaitingRun.awaiting?.stageId)}）`
              : ""}
            ，确认后才会继续。
            <button type="button" className="btn-link" onClick={() => onOpenTab("workflow")} data-testid="goto-workflow-from-review">
              前往处理
            </button>
          </span>
        </div>
      ) : null}

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

      {workflowKind === "existing_paper_improvement" ? (
        <>
          <ExternalInstructionsPanel projectId={projectId} />
          <RevisionPlanPanel projectId={projectId} />
        </>
      ) : null}

      {hasReport && report.data !== null && report.data !== undefined ? (
        <ReportBlock actions={actions} report={report.data} sections={paper.data?.sections ?? []} onOpenTab={onOpenTab} />
      ) : !active ? (
        <p className="panel-empty">{reviewRun?.status === "completed" ? "Review 已完成，正在载入报告…" : "尚未开始 Review。"}</p>
      ) : null}

      {/* M12.2 B5：视觉检查（独立于文本 Review——确定性检查恒可运行，vision 按 capability 降级） */}
      <VisualReviewSection projectId={projectId} />
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

/** 运行中：阶段清单（已完成 / 当前 / 待执行）+ 章节进度（off 模式不含语义核验阶段） */
function RunProgress({ run, onOpenTab }: { run: WorkflowRunView; onOpenTab: (tab: "pdf" | "citations" | "workflow") => void }) {
  const stages = stagesForMode(run.citationSemanticMode);
  const currentIndex = stages.indexOf(run.currentStage ?? "");
  const progress = progressOf(run);
  const findings = run.progress?.data["findings"];
  return (
    <div className="review-progress" role="status" data-testid="review-running" aria-live="polite">
      <ProgressRing value={progress?.index ?? 0} total={progress?.total ?? 0} caption="章节完成" />
      <div>
        <ol className="stage-list">
          {stages.map((stage, index) => {
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
          后台任务不受页面影响；实时详情与取消入口在
          <button type="button" className="btn-link" onClick={() => onOpenTab("workflow")} data-testid="goto-workflow-from-review">
            工作流
          </button>
          标签页。
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
  // 本轮语义核验模式：off 轮报告不携带 semantic 统计——绝不显示「支持 0 / 证据不足 0」
  // 这类无意义计数；旧报告无该字段视为 full（历史轮语义不变）
  const semanticMode: CitationSemanticMode = report.citationSemanticMode ?? "full";
  const semanticByVerdict = (report.citationIntegrity.semantic as { byVerdict?: Record<string, number> } | undefined)
    ?.byVerdict;
  const contradicted = semanticByVerdict?.["CONTRADICTED"] ?? 0;
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
          {semanticMode === "off" ? (
            <span className="review-summary-meta" data-testid="semantic-mode-note">
              {CITATION_SEMANTIC_MODE_LABELS["off"]}
              {" · "}
              <button type="button" className="btn-link" onClick={() => onOpenTab("citations")} title="在「引用核验」中手动运行语义核验（不重跑 Review）">
                进行语义核验
              </button>
            </span>
          ) : semanticMode === "contradiction_only" ? (
            <span className={`review-summary-meta${contradicted > 0 ? " run-error" : ""}`} data-testid="semantic-mode-note">
              {CITATION_SEMANTIC_MODE_LABELS["contradiction_only"]}
              {contradicted > 0 ? ` · 明显矛盾 ${contradicted}` : " · 未发现明显矛盾"}
              {" · "}
              <button type="button" className="btn-link" onClick={() => onOpenTab("citations")}>
                查看明细
              </button>
            </span>
          ) : null}
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

// ---- M12.2 B5：视觉检查（多模态 Review）----
//
// 与文本 Review 报告（ReportBlock）完全分离的独立数据源（GET visual-reviews/latest）。
// 纪律：
// - 「确定性视觉检查」与「Vision 辅助审查」两组**绝不混排**——前者是机器可
//   复核的事实（verified_deterministic），后者是模型观察（model_observation，
//   永不冒充已核验）；
// - vision 不可用是预期状态（当前部署默认文本模型）：如实给出原因码与
//   「确定性-only 模式」标注，不渲染任何「全部通过」语义；
// - 「尚未运行」与「已运行但无发现」严格区分；
// - 预览走受控资产路由；不可预览时给出明确原因，不显示坏图。

const VISUAL_VERIFICATION_LABELS: Record<VisualVerificationStatus, string> = {
  verified_deterministic: "确定性核验",
  model_observation: "模型观察（未核验）",
  needs_author_review: "需作者复核",
};

const VISUAL_CONFIDENCE_LABELS: Record<string, string> = { high: "高", medium: "中", low: "低" };

const VISUAL_CHECK_LABELS: Record<string, string> = {
  "label-ref-resolution": "图表引用解析",
  "duplicate-label": "label 重复",
  "missing-caption": "caption 缺失",
  "unreferenced-artifact": "未引用图表",
  "table-text-numeric": "表-文数值一致性",
  "caption-reference-mismatch": "题注-描述匹配",
  "figure-caption-consistency": "图-题注一致性",
  "figure-claim-consistency": "图-正文论断一致性",
  "legend-axis-consistency": "图例/坐标轴自洽",
  "diagram-method-consistency": "流程图-方法描述一致性",
};

const VISUAL_CHECK_STATUS_LABELS: Record<string, string> = {
  passed: "通过",
  finding: "有发现",
  skipped: "未运行",
  failed: "执行失败",
};

function VisualReviewSection({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const visualQuery = useQuery({
    queryKey: ["visual-review", projectId],
    queryFn: ({ signal }) => getVisualReviewReport(projectId, signal),
  });
  const runVisual = useMutation({
    mutationFn: () => runVisualReview(projectId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["visual-review", projectId] });
    },
  });

  return (
    <section className="section-block" data-testid="visual-review-section">
      <div className="section-head">
        <h3>视觉检查</h3>
        <button
          type="button"
          className="btn"
          onClick={() => runVisual.mutate()}
          disabled={runVisual.isPending}
          data-testid="run-visual-review"
          title="确定性视觉检查（图表引用/caption/数值一致性）+ Vision 模型图表审查（按模型能力降级）"
        >
          <Icon name={visualQuery.data === null ? "play" : "refresh"} />
          {runVisual.isPending ? "运行中…" : visualQuery.data === null ? "运行视觉检查" : "重新运行"}
        </button>
      </div>

      {runVisual.isError ? (
        <p className="form-error" role="alert" data-testid="visual-run-error">
          运行失败：{formatApiError(runVisual.error)}
        </p>
      ) : null}

      {visualQuery.isPending ? (
        <p className="faint">加载视觉检查状态…</p>
      ) : visualQuery.isError ? (
        <p className="note note-info" role="status" data-testid="visual-status-error">
          <span>视觉检查状态暂不可用（{formatApiError(visualQuery.error)}）。</span>
        </p>
      ) : visualQuery.data === null ? (
        <div className="state-block state-empty" data-testid="visual-not-run">
          <strong>尚未运行视觉检查</strong>
          <span>
            确定性检查（图表引用、caption、表-文数值一致性）不依赖视觉模型，随时可运行；
            Vision 辅助审查在配置 image 输入模型后自动加入。
          </span>
        </div>
      ) : (
        <VisualReportBlock projectId={projectId} report={visualQuery.data} />
      )}
    </section>
  );
}

function VisualReportBlock({ projectId, report }: { projectId: string; report: VisualReviewReportView }) {
  const deterministic = report.findings.filter((finding) => finding.source === "deterministic-visual");
  const visionAssisted = report.findings.filter((finding) => finding.source === "vision-assisted");
  const deterministicChecks = report.checks.filter((check) => check.kind === "deterministic");
  const visionChecks = report.checks.filter((check) => check.kind === "vision");
  const capability = report.capability;

  return (
    <div data-testid="visual-review-report">
      <p className="panel-sub" data-testid="visual-report-meta">
        覆盖 {report.artifacts.total} 个图表对象（figure {report.artifacts.figures} / table {report.artifacts.tables}）·
        运行于 {formatDateTime(report.runAt)}
        {report.round !== undefined ? `（round ${report.round}）` : ""}
      </p>

      {/* capability 透明化：vision 不可用 = 预期降级态，绝不伪装成已检查 */}
      {capability.visionAvailable ? (
        <p className="note note-info" role="status" data-testid="visual-vision-available">
          <span>
            <span className="note-mark">●</span> Vision 辅助审查已运行（{capability.modelSpec ?? "未知模型"}）：
            完成 {capability.visionFiguresCompleted} 图 / 失败 {capability.visionFiguresFailed} 图
            {capability.skippedFigures.length > 0 ? ` / ${capability.skippedFigures.length} 图不可送审（资产缺失或非 PNG/JPEG）` : ""}
          </span>
        </p>
      ) : (
        <p className="note note-warn" role="status" data-testid="visual-vision-unavailable">
          <span>
            <span className="note-mark">●</span> Vision 辅助审查未运行（原因 {capability.reason ?? "not_configured"}：
            {capability.detail}）——当前为「确定性-only 模式」，以下视觉事实全部来自机器可复核的确定性检查。
          </span>
        </p>
      )}

      {/* 组 1：确定性视觉检查（与模型观察严格分离） */}
      <div className="review-list-head" data-testid="visual-deterministic-group">
        <h4>确定性视觉检查</h4>
        <span className="review-list-note">{deterministic.length > 0 ? `${deterministic.length} 条确定性发现` : "无确定性发现"}</span>
      </div>
      <details className="details-block">
        <summary>检查项执行状态（{deterministicChecks.length} 项确定性检查）</summary>
        <ul className="stage-list">
          {deterministicChecks.map((check) => (
            <li key={check.checkId} className={`stage-item stage-${check.status === "passed" ? "done" : check.status === "finding" ? "current" : "todo"}`}>
              <span className="stage-name">{VISUAL_CHECK_LABELS[check.checkId] ?? check.checkId}</span>
              <span className="stage-detail">
                {VISUAL_CHECK_STATUS_LABELS[check.status] ?? check.status}
                {check.detail !== undefined ? ` · ${check.detail}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </details>
      {deterministic.length > 0 ? (
        <div className="finding-list">
          {deterministic.map((finding) => (
            <VisualFindingCard key={finding.findingId} projectId={projectId} finding={finding} />
          ))}
        </div>
      ) : (
        <p className="note note-success" role="status">
          <span>
            <span className="note-mark">✓</span> 确定性视觉检查未发现问题。
          </span>
        </p>
      )}

      {/* 组 2：Vision 辅助审查（模型观察——永不冒充已核验） */}
      <div className="review-list-head" data-testid="visual-vision-group">
        <h4>Vision 辅助审查</h4>
        <span className="review-list-note">
          {capability.visionAvailable
            ? visionAssisted.length > 0
              ? `${visionAssisted.length} 条模型观察`
              : "无模型观察"
            : "未运行（模型不可用）"}
        </span>
      </div>
      {!capability.visionAvailable ? (
        <p className="panel-empty" data-testid="visual-vision-skipped">
          Vision 检查项（{visionChecks.map((check) => VISUAL_CHECK_LABELS[check.checkId] ?? check.checkId).join("、")}）未运行。
          配置 image 输入模型后重新运行即可加入。
        </p>
      ) : visionAssisted.length > 0 ? (
        <div className="finding-list">
          {visionAssisted.map((finding) => (
            <VisualFindingCard key={finding.findingId} projectId={projectId} finding={finding} />
          ))}
        </div>
      ) : (
        <p className="note note-success" role="status">
          <span>
            <span className="note-mark">✓</span> Vision 辅助审查未产生模型观察。
          </span>
        </p>
      )}

      {report.notes.length > 0 ? (
        <details className="details-block">
          <summary>运行说明（{report.notes.length} 条）</summary>
          <ul>
            {report.notes.map((note, index) => (
              <li key={index} className="faint">{note}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function VisualFindingCard({ projectId, finding }: { projectId: string; finding: VisualReviewFindingView }) {
  const severity = statusStyleOf(SEVERITY_STYLES, finding.severity);
  const preview = assetPreviewOf(projectId, finding);
  return (
    <article className={`finding-card finding-${finding.severity}`} data-testid="visual-finding-card">
      <span className={`finding-page${finding.page === undefined && finding.chunkId === undefined ? " finding-page-empty" : ""}`}>
        {finding.page !== undefined ? `p${finding.page}` : finding.chunkId ?? "—"}
      </span>
      <div className="finding-body">
        <div className="finding-tags">
          <span className={`sev-badge sev-badge-${finding.severity}`}>{severity.label}</span>
          <span className="chip chip-tone-info">{finding.source === "deterministic-visual" ? "确定性" : "Vision 观察"}</span>
          {finding.verificationStatus !== undefined ? (
            <span className="chip">{VISUAL_VERIFICATION_LABELS[finding.verificationStatus]}</span>
          ) : null}
          {finding.visualConfidence !== undefined ? (
            <span className="finding-section">置信度 {VISUAL_CONFIDENCE_LABELS[finding.visualConfidence] ?? finding.visualConfidence}</span>
          ) : null}
        </div>
        {finding.figureEnvRef !== undefined ? (
          <p className="finding-section mono" title="图表锚（VisualArtifactView id）">
            {finding.figureEnvRef}
          </p>
        ) : null}
        <p className="finding-message">{finding.message}</p>
        {finding.claimText !== undefined ? (
          <blockquote className="finding-claim">
            <Icon name="quote" />
            <span>{finding.claimText}</span>
          </blockquote>
        ) : null}
        {preview.kind === "image" ? (
          <figure className="visual-preview" data-testid="visual-asset-preview">
            <img src={preview.url} alt={`图表资产预览（${finding.figureEnvRef ?? finding.findingId}）`} loading="lazy" style={{ maxWidth: "100%", maxHeight: "240px", borderRadius: "var(--radius, 6px)", border: "1px solid var(--border, #ddd)" }} />
          </figure>
        ) : preview.kind === "pdf" ? (
          <p className="visual-preview" data-testid="visual-asset-preview">
            <a className="btn-link" href={preview.url} target="_blank" rel="noreferrer">
              打开图表 PDF 预览
            </a>
          </p>
        ) : (
          <p className="faint" data-testid="visual-asset-unavailable">
            预览不可用：{preview.reason}
          </p>
        )}
      </div>
    </article>
  );
}
