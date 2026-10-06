/**
 * Writer Agent：整篇写作 + 分节写作 / 修订。
 *
 * - write：M2 完整文档形态（legacy generate API 使用）
 * - planOutline：基于调研与 Evidence 产出结构化大纲（JSON，经确定性校验）
 * - writeSection：逐节写作（LaTeX 片段，禁止 \documentclass / \begin{document}）
 *
 * 输出校验失败抛业务错误（Agent 返回文本 ≠ 成功）。
 */

import { readFile } from "node:fs/promises";

import { AgentRunFailedError, BusinessError, InvalidLatexOutputError } from "../errors.js";
import type { AgentRuntime, AgentTask } from "../runtime/types.js";
import type { ManuscriptLanguage } from "../project/language.js";
import { targetLanguageLines } from "../project/language.js";
import type { BibliographyEntryInput } from "../agents/ResearcherService.js";
import type { EvidenceRecord } from "../evidence/EvidenceStore.js";
import { resolveEvidenceCitationKey } from "../citation/bibliography.js";
import type { ReviewIssue } from "../agents/ReviewerService.js";
import { buildPlannerAliases, resolvePlannerRefs } from "../review/plannerAliases.js";
import type { ClaimRepairDirective } from "../review/claimGrounding.js";
import type { RevisionPlanItem } from "../review/revisionPlan.js";
import {
  EXTERNAL_OUTCOMES_MARKER,
  type ExternalDirectiveDispatch,
  type ExternalOutcomeKind,
  type ExternalOutcomeReport,
} from "../review/externalInstructions.js";
import { extractCitationKeys, protectedInventory } from "../review/styleInvariants.js";
import type { Outline, OutlineSection } from "../manuscript/ManuscriptService.js";
import { validateOutline } from "../manuscript/ManuscriptService.js";
import { extractJsonObject } from "../agents/outputParsing.js";
import type { SurveyOutlineDigest } from "../survey/outlineDigest.js";
import {
  renderDigestItems,
  renderDigestLiterature,
  renderDigestStats,
} from "../survey/outlineDigest.js";
import type { SurveySectionWritingContext } from "../survey/sectionContext.js";
import {
  renderSectionLiteratureLines,
  renderSectionSynthesisLines,
} from "../survey/sectionContext.js";

export interface WriterServiceOptions {
  runtime: AgentRuntime;
  /** Writer 对应的 Runtime 会话标识（sessionKey 组成段） */
  agentId: string;
  /**
   * 逐 run 执行超时覆盖（毫秒；长论文阶段口径，见 config.pi.longRunTimeoutMs）。
   * 缺省不覆盖：沿用 Runtime 通用默认（300s），不改 Runtime 全局超时契约。
   */
  runTimeoutMs?: number;
  /** 诊断日志 */
  log?: (message: string) => void;
}

export interface WriterResult {
  task: AgentTask;
  /** 校验后的 LaTeX 文档全文 */
  latex: string;
}

/** Markdown 代码围栏（模型偶尔会无视指令包裹输出，做防御性剥离） */
const FENCE_PATTERN = /^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/;

/**
 * M6.6 Evidence 消费模式（§M6.6-6 兼容迁移）：
 * - 下方注入的 digest 只含正式证据（verified + chunk 锚点；由
 *   EvidenceSelectionService.selectForWriting 保证），legacy unverified 不再进入；
 * - digest 只是初始上下文（限量快照）：需要更多证据时 Agent 通过
 *   evidence_query 工具（writer 视图，formalOnly）按 claim 关键词 / sourceId /
 *   章节主动查询——不再依赖 workflow 预先塞入的静态全量。
 */
const EVIDENCE_QUERY_GUIDANCE = [
  "证据查询工具（evidence_query）：当上方 Evidence 不足以支撑本节某个论断时，",
  "可用 evidence_query 按 claim 关键词（claimContains）/ sourceId / section 查询证据库，",
  "获取更多已核验证据（verified）及其 chunk 锚点；查询无果时弱化或删除该论断，不得虚构。",
].join("");

/**
 * 渲染 Evidence digest 行（M6.6 §12 Citation Integration；M9.5 确定性 key；
 * M9.7.6 Claim Discipline 补 source identity）：
 * EvidenceRecord → resolveEvidenceCitationKey（sourceId 精确 → DOI/标题降级）
 * → 引用时使用系统按文献身份确定性生成的 key（LLM 不自造 key）。
 * 行格式：- [E001]（cite: vaswani2017attention；src: ReAct (2023)）claim…（引文："…"）
 */
function renderEvidenceLines(
  evidence: EvidenceRecord[],
  bibliography: BibliographyEntryInput[],
  limit: number,
): string[] {
  if (evidence.length === 0) {
    return ["（无已核验（verified）Evidence：避免需要外部证据的强论断；可用 evidence_query 查询证据库确认）"];
  }
  return evidence.slice(0, limit).map((record) => {
    const key = resolveEvidenceCitationKey(record, bibliography);
    const title = record.source?.title?.trim();
    const year = record.source?.year;
    const meta: string[] = [];
    if (key !== null) {
      meta.push(`cite: ${key}`);
    }
    if (title !== undefined && title !== "") {
      meta.push(`src: ${title.slice(0, 60)}${year !== undefined ? ` (${year})` : ""}`);
    }
    return `- [${record.id}]${meta.length > 0 ? `（${meta.join("；")}）` : ""} ${record.claim.slice(0, 150)}${
      record.quote ? `（引文："${record.quote.slice(0, 120)}"）` : ""
    }`;
  });
}

/**
 * M9.7.6 Claim Discipline（§4）：事实性 claim 的强度纪律。写作与修订 prompt
 * 共用——「证据 claim 说什么就写什么，不升级、不外推」；无证据的出口只有
 * 弱化 / 标注不确定 / 删除，不存在「凭记忆写得更确定」。
 */
const CLAIM_DISCIPLINE_LINES = [
  "事实性论断强度纪律（数字 / 年份 / 性能结论 / 方法能力 / 实验结果 / 对论文贡献的具体描述 / 比较性事实）：",
  "- 每写一个这类论断，先在上方 Evidence 中找到能支撑它的 claim（证据说什么写什么：范围、数值、对象、限定词都不得扩大）；",
  "- 证据只支撑一部分时，只写被支撑的那部分，其余弱化为背景性描述或明确不确定性（如「有报道指出」「尚待验证」）；",
  "- 完全没有证据时删除该具体论断，只保留无争议的背景性叙述；禁止凭模型记忆把具体事实（数字、年份、结论、对比）写得更确定。",
];

/**
 * M9.7.2：bibliography key 的 evidence 支撑分组（prompt 构造时派生，不落存储）。
 * 与 quality/evidenceCitationCoverage 的覆盖判定共用 resolveEvidenceCitationKey
 * 解析链（sourceId 精确 → DOI → 归一标题+年份）——Writer 所见分组与 gate 统计
 * 永远同口径。A 组 = 至少一条 evidence 命中的 key；B 组 = 其余（LLM 回忆条目）。
 */
export function partitionEvidenceBackedKeys(
  evidence: EvidenceRecord[],
  bibliography: BibliographyEntryInput[],
): { backedKeys: string[]; unbackedKeys: string[] } {
  const backed = new Set<string>();
  for (const record of evidence) {
    const key = resolveEvidenceCitationKey(record, bibliography);
    if (key !== null) {
      backed.add(key);
    }
  }
  const backedKeys: string[] = [];
  const unbackedKeys: string[] = [];
  for (const entry of bibliography) {
    (backed.has(entry.key) ? backedKeys : unbackedKeys).push(entry.key);
  }
  return { backedKeys, unbackedKeys };
}

/**
 * M9.10 Phase 2 引用冻结清单：本章节当前实际引用的 key（确定性提取自
 * currentLatex，非 LLM 推断）。修订输出必须保留清单内每一个 key——「弱化论断」
 * 与「删除引用」是两件事：弱化后的表述仍带原 \cite；删除只发生在修订计划条目
 * 明确要求删该引用（如 citation_missing）时。清单化的动机（M9.7.1 §11 归因）：
 * 显式清单（A/B 组白名单）hallucinated=0 全零有效，而隐式「保留原文 cite」在
 * GLM-5.3 整节重写式输出下概率性丢失——把隐式约束变成显式锚点。
 */
function renderCitationFreezeLines(currentLatex: string): string[] {
  const keys = extractCitationKeys(currentLatex);
  return [
    "11. 引用冻结清单（本章节当前实际引用的 key；修订输出必须原样保留其中每一个，至少各出现一次）：",
    keys.length > 0 ? `    ${keys.join(", ")}` : "    （本章节当前没有引用；新增引用仍须遵守第 9 条 A/B 组规则）",
    "    - 禁止删除清单内任何 key：不得因「证据不足」「精简」「重写」「B 组身份」而移除；",
    "    - 弱化论断 ≠ 删除引用：把表述弱化为背景性 / 有限定的说法时，保留其 \\cite（引用标注来源主张，不背书强度）；",
    "    - 只有当上方修订计划条目明确要求删除某引用（如 citation_missing：key 不在参考文献库）时，才允许移除该 key；",
    "    - 允许新增 A 组 key；清单外与 A/B 组之外的 key 一律不得出现。",
  ];
}

/**
 * M9.7.2 引用纪律行（A/B 组分组白名单）：buildSectionPrompt / buildRevisePrompt /
 * buildOutlinePrompt 共用。政策：事实性论断（机制、方法、数值、结论）的引用
 * 必须取自 A 组；B 组只承载泛指性背景陈述——Writer 优先基于 Verified Evidence
 * 引用，而不是自由引用 bibliography（M9.7.1 baseline coverage 3/17=17.6% 的
 * 修复面；分组派生与 coverage gate 同源，无双重标准）。
 */
function renderCitationDisciplineLines(
  evidence: EvidenceRecord[],
  bibliography: BibliographyEntryInput[],
): string[] {
  if (bibliography.length === 0) {
    return ["（无可用文献：不要使用 \\cite）"];
  }
  const { backedKeys, unbackedKeys } = partitionEvidenceBackedKeys(evidence, bibliography);
  return [
    backedKeys.length > 0
      ? `   - A 组（有 verified evidence 支撑；一切事实性论断——机制描述、方法对比、实验数值、结论——的引用必须取自本组）：${backedKeys.join(", ")}`
      : "   - A 组（有 verified evidence 支撑）：（空——当前没有任何可用 key 具备 verified evidence 支撑；事实性论断只能弱化或删除，不得引用 B 组 key 支撑）",
    unbackedKeys.length > 0
      ? `   - B 组（无 verified evidence 支撑；仅限泛指性背景陈述——领域概述、广为人知的概念——不得支撑任何具体事实、数值或结论；证据不足时弱化或删除论断，不得改引本组 key 充数）：${unbackedKeys.join(", ")}`
      : "   - B 组（无 verified evidence 支撑）：（无——全部可用 key 均有证据支撑，按 A 组规则引用）",
  ];
}

/**
 * 大纲结构化输出修复上限（M9.7.6，M9.7.4 REVIEW_REPAIR_MAX_ATTEMPTS 同构）：
 * original attempt + 最多 2 次错误反馈修复，有界，绝不无限重试。
 */
export const OUTLINE_REPAIR_MAX_ATTEMPTS = 2;

export class WriterService {
  private readonly runtime: AgentRuntime;
  private readonly agentId: string;
  private readonly log: (message: string) => void;
  /** 长论文阶段的逐 run 执行超时（RunAgentInput.timeoutMs；缺省不传） */
  private readonly timeoutOverride: { timeoutMs: number } | Record<string, never>;

  constructor(options: WriterServiceOptions) {
    this.runtime = options.runtime;
    this.agentId = options.agentId;
    this.log = options.log ?? (() => {});
    this.timeoutOverride = options.runTimeoutMs !== undefined ? { timeoutMs: options.runTimeoutMs } : {};
  }

