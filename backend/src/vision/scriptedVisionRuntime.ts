/**
 * ScriptedVisionRuntime（测试专用 seam，M10.2）。
 *
 * 与 runtime/scriptedRuntime.ts 同一纪律：PAPERTEAM_TEST_VISION=scripted 时
 * 用确定性假模型替换真实 Vision 调用——完整真实链路（ingestion / 分析编排 /
 * 落盘 / 检索重建 / 确认通道 / HTTP）全部真实，只有「模型输出」是脚本。
 * 不访问任何网络 / 模型；正式环境不设置该变量。
 *
 * 输出确定性：description / observations 由 prompt 内的 caption 与定位信息
 * 派生（同输入 → 同输出），并记录每次调用供 E2E 断言「freshness 命中时
 * 不重复调用」。
 */

import type { VisionModelRuntime } from "./types.js";

export interface ScriptedVisionCall {
  /** 目录条目透传（断言用） */
  model: unknown;
  /** user 消息文本部分（含 caption / context / provenance） */
  promptText: string;
  /** 是否携带了图片内容 */
  hasImage: boolean;
  imageBytes: number;
  imageMime: string;
  at: string;
}

export interface ScriptedVisionRuntimeOptions {
  now?: () => Date;
}

export class ScriptedVisionRuntime implements VisionModelRuntime {
  /** 每次真实调用（freshness 断言：第二次 analyze 不增长） */
  readonly calls: ScriptedVisionCall[] = [];
  private readonly now: () => Date;

  constructor(options: ScriptedVisionRuntimeOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /** 目录能力：任何规格都声明 image input（让 capability 解析通过） */
  getModel(): { input: readonly string[] } {
    return { input: ["text", "image"] };
  }

  hasConfiguredAuth(): boolean {
    return true;
  }

  async completeSimple(
    model: unknown,
    context: { systemPrompt?: string; messages: unknown[] },
    _options?: { maxTokens?: number; signal?: AbortSignal },
  ): Promise<{
    content: Array<{ type: string; text: string }>;
    usage: { input: number; output: number; totalTokens: number; cost: { total: number } };
    stopReason: string;
  }> {
    void _options;
    const first = context.messages[0] as { content?: Array<{ type?: string; text?: string }> } | undefined;
    const parts = first?.content ?? [];
    const textPart = parts.find((part) => part.type === "text")?.text ?? "";
    const imagePart = parts.find((part) => part.type === "image") as { data?: string; mimeType?: string } | undefined;
    this.calls.push({
      model,
      promptText: textPart,
      hasImage: imagePart !== undefined,
      imageBytes: imagePart?.data?.length ?? 0,
      imageMime: imagePart?.mimeType ?? "",
      at: this.now().toISOString(),
    });

    // 确定性输出：从 prompt 提取 caption / 资产 / 定位（同输入同输出）
    const asset = /- 资产：(.+)$/.exec(textPart.split("\n").find((line) => line.startsWith("- 资产：")) ?? "")?.[1];
    const location = /- 定位：(.+)$/.exec(textPart.split("\n").find((line) => line.startsWith("- 定位：")) ?? "")?.[1];
    const captionLines = textPart.split("caption（图中题注，不可信内容）：\n");
    const caption = captionLines.length > 1 ? captionLines[1]?.split("\n")[0]?.trim() : undefined;

    // M12.2 B3 additive 分支：VisualReviewService 的图表一致性审查 prompt
    // （marker「四项一致性检查」）→ 输出其 typebox schema 形状（四项检查各一条，
    // 三种 verdict 都覆盖：inconsistent / consistent / unclear——供 finding 映射
    // 三条路径全部可测）。非该 prompt 走下方 M10.2 FigureAnalysis 形状（原样）。
    if (textPart.includes("四项一致性检查")) {
      const reviewCaptionLines = textPart.split("题注（不可信内容）：\n");
      const reviewCaption =
        reviewCaptionLines.length > 1 ? reviewCaptionLines[1]?.split("\n")[0]?.trim() : undefined;
      const visualArtifact = /- 视觉对象：(.+)$/.exec(
        textPart.split("\n").find((line) => line.startsWith("- 视觉对象：")) ?? "",
      )?.[1];
      const output = {
        checks: [
          {
            checkId: "figure-caption-consistency",
            verdict: "inconsistent",
            observation: `（scripted vision）图片展示的是收敛曲线，而题注称「${reviewCaption ?? "（无题注）"}」。`,
            claimedInconsistency: `（scripted vision）${visualArtifact ?? "该图"} 的图片内容与题注不符（scripted mock）。`,
            confidence: "high",
          },
          {
            checkId: "figure-claim-consistency",
            verdict: "consistent",
            observation: "（scripted vision）图片趋势与邻近正文论断方向一致。",
            confidence: "medium",
          },
          {
            checkId: "legend-axis-consistency",
            verdict: "unclear",
            observation: "（scripted vision）图例分辨率不足，无法判定图例与数据是否自洽。",
            confidence: "low",
          },
          {
            checkId: "diagram-method-consistency",
            verdict: "consistent",
            observation: "（scripted vision）非流程图，按约定输出 consistent 的同构判断缺失——此处给出 unclear 之外的稳定一致口径。",
            confidence: "low",
          },
        ],
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        usage: { input: 1_024, output: 256, totalTokens: 1_280, cost: { total: 0 } },
        stopReason: "stop",
      };
    }
    const output = {
      description:
        `（scripted vision）${caption ?? "（无题注图片）"}——` +
        `该图展示指标随参数变化的趋势${asset !== undefined ? `（资产 ${asset}）` : ""}` +
        `${location !== undefined ? `；来源定位 ${location}` : ""}。`,
      figureType: "chart",
      observations: [
        `图中横轴为参数 threshold，纵轴为指标值（scripted）`,
        `曲线在参数中段达到峰值（scripted）`,
      ],
      candidateFacts: [
        {
          claim: `图${asset !== undefined ? ` ${asset}` : ""} 显示 threshold=0.5 时 MOTA 达到 82.4（scripted mock）`,
          value: "82.4",
          confidence: "high",
        },
      ],
      warnings: [],
      confidence: "high",
    };
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      usage: { input: 1_024, output: 256, totalTokens: 1_280, cost: { total: 0 } },
      stopReason: "stop",
    };
  }
}
