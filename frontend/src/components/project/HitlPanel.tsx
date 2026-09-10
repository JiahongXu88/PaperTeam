import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Icon } from "../common/Icon.js";
import { InlineConfirm } from "../common/RowMenu.js";
import { RegistryStatus } from "../common/StatusBadge.js";
import {
  FEASIBILITY_LEVEL_STYLES,
  stageLabel,
  statusStyleOf,
} from "../common/status.js";
import { TARGET_PROFILE_OPTIONS } from "../../constants/projectMeta.js";
import { queryKeys, useResumeWorkflowRun } from "../../hooks/queries.js";
import { ApiError } from "../../api/client.js";
import { formatApiErrorDetail } from "../../utils/errors.js";
import type { HitlDecisionInput, WorkflowRunView } from "../../types/api.js";

/**
 * HITL 决策面板（M4.5）：workflow 停在 awaiting_input 时的统一交互壳。
 *
 * 数据全部来自 run.awaiting（checkpoint 持久化，刷新 / 重启后仍在）：
 *   prompt      为什么暂停、需要用户决定什么
 *   payload     该节点的业务上下文（可行性结论 / 大纲 / 改进计划 / Gate 摘要），
 *               按 stageId 选择 renderer —— 统一 shell + 差异化 payload 展示
 *   options     允许的 decision（严格按后端契约渲染，未提供的动作不出现）
 *
 * 提交走 POST /api/runs/:id/resume；409（过期请求 / 非法决策）时失效 run
 * 列表取回权威状态：请求已被其它页面处理 → 面板自然消失，页面不卡死。
 */

type OpenForm = "adjust" | "revise" | null;

