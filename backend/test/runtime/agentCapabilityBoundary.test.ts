/**
 * M15 长程 A1：审批面信任边界的确定性回归。
 *
 * 断言的是「运行中 Agent 的能力面」：没有 shell / 通用 HTTP 工具，自定义工具没有可指向任意地址的参数，
 * 写工具只能写 manuscript/（且不能写修订证据源）、不能写 research/edit-contracts.json 等契约 / 审批存储。
 * 因此模型文本无法自行调用 HITL / 审计决策 / plan_confirm 等本机决策接口——批准只可能来自 Agent 之外的
 * HTTP 调用方。这不证明调用方是人类（同 OS 用户进程可直接调用本机 API，见主报告「产品限制」）。
 */
import { describe, expect, it } from "vitest";

import { evidenceToolsForRole } from "../../src/evidence/tools.js";
import { createRetrieveLibraryTool } from "../../src/retrieval/tools.js";
import { allRoleConfigs, resolveRoleConfig } from "../../src/runtime/pi/roleConfig.js";
import { createWorkspaceGuardPolicy } from "../../src/runtime/pi/workspaceGuard.js";
import { createScholarlyTools } from "../../src/skills/scholarlyTools.js";

const FILE_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const ADDRESS_PARAM = /^(url|uri|href|endpoint|host|hostname|port|baseurl|apiurl|address|command|cmd|script|shell)$/i;

function paramNames(schema: unknown): string[] {
  const properties = (schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  return Object.keys(properties);
}

describe("A1：运行中 Agent 的能力面", () => {
  it("所有角色 × 工具策略的内置工具只有文件工具（无 bash / powershell / fetch）", () => {
    for (const [, role] of Object.entries(allRoleConfigs())) {
      for (const policy of ["default", "read_only", "sealed"] as const) {
        const scope = role.role === "default" ? undefined : role.role === "researcher" ? "research" : role.role === "writer" ? "writing" : role.role === "reviewer" ? "review" : "citation";
        const resolved = resolveRoleConfig(scope, policy);
        for (const tool of resolved.tools) expect(FILE_TOOLS.has(tool), `${role.role}/${policy}: ${tool}`).toBe(true);
        if (policy !== "default" || role.role !== "writer") expect(resolved.tools).not.toContain("write");
      }
    }
  });

  it("生产自定义工具没有可指向任意地址 / 命令的参数", () => {
    const stub = {} as never;
    const tools = [
      ...createScholarlyTools(stub, stub, "p-a1"),
      createRetrieveLibraryTool(stub, "p-a1"),
      ...evidenceToolsForRole("researcher", stub, "p-a1"),
      ...evidenceToolsForRole("reviewer", stub, "p-a1"),
      ...evidenceToolsForRole("writer", stub, "p-a1"),
    ];
    expect(tools.length).toBeGreaterThan(4);
    for (const tool of tools) {
      for (const name of paramNames(tool.parameters)) expect(ADDRESS_PARAM.test(name), `${tool.name}.${name}`).toBe(false);
    }
  });

  it("写边界：契约 / 审批 / 运行状态 / 修订证据源均不可写", () => {
    const projectDir = process.platform === "win32" ? "C:\\pt\\projects\\p-a1" : "/pt/projects/p-a1";
    const policy = createWorkspaceGuardPolicy({ projectDir, protectedSourceIds: [] });
    const at = (...parts: string[]) => [projectDir, ...parts].join(process.platform === "win32" ? "\\" : "/");
    for (const target of [
      at("research", "edit-contracts.json"),
      at("research", "fact-authorizations.json"),
      at("research", "external-instructions.json"),
      at("workflow", "runs", "w-1", "state.json"),
      at("workflow", "agent-writes.jsonl"),
      at("reviews", "quality-gate-r1.json"),
      at("manuscript", "revisions", "rev-1", "main.tex"),
      at("manuscript", "revisions.json"),
      at("manuscript", "restore-intent.json"),
    ]) {
      expect(policy.canWrite(target), target).toBe(false);
    }
    expect(policy.canRead(at("workflow", "agent-writes.jsonl"))).toBe(false);
    expect(policy.canWrite(at("manuscript", "sections", "intro.tex"))).toBe(true);
  });
});
