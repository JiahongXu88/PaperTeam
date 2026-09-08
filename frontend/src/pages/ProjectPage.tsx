import { useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useSearchParams, useParams } from "react-router-dom";

import { ErrorState, Loading } from "../components/common/StateViews.js";
import { InlineConfirm, InlineRename, RowMenu } from "../components/common/RowMenu.js";
import { RegistryStatus } from "../components/common/StatusBadge.js";
import { COMPLETION_LABELS, EXTRACTION_QUALITY_STYLES, stageLabel, statusStyleOf } from "../components/common/status.js";
import { ProjectStatusBadge, RunStatusBadge, WorkflowKindBadge } from "../components/project/Badges.js";
import { CitationsPanel } from "../components/project/CitationsPanel.js";
import { PdfPanel } from "../components/project/PdfPanel.js";
import { ReviewPanel } from "../components/project/ReviewPanel.js";
import { optionLabel, DOCUMENT_TYPE_OPTIONS, TARGET_PROFILE_OPTIONS } from "../constants/projectMeta.js";
import {
  isRunActive,
  useArchiveProject,
  useCitations,
  useCitationIntegrity,
  usePaper,
  usePaperReviewReport,
  useProject,
  useProjectRuns,
  useRenameProject,
} from "../hooks/queries.js";
import { ApiError } from "../api/client.js";
import { formatApiError, formatApiErrorDetail } from "../utils/errors.js";
import { formatDateTime } from "../utils/format.js";
import type { ProjectView, WorkflowKind, WorkflowRunView } from "../types/api.js";

/**
 * 项目工作区：标题（可重命名）+ 类型 / 状态 → 标签页（只暴露真正可用的模块）→ 内容。
 * 已有论文类项目多一个「Review」标签。标签进入 URL（?tab=），刷新与分享可恢复；无效值回退概览。
 */

type TabId = "overview" | "pdf" | "citations" | "review";
type OpenableTab = Exclude<TabId, "overview">;

const TABS: ReadonlyArray<{ id: TabId; label: string; existingOnly?: boolean }> = [
  { id: "overview", label: "概览" },
  { id: "pdf", label: "PDF 与结构" },
  { id: "citations", label: "引用核验" },
  { id: "review", label: "Review", existingOnly: true },
];

function isExistingPaper(kind: WorkflowKind | undefined): boolean {
  return kind === "existing_paper_improvement" || kind === "existing_paper_review";
}

