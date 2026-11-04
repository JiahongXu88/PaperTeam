/**
 * M17.1.1 拼接检查与通顺度否决的定向回归。
 *
 * 句子全部为人工构造（与 B2 真实样本无关的话题，避免为某几句硬编码）。每类检查都配一条应放行的合法修改，
 * 确认新检查不会误伤正常的去防御修订。
 */

import { describe, expect, it } from "vitest";

import { checkStyleSplice, diffRuns, locateStyleQuote, type StyleFinding } from "../../src/review/academicStyleAudit.js";
import { finalizeStyleRevisions, prepareStyleRevisions, styleRewriteCheckItems } from "../../src/review/academicStyleRevision.js";

const at = (content: string, quote: string) => {
  const loc = locateStyleQuote(content, quote);
  return { start: loc.start, end: loc.end };
};
const rules = (violations: Array<{ rule: string }>) => violations.map((v) => v.rule);

describe("标点衔接（确定性）", () => {
  const content = "该模型在三个城市的数据上完成验证（降雨场景未覆盖），这正是我们关注的重点。\n\n第二段讨论部署。";

  it("删除以句号结尾的分句后句子停在逗号上 → dangling_punctuation", () => {
    const { start, end } = at(content, "这正是我们关注的重点。");
    expect(rules(checkStyleSplice({ content, start, end, rewrite: "" }))).toContain("dangling_punctuation");
  });

  it("删除完整的一句（前文以句号结束）→ 放行", () => {
    const text = "该模型在三个城市的数据上完成验证。这正是我们关注的重点。第二句继续。";
    const { start, end } = at(text, "这正是我们关注的重点。");
    expect(checkStyleSplice({ content: text, start, end, rewrite: "" })).toEqual([]);
  });

  it("改写丢失句末标点 → terminal_punctuation_lost；删除造成相邻标点 → double_punctuation", () => {
    const { start, end } = at(content, "这正是我们关注的重点。");
    expect(rules(checkStyleSplice({ content, start, end, rewrite: "这是本文的重点" }))).toContain("terminal_punctuation_lost");
    const text = "结果稳定，需要说明的是，样本来自同一地区。";
    const span = at(text, "需要说明的是");
    expect(rules(checkStyleSplice({ content: text, start: span.start, end: span.end, rewrite: "" }))).toContain("double_punctuation");
    const ok = at(text, "需要说明的是，");
    expect(checkStyleSplice({ content: text, start: ok.start, end: ok.end, rewrite: "" })).toEqual([]);
  });
});

describe("术语一致性（确定性）", () => {
  const section = "此外，模型还可能在数据漂移时仍以较高置信度输出错误标签。";
  const corpus = `${section}\n\n第五节的实验进一步说明数据漂移会削弱校准效果。\n\n讨论部分再次分析数据漂移的来源。`;

  it("替换掉在全稿其他位置反复出现的词 → term_replaced（交作者，不自动改）", () => {
    const { start, end } = at(section, "模型还可能在数据漂移时仍以较高置信度输出错误标签");
    const violations = checkStyleSplice({ content: section, start, end, rewrite: "模型还可能在输入分布发生变化时仍以较高置信度输出错误标签", corpus });
    expect(rules(violations)).toContain("term_replaced");
    expect(violations.find((v) => v.rule === "term_replaced")?.detail).toMatch(/数据漂移/);
  });

  it("删除冗余对冲 / 自证用语（即使这些词在别处也出现）→ 放行", () => {
    const text = "我们如实报告了该方法在夜间的失败案例，结果可能在一定程度上说明光照影响较大。";
    const other = `${text}\n\n另一节同样如实报告了代价，并指出可能存在偏差。`;
    const a = at(text, "我们如实报告了该方法在夜间的失败案例");
    expect(checkStyleSplice({ content: text, start: a.start, end: a.end, rewrite: "我们报告了该方法在夜间的失败案例", corpus: other })).toEqual([]);
    const b = at(text, "结果可能在一定程度上说明光照影响较大。");
    expect(checkStyleSplice({ content: text, start: b.start, end: b.end, rewrite: "结果说明光照影响可能较大。", corpus: other })).toEqual([]);
  });

  it("差分会把被拆开的替换合并成一个改动块", () => {
    expect(diffRuns("在数据漂移时", "在输入分布发生数据变化时")).toEqual([{ removed: "数据漂移", inserted: "输入分布发生数据变化" }]);
  });
});

