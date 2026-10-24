/**
 * M15.4.1 CandidateProposer 合成契约测试（零模型；模型调用以 stub 注入）。
 *
 * 覆盖任务书 §6.1：契约/解析/alias/来源/数值不一致/重复候选/跨表竞争/错误证据同值/
 * 无凭据异常路径 + propose→resolve→verify→统计的真实通道。夹具全部自写合成 LaTeX，
 * 只证算法性质（修正 A 不假唯一 / 修正 B 先对应后比较），不代表真实论文检出率。
 */
import { describe, expect, it } from "vitest";

import {
  buildTableAllowlist, parseProposerResponse, resolveProposal, verifyProposal, runCandidateProposer,
  type ProposerClaimInput, type RawProposal, type TableAllowlist,
} from "../../src/review/candidateProposer.js";
import { buildCertificateDocument, type CertificateDocument } from "../../src/review/claimCertificate.js";
import { locateQuote } from "../../src/review/claimAuditText.js";

// ---- 夹具 ----

const DOC_HEAD = [
  "\\title{PatchMix Graph Learning}",
  "\\begin{table}[t]",
  "\\caption{Main results on the Bench-R benchmark.}\\label{tab:main}",
  "\\begin{tabular}{lcc}",
  "\\toprule",
  "Method & MaF1 & Acc \\\\",
  "\\midrule",
  "Proposed & 84.5 & 90.2 \\\\",
  "Baseline A & 82.1 & 88.9 \\\\",
  "Baseline B & 83.7 & 87.5 \\\\",
  "\\bottomrule",
  "\\end{tabular}",
  "\\end{table}",
  "\\begin{table}[t]",
  "\\caption{Reproduction of prior methods on Bench-W.}\\label{tab:repro}",
  "\\begin{tabular}{lcc}",
  "\\toprule",
  "Method & MaF1 & Acc \\\\",
  "\\midrule",
  "Proposed & 83.9 & 89.7 \\\\",
  "Baseline A & 82.1 & 88.9 \\\\",
  "\\bottomrule",
  "\\end{tabular}",
  "\\end{table}",
].join("\n");

/** materialized 口径：论断句原样写入文档（编辑值案例 = 换数字后的句子进文档，其余逐字节不变） */
function docWith(sentence: string): string {
  return `${DOC_HEAD}\n\\section{Results}\n${sentence}\n`;
}

const DOC_MAIN = docWith("Our method achieves 84.5\\% macro-F1 on Bench-R.");

function makeDoc(content: string): CertificateDocument {
  return buildCertificateDocument([{ file: "main.tex", content }]);
}

function claimAt(document: CertificateDocument, sentence: string, value: string): { file: string; start: number; end: number; value: string } {
  const content = document.files[0]!.content;
  const located = locateQuote(content, sentence);
  if (located === null) throw new Error(`fixture sentence not found: ${sentence}`);
  return { file: "main.tex", start: located.start, end: located.end, value };
}

function proposal(overrides: Partial<RawProposal> = {}): RawProposal {
  return {
    claimId: "C1",
    subject: "ours",
    metric: "macro-F1",
    dataset: "Bench-R",
    conditions: [],
    comparison: "CONSISTENT",
    candidates: [
      { tableAlias: "T1", rowAlias: "R2", colAlias: "C2", interpretation: "our method's macro-F1 on Bench-R (main table)", evidenceQuotes: ["MaF1", "Bench-R"] },
    ],
    ...overrides,
  };
}

function runVerify(document: CertificateDocument, sentence: string, value: string, raw: RawProposal): ReturnType<typeof verifyProposal> {
  const allowlist = buildTableAllowlist(document);
  const resolved = resolveProposal(document, raw, allowlist);
  return verifyProposal({ document, claim: claimAt(document, sentence, value), resolved });
}

/** vitest 断言不做类型收窄；集中在此处显式判别，测试体内直接取字段 */
function accepted(result: ReturnType<typeof verifyProposal>) {
  if (result.status !== "ACCEPTED") throw new Error(`expected ACCEPTED, got ${result.status}/${(result as { category?: string }).category}: ${result.reason}`);
  return result;
}

function abstained(result: ReturnType<typeof verifyProposal>) {
  if (result.status !== "ABSTAIN") throw new Error(`expected ABSTAIN, got ${result.status}`);
  return result;
}

