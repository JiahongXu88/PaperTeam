import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  InvalidProjectIdError,
  InvalidProjectTitleError,
  ProjectNotFoundError,
} from "../src/errors.js";
import { ProjectStore } from "../src/project/ProjectStore.js";

/** 每个用例独立的临时根目录 */
const tempRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function newStore(): Promise<{ store: ProjectStore; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-projects-"));
  tempRoots.push(root);
  return { store: new ProjectStore({ root }), root };
}

describe("ProjectStore", () => {
  it("创建项目：生成全部目录与 project.json", async () => {
    const { store } = await newStore();
    const project = await store.create("RAG Demo Paper");

    expect(project.id).toMatch(/^p-[a-z0-9]{12}$/);
    expect(project.title).toBe("RAG Demo Paper");
    expect(project.status).toBe("created");
    expect(project.createdAt).toBeTruthy();
    expect(project.updatedAt).toBeTruthy();

    for (const dir of ["manuscript", "sources", "evidence", "reviews", "build"]) {
      const info = await stat(join(store.rootDir, project.id, dir));
      expect(info.isDirectory()).toBe(true);
    }

    const raw = JSON.parse(
      await readFile(join(store.rootDir, project.id, "project.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(raw["id"]).toBe(project.id);
    expect(raw["title"]).toBe("RAG Demo Paper");
    expect(raw["status"]).toBe("created");
  });

  it("标题会被规范化：首尾空白剔除", async () => {
    const { store } = await newStore();
    const project = await store.create("  空白标题  ");
    expect(project.title).toBe("空白标题");
  });

  it("空标题 / 超长标题 / 含控制字符的标题被拒绝", async () => {
    const { store } = await newStore();
    await expect(store.create("   ")).rejects.toBeInstanceOf(InvalidProjectTitleError);
    await expect(store.create("x".repeat(201))).rejects.toBeInstanceOf(InvalidProjectTitleError);
    await expect(store.create("带\n换行的标题")).rejects.toBeInstanceOf(InvalidProjectTitleError);
  });

  it("读取项目：create 后 get 返回相同元数据", async () => {
    const { store } = await newStore();
    const project = await store.create("可读取的项目");
    const loaded = await store.get(project.id);
    expect(loaded).toEqual(project);
  });

  it("项目不存在：get 返回 null，getRequired 抛 ProjectNotFoundError", async () => {
    const { store } = await newStore();
    expect(await store.get("p-notexists00")).toBeNull();
    await expect(store.getRequired("p-notexists00")).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it("非法 projectId（路径穿越 / 大写 / 空值）被拒绝", async () => {
    const { store } = await newStore();
    const illegal = ["", "p/../evil", "p/foo", "..", "P-Upper", "p with space", "p/x\\y", "."];
    for (const id of illegal) {
      await expect(store.getRequired(id), `id="${id}"`).rejects.toBeInstanceOf(
        InvalidProjectIdError,
      );
    }
    // 目录计算同样被拦截（路径工具入口）
    expect(() => store.projectDir("p/../../etc")).toThrow(InvalidProjectIdError);
    expect(() => store.mainTexPath("../escape")).toThrow(InvalidProjectIdError);
  });

  it("合法 id 的目录计算始终落在 root 内", async () => {
    const { store, root } = await newStore();
    const dir = store.projectDir("p-abcdef123456");
    expect(dir.startsWith(root)).toBe(true);
    expect(store.mainTexPath("p-abcdef123456").startsWith(root)).toBe(true);
    expect(store.paperPdfPath("p-abcdef123456").endsWith(join("build", "paper.pdf"))).toBe(true);
  });

  it("updateStatus 更新状态与 updatedAt", async () => {
    const { store } = await newStore();
    const project = await store.create("状态流转");
    const updated = await store.updateStatus(project.id, "generated");
    expect(updated.status).toBe("generated");
    expect(updated.updatedAt).toBeTruthy();
    expect((await store.get(project.id))?.status).toBe("generated");
  });

  it("id 冲突时重试生成新 id", async () => {
    const { store } = await newStore();
    let call = 0;
    const fixedIds = ["p-collide00001", "p-collide00001", "p-fresh000001"];
    const storeWithFactory = new ProjectStore({
      root: store.rootDir,
      idFactory: () => fixedIds[call++] ?? "p-never0000000",
    });
    await store.create("第一个项目"); // 占用目录结构但 id 不同
    // 预先创建同名目录制造冲突
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(store.rootDir, "p-collide00001"));
    const project = await storeWithFactory.create("第二个项目");
    expect(project.id).toBe("p-fresh000001");
  });

  it("root 必须是绝对路径", () => {
    expect(() => new ProjectStore({ root: "relative/path" })).toThrow(/绝对路径/);
  });

  it("project.json 损坏时 get 返回 null", async () => {
    const { store } = await newStore();
    const project = await store.create("损坏测试");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(store.rootDir, project.id, "project.json"), "{not json", "utf8");
    expect(await store.get(project.id)).toBeNull();
  });
});
