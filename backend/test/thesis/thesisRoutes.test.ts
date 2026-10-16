/**
 * M14.1c HTTP：/api/projects/:id/thesis/{templates,document,assemble}
 *
 * 保存模型（对当前 outline 校验）→ 读取 → 模板列表 → 确定性装配。
 * 编译端点不在 vitest 里跑真实 TeX（编译链由 scripts/acceptance/thesis-compile-check.mjs
 * 在有 TeX Live 的服务器验收 + LatexCompiler 单元测试覆盖 fake 工具链）。
 */

import { afterEach, describe, expect, it } from "vitest";

import { scriptedIdeaRuntime } from "../helpers/testStack.js";
import { startTestStack, type TestStack } from "../helpers/testStack.js";

const stacks: TestStack[] = [];
afterEach(async () => {
  await Promise.all(stacks.splice(0).map((stack) => stack.cleanup()));
});

async function newProjectWithOutline(title: string) {
  const stack = await startTestStack(scriptedIdeaRuntime().runtime);
  stacks.push(stack);
  const created = await stack.request("POST", "/api/projects", { title });
  const projectId = (created.body["project"] as { id: string }).id;
  await stack.stack.manuscript.saveOutline(projectId, {
    title: "合成测试论文",
    sections: [
      { id: "s1", file: "intro.tex", title: "intro" },
      { id: "s2", file: "method.tex", title: "method" },
      { id: "s3", file: "experiment.tex", title: "experiment" },
    ],
  });
  await stack.stack.manuscript.writeSection(projectId, { id: "s1", file: "intro.tex", title: "intro" }, "\\section{intro}\n合成内容（sentinel-http-intro）。\n");
  await stack.stack.manuscript.writeSection(projectId, { id: "s2", file: "method.tex", title: "method" }, "\\section{method}\n合成方法内容。\n");
  await stack.stack.manuscript.writeSection(projectId, { id: "s3", file: "experiment.tex", title: "experiment" }, "\\section{experiment}\n合成实验内容。\n");
  return { stack, projectId };
}

const modelOf = () => ({
  schemaVersion: 1,
  templateId: "generic-ctexbook",
  titleZh: "合成测试学位论文（HTTP）",
  abstractZh: "合成测试材料。",
  keywordsZh: ["合成测试"],
  chapters: [
    { chapterId: "ch01", titleZh: "intro", sections: ["intro.tex"] },
    { chapterId: "ch02", titleZh: "方法与实验章", sections: ["method.tex", "experiment.tex"] },
  ],
  acknowledgmentsZh: "合成致谢。",
});

describe("M14.1c HTTP：/api/projects/:id/thesis/*", () => {
  it("templates：列出 generic-ctexbook 与默认参考文献后端", async () => {
    const { stack, projectId } = await newProjectWithOutline("m141c-templates");
    const res = await stack.request("GET", `/api/projects/${projectId}/thesis/templates`);
    expect(res.status).toBe(200);
    expect(res.body["templates"]).toEqual([{ templateId: "generic-ctexbook", defaultBibliography: "bibtex" }]);
  });

  it("document：PUT 保存（校验 outline 映射）→ GET 读回；重启后可见", async () => {
    const { stack, projectId } = await newProjectWithOutline("m141c-document");
    const put = await stack.request("PUT", `/api/projects/${projectId}/thesis/document`, { model: modelOf() });
    expect(put.status).toBe(200);
    expect((put.body["model"] as { titleZh: string }).titleZh).toBe("合成测试学位论文（HTTP）");

    const get = await stack.request("GET", `/api/projects/${projectId}/thesis/document`);
    expect((get.body["model"] as { chapters: unknown[] }).chapters).toHaveLength(2);

    // 进程重启模拟：同一 ProjectStore 上新建服务实例仍可读回（文件持久化）
    const { ThesisDocumentService } = await import("../../src/thesis/ThesisDocumentService.js");
    const fresh = new ThesisDocumentService(stack.stack.projects, stack.stack.latex);
    const persisted = await fresh.loadModel(projectId);
    expect(persisted?.templateId).toBe("generic-ctexbook");
  });

  it("document：未映射全部 section 的模型被拒绝（400 契约违规）", async () => {
    const { stack, projectId } = await newProjectWithOutline("m141c-invalid");
    const bad = { ...modelOf(), chapters: [{ chapterId: "ch01", titleZh: "intro", sections: ["intro.tex"] }] }; // method.tex 未映射
    const res = await stack.request("PUT", `/api/projects/${projectId}/thesis/document`, { model: bad });
    expect(res.status).toBe(400);
    // BusinessError → {status:"error", error:{code,message,detail?}}
    const error = res.body["error"] as { message?: string; detail?: string };
    expect(`${error?.message ?? ""}${error?.detail ?? ""}`).toContain("未映射");
  });

  it("assemble：确定性装配 manuscript-thesis/（promoted + wrapper 章结构返回）", async () => {
    const { stack, projectId } = await newProjectWithOutline("m141c-assemble");
    await stack.request("PUT", `/api/projects/${projectId}/thesis/document`, { model: modelOf() });
    const res = await stack.request("POST", `/api/projects/${projectId}/thesis/assemble`);
    expect(res.status).toBe(200);
    expect(res.body["chapters"]).toEqual([
      { chapterId: "ch01", titleZh: "intro", mode: "promoted", sectionFiles: ["intro.tex"], part: "main" },
      { chapterId: "ch02", titleZh: "方法与实验章", mode: "wrapper", sectionFiles: ["method.tex", "experiment.tex"], part: "main" },
    ]);
    // 正文哨兵保留在装配产物中（内容不丢失）
    const { readFile } = await import("node:fs/promises");
    const intro = await readFile(
      (await import("node:path")).join(stack.stack.projects.manuscriptDir(projectId), "..", "manuscript-thesis", "sections", "intro.tex"),
      "utf8",
    );
    expect(intro).toContain("sentinel-http-intro");
    expect(intro.split("\n")[0]).toBe("\\chapter{intro}\\label{ch:ch01}"); // promoted（M14.6：章标签同行） 层级提升
  });

  it("无模型时 assemble 404（不猜默认结构）", async () => {
    const { stack, projectId } = await newProjectWithOutline("m141c-empty");
    const res = await stack.request("POST", `/api/projects/${projectId}/thesis/assemble`);
    expect(res.status).toBe(404);
  });
});
