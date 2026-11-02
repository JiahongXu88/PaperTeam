import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ErrorState, Loading } from "../common/StateViews.js";
import {
  ARTICLE_TYPE_LABELS,
  convertJournalCriteriaToRevision,
  evaluateJournalAssessment,
  getJournalAssessment,
  listJournalProfiles,
  refreshJournalProfile,
  type CriterionStatus,
  type EvidenceLevel,
  type JournalArticleType,
  type JournalAssessmentVerdict,
  type JournalAssessmentView,
  type JournalCriterionView,
  type JournalVerificationStatus,
} from "../../api/journalAssessment.js";
import { queryKeys } from "../../hooks/queries.js";
import { formatApiError } from "../../utils/errors.js";
import { formatDateTime } from "../../utils/format.js";

/**
 * 目标期刊评估（M15 TJA）：选期刊 + 稿型 → 生成评估 → 四块可展开报告（A 投稿要求 / B 质量风险 /
 * C 期刊匹配 / D 结论）→ 逐条把可改写项转入修改意见队列（之后走既有修订流程与编辑契约）。
 *
 * 纯呈现：结论、计数、证据等级全部来自后端评估工件，前端不重算、不合成分数。
 */

const VERDICT_LABELS: Record<JournalAssessmentVerdict, string> = {
  READY_FOR_AUTHOR_SUBMISSION_REVIEW: "可检查要求无阻断（待作者投稿前复核）",
  CHANGES_REQUIRED: "需要修改",
  BLOCKED_BY_VERIFIED_ISSUE: "存在已证实的阻断问题",
  INSUFFICIENT_EVIDENCE: "证据不足，无法给出结论",
  JOURNAL_PROFILE_UNVERIFIED: "期刊规则来源未验证",
};

const VERDICT_TONE: Record<JournalAssessmentVerdict, string> = {
  READY_FOR_AUTHOR_SUBMISSION_REVIEW: "chip-tone-accent",
  CHANGES_REQUIRED: "chip-tone-warn",
  BLOCKED_BY_VERIFIED_ISSUE: "chip-tone-danger",
  INSUFFICIENT_EVIDENCE: "chip-tone-neutral",
  JOURNAL_PROFILE_UNVERIFIED: "chip-tone-neutral",
};

const STATUS_LABELS: Record<CriterionStatus, string> = {
  SATISFIED: "满足",
  VIOLATED: "不符",
  NOT_EVALUATED: "未评估",
  NOT_APPLICABLE: "不适用",
};

const EVIDENCE_LABELS: Record<EvidenceLevel, string> = {
  verified: "已证实",
  "author-check": "需作者确认",
  "model-opinion": "模型意见（未校准）",
  unassessed: "未评估",
};

const TRUST_LABELS: Record<JournalVerificationStatus, string> = {
  VERIFIED_SNAPSHOT: "官方页面快照（未在线复核）",
  VERIFIED_LIVE: "已在线复核",
  STALE: "快照过期",
  SOURCE_CHANGED: "官方页面已变化",
  UNREACHABLE: "官方页面不可达",
  UNVERIFIED: "未验证",
};

const ARTICLE_TYPES = Object.keys(ARTICLE_TYPE_LABELS) as JournalArticleType[];

