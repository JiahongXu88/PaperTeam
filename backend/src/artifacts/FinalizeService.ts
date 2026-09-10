/**
 * FinalizeService（M4.7）—— 标记 Final 的唯一合法入口（纯确定性，零 LLM）。
 *
 * Final = Build Gate 通过 + Quality Gate 通过，且两者都对齐「当前 manuscript 修订」：
 *   1. 最新 Quality Gate 产物存在且 passed
 *   2. gate 的 reviewedRevision === 当前修订（Revision 3 的 gate + Revision 4 的编辑 → 拒绝）
 *   3. gate 轮次 === 最新 review 轮次（gate 落后于新 review → 拒绝）
 *   4. Build Gate 记录存在且 passed，revision === 当前修订
 *   5. 冻结 build/paper.pdf → artifacts/（Final 与 Draft 一并落盘）
 *
 * 「有进行中 run 时 finalize」的互斥由调用方（HTTP 层）用 orchestrator.hasActiveRun
 * 前置校验；workflow 的 build.final stage 本身就是活跃 run，跳过该校验。
 */

import {
  BusinessError,
  BuildGateFailedError,
  BuildGateStaleError,
  QualityGateFailedError,
  QualityGateStaleError,
} from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { ReviewArtifactStore } from "../review/reviewArtifacts.js";
import type { ManuscriptRevisionStore } from "../manuscript/RevisionStore.js";
import { loadBuildGateRecord } from "../quality/gates.js";
import type { PaperArtifact } from "./ArtifactStore.js";
import type { PaperArtifactStore } from "./ArtifactStore.js";

export interface FinalizeResult {
  final: PaperArtifact;
  draft: PaperArtifact;
  revision: number;
  gateRound: number;
}

export interface FinalizeServiceOptions {
  projects: ProjectStore;
  reviewArtifacts: ReviewArtifactStore;
  artifacts: PaperArtifactStore;
  revisions: ManuscriptRevisionStore;
}

export class FinalizeService {
  private readonly projects: ProjectStore;
  private readonly reviewArtifacts: ReviewArtifactStore;
  private readonly artifacts: PaperArtifactStore;
  private readonly revisions: ManuscriptRevisionStore;

  constructor(options: FinalizeServiceOptions) {
    this.projects = options.projects;
    this.reviewArtifacts = options.reviewArtifacts;
    this.artifacts = options.artifacts;
    this.revisions = options.revisions;
  }

  async finalize(projectId: string, runId?: string): Promise<FinalizeResult> {
    const revision = await this.revisions.currentRevision(projectId);
    if (revision === 0) {
      throw new BusinessError("INVALID_REQUEST", "项目尚无 manuscript 修订（先完成写作 / 导入）");
    }

    // ---- Quality Gate：最新一轮，且必须对齐当前修订 ----
    const gateRounds = await this.reviewArtifacts.gateRounds(projectId);
    const latestGateRound = gateRounds[0];
    if (latestGateRound === undefined) {
      throw new BusinessError("QUALITY_GATE_FAILED", "项目还没有 Quality Gate 结果（先完成审稿与门禁评估）");
    }
    const gateArtifact = await this.reviewArtifacts.loadGate(projectId, latestGateRound);
    if (gateArtifact === null) {
      throw new BusinessError("QUALITY_GATE_FAILED", `第 ${latestGateRound} 轮 Quality Gate 产物不可读`);
    }
    if (!gateArtifact.gate.passed) {
      throw new QualityGateFailedError(gateArtifact.gate.reasons);
    }
    const reviewedRevision = gateArtifact.reviewedRevision;
    if (reviewedRevision === undefined) {
      throw new QualityGateStaleError(
        `第 ${latestGateRound} 轮 gate 产物缺少修订对齐信息（旧版本产物；重新运行审稿与门禁后重试）`,
      );
    }
    if (reviewedRevision !== revision) {
      throw new QualityGateStaleError(
        `gate 评估的是 revision ${reviewedRevision}，当前 manuscript 已是 revision ${revision}` +
          "（修订后必须重新审稿）",
      );
    }
    // gate 落后于更新的 review 轮次 → 过期（新审稿可能已改变结论）
    const latestSummary = await this.reviewArtifacts.latestSummary(projectId);
    if (latestSummary !== null && latestSummary.round !== latestGateRound) {
      throw new QualityGateStaleError(
        `gate 轮次（r${latestGateRound}）落后于最新审稿轮次（r${latestSummary.round}）`,
      );
    }

    // ---- Build Gate：记录存在、通过、revision 对齐 ----
    const build = await loadBuildGateRecord(this.projects, projectId);
    if (build === null) {
      throw new BuildGateFailedError("项目还没有构建记录（先执行构建）");
    }
    if (!build.passed) {
      throw new BuildGateFailedError(
        `最近一次构建未通过（${build.reasons[0] ?? "编译失败"}；修复后重新构建）`,
      );
    }
    if (build.revision !== revision) {
      throw new BuildGateStaleError(
        `构建记录对应 revision ${build.revision}，当前 manuscript 已是 revision ${revision}（重新构建）`,
      );
    }

    // ---- 冻结（幂等） ----
    const { final, draft } = await this.artifacts.createFinal(
      projectId,
      revision,
      {
        build,
        gate: {
          passed: gateArtifact.gate.passed,
          round: latestGateRound,
          checkedAt: gateArtifact.gate.checkedAt,
          reviewedRevision,
        },
      },
      runId,
    );
    return { final, draft, revision, gateRound: latestGateRound };
  }
}
