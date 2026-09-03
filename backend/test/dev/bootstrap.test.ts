/**
 * M3.5 Runtime Bootstrap 单元测试：
 * 路径隔离 / runtime.json 配置 / OpenClaw state 准备 / 版本校验 /
 * Gateway 子进程环境 / 健康等待。
 * 全部使用注入的 IO / fetch / sleep，不真正安装或联网。
 */

import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  BootstrapError,
  PAPERTEAM_RUNTIME_ROOT_ENV,
  resolveRuntimePaths,
} from "../../src/dev/runtimePaths.js";
import {
  loadRuntimeConfig,
  OPENCLAW_RUNTIME_VERSION,
  redactGatewayToken,
  summarizeRuntimeConfig,
} from "../../src/dev/runtimeConfig.js";
import {
  MINIMAL_OPENCLAW_CONFIG,
  gatewayProcessEnv,
  prepareOpenClawState,
  resolveOpenClawInstall,
} from "../../src/dev/openclawState.js";
import { waitForGatewayHealth } from "../../src/dev/gatewayHealth.js";

// ---- 内存 IO fake ----

function memoryIo(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    io: {
      mkdir: async (path: string) => {
        dirs.add(path);
      },
      readFile: async (path: string) => {
        const content = files.get(path);
        if (content === undefined) {
          const error = new Error("ENOENT") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return content;
      },
      writeFile: async (path: string, content: string) => {
        files.set(path, content);
      },
    },
  };
}

const HOME = process.platform === "win32" ? "C:\\Users\\test" : "/home/test";
const homeOpenClaw = join(HOME, ".openclaw");

describe("resolveRuntimePaths：独立 state 与全局隔离", () => {
  it("默认布局：<home>/.paperteam/runtime/openclaw", () => {
    const paths = resolveRuntimePaths({}, HOME);
    expect(paths.root).toBe(join(HOME, ".paperteam"));
    expect(paths.openclawStateDir).toBe(join(HOME, ".paperteam", "runtime", "openclaw"));
    expect(paths.openclawConfigPath).toBe(
      join(HOME, ".paperteam", "runtime", "openclaw", "openclaw.json"),
    );
    expect(paths.runtimeConfigPath).toBe(join(HOME, ".paperteam", "runtime", "runtime.json"));
    expect(paths.openclawEnvPath).toBe(join(HOME, ".paperteam", "runtime", "openclaw", ".env"));
  });

  it("PAPERTEAM_RUNTIME_ROOT 覆盖到任意绝对路径", () => {
    const custom = process.platform === "win32" ? "D:\\pt-runtime" : "/tmp/pt-runtime";
    const paths = resolveRuntimePaths({ [PAPERTEAM_RUNTIME_ROOT_ENV]: custom }, HOME);
    expect(paths.root).toBe(custom);
    expect(paths.openclawStateDir.startsWith(custom)).toBe(true);
  });

  it("覆盖为 ~/.openclaw 本身 → 拒绝（STATE_DIR_NOT_ISOLATED）", () => {
    expect(() => resolveRuntimePaths({ [PAPERTEAM_RUNTIME_ROOT_ENV]: homeOpenClaw }, HOME)).toThrow(
      BootstrapError,
    );
    try {
      resolveRuntimePaths({ [PAPERTEAM_RUNTIME_ROOT_ENV]: homeOpenClaw }, HOME);
    } catch (error) {
      expect((error as BootstrapError).code).toBe("STATE_DIR_NOT_ISOLATED");
    }
  });

  it("覆盖到 ~/.openclaw 内部（state 落在全局目录之下）→ 拒绝嵌套", () => {
    expect(() =>
      resolveRuntimePaths({ [PAPERTEAM_RUNTIME_ROOT_ENV]: join(HOME, ".openclaw", "sub") }, HOME),
    ).toThrow(/嵌套/);
  });

  it("与 ~/.openclaw 平级的目录 → 允许（兄弟目录不冲突）", () => {
    const paths = resolveRuntimePaths({ [PAPERTEAM_RUNTIME_ROOT_ENV]: HOME }, HOME);
    expect(paths.openclawStateDir.startsWith(HOME)).toBe(true);
  });

  it("相对路径覆盖 → 拒绝", () => {
    expect(() => resolveRuntimePaths({ [PAPERTEAM_RUNTIME_ROOT_ENV]: "relative/path" }, HOME)).toThrow(
      /绝对路径/,
    );
  });
});

