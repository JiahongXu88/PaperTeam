import { useState } from "react";

import { ErrorState, Loading } from "../common/StateViews.js";
import { formatApiError, formatApiErrorDetail } from "../../utils/errors.js";
import { formatDateTime } from "../../utils/format.js";
import {
  useAcademicSearch,
  useCandidates,
  usePromoteCandidate,
  useRejectCandidate,
  useWebSearch,
} from "../../hooks/queries.js";
import type {
  AcademicResultView,
  ProviderAttemptView,
  WebResultView,
} from "../../types/discovery.js";
import type {
  CandidateOrigin,
  CandidateSourceView,
  CandidateStatus,
  SourceRole,
} from "../../types/sources.js";
import type { DiscoveryMode } from "../../api/discovery.js";

/**
 * 「Discovery」：Research Discovery → Candidate Review → Literature Library
 * 闭环的前端消费（M7.1c；后端能力 M6.2/M6.3 已就绪，零新 API）。
 *
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

function SearchSection({ projectId }: { projectId: string }) {
  const [mode, setMode] = useState<DiscoveryMode>("academic");
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
          title="候选加载失败"
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

export function DiscoveryPanel({ projectId }: { projectId: string }) {
  return (
    <div className="panel-stack" data-testid="discovery-panel">
      <SearchSection projectId={projectId} />
      <CandidateSection projectId={projectId} />
    </div>
  );
}
