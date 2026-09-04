import { Link } from "react-router-dom";

import { EmptyState, ErrorState, Loading } from "../components/common/StateViews.js";
import { ProjectCard } from "../components/project/ProjectCard.js";
import { useProjects } from "../hooks/queries.js";

/** 项目列表页（M4.2）：My Papers */
export function ProjectsPage() {
  const { data, isPending, isError, error, refetch } = useProjects();

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>My Papers</h1>
          <p className="page-sub">论文项目工作台（PaperTeam Workbench）</p>
        </div>
        <Link to="/projects/new" className="btn btn-primary">
          + New Project
        </Link>
      </div>

      {isPending ? (
        <Loading label="加载项目列表…" />
      ) : isError ? (
        <ErrorState
          title="项目列表加载失败"
          message={error instanceof Error ? error.message : String(error)}
          onRetry={() => void refetch()}
        />
      ) : data !== undefined && data.length === 0 ? (
        <EmptyState
          title="还没有论文项目"
          description="从研究想法（Idea-to-Paper）开始，创建你的第一个项目。"
        >
          <Link to="/projects/new" className="btn btn-primary">
            创建第一个项目
          </Link>
        </EmptyState>
      ) : (
        <div className="project-grid">
          {data?.map((project) => <ProjectCard key={project.id} project={project} />)}
        </div>
      )}
    </section>
  );
}
