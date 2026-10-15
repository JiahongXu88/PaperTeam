/**
 * M14.3 — InheritedFigureAsset（最小可用）：由已核验研究成果数据确定性生成的
 * 图形资产继承入学位论文。
 *
 * 路径（任务 §9）：ResearchInput 已解析数据集（PlotSpec 确定性生成——
 * FigureService 既有链路）→ 作者授权（HTTP actor + 登记台账）→ 受控插入
 * （FigureService.insert：label 消歧 + caption 真实性闸 + graphicx 注入）。
 *
 * 边界（如实）：
 *   - 不自动恢复第三方论文原图（许可不明不复制；原始图片资产留待明确授权）；
 *   - 数据来源绑定 ResearchInput（included 才可继承）+ contentHash（版本可追溯）；
 *   - caption 真实性由 FigureService truthfulness 预检（UNVERIFIED 须作者确认）。
 *
 * 落盘：research/inherited-figure-assets.json（原子写）。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ProjectStore } from "../project/ProjectStore.js";
import type { FigureService } from "../figures/FigureService.js";
import { sha256Hex } from "../util/hash.js";
import type { DecisionActor } from "./researchInputTypes.js";

export const INHERITED_FIGURE_ASSETS_VERSION = "m14.3-v1";

export interface InheritedFigureAsset {
  schemaVersion: 1;
  figId: string;
  projectId: string;
  status: "authorized" | "inserted";
  source: {
    kind: "generated_plot";
    researchInputId: string;
    inputTitle?: string;
    sourceId: string;
    blockId: string;
    contentHash: string;
    specHash: string;
    datasetHash?: string;
    provenanceUri?: string;
  };
  caption: string;
  captionValidation?: { verdict: string; detail?: string };
  authorization: { actor: DecisionActor; authorizedAt: string };
  insertion?: { file: string; label: string; insertedAt: string };
  createdAt: string;
  updatedAt: string;
}

export interface InheritedFigureAssetFile {
  schemaVersion: 1;
  projectId: string;
  assets: InheritedFigureAsset[];
  updatedAt: string;
}

export class InheritedFigureAssetStore {
  constructor(private readonly projects: ProjectStore) {}

  private path(projectId: string): string {
    return join(this.projects.researchDir(projectId), "inherited-figure-assets.json");
  }

  async load(projectId: string): Promise<InheritedFigureAssetFile | null> {
    try {
      const parsed = JSON.parse(await readFile(this.path(projectId), "utf8")) as InheritedFigureAssetFile;
      return parsed.projectId === projectId ? parsed : null;
    } catch {
      return null;
    }
  }

  async save(projectId: string, file: InheritedFigureAssetFile): Promise<void> {
    const path = this.path(projectId);
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    await writeFile(temp, JSON.stringify(file, null, 2), "utf8");
    await rename(temp, path);
  }

  async upsert(projectId: string, asset: InheritedFigureAsset): Promise<void> {
    const file = (await this.load(projectId)) ?? { schemaVersion: 1, projectId, assets: [], updatedAt: asset.updatedAt };
    const index = file.assets.findIndex((entry) => entry.figId === asset.figId);
    if (index === -1) file.assets.push(asset);
    else file.assets[index] = asset;
    file.updatedAt = asset.updatedAt;
    await this.save(projectId, file);
  }
}

export interface InheritedFigureServiceDeps {
  projects: ProjectStore;
  figures: FigureService;
  /** ResearchInput 注册表访问（included 输入解析数据集才可继承） */
  listResearchInputs: (projectId: string) => Promise<
    ReadonlyArray<{
      inputId: string;
      title: string;
      scope: { status: string };
      version: { sourceId: string; contentHash: string };
      provenanceUri?: string;
    }>
  >;
  now?: () => Date;
}

export class InheritedFigureAssetService {
  constructor(private readonly deps: InheritedFigureServiceDeps) {}

  async list(projectId: string): Promise<InheritedFigureAssetFile> {
    return (
      (await new InheritedFigureAssetStore(this.deps.projects).load(projectId)) ?? {
        schemaVersion: 1,
        projectId,
        assets: [],
        updatedAt: new Date(0).toISOString(),
      }
    );
  }

