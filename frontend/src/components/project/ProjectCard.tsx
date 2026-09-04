import { Link } from "react-router-dom";

import { optionLabel, DOCUMENT_TYPE_OPTIONS } from "../../constants/projectMeta.js";
import type { ProjectView } from "../../types/api.js";
import { formatDateTime } from "../../utils/format.js";
import { ProjectStatusBadge, WorkflowKindBadge } from "./Badges.js";

/** 项目卡片（M4.2）：只渲染 Backend 提供的真实字段，缺失字段不占位 */
export function ProjectCard({ project }: { project: ProjectView }) {
  const documentTypeLabel = optionLabel(DOCUMENT_TYPE_OPTIONS, project.documentType);
  const meta = [
    project.researchField,
    documentTypeLabel,
    project.targetVenue,
    project.language,
  ].filter((part): part is string => part !== undefined && part !== "");

  return (
    <Link to={`/projects/${project.id}`} className="project-card" data-testid="project-card">
      <div className="project-card-head">
        <h3 className="project-card-title">{project.title}</h3>
        <ProjectStatusBadge status={project.status} />
      </div>
      <div className="project-card-badges">
        <WorkflowKindBadge kind={project.workflowKind} />
      </div>
      {meta.length > 0 ? <p className="project-card-meta">{meta.join(" · ")}</p> : null}
      <p className="project-card-time">
        创建 {formatDateTime(project.createdAt)} · 更新 {formatDateTime(project.updatedAt)}
      </p>
    </Link>
  );
}