  /**
   * 执行一次写作任务。
   * 输入是用户的自然语言写作要求；输出是完整 LaTeX 文档。
   * sessionKey（可选）是该项目上次任务返回的 Runtime 会话引用，原样透传以复用上下文。
   */
  async write(params: {
    projectId: string;
    prompt: string;
    sessionKey?: string;
  }): Promise<WriterResult> {
    const prompt = params.prompt.trim();
    if (prompt === "") {
      throw new AgentRunFailedError("写作任务（prompt）不能为空");
    }

    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      ...this.timeoutOverride,
      task: buildWriterPrompt(prompt),
      projectId: params.projectId,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      metadata: { role: "writer" },
    });

    if (task.status !== "completed") {
      throw new AgentRunFailedError(task.error ?? `Writer 任务以 ${task.status} 状态结束`);
    }
    const output = task.output?.trim();
    if (!output) {
      throw new AgentRunFailedError("Writer 没有返回任何文本");
    }

    const latex = stripCodeFence(output);
    if (!latex.includes("\\documentclass")) {
      throw new InvalidLatexOutputError(
        "返回内容中没有 \\documentclass 命令（应为完整 LaTeX 文档）",
      );
    }
    if (!latex.includes("\\begin{document}")) {
      throw new InvalidLatexOutputError("返回内容中没有 \\begin{document}");
    }

    this.log(`[writer] projectId=${params.projectId} taskId=${task.taskId} 产出 LaTeX ${latex.length} 字符`);
    return { task, latex };
  }

  // ---- 分节写作 ----

  /**
   * 产出结构化大纲（JSON）。校验：至少 3 节、文件名合法、id 唯一。
   * feedback 用于 HITL 修订轮（用户对上一版大纲的修改意见）。
   *
   * M11.1.3 Survey 模式：surveyDigest 存在时走综述大纲 prompt（按方法体系
   * 组织 / synthesisRefs / literatureRefs 契约），researchDigest 可省；缺省
   * （普通论文路径）行为与旧版完全一致——refs 字段不解析。
   *
   * M9.7.6 Structured Output Repair（M9.7.4 Reviewer repair 同构）：输出已产生
   * 但未通过结构化校验时，把具体校验错误 + 上一轮输出回馈模型做有界修复
   * （≤ OUTLINE_REPAIR_MAX_ATTEMPTS 次），不原样重跑。真实漂移形态（2026-09-24
   * GLM-5.3 smoke 实录）：abstract 含未转义 ASCII 双引号 → 外层 JSON 非法 →
   * extractJsonObject 回退命中内层 section 子对象 → 伪装成 sections<3 校验错。
   * repair prompt 显式提示转义规则修复此类漂移；全部失败仍如实抛错。
   */
  async planOutline(params: {
    projectId: string;
    researchDigest?: {
      domainOverview: string;
      researchGaps: string[];
      potentialContributions: string[];
    };
    evidence: EvidenceRecord[];
    bibliography: BibliographyEntryInput[];
    targetProfile?: string;
    documentType?: string;
    /** 稿件语言（M9.7.4；undefined = legacy 不注入） */
    language?: ManuscriptLanguage;
    feedback?: string;
    /** M11.1.3：Survey 大纲 digest（存在 = Survey 模式；章节结构来自七类 synthesis） */
    surveyDigest?: SurveyOutlineDigest;
  }): Promise<Outline & { repair?: { attempts: number; errors: string[] } }> {
    const survey = params.surveyDigest !== undefined;
    if (!survey && params.researchDigest === undefined) {
      throw new AgentRunFailedError("planOutline 需要 researchDigest（普通论文）或 surveyDigest（综述）之一");
    }
    let lastOutput = "";
    const validationErrors: string[] = [];
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= OUTLINE_REPAIR_MAX_ATTEMPTS; attempt += 1) {
      const task = await this.runtime.runAgent({
        agentId: this.agentId,
        ...this.timeoutOverride,
        task:
          attempt === 0
            ? survey
              ? buildSurveyOutlinePrompt({
                  targetProfile: params.targetProfile,
                  documentType: params.documentType,
                  ...(params.language !== undefined ? { language: params.language } : {}),
                  ...(params.feedback !== undefined ? { feedback: params.feedback } : {}),
                  surveyDigest: params.surveyDigest!,
                })
              : buildOutlinePrompt(params as Parameters<typeof buildOutlinePrompt>[0])
            : buildOutlineRepairPrompt(lastOutput, validationErrors),
        projectId: params.projectId,
        contextScope: "writing/outline",
        ...(params.language !== undefined ? { language: params.language } : {}),
        metadata: {
          role: "writer",
          skill: "outline",
          ...(survey ? { outlineProfile: "survey" } : {}),
          ...(attempt > 0 ? { structuredRepairAttempt: attempt } : {}),
        },
      });
      if (task.status !== "completed") {
        // 模型 / 网络层失败不是结构化违约：直接抛出（Stage transient retry 兜底）
        throw new AgentRunFailedError(task.error ?? `大纲任务以 ${task.status} 状态结束`);
      }
      lastOutput = task.output ?? "";
      try {
        const parsed = extractJsonObject(lastOutput, "大纲结果");
        const outline: Outline = {
          title:
            typeof parsed["title"] === "string" && parsed["title"].trim() !== ""
              ? parsed["title"].trim()
              : "Untitled",
          ...(typeof parsed["abstract"] === "string" && parsed["abstract"].trim() !== ""
            ? { abstract: parsed["abstract"].trim() }
            : {}),
          sections: readOutlineSections(parsed, { surveyRefs: survey }),
        };
        const violations = validateOutline(outline);
        if (violations.length > 0) {
          throw new InvalidLatexOutputError(`大纲未通过校验：${violations.join("；")}`);
        }
        if (attempt > 0) {
          this.log(
            `[writer] projectId=${params.projectId} 大纲结构化修复成功（第 ${attempt} 次修复）：${validationErrors.length} 项校验错误已补齐`,
          );
        }
        this.log(`[writer] projectId=${params.projectId} 大纲完成：${outline.sections.length} 节`);
        return attempt > 0
          ? { ...outline, repair: { attempts: attempt, errors: [...validationErrors] } }
          : outline;
      } catch (error) {
        if (!(error instanceof AgentRunFailedError) && !(error instanceof InvalidLatexOutputError)) {
          throw error;
        }
        lastError = error;
        validationErrors.push(error.message);
        this.log(
          `[writer] projectId=${params.projectId} 第 ${attempt + 1} 次大纲输出未通过结构化校验：${error.message}`,
        );
      }
    }
    // 有界耗尽：如实失败（禁止伪造默认结构）
    throw new AgentRunFailedError(
      `大纲结构化输出在 ${OUTLINE_REPAIR_MAX_ATTEMPTS + 1} 次尝试（含 ${OUTLINE_REPAIR_MAX_ATTEMPTS} 次错误反馈修复）后仍未通过校验：` +
        `${lastError !== undefined ? lastError.message : "未知校验错误"}（修复历史：${validationErrors.join("；")}）`,
    );
  }

  /**
   * 写作单个章节（LaTeX 片段，不含文档骨架）。
   * 校验：非空、不含 \documentclass / \begin{document}（骨架由确定性代码生成）。
   *
   * M11.2 Survey 模式：params.survey 存在时走综述章节 prompt（按 synthesis
   * 表达，refs 契约的有界投影），输出后做确定性引用后检——出现的每个
   * \cite key 必须 ∈ context.allowedCitationKeys（fail-closed，防 Writer
   * 凭记忆引用输入之外的文献）。缺省（普通论文）行为与旧版完全一致。
   */
  async writeSection(params: {
    projectId: string;
    section: OutlineSection;
    outline: Outline;
    evidence: EvidenceRecord[];
    bibliography: BibliographyEntryInput[];
    styleProfile?: Record<string, unknown>;
    /** 稿件语言（M9.7.4；undefined = legacy 不注入） */
    language?: ManuscriptLanguage;
    extraInstructions?: string;
    /** M11.2：Survey 章节写作上下文（存在 = Survey 模式） */
    survey?: SurveySectionWritingContext;
  }): Promise<{ latex: string; taskId: string }> {
    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      ...this.timeoutOverride,
      task:
        params.survey !== undefined
          ? buildSurveySectionPrompt({
              section: params.section,
              outline: params.outline,
              bibliography: params.bibliography,
              ...(params.language !== undefined ? { language: params.language } : {}),
              survey: params.survey,
            })
          : buildSectionPrompt(params),
      projectId: params.projectId,
      contextScope: "writing/sections",
      ...(params.language !== undefined ? { language: params.language } : {}),
      metadata: {
        role: "writer",
        skill: "section",
        ...(params.survey !== undefined ? { documentType: "survey" } : {}),
      },
    });
    if (task.status !== "completed") {
      throw new AgentRunFailedError(
        task.error ?? `章节 ${params.section.id} 写作任务以 ${task.status} 状态结束`,
      );
    }
    const latex = stripCodeFence(task.output ?? "").trim();
    if (latex === "") {
      throw new AgentRunFailedError(`章节 ${params.section.id} 没有返回内容`);
    }
    if (latex.includes("\\documentclass") || latex.includes("\\begin{document}")) {
      throw new InvalidLatexOutputError(
        `章节 ${params.section.id} 返回了完整文档骨架（应为正文片段；骨架由系统生成）`,
      );
    }
    if (!hasBalancedBraces(latex)) {
      throw new InvalidLatexOutputError(`章节 ${params.section.id} 花括号不配对`);
    }
    // M11.2 Survey 引用后检（确定性）：key 越界 = 契约违约，交 Stage 层重试
    if (params.survey !== undefined) {
      const allowed = new Set(params.survey.allowedCitationKeys);
      const violated = extractCitationKeys(latex).filter((key) => !allowed.has(key));
      if (violated.length > 0) {
        throw new InvalidLatexOutputError(
          `章节 ${params.section.id} 引用了本节契约之外的 citation key：${violated.join("、")}` +
            `（只允许：${params.survey.allowedCitationKeys.join(", ") || "（无）"}）`,
        );
      }
    }
    return { latex, taskId: task.taskId };
  }

  // ---- 修订 ----

  /**
   * 依据汇总的 review issues / 改进计划修订单个章节（有界修改闭环中的一环）。
   * 只针对该章节的问题；证据不足的论断要求弱化或删除，不允许新造引用。
   *
   * M5.7：externalDirectives 非空时，外部修改意见以「最高业务优先级」
   * 进入 prompt，且输出末尾携带 %%%PT-OUTCOMES%%% 执行报告行（applied /
   * conflict / not_applicable）；事实 / 引用 / 证据约束不因外部意见放宽。
   *
   * M6.7 §12：revisionItems 非空时，Writer 直接读取结构化 Revision Plan 条目
   * （id / 风险档位 / 关联证据 / 修改要求），prompt 附「修改前依据」上下文；
   * issues 通道保持兼容（旧调用 / 无计划回退）。
   */
  async reviseSection(params: {
    projectId: string;
    section: OutlineSection;
    outline: Outline;
    currentLatex: string;
    issues: ReviewIssue[];
    evidence: EvidenceRecord[];
    bibliography: BibliographyEntryInput[];
    buildError?: string;
    /** 稿件语言（M9.7.4；undefined = legacy 不注入） */
    language?: ManuscriptLanguage;
    extraInstructions?: string;
    /** 外部修改意见（M5.7；缺省 = 行为与旧版完全一致） */
    externalDirectives?: ExternalDirectiveDispatch[];
    /**
     * Unsupported Claim Repair Context（M9.7.6：本节命中的 UNSUPPORTED /
     * CONTRADICTED claim + 候选 Verified Evidence；缺省 = 无该区块）
     */
    claimRepairs?: ClaimRepairDirective[];
    /** 结构化修订计划条目（M6.7；本节命中的 applied 待执行条目） */
    revisionItems?: RevisionPlanItem[];
    /** 条目关联证据的完整记录池（M6.7 §6：修改前依据；缺省退化为 formal 快照） */
    itemEvidence?: EvidenceRecord[];
    /** M10.3：单文件项目的整文件修订（main.tex；输出完整文件而非片段） */
    wholeFile?: boolean;
    /**
     * M10.3.1：整文件目标在磁盘上的绝对路径。GLM 5.3 在工具会话中会改用
     * write/edit 直接改写目标文件而最终消息为空（真实 E2E 实测 77.7KB→90.2KB
     * 直接落盘、消息空 → 判失败 ×2）。提供路径后：最终消息为空但目标文件相对
     * currentLatex 真实变化时，确定性采纳磁盘内容为修订结果（DoD / gate 照常
     * 裁决，不降低任何守卫）。
     */
    targetFilePath?: string;
    /** Existing-paper scoped revision: proposal-only session with mutation tools removed. */
    proposalOnly?: boolean;
    /**
     * M11.2 Survey：本节的写作上下文投影（存在 = Survey 修订模式）。注入
     * 综述结构红线——taxonomy / gap / speculative 语气 / 文献集合不得因
     * 「修得更漂亮」而被改写；引用白名单与写作阶段同源。
     */
    survey?: SurveySectionWritingContext;
    /** Targeted validation-aware repair context; never expands the target scope. */
    patchRepairContext?: string;
  }): Promise<{ latex: string; taskId: string; externalOutcomes?: ExternalOutcomeReport[] }> {
    if (
      params.issues.length === 0 &&
      params.buildError === undefined &&
      (params.externalDirectives ?? []).length === 0 &&
      (params.claimRepairs ?? []).length === 0 &&
      params.patchRepairContext === undefined
    ) {
      // 无问题章节原样返回（不烧 Token）
      return { latex: params.currentLatex, taskId: "(unchanged)" };
    }
    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      ...this.timeoutOverride,
      task: buildRevisePrompt({
        ...params,
        ...(params.revisionItems !== undefined && params.revisionItems.length > 0
          ? {
              evidenceById: new Map(
                (params.itemEvidence ?? params.evidence).map((record) => [record.id, record]),
              ),
            }
          : {}),
      }),
      projectId: params.projectId,
      contextScope: params.proposalOnly ? "writing/revision-proposal" : "writing/revision",
      ...(params.proposalOnly ? { toolPolicy: "read_only" as const } : {}),
      ...(params.language !== undefined ? { language: params.language } : {}),
      metadata: {
        role: "writer",
        skill: "revision",
        ...(params.survey !== undefined ? { documentType: "survey" } : {}),
        ...(params.externalDirectives !== undefined && params.externalDirectives.length > 0
          ? { externalInstructions: params.externalDirectives.length }
          : {}),
      },
    });
    if (task.status !== "completed") {
      throw new AgentRunFailedError(
        task.error ?? `章节 ${params.section.id} 修订任务以 ${task.status} 状态结束`,
      );
    }
    // M5.7：先分离执行报告标记行，正文再走既有校验
    const { latex: bodyLatex, outcomes } = splitExternalOutcomes(
      task.output ?? "",
      params.externalDirectives ?? [],
    );
    // M9.10 Phase 1：防御性剥离「无外部意见派发时模型自发输出的协议标记行」——
    // GLM-5.3 会把 RevisionPlanItem id 当 instructionId 上报 PT-OUTCOMES（m910 E2E
    // rev3 实录：协议行连同 JSON 进入正文，其数字片段被 Fact Preservation 判为
    // added_number）。协议行不可能是合法 LaTeX 内容，无论是否派发过外部意见都剥离。
    let latex = stripStrayOutcomeLines(stripCodeFence(bodyLatex)).trim();
    if (latex === "") {
      // M10.3.1：整文件目标——模型用 write/edit 工具直接改写文件而最终消息为空
      // 时，磁盘上的真实变更就是修订结果（确定性读取；继续走下方全部 DoD 与
      // 下游 Fact Preservation / Quality Gate，不降低任何守卫）
      if (params.wholeFile === true && params.targetFilePath !== undefined && !params.proposalOnly) {
        const onDisk = await readFile(params.targetFilePath, "utf8");
        const diskLatex = stripStrayOutcomeLines(stripCodeFence(onDisk)).trim();
        if (diskLatex !== "" && diskLatex !== params.currentLatex.trim()) {
          latex = diskLatex;
        }
      }
    }
    if (latex === "") {
      throw new AgentRunFailedError(`章节 ${params.section.id} 修订没有返回内容`);
    }
    if (params.wholeFile === true) {
      // M10.3：整文件目标——输出必须是完整文档（缺失骨架说明 Writer 误解了契约）
      if (!latex.includes("\\documentclass") || !latex.includes("\\begin{document}")) {
        throw new InvalidLatexOutputError(
          `章节 ${params.section.id} 整文件修订缺少完整文档骨架（\\documentclass / \\begin{document}）`,
        );
      }
    } else if (latex.includes("\\documentclass") || latex.includes("\\begin{document}")) {
      throw new InvalidLatexOutputError(
        `章节 ${params.section.id} 修订返回了完整文档骨架（应为正文片段）`,
      );
    }
    if (params.section.id === "abstract" && /(\\section|\\begin\{)/.test(latex)) {
      // 摘要载体是纯文本：返回 LaTeX 结构说明 Writer 误解了目标
      throw new InvalidLatexOutputError(
        `摘要修订返回了 LaTeX 结构（应为纯文本摘要）`,
      );
    }
    if (!hasBalancedBraces(latex)) {
      throw new InvalidLatexOutputError(`章节 ${params.section.id} 修订花括号不配对`);
    }
    return {
      latex,
      taskId: task.taskId,
      ...(outcomes !== undefined ? { externalOutcomes: outcomes } : {}),
    };
  }

  /**
   * Style-only 润色（M5.4 Style Revision Loop）：只按 style plan 条目调整表达，
   * 不允许改变事实 / 数字 / 引用 / 公式 / 术语 / 结论强度；调用方在写回前执行
   * deterministic Style Invariant Checker，失败即丢弃输出（原稿保留）。
   * contextScope=writing/style-polish → 注入 academic-writing-zh + academic-style-zh。
   */
  async polishSectionStyle(params: {
    projectId: string;
    section: OutlineSection;
    currentLatex: string;
    items: RevisionPlanItem[];
    /** 受保护术语（glossary / 调用方传入；invariant 检查同源） */
    protectedTerms: string[];
    bibliographyKeys: string[];
  }): Promise<{ latex: string; taskId: string }> {
    if (params.items.length === 0) {
      return { latex: params.currentLatex, taskId: "(unchanged)" };
    }
    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      ...this.timeoutOverride,
      task: buildStylePolishPrompt(params),
      projectId: params.projectId,
      contextScope: "writing/style-polish",
      metadata: { role: "writer", skill: "style-polish" },
    });
    if (task.status !== "completed") {
      throw new AgentRunFailedError(
        task.error ?? `章节 ${params.section.id} 语言润色任务以 ${task.status} 状态结束`,
      );
    }
    const latex = stripCodeFence(task.output ?? "").trim();
    if (latex === "") {
      throw new AgentRunFailedError(`章节 ${params.section.id} 语言润色没有返回内容`);
    }
    if (latex.includes("\\documentclass") || latex.includes("\\begin{document}")) {
      throw new InvalidLatexOutputError(
        `章节 ${params.section.id} 语言润色返回了完整文档骨架（应为正文片段）`,
      );
    }
    if (params.section.id === "abstract" && /(\\section|\\begin\{)/.test(latex)) {
      throw new InvalidLatexOutputError("摘要语言润色返回了 LaTeX 结构（应为纯文本摘要）");
    }
    if (!hasBalancedBraces(latex)) {
      throw new InvalidLatexOutputError(`章节 ${params.section.id} 语言润色后花括号不配对`);
    }
    return { latex, taskId: task.taskId };
  }

  /**
   * 修复编译错误（M4.7 bounded repair loop）。
   * 上下文刻意最小化：只给受影响章节的当前内容 + 结构化编译诊断
   * （文件 / 行号 / 错误 / 附近行），绝不整篇论文 + 整份日志。
   * 只允许修语法 / 结构，不允许改变论述内容或引用。
   */
  async repairSection(params: {
    projectId: string;
    sectionFile: string;
    currentLatex: string;
    buildError: string;
    diagnostics: { file: string | null; line: number | null; message: string; contextLines: string[] }[];
  }): Promise<{ latex: string; taskId: string }> {
    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      ...this.timeoutOverride,
      task: buildRepairPrompt(params),
      projectId: params.projectId,
      contextScope: "writing/repair",
      metadata: { role: "writer", skill: "repair" },
    });
    if (task.status !== "completed") {
      throw new AgentRunFailedError(
        task.error ?? `章节 ${params.sectionFile} 编译修复任务以 ${task.status} 状态结束`,
      );
    }
    const latex = stripCodeFence(task.output ?? "").trim();
    if (latex === "") {
      throw new AgentRunFailedError(`章节 ${params.sectionFile} 修复没有返回内容`);
    }
    if (latex.includes("\\documentclass") || latex.includes("\\begin{document}")) {
      throw new InvalidLatexOutputError(
        `章节 ${params.sectionFile} 修复返回了完整文档骨架（应为正文片段）`,
      );
    }
    if (!hasBalancedBraces(latex)) {
      throw new InvalidLatexOutputError(`章节 ${params.sectionFile} 修复后花括号不配对`);
    }
    return { latex, taskId: task.taskId };
  }

  /**
   * Existing-Paper Improvement：依据审稿问题与目标差距生成分节改进计划。
   * 输出为结构化 plan（经校验），不改写正文。
   *
   * M10.3：计划输入扩展（A 原稿基线 / B·E 分层证据 / 需求覆盖 / 外部意见 /
   * 作者目标）；条目可选携带 relatedEvidenceIds（修改依据的证据 id）、
   * instructionId（对应外部意见）、expectedFactChanges（授权的事实数值变更
   * before → after）。确定性校验：证据 id / 意见 id 必须存在于给定清单，
   * 伪造引用一律剥离。
   */
  async planImprovement(params: {
    projectId: string;
    issues: ReviewIssue[];
    analysisDigest: string;
    feasibilityLevel: string;
    targetProfile?: string;
    feedback?: string;
    /** 现有章节文件（相对 manuscript/ 的 POSIX 路径；section 字段必须从中选择） */
    sectionFiles: string[];
    logicalTargets?: { file: string; logicalSection: string; heading: string; label?: string }[];
    /** M10.3：原稿冻结事实基线要点（表格 / 引用 / 硬件 / 占位） */
    baselineDigest?: string;
    /** M10.3：分层证据摘要（verified 外部文献 + user_confirmed 作者实验） */
    evidenceDigest?: string;
    /** M10.3：文献需求覆盖现状 */
    coverageDigest?: string;
    /** M10.3：外部修改意见摘要（状态 + instructionId） */
    instructionDigest?: string;
    /** M10.3：作者修订目标（run prompt） */
    authorGoal?: string;
    /** 合法证据 id 清单（relatedEvidenceIds 校验用；缺省不校验但也不注入提示） */
    validEvidenceIds?: string[];
    validEvidenceProtocolScopes?: Record<string, { protocolId: string; status: "current" | "historical" | "superseded" }>;
    commentAliases?: { ref: string; canonicalId: string; text: string; reviewerLabel?: string }[];
    /**
     * M11.4 Reliability Closure（F7）：意见 ↔ 基线章节词面相关提示（确定性，
     * 由 plan.improvement stage 计算）。只进 prompt 的候选可见性——评论前提
     * 可能已被基线反驳（如「缺少 X 实验」而基线已有 X 小节），此时合法计划是
     * noop + coverageQuote + evidenceRefs，而不是 modify / author_decision。
     */
    commentTargetHints?: string[];
    evidenceAliases?: { ref: string; canonicalId: string; claim: string; provenance: string; protocolStatus: string; supportStrength?: string; verificationLevel?: string }[];
    /** 合法外部意见 id 清单（instructionId 校验用） */
    validInstructionIds?: string[];
    /** 外部意见原文；用于对模型漏链意见生成保守的 author-decision 计划项 */
    externalInstructions?: { instructionId: string; text: string }[];
    /** Internal, bounded structured-field repair state. */
    structuredRepair?: { request: string; attempts: number; originalPlan?: unknown[]; invalidFields?: Record<number, string[]> };
  }): Promise<ImprovementPlan> {
    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      ...this.timeoutOverride,
      task: [
        "你是一名论文写手（Writer）。请基于审稿问题与目标差距，为已有 LaTeX 论文制定分节改进计划（只规划，不写正文）。",
        "",
        "只输出一个 JSON 对象（不要 Markdown 围栏）：",
        '{"plan": [{"section": "sections/xxx.tex", "logicalSection": "subsec:datasets（如适用）", "actionType": "modify|noop|author_decision_required", "coverageQuote": "NO-OP 时逐字摘录当前稿内容", "protocolId": "当前实验协议 id（如适用）", "action": "具体改法（要点名涉及的旧值与新值）", "rationale": "对应的问题或差距（含依据）", "priority": "high|medium|low",',
        '  "commentRefs": ["C1"], "evidenceRefs": ["EV1"],',
        '  "expectedFactChanges": [{"before": "旧值", "after": "新值", "basis": "证据 id 或依据说明"}]}]}',
        "",
        "要求：",
        "1. plan 至少 1 项、至多 20 项；section 必须是以下现有章节文件之一：",
        ...(params.sectionFiles.length > 0
          ? params.sectionFiles.map((file) => `   - ${file}`)
          : ["   - （未识别到章节文件：section 使用 main.tex）"]),
        ...(params.logicalTargets !== undefined && params.logicalTargets.length > 0
          ? ["   可用逻辑章节 target（single-file 项目必须选择；不得把 main.tex 当作整稿 scope）：", ...params.logicalTargets.map((target) => `   - file=${target.file}; logicalSection=${target.logicalSection}; heading=${target.heading}${target.label ? `; label=${target.label}` : ""}`)]
          : []),
        "2. 优先处理 critical / blocking 问题与编译错误。",
        "3. 证据不足的论断计划为「弱化或删除」，不允许计划编造实验或引用。",
        "4. 修改实验数值的条目必须：action 点名旧值与新值 + expectedFactChanges 逐条列出 + evidenceRefs 选择 allowlist 中支持该变更的证据。没有证据授权的数值修改不允许进入计划。",
        "5. 证据分层纪律：verified（已核验文献）只支撑外部事实论述；user_confirmed（作者实验）只授权作者自身实验数值变更，不得当作外部科学事实验证。",
        "6. 每条可验证（不要「整体润色全文」这类无法验证的模糊任务）。",
        "7. actionType=noop 只能表示 baseline 已满足。必须给出 coverageQuote（逐字摘自指定 logicalSection，引用足以证明意见要求的内容已在基线中）；若存在可核验的 EV 证据则一并绑定（增强，非必需）。不能仅用 rationale 写‘已覆盖’。系统会确定性核验引文逐字存在于目标章节，核验失败即不会关闭 comment。",
        "8. 需要事实或实验依据的意见：有兼容证据时必须选择对应 EV alias；没有时应给出 evidence gap 或 author_decision_required，不得编造 Evidence。",
        "9. action 的执行不得依赖作者输入：凡需要「由作者确认 / 待作者确认」才能落笔的条目（如实现细节二选一、超参数最终取值），必须 actionType=author_decision_required 并在 rationale 写明决策点。注意：只把真正依赖作者输入的条目标为 author_decision_required——有证据支撑的修改（EV 别名可绑定）和纯表述 / 结构 / 弱化类修改仍然应当 modify，不要为保守而把所有意见推向作者决策。",
        "10. 不得计划新增基线没有的分析性 / 方法论论断（如指标间循环评测风险、构造性论证、机制有效性声明），除非绑定支持它的 EV 证据——此类新增论断会被事实核验判 UNSUPPORTED 并按修订引入违规阻断。对证据不足的既有论断，正确动作是弱化该论断本身（weaken），不是新增一条与之并存的相反表述。",
        ...(params.feedback ? ["", "用户补充要求：", params.feedback] : []),
        "",
        `目标档次：${params.targetProfile ?? "未指定"}；可行性结论：${params.feasibilityLevel}`,
        ...(params.authorGoal !== undefined
          ? ["", "===== 作者修订目标 =====", params.authorGoal]
          : []),
        ...(params.baselineDigest !== undefined
          ? ["", "===== 原稿冻结基线 =====", params.baselineDigest]
          : []),
        ...(params.instructionDigest !== undefined
          ? ["", "===== 外部修改意见 =====", params.instructionDigest]
          : []),
        ...(params.externalInstructions !== undefined && params.externalInstructions.length > 0
          ? ["", "===== External comment linkage aliases (linkage only) =====", ...((params.commentAliases ?? buildPlannerAliases(params.externalInstructions, "C", (item) => item.instructionId).map((alias) => ({ ...alias, text: alias.value.text }))).map((item) => `${item.ref} [${"reviewerLabel" in item ? item.reviewerLabel ?? "Reviewer" : "Reviewer"}] ${item.text}`)), `Only use comment references from: [${(params.commentAliases ?? buildPlannerAliases(params.externalInstructions, "C", (item) => item.instructionId)).map((item) => item.ref).join(",")}]`]
          : []),
        ...(params.commentTargetHints !== undefined && params.commentTargetHints.length > 0
          ? [
              "",
              "===== Baseline coverage check（评论前提可能已被基线反驳）=====",
              ...params.commentTargetHints,
              "先核对每条意见：若基线相关章节已包含意见要求的内容，该意见必须计划为 actionType=noop（coverageQuote 逐字摘录该章节内容 + evidenceRefs 绑定可核验证据），不得再计划 modify。以上章节仅是词面候选，无关章节不要强行关联。",
            ]
          : []),
        ...(params.evidenceAliases !== undefined
          ? ["", "===== Eligible verified Evidence aliases =====", ...(params.evidenceAliases.length === 0 ? ["No eligible evidence is available."] : params.evidenceAliases.map((item) => `${item.ref}: ${item.claim}; provenance=${item.provenance}; protocol=${item.protocolStatus}; support=${item.supportStrength ?? "unknown"}; level=${item.verificationLevel ?? "unknown"}`)), `Only use evidence references from: [${params.evidenceAliases.map((item) => item.ref).join(",")}]`]
          : []),
        ...(params.coverageDigest !== undefined
          ? ["", "===== 文献需求覆盖 =====", params.coverageDigest]
          : []),
        ...(params.evidenceDigest !== undefined
          ? ["", "===== 证据（分层）=====", params.evidenceDigest]
          : []),
        "",
        "===== 论文理解摘要 =====",
        params.analysisDigest,
        "",
        "===== 审稿问题 =====",
        ...params.issues
          .slice(0, 30)
          .map(
            (issue) =>
              `- [${issue.severity}${issue.blocking ? "/blocking" : ""}][${issue.section}] ${issue.description}`,
          ),
        ...(params.structuredRepair !== undefined
          ? [
              "",
              "===== STRUCTURED OUTPUT REPAIR (highest priority) =====",
              params.structuredRepair.request,
              "Only repair the invalid structured fields. Do not replan valid items or change scientific intent. Return JSON only.",
            ]
          : []),
      ].join("\n"),
      projectId: params.projectId,
      contextScope: "writing/improvement-plan",
      metadata: { role: "writer", skill: "improvement-plan" },
    });
    if (task.status !== "completed") {
      throw new AgentRunFailedError(task.error ?? `改进计划任务以 ${task.status} 状态结束`);
    }
    const parsed = extractJsonObject(task.output ?? "", "改进计划");
    const rawPlanValue = parsed["plan"];
    if (!Array.isArray(rawPlanValue) || rawPlanValue.length === 0) {
      throw new AgentRunFailedError("改进计划：缺少非空 plan 数组");
    }
    const rawPlan = params.structuredRepair?.originalPlan !== undefined && params.structuredRepair.invalidFields !== undefined
      ? params.structuredRepair.originalPlan.map((original, index) => {
          const allowedFields = params.structuredRepair!.invalidFields![index] ?? [];
          if (allowedFields.length === 0) return original;
          const repaired = rawPlanValue[index];
          if (typeof original !== "object" || original === null || typeof repaired !== "object" || repaired === null) return original;
          const merged = { ...(original as Record<string, unknown>) };
          for (const field of allowedFields) {
            const repairedRecord = repaired as Record<string, unknown>;
            const actualField = field === "relatedEvidenceIds" && Object.prototype.hasOwnProperty.call(repairedRecord, "evidenceRefs") ? "evidenceRefs" : field;
            if (Object.prototype.hasOwnProperty.call(repairedRecord, actualField)) merged[actualField] = repairedRecord[actualField];
          }
          return merged;
        })
      : rawPlanValue;
    const validEvidence = new Set(params.validEvidenceIds ?? []);
    const validInstructions = new Set(params.validInstructionIds ?? []);
    const evidenceAliasList = params.evidenceAliases ?? buildPlannerAliases(
      (params.validEvidenceIds ?? []).map((canonicalId) => ({ canonicalId })), "EV", (item) => item.canonicalId,
    ).map((alias) => ({ ref: alias.ref, canonicalId: alias.canonicalId, claim: "verified evidence", provenance: "project source", protocolStatus: "eligible" }));
    const commentAliasList = params.commentAliases ?? buildPlannerAliases(
      params.externalInstructions ?? [], "C", (item) => item.instructionId,
    ).map((alias) => ({ ref: alias.ref, canonicalId: alias.canonicalId, text: alias.value.text }));
    const structuredFailures: { itemIndex: number; field: string; code: string; message: string }[] = [];
    const items: ImprovementPlanItem[] = [];
    for (const [itemIndex, raw] of rawPlan.slice(0, 20).entries()) {
      if (typeof raw !== "object" || raw === null) {
        continue;
      }
      const record = raw as Record<string, unknown>;
      const section = typeof record["section"] === "string" ? record["section"].trim() : "";
      const action = typeof record["action"] === "string" ? record["action"].trim() : "";
      if (section === "" || action === "") {
        continue;
      }
      const priority =
        record["priority"] === "high" || record["priority"] === "medium" || record["priority"] === "low"
          ? record["priority"]
          : "medium";
      const actionType = record["actionType"] === "noop" || record["actionType"] === "author_decision_required"
        ? record["actionType"]
        : "modify";
      const planText = `${action} ${typeof record["rationale"] === "string" ? record["rationale"] : ""}`;
      const protocolId = typeof record["protocolId"] === "string" && record["protocolId"].trim() !== ""
        ? record["protocolId"].trim()
        : /fair[-_ ]?ablation|公平(?:实验|协议)|newly fine[- ]tuned detector/i.test(planText)
          ? "fair_ablation_new_detector"
          : "";
      const rawEvidenceRefs = record["evidenceRefs"] ?? (params.evidenceAliases === undefined ? record["relatedEvidenceIds"] : undefined);
      if (params.evidenceAliases !== undefined && record["relatedEvidenceIds"] !== undefined && record["evidenceRefs"] === undefined) {
        structuredFailures.push({ itemIndex, field: "evidenceRefs", code: "EVIDENCE_ALIAS_REQUIRED", message: "Use evidenceRefs aliases; canonical Evidence IDs are not accepted in Planner output" });
      }
      let resolvedEvidenceRefs: string[] = [];
      if (Array.isArray(rawEvidenceRefs)) {
        try { resolvedEvidenceRefs = rawEvidenceRefs.every((id) => typeof id === "string" && /^EV\d+$/i.test(id.trim()))
          ? resolvePlannerRefs(rawEvidenceRefs as string[], evidenceAliasList, "EV")
          : rawEvidenceRefs as string[]; } catch { resolvedEvidenceRefs = rawEvidenceRefs as string[]; }
      }
      const linkedEvidenceIds = Array.isArray(rawEvidenceRefs)
        ? resolvedEvidenceRefs.flatMap((id): string[] => {
            if (typeof id !== "string" || id.trim() === "") {
              structuredFailures.push({ itemIndex, field: "evidenceRefs", code: "INVALID_EVIDENCE_ID", message: "Evidence reference must be a non-empty string" });
              return [];
            }
            const evidenceId = id.trim();
            const scope = params.validEvidenceProtocolScopes?.[evidenceId];
            if (scope?.status === "superseded") {
              structuredFailures.push({ itemIndex, field: "evidenceRefs", code: "EVIDENCE_SUPERSEDED", message: `${evidenceId} is superseded` });
              return [];
            }
            if (!validEvidence.has(evidenceId)) {
              structuredFailures.push({ itemIndex, field: "evidenceRefs", code: "INVALID_EVIDENCE_ID", message: `${evidenceId} is not an allowed verified Evidence reference` });
              return [];
            }
            if (protocolId !== "" && (scope?.protocolId !== protocolId || scope.status !== "current")) {
              structuredFailures.push({ itemIndex, field: "evidenceRefs", code: "EVIDENCE_PROTOCOL_MISMATCH", message: `${evidenceId} is not current evidence for ${protocolId}` });
              return [];
            }
            return [evidenceId];
          }).slice(0, 8)
        : [];
      const logicalSection = typeof record["logicalSection"] === "string" ? record["logicalSection"].trim() : "";
      const coverageQuote = typeof record["coverageQuote"] === "string" ? record["coverageQuote"].trim() : "";
      if (params.sectionFiles.length > 0 && !params.sectionFiles.includes(section) && section !== "main.tex") {
        structuredFailures.push({ itemIndex, field: "section", code: "TARGET_NOT_ALLOWED", message: `${section} is not an existing manuscript section` });
      }
      if (params.logicalTargets !== undefined && params.logicalTargets.length > 0 &&
        (logicalSection === "" || !params.logicalTargets.some((target) => target.file === section && target.logicalSection === logicalSection))) {
        structuredFailures.push({ itemIndex, field: "logicalSection", code: "TARGET_REQUIRED", message: "single-file plan items must select a listed logicalSection" });
      }
      if (actionType === "noop") {
        if (!coverageQuote) structuredFailures.push({ itemIndex, field: "coverageQuote", code: "NOOP_COVERAGE_REQUIRED", message: "noop requires a verbatim coverage quote" });
        if (!logicalSection) structuredFailures.push({ itemIndex, field: "logicalSection", code: "TARGET_REQUIRED", message: "noop requires a logical target" });
        // M11.4 Reliability Closure（Run E 实证）：Evidence 绑定不再强制——
        // 基线覆盖类 noop（引用数达标 / 已有部署章节）的证明就是稿件引文本身；
        // 旧的 EVIDENCE_LINK_REQUIRED 使合法 noop 结构性无解（repair 耗尽 →
        // 阶段失败）。核验口径见 verifyNoopCoverage（引文逐字 + 绑定则校验）。
        if (typeof record["rationale"] !== "string" || record["rationale"].trim() === "") structuredFailures.push({ itemIndex, field: "rationale", code: "NOOP_VERIFICATION_REQUIRED", message: "noop requires a verification basis" });
      }
      if (Array.isArray(record["expectedFactChanges"]) && record["expectedFactChanges"].length > 0 && linkedEvidenceIds.length === 0) {
        structuredFailures.push({ itemIndex, field: "evidenceRefs", code: "FACT_CHANGE_EVIDENCE_REQUIRED", message: "fact-changing plan items require verified Evidence linkage" });
      }
      if (actionType === "author_decision_required" && (typeof record["rationale"] !== "string" || record["rationale"].trim() === "")) {
        structuredFailures.push({ itemIndex, field: "rationale", code: "DECISION_REASON_REQUIRED", message: "author_decision_required needs a decision reason" });
      }
      const rawCommentRefs = record["commentRefs"] ?? (params.commentAliases === undefined && typeof record["instructionId"] === "string" ? [record["instructionId"]] : []);
      if (params.commentAliases !== undefined && record["instructionId"] !== undefined && record["commentRefs"] === undefined) {
        structuredFailures.push({ itemIndex, field: "commentRefs", code: "COMMENT_ALIAS_REQUIRED", message: "Use commentRefs aliases; canonical comment IDs are not accepted in Planner output" });
      }
      let resolvedCommentRefs: string[] = [];
      if (Array.isArray(rawCommentRefs)) {
        try { resolvedCommentRefs = rawCommentRefs.every((id) => typeof id === "string" && /^C\d+$/i.test(id.trim()))
          ? resolvePlannerRefs(rawCommentRefs as string[], commentAliasList, "C")
          : rawCommentRefs as string[]; } catch { resolvedCommentRefs = rawCommentRefs as string[]; }
      }
      const instructionId = resolvedCommentRefs.find((id) => validInstructions.has(id));
      if (Array.isArray(rawCommentRefs) && rawCommentRefs.length > 0 && instructionId === undefined) {
        structuredFailures.push({ itemIndex, field: "commentRefs", code: "INVALID_COMMENT_LINK", message: `Choose comment references from ${commentAliasList.map((item) => item.ref).join(",")}` });
      }
      const plannedItem: ImprovementPlanItem = {
        section,
        action,
        actionType,
        ...(logicalSection ? { logicalSection } : {}),
        ...(coverageQuote ? { coverageQuote } : {}),
        ...(protocolId !== "" ? { protocolId } : {}),
        ...(typeof record["rationale"] === "string" && record["rationale"].trim() !== ""
          ? { rationale: record["rationale"].trim() }
          : {}),
        priority,
        // 确定性校验：id 必须存在于系统清单，模型自造 id 一律剥离
        ...(instructionId !== undefined
          ? { instructionId }
          : {}),
        ...(Array.isArray(rawEvidenceRefs) ? { relatedEvidenceIds: linkedEvidenceIds } : {}),
        ...(Array.isArray(record["expectedFactChanges"])
          ? {
              expectedFactChanges: record["expectedFactChanges"]
                .filter(
                  (change): change is { before: string; after: string; basis?: string } =>
                    typeof change === "object" &&
                    change !== null &&
                    typeof (change as Record<string, unknown>)["before"] === "string" &&
                    typeof (change as Record<string, unknown>)["after"] === "string",
                )
                .slice(0, 6),
            }
          : {}),
      };
      const linkedCommentIds = resolvedCommentRefs.filter((id) => validInstructions.has(id));
      if (linkedCommentIds.length > 1) {
        for (const id of linkedCommentIds.slice(0, Math.max(0, 20 - items.length))) items.push({ ...plannedItem, instructionId: id });
      } else {
        items.push(plannedItem);
      }
    }
    // 模型输出不能决定外部意见是否从计划中消失。对每条未链接意见补一个
    // 保守的人工决策项；它明确禁止 Writer 推测、补实验或改论文事实。
    const linkedInstructions = new Set(
      items.flatMap((item) => (item.instructionId === undefined ? [] : [item.instructionId])),
    );
    for (const instruction of params.externalInstructions ?? []) {
      // M11.4 Reliability Closure（Run H 实证：p-32bc3d63d06a，模型恰好用满
      // 20 条上限，R4 未被链接 → 旧的 items.length>=20 守卫把兜底条目静默
      // 丢弃 → 意见 pending → 任务层 FAIL。「外部意见不得从计划中消失」是
      // 机器不变量，兜底不受模型条目上限约束（20 条上限只限模型输出）。
      if (linkedInstructions.has(instruction.instructionId)) {
        continue;
      }
      items.push({
        section: params.sectionFiles[0] ?? "main.tex",
        action:
          `作者决策必需：${instruction.text}。当前计划未能提出有证据支持的安全修改；` +
          "本轮不得据此改写论文、补造结果或推断事实，等待作者提供材料或决定。",
        // M11.4 Reliability Closure（8c 实证：p-85d7749054b9 R1/R3）：兜底条目
        // 由机器生成，actionType 是机器自有字段，必须随条目一起落盘——缺失时
        // collectRevisionDirectives 按未识别类型跳过，意见被记 plain unresolved
        // 而非合法 author_decision 闭环，翻转任务层 verdict。
        actionType: "author_decision_required",
        rationale: `外部意见 ${instruction.instructionId} 未被模型计划覆盖；保留其可追踪状态，防止意见静默丢失。`,
        priority: "high",
        instructionId: instruction.instructionId,
        relatedEvidenceIds: [],
        expectedFactChanges: [],
      });
      linkedInstructions.add(instruction.instructionId);
    }
    if (items.length === 0) {
      throw new AgentRunFailedError("改进计划：没有合法条目");
    }
    if (structuredFailures.length > 0) {
      const attempts = params.structuredRepair?.attempts ?? 0;
      if (attempts >= 2) {
        throw new BusinessError("MODEL_REPAIR_EXHAUSTED", `STRUCTURED_OUTPUT_REPAIR_EXHAUSTED: ${JSON.stringify(structuredFailures)}`);
      }
      const request = [
        `Original structured output: ${JSON.stringify(parsed["plan"])}`,
        `Validation errors: ${JSON.stringify(structuredFailures)}`,
        `Allowed Evidence references: ${evidenceAliasList.map((item) => item.ref).join(", ") || "(none)"}`,
        `Allowed comment references: ${commentAliasList.map((item) => item.ref).join(", ") || "(none)"}`,
        `Original reviewer comments: ${JSON.stringify(params.issues.map((issue) => ({ section: issue.section, category: issue.category, description: issue.description })))}`,
        "Only use commentRefs from the comment allowlist and evidenceRefs from the evidence allowlist. Do not invent IDs. Repair only the invalid structured fields; do not modify valid intent, action, or target.",
        ...(structuredFailures.some((failure) => failure.code === "FACT_CHANGE_EVIDENCE_REQUIRED")
          ? [
              "FACT_CHANGE_EVIDENCE_REQUIRED has exactly two legal resolutions: (a) add evidenceRefs selecting from the allowed Evidence references that actually support the change, or (b) set expectedFactChanges to [] and change actionType to author_decision_required, keeping section/logicalSection/action and stating the decision need in rationale. Never attach an Evidence reference that does not actually support the change.",
            ]
          : []),
      ].join("\n");
      // FACT_CHANGE_EVIDENCE_REQUIRED 的合法修复不只「补证据」：把无证据支持的
      // 事实变更降级为 author_decision_required（清空 expectedFactChanges）同样
      // 合法且更诚实。这两个字段必须进入可修复集合，否则诚实模型（拒绝伪造
      // evidence 链接）在 repair 通道里无解，bounded repair 构造性不可收敛。
      const invalidFields = Object.fromEntries([...new Set(structuredFailures.map((failure) => failure.itemIndex))].map((index) => [index, [...new Set([
        ...structuredFailures.filter((failure) => failure.itemIndex === index).map((failure) => failure.field === "evidenceRefs" ? "relatedEvidenceIds" : failure.field),
        ...(structuredFailures.some((failure) => failure.itemIndex === index && failure.code === "FACT_CHANGE_EVIDENCE_REQUIRED")
          ? ["expectedFactChanges", "actionType", "rationale"]
          : []),
      ])]]));
      const originalPlan = params.structuredRepair?.originalPlan ?? rawPlanValue.slice(0, 20);
      const previouslyAllowed = params.structuredRepair?.invalidFields ?? {};
      const mergedInvalidFields = { ...previouslyAllowed };
      for (const [index, fields] of Object.entries(invalidFields)) {
        const numericIndex = Number(index);
        mergedInvalidFields[numericIndex] = [...new Set([...(mergedInvalidFields[numericIndex] ?? []), ...fields])];
      }
      this.log(`[writer] projectId=${params.projectId} Planner structured repair attempt=${attempts + 1} failures=${JSON.stringify(structuredFailures)}`);
      return this.planImprovement({ ...params, structuredRepair: { request, attempts: attempts + 1, originalPlan, invalidFields: mergedInvalidFields } });
    }
    return { items };
  }
}

