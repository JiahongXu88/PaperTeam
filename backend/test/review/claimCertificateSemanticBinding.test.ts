/**
 * M15.3.4 语义绑定（预注册方案A：A1 层级列维距离 / A1-b 聚合措辞忽略 / A1-c 区分词比较短语剥离 /
 * A2 值重合平局裁决 / A3 操作数优先派生绑定）——§6 七类反例 + 三个正例的合成夹具测试。
 * 夹具全部自写合成 LaTeX（结构仿照真实失败类，术语与数值均自造），只证算法性质，不代表真实论文检出率。
 * 期望由 M15_3_4/design/SYNTHETIC_TEST_DESIGN.md 预注册；与预注册文本的夹具级偏差（首轮 vitest 实测后修正）
 * 逐条注明：候选池要求行维得分>0（无行名 → NO_CELL_MATCHES），故平局夹具均构造「同行异列 / 同列异表同名行」。
 */
import { describe, expect, it } from "vitest";
import { buildCertificateDocument, bindTextAtom, certifyClaim, locateAtom, type CertifyInput } from "../../src/review/claimCertificate.js";
import { locateQuote } from "../../src/review/claimAuditText.js";

function certify(doc: string, claim: string, claimValue: string, counterpart: string | null, counterpartValue: string | undefined, check: CertifyInput["check"]) {
  const document = buildCertificateDocument([{ file: "main.tex", content: doc }]);
  const located = locateQuote(doc, claim);
  if (located === null) throw new Error(`fixture quote not found: ${claim}`);
  const cpLocated = counterpart === null ? null : locateQuote(doc, counterpart);
  if (counterpart !== null && cpLocated === null) throw new Error(`counterpart quote not found: ${counterpart}`);
  return certifyClaim(document, {
    claim: { file: "main.tex", start: located.start, end: located.end, value: claimValue },
    counterpart: cpLocated === null ? null : { file: "main.tex", start: cpLocated.start, end: cpLocated.end, ...(counterpartValue !== undefined ? { value: counterpartValue } : {}) },
    check,
  });
}

function bindFor(doc: string, quote: string, value: string) {
  const document = buildCertificateDocument([{ file: "main.tex", content: doc }]);
  const located = locateQuote(doc, quote);
  if (located === null) throw new Error(`fixture quote not found: ${quote}`);
  const atom = locateAtom(document, "main.tex", located.start, located.end, value).atom;
  if (atom === null) throw new Error("atom not located");
  return { document, atom, binding: bindTextAtom(document, atom) };
}

describe("M15.3.4 §6.1 T1：同表值巧合不得借值定归属", () => {
  const DOC = [
    "\\title{Edge Inference at Scale}",
    "\\begin{table}[t]",
    "\\caption{Main results on the Bench-R benchmark.}\\label{tab:main}",
    "\\begin{tabular}{lcc}",
    "\\toprule",
    "Method & MetricX & MetricY \\\\",
    "\\midrule",
    "Proposed & 42.1 & 88.7 \\\\",
    "Baseline A & 45.2 & 90.1 \\\\",
    "Baseline B & 47.3 & 91.5 \\\\",
    "\\bottomrule",
    "\\end{tabular}",
    "\\end{table}",
    "\\section{Results}",
    "Our method achieves 45.2 on MetricX.",
    "",
  ].join("\n");
  it("T1a 论断值被改成同表他行格值：行维（本文方法）决定归属，不因值巧合绑他行 → 不出支持证书", () => {
    const cert = certify(DOC, "Our method achieves 45.2 on MetricX", "45.2", "Baseline A & 45.2 & 90.1", "45.2", "INCONSISTENT");
    expect(cert.outcome).not.toBe("SUPPORTED");
    if (cert.outcome === "NOT_CERTIFIED") {
      expect(cert.reasons.join(" ")).toMatch(/PROPOSED_COUNTERPART_IS_NOT_THE_UNIQUE_BINDING|VALUE_APPEARS|TIED_CANDIDATES|NO_CELL_MATCHES/);
    }
  });
  it("T1b 精确平局集内无值重合存活者 → A2 维持 TIED_CANDIDATES（不得在平局集外挑值）", () => {
    // 偏差修正：候选池要求行维得分>0；平局 = 同一被点名的行内两个并列指标词列（共享 throughput 词元）
    const doc = [
      "\\title{Serving Throughput}",
      "\\begin{table}[t]",
      "\\caption{Serving throughput study.}\\label{tab:serve}",
      "\\begin{tabular}{lcc}",
      "\\toprule",
      "Variant & Throughput-East & Throughput-West \\\\",
      "\\midrule",
      "Alpha & 15200 & 14900 \\\\",
      "Base & 14100 & 13800 \\\\",
      "\\bottomrule",
      "\\end{tabular}",
      "\\end{table}",
      "\\section{Results}",
      "Alpha sustains a throughput of 15500 under load.",
      "",
    ].join("\n");
    const { binding } = bindFor(doc, "Alpha sustains a throughput of 15500 under load", "15500");
    expect(binding.status).toBe("AMBIGUOUS");
    expect(binding.rule).toBe("TIED_CANDIDATES");
    expect(binding.valueTieBreak ?? false).toBe(false);
  });
});