export function HitlPanel({ run }: { run: WorkflowRunView }) {
  const awaiting = run.awaiting;
  const resume = useResumeWorkflowRun(run.projectId);
  const queryClient = useQueryClient();
  const [openForm, setOpenForm] = useState<OpenForm>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const formId = useId();

  if (awaiting === null || awaiting === undefined) {
    return null;
  }

  const pending = resume.isPending;
  const options = awaiting.options;

  const submit = (input: HitlDecisionInput) => {
    resume.mutate(
      { runId: run.runId, input },
      {
        onSuccess: () => {
          setOpenForm(null);
          setConfirmingCancel(false);
        },
        onError: (error) => {
          // 过期请求（其它页面已 resume / 状态已变化）：取回权威状态，
          // 若 run 已不在 awaiting_input，本面板随缓存更新自然卸载
          if (error instanceof ApiError && error.code === "WORKFLOW_INVALID_STATE") {
            void queryClient.invalidateQueries({ queryKey: queryKeys.projectRuns(run.projectId) });
          }
          setConfirmingCancel(false);
        },
      },
    );
  };

  const hasApprove = options.includes("approve");
  const hasAdjust = options.includes("adjust");
  const hasRevise = options.includes("revise");
  const hasAcceptDraft = options.includes("accept_draft");
  const hasReviseMore = options.includes("revise_more");
  const hasCancel = options.includes("cancel");
  const supportsForm = hasAdjust || hasRevise;

  return (
    <section className="panel section-block hitl-panel" data-testid="hitl-panel" aria-labelledby={`hitl-title-${formId}`}>
      <div className="section-head">
        <h2 id={`hitl-title-${formId}`}>等待你的确认</h2>
        <span className="chip chip-outline" data-testid="hitl-stage">
          <Icon name="clock" />
          {stageLabel(awaiting.stageId) ?? awaiting.stageId}
        </span>
      </div>
      <p className="hitl-lead">
        任务已在此暂停，不会继续消耗模型调用；确认后才会进入下一阶段。
      </p>
      <blockquote className="workflow-awaiting-prompt">{awaiting.prompt}</blockquote>

      <HitlPayload stageId={awaiting.stageId} payload={awaiting.payload} />

      <div className="hitl-actions" data-testid="hitl-actions">
        {hasApprove ? (
          <button
            type="button"
            className="btn btn-primary"
            data-testid="hitl-approve"
            disabled={pending}
            onClick={() => submit({ action: "approve" })}
          >
            <Icon name="play" />
            {pending && resume.variables?.input.action === "approve" ? "提交中…" : "继续"}
          </button>
        ) : null}
        {hasAcceptDraft ? (
          <button
            type="button"
            className="btn btn-primary"
            data-testid="hitl-accept-draft"
            disabled={pending}
            onClick={() => submit({ action: "accept_draft" })}
          >
            <Icon name="download" />
            {pending && resume.variables?.input.action === "accept_draft" ? "提交中…" : "接受为草稿"}
          </button>
        ) : null}
        {hasAdjust ? (
          <button
            type="button"
            className="btn"
            data-testid="hitl-adjust"
            disabled={pending}
            aria-expanded={openForm === "adjust"}
            onClick={() => {
              setOpenForm(openForm === "adjust" ? null : "adjust");
              setConfirmingCancel(false);
            }}
          >
            <Icon name="edit" />
            调整目标
          </button>
        ) : null}
        {hasRevise ? (
          <button
            type="button"
            className="btn"
            data-testid="hitl-revise"
            disabled={pending}
            aria-expanded={openForm === "revise"}
            onClick={() => {
              setOpenForm(openForm === "revise" ? null : "revise");
              setConfirmingCancel(false);
            }}
          >
            <Icon name="edit" />
            提出修改意见
          </button>
        ) : null}
        {hasReviseMore ? (
          <button
            type="button"
            className="btn"
            data-testid="hitl-revise-more"
            disabled={pending}
            title="人工授权追加一轮自动修订（有次数上限）"
            onClick={() => submit({ action: "revise_more" })}
          >
            <Icon name="refresh" />
            再修一轮
          </button>
        ) : null}
        {hasCancel && !confirmingCancel ? (
          <button
            type="button"
            className="btn btn-danger"
            data-testid="hitl-cancel"
            disabled={pending}
            onClick={() => {
              setConfirmingCancel(true);
              setOpenForm(null);
            }}
          >
            <Icon name="minus-circle" />
            取消任务
          </button>
        ) : null}
      </div>

      {hasCancel && confirmingCancel ? (
        <InlineConfirm
          message="确定取消整个任务吗？已完成的阶段与结果会保留，之后的阶段不再执行。"
          confirmLabel="取消任务"
          danger
          pending={pending && resume.variables?.input.action === "cancel"}
          testId="hitl-cancel-confirm"
          onConfirm={() => submit({ action: "cancel" })}
          onCancel={() => setConfirmingCancel(false)}
        />
      ) : null}

      {supportsForm && openForm === "adjust" ? (
        <AdjustForm
          key={`${run.runId}-adjust`}
          pending={pending}
          suggested={readStringArray(awaiting.payload?.["suggestedTargetAdjustment"])}
          onSubmit={(payload) => submit({ action: "adjust", payload })}
          onCancel={() => setOpenForm(null)}
        />
      ) : null}
      {supportsForm && openForm === "revise" ? (
        <ReviseForm
          key={`${run.runId}-revise`}
          pending={pending}
          onSubmit={(feedback) => submit({ action: "revise", payload: { feedback } })}
          onCancel={() => setOpenForm(null)}
        />
      ) : null}

      {resume.isError ? <HitlError error={resume.error} /> : null}
    </section>
  );
}

// ---- 决策表单 ----