export interface ImprovementPlanItem {
  /**
   * M11.4 Reliability Closure：持久化时由机器赋的稳定条目 id
   * （improvement:N，N = 落盘序）。派发指令 / 意见 resolutionTrace /
   * patch planItemIds 共用同一 id 空间（8c 实证：trace 用全量序、派发用
   * actionable 序，同号不同条，lineage 错位）。模型不产出该字段。
   */
  id?: string;
  section: string;
  action: string;
  actionType?: "modify" | "noop" | "author_decision_required";
  logicalSection?: string;
  coverageQuote?: string;
  protocolId?: string;
  rationale?: string;
  priority: "high" | "medium" | "low";
  /** M10.3：对应外部意见 id（确定性校验通过后保留） */
  instructionId?: string;
  /** M10.3：依据证据 id（确定性校验通过后保留） */
  relatedEvidenceIds?: string[];
  /** M10.3：授权的事实数值变更（Fact Preservation 的计划授权通道） */
  expectedFactChanges?: { before: string; after: string; basis?: string }[];
}

export interface ImprovementPlan {
  items: ImprovementPlanItem[];
}

/**
 * M11.4 Reliability Closure（Run 1 实证：p-c923662f9c48 improvement:11/12/14）：
 * Planner 把「由作者确认 X 后二选一写明」的作者决策语义写进 modify 条目的
 * action 文本 → Writer 无从裁决，只能把【待作者确认】问句实体写进正文 →
 * 修订引入违规、任务层 FAIL。actionType 合法性是机器可判定约束：modify 的
 * 执行不得依赖作者输入，凡 action 文本点名需要作者确认 / 裁决的条目确定性
 * 重分类为 author_decision_required（保留原文；不派发 Writer，意见走合法
 * 作者裁决闭环）。§13：模型给 intent proposal，machine resolve actionType。
 */
