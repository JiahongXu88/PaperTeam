/**
 * M17.2.1 作者方法事实（method-facts/v1）确定性核查回归（零模型；全部为人工构造的 SYNTHETIC 夹具，与任何真实实验无关）。
 * 覆盖：参数标度 / 绑定 / 范围 / 科学计数法；新增无来源参数；组件状态（移除 / 启用 / 拟议 / 未知）的正反例；
 * 结构性数字不误判；事实表撤销 / 来源变化失效；修订补丁只拒绝新引入的问题。
 */

import { describe, expect, it } from "vitest";

import {
  auditMethodFacts,
  buildMethodFactSheet,
  classifyMention,
  evaluateMethodFactState,
  extractMethodFactCandidates,
  methodFactPatchViolations,
  numberMatchesFact,
  parseScientificNumber,
  validateMethodFactInputs,
  type MethodFactInput,
  type MethodFactState,
} from "../../src/experiments/methodFacts.js";

const IDEA = "SYNTHETIC：在冻结底座上加一个门控过滤模块，去掉邻域门控、λ=0.35、k=12 的规则（cfg-a），k=6 的消融（cfg-b）。";
const FACTS: MethodFactInput[] = [
  { factKind: "parameter", subject: "λ", aliases: ["\\lambda", "融合系数"], valueText: "0.35", scope: ["cfg-a", "cfg-b"], sourceLocator: "project.researchIdea" },
  { factKind: "parameter", subject: "k", valueText: "12", scope: ["cfg-a"], sourceLocator: "project.researchIdea" },
  { factKind: "parameter", subject: "k", valueText: "6", scope: ["cfg-b"], sourceLocator: "project.researchIdea" },
  { factKind: "parameter", subject: "γ", valueText: "0.9", sourceLocator: "author:form" },
  { factKind: "component", subject: "邻域门控", aliases: ["neighborhood gate"], status: "REMOVED", sourceLocator: "project.researchIdea" },
  { factKind: "component", subject: "缓存队列", status: "ACTIVE", sourceLocator: "author:form" },
  { factKind: "component", subject: "重排模块", status: "PROPOSED", sourceLocator: "author:form" },
  { factKind: "component", subject: "平滑器", status: "UNKNOWN", sourceLocator: "author:form" },
];

function validState(idea = IDEA): MethodFactState {
  const sheet = buildMethodFactSheet({ sheetId: "mfs-0001", version: 1, createdAt: "2026-01-01T00:00:00Z", facts: FACTS, researchIdea: idea });
  return evaluateMethodFactState({ sheet, pointerHash: sheet.contentHash, researchIdea: idea });
}

function audit(content: string, file = "sections/method.tex", state = validState()) {
  return auditMethodFacts([{ file, content }], state, { stage: "review", researchIdea: IDEA, metricKeys: ["HOTA", "IDF1"] });
}

const codes = (content: string, file?: string) => audit(content, file).findings.map((finding) => finding.code);

describe("M17.2.1 numeric normalization", () => {
  it("parses decimals, percents and scientific notation", () => {
    expect(parseScientificNumber("0.35")).toMatchObject({ value: 0.35, decimals: 2, percent: false });
    expect(parseScientificNumber("3.5e-1")).toMatchObject({ value: 0.35, decimals: 2 });
    expect(parseScientificNumber("3.5\\times 10^{-1}")).toMatchObject({ value: 0.35, decimals: 2 });
    expect(parseScientificNumber("35\\%")).toMatchObject({ value: 35, percent: true });
    expect(parseScientificNumber("−0.35")?.value).toBe(-0.35);
    expect(parseScientificNumber("abc")).toBeNull();
  });
  it("accepts equivalent forms but never a different scale", () => {
    const fact = { value: 0.35, unit: "dimensionless" };
    for (const raw of ["0.35", "0.350", "3.5e-1", "35%"]) expect(numberMatchesFact(parseScientificNumber(raw)!, fact)).toBe(true);
    for (const raw of ["35", "3.5", "-0.35", "0.45"]) expect(numberMatchesFact(parseScientificNumber(raw)!, fact)).toBe(false);
    // 显示精度：0.4 只有 1 位小数，区间 [0.35, 0.45] 覆盖 0.35（四舍五入容差）
    expect(numberMatchesFact(parseScientificNumber("0.4")!, fact)).toBe(true);
  });
});

