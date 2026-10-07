/**
 * 视觉资产安全解析（M12 Batch 2 · B4）：纯逻辑 + 受控文件系统读取，
 * 供 HTTP 层（GET /api/sources/:sid/figures/:name、GET /api/projects/:id/figures/generated/:name）
 * 与任何需要图片字节的调用方复用。**本模块不注册路由**——路由由 httpServer
 * 按 docs/research/M12_BATCH2_TRACK_B_HANDOFF.md 的契约接线。
 *
 * 安全纪律（G8 补口）：
 * - 资产名是**扁平文件名**（fig-001.png / fig-<hex>.pdf）：白名单字符集
 *   ^[A-Za-z0-9][A-Za-z0-9._-]*$，显式拒绝路径分隔符（/ 与 \——后者在
 *   posix 是合法文件名字符，作为分隔符使用一律拒绝）、`..` 段、绝对路径
 *   （含 Windows 盘符形态）、前导点、NUL/控制字符；
 * - 双重包含校验：词法 resolve 后必须仍在资产根目录内；再对**实际文件**
 *   做 realpath 包含校验（整个文件名被符号链接劫持的场景——白名单之外的
 *   逃生通道在这里封死）；
 * - MIME 白名单：source 抽图 = png/jpg/jpeg；生成图 = pdf（fig-<hex>.pdf
 *   形态白名单）。扩展名即声明，不做内容嗅探（内容嗅探是 vision 管线的
 *   职责，见 imageSignature）；
 * - stale_asset：文件在盘但不在权威登记（ParsedDocument figure 块的
 *   assetName / figure store manifest）——已重解析残留文件不外发；
 *   未提供登记访问器时跳过该检查（纯文件系统模式，调用方自行保证）。
 *
 * 错误模型：结构化失败对象（code 稳定 + httpStatus 供 HTTP 层映射），
 * 绝不抛异常——路径攻击是预期输入，不是控制流异常。
 */

