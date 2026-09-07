import { useEffect, useRef, useState } from "react";

import { EmptyState, ErrorState, Loading } from "../components/common/StateViews.js";
import { PageHeader } from "../components/common/PageHeader.js";
import { WorkflowKindBadge } from "../components/project/Badges.js";
import { useArchivedProjects, useDeleteProject, useRestoreProject } from "../hooks/queries.js";
import { formatApiError, formatApiErrorDetail } from "../utils/errors.js";
import { formatDateTime } from "../utils/format.js";
import type { ProjectView } from "../types/api.js";

/**
 * 设置 → 项目管理：只处理已归档项目——恢复，或输入完整标题后永久删除（删除整个工作区，不可恢复）。
 * 归档入口在项目列表行的「···」菜单，不在此重复。
 */
export function ProjectManagementSettingsPage() {
  const { data, isPending, isError, error, refetch } = useArchivedProjects();
  const restore = useRestoreProject();
  const del = useDeleteProject();
  const [confirming, setConfirming] = useState<ProjectView | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const confirmInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (confirming !== null) {
      confirmInputRef.current?.focus();
    }
  }, [confirming]);

  const archived = data ?? [];

  const closeConfirm = () => {
    setConfirming(null);
    setConfirmText("");
    del.reset();
  };

  const onDelete = () => {
    if (confirming === null || confirmText.trim() !== confirming.title) {
      return;
    }
    del.mutate(confirming.id, { onSuccess: closeConfirm });
  };

  return (
    <div>
      <PageHeader title="项目管理" sub="已归档项目的恢复与永久删除。归档入口在「论文项目」列表每行的 ··· 菜单。" />

      {isPending ? (
        <Loading label="加载已归档项目…" />
      ) : isError ? (
        <ErrorState title="已归档项目加载失败" message={formatApiError(error)} detail={formatApiErrorDetail(error)} onRetry={() => void refetch()} />
      ) : archived.length === 0 ? (
        <EmptyState title="暂无已归档项目。" description="在论文项目列表的「···」菜单中选择「归档项目」后，项目会出现在这里。" />
      ) : (
        <div className="table-scroll">
          <table className="data-table" data-testid="archived-projects-table">
            <thead>
              <tr>
                <th>项目标题</th>
                <th>类型</th>
                <th>归档时间</th>
                <th>最近更新</th>
                <th>
                  <span className="visually-hidden">操作</span>
                </th>
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
                        onClick={() => {
                          setActionError(null);
                          restore.mutate(project.id, { onError: (restoreError) => setActionError(formatApiError(restoreError)) });
                        }}
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
                          del.reset();
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
        <p className="form-error" role="alert" style={{ marginTop: "var(--s-3)" }}>
          {actionError}
        </p>
      ) : null}

      {confirming !== null ? (
        <section className="danger-zone" aria-labelledby="delete-confirm-title" data-testid="delete-confirm">
          <div className="danger-kicker">永久删除确认</div>
          <div className="section-head">
            <h2 className="panel-title" id="delete-confirm-title">
              永久删除「{confirming.title}」
            </h2>
          </div>
          <p className="panel-sub" style={{ marginBottom: "var(--s-3)" }}>
            将删除该项目的全部内容：论文 PDF、解析结果、引用核验记录、Review 报告、任务记录与项目信息。<strong>永久删除后无法恢复。</strong>
          </p>
          <div className="field">
            <label htmlFor="delete-confirm-input">输入完整项目标题以确认</label>
            <input
              id="delete-confirm-input"
              ref={confirmInputRef}
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              autoComplete="off"
              placeholder={confirming.title}
              data-testid="delete-confirm-input"
            />
            <span className="field-help">
              需要与「<span className="reading">{confirming.title}</span>」完全一致。
            </span>
          </div>
          <div className="action-row" style={{ marginTop: "var(--s-3)" }}>
            <button type="button" className="btn btn-danger" disabled={confirmText.trim() !== confirming.title || del.isPending} data-testid="delete-confirm-button" onClick={onDelete}>
              {del.isPending ? "删除中…" : "永久删除"}
            </button>
            <button type="button" className="btn" onClick={closeConfirm}>
              取消
            </button>
          </div>
          {del.isError ? (
            <p className="form-error" role="alert" style={{ marginTop: "var(--s-2)" }}>
              删除失败：{formatApiError(del.error)}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
