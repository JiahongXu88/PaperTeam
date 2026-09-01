/**
 * 论文生成最小工作流（M2）：
 *
 *   ProjectService → WriterService → AgentRuntime.runAgent()
 *   → OpenClawRuntimeAdapter → Writer 返回 LaTeX
 *   → 写入 manuscript/main.tex → LatexCompiler → build/paper.pdf
 *
 * 只编排，不含业务判断以外的逻辑；多 Agent 调度属于后续里程碑。
 */

import { mkdir, writeFile } from "node:fs/promises";

import { toBusinessError } from "../errors.js";
import type { LatexCompileResult, LatexCompiler } from "../latex/LatexCompiler.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { WriterService } from "../writer/WriterService.js";

export interface GenerationServiceOptions {
  projects: ProjectStore;
  writer: WriterService;
  latex: LatexCompiler;
  /** 诊断日志 */
  log?: (message: string) => void;
}

export interface GenerationResult {
  projectId: string;
  /** Writer 的 Agent 任务 id（诊断用） */
  taskId: string;
  /** manuscript/main.tex 相对项目根的路径 */
  mainTexPath: string;
  compile: {
    ok: boolean;
    tool: string;
    durationMs: number;
    /** build/paper.pdf 相对项目根的路径（编译成功时存在） */
    pdfPath?: string;
    logPath?: string;
    error?: string;
  };
}

export class GenerationService {
  private readonly projects: ProjectStore;
  private readonly writer: WriterService;
  private readonly latex: LatexCompiler;
  private readonly log: (message: string) => void;

  constructor(options: GenerationServiceOptions) {
    this.projects = options.projects;
    this.writer = options.writer;
    this.latex = options.latex;
    this.log = options.log ?? (() => {});
  }

  /**
   * 对已存在的项目执行一次「Writer 写作 + LaTeX 编译」。
   * 项目不存在 / Writer 失败 / 编译失败分别抛对应业务错误。
   * 会话连续性（M2.1）：把 project.json 里的 runtimeSessionKey 传给 Writer
   * 复用；成功后把本次实际使用的会话引用写回，失败不改变已存引用。
   */
  async generate(params: { projectId: string; prompt: string }): Promise<GenerationResult> {
    const project = await this.projects.getRequired(params.projectId);

    let result: GenerationResult;
    try {
      const written = await this.writer.write({
        projectId: project.id,
        prompt: params.prompt,
        ...(project.runtimeSessionKey
          ? { sessionKey: project.runtimeSessionKey }
          : {}),
      });
      await this.persistRuntimeSession(project.id, written.task.metadata?.["sessionKey"]);

      const manuscriptDir = this.projects.manuscriptDir(project.id);
      await mkdir(manuscriptDir, { recursive: true });
      await writeFile(this.projects.mainTexPath(project.id), written.latex + "\n", "utf8");
      this.log(`[generation] ${project.id} main.tex 已写入（${written.latex.length} 字符）`);

      const compile = await this.compileBestEffort(project.id, manuscriptDir);

      result = {
        projectId: project.id,
        taskId: written.task.taskId,
        mainTexPath: "manuscript/main.tex",
        compile,
      };
    } catch (error) {
      const businessError = toBusinessError(error);
      this.log(`[generation] ${project.id} 生成失败：${businessError.code} ${businessError.message}`);
      await this.safeUpdateStatus(project.id, "failed");
      throw businessError;
    }

    await this.safeUpdateStatus(project.id, result.compile.ok ? "generated" : "failed");
    return result;
  }

  /** 编译失败不覆盖写作阶段的错误语义：写作产物已落盘时把编译错误如实带回 */
  private async compileBestEffort(
    projectId: string,
    manuscriptDir: string,
  ): Promise<GenerationResult["compile"]> {
    let compile: LatexCompileResult;
    try {
      compile = await this.latex.compile({
        manuscriptDir,
        buildDir: this.projects.buildDir(projectId),
      });
    } catch (error) {
      // 工具缺失 / 编译失败 / 超时 → 结构化带回，不中断响应
      const businessError = toBusinessError(error);
      this.log(`[generation] ${projectId} 编译失败：${businessError.code} ${businessError.message}`);
      return {
        ok: false,
        tool: "unknown",
        durationMs: 0,
        error: `${businessError.message}${businessError.detail ? `（${businessError.detail}）` : ""}`,
      };
    }
    return {
      ok: compile.ok,
      tool: compile.tool,
      durationMs: compile.durationMs,
      ...(compile.pdfPath !== null ? { pdfPath: "build/paper.pdf" } : {}),
      ...(compile.logPath !== null ? { logPath: "build/compile.log" } : {}),
      ...(compile.error !== undefined ? { error: compile.error } : {}),
    };
  }

  private async safeUpdateStatus(projectId: string, status: "generated" | "failed"): Promise<void> {
    try {
      await this.projects.updateStatus(projectId, status);
    } catch (error) {
      // 状态更新失败不影响主流程，只记日志
      this.log(`[generation] ${projectId} 状态更新失败：${String(error)}`);
    }
  }

  /** 会话引用写回失败不影响主流程（下次生成会重新派生/复用旧值） */
  private async persistRuntimeSession(projectId: string, sessionKey: unknown): Promise<void> {
    if (typeof sessionKey !== "string" || sessionKey === "") {
      return;
    }
    try {
      await this.projects.updateRuntimeSessionKey(projectId, sessionKey);
    } catch (error) {
      this.log(`[generation] ${projectId} 会话引用写回失败：${String(error)}`);
    }
  }
}
