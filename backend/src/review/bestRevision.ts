/**
 * M14.4 P0-4：最佳合法版本（Best Valid Revision）选择——确定性、无 LLM。
 *
 * 背景（真实 R3）：修订循环逐轮劣化（issues 186→544 / academicScore 63→54），
 * 系统没有任何「最佳版本」概念：gate 判定劣化后继续在劣化版本上修订，最终
 * 只能人工从 rev-3（写作完成态）恢复后编译 Draft。RevisionStore 本身已有不可
 * 变快照与 restore（恢复 = 提交新的不可变修订），缺的只是**选择**与**接线**。
 *
 * 选择纪律（任务 §5.1：不要简单地把 academicScore 最高的一轮定义为最佳）：
 * 1. 同一 run 内比较（iterationsForRun 口径——新 run 的首轮不与旧 run 终稿比）；
 * 2. 守卫干净（factViolations + citationViolations = 0）优先于一切分数——
 *    守卫脏的版本是不安全产物（SYSTEM_FAILED 语义），分数再高也不可选；
 * 3. 其次 blocking 更少 → critical 更少（内容质量的主信号）；
 * 4. academicScore 只作末位 tiebreak，且按 10 分带宽取整（band）——跨轮 reviewer
 *    分数存在波动与覆盖口径差异（R2 coverage 83.9%），带内差异不构成「更好」
 *    的可靠证据（INCONCLUSIVE → 保守保留既有最佳，不追噪声）；
 * 5. 全部相等 → 保留既有版本（更早、更少扰动）。
 *
 * 轮次评分不可比（coverage 口径不同 / academicScore 为 null）时：比较只依据
 * 确定性计数（守卫/违规），不依据分数——不假装有可靠的分数改善证据。
 */

import type { IterationRecord, IterationScorecard } from "./revisionOutcome.js";

/** 落盘工件：reviews/best-revision.json（reviewArtifacts 持久化） */
export interface BestRevisionArtifact {
  /** 被选中的 manuscript 修订号（restore 的来源） */
  revision: number;
  gateRound: number;
  runId: string;
  scorecard: IterationScorecard;
  /** 选择依据（确定性描述；审计与 stalled payload 消费） */
  basis: string[];
  updatedAt: string;
}

export interface BestRevisionCandidate {
  revision: number;
  gateRound: number;
  runId: string;
  scorecard: IterationScorecard;
}

const SCORE_BAND = 10;

function guardClean(scorecard: IterationScorecard): boolean {
  return (scorecard.factViolations ?? 0) === 0 && (scorecard.citationViolations ?? 0) === 0;
}

function scoreBand(scorecard: IterationScorecard): number {
  return scorecard.academicScore === null ? -1 : Math.floor(scorecard.academicScore / SCORE_BAND);
}

/**
 * 候选 vs 既有最佳。返回负值 = 候选更差，0 = 不可区分（INCONCLUSIVE，保留既有），
 * 正值 = 候选严格更好。比较键：守卫干净 > blocking > critical > 分数带宽。
 */
export function compareBestRevision(
  candidate: BestRevisionCandidate,
  incumbent: BestRevisionCandidate,
): number {
  const keys: Array<(entry: BestRevisionCandidate) => number> = [
    (entry) => (guardClean(entry.scorecard) ? 1 : 0),
    (entry) => -entry.scorecard.blocking,
    (entry) => -entry.scorecard.critical,
    (entry) => scoreBand(entry.scorecard),
  ];
  for (const key of keys) {
    const delta = key(candidate) - key(incumbent);
    if (delta !== 0) return delta;
  }
  return 0;
}

export interface BestRevisionDecision {
  best: BestRevisionArtifact;
  changed: boolean;
}

/**
 * 质量门后更新最佳版本工件。规则：
 * - 无既有工件（首轮 / 新 run）→ 候选成为最佳（新 run 的第一轮重置基线：
 *   跨 run 分数不可比，沿用 iterationsForRun 的纪律）；
 * - 既有工件属于其它 run → 候选成为最佳（同上；旧 run 的最佳留在 basis 里注明）；
 * - 同 run：仅当候选**严格更好**（compareBestRevision > 0）时替换。
 */
