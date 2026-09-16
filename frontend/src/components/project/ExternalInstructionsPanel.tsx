import { useState } from "react";

import { Icon } from "../common/Icon.js";
import {
  useAddExternalInstruction,
  useDeleteExternalInstruction,
  useExternalInstructions,
} from "../../hooks/queries.js";
import { formatApiError } from "../../utils/errors.js";
import type { ExternalInstructionSource, ExternalInstructionView } from "../../types/api.js";

/**
 * 外部修改意见面板（M5.7）：期刊专家 / 编辑 / 导师 / 用户要求 → 修订计划。
 *
 * 纪律（与后端一致）：
 * - 意见是最高**业务**修改优先级（mandatory），但永远不绕过 Fact / Citation
 *   Preservation 等确定性 Gate——与实验事实冲突时如实标记 conflict，不篡改数据；
 * - 原文逐字保存（statusNote / 冲突依据可追溯）；
 * - 状态是确定性判定（handled = Writer 报告 applied 且目标文件真实变化，
 *   且未触发事实保持失败）。
 */

const SOURCE_OPTIONS: Array<{ value: ExternalInstructionSource; label: string }> = [
  { value: "journal_reviewer", label: "期刊外审专家" },
  { value: "user", label: "用户要求" },
  { value: "editor", label: "编辑" },
  { value: "advisor", label: "导师" },
  { value: "other", label: "其他" },
];

const SOURCE_LABEL: Record<ExternalInstructionSource, string> = {
  journal_reviewer: "期刊外审专家",
  user: "用户要求",
  editor: "编辑",
  advisor: "导师",
  other: "其他",
};

const STATUS_VIEW: Record<
  ExternalInstructionView["status"],
  { label: string; tone: "ok" | "info" | "warn" | "neutral" }
> = {
  pending: { label: "待派发", tone: "neutral" },
  handled: { label: "已处理", tone: "ok" },
  partially_handled: { label: "部分处理", tone: "info" },
  unresolved: { label: "未处理", tone: "warn" },
  conflict: { label: "与事实 / Evidence 冲突", tone: "warn" },
};

const TEXT_MAX_CHARS = 8000;

