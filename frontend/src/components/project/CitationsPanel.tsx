import { ErrorState, Loading } from "../common/StateViews.js";
import { METADATA_STATUS_STYLES, SEMANTIC_VERDICT_STYLES } from "../common/status.js";
import {
  useCitationIntegrity,
  useCitations,
  useExtractCitations,
  useMetadataRecords,
  useVerifyClaims,
  useVerifyMetadata,
} from "../../hooks/queries";
import { formatApiError } from "../../utils/errors.js";
import type { MetadataRecordView, MetadataStatus, ReferenceView } from "../../types/paper.js";

/**
 * Citation Integrity 面板（Visual Redesign 2026-09，Pass 2）。
 *
 * 三行「登记簿」各配自己的作用域按钮（提取 / 真实性 / 语义），账目对平：
 * Σ 状态计数 + 未核验 = References。两层核验严格区分：文献真实性 ≠
 * 文献支持论断；查无此文 ≠ 捏造，证据不足 ≠ 不支持。
 * 严重状态行用 2px 左缘色条 + 极淡底色，克制但扫读可辨。
 */

const METADATA_ORDER: MetadataStatus[] = [
  "VERIFIED",
  "METADATA_MISMATCH",
  "AMBIGUOUS",
  "NOT_FOUND",
  "UNRESOLVED",
];

const VERDICT_ORDER = [
  "SUPPORTED",
  "PARTIALLY_SUPPORTED",
  "UNSUPPORTED",
  "CONTRADICTED",
  "INSUFFICIENT_EVIDENCE",
] as const;

/** 状态型 ledger 项：dot + 「Label N」单一元素 */
function LedgerStatus({ style, count }: { style: { label: string; tone: string }; count: number }) {
  return (
    <span className={`ledger-item status status-tone-${style.tone}`}>
      {style.label} {count}
    </span>
  );
}

/** 完成度比例条：真实分布按占比渲染（宽度为 0 的段不渲染） */
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
          <span
            key={index}
            className={`ledger-bar-seg ledger-bar-seg-tone-${seg.tone}`}
            style={{ width: `${(seg.count / total) * 100}%` }}
          />
        ))}
    </div>
  );
}

/** 清洗显示标题：剥离行首 [n]；无标题时返回 undefined（由 rawText 降级展示） */
function displayTitle(title: string | undefined): string | undefined {
  if (title === undefined) {
    return undefined;
  }
  return title.replace(/^\[\d+\]\s*/, "").trim() || undefined;
}

