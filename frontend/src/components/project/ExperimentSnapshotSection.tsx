import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ErrorState, Loading } from "../common/StateViews.js";
import {
  decideExperimentFacts,
  freezeExperimentSnapshot,
  getActiveExperimentSnapshot,
  getSnapshotPreview,
  listExperimentSnapshots,
  type DerivedQuantityView,
  type ExperimentFactView,
  type FactComparisonView,
} from "../../api/experimentPackages.js";
import { formatApiError } from "../../utils/errors.js";

/**
 * M17.2 实验事实快照：把已确认 + 已授权的实验观测冻结为版本化事实，写作 / 结果表 / 审查都只用当前快照。
 *
 * 只把真正需要作者判断的内容摆出来：冲突（双方来源并排，排除任一方 = 选择另一方）、不可比较的原因、需补的 metadata；
 * 无歧义的数据不要求逐格确认。对比数值是系统确定性复算（百分点与相对 % 分开），不展示任何置信度百分比。
 */

export const SNAPSHOT_QUERY_KEY = "experiment-snapshot";

const CONFLICT_LABEL: Record<string, string> = {
  SAME_KEY_DIFFERENT_VALUE: "同一实验量取值不同",
  VERSION_CONFLICT: "版本冲突",
  UNIT_SCALE_UNRESOLVED: "标度未确认（比例 / 百分数）",
  AGGREGATE_VS_RUN_MISMATCH: "汇总值与逐次运行不符",
};
const NOT_COMPARABLE_LABEL: Record<string, string> = {
  PROTOCOL_NOT_COMPARABLE: "数据集 / 划分 / 协议不同",
  MISSING_REQUIRED_METADATA: "缺少必要 metadata",
  UNIT_NOT_COMPARABLE: "单位量纲不同",
};
const OUTCOME_LABEL: Record<FactComparisonView["outcome"], string> = {
  subject_better: "前者更优",
  reference_better: "后者更优",
  tie_within_rounding: "舍入精度内无差异",
  direction_unknown: "方向未知（只报差值）",
};

function formatDerived(quantity: DerivedQuantityView | null): string {
  if (quantity === null) return "不可算";
  const text = `${quantity.value > 0 ? "+" : ""}${quantity.value.toFixed(quantity.displayDecimals)}`;
  if (quantity.unitLabel === "pp") return `${text} 个百分点`;
  if (quantity.unitLabel === "percent_relative") return `${text}%（相对）`;
  return `${text}${quantity.unitLabel === "count" ? "" : ` ${quantity.unitLabel}`}`;
}

