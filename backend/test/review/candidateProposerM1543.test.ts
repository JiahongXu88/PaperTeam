/**
 * M15.4.3（P0-A）合成对抗测试：同一逻辑观察的确定性等价候选协议（logical-equivalence/v1）
 * + 指标数字标记冲突判别（mAP 50 ≠ mAP 50:95）。零模型（提案 stub 注入）。
 *
 * 必测负例（任务书 §四）：同值不同指标 / 值不同（指纹失配）/ 副本 provenance 不完整不归并；
 * 跨表同值 B2 不失效；列头无标记不触发冲突（只降不升的反方向不触发）。
 */
import { describe, expect, it } from "vitest";

import { buildTableAllowlist, resolveProposal, verifyProposal, type RawProposal } from "../../src/review/candidateProposer.js";
import { buildCertificateDocument, type CertificateDocument } from "../../src/review/claimCertificate.js";
import { locateQuote } from "../../src/review/claimAuditText.js";

function makeDoc(content: string): CertificateDocument {
  return buildCertificateDocument([{ file: "main.tex", content }]);
}

function claimAt(document: CertificateDocument, sentence: string, value: string): { file: string; start: number; end: number; value: string } {
  const content = document.files[0]!.content;
  const located = locateQuote(content, sentence);
  if (located === null) throw new Error(`fixture sentence not found: ${sentence}`);
  return { file: "main.tex", start: located.start, end: located.end, value };
}

function runVerify(document: CertificateDocument, sentence: string, value: string, raw: RawProposal): ReturnType<typeof verifyProposal> {
  const allowlist = buildTableAllowlist(document);
  const resolved = resolveProposal(document, raw, allowlist);
  return verifyProposal({ document, claim: claimAt(document, sentence, value), resolved });
}

function accepted(result: ReturnType<typeof verifyProposal>) {
  if (result.status !== "ACCEPTED") throw new Error(`expected ACCEPTED, got ${result.status}/${(result as { category?: string }).category}: ${(result as { reason?: string }).reason ?? ""} ${(result as { detail?: string }).detail ?? ""}`);
  return result;
}

function abstained(result: ReturnType<typeof verifyProposal>) {
  if (result.status !== "ABSTAIN") throw new Error(`expected ABSTAIN, got ${result.status}`);
  return result;
}

/** 主对比表 + 消融表 full-config 行重复报告同一观察（G1 形态的最小合成；lccc → C2=MaF1 C3=mAP50 C4=mAP50:95） */
const DUPE_DOC = [
  "\\title{DeepTrack UAV Detection}",
  "\\begin{table}[t]",
  "\\caption{Comparison with detectors on DroneSet.}\\label{tab:main}",
  "\\begin{tabular}{lccc}",
  "\\toprule",
  "Method & MaF1 & mAP 50 & mAP 50:95 \\\\",
  "\\midrule",
  "DeepTrack & 84.5 & 42.7 & 25.7 \\\\",
  "Baseline A & 82.1 & 39.9 & 22.1 \\\\",
  "\\bottomrule",
  "\\end{tabular}",
  "\\end{table}",
  "\\begin{table}[t]",
  "\\caption{Ablation of DeepTrack components on DroneSet.}\\label{tab:ablation}",
  "\\begin{tabular}{lccc}",
  "\\toprule",
  "Config & MaF1 & mAP 50 & mAP 50:95 \\\\",
  "\\midrule",
  "DeepTrack complete & 84.5 & 42.7 & 25.7 \\\\",
  "CompNet & 83.0 & 40.1 & 23.0 \\\\",
  "\\bottomrule",
  "\\end{tabular}",
  "\\end{table}",
  "\\section{Results}",
  "DeepTrack obtains 42.7\\% mAP 50 on DroneSet.",
  "",
].join("\n");

const MAIN_SENTENCE = "DeepTrack obtains 42.7\\% mAP 50 on DroneSet.";

const dupeProposal = (overrides: Partial<RawProposal> = {}): RawProposal => ({
  claimId: "P0A",
  subject: "DeepTrack",
  metric: "mAP 50",
  dataset: "DroneSet",
  conditions: [],
  comparison: "CONSISTENT",
  candidates: [{ tableAlias: "T1", rowAlias: "R2", colAlias: "C3", interpretation: "main table mAP 50", evidenceQuotes: ["mAP 50"] }],
  ...overrides,
});

