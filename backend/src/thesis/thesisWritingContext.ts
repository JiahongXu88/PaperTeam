/**
 * M14.2：分章写作的上下文构建（确定性）。
 *
 * 事实纪律（M14.1b 四类分区的写作口径）：
 *   authorConfirmed            → 「作者已确认事实」表：唯一可写具体数值来源
 *   sourceVerifiedUnconfirmed  → 只能定性提及并标注待确认，数值不得写入
 *   extractedOnly              → 不得进入正文
 *   conflicted                 → 禁止选择任一数值（未裁决）
 *
 * 来源改写（核心章）：注入源文本有界投影，Writer 的任务是「翻译 / 重排 /
 * 衔接」，不是语言扩写；禁止新增数值与结论（M14.0.1 语料结论）。
 */

import type { ResearchFactContext, FactView } from "./researchInputTypes.js";
import type { ThesisChapterPlan } from "./thesisWorkflowTypes.js";
import { documentPlainText } from "./sourceVerification.js";

/** 单节源文本投影预算（字符） */
const SOURCE_PROJECTION_BUDGET = 4_500;
/** 单章事实行上限（防 prompt 爆炸；超出时截断并注明） */
const MAX_FACT_LINES = 30;

export interface ThesisSectionWritingContext {
  /** 拼接到 writeSection extraInstructions 的完整纪律块 */
  extraInstructions: string;
  /** 诊断摘要（stage result 用） */
  summary: {
    chapterId: string;
    responsibility: ThesisChapterPlan["responsibility"];
    authorConfirmedFacts: number;
    sourceVerifiedFacts: number;
    conflictedFacts: number;
    sourceProjectionChars: number;
    limitationMode: boolean;
  };
}

export interface ThesisSectionContextInput {
  chapter: ThesisChapterPlan;
  sectionFile: string;
  sectionTitle: string;
  sectionIndex: number;
  sectionCount: number;
  /** planner 上下文（严格分区） */
  factContext: ResearchFactContext;
  /** 贡献 id → statement（含 owns/references 渲染） */
  contributionStatements: ReadonlyMap<string, { statement: string; kind: string }>;
  /** 章级来源文本投影（已按节分窗；无来源章为 null） */
  sourceProjection: string | null;
  /** 作者决定：本章以研究限制口径撰写 */
  limitationMode: boolean;
  /** 本节文献主题（outline literatureRefs） */
  literatureRefs?: readonly string[];
  /**
   * M14.3：本章系统继承表格（label + 题注 + 插入节文件）。写作只负责在正文
   * 合适位置以 \ref 引用；表格本体由系统确定性插入，Writer 不得自造替代表格。
   */
  inheritedTables?: ReadonlyArray<{ label: string; captionZh: string; sectionFile: string }>;
}

