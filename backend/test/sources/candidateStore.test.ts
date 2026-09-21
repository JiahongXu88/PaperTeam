/**
 * CandidateStore 可靠性测试（M8.5 P0：save_candidates 并发写损坏修复）。
 *
 * 覆盖：
 * 1. Concurrent Writes：同项目并发 add / markRejected / remove（单实例 promise
 *    链互斥）→ 最终文件合法 JSON、无丢更新、ID 连续不冲突；
 * 2. Corruption Read：非法 JSON / 缺 items → 结构化 CANDIDATE_STORE_CORRUPTED
 *    （500），绝不静默返回空；文件不存在仍是空列表（空 ≠ 损坏）；修复后可读；
 * 3. Atomic Write：落盘后无 tmp 残留；崩溃残留的 tmp 被下一次写清理；
 *    其它文件的 tmp 不被误删；损坏期间的写入被拒绝且不覆盖现场；
 * 4. Compatibility：M6.2 旧形态 {items:[...]} 继续可读；并发同身份合并为一条；
 * 5. HTTP 口径：GET /sources/candidates 对损坏索引 500 CANDIDATE_STORE_CORRUPTED
 *    （不是 200 空列表）；POST 保存候选同样显式失败。
 */

import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { CandidateStore } from "../../src/sources/CandidateStore.js";
import { BusinessError } from "../../src/errors.js";
import { startTestStack, scriptedIdeaRuntime, type TestStack } from "../helpers/testStack.js";

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function newFixture(): Promise<{ projects: ProjectStore; candidates: CandidateStore; projectId: string; root: string; indexpath: string }> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-cand-"));
  tempRoots.push(root);
  const projects = new ProjectStore({ root });
  const project = await projects.create("候选可靠性测试");
  const candidates = new CandidateStore(projects);
  return {
    projects,
    candidates,
    projectId: project.id,
    root,
    indexpath: join(projects.sourcesDir(project.id), "candidates.json"),
  };
}

/** 直写索引文件（构造损坏 / 旧形态现场；父目录不存在则先创建） */
async function writeIndex(path: string, content: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function readIndexJson(path: string): Promise<{ items?: unknown }> {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(path, "utf8")) as { items?: unknown };
}

function doiInput(n: number) {
  return { doi: `10.1234/concurrent-${n}`, title: `并发候选 ${n}`, origin: "academic_search" as const, provider: "openalex" };
}

// ---- 1. Concurrent Writes ----

describe("Concurrent Writes：项目级互斥串行化", () => {
  it("同毫秒并发 add 8 条：全部落盘、文件合法、ID 唯一连续（无丢更新）", async () => {
    const f = await newFixture();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => f.candidates.add(f.projectId, doiInput(i + 1))),
    );
    expect(results.every((result) => result.created)).toBe(true);

    const stored = await readIndexJson(f.indexpath);
    expect(Array.isArray(stored.items)).toBe(true);
    expect(stored.items).toHaveLength(8);
    const ids = (stored.items as Array<{ candidateId: string }>).map((item) => item.candidateId);
    expect(new Set(ids).size).toBe(8);
    // 互斥下 nextId 基于最新落盘结果计算：ID 连续（C001..C008），无重复分配
    expect(ids).toEqual(["C001", "C002", "C003", "C004", "C005", "C006", "C007", "C008"]);
    expect(await f.candidates.list(f.projectId)).toHaveLength(8);
  });

  it("并发 add + markRejected + remove 混合：最终状态一致且文件合法", async () => {
    const f = await newFixture();
    // 预置三条候选（串行），随后并发混合作战
    for (let i = 1; i <= 3; i += 1) {
      await f.candidates.add(f.projectId, doiInput(i));
    }
    await Promise.all([
      f.candidates.add(f.projectId, doiInput(4)),
      f.candidates.add(f.projectId, doiInput(5)),
      f.candidates.markRejected(f.projectId, "C001"),
      f.candidates.remove(f.projectId, "C002"),
      f.candidates.add(f.projectId, doiInput(6)),
    ]);

    const stored = await readIndexJson(f.indexpath);
    const byId = new Map(
      (stored.items as Array<{ candidateId: string; status: string }>).map((item) => [item.candidateId, item.status]),
    );
    expect(stored.items).toHaveLength(5); // 6 新增 − C002 删除
    expect(byId.get("C001")).toBe("rejected"); // markRejected 未被并发 add 覆盖
    expect(byId.has("C002")).toBe(false);
    expect(byId.get("C006")).toBe("pending_review");
  });

  it("并发 add 同身份：合并为一条 pending（created 恰一次），不产生重复候选", async () => {
    const f = await newFixture();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        f.candidates.add(f.projectId, { ...doiInput(1), title: undefined, snippetOrAbstract: "片段" }),
      ),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.filter((result) => !result.created)).toHaveLength(4);
    const stored = await readIndexJson(f.indexpath);
    expect(stored.items).toHaveLength(1);
  });
});

// ---- 2. Corruption Read ----

