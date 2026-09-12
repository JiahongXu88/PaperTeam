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
    // 并发度默认（性能调优项，缺省即默认值）
    expect(config.review.reviewConcurrency).toBe(3);
    expect(config.review.summaryConcurrency).toBe(3);
    expect(config.review.reviewSectionLimit).toBe(0);
  });

  it("并发度配置：合法值被采用；非法值回退默认（不阻断启动）", () => {
    expect(loadConfig({ PAPERTEAM_REVIEW_CONCURRENCY: "1" }).review.reviewConcurrency).toBe(1);
    expect(loadConfig({ PAPERTEAM_REVIEW_CONCURRENCY: "8" }).review.reviewConcurrency).toBe(8);
    expect(loadConfig({ PAPERTEAM_SUMMARY_CONCURRENCY: "2" }).review.summaryConcurrency).toBe(2);
    expect(loadConfig({ PAPERTEAM_REVIEW_SECTION_LIMIT: "12" }).review.reviewSectionLimit).toBe(12);
    // 0 / 负数 / 超上限 / 非数字：静默回退默认（与 readInt 的报错语义相反——
    // 并发度是调优项，手滑不应让后端拒绝启动；"1.5" 按 parseInt 语义取 1，合法）
    for (const bad of ["0", "-3", "9", "1000", "abc"]) {
      expect(loadConfig({ PAPERTEAM_REVIEW_CONCURRENCY: bad }).review.reviewConcurrency).toBe(3);
      expect(loadConfig({ PAPERTEAM_SUMMARY_CONCURRENCY: bad }).review.summaryConcurrency).toBe(3);
    }
    for (const bad of ["-1", "41", "xyz"]) {
      expect(loadConfig({ PAPERTEAM_REVIEW_SECTION_LIMIT: bad }).review.reviewSectionLimit).toBe(0);
    }
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

  it("Runtime 全局并发/受理容量（M5.2）：默认 4/32；合法值采用；非法报 ConfigError（容量契约不静默回退）", () => {
    expect(loadConfig({}).pi.maxConcurrentRuns).toBe(4);
    expect(loadConfig({}).pi.maxQueuedRuns).toBe(32);
    expect(loadConfig({ PAPERTEAM_PI_MAX_CONCURRENT_RUNS: "1" }).pi.maxConcurrentRuns).toBe(1);
    expect(loadConfig({ PAPERTEAM_PI_MAX_CONCURRENT_RUNS: "64" }).pi.maxConcurrentRuns).toBe(64);
    expect(loadConfig({ PAPERTEAM_PI_MAX_QUEUED_RUNS: "0" }).pi.maxQueuedRuns).toBe(0);
    expect(loadConfig({ PAPERTEAM_PI_MAX_QUEUED_RUNS: "256" }).pi.maxQueuedRuns).toBe(256);
    // 并发上限：0 / 负数 / 非数字 / 超上限 → 启动报错
    for (const bad of ["0", "-1", "abc", "65"]) {
      expect(() => loadConfig({ PAPERTEAM_PI_MAX_CONCURRENT_RUNS: bad })).toThrow(ConfigError);
    }
    // 等待容量：负数 / 非数字 / 超上限 → 启动报错（0 合法 = 不允许等待）
    for (const bad of ["-1", "abc", "1025"]) {
      expect(() => loadConfig({ PAPERTEAM_PI_MAX_QUEUED_RUNS: bad })).toThrow(ConfigError);
    }
  });

  it("M5.2 长程治理容量（rotation/TTL/会话数/预留）：默认采用；非法报 ConfigError", () => {
    const defaults = loadConfig({}).pi;
    expect(defaults.maxRunsPerSession).toBe(32);
    expect(defaults.sessionIdleTtlMs).toBe(1_800_000); // 30 分钟
    expect(defaults.maxSessions).toBe(16);
    expect(defaults.outputReserveTokens).toBeUndefined(); // 缺省按 resolved model 推导
    // 合法值采用
    expect(loadConfig({ PAPERTEAM_PI_MAX_RUNS_PER_SESSION: "100" }).pi.maxRunsPerSession).toBe(100);
    expect(loadConfig({ PAPERTEAM_PI_SESSION_IDLE_TTL_MS: "3600000" }).pi.sessionIdleTtlMs).toBe(3_600_000);
    expect(loadConfig({ PAPERTEAM_PI_MAX_SESSIONS: "64" }).pi.maxSessions).toBe(64);
    expect(loadConfig({ PAPERTEAM_PI_OUTPUT_RESERVE_TOKENS: "8192" }).pi.outputReserveTokens).toBe(8192);
    // 非法值启动报错（容量契约不静默回退）
    for (const bad of ["0", "-1", "abc", "10001"]) {
      expect(() => loadConfig({ PAPERTEAM_PI_MAX_RUNS_PER_SESSION: bad })).toThrow(ConfigError);
    }
    for (const bad of ["59999", "abc", "90000000"]) {
      expect(() => loadConfig({ PAPERTEAM_PI_SESSION_IDLE_TTL_MS: bad })).toThrow(ConfigError);
    }
    for (const bad of ["0", "-1", "abc", "257"]) {
      expect(() => loadConfig({ PAPERTEAM_PI_MAX_SESSIONS: bad })).toThrow(ConfigError);
    }
    for (const bad of ["1023", "abc", "262145"]) {
      expect(() => loadConfig({ PAPERTEAM_PI_OUTPUT_RESERVE_TOKENS: bad })).toThrow(ConfigError);
    }
  });

  it("模型规格不做格式前置校验（由 Runtime 层结构化报告）", () => {
    const config = loadConfig({ PAPERTEAM_PI_MODEL: "anything" });
    expect(config.pi.model).toBe("anything");
  });
});