const AUTHOR_INPUT_REQUIRED_PATTERN = /(待|需|由)作者确认|待作者(裁决|决定|选择|提供|补[充充])/;

export function reclassifyAuthorInputActions<T extends { action: string; actionType?: string }>(items: readonly T[]): T[] {
  return items.map((item) =>
    item.actionType === "modify" && AUTHOR_INPUT_REQUIRED_PATTERN.test(item.action)
      ? { ...item, actionType: "author_decision_required" as const }
      : item,
  );
}

/**
 * M9.7.6 §7：Unsupported Claim Repair Context 渲染。
 * 每条 UNSUPPORTED / CONTRADICTED claim 附候选 Verified Evidence（claim +
 * 引文 + cite key）与三动作处置规则（SUPPORT / WEAKEN / REMOVE）；候选为空时
 * 只允许 WEAKEN / REMOVE。红线与既有修订规则（事实冻结 / 引用保持）叠加，
 * 不是替代——Evidence ID 只出现在 prompt（Agent Harness 内部 grounding
 * contract），正文永远只允许 \cite{key}，不得出现 [E###] / [c-###] 标记。
 */
function renderClaimRepairBlock(repairs: readonly ClaimRepairDirective[]): string[] {
  if (repairs.length === 0) {
    return [];
  }
  const blocks = repairs.map((repair) => {
    const candidates =
      repair.candidates.length > 0
        ? repair.candidates.map(
            (candidate) =>
              `   - [${candidate.evidenceId}]${candidate.citationKey !== undefined ? `（cite: ${candidate.citationKey}）` : ""} ${candidate.claim.slice(0, 150)}${
                candidate.quote !== undefined ? `（引文："${candidate.quote.slice(0, 120)}"）` : ""
              }`,
          )
        : ["   - （无足够相关的已核验证据：本条只能 WEAKEN 或 REMOVE）"];
    return [
      `- [${repair.claimId}]（verdict: ${repair.verdict}；位置：${repair.section}）论断原文：${repair.claim.slice(0, 300)}`,
      "  候选 Verified Evidence（系统按相关性给出，仅供判断；引用只使用行内 cite key）：",
      ...candidates,
    ].join("\n");
  });
  return [
    "",
    "===== Unsupported Claim Repair（证据感知修订；逐条处置）=====",
    ...blocks,
    "处置规则（每条三选一，按候选证据的实际支撑范围决定）：",
    "1. SUPPORT——某条候选证据确实支撑该论断：用该证据重写论断（范围 / 数值 / 限定词以证据为准，不得扩大），并 \\cite 其行内 cite key；",
    "2. WEAKEN——证据只支撑一部分：降低表述强度，只保留被支撑的部分；",
    "3. REMOVE——没有证据支撑：删除该具体论断（可保留无争议的背景性叙述）。",
    "红线：不得为此新增数字、年份、实验结果、bibliography key 或任何未经核验的具体事实；正文不得出现 [E###] / [c-###] 之类证据标记（它们是内部编号，只允许 \\cite）。",
  ];
}

