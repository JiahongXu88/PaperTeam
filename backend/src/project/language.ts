/**
 * Project Language Contract（M9.7.4）。
 *
 * project.language 在存储层是自由字符串（≤50 字符，无 enum——见
 * ProjectStore 的设计注释）；本模块是它在 Pipeline 侧的唯一归一化出口：
 * 自由字符串 → "zh" | "en" | undefined（legacy，保持缺省行为）。
 *
 * 纪律：
 * - 不在存储层新增第二套 language 字段，不回写 project.json；
 * - 识别不了的值一律 undefined（legacy 语义：不注入语言指令、不过滤
 *   zh-only skill——与 M9.7.4 之前的行为完全一致，零回归）；
 * - 消费方（prompt 构造 / skill 路由）只依赖本模块，不各自解析字符串。
 */

/** 归一化后的稿件语言（undefined = legacy / 未指定） */
export type ManuscriptLanguage = "zh" | "en";

/** 中文标识（token 级匹配；覆盖常见自由写法） */
const ZH_TOKENS = new Set(["zh", "chinese", "中文", "汉语", "华语", "中国话"]);
/** 英文标识 */
const EN_TOKENS = new Set(["en", "english", "英文", "英语"]);

/**
 * 归一化 project.language：
 * - "Chinese" / "中文" / "zh" / "zh-CN" / "Simplified Chinese" → "zh"
 * - "English" / "英文" / "en" / "en-US" → "en"
 * - 缺省 / 空串 / 无法识别 → undefined（legacy）
 * 中英同时出现时以先命中者为准（正常输入不会出现；出现即说明输入本身
 * 有歧义，任取一侧都不比 undefined 更差，保持确定性即可）。
 */
export function normalizeManuscriptLanguage(language: string | undefined): ManuscriptLanguage | undefined {
  if (typeof language !== "string") {
    return undefined;
  }
  const value = language.trim().toLowerCase();
  if (value === "") {
    return undefined;
  }
  const tokens = value.split(/[\s(\[（【,，/、\-_]+/).filter((token) => token !== "");
  for (const token of tokens) {
    if (ZH_TOKENS.has(token)) {
      return "zh";
    }
    if (EN_TOKENS.has(token)) {
      return "en";
    }
  }
  // BCP-47 风格前缀（zh-cn / en_us 等）：首个 token 前缀命中即可
  const first = tokens[0];
  if (first !== undefined) {
    if (first === "zh" || first.startsWith("zh-")) {
      return "zh";
    }
    if (first === "en" || first.startsWith("en-")) {
      return "en";
    }
  }
  return undefined;
}

/** 语言显示名（prompt / 诊断用） */
export function languageDisplayName(language: ManuscriptLanguage): string {
  return language === "zh" ? "中文（Chinese）" : "英文（English）";
}

/**
 * 写作语言指令行（Researcher / Outline / Writer prompt 共用；undefined 时
 * 返回空数组 = 不注入，legacy 行为）。
 */
export function targetLanguageLines(language: ManuscriptLanguage | undefined): string[] {
  if (language === undefined) {
    return [];
  }
  return [
    language === "zh"
      ? `写作语言（不可违反）：中文。论文标题、摘要、章节名、正文必须全部使用中文。`
      : `Writing language (must be followed): English. The paper title, abstract, section headings, and body text must all be written in English.`,
  ];
}
