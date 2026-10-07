/**
 * 图表 spec（M12.3 C1）：PlotSpec / DiagramSpec 的 typebox schema、确定性校验
 * 与规范化（zero LLM——本模块没有任何模型参与，同输入同输出）。
 *
 * 设计纪律（M12.0 §11.2 / §12 / §13 冻结）：
 *
 * 1. 数据 lineage 是 spec 的一等公民。实际数值数据以 inlineDataset 形式内嵌在
 *    spec 中（它是 dataset 引用的具体化载体，不是 LLM 自由生成的事实源）：
 *    - data.datasetHash = stableStringify({columns, rows}) 的 sha256；
 *    - 校验强制 datasetHash 与 inlineDataset 内容一致——数据被改动而 hash 未
 *      更新 → invalid_spec（这是「数据变化必须显式重生成」的强制路径：内容
 *      变了 hash 必然变，hash 变了 specHash 必然变，见 figureStore.computeSpecHash
 *      ——specHash 的 canonical 序列化范围覆盖完整规范化 spec，包括 datasetHash
 *      与 inlineDataset 本身）；
 *    - origin 锚定数据来源（sourceId+blockId 锚到 ParsedDocument 块，或显式
 *      origin="manual" + note 如实标注）。
 *
 * 2. 缺失值不静默填 0。单元格允许 null 表示缺失；策略二选一：
 *    - "reject"（默认）：使用的列（x + 全部 series）中任一 null → 校验错误，
 *      错误信息列出缺失行号；
 *    - "skip_row"：包含 null 的行在渲染时确定性丢弃（codegen 层执行，规则
 *      与校验层完全一致）。
 *
 * 3. 注入安全分两层（任务书 §12）：schema 层只做「长度 + 字符白名单」宽校验
 *    （拒绝控制字符、超长、非法 slug），转义责任全部在 codegen
 *    （figures/latexEscape.ts 处理 % $ & # _ { } ~ ^ \ 全套 LaTeX 特殊字符）。
 *    spec 里不存在任何能以未转义形态进入 TeX 的路径。唯一例外：DiagramSpec
 *    节点 label 允许 \n（受控换行语义，codegen 转为 TikZ 的 \\ 行分隔 + align
 *    居中），其余文本字段一律单行。
 *
 * 4. 校验返回结构化结果（ok / errors[]），不抛异常——spec 非法是预期内的
 *    业务输入，不是控制流异常。错误信息人读（中文、带字段路径）。
 *
 * 5. 规范化（normalize）：默认值物化（missingPolicy / legend / renderOptions /
 *    variant / role），未声明的键丢弃。规范化形态是 specHash、spec.json 持久化
 *    与 codegen 的唯一输入——「视觉上等价的两个 spec」（缺省 vs 显式默认值）
 *    规范化后深度相等 → 同 specHash → 同 figId → 缓存命中。
 *
 * 6. DiagramSpec 是 node/edge/group 结构模型，两个模板（pipeline / comparison）
 *    只是布局变体，不是通用矢量图形语言——没有任意 TikZ 逃生舱。v1 只支持
 *    DAG（流水线无回边；环被显式拒绝而不是强行布局）。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import { Check, Errors } from "typebox/value";

import { fingerprintJson } from "../util/hash.js";

// ---- 公共常量（长度/字符白名单；schema 层「宽校验」的边界） ----

/**
 * 单行文本：拒绝全部 C0 控制字符（含 \n）与 DEL、U+2028/2029。
 * 注意 LaTeX 特殊字符（% $ & # _ { } ~ ^ \）在这里是允许的——转义责任在 codegen。
 */
const SINGLE_LINE_TEXT_PATTERN = "^[^\\u0000-\\u001F\\u007F\\u2028\\u2029]*$";

/** 多行文本：同上，但允许 \n（唯一受控换行；仅用于 DiagramSpec 节点 label） */
const MULTILINE_TEXT_PATTERN = "^[^\\u0000-\\u0009\\u000B-\\u001F\\u007F\\u2028\\u2029]*$";

