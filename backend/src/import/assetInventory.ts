/**
 * Asset Inventory（M10.3 Stage A：确定性、无 LLM）。
 *
 * 真实案例 ZIP 导入后，把「项目内 source ↔ 案例角色」的映射固化为
 * research/asset-inventory.json：
 * - 事实边界来自案例 MANIFEST（M10.3 真实案例包的 packagedPath → role 映射），
 *   绝不按文件名猜测（README §4 纪律）；
 * - source 上传是扁平文件名（sanitizeFileName 不允许路径），映射按 basename
 *   唯一匹配；无法唯一对应 → ambiguous / unclassified，如实登记；
 * - domain 隔离视图：current_experiment（PC final）/ historical_board（板端）/
 *   current_manuscript / feedback / context / code / references ——下游报告与
 *   E2E 校验据此断言「current 与 historical 不混域」。
 *
 * 只读派生：不修改任何 source / manuscript；MANIFEST 缺失时退化为
 * unclassified 清单（不阻塞工作流）。
 */

export const ASSET_INVENTORY_ROLES = [
  "current_manuscript",
  "historical_manuscript_candidate",
  "current_experiment",
  "historical_board_experiment",
  "historical_experiment",
  "submission_feedback",
  "research_context",
  "code",
  "references",
  "case_manifest",
  "readme",
] as const;
export type AssetInventoryRole = (typeof ASSET_INVENTORY_ROLES)[number] | "unclassified" | "ambiguous";

export interface InventorySourceEntry {
  sourceId: string;
  fileName: string;
  originalName?: string;
  sourceType: string;
  /** MANIFEST 判定的角色（basename 唯一匹配；无 MANIFEST → unclassified） */
  role: AssetInventoryRole;
  /** 匹配到的 MANIFEST packagedPath（role ≠ unclassified/ambiguous 时携带） */
  packagedPath?: string;
  confidence?: string;
}

export interface AssetInventory {
  schemaVersion: 1;
  generatedAt: string;
  /** MANIFEST 是否存在并成功解析 */
  manifestFound: boolean;
  /** manifest 解析失败原因（manifestFound=false 时携带） */
  manifestError?: string;
  /** 主稿 packagedPath（MANIFEST currentManuscript；事实边界） */
  currentManuscriptPath?: string;
  entries: InventorySourceEntry[];
  domains: {
    current: string[];
    historicalBoard: string[];
    historical: string[];
    feedback: string[];
    unclassified: string[];
  };
  warnings: string[];
}

interface ManifestLike {
  caseVersion?: unknown;
  currentManuscript?: { packagedPath?: unknown };
  assets?: unknown;
}

interface ManifestAsset {
  packagedPath?: string;
  role?: string;
  confidence?: string;
}

/** 防御性解析案例 MANIFEST（结构不对 → null；不抛错） */
export function parseCaseManifest(raw: string): ManifestLike | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record["caseVersion"] === undefined || !Array.isArray(record["assets"])) {
    return null;
  }
  return parsed as ManifestLike;
}

function normalizeManifestAssets(manifest: ManifestLike): ManifestAsset[] {
  const raw = manifest.assets;
  if (!Array.isArray(raw)) {
    return [];
  }
  const assets: ManifestAsset[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const packagedPath = typeof record["packagedPath"] === "string" ? record["packagedPath"] : undefined;
    if (packagedPath === undefined || packagedPath === "") {
      continue;
    }
    assets.push({
      packagedPath,
      ...(typeof record["role"] === "string" ? { role: record["role"] } : {}),
      ...(typeof record["confidence"] === "string" ? { confidence: record["confidence"] } : {}),
    });
  }
  return assets;
}

function basenameOf(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized.split("/").pop() ?? normalized;
}

export interface InventorySourceInput {
  sourceId: string;
  fileName: string;
  originalName?: string;
  sourceType: string;
}

/**
 * 构建资产清单（纯函数）。
 * sources 以扁平文件名入库；MANIFEST 的 packagedPath 按 basename 匹配——
 * 同名多资产（如两个 README.md）一律 ambiguous，不猜。
 */
