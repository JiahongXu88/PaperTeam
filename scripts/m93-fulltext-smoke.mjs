#!/usr/bin/env node
/**
 * M9.3 Academic FullText Activation 真实 smoke（一次性脚本，不进 CI）。
 *
 * 与单元测试的区别：真实 OA resolver 外呼（OpenAlex oa-url / arXiv / Unpaywall）
 * + 真实 PDF 下载 + 真实解析 / chunk / 检索，走 HTTP 全链（createBackendHttpServer
 * + buildServiceStack 生产装配，FullTextSupport 由 serviceStack 注入——脚本只
 * 提供 dummy runtime，全文链路不触碰模型）。
 *
 * 场景（对应 M9.3 验收 §26/§27）：
 *   A. 真实 OA 批量补全：2 篇 PLOS ONE（DOI → OpenAlex oa-url → CC-BY PDF）
 *      + 1 篇 arXiv:1706.03762（Attention Is All You Need；arxiv resolver），
 *      经 POST /sources/resolve-fulltext 批量端点（有界并发）；
 *   B. 逐篇断言：outcome=resolved、文件落盘（%PDF- 魔数 + 大小）、
 *      fullText provenance（resolver / license / bytes / attempts）；
 *   C. 检索验收：POST /retrieval/search 用每篇 chunk 文本中的真实词命中
 *      该 source 的 chunk（chunkId / sourceId / sectionId / text 四件套）；
 *   D. 手动上传 fallback：url-only 条目（Web 候选定位）挂本地最小 PDF →
 *      resolved + chunk 可检索；
 *   E. Web 边界：url-only 条目进批量 → notResolvable，不产生下载。
 *
 * 用法：node scripts/m93-fulltext-smoke.mjs
 * 前置：npm --prefix backend run build（backend/dist 最新）；外网可达。
 */

import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

// 临时项目根（必须在 loadConfig 前设置；绝对路径）
const projectsRoot = await mkdtemp(join(tmpdir(), "m93-fulltext-projects-"));
process.env["PROJECTS_ROOT"] = projectsRoot;
// Unpaywall 需 email（礼貌池；同时给 OpenAlex mailto）
process.env["PAPERTEAM_OPENALEX_MAILTO"] ??= "paperteam.smoke@example.com";

