import { useState } from "react";

import { ErrorState, Loading } from "../common/StateViews.js";
import { Icon } from "../common/Icon.js";
import {
  GATE_OUTCOME_STYLES,
  GATE_RULES_NEUTRAL,
  GATE_RULE_STYLES,
  statusStyleOf,
  type GateRuleStyle,
} from "../common/status.js";
import { useQualityGate, useReevaluateQualityGate } from "../../hooks/queries.js";
import { formatApiError } from "../../utils/errors.js";
import { formatDateTime } from "../../utils/format.js";
import type { QualityGateResponseView, QualityGateResultView, WorkflowKind } from "../../types/api.js";

/**
 * 质量门禁面板：回答「当前论文是否允许标记为 Final」。
 *
 * 结论 / 规则 / 阻止项全部渲染自 Backend 落盘的 QualityGateResult
 * （GET /quality-gate，按轮读取；同轮审稿汇总随产物内嵌，round 隔离由产物
 * 结构保证）。前端不做任何重算——这里只有 presentation / 轮次切换 / 导航。
 *
 * 视觉约束：红色只出现在未通过徽标与阻止项列表；规则清单用文字 + 中性排版，
 * 不做满屏红色。INSUFFICIENT_EVIDENCE / 未开启语义核验 =「不参与判定」，不是失败。
 */

export type GateOpenTab = (tab: "citations" | "evidence" | "overview", extra?: Record<string, string>) => void;

