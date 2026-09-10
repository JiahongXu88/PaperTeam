import { useState } from "react";

import { ErrorState, Loading } from "../common/StateViews.js";
import { Icon } from "../common/Icon.js";
import {
  ITERATION_OUTCOME_STYLES,
  statusStyleOf,
} from "../common/status.js";
import {
  artifactDownloadUrl,
  getBuildLog,
} from "../../api/artifacts.js";
import {
  queryKeys,
  useArtifacts,
  useBuildStatus,
  useFinalizeProject,
  useIterations,
  useRunBuild,
} from "../../hooks/queries.js";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../../api/client.js";
import { formatApiError } from "../../utils/errors.js";
import { formatBytes, formatDateTime, formatDurationMs } from "../../utils/format.js";
import type {
  BuildGateRecordView,
  PaperArtifactView,
  RevisionIterationView,
} from "../../types/api.js";

/**
 * 论文产出面板（M4.7）：Draft / Final 产物 + 构建状态 + 修订迭代历史。
 *
 * 语义纪律（PRD / D-0015 / D-0026）：
 * - Draft 只看 Build Gate（质量门禁不阻塞构建）；
 * - Final 的资格判定 100% 在 Backend（FinalizeService 确定性校验）——前端
 *   不自己组合 buildOk && qualityOk 产生任何 Final 状态，按钮永远可请求，
 *   拒绝原因如实展示（「当前版本可以作为 Draft，但尚未满足 Final 要求」）；
 * - Final 冻结后不可变：后续修订产生新条目，历史条目仍可查看 / 下载。
 */

/** 查看 PDF：新标签页交给浏览器原生 viewer（不先落盘再打开） */
function openArtifactPdf(projectId: string, artifactId: string): void {
  window.open(artifactDownloadUrl(projectId, artifactId), "_blank", "noopener,noreferrer");
}

