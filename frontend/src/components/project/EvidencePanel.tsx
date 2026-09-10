import { useMemo, useState, type ReactNode } from "react";

import { ErrorState, Loading } from "../common/StateViews.js";
import { Icon } from "../common/Icon.js";
import {
  EVIDENCE_VERIFICATION_STYLES,
  SUPPORT_STRENGTH_STYLES,
  VERIFICATION_LEVEL_LABELS,
  statusStyleOf,
} from "../common/status.js";
import { useConfirmEvidenceVerified, useEvidence } from "../../hooks/queries.js";
import { formatApiError, formatApiErrorDetail } from "../../utils/errors.js";
import { formatDateTime } from "../../utils/format.js";
import type { EvidenceRecordView, EvidenceVerificationStatus, WorkflowKind } from "../../types/api.js";

/**
 * 证据工作台：回答「这篇论文的核心论断，依据是什么？这些依据可靠吗？」
 *
 * 数据全部来自 EvidenceStore（GET /evidence 一次取回；筛选 / 搜索 / 概况统计
 * 都在同一份数据上派生，无 N+1）。核验动作是人工确认（user_confirmed），
 * 与「引用核验」的学术库自动核验是两条链路——状态语义不混用。
 * 状态枚举原样来自 Domain；中文标签集中在 status.ts 注册表。
 */

type StatusFilter = "all" | "verified" | "unverified" | "attention";

/** 需要用户留意的口径：与来源不符 / 查无来源 / 无法核验 / 与论断矛盾 */
const ATTENTION_STATUSES: ReadonlySet<EvidenceVerificationStatus> = new Set([
  "mismatch",
  "not_found",
  "unverifiable",
]);

const CREATED_BY_LABELS: Record<string, string> = {
  researcher: "调研（Researcher）",
  user: "人工",
};

function isAttention(record: EvidenceRecordView): boolean {
  return ATTENTION_STATUSES.has(record.verificationStatus) || record.supportStrength === "contradictory";
}

function createdByLabel(record: EvidenceRecordView): string {
  return CREATED_BY_LABELS[record.createdBy] ?? record.createdBy;
}

/** 搜索命中：claim / 摘要 / 引文 / 来源标题 / DOI / 编号 */
function matchesQuery(record: EvidenceRecordView, query: string): boolean {
  if (query === "") {
    return true;
  }
  const haystack = [
    record.id,
    record.claim,
    record.summary,
    record.quote,
    record.source?.title,
    record.source?.doi,
    record.source?.authors?.join(" "),
  ]
    .filter((part): part is string => part !== undefined && part !== "")
    .join("\n")
    .toLowerCase();
  return haystack.includes(query);
}

