/**
 * EvidenceStore 测试（M3.1）：
 * append / get / list / query / updateVerification / markUsage、
 * 损坏行容忍、项目隔离、输入校验。
 */

import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { EvidenceStore } from "../../src/evidence/EvidenceStore.js";
import { EvidenceValidationError } from "../../src/errors.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function newProject(): Promise<{ store: ProjectStore; evidence: EvidenceStore; projectId: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-ev-"));
  tempRoots.push(root);
  const store = new ProjectStore({ root });
  const project = await store.create("Evidence 测试");
  return { store, evidence: new EvidenceStore(store), projectId: project.id, root };
}

describe("EvidenceStore：append / get / list", () => {
  it("追加生成递增 id 并可读回；claim 必填", async () => {
    const { evidence, projectId } = await newProject();
    const first = await evidence.append(
      projectId,
      { claim: "RAG 降低幻觉率", summary: "综述汇总", quote: "hallucination drops" },
      "researcher",
    );
    const second = await evidence.append(projectId, { claim: "第二条证据" }, "user");
    expect(first.id).toBe("E001");
    expect(second.id).toBe("E002");
    expect(first.verificationStatus).toBe("unverified");
    expect(first.createdBy).toBe("researcher");

    const listed = await evidence.list(projectId);
    expect(listed).toHaveLength(2);
    expect(await evidence.get(projectId, "E001")).toMatchObject({ claim: "RAG 降低幻觉率" });
    expect(await evidence.get(projectId, "E999")).toBeNull();

    await expect(evidence.append(projectId, { claim: "  " }, "user")).rejects.toBeInstanceOf(
      EvidenceValidationError,
    );
    await expect(
      evidence.append(projectId, { claim: "x", verificationStatus: "bogus" as never }, "user"),
    ).rejects.toBeInstanceOf(EvidenceValidationError);
  });

  it("来源与位置字段经过校验（非法值拒绝）", async () => {
    const { evidence, projectId } = await newProject();
    await expect(
      evidence.append(
        projectId,
        {
          claim: "x",
          source: { title: "T", authors: ["A"], year: 2024, doi: "10.1/x" },
          location: { page: 3, section: "4.2" },
          supportStrength: "direct",
          verificationLevel: "fulltext",
        },
        "researcher",
      ),
    ).resolves.toMatchObject({
      source: { title: "T", year: 2024 },
      location: { page: 3, section: "4.2" },
      supportStrength: "direct",
    });
    await expect(
      evidence.append(projectId, { claim: "x", location: { page: -1 } }, "user"),
    ).rejects.toBeInstanceOf(EvidenceValidationError);
    await expect(
      evidence.append(projectId, { claim: "x", source: { authors: [1] as never } }, "user"),
    ).rejects.toBeInstanceOf(EvidenceValidationError);
  });
});

describe("EvidenceStore：query / updateVerification / markUsage", () => {
  it("按状态 / 来源 / 章节 / usedBy / claim 子串过滤", async () => {
    const { evidence, projectId } = await newProject();
    await evidence.append(
      projectId,
      { claim: "检索质量影响幻觉", source: { sourceId: "S001" } },
      "researcher",
    );
    await evidence.append(projectId, { claim: "重排策略最稳健" }, "user");
    await evidence.append(projectId, { claim: "另一种检索观点" }, "user");

    expect(await evidence.query(projectId, { status: "unverified" })).toHaveLength(3);
    expect(await evidence.query(projectId, { sourceId: "S001" })).toHaveLength(1);
    expect(await evidence.query(projectId, { claimContains: "检索" })).toHaveLength(2);

    await evidence.markUsage(projectId, "E001", { section: "sections/introduction.tex", usedBy: "run:w-1" });
    expect(await evidence.query(projectId, { section: "sections/introduction.tex" })).toHaveLength(1);
    expect(await evidence.query(projectId, { usedBy: "run:w-1" })).toHaveLength(1);

    const updated = await evidence.updateVerification(projectId, "E001", {
      verificationStatus: "verified",
      verificationMethod: "fulltext_quote_match",
      verificationLevel: "fulltext",
    });
    expect(updated.verificationStatus).toBe("verified");
    expect(updated.updatedAt).toBeDefined();
    expect(await evidence.query(projectId, { status: "verified" })).toHaveLength(1);

    await expect(
      evidence.updateVerification(projectId, "E999", { verificationStatus: "verified" }),
    ).rejects.toBeInstanceOf(EvidenceValidationError);
  });

  it("stats 汇总各状态计数", async () => {
    const { evidence, projectId } = await newProject();
    await evidence.append(projectId, { claim: "a" }, "user");
    await evidence.append(projectId, { claim: "b" }, "user");
    await evidence.updateVerification(projectId, "E002", { verificationStatus: "not_found" });
    const stats = await evidence.stats(projectId);
    expect(stats.total).toBe(2);
    expect(stats.byStatus.unverified).toBe(1);
    expect(stats.byStatus.not_found).toBe(1);
  });
});

describe("EvidenceStore：持久化与容错", () => {
  it("损坏行被跳过（计数进 stats.skippedLines），其余记录可用", async () => {
    const { evidence, projectId, store } = await newProject();
    await evidence.append(projectId, { claim: "good-1" }, "user");
    const path = join(store.evidenceDir(projectId), "evidence.jsonl");
    await appendFile(path, "{\"broken json\n", "utf8");
    await evidence.append(projectId, { claim: "good-2" }, "user");

    const listed = await evidence.list(projectId);
    expect(listed.map((record) => record.claim)).toEqual(["good-1", "good-2"]);
    // 追加的新记录 id 跳过损坏行编号（避免与潜在残留冲突）
    expect(listed[1]?.id).toBe("E002");
    const stats = await evidence.stats(projectId);
    expect(stats.skippedLines).toBe(1);
  });

  it("updateVerification 全量重写后文件仍是合法 JSONL（每行一个 JSON）", async () => {
    const { evidence, projectId, store } = await newProject();
    await evidence.append(projectId, { claim: "a" }, "user");
    await evidence.append(projectId, { claim: "b" }, "user");
    await evidence.updateVerification(projectId, "E001", { verificationStatus: "verified" });
    const raw = await readFile(join(store.evidenceDir(projectId), "evidence.jsonl"), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(JSON.parse(lines[0]!).verificationStatus).toBe("verified");
  });

  it("不同项目 Evidence 完全隔离", async () => {
    const { store, evidence } = await newProject();
    const projectA = await store.create("项目 A");
    const projectB = await store.create("项目 B");
    await evidence.append(projectA.id, { claim: "A 的证据" }, "user");
    await evidence.append(projectB.id, { claim: "B 的证据" }, "user");
    expect((await evidence.list(projectA.id)).map((r) => r.claim)).toEqual(["A 的证据"]);
    expect((await evidence.list(projectB.id)).map((r) => r.claim)).toEqual(["B 的证据"]);

    const rawA = await readFile(join(store.evidenceDir(projectA.id), "evidence.jsonl"), "utf8");
    expect(rawA).not.toContain("B 的证据");
  });

  it("空文件 / 文件不存在：list 返回空数组", async () => {
    const { evidence, projectId, store } = await newProject();
    expect(await evidence.list(projectId)).toEqual([]);
    await writeFile(join(store.evidenceDir(projectId), "evidence.jsonl"), "", "utf8");
    expect(await evidence.list(projectId)).toEqual([]);
  });
});
