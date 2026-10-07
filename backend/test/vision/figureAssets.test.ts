/**
 * M12 Batch 2 · B4：figureAssets 安全解析（逻辑层；路由由主线按契约接线）。
 *
 * 攻击面逐一覆盖：路径遍历（../ 与 ..\）、编码遍历（%2F 解码形态）、
 * 绝对路径（posix 与 Windows 盘符）、嵌套前缀、NUL/控制字符、前导点、
 * 分隔符、扩展名白名单、登记外残留（stale）、登记存在但文件缺失、
 * realpath 包含校验（符号链接劫持——Windows 无特权时 skipIf）。
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import type { ParsedDocument } from "../../src/ingestion/types.js";
import {
  resolveGeneratedFigureAsset,
  resolveSourceFigureAsset,
  type GeneratedFigureRegistry,
  type ParsedDocumentAccess,
} from "../../src/vision/figureAssets.js";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function makeSetup(): Promise<{ projects: ProjectStore; projectId: string; figuresDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-fig-"));
  roots.push(root);
  const projects = new ProjectStore({ root });
  const project = await projects.create("figure assets test");
  const figuresDir = join(projects.sourcesDir(project.id), "figures", "S0001");
  await mkdir(figuresDir, { recursive: true });
  await writeFile(join(figuresDir, "fig-001.png"), PNG_BYTES);
  await writeFile(join(figuresDir, "fig-002.jpg"), PNG_BYTES); // 内容签名不校验（MIME 由扩展名声明）
  return { projects, projectId: project.id, figuresDir };
}

function documentsAccess(doc: ParsedDocument | null): ParsedDocumentAccess {
  return {
    async load() {
      return doc;
    },
  };
}

function docWithAssets(...assetNames: string[]): ParsedDocument {
  return {
    schemaVersion: 1,
    sourceId: "S0001",
    fileName: "S0001-paper.pdf",
    storedFileName: "S0001-paper.pdf",
    kind: "pdf",
    mimeType: "application/pdf",
    parser: { id: "docling", version: "test" },
    parseMode: "structured",
    status: "ok",
    pageCount: 1,
    blocks: assetNames.map((assetName, index) => ({
      blockId: `B${String(index + 1).padStart(4, "0")}`,
      type: "figure" as const,
      provenance: { fileName: "S0001-paper.pdf", page: 1 },
      assetName,
    })),
    counts: {
      text: 0,
      table: 0,
      figure: assetNames.length,
      formula: 0,
      structured_record: 0,
      code: 0,
      output: 0,
    },
    notes: [],
    contentHash: "a".repeat(64),
    parsedAt: "2026-10-07T00:00:00.000Z",
  };
}

describe("M12 B4 source 抽图解析：正常路径", () => {
  it("登记内 png → bytes + image/png；jpg → image/jpeg", async () => {
    const { projects, projectId } = await makeSetup();
    const documents = documentsAccess(docWithAssets("fig-001.png", "fig-002.jpg"));
    const png = await resolveSourceFigureAsset({ projects, documents, projectId, sourceId: "S0001", assetName: "fig-001.png" });
    expect(png).toMatchObject({ ok: true, asset: { mimeType: "image/png", byteLength: PNG_BYTES.length } });
    const jpg = await resolveSourceFigureAsset({ projects, documents, projectId, sourceId: "S0001", assetName: "fig-002.jpg" });
    expect(jpg).toMatchObject({ ok: true, asset: { mimeType: "image/jpeg" } });
  });

  it("无 documents 访问器 → 纯文件系统模式（跳过登记检查）", async () => {
    const { projects, projectId } = await makeSetup();
    const result = await resolveSourceFigureAsset({ projects, projectId, sourceId: "S0001", assetName: "fig-001.png" });
    expect(result).toMatchObject({ ok: true });
  });
});

describe("M12 B4 source 抽图解析：攻击面（全部在文件系统访问前/受控内拒绝）", () => {
  const ATTACK_NAMES = [
    "..",
    "../fig-001.png",
    "..%2F..%2Fetc%2Fpasswd", // 已解码的编码遍历（httpServer decode 后到达本层）
    "..\\..\\secret.png", // 反斜杠遍历（Windows 分隔符）
    "a/../../fig-001.png", // 嵌套前缀遍历
    "sub/fig-001.png", // 目录分隔（扁平名不允许）
    "/etc/passwd", // posix 绝对路径
    "C:\\Windows\\system32\\x.png", // Windows 盘符绝对路径
    "\\\\server\\share\\x.png", // UNC
    "fig-001.png\0.png", // NUL
    ".fig-001.png", // 前导点（隐藏文件）
    "fig-001.png/../../x", // 尾部遍历
    "....png", // 双点段
  ];

  it("逐攻击名独立断言：全部拒绝且绝不成功", async () => {
    const { projects, projectId } = await makeSetup();
    for (const name of ATTACK_NAMES) {
      const result = await resolveSourceFigureAsset({ projects, projectId, sourceId: "S0001", assetName: name });
      expect(result.ok, `资产名 "${name}" 不应解析成功`).toBe(false);
      if (!result.ok) {
        expect(["invalid_path", "unsupported_asset"]).toContain(result.failure.code);
        expect([400, 404]).toContain(result.failure.httpStatus);
      }
    }
  });

  it("扩展名白名单：gif/txt/exe/无扩展名 → unsupported_asset 或 invalid_path", async () => {
    const { projects, projectId } = await makeSetup();
    for (const name of ["fig-001.gif", "notes.txt", "payload.exe", "fig-001"]) {
      const result = await resolveSourceFigureAsset({ projects, projectId, sourceId: "S0001", assetName: name });
      expect(result.ok, name).toBe(false);
      if (!result.ok) {
        expect(["unsupported_asset", "invalid_path"]).toContain(result.failure.code);
      }
    }
  });

  it("非法 sourceId 形态 / 项目不存在 → invalid_path / invalid_project", async () => {
    const { projects, projectId } = await makeSetup();
    const badSource = await resolveSourceFigureAsset({ projects, projectId, sourceId: "s0001", assetName: "fig-001.png" });
    expect(badSource).toMatchObject({ ok: false, failure: { code: "invalid_path", httpStatus: 400 } });
    // 合法 id 形态但不存在的项目（项目 id 规则：小写字母数字连字符）
    const badProject = await resolveSourceFigureAsset({ projects, projectId: "p9999", sourceId: "S0001", assetName: "fig-001.png" });
    expect(badProject).toMatchObject({ ok: false, failure: { code: "invalid_project", httpStatus: 404 } });
  });

  it("登记外残留（文件在盘、不在 ParsedDocument figure 登记）→ stale_asset；登记内但文件缺失 → missing_artifact", async () => {
    const { projects, projectId, figuresDir } = await makeSetup();
    await writeFile(join(figuresDir, "orphan.png"), PNG_BYTES);
    const documents = documentsAccess(docWithAssets("fig-001.png", "gone.png"));
    const stale = await resolveSourceFigureAsset({ projects, documents, projectId, sourceId: "S0001", assetName: "orphan.png" });
    expect(stale).toMatchObject({ ok: false, failure: { code: "stale_asset", httpStatus: 404 } });
    const missing = await resolveSourceFigureAsset({ projects, documents, projectId, sourceId: "S0001", assetName: "gone.png" });
    expect(missing).toMatchObject({ ok: false, failure: { code: "missing_artifact", httpStatus: 404 } });
    const noDoc = await resolveSourceFigureAsset({
      projects,
      documents: documentsAccess(null),
      projectId,
      sourceId: "S0001",
      assetName: "fig-001.png",
    });
    expect(noDoc).toMatchObject({ ok: false, failure: { code: "missing_artifact" } });
  });

  it("realpath 包含校验：整个文件名是符号链接指向根外 → invalid_path（无符号链接权限则跳过）", async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), "paperteam-out-"));
    roots.push(outsideRoot);
    const outsideAsset = join(outsideRoot, "secret.png");
    await writeFile(outsideAsset, PNG_BYTES);
    const { projects, projectId, figuresDir } = await makeSetup();
    let linkCreated = true;
    try {
      await symlink(outsideAsset, join(figuresDir, "hijack.png"));
    } catch {
      linkCreated = false; // Windows 无特权创建符号链接失败：该断言环境不可达，跳过
    }
    if (linkCreated) {
      const result = await resolveSourceFigureAsset({ projects, projectId, sourceId: "S0001", assetName: "hijack.png" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.code).toBe("invalid_path");
      }
    }
  });
});

describe("M12 B4 生成图解析", () => {
  const FIG_ID = "fig-0123456789ab";
  const FILE_NAME = `${FIG_ID}.pdf`;
  const registry: GeneratedFigureRegistry = { async listFigIds() { return [FIG_ID]; } };

  async function makeGenerated(): Promise<{ projects: ProjectStore; projectId: string }> {
    const root = await mkdtemp(join(tmpdir(), "paperteam-gen-"));
    roots.push(root);
    const projects = new ProjectStore({ root });
    const project = await projects.create("generated assets test");
    const dir = join(projects.manuscriptDir(project.id), "figs", "generated");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, FILE_NAME), Buffer.from("%PDF-1.4 fake"));
    return { projects, projectId: project.id };
  }

  it("登记内 fig-<hex>.pdf → application/pdf", async () => {
    const { projects, projectId } = await makeGenerated();
    const result = await resolveGeneratedFigureAsset({ projects, projectId, fileName: FILE_NAME, registry });
    expect(result).toMatchObject({ ok: true, asset: { mimeType: "application/pdf" } });
  });

  it("形态不符（非 fig-<hex>.pdf）→ unsupported_asset；遍历/分隔符 → invalid_path", async () => {
    const { projects, projectId } = await makeGenerated();
    for (const name of ["main.pdf", "fig-XYZ.pdf", "../manifest.json", "fig-0123456789ab.pdf\\x", "fig-0123456789ab.tex", "fig-0123456789ab.pdf.pdf"]) {
      const result = await resolveGeneratedFigureAsset({ projects, projectId, fileName: name, registry });
      expect(result.ok, name).toBe(false);
    }
  });

  it("登记外（manifest 无该 figId）→ stale_asset；登记内但文件缺失 → missing_artifact", async () => {
    const { projects, projectId } = await makeGenerated();
    // 合法形态但不在 manifest（重解析/手工残留）
    await writeFile(
      join(projects.manuscriptDir(projectId), "figs", "generated", "fig-aaaaaaaabbbb.pdf"),
      Buffer.from("%PDF-1.4"),
    );
    const stale = await resolveGeneratedFigureAsset({
      projects,
      projectId,
      fileName: "fig-aaaaaaaabbbb.pdf",
      registry,
    });
    expect(stale).toMatchObject({ ok: false, failure: { code: "stale_asset", httpStatus: 404 } });
    // 登记内但 PDF 资产被手工删除
    const missing = await resolveGeneratedFigureAsset({
      projects,
      projectId,
      fileName: "fig-bbbbbbbbcccc.pdf",
      registry: { async listFigIds() { return ["fig-bbbbbbbbcccc"]; } },
    });
    expect(missing).toMatchObject({ ok: false, failure: { code: "missing_artifact", httpStatus: 404 } });
  });
});
