/**
 * 研究材料缺口面板（thesis_from_papers 专属；挂在研究材料面板的冲突区块之后）。
 *
 * 展示 Planner 确认章节映射并完成证据供给后生成的「材料缺口账本」，
 * 并提供作者快捷决定（补充材料 / 作为研究限制 / 暂缓该章 / 确认为缺口 / 排除建议）。
 *
 * 边界：缺口只有作者决定后才会影响写作；系统不会为缺失材料生成任何实验数值。
 * 模型 / Planner 提出的缺口只是建议，是否成立由作者裁定。
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ErrorState } from "../common/StateViews.js";
import {
  getMissingMaterialLedger,
  submitMissingMaterialDecision,
  type MissingMaterialDecision,
  type MissingMaterialGap,
  type MissingMaterialGapStatus,
  type MissingMaterialGapType,
} from "../../api/thesisMissingMaterials.js";
import { formatApiError } from "../../utils/errors.js";
import {
  GAP_TYPE_LABELS,
  MATERIAL_KIND_LABELS,
  MISSING_MATERIAL_BOUNDARY_NOTE,
  ORIGIN_LABELS,
  STALE_LABEL,
  STATUS_BADGE_CLASS,
  STATUS_LABELS,
} from "./missingMaterialLabels.js";

const DECISION_LABELS: Record<MissingMaterialDecision, string> = {
  confirm_missing: "确认为缺口",
  supply_experiment_data: "补充实验数据",
  supply_research_record: "补充研究记录",
  supply_manuscript: "补充研究手稿",
  write_as_limitation: "作为研究限制说明",
  defer_chapter: "暂缓该章",
  reject: "排除该建议",
};

/** 「下一步作者操作」按 gapType 给出的动作集合 */
const DECISIONS_BY_GAP_TYPE: Record<MissingMaterialGapType, MissingMaterialDecision[]> = {
  planned_chapter_material: [
    "supply_experiment_data",
    "supply_research_record",
    "supply_manuscript",
    "write_as_limitation",
    "defer_chapter",
  ],
  proposed_scope_gap: ["confirm_missing", "reject", "supply_manuscript"],
};

const TERMINAL_STATUSES: ReadonlySet<MissingMaterialGapStatus> = new Set(["resolved", "rejected"]);

const RATIONALE = "面板快捷决定";

export function MissingMaterialPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["thesis-missing-materials", projectId] as const;
  const ledger = useQuery({
    queryKey,
    queryFn: () => getMissingMaterialLedger(projectId),
    enabled: projectId !== "",
  });
  const decide = useMutation({
    mutationFn: (input: { gapId: string; decision: MissingMaterialDecision }) =>
      submitMissingMaterialDecision(projectId, input.gapId, input.decision, RATIONALE),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const onDecide = async (gap: MissingMaterialGap, decision: MissingMaterialDecision) => {
    setError(null);
    setNotice(null);
    try {
      await decide.mutateAsync({ gapId: gap.gapId, decision });
      setNotice(`已记录作者决定：${DECISION_LABELS[decision]}（${gap.title}）`);
    } catch (mutationError) {
      setError(formatApiError(mutationError));
    }
  };

  const gaps = ledger.data?.gaps ?? [];

  return (
    <div className="research-inputs-missing-materials" data-testid="missing-material-panel">
      <h3>研究材料缺口（{gaps.length}）</h3>
      <p className="panel-note">{MISSING_MATERIAL_BOUNDARY_NOTE}</p>

      {ledger.isLoading ? <p className="panel-note">加载中…</p> : null}
      {ledger.isError ? <ErrorState>{formatApiError(ledger.error)}</ErrorState> : null}
      {error !== null ? <ErrorState>{error}</ErrorState> : null}
      {notice !== null ? <p className="panel-note" role="status">{notice}</p> : null}

      {!ledger.isLoading && !ledger.isError && gaps.length === 0 ? (
        <p className="panel-note">尚无材料缺口记录（Planner 确认章节映射并完成证据供给后生成）</p>
      ) : null}

      {gaps.length > 0 ? (
        <ul>
          {gaps.map((gap) => {
            const stale = gap.stale !== undefined;
            const disabled = decide.isPending || (TERMINAL_STATUSES.has(gap.status) && !stale);
            return (
              <li key={gap.gapId} data-testid={`missing-material-gap-${gap.gapId}`}>
                <div className="research-input-head">
                  <strong>{gap.title}</strong>
                  <span className="badge">{GAP_TYPE_LABELS[gap.gapType]}</span>
                  <span className="badge">{ORIGIN_LABELS[gap.origin]}</span>
                  <span className={`badge ${STATUS_BADGE_CLASS[gap.status] ?? ""}`.trim()}>
                    {STATUS_LABELS[gap.status]}
                  </span>
                  {stale ? <span className="badge badge-warn">{STALE_LABEL}</span> : null}
                </div>
                <div className="research-input-meta">
                  <span>对应章节：{gap.chapterTitleZh ?? "—"}</span>
                  <span>{gap.canWriteWithoutMaterial ? "可先以理论/限制口径撰写" : "须等待真实材料"}</span>
                </div>
                <p className="panel-note">原因：{gap.whyInsufficient}</p>
                {gap.requiredMaterials.length > 0 ? (
                  <ul className="conflict-parties">
                    {gap.requiredMaterials.map((material, index) => (
                      <li key={`${gap.gapId}-${index}`}>
                        <span className="badge">{MATERIAL_KIND_LABELS[material.kind]}</span>
                        <span>{material.description}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {gap.decisionRationale !== undefined && gap.decision !== undefined ? (
                  <p className="panel-note">作者决定：{DECISION_LABELS[gap.decision]} — {gap.decisionRationale}</p>
                ) : null}
                <div className="research-input-ops">
                  <span>下一步作者操作：</span>
                  {DECISIONS_BY_GAP_TYPE[gap.gapType].map((decision) => (
                    <button
                      key={decision}
                      type="button"
                      className="text-button"
                      disabled={disabled}
                      onClick={() => void onDecide(gap, decision)}
                    >
                      {DECISION_LABELS[decision]}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