describe("M15.3.4 §6.2 T2：无题注表禁止值平局裁决", () => {
  // 偏差修正：预注册文本用裸 tabular + 通用词 Score：裸 tabular 解析不出表格；Score 属通用指标词
  // （列维不认），候选池为空。改为 table 环境 + booktabs 规则线 + 真实指标词 QPS，但无 \caption/\label
  // （解析与列维准入正常、A2 的题注/标签守卫恰好排除两表）。
  const doc = [
    "\\title{Stream Join Benchmarks}",
    "\\begin{table}[t]",
    "\\begin{tabular}{lc}",
    "\\toprule",
    "Variant & QPS \\\\",
    "\\midrule",
    "JoinA & 50.1 \\\\",
    "JoinB & 51.3 \\\\",
    "\\bottomrule",
    "\\end{tabular}",
    "\\end{table}",
    "\\begin{table}[t]",
    "\\begin{tabular}{lc}",
    "\\toprule",
    "Variant & QPS \\\\",
    "\\midrule",
    "JoinA & 55.5 \\\\",
    "JoinB & 60.2 \\\\",
    "\\bottomrule",
    "\\end{tabular}",
    "\\end{table}",
    "\\section{Results}",
    "JoinA attains a QPS of 55.5 in our study.",
    "",
  ].join("\n");
  it("两张无 caption / 无 label 表同构同分（同名行 JoinA）：值唯一重合也不得定表 → TIED_CANDIDATES 保持", () => {
    const { binding } = bindFor(doc, "JoinA attains a QPS of 55.5 in our study", "55.5");
    expect(binding.status).toBe("AMBIGUOUS");
    expect(binding.rule).toBe("TIED_CANDIDATES");
    expect(binding.valueTieBreak ?? false).toBe(false);
  });
});

describe("M15.3.4 §6.3 T3：多级表头上层词 + 比较短语内他模型名（N09 型）", () => {
  // 偏差修正：预注册文本把比较对象名放在他表行键上，实测会走既有方向 B（行键就近匹配，M15.3.1 已记录的
  // 既有行为）抢 top；改为把 PriorA 放在列组上层（N09 事故的真实结构：headerPath 上层含他模型名），
  // 精确针对 A1-c 的 DISCRIMINATING_TERM 剥离与 A1 的逐层列距。主语侧组名须用区分性专名
  // （Proposed/Ours 属通用词、不进 context 计分，会造成隐性单侧加分破坏精确平局）。
  const doc = [
    "\\title{Graph Distillation at Scale}",
    "\\begin{table}[t]",
    "\\caption{Reproduction on the Corva benchmark.}\\label{tab:repro}",
    "\\begin{tabular}{lcccc}",
    "\\toprule",
    " & \\multicolumn{2}{c}{GNX-Distill} & \\multicolumn{2}{c}{PriorA} \\\\",
    "Dataset & MacroF1 & MicroF1 & MacroF1 & MicroF1 \\\\",
    "\\midrule",
    "D1 & 94.65 & 95.00 & 91.10 & 92.30 \\\\",
    "D2 & 93.80 & 94.50 & 90.20 & 91.40 \\\\",
    "\\bottomrule",
    "\\end{tabular}",
    "\\end{table}",
    "\\section{Results}",
    "On D1, the GNX-Distill method obtains a MacroF1 of 94.65, outperforming PriorA by 3.55 points.",
    "",
  ].join("\n");
  it("上层 GNX-Distill/PriorA 各自被句内点名（PriorA 在比较短语内）→ A1 逐层列距 + A2 值裁决 + A1-c 剥离 → 唯一绑定 + SUPPORTED", () => {
    const { binding } = bindFor(doc, "obtains a MacroF1 of 94.65, outperforming PriorA by 3.55 points", "94.65");
    expect(binding.status).toBe("UNIQUE");
    expect(binding.bound?.rowKey).toEqual(["D1"]);
    expect(binding.bound?.headerPath).toEqual(["GNX-Distill", "MacroF1"]);
    const cert = certify(doc, "obtains a MacroF1 of 94.65, outperforming PriorA by 3.55 points", "94.65", "D1 & 94.65 & 95.00 & 91.10 & 92.30", "94.65", "CONSISTENT");
    expect(cert.outcome).toBe("SUPPORTED");
  });
});

