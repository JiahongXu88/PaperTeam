import { afterEach, describe, expect, it, vi } from "vitest";

import { createProject, getProject, listProjects } from "../src/api/projects.js";
import type { ProjectView } from "../src/types/api.js";

/** Project API 层（M4.2）：路径、payload 与响应映射 */

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

describe("projects api", () => {
  it("listProjects：GET /api/projects 并取出 projects 数组", async () => {
    const fetchMock = ok({ projects: [project] });
    vi.stubGlobal("fetch", fetchMock);

    const projects = await listProjects();
    expect(projects).toEqual([project]);
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/projects");
    expect(init.method).toBe("GET");
  });

  it("listProjects：Backend 无项目时返回空数组", async () => {
    vi.stubGlobal("fetch", ok({ projects: [] }));
    expect(await listProjects()).toEqual([]);
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
