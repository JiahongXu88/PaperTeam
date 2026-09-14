/**
 * Style Signals（M5.4 eval instrument）：确定性的中文学术表达「信号」扫描器。
 *
 * 用途：M5 eval corpus 的 deterministic hard check 与 M5.6 A/B 的硬指标之一
 * （模板化短语 / 机械排比 / 宣传式评价词 / 空泛总结 / 模糊归因的计数），以及
 * 对 Style Reviewer 输出做 false-positive 对照。**不是** Reviewer、不进入
 * Quality Gate、不是 AI detector——它只数可枚举的表面模式，没有任何「AI 概率」。
 *
 * 防误报纪律（与 academic-style-zh Skill 一致）：「此外 / 然而 / 因此 / 同时」
 * 单独出现不是信号；只有同一段内 ≥ 3 个连续句子均以过渡词开头才计为
 * 「机械过渡」信号。
 */

export type StyleSignalKind =
  | "template_opening"
  | "vague_attribution"
  | "promotional_adjective"
  | "hollow_summary"
  | "mechanical_enumeration"
  | "mechanical_transitions"
  | "overclaim";

export interface StyleSignal {
  kind: StyleSignalKind;
  /** 命中的原文片段（≤ 80 字） */
  sample: string;
  /** 段落序号（1 起） */
  paragraph: number;
}

export interface StyleSignalReport {
  total: number;
  byKind: Record<StyleSignalKind, number>;
  signals: StyleSignal[];
  paragraphs: number;
}

const TEMPLATE_OPENINGS = [
  /随着[^。！？]{0,30}(快速|不断|迅猛|飞速)发展/,
  /已(经)?成为[^。！？]{0,20}(研究)?热点/,
  /本文提出了?一种(新颖|全新|创新)的/,
  /有效地?解决了/,
  /在[^。！？]{0,20}的(大)?背景下/,
];
const VAGUE_ATTRIBUTION = [
  // 「研究表明 / 实验证明」只有在同句既无 \cite 也无数字时才算模糊归因
  //（「消融实验表明 … 下降 0.6 个百分点」是有数据支撑的陈述，不是信号）
  /(大量|众多|许多|诸多)?(研究|实验|文献|学者|专家)(表明|证明|显示|认为|指出|普遍认为)(?![^。！？]*(\\cite|\d))/,
  /众所周知/,
  /业界普遍/,
];
const PROMOTIONAL = /(强大的|优雅的|令人瞩目的|令人印象深刻的|完美地|卓越的|出色的|革命性的|颠覆性的|里程碑式?的|开创性的)/;
const HOLLOW_SUMMARY = [
  /具有(十分|非常|极其|重大|重要)?(重要|重大|深远)(的)?(意义|价值)(?![^。！？]*\d)/,
  /为[^。！？]{0,20}(奠定了|打下了)(坚实的?)?基础/,
  /(值得|有待)进一步(深入)?(研究|探索)(?![^。！？]{0,40}(如|例如|包括|具体))/,
  /综上所述[^。！？]{0,40}(有效|重要|意义)(?![^。！？]*\d)/,
];
const OVERCLAIM = [
  /(首次|彻底|完全|全面)(解决|克服|消除)/,
  /(显著|大幅)(优于|超过|提升)(所有|全部|一切)/,
  /(所有|任意|任何)(场景|数据集|情况)下(均|都)/,
];
const ENUM_MARKERS = /^(首先|其次|再次|最后|一方面|另一方面|第一|第二|第三)[，,、]/;
const TRANSITIONS = /^(此外|然而|因此|同时|另外|而且|并且|值得注意的是|不难发现|可以看出)[，,]/;

function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph !== "");
}

function splitSentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[。！？；])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
}

function stripLatex(text: string): string {
  return text
    .replace(/\\begin\{[^}]*\}[\s\S]*?\\end\{[^}]*\}/g, " ")
    .replace(/\$[^$]*\$/g, " ")
    .replace(/\\[A-Za-z]+\*?(\[[^\]]*\])?\{([^}]*)\}/g, (whole, _opt: string, inner: string) =>
      whole.startsWith("\\cite") ? whole : inner,
    );
}

/** 扫描 LaTeX / 纯文本段落，返回可枚举的表面信号（确定性） */
export function scanStyleSignals(text: string): StyleSignalReport {
  const paragraphs = splitParagraphs(stripLatex(text));
  const signals: StyleSignal[] = [];
  const push = (kind: StyleSignalKind, sample: string, paragraph: number): void => {
    signals.push({ kind, sample: sample.slice(0, 80), paragraph });
  };
  paragraphs.forEach((paragraph, index) => {
    const number = index + 1;
    const sentences = splitSentences(paragraph);
    for (const sentence of sentences) {
      for (const pattern of TEMPLATE_OPENINGS) {
        if (pattern.test(sentence)) {
          push("template_opening", sentence, number);
          break;
        }
      }
      for (const pattern of VAGUE_ATTRIBUTION) {
        if (pattern.test(sentence)) {
          push("vague_attribution", sentence, number);
          break;
        }
      }
      if (PROMOTIONAL.test(sentence)) {
        push("promotional_adjective", sentence, number);
      }
      for (const pattern of HOLLOW_SUMMARY) {
        if (pattern.test(sentence)) {
          push("hollow_summary", sentence, number);
          break;
        }
      }
      for (const pattern of OVERCLAIM) {
        if (pattern.test(sentence)) {
          push("overclaim", sentence, number);
          break;
        }
      }
    }
    // 机械排比：同段 ≥ 3 句以「首先 / 其次 / 最后 …」开头
    const enumerated = sentences.filter((sentence) => ENUM_MARKERS.test(sentence));
    if (enumerated.length >= 3) {
      push("mechanical_enumeration", enumerated.slice(0, 3).join(" / "), number);
    }
    // 机械过渡：≥ 3 个连续句子均以过渡词开头（单个「此外 / 然而 / 因此」不是信号）
    let streak = 0;
    let flagged = false;
    for (const sentence of sentences) {
      streak = TRANSITIONS.test(sentence) ? streak + 1 : 0;
      if (streak >= 3 && !flagged) {
        push("mechanical_transitions", sentence, number);
        flagged = true;
      }
    }
  });
  const byKind: Record<StyleSignalKind, number> = {
    template_opening: 0,
    vague_attribution: 0,
    promotional_adjective: 0,
    hollow_summary: 0,
    mechanical_enumeration: 0,
    mechanical_transitions: 0,
    overclaim: 0,
  };
  for (const signal of signals) {
    byKind[signal.kind] += 1;
  }
  return { total: signals.length, byKind, signals, paragraphs: paragraphs.length };
}
