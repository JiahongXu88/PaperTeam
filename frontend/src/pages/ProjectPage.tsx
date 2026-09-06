import { useState } from "react";
import { Link, useNavigate, useSearchParams, useParams } from "react-router-dom";

import { ErrorState, Loading } from "../components/common/StateViews.js";
import { InlineRename, RowMenu } from "../components/common/RowMenu.js";
import { ProjectStatusBadge, RunStatusBadge, WorkflowKindBadge } from "../components/project/Badges.js";
import { CitationsPanel } from "../components/project/CitationsPanel.js";
import { PdfPanel } from "../components/project/PdfPanel.js";
import { ReviewPanel } from "../components/project/ReviewPanel.js";
import { optionLabel, DOCUMENT_TYPE_OPTIONS, TARGET_PROFILE_OPTIONS } from "../constants/projectMeta.js";
import {
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
import { formatApiError } from "../utils/errors.js";
import { formatDateTime } from "../utils/format.js";
import type { PaperDocSummary } from "../types/paper.js";
import type { WorkflowKind } from "../types/api.js";

/**
 * Project Workspace（Project Entry & Lifecycle UX 2026-09）。
 *
 * 结构：衬线标题（可重命名）+ 状态 → 项目级导航（只暴露真正可用的模块）→
 * 内容。已有论文类项目提供「Review」Tab（PDF 快速 Review）。
 * Tab 进入 URL（?tab=），刷新 / 分享链接可恢复；无效值回退概览。
 */

type TabId = "overview" | "pdf" | "citations" | "workflow" | "evidence" | "review" | "artifacts";

interface TabEntry {
  id: TabId;
  label: string;
  milestone?: string;
}

/** 全量 Tab 定义（含未开放模块；未开放项暂不在一级导航渲染，里程碑完成后恢复） */
const TABS: ReadonlyArray<TabEntry> = [
  { id: "overview", label: "概览" },
  { id: "pdf", label: "PDF 与结构" },
  { id: "citations", label: "引用核验" },
  { id: "review", label: "Review", milestone: "existing-only" },
  { id: "workflow", label: "工作流", milestone: "M4.4" },
  { id: "evidence", label: "证据", milestone: "M4.5" },
  { id: "artifacts", label: "草稿 / 最终 PDF", milestone: "M4.7" },
];

/** 已有论文类项目（导入 PDF）开放 Review Tab；idea 项目仍是后续里程碑 */
function visibleTabs(workflowKind: WorkflowKind | undefined): ReadonlyArray<TabEntry> {
  const isExisting =
    workflowKind === "existing_paper_improvement" || workflowKind === "existing_paper_review";
  return TABS.filter(
    (entry) => entry.milestone === undefined || (entry.milestone === "existing-only" && isExisting),
  );
}

const COMING_DESCRIPTION: Record<string, string> = {
  workflow: "启动与跟踪工作流运行：阶段进度、等待确认、取消与恢复。",
  evidence: "研究证据库：文献检索结果、PDF 文本层分析与派生上下文。",
  artifacts: "草稿与最终交付物：LaTeX 源、编译产物与版本历史。",
};

type OpenableTab = "pdf" | "citations" | "review";

/** WorkflowRun 完成标签（completion.label）→ 中文 */
const COMPLETION_LABELS: Record<string, string> = {
  final: "最终稿",
  draft: "草稿",
  review: "审阅报告",
};

/** URL ?tab= → TabId（仅接受当前项目已开放的 Tab；其余回退概览） */
function tabFromParam(param: string | null, visible: ReadonlyArray<TabEntry>): TabId {
  const found = visible.find((entry) => entry.id === param);
  return found !== undefined ? found.id : "overview";
}

function ProjectRunsPanel({ projectId }: { projectId: string }) {
  const { data, isPending, isError, error, refetch } = useProjectRuns(projectId);

  if (isPending) {
    return <Loading label="加载工作流运行记录…" />;
  }
  if (isError) {
    return (
      <ErrorState
        title="运行记录加载失败"
        message={formatApiError(error)}
        onRetry={() => void refetch()}
      />
    );
  }
  if (data === undefined || data.length === 0) {
    return <p className="panel-empty">尚未开始工作流。运行界面即将开放。</p>;
  }
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>运行</th>
            <th>状态</th>
            <th>当前阶段</th>
            <th>完成</th>
            <th>更新时间</th>
          </tr>
        </thead>
        <tbody>
          {data.map((run) => (
            <tr key={run.runId}>
              <td className="mono">{run.runId}</td>
              <td>
                <RunStatusBadge status={run.status} />
              </td>
              <td>{run.currentStage ?? "—"}</td>
              <td>{run.completion !== undefined && run.completion !== null ? (COMPLETION_LABELS[run.completion.label] ?? run.completion.label) : "—"}</td>
              <td className="muted">{formatDateTime(run.updatedAt) ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 侧栏：文档与引用状态摘要（真实查询；标题可跳转到对应 tab） */
function WorkspaceAside({
  projectId,
  workflowKind,
  onOpenTab,
}: {
  projectId: string;
  workflowKind: WorkflowKind | undefined;
  onOpenTab: (tab: OpenableTab) => void;
}) {
  const paper = usePaper(projectId);
  const citations = useCitations(projectId);
  const integrity = useCitationIntegrity(projectId);
  const reviewReport = usePaperReviewReport(projectId);

  const doc: PaperDocSummary | null | undefined = paper.data?.document;
  const summary = citations.data?.summary;
  const citationsReady = summary !== undefined && summary.extracted;
  const semanticTotal = integrity.data?.report?.semantic.total ?? 0;
  const hasReport = reviewReport.data !== null && reviewReport.data !== undefined;
  const reviewAvailable =
    workflowKind === "existing_paper_improvement" || workflowKind === "existing_paper_review";

  // 下一步建议：由真实状态推导，最多两条
  const nextSteps: Array<{ label: string; tab: OpenableTab }> = [];
  if (!paper.isPending && (doc === null || doc === undefined)) {
    nextSteps.push({ label: "上传最终 PDF", tab: "pdf" });
  } else if (reviewAvailable && !reviewReport.isPending && !hasReport) {
    nextSteps.push({ label: "开始 Review（引用核验 + 分章节审阅）", tab: "review" });
  }
  if (!citations.isPending && !citationsReady) {
    nextSteps.push({ label: "提取并核验引用", tab: "citations" });
  }
  if (citationsReady && !integrity.isPending && semanticTotal === 0) {
    nextSteps.push({ label: "语义核验引用是否支持论断", tab: "citations" });
  }
  nextSteps.splice(2);

  return (
    <aside className="workspace-aside">
      {nextSteps.length > 0 ? (
        <div className="aside-block">
          <h2 className="aside-title">下一步</h2>
          <div className="aside-next">
            {nextSteps.map((step) => (
              <button
                key={step.label}
                type="button"
                className="aside-next-item"
                onClick={() => onOpenTab(step.tab)}
              >
                {step.label}
                <span className="aside-next-arrow" aria-hidden="true">›</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="aside-block">
        <button
          type="button"
          className="aside-title aside-title-link"
          onClick={() => onOpenTab("pdf")}
          title="打开 PDF 与结构"
        >
          最终 PDF <span className="aside-next-arrow" aria-hidden="true">›</span>
        </button>
        <dl className="aside-rows">
          {paper.isPending ? (
            <div className="aside-row">
              <dt>状态</dt>
              <dd className="muted">加载中…</dd>
            </div>
          ) : doc === null || doc === undefined ? (
            <button type="button" className="aside-row-click" onClick={() => onOpenTab("pdf")}>
              <span className="ck-label">状态</span>
              <span className="ck-value">
                <span className="status status-tone-neutral">未上传</span>
              </span>
            </button>
          ) : (
            <>
              <div className="aside-row">
                <dt>规模</dt>
                <dd>
                  <span className="aside-value">{doc.pageCount}</span> 页 ·{" "}
                  <span className="aside-value">{doc.sectionCount}</span> 节
                </dd>
              </div>
              <div className="aside-row">
                <dt>文档</dt>
                <dd className="mono" title={doc.originalFileName}>
                  {doc.originalFileName}
                </dd>
              </div>
              <div className="aside-row">
                <dt>解析质量</dt>
                <dd>
                  <span className={`status status-tone-${doc.parse.extractionQuality === "good" ? "ok" : doc.parse.extractionQuality === "partial" ? "warn" : "danger"}`}>
                    {doc.parse.extractionQuality === "good" ? "良好" : doc.parse.extractionQuality === "partial" ? "部分" : "较差"}
                  </span>
                </dd>
              </div>
            </>
          )}
        </dl>
      </div>

      <div className="aside-block">
        <button
          type="button"
          className="aside-title aside-title-link"
          onClick={() => onOpenTab("citations")}
          title="打开引用核验"
        >
          引用核验 <span className="aside-next-arrow" aria-hidden="true">›</span>
        </button>
        <dl className="aside-rows">
          {citations.isPending ? (
            <div className="aside-row">
              <dt>状态</dt>
              <dd className="muted">加载中…</dd>
            </div>
          ) : !citationsReady ? (
            <button type="button" className="aside-row-click" onClick={() => onOpenTab("citations")}>
              <span className="ck-label">状态</span>
              <span className="ck-value">
                <span className="status status-tone-neutral">未提取</span>
              </span>
            </button>
          ) : (
            <>
              <div className="aside-row">
                <dt>参考文献条目</dt>
                <dd>
                  <span className="aside-value">{summary.references}</span>
                </dd>
              </div>
              <div className="aside-row">
                <dt>正文引用</dt>
                <dd>
                  <span className="aside-value">{summary.callouts}</span>
                </dd>
              </div>
              {summary.unresolvedRelations > 0 ? (
                <div className="aside-row">
                  <dt>待关联</dt>
                  <dd>
                    <span className="aside-value">{summary.unresolvedRelations}</span>
                  </dd>
                </div>
              ) : null}
            </>
          )}
        </dl>
      </div>
    </aside>
  );
}

function ComingPanel({ entry }: { entry: TabEntry }) {
  return (
    <div className="panel-coming">
      <span className="coming-tag">{entry.milestone}</span>
      <strong>{entry.label}</strong>
      <span>{COMING_DESCRIPTION[entry.id]}</span>
      <span className="faint">即将开放，当前暂不可用。</span>
    </div>
  );
}

export function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  // Tab 状态进入 URL（?tab=overview|pdf|citations|review）：刷新 / 复制链接可恢复
  const [searchParams, setSearchParams] = useSearchParams();
  const { data, isPending, isError, error, refetch } = useProject(projectId);
  const rename = useRenameProject(projectId);
  const archive = useArchiveProject();
  const [editingTitle, setEditingTitle] = useState(false);
  const [headerError, setHeaderError] = useState<string | null>(null);

  const visible = visibleTabs(data?.workflowKind);
  const tab = tabFromParam(searchParams.get("tab"), visible);
  const setTab = (next: TabId) => {
    setSearchParams(next === "overview" ? {} : { tab: next });
  };

  if (isPending) {
    return (
      <section className="page">
        <Loading label="加载项目…" />
      </section>
    );
  }

  if (isError) {
    const notFound = error instanceof ApiError && error.isNotFound;
    return (
      <section className="page">
        <ErrorState
          title={notFound ? "项目不存在" : "项目加载失败"}
          message={
            notFound
              ? `找不到项目 ${projectId}（可能已被删除，或链接有误）。`
              : formatApiError(error)
          }
          onRetry={notFound ? undefined : () => void refetch()}
        />
        <p>
          <Link to="/projects" className="btn">
            ← 返回项目列表
          </Link>
        </p>
      </section>
    );
  }

  const project = data!;
  const meta = [
    project.researchField,
    optionLabel(DOCUMENT_TYPE_OPTIONS, project.documentType),
    optionLabel(TARGET_PROFILE_OPTIONS, project.targetProfile),
    project.targetVenue,
    project.language,
  ].filter((part): part is string => part !== undefined && part !== "");

  return (
    <section className="page">
      <div>
        <div className="workspace-title-row">
          {editingTitle ? (
            <InlineRename
              initial={project.title}
              testId="workspace-rename"
              onCancel={() => setEditingTitle(false)}
              onCommit={(title) => {
                setEditingTitle(false);
                rename.mutate(title, {
                  onError: (renameError) => setHeaderError(formatApiError(renameError)),
                });
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
                <span aria-hidden="true">✎</span>
              </button>
              <RowMenu
                label="项目的更多操作"
                testId="workspace-menu"
                items={[
                  { id: "rename", label: "重命名", onSelect: () => setEditingTitle(true) },
                  {
                    id: "archive",
                    label: "归档项目",
                    onSelect: () => {
                      setHeaderError(null);
                      archive.mutate(project.id, {
                        onSuccess: () => void navigate("/projects"),
                        onError: (archiveError) => setHeaderError(formatApiError(archiveError)),
                      });
                    },
                  },
                ]}
              />
            </div>
          ) : null}
        </div>
        <div className="workspace-badges">
          <WorkflowKindBadge kind={project.workflowKind} />
          <ProjectStatusBadge status={project.status} />
        </div>
        <div className="workspace-meta">
          <span>创建 {formatDateTime(project.createdAt)} · 更新 {formatDateTime(project.updatedAt)}</span>
          <span className="id-chip" title="项目 ID（技术标识）">
            {project.id}
          </span>
        </div>
      </div>

      {project.archivedAt !== undefined ? (
        <p className="note note-warn" role="status" style={{ marginTop: 12 }}>
          <span>
            该项目已归档（{formatDateTime(project.archivedAt)}）。归档项目不出现在论文项目列表；
            可在<Link to="/settings/projects">「设置 → 项目管理」</Link>恢复或永久删除。
          </span>
        </p>
      ) : null}
      {headerError !== null ? (
        <p className="form-error" role="alert" style={{ marginTop: 8 }}>
          {headerError}
        </p>
      ) : null}

      <nav className="tabs" role="tablist" aria-label="项目工作区">
        {visible.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={`tab ${tab === entry.id ? "active" : ""}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {tab === "overview" ? (
        <div className="workspace-grid">
          <div className="panel-stack">
            <section>
              <div className="section-head">
                <h2>研究定位</h2>
              </div>
              {meta.length > 0 ? (
                <dl className="meta-list meta-list-2col">
                  {project.researchField ? (
                    <div>
                      <dt>研究领域</dt>
                      <dd>{project.researchField}</dd>
                    </div>
                  ) : null}
                  {project.documentType ? (
                    <div>
                      <dt>论文类型</dt>
                      <dd>{optionLabel(DOCUMENT_TYPE_OPTIONS, project.documentType)}</dd>
                    </div>
                  ) : null}
                  {project.targetProfile ? (
                    <div>
                      <dt>目标定位</dt>
                      <dd>{optionLabel(TARGET_PROFILE_OPTIONS, project.targetProfile)}</dd>
                    </div>
                  ) : null}
                  {project.targetVenue ? (
                    <div>
                      <dt>目标期刊 / 会议</dt>
                      <dd>{project.targetVenue}</dd>
                    </div>
                  ) : null}
                  {project.language ? (
                    <div>
                      <dt>写作语言</dt>
                      <dd>{project.language}</dd>
                    </div>
                  ) : null}
                </dl>
              ) : (
                <p className="panel-empty">尚未填写研究定位字段（编辑界面即将提供）。</p>
              )}
              {project.researchIdea ? (
                <div className="idea-block">
                  <h3>研究想法</h3>
                  <p className="prewrap">{project.researchIdea}</p>
                </div>
              ) : null}
              {project.workflowKind === "existing_paper_improvement" ? (
                <p className="note note-info" style={{ marginTop: 16 }}>
                  <span>
                    系统性改进：第一阶段先完成「Review」建立基线（引用核验 + 分章节审阅），
                    后续改进流程将基于 Review 发现进行；不会直接重写论文。
                  </span>
                </p>
              ) : null}
              {project.workflowKind === "existing_paper_review" ? (
                <p className="note note-info" style={{ marginTop: 16 }}>
                  <span>
                    快速 Review 模式：只读分析现有论文，不修改正文。审阅结论与汇总报告在「Review」页查看。
                  </span>
                </p>
              ) : null}
            </section>

            <section>
              <div className="section-head">
                <h2>工作流运行记录</h2>
              </div>
              <ProjectRunsPanel projectId={project.id} />
            </section>
          </div>

          <WorkspaceAside projectId={project.id} workflowKind={project.workflowKind} onOpenTab={setTab} />
        </div>
      ) : tab === "pdf" ? (
        <PdfPanel projectId={project.id} />
      ) : tab === "citations" ? (
        <CitationsPanel projectId={project.id} />
      ) : tab === "review" ? (
        <ReviewPanel projectId={project.id} onOpenTab={setTab} />
      ) : (
        <ComingPanel entry={TABS.find((entry) => entry.id === tab)!} />
      )}
    </section>
  );
}
