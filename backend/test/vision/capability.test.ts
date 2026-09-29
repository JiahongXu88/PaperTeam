/**
 * M10.2 Vision capability 解析测试（§6/§7）：
 * - 两 slot 顺序：显式 visionModel > defaultModel；
 * - 能力判定唯一依据 = 目录 Model.input（名字字符串不算证据）；
 * - unknown ≠ vision supported（保守判不可用）；
 * - 无凭据 / 不在目录 / 未配置 → available=false（调用方不调用模型）。
 */

import { describe, expect, it } from "vitest";

import { isImageCapable, resolveVisionModel } from "../../src/vision/capabilities.js";
import { FakeVisionModelRuntime } from "./fixtures.js";

describe("isImageCapable", () => {
  it("目录声明 image input 才算 vision-capable", () => {
    expect(isImageCapable({ input: ["text", "image"] })).toBe(true);
    expect(isImageCapable({ input: ["text"] })).toBe(false);
  });

  it("缺 input 元数据（unknown）保守判为不可用", () => {
    expect(isImageCapable(undefined)).toBe(false);
    expect(isImageCapable({})).toBe(false);
  });
});

describe("resolveVisionModel", () => {
  it("未配置任何模型 → not_configured", () => {
    const model = new FakeVisionModelRuntime();
    const selection = resolveVisionModel(model, {});
    expect(selection.available).toBe(false);
    expect(selection).toMatchObject({ reason: "not_configured" });
  });

  it("显式 visionModel 优先且可用 → vision_setting", () => {
    const model = new FakeVisionModelRuntime();
    const selection = resolveVisionModel(model, {
      visionModel: "prov-a/model-v",
      defaultModel: "prov-a/model-text",
    });
    expect(selection).toMatchObject({
      available: true,
      modelSpec: "prov-a/model-v",
      source: "vision_setting",
    });
  });

  it("未配置 visionModel 但默认模型 image-capable → 复用 default_model", () => {
    const model = new FakeVisionModelRuntime();
    model.catalogInputs.set("prov-a/model-text-v", ["text", "image"]);
    const selection = resolveVisionModel(model, { defaultModel: "prov-a/model-text-v" });
    expect(selection).toMatchObject({
      available: true,
      modelSpec: "prov-a/model-text-v",
      source: "default_model",
    });
  });

  it("默认模型不支持 image input → no_vision_model（不按名字猜）", () => {
    const model = new FakeVisionModelRuntime();
    model.catalogInputs.set("prov-a/gpt-opus-fancy", ["text"]); // 名字像多模态但目录说 text-only
    const selection = resolveVisionModel(model, { defaultModel: "prov-a/gpt-opus-fancy" });
    expect(selection).toMatchObject({ available: false, reason: "no_vision_model" });
  });

  it("目录条目缺 input 元数据（unknown）→ 保守 no_vision_model", () => {
    const model = new FakeVisionModelRuntime();
    model.catalogInputs.set("prov-a/unknown-inputs", []);
    const selection = resolveVisionModel(model, { defaultModel: "prov-a/unknown-inputs" });
    expect(selection).toMatchObject({ available: false, reason: "no_vision_model" });
  });

  it("显式 visionModel 不在目录 → model_not_in_catalog（不静默回落默认）", () => {
    const model = new FakeVisionModelRuntime();
    model.catalogInputs.set("prov-a/model-v", undefined as never);
    const getModel = model.getModel.bind(model);
    model.getModel = (provider, id) =>
      `${provider}/${id}` === "prov-a/model-v" ? undefined : getModel(provider, id);
    const selection = resolveVisionModel(model, {
      visionModel: "prov-a/model-v",
      defaultModel: "prov-b/model-text",
    });
    expect(selection).toMatchObject({ available: false, reason: "model_not_in_catalog" });
  });

  it("provider 无凭据 → auth_missing", () => {
    const model = new FakeVisionModelRuntime();
    model.authProviders.delete("prov-a");
    const selection = resolveVisionModel(model, { visionModel: "prov-a/model-v" });
    expect(selection).toMatchObject({ available: false, reason: "auth_missing" });
  });

  it("规格非法（无 provider 段）→ model_not_in_catalog", () => {
    const model = new FakeVisionModelRuntime();
    const selection = resolveVisionModel(model, { visionModel: "no-slash-spec" });
    expect(selection).toMatchObject({ available: false, reason: "model_not_in_catalog" });
  });
});
