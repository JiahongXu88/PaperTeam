import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ErrorState, Loading } from "../common/StateViews.js";
import {
  confirmMethodFacts,
  getMethodFacts,
  revokeMethodFacts,
  type ComponentStatusView,
  type MethodFactInputView,
  type MethodFactStateView,
} from "../../api/experimentPackages.js";
import { formatApiError } from "../../utils/errors.js";

/**
 * M17.2.1 作者确认的研究方法事实：参数取值（符号 / 数值 / 适用配置）与组件状态（启用 / 已移除 / 拟议 / 未知）。
 *
 * 只有作者在这里确认的事实会约束大纲、写作、审稿与修订；从研究想法原文抽取的只是候选，需要作者逐条核对后确认。
 * 确认后若修改研究想法或撤销，事实立即失效，系统不会继续使用旧事实。
 */

export const METHOD_FACTS_QUERY_KEY = "method-facts";

const STATUS_LABEL: Record<ComponentStatusView, string> = {
  ACTIVE: "启用（当前方法包含）",
  REMOVED: "已移除（当前方法不包含）",
  PROPOSED: "拟议（尚未实现）",
  UNKNOWN: "未知（待确认）",
};

interface Row {
  key: string;
  factKind: "parameter" | "component";
  subject: string;
  valueText: string;
  status: ComponentStatusView;
  scope: string;
  aliases: string;
}

let rowCounter = 0;
const newRow = (partial: Partial<Row>): Row => ({ key: `r${rowCounter++}`, factKind: "parameter", subject: "", valueText: "", status: "UNKNOWN", scope: "", aliases: "", ...partial });

function rowsFromState(state: MethodFactStateView): Row[] {
  if (state.status === "valid") {
    return state.sheet.facts.map((fact) => newRow({
      factKind: fact.factKind, subject: fact.subject, valueText: fact.valueText ?? "", status: fact.status ?? "UNKNOWN", scope: fact.scope.join(", "), aliases: fact.aliases.join(", "),
    }));
  }
  return state.candidates.map((candidate) => newRow({
    factKind: candidate.factKind, subject: candidate.subject, valueText: candidate.valueText ?? "", status: candidate.status ?? "UNKNOWN",
  }));
}

const split = (text: string) => text.split(/[,，、]/).map((entry) => entry.trim()).filter((entry) => entry !== "");

