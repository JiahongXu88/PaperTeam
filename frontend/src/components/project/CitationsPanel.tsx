import { ErrorState, Loading } from "../common/StateViews.js";
import {
  useCitationIntegrity,
  useCitations,
  useExtractCitations,
  useMetadataRecords,
  useVerifyClaims,
  useVerifyMetadata,
} from "../../hooks/queries.js";
import type { MetadataStatus, ReferenceView } from "../../types/paper.js";

/**
 * Citation Integrity 面板（M4.3.7）：
 * 摘要（真实性五态 + 语义 verdict 分布）→ reference 明细（status / canonical /
 * 被引页）。两层核验严格区分：文献真实性 ≠ 文献支持论断。
 */

const METADATA_STATUS_LABEL: Record<MetadataStatus, string> = {
  VERIFIED: "Verified",
  METADATA_MISMATCH: "Metadata Mismatch",
  AMBIGUOUS: "Ambiguous",
  NOT_FOUND: "Not Found",
  UNRESOLVED: "Unresolved",
};

function StatusChip({ status }: { status: MetadataStatus }) {
  return <span className={`chip meta-${status.toLowerCase()}`}>{METADATA_STATUS_LABEL[status]}</span>;
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
        message={citations.error instanceof Error ? citations.error.message : String(citations.error)}
        onRetry={() => void citations.refetch()}
      />
    );
  }

  const summary = citations.data.summary;
  const references = citations.data.references;
  const report = integrity.data?.report;

  if (!summary.extracted) {
    return (
      <div className="panel">
        <h2>Citation Integrity</h2>
        <p className="panel-empty">尚未提取引用。先在「PDF / Structure」上传 Final PDF 并提取引用。</p>
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
            <span className="form-error">
              {extract.error instanceof Error ? extract.error.message : String(extract.error)}
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  const busy = verifyMeta.isPending || verifyClaims.isPending || extract.isPending;

  return (
    <div className="panel-stack">
      <div className="panel">
        <h2>Citation Integrity</h2>
        <p className="form-note">
          两层核验：① 文献真实性（外部学术库，确定性）② 文献是否支持论断
          （(claim, citation) 语义核验，真实检索证据）。查无此文 ≠ 捏造；
          证据不足 ≠ 不支持。
        </p>
        <div className="chip-row">
          <span className="chip">References {summary.references}</span>
          <span className="chip">Callouts {summary.callouts}</span>
          <span className="chip">
            关联 {summary.resolvedRelations} / 未关联 {summary.unresolvedRelations} / 无效 {summary.invalidRelations}
          </span>
          {report !== undefined ? (
            (Object.keys(report.metadataByStatus) as MetadataStatus[]).map((status) =>
              report.metadataByStatus[status] > 0 ? (
                <span key={status} className={`chip meta-${status.toLowerCase()}`}>
                  {METADATA_STATUS_LABEL[status]} {report.metadataByStatus[status]}
                </span>
              ) : null,
            )
          ) : (
            <span className="chip">尚未核验真实性</span>
          )}
        </div>
        {report !== undefined ? (
          <div className="chip-row semantic-row">
            {Object.entries(report.semantic.byVerdict)
              .filter(([, count]) => count > 0)
              .map(([verdict, count]) => (
                <span key={verdict} className={`chip verdict-${verdict.toLowerCase()}`}>
                  {verdict.replace("_", " ")} {count}
                </span>
              ))}
            {report.semantic.total === 0 ? <span className="chip">尚未语义核验</span> : null}
          </div>
        ) : null}
        <div className="action-row">
          <button
            type="button"
            className="btn btn-small"
            onClick={() => extract.mutate()}
            disabled={busy}
          >
            {extract.isPending ? "提取中…" : "重新提取"}
          </button>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => verifyMeta.mutate()}
            disabled={busy}
          >
            {verifyMeta.isPending ? "核验中（外部学术库）…" : "核验文献真实性"}
          </button>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => verifyClaims.mutate()}
            disabled={busy}
          >
            {verifyClaims.isPending ? "语义核验中（模型）…" : "语义核验（claim 支持）"}
          </button>
        </div>
        {verifyMeta.isError ? (
          <p className="form-error">
            真实性核验失败：{verifyMeta.error instanceof Error ? verifyMeta.error.message : String(verifyMeta.error)}
          </p>
        ) : null}
        {verifyClaims.isError ? (
          <p className="form-error">
            语义核验失败：{verifyClaims.error instanceof Error ? verifyClaims.error.message : String(verifyClaims.error)}
            （需要已配置模型）
          </p>
        ) : null}
      </div>

      <div className="panel">
        <h2>References</h2>
        <table className="runs-table">
          <thead>
            <tr>
              <th>#</th>
              <th>条目</th>
              <th>真实性</th>
              <th>Canonical / DOI</th>
              <th>页</th>
            </tr>
          </thead>
          <tbody>
            {references.map((reference) => (
              <ReferenceRow
                key={reference.referenceId}
                reference={reference}
                record={metadataRecords.data?.find(
                  (entry: { referenceId: string }) => entry.referenceId === reference.referenceId,
                )}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReferenceRow({
  reference,
  record,
}: {
  reference: ReferenceView;
  record?: import("../../types/paper.js").MetadataRecordView;
}) {
  const canonicalDoi = record?.canonical?.doi ?? reference.doi;
  return (
    <tr>
      <td className="mono">{reference.referenceId}</td>
      <td className="ref-cell">
        <span className="ref-title">{reference.title ?? reference.rawText.slice(0, 90)}</span>
        <span className="ref-meta">
          {[
            reference.authors?.[0] !== undefined
              ? `${reference.authors[0]}${reference.authors.length > 1 ? " et al." : ""}`
              : undefined,
            reference.year !== undefined ? String(reference.year) : undefined,
            reference.venue,
          ]
            .filter((part): part is string => part !== undefined)
            .join(" · ")}
        </span>
        {record?.probableFabrication === true ? (
          <span className="ref-meta fabricate-warning">⚠ 多源一致查无此文（疑似捏造，需人工确认）</span>
        ) : null}
        {record?.mismatches !== undefined && record.mismatches.length > 0 ? (
          <span className="ref-meta">
            差异：{record.mismatches.map((m) => `${m.field}（${m.expected ?? "?"} vs ${m.actual ?? "?"}）`).join("；")}
          </span>
        ) : null}
      </td>
      <td>
        {record !== undefined ? (
          <StatusChip status={record.status} />
        ) : (
          <span className="chip">未核验</span>
        )}
      </td>
      <td className="ref-canonical">
        {canonicalDoi !== undefined ? (
          <span className="mono">{canonicalDoi}</span>
        ) : reference.arxivId !== undefined ? (
          <span className="mono">arXiv:{reference.arxivId}</span>
        ) : (
          "—"
        )}
        {record?.canonical !== undefined ? (
          <span className="ref-meta">via {record.canonical.provider}</span>
        ) : null}
      </td>
      <td>p{reference.page}</td>
    </tr>
  );
}