function buildStylePolishPrompt(params: {
  section: OutlineSection;
  currentLatex: string;
  items: RevisionPlanItem[];
  protectedTerms: string[];
  bibliographyKeys: string[];
}): string {
  const inventory = protectedInventory(params.currentLatex);
  const isAbstract = params.section.id === "abstract";
  return [
    `你是一名学术论文写手（Writer）。这是一次 **style-only 语言润色**：只改善论文${isAbstract ? "摘要" : `章节「${params.section.title}」`}中下列指定位置的中文学术表达，不做任何其他修改。`,
    "",
    "输出要求：",
    isAbstract
      ? "1. 只输出润色后的摘要纯文本；不要 LaTeX 命令、不要解释。"
      : "1. 只输出润色后的该章节完整 LaTeX 正文片段（\\section 起）；不要文档骨架、不要解释、不要 Markdown 围栏。",
    "2. 只修改下列「语言风格问题」指向的句子及为保持通顺所需的最小上下文；其余内容逐字保留。",
    "3. 绝对不得改变：数值（含小数位 / 百分比 / 区间）与单位、表格事实、数学公式与符号、\\cite 的 key 集合、\\ref / \\label / \\eqref、\\begin / \\end 环境、专业术语、否定关系（不 / 未 / 无 / 并非 / 不显著 …）、比较方向（高于 / 低于 / 优于 / 差于 / 增加 / 降低 …）、因果方向、结论强度（可能 / 表明 / 证明 不互换）。",
    "4. 不得新增任何事实、数字、例子、引用、实验或结论；不得删除任何承载事实的句子；不得改变段落顺序与章节结构。",
    "5. 不追求「像人写的」：不加第一人称、个人感受、题外话、口语；只追求清晰、准确、术语一致的中文学术表达。",
    "6. 如果某条问题无法在不触及第 3 / 4 条的前提下修改，就原样保留该句。",
    "7. 只允许引用以下参考文献 key（且集合必须与当前内容完全一致）：" +
      (params.bibliographyKeys.length > 0 ? params.bibliographyKeys.join(", ") : "（当前无引用：不要使用 \\cite）"),
    "",
    "===== 受保护内容清单（润色后必须逐项保持）=====",
    `citation key：${inventory.citationKeys.length > 0 ? inventory.citationKeys.join(", ") : "（无）"}`,
    `数字 / 单位：${inventory.numbers.length > 0 ? inventory.numbers.join("、") : "（无）"}`,
    `数学片段：${inventory.mathSegments} 段（内容不得改动）`,
    `LaTeX 结构：${inventory.structure.length > 0 ? inventory.structure.join(" ") : "（无）"}`,
    `受保护术语：${params.protectedTerms.length > 0 ? params.protectedTerms.join("、") : "（未提供 glossary；沿用当前内容中的术语，不得替换为近义词）"}`,
    "",
    "===== 语言风格问题（只处理这些）=====",
    ...params.items.map(
      (item) => `- [${item.id}] ${item.problem}（改法：${item.instruction}）`,
    ),
    "",
    `===== ${isAbstract ? "当前摘要" : "本章节当前内容"} =====`,
    params.currentLatex.slice(0, 12_000),
  ].join("\n");
}