/** 安全 slug（node/edge/group id）：字母数字连字符下划线 */
const SLUG_PATTERN = "^[a-zA-Z0-9_-]+$";

/** sha256 hex */
const HASH_PATTERN = "^[0-9a-f]{64}$";

const LABEL_MAX_LENGTH = 200;
const TITLE_MAX_LENGTH = 300;
const CAPTION_MAX_LENGTH = 1000;
const NODE_LABEL_MAX_LENGTH = 400;
const NOTE_MAX_LENGTH = 500;
const CELL_STRING_MAX_LENGTH = 300;

/** 数值/行/列的量级上限：模板化图表的工作负载边界（超限 = spec 非法） */
const MAX_COLUMNS = 64;
const MAX_ROWS = 10_000;
const MAX_SERIES = 12;
const MAX_NODES = 60;
const MAX_EDGES = 200;
const MAX_GROUPS = 20;

// ---- 类型别名（Static 从 schema 推导，单一事实源） ----

export type PlotType = "line" | "bar" | "grouped_bar" | "scatter";
/** 语义子类型 metadata（benchmark_comparison / ablation）：只作标注与检索，不派生新 renderer */
export type PlotSemantic = "benchmark_comparison" | "ablation";
export type MissingValuePolicy = "reject" | "skip_row";
export type DiagramLayoutDir = "vertical" | "horizontal";
export type DiagramVariant = "pipeline" | "comparison";
export type DiagramNodeRole = "stage" | "annotation" | "left" | "right";

/** 数据来源锚（M12.0 §13 dataOrigin）：结构化溯源，禁止自由文本 */
export type DataOrigin = { sourceId: string; blockId?: string } | { origin: "manual"; note: string };

export interface InlineDataset {
  columns: string[];
  /** 行×列网格；单元格 = 数值 | 类目字符串 | null（缺失） */
  rows: (number | string | null)[][];
}

export interface RenderOptions {
  widthCm: number;
  heightCm: number;
  markSizePt: number;
}

/** 校验通过后的规范化 PlotSpec（默认值已物化；codegen 的输入类型） */
export interface NormalizedPlotSpec {
  plotType: PlotType;
  semantic?: PlotSemantic;
  title?: string;
  caption?: string;
  data: {
    origin: DataOrigin;
    datasetHash: string;
    /** 列名引用（dataset.columns 中的列）。v1 恰好 1 列；数组形态为后续图型预留 */
    x: string[];
    series: Array<{ name: string; column: string }>;
    missingPolicy: MissingValuePolicy;
    inlineDataset: InlineDataset;
  };
  axis: {
    xLabel?: string;
    yLabel?: string;
    /** 图例显示（默认：多 series 时显示、单 series 隐藏；显式 false 恒不显示） */
    legend: boolean;
    renderOptions: RenderOptions;
  };
}

/** 校验通过后的规范化 DiagramSpec（variant/role 默认值已物化） */
export interface NormalizedDiagramSpec {
  layout: DiagramLayoutDir;
  variant: DiagramVariant;
  nodes: Array<{ id: string; label: string; group?: string; role: DiagramNodeRole }>;
  edges: Array<{ from: string; to: string; label?: string }>;
  groups: Array<{ id: string; label?: string }>;
  title?: string;
}

// ---- schema（typebox） ----

const singleLineText = (maxLength: number) =>
  Type.String({ minLength: 1, maxLength, pattern: SINGLE_LINE_TEXT_PATTERN });

const columnName = Type.String({
  minLength: 1,
  maxLength: LABEL_MAX_LENGTH,
  pattern: SINGLE_LINE_TEXT_PATTERN,
});