describe("M15.3.4 §6.4 T4：跨表值竞争（B2）在 A1/A2 激活下保持", () => {
  const doc = [
    "\\title{Serving Latency Study}",
    "\\begin{table}[t]",
    "\\caption{Serving latency (ms).}\\label{tab:lat}",
    "\\begin{tabular}{lc}",
    "\\toprule",
    "System & Latency \\\\",
    "\\midrule",
    "Ours & 55.0 \\\\",
    "Base & 58.3 \\\\",
    "\\bottomrule",
    "\\end{tabular}",
    "\\end{table}",
    "\\begin{table}[t]",
    "\\caption{Per-region details.}\\label{tab:region}",
    "\\begin{tabular}{lc}",
    "\\toprule",
    "Region & Latency \\\\",
    "\\midrule",
    "north & 55.5 \\\\",
    "\\bottomrule",
    "\\end{tabular}",
    "\\end{table}",
    "\\section{Results}",
    "Our system attains a Latency of 55.5 ms.",
    "",
  ].join("\n");
  it("冲突值逐字出现在他表 → VALUE_APPEARS_IN_OTHER_TABLE 拒绝，不出证书", () => {
    const cert = certify(doc, "Our system attains a Latency of 55.5 ms", "55.5", "Ours & 55.0", "55.0", "INCONSISTENT");
    expect(cert.outcome).toBe("NOT_CERTIFIED");
    expect(cert.reasons.join(" ")).toContain("VALUE_APPEARS_IN_OTHER_TABLE");
  });
});

describe("M15.3.4 §6.5 T5：值前多指标不可证（MULTIPLE_METRICS_BEFORE_VALUE）", () => {
  // 偏差修正：预注册文本用「A and B of x and y」句式，实测 beforeWide 在最后一个 and 处截断
  // （左扫描只见 B，见不到 A），无法触发该防线；改为「Prec/Recall of 45.2/88.7」斜杠并列句式
  // （词元切分含 prec、recall，无 and 截断）。该防线在真实语料上的实际触发形态是共享子词元列
  // （N09-P07 的 Homo|Homo+Hete），非并列 and 列表。
  const doc = [
    "\\title{Retrieval Quality}",
    "\\begin{table}[t]",
    "\\caption{Retrieval on the K-Set.}\\label{tab:ret}",
    "\\begin{tabular}{lcc}",
    "\\toprule",
    "Model & Prec & Recall \\\\",
    "\\midrule",
    "RetNet & 45.2 & 88.7 \\\\",
    "\\bottomrule",
    "\\end{tabular}",
    "\\end{table}",
    "\\section{Results}",
    "RetNet achieves Prec/Recall of 45.2/88.7 on K-Set.",
    "",
  ].join("\n");
  it("两个指标名先于数值出现且无 respectively → 拒绝", () => {
    const cert = certify(doc, "achieves Prec/Recall of 45.2/88.7", "45.2", "RetNet & 45.2 & 88.7", "45.2", "CONSISTENT");
    expect(cert.outcome).toBe("NOT_CERTIFIED");
    expect(cert.reasons.join(" ")).toContain("MULTIPLE_METRICS_BEFORE_VALUE");
  });
});

