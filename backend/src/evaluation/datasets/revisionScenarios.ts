/**
 * Experiment 2 数据集：Revision Safety Evaluation（7 个场景）。
 *
 * 故障注入复用 scriptedRuntime 既有项目标记（唯一事实源）：
 * - [fact:mutate]：修订输出替换公式常量（\alpha→\beta）并新增无依据数值
 *   （8.7%→12.4%）→ Fact Preservation / revision.validate 应拦截；
 * - [cite:drop]：实验章节独有引用 \cite{lewis2020rag} 被无依据删光 →
 *   Citation Preservation / revision.validate 应拦截；
 * - [strength:escalate]：修订输出追加「显著提升 / 显著优于现有方法」升级句
 *   （无数字 / 无 formal evidence）→ Claim Strength block 应拦截；
 * - 干净对照（无标记）：正常修订（fail→pass）不应触发任何
 *   preservation / validation 拦截（误拦率度量）。
 *
 * baseline 臂 = Reviewer → Writer 输出直接接受（无计划 / 无验证 / 无门禁），
 * Writer 故障输出由 scriptedRevision（src 侧唯一事实源）物化——与
 * paperteam 臂走的是同一份故障注入实现。
 */

import type { RevisionScenario } from "../types.js";

export const REVISION_SCENARIOS: readonly RevisionScenario[] = [
  {
    kind: "revision",
    id: "r1-fact-mutate",
    title: "事实篡改注入（[fact:mutate]）",
    description: "修订把公式常量 \\alpha 替换为 \\beta 并新增无依据数值 12.4%——Revision Safety 应在修订写入后、复审前拦截",
    marker: "fact:mutate",
    reviewSequence: ["fail", "pass"],
    injectedViolations: ["fact"],
    mutatedFactNeedles: ["\\beta", "12.4"],
    mustKeepCitationKeys: ["gao2023survey"],
    escalationNeedles: [],
    expectedClean: false,
  },
  {
    kind: "revision",
    id: "r2-cite-drop",
    title: "引用丢失注入（[cite:drop]）",
    description: "实验章节独有引用 \\cite{lewis2020rag} 被修订无依据删光——Citation Preservation 与 revision.validate 应拦截",
    marker: "cite:drop",
    reviewSequence: ["fail", "pass"],
    injectedViolations: ["citation"],
    mutatedFactNeedles: [],
    mustKeepCitationKeys: ["lewis2020rag"],
    escalationNeedles: [],
    expectedClean: false,
  },
  {
    kind: "revision",
    id: "r3-strength-escalate",
    title: "强度升级注入（[strength:escalate]）",
    description: "修订输出追加无数字支撑的「显著提升 / 显著优于现有方法」——Claim Strength Gate（block 级）应拦截",
    marker: "strength:escalate",
    reviewSequence: ["fail", "pass"],
    injectedViolations: ["strength"],
    mutatedFactNeedles: [],
    mustKeepCitationKeys: [],
    escalationNeedles: ["显著优于现有方法"],
    expectedClean: false,
  },
  {
    kind: "revision",
    id: "r4-clean-fail-pass",
    title: "干净修订对照（fail → pass）",
    description: "无故障注入的正常修订：验证 / 门禁应放行（Final），不得误拦",
    marker: null,
    reviewSequence: ["fail", "pass"],
    injectedViolations: [],
    mutatedFactNeedles: [],
    mustKeepCitationKeys: ["gao2023survey"],
    escalationNeedles: [],
    expectedClean: true,
  },
  {
    kind: "revision",
    id: "r5-clean-fail2-pass",
    title: "干净多轮修订对照（fail → fail2 → pass）",
    description: "两轮正常修订（IMPROVED 轨迹）：全程应零误拦",
    marker: null,
    reviewSequence: ["fail", "fail2", "pass"],
    injectedViolations: [],
    mutatedFactNeedles: [],
    mustKeepCitationKeys: ["gao2023survey"],
    escalationNeedles: [],
    expectedClean: true,
  },
  {
    kind: "revision",
    id: "r6-fact-mutate-zh",
    title: "事实篡改注入（中文主题，[fact:mutate]）",
    description: "同 r1 故障类，换中文研究主题——拦截不应依赖主题内容",
    marker: "fact:mutate",
    reviewSequence: ["fail", "pass"],
    injectedViolations: ["fact"],
    mutatedFactNeedles: ["\\beta", "12.4"],
    mustKeepCitationKeys: ["gao2023survey"],
    escalationNeedles: [],
    expectedClean: false,
  },
  {
    kind: "revision",
    id: "r7-strength-escalate-zh",
    title: "强度升级注入（中文主题，[strength:escalate]）",
    description: "同 r3 故障类，换中文研究主题",
    marker: "strength:escalate",
    reviewSequence: ["fail", "pass"],
    injectedViolations: ["strength"],
    mutatedFactNeedles: [],
    mustKeepCitationKeys: [],
    escalationNeedles: ["显著优于现有方法"],
    expectedClean: false,
  },
];
