import { describe, expect, it } from "vitest";

import { HF_MIRROR_ENDPOINT, resolveDefaultHfEndpoint } from "../../src/ingestion/hfEndpoint.js";

describe("M15.3.3 B3.5 HF 端点缺省解析（无网络单测）", () => {
  it("未设置（undefined）→ 国内镜像缺省（本机行为不变）", () => {
    expect(HF_MIRROR_ENDPOINT).toBe("https://hf-mirror.com");
    expect(resolveDefaultHfEndpoint(undefined)).toBe("https://hf-mirror.com");
  });

  it("CI 显式设置官方源 → 原样透传，不得被镜像缺省覆盖", () => {
    expect(resolveDefaultHfEndpoint("https://huggingface.co")).toBe("https://huggingface.co");
  });

  it("任意显式值（自建网关/代理）原样保留", () => {
    expect(resolveDefaultHfEndpoint("https://hf.example.internal")).toBe("https://hf.example.internal");
  });

  it("空串视为显式设置（守卫只认 undefined，与 huggingface_hub 端点解析语义一致）", () => {
    expect(resolveDefaultHfEndpoint("")).toBe("");
  });
});