/** adjust（仅 hitl.feasibility_confirm）：targetProfile / targetVenue 至少一项 */
function AdjustForm({
  pending,
  suggested,
  onSubmit,
  onCancel,
}: {
  pending: boolean;
  suggested: string[];
  onSubmit: (payload: { targetProfile?: string; targetVenue?: string }) => void;
  onCancel: () => void;
}) {
  const [targetProfile, setTargetProfile] = useState("");
  const [targetVenue, setTargetVenue] = useState("");
  const empty = targetProfile === "" && targetVenue.trim() === "";

  return (
    <form
      className="hitl-form"
      data-testid="hitl-adjust-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!empty) {
          onSubmit({
            ...(targetProfile !== "" ? { targetProfile } : {}),
            ...(targetVenue.trim() !== "" ? { targetVenue: targetVenue.trim() } : {}),
          });
        }
      }}
    >
      <div className="form-section">
        <h3>调整研究目标</h3>
        <p className="field-help">
          调整后系统会重新评估可行性，再回到这里等你确认（有次数上限）。
          {suggested.length > 0 ? `评估建议：${suggested.join("、")}。` : ""}
        </p>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="hitl-target-profile">目标定位</label>
            <select
              id="hitl-target-profile"
              value={targetProfile}
              onChange={(event) => setTargetProfile(event.target.value)}
              disabled={pending}
              autoFocus
              data-testid="hitl-target-profile"
            >
              <option value="">不调整</option>
              {TARGET_PROFILE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="hitl-target-venue">目标期刊 / 会议</label>
            <input
              id="hitl-target-venue"
              type="text"
              value={targetVenue}
              disabled={pending}
              placeholder="例如：某核心期刊（留空 = 不调整）"
              onChange={(event) => setTargetVenue(event.target.value)}
              data-testid="hitl-target-venue"
            />
          </div>
        </div>
      </div>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={pending || empty} data-testid="hitl-adjust-submit">
          {pending ? "提交中…" : "按新目标重新评估"}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={pending}>
          返回
        </button>
        {empty ? <span className="field-help">至少填写一项才会提交。</span> : null}
      </div>
    </form>
  );
}

/** revise（hitl.outline_confirm / hitl.plan_confirm）：非空 feedback，重做当前产物 */
function ReviseForm({
  pending,
  onSubmit,
  onCancel,
}: {
  pending: boolean;
  onSubmit: (feedback: string) => void;
  onCancel: () => void;
}) {
  const [feedback, setFeedback] = useState("");
  const trimmed = feedback.trim();

  return (
    <form
      className="hitl-form"
      data-testid="hitl-revise-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed !== "") {
          onSubmit(trimmed);
        }
      }}
    >
      <div className="form-section">
        <h3>修改意见</h3>
        <div className="field">
          <label htmlFor="hitl-feedback">
            希望如何修改<span className="required" aria-hidden="true">*</span>
          </label>
          <textarea
            id="hitl-feedback"
            value={feedback}
            disabled={pending}
            autoFocus
            placeholder="说明你希望调整的方向，例如补充某个实验、缩小研究范围或修改章节结构。"
            onChange={(event) => setFeedback(event.target.value)}
            data-testid="hitl-feedback"
          />
          <span className="field-help">系统会按你的意见重新生成，再回到这里等你确认（有次数上限）。</span>
        </div>
      </div>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={pending || trimmed === ""} data-testid="hitl-revise-submit">
          {pending ? "提交中…" : "提交并重新生成"}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={pending}>
          返回
        </button>
        {trimmed === "" ? <span className="field-help">填写修改意见后才能提交。</span> : null}
      </div>
    </form>
  );
}

// ---- 错误呈现 ----

/**
 * resume 失败：后端 message 本身是中文业务文案（如「revise 需要携带非空
 * payload.feedback」「大纲修订次数已达上限…」），直接展示；技术细节折叠。
 */
function HitlError({ error }: { error: unknown }) {
  const message = error instanceof ApiError ? error.message : String(error);
  const detail = formatApiErrorDetail(error);
  return (
    <div className="hitl-error" role="alert" data-testid="hitl-error">
      <p className="form-error">{message}</p>
      {detail !== undefined ? (
        <details className="details-block">
          <summary>详细信息</summary>
          <div className="details-body mono">{detail}</div>
        </details>
      ) : null}
    </div>
  );
}