export function ExternalInstructionsPanel({ projectId }: { projectId: string }) {
  const query = useExternalInstructions(projectId);
  const add = useAddExternalInstruction(projectId);
  const remove = useDeleteExternalInstruction(projectId);

  const [source, setSource] = useState<ExternalInstructionSource>("journal_reviewer");
  const [reviewerLabel, setReviewerLabel] = useState("");
  const [section, setSection] = useState("");
  const [text, setText] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const instructions = query.data?.instructions ?? [];
  const sectionOptions = query.data?.sectionOptions ?? [];

  const canSubmit = text.trim() !== "" && !add.isPending;

  const handleSubmit = () => {
    if (!canSubmit) {
      return;
    }
    add.mutate(
      {
        source,
        text: text.trim(),
        ...(reviewerLabel.trim() !== "" ? { reviewerLabel: reviewerLabel.trim() } : {}),
        ...(section !== "" ? { section } : {}),
      },
      {
        onSuccess: () => {
          setText("");
          setReviewerLabel("");
        },
      },
    );
  };

  return (
    <section className="section-block" data-testid="external-instructions-panel">
      <div className="section-head">
        <h2>外部修改意见</h2>
        <span className="muted">专家 / 导师 / 编辑 / 本人要求 → 修订计划（mandatory）</span>
      </div>
      <p className="panel-sub">
        手工录入期刊外审专家、编辑、导师或你自己的修改要求。意见以最高业务优先级进入修订计划；
        但任何意见都不会绕过事实 / 引用 / 证据等确定性安全门禁——与实验事实冲突时会明确标记冲突并保留原结果。
      </p>

      <form
        className="external-instruction-form"
        onSubmit={(event) => {
          event.preventDefault();
          handleSubmit();
        }}
      >
        <div className="external-instruction-form-row">
          <div className="field">
            <label htmlFor="ext-source">来源</label>
            <select
              id="ext-source"
              value={source}
              onChange={(event) => setSource(event.target.value as ExternalInstructionSource)}
              data-testid="external-source-select"
            >
              {SOURCE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ext-reviewer-label">Reviewer 标识（可选）</label>
            <input
              id="ext-reviewer-label"
              type="text"
              value={reviewerLabel}
              onChange={(event) => setReviewerLabel(event.target.value)}
              placeholder="如 Reviewer 2"
              maxLength={100}
              data-testid="external-reviewer-label"
            />
          </div>
          <div className="field">
            <label htmlFor="ext-section">涉及章节（可选）</label>
            <select
              id="ext-section"
              value={section}
              onChange={(event) => setSection(event.target.value)}
              data-testid="external-section-select"
            >
              <option value="">不限定（全篇）</option>
              {sectionOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="ext-text">修改意见（整段粘贴即可；原文逐字保存）</label>
          <textarea
            id="ext-text"
            value={text}
            onChange={(event) => setText(event.target.value.slice(0, TEXT_MAX_CHARS))}
            rows={5}
            placeholder={"Reviewer 2:\n1. 请补充与 ByteTrack 的对比。\n2. 第 3.7 节需要弱化显著性表述。"}
            data-testid="external-text-input"
          />
          <span className="field-help">
            {text.length}/{TEXT_MAX_CHARS} · 优先级恒为「必须处理」（mandatory）；多条意见请分条添加
          </span>
        </div>
        <div className="form-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!canSubmit}
            data-testid="add-external-instruction"
          >
            <Icon name="plus" />
            {add.isPending ? "添加中…" : "添加到修改计划"}
          </button>
        </div>
        {add.isError ? (
          <p className="form-error" role="alert" data-testid="external-add-error">
            添加失败：{formatApiError(add.error)}
          </p>
        ) : null}
      </form>

      {query.isError ? (
        <p className="form-error" role="alert">
          意见列表加载失败：{formatApiError(query.error)}
          <button type="button" className="btn-link" onClick={() => void query.refetch()}>
            重试
          </button>
        </p>
      ) : null}

      {instructions.length > 0 ? (
        <ul className="external-instruction-list" data-testid="external-instruction-list">
          {instructions.map((instruction) => {
            const status = STATUS_VIEW[instruction.status];
            return (
              <li
                key={instruction.instructionId}
                className={`external-instruction-item${instruction.status === "conflict" ? " external-instruction-conflict" : ""}`}
                data-testid={`external-instruction-${instruction.instructionId}`}
              >
                <div className="external-instruction-head">
                  <span className="chip chip-tone-info">
                    {SOURCE_LABEL[instruction.source]}
                    {instruction.reviewerLabel !== undefined ? ` · ${instruction.reviewerLabel}` : ""}
                  </span>
                  <span className="chip chip-tone-danger">必须处理</span>
                  <span className={`status status-tone-${status.tone}`} data-testid={`external-status-${instruction.instructionId}`}>
                    {status.label}
                  </span>
                  <span className="muted mono external-instruction-section">
                    {instruction.section ?? "全篇"}
                  </span>
                  {confirmRemove === instruction.instructionId ? (
                    <span className="inline-confirm" role="group">
                      <button
                        type="button"
                        className="btn btn-small btn-danger"
                        onClick={() => {
                          setConfirmRemove(null);
                          remove.mutate(instruction.instructionId);
                        }}
                        data-testid={`external-remove-confirm-${instruction.instructionId}`}
                      >
                        确认删除
                      </button>
                      <button type="button" className="btn btn-small" onClick={() => setConfirmRemove(null)}>
                        取消
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => setConfirmRemove(instruction.instructionId)}
                      title="删除这条意见（不影响已产生的修订）"
                      data-testid={`external-remove-${instruction.instructionId}`}
                    >
                      删除
                    </button>
                  )}
                </div>
                <pre className="external-instruction-text">{instruction.text}</pre>
                {instruction.status === "conflict" ? (
                  <div className="note note-warn" role="status" data-testid={`external-conflict-${instruction.instructionId}`}>
                    <span>
                      <span className="note-mark">⚠</span> 该意见与当前实验事实 / Evidence 冲突，系统未篡改事实，保留原结果。
                      {instruction.conflictBasis !== undefined ? (
                        <>
                          <br />
                          依据：<span className="mono">{instruction.conflictBasis}</span>
                        </>
                      ) : null}
                      <br />
                      可选建议：改为解释性能边界、补充失效原因分析；若确实要证明优势，需要补充新的实验 Evidence。
                    </span>
                  </div>
                ) : instruction.statusNote !== undefined ? (
                  <p className="field-help">{instruction.statusNote}</p>
                ) : null}
                {remove.isError ? (
                  <p className="form-error" role="alert">
                    删除失败：{formatApiError(remove.error)}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        !query.isPending && !query.isError ? (
          <p className="panel-empty">暂无外部修改意见。系统行为与未加入本功能前完全一致。</p>
        ) : null
      )}
    </section>
  );
}
