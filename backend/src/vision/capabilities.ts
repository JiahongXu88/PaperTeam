/**
 * Vision capability 解析（M10.2 §6/§7）。
 *
 * 只做两 slot 选择：显式 visionModel > defaultModel（须已确认 image input）。
 * 不做成本路由 / 多模型 benchmark / failover——那是明确禁止的 Model Router。
 *
 * 能力判定唯一依据：Pi 模型目录的 Model.input 元数据（`["text","image"]`）。
 * 绝不按模型名字符串猜（模型名含 gpt / opus 等字样一律不算证据）。缺目录
 * 条目或缺 input 元数据 = unknown ≠ vision supported —— 保守判为不可用（§7）。
 */

import { parseModelSpec } from "../runtime/PiRuntimeAdapter.js";
import type { VisionModelCandidates, VisionModelCatalog, VisionModelSelection } from "./types.js";

/** 目录条目是否声明支持 image input（unknown → false，保守处理） */
export function isImageCapable(entry: { input?: readonly string[] } | undefined): boolean {
  return Array.isArray(entry?.input) && (entry?.input as readonly string[]).includes("image");
}

/**
 * 解析 Vision 模型选择。
 *
 * 顺序（§6）：
 * 1. 显式 visionModel（settings 保存）——目录不存在 / 无 image 能力 / 无凭据
 *    都判不可用（显式配置坏了要如实报，不静默回落默认模型）；
 * 2. defaultModel（env PAPERTEAM_PI_MODEL > settings model）——仅当目录确认
 *    image input 且有凭据才复用；
 * 3. 都不行 → available=false（调用方按 capability unavailable 处理，不调用）。
 */
export function resolveVisionModel(
  catalog: VisionModelCatalog,
  candidates: VisionModelCandidates,
): VisionModelSelection {
  if (candidates.visionModel !== undefined && candidates.visionModel.trim() !== "") {
    return selectSpecified(catalog, candidates.visionModel.trim(), "vision_setting");
  }
  if (candidates.defaultModel !== undefined && candidates.defaultModel.trim() !== "") {
    return selectSpecified(catalog, candidates.defaultModel.trim(), "default_model");
  }
  return {
    available: false,
    reason: "not_configured",
    detail: "未配置任何模型（默认模型与 Vision 模型均为空）",
  };
}

function selectSpecified(
  catalog: VisionModelCatalog,
  modelSpec: string,
  source: "vision_setting" | "default_model",
): VisionModelSelection {
  const label = source === "vision_setting" ? "Vision 模型" : "默认模型";
  const parsed = parseModelSpec(modelSpec);
  if (parsed === undefined) {
    return {
      available: false,
      reason: "model_not_in_catalog",
      detail: `${label}规格非法："${modelSpec}"（应为 provider/model-id）`,
    };
  }
  const entry = catalog.getModel(parsed.provider, parsed.modelId);
  if (entry === undefined) {
    return {
      available: false,
      reason: "model_not_in_catalog",
      detail: `${label} ${modelSpec} 不在模型目录`,
    };
  }
  if (!isImageCapable(entry)) {
    return {
      available: false,
      reason: "no_vision_model",
      detail: `${label} ${modelSpec} 未声明 image input 能力（目录 input=${JSON.stringify(entry.input ?? null)}；unknown 保守判为不可用）`,
    };
  }
  if (!catalog.hasConfiguredAuth(parsed.provider)) {
    return {
      available: false,
      reason: "auth_missing",
      detail: `${label} ${modelSpec} 的 provider ${parsed.provider} 无可用凭据`,
    };
  }
  return {
    available: true,
    modelSpec,
    provider: parsed.provider,
    modelId: parsed.modelId,
    catalogEntry: entry,
    source,
  };
}