// ---- payload renderer（统一 shell，按 stageId 差异化） ----

function HitlPayload({ stageId, payload }: { stageId: string; payload: Record<string, unknown> | undefined }) {
  if (payload === undefined) {
    return null;
  }
  switch (stageId) {
    case "hitl.feasibility_confirm":
      return <FeasibilityPayload payload={payload} />;
    case "hitl.outline_confirm":
      return <OutlinePayload payload={payload} />;
    case "hitl.plan_confirm":
      return <PlanPayload payload={payload} />;
    case "hitl.revision_overflow":
      return <OverflowPayload payload={payload} />;
    default:
      // 未知 HITL 节点：不虚构内容，prompt 已说明情况
      return null;
  }
}

/** 可行性结论：等级 + 原因 / 缺口 / 需补实验 / 建议（Backend feasibility.json 摘要） */
function FeasibilityPayload({ payload }: { payload: Record<string, unknown> }) {
  const level = typeof payload["level"] === "string" ? payload["level"] : undefined;
  const reasons = readStringArray(payload["reasons"]);
  const missing = readStringArray(payload["missingRequirements"]);
  const experiments = readStringArray(payload["requiredExperiments"]);
  const recommendations = readStringArray(payload["recommendations"]);
  if (
    level === undefined &&
    reasons.length === 0 &&
    missing.length === 0 &&
    experiments.length === 0 &&
    recommendations.length === 0
  ) {
    return null;
  }
  return (
    <div className="hitl-payload" data-testid="hitl-payload-feasibility">
      {level !== undefined ? (
        <p className="hitl-payload-level">
          当前评估结论：
          <RegistryStatus style={statusStyleOf(FEASIBILITY_LEVEL_STYLES, level)} />
        </p>
      ) : null}
      <HitlList title="主要理由" items={reasons} />
      <HitlList title="尚缺的条件" items={missing} tone="warn" empty="暂无明显缺口" />
      <HitlList title="需要补充的实验" items={experiments} empty="暂无" />
      <HitlList title="建议" items={recommendations} empty="暂无" />
    </div>
  );
}

