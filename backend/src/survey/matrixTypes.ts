/**
 * Survey Matrix 类型与确定性校验（M11.1.1）。
 *
 * 数据边界（M11.0 冻结设计）：
 * - Matrix 是 Research 阶段派生产物：per-paper 的**结构化理解**，不是
 *   Verified Evidence——EvidenceRecord 的「单源、单锚点、verified」语义
 *   不变，Matrix 不写 EvidenceStore；
 * - 不复制 SourceStore 事实（year / venue / DOI / metadata 均经 sourceId
 *   指向 SourceStore 解析；citationKey 不落盘，使用点经 bibliography
 *   确定性管道解析——与 M9.5「Evidence → key 追溯不落存储」同纪律）；
 * - entryId 是 sourceId 的确定性派生（`M-<sourceId>`）：同输入重复 build
 *   恒产生同一行（dedup 键 = sourceId），不依赖随机数 / 时钟 / 序号；
 * - abstract_only 诚实降级：允许 taxonomy 初步归类与描述性字段，禁止
 *   chunk anchor（强制清空）与评价性字段（strength / limitation /
 *   keyFindings——这些需要全文依据）；
 * - LLM 无权自报 grounded：anchors 只承载 chunk 引用（经 ChunkAccess
 *   fail-closed 核验），evidenceIds 仅 HITL 路径可携带（写入时核验存在）；
 *   groundingLevel 判定属 M11.1.2。
 *
 * taxonomy fail-closed：模型返回的 methodFamily 不在 taxonomy 内 →
 * methodFamily = "unclassified" + issue 记录原始提案，**绝不静默扩表**；
 * 后续人工修正走 PUT /survey/matrix/:entryId（同样只接受表内标签）。
 */

import { AgentRunFailedError } from "../errors.js";

/** 解释深度：fulltext（已入库全文 chunk 可检索）/ abstract_only（仅元数据+摘要） */
export type InterpretationDepth = "fulltext" | "abstract_only";

/** entry 生命周期：draft（构建产出）/ confirmed（HITL 确认）；内容编辑回退 draft */
export type SurveyEntryStatus = "draft" | "confirmed";

/** 允许携带 chunk anchor 的 Matrix 字段（评价性 / 依据性字段全集） */
export type SurveyAnchorableField =
  | "mainIdea"
  | "keyTechnique"
  | "strength"
  | "limitation"
  | "keyFindings"
  | "datasetContext";

export const SURVEY_ANCHORABLE_FIELDS: readonly SurveyAnchorableField[] = [
  "mainIdea",
  "keyTechnique",
  "strength",
  "limitation",
  "keyFindings",
  "datasetContext",
];

/** taxonomy 之外的保留值：未归类（进入人工修正路径，不算合法 family 标签） */
export const UNCLASSIFIED_FAMILY = "unclassified";

/** Matrix 条目级校验问题（needs_review 信号；不阻塞落盘，供 HITL 队列消费） */
export interface SurveyMatrixIssue {
  code:
    | "method_family_not_in_taxonomy" // 模型标签不在 taxonomy → unclassified
    | "subfamily_not_in_taxonomy" // 子家族不在 family 的 subFamilies → 丢弃
    | "abstract_only_field_dropped" // abstract_only 的评价性字段被剥离
    | "abstract_only_anchors_forced_empty" // abstract_only 的 anchors 被强制清空
    | "anchor_field_invalid" // anchors[].field 不在可锚定字段集 → 丢弃
    | "anchor_chunk_invalid" // chunkId 不存在 / 跨文献锚定 → 剔除
    | "anchor_dropped" // 整条 anchor 无有效 chunkId → 丢弃
    | "no_valid_anchors" // fulltext 条目零有效 anchor（弱溯源信号）
    | "no_retrievable_chunks" // fulltext 条目未检索到任何全文段落
    | "key_findings_capped" // keyFindings 超上限被截断
    | "entry_reclassified" // taxonomy 更替后既有条目标签失效 → unclassified
    | "evidence_id_invalid" // evidenceIds 引用不存在的 Evidence → 剔除（HITL 路径）
    | "evidence_source_mismatch"; // evidence 指向其它文献 → 剔除（HITL 路径）
  message: string;
  /** 模型 / 用户原始提案（not_in_taxonomy 等 code 携带；审计用） */
  proposed?: string;
}