import { realpath, readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import type { ProjectStore } from "../project/ProjectStore.js";
import type { ParsedDocument } from "../ingestion/types.js";

/** 结构化失败（HTTP 层按 httpStatus + code 映射；code 是对外契约） */
export interface FigureAssetFailure {
  code:
    | "invalid_project" // 项目不存在
    | "invalid_path" // 资产名非法（遍历 / 分隔符 / 控制字符 / 形态不符）
    | "unsupported_asset" // 扩展名不在白名单
    | "missing_artifact" // 登记存在但文件不在盘（或源无解析产物）
    | "stale_asset"; // 文件在盘但不在权威登记
  message: string;
  httpStatus: 400 | 404;
}

export interface FigureAssetResolved {
  bytes: Buffer;
  mimeType: "image/png" | "image/jpeg" | "application/pdf";
  /** 字节数（Content-Length 由 HTTP 层设置；此处供日志 / 断言） */
  byteLength: number;
}

export type FigureAssetResult =
  | { ok: true; asset: FigureAssetResolved }
  | { ok: false; failure: FigureAssetFailure };

/** source id 形态（与 httpServer 现行约定一致：大写字母 + ≥2 位数字） */
const SOURCE_ID_PATTERN = /^[A-Z]\d{2,}$/;

/** 扁平资产名白名单：字母数字开头，仅字母数字/点/下划线/连字符 */
const FLAT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** source 抽图允许的扩展名 → MIME（白名单即契约） */
const SOURCE_ASSET_MIME: Readonly<Record<string, "image/png" | "image/jpeg">> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

/** 生成图资产形态：fig-<12..64 hex>.pdf（figId = specHash 前 12 hex，碰撞退化全 hash） */
const GENERATED_ASSET_PATTERN = /^fig-[0-9a-f]{12,64}\.pdf$/;

/**
 * 扁平资产名校验（长度保持防御：所有拒绝路径都先于任何文件系统访问）。
 * 返回 undefined = 非法（invalid_path）；否则返回小写扩展名（不含点）。
 */
export function validateFlatAssetName(name: string): { extension: string } | undefined {
  if (
    name === "" ||
    name.length > 128 ||
    name.includes("\0") ||
    /[\u0000-\u001F\u007F]/.test(name) ||
    name.includes("\\") || // 反斜杠：Windows 分隔符，posix 下作分隔符使用同样拒绝
    name.includes("/") ||
    name.startsWith(".") ||
    name.includes("..") || // 覆盖 "fig..png" 与显式 ".." 段（扁平名无段概念，出现即拒）
    !FLAT_NAME_PATTERN.test(name)
  ) {
    return undefined;
  }
  const dot = name.lastIndexOf(".");
  if (dot === -1) {
    return undefined; // 无扩展名 → 无法归入 MIME 白名单，按非法路径拒
  }
  return { extension: name.slice(dot + 1).toLowerCase() };
}

/** 词法包含校验：resolve(root, name) 必须仍在 root 内（防御纵深，理论上被白名单覆盖） */
function isLexicallyContained(root: string, name: string): boolean {
  const resolved = resolve(root, name);
  return resolved === root || resolved.startsWith(root + sep);
}

/** realpath 包含校验：实际文件路径（含符号链接展开后）必须仍在 root 内 */
async function isRealpathContained(rootDir: string, filePath: string): Promise<boolean> {
  const [rootReal, fileReal] = await Promise.all([realpath(rootDir), realpath(filePath)]);
  return fileReal === rootReal || fileReal.startsWith(rootReal + sep);
}

/** 受控读取：stat（存在 + 是文件）→ realpath 包含 → readFile */
async function readContained(
  rootDir: string,
  fileName: string,
  mimeType: FigureAssetResolved["mimeType"],
): Promise<FigureAssetResult> {
  const filePath = join(rootDir, fileName);
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      return {
        ok: false,
        failure: { code: "missing_artifact", message: `资产 ${fileName} 不是常规文件`, httpStatus: 404 },
      };
    }
  } catch {
    return {
      ok: false,
      failure: { code: "missing_artifact", message: `资产 ${fileName} 不存在`, httpStatus: 404 },
    };
  }
  try {
    if (!(await isRealpathContained(rootDir, filePath))) {
      return {
        ok: false,
        failure: { code: "invalid_path", message: `资产 ${fileName} 解析后越出资产根目录`, httpStatus: 400 },
      };
    }
  } catch {
    return {
      ok: false,
      failure: { code: "missing_artifact", message: `资产 ${fileName} 无法解析真实路径`, httpStatus: 404 },
    };
  }
  const bytes = await readFile(filePath);
  return { ok: true, asset: { bytes, mimeType, byteLength: bytes.length } };
}

/** ParsedDocument 登记访问器（stale 检查；生产传 ParsedDocumentStore） */
export interface ParsedDocumentAccess {
  load(projectId: string, sourceId: string): Promise<ParsedDocument | null>;
}

/**
 * 解析 source 抽图资产：sources/figures/<sourceId>/<assetName>。
 *
 * 前置：project 存在（invalid_project）、sourceId 形态合法（invalid_path）、
 * assetName 扁平白名单（invalid_path）、扩展名 ∈ {png,jpg,jpeg}
 * （unsupported_asset）。登记检查（可选 access）：资产名必须出现在该源
 * ParsedDocument 的 figure 块 assetName 中（stale_asset）；无解析产物 →
 * missing_artifact（抽图登记与解析产物同生共死）。
 */
