import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Icon } from "../common/Icon.js";
import { ErrorState, Loading } from "../common/StateViews.js";
import { getProject } from "../../api/projects.js";
import {
  confirmTargetBenchmark,
  discoverTargetBenchmark,
  evaluateTargetReadiness,
  evaluateTargetGuidelineCompliance,
  evaluateTargetRubric,
  evaluateTargetEvidenceAudit,
  excludeTargetBenchmarkPaper,
  decideTargetAuditRevisionPlan,
  generateTargetAuditRevisionPlan,
  getTargetBenchmark,
  getTargetGuideline,
  getTargetGuidelineCompliance,
  getTargetProfile,
  getTargetReadiness,
  getTargetRubric,
  getTargetEvidenceAudit,
  getTargetAuditRevisionPlan,
  reassessTargetAuditRevision,
  regenerateTargetProfile,
  type AuditClosureReportView,
  type AuditGapClassification,
  type AuditRevisionPlanItemView,
  type AuditRevisionPlanView,
  type DistributionView,
  type EvidenceAuditComparisonStatus,
  type EvidenceAuditGapPlanItemView,
  type GuidelineCheckView,
  type GuidelineComplianceView,
  type TargetProfileView,
  type TargetReadinessDimensionView,
  type TargetReadinessView,
  type TargetRubricView,
  type TargetVerdictView,
} from "../../api/target.js";
import { formatApiError } from "../../utils/errors.js";
import { formatDateTime } from "../../utils/format.js";

/**
 * 目标参照系面板（M12 Batch 2 · A10）。
 *
 * 四段：目标配置 / Benchmark 语料 / 目标画像（分位带）/ 就绪度（advisory 四档）。
 * 语义红线（与 backend 一致）：
 * - 目标带是 benchmark 观测，不是期刊/会议官方投稿要求（面板固定声明）；
 * - 就绪度差距是「距离」不是稿件缺陷——徽章用中性色系，红色只给 BELOW_TARGET；
 * - INSUFFICIENT_EVIDENCE 是一等结果（语料不足/无手稿/维度无数据），如实呈现。
 *
 * 自包含组件：只依赖 { projectId } + api/target.ts + 共通 UI 原语；
 * ProjectPage 由主线接线（不在此文件内）。
 */

const VERDICT_META: Record<TargetVerdictView, { label: string; tone: string }> = {
  MEETS_TARGET: { label: "达标", tone: "ok" },
  PARTIALLY_MEETS_TARGET: { label: "部分达标", tone: "warn" },
  BELOW_TARGET: { label: "低于目标带", tone: "danger" },
  INSUFFICIENT_EVIDENCE: { label: "证据不足", tone: "neutral" },
};

const DIMENSION_LABELS: Record<TargetReadinessDimensionView["dimension"], string> = {
  structure: "结构",
  literature: "文献",
  experiments: "实验",
  visuals: "视觉材料",
  method: "方法",
  writing: "写作",
};

function band(dist: DistributionView | undefined, unit: string): string {
  if (dist === undefined) {
    return "（无数据）";
  }
  return `${dist.p25}–${dist.p75} ${unit}（min–max ${dist.min}–${dist.max}，n=${dist.n}）`;
}

function availabilityBadge(availability: "available" | "unavailable" | "insufficient"): string {
  if (availability === "available") {
    return "可用";
  }
  return availability === "insufficient" ? "样本不足" : "无数据";
}

function availabilityTone(availability: "available" | "unavailable" | "insufficient"): string {
  if (availability === "available") {
    return "ok";
  }
  return availability === "insufficient" ? "warn" : "neutral";
}

