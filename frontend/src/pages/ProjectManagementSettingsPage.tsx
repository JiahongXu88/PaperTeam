import { useState } from "react";

import { EmptyState, ErrorState, Loading } from "../components/common/StateViews.js";
import { PageHeader } from "../components/common/PageHeader.js";
import { WorkflowKindBadge } from "../components/project/Badges.js";
import { useArchivedProjects, useDeleteProject, useRestoreProject } from "../hooks/queries.js";
import { formatApiError } from "../utils/errors.js";
import { formatDateTime } from "../utils/format.js";
import type { ProjectView } from "../types/api.js";

/**
 * 设置 → 项目管理（Project Entry & Lifecycle UX 2026-09）。
 *
 * 只管理已归档项目：恢复（回到论文项目列表与最近项目）与永久删除
 * （输入完整项目标题确认；删除整个工作区，不可恢复）。
 * 归档入口在项目列表行的「···」菜单，不在此页重复。
 */
export function ProjectManagementSettingsPage() {
  const { data, isPending, isError, error, refetch } = useArchivedProjects();
  const restore = useRestoreProject();
  const del = useDeleteProject();
  const [confirming, setConfirming] = useState<ProjectView | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const archived = data ?? [];

  const onDelete = () => {
    if (confirming === null || confirmText !== confirming.title) {
      return;
    }
    del.mutate(confirming.id, {
      onSuccess: () => {
        setConfirming(null);
        setConfirmText("");
      },
      // 删除错误由确认区的 del.isError 呈现（不与 actionError 重复）
    });
  };

  return (
    <div>
      <PageHeader
        title="项目管理"
        sub="已归档项目的恢复与永久删除。归档入口在「论文项目」列表每行的 ··· 菜单。"
      />

      {isPending ? (
        <Loading label="加载已归档项目…" />
      ) : isError ? (
        <ErrorState
          title="已归档项目加载失败"
          message={formatApiError(error)}
          onRetry={() => void refetch()}
        />
      ) : archived.length === 0 ? (
        <EmptyState
          title="暂无已归档项目。"
          description="在论文项目列表的「···」菜单中选择「归档项目」后，项目会出现在这里。"
        />
      ) : (
        <div className="table-scroll">
          <table className="data-table" data-testid="archived-projects-table">
            <thead>
              <tr>
                <th>项目标题</th>
                <th>项目类型</th>
                <th>归档时间</th>
                <th>最近更新</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {archived.map((project) => (
                <tr key={project.id}>
                  <td className="reading">{project.title}</td>
                  <td>
                    <WorkflowKindBadge kind={project.workflowKind} />
                  </td>
                  <td className="muted">{formatDateTime(project.archivedAt) ?? "—"}</td>
                  <td className="muted">{formatDateTime(project.updatedAt) ?? "—"}</td>
                  <td>
                    <div className="action-row">
                      <button
                        type="button"
                        className="btn btn-small"
                        disabled={restore.isPending}
                        data-testid={`restore-${project.id}`}
                        onClick={() =>
                          restore.mutate(project.id, {
                            onError: (restoreError) => setActionError(formatApiError(restoreError)),
                          })
                        }
                      >
                        恢复
                      </button>
                      <button
                        type="button"
                        className="btn btn-small btn-danger"
                        onClick={() => {
                          setConfirming(project);
                          setConfirmText("");
                          setActionError(null);
                        }}
                      >
                        永久删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {actionError !== null ? (
        <p className="form-error" role="alert" style={{ marginTop: 12 }}>
          {actionError}
        </p>
      ) : null}

      {confirming !== null ? (
        <div className="danger-zone" role="dialog" aria-modal="false" aria-label="永久删除确认" data-testid="delete-confirm">
          <div className="danger-kicker">永久删除确认</div>
          <div className="section-head">
            <h2 className="panel-title">永久删除「{confirming.title}」</h2>
          </div>
          <p className="panel-sub" style={{ marginBottom: 12 }}>
            将删除该项目的全部内容：论文 PDF、解析结果、引用核验记录、审阅报告、
            运行记录与项目信息。<strong>永久删除后无法恢复。</strong>
          </p>
          <div className="field">
            <label htmlFor="delete-confirm-input">
              输入完整项目标题 <span className="mono">{confirming.title}</span> 以确认：
            </label>
            <input
              id="delete-confirm-input"
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              autoComplete="off"
              data-testid="delete-confirm-input"
            />
          </div>
          <div className="action-row" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-danger"
              disabled={confirmText !== confirming.title || del.isPending}
              data-testid="delete-confirm-button"
              onClick={onDelete}
            >
              {del.isPending ? "删除中…" : "永久删除"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setConfirming(null);
                setConfirmText("");
              }}
            >
              取消
            </button>
          </div>
          {del.isError ? (
            <p className="form-error" role="alert" style={{ marginTop: 8 }}>
              删除失败：{formatApiError(del.error)}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
