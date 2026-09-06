import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { optionLabel, DOCUMENT_TYPE_OPTIONS } from "../../constants/projectMeta.js";
import { useArchiveProject, useRenameProject } from "../../hooks/queries.js";
import { formatApiError } from "../../utils/errors.js";
import type { ProjectView } from "../../types/api.js";
import { formatDateTime } from "../../utils/format.js";
import { ProjectStatusBadge, WorkflowKindBadge } from "./Badges.js";
import { InlineRename, RowMenu } from "../common/RowMenu.js";

/**
 * 项目列表行（Project Entry & Lifecycle UX 2026-09）。
 *
 * 结构：row container + 主内容 Link + actions 菜单（打开 / 重命名 / 归档）。
 * 菜单按钮不在 <Link> 内嵌套（合法交互结构，键盘可达）。
 * 永久删除只在 设置 → 项目管理 提供，不进普通项目列表。
 */
export function ProjectRow({ project }: { project: ProjectView }) {
  const navigate = useNavigate();
  const archive = useArchiveProject();
  const rename = useRenameProject(project.id);
  const [editing, setEditing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const meta = [
    project.researchField,
    optionLabel(DOCUMENT_TYPE_OPTIONS, project.documentType),
    project.targetVenue,
  ].filter((part): part is string => part !== undefined && part !== "");

  const onArchive = () => {
    setActionError(null);
    archive.mutate(project.id, {
      onError: (error) => setActionError(formatApiError(error)),
    });
  };

  return (
    <div className="project-row" data-testid="project-card">
      <div className="project-row-main">
        {editing ? (
          <InlineRename
            initial={project.title}
            onCancel={() => setEditing(false)}
            onCommit={(title) => {
              setEditing(false);
              rename.mutate(title, {
                onError: (error) => setActionError(formatApiError(error)),
              });
            }}
          />
        ) : (
          <Link to={`/projects/${project.id}`} className="project-row-link">
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
          </Link>
        )}
      </div>
      <div className="project-row-side">
        {!editing ? <ProjectStatusBadge status={project.status} /> : null}
        <span className="project-row-time">更新 {formatDateTime(project.updatedAt)}</span>
        {!editing ? (
          <RowMenu
            label={`项目「${project.title}」的更多操作`}
            testId="project-row-menu"
            items={[
              { id: "open", label: "打开", onSelect: () => void navigate(`/projects/${project.id}`) },
              { id: "rename", label: "重命名", onSelect: () => setEditing(true) },
              { id: "archive", label: "归档项目", onSelect: onArchive },
            ]}
          />
        ) : null}
      </div>
      {actionError !== null ? (
        <p className="form-error project-row-error" role="alert">
          {actionError}
        </p>
      ) : null}
    </div>
  );
}
