/**
 * Argument Unit Contract（M13.7.10）：章节论证单元的最小、可持久化、可校验契约。
 *
 * 研究依据（M13.7.7 → M13.7.9）：跨章节无意义重复的首要驱动是「每一节拿到相同的
 * 证据快照 × 被要求写满固定长度 × 只能写引文事实」。M13.7.9 在两个 held-out 主题
 * 上验证的 B2 方案由三项协同机制构成：逐节分配正式 Evidence、固定篇幅改为软上限、
 * 明确章节的论证任务与负向范围。本模块只负责其中「角色 / 任务 / 负向范围 / 长度
 * 口径」的派生与渲染；逐节证据分配见 evidence/sectionEvidenceAllocation.ts。
 *
 * 纪律：
 * - Outline 只多一个可选字段 `argument`（旧 Outline 无该字段 → 全部由本模块按位置 /
 *   标题 / Survey 语境确定性派生）；不生成第二套权威 Outline，无数据库迁移；
 * - 不要求 Planner 必须输出任何新字段；Planner 若输出，无效部分可诊断、可丢弃，
 *   绝不因可选优化让整篇论文无法写作（M13.7.4 复杂职责 JSON 的教训）；
 * - 角色存在歧义时降级为 develop 并报告，不猜测后宣称正确；
 * - doNotExplain 由 owner 章节确定性派生，渲染时**不**出现「见「X」一节」路标
 *   （M13.7.8 路标模板句的根因），只给概念 + 一条行为约束（B2 crossSectionPolicy）；
 * - 长度是上限参考不是配额：M13.7.9 已证明模型不严格遵守上限，这里不承诺硬保证。
 */

import type { Outline, OutlineSection } from "../manuscript/ManuscriptService.js";
import type { SurveySynthesisArtifact, SurveySynthesisKind } from "../survey/synthesisTypes.js";
import { classifySurveySection } from "../survey/outlineValidation.js";

export type ArgumentRole = "framing" | "develop" | "compare" | "conclude";

export const ARGUMENT_ROLES: readonly ArgumentRole[] = ["framing", "develop", "compare", "conclude"];

/** Outline 可选字段（Planner 可选输出 / HITL 可编辑；缺省由 resolveArgumentUnits 派生） */
export interface OutlineArgumentUnit {
  role?: ArgumentRole;
  /** 规划者给出的论证任务补充（≤ ARGUMENT_TASK_MAX_CHARS；模板任务之上追加） */
  task?: string;
  /** 普通论文：本节正式 Evidence 候选 ID（必须是证据库中的 canonical ID，写作时按 formal 池校验） */
  evidenceIds?: string[];
  /** 本节无需再次完整解释的概念（概念字符串；派生项会与之合并） */
  doNotExplain?: string[];
  /** 软性篇幅上限（字） */
  targetLengthUpperBound?: number;
}

export const ARGUMENT_TASK_MAX_CHARS = 600;
export const ARGUMENT_CONCEPT_MAX_CHARS = 120;
export const ARGUMENT_LIST_MAX_ITEMS = 24;
const EVIDENCE_ID_PATTERN = /^E\d{1,6}$/;

/** Outline 校验用：返回违规描述（空数组 = 合法）。可选字段，缺省合法。 */
export function validateOutlineArgument(sectionId: string, raw: unknown): string[] {
  if (raw === undefined) {
    return [];
  }
  const prefix = `section ${sectionId} 的 argument`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return [`${prefix} 必须是对象`];
  }
  const violations: string[] = [];
  const record = raw as Record<string, unknown>;
  if (record["role"] !== undefined && !ARGUMENT_ROLES.includes(record["role"] as ArgumentRole)) {
    violations.push(`${prefix}.role 只能是 ${ARGUMENT_ROLES.join(" / ")}`);
  }
  if (record["task"] !== undefined && (typeof record["task"] !== "string" || record["task"].length > ARGUMENT_TASK_MAX_CHARS)) {
    violations.push(`${prefix}.task 必须是不超过 ${ARGUMENT_TASK_MAX_CHARS} 字符的字符串`);
  }
  for (const field of ["evidenceIds", "doNotExplain"] as const) {
    const value = record[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
      violations.push(`${prefix}.${field} 必须是非空字符串数组`);
    } else if (value.length > ARGUMENT_LIST_MAX_ITEMS) {
      violations.push(`${prefix}.${field} 不能超过 ${ARGUMENT_LIST_MAX_ITEMS} 项`);
    }
  }
  if (
    record["targetLengthUpperBound"] !== undefined &&
    (typeof record["targetLengthUpperBound"] !== "number" ||
      !Number.isFinite(record["targetLengthUpperBound"]) ||
      record["targetLengthUpperBound"] < 50 ||
      record["targetLengthUpperBound"] > 5000)
  ) {
    violations.push(`${prefix}.targetLengthUpperBound 必须是 50–5000 的数字`);
  }
  return violations;
}

