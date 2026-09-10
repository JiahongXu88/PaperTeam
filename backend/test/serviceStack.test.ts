/**
 * serviceStack：CITATION_METADATA_* 配置接线（M4.6 回归）。
 *
 * 此前 config.citation.metadataEnabled / metadataTimeoutMs 只接到旧 CitationService，
 * PDF 引用核验（citationIntegrity → quick review 的 citation.metadata stage）不受益：
 * CITATION_METADATA_ENABLED=0 时仍会真实外呼 Crossref / OpenAlex，网络慢时整条
 * run 停滞（e2e E 用例在无外网环境超时的根因）。接线后：
 *   metadataEnabled=false → 空 provider 集（逐条 UNRESOLVED，不发起外部请求）
 *   metadataTimeoutMs / contactEmail → resolver 语义与旧 CitationService 一致
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LatexCompiler } from "../src/latex/LatexCompiler.js";
import type { ScholarlyProvider } from "../src/citation/scholarly.js";
import { ProjectStore } from "../src/project/ProjectStore.js";
import { buildServiceStack } from "../src/serviceStack.js";
import { AGENT_IDS, createScriptedRuntime } from "./helpers/testStack.js";

describe("serviceStack：CITATION_METADATA 配置接线", () => {
  let root: string;
  let store: ProjectStore;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperteam-stack-wiring-"));
    store = new ProjectStore({ root });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function buildStack(citation: Parameters<typeof buildServiceStack>[0]["citation"]) {
    return buildServiceStack({
      runtime: createScriptedRuntime().runtime,
      projects: store,
      latex: new LatexCompiler({ timeoutMs: 1_000 }),
      agentIds: { ...AGENT_IDS },
      ...(citation !== undefined ? { citation } : {}),
      log: () => {},
    });
  }

  it("metadataEnabled=false → citationIntegrity 离线：resolve 逐条 UNRESOLVED，零外部调用", async () => {
    const stack = buildStack({ metadataEnabled: false });
    const resolver = stack.citationIntegrity.scholarlyResolver;
    const verdict = await resolver.resolve({ title: "Attention Is All You Need", year: 2017 });
    expect(verdict.outcome).toBe("unresolved");
    expect(resolver.telemetry.providerCalls).toBe(0);
  });

  it("metadataEnabled 未配置 → 显式注入的 scholarly providers 仍然生效（测试注入不被清空）", async () => {
    const stack = buildStack({ scholarly: { providers: [] } });
    const resolver = stack.citationIntegrity.scholarlyResolver;
    const verdict = await resolver.resolve({ title: "Attention Is All You Need", year: 2017 });
    expect(verdict.outcome).toBe("unresolved");
    expect(resolver.telemetry.providerCalls).toBe(0);
  });

  it("metadataEnabled=false 且显式注入 providers → 注入优先（disable 不清空测试 fake provider）", async () => {
    let calls = 0;
    const counting: ScholarlyProvider = {
      name: "crossref",
      async lookup() {
        calls += 1;
        return { kind: "not_found" } as const;
      },
    };
    const stack = buildStack({ metadataEnabled: false, scholarly: { providers: [counting] } });
    await stack.citationIntegrity.scholarlyResolver.resolve({ title: "Attention Is All You Need", year: 2017 });
    expect(calls).toBeGreaterThanOrEqual(1); // 注入 provider 真实参与判定
  });
});
