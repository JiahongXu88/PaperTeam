import { Link, useSearchParams } from "react-router-dom";

import { EmptyState, ErrorState, Loading } from "../components/common/StateViews.js";
import { Icon } from "../components/common/Icon.js";
import { PageHeader } from "../components/common/PageHeader.js";
import { ProjectRow } from "../components/project/ProjectRow.js";
import { RunStatusBadge } from "../components/project/Badges.js";
import { stageLabel } from "../components/common/status.js";
import { useProjectRuns, useProjects, isRunActive } from "../hooks/queries.js";
import { WORKFLOW_KIND_RUN_LABELS } from "../constants/projectMeta.js";
import { formatApiError, formatApiErrorDetail } from "../utils/errors.js";
import { formatDateTime } from "../utils/format.js";
import type { ProjectView, WorkflowRunView } from "../types/api.js";

function RunActivity({ project }: { project: ProjectView }) {
  const runs = useProjectRuns(project.id);
  const activeRun = runs.data?.find(isRunActive);
  const visibleRuns = (runs.data ?? []).slice(0, 3);

  return (
    <article className="home-agent-project" data-testid={`agent-activity-${project.id}`}>
      <div className="home-agent-project-head">
        <Link to={`/projects/${project.id}`} title={project.title}>{project.title}</Link>
        {activeRun ? <span className="home-live-indicator"><i />运行中</span> : null}
      </div>
      {runs.isPending ? (
        <p className="home-agent-muted" role="status">正在读取任务状态…</p>
      ) : runs.isError ? (
        <div className="home-agent-error" role="alert">
          <span>任务状态加载失败</span>
          <button type="button" onClick={() => void runs.refetch()}>重试</button>
        </div>
      ) : visibleRuns.length === 0 ? (
        <p className="home-agent-muted">暂无 Agent 运行记录</p>
      ) : (
        <ul className="home-agent-run-list">
          {visibleRuns.map((run) => <RunActivityItem key={run.runId} run={run} />)}
        </ul>
      )}
      {visibleRuns.length > 0 ? (
        <Link className="home-agent-open" to={`/projects/${project.id}?tab=workflow`}>
          查看工作流 <Icon name="chevron-right" />
        </Link>
      ) : null}
    </article>
  );
}

function RunActivityItem({ run }: { run: WorkflowRunView }) {
  return (
    <li>
      <span className={`home-run-dot${isRunActive(run) ? " is-active" : ""}`} aria-hidden="true" />
      <span className="home-run-copy">
        <span>{WORKFLOW_KIND_RUN_LABELS[run.workflowKind]}</span>
        <small>{run.currentStage ? `当前阶段：${stageLabel(run.currentStage) ?? run.currentStage}` : formatDateTime(run.updatedAt)}</small>
      </span>
      <RunStatusBadge status={run.status} />
    </li>
  );
}

/** 工作台首页：真实项目与运行记录通过项目 API / workflow API 加载。 */
export function ProjectsPage() {
  const [searchParams] = useSearchParams();
  if (searchParams.get("view") === "list") return <ProjectsListPage />;
  return <ProjectsDashboard />;
}

function ProjectsListPage() {
  const { data, isPending, isError, error, refetch } = useProjects();
  const failedCount = data?.filter((project) => project.status === "failed").length ?? 0;
  return (
    <section className="page">
      <PageHeader title="我的项目" sub={data ? `共 ${data.length} 个项目${failedCount ? `，${failedCount} 个上次任务失败` : ""}` : "查看并继续最近的论文项目。"} actions={<Link to="/projects/new" className="btn btn-primary"><Icon name="plus" />新建项目</Link>} />
      {isPending ? <Loading label="加载项目列表…" /> : isError ? <ErrorState title="项目列表加载失败" message={formatApiError(error)} detail={formatApiErrorDetail(error)} onRetry={() => void refetch()} /> : data?.length === 0 ? <EmptyState title="还没有论文项目" description="创建论文或导入已有稿件后，项目会显示在这里。"><Link to="/projects/new" className="btn btn-primary">新建项目</Link></EmptyState> : <div className="project-list">{data?.map((project) => <ProjectRow key={project.id} project={project} />)}</div>}
    </section>
  );
}

