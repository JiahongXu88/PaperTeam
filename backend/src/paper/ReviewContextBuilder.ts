/**
 * ReviewContextBuilder（M4.3.2）：section review 的受控上下文组装。
 *
 * 给任何 section review 任务组装且仅组装：
 *   1. 论文概览（标题 + 摘要，截断）
 *   2. 全文导航（各 section 标题/页码/一句摘要——绝不包含其他 section 全文）
 *   3. 当前 section 的完整 chunks
 *   4. 相关引用记录（可选注入，截断）
 *   5. 审阅要求（skill 名称 / 指令）
 *
 * 每次构建都从磁盘事实源（parsed 产物 + paper-map）重新组装——
 * Runtime Session 删除后 context 完全可重建；同一 section 重建结果确定。
 * budget 显式分项，可估算、可审计。
 */

import type { ProjectStore } from "../project/ProjectStore.js";
import { BusinessError } from "../errors.js";
import type { PaperChunk, PaperMap } from "./types.js";
import type { PaperStore } from "./PaperStore.js";

/** 各部分预算（字符）——超限截断并在 budget 中如实反映 */
const BUDGET = {
  abstract: 1500,
  sectionIndexPerEntry: 400,
  sectionIndexTotal: 3000,
  citationsTotal: 2500,
} as const;

export interface CitationContextEntry {
  referenceId: string;
  rawText: string;
  status?: string;
}

export interface SectionReviewContext {
  contextScope: string;
  sectionId: string;
  sectionTitle: string;
  paperTitle: string | undefined;
  chunks: PaperChunk[];
  /** 组装后的完整 prompt（review task 的任务文本） */
  prompt: string;
  budget: {
    paperOverviewChars: number;
    sectionIndexChars: number;
    currentSectionChars: number;
    citationsChars: number;
    totalChars: number;
  };
}

export interface ReviewContextBuilderOptions {
  projects: ProjectStore;
  store: PaperStore;
}

export class ReviewContextBuilder {
  private readonly projects: ProjectStore;
  private readonly store: PaperStore;

  constructor(options: ReviewContextBuilderOptions) {
    this.projects = options.projects;
    this.store = options.store;
  }

  /** 全部可审阅 section 的稳定 contextScope（短生命周期 review task 的会话键） */
  async listSectionScopes(projectId: string): Promise<
    Array<{ contextScope: string; sectionId: string; title: string; chunkCount: number }>
  > {
    const document = await this.store.loadDocument(projectId);
    if (document === null) {
      return [];
    }
    return document.sections.map((section) => ({
      contextScope: `review/section/${section.sectionId.toLowerCase()}`,
      sectionId: section.sectionId,
      title: section.title,
      chunkCount: document.chunks.filter((chunk) => chunk.sectionId === section.sectionId).length,
    }));
  }

