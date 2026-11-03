import { useEffect, useState } from "react";

import { useProjectRuns, usePublicationTargetOptions, useUpdatePublicationTarget } from "../../hooks/queries.js";
import type { ProjectView, PublicationTargetView, ReviewPolicySnapshotView } from "../../types/api.js";
import { formatApiError } from "../../utils/errors.js";
import {
  draftFromView,
  draftToInput,
  PublicationTargetFields,
  validatePublicationDraft,
  type PublicationTargetDraft,
} from "./PublicationTargetFields.js";

const ARTICLE_TYPE_LABEL: Record<string, string> = { research: "研究论文", survey: "综述论文", thesis: "学位论文" };

const CAS_NUMERALS = ["", "一", "二", "三", "四"];

/** 层级展示名（与后端 PUBLICATION_TIER_LABELS 同口径） */
function tierText(target: Pick<PublicationTargetView, "scheme" | "tier">): string | null {
  if (target.scheme === "none" || target.tier === undefined) return null;
  if (target.scheme === "cas") return `中科院${CAS_NUMERALS[Number(target.tier)] ?? target.tier}区`;
  if (target.scheme === "jcr") return `JCR ${target.tier}`;
  return target.tier === "PKU_CORE" ? "北大核心" : target.tier;
}

/** 项目设置中的发表目标展示文案（全部基于后端字段；未核实如实标注） */
export function publicationTargetText(project: ProjectView, journalName: (id: string) => string | undefined): string | null {
  const target = project.publicationTarget;
  if (target === undefined) return null;
  const parts: string[] = [];
  const tier = tierText(target);
  if (tier !== null) parts.push(`${tier}${target.schemeYear !== undefined ? `（${target.schemeYear} 年名单）` : ""}`);
  if (target.targetJournalId !== undefined) parts.push(journalName(target.targetJournalId) ?? target.targetJournalId);
  if (target.customJournalName !== undefined) parts.push(`${target.customJournalName}（资料未核实）`);
  return parts.join(" · ");
}

function frozenPolicyText(policy: ReviewPolicySnapshotView): string {
  const tier = policy.target !== null ? tierText(policy.target) : null;
  const journal = policy.targetJournal?.displayName ?? policy.target?.customJournalName ?? null;
  const target = [tier, journal].filter((part): part is string => part !== null).join(" · ");
  return `${ARTICLE_TYPE_LABEL[policy.articleType] ?? policy.articleType} · ${target === "" ? "未设置发表目标" : target} · ${policy.policyVersion}`;
}

/**
 * 研究定位卡内的「发表目标」区块：当前设置 + 层级事实状态 + 最近一次运行冻结的政策；
 * 修改只影响之后新建的运行（已完成 / 进行中的审稿与报告不追溯改变）。
 */
export function PublicationTargetCard({ project }: { project: ProjectView }) {
  const options = usePublicationTargetOptions();
  const runs = useProjectRuns(project.id);
  const update = useUpdatePublicationTarget(project.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<PublicationTargetDraft>(draftFromView(project.publicationTarget));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!editing) setDraft(draftFromView(project.publicationTarget));
  }, [editing, project.publicationTarget]);

  const journalName = (id: string) => options.data?.journals.find((journal) => journal.journalId === id)?.displayName;
  const text = publicationTargetText(project, journalName);
  const latestPolicy = (runs.data ?? []).find((run) => run.reviewPolicy != null)?.reviewPolicy ?? null;
  const tierUnverified = project.publicationTarget !== undefined && project.publicationTarget.scheme !== "none";

  const onSave = () => {
    const problem = validatePublicationDraft(draft);
    setError(problem);
    if (problem !== null) return;
    update.mutate(draftToInput(draft), { onSuccess: () => setEditing(false) });
  };

  return (
    <div className="idea-block" data-testid="publication-target-card">
      <h3>发表目标</h3>
      {!editing ? (
        <>
          <p className="reading" data-testid="publication-target-current">
            {text ?? "未设置（使用通用学术审稿策略）"}
          </p>
          {tierUnverified ? (
            <p className="field-help" data-testid="publication-target-unverified">
              所选层级是你的投稿目标，系统未核实任何期刊的分区 / 收录事实；它只用于决定审稿关注点。
            </p>
          ) : null}
          {latestPolicy !== null ? (
            <p className="field-help" data-testid="publication-target-frozen">
              最近一次运行冻结的审稿政策：{frozenPolicyText(latestPolicy)}（{new Date(latestPolicy.frozenAt).toLocaleString()}）
            </p>
          ) : null}
          <button type="button" className="btn" onClick={() => setEditing(true)} data-testid="publication-target-edit">
            {text === null ? "设置发表目标" : "修改发表目标"}
          </button>
        </>
      ) : (
        <>
          <PublicationTargetFields value={draft} onChange={setDraft} idPrefix="project-pt" />
          <p className="note note-info" style={{ marginTop: "var(--s-3)" }}>
            <span>新设置只影响下一次审稿 / 修订运行；不会改变已完成的报告，也不会改变正在进行的运行。</span>
          </p>
          {error !== null ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          {update.isError ? (
            <p className="form-error" role="alert" data-testid="publication-target-error">
              {formatApiError(update.error)}
            </p>
          ) : null}
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => { setEditing(false); setError(null); update.reset(); }}>
              取消
            </button>
            <button type="button" className="btn btn-primary" onClick={onSave} disabled={update.isPending} data-testid="publication-target-save">
              {update.isPending ? "保存中…" : "保存"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
