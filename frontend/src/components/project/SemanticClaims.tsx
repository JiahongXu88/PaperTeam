import { useMemo } from "react";

import {
  EVIDENCE_LEVEL_LABELS,
  METADATA_STATUS_STYLES,
  REASON_CODE_LABELS,
  SEMANTIC_VERDICT_STYLES,
  statusStyleOf,
} from "../common/status.js";
import { usePaper } from "../../hooks/queries.js";
import type {
  ClaimRecordView,
  EvidenceRecordView,
  MetadataRecordView,
  MetadataStatus,
  ReferenceView,
  SemanticVerdict,
} from "../../types/paper.js";

/**
 * 语义核验明细：逐条 (atomic claim, citation group) 记录，可按 verdict 筛选
 * （顶部统计数字点击即过滤到这里）。每条显示正文位置（页/章节）、原子论断
 * （复合句拆解产物；来源句可展开）、引用组（组内文献共同核验）、verdict、
 * 理由（含结构化 reasonCode）与真实证据；无证据时明示「无法自动判断，
 * 不代表引用存在错误」，不只有一个状态词。
 */

export type ClaimFilter = SemanticVerdict | "all";

export const CLAIM_FILTER_ORDER: readonly ClaimFilter[] = [
  "all",
  "SUPPORTED",
  "PARTIALLY_SUPPORTED",
  "UNSUPPORTED",
  "CONTRADICTED",
  "INSUFFICIENT_EVIDENCE",
  "SKIPPED",
  "NO_CONTRADICTION_DETECTED",
];

/** 后端把 PDF 行尾断词编码为软连字符（U+00AD）；展示时去掉 */
function stripSoftHyphens(text: string): string {
  return text.replace(/­/g, "");
}

