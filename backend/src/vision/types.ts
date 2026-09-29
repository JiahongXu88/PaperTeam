/**
 * M10.2 Minimal Multimodal Document Understanding：数据模型与常量。
 *
 * 唯一职责：把 M10.1 / M10.1.1 已登记的 ParsedFigureBlock 资产交给
 * Vision-capable Model，得到结构化 FigureAnalysis（Derived Context）。
 *
 * 语义红线（与 M10.1 Evidence 纪律同源）：
 * - Parser Fact（page / bbox / assetName / caption / width / height ——
 *   ParsedDocument 内、解析器产生）与 Model Interpretation（本模块产物）
 *   是两个事实层：Vision 输出绝不回写 sources/parsed/<id>.document.json；
 * - FigureAnalysis ≠ Evidence：candidateFacts 只是候选知识，进 EvidenceStore
 *   必须用户显式确认（verificationLevel=user_confirmed、status=unverified）；
 *   grounded_verified 分级（verified + 三件套锚点）不受任何影响；
 * - 换模型 / 重解析 → 旧分析按 freshness 键失效重建，ParsedDocument 不动。
 */

import type { BBox } from "../ingestion/types.js";

/** 图类型小分类（刻意少；不做大 taxonomy） */
export type FigureType = "chart" | "diagram" | "table_image" | "screenshot" | "photo" | "unknown";

export const FIGURE_TYPES: readonly FigureType[] = [
  "chart",
  "diagram",
  "table_image",
  "screenshot",
  "photo",
  "unknown",
];

/** 模型自评置信度（候选事实级与图级同枚举） */
export type VisionConfidence = "high" | "medium" | "low";

export const VISION_CONFIDENCES: readonly VisionConfidence[] = ["high", "medium", "low"];

/**
 * 单图分析状态。pending 仅存在于内存（后台链执行中）；落盘产物只会有
 * 终态（completed / failed / skipped）——失败不伪装成功，跳过有原因。
 */
export type FigureAnalysisStatus = "pending" | "completed" | "failed" | "skipped";

/** 候选事实（模型读出的可确认陈述；确认前不是 Evidence） */
export interface FigureCandidateFact {
  /** 分析文档内稳定 id（F0001…，按 figure × 声明顺序；同输入重算一致） */
  factId: string;
  claim: string;
  /** 模型读出的值（数字 / 名称；无明确单值时缺省） */
  value?: string;
  confidence: VisionConfidence;
}

/** 分析失败的结构化原因（code 稳定，message 人读） */
export interface FigureAnalysisError {
  code:
    | "MODEL_UNAVAILABLE" // 未配置 / 无凭据 / 能力不可用（分析前判定）
    | "ASSET_MISSING" // 图片资产缺失（未落盘 / 目录被清）
    | "IMAGE_INVALID" // 非法图片（签名不符 / 解码失败）
    | "IMAGE_TOO_LARGE" // 超出单图字节上限
    | "UNSUPPORTED_MIME" // 仅支持 PNG / JPEG
    | "REQUEST_FAILED" // provider 请求失败（网络 / 服务端）
    | "RATE_LIMITED" // 限速
    | "TIMEOUT" // 超时
    | "INVALID_MODEL_OUTPUT" // 结构化输出解析 / 校验失败（含 1 次 repair 后仍失败）
    | "EMPTY_MODEL_OUTPUT"; // 模型返回空内容
  message: string;
}

/**
 * FigureAnalysis：单个 figure block 的 Vision 分析产物（Derived Context）。
 * provenance 字段是 Parser Fact 的拷贝（展示 / 检索锚用）——权威值永远在
 * ParsedDocument 的块上，这里不伪造也不扩展。
 */
export interface FigureAnalysis {
  schemaVersion: 1;
  analysisId: string;
  sourceId: string;
  /** 对应 ParsedFigureBlock.blockId（B0001…；Parser Fact 锚） */
  figureBlockId: string;
  status: FigureAnalysisStatus;
  /** 完成时的模型规格 "provider/model-id"（失败于调用前可缺省） */
  model?: string;
  provider?: string;
  figureType?: FigureType;
  description?: string;
  observations: string[];
  candidateFacts: FigureCandidateFact[];
  warnings: string[];
  confidence?: VisionConfidence;
  /** failed 时的结构化原因 */
  error?: FigureAnalysisError;
  /** skipped 时的原因码 + 说明 */
  skipReason?: string;
  skipNote?: string;
  /** 真实 usage（provider 返回才记录；拿不到缺省，不估算假成本） */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    /** 成本（USD；provider 报告才记录） */
    costUsd?: number;
  };
  /** ---- freshness 键（§18：三键全同才可复用）---- */
  /** 图片资产字节 sha256（无资产时为 null 占位——永不复用） */
  imageHash: string | null;
  /** 分析时的模型规格（换模型即失效） */
  analyzedModelSpec?: string;
  /** 分析输出 schema 版本（schema 演进即失效） */
  outputSchemaVersion: number;
  /** 分析时 source 的 contentHash（检索投影的新鲜度门） */
  sourceContentHash?: string;
  analyzedAt: string;
  /** Parser Fact 拷贝（展示 / 检索锚；权威值在 ParsedDocument） */
  provenance: {
    fileName: string;
    assetName?: string;
    caption?: string;
    width?: number;
    height?: number;
    page?: number;
    bbox?: BBox;
    cellIndex?: number;
    cellId?: string;
    outputIndex?: number;
  };
}

