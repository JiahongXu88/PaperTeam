/**
 * Context Budget 估算与输出预留（M5.2 任务 H）。
 *
 * 全部是纯函数：供 PiRuntimeAdapter 在「任务成为会话队头、尚未 prompt」的
 * 安全边界做 preflight guard，也可独立单测。
 *
 * 事实源纪律：
 * - contextWindow / maxTokens 一律来自当前 resolved Pi Model
 *   （pi-ai Model 的必填字段），PaperTeam 不维护自己的模型上下文表；
 * - 本模块的 token 数字全部是 **estimate**（显式标注），只用于调用
 *   provider 之前的预算判断；provider 返回的真实 usage（run 级
 *   usage.contextTokens）永远优先覆盖估算值；
 * - 不引入 tokenizer 依赖（仓库没有，也不为估算精度引入）。
 */

/**
 * 中日韩字符的保守 token 系数。
 *
 * Pi 自带的 estimateTokens 用 chars/4 启发式（对英文保守高估，注释自称
 * "conservative (overestimates tokens)"），但对中文严重低估：常见 BPE
 * （cl100k / o200k / GLM 系）对中文普遍在 0.6–1.1 token/字符之间，
 * chars/4 会把中文预算低估 3–6 倍。PaperTeam 的 prompt 主体是中文论文
 * 内容，估算必须 CJK 感知：
 * - CJK 字符按 1.5 token/字符计（相对真实值 0.6–1.1 是保守高估，
 *   对 preflight guard 而言宁可高估）；
 * - 其余字符沿用 chars/4（与 Pi 同口径）。
 */
const CJK_TOKENS_PER_CHAR = 1.5;
const OTHER_CHARS_PER_TOKEN = 4;

/** CJK 相关码位（含汉字各扩展区、假名、谚文、全角形式与 CJK 标点） */
function isCjkCodepoint(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x303f) || // CJK 标点 、。「」
    (code >= 0x3040 && code <= 0x30ff) || // 平假名 + 片假名
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // 基本区
    (code >= 0xac00 && code <= 0xd7af) || // 谚文音节
    (code >= 0xf900 && code <= 0xfaff) || // 兼容表意
    (code >= 0xff00 && code <= 0xffef) || // 全角形式
    (code >= 0x20000 && code <= 0x2ffff) // 扩展 B 及以上
  );
}

/**
 * 文本 token 估算（CJK 感知；显式 estimate）。
 * 空串返回 0；只用于 preflight guard，不用于计费 / 统计。
 */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let cjkChars = 0;
  let otherChars = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (isCjkCodepoint(code)) {
      cjkChars += 1;
    } else {
      otherChars += 1;
    }
  }
  return Math.ceil(cjkChars * CJK_TOKENS_PER_CHAR + otherChars / OTHER_CHARS_PER_TOKEN);
}

/** 下一次 prompt 的输入 token 估算（任务文本本体；estimate） */
export function estimatePromptTokens(message: string): number {
  return estimateTextTokens(message);
}

/**
 * 会话既有消息的上下文 token 估算（estimate；provider 未返回 usage 时的
 * fallback）。对 Pi AgentMessage 做防御性 duck-typing：只统计文本类内容
 * （text / thinking / toolCall 参数 / 用户与工具结果文本），读不出的消息
 * 记 0——返回 undefined 表示连消息列表都不可读（调用方进入 unknown 状态）。
 */
export function estimateSessionContextTokens(
  messages: readonly unknown[] | undefined,
): number | undefined {
  if (messages === undefined) {
    return undefined;
  }
  let total = 0;
  for (const message of messages) {
    if (typeof message !== "object" || message === null) {
      continue;
    }
    const role = (message as { role?: unknown }).role;
    if (role === "assistant") {
      const content = (message as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== "object" || block === null) {
            continue;
          }
          const record = block as { type?: unknown; text?: unknown; thinking?: unknown; name?: unknown; arguments?: unknown };
          if (typeof record.text === "string") {
            total += estimateTextTokens(record.text);
          }
          if (typeof record.thinking === "string") {
            total += estimateTextTokens(record.thinking);
          }
          if (typeof record.name === "string" || record.arguments !== undefined) {
            const serialized = `${record.name ?? ""}${JSON.stringify(record.arguments ?? {})}`;
            total += estimateTextTokens(serialized);
          }
        }
      }
      continue;
    }
    // user / toolResult / custom：content 为字符串或内容块数组
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      total += estimateTextTokens(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === "object" && block !== null) {
          const text = (block as { text?: unknown }).text;
          if (typeof text === "string") {
            total += estimateTextTokens(text);
          }
        } else if (typeof block === "string") {
          total += estimateTextTokens(block);
        }
      }
    }
  }
  return total;
}

// ---- 输出预留（Output Reserve，任务 H3） ----

/**
 * 预留比例与上限的默认依据：
 * - Pi 自身 compaction 默认 reserveTokens = 16384（上游同源参考）；
 * - PaperTeam 长论文调用形态（Writer 整节修订 / Reviewer 结构化审稿）单轮
 *   输出通常在几千到一两万 token，32k 上限留足余量；
 * - 比例 25%：200k 窗口模型至少保留 75% 给输入（长 Evidence + 稿件全文），
 *   同时小窗口模型也能拿到成比例的输出空间；
 * - 上限 32768：避免 1M 窗口模型预留出荒谬的输出空间（预留在 prompt 之后
 *   空着也是浪费）。
 */
export const DEFAULT_RESERVE_RATIO = 0.25;
export const DEFAULT_RESERVE_CEILING = 32_768;
/** 显式配置的合法范围（config 层同口径校验） */
export const OUTPUT_RESERVE_MIN = 1_024;
export const OUTPUT_RESERVE_MAX = 262_144;

/**
 * 计算下一次 prompt 前必须为模型输出预留的 token 数。
 *
 * 公式：reserve = min(model.maxTokens, ceil(contextWindow × 25%), 32768)
 * 显式配置（PAPERTEAM_PI_OUTPUT_RESERVE_TOKENS）时改用配置值，但仍被
 * 夹紧到 [1024, 262144] 且不超过 model.maxTokens（不超过模型真实能力）。
 * 不机械预留完整 maxTokens：200k 窗口 + 128k maxTokens 的模型只会预留
 * 32k，而不是让输入空间只剩 72k。
 */
export function computeOutputReserve(
  contextWindow: number,
  maxTokens: number,
  configuredReserve?: number,
): number {
  const windowBased = Math.ceil(contextWindow * DEFAULT_RESERVE_RATIO);
  // 模型真实输出能力（maxTokens 缺省/非法时退回上限常量）
  const cap = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_RESERVE_CEILING;
  let reserve: number;
  if (configuredReserve !== undefined) {
    reserve = Math.min(Math.max(configuredReserve, OUTPUT_RESERVE_MIN), OUTPUT_RESERVE_MAX);
  } else {
    reserve = Math.min(windowBased, DEFAULT_RESERVE_CEILING);
  }
  // 绝不超过模型真实能力（小 maxTokens 模型按其能力封顶）
  return Math.max(1, Math.floor(Math.min(reserve, cap)));
}
