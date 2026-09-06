import { Link } from "react-router-dom";

import { optionLabel, DOCUMENT_TYPE_OPTIONS } from "../../constants/projectMeta.js";
import type { ProjectView } from "../../types/api.js";
import { formatDateTime } from "../../utils/format.js";
import { ProjectStatusBadge, WorkflowKindBadge } from "./Badges.js";

/**
 * 项目列表行（Visual Redesign 2026-09）：账簿式单行条目。
 *
 * 第一视觉层 = 论文标题（衬线 18px）；模式 chip + 领域 / 类型 / venue
 * 作为次级 meta（语言等工作区细节不占首页注意力）；状态与更新时间靠右。
 * 只渲染 Backend 提供的真实字段，缺失字段不占位。
 */
export function ProjectRow({ project }: { project: ProjectView }) {
  const meta = [
    project.researchField,
    optionLabel(DOCUMENT_TYPE_OPTIONS, project.documentType),
    project.targetVenue,
  ].filter((part): part is string => part !== undefined && part !== "");

  return (
    <Link to={`/projects/${project.id}`} className="project-row" data-testid="project-card">
      <div className="project-row-main">
        <span className="project-row-title reading">{project.title}</span>
        <span className="project-row-meta">
          <span className="meta-part">
            <WorkflowKindBadge kind={project.workflowKind} />
          </span>
          {meta.map((part) => (
            <span key={part} className="meta-part">
              {part}
            </span>
          ))}
        </span>
      </div>
      <div className="project-row-side">
        <ProjectStatusBadge status={project.status} />
        <span className="project-row-time">更新 {formatDateTime(project.updatedAt)}</span>
      </div>
    </Link>
  );
}