export function TargetPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [excludeSourceId, setExcludeSourceId] = useState("");
  const [excludeReason, setExcludeReason] = useState("");

  const project = useQuery({
    queryKey: ["project", projectId, "meta-for-target"],
    queryFn: ({ signal }) => getProject(projectId, signal),
  });
  const benchmark = useQuery({
    queryKey: ["target", projectId, "benchmark"],
    queryFn: ({ signal }) => getTargetBenchmark(projectId, signal),
  });
  const profile = useQuery({
    queryKey: ["target", projectId, "profile"],
    queryFn: ({ signal }) => getTargetProfile(projectId, signal),
  });
  const readiness = useQuery({
    queryKey: ["target", projectId, "readiness"],
    queryFn: ({ signal }) => getTargetReadiness(projectId, signal),
  });
  const guideline = useQuery({
    queryKey: ["target", projectId, "guideline"],
    queryFn: ({ signal }) => getTargetGuideline(projectId, signal),
  });
  const compliance = useQuery({
    queryKey: ["target", projectId, "guideline-compliance"],
    queryFn: ({ signal }) => getTargetGuidelineCompliance(projectId, signal),
  });
  const rubric = useQuery({
    queryKey: ["target", projectId, "rubric"],
    queryFn: ({ signal }) => getTargetRubric(projectId, signal),
  });
  const evidenceAudit = useQuery({
    queryKey: ["target", projectId, "evidence-audit"],
    queryFn: ({ signal }) => getTargetEvidenceAudit(projectId, signal),
  });
  // M15.17：审计修订计划（只在证据审计 flag 开启时查询）
  const auditRevisionPlan = useQuery({
    queryKey: ["target", projectId, "audit-revision-plan"],
    queryFn: ({ signal }) => getTargetAuditRevisionPlan(projectId, signal),
    enabled: evidenceAudit.data?.enabled === true,
  });

  const invalidateTarget = (): Promise<void> =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["target", projectId] }),
    ]).then(() => undefined);

  const discover = useMutation({
    mutationFn: () => discoverTargetBenchmark(projectId),
    onSuccess: () => {
      setActionError(null);
      void invalidateTarget();
    },
    onError: (error) => setActionError(formatApiError(error)),
  });
  const confirm = useMutation({
    mutationFn: () => confirmTargetBenchmark(projectId),
    onSuccess: () => {
      setActionError(null);
      void invalidateTarget();
    },
    onError: (error) => setActionError(formatApiError(error)),
  });
  const exclude = useMutation({
    mutationFn: (input: { sourceId: string; reason: string }) =>
      excludeTargetBenchmarkPaper(projectId, input.sourceId, input.reason),
    onSuccess: () => {
      setActionError(null);
      setExcludeSourceId("");
      setExcludeReason("");
      void invalidateTarget();
    },
    onError: (error) => setActionError(formatApiError(error)),
  });
  const regenerateProfile = useMutation({
    mutationFn: () => regenerateTargetProfile(projectId),
    onSuccess: () => {
      setActionError(null);
      void invalidateTarget();
    },
    onError: (error) => setActionError(formatApiError(error)),
  });
  const evaluateReadiness = useMutation({
    mutationFn: () => evaluateTargetReadiness(projectId),
    onSuccess: () => {
      setActionError(null);
      void invalidateTarget();
    },
    onError: (error) => setActionError(formatApiError(error)),
  });
  const evaluateCompliance = useMutation({
    mutationFn: () => evaluateTargetGuidelineCompliance(projectId),
    onSuccess: () => {
      setActionError(null);
      void invalidateTarget();
    },
    onError: (error) => setActionError(formatApiError(error)),
  });
  const evaluateRubric = useMutation({
    mutationFn: () => evaluateTargetRubric(projectId),
    onSuccess: () => {
      setActionError(null);
      void invalidateTarget();
    },
    onError: (error) => setActionError(formatApiError(error)),
  });
  const evaluateEvidenceAudit = useMutation({
    mutationFn: () => evaluateTargetEvidenceAudit(projectId),
    onSuccess: () => {
      setActionError(null);
      void invalidateTarget();
    },
    onError: (error) => setActionError(formatApiError(error)),
  });
  const generateAuditPlan = useMutation({
    mutationFn: () => generateTargetAuditRevisionPlan(projectId),
    onSuccess: () => {
      setActionError(null);
      void invalidateTarget();
    },
    onError: (error) => setActionError(formatApiError(error)),
  });
  const decideAuditPlan = useMutation({
    mutationFn: (decisions: Array<{ itemId: string; decision: "approve" | "reject" }>) =>
      decideTargetAuditRevisionPlan(projectId, decisions),
    onSuccess: () => {
      setActionError(null);
      void invalidateTarget();
    },
    onError: (error) => setActionError(formatApiError(error)),
  });
  const reassessAuditPlan = useMutation({
    mutationFn: () => reassessTargetAuditRevision(projectId),
    onSuccess: () => {
      setActionError(null);
      void invalidateTarget();
    },
    onError: (error) => setActionError(formatApiError(error)),
  });

  if (project.isPending || benchmark.isPending) {
    return (
      <section className="panel section-block target-panel" id="target-panel" data-testid="target-panel">
        <div className="section-head">
          <h2>目标参照系</h2>
        </div>
        <Loading label="加载目标参照系…" />
      </section>
    );
  }
  if (project.isError) {
    return (
      <section className="panel section-block target-panel" id="target-panel" data-testid="target-panel">
        <div className="section-head">
          <h2>目标参照系</h2>
        </div>
        <ErrorState
          title="目标参照系加载失败"
          message={formatApiError(project.error)}
          onRetry={() => void project.refetch()}
        />
      </section>
    );
  }
  if (benchmark.isError) {
    return (
      <section className="panel section-block target-panel" id="target-panel" data-testid="target-panel">
        <div className="section-head">
          <h2>目标参照系</h2>
        </div>
        <ErrorState
          title="Benchmark 语料加载失败"
          message={formatApiError(benchmark.error)}
          onRetry={() => void benchmark.refetch()}
        />
      </section>
    );
  }

  const projectData = project.data;
  const benchmarkData = benchmark.data ?? null;
  const researchField = projectData?.researchField?.trim() ?? "";
  const targetConfigured = researchField !== "" || (projectData?.targetVenue ?? "").trim() !== "";
  const profileData = profile.data?.profile ?? null;
  const profileEnvelope = profile.data ?? null;
  const profileStale = profileEnvelope?.profile != null && profileEnvelope.fresh === false;
  const readinessData = readiness.data ?? null;

  // 未配置目标：专属空态（区别于「已配置未发现」）
  if (!targetConfigured && benchmarkData === null) {
    return (
      <section className="panel section-block target-panel" id="target-panel" data-testid="target-panel">
        <div className="section-head">
          <h2>目标参照系</h2>
        </div>
        <div className="state-block state-empty" data-testid="target-empty-not-configured">
          <strong>本项目尚未配置目标参照系</strong>
          <span>
            在项目设置中填写「研究领域」（researchField，benchmark 检索的确定性来源），可选填目标
            venue / 目标档次。配置后工作流的 target 阶段会自动发现并冻结 8–15 篇 benchmark
            论文，建立结构 / 文献 / 实验 / 视觉 / 方法 / 写作六维目标带。
          </span>
        </div>
      </section>
    );
  }

  return (
    <section className="panel section-block target-panel" id="target-panel" data-testid="target-panel">
      <div className="section-head">
        <h2>目标参照系</h2>
        <span className="faint">benchmark 观测，非官方投稿要求</span>
      </div>

      {/* ---- 1. 目标配置与语料状态 ---- */}
      <div className="kv" data-testid="target-config">
        <div className="kv-row">
          <dt>目标定位</dt>
          <dd>
            {projectData?.documentType ?? "（未填写类型）"} · {projectData?.targetProfile ?? "（未填写档次）"}
            {projectData?.targetVenue ? ` · ${projectData.targetVenue}` : ""}
          </dd>
        </div>
        <div className="kv-row">
          <dt>研究领域</dt>
          <dd>{researchField || "（未填写——benchmark discovery 需要该字段作为检索词来源）"}</dd>
        </div>
        <div className="kv-row">
          <dt>语料状态</dt>
          <dd>
            {benchmarkData === null ? (
              <span className="status status-tone-warn" data-testid="target-benchmark-absent">
                未发现
              </span>
            ) : (
              <>
                <span className="status status-tone-ok">
                  已冻结（revision {benchmarkData.revision} · {benchmarkData.papers.filter((p) => p.excluded === undefined).length} 篇有效）
                </span>
                {benchmarkData.selection !== undefined ? (
                  <span
                    className={`chip ${benchmarkData.selection.sufficiency === "sufficient" ? "chip-tone-info" : "chip-tone-warn"}`}
                    title={benchmarkData.selection.reason ?? undefined}
                  >
                    {benchmarkData.selection.sufficiency === "sufficient" ? "语料充足" : "语料不足"}
                  </span>
                ) : null}
                {benchmarkData.confirmedAt !== undefined ? (
                  <span className="chip chip-tone-neutral" title={formatDateTime(benchmarkData.confirmedAt) ?? undefined}>
                    已确认
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => confirm.mutate()}
                    disabled={confirm.isPending}
                    data-testid="target-benchmark-confirm"
                  >
                    {confirm.isPending ? "确认中…" : "确认语料"}
                  </button>
                )}
                <span className="faint mono">fingerprint {benchmarkData.fingerprint}</span>
              </>
            )}
          </dd>
        </div>
      </div>

      {benchmarkData?.selection?.requiresAttention?.length ? (
        <div className="note note-warn" role="status" data-testid="target-requires-attention">
          <span>
            <span className="note-mark">●</span> 发现过程注意事项（advisory，不阻塞流程；对应维度将以证据不足如实呈现）：
            <ul>
              {benchmarkData.selection.requiresAttention.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </span>
        </div>
      ) : null}

      {benchmarkData === null ? (
        <div className="state-block state-empty" data-testid="target-benchmark-empty">
          <strong>尚未发现 benchmark 语料</strong>
          <span>
            已配置目标，但还没有冻结的目标语料。可立即触发发现（自动按引用数选择 8–15 篇并冻结，
            全程零暂停），或运行一次写稿 / 改进工作流由 target 阶段自动完成。
          </span>
          <p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => discover.mutate()}
              disabled={discover.isPending}
              data-testid="target-benchmark-discover"
            >
              {discover.isPending ? "发现中…" : "发现并冻结 benchmark 语料"}
              <Icon name="search" />
            </button>
          </p>
        </div>
      ) : (
        /* ---- 2. Benchmark 语料表 ---- */
        <div className="target-benchmark-corpus" data-testid="target-benchmark-corpus">
          <div className="gate-rules-head">
            <h3>Benchmark 语料（{benchmarkData.papers.length} 条冻结记录）</h3>
            <span className="faint">
              全部条目 sourceRole=reference——只作写作参照，永不进入证据链
            </span>
          </div>
          <div className="table-scroll">
            <table className="data-table" data-testid="target-benchmark-table">
              <thead>
                <tr>
                  <th>来源</th>
                  <th>Venue（原文）</th>
                  <th className="num">引用数</th>
                  <th>全文</th>
                  <th>入选理由</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {benchmarkData.papers.map((paper) => (
                  <tr key={paper.sourceId} data-testid="target-benchmark-paper">
                    <td className="mono">{paper.sourceId}</td>
                    <td>{paper.venueRaw || "—"}</td>
                    <td className="num">{paper.citationCount ?? "—"}</td>
                    <td>{paper.hasFullText ? "有" : <span className="faint">仅元数据</span>}</td>
                    <td className="faint">{paper.inclusionReason}</td>
                    <td>
                      {paper.excluded !== undefined ? (
                        <span className="status status-tone-neutral" title={paper.excluded.reason}>
                          已剔除
                        </span>
                      ) : (
                        <span className="status status-tone-ok">有效</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="target-benchmark-actions">
            <button
              type="button"
              className="btn btn-small"
              onClick={() => discover.mutate()}
              disabled={discover.isPending}
              data-testid="target-benchmark-rediscover"
              title="语料已冻结时为幂等 no-op（更新走显式 refresh 语义，由服务端编排）"
            >
              {discover.isPending ? "执行中…" : "重新执行发现（幂等）"}
            </button>
            <form
              className="target-exclude-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (excludeSourceId.trim() !== "" && excludeReason.trim() !== "") {
                  exclude.mutate({ sourceId: excludeSourceId.trim(), reason: excludeReason.trim() });
                }
              }}
            >
              <input
                value={excludeSourceId}
                onChange={(event) => setExcludeSourceId(event.target.value)}
                placeholder="sourceId"
                aria-label="剔除条目的 sourceId"
                data-testid="target-exclude-source"
              />
              <input
                value={excludeReason}
                onChange={(event) => setExcludeReason(event.target.value)}
                placeholder="剔除理由（必填，审计事实）"
                aria-label="剔除理由"
                data-testid="target-exclude-reason"
              />
              <button
                type="submit"
                className="btn btn-small"
                disabled={exclude.isPending || excludeSourceId.trim() === "" || excludeReason.trim() === ""}
                data-testid="target-exclude-submit"
              >
                剔除条目
              </button>
            </form>
          </div>
        </div>
      )}

      {actionError !== null ? (
        <p className="form-error" role="alert" data-testid="target-action-error">
          操作失败：{actionError}
        </p>
      ) : null}

      {/* ---- 3. 目标画像（分位带） ---- */}
      <TargetProfileSection
        profile={profileData}
        pending={profile.isPending}
        error={profile.isError ? formatApiError(profile.error) : null}
        stale={profileStale}
        staleReason={profileEnvelope?.staleReason}
        regenerating={regenerateProfile.isPending}
        onRegenerate={() => regenerateProfile.mutate()}
        onRetry={() => void profile.refetch()}
        benchmarkReady={benchmarkData !== null}
      />

      {/* ---- 4. 就绪度 ---- */}
      <TargetReadinessSection
        readiness={readinessData}
        pending={readiness.isPending}
        error={readiness.isError ? formatApiError(readiness.error) : null}
        evaluating={evaluateReadiness.isPending}
        onEvaluate={() => evaluateReadiness.mutate()}
        onRetry={() => void readiness.refetch()}
        profileReady={profileData !== null}
      />

      {/* ---- 5. 官方投稿要求符合度（M15.9 G1，确定性 advisory） ---- */}
      <TargetGuidelineSection
        guideline={guideline.data ?? null}
        compliance={compliance.data ?? null}
        pending={guideline.isPending || compliance.isPending}
        error={guideline.isError ? formatApiError(guideline.error) : compliance.isError ? formatApiError(compliance.error) : null}
        evaluating={evaluateCompliance.isPending}
        onEvaluate={() => evaluateCompliance.mutate()}
        onRetry={() => {
          void guideline.refetch();
          void compliance.refetch();
        }}
      />

      {/* ---- 6. 期刊级 rubric（M15.9 G2，模型 advisory） ---- */}
      <TargetRubricSection
        rubric={rubric.data ?? null}
        pending={rubric.isPending}
        error={rubric.isError ? formatApiError(rubric.error) : null}
        evaluating={evaluateRubric.isPending}
        onEvaluate={() => evaluateRubric.mutate()}
        onRetry={() => void rubric.refetch()}
        guidelineReady={guideline.data != null}
      />

      {/* ---- 7. 证据审计（M15.16 P0-A，实验性；flag off 时后端返回 enabled:false，区块不渲染） ---- */}
      {evidenceAudit.data?.enabled === true ? (
        <>
          <TargetEvidenceAuditSection
            audit={evidenceAudit.data.audit}
            pending={evidenceAudit.isPending}
            error={evidenceAudit.isError ? formatApiError(evidenceAudit.error) : null}
            evaluating={evaluateEvidenceAudit.isPending}
            onEvaluate={() => evaluateEvidenceAudit.mutate()}
            onRetry={() => void evidenceAudit.refetch()}
          />
          {/* ---- 7b. 审计差距 → 修订计划（M15.17；随审计 flag 渲染） ---- */}
          <TargetAuditRevisionSection
            auditStale={evidenceAudit.data.audit?.stale ?? false}
            planStatus={auditRevisionPlan.data ?? null}
            pending={auditRevisionPlan.isPending}
            error={auditRevisionPlan.isError ? formatApiError(auditRevisionPlan.error) : null}
            generating={generateAuditPlan.isPending}
            deciding={decideAuditPlan.isPending}
            reassessing={reassessAuditPlan.isPending}
            onGenerate={() => generateAuditPlan.mutate()}
            onDecide={(decisions) => decideAuditPlan.mutate(decisions)}
            onReassess={() => reassessAuditPlan.mutate()}
            onRetry={() => void auditRevisionPlan.refetch()}
          />
        </>
      ) : null}

      <p className="section-note faint">
        目标带来自冻结 benchmark 语料的确定性观测（research/target-profile.json），不是期刊/会议官方投稿要求；
        就绪度差距是与目标带的距离陈述，不构成稿件事实错误，也不阻断任何质量门禁。
        官方要求符合度（target-guideline.json）逐条对照期刊官方页面明文；rubric（target-rubric.json）是模型
        在官方范围与稿件摘录上的候选判断——不构成录用判断或专家意见，均不进入质量门禁。
      </p>
    </section>
  );
}

