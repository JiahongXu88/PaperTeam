/**
 * Paper Artifact Store（M4.7）。
 *
 * Draft / Final 产物的唯一权威存储：
 *   artifacts/manifest.json            产物登记表（append-only 语义）
 *   artifacts/art-{kind}-rev{n}.pdf    冻结的 PDF 副本（build/paper.pdf 的拷贝，
 *                                      后续编辑 / 重新编译不影响已冻结产物）
 *
 * - artifactId 确定性：art-draft-rev{n} / art-final-rev{n}（同修订幂等）；
 * - 下载只允许通过 manifest 解析（projectId + artifactId → 受控路径），
 *   不接受任何文件系统路径参数（防 path traversal）；
 * - Final 冻结后不可变：后续修订产生 rev n+1 的新产物，旧条目永不改写。
 */

import { copyFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { BusinessError, BuildGateFailedError, BuildGateStaleError, NotFoundError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { BuildGateRecord } from "../quality/gates.js";
import { writeJsonAtomic } from "../util/atomic.js";

export type PaperArtifactKind = "draft" | "final";

export interface PaperArtifactFileRef {
  /** artifacts/ 下的文件名 */
  name: string;
  mimeType: "application/pdf";
  bytes: number;
}

export interface PaperArtifact {
  artifactId: string;
  projectId: string;
  kind: PaperArtifactKind;
  /** 冻结时对应的 manuscript 修订 */
  revision: number;
  createdAt: string;
  buildGate: { passed: boolean; checkedAt: string; revision: number };
  /** Final 产物必带（Draft 缺省：Draft 只要求 Build Gate） */
  qualityGate?: { passed: boolean; round: number; checkedAt: string; reviewedRevision: number };
  file: PaperArtifactFileRef;
  sourceRunId?: string;
}

interface ArtifactManifest {
  schemaVersion: 1;
  artifacts: PaperArtifact[];
}

/** artifactId 形态（下载路由的同款校验） */
export const ARTIFACT_ID_PATTERN = /^art-(draft|final)-rev(\d+)$/;

export interface PaperArtifactStoreOptions {
  projects: ProjectStore;
  now?: () => Date;
}

export class PaperArtifactStore {
  private readonly projects: ProjectStore;
  private readonly now: () => Date;
  /** 每项目串行化 manifest 写入（并发 ensure/finalize 不交叉） */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(options: PaperArtifactStoreOptions) {
    this.projects = options.projects;
    this.now = options.now ?? (() => new Date());
  }

  /** manifest 读取（防御性；损坏 → 空清单） */
  async list(projectId: string): Promise<PaperArtifact[]> {
    return (await this.loadManifest(projectId)).artifacts;
  }

  /** 最新 Draft / Final（按 revision 最大；无则 null） */
  async latest(projectId: string): Promise<{ draft: PaperArtifact | null; final: PaperArtifact | null }> {
    const artifacts = await this.list(projectId);
    let draft: PaperArtifact | null = null;
    let final: PaperArtifact | null = null;
    for (const artifact of artifacts) {
      if (artifact.kind === "draft" && (draft === null || artifact.revision > draft.revision)) {
        draft = artifact;
      }
      if (artifact.kind === "final" && (final === null || artifact.revision > final.revision)) {
        final = artifact;
      }
    }
    return { draft, final };
  }

  /** manifest 解析产物（下载唯一入口：不接受路径参数） */
  async get(projectId: string, artifactId: string): Promise<PaperArtifact> {
    if (!ARTIFACT_ID_PATTERN.test(artifactId)) {
      throw new NotFoundError("Artifact", artifactId);
    }
    const artifacts = await this.list(projectId);
    const artifact = artifacts.find((candidate) => candidate.artifactId === artifactId);
    if (artifact === undefined) {
      throw new NotFoundError("Artifact", artifactId);
    }
    return artifact;
  }

  /** 产物 PDF 的绝对路径（只对 manifest 中存在的产物调用） */
  filePath(projectId: string, artifact: PaperArtifact): string {
    return join(this.projects.artifactsDir(projectId), artifact.file.name);
  }

  /**
   * 确保 Draft 产物存在（幂等：同 revision 已有 → 原样返回）。
   * 要求 build record 通过且 revision 对齐（质量语义不参与：Draft 只看 Build Gate）。
   */
  async ensureDraft(
    projectId: string,
    revision: number,
    build: BuildGateRecord,
    runId?: string,
  ): Promise<PaperArtifact> {
    return this.serialize(projectId, async () => {
      const manifest = await this.loadManifest(projectId);
      const existing = manifest.artifacts.find(
        (artifact) => artifact.kind === "draft" && artifact.revision === revision,
      );
      if (existing !== undefined) {
        return existing;
      }
      if (!build.passed) {
        throw new BuildGateFailedError(
          `revision ${revision} 的构建未通过（${build.reasons[0] ?? "编译失败"}）`,
        );
      }
      if (build.revision !== revision) {
        throw new BuildGateStaleError(
          `构建记录对应 revision ${build.revision}，当前请求冻结 revision ${revision}`,
        );
      }
      const artifact = await this.freeze(
        projectId,
        {
          artifactId: `art-draft-rev${revision}`,
          projectId,
          kind: "draft",
          revision,
          createdAt: this.now().toISOString(),
          buildGate: { passed: build.passed, checkedAt: build.checkedAt, revision: build.revision },
          file: { name: `art-draft-rev${revision}.pdf`, mimeType: "application/pdf", bytes: 0 },
          ...(runId !== undefined ? { sourceRunId: runId } : {}),
        },
        manifest,
      );
      return artifact;
    });
  }

  /**
   * 创建 Final 产物（幂等：同 revision 已有 → 原样返回）。
   * Gate 对齐校验由 FinalizeService 完成；这里只要求传入的 gate/build 事实自洽
   * （双 Gate 通过 + revision 一致），并确保同 revision 的 Draft 一并存在。
   */
  async createFinal(
    projectId: string,
    revision: number,
    input: {
      build: BuildGateRecord;
      gate: { passed: boolean; round: number; checkedAt: string; reviewedRevision: number };
    },
    runId?: string,
  ): Promise<{ final: PaperArtifact; draft: PaperArtifact }> {
    if (!input.gate.passed) {
      throw new BusinessError("QUALITY_GATE_FAILED", "Final 要求 Quality Gate 通过");
    }
    if (input.gate.reviewedRevision !== revision) {
      throw new QualityGateMisaligned(
        `gate 审阅的是 revision ${input.gate.reviewedRevision}，当前为 revision ${revision}`,
      );
    }
    const draft = await this.ensureDraft(projectId, revision, input.build, runId);
    const final = await this.serialize(projectId, async () => {
      const manifest = await this.loadManifest(projectId);
      const existing = manifest.artifacts.find(
        (artifact) => artifact.kind === "final" && artifact.revision === revision,
      );
      if (existing !== undefined) {
        return existing;
      }
      if (!input.build.passed || input.build.revision !== revision) {
        throw new BuildGateStaleError(
          `构建记录未通过或 revision 不对齐（passed=${input.build.passed}, revision=${input.build.revision}）`,
        );
      }
      return this.freeze(
        projectId,
        {
          artifactId: `art-final-rev${revision}`,
          projectId,
          kind: "final",
          revision,
          createdAt: this.now().toISOString(),
          buildGate: { passed: input.build.passed, checkedAt: input.build.checkedAt, revision: input.build.revision },
          qualityGate: {
            passed: input.gate.passed,
            round: input.gate.round,
            checkedAt: input.gate.checkedAt,
            reviewedRevision: input.gate.reviewedRevision,
          },
          file: { name: `art-final-rev${revision}.pdf`, mimeType: "application/pdf", bytes: 0 },
          ...(runId !== undefined ? { sourceRunId: runId } : {}),
        },
        manifest,
      );
    });
    return { final, draft };
  }

  // ---- 内部 ----

  /** 冻结 PDF：build/paper.pdf → artifacts/{name}.pdf（tmp → rename），登记 manifest */
  private async freeze(
    projectId: string,
    artifact: PaperArtifact,
    manifest: ArtifactManifest,
  ): Promise<PaperArtifact> {
    const artifactsDir = this.projects.artifactsDir(projectId);
    await mkdir(artifactsDir, { recursive: true });
    const source = join(this.projects.buildDir(projectId), "paper.pdf");
    const target = join(artifactsDir, artifact.file.name);
    const tmp = join(artifactsDir, `.${artifact.file.name}.${process.pid}.tmp`);
    let bytes: number;
    try {
      await copyFile(source, tmp);
      const info = await stat(tmp);
      bytes = info.size;
      await rename(tmp, target);
    } catch (error) {
      // 源 PDF 缺失（编译产物被清理）→ 如实报错，不留半个产物
      throw new BuildGateFailedError(
        "build/paper.pdf 不存在或不可读（先重新构建）",
        error instanceof Error ? error.message : String(error),
      );
    }
    const frozen: PaperArtifact = { ...artifact, file: { ...artifact.file, bytes } };
    const next: ArtifactManifest = {
      schemaVersion: 1,
      artifacts: [...manifest.artifacts, frozen],
    };
    await writeJsonAtomic(join(artifactsDir, "manifest.json"), next);
    return frozen;
  }

  private async loadManifest(projectId: string): Promise<ArtifactManifest> {
    try {
      const parsed = JSON.parse(
        await readFile(join(this.projects.artifactsDir(projectId), "manifest.json"), "utf8"),
      ) as Partial<ArtifactManifest>;
      if (
        Array.isArray(parsed["artifacts"]) &&
        parsed["artifacts"].every(
          (artifact) =>
            typeof artifact === "object" &&
            artifact !== null &&
            typeof artifact["artifactId"] === "string" &&
            typeof artifact["kind"] === "string",
        )
      ) {
        return { schemaVersion: 1, artifacts: parsed["artifacts"] as PaperArtifact[] };
      }
    } catch {
      // 无 manifest（新项目 / 旧项目）→ 空清单
    }
    return { schemaVersion: 1, artifacts: [] };
  }

  private serialize<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.queues.set(
      projectId,
      next.catch(() => undefined),
    );
    return next;
  }
}

/** 内部自洽校验失败（FinalizeService 应在上游拦截；这里防御性兜底） */
class QualityGateMisaligned extends BusinessError {
  constructor(message: string) {
    super("QUALITY_GATE_STALE", `Quality Gate 结果与当前修订不对齐：${message}`);
  }
}

/** 计算冻结 PDF 的内容指纹（诊断 / 审计用；不进 API 响应） */
export async function artifactSha256(absolutePath: string): Promise<string> {
  const content = await readFile(absolutePath);
  return createHash("sha256").update(content).digest("hex");
}