describe("Corruption Read：损坏显式报错（不静默返回空）", () => {
  it("非法 JSON（完整文档 + 残尾形态）→ CANDIDATE_STORE_CORRUPTED（500）", async () => {
    const f = await newFixture();
    await f.candidates.add(f.projectId, doiInput(1));
    const valid = JSON.stringify({ items: [{ candidateId: "C001", identity: { doi: "10.1/x" }, origin: "manual", provider: "manual", status: "pending_review", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" }] });
    await writeIndex(f.indexpath, `${valid}\n${valid.slice(0, 40)}`);

    const error = await f.candidates.list(f.projectId).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(BusinessError);
    expect((error as BusinessError).code).toBe("CANDIDATE_STORE_CORRUPTED");
    expect((error as BusinessError).httpStatus).toBe(500);
    // 消息明确区分「数据损坏」与「没有候选论文」
    expect((error as BusinessError).message).toContain("数据损坏");
    expect((error as BusinessError).message).toContain(f.projectId);
  });

  it("合法 JSON 但缺 items → CANDIDATE_STORE_CORRUPTED", async () => {
    const f = await newFixture();
    await writeIndex(f.indexpath, JSON.stringify({ candidates: [] }));
    await expect(f.candidates.list(f.projectId)).rejects.toMatchObject({
      code: "CANDIDATE_STORE_CORRUPTED",
    });
  });

  it("文件不存在 = 空列表（空 ≠ 损坏）；正常 JSON 正常读取", async () => {
    const f = await newFixture();
    expect(await f.candidates.list(f.projectId)).toEqual([]);
    await f.candidates.add(f.projectId, doiInput(1));
    const listed = await f.candidates.list(f.projectId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ candidateId: "C001", status: "pending_review" });
  });

  it("恢复后读取：损坏 → 手工修复 → list 恢复正常", async () => {
    const f = await newFixture();
    await writeIndex(f.indexpath, "{broken");
    await expect(f.candidates.list(f.projectId)).rejects.toMatchObject({ code: "CANDIDATE_STORE_CORRUPTED" });
    await writeIndex(f.indexpath, JSON.stringify({ items: [] }));
    expect(await f.candidates.list(f.projectId)).toEqual([]);
  });

  it("损坏期间写入被拒绝且不覆盖现场（假成功不可能）", async () => {
    const f = await newFixture();
    await writeIndex(f.indexpath, "{broken");
    await expect(f.candidates.add(f.projectId, doiInput(1))).rejects.toMatchObject({
      code: "CANDIDATE_STORE_CORRUPTED",
    });
    expect(await readFileRaw(f.indexpath)).toBe("{broken"); // 现场原样保留
  });
});

// ---- 3. Atomic Write ----

describe("Atomic Write：tmp 唯一命名与残留清理", () => {
  it("并发写后目录无 tmp 残留（tmp 名单调序号不碰撞）", async () => {
    const f = await newFixture();
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => f.candidates.add(f.projectId, doiInput(i + 1))),
    );
    const leftovers = (await readdir(join(f.root, f.projectId, "sources"))).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    expect(existsSync(f.indexpath)).toBe(true);
  });

  it("崩溃残留的同名 tmp 被下一次成功写清理；其它文件的 tmp 不受影响", async () => {
    const f = await newFixture();
    const sourcesDir = join(f.root, f.projectId, "sources");
    await writeIndex(join(sourcesDir, ".candidates.json.99999-111-1.tmp"), "残留");
    await writeIndex(join(sourcesDir, ".index.json.99999-111-1.tmp"), "别动我");
    await f.candidates.add(f.projectId, doiInput(1));
    const names = await readdir(sourcesDir);
    expect(names).toContain("candidates.json");
    expect(names).not.toContain(".candidates.json.99999-111-1.tmp"); // 同名残留被清
    expect(names).toContain(".index.json.99999-111-1.tmp"); // 其它文件不动
  });
});

// ---- 4. Compatibility ----

describe("Compatibility：旧 candidates.json 继续可用", () => {
  it("M6.2 旧形态（无 query / 无 origin 字段）可读可追加", async () => {
    const f = await newFixture();
    await writeIndex(
      f.indexpath,
      JSON.stringify({
        items: [
          {
            candidateId: "C001",
            identity: { doi: "10.1234/legacy-1" },
            origin: "manual",
            provider: "manual",
            title: "旧候选",
            status: "pending_review",
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const listed = await f.candidates.list(f.projectId);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.title).toBe("旧候选");

    const added = await f.candidates.add(f.projectId, doiInput(9));
    expect(added.candidate.candidateId).toBe("C002"); // nextId 延续旧序号
    expect(await f.candidates.list(f.projectId)).toHaveLength(2);
  });
});

// ---- 5. HTTP 口径 ----

describe("HTTP：损坏索引对 API 消费者同样显式", () => {
  let stack: TestStack;
  beforeAll(async () => {
    stack = await startTestStack(scriptedIdeaRuntime().runtime);
  });
  afterAll(async () => {
    await stack.cleanup();
  });

  it("GET /sources/candidates → 500 CANDIDATE_STORE_CORRUPTED（不是 200 空列表）；POST 同样拒绝", async () => {
    const response = await stack.request("POST", "/api/projects", { title: "损坏口径" });
    const projectId = (response.body["project"] as { id: string }).id;
    await writeIndex(join(stack.store.sourcesDir(projectId), "candidates.json"), '{"items":[{"broken"');

    const listResponse = await stack.request("GET", `/api/projects/${projectId}/sources/candidates`);
    expect(listResponse.status).toBe(500);
    expect(listResponse.body).toMatchObject({
      status: "error",
      error: { code: "CANDIDATE_STORE_CORRUPTED" },
    });

    const postResponse = await stack.request("POST", `/api/projects/${projectId}/sources/candidates`, {
      doi: "10.1234/http-corrupt",
      title: "损坏期间写入",
    });
    expect(postResponse.status).toBe(500);
    expect(postResponse.body).toMatchObject({ error: { code: "CANDIDATE_STORE_CORRUPTED" } });
  });
});

async function readFileRaw(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}
