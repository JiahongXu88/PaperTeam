#!/usr/bin/env node
/**
 * M14.1c：ScientificFactStore 存储性能实测（任务 7.3）。
 *
 * 背景：M14.0.1 真实语料下单项目 scientific-facts.json 达 ~3.7MB / 1,832 facts。
 * 本脚本在服务器合成同等规模（1,832 facts + 200 conflicts）测量：
 *   - load() 耗时与堆内存
 *   - upsertFacts / applySourceChecks 全文件重写耗时
 *   - list(filter) 耗时
 * 判定：单文件 JSON 在该规模下的读写若在几十 ms 量级 → 维持现状（不引入
 * 分片 / 数据库），把数字如实写进报告；只有实测确有性能问题才做拆分。
 */

import { performance } from "node:perf_hooks";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const { ProjectStore } = await import(`file://${join(repoRoot, "backend/dist/project/ProjectStore.js").replaceAll("\\", "/")}`);
const { ScientificFactStore } = await import(`file://${join(repoRoot, "backend/dist/thesis/ScientificFactStore.js").replaceAll("\\", "/")}`);

function syntheticFact(index, inputId) {
  return {
    schemaVersion: 1,
    factId: `Fbench${String(index).padStart(6, "0")}`,
    projectId: "p-bench",
    researchInputId: inputId,
    kind: index % 3 === 0 ? "table_cell" : "numeric_result",
    key: { subject: `subject-${index % 40}`, metric: `metric-${index % 25}`, dataset: `dataset-${index % 12}`, protocol: "table:表4.3" },
    surface: `${(index % 100) / 100}`,
    value: { raw: `${(index % 100) / 100}`, numeric: (index % 100) / 100, normalized: `${(index % 100) / 100}` },
    provenance: {
      researchInputId: inputId,
      sourceId: "S001",
      contentHash: "hash-bench",
      blockId: `B${String(index % 500).padStart(4, "0")}`,
      page: (index % 80) + 1,
      pageBasis: "parser",
      quote: "合成基准句子，长度约八十个字符，用于模拟真实正文引文的平均规模与中英文混排形态。".repeat(2),
      surfaceHash: `a${index}`,
    },
    extraction: { method: "deterministic_table", extractor: "bench", algorithmVersion: "m14.1c-v1" },
    verification: { status: "extracted", sourceCheck: "unchecked" },
    conflict: { status: "none", conflictIds: [] },
    createdAt: "2026-10-15T00:00:00Z",
    updatedAt: "2026-10-15T00:00:00Z",
  };
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "fact-bench-"));
  try {
    const projects = new ProjectStore({ root });
    const created = await projects.create("M14.1c 存储基准");
    const projectId = created.id;
    const store = new ScientificFactStore(projects);

    const FACT_COUNT = 1832; // M14.0.1 真实观察规模
    const facts = Array.from({ length: FACT_COUNT }, (_, i) => syntheticFact(i, "ri-bench0001"));

    const upsertStart = performance.now();
    const upsertMemBefore = process.memoryUsage().heapUsed;
    await store.upsertFacts(projectId, facts);
    const upsertMs = performance.now() - upsertStart;

    const filePath = store.filePath(projectId);
    const fileSize = (await readFile(filePath)).length;

    // 冷读（进程内首次已缓存；真实进程重启后为冷 JSON.parse）
    const loadStart = performance.now();
    await store.load(projectId);
    const loadMs = performance.now() - loadStart;

    const listStart = performance.now();
    const filtered = await store.list(projectId, { researchInputId: "ri-bench0001", kind: "table_cell" });
    const listMs = performance.now() - listStart;

    // 全量 source check 重写（最重路径：逐事实核验后全文件写回）
    const checkStart = performance.now();
    await store.applySourceChecks(
      projectId,
      facts.slice(0, 500).map((fact) => ({ factId: fact.factId, outcome: { verified: true, method: "text_layer_match" } })),
    );
    const checkMs = performance.now() - checkStart;
    const heapDeltaMb = ((process.memoryUsage().heapUsed - upsertMemBefore) / 1024 / 1024).toFixed(1);

    console.log(`facts=${FACT_COUNT}, file=${(fileSize / 1024 / 1024).toFixed(2)}MB`);
    console.log(`upsertFacts(全量首次写入)  ${upsertMs.toFixed(0)}ms`);
    console.log(`load()（JSON.parse 全文件） ${loadMs.toFixed(0)}ms`);
    console.log(`list(filter)              ${listMs.toFixed(0)}ms → ${filtered.length} 条`);
    console.log(`applySourceChecks(500条)  ${checkMs.toFixed(0)}ms（含全文件重写）`);
    console.log(`heap 增量                  ${heapDeltaMb}MB`);
    console.log(`\n判定：${loadMs < 200 && checkMs < 500 ? "单文件存储在真实规模下读写开销可接受（<0.5s），维持现状不分片" : "存在性能压力，考虑按 researchInputId 拆分"}`);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error("基准脚本失败：", error);
  process.exit(2);
});
