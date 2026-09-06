import { afterEach, describe, expect, it, vi } from "vitest";

import {
  archiveProject,
  createProject,
  deleteProject,
  getProject,
  importProjectPdf,
  listProjects,
  renameProject,
  restoreProject,
} from "../src/api/projects.js";
import type { ProjectView } from "../src/types/api.js";

/** Project API 层（M4.2 + 2026-09 生命周期）：路径、payload 与响应映射 */

const project: ProjectView = {
  id: "p-abc123def456",
  title: "RAG 论文",
  status: "created",
  createdAt: "2026-09-04T10:00:00.000Z",
  updatedAt: "2026-09-04T10:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function ok(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return fetchMock.mock.calls[0] as [string, RequestInit];
}

describe("projects api", () => {
  it("listProjects：默认 GET /api/projects?scope=active（未归档）", async () => {
    const fetchMock = ok({ projects: [project] }) as unknown as ReturnType<typeof vi.fn>;
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const projects = await listProjects();
    expect(projects).toEqual([project]);
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("/api/projects?scope=active");
    expect(init.method).toBe("GET");
  });

  it("listProjects：scope=archived（设置 → 项目管理）", async () => {
    const fetchMock = ok({ projects: [] }) as unknown as ReturnType<typeof vi.fn>;
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await listProjects("archived");
    expect(lastCall(fetchMock)[0]).toBe("/api/projects?scope=archived");
  });

  it("listProjects：Backend 无项目时返回空数组", async () => {
    vi.stubGlobal("fetch", ok({ projects: [] }));
    expect(await listProjects()).toEqual([]);
  });

  it("importProjectPdf：POST /api/projects/import-pdf（fileName + contentBase64 + goal）", async () => {
    const fetchMock = ok({ project, titleSource: "pdf" }, 201) as unknown as ReturnType<typeof vi.fn>;
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await importProjectPdf({
      fileName: "paper.pdf",
      contentBase64: "JVBERi0=",
      goal: "review_only",
    });
    expect(result.project).toEqual(project);
    expect(result.titleSource).toBe("pdf");
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("/api/projects/import-pdf");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      fileName: "paper.pdf",
      contentBase64: "JVBERi0=",
      goal: "review_only",
    });
  });

  it("renameProject：PATCH /api/projects/:id 只带 title", async () => {
    const fetchMock = ok({ project: { ...project, title: "新标题" } }) as unknown as ReturnType<
      typeof vi.fn
    >;
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await renameProject(project.id, "新标题");
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe(`/api/projects/${project.id}`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ title: "新标题" });
  });

  it("archiveProject / restoreProject：POST 生命周期端点", async () => {
    const archiveMock = ok({ project: { ...project, archivedAt: "2026-09-06T00:00:00.000Z" } }) as unknown as ReturnType<typeof vi.fn>;
    vi.stubGlobal("fetch", archiveMock as unknown as typeof fetch);
    await archiveProject(project.id);
    const [archiveUrl, archiveInit] = lastCall(archiveMock);
    expect(archiveUrl).toBe(`/api/projects/${project.id}/archive`);
    expect(archiveInit.method).toBe("POST");

    const restoreMock = ok({ project }) as unknown as ReturnType<typeof vi.fn>;
    vi.stubGlobal("fetch", restoreMock as unknown as typeof fetch);
    await restoreProject(project.id);
    expect(lastCall(restoreMock)[0]).toBe(`/api/projects/${project.id}/restore`);
  });

  it("deleteProject：DELETE /api/projects/:id（仅已归档，由 Backend 校验）", async () => {
    const fetchMock = ok({ status: "deleted", projectId: project.id }) as unknown as ReturnType<
      typeof vi.fn
    >;
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await deleteProject(project.id);
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe(`/api/projects/${project.id}`);
    expect(init.method).toBe("DELETE");
  });

  it("getProject：路径带 projectId", async () => {
    const fetchMock = ok({ project });
    vi.stubGlobal("fetch", fetchMock);

    expect(await getProject(project.id)).toEqual(project);
    const [url] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe(`/api/projects/${project.id}`);
  });

  it("createProject：POST 非空字段并返回 project", async () => {
    const fetchMock = ok({ project }, 201);
    vi.stubGlobal("fetch", fetchMock);

    const created = await createProject({
      title: "RAG 论文",
      workflowKind: "idea_to_paper",
      researchField: "信息检索",
    });
    expect(created).toEqual(project);
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/projects");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      title: "RAG 论文",
      workflowKind: "idea_to_paper",
      researchField: "信息检索",
    });
  });
});
