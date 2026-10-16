/**
 * M14.6 学位论文摘要生成：提示词渲染 / 输出解析 / 确定性事实门禁 / 一次修复循环。
 * 全部不触模型——AgentRuntime 用脚本化假实现。
 */

import { describe, expect, it } from "vitest";

import { BusinessError } from "../../src/errors.js";
import type { FactView } from "../../src/thesis/researchInputTypes.js";
import {
  ThesisAbstractService,
  buildThesisAbstractPrompt,
  checkThesisAbstractFacts,
  extractAbstractNumbers,
  parseThesisAbstractOutput,
  type ThesisAbstractDraft,
  type ThesisAbstractInput,
} from "../../src/thesis/thesisAbstract.js";
import { runtimeFromScript } from "../helpers/fakeRuntime.js";

function fact(overrides: Partial<FactView> = {}): FactView {
  return {
    factId: "f-0001",
    researchInputId: "ri-000000000001",
    kind: "metric",
    key: { dataset: "DUTS-TE", metric: "F-measure" },
    surface: "F-measure 75.37%",
    value: { raw: "75.37%", numeric: 75.37, unit: "%", normalized: "75.37 %" },
    verification: "author_confirmed",
    sourceCheck: "verified",
    conflictStatus: "none",
    location: "论文A 表3 行2",
    ...overrides,
  };
}

const METHOD_BODY = [
  "\\section{方法设计}",
  "本章提出面向视频显著性检测的时序一致性约束模块，在特征层对相邻帧施加一致性约束。",
  "该模块由三个子部件构成：时序对齐、注意力聚合与残差融合。",
].join("\n");

const EXPERIMENT_BODY = [
  "\\section{实验与分析}",
  "在 DUTS-TE 数据集上，本文方法的 F-measure 达到 75.37\\%，优于基线方法~\\cite{baseline2021}。",
  "训练共进行 30 个轮次，批大小为 8。",
  "表~\\ref{tab:main} 给出了完整对比结果。",
].join("\n");

function buildInput(overrides: Partial<ThesisAbstractInput> = {}): ThesisAbstractInput {
  return {
    projectTitle: "基于时序一致性约束的视频显著性检测研究",
    documentType: "master_thesis",
    language: "zh",
    storyline: {
      narrative: "围绕视频显著性检测中的时序一致性问题，提出一致性约束模块并在公开数据集上验证其有效性。",
      structure: "progressive",
      relations: [],
      contributionsOrder: ["c-0001"],
    },
    chapters: [
      {
        chapterId: "ch01",
        titleZh: "绪论",
        responsibility: "introduction",
        goal: "提出研究问题",
        sectionFiles: ["introduction.tex"],
        ownsContributionIds: [],
        referencesContributionIds: ["c-0001"],
        sourceInputIds: [],
        factIds: [],
      },
      {
        chapterId: "ch02",
        titleZh: "时序一致性约束方法",
        responsibility: "method",
        goal: "阐述一致性约束模块的设计",
        sectionFiles: ["method.tex"],
        ownsContributionIds: ["c-0001"],
        referencesContributionIds: [],
        sourceInputIds: ["ri-000000000001"],
        factIds: [],
      },
      {
        chapterId: "ch03",
        titleZh: "实验与分析",
        responsibility: "experiment",
        goal: "在公开数据集上验证方法",
        sectionFiles: ["experiment.tex"],
        ownsContributionIds: [],
        referencesContributionIds: ["c-0001"],
        sourceInputIds: ["ri-000000000001"],
        factIds: ["f-0001"],
      },
      {
        chapterId: "ch04",
        titleZh: "跨域泛化实验",
        responsibility: "experiment",
        goal: "验证方法在跨域场景下的泛化能力",
        sectionFiles: ["generalization.tex"],
        ownsContributionIds: [],
        referencesContributionIds: ["c-0001"],
        sourceInputIds: [],
        factIds: [],
        missingMaterials: ["跨域实验尚未开展，无可用数据"],
        limitationMode: true,
      },
    ],
    contributions: [{ id: "c-0001", kind: "method", statement: "提出时序一致性约束模块，提升视频显著性检测的帧间稳定性" }],
    confirmedFacts: [fact()],
    sections: [
      { file: "introduction.tex", chapterId: "ch01", title: "绪论", content: "\\section{绪论}\n视频显著性检测是计算机视觉的基础任务之一。" },
      { file: "method.tex", chapterId: "ch02", title: "方法设计", content: METHOD_BODY },
      { file: "experiment.tex", chapterId: "ch03", title: "实验与分析", content: EXPERIMENT_BODY },
      {
        file: "generalization.tex",
        chapterId: "ch04",
        title: "跨域泛化实验",
        content: "\\section{跨域泛化实验}\n由于材料缺失，本章的跨域实验尚未开展，仅给出实验设计与预期分析框架。",
      },
    ],
    ...overrides,
  };
}