function visibleTabs(kind: WorkflowKind | undefined) {
  return TABS.filter((entry) => entry.existingOnly !== true || isExistingPaper(kind));
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

/** 右侧概要：下一步建议 + PDF / 引用状态（真实查询；标题可跳到对应标签页） */
function WorkspaceAside({ project, onOpenTab }: { project: ProjectView; onOpenTab: (tab: OpenableTab) => void }) {
  const paper = usePaper(project.id);
  const citations = useCitations(project.id);
  const integrity = useCitationIntegrity(project.id);
  const reviewReport = usePaperReviewReport(project.id);

  const doc = paper.data?.document;
  const summary = citations.data?.summary;
  const citationsReady = summary !== undefined && summary.extracted;
  const semanticTotal = integrity.data?.report?.semantic.total ?? 0;
  const hasReport = reviewReport.data !== null && reviewReport.data !== undefined;
  const reviewAvailable = isExistingPaper(project.workflowKind);

  const nextSteps: Array<{ label: string; tab: OpenableTab }> = [];
  if (!paper.isPending && (doc === null || doc === undefined)) {
    nextSteps.push({ label: "上传论文 PDF", tab: "pdf" });
  } else if (reviewAvailable && !reviewReport.isPending && !hasReport) {
    nextSteps.push({ label: "开始 Review（引用核验 + 分章节审阅）", tab: "review" });
  }
  if (doc !== null && doc !== undefined && !citations.isPending && !citationsReady) {
    nextSteps.push({ label: "提取并核验引用", tab: "citations" });
  }
  if (citationsReady && !integrity.isPending && semanticTotal === 0) {
    nextSteps.push({ label: "语义核验引用是否支持论断", tab: "citations" });
  }

  return (
    <aside className="workspace-aside" aria-label="项目概要">
      {nextSteps.length > 0 ? (
        <section className="aside-block">
          <h2 className="aside-title">下一步</h2>
          <div className="aside-next">
            {nextSteps.slice(0, 2).map((step) => (
              <button key={step.label} type="button" className="aside-next-item" onClick={() => onOpenTab(step.tab)}>
                {step.label}
                <span className="aside-next-arrow" aria-hidden="true">
                  ›
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="aside-block">
        <h2 className="aside-title">
          <button type="button" className="aside-title-link" onClick={() => onOpenTab("pdf")}>
            论文 PDF
          </button>
        </h2>
        <dl className="kv">
          {paper.isPending ? (
            <div className="kv-row">
              <dt>状态</dt>
              <dd className="muted">加载中…</dd>
            </div>
          ) : doc === null || doc === undefined ? (
            <div className="kv-row">
              <dt>状态</dt>
              <dd>
                <span className="status">未上传</span>
              </dd>
            </div>
          ) : (
            <>
              <div className="kv-row">
                <dt>规模</dt>
                <dd>
                  {doc.pageCount} 页，{doc.sectionCount} 节
                </dd>
              </div>
              <div className="kv-row">
                <dt>文件</dt>
                <dd className="mono" title={doc.originalFileName}>
                  {doc.originalFileName}
                </dd>
              </div>
              <div className="kv-row">
                <dt>解析质量</dt>
                <dd>
                  <RegistryStatus style={statusStyleOf(EXTRACTION_QUALITY_STYLES, doc.parse.extractionQuality)} />
                </dd>
              </div>
            </>
          )}
        </dl>
      </section>

      <section className="aside-block">
        <h2 className="aside-title">
          <button type="button" className="aside-title-link" onClick={() => onOpenTab("citations")}>
            引用核验
          </button>
        </h2>
        <dl className="kv">
          {citations.isPending ? (
            <div className="kv-row">
              <dt>状态</dt>
              <dd className="muted">加载中…</dd>
            </div>
          ) : !citationsReady ? (
            <div className="kv-row">
              <dt>状态</dt>
              <dd>
                <span className="status">未提取</span>
              </dd>
            </div>
          ) : (
            <>
              <div className="kv-row">
                <dt>参考文献</dt>
                <dd>{summary.references} 条</dd>
              </div>
              <div className="kv-row">
                <dt>正文引用</dt>
                <dd>{summary.callouts} 处</dd>
              </div>
              {summary.unresolvedRelations > 0 ? (
                <div className="kv-row">
                  <dt>待关联</dt>
                  <dd>{summary.unresolvedRelations}</dd>
                </div>
              ) : null}
            </>
          )}
        </dl>
      </section>
    </aside>
  );
}

function OverviewTab({ project, onOpenTab }: { project: ProjectView; onOpenTab: (tab: OpenableTab) => void }) {
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
    <div className="workspace-grid">
      <div className="panel-stack">
        <section className="section-block">
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

        <section className="section-block">
          <div className="section-head">
            <h2>任务记录</h2>
          </div>
          <ProjectRunsPanel projectId={project.id} />
        </section>
      </div>

      <WorkspaceAside project={project} onOpenTab={onOpenTab} />
    </div>
  );
}

export function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data, isPending, isError, error, refetch } = useProject(projectId);
  const rename = useRenameProject(projectId);
  const archive = useArchiveProject();
  const [editingTitle, setEditingTitle] = useState(false);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [headerError, setHeaderError] = useState<string | null>(null);

  const visible = visibleTabs(data?.workflowKind);
  const tab = tabFromParam(searchParams.get("tab"), visible);
  const setTab = (next: TabId) => {
    // 标签切换用 replace：浏览器"后退"回到上一个页面，而不是逐个回退标签
    setSearchParams(next === "overview" ? {} : { tab: next }, { replace: true });
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0) {
      return;
    }
    event.preventDefault();
    const next = visible[(index + delta + visible.length) % visible.length];
    if (next !== undefined) {
      setTab(next.id);
      (event.currentTarget.parentElement?.children[(index + delta + visible.length) % visible.length] as HTMLElement | undefined)?.focus();
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
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <path d="M11.5 2.5l2 2L5 13H3v-2z" strokeLinejoin="round" />
                </svg>
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
          <span className="workspace-dates">
            创建于 {formatDateTime(project.createdAt)}，更新于 {formatDateTime(project.updatedAt)}
          </span>
          <span className="id-chip" title="项目 ID">
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

      <div role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`} className="tabpanel">
        {tab === "overview" ? (
          <OverviewTab project={project} onOpenTab={setTab} />
        ) : tab === "pdf" ? (
          <PdfPanel projectId={project.id} />
        ) : tab === "citations" ? (
          <CitationsPanel projectId={project.id} />
        ) : (
          <ReviewPanel projectId={project.id} onOpenTab={setTab} />
        )}
      </div>
    </section>
  );
}
