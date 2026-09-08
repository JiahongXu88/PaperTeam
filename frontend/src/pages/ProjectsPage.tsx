import { RecentActivity } from "../components/project/ProjectInsights.js";
import { Link } from "react-router-dom";

import { EmptyState, ErrorState, Loading } from "../components/common/StateViews.js";
import { Icon } from "../components/common/Icon.js";
import { PageHeader } from "../components/common/PageHeader.js";
import { ProjectRow } from "../components/project/ProjectRow.js";
import { useProjects } from "../hooks/queries.js";
import { formatApiError, formatApiErrorDetail } from "../utils/errors.js";

/** 论文项目列表：回答「我有哪些论文项目 / 最后动过哪个 / 进行到哪」 */
export function ProjectsPage() {
  const { data, isPending, isError, error, refetch } = useProjects();
  const failedCount = data?.filter((project) => project.status === "failed").length ?? 0;

  return (
    <section className="page research-home">
      <PageHeader
        title="论文项目"
        sub={
          data !== undefined && data.length > 0 ? (
            <>
              让每一次审阅，都推动研究向前。共 {data.length} 个项目
              {failedCount > 0 ? <span className="page-sub-warn">，{failedCount} 个上次任务失败</span> : null}
            </>
          ) : (
            "从研究想法开始写一篇新论文，或导入已有论文 PDF 做 Review。"
          )
        }
        actions={
          <Link to="/projects/new" className="btn btn-primary">
            <Icon name="plus" />
            新建项目
          </Link>
        }
      />

      {isPending ? (
        <Loading label="加载项目列表…" />
      ) : isError ? (
        <ErrorState
          title="项目列表加载失败"
          message={formatApiError(error)}
          detail={formatApiErrorDetail(error)}
          onRetry={() => void refetch()}
        />
      ) : data !== undefined && data.length === 0 ? (
        <EmptyState
          title="还没有论文项目"
          description="从研究想法开始写一篇新论文，或导入已有论文 PDF 做快速 Review 与系统性改进。"
        >
          <Link to="/projects/new" className="btn btn-primary">
            新建项目
          </Link>
        </EmptyState>
      ) : (
        <div className="home-layout">
          <div className="home-projects">
            <div className="section-head"><h2>继续工作</h2><span className="section-note">最近更新的论文</span></div>
            <div className="project-list">{data?.map((project, index) => <div key={project.id} className={index === 0 ? "home-current" : "home-recent"}>{index === 1 && <h2 className="home-recent-heading">最近项目</h2>}<ProjectRow project={project} /></div>)}</div>
            <div className="home-entry-grid">
              <Link to="/projects/new" className="home-entry"><Icon name="upload" /><h3>让论文更进一步</h3><p>导入 PDF，梳理结构、核验引用、获取审阅建议。</p><span>导入或创建论文 <Icon name="chevron-right" /></span></Link>
              <Link to="/skills" className="home-entry"><Icon name="layers" /><h3>研究能力，随时就绪</h3><p>了解 Agent 使用的 Skill，让调研与审阅各有所长。</p><span>浏览 Skills <Icon name="chevron-right" /></span></Link>
            </div>
          </div>
          <div className="home-support">
            <div className="home-brand" aria-hidden="true"><span>Better Research<br />Higher Impact</span><small>从每一个值得追问的问题开始。</small></div>
            {data?.[0] && <RecentActivity projectId={data[0].id} createdAt={data[0].createdAt} />}
          </div>
        </div>
      )}
    </section>
  );
}