export function SemanticClaimsSection({
  projectId,
  claims,
  references,
  metadataById,
  filter,
  onFilterChange,
}: {
  projectId: string;
  claims: ClaimRecordView[];
  references: ReferenceView[];
  metadataById: Map<string, MetadataRecordView>;
  filter: ClaimFilter;
  onFilterChange: (filter: ClaimFilter) => void;
}) {
  const paper = usePaper(projectId);
  const sectionTitle = useMemo(
    () => new Map((paper.data?.sections ?? []).map((section) => [section.sectionId, section.title])),
    [paper.data?.sections],
  );
  const referenceById = useMemo(() => new Map(references.map((r) => [r.referenceId, r])), [references]);

  const counts = useMemo(() => {
    const byVerdict = new Map<SemanticVerdict, number>();
    for (const claim of claims) {
      byVerdict.set(claim.verdict, (byVerdict.get(claim.verdict) ?? 0) + 1);
    }
    return byVerdict;
  }, [claims]);

  const visible = useMemo(
    () =>
      claims
        .filter((claim) => filter === "all" || claim.verdict === filter)
        .sort((a, b) => a.page - b.page || a.claimCitationId.localeCompare(b.claimCitationId)),
    [claims, filter],
  );

  return (
    <section className="section-block" data-testid="semantic-claims">
      <div className="section-head">
        <h2>语义核验明细</h2>
        <div className="segmented" role="radiogroup" aria-label="筛选语义核验记录">
          {CLAIM_FILTER_ORDER.map((value) => {
            const count = value === "all" ? claims.length : (counts.get(value) ?? 0);
            const label = value === "all" ? "全部" : statusStyleOf(SEMANTIC_VERDICT_STYLES, value).label;
            return (
              <label key={value} className="segmented-option" data-testid={`claim-filter-${value}`}>
                <input
                  type="radio"
                  name="claim-verdict-filter"
                  value={value}
                  checked={filter === value}
                  onChange={() => onFilterChange(value)}
                />
                {label} {count}
              </label>
            );
          })}
        </div>
      </div>
      {claims.length === 0 ? (
        <div className="state-block state-empty">
          <strong>尚无语义核验记录</strong>
          <span>完成真实性核验后运行「语义核验」，每条论断-引用对会生成一条记录。</span>
        </div>
      ) : visible.length === 0 ? (
        <p className="panel-empty">当前筛选下没有记录。</p>
      ) : (
        <div className="gutter-list claim-list">
          {visible.map((claim) => (
            <ClaimRow
              key={claim.claimCitationId}
              claim={claim}
              references={references}
              reference={referenceById.get(claim.referenceId)}
              metadata={metadataById.get(claim.referenceId)}
              sectionTitle={sectionTitle.get(claim.sectionId) ?? claim.sectionId}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ClaimRow({
  claim,
  reference,
  references,
  metadata,
  sectionTitle,
}: {
  claim: ClaimRecordView;
  reference?: ReferenceView;
  references: ReferenceView[];
  metadata?: MetadataRecordView;
  sectionTitle: string;
}) {
  const verdictStyle = statusStyleOf(SEMANTIC_VERDICT_STYLES, claim.verdict);
  const metadataStyle =
    claim.metadataStatus === "SKIPPED_NO_METADATA"
      ? undefined
      : statusStyleOf(METADATA_STATUS_STYLES, claim.metadataStatus as MetadataStatus, "未核验");
  const title = reference?.title !== undefined ? stripSoftHyphens(reference.title) : undefined;
  const refMeta = [
    reference?.authors?.[0] !== undefined
      ? `${reference.authors[0]}${(reference.authors?.length ?? 0) > 1 ? " 等" : ""}`
      : undefined,
    reference?.year !== undefined ? String(reference.year) : undefined,
  ].filter((part): part is string => part !== undefined);
  // 引用组（v4）：组内成员共同支撑论断（如 [35, 2, 5]）；旧记录 / 单引用 = 单成员
  const groupMembers = claim.referenceIds ?? [claim.referenceId];
  const isGroup = groupMembers.length > 1;
  const referenceById = new Map(references.map((r) => [r.referenceId, r]));
  const groupNumbers = groupMembers
    .map((referenceId) => referenceById.get(referenceId)?.number ?? referenceId)
    .join(", ");
  const excludedNumbers = (claim.excludedReferenceIds ?? [])
    .map((referenceId) => referenceById.get(referenceId)?.number ?? referenceId)
    .join(", ");

  return (
    <article className={`gutter-row claim-row claim-${claim.verdict.toLowerCase()}`} data-testid="claim-row">
      <span className="gutter-num" title={claim.claimCitationId}>
        p{claim.page}
      </span>
      <div className="gutter-body">
        <div className="finding-tags">
          <span
            className={`status status-tone-${verdictStyle.tone}`}
            title={
              claim.verdict === "INSUFFICIENT_EVIDENCE"
                ? "当前未获取到足够摘要或正文证据，不代表引用存在错误"
                : undefined
            }
          >
            {verdictStyle.label}
          </span>
          {claim.reasonCode !== undefined ? (
            <span className="chip" title={claim.reasonCode}>
              {REASON_CODE_LABELS[claim.reasonCode] ?? claim.reasonCode}
            </span>
          ) : null}
          {isGroup ? (
            <span
              className="chip"
              title="引用组：这些文献共同支撑该论断，不要求每篇单独覆盖论断全部内容"
              data-testid="citation-group-chip"
            >
              引用组 {claim.groupRawText ?? `[${groupNumbers}]`} 共同核验
            </span>
          ) : null}
          <span className="chip">{claim.priority === "obligatory" ? "关键论断" : "辅助论断"}</span>
          {metadataStyle !== undefined ? (
            <span className="chip" title="文献真实性（Layer 1）">
              文献：{metadataStyle.label}
            </span>
          ) : (
            <span className="chip">文献：未核验</span>
          )}
          {claim.status === "failed" ? <span className="chip chip-tone-danger">模型调用失败（可重试）</span> : null}
        </div>
        <blockquote className="finding-claim reading">「{stripSoftHyphens(claim.claimText)}」</blockquote>
        {claim.sourceSentence !== undefined && claim.sourceSentence !== claim.claimText ? (
          <details className="ref-details">
            <summary>来源句（含引用标记）</summary>
            <blockquote className="reading">{stripSoftHyphens(claim.sourceSentence)}</blockquote>
          </details>
        ) : null}
        <p className="claim-ref">
          正文位置：第 {claim.page} 页 · {sectionTitle}
          {isGroup ? (
            <>
              ；引用组 <span className="mono">{claim.groupRawText ?? `[${groupNumbers}]`}</span>（
              {groupMembers.length} 篇共同承担支撑责任）
              {excludedNumbers !== "" ? (
                <>
                  ；未参与核验：<span className="mono">[{excludedNumbers}]</span>（真实性未确立或无摘要）
                </>
              ) : null}
            </>
          ) : reference !== undefined ? (
            <>
              ；引用 <span className="mono">[{reference.number ?? claim.referenceId}]</span>{" "}
              {title ?? stripSoftHyphens(reference.rawText).slice(0, 100)}
              {refMeta.length > 0 ? `（${refMeta.join("，")}）` : ""}
            </>
          ) : (
            <>；引用 <span className="mono">[{claim.referenceId}]</span></>
          )}
        </p>
        {claim.reason !== undefined && claim.reason !== "" ? (
          <p className="claim-reason">
            理由：{claim.reason}
            {claim.reasonCode !== undefined ? (
              <span className="muted">（{REASON_CODE_LABELS[claim.reasonCode] ?? claim.reasonCode}）</span>
            ) : null}
          </p>
        ) : null}
        {claim.error !== undefined ? <p className="form-error">{claim.error}</p> : null}
        <ClaimEvidence evidence={claim.evidence} repositoryUrl={metadata?.canonical?.software?.repositoryUrl} />
      </div>
    </article>
  );
}

/** 证据区：有则列出（来源/等级/片段/DOI/URL/页码），无则明示 */
function ClaimEvidence({ evidence, repositoryUrl }: { evidence: EvidenceRecordView[]; repositoryUrl?: string }) {
  if (evidence.length === 0) {
    return (
      <p className="claim-evidence-empty" title="INSUFFICIENT_EVIDENCE 不是论文问题">
        当前未获得足够可核验的原文证据——自动核验无法判断，不代表引用存在错误。
      </p>
    );
  }
  return (
    <details className="ref-details">
      <summary>证据（{evidence.length} 条）</summary>
      <ul className="claim-evidence-list">
        {evidence.map((item, index) => (
          <li key={index}>
            <span className="claim-evidence-meta">
              来源 {item.source} · 等级 {EVIDENCE_LEVEL_LABELS[item.evidenceLevel] ?? item.evidenceLevel}
              {item.page !== undefined ? ` · p${item.page}` : ""}
            </span>
            <blockquote className="reading">{item.text}</blockquote>
            <span className="claim-evidence-links mono">
              {item.doi !== undefined ? (
                <a href={`https://doi.org/${item.doi}`} target="_blank" rel="noreferrer">
                  {item.doi}
                </a>
              ) : null}
              {item.url !== undefined ? (
                <a href={item.url} target="_blank" rel="noreferrer">
                  {item.url}
                </a>
              ) : null}
              {item.doi === undefined && item.url === undefined && repositoryUrl !== undefined ? (
                <a href={repositoryUrl} target="_blank" rel="noreferrer">
                  {repositoryUrl}
                </a>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