function ProjectsDashboard() {
  const { data, isPending, isError, error, refetch } = useProjects();
  const failedCount = data?.filter((project) => project.status === "failed").length ?? 0;

  return (
    <section className="page research-home" data-testid="projects-dashboard">
      <section className="home-hero">
        <div className="home-hero-copy">
          <span className="home-kicker">RESEARCH / PAPERTEAM</span>
          <h1>让研究更进一步</h1>
          <p>从真实文献与可核验证据出发，完成写作、审阅与修订。</p>
          <span className="home-hero-meta">Evidence grounded <i /> Human in the loop <i /> Self hosted</span>
        </div>
      </section>

      <section className="home-start-section" aria-labelledby="home-start-heading">
        <div className="section-head"><h2 id="home-start-heading">选择一个开始方式</h2><span className="section-note">让研究流程从合适的材料开始</span></div>
        <div className="home-entry-grid">
          <Link to="/projects/new" className="home-entry home-entry-create">
            <span className="home-entry-number">01</span>
            <h3>创建新论文</h3>
            <strong>研究论文 · 综述论文 · 学位论文</strong>
            <p>从研究主题或已有成果出发，开展文献研究、论文写作与审阅。</p>
            <span className="home-entry-action">选择论文类型 <Icon name="chevron-right" /></span>
          </Link>
          <Link to="/projects/new?mode=existing" className="home-entry home-entry-import">
            <span className="home-entry-number">02</span>
            <h3>修改已有论文</h3>
            <strong>PDF / LaTeX / 审稿意见</strong>
            <p>以已有稿件为基础，支持审阅、审稿意见驱动修订和质量验证。</p>
            <span className="home-entry-action">导入论文并开始 <Icon name="chevron-right" /></span>
          </Link>
        </div>
      </section>

      <section className="home-workspace" aria-label="项目与 Agent 状态">
        <div className="home-projects home-section-panel">
          <div className="section-head">
            <div><span className="home-section-kicker">YOUR WORKSPACE</span><h2>当前项目 / 继续工作</h2></div>
            <Link className="home-text-link" to="/projects?view=list">全部项目 <Icon name="chevron-right" /></Link>
          </div>
          {data !== undefined && data.length > 0 ? (
            <>
              <div className="home-project-list">
                {data.slice(0, 4).map((project, index) => (
                  <div key={project.id} className={index === 0 ? "home-current" : "home-recent"}>
                    {index === 1 ? <h3 className="home-recent-heading">最近项目</h3> : null}
                    <ProjectRow project={project} />
                  </div>
                ))}
              </div>
              {failedCount > 0 ? <p className="home-failed-note">有 {failedCount} 个项目的上次任务失败，可打开项目查看错误并重试。</p> : null}
            </>
          ) : isPending ? (
            <Loading label="加载项目列表…" />
          ) : isError ? (
            <ErrorState title="项目列表加载失败" message={formatApiError(error)} detail={formatApiErrorDetail(error)} onRetry={() => void refetch()} />
          ) : (
            <div className="home-empty-projects">
              <span className="home-empty-icon"><Icon name="document" /></span>
              <div><h3>还没有论文项目</h3><p>创建论文或导入已有稿件后，项目进度会显示在这里。</p></div>
              <Link to="/projects/new" className="btn btn-primary">开始创建</Link>
            </div>
          )}
        </div>

        <aside className="home-agent-panel">
          <div className="section-head"><div><span className="home-section-kicker">LIVE WORKFLOW</span><h2>Agent 活动</h2></div></div>
          {isPending ? <p className="home-agent-muted">加载项目后显示 Agent 活动。</p> : null}
          {isError ? <p className="home-agent-muted">项目列表不可用，暂时无法读取 Agent 活动。</p> : null}
          {data?.length === 0 ? (
            <div className="home-agent-empty"><span className="home-empty-icon"><Icon name="layers" /></span><strong>暂无运行任务</strong><p>启动项目工作流后，Agent 进度会显示在这里。</p></div>
          ) : null}
          {data?.slice(0, 3).map((project) => <RunActivity key={project.id} project={project} />)}
        </aside>
      </section>
    </section>
  );
}
