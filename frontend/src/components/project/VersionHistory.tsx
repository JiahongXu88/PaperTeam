import { useState } from "react";

import { ErrorState, Loading } from "../common/StateViews.js";
import { Icon } from "../common/Icon.js";
import {
  COMPARE_STATUS_STYLES,
  ITERATION_OUTCOME_STYLES,
  REVISION_SOURCE_LABELS,
  statusStyleOf,
} from "../common/status.js";
import { artifactDownloadUrl } from "../../api/artifacts.js";
import { useRestoreRevision, useVersionCompare, useVersions } from "../../hooks/queries.js";
import { ApiError } from "../../api/client.js";
import { formatApiError } from "../../utils/errors.js";
import { formatDateTime } from "../../utils/format.js";
import type { ManuscriptVersionView } from "../../types/api.js";

/**
 * 版本历史（M4.8）：论文修订的完整时间线 + 确定性版本比较 + 不可变恢复。
 *
 * 语义纪律：
 * - 用户看到的是「修订 N / 审稿轮次 / Draft / Final」，不是工程标识；
 * - 版本与 review / gate / artifact 的关联全部来自 Backend 的 ManuscriptVersionDTO，
 *   前端不拼装猜测；差异是 Backend 确定性计算（零 LLM）；
 * - 恢复 = 基于历史修订创建新的当前修订（历史永不删除），确认文案如实说明。
 */
export function VersionHistoryCard({ projectId }: { projectId: string }) {
  const versions = useVersions(projectId);
  const [fromRevision, setFromRevision] = useState<number | null>(null);
  const [toRevision, setToRevision] = useState<number | null>(null);

  if (versions.isPending) {
    return (
      <section className="panel section-block" data-testid="version-history">
        <div className="section-head">
          <h2>版本历史</h2>
        </div>
        <Loading label="加载版本历史…" />
      </section>
    );
  }
  if (versions.isError) {
    return (
      <section className="panel section-block" data-testid="version-history">
        <div className="section-head">
          <h2>版本历史</h2>
        </div>
        <ErrorState
          title="版本历史加载失败"
          message={formatApiError(versions.error)}
          onRetry={() => void versions.refetch()}
        />
      </section>
    );
  }
  const list = versions.data.versions;
  if (list.length === 0) {
    return null; // 尚无版本事实：面板其余空态已说明
  }
  const current = versions.data.current;
  // 默认比较：上一版 → 当前版（用户可改）
  const from = fromRevision ?? list[Math.min(1, list.length - 1)]?.revision ?? list[0]!.revision;
  const to = toRevision ?? current;
  const compareReady = from !== to;

  return (
    <section className="panel section-block" data-testid="version-history">
      <div className="section-head">
        <h2>版本历史</h2>
        <span className="faint">每个修订不可变；恢复历史版本会创建新修订，不覆盖任何记录</span>
      </div>

      <VersionCompareControls
        projectId={projectId}
        versions={list}
        from={from}
        to={to}
        onFromChange={setFromRevision}
        onToChange={setToRevision}
        enabled={compareReady}
      />

      <ol className="version-list">
        {list.map((version) => (
          <VersionRow key={version.revision} projectId={projectId} version={version} />
        ))}
      </ol>
    </section>
  );
}

// ---- 版本比较 ----

function VersionCompareControls({
  projectId,
  versions,
  from,
  to,
  onFromChange,
  onToChange,
  enabled,
}: {
  projectId: string;
  versions: ManuscriptVersionView[];
  from: number;
  to: number;
  onFromChange: (revision: number) => void;
  onToChange: (revision: number) => void;
  enabled: boolean;
}) {
  const compare = useVersionCompare(projectId, enabled ? from : null, enabled ? to : null);
  const options = [...versions].sort((a, b) => a.revision - b.revision);
  return (
    <div className="version-compare" data-testid="version-compare-block">
      <div className="version-compare-controls">
        <label className="field-inline">
          <span>从</span>
          <select
            value={from}
            data-testid="compare-from"
            onChange={(event) => onFromChange(Number(event.target.value))}
          >
            {options.map((option) => (
              <option key={option.revision} value={option.revision}>
                修订 {option.revision}
              </option>
            ))}
          </select>
        </label>
        <span className="version-compare-arrow" aria-hidden="true">
          →
        </span>
        <label className="field-inline">
          <span>到</span>
          <select
            value={to}
            data-testid="compare-to"
            onChange={(event) => onToChange(Number(event.target.value))}
          >
            {options.map((option) => (
              <option key={option.revision} value={option.revision}>
                修订 {option.revision}
              </option>
            ))}
          </select>
        </label>
        <span className="field-help">差异由后端确定性计算（不使用模型）</span>
      </div>
      {!enabled ? <p className="field-help">请选择两个不同的修订进行比较。</p> : null}
      {enabled && compare.isPending ? <Loading label="比较版本…" /> : null}
      {enabled && compare.isError ? (
        <p className="form-error" role="alert">
          版本比较失败：{formatApiError(compare.error)}
        </p>
      ) : null}
      {enabled && compare.data !== undefined ? <VersionCompareResult data={compare.data} /> : null}
    </div>
  );
}