describe("同句重复（确定性）", () => {
  const text = "针对第二阶段使用的样本重加权策略，本文以五组随机种子的对照实验如实记录了其未带来显著收益的结果。";

  it("改写补出的成分在同一句锚外已经存在 → duplicate_in_sentence", () => {
    const { start, end } = at(text, "本文以五组随机种子的对照实验如实记录了其未带来显著收益的结果。");
    expect(rules(checkStyleSplice({ content: text, start, end, rewrite: "本文以五组随机种子的对照实验检验了样本重加权策略，其未带来显著收益。" }))).toContain("duplicate_in_sentence");
  });

  it("只删自证用语、不补主语 → 放行", () => {
    const { start, end } = at(text, "本文以五组随机种子的对照实验如实记录了其未带来显著收益的结果。");
    expect(checkStyleSplice({ content: text, start, end, rewrite: "本文以五组随机种子的对照实验记录了其未带来显著收益的结果。" })).toEqual([]);
  });
});

describe("落盘链路：拼接检查与通顺度否决", () => {
  const content = "\\section{引言}\n该模型在三个城市的数据上完成验证（降雨场景未覆盖），这正是我们关注的重点。\n\n本文还给出部署实测（单帧 0.8 秒，如实标注为非实时）。\n";
  const target = { target: "sections/intro.tex", carrier: "file" as const, content };
  const finding = (partial: Partial<StyleFinding>): StyleFinding => ({
    id: "sty-a", unitId: "u", file: "sections/intro.tex", logicalSection: "s", heading: "引言", originalQuote: "这正是我们关注的重点。",
    styleCategory: "empty_summary_transition", candidateReason: "", necessityJudgment: "UNNECESSARY", evidenceConstraints: [],
    suggestedAction: "MINIMAL_REWRITE", proposedRewrite: "", disposition: "AUTO_REWRITE_ELIGIBLE", dispositionReason: "",
    candidateSignals: [], reviewStatus: "REVIEWED", revisionStatus: "NOT_DISPATCHED", lineage: { round: 1, unitFingerprint: "f" }, ...partial,
  });

  it("残留逗号的删除在落盘前被拒（GUARD_REJECTED，原文不变）", () => {
    const prepared = prepareStyleRevisions({ findings: [finding({})], attempted: new Set(), maxAutoRewrites: 5, resolveTarget: () => target, corpus: content });
    expect(prepared.candidates).toHaveLength(0);
    expect(prepared.settled[0]).toMatchObject({ status: "GUARD_REJECTED" });
    expect(prepared.settled[0]!.detail).toMatch(/拼接检查/);
  });

  it("复核看到拼接后的整句；EQUIVALENT 但 AWKWARD / 缺少 fluency → 保持原文；FLUENT → 落盘", () => {
    const ok = finding({ id: "sty-b", originalQuote: "如实标注为非实时", styleCategory: "mechanical_template", proposedRewrite: "非实时" });
    const prepared = prepareStyleRevisions({ findings: [ok], attempted: new Set(), maxAutoRewrites: 5, resolveTarget: () => target, corpus: content });
    expect(prepared.candidates).toHaveLength(1);
    const item = styleRewriteCheckItems(prepared.candidates)[0]!;
    expect(item.sentenceAfter).toBe("本文还给出部署实测（单帧 0.8 秒，非实时）。");
    expect(item.sentenceBefore).toContain("如实标注为非实时");
    const run = (fluency?: "FLUENT" | "AWKWARD") => finalizeStyleRevisions({
      projectId: "p", runId: "r", candidates: prepared.candidates,
      verdicts: new Map([["sty-b", { verdict: "EQUIVALENT" as const, ...(fluency !== undefined ? { fluency } : {}), reason: "x" }]]),
    });
    expect(run("AWKWARD").items[0]!.status).toBe("AUTHOR_DECISION");
    expect(run("AWKWARD").writes).toHaveLength(0);
    expect(run(undefined).items[0]!.status).toBe("AUTHOR_DECISION");
    expect(run("FLUENT").items[0]!.status).toBe("AUTO_FIXED");
    expect(run("FLUENT").writes[0]!.after).toContain("（单帧 0.8 秒，非实时）。");
  });
});