export function EvidencePanel({
  projectId,
  workflowKind,
  onOpenTab,
  initialAttention = false,
}: {
  projectId: string;
  workflowKind: WorkflowKind | undefined;
  onOpenTab: (tab: "workflow") => void;
  /** 来自门禁 blocker 的深链（?tab=evidence&attention=1）：初始即筛「需注意」 */
  initialAttention?: boolean;
}) {
  const evidence = useEvidence(projectId);
  const confirm = useConfirmEvidenceVerified(projectId);
  const [status, setStatus] = useState<StatusFilter>(initialAttention ? "attention" : "all");
  const [section, setSection] = useState("all");
  const [source, setSource] = useState("all");
  const [query, setQuery] = useState("");

  const sections = useMemo(() => {
    const set = new Set<string>();
    for (const record of evidence.data ?? []) {
      for (const value of record.relatedSections ?? []) {
        set.add(value);
      }
      if (record.location?.section !== undefined) {
        set.add(record.location.section);
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  }, [evidence.data]);

  const sources = useMemo(() => {
    const map = new Map<string, number>();
    for (const record of evidence.data ?? []) {
      const key = record.source?.sourceId ?? record.source?.title ?? "";
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    // 有标题 / sourceId 的来源按名称排序；未标注来源的条目归入「未标注来源」
    return [...map.entries()].sort((a, b) => (a[0] === "" ? 1 : b[0] === "" ? -1 : a[0].localeCompare(b[0], "zh-Hans-CN")));
  }, [evidence.data]);

  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (evidence.data ?? []).filter((record) => {
      if (status === "verified" && record.verificationStatus !== "verified" && record.verificationStatus !== "plausible") {
        return false;
      }
      if (status === "unverified" && record.verificationStatus !== "unverified") {
        return false;
      }
      if (status === "attention" && !isAttention(record)) {
        return false;
      }
      if (section !== "all") {
        const inRelated = (record.relatedSections ?? []).includes(section);
        const atLocation = record.location?.section === section;
        if (!inRelated && !atLocation) {
          return false;
        }
      }
      if (source !== "all") {
        const key = record.source?.sourceId ?? record.source?.title ?? "";
        if (key !== source) {
          return false;
        }
      }
      return matchesQuery(record, normalized);
    });
  }, [evidence.data, status, section, source, query]);

  if (evidence.isPending) {
    return <Loading label="加载证据数据…" />;
  }
  if (evidence.isError) {
    return (
      <ErrorState
        title="证据数据加载失败"
        message={formatApiError(evidence.error)}
        detail={formatApiErrorDetail(evidence.error)}
        onRetry={() => void evidence.refetch()}
      />
    );
  }

  const records = evidence.data ?? [];
  if (records.length === 0) {
    return (
      <section className="section-block" data-testid="evidence-panel">
        <div className="section-head">
          <h2>证据</h2>
        </div>
        <div className="state-block state-empty" data-testid="evidence-empty">
          <strong>当前项目还没有可展示的证据</strong>
          <span>
            {workflowKind === undefined || workflowKind === "idea_to_paper"
              ? "证据在「从想法到论文」的调研阶段自动收集：每条证据记录它支撑的论断、来源文献与核验状态。"
              : "证据库记录支撑论文论断的文献证据（写稿流程的调研产出）。当前流程还没有产出证据记录。"}
          </span>
          <div className="action-row">
            <button type="button" className="btn btn-primary" onClick={() => onOpenTab("workflow")} data-testid="evidence-goto-workflow">
              <Icon name="play" />
              {workflowKind === "existing_paper_improvement" ? "继续改进工作流" : "前往工作流"}
            </button>
          </div>
        </div>
      </section>
    );
  }

  const verified = records.filter((record) => record.verificationStatus === "verified" || record.verificationStatus === "plausible").length;
  const unverified = records.filter((record) => record.verificationStatus === "unverified").length;
  const attention = records.filter(isAttention).length;
  const usedByManuscript = records.filter((record) => (record.usedBy ?? []).length > 0).length;
  const sourceCount = new Set(records.map((record) => record.source?.sourceId ?? record.source?.title ?? "")).size;
  const filtered = visible.length !== records.length;

  return (
    <div className="evidence-panel" data-testid="evidence-panel">
      <p className="integrity-explain">
        证据 = 论文论断的依据。每条证据记录支撑的论断、来源文献与核验状态；「确认已核验」表示你已人工核对过来源（与引用核验的学术库自动核验相互独立）。
      </p>

      <div className="ledger-group">
        <section className="ledger-block">
          <div className="ledger-block-head">
            <h2 className="ledger-title">证据概况</h2>
          </div>
          <div className="ledger">
            <span className="ledger-item">证据总数 {records.length}</span>
            <span className="ledger-item status status-tone-ok">已核验 {verified}</span>
            <span className="ledger-item">待核验 {unverified}</span>
            <span className={`ledger-item${attention > 0 ? " status status-tone-danger" : ""}`}>需注意 {attention}</span>
            <span className="ledger-item">被正文使用 {usedByManuscript}</span>
            <span className="ledger-item" title="按来源文献去重">
              来源 {sourceCount}
            </span>
          </div>
        </section>
      </div>

      <section className="section-block">
        <div className="section-head">
          <h2>证据列表</h2>
          <div className="action-row review-toolbar-tools">
            <label className="search-field">
              <Icon name="search" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索论断 / 证据 / 来源 / DOI…"
                aria-label="搜索证据"
                data-testid="evidence-search"
              />
            </label>
            {sections.length > 0 ? (
              <select value={section} onChange={(event) => setSection(event.target.value)} aria-label="按章节筛选">
                <option value="all">全部章节</option>
                {sections.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            ) : null}
            {sources.length > 1 || (sources.length === 1 && sources[0]?.[0] !== "") ? (
              <select value={source} onChange={(event) => setSource(event.target.value)} aria-label="按来源筛选">
                <option value="all">全部来源</option>
                {sources
                  .filter(([key]) => key !== "")
                  .map(([key, count]) => (
                    <option key={key} value={key}>
                      {key.length > 40 ? `${key.slice(0, 40)}…` : key}（{count}）
                    </option>
                  ))}
                {sources.some(([key]) => key === "") ? <option value="">未标注来源</option> : null}
              </select>
            ) : null}
            <div className="segmented" role="radiogroup" aria-label="按核验状态筛选">
              {(
                [
                  ["all", `全部 ${records.length}`],
                  ["verified", `已核验 ${verified}`],
                  ["unverified", `待核验 ${unverified}`],
                  ["attention", `需注意 ${attention}`],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="segmented-option">
                  <input
                    type="radio"
                    name="evidence-status-filter"
                    value={value}
                    checked={status === value}
                    onChange={() => setStatus(value)}
                    data-testid={`evidence-filter-${value}`}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
        </div>

        {confirm.isError ? (
          <p className="form-error" role="alert">
            确认核验失败：{formatApiError(confirm.error)}
          </p>
        ) : null}

        {visible.length === 0 ? (
          <p className="panel-empty" data-testid="evidence-no-match">
            当前筛选下没有证据。{filtered ? "可调整筛选或搜索词。" : ""}
          </p>
        ) : (
          <div className="gutter-list evidence-list" data-testid="evidence-list">
            {visible.map((record) => (
              <EvidenceRow
                key={record.id}
                record={record}
                confirming={confirm.isPending && confirm.variables === record.id}
                onConfirm={() => confirm.mutate(record.id)}
              />
            ))}
          </div>
        )}
        <p className="section-note faint">
          共 {records.length} 条{filtered ? ` · 当前显示 ${visible.length} 条` : ""} · 筛选在已加载的数据上进行
        </p>
      </section>
    </div>
  );
}

function EvidenceRow({
  record,
  confirming,
  onConfirm,
}: {
  record: EvidenceRecordView;
  confirming: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  const status = statusStyleOf(EVIDENCE_VERIFICATION_STYLES, record.verificationStatus);
  const support = record.supportStrength !== undefined ? statusStyleOf(SUPPORT_STRENGTH_STYLES, record.supportStrength) : undefined;
  const source = record.source;
  const author = source?.authors?.[0];
  const sourceParts = [
    author !== undefined ? `${author}${(source?.authors?.length ?? 0) > 1 ? " 等" : ""}` : undefined,
    source?.year !== undefined ? String(source.year) : undefined,
  ].filter((part): part is string => part !== undefined);
  const locationParts = [
    record.location?.section !== undefined ? `章节 ${record.location.section}` : undefined,
    record.location?.page !== undefined ? `第 ${record.location.page} 页` : undefined,
  ].filter((part): part is string => part !== undefined);
  const usedCount = (record.usedBy ?? []).length;

  return (
    <article className={`gutter-row evidence-row${open ? " evidence-row-open" : ""}`} data-testid="evidence-row" data-evidence-id={record.id}>
      <span className="gutter-num" title={record.id}>
        {record.id}
      </span>
      <div className="gutter-body">
        <span className="evidence-claim">{record.claim}</span>
        {record.quote !== undefined || record.summary !== undefined ? (
          <span className="evidence-text">
            {record.quote ?? record.summary}
          </span>
        ) : null}
        {source !== undefined ? (
          <span className="evidence-source">
            {source.title !== undefined ? <span className="evidence-source-title">{source.title}</span> : null}
            {sourceParts.length > 0 ? <span className="meta-part">{sourceParts.join(" · ")}</span> : null}
            {source.doi !== undefined ? <span className="evidence-doi mono">{source.doi}</span> : null}
            {source.url !== undefined ? (
              <a href={source.url} target="_blank" rel="noreferrer" className="evidence-link">
                <Icon name="external" />
                来源链接
              </a>
            ) : null}
          </span>
        ) : (
          <span className="evidence-source muted">未标注来源</span>
        )}
        <span className="evidence-meta">
          {locationParts.length > 0 ? <span className="meta-part">{locationParts.join(" · ")}</span> : null}
          <span className="meta-part">{createdByLabel(record)} · {formatDateTime(record.createdAt) ?? "—"}</span>
          {usedCount > 0 ? <span className="meta-part">被正文使用（{usedCount} 次任务）</span> : null}
        </span>
        <button type="button" className="btn-link evidence-expand" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="evidence-toggle-detail">
          {open ? "收起详情" : "查看详情与出处"}
        </button>
        {open ? <EvidenceDetail record={record} confirming={confirming} onConfirm={onConfirm} /> : null}
      </div>
      <div className="gutter-side">
        <span className={`status status-tone-${status.tone}`}>{status.label}</span>
        {support !== undefined ? <span className={`support-chip status status-tone-${support.tone}`}>{support.label}</span> : null}
        {record.verificationStatus === "unverified" ? (
          <button
            type="button"
            className="btn btn-small"
            onClick={onConfirm}
            disabled={confirming}
            title="我已人工核对来源：把这条证据标记为已核验（user_confirmed）"
            data-testid={`evidence-confirm-${record.id}`}
          >
            {confirming ? "确认中…" : "确认已核验"}
          </button>
        ) : null}
      </div>
    </article>
  );
}

/** 展开后的详情：出处（provenance）/ 核验信息 / 使用情况——全部来自真实字段，不推导 */
function EvidenceDetail({ record, confirming, onConfirm }: { record: EvidenceRecordView; confirming: boolean; onConfirm: () => void }) {
  const verification = statusStyleOf(EVIDENCE_VERIFICATION_STYLES, record.verificationStatus);
  const rows: Array<[string, ReactNode]> = [];
  const source = record.source;
  if (source?.sourceId !== undefined) {
    rows.push(["来源 ID", <span key="sid" className="mono">{source.sourceId}</span>]);
  }
  if (record.location?.chunk !== undefined) {
    rows.push(["文本块", <span key="chunk" className="mono">{record.location.chunk}</span>]);
  }
  if (record.verificationMethod !== undefined || record.verificationLevel !== undefined) {
    rows.push([
      "核验方式",
      <>
        {record.verificationLevel !== undefined ? VERIFICATION_LEVEL_LABELS[record.verificationLevel] ?? record.verificationLevel : "—"}
        {record.verificationMethod !== undefined ? <span className="muted">（{record.verificationMethod}）</span> : null}
      </>,
    ]);
  }
  if (record.updatedAt !== undefined) {
    rows.push(["最近更新", formatDateTime(record.updatedAt) ?? "—"]);
  }
  rows.push(["创建", createdByLabel(record)]);
  if (record.confidence !== undefined) {
    rows.push(["置信度（参考）", `${Math.round(record.confidence * 100)}%（辅助字段，不参与质量门禁判定）`]);
  }
  if ((record.relatedSections ?? []).length > 0) {
    rows.push(["关联章节", (record.relatedSections ?? []).join("、")]);
  }
  if ((record.usedBy ?? []).length > 0) {
    rows.push(["使用记录", (record.usedBy ?? []).map((entry) => <span key={entry} className="mono evidence-usedby">{entry}</span>)]);
  }
  return (
    <div className="evidence-detail" data-testid="evidence-detail">
      {record.quote !== undefined && record.summary !== undefined ? (
        <div className="evidence-detail-block">
          <h4>证据摘要</h4>
          <p className="prewrap reading">{record.summary}</p>
        </div>
      ) : null}
      {record.quote !== undefined ? (
        <div className="evidence-detail-block">
          <h4>来源引文</h4>
          <blockquote className="finding-claim">
            <Icon name="quote" />
            <span className="prewrap">{record.quote}</span>
          </blockquote>
        </div>
      ) : null}
      <div className="evidence-detail-block">
        <h4>出处</h4>
        <dl className="ref-details-list">
          {source !== undefined ? (
            <>
              <dt>文献</dt>
              <dd>{source.title ?? "（未标注标题）"}</dd>
              {source.authors !== undefined && source.authors.length > 0 ? (
                <>
                  <dt>作者</dt>
                  <dd>{source.authors.slice(0, 3).join("，")}{source.authors.length > 3 ? " 等" : ""}</dd>
                </>
              ) : null}
              {source.year !== undefined ? (
                <>
                  <dt>年份</dt>
                  <dd>{source.year}</dd>
                </>
              ) : null}
              {source.doi !== undefined ? (
                <>
                  <dt>DOI</dt>
                  <dd className="mono">{source.doi}</dd>
                </>
              ) : null}
              {source.url !== undefined ? (
                <>
                  <dt>链接</dt>
                  <dd>
                    <a href={source.url} target="_blank" rel="noreferrer" className="mono">{source.url}</a>
                  </dd>
                </>
              ) : null}
            </>
          ) : (
            <>
              <dt>文献</dt>
              <dd className="muted">未标注来源（可要求调研阶段补充，或人工核验后标注）</dd>
            </>
          )}
          {record.location?.page !== undefined ? (
            <>
              <dt>页码</dt>
              <dd>第 {record.location.page} 页</dd>
            </>
          ) : null}
          {record.location?.section !== undefined ? (
            <>
              <dt>章节</dt>
              <dd>{record.location.section}</dd>
            </>
          ) : null}
        </dl>
      </div>
      <div className="evidence-detail-block">
        <h4>核验</h4>
        <dl className="ref-details-list">
          <dt>状态</dt>
          <dd>
            <span className={`status status-tone-${verification.tone}`}>{verification.label}</span>
            {record.verificationStatus === "unverified" ? (
              <>
                {" "}
                <button type="button" className="btn-link" onClick={onConfirm} disabled={confirming}>
                  {confirming ? "确认中…" : "我已核对来源，标记为已核验"}
                </button>
              </>
            ) : null}
          </dd>
          {rows.map(([label, node]) => (
            <div key={label} className="evidence-detail-row">
              <dt>{label}</dt>
              <dd>{node}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