export function JournalAssessmentPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [journalId, setJournalId] = useState("");
  const [articleType, setArticleType] = useState<JournalArticleType>("research");
  const [includeModelReview, setIncludeModelReview] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const profiles = useQuery({ queryKey: ["journal", projectId, "profiles"], queryFn: ({ signal }) => listJournalProfiles(projectId, signal) });
  const assessment = useQuery({ queryKey: ["journal", projectId, "assessment"], queryFn: ({ signal }) => getJournalAssessment(projectId, signal) });
  const effectiveJournal = journalId || assessment.data?.journal.journalId || profiles.data?.[0]?.journalId || "";
  const profile = profiles.data?.find((item) => item.journalId === effectiveJournal);

  const evaluate = useMutation({
    mutationFn: () => evaluateJournalAssessment(projectId, { journalId: effectiveJournal, articleType, includeModelReview }),
    onSuccess: (result) => {
      setActionError(null);
      setSelected([]);
      setMessage(null);
      queryClient.setQueryData(["journal", projectId, "assessment"], result.assessment);
    },
    onError: (error) => setActionError(formatApiError(error)),
  });
  const refresh = useMutation({
    mutationFn: () => refreshJournalProfile(projectId, effectiveJournal),
    onSuccess: (result) => {
      setActionError(null);
      setMessage(`来源复核：${TRUST_LABELS[result.trust.status]}——${result.trust.note}`);
      void queryClient.invalidateQueries({ queryKey: ["journal", projectId, "profiles"] });
    },
    onError: (error) => setActionError(formatApiError(error)),
  });
  const convert = useMutation({
    mutationFn: (input: { assessmentId: string; criterionIds: string[] }) => convertJournalCriteriaToRevision(projectId, input),
    onSuccess: (result) => {
      setActionError(null);
      setSelected([]);
      setMessage(`已转入修改意见队列 ${result.created.length} 条${result.skipped.length > 0 ? `；跳过 ${result.skipped.length} 条（${result.skipped.map((s) => s.reason).join("；")}）` : ""}。在「审稿意见」中启动修订后仍受编辑契约约束，不授权任何数值修改。`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.externalInstructions(projectId) });
    },
    onError: (error) => setActionError(formatApiError(error)),
  });

  return (
    <section className="target-guideline" data-testid="journal-assessment-panel">
      <div className="gate-rules-head">
        <h3>目标期刊评估</h3>
        <span className="faint">对照期刊官方明文要求与已证实缺陷；不预测录用、不给分数</span>
      </div>
      {profiles.isPending ? (
        <Loading label="加载期刊规则库…" />
      ) : profiles.isError ? (
        <ErrorState title="期刊规则库加载失败" message={formatApiError(profiles.error)} onRetry={() => void profiles.refetch()} />
      ) : (
        <div className="journal-assessment-form" style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "end", margin: "8px 0 12px" }}>
          <label>
            目标期刊
            <select data-testid="journal-select" value={effectiveJournal} onChange={(event) => setJournalId(event.target.value)}>
              {profiles.data.map((item) => (
                <option key={item.journalId} value={item.journalId}>
                  {item.displayName}
                  {item.nameEn !== undefined && item.nameEn !== item.displayName ? `（${item.nameEn}）` : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            文章类型
            <select data-testid="journal-article-type" value={articleType} onChange={(event) => setArticleType(event.target.value as JournalArticleType)}>
              {ARTICLE_TYPES.map((type) => (
                <option key={type} value={type}>{ARTICLE_TYPE_LABELS[type]}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" data-testid="journal-include-model" checked={includeModelReview} onChange={(event) => setIncludeModelReview(event.target.checked)} />
            附加模型意见（消耗 1–2 次模型调用，未校准）
          </label>
          <button type="button" className="btn btn-primary btn-small" data-testid="journal-evaluate" disabled={effectiveJournal === "" || evaluate.isPending} onClick={() => evaluate.mutate()}>
            {evaluate.isPending ? "评估中…" : "生成评估"}
          </button>
          <button type="button" className="btn btn-small" data-testid="journal-refresh-source" disabled={effectiveJournal === "" || refresh.isPending} onClick={() => refresh.mutate()}>
            {refresh.isPending ? "复核中（逐页抓取）…" : "在线复核来源"}
          </button>
        </div>
      )}
      {profile !== undefined ? (
        <p className="faint" data-testid="journal-profile-trust" data-status={profile.verification.status}>
          规则来源：{TRUST_LABELS[profile.verification.status]} · {profile.verification.note} · 规则版本 {profile.rulesVersion} · {profile.ruleCount} 条
        </p>
      ) : null}
      {actionError !== null ? <div className="state-block state-error" role="alert">{actionError}</div> : null}
      {message !== null ? <div className="state-block" data-testid="journal-message">{message}</div> : null}

      {assessment.isPending ? (
        <Loading label="加载上次评估…" />
      ) : assessment.isError ? (
        <ErrorState title="评估加载失败" message={formatApiError(assessment.error)} onRetry={() => void assessment.refetch()} />
      ) : assessment.data === null ? (
        <div className="state-block state-empty" data-testid="journal-assessment-empty">
          <strong>尚未生成目标期刊评估</strong>
          <span>选择期刊与文章类型后点「生成评估」。评估只读取稿件与质量门禁结果，不修改稿件。</span>
        </div>
      ) : (
        <AssessmentReport
          assessment={assessment.data}
          selected={selected}
          onToggle={(id) => setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))}
          converting={convert.isPending}
          onConvert={() => convert.mutate({ assessmentId: assessment.data!.assessmentId, criterionIds: selected })}
        />
      )}
    </section>
  );
}

function AssessmentReport({
  assessment,
  selected,
  onToggle,
  converting,
  onConvert,
}: {
  assessment: JournalAssessmentView;
  selected: string[];
  onToggle: (criterionId: string) => void;
  converting: boolean;
  onConvert: () => void;
}) {
  const { summary } = assessment;
  const counts = summary.observableRequirements;
  const requirements = assessment.criteria.filter((c) => c.category === "submission_requirement");
  return (
    <div data-testid="journal-assessment-report" data-verdict={summary.verdict}>
      <div className="state-block" data-testid="journal-verdict">
        <strong>
          <span className={`chip ${VERDICT_TONE[summary.verdict]}`} data-testid="journal-verdict-chip">{VERDICT_LABELS[summary.verdict]}</span>{" "}
          {assessment.journal.displayName} · {ARTICLE_TYPE_LABELS[assessment.articleType]}
        </strong>
        <span data-testid="journal-verdict-statement">{summary.statement}</span>
        <ul>
          {summary.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
        <span className="faint" data-testid="journal-observable-ratio">
          可检查的硬性要求：满足 {counts.satisfied} / 已判定 {counts.denominator}（不符 {counts.violated}）；未评估 {counts.notEvaluated}、不适用 {counts.notApplicable}、需作者确认 {counts.authorCheck}、主观项 {counts.advisory}（主观与未知不计入分母）
        </span>
        <span className="faint" data-testid="journal-external-validity">
          外部效度：未经独立校准（独立人类标签 {assessment.externalValidity.independentHumanLabels}）——{assessment.externalValidity.statement}
        </span>
        <span className="faint">
          评估于 {formatDateTime(assessment.generatedAt) ?? assessment.generatedAt} · 稿件修订 {assessment.manuscript.revision ?? "—"}（{assessment.manuscript.fidelity === "latex" ? "LaTeX 源码" : assessment.manuscript.fidelity === "pdf" ? "仅 PDF" : "无稿件"}）· 规则来源 {TRUST_LABELS[assessment.journal.verification.status]}
        </span>
      </div>

      <h4>A. 投稿要求（官方明文逐条）</h4>
      <ul className="journal-criteria" data-testid="journal-criteria">
        {[...assessment.criteria.filter((c) => c.category === "article_type"), ...requirements].map((criterion) => (
          <CriterionRow key={criterion.criterionId} criterion={criterion} checked={selected.includes(criterion.criterionId)} onToggle={() => onToggle(criterion.criterionId)} />
        ))}
      </ul>
      <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "6px 0 14px" }}>
        <button type="button" className="btn btn-small" data-testid="journal-convert" disabled={selected.length === 0 || converting} onClick={onConvert}>
          {converting ? "转入中…" : `把选中的 ${selected.length} 条转入修改意见`}
        </button>
        <span className="faint">只有「不符 + 可改写」的条目可勾选；需作者提供信息 / 实验 / 素材的条目不会进入自动修订。</span>
      </div>

      <h4>B. 学术质量与风险</h4>
      {assessment.riskFindings.length === 0 ? (
        <p className="faint">质量门禁未报告问题。</p>
      ) : (
        <ul data-testid="journal-risks">
          {assessment.riskFindings.map((risk) => (
            <li key={risk.findingId} data-testid={`journal-risk-${risk.findingId}`} data-evidence={risk.evidenceLevel}>
              <details>
                <summary>
                  <span className={`chip ${risk.evidenceLevel === "verified" ? "chip-tone-danger" : risk.evidenceLevel === "model-opinion" ? "chip-tone-info" : "chip-tone-neutral"}`}>{EVIDENCE_LABELS[risk.evidenceLevel]}</span> {risk.title}
                </summary>
                <p>{risk.detail}</p>
                {risk.evidenceQuotes !== undefined && risk.evidenceQuotes.length > 0 ? <blockquote>{risk.evidenceQuotes.join(" … ")}</blockquote> : null}
                <p className="faint">位置：{risk.location} · 建议：{risk.suggestion}</p>
              </details>
            </li>
          ))}
        </ul>
      )}
      {assessment.subjectiveEstimates.length > 0 ? (
        <p className="faint" data-testid="journal-subjective">
          模型主观估计（未校准、需专家复核，不影响结论）：{assessment.subjectiveEstimates.map((s) => `${s.dimension}=${s.verdict}`).join("；")}
        </p>
      ) : (
        <p className="faint" data-testid="journal-subjective">主观质量维度（创新性 / 贡献 / 论证）：本次未运行模型意见——未评估。</p>
      )}

      <h4>C. 目标期刊匹配</h4>
      <ul data-testid="journal-fit">
        {assessment.fitEvidence.map((fit) => (
          <li key={fit.fitId} data-testid={`journal-fit-${fit.aspect}`} data-status={fit.status}>
            <span className="chip chip-outline">{fit.status}</span> {fit.detail}
            {fit.referenceKind === "POSITIVE_ONLY_REFERENCE" ? <span className="faint">（仅作正向参照）</span> : null}
            {fit.sourceUrl !== undefined ? (
              <>
                {" "}
                <a href={fit.sourceUrl} target="_blank" rel="noreferrer">来源</a>
              </>
            ) : null}
          </li>
        ))}
      </ul>
      {assessment.journal.indexing.length > 0 ? (
        <p className="faint" data-testid="journal-indexing">
          收录 / 分级：{assessment.journal.indexing.map((item) => `${item.label}（${item.status === "SELF_DECLARED" ? "编辑部自述" : "未验证"}）`).join("；")}
        </p>
      ) : null}

      <h4>D. 不确定性与未评估项</h4>
      <ul data-testid="journal-unknowns">
        {[...summary.unknowns, ...summary.authorChecks.map((item) => `需作者确认 · ${item}`), ...assessment.uncertainty].map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function CriterionRow({ criterion, checked, onToggle }: { criterion: JournalCriterionView; checked: boolean; onToggle: () => void }) {
  const tone = criterion.status === "VIOLATED" ? (criterion.blocking ? "chip-tone-danger" : "chip-tone-warn") : criterion.status === "SATISFIED" ? "chip-tone-info" : "chip-tone-neutral";
  return (
    <li data-testid={`journal-criterion-${criterion.criterionId}`} data-status={criterion.status} data-evidence={criterion.evidenceLevel}>
      <details>
        <summary>
          {criterion.convertible ? (
            <input
              type="checkbox"
              aria-label={`选择：${criterion.title}`}
              data-testid={`journal-select-${criterion.criterionId}`}
              checked={checked}
              onChange={onToggle}
              onClick={(event) => event.stopPropagation()}
            />
          ) : null}{" "}
          <span className={`chip ${tone}`}>{STATUS_LABELS[criterion.status]}{criterion.status === "VIOLATED" && !criterion.blocking ? "（建议级）" : ""}</span>{" "}
          <span className="chip chip-outline">{EVIDENCE_LABELS[criterion.evidenceLevel]}</span> {criterion.title}
        </summary>
        <dl>
          <dt>稿件观测</dt>
          <dd>{criterion.observed}（位置：{criterion.location}）</dd>
          <dt>官方要求</dt>
          <dd>
            「{criterion.officialQuote}」 <a href={criterion.sourceUrl} target="_blank" rel="noreferrer">官方来源</a>{" "}
            <span className="faint">（{criterion.sourceStatus === "QUOTE_VERIFIED_LIVE" ? "原句已在线复核" : criterion.sourceStatus === "QUOTE_NOT_FOUND" ? "原句已不在官方页面" : criterion.sourceStatus === "SNAPSHOT" ? "来自官方页面快照" : "未验证来源"}；可靠性 {criterion.reliability}）</span>
          </dd>
          <dt>判定依据</dt>
          <dd>{criterion.why}</dd>
          {criterion.gap !== undefined ? (
            <>
              <dt>缺口</dt>
              <dd data-testid={`journal-gap-${criterion.criterionId}`}>{criterion.gap}</dd>
            </>
          ) : null}
          <dt>建议</dt>
          <dd>{criterion.suggestion}</dd>
        </dl>
      </details>
    </li>
  );
}