describe("M17.2.1 method parameter facts", () => {
  it("rejects a confirmed parameter written at the wrong scale and passes the legal value (LaTeX and plain)", () => {
    const wrong = audit("配置 cfg-a 的取值对应 $\\lambda=35$ 与 $k=12$。");
    expect(wrong.findings.map((finding) => finding.code)).toEqual(["METHOD_PARAM_CONFLICT"]);
    expect(wrong.findings[0]!.detail).toContain("100 倍");
    expect(wrong.findings[0]!.severity).toBe("major");
    expect(codes("配置 cfg-a 的取值对应 $\\lambda{=}0.35$ 与 $k=12$。")).toEqual([]);
    expect(codes("融合系数 λ 设为 0.350，k 取 12（cfg-a）。")).toEqual([]);
    expect(codes("融合系数为 0.35。")).toEqual([]);
    expect(codes("融合系数为 35。")).toEqual(["METHOD_PARAM_CONFLICT"]);
  });
  it("binds by symbol, not by bare number: the same value on another parameter is a conflict", () => {
    expect(codes("本文取 $\\gamma=0.35$。")).toEqual(["METHOD_PARAM_CONFLICT"]);
    // 从未给过的符号：即使数值在别处出现过也不算来源
    expect(audit("本文取 $\\kappa=0.35$。").findings.map((finding) => [finding.code, finding.authorDecisionRequired])).toEqual([["METHOD_PARAM_UNSOURCED", true]]);
  });
  it("respects variant scope: cfg-b's k=6 is legal, k=6 attributed to cfg-a is not", () => {
    expect(codes("消融组 cfg-b 将 $k$ 缩短为 $k{=}6$，主设定 cfg-a 保持 $k=12$。")).toEqual([]);
    expect(codes("主设定 cfg-a 使用 $k=6$。")).toEqual(["METHOD_PARAM_CONFLICT"]);
  });
  it("does not treat structural numbers or metric levels as method parameters", () => {
    expect(audit("如表~\\ref{tab:x1} 与式~\\eqref{eq:3} 所示\\cite{ref2021}，第 3 节给出 $\\sum_{i=1}^{N} x_i$；HOTA 为 55.5，配置名 cfg-a。").checkedParameters).toBe(0);
    expect(audit("我们在 MOT17 与 DS-24 上评测，见 Table 2。").checkedParameters).toBe(0);
  });
  it("leaves 'respectively' enumerations unbound instead of guessing", () => {
    expect(audit("λ 与 k 分别为 0.35 与 12。").checkedParameters).toBe(0);
  });
  it("accepts author-stated (unconfirmed) values only with the same binding when no confirmed fact exists", () => {
    const none = evaluateMethodFactState({ sheet: null, researchIdea: IDEA });
    const stated = auditMethodFacts([{ file: "m.tex", content: "本文取 $k=12$。" }], none, { stage: "review", researchIdea: IDEA });
    expect(stated.evaluated).toBe(false);
    expect(stated.findings).toEqual([]);
    expect(stated.consistent[0]!.basis).toContain("author_stated_unconfirmed");
    const misbound = auditMethodFacts([{ file: "m.tex", content: "本文取 $k=35$。" }], none, { stage: "review", researchIdea: IDEA });
    expect(misbound.findings.map((finding) => finding.code)).toEqual(["METHOD_PARAM_UNSOURCED"]);
  });
});

describe("M17.2.1 method component status", () => {
  it("classifies mentions by negation, history, other work, proposal and uncertainty", () => {
    expect(classifyMention("本方法去掉了邻域门控", 6, 4, "m.tex")).toBe("negated");
    expect(classifyMention("邻域门控已移除", 0, 4, "m.tex")).toBe("negated");
    expect(classifyMention("超出邻域门控的目标不进入候选", 2, 4, "m.tex")).toBe("asserted_current");
  });
  it("REMOVED component written as current is a conflict; correct history / other work / removal statements pass", () => {
    expect(codes("规则由融合系数与邻域门控两部分组成，超出邻域门控的目标不进入候选。")).toEqual(["METHOD_COMPONENT_CONFLICT"]);
    expect(codes("本文方法（含融合系数 λ 与邻域门控）作用于底座轨迹。")).toEqual(["METHOD_COMPONENT_CONFLICT"]);
    expect(codes("旧版本采用过邻域门控，现已移除。")).toEqual([]);
    expect(codes("与本文不同，文献\\cite{other2020}中的跟踪器采用邻域门控过滤候选。")).toEqual([]);
    expect(codes("文献\\cite{other2020}中的跟踪器采用邻域门控过滤候选。")).toEqual([]);
    expect(codes("本方法不使用邻域门控。")).toEqual([]);
    expect(codes("The proposed layer works without the neighborhood gate.")).toEqual([]);
    expect(codes("未来工作可进一步考察邻域门控的作用。")).toEqual([]);
  });
  it("ambiguous related-work mentions require author decision instead of a silent pass", () => {
    const result = audit("一些跟踪器使用邻域门控。", "sections/related-work.tex");
    expect(result.findings.map((finding) => [finding.code, finding.authorDecisionRequired])).toEqual([["METHOD_COMPONENT_UNCERTAIN", true]]);
  });
  it("ACTIVE written as absent, PROPOSED written as implemented, UNKNOWN asserted", () => {
    expect(codes("本方法不含缓存队列。")).toEqual(["METHOD_COMPONENT_CONFLICT"]);
    expect(codes("本方法使用缓存队列保存历史。")).toEqual([]);
    expect(codes("本方法的重排模块对候选重新打分。")).toEqual(["METHOD_COMPONENT_CONFLICT"]);
    expect(codes("我们拟引入重排模块作为后续工作。")).toEqual([]);
    expect(audit("本方法使用平滑器。").findings.map((finding) => [finding.code, finding.severity])).toEqual([["METHOD_COMPONENT_UNCONFIRMED", "minor"]]);
  });
});

