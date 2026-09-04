import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

import { ConfigError, loadConfig, resolveRuntimeRoot } from "../src/config/config.js";

describe("loadConfig", () => {
  it("合法配置：解析端口与 Pi Runtime 配置", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      PAPERTEAM_PORT: "8123",
      PAPERTEAM_PI_MODEL: "anthropic/claude-opus-4-5",
      PAPERTEAM_PI_API_KEY: "secret-key",
    });

    expect(config.env).toBe("production");
    expect(config.port).toBe(8123);
    expect(config.pi.model).toBe("anthropic/claude-opus-4-5");
    expect(config.pi.apiKey).toBe("secret-key");
  });

  it("可选配置缺省时使用默认值（无必填项：Pi in-process 无 Gateway 地址）", () => {
    const config = loadConfig({});

    expect(config.env).toBe("development");
    expect(config.port).toBe(3000);
    expect(config.pi.model).toBeUndefined();
    expect(config.pi.apiKey).toBeUndefined();
    expect(config.pi.runTimeoutMs).toBe(300_000);
    // agentDir 默认落在用户级 Runtime 根下
    expect(config.pi.agentDir).toBe(join(homedir(), ".paperteam", "runtime", "pi", "agent"));
    // 会话标识默认沿用 M3.7 验证基线
    expect(config.agents).toEqual({
      writer: "main",
      researcher: "main",
      reviewer: "main",
      citation: "main",
    });
  });

  it("PAPERTEAM_PI_AGENT_DIR 显式指定时被采用", () => {
    const config = loadConfig({ PAPERTEAM_PI_AGENT_DIR: "D:/pt/pi-agent" });
    expect(config.pi.agentDir).toBe("D:/pt/pi-agent");
  });

  it("PAPERTEAM_RUNTIME_ROOT 影响 agentDir 默认值；相对路径拒绝", () => {
    const config = loadConfig({ PAPERTEAM_RUNTIME_ROOT: "D:/pt-root" });
    expect(config.pi.agentDir).toBe(join("D:/pt-root", "runtime", "pi", "agent"));
    expect(() => loadConfig({ PAPERTEAM_RUNTIME_ROOT: "relative/path" })).toThrow(ConfigError);
  });

  it("resolveRuntimeRoot：默认 ~/.paperteam；绝对路径覆盖", () => {
    expect(resolveRuntimeRoot({}, "H:/home")).toBe(join("H:/home", ".paperteam"));
    expect(resolveRuntimeRoot({ PAPERTEAM_RUNTIME_ROOT: "H:\\custom" }, "H:/home")).toBe(
      "H:\\custom",
    );
  });

  it("会话标识可覆盖且校验字符集", () => {
    const config = loadConfig({
      PAPERTEAM_WRITER_AGENT_ID: "writer-x",
      PAPERTEAM_RESEARCHER_AGENT_ID: "researcher-y",
    });
    expect(config.agents.writer).toBe("writer-x");
    expect(config.agents.researcher).toBe("researcher-y");
    expect(() =>
      loadConfig({ PAPERTEAM_REVIEWER_AGENT_ID: "bad id!" }),
    ).toThrow(ConfigError);
  });

  it("PAPERTEAM_PORT 非法时抛出明确错误", () => {
    expect(() => loadConfig({ PAPERTEAM_PORT: "abc" })).toThrow(ConfigError);
    expect(() => loadConfig({ PAPERTEAM_PORT: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ PAPERTEAM_PORT: "70000" })).toThrow(ConfigError);
  });

  it("NODE_ENV 非法时抛出明确错误", () => {
    expect(() => loadConfig({ NODE_ENV: "staging" })).toThrow(ConfigError);
  });

  it("Pi run 超时配置非法时抛出明确错误；合法时被采用", () => {
    expect(() => loadConfig({ PAPERTEAM_PI_RUN_TIMEOUT_MS: "abc" })).toThrow(ConfigError);
    expect(() => loadConfig({ PAPERTEAM_PI_RUN_TIMEOUT_MS: "10" })).toThrow(ConfigError);
    const config = loadConfig({ PAPERTEAM_PI_RUN_TIMEOUT_MS: "2000" });
    expect(config.pi.runTimeoutMs).toBe(2000);
  });

  it("模型规格不做格式前置校验（由 Runtime 层结构化报告）", () => {
    const config = loadConfig({ PAPERTEAM_PI_MODEL: "anything" });
    expect(config.pi.model).toBe("anything");
  });
});