const DataOriginSchema = Type.Union([
  Type.Object({
    sourceId: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
    blockId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: SINGLE_LINE_TEXT_PATTERN })),
  }),
  Type.Object({ origin: Type.Literal("manual"), note: Type.String({ minLength: 1, maxLength: NOTE_MAX_LENGTH, pattern: SINGLE_LINE_TEXT_PATTERN }) }),
]);

const InlineDatasetSchema = Type.Object({
  columns: Type.Array(columnName, { minItems: 1, maxItems: MAX_COLUMNS }),
  rows: Type.Array(
    Type.Array(
      Type.Union([
        Type.Number(),
        Type.String({ minLength: 1, maxLength: CELL_STRING_MAX_LENGTH, pattern: SINGLE_LINE_TEXT_PATTERN }),
        Type.Null(),
      ]),
      { minItems: 1, maxItems: MAX_COLUMNS },
    ),
    { minItems: 1, maxItems: MAX_ROWS },
  ),
});

export const PlotSpecSchema = Type.Object({
  plotType: Type.Union([Type.Literal("line"), Type.Literal("bar"), Type.Literal("grouped_bar"), Type.Literal("scatter")]),
  semantic: Type.Optional(
    Type.Union([Type.Literal("benchmark_comparison"), Type.Literal("ablation")]),
  ),
  title: Type.Optional(singleLineText(TITLE_MAX_LENGTH)),
  caption: Type.Optional(singleLineText(CAPTION_MAX_LENGTH)),
  data: Type.Object({
    origin: DataOriginSchema,
    datasetHash: Type.String({ pattern: HASH_PATTERN }),
    x: Type.Array(columnName, { minItems: 1, maxItems: 4 }),
    series: Type.Array(
      Type.Object({ name: singleLineText(LABEL_MAX_LENGTH), column: columnName }),
      { minItems: 1, maxItems: MAX_SERIES },
    ),
    missingPolicy: Type.Optional(Type.Union([Type.Literal("reject"), Type.Literal("skip_row")])),
    inlineDataset: InlineDatasetSchema,
  }),
  axis: Type.Object({
    xLabel: Type.Optional(singleLineText(LABEL_MAX_LENGTH)),
    yLabel: Type.Optional(singleLineText(LABEL_MAX_LENGTH)),
    legend: Type.Optional(Type.Boolean()),
    renderOptions: Type.Optional(
      Type.Object({
        widthCm: Type.Optional(Type.Number({ minimum: 4, maximum: 40 })),
        heightCm: Type.Optional(Type.Number({ minimum: 3, maximum: 40 })),
        markSizePt: Type.Optional(Type.Number({ minimum: 0.1, maximum: 10 })),
      }),
    ),
  }),
});

export const DiagramSpecSchema = Type.Object({
  layout: Type.Union([Type.Literal("vertical"), Type.Literal("horizontal")]),
  variant: Type.Optional(Type.Union([Type.Literal("pipeline"), Type.Literal("comparison")])),
  nodes: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1, maxLength: 64, pattern: SLUG_PATTERN }),
      label: Type.String({ minLength: 1, maxLength: NODE_LABEL_MAX_LENGTH, pattern: MULTILINE_TEXT_PATTERN }),
      group: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: SLUG_PATTERN })),
      role: Type.Optional(
        Type.Union([Type.Literal("stage"), Type.Literal("annotation"), Type.Literal("left"), Type.Literal("right")]),
      ),
    }),
    { minItems: 1, maxItems: MAX_NODES },
  ),
  edges: Type.Array(
    Type.Object({
      from: Type.String({ minLength: 1, maxLength: 64, pattern: SLUG_PATTERN }),
      to: Type.String({ minLength: 1, maxLength: 64, pattern: SLUG_PATTERN }),
      label: Type.Optional(singleLineText(LABEL_MAX_LENGTH)),
    }),
    { minItems: 0, maxItems: MAX_EDGES },
  ),
  groups: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String({ minLength: 1, maxLength: 64, pattern: SLUG_PATTERN }),
        label: Type.Optional(singleLineText(LABEL_MAX_LENGTH)),
      }),
      { minItems: 1, maxItems: MAX_GROUPS },
    ),
  ),
  title: Type.Optional(singleLineText(TITLE_MAX_LENGTH)),
});

