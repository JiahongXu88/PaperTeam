/**
 * M13.7.10 Argument Unit Contract 测试：
 * - 旧 Outline（无 argument）全部由位置 / 标题确定性派生；中英文标题；
 * - 「对比学习」类标题不是 compare；comparison / 讨论 / 局限 是 compare；
 * - 歧义标题降级为 develop 并报告（不猜测）；
 * - Survey 语境：future → conclude；gap → compare；compare 标题但 taxonomy refs → develop 降级；
 *   comparison synthesis 的维度进入 compare 任务；
 * - 显式 argument.role 优先；planner task 追加而不替换模板；
 * - doNotExplain 由 owner 派生且不含「见 X 一节」路标；限制 owner = compare（无 compare 时 conclude）；
 * - 长度：outline 上限 > 目标 > 角色缺省；framing / conclude 受角色封顶，显式上限不封顶；
 * - Planner 字段宽容解析：非法 role / 非 canonical evidenceIds / Survey 中的 evidenceIds 丢弃并诊断；
 * - Outline 校验与归一：非法形状被拒；保存 / 重载一致；空 argument 不写入；
 * - 渲染：B2 冻结措辞、无路标、上限长度行；未启用时「约 N 字」逐字不变。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  ARGUMENT_CROSS_SECTION_POLICY,
  ARGUMENT_LENGTH_POLICY,
  ARGUMENT_UNIT_BLOCK_HEADER,
  normalizeOutlineArgument,
  parseOutlineArgument,
  renderArgumentUnitLines,
  renderBibliographyIdentityLines,
  renderTargetLengthLine,
  resolveArgumentUnits,
  validateOutlineArgument,
} from "../../src/writer/argumentUnit.js";
import { ManuscriptService, validateOutline, normalizeOutlineRefs, type Outline } from "../../src/manuscript/ManuscriptService.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import type { SurveySynthesisArtifact, SurveySynthesisItem } from "../../src/survey/synthesisTypes.js";

const NOW = "2026-10-12T00:00:00.000Z";

function outlineOf(sections: Array<Partial<Outline["sections"][number]> & { id: string; title: string }>): Outline {
  return {
    title: "测试大纲",
    sections: sections.map((section) => ({ file: `${section.id}.tex`, ...section })),
  };
}

const QEC_OUTLINE = outlineOf([
  { id: "introduction", title: "引言", targetLengthWords: 350, keyPoints: ["界定范围"] },
  { id: "surface", title: "表面码逻辑量子比特的规模扩展", targetLengthWords: 350, keyPoints: ["距离 5 码略优于距离 3 码"] },
  { id: "breakeven", title: "突破盈亏平衡的逻辑量子比特实验", targetLengthWords: 350, keyPoints: ["G=2.27"] },
  { id: "comparison", title: "综合比较与局限性", targetLengthWords: 350, keyPoints: ["沿四个维度比较"] },
  { id: "conclusion", title: "结论与展望", targetLengthWords: 350, keyPoints: ["两条路线的关系"] },
]);

describe("resolveArgumentUnits：角色推断", () => {
  it("旧 Outline（无 argument）：引言 framing / 主体 develop / 比较 compare / 结论 conclude", () => {
    const units = resolveArgumentUnits({ outline: QEC_OUTLINE });
    expect(units.map((unit) => unit.role)).toEqual(["framing", "develop", "develop", "compare", "conclude"]);
    expect(units.map((unit) => unit.roleSource)).toEqual(["title", "position", "position", "title", "title"]);
    expect(units.every((unit) => unit.roleConfidence === "inferred")).toBe(true);
    expect(units[3]!.limitationOwner).toBe(true);
    expect(units.filter((unit) => unit.limitationOwner)).toHaveLength(1);
  });

  it("英文标题同样推断；首节 / 末节按位置兜底", () => {
    const units = resolveArgumentUnits({
      outline: outlineOf([
        { id: "intro", title: "Introduction" },
        { id: "methods", title: "Methods" },
        { id: "exp", title: "Experiments" },
        { id: "disc", title: "Discussion and Limitations" },
        { id: "concl", title: "Conclusion" },
      ]),
    });
    expect(units.map((unit) => unit.role)).toEqual(["framing", "develop", "develop", "compare", "conclude"]);
    const noTitles = resolveArgumentUnits({
      outline: outlineOf([
        { id: "a", title: "第一部分" },
        { id: "b", title: "第二部分" },
        { id: "c", title: "第三部分" },
      ]),
    });
    expect(noTitles.map((unit) => unit.role)).toEqual(["framing", "develop", "conclude"]);
    expect(noTitles.map((unit) => unit.roleSource)).toEqual(["position", "position", "position"]);
  });

  it("「对比学习」「对比实验设置」不是 compare；含「分析」的章节不被一律判为 compare", () => {
    const units = resolveArgumentUnits({
      outline: outlineOf([
        { id: "intro", title: "引言" },
        { id: "contrastive", title: "基于负样本的对比学习框架" },
        { id: "setup", title: "对比实验设置" },
        { id: "analysis", title: "误差分析" },
        { id: "end", title: "结论" },
      ]),
    });
    expect(units.map((unit) => unit.role)).toEqual(["framing", "develop", "develop", "develop", "conclude"]);
  });

  it("歧义标题（框架 + 比较语义同现）降级为 develop 并报告，不猜测", () => {
    const units = resolveArgumentUnits({
      outline: outlineOf([
        { id: "intro", title: "引言" },
        { id: "mixed", title: "背景与讨论" },
        { id: "end", title: "结论" },
      ]),
    });
    expect(units[1]!.role).toBe("develop");
    expect(units[1]!.roleConfidence).toBe("ambiguous_fallback");
    expect(units[1]!.warnings[0]).toContain("无法确定");
  });

  it("显式 argument.role 优先于推断", () => {
    const outline = outlineOf([
      { id: "intro", title: "引言" },
      { id: "x", title: "方法", argument: { role: "compare" } },
      { id: "end", title: "结论" },
    ]);
    const units = resolveArgumentUnits({ outline });
    expect(units[1]!.role).toBe("compare");
    expect(units[1]!.roleSource).toBe("outline");
    expect(units[1]!.roleConfidence).toBe("explicit");
  });

  it("没有 compare 节时限制 owner 落到 conclude；没有 conclude 也没有 compare 时无人承担（不强加）", () => {
    const units = resolveArgumentUnits({
      outline: outlineOf([
        { id: "intro", title: "引言" },
        { id: "m", title: "方法" },
        { id: "end", title: "结论" },
      ]),
    });
    expect(units.find((unit) => unit.limitationOwner)?.sectionId).toBe("end");
    expect(units[1]!.doNotExplain.some((concept) => concept.includes("限制的集中陈述"))).toBe(true);
  });
});

function synItem(id: string, kind: SurveySynthesisItem["kind"], detail?: SurveySynthesisItem["detail"]): SurveySynthesisItem {
  return {
    synthesisId: id,
    kind,
    claim: `综合结论 ${id}`,
    groundingLevel: "literature_cited",
    evidenceIds: [],
    sourceIds: ["S001"],
    derivedFrom: { entryIds: ["M-S001"] },
    ...(detail !== undefined ? { detail } : {}),
    updatedAt: NOW,
  };
}

const SYNTHESIS: SurveySynthesisArtifact = {
  schemaVersion: 1,
  updatedAt: NOW,
  matrixFingerprint: "fp",
  items: [
    synItem("SYN-tax0000001", "taxonomy", { kind: "taxonomy", family: "surface_code" }),
    synItem("SYN-cmp0000001", "comparison", { kind: "comparison", dimension: "encoding carrier and scale", sides: [] }),
    synItem("SYN-cmp0000002", "comparison", { kind: "comparison", dimension: "metric convention", sides: [] }),
    synItem("SYN-gap0000001", "research_gap", { kind: "research_gap", trigger: "literature_limitation", basis: "x" }),
    synItem("SYN-fut0000001", "future_direction", { kind: "future_direction", origin: "inferred" }),
  ],
};

describe("resolveArgumentUnits：Survey 语境", () => {
  it("future 章节 → conclude；gap 章节 → compare；comparison refs 的维度进入 compare 任务", () => {
    const outline = outlineOf([
      { id: "introduction", title: "引言" },
      { id: "families", title: "方法体系", synthesisRefs: ["SYN-tax0000001"] },
      { id: "trends", title: "跨方法综合分析", synthesisRefs: ["SYN-cmp0000001", "SYN-cmp0000002"] },
      { id: "gaps", title: "研究空缺", synthesisRefs: ["SYN-gap0000001"] },
      { id: "future", title: "未来方向", synthesisRefs: ["SYN-fut0000001"] },
    ]);
    const units = resolveArgumentUnits({ outline, synthesis: SYNTHESIS });
    expect(units.map((unit) => unit.role)).toEqual(["framing", "develop", "compare", "compare", "conclude"]);
    expect(units[2]!.task).toContain("「encoding carrier and scale」「metric convention」");
    expect(units[4]!.roleSource).toBe("survey_context");
    // 限制 owner：绑定 research_gap synthesis 的章节（不是第一个 compare）
    expect(units.filter((unit) => unit.limitationOwner).map((unit) => unit.sectionId)).toEqual(["gaps"]);
  });

  it("绑定 research_gap synthesis 的章节成为限制 owner（compare 不再集中陈述限制）", () => {
    const outline = outlineOf([
      { id: "introduction", title: "引言" },
      { id: "families", title: "方法体系", synthesisRefs: ["SYN-tax0000001"] },
      { id: "compare", title: "跨路线对照", synthesisRefs: ["SYN-cmp0000001"] },
      { id: "limits", title: "局限与未来方向", synthesisRefs: ["SYN-gap0000001", "SYN-fut0000001"], argument: { role: "conclude" } },
      { id: "end", title: "结论" },
    ]);
    const units = resolveArgumentUnits({ outline, synthesis: SYNTHESIS });
    expect(units.map((unit) => unit.limitationOwner)).toEqual([false, false, false, true, false]);
    expect(units[2]!.task).not.toContain("这是全文唯一集中陈述");
    expect(units[2]!.doNotExplain.some((concept) => concept.includes("由「局限与未来方向」承担"))).toBe(true);
    expect(units[3]!.task).toContain("集中说明真实的研究限制");
    expect(units[4]!.task).toContain("用一句话承接前文已集中说明的限制");
  });

  it("非末节的 conclude（独立的未来方向节）只陈述未来方向，不总结各路线；末节 conclude 仍负责总结", () => {
    const outline = outlineOf([
      { id: "introduction", title: "引言" },
      { id: "families", title: "方法体系", synthesisRefs: ["SYN-tax0000001"] },
      { id: "limits", title: "比较局限与现有证据边界", synthesisRefs: ["SYN-gap0000001"], argument: { role: "compare" } },
      { id: "future", title: "未来方向与展望", synthesisRefs: ["SYN-fut0000001"], argument: { role: "conclude" } },
      { id: "conclusion", title: "结论", argument: { role: "conclude" } },
    ]);
    const units = resolveArgumentUnits({ outline, synthesis: SYNTHESIS });
    expect(units[3]!.task).toContain("本节只陈述未来方向与开放问题");
    expect(units[3]!.task).toContain("不总结各路线 / 方法的机制、结果与关系");
    expect(units[3]!.task).not.toContain("回答全文要回答的问题");
    expect(units[4]!.task).toContain("回答全文要回答的问题");
    expect(units.filter((unit) => unit.limitationOwner).map((unit) => unit.sectionId)).toEqual(["limits"]);
  });

  it("标题含比较语义但绑定 taxonomy synthesis → develop 降级并报告", () => {
    const outline = outlineOf([
      { id: "introduction", title: "引言" },
      { id: "cmp", title: "方法比较", synthesisRefs: ["SYN-tax0000001"] },
      { id: "end", title: "结论" },
    ]);
    const units = resolveArgumentUnits({ outline, synthesis: SYNTHESIS });
    expect(units[1]!.role).toBe("develop");
    expect(units[1]!.roleConfidence).toBe("ambiguous_fallback");
    expect(units[1]!.roleSource).toBe("survey_context");
  });

  it("core 章节只绑定 comparison / consensus 类 synthesis 时按 survey_context 推为 compare", () => {
    const outline = outlineOf([
      { id: "introduction", title: "引言" },
      { id: "fam", title: "方法体系", synthesisRefs: ["SYN-tax0000001"] },
      { id: "core2", title: "两条路线的横向观察", synthesisRefs: ["SYN-cmp0000001"] },
      { id: "end", title: "结论" },
    ]);
    const units = resolveArgumentUnits({ outline, synthesis: SYNTHESIS });
    expect(units[2]!.role).toBe("compare");
    expect(units[2]!.roleSource).toBe("survey_context");
  });
});

describe("resolveArgumentUnits：任务 / doNotExplain / 长度", () => {
  it("doNotExplain 由 owner develop 节派生，不含「见 X 一节」路标；planner task 追加不替换模板", () => {
    const outline = structuredClone(QEC_OUTLINE);
    outline.sections[1]!.argument = { task: "强调 Λ=2.14 的含义", doNotExplain: ["盈亏平衡的定义"] };
    const units = resolveArgumentUnits({ outline });
    const intro = units[0]!;
    expect(intro.doNotExplain).toEqual([
      "「表面码逻辑量子比特的规模扩展」所负责的机制、结果与数值细节",
      "「突破盈亏平衡的逻辑量子比特实验」所负责的机制、结果与数值细节",
      "材料范围、本文实验缺失等限制的集中陈述（由「综合比较与局限性」承担）",
    ]);
    const surface = units[1]!;
    expect(surface.doNotExplain).not.toContain("「表面码逻辑量子比特的规模扩展」所负责的机制、结果与数值细节");
    expect(surface.doNotExplain).toContain("盈亏平衡的定义");
    expect(surface.task).toContain("这是全文唯一完整解释「表面码逻辑量子比特的规模扩展」");
    expect(surface.task).toContain("规划补充：强调 Λ=2.14 的含义");
    expect(surface.taskSource).toBe("template+outline");
    expect(surface.task).toContain("本节要点：距离 5 码略优于距离 3 码");
    for (const unit of units) {
      expect(unit.task).not.toMatch(/见「|将在「|已在「/);
      for (const concept of unit.doNotExplain) expect(concept).not.toMatch(/见「|一节/);
    }
    // compare 任务：B2 五问 + 限制 owner；conclude：不逐一复述、一句承接
    expect(units[3]!.task).toContain("不是第二遍方法描述");
    expect(units[3]!.task).toContain("这是全文唯一集中陈述");
    expect(units[4]!.task).toContain("用一句话承接前文已集中说明的限制");
    expect(units[4]!.task).toContain("不写指向其他章节的句子");
    expect(intro.task).toContain("不解释任何机制细节，不转述任何数值结果");
  });

  it("长度：framing / conclude 受角色封顶，develop / compare 用大纲目标，显式上限不封顶，缺省用角色值", () => {
    const outline = structuredClone(QEC_OUTLINE);
    outline.sections[4]!.argument = { targetLengthUpperBound: 320 };
    delete outline.sections[2]!.targetLengthWords;
    const units = resolveArgumentUnits({ outline });
    expect(units[0]!.targetLengthUpperBound).toBe(260);
    expect(units[0]!.lengthSource).toBe("role_cap");
    expect(units[1]!.targetLengthUpperBound).toBe(350);
    expect(units[1]!.lengthSource).toBe("outline_target");
    expect(units[2]!.targetLengthUpperBound).toBe(400);
    expect(units[2]!.lengthSource).toBe("role_default");
    expect(units[4]!.targetLengthUpperBound).toBe(320);
    expect(units[4]!.lengthSource).toBe("outline_upper_bound");
  });

  it("确定性：同输入恒同结果", () => {
    expect(resolveArgumentUnits({ outline: QEC_OUTLINE })).toEqual(resolveArgumentUnits({ outline: QEC_OUTLINE }));
  });
});

describe("Planner 字段宽容解析 / Outline 校验 / 归一", () => {
  it("合法字段保留；非法 role、非 canonical evidenceIds 逐项丢弃并诊断", () => {
    const parsed = parseOutlineArgument(
      { role: "Develop", task: " 本节任务 ", evidenceIds: ["E003", "E001", "evidence about X", "E001"], doNotExplain: ["A", "", "A"], targetLengthUpperBound: 10 },
      { allowEvidenceIds: true },
    );
    expect(parsed.argument).toEqual({ role: "develop", task: "本节任务", evidenceIds: ["E001", "E003"], doNotExplain: ["A"] });
    expect(parsed.dropped.some((reason) => reason.includes("evidence about X"))).toBe(true);
    expect(parsed.dropped.some((reason) => reason.includes("targetLengthUpperBound"))).toBe(true);
    const bad = parseOutlineArgument({ role: "owner", task: 3 }, { allowEvidenceIds: true });
    expect(bad.argument).toBeUndefined();
    expect(bad.dropped).toHaveLength(2);
    expect(parseOutlineArgument("x", { allowEvidenceIds: true }).dropped[0]).toContain("不是对象");
  });

  it("Survey 大纲中的 evidenceIds 被忽略（证据由 synthesisRefs 投影）", () => {
    const parsed = parseOutlineArgument({ role: "compare", evidenceIds: ["E001"] }, { allowEvidenceIds: false });
    expect(parsed.argument).toEqual({ role: "compare" });
    expect(parsed.dropped[0]).toContain("Survey");
  });

  it("validateOutline：非法 argument 形状被拒，合法 / 缺省通过", () => {
    expect(validateOutlineArgument("s", undefined)).toEqual([]);
    expect(validateOutlineArgument("s", { role: "framing", evidenceIds: ["E001"], targetLengthUpperBound: 200 })).toEqual([]);
    expect(validateOutlineArgument("s", "develop")[0]).toContain("必须是对象");
    expect(validateOutlineArgument("s", { role: "owner" })[0]).toContain("role");
    expect(validateOutlineArgument("s", { evidenceIds: ["", "E1"] })[0]).toContain("evidenceIds");
    expect(validateOutlineArgument("s", { targetLengthUpperBound: 9 })[0]).toContain("targetLengthUpperBound");
    const outline = structuredClone(QEC_OUTLINE);
    (outline.sections[1] as { argument: unknown }).argument = { role: "nope" };
    expect(validateOutline(outline).some((violation) => violation.includes("argument.role"))).toBe(true);
  });

  it("normalize：去重去空；全空 argument 删除键；无 argument 的 Outline 不新增键", () => {
    expect(normalizeOutlineArgument({ evidenceIds: ["E2", " E1 ", "E2"], doNotExplain: [" "], task: "  " })).toEqual({ evidenceIds: ["E1", "E2"] });
    expect(normalizeOutlineArgument({ doNotExplain: [] })).toBeUndefined();
    const outline = structuredClone(QEC_OUTLINE);
    outline.sections[0]!.argument = { doNotExplain: [] };
    const normalized = normalizeOutlineRefs(outline);
    expect("argument" in normalized.sections[0]!).toBe(false);
    expect(normalizeOutlineRefs(QEC_OUTLINE)).toBe(QEC_OUTLINE);
  });
});

describe("保存 / 重载一致（ManuscriptService）", () => {
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  it("带 argument 的 Outline 落盘后重载恒同；旧 Outline 重载后照常解析论证单元", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperteam-argument-"));
    roots.push(root);
    const projects = new ProjectStore({ root });
    const manuscript = new ManuscriptService(projects);
    const project = await projects.create("argument roundtrip");
    const outline = structuredClone(QEC_OUTLINE);
    outline.sections[1]!.argument = { role: "develop", evidenceIds: ["E002", "E001"], task: "任务" };
    const saved = await manuscript.saveOutline(project.id, outline);
    expect(saved.sections[1]!.argument).toEqual({ role: "develop", task: "任务", evidenceIds: ["E001", "E002"] });
    const reloaded = await manuscript.loadOutline(project.id);
    expect(reloaded).toEqual(saved);
    expect(resolveArgumentUnits({ outline: reloaded! })).toEqual(resolveArgumentUnits({ outline: saved }));
    // 旧 Outline：无 argument 字段
    const legacy = await projects.create("legacy outline");
    await manuscript.saveOutline(legacy.id, QEC_OUTLINE);
    const legacyReloaded = await manuscript.loadOutline(legacy.id);
    expect(legacyReloaded!.sections.every((section) => section.argument === undefined)).toBe(true);
    expect(resolveArgumentUnits({ outline: legacyReloaded! }).map((unit) => unit.role)).toEqual(["framing", "develop", "develop", "compare", "conclude"]);
  });
});

describe("渲染", () => {
  it("B2 任务块：角色标签 / 任务 / doNotExplain 概念 / 行为约束 / 长度口径；无路标句；partial 命题与短写提示", () => {
    const units = resolveArgumentUnits({ outline: QEC_OUTLINE });
    const compare = renderArgumentUnitLines(units[3]!, { partialClaims: ["表面码已达到大规模容错所需错误率"] });
    expect(compare[0]).toBe(ARGUMENT_UNIT_BLOCK_HEADER);
    expect(compare[1]).toContain("角色：compare（综合与对照");
    expect(compare.some((line) => line.startsWith("目前证据还不能判断"))).toBe(true);
    expect(compare).toContain("- 表面码已达到大规模容错所需错误率");
    expect(compare.at(-2)).toBe(`跨章节约定：${ARGUMENT_CROSS_SECTION_POLICY}`);
    expect(compare.at(-1)).toBe(`长度口径：${ARGUMENT_LENGTH_POLICY}`);
    expect(compare.join("\n")).not.toMatch(/见「[^」]+」一节/);
    const develop = renderArgumentUnitLines(units[1]!, { evidenceCount: 1 });
    expect(develop.some((line) => line.includes("本节可用正式证据只有 1 条"))).toBe(true);
    const developEnough = renderArgumentUnitLines(units[1]!, { evidenceCount: 5 });
    expect(developEnough.some((line) => line.includes("本节可用正式证据只有"))).toBe(false);
  });

  it("文献身份表只渲染给 framing / conclude，且声明不是内容依据", () => {
    const units = resolveArgumentUnits({ outline: QEC_OUTLINE });
    const bib = [{ key: "ni2022beating", title: "Beating the break-even point with a discrete-variable-encoded logical qubit", year: 2022 }];
    const framing = renderBibliographyIdentityLines(units[0]!, bib);
    expect(framing.some((line) => line.includes("文献身份（只用于按标题点名代表工作；不是内容依据"))).toBe(true);
    expect(framing).toContain("- ni2022beating：Beating the break-even point with a discrete-variable-encoded logical qubit（2022）");
    expect(renderBibliographyIdentityLines(units[4]!, bib).length).toBeGreaterThan(0);
    expect(renderBibliographyIdentityLines(units[1]!, bib)).toEqual([]);
    expect(renderBibliographyIdentityLines(units[3]!, bib)).toEqual([]);
    expect(renderBibliographyIdentityLines(units[0]!, [])).toEqual([]);
    expect(units[0]!.task).toContain("代表工作只按下方「文献身份」所列标题 / 年份点名");
  });

  it("目标长度行：启用时为上限口径，未启用时逐字沿用「约 N 字」", () => {
    const units = resolveArgumentUnits({ outline: QEC_OUTLINE });
    expect(renderTargetLengthLine(QEC_OUTLINE.sections[0]!, units[0]!, 400)).toBe("目标长度：不超过 260 字（上限参考，不是配额）");
    expect(renderTargetLengthLine(QEC_OUTLINE.sections[0]!, undefined, 400)).toBe("目标长度：约 350 字");
    expect(renderTargetLengthLine({ id: "x", file: "x.tex", title: "x" }, undefined, 500)).toBe("目标长度：约 500 字");
  });
});