function buildRepairPrompt(params: {
  sectionFile: string;
  currentLatex: string;
  buildError: string;
  diagnostics: { file: string | null; line: number | null; message: string; contextLines: string[] }[];
}): string {
  return [
    `你是一名 LaTeX 编辑。论文章节文件「${params.sectionFile}」存在编译错误，请修复它。`,
    "",
    "输出要求：",
    "1. 只输出修复后的该章节完整 LaTeX 正文片段；不要文档骨架、不要解释。",
    "2. 只做让编译通过所需的最小修改（修正语法 / 未定义命令 / 环境配对 / 数学模式）。",
    "3. 不改变论述内容，不增删 \\cite 引用，不新增宏包或参考文献。",
    "4. 可用宏包只有 amsmath / amssymb / natbib；诊断指向 tikz 等未定义环境时，"
      + "把该环境整体替换为文字描述或删除（前导不会为它加包）。",
    "",
    "===== 编译错误摘要 =====",
    params.buildError.slice(0, 500),
    "",
    "===== 结构化诊断（文件 / 行号 / 错误 / 附近行）=====",
    ...(params.diagnostics.length > 0
      ? params.diagnostics.map(
          (diagnostic) =>
            `- ${diagnostic.file ?? "(未定位)"}${diagnostic.line !== null ? `:${diagnostic.line}` : ""} ${diagnostic.message}` +
            (diagnostic.contextLines.length > 0 ? `（附近：${diagnostic.contextLines.join(" ⏎ ").slice(0, 200)}）` : ""),
        )
      : ["（诊断未解析出行号；按错误摘要定位）"]),
    "",
    "===== 本章节当前内容 =====",
    params.currentLatex.slice(0, 12_000),
  ].join("\n");
}

/**
 * M6.7 §12：结构化 Revision Item 渲染（Writer 直接读取计划条目）。
 * 每条携带 id / kind / 风险档位 / 修改要求与「修改前依据的证据」——
 * Revision ≠ Correct Revision：修改后的表述必须仍被关联证据支撑，
 * 支撑不住就弱化，不允许顺势升级结论强度。
 */
function renderRevisionItemsBlock(
  items: readonly RevisionPlanItem[],
  evidenceById: Map<string, EvidenceRecord> | undefined,
): string[] {
  if (items.length === 0) {
    return [];
  }
  const lines = items.map((item) => {
    const constraints: string[] = [];
    if (item.needsEvidence) {
      constraints.push("只能基于现有 Evidence 修改；证据不足时弱化或删除，不允许编造");
    }
    if (item.riskLevel === "high") {
      constraints.push("高风险条目：不得改动实验数值 / 既有引用 / 结论方向");
    }
    const related = (item.relatedEvidenceIds ?? []).map((id) => {
      const record = evidenceById?.get(id);
      return record !== undefined ? `[${id}] ${record.claim.slice(0, 100)}` : `[${id}]（证据库中不可用：按无证据处理）`;
    });
    // M11.2.3（D-4 §15）：mustPreserve 前置约束——目标章节的事实 / 引用基线
    // 投影（已剔除授权改动的值）。Writer 改前就知道哪些绝对不能动。
    const mustPreserveLines: string[] = [];
    if (item.mustPreserve?.values !== undefined && item.mustPreserve.values.length > 0) {
      mustPreserveLines.push(`  绝对不可变动的数值（改写前后逐字保留）：${item.mustPreserve.values.join("、")}`);
    }
    if (item.mustPreserve?.citationKeys !== undefined && item.mustPreserve.citationKeys.length > 0) {
      mustPreserveLines.push(`  绝对不可移除的引用（本条目修改不得丢弃）：\\cite{${item.mustPreserve.citationKeys.slice(0, 12).join(", ")}${item.mustPreserve.citationKeys.length > 12 ? ", …" : ""}}`);
    }
    return [
      `- [${item.id}]（${item.kind}${item.riskLevel !== undefined ? ` / risk=${item.riskLevel}` : ""}）${item.problem}`,
      `  修改要求：${item.instruction}`,
      ...(constraints.length > 0 ? [`  约束：${constraints.join("；")}`] : []),
      ...mustPreserveLines,
      ...(related.length > 0
        ? [`  修改前该论述依据的证据（修改后表述必须仍被其支撑，否则弱化）：${related.join("；")}`]
        : []),
    ].join("\n");
  });
  return ["", "===== 修订计划条目（结构化；逐条落实，修改后将逐条复核）=====", ...lines];
}

export function buildRevisePrompt(params: {
  section: OutlineSection;
  outline: Outline;
  currentLatex: string;
  issues: ReviewIssue[];
  evidence: EvidenceRecord[];
  bibliography: BibliographyEntryInput[];
  buildError?: string;
  language?: ManuscriptLanguage;
  extraInstructions?: string;
  externalDirectives?: ExternalDirectiveDispatch[];
  claimRepairs?: ClaimRepairDirective[];
  revisionItems?: RevisionPlanItem[];
  /** revisionItems 关联证据的只读索引（M6.7 §6：修改前依据的渲染源） */
  evidenceById?: Map<string, EvidenceRecord>;
  /**
   * M10.3：单文件 LaTeX 项目的整文件修订目标（main.tex = 用户全部内容）。
   * 输出契约变为「修改后的完整文件」（含导言区），不按章节片段口径校验。
   */
  wholeFile?: boolean;
  /** M11.2 Survey：本节写作上下文（综述结构红线；缺省不注入） */
  survey?: SurveySectionWritingContext;
  patchRepairContext?: string;
}): string {
  const external = params.externalDirectives ?? [];
  const externalRules =
    external.length > 0
      ? [
          "",
          "外部意见执行规则：",
          "a. 下方「外部修改意见」区块的意见（用户 / 期刊专家 / 导师）是最高业务优先级，先于内部审稿问题处理；内部意见与其冲突时以外部意见为准（内部建议可暂缓）。",
          "b. 外部意见不得突破上述任何事实与证据约束：意见要求与稿件实验事实 / Evidence 冲突时（如要求「说明优势」而表格数据不支持），保留事实——不伪造数字、不篡改表格、不美化负结果——报告 conflict 并在 basis 中引用稿件的具体数值 / 结论。",
          "c. 意见未指定章节且与本节内容无关时：本节保持原样，报告 not_applicable。",
          "d. 可执行的替代方向：解释性能边界、分析失效原因；不得为了让意见成立而新增或修改实验数字。",
          "e. 输出的最后一行必须单独一行执行报告（单行 JSON 数组，不要代码块）：",
          `   ${EXTERNAL_OUTCOMES_MARKER} [{"instructionId":"<id>","outcome":"applied|conflict|not_applicable","basis":"<依据：conflict 必填，引用稿件具体数值>"}]`,
          "   每条派发意见恰好一项；applied 只在本节真实修改时使用，不得为提高完成率虚报。",
          "f. 弱化论断 = 修改该论断本身（或删除）；不得新增与稿内未弱化旧论断并存的反向 / 对冲表述（自相矛盾会被复审判 blocking）。修订说明 / 决策点 / 待作者确认等执行注记只允许出现在最后的执行报告行，绝对不得写进正文。",
        ]
      : [];
  const externalBlock =
    external.length > 0
      ? [
          "",
          "===== 外部修改意见（最高业务优先级）=====",
          ...external.flatMap((directive) => [
            `--- 意见 ${directive.instructionId}（${directive.reviewerLabel ?? directive.source}${
              directive.section !== undefined ? `；指定章节：${directive.section}` : "；未指定章节"
            }）---`,
            directive.text,
          ]),
        ]
      : [];
  // 摘要目标（M4.8）：载体是 outline.abstract 纯文本，不是 LaTeX 片段
  if (params.section.id === "abstract") {
    return [
      "你是一名学术论文写手（Writer）。请修订论文摘要（abstract）。",
      "",
      ...targetLanguageLines(params.language),
      ...(params.language !== undefined ? [""] : []),
      "输出要求：",
      "1. 只输出修订后的摘要纯文本（100–200 字）；不要 LaTeX 命令、不要解释。",
      "2. 逐条解决下列针对摘要的问题；无法用现有 Evidence 支撑的论断必须弱化或删除。",
      "3. 摘要是纯文本：不使用任何 LaTeX 命令、宏包或数学环境。",
      ...(external.length > 0
        ? [
            `4. 外部修改意见（见下方区块）优先处理，但不得虚构数字或结论：与事实冲突时保留事实，报告行给 conflict 与依据；${EXTERNAL_OUTCOMES_MARKER} 报告行必须是输出的最后一行。`,
          ]
        : []),
      ...externalRules,
      "",
      "===== 当前摘要 =====",
      params.currentLatex.slice(0, 4000),
      "",
      "===== 针对摘要的问题 =====",
      ...(params.issues.length > 0
        ? params.issues.map(
            (issue) =>
              `- [${issue.severity}${issue.blocking ? "/blocking" : ""}] ${issue.description}` +
              (issue.suggestedAction ? `（建议：${issue.suggestedAction}）` : ""),
          )
        : ["（无审稿问题）"]),
      ...renderRevisionItemsBlock(params.revisionItems ?? [], params.evidenceById),
      ...renderClaimRepairBlock(params.claimRepairs ?? []),
      ...(params.patchRepairContext !== undefined ? ["", "===== Patch-local validation repair =====", params.patchRepairContext] : []),
      ...externalBlock,
      "",
      "===== Verified Evidence Context（已核验 verified 证据，引用第一优先来源）=====",
      ...renderEvidenceLines(params.evidence, params.bibliography, 15),
      `（${EVIDENCE_QUERY_GUIDANCE}）`,
    ].join("\n");
  }
  return [
    `你是一名学术论文写手（Writer）。请修订论文章节「${params.section.title}」。`,
    "",
    ...targetLanguageLines(params.language),
    ...(params.language !== undefined ? [""] : []),
    "输出要求：",
    ...(params.wholeFile === true
      ? [
          "1. 本目标是**单文件完整稿件**（main.tex 即全部内容）：输出修改后的完整 LaTeX 文件（含 \\documentclass 导言区到 \\end{document}）；不要解释、不要代码围栏。只修改问题指向的位置及保持连贯所需的最小上下文，导言区与其余章节内容逐字保留（除非问题明确指向它们）。",
          "1b. **交付方式契约**：修改后的完整文件内容必须出现在你的**最终回复消息**里（正文输出）。不要改用 write/edit 工具直接改写文件来替代交付——只有最终消息会被采纳为修订结果；最终消息为空将被判失败。",
        ]
      : [
          "1. 只输出修订后的当前 target 内容片段；不要文档骨架、不要解释。",
          "1a. 修改边界严格限于当前 target。不得改动其他章节、摘要、数字、公式、citation、figure/table 或方法描述；仅当本条计划明确授权且给出依据时才可触及对应内容。只需改一句时，只改那一句及必要的语法衔接。",
        ]),
    "2. 这是一次**受限修订（revision）**，不是重写：逐条解决下列针对本章节的问题，只修改问题指向的位置及保持连贯所需的最小上下文；其余内容逐字保留。",
    "3. **实验事实默认冻结**：当前稿件中的实验数值（含小数位 / 百分比 / 区间 / 单位）、表格内容、"
      + "数据集划分、训练与评测协议、硬件与部署配置、超参数、公式（数学环境内容）必须原样保留，"
      + "除非某条问题明确要求修正该项且给出了新值依据。",
    "4. 发现疑似数值错误而问题清单未授权修改时：**保留原值**，不要自行改正、补全、推测或重新计算。"
      + "无法用现有 Evidence 支撑的**论断**可以弱化或删除表述，但已有具体实验事实（数字 / 表格 / 协议）"
      + "不得因此改成「待回填」「待补充」等占位或模糊区间。",
    "5. 负结果与性能短板不得美化：方法在某场景更差 / 更慢 / 更耗时的事实陈述保持原方向，"
      + "不得改写为「保持优势」「基本一致」等相反结论；与稿件事实冲突的 Evidence 以稿件事实为准并在问题清单外不动。",
    "6. 不得新增本章节当前内容与问题清单中都不存在的实验细节、数字、超参数或因果解释。"
      + "当稿件内容与 Evidence 不一致时，不要虚构或静默调和——报告冲突（保留原表述）。",
    "7. 学术语言优化不得改变 claim 强度（可能 / 表明 / 证明 不互换）与比较方向（高于 / 低于 / 优于 / 劣于 不互换）。",
    "7b. 弱化论断 = 修改该论断本身（或删除）；不得新增与稿内未弱化旧论断并存的反向 / 对冲表述（自相矛盾会被复审判 blocking）。",
    "7c. 【修订说明】【决策点】【待作者确认】等执行注记与 %%%PT-OUTCOMES%%% 报告行**绝不允许写进正文**——它们只属于输出末尾的执行报告（无外部意见派发时不要输出报告行）；裸希腊字母/下标写进正文还会导致编译失败。",
    "8. 可用宏包只有 amsmath / amssymb / natbib（ctexart 文档类）；不要使用 tikz 等"
      + "其他宏包的环境或命令（图形以文字描述或 table 呈现），否则无法编译。",
    "9. 引用纪律（只允许引用以下参考文献 key；按 verified evidence 支撑分组）：",
    ...renderCitationDisciplineLines(params.evidence, params.bibliography),
    "   - 修订特则：本章节现有的 B 组引用按第 10/11 条保留（不因缺证据而删除）；但不得新增 B 组引用，也不得把原本 A 组支撑的论断改由 B 组支撑。",
    "10. 保留本章节现有的 \\cite 引用及其所支撑的论述（除非某条问题明确要求删除该引用）；不得为了精简而整体删光引用，也不得新增列表之外的 key。",
    ...renderCitationFreezeLines(params.currentLatex),
    ...CLAIM_DISCIPLINE_LINES,
    ...(params.buildError
      ? ["12. 上一轮编译失败，错误摘要（必须修复）：" + params.buildError]
      : []),
    ...externalRules,
    ...(params.extraInstructions ? ["", "补充要求：", params.extraInstructions] : []),
    "",
    "===== 本章节当前内容 =====",
    // M10.3：单文件整文件修订不截断（截断 = 丢失保留义务，Writer 无法逐字保留）
    params.wholeFile === true ? params.currentLatex : params.currentLatex.slice(0, 12_000),
    "",
    "===== 针对本章节的问题 =====",
    ...(params.issues.length > 0
      ? params.issues.map(
          (issue) =>
            `- [${issue.severity}${issue.blocking ? "/blocking" : ""}] ${issue.description}` +
            (issue.suggestedAction ? `（建议：${issue.suggestedAction}）` : ""),
        )
      : ["（无审稿问题）"]),
    ...renderRevisionItemsBlock(params.revisionItems ?? [], params.evidenceById),
    ...renderClaimRepairBlock(params.claimRepairs ?? []),
    ...(params.patchRepairContext !== undefined ? ["", "===== Patch-local validation repair =====", params.patchRepairContext] : []),
    ...externalBlock,
    ...(params.survey !== undefined ? renderSurveyRevisionConstraints(params.survey) : []),
    "",
    "===== Verified Evidence Context（已核验 verified 证据，引用第一优先来源）=====",
    ...renderEvidenceLines(params.evidence, params.bibliography, 15),
    `（${EVIDENCE_QUERY_GUIDANCE}）`,
  ].join("\n");
}