/** 中文填充句（无数字），把摘要撑到门禁下限以上 */
const ZH_FILLER =
  "视频显著性检测旨在从连续视频帧中定位最吸引人类视觉注意的区域，是视频理解与编辑的基础任务。现有方法在处理快速运动与遮挡时常出现帧间预测抖动，影响下游应用的稳定性。";
const EN_FILLER =
  "Video salient object detection aims to locate the regions that attract human visual attention in consecutive frames and serves as a basis for video understanding and editing. Existing methods often suffer from frame-to-frame prediction jitter under fast motion and occlusion, which harms the stability of downstream applications.";

function zhAbstract(core: string): string {
  return `${ZH_FILLER}${core}${ZH_FILLER}本文的工作为后续研究提供了参考。`;
}

function enAbstract(core: string): string {
  return `${EN_FILLER} ${core} ${EN_FILLER} This work provides a reference for future research in this direction.`;
}

const ZH_CORE_OK =
  "针对该问题，本文提出时序一致性约束模块，在特征层对相邻帧施加一致性约束，由时序对齐、注意力聚合与残差融合三个子部件构成。在 DUTS-TE 数据集上，本文方法的 F-measure 达到 75.37%，优于基线方法。跨域泛化实验因材料缺失尚未开展，留待后续工作。";
const EN_CORE_OK =
  "To address this problem, this thesis proposes a temporal consistency constraint module that enforces consistency between adjacent frames at the feature level, consisting of temporal alignment, attention aggregation and residual fusion. On the DUTS-TE dataset, the proposed method achieves an F-measure of 75.37%, outperforming the baseline. The cross-domain generalization experiment has not been conducted due to missing materials and is left for future work.";

function cleanDraft(overrides: Partial<ThesisAbstractDraft> = {}): ThesisAbstractDraft {
  return {
    abstractZh: zhAbstract(ZH_CORE_OK),
    abstractEn: enAbstract(EN_CORE_OK),
    keywordsZh: ["视频显著性检测", "时序一致性", "注意力聚合"],
    keywordsEn: ["video salient object detection", "temporal consistency", "attention aggregation"],
    ...overrides,
  };
}