export function buildThesisSectionContext(input: ThesisSectionContextInput): ThesisSectionWritingContext {
  const lines: string[] = [];

  // 章节定位
  lines.push(
    `【学位论文章节】本章「${input.chapter.titleZh}」（${responsibilityLabel(input.chapter.responsibility)}）：${input.chapter.goal}`,
    `本节「${input.sectionTitle}」是本章第 ${input.sectionIndex + 1}/${input.sectionCount} 节。`,
  );

  // 事实纪律（stage 装配时已把 owns 贡献的 linkedFactIds 并入 chapter.factIds）
  const chapterFactIds = new Set(input.chapter.factIds);
  const authorConfirmed = input.factContext.facts.authorConfirmed.filter((fact) => chapterFactIds.has(fact.factId));
  const sourceVerified = input.factContext.facts.sourceVerifiedUnconfirmed.filter((fact) => chapterFactIds.has(fact.factId));
  const conflicted = input.factContext.facts.conflicted;

  lines.push("【科研事实纪律】");
  if (authorConfirmed.length > 0) {
    lines.push(
      "以下为作者已确认的研究成果事实——正文中的全部实验指标/参数/数据集数值只能来自此表（允许等价单位换算与合理舍入表述，禁止改值）：",
    );
    for (const fact of authorConfirmed.slice(0, MAX_FACT_LINES)) {
      lines.push(`- ${fact.surface}（${describeFactView(fact)}）`);
    }
    if (authorConfirmed.length > MAX_FACT_LINES) {
      lines.push(`-（其余 ${authorConfirmed.length - MAX_FACT_LINES} 条已确认事实略——写作时按需定性引用，不得虚构数值）`);
    }
  } else {
    lines.push("本章没有已确认的实验数值：正文不得出现任何具体实验指标数值；实验结论只能定性描述并如实说明数据待补。");
  }
  if (sourceVerified.length > 0) {
    lines.push(
      `另有 ${sourceVerified.length} 条仅经来源核验、未经作者确认的事实：不得作为具体数值写入正文（如需提及只能定性表述并标注「待作者确认」。`,
    );
  }
  if (conflicted.length > 0) {
    lines.push(
      `存在 ${conflicted.length} 条未裁决冲突事实：禁止选择其中任何一方的数值；涉及相关结论时如实表述为「存在版本差异，待裁决」。`,
    )
  }
  lines.push("禁止虚构实验结果、补造表格数据、或写入上表之外的任何具体数值。");

  // 源文本投影（核心章）
  if (input.sourceProjection !== null && input.sourceProjection.trim() !== "") {
    lines.push(
      "【你的研究成果原文投影（改写源）】",
      "以下是本章来源研究材料的原文片段。你的任务是把相关内容翻译/重排/衔接为本节正文：",
      "- 忠实保留原文的方法、实验与结论口径；禁止新增数值、实验或结论；",
      "- 原文中的 supplemental / 见附录 / see appendix 一律转为正文文字说明，不得写成 \\ref 交叉引用；",
      "- 投影只是节选：投影未覆盖的内容不得凭空补写。",
      "原文投影：",
      input.sourceProjection,
    );
  }

  // 贡献归属
  const owns = input.chapter.ownsContributionIds
    .map((id) => input.contributionStatements.get(id))
    .filter((item): item is { statement: string; kind: string } => item !== undefined);
  if (owns.length > 0) {
    lines.push("【本章负责完整展开的研究贡献】", ...owns.map((item) => `- [${item.kind}] ${item.statement}`));
  }
  const references = input.chapter.referencesContributionIds
    .map((id) => input.contributionStatements.get(id))
    .filter((item): item is { statement: string; kind: string } => item !== undefined);
  if (references.length > 0) {
    lines.push(
      "【其他章展开的贡献——本章只允许简要引用提及，不得重复展开】",
      ...references.map((item) => `- [${item.kind}] ${item.statement}`),
    );
  }

  // 文献主题
  if (input.literatureRefs !== undefined && input.literatureRefs.length > 0) {
    lines.push(
      "【本节需要文献支撑的主题】只允许使用系统提供的允许引用 key：",
      ...input.literatureRefs.map((ref) => `- ${ref}`),
    );
  }

  // 限制口径
  if (input.limitationMode) {
    lines.push(
      "【作者决定：研究限制口径】本章按作者决定以「研究限制 / 未开展」口径撰写：如实说明材料未齐、实验未开展或数据待补；不得出现任何具体数值，不得虚构进展。",
    );
  }

  // M14.3 系统继承表格
  if (input.inheritedTables !== undefined && input.inheritedTables.length > 0) {
    const here = input.inheritedTables.filter((table) => table.sectionFile === input.sectionFile);
    const elsewhere = input.inheritedTables.filter((table) => table.sectionFile !== input.sectionFile);
    lines.push(
      "【系统继承表格】以下研究成果表格由系统按作者授权确定性插入本章，数据不可改动：",
      ...input.inheritedTables.map((table) => `- ${table.captionZh}（\\ref{${table.label}}）`),
      "正文可在合适位置以 \\ref 引用上述表格并围绕其数据展开分析；禁止自行编写这些表格的替代版本、改写其中数值、或在正文中给出与表格冲突的数字。",
      ...(here.length > 0
        ? [`本节末尾将插入：${here.map((table) => table.label).join("、")}（无需在正文输出表格环境）。`]
        : []),
      ...(elsewhere.length > 0 ? [`其余继承表格（${elsewhere.map((table) => table.label).join("、")}）在本章其他节插入。`] : []),
    );
  }

  return {
    extraInstructions: lines.join("\n"),
    summary: {
      chapterId: input.chapter.chapterId,
      responsibility: input.chapter.responsibility,
      authorConfirmedFacts: authorConfirmed.length,
      sourceVerifiedFacts: sourceVerified.length,
      conflictedFacts: conflicted.length,
      sourceProjectionChars: input.sourceProjection?.length ?? 0,
      limitationMode: input.limitationMode,
    },
  };
}

