import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/config/config.js";

describe("loadConfig", () => {
  it("合法配置：解析 Gateway URL、端口与 API Key", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      PAPERTEAM_PORT: "8123",
      OPENCLAW_GATEWAY_URL: "http://127.0.0.1:18789",
      OPENCLAW_GATEWAY_API_KEY: "secret-key",
    });

    expect(config.env).toBe("production");
    expect(config.port).toBe(8123);
    expect(config.gateway.url).toBe("http://127.0.0.1:18789");
    expect(config.gateway.apiKey).toBe("secret-key");
  });

  it("可选配置缺省时使用默认值", () => {
    const config = loadConfig({ OPENCLAW_GATEWAY_URL: "http://localhost:18789" });

    expect(config.env).toBe("development");
    expect(config.port).toBe(3000);
    expect(config.gateway.apiKey).toBeUndefined();
    expect(config.gateway.healthTimeoutMs).toBe(5000);
  });

  it("Gateway URL 尾部斜杠会被归一化", () => {
    const config = loadConfig({ OPENCLAW_GATEWAY_URL: "http://127.0.0.1:18789/" });
    expect(config.gateway.url).toBe("http://127.0.0.1:18789");
  });

  it("缺失 OPENCLAW_GATEWAY_URL 时抛出明确错误", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/OPENCLAW_GATEWAY_URL/);
    expect(() => loadConfig({ OPENCLAW_GATEWAY_URL: "   " })).toThrow(ConfigError);
  });

  it("OPENCLAW_GATEWAY_URL 不是 URL 时抛出明确错误", () => {
    expect(() => loadConfig({ OPENCLAW_GATEWAY_URL: "not-a-url" })).toThrow(ConfigError);
    expect(() => loadConfig({ OPENCLAW_GATEWAY_URL: "127.0.0.1:18789" })).toThrow(ConfigError);
  });

  it("OPENCLAW_GATEWAY_URL 协议不是 http(s) 时抛出明确错误", () => {
    expect(() => loadConfig({ OPENCLAW_GATEWAY_URL: "ftp://127.0.0.1:18789" })).toThrow(ConfigError);
    expect(() => loadConfig({ OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789" })).toThrow(ConfigError);
  });

  it("OPENCLAW_GATEWAY_URL 带查询串时拒绝", () => {
    expect(() =>
      loadConfig({ OPENCLAW_GATEWAY_URL: "http://127.0.0.1:18789?x=1" }),
    ).toThrow(ConfigError);
  });

  it("PAPERTEAM_PORT 非法时抛出明确错误", () => {
    expect(() => loadConfig(validEnv({ PAPERTEAM_PORT: "abc" }))).toThrow(ConfigError);
    expect(() => loadConfig(validEnv({ PAPERTEAM_PORT: "0" }))).toThrow(ConfigError);
    expect(() => loadConfig(validEnv({ PAPERTEAM_PORT: "70000" }))).toThrow(ConfigError);
  });

  it("NODE_ENV 非法时抛出明确错误", () => {
    expect(() => loadConfig(validEnv({ NODE_ENV: "staging" }))).toThrow(ConfigError);
  });

  it("健康检查超时配置非法时抛出明确错误", () => {
    expect(() =>
      loadConfig(validEnv({ OPENCLAW_GATEWAY_HEALTH_TIMEOUT_MS: "abc" })),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig(validEnv({ OPENCLAW_GATEWAY_HEALTH_TIMEOUT_MS: "10" })),
    ).toThrow(ConfigError);
  });

  it("健康检查超时配置合法时被采用", () => {
    const config = loadConfig(validEnv({ OPENCLAW_GATEWAY_HEALTH_TIMEOUT_MS: "2000" }));
    expect(config.gateway.healthTimeoutMs).toBe(2000);
  });
});

function validEnv(overrides: Record<string, string>): Record<string, string> {
  return { OPENCLAW_GATEWAY_URL: "http://127.0.0.1:18789", ...overrides };
}
