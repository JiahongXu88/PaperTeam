#!/usr/bin/env node
/**
 * M15.4.2 C2 语料构建（零模型）：3 个新独立家族（G1/G2/G3，均与 M15.4.1 F1-F7 不同子领域/第一作者）。
 * 机械校验：CONSIST 须值与金格逐字一致；CONTRADICT 须编辑值逐字注入且≠金格且跨表检查如实记录；
 * 每案例独立 materialized 视图。产物 D:\PaperTeamData\M15\M15_4_2\corpus\。
 */
import { readFile, readdir, writeFile, mkdir, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const ROOT = "D:\\PaperTeamData\\M15\\M15_4_2";
const REPO = "D:\\Projects\\PaperTeam";
const dist = (...p) => "file://D:/Projects/PaperTeam/backend/dist/" + p.join("/");
const { parseLatexTables, plainLatexText } = await import(dist("review", "latexTable.js"));
const { locateQuote } = await import(dist("review", "claimAuditText.js"));
const { buildCertificateDocument, locateAtom } = await import(dist("review", "claimCertificate.js"));

const FAMILIES = {
  "G1-hdmamba": { arxiv: "2609.23061", title: "HDMamba-YOLO: UAV small object detection", license: "arXiv default (non-exclusive)", file: "chapter4_with_fig5_fig10.tex" },
  "G2-brainiac": { arxiv: "2609.23026", title: "BrainIAC: interactive brain lesion segmentation", license: "arXiv default (non-exclusive)", file: "paper.tex" },
  "G3-sparkdiff": { arxiv: "2609.23153", title: "SparkDiffusion: sparse video diffusion acceleration", license: "arXiv default (non-exclusive)", file: "main.tex" },
};

const CASES = {
  "G1-hdmamba": [
    {
      caseId: "G1-C01", kind: "ATOMIC-CONSIST", difficulty: "NAMED-MULTI-METRIC",
      claimQuote: "HDMamba-YOLO-B reaches 42.737\\% mAP$_{50}$ and 25.713\\% mAP$_{50:95}$ with 10.042M parameters and 29.879 corrected GFLOPs.",
      targetValue: "42.737", editValue: null,
      goldCells: [{ file: "chapter4_with_fig5_fig10.tex", tableId: "6bc12e9c07b9", row: 17, col: 4 }],
      observationIdentity: { subject: "HDMamba-YOLO-B", metric: "mAP50", dataset: "VisDrone2019 val", conditions: [], variant: null, comparisonTarget: null },
      expectedRelation: "SUPPORTED", expectedCertifiable: true,
      oracleBasis: "tab:visdrone comparison HDMamba-YOLO-B (Ours) 行 mAP50 列 42.737；mAP50:95 列 25.713 同行",
    },
    {
      caseId: "G1-C02", kind: "ATOMIC-CONSIST", difficulty: "MULTI-LEVEL-MEDIUM-OBJECT-METRIC",
      claimQuote: "For very tiny objects, HDMamba-YOLO-B obtains 6.333\\% AP$_{vt}$ and 12.213\\% AR$_{vt}$, which are lower than the corresponding YOLO11s values of 9.030\\% and 13.340\\%.",
      targetValue: "6.333", editValue: null,
      goldCells: [{ file: "chapter4_with_fig5_fig10.tex", tableId: "e84d6f5cf9c2", row: 8, col: 6 }],
      observationIdentity: { subject: "HDMamba-YOLO-B", metric: "AP_vt (very tiny)", dataset: "AI-TOD val", conditions: [], variant: null, comparisonTarget: "YOLO11s" },
      expectedRelation: "SUPPORTED", expectedCertifiable: true,
      oracleBasis: "tab:ai-tod HDMamba-YOLO-B 行 AP_vt 列 6.333（AR_vt 列 12.213 同句）",
    },
    {
      caseId: "G1-C03", kind: "ATOMIC-CONTRADICT", difficulty: "EDITED-VALUE-B2-CLEAN",
      claimQuote: "HDMamba-YOLO-B reaches 42.737\\% mAP$_{50}$ and 25.713\\% mAP$_{50:95}$ with 10.042M parameters and 29.879 corrected GFLOPs.",
      targetValue: "42.737", editValue: "43.512", originalValue: "42.737",
      goldCells: [{ file: "chapter4_with_fig5_fig10.tex", tableId: "6bc12e9c07b9", row: 17, col: 4 }],
      observationIdentity: { subject: "HDMamba-YOLO-B", metric: "mAP50", dataset: "VisDrone2019 val", conditions: [], variant: null, comparisonTarget: null },
      expectedRelation: "CONTRADICTED", expectedCertifiable: true,
      oracleBasis: "编辑值 43.512 全文档缺失（机械校验）→ 唯一绑定格 42.737 DISJOINT → 可证矛盾",
    },
    {
      caseId: "G1-C04", kind: "DERIVED-NEG", difficulty: "IMPROVES-BY-POINTS",
      claimQuote: "Relative to YOLO11s, which has a similar parameter scale, the proposed model improves AP, AP$_{50}$, and AP$_{75}$ by 1.371, 1.011, and 1.326 percentage points, respectively.",
      targetValue: "1.371", editValue: null,
      goldCells: [],
      observationIdentity: { subject: "HDMamba-YOLO-B (proposed)", metric: "AP improvement (pp)", dataset: "AI-TOD", conditions: [], variant: null, comparisonTarget: "YOLO11s" },
      expectedRelation: "ABSTAIN_ONLY", expectedCertifiable: false,
      oracleBasis: "派生措辞（improves … by X percentage points）→ derivedFormula 域，本轮协议只证原子",
    },
    {
      caseId: "G1-C05", kind: "NO-TABLE", difficulty: "DATASET-STATISTIC",
      claimQuote: "Thus, 60.49\\% of the training instances have an equivalent side length below 32 pixels, providing a suitable setting for evaluating the proposed small-object-oriented design.",
      targetValue: "60.49", editValue: null,
      goldCells: [],
      observationIdentity: { subject: "training instances", metric: "fraction below 32px", dataset: "VisDrone2019 train", conditions: [], variant: null, comparisonTarget: null },
      expectedRelation: "ABSTAIN_ONLY", expectedCertifiable: false,
      oracleBasis: "数据集统计量，非任何实验表格观察",
    },
  ],
  "G2-brainiac": [
    {
      caseId: "G2-C01", kind: "ATOMIC-CONSIST", difficulty: "ROW-GROUP-CLICK-STRATEGY",
      claimQuote: "This lesion-type-specific clicking strategy improves the detection rate of SWI lesion components compared with our standard click strategy: BBox + 6 largest error clicks for the agnostic channel with SWI (49.8\\%) and ours without SWI (38.6\\%) and is more representative of how a clinician would use this tool in practice.",
      targetValue: "49.8", editValue: null,
      goldCells: [{ file: "paper.tex", tableId: "ddc3e7fa0843", row: 4, col: 4 }],
      observationIdentity: { subject: "BrainIAC + agnostic channel (online)", metric: "detected SWI components %", dataset: "TBI", conditions: ["BBox+6"], variant: "Agn.", comparisonTarget: "ours without SWI" },
      expectedRelation: "SUPPORTED", expectedCertifiable: true,
      oracleBasis: "SWI 检测率表 r4（+Agn. 行）BBox+6 列 49.8；r2（ours 无 SWI）38.6 同句",
    },
    {
      caseId: "G2-C02", kind: "ATOMIC-CONSIST", difficulty: "ANAPHORIC-OUR-SETUP",
      claimQuote: "This resulted in a much higher percentage of SWI connect components being detected when using the agnostic channel (68.9\\%) compared to our original set up with no place to process SWI (53.1\\%), however, we still click where the largest undetected SWI lesions would be using our SWI ground truth.",
      targetValue: "68.9", editValue: null,
      goldCells: [{ file: "paper.tex", tableId: "ddc3e7fa0843", row: 8, col: 5 }],
      observationIdentity: { subject: "BrainIAC + agnostic (alternate clicks)", metric: "detected SWI components %", dataset: "TBI", conditions: ["BBox+12"], variant: "Agn.", comparisonTarget: "original setup (53.1)" },
      expectedRelation: "SUPPORTED", expectedCertifiable: true,
      oracleBasis: "SWI 检测率表 r8（+Agn. 行）BBox+12 列 68.9；53.1 未见于表（正文参照值）",
    },
    {
      caseId: "G2-C03", kind: "ATOMIC-CONTRADICT", difficulty: "EDITED-VALUE-SAME-TABLE-COLLISION",
      claimQuote: "This lesion-type-specific clicking strategy improves the detection rate of SWI lesion components compared with our standard click strategy: BBox + 6 largest error clicks for the agnostic channel with SWI (49.8\\%) and ours without SWI (38.6\\%) and is more representative of how a clinician would use this tool in practice.",
      targetValue: "49.8", editValue: "47.6", originalValue: "49.8",
      goldCells: [{ file: "paper.tex", tableId: "ddc3e7fa0843", row: 4, col: 4 }],
      observationIdentity: { subject: "BrainIAC + agnostic channel (online)", metric: "detected SWI components %", dataset: "TBI", conditions: ["BBox+6"], variant: "Agn.", comparisonTarget: null },
      expectedRelation: "CONTRADICTED", expectedCertifiable: true,
      oracleBasis: "编辑值 47.6 出现于同表 r6（BBox+1 列）——同表不触发 B2；若 47.6 亦现于他表则按机械校验改判 ABSTAIN_ONLY",
    },
    {
      caseId: "G2-C04", kind: "ATOMIC-CONSIST", difficulty: "FROM-ENDPOINT-UNION",
      claimQuote: "In particular, UNION degrades monotonically: its BBox+6 Dice decreases from 54.8 using FLAIR alone to 46.8 when all channels are combined.",
      targetValue: "54.8", editValue: null,
      goldCells: [{ file: "paper.tex", tableId: "67f92baf1d82", row: 10, col: 5 }],
      observationIdentity: { subject: "nnInter. (UNION)", metric: "Dice (BBox+6)", dataset: "TBI unseen-modalities", conditions: ["FLAIR"], variant: "UNION", comparisonTarget: "all channels 46.8" },
      expectedRelation: "SUPPORTED", expectedCertifiable: true,
      oracleBasis: "unseen-modalities 表 r10 UNION/FLAIR BBox+6=54.8（from 端点）；46.8=r13 全通道；54.8 同值亦在 r14 LOGITS（subject 判别）",
    },
  ],
  "G3-sparkdiff": [
    {
      caseId: "G3-C01", kind: "ATOMIC-CONSIST", difficulty: "FROM-ENDPOINT-LATENCY",
      claimQuote: "This reduction translates directly into end-to-end latency gains: on Wan2.1-T2V-14B-720P with 3-step inference, the $90\\%\\!\\to\\!97\\%$ stretch alone reduces latency from $10.5$\\,s to $8.0$\\,s on H100 and from $23.7$\\,s to $18.0$\\,s on RTX~5090 (Fig.~\\ref{fig:sparkdiffusion_latency_speedup_h100_rtx5090})---an additional $1.31$--$1.32\\times$ speedup that is available only if quality survives extreme sparsity.",
      targetValue: "10.5", editValue: null,
      goldCells: [{ file: "main.tex", tableId: "1f61eea45eb7", row: 9, col: 11 }],
      observationIdentity: { subject: "SparkDiffusion (Ours) 90% sparsity", metric: "latency (s) on H100", dataset: "Wan2.1-T2V-14B-720P", conditions: ["3-step"], variant: "90% sparsity", comparisonTarget: "97% (8.0s)" },
      expectedRelation: "SUPPORTED", expectedCertifiable: true,
      oracleBasis: "主对比表 r9（SparkDiffusion 90%）H100 列 10.5（from 端点）；r10（97%）8.0 同句",
    },
    {
      caseId: "G3-C02", kind: "ATOMIC-CONSIST", difficulty: "MACRO-SUBJECT-LOWEST-LATENCY",
      claimQuote: "short-sequence Wan2.1-T2V-1.3B-480P, \\method at the same $90\\%$ sparsity improves generation quality and inference speed simultaneously over both baselines: it attains the best VBench-2.0 at the lowest latency ($1.3$\\,s on RTX~5090 and $0.6$\\,s on H100, $1.5$--$2.2\\times$ faster than the baselines).",
      targetValue: "1.3", editValue: null,
      goldCells: [{ file: "main.tex", tableId: "1f61eea45eb7", row: 5, col: 10 }],
      observationIdentity: { subject: "SparkDiffusion (Ours) on Wan2.1-T2V-1.3B", metric: "latency (s) on RTX 5090", dataset: "Wan2.1-T2V-1.3B-480P", conditions: ["90% sparsity"], variant: null, comparisonTarget: "baselines" },
      expectedRelation: "SUPPORTED", expectedCertifiable: true,
      oracleBasis: "主对比表 r5（1.3B 块 SparkDiffusion 90%）5090 列 1.3；\\method 宏经 plainLatexText 消隐 → 真实接口难度",
    },
    {
      caseId: "G3-C03", kind: "ATOMIC-CONTRADICT", difficulty: "EDITED-VALUE-B2-CLEAN",
      claimQuote: "This reduction translates directly into end-to-end latency gains: on Wan2.1-T2V-14B-720P with 3-step inference, the $90\\%\\!\\to\\!97\\%$ stretch alone reduces latency from $10.5$\\,s to $8.0$\\,s on H100 and from $23.7$\\,s to $18.0$\\,s on RTX~5090 (Fig.~\\ref{fig:sparkdiffusion_latency_speedup_h100_rtx5090})---an additional $1.31$--$1.32\\times$ speedup that is available only if quality survives extreme sparsity.",
      targetValue: "10.5", editValue: "10.9", originalValue: "10.5",
      goldCells: [{ file: "main.tex", tableId: "1f61eea45eb7", row: 9, col: 11 }],
      observationIdentity: { subject: "SparkDiffusion (Ours) 90% sparsity", metric: "latency (s) on H100", dataset: "Wan2.1-T2V-14B-720P", conditions: ["3-step"], variant: "90% sparsity", comparisonTarget: null },
      expectedRelation: "CONTRADICTED", expectedCertifiable: true,
      oracleBasis: "编辑值 10.9 全文档缺失（机械校验）→ DISJOINT 可证",
    },
    {
      caseId: "G3-C04", kind: "APPROX-NEG", difficulty: "WITHIN-DELTA",
      claimQuote: "All \\method quality numbers reported in this paper (Tables~\\ref{tab:main_vbench} and~\\ref{tab:diversity}) are measured on the deployed model with FP8 quantization and fused kernels enabled; the BF16-to-FP8 quality delta is ablated in Appendix~\\ref{app:fp8_ablation} and stays within $0.1$ VBench points.",
      targetValue: "0.1", editValue: null,
      goldCells: [],
      observationIdentity: { subject: "FP8 quantization delta", metric: "VBench points delta", dataset: "deployed models", conditions: ["FP8"], variant: null, comparisonTarget: "BF16" },
      expectedRelation: "ABSTAIN_ONLY", expectedCertifiable: false,
      oracleBasis: "差值上限措辞（stays within）= 不可证的近似/不等式语义",
    },
  ],
};

async function familyFiles(familyKey) {
  const dir = join(ROOT, "candidates", FAMILIES[familyKey].arxiv);
  const files = [];
  const walk = async (d) => {
    for (const n of await readdir(d, { withFileTypes: true })) {
      if (n.isDirectory()) await walk(join(d, n.name));
      else if (n.name.endsWith(".tex")) files.push({ abs: join(d, n.name), rel: join(d, n.name).slice(dir.length + 1).replaceAll("\\", "/") });
    }
  };
  await walk(dir);
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  return Promise.all(files.map(async (f) => ({ path: f.rel, content: await readFile(f.abs, "utf8") })));
}

const sha256 = (t) => createHash("sha256").update(t, "utf8").digest("hex");

await mkdir(join(ROOT, "corpus"), { recursive: true });
await mkdir(join(ROOT, "materialized"), { recursive: true });
const problems = [];
for (const familyKey of Object.keys(FAMILIES)) {
  const files = await familyFiles(familyKey);
  const caseDir = join(ROOT, "materialized", familyKey);
  await mkdir(caseDir, { recursive: true });
  for (const kase of CASES[familyKey]) {
    // 1) claimQuote 可定位（原文或编辑后）
    kase.file = kase.file ?? kase.goldCells[0]?.file ?? FAMILIES[familyKey].file;
    const original = files.find((f) => f.path === kase.file).content;
    const effectiveQuote = kase.editValue === null || kase.editValue === undefined ? kase.claimQuote : kase.claimQuote.replace(kase.originalValue, kase.editValue);
    const content = kase.editValue === null || kase.editValue === undefined ? original : original.replace(kase.claimQuote, effectiveQuote);
    const span = locateQuote(content, effectiveQuote);
    if (span === null || span.occurrences > 1) { problems.push(`${kase.caseId}: quote ${span === null ? "NOT FOUND" : `AMBIGUOUS x${span.occurrences}`}`); continue; }
    // 2) 金格机械校验
    const document = buildCertificateDocument(files.map((f) => ({ file: f.path, content: f.content })));
    for (const gold of kase.goldCells) {
      const table = document.files.find((f) => f.file === gold.file)?.tables.find((t) => t.tableId.startsWith(gold.tableId));
      if (table === undefined) { problems.push(`${kase.caseId}: gold table ${gold.tableId} NOT FOUND`); continue; }
      const cell = table.cells.find((c) => c.row === gold.row && c.col === gold.col && c.value !== null && !c.isHeader);
      if (cell === undefined) { problems.push(`${kase.caseId}: gold cell r${gold.row}c${gold.col} NOT NUMERIC`); continue; }
      if (kase.expectedRelation === "SUPPORTED" && cell.value.raw !== kase.targetValue) {
        problems.push(`${kase.caseId}: gold value ${cell.value.raw} != target ${kase.targetValue}`);
      }
      if (kase.expectedRelation === "CONTRADICTED" && cell.value.raw === kase.editValue) {
        problems.push(`${kase.caseId}: edit value equals gold`);
      }
      gold.tableId = table.tableId;
    }
    // 3) CONTRADICT 编辑值跨表检查（如实决定 expected）
    if (kase.kind === "ATOMIC-CONTRADICT") {
      const gold = kase.goldCells[0];
      const table = document.files.find((f) => f.file === gold.file)?.tables.find((t) => t.tableId === gold.tableId);
      const needle = kase.editValue;
      const pattern = new RegExp(`(?<![\\d.])${needle.replace(/\./g, "\\.")}(?![\\d.])`, "g");
      const otherTables = new Set();
      for (const f of document.files) {
        for (const m of f.content.matchAll(pattern)) {
          for (const t of f.tables) {
            if (t.tableId !== table?.tableId && m.index >= t.start && m.index < t.end) otherTables.add(t.tableId);
          }
        }
      }
      if (otherTables.size > 0 && kase.expectedCertifiable) {
        kase.expectedRelation = "ABSTAIN_ONLY";
        kase.expectedCertifiable = false;
        kase.oracleBasis += `；【机械校验改判】编辑值出现于他表 ${[...otherTables].join(",")} → B2 跨表不可证 → ABSTAIN_ONLY`;
      }
    }
    // 4) materialized 编辑案例
    if (kase.editValue !== null && kase.editValue !== undefined) {
      const target = join(caseDir, kase.caseId);
      await mkdir(target, { recursive: true });
      for (const f of files) {
        const out = f.path === kase.file ? f.content.replace(kase.claimQuote, effectiveQuote) : f.content;
        const sub = join(target, f.path);
        await mkdir(join(sub, ".."), { recursive: true });
        await writeFile(sub, out, "utf8");
      }
    }
  }
  // provenance
  const prov = {
    familyKey, arxiv: FAMILIES[familyKey].arxiv, split: "C2_INDEPENDENT", license: FAMILIES[familyKey].license,
    files: await Promise.all(files.map(async (f) => ({ path: f.path, sha256: sha256(f.content), bytes: Buffer.byteLength(f.content) }))),
    caseCount: CASES[familyKey].length,
    kinds: CASES[familyKey].reduce((acc, c) => { acc[c.kind] = (acc[c.kind] ?? 0) + 1; return acc; }, {}),
    editedCases: CASES[familyKey].filter((c) => c.editValue !== null && c.editValue !== undefined).map((c) => c.caseId),
    validatedAt: new Date().toISOString(),
    problems: [],
  };
  await writeFile(join(ROOT, "corpus", `${familyKey}-cases.json`), JSON.stringify({ family: familyKey, arxiv: FAMILIES[familyKey].arxiv, license: FAMILIES[familyKey].license, title: FAMILIES[familyKey].title, cases: CASES[familyKey] }, null, 2), "utf8");
  await writeFile(join(ROOT, "corpus", `${familyKey}-provenance.json`), JSON.stringify(prov, null, 2), "utf8");
  console.log(`${familyKey}: ${CASES[familyKey].length} cases validated`);
}
if (problems.length > 0) {
  console.log("\nPROBLEMS:");
  for (const p of problems) console.log(" -", p);
  process.exit(1);
}
console.log("\nALL MECHANICAL CHECKS PASS");
