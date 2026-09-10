import { useEffect, useMemo, useState } from "react";

import { Icon } from "../common/Icon.js";
import { Loading } from "../common/StateViews.js";
import { InlineConfirm } from "../common/RowMenu.js";
import { HitlPanel } from "./HitlPanel.js";
import { QualityGatePanel } from "./QualityGatePanel.js";
import { COMPLETION_LABELS, stageLabel } from "../common/status.js";
import { RunStatusBadge } from "./Badges.js";
import { WORKFLOW_KIND_LABELS } from "../../constants/projectMeta.js";
import { buildStageTimeline, type StageTimelineItem } from "./workflowTimeline.js";
import {
  isRunActive,
  useCancelWorkflowRun,
  useExportReviewReport,
  useProjectRuns,
} from "../../hooks/queries.js";
import type { WorkflowEventConnection } from "../../hooks/workflowEvents.js";
import { formatApiError, summarizeRunError } from "../../utils/errors.js";
import { formatDateTime, formatDurationBetween, formatStageDuration } from "../../utils/format.js";
import type { ProjectView, WorkflowRunView } from "../../types/api.js";

/**
 * 工作流实时视图：当前 run 状态 + Stage Timeline + 分章节进度 + 取消 + 结果入口。
 * 数据全部来自 run 列表（TanStack Query，SSE hook 在页面级驱动缓存更新 +
 * 活跃时 3s 轮询兜底）；耗时用客户端 timer 基于 server 时间戳计算，不轮询后端。
 */

type OpenableTab = "pdf" | "evidence" | "citations" | "review" | "overview";

/** 客户端秒级 tick（仅运行中启用；驱动 elapsed 展示，不请求后端） */
function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const STAGE_STATE_TEXT: Record<StageTimelineItem["state"], string> = {
  completed: "已完成",
  running: "进行中",
  awaiting: "等待确认",
  failed: "失败",
  cancelled: "已取消",
  pending: "未开始",
};

function runKindLabel(run: WorkflowRunView): string {
  return WORKFLOW_KIND_LABELS[run.workflowKind] ?? run.workflowKind;
}

/** Review 类 run 的失败重试建议（真实入口：Review 标签页可重新开始） */
function retryAdvice(run: WorkflowRunView): string {
  if (run.workflowKind === "existing_paper_review") {
    return "稍后在「Review」标签页重新开始即可；已完成章节的审阅记录会按指纹复用，不会重复消耗模型调用。";
  }
  return "检查模型设置与网络后重新开始任务。";
}

