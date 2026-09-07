/**
 * SkillSummaryService：中文简介一次生成、持久化。
 *
 * - 只对 summaryStatus != ok 的 skill 调用模型（2-3 句：干什么/什么时候有用）；
 * - 模型不可用/失败 → 保持 summary_pending，Skill discovery 照常成功
 *   （UI 显示原始 description，下次模型可用再生成）；
 * - 每次打开页面不重新调用模型——只有 contentHash 变化才 stale。
 */

import type { AgentRuntime } from "../runtime/types.js";
import type { SkillRegistry } from "./SkillRegistry.js";
import type { SkillMetadata } from "./types.js";

export interface SkillSummaryServiceOptions {
  registry: SkillRegistry;
  runtime: AgentRuntime;
  /** 生成简介用的 agent id（default 角色 scope） */
  agentId: string;
  log?: (message: string) => void;
}

export class SkillSummaryService {
  private readonly registry: SkillRegistry;
  private readonly runtime: AgentRuntime;
  private readonly agentId: string;
  private readonly log: (message: string) => void;

  /** telemetry */
  lastTelemetry: { modelCalls: number; generated: number; failed: number } | undefined;

  constructor(options: SkillSummaryServiceOptions) {
    this.registry = options.registry;
    this.runtime = options.runtime;
    this.agentId = options.agentId;
    this.log = options.log ?? (() => {});
  }

  /** 补齐缺失/过期的中文简介（不阻塞：单条失败跳过；only 只处理单个 skill） */
  async generateMissing(options: { force?: boolean; only?: string } = {}): Promise<{
    generated: SkillMetadata[];
    failed: string[];
  }> {
    const skills = await this.registry.list();
    const targets = skills.filter((skill) => {
      if (options.only !== undefined) {
        return skill.id === options.only;
      }
      return options.force === true || skill.summaryStatus !== "ok";
    });
    const generated: SkillMetadata[] = [];
    const failed: string[] = [];
    let modelCalls = 0;
    for (const skill of targets) {
      modelCalls += 1;
      try {
        const lines = [
          "你是 PaperTeam 的 Skill 管理助手。为下面的 Agent Skill 写 2-3 句中文简介，",
          "面向普通用户：第 1 句说明它干什么，第 2-3 句说明什么时候有用。",
          "要求：简洁、客观、不写营销文案、不使用列表或标题，直接输出简介正文。",
          "",
          `Skill 名称：${skill.name}`,
          `原始描述：${skill.originalDescription}`,
        ];
        if (skill.wrapperNote !== undefined) {
          lines.push(`（注：${skill.wrapperNote}）`);
        }
        const task = await this.runtime.runAgent({
          agentId: this.agentId,
          contextScope: `skills/summary/${skill.id}`,
          task: lines.join("\n"),
          metadata: { role: "default" },
        });
        if (task.status !== "completed" || (task.output ?? "").trim() === "") {
          throw new Error(task.error ?? "模型未返回简介");
        }
        const summary = task.output!.trim().slice(0, 500);
        const updated = await this.registry.saveSummary(skill.id, summary);
        if (updated !== null) {
          generated.push(updated);
        }
      } catch (error) {
        failed.push(skill.id);
        this.log(
          `[skills] ${skill.id} 简介生成失败（保持 summary_pending）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    this.lastTelemetry = { modelCalls, generated: generated.length, failed: failed.length };
    return { generated, failed };
  }
}