/** 输入形态（schema 原样推导；默认值未物化） */
export type PlotSpec = Static<typeof PlotSpecSchema>;
export type DiagramSpec = Static<typeof DiagramSpecSchema>;

// ---- 校验结果 ----

export interface SpecValidationResult<T> {
  ok: boolean;
  /** ok=true 时给出规范化 spec（默认值物化、未知键丢弃） */
  spec?: T;
  /** ok=false 时的人读错误（中文、含字段路径） */
  errors: string[];
}

// ---- datasetHash（数据一致性锚） ----

/**
 * datasetHash = stableStringify({columns, rows}) 的 sha256（fingerprintJson：
 * 键排序、数组保序——行序是数据的一部分，重排行 = 数据变化 = hash 变化）。
 */
export function computeDatasetHash(dataset: InlineDataset): string {
  return fingerprintJson({ columns: dataset.columns, rows: dataset.rows });
}

// ---- PlotSpec 校验 ----

/**
 * 校验 + 规范化 PlotSpec。两层：
 * 1. schema 层（typebox Check）：结构 / 枚举 / 长度 / 字符白名单；
 * 2. 语义层（本函数内的确定性检查）：列引用存在、数值列有限、缺失值策略、
 *    datasetHash 一致。
 */
export function validatePlotSpec(input: unknown): SpecValidationResult<NormalizedPlotSpec> {
  if (!Check(PlotSpecSchema, input)) {
    return { ok: false, errors: formatSchemaErrors(Errors(PlotSpecSchema, input)) };
  }
  const spec = input as PlotSpec;
  const errors = validatePlotSemantics(spec);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, spec: normalizePlotSpec(spec), errors: [] };
}

