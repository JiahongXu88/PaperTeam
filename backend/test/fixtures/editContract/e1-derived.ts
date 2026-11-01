/**
 * M15.20 P0 —— 根据真实冻结工件派生的最小等价夹具（不是新的真实模型实验）。
 *
 * 来源（仓库外只读）：D:\PaperTeamData\M15\M15_19\e2e-stack\p-b6a2677fdf05\
 *   manuscript/revisions/rev-1/outline.json（摘要基线）与 rev-2/outline.json（越权落盘后摘要）、
 *   research/improvement-plan.json（improvement:1）、e1/E1-plan-after-D1.json（ta-sg-34ced22fcb）。
 * 派生方式：非目标句改写为同结构的合成英文（不复制论文正文）；保留触发缺陷所需的结构要素——
 *   目标锚句的数字串 5.402/6.075 · 11.549/12.789、PDF 断行、被越界删除的两句、
 *   Writer 落盘后把 5.402→3.312、11.549→9.798 并删句的形态。真实工件回放见
 *   scripts/m1520/replay-e1-edit-contract.mjs（输出写 D:\PaperTeamData\M15\M15_20_EditContractP0\）。
 */

/** 审计目标锚（审计 claimQuote，与真实工件逐字一致：短引文，用于锚定位） */
export const E1_ANCHOR =
  "improving the previous best HOTA by 5.402/6.075 points and IDF1 by 11.549/12.789 points, respectively";

/** 摘要基线（PDF 重建：含断行与行尾连字符） */
export const E1_ABSTRACT_BEFORE = [
  "Synthetic tracking methods have improved cross-modal representation",
  "learning and multimodal information integration. However, many",
  "methods merge both modalities into a single descriptor. When one",
  "modality degrades, the tracker cannot regulate it separately. We",
  "propose RCA-X, a reliability-consistent appearance framework. The individ-",
  "ual components are intentionally simple, focusing evaluation",
  "on controllable organization rather than learned estimation modules. RCA-",
  "X sets new SOTA results on BENCH-A and BENCH-B, improving",
  "the previous best HOTA by 5.402/6.075 points and IDF1 by",
  "11.549/12.789 points, respectively, while post-hoc analyses further",
  "validate reliability as an informative control signal. Code will be",
  "released upon acceptance.",
].join("\n");

/** Writer 实际落盘形态（越权：换数字 + 删两句 + 删短语 + 全段重排版） */
export const E1_ABSTRACT_AFTER_REAL =
  "Synthetic tracking methods have improved cross-modal representation learning. However, many methods merge both modalities into a single descriptor, so when one modality degrades the tracker cannot regulate it separately. We propose RCA-X, a reliability-consistent appearance framework. Under a single detection setting, RCA-X exceeds the highest prior values on BENCH-A and reproduced baselines on BENCH-B by 3.312/6.075 HOTA points and 9.798/12.789 IDF1 points, respectively. Code will be released upon acceptance.";

/** 仅换数字（其余逐字保留）——隔离 E1-NUM */
export const E1_ABSTRACT_NUMBERS_ONLY = E1_ABSTRACT_BEFORE.replace("5.402/6.075", "3.312/6.075").replace("11.549/12.789", "9.798/12.789");

/** 数字保留、只限定锚句，但额外删掉两句无关句——隔离 E1-SENT */
export const E1_ABSTRACT_EXTRA_DELETIONS = E1_ABSTRACT_BEFORE
  .replace(
    "The individ-\nual components are intentionally simple, focusing evaluation\non controllable organization rather than learned estimation modules. ",
    "",
  )
  .replace(", while post-hoc analyses further\nvalidate reliability as an informative control signal", "")
  .replace(
    "improving\nthe previous best HOTA by 5.402/6.075 points and IDF1 by\n11.549/12.789 points, respectively",
    "improving the best prior HOTA under the respective detection settings by 5.402/6.075 points and IDF1 by 11.549/12.789 points, respectively",
  );

/** 合法正例：原数值全部保留，仅在锚区间内加局部限定语，锚外逐字不变 */
export const E1_ABSTRACT_LEGAL_QUALIFY = E1_ABSTRACT_BEFORE.replace(
  "improving\nthe previous best HOTA by 5.402/6.075 points and IDF1 by\n11.549/12.789 points, respectively",
  "improving the previous best HOTA by 5.402/6.075 points and IDF1 by 11.549/12.789 points under the respective detection settings, respectively",
);

/** 审计建议方向（advisory；与「不得改变既有数字」冲突——建议换数） */
export const E1_PROPOSED_DIRECTION =
  "Restrict the abstract numbers to one detection setting and the tables shown, e.g. report PFTrack-detection gains (3.312/6.075 HOTA, 9.798/12.789 IDF1) or explicitly attribute 5.402/11.549 to the YOLO-RGBT setting on VT-MOT.";

/** Planner 计划条目（模型文本：点名旧值→新值 + 自称作者已批准；expectedFactChanges 为空） */
export const E1_PLANNER_ITEM = {
  id: "improvement:1",
  section: "sections/sec01.tex",
  logicalSection: "abstract",
  targetQuote: E1_ANCHOR,
  actionType: "modify",
  action: '将摘要头条数字统一到一个口径：把旧值 "5.402/6.075" 改为 "3.312/6.075"，把旧值 "11.549/12.789" 改为 "9.798/12.789"。',
  rationale: "C1【作者已批准：按既有证据改写】仅修改该句，targetQuote 之外内容逐字保留。",
  instructionId: "x-620aab7c7d",
  relatedEvidenceIds: [] as string[],
  expectedFactChanges: [] as Array<{ before: string; after: string }>,
};

/** sec01 章节文件中的摘要副本（span 路径；与摘要载体同一越权候选） */
export const E1_SEC01_BEFORE = [
  "\\section{I Introduction}",
  "",
  E1_ABSTRACT_BEFORE,
  "",
  "Experiments on BENCH-A and BENCH-B show",
  "that RCA-X surpasses the previous SOTA by 5.402/6.075",
  "HOTA and 11.549/12.789 IDF1, respectively.",
  "",
].join("\n");
