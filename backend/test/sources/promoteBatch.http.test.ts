/**
 * M11.1.1 Candidate 批量入选（promote-batch）HTTP 测试：
 * partial success / 幂等 / already_exists / 数量上限 / selectionReason 落盘。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";

let stack: TestStack;

beforeAll(async () => {
  stack = await startTestStack(scriptedIdeaRuntime().runtime);
});

afterAll(async () => {
  await stack.cleanup();
});

async function createProject(): Promise<string> {
  const { body } = await stack.request("POST", "/api/projects", {
    title: "promote-batch 测试",
  });
  return (body["project"] as { id: string }).id;
}

interface CandidateView {
  candidateId: string;
  status: string;
  promotedSourceId?: string;
  selectionReason?: string;
}

describe("POST /api/projects/:id/sources/candidates/promote-batch", () => {
  it("partial success：成功 / already_exists / 失败逐条落账，成功项保留", async () => {
    const projectId = await createProject();
    // 预先以同 DOI 导入正式 Source：C001 promote 时身份判等命中 → already_exists
    await stack.stack.sourceImport.importDoi(projectId, {
      doi: "10.1000/batch-a",
      enrich: false,
    });
    await stack.stack.sourceImport.addCandidate(projectId, {
      doi: "10.1000/batch-a",
      title: "Batch Paper A",
      year: 2023,
    });
    await stack.stack.sourceImport.addCandidate(projectId, {
      doi: "10.1000/batch-b",
      title: "Batch Paper B",
      year: 2024,
    });

    const { status, body } = await stack.request(
      "POST",
      `/api/projects/${projectId}/sources/candidates/promote-batch`,
      {
        candidateIds: ["C001", "C002", "C099"],
        selectionReason: "seminal work for survey corpus",
      },
    );
    expect(status).toBe(200);
    const summary = body["summary"] as Record<string, number>;
    // C001 同身份命中既有 Source → already_exists；C002 新建；C099 不存在 → failed
    expect(summary).toEqual({ total: 3, promoted: 1, alreadyExists: 1, failed: 1 });
    const results = body["results"] as Array<{ candidateId: string; outcome: string }>;
    expect(results.find((item) => item.candidateId === "C001")?.outcome).toBe("already_exists");
    expect(results.find((item) => item.candidateId === "C002")?.outcome).toBe("promoted");
    expect(results.find((item) => item.candidateId === "C099")?.outcome).toBe("failed");

    // selectionReason 落盘到全部 accepted 候选（含 already_exists 条目）
    const candidates = (await stack.stack.sourceImport.listCandidates(projectId)) as CandidateView[];
    expect(candidates.find((candidate) => candidate.candidateId === "C001")?.selectionReason).toBe(
      "seminal work for survey corpus",
    );
    expect(candidates.find((candidate) => candidate.candidateId === "C002")?.selectionReason).toBe(
      "seminal work for survey corpus",
    );

    // 文献库不因 already_exists 复制条目（预导入 1 + 新建 1）
    const sources = await stack.stack.sources.list(projectId);
    expect(sources.length).toBe(2);
  });

  it("幂等：重复提交同一批 → 全部 already_exists，不创建重复 Source", async () => {
    const projectId = await createProject();
    await stack.stack.sourceImport.addCandidate(projectId, {
      doi: "10.1000/idem-a",
      title: "Idem Paper A",
      year: 2022,
    });
    await stack.stack.sourceImport.addCandidate(projectId, {
      doi: "10.1000/idem-b",
      title: "Idem Paper B",
      year: 2022,
    });

    const first = await stack.request(
      "POST",
      `/api/projects/${projectId}/sources/candidates/promote-batch`,
      { candidateIds: ["C001", "C002"] },
    );
    expect((first.body["summary"] as Record<string, number>).promoted).toBe(2);

    const second = await stack.request(
      "POST",
      `/api/projects/${projectId}/sources/candidates/promote-batch`,
      { candidateIds: ["C001", "C002"] },
    );
    expect(second.body["summary"]).toMatchObject({ promoted: 0, alreadyExists: 2, failed: 0 });
    expect((await stack.stack.sources.list(projectId)).length).toBe(2);

    // 单条 promote 端点同样携带 selectionReason（M11.1.1 扩展）
    const single = await stack.request(
      "POST",
      `/api/projects/${projectId}/sources/candidates/C001/promote`,
      { selectionReason: "opposing approach" },
    );
    expect(single.status).toBe(200);
    const updated = (await stack.stack.candidates.get(projectId, "C001")) as CandidateView;
    expect(updated.selectionReason).toBe("opposing approach");
  });

  it("数量上限与空数组 / 缺字段 → 400", async () => {
    const projectId = await createProject();
    const tooMany = await stack.request(
      "POST",
      `/api/projects/${projectId}/sources/candidates/promote-batch`,
      {
        candidateIds: Array.from({ length: 51 }, (_, index) =>
          `C${String(index + 1).padStart(3, "0")}`,
        ),
      },
    );
    expect(tooMany.status).toBe(400);
    expect((tooMany.body["error"] as { code: string }).code).toBe("INVALID_REQUEST");

    const empty = await stack.request(
      "POST",
      `/api/projects/${projectId}/sources/candidates/promote-batch`,
      { candidateIds: [] },
    );
    expect(empty.status).toBe(400);

    const missing = await stack.request(
      "POST",
      `/api/projects/${projectId}/sources/candidates/promote-batch`,
      {},
    );
    expect(missing.status).toBe(400);
  });
});
