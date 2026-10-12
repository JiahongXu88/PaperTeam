/**
 * M13.7.9 Academic Redundancy Classifier 测试：
 * - 探测器 pair 原样进入分类层（指标 A 不变），每个 pair 得到类别 / 规则 / 可解释理由；
 * - P：引言预展开时有害的是引言句而不是 owner 句；
 * - S：路标句在 develop / compare / conclude 记有害，framing 的路线图句不计；孤立路标句也计入；
 * - L：develop 节之间重复的免责句有害；compare（owner）与引言范围声明不计；单句 develop 限制记 uncertain；
 * - X：比较节的提醒不计有害，containment ≥ 0.8 的逐字搬运计有害，灰区记 uncertain；
 * - E / M：结论一句概括不计，逐一复述（≥ 2 句）升级为 M；
 * - F：短标签句被长句包含记误报；
 * - 指标 B 给出下界 / 上界，不包含必要引用与孤立科学限制；角色可显式传入或推断；`\%` 不破坏分析。
 */
import { describe, expect, it } from "vitest";

import {
  analyzeSignpost,
  classifyAcademicRedundancy,
  countUnits,
  inferSectionRoles,
  isSignpostSentence,
} from "../../src/review/academicRedundancyClassifier.js";

const MECH_BYOL = "BYOL 依赖在线网络与目标网络两个相互交互的网络：训练在线网络去预测目标网络对同一图像另一增强视图的表示，同时目标网络以在线网络的慢速移动平均更新\\cite{grill2020byol}。";
const MECH_BYOL_RESTATED = "BYOL 以在线网络预测目标网络对同一图像另一增强视图的表示，并以在线网络的慢速移动平均更新目标网络\\cite{grill2020byol}。";
const MECH_SIMSIAM = "SimSiam 的实验表明，该损失与结构下坍缩解确实存在，但停止梯度操作在防止坍缩中起关键作用\\cite{chen2020simsiam}。";
const MECH_SIMSIAM_RESTATED = "SimSiam 的实验表明坍缩解在该损失与结构下确实存在，停止梯度操作在防止坍缩中起关键作用\\cite{chen2020simsiam}。";
const DISCLAIMER_A = "需要说明的是，本节论述依据的是两篇文献摘要中的作者自述结论，未涉及本文自己的实验。";
const DISCLAIMER_B = "本节论述同样基于两篇文献摘要中的作者自述结论，不涉及本文自己的实验。";
const INTRO_SCOPE = "本综述仅基于上述四篇文献的公开摘要梳理其机制关系，不包含本文实验。";

const ROLES = { intro: "framing", a: "develop", b: "develop", cmp: "compare", end: "conclude" } as const;

