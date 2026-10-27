/**
 * M14.9-MOT：修订候选中「关于修订过程的说明」检测。
 *
 * 真实返修（R5.1 MOT 小论文）：补丁被校验拒绝后，修复轮的 Writer 在替换文本末尾追加了一段
 * 无标记的自然语言说明——「本次重提交与上一版提案相同。报告的校验失败指向本节之外的导言区
 * 定义……删除这些修订痕迹是 improvement:23/24 明确要求的……」——该段通过全部守卫进入正文。
 * 既有 REVISION_META_TEXT_PATTERN 只认【修订说明】类显式标记。
 *
 * 判定只看候选**新增**的段落（原 span 中不存在的段落），且只认修订流程专有词汇与内部 ID；
 * 原 span 已含同一词汇时不判（论文正文合法使用该词不受影响）。
 */

/**
 * M15.8.2（第三变体）：修订 Writer 把「执行报告：…（f-xxxxxxxxxxxx / c-xxxxxxxxxxxx）」
 * 以无书名号形态写进正文——两个既有守卫双双漏检（REVISION_META_TEXT_PATTERN 只认
 * 【执行报告】；词汇表只有「执行说明」），泄漏段落的数字与库外实体反被事实守卫保护，
 * 清除补丁连续被拒。「执行报告」与 finding/claim 内部 ID（f-/c- + 12 hex）并入检测。
 */
const INTERNAL_ID = /\b(?:improvement:\d+|patch:[0-9a-f]{6,}|[fc]-[0-9a-f]{12})\b/;

const PROCESS_COMMENTARY_PATTERNS: readonly RegExp[] = [
  INTERNAL_ID,
  /校验器|校验失败|修改要求|修订计划|重提交|上一版(?:提案|输出)|本(?:次|版)提案|编辑单元|本单元|按单元边界|执行说明|执行报告/,
];

/**
 * 文本块：以空行与章节 / 环境命令起始行为边界（LaTeX 的章节标题前常无空行，只按空行切分会把
 * 泄漏段落与下一节正文并成一块）。返回原文切片，拼接后与输入逐字节一致。
 */
function blocks(text: string): string[] {
  const result: string[] = [];
  let current = "";
  for (const line of text.split(/(?<=\n)/)) {
    const trimmed = line.trim();
    if (trimmed === "" || /^\\(?:(?:sub)*section|paragraph|begin|end|item|caption|label)\b/.test(trimmed)) {
      if (current !== "") result.push(current);
      current = "";
      result.push(line);
      continue;
    }
    current += line;
  }
  if (current !== "") result.push(current);
  return result;
}

function paragraphs(text: string): string[] {
  return blocks(text)
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter((block) => block !== "");
}

/** 返回首个新增的修订过程说明段落摘录（≤120 字符）；无则 null。 */
export function findWriterProcessCommentary(originalSpan: string, proposal: string): string | null {
  const original = paragraphs(originalSpan);
  const originalText = original.join("\n");
  const known = new Set(original);
  for (const paragraph of paragraphs(proposal)) {
    if (known.has(paragraph)) continue;
    for (const pattern of PROCESS_COMMENTARY_PATTERNS) {
      const match = pattern.exec(paragraph);
      if (match === null || pattern.test(originalText)) continue;
      const at = Math.max(0, match.index - 40);
      return paragraph.slice(at, at + 120);
    }
  }
  return null;
}

const ID_MARKER = INTERNAL_ID;
const PROCESS_VOCABULARY = /校验器|校验失败|修改要求|修订计划|重提交|上一版(?:提案|输出)|本(?:次|版)提案|编辑单元|本单元|按单元边界|执行说明|执行报告/g;

/**
 * 已经进入稿件的修订过程说明段落（带内部计划 / 补丁 ID，或至少两处不同的修订流程词汇）
 * 不是论文事实：事实守卫的数值提取前整段替换为空白（保留换行），删除它不构成「删除事实」。
 * M14.9-MOT 真实返修：清除泄漏段落的补丁因段内「[1]」「数值 1」「improvement:23/24」被判
 * 删除事实而两次被拒。
 */
export function stripWriterProcessCommentary(text: string): string {
  return blocks(text).map((block) => {
    const commentary = ID_MARKER.test(block) || new Set(block.match(PROCESS_VOCABULARY) ?? []).size >= 2;
    return commentary ? block.replace(/[^\r\n]/g, " ") : block;
  }).join("");
}
