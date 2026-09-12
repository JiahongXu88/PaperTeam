/**
 * Context Budget 估算与输出预留纯函数测试（M5.2 任务 H）。
 *
 * 核心断言口径：
 * - 中文估算必须 CJK 感知：同等字符数下显著高于 chars/4（Pi 启发式对
 *   中文低估 3-6 倍，preflight guard 用它等于形同虚设）；
 * - 输出预留不机械预留完整 maxTokens（200k 窗口 + 128k maxTokens 只留
 *   32k），也不超过模型真实能力（小 maxTokens 模型按能力封顶）；
 * - 全部数字是 estimate：provider 实测 usage 永远优先（在 Adapter 层
 *   由 managed.context.basis=measured 体现，本文件只测纯函数）。
 */

import { describe, expect, it } from "vitest";

import {
  computeOutputReserve,
  estimatePromptTokens,
  estimateSessionContextTokens,
  estimateTextTokens,
} from "../../src/runtime/pi/contextBudget.js";

describe("estimateTextTokens（CJK 感知估算）", () => {
  it("中文文本不低于 chars/4 的 4 倍口径（1.5 token/字符 vs 0.25）", () => {
    const chinese = "这是中文论文写作的一段示例文本"; // 14 个 CJK 字符
    expect(estimateTextTokens(chinese)).toBeGreaterThanOrEqual(21); // 14 × 1.5
    expect(estimateTextTokens(chinese)).toBeLessThanOrEqual(28); // 不荒谬高估
    // 对照：chars/4 会给出 4 —— 严重低估
    expect(estimateTextTokens(chinese)).toBeGreaterThan(Math.ceil(chinese.length / 4) * 2);
  });

  it("英文文本沿用 chars/4 口径（与 Pi 一致）", () => {
    const english = "abcdefghij"; // 10 字符 → 2.5 → ceil 3
    expect(estimateTextTokens(english)).toBe(3);
  });

  it("中英混合：CJK 与非 CJK 分别计价后求和", () => {
    const mixed = "论文".repeat(10) + "a".repeat(20); // 20 CJK + 20 ASCII
    // 20×1.5 + 20/4 = 30 + 5 = 35
    expect(estimateTextTokens(mixed)).toBe(35);
  });

  it("全角标点 / 假名 / 谚文都按 CJK 计价；空串为 0", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("、。「」")).toBeGreaterThanOrEqual(5); // 4 个全角 → 6
    expect(estimateTextTokens("こんにちは")).toBeGreaterThanOrEqual(7); // 5 假名 → 7.5 → 8
    expect(estimateTextTokens("한국어")).toBeGreaterThanOrEqual(5); // 3 谚文 → 4.5 → 5
  });

  it("estimatePromptTokens 与 estimateTextTokens 同口径（任务文本本体）", () => {
    const prompt = "请修改第三节".repeat(5);
    expect(estimatePromptTokens(prompt)).toBe(estimateTextTokens(prompt));
  });
});

describe("estimateSessionContextTokens（会话消息面估算）", () => {
  it("user 字符串 content / assistant 内容块（text / thinking / toolCall）都计入", () => {
    const messages = [
      { role: "user", content: "论".repeat(100) }, // 150
      {
        role: "assistant",
        content: [
          { type: "text", text: "答".repeat(40) }, // 60
          { type: "thinking", thinking: "思".repeat(20) }, // 30
          { type: "toolCall", name: "read", arguments: { path: "main.tex" } }, // 序列化长度
        ],
        stopReason: "stop",
      },
      { role: "toolResult", content: [{ type: "text", text: "x".repeat(40) }] }, // 10
    ];
    const total = estimateSessionContextTokens(messages);
    expect(total).toBeGreaterThan(150 + 60 + 30);
    expect(total).toBeGreaterThan(150 + 60 + 30 + 10 - 1);
  });

  it("空会话估 0（准确：无对话内容，不是 unknown 的伪装）", () => {
    expect(estimateSessionContextTokens([])).toBe(0);
  });

  it("messages 不可读时返回 undefined（unknown，绝不能猜 0）", () => {
    expect(estimateSessionContextTokens(undefined)).toBeUndefined();
  });

  it("读不出的消息形状记 0、不抛异常（防御性 duck-typing）", () => {
    expect(estimateSessionContextTokens([null, 42, { role: "weird" }])).toBe(0);
  });
});

describe("computeOutputReserve（输出预留公式，任务 H3）", () => {
  it("默认公式：min(maxTokens, ⌈window×25%⌉, 32768)", () => {
    // 128k 窗口 / 16k maxTokens（faux 默认形态）→ 16k（完整 maxTokens 可留）
    expect(computeOutputReserve(128_000, 16_384)).toBe(16_384);
    // 200k 窗口 / 128k maxTokens → 不机械预留完整 maxTokens：32k 封顶
    expect(computeOutputReserve(200_000, 131_072)).toBe(32_768);
    // 200k 窗口 / 8k maxTokens → 按模型能力 8k
    expect(computeOutputReserve(200_000, 8_192)).toBe(8_192);
    // 1M 窗口（比例项 250k 被 32k 封顶）
    expect(computeOutputReserve(1_000_000, 262_144)).toBe(32_768);
    // 小窗口：25% 比例生效（1600 × 0.25 = 400 < maxTokens）
    expect(computeOutputReserve(1_600, 1_024)).toBe(400);
  });

  it("显式配置：夹紧到 [1024, 262144] 且不超过模型真实能力", () => {
    expect(computeOutputReserve(200_000, 8_192, 4_096)).toBe(4_096); // 正常配置
    expect(computeOutputReserve(200_000, 65_536, 500)).toBe(1_024); // 过小抬到下限
    expect(computeOutputReserve(200_000, 8_192, 65_536)).toBe(8_192); // 超模型能力封顶
    expect(computeOutputReserve(200_000, 4_096, 8_388_608)).toBe(4_096); // 过大压到上限再封模型能力
    // 小 maxTokens 模型（< 1024）：绝不超过真实能力
    expect(computeOutputReserve(32_000, 512)).toBe(512);
  });

  it("maxTokens 缺省/非法：回退 32k 上限常量，仍受 25% 比例约束", () => {
    expect(computeOutputReserve(200_000, 0)).toBe(32_768);
    expect(computeOutputReserve(200_000, Number.NaN)).toBe(32_768);
    expect(computeOutputReserve(64_000, 0)).toBe(16_000); // 比例项 16k < 32k
  });
});