function TargetProfileSection({
  profile,
  pending,
  error,
  stale,
  staleReason,
  regenerating,
  onRegenerate,
  onRetry,
  benchmarkReady,
}: {
  profile: TargetProfileView | null;
  pending: boolean;
  error: string | null;
  stale: boolean;
  staleReason?: string;
  regenerating: boolean;
  onRegenerate: () => void;
  onRetry: () => void;
  benchmarkReady: boolean;
}) {
  return (
    <div className="target-profile" data-testid="target-profile-section">
      <div className="gate-rules-head">
        <h3>目标画像（六维分位带）</h3>
        {profile !== null ? (
          <span className="faint">
            n={profile.n} · benchmarkRevision={profile.benchmarkRevision} · 生成于 {formatDateTime(profile.generatedAt) ?? "—"}
            {profile.provenance.model !== undefined ? ` · 摘要模型 ${profile.provenance.model}` : ""}
          </span>
        ) : null}
      </div>
      {pending ? (
        <Loading label="加载目标画像…" />
      ) : error !== null ? (
        <ErrorState title="目标画像加载失败" message={error} onRetry={onRetry} />
      ) : profile === null ? (
        <div className="state-block state-empty" data-testid="target-profile-empty">
          <strong>{benchmarkReady ? "尚无目标画像" : "无 benchmark 语料，暂无画像"}</strong>
          <span>
            {benchmarkReady
              ? "语料冻结后，工作流 target.profile 阶段会自动生成；也可在此显式重建。"
              : "先发现并冻结 benchmark 语料，画像随后自动生成。"}
          </span>
        </div>
      ) : (
        <>
          {stale ? (
            <div className="note note-warn" role="status" data-testid="target-profile-stale">
              <span>
                <span className="note-mark">●</span> 画像相对当前语料已陈旧（{staleReason ?? "参照系变更"}）——
                陈旧画像不会作为当前参照系使用。
                <button type="button" className="btn-link" onClick={onRegenerate} disabled={regenerating}>
                  {regenerating ? "重建中…" : "立即重建"}
                </button>
              </span>
            </div>
          ) : null}
          <dl className="kv" data-testid="target-profile-bands">
            <div className="kv-row">
              <dt>结构 · 正文词数</dt>
              <dd>
                {band(profile.dimensions.structure.totalLengthWords, "词")}{" "}
                <span className={`status status-tone-${availabilityTone(profile.dimensions.structure.availability)}`}>
                  {availabilityBadge(profile.dimensions.structure.availability)}
                </span>
              </dd>
            </div>
            <div className="kv-row">
              <dt>结构 · 摘要词数</dt>
              <dd>{band(profile.dimensions.structure.abstractLengthWords, "词")}</dd>
            </div>
            <div className="kv-row">
              <dt>文献 · 参考文献条目数</dt>
              <dd>
                {band(profile.dimensions.literature.citationCount, "条")}{" "}
                <span className={`status status-tone-${availabilityTone(profile.dimensions.literature.availability)}`}>
                  {availabilityBadge(profile.dimensions.literature.availability)}
                </span>
              </dd>
            </div>
            <div className="kv-row">
              <dt>实验 · 表格数 / 消融占比</dt>
              <dd>
                {band(profile.dimensions.experiments.tableCount, "个表")} ·{" "}
                {profile.dimensions.experiments.ablationPresent !== undefined
                  ? `${Math.round(profile.dimensions.experiments.ablationPresent * 100)}% 论文含 ablation`
                  : "（无数据）"}
              </dd>
            </div>
            <div className="kv-row">
              <dt>视觉 · 图数 / 方法总览图占比</dt>
              <dd>
                {band(profile.dimensions.visuals.figureCount, "个图")} ·{" "}
                {profile.dimensions.visuals.methodDiagramPresent !== undefined
                  ? `${Math.round(profile.dimensions.visuals.methodDiagramPresent * 100)}% 论文含方法总览图`
                  : "（无数据）"}
              </dd>
            </div>
            <div className="kv-row">
              <dt>章节模式（present / 中位词数）</dt>
              <dd>
                {Object.keys(profile.dimensions.structure.sectionPattern).length > 0
                  ? Object.entries(profile.dimensions.structure.sectionPattern)
                      .sort((a, b) => b[1].present - a[1].present)
                      .slice(0, 8)
                      .map(([name, entry]) => `${name} ${entry.present}/${profile.n}（${entry.medianLengthWords} 词）`)
                      .join("；")
                  : "（无节标题统计）"}
              </dd>
            </div>
            {profile.dimensions.method.depthNote !== undefined ? (
              <div className="kv-row">
                <dt>方法深度模式（模型归纳）</dt>
                <dd>{profile.dimensions.method.depthNote}</dd>
              </div>
            ) : null}
            {profile.dimensions.writing.claimStrengthNote !== undefined ? (
              <div className="kv-row">
                <dt>论断强度模式（模型归纳）</dt>
                <dd>{profile.dimensions.writing.claimStrengthNote}</dd>
              </div>
            ) : null}
          </dl>
          {profile.provenance.summaryFailure !== undefined ? (
            <div className="note note-warn" role="status" data-testid="target-profile-summary-failure">
              <span>
                <span className="note-mark">●</span> 方法/写作摘要不可用（{profile.provenance.summaryFailure}）——
                两维以确定性统计呈现，不伪造模型归纳。
              </span>
            </div>
          ) : null}
          {profile.notes.length > 0 ? (
            <ul className="faint target-profile-notes" data-testid="target-profile-notes">
              {profile.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
          <p>
            <button type="button" className="btn btn-small" onClick={onRegenerate} disabled={regenerating}>
              {regenerating ? "重建中…" : "重建画像（缺失/陈旧时）"}
            </button>
          </p>
        </>
      )}
    </div>
  );
}

function TargetReadinessSection({
  readiness,
  pending,
  error,
  evaluating,
  onEvaluate,
  onRetry,
  profileReady,
}: {
  readiness: TargetReadinessView | null;
  pending: boolean;
  error: string | null;
  evaluating: boolean;
  onEvaluate: () => void;
  onRetry: () => void;
  profileReady: boolean;
}) {
  return (
    <div className="target-readiness" data-testid="target-readiness-section">
      <div className="gate-rules-head">
        <h3>目标就绪度（advisory）</h3>
        {readiness !== null ? (
          <span className="faint">
            评估于 {formatDateTime(readiness.evaluatedAt) ?? "—"} · 手稿修订{" "}
            {readiness.manuscriptRevision ?? "（无）"} · benchmarkRevision {readiness.benchmarkRevision}
          </span>
        ) : null}
      </div>
      {pending ? (
        <Loading label="加载就绪度…" />
      ) : error !== null ? (
        <ErrorState title="就绪度加载失败" message={error} onRetry={onRetry} />
      ) : readiness === null ? (
        <div className="state-block state-empty" data-testid="target-readiness-empty">
          <strong>{profileReady ? "尚未评估就绪度" : "无目标画像，暂无法评估"}</strong>
          <span>
            {profileReady
              ? "工作流 target.readiness 阶段会自动评估当前稿；也可在此手动评估（每次评估覆写落盘）。"
              : "目标画像就绪后即可评估（无手稿时结果为全维证据不足，属正常状态）。"}
          </span>
        </div>
      ) : (
        <>
          <div className="gate-summary-head" data-testid="target-readiness-overall">
            <span className={`status status-tone-${VERDICT_META[readiness.overall.verdict].tone}`}>
              {VERDICT_META[readiness.overall.verdict].label}
            </span>
            <span className="faint">{readiness.overall.summary}</span>
          </div>
          <ul className="gate-rule-list" data-testid="target-readiness-dimensions">
            {readiness.dimensions.map((dimension) => {
              const meta = VERDICT_META[dimension.verdict];
              return (
                <li key={dimension.dimension} className="gate-rule" data-testid="target-readiness-dimension">
                  <span className={`status status-tone-${meta.tone} gate-rule-status`}>{meta.label}</span>
                  <div className="gate-rule-body">
                    <span className="gate-rule-name">
                      {DIMENSION_LABELS[dimension.dimension]}
                      <span className="faint"> · 置信 {dimension.confidence}</span>
                    </span>
                    <span className="gate-rule-detail">
                      当前：{dimension.observed}
                      <br />
                      目标带：{dimension.targetRange}
                    </span>
                    {dimension.gaps.length > 0 ? (
                      <ul className="target-gap-list">
                        {dimension.gaps.map((gap) => (
                          <li key={gap}>{gap}</li>
                        ))}
                      </ul>
                    ) : null}
                    <span className="gate-rule-id mono faint">{dimension.evidenceBasis}</span>
                  </div>
                </li>
              );
            })}
          </ul>
          {readiness.dimensions.some((dimension) => dimension.verdict === "INSUFFICIENT_EVIDENCE") ? (
            <div className="note note-warn" role="status" data-testid="target-readiness-insufficient">
              <span>
                <span className="note-mark">●</span>{" "}
                存在证据不足维度（语料样本 &lt; 5 / 无解析产物 / 无手稿观测点）——系统如实降级，不静默放宽。
                可补充语料（发现更多论文或手动以 role=reference 入库后 addPaper）再重建画像。
              </span>
            </div>
          ) : null}
          <p>
            <button type="button" className="btn btn-small" onClick={onEvaluate} disabled={evaluating}>
              {evaluating ? "评估中…" : "评估当前稿"}
            </button>
          </p>
        </>
      )}
    </div>
  );
}

// ---- M15.9 G1：官方投稿要求符合度（确定性 advisory） ----

const GUIDELINE_STATUS_META: Record<GuidelineCheckView["status"], { label: string; tone: string }> = {
  PASS: { label: "符合", tone: "ok" },
  VIOLATION: { label: "不符", tone: "danger" },
  NOT_EVALUATED: { label: "未评", tone: "neutral" },
  ADVISORY: { label: "建议关注", tone: "warn" },
};

function TargetGuidelineSection({
  guideline,
  compliance,
  pending,
  error,
  evaluating,
  onEvaluate,
  onRetry,
}: {
  guideline: import("../../api/target.js").TargetGuidelineView | null;
  compliance: GuidelineComplianceView | null;
  pending: boolean;
  error: string | null;
  evaluating: boolean;
  onEvaluate: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="target-guideline" data-testid="target-guideline-section">
      <div className="gate-rules-head">
        <h3>官方投稿要求符合度（advisory）</h3>
        {guideline !== null ? (
          <span className="faint">
            {guideline.displayName} · 指南冻结于 {formatDateTime(guideline.frozenAt) ?? "—"} · 来源访问{" "}
            {guideline.provenance.accessDate}（{guideline.provenance.confidence}）
          </span>
        ) : null}
      </div>
      {pending ? (
        <Loading label="加载官方要求符合度…" />
      ) : error !== null ? (
        <ErrorState title="官方要求符合度加载失败" message={error} onRetry={onRetry} />
      ) : guideline === null ? (
        <div className="state-block state-empty" data-testid="target-guideline-empty">
          <strong>尚未导入目标期刊官方指南工件</strong>
          <span>
            本项目未冻结 target-guideline.json（官方范围/明文要求 + 来源快照）。导入后可对当前稿做确定性逐条对照；
            未导入时官方要求层为 NOT_EVALUATED，不以 benchmark 观测带冒充。
          </span>
        </div>
      ) : compliance === null ? (
        <div className="state-block state-empty" data-testid="target-guideline-compliance-empty">
          <strong>指南已冻结，尚未评估当前稿</strong>
          <span>
            <button type="button" className="btn btn-small" onClick={onEvaluate} disabled={evaluating}>
              {evaluating ? "评估中…" : "逐条对照（确定性，零模型）"}
            </button>
          </span>
        </div>
      ) : (
        <>
          <div className="gate-rules-head">
            <span>
              <span className={`status status-tone-${compliance.summary.topStatus === "HARD_VIOLATION" ? "danger" : compliance.summary.topStatus === "COMPLIANT" ? "ok" : "neutral"}`}>
                {compliance.summary.topStatus === "HARD_VIOLATION"
                  ? `硬性不符 ${compliance.summary.hardViolations} 条`
                  : compliance.summary.topStatus === "COMPLIANT"
                    ? "明文条款未见硬性不符"
                    : "全部未评"}
              </span>{" "}
              <span className="faint">
                （符合 {compliance.summary.passCount} · 不符 {compliance.summary.hardViolations} · 未评{" "}
                {compliance.summary.notEvaluatedCount} · 建议关注 {compliance.summary.advisoryCount}；评估于{" "}
                {formatDateTime(compliance.evaluatedAt) ?? "—"}）
              </span>
            </span>
            <span>
              <button type="button" className="btn btn-small" onClick={onEvaluate} disabled={evaluating}>
                {evaluating ? "评估中…" : "重新对照"}
              </button>
            </span>
          </div>
          <ul className="rule-list" data-testid="target-guideline-checks">
            {compliance.checks.map((check) => (
              <li key={check.requirementId} className="rule-item">
                <span className={`status status-tone-${GUIDELINE_STATUS_META[check.status].tone}`}>
                  {GUIDELINE_STATUS_META[check.status].label}
                  {check.hard ? "·硬性" : "·建议"}
                </span>
                <div>
                  <div>
                    <strong>{check.field}</strong>
                    <span className="faint">（{check.expected}）</span>：{check.observed}
                    {check.status === "NOT_EVALUATED" && check.reason !== undefined ? (
                      <span className="faint"> — 未评原因：{check.reason}</span>
                    ) : null}
                  </div>
                  <details>
                    <summary className="faint">官方原文与出处</summary>
                    <blockquote className="section-note">
                      “{check.officialQuote}”
                      <br />
                      <a href={check.sourceUrl} target="_blank" rel="noreferrer">
                        {check.sourceUrl}
                      </a>
                    </blockquote>
                  </details>
                </div>
              </li>
            ))}
          </ul>
          <p className="section-note faint">{compliance.provenance.disclaimer}</p>
        </>
      )}
    </div>
  );
}

// ---- M15.9 G2：期刊级 rubric（模型 advisory） ----

const RUBRIC_VERDICT_META: Record<string, { label: string; tone: string }> = {
  STRONG: { label: "强", tone: "ok" },
  ADEQUATE: { label: "合格", tone: "ok" },
  WEAK: { label: "弱", tone: "warn" },
  INSUFFICIENT_EVIDENCE: { label: "证据不足", tone: "neutral" },
  NEEDS_EXPERT_REVIEW: { label: "需专家复核", tone: "neutral" },
};

const RUBRIC_DIMENSION_LABELS: Record<string, string> = {
  novelty: "创新性",
  contribution: "研究贡献",
  technicalSoundness: "技术可靠性",
  experimentalAdequacy: "实验/实证充分性",
  relevance: "期刊相关性",
  clarity: "表达清晰度",
};

function TargetRubricSection({
  rubric,
  pending,
  error,
  evaluating,
  onEvaluate,
  onRetry,
  guidelineReady,
}: {
  rubric: TargetRubricView | null;
  pending: boolean;
  error: string | null;
  evaluating: boolean;
  onEvaluate: () => void;
  onRetry: () => void;
  guidelineReady: boolean;
}) {
  return (
    <div className="target-rubric" data-testid="target-rubric-section">
      <div className="gate-rules-head">
        <h3>期刊级质量 rubric（advisory · 模型候选判断）</h3>
        {rubric !== null ? (
          <span className="faint">
            {rubric.venueId} · {rubric.model ?? "未配置模型"} · 文章类型 {rubric.documentType} ·{" "}
            {rubric.withBenchmarkBands ? "含 benchmark 带" : "无 benchmark 带（A3 形态）"} · 评估于{" "}
            {formatDateTime(rubric.evaluatedAt) ?? "—"}
          </span>
        ) : null}
      </div>
      {pending ? (
        <Loading label="加载期刊级 rubric…" />
      ) : error !== null ? (
        <ErrorState title="rubric 加载失败" message={error} onRetry={onRetry} />
      ) : !guidelineReady ? (
        <div className="state-block state-empty" data-testid="target-rubric-empty">
          <strong>需先冻结官方指南工件</strong>
          <span>rubric 的范围判据来自 target-guideline.json 的官方范围陈述——未导入前不评估（不以 benchmark 观测冒充范围）。</span>
        </div>
      ) : rubric === null ? (
        <div className="state-block state-empty" data-testid="target-rubric-unevaluated">
          <strong>尚未评估</strong>
          <span>
            <button type="button" className="btn btn-small" onClick={onEvaluate} disabled={evaluating}>
              {evaluating ? "评估中…" : "评估（模型 advisory，单次调用）"}
            </button>
          </span>
        </div>
      ) : (
        <>
          <div className="gate-rules-head">
            <span>
              <span className={`status status-tone-${RUBRIC_VERDICT_META[rubric.overall.verdict]?.tone ?? "neutral"}`}>
                {RUBRIC_VERDICT_META[rubric.overall.verdict]?.label ?? rubric.overall.verdict}
              </span>{" "}
              <span className="faint">{rubric.overall.rationale}</span>
            </span>
            <span>
              <button type="button" className="btn btn-small" onClick={onEvaluate} disabled={evaluating}>
                {evaluating ? "评估中…" : "重新评估"}
              </button>
            </span>
          </div>
          <div className="kv" data-testid="target-rubric-scope">
            <div className="kv-row">
              <dt>范围相关性</dt>
              <dd>
                {rubric.scopeRelevance.inScope === null ? (
                  <span className="status status-tone-neutral">未判定</span>
                ) : rubric.scopeRelevance.inScope ? (
                  <span className="status status-tone-ok">
                    在期刊范围内{rubric.scopeRelevance.columnMatch !== undefined ? `（${rubric.scopeRelevance.columnMatch}）` : ""}
                  </span>
                ) : (
                  <span className="status status-tone-danger">疑似超出期刊范围</span>
                )}
                <span className="faint"> — {rubric.scopeRelevance.evidence}</span>
              </dd>
            </div>
          </div>
          <ul className="rule-list" data-testid="target-rubric-dimensions">
            {rubric.dimensions.map((dimension) => (
              <li key={dimension.dimension} className="rule-item">
                <span className={`status status-tone-${RUBRIC_VERDICT_META[dimension.verdict]?.tone ?? "neutral"}`}>
                  {RUBRIC_VERDICT_META[dimension.verdict]?.label ?? dimension.verdict}
                  {dimension.needsExpertReview ? "·需专家复核" : ""}
                </span>
                <div>
                  <strong>{RUBRIC_DIMENSION_LABELS[dimension.dimension] ?? dimension.dimension}</strong>
                  {dimension.gaps.length > 0 ? (
                    <ul>
                      {dimension.gaps.map((gap, index) => (
                        <li key={index}>{gap}</li>
                      ))}
                    </ul>
                  ) : null}
                  {dimension.evidenceQuotes.length > 0 ? (
                    <details>
                      <summary className="faint">稿件引文依据</summary>
                      <blockquote className="section-note">
                        {dimension.evidenceQuotes.map((quote, index) => (
                          <div key={index}>“{quote}”</div>
                        ))}
                      </blockquote>
                    </details>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {rubric.summaryFailure !== undefined ? (
            <div className="note note-warn" role="status" data-testid="target-rubric-failure">
              <span>
                <span className="note-mark">●</span> 评估失败/未配置（整体 INSUFFICIENT_EVIDENCE，不伪造）：{rubric.summaryFailure}
              </span>
            </div>
          ) : null}
          <p className="section-note faint">{rubric.provenance.disclaimer}</p>
        </>
      )}
    </div>
  );
}

// ---- M15.16 P0-A：证据审计（实验性；贡献级先前工作比较，模型 advisory） ----

const AUDIT_STATUS_META: Record<EvidenceAuditComparisonStatus, { label: string; tone: string; hint: string }> = {
  SUPPORTED_DIFFERENCE: { label: "差异可支持", tone: "ok", hint: "可定位的技术差异且现有材料（稿件+先前工作对应内容级）支持" },
  POTENTIAL_OVERLAP: { label: "疑似重叠", tone: "warn", hint: "先前工作可能已覆盖声称的创新——展示具体重叠与仍不可判定部分" },
  EVIDENCE_GAP: { label: "证据缺口", tone: "warn", hint: "论文自身证据未支撑声称的进展（声称/实验不匹配）" },
  INSUFFICIENT_EVIDENCE: { label: "证据不足", tone: "neutral", hint: "稿件细节或先前工作材料不足以判定" },
};

const CLAIM_TYPE_LABELS: Record<string, string> = {
  technical_idea: "技术思想",
  method_combination: "方法组合",
  performance_advantage: "性能优势",
  application_scope: "应用范围",
  analysis_or_taxonomy: "分析/分类",
  dataset_or_benchmark: "数据集/基准",
  other: "其他",
};

const SOURCE_LEVEL_LABELS: Record<string, string> = {
  pool_fulltext: "已核验全文",
  pool_abstract: "摘要级",
  pool_metadata: "题录级",
  model_memory: "模型记忆（非证据）",
};

function identityLabel(prior: { doi?: string; arxivId?: string; year?: number }): string {
  const parts: string[] = [];
  if (prior.year !== undefined) parts.push(String(prior.year));
  if (prior.doi !== undefined) parts.push(`doi:${prior.doi}`);
  if (prior.arxivId !== undefined) parts.push(`arXiv:${prior.arxivId}`);
  return parts.length > 0 ? `（${parts.join(" · ")}）` : "";
}

function TargetEvidenceAuditSection({
  audit,
  pending,
  error,
  evaluating,
  onEvaluate,
  onRetry,
}: {
  audit: import("../../api/target.js").TargetEvidenceAuditView | null;
  pending: boolean;
  error: string | null;
  evaluating: boolean;
  onEvaluate: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="target-evidence-audit" data-testid="target-evidence-audit-section">
      <div className="gate-rules-head">
        <h3>证据审计（实验性 · 贡献级先前工作比较）</h3>
        {audit !== null ? (
          <span className="faint">
            评估于 {formatDateTime(audit.artifact.evaluatedAt) ?? "—"} · 文章类型 {audit.artifact.documentType}
            {audit.artifact.venueId !== undefined ? ` · venue ${audit.artifact.venueId}` : ""} · pool {audit.artifact.priorWork.poolSize} 篇
            （cutoff {audit.artifact.priorWork.cutoffDate}）
          </span>
        ) : null}
      </div>
      {pending ? (
        <Loading label="加载证据审计…" />
      ) : error !== null ? (
        <ErrorState title="证据审计加载失败" message={error} onRetry={onRetry} />
      ) : audit === null ? (
        <div className="state-block state-empty" data-testid="target-evidence-audit-empty">
          <strong>尚未执行证据审计</strong>
          <span>
            对当前稿的逐创新点声称构建先前工作候选池（稿件参考文献解析 + 学术检索 + 在库全文升级），
            经 3 次有界模型调用产出可回放锚定的比较与差距行动清单。需要已解析的稿件（PDF/LaTeX 均可）。
          </span>
          <p>
            <button type="button" className="btn btn-small" onClick={onEvaluate} disabled={evaluating} data-testid="target-evidence-audit-run">
              {evaluating ? "审计中…" : "执行证据审计（3 次模型调用）"}
            </button>
          </p>
        </div>
      ) : (
        <>
          {audit.stale ? (
            <div className="note note-warn" role="status" data-testid="target-evidence-audit-stale">
              <span>
                <span className="note-mark">●</span> 审计结果相对当前稿已陈旧（{audit.staleReason ?? "稿件或参照池变更"}）——
                以下内容是历史工件，不可当作当前结论。
                <button type="button" className="btn-link" onClick={onEvaluate} disabled={evaluating}>
                  {evaluating ? "重新审计中…" : "重新审计"}
                </button>
              </span>
            </div>
          ) : null}
          {/* 审计概览：pool 构成 / 守卫 / 调用账 */}
          <div className="kv" data-testid="target-evidence-audit-overview">
            <div className="kv-row">
              <dt>先前工作池</dt>
              <dd>
                {audit.artifact.priorWork.poolSize} 篇（已核验全文{" "}
                {audit.artifact.priorWork.candidates.filter((c) => c.contentLevel === "verified_fulltext").length} / 摘要{" "}
                {audit.artifact.priorWork.candidates.filter((c) => c.contentLevel === "abstract").length} / 题录{" "}
                {audit.artifact.priorWork.candidates.filter((c) => c.contentLevel === "metadata").length}）
                {audit.meta !== null ? (
                  <span className="faint">
                    {" "}— 稿件参考文献 {audit.meta.poolBuild.referenceEntriesTotal} 条（解析 {audit.meta.poolBuild.refResolved}/{audit.meta.poolBuild.referenceEntriesEligible}）；
                    外部检索 {audit.meta.poolBuild.externalRetrieved} 条；在库全文升级 {audit.meta.poolBuild.libraryUpgraded} 篇；
                    模型调用 {audit.meta.telemetry.calls} 次（{(audit.meta.telemetry.totalMs / 1000).toFixed(1)}s）
                  </span>
                ) : null}
              </dd>
            </div>
            <div className="kv-row">
              <dt>确定性守卫</dt>
              <dd className="faint mono" data-testid="target-evidence-audit-guards">
                {`anchorFailures=${audit.artifact.guards.anchorFailures} unresolvedRefs=${audit.artifact.guards.unresolvedPriorWorkRefs} cutoffViolations=${audit.artifact.guards.cutoffViolations} statusRuleViolations=${audit.artifact.guards.statusRuleViolations} priorQuoteReplayFailures=${audit.artifact.guards.priorQuoteReplayFailures} fulltextBasisDowngrades=${audit.artifact.guards.fulltextBasisDowngrades} droppedFindings=${audit.artifact.guards.droppedFindings}`}
              </dd>
            </div>
            {audit.meta !== null && audit.meta.poolBuild.buildNotes.length > 0 ? (
              <div className="kv-row">
                <dt>构建说明（如实降级）</dt>
                <dd>
                  <ul className="faint target-profile-notes">
                    {audit.meta.poolBuild.buildNotes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </dd>
              </div>
            ) : null}
          </div>

          {/* 逐贡献比较 */}
          <ul className="gate-rule-list" data-testid="target-evidence-audit-comparisons">
            {audit.artifact.inventory.map((unit) => {
              const comparison = audit.artifact.comparisons.find((c) => c.contributionId === unit.contributionId);
              const meta = comparison !== undefined ? AUDIT_STATUS_META[comparison.status] : null;
              return (
                <li key={unit.contributionId} className="gate-rule" data-testid="target-evidence-audit-contribution">
                  {meta !== null ? (
                    <span className={`status status-tone-${meta.tone} gate-rule-status`} title={meta.hint}>
                      {meta.label}
                    </span>
                  ) : (
                    <span className="status status-tone-neutral gate-rule-status">未比较</span>
                  )}
                  <div className="gate-rule-body">
                    <span className="gate-rule-name">
                      {unit.contributionId} · {CLAIM_TYPE_LABELS[unit.claimType] ?? unit.claimType}
                      <span className="faint"> · 声称锚 {unit.sectionId}{unit.page !== undefined ? ` p.${unit.page}` : ""}（{unit.anchorVerified ? "已核验" : "未核验"}）· 支撑 {unit.supportStatus === "located" ? `${unit.supportLocations.length} 处` : "缺失"} · 依据级 {comparison?.differenceBasis ?? "—"}</span>
                    </span>
                    <blockquote className="section-note">“{unit.claimQuote}”</blockquote>
                    {comparison !== undefined ? (
                      <span className="gate-rule-detail">
                        {comparison.nearestPriorWorks.length > 0 ? "最近先前工作：" : "（未给出可解析先前工作——按规则不得判差异成立）"}
                        <ul className="target-gap-list">
                          {comparison.nearestPriorWorks.map((prior, index) => (
                            <li key={index}>
                              「{prior.title}」{identityLabel(prior)}
                              <span className={`chip ${prior.resolvesToPool ? "chip-tone-info" : "chip-tone-warn"}`}>
                                {SOURCE_LEVEL_LABELS[prior.sourceLevel ?? ""] ?? prior.sourceLevel ?? "未标注"}
                              </span>
                              {prior.timeCausalityViolation === true ? <span className="chip chip-tone-warn">时间因果违规</span> : null}
                              {prior.quote !== undefined ? (
                                prior.priorQuoteVerified === true ? (
                                  <span className="chip chip-tone-info">quote 已回放</span>
                                ) : (
                                  <span className="chip chip-tone-warn">quote 未通过回放（不作证据）</span>
                                )
                              ) : null}
                            </li>
                          ))}
                        </ul>
                        {comparison.commonMechanism !== "" ? <>共同机制：{comparison.commonMechanism}<br /></> : null}
                        {comparison.substantiveDifference !== "" ? <>实质差异：{comparison.substantiveDifference}<br /></> : null}
                        {comparison.completedVerification !== "" ? <>已验证：{comparison.completedVerification}<br /></> : null}
                        {comparison.missingVerification !== "" ? <>缺验证：{comparison.missingVerification}</> : null}
                        {comparison.uncertainty !== undefined ? <><br /><span className="faint">不确定性：{comparison.uncertainty}</span></> : null}
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>

          {/* 行动清单（可改写 / 需真实实验或作者输入） */}
          {audit.artifact.gapPlan.length > 0 ? (
            <div className="target-evidence-audit-gapplan" data-testid="target-evidence-audit-gapplan">
              <div className="gate-rules-head">
                <h4>差距行动清单</h4>
                <span className="faint">requires_real_experiment 项停在 Author Decision——系统不编造实验数字</span>
              </div>
              <ul className="rule-list">
                {audit.artifact.gapPlan.map((item) => (
                  <GapPlanItem key={`${item.contributionId}-${item.gap.slice(0, 24)}`} item={item} />
                ))}
              </ul>
            </div>
          ) : null}

          {/* findings */}
          {audit.artifact.findings.length > 0 ? (
            <details data-testid="target-evidence-audit-findings">
              <summary className="faint">审查发现（{audit.artifact.findings.length} 条 · advisory）</summary>
              <ul className="rule-list">
                {audit.artifact.findings.map((finding) => (
                  <li key={finding.findingId} className="rule-item">
                    <span className={`status status-tone-${finding.severity === "critical" || finding.severity === "major" ? "danger" : "neutral"}`}>
                      {finding.severity}·{finding.category}
                    </span>
                    <div>
                      <strong>{finding.sectionId}</strong>
                      {finding.contributionId !== undefined ? `（${finding.contributionId}）` : ""}：{finding.message}
                      {finding.evidenceGap !== undefined ? <div className="faint">证据缺口：{finding.evidenceGap}</div> : null}
                      {finding.suggestion !== undefined ? <div className="faint">建议：{finding.suggestion}</div> : null}
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <p>
            <button type="button" className="btn btn-small" onClick={onEvaluate} disabled={evaluating} data-testid="target-evidence-audit-rerun">
              {evaluating ? "审计中…" : "重新审计（覆盖当前工件）"}
            </button>
          </p>
          <p className="section-note faint">{audit.artifact.provenance.disclaimer}</p>
        </>
      )}
    </div>
  );
}

function GapPlanItem({ item }: { item: EvidenceAuditGapPlanItemView }) {
  const needsExperiment = item.actionType === "requires_real_experiment_or_author_input";
  return (
    <li className="rule-item" data-testid="target-evidence-audit-gapitem">
      <span className={`status status-tone-${needsExperiment ? "warn" : "info"}`}>
        {needsExperiment ? "需真实实验/作者输入" : "可基于现有证据改写"}
      </span>
      <div>
        <strong>{item.contributionId}</strong>：{item.gap}
        {needsExperiment && item.experimentPlan !== undefined ? (
          <div className="faint">
            实验目的：{item.experimentPlan.purpose}
            {item.experimentPlan.baselines !== undefined ? `；基线：${item.experimentPlan.baselines}` : ""}
            {item.experimentPlan.datasets !== undefined ? `；数据集：${item.experimentPlan.datasets}` : ""}
            {item.experimentPlan.metrics !== undefined ? `；指标：${item.experimentPlan.metrics}` : ""}
            {item.experimentPlan.expectedEvidence !== undefined ? `；所需证据：${item.experimentPlan.expectedEvidence}` : ""}
            <br />
            （停在 Author Decision——需作者确认或补充真实实验，系统不自动执行、不伪造数据）
          </div>
        ) : null}
      </div>
    </li>
  );
}

// ---- M15.17：审计差距 → 修订计划区块 ----

const AUDIT_CLASSIFICATION_META: Record<AuditGapClassification, { label: string; tone: "ok" | "info" | "warn" | "neutral" }> = {
  REWRITE_ELIGIBLE: { label: "可基于现有证据改写", tone: "ok" },
  NEEDS_REAL_EXPERIMENT_OR_AUTHOR_INPUT: { label: "需真实实验 / 作者输入", tone: "warn" },
  NEEDS_TARGETED_EVIDENCE: { label: "需查阅 / 补充证据", tone: "info" },
  EVIDENCE_INSUFFICIENT: { label: "审计证据不足（作者裁决）", tone: "neutral" },
  UNMAPPABLE_TARGET: { label: "无法定位可编辑目标", tone: "neutral" },
};

const AUDIT_CLOSURE_META: Record<string, { label: string; tone: "ok" | "info" | "warn" | "neutral" }> = {
  VALIDATED_FIXED: { label: "已验证解决（机器可证）", tone: "ok" },
  PARTIALLY_ADDRESSED: { label: "部分解决", tone: "info" },
  STILL_OPEN: { label: "仍未解决", tone: "warn" },
  NEEDS_AUTHOR_DECISION: { label: "待作者决策 / 实验补充", tone: "warn" },
  ALREADY_SATISFIED: { label: "基线已覆盖", tone: "ok" },
  AUTHOR_REJECTED: { label: "作者不采纳", tone: "neutral" },
  NOT_EVALUATED: { label: "不可复评", tone: "neutral" },
};

const INSTRUCTION_STATUS_LABEL: Record<string, string> = {
  pending: "待派发",
  handled: "已处理",
  partially_handled: "部分处理",
  unresolved: "未处理",
  conflict: "与事实冲突（保留事实）",
  already_satisfied: "当前稿已满足",
};

function TargetAuditRevisionSection({
  auditStale,
  planStatus,
  pending,
  error,
  generating,
  deciding,
  reassessing,
  onGenerate,
  onDecide,
  onReassess,
  onRetry,
}: {
  auditStale: boolean;
  planStatus: { enabled: boolean; plan: AuditRevisionPlanView | null; report: AuditClosureReportView | null } | null;
  pending: boolean;
  error: string | null;
  generating: boolean;
  deciding: boolean;
  reassessing: boolean;
  onGenerate: () => void;
  onDecide: (decisions: Array<{ itemId: string; decision: "approve" | "reject" }>) => void;
  onReassess: () => void;
  onRetry: () => void;
}) {
  const plan = planStatus?.plan?.plan ?? null;
  const instructionById = new Map((planStatus?.plan?.instructions ?? []).map((instruction) => [instruction.instructionId, instruction]));
  const report = planStatus?.report ?? null;
  const canGenerate = !auditStale;
  return (
    <div className="target-audit-revision" data-testid="target-audit-revision-section">
      <div className="gate-rules-head">
        <h3>审计差距 → 修订计划（实验性）</h3>
        {plan !== null ? (
          <span className="faint">
            计划 {plan.planId} · 生成于 {formatDateTime(plan.createdAt) ?? "—"} · 状态 {plan.status === "decided" ? "已决策" : "待决策"}
            {" "}· 绑定修订 r{plan.source.manuscriptRevisionAtPlan ?? "?"}
          </span>
        ) : null}
      </div>
      {pending ? (
        <Loading label="加载审计修订计划…" />
      ) : error !== null ? (
        <ErrorState title="审计修订计划加载失败" message={error} onRetry={onRetry} />
      ) : plan === null ? (
        <div className="state-block state-empty" data-testid="target-audit-revision-empty">
          <strong>尚未制定修改计划</strong>
          <span>
            把证据审计的差距清单（gapPlan）经确定性门禁分类为「可改写 / 需真实实验 / 需补证据 / 不可定位」，
            作者逐项决策后，可改写项转入修订意见队列（由既有改进工作流执行——全套事实 / 引用 / 范围守卫生效；
            需实验项停在作者裁决，系统不伪造数据）。
          </span>
          <p>
            <button
              type="button"
              className="btn btn-small"
              onClick={onGenerate}
              disabled={generating || !canGenerate}
              data-testid="target-audit-revision-generate"
            >
              {generating ? "生成中…" : "根据审计建议制定修改计划（零模型调用）"}
            </button>
          </p>
        </div>
      ) : (
        <>
          {auditStale || !planStatus?.plan?.fresh ? (
            <div className="note note-warn" role="status" data-testid="target-audit-revision-stale">
              <span>
                <span className="note-mark">●</span> 计划相对当前状态已陈旧（
                {planStatus?.plan?.staleReason ?? "证据审计已陈旧"}）——决策入口已关闭；重新执行证据审计后再生成新计划。
              </span>
            </div>
          ) : null}
          <div className="kv" data-testid="target-audit-revision-summary">
            <div className="kv-row">
              <dt>分类汇总</dt>
              <dd>
                共 {plan.summary.total} 项：可改写 {plan.summary.rewriteEligible} · 需真实实验 {plan.summary.needsRealExperiment} ·
                需补证据 {plan.summary.needsTargetedEvidence} · 证据不足 {plan.summary.evidenceInsufficient} · 不可定位 {plan.summary.unmappable}
                {plan.status === "decided" ? `（已批准 ${plan.summary.approved} / 已拒绝 ${plan.summary.rejected}）` : ""}
              </dd>
            </div>
          </div>
          <ul className="rule-list" data-testid="target-audit-revision-items">
            {plan.items.map((item) => (
              <AuditPlanItemRow
                key={item.itemId}
                item={item}
                fresh={planStatus?.plan?.fresh ?? false}
                decided={plan.status === "decided"}
                instruction={item.instructionId !== undefined ? instructionById.get(item.instructionId) : undefined}
                deciding={deciding}
                onDecide={onDecide}
              />
            ))}
          </ul>
          {plan.summary.approved + plan.summary.rejected > 0 ? (
            <div className="note note-info" data-testid="target-audit-revision-dispatch-hint">
              <span>
                已批准的可改写项已转入「外部修改意见」队列（来源：目标期刊证据审计 advisory——派发优先级低于真人意见）。
                在工作流面板启动「论文改进」后由 Writer 按既有守卫执行；需真实实验项登记在作者裁决队列（不派发、不伪造数据）。
                执行并产生修订后，点击下方「复评闭环」查看逐项结果。
              </span>
            </div>
          ) : null}
          <p>
            <button
              type="button"
              className="btn btn-small"
              onClick={onReassess}
              disabled={reassessing || plan.summary.approved + plan.summary.rejected === 0}
              data-testid="target-audit-revision-reassess"
            >
              {reassessing ? "复评中…" : "复评闭环（确定性核对，零模型）"}
            </button>
          </p>
          {report !== null ? <AuditClosureReportViewBlock report={report} /> : null}
        </>
      )}
    </div>
  );
}

function AuditPlanItemRow({
  item,
  fresh,
  decided,
  instruction,
  deciding,
  onDecide,
}: {
  item: AuditRevisionPlanItemView;
  fresh: boolean;
  decided: boolean;
  instruction?: { instructionId: string; status: string; statusNote?: string; section?: string };
  deciding: boolean;
  onDecide: (decisions: Array<{ itemId: string; decision: "approve" | "reject" }>) => void;
}) {
  const meta = AUDIT_CLASSIFICATION_META[item.classification];
  const decision = item.authorDecision?.decision;
  return (
    <li className="rule-item" data-testid="target-audit-revision-item">
      <span className={`status status-tone-${meta.tone}`}>{meta.label}</span>
      <div>
        <strong>
          {item.itemId}（贡献 {item.contributionId}）
        </strong>
        ：{item.gap}
        <div className="faint">分类依据：{item.classificationReason}</div>
        {item.anchor.claimQuote !== "" ? (
          <blockquote className="claim-quote">
            「{item.anchor.claimQuote.slice(0, 220)}
            {item.anchor.claimQuote.length > 220 ? "…" : ""}」
          </blockquote>
        ) : null}
        <div className="faint">
          锚定：审计节 {item.anchor.sectionId || "—"} ·{" "}
          {item.anchor.projection.status === "resolved"
            ? `可编辑目标 ${item.anchor.projection.file}${item.anchor.projection.ambiguous === true ? "（多文件命中，按节序定位）" : ""}（quote 回放核验通过）`
            : `不可投影（${item.anchor.projection.reason === "no-editable-manuscript" ? "项目无可编辑稿件" : item.anchor.projection.reason === "quote-ambiguous" ? "quote 多文件命中" : "quote 无法回放"}）——不改写`}
        </div>
        {item.priorWork.length > 0 ? (
          <div className="faint">
            先前工作：
            {item.priorWork
              .map(
                (ref) =>
                  `${ref.title}（${ref.year ?? "?"}${ref.doi !== undefined ? ` · doi:${ref.doi}` : ""}；${ref.resolvesToPool ? "身份可解析" : "不可解析"}${ref.priorQuoteVerified === true ? " · quote 已回放" : ""}）`,
              )
              .join("；")}
          </div>
        ) : (
          <div className="faint">先前工作：无可解析身份（不得新增比较结论）</div>
        )}
        {item.forbidden.citationKeys.length > 0 || item.forbidden.values.length > 0 ? (
          <div className="faint">
            禁止变更：数值 {item.forbidden.values.slice(0, 8).join("、")}
            {item.forbidden.values.length > 8 ? ` 等 ${item.forbidden.values.length} 项` : ""}
            {" "}· cite key {item.forbidden.citationKeys.slice(0, 8).join("、")}
            {item.forbidden.citationKeys.length > 8 ? ` 等 ${item.forbidden.citationKeys.length} 个` : ""}
          </div>
        ) : null}
        {item.classification === "REWRITE_ELIGIBLE" ? (
          <div className="faint">允许的修改：{item.allowedScope}</div>
        ) : null}
        {item.experimentPlan !== undefined ? (
          <div className="faint">
            实验需求：目的 {item.experimentPlan.purpose}
            {item.experimentPlan.baselines !== undefined ? `；基线 ${item.experimentPlan.baselines}` : ""}
            {item.experimentPlan.datasets !== undefined ? `；数据集 ${item.experimentPlan.datasets}` : ""}
            {item.experimentPlan.metrics !== undefined ? `；指标 ${item.experimentPlan.metrics}` : ""}
            {item.experimentPlan.expectedEvidence !== undefined ? `；所需证据 ${item.experimentPlan.expectedEvidence}` : ""}
          </div>
        ) : null}
        {instruction !== undefined ? (
          <div className="faint">
            已转入意见队列（{instruction.instructionId}）：状态 {INSTRUCTION_STATUS_LABEL[instruction.status] ?? instruction.status}
            {instruction.statusNote !== undefined ? ` · ${instruction.statusNote.slice(0, 120)}` : ""}
          </div>
        ) : null}
        {!decided && fresh && item.authorDecision === undefined ? (
          <p>
            <button
              type="button"
              className="btn btn-small"
              disabled={deciding}
              onClick={() => onDecide([{ itemId: item.itemId, decision: "approve" }])}
              data-testid={`target-audit-revision-approve-${item.itemId}`}
            >
              批准转入
            </button>{" "}
            <button
              type="button"
              className="btn btn-small btn-danger"
              disabled={deciding}
              onClick={() => onDecide([{ itemId: item.itemId, decision: "reject" }])}
              data-testid={`target-audit-revision-reject-${item.itemId}`}
            >
              不采纳
            </button>
          </p>
        ) : decision !== undefined ? (
          <div className="faint">
            作者决策：{decision === "approve" ? "已批准（转入执行通道）" : "不采纳"}
            {item.authorDecision !== undefined ? `（${formatDateTime(item.authorDecision.decidedAt) ?? ""}）` : ""}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function AuditClosureReportViewBlock({ report }: { report: AuditClosureReportView }) {
  const summaryRecord = report.summary as unknown as Record<string, number>;
  return (
    <details className="details-block" data-testid="target-audit-revision-report" open>
      <summary>
        闭环复评报告（{report.reportId} · 评估于修订 r{report.assessedAtRevision ?? "?"} · {formatDateTime(report.generatedAt) ?? "—"}）
      </summary>
      <div className="kv">
        <div className="kv-row">
          <dt>闭环汇总</dt>
          <dd>
            共 {report.summary.total} 项：
            {Object.entries(AUDIT_CLOSURE_META)
              .filter(([key]) => (summaryRecord[key] ?? 0) > 0)
              .map(([key, meta]) => `${meta.label} ${summaryRecord[key] ?? 0}`)
              .join(" · ")}
            {report.auditStaleNow ? "（注：证据审计工件相对当前稿已陈旧——复评为确定性核对，不依赖重新审计）" : ""}
          </dd>
        </div>
      </div>
      <ul className="rule-list">
        {report.items.map((item) => {
          const meta = AUDIT_CLOSURE_META[item.closure] ?? { label: item.closure, tone: "neutral" as const };
          return (
            <li className="rule-item" key={item.itemId} data-testid="target-audit-revision-report-item">
              <span className={`status status-tone-${meta.tone}`}>{meta.label}</span>
              <div>
                <strong>{item.itemId}</strong>（{AUDIT_CLASSIFICATION_META[item.classification]?.label ?? item.classification}）：{item.basis}
                {item.patches !== undefined && item.patches.length > 0 ? (
                  <div className="faint">
                    patch lineage：
                    {item.patches.map((patch) => `${patch.patchId}@rev${patch.revision}（${patch.finalStatus}）`).join("、")}
                  </div>
                ) : null}
                {item.verification !== undefined ? (
                  <div className="faint">
                    守卫：scope {item.verification.scope === true ? "✓" : item.verification.scope === false ? "✗" : "—"} ·
                    fact {item.verification.fact === true ? "✓" : item.verification.fact === false ? "✗" : "—"} ·
                    citation {item.verification.citation === true ? "✓" : item.verification.citation === false ? "✗" : "—"}
                  </div>
                ) : null}
                {item.checks !== undefined ? (
                  <div className="faint" data-testid="target-audit-revision-report-checks">
                    证据门：落盘 lineage {item.checks.lineage ? "✓" : "✗"} · 目标绑定 {item.checks.targetBinding ? "✓" : "✗"} ·
                    内容变化 {item.checks.contentChanged ? "✓" : "✗"} · 未回退 {item.checks.notReverted ? "✓" : "✗"} ·
                    守卫 {item.checks.guards ? "✓" : "✗"}
                  </div>
                ) : null}
                {item.lineage !== undefined && item.lineage.length > 0 ? (
                  <div className="faint">
                    修订 lineage：
                    {item.lineage
                      .map((entry) => `${entry.file ?? "?"}@rev${entry.revision ?? "?"}（${entry.patchIds?.join("+") ?? entry.planItemId}；${(entry.beforeSha256 ?? "").slice(0, 8)}→${(entry.afterSha256 ?? "").slice(0, 8)}）`)
                      .join("、")}
                  </div>
                ) : null}
                {item.openSubItems !== undefined && item.openSubItems.length > 0 ? (
                  <div className="faint">
                    仍开放的子条：{item.openSubItems.map((entry) => `${entry.planItemId}（${entry.outcome}）`).join("、")}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="section-note faint">{report.disclaimer}</p>
    </details>
  );
}