export function CitationsPanel({ projectId }: { projectId: string }) {
  const citations = useCitations(projectId);
  const integrity = useCitationIntegrity(projectId);
  const metadataRecords = useMetadataRecords(projectId);
  const extract = useExtractCitations(projectId);
  const verifyMeta = useVerifyMetadata(projectId);
  const verifyClaims = useVerifyClaims(projectId);

  if (citations.isPending) {
    return <Loading label="加载引用数据…" />;
  }
  if (citations.isError) {
    return (
      <ErrorState
        title="引用数据加载失败"
        message={formatApiError(citations.error)}
        onRetry={() => void citations.refetch()}
      />
    );
  }

  const summary = citations.data.summary;
  const references = citations.data.references;
  const report = integrity.data?.report;

  if (!summary.extracted) {
    return (
      <section>
        <div className="section-head">
          <h2>引用核验</h2>
        </div>
        <div className="panel-coming">
          <strong>尚未提取引用</strong>
          <span>先在「PDF 与结构」上传最终 PDF，再提取引用。</span>
          <div className="action-row">
            <button
              type="button"
              className="btn btn-small"
              onClick={() => extract.mutate()}
              disabled={extract.isPending}
            >
              {extract.isPending ? "提取中…" : "提取引用"}
            </button>
            {extract.isError ? (
              <span className="form-error">{formatApiError(extract.error)}</span>
            ) : null}
          </div>
        </div>
      </section>
    );
  }

  const busy = verifyMeta.isPending || verifyClaims.isPending || extract.isPending;

  // 账目对平：已核验各状态 + 未核验 = References
  const checkedSegments =
    report !== undefined
      ? METADATA_ORDER.map((status) => ({
          tone: METADATA_STATUS_STYLES[status].tone,
          count: report.metadataByStatus[status],
        }))
      : [];
  const checkedTotal = checkedSegments.reduce((sum, seg) => sum + seg.count, 0);
  const unchecked = Math.max(0, summary.references - checkedTotal);

  return (
    <section className="page">
      <div className="integrity-head">
        <p className="integrity-explain">
          两层核验：① 文献真实性（外部学术库，确定性）② 文献是否支持论断（语义核验，真实检索证据）。
          查无此文 ≠ 捏造；证据不足 ≠ 不支持。
        </p>
      </div>

      <div className="ledger-gap">
        <div>
          <div className="ledger-block-head">
            <span className="ledger-title">提取</span>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => extract.mutate()}
              disabled={busy}
            >
              {extract.isPending ? "提取中…" : "重新提取"}
            </button>
          </div>
          <div className="ledger">
            <span className="ledger-item">参考文献条目 {summary.references}</span>
            <span className="ledger-item">正文引用 {summary.callouts}</span>
            <span className="ledger-item" title="同一引用可被多处 callout 关联">
              关联 {summary.resolvedRelations} · 未关联 {summary.unresolvedRelations} · 无效 {summary.invalidRelations}
            </span>
          </div>
        </div>

        <div>
          <div className="ledger-block-head">
            <span className="ledger-title">真实性核验（外部学术库）</span>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => verifyMeta.mutate()}
              disabled={busy}
            >
              {verifyMeta.isPending ? "核验中（外部学术库）…" : "核验文献真实性"}
            </button>
          </div>
          <div className="ledger">
            {report !== undefined ? (
              <>
                {METADATA_ORDER.filter((status) => report.metadataByStatus[status] > 0).map((status) => (
                  <LedgerStatus
                    key={status}
                    style={METADATA_STATUS_STYLES[status]}
                    count={report.metadataByStatus[status]}
                  />
                ))}
                {unchecked > 0 ? (
                  <span className="ledger-item">未核验 {unchecked}</span>
                ) : null}
              </>
            ) : (
              <span className="ledger-item">尚未核验真实性</span>
            )}
          </div>
          {report !== undefined && unchecked > 0 ? (
            <LedgerBar segments={[...checkedSegments, { tone: "neutral", count: unchecked }]} />
          ) : null}
        </div>

        {report !== undefined ? (
          <div>
            <div className="ledger-block-head">
              <span className="ledger-title">语义核验（是否支持论断）</span>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => verifyClaims.mutate()}
                disabled={busy}
                title="需要已配置模型"
              >
                {verifyClaims.isPending ? "语义核验中（模型）…" : "语义核验"}
              </button>
            </div>
            <div className="ledger">
              {VERDICT_ORDER.filter((verdict) => report.semantic.byVerdict[verdict] > 0).map(
                (verdict) => (
                  <LedgerStatus
                    key={verdict}
                    style={SEMANTIC_VERDICT_STYLES[verdict]}
                    count={report.semantic.byVerdict[verdict]}
                  />
                ),
              )}
              {report.semantic.total === 0 ? (
                <span className="ledger-item">尚未语义核验</span>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {verifyMeta.isError ? (
        <p className="form-error" role="alert">
          真实性核验失败：{formatApiError(verifyMeta.error)}
        </p>
      ) : null}
      {verifyClaims.isError ? (
        <p className="form-error" role="alert">
          语义核验失败：{formatApiError(verifyClaims.error)}
          （需要已配置模型）
        </p>
      ) : null}

      <section>
        <div className="section-head">
          <h2>参考文献</h2>
          <span className="section-note">{references.length} 条</span>
        </div>
        {references.length > 0 ? (
          <div className="ref-list">
            {references.map((reference) => (
              <ReferenceRow
                key={reference.referenceId}
                reference={reference}
                record={metadataRecords.data?.find(
                  (entry: { referenceId: string }) => entry.referenceId === reference.referenceId,
                )}
              />
            ))}
          </div>
        ) : (
          <div className="panel-coming">
            <strong>已提取，但未解析出参考文献条目</strong>
            <span>
              正文找到 {summary.callouts} 处引用标注；参考文献列表的条目化解析将在后续里程碑增强。
            </span>
          </div>
        )}
      </section>
    </section>
  );
}

function ReferenceRow({
  reference,
  record,
}: {
  reference: ReferenceView;
  record?: MetadataRecordView;
}) {
  const canonicalDoi = record?.canonical?.doi ?? reference.doi;
  const title = displayTitle(reference.title);
  const metaLine = [
    reference.authors?.[0] !== undefined
      ? `${reference.authors[0]}${reference.authors.length > 1 ? " et al." : ""}`
      : undefined,
    reference.year !== undefined ? String(reference.year) : undefined,
    reference.venue,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");

  const flagTone =
    record?.status === "NOT_FOUND" ? "danger"
    : record?.probableFabrication === true ? "danger"
    : record?.status === "METADATA_MISMATCH" ? "warn"
    : undefined;

  return (
    <article className={`ref-row${flagTone !== undefined ? ` ref-row-flag-${flagTone}` : ""}`}>
      <span className="ref-num" title={reference.referenceId}>
        {reference.number ?? reference.referenceId}
      </span>
      <div className="ref-main">
        {title !== undefined ? (
          <span className="ref-title">{title}</span>
        ) : (
          <span className="ref-rawtext" title={reference.rawText}>
            {reference.rawText}
          </span>
        )}
        {metaLine !== "" ? <span className="ref-meta">{metaLine}</span> : null}
        {canonicalDoi !== undefined ? (
          <span className="ref-doi">
            {canonicalDoi}
            {record?.canonical !== undefined ? ` · 来源 ${record.canonical.provider}` : ""}
          </span>
        ) : reference.arxivId !== undefined ? (
          <span className="ref-doi">arXiv:{reference.arxivId}</span>
        ) : record?.canonical !== undefined ? (
          <span className="ref-doi">来源 {record.canonical.provider}</span>
        ) : null}
        {record?.probableFabrication === true ? (
          <span className="ref-flag ref-flag-danger">多源一致查无此文（疑似捏造，需人工确认）</span>
        ) : null}
        {record?.mismatches !== undefined && record.mismatches.length > 0 ? (
          <span className="ref-flag ref-flag-warn">
            差异：{record.mismatches.map((m) => `${m.field}：文中 ${m.expected ?? "?"} · 库中 ${m.actual ?? "?"}`).join("；")}
          </span>
        ) : null}
      </div>
      <div className="ref-side">
        {record !== undefined ? (
          <span className={`status status-tone-${METADATA_STATUS_STYLES[record.status].tone}`}>
            {METADATA_STATUS_STYLES[record.status].label}
          </span>
        ) : (
          <span className="status status-tone-neutral">未核验</span>
        )}
        <span className="ref-page" title="正文引用所在页">
          p{reference.page}
        </span>
      </div>
    </article>
  );
}
