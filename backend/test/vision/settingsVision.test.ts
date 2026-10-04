/**
 * M10.2 settings 集成测试：visionModel 偏好（保存 / 清除 / 非法拒绝 /
 * 状态视图）+ deleteCustomProvider 联动清理。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { CustomProviderStore } from "../../src/settings/CustomProviderStore.js";
import { ModelSettingsService, type ModelSettingsRuntime } from "../../src/settings/ModelSettingsService.js";
import { ModelSettingsStore } from "../../src/settings/ModelSettingsStore.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 结构满足 VisionModelRuntime / ModelSettingsService 需要的最小 fake 目录 */
function fakeCatalog(models: Record<string, string[]>): ModelRuntime {
  return {
    getModel: (provider: string, modelId: string) =>
      models[`${provider}/${modelId}`] !== undefined ? ({ input: models[`${provider}/${modelId}`] } as never) : undefined,
    hasConfiguredAuth: () => true,
    getProviderAuthStatus: () => ({ configured: true, source: "runtime" }) as never,
    getProviders: () => [],
    getProvider: () => undefined,
    getModels: () => [],
    // Z.AI API 通道注册面（saveModel 末尾同步；fake 无 extension 层，no-op）
    registerProvider: () => {},
    unregisterProvider: () => {},
  } as unknown as ModelRuntime;
}

/** 结构满足 ModelSettingsRuntime 的最小 fake（整体断言，不做字段级 satisfies） */
const runtimeStub = {
  healthCheck: async () => ({ ok: true, status: "healthy", detail: "" }),
  modelStatusSnapshot: async () => ({ phase: "configured", providers: ["prov-a"], detail: "" }),
  reconfigure: async () => ({}),
  runtimeStats: () => ({ activeRuns: 0, managedSessions: 0 }),
} as unknown as ModelSettingsRuntime;

async function newService(models: Record<string, string[]>) {
  const root = await mkdtemp(join(tmpdir(), "paperteam-vsettings-"));
  roots.push(root);
  const store = new ModelSettingsStore({ settingsDir: join(root, "settings") });
  const customProviders = new CustomProviderStore({ settingsDir: join(root, "settings") });
  const service = new ModelSettingsService({
    modelRuntime: fakeCatalog(models),
    runtime: runtimeStub,
    store,
    customProviders,
    env: {},
    log: () => {},
  });
  return { service, store, customProviders, root };
}

describe("saveModel visionModel", () => {
  it("保存合法 image-capable 模型 → 状态视图 source=vision_setting", async () => {
    const { service } = await newService({
      "prov-a/model-text": ["text"],
      "prov-a/model-v": ["text", "image"],
    });
    const status = await service.saveModel({
      model: "prov-a/model-text",
      visionModel: "prov-a/model-v",
    });
    expect(status.vision).toMatchObject({
      savedModel: "prov-a/model-v",
      model: "prov-a/model-v",
      source: "vision_setting",
      authConfigured: true,
    });
  });

  it("visionModel=null 清除 → 回落到默认模型解析", async () => {
    const { service } = await newService({
      "prov-a/model-v": ["text", "image"],
      "prov-a/model-text": ["text"],
    });
    await service.saveModel({ model: "prov-a/model-text", visionModel: "prov-a/model-v" });
    const cleared = await service.saveModel({ model: "prov-a/model-text", visionModel: null });
    expect(cleared.vision).toMatchObject({ source: "unavailable", reason: "no_vision_model" });
  });

  it("text-only 模型作 visionModel → 400 拒绝（unknown/name 不算证据）", async () => {
    const { service } = await newService({
      "prov-a/fancy-gpt-vision-name": ["text"],
    });
    await expect(
      service.saveModel({ model: "prov-a/fancy-gpt-vision-name", visionModel: "prov-a/fancy-gpt-vision-name" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("不在目录的模型 → 400", async () => {
    const { service } = await newService({ "prov-a/model-text": ["text"] });
    await expect(
      service.saveModel({ model: "prov-a/model-text", visionModel: "prov-a/ghost-v" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("默认模型 image-capable 且无 visionModel → source=default_model 复用", async () => {
    const { service } = await newService({ "prov-a/model-text": ["text", "image"] });
    const status = await service.saveModel({ model: "prov-a/model-text" });
    expect(status.vision).toMatchObject({ model: "prov-a/model-text", source: "default_model" });
  });
});