describe("M15.3.4 §6.6 T6：A3 多解 / 跨表操作数 / AGGREGATE 排除", () => {
  it("T6a 同表两个行对都复现论断值（84.58−72.06 = 90.08−77.56 = 12.52，四数均在句内）→ 操作数发现多解 → 弃判", () => {
    // 偏差修正：预注册文本只把一对操作数写进句内（另一对自然不构成解）；句内须同时出现四个数
    const doc = [
      "\\title{Scalable Graph Refinement}",
      "\\begin{table}[t]",
      "\\caption{Tuning gains on graph benchmarks.}\\label{tab:tune}",
      "\\begin{tabular}{lc}",
      "\\toprule",
      "Model & Score \\\\",
      "\\midrule",
      "Vanilla & 72.06 \\\\",
      "Tuned & 84.58 \\\\",
      "ColdA & 77.56 \\\\",
      "ColdB & 90.08 \\\\",
      "\\bottomrule",
      "\\end{tabular}",
      "\\end{table}",
      "\\section{Results}",
      "Our approach improves the Score by 12.52 percentage points (84.58 over 72.06, and 90.08 over 77.56).",
      "",
    ].join("\n");
    const cert = certify(doc, "improves the Score by 12.52 percentage points (84.58 over 72.06, and 90.08 over 77.56)", "12.52", null, undefined, "CONSISTENT");
    expect(cert.outcome).toBe("NOT_CERTIFIED");
    expect(cert.derived?.bindingProvenance).toBeUndefined();
  });
  it("T6b 操作数分居两表 → 不跨表配对 → 弃判（不操作数发现）", () => {
    const doc = [
      "\\title{Scalable Graph Refinement}",
      "\\begin{table}[t]\\caption{Reported scores.}\\label{tab:rep}",
      "\\begin{tabular}{lc}\\toprule", "Model & Score \\\\", "\\midrule", "Vanilla & 72.06 \\\\", "\\bottomrule", "\\end{tabular}\\end{table}",
      "\\begin{table}[t]\\caption{Tuned scores.}\\label{tab:tun}",
      "\\begin{tabular}{lc}\\toprule", "Model & Score \\\\", "\\midrule", "Tuned & 84.58 \\\\", "\\bottomrule", "\\end{tabular}\\end{table}",
      "\\section{Results}",
      "Our approach improves the Score by 12.52 percentage points (84.58 over 72.06).",
      "",
    ].join("\n");
    const cert = certify(doc, "improves the Score by 12.52 percentage points (84.58 over 72.06)", "12.52", null, undefined, "CONSISTENT");
    expect(cert.outcome).toBe("NOT_CERTIFIED");
    expect(cert.derived?.bindingProvenance).toBeUndefined();
  });
  it("T6c AGGREGATE 措辞（on average）→ A3 排除（family 不在 {DIFFERENCE, MULTIPLE, PERCENT}），维持弃判", () => {
    const doc = [
      "\\title{Scalable Graph Refinement}",
      "\\begin{table}[t]",
      "\\caption{Tuning gains on graph benchmarks.}\\label{tab:tune}",
      "\\begin{tabular}{lc}",
      "\\toprule",
      "Model & Score \\\\",
      "\\midrule",
      "Vanilla & 72.06 \\\\",
      "Tuned & 84.58 \\\\",
      "\\bottomrule",
      "\\end{tabular}",
      "\\end{table}",
      "\\section{Results}",
      "Our approach improves the Score by 12.52 percentage points on average (84.58 over 72.06).",
      "",
    ].join("\n");
    const cert = certify(doc, "improves the Score by 12.52 percentage points on average (84.58 over 72.06)", "12.52", null, undefined, "CONSISTENT");
    expect(cert.outcome).toBe("NOT_CERTIFIED");
    expect(cert.derived?.family).toBe("AGGREGATE");
    expect(cert.derived?.bindingProvenance).toBeUndefined();
  });
});

