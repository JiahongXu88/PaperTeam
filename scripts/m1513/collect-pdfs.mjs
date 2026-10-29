#!/usr/bin/env node
/**
 * M15.13 Phase B — PeerRead ICLR 2017 候选论文 PDF 采集（只取选定 17 篇）。
 * 逐文件 raw.githubusercontent（CDN）+ 限速重试；输出 manuscripts/pr-XX.pdf
 * 与下载台账（字节数/SHA256/耗时）。许可证注意：PDF 版权归作者——仅内部分析，
 * 不进公开仓库（与 M15.11 纪律一致）。
 * 用法：node scripts/m1513/collect-pdfs.mjs
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1513_ROOT ? resolve(process.env.M1513_ROOT) : resolve("D:\\PaperTeamData\\M15\\M15_13");
const FRAME = join(ROOT, "phase-b", "candidate-frame.json");
const OUT_DIR = join(ROOT, "manuscripts");
const BASE = "https://raw.githubusercontent.com/allenai/peerread/master/data/iclr_2017";

const frame = JSON.parse(await readFile(FRAME, "utf8"));
await mkdir(OUT_DIR, { recursive: true });

const ledger = [];
for (const candidate of frame.candidates) {
  const dest = join(OUT_DIR, `fam-${candidate.candidateId}.pdf`);
  const url = `${BASE}/${candidate.split}/pdfs/${candidate.paperId}.pdf`;
  const startedAt = Date.now();
  let bytes = 0;
  let sha256 = "";
  let status = "ok";
  try {
    const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(300_000) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    bytes = buffer.byteLength;
    sha256 = createHash("sha256").update(buffer).digest("hex");
    if (bytes < 20_000 || buffer.subarray(0, 4).toString("latin1") !== "%PDF") {
      throw new Error(`not a PDF (${bytes} bytes, head=${buffer.subarray(0, 8).toString("latin1")})`);
    }
    await writeFile(dest, buffer);
  } catch (error) {
    status = `error: ${error.message}`;
  }
  ledger.push({
    candidateId: candidate.candidateId,
    role: candidate.role,
    paperId: candidate.paperId,
    split: candidate.split,
    url,
    status,
    bytes,
    sha256,
    ms: Date.now() - startedAt,
  });
  console.log(JSON.stringify(ledger.at(-1)));
  await new Promise((r) => setTimeout(r, 1000));
}
await writeFile(join(ROOT, "phase-b", "pdf-collection-ledger.json"), JSON.stringify(ledger, null, 1), "utf8");
console.log(`done: ok=${ledger.filter((l) => l.status === "ok").length}/${ledger.length}`);
