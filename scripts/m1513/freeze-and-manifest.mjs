#!/usr/bin/env node
/**
 * M15.13 Phase B/C — 样本清单冻结 + 四臂预测 SHA 冻结。
 *
 * build-sample-manifest：对 PRIMARY 12 候选做离线 PDF 资格核验（pymupdf 文本
 * 抽取量/页数/正文可读），不合格按 RESERVE 顺序替补（规则前置冻结）；产出
 * phase-c/sample-manifest.json（familyId=fam-pr-XX、role=HELD-OUT、评审隔离路径
 * 与 SHA256）。
 * freeze-predictions：四臂输出逐文件 SHA256 冻结（missing 非空即退出码 2）。
 *
 * 用法：node scripts/m1513/freeze-and-manifest.mjs build-sample-manifest | freeze-predictions
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1513_ROOT ? resolve(process.env.M1513_ROOT) : resolve("D:\\PaperTeamData\\M15\\M15_13");
const mode = process.argv[2];

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** 离线 PDF 资格核验：pymupdf 抽取（只读，零模型调用） */
function probePdf(pdfPath) {
  return new Promise((resolveProbe) => {
    const script = [
      "import sys, json",
      "import pymupdf",
      `doc = pymupdf.open(r"${pdfPath.replaceAll("\\", "\\\\")}")`,
      "pages = len(doc)",
      "chars = 0",
      "for p in doc: chars += len(p.get_text())",
      "head = doc[0].get_text()[:400] if pages else ''",
      "print(json.dumps({'pages': pages, 'chars': chars, 'head': head}))",
    ].join("\n");
    execFileAsync("python", ["-c", script], { timeout: 60_000 })
      .then(({ stdout }) => {
        try {
          resolveProbe(JSON.parse(stdout.trim().split("\n").pop()));
        } catch {
          resolveProbe({ error: "parse" });
        }
      })
      .catch((error) => resolveProbe({ error: String(error.message).slice(0, 160) }));
  });
}

if (mode === "build-sample-manifest") {
  const frame = JSON.parse(await readFile(join(ROOT, "phase-b", "candidate-frame.json"), "utf8"));
  const byRole = {
    DEV: frame.candidates.filter((c) => c.role === "DEV"),
    PRIMARY: frame.candidates.filter((c) => c.role === "PRIMARY"),
    RESERVE: frame.candidates.filter((c) => c.role === "RESERVE"),
  };
  const families = [];
  const substitutions = [];
  const queue = [...byRole.PRIMARY];
  const reserves = [...byRole.RESERVE];
  while (families.length < 12 && (queue.length > 0 || reserves.length > 0)) {
    const candidate = queue.length > 0 ? queue.shift() : reserves.shift();
    const pdfPath = join(ROOT, "manuscripts", `fam-${candidate.candidateId}.pdf`);
    if (!existsSync(pdfPath)) {
      substitutions.push({ candidateId: candidate.candidateId, reason: "pdf-missing" });
      continue;
    }
    const probe = await probePdf(pdfPath);
    const ok = probe.pages >= 6 && probe.chars >= 15_000;
    if (!ok) {
      substitutions.push({ candidateId: candidate.candidateId, reason: `pdf-quality pages=${probe.pages} chars=${probe.chars ?? "?"} err=${probe.error ?? ""}` });
      continue;
    }
    // 版本对齐证据：页眉是否含 ICLR 2017 投稿标记（Under review / ICLR 2017）
    const headerEvidence = /under review as a conference paper at iclr 2017|iclr 2017 (conference )?submission|submitted to iclr 2017/i.test(probe.head ?? "");
    families.push({
      familyId: `fam-${candidate.candidateId}`,
      role: "HELD-OUT",
      candidateId: candidate.candidateId,
      paperId: candidate.paperId,
      split: candidate.split,
      title: candidate.title,
      pdfPath,
      manuscriptPdfSha256: await sha256(pdfPath),
      pdfPages: probe.pages,
      pdfChars: probe.chars,
      submissionHeaderEvidence: headerEvidence,
      sequesterReviewsPath: join(ROOT, "sequester", "peerread-iclr2017", "reviews_raw", `${candidate.split}-${candidate.paperId}.json`),
      substantiveReviewCount: candidate.substantiveReviews,
      versionAlignment: {
        source: "PeerRead iclr_2017 distributed PDF (rejected submission; no camera-ready revision)",
        submissionHeaderEvidence: headerEvidence,
        caveat: "cannot verify against OpenReview revision history (primary path blocked); disclosed in protocol §1",
      },
    });
    console.log(`qualified ${candidate.candidateId}: pages=${probe.pages} chars=${probe.chars} header=${headerEvidence}`);
  }
  const manifest = {
    generatedAt: new Date().toISOString(),
    selectionRule:
      "PeerRead iclr_2017 rejected frame; seed=1513 shuffle; metadata-only selection (phase-b/candidate-frame.json sha256=bd43f65a...); PDF qualification = pymupdf pages>=6 & chars>=15000; failures substituted by RESERVE in candidate order",
    dataRoot: ROOT,
    protocolFrozenSha256: (await readFile(join(ROOT, "phase-b", "PROTOCOL_FROZEN.sha256"), "utf8")).trim(),
    substitutions,
    families,
    dev: byRole.DEV.map((c) => ({ familyId: `fam-${c.candidateId}`, paperId: c.paperId, split: c.split, title: c.title, pdfPath: join(ROOT, "manuscripts", `${c.candidateId}.pdf`) })),
  };
  if (families.length < 12) throw new Error(`合格族不足 12：${families.length}（替补源耗尽）`);
  await mkdir(join(ROOT, "phase-c"), { recursive: true });
  const out = join(ROOT, "phase-c", "sample-manifest.json");
  await writeFile(out, JSON.stringify(manifest, null, 1), "utf8");
  console.log(`sample manifest: ${families.length} HELD-OUT -> ${out}`);
  process.exit(0);
}

if (mode === "freeze-predictions") {
  const manifest = JSON.parse(await readFile(join(ROOT, "phase-c", "sample-manifest.json"), "utf8"));
  const outDir = join(ROOT, "phase-d", "out");
  const families = [];
  const missing = [];
  for (const fam of manifest.families.filter((f) => f.role === "HELD-OUT")) {
    const entry = { familyId: fam.familyId };
    for (const arm of ["c0", "c0plus", "c1opt", "c2"]) {
      const p = join(outDir, fam.familyId, `${arm}.json`);
      if (!existsSync(p)) {
        missing.push(`${fam.familyId}/${arm}`);
      } else {
        entry[arm] = await sha256(p);
      }
    }
    families.push(entry);
  }
  const frozen = { frozenAt: new Date().toISOString(), families, missing };
  await mkdir(join(ROOT, "phase-e"), { recursive: true });
  await writeFile(join(ROOT, "phase-e", "predictions-frozen.json"), JSON.stringify(frozen, null, 1), "utf8");
  console.log(`frozen ${families.length} families; missing=${JSON.stringify(missing)}`);
  process.exit(missing.length > 0 ? 2 : 0);
}

throw new Error(`未知模式 ${mode}（build-sample-manifest | freeze-predictions）`);
