/**
 * SurveyOutlineService：Structured Synthesis → Survey Outline 构建编排（M11.1.3）。
 *
 * 链路（零新 Runtime 角色；Writer 的 writing/outline 会话，survey 模式 prompt）：
 *   Matrix + Synthesis（artifact）
 *   → staleness 检查（synthesis.matrixFingerprint ≠ 当前 Matrix → 先重建 synthesis）
 *   → buildSurveyOutlineDigest（纯函数投影：七类 items + 文献清单 + 覆盖统计；
 *     不塞完整 chunk / EvidenceRecord / PDF——Outline 只需要研究综合结果）
 *   → WriterService.planOutline（surveyDigest 分支；结构化输出内部有界修复）
 *   → validateSurveyOutline（确定性契约：blocking / warnings 分离）
 *   → blocking 非空 → 校验错误作为 feedback 重规划（≤1 次；仍失败如实抛
 *     SURVEY_OUTLINE_INVALID，不落盘——fail-closed，绝不伪造默认结构）
 *   → 通过 → ManuscriptService.saveOutline（refs 归一：去重 + 升序）
 *
 * 持久化：Survey Outline 本质仍是 Manuscript Outline（manuscript/outline.json，
 * section 携带可选 synthesisRefs / literatureRefs）——复用既有 outline HITL /
 * persistence / resume 链，不建平行 survey-outline.json。Outline 只存 refs：
 * taxonomy 标签 / synthesis claim 不复制（refs → Synthesis / Matrix 追溯），
 * Matrix HITL 修正 → Synthesis rebuild → Outline rebuild 链可正常发生。
 */

import { BusinessError } from "../errors.js";
import type { ManuscriptService } from "../manuscript/ManuscriptService.js";
import type { Outline } from "../manuscript/ManuscriptService.js";
import { normalizeManuscriptLanguage } from "../project/language.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { SourceStore } from "../sources/SourceStore.js";
import type { WriterService } from "../writer/WriterService.js";
import { fingerprintJson } from "../util/hash.js";
import { SurveyMatrixArtifactStore, SurveySynthesisArtifactStore } from "./surveyArtifacts.js";
import { buildSurveyOutlineDigest } from "./outlineDigest.js";
import {
  validateSurveyOutline,
  type SurveyOutlineValidation,
} from "./outlineValidation.js";

/** survey 语义校验失败后的重规划上限（首次规划 + 1 次错误反馈重规划） */
export const SURVEY_OUTLINE_REPLAN_MAX_ATTEMPTS = 2;

export interface SurveyOutlineBuildInput {
  /** HITL 修订意见（用户对上一版 Survey Outline 的要求；与校验错误反馈叠加） */
  feedback?: string;
}

export interface SurveyOutlineBuildResult {
  outline: Outline;
  validation: SurveyOutlineValidation;
  summary: {
    matrixEntries: number;
    synthesisItems: number;
    sections: number;
    /** planner 规划次数（含校验失败后的重规划；不含 Writer 内部结构修复） */
    planningAttempts: number;
    /** Writer 结构化输出内部修复诊断（M9.7.6 口径；未触发不携带） */
    repair?: { attempts: number; errors: string[] };
  };
}

export interface SurveyOutlineServiceOptions {
  projects: ProjectStore;
  sources: SourceStore;
  writer: WriterService;
  manuscript: ManuscriptService;
  log?: (message: string) => void;
}

export class SurveyOutlineService {
  private readonly projects: ProjectStore;
  private readonly sources: SourceStore;
  private readonly writer: WriterService;
  private readonly manuscript: ManuscriptService;
  private readonly matrixStore: SurveyMatrixArtifactStore;
  private readonly synthesisStore: SurveySynthesisArtifactStore;
  private readonly log: (message: string) => void;

  constructor(options: SurveyOutlineServiceOptions) {
    this.projects = options.projects;
    this.sources = options.sources;
    this.writer = options.writer;
    this.manuscript = options.manuscript;
    this.matrixStore = new SurveyMatrixArtifactStore(options.projects);
    this.synthesisStore = new SurveySynthesisArtifactStore(options.projects);
    this.log = options.log ?? (() => {});
  }

  /**
   * M11.2：确定性新鲜度复用——已落盘的 outline.json 在「synthesis 指纹一致 +
   * survey 契约校验无 blocking」时可直接复用（重跑 / 续跑不重烧规划 Token；
   * HITL revise 携带 feedback 的路径不走这里，仍强制重规划）。
   * 返回 null = 不可复用（无 outline / 指纹过期 / 契约违约），调用方走规划。
   */
  async reuseFreshOutline(
    projectId: string,
    input: { yearBySource?: Map<string, number> } = {},
  ): Promise<Outline | null> {
    const outline = await this.manuscript.loadOutline(projectId);
    if (outline === null) {
      return null;
    }
    // 无任何 refs 的 outline 不是 survey 产物（普通论文 / 遗留项目）——不复用
    const hasRefs = outline.sections.some(
      (section) =>
        (section.synthesisRefs ?? []).length > 0 || (section.literatureRefs ?? []).length > 0,
    );
    if (!hasRefs) {
      return null;
    }
    const matrix = await this.matrixStore.read(projectId);
    const synthesis = await this.synthesisStore.read(projectId);
    if (matrix === null || synthesis === null) {
      return null;
    }
    if (synthesis.matrixFingerprint !== fingerprintJson(matrix)) {
      return null; // Matrix 已变化（HITL 修正后）：outline 过期，须重规划
    }
    const sourceItems = await this.sources.list(projectId);
    const yearBySource =
      input.yearBySource ??
      new Map(
        sourceItems
          .filter((item) => item.metadata.year !== undefined)
          .map((item) => [item.sourceId, item.metadata.year as number]),
      );
    const validation = validateSurveyOutline(outline, { matrix, synthesis, yearBySource });
    if (validation.blocking.length > 0) {
      return null;
    }
    return outline;
  }

