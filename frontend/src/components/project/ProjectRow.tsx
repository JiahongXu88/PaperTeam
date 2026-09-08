import { PaperPreview } from "./PaperPreview.js";
import { Icon } from "../common/Icon.js";
import { ProjectInsights } from "./ProjectInsights.js";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { optionLabel, DOCUMENT_TYPE_OPTIONS } from "../../constants/projectMeta.js";
import { useArchiveProject, useRenameProject } from "../../hooks/queries.js";
import { formatApiError } from "../../utils/errors.js";
import type { ProjectView } from "../../types/api.js";
import { formatDateTime } from "../../utils/format.js";
import { ProjectStatusBadge, WorkflowKindBadge } from "./Badges.js";
import { InlineConfirm, InlineRename, RowMenu } from "../common/RowMenu.js";


/**
 * 项目列表行：标题链接 + 类型 / 定位 + 状态 + 更新时间 + 「···」菜单。
 * 菜单按钮不嵌在 <Link> 内；归档要经一次行内确认。永久删除只在 设置 → 项目管理。
 */
export function ProjectRow({ project }: { project: ProjectView }) {
  const navigate = useNavigate();
  const archive = useArchiveProject();
  const rename = useRenameProject(project.id);
  const [editing, setEditing] = useState(false);
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const meta = [project.researchField, optionLabel(DOCUMENT_TYPE_OPTIONS, project.documentType), project.targetVenue].filter(
    (part): part is string => part !== undefined && part !== "",
  );

  const onArchive = () => {
    setActionError(null);
    archive.mutate(project.id, {
      onSuccess: () => setConfirmingArchive(false),
      onError: (error) => {
        setConfirmingArchive(false);
        setActionError(formatApiError(error));
      },
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
              setActionError(null);
              rename.mutate(title, { onError: (error) => setActionError(formatApiError(error)) });
            }}
          />
        ) : (
          <Link to={`/projects/${project.id}`} className="project-row-link">
            <span className="project-row-icon" aria-hidden="true">
              <PaperPreview title={project.title} compact />
            </span>
            <span className="project-row-text">
              <span className="project-row-title">{project.title}</span>
              <span className="project-row-meta">
                <WorkflowKindBadge kind={project.workflowKind} />
                {meta.map((part, index) => (
                  <span key={`${index}-${part}`} className="meta-part">
                    {part}
                  </span>
                ))}
              </span>
            </span>
          </Link>
        )}
      </div>
      <div className="project-row-side">
        {confirmingArchive ? (
          <InlineConfirm
            message="归档后不再显示在列表中，可在设置中恢复。"
            confirmLabel="归档"
            onConfirm={onArchive}
            onCancel={() => setConfirmingArchive(false)}
            pending={archive.isPending}
            testId="archive-confirm"
          />
        ) : (
          <>
            {!editing ? <ProjectStatusBadge status={project.status} /> : null}
            <span className="project-row-time">更新于 {formatDateTime(project.updatedAt)}</span>
            <Link className="btn btn-small project-continue" to={`/projects/${project.id}${project.workflowKind === "existing_paper_review" || project.workflowKind === "existing_paper_improvement" ? "?tab=review" : ""}`}>继续工作 <Icon name="chevron-right" /></Link>
            {!editing ? (
              <RowMenu
                label={`项目「${project.title}」的更多操作`}
                testId="project-row-menu"
                items={[
                  { id: "open", label: "打开", onSelect: () => void navigate(`/projects/${project.id}`) },
                  { id: "rename", label: "重命名", onSelect: () => setEditing(true) },
                  { id: "archive", label: "归档项目", onSelect: () => setConfirmingArchive(true) },
                ]}
              />
            ) : null}
          </>
        )}
      </div>
      {project.workflowKind !== "idea_to_paper" && project.workflowKind !== undefined ? <ProjectInsights projectId={project.id} /> : null}
      {actionError !== null ? (
        <p className="form-error project-row-error" role="alert">
          {actionError}
        </p>
      ) : null}
    </div>
  );
}
