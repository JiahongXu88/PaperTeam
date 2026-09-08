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
    <section className="page">
      <PageHeader
        title="论文项目"
        sub={
          data !== undefined && data.length > 0 ? (
            <>
              共 {data.length} 个项目
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
        <div className="project-list">
          {data?.map((project) => <ProjectRow key={project.id} project={project} />)}
        </div>
      )}
    </section>
  );
}
