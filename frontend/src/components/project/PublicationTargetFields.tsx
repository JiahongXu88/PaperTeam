import { useId } from "react";

import { usePublicationTargetOptions } from "../../hooks/queries.js";
import type { PublicationScheme, PublicationTargetInput, PublicationTargetView } from "../../types/api.js";

/**
 * 发表目标（可选）表单片段：体系 → 层级 → 名单年份 → 期刊（已核验资料 / 自填名称二选一）。
 * 选项全部来自 GET /api/publication-target/options（后端唯一事实源）；本组件不判断「是否达标」。
 */
export interface PublicationTargetDraft {
  scheme: PublicationScheme;
  tier: string;
  schemeYear: string;
  journalMode: "none" | "verified" | "custom";
  targetJournalId: string;
  customJournalName: string;
}

export const EMPTY_PUBLICATION_TARGET: PublicationTargetDraft = {
  scheme: "none",
  tier: "",
  schemeYear: "",
  journalMode: "none",
  targetJournalId: "",
  customJournalName: "",
};

export function draftFromView(view: PublicationTargetView | undefined): PublicationTargetDraft {
  if (view === undefined) return EMPTY_PUBLICATION_TARGET;
  return {
    scheme: view.scheme,
    tier: view.tier ?? "",
    schemeYear: view.schemeYear !== undefined ? String(view.schemeYear) : "",
    journalMode: view.targetJournalId !== undefined ? "verified" : view.customJournalName !== undefined ? "custom" : "none",
    targetJournalId: view.targetJournalId ?? "",
    customJournalName: view.customJournalName ?? "",
  };
}

/** 草稿 → API 输入；未设置任何内容 → null（= 不设置 / 清除）。非法组合由后端最终校验 */
export function draftToInput(draft: PublicationTargetDraft): PublicationTargetInput | null {
  const journal =
    draft.journalMode === "verified" && draft.targetJournalId !== ""
      ? { targetJournalId: draft.targetJournalId }
      : draft.journalMode === "custom" && draft.customJournalName.trim() !== ""
        ? { customJournalName: draft.customJournalName.trim() }
        : {};
  if (draft.scheme === "none") {
    return Object.keys(journal).length > 0 ? { scheme: "none", ...journal } : null;
  }
  const year = draft.schemeYear.trim() === "" ? undefined : Number(draft.schemeYear.trim());
  return {
    scheme: draft.scheme,
    ...(draft.tier !== "" ? { tier: draft.tier } : {}),
    ...(year !== undefined ? { schemeYear: year } : {}),
    ...journal,
  };
}

/** 本地前置校验（与后端规则一致的最小子集；后端仍是最终裁决） */
export function validatePublicationDraft(draft: PublicationTargetDraft): string | null {
  if (draft.scheme !== "none" && draft.tier === "") return "已选择发表体系，请选择层级（或把体系改回「不设置」）";
  if (draft.schemeYear.trim() !== "" && !/^\d{4}$/.test(draft.schemeYear.trim())) return "名单年份应为四位数字（可留空）";
  if (draft.journalMode === "verified" && draft.targetJournalId === "") return "请选择已核验期刊，或改为「不指定」";
  if (draft.journalMode === "custom" && draft.customJournalName.trim().length > 200) return "自填期刊名不能超过 200 个字符";
  return null;
}

export function PublicationTargetFields({
  value,
  onChange,
  idPrefix,
}: {
  value: PublicationTargetDraft;
  onChange: (next: PublicationTargetDraft) => void;
  idPrefix?: string;
}) {
  const autoId = useId();
  const prefix = idPrefix ?? `pt-${autoId.replace(/:/g, "")}`;
  const options = usePublicationTargetOptions();
  const schemes = options.data?.schemes ?? [];
  const journals = options.data?.journals ?? [];
  const scheme = schemes.find((entry) => entry.scheme === value.scheme);
  const set = (patch: Partial<PublicationTargetDraft>) => onChange({ ...value, ...patch });

  return (
    <div className="publication-target-fields" data-testid="publication-target-fields">
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`${prefix}-scheme`}>目标发表体系（可选）</label>
          <select
            id={`${prefix}-scheme`}
            value={value.scheme}
            disabled={options.isLoading}
            onChange={(event) => set({ scheme: event.target.value as PublicationScheme, tier: "", schemeYear: event.target.value === "none" ? "" : value.schemeYear })}
          >
            {schemes.length === 0 ? <option value="none">不设置</option> : null}
            {schemes.map((entry) => (
              <option key={entry.scheme} value={entry.scheme}>
                {entry.scheme === "none" ? "不设置（通用学术审稿）" : entry.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-tier`}>层级</label>
          <select id={`${prefix}-tier`} value={value.tier} disabled={value.scheme === "none"} onChange={(event) => set({ tier: event.target.value })}>
            <option value="">{value.scheme === "none" ? "—" : "请选择"}</option>
            {(scheme?.tiers ?? []).map((tier) => (
              <option key={tier.tier} value={tier.tier}>
                {tier.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-year`}>名单 / 分区年份</label>
          <input
            id={`${prefix}-year`}
            inputMode="numeric"
            value={value.schemeYear}
            disabled={value.scheme === "none"}
            onChange={(event) => set({ schemeYear: event.target.value })}
            placeholder="如：2025（可留空）"
            maxLength={4}
          />
        </div>
      </div>
      {scheme?.note !== undefined ? <span className="field-help">{scheme.note}</span> : null}
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`${prefix}-journal-mode`}>目标期刊（可选）</label>
          <select id={`${prefix}-journal-mode`} value={value.journalMode} onChange={(event) => set({ journalMode: event.target.value as PublicationTargetDraft["journalMode"] })}>
            <option value="none">不指定</option>
            <option value="verified">从已核验期刊资料中选择</option>
            <option value="custom">自填期刊名（资料未核实）</option>
          </select>
        </div>
        {value.journalMode === "verified" ? (
          <div className="field">
            <label htmlFor={`${prefix}-journal`}>已核验期刊</label>
            <select id={`${prefix}-journal`} value={value.targetJournalId} onChange={(event) => set({ targetJournalId: event.target.value })}>
              <option value="">请选择</option>
              {journals.map((journal) => (
                <option key={journal.journalId} value={journal.journalId}>
                  {journal.displayName}
                  {journal.nameEn !== undefined && journal.nameEn !== journal.displayName ? ` · ${journal.nameEn}` : ""}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {value.journalMode === "custom" ? (
          <div className="field">
            <label htmlFor={`${prefix}-custom`}>期刊名</label>
            <input id={`${prefix}-custom`} value={value.customJournalName} onChange={(event) => set({ customJournalName: event.target.value })} placeholder="系统没有该期刊的已核验投稿规则" maxLength={201} />
          </div>
        ) : null}
      </div>
      <span className="field-help" data-testid="publication-target-help">
        发表目标只用来决定审稿关注点与建议排序（例如更重视强基线对照或论证充分性）；所选层级视为你的投稿目标，系统不核实分区事实，
        不预测录用，也不证明稿件达到某分区 / 期刊的学术水平。论文类型仍决定工作流。
      </span>
    </div>
  );
}
