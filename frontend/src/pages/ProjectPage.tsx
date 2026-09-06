import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { ErrorState, Loading } from "../components/common/StateViews.js";
import { ProjectStatusBadge, RunStatusBadge, WorkflowKindBadge } from "../components/project/Badges.js";
import { CitationsPanel } from "../components/project/CitationsPanel.js";
import { PdfPanel } from "../components/project/PdfPanel.js";
import { optionLabel, DOCUMENT_TYPE_OPTIONS, TARGET_PROFILE_OPTIONS } from "../constants/projectMeta.js";
import { useCitations, useCitationIntegrity, usePaper, useProject, useProjectRuns } from "../hooks/queries.js";
import { ApiError } from "../api/client.js";
import { formatDateTime } from "../utils/format.js";
import type { PaperDocSummary } from "../types/paper.js";

/**
 * Project Workspace（Visual Redesign 2026-09）。
 *
 * 结构：面包屑（Projects / 项目名）→ 衬线标题 + 状态 → 项目级导航 →
 * 内容。Overview 左主右辅：研究定位与想法在主列，文档 / 引用 / 运行
 * 摘要在侧栏；未开放模块用明确的「规划中」占位，不伪装成故障页。
 */

type TabId = "overview" | "pdf" | "citations" | "workflow" | "evidence" | "review" | "artifacts";

interface TabEntry {
  id: TabId;
  label: string;
  milestone?: string;
}

const TABS: ReadonlyArray<TabEntry> = [
  { id: "overview", label: "Overview" },
  { id: "pdf", label: "PDF / Structure" },
  { id: "citations", label: "Citations" },
  { id: "workflow", label: "Workflow", milestone: "M4.4" },
  { id: "evidence", label: "Evidence", milestone: "M4.5" },
  { id: "review", label: "Review / Quality Gate", milestone: "M4.6" },
  { id: "artifacts", label: "Draft / Final PDF", milestone: "M4.7" },
];

const COMING_DESCRIPTION: Record<string, string> = {
  workflow: "启动与跟踪 WorkflowRun：阶段进度、HITL 等待输入、取消与恢复。",
  evidence: "研究证据库：文献检索结果、PDF 文本层分析与 Derived Context。",
  review: "Reviewer 三路审阅与 Quality Gate 结论、修订循环状态。",
  artifacts: "草稿与最终交付物：LaTeX 源、编译产物与版本历史。",
};

type OpenableTab = "pdf" | "citations";

function ProjectRunsPanel({ projectId }: { projectId: string }) {
  const { data, isPending, isError, error, refetch } = useProjectRuns(projectId);

  if (isPending) {
    return <Loading label="加载 Workflow 运行记录…" />;
  }
  if (isError) {
    return (
      <ErrorState
        title="运行记录加载失败"
        message={error instanceof Error ? error.message : String(error)}
        onRetry={() => void refetch()}
      />
    );
  }
  if (data === undefined || data.length === 0) {
    return (
      <p className="panel-empty">
        尚未运行 Workflow。运行界面即将开放；当前可经 API 触发
        （POST /api/projects/{projectId}/workflows）。
      </p>
    );
  }
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>Run</th>
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
              <td>{run.completion?.label ?? "—"}</td>
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
  onOpenTab,
}: {
  projectId: string;
  onOpenTab: (tab: OpenableTab) => void;
}) {
  const paper = usePaper(projectId);
  const citations = useCitations(projectId);
  const integrity = useCitationIntegrity(projectId);

  const doc: PaperDocSummary | null | undefined = paper.data?.document;
  const summary = citations.data?.summary;
  const citationsReady = summary !== undefined && summary.extracted;
  const semanticTotal = integrity.data?.report?.semantic.total ?? 0;

  // 下一步建议：由真实状态推导，最多两条
  const nextSteps: Array<{ label: string; tab: OpenableTab }> = [];
  if (!paper.isPending && (doc === null || doc === undefined)) {
    nextSteps.push({ label: "上传 Final PDF", tab: "pdf" });
  }
  if (!citations.isPending && !citationsReady) {
    nextSteps.push({ label: "提取并核验引用", tab: "citations" });
  }
  if (citationsReady && !integrity.isPending && semanticTotal === 0) {
    nextSteps.push({ label: "语义核验引用是否支持论断", tab: "citations" });
  }

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
          title="打开 PDF / Structure"
        >
          Final PDF <span className="aside-next-arrow" aria-hidden="true">›</span>
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
          title="打开 Citations"
        >
          Citations <span className="aside-next-arrow" aria-hidden="true">›</span>
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
                <dt>References</dt>
                <dd>
                  <span className="aside-value">{summary.references}</span>
                </dd>
              </div>
              <div className="aside-row">
                <dt>Callouts</dt>
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
  const [tab, setTab] = useState<TabId>("overview");
  const { data, isPending, isError, error, refetch } = useProject(projectId);

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
              : error instanceof Error
                ? error.message
                : String(error)
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
        <h1 className="workspace-title">{project.title}</h1>
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

      <nav className="tabs" role="tablist" aria-label="项目工作区">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={`tab ${tab === entry.id ? "active" : ""}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
            {entry.milestone !== undefined ? (
              <span className="tab-milestone" title={`规划于 ${entry.milestone}`}>
                Soon
              </span>
            ) : null}
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
                      <dt>目标 Venue</dt>
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
                <p className="panel-empty">
                  尚未填写研究定位字段。可经 PATCH /api/projects/{project.id} 补充（编辑界面后续提供）。
                </p>
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
                    已有论文改进模式：LaTeX 导入 API 已开放（POST /api/projects/{project.id}/import），
                    导入与改进流程界面将在后续里程碑提供；最终 PDF 已可在「PDF / Structure」上传。
                  </span>
                </p>
              ) : null}
            </section>

            <section>
              <div className="section-head">
                <h2>Workflow 运行记录</h2>
              </div>
              <ProjectRunsPanel projectId={project.id} />
            </section>
          </div>

          <WorkspaceAside projectId={project.id} onOpenTab={setTab} />
        </div>
      ) : tab === "pdf" ? (
        <PdfPanel projectId={project.id} />
      ) : tab === "citations" ? (
        <CitationsPanel projectId={project.id} />
      ) : (
        <ComingPanel entry={TABS.find((entry) => entry.id === tab)!} />
      )}
    </section>
  );
}