/**
 * Planner 输出的宽容解析（M13.7.4 教训：模型对结构化契约执行不稳定）：合法部分保留，
 * 非法部分逐项丢弃并返回诊断；全部为空 → undefined（Outline 不写入空对象）。
 */
export function parseOutlineArgument(
  raw: unknown,
  options: { allowEvidenceIds: boolean },
): { argument?: OutlineArgumentUnit; dropped: string[] } {
  if (raw === undefined || raw === null) {
    return { dropped: [] };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { dropped: ["argument 不是对象，已忽略"] };
  }
  const record = raw as Record<string, unknown>;
  const dropped: string[] = [];
  const result: OutlineArgumentUnit = {};
  if (record["role"] !== undefined) {
    const role = typeof record["role"] === "string" ? record["role"].trim().toLowerCase() : "";
    if (ARGUMENT_ROLES.includes(role as ArgumentRole)) {
      result.role = role as ArgumentRole;
    } else {
      dropped.push(`argument.role 非法（${String(record["role"]).slice(0, 40)}），按位置 / 标题推断`);
    }
  }
  if (record["task"] !== undefined) {
    if (typeof record["task"] === "string" && record["task"].trim() !== "") {
      result.task = record["task"].trim().slice(0, ARGUMENT_TASK_MAX_CHARS);
    } else {
      dropped.push("argument.task 不是非空字符串，已忽略");
    }
  }
  if (record["evidenceIds"] !== undefined) {
    if (!options.allowEvidenceIds) {
      dropped.push("argument.evidenceIds 在 Survey 大纲中不适用（证据由 synthesisRefs 投影），已忽略");
    } else if (Array.isArray(record["evidenceIds"])) {
      const ids: string[] = [];
      for (const item of record["evidenceIds"]) {
        const id = typeof item === "string" ? item.trim() : "";
        if (EVIDENCE_ID_PATTERN.test(id)) {
          if (!ids.includes(id)) ids.push(id);
        } else {
          dropped.push(`argument.evidenceIds 含非 canonical ID「${String(item).slice(0, 40)}」，已忽略`);
        }
      }
      if (ids.length > 0) result.evidenceIds = ids.sort().slice(0, ARGUMENT_LIST_MAX_ITEMS);
    } else {
      dropped.push("argument.evidenceIds 不是数组，已忽略");
    }
  }
  if (record["doNotExplain"] !== undefined) {
    if (Array.isArray(record["doNotExplain"])) {
      const concepts = [
        ...new Set(
          record["doNotExplain"]
            .filter((item): item is string => typeof item === "string" && item.trim() !== "")
            .map((item) => item.trim().slice(0, ARGUMENT_CONCEPT_MAX_CHARS)),
        ),
      ];
      if (concepts.length > 0) result.doNotExplain = concepts.slice(0, ARGUMENT_LIST_MAX_ITEMS);
    } else {
      dropped.push("argument.doNotExplain 不是数组，已忽略");
    }
  }
  if (record["targetLengthUpperBound"] !== undefined) {
    const value = Number(record["targetLengthUpperBound"]);
    if (Number.isFinite(value) && value >= 50 && value <= 5000) {
      result.targetLengthUpperBound = Math.round(value);
    } else {
      dropped.push("argument.targetLengthUpperBound 不在 50–5000，已忽略");
    }
  }
  return Object.keys(result).length > 0 ? { argument: result, dropped } : { dropped };
}

