/**
 * M12.2.5 双运行时配置隔离（Smoke 6 的自动化形态）。
 *
 * Dual-runtime 契约：两台机器（公司 Windows / 个人 Linux）各自持有完全独立的
 * 模型配置与 credentials——代码同步、credentials 不同步。隔离的机制性保证是
 * 「一切机器本地配置都挂在 PAPERTEAM_RUNTIME_ROOT 下」：
 *
 *   <runtimeRoot>/settings/model.json            非敏感模型偏好
 *   <runtimeRoot>/settings/custom-providers.json 自定义 Provider
 *   <runtimeRoot>/runtime/pi/agent/auth.json     Pi credentials（API Key）
 *
 * 本测试用两个独立 data root fixture 模拟 Machine A / B：
 * - A 保存的 model.json / auth.json 对 B 完全不可见（反之亦然）
 * - resolveRuntimeRoot + config 派生的 agentDir / settings 路径随根隔离
 * - auth.json 不会被项目数据（PROJECTS_ROOT）复制带走——两根目录树无交集
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { loadConfig, resolveRuntimeRoot } from "../../src/config/config.js";
import { ModelSettingsStore } from "../../src/settings/ModelSettingsStore.js";
import { CustomProviderStore } from "../../src/settings/CustomProviderStore.js";

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pt-dual-runtime-"));
  tempDirs.push(dir);
  return dir;
}

describe("M12.2.5 双运行时配置隔离", () => {
  it("resolveRuntimeRoot：不同机器（不同 env）解析到不同根；默认仍是各自 home", () => {
    const machineA = resolveRuntimeRoot({ PAPERTEAM_RUNTIME_ROOT: join("X:\\", "company", "paperteam") });
    const machineB = resolveRuntimeRoot({ PAPERTEAM_RUNTIME_ROOT: "/var/lib/paperteam" });
    expect(machineA).not.toBe(machineB);
    // 未设置时按各自 OS 用户 home（同机同用户才可能相同——公司机与服务器天然不同）
    expect(resolveRuntimeRoot({})).toBe(join(homedir(), ".paperteam"));
  });

  it("config 派生路径随 runtimeRoot 隔离：agentDir / settings 都在各自根下", () => {
    const rootA = "X:\\company\\paperteam";
    const rootB = "/var/lib/paperteam";
    const configA = loadConfig({ PAPERTEAM_RUNTIME_ROOT: rootA });
    const configB = loadConfig({ PAPERTEAM_RUNTIME_ROOT: rootB });
    // resolve 与 config 内部同语义（POSIX 绝对路径在 Windows 上会补当前盘符——平台无关断言）
    expect(configA.pi.agentDir).toBe(resolve(rootA, "runtime", "pi", "agent"));
    expect(configB.pi.agentDir).toBe(resolve(rootB, "runtime", "pi", "agent"));
    expect(configA.pi.agentDir).not.toBe(configB.pi.agentDir);
    // projects root 也随部署独立（同一 env 上不同值互不影响）
    expect(loadConfig({ PROJECTS_ROOT: "D:\\PaperTeamData\\projects" }).projectsRoot).not.toBe(
      loadConfig({ PROJECTS_ROOT: "/srv/paperteam/projects" }).projectsRoot,
    );
  });

  it("Machine A 保存的模型偏好与 credentials 对 Machine B 完全不可见（不同 data root fixture）", async () => {
    const rootA = await tmp(); // 公司 Windows 机的 runtime root
    const rootB = await tmp(); // 个人 Linux 服务器的 runtime root

    const storeA = new ModelSettingsStore({ settingsDir: join(rootA, "settings") });
    const storeB = new ModelSettingsStore({ settingsDir: join(rootB, "settings") });
    await storeA.save("zai-coding-cn/glm-5.3", { writer: "zai-coding-cn/glm-5.3-flash" });
    // 公司机把 Key 存在 Pi auth.json（Settings UI 的保存位置）
    await mkdir(join(rootA, "runtime", "pi", "agent"), { recursive: true });
    await writeFile(join(rootA, "runtime", "pi", "agent", "auth.json"), '{"zai-coding-cn":"company-secret"}', "utf8");

    // A 读到自己的偏好；B 看到空（未配置）——不共享任何状态
    expect((await storeA.load()).model).toBe("zai-coding-cn/glm-5.3");
    expect((await storeB.load()).model).toBeUndefined();

    // B 独立配置自己的偏好，不覆盖 A
    await storeB.save("openai/gpt-6.1");
    expect((await storeA.load()).model).toBe("zai-coding-cn/glm-5.3");
    expect((await storeB.load()).model).toBe("openai/gpt-6.1");

    // credentials 物理隔离：B 的目录树里不存在 auth.json（迁移projects 不带走 Key）
    const filesB = await readdir(rootB, { recursive: true, withFileTypes: false });
    expect(filesB.some((file) => String(file).endsWith("auth.json"))).toBe(false);
    const filesA = await readdir(rootA, { recursive: true, withFileTypes: false });
    expect(filesA.some((file) => String(file).endsWith("auth.json"))).toBe(true);
  });

  it("自定义 Provider 配置同样随根隔离（公司内部 Provider 只存在于公司机的根）", async () => {
    const rootA = await tmp();
    const rootB = await tmp();
    const providersA = new CustomProviderStore({ settingsDir: join(rootA, "settings") });
    const providersB = new CustomProviderStore({ settingsDir: join(rootB, "settings") });
    // 非敏感网关描述（Key 走 credential storage，本就不入此文件）
    await providersA.save([
      {
        id: "company-internal",
        name: "公司内部网关",
        baseUrl: "http://internal-gw.corp.local/v1",
        api: "openai-completions",
        authHeader: true,
        headers: {},
        models: [
          { id: "corp-strong", name: "Corp Strong", reasoning: false, contextWindow: 200_000, maxTokens: 16_384, input: ["text"] },
        ],
        updatedAt: new Date().toISOString(),
      },
    ]);
    expect((await providersA.load()).some((provider) => provider.id === "company-internal")).toBe(true);
    expect((await providersB.load()).some((provider) => provider.id === "company-internal")).toBe(false);
  });
});