  async buildSurveyOutline(
    projectId: string,
    input: SurveyOutlineBuildInput = {},
  ): Promise<SurveyOutlineBuildResult> {
    const project = await this.projects.getRequired(projectId);
    const language = normalizeManuscriptLanguage(project.language);

    const matrix = await this.matrixStore.read(projectId);
    if (matrix === null) {
      throw new BusinessError(
        "INVALID_REQUEST",
        "项目还没有 Survey Matrix（research/survey.json 不存在），请先执行 POST /survey/matrix/build",
      );
    }
    const synthesis = await this.synthesisStore.read(projectId);
    if (synthesis === null) {
      throw new BusinessError(
        "INVALID_REQUEST",
        "项目还没有 Structured Synthesis（research/survey-synthesis.json 不存在），请先执行 POST /survey/synthesis/build",
      );
    }
    const matrixFingerprint = fingerprintJson(matrix);
    if (synthesis.matrixFingerprint !== matrixFingerprint) {
      throw new BusinessError(
        "INVALID_REQUEST",
        "Survey Synthesis 相对当前 Matrix 已过期（matrix 指纹不一致，Synthesis 构建后 Matrix 已变化）："
          + "请先重建 synthesis（POST /survey/synthesis/build）再规划 Survey Outline",
      );
    }
    if (matrix.entries.length === 0) {
      throw new BusinessError("INVALID_REQUEST", "Survey Matrix 是空的（0 条文献），没有可组织的综述结构");
    }

    const sourceItems = await this.sources.list(projectId);
    const yearBySource = new Map(
      sourceItems
        .filter((item) => item.metadata.year !== undefined)
        .map((item) => [item.sourceId, item.metadata.year as number]),
    );
    const titleBySource = new Map(
      sourceItems
        .filter((item) => item.metadata.title !== undefined && item.metadata.title.trim() !== "")
        .map((item) => [item.sourceId, item.metadata.title!.trim()]),
    );

    const digest = buildSurveyOutlineDigest(matrix, synthesis, {
      topic: project.title,
      yearBySource,
      titleBySource,
    });

    const validationErrors: string[] = [];
    let planningAttempts = 0;
    let feedback: string | undefined = input.feedback;
    for (let attempt = 1; attempt <= SURVEY_OUTLINE_REPLAN_MAX_ATTEMPTS; attempt += 1) {
      const outline = await this.writer.planOutline({
        projectId,
        evidence: [],
        bibliography: [],
        targetProfile: project.targetProfile,
        documentType: project.documentType,
        ...(language !== undefined ? { language } : {}),
        ...(feedback !== undefined && feedback.trim() !== "" ? { feedback: feedback.trim() } : {}),
        surveyDigest: digest,
      });
      planningAttempts += 1;
      const validation = validateSurveyOutline(outline, { matrix, synthesis, yearBySource });
      if (validation.blocking.length === 0) {
        const saved = await this.manuscript.saveOutline(projectId, outline);
        this.log(
          `[survey] projectId=${projectId} outline 完成：${saved.sections.length} 节`
          + `（synthesis 覆盖 ${(validation.summary.synthesisCoverage * 100).toFixed(0)}% /`
          + ` literature 覆盖 ${(validation.summary.literatureCoverage * 100).toFixed(0)}%；`
          + `warnings ${validation.warnings.length}）`,
        );
        return {
          outline: saved,
          validation,
          summary: {
            matrixEntries: matrix.entries.length,
            synthesisItems: synthesis.items.length,
            sections: saved.sections.length,
            planningAttempts,
            ...(outline.repair !== undefined ? { repair: outline.repair } : {}),
          },
        };
      }
      validationErrors.push(...validation.blocking);
      this.log(
        `[survey] projectId=${projectId} 第 ${attempt} 次 Survey Outline 规划未过契约校验（${validation.blocking.length} 项 blocking）：${validation.blocking.join("；").slice(0, 300)}`,
      );
      if (attempt < SURVEY_OUTLINE_REPLAN_MAX_ATTEMPTS) {
        feedback = [
          input.feedback?.trim() ?? "",
          "上一版大纲未通过 Survey 契约校验，必须逐条修复后重新输出完整大纲：",
          ...validation.blocking.map((error) => `- ${error}`),
        ]
          .filter((line) => line !== "")
          .join("\n");
      }
    }
    throw new BusinessError(
      "SURVEY_OUTLINE_INVALID",
      `Survey Outline 连续 ${planningAttempts} 次规划均未通过契约校验（fail-closed，未落盘）：${validationErrors.join("；")}`,
    );
  }
}