/** 落盘归一（去重 / 排序 / 去空；全空 → undefined，不写空对象） */
export function normalizeOutlineArgument(argument: OutlineArgumentUnit | undefined): OutlineArgumentUnit | undefined {
  if (argument === undefined) {
    return undefined;
  }
  const next: OutlineArgumentUnit = {};
  if (argument.role !== undefined) next.role = argument.role;
  if (argument.task !== undefined && argument.task.trim() !== "") next.task = argument.task.trim();
  if (argument.evidenceIds !== undefined) {
    const ids = [...new Set(argument.evidenceIds.map((id) => id.trim()).filter((id) => id !== ""))].sort();
    if (ids.length > 0) next.evidenceIds = ids;
  }
  if (argument.doNotExplain !== undefined) {
    const concepts = [...new Set(argument.doNotExplain.map((item) => item.trim()).filter((item) => item !== ""))];
    if (concepts.length > 0) next.doNotExplain = concepts;
  }
  if (argument.targetLengthUpperBound !== undefined) next.targetLengthUpperBound = argument.targetLengthUpperBound;
  return Object.keys(next).length > 0 ? next : undefined;
}

// ---- 角色推断 ----

export type RoleSource = "outline" | "survey_context" | "title" | "position";
export type RoleConfidence = "explicit" | "inferred" | "ambiguous_fallback";

/** 「对比学习」「比较基准」这类标题不是比较节（与 academicRedundancyClassifier 同口径） */
const COMPARE_TITLE = /(比较|对照|对比|讨论|局限|综合分析|synthesis|comparison|discussion|limitations?)/i;
const COMPARE_TITLE_EXCLUDE = /(对比|比较)(学习|框架|方法|损失|式|基准|模型|实验|设置)/;
const CONCLUDE_TITLE = /(结论|总结|展望|结语|conclusion|summary|outlook|future (work|directions?))/i;
const FRAMING_TITLE = /(引言|绪论|导言|背景|概述|introduction|overview|background|preliminar)/i;

const COMPARE_KINDS: ReadonlySet<SurveySynthesisKind> = new Set(["comparison", "consensus", "disagreement", "trend"]);

function isCompareTitle(text: string): boolean {
  return COMPARE_TITLE.test(text) && !COMPARE_TITLE_EXCLUDE.test(text);
}

interface RoleDecision {
  role: ArgumentRole;
  source: RoleSource;
  confidence: RoleConfidence;
  warning?: string;
}

function inferRole(
  section: OutlineSection,
  index: number,
  total: number,
  synthesis: SurveySynthesisArtifact | undefined,
): RoleDecision {
  if (section.argument?.role !== undefined) {
    return { role: section.argument.role, source: "outline", confidence: "explicit" };
  }
  const text = `${section.id} ${section.title}`;
  const concludeHit = CONCLUDE_TITLE.test(text);
  const compareHit = isCompareTitle(text);
  const framingHit = FRAMING_TITLE.test(text);
  // Survey 语境（有 synthesis 时才有意义）：refs 的 kind 分布与 classifySurveySection 一起参与
  let surveyContext: ReturnType<typeof classifySurveySection> | undefined;
  let refKinds: SurveySynthesisKind[] = [];
  if (synthesis !== undefined) {
    surveyContext = classifySurveySection(section);
    const byId = new Map(synthesis.items.map((item) => [item.synthesisId, item.kind]));
    refKinds = (section.synthesisRefs ?? [])
      .map((ref) => byId.get(ref))
      .filter((kind): kind is SurveySynthesisKind => kind !== undefined);
  }
  const compareLeaning = refKinds.length > 0 && refKinds.every((kind) => COMPARE_KINDS.has(kind) || kind === "research_gap");
  const taxonomyLeaning = refKinds.length > 0 && refKinds.some((kind) => kind === "taxonomy");

  if (concludeHit && !compareHit) {
    return { role: "conclude", source: "title", confidence: "inferred" };
  }
  if (surveyContext === "future") {
    return { role: "conclude", source: "survey_context", confidence: "inferred" };
  }
  if (compareHit && framingHit) {
    return {
      role: "develop",
      source: "title",
      confidence: "ambiguous_fallback",
      warning: `章节「${section.title}」标题同时含框架与比较语义，角色无法确定，按 develop 降级处理`,
    };
  }
  if (compareHit && concludeHit) {
    // 「比较与结论」类混合标题：比较语义优先（限制集中陈述），但如实报告歧义
    return {
      role: "compare",
      source: "title",
      confidence: "ambiguous_fallback",
      warning: `章节「${section.title}」标题同时含比较与结论语义，按 compare 处理（结论任务由其他章节承担）`,
    };
  }
  if (compareHit) {
    if (taxonomyLeaning && !compareLeaning) {
      return {
        role: "develop",
        source: "survey_context",
        confidence: "ambiguous_fallback",
        warning: `章节「${section.title}」标题含比较语义但绑定的 synthesis 以 taxonomy 为主，角色存疑，按 develop 降级处理`,
      };
    }
    return { role: "compare", source: "title", confidence: "inferred" };
  }
  if (surveyContext === "gap") {
    return { role: "compare", source: "survey_context", confidence: "inferred" };
  }
  if (surveyContext === "core" && compareLeaning && !framingHit) {
    return { role: "compare", source: "survey_context", confidence: "inferred" };
  }
  if (framingHit) {
    return { role: "framing", source: "title", confidence: "inferred" };
  }
  if (index === 0) {
    return { role: "framing", source: "position", confidence: "inferred" };
  }
  if (index === total - 1 && total > 1) {
    return { role: "conclude", source: "position", confidence: "inferred" };
  }
  return { role: "develop", source: "position", confidence: "inferred" };
}