/** field → source chunk 的可追溯锚点（chunk 引用经 ChunkAccess 核验） */
export interface SurveyFieldAnchor {
  field: SurveyAnchorableField;
  /** chunkId（<sourceId>:<sectionId>:<序号>:<hash10>；必须属于本条目 sourceId） */
  chunkIds: string[];
  /**
   * verified Evidence 引用（可选；仅 HITL 修正路径可携带并经 EvidenceStore
   * 核验存在——模型抽取链不产生，LLM 无权自报 grounded）。
   */
  evidenceIds?: string[];
}

/** 方法家族受控词表（模型不得静默扩充；可在 build 时提供 / 覆盖） */
export interface SurveyTaxonomyFamily {
  label: string;
  description: string;
  subFamilies?: string[];
}

export interface SurveyTaxonomy {
  families: SurveyTaxonomyFamily[];
}

/**
 * 缺省 taxonomy：面向 ML / CV 实证文献的最小家族集（综述场景的通用兜底；
 * 真实 Survey 构建应在 build 请求中按课题提供更贴切的词表）。
 * "unclassified" 是保留值，不出现在 families 中。
 */
export const DEFAULT_SURVEY_TAXONOMY: SurveyTaxonomy = {
  families: [
    { label: "survey", description: "综述 / 对某领域文献的系统性回顾" },
    { label: "detection", description: "目标 / 特征检测方法" },
    {
      label: "tracking_association",
      description: "多目标跟踪与数据关联方法（运动 / 外观 / 联合）",
      subFamilies: ["motion_based", "appearance_based", "joint"],
    },
    { label: "re_identification", description: "外观重识别与嵌入匹配方法" },
    { label: "retrieval_augmented", description: "检索增强 / 检索融合方法" },
    { label: "representation_learning", description: "表示学习与特征学习" },
    { label: "generative_model", description: "生成式模型与数据合成" },
    { label: "evaluation_benchmark", description: "评测基准 / 协议与实证分析" },
    { label: "system_deployment", description: "系统实现与端侧部署优化" },
    { label: "theory_analysis", description: "理论分析 / 形式化方法" },
  ],
};

/** 文本字段长度上限（写入与读取共用；超长截断而非拒绝——与 CandidateStore 同纪律） */
export const SURVEY_FIELD_LIMITS = {
  researchProblem: 300,
  methodFamily: 80,
  subFamily: 80,
  mainIdea: 300,
  keyTechnique: 300,
  assumption: 300,
  datasetContext: 300,
  strength: 300,
  limitation: 300,
  comparedMethod: 80,
} as const;

/** keyFindings 条数上限（超出截断 + issue） */
export const KEY_FINDINGS_MAX = 3;
/** comparedMethods 去重后上限 */
export const COMPARED_METHODS_MAX = 20;
/** anchors 条数上限（每条目；防御模型输出风暴） */
export const ANCHORS_MAX = 12;

/** Survey Matrix 单行（per-paper 结构化理解；sourceId 是 dedup 唯一键） */
export interface SurveyMatrixEntry {
  /** 确定性派生：`M-<sourceId>` */
  entryId: string;
  sourceId: string;
  interpretationDepth: InterpretationDepth;
  researchProblem?: string;
  /** 受控标签（taxonomy 内）或 "unclassified"；HITL 可改回表内标签 */
  methodFamily?: string;
  subFamily?: string;
  mainIdea?: string;
  keyTechnique?: string;
  assumption?: string;
  datasetContext?: string;
  strength?: string;
  limitation?: string;
  comparedMethods?: string[];
  keyFindings?: string[];
  anchors: SurveyFieldAnchor[];
  status: SurveyEntryStatus;
  /** 构建问题（unclassified / 降级 / 锚定剔除等；HITL 修正依据） */
  issues?: SurveyMatrixIssue[];
  /** 构建产生的 Runtime 任务 id（追溯；HITL 编辑不改写） */
  taskId?: string;
  updatedAt: string;
}