describe("M15.4.3 P0-A logical equivalence + metric marker conflict", () => {
  it("A1-1 同一观察的物理副本归并：主表 own 行 + 消融表 full 行 → 单逻辑类 → ACCEPTED，见证保留全部成员与指纹", () => {
    const result = runVerify(makeDoc(DUPE_DOC), MAIN_SENTENCE, "42.7", dupeProposal());
    const ok = accepted(result);
    expect(ok.outcome).toBe("SUPPORTED");
    expect(ok.witness.uniqueness.physicalHitCount).toBe(2);
    expect(ok.witness.uniqueness.hitCount).toBe(1);
    expect(ok.witness.uniqueness.logicalEquivalence).toHaveLength(1);
    expect(ok.witness.uniqueness.logicalEquivalence[0]!.rule).toBe("logical-equivalence/v1");
    expect(ok.witness.uniqueness.logicalEquivalence[0]!.members).toHaveLength(2);
    expect(new Set(ok.witness.uniqueness.logicalEquivalence[0]!.members.map((m) => m.tableId)).size).toBe(2);
    expect(ok.witness.uniqueness.logicalEquivalence[0]!.pairs[0]!.sharedMetricColumns).toBeGreaterThanOrEqual(2);
    expect(ok.checks.some((c) => c.startsWith("SIGNATURE_UNIQUE_LOGICAL"))).toBe(true);
  });

  it("A1-2 负例：消融 full 行值不同（跨行指纹失配）→ 不归并 → 混合关系弃判", () => {
    const doc = DUPE_DOC.replace("DeepTrack complete & 84.5 & 42.7 & 25.7", "DeepTrack complete & 84.5 & 41.1 & 25.7");
    const result = runVerify(makeDoc(doc), MAIN_SENTENCE, "42.7", dupeProposal());
    expect(abstained(result).category).toBe("PROPOSAL_NOT_UNIQUE");
  });

  it("A1-3 负例：同值但不同指标列（headerPath 不同）→ 不归并（mAP 50:95 命中自成一类，与 mAP 50 命中无关）", () => {
    const doc = DUPE_DOC.replace("\\section{Results}\nDeepTrack obtains 42.7\\% mAP 50 on DroneSet.", "\\section{Results}\nDeepTrack reaches 25.7\\% mAP 50:95 on DroneSet.");
    const raw = dupeProposal({
      metric: "mAP 50:95",
      candidates: [{ tableAlias: "T1", rowAlias: "R2", colAlias: "C4", interpretation: "main table mAP 50:95", evidenceQuotes: ["mAP 50:95"] }],
    });
    const result = runVerify(makeDoc(doc), "DeepTrack reaches 25.7\\% mAP 50:95 on DroneSet.", "25.7", raw);
    const ok = accepted(result);
    expect(ok.witness.uniqueness.physicalHitCount).toBe(2);
    expect(ok.witness.uniqueness.logicalEquivalence).toHaveLength(1);
  });

  it("A1-4 负例：副本表带 parseIssues（provenance 不完整）→ 不归并（维持多逻辑类，见证无等价记录）", () => {
    // 消融表 w/o 行缺一格触发 RAGGED_ROWS（full 行与主表完全同值同指纹，但表解析不健康 → 不得归并）
    const doc = DUPE_DOC.replace("CompNet & 83.0 & 40.1 & 23.0 \\\\", "DeepTrack w/o X & 83.0 \\\\");
    const result = runVerify(makeDoc(doc), MAIN_SENTENCE, "42.7", dupeProposal());
    const ok = accepted(result);
    expect(ok.witness.uniqueness.logicalEquivalence).toHaveLength(0);
    expect(ok.witness.uniqueness.physicalHitCount).toBe(2);
    expect(ok.witness.uniqueness.multiBinding?.count).toBe(2);
  });

  it("A1-5 B2 不失效：归并类矛盾路径 + 值出现在第三表 → VALUE_APPEARS_IN_OTHER_TABLE", () => {
    const doc = [
      DUPE_DOC.replace("DeepTrack obtains 42.7", "DeepTrack obtains 44.9"),
      "\\begin{table}[t]",
      "\\caption{Reproduction on DroneSet subset.}\\label{tab:repro}",
      "\\begin{tabular}{lc}\\toprule Method & mAP 50 \\\\ \\midrule PriorNet & 44.9 \\\\ \\bottomrule \\end{tabular}",
      "\\end{table}",
    ].join("\n");
    const result = runVerify(makeDoc(doc), "DeepTrack obtains 44.9\\% mAP 50 on DroneSet.", "44.9", dupeProposal({ comparison: "INCONSISTENT" }));
    expect(abstained(result).category).toBe("VALUE_APPEARS_IN_OTHER_TABLE");
  });

  it("A2-1 指标标记冲突：metric mAP 50 不落位 mAP 50:95 列（单表双列；旧口径两列同落 → 假竞争弃判）", () => {
    const doc = [
      "\\title{DeepTrack UAV Detection}",
      "\\begin{table}[t]\\caption{Comparison on DroneSet.}\\label{tab:main}",
      "\\begin{tabular}{lcc}\\toprule Method & mAP 50 & mAP 50:95 \\\\ \\midrule DeepTrack & 42.7 & 25.7 \\\\ \\bottomrule \\end{tabular}\\end{table}",
      "\\section{Results}",
      "DeepTrack obtains 42.7\\% mAP 50 on DroneSet.",
      "",
    ].join("\n");
    const result = runVerify(makeDoc(doc), MAIN_SENTENCE, "42.7", dupeProposal({ candidates: [{ tableAlias: "T1", rowAlias: "R2", colAlias: "C2", interpretation: "mAP 50 column", evidenceQuotes: ["mAP 50"] }] }));
    expect(accepted(result).outcome).toBe("SUPPORTED");
  });

  it("A2-2 反向：论断 metric mAP 50:95 正常落位同名列（标记子集关系不冲突）", () => {
    const doc = [
      "\\title{DeepTrack UAV Detection}",
      "\\begin{table}[t]\\caption{Comparison on DroneSet.}\\label{tab:main}",
      "\\begin{tabular}{lcc}\\toprule Method & mAP 50 & mAP 50:95 \\\\ \\midrule DeepTrack & 42.7 & 25.7 \\\\ \\bottomrule \\end{tabular}\\end{table}",
      "\\section{Results}",
      "DeepTrack reaches 25.7\\% mAP 50:95 on DroneSet.",
      "",
    ].join("\n");
    const raw = dupeProposal({
      metric: "mAP 50:95",
      candidates: [{ tableAlias: "T1", rowAlias: "R2", colAlias: "C3", interpretation: "mAP 50:95 column", evidenceQuotes: ["mAP 50:95"] }],
    });
    const result = runVerify(makeDoc(doc), "DeepTrack reaches 25.7\\% mAP 50:95 on DroneSet.", "25.7", raw);
    expect(accepted(result).outcome).toBe("SUPPORTED");
  });

  it("A2-3 列头无标记不冲突：metric mAP 50 仍落位 mAP (\\%) 列（只降不升的反方向不触发）", () => {
    const doc = [
      "\\title{DeepTrack UAV Detection}",
      "\\begin{table}[t]\\caption{Comparison on DroneSet.}\\label{tab:main}",
      "\\begin{tabular}{lc}\\toprule Method & mAP (\\%) \\\\ \\midrule DeepTrack & 42.7 \\\\ \\bottomrule \\end{tabular}\\end{table}",
      "\\section{Results}",
      "DeepTrack obtains 42.7\\% mAP 50 on DroneSet.",
      "",
    ].join("\n");
    const result = runVerify(makeDoc(doc), MAIN_SENTENCE, "42.7", dupeProposal({ candidates: [{ tableAlias: "T1", rowAlias: "R2", colAlias: "C2", interpretation: "mAP column", evidenceQuotes: ["mAP"] }] }));
    expect(result.status).toBe("ACCEPTED");
  });
});
