import { useState } from "react";

import type { StatusStyle } from "../common/status.js";
import { useDecideValueChangeRequests, useValueChangeRequests } from "../../hooks/queries.js";
import { formatApiError } from "../../utils/errors.js";
import type { QualityLayerIdView, QualityReportItemView, QualityReportView } from "../../types/qualityReport.js";

/**
 * M15 长程 B / D：分层质量报告（唯一决策事实源 quality-report/v1 的纯呈现，前端不重算）。
 *
 * 让作者一眼分清 Gate 不通过的原因属于哪一类：
 *   L1 已证实缺陷（确定性 / 作者数据复算 / 元数据）≠ L2 AI 审稿意见（未经核验）≠ L0 / L1 未评估（没验证）。
 * L4 恒为「未经独立校准」：任何文案都不宣称达到期刊水平或可投稿。
 */
const LAYER_STATUS_STYLES: Record<string, StatusStyle> = {
  PASS: { label: "通过", tone: "ok" },
  FAIL: { label: "未通过", tone: "danger" },
  NOT_EVALUATED: { label: "必需核验未完成", tone: "warn" },
  NOT_APPLICABLE: { label: "不适用", tone: "neutral" },
  NEEDS_VERIFICATION: { label: "AI 意见待核验", tone: "warn" },
  NEEDS_AUTHOR_DECISION: { label: "需作者裁决", tone: "accent" },
  UNVALIDATED: { label: "未经独立校准", tone: "neutral" },
};

const OVERALL_STYLES: Record<string, StatusStyle> = {
  PASS: { label: "完整性与已证实缺陷检查通过", tone: "ok" },
  FAIL: { label: "存在已证实缺陷或完整性失败", tone: "danger" },
  NOT_EVALUATED: { label: "必需核验未完成", tone: "warn" },
  NEEDS_VERIFICATION: { label: "AI 阻断意见待核验", tone: "warn" },
  NEEDS_AUTHOR_DECISION: { label: "需作者裁决", tone: "accent" },
};

const EVIDENCE_GRADE_LABELS: Record<string, string> = {
  deterministic: "确定性核验",
  author_data_recomputed: "作者数据复算",
  metadata_lookup: "文献元数据核验",
  verified_evidence: "已核验证据",
  llm_judgment: "模型判断（未核验）",
  uncalibrated_score: "未校准分数",
  edit_contract: "编辑契约",
  author_decision: "作者裁决",
  unclassified: "未分类",
};

const LAYERS: QualityLayerIdView[] = ["L0", "L1", "L2", "L3", "L4"];

function styleOf(registry: Record<string, StatusStyle>, key: string): StatusStyle {
  return registry[key] ?? { label: key, tone: "neutral" };
}

function itemNeedsAttention(item: QualityReportItemView): boolean {
  return item.status === "FAIL" || item.status === "NEEDS_VERIFICATION" || item.status === "NEEDS_AUTHOR_DECISION" || item.status === "NOT_EVALUATED";
}

const REVIEW_ARTICLE_TYPE_LABELS: Record<string, string> = { research: "研究论文", survey: "综述论文", thesis: "学位论文" };

