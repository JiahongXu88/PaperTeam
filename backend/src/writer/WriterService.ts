/**
 * Writer Agent：整篇写作 + 分节写作 / 修订。
 *
 * - write：M2 完整文档形态（legacy generate API 使用）
 * - planOutline：基于调研与 Evidence 产出结构化大纲（JSON，经确定性校验）
 * - writeSection：逐节写作（LaTeX 片段，禁止 \documentclass / \begin{document}）
 *
 * 输出校验失败抛业务错误（Agent 返回文本 ≠ 成功）。
 */

import { AgentRunFailedError, InvalidLatexOutputError } from "../errors.js";
import type { AgentRuntime, AgentTask } from "../runtime/types.js";
import type { BibliographyEntryInput } from "../agents/ResearcherService.js";
import type { EvidenceRecord } from "../evidence/EvidenceStore.js";
import type { ReviewIssue } from "../agents/ReviewerService.js";
import type { RevisionPlanItem } from "../review/revisionPlan.js";
import {
  EXTERNAL_OUTCOMES_MARKER,
  type ExternalDirectiveDispatch,
  type ExternalOutcomeKind,
  type ExternalOutcomeReport,
} from "../review/externalInstructions.js";
import { protectedInventory } from "../review/styleInvariants.js";
import type { Outline, OutlineSection } from "../manuscript/ManuscriptService.js";
import { validateOutline } from "../manuscript/ManuscriptService.js";
import { extractJsonObject } from "../agents/outputParsing.js";

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
   */
  async planOutline(params: {
    projectId: string;
    researchDigest: {
      domainOverview: string;
      researchGaps: string[];
      potentialContributions: string[];
    };
    evidence: EvidenceRecord[];
    bibliography: BibliographyEntryInput[];
    targetProfile?: string;
    documentType?: string;
    feedback?: string;
  }): Promise<Outline> {
    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      ...this.timeoutOverride,
      task: buildOutlinePrompt(params),
      projectId: params.projectId,
      contextScope: "writing/outline",
      metadata: { role: "writer", skill: "outline" },
    });
    if (task.status !== "completed") {
      throw new AgentRunFailedError(task.error ?? `大纲任务以 ${task.status} 状态结束`);
    }
    const parsed = extractJsonObject(task.output ?? "", "大纲结果");
    const outline: Outline = {
      title:
        typeof parsed["title"] === "string" && parsed["title"].trim() !== ""
          ? parsed["title"].trim()
          : "Untitled",
      ...(typeof parsed["abstract"] === "string" && parsed["abstract"].trim() !== ""
        ? { abstract: parsed["abstract"].trim() }
        : {}),
      sections: readOutlineSections(parsed),
    };
    const violations = validateOutline(outline);
    if (violations.length > 0) {
      throw new InvalidLatexOutputError(`大纲未通过校验：${violations.join("；")}`);
    }
    this.log(`[writer] projectId=${params.projectId} 大纲完成：${outline.sections.length} 节`);
    return outline;
  }

  /**
   * 写作单个章节（LaTeX 片段，不含文档骨架）。
   * 校验：非空、不含 \documentclass / \begin{document}（骨架由确定性代码生成）。
   */
  async writeSection(params: {
    projectId: string;
    section: OutlineSection;
    outline: Outline;
    evidence: EvidenceRecord[];
    bibliography: BibliographyEntryInput[];
    styleProfile?: Record<string, unknown>;
    extraInstructions?: string;
  }): Promise<{ latex: string; taskId: string }> {
    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      ...this.timeoutOverride,
      task: buildSectionPrompt(params),
      projectId: params.projectId,
      contextScope: "writing/sections",
      metadata: { role: "writer", skill: "section" },
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
    extraInstructions?: string;
    /** 外部修改意见（M5.7；缺省 = 行为与旧版完全一致） */
    externalDirectives?: ExternalDirectiveDispatch[];
  }): Promise<{ latex: string; taskId: string; externalOutcomes?: ExternalOutcomeReport[] }> {
    if (
      params.issues.length === 0 &&
      params.buildError === undefined &&
      (params.externalDirectives ?? []).length === 0
    ) {
      // 无问题章节原样返回（不烧 Token）
      return { latex: params.currentLatex, taskId: "(unchanged)" };
    }
    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      ...this.timeoutOverride,
      task: buildRevisePrompt(params),
      projectId: params.projectId,
      contextScope: "writing/revision",
      metadata: {
        role: "writer",
        skill: "revision",
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
    const latex = stripCodeFence(bodyLatex).trim();
    if (latex === "") {
      throw new AgentRunFailedError(`章节 ${params.section.id} 修订没有返回内容`);
    }
    if (latex.includes("\\documentclass") || latex.includes("\\begin{document}")) {
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
  }): Promise<ImprovementPlan> {
    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      ...this.timeoutOverride,
      task: [
        "你是一名论文写手（Writer）。请基于审稿问题与目标差距，为已有 LaTeX 论文制定分节改进计划（只规划，不写正文）。",
        "",
        "只输出一个 JSON 对象（不要 Markdown 围栏）：",
        '{"plan": [{"section": "sections/xxx.tex", "action": "具体改法", "rationale": "对应的问题或差距", "priority": "high|medium|low"}]}',
        "",
        "要求：",
        "1. plan 至少 1 项、至多 20 项；section 必须是以下现有章节文件之一：",
        ...(params.sectionFiles.length > 0
          ? params.sectionFiles.map((file) => `   - ${file}`)
          : ["   - （未识别到章节文件：section 使用 main.tex）"]),
        "2. 优先处理 critical / blocking 问题与编译错误。",
        "3. 证据不足的论断计划为「弱化或删除」，不允许计划编造实验或引用。",
        ...(params.feedback ? ["", "用户补充要求：", params.feedback] : []),
        "",
        `目标档次：${params.targetProfile ?? "未指定"}；可行性结论：${params.feasibilityLevel}`,
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
      ].join("\n"),
      projectId: params.projectId,
      contextScope: "writing/improvement-plan",
      metadata: { role: "writer", skill: "improvement-plan" },
    });
    if (task.status !== "completed") {
      throw new AgentRunFailedError(task.error ?? `改进计划任务以 ${task.status} 状态结束`);
    }
    const parsed = extractJsonObject(task.output ?? "", "改进计划");
    const rawPlan = parsed["plan"];
    if (!Array.isArray(rawPlan) || rawPlan.length === 0) {
      throw new AgentRunFailedError("改进计划：缺少非空 plan 数组");
    }
    const items: ImprovementPlanItem[] = [];
    for (const raw of rawPlan.slice(0, 20)) {
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
      items.push({
        section,
        action,
        ...(typeof record["rationale"] === "string" && record["rationale"].trim() !== ""
          ? { rationale: record["rationale"].trim() }
          : {}),
        priority,
      });
    }
    if (items.length === 0) {
      throw new AgentRunFailedError("改进计划：没有合法条目");
    }
    return { items };
  }
}

