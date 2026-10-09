/**
 * Dataset 候选提取（M12.3 C4）：项目 sources 的结构化解析产物 → 图表可用
 * 数据集列表（InlineDataset 形状 + datasetHash + 溯源锚）。
 *
 * 数据来源（全部带 sourceId + blockId 锚，M12.0 §11.2 冻结的三类数据入口
 * 中的「已解析 Source 数据」）：
 * - ParsedTableBlock（PDF docling 表格 / 部分表格资产）：headers + rows 网格；
 * - 连续 ParsedRecordBlock 游程（CSV / XLSX / JSON 投影）：按 header 集合
 *   对齐成列（同一游程 = 同一张「表」；CSV 每行一条 record，天然连续）。
 *
 * 单元格数值化：字符串尝试确定性解析（trim → 千分位逗号剥离 → Number），
 * 解析失败保留字符串（类目列），空串 → null（缺失，missingPolicy 语义由
 * spec 校验层接管——这里不丢数据）。**不补零、不四舍五入、不发明数值**。
 *
 * datasetHash 与 spec 同源（computeDatasetHash = fingerprintJson({columns, rows})）
 * ——「提取 → spec」链路上的 hash 由同一函数计算，保证一致性可校验。
 */

import type { ParsedBlock, ParsedDocument } from "../ingestion/types.js";
import type { InlineDataset } from "./spec.js";
import { computeDatasetHash } from "./spec.js";

/** 数据集候选（HTTP 列表 + UI 选择用；inlineDataset 全量数据经 /dataset 端点取） */
export interface DatasetCandidate {
  sourceId: string;
  /** 块 / 游程锚（records 游程用 "B0012-B0057" 区间形态；图表 spec 的 data.origin.blockId） */
  blockId: string;
  /** table（PDF/表格块）| records（CSV/XLSX/JSON 投影游程） */
  kind: "table" | "records";
  /** 用户可见文件名（originalName 优先） */
  fileName: string;
  /** table 块的题注（parser 提供时） */
  caption?: string;
  /** sheet 名（XLSX）或 jsonPath 前缀（JSON 投影；无法归纳时缺省） */
  locationHint?: string;
  columns: string[];
  rowCount: number;
  /** 全量数据的 datasetHash（选择数据集后进入 spec 的 hash 就是它） */
  datasetHash: string;
  /** 来源角色（evidence/reference/both；benchmark 对比图可合法消费 reference 源，UI 标注） */
  sourceRole?: string;
}

/** 数据集全量载荷（候选 + InlineDataset） */
export interface DatasetPayload extends DatasetCandidate {
  inlineDataset: InlineDataset;
}

/** 数据集单元格字符串上限（与 spec InlineDataset CELL_STRING_MAX_LENGTH 对齐；
 * 超长文本（JSONL 嵌套字段、长描述）在「数据集视图」层截断——原始解析
 * 记录仍是 source of truth，锚点不变，只是图表单元格不再让整个 spec 被拒） */
const DATASET_CELL_MAX_CHARS = 300;

/** 数值化解析：确定性、无发明（千分位逗号与首尾空白剥离；失败返回原字符串） */
function coerceCell(raw: string): number | string | null {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  // 千分位形态（1,234 / 1,234.5）：逗号全部处于千分位位置才剥离
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed.replaceAll(",", ""));
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  // 类目文本：单行化 + 有界截断（保持 spec 可用；不改变原始记录）
  const singleLine = trimmed.replace(/[\u0000-\u001F\u007F\u2028\u2029]+/g, " ");
  if (singleLine.length === 0) {
    return null;
  }
  return singleLine.length > DATASET_CELL_MAX_CHARS
    ? `${singleLine.slice(0, DATASET_CELL_MAX_CHARS - 1)}…`
    : singleLine;
}

function tableBlockToDataset(block: ParsedBlock): DatasetPayload | null {
  if (block.type !== "table") {
    return null;
  }
  const columns = block.headers.map((header, index) =>
    header.trim() === "" ? `列${index + 1}` : header.trim(),
  );
  // 空表头去重（同名列会让 spec 校验拒绝——保持原样让校验层如实报错更好？
  // 不：提取层就给出可用的唯一列名，避免用户选择一个必然非法的数据集）
  const seen = new Set<string>();
  const uniqueColumns = columns.map((column) => {
    if (!seen.has(column)) {
      seen.add(column);
      return column;
    }
    let suffix = 2;
    while (seen.has(`${column}(${suffix})`)) {
      suffix += 1;
    }
    const renamed = `${column}(${suffix})`;
    seen.add(renamed);
    return renamed;
  });
  const rows = block.rows.map((row) => row.map((cell) => coerceCell(cell)));
  const inlineDataset: InlineDataset = { columns: uniqueColumns, rows };
  return {
    sourceId: "",
    blockId: block.blockId,
    kind: "table",
    fileName: "",
    ...(block.caption !== undefined && block.caption.trim() !== "" ? { caption: block.caption } : {}),
    ...(block.provenance.sheet !== undefined ? { locationHint: block.provenance.sheet } : {}),
    columns: uniqueColumns,
    rowCount: rows.length,
    datasetHash: computeDatasetHash(inlineDataset),
    inlineDataset,
  };
}

