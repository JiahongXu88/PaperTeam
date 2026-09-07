import { useMemo, useRef, useState } from "react";

import { ErrorState, Loading } from "../common/StateViews.js";
import {
  METADATA_STATUS_STYLES,
  REFERENCE_KIND_LABELS,
  SEMANTIC_VERDICT_STYLES,
  statusStyleOf,
} from "../common/status.js";
import {
  SEMANTIC_VERIFY_LIMIT,
  useClaimRecords,
  useCitationIntegrity,
  useCitations,
  useExtractCitations,
  useMetadataRecords,
  useVerifyClaims,
  useVerifyMetadata,
} from "../../hooks/queries.js";
import { formatApiError, formatApiErrorDetail } from "../../utils/errors.js";
import type { MetadataRecordView, MetadataStatus, ReferenceView, SemanticVerdict } from "../../types/paper.js";
import { SemanticClaimsSection, type ClaimFilter } from "./SemanticClaims.js";

/**
 * 引用核验：三段"登记簿"（提取 / 真实性 / 语义）各带自己的操作，账目对平：
 * Σ 各状态 + 未核验 = 参考文献总数。两层核验严格区分——文献真实性 ≠ 文献支持论断；
 * 查无此文 ≠ 捏造，证据不足 ≠ 不支持。语义核验的统计数字可点击——直接过滤明细列表。
 * 参考文献列表：编号在左侧栏位，状态在右。
 */

const METADATA_ORDER: readonly MetadataStatus[] = ["VERIFIED", "METADATA_MISMATCH", "AMBIGUOUS", "NOT_FOUND", "PROVIDER_ERROR", "UNRESOLVED"];
const VERDICT_ORDER: readonly SemanticVerdict[] = ["SUPPORTED", "PARTIALLY_SUPPORTED", "UNSUPPORTED", "CONTRADICTED", "INSUFFICIENT_EVIDENCE", "SKIPPED"];

type ReferenceFilter = "all" | "flagged" | "unchecked";

function LedgerItem({ label, tone, count }: { label: string; tone: string; count: number }) {
  return <span className={`ledger-item status status-tone-${tone}`}>{`${label} ${count}`}</span>;
}

/** 可点击的统计项（语义核验）：点击即过滤下方明细列表并滚动过去 */
function LedgerFilterItem({
  label,
  tone,
  count,
  active,
  onClick,
}: {
  label: string;
  tone: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`ledger-item ledger-item-button status status-tone-${tone}${active ? " ledger-item-active" : ""}`}
      onClick={onClick}
      data-testid={`ledger-filter-${label}`}
    >
      {`${label} ${count}`}
    </button>
  );
}

/** 分布比例条（宽度为 0 的段不渲染；纯视觉，不承载信息） */
function LedgerBar({ segments }: { segments: Array<{ tone: string; count: number }> }) {
  const total = segments.reduce((sum, seg) => sum + seg.count, 0);
  if (total === 0) {
    return null;
  }
  return (
    <div className="ledger-bar" aria-hidden="true">
      {segments
        .filter((seg) => seg.count > 0)
        .map((seg, index) => (
          <span key={index} className={`ledger-bar-seg ledger-bar-seg-tone-${seg.tone}`} style={{ width: `${(seg.count / total) * 100}%` }} />
        ))}
    </div>
  );
}

/** 后端把 PDF 行尾断词编码为软连字符（U+00AD）；展示时去掉，避免复制出不可见字符 */
function stripSoftHyphens(text: string): string {
  return text.replace(/\u00AD/g, "");
}

function displayTitle(title: string | undefined): string | undefined {
  return title === undefined ? undefined : stripSoftHyphens(title).replace(/^\[\d+\]\s*/, "").trim() || undefined;
}

/** 单库查询结果 → 中文（未知值原样展示） */
const ATTEMPT_OUTCOME_LABELS: Record<string, string> = {
  match: "命中",
  mismatch: "命中（字段有差异）",
  not_found: "未收录",
  ambiguous: "多个候选",
  error: "查询失败",
};

const PROVIDER_LABELS: Record<string, string> = {
  crossref: "Crossref",
  openalex: "OpenAlex",
  "semantic-scholar": "Semantic Scholar",
  arxiv: "arXiv",
  github: "GitHub（官方仓库）",
};

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