export async function resolveSourceFigureAsset(input: {
  projects: ProjectStore;
  documents?: ParsedDocumentAccess;
  projectId: string;
  sourceId: string;
  assetName: string;
}): Promise<FigureAssetResult> {
  const { projects, documents, projectId, sourceId, assetName } = input;
  if ((await projects.get(projectId)) === null) {
    return {
      ok: false,
      failure: { code: "invalid_project", message: `项目 ${projectId} 不存在`, httpStatus: 404 },
    };
  }
  if (!SOURCE_ID_PATTERN.test(sourceId)) {
    return {
      ok: false,
      failure: { code: "invalid_path", message: `source id "${sourceId}" 形态非法`, httpStatus: 400 },
    };
  }
  const validated = validateFlatAssetName(assetName);
  if (validated === undefined) {
    return {
      ok: false,
      failure: { code: "invalid_path", message: `资产名 "${assetName}" 非法（扁平白名单：字母数字开头，仅 . _ -）`, httpStatus: 400 },
    };
  }
  const mimeType = SOURCE_ASSET_MIME[validated.extension];
  if (mimeType === undefined) {
    return {
      ok: false,
      failure: {
        code: "unsupported_asset",
        message: `资产 ${assetName} 扩展名 .${validated.extension} 不在白名单（png/jpg/jpeg）`,
        httpStatus: 400,
      },
    };
  }

  const rootDir = join(projects.sourcesDir(projectId), "figures", sourceId);
  if (!isLexicallyContained(projects.sourcesDir(projectId), join("figures", sourceId, assetName))) {
    return {
      ok: false,
      failure: { code: "invalid_path", message: `资产名 "${assetName}" 解析越界`, httpStatus: 400 },
    };
  }

  if (documents !== undefined) {
    const document = await documents.load(projectId, sourceId);
    if (document === null) {
      return {
        ok: false,
        failure: { code: "missing_artifact", message: `源 ${sourceId} 无结构化解析产物（登记不可用）`, httpStatus: 404 },
      };
    }
    const registered = document.blocks.some(
      (block) => block.type === "figure" && block.assetName === assetName,
    );
    if (!registered) {
      return {
        ok: false,
        failure: { code: "stale_asset", message: `资产 ${assetName} 不在源 ${sourceId} 当前解析产物的 figure 登记中（可能为重解析残留）`, httpStatus: 404 },
      };
    }
  }

  return readContained(rootDir, assetName, mimeType);
}

/** 生成图登记访问器（stale 检查；生产传 FigureStore manifest 视图） */
export interface GeneratedFigureRegistry {
  listFigIds(): Promise<readonly string[]>;
}

/**
 * 解析生成图资产：manuscript/figs/generated/<fileName>（fig-<hex>.pdf →
 * application/pdf）。manifest 登记检查可选：fileName 去扩展名后必须在
 * manifest figId 集合中（stale_asset）。
 */
export async function resolveGeneratedFigureAsset(input: {
  projects: ProjectStore;
  projectId: string;
  fileName: string;
  registry?: GeneratedFigureRegistry;
}): Promise<FigureAssetResult> {
  const { projects, projectId, fileName, registry } = input;
  if ((await projects.get(projectId)) === null) {
    return {
      ok: false,
      failure: { code: "invalid_project", message: `项目 ${projectId} 不存在`, httpStatus: 404 },
    };
  }
  if (
    fileName === "" ||
    fileName.length > 128 ||
    fileName.includes("\0") ||
    /[\u0000-\u001F\u007F]/.test(fileName) ||
    fileName.includes("\\") ||
    fileName.includes("/") ||
    fileName.includes("..")
  ) {
    return {
      ok: false,
      failure: { code: "invalid_path", message: `生成图资产名 "${fileName}" 非法`, httpStatus: 400 },
    };
  }
  if (!GENERATED_ASSET_PATTERN.test(fileName)) {
    return {
      ok: false,
      failure: {
        code: "unsupported_asset",
        message: `生成图资产 ${fileName} 不符合 fig-<hex>.pdf 形态（仅服务生成 PDF）`,
        httpStatus: 400,
      },
    };
  }

  const rootDir = join(projects.manuscriptDir(projectId), "figs", "generated");
  if (!isLexicallyContained(projects.manuscriptDir(projectId), join("figs", "generated", fileName))) {
    return {
      ok: false,
      failure: { code: "invalid_path", message: `生成图资产名 "${fileName}" 解析越界`, httpStatus: 400 },
    };
  }

  if (registry !== undefined) {
    const figId = fileName.slice(0, -".pdf".length);
    const registered = (await registry.listFigIds()).includes(figId);
    if (!registered) {
      return {
        ok: false,
        failure: { code: "stale_asset", message: `生成图 ${figId} 不在 figure store manifest 登记中`, httpStatus: 404 },
      };
    }
  }

  return readContained(rootDir, fileName, "application/pdf");
}
