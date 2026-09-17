/**
 * 中英兼容 lexical tokenizer（M6.4；D-0036）。
 *
 * 目标：学术语料友好 + 中文不失效 + 零外部依赖（不接分词服务 / 全文索引引擎）：
 * - 英文 / 数字 / 标识符：`[a-z0-9][a-z0-9'-]*`（小写化）。含连字符的学术
 *   标识符（MRG-DTM / YOLOv11-L）保留整体 token，同时补发各部分（mrg / dtm）
 *   ——查询侧写 "MRG DTM" 或整体都能命中；
 * - 中文：CJK 连续段切 bigram（二元），单字段落单字。bigram 是无词典 CJK
 *   检索的最小可用方案：单字索引区分度过低（"的/了"满库），bigram 显著
 *   提高精度；查询侧同口径（"数据关联" → 数据/据关/关联），子串召回成立；
 * - 全角数字/字母不归一（论文语料罕见；CJK 标点只作分隔符）。
 *
 * 查询与文档共用同一 tokenizer（lexical 对称性是确定性排序的前提）。
 */

/** CJK 码位（汉字基本区 + 扩展 A + 兼容区；假名/谚文按其他文字走词切） */
function isCjkCodepoint(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

function isLatinWordChar(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) || // a-z（先小写化）
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x27 || // '
    code === 0x2d || // -
    code === 0x5f // _
  );
}

function isLatinStartChar(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39);
}

/** 文本 → token 流（小写化；中英混合；确定性——同文本恒同序列） */
export function tokenizeText(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  let index = 0;
  let cjkRun: string[] = [];
  const flushCjk = () => {
    if (cjkRun.length === 0) {
      return;
    }
    if (cjkRun.length === 1) {
      tokens.push(cjkRun[0]!);
    } else {
      for (let i = 0; i + 1 < cjkRun.length; i += 1) {
        tokens.push(cjkRun[i]! + cjkRun[i + 1]!);
      }
      // 尾单字保留（查询"关联性"中"性"独立成词的常见短词场景）
      tokens.push(cjkRun[cjkRun.length - 1]!);
    }
    cjkRun = [];
  };
  while (index < lower.length) {
    const code = lower.codePointAt(index) ?? 0;
    const size = code > 0xffff ? 2 : 1;
    const ch = lower.charAt(index);
    if (isCjkCodepoint(code)) {
      cjkRun.push(ch);
      index += size;
      continue;
    }
    flushCjk();
    if (isLatinStartChar(code)) {
      let end = index + 1;
      while (end < lower.length && isLatinWordChar(lower.codePointAt(end) ?? 0)) {
        end += 1;
      }
      const word = lower.slice(index, end).replace(/^[-']+|[-']+$/g, "");
      if (word !== "") {
        tokens.push(word);
        // 含连字符的标识符补发各部分（整体与部分双索引）
        if (word.includes("-")) {
          for (const part of word.split("-")) {
            if (part.length >= 2) {
              tokens.push(part);
            }
          }
        }
      }
      index = end;
      continue;
    }
    // 其他（拉丁词中段起点、标点、空白、全角标点、其他文字）：分隔符
    index += size;
  }
  flushCjk();
  return tokens;
}