export function CitationsPanel({ projectId }: { projectId: string }) {
  const citations = useCitations(projectId);
  const integrity = useCitationIntegrity(projectId);
  const metadataRecords = useMetadataRecords(projectId);
  const claimRecords = useClaimRecords(projectId);
  const extract = useExtractCitations(projectId);
  const verifyMeta = useVerifyMetadata(projectId);
  const verifyClaims = useVerifyClaims(projectId);
  const [filter, setFilter] = useState<ReferenceFilter>("all");
  const [claimFilter, setClaimFilter] = useState<ClaimFilter>("all");
  const claimsHeadingRef = useRef<HTMLDivElement | null>(null);

  const recordsById = useMemo(() => {
    const map = new Map<string, MetadataRecordView>();
    for (const record of metadataRecords.data ?? []) {
      map.set(record.referenceId, record);
    }
    return map;
  }, [metadataRecords.data]);

  /** 点击语义核验统计 → 过滤明细并滚动到列表 */
  const filterClaims = (verdict: ClaimFilter) => {
    setClaimFilter(verdict);
    claimsHeadingRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (citations.isPending) {
    return <Loading label="加载引用数据…" />;
  }
  if (citations.isError) {
    return (
      <ErrorState
        title="引用数据加载失败"
        message={formatApiError(citations.error)}
        detail={formatApiErrorDetail(citations.error)}
        onRetry={() => void citations.refetch()}
      />
    );
  }

  const summary = citations.data.summary;
  const references = citations.data.references;
  const report = integrity.data?.report;

  if (!summary.extracted) {
    return (
      <section className="section-block">
        <div className="section-head">
          <h2>引用核验</h2>
        </div>
        <div className="state-block state-empty">
          <strong>尚未提取引用</strong>
          <span>先在「PDF 与结构」上传论文 PDF，再提取参考文献与正文引用。提取是确定性的，不调用模型。</span>
          <div className="action-row">
            <button type="button" className="btn btn-primary" onClick={() => extract.mutate()} disabled={extract.isPending}>
              {extract.isPending ? "提取中…" : "提取引用"}
            </button>
          </div>
          {extract.isError ? (
            <p className="form-error" role="alert">
              {formatApiError(extract.error)}
            </p>
          ) : null}
        </div>
      </section>
    );
  }

  const busy = verifyMeta.isPending || verifyClaims.isPending || extract.isPending;

  const checkedSegments =
    report !== undefined
      ? METADATA_ORDER.map((status) => ({ tone: statusStyleOf(METADATA_STATUS_STYLES, status).tone, count: report.metadataByStatus[status] ?? 0 }))
      : [];
  const checkedTotal = checkedSegments.reduce((sum, seg) => sum + seg.count, 0);
  const unchecked = Math.max(0, summary.references - checkedTotal);

  const isFlagged = (record: MetadataRecordView | undefined) =>
    record !== undefined &&
    (record.status === "NOT_FOUND" ||
      record.status === "METADATA_MISMATCH" ||
      record.status === "PROVIDER_ERROR" ||
      record.status === "UNRESOLVED" ||
      record.probableFabrication);
  const visibleReferences = references.filter((reference) => {
    const record = recordsById.get(reference.referenceId);
    if (filter === "flagged") {
      return isFlagged(record);
    }
    if (filter === "unchecked") {
      return record === undefined;
    }
    return true;
  });
  const flaggedCount = references.filter((reference) => isFlagged(recordsById.get(reference.referenceId))).length;

  return (
    <div className="citations-panel">
      <p className="integrity-explain">
        两层核验：① 文献真实性——用外部学术库确定性比对；② 文献是否支持论断——基于真实检索证据的语义核验。
        查无此文不等于捏造，证据不足不等于不支持。
      </p>

      <div className="ledger-group">
        <section className="ledger-block">
          <div className="ledger-block-head">
            <h2 className="ledger-title">提取</h2>
            <button type="button" className="btn btn-small" onClick={() => extract.mutate()} disabled={busy}>
              {extract.isPending ? "提取中…" : "重新提取"}
            </button>
          </div>
          <div className="ledger">
            <span className="ledger-item">参考文献 {summary.references}</span>
            <span className="ledger-item">正文引用 {summary.callouts}</span>
            <span className="ledger-item" title="同一条文献可被多处引用关联">
              已关联 {summary.resolvedRelations}
              {summary.unresolvedRelations > 0 ? `，未关联 ${summary.unresolvedRelations}` : ""}
              {summary.invalidRelations > 0 ? `，无效 ${summary.invalidRelations}` : ""}
            </span>
          </div>
        </section>

        <section className="ledger-block">
          <div className="ledger-block-head">
            <h2 className="ledger-title">真实性核验（外部学术库）</h2>
            <button type="button" className="btn btn-small" onClick={() => verifyMeta.mutate()} disabled={busy}>
              {verifyMeta.isPending ? "核验中…" : "核验文献真实性"}
            </button>
          </div>
          <div className="ledger">
            {report !== undefined && checkedTotal > 0 ? (
              <>
                {METADATA_ORDER.filter((status) => (report.metadataByStatus[status] ?? 0) > 0).map((status) => {
                  const style = statusStyleOf(METADATA_STATUS_STYLES, status);
                  return <LedgerItem key={status} label={style.label} tone={style.tone} count={report.metadataByStatus[status] ?? 0} />;
                })}
                {unchecked > 0 ? <span className="ledger-item">未核验 {unchecked}</span> : null}
              </>
            ) : (
              <span className="ledger-item muted">尚未核验真实性</span>
            )}
          </div>
          {report !== undefined && checkedTotal > 0 ? <LedgerBar segments={[...checkedSegments, { tone: "neutral", count: unchecked }]} /> : null}
          {verifyMeta.isError ? (
            <p className="form-error" role="alert">
              真实性核验失败：{formatApiError(verifyMeta.error)}
            </p>
          ) : null}
        </section>

        <section className="ledger-block">
          <div className="ledger-block-head">
            <h2 className="ledger-title">语义核验（是否支持论断）</h2>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => verifyClaims.mutate()}
              disabled={busy || report === undefined || checkedTotal === 0}
              title={report === undefined || checkedTotal === 0 ? "先完成真实性核验" : `每次最多核验 ${SEMANTIC_VERIFY_LIMIT} 条（需要已配置模型）`}
            >
              {verifyClaims.isPending ? "语义核验中…" : "语义核验"}
            </button>
          </div>
          <div className="ledger">
            {report !== undefined && report.semantic.total > 0 ? (
              VERDICT_ORDER.filter((verdict) => (report.semantic.byVerdict[verdict] ?? 0) > 0).map((verdict) => {
                const style = statusStyleOf(SEMANTIC_VERDICT_STYLES, verdict);
                return (
                  <LedgerFilterItem
                    key={verdict}
                    label={style.label}
                    tone={style.tone}
                    count={report.semantic.byVerdict[verdict] ?? 0}
                    active={claimFilter === verdict}
                    onClick={() => filterClaims(claimFilter === verdict ? "all" : verdict)}
                  />
                );
              })
            ) : (
              <span className="ledger-item muted">
                {report === undefined || checkedTotal === 0 ? "需先完成真实性核验" : `尚未语义核验（每次最多 ${SEMANTIC_VERIFY_LIMIT} 条，需要已配置模型）`}
              </span>
            )}
          </div>
          {verifyClaims.isError ? (
            <p className="form-error" role="alert">
              语义核验失败：{formatApiError(verifyClaims.error)}
            </p>
          ) : null}
        </section>
      </div>

      <div ref={claimsHeadingRef}>
        <SemanticClaimsSection
          projectId={projectId}
          claims={claimRecords.data ?? []}
          references={references}
          metadataById={recordsById}
          filter={claimFilter}
          onFilterChange={setClaimFilter}
        />
      </div>

      <section className="section-block">
        <div className="section-head">
          <h2>参考文献</h2>
          <div className="action-row">
            <span className="section-note">{references.length} 条</span>
            <div className="segmented" role="radiogroup" aria-label="筛选参考文献">
              {(
                [
                  ["all", "全部"],
                  ["flagged", `需注意${flaggedCount > 0 ? ` ${flaggedCount}` : ""}`],
                  ["unchecked", "未核验"],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="segmented-option">
                  <input type="radio" name="reference-filter" value={value} checked={filter === value} onChange={() => setFilter(value)} />
                  {label}
                </label>
              ))}
            </div>
          </div>
        </div>
        {references.length === 0 ? (
          <div className="state-block state-empty">
            <strong>已提取，但未解析出参考文献条目</strong>
            <span>正文找到 {summary.callouts} 处引用标注；参考文献列表未能条目化，可能是版式特殊或没有编号。</span>
          </div>
        ) : visibleReferences.length === 0 ? (
          <p className="panel-empty">当前筛选下没有条目。</p>
        ) : (
          <div className="gutter-list ref-list">
            {visibleReferences.map((reference) => (
              <ReferenceRow key={reference.referenceId} reference={reference} record={recordsById.get(reference.referenceId)} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ReferenceRow({ reference, record }: { reference: ReferenceView; record?: MetadataRecordView }) {
  const canonicalDoi = record?.canonical?.doi ?? reference.doi;
  const software = record?.canonical?.software;
  const kind = record?.kind;
  const title = displayTitle(reference.title);
  const author = reference.authors?.[0];
  const metaParts = [
    author !== undefined ? `${author}${(reference.authors?.length ?? 0) > 1 ? " 等" : ""}` : undefined,
    reference.year !== undefined ? String(reference.year) : undefined,
    reference.venue,
  ].filter((part): part is string => part !== undefined && part !== "");

  const flagTone = record?.status === "NOT_FOUND" || record?.probableFabrication === true ? "danger" : record?.status === "METADATA_MISMATCH" ? "warn" : undefined;
  const statusStyle = record !== undefined ? statusStyleOf(METADATA_STATUS_STYLES, record.status) : undefined;

  return (
    <article className={`gutter-row ref-row${flagTone !== undefined ? ` ref-row-flag-${flagTone}` : ""}`}>
      <span className="gutter-num" title={reference.referenceId}>
        [{reference.number ?? reference.referenceId}]
      </span>
      <div className="gutter-body">
        {title !== undefined ? (
          <span className="ref-title">
            {title}
            {kind !== undefined && kind !== "scholarly_paper" ? (
              <span className="chip" title="引用类型（核验语义不同：软件经官方仓库核验）">
                {REFERENCE_KIND_LABELS[kind] ?? kind}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="ref-rawtext" title={stripSoftHyphens(reference.rawText)}>
            {stripSoftHyphens(reference.rawText)}
          </span>
        )}
        {metaParts.length > 0 ? (
          <span className="ref-meta">
            {metaParts.map((part, index) => (
              <span key={index} className="meta-part">
                {part}
              </span>
            ))}
          </span>
        ) : null}
        {software !== undefined ? (
          <span className="ref-software mono">
            <a href={software.repositoryUrl} target="_blank" rel="noreferrer">
              {software.repositoryUrl.replace(/^https?:\/\//, "")}
            </a>
            {software.homepage !== undefined && software.homepage !== "" ? (
              <>
                {" · "}
                <a href={software.homepage} target="_blank" rel="noreferrer">
                  官方文档
                </a>
              </>
            ) : null}
            {software.stars !== undefined ? <span className="muted"> · ★ {software.stars.toLocaleString()}</span> : null}
            <span className="muted ref-source">官方来源 GitHub</span>
          </span>
        ) : canonicalDoi !== undefined ? (
          <span className="ref-doi mono">
            {canonicalDoi}
            {record?.canonical !== undefined ? <span className="muted ref-source">来源 {record.canonical.provider}</span> : null}
          </span>
        ) : reference.arxivId !== undefined ? (
          <span className="ref-doi mono">arXiv:{reference.arxivId}</span>
        ) : record?.canonical !== undefined ? (
          <span className="ref-doi muted">来源 {record.canonical.provider}</span>
        ) : null}
        {record?.probableFabrication === true ? <span className="ref-flag ref-flag-danger">多个学术库一致查无此文（疑似捏造，需人工确认）</span> : null}
        {record?.mismatches !== undefined && record.mismatches.length > 0 ? (
          <span className="ref-flag ref-flag-warn">
            差异：{record.mismatches.map((m) => `${m.field}：文中 ${m.expected ?? "?"}，库中 ${m.actual ?? "?"}${m.note !== undefined ? `（${m.note}）` : ""}`).join("；")}
          </span>
        ) : null}
        {record !== undefined ? <VerificationDetails record={record} /> : null}
      </div>
      <div className="gutter-side">
        {statusStyle !== undefined ? <span className={`status status-tone-${statusStyle.tone}`}>{statusStyle.label}</span> : <span className="status">未核验</span>}
        <span className="ref-page" title="所在页">
          p{reference.page}
        </span>
      </div>
    </article>
  );
}

/** 折叠的核验详情：各库结果 / 匹配标题 / DOI / 检查时间。只展示事实，不展示内部分数 */
function VerificationDetails({ record }: { record: MetadataRecordView }) {
  const attempts = record.attempts ?? [];
  const canonical = record.canonical;
  if (attempts.length === 0 && canonical === undefined && record.checkedAt === undefined) {
    return null;
  }
  return (
    <details className="ref-details">
      <summary>核验详情</summary>
      <dl className="ref-details-list">
        {attempts.length > 0 ? (
          <>
            <dt>核验来源</dt>
            <dd>
              {attempts.map((attempt, index) => (
                <span key={index} className="ref-details-attempt">
                  {providerLabel(attempt.provider)}：{ATTEMPT_OUTCOME_LABELS[attempt.outcome] ?? attempt.outcome}
                </span>
              ))}
            </dd>
          </>
        ) : null}
        {canonical?.title !== undefined ? (
          <>
            <dt>匹配标题</dt>
            <dd>
              {canonical.title}
              {canonical.year !== undefined ? `（${canonical.year}）` : ""}
            </dd>
          </>
        ) : null}
        {canonical?.authors !== undefined && canonical.authors.length > 0 ? (
          <>
            <dt>库中作者</dt>
            <dd>{canonical.authors.slice(0, 3).join("，")}{canonical.authors.length > 3 ? " 等" : ""}</dd>
          </>
        ) : null}
        {canonical?.doi !== undefined ? (
          <>
            <dt>DOI</dt>
            <dd className="mono">{canonical.doi}</dd>
          </>
        ) : null}
        {record.checkedAt !== undefined ? (
          <>
            <dt>检查时间</dt>
            <dd>{new Date(record.checkedAt).toLocaleString()}</dd>
          </>
        ) : null}
      </dl>
    </details>
  );
}
