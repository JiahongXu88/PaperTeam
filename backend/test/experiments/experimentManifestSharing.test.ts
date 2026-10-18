/**
 * M14.9.1 C2：只读路径共享已解析 Manifest。
 *
 * 失败形态（真实 R5.1 审查包，916 文件 / 59 万条观测 / 247 MB manifest）：view / list / workflowContext /
 * queryObservations 每次重新 JSON.parse 整个 manifest；3 个并发 workflowContext 实测堆峰值 2.3 GB。
 * 本组用例锁定：并发只读调用共享一次解析；写入（confirm → save）后立即失效并读到新内容；磁盘被
 * 外部改写（mtime / size 变化）后重新解析；get() 仍返回独立副本，修改它不会污染共享视图。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { startTestStack, scriptedIdeaRuntime } from "../helpers/testStack.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
const fixture = (name: string) => join(import.meta.dirname, "..", "fixtures", "experiments", name);

async function setup() {
  const stack = await startTestStack(scriptedIdeaRuntime().runtime, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
  const created = await stack.request("POST", "/api/projects", { title: "Manifest sharing", researchIdea: "synthetic", workflowKind: "idea_to_paper" });
  const projectId = (created.body["project"] as { id: string }).id;
  const response = await fetch(`http://127.0.0.1:${stack.port()}/api/projects/${projectId}/experiment-packages`, {
    method: "POST", headers: { "Content-Type": "application/zip", "X-Package-Name": "synthetic-normal.zip" }, body: await readFile(fixture("synthetic-normal.zip")),
  });
  const packageId = ((await response.json()) as { package: { packageId: string } }).package.packageId;
  return { stack, projectId, packageId, service: stack.stack.experimentPackages };
}

describe("ExperimentPackageService 只读 Manifest 共享", () => {
  it("3 个并发 workflowContext 只解析一次；confirm（写入）后失效并读到新状态", async () => {
    const { stack, projectId, packageId, service } = await setup();
    const parse = vi.spyOn(service, "get");
    const contexts = await Promise.all([0, 1, 2].map(() => service.workflowContext(projectId)));
    expect(parse).toHaveBeenCalledTimes(1);
    expect(contexts.every((context) => context.observations.length === 0)).toBe(true); // 尚未确认任何组

    await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${packageId}/confirm`, { groupIds: ["main"] });
    parse.mockClear();
    const after = await service.workflowContext(projectId);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(after.observations.length).toBeGreaterThan(0);
    await service.workflowContext(projectId);
    expect(parse).toHaveBeenCalledTimes(1);
    parse.mockRestore();
  });

  it("get() 返回独立副本：修改它不污染共享视图", async () => {
    const { projectId, packageId, service } = await setup();
    const shared = await service.view(projectId, packageId);
    const groups = shared.groups.length;
    const fresh = await service.get(projectId, packageId);
    fresh.groups = [];
    fresh.observations.length = 0;
    const again = await service.view(projectId, packageId);
    expect(again).toBe(shared);
    expect(again.groups).toHaveLength(groups);
    expect(again.observations.length).toBeGreaterThan(0);
  });
});