function requireVerification(result: { verification: ReturnType<typeof verifyProposal> | null }): ReturnType<typeof verifyProposal> {
  if (result.verification === null) throw new Error("expected verification, got null");
  return result.verification;
}

// ---- 解析契约 ----

describe("M15.4.1 parseProposerResponse", () => {
  it("解析带 markdown 栅栏的合法 JSON", () => {
    const text = '```json\n{"claimId":"C1","subject":"ours","metric":"macro-F1","dataset":"","conditions":[],"comparison":"CONSISTENT","candidates":[{"tableAlias":"T1","rowAlias":"R2","colAlias":"C2","interpretation":"x","evidenceQuotes":["MaF1"]}],"confidence":0.8}\n```';
    const { proposal, error } = parseProposerResponse(text);
    expect(error).toBeNull();
    expect(proposal?.candidates).toHaveLength(1);
    expect(proposal?.metric).toBe("macro-F1");
  });
  it("JSON 前后有散文也能截取首个平衡对象", () => {
    const text = 'Here is my answer: {"claimId":"C1","subject":"ours","metric":"","dataset":"","conditions":[],"comparison":"","candidates":[],"abstain":{"reason":"not about a table"}} hope this helps';
    const { proposal, error } = parseProposerResponse(text);
    expect(error).toBeNull();
    expect(proposal?.abstain?.reason).toContain("not about a table");
  });
  it("无 JSON / 不平衡 / 无候选且无弃权 → fail-closed", () => {
    expect(parseProposerResponse("no json here").error).toBe("NO_JSON_OBJECT");
    expect(parseProposerResponse("{\"a\": {").error).toBe("UNBALANCED_JSON");
    expect(parseProposerResponse("{\"claimId\":\"C1\",\"candidates\":[]}").error).toBe("NO_CANDIDATES_NO_ABSTAIN");
  });
});

// ---- allowlist 确定性 ----

describe("M15.4.1 buildTableAllowlist", () => {
  it("同文档两次构建别名完全一致（内容寻址、确定性）", () => {
    const document = makeDoc(DOC_MAIN);
    const a = buildTableAllowlist(document);
    const b = buildTableAllowlist(document);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.tables).toHaveLength(2);
    expect(a.tables[0]!.alias).toBe("T1");
    expect(a.tables[0]!.columns[0]!.alias).toBe("C2"); // 数值列从 MaF1（col=1 → C2）开始
    expect(a.tables[0]!.rows[0]!.alias).toBe("R2");
  });
});

// ---- 核验通道（修正 A / 修正 B） ----