function validatePlotSemantics(spec: PlotSpec): string[] {
  const errors: string[] = [];
  const data = spec.data;
  const dataset = data.inlineDataset;

  // 列名唯一
  const columnSet = new Set<string>();
  for (const column of dataset.columns) {
    if (columnSet.has(column)) {
      errors.push(`inlineDataset.columns 存在重复列名："${column}"`);
    }
    columnSet.add(column);
  }

  // x 列引用：v1 恰好 1 列（数组形态为后续图型预留，宽进严出）
  if (data.x.length !== 1) {
    errors.push(`data.x 目前仅支持恰好 1 个 x 列（收到 ${data.x.length} 个；数组形态为后续图型预留）`);
  }
  const xColumn = data.x[0];
  if (xColumn !== undefined && !columnSet.has(xColumn)) {
    errors.push(`data.x 引用的列不存在：${xColumn}`);
  }

  // series 列引用唯一 + 名称唯一（legend 语义要求）
  const usedSeriesColumns = new Set<string>();
  const seriesNames = new Set<string>();
  data.series.forEach((series, index) => {
    if (!columnSet.has(series.column)) {
      errors.push(`data.series[${index}]（${series.name}）引用的列不存在：${series.column}`);
    }
    if (usedSeriesColumns.has(series.column)) {
      errors.push(`data.series[${index}]（${series.name}）重复引用列：${series.column}`);
    }
    if (seriesNames.has(series.name)) {
      errors.push(`data.series 名称重复：${series.name}`);
    }
    usedSeriesColumns.add(series.column);
    seriesNames.add(series.name);
  });

  // datasetHash 一致性（数据内容锚）
  if (computeDatasetHash(dataset) !== data.datasetHash) {
    errors.push(
      "data.datasetHash 与 inlineDataset 内容不一致（数据变更必须重新计算 datasetHash——校验层强制「数据变了必须显式重生成」）",
    );
  }

  // 数值语义：x / series 列的类型与缺失
  const xIndex = xColumn === undefined ? -1 : dataset.columns.indexOf(xColumn);
  const seriesIndexes = data.series.map((series) => ({
    name: series.name,
    column: series.column,
    index: dataset.columns.indexOf(series.column),
  }));
  const categoricalX = spec.plotType === "bar" || spec.plotType === "grouped_bar";
  const missingRows: number[] = [];

  dataset.rows.forEach((row, rowIndex) => {
    if (row.length !== dataset.columns.length) {
      errors.push(
        `inlineDataset.rows[${rowIndex}] 宽度 ${row.length} 与 columns（${dataset.columns.length} 列）不一致`,
      );
      return;
    }
    // x 单元格
    if (xIndex >= 0) {
      const cell = row[xIndex];
      if (cell === null) {
        missingRows.push(rowIndex);
      } else if (typeof cell === "number") {
        if (!Number.isFinite(cell)) {
          errors.push(`x 列（${xColumn}）第 ${rowIndex} 行不是有限数值：${cell}`);
        }
      } else if (!categoricalX) {
        errors.push(
          `x 列（${xColumn}）第 ${rowIndex} 行必须是数值（plotType=${spec.plotType} 不支持字符串 x；类目轴请使用 bar / grouped_bar）：${JSON.stringify(cell)}`,
        );
      }
    }
    // series 单元格
    for (const { name, column, index } of seriesIndexes) {
      if (index < 0) {
        continue; // 引用错误已在上面报告
      }
      const cell = row[index];
      if (cell === null) {
        missingRows.push(rowIndex);
      } else if (typeof cell === "number") {
        if (!Number.isFinite(cell)) {
          errors.push(`series（${name}，列 ${column}）第 ${rowIndex} 行不是有限数值：${cell}`);
        }
      } else {
        errors.push(
          `series（${name}，列 ${column}）第 ${rowIndex} 行必须是数值（series 列不支持字符串）：${JSON.stringify(cell)}`,
        );
      }
    }
  });

  if (missingRows.length > 0 && (data.missingPolicy ?? "reject") === "reject") {
    const sample = missingRows.slice(0, 5).join("、");
    const suffix = missingRows.length > 5 ? ` 等 ${missingRows.length} 行` : "";
    errors.push(
      `使用的列（x + series）存在缺失值（null）：第 ${sample} 行${suffix}；缺失值策略默认 reject（不静默填 0），如需跳过这些行请显式 missingPolicy="skip_row"`,
    );
  }

  return errors;
}

function normalizePlotSpec(spec: PlotSpec): NormalizedPlotSpec {
  const render = spec.axis.renderOptions;
  return {
    plotType: spec.plotType,
    ...(spec.semantic !== undefined ? { semantic: spec.semantic } : {}),
    ...(spec.title !== undefined ? { title: spec.title } : {}),
    ...(spec.caption !== undefined ? { caption: spec.caption } : {}),
    data: {
      origin: spec.data.origin,
      datasetHash: spec.data.datasetHash,
      x: [...spec.data.x],
      series: spec.data.series.map((series) => ({ ...series })),
      missingPolicy: spec.data.missingPolicy ?? "reject",
      inlineDataset: {
        columns: [...spec.data.inlineDataset.columns],
        rows: spec.data.inlineDataset.rows.map((row) => [...row]),
      },
    },
    axis: {
      ...(spec.axis.xLabel !== undefined ? { xLabel: spec.axis.xLabel } : {}),
      ...(spec.axis.yLabel !== undefined ? { yLabel: spec.axis.yLabel } : {}),
      legend: spec.axis.legend ?? spec.data.series.length > 1,
      renderOptions: {
        widthCm: render?.widthCm ?? 12,
        heightCm: render?.heightCm ?? 8,
        markSizePt: render?.markSizePt ?? 1.5,
      },
    },
  };
}

// ---- DiagramSpec 校验 ----

