import { useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useSearchParams, useParams } from "react-router-dom";

import { ErrorState, Loading } from "../components/common/StateViews.js";
import { Icon } from "../components/common/Icon.js";
import { InlineConfirm, InlineRename, RowMenu } from "../components/common/RowMenu.js";
import { COMPLETION_LABELS, stageLabel } from "../components/common/status.js";
import { ProjectStatusBadge, RunStatusBadge, WorkflowKindBadge } from "../components/project/Badges.js";
import { CitationsPanel } from "../components/project/CitationsPanel.js";
import { EvidencePanel } from "../components/project/EvidencePanel.js";
import { PaperPanel } from "../components/project/PaperPanel.js";
import { PdfPanel } from "../components/project/PdfPanel.js";
import { ProjectAside, isExistingPaper } from "../components/project/ProjectAside.js";
import { QualityGateSummaryLink } from "../components/project/QualityGatePanel.js";
import { ReviewPanel } from "../components/project/ReviewPanel.js";
import { WorkflowPanel } from "../components/project/WorkflowPanel.js";
import { readSectionProgress } from "../components/project/workflowTimeline.js";
import { optionLabel, DOCUMENT_TYPE_OPTIONS, TARGET_PROFILE_OPTIONS } from "../constants/projectMeta.js";
import { isRunActive, useArchiveProject, useProject, useProjectRuns, useRenameProject } from "../hooks/queries.js";
import { useWorkflowEvents } from "../hooks/workflowEvents.js";
import { ApiError } from "../api/client.js";
import { formatApiError, formatApiErrorDetail } from "../utils/errors.js";
import { formatDateTime, formatDurationBetween } from "../utils/format.js";
import type { ProjectView, WorkflowKind, WorkflowRunView } from "../types/api.js";

/**
 * 项目工作区：标题（可重命名）+ 类型 / 状态 / 时间 / ID → 标签页（只暴露真正可用的模块）
 * → 主内容 + 右侧栏（论文信息、下一步、快捷操作、引用概况）。
 * 已有论文类项目多一个「Review」标签；「工作流」对所有项目开放（任务实时视图）。
 * 标签进入 URL（?tab=），刷新与分享可恢复；无效值回退概览。
 */

type TabId = "overview" | "paper" | "pdf" | "evidence" | "citations" | "review" | "workflow";
type OpenableTab = Exclude<TabId, "overview">;

const TABS: ReadonlyArray<{ id: TabId; label: string; existingOnly?: boolean; notReviewOnly?: boolean }> = [
  { id: "overview", label: "概览" },
  { id: "paper", label: "论文产出", notReviewOnly: true },
  { id: "pdf", label: "PDF 与结构" },
  { id: "evidence", label: "证据" },
  { id: "citations", label: "引用核验" },
  { id: "review", label: "Review", existingOnly: true },
  { id: "workflow", label: "工作流" },
];

function visibleTabs(kind: WorkflowKind | undefined) {
  return TABS.filter(
    (entry) =>
      (entry.existingOnly !== true || isExistingPaper(kind)) &&
      // 论文产出只对写稿 / 系统性改进开放：快速 Review 只读，不产出 Draft / Final
      (entry.notReviewOnly !== true || kind !== "existing_paper_review"),
  );
}

function tabFromParam(param: string | null, visible: ReadonlyArray<{ id: TabId }>): TabId {
  return visible.find((entry) => entry.id === param)?.id ?? "overview";
}

/** 分章节审阅进度（stage.progress 快照：completed（并发版）/ index（旧串行版） + total） */
function runProgressText(run: WorkflowRunView): string | undefined {
  const progress = run.progress;
  if (progress === null || progress === undefined) {
    return undefined;
  }
  const index = progress.data["completed"] ?? progress.data["index"];
  const total = progress.data["total"];
  if (typeof index === "number" && typeof total === "number" && total > 0) {
    return `已完成 ${index} / ${total} 节`;
  }
  return undefined;
}

