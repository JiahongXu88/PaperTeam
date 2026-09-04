import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { ErrorState, Loading } from "../components/common/StateViews.js";
import { ProjectStatusBadge, RunStatusBadge, WorkflowKindBadge } from "../components/project/Badges.js";
import { optionLabel, DOCUMENT_TYPE_OPTIONS, TARGET_PROFILE_OPTIONS } from "../constants/projectMeta.js";
import { useProject, useProjectRuns } from "../hooks/queries.js";
import { ApiError } from "../api/client.js";
import { formatDateTime } from "../utils/format.js";

/**
 * Project Workspace（M4.2 基础壳）。
 *
 * Overview 展示真实数据（项目定位字段 + 最近 WorkflowRun 摘要）；
 * Workflow / Evidence / Review / Artifacts 为导航入口，完整功能属
 * M4.3-M4.7（不做占位 mock 数据）。
 */

type TabId = "overview" | "workflow" | "evidence" | "review" | "artifacts";

const TABS: ReadonlyArray<{ id: TabId; label: string; milestone?: string }> = [
  { id: "overview", label: "Overview" },
  { id: "workflow", label: "Workflow", milestone: "M4.3" },
  { id: "evidence", label: "Evidence", milestone: "M4.5" },
  { id: "review", label: "Review / Quality Gate", milestone: "M4.6" },
  { id: "artifacts", label: "Draft / Final PDF", milestone: "M4.7" },
];

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
        尚未运行 Workflow。启动 Workflow 的界面将在 M4.3 提供（当前可经
        POST /api/projects/{projectId}/workflows 调用）。
      </p>
    );
  }
  return (
    <table className="runs-table">
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
            <td>{formatDateTime(run.updatedAt) ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
      <div className="page-head">
        <div>
          <p className="page-sub">
            <Link to="/projects">My Papers</Link> / <span className="mono">{project.id}</span>
          </p>
          <h1 className="project-title">{project.title}</h1>
          <div className="project-title-badges">
            <WorkflowKindBadge kind={project.workflowKind} />
            <ProjectStatusBadge status={project.status} />
          </div>
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
          </button>
        ))}
      </nav>

      {tab === "overview" ? (
        <div className="panel-stack">
          <div className="panel">
            <h2>研究定位</h2>
            {meta.length > 0 ? (
              <dl className="meta-grid">
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
                <div>
                  <dt>创建 / 更新</dt>
                  <dd>
                    {formatDateTime(project.createdAt)} / {formatDateTime(project.updatedAt)}
                  </dd>
                </div>
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
              <p className="form-note">
                已有论文改进模式：LaTeX 导入 API 已开放（POST /api/projects/{project.id}/import），
                导入与改进流程界面将在后续里程碑提供。
              </p>
            ) : null}
          </div>

          <div className="panel">
            <h2>Workflow 运行记录</h2>
            <ProjectRunsPanel projectId={project.id} />
          </div>
        </div>
      ) : (
        <div className="panel">
          <h2>{TABS.find((entry) => entry.id === tab)?.label}</h2>
          <p className="panel-empty">
            该模块计划在 {TABS.find((entry) => entry.id === tab)?.milestone} 提供，
            当前里程碑（M4.0-M4.2）暂未开放。
          </p>
        </div>
      )}
    </section>
  );
}
