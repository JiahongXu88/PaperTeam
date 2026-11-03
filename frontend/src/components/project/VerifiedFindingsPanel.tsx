import type { VerifiedFindingsGateSummaryView, VerifiedFindingCheckView, VerifiedFindingRecordView } from "../../types/api.js";

/**
 * M16 后续：审稿 finding 的确定性证书核验呈现（后端 verified-findings/v1 的纯展示，前端不重算）。
 *
 * - 已核验缺陷（L1）与「转写稿上可复算、需对照原件」分开显示；其余 finding 仍是 AI 意见（见审稿面板 / L2）。
 * - 每条证书给出：原文位置、原文数字、唯一绑定的单元格或所引表格、复算候选与最接近值、容差、输入指纹。
 * - 旧门禁产物没有本字段 → 明示「未评估」，不补任何「已核验」。
 * - 证书只证明被审文本内部的数值关系：不授权修改（修订仍需逐项批准），也不是期刊级学术判断。
 */
const STATUS_LABEL: Record<string, { label: string; tone: string }> = {
  VERIFIED_CONTRADICTED: { label: "已核验缺陷（L1）", tone: "danger" },
  CERTIFIED_ON_TRANSCRIPT: { label: "转写稿上可复算 · 需对照原件", tone: "warn" },
  NOT_CERTIFIED: { label: "未能证书化（仍是 AI 意见）", tone: "neutral" },
  NOT_APPLICABLE: { label: "不适用", tone: "neutral" },
};

const SOURCE_LABEL: Record<string, string> = {
  AUTHOR_SOURCE: "作者源稿",
  SOURCE_ATTESTED: "转写稿（已人工 QA 证明）",
  SOURCE_UNVERIFIED: "转写稿（未核验）",
  SOURCE_UNKNOWN: "来源未知",
};

function CheckDetail({ check }: { check: VerifiedFindingCheckView }) {
  return (
    <li data-testid="verified-finding-check" data-kind={check.kind} data-outcome={check.outcome}>
      <span className="chip">{check.kind === "TABLE_MULTIPLIER" ? "倍数复算" : "文表数值比对"}</span>{" "}
      原文 <code>{check.claim.raw}{check.kind === "TABLE_MULTIPLIER" ? "×" : check.claim.unit ?? ""}</code>（{check.claim.file}:{check.claim.line}）
      {check.counterpart !== undefined ? (
        <>
          {" "}↔ 单元格 <code>{check.counterpart.raw}</code>（{check.counterpart.rowKey.join(" / ")} · {check.counterpart.headerPath.join(" › ")}，{check.counterpart.file}:{check.counterpart.line}）
        </>
      ) : null}
      {check.recompute !== undefined ? (
        <>
          {" "}↔ {check.recompute.table.number !== null ? `Table ${check.recompute.table.number}` : check.recompute.table.label ?? "所引表格"}（{check.recompute.table.file}:{check.recompute.table.line}，经 {check.recompute.table.resolvedVia}）：
          候选 {check.recompute.candidates} 个，论断区间 [{check.recompute.claimInterval[0].toFixed(4)}, {check.recompute.claimInterval[1].toFixed(4)}]
          {check.recompute.nearest !== null ? `，最接近 ${check.recompute.nearest.value}（${check.recompute.nearest.formula}）` : ""}
        </>
      ) : null}
      <div className="faint">
        判定：{check.outcome} · 容差：{check.tolerance} · 输入指纹 {check.inputsSha256 === "" ? "—" : check.inputsSha256.slice(0, 12)}
      </div>
      <div className="faint">所在句：{check.claim.sentence}</div>
    </li>
  );
}

function RecordItem({ record }: { record: VerifiedFindingRecordView }) {
  const style = STATUS_LABEL[record.status] ?? { label: record.status, tone: "neutral" };
  const shownChecks = record.checks.filter((check) => check.outcome === "CONTRADICTED");
  return (
    <li data-testid="verified-finding" data-status={record.status}>
      <span className={`status status-tone-${style.tone}`}>{style.label}</span>{" "}
      <span className="faint">审稿意见 #{record.issueIndex + 1} · {record.category} · 模型标注 {record.severityObserved}</span>
      {record.statement !== null ? <p data-testid="verified-finding-statement">{record.statement}</p> : null}
      {shownChecks.length > 0 ? <ul className="quality-report-items">{shownChecks.map((check, index) => <CheckDetail key={index} check={check} />)}</ul> : null}
    </li>
  );
}

export function VerifiedFindingsPanel({ summary }: { summary: VerifiedFindingsGateSummaryView | undefined }) {
  if (summary === undefined) {
    return (
      <div className="note" data-testid="verified-findings" data-state="absent">
        本轮门禁产物没有审稿意见的证书核验（旧版本产物）：未评估，不代表任何意见已核验。重新评估后可见。
      </div>
    );
  }
  if (summary.status === "UNAVAILABLE") {
    return (
      <div className="note note-warn" data-testid="verified-findings" data-state="unavailable">
        审稿意见证书核验未执行（{summary.unavailableReason ?? "未知原因"}）：可复算的数值问题未核验，不代表没有。
      </div>
    );
  }
  const certified = summary.records.filter((record) => record.status === "VERIFIED_CONTRADICTED" || record.status === "CERTIFIED_ON_TRANSCRIPT");
  const dangling = summary.records.filter((record) => record.anchor.danglingReferences.length > 0);
  return (
    <section className="quality-report" data-testid="verified-findings" data-state="evaluated">
      <div className="quality-report-layer-head">
        <strong>确定性核验的审稿意见</strong>
        <span className="faint">
          被审文本：{SOURCE_LABEL[summary.summary.sourceVerification] ?? summary.summary.sourceVerification} · 可定位 {summary.summary.reliablyLocated ?? summary.summary.located}/{summary.summary.findings} · 含可核对数值 {summary.summary.checked} · 已核验缺陷 {summary.summary.verifiedContradicted} · 需对照原件 {summary.summary.certifiedOnTranscript}
        </span>
      </div>
      {certified.length > 0 ? (
        <ul className="quality-report-items">{certified.map((record) => <RecordItem key={record.findingId} record={record} />)}</ul>
      ) : (
        <p className="faint" data-testid="verified-findings-none">没有被证书证实的矛盾。未证实 ≠ 没有问题：其余审稿意见仍是待核验的 AI 意见。</p>
      )}
      {dangling.length > 0 ? (
        <ul className="quality-report-items" data-testid="verified-findings-dangling">
          {dangling.map((record) => (
            <li key={record.findingId}>
              <span className="status status-tone-warn">定位不可信</span> 审稿意见 #{record.issueIndex + 1} 点名了原文中确定不存在的 {record.anchor.danglingReferences.join("、")}（意见保留、待核验，不作为准确锚点）
            </li>
          ))}
        </ul>
      ) : null}
      {(summary.summary.unverifiableLocators ?? 0) > 0 ? (
        <p className="faint" data-testid="verified-findings-unverifiable-locators">
          另有 {summary.summary.unverifiableLocators} 条意见引用的表 / 图 / 公式编号无法在本输入中核对（例如转写稿丢失了公式编号）：未知，不代表不存在，也不代表已核实。
        </p>
      ) : null}
      <p className="section-note faint">
        证书只证明被审文本内部的数值关系（原文数字、唯一绑定或所引表格、显示精度区间）；它不授权任何修改（数值修改仍需在修订中逐项批准），也不是期刊学术水平判断。
      </p>
    </section>
  );
}
