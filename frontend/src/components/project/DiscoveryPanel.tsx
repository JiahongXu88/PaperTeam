import { useState } from "react";

import { ErrorState, Loading } from "../common/StateViews.js";
import { ApiError } from "../../api/client.js";
import { formatApiError, formatApiErrorDetail } from "../../utils/errors.js";
import { formatDateTime } from "../../utils/format.js";
import {
  useAcademicSearch,
  useActivateResearchPlan,
  useAcceptResearchGap,
  useAnalyzeResearchCoverage,
  useApproveResearchPlan,
  useCandidates,
  useDeriveResearchGap,
  useDeriveResearchPlan,
  useExecuteResearchPlan,
  useExecutionHistory,
  usePromoteCandidate,
  useRejectCandidate,
  useRejectResearchGap,
  useResearchCoverage,
  useResearchGaps,
  useResearchPlan,
  useResearchPlans,
  useSaveExecutionResults,
  useUpdateResearchPlan,
  useWebSearch,
} from "../../hooks/queries.js";
import type {
  AcademicResultView,
  ProviderAttemptView,
  WebResultView,
} from "../../types/discovery.js";
import type {
  PlanExecutionEntryView,
  PlanExecutionProviderAttemptView,
  PlanExecutionResultSnapshotView,
  PlanExecutionResultView,
  ResearchCoverageLevel,
  ResearchCoverageQuestionView,
  ResearchCoverageView,
  ResearchGapSeverity,
  ResearchGapStatus,
  ResearchGapView,
} from "../../types/researchPlan.js";
import type {
  CandidateOrigin,
  CandidateSourceView,
  CandidateStatus,
  SourceRole,
} from "../../types/sources.js";
import type {
  ResearchPlanQueryView,
  ResearchPlanStatus,
  ResearchPlanView,
  ResearchQueryKind,
  ResearchQueryStatus,
} from "../../types/researchPlan.js";
import type { ResearchPlanUpdateInput } from "../../api/researchPlan.js";
import type { DiscoveryMode } from "../../api/discovery.js";

/**
 * 「Discovery」：Research Discovery → Candidate Review → Literature Library
 * 闭环的前端消费（M7.1c；后端能力 M6.2/M6.3 已就绪，零新 API）。
 *
 * - M8.1：顶部展示 Research Plan（调研产出的检索计划）——Topic / Questions /
 *   Queries（含理由），支持查看 / 编辑 / 保存（GET+PUT /research/plan）；
 * - M8.3.1：计划完成后可迭代——迭代条（v1 / v2…当前标记）、查看历史计划、
 *   派生新计划（done → 新 draft）、把历史计划设为当前（GET /research/plans +
 *   POST derive / activate）；编辑 / 批准 / 执行始终作用于当前活动计划；
 * - M8.3.2：覆盖分析（Coverage Analysis）——当前活动计划执行后的确定性
 *   覆盖报告（covered / partial / missing），只读派生视图；
 * - M8.3.3：Research Gaps（受控研究循环 HITL）——覆盖缺口成为显式研究对象
 *   （gapId / severity / proposed），Accept / Reject 是用户决策，「由此派生
 *   下一轮计划」只对已接受缺口开放并复用既有 derive API（Coverage → Gap →
 *   Human Approval → Next Plan → 用户批准 → Next Execution；不自动执行）；
 * - 检索走既有 POST /research/{academic|web}-search：默认只返回不持久化，
 *   「保存选中」用同一端点的 saveAsCandidates（结果下标）显式写入候选；
 * - 候选列表 / Promote / Reject 走既有 /sources/candidates 端点群；
 *   Promote（= 接受并入库）幂等，Accept 语义由后端 promote 落定（无独立端点，
 *   UI 不伪造第三种动作）；
 * - 检索结果 ≠ Evidence ≠ 正式文献（D-0033 红线在前端的如实呈现）。
 */

const CANDIDATE_STATUS_LABELS: Record<CandidateStatus, string> = {
  pending_review: "待审",
  accepted: "已接受",
  rejected: "已拒绝",
};

/** status → chip tone（已拒=警示；待审/已接受用默认/信息色，与 Sources 约定一致） */
function candidateStatusTone(status: CandidateStatus): string {
  if (status === "accepted") return "chip-tone-info";
  if (status === "rejected") return "chip-tone-warn";
  return "";
}

const CANDIDATE_ORIGIN_LABELS: Record<CandidateOrigin, string> = {
  academic_search: "学术检索",
  web_search: "Web 检索",
  manual: "手动添加",
};

const SOURCE_ROLE_OPTIONS: ReadonlyArray<{ value: SourceRole; label: string }> = [
  { value: "both", label: "证据 + 参考（默认）" },
  { value: "evidence", label: "证据来源" },
  { value: "reference", label: "参考范文" },
];

const PROVIDER_OUTCOME_LABELS: Record<ProviderAttemptView["outcome"], string> = {
  ok: "正常",
  degraded: "降级",
  failed: "失败",
  not_configured: "未配置",
  skipped_cooldown: "冷却跳过",
  skipped_circuit_open: "熔断跳过",
};

type StatusFilter = "all" | CandidateStatus;

const STATUS_FILTERS: ReadonlyArray<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "pending_review", label: "待审" },
  { id: "accepted", label: "已接受" },
  { id: "rejected", label: "已拒绝" },
];

/** 供「保存选中」复用的最近一次检索参数（与结果列表一一对应；下标才有效） */
interface SearchFormInput {
  query: string;
  yearFrom?: number;
  yearTo?: number;
}