/** 下载 PDF：attachment 头由后端下发，前端只触发导航 */
function downloadArtifactPdf(projectId: string, artifactId: string, fileName: string): void {
  const anchor = document.createElement("a");
  anchor.href = artifactDownloadUrl(projectId, artifactId, "attachment");
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function PaperPanel({ projectId }: { projectId: string }) {
  const artifacts = useArtifacts(projectId);
  const finalize = useFinalizeProject(projectId);

  if (artifacts.isPending) {
    return <Loading label="加载论文产出…" />;
  }
  if (artifacts.isError) {
    return (
      <ErrorState
        title="论文产出加载失败"
        message={formatApiError(artifacts.error)}
        onRetry={() => void artifacts.refetch()}
      />
    );
  }

  const data = artifacts.data;
  const hasAnyArtifact = data.artifacts.length > 0;

  return (
    <div className="panel-stack" data-testid="paper-panel">
      <section className="panel section-block" data-testid="artifact-summary">
        <div className="section-head">
          <h2>论文产出</h2>
        </div>

        {!hasAnyArtifact ? (
          <div className="state-block state-empty" data-testid="artifact-empty">
            <strong>还没有可用的论文 PDF</strong>
            <span>工作流推进到「构建论文」阶段会自动编译并产出 Draft；也可以在下方手动构建。</span>
          </div>
        ) : (
          <>
            <div className="artifact-grid">
              <FinalCard
                projectId={projectId}
                latestFinal={data.latestFinal}
                finalUpToDate={data.finalUpToDate}
                currentRevision={data.currentRevision}
              />
              <DraftCard projectId={projectId} latestDraft={data.latestDraft} hasFinal={data.latestFinal !== null} />
            </div>
            <ArtifactHistory
              projectId={projectId}
              artifacts={data.artifacts}
              latestDraftId={data.latestDraft?.artifactId}
              latestFinalId={data.latestFinal?.artifactId}
            />
          </>
        )}

        <FinalizeAction
          pending={finalize.isPending}
          error={finalize.isError ? formatApiError(finalize.error) : null}
          errorCode={finalize.error instanceof ApiError ? finalize.error.code : undefined}
          onFinalize={() => finalize.mutate()}
          finalRevision={finalize.data?.final.revision}
        />
      </section>

      <BuildStatusCard projectId={projectId} />
      <IterationsCard projectId={projectId} />
    </div>
  );
}

// ---- Final / Draft 卡片 ----

function FinalCard({
  projectId,
  latestFinal,
  finalUpToDate,
  currentRevision,
}: {
  projectId: string;
  latestFinal: PaperArtifactView | null;
  finalUpToDate: boolean;
  currentRevision: number;
}) {
  if (latestFinal === null) {
    return (
      <div className="artifact-card artifact-card-empty" data-testid="final-card">
        <div className="artifact-card-head">
          <h3>Final</h3>
          <span className="status status-tone-neutral">尚未冻结</span>
        </div>
        <p className="artifact-card-note">
          Final 需要构建门禁与质量门禁都通过（后端确定性判定）。当前版本可以作为
          Draft，但尚未满足 Final 要求。
        </p>
      </div>
    );
  }
  return (
    <div className="artifact-card" data-testid="final-card">
      <div className="artifact-card-head">
        <h3>Final</h3>
        <span className="status status-tone-ok">
          <Icon name="check-circle" />
          已冻结
        </span>
      </div>
      <dl className="kv artifact-meta">
        <div className="kv-row">
          <dt>对应修订</dt>
          <dd>
            rev {latestFinal.revision}
            {!finalUpToDate ? `（当前 rev ${currentRevision}，已有更新修订）` : "（对齐当前修订）"}
          </dd>
        </div>
        <div className="kv-row">
          <dt>冻结时间</dt>
          <dd>{formatDateTime(latestFinal.createdAt) ?? "—"}</dd>
        </div>
        {latestFinal.qualityGate !== undefined ? (
          <div className="kv-row">
            <dt>质量门禁</dt>
            <dd>第 {latestFinal.qualityGate.round} 轮通过</dd>
          </div>
        ) : null}
        <div className="kv-row">
          <dt>文件</dt>
          <dd className="mono">
            {latestFinal.file.name} · {formatBytes(latestFinal.file.bytes)}
          </dd>
        </div>
      </dl>
      {!finalUpToDate ? (
        <p className="note note-warn" role="status" data-testid="final-stale">
          <span>冻结后又有了新修订：这份 Final 保持不变；新修订需复审并通过双门禁后，才能冻结新的 Final。</span>
        </p>
      ) : null}
      <div className="artifact-actions">
        <button
          type="button"
          className="btn btn-small btn-primary"
          data-testid="final-view"
          onClick={() => openArtifactPdf(projectId, latestFinal.artifactId)}
        >
          <Icon name="file-pdf" />
          查看 PDF
        </button>
        <button
          type="button"
          className="btn btn-small"
          data-testid="final-download"
          onClick={() => downloadArtifactPdf(projectId, latestFinal.artifactId, latestFinal.file.name)}
        >
          <Icon name="download" />
          下载
        </button>
      </div>
    </div>
  );
}

function DraftCard({
  projectId,
  latestDraft,
  hasFinal,
}: {
  projectId: string;
  latestDraft: PaperArtifactView | null;
  hasFinal: boolean;
}) {
  if (latestDraft === null) {
    return (
      <div className="artifact-card artifact-card-empty" data-testid="draft-card">
        <div className="artifact-card-head">
          <h3>Draft</h3>
          <span className="status status-tone-neutral">尚无 PDF</span>
        </div>
        <p className="artifact-card-note">
          Draft 只需要构建门禁（LaTeX 编译）通过。质量门禁未通过不影响产出 Draft PDF。
        </p>
      </div>
    );
  }
  return (
    <div className="artifact-card" data-testid="draft-card">
      <div className="artifact-card-head">
        <h3>Draft</h3>
        <span className="status status-tone-info">可用</span>
      </div>
      <dl className="kv artifact-meta">
        <div className="kv-row">
          <dt>对应修订</dt>
          <dd>rev {latestDraft.revision}</dd>
        </div>
        <div className="kv-row">
          <dt>产出时间</dt>
          <dd>{formatDateTime(latestDraft.createdAt) ?? "—"}</dd>
        </div>
        <div className="kv-row">
          <dt>文件</dt>
          <dd className="mono">
            {latestDraft.file.name} · {formatBytes(latestDraft.file.bytes)}
          </dd>
        </div>
      </dl>
      {!hasFinal ? (
        <p className="artifact-card-note">
          当前版本可以作为 Draft，但尚未满足 Final 要求。
        </p>
      ) : null}
      <div className="artifact-actions">
        <button
          type="button"
          className="btn btn-small btn-primary"
          data-testid="draft-view"
          onClick={() => openArtifactPdf(projectId, latestDraft.artifactId)}
        >
          <Icon name="file-pdf" />
          查看 PDF
        </button>
        <button
          type="button"
          className="btn btn-small"
          data-testid="draft-download"
          onClick={() => downloadArtifactPdf(projectId, latestDraft.artifactId, latestDraft.file.name)}
        >
          <Icon name="download" />
          下载
        </button>
      </div>
    </div>
  );
}

/** 产物历史（不可变清单：每次冻结追加，旧条目永不改写） */
function ArtifactHistory({
  projectId,
  artifacts,
  latestDraftId,
  latestFinalId,
}: {
  projectId: string;
  artifacts: PaperArtifactView[];
  latestDraftId: string | undefined;
  latestFinalId: string | undefined;
}) {
  const history = [...artifacts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <details className="details-block artifact-history" data-testid="artifact-history">
      <summary>
        全部产物（{history.length} 个，按冻结时间排列；历史版本不可变）
      </summary>
      <div className="details-body">
        <ul className="artifact-history-list">
          {history.map((artifact) => (
            <li key={artifact.artifactId} className="artifact-history-item">
              <span className={`chip chip-tone-${artifact.kind === "final" ? "ok" : "info"}`}>
                {artifact.kind === "final" ? "Final" : "Draft"}
              </span>
              <span className="mono artifact-history-id">{artifact.artifactId}</span>
              <span className="muted">
                rev {artifact.revision} · {formatDateTime(artifact.createdAt) ?? "—"} ·{" "}
                {formatBytes(artifact.file.bytes)}
              </span>
              {artifact.artifactId === latestFinalId || artifact.artifactId === latestDraftId ? (
                <span className="chip chip-outline">最新</span>
              ) : null}
              <button
                type="button"
                className="btn-link"
                onClick={() => openArtifactPdf(projectId, artifact.artifactId)}
              >
                查看
              </button>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

/** 标记 Final：按钮永远可请求，资格由后端确定性判定（拒绝如实展示） */
function FinalizeAction({
  pending,
  error,
  errorCode,
  onFinalize,
  finalRevision,
}: {
  pending: boolean;
  error: string | null;
  errorCode: string | undefined;
  onFinalize: () => void;
  finalRevision: number | undefined;
}) {
  return (
    <div className="finalize-row" data-testid="finalize-action">
      <button type="button" className="btn btn-primary" data-testid="finalize-button" disabled={pending} onClick={onFinalize}>
        <Icon name="check-circle" />
        {pending ? "正在标记 Final…" : "标记为 Final"}
      </button>
      <span className="field-help">
        纯确定性操作：后端校验构建门禁 + 质量门禁都通过且对齐当前修订，才会冻结 Final。
      </span>
      {finalRevision !== undefined ? (
        <p className="note note-success" role="status" data-testid="finalize-success">
          <span>
            <span className="note-mark">✓</span> Final 已冻结（修订 rev {finalRevision}），可在上方查看 / 下载。
          </span>
        </p>
      ) : null}
      {error !== null ? <p className="form-error" role="alert" data-testid="finalize-error">{finalizeErrorText(errorCode, error)}</p> : null}
    </div>
  );
}

/** Finalize 拒绝的业务语义映射（后端 code → 用户能行动的中文说明） */
function finalizeErrorText(code: string | undefined, fallback: string): string {
  switch (code) {
    case "QUALITY_GATE_FAILED":
      return "尚未满足 Final 要求：质量门禁未通过。当前版本可以作为 Draft；处理审稿问题并复审通过后即可标记 Final。";
    case "QUALITY_GATE_STALE":
      return "修订后的审稿结论尚未更新：请先重新审稿（或运行工作流到 Quality Gate 阶段），再标记 Final。";
    case "BUILD_GATE_FAILED":
      return "构建未通过：需先修复编译错误并成功构建，才能标记 Final。";
    case "BUILD_GATE_STALE":
      return "构建结果已过期（修订后未重新构建）：请先在下方重新构建，再标记 Final。";
    case "PROJECT_BUSY":
      return "项目有进行中的任务，任务结束后再标记 Final。";
    default:
      return fallback;
  }
}

// ---- 构建状态卡片 ----

function BuildStatusCard({ projectId }: { projectId: string }) {
  const status = useBuildStatus(projectId);
  const build = useRunBuild(projectId);
  const [logOpen, setLogOpen] = useState(false);
  const log = useQuery({
    queryKey: queryKeys.buildLog(projectId),
    queryFn: ({ signal }) => getBuildLog(projectId, signal),
    enabled: logOpen,
  });

  if (status.isPending) {
    return (
      <section className="panel section-block" data-testid="build-status">
        <div className="section-head">
          <h2>构建状态</h2>
        </div>
        <Loading label="加载构建状态…" />
      </section>
    );
  }
  if (status.isError) {
    return (
      <section className="panel section-block" data-testid="build-status">
        <div className="section-head">
          <h2>构建状态</h2>
        </div>
        <ErrorState title="构建状态加载失败" message={formatApiError(status.error)} onRetry={() => void status.refetch()} />
      </section>
    );
  }

  const record: BuildGateRecordView | null = status.data.build;

  return (
    <section className="panel section-block" id="build-status-panel" data-testid="build-status">
      <div className="section-head">
        <h2>构建状态</h2>
        {record !== null ? (
          <span className={`status status-tone-${record.passed ? "ok" : "danger"}`} data-testid="build-outcome">
            {record.passed ? <Icon name="check-circle" /> : <Icon name="alert-circle" />}
            {record.passed ? "构建通过" : "构建失败"}
          </span>
        ) : null}
      </div>

      {record === null ? (
        <p className="panel-empty" data-testid="build-empty">
          尚未构建过。工作流到「构建论文」阶段会自动编译；也可以手动触发一次构建。
        </p>
      ) : (
        <>
          <dl className="kv" data-testid="build-meta">
            <div className="kv-row">
              <dt>编译工具</dt>
              <dd className="mono">
                {record.compile.tool}
                {record.compile.durationMs > 0 && formatDurationMs(record.compile.durationMs) !== undefined
                  ? ` · 耗时 ${formatDurationMs(record.compile.durationMs)}`
                  : ""}
              </dd>
            </div>
            <div className="kv-row">
              <dt>构建基于修订</dt>
              <dd>
                rev {record.revision}
                {status.data.stale ? (
                  <span className="chip chip-tone-warn" data-testid="build-stale" style={{ marginLeft: "var(--s-2)" }}>
                    已过期（当前 rev {status.data.currentRevision}）
                  </span>
                ) : (
                  <span className="chip chip-tone-ok" style={{ marginLeft: "var(--s-2)" }}>
                    对齐当前修订
                  </span>
                )}
              </dd>
            </div>
            <div className="kv-row">
              <dt>评估时间</dt>
              <dd>{formatDateTime(record.checkedAt) ?? "—"}</dd>
            </div>
          </dl>

          {status.data.stale ? (
            <p className="note note-warn" role="status">
              <span>修订后又没有重新编译：构建结论基于旧版本。重新构建后 Draft / Final 才能对齐当前修订。</span>
            </p>
          ) : null}

          {!record.passed ? <BuildDiagnostics record={record} /> : null}
        </>
      )}

      <div className="build-actions">
        <button type="button" className="btn" data-testid="build-run" disabled={build.isPending} onClick={() => build.mutate()}>
          <Icon name="refresh" />
          {build.isPending ? "构建中…" : record === null ? "构建论文" : "重新构建"}
        </button>
        <button
          type="button"
          className="btn-link"
          aria-expanded={logOpen}
          data-testid="build-log-toggle"
          onClick={() => setLogOpen(!logOpen)}
        >
          {logOpen ? "收起编译日志" : "展开编译日志"}
        </button>
      </div>
      {build.isError ? (
        <p className="form-error" role="alert" data-testid="build-error">
          构建失败：{formatApiError(build.error)}
        </p>
      ) : null}
      {build.data !== undefined && !build.data.build.passed ? (
        <p className="form-error" role="alert" data-testid="build-failed-note">
          本次构建未通过（{build.data.build.reasons[0] ?? "编译失败"}）；诊断见上方，完整日志见编译日志。
        </p>
      ) : null}

      {logOpen ? (
        log.isPending ? (
          <Loading label="加载编译日志…" />
        ) : log.isError ? (
          <p className="form-error">编译日志加载失败：{formatApiError(log.error)}</p>
        ) : (
          <details className="details-block build-log" open data-testid="build-log">
            <summary>compile.log（尾部）</summary>
            <pre className="details-body mono build-log-body">{log.data?.log === "" ? "（暂无日志）" : log.data?.log}</pre>
          </details>
        )
      ) : null}
    </section>
  );
}

/** 结构化编译诊断（文件 / 行号 / 错误 / 附近行；Writer 修复循环同源数据） */
function BuildDiagnostics({ record }: { record: BuildGateRecordView }) {
  if (record.diagnostics.length === 0) {
    return (
      <div className="gate-blockers" data-testid="build-reasons">
        <h3>构建未通过的原因</h3>
        <ol className="gate-blocker-list">
          {record.reasons.map((reason, index) => (
            <li key={index} className="gate-blocker">
              <div className="gate-blocker-main">
                <span className="gate-blocker-detail">{reason}</span>
              </div>
            </li>
          ))}
        </ol>
        {record.compile.error !== undefined ? (
          <p className="gate-blocker-detail mono">{record.compile.error}</p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="gate-blockers" data-testid="build-diagnostics">
      <h3>编译诊断（{record.diagnostics.length} 条）</h3>
      <ol className="gate-blocker-list">
        {record.diagnostics.map((diagnostic, index) => (
          <li key={index} className="gate-blocker">
            <div className="gate-blocker-main">
              <strong className="mono">
                {diagnostic.file ?? "(未知文件)"}
                {diagnostic.line !== null ? `:${diagnostic.line}` : ""}
              </strong>
              <span className="gate-blocker-detail">{diagnostic.message}</span>
              {diagnostic.contextLines.length > 0 ? (
                <pre className="build-diagnostic-context mono">{diagnostic.contextLines.join("\n")}</pre>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---- 修订迭代历史 ----

function IterationsCard({ projectId }: { projectId: string }) {
  const iterations = useIterations(projectId);
  if (iterations.isPending) {
    return null;
  }
  if (iterations.isError) {
    return null; // 迭代历史是辅助信息：失败不打断主面板（构建卡片已有重试入口）
  }
  const records = iterations.data;
  if (records.length === 0) {
    return null;
  }
  const reversed = [...records].reverse();
  return (
    <section className="panel section-block" data-testid="iterations-card">
      <div className="section-head">
        <h2>修订迭代</h2>
        <span className="faint">每轮修订后的审稿对比（确定性收敛判定，不使用模型自评）</span>
      </div>
      <ol className="iteration-list">
        {reversed.map((record) => (
          <IterationRow key={`${record.gateRound}-${record.revision}`} record={record} />
        ))}
      </ol>
    </section>
  );
}

function IterationRow({ record }: { record: RevisionIterationView }) {
  const outcome = statusStyleOf(ITERATION_OUTCOME_STYLES, record.outcome ?? undefined, "首轮");
  const card = record.scorecard;
  return (
    <li className={`iteration-item iteration-tone-${outcome.tone}`} data-testid="iteration-item">
      <div className="iteration-head">
        <span className="iteration-round">第 {record.gateRound} 轮</span>
        <span className={`status status-tone-${outcome.tone}`} data-testid="iteration-outcome">
          {outcome.label}
        </span>
        <span className="muted iteration-meta">
          rev {record.revision} · {formatDateTime(record.completedAt) ?? "—"}
          {record.planId !== undefined ? ` · 计划 ${record.planId}` : ""}
        </span>
      </div>
      <div className="iteration-scorecard">
        <span>{card.gatePassed ? "门禁通过" : `未过规则 ${card.failedRuleIds.length} 项`}</span>
        <span>严重 {card.critical} / 主要 {card.major} / 阻断 {card.blocking}</span>
        {card.academicScore !== null ? <span>学术评分 {card.academicScore}</span> : null}
        {card.styleRisk !== null ? <span>文风风险 {card.styleRisk}</span> : null}
      </div>
    </li>
  );
}
