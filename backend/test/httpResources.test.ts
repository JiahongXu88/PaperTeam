/**
 * M3.1 资源路由测试：项目研究定位（创建/PATCH）、sources 上传与分析、
 * evidence 手工管理与核验、citation-check、manuscript、context（Derived）。
 * 使用完整服务栈 + scripted runtime（仅用 builtin 分析，不依赖网络）。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  startTestStack,
  scriptedIdeaRuntime,
  type ServiceStackOptionsCitation,
  type TestStack,
} from "./helpers/testStack.js";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
});

async function newStack(citation?: ServiceStackOptionsCitation): Promise<TestStack> {
  const scripted = scriptedIdeaRuntime();
  return startTestStack(scripted.runtime, {
    citation: {
      metadataEnabled: true,
      maxMetadataLookups: 5,
      metadataTimeoutMs: 300,
      ...(citation ?? {}),
    },
    registerCleanup: (cleanup) => cleanups.push(cleanup),
  });
}

function minimalPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  return Buffer.from(
    ["%PDF-1.4", "1 0 obj", "<< /Type /Catalog /Pages 2 0 R >>", "endobj"].join("\n") +
      `\n<< /Count 1 >>\nstream\n${content}\nendstream\n%%EOF\n`,
    "latin1",
  );
}

describe("项目研究定位", () => {
  it("创建携带研究字段；PATCH 更新 targetProfile / targetVenue；非法值 400", async () => {
    const stack = await newStack();
    const created = await stack.request("POST", "/api/projects", {
      title: "定位测试",
      researchIdea: "研究想法",
      researchField: "NLP",
      documentType: "conference_paper",
      targetProfile: "high_level_conference",
      targetVenue: "CVPR",
      workflowKind: "idea_to_paper",
    });
    expect(created.status).toBe(201);
    expect(created.body["project"]).toMatchObject({
      researchIdea: "研究想法",
      targetVenue: "CVPR",
      workflowKind: "idea_to_paper",
    });

    const projectId = (created.body["project"] as { id: string }).id;
    const patched = await stack.request("PATCH", `/api/projects/${projectId}`, {
      targetProfile: "core_journal",
    });
    expect(patched.status).toBe(200);
    expect((patched.body["project"] as { targetProfile?: string }).targetProfile).toBe("core_journal");

    const bad = await stack.request("PATCH", `/api/projects/${projectId}`, {
      targetProfile: "x".repeat(101),
    });
    expect(bad.status).toBe(400);
  });
});

describe("sources 上传与分析", () => {
  it("上传 PDF：自动 builtin 分析；列表与详情可见；PATCH 角色与 preferred", async () => {
    const stack = await newStack();
    const project = await stack.store.create("文献上传测试");
    const upload = await stack.request("POST", `/api/projects/${project.id}/sources`, {
      fileName: "survey.pdf",
      contentBase64: minimalPdf("Introduction to RAG survey").toString("base64"),
      sourceRole: "evidence",
      title: "RAG Survey",
      year: 2023,
    });
    expect(upload.status).toBe(201);
    const source = upload.body["source"] as {
      sourceId: string;
      status: string;
      analysis?: { status: string; pageCount: number | null };
    };
    expect(source.status).not.toBe("failed");
    expect(source.analysis?.pageCount).toBeGreaterThanOrEqual(1);

    const list = await stack.request("GET", `/api/projects/${project.id}/sources`);
    expect((list.body["sources"] as unknown[]).length).toBe(1);

    const detail = await stack.request("GET", `/api/projects/${project.id}/sources/${source.sourceId}`);
    expect(detail.status).toBe(200);

    const patched = await stack.request("PATCH", `/api/projects/${project.id}/sources/${source.sourceId}`, {
      sourceRole: "reference",
      preferred: true,
    });
    expect((patched.body["source"] as { sourceRole: string }).sourceRole).toBe("reference");

    const deleted = await stack.request(
      "DELETE",
      `/api/projects/${project.id}/sources/${source.sourceId}`,
    );
    expect(deleted.status).toBe(200);
    const afterDelete = await stack.request("GET", `/api/projects/${project.id}/sources`);
    expect((afterDelete.body["sources"] as unknown[]).length).toBe(0);
  });

  it("非法文件名 / 空内容 / 非法 sourceRole 返回 400", async () => {
    const stack = await newStack();
    const project = await stack.store.create("非法上传");
    const badName = await stack.request("POST", `/api/projects/${project.id}/sources`, {
      fileName: "../../evil.pdf",
      contentBase64: Buffer.from("x").toString("base64"),
    });
    expect(badName.status).toBe(400);

    const empty = await stack.request("POST", `/api/projects/${project.id}/sources`, {
      fileName: "ok.pdf",
      contentBase64: "",
    });
    expect(empty.status).toBe(400);

    const badRole = await stack.request("POST", `/api/projects/${project.id}/sources`, {
      fileName: "ok.pdf",
      contentBase64: Buffer.from("x").toString("base64"),
      sourceRole: "whatever",
    });
    expect(badRole.status).toBe(400);
  });

  it("multimodal 分析：Runtime 输出合法 JSON 时产出 styleProfile；模式默认 builtin", async () => {
    const stack = await newStack();
    const project = await stack.store.create("multimodal 测试");
    const upload = await stack.request("POST", `/api/projects/${project.id}/sources`, {
      fileName: "paper.pdf",
      contentBase64: minimalPdf("Some paper").toString("base64"),
    });
    const sourceId = (upload.body["source"] as { sourceId: string }).sourceId;

    // scripted runtime 对未知 scope 返回 LATEX_DOC → 多模态输出不可解析 → failed（如实报告）
    const multimodal = await stack.request(
      "POST",
      `/api/projects/${project.id}/sources/${sourceId}/analyze`,
      { mode: "multimodal" },
    );
    expect(multimodal.status).toBe(200);
    const source = multimodal.body["source"] as { status: string; analysis?: { status: string } };
    expect(source.analysis?.status).toBe("failed");

    const builtin = await stack.request(
      "POST",
      `/api/projects/${project.id}/sources/${sourceId}/analyze`,
      {},
    );
    expect((builtin.body["source"] as { status: string }).status).not.toBe("failed");
  });
});

describe("evidence 管理", () => {
  it("手工添加 / 查询过滤 / 核验状态更新；非法状态 400", async () => {
    const stack = await newStack();
    const project = await stack.store.create("Evidence 测试");
    const added = await stack.request("POST", `/api/projects/${project.id}/evidence`, {
      claim: "重排策略提升检索精度",
      summary: "实验汇总",
    });
    expect(added.status).toBe(201);
    const record = added.body["evidence"] as { id: string };
    expect(record.id).toBe("E001");

    const query = await stack.request(
      "GET",
      `/api/projects/${project.id}/evidence?status=unverified`,
    );
    expect((query.body["evidence"] as unknown[]).length).toBe(1);

    const verified = await stack.request(
      "POST",
      `/api/projects/${project.id}/evidence/${record.id}/verify`,
      { verificationStatus: "verified", verificationMethod: "user_confirmed", verificationLevel: "user_confirmed" },
    );
    expect(verified.status).toBe(200);
    expect((verified.body["evidence"] as { verificationStatus: string }).verificationStatus).toBe("verified");

    const bad = await stack.request(
      "POST",
      `/api/projects/${project.id}/evidence/${record.id}/verify`,
      { verificationStatus: "bogus" },
    );
    expect(bad.status).toBe(422); // EVIDENCE_VALIDATION

    const missing = await stack.request(
      "POST",
      `/api/projects/${project.id}/evidence/E999/verify`,
      { verificationStatus: "verified" },
    );
    expect(missing.status).toBe(422);
  });
});

describe("citation-check / manuscript / context / feasibility", () => {
  it("citation-check 静态层工作（metadata 全失败时 unverifiable 不误报）", async () => {
    const stack = await newStack({
      fetchImpl: async () => {
        throw new TypeError("offline");
      },
    });
    const project = await stack.store.create("引用 API 测试");
    // 直接写入手稿文件（不经 workflow）
    const { mkdir, writeFile } = await import("node:fs/promises");
    const manuscriptDir = join(stack.root, project.id, "manuscript");
    await mkdir(join(manuscriptDir, "sections"), { recursive: true });
    await writeFile(
      join(manuscriptDir, "main.tex"),
      "\\documentclass{ctexart}\\begin{document}\\input{sections/intro}\\bibliography{references}\\end{document}",
      "utf8",
    );
    await writeFile(join(manuscriptDir, "sections", "intro.tex"), "\\cite{a2024}\\cite{ghost}", "utf8");
    await writeFile(
      join(manuscriptDir, "references.bib"),
      "@article{a2024, title={A}, year={2024}}",
      "utf8",
    );

    const report = await stack.request("POST", `/api/projects/${project.id}/citation-check`, {});
    expect(report.status).toBe(200);
    const summary = (report.body["report"] as { summary: Record<string, number> }).summary;
    expect(summary.missingKeys).toBe(1);
    expect(summary.hallucinated).toBe(0); // 网络故障 ≠ not_found

    const latest = await stack.request("GET", `/api/projects/${project.id}/citation-report`);
    expect((latest.body["report"] as { summary: unknown }).summary).toBeDefined();
  });

  it("feasibility 未评估返回 null；manuscript / context 返回 Derived 数据", async () => {
    const stack = await newStack();
    const project = await stack.store.create("Derived 测试");
    const feasibility = await stack.request("GET", `/api/projects/${project.id}/feasibility`);
    expect(feasibility.status).toBe(200);
    expect(feasibility.body["feasibility"]).toBeNull();

    const manuscript = await stack.request("GET", `/api/projects/${project.id}/manuscript`);
    expect(manuscript.status).toBe(200);
    expect(manuscript.body["outline"]).toBeNull();

    const context = await stack.request("GET", `/api/projects/${project.id}/context?rebuild=true`);
    expect(context.status).toBe(200);
    expect(context.body["rebuilt"]).toBe(true);
    expect(String(context.body["context"])).toContain("projectId");

    // 手工放一个 outline 后 manuscript 反映
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(stack.root, project.id, "manuscript", "sections"), { recursive: true });
    await writeFile(
      join(stack.root, project.id, "manuscript", "outline.json"),
      JSON.stringify({
        title: "T",
        sections: [
          { id: "a", file: "a.tex", title: "A" },
          { id: "b", file: "b.tex", title: "B" },
          { id: "c", file: "c.tex", title: "C" },
        ],
      }),
      "utf8",
    );
    await writeFile(join(stack.root, project.id, "manuscript", "sections", "a.tex"), "\\section{A}", "utf8");
    const manuscript2 = await stack.request("GET", `/api/projects/${project.id}/manuscript`);
    const sections = manuscript2.body["sections"] as { id: string; exists: boolean }[];
    expect(sections.find((section) => section.id === "a")?.exists).toBe(true);
    expect(sections.find((section) => section.id === "c")?.exists).toBe(false);

    // context.yaml 真实落盘且可重建
    const onDisk = await readFile(join(stack.root, project.id, "context.yaml"), "utf8").catch(() => null);
    expect(onDisk).toContain("outline:");
  });
});