function ProjectRunsPanel({ projectId }: { projectId: string }) {
  const { data, isPending, isError, error, refetch } = useProjectRuns(projectId);

  if (isPending) {
    return <Loading label="加载任务记录…" />;
  }
  if (isError) {
    return <ErrorState title="任务记录加载失败" message={formatApiError(error)} detail={formatApiErrorDetail(error)} onRetry={() => void refetch()} />;
  }
  if (data === undefined || data.length === 0) {
    return <p className="panel-empty">还没有运行过任务。</p>;
  }
  return (
    <div className="gutter-list" data-testid="run-list">
      {data.map((run, index) => {
        const progress = runProgressText(run);
        return (
          <div key={run.runId} className="gutter-row">
            <span className="gutter-num" title={run.runId}>
              {data.length - index}
            </span>
            <div className="gutter-body">
              <span className="run-title">
                {run.workflowKind === "existing_paper_review" ? "快速 Review" : run.workflowKind === "existing_paper_improvement" ? "系统性改进" : "从想法到论文"}
                {run.completion !== null && run.completion !== undefined ? (
                  <span className="muted">，产出 {COMPLETION_LABELS[run.completion.label] ?? run.completion.label}</span>
                ) : null}
              </span>
              <span className="run-meta">
                {isRunActive(run) && run.currentStage !== undefined ? (
                  <>
                    {stageLabel(run.currentStage)}
                    {progress !== undefined ? `，${progress}` : ""}
                  </>
                ) : run.status === "failed" && run.error ? (
                  <span className="run-error">{run.error.message}</span>
                ) : (
                  <span className="muted">{formatDateTime(run.updatedAt) ?? "—"}</span>
                )}
              </span>
            </div>
            <div className="gutter-side">
              <RunStatusBadge status={run.status} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 概览的当前任务摘要：只显示状态 / 阶段 / 进度 + 入口，完整时间线在「工作流」标签 */
function CurrentWorkflowCard({ projectId, onOpenTab }: { projectId: string; onOpenTab: (tab: OpenableTab) => void }) {  const { data } = useProjectRuns(projectId);
  const active = data?.find(isRunActive);
  if (active === undefined) {
    return null;
  }
  const sectionProgress =
    active.progress?.stageId === "review.sections" ? readSectionProgress(active.progress.data) : undefined;
  const elapsed = formatDurationBetween(active.startedAt, undefined);
  return (
    <section className="panel section-block workflow-summary-card" data-testid="current-workflow">
      <div className="section-head">
        <h2>当前任务</h2>
        <RunStatusBadge status={active.status} />
      </div>
      <p className="workflow-summary-line">
        {active.status === "awaiting_input"
          ? `任务正在等待你的确认${
              stageLabel(active.awaiting?.stageId ?? active.currentStage) !== undefined
                ? `：${stageLabel(active.awaiting?.stageId ?? active.currentStage)}`
                : ""
            }`
          : active.currentStage !== undefined
            ? `正在执行：${stageLabel(active.currentStage) ?? active.currentStage}`
            : "任务排队中"}
        {sectionProgress !== undefined ? `（${sectionProgress.completed} / ${sectionProgress.total} 节）` : ""}
        {active.status === "running" && elapsed !== undefined ? `，已运行 ${elapsed}` : ""}
      </p>
      <button
        type="button"
        className={active.status === "awaiting_input" ? "btn btn-primary" : "btn"}
        onClick={() => onOpenTab("workflow")}
        data-testid="goto-workflow"
      >
        {active.status === "awaiting_input" ? "前往处理" : "查看工作流"}
        <Icon name="chevron-right" />
      </button>    </section>
  );
}

function OverviewTab({ project, onOpenTab, onOpenGate }: { project: ProjectView; onOpenTab: (tab: OpenableTab) => void; onOpenGate: () => void }) {
  const meta: Array<[string, string]> = [];
  if (project.researchField) {
    meta.push(["研究领域", project.researchField]);
  }
  const documentType = optionLabel(DOCUMENT_TYPE_OPTIONS, project.documentType);
  if (documentType !== undefined) {
    meta.push(["论文类型", documentType]);
  }
  const targetProfile = optionLabel(TARGET_PROFILE_OPTIONS, project.targetProfile);
  if (targetProfile !== undefined) {
    meta.push(["目标定位", targetProfile]);
  }
  if (project.targetVenue) {
    meta.push(["目标期刊 / 会议", project.targetVenue]);
  }
  if (project.language) {
    meta.push(["写作语言", project.language]);
  }

  return (
    <div className="panel-stack">
      <CurrentWorkflowCard projectId={project.id} onOpenTab={onOpenTab} />
      {project.workflowKind !== "existing_paper_review" ? (
        <QualityGateSummaryLink projectId={project.id} onOpenTab={() => onOpenGate()} />
      ) : null}
      <section className="panel section-block">
        <div className="section-head">
          <h2>研究定位</h2>
        </div>
        {meta.length > 0 ? (
          <dl className="meta-list meta-list-2col">
            {meta.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="panel-empty">尚未填写研究定位字段。</p>
        )}
        {project.researchIdea ? (
          <div className="idea-block">
            <h3>研究想法</h3>
            <p className="prewrap reading">{project.researchIdea}</p>
          </div>
        ) : null}
        {project.workflowKind === "existing_paper_improvement" ? (
          <p className="note note-info" style={{ marginTop: "var(--s-4)" }}>
            <span>系统性改进：第一阶段先完成「Review」建立基线（引用核验 + 分章节审阅），后续改进流程基于 Review 发现进行，不会直接重写论文。</span>
          </p>
        ) : null}
        {project.workflowKind === "existing_paper_review" ? (
          <p className="note note-info" style={{ marginTop: "var(--s-4)" }}>
            <span>快速 Review：只读分析现有论文，不修改正文。结论与报告在「Review」标签页查看。</span>
          </p>
        ) : null}
      </section>

      <section className="panel section-block">
        <div className="section-head">
          <h2>任务记录</h2>
        </div>
        <ProjectRunsPanel projectId={project.id} />
      </section>
    </div>
  );
}

export function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data, isPending, isError, error, refetch } = useProject(projectId);
  const runs = useProjectRuns(projectId);
  const rename = useRenameProject(projectId);
  const archive = useArchiveProject();
  const [editingTitle, setEditingTitle] = useState(false);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [headerError, setHeaderError] = useState<string | null>(null);

  // 页面级 SSE 订阅：存在活跃 run 时建立实时通道（驱动全部标签页的 run 缓存更新；
  // 断线自动重连 + replay，活跃时的 3s 轮询作为兜底）
  const activeRun = runs.data?.find(isRunActive);
  const connection = useWorkflowEvents({
    runId: activeRun?.runId,
    projectId,
    enabled: activeRun !== undefined,
  });

  const visible = visibleTabs(data?.workflowKind);
  const tab = tabFromParam(searchParams.get("tab"), visible);
  // 标签切换用 replace：浏览器"后退"回到上一个页面，而不是逐个回退标签；
  // extra 携带跨页上下文（如门禁 blocker → 证据页的「需注意」筛选）
  const setTab = (next: TabId, extra?: Record<string, string>) => {
    const params = { tab: next, ...extra };
    setSearchParams(next === "overview" && extra === undefined ? {} : params, { replace: true });
  };
  const openTab = (next: TabId, extra?: Record<string, string>) => {
    if (visible.some((entry) => entry.id === next)) {
      setTab(next, extra);
    }
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0) {
      return;
    }
    event.preventDefault();
    const nextIndex = (index + delta + visible.length) % visible.length;
    const next = visible[nextIndex];
    if (next !== undefined) {
      setTab(next.id);
      (event.currentTarget.parentElement?.children[nextIndex] as HTMLElement | undefined)?.focus();
    }
  };

  if (isPending) {
    return (
      <section className="page">
        <Loading label="加载项目…" />
      </section>
    );
  }

  if (isError || data === undefined) {
    const notFound = error instanceof ApiError && error.isNotFound;
    return (
      <section className="page">
        <ErrorState
          title={notFound ? "项目不存在" : "项目加载失败"}
          message={notFound ? `找不到项目 ${projectId ?? ""}：可能已被删除，或链接有误。` : formatApiError(error)}
          detail={notFound ? undefined : formatApiErrorDetail(error)}
          onRetry={notFound ? undefined : () => void refetch()}
        >
          <Link to="/projects" className="btn btn-small">
            返回论文项目
          </Link>
        </ErrorState>
      </section>
    );
  }

  const project = data;

  return (
    <section className="page">
      <header className="workspace-head">
        <div className="workspace-title-row">
          {editingTitle ? (
            <InlineRename
              initial={project.title}
              testId="workspace-rename"
              onCancel={() => setEditingTitle(false)}
              onCommit={(title) => {
                setEditingTitle(false);
                setHeaderError(null);
                rename.mutate(title, { onError: (renameError) => setHeaderError(formatApiError(renameError)) });
              }}
            />
          ) : (
            <h1 className="workspace-title">{project.title}</h1>
          )}
          {!editingTitle ? (
            <div className="workspace-title-actions">
              <button
                type="button"
                className="icon-btn"
                aria-label="编辑标题"
                title="编辑标题（PDF 识别的标题可能有误）"
                data-testid="rename-project"
                onClick={() => setEditingTitle(true)}
              >
                <Icon name="edit" />
              </button>
              <RowMenu
                label="项目的更多操作"
                testId="workspace-menu"
                items={[
                  { id: "rename", label: "重命名", onSelect: () => setEditingTitle(true) },
                  { id: "archive", label: "归档项目", onSelect: () => setConfirmingArchive(true) },
                ]}
              />
            </div>
          ) : null}
        </div>
        <div className="workspace-meta">
          <WorkflowKindBadge kind={project.workflowKind} />
          <ProjectStatusBadge status={project.status} />
          <span className="workspace-meta-sep" aria-hidden="true" />
          <span className="workspace-dates">创建于 {formatDateTime(project.createdAt)}</span>
          <span className="workspace-meta-sep" aria-hidden="true" />
          <span className="workspace-dates">更新于 {formatDateTime(project.updatedAt)}</span>
          <span className="workspace-meta-sep" aria-hidden="true" />
          <span className="id-chip" title="项目 ID">
            <Icon name="hash" />
            {project.id}
          </span>
        </div>
        {confirmingArchive ? (
          <div className="workspace-inline-confirm">
            <InlineConfirm
              message="归档后项目不再出现在列表中，可在「设置 → 项目管理」恢复。"
              confirmLabel="归档"
              pending={archive.isPending}
              onCancel={() => setConfirmingArchive(false)}
              onConfirm={() => {
                setHeaderError(null);
                archive.mutate(project.id, {
                  onSuccess: () => void navigate("/projects"),
                  onError: (archiveError) => {
                    setConfirmingArchive(false);
                    setHeaderError(formatApiError(archiveError));
                  },
                });
              }}
            />
          </div>
        ) : null}
        {project.archivedAt !== undefined ? (
          <p className="note note-warn" role="status">
            <span>
              该项目已于 {formatDateTime(project.archivedAt)} 归档，不出现在论文项目列表；可在
              <Link to="/settings/projects">「设置 → 项目管理」</Link>恢复或永久删除。
            </span>
          </p>
        ) : null}
        {headerError !== null ? (
          <p className="form-error" role="alert">
            {headerError}
          </p>
        ) : null}
      </header>

      <nav className="tabs" role="tablist" aria-label="项目工作区">
        {visible.map((entry, index) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`tab-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={`tabpanel-${entry.id}`}
            tabIndex={tab === entry.id ? 0 : -1}
            className={`tab${tab === entry.id ? " active" : ""}`}
            onClick={() => setTab(entry.id)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <div className="workspace-body">
        <div role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`} className="tabpanel">
          {tab === "overview" ? (
            <OverviewTab project={project} onOpenTab={openTab} onOpenGate={() => setTab("workflow")} />
          ) : tab === "paper" ? (
            <PaperPanel projectId={project.id} />
          ) : tab === "pdf" ? (
            <PdfPanel projectId={project.id} />
          ) : tab === "evidence" ? (
            <EvidencePanel
              projectId={project.id}
              workflowKind={project.workflowKind}
              onOpenTab={openTab}
              initialAttention={searchParams.get("attention") === "1"}
            />
          ) : tab === "citations" ? (
            <CitationsPanel projectId={project.id} />
          ) : tab === "workflow" ? (
            <WorkflowPanel projectId={project.id} project={project} onOpenTab={openTab} connection={connection} />
          ) : (
            <ReviewPanel projectId={project.id} workflowKind={project.workflowKind} onOpenTab={openTab} />
          )}
        </div>
        <ProjectAside project={project} onOpenTab={openTab} />
      </div>
    </section>
  );
}