export function selectBestRevision(
  candidate: BestRevisionCandidate,
  incumbent: BestRevisionArtifact | null,
): BestRevisionDecision {
  const replace =
    incumbent === null ||
    incumbent.runId !== candidate.runId ||
    compareBestRevision(candidate, incumbent) > 0;
  const basis: string[] = [];
  if (incumbent !== null && incumbent.runId === candidate.runId) {
    if (replace) {
      basis.push(
        `run 内比较：rev-${candidate.revision}（gateRound ${candidate.gateRound}）严格优于既有最佳 rev-${incumbent.revision}（守卫干净=${guardClean(candidate.scorecard)}，blocking ${incumbent.scorecard.blocking}→${candidate.scorecard.blocking}，critical ${incumbent.scorecard.critical}→${candidate.scorecard.critical}，分数带宽 ${scoreBand(incumbent.scorecard)}→${scoreBand(candidate.scorecard)}）`,
      );
    } else {
      basis.push(
        `run 内比较：rev-${candidate.revision} 未严格优于既有最佳 rev-${incumbent.revision}（分数带内差异不构成替换依据；保守保留）`,
      );
    }
  } else if (incumbent !== null) {
    basis.push(`新 run（${candidate.runId}）首轮评估成为本 run 基线；旧 run 最佳 rev-${incumbent.revision} 留档不再作为恢复目标`);
  } else {
    basis.push(`首次评估：rev-${candidate.revision}（gateRound ${candidate.gateRound}）成为本 run（${candidate.runId}）的最佳合法版本基线`);
  }
  return {
    changed: replace,
    best: replace
      ? {
          revision: candidate.revision,
          gateRound: candidate.gateRound,
          runId: candidate.runId,
          scorecard: candidate.scorecard,
          basis,
          updatedAt: new Date().toISOString(),
        }
      : { ...incumbent!, basis: [...incumbent!.basis, ...basis].slice(-5), updatedAt: incumbent!.updatedAt },
  };
}

/**
 * 终局是否应从最佳版本恢复（任务 §5.2：仅当当前**可证明更差**）。
 * 口径：当前在守卫干净 / blocking / critical 任一主键上劣于最佳，且没有任何
 * 主键更好 → 恢复；否则（含不可区分）保留当前稿——保守，不追噪声。
 */
export function shouldRestoreBest(
  current: IterationScorecard,
  best: BestRevisionArtifact,
): { restore: boolean; reasons: string[] } {
  const incumbent: BestRevisionCandidate = {
    revision: best.revision,
    gateRound: best.gateRound,
    runId: best.runId,
    scorecard: best.scorecard,
  };
  const verdict = compareBestRevision(
    { revision: -1, gateRound: -1, runId: best.runId, scorecard: current },
    incumbent,
  );
  if (verdict >= 0) {
    return { restore: false, reasons: [`当前稿不劣于最佳合法版本 rev-${best.revision}（比较键：守卫/blocking/critical/分数带宽）——保留当前稿`] };
  }
  return {
    restore: true,
    reasons: [
      `当前稿可证明劣于最佳合法版本 rev-${best.revision}：守卫干净 ${guardClean(current) ? "是" : "否"} vs ${guardClean(best.scorecard) ? "是" : "否"}，blocking ${current.blocking} vs ${best.scorecard.blocking}，critical ${current.critical} vs ${best.scorecard.critical}（分数带宽仅作末位 tiebreak，不单独触发恢复）`,
    ],
  };
}

/** 从本 run 的 iteration 记录取「当前终局记分卡」（最后一条未通过记录） */
export function terminalScorecardForRun(
  iterations: readonly IterationRecord[],
  runId: string,
): IterationScorecard | null {
  const own = iterations.filter((record) => record.runId === runId);
  for (let index = own.length - 1; index >= 0; index -= 1) {
    const record = own[index]!;
    if (!record.scorecard.gatePassed) return record.scorecard;
  }
  return own.at(-1)?.scorecard ?? null;
}