describe("classifyAcademicRedundancy", () => {
  it("引言预展开（P）：有害的是引言句，owner 句不计；指标 A 与探测器一致", () => {
    const report = classifyAcademicRedundancy(
      [
        { id: "intro", latex: `\\section{引言}\n本文整理两条路线。${MECH_BYOL}` },
        { id: "b", latex: `\\section{无负样本方法}\n${MECH_BYOL_RESTATED} 其结果按引文范围转述。` },
        { id: "end", latex: "\\section{结论}\n两条路线在是否使用负样本上不同，统一评测是未来工作。" },
      ],
      { roles: { intro: "framing", b: "develop", end: "conclude" } },
    );
    expect(report.summary.lexical.restatedCharShare).toBe(report.detector.summary.restatedCharShare);
    const p = report.pairs.find((entry) => entry.class === "P");
    expect(p).toBeDefined();
    expect(p?.harmfulSide).toBe("earlier");
    expect(p?.rule).toBe("R4");
    expect(report.harmfulSentences.map((s) => s.section)).toEqual(["intro"]);
    expect(report.harmfulSentences[0]?.text).toContain("慢速移动平均");
    expect(report.summary.harmful.byClass.P?.sentences).toBe(1);
    expect(report.summary.harmful.share).toBeGreaterThan(0);
  });

  it("路标句（S）：develop / compare / conclude 的路标记有害，引言路线图不计，孤立路标也计入", () => {
    const report = classifyAcademicRedundancy(
      [
        { id: "intro", latex: "本文围绕两条路线展开。其中，前者在「对比框架」一节完整展开，后者在「孪生方法」一节完整展开，并在「综合比较」一节进行对照讨论。" },
        { id: "a", latex: `${MECH_SIMSIAM} 不依赖负样本的替代路线将在「孪生方法」一节展开。` },
        { id: "b", latex: "孪生方法以另一方式学习表示。两者差异的详细比较留待下一节。" },
        { id: "cmp", latex: "本节沿四个维度对照两条路线，机制细节见「对比框架」与「孪生方法」两节。两条路线在负样本依赖上不同。" },
        { id: "end", latex: "两条路线的机制细节已分别在「对比框架」与「孪生方法」两节展开，其差异见「综合比较」一节。" },
      ],
      { roles: ROLES },
    );
    const harmfulSignposts = report.signpostSentences.filter((s) => s.harmful);
    expect(harmfulSignposts.map((s) => s.section).sort()).toEqual(["a", "b", "cmp", "end"]);
    expect(report.signpostSentences.find((s) => s.section === "intro")?.harmful).toBe(false);
    expect(report.summary.framingRoadmapSentences).toBe(1);
    // "留待下一节" 没有与前文形成词面 pair，但作为孤立路标仍进入有害集合
    expect(report.harmfulSentences.some((s) => s.section === "b" && s.class === "S" && s.pairs.includes("(standalone)"))).toBe(true);
    for (const entry of report.pairs.filter((p) => p.class === "S")) expect(entry.rule).toBe("R1");
    expect(report.summary.harmful.byClass.S?.sentences).toBe(4);
  });

  it("限制重复（L）：两个 develop 节各写一次免责有害；引言范围声明与 compare owner 不计；单句 develop 限制记 uncertain", () => {
    const repeated = classifyAcademicRedundancy(
      [
        { id: "intro", latex: `本文整理两条路线。${INTRO_SCOPE}` },
        { id: "a", latex: `SimCLR 的三项发现按引文说明。${DISCLAIMER_A}` },
        { id: "b", latex: `BYOL 的机制按引文说明。${DISCLAIMER_B}` },
        { id: "cmp", latex: "本文材料仅为四篇文献的公开摘要，不含任何本文实验；各文数值来自不同设置，不能据此给出性能排序。" },
        { id: "end", latex: "统一协议下的评测是未来工作。" },
      ],
      { roles: ROLES },
    );
    const l = repeated.pairs.filter((p) => p.class === "L");
    expect(l.length).toBeGreaterThanOrEqual(1);
    expect(repeated.harmfulSentences.filter((s) => s.class === "L").map((s) => s.section).sort()).toEqual(["a", "b"]);
    // 引言范围声明 ↔ compare owner 的重复不计有害
    expect(repeated.harmfulSentences.some((s) => s.section === "intro" || s.section === "cmp")).toBe(false);

    const single = classifyAcademicRedundancy(
      [
        { id: "intro", latex: "本文整理两条路线。" },
        { id: "a", latex: "LoRA 冻结预训练权重并注入秩分解矩阵。更强的普适性结论（如在任意任务上与全量微调质量完全一致）尚缺乏可靠证据支撑，本文不作此类断言。" },
        { id: "cmp", latex: "此外，LoRA 在任意任务上与全量微调质量完全一致的更强命题亦缺乏可靠证据支撑，本文不作此类断言。" },
        { id: "end", latex: "统一评测是未来工作。" },
      ],
      { roles: { intro: "framing", a: "develop", cmp: "compare", end: "conclude" } },
    );
    const grey = single.pairs.find((p) => p.rule === "R2u");
    expect(grey).toBeDefined();
    expect(grey?.class).toBe("uncertain");
    expect(single.summary.harmful.sentenceCount).toBe(0);
    expect(single.uncertainSentences.map((s) => s.section)).toEqual(["a"]);
    expect(single.summary.harmfulUpperShare).toBeGreaterThan(single.summary.harmful.share);
  });

  it("比较节（X）：提醒不计有害，逐字搬运（containment ≥ 0.8）记有害，灰区记 uncertain；阈值可调", () => {
    const sections = [
      { id: "intro", latex: "本文整理两条路线。" },
      { id: "b", latex: `${MECH_SIMSIAM} ${MECH_BYOL}` },
      { id: "cmp", latex: `在防坍缩手段上，基于负样本的路线以负样本构造对比目标，而 ${MECH_SIMSIAM_RESTATED} 在目标编码器更新上，BYOL 的目标网络以慢速移动平均更新，SimSiam 不需要动量编码器。` },
      { id: "end", latex: "统一评测是未来工作。" },
    ];
    const report = classifyAcademicRedundancy(sections, { roles: { intro: "framing", b: "develop", cmp: "compare", end: "conclude" } });
    const verbatim = report.pairs.find((p) => p.rule === "R7v");
    expect(verbatim).toBeDefined();
    expect(verbatim?.class).toBe("X");
    expect(verbatim?.harmful).toBe(true);
    expect(verbatim?.pair.containment).toBeGreaterThanOrEqual(0.8);
    const reminders = report.pairs.filter((p) => p.rule === "R7");
    expect(reminders.every((p) => !p.harmful)).toBe(true);
    // 提高逐字阈值后同一 pair 落入灰区
    const relaxed = classifyAcademicRedundancy(sections, {
      roles: { intro: "framing", b: "develop", cmp: "compare", end: "conclude" },
      thresholds: { verbatimContainment: 0.95, uncertainContainment: 0.7, uncertainJaccard: 0.3 },
    });
    expect(relaxed.thresholds.verbatimContainment).toBe(0.95);
    expect(relaxed.pairs.some((p) => p.rule === "R7u")).toBe(true);
    expect(relaxed.summary.harmful.sentenceCount).toBeLessThan(report.summary.harmful.sentenceCount + 1);
  });

  it("结论（E → M）：一句概括不计有害；对 ≥ 2 条机制逐一复述升级为 M", () => {
    const base = [
      { id: "intro", latex: "本文整理两条路线。" },
      { id: "a", latex: `SimCLR 的三项发现按引文说明。${MECH_SIMSIAM}` },
      { id: "b", latex: MECH_BYOL },
      { id: "cmp", latex: "两条路线在负样本依赖与防坍缩手段上不同，数值来自不同设置不能排序。" },
    ];
    const oneEcho = classifyAcademicRedundancy(
      [...base, { id: "end", latex: `两条路线的差别在于约束来源：${MECH_BYOL_RESTATED}` }],
      { roles: ROLES },
    );
    expect(oneEcho.pairs.filter((p) => p.laterRole === "conclude").every((p) => p.class === "E" && !p.harmful)).toBe(true);
    const enumerating = classifyAcademicRedundancy(
      [...base, { id: "end", latex: `${MECH_BYOL_RESTATED} ${MECH_SIMSIAM_RESTATED}` }],
      { roles: ROLES },
    );
    const m = enumerating.pairs.filter((p) => p.rule === "R8m");
    expect(m.length).toBeGreaterThanOrEqual(2);
    expect(enumerating.harmfulSentences.filter((s) => s.section === "end" && s.class === "M")).toHaveLength(2);
  });

  it("误报（F）：短标签句被长句包含、Jaccard 低，不计有害", () => {
    const report = classifyAcademicRedundancy(
      [
        { id: "intro", latex: "本文整理两条路线。二是无负样本的孪生方法，以 BYOL 与 SimSiam 为代表。" },
        { id: "b", latex: MECH_BYOL },
        { id: "end", latex: "无负样本的孪生方法（BYOL、SimSiam）则摆脱负样本对，转而依靠在线网络与目标网络的预测关系及慢速移动平均更新，或以停止梯度防止表示坍缩。" },
      ],
      { roles: { intro: "framing", b: "develop", end: "conclude" } },
    );
    const f = report.pairs.find((p) => p.class === "F");
    expect(f).toBeDefined();
    expect(f?.rule).toBe("R3");
    expect(f?.harmful).toBe(false);
    expect(report.harmfulSentences.some((s) => s.section === "intro")).toBe(false);
    expect(countUnits("SimSiam 在 ImageNet 及下游任务上取得了有竞争力的结果")).toBeLessThan("SimSiam 在 ImageNet 及下游任务上取得了有竞争力的结果".replace(/\s/g, "").length);
  });

  it("develop 节首带对照标记的承接句视同必要提醒（R5），不记有害", () => {
    const report = classifyAcademicRedundancy(
      [
        { id: "intro", latex: "本文整理两条路线。基于负样本的对比框架通过拉近同一图像不同增广视图的表示、并与其他样本的表示保持区分来学习特征。" },
        { id: "a", latex: "基于负样本的对比方法拉近同一图像不同增广视图的表示，并借助负样本与其他图像的表示保持区分。SimCLR 不依赖专用结构。" },
        { id: "b", latex: "与基于负样本的对比框架不同，另一条路线完全不依赖负样本，而是以孪生网络拉近同一图像不同增广视图的表示。" },
        { id: "end", latex: "统一评测是未来工作。" },
      ],
      { roles: { intro: "framing", a: "develop", b: "develop", end: "conclude" } },
    );
    const transition = report.pairs.find((p) => p.pair.later.section === "b" && p.pair.later.index === 0);
    expect(transition?.rule).toBe("R5");
    expect(transition?.harmful).toBe(false);
    // a#0 对引言句的 pair 仍是 P（引言预展开）
    expect(report.pairs.some((p) => p.class === "P" && p.pair.earlier.section === "intro")).toBe(true);
  });

  it("角色推断：首节 framing、末节 conclude、「综合比较与局限性」compare；「基于负样本的对比框架」不是比较节；显式角色优先", () => {
    const roles = inferSectionRoles([
      { id: "introduction", title: "引言" },
      { id: "contrastive", title: "基于负样本的对比框架" },
      { id: "noncontrastive", title: "无负样本的孪生方法" },
      { id: "comparison", title: "综合比较与局限性" },
      { id: "conclusion", title: "结论与展望" },
    ]);
    expect(roles).toEqual({ introduction: "framing", contrastive: "develop", noncontrastive: "develop", comparison: "compare", conclusion: "conclude" });
    const overridden = classifyAcademicRedundancy([{ id: "x", title: "综合比较", latex: "一句。" }, { id: "y", latex: "另一句。" }], { roles: { x: "develop" } });
    expect(overridden.roles.x).toBe("develop");
    expect(overridden.roles.y).toBe("conclude");
  });

  it("路标分析是确定性的：交叉引用谓语收尾、占比与剩余字符都回显", () => {
    const tail = analyzeSignpost("不依赖负样本的替代路线将在「无负样本的孪生方法」一节展开。");
    expect(tail.signpost).toBe(true);
    expect(tail.endsWithCrossReference).toBe(true);
    expect(tail.spans[0]).toContain("「无负样本的孪生方法」一节展开");
    const mixed = analyzeSignpost("与「基于负样本的对比框架」一节中的方法相对照，两条路线的核心差异在于是否需要负样本构造对比目标，相关讨论见「综合比较与局限性」一节。");
    expect(mixed.signpost).toBe(true);
    expect(mixed.share).toBeGreaterThanOrEqual(0.5);
    expect(isSignpostSentence("SimSiam 的实验表明停止梯度操作在防止坍缩中起关键作用。")).toBe(false);
    expect(isSignpostSentence("如前所述，LoRA 冻结预训练权重。")).toBe(true);
    // 必要引用 / 数值 / 科学限制不会被当成路标
    expect(isSignpostSentence("线性分类器取得 76.5\\% 的 top-1 准确率，本综述未进行统一复现，不能据此给出性能排序。")).toBe(false);
  });

  it("转义百分号与引用不影响分类层：`\\%` 之后的句子仍被分析，cite 不制造伪共享", () => {
    const report = classifyAcademicRedundancy(
      [
        { id: "intro", latex: "本文整理两条路线。" },
        { id: "a", latex: "SimCLR 线性评测取得 76.5\\% 的 top-1 准确率\\cite{chen2020simclr}。该结果与有监督 ResNet-50 相当\\cite{chen2020simclr}。" },
        { id: "cmp", latex: "SimCLR 线性评测取得 76.5\\% 的 top-1 准确率\\cite{chen2020simclr}，BYOL 为 74.3\\%\\cite{grill2020byol}，但二者设置不同，不能据此排序。" },
        { id: "end", latex: "统一评测是未来工作。" },
      ],
      { roles: { intro: "framing", a: "develop", cmp: "compare", end: "conclude" } },
    );
    expect(report.summary.sentenceCount).toBeGreaterThanOrEqual(5);
    expect(report.pairs.length).toBeGreaterThanOrEqual(1);
    expect(report.pairs[0]?.pair.later.text).toContain("76.5%");
    // 不是因为 \cite 而配对：去掉 cite 后共享 token 仍 ≥ 阈值
    expect(report.pairs[0]?.pair.shared).toBeGreaterThanOrEqual(6);
  });
});