/** 大纲：标题 + 摘要 + 章节列表 */
function OutlinePayload({ payload }: { payload: Record<string, unknown> }) {
  const title = typeof payload["title"] === "string" ? payload["title"] : undefined;
  const abstract = typeof payload["abstract"] === "string" ? payload["abstract"] : undefined;
  const sections = Array.isArray(payload["sections"])
    ? payload["sections"].filter(
        (entry): entry is { id: string; title: string; file: string } =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as Record<string, unknown>)["id"] === "string" &&
          typeof (entry as Record<string, unknown>)["title"] === "string",
      )
    : [];
  if (title === undefined && sections.length === 0) {
    return null;
  }
  return (
    <div className="hitl-payload" data-testid="hitl-payload-outline">
      {title !== undefined ? <p className="hitl-outline-title">{title}</p> : null}
      {abstract !== undefined ? <p className="hitl-outline-abstract">{abstract}</p> : null}
      {sections.length > 0 ? (
        <ol className="hitl-outline-list" data-testid="hitl-outline-sections">
          {sections.map((section) => (
            <li key={section.id}>
              <span className="hitl-outline-section-title">{section.title}</span>
              {typeof section.file === "string" ? <span className="muted mono">{section.file}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/** 改进计划：可行性等级 + 计划条目（章节 → 动作，优先级） */
function PlanPayload({ payload }: { payload: Record<string, unknown> }) {
  const level = typeof payload["feasibilityLevel"] === "string" ? payload["feasibilityLevel"] : undefined;
  const items = Array.isArray(payload["items"])
    ? payload["items"].filter(
        (entry): entry is { section: string; action: string; priority?: string } =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as Record<string, unknown>)["section"] === "string" &&
          typeof (entry as Record<string, unknown>)["action"] === "string",
      )
    : [];
  if (level === undefined && items.length === 0) {
    return null;
  }
  return (
    <div className="hitl-payload" data-testid="hitl-payload-plan">
      {level !== undefined ? (
        <p className="hitl-payload-level">
          目标可行性：
          <RegistryStatus style={statusStyleOf(FEASIBILITY_LEVEL_STYLES, level)} />
        </p>
      ) : null}
      <ol className="hitl-plan-list" data-testid="hitl-plan-items">
        {items.map((item, index) => (
          <li key={`${item.section}-${index}`}>
            <span className="hitl-plan-section mono">{item.section}</span>
            <span className="hitl-plan-action">{item.action}</span>
            {item.priority !== undefined ? (
              <span className={`chip chip-tone-${planPriorityTone(item.priority)}`}>{planPriorityLabel(item.priority)}</span>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** 修订耗尽：Gate 结论 + 审稿问题规模 + 构建状态 */
function OverflowPayload({ payload }: { payload: Record<string, unknown> }) {
  const gatePassed = payload["gatePassed"] === true;
  const gateReasons = readStringArray(payload["gateReasons"]);
  const review = payload["review"];
  const counts =
    typeof review === "object" && review !== null
      ? {
          critical: Number((review as Record<string, unknown>)["critical"] ?? 0),
          major: Number((review as Record<string, unknown>)["major"] ?? 0),
          blocking: Number((review as Record<string, unknown>)["blocking"] ?? 0),
        }
      : undefined;
  const buildOk = payload["buildOk"] === true;
  const buildError = typeof payload["buildError"] === "string" ? payload["buildError"] : undefined;
  return (
    <div className="hitl-payload" data-testid="hitl-payload-overflow">
      <p className="hitl-payload-level">
        Quality Gate：
        <RegistryStatus
          style={gatePassed ? { label: "已通过", tone: "ok" } : { label: "未通过", tone: "warn" }}
        />
      </p>
      <HitlList title="未通过的原因" items={gatePassed ? [] : gateReasons} tone="warn" empty="—" />
      {!gatePassed ? (
        <p className="field-help">
          <button
            type="button"
            className="btn-link"
            onClick={() => document.getElementById("quality-gate-panel")?.scrollIntoView({ behavior: "smooth", block: "start" })}
            data-testid="hitl-goto-gate"
          >
            查看详细判定与处理入口
          </button>
          （本页下方的质量门禁面板）
        </p>
      ) : null}
      {counts !== undefined ? (
        <p className="field-help">
          当前审稿意见规模：严重 {counts.critical} / 主要 {counts.major} / 阻断性 {counts.blocking}。
        </p>
      ) : null}
      <p className="field-help">
        构建：{buildOk ? "PDF 可正常产出。" : buildError !== undefined ? `编译失败（${buildError}）。` : "尚未产出 PDF。"}
      </p>
    </div>
  );
}

function HitlList({
  title,
  items,
  tone,
  empty,
}: {
  title: string;
  items: string[];
  tone?: "warn";
  empty?: string;
}) {
  if (items.length === 0 && empty === undefined) {
    return null;
  }
  return (
    <div className="hitl-list">
      <h3>{title}</h3>
      {items.length > 0 ? (
        <ul className={tone === "warn" ? "hitl-list-warn" : undefined}>
          {items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="field-help">{empty}</p>
      )}
    </div>
  );
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function planPriorityTone(priority: string): string {
  if (priority === "high") {
    return "danger";
  }
  if (priority === "low") {
    return "neutral";
  }
  return "warn";
}

function planPriorityLabel(priority: string): string {
  if (priority === "high") {
    return "优先处理";
  }
  if (priority === "low") {
    return "较低优先";
  }
  return "常规";
}