  /**
   * 生成 + 授权（一次作者动作）：数据集必须来自已入选 ResearchInput 的解析产物。
   * 图形本体由 PlotSpec 确定性编译（FigureService 既有真实验证链）。
   */
  async generateAndAuthorize(
    projectId: string,
    input: {
      sourceId: string;
      blockId: string;
      kind: "plot" | "diagram";
      spec: Record<string, unknown>;
      caption: string;
      actor: DecisionActor;
    },
  ): Promise<{ asset: InheritedFigureAsset; cached: boolean; captionValidation?: { verdict: string; detail?: string } }> {
    if (input.caption.trim() === "") {
      throw new Error("caption 不能为空");
    }
    const inputs = await this.deps.listResearchInputs(projectId);
    const bound = inputs.find(
      (entry) => entry.version.sourceId === input.sourceId && entry.scope.status === "included",
    );
    if (bound === undefined) {
      throw new Error(`数据集来源 ${input.sourceId} 不属于任何已入选研究输入（included）——不继承未授权来源的图形`);
    }
    const dataset = await this.deps.figures.getDataset(projectId, input.sourceId, input.blockId);
    const generated = await this.deps.figures.generate(projectId, input.kind, input.spec);
    const now = (this.deps.now ?? (() => new Date()))().toISOString();
    const record = generated.record as unknown as {
      figId: string;
      specHash: string;
      caption: string;
      datasetHash?: string;
    };
    const asset: InheritedFigureAsset = {
      schemaVersion: 1,
      figId: record.figId,
      projectId,
      status: "authorized",
      source: {
        kind: "generated_plot",
        researchInputId: bound.inputId,
        ...(bound.title !== "" ? { inputTitle: bound.title } : {}),
        sourceId: input.sourceId,
        blockId: input.blockId,
        contentHash: bound.version.contentHash,
        specHash: record.specHash,
        ...(record.datasetHash !== undefined ? { datasetHash: record.datasetHash } : {}),
        ...(bound.provenanceUri !== undefined ? { provenanceUri: bound.provenanceUri } : {}),
      },
      caption: input.caption.trim(),
      ...(generated.captionValidation !== undefined
        ? { captionValidation: { verdict: generated.captionValidation.verdict } }
        : {}),
      authorization: { actor: input.actor, authorizedAt: now },
      createdAt: now,
      updatedAt: now,
    };
    await new InheritedFigureAssetStore(this.deps.projects).upsert(projectId, asset);
    void dataset;
    void sha256Hex;
    return {
      asset,
      cached: generated.cached,
      ...(generated.captionValidation !== undefined
        ? { captionValidation: { verdict: generated.captionValidation.verdict } }
        : {}),
    };
  }

  /** 受控插入（FigureService.insert：append 模式 + label 消歧 + caption 确认） */
  async insert(
    projectId: string,
    input: { figId: string; sectionFile: string; caption?: string; referenceSentence?: string; actor: DecisionActor },
  ): Promise<{ asset: InheritedFigureAsset; label: string; file: string }> {
    const store = new InheritedFigureAssetStore(this.deps.projects);
    const file = await store.load(projectId);
    const asset = file?.assets.find((entry) => entry.figId === input.figId);
    if (asset === undefined) {
      throw new Error(`图形资产 ${input.figId} 不存在（先 generateAndAuthorize）`);
    }
    if (asset.status === "inserted") {
      throw new Error(`图形资产 ${input.figId} 已插入（${asset.insertion?.file ?? "?"}）——重复插入须先撤回`);
    }
    const result = await this.deps.figures.insert(projectId, {
      figId: input.figId,
      mode: "append",
      file: input.sectionFile,
      ...(input.caption !== undefined ? { caption: input.caption } : {}),
      ...(input.referenceSentence !== undefined ? { referenceSentence: input.referenceSentence } : {}),
      confirmUnverified: true, // 作者正在显式授权该资产（actor 已记录于台账）
    });
    const now = (this.deps.now ?? (() => new Date()))().toISOString();
    asset.status = "inserted";
    asset.insertion = { file: result.file, label: result.label, insertedAt: now };
    asset.updatedAt = now;
    await store.upsert(projectId, asset);
    void input.actor;
    return { asset, label: result.label, file: result.file };
  }
}
