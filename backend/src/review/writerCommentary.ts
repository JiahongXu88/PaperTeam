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

const PROCESS_COMMENTARY_PATTERNS: readonly RegExp[] = [
  /\bimprovement:\d+/,
  /\bpatch:[0-9a-f]{6,}/,
  /校验器|校验失败|修改要求|修订计划|重提交|上一版(?:提案|输出)|本(?:次|版)提案|编辑单元|本单元|按单元边界|执行说明/,
];

function paragraphs(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph !== "");
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