export function QualityReportLayers({ report }: { report: QualityReportView }) {
  const overall = styleOf(OVERALL_STYLES, report.overall.status);
  return (
    <div className="quality-report" data-testid="quality-report" data-overall={report.overall.status}>
      <div className="quality-report-overall">
        <span className={`status status-tone-${overall.tone}`} data-testid="quality-report-overall">
          {overall.label}
        </span>
        <span className="quality-report-statement" data-testid="quality-report-statement">
          {report.overall.statement}
        </span>
        {report.binding.entry === "legacy_projection" ? (
          <span className="chip chip-tone-info" data-testid="quality-report-legacy">旧版产物投影（需重新评估）</span>
        ) : null}
      </div>
      {report.binding.reviewPolicy !== undefined ? (
        <p className="section-note" data-testid="quality-report-review-policy">
          审稿政策 {report.binding.reviewPolicy.policyVersion}（{REVIEW_ARTICLE_TYPE_LABELS[report.binding.reviewPolicy.articleType] ?? report.binding.reviewPolicy.articleType}）
          {report.binding.reviewPolicy.targetLabel !== null
            ? `：发表目标「${report.binding.reviewPolicy.targetLabel}」${report.binding.reviewPolicy.tierFactStatus === "JOURNAL_SELF_DECLARED" ? "（层级为期刊官方自述）" : report.binding.reviewPolicy.tierFactStatus === "USER_TARGET_UNVERIFIED" ? "（用户设定目标，未核实）" : ""}`
            : "：未设置发表目标（通用学术审稿）"}
          。发表目标只决定审稿关注点与建议排序；本报告不预测录用，也不证明稿件达到某分区 / 期刊的学术水平。
        </p>
      ) : null}
      <ol className="quality-report-layers">
        {LAYERS.map((id) => {
          const layer = report.layers[id];
          const style = styleOf(LAYER_STATUS_STYLES, layer.status);
          const attention = layer.items.filter(itemNeedsAttention);
          return (
            <li key={id} className="quality-report-layer" data-testid={`quality-layer-${id}`} data-status={layer.status}>
              <div className="quality-report-layer-head">
                <strong>
                  {id} · {layer.title}
                </strong>
                <span className={`status status-tone-${style.tone}`}>{style.label}</span>
              </div>
              {attention.length > 0 ? (
                <ul className="quality-report-items">
                  {attention.map((item) => (
                    <li key={item.id} data-testid="quality-report-item" data-item={item.id} data-item-status={item.status}>
                      <span className="chip">{EVIDENCE_GRADE_LABELS[item.evidenceGrade] ?? item.evidenceGrade}</span>{" "}
                      <span className={`status status-tone-${styleOf(LAYER_STATUS_STYLES, item.status).tone}`}>
                        {styleOf(LAYER_STATUS_STYLES, item.status).label}
                        {item.status === "NOT_EVALUATED" && !item.required ? "（不阻断）" : ""}
                      </span>{" "}
                      <span className="faint">{item.id}</span>：{item.detail}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="section-note faint" data-testid="quality-report-external-validity">
        {report.externalValidity.statement}（独立人类标签 {report.externalValidity.independentHumanLabels}）
      </p>
    </div>
  );
}

/**
 * M15 长程 A3（R4）/ D：审稿驱动修订改动作者冻结数值的逐项批准。每条显示旧值 → 新值与原句 / 建议句；
 * 批准请求携带所见内容哈希（服务端 409 拒绝陈旧 / 伪造）。不提供「全部批准」——每一项都是作者对科学事实的明确决定。
 */
export function ValueChangeRequestsPanel({ projectId }: { projectId: string }) {
  const requests = useValueChangeRequests(projectId);
  const decide = useDecideValueChangeRequests(projectId);
  const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({});
  const pending = (requests.data ?? []).filter((request) => request.status === "pending");
  const decided = (requests.data ?? []).filter((request) => request.status === "approved" || request.status === "rejected");
  if (requests.isPending || (pending.length === 0 && decided.length === 0)) return null;
  return (
    <div className="value-change-requests" data-testid="value-change-requests">
      <h3>待作者批准的数值修改（{pending.length}）</h3>
      <p className="faint">
        以下修改由审稿驱动的自动修订提出，会改动你原稿中的数值，已被编辑契约拦截、未写入稿件。只有你逐项批准的值对才会在下一轮修订中生效。
      </p>
      {decide.isError ? (
        <p className="form-error" role="alert" data-testid="value-change-error">
          决策失败：{formatApiError(decide.error)}
        </p>
      ) : null}
      <ul>
        {pending.map((request) => (
          <li key={request.requestId} data-testid="value-change-request" data-request={request.requestId}>
            <div>
              <strong>{request.target}</strong>：<code>{request.before}</code> → <code>{request.after === "" ? "（删除）" : request.after}</code>
            </div>
            <div className="faint">原句：{request.context}</div>
            {request.proposedContext !== "" ? <div className="faint">建议句：{request.proposedContext}</div> : null}
            <div className="faint">来源：{request.source.stageId} · {request.source.violation}</div>
            <label>
              <input
                type="checkbox"
                checked={acknowledged[request.requestId] === true}
                onChange={(event) => setAcknowledged((current) => ({ ...current, [request.requestId]: event.target.checked }))}
                data-testid="value-change-ack"
              />
              我已核对证据，确认把 {request.before} 改为 {request.after === "" ? "（删除）" : request.after}
            </label>
            <button
              type="button"
              className="btn btn-small"
              disabled={decide.isPending || acknowledged[request.requestId] !== true}
              onClick={() => decide.mutate([{ requestId: request.requestId, decision: "approve", boundHash: request.boundHash }])}
              data-testid="value-change-approve"
            >
              批准此项
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={decide.isPending}
              onClick={() => decide.mutate([{ requestId: request.requestId, decision: "reject", boundHash: request.boundHash }])}
              data-testid="value-change-reject"
            >
              拒绝
            </button>
          </li>
        ))}
      </ul>
      {decided.length > 0 ? (
        <p className="faint" data-testid="value-change-decided">
          已决策 {decided.length} 项（批准 {decided.filter((request) => request.status === "approved").length}）
        </p>
      ) : null}
    </div>
  );
}