/**
 * 校验 + 规范化 DiagramSpec。语义层规则（v1 冻结，逐条理由）：
 * - node id 唯一且为安全 slug（slug 直接成为 TikZ node 名——白名单字符保证
 *   不可能构造出 TeX 语法）；
 * - edge 端点必须存在；自环与重复边拒绝（模板布局无意义）；
 * - node.group 必须指向声明的 group；group 至少有 1 个成员（空 fit 框无意义）；
 * - comparison 变体：每个节点必须显式 role=left|right（缺省即错——对比图两侧
 *   语义必须由作者声明，不猜测）；两侧各至少 1 节点；stage/annotation 拒绝；
 * - pipeline 变体：role 缺省物化为 stage；left/right 拒绝（那是 comparison
 *   专属语义）；annotation 必须至少有一条边（注释必须指向/来自主流水线节点，
 *   悬空注释没有布局锚点）；annotation 之间不能互连（注释的语义是补充主流水线）；
 * - edges 必须构成 DAG（Kahn 拓扑判定）：pipeline 模板是分层布局，回边会破坏
 *   分层不变量——显式拒绝而不是产出错乱布局。
 */
export function validateDiagramSpec(input: unknown): SpecValidationResult<NormalizedDiagramSpec> {
  if (!Check(DiagramSpecSchema, input)) {
    return { ok: false, errors: formatSchemaErrors(Errors(DiagramSpecSchema, input)) };
  }
  const spec = input as DiagramSpec;
  const errors = validateDiagramSemantics(spec);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, spec: normalizeDiagramSpec(spec), errors: [] };
}