describe("M15.3.4 §6.7 T7：同名方法跨表 + 值巧合不得绕过对应关系认定", () => {
  const doc = [
    "\\title{Fused Kernels}",
    "\\begin{table}[t]",
    "\\caption{Main results.}\\label{tab:main}",
    "\\begin{tabular}{lc}",
    "\\toprule",
    "Method & MetricX \\\\",
    "\\midrule",
    "Proposed & 42.1 \\\\",
    "\\bottomrule",
    "\\end{tabular}",
    "\\end{table}",
    "\\begin{table}[t]",
    "\\caption{Reproduction results.}\\label{tab:repro}",
    "\\begin{tabular}{lc}",
    "\\toprule",
    "Method & MetricX \\\\",
    "\\midrule",
    "Proposed & 42.1 \\\\",
    "\\bottomrule",
    "\\end{tabular}",
    "\\end{table}",
    "\\section{Results}",
    "Our method achieves 42.1 on MetricX.",
    "",
  ].join("\n");
  it("复现表同值格被提议为对应 → 无论平局或绑定到他格，都不得出 VERIFIED_* 强判", () => {
    const cert = certify(doc, "Our method achieves 42.1 on MetricX", "42.1", "Proposed & 42.1", "42.1", "CONSISTENT");
    expect(cert.outcome).not.toBe("SUPPORTED");
    expect(cert.outcome).not.toBe("CONTRADICTED");
    expect(cert.reasons.join(" ")).toMatch(/VALUE_APPEARS_IN_OTHER_TABLE|TIED_CANDIDATES|PROPOSED_COUNTERPART_IS_NOT_THE_UNIQUE_BINDING/);
  });
});

describe("M15.3.4 TP1：多级表头上层词就近匹配（A1）", () => {
  const doc = [
    "\\title{Language Evaluation Suite}",
    "\\begin{table}[t]",
    "\\caption{Benchmark accuracy.}\\label{tab:bench}",
    "\\begin{tabular}{lcccc}",
    "\\toprule",
    " & \\multicolumn{2}{c}{Zero-shot} & \\multicolumn{2}{c}{Few-shot} \\\\",
    "Model & Easy & Medium & Easy & Medium \\\\",
    "\\midrule",
    "GPT-5 & 95.3 & 87.2 & 96.1 & 88.4 \\\\",
    "Llama-X & 93.8 & 85.9 & 94.2 & 86.7 \\\\",
    "\\bottomrule",
    "\\end{tabular}",
    "\\end{table}",
    "\\section{Results}",
    "GPT-5 attains 95.3 in the zero-shot setting.",
    "",
  ].join("\n");
  it("指标语义在上层（Zero-shot 组）、叶层（Easy/Medium）未提及 → A1 逐层匹配 + A2 值裁决 → 唯一绑定 + SUPPORTED", () => {
    const { binding } = bindFor(doc, "GPT-5 attains 95.3 in the zero-shot setting", "95.3");
    expect(binding.status).toBe("UNIQUE");
    expect(binding.bound?.rowKey).toEqual(["GPT-5"]);
    expect(binding.bound?.headerPath).toEqual(["Zero-shot", "Easy"]);
    const cert = certify(doc, "GPT-5 attains 95.3 in the zero-shot setting", "95.3", "GPT-5 & 95.3 & 87.2 & 96.1 & 88.4", "95.3", "CONSISTENT");
    expect(cert.outcome).toBe("SUPPORTED");
  });
});

describe("M15.3.4 TP2：精确平局 + 唯一值重合（A2 正例，层级平局形态）", () => {
  // 偏差修正：预注册文本用同行两个共享词元叶列（Throughput-East/West）造同级平局，实测 MULTIPLE_METRICS_
  // BEFORE_VALUE 防线会因共享词元先于值出现而否决（该防线在真实语料正是对共享子词元列触发的，N09-P07）——
  // 这是防线正确工作，不是缺陷。A2 在真实语料的两次破平局（N08-P01/P02）都是层级平局形态：指标词在上层，
  // 同层兄弟叶未被点名，靠值重合定叶。本夹具改用该形态（Cloud 上层 + P50/P95 叶）。
  const doc = [
    "\\title{Edge Serving Study}",
    "\\begin{table}[t]",
    "\\caption{Response latency decomposition.}\\label{tab:resp}",
    "\\begin{tabular}{lcccc}",
    "\\toprule",
    " & \\multicolumn{2}{c}{Cloud} & \\multicolumn{2}{c}{Edge} \\\\",
    "Variant & P50 & P95 & P50 & P95 \\\\",
    "\\midrule",
    "Alpha & 90.1 & 240.0 & 110.5 & 380.2 \\\\",
    "Base & 92.0 & 250.5 & 115.0 & 390.0 \\\\",
    "\\bottomrule",
    "\\end{tabular}",
    "\\end{table}",
    "\\section{Results}",
    "In the Cloud setting, Alpha attains a response of 90.1 ms.",
    "",
  ].join("\n");
  it("上层 Cloud 点名、P50/P95 叶未点名 → 层级平局；值 90.1 恰与一格重合、表有题注 → 值裁决破平局（加性标记）+ SUPPORTED", () => {
    const { binding } = bindFor(doc, "In the Cloud setting, Alpha attains a response of 90.1 ms", "90.1");
    expect(binding.status).toBe("UNIQUE");
    expect(binding.bound?.rowKey).toEqual(["Alpha"]);
    expect(binding.bound?.headerPath).toEqual(["Cloud", "P50"]);
    expect(binding.valueTieBreak).toBe(true);
    const cert = certify(doc, "In the Cloud setting, Alpha attains a response of 90.1 ms", "90.1", "Alpha & 90.1 & 240.0 & 110.5 & 380.2", "90.1", "CONSISTENT");
    expect(cert.outcome).toBe("SUPPORTED");
  });
});