describe("M14.6 thesisAbstract 提示词", () => {
  it("包含已确认事实表、受限章节指令、输出契约与既有摘要更新指令", () => {
    const prompt = buildThesisAbstractPrompt(
      buildInput({ existing: { abstractZh: "旧摘要内容", keywordsZh: ["旧关键词一", "旧关键词二", "旧关键词三"] } }),
    );
    expect(prompt).toContain("学位论文摘要撰写");
    expect(prompt).toContain("已确认科研事实表");
    expect(prompt).toContain("F-measure 75.37%");
    expect(prompt).toContain("数据集=DUTS-TE");
    expect(prompt).toContain("受限模式章节");
    expect(prompt).toContain("跨域泛化实验");
    expect(prompt).toContain("未开展 / 受限");
    expect(prompt).toContain("400–800 字（硕士学位论文）");
    expect(prompt).toContain('{"abstractZh":"...","abstractEn":"...","keywordsZh":["...","..."],"keywordsEn":["...","..."]}');
    expect(prompt).toContain("在此基础上更新");
    expect(prompt).toContain("旧摘要内容");
    // 正文投影：LaTeX 已剥离，事实句被摘入
    expect(prompt).toContain("F-measure 达到 75.37%");
    expect(prompt).not.toContain("\\cite");
  });

  it("博士论文给出 600–1200 字目标；无事实时禁止出现数值", () => {
    const prompt = buildThesisAbstractPrompt(buildInput({ documentType: "doctoral_thesis", confirmedFacts: [] }));
    expect(prompt).toContain("600–1200 字（博士学位论文）");
    expect(prompt).toContain("摘要不得出现任何具体实验数值");
  });
});

describe("M14.6 thesisAbstract 输出解析", () => {
  it("接受带代码围栏的合法 JSON", () => {
    const draft = parseThesisAbstractOutput(
      '```json\n{"abstractZh":"中文","abstractEn":"English","keywordsZh":["a","b","c"],"keywordsEn":["x","y","z"]}\n```',
    );
    expect(draft.abstractZh).toBe("中文");
    expect(draft.keywordsEn).toEqual(["x", "y", "z"]);
  });

  it("缺少字段 / 非数组关键词 / 非 JSON → STAGE_CONTRACT_VIOLATION", () => {
    const expectViolation = (raw: string) => {
      try {
        parseThesisAbstractOutput(raw);
        throw new Error("expected throw");
      } catch (error) {
        expect(error).toBeInstanceOf(BusinessError);
        expect((error as BusinessError).code).toBe("STAGE_CONTRACT_VIOLATION");
      }
    };
    expectViolation('{"abstractZh":"中文","keywordsZh":["a"],"keywordsEn":["x"]}');
    expectViolation('{"abstractZh":"中文","abstractEn":"en","keywordsZh":"a","keywordsEn":["x"]}');
    expectViolation("这不是 JSON");
  });
});

describe("M14.6 thesisAbstract 数值 token 化", () => {
  it("忽略年份、章节序号与小计数整数，保留实验数值", () => {
    expect(extractAbstractNumbers("2023 年提出；第3章与 5 个子模块；共 30 个轮次；准确率 75.37%，损失 -0.5；CIFAR-10")).toEqual([
      "30",
      "75.37%",
      "-0.5",
      "10",
    ]);
  });
});