function parseYear(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

function ProviderDiagnostics({ attempts }: { attempts: ProviderAttemptView[] }) {
  if (attempts.length === 0) {
    return null;
  }
  const okCount = attempts.filter((a) => a.outcome === "ok" || a.outcome === "degraded").length;
  return (
    <details className="details-block">
      <summary>
        检索源参与情况（{okCount} / {attempts.length} 可用）
      </summary>
      <ul className="details-body notes-list">
        {attempts.map((attempt) => (
          <li key={attempt.provider}>
            {attempt.provider}：{PROVIDER_OUTCOME_LABELS[attempt.outcome]}
            {attempt.resultCount > 0 ? `（${attempt.resultCount} 条）` : ""}
            {attempt.error !== undefined ? ` — ${attempt.error.message}` : ""}
            {attempt.note !== undefined ? `（${attempt.note}）` : ""}
          </li>
        ))}
      </ul>
    </details>
  );
}

function AcademicResultRow({
  result,
  index,
  checked,
  onToggle,
}: {
  result: AcademicResultView;
  index: number;
  checked: boolean;
  onToggle: (index: number) => void;
}) {
  const record = result.record;
  const title = record.title ?? record.url ?? `结果 ${index + 1}`;
  return (
    <li className="source-row candidate-row">
      <input
        type="checkbox"
        className="candidate-check"
        aria-label={`选择结果 ${index + 1}`}
        checked={checked}
        onChange={() => onToggle(index)}
      />
      <div className="source-row-main">
        <span className="source-title" title={title}>
          {title}
        </span>
        <span className="source-chips">
          {result.sources.map((source) => (
            <span key={source.provider} className="chip chip-outline" title={`来源 ${source.provider}，名次 ${source.rank}`}>
              {source.provider}
            </span>
          ))}
          {result.citationCount !== undefined ? (
            <span className="chip chip-outline" title="被引次数">被引 {result.citationCount}</span>
          ) : null}
          {result.openAccess === true ? <span className="chip chip-outline">开放获取</span> : null}
        </span>
      </div>
      <div className="source-row-meta">
        {record.authors !== undefined && record.authors.length > 0 ? (
          <span className="source-authors" title={record.authors.join("; ")}>
            {record.authors[0]}
            {record.authors.length > 1 ? " 等" : ""}
          </span>
        ) : null}
        {record.year !== undefined ? <span>{record.year}</span> : null}
        {record.venue !== undefined ? <span className="source-venue">{record.venue}</span> : null}
        <span className="muted mono" title="RRF 融合分">score {result.score.toFixed(3)}</span>
        {record.doi !== undefined ? <span className="muted mono">{record.doi}</span> : null}
        {record.arxivId !== undefined ? <span className="muted mono">arXiv:{record.arxivId}</span> : null}
      </div>
    </li>
  );
}

function WebResultRow({
  result,
  index,
  checked,
  onToggle,
}: {
  result: WebResultView;
  index: number;
  checked: boolean;
  onToggle: (index: number) => void;
}) {
  return (
    <li className="source-row candidate-row">
      <input
        type="checkbox"
        className="candidate-check"
        aria-label={`选择结果 ${index + 1}`}
        checked={checked}
        onChange={() => onToggle(index)}
      />
      <div className="source-row-main">
        <span className="source-title" title={result.url}>
          {result.title}
        </span>
        <span className="source-chips">
          <span className="chip chip-outline">{result.provider}</span>
          {result.engines.length > 0 ? (
            <span className="chip chip-outline" title={result.engines.join(", ")}>
              {result.engines.length} 引擎
            </span>
          ) : null}
        </span>
      </div>
      <div className="source-row-meta">
        <span className="source-venue" title={result.url}>
          {result.url}
        </span>
        <span className="muted mono" title="融合分">score {result.score.toFixed(3)}</span>
      </div>
      {result.snippet !== "" ? <div className="source-row-meta candidate-snippet">{result.snippet}</div> : null}
    </li>
  );
}

// ---- Research Plan（M8.1）----

const PLAN_STATUS_LABELS: Record<ResearchPlanStatus, string> = {
  draft: "草稿",
  approved: "已批准",
  executing: "执行中",
  done: "已完成",
};

const QUERY_KIND_LABELS: Record<ResearchQueryKind, string> = {
  academic: "学术检索",
  web: "Web 检索",
};

const QUERY_STATUS_LABELS: Record<ResearchQueryStatus, string> = {
  planned: "计划中",
  executed: "已执行",
  skipped: "已跳过",
};

/** 编辑态的单条检索（queryId 为空串 = 本轮新增；保存时省略该字段） */
interface EditableQuery {
  queryId: string;
  query: string;
  kind: ResearchQueryKind;
  rationale: string;
  status: ResearchQueryStatus;
}

function toEditable(plan: ResearchPlanView): { questions: string; queries: EditableQuery[] } {
  return {
    questions: plan.questions.join("\n"),
    queries: plan.queries.map((entry) => ({
      queryId: entry.queryId,
      query: entry.query,
      kind: entry.kind,
      rationale: entry.rationale ?? "",
      status: entry.status,
    })),
  };
}

function PlanQueryRow({ entry }: { entry: ResearchPlanQueryView }) {
  return (
    <li className="source-row candidate-row">
      <div className="source-row-main">
        <span className="source-title">{entry.query}</span>
        <span className="source-chips">
          <span className="chip chip-outline" title="检索方式">{QUERY_KIND_LABELS[entry.kind]}</span>
          <span className="chip">{QUERY_STATUS_LABELS[entry.status]}</span>
          {entry.resultCount !== undefined ? (
            <span className="chip chip-outline" title="执行结果数">{entry.resultCount} 条结果</span>
          ) : null}
        </span>
      </div>
      {entry.rationale !== undefined && entry.rationale !== "" ? (
        <div className="source-row-meta candidate-snippet">理由：{entry.rationale}</div>
      ) : null}
      {entry.expectedCoverage !== undefined && entry.expectedCoverage !== "" ? (
        <div className="source-row-meta candidate-snippet">期望覆盖：{entry.expectedCoverage}</div>
      ) : null}
    </li>
  );
}

// ---- Execution Audit（M8.5：executionHistory 只读审计视图）----

/** provider 参与摘要的紧凑文案（provider 条数，降级 / 失败时附注） */
function attemptLabel(attempt: PlanExecutionProviderAttemptView): string {
  const note =
    attempt.outcome !== "ok" && attempt.outcome !== "degraded" && attempt.note !== undefined
      ? `：${attempt.note}`
      : attempt.outcome === "degraded"
        ? "（降级）"
        : "";
  return `${attempt.provider} ${attempt.resultCount} 条${note}`;
}

function ExecutionAuditSection({ projectId }: { projectId: string }) {
  const history = useExecutionHistory(projectId);
  const entries = history.data ?? [];
  // 审计是辅助视图：加载失败 / 无记录时静默收起，不打扰主面板
  if (entries.length === 0) {
    return null;
  }
  return (
    <details className="details-block" data-testid="execution-audit">
      <summary>
        执行审计（{entries.length} 条记录 · 最新在前）
      </summary>
      <ul className="details-body notes-list">
        {entries
          .slice()
          .reverse()
          .map((entry, index) => (
            <li key={`${entry.executionId}-${entry.queryId}-${index}`}>
              {formatDateTime(entry.timestamp) ?? "—"} · {QUERY_KIND_LABELS[entry.kind]}「{entry.query}」：
              {entry.status === "executed"
                ? `${entry.resultCount ?? 0} 条结果`
                : `失败 —— ${entry.error ?? "未知原因"}`}
              {entry.providers !== undefined && entry.providers.length > 0
                ? ` · 检索源：${entry.providers.map(attemptLabel).join("、")}`
                : ""}
              {entry.resultIdentifiers !== undefined && entry.resultIdentifiers.length > 0 ? (
                <span
                  title={entry.resultIdentifiers.join("\n")}
                  data-testid="execution-audit-identifiers"
                >
                  {" "}
                  · {entry.resultIdentifiers.length} 条结果标识已留存（悬停查看；只是审计痕迹，不是候选）
                </span>
              ) : null}
              {entry.resultSnapshot !== undefined && entry.resultSnapshot.length > 0 ? (
                <ExecutionSnapshotPicker projectId={projectId} entry={entry} />
              ) : null}
            </li>
          ))}
      </ul>
    </details>
  );
}

/**
 * 单条执行记录的结果快照勾选保存（M9.1 Search Result → Candidate 的 HITL
 * 衔接）：展示该 query 的 Top-N 快照（provider / 年份 / DOI / arXiv / 预览），
 * 用户勾选后显式保存为候选——快照本身永不自动成为候选。
 */
function ExecutionSnapshotPicker({
  projectId,
  entry,
}: {
  projectId: string;
  entry: PlanExecutionEntryView;
}) {
  const save = useSaveExecutionResults(projectId);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const snapshot = entry.resultSnapshot ?? [];

  const toggle = (index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  return (
    <div className="execution-snapshot" data-testid="execution-snapshot" style={{ marginTop: "var(--s-2)" }}>
      <ul className="source-list" data-testid="execution-snapshot-results">
        {snapshot.map((item, index) => (
          <SnapshotResultRow
            key={`${entry.queryId}-${index}`}
            item={item}
            index={index}
            checked={selected.has(index)}
            onToggle={toggle}
          />
        ))}
      </ul>
      <div className="action-row">
        <button
          type="button"
          className="btn btn-small"
          disabled={save.isPending || selected.size === 0}
          onClick={() =>
            save.mutate(
              {
                executionId: entry.executionId,
                queryId: entry.queryId,
                saveAsCandidates: [...selected].sort((a, b) => a - b),
              },
              { onSuccess: () => setSelected(new Set()) },
            )
          }
          data-testid="save-snapshot-candidates"
        >
          {save.isPending ? "保存中…" : `保存选中（${selected.size}）为候选`}
        </button>
        {save.isSuccess && save.data !== undefined ? (
          <span className="field-help" role="status" data-testid="save-snapshot-note">
            已保存 {save.data.saved.length} 条候选
            {save.data.mergedExisting.length > 0
              ? `（${save.data.mergedExisting.length} 条与既有待审候选同身份，已合并补充）`
              : ""}
            ，请在下方候选审阅区确认。
          </span>
        ) : null}
        {save.isError ? (
          <span className="form-error" role="alert">
            保存失败：{formatApiError(save.error)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** 快照行：勾选 + 标题 + provider / 年份 / DOI / arXiv chips + 预览（与检索结果行同视觉） */
function SnapshotResultRow({
  item,
  index,
  checked,
  onToggle,
}: {
  item: PlanExecutionResultSnapshotView;
  index: number;
  checked: boolean;
  onToggle: (index: number) => void;
}) {
  const title =
    item.title ?? (item.kind === "academic" ? item.url ?? item.doi ?? item.arxivId ?? `结果 ${index + 1}` : item.url);
  return (
    <li className="source-row candidate-row">
      <input
        type="checkbox"
        className="candidate-check"
        aria-label={`选择结果 ${index + 1}：${title}`}
        checked={checked}
        onChange={() => onToggle(index)}
        data-testid={`snapshot-check-${index}`}
      />
      <div className="source-row-main">
        <span className="source-title" title={title}>
          {title}
        </span>
        <span className="source-chips">
          <span className="chip chip-outline" title="发现方 provider">{item.provider}</span>
          {item.kind === "academic" && item.year !== undefined ? (
            <span className="chip chip-outline">{item.year}</span>
          ) : null}
          {item.kind === "academic" && item.doi !== undefined ? (
            <span className="chip chip-outline mono">{item.doi}</span>
          ) : null}
          {item.kind === "academic" && item.arxivId !== undefined ? (
            <span className="chip chip-outline mono">arXiv:{item.arxivId}</span>
          ) : null}
        </span>
      </div>
      {item.snippetPreview !== undefined && item.snippetPreview !== "" ? (
        <div className="source-row-meta candidate-snippet">{item.snippetPreview}</div>
      ) : null}
    </li>
  );
}

function PlanEditForm({
  plan,
  projectId,
  onDone,
}: {
  plan: ResearchPlanView;
  projectId: string;
  onDone: () => void;
}) {
  const initial = toEditable(plan);
  const [questionsText, setQuestionsText] = useState(initial.questions);
  const [queries, setQueries] = useState<EditableQuery[]>(initial.queries);
  const [localError, setLocalError] = useState<string | null>(null);
  const save = useUpdateResearchPlan(projectId);

  const patchQuery = (index: number, patch: Partial<EditableQuery>) => {
    setQueries((prev) => prev.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  };

  const submit = () => {
    const questions = questionsText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    const invalidQuery = queries.findIndex((entry) => entry.query.trim() === "");
    if (invalidQuery >= 0) {
      setLocalError(`第 ${invalidQuery + 1} 条检索词为空，请填写或删除该条`);
      return;
    }
    setLocalError(null);
    const input: ResearchPlanUpdateInput = {
      questions,
      queries: queries.map((entry) => ({
        ...(entry.queryId !== "" ? { queryId: entry.queryId } : {}),
        query: entry.query.trim(),
        kind: entry.kind,
        ...(entry.rationale.trim() !== "" ? { rationale: entry.rationale.trim() } : {}),
        status: entry.status,
      })),
    };
    save.mutate(input, { onSuccess: onDone });
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="field">
        <label htmlFor="plan-questions">研究问题（每行一个）</label>
        <textarea
          id="plan-questions"
          rows={Math.max(3, questionsText.split("\n").length)}
          value={questionsText}
          onChange={(event) => setQuestionsText(event.target.value)}
          disabled={save.isPending}
        />
      </div>
      <div className="field">
        <span className="field-label">检索计划</span>
        {queries.map((entry, index) => (
          <div key={entry.queryId !== "" ? entry.queryId : `new-${index}`} className="plan-query-edit-row">
            <input
              type="text"
              aria-label={`检索词 ${index + 1}`}
              value={entry.query}
              onChange={(event) => patchQuery(index, { query: event.target.value })}
              placeholder="检索词"
              disabled={save.isPending}
            />
            <select
              aria-label={`检索方式 ${index + 1}`}
              value={entry.kind}
              onChange={(event) => patchQuery(index, { kind: event.target.value as ResearchQueryKind })}
              disabled={save.isPending}
            >
              <option value="academic">学术检索</option>
              <option value="web">Web 检索</option>
            </select>
            <select
              aria-label={`状态 ${index + 1}`}
              value={entry.status}
              onChange={(event) =>
                patchQuery(index, { status: event.target.value as ResearchQueryStatus })
              }
              disabled={save.isPending}
            >
              <option value="planned">计划中</option>
              <option value="executed">已执行</option>
              <option value="skipped">已跳过</option>
            </select>
            <input
              type="text"
              aria-label={`理由 ${index + 1}`}
              value={entry.rationale}
              onChange={(event) => patchQuery(index, { rationale: event.target.value })}
              placeholder="理由（为什么做这条检索）"
              disabled={save.isPending}
            />
            <button
              type="button"
              className="btn btn-small"
              onClick={() => setQueries((prev) => prev.filter((_, i) => i !== index))}
              disabled={save.isPending}
            >
              删除
            </button>
          </div>
        ))}
        <div className="action-row">
          <button
            type="button"
            className="btn btn-small"
            onClick={() =>
              setQueries((prev) => [
                ...prev,
                { queryId: "", query: "", kind: "academic", rationale: "", status: "planned" },
              ])
            }
            disabled={save.isPending}
          >
            添加检索
          </button>
        </div>
      </div>
      {localError !== null ? (
        <p className="form-error" role="alert">
          {localError}
        </p>
      ) : null}
      {save.isError ? (
        <ErrorState title="计划保存失败" message={formatApiError(save.error)} detail={formatApiErrorDetail(save.error)} />
      ) : null}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={save.isPending}>
          {save.isPending ? "保存中…" : "保存计划"}
        </button>
        <button type="button" className="btn" onClick={onDone} disabled={save.isPending}>
          取消
        </button>
      </div>
    </form>
  );
}

function ResearchPlanSection({ projectId, topic }: { projectId: string; topic?: string }) {
  const [editing, setEditing] = useState(false);
  const [executionSummary, setExecutionSummary] = useState<PlanExecutionResultView | null>(null);
  /** 查看的历史计划（null = 跟随当前活动计划；查看不切换，切换需显式「设为当前」） */
  const [viewPlanId, setViewPlanId] = useState<string | null>(null);
  const plan = useResearchPlan(projectId);
  const plans = useResearchPlans(projectId);
  const approve = useApproveResearchPlan(projectId);
  const execute = useExecuteResearchPlan(projectId);
  const derive = useDeriveResearchPlan(projectId);
  const activate = useActivateResearchPlan(projectId);
  const actionPending = approve.isPending || execute.isPending || derive.isPending || activate.isPending;

  const historyPlans = plans.data?.plans ?? [];
  const activePlanId = plans.data?.activePlanId ?? plan.data?.planId ?? null;
  const viewingHistoryPlan =
    viewPlanId !== null && viewPlanId !== activePlanId
      ? (historyPlans.find((entry) => entry.planId === viewPlanId) ?? null)
      : null;
  // 展示对象：查看历史时取链中条目；否则跟随活动计划（GET /research/plan）
  const displayed = viewingHistoryPlan ?? plan.data;
  const currentStatus = displayed?.status;
  const isActivePlan = displayed !== null && displayed !== undefined && displayed.planId === activePlanId;

  const runExecute = () => {
    setExecutionSummary(null);
    execute.mutate(undefined, {
      onSuccess: (result) => setExecutionSummary(result),
    });
  };

  const runDerive = () => {
    if (activePlanId === null) {
      return;
    }
    derive.mutate({ planId: activePlanId }, { onSuccess: () => setViewPlanId(null) });
  };

  const runActivate = (planId: string) => {
    activate.mutate(planId, { onSuccess: () => setViewPlanId(null) });
  };

  return (
    <section className="panel section-block" data-testid="research-plan-section">
      <div className="section-head">
        <h2>Research Plan</h2>
        {currentStatus !== undefined ? (
          <>
            <span className={`chip${currentStatus === "done" ? " chip-tone-info" : ""}`} data-testid="plan-status">
              {PLAN_STATUS_LABELS[currentStatus]}
            </span>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => setEditing((prev) => !prev)}
              disabled={plan.isPending || actionPending || !isActivePlan}
            >
              {editing ? "收起编辑" : "编辑"}
            </button>
          </>
        ) : null}
      </div>
      <p className="field-help">
        检索计划是 Researcher 调研产出的检索意图声明（先计划后检索）。批准（draft →
        已批准）后可执行：计划中「计划中」的检索会逐一运行并回填状态与结果数。
        执行只产生检索结果，不会自动保存候选或产生文献 / Evidence——保存仍由你在下方检索结果中显式勾选。
      </p>
      {historyPlans.length > 1 ? (
        <div className="action-row" data-testid="plan-iterations" role="group" aria-label="计划迭代">
          {historyPlans.map((entry) => {
            const active = entry.planId === activePlanId;
            return (
              <button
                key={entry.planId}
                type="button"
                className={`btn btn-small${viewPlanId === entry.planId ? " is-active" : ""}`}
                aria-pressed={viewPlanId === entry.planId}
                onClick={() => {
                  setViewPlanId(entry.planId);
                  setEditing(false); // 查看历史时退出编辑（编辑只作用于当前活动计划）
                }}
                disabled={actionPending}
                title={active ? "当前活动计划（编辑 / 批准 / 执行作用于它）" : "查看该轮计划"}
              >
                v{entry.iterationNumber ?? "?"} · {PLAN_STATUS_LABELS[entry.status]}
                {active ? "（当前）" : ""}
              </button>
            );
          })}
        </div>
      ) : null}
      {viewingHistoryPlan !== null ? (
        <p className="note" role="status" data-testid="plan-history-note">
          <span>
            正在查看历史计划 v{viewingHistoryPlan.iterationNumber ?? "?"}（
            {PLAN_STATUS_LABELS[viewingHistoryPlan.status]}，非当前）。编辑 / 批准 / 执行
            只作用于当前活动计划。
          </span>{" "}
          <button
            type="button"
            className="btn btn-small"
            onClick={() => runActivate(viewingHistoryPlan.planId)}
            disabled={actionPending}
            data-testid="activate-plan"
          >
            {activate.isPending ? "切换中…" : "设为当前"}
          </button>{" "}
          <button
            type="button"
            className="btn btn-small"
            onClick={() => setViewPlanId(null)}
            disabled={actionPending}
          >
            回到当前计划
          </button>
        </p>
      ) : null}
      {!editing && currentStatus !== undefined && isActivePlan ? (
        <div className="action-row">
          {currentStatus === "draft" ? (
            <button
              type="button"
              className="btn btn-small"
              onClick={() => approve.mutate()}
              disabled={actionPending}
              data-testid="approve-plan"
            >
              {approve.isPending ? "批准中…" : "批准计划"}
            </button>
          ) : null}
          {currentStatus === "approved" ? (
            <button
              type="button"
              className="btn btn-small btn-primary"
              onClick={runExecute}
              disabled={actionPending}
              data-testid="execute-plan"
            >
              {execute.isPending ? "执行中…" : "执行计划"}
            </button>
          ) : null}
          {currentStatus === "executing" ? <span className="muted">计划执行中…</span> : null}
          {currentStatus === "done" ? (
            <>
              <span className="muted">本轮计划已执行完成；可派生新计划继续研究。</span>
              <button
                type="button"
                className="btn btn-small"
                onClick={runDerive}
                disabled={actionPending}
                data-testid="derive-plan"
              >
                {derive.isPending ? "派生中…" : "派生新计划"}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {derive.isError ? (
        <ErrorState
          title="派生计划失败"
          message={formatApiError(derive.error)}
          detail={formatApiErrorDetail(derive.error)}
        />
      ) : null}
      {activate.isError ? (
        <ErrorState
          title="切换计划失败"
          message={formatApiError(activate.error)}
          detail={formatApiErrorDetail(activate.error)}
        />
      ) : null}
      {plan.isPending ? (
        <Loading label="加载检索计划…" />
      ) : plan.isError ? (
        <ErrorState
          title="计划加载失败"
          message={formatApiError(plan.error)}
          detail={formatApiErrorDetail(plan.error)}
          onRetry={() => void plan.refetch()}
        />
      ) : approve.isError ? (
        <ErrorState
          title="计划批准失败"
          message={formatApiError(approve.error)}
          detail={formatApiErrorDetail(approve.error)}
        />
      ) : execute.isError ? (
        <ErrorState
          title="计划执行失败"
          message={formatApiError(execute.error)}
          detail={formatApiErrorDetail(execute.error)}
        />
      ) : displayed === null || displayed === undefined ? (
        <p className="panel-empty" data-testid="research-plan-empty">
          还没有检索计划。运行「从想法到论文」工作流的调研阶段后，Researcher 制定的
          检索计划会展示在这里。
        </p>
      ) : editing ? (
        <PlanEditForm plan={plan.data!} projectId={projectId} onDone={() => setEditing(false)} />
      ) : (
        <div className="panel-stack">
          <div className="field">
            <span className="field-label">Topic</span>
            <p>{topic ?? "—"}</p>
          </div>
          <div className="field">
            <span className="field-label">Questions</span>
            {displayed.questions.length === 0 ? (
              <p className="muted">（无研究问题）</p>
            ) : (
              <ol className="notes-list" data-testid="plan-questions">
                {displayed.questions.map((question, index) => (
                  <li key={`${index}-${question}`}>{question}</li>
                ))}
              </ol>
            )}
          </div>
          <div className="field">
            <span className="field-label">Queries</span>
            {displayed.queries.length === 0 ? (
              <p className="muted">（无检索词）</p>
            ) : (
              <ul className="source-list" data-testid="plan-queries">
                {displayed.queries.map((entry) => (
                  <PlanQueryRow key={entry.queryId} entry={entry} />
                ))}
              </ul>
            )}
          </div>
          <ExecutionAuditSection projectId={projectId} />
          {executionSummary !== null ? (
            <p
              className={`note ${executionSummary.failedQueries > 0 ? "note-warn" : "note-success"}`}
              role="status"
              data-testid="plan-execution-result"
            >
              <span>
                <span className="note-mark">{executionSummary.failedQueries > 0 ? "!" : "✓"}</span>{" "}
                计划执行完成：{executionSummary.executedQueries} 条检索成功
                {executionSummary.failedQueries > 0
                  ? `、${executionSummary.failedQueries} 条失败（失败原因已记录在执行历史，条目保持计划中可重试）`
                  : ""}
                （计划共 {executionSummary.totalQueries} 条）。
              </span>
            </p>
          ) : null}
          <p className="muted">
            更新于 {formatDateTime(displayed.updatedAt) ?? "—"} · planId {displayed.planId}
            {displayed.iterationNumber !== undefined ? ` · v${displayed.iterationNumber}` : ""}
          </p>
        </div>
      )}
    </section>
  );
}

// ---- Coverage Analysis（M8.3.2：只读派生视图 + 缺口建议） ----

const COVERAGE_LEVEL_LABELS: Record<ResearchCoverageLevel, string> = {
  covered: "已覆盖",
  partial: "部分覆盖",
  missing: "未覆盖",
};

/** status → chip tone（已覆盖=信息色；未覆盖=警示色；部分覆盖=默认） */
function coverageTone(level: ResearchCoverageLevel): string {
  if (level === "covered") return "chip-tone-info";
  if (level === "missing") return "chip-tone-warn";
  return "";
}

function CoverageQuestionRow({ entry }: { entry: ResearchCoverageQuestionView }) {
  return (
    <li className="source-row candidate-row">
      <div className="source-row-main">
        <span className="source-title">{entry.question}</span>
        <span className="source-chips">
          <span className={`chip ${coverageTone(entry.coverage)}`}>
            {COVERAGE_LEVEL_LABELS[entry.coverage]}
          </span>
          <span className="chip chip-outline" title="问题来源">
            {entry.origin === "plan" ? "计划问题" : "报告问题"}
          </span>
        </span>
      </div>
      <div className="source-row-meta">
        <span title="与该问题关联的计划检索数">关联检索 {entry.relatedQueryCount}</span>
        <span title="关联检索中已执行且带回结果的条数">已执行 {entry.executedQueryCount}</span>
        <span title="Search Result 计数（≠候选≠文献≠证据）">结果 {entry.resultCount}</span>
        <span title="关联 EvidenceStore 证据条数">证据 {entry.evidenceCount}</span>
        <span title="关联已入库文献数">已入库 {entry.promotedCount}</span>
      </div>
      {entry.gap !== undefined ? (
        <div className="source-row-meta candidate-snippet">缺口：{entry.gap}</div>
      ) : null}
    </li>
  );
}

function CoverageSection({ projectId }: { projectId: string }) {
  const coverage = useResearchCoverage(projectId);
  const analyze = useAnalyzeResearchCoverage(projectId);

  // 展示最近一次分析结果（POST 优先于 GET 派生视图）
  const report: ResearchCoverageView | null = analyze.data ?? coverage.data ?? null;

  return (
    <section className="panel section-block" data-testid="coverage-section">
      <div className="section-head">
        <h2>覆盖分析</h2>
        <span className="section-note">只读分析 · 不改计划与证据</span>
      </div>
      <p className="field-help">
        对当前活动计划做确定性覆盖分析（不含 LLM 判断）：研究问题是否被检索 /
        证据 / 入库文献覆盖，哪些方向仍有缺口。报告是即时重算的派生视图，不落盘；
        缺口的确认与「由此派生下一轮」在下方 Research Gaps 区域（M8.3.3 HITL）。
      </p>
      <div className="action-row">
        <button
          type="button"
          className="btn btn-small"
          onClick={() => analyze.mutate()}
          disabled={analyze.isPending}
          data-testid="analyze-coverage"
        >
          {analyze.isPending ? "分析中…" : "分析覆盖"}
        </button>
      </div>
      {analyze.isError ? (
        <ErrorState
          title="覆盖分析失败"
          message={formatApiError(analyze.error)}
          detail={formatApiErrorDetail(analyze.error)}
        />
      ) : null}
      {report === null ? (
        coverage.isPending ? (
          <Loading label="加载覆盖报告…" />
        ) : (
          <p className="panel-empty" data-testid="coverage-empty">
            还没有覆盖报告。当前活动计划有研究问题时，点击「分析覆盖」查看覆盖情况。
          </p>
        )
      ) : (
        <div className="panel-stack">
          <p className="note" role="status" data-testid="coverage-summary">
            <span>
              <span className="note-mark">✓</span> {report.overall.summary}（分析于{" "}
              {formatDateTime(report.analyzedAt) ?? "—"}
              {report.iterationNumber !== undefined ? ` · v${report.iterationNumber}` : ""}）
            </span>
          </p>
          <div className="field">
            <span className="field-label">Research Coverage</span>
            {report.questions.length === 0 ? (
              <p className="muted">（活动计划没有研究问题）</p>
            ) : (
              <ul className="source-list" data-testid="coverage-questions">
                {report.questions.map((entry, index) => (
                  <CoverageQuestionRow key={`${index}-${entry.question}`} entry={entry} />
                ))}
              </ul>
            )}
          </div>
          {report.gaps.length > 0 ? (
            <p className="muted">
              检出 {report.gaps.length} 项研究缺口（含建议检索）——到下方「Research
              Gaps」逐项确认（Accept / Reject）后即可由此派生下一轮计划。
            </p>
          ) : (
            <p className="muted">无缺口：全部研究问题均已覆盖。</p>
          )}
        </div>
      )}
    </section>
  );
}

// ---- Research Gaps（M8.3.3：Coverage → Gap → Human Approval → Next Plan）----

const GAP_SEVERITY_LABELS: Record<ResearchGapSeverity, string> = {
  high: "高",
  medium: "中",
  low: "低",
};

const GAP_STATUS_LABELS: Record<ResearchGapStatus, string> = {
  proposed: "待确认",
  accepted: "已接受",
  rejected: "已拒绝",
};

/** severity → chip tone（高=警示；中/低用默认色） */
function gapSeverityTone(severity: ResearchGapSeverity): string {
  return severity === "high" ? "chip-tone-warn" : "";
}

/** status → chip tone（已接受=信息色；待确认/已拒绝用默认色） */
function gapStatusTone(status: ResearchGapStatus): string {
  return status === "accepted" ? "chip-tone-info" : "";
}

function GapRow({
  gap,
  canDerive,
  actionPending,
  onAccept,
  onReject,
  onDerive,
}: {
  gap: ResearchGapView;
  /** 活动计划已 done（派生的来源计划状态门槛；后端同口径 409） */
  canDerive: boolean;
  actionPending: boolean;
  onAccept: () => void;
  onReject: () => void;
  onDerive: () => void;
}) {
  const title = gap.question ?? gap.description;
  return (
    <li className="source-row candidate-row" data-testid="research-gap-row">
      <div className="source-row-main">
        <span className="source-title" title={gap.description}>
          {title}
        </span>
        <span className="source-chips">
          <span className={`chip ${gapSeverityTone(gap.severity)}`} title="缺口严重度（确定性规则：missing 无方向=高 / 有方向无产出=中 / partial=低；残差=中）">
            严重度 {GAP_SEVERITY_LABELS[gap.severity]}
          </span>
          <span className={`chip ${gapStatusTone(gap.status)}`}>{GAP_STATUS_LABELS[gap.status]}</span>
        </span>
      </div>
      <div className="source-row-meta">
        {gap.question !== undefined ? (
          <span className="candidate-snippet" title="缺口描述">
            {gap.description}
          </span>
        ) : null}
        {gap.suggestedQueries.length > 0 ? (
          <span title="建议下一轮执行的检索词">建议检索：{gap.suggestedQueries.join("；")}</span>
        ) : null}
        <span className="muted mono">{gap.gapId}</span>
        {gap.decidedAt !== undefined ? (
          <span className="muted">确认于 {formatDateTime(gap.decidedAt) ?? "—"}</span>
        ) : null}
      </div>
      <div className="action-row">
        {gap.status === "proposed" ? (
          <>
            <button
              type="button"
              className="btn btn-small btn-primary"
              onClick={onAccept}
              disabled={actionPending}
              data-testid="accept-gap"
            >
              接受
            </button>
            <button
              type="button"
              className="btn btn-small"
              onClick={onReject}
              disabled={actionPending}
              data-testid="reject-gap"
            >
              拒绝
            </button>
          </>
        ) : null}
        {gap.status === "accepted" ? (
          <button
            type="button"
            className="btn btn-small btn-primary"
            onClick={onDerive}
            disabled={actionPending || !canDerive}
            title={
              canDerive
                ? "以该缺口的建议检索派生下一轮 draft 计划（复用既有派生接口；派生后仍需编辑、批准才会执行）"
                : "只有已完成（done）的活动计划才能派生下一轮"
            }
            data-testid="derive-from-gap"
          >
            由此派生下一轮计划
          </button>
        ) : null}
        {gap.status === "rejected" ? <span className="muted">已拒绝（不参与下一轮派生）。</span> : null}
      </div>
    </li>
  );
}

function ResearchGapsSection({ projectId }: { projectId: string }) {
  const gapsQuery = useResearchGaps(projectId);
  const accept = useAcceptResearchGap(projectId);
  const reject = useRejectResearchGap(projectId);
  const derive = useDeriveResearchGap(projectId);
  const plans = useResearchPlans(projectId);

  const activePlanId = plans.data?.activePlanId ?? null;
  const activeStatus =
    plans.data?.plans.find((entry) => entry.planId === activePlanId)?.status ?? undefined;
  // 派生门槛与后端同口径：缺口来自活动计划；活动计划须 done 才能派生下一轮
  const canDerive = activePlanId !== null && activeStatus === "done";
  const actionPending = accept.isPending || reject.isPending || derive.isPending;

  const gaps = gapsQuery.data?.gaps ?? [];

  return (
    <section className="panel section-block" data-testid="research-gaps-section">
      <div className="section-head">
        <h2>Research Gaps</h2>
        <span className="section-note">受控研究循环 · 确认缺口后才可派生下一轮</span>
      </div>
      <p className="field-help">
        缺口来自覆盖分析（待确认 proposed，随分析即时重算）。Accept = 确认该方向值得
        下一轮检索；Reject = 否决。「由此派生下一轮计划」只对已接受缺口开放——
        新计划是 draft，仍需编辑、批准、执行才会跑检索（不自动执行）。
      </p>
      {accept.isError ? (
        <ErrorState
          title="接受缺口失败"
          message={formatApiError(accept.error)}
          detail={formatApiErrorDetail(accept.error)}
        />
      ) : null}
      {reject.isError ? (
        <ErrorState
          title="拒绝缺口失败"
          message={formatApiError(reject.error)}
          detail={formatApiErrorDetail(reject.error)}
        />
      ) : null}
      {derive.isError ? (
        <ErrorState
          title="派生计划失败"
          message={formatApiError(derive.error)}
          detail={formatApiErrorDetail(derive.error)}
        />
      ) : null}
      {gapsQuery.isPending ? (
        <Loading label="加载研究缺口…" />
      ) : gapsQuery.isError ? (
        <ErrorState
          title="缺口加载失败"
          message={formatApiError(gapsQuery.error)}
          detail={formatApiErrorDetail(gapsQuery.error)}
          onRetry={() => void gapsQuery.refetch()}
        />
      ) : gaps.length === 0 ? (
        <p className="panel-empty" data-testid="research-gaps-empty">
          还没有研究缺口。覆盖分析发现未覆盖方向时，缺口会列在这里（待确认），
          确认后可由此派生下一轮计划。
        </p>
      ) : (
        <ul className="source-list" data-testid="research-gap-list">
          {gaps.map((gap) => (
            <GapRow
              key={gap.gapId}
              gap={gap}
              canDerive={canDerive}
              actionPending={actionPending}
              onAccept={() => accept.mutate(gap.gapId)}
              onReject={() => reject.mutate(gap.gapId)}
              onDerive={() => derive.mutate({ gapId: gap.gapId })}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function SearchSection({ projectId }: { projectId: string }) {  const [mode, setMode] = useState<DiscoveryMode>("academic");
  const [query, setQuery] = useState("");
  const [yearFromText, setYearFromText] = useState("");
  const [yearToText, setYearToText] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [localError, setLocalError] = useState<string | null>(null);
  /** 最近一次成功检索的参数：保存选中时原样复用（结果下标只对同参数检索有效） */
  const [lastSearch, setLastSearch] = useState<SearchFormInput | null>(null);

  const academic = useAcademicSearch(projectId);
  const web = useWebSearch(projectId);
  const pending = academic.isPending || web.isPending;
  const response = mode === "academic" ? academic.data : web.data;

  const runSearch = (saveIndexes?: number[]) => {
    const trimmed = query.trim();
    if (trimmed === "") {
      setLocalError("请先填写研究问题");
      return;
    }
    const yearFrom = parseYear(yearFromText);
    const yearTo = parseYear(yearToText);
    if (Number.isNaN(yearFrom) || Number.isNaN(yearTo)) {
      setLocalError("年份范围必须是整数（可留空）");
      return;
    }
    if (yearFrom !== undefined && yearTo !== undefined && yearFrom > yearTo) {
      setLocalError("起始年份不能晚于结束年份");
      return;
    }
    if (saveIndexes !== undefined && saveIndexes.length === 0) {
      return;
    }
    setLocalError(null);
    const input = { query: trimmed, ...(yearFrom !== undefined ? { yearFrom } : {}), ...(yearTo !== undefined ? { yearTo } : {}) };
    if (saveIndexes === undefined) {
      setSelected(new Set());
    }
    setLastSearch(input);
    if (mode === "academic") {
      academic.mutate(saveIndexes === undefined ? input : { ...input, saveAsCandidates: saveIndexes });
    } else {
      web.mutate(
        saveIndexes === undefined
          ? { query: trimmed }
          : { query: trimmed, saveAsCandidates: saveIndexes },
      );
    }
  };

  const toggleIndex = (index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const results = response?.results ?? [];
  const saved = response?.saved;

  return (
    <section className="panel section-block">
      <div className="section-head">
        <h2>研究检索</h2>
        <span className="section-note">结果默认不保存；勾选后显式存为本项目候选</span>
      </div>
      <div className="action-row source-mode-row" role="group" aria-label="检索方式">
        {(
          [
            { id: "academic" as DiscoveryMode, label: "学术检索" },
            { id: "web" as DiscoveryMode, label: "Web 检索" },
          ]
        ).map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`btn btn-small${mode === entry.id ? " is-active" : ""}`}
            aria-pressed={mode === entry.id}
            onClick={() => {
              setMode(entry.id);
              setLocalError(null);
              setSelected(new Set());
            }}
            disabled={pending}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          runSearch();
        }}
      >
        <div className="field">
          <label htmlFor="discovery-query">研究问题</label>
          <input
            id="discovery-query"
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="如 Transformer based multi-object tracking"
            disabled={pending}
          />
        </div>
        {mode === "academic" ? (
          <div className="field field-inline">
            <label htmlFor="discovery-year-from">年份范围（可选）</label>
            <span className="year-range">
              <input
                id="discovery-year-from"
                type="number"
                value={yearFromText}
                onChange={(event) => setYearFromText(event.target.value)}
                placeholder="从"
                disabled={pending}
              />
              <span className="muted">—</span>
              <input
                id="discovery-year-to"
                type="number"
                aria-label="结束年份"
                value={yearToText}
                onChange={(event) => setYearToText(event.target.value)}
                placeholder="到"
                disabled={pending}
              />
            </span>
          </div>
        ) : null}
        <div className="form-actions">
          <button type="submit" className="btn" disabled={pending || query.trim() === ""}>
            {pending ? "检索中…" : "检索"}
          </button>
        </div>
      </form>

      <div className="panel-stack" style={{ marginTop: "var(--s-3)" }}>
        {localError !== null ? (
          <p className="form-error" role="alert">
            {localError}
          </p>
        ) : null}
        {academic.isError ? (
          <ErrorState
            title="学术检索失败"
            message={formatApiError(academic.error)}
            detail={formatApiErrorDetail(academic.error)}
          />
        ) : null}
        {web.isError ? (
          <ErrorState
            title="Web 检索失败"
            message={formatApiError(web.error)}
            detail={formatApiErrorDetail(web.error)}
          />
        ) : null}
        {response !== undefined && response.status === "partial" ? (
          <p className="note note-warn" role="status">
            <span>
              <span className="note-mark">!</span> 部分检索源失败，以下为可用源的融合结果。
            </span>
          </p>
        ) : null}
        {response !== undefined && results.length === 0 ? (
          <p className="panel-empty">没有检索到结果，可调整研究问题或年份范围后重试。</p>
        ) : null}
        {saved !== undefined ? (
          <p className="note note-success" role="status">
            <span>
              <span className="note-mark">✓</span> 已保存 {saved.saved.length} 条候选
              {saved.mergedExisting.length > 0
                ? `（${saved.mergedExisting.length} 条与既有待审候选同身份，已合并补充而非重复创建）`
                : ""}
              ，请在下方审阅。
            </span>
          </p>
        ) : null}
        {results.length > 0 ? (
          <>
            <ul className="source-list" data-testid="search-results">
              {mode === "academic"
                ? (results as AcademicResultView[]).map((result, index) => (
                    <AcademicResultRow
                      key={`${result.record.provider}-${result.record.recordId}`}
                      result={result}
                      index={index}
                      checked={selected.has(index)}
                      onToggle={toggleIndex}
                    />
                  ))
                : (results as WebResultView[]).map((result, index) => (
                    <WebResultRow
                      key={result.url}
                      result={result}
                      index={index}
                      checked={selected.has(index)}
                      onToggle={toggleIndex}
                    />
                  ))}
            </ul>
            <div className="action-row">
              <button
                type="button"
                className="btn btn-small"
                disabled={pending || selected.size === 0}
                onClick={() => runSearch([...selected].sort((a, b) => a - b))}
                data-testid="save-candidates"
              >
                {pending ? "保存中…" : `保存选中（${selected.size}）为候选`}
              </button>
              <span className="field-help">
                保存会以相同检索参数显式写入候选列表（下方立即出现）。
              </span>
            </div>
          </>
        ) : null}
        {lastSearch !== null && response?.diagnostics !== undefined ? (
          <ProviderDiagnostics attempts={response.diagnostics.providers} />
        ) : null}
      </div>
    </section>
  );
}

function CandidateRow({
  candidate,
  checked,
  onToggle,
}: {
  candidate: CandidateSourceView;
  checked: boolean;
  onToggle: (candidateId: string) => void;
}) {
  const title = candidate.title ?? candidate.url ?? candidate.doi ?? candidate.arxivId ?? candidate.candidateId;
  return (
    <li className="source-row candidate-row">
      <input
        type="checkbox"
        className="candidate-check"
        aria-label={`选择候选 ${candidate.candidateId}`}
        checked={checked}
        onChange={() => onToggle(candidate.candidateId)}
      />
      <div className="source-row-main">
        <span className="source-title" title={title}>
          {title}
        </span>
        <span className="source-chips">
          <span className="chip" title="发现方式">{CANDIDATE_ORIGIN_LABELS[candidate.origin]}</span>
          <span className="chip chip-outline" title="发现方 provider">{candidate.provider}</span>
          <span className={`chip ${candidateStatusTone(candidate.status)}`}>
            {CANDIDATE_STATUS_LABELS[candidate.status]}
          </span>
        </span>
      </div>
      <div className="source-row-meta">
        {candidate.authors !== undefined && candidate.authors.length > 0 ? (
          <span className="source-authors" title={candidate.authors.join("; ")}>
            {candidate.authors[0]}
            {candidate.authors.length > 1 ? " 等" : ""}
          </span>
        ) : null}
        {candidate.year !== undefined ? <span>{candidate.year}</span> : null}
        {candidate.venue !== undefined ? <span className="source-venue">{candidate.venue}</span> : null}
        {candidate.doi !== undefined ? <span className="muted mono">{candidate.doi}</span> : null}
        {candidate.arxivId !== undefined ? <span className="muted mono">arXiv:{candidate.arxivId}</span> : null}
        {candidate.url !== undefined ? (
          <span className="source-venue" title={candidate.url}>
            {candidate.url}
          </span>
        ) : null}
        {candidate.query !== undefined ? <span className="muted" title="发现该候选的检索词">检索词：{candidate.query}</span> : null}
        <span className="muted mono">{candidate.candidateId}</span>
        {candidate.status === "accepted" && candidate.promotedSourceId !== undefined ? (
          <span className="muted mono" title="已入库的正式文献 ID">→ {candidate.promotedSourceId}</span>
        ) : null}
        <span className="muted">{formatDateTime(candidate.updatedAt) ?? "—"}</span>
      </div>
      {candidate.snippetOrAbstract !== undefined && candidate.snippetOrAbstract !== "" ? (
        <div className="source-row-meta candidate-snippet">{candidate.snippetOrAbstract}</div>
      ) : null}
    </li>
  );
}

function CandidateSection({ projectId }: { projectId: string }) {
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sourceRole, setSourceRole] = useState<SourceRole>("both");
  const [batchNote, setBatchNote] = useState<string | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);

  const { data, isPending, isError, error, refetch } = useCandidates(
    projectId,
    filter === "all" ? undefined : filter,
  );
  const promote = usePromoteCandidate(projectId);
  const reject = useRejectCandidate(projectId);
  const busy = promote.isPending || reject.isPending;

  const candidates = data ?? [];

  const toggleCandidate = (candidateId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(candidateId)) {
        next.delete(candidateId);
      } else {
        next.add(candidateId);
      }
      return next;
    });
  };

  /** 批量执行（顺序调用幂等端点；失败不中断，剩余条目继续，结果如实汇总） */
  const runBatch = async (
    action: (candidateId: string) => Promise<unknown>,
    describe: (count: number) => string,
  ) => {
    const ids = [...selected];
    setBatchNote(null);
    setBatchError(null);
    const failures: string[] = [];
    for (const candidateId of ids) {
      try {
        await action(candidateId);
      } catch (cause) {
        failures.push(`${candidateId}：${formatApiError(cause)}`);
      }
    }
    setSelected(new Set());
    if (failures.length === 0) {
      setBatchNote(describe(ids.length));
    } else {
      setBatchError(
        `${failures.length} / ${ids.length} 条失败：\n${failures.join("\n")}`,
      );
    }
  };

  return (
    <section className="panel section-block">
      <div className="section-head">
        <h2>候选文献</h2>
        <span className="section-note">{candidates.length} 条</span>
      </div>
      <p className="field-help">
        候选 ≠ 正式文献：来自检索保存或 Researcher Agent 的发现。Promote = 接受并导入文献库
        （幂等）；Reject = 否决。已入库的文献在「文献库」标签页管理。
      </p>
      <div className="action-row" role="group" aria-label="状态筛选">
        {STATUS_FILTERS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`btn btn-small${filter === entry.id ? " is-active" : ""}`}
            aria-pressed={filter === entry.id}
            onClick={() => {
              setFilter(entry.id);
              setSelected(new Set());
            }}
            disabled={isPending}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {isPending ? (
        <Loading label="加载候选…" />
      ) : isError ? (
        <ErrorState
          title={
            error instanceof ApiError && error.code === "CANDIDATE_STORE_CORRUPTED"
              ? "候选数据损坏（不是没有候选论文）"
              : "候选加载失败"
          }
          message={formatApiError(error)}
          detail={formatApiErrorDetail(error)}
          onRetry={() => void refetch()}
        />
      ) : candidates.length === 0 ? (
        <p className="panel-empty">
          还没有候选。在上方检索研究问题并保存选中结果，或运行「从想法到论文」工作流——
          Researcher Agent 会把发现的文献自动存为候选。
        </p>
      ) : (
        <>
          <ul className="source-list" data-testid="candidate-list">
            {candidates.map((candidate) => (
              <CandidateRow
                key={candidate.candidateId}
                candidate={candidate}
                checked={selected.has(candidate.candidateId)}
                onToggle={toggleCandidate}
              />
            ))}
          </ul>
          <div className="action-row candidate-actions">
            <button
              type="button"
              className="btn btn-small btn-primary"
              disabled={busy || selected.size === 0}
              onClick={() =>
                void runBatch(
                  (candidateId) => promote.mutateAsync({ candidateId, sourceRole }),
                  (count) => `已接受 ${count} 条候选并导入文献库（可在「文献库」查看）。`,
                )
              }
              data-testid="promote-candidates"
            >
              {promote.isPending ? "入库中…" : `Promote 入库（${selected.size}）`}
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={busy || selected.size === 0}
              onClick={() =>
                void runBatch(
                  (candidateId) => reject.mutateAsync(candidateId),
                  (count) => `已拒绝 ${count} 条候选。`,
                )
              }
              data-testid="reject-candidates"
            >
              {reject.isPending ? "处理中…" : `拒绝（${selected.size}）`}
            </button>
            <span className="field-help candidate-role-field">
              <label htmlFor="candidate-role">入库角色</label>
              <select
                id="candidate-role"
                value={sourceRole}
                onChange={(event) => setSourceRole(event.target.value as SourceRole)}
                disabled={busy}
              >
                {SOURCE_ROLE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </span>
          </div>
        </>
      )}

      <div className="panel-stack" style={{ marginTop: "var(--s-3)" }}>
        {batchNote !== null ? (
          <p className="note note-success" role="status">
            <span>
              <span className="note-mark">✓</span> {batchNote}
            </span>
          </p>
        ) : null}
        {batchError !== null ? (
          <p className="form-error" role="alert" style={{ whiteSpace: "pre-wrap" }}>
            {batchError}
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function DiscoveryPanel({ projectId, topic }: { projectId: string; topic?: string }) {
  return (
    <div className="panel-stack" data-testid="discovery-panel">
      <ResearchPlanSection projectId={projectId} topic={topic} />
      <CoverageSection projectId={projectId} />
      <ResearchGapsSection projectId={projectId} />
      <SearchSection projectId={projectId} />
      <CandidateSection projectId={projectId} />
    </div>
  );
}