/** artifact 形状（research/survey.json 的全部事实） */
export interface SurveyMatrixArtifact {
  schemaVersion: 1;
  updatedAt: string;
  taxonomy: SurveyTaxonomy;
  /** 按 sourceId 升序（确定性序列化） */
  entries: SurveyMatrixEntry[];
}

/** 确定性 entryId：sourceId 的纯函数 */
export function matrixEntryId(sourceId: string): string {
  return `M-${sourceId}`;
}

/** entryId 形状校验（HTTP 路由 / PUT 入参用） */
export function isMatrixEntryId(value: string): boolean {
  return /^M-S\d{2,}$/.test(value);
}

/** taxonomy 归一与合法性（label 去空白、去重；空 families 拒绝） */
export function normalizeTaxonomy(input: SurveyTaxonomy): SurveyTaxonomy {
  if (
    typeof input !== "object" ||
    input === null ||
    !Array.isArray(input.families) ||
    input.families.length === 0
  ) {
    throw new AgentRunFailedError("taxonomy 必须是非空 families 数组");
  }
  const seen = new Set<string>();
  const families: SurveyTaxonomyFamily[] = [];
  for (const raw of input.families) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    const description = typeof raw.description === "string" ? raw.description.trim() : "";
    if (label === "" || label === UNCLASSIFIED_FAMILY || seen.has(label)) {
      continue; // 空标签 / 保留值 / 重复标签：丢弃（fail-closed 而非报错——词表容错）
    }
    seen.add(label);
    const subFamilies = Array.isArray(raw.subFamilies)
      ? [
          ...new Set(
            raw.subFamilies
              .filter((sub): sub is string => typeof sub === "string" && sub.trim() !== "")
              .map((sub) => sub.trim()),
          ),
        ]
      : undefined;
    families.push({
      label: label.slice(0, SURVEY_FIELD_LIMITS.methodFamily),
      description: description.slice(0, 500),
      ...(subFamilies !== undefined && subFamilies.length > 0 ? { subFamilies } : {}),
    });
  }
  if (families.length === 0) {
    throw new AgentRunFailedError("taxonomy 没有可用 family（label 全部为空 / 重复 / 保留值）");
  }
  return { families };
}

export function taxonomyFamilyOf(
  taxonomy: SurveyTaxonomy,
  label: string | undefined,
): SurveyTaxonomyFamily | undefined {
  if (label === undefined) {
    return undefined;
  }
  return taxonomy.families.find((family) => family.label === label);
}

function optionalText(
  parsed: Record<string, unknown>,
  field: string,
  limit: number,
): string | undefined {
  const raw = parsed[field];
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return undefined;
  }
  return trimmed.slice(0, limit);
}

function optionalTextArray(
  parsed: Record<string, unknown>,
  field: string,
  perItemLimit: number,
): string[] | undefined {
  const raw = parsed[field];
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const items = raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (items.length === 0) {
    return undefined;
  }
  return items.map((item) => item.slice(0, perItemLimit));
}

/** comparedMethods 归一：trim / 截断 / 大小写不敏感去重 / 上限 */
export function normalizeComparedMethods(raw: string[] | undefined): string[] {
  if (raw === undefined) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const trimmed = item.trim().slice(0, SURVEY_FIELD_LIMITS.comparedMethod);
    if (trimmed === "") {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(trimmed);
    if (out.length >= COMPARED_METHODS_MAX) {
      break;
    }
  }
  return out;
}