describe("loadRuntimeConfig：runtime.json 读取 / 生成 / 校验", () => {
  const dir = process.platform === "win32" ? "C:\\rt" : "/rt";
  const configPath = join(dir, "runtime.json");

  it("首次运行：生成默认配置并落盘（含随机 token、精确版本）", async () => {
    const { io, files } = memoryIo();
    const config = await loadRuntimeConfig(configPath, {}, io);
    expect(config.openclawVersion).toBe(OPENCLAW_RUNTIME_VERSION);
    expect(config.gatewayPort).toBe(18790);
    expect(config.backendPort).toBe(3000);
    expect(config.gatewayToken).toMatch(/^[0-9a-f]{64}$/);
    // 落盘内容完整且是合法 JSON
    const saved = JSON.parse(files.get(configPath) ?? "{}") as Record<string, unknown>;
    expect(saved["gatewayToken"]).toBe(config.gatewayToken);
    expect(saved["openclawVersion"]).toBe(OPENCLAW_RUNTIME_VERSION);
  });

  it("再次运行：复用文件中的 token 与端口（不重新生成）", async () => {
    const existing = {
      openclawVersion: OPENCLAW_RUNTIME_VERSION,
      gatewayPort: 18800,
      backendPort: 3100,
      gatewayToken: "fixed-token-abcdefghijklmnop",
    };
    const { io, files } = memoryIo({ [configPath]: JSON.stringify(existing) });
    const config = await loadRuntimeConfig(configPath, {}, io);
    expect(config.gatewayPort).toBe(18800);
    expect(config.backendPort).toBe(3100);
    expect(config.gatewayToken).toBe("fixed-token-abcdefghijklmnop");
    // 未重写文件
    expect(files.get(configPath)).toBe(JSON.stringify(existing));
  });

  it("环境变量覆盖端口与 token（不写回文件）", async () => {
    const { io, files } = memoryIo();
    const config = await loadRuntimeConfig(
      configPath,
      { PAPERTEAM_DEV_GATEWAY_PORT: "19001", PAPERTEAM_DEV_BACKEND_PORT: "3200", PAPERTEAM_DEV_GATEWAY_TOKEN: "env-token-0123456789abcdef" },
      io,
    );
    expect(config.gatewayPort).toBe(19001);
    expect(config.backendPort).toBe(3200);
    expect(config.gatewayToken).toBe("env-token-0123456789abcdef");
    const saved = JSON.parse(files.get(configPath) ?? "{}") as Record<string, unknown>;
    expect(saved["gatewayPort"]).toBe(18790); // 文件保持默认
    expect(saved["gatewayToken"]).not.toBe(config.gatewayToken);
  });

  it("非法端口 / token / 版本 → 结构化报错", async () => {
    await expect(
      loadRuntimeConfig(configPath, { PAPERTEAM_DEV_GATEWAY_PORT: "70000" }, memoryIo().io),
    ).rejects.toThrow(/1-65535/);
    await expect(
      loadRuntimeConfig(
        configPath,
        {},
        memoryIo({ [configPath]: JSON.stringify({ gatewayPort: "x" }) }).io,
      ),
    ).rejects.toThrow(/gatewayPort/);
    await expect(
      loadRuntimeConfig(
        configPath,
        {},
        memoryIo({ [configPath]: JSON.stringify({ openclawVersion: "^2026.8.0" }) }).io,
      ),
    ).rejects.toThrow(/精确版本/);
    await expect(
      loadRuntimeConfig(
        configPath,
        {},
        memoryIo({ [configPath]: "{ not json" }).io,
      ),
    ).rejects.toThrow(/不是合法 JSON/);
  });

  it("token 脱敏与配置摘要不泄露完整 token", () => {
    expect(redactGatewayToken("abcdefghijklmnop")).toBe("abcd****");
    expect(redactGatewayToken("abc")).toBe("****");
    const summary = summarizeRuntimeConfig({
      openclawVersion: "2026.8.2",
      gatewayPort: 18790,
      backendPort: 3000,
      gatewayToken: "secret-secret-secret-secret",
    });
    expect(JSON.stringify(summary)).not.toContain("secret-secret-secret-secret");
    expect(summary.gatewayToken).toBe("secr****");
  });
});

