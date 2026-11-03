/**
 * M16 工程收口 B：review.run 长文档单元模式的调用预算准入（有上限时才生效；无上限 = 恒放行，行为零变化）。
 *
 * 背景（M16 留出集真实运行）：两篇英文稿单元输出被解析成碎片 → claims 缺失 → 9 / 7 次论断修复调用，
 * 21 次单 run 上限被耗尽，跨章一致性与整稿综合审查在 stage 末尾被账本拒绝——要求执行的整稿阶段被
 * 「可选」的修复调用无意挤占。
 *
 * 优先级（高 → 低）：单元首次审稿 > 单元重试（正文覆盖）> 跨章 / 整稿（各 1 次）> 单元论断修复（补充账本）。
 * - 单元重试只为「尚未开始首审的单元」让路：正文覆盖是 L0 核心，不能为整稿牺牲；
 * - 论断修复同时为未开始单元与待执行的跨章 / 整稿预留额度；被拒绝时如实记 repairSkippedReason，账本保持 ABSENT / INVALID；
 * - 预留只是准入判断，不改变 Runtime 硬上限；整稿 / 跨章本身若仍被拒绝，按 skipped（BUDGET_EXHAUSTED）如实记录。
 */

/** PAPERTEAM_REVIEW_STAGE_CALL_RESERVE：on（缺省）= 按上述优先级预留；off = 旧行为（先到先得） */
export type ReviewStageCallReservePolicy = "on" | "off";

export type OptionalReviewCallKind = "unit_retry" | "claims_repair";

export const BUDGET_RESERVED_REASON = "BUDGET_RESERVED_FOR_REQUIRED_STAGES" as const;

/** 单元模式调用账（观测；coverage.callAccounting 落盘供维护对账——不是 Runtime 账本的替代） */
export interface ReviewCallAccounting {
  policy: ReviewStageCallReservePolicy;
  /** 准入判断时可见的剩余调用上限（undefined = 无上限） */
  limitedBy?: "run_or_task_budget";
  unitPrimaryCalls: number;
  unitRetryCalls: number;
  claimRepairCalls: number;
  unitRetriesSkipped: number;
  claimRepairsSkipped: number;
  crossChapterCalls: number;
  wholePaperCalls: number;
}

export interface ReviewCallBudget {
  /** 单元首审即将开始（同步计数：并发调度下在 await 之前调用） */
  notePrimaryStart(): void;
  /** 可选调用准入；false = 为更高优先级的阶段预留 */
  admit(kind: OptionalReviewCallKind): boolean;
  accounting: ReviewCallAccounting;
}

export function createReviewCallBudget(params: {
  policy: ReviewStageCallReservePolicy;
  totalUnits: number;
  /** 后续必需阶段（跨章 + 整稿）的调用数 */
  stageReserve: number;
  /** 当前剩余可启动调用数（run 级与任务级取小；undefined = 无上限） */
  remainingCalls: () => number | undefined;
}): ReviewCallBudget {
  let primaryStarted = 0;
  const accounting: ReviewCallAccounting = {
    policy: params.policy,
    unitPrimaryCalls: 0, unitRetryCalls: 0, claimRepairCalls: 0,
    unitRetriesSkipped: 0, claimRepairsSkipped: 0, crossChapterCalls: 0, wholePaperCalls: 0,
  };
  return {
    accounting,
    notePrimaryStart() {
      primaryStarted += 1;
    },
    admit(kind) {
      const remaining = params.remainingCalls();
      if (remaining !== undefined) accounting.limitedBy = "run_or_task_budget";
      if (params.policy === "off" || remaining === undefined) return true;
      // 尚未开始首审的单元（缓存单元不花调用，此处按需花计——保守预留）
      const pendingPrimary = Math.max(0, params.totalUnits - primaryStarted);
      const reserve = pendingPrimary + (kind === "claims_repair" ? params.stageReserve : 0);
      const admitted = remaining - reserve >= 1;
      if (!admitted) {
        if (kind === "unit_retry") accounting.unitRetriesSkipped += 1;
        else accounting.claimRepairsSkipped += 1;
      }
      return admitted;
    },
  };
}
