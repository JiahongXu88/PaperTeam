/**
 * Idea-to-Paper Workflow 定义（M3.0 最小形态）。
 *
 * M3.0 交付编排地基：本定义把 M2 的「Writer 写作 + LaTeX 编译」闭环升级为
 * 异步 WorkflowRun（DoD 校验、checkpoint、事件、取消齐备）。
 * M3.1 将在写作之前插入 Research → Feasibility → HITL → Outline → 分节写作。
 */

import { readFile } from "node:fs/promises";

import type { GenerationService } from "../generation/GenerationService.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { BusinessError } from "../errors.js";
import type {
  PlanDecision,
  ResumeInput,
  StageSpec,
  WorkflowDefinition,
  WorkflowState,
} from "./types.js";

export interface WorkflowServices {
  projects: ProjectStore;
  generation: GenerationService;
  stageTimeoutMs: number;
  stageMaxAttempts: number;
}

/** writing.document：完整文档写作（复用 M2 GenerationService 链路） */
function writingDocumentStage(services: WorkflowServices): StageSpec {
  return {
    id: "writing.document",
    description: "Writer 撰写完整论文并编译 PDF",
    requiredInputs: [],
    producedOutputs: ["manuscript/main.tex", "build/paper.pdf"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs,
    retryable: ["transient", "timeout", "runtime_unavailable"],
    async execute(ctx) {
      const prompt = readString(ctx.state.request?.["prompt"]);
      const project = await services.projects.getRequired(ctx.projectId);
      const result = await services.generation.generate({
        projectId: ctx.projectId,
        prompt: prompt ?? `围绕「${project.title}」撰写一篇简短的学术论文`,
      });
      return {
        taskId: result.taskId,
        mainTexPath: result.mainTexPath,
        compileOk: result.compile.ok,
        compileTool: result.compile.tool,
        ...(result.compile.pdfPath !== undefined ? { pdfPath: result.compile.pdfPath } : {}),
        ...(result.compile.error !== undefined ? { compileError: result.compile.error } : {}),
      };
    },
    async verifyDod(ctx) {
      // DoD：main.tex 存在、非空、是 LaTeX 文档（确定性文件检查，不信任 Agent 自述）
      const violations: string[] = [];
      const texPath = services.projects.mainTexPath(ctx.projectId);
      try {
        const content = await readFile(texPath, "utf8");
        if (content.trim() === "") {
          violations.push("manuscript/main.tex 为空");
        }
        if (!content.includes("\\documentclass")) {
          violations.push("manuscript/main.tex 不包含 \\documentclass");
        }
      } catch {
        violations.push("manuscript/main.tex 不存在");
      }
      return violations;
    },
  };
}

export function createIdeaToPaperDefinition(services: WorkflowServices): WorkflowDefinition {
  const stages: readonly StageSpec[] = [writingDocumentStage(services)];

  return {
    kind: "idea_to_paper",
    description: "Idea-to-Paper（M3.0 最小形态：单文档写作；M3.1 扩展调研与可行性前置）",
    stages,
    plan(state: WorkflowState): PlanDecision {
      if ("writing.document" in state.stageResults) {
        const result = state.stageResults["writing.document"] ?? {};
        return {
          kind: "complete",
          // M3.0 无 Quality Gate，一律 Draft（Final 判定属于 M3.2）
          label: "draft",
          summary: {
            mainTexPath: result["mainTexPath"] ?? "manuscript/main.tex",
            compileOk: result["compileOk"] ?? false,
          },
        };
      }
      return { kind: "stage", stageId: "writing.document" };
    },
    async onInput(_state: WorkflowState, _stageId: string, _input: ResumeInput): Promise<void> {
      // M3.0 的 idea_to_paper 无 HITL stage；resume 一定来自非法调用
      throw new BusinessError("WORKFLOW_INVALID_STATE", "当前 Workflow 没有等待用户输入的节点");
    },
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
