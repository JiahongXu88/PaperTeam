/**
 * 发表目标 HTTP 契约（T1 / T8 后端部分）：options 只读端点；创建 / PATCH 校验（400 不落盘）；
 * Journal Assessment 未显式指定期刊时沿用项目发表目标中的已核验期刊（自填期刊 → 未核实，不生成规范条目）。
 */
import { afterAll, describe, expect, it } from "vitest";

import { startTestStack, scriptedIdeaRuntime, type TestStack } from "../helpers/testStack.js";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

async function newStack(): Promise<TestStack> {
  return startTestStack(scriptedIdeaRuntime().runtime, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
}

describe("发表目标 HTTP 契约", () => {
  it("GET options；POST 创建带目标；GET 读回；PATCH 非法 → 400 且不覆盖；PATCH null 清除", async () => {
    const stack = await newStack();
    const options = await stack.request("GET", "/api/publication-target/options");
    expect(options.status).toBe(200);
    expect((options.body["schemes"] as Array<{ scheme: string }>).map((s) => s.scheme)).toEqual(["none", "chinese_index", "cas", "jcr"]);
    expect((await stack.request("POST", "/api/publication-target/options", {})).status).toBe(405);

    const created = await stack.request("POST", "/api/projects", {
      title: "目标 HTTP", documentType: "research_article", publicationTarget: { scheme: "jcr", tier: "Q2", targetJournalId: "cjig" },
    });
    expect(created.status).toBe(201);
    const projectId = (created.body["project"] as { id: string }).id;
    expect((created.body["project"] as { publicationTarget: unknown }).publicationTarget).toMatchObject({ scheme: "jcr", tier: "Q2", targetJournalId: "cjig" });

    const bad = await stack.request("PATCH", `/api/projects/${projectId}`, { publicationTarget: { scheme: "jcr", tier: "1" } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("层级只能是");
    const sci = await stack.request("PATCH", `/api/projects/${projectId}`, { publicationTarget: { scheme: "SCI", tier: "1" } });
    expect(sci.status).toBe(400);
    const read = await stack.request("GET", `/api/projects/${projectId}`);
    expect((read.body["project"] as { publicationTarget: unknown }).publicationTarget).toMatchObject({ scheme: "jcr", tier: "Q2" });

    const badCreate = await stack.request("POST", "/api/projects", { title: "x", publicationTarget: { scheme: "cas", tier: "Q1" } });
    expect(badCreate.status).toBe(400);

    const cleared = await stack.request("PATCH", `/api/projects/${projectId}`, { publicationTarget: null });
    expect(cleared.status).toBe(200);
    expect((cleared.body["project"] as { publicationTarget?: unknown }).publicationTarget).toBeUndefined();
  });

  it("Journal Assessment：请求未指定期刊 → 沿用项目目标期刊；自填期刊 → 未核实，0 条规范；都不指定 → 400（旧行为）", async () => {
    const stack = await newStack();
    const make = async (publicationTarget?: unknown) => {
      const created = await stack.request("POST", "/api/projects", { title: "JA", documentType: "research_article", ...(publicationTarget !== undefined ? { publicationTarget } : {}) });
      return (created.body["project"] as { id: string }).id;
    };
    const verified = await make({ scheme: "none", targetJournalId: "cjig" });
    const ja = await stack.request("POST", `/api/projects/${verified}/target/journal-assessment`, { articleType: "research" });
    expect(ja.status).toBe(200);
    expect((ja.body["assessment"] as { journal: { journalId: string } }).journal.journalId).toBe("cjig");

    const custom = await make({ scheme: "jcr", tier: "Q3", customJournalName: "Unlisted Journal of Things" });
    const jaCustom = await stack.request("POST", `/api/projects/${custom}/target/journal-assessment`, { articleType: "research" });
    expect(jaCustom.status).toBe(200);
    const assessment = jaCustom.body["assessment"] as { journal: { journalId: string | null; verification: { trusted: boolean } }; criteria: unknown[]; summary: { verdict: string } };
    expect(assessment.journal.journalId).toBeNull();
    expect(assessment.journal.verification.trusted).toBe(false);
    expect(assessment.criteria).toHaveLength(0);
    expect(assessment.summary.verdict).toBe("JOURNAL_PROFILE_UNVERIFIED");

    const none = await make();
    expect((await stack.request("POST", `/api/projects/${none}/target/journal-assessment`, { articleType: "research" })).status).toBe(400);
  });
});
