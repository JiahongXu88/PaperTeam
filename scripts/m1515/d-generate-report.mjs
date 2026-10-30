#!/usr/bin/env node
/**
 * M15.15 D — 真实中文目标期刊用户路径报告生成器（确定性组装 + 有限模型调用）。
 *
 * 输入（全部已有工件，不重复计算）：
 *   - case-R（CJIG 2023 已发表中文研究论文，作"中文稿件"演示）：Phase C F5 的
 *     P0/P1/P2 输出（含 DBNet verified_fulltext 证据）
 *   - b1（作者综述稿，授权环境）：M15.14 phase-d b1 工件 + 本轮增强的一次 P2
 *     （pool 含 HOTA/IDF1 verified_fulltext 摘录）
 *   - M15_9 cjig.json / cea.json 官方 guideline 工件 + CJIG/CEA benchmark 观测带
 * 输出：phase-d/out/report-cjig-caseR.md / report-cjig-b1.md / differential-caseR-CJIG-vs-CEA.md
 * 纪律：不输出录用概率；学术风险全部限定性表述；缺全文/事实的层如实标注。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");
const ROOT = "D:\\PaperTeamData\\M15\\M15_15";
const M159 = "D:\\PaperTeamData\\M15\\M15_9";
const M1514 = "D:\\PaperTeamData\\M15\\M15_14";
const OUT = join(ROOT, "phase-d", "out");
await mkdir(OUT, { recursive: true });

const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));

// ---- CJIG 观测带（从 M15_9 冻结语料的 parsed blocks 确定性重算；非官方要求） ----
const { quantile } = await import(
  `file://${join(REPO, "backend", "dist", "target", "quantiles.js").replaceAll("\\", "/")}`
);
import { readdirSync } from "node:fs";
const corpusDir = join(M159, "phase-b", "corpus", "cjig", "parsed");
const wordCounts = [];
const refCounts = [];
for (const file of readdirSync(corpusDir)) {
  if (!file.endsWith(".json")) continue;
  const record = await readJson(join(corpusDir, file)).catch(() => null);
  if (record === null || record.ok !== true) continue;
  const text = (record.blocks ?? []).map((b) => b.text).join("\n");
  const words = (text.match(/[A-Za-z][A-Za-z'-]+/g) ?? []).length;
  const cjk = (text.match(/\p{Script=Han}/gu) ?? []).length;
  wordCounts.push(words + Math.round(cjk / 1.6)); // 中文字符≈1.6 词的保守折算（披露）
  refCounts.push(((text.match(/\n\[\d+\]/g) ?? []).length) || ((text.match(/DOI[：:]/g) ?? []).length));
}
const sortedW = [...wordCounts].sort((a, b) => a - b);
const band = (arr, p) => quantile(arr, p);
const cjigBands = {
  n: sortedW.length,
  bodyWordsP25P75: [band(sortedW, 0.25), band(sortedW, 0.75)],
  medianRefs: null,
};

// ---- 官方 guideline 层 ----
const cjig = await readJson(join(M159, "phase-c", "guideline-artifacts", "cjig.json"));
const cea = await readJson(join(M159, "phase-c", "guideline-artifacts", "cea.json"));

const guidelineSection = (g, note) => [
  `### 官方投稿规范（${g.displayName ?? g.venueId}；逐字摘录工件 ${g.frozenAt ?? ""}）`,
  `- 身份：${JSON.stringify(g.identity ?? {})}`.slice(0, 300),
  `- 官方要求条数：${(g.requirements ?? []).length}`,
  ...((g.requirements ?? []).slice(0, 12).map((r, i) =>
    `  ${i + 1}. [${r.field ?? r.id ?? "req"}${r.hard === true ? "; 硬性" : ""}] ${String(r.officialQuote ?? r.text ?? r.requirement ?? "").slice(0, 160)}（${r.sourceUrl ?? "见工件"}）`)),
  note ? `- ${note}` : "",
].filter(Boolean).join("\n");

// ---- Phase C F5 工件（case-R vs DBNet） ----
const f5 = await readJson(join(ROOT, "phase-c", "out", "F5", "p2.json")).catch(() => null);
const f5p1 = await readJson(join(ROOT, "phase-c", "out", "F5", "p1.json")).catch(() => null);

function auditSection(artifact, title) {
  if (artifact === null) return `### ${title}\n（工件缺失）`;
  const lines = [`### ${title}`];
  for (const c of artifact.contributions ?? []) {
    lines.push(`- 贡献【${c.claimType}】${(c.claimParaphrase ?? c.claimQuote ?? "").slice(0, 120)}` +
      `（支持：${(c.supportLocations ?? []).length} 处，锚校验 ${c.anchorVerified ? "通过" : "失败"}）`);
  }
  for (const cmp of artifact.comparisons ?? []) {
    const prior = (cmp.nearestPriorWorks ?? [])[0] ?? {};
    lines.push(`- vs 先前工作「${prior.title ?? "?"}」(${prior.year ?? "?"})：**${cmp.status}**` +
      `（依据级：${cmp.differenceBasis}；先前工作侧 quote ${prior.priorQuoteVerified === true ? "已回放核验" : prior.quote ? "未通过回放" : "未给出"}）` +
      `\n  - 共同机制：${String(cmp.commonMechanism ?? "").slice(0, 150)}` +
      `\n  - 实质差异：${String(cmp.substantiveDifference ?? "").slice(0, 200)}` +
      `\n  - 待验证：${String(cmp.missingVerification ?? "").slice(0, 150)}`);
  }
  for (const gp of artifact.gapPlan ?? []) {
    lines.push(`- 行动【${gp.actionType === "author_decision" ? "须作者决策（缺实验/事实）" : "可改写"}】${gp.gap?.slice(0, 120)}`);
  }
  lines.push(`- 守卫：${JSON.stringify(artifact.guards ?? {})}`);
  return lines.join("\n");
}

// ---- 同稿差分（case-R：CJIG vs CEA） ----
const diffReport = `# 同稿差分：case-R《层级语义融合的场景文本检测》投 CJIG vs CEA

> 生成：M15.15 Phase D（确定性组装）。本报告不构成录用判断；两个期刊的学术质量档位
> 均无已校准数据（M15.10 事实不变），差异仅限官方要求与可支持的观测参照。

## 真实差异（官方层面）

${guidelineSection(cjig, "CJIG：稿件事实的合规检查需 LaTeX 源（compliance facts），PDF-only 稿件本轮 NOT_EVALUATED——既有产品约束。")}

${guidelineSection(cea, "CEA：官方指南工件仅 4 条要求（少于 CJIG 12 条）——信息量差异本身是如实呈现的官方事实，不代表要求更松。")}

## 观测参照差异（非官方）

- CJIG：M15_9 冻结 24 篇全文语料（正文词数 p25-p75=4577-10063 等）。
- CEA：M15_9 语料 24 篇仅摘要级（fulltextBasis=0）——篇幅/结构观测带不可得，
  差分报告中该层标注 **暂无足够证据**，不以 CJIG 带冒充。

## 学术风险层（与期刊无关的稿件事实）

${f5 ? auditSection(f5.artifact, "case-R 贡献/证据审计（Phase C F5，含 DBNet 全文证据）") : "（Phase C F5 工件未生成）"}

## 不可判定项（如实）

1. 两刊对同一稿件的学术质量档位差异：无独立人类标签，不可自动判断。
2. CEA 观测带：缺全文语料。
3. 稿件是否"达到"任一刊录用水平：本系统不输出该判断。
`;

await writeFile(join(OUT, "differential-caseR-CJIG-vs-CEA.md"), diffReport, "utf8");
console.log("[done] differential report ->", join(OUT, "differential-caseR-CJIG-vs-CEA.md"));

// ---- case-R 主报告（CJIG） ----
const caseRReport = `# 投稿准备度报告（advisory）：case-R《层级语义融合的场景文本检测》→ CJIG

> 生成：M15.15 Phase D（确定性组装 + Phase C F5 审计工件）。
> **本报告不判断、也不暗示该稿是否达到 CJIG 录用水平**；无目标期刊独立人类质量标签（M15.10 事实）。

## 1. 官方投稿规范层

${guidelineSection(cjig, "PDF-only 稿件的机器合规检查需 LaTeX 源（compliance facts）——本轮 NOT_EVALUATED，如实呈现；不可检查项不虚构结论。")}

## 2. 同刊观测参照（非官方）

- 冻结语料 n=${cjigBands.n} 篇（M15_9）；正文词数 p25-p75 ≈ ${cjigBands.bodyWordsP25P75.join(" - ")}
  （中文按 1.6 字/词保守折算，口径已披露）。
- 该带只说明"同刊最近发表的论文长什么样"，**不是**投稿要求，更不是录用标准。

## 3. 贡献 vs 先前工作（证据分层）

${f5 ? auditSection(f5.artifact, "Phase C F5：ContributionAuditService（P2，pool 含 DBNet verified_fulltext 方法节摘录）") : "（F5 工件未生成）"}

${f5p1 ? auditSection(
  { contributions: [], comparisons: (f5p1.parsed?.comparisons ?? []).map((c) => ({ ...c, nearestPriorWorks: c.nearestPriorWorks ?? [] })), gapPlan: [] },
  "同稿 P1（one-shot + 同全文材料）：四态/依据级对照",
) : ""}

## 4. Claim→Experiment（缺什么实验，须作者决策）

${f5 ? (f5.artifact.gapPlan ?? []).map((g) =>
  `- 【${g.status === "author_decision" ? "须作者完成/确认" : "可由改写解决"}】${g.gap ?? ""}${g.experimentPlan ? `（建议实验：${g.experimentPlan.purpose ?? ""}；基线 ${g.experimentPlan.baselines ?? "?"}；数据 ${g.experimentPlan.datasets ?? "?"}；指标 ${g.experimentPlan.metrics ?? "?"}）` : ""}`,
).join("\n") : "（无）"}

## 5. 行动优先级（作者视角）

- 现在可做（改写类）：见 gapPlan 中 can_rewrite 项。
- 需补真实文献核验：POTENTIAL_OVERLAP / INSUFFICIENT_EVIDENCE 项的 missingVerification。
- 需真实实验（系统不代做、不虚构）：requires_real_experiment 项，停 Author Decision。
- 需作者确认的事实：合规层 NOT_EVALUATED 项（题目字数/关键词要素/摘要四要素等需 LaTeX 才能机检）。

## 6. 总体状态（限定性）

- 明确违反官方要求：本轮机检不可用（NOT_EVALUATED）——不虚报通过。
- 有证据支持的学术风险：见第 3/4 节逐项（每项带证据等级与 quote 回放状态）。
- 暂无足够证据的项：已逐项标注 INSUFFICIENT_EVIDENCE / EVIDENCE_GAP。
`;

await writeFile(join(OUT, "report-cjig-caseR.md"), caseRReport, "utf8");
console.log("[done] caseR report ->", join(OUT, "report-cjig-caseR.md"));

// ---- b1 综述稿报告（CJIG；M15.14 工件 + 本轮 fulltext 增强 P2） ----
const b1M1514 = await readJson(join(M1514, "phase-d-journal", "case-b1.json")).catch(() => null);
const b1Enhanced = await readJson(join(ROOT, "phase-d", "out", "b1-fulltext-p2.json")).catch(() => null);

function m1514AuditSection(artifact, title) {
  if (artifact === null) return `### ${title}\n（工件缺失）`;
  return auditSection(artifact, title);
}

const b1Report = `# 投稿准备度报告（advisory）：作者综述稿 b1《多目标跟踪评测指标体系综述》→ CJIG

> 生成：M15.15 Phase D。**不判断录用水平**；survey 语义（覆盖面/比较/综合深度）生效，
> 不因"无新实验"降档。

## 1. 官方投稿规范层

- M15_9 已机检（LaTeX 源可得）：3 项违规（题目字数 / 关键词要素 / 摘要四要素）——
  逐项来源见 M15_9 工件，作者可直接修改。

${guidelineSection(cjig)}

## 2. 同刊观测参照（非官方）

- 冻结语料 n=${cjigBands.n}；正文词数 p25-p75 ≈ ${cjigBands.bodyWordsP25P75.join(" - ")}（折算口径同前）。

## 3. 贡献 vs 先前工作

### M15.14 基线（abstract/metadata 级 pool，12 候选）

${b1M1514 ? m1514AuditSection(b1M1514.audit, "M15.14 ContributionAuditService（pool 全摘要级）") : "（M15.14 工件缺失）"}

### 本轮 fulltext 增强（HOTA/IDF1 verified_fulltext 摘录入 pool）

${b1Enhanced ? m1514AuditSection(b1Enhanced.artifact, "M15.15 P2（同一服务，pool 含全文摘录）") : "（增强审计未运行或工件缺失——如实呈现）"}

## 4. 综述语义检查（对照研究论文语义）

- 贡献清册以 taxonomy/coverage/综合主张为主（M15.14 工件 documentType=survey 生效记录）。
- 缺"新实验"不计为缺陷；计入行动清单的是覆盖面/比较深度类 gap（如有）。

## 5. 行动优先级

- 可改写：官方格式 3 项违规 + can_rewrite 类 gap。
- 需补文献核验：INSUFFICIENT_EVIDENCE 项（先前工作实现级异同需全文）。
- 须作者确认：综述边界选择、指标取舍的表述事实。

## 6. 总体状态（限定性）

同 case-R 报告纪律：不输出录用判断；各项带证据等级。
`;

await writeFile(join(OUT, "report-cjig-b1.md"), b1Report, "utf8");
console.log("[done] b1 report ->", join(OUT, "report-cjig-b1.md"));
