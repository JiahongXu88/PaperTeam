/**
 * M14.1c：学位论文文档模型服务（保存 / 装配 / 编译门面）。
 *
 * 存储：manuscript/thesis.json（模型，作者可编辑）；装配产物进
 * manuscript-thesis/（确定性重建，可随时删除）；编译产物进 build-thesis/。
 * 不新建 Workflow Stage——完整 thesis_from_papers 工作流是 M14.2。
 *
 * 编译超时：学位论文（长文档 / 高校模板冷启动）用独立预算
 * （config.latex.thesisCompileTimeoutMs，缺省 600s），不共用普通论文的 120s。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError, NotFoundError } from "../errors.js";
import type { LatexCompiler, LatexCompileResult } from "../latex/LatexCompiler.js";
import type { Outline } from "../manuscript/ManuscriptService.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { writeFileAtomic } from "../util/atomic.js";
import { assembleThesisManuscript, type ThesisAssemblyResult } from "./thesisAssembler.js";
import { validateThesisDocumentModel, type ThesisDocumentModel } from "./thesisDocumentTypes.js";

export class ThesisDocumentService {
  constructor(
    private readonly projects: ProjectStore,
    private readonly latex: LatexCompiler,
  ) {}

  modelPath(projectId: string): string {
    return join(this.projects.manuscriptDir(projectId), "thesis.json");
  }

  thesisManuscriptDir(projectId: string): string {
    return join(this.projects.projectDir(projectId), "manuscript-thesis");
  }

  thesisBuildDir(projectId: string): string {
    return join(this.projects.projectDir(projectId), "build-thesis");
  }

  async loadModel(projectId: string): Promise<ThesisDocumentModel | null> {
    await this.projects.getRequired(projectId);
    try {
      const raw = await readFile(this.modelPath(projectId), "utf8");
      return JSON.parse(raw) as ThesisDocumentModel;
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  /** 保存模型（对当前 outline 校验；用户输入错误 → 400，违规拒绝落盘） */
  async saveModel(projectId: string, model: ThesisDocumentModel, outline: Outline): Promise<ThesisDocumentModel> {
    await this.projects.getRequired(projectId);
    const violations = this.validateAgainstOutline(model, outline);
    if (violations.length > 0) {
      throw new BusinessError("INVALID_REQUEST", `学位论文文档模型校验未通过：${violations.join("；")}`);
    }
    await writeFileAtomic(this.modelPath(projectId), `${JSON.stringify(model, null, 2)}\n`);
    return model;
  }

  private validateAgainstOutline(model: ThesisDocumentModel, outline: Outline): string[] {
    return validateThesisDocumentModel(model, {
      sectionFiles: outline.sections.map((section) => section.file),
      sectionTitles: new Map(outline.sections.map((section) => [section.file, section.title])),
    });
  }

  /** 确定性装配（幂等：同模型 + 同源 → byte-identical 产物） */
  async assemble(projectId: string, outline: Outline, model?: ThesisDocumentModel): Promise<ThesisAssemblyResult> {
    await this.projects.getRequired(projectId);
    const resolved = model ?? (await this.loadModel(projectId));
    if (resolved === null) {
      throw new NotFoundError("学位论文文档模型", this.modelPath(projectId));
    }
    return assembleThesisManuscript({
      model: resolved,
      outline,
      manuscriptDir: this.projects.manuscriptDir(projectId),
      targetDir: this.thesisManuscriptDir(projectId),
    });
  }

  /** 编译装配产物（xelatex + bibtex/biber 由模型 bibliography 决定） */
  async compile(projectId: string): Promise<LatexCompileResult> {
    await this.projects.getRequired(projectId);
    const model = await this.loadModel(projectId);
    if (model === null) {
      throw new NotFoundError("学位论文文档模型", this.modelPath(projectId));
    }
    return this.latex.compile({
      manuscriptDir: this.thesisManuscriptDir(projectId),
      buildDir: this.thesisBuildDir(projectId),
      // 模型声明的后端流入编译（缺省 auto：按 .bcf / \bibdata 产物判定）
      ...(model.bibliography !== undefined ? { bibliography: model.bibliography } : {}),
    });
  }
}
