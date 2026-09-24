/**
 * Weakened Claim Terminal Semantics（M9.8 Phase 4：弱化终态的最小语义）。
 *
 * 背景（M9.7.7 §15-2b）：Writer 的 WEAKEN 动作会把无证据论断弱化为「泛指性
 * 存在断言」，但 Reviewer fact 判据（「无已核验证据支撑的关键论断必须
 * UNSUPPORTED」）没有「可接受的弱化形态」概念——弱化后的泛指句在后续轮仍判
 * U（新指纹、同语义），U 永不收敛。本模块定义并实现**何时弱化可以作为终态**
 * 的确定性判定，作为下一里程碑接线（reviewer 判据 / gate 口径）的工具与审计
 * 口径；M9.8 本轮**不接 Quality Gate、不改 Reviewer**（预注册约束）。
 *
 * 语义（docs/research/M9.8_RESEARCH_EVIDENCE_ALIGNMENT.md §4.4）：
 * 弱化可接受的唯一形态 = 泛指性背景叙述，须同时满足：
 * 1. 不含数字（数值 / 年份 / 百分比 / 版本号——模型名内嵌数字一并保守拒绝）；
 * 2. 不含比较方向或程度词（优于 / 超过 / 提升 / 降低 / outperform…）；
 * 3. 不含性能 / 基准结果语义（准确率 / 性能 / F1 / 吞吐 / 延迟…）；
 * 4. 不含对具体系统 / 方法的能力归因（提出 / 首次实现 / 证明了 / proposed…）。
 * 违反任一 → WEAKEN 不是合法终态，出口只有 SUPPORT（补证据）或 REMOVE。
 *
 * 诚实边界：marker 级启发式（与 claimStrength.ts 同级），不是语义理解——
 * 「宁可漏报不误报」方向相反：本分类器用于**放行判定**，漏报（把该拒的判为
 * 可接受）比误报（把可接受的判为该拒）危害大，因此 marker 集刻意从宽
 * （增加/减少 等弱比较词也拒绝；含任何数字即拒绝）。
 */

/** 拒绝规则的稳定标识（评估 / 审计口径） */
export type WeakeningRejectRule =
  | "numeric" // 数字：数值 / 年份 / 百分比 / 版本号 / 模型名内嵌数字
  | "comparative" // 比较方向或程度词
  | "performance" // 性能 / 基准结果语义
  | "attribution"; // 对具体系统 / 方法的能力归因

export interface WeakenedClaimAssessment {
  /** true = 该弱化形态可作为终态（泛指性背景叙述） */
  acceptable: boolean;
  /** acceptable ? "general_background" : 违反的第一条规则 */
  category: "general_background" | WeakeningRejectRule;
  /** 命中的全部拒绝规则（按 numeric → comparative → performance → attribution 全序） */
  violatedRules: WeakeningRejectRule[];
  /** 人读结论（审计 / 报告用） */
  reason: string;
}

/** 比较方向 / 程度词（中英；从宽收录——本分类器服务放行判定） */
const COMPARATIVE_MARKERS: readonly string[] = [
  "优于",
  "劣于",
  "超过",
  "落后",
  "领先",
  "超越",
  "提升",
  "提高",
  "降低",
  "减少",
  "增加",
  "改善",
  "更优",
  "更差",
  "更快",
  "更慢",
  "更强",
  "更弱",
  "更好",
  "更坏",
  "更高",
  "更低",
  "更多",
  "更少",
  "最好",
  "最优",
  "outperform",
  "surpass",
  "exceed",
  "better",
  "worse",
  "faster",
  "slower",
  "higher",
  "lower",
  "more efficient",
  "improve",
  "improves",
  "improved",
  "reduce",
  "reduces",
  "increase",
  "increases",
  "gain",
  "gains",
];

/** 性能 / 基准结果语义 */
const PERFORMANCE_MARKERS: readonly string[] = [
  "准确率",
  "精度",
  "性能",
  "吞吐",
  "延迟",
  "开销",
  "效率",
  "收敛速度",
  "误差",
  "效果最好",
  "实验结果",
  "评测结果",
  "基准测试",
  "accuracy",
  "precision",
  "recall",
  "throughput",
  "latency",
  "efficiency",
  "f1",
  "map",
  "bleu",
  "benchmark result",
];

/** 具体系统 / 方法的能力归因（「X 提出 / 实现 / 证明了 Y」形态） */
const ATTRIBUTION_MARKERS: readonly string[] = [
  "提出了",
  "首次提出",
  "首次实现",
  "实现了",
  "设计并实现",
  "构建了",
  "引入了",
  "证明了",
  "验证了",
  "展示了",
  "proposed",
  "introduced",
  "first to",
  "designed",
  "developed",
  "built",
  "demonstrated",
  "achieved",
  "showed that",
  "proved",
];

function hasAnyMarker(lower: string, markers: readonly string[]): boolean {
  return markers.some((marker) => lower.includes(marker));
}

/**
 * 判定一条弱化后的 claim 文本是否处于可接受的泛指形态（纯函数）。
 * 输入是 fact claim 文本（claim grounding 口径的自然语言句子，非 LaTeX）。
 */
export function assessWeakenedClaim(claimText: string): WeakenedClaimAssessment {
  const text = claimText.trim();
  const lower = text.toLowerCase();
  const violatedRules: WeakeningRejectRule[] = [];

  // 1. 数字：任何 ASCII 数字串（含年份 / 百分比 / 版本 / GPT-4 形态）——保守拒绝
  if (/\d/.test(text)) {
    violatedRules.push("numeric");
  }
  // 2-4. marker 检查（小写匹配覆盖英文大小写形态）
  if (hasAnyMarker(lower, COMPARATIVE_MARKERS)) {
    violatedRules.push("comparative");
  }
  if (hasAnyMarker(lower, PERFORMANCE_MARKERS)) {
    violatedRules.push("performance");
  }
  if (hasAnyMarker(lower, ATTRIBUTION_MARKERS)) {
    violatedRules.push("attribution");
  }

  if (violatedRules.length === 0) {
    return {
      acceptable: true,
      category: "general_background",
      violatedRules: [],
      reason: "泛指性背景叙述：无数字、无比较方向、无性能语义、无具体归因——可作为弱化终态",
    };
  }
  const label: Record<WeakeningRejectRule, string> = {
    numeric: "含数字（数值 / 年份 / 百分比 / 版本号）",
    comparative: "含比较方向或程度词",
    performance: "含性能 / 基准结果语义",
    attribution: "含对具体系统 / 方法的能力归因",
  };
  return {
    acceptable: false,
    category: violatedRules[0]!,
    violatedRules,
    reason: `不是可接受的弱化形态（${violatedRules.map((rule) => label[rule]).join("；")}）——出口只有 SUPPORT（补证据）或 REMOVE`,
  };
}