/**
 * 分离 Writer 输出中的外部意见执行报告行（M5.7）：
 * - 标记行（EXTERNAL_OUTCOMES_MARKER 开头）之后同行是单行 JSON 数组；
 * - 标记行之前的内容是 LaTeX 正文（调用方再走既有校验）；
 * - 未派发外部意见时 outcomes = undefined（行为与旧版一致）；
 * - 派发了但报告缺失 / 非法的条目以 unreported 如实补齐（不采信也不丢弃）。
 */
export function splitExternalOutcomes(
  raw: string,
  dispatched: ExternalDirectiveDispatch[],
): { latex: string; outcomes: ExternalOutcomeReport[] | undefined } {
  if (dispatched.length === 0) {
    return { latex: raw, outcomes: undefined };
  }
  const lineIndex = raw
    .split(/\r?\n/)
    .findIndex((line) => line.trim().startsWith(EXTERNAL_OUTCOMES_MARKER));
  if (lineIndex < 0) {
    return {
      latex: raw,
      outcomes: dispatched.map((directive) => ({
        instructionId: directive.instructionId,
        outcome: "unreported",
      })),
    };
  }
  const lines = raw.split(/\r?\n/);
  // M10.3.1：模型会把执行报告行放在输出**最前面**（先上报后交付）——此时
  // 「marker 之前取正文」得到空串（整文件修订被判空内容）。前缀为空时改取
  // marker 行之后的内容为正文（残留 marker 行由 stripStrayOutcomeLines 剥离）。
  const before = lines.slice(0, lineIndex).join("\n");
  const latex = before.trim() === "" ? lines.slice(lineIndex + 1).join("\n") : before;
  const reportLine = lines[lineIndex] ?? "";
  const jsonPart = reportLine.trim().slice(EXTERNAL_OUTCOMES_MARKER.length).trim();
  const parsed = parseOutcomeArray(jsonPart, dispatched);
  const reported = new Set(parsed.map((report) => report.instructionId));
  const outcomes: ExternalOutcomeReport[] = [
    ...parsed,
    ...dispatched
      .filter((directive) => !reported.has(directive.instructionId))
      .map((directive) => ({ instructionId: directive.instructionId, outcome: "unreported" as const })),
  ];
  return { latex, outcomes };
}

/** 报告行 JSON 数组的防御性解析：非法条目丢弃（对应意见走 unreported 兜底） */
function parseOutcomeArray(
  jsonPart: string,
  dispatched: ExternalDirectiveDispatch[],
): ExternalOutcomeReport[] {
  if (jsonPart === "") {
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(jsonPart);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const known = new Set(dispatched.map((directive) => directive.instructionId));
  const reports: ExternalOutcomeReport[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const instructionId = typeof record["instructionId"] === "string" ? record["instructionId"] : undefined;
    const outcome = record["outcome"];
    if (
      instructionId === undefined ||
      !known.has(instructionId) ||
      (outcome !== "applied" && outcome !== "conflict" && outcome !== "not_applicable")
    ) {
      continue;
    }
    const basis = typeof record["basis"] === "string" ? record["basis"].trim().slice(0, 600) : undefined;
    reports.push({
      instructionId,
      outcome: outcome as Exclude<ExternalOutcomeKind, "unreported">,
      ...(basis !== undefined && basis !== "" ? { basis } : {}),
    });
  }
  return reports;
}

/**
 * 剥离输出中残留的 PT-OUTCOMES 协议标记行（M9.10 Phase 1）。
 * splitExternalOutcomes 只在「本目标派发过外部意见」时分离报告行；GLM-5.3 会
 * 在无派发时也自发上报（把 RevisionPlanItem id 当 instructionId，m910 E2E rev3
 * 实录三处泄漏），协议行连同 JSON 进入正文——其中的数字片段（verified=0、
 * id 尾串）会被 Fact Preservation 判为 added_number。协议行不可能是合法
 * LaTeX 内容，统一防御性剥离。
 */
export function stripStrayOutcomeLines(latex: string): string {
  return latex
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith(EXTERNAL_OUTCOMES_MARKER))
    .join("\n");
}

/** 解析大纲 sections 数组（防御性）；surveyRefs=true 时解析 M11.1.3 refs 字段 */
function readOutlineSections(
  parsed: Record<string, unknown>,
  options: { surveyRefs?: boolean } = {},
): OutlineSection[] {
  const value = parsed["sections"];
  if (!Array.isArray(value)) {
    return [];
  }
  const parseRefList = (raw: unknown): string[] | undefined => {
    if (!Array.isArray(raw)) {
      return undefined;
    }
    const refs = [
      ...new Set(
        raw
          .filter((ref): ref is string => typeof ref === "string" && ref.trim() !== "")
          .map((ref) => ref.trim()),
      ),
    ].sort();
    return refs.length > 0 ? refs : undefined;
  };
  const sections: OutlineSection[] = [];
  for (const raw of value.slice(0, 20)) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const record = raw as Record<string, unknown>;
    if (typeof record["id"] !== "string" || typeof record["file"] !== "string") {
      continue;
    }
    const synthesisRefs = options.surveyRefs ? parseRefList(record["synthesisRefs"]) : undefined;
    const literatureRefs = options.surveyRefs ? parseRefList(record["literatureRefs"]) : undefined;
    sections.push({
      id: record["id"].trim().toLowerCase().replaceAll(/[^a-z0-9-]/g, "-").slice(0, 40),
      file: record["file"].trim().toLowerCase(),
      ...(typeof record["title"] === "string" ? { title: record["title"].trim() } : { title: record["id"] }),
      ...(typeof record["targetLengthWords"] === "number"
        ? { targetLengthWords: Math.max(50, Math.min(5000, Math.round(record["targetLengthWords"]))) }
        : {}),
      ...(Array.isArray(record["keyPoints"])
        ? {
            keyPoints: record["keyPoints"]
              .filter((point): point is string => typeof point === "string" && point.trim() !== "")
              .slice(0, 10)
              .map((point) => point.trim()),
          }
        : {}),
      ...(synthesisRefs !== undefined ? { synthesisRefs } : {}),
      ...(literatureRefs !== undefined ? { literatureRefs } : {}),
    });
  }
  return sections;
}