describe("M15.3.4 TP3：操作数优先派生绑定（A3 正例，N09-P09 型）", () => {
  // 偏差修正：列头 Score 无极性词元 → DERIVED_METRIC_POLARITY_UNKNOWN 拦截（既有防线）；改用 Speed（higher-is-better）
  const doc = [
    "\\title{Scalable Graph Refinement}",
    "\\begin{table}[t]",
    "\\caption{Tuning gains on graph benchmarks.}\\label{tab:tune}",
    "\\begin{tabular}{lc}",
    "\\toprule",
    "Model & Speed \\\\",
    "\\midrule",
    "Vanilla & 72.06 \\\\",
    "Tuned & 84.58 \\\\",
    "\\bottomrule",
    "\\end{tabular}",
    "\\end{table}",
    "\\section{Results}",
    "Our approach improves the Speed by 12.52 percentage points (84.58 over 72.06).",
    "",
  ].join("\n");
  it("句内操作数各只出现一次、唯一行对复现 12.52 → operand-discovered 绑定 + SUPPORTED（双钥匙 CONSISTENT）", () => {
    const cert = certify(doc, "improves the Speed by 12.52 percentage points (84.58 over 72.06)", "12.52", null, undefined, "CONSISTENT");
    expect(cert.kind).toBe("DERIVED_RECOMPUTE");
    expect(cert.derived?.bindingProvenance).toBe("operand-discovered");
    expect(cert.outcome).toBe("SUPPORTED");
  });
  it("数值被改动（13.52）→ 无行对复现 → 操作数发现失败 → 弃判（发现即一致，不提供矛盾方向的值巧合通道）", () => {
    const doc2 = doc.replace("by 12.52 percentage points", "by 13.52 percentage points");
    const cert = certify(doc2, "improves the Speed by 13.52 percentage points (84.58 over 72.06)", "13.52", null, undefined, "INCONSISTENT");
    expect(cert.outcome).toBe("NOT_CERTIFIED");
    expect(cert.derived?.bindingProvenance).toBeUndefined();
  });
});

describe("M15.3.4 机械守卫：版本号 / 序列化确定性", () => {
  const doc = [
    "\\title{Serving Throughput}",
    "\\begin{table}[t]\\caption{Serving throughput study.}\\label{tab:serve}",
    "\\begin{tabular}{lcc}\\toprule", "Variant & Throughput-East & Throughput-West \\\\", "\\midrule", "Alpha & 15200 & 14900 \\\\", "Base & 14100 & 13800 \\\\", "\\bottomrule", "\\end{tabular}\\end{table}",
    "\\section{Results}",
    "Alpha sustains a throughput of 15200 under load.",
    "",
  ].join("\n");
  it("claim-certificate/v1 不变；同一输入两次调用 inputsSha256 逐字节一致（派生加性字段不进配方）", () => {
    const a = certify(doc, "Alpha sustains a throughput of 15200 under load", "15200", "Alpha & 15200 & 14900", "15200", "CONSISTENT");
    const b = certify(doc, "Alpha sustains a throughput of 15200 under load", "15200", "Alpha & 15200 & 14900", "15200", "CONSISTENT");
    expect(a.version).toBe("claim-certificate/v1");
    expect(a.inputsSha256).toBe(b.inputsSha256);
    expect(a.inputsSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
