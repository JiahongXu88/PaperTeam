/**
 * Existing-LaTeX 导入测试（M3.2）：
 * ZIP 读取安全（Zip Slip / 大小与数量上限 / 非法条目）、结构识别、
 * baseline snapshot、导入后项目保持可编译（注入式 LaTeX runner）。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

import { afterAll, describe, expect, it } from "vitest";

import { ImportValidationError } from "../../src/errors.js";
import { LatexImporter } from "../../src/import/LatexImporter.js";
import { readZipEntries, requireSafeEntryName } from "../../src/import/zipReader.js";
import { LatexCompiler, type CommandRunner } from "../../src/latex/LatexCompiler.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import { collectLatexFiles } from "../../src/manuscript/LatexFiles.js";
import { fakeSuccessfulRunner } from "../helpers/testStack.js";

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

// ---- ZIP 构造辅助 ----

interface ZipEntrySpec {
  name: string;
  data: Buffer;
}

function buildZip(entries: ZipEntrySpec[], method: "store" | "deflate" = "store"): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const compressed = method === "deflate" ? deflateRawSync(entry.data) : entry.data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method === "deflate" ? 8 : 0, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(0, 14); // crc（测试不校验）
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBytes, compressed);

    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(0x02014b50, 0);
    centralEntry.writeUInt16LE(20, 4);
    centralEntry.writeUInt16LE(20, 6);
    centralEntry.writeUInt16LE(method === "deflate" ? 8 : 0, 10);
    centralEntry.writeUInt32LE(compressed.length, 20);
    centralEntry.writeUInt32LE(entry.data.length, 24);
    centralEntry.writeUInt16LE(nameBytes.length, 28);
    centralEntry.writeUInt32LE(offset, 42);
    central.push(centralEntry, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralStart = offset;
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}

const MAIN_TEX = [
  "\\documentclass[UTF8]{ctexart}",
  "\\begin{document}",
  "\\input{sections/introduction}",
  "\\input{sections/conclusion}",
  "\\bibliographystyle{unsrt}",
  "\\bibliography{references}",
  "\\end{document}",
].join("\n");

const SAMPLE_PROJECT: ZipEntrySpec[] = [
  { name: "main.tex", data: Buffer.from(MAIN_TEX, "utf8") },
  { name: "sections/introduction.tex", data: Buffer.from("\\section{引言}\n引用 \\cite{a}。", "utf8") },
  { name: "sections/conclusion.tex", data: Buffer.from("\\section{结论}\n结论。", "utf8") },
  { name: "references.bib", data: Buffer.from("@article{a, title={A}, year={2020}}", "utf8") },
  { name: "figures/plot.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
];

async function newImporter(runner: CommandRunner = fakeSuccessfulRunner): Promise<{
  store: ProjectStore;
  importer: LatexImporter;
  projectId: string;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-imp-"));
  tempRoots.push(root);
  const store = new ProjectStore({ root });
  const project = await store.create("导入测试");
  const latex = new LatexCompiler({ timeoutMs: 10_000, runner });
  return { store, importer: new LatexImporter({ projects: store, latex, log: () => {} }), projectId: project.id, root };
}

// ---- zipReader 安全 ----

describe("readZipEntries / requireSafeEntryName（防 Zip Slip）", () => {
  it("穿越路径（../）、绝对路径、反斜杠、盘符全部拒绝", () => {
    expect(() => requireSafeEntryName("../../evil.tex")).toThrow();
    expect(() => requireSafeEntryName("a/../../evil.tex")).toThrow();
    expect(() => requireSafeEntryName("/etc/passwd")).toThrow();
    expect(() => requireSafeEntryName("a\\b.tex")).toThrow();
    expect(() => requireSafeEntryName("C:\\temp\\x.tex")).toThrow();
    expect(requireSafeEntryName("sections/introduction.tex")).toBe("sections/introduction.tex");
  });

  it("含穿越条目的归档在读取时整体拒绝", () => {
    const zip = buildZip([
      { name: "main.tex", data: Buffer.from(MAIN_TEX, "utf8") },
      { name: "../evil.tex", data: Buffer.from("evil", "utf8") },
    ]);
    expect(() => readZipEntries(zip)).toThrow(/路径穿越/);
  });

  it("非 ZIP / 损坏数据拒绝", () => {
    expect(() => readZipEntries(Buffer.from("not a zip at all"))).toThrow(/ZIP/);
  });

  it("store 与 deflate 两种压缩方式均可读取", () => {
    const stored = readZipEntries(buildZip(SAMPLE_PROJECT, "store"));
    expect(stored.map((entry) => entry.name)).toContain("sections/introduction.tex");
    const deflated = readZipEntries(buildZip(SAMPLE_PROJECT, "deflate"));
    expect(deflated.find((entry) => entry.name === "main.tex")?.data.toString("utf8")).toContain(
      "\\documentclass",
    );
  });

  it("大小与条目数上限生效", () => {
    const big = buildZip([
      { name: "main.tex", data: Buffer.from(MAIN_TEX, "utf8") },
      { name: "huge.tex", data: Buffer.alloc(21 * 1024 * 1024) },
    ]);
    expect(() => readZipEntries(big)).toThrow(/单文件上限/);
  });
});

// ---- LatexImporter ----

describe("LatexImporter", () => {
  it("合法项目导入：结构识别正确、快照可回溯、项目保持可编译", async () => {
    const { importer, projectId, root } = await newImporter();
    const report = await importer.importFromArchive(projectId, buildZip(SAMPLE_PROJECT, "deflate"));

    expect(report.entryCount).toBe(5);
    expect(report.structure.entryFile).toBe("main.tex");
    expect(report.structure.texFiles).toHaveLength(3);
    expect(report.structure.bibFile).toBe("references.bib");
    expect(report.structure.figures).toEqual(["figures/plot.png"]);
    expect(report.baselineCompile.ok).toBe(true);

    // manuscript 内文件真实落盘且 \input 图可达
    const manuscriptDir = join(root, projectId, "manuscript");
    const main = await readFile(join(manuscriptDir, "main.tex"), "utf8");
    expect(main).toContain("\\input{sections/introduction}");
    await readFile(join(manuscriptDir, "figures", "plot.png"));

    // baseline 快照（原始导入内容，可回溯）
    const snapshotMain = await readFile(join(root, projectId, report.snapshotDir, "main.tex"), "utf8");
    expect(snapshotMain).toBe(MAIN_TEX);

    // 导入后项目仍可编译（fake runner 真实执行 compile 流程）
    const files = await collectLatexFiles(manuscriptDir);
    expect(files.allTex).toHaveLength(3);
    expect(files.bibContent).toContain("@article{a,");

    // 项目被标记为 existing_paper_improvement
    expect((await new ProjectStore({ root }).get(projectId))?.workflowKind).toBe(
      "existing_paper_improvement",
    );
  });

  it("入口不是 main.tex 时：选含 \\documentclass 的文件并复制为 main.tex 编译", async () => {
    const { importer, projectId, root } = await newImporter();
    const report = await importer.importFromArchive(
      projectId,
      buildZip([
        { name: "paper.tex", data: Buffer.from(MAIN_TEX, "utf8") },
        { name: "sections/introduction.tex", data: Buffer.from("\\section{引言}", "utf8") },
        { name: "sections/conclusion.tex", data: Buffer.from("\\section{结论}", "utf8") },
      ]),
    );
    expect(report.structure.entryFile).toBe("paper.tex");
    expect(report.baselineCompile.ok).toBe(true);
    // main.tex 已生成（编译入口约定）
    const main = await readFile(join(root, projectId, "manuscript", "main.tex"), "utf8");
    expect(main).toContain("\\documentclass");
  });

  it("无 .tex / 无 \\documentclass / 非法扩展名 → IMPORT_VALIDATION", async () => {
    const { importer, projectId } = await newImporter();
    await expect(
      importer.importFromArchive(projectId, buildZip([{ name: "readme.md", data: Buffer.from("x") }])),
    ).rejects.toBeInstanceOf(ImportValidationError);
    await expect(
      importer.importFromArchive(
        projectId,
        buildZip([{ name: "a.tex", data: Buffer.from("无 documentclass") }]),
      ),
    ).rejects.toThrow(/documentclass/);
    await expect(
      importer.importFromArchive(
        projectId,
        buildZip([{ name: "main.tex", data: Buffer.from(MAIN_TEX) }, { name: "evil.exe", data: Buffer.from("x") }]),
      ),
    ).rejects.toThrow(/不允许的文件类型/);
  });

  it("importFromFiles（JSON 内联）：路径穿越拒绝；正常导入成功", async () => {
    const { importer, projectId } = await newImporter();
    await expect(
      importer.importFromFiles(projectId, [
        { path: "../evil.tex", contentBase64: Buffer.from("x").toString("base64") },
      ]),
    ).rejects.toBeInstanceOf(ImportValidationError);

    const report = await importer.importFromFiles(projectId, [
      { path: "main.tex", contentBase64: Buffer.from(MAIN_TEX).toString("base64") },
      { path: "sections/introduction.tex", contentBase64: Buffer.from("\\section{引言}").toString("base64") },
      { path: "sections/conclusion.tex", contentBase64: Buffer.from("\\section{结论}").toString("base64") },
    ]);
    expect(report.entryCount).toBe(3);
    expect(report.baselineCompile.ok).toBe(true);
  });

  it("baseline 编译失败被如实记录（不是导入失败）", async () => {
    const { store, projectId } = await newImporter();
    const latex = new LatexCompiler({
      timeoutMs: 5_000,
      runner: async (command, args) => {
        if (args.includes("--version")) {
          return { code: 0, stdout: "1.0", stderr: "" };
        }
        return { code: 1, stdout: "! Broken.", stderr: "" };
      },
    });
    const failingImporter = new LatexImporter({ projects: store, latex, log: () => {} });
    const report = await failingImporter.importFromFiles(projectId, [
      { path: "main.tex", contentBase64: Buffer.from(MAIN_TEX).toString("base64") },
    ]);
    expect(report.baselineCompile.ok).toBe(false);
    expect(report.baselineCompile.error).toContain("Broken");
  });
});