describe("prepareOpenClawState / resolveOpenClawInstall", () => {
  it("首次：创建 state 目录并写最小 config（gateway.mode=local）", async () => {
    const { io, files } = memoryIo();
    const state = await prepareOpenClawState(
      { openclawStateDir: "C:\\s", openclawConfigPath: "C:\\s\\openclaw.json" },
      io,
    );
    expect(state.created).toBe(true);
    expect(files.get("C:\\s\\openclaw.json")).toBe(MINIMAL_OPENCLAW_CONFIG);
    expect(JSON.parse(MINIMAL_OPENCLAW_CONFIG)).toEqual({ gateway: { mode: "local" } });
  });

  it("已存在：不覆盖用户自定义 config", async () => {
    const custom = JSON.stringify({ gateway: { mode: "local", port: 18999 }, agents: {} });
    const { io, files } = memoryIo({ "C:\\s\\openclaw.json": custom });
    const state = await prepareOpenClawState(
      { openclawStateDir: "C:\\s", openclawConfigPath: "C:\\s\\openclaw.json" },
      io,
    );
    expect(state.created).toBe(false);
    expect(files.get("C:\\s\\openclaw.json")).toBe(custom);
  });

  it("版本一致：返回入口路径", async () => {
    const root = process.platform === "win32" ? "D:\\repo" : "/repo";
    const { io } = memoryIo({
      [`${root.replaceAll("\\", "/")}/node_modules/openclaw/package.json`]: JSON.stringify({
        version: OPENCLAW_RUNTIME_VERSION,
      }),
    });
    const install = await resolveOpenClawInstall(root, OPENCLAW_RUNTIME_VERSION, io);
    expect(install.version).toBe(OPENCLAW_RUNTIME_VERSION);
    expect(install.entryPath.endsWith("node_modules/openclaw/openclaw.mjs")).toBe(true);
  });

  it("版本漂移 / 未安装 → 明确报错", async () => {
    const root = "D:\\repo";
    const drift = memoryIo({
      "D:/repo/node_modules/openclaw/package.json": JSON.stringify({ version: "2026.7.9" }),
    });
    await expect(resolveOpenClawInstall(root, OPENCLAW_RUNTIME_VERSION, drift.io)).rejects.toThrow(
      /2026\.7\.9.*2026\.8\.2|版本/,
    );
    await expect(resolveOpenClawInstall(root, OPENCLAW_RUNTIME_VERSION, memoryIo().io)).rejects.toThrow(
      /npm install/,
    );
  });
});

describe("gatewayProcessEnv：实例隔离环境", () => {
  const state = { stateDir: "C:\\pt\\openclaw", configPath: "C:\\pt\\openclaw\\openclaw.json", created: true };

  it("注入 STATE_DIR / CONFIG_PATH / TOKEN，剔除 OPENCLAW_PROFILE", () => {
    const env = gatewayProcessEnv(state, { gatewayToken: "tok" }, {
      OPENCLAW_STATE_DIR: "C:\\Users\\global\\.openclaw",
      OPENCLAW_CONFIG_PATH: "C:\\Users\\global\\.openclaw\\openclaw.json",
      OPENCLAW_PROFILE: "work",
      OPENCLAW_GATEWAY_TOKEN: "wrong-token",
      PATH: "C:\\bin",
    } as Record<string, string | undefined>);
    expect(env["OPENCLAW_STATE_DIR"]).toBe("C:\\pt\\openclaw");
    expect(env["OPENCLAW_CONFIG_PATH"]).toBe("C:\\pt\\openclaw\\openclaw.json");
    expect(env["OPENCLAW_GATEWAY_TOKEN"]).toBe("tok");
    expect(env["OPENCLAW_PROFILE"]).toBeUndefined();
    expect(env["PATH"]).toBe("C:\\bin");
  });
});

describe("waitForGatewayHealth", () => {
  const okResponse = () =>
    new Response(JSON.stringify({ ok: true, status: "live" }), { status: 200 });

  it("首次探测即通过", async () => {
    const result = await waitForGatewayHealth("http://127.0.0.1:18790", {
      fetchImpl: (async () => okResponse()) as unknown as typeof fetch,
      sleep: async () => {},
    });
    expect(result.attempts).toBe(1);
  });

  it("先拒绝后通过：重试直到健康", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error("connect ECONNREFUSED");
      }
      return okResponse();
    }) as unknown as typeof fetch;
    const polls: string[] = [];
    const result = await waitForGatewayHealth("http://127.0.0.1:18790", {
      fetchImpl,
      sleep: async () => {},
      onPoll: (_attempt, detail) => polls.push(detail),
    });
    expect(result.attempts).toBe(3);
    expect(polls).toHaveLength(2);
  });

  it("持续不可达 → 超时 BootstrapError（GATEWAY_STARTUP_TIMEOUT）", async () => {
    await expect(
      waitForGatewayHealth("http://127.0.0.1:18790", {
        timeoutMs: 50,
        intervalMs: 10,
        fetchImpl: (async () => {
          throw new Error("connect ECONNREFUSED");
        }) as unknown as typeof fetch,
        sleep: async () => {},
      }),
    ).rejects.toThrow(BootstrapError);
  });

  it("200 但响应体缺 ok:true → 视为不健康", async () => {
    await expect(
      waitForGatewayHealth("http://127.0.0.1:18790", {
        timeoutMs: 30,
        intervalMs: 10,
        fetchImpl: (async () => new Response("<html>502</html>", { status: 502 })) as unknown as typeof fetch,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/HTTP 502/);
  });
});