export function WorkflowPanel({
  projectId,
  project,
  onOpenTab,
  connection,
}: {
  projectId: string;
  /** 项目元数据（质量门禁需要 workflowKind 判定空态文案；缺省按未知类型处理） */
  project?: ProjectView;
  onOpenTab: (tab: OpenableTab, extra?: Record<string, string>) => void;
  connection: WorkflowEventConnection;
}) {
  const runs = useProjectRuns(projectId);
  const cancel = useCancelWorkflowRun(projectId);
  const exportReport = useExportReviewReport(projectId);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [headerError, setHeaderError] = useState<string | null>(null);

  const activeRun = runs.data?.find(isRunActive);
  const selected = useMemo(() => {
    const list = runs.data ?? [];
    return list.find((run) => run.runId === selectedRunId) ?? activeRun ?? list[0];
  }, [runs.data, selectedRunId, activeRun]);

  const selectedActive = isRunActive(selected);
  const now = useNowTick(selectedActive);

  useEffect(() => {
    if (!isRunActive(selected)) {
      setCancelRequested(false);
      setConfirmingCancel(false);
    }
  }, [selected]);

  const cancelling = cancel.isPending || (cancelRequested && selectedActive);

  if (runs.isPending) {
    return <Loading label="加载任务状态…" />;
  }
  if (runs.isError) {
    return (
      <div className="note note-error" role="alert">
        <span>任务状态加载失败：{formatApiError(runs.error)}</span>
      </div>
    );
  }
  if (runs.data === undefined || runs.data.length === 0) {
    return (
      <section className="workflow-panel" data-testid="workflow-panel">
        <section className="panel section-block">
          <div className="section-head">
            <h2>工作流</h2>
          </div>
          <p className="panel-empty">还没有运行过任务。</p>
        </section>
        {/* 门禁产物独立于 run 存在（如手动 review + gate）；无 run 也要可见 */}
        <QualityGatePanel projectId={projectId} workflowKind={project?.workflowKind} onOpenTab={onOpenTab} />
      </section>
    );
  }

  const onConfirmCancel = () => {
    if (selected === undefined) {
      return;
    }
    setHeaderError(null);
    cancel.mutate(selected.runId, {
      onSuccess: () => setCancelRequested(true),
      onError: (error) => {
        setConfirmingCancel(false);
        setHeaderError(formatApiError(error));
      },
    });
  };

  return (
    <section className="workflow-panel" data-testid="workflow-panel">
      {selected !== undefined ? (
        <RunDetail
          run={selected}
          now={now}
          cancelling={cancelling}
          confirmingCancel={confirmingCancel}
          onAskCancel={() => setConfirmingCancel(true)}
          onCancelConfirmClose={() => setConfirmingCancel(false)}
          onCancelConfirm={onConfirmCancel}
          cancelError={headerError}
          cancelMutationError={cancel.isError ? formatApiError(cancel.error) : null}
          connection={selectedActive ? connection : null}
          onOpenTab={onOpenTab}
          exportPending={exportReport.isPending}
          onExport={() => exportReport.mutate()}
          exportError={exportReport.isError ? formatApiError(exportReport.error) : null}
        />
      ) : null}

      {/* 质量门禁（项目级产物，按轮落盘；工作流的 quality.gate 阶段自动产出） */}
      <QualityGatePanel projectId={projectId} workflowKind={project?.workflowKind} onOpenTab={onOpenTab} />

      {runs.data.length > 1 ? (
        <section className="panel section-block">
          <div className="section-head">
            <h2>最近运行</h2>
          </div>
          <div className="gutter-list">
            {runs.data.map((run, index) => {
              const isSelected = selected?.runId === run.runId;
              return (
                <button
                  key={run.runId}
                  type="button"
                  className={`gutter-row gutter-row-button${isSelected ? " selected" : ""}`}
                  data-testid={`run-history-${index}`}
                  aria-current={isSelected ? "true" : undefined}
                  onClick={() => setSelectedRunId(run.runId)}
                >
                  <span className="gutter-num" title={run.runId}>
                    {runs.data.length - index}
                  </span>
                  <span className="gutter-body">
                    <span className="run-title">
                      第 {runs.data.length - index} 轮 · {runKindLabel(run)}
                      {run.completion !== null && run.completion !== undefined ? (
                        <span className="muted">，产出 {COMPLETION_LABELS[run.completion.label] ?? run.completion.label}</span>
                      ) : null}
                    </span>
                    <span className="run-meta">
                      {isRunActive(run)
                        ? "进行中"
                        : formatDurationBetween(run.startedAt, run.finishedAt) !== undefined
                          ? `耗时 ${formatDurationBetween(run.startedAt, run.finishedAt)}`
                          : (formatDateTime(run.updatedAt) ?? "—")}
                    </span>
                  </span>
                  <span className="gutter-side">
                    <RunStatusBadge status={run.status} />
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}
    </section>
  );
}

function RunDetail({
  run,
  now,
  cancelling,
  confirmingCancel,
  onAskCancel,
  onCancelConfirmClose,
  onCancelConfirm,
  cancelError,
  cancelMutationError,
  connection,
  onOpenTab,
  exportPending,
  onExport,
  exportError,
}: {
  run: WorkflowRunView;
  now: number;
  cancelling: boolean;
  confirmingCancel: boolean;
  onAskCancel: () => void;
  onCancelConfirmClose: () => void;
  onCancelConfirm: () => void;
  cancelError: string | null;
  cancelMutationError: string | null;
  connection: WorkflowEventConnection | null;
  onOpenTab: (tab: OpenableTab) => void;
  exportPending: boolean;
  onExport: () => void;
  exportError: string | null;
}) {
  const timeline = useMemo(() => buildStageTimeline(run), [run]);
  const active = isRunActive(run);
  const completedCount = timeline.filter((item) => item.state === "completed").length;
  const elapsed = formatDurationBetween(run.startedAt, run.finishedAt, () => now);
  const isReviewKind = run.workflowKind === "existing_paper_review";

  return (
    <>
      <section className="panel section-block workflow-head">
        <div className="workflow-head-main">
          <div className="section-head">
            <h2>当前任务</h2>
            <RunStatusBadge status={run.status} />
          </div>
          <dl className="meta-list meta-list-2col">
            <div>
              <dt>类型</dt>
              <dd>{runKindLabel(run)}</dd>
            </div>
            <div>
              <dt>{run.status === "pending" ? "创建时间" : active ? "开始时间" : "完成时间"}</dt>
              <dd>
                {run.status === "pending"
                  ? (formatDateTime(run.createdAt) ?? "—")
                  : active
                    ? ((formatDateTime(run.startedAt) ?? "—") + (elapsed !== undefined ? `（已运行 ${elapsed}）` : ""))
                    : (formatDateTime(run.finishedAt) ?? "—")}
              </dd>
            </div>
            {!active && elapsed !== undefined ? (
              <div>
                <dt>总耗时</dt>
                <dd>{elapsed}</dd>
              </div>
            ) : null}
            <div>
              <dt>阶段进度</dt>
              <dd>
                {completedCount} / {timeline.length} 个阶段
              </dd>
            </div>
          </dl>
        </div>

        <div className="workflow-head-actions">
          {active ? (
            confirmingCancel ? (
              <InlineConfirm
                message="确定取消当前任务吗？已完成的阶段与结果会保留；尚未开始的阶段不会执行，进行中的调用会被中断。"
                confirmLabel="取消任务"
                danger
                pending={cancelling}
                testId="cancel-confirm"
                onConfirm={onCancelConfirm}
                onCancel={onCancelConfirmClose}
              />
            ) : (
              <button
                type="button"
                className="btn btn-danger"
                data-testid="cancel-run"
                disabled={cancelling}
                onClick={onAskCancel}
              >
                <Icon name="minus-circle" />
                取消任务
              </button>
            )
          ) : null}
          {cancelling && active ? (
            <span className="workflow-cancelling" role="status">
              正在取消…（等待进行中的调用结束）
            </span>
          ) : null}
          {connection !== null ? (
            <span className={`workflow-live workflow-live-${connection}`} data-testid="workflow-connection">
              {connection === "open" ? "实时同步中" : connection === "connecting" ? "连接中，自动重试…" : "未连接"}
            </span>
          ) : null}
        </div>
      </section>

      {cancelError !== null ? (
        <p className="form-error" role="alert">
          {cancelError}
        </p>
      ) : null}
      {cancelMutationError !== null ? (
        <p className="form-error" role="alert">
          取消失败：{cancelMutationError}
        </p>
      ) : null}

      {run.status === "awaiting_input" ? <HitlPanel run={run} /> : null}
      {run.status === "failed" ? <FailedBlock run={run} /> : null}
      {run.status === "cancelled" ? (
        <p className="note note-info" role="status" data-testid="workflow-cancelled">
          <span>任务已取消。已完成阶段的结果已保留{isReviewKind ? "，可随时在「Review」标签页重新开始" : ""}。</span>
        </p>
      ) : null}
      {run.status === "completed" ? (
        <CompletedBlock run={run} timeline={timeline} isReviewKind={isReviewKind} onOpenTab={onOpenTab} exportPending={exportPending} onExport={onExport} exportError={exportError} />
      ) : null}

      <section className="panel section-block">
        <div className="section-head">
          <h2>阶段时间线</h2>
        </div>
        <ol className="stage-list stage-list-workflow" data-testid="stage-timeline">
          {timeline.map((item) => (
            <TimelineRow key={item.stageId} item={item} now={now} />
          ))}
        </ol>
      </section>

      <RunDetails run={run} timeline={timeline} />
    </>
  );
}

function TimelineRow({ item, now }: { item: StageTimelineItem; now: number }) {
  const duration =
    item.state === "completed" || item.state === "failed"
      ? formatStageDuration(item.startedAt, item.finishedAt)
      : item.state === "running" || item.state === "awaiting" || item.state === "cancelled"
        ? formatStageDuration(item.startedAt, undefined, () => now)
        : undefined;
  const progress = item.sectionProgress;
  return (
    <li className={`stage-item stage-${timelineClass(item.state)}`} data-stage={item.stageId} data-stage-state={item.state}>
      <span className="stage-mark" aria-hidden="true" />
      <span className="stage-name">
        {stageLabel(item.stageId) ?? item.stageId}
        <span className="stage-state-text">{STAGE_STATE_TEXT[item.state]}</span>
      </span>
      <span className="stage-detail">
        {item.state === "running" && progress !== undefined ? (
          <span className="stage-section-progress">
            {progress.completed} / {progress.total} 节
          </span>
        ) : null}
        {item.state === "awaiting" ? "等待你的确认" : null}
        {item.state === "failed" && item.error !== undefined && item.error !== null ? (
          <span className="run-error">{summarizeRunError(item.error.message).summary}</span>
        ) : null}
        {item.state === "cancelled" ? "中断于此" : null}
        {item.state === "pending" && item.conditional ? "按需执行" : null}
        {duration !== undefined && item.state !== "pending" ? <span className="muted">{duration}</span> : null}
        {item.stageId === "quality.gate" && item.state === "completed" ? (
          <button
            type="button"
            className="btn-link stage-goto-gate"
            onClick={() => document.getElementById("quality-gate-panel")?.scrollIntoView({ behavior: "smooth", block: "start" })}
            data-testid="stage-goto-gate"
          >
            查看门禁详情
          </button>
        ) : null}
      </span>
      {item.state === "running" && item.stageId === "review.sections" ? <SectionProgressBlock item={item} now={now} /> : null}
    </li>
  );
}

function timelineClass(state: StageTimelineItem["state"]): string {
  // 复用现有 stage-* 样式：done / current；新增 failed / awaiting / cancelled 变体
  switch (state) {
    case "completed":
      return "done";
    case "running":
      return "current";
    default:
      return state;
  }
}

/** 分章节进度块：17 / 33 + 运行中 / 等待 / 重试 / 失败（确定性计数，非虚假百分比） */
function SectionProgressBlock({ item, now }: { item: StageTimelineItem; now: number }) {
  const progress = item.sectionProgress;
  if (progress === undefined) {
    return null;
  }
  const ratio = progress.total > 0 ? Math.min(1, progress.completed / progress.total) : 0;
  const stageElapsed = formatDurationBetween(item.startedAt, undefined, () => now);
  const metrics: string[] = [];
  if (progress.active !== undefined) {
    metrics.push(`运行中 ${progress.active}`);
  }
  if (progress.queued !== undefined) {
    metrics.push(`等待 ${progress.queued}`);
  }
  if (progress.retried !== undefined && progress.retried > 0) {
    metrics.push(`已重试 ${progress.retried}`);
  }
  if (progress.failed !== undefined) {
    metrics.push(`失败 ${progress.failed}`);
  }
  return (
    <div className="wf-progress" data-testid="section-progress">
      <div className="wf-progress-main">
        <span className="wf-progress-count">
          {progress.completed}
          <small> / {progress.total}</small>
        </span>
        <span className="wf-progress-label">节已完成</span>
        <div className="wf-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.completed} aria-label="分章节审阅进度">
          <span style={{ width: `${ratio * 100}%` }} />
        </div>
      </div>
      <div className="wf-progress-metrics">
        {metrics.map((metric) => (
          <span key={metric}>{metric}</span>
        ))}
        {progress.findings !== undefined ? <span>已记录发现 {progress.findings}</span> : null}
        {stageElapsed !== undefined ? <span className="muted">elapsed {stageElapsed}</span> : null}
      </div>
    </div>
  );
}

function FailedBlock({ run }: { run: WorkflowRunView }) {
  const { summary, detail } = summarizeRunError(run.error?.message ?? "未知原因");
  return (
    <div className="note note-error" role="alert" data-testid="workflow-failed">
      <span>
        <span className="note-mark">✗</span> 任务失败：{summary}
        {run.error?.stageId !== undefined ? (
          <span className="muted">（阶段：{stageLabel(run.error.stageId) ?? run.error.stageId}）</span>
        ) : null}
        <span className="workflow-retry-advice">{retryAdvice(run)}</span>
        {detail !== undefined ? (
          <details className="details-block">
            <summary>查看详细信息</summary>
            <div className="details-body mono">{detail}</div>
          </details>
        ) : null}
      </span>
    </div>
  );
}

function CompletedBlock({
  run,
  timeline,
  isReviewKind,
  onOpenTab,
  exportPending,
  onExport,
  exportError,
}: {
  run: WorkflowRunView;
  timeline: StageTimelineItem[];
  isReviewKind: boolean;
  onOpenTab: (tab: OpenableTab) => void;
  exportPending: boolean;
  onExport: () => void;
  exportError: string | null;
}) {
  const completedCount = timeline.filter((item) => item.state === "completed").length;
  const sections = run.stageHistory?.find((record) => record.stageId === "review.sections" && record.status === "completed");
  const duration = formatDurationBetween(run.startedAt, run.finishedAt);
  return (
    <div className="note note-success" role="status" data-testid="workflow-completed">
      <span>
        <span className="note-mark">✓</span> 任务已完成
        {run.completion !== null && run.completion !== undefined ? (
          <span className="muted">（产出：{COMPLETION_LABELS[run.completion.label] ?? run.completion.label}）</span>
        ) : null}
        ：{completedCount} / {timeline.length} 个阶段
        {duration !== undefined ? `，总耗时 ${duration}` : ""}
        {sections?.summaryNumbers !== undefined ? (
          <>
            ，已审阅 {sections.summaryNumbers["sectionsReviewed"] ?? "—"} / {sections.summaryNumbers["sectionsTotal"] ?? "—"} 节
          </>
        ) : null}
        。
      </span>
      {isReviewKind ? (
        <span className="workflow-result-actions">
          <button type="button" className="btn btn-small btn-primary" onClick={() => onOpenTab("review")} data-testid="goto-review">
            查看 Review
          </button>
          <button type="button" className="btn btn-small" onClick={() => onOpenTab("citations")}>
            查看引用核验
          </button>
          <button type="button" className="btn btn-small" onClick={onExport} disabled={exportPending}>
            <Icon name="download" />
            {exportPending ? "导出中…" : "导出报告"}
          </button>
        </span>
      ) : null}
      {exportError !== null ? (
        <p className="form-error" role="alert">
          导出失败：{exportError}
        </p>
      ) : null}
    </div>
  );
}

/** 弱化的开发者字段：runId / 时间戳 / 每阶段尝试与耗时 / 并发画像 */
function RunDetails({ run, timeline }: { run: WorkflowRunView; timeline: StageTimelineItem[] }) {
  const reviewRecord = run.stageHistory?.find((record) => record.stageId === "review.sections" && record.status === "completed");
  return (
    <details className="details-block workflow-details" data-testid="workflow-details">
      <summary>详细信息</summary>
      <div className="details-body">
        <dl className="kv">
          <div className="kv-row">
            <dt>Run ID</dt>
            <dd className="mono">{run.runId}</dd>
          </div>
          <div className="kv-row">
            <dt>创建 / 开始 / 结束</dt>
            <dd>
              {formatDateTime(run.createdAt) ?? "—"} / {formatDateTime(run.startedAt) ?? "—"} / {formatDateTime(run.finishedAt) ?? "—"}
            </dd>
          </div>
          {reviewRecord?.concurrency !== undefined ? (
            <div className="kv-row">
              <dt>审阅并发</dt>
              <dd>
                配置 {reviewRecord.concurrency.configured} · 峰值 {reviewRecord.concurrency.maxObserved}
              </dd>
            </div>
          ) : null}
        </dl>
        <table className="workflow-stage-table">
          <caption className="visually-hidden">各阶段执行记录</caption>
          <thead>
            <tr>
              <th scope="col">阶段</th>
              <th scope="col">状态</th>
              <th scope="col">尝试</th>
              <th scope="col">耗时</th>
            </tr>
          </thead>
          <tbody>
            {timeline.map((item) => (
              <tr key={item.stageId}>
                <td>{stageLabel(item.stageId) ?? item.stageId}</td>
                <td>{STAGE_STATE_TEXT[item.state]}</td>
                <td>{item.attempts ?? (item.state === "completed" ? 1 : "—")}</td>
                <td>
                  {item.state === "completed" || item.state === "failed"
                    ? (formatStageDuration(item.startedAt, item.finishedAt) ?? "—")
                    : item.state === "pending"
                      ? "—"
                      : (formatStageDuration(item.startedAt, undefined) ?? "—")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