  /**
   * 组装某个 section 的 review context（从磁盘事实源重建，无内存状态依赖）。
   * reviewSkill：要求的审阅 skill/指令（如 "verify-citations"）。
   */
  async buildSectionContext(
    projectId: string,
    sectionId: string,
    options: { reviewSkill?: string; citations?: CitationContextEntry[]; instruction?: string } = {},
  ): Promise<SectionReviewContext> {
    await this.projects.getRequired(projectId);
    const document = await this.store.loadDocument(projectId);
    if (document === null) {
      throw new BusinessError("INVALID_REQUEST", "尚未上传/解析 Final PDF");
    }
    const map = await this.store.loadMap(projectId);
    const section = document.sections.find((entry) => entry.sectionId === sectionId);
    if (section === undefined) {
      throw new BusinessError("INVALID_REQUEST", `章节不存在：${sectionId}`);
    }
    const chunks = document.chunks.filter((chunk) => chunk.sectionId === sectionId);
    if (chunks.length === 0) {
      throw new BusinessError("INVALID_REQUEST", `章节 ${sectionId} 没有可用文本 chunk`);
    }

    // 1. 论文概览（不含全文）
    const overviewParts: string[] = [];
    if (document.title !== undefined) {
      overviewParts.push(`标题：${document.title}`);
    }
    const abstract = await this.readAbstract(projectId, document.abstractSectionId);
    if (abstract !== undefined && abstract !== "") {
      overviewParts.push(`摘要：${abstract.slice(0, BUDGET.abstract)}`);
    }
    const overview = overviewParts.join("\n");

    // 2. 全文导航：其他 section 只给 标题 + 摘要（缺摘要如实标注），绝不给全文
    const indexLines: string[] = [];
    let indexChars = 0;
    for (const entry of map?.sections ?? document.sections) {
      if (entry.sectionId === sectionId) {
        continue;
      }
      const summary = "summary" in entry ? entry.summary : undefined;
      const summaryText =
        summary !== undefined && summary.status === "ok" && summary.summary
          ? summary.summary
          : "（摘要未生成）";
      const line = `- ${entry.sectionId} ${entry.title}（p${entry.pageStart}-${entry.pageEnd}）：${summaryText}`.slice(
        0,
        BUDGET.sectionIndexPerEntry,
      );
      if (indexChars + line.length > BUDGET.sectionIndexTotal) {
        break; // 预算耗尽即止（长文档导航截断如实发生）
      }
      indexLines.push(line);
      indexChars += line.length;
    }
    const sectionIndex = indexLines.join("\n");

    // 3. 当前 section 全文
    const sectionText = chunks
      .map((chunk) => `[${chunk.chunkId} p${chunk.pageStart}-${chunk.pageEnd}]\n${chunk.text}`)
      .join("\n\n");

    // 4. 相关引用（可选）
    const citationLines: string[] = [];
    let citationChars = 0;
    for (const citation of options.citations ?? []) {
      const line = `- ${citation.referenceId}${citation.status ? `（${citation.status}）` : ""}：${citation.rawText}`.slice(
        0,
        400,
      );
      if (citationChars + line.length > BUDGET.citationsTotal) {
        break;
      }
      citationLines.push(line);
      citationChars += line.length;
    }
    const citationBlock = citationLines.join("\n");

    // 5. 审阅要求
    const instruction =
      options.instruction ??
      [
        "你是论文审稿 Agent。请只审阅上面给出的当前章节文本，基于给出的材料输出结构化审稿结论。",
        options.reviewSkill !== undefined
          ? `审阅方法遵循 skill：${options.reviewSkill}。`
          : "",
        "不要引用未在上下文中提供的材料；对无法核验的内容明确说「无法核验」。",
      ]
        .filter((part) => part !== "")
        .join("\n");

    const promptParts: string[] = [];
    if (overview !== "") {
      promptParts.push(`【论文概览】\n${overview}`);
    }
    if (sectionIndex !== "") {
      promptParts.push(`【全文导航（其他章节摘要，不含全文）】\n${sectionIndex}`);
    }
    promptParts.push(`【当前章节：${sectionId} ${section.title}（p${section.pageStart}-${section.pageEnd}）】\n${sectionText}`);
    if (citationBlock !== "") {
      promptParts.push(`【本章节相关引用】\n${citationBlock}`);
    }
    promptParts.push(`【审阅要求】\n${instruction}`);
    const prompt = promptParts.join("\n\n");

    const budget = {
      paperOverviewChars: overview.length,
      sectionIndexChars: sectionIndex.length,
      currentSectionChars: sectionText.length,
      citationsChars: citationBlock.length,
      totalChars: prompt.length,
    };
    return {
      contextScope: `review/section/${sectionId.toLowerCase()}`,
      sectionId,
      sectionTitle: section.title,
      paperTitle: document.title,
      chunks,
      prompt,
      budget,
    };
  }

  private async readAbstract(projectId: string, abstractSectionId: string | undefined): Promise<string | undefined> {
    if (abstractSectionId === undefined) {
      return undefined;
    }
    const chunks = await this.store.loadChunks(projectId);
    return chunks
      .filter((chunk) => chunk.sectionId === abstractSectionId)
      .map((chunk) => chunk.text)
      .join("\n\n")
      .slice(0, BUDGET.abstract + 200);
  }
}