describe("M15.4.1 verifyProposal", () => {
  it("P1 正例：token+引文双通道 grounding → SUPPORTED（缩写桥 macro-F1 ↔ MaF1 由表头引文证明）", () => {
    const result = runVerify(makeDoc(DOC_MAIN), "Our method achieves 84.5\\% macro-F1 on Bench-R.", "84.5", proposal());
    expect(result.status).toBe("ACCEPTED");
    expect(accepted(result).outcome).toBe("SUPPORTED");
    if (result.status === "ACCEPTED") {
      expect(result.cell.tableId).toBe(buildTableAllowlist(makeDoc(DOC_MAIN)).tables[0]!.tableId);
      expect(accepted(result).grounding.valueCorroborated).toBe(false);
      expect(result.checks).toContain("METRIC_COLUMN_GROUNDED");
    }
  });

  it("P2 修正 B：正确对应 + 值不一致 + 模型 INCONSISTENT → CONTRADICTED（不得预先要求 OVERLAP）", () => {
    const raw = proposal({
      comparison: "INCONSISTENT",
      candidates: [{ tableAlias: "T1", rowAlias: "R2", colAlias: "C2", interpretation: "main table macro-F1", evidenceQuotes: ["MaF1", "Bench-R"] }],
    });
    const sentence = "Our method achieves 84.9\\% macro-F1 on Bench-R.";
    const result = runVerify(makeDoc(docWith(sentence)), sentence, "84.9", raw);
    accepted(result);
    expect(accepted(result).outcome).toBe("CONTRADICTED");
  });

  it("N1 错误证据同值：提案指向 Baseline 行（值碰巧相等）且 subject=ours → 绝不 SUPPORTED", () => {
    const raw = proposal({
      candidates: [{ tableAlias: "T1", rowAlias: "R3", colAlias: "C2", interpretation: "baseline row value coincides", evidenceQuotes: ["MaF1", "Bench-R"] }],
    });
    const sentence = "Our method achieves 82.1\\% macro-F1 on Bench-R.";
    const result = runVerify(makeDoc(docWith(sentence)), sentence, "82.1", raw);
    abstained(result);
    expect(abstained(result).category).toBe("GROUNDING_FAILED");
  });

  it("N2 修正 A 跨表竞争：两表同签名（同名行+同表头引文+同一数据集词）→ 不因模型指向 T2 而假唯一", () => {
    const doc = [
      "\\title{Dup}",
      "\\begin{table}[t]\\caption{Results on Bench-R.}\\label{t:a}\\begin{tabular}{lc}\\toprule Method & MaF1 \\\\ \\midrule Proposed & 84.5 \\\\ \\bottomrule \\end{tabular}\\end{table}",
      "\\begin{table}[t]\\caption{Results on Bench-R.}\\label{t:b}\\begin{tabular}{lc}\\toprule Method & MaF1 \\\\ \\midrule Proposed & 85.9 \\\\ \\bottomrule \\end{tabular}\\end{table}",
      "\\section{Results}",
      "Our method achieves 84.5\\% macro-F1 on Bench-R.",
      "",
    ].join("\n");
    const raw = proposal({
      candidates: [{ tableAlias: "T2", rowAlias: "R2", colAlias: "C2", interpretation: "second table", evidenceQuotes: ["MaF1", "Bench-R"] }],
    });
    const result = runVerify(makeDoc(doc), "Our method achieves 84.5\\% macro-F1 on Bench-R.", "84.5", raw);
    abstained(result);
    expect(abstained(result).category).toBe("PROPOSAL_NOT_UNIQUE");
    expect(abstained(result).competitorCount).toBe(2);
  });

  it("N3 引文伪造：evidenceQuote 不在论文原文逐字出现 → fail-closed", () => {
    const raw = proposal({
      candidates: [{ tableAlias: "T1", rowAlias: "R2", colAlias: "C2", interpretation: "x", evidenceQuotes: ["this quote exists nowhere 88123"] }],
    });
    const result = runVerify(makeDoc(DOC_MAIN), "Our method achieves 84.5\\% macro-F1 on Bench-R.", "84.5", raw);
    abstained(result);
    expect(abstained(result).category).toBe("PROPOSAL_QUOTE_NOT_FOUND");
  });

  it("N4 术语不在论断：subject 是论断里没有的名字 → PROPOSAL_TERM_NOT_IN_CLAIM", () => {
    const raw = proposal({ subject: "GhostNet" });
    const result = runVerify(makeDoc(DOC_MAIN), "Our method achieves 84.5\\% macro-F1 on Bench-R.", "84.5", raw);
    abstained(result);
    expect(abstained(result).category).toBe("PROPOSAL_TERM_NOT_IN_CLAIM");
  });

  it("N5 B2 跨表值守卫：值不一致且该值逐字出现在他表表格体 → 不得出矛盾证书", () => {
    const raw = proposal({
      dataset: "Bench-W",
      comparison: "INCONSISTENT",
      candidates: [{ tableAlias: "T2", rowAlias: "R2", colAlias: "C2", interpretation: "reproduction table macro-F1", evidenceQuotes: ["MaF1", "Bench-W"] }],
    });
    const sentence = "Our method achieves 83.7\\% macro-F1 on Bench-W.";
    const result = runVerify(makeDoc(docWith(sentence)), sentence, "83.7", raw);
    abstained(result);
    expect(abstained(result).category).toBe("VALUE_APPEARS_IN_OTHER_TABLE");
  });

  it("N6 B3 限定词：reproduced 未被表语境解释 → 弃判；被 Reproduction 题注解释 → 可出证", () => {
    const single = [
      "\\title{Solo}",
      "\\begin{table}[t]\\caption{Main results on Bench-R.}\\label{t:1}\\begin{tabular}{lc}\\toprule Method & MaF1 \\\\ \\midrule Proposed & 84.5 \\\\ \\bottomrule \\end{tabular}\\end{table}",
      "\\section{Results}",
      "Our reproduced method achieves 84.5\\% macro-F1.",
      "",
    ].join("\n");
    const noDataset = { dataset: "", candidates: [{ tableAlias: "T1", rowAlias: "R2", colAlias: "C2", interpretation: "macro-F1 of our method", evidenceQuotes: ["MaF1"] }] };
    const bad = runVerify(makeDoc(single), "Our reproduced method achieves 84.5\\% macro-F1.", "84.5", proposal(noDataset));
    abstained(bad);
    expect(abstained(bad).category).toBe("UNEXPLAINED_QUALIFIER");
    const repro = single.replace("Main results on Bench-R.", "Reproduction of prior methods.");
    const good = runVerify(makeDoc(repro), "Our reproduced method achieves 84.5\\% macro-F1.", "84.5", proposal(noDataset));
    accepted(good);
    expect(accepted(good).outcome).toBe("SUPPORTED");
  });

  it("V1 值佐证列选择：metric 未点名 + 行签名唯一 + 恰一值重叠格 → SUPPORTED(valueCorroborated)", () => {
    const raw = proposal({
      metric: "",
      candidates: [{ tableAlias: "T1", rowAlias: "R2", colAlias: "C2", interpretation: "only value matching in our row", evidenceQuotes: ["Bench-R"] }],
    });
    const sentence = "Our method reaches 84.5 on Bench-R.";
    const result = runVerify(makeDoc(docWith(sentence)), sentence, "84.5", raw);
    accepted(result);
    {
      expect(accepted(result).outcome).toBe("SUPPORTED");
      expect(accepted(result).grounding.valueCorroborated).toBe(true);
    }
  });

  it("V2 值佐证不唯一：同值两格 → 弃判（不得借值定列）", () => {
    const doc = [
      "\\title{Solo}",
      "\\begin{table}[t]\\caption{Main results on Bench-R.}\\label{t:1}\\begin{tabular}{lcc}\\toprule Method & MaF1 & Test-Acc \\\\ \\midrule Proposed & 84.5 & 84.5 \\\\ \\bottomrule \\end{tabular}\\end{table}",
      "\\section{Results}",
      "Our method reaches 84.5 on Bench-R.",
      "",
    ].join("\n");
    const raw = proposal({
      metric: "",
      candidates: [{ tableAlias: "T1", rowAlias: "R2", colAlias: "C2", interpretation: "either column", evidenceQuotes: ["Bench-R"] }],
    });
    const result = runVerify(makeDoc(doc), "Our method reaches 84.5 on Bench-R.", "84.5", raw);
    abstained(result);
    expect(abstained(result).category).toBe("PROPOSAL_NOT_UNIQUE");
  });

  it("D1 派生量：措辞派生 + 非派生列提案 → OUT_OF_SCOPE；论文派生列（Improv.）→ 原子路径出证", () => {
    const derivedSentence = "Our method improves the Macro-F1 score by 2.4 points on Bench-R.";
    const plain = runVerify(makeDoc(docWith(derivedSentence)), derivedSentence, "2.4", proposal({ metric: "Macro-F1" }));
    abstained(plain);
    expect(abstained(plain).category).toBe("DERIVED_RECOMPUTE_OUT_OF_SCOPE");
    const derived = [
      "\\title{Solo}",
      "\\begin{table}[t]\\caption{Improvements on Bench-R.}\\label{t:1}\\begin{tabular}{lcc}\\toprule Method & MaF1 & Improv. \\\\ \\midrule Proposed & 84.5 & 2.4 \\\\ \\bottomrule \\end{tabular}\\end{table}",
      "\\section{Results}",
      "Our method improves the Macro-F1 score by 2.4 points on Bench-R.",
      "",
    ].join("\n");
    const raw = proposal({
      metric: "",
      candidates: [{ tableAlias: "T1", rowAlias: "R2", colAlias: "C3", interpretation: "improvement column", evidenceQuotes: ["Bench-R"] }],
    });
    const result = runVerify(makeDoc(derived), derivedSentence, "2.4", raw);
    accepted(result);
    expect(accepted(result).outcome).toBe("SUPPORTED");
  });

  it("K1 双钥匙：comparison 缺失 → MODEL_CHECK_MISSING；与确定性比较相反 → MODEL_CHECK_DISAGREES", () => {
    const missing = runVerify(makeDoc(DOC_MAIN), "Our method achieves 84.5\\% macro-F1 on Bench-R.", "84.5", proposal({ comparison: "" }));
    abstained(missing);
    expect(abstained(missing).category).toBe("MODEL_CHECK_MISSING");
    const disagreeSentence = "Our method achieves 84.9\\% macro-F1 on Bench-R.";
    const disagree = runVerify(makeDoc(docWith(disagreeSentence)), disagreeSentence, "84.9", proposal({ comparison: "CONSISTENT" }));
    abstained(disagree);
    expect(abstained(disagree).category).toBe("MODEL_CHECK_DISAGREES");
  });

  it("A1 无效别名与不可定位原子 → fail-closed", () => {
    const document = makeDoc(DOC_MAIN);
    const allowlist: TableAllowlist = buildTableAllowlist(document);
    const bad = resolveProposal(document, proposal({ candidates: [{ tableAlias: "T9", rowAlias: "R2", colAlias: "C2", interpretation: "x", evidenceQuotes: [] }] }), allowlist);
    expect(bad.candidates[0]!.status).toBe("ALIAS_INVALID");
    const result = verifyProposal({ document, claim: claimAt(document, "Our method achieves 84.5\\% macro-F1 on Bench-R.", "99.9"), resolved: resolveProposal(document, proposal(), allowlist) });
    abstained(result);
    expect(abstained(result).category).toBe("CLAIM_ATOM_NOT_LOCATED");
  });
});