// ---- 长度口径 ----

/** 角色缺省上限（M13.7.9 B2：180 / 400 / 400 / 320 / 160 的生产化近似） */
export const ROLE_DEFAULT_UPPER_BOUND: Record<ArgumentRole, number> = {
  framing: 200,
  develop: 400,
  compare: 350,
  conclude: 180,
};

/** framing / conclude 的角色封顶：规划者给的目标长度再大，上限也不超过此值（B2：引言 / 结论收缩是去重主来源之一） */
export const ROLE_UPPER_BOUND_CAP: Partial<Record<ArgumentRole, number>> = {
  framing: 260,
  conclude: 240,
};

export type LengthSource = "outline_upper_bound" | "outline_target" | "role_default" | "role_cap";

// ---- 解析结果 ----

export interface ResolvedArgumentUnit {
  sectionId: string;
  title: string;
  role: ArgumentRole;
  roleSource: RoleSource;
  roleConfidence: RoleConfidence;
  /** 最终任务文本（模板 + 规划者补充） */
  task: string;
  taskSource: "template" | "template+outline";
  /** 本节不重新解释的概念（派生 ∪ 规划者给出） */
  doNotExplain: string[];
  targetLengthUpperBound: number;
  lengthSource: LengthSource;
  /** 规划者指定的正式 Evidence 候选（写作时按 formal 池校验） */
  pinnedEvidenceIds: string[];
  /** 本节是否是全文集中陈述限制的位置 */
  limitationOwner: boolean;
  warnings: string[];
}

export interface ResolveArgumentUnitsInput {
  outline: Outline;
  /** Survey：synthesis artifact 参与角色推断与比较维度派生 */
  synthesis?: SurveySynthesisArtifact;
}

const KEY_POINT_LIMIT = 6;
const KEY_POINT_CHARS = 220;

function keyPointLines(section: OutlineSection): string {
  const points = (section.keyPoints ?? []).slice(0, KEY_POINT_LIMIT).map((point) => point.slice(0, KEY_POINT_CHARS));
  return points.length > 0 ? `本节要点：${points.join("；")}。` : "";
}

function titleList(sections: readonly OutlineSection[]): string {
  return sections.map((section) => `「${section.title}」`).join("、");
}

/** comparison synthesis 的维度（Survey）：detail.dimension 去重 */
function comparisonDimensions(section: OutlineSection, synthesis: SurveySynthesisArtifact | undefined): string[] {
  if (synthesis === undefined) return [];
  const byId = new Map(synthesis.items.map((item) => [item.synthesisId, item]));
  const dimensions: string[] = [];
  for (const ref of section.synthesisRefs ?? []) {
    const item = byId.get(ref);
    if (item?.detail?.kind === "comparison" && item.detail.dimension.trim() !== "" && !dimensions.includes(item.detail.dimension.trim())) {
      dimensions.push(item.detail.dimension.trim());
    }
  }
  return dimensions;
}