/**
 * 模型 JSON 输出 → Matrix 条目草稿（同步部分：字段 / taxonomy / 列表归一）。
 * anchors 的 chunkId 存在性核验在服务层（需 ChunkAccess 异步读盘），本函数
 * 只做形状校验：field 合法 + chunkIds 非空字符串数组。
 * 全部核心字段为空 → AgentRunFailedError（按单篇失败落账，不产出空壳行）。
 */
export function parseMatrixEntryOutput(input: {
  sourceId: string;
  interpretationDepth: InterpretationDepth;
  parsed: Record<string, unknown>;
  taxonomy: SurveyTaxonomy;
  /** 条目时间戳（调用方注入；保持本函数确定性、可测） */
  updatedAt: string;
}): { entry: SurveyMatrixEntry; issues: SurveyMatrixIssue[] } {
  const { sourceId, interpretationDepth, parsed, taxonomy } = input;
  const issues: SurveyMatrixIssue[] = [];

  const researchProblem = optionalText(parsed, "researchProblem", SURVEY_FIELD_LIMITS.researchProblem);
  const mainIdea = optionalText(parsed, "mainIdea", SURVEY_FIELD_LIMITS.mainIdea);

  // methodFamily：受控词表核验（fail-closed → unclassified + issue）
  const proposedFamilyRaw = optionalText(parsed, "methodFamily", SURVEY_FIELD_LIMITS.methodFamily);
  let methodFamily: string | undefined;
  if (proposedFamilyRaw !== undefined) {
    if (proposedFamilyRaw === UNCLASSIFIED_FAMILY) {
      methodFamily = UNCLASSIFIED_FAMILY;
    } else if (taxonomyFamilyOf(taxonomy, proposedFamilyRaw) !== undefined) {
      methodFamily = proposedFamilyRaw;
    } else {
      methodFamily = UNCLASSIFIED_FAMILY;
      issues.push({
        code: "method_family_not_in_taxonomy",
        message: `模型给出的 methodFamily「${proposedFamilyRaw}」不在 taxonomy 内，已标记 unclassified`,
        proposed: proposedFamilyRaw,
      });
    }
  }

  // subFamily：仅当 family 存在且声明 subFamilies 时接受表内值
  const proposedSubFamily = optionalText(parsed, "subFamily", SURVEY_FIELD_LIMITS.subFamily);
  let subFamily: string | undefined;
  if (proposedSubFamily !== undefined) {
    const family = taxonomyFamilyOf(taxonomy, methodFamily);
    const allowed = family?.subFamilies;
    if (
      methodFamily !== undefined &&
      methodFamily !== UNCLASSIFIED_FAMILY &&
      allowed !== undefined &&
      allowed.includes(proposedSubFamily)
    ) {
      subFamily = proposedSubFamily;
    } else if (proposedSubFamily === UNCLASSIFIED_FAMILY) {
      subFamily = undefined;
    } else {
      issues.push({
        code: "subfamily_not_in_taxonomy",
        message: `subFamily「${proposedSubFamily}」不在所属 family 的 subFamilies 列表内，已丢弃`,
        proposed: proposedSubFamily,
      });
    }
  }

  let keyTechnique = optionalText(parsed, "keyTechnique", SURVEY_FIELD_LIMITS.keyTechnique);
  const assumption = optionalText(parsed, "assumption", SURVEY_FIELD_LIMITS.assumption);
  const datasetContext = optionalText(parsed, "datasetContext", SURVEY_FIELD_LIMITS.datasetContext);
  let strength = optionalText(parsed, "strength", SURVEY_FIELD_LIMITS.strength);
  let limitation = optionalText(parsed, "limitation", SURVEY_FIELD_LIMITS.limitation);

  let keyFindings = optionalTextArray(parsed, "keyFindings", 500);
  if (keyFindings !== undefined && keyFindings.length > KEY_FINDINGS_MAX) {
    issues.push({
      code: "key_findings_capped",
      message: `keyFindings 超过 ${KEY_FINDINGS_MAX} 条上限，已截断（模型给出 ${keyFindings.length} 条）`,
    });
    keyFindings = keyFindings.slice(0, KEY_FINDINGS_MAX);
  }

  const comparedMethods = normalizeComparedMethods(
    optionalTextArray(parsed, "comparedMethods", SURVEY_FIELD_LIMITS.comparedMethod),
  );

  // abstract_only 诚实降级：评价性 / 实证性字段需要全文依据，剥离并记账
  if (interpretationDepth === "abstract_only") {
    for (const field of ["strength", "limitation"] as const) {
      if (field === "strength" ? strength !== undefined : limitation !== undefined) {
        issues.push({
          code: "abstract_only_field_dropped",
          message: `abstract_only 条目不保留 ${field}（评价性字段需要全文依据），已剥离`,
        });
      }
    }
    if (keyFindings !== undefined) {
      issues.push({
        code: "abstract_only_field_dropped",
        message: "abstract_only 条目不保留 keyFindings（实证结论需要全文依据），已剥离",
      });
    }
    strength = undefined;
    limitation = undefined;
    keyFindings = undefined;
  }

  // anchors：形状校验（field ∈ 可锚定集；chunkIds 非空字符串数组）
  const anchors: SurveyFieldAnchor[] = [];
  const rawAnchors = parsed["anchors"];
  if (Array.isArray(rawAnchors)) {
    for (const raw of rawAnchors.slice(0, ANCHORS_MAX)) {
      if (typeof raw !== "object" || raw === null) {
        continue;
      }
      const record = raw as Record<string, unknown>;
      const field = record["field"];
      if (
        typeof field !== "string" ||
        !(SURVEY_ANCHORABLE_FIELDS as readonly string[]).includes(field)
      ) {
        issues.push({
          code: "anchor_field_invalid",
          message: `anchors[].field 非法（${String(field).slice(0, 40)}），已丢弃该条`,
        });
        continue;
      }
      const chunkIdsRaw = record["chunkIds"];
      if (!Array.isArray(chunkIdsRaw)) {
        continue;
      }
      const chunkIds = [
        ...new Set(
          chunkIdsRaw
            .filter((id): id is string => typeof id === "string" && id.trim() !== "")
            .map((id) => id.trim()),
        ),
      ];
      if (chunkIds.length === 0) {
        continue;
      }
      anchors.push({ field: field as SurveyAnchorableField, chunkIds });
    }
  }

  if (
    researchProblem === undefined &&
    mainIdea === undefined &&
    methodFamily === undefined
  ) {
    throw new AgentRunFailedError(
      `Survey Matrix 抽取结果为空（${sourceId}：researchProblem / mainIdea / methodFamily 全部缺失）`,
    );
  }

  const entry: SurveyMatrixEntry = {
    entryId: matrixEntryId(sourceId),
    sourceId,
    interpretationDepth,
    ...(researchProblem !== undefined ? { researchProblem } : {}),
    ...(methodFamily !== undefined ? { methodFamily } : {}),
    ...(subFamily !== undefined ? { subFamily } : {}),
    ...(mainIdea !== undefined ? { mainIdea } : {}),
    ...(keyTechnique !== undefined ? { keyTechnique } : {}),
    ...(assumption !== undefined ? { assumption } : {}),
    ...(datasetContext !== undefined ? { datasetContext } : {}),
    ...(strength !== undefined ? { strength } : {}),
    ...(limitation !== undefined ? { limitation } : {}),
    ...(comparedMethods.length > 0 ? { comparedMethods } : {}),
    ...(keyFindings !== undefined ? { keyFindings } : {}),
    anchors,
    status: "draft",
    ...(issues.length > 0 ? { issues } : {}),
    updatedAt: input.updatedAt,
  };
  return { entry, issues };
}