/** 粗粒度花括号配对检查（忽略 \{ 转义） */
function hasBalancedBraces(latex: string): boolean {
  let depth = 0;
  for (let index = 0; index < latex.length; index += 1) {
    const ch = latex[index];
    if (ch === "\\") {
      index += 1; // 跳过转义字符
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0;
}

export function buildOutlinePrompt(params: {
  researchDigest: {
    domainOverview: string;
    researchGaps: string[];
    potentialContributions: string[];
  };
  evidence: EvidenceRecord[];
  bibliography: BibliographyEntryInput[];
  targetProfile?: string;
  documentType?: string;
  language?: ManuscriptLanguage;
  feedback?: string;
}): string {
  return [
    "你是一名学术论文写手（Writer）。请基于调研结果与 Evidence 规划论文大纲（只规划，不写正文）。",
    "",
    "只输出一个 JSON 对象（不要 Markdown 围栏），字段：",
    '{"title": "论文标题", "abstract": "摘要（100-200 字）",',
    ' "sections": [{"id": "introduction", "file": "introduction.tex", "title": "引言",',
    '   "targetLengthWords": 400, "keyPoints": ["要点 1"]}],',
    ' "references": []}',
    "",
    ...targetLanguageLines(params.language),
    ...(params.language !== undefined ? [""] : []),
    "要求：",
    "1. sections 至少 4 节（含 introduction 与 conclusion），至多 12 节；file 使用小写字母数字连字符加 .tex。",
    "2. 大纲必须与研究空白、潜在贡献对应；Evidence 不足的章节在 keyPoints 中明确标注「证据不足」。",
    "3. 引用纪律（可引用的参考文献 key 按 verified evidence 支撑分组；正文写作时事实性论断必须取 A 组）：",
    ...renderCitationDisciplineLines(params.evidence, params.bibliography),
    ...(params.feedback ? ["", "用户对上一版大纲的修改意见（必须落实）：", params.feedback] : []),
    "",
    "===== 调研摘要 =====",
    `领域现状：${params.researchDigest.domainOverview.slice(0, 400)}`,
    `研究空白：${params.researchDigest.researchGaps.slice(0, 5).join("；")}`,
    `潜在贡献：${params.researchDigest.potentialContributions.slice(0, 5).join("；")}`,
    `目标类型：${params.documentType ?? "（未填写）"}；目标档次：${params.targetProfile ?? "（未填写）"}`,
    "",
    "===== Verified Evidence Context（已核验 verified，用于判断哪些论点有支撑）=====",
    ...renderEvidenceLines(params.evidence, params.bibliography, 20),
    ...(params.evidence.length === 0
      ? []
      : [`（${EVIDENCE_QUERY_GUIDANCE}）`]),
  ].join("\n");
}

/**
 * M11.1.3 Survey 大纲 prompt（综述 ≠ 原创论文）：
 * - 章节结构的事实来源是七类 Structured Synthesis（digest 投影），不是
 *   research gaps / potential contributions / 实验设计；
 * - 每个核心 section 返回 synthesisRefs / literatureRefs（逐字复制）；
 * - speculative（含推断型 future_direction）只能进展望语境；
 * - Outline 是组织层：不发明 taxonomy / gap / consensus / future，不新增
 *   digest 之外的文献。
 */
export function buildSurveyOutlinePrompt(params: {
  targetProfile?: string;
  documentType?: string;
  language?: ManuscriptLanguage;
  feedback?: string;
  surveyDigest: SurveyOutlineDigest;
}): string {
  const digest = params.surveyDigest;
  return [
    `你是一名学术论文写手（Writer）。请基于下方「结构化综合（Structured Synthesis）」为一篇综述（survey / review article）规划大纲——主题：${digest.topic}。只规划，不写正文。`,
    "",
    "只输出一个 JSON 对象（不要 Markdown 围栏），字段：",
    '{"title": "综述标题", "abstract": "摘要（100-200 字）",',
    ' "sections": [{"id": "introduction", "file": "introduction.tex", "title": "引言",',
    '   "targetLengthWords": 400, "keyPoints": ["要点"],',
    '   "synthesisRefs": ["SYN-…（逐字复制下方综合产物 digest 中的标识）"],',
    '   "literatureRefs": ["M-S…（逐字复制下方文献清单中的标识）"]}],',
    ' "references": []}',
    "",
    ...targetLanguageLines(params.language),
    ...(params.language !== undefined ? [""] : []),
    "组织纪律（综述大纲最重要的规则）：",
    "1. 这是综述（review article），不是原创算法论文：不要求论证研究空白、不要求潜在贡献 / 创新点、不要求实验设计 / 方法章节。",
    "2. 按方法体系 / 研究问题组织章节，绝不按论文逐篇组织——「论文 A / 论文 B / 论文 C」式章节是错误结构。",
    "3. 章节结构只能来自输入的七类 synthesis：taxonomy 决定方法分类章节的骨架；trend / comparison / consensus / disagreement 决定综合分析章节；research_gap 决定空缺章节；future_direction 决定展望章节。digest 中没有的类（标注「无」）不得发明对应章节。",
    "4. 不发明输入中不存在的内容：不新增 taxonomy 家族、不新增文献、不虚构共识或争议；某个主题 synthesis 不足就不设对应小节。",
    "5. 每个核心正文 section 必须给出 synthesisRefs（本节消费的 synthesisId）与 literatureRefs（本节覆盖的 entryId）——逐字复制，不得改写、不得凭记忆生成。",
    "6. Introduction / Conclusion 等框架章节可不带 refs（若给出也必须真实存在且非 speculative）。",
    "7. speculative 的 synthesis（含推断型 future_direction）只能进入明确的展望 / 未来方向章节；taxonomy / trend / comparison / consensus 等既定结论章节只消费 evidence_backed 或 literature_cited。",
    "8. 文献分布不均衡时在 keyPoints 说明结构依据（如「X 族占多数，拆两个小节」），不强行让章节平均分配文献。",
    "9. sections 至少 4 节（含 introduction 与 conclusion），至多 12 节；file 使用小写字母数字连字符加 .tex。",
    ...(params.feedback ? ["", "用户对上一版大纲的修改意见（必须落实；不得因此违反上述纪律）：", params.feedback] : []),
    "",
    `目标类型：survey（综述）${params.documentType !== undefined ? `（项目登记：${params.documentType}）` : ""}；目标档次：${params.targetProfile ?? "（未填写）"}`,
    "",
    "===== 综合产物 digest（章节结构的事实来源；synthesisRefs 只能从中逐字复制）=====",
    ...renderDigestItems(digest),
    "",
    "===== 文献清单（literatureRefs 的唯一合法候选集）=====",
    ...renderDigestLiterature(digest),
    "",
    "===== 覆盖与分布统计（组织提示，不是硬性配额）=====",
    ...renderDigestStats(digest),
  ].join("\n");
}

/**
 * M9.7.6 大纲结构化修复 prompt（ReviewerService.buildReviewRepairPrompt 同构）：
 * 复用同一 writing/outline 会话，注入上一轮输出与具体校验错误——修复输出协议
 * （严格合法 JSON），不重做大纲规划。显式给出转义规则：真实漂移形态是字符串
 * 值内未转义的 ASCII 双引号（中文术语强调引号），修复时必须转义或改中文引号。
 */
export function buildOutlineRepairPrompt(
  previousOutput: string,
  validationErrors: readonly string[],
): string {
  return [
    "你上一轮的大纲输出未通过结构化校验，需要修复。",
    "",
    "校验错误（逐条修复）：",
    ...validationErrors.map((error) => `- ${error}`),
    "",
    "要求：",
    "1. 保留上一轮输出中已有的大纲内容（title / abstract / sections / keyPoints 一律不重写、不删减），只修复违反校验的部分；synthesisRefs / literatureRefs（如上一轮输出中存在）原样保留、不增不改。",
    "2. 输出必须是严格合法的单个 JSON 对象：字符串值内部不得出现未转义的 ASCII 双引号——中文表述中的强调引号改用「」或转义为 \\\"；不要 Markdown 围栏、不要解释文字。",
    "3. 不要重新执行大纲规划，除非修复校验错误必需。",
    "",
    "===== 上一轮输出 =====",
    previousOutput,
  ].join("\n");
}

export function buildSectionPrompt(params: {
  section: OutlineSection;
  outline: Outline;
  evidence: EvidenceRecord[];
  bibliography: BibliographyEntryInput[];
  styleProfile?: Record<string, unknown>;
  language?: ManuscriptLanguage;
  extraInstructions?: string;
}): string {
  return [
    `你是一名学术论文写手（Writer）。请撰写论文章节「${params.section.title}」。`,
    "",
    ...targetLanguageLines(params.language),
    ...(params.language !== undefined ? [""] : []),
    "输出要求：",
    "1. 只输出该章节的 LaTeX 正文片段：以 \\section{标题} 开始；不要 \\documentclass、\\begin{document}、导言区、文档骨架。",
    "2. 不要用 Markdown 代码块包裹，不要解释文字。",
    "3. 论述必须优先基于下方 Verified Evidence Context（均为已核验 verified 证据；引用时使用行内标注的 cite key）；证据不足时显式弱化表述或标注，不为凑字虚构数据、结论或引用。",
    "4. 引用纪律（只允许引用以下参考文献 key；按 verified evidence 支撑分组）：",
    ...renderCitationDisciplineLines(params.evidence, params.bibliography),
    ...CLAIM_DISCIPLINE_LINES,
    "5. 保持与其他章节的术语一致。",
    ...(params.styleProfile
      ? ["6. 参考论文的结构与呈现模式（只学结构，不复制内容）：" + JSON.stringify(params.styleProfile).slice(0, 600)]
      : []),
    ...(params.extraInstructions ? ["", "补充要求：", params.extraInstructions] : []),
    "",
    "===== 论文大纲（全文结构）=====",
    `标题：${params.outline.title}`,
    ...params.outline.sections.map((section) => `- ${section.title}（${section.id}）`),
    "",
    `===== 本章节要求 =====`,
    `章节：${params.section.title}（${params.section.file}）`,
    `目标长度：约 ${params.section.targetLengthWords ?? 400} 字`,
    ...(params.section.keyPoints?.length
      ? ["要点：", ...params.section.keyPoints.map((point) => `- ${point}`)]
      : []),
    "",
    "===== Verified Evidence Context（已核验 verified 证据，引用第一优先来源）=====",
    ...renderEvidenceLines(params.evidence, params.bibliography, 20),
    ...(params.evidence.length === 0 ? [] : [`（${EVIDENCE_QUERY_GUIDANCE}）`]),
  ].join("\n");
}

/**
 * M11.2 Survey 章节写作 prompt。核心契约（Writer 是表达层，不是第二个
 * Researcher）：研究已经做完（Matrix → Synthesis → Outline），本 prompt 只
 * 提供该节 refs 契约的有界投影；按 synthesis 写而不是按论文写；引用 key
 * 白名单 = context.allowedCitationKeys（输出后有确定性后检，越界即违约）。
 */
export function buildSurveySectionPrompt(params: {
  section: OutlineSection;
  outline: Outline;
  bibliography: BibliographyEntryInput[];
  language?: ManuscriptLanguage;
  survey: SurveySectionWritingContext;
}): string {
  const context = params.survey;
  const evidenceLines = renderEvidenceLines(context.evidence, params.bibliography, 24);
  const allowed = context.allowedCitationKeys;
  const unbacked = allowed.filter((key) => !context.evidenceBackedKeys.includes(key));
  const contextLabel =
    context.sectionContext === "framing"
      ? "框架章节（引言 / 结论 / 背景：只写背景与组织性内容）"
      : context.sectionContext === "gap"
        ? "研究空缺章节（内容只能来自绑定的 research_gap synthesis）"
        : context.sectionContext === "future"
          ? "展望章节（唯一允许消费 speculative synthesis 的章节）"
          : "核心正文章节（按方法体系 / 研究问题综合已有结论）";
  return [
    `你是一名学术论文写手（Writer）。请撰写综述章节「${params.section.title}」。`,
    "",
    ...targetLanguageLines(params.language),
    ...(params.language !== undefined ? [""] : []),
    "输出要求：",
    "1. 只输出该章节的 LaTeX 正文片段：以 \\section{标题} 开始；不要 \\documentclass、\\begin{document}、导言区、文档骨架；不要 Markdown 代码块，不要解释文字。",
    "2. 可用宏包只有 amsmath / amssymb / natbib（ctexart 文档类）；不使用 tikz 等其他宏包的环境或命令。",
    "",
    "综述写作纪律（最重要的规则）：",
    "1. 这是综述（survey）的一节。研究已经完成——下方「综合产物」就是本节全部的事实来源，你的任务是把它表达成论文，不是重新做研究：不发明 taxonomy / 共识 / 分歧 / 研究空缺 / 未来方向，不引入清单之外的文献，不凭模型常识补充「大家都知道」的具体事实（数字、年份、性能结论）。",
    "2. 按 synthesis 组织段落，绝不按论文逐篇组织：「论文 A 做了……论文 B 做了……论文 C 做了……」的连续罗列是错误写法。同类工作合并为按方法家族 / 技术路线的综合描述。",
    "3. 比较内容必须体现 comparison synthesis 给出的维度与两侧依据；趋势内容按时间 / 技术路线组织；consensus 与 disagreement 分开表达，分歧双方都要公平呈现（有双方文献支撑）。",
    "4. research gap 只能来自本节绑定的 research_gap synthesis；不得提出任何 synthesis 中不存在的新 gap。",
    "5. future direction 严格区分：grounded（cited_future_work）可陈述文献明确提出的方向；speculative 只能用推测语气（可能 / 值得探索 / 未来可考虑 / 有待验证），不得写成既定结论。",
    "6. 逐条 synthesis 的措辞强度按其 grounding 分级执行（每条已标注措辞纪律）：evidence_backed 可确定陈述（证据范围内）；literature_cited 只能弱措辞；speculative 只保留不确定性表述。",
    "7. 引用纪律：只允许引用「本节允许的 citation key」清单内的 key（输出会被逐 key 校验，越界即失败）。事实性论断（机制、方法、数值、结论）优先引用 A 组；一个综合结论允许多 key 并列（如 \\cite{a,b,c}）——多源综合结论不得伪装成单篇论文支撑，也不要机械地每句只引 1 篇。",
    "8. 上下文不足以支撑某个具体论断时：保守表述或省略，不脑补；可以用 evidence_query 查询证据库确认，无果就弱化。",
    "",
    ...CLAIM_DISCIPLINE_LINES,
    "",
    "===== 论文大纲（全文结构；本节是其中一节，保持术语一致）=====",
    `标题：${params.outline.title}`,
    ...params.outline.sections.map((section) => `- ${section.title}（${section.id}）`),
    "",
    "===== 本章节要求 =====",
    `章节：${params.section.title}（${params.section.file}）｜${contextLabel}`,
    `目标长度：约 ${params.section.targetLengthWords ?? 500} 字`,
    ...(context.keyPoints.length > 0
      ? ["要点：", ...context.keyPoints.map((point) => `- ${point}`)]
      : []),
    ...(context.warnings.length > 0
      ? ["上下文提示（如实处理，不得掩盖）：", ...context.warnings.map((warning) => `- ${warning}`)]
      : []),
    "",
    "===== 综合产物（本节消费的 Structured Synthesis；章节内容的事实来源）=====",
    ...renderSectionSynthesisLines(context),
    "",
    "===== 本节文献清单（literatureRefs 投影；引用候选已并入上方各组）=====",
    ...renderSectionLiteratureLines(context),
    "",
    "===== 本节允许的 citation key（白名单；A 组 = verified evidence 支撑）=====",
    `A 组（有 verified evidence 支撑；事实性论断的引用必须取自本组）：${
      context.evidenceBackedKeys.length > 0 ? context.evidenceBackedKeys.join(", ") : "（空——事实性论断只能弱化或删除）"
    }`,
    `B 组（文献库条目、无逐字核验证据；仅限文献_cited 口径的泛指性陈述）：${
      unbacked.length > 0 ? unbacked.join(", ") : "（无）"
    }`,
    `全部允许（\\cite 只能用这些 key）：${allowed.length > 0 ? allowed.join(", ") : "（无：本节不要使用 \\cite）"}`,
    "",
    "===== Verified Evidence Context（本节绑定 synthesis 的已核验证据）=====",
    ...evidenceLines,
    ...(context.evidence.length === 0 ? [] : [`（${EVIDENCE_QUERY_GUIDANCE}）`]),
  ].join("\n");
}

/**
 * Writer Prompt（M2 有意保持简单）：
 * 要求完整 LaTeX、中文可用、无 Markdown 围栏、不虚构引用、优先保证可编译。
 */
export function buildWriterPrompt(userPrompt: string): string {
  return [
    "你是一名学术论文写手（Writer）。请根据下面的写作任务撰写一篇简短的学术论文，直接返回完整的 LaTeX 文档。",
    "",
    "要求：",
    "1. 只返回一个完整、可直接编译的 LaTeX 文档：从 \\documentclass 开始，到 \\end{document} 结束。",
    "2. 使用 \\documentclass[UTF8]{ctexart} 支持中文。",
    "3. 不要用 Markdown 代码块（```）包裹输出，不要输出任何解释、前言或结尾说明。",
    "4. 论文结构包含：标题、摘要、引言、结论。",
    "5. 不要虚构参考文献，不需要 \\cite 和参考文献列表。",
    "6. 优先保证能通过 XeLaTeX 编译：只使用基础宏包（amsmath、amssymb 等），不使用生僻宏包。",
    "",
    "写作任务：",
    userPrompt,
  ].join("\n");
}

/**
 * M11.2 Survey 修订红线块：修订不得破坏综述研究结构。与既有事实 / 引用 /
 * claim 强度守卫叠加（不是替代）——综述结构（taxonomy / gap 集合 / speculative
 * 语气 / 文献覆盖）是上游 HITL 批准的研究结论，Writer 无权在修订中改写。
 */
function renderSurveyRevisionConstraints(survey: SurveySectionWritingContext): string[] {
  const speculativeIds = survey.synthesis
    .filter((item) => item.groundingLevel === "speculative")
    .map((item) => item.synthesisId);
  const gapIds = survey.synthesis
    .filter((item) => item.kind === "research_gap")
    .map((item) => item.synthesisId);
  return [
    "",
    "===== 综述结构红线（Survey 契约；与上方所有守卫叠加）=====",
    "本稿是综述（survey）。修订只解决问题清单指向的表达 / 支撑 / 结构问题，不得为了「修得更好看」而改写研究结构：",
    "- **弱化 ≠ 删除事实**：按「证据不足」弱化某论断时，若其中的数值 / 事实有文献来源归属（其 \\cite 指向的文献报告过它），保留数值并把表述改为归因式陈述（如「文献 [key] 报告了 X」）；只有完全无来源归属的数值才连同数值一起删除。整句删除会触发事实保持守卫（数值消失 = 未授权事实删除），必须避免。",
    "- 不得更换或新增 taxonomy（方法分类体系以本节绑定的 taxonomy synthesis 为准）；",
    `- 不得提出新的 research gap${gapIds.length > 0 ? `（本节 gap 只能来自：${gapIds.join("、")}）` : "（本节未绑定 gap synthesis，不得引入任何 gap 表述）"}；`,
    "- 不得删除支撑性文献引用来简化论述（引用冻结清单仍然有效）；",
    speculativeIds.length > 0
      ? `- 以下 speculative synthesis 只能保持推测语气（可能 / 值得探索 / 有待验证），不得升级为确定结论：${speculativeIds.join("、")}；`
      : "- 推测性内容必须保持推测语气，不得升级为确定结论；",
    "grounded（cited_future_work）方向与 speculative 方向的区分不得抹平；",
    `- 新增引用只能使用以下 key：${survey.allowedCitationKeys.length > 0 ? survey.allowedCitationKeys.join(", ") : "（无：不得新增任何引用）"}。`,
    "",
    "本节绑定的 synthesis（内容边界；本节论断不得超出其范围）：",
    ...renderSectionSynthesisLines(survey),
  ];
}

/** 剥离模型可能误加的 Markdown 代码围栏 */
function stripCodeFence(text: string): string {
  const match = FENCE_PATTERN.exec(text);
  if (match?.[1]) {
    return match[1].trim();
  }
  return text.trim();
}