const results = [];
const record = (step, ok, detail) => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail !== undefined ? ` — ${detail}` : ""}`);
};

// 真实 OA 论文（探测于 2026-09-22：OpenAlex best_oa_location.pdf_url 有效、CC-BY）。
// arXiv 选小体积论文（~110KB）：本机到 arxiv.org 带宽 ~16KB/s，2MB 级论文会撞上
// 下载层 60s 硬超时（产品常量，不为 smoke 放宽）——如实记录为环境限制。
const OA_PAPERS = [
  {
    label: "PLOS-robotic-nephrectomy",
    doi: "10.1371/journal.pone.0210413",
    expectResolver: ["oa-url", "unpaywall"],
    expectLicense: /cc-by/i,
  },
  {
    label: "PLOS-x-linked-cnv",
    doi: "10.1371/journal.pone.0097746",
    expectResolver: ["oa-url", "unpaywall"],
    expectLicense: /cc-by/i,
  },
];
const ARXIV_PAPER = { label: "arXiv-1801.00653", arxivId: "1801.00653", expectResolver: ["arxiv"] };

try {
  const { loadConfig } = await import(distUrl("config", "config.js"));
  const { buildServiceStack } = await import(distUrl("serviceStack.js"));
  const { ProjectStore } = await import(distUrl("project", "ProjectStore.js"));
  const { LatexCompiler } = await import(distUrl("latex", "LatexCompiler.js"));
  const { createBackendHttpServer } = await import(distUrl("httpServer.js"));
  const { WorkflowOrchestrator } = await import(distUrl("workflow", "WorkflowOrchestrator.js"));
  const { WorkflowRunStore } = await import(distUrl("workflow", "runStore.js"));
  const { createIdeaToPaperDefinition } = await import(distUrl("workflow", "definitions.js"));

  const config = loadConfig();
  const projects = new ProjectStore({ root: config.projectsRoot });
  const latex = new LatexCompiler({ timeoutMs: 10_000 });
  // dummy runtime：全文链路不触碰模型（startAgent 被调用即 fail-fast）
  const runtime = {
    async startAgent() {
      throw new Error("m93-smoke: 全文链路不应触碰 Agent runtime");
    },
    async runAgent() {
      throw new Error("m93-smoke: 全文链路不应触碰 Agent runtime");
    },
    async getTask() {
      throw new Error("m93-smoke: 不应查询 runtime task");
    },
  };
  const stack = buildServiceStack({
    runtime,
    projects,
    latex,
    agentIds: { writer: "w", researcher: "r", reviewer: "v", citation: "c" },
    citation: { metadataEnabled: false, scholarly: { providers: [] } },
    log: () => {},
  });
  const orchestrator = new WorkflowOrchestrator({
    projects,
    runStore: new WorkflowRunStore(projects),
    definitionFactory: () => createIdeaToPaperDefinition(stack.workflowServices),
    log: () => {},
  });
  const server = createBackendHttpServer({
    runtime,
    projects,
    generation: stack.generation,
    orchestrator,
    stack,
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
        : {}),
    });
    let parsed;
    try {
      parsed = await response.json();
    } catch {
      parsed = {};
    }
    return { status: response.status, body: parsed };
  };
  console.log(`m93 fulltext smoke — backend http on ${base}\n`);

  // ---- 建项目 + 导入（enrich:false 保持元数据离线确定性；全文链路才是被测对象） ----
  const created = await request("POST", "/api/projects", { title: "M9.3 FullText Live Smoke" });
  const projectId = created.body.project?.id;
  if (created.status !== 201 || projectId === undefined) {
    throw new Error(`项目创建失败：${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);
  }

  const imported = [];
  for (const paper of OA_PAPERS) {
    const r = await request("POST", `/api/projects/${projectId}/sources/import/doi`, {
      doi: paper.doi,
      enrich: false,
    });
    if (r.status !== 201) throw new Error(`DOI 导入失败（${paper.doi}）：${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    imported.push({ ...paper, sourceId: r.body.source.sourceId });
  }
  {
    const r = await request("POST", `/api/projects/${projectId}/sources/import/arxiv`, {
      arxivId: ARXIV_PAPER.arxivId,
      enrich: false,
    });
    if (r.status !== 201) throw new Error(`arXiv 导入失败：${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    imported.push({ ...ARXIV_PAPER, sourceId: r.body.source.sourceId });
  }
  // E. Web 边界：url-only 条目（不可自动获取，也不该被下载）
  const webImport = await request("POST", `/api/projects/${projectId}/sources/import/url`, {
    url: "https://blog.example.org/m93-web-candidate",
  });
  const webSourceId = webImport.body.source.sourceId;
  record("导入 4 条元数据（2 DOI + 1 arXiv + 1 url-only）", webImport.status === 201);

  // ---- A. 批量真实 OA 补全（url-only 一并送入 → 应落 notResolvable 桶） ----
  const batchStarted = Date.now();
  const batch = await request("POST", `/api/projects/${projectId}/sources/resolve-fulltext`, {
    sourceIds: [...imported.map((p) => p.sourceId), webSourceId],
  });
  const batchMs = Date.now() - batchStarted;
  if (batch.status !== 200) throw new Error(`批量端点失败：${batch.status} ${JSON.stringify(batch.body).slice(0, 300)}`);
  const summary = batch.body.summary;
  record(
    "批量 resolve summary（3 resolved / 1 notResolvable）",
    summary.resolved === 3 && summary.notResolvable === 1 && summary.total === 4,
    JSON.stringify(summary) + `（${batchMs}ms）`,
  );
  for (const entry of batch.body.results ?? []) {
    if (entry.outcome !== "resolved" && entry.outcome !== "not_resolvable") {
      console.log(`      ↳ ${entry.sourceId} ${entry.outcome}: ${(entry.note ?? "").slice(0, 240)}`);
    }
  }

  // ---- B. 逐篇 provenance + 文件断言 ----
  const chunkSamples = [];
  for (const paper of imported) {
    const got = await request("GET", `/api/projects/${projectId}/sources/${paper.sourceId}`);
    const source = got.body.source;
    if (source.fileName === undefined) {
      // 未 resolved：如实记录后继续（不让一篇失败推翻整轮 smoke 的其余断言）
      record(
        `${paper.label}：resolved + 文件 + provenance`,
        false,
        `outcome 落 ${source.fullText?.status ?? "未尝试"}，note=${(source.fullText?.note ?? "").slice(0, 240)}`,
      );
      continue;
    }
    const okOutcome =
      source.fullText?.status === "resolved" &&
      paper.expectResolver.includes(source.fullText.resolver);
    const paperPath = join(projects.sourcesDir(projectId), "papers", source.fileName);
    const fileOk = existsSync(paperPath);
    let magicOk = false;
    let bytesOnDisk = 0;
    if (fileOk) {
      const head = Buffer.from(await readFile(paperPath)).subarray(0, 5).toString("latin1");
      magicOk = head === "%PDF-";
      bytesOnDisk = statSync(paperPath).size;
    }
    const licenseOk =
      paper.expectLicense === undefined ||
      paper.expectLicense.test(source.fullText?.license ?? "") ||
      source.fullText?.license === undefined; // arXiv 无 license 字段（合法缺省）
    record(
      `${paper.label}：resolved + 文件 + provenance`,
      okOutcome && fileOk && magicOk && licenseOk,
      `resolver=${source.fullText?.resolver} license=${source.fullText?.license ?? "-"} bytes=${source.fullText?.bytes}（磁盘 ${bytesOnDisk}B）attempts=${source.fullText?.attempts}`,
    );

    // ---- C. 检索验收：从 chunk 真实文本取词检索 ----
    const chunkFile = join(projects.sourcesDir(projectId), "chunks", `${paper.sourceId}.jsonl`);
    if (!existsSync(chunkFile)) {
      record(`${paper.label}：chunk 落盘`, false, "chunks/<id>.jsonl 不存在");
      continue;
    }
    const lines = (await readFile(chunkFile, "utf8")).split("\n").filter(Boolean);
    const firstChunk = JSON.parse(lines[0]);
    const probe = distinctiveTerm(firstChunk.text);
    const search = await request("POST", `/api/projects/${projectId}/retrieval/search`, {
      query: probe,
      topK: 5,
    });
    const hit = (search.body.results ?? []).find((r) => r.chunk?.sourceId === paper.sourceId);
    record(
      `${paper.label}：retrieve_library 语义命中真实 chunk`,
      hit !== undefined,
      hit !== undefined
        ? `probe="${probe}" → chunkId=${hit.chunk.chunkId}（chunks=${lines.length}，score.fused=${hit.score?.fused?.toFixed(4)}）`
        : `probe="${probe}" 未命中（chunks=${lines.length}）`,
    );
    chunkSamples.push({
      label: paper.label,
      sourceId: paper.sourceId,
      chunkId: hit?.chunk?.chunkId ?? firstChunk.chunkId,
      sectionId: hit?.chunk?.sectionId ?? firstChunk.sectionId,
      chunkCount: lines.length,
    });
  }

  // ---- D. 手动上传 fallback（url-only 条目 + 本地最小文本层 PDF） ----
  const manualPdf = buildMinimalTextPdf(
    "M93 manual upload fallback marker. Deterministic lexical retrieval probe sentence. ".repeat(4),
  );
  const manual = await request("POST", `/api/projects/${projectId}/sources/${webSourceId}/fulltext`, {
    fileName: "author-copy.pdf",
    contentBase64: manualPdf.toString("base64"),
  });
  const manualOk =
    manual.status === 200 &&
    manual.body.outcome === "resolved" &&
    manual.body.source.fullText?.resolver === "manual-upload";
  record("手动上传 PDF → resolved + manual-upload provenance", manualOk, `bytes=${manual.body.source?.fullText?.bytes}`);

  const manualSearch = await request("POST", `/api/projects/${projectId}/retrieval/search`, {
    query: "manual upload fallback marker",
    topK: 5,
  });
  const manualHit = (manualSearch.body.results ?? []).find((r) => r.chunk?.sourceId === webSourceId);
  record(
    "手动上传 PDF → chunk 可检索",
    manualHit !== undefined,
    manualHit !== undefined ? `chunkId=${manualHit.chunk.chunkId}` : "未命中",
  );

  // ---- Evidence 边界（live 复核） ----
  const evidence = await request("GET", `/api/projects/${projectId}/evidence`);
  record("全文操作零 Evidence（Verified Evidence = 0 合法）", Array.isArray(evidence.body.evidence) && evidence.body.evidence.length === 0);

  // ---- 幂等（live 复核：再批量一次全部 skipped） ----
  const again = await request("POST", `/api/projects/${projectId}/sources/resolve-fulltext`, {
    sourceIds: imported.map((p) => p.sourceId),
  });
  record("二次批量幂等（全部 skipped，不重复下载）", again.body.summary?.skipped === 3, JSON.stringify(again.body.summary));

  console.log("\nchunk 样本（不dump正文）：");
  for (const sample of chunkSamples) {
    console.log(`  ${sample.label}: sourceId=${sample.sourceId} chunkId=${sample.chunkId} sectionId=${sample.sectionId} chunks=${sample.chunkCount}`);
  }
  await new Promise((resolveClose) => server.close(resolveClose));
} catch (error) {
  record("脚本执行", false, error instanceof Error ? error.message : String(error));
} finally {
  await rm(projectsRoot, { recursive: true, force: true });
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n==== M9.3 live smoke：${results.length - failed.length}/${results.length} PASS ====`);
if (failed.length > 0) {
  process.exitCode = 1;
}

// ---- helpers ----

/** 从 chunk 文本挑一个可检索的区分性词（≥5 字符字母词，取中段避免页眉噪声） */
function distinctiveTerm(text) {
  const words = (text ?? "").match(/[A-Za-z]{5,}/g) ?? [];
  const pick = words.slice(3, 12).filter((w) => !/^(paper|study|results|figure|table|section|abstract|introduction|methodology)$/i.test(w));
  return pick[0] ?? words[0] ?? "paper";
}

/** 与 backend 测试同构的最小文本层 PDF（builtin 分析 ok + chunker 可索引） */
function buildMinimalTextPdf(text) {
  const content = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, " ")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  const parts = ["%PDF-1.4"];
  let offset = parts[0].length + 1;
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(offset);
    const object = `${index + 1} 0 obj\n${body}\nendobj\n`;
    parts.push(object);
    offset += object.length;
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  parts.push(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`);
  return Buffer.from(parts.join("\n"), "latin1");
}
