#!/usr/bin/env node
/**
 * M15.14 Phase B — PeerRead ICLR 2017 候选论文 PDF 采集（只取选定 17 篇）。
 * 平移 M15.13 collect-pdfs（raw.githubusercontent CDN + 限速 + SHA256 台账）。
 * 许可：PDF 版权归作者——仅内部分析，不进公开仓库。
 * 用法：node scripts/m1514/collect-pdfs.mjs
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1514_ROOT ? resolve(process.env.M1514_ROOT) : resolve("D:\\PaperTeamData\\M15\\M15_14");
const FRAME = join(ROOT, "phase-b", "candidate-frame.json");
const OUT_DIR = join(ROOT, "manuscripts");
const LEDGER = join(ROOT, "phase-b", "pdf-collection-ledger.json");
const BASE = "https://raw.githubusercontent.com/allenai/peerread/master/data/iclr_2017";
const MAX_ATTEMPTS = 4;

const frame = JSON.parse(await readFile(FRAME, "utf8"));
await mkdir(OUT_DIR, { recursive: true });

/** 断点续传：优先沿用旧台账里 status=ok 且文件仍在的记录 */
const previous = existsSync(LEDGER) ? JSON.parse(await readFile(LEDGER, "utf8")) : [];
const priorOk = new Map(previous.filter((l) => l.status === "ok" && existsSync(join(OUT_DIR, `fam-${l.candidateId}.pdf`))).map((l) => [l.candidateId, l]));

const ledger = [];
for (const candidate of frame.candidates) {
  const dest = join(OUT_DIR, `fam-${candidate.candidateId}.pdf`);
  const url = `${BASE}/${candidate.split}/pdfs/${candidate.paperId}.pdf`;
  if (priorOk.has(candidate.candidateId)) {
    ledger.push(priorOk.get(candidate.candidateId));
    console.log(JSON.stringify({ ...priorOk.get(candidate.candidateId), resumed: true }));
    continue;
  }
  const startedAt = Date.now();
  let bytes = 0;
  let sha256 = "";
  let status = "ok";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(120_000) });
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
      status = "ok";
      break;
    } catch (error) {
      status = `error: ${error.message}`;
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
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
await writeFile(LEDGER, JSON.stringify(ledger, null, 1), "utf8");
console.log(`done: ok=${ledger.filter((l) => l.status === "ok").length}/${ledger.length}`);
