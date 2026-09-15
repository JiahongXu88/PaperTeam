/**
 * Fact Preservation Gate（M5.6 第二层，确定性、无 LLM）。
 *
 * 真实 pair-02 盲评暴露：Citation Preservation 通过的修订仍可能改写实验事实——
 * 候选稿出现表格数值替换（45→28、35.9%→38.7%）、漏检比例与结论方向反转、
 * 部署协议弱化（18 min/621 帧 → 15–20 min）、真实结果被替换成「待回填」占位、
 * 公式项被替换、以及无 Evidence 依据的新增超参数/实现细节。
 *
 * 口径（与 Citation Preservation 同构）：
 *   * 事实源是不可变修订快照（manuscript/revisions/rev-{n}/）：previous = 被审阅
 *     修订的前一个修订，current = 被审阅修订。
 *   * 默认 protected：previous 已存在的实验事实（表格单元格数值 / 正文数字+单位 /
 *     公式内容 / 方向性结论 / 数据集划分 / 硬件型号）不得无依据变化、消失或被占位。
 *   * authorized fact change 只承认结构化依据：
 *       - 计划条目（RevisionPlan planned / 改进计划）文本同时点名旧值与新值；
 *       - 计划点名旧值且 Evidence 文本包含新值；
 *       - needsEvidence 条目命中的章节内允许**删除/弱化论述**（连带其 prose 数字），
 *         但不授权改表格单元格、公式与方向性结论；
 *       - 新增数字要求出现在 Evidence 或计划文本中。
 *     自由文本里的「优化实验描述」不构成任何数字修改的依据。
 *   * 无法可靠判定 → FAIL（宁可 needs_review，不静默放行）。
 *   * 不可比较（无前序修订 / 快照缺失 / 用户恢复历史修订）→ null，以
 *     fact_preservation_not_applicable 中性规则呈现，绝不伪造 PASS。
 *
 * 诚实边界：这是保守的必要条件守卫，不是语义等价证明。方向哨兵只检测确定的
 * 方向反转（负结果→优势 / 基本一致→优势 / 同指标比较方向对调）；检测不到的
 * 语义改写仍依赖 Reviewer 与人审。
 */

import type { RevisionPlan, RevisionPlanItem } from "../review/revisionPlan.js";
import {
  extractMathSegments,
  extractNumericTokens,
} from "../review/styleInvariants.js";

export interface FactTexFile {
  /** 相对 manuscript 目录的 POSIX 路径 */
  file: string;
  content: string;
}

export interface FactSnapshot {
  revision: number;
  files: FactTexFile[];
}

export type FactFindingKind =
  | "changed"
  | "removed"
  | "added_unsupported"
  | "directional"
  | "formula"
  | "placeholder";

export interface FactFinding {
  kind: FactFindingKind;
  /** 相对 manuscript 的文件路径 */
  file: string;
  /** 近似章节（离事实最近的 \section / \subsection 标题） */
  section: string;
  /** 修改前短片段（≤ 90 字符） */
  before: string;
  /** 修改后短片段（≤ 90 字符）；纯删除时为空串 */
  after: string;
  /** 机器可读原因（table_cell / prose_number / formula / negative_to_advantage …） */
  reason: string;
  /** 命中的授权（只出现在被放行的变更统计里；违规 finding 恒无授权） */
  authorization?: { basis: string; planItemId: string };
}

export interface FactPreservationSummary {
  previousRevision: number;
  currentRevision: number;
  changedFacts: FactFinding[];
  removedFacts: FactFinding[];
  addedUnsupportedFacts: FactFinding[];
  directionalChanges: FactFinding[];
  formulaChanges: FactFinding[];
  placeholderRegressions: FactFinding[];
  /** 有计划 / Evidence 依据被放行的变更与删除数（审计口径） */
  allowedChanges: number;
  allowedRemovals: number;
  planId: string | null;
  /** 全部违规数组为空 */
  ok: boolean;
}

export interface FactPreservationInput {
  previous: FactSnapshot;
  current: FactSnapshot;
  /** sourceRevision == previous.revision 的确定性修订计划（无则 null） */
  plan: RevisionPlan | null;
  /** Existing-Paper 改进计划条目（与 Citation Preservation 同源） */
  improvementPlanItems?: { section: string; action: string; rationale?: string }[];
  /** Evidence 文本（claims + quotes + summaries；新增/替换值的授权依据） */
  evidenceTexts?: string[];
}

// ---- 提取：表格 ----

interface LatexTable {
  /** 匹配用标识：\label > caption > 序号 */
  key: string;
  label: string | null;
  caption: string;
  /** 行单元格原文（已去命令残留、trim） */
  rows: string[][];
  ordinal: number;
}

const TABLE_ENV_PATTERN = /\\begin\{table\*?\}([\s\S]*?)\\end\{table\*?\}/g;
const TABULAR_PATTERN = /\\begin\{tabular[xX*]*\}{[^}]*}([\s\S]*?)\\end\{tabular[xX*]*\}/;