/**
 * M14.5（案例 B 真实 run 实证）：Reviewer 的实验数据口径只看实验包（experimentPolicy）——
 * 学位论文项目没有实验包时被告知「本项目当前没有已导入的实验数据」，于是把作者已确认
 * 的研究输入事实（如小论文的 75.37%）判为「无授权数据」并阻断、修订随之删掉正确数值。
 * 本块与 Writer 的科研事实纪律同源：已确认事实 = 合法实验/参数数据来源。
 */
export function renderThesisFactPolicyLines(factContext: { facts: { authorConfirmed: FactView[]; sourceVerifiedUnconfirmed: FactView[]; conflicted: FactView[] } }): string[] {
  const confirmed = factContext.facts.authorConfirmed;
  if (confirmed.length === 0) return [];
  const lines: string[] = [
    "",
    "===== 学位论文研究输入已确认事实（Research Input Facts；全体审稿角色一致）=====",
    "本论文由作者已确认的研究输入（已发表/投稿论文、实验报告等）扩展而成；下表数值经来源核验并由作者确认，是本论文合法的实验数据与参数来源（等价于已授权进入工作流的实验数据）。稿件中与下表一致的数值不得判为「无实验数据」「未授权」或「仅见于外部来源」；不在下表且无其他授权来源的具体数值仍按实验支撑缺口如实报告。",
  ];
  for (const fact of confirmed.slice(0, MAX_FACT_LINES)) {
    lines.push(`- ${fact.surface}（${describeFactView(fact)}）`);
  }
  if (confirmed.length > MAX_FACT_LINES) {
    lines.push(`-（其余 ${confirmed.length - MAX_FACT_LINES} 条已确认事实略）`);
  }
  if (factContext.facts.sourceVerifiedUnconfirmed.length > 0) {
    lines.push(`另有 ${factContext.facts.sourceVerifiedUnconfirmed.length} 条仅来源核验、未经作者确认的事实：其数值出现在正文时按「待作者确认」报告。`);
  }
  if (factContext.facts.conflicted.length > 0) {
    lines.push(`存在 ${factContext.facts.conflicted.length} 条未裁决冲突事实：正文选取任一方数值均应报告为未裁决冲突。`);
  }
  return lines;
}

function describeFactView(fact: FactView): string {
  const key = fact.key;
  const parts: string[] = [];
  if (key.subject !== undefined && key.subject !== "") parts.push(key.subject);
  if (key.dataset !== undefined && key.dataset !== "") parts.push(key.dataset);
  if (key.metric !== undefined && key.metric !== "") parts.push(key.metric);
  return parts.length > 0 ? parts.join(" / ") : fact.kind;
}

function responsibilityLabel(responsibility: ThesisChapterPlan["responsibility"]): string {
  const labels: Record<ThesisChapterPlan["responsibility"], string> = {
    introduction: "绪论",
    background: "基础知识",
    literature_review: "文献综述",
    method: "核心方法章",
    experiment: "实验验证章",
    discussion: "讨论章",
    conclusion: "总结与展望",
  };
  return labels[responsibility];
}

/**
 * 章级源文本按节分窗（确定性轮转）：第 i 节取窗口 [i*B, i*B+B*1.1]，
 * 尾部不足时从头取。无来源 → null。
 */
export function sourceProjectionForSection(source: {
  text: string;
  sectionIndex: number;
  sectionCount: number;
}): string | null {
  if (source.text.trim() === "") return null;
  if (source.sectionCount <= 1) return source.text.slice(0, SOURCE_PROJECTION_BUDGET);
  const start = Math.min(source.sectionIndex * SOURCE_PROJECTION_BUDGET, Math.max(0, source.text.length - 500));
  const window = source.text.slice(start, start + Math.round(SOURCE_PROJECTION_BUDGET * 1.1));
  return window.length > 0 ? window : source.text.slice(0, SOURCE_PROJECTION_BUDGET);
}

/** 汇总一章各来源输入的全文（供分窗） */
export function chapterSourceText(
  blocksPerInput: ReadonlyArray<{ blocks: ReadonlyArray<{ type: string; text?: string; caption?: string }> }>,
): string {
  return blocksPerInput.map((entry) => documentPlainText(entry.blocks)).join("\n\n");
}