describe("M17.2.1 fact sheet lifecycle", () => {
  it("extracts candidates from the research idea but never as confirmed facts", () => {
    const candidates = extractMethodFactCandidates(IDEA);
    expect(candidates.map((candidate) => [candidate.factKind, candidate.subject, candidate.value ?? candidate.status])).toEqual([
      ["parameter", "λ", 0.35], ["parameter", "k", 12], ["parameter", "k", 6], ["component", "邻域门控", "REMOVED"],
    ]);
    expect(candidates.every((candidate) => candidate.confirmationStatus === "candidate")).toBe(true);
    const none = evaluateMethodFactState({ sheet: null, researchIdea: IDEA });
    // 候选不约束：组件提及不会因候选被判冲突
    expect(auditMethodFacts([{ file: "m.tex", content: "超出邻域门控的目标不进入候选。" }], none, { stage: "review" }).findings).toEqual([]);
  });
  it("revocation and source changes invalidate the sheet; stale facts no longer support claims", () => {
    const sheet = buildMethodFactSheet({ sheetId: "mfs-0001", version: 1, createdAt: "2026-01-01T00:00:00Z", facts: FACTS, researchIdea: IDEA });
    const revoked = evaluateMethodFactState({ sheet, pointerHash: sheet.contentHash, revoked: { at: "2026-01-02", reason: "方法改版" }, researchIdea: IDEA });
    expect(revoked.status).toBe("revoked");
    const changed = evaluateMethodFactState({ sheet, pointerHash: sheet.contentHash, researchIdea: `${IDEA}（改）` });
    expect(changed.status).toBe("stale");
    const tampered = evaluateMethodFactState({ sheet: { ...sheet, facts: sheet.facts.slice(1) }, pointerHash: sheet.contentHash, researchIdea: IDEA });
    expect(tampered.status).toBe("stale");
    const result = auditMethodFacts([{ file: "m.tex", content: "本文取 $\\gamma=0.9$，超出邻域门控的目标不进入候选。" }], revoked, { stage: "review" });
    expect(result.evaluated).toBe(false);
    expect(result.consistent).toEqual([]);
    expect(result.findings.map((finding) => finding.code).sort()).toEqual(["METHOD_FACTS_STALE", "METHOD_PARAM_UNSOURCED"]);
  });
  it("validates author input strictly", () => {
    expect(validateMethodFactInputs([{ factKind: "parameter", subject: "λ", valueText: "abc" }]).problems).toHaveLength(1);
    expect(validateMethodFactInputs([{ factKind: "component", subject: "x", status: "ON" }]).problems).toHaveLength(1);
    expect(validateMethodFactInputs([]).problems).toHaveLength(1);
    expect(validateMethodFactInputs(FACTS).problems).toEqual([]);
  });
  it("sheet hash is deterministic", () => {
    const a = buildMethodFactSheet({ sheetId: "mfs-0001", version: 1, createdAt: "t1", facts: FACTS, researchIdea: IDEA });
    const b = buildMethodFactSheet({ sheetId: "mfs-0001", version: 1, createdAt: "t1", facts: FACTS, researchIdea: IDEA });
    expect(a.contentHash).toBe(b.contentHash);
  });
});

describe("M17.2.1 revision patch guard", () => {
  const state = validState();
  const guard = (before: string, after: string) => methodFactPatchViolations({ file: "sections/method.tex", before, after, state, researchIdea: IDEA }).map((violation) => violation.code);
  it("rejects a newly introduced wrong parameter even when the old text had no number for it", () => {
    expect(guard("主设定为 cfg-a。", "主设定为 cfg-a，其中配置名中的数值对应 $k=12$ 与 $\\lambda=35$。")).toEqual(["METHOD_FACT_CONFLICT"]);
    expect(guard("主设定为 cfg-a。", "主设定为 cfg-a，其中 $k=12$、$\\lambda=0.35$。")).toEqual([]);
  });
  it("rejects new unsourced parameters and re-introduced removed components", () => {
    expect(guard("主设定为 cfg-a。", "主设定为 cfg-a，阈值 $\\tau=0.8$。")).toEqual(["UNSOURCED_SCIENTIFIC_NUMBER"]);
    expect(guard("本方法去掉了邻域门控。", "本方法依赖邻域门控筛选候选。")).toEqual(["METHOD_FACT_CONFLICT"]);
  });
  it("does not blame a patch for a pre-existing problem it did not worsen", () => {
    const old = "本方法依赖邻域门控筛选候选。";
    expect(guard(old, `${old}此外语言更流畅。`)).toEqual([]);
  });
});
