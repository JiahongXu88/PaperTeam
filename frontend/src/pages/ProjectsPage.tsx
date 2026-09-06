import { Link } from "react-router-dom";

import { EmptyState, ErrorState, Loading } from "../components/common/StateViews.js";
import { PageHeader } from "../components/common/PageHeader.js";
import { ProjectRow } from "../components/project/ProjectRow.js";
import { useProjects } from "../hooks/queries.js";

/**
 * 项目列表页（Visual Redesign 2026-09）：账簿式列表，回答
 * 「我有哪些论文项目 / 最后动过哪个 / 是什么类型 / 进行到哪」。
 */
export function ProjectsPage() {
  const { data, isPending, isError, error, refetch } = useProjects();
  const failedCount = data?.filter((project) => project.status === "failed").length ?? 0;

  return (
    <section className="page">
      <PageHeader
        title="My Papers"
        sub={
          data !== undefined && data.length > 0 ? (
            failedCount > 0 ? (
              <>
                {data.length} 个论文项目 ·{" "}
                <span style={{ color: "var(--danger)", fontWeight: 600 }}>{failedCount} 个失败</span>
              </>
            ) : (
              `${data.length} 个论文项目`
            )
          ) : (
            "管理你的论文项目与研究工作流"
          )
        }
        actions={
          <Link to="/projects/new" className="btn btn-primary">
            New Project
          </Link>
        }
      />

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
        <div className="project-list">
          {data?.map((project) => <ProjectRow key={project.id} project={project} />)}
        </div>
      )}
    </section>
  );
}