export interface ImprovementPlanItem {
  section: string;
  action: string;
  rationale?: string;
  priority: "high" | "medium" | "low";
}

export interface ImprovementPlan {
  items: ImprovementPlanItem[];
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

function buildRevisePrompt(params: {
  section: OutlineSection;
  outline: Outline;
  currentLatex: string;
  issues: ReviewIssue[];
  evidence: EvidenceRecord[];
  bibliography: BibliographyEntryInput[];
  buildError?: string;
  extraInstructions?: string;
  externalDirectives?: ExternalDirectiveDispatch[];
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
      ...externalBlock,
      "",
      "===== 可用 Evidence =====",
      ...params.evidence
        .slice(0, 15)
        .map((record) => `- [${record.id}] ${record.claim.slice(0, 140)}`),
    ].join("\n");
  }
  return [
    `你是一名学术论文写手（Writer）。请修订论文章节「${params.section.title}」。`,
    "",
    "输出要求：",
    "1. 只输出修订后的该章节完整 LaTeX 正文片段（\\section 起）；不要文档骨架、不要解释。",
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
    "8. 可用宏包只有 amsmath / amssymb / natbib（ctexart 文档类）；不要使用 tikz 等"
      + "其他宏包的环境或命令（图形以文字描述或 table 呈现），否则无法编译。",
    "9. 只允许引用以下参考文献 key：" +
      (params.bibliography.length > 0
        ? params.bibliography.map((entry) => entry.key).join(", ")
        : "（无：不要新增 \\cite）"),
    "10. 保留本章节现有的 \\cite 引用及其所支撑的论述（除非某条问题明确要求删除该引用）；不得为了精简而整体删光引用，也不得新增列表之外的 key。",
    ...(params.buildError
      ? ["11. 上一轮编译失败，错误摘要（必须修复）：" + params.buildError]
      : []),
    ...externalRules,
    ...(params.extraInstructions ? ["", "补充要求：", params.extraInstructions] : []),
    "",
    "===== 本章节当前内容 =====",
    params.currentLatex.slice(0, 12_000),
    "",
    "===== 针对本章节的问题 =====",
    ...(params.issues.length > 0
      ? params.issues.map(
          (issue) =>
            `- [${issue.severity}${issue.blocking ? "/blocking" : ""}] ${issue.description}` +
            (issue.suggestedAction ? `（建议：${issue.suggestedAction}）` : ""),
        )
      : ["（无审稿问题）"]),
    ...externalBlock,
    "",
    "===== 可用 Evidence =====",
    ...params.evidence
      .slice(0, 15)
      .map((record) => `- [${record.id}] ${record.claim.slice(0, 140)}`),
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
  const latex = lines.slice(0, lineIndex).join("\n");
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

/** 解析大纲 sections 数组（防御性） */
function readOutlineSections(parsed: Record<string, unknown>): OutlineSection[] {
  const value = parsed["sections"];
  if (!Array.isArray(value)) {
    return [];
  }
  const sections: OutlineSection[] = [];
  for (const raw of value.slice(0, 20)) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const record = raw as Record<string, unknown>;
    if (typeof record["id"] !== "string" || typeof record["file"] !== "string") {
      continue;
    }
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

function buildOutlinePrompt(params: {
  researchDigest: {
    domainOverview: string;
    researchGaps: string[];
    potentialContributions: string[];
  };
  evidence: EvidenceRecord[];
  bibliography: BibliographyEntryInput[];
  targetProfile?: string;
  documentType?: string;
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
    "要求：",
    "1. sections 至少 4 节（含 introduction 与 conclusion），至多 12 节；file 使用小写字母数字连字符加 .tex。",
    "2. 大纲必须与研究空白、潜在贡献对应；Evidence 不足的章节在 keyPoints 中明确标注「证据不足」。",
    "3. 可引用的参考文献 key：" +
      (params.bibliography.length > 0
        ? params.bibliography.map((entry) => entry.key).join(", ")
        : "（暂无；正文中不要使用 \\cite）"),
    ...(params.feedback ? ["", "用户对上一版大纲的修改意见（必须落实）：", params.feedback] : []),
    "",
    "===== 调研摘要 =====",
    `领域现状：${params.researchDigest.domainOverview.slice(0, 400)}`,
    `研究空白：${params.researchDigest.researchGaps.slice(0, 5).join("；")}`,
    `潜在贡献：${params.researchDigest.potentialContributions.slice(0, 5).join("；")}`,
    `目标类型：${params.documentType ?? "（未填写）"}；目标档次：${params.targetProfile ?? "（未填写）"}`,
    "",
    "===== 可用 Evidence（用于判断哪些论点有支撑）=====",
    ...params.evidence
      .slice(0, 20)
      .map((record) => `- [${record.id}] ${record.claim.slice(0, 120)}`),
  ].join("\n");
}

function buildSectionPrompt(params: {
  section: OutlineSection;
  outline: Outline;
  evidence: EvidenceRecord[];
  bibliography: BibliographyEntryInput[];
  styleProfile?: Record<string, unknown>;
  extraInstructions?: string;
}): string {
  return [
    `你是一名学术论文写手（Writer）。请撰写论文章节「${params.section.title}」。`,
    "",
    "输出要求：",
    "1. 只输出该章节的 LaTeX 正文片段：以 \\section{标题} 开始；不要 \\documentclass、\\begin{document}、导言区、文档骨架。",
    "2. 不要用 Markdown 代码块包裹，不要解释文字。",
    "3. 论述优先使用下方 Evidence 支撑；证据不足时显式弱化表述或标注，不为凑字虚构数据、结论或引用。",
    "4. 只允许引用以下参考文献 key：" +
      (params.bibliography.length > 0
        ? params.bibliography.map((entry) => entry.key).join(", ")
        : "（无可用文献：不要使用 \\cite）"),
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
    "===== 可用 Evidence =====",
    ...params.evidence
      .slice(0, 20)
      .map(
        (record) =>
          `- [${record.id}] ${record.claim.slice(0, 150)}${record.quote ? `（引文："${record.quote.slice(0, 120)}"）` : ""}`,
      ),
    ...(params.evidence.length === 0 ? ["（无 Evidence：本章节避免需要外部证据的强论断）"] : []),
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

/** 剥离模型可能误加的 Markdown 代码围栏 */
function stripCodeFence(text: string): string {
  const match = FENCE_PATTERN.exec(text);
  if (match?.[1]) {
    return match[1].trim();
  }
  return text.trim();
}