export function MethodFactsSection({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: [METHOD_FACTS_QUERY_KEY, projectId], queryFn: () => getMethodFacts(projectId) });
  const [rows, setRows] = useState<Row[] | null>(null);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const refresh = async () => { setRows(null); await queryClient.invalidateQueries({ queryKey: [METHOD_FACTS_QUERY_KEY, projectId] }); };
  const confirm = useMutation({
    mutationFn: (facts: MethodFactInputView[]) => confirmMethodFacts(projectId, { facts }),
    onSuccess: async (next) => { setMessage(next.status === "valid" ? `已确认方法事实 ${next.sheet.sheetId}（v${next.sheet.version}）：后续大纲、写作、审稿与修订以此为准。` : "已提交"); await refresh(); },
  });
  const revoke = useMutation({
    mutationFn: () => revokeMethodFacts(projectId, reason.trim()),
    onSuccess: async () => { setReason(""); setMessage("已撤销：撤销后的事实不再支撑任何稿件表述，请重新确认。"); await refresh(); },
  });

  if (state.isPending) return <Loading label="加载方法事实…" />;
  if (state.isError) return <ErrorState title="方法事实加载失败" message={formatApiError(state.error)} onRetry={() => void state.refetch()} />;
  const current = state.data;
  const editing = rows ?? rowsFromState(current);
  const update = (key: string, patch: Partial<Row>) => setRows(editing.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const submit = () => confirm.mutate(editing.filter((row) => row.subject.trim() !== "").map((row): MethodFactInputView => ({
    factKind: row.factKind, subject: row.subject.trim(),
    ...(row.factKind === "parameter" ? { valueText: row.valueText.trim() } : { status: row.status }),
    ...(split(row.scope).length > 0 ? { scope: split(row.scope) } : {}),
    ...(split(row.aliases).length > 0 ? { aliases: split(row.aliases) } : {}),
    sourceLocator: current.status === "valid" ? "author:method-facts-form" : "project.researchIdea + author:method-facts-form",
  })));

  return (
    <section className="panel experiment-step" aria-label="研究方法事实">
      <h3>研究方法事实（作者确认）</h3>
      <p className="muted">
        参数取值与组件状态（如某模块已去掉）是方法节的权威事实：只有你在这里确认的内容会约束写作与审稿；配置名中的数字不会被当作参数取值。
      </p>
      {current.status === "none" ? (
        <p className="muted" data-testid="method-facts-none">尚未确认方法事实。{current.candidates.length > 0 ? `下表预填了从研究想法原文抽取的 ${current.candidates.length} 条候选（未经确认），请逐条核对。` : "可在下表登记。"}</p>
      ) : (
        <div data-testid="method-facts-active" className={current.status !== "valid" ? "note-warn-line" : undefined}>
          <p>
            当前事实表 <code>{current.sheet.sheetId}</code>（v{current.sheet.version} · 内容哈希 <code>{current.sheet.contentHash.slice(0, 12)}</code> · {current.sheet.facts.length} 条）·{" "}
            <strong>{current.status === "valid" ? "有效" : current.status === "revoked" ? "已撤销" : "已失效"}</strong>
          </p>
          {current.status !== "valid" && (
            <ul role="alert">
              {current.reasons.map((entry, index) => <li key={index}>{entry}</li>)}
              <li>失效期间写作不得写入具体方法参数，审稿不会据此判定通过；请核对后重新确认。</li>
            </ul>
          )}
        </div>
      )}

      <table className="data-table" data-testid="method-facts-editor">
        <thead><tr><th>类型</th><th>符号 / 组件名</th><th>取值 / 状态</th><th>适用配置（逗号分隔，可空）</th><th>其他写法（逗号分隔）</th><th aria-label="操作" /></tr></thead>
        <tbody>
          {editing.map((row) => (
            <tr key={row.key}>
              <td>
                <select aria-label="事实类型" value={row.factKind} onChange={(event) => update(row.key, { factKind: event.target.value as Row["factKind"] })}>
                  <option value="parameter">参数</option>
                  <option value="component">组件</option>
                </select>
              </td>
              <td><input aria-label="符号或组件名" value={row.subject} onChange={(event) => update(row.key, { subject: event.target.value })} /></td>
              <td>
                {row.factKind === "parameter" ? (
                  <input aria-label="参数取值" value={row.valueText} onChange={(event) => update(row.key, { valueText: event.target.value })} />
                ) : (
                  <select aria-label="组件状态" value={row.status} onChange={(event) => update(row.key, { status: event.target.value as ComponentStatusView })}>
                    {(Object.keys(STATUS_LABEL) as ComponentStatusView[]).map((status) => <option key={status} value={status}>{STATUS_LABEL[status]}</option>)}
                  </select>
                )}
              </td>
              <td><input aria-label="适用配置" value={row.scope} onChange={(event) => update(row.key, { scope: event.target.value })} /></td>
              <td><input aria-label="其他写法" value={row.aliases} onChange={(event) => update(row.key, { aliases: event.target.value })} /></td>
              <td><button type="button" className="btn btn-small" onClick={() => setRows(editing.filter((entry) => entry.key !== row.key))}>删除</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="btn-row">
        <button type="button" className="btn btn-small" onClick={() => setRows([...editing, newRow({ factKind: "parameter" })])}>添加参数</button>
        <button type="button" className="btn btn-small" onClick={() => setRows([...editing, newRow({ factKind: "component" })])}>添加组件</button>
        <button type="button" className="btn btn-primary" data-testid="method-facts-confirm" disabled={confirm.isPending || editing.every((row) => row.subject.trim() === "")} onClick={submit}>
          确认为作者方法事实
        </button>
      </div>
      {current.status === "valid" && (
        <div className="btn-row">
          <input aria-label="撤销原因" placeholder="撤销原因（如方法改版）" value={reason} onChange={(event) => setReason(event.target.value)} />
          <button type="button" className="btn btn-small" data-testid="method-facts-revoke" disabled={revoke.isPending || reason.trim() === ""} onClick={() => revoke.mutate()}>撤销当前事实</button>
        </div>
      )}
      {confirm.isError && <p role="alert" className="run-error">{formatApiError(confirm.error)}</p>}
      {revoke.isError && <p role="alert" className="run-error">{formatApiError(revoke.error)}</p>}
      {message !== "" && <p className="muted" data-testid="method-facts-message">{message}</p>}
    </section>
  );
}