function buildTask(
  section: OutlineSection,
  role: ArgumentRole,
  develops: readonly OutlineSection[],
  limitationOwner: boolean,
  synthesis: SurveySynthesisArtifact | undefined,
  isFinalSection: boolean,
): string {
  const points = keyPointLines(section);
  const others = develops.filter((candidate) => candidate.id !== section.id);
  switch (role) {
    case "framing":
      return [
        `界定问题与范围：说明本文 / 本综述要回答的问题、研究对象与材料边界，点名将要展开的路线或主题${
          others.length > 0 ? `（${titleList(others)}）` : ""
        }及其代表工作。`,
        "不解释任何机制细节，不转述任何数值结果，不预告各节内容；背景性引用只说明来源与本文方向的关系。代表工作只按下方「文献身份」所列标题 / 年份点名，不补写其平台、装置、方法、机制或结果（引用 key 之外的任何具体描述都须有 Evidence 支撑）。",
        "本节不注入正式 Evidence 是分工安排，不是证据缺失：不要用 evidence_query 把其他章节负责的机制与数值取回本节。",
        points,
      ]
        .filter((line) => line !== "")
        .join("");
    case "develop":
      return [
        `这是全文唯一完整解释「${section.title}」所负责内容的位置：按 Evidence 完整说明机制、结果、适用范围与限制，Evidence 明确支持的数值、对象与限定词必须保留并只按引文范围转述。`,
        others.length > 0 ? `涉及${titleList(others)}所负责的内容时，至多用半句点出差异，不展开、不预告。` : "",
        limitationOwner ? "" : "来源自身的科学限制在相关结论处保留必要限定即可，不写成段的免责声明。",
        points,
      ]
        .filter((line) => line !== "")
        .join("");
    case "compare": {
      const dimensions = comparisonDimensions(section, synthesis);
      return [
        "本节是综合与对照，不是第二遍方法描述。依次回答：各路线 / 方法之间的关键差异是什么",
        dimensions.length > 0 ? `——沿「${dimensions.join("」「")}」等维度，每个维度落到一个对照结论` : "——按要点给出的维度，每个维度落到一个对照结论",
        "，机制与数值只以半句提醒的方式出现，不复制其他章节的句子；现有证据能支持哪些结论；哪些结果因指标口径、平台、数据或实验设置不同而不可直接横向比较（不得给出证据之外的性能排序）；",
        "目前证据还不能判断什么（partial 证据的待核验命题不得写成事实，逐条点明）。",
        limitationOwner ? "这是全文唯一集中陈述材料范围与本文实验缺失等限制的位置。" : "",
        points,
      ]
        .filter((line) => line !== "")
        .join("");
    }
    case "conclude":
      if (!isFinalSection) {
        // 非末节的 conclude（典型：Planner 把「未来方向 / 展望」独立成节，再接「结论」）：只陈述未来方向与
        // 开放问题，不总结各路线——否则两节各复述一遍（M13.7.10 真实验收 run 2：3 句 M 全部来自这一结构）。
        return [
          "本节只陈述未来方向与开放问题：按绑定的综合产物说明尚未完成的工作、其依据与不确定性（推断型方向保留推测语气）；",
          "不总结各路线 / 方法的机制、结果与关系（总结由全文最后一节承担），不重复数值；",
          limitationOwner ? "集中说明真实的研究限制与未完成工作；" : "限制至多一句承接，不再逐条复述；",
          "不写指向其他章节的句子；提及代表工作时只按文献身份点名，不补写前文没有的平台、方法或结果。",
          points,
        ]
          .filter((line) => line !== "")
          .join("");
      }
      return [
        "回答全文要回答的问题：各路线 / 方法分别建立了什么、它们之间的关系与主要判断（只归纳前文已写内容，不新增引文之外的机制细节，不重复数值）；",
        limitationOwner
          ? "集中说明真实的研究限制与未完成工作；"
          : "用一句话承接前文已集中说明的限制，不再逐条复述；",
        "未来工作只作为计划陈述，不列为已完成贡献。不写指向其他章节的句子，不逐一复述各章机制；提及代表工作时只按文献身份点名，不补写前文没有的平台、方法或结果。",
        "本节不注入正式 Evidence 是分工安排，不是证据缺失：不要用 evidence_query 把其他章节负责的机制与数值取回本节。",
        points,
      ]
        .filter((line) => line !== "")
        .join("");
  }
}

/**
 * 解析整篇大纲的论证单元（确定性纯函数：同 outline + synthesis 恒同结果）。
 * 顺序：角色 → 限制 owner（compare 优先，其次 conclude）→ 任务模板 → doNotExplain → 长度上限。
 */