/** 清理单元格文本：留数字/字母/中文/常用符号，压空白 */
function cleanCell(raw: string): string {
  return raw
    .replace(/\\(?:multicolumn|multirow)\{[^{}]*\}\{[^{}]*\}\{([^{}]*)\}/g, "$1")
    .replace(/\\[A-Za-z@]+\*?/g, " ")
    .replace(/[${}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTables(content: string): LatexTable[] {
  const tables: LatexTable[] = [];
  let ordinal = 0;
  for (const envMatch of content.matchAll(TABLE_ENV_PATTERN)) {
    const body = envMatch[1] ?? "";
    const labelMatch = /\\label\{([^}]*)\}/.exec(body);
    const captionMatch = /\\caption\{([^}]*)\}/.exec(body);
    const label = labelMatch !== null ? (labelMatch[1] ?? "").trim() : null;
    const caption = cleanCell(captionMatch !== null ? (captionMatch[1] ?? "") : "");
    const tabularMatch = TABULAR_PATTERN.exec(body);
    const rows: string[][] = [];
    if (tabularMatch !== null) {
      const raw = tabularMatch[1] ?? "";
      for (const rawRow of raw.split(/\\\\(?!\()\s*(?:\[[^\]]*\])?/)) {
        const cells = rawRow.split("&").map((cell) => cleanCell(cell));
        const meaningful = cells.filter((cell) => cell !== "").length;
        if (meaningful === 0 || cells.length < 2) {
          continue; // 表头规则行 / 空行
        }
        rows.push(cells);
      }
    }
    tables.push({
      key: label !== null ? `label:${label}` : caption !== "" ? `caption:${caption}` : `ordinal:${ordinal}`,
      label,
      caption,
      rows,
      ordinal,
    });
    ordinal += 1;
  }
  return tables;
}

// ---- 提取：占位 / 方向 / 协议哨兵 ----

const PLACEHOLDER_PATTERN = /(待回填|待补充|待验证|待确认|待归档|暂无数据|待实验产出|TBD|TODO)/g;
/** .test() 用（/g 正则的 test 有 lastIndex 状态，必须与 matchAll 分开） */
const PLACEHOLDER_TEST = /(待回填|待补充|待验证|待确认|待归档|暂无数据|待实验产出|TBD|TODO)/;

function countPlaceholders(content: string): number {
  return [...content.matchAll(PLACEHOLDER_PATTERN)].length;
}

/** 硬件型号（保守白名单：常见边缘板卡 / GPU / SoC 形态） */
const HARDWARE_PATTERN =
  /(RDK\s?X\d|RK\d{4}|Jetson\s?[A-Za-z]+\d*|Xavier(?:\s?NX)?|Orin(?:\s?NX)?|旭日[^\s，。；]{0,4}|地平线|树莓派|Raspberry\s?Pi\s?\d*|RTX\s?\d{3,4}|GTX\s?\d{3,4}|\b(?:V100|A100|H100|A800|H800)\b|Intel\s?[A-Za-z]+\s?\d{4,}|i[3579]-\d{4,}[A-Za-z]*)/g;

/** 数据集划分表述 */
const OFFICIAL_SPLIT_PATTERN = /(官方|标准|official|原论文|原文)[^\n。；]{0,14}(划分|split)/i;
const CUSTOM_SPLIT_PATTERN = /(自定义|自行|重新|new|custom)[^\n。；]{0,14}(划分|split)/i;

/** 本文方法的优势 / 劣势 / 持平结论词（文件级方向规则） */
const ADVANTAGE_WORDS =
  /(优于|更优|更好|更强|领先|保持优势|优势明显|明显优势|全面超过|胜过|反超)/;
const DISADVANTAGE_WORDS = /(更差|劣于|差于|落后|劣势|不及|不如|恶化|退化|退步|额外增加|仍较敏感)/;
const PARITY_WORDS = /(基本一致|大致相当|差异不大|相差不大|性能相当|接近|相近|相当)/;

/** 指标 token（metric 级方向对调用） */
const METRIC_PATTERN =
  /(IDF1|MOTA|IDS\b|ID Switch|HOTA|DetA|AssA|Frag\b|FPS|fps|mAP|AP\b|RSS|Norm-IDS|latency|Latency|漏检|误报|延迟|内存|温度|精度|身份切换|召回|查准)/;

/** 比较方向对（metric 级：同指标的正反词互换） */
const POSITIVE_DIRECTION = new Set(["高于", "优于", "超过", "提升", "增加", "升至"]);

// ---- 通用工具 ----

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

function snippet(text: string, maxLength = 90): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

/** 数字边界安全包含（47 不匹配 147 / 47.5） */
function mentionsValue(texts: readonly string[], value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![\\w.])${escaped}(?![\\w.])`);
  return texts.some((text) => pattern.test(text));
}

/** 离内容位置最近的 \section / \subsection 标题（无则 "(global)"） */
function nearestSection(content: string, index: number): string {
  const before = content.slice(0, index);
  const matches = [...before.matchAll(/\\(?:sub)*section\*?\{([^}]*)\}/g)];
  const last = matches.at(-1);
  return last !== undefined ? (last[1] ?? "").trim() : "(global)";
}

/** 值所在行（报告片段用） */
function lineOf(content: string, index: number): string {
  const start = content.lastIndexOf("\n", index) + 1;
  const end = content.indexOf("\n", index);
  return content.slice(start, end === -1 ? content.length : end);
}

// ---- 授权 ----

interface AuthorizationContext {
  planTexts: { id: string; section: string; text: string }[];
  improvementTexts: { id: string; section: string; text: string }[];
  evidenceTexts: string[];
  needsEvidenceItems: RevisionPlanItem[];
}

function buildAuthorization(
  plan: RevisionPlan | null,
  improvementPlanItems: FactPreservationInput["improvementPlanItems"],
  evidenceTexts: readonly string[],
): AuthorizationContext {
  const planTexts = (plan?.items ?? [])
    .filter((item) => item.status === "planned")
    .map((item) => ({
      id: item.id,
      section: item.section,
      text: `${item.problem}\n${item.instruction}\n${item.expectedOutcome}`,
    }));
  const improvementTexts = (improvementPlanItems ?? []).map((item, index) => ({
    id: `improvement-plan:${index}`,
    section: item.section,
    text: `${item.action}\n${item.rationale ?? ""}`,
  }));
  const needsEvidenceItems = (plan?.items ?? []).filter(
    (item) => item.status === "planned" && item.needsEvidence === true,
  );
  return { planTexts, improvementTexts, evidenceTexts: [...evidenceTexts], needsEvidenceItems };
}

/** 计划条目是否显式指向该章节（与 Citation Preservation 同口径的宽松匹配） */
function sectionRefMatchesFile(sectionRef: string, file: string): boolean {
  const ref = sectionRef.trim().replaceAll("\\", "/").toLowerCase();
  if (ref === "" || ref === "(global)" || ref === "(unknown)") {
    return false;
  }
  const path = file.replaceAll("\\", "/").toLowerCase();
  const fileName = path.split("/").pop() ?? path;
  const stem = fileName.replace(/\.tex$/, "");
  return (
    ref === path ||
    ref === fileName ||
    ref === stem ||
    ref.endsWith(`/${path}`) ||
    path.endsWith(ref) ||
    (stem !== "" && ref.includes(stem))
  );
}

/** 值变更授权：计划点名旧值且（点名新值 或 Evidence 含新值） */
function valueChangeAuthorized(
  auth: AuthorizationContext,
  before: string,
  after: string,
): { basis: string; planItemId: string } | null {
  const entries = [...auth.planTexts, ...auth.improvementTexts];
  for (const entry of entries) {
    if (mentionsValue([entry.text], before)) {
      if (mentionsValue([entry.text], after)) {
        return { basis: "plan_value_correction", planItemId: entry.id };
      }
      if (mentionsValue(auth.evidenceTexts, after)) {
        return { basis: "plan_and_evidence", planItemId: entry.id };
      }
    }
  }
  return null;
}

/** 值删除授权：needsEvidence 条目命中章节，或计划点名值且明示删除/弱化 */
const REMOVAL_WORDS = /(删除|移除|弱化|去掉|删去|剪除)/;

function valueRemovalAuthorized(
  auth: AuthorizationContext,
  before: string,
  file: string,
): { basis: string; planItemId: string } | null {
  const covering = auth.needsEvidenceItems.find((item) => sectionRefMatchesFile(item.section, file));
  if (covering !== undefined) {
    return { basis: "planned_evidence_removal", planItemId: covering.id };
  }
  const entries = [...auth.planTexts, ...auth.improvementTexts];
  for (const entry of entries) {
    if (mentionsValue([entry.text], before) && REMOVAL_WORDS.test(entry.text)) {
      return { basis: "planned_value_removal", planItemId: entry.id };
    }
  }
  return null;
}

/** 值新增授权：Evidence 或计划文本包含该值 */
function valueAdditionAuthorized(
  auth: AuthorizationContext,
  value: string,
): { basis: string; planItemId: string } | null {
  if (mentionsValue(auth.evidenceTexts, value)) {
    return { basis: "evidence", planItemId: "(evidence)" };
  }
  const entries = [...auth.planTexts, ...auth.improvementTexts];
  for (const entry of entries) {
    if (mentionsValue([entry.text], value)) {
      return { basis: "plan_value", planItemId: entry.id };
    }
  }
  return null;
}

/** 公式变更授权：计划明确提及公式修正 */
const FORMULA_WORDS = /(公式|equation|数学表达|损失函数|loss)/i;

function formulaChangeAuthorized(auth: AuthorizationContext): { basis: string; planItemId: string } | null {
  const entries = [...auth.planTexts, ...auth.improvementTexts];
  for (const entry of entries) {
    if (FORMULA_WORDS.test(entry.text)) {
      return { basis: "planned_formula_change", planItemId: entry.id };
    }
  }
  return null;
}

/** 方向结论变更授权：计划明确提及该结论方向（点名变更词或「结论表述」） */
const DIRECTION_AUTH_WORDS = /(结论|表述|优势|一致|方向|劣势|劣于|优于|高于|低于|比较)/;

function directionChangeAuthorized(
  auth: AuthorizationContext,
  file: string,
): { basis: string; planItemId: string } | null {
  const entries = [...auth.planTexts, ...auth.improvementTexts];
  for (const entry of entries) {
    if (DIRECTION_AUTH_WORDS.test(entry.text) && sectionRefMatchesFile(entry.section, file)) {
      return { basis: "planned_direction_change", planItemId: entry.id };
    }
  }
  return null;
}

// ---- 数字事实（prose；排除表格与数学环境） ----

function stripTablesAndMath(content: string): string {
  let text = normalizeContent(content);
  text = text.replace(TABLE_ENV_PATTERN, " ");
  text = text.replace(TABULAR_PATTERN, " ");
  text = text.replace(/\\\[[\s\S]*?\\\]/g, " ").replace(/\\\(([\s\S]*?)\\\)/g, " ");
  text = text.replace(/\$\$[\s\S]*?\$\$/g, " ").replace(/(?<!\\)\$[^$\n]+?(?<!\\)\$/g, " ");
  return text;
}

function proseNumberTokens(content: string): string[] {
  return extractNumericTokens(stripTablesAndMath(content));
}

function indexOfToken(content: string, token: string): number {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  const pattern = new RegExp(`(?<![\\w.])${escaped}`);
  const match = pattern.exec(content);
  return match !== null ? match.index : -1;
}

/** 多重集差异（值语义：missing = previous 多出的，added = current 多出的） */
function multisetDiff(
  before: readonly string[],
  after: readonly string[],
): { missing: string[]; added: string[] } {
  const counts = new Map<string, number>();
  for (const item of before) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  for (const item of after) {
    const count = counts.get(item) ?? 0;
    if (count > 0) {
      counts.set(item, count - 1);
    } else {
      counts.set(item, -1);
    }
  }
  const missing: string[] = [];
  const added: string[] = [];
  for (const [item, count] of counts) {
    for (let i = 0; i < count; i += 1) {
      missing.push(item);
    }
    for (let i = 0; i < -count; i += 1) {
      added.push(item);
    }
  }
  return { missing, added };
}

/** 事实型新增数字（过滤裸整数噪音）：百分比 / 带单位 / 阈值式 */
function isFactLikeAddition(token: string): boolean {
  if (/%|‰/.test(token)) {
    return true;
  }
  if (/[A-Za-zμ]{1,6}$/.test(token.replace(/[.,]/g, "")) && /\d/.test(token)) {
    return true;
  }
  if (/(帧|次|维|倍|个|张|轮|epoch|batch|位|类|组|年|月|天|小时|分钟|秒)$/.test(token)) {
    return true;
  }
  return false;
}

/** 超参数 / 阈值赋值（name=value / name≥value；prose 上，数学环境内由公式段覆盖） */
const ASSIGNMENT_PATTERN = /([A-Za-zλγαβτμ][A-Za-z\d_]{0,9})\s*[=＝≥≤]\s*(\d+(?:\.\d+)?)/g;
/** 量纲后缀（71维 / 64路 / 8头 等；NUMBER_PATTERN 单位表之外的量纲词） */
const DIMENSION_PATTERN = /(?<![\w.])(\d+(?:\.\d+)?)\s*(维|路|通道|头|层)/g;

// ---- 句子级方向提取 ----

interface ClaimSentence {
  text: string;
  index: number;
  metric: string | null;
  ownMethod: boolean;
  direction: string | null; // 高于/低于/优于/劣于/升至/降至…
  polarity: "advantage" | "disadvantage" | "parity" | null;
}

function claimSentences(content: string): ClaimSentence[] {
  const text = normalizeContent(content);
  const sentences: ClaimSentence[] = [];
  let start = 0;
  const push = (end: number): void => {
    const raw = text.slice(start, end);
    if (raw.trim() !== "") {
      const metricMatch = METRIC_PATTERN.exec(raw);
      const directionMatch = [...raw.matchAll(/高于|低于|优于|劣于|超过|不及|提升|下降|增加|减少|升至|降至/g)].at(-1);
      const polarity: ClaimSentence["polarity"] = ADVANTAGE_WORDS.test(raw)
        ? "advantage"
        : DISADVANTAGE_WORDS.test(raw)
          ? "disadvantage"
          : PARITY_WORDS.test(raw)
            ? "parity"
            : null;
      if (metricMatch !== null || polarity !== null || directionMatch !== undefined) {
        sentences.push({
          text: raw.trim(),
          index: start,
          metric: metricMatch !== null ? metricMatch[0] : null,
          ownMethod: /(本文|本方法|该方法|本研究所?提)/.test(raw),
          direction: directionMatch !== undefined ? directionMatch[0] : null,
          polarity,
        });
      }
    }
    start = end + 1;
  };
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === "。" || ch === "！" || ch === "？" || ch === ";" || ch === "\n") {
      push(index);
    }
  }
  push(text.length);
  return sentences;
}

// ---- 主判定（纯函数） ----

const MAX_FINDINGS_PER_BUCKET = 30;

function cap(items: FactFinding[]): FactFinding[] {
  return items.slice(0, MAX_FINDINGS_PER_BUCKET);
}

export function evaluateFactPreservation(input: FactPreservationInput): FactPreservationSummary {
  const auth = buildAuthorization(input.plan, input.improvementPlanItems, input.evidenceTexts ?? []);
  const changedFacts: FactFinding[] = [];
  const removedFacts: FactFinding[] = [];
  const addedUnsupportedFacts: FactFinding[] = [];
  const directionalChanges: FactFinding[] = [];
  const formulaChanges: FactFinding[] = [];
  const placeholderRegressions: FactFinding[] = [];
  let allowedChanges = 0;
  let allowedRemovals = 0;

  const currentFiles = new Map(input.current.files.map((file) => [file.file, normalizeContent(file.content)]));

  for (const previousFile of input.previous.files) {
    const previous = normalizeContent(previousFile.content);
    const current = currentFiles.get(previousFile.file);

    // -- 1. 表格：同表同行同列的数值变化 / 整表整行消失 / 新增行 --
    const previousTables = parseTables(previous);
    const currentTables = current !== undefined ? parseTables(current) : [];
    const currentTableByKey = new Map(currentTables.map((table) => [table.key, table]));
    previousTables.forEach((table, tableOrdinal) => {
      const matched = currentTableByKey.get(table.key) ?? currentTables[tableOrdinal];
      const where = table.label !== null ? `表 ${table.label}` : table.caption !== "" ? `「${table.caption}」` : `第 ${tableOrdinal + 1} 个表`;
      if (matched === undefined) {
        removedFacts.push({
          kind: "removed",
          file: previousFile.file,
          section: "(table)",
          before: snippet(`${where}（${table.rows.length} 行）`),
          after: "",
          reason: "table_removed",
        });
        return;
      }
      const rowMatches = matchRows(table.rows, matched.rows);
      table.rows.forEach((row, rowIndex) => {
        const currentRowIndex = rowMatches[rowIndex];
        if (currentRowIndex === undefined) {
          if (row.some((cell) => /\d/.test(cell))) {
            removedFacts.push({
              kind: "removed",
              file: previousFile.file,
              section: "(table)",
              before: snippet(`${where} 行「${row[0] ?? ""}」：${row.join(" | ")}`),
              after: "",
              reason: "table_row_removed",
            });
          }
          return;
        }
        const currentRow = matched.rows[currentRowIndex] ?? [];
        const cells = Math.max(row.length, currentRow.length);
        for (let cellIndex = 0; cellIndex < cells; cellIndex += 1) {
          const before = row[cellIndex] ?? "";
          const after = currentRow[cellIndex] ?? "";
          if (before === after) {
            continue;
          }
          const numericChange = /\d/.test(before) || /\d/.test(after);
          const placeholderNow = PLACEHOLDER_TEST.test(after);
          if (!numericChange && !placeholderNow) {
            continue; // 纯措辞单元格：不属事实
          }
          const location = `${where} 行「${row[0] ?? currentRow[0] ?? ""}」第 ${cellIndex + 1} 列`;
          const finding: FactFinding = {
            kind: placeholderNow ? "placeholder" : "changed",
            file: previousFile.file,
            section: "(table)",
            before: snippet(`${location}：${before}`),
            after: snippet(after),
            reason: placeholderNow ? "table_cell_placeholder" : "table_cell",
          };
          const grant =
            !placeholderNow && numericChange
              ? valueChangeAuthorized(auth, before.replace(/[^\d.%‰eE+\-−]/g, ""), after.replace(/[^\d.%‰eE+\-−]/g, ""))
              : null;
          if (grant !== null) {
            allowedChanges += 1;
          } else if (placeholderNow) {
            placeholderRegressions.push(finding);
          } else {
            changedFacts.push(finding);
          }
        }
      });
      matched.rows.forEach((row, index) => {
        if (rowMatches.includes(index)) {
          return; // 与 previous 某行配对过的行不算新增
        }
        if (row.some((cell) => /\d/.test(cell))) {
          const grant = row.some((cell) =>
            /\d/.test(cell) && valueAdditionAuthorized(auth, cell.replace(/[^\d.%‰eE+\-−]/g, "")) !== null,
          );
          const finding: FactFinding = {
            kind: "added_unsupported",
            file: previousFile.file,
            section: "(table)",
            before: "",
            after: snippet(`${where} 新增行：${row.join(" | ")}`),
            reason: "table_row_added",
          };
          if (grant) {
            allowedChanges += 1;
          } else {
            addedUnsupportedFacts.push(finding);
          }
        }
      });
    });
    currentTables.forEach((table, ordinal) => {
      const known =
        previousTables.some((candidate) => candidate.key === table.key) || previousTables[ordinal] !== undefined;
      if (!known && table.rows.some((row) => row.some((cell) => /\d/.test(cell)))) {
        addedUnsupportedFacts.push({
          kind: "added_unsupported",
          file: previousFile.file,
          section: "(table)",
          before: "",
          after: snippet(`新增表（${table.label ?? table.caption}，${table.rows.length} 行）`),
          reason: "table_added",
        });
      }
    });

    if (current === undefined) {
      // 文件整体消失：prose 数字与公式全部记为删除
      for (const token of proseNumberTokens(previous)) {
        removedFacts.push({
          kind: "removed",
          file: previousFile.file,
          section: "(file removed)",
          before: snippet(token),
          after: "",
          reason: "file_removed",
        });
      }
      continue;
    }

    // -- 2. prose 数字：缺失（值语义）→ 删除 / 值变更；新增（事实型）→ 无依据新增 --
    const previousNumbers = proseNumberTokens(previous);
    const currentNumbers = proseNumberTokens(current);
    const numberDiff = multisetDiff(previousNumbers, currentNumbers);
    const placeholderIncreased = countPlaceholders(current) > countPlaceholders(previous);
    const missingNumericTotal = numberDiff.missing.length;
    const paired = Math.min(numberDiff.missing.length, numberDiff.added.length);
    for (let index = 0; index < numberDiff.missing.length && removedFacts.length + changedFacts.length < 400; index += 1) {
      const token = numberDiff.missing[index] ?? "";
      const at = indexOfToken(previous, token);
      const section = at >= 0 ? nearestSection(previous, at) : "(global)";
      const beforeSnippet = at >= 0 ? snippet(lineOf(previous, at)) : snippet(token);
      if (index < paired) {
        const replacement = numberDiff.added[index] ?? "";
        const grant = valueChangeAuthorized(auth, token, replacement);
        if (grant !== null) {
          allowedChanges += 1;
          continue;
        }
        changedFacts.push({
          kind: "changed",
          file: previousFile.file,
          section,
          before: beforeSnippet,
          after: snippet(`${replacement}（原 ${token}）`),
          reason: "prose_number",
        });
      } else {
        const grant = valueRemovalAuthorized(auth, token, previousFile.file);
        if (grant !== null) {
          allowedRemovals += 1;
          continue;
        }
        if (placeholderIncreased) {
          placeholderRegressions.push({
            kind: "placeholder",
            file: previousFile.file,
            section,
            before: beforeSnippet,
            after: snippet(`${token} → 占位表述`),
            reason: "placeholder_replacement",
          });
          continue;
        }
        removedFacts.push({
          kind: "removed",
          file: previousFile.file,
          section,
          before: beforeSnippet,
          after: "",
          reason: "prose_number",
        });
      }
    }
    const unpairedAdditions = numberDiff.added.slice(paired);
    for (const token of unpairedAdditions) {
      if (!isFactLikeAddition(token)) {
        continue;
      }
      const grant = valueAdditionAuthorized(auth, token);
      const at = indexOfToken(current, token);
      if (grant !== null) {
        allowedChanges += 1;
        continue;
      }
      addedUnsupportedFacts.push({
        kind: "added_unsupported",
        file: previousFile.file,
        section: at >= 0 ? nearestSection(current, at) : "(global)",
        before: "",
        after: snippet(at >= 0 ? lineOf(current, at) : token),
        reason: "added_number",
      });
    }
    // -- 2b. 超参数 / 阈值赋值新增（r=16、Lclip≥3 类；仅 previous 已存在的文件参与，
    //    写作阶段的新章节文件不在本循环内——新增审查只针对既有稿） --
    const previousProseCompact = stripTablesAndMath(previous).replace(/\s+/g, "");
    const currentProse = stripTablesAndMath(current);
    for (const match of currentProse.matchAll(ASSIGNMENT_PATTERN)) {
      const whole = (match[0] ?? "").replace(/\s+/g, "");
      const value = match[2] ?? "";
      if (whole === "" || previousProseCompact.includes(whole)) {
        continue;
      }
      const grant = valueAdditionAuthorized(auth, value);
      if (grant !== null) {
        allowedChanges += 1;
        continue;
      }
      addedUnsupportedFacts.push({
        kind: "added_unsupported",
        file: previousFile.file,
        section: nearestSection(currentProse, match.index ?? 0),
        before: "",
        after: snippet(whole),
        reason: "hyperparameter_assignment",
      });
    }
    // -- 2c. 量纲后缀新增（71维 / 64路：数字 token 本体不带这些量纲，单独扫描） --
    for (const match of currentProse.matchAll(DIMENSION_PATTERN)) {
      const whole = (match[0] ?? "").replace(/\s+/g, "");
      if (whole === "" || previousProseCompact.includes(whole)) {
        continue;
      }
      const grant = valueAdditionAuthorized(auth, match[1] ?? "");
      if (grant !== null) {
        allowedChanges += 1;
        continue;
      }
      addedUnsupportedFacts.push({
        kind: "added_unsupported",
        file: previousFile.file,
        section: nearestSection(currentProse, match.index ?? 0),
        before: "",
        after: snippet(whole),
        reason: "added_number",
      });
    }
    if (placeholderIncreased && missingNumericTotal === 0) {
      const hadFacts = previousNumbers.length > 0 || previousTables.length > 0;
      if (hadFacts) {
        placeholderRegressions.push({
          kind: "placeholder",
          file: previousFile.file,
          section: "(global)",
          before: snippet("（该章节原有具体实验事实）"),
          after: snippet([...current.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[0]).slice(0, 3).join("/")),
          reason: "placeholder_regression",
        });
      }
    }

    // -- 3. 公式：数学片段多重集（归一化空白）；缺失 → formulaChanges；
    //    新增 → added_unsupported（新公式 = 新增方法事实；仅既有文件参与） --
    const previousMath = extractMathSegments(previous);
    const currentMath = extractMathSegments(current);
    const mathDiff = multisetDiff(previousMath, currentMath);
    for (const segment of mathDiff.missing) {
      const grant = formulaChangeAuthorized(auth);
      if (grant !== null) {
        allowedChanges += 1;
        continue;
      }
      const at = previous.indexOf(segment.split(" ")[0] ?? "");
      formulaChanges.push({
        kind: "formula",
        file: previousFile.file,
        section: at >= 0 ? nearestSection(previous, at) : "(global)",
        before: snippet(segment, 70),
        after: "",
        reason: "formula_removed_or_changed",
      });
    }
    for (const segment of mathDiff.added) {
      const grant = formulaChangeAuthorized(auth);
      if (grant !== null) {
        allowedChanges += 1;
        continue;
      }
      addedUnsupportedFacts.push({
        kind: "added_unsupported",
        file: previousFile.file,
        section: "(formula)",
        before: "",
        after: snippet(segment, 70),
        reason: "formula_added",
      });
    }

    // -- 4. 方向性结论：负结果 / 持平 → 优势；同指标比较方向对调 --
    const previousClaims = claimSentences(previous);
    const currentClaims = claimSentences(current);
    const previousNegative = previousClaims.filter((claim) => claim.polarity === "disadvantage");
    const previousParity = previousClaims.filter((claim) => claim.polarity === "parity");
    const currentAdvantage = currentClaims.filter((claim) => claim.polarity === "advantage");
    const currentHasNegative = currentClaims.some((claim) => claim.polarity === "disadvantage");
    const currentHasParity = currentClaims.some((claim) => claim.polarity === "parity");
    const grantDirection = () => directionChangeAuthorized(auth, previousFile.file);
    const directional = (finding: Omit<FactFinding, "kind">): void => {
      const grant = grantDirection();
      if (grant !== null) {
        allowedChanges += 1;
        return;
      }
      directionalChanges.push({ kind: "directional", ...finding });
    };
    // 4a. 负结果消失且出现优势结论（§9 hard protection）
    if (
      previousNegative.length > 0 &&
      !currentHasNegative &&
      currentAdvantage.length > 0 &&
      previousNegative.some((claim) => claim.ownMethod || claim.metric !== null)
    ) {
      directional({
        file: previousFile.file,
        section: nearestSection(previous, previousNegative[0]?.index ?? 0),
        before: snippet(previousNegative[0]?.text ?? ""),
        after: snippet(currentAdvantage[0]?.text ?? ""),
        reason: "negative_to_advantage",
      });
    }
    // 4b. 持平结论消失且出现优势结论
    if (previousParity.length > 0 && !currentHasParity && currentAdvantage.length > 0) {
      directional({
        file: previousFile.file,
        section: nearestSection(previous, previousParity[0]?.index ?? 0),
        before: snippet(previousParity[0]?.text ?? ""),
        after: snippet(currentAdvantage[0]?.text ?? ""),
        reason: "parity_to_advantage",
      });
    }
    // 4c. 同指标比较方向对调（metric + direction 词都出现且方向词极性相反）
    for (const previousClaim of previousClaims) {
      if (previousClaim.metric === null || previousClaim.direction === null) {
        continue;
      }
      const previousPositive = POSITIVE_DIRECTION.has(previousClaim.direction);
      const flip = currentClaims.find(
        (claim) =>
          claim.metric === previousClaim.metric &&
          claim.direction !== null &&
          POSITIVE_DIRECTION.has(claim.direction) !== previousPositive &&
          claim.direction !== previousClaim.direction,
      );
      if (flip !== undefined) {
        directional({
          file: previousFile.file,
          section: nearestSection(previous, previousClaim.index),
          before: snippet(previousClaim.text),
          after: snippet(flip.text),
          reason: "metric_direction_flip",
        });
      }
    }

    // -- 5. 协议哨兵：数据集划分 / 硬件 --
    const previousOfficial = OFFICIAL_SPLIT_PATTERN.test(previous);
    const currentCustom = CUSTOM_SPLIT_PATTERN.test(current);
    const previousCustom = CUSTOM_SPLIT_PATTERN.test(previous);
    const currentOfficial = OFFICIAL_SPLIT_PATTERN.test(current);
    if ((previousOfficial && currentCustom && !previousCustom) || (previousCustom && currentOfficial && !previousOfficial)) {
      const grant = directionChangeAuthorized(auth, previousFile.file);
      if (grant === null) {
        changedFacts.push({
          kind: "changed",
          file: previousFile.file,
          section: "(protocol)",
          before: snippet(previousOfficial ? "official/官方数据划分" : "custom/自定义数据划分"),
          after: snippet(currentCustom ? "custom/自定义数据划分" : "official/官方数据划分"),
          reason: "dataset_split_changed",
        });
      } else {
        allowedChanges += 1;
      }
    }
    const previousHardware = new Set([...previous.matchAll(HARDWARE_PATTERN)].map((match) => (match[0] ?? "").replace(/\s+/g, " ")));
    const currentHardware = new Set([...current.matchAll(HARDWARE_PATTERN)].map((match) => (match[0] ?? "").replace(/\s+/g, " ")));
    for (const hardware of previousHardware) {
      if (![...currentHardware].some((candidate) => candidate.replace(/\s/g, "") === hardware.replace(/\s/g, ""))) {
        const grant = valueRemovalAuthorized(auth, hardware, previousFile.file);
        if (grant === null) {
          removedFacts.push({
            kind: "removed",
            file: previousFile.file,
            section: "(protocol)",
            before: snippet(hardware),
            after: "",
            reason: "hardware_removed",
          });
        } else {
          allowedRemovals += 1;
        }
      }
    }
    for (const hardware of currentHardware) {
      if (![...previousHardware].some((candidate) => candidate.replace(/\s/g, "") === hardware.replace(/\s/g, ""))) {
        const grant = valueAdditionAuthorized(auth, hardware);
        if (grant === null) {
          addedUnsupportedFacts.push({
            kind: "added_unsupported",
            file: previousFile.file,
            section: "(protocol)",
            before: "",
            after: snippet(hardware),
            reason: "hardware_added",
          });
        } else {
          allowedChanges += 1;
        }
      }
    }
  }

  const summary: FactPreservationSummary = {
    previousRevision: input.previous.revision,
    currentRevision: input.current.revision,
    changedFacts: cap(changedFacts),
    removedFacts: cap(removedFacts),
    addedUnsupportedFacts: cap(addedUnsupportedFacts),
    directionalChanges: cap(directionalChanges),
    formulaChanges: cap(formulaChanges),
    placeholderRegressions: cap(placeholderRegressions),
    allowedChanges,
    allowedRemovals,
    planId: input.plan?.planId ?? null,
    ok:
      changedFacts.length === 0 &&
      removedFacts.length === 0 &&
      addedUnsupportedFacts.length === 0 &&
      directionalChanges.length === 0 &&
      formulaChanges.length === 0 &&
      placeholderRegressions.length === 0,
  };
  return summary;
}

/**
 * 行匹配键：数值列出现前的标签单元格串联（「低照度|纯IoU基线」这类前缀重复的表，
 * 只用首列会串行）；首列即数值的表退化为首单元格；全空退化为行号。
 */
function rowKey(row: readonly string[], index: number): string {
  const labelCells: string[] = [];
  for (const cell of row) {
    if (/\d/.test(cell)) {
      break;
    }
    if (cell !== "") {
      labelCells.push(cell);
    }
  }
  const label = labelCells.join("|");
  if (label !== "") {
    return `label:${label}`;
  }
  const first = row.find((cell) => cell !== "") ?? "";
  return first !== "" ? `first:${first}` : `index:${index}`;
}

/**
 * previous 行 → current 行 的配对（undefined = 该行消失）。
 * 1) 键精确匹配；2) 前缀兼容兜底：值列被「待回填」等占位替换后，占位单元格会
 * 混入标签前缀（高密度|本文方法 → 高密度|本文方法|待回填），此时要求列数相同、
 * 标签互为「|」边界前缀，按行序优先配对。
 */
function matchRows(previousRows: readonly string[][], currentRows: readonly string[][]): (number | undefined)[] {
  const used = new Set<number>();
  const tryClaim = (predicate: (row: string[], index: number) => boolean): number | undefined => {
    const index = currentRows.findIndex((row, candidateIndex) => !used.has(candidateIndex) && predicate(row, candidateIndex));
    if (index >= 0) {
      used.add(index);
      return index;
    }
    return undefined;
  };
  return previousRows.map((row, rowIndex) => {
    const key = rowKey(row, rowIndex);
    const exact = tryClaim((candidate, candidateIndex) => rowKey(candidate, candidateIndex) === key);
    if (exact !== undefined) {
      return exact;
    }
    if (!key.startsWith("label:")) {
      return undefined;
    }
    const label = key.slice("label:".length);
    return tryClaim(
      (candidate, candidateIndex) =>
        candidate.length === row.length &&
        (() => {
          const candidateKey = rowKey(candidate, candidateIndex);
          if (!candidateKey.startsWith("label:")) {
            return false;
          }
          const candidateLabel = candidateKey.slice("label:".length);
          return label.startsWith(`${candidateLabel}|`) || candidateLabel.startsWith(`${label}|`);
        })(),
    );
  });
}

/** Gate 规则 detail（有界；样本最多 3 条 / 类别） */
export function describeFactPreservation(summary: FactPreservationSummary): string {
  const base = `rev-${summary.previousRevision}→rev-${summary.currentRevision}`;
  if (summary.ok) {
    return `${base} 实验事实保持通过（授权变更 ${summary.allowedChanges} 项 / 授权删除 ${summary.allowedRemovals} 项）`;
  }
  const parts: string[] = [];
  const sample = (findings: FactFinding[], label: string): string => {
    if (findings.length === 0) {
      return "";
    }
    const first = findings[0] as FactFinding;
    const detail = `${first.before} → ${first.after}`.trim();
    return `${label} ${findings.length} 项（如 ${detail.slice(0, 80)}）`;
  };
  parts.push(sample(summary.changedFacts, "事实被改"));
  parts.push(sample(summary.removedFacts, "事实被删"));
  parts.push(sample(summary.addedUnsupportedFacts, "无依据新增"));
  parts.push(sample(summary.directionalChanges, "结论方向反转"));
  parts.push(sample(summary.formulaChanges, "公式变化"));
  parts.push(sample(summary.placeholderRegressions, "事实被占位替换"));
  return `${base} 实验事实保持失败：${parts.filter((part) => part !== "").join("；")}——未经 RevisionPlan/Evidence 授权`;
}

// ---- 工作流 / HTTP 共用的加载器（与 computeCitationPreservation 同构） ----

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ManuscriptRevisionStore } from "../manuscript/RevisionStore.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { ReviewArtifactStore } from "../review/reviewArtifacts.js";
import type { EvidenceStore } from "../evidence/EvidenceStore.js";
import { readSnapshotTex } from "./citationPreservation.js";

export interface FactPreservationDeps {
  projects: ProjectStore;
  revisions: ManuscriptRevisionStore;
  reviewArtifacts: ReviewArtifactStore;
  evidence: EvidenceStore;
}

/**
 * 计算被审阅修订相对其前一修订的实验事实保持结果。
 * 返回 null = 不可比较（无前序修订 / 快照缺失 / reason=revision.restore），规则中性不参与。
 */
export async function computeFactPreservation(
  deps: FactPreservationDeps,
  projectId: string,
  reviewedRevision: number | undefined,
): Promise<FactPreservationSummary | null> {
  const state = await deps.revisions.load(projectId);
  const current = typeof reviewedRevision === "number" && reviewedRevision > 0 ? reviewedRevision : state.current;
  if (current <= 0) {
    return null;
  }
  const ordered = [...state.revisions].sort((a, b) => a.revision - b.revision);
  const index = ordered.findIndex((record) => record.revision === current);
  if (index <= 0) {
    return null; // 无前序修订
  }
  const currentRecord = ordered[index]!;
  const previousRecord = ordered[index - 1]!;
  if (currentRecord.reason === "revision.restore") {
    return null; // 用户显式恢复历史修订：不是 Writer 改稿，不做保持比较
  }
  const [previousFiles, currentFiles] = await Promise.all([
    readSnapshotTex(deps.revisions.snapshotDir(projectId, previousRecord.revision)),
    readSnapshotTex(deps.revisions.snapshotDir(projectId, currentRecord.revision)),
  ]);
  if (previousFiles === null || currentFiles === null || previousFiles.length === 0) {
    return null; // 快照缺失（旧项目）：如实不可比较
  }
  // 承认修改依据的计划：sourceRevision == previous 的 quality 修订计划（最新轮优先）
  let plan: import("../review/revisionPlan.js").RevisionPlan | null = null;
  for (const round of await deps.reviewArtifacts.planRounds(projectId)) {
    const candidate = await deps.reviewArtifacts.loadPlan(projectId, round);
    if (
      candidate !== null &&
      candidate.sourceRevision === previousRecord.revision &&
      candidate.revisionReason !== "style_polish"
    ) {
      plan = candidate;
      break;
    }
  }
  const improvementPlanItems = await readImprovementPlanItems(deps.projects, projectId);
  const evidenceTexts = (await deps.evidence.list(projectId)).flatMap((record) => [
    record.claim,
    record.summary ?? "",
    record.quote ?? "",
  ]);
  return evaluateFactPreservation({
    previous: { revision: previousRecord.revision, files: previousFiles },
    current: { revision: currentRecord.revision, files: currentFiles },
    plan,
    ...(improvementPlanItems.length > 0 ? { improvementPlanItems } : {}),
    evidenceTexts,
  });
}

async function readImprovementPlanItems(
  projects: ProjectStore,
  projectId: string,
): Promise<{ section: string; action: string; rationale?: string }[]> {
  try {
    const parsed = JSON.parse(
      await readFile(join(projects.researchDir(projectId), "improvement-plan.json"), "utf8"),
    ) as { plan?: { items?: { section?: unknown; action?: unknown; rationale?: unknown }[] } };
    return (parsed.plan?.items ?? [])
      .filter((item) => typeof item.section === "string" && typeof item.action === "string")
      .map((item) => ({
        section: item.section as string,
        action: item.action as string,
        ...(typeof item.rationale === "string" ? { rationale: item.rationale as string } : {}),
      }));
  } catch {
    return [];
  }
}