function validateDiagramSemantics(spec: DiagramSpec): string[] {
  const errors: string[] = [];
  const variant = spec.variant ?? "pipeline";

  // 节点 id 唯一（slug 合法性由 schema 层保证）
  const nodeIds = new Set<string>();
  for (const node of spec.nodes) {
    if (nodeIds.has(node.id)) {
      errors.push(`nodes.id 重复：${node.id}`);
    }
    nodeIds.add(node.id);
  }

  // 角色（规范化后的口径）与变体规则
  const roleById = new Map<string, DiagramNodeRole>();
  let hasLeft = false;
  let hasRight = false;
  for (const node of spec.nodes) {
    const role: DiagramNodeRole | undefined =
      node.role ?? (variant === "pipeline" ? "stage" : undefined);
    if (role === undefined) {
      errors.push(`comparison 变体要求每个节点显式 role="left"|"right"（节点 ${node.id} 缺失 role）`);
      continue;
    }
    if (variant === "pipeline" && (role === "left" || role === "right")) {
      errors.push(`pipeline 变体不允许 left/right 角色（节点 ${node.id}；该角色是 comparison 专属）`);
    }
    if (variant === "comparison" && (role === "stage" || role === "annotation")) {
      errors.push(`comparison 变体不允许 stage/annotation 角色（节点 ${node.id}；两侧节点请用 left/right）`);
    }
    if (role === "left") {
      hasLeft = true;
    }
    if (role === "right") {
      hasRight = true;
    }
    roleById.set(node.id, role);
  }
  if (variant === "comparison") {
    if (!hasLeft) {
      errors.push("comparison 变体缺少 left 侧节点");
    }
    if (!hasRight) {
      errors.push("comparison 变体缺少 right 侧节点");
    }
  }

  // 边：端点存在 / 自环 / 重复 / annotation 互连
  const edgeKeys = new Set<string>();
  spec.edges.forEach((edge, index) => {
    if (!nodeIds.has(edge.from)) {
      errors.push(`edges[${index}]（${edge.from} -> ${edge.to}）from 引用不存在的节点：${edge.from}`);
    }
    if (!nodeIds.has(edge.to)) {
      errors.push(`edges[${index}]（${edge.from} -> ${edge.to}）to 引用不存在的节点：${edge.to}`);
    }
    if (edge.from === edge.to) {
      errors.push(`edges[${index}] 自环（from === to）：${edge.from}`);
    }
    const key = `${edge.from}->${edge.to}`;
    if (edgeKeys.has(key)) {
      errors.push(`edges 重复：${key}`);
    }
    edgeKeys.add(key);
    if (roleById.get(edge.from) === "annotation" && roleById.get(edge.to) === "annotation") {
      errors.push(
        `edges[${index}]（${edge.from} -> ${edge.to}）两个端点都是 annotation：注释节点只能连接主流水线节点`,
      );
    }
  });

  // annotation 必须有连接（布局锚点 = 其连接的主流水线节点）
  if (variant === "pipeline") {
    for (const node of spec.nodes) {
      if ((node.role ?? "stage") === "annotation") {
        const connected = spec.edges.some((edge) => edge.from === node.id || edge.to === node.id);
        if (!connected) {
          errors.push(
            `annotation 节点 ${node.id} 没有任何边（注释必须指向或来自一个主流水线节点，否则没有布局锚点）`,
          );
        }
      }
    }
  }

  // group：声明 + 成员
  const groupIds = new Set<string>();
  for (const group of spec.groups ?? []) {
    if (groupIds.has(group.id)) {
      errors.push(`groups.id 重复：${group.id}`);
    }
    groupIds.add(group.id);
  }
  const memberCount = new Map<string, number>([...groupIds].map((id) => [id, 0] as const));
  for (const node of spec.nodes) {
    if (node.group === undefined) {
      continue;
    }
    if (!groupIds.has(node.group)) {
      errors.push(`节点 ${node.id} 引用未声明的 group：${node.group}`);
    } else {
      memberCount.set(node.group, (memberCount.get(node.group) ?? 0) + 1);
    }
  }
  for (const [groupId, count] of memberCount) {
    if (count === 0) {
      errors.push(`group ${groupId} 没有任何成员节点`);
    }
  }

  // DAG（Kahn）：processed < 节点数 ⇔ 存在环
  const indegree = new Map<string, number>(spec.nodes.map((node) => [node.id, 0] as const));
  const adjacency = new Map<string, string[]>(spec.nodes.map((node) => [node.id, [] as string[]] as const));
  for (const edge of spec.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      continue; // 端点错误已报告
    }
    adjacency.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const queue = spec.nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
  let processed = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    processed += 1;
    for (const next of adjacency.get(current) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) {
        queue.push(next);
      }
    }
  }
  if (processed < spec.nodes.length) {
    errors.push(
      `edges 构成环（${spec.nodes.length - processed} 个节点无法拓扑排序）：v1 模板只支持 DAG 流水线（回边显式拒绝，不强行布局）`,
    );
  }

  return errors;
}

function normalizeDiagramSpec(spec: DiagramSpec): NormalizedDiagramSpec {
  const variant = spec.variant ?? "pipeline";
  return {
    layout: spec.layout,
    variant,
    nodes: spec.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      ...(node.group !== undefined ? { group: node.group } : {}),
      role: node.role ?? "stage",
    })),
    edges: spec.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      ...(edge.label !== undefined ? { label: edge.label } : {}),
    })),
    groups: (spec.groups ?? []).map((group) => ({
      id: group.id,
      ...(group.label !== undefined ? { label: group.label } : {}),
    })),
    ...(spec.title !== undefined ? { title: spec.title } : {}),
  };
}

// ---- schema 错误格式化 ----

/** typebox 错误 → 人读中文（路径 + 关键字消息），最多 8 条防刷屏 */
function formatSchemaErrors(errors: ReadonlyArray<{ instancePath?: string; message?: string }>): string[] {
  const formatted = errors.slice(0, 8).map((error) => {
    const path = error.instancePath === undefined || error.instancePath === "" ? "<根>" : error.instancePath;
    return `${path}：${error.message ?? "不符合 schema"}`;
  });
  if (errors.length > 8) {
    formatted.push(`…另有 ${errors.length - 8} 处 schema 错误`);
  }
  return formatted;
}