/** 单 source 的分析产物文件（sources/analysis/<sourceId>.vision.json） */
export interface VisionAnalysisDocument {
  schemaVersion: 1;
  sourceId: string;
  /** 按 figure block 一条（终态；pending 不落盘） */
  analyses: FigureAnalysis[];
  updatedAt: string;
}

/** 当前结构化输出 schema 版本（prompt / 校验 / freshness 三处共用） */
export const VISION_OUTPUT_SCHEMA_VERSION = 1;

/** 模型结构化输出（校验前的人读形状；校验归一见 VisionAnalyzer） */
export interface VisionStructuredOutput {
  description: string;
  figureType: FigureType;
  observations: string[];
  candidateFacts: Array<{ claim: string; value?: string; confidence: VisionConfidence }>;
  warnings: string[];
  confidence: VisionConfidence;
}

/** ---- 防御上限（显式降级不静默）---- */
export const VISION_LIMITS = {
  /** 单图字节上限（与 notebook 图片登记上限同口径） */
  maxImageBytes: 8 * 1024 * 1024,
  /** 单次模型调用超时（毫秒） */
  requestTimeoutMs: 120_000,
  /** 结构化输出解析失败后的 repair 重试次数（§25：至多 1 次） */
  maxRepairAttempts: 1,
  /** description / 单条 observation / 单条 claim 字符上限 */
  maxDescriptionChars: 2_000,
  maxObservationChars: 1_000,
  maxClaimChars: 1_000,
  /** observations / candidateFacts / warnings 条数上限 */
  maxObservations: 20,
  maxCandidateFacts: 20,
  maxWarnings: 10,
  /** figure 前后文本 context 预算（字符；两侧合计） */
  maxContextChars: 2_400,
  /** 单 source 并发分析的图片张数上限（防御超大文档） */
  maxFiguresPerSource: 50,
  /** 模型输出 maxTokens */
  maxOutputTokens: 4_096,
} as const;

/** ---- 模型接入 seam（Pi ModelRuntime 结构满足；测试可注入最小 fake）---- */

/** 目录 / 凭据能力子集 */
export interface VisionModelCatalog {
  /** 取模型目录条目（input 含 "image" = vision-capable；缺目录 = unknown） */
  getModel(providerId: string, modelId: string): { input?: readonly string[] } | undefined;
  /** provider 是否有可用凭据 */
  hasConfiguredAuth(providerId: string): boolean;
}

/** 直接模型调用子集（pi ModelRuntime.completeSimple 形状） */
export interface VisionModelCaller {
  completeSimple(
    model: unknown,
    context: { systemPrompt?: string; messages: unknown[] },
    options?: { maxTokens?: number; signal?: AbortSignal },
  ): Promise<{
    content?: ReadonlyArray<{ type?: string; text?: string }>;
    usage?: {
      input?: number;
      output?: number;
      totalTokens?: number;
      cost?: { total?: number | string };
    };
    stopReason?: string;
    errorMessage?: string;
  }>;
}

/** Vision 用的 ModelRuntime 能力子集（生产直接传 ModelRuntime 实例） */
export type VisionModelRuntime = VisionModelCatalog & VisionModelCaller;

/** Vision 不可用原因码（无模型可用时分析前置判定为 skipped 的依据） */
export type VisionUnavailableReason =
  | "not_configured" // 未配置任何模型
  | "no_vision_model" // 候选模型未声明 image input（unknown 保守判不可用）
  | "model_not_in_catalog" // 规格非法 / 不在模型目录
  | "auth_missing"; // provider 无可用凭据

/** 模型选择结果（§6/§7：两 slot —— visionModel 优先，default 可复用） */
export type VisionModelSelection =
  | {
      available: true;
      modelSpec: string;
      provider: string;
      modelId: string;
      /** 传给 completeSimple 的目录条目 */
      catalogEntry: unknown;
      source: "vision_setting" | "default_model";
    }
  | {
      available: false;
      reason: VisionUnavailableReason;
      detail: string;
    };

/** 模型偏好候选（serviceStack 注入：visionModel 设置 + 生效默认模型） */
export interface VisionModelCandidates {
  visionModel?: string;
  defaultModel?: string;
}