export function ExperimentSnapshotSection({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const preview = useQuery({ queryKey: [SNAPSHOT_QUERY_KEY, projectId, "preview"], queryFn: () => getSnapshotPreview(projectId) });
  const active = useQuery({ queryKey: [SNAPSHOT_QUERY_KEY, projectId, "active"], queryFn: () => getActiveExperimentSnapshot(projectId) });
  const history = useQuery({ queryKey: [SNAPSHOT_QUERY_KEY, projectId, "list"], queryFn: () => listExperimentSnapshots(projectId) });
  const refresh = async () => { await queryClient.invalidateQueries({ queryKey: [SNAPSHOT_QUERY_KEY, projectId] }); };
  const decide = useMutation({
    mutationFn: (input: { exclude?: string[]; include?: string[]; reason?: string }) => decideExperimentFacts(projectId, input),
    onSuccess: async () => { setMessage("作者决定已记录（原始文件与审计轨迹不变）。"); await refresh(); },
  });
  const freeze = useMutation({
    mutationFn: () => freezeExperimentSnapshot(projectId, note.trim() !== "" ? note.trim() : undefined),
    onSuccess: async (snapshot) => {
      setNote("");
      setMessage(`已冻结实验事实快照 ${snapshot.snapshotId}（v${snapshot.version}）：后续写作、结果表与审查只使用该版本。`);
      await refresh();
    },
  });
  const factsById = new Map<string, ExperimentFactView>((preview.data?.facts ?? []).map((fact) => [fact.factId, fact]));
  const current = active.data;

  return (
    <section className="panel experiment-step" aria-label="实验事实快照">
      <h3>实验事实快照（写作使用的冻结版本）</h3>
      {active.isPending ? <Loading label="加载当前快照…" /> : active.isError ? (
        <ErrorState title="当前快照加载失败" message={formatApiError(active.error)} onRetry={() => void active.refetch()} />
      ) : current === null || current === undefined ? (
        <p className="muted" data-testid="snapshot-none">
          尚未冻结快照：写作暂按实时授权数据（不含确定性对比）。建议核对后冻结，让写作、结果表与审查使用同一版本。
        </p>
      ) : (
        <div data-testid="snapshot-active" className={current.status === "stale" ? "note-warn-line" : undefined}>
          <p>
            当前快照 <code>{current.snapshot.snapshotId}</code>（v{current.snapshot.version} · 内容哈希 <code>{current.snapshot.contentHash.slice(0, 12)}</code> · {current.snapshot.factCount} 条事实 · {current.snapshot.comparisonCount} 条确定性对比）·{" "}
            <strong>{current.status === "valid" ? "有效" : "已失效"}</strong>
          </p>
          {current.status === "stale" && (
            <ul role="alert">
              {(current.staleReasons ?? []).map((reason, index) => <li key={index}>{reason}</li>)}
              <li>失效期间写作不会使用任何实验数值，也不会悄悄改用新数据；请核对后重新冻结。</li>
            </ul>
          )}
        </div>
      )}

      {preview.isPending ? <Loading label="计算待冻结内容…" /> : preview.isError ? (
        <ErrorState title="快照预览失败" message={formatApiError(preview.error)} onRetry={() => void preview.refetch()} />
      ) : preview.data !== undefined && (
        <>
          <p className="muted" data-testid="snapshot-preview-summary">
            待冻结：{preview.data.factCount} 条已确认 + 已授权事实 · {preview.data.comparisonCount} 条确定性对比 · {preview.data.conflicts.length} 处冲突 · {preview.data.notComparable.length} 对不可比较 · 作者已排除 {preview.data.excluded.length} 条
          </p>
          {preview.data.conflicts.length > 0 && (
            <div data-testid="snapshot-conflicts">
              <h4>需要作者裁决的冲突（未裁决不能冻结）</h4>
              {preview.data.conflicts.map((conflict) => (
                <div key={conflict.conflictId} className="details-block">
                  <p><strong>{CONFLICT_LABEL[conflict.code] ?? conflict.code}</strong>：{conflict.detail}</p>
                  <table className="data-table">
                    <thead><tr><th>原始值</th><th>单位</th><th>版本</th><th>来源定位</th><th aria-label="操作" /></tr></thead>
                    <tbody>
                      {conflict.sides.map((side) => (
                        <tr key={side.factId}>
                          <td><code>{side.rawText ?? side.value}</code></td>
                          <td>{side.unit === "unknown" ? "未声明" : side.unit}</td>
                          <td>{side.version ?? "—"}</td>
                          <td><small>{side.sourceLocator}</small></td>
                          <td>
                            <button type="button" className="btn btn-small" disabled={decide.isPending} onClick={() => decide.mutate({ exclude: [side.factId], reason: `作者在冲突 ${conflict.conflictId} 中排除该值` })}>
                              排除此值
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {conflict.code === "UNIT_SCALE_UNRESOLVED" && <p className="muted">标度冲突更常见的解法是在下方「文件清单 → 补充实验 metadata」中声明单位（ratio / percentage），而不是排除数据。</p>}
                </div>
              ))}
            </div>
          )}
          {preview.data.excluded.length > 0 && (
            <details className="details-block">
              <summary>作者已排除的事实（{preview.data.excluded.length}）</summary>
              <ul>
                {preview.data.excluded.map((entry) => (
                  <li key={entry.factId}>
                    <code>{entry.factId}</code> · {entry.reason}{" "}
                    <button type="button" className="btn btn-small" disabled={decide.isPending} onClick={() => decide.mutate({ include: [entry.factId], reason: "作者恢复" })}>恢复</button>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {preview.data.comparisons.length > 0 && (
            <details className="details-block" open>
              <summary>确定性对比（系统复算；百分点与相对 % 分开）</summary>
              <div style={{ overflowX: "auto" }}>
                <table className="data-table" data-testid="snapshot-comparisons">
                  <thead><tr><th>数据集 / 协议</th><th>指标</th><th>对比</th><th>绝对差</th><th>相对变化</th><th>结论</th><th>来源</th></tr></thead>
                  <tbody>
                    {preview.data.comparisons.slice(0, 60).map((comparison) => (
                      <tr key={comparison.comparisonId}>
                        <td>{comparison.context.dataset}{comparison.context.split ? ` / ${comparison.context.split}` : ""} · {comparison.context.protocol}{comparison.context.subset ? ` · ${comparison.context.subset}` : ""}</td>
                        <td>{comparison.context.metricKey}</td>
                        <td>{comparison.subject.method} {comparison.subject.value} 对 {comparison.reference.method} {comparison.reference.value}{comparison.kind === "ablation_vs_main" ? "（消融）" : ""}</td>
                        <td>{formatDerived(comparison.absoluteDifference)}</td>
                        <td>{comparison.relativeChange === null ? (comparison.relativeChangeUnavailable ?? "不可算") : formatDerived(comparison.relativeChange)}</td>
                        <td>{OUTCOME_LABEL[comparison.outcome]}</td>
                        <td>
                          <details>
                            <summary>溯源</summary>
                            <small>
                              {comparison.operandRefs.map((id) => <span key={id}>{factsById.get(id)?.sourceLocator ?? id}（原文 {factsById.get(id)?.rawText ?? "?"}）<br /></span>)}
                              公式 {comparison.absoluteDifference.formulaText}
                            </small>
                          </details>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          {preview.data.notComparable.length > 0 && (
            <details className="details-block">
              <summary>不可比较（{preview.data.notComparable.length}；只展示原始数值，不生成提升幅度）</summary>
              <ul>
                {preview.data.notComparable.slice(0, 30).map((entry, index) => (
                  <li key={index}>{NOT_COMPARABLE_LABEL[entry.code] ?? entry.code} · {entry.metricKey}：{entry.detail}</li>
                ))}
              </ul>
            </details>
          )}
          {preview.data.limitations.length > 0 && (
            <ul className="muted">
              {preview.data.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}
            </ul>
          )}
          <div className="form-row">
            <label>
              冻结备注（可选）
              <input aria-label="快照备注" value={note} maxLength={300} onChange={(event) => setNote(event.target.value)} />
            </label>
            <button type="button" disabled={!preview.data.freezable || freeze.isPending} onClick={() => freeze.mutate()}>
              {freeze.isPending ? "冻结中…" : "冻结为新版本快照"}
            </button>
          </div>
          {!preview.data.freezable && (
            <ul className="run-error" data-testid="snapshot-blocking">
              {preview.data.blockingReasons.map((reason, index) => <li key={index}>{reason}</li>)}
            </ul>
          )}
        </>
      )}
      {(decide.isError || freeze.isError) && <p role="alert" className="run-error">{formatApiError(decide.error ?? freeze.error)}</p>}
      {message && <p role="status">{message}</p>}
      {history.data !== undefined && history.data.length > 0 && (
        <details className="details-block">
          <summary>快照版本历史（{history.data.length}）</summary>
          <ul>
            {history.data.map((entry) => (
              <li key={entry.snapshotId}>
                <code>{entry.snapshotId}</code> v{entry.version} · {entry.createdAt} · 哈希 <code>{entry.contentHash.slice(0, 12)}</code> · {entry.factCount} 条事实 · {entry.comparisonCount} 条对比{entry.active ? " · 当前" : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
