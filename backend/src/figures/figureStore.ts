/**
 * Figure Store（M12.3 C3）：manuscript/figs/generated/ 的持久化与 lineage。
 *
 * 目录形态（M12.0 §13 冻结）：
 *   manuscript/figs/generated/
 *     manifest.json            // { schemaVersion, figures: GeneratedFigureRecord[] }
 *     <figId>.spec.json        // 完整（规范化）spec 持久化
 *     <figId>.tex              // 生成的 TeX 源（保留可调试 / 作者可改）
 *     <figId>.pdf              // vector 产物
 *
 * 身份与缓存键：
 * - specHash = fingerprintJson(规范化 spec)（键排序稳定序列化 + sha256）。
 *   canonical 序列化范围 = 完整规范化 spec——包括 data.datasetHash 与
 *   inlineDataset 本身。因此「数据变化必然改变 specHash」是结构保证：
 *   inlineDataset 变 → 校验层要求 datasetHash 同步重算 → 二者都在 spec 序列
 *   化范围内 → specHash 必变。不存在「spec 同但数据变」的缓存误命中。
 * - figId = "fig-" + specHash 前 12 个 hex（同 spec 同 id，确定性）。前缀
 *   碰撞（同 figId 不同 specHash）由 FigureCompiler 检测并退化为全 hash
 *   形态，保证 figId ↔ specHash 一一对应。
 *
 * 缓存语义：同 specHash 且 PDF 资产在盘 → 直接复用（cache hit，不跑 xelatex）。
 * PDF 资产丢失（手工删除）→ 缓存视为 miss，重新编译；upsert 时保留原 record
 * 的 createdAt（重编译不是重新创作）。
 *
 * 并发：manifest 读-改-写不加密级互斥——调用方（工作流 / HTTP 层）串行化
 * 同一项目的图表生成即可（C4 的职责）；写盘本身走原子写（util/atomic 与本
 * 文件的二进制原子写），进程中断不会留下半个 manifest 或半个 PDF。
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { writeFileAtomic, writeJsonAtomic } from "../util/atomic.js";
import { fingerprintJson } from "../util/hash.js";
import type { DataOrigin } from "./spec.js";

/** specHash：规范化 spec 的稳定序列化指纹（缓存键 + 一致性锚） */
export function computeSpecHash(spec: unknown): string {
  return fingerprintJson(spec);
}

/** figId：specHash 前 12 hex（确定性派生——同 spec 同 id） */
export function deriveFigId(specHash: string): string {
  return `fig-${specHash.slice(0, 12)}`;
}

export interface GeneratedFigureRecord {
  /** fig-<12hex>（由 specHash 派生；前缀碰撞时为全 hash 形态） */
  figId: string;
  kind: "plot" | "diagram";
  /** 规范化 spec 的稳定指纹（缓存键；覆盖 datasetHash 与 inlineDataset） */
  specHash: string;
  /** 数据集内容 sha256（plot 必填；diagram 无数据集） */
  datasetHash?: string;
  /** 数据来源锚（sourceId+blockId → ParsedDocument 块；manual = 手工数据如实标注） */
  dataOrigin: DataOrigin;
  /** 相对 store 根目录的资产路径 */
  assets: { tex: string; pdf: string };
  /** 候选 caption（plot 来自 spec.caption，diagram 来自 title；插入手稿时快照到 insertedIn） */
  caption: string;
  /** C5 手稿插入后回填的当前位置（被替换后清除，改记 supersededBy） */
  insertedIn?: { file: string; label: string; revision: number };
  /** 本图在某 (file, label) 位置被替换时指向取代它的 figId（append-only lineage） */
  supersededBy?: string;
  createdAt: string;
  /** 编译诊断摘要（时长 + 结果一句话；不含完整日志） */
  compiler?: { durationMs: number; diagnostics: string };
}

export interface FigureManifest {
  schemaVersion: 1;
  figures: GeneratedFigureRecord[];
}

const MANIFEST_SCHEMA_VERSION = 1;
const MANIFEST_FILE = "manifest.json";

/** manifest 损坏 / schemaVersion 不符（机器 owned 产物：损坏即显式报错，不静默重建） */
export class FigureStoreCorruptedError extends Error {
  constructor(detail: string) {
    super(`figure store manifest 损坏：${detail}`);
    this.name = "FigureStoreCorruptedError";
  }
}

export class FigureStore {
  private readonly rootDir: string;

  /** rootDir = <project>/manuscript/figs/generated（由调用方拼好绝对路径） */
  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  get root(): string {
    return this.rootDir;
  }

  get manifestPath(): string {
    return join(this.rootDir, MANIFEST_FILE);
  }

  /** spec / tex / pdf 资产绝对路径（record.assets 存相对名） */
  assetPath(record: GeneratedFigureRecord, kind: "tex" | "pdf" | "spec"): string {
    const fileName =
      kind === "tex"
        ? record.assets.tex
        : kind === "pdf"
          ? record.assets.pdf
          : `${record.figId}.spec.json`;
    return join(this.rootDir, fileName);
  }

  /** 读 manifest（不存在 → 空 manifest；损坏 / 版本不符 → 显式抛错） */
  async loadManifest(): Promise<FigureManifest> {
    let raw: string;
    try {
      raw = await readFile(this.manifestPath, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return { schemaVersion: MANIFEST_SCHEMA_VERSION, figures: [] };
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new FigureStoreCorruptedError(`JSON 解析失败（${String(error)}）`);
    }
    const manifest = parsed as Partial<FigureManifest>;
    if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION || !Array.isArray(manifest.figures)) {
      throw new FigureStoreCorruptedError(
        `schemaVersion=${String(manifest.schemaVersion)} 不符合预期（${MANIFEST_SCHEMA_VERSION}）或 figures 非数组`,
      );
    }
    return { schemaVersion: MANIFEST_SCHEMA_VERSION, figures: manifest.figures };
  }

