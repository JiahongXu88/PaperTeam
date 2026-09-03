/**
 * M3.5 版本锚点防漂移测试：
 *   - statusService 的 SDK 版本常量 == backend/package.json 精确依赖
 *   - OPENCLAW_RUNTIME_VERSION == 根 package.json 的 openclaw devDependency
 *   - 依赖不允许 ^ / ~ / latest（可复现性）
 *   - 业务 Agent 默认映射 = OpenClaw 默认 agent（main，方案 A）
 */

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { OPENCLAW_RUNTIME_VERSION } from "../../src/dev/runtimeConfig.js";
import { GATEWAY_CLIENT_SDK_VERSION } from "../../src/runtime/statusService.js";

const backendDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = dirname(backendDir);

describe("OpenClaw 版本锚点（M3.5）", () => {
  it("backend 依赖：gateway-client / gateway-protocol 精确 pin 同一版本", async () => {
    const pkg = JSON.parse(await readFile(join(backendDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const client = pkg.dependencies?.["@openclaw/gateway-client"];
    const protocol = pkg.dependencies?.["@openclaw/gateway-protocol"];
    expect(client).toMatch(/^\d{4}\.\d+\.\d+$/); // 无 ^ ~ latest
    expect(protocol).toBe(client);
  });

  it("根 package.json：openclaw devDependency 精确 pin 且与 OPENCLAW_RUNTIME_VERSION 一致", async () => {
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>;
    };
    const runtime = pkg.devDependencies?.["openclaw"];
    expect(runtime).toMatch(/^\d{4}\.\d+\.\d+$/);
    expect(runtime).toBe(OPENCLAW_RUNTIME_VERSION);
  });

  it("statusService 的 SDK 版本常量与 backend 依赖一致", async () => {
    const pkg = JSON.parse(await readFile(join(backendDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(GATEWAY_CLIENT_SDK_VERSION).toBe(pkg.dependencies?.["@openclaw/gateway-client"]);
  });

  it("业务 Agent 默认映射 = main（config 缺省，方案 A）", async () => {
    const { loadConfig } = await import("../../src/config/config.js");
    const config = loadConfig({ OPENCLAW_GATEWAY_URL: "http://127.0.0.1:18789" });
    expect(config.agents).toEqual({
      writer: "main",
      researcher: "main",
      reviewer: "main",
      citation: "main",
    });
  });
});