describe("M14.6 thesisAbstract 确定性门禁", () => {
  it("一致的双语摘要（75.37% 同时在正文与事实表中）通过", () => {
    const result = checkThesisAbstractFacts(cleanDraft(), buildInput());
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("编造的 62.4% → number_not_in_facts_or_body（中英文各一条）", () => {
    const draft = cleanDraft({
      abstractZh: zhAbstract(ZH_CORE_OK.replace("75.37%", "62.4%")),
      abstractEn: enAbstract(EN_CORE_OK.replace("75.37%", "62.4%")),
    });
    const result = checkThesisAbstractFacts(draft, buildInput());
    expect(result.ok).toBe(false);
    const fabricated = result.violations.filter((v) => v.code === "number_not_in_facts_or_body");
    expect(fabricated).toHaveLength(2);
    expect(fabricated.every((v) => v.token === "62.4%")).toBe(true);
    expect(result.violations.some((v) => v.code === "zh_en_number_mismatch")).toBe(false);
  });

  it("数值只在事实表而不在正文 → advisory number_not_in_body（不阻断）", () => {
    const input = buildInput({
      sections: buildInput().sections.map((s) => (s.file === "experiment.tex" ? { ...s, content: "\\section{实验与分析}\n本文方法优于基线。" } : s)),
    });
    const result = checkThesisAbstractFacts(cleanDraft(), input);
    expect(result.ok).toBe(true);
    expect(result.advisories.some((a) => a.code === "number_not_in_body" && a.token === "75.37%")).toBe(true);
  });

  it("中文 75.37% / 英文 75% → zh_en_number_mismatch", () => {
    const draft = cleanDraft({ abstractEn: enAbstract(EN_CORE_OK.replace("75.37%", "75%")) });
    const result = checkThesisAbstractFacts(draft, buildInput());
    expect(result.ok).toBe(false);
    const mismatch = result.violations.filter((v) => v.code === "zh_en_number_mismatch");
    expect(mismatch.map((v) => v.token).sort()).toEqual(["75%", "75.37%"]);
  });

  it("受限章节被写成已完成 → limitation_chapter_claimed_done", () => {
    const core = ZH_CORE_OK.replace("跨域泛化实验因材料缺失尚未开展，留待后续工作。", "跨域泛化实验验证了方法在跨域场景下同样有效。");
    const result = checkThesisAbstractFacts(cleanDraft({ abstractZh: zhAbstract(core) }), buildInput());
    const hit = result.violations.find((v) => v.code === "limitation_chapter_claimed_done");
    expect(hit).toBeDefined();
    expect(hit?.token).toBe("跨域泛化实验");
  });

  it("已完成 + 未来 同句 → future_work_as_done", () => {
    const core = `${ZH_CORE_OK}跨域实验已完成并将在未来进一步扩展。`;
    const result = checkThesisAbstractFacts(cleanDraft({ abstractZh: zhAbstract(core) }), buildInput());
    expect(result.violations.some((v) => v.code === "future_work_as_done")).toBe(true);
  });

  it("「本文提出」与任何已确认贡献无重叠 → advisory third_party_as_own", () => {
    const core = `${ZH_CORE_OK}本文提出基于光流扭曲的帧间传播策略。`;
    const result = checkThesisAbstractFacts(cleanDraft({ abstractZh: zhAbstract(core) }), buildInput());
    expect(result.advisories.some((a) => a.code === "third_party_as_own")).toBe(true);
    // 与贡献陈述重叠的「本文提出」句不报
    expect(checkThesisAbstractFacts(cleanDraft(), buildInput()).advisories.some((a) => a.code === "third_party_as_own")).toBe(false);
  });

  it("LaTeX 命令与内部流程措辞 → latex_in_abstract / meta_note", () => {
    const draft = cleanDraft({
      abstractZh: zhAbstract(`${ZH_CORE_OK}该结果见 \\textbf{表 3}，待作者确认。`),
    });
    const result = checkThesisAbstractFacts(draft, buildInput());
    expect(result.violations.some((v) => v.code === "latex_in_abstract" && v.token === "\\textbf")).toBe(true);
    expect(result.violations.some((v) => v.code === "meta_note" && v.token === "待作者确认")).toBe(true);
    const workflow = checkThesisAbstractFacts(cleanDraft({ abstractEn: enAbstract(`${EN_CORE_OK} Generated by the Workflow.`) }), buildInput());
    expect(workflow.violations.some((v) => v.code === "meta_note")).toBe(true);
  });

  it("关键词数量 / 数字关键词 / 未落地关键词", () => {
    const tooFew = checkThesisAbstractFacts(cleanDraft({ keywordsZh: ["视频显著性检测", "时序一致性"] }), buildInput());
    expect(tooFew.violations.some((v) => v.code === "keyword_count" && v.detail.includes("中文"))).toBe(true);
    const tooMany = checkThesisAbstractFacts(
      cleanDraft({ keywordsEn: ["a", "b", "c", "d", "e", "f", "g"] }),
      buildInput(),
    );
    expect(tooMany.violations.some((v) => v.code === "keyword_count" && v.detail.includes("英文"))).toBe(true);
    const numeric = checkThesisAbstractFacts(cleanDraft({ keywordsZh: ["视频显著性检测", "时序一致性", "75.37%"] }), buildInput());
    expect(numeric.violations.some((v) => v.code === "keyword_not_grounded" && v.token === "75.37%")).toBe(true);
    const ungrounded = checkThesisAbstractFacts(cleanDraft({ keywordsZh: ["视频显著性检测", "时序一致性", "神经网络下洗预测"] }), buildInput());
    expect(ungrounded.ok).toBe(true);
    expect(ungrounded.advisories.some((a) => a.code === "keyword_not_grounded" && a.token === "神经网络下洗预测")).toBe(true);
  });

  it("长度越界 → length", () => {
    const short = checkThesisAbstractFacts(cleanDraft({ abstractZh: "太短的摘要。", abstractEn: "Too short." }), buildInput());
    expect(short.violations.filter((v) => v.code === "length")).toHaveLength(2);
  });
});

describe("M14.6 ThesisAbstractService.generate", () => {
  const fabricated = JSON.stringify(cleanDraft({
    abstractZh: zhAbstract(ZH_CORE_OK.replace("75.37%", "62.4%")),
    abstractEn: enAbstract(EN_CORE_OK.replace("75.37%", "62.4%")),
  }));
  const clean = JSON.stringify(cleanDraft());

  it("首轮编造数值 → 修复一次 → 通过（attempts=2，修复提示词含违规清单）", async () => {
    const prompts: string[] = [];
    const runtime = runtimeFromScript((input) => {
      prompts.push(input.task);
      return prompts.length === 1 ? fabricated : clean;
    });
    const service = new ThesisAbstractService({ runtime, agentId: "writer" });
    const result = await service.generate(buildInput(), { projectId: "p1" });
    expect(result.attempts).toBe(2);
    expect(result.violations).toEqual([]);
    expect(result.taskIds).toHaveLength(2);
    expect(result.draft.abstractZh).toContain("75.37%");
    expect(prompts[1]).toContain("修复以下问题，不得引入新数值");
    expect(prompts[1]).toContain("number_not_in_facts_or_body");
    expect(prompts[1]).toContain("62.4%");
  });

  it("修复后仍违规 → 返回违规清单（attempts=2，不静默改数）", async () => {
    const runtime = runtimeFromScript(() => fabricated);
    const service = new ThesisAbstractService({ runtime, agentId: "writer" });
    const result = await service.generate(buildInput(), { projectId: "p1" });
    expect(result.attempts).toBe(2);
    expect(result.violations.some((v) => v.code === "number_not_in_facts_or_body" && v.token === "62.4%")).toBe(true);
    expect(result.draft.abstractZh).toContain("62.4%");
  });

  it("maxRepairAttempts=0 → 只调用一次", async () => {
    let calls = 0;
    const runtime = runtimeFromScript(() => {
      calls += 1;
      return fabricated;
    });
    const service = new ThesisAbstractService({ runtime, agentId: "writer" });
    const result = await service.generate(buildInput(), { projectId: "p1", maxRepairAttempts: 0 });
    expect(calls).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("首轮输出不可解析 → 修复轮给出合法 JSON → 通过", async () => {
    let calls = 0;
    const runtime = runtimeFromScript(() => {
      calls += 1;
      return calls === 1 ? "抱歉，我无法输出。" : clean;
    });
    const service = new ThesisAbstractService({ runtime, agentId: "writer" });
    const result = await service.generate(buildInput(), { projectId: "p1" });
    expect(result.attempts).toBe(2);
    expect(result.violations).toEqual([]);
  });

  it("两轮都不可解析 → 抛 STAGE_CONTRACT_VIOLATION", async () => {
    const runtime = runtimeFromScript(() => "没有 JSON");
    const service = new ThesisAbstractService({ runtime, agentId: "writer" });
    await expect(service.generate(buildInput(), { projectId: "p1" })).rejects.toMatchObject({ code: "STAGE_CONTRACT_VIOLATION" });
  });
});