// ---- 端到端通道（stub 模型 + 结构化重试） ----

describe("M15.4.1 runCandidateProposer（propose→resolve→verify→重试）", () => {
  const document = makeDoc(DOC_MAIN);
  const content = document.files[0]!.content;
  const located = locateQuote(content, "Our method achieves 84.5\\% macro-F1 on Bench-R.");
  if (located === null) throw new Error("fixture sentence missing");
  const claim: ProposerClaimInput & { start: number; end: number } = {
    claimId: "C1", file: "main.tex",
    claimSentence: "Our method achieves 84.5\\% macro-F1 on Bench-R.",
    contextBefore: "", contextAfter: "", claimValue: "84.5",
    start: located.start, end: located.end,
  };
  const goodJson = JSON.stringify({
    claimId: "C1", subject: "ours", metric: "macro-F1", dataset: "Bench-R", conditions: [], comparison: "CONSISTENT",
    candidates: [{ tableAlias: "T1", rowAlias: "R2", colAlias: "C2", interpretation: "main table", evidenceQuotes: ["MaF1", "Bench-R"] }],
  });

  it("首次无效 JSON 只触发一次结构化重试，之后成功出证", async () => {
    const replies = ["I think the answer is T1 but I am not sure (no JSON)", goodJson];
    let calls = 0;
    const result = await runCandidateProposer(document, claim, async (prompt) => {
      calls += 1;
      expect(prompt).toContain("T1");
      expect(prompt).toContain("STRICT JSON");
      return { text: replies[calls - 1]!, model: "stub/test-1" };
    });
    expect(calls).toBe(2);
    expect(result.attempts).toBe(2);
    expect(result.verification?.status).toBe("ACCEPTED");
    expect(accepted(requireVerification(result)).outcome).toBe("SUPPORTED");
    expect(result.model).toBe("stub/test-1");
  });

  it("模型弃权 → PROPOSER_ABSTAIN；连续无效 JSON → parseError 记录且不出证", async () => {
    const abstain = await runCandidateProposer(document, claim, async () => ({
      text: JSON.stringify({ claimId: "C1", subject: "", metric: "", dataset: "", conditions: [], comparison: "", candidates: [], abstain: { reason: "not a table claim" } }),
      model: "stub/test-1",
    }));
    expect(abstained(requireVerification(abstain)).category).toBe("PROPOSER_ABSTAIN");
    const broken = await runCandidateProposer(document, claim, async () => ({ text: "still no json", model: "stub/test-1" }));
    expect(broken.raw).toBeNull();
    expect(broken.parseError).toBe("NO_JSON_OBJECT");
    expect(broken.verification).toBeNull();
  });
});