/**
 * 连续 structured_record 游程 → 数据集。同一游程内按 header 首现序对齐列；
 * 游程内某 record 缺某 header → 该格 null（如实缺失，不填 0）。
 */
function recordRunsToDatasets(blocks: ParsedBlock[]): DatasetPayload[] {
  const datasets: DatasetPayload[] = [];
  let run: ParsedBlock[] = [];
  const flush = () => {
    if (run.length === 0) {
      return;
    }
    const columns: string[] = [];
    const columnIndex = new Map<string, number>();
    for (const record of run) {
      if (record.type !== "structured_record") {
        continue;
      }
      for (const cell of record.cells) {
        const header = cell.header.trim() === "" ? cell.letter ?? "值" : cell.header.trim();
        if (!columnIndex.has(header)) {
          columnIndex.set(header, columns.length);
          columns.push(header);
        }
      }
    }
    const rows = run
      .filter((block) => block.type === "structured_record")
      .map((record) => {
        const row: (number | string | null)[] = new Array(columns.length).fill(null);
        const seenInRow = new Set<string>();
        for (const cell of record.type === "structured_record" ? record.cells : []) {
          const header = cell.header.trim() === "" ? cell.letter ?? "值" : cell.header.trim();
          const index = columnIndex.get(header);
          if (index === undefined || seenInRow.has(header)) {
            continue; // 同名 header 只取首值（游程层已保证列唯一）
          }
          seenInRow.add(header);
          row[index] = coerceCell(cell.value);
        }
        return row;
      });
    const first = run[0];
    const last = run[run.length - 1];
    const inlineDataset: InlineDataset = { columns, rows };
    const locationHint =
      first?.type === "structured_record" && first.provenance.sheet !== undefined
        ? first.provenance.sheet
        : first?.provenance.jsonPath !== undefined
          ? `${first.provenance.jsonPath.split(".")[0]}…`
          : undefined;
    datasets.push({
      sourceId: "",
      blockId: `${first?.blockId ?? "?"}-${last?.blockId ?? "?"}`,
      kind: "records",
      fileName: "",
      ...(locationHint !== undefined ? { locationHint } : {}),
      columns,
      rowCount: rows.length,
      datasetHash: computeDatasetHash(inlineDataset),
      inlineDataset,
    });
    run = [];
  };
  for (const block of blocks) {
    if (block.type === "structured_record") {
      run.push(block);
    } else {
      flush();
    }
  }
  flush();
  return datasets;
}

/** 单个 ParsedDocument → 数据集载荷（sourceId/fileName 由调用方补齐前的中间形态） */
export function extractDatasetsFromDocument(document: ParsedDocument): DatasetPayload[] {
  const payloads: DatasetPayload[] = [];
  for (const block of document.blocks) {
    const table = tableBlockToDataset(block);
    if (table !== null) {
      payloads.push(table);
    }
  }
  payloads.push(...recordRunsToDatasets(document.blocks));
  return payloads.map((payload) => ({
    ...payload,
    sourceId: document.sourceId,
    fileName: document.fileName,
  }));
}

/** 候选视图（不含行数据；列表端点用） */
export function toCandidate(payload: DatasetPayload): DatasetCandidate {
  const { inlineDataset: _inlineDataset, ...candidate } = payload;
  return candidate;
}

/**
 * 按锚取单个数据集（生成 spec 时的服务端取数入口）。
 * blockId 匹配：单块 id 或 "B0012-B0057" 游程区间形态。
 */
export function findDatasetByAnchor(
  payloads: DatasetPayload[],
  sourceId: string,
  blockId: string,
): DatasetPayload | undefined {
  return payloads.find(
    (payload) => payload.sourceId === sourceId && payload.blockId === blockId,
  );
}

/** 数值化导出（测试 / 服务层复用） */
export { coerceCell as coerceDatasetCell };
