import { useAcademicStyleAudit } from "../../hooks/queries.js";
import type {
  AcademicStyleAuditView,
  AcademicStyleCoverageState,
  AcademicStyleFindingView,
  AcademicStyleRevisionItemView,
  AcademicStyleRevisionStatus,
} from "../../types/api.js";

/**
 * M17.1 学术风格与过度防御性表达审查卡（默认必检；只读）。
 *
 * 展示纪律：覆盖状态如实（部分 / 未审查不显示为通过）；不输出 AI 率 / AI 概率；
 * 「需要证据或作者决定」的条目明确显示为未修改，不当作已修复。
 */

const COVERAGE: Record<AcademicStyleCoverageState, { label: string; tone: string }> = {
  COMPLETE: { label: "已审查", tone: "ok" },
  PARTIAL: { label: "部分审查", tone: "warn" },
  FAILED: { label: "未审查（审查失败）", tone: "danger" },
  NOT_APPLICABLE: { label: "不适用", tone: "neutral" },
  DISABLED: { label: "未审查（诊断开关关闭）", tone: "warn" },
};

const CATEGORY: Record<string, string> = {
  uninformative_hedge: "无信息限定 / 对冲堆叠",
  repeated_modesty_apology: "重复自谦 / 道歉",
  mechanical_template: "机械模板套话",
  empty_summary_transition: "空泛总结 / 过渡",
  unnatural_wording: "不自然的语言组织",
  understated_contribution: "贡献被无端弱化",
  required_limitation: "科学必要限定（保留）",
  negative_result_disclosure: "负结果 / 风险披露（保留）",
  overclaim_risk: "存在 overclaim 风险",
};

const REVISION: Record<AcademicStyleRevisionStatus, { label: string; tone: string }> = {
  AUTO_FIXED: { label: "已定点修订", tone: "ok" },
  KEPT: { label: "保留原文", tone: "neutral" },
  AUTHOR_DECISION: { label: "未修改：需要证据或作者决定", tone: "warn" },
  NOT_DISPATCHED: { label: "未修改：待处理", tone: "neutral" },
  GUARD_REJECTED: { label: "未修改：守卫拒绝", tone: "warn" },
  SEMANTIC_REJECTED: { label: "未修改：语义复核判定会改变命题", tone: "warn" },
  ANCHOR_LOST: { label: "未修改：原句已变化 / 不唯一", tone: "neutral" },
  STALE: { label: "未修改：结果已过期", tone: "neutral" },
};

export function AcademicStyleAuditCard({ projectId }: { projectId: string }) {
  const audit = useAcademicStyleAudit(projectId);
  if (audit.isPending || audit.isError) {
    return null; // 辅助信息：失败不打断主面板
  }
  return <AcademicStyleAuditCardView view={audit.data} />;
}