export function resolveArgumentUnits(input: ResolveArgumentUnitsInput): ResolvedArgumentUnit[] {
  const sections = input.outline.sections;
  const decisions = sections.map((section, index) => inferRole(section, index, sections.length, input.synthesis));
  const develops = sections.filter((_, index) => decisions[index]!.role === "develop");
  const compareIndex = decisions.findIndex((decision) => decision.role === "compare");
  const concludeIndex = decisions.findIndex((decision) => decision.role === "conclude");
  // 限制集中陈述的 owner：Survey 中绑定 research_gap synthesis 的章节（M11 契约：空缺 / 局限由该
  // synthesis 承载）优先；否则第一个 compare；再否则第一个 conclude。
  const gapKinds = new Map(input.synthesis?.items.map((item) => [item.synthesisId, item.kind]) ?? []);
  const gapIndex =
    input.synthesis === undefined
      ? -1
      : sections.findIndex((section) => (section.synthesisRefs ?? []).some((ref) => gapKinds.get(ref) === "research_gap"));
  const limitationOwnerIndex = gapIndex >= 0 ? gapIndex : compareIndex >= 0 ? compareIndex : concludeIndex;

  return sections.map((section, index) => {
    const decision = decisions[index]!;
    const warnings: string[] = decision.warning !== undefined ? [decision.warning] : [];
    const limitationOwner = index === limitationOwnerIndex;
    const template = buildTask(section, decision.role, develops, limitationOwner, input.synthesis, index === sections.length - 1);
    const outlineTask = section.argument?.task?.trim();
    const task = outlineTask !== undefined && outlineTask !== "" ? `${template}规划补充：${outlineTask}` : template;

    const derived: string[] = [];
    for (const owner of develops) {
      if (owner.id === section.id) continue;
      derived.push(`「${owner.title}」所负责的机制、结果与数值细节`);
    }
    if (limitationOwnerIndex >= 0 && !limitationOwner) {
      derived.push(`材料范围、本文实验缺失等限制的集中陈述（由「${sections[limitationOwnerIndex]!.title}」承担）`);
    }
    const doNotExplain = [...new Set([...derived, ...(section.argument?.doNotExplain ?? [])])].slice(0, ARGUMENT_LIST_MAX_ITEMS);

    let targetLengthUpperBound: number;
    let lengthSource: LengthSource;
    if (section.argument?.targetLengthUpperBound !== undefined) {
      targetLengthUpperBound = section.argument.targetLengthUpperBound;
      lengthSource = "outline_upper_bound";
    } else if (section.targetLengthWords !== undefined) {
      targetLengthUpperBound = section.targetLengthWords;
      lengthSource = "outline_target";
    } else {
      targetLengthUpperBound = ROLE_DEFAULT_UPPER_BOUND[decision.role];
      lengthSource = "role_default";
    }
    const cap = ROLE_UPPER_BOUND_CAP[decision.role];
    if (cap !== undefined && targetLengthUpperBound > cap && lengthSource !== "outline_upper_bound") {
      targetLengthUpperBound = cap;
      lengthSource = "role_cap";
    }

    return {
      sectionId: section.id,
      title: section.title,
      role: decision.role,
      roleSource: decision.source,
      roleConfidence: decision.confidence,
      task,
      taskSource: outlineTask !== undefined && outlineTask !== "" ? "template+outline" : "template",
      doNotExplain,
      targetLengthUpperBound,
      lengthSource,
      pinnedEvidenceIds: [...(section.argument?.evidenceIds ?? [])],
      limitationOwner,
      warnings,
    };
  });
}

// ---- 渲染（B2 冻结措辞：scripts/acceptance/fixtures/m13-7-9/*.json#argumentUnitsV2） ----

export const ARGUMENT_ROLE_LABELS: Record<ArgumentRole, string> = {
  framing: "framing（界定问题与范围、点名路线及代表工作；不展开机制、不转述数值、不预告各节内容）",
  develop: "develop（本节是指定概念的唯一完整展开位置；涉及其他路线时至多半句点出差异）",
  compare: "compare（综合与对照：回答关键差异、比较维度、现有证据支持什么、哪些结果不可直接横向比较、还不能判断什么；不是第二遍方法描述）",
  conclude: "conclude（综合回答全文问题，一句承接限制，不逐条复述、不写结构性回指）",
};

export const ARGUMENT_LENGTH_POLICY =
  "目标长度是上限参考，不是必须填满的配额：当本节分配到的材料不足以支撑目标长度时，宁可写短，也不为凑字重述已有内容、重复限制声明或补写引文之外的细节。";