export function QualityGatePanel({
  projectId,
  workflowKind,
  onOpenTab,
}: {
  projectId: string;
  workflowKind: WorkflowKind | undefined;
  onOpenTab: GateOpenTab;
}) {
  const [selectedRound, setSelectedRound] = useState<number | undefined>(undefined);
  const gate = useQualityGate(projectId, selectedRound);
  const reevaluate = useReevaluateQualityGate(projectId);

  if (gate.isPending) {
    return (
      <section className="panel section-block quality-gate-panel" id="quality-gate-panel" data-testid="quality-gate-panel">
        <div className="section-head">
          <h2>质量门禁</h2>
        </div>
        <Loading label="加载质量门禁…" />
      </section>
    );
  }
  if (gate.isError) {
    return (
      <section className="panel section-block quality-gate-panel" id="quality-gate-panel" data-testid="quality-gate-panel">
        <div className="section-head">
          <h2>质量门禁</h2>
        </div>
        <ErrorState
          title="质量门禁加载失败"
          message={formatApiError(gate.error)}
          onRetry={() => void gate.refetch()}
        />
      </section>
    );
  }

  const data: QualityGateResponseView | undefined = gate.data;
  const rounds = data?.rounds ?? [];
  const viewingLatest = selectedRound === undefined || (data?.round !== null && data?.round === rounds[0]?.round);

  return (
    <section className="panel section-block quality-gate-panel" id="quality-gate-panel" data-testid="quality-gate-panel">
      <div className="section-head">
        <h2>质量门禁</h2>
        {rounds.length > 1 ? (
          <select
            value={selectedRound ?? rounds[0]?.round ?? ""}
            onChange={(event) => setSelectedRound(event.target.value === "" ? undefined : Number(event.target.value))}
            aria-label="切换质量门禁轮次"
            data-testid="gate-round-select"
          >
            {rounds.map((entry) => (
              <option key={entry.round} value={entry.round}>
                第 {entry.round} 轮 · {entry.passed ? "通过" : `未通过（${entry.blockerCount} 项阻止）`}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {data === undefined || data.gate === null || data.round === null ? (
        <div className="state-block state-empty" data-testid="gate-empty">
          <strong>当前还没有质量门禁结果</strong>
          <span>
            {workflowKind === "existing_paper_review"
              ? "快速 Review 是只读分析，不运行质量门禁。门禁在写稿（从想法到论文）与系统性改进工作流的「Quality Gate」阶段自动运行。"
              : "工作流推进到审稿阶段后，「Quality Gate」阶段会自动评估并按轮落盘结果。"}
          </span>
        </div>
      ) : (
        <>
          <GateSummary
            data={data}
            viewingLatest={viewingLatest}
            reevaluatePending={reevaluate.isPending}
            reevaluateError={reevaluate.isError ? formatApiError(reevaluate.error) : null}
            onReevaluate={() => reevaluate.mutate()}
            onOpenTab={onOpenTab}
          />
          <GateRules result={data.gate} />
        </>
      )}
      <p className="section-note faint">
        Draft 只需要构建门禁（LaTeX 编译）通过；标记为 Final 需要构建门禁 + 质量门禁都通过。质量门禁未通过不影响生成 PDF。
      </p>
    </section>
  );
}

function GateSummary({
  data,
  viewingLatest,
  reevaluatePending,
  reevaluateError,
  onReevaluate,
  onOpenTab,
}: {
  data: QualityGateResponseView;
  viewingLatest: boolean;
  reevaluatePending: boolean;
  reevaluateError: string | null;
  onReevaluate: () => void;
  onOpenTab: GateOpenTab;
}) {
  const gate = data.gate!;
  const outcome = statusStyleOf(GATE_OUTCOME_STYLES, gate.passed ? "passed" : "failed");
  const blockers = gate.rules.filter((rule) => !rule.passed);
  const summary = data.reviewSummary;

  return (
    <div className="gate-summary" data-testid="gate-summary">
      <div className="gate-summary-head">
        <span className={`status status-tone-${outcome.tone} gate-outcome`} data-testid="gate-outcome">
          {gate.passed ? <Icon name="check-circle" /> : <Icon name="alert-circle" />}
          {outcome.label}
        </span>
        <span className="gate-summary-meta">
          第 {data.round} 轮 · 评估于 {formatDateTime(gate.checkedAt) ?? "—"}
          {!viewingLatest ? <span className="chip chip-tone-info">历史轮次</span> : null}
        </span>
        <span className="gate-summary-thresholds" title="当前目标的门禁阈值（确定性判定）">
          学术评分 ≥ {gate.thresholds.academicPassScore} · 文风风险 ≤ {gate.thresholds.styleRiskMax}
        </span>
      </div>

      {data.stale && viewingLatest ? (
        <div className="note note-warn" role="status" data-testid="gate-stale">
          <span>
            <span className="note-mark">●</span> 门禁基于第 {data.round} 轮审稿，但已有更新的第 {data.latestReviewRound} 轮审稿。
            <button type="button" className="btn-link" onClick={onReevaluate} disabled={reevaluatePending} data-testid="gate-reevaluate">
              {reevaluatePending ? "评估中…" : "按最新审稿重新评估"}
            </button>
          </span>
        </div>
      ) : null}
      {reevaluateError !== null ? (
        <p className="form-error" role="alert">
          重新评估失败：{reevaluateError}
        </p>
      ) : null}

      {!gate.passed ? (
        <div className="gate-blockers" data-testid="gate-blockers">
          <h3>
            {blockers.length} 项阻止论文进入 Final
          </h3>
          <ol className="gate-blocker-list">
            {blockers.map((rule) => {
              const style = GATE_RULE_STYLES[rule.rule];
              return (
                <li key={rule.rule} className="gate-blocker" data-testid="gate-blocker" data-rule={rule.rule}>
                  <div className="gate-blocker-main">
                    <strong>{style?.label ?? rule.rule}</strong>
                    <span className="gate-blocker-detail">{rule.detail}</span>
                    <span className="gate-blocker-action faint">{blockerAdvice(style)}</span>
                  </div>
                  {style?.target !== undefined ? (
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() =>
                        onOpenTab(
                          style.target!.tab,
                          style.target!.tab === "evidence" && style.target!.evidenceAttention === true
                            ? { attention: "1" }
                            : undefined,
                        )
                      }
                      data-testid={`gate-blocker-goto-${style.target!.tab}`}
                    >
                      前往处理
                      <Icon name="chevron-right" />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </div>
      ) : (
        <p className="note note-success" role="status" data-testid="gate-passed-note">
          <span>
            <span className="note-mark">✓</span> 当前质量门禁已通过：论文在构建成功后可标记为 Final。
            {summary !== null && summary.scores.academicScore !== null ? `（学术评分 ${summary.scores.academicScore}）` : ""}
          </span>
        </p>
      )}

      {summary !== null ? (
        <dl className="kv gate-review-context" data-testid="gate-review-context">
          <div className="kv-row">
            <dt>同轮审稿（第 {summary.round} 轮）</dt>
            <dd>
              {summary.scores.academicScore !== null ? `学术评分 ${summary.scores.academicScore}` : "无学术评分"} ·{" "}
              {summary.scores.styleRisk !== null ? `文风风险 ${summary.scores.styleRisk}` : "无文风评分"} · 严重 {summary.counts.critical} / 主要{" "}
              {summary.counts.major}
              {summary.counts.blocking > 0 ? ` / 阻断 ${summary.counts.blocking}` : ""}
            </dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
}

/** blocker 的处理建议文案（无 target 的规则 = 通过修订流程处理，留在工作流页） */
function blockerAdvice(style: GateRuleStyle | undefined): string {
  if (style?.target === undefined) {
    return "通过工作流的修订阶段处理审稿问题";
  }
  if (style.target.tab === "citations") {
    return "在「引用核验」中查看明细并修复引用";
  }
  if (style.target.tab === "evidence") {
    return "在「证据」中核对矛盾证据";
  }
  return "在「概览」中调整研究目标或补充证据后重新评估";
}

/**
 * Overview / Review 页共用的克制质量状态：一行结论 + 查看入口（完整规则 /
 * 阻止项在工作流页的门禁面板）。快速 Review 项目不显示——该流程不运行
 * 质量门禁，避免永久「尚未评估」噪音。加载中 / 失败不占位（详情页有完整错误态）。
 */
export function QualityGateSummaryLink({ projectId, onOpenTab }: { projectId: string; onOpenTab: (tab: "workflow") => void }) {
  const gate = useQualityGate(projectId);
  const data = gate.data;
  if (gate.isPending || gate.isError || data === undefined) {
    return null;
  }
  if (data.gate === null || data.round === null) {
    return (
      <section className="panel section-block quality-status-card" data-testid="quality-status">
        <div className="quality-status-row">
          <h2>质量状态</h2>
          <span className="status">尚未评估</span>
          <button type="button" className="btn-link" onClick={() => onOpenTab("workflow")}>
            查看
          </button>
        </div>
      </section>
    );
  }
  const outcome = statusStyleOf(GATE_OUTCOME_STYLES, data.gate.passed ? "passed" : "failed");
  const blockerCount = data.gate.reasons.length;
  return (
    <section className="panel section-block quality-status-card" data-testid="quality-status">
      <div className="quality-status-row">
        <h2>质量状态</h2>
        <span className={`status status-tone-${outcome.tone}`}>{outcome.label}</span>
        <span className="muted">
          第 {data.round} 轮{!data.gate.passed ? ` · ${blockerCount} 个阻止项` : ""}
          {data.stale ? " · 结果可能过期" : ""}
        </span>
        <button type="button" className="btn-link" onClick={() => onOpenTab("workflow")} data-testid="quality-status-goto">
          查看
        </button>
      </div>
    </section>
  );
}

/** 规则清单：文字状态（不只靠颜色）+ 中文名 + 后端 detail + ruleId（弱化） */
function GateRules({ result }: { result: QualityGateResultView }) {
  return (
    <div className="gate-rules" data-testid="gate-rules">
      <div className="gate-rules-head">
        <h3>判定规则</h3>
        <span className="faint">{result.rules.filter((rule) => rule.passed).length} / {result.rules.length} 项通过 · 确定性判定，不使用模型自评</span>
      </div>
      <ul className="gate-rule-list">
        {result.rules.map((rule) => {
          const style = GATE_RULE_STYLES[rule.rule];
          const neutral = rule.passed && GATE_RULES_NEUTRAL.has(rule.rule);
          const tone = !rule.passed ? "danger" : neutral ? "neutral" : "ok";
          const label = !rule.passed ? "未通过" : neutral ? "不参与判定" : "通过";
          return (
            <li key={rule.rule} className={`gate-rule${!rule.passed ? " gate-rule-failed" : ""}`} data-testid="gate-rule" data-rule={rule.rule}>
              <span className={`status status-tone-${tone} gate-rule-status`} data-status={label}>
                {label}
              </span>
              <div className="gate-rule-body">
                <span className="gate-rule-name" title={style?.description ?? undefined}>
                  {style?.label ?? rule.rule}
                </span>
                <span className="gate-rule-detail">{rule.detail}</span>
                <span className="gate-rule-id mono faint">{rule.rule}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