export function buildAssetInventory(
  sources: InventorySourceInput[],
  manifestRaw: string | null,
  now = new Date().toISOString(),
): AssetInventory {
  const warnings: string[] = [];
  const manifest = manifestRaw !== null ? parseCaseManifest(manifestRaw) : null;
  if (manifestRaw !== null && manifest === null) {
    warnings.push("MANIFEST.json 内容不符合案例清单 schema（caseVersion + assets），角色映射退化为 unclassified");
  }
  const assets = manifest !== null ? normalizeManifestAssets(manifest) : [];
  const byBasename = new Map<string, ManifestAsset[]>();
  for (const asset of assets) {
    const base = basenameOf(asset.packagedPath ?? "");
    const list = byBasename.get(base) ?? [];
    list.push(asset);
    byBasename.set(base, list);
  }
  // 后缀回退匹配（上传时为避免同名冲突加前缀，如 board_c0_aggregate.json ←
  // aggregate.json）：仍要求全清单唯一命中，多命中维持不猜测纪律
  const matchAsset = (fileName: string): ManifestAsset | "ambiguous" | null => {
    const exact = byBasename.get(fileName);
    if (exact !== undefined) {
      return exact.length === 1 ? exact[0]! : "ambiguous";
    }
    const suffixHits = assets.filter(
      (asset) => asset.packagedPath !== undefined && fileName.endsWith(basenameOf(asset.packagedPath)),
    );
    if (suffixHits.length === 1) {
      return suffixHits[0]!;
    }
    if (suffixHits.length > 1) {
      return "ambiguous";
    }
    return null;
  };

  const entries: InventorySourceEntry[] = sources.map((source) => {
    const base = basenameOf(source.originalName ?? source.fileName);
    if (manifest === null) {
      return { ...source, role: "unclassified" as AssetInventoryRole };
    }
    if (base.toLowerCase() === "manifest.json") {
      return { ...source, role: "case_manifest" as AssetInventoryRole, packagedPath: "MANIFEST.json" };
    }
    if (base.toLowerCase() === "readme.md" && !byBasename.has(base)) {
      // 无 assets 记录的根 README：按案例说明文档登记（只在唯一 README source 时）
      const readmes = sources.filter(
        (candidate) => basenameOf(candidate.originalName ?? candidate.fileName).toLowerCase() === "readme.md",
      );
      if (readmes.length === 1) {
        return { ...source, role: "readme" as AssetInventoryRole, packagedPath: "README.md" };
      }
    }
    const matches = matchAsset(base);
    if (matches === null) {
      return { ...source, role: "unclassified" as AssetInventoryRole };
    }
    if (matches === "ambiguous") {
      warnings.push(`${base} 在 MANIFEST 中无唯一对应资产，标记 ambiguous`);
      return { ...source, role: "ambiguous" as AssetInventoryRole };
    }
    return {
      ...source,
      role: (matches.role ?? "unclassified") as AssetInventoryRole,
      packagedPath: matches.packagedPath,
      ...(matches.confidence !== undefined ? { confidence: matches.confidence } : {}),
    };
  });

  const domains: AssetInventory["domains"] = { current: [], historicalBoard: [], historical: [], feedback: [], unclassified: [] };
  for (const entry of entries) {
    // 域归类同时接受 M10.3 规范角色词与真实案例 MANIFEST 的实际词表
    // （experiment_result / board_data / phase_report / reviewer_response…）
    if (DOMAIN_ROLE_SETS.current.has(entry.role)) {
      domains.current.push(entry.sourceId);
    } else if (DOMAIN_ROLE_SETS.historicalBoard.has(entry.role)) {
      domains.historicalBoard.push(entry.sourceId);
    } else if (DOMAIN_ROLE_SETS.historical.has(entry.role)) {
      domains.historical.push(entry.sourceId);
    } else if (DOMAIN_ROLE_SETS.feedback.has(entry.role)) {
      domains.feedback.push(entry.sourceId);
    } else {
      domains.unclassified.push(entry.sourceId);
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: now,
    manifestFound: manifest !== null,
    ...(manifest !== null && typeof manifest.currentManuscript?.packagedPath === "string"
      ? { currentManuscriptPath: manifest.currentManuscript.packagedPath }
      : {}),
    entries,
    domains,
    warnings: [...new Set(warnings)],
  };
}

/** 域归类角色集（规范词 + 真实案例词表别名） */
const DOMAIN_ROLE_SETS = {
  current: new Set([
    "current_manuscript",
    "current_experiment",
    "experiment_result",
    "experiment_data",
    "experiment_figure",
    "experiment_config",
    "experiment_log",
    "experiment_code",
    "evaluation_report",
    "manuscript_figure",
    "manuscript_pdf",
    "manuscript_submission_format_pdf",
    "bibliography",
    "bibliography_compiled",
    "references",
    "readme",
    "case_manifest",
  ]),
  historicalBoard: new Set([
    "historical_board_experiment",
    "board_data",
    "board_benchmark",
    "board_measurement",
    "board_figure",
    "deployment_measurement",
    "deployment_result",
    "deployment_log",
    "deployment_figure",
  ]),
  historical: new Set([
    "historical_experiment",
    "historical_manuscript_candidate",
    "historical_manuscript",
    "superseded_manuscript_copy",
    "historical_report",
    "version_freeze_note",
    "version_freeze_manifest",
    "revision_change_log",
    "revision_note_text",
    "revision_note_qa",
  ]),
  feedback: new Set([
    "submission_feedback",
    "feedback",
    "reviewer_response",
    "reviewer_feedback_response",
    "reviewer_feedback_response_submitted",
    "response_letter",
    "submission_audit",
  ]),
} as const;