function VersionCompareResult({ data }: { data: NonNullable<ReturnType<typeof useVersionCompare>["data"]> }) {
  const { summary, sections, reviewDelta } = data;
  const changedCount = summary.modified + summary.added + summary.removed;
  return (
    <div className="version-compare-result" data-testid="version-compare-result">
      <div className="version-compare-summary">
        <span className="chip chip-tone-info">修改 {summary.modified} 处</span>
        {summary.added > 0 ? <span className="chip chip-tone-ok">新增 {summary.added} 处</span> : null}
        {summary.removed > 0 ? <span className="chip chip-tone-warn">移除 {summary.removed} 处</span> : null}
        <span className="chip chip-tone-neutral">未变化 {summary.unchanged} 处</span>
        <span className="muted">共 {changedCount} 处实质变化</span>
      </div>
      <table className="version-compare-table" data-testid="version-compare-table">
        <thead>
          <tr>
            <th>章节 / 文件</th>
            <th>状态</th>
            <th>规模</th>
          </tr>
        </thead>
        <tbody>
          {sections.map((section) => {
            const style = statusStyleOf(COMPARE_STATUS_STYLES, section.status, section.status);
            const scale =
              section.status === "unchanged"
                ? section.fromLines !== null
                  ? `${section.fromLines} 行`
                  : "—"
                : section.added !== null
                  ? `${section.fromLines ?? 0} → ${section.toLines ?? 0} 行（+${section.added} / −${section.removed}）`
                  : "二进制 / 资产";
            return (
              <tr key={section.path} data-compare-status={section.status}>
                <td>
                  <span>{section.title}</span>
                  <span className="mono muted version-compare-path">{section.path}</span>
                </td>
                <td>
                  <span className={`status status-tone-${style.tone}`}>{style.label}</span>
                </td>
                <td className="mono">{scale}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ReviewGateDelta reviewDelta={reviewDelta} />
    </div>
  );
}

/** 两端 review / gate 记分对照（只展示 Backend 已有 Scorecard，前端不重算） */
function ReviewGateDelta({
  reviewDelta,
}: {
  reviewDelta: NonNullable<ReturnType<typeof useVersionCompare>["data"]>["reviewDelta"];
}) {
  const { from, to, fromGate, toGate } = reviewDelta;
  const factText = (review: typeof from, gate: typeof fromGate): string => {
    if (review === null) {
      return "无审稿记录";
    }
    const scorePart = review.academicScore !== null ? ` · 学术 ${review.academicScore}` : "";
    const gatePart =
      gate === null ? " · 门禁未评估" : gate.passed ? " · 门禁通过" : ` · 门禁未通过（${gate.failedRuleIds.length} 项）`;
    return `第 ${review.round} 轮审稿：严重 ${review.critical} / 主要 ${review.major}${scorePart}${gatePart}`;
  };
  return (
    <div className="version-compare-delta" data-testid="version-compare-delta">
      <div>
        <span className="muted">修订 {from?.reviewedRevision ?? "—"}：</span>
        {factText(from, fromGate)}
      </div>
      <div>
        <span className="muted">修订 {to?.reviewedRevision ?? "—"}：</span>
        {factText(to, toGate)}
      </div>
    </div>
  );
}

// ---- 版本行 ----

function VersionRow({
  projectId,
  version,
}: {
  projectId: string;
  version: ManuscriptVersionView;
}) {
  const restore = useRestoreRevision(projectId);
  const [confirming, setConfirming] = useState(false);
  const sourceLabel = REVISION_SOURCE_LABELS[version.source] ?? version.source;
  const iteration =
    version.iteration !== null && version.iteration.outcome !== null
      ? statusStyleOf(ITERATION_OUTCOME_STYLES, version.iteration.outcome, version.iteration.outcome)
      : null;

  return (
    <li
      className={`version-item${version.isCurrent ? " version-item-current" : ""}`}
      data-testid="version-item"
      data-revision={version.revision}
    >
      <div className="version-item-head">
        <span className="version-rev">修订 {version.revision}</span>
        {version.isCurrent ? <span className="chip chip-tone-accent">当前版本</span> : null}
        {version.isFinal ? <span className="chip chip-tone-ok">Final</span> : null}
        {version.hasDraft && !version.isFinal ? <span className="chip chip-tone-info">Draft</span> : null}
        {version.restoredFrom !== undefined ? (
          <span className="chip chip-outline">基于修订 {version.restoredFrom} 恢复</span>
        ) : null}
        <time className="muted">{formatDateTime(version.createdAt) ?? "—"}</time>
      </div>
      <div className="version-item-body">
        <span className="version-source">{sourceLabel}</span>
        {version.review !== null ? (
          <span className="muted">
            审稿第 {version.review.round} 轮：严重 {version.review.critical} / 主要 {version.review.major}
            {version.review.academicScore !== null ? ` · 学术 ${version.review.academicScore}` : ""}
          </span>
        ) : (
          <span className="muted">未审稿</span>
        )}
        {version.qualityGate !== null ? (
          <span
            className={`status status-tone-${version.qualityGate.passed ? "ok" : "danger"}`}
            data-testid="version-gate"
          >
            {version.qualityGate.passed ? (
              <>
                <Icon name="check-circle" />
                门禁通过
              </>
            ) : (
              <>
                <Icon name="alert-circle" />
                门禁未通过（{version.qualityGate.failedRuleIds.length} 项）
              </>
            )}
          </span>
        ) : version.review !== null ? (
          <span className="status status-tone-neutral">门禁未评估</span>
        ) : null}
        {iteration !== null ? (
          <span className={`status status-tone-${iteration.tone}`}>{iteration.label}</span>
        ) : null}
        {version.revisionPlan !== null ? (
          <span className="muted">
            修订计划 {version.revisionPlan.planId}（派发 {version.revisionPlan.planned} · 记录{" "}
            {version.revisionPlan.skipped}）
          </span>
        ) : null}
        {version.artifacts.map((artifact) => (
          <a
            key={artifact.artifactId}
            className="btn-link"
            href={artifactDownloadUrl(projectId, artifact.artifactId)}
            target="_blank"
            rel="noopener noreferrer"
          >
            查看 {artifact.kind === "final" ? "Final" : "Draft"}
          </a>
        ))}
      </div>
      {!version.isCurrent ? (
        <div className="version-item-actions">
          {confirming ? (
            <div className="version-restore-confirm" data-testid="version-restore-confirm">
              <p>
                将基于修订 {version.revision} 创建新的当前修订。现有版本历史不会被删除；旧 Final
                与产物保持不变。恢复后的版本需重新构建与审稿，才能再次标记 Final。
              </p>
              <div className="action-row">
                <button
                  type="button"
                  className="btn btn-primary btn-small"
                  data-testid="version-restore-confirm-button"
                  disabled={restore.isPending}
                  onClick={() => {
                    restore.mutate(version.revision, { onSuccess: () => setConfirming(false) });
                  }}
                >
                  {restore.isPending ? "恢复中…" : "创建新修订"}
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={restore.isPending}
                  onClick={() => setConfirming(false)}
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="btn-link"
              data-testid="version-restore-button"
              onClick={() => setConfirming(true)}
            >
              恢复此版本
            </button>
          )}
          {restore.isError ? (
            <p className="form-error" role="alert" data-testid="version-restore-error">
              {restoreErrorText(restore.error)}
            </p>
          ) : null}
          {restore.isSuccess && restore.data !== undefined ? (
            <p className="note note-success" role="status" data-testid="version-restore-success">
              <span>
                <span className="note-mark">✓</span> 已创建修订 {restore.data.revision}（基于修订{" "}
                {restore.data.restoredFrom}）。旧门禁与构建结论已过期：重新审稿并通过双门禁后才能再次标记
                Final。
              </span>
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Restore 拒绝的业务语义映射 */
function restoreErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "PROJECT_BUSY":
        return "项目有进行中的任务，任务结束后再恢复版本。";
      case "NOT_FOUND":
        return "该修订不存在（可能已被删除），请刷新版本历史。";
      default:
        return formatApiError(error);
    }
  }
  return formatApiError(error);
}