export function AcademicStyleAuditCardView({ view }: { view: AcademicStyleAuditView }) {
  const { report, revision } = view;
  if (report === null) {
    return null;
  }
  const coverage = COVERAGE[report.coverage.state] ?? { label: report.coverage.state, tone: "neutral" };
  const revisionItems = revision !== null && revision.reviewRound >= report.round - 1 ? revision.items : [];
  const itemByFinding = new Map(revisionItems.map((item) => [item.findingId, item]));
  const fixed = revisionItems.filter((item) => item.status === "AUTO_FIXED");
  const unresolved = report.findings.filter((finding) => finding.disposition === "AUTHOR_DECISION");
  const kept = report.findings.filter((finding) => finding.disposition === "KEEP");
  const incompleteUnits = report.units.filter((unit) => unit.status === "FAILED" || unit.status === "SKIPPED_BUDGET");
  const categories = Object.entries(report.counts.byCategory).sort((a, b) => b[1] - a[1]);
  return (
    <section className="panel section-block" data-testid="academic-style-audit-card">
      <div className="section-head">
        <h2>学术风格与防御性表达</h2>
        <span className="faint">默认审查：模板化套话、无信息限定、重复自谦、贡献弱化；必要科学限定与负结果保留。不是 AI 生成检测。</span>
      </div>
      <dl className="meta-list meta-list-2col">
        <div>
          <dt>审查覆盖</dt>
          <dd>
            <span className={`status status-tone-${coverage.tone}`} data-testid="academic-style-coverage">{coverage.label}</span>
            {report.coverage.state !== "NOT_APPLICABLE" ? ` ${report.coverage.completedUnits + report.coverage.reusedUnits}/${report.coverage.eligibleUnits} 个正文单元` : ""}
          </dd>
        </div>
        <div>
          <dt>发现</dt>
          <dd data-testid="academic-style-counts">
            本轮 {report.counts.findings} 条（可自动修订 {report.counts.byDisposition.AUTO_REWRITE_ELIGIBLE} · 保留 {kept.length} · 待作者决定 {unresolved.length}）
          </dd>
        </div>
        <div>
          <dt>审查轮次</dt>
          <dd className="mono">r{report.round}{report.reviewedRevision !== undefined ? ` · rev ${report.reviewedRevision}` : ""}</dd>
        </div>
        <div>
          <dt>定点修订</dt>
          <dd data-testid="academic-style-revision">
            {revision === null
              ? "—（尚未执行）"
              : revision.status === "applied" && revision.revision !== undefined
                ? `rev ${revision.sourceRevision} → rev ${revision.revision}（${fixed.length} 处）`
                : revision.status === "stale" ? "未执行（审查结果已过期）" : `未改动（${revision.items.length} 条均保持原文）`}
          </dd>
        </div>
      </dl>
      {incompleteUnits.length > 0 || report.coverage.reasons.length > 0 ? (
        <p className="note note-warn" role="status" data-testid="academic-style-incomplete">
          <span>
            未完成审查的单元：{incompleteUnits.length > 0 ? incompleteUnits.slice(0, 6).map((unit) => `${unit.heading}（${unit.status === "FAILED" ? "失败" : "预算跳过"}）`).join("、") : report.coverage.reasons.slice(0, 2).join("；")}
            ——这些部分的风格问题未知，不代表没有问题。
          </span>
        </p>
      ) : null}
      {categories.length > 0 ? (
        <div className="chip-row" data-testid="academic-style-categories">
          {categories.map(([category, count]) => (
            <span key={category} className="chip chip-tone-neutral">{CATEGORY[category] ?? category} {count}</span>
          ))}
        </div>
      ) : null}
      {fixed.length > 0 ? (
        <details className="details-block" open data-testid="academic-style-fixed">
          <summary>已定点修订（{fixed.length}）</summary>
          <ul className="finding-list">
            {fixed.map((item) => <RevisionDiff key={item.findingId} item={item} />)}
          </ul>
        </details>
      ) : null}
      {unresolved.length > 0 ? (
        <details className="details-block" data-testid="academic-style-unresolved">
          <summary>未修改：需要证据或作者决定（{unresolved.length}）</summary>
          <ul className="finding-list">
            {unresolved.map((finding) => <FindingRow key={finding.id} finding={finding} item={itemByFinding.get(finding.id)} />)}
          </ul>
        </details>
      ) : null}
      {revisionItems.some((item) => item.status !== "AUTO_FIXED") ? (
        <details className="details-block" data-testid="academic-style-rejected">
          <summary>尝试修订但保持原文（{revisionItems.filter((item) => item.status !== "AUTO_FIXED").length}）</summary>
          <ul className="finding-list">
            {revisionItems.filter((item) => item.status !== "AUTO_FIXED").map((item) => (
              <li key={item.findingId}>
                <span className="mono">{item.heading}</span> · <StatusChip status={item.status} /> {item.detail}
                <blockquote className="style-quote">{item.before}</blockquote>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {kept.length > 0 ? (
        <details className="details-block" data-testid="academic-style-kept">
          <summary>保留的必要限定 / 负结果（{kept.length}）</summary>
          <ul className="finding-list">
            {kept.map((finding) => <FindingRow key={finding.id} finding={finding} item={undefined} />)}
          </ul>
        </details>
      ) : null}
      <p className="faint">{report.disclaimer}</p>
    </section>
  );
}

function StatusChip({ status }: { status: AcademicStyleRevisionStatus }) {
  const style = REVISION[status] ?? { label: status, tone: "neutral" };
  return <span className={`chip chip-tone-${style.tone === "ok" ? "accent" : style.tone}`}>{style.label}</span>;
}

function RevisionDiff({ item }: { item: AcademicStyleRevisionItemView }) {
  return (
    <li>
      <span className="mono">{item.heading}</span> · {CATEGORY[item.styleCategory] ?? item.styleCategory}
      <div className="style-diff">
        <del>{item.before}</del>
        {item.after === "" ? <span className="faint">（整句删除）</span> : <ins>{item.after}</ins>}
      </div>
    </li>
  );
}

function FindingRow({ finding, item }: { finding: AcademicStyleFindingView; item: AcademicStyleRevisionItemView | undefined }) {
  return (
    <li>
      <span className="mono">{finding.heading}</span> · {CATEGORY[finding.styleCategory] ?? finding.styleCategory}
      {item !== undefined ? <> · <StatusChip status={item.status} /></> : null}
      <blockquote className="style-quote">{finding.originalQuote}</blockquote>
      {finding.candidateReason !== "" ? <div>审稿理由：{finding.candidateReason}</div> : null}
      {finding.evidenceConstraints.length > 0 ? <div>承载的限制：{finding.evidenceConstraints.join("；")}</div> : null}
      <div className="faint">处置：{finding.dispositionReason}</div>
      {finding.proposedRewrite !== undefined && finding.disposition !== "KEEP" ? (
        <div>建议改写（未应用）：{finding.proposedRewrite === "" ? "删除该片段" : finding.proposedRewrite}</div>
      ) : null}
    </li>
  );
}
