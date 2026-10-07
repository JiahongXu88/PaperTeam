import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Icon } from "../common/Icon.js";
import { ErrorState, Loading } from "../common/StateViews.js";
import { getProject } from "../../api/projects.js";
import {
  confirmTargetBenchmark,
  discoverTargetBenchmark,
  evaluateTargetReadiness,
  excludeTargetBenchmarkPaper,
  getTargetBenchmark,
  getTargetProfile,
  getTargetReadiness,
  regenerateTargetProfile,
  type DistributionView,
  type TargetProfileView,
  type TargetReadinessDimensionView,
  type TargetReadinessView,
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

      <p className="section-note faint">
        目标带来自冻结 benchmark 语料的确定性观测（research/target-profile.json），不是期刊/会议官方投稿要求；
        就绪度差距是与目标带的距离陈述，不构成稿件事实错误，也不阻断任何质量门禁。
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
