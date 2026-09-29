/**
 * Revision Response / Revision Trace（M10.3 §15：确定性、无 LLM）。
 *
 * 把 PT-OUTCOMES / 指令状态 / 修订计划条目 / 复核结果投影为正式产物
 * build/revision-response.md。每条外部意见：
 *   Original instruction → Status → Change made → Affected section →
 *   Evidence → Conflict / unresolved reason
 *
 * 定位是 Revision Trace / Author Revision Report（作者修订轨迹报告），
 * **不是** Response Letter——本轮没有第二轮审稿意见，不假装是正式回复函；
 * 无据可写的地方如实写「未派发 / 无变化」，不编造执行内容。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ProjectStore } from "../project/ProjectStore.js";
import type { ReviewArtifactStore } from "./reviewArtifacts.js";
import type { ExternalInstructionStore, ExternalInstruction } from "./externalInstructions.js";
import {
  EXTERNAL_SOURCE_LABELS,
} from "./externalInstructions.js";
import type { RevisionPlan } from "./revisionPlan.js";
import type { RevisionValidationResult } from "./revisionValidation.js";

export interface RevisionResponseInput {
  instructions: ExternalInstruction[];
  plans: RevisionPlan[];
  validation: RevisionValidationResult | null;
  improvementPlan: {
    items: {
      section: string;
      action: string;
      rationale?: string;
      priority?: string;
      instructionId?: string;
      relatedEvidenceIds?: string[];
    }[];
  } | null;
  revision: number;
  finalArtifactId: string | null;
  draftArtifactId: string | null;
  generatedAt: string;
}

const STATUS_LABELS: Record<ExternalInstruction["status"], string> = {
  pending: "未派发",
  handled: "已执行（本轮系统派发并核实）",
  partially_handled: "部分执行",
  unresolved: "已派发未落实",
  conflict: "与实验事实冲突（未篡改数据）",
  already_satisfied: "已在当前稿落实（导入登记）",
};

function quoteBlock(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

/** 构建报告 markdown（纯函数） */
export function buildRevisionResponseMarkdown(input: RevisionResponseInput): string {
  const lines: string[] = [];
  lines.push("# Revision Trace / Author Revision Report");
  lines.push("");
  lines.push(`> 生成时间：${input.generatedAt}`);
  lines.push(`> 当前修订：rev-${input.revision}`);
  lines.push(
    `> 产物：${input.finalArtifactId !== null ? `Final ${input.finalArtifactId}` : input.draftArtifactId !== null ? `Draft ${input.draftArtifactId}` : "（无构建产物）"}`,
  );
  lines.push(">");
  lines.push(
    "> 说明：本报告是修订轨迹（Revision Trace）——逐条记录外部意见与修订计划条目的处置。"
    + "本轮没有新的审稿意见输入时，它不是 Response Letter；已有意见按导入时登记的状态如实呈现。",
  );
  lines.push("");

  // ---- 一、外部意见逐条 ----
  lines.push("## 一、外部修改意见（逐条）");
  lines.push("");
  if (input.instructions.length === 0) {
    lines.push("（本轮没有登记任何外部修改意见——不存在虚构的 Reviewer 意见。）");
  }
  for (const instruction of input.instructions) {
    const label = `${EXTERNAL_SOURCE_LABELS[instruction.source]}${instruction.reviewerLabel !== undefined ? ` · ${instruction.reviewerLabel}` : ""}`;
    lines.push(`### ${instruction.instructionId}（${label}）`);
    lines.push("");
    lines.push(quoteBlock(instruction.text.slice(0, 1200)));
    lines.push("");
    lines.push(`- **Status**：${STATUS_LABELS[instruction.status]}`);
    if (instruction.section !== undefined) {
      lines.push(`- **Affected section**：${instruction.section}`);
    }
    if (instruction.status === "already_satisfied") {
      lines.push(`- **依据**：${instruction.statusNote ?? "导入时登记（已在当前稿落实）"}`);
    }
    if (instruction.status === "conflict") {
      lines.push(`- **Conflict reason**：${instruction.conflictBasis ?? instruction.statusNote ?? "与稿件实验事实 / Evidence 冲突，保留原结果"}`);
    }
    if (instruction.status === "unresolved" || instruction.status === "partially_handled") {
      lines.push(`- **Unresolved reason**：${instruction.statusNote ?? "派发目标未产生真实变化"}`);
    }
    // Change made：改进计划中挂接该意见的条目 + 计划条目终态
    const linked = (input.improvementPlan?.items ?? []).filter(
      (item) => item.instructionId === instruction.instructionId,
    );
    const planItems = input.plans
      .flatMap((plan) => plan.items)
      .filter((item) => item.instructionId === instruction.instructionId);
    const changes = [
      ...linked.map((item) => `改进计划条目：${item.action.slice(0, 200)}（${item.section}）`),
      ...planItems.map(
        (item) =>
          `修订条目 ${item.id}［${item.status}${item.targetChanged === true ? " / 已产生文本变化" : ""}］：${item.instruction.slice(0, 160)}`,
      ),
    ];
    lines.push(
      `- **Change made**：${changes.length > 0 ? changes.join("；") : instruction.status === "handled" ? "（见派发轮执行记录）" : "（无——本轮未派发或未产生变化）"}`,
    );
    const evidenceIds = [
      ...new Set([
        ...linked.flatMap((item) => item.relatedEvidenceIds ?? []),
        ...planItems.flatMap((item) => item.relatedEvidenceIds ?? []),
      ]),
    ];
    lines.push(`- **Evidence**：${evidenceIds.length > 0 ? evidenceIds.join("、") : "（无关联证据）"}`);
    lines.push("");
  }

  // ---- 二、修订计划条目汇总 ----
  lines.push("## 二、修订计划条目（含改进计划）");
  lines.push("");
  if (input.improvementPlan !== null && input.improvementPlan.items.length > 0) {
    lines.push("### Existing-Paper 改进计划（revision.apply 派发源）");
    lines.push("");
    lines.push("| # | Section | Action | Priority | Evidence | 意见 |");
    lines.push("|---|---------|--------|----------|----------|------|");
    input.improvementPlan.items.forEach((item, index) => {
      lines.push(
        `| ${index + 1} | ${item.section} | ${item.action.replace(/\|/g, "\\|").slice(0, 160)} | ${item.priority ?? "-"} | ${(item.relatedEvidenceIds ?? []).join("、") || "-"} | ${item.instructionId ?? "-"} |`,
      );
    });
    lines.push("");
  }
  for (const plan of input.plans) {
    const applied = plan.items.filter((item) => item.status !== "planned" && item.status !== "skipped").length;
    lines.push(`### ${plan.planId}（依据 review r${plan.reviewRound}，源修订 rev-${plan.sourceRevision}）`);
    lines.push("");
    lines.push(`条目 ${plan.items.length} 项（派发 ${applied} 项 / 计划外记录 ${plan.items.length - applied} 项）。`);
    lines.push("");
    if (plan.items.length > 0) {
      lines.push("| Item | Kind | Section | Status | 说明 |");
      lines.push("|------|------|---------|--------|------|");
      for (const item of plan.items) {
        const note = item.resolution ?? item.note ?? item.instruction.slice(0, 100);
        lines.push(
          `| ${item.id} | ${item.kind} | ${item.section} | ${item.status} | ${note.replace(/\|/g, "\\|").slice(0, 140)} |`,
        );
      }
      lines.push("");
    }
  }
  if (input.plans.length === 0 && (input.improvementPlan === null || input.improvementPlan.items.length === 0)) {
    lines.push("（没有可追溯的修订计划条目。）");
    lines.push("");
  }

  // ---- 三、修订复核 ----
  lines.push("## 三、Revision Validation（条目级复核）");
  lines.push("");
  if (input.validation === null) {
    lines.push("（无修订复核产物——本轮没有触发条目级复核。）");
  } else {
    lines.push(
      `- 复核范围：rev-${input.validation.sourceRevision} → rev-${input.validation.revision}（${input.validation.validationId}）`,
    );
    lines.push(
      `- 结果：validated ${input.validation.items.filter((item) => item.status === "validated").length} / rejected ${input.validation.items.filter((item) => item.status === "rejected").length} / needs_review ${input.validation.items.filter((item) => item.status === "needs_review").length}`,
    );
    if (input.validation.factPreservation !== null && input.validation.factPreservation !== undefined) {
      lines.push(`- Fact Preservation：${input.validation.factPreservation.ok ? "通过" : "未通过"}`);
    }
    if (input.validation.citationPreservation !== null && input.validation.citationPreservation !== undefined) {
      lines.push(`- Citation Preservation：${input.validation.citationPreservation.ok ? "通过" : "未通过"}`);
    }
    for (const item of input.validation.rejectedItems ?? []) {
      lines.push(`- rejected：${item.id}（${item.category}）${item.reason.slice(0, 120)}`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    "报告纪律：以上内容全部由系统状态确定性投影生成（指令状态机 + 修订计划条目 + 复核产物），没有 LLM 改写；"
    + "「无据可写」的位置如实标注，不编造执行内容。",
  );
  lines.push("");
  return lines.join("\n");
}

export interface RevisionResponseDeps {
  projects: ProjectStore;
  reviewArtifacts: ReviewArtifactStore;
  externalInstructions: ExternalInstructionStore;
}

export interface RevisionResponseResult {
  path: string;
  instructions: number;
  planItems: number;
  improvementItems: number;
}

/** 读取项目状态并产出 build/revision-response.md（确定性） */
export async function writeRevisionResponse(
  deps: RevisionResponseDeps,
  projectId: string,
  artifacts: {
    revision: number;
    finalArtifactId: string | null;
    draftArtifactId: string | null;
  },
): Promise<RevisionResponseResult> {
  const { mkdir } = await import("node:fs/promises");
  const [instructions, planRounds, validation] = await Promise.all([
    deps.externalInstructions.load(projectId),
    deps.reviewArtifacts.planRounds(projectId),
    deps.reviewArtifacts.latestValidation(projectId),
  ]);
  const plans: RevisionPlan[] = [];
  for (const round of [...planRounds].reverse()) {
    const plan = await deps.reviewArtifacts.loadPlan(projectId, round);
    if (plan !== null) {
      plans.push(plan);
    }
  }
  let improvementPlan: RevisionResponseInput["improvementPlan"] = null;
  try {
    const parsed = JSON.parse(
      await readFile(join(deps.projects.researchDir(projectId), "improvement-plan.json"), "utf8"),
    ) as {
      plan?: {
        items?: {
          section?: unknown;
          action?: unknown;
          rationale?: unknown;
          priority?: unknown;
          instructionId?: unknown;
          relatedEvidenceIds?: unknown;
        }[];
      };
    };
    const items = (parsed.plan?.items ?? [])
      .filter(
        (item): item is NonNullable<typeof item> =>
          typeof item?.section === "string" && typeof item?.action === "string",
      )
      .map((item) => ({
        section: item.section as string,
        action: item.action as string,
        ...(typeof item.rationale === "string" ? { rationale: item.rationale } : {}),
        ...(typeof item.priority === "string" ? { priority: item.priority } : {}),
        ...(typeof item.instructionId === "string" ? { instructionId: item.instructionId } : {}),
        ...(Array.isArray(item.relatedEvidenceIds)
          ? {
              relatedEvidenceIds: item.relatedEvidenceIds.filter(
                (id): id is string => typeof id === "string",
              ),
            }
          : {}),
      }));
    improvementPlan = items.length > 0 ? { items } : null;
  } catch {
    improvementPlan = null;
  }
  const markdown = buildRevisionResponseMarkdown({
    instructions,
    plans,
    validation,
    improvementPlan,
    revision: artifacts.revision,
    finalArtifactId: artifacts.finalArtifactId,
    draftArtifactId: artifacts.draftArtifactId,
    generatedAt: new Date().toISOString(),
  });
  const buildDir = deps.projects.buildDir(projectId);
  await mkdir(buildDir, { recursive: true });
  const target = join(buildDir, "revision-response.md");
  const { writeFileAtomic } = await import("../util/atomic.js");
  await writeFileAtomic(target, markdown);
  return {
    path: "build/revision-response.md",
    instructions: instructions.length,
    planItems: plans.reduce((sum, plan) => sum + plan.items.length, 0),
    improvementItems: improvementPlan?.items.length ?? 0,
  };
}