export const ARGUMENT_CROSS_SECTION_POLICY =
  "跨章节分工只约束本节写什么、不写什么，分工本身不进入正文：不写「见某节」「将在某节展开」「已在前文说明」这类指向其他章节的句子，不在节首或节尾预告、回顾论文结构；需要承接时直接点出对象或差异，用半句自然过渡即可。";

export const ARGUMENT_UNIT_BLOCK_HEADER = "===== 本节论证任务（组织约定，不是事实证据）=====";

export interface RenderArgumentUnitOptions {
  /** 本节分配到的正式 Evidence 条数（develop 不足时追加短写提示） */
  evidenceCount?: number;
  /** compare 节：partial 证据的待核验命题（逐条点明「还不能判断什么」） */
  partialClaims?: string[];
}

/** 渲染 B2 任务块（普通 Writer 与 Survey Writer 共用；不渲染任何「见 X 一节」路标） */
export function renderArgumentUnitLines(unit: ResolvedArgumentUnit, options: RenderArgumentUnitOptions = {}): string[] {
  const lines = [ARGUMENT_UNIT_BLOCK_HEADER, `角色：${ARGUMENT_ROLE_LABELS[unit.role]}`, `任务：${unit.task}`];
  if (unit.role === "develop" && options.evidenceCount !== undefined && options.evidenceCount < 2) {
    lines.push(
      `本节可用正式证据只有 ${options.evidenceCount} 条：按证据能支撑的范围短写，不为凑长度补写引文之外的机制或数值；确需更多依据时如实弱化或省略。`,
    );
  }
  if (unit.role === "compare" && options.partialClaims !== undefined && options.partialClaims.length > 0) {
    lines.push("目前证据还不能判断（partial 证据的待核验命题，不得写成事实）：");
    for (const claim of options.partialClaims.slice(0, 6)) {
      lines.push(`- ${claim.slice(0, 160)}`);
    }
  }
  if (unit.doNotExplain.length > 0) {
    lines.push("本节不重新解释的内容（由其他章节完整展开；如论述需要，以半句点到为止）：");
    for (const concept of unit.doNotExplain) {
      lines.push(`- ${concept}`);
    }
  }
  lines.push(`跨章节约定：${ARGUMENT_CROSS_SECTION_POLICY}`, `长度口径：${ARGUMENT_LENGTH_POLICY}`);
  return lines;
}

/**
 * 文献身份表（framing / conclude 专用）：这两类章节不注入正式 Evidence，模型只看到 cite key 时会凭记忆
 * 补写文献的平台 / 方法（M13.7.10 真实验收 run 1：把微波腔实验写成「里德堡原子阵列」）。给出 key → 标题 /
 * 年份，并声明「只用于点名，不得据此描述内容」。
 */
export function renderBibliographyIdentityLines(
  unit: ResolvedArgumentUnit,
  bibliography: ReadonlyArray<{ key: string; title?: string; year?: number }>,
  limit = 40,
): string[] {
  if ((unit.role !== "framing" && unit.role !== "conclude") || bibliography.length === 0) {
    return [];
  }
  return [
    "",
    "===== 文献身份（只用于按标题点名代表工作；不是内容依据——平台、装置、方法、机制、结果一律不得据此补写）=====",
    ...bibliography
      .slice(0, limit)
      .map((entry) => `- ${entry.key}：${(entry.title ?? "（无标题）").slice(0, 160)}${entry.year !== undefined ? `（${entry.year}）` : ""}`),
  ];
}

/** 「目标长度」行：启用论证单元时是上限口径，否则沿用旧的「约 N 字」 */
export function renderTargetLengthLine(section: OutlineSection, unit: ResolvedArgumentUnit | undefined, fallback: number): string {
  if (unit === undefined) {
    return `目标长度：约 ${section.targetLengthWords ?? fallback} 字`;
  }
  return `目标长度：不超过 ${unit.targetLengthUpperBound} 字（上限参考，不是配额）`;
}

/** 任务摘要（产物 / 日志用；不含规划者补充的全文） */
export function summarizeArgumentTask(unit: ResolvedArgumentUnit, maxChars = 200): string {
  return unit.task.length > maxChars ? `${unit.task.slice(0, maxChars)}…` : unit.task;
}