  async list(): Promise<GeneratedFigureRecord[]> {
    return (await this.loadManifest()).figures;
  }

  async get(figId: string): Promise<GeneratedFigureRecord | undefined> {
    return (await this.list()).find((record) => record.figId === figId);
  }

  /** 缓存查找：同 specHash 的记录（是否命中还需 PDF 资产在盘，见 pdfAssetExists） */
  async findBySpecHash(specHash: string): Promise<GeneratedFigureRecord | undefined> {
    return (await this.list()).find((record) => record.specHash === specHash);
  }

  /** PDF 资产是否在盘（缓存命中的第二条件） */
  async pdfAssetExists(record: GeneratedFigureRecord): Promise<boolean> {
    try {
      return (await stat(join(this.rootDir, record.assets.pdf))).isFile();
    } catch {
      return false;
    }
  }

  /**
   * 持久化一张图：spec.json / tex / pdf 三资产落盘 + manifest upsert。
   * upsert 规则：同 figId 的旧记录被替换（保留 createdAt——重编译不是重新
   * 创作）；同 specHash 的旧记录一并移除（specHash 与 figId 一一对应，防
   * 孤儿记录堆积）。返回落盘的最终记录（含保留的 createdAt）。
   */
  async persistFigure(params: {
    record: GeneratedFigureRecord;
    spec: unknown;
    tex: string;
    pdfBytes: Buffer;
  }): Promise<GeneratedFigureRecord> {
    await mkdir(this.rootDir, { recursive: true });
    await writeJsonAtomic(this.assetPath(params.record, "spec"), params.spec);
    await writeFileAtomic(this.assetPath(params.record, "tex"), params.tex);
    await writeBinaryAtomic(this.assetPath(params.record, "pdf"), params.pdfBytes);

    const manifest = await this.loadManifest();
    const existing = manifest.figures.find((record) => record.figId === params.record.figId);
    const merged: GeneratedFigureRecord = existing === undefined ? params.record : {
      ...params.record,
      createdAt: existing.createdAt,
      ...(existing.insertedIn !== undefined ? { insertedIn: existing.insertedIn } : {}),
      ...(existing.supersededBy !== undefined ? { supersededBy: existing.supersededBy } : {}),
    };
    const figures = manifest.figures.filter(
      (record) => record.figId !== params.record.figId && record.specHash !== params.record.specHash,
    );
    figures.push(merged);
    await writeJsonAtomic(this.manifestPath, {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      figures,
    } satisfies FigureManifest);
    return merged;
  }

  /**
   * C5 手稿插入的 manifest 回写：
   * - 目标图 insertedIn = {file, label, revision}；
   * - 同（file, label）位置的旧图 insertedIn 清除并记 supersededBy（append-only
   *   语义的 lineage：旧资产与 spec.json 不删，替换可追溯）。
   */
  async recordInsertion(params: {
    figId: string;
    insertedIn: { file: string; label: string; revision: number };
  }): Promise<GeneratedFigureRecord | undefined> {
    const manifest = await this.loadManifest();
    const planned = this.planInsertion(manifest, params);
    await writeJsonAtomic(this.manifestPath, planned.manifest);
    return planned.updated;
  }

  /** 纯计算 lineage，供持久化 intent 在写手稿前固定 manifest 结果。 */
  planInsertion(manifest: FigureManifest, params: {
    figId: string;
    insertedIn: { file: string; label: string; revision: number };
  }): { manifest: FigureManifest; updated: GeneratedFigureRecord } {
    let updated: GeneratedFigureRecord | undefined;
    const figures = manifest.figures.map((record): GeneratedFigureRecord => {
      const sameSlot =
        record.insertedIn !== undefined &&
        record.insertedIn.file === params.insertedIn.file &&
        record.insertedIn.label === params.insertedIn.label &&
        record.figId !== params.figId;
      if (record.figId === params.figId) {
        updated = { ...record, insertedIn: params.insertedIn };
        return updated;
      }
      if (sameSlot) {
        const { insertedIn: _drop, ...rest } = record;
        return { ...rest, supersededBy: params.figId };
      }
      return record;
    });
    if (updated === undefined) {
      throw new FigureStoreCorruptedError(`插入目标 ${params.figId} 不在 manifest`);
    }
    return { manifest: { schemaVersion: MANIFEST_SCHEMA_VERSION, figures }, updated };
  }

  /** 读某图的持久化 spec（spec.json；缺失 → null） */
  async loadSpec(figId: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(join(this.rootDir, `${figId}.spec.json`), "utf8"));
    } catch {
      return null;
    }
  }
}

/**
 * 二进制原子写：同目录 tmp → rename（util/atomic 的 writeFileAtomic 只写
 * utf8 文本，PDF 字节需要独立实现；EPERM/EBUSY 有限退避——Windows 杀毒 /
 * 索引器短暂占用 rename 的已知防御，同 util/atomic 的重试语义）。
 */
async function writeBinaryAtomic(filePath: string, bytes: Buffer): Promise<void> {
  const tmpPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}-${Date.now()}.tmp`,
  );
  try {
    await writeFile(tmpPath, bytes);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(tmpPath, filePath);
        return;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if ((code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") || attempt >= 3) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
