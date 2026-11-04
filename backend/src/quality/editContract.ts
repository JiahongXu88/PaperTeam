/**
 * EditContract（M15.20 P0 授权内核）：「是否有权改」的确定性判定。
 *
 * 背景（M15.19 E1 真实运行实证）：审计条目的结构化禁改项（forbidden.values）在批准时被丢弃；
 * Planner 计划文本点名「旧值 → 新值」并自述「作者已批准」，plan_confirm 后进入授权台账，
 * factPreservation 以「已批准文本同时出现新旧值」放行；摘要载体不经候选守卫直接落盘——
 * 结果是越权改数字 + 越界删句仍被复评判 VALIDATED_FIXED。
 *
 * 不变量（本模块负责证明的部分）：
 *   1. 授权只来自结构化、有来源的契约（系统策略 / 冻结协议 / 真实用户批准事件）；模型生成的
 *      计划文本、理由、自称的「已批准」永远不是授权来源——本模块不读取任何自然语言授权。
 *   2. 契约可写范围外的文本逐字（空白归一）保留；锚区间内的改写只能满足全部约束。
 *   3. 受保护数值（数字 / 小数 / 百分数 / 负号 / 科学计数）按出现顺序守恒；含数字的标识符（MOT17 等）
 *      只做 token 化展示，不受数值约束（具名实体增删由既有具名实体守卫负责）；
 *      只有用户批准的结构化值对可替换 / 删除，且硬冻结（审计禁改）存在时任何批准都不生效。
 *   4. 多份契约叠加只能收窄：锚范围契约存在时整目标契约不扩大范围；约束取最严。
 *
 * 职责边界：本模块只回答「是否被授权」。改后事实 / 引用是否安全仍由既有 Fact / Citation /
 * Evidence / Scope 守卫负责——两者都通过才可落盘；任何一方 PASS 都不蕴含另一方 PASS。
 *
 * 归一化边界（如实声明，不做语义等价猜测）：空白折叠；NFKC（全角数字 / 连字）；`\%`≡`%`；
 * Unicode 负号 / 减号≡`-`（仅紧贴数字且前方非字母数字时）；`a\times10^{b}`≡`aeb`；千分位逗号剥离。
 * 小数末尾 0 视为格式（0.25 ≡ 0.250，与既有事实守卫 normalizeNumericToken 同口径）；不识别「同值同序但换了指标名」以外的语义位移。
 */

import { createHash } from "node:crypto";

import { extractCitationKeys } from "../citation/StaticCitationChecker.js";

export const EDIT_CONTRACT_SCHEMA_VERSION = "edit-contract/v1" as const;
export const EDIT_CONTRACT_VERDICT_SCHEMA_VERSION = "edit-contract-verdict/v1" as const;

export type EditContractSourceKind =
  /** 目标期刊审计条目经作者在审计计划中批准（POST decide） */
  | "target_audit_rewrite"
  /** 改进计划 modify 条目经 hitl.plan_confirm 批准 */
  | "improvement_plan_item"
  /** 系统策略：任何修订写入的底线约束（冻结基线数值不可被未授权改动） */
  | "system_revision_policy"
  | "style_polish_policy"
  | "latex_repair_policy"
  | "fact_restore_policy"
  /** M17.1：默认风格审查的锚定措辞修订（系统策略；锚内替换 / 删除，数值与引用硬冻结） */
  | "academic_style_rewrite";

export type EditAuthorityKind =
  /** 确定性系统策略（代码常量，版本化） */
  | "system_policy"
  /** 冻结协议 / 审计禁改项（不可被下游批准覆盖） */
  | "frozen_protocol"
  /** 真实用户批准事件（HTTP 决策通道，绑定所见内容哈希） */
  | "user_approval"
  /** 测试夹具中显式标注的合成批准主体（仅用于验证机制，不代表真实作者） */
  | "synthetic_test_actor";

export interface EditAuthority {
  kind: EditAuthorityKind;
  /** 策略 id / 批准事件 id */
  ref: string;
  actor?: string;
  channel?: string;
  at?: string;
  /** 批准时向用户展示内容的哈希（审批绑定；内容变化即失效） */
  boundContentHash?: string;
}

export type EditOperation = "replace_wording" | "qualify" | "weaken" | "insert_text" | "delete_text" | "restructure";

export const ALL_TEXT_OPERATIONS: readonly EditOperation[] = ["replace_wording", "qualify", "weaken", "insert_text", "delete_text", "restructure"];

export interface EditScopeAnchor {
  /** 基线中可逐字（空白归一）唯一回放的原文 */
  text: string;
  textHash: string;
}

export interface ApprovedValueChange {
  /** 原值（原文 token 形态） */
  before: string;
  /** 新值；空串 = 批准删除该值 */
  after: string;
  /** 产生该批准的用户事件 id */
  approvalId: string;
  basis?: string;
}

export interface EditContractConflict {
  kind:
    | "advice_conflicts_with_numeric_freeze"
    | "plan_text_value_change_unstructured"
    | "approval_conflicts_with_hard_freeze"
    | "plan_item_exceeds_audit_scope";
  detail: string;
  /** constraint_wins：更高优先级约束生效、契约不扩大；rejected：请求被拒绝 */
  resolution: "constraint_wins" | "rejected";
}

export interface EditContractConstraints {
  /** all_existing：基线中全部数值受保护；listed：仅 protectedValues 中的值（多重集）受保护 */
  numericProtect: "all_existing" | "listed";
  protectedValues: string[];
  /** 是否允许出现基线中没有的数值 */
  allowNewValues: boolean;
  /** 硬冻结：存在时任何批准的值对都不生效（审计「不得改变既有数字」） */
  hardNumericFreeze: boolean;
  citationPolicy: "preserve_existing" | "preserve_existing_no_new" | "unrestricted";
  protectedCitationKeys: string[];
  /** 无法结构化强制的自然语言限制（存在即不可执行——fail closed，不假装已执行） */
  unenforceable: string[];
}

export interface EditContract {
  schemaVersion: typeof EDIT_CONTRACT_SCHEMA_VERSION;
  contractId: string;
  projectId: string;
  runId?: string;
  source: {
    kind: EditContractSourceKind;
    ref: string;
    instructionId?: string;
    planItemId?: string;
    planId?: string;
    /** 契约生成时的计划内容哈希（计划变化 → 契约陈旧） */
    planHash?: string;
  };
  authority: EditAuthority[];
  target: {
    carrier: "abstract" | "file";
    /** manuscript 相对路径；摘要载体为 "abstract" */
    file: string;
    baseRevision?: number;
    /** 批准时目标内容哈希（sha256 原文） */
    baseHash: string;
  };
  scope: { mode: "anchors" | "whole_target"; anchors: EditScopeAnchor[]; allowedOps: EditOperation[] };
  constraints: EditContractConstraints;
  allowedValueChanges: ApprovedValueChange[];
  conflicts: EditContractConflict[];
  status: "executable" | "unenforceable" | "conflict" | "superseded";
  createdAt: string;
  /** 契约内容哈希（除 status / contentHash 外的规范 JSON） */
  contentHash: string;
}

export type EditContractViolationCode =
  | "EDIT_CONTRACT_MISSING"
  | "EDIT_CONTRACT_NOT_EXECUTABLE"
  | "EDIT_CONTRACT_UNENFORCEABLE_CONSTRAINT"
  | "EDIT_CONTRACT_STALE"
  | "EDIT_CONTRACT_TARGET_MISMATCH"
  | "EDIT_CONTRACT_SCOPE_UNRESOLVED"
  | "EDIT_CONTRACT_OUT_OF_SCOPE"
  | "EDIT_CONTRACT_DELETION_NOT_ALLOWED"
  | "EDIT_CONTRACT_PROTECTED_VALUE_CHANGED"
  | "EDIT_CONTRACT_PROTECTED_VALUE_REMOVED"
  | "EDIT_CONTRACT_VALUE_ORDER_CHANGED"
  | "EDIT_CONTRACT_VALUE_REBOUND"
  | "EDIT_CONTRACT_NEW_VALUE"
  | "EDIT_CONTRACT_CITATION_REMOVED"
  | "EDIT_CONTRACT_CITATION_ADDED";

export interface EditContractViolation {
  code: EditContractViolationCode;
  detail: string;
  contractId?: string;
  value?: string;
  /** 越界改动的基线句子（截断） */
  sentence?: string;
}

export interface EditContractVerdict {
  schemaVersion: typeof EDIT_CONTRACT_VERDICT_SCHEMA_VERSION;
  ok: boolean;
  contractIds: string[];
  target: string;
  baselineHash: string;
  candidateHash: string;
  violations: EditContractViolation[];
  effective: {
    scope: "anchors" | "whole_target";
    anchors: number;
    hardNumericFreeze: boolean;
    approvedValueChanges: number;
    allowNewValues: boolean;
  };
}

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

// ---------------------------------------------------------------------------
// 数值 token 化
// ---------------------------------------------------------------------------

export interface ValueToken {
  /** 原文片段（展示用） */
  raw: string;
  /** 规范值（比较用） */
  norm: string;
  kind: "number" | "identifier";
}

/** 结构性 LaTeX 参数（label / ref / cite / 尺寸 / 文件名）中的数字不是事实值 */
const STRUCTURAL_COMMAND_ARG =
  /\\(?:cite[a-zA-Z]*|citep|citet|ref|eqref|autoref|cref|Cref|pageref|label|url|href|includegraphics|input|include|bibliography|bibliographystyle|vspace|hspace|setlength|addtolength|resizebox|scalebox|rule|hypersetup|usepackage|documentclass|begin|end)\*?(?:\[[^\]]*\])*(?:\{[^{}]*\})+/g;
// M15 长程：长度字面量必须紧贴单位（2cm / 0.5in）。旧写法允许空白，导致「11.549 in IDF1」「3 ex」这类正文数字被当作
// 长度剥离、不受数值保护（受保护值静默漏检）
const LENGTH_LITERAL = /(?<![\w.])\d+(?:\.\d+)?(?:pt|mm|cm|em|ex|bp|in)\b/g;

function stripStructural(text: string): string {
  return text.replace(STRUCTURAL_COMMAND_ARG, " ").replace(LENGTH_LITERAL, " ");
}

/**
 * 正文 → 有序数值 token 序列。含数字的标识符（IDF1 / YOLOv8 / MOT17）整体作为一个 token
 * （改名即改事实）；纯数字按规范值比较（负号 / 科学计数 / 百分号 / 千分位归一）。
 */
export function extractValueTokens(text: string): ValueToken[] {
  let source = stripStructural(text.normalize("NFKC"))
    .replace(/\\%/g, "%")
    .replace(/\\(?:,|;|!|thinspace)/g, "")
    .replace(/\{,\}/g, ".");
  // a \times 10^{b} → aEb（科学计数的 LaTeX 写法）
  source = source.replace(/(\d+(?:\.\d+)?)\s*(?:\\times|×|x)\s*10\s*\^\s*\{?\s*([-−–+]?\d+)\s*\}?/g, (_m, mantissa: string, exp: string) => `${mantissa}e${exp.replace(/[−–]/g, "-")}`);
  source = source.replace(/(?<![\w.])10\s*\^\s*\{?\s*([-−–+]?\d+)\s*\}?/g, (_m, exp: string) => `1e${exp.replace(/[−–]/g, "-")}`);
  const tokens: ValueToken[] = [];
  const pattern =
    /(?<![\w.])([A-Za-z][A-Za-z]*\d[A-Za-z\d]*(?:[-_.]\d+[A-Za-z\d]*)*)|(?<![A-Za-z\d.])((?:[-−‐-‒–](?=\d))?)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(e[-+]?\d+)?(\s*(?:%|‰|°))?([A-Za-z]+)?/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1] !== undefined) {
      tokens.push({ raw: match[1], norm: match[1], kind: "identifier" });
      continue;
    }
    // 负号仅在前方为空白 / 行首 / 开括号 / 运算符时成立（20--80、RGB–2 中的连接号不是负号）
    const before = (match.index ?? 0) > 0 ? source[(match.index ?? 0) - 1]! : "";
    const sign = match[2] !== undefined && match[2] !== "" && (before === "" || /[\s$({\[=<>,;:]/.test(before)) ? "-" : "";
    const digits = (match[3] ?? "").replace(/,/g, "");
    const exponent = match[4] ?? "";
    const unit = (match[5] ?? "").trim();
    const trailingLetters = match[6];
    // 数字紧贴字母（2D / 3x / 10ms）：作为标识符整体保护
    if (trailingLetters !== undefined) {
      const raw = `${sign}${match[3]}${exponent}${match[5] ?? ""}${trailingLetters}`;
      tokens.push({ raw, norm: raw.replace(/\s+/g, ""), kind: "identifier" });
      continue;
    }
    // 负号仅在前方非字母数字时成立（RGB–2 中的连接号不是负号）——由 lookbehind 保证
    // 与 factPreservation.normalizeNumericToken 同一归一边界：小数末尾 0 是格式（0.25 ≡ 0.250）
    const canonical = digits.includes(".") ? digits.replace(/0+$/, "").replace(/\.$/, "") : digits;
    const norm = `${sign}${canonical}${exponent.toLowerCase()}${unit}`;
    tokens.push({ raw: match[0].trim().replace(/^[-−‐-‒–]/, sign), norm, kind: "number" });
  }
  return tokens;
}

/**
 * M15 长程 A3（R2）：数值 ↔ 指标标签的句内绑定。多重集守恒看不见「HOTA=5.402、IDF1=11.549」被换成
 * 「HOTA=11.549、IDF1=5.402」——值都还在，含义交换了。这里只做最小、保守的绑定：同一句内距离数字最近
 * （≤ 24 字符、中间无其它数字）的指标式标签（≥2 个大写字母，或字母后接数字：HOTA / IDF1 / mAP / AP50 / BLEU-4）；
 * 平局或无标签 → 不绑定（不判定）。不宣称理解所有科研语义：中文指标名、表格列头不在此处判定（表格由事实守卫负责）。
 */
export interface ValueBinding {
  label: string;
  norm: string;
  /** 所在句序号（交换判定只在同一句内成立） */
  sentence: number;
}

const METRIC_LABEL = /(?<![A-Za-z\d])(?:[A-Za-z]*[A-Z][A-Za-z]*[A-Z][A-Za-z\d]*|[A-Za-z]+\d+[A-Za-z\d]*)(?:-[A-Za-z\d]+)*(?![A-Za-z\d])/g;
const PROSE_NUMBER = /(?<![A-Za-z\d.])[-−]?\d+(?:\.\d+)?(?:\s*%)?(?![A-Za-z\d])/g;
const BINDING_MAX_GAP = 24;

export function extractValueBindings(text: string): ValueBinding[] {
  const bindings: ValueBinding[] = [];
  const sentences = collapseWhitespace(stripStructural(text.normalize("NFKC")).replace(/\\%/g, "%"))
    .split(/(?<=[.!?。！？；;])\s+|(?<=[。！？；])|\\\\|&/);
  for (const [sentenceIndex, sentence] of sentences.entries()) {
    const numbers = [...sentence.matchAll(PROSE_NUMBER)].map((match) => {
      const start = match.index ?? 0;
      // 连接号不是负号（BLEU-4 / RGB–2）：与 extractValueTokens 同一规则
      const raw = /^[-−]/.test(match[0]) && start > 0 && /[A-Za-z\d]/.test(sentence[start - 1]!) ? match[0].slice(1) : match[0];
      return { start, end: start + match[0].length, raw };
    });
    if (numbers.length === 0) continue;
    const labels = [...sentence.matchAll(METRIC_LABEL)].map((match) => ({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, text: match[0] }));
    for (const number of numbers) {
      let best: { label: string; distance: number } | null = null;
      let tie = false;
      for (const label of labels) {
        const before = label.end <= number.start;
        const gapStart = before ? label.end : number.end;
        const gapEnd = before ? number.start : label.start;
        if (!before && label.start < number.end) continue;
        const distance = gapEnd - gapStart;
        if (distance > BINDING_MAX_GAP) continue;
        if (numbers.some((other) => other !== number && other.start >= gapStart && other.end <= gapEnd)) continue;
        if (best === null || distance < best.distance) {
          best = { label: label.text, distance };
          tie = false;
        } else if (distance === best.distance && label.text !== best.label) {
          tie = true;
        }
      }
      if (best !== null && !tie) bindings.push({ label: best.label, norm: normValue(number.raw), sentence: sentenceIndex });
    }
  }
  return bindings;
}

// ---------------------------------------------------------------------------
// 空白归一与锚定位
// ---------------------------------------------------------------------------

interface CollapsedText {
  text: string;
  /** collapsed 下标 → 原文下标 */
  map: number[];
}

function collapseWithMap(content: string): CollapsedText {
  const normalized = content.normalize("NFKC");
  // NFKC 可能改变长度（连字），按码元逐个处理并保守映射到原串（长度差异只影响诊断位置）
  const out: string[] = [];
  const map: number[] = [];
  let inSpace = false;
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i]!;
    if (/\s/.test(ch)) {
      if (!inSpace && out.length > 0) {
        out.push(" ");
        map.push(Math.min(i, content.length));
      }
      inSpace = true;
      continue;
    }
    inSpace = false;
    out.push(ch);
    map.push(Math.min(i, content.length));
  }
  while (out.length > 0 && out[out.length - 1] === " ") {
    out.pop();
    map.pop();
  }
  return { text: out.join(""), map };
}

export function collapseWhitespace(content: string): string {
  return collapseWithMap(content).text;
}

/** 锚在基线 collapsed 文本中的唯一区间（找不到 / 多处 → null） */
function locateAnchorCollapsed(baseline: CollapsedText, anchor: string): { start: number; end: number } | null {
  const needle = collapseWhitespace(anchor);
  if (needle.length < 8) return null;
  const first = baseline.text.indexOf(needle);
  if (first < 0) return null;
  if (baseline.text.indexOf(needle, first + 1) >= 0) return null;
  return { start: first, end: first + needle.length };
}

export function anchorResolvesUniquely(baseline: string, anchor: string): boolean {
  return locateAnchorCollapsed(collapseWithMap(baseline), anchor) !== null;
}

/** 句子切分（中英文句末标点；用于越界诊断与删除检测，不参与授权判定本身） */
export function splitSentences(text: string): string[] {
  return collapseWhitespace(text)
    .split(/(?<=[.!?。！？；;])\s+|(?<=[。！？；])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 12);
}

// ---------------------------------------------------------------------------
// 契约构造（纯函数；调用方负责持久化与来源证明）
// ---------------------------------------------------------------------------

export function canonicalContractHash(contract: Omit<EditContract, "contentHash" | "status">): string {
  const { createdAt: _createdAt, ...rest } = contract as Omit<EditContract, "contentHash" | "status"> & { createdAt: string };
  return sha256(JSON.stringify(rest, Object.keys(flattenKeys(rest)).sort()));
}

function flattenKeys(value: unknown, acc: Record<string, true> = {}): Record<string, true> {
  if (Array.isArray(value)) {
    for (const entry of value) flattenKeys(entry, acc);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      acc[key] = true;
      flattenKeys(entry, acc);
    }
  }
  return acc;
}

export interface BuildEditContractInput {
  projectId: string;
  runId?: string;
  source: EditContract["source"];
  authority: EditAuthority[];
  target: { carrier: "abstract" | "file"; file: string; baseRevision?: number; baseContent: string };
  anchors?: readonly string[];
  allowedOps?: readonly EditOperation[];
  constraints?: Partial<EditContractConstraints>;
  allowedValueChanges?: readonly ApprovedValueChange[];
  conflicts?: readonly EditContractConflict[];
  now?: Date;
}

export function buildEditContract(input: BuildEditContractInput): EditContract {
  const anchors = [...new Set((input.anchors ?? []).map((anchor) => anchor.trim()).filter((anchor) => anchor !== ""))]
    .map((text) => ({ text, textHash: sha256(collapseWhitespace(text)) }));
  const constraints: EditContractConstraints = {
    numericProtect: input.constraints?.numericProtect ?? "all_existing",
    protectedValues: [...(input.constraints?.protectedValues ?? [])],
    allowNewValues: input.constraints?.allowNewValues ?? true,
    hardNumericFreeze: input.constraints?.hardNumericFreeze ?? false,
    citationPolicy: input.constraints?.citationPolicy ?? "preserve_existing",
    protectedCitationKeys: [...(input.constraints?.protectedCitationKeys ?? [])],
    unenforceable: [...(input.constraints?.unenforceable ?? [])],
  };
  const conflicts = [...(input.conflicts ?? [])];
  // 硬冻结下的值对批准不生效：如实登记冲突（约束优先），契约不扩大
  const allowedValueChanges = constraints.hardNumericFreeze ? [] : [...(input.allowedValueChanges ?? [])];
  if (constraints.hardNumericFreeze && (input.allowedValueChanges ?? []).length > 0) {
    conflicts.push({
      kind: "approval_conflicts_with_hard_freeze",
      detail: `${(input.allowedValueChanges ?? []).length} 项值变更批准与硬禁改约束冲突：禁改优先，批准不生效`,
      resolution: "constraint_wins",
    });
  }
  const body = {
    schemaVersion: EDIT_CONTRACT_SCHEMA_VERSION,
    contractId: "",
    projectId: input.projectId,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    source: input.source,
    authority: input.authority,
    target: {
      carrier: input.target.carrier,
      file: input.target.file,
      ...(input.target.baseRevision !== undefined ? { baseRevision: input.target.baseRevision } : {}),
      baseHash: sha256(input.target.baseContent),
    },
    scope: {
      mode: anchors.length > 0 ? ("anchors" as const) : ("whole_target" as const),
      anchors,
      allowedOps: [...(input.allowedOps ?? ALL_TEXT_OPERATIONS)],
    },
    constraints,
    allowedValueChanges,
    conflicts,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
  const contentHash = canonicalContractHash(body);
  const contractId = `ec-${contentHash.slice(0, 16)}`;
  const status: EditContract["status"] = constraints.unenforceable.length > 0 ? "unenforceable" : "executable";
  return { ...body, contractId, status, contentHash };
}

/**
 * 系统修订策略（任何修订写入的底线）：冻结基线中出现的数值不可被未经结构化批准的写入改动 /
 * 删除 / 换序；后续修订引入的值（非冻结基线值）可被修正或删除（由事实守卫判定安全性）；
 * 整目标范围（具体编辑区间由 span / 单元机制约束），引用以既有引用守卫为准。
 */
export function systemRevisionPolicyContract(input: {
  projectId: string;
  runId?: string;
  file: string;
  carrier: "abstract" | "file";
  baseContent: string;
  frozenContent: string | undefined;
  stageId: string;
  approvedValueChanges?: readonly ApprovedValueChange[];
  anchors?: readonly string[];
}): EditContract {
  const frozen = input.frozenContent ?? input.baseContent;
  return buildEditContract({
    projectId: input.projectId,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    source: { kind: "system_revision_policy", ref: `system-revision-policy/v1:${input.stageId}` },
    authority: [{ kind: "system_policy", ref: "system-revision-policy/v1" }],
    target: { carrier: input.carrier, file: input.file, baseContent: input.baseContent },
    ...(input.anchors !== undefined ? { anchors: input.anchors } : {}),
    constraints: {
      numericProtect: "listed",
      protectedValues: extractValueTokens(frozen).filter((token) => token.kind === "number").map((token) => token.norm),
      allowNewValues: true,
      hardNumericFreeze: false,
      citationPolicy: "unrestricted",
    },
    ...(input.approvedValueChanges !== undefined ? { allowedValueChanges: input.approvedValueChanges } : {}),
  });
}

/** 纯表述类系统写入（语言润色 / 编译修复）：全部数值与引用逐个守恒、不得新增 */
export function preservingPolicyContract(input: {
  projectId: string;
  runId?: string;
  file: string;
  carrier: "abstract" | "file";
  baseContent: string;
  kind: "style_polish_policy" | "latex_repair_policy";
}): EditContract {
  return buildEditContract({
    projectId: input.projectId,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    source: { kind: input.kind, ref: `${input.kind}/v1` },
    authority: [{ kind: "system_policy", ref: `${input.kind}/v1` }],
    target: { carrier: input.carrier, file: input.file, baseContent: input.baseContent },
    constraints: {
      numericProtect: "all_existing",
      allowNewValues: false,
      hardNumericFreeze: true,
      citationPolicy: "preserve_existing_no_new",
    },
  });
}

/**
 * M17.1 风格定点修订：只能改写 / 删除风格审查定位的原句（anchors，基线中唯一可回放），锚外逐字保留；
 * 全部数值与引用逐个守恒、不得新增。授权来源是代码常量策略（审查 → 机器分级 → 守卫），不是模型自述的「已批准」。
 */
export function academicStyleRewriteContract(input: {
  projectId: string;
  runId?: string;
  file: string;
  carrier: "abstract" | "file";
  baseContent: string;
  anchors: readonly string[];
}): EditContract {
  return buildEditContract({
    projectId: input.projectId,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    source: { kind: "academic_style_rewrite", ref: "academic-style-rewrite/v1" },
    authority: [{ kind: "system_policy", ref: "academic-style-rewrite/v1" }],
    target: { carrier: input.carrier, file: input.file, baseContent: input.baseContent },
    anchors: input.anchors,
    allowedOps: ["replace_wording", "delete_text"],
    constraints: {
      numericProtect: "all_existing",
      allowNewValues: false,
      hardNumericFreeze: true,
      citationPolicy: "preserve_existing_no_new",
    },
  });
}

/** 确定性事实恢复：只允许出现冻结基线中的值（恢复方向），不得新增其它值 */
export function factRestorePolicyContract(input: {
  projectId: string;
  runId?: string;
  file: string;
  baseContent: string;
  frozenContent: string;
}): EditContract {
  const frozenValues = extractValueTokens(input.frozenContent).filter((token) => token.kind === "number").map((token) => token.norm);
  return buildEditContract({
    projectId: input.projectId,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    source: { kind: "fact_restore_policy", ref: "fact-restore-policy/v1" },
    authority: [{ kind: "system_policy", ref: "fact-restore-policy/v1" }],
    target: { carrier: "file", file: input.file, baseContent: input.baseContent },
    constraints: {
      numericProtect: "listed",
      // 冻结基线值在当前稿中仍存在者受保护；恢复只可能加回冻结值
      protectedValues: frozenValues,
      allowNewValues: true,
      hardNumericFreeze: true,
      citationPolicy: "unrestricted",
    },
  });
}

/** 契约是否仍绑定当前目标内容（批准后正文变化 → 陈旧，需重新批准） */
export function isContractFresh(contract: EditContract, currentTargetContent: string): boolean {
  return contract.target.baseHash === sha256(currentTargetContent);
}

// ---------------------------------------------------------------------------
// 确定性 diff 校验
// ---------------------------------------------------------------------------

export interface ValidateCandidateEditInput {
  /** 目标（manuscript 相对路径或 "abstract"） */
  target: string;
  baseline: string;
  candidate: string;
  contracts: readonly EditContract[];
  /** 额外要求契约 baseHash 与 baseline 一致（候选回放 / 竞态防护） */
  enforceBaseHash?: boolean;
}

const truncate = (text: string, max = 160): string => (text.length > max ? `${text.slice(0, max)}…` : text);

function multisetCount(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function normValue(raw: string): string {
  if (raw.trim() === "") return "";
  const tokens = extractValueTokens(raw);
  return tokens.length === 1 ? tokens[0]!.norm : collapseWhitespace(raw);
}

export function validateCandidateEdit(input: ValidateCandidateEditInput): EditContractVerdict {
  const { baseline, candidate, contracts } = input;
  const violations: EditContractViolation[] = [];
  const baselineHash = sha256(baseline);
  const candidateHash = sha256(candidate);
  const effective = {
    scope: "whole_target" as "anchors" | "whole_target",
    anchors: 0,
    hardNumericFreeze: false,
    approvedValueChanges: 0,
    allowNewValues: true,
  };
  const finish = (): EditContractVerdict => ({
    schemaVersion: EDIT_CONTRACT_VERDICT_SCHEMA_VERSION,
    ok: violations.length === 0,
    contractIds: contracts.map((contract) => contract.contractId),
    target: input.target,
    baselineHash,
    candidateHash,
    violations,
    effective,
  });
  // 未改动的写入不构成越权（即使契约陈旧 / 目标不符——没有任何内容被写入）
  if (baseline === candidate) return finish();
  if (contracts.length === 0) {
    violations.push({ code: "EDIT_CONTRACT_MISSING", detail: "写入没有任何可执行的编辑契约（fail closed）" });
    return finish();
  }
  for (const contract of contracts) {
    if (contract.status === "unenforceable" || contract.constraints.unenforceable.length > 0) {
      violations.push({
        code: "EDIT_CONTRACT_UNENFORCEABLE_CONSTRAINT",
        contractId: contract.contractId,
        detail: `契约含无法结构化强制的限制：${contract.constraints.unenforceable.map((entry) => truncate(entry, 80)).join("；")}——暂停修改，需作者决定`,
      });
    } else if (contract.status !== "executable") {
      violations.push({ code: "EDIT_CONTRACT_NOT_EXECUTABLE", contractId: contract.contractId, detail: `契约状态 ${contract.status}，不可执行` });
    }
    if (contract.target.file !== input.target) {
      violations.push({
        code: "EDIT_CONTRACT_TARGET_MISMATCH",
        contractId: contract.contractId,
        detail: `契约只授权 ${contract.target.file}，本次写入目标为 ${input.target}`,
      });
    }
    if (input.enforceBaseHash === true && contract.target.baseHash !== baselineHash) {
      violations.push({ code: "EDIT_CONTRACT_STALE", contractId: contract.contractId, detail: "契约绑定的目标内容已变化（批准后正文变化 / 旧候选回放）——需重新批准" });
    }
  }
  if (violations.length > 0) return finish();

  // ---- 范围：锚契约存在时，允许区间 = 全部锚区间并集；整目标契约不扩大 ----
  const anchorContracts = contracts.filter((contract) => contract.scope.mode === "anchors");
  const collapsedBaseline = collapseWithMap(baseline);
  const collapsedCandidate = collapseWhitespace(candidate);
  if (anchorContracts.length > 0) {
    effective.scope = "anchors";
    const ranges: Array<{ start: number; end: number }> = [];
    for (const contract of anchorContracts) {
      for (const anchor of contract.scope.anchors) {
        const located = locateAnchorCollapsed(collapsedBaseline, anchor.text);
        if (located === null) {
          violations.push({
            code: "EDIT_CONTRACT_SCOPE_UNRESOLVED",
            contractId: contract.contractId,
            detail: `授权锚在基线中不可唯一回放：「${truncate(anchor.text, 80)}」——不猜位置`,
          });
          continue;
        }
        ranges.push(located);
      }
    }
    effective.anchors = ranges.length;
    if (violations.length > 0) return finish();
    ranges.sort((a, b) => a.start - b.start);
    const merged: Array<{ start: number; end: number }> = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end);
      else merged.push({ ...range });
    }
    const outside: string[] = [];
    let cursor = 0;
    for (const range of merged) {
      outside.push(collapsedBaseline.text.slice(cursor, range.start));
      cursor = range.end;
    }
    outside.push(collapsedBaseline.text.slice(cursor));
    if (!segmentsPreservedInOrder(outside, collapsedCandidate)) {
      const missing = outside.flatMap((segment) => splitSentences(segment)).filter((sentence) => !collapsedCandidate.includes(sentence));
      if (missing.length > 0) {
        for (const sentence of missing.slice(0, 8)) {
          violations.push({ code: "EDIT_CONTRACT_OUT_OF_SCOPE", sentence: truncate(sentence, 200), detail: `授权范围外的原文被删除或改写：「${truncate(sentence, 120)}」` });
        }
      } else {
        violations.push({ code: "EDIT_CONTRACT_OUT_OF_SCOPE", detail: "授权范围外的原文未按原顺序逐字保留（插入 / 换序 / 局部改字）" });
      }
    }
    // 删除：范围外逐字保留时，锚区间替换文本为空 = 整体删除；无契约允许 delete_text 即拒绝
    const deletionAllowed = anchorContracts.some((contract) => contract.scope.allowedOps.includes("delete_text"));
    const outsidePreserved = !violations.some((violation) => violation.code === "EDIT_CONTRACT_OUT_OF_SCOPE");
    if (!deletionAllowed && outsidePreserved) {
      const insideChars = collapsedCandidate.replace(/\s/g, "").length - outside.join("").replace(/\s/g, "").length;
      if (insideChars <= 0) {
        violations.push({ code: "EDIT_CONTRACT_DELETION_NOT_ALLOWED", detail: "授权锚区间被整体删除，但契约不允许删除操作" });
      }
    }
  }

  // ---- 数值：受保护值按序守恒（批准值对替换 / 删除；硬冻结下批准不生效） ----
  const hardFreeze = contracts.some((contract) => contract.constraints.hardNumericFreeze);
  const protectAll = contracts.some((contract) => contract.constraints.numericProtect === "all_existing");
  const allowNew = contracts.every((contract) => contract.constraints.allowNewValues);
  effective.hardNumericFreeze = hardFreeze;
  effective.allowNewValues = allowNew;
  // 只有数值 token 受数值约束；含数字的标识符（MOT17 / YOLOv8）属具名实体，由具名实体守卫负责——
  // 审计允许「只保留证据支持的数据集」这类弱化，标识符的增删不是改数
  const baselineTokens = extractValueTokens(baseline).filter((token) => token.kind === "number");
  const candidateTokens = extractValueTokens(candidate).filter((token) => token.kind === "number");
  let protectedTokens: ValueToken[];
  if (protectAll) {
    protectedTokens = baselineTokens;
  } else {
    // listed：每个值的保护份额取各契约清单中出现次数的最大值
    const quota = new Map<string, number>();
    for (const contract of contracts) {
      for (const [value, count] of multisetCount(contract.constraints.protectedValues.map((entry) => normValue(entry)))) {
        quota.set(value, Math.max(quota.get(value) ?? 0, count));
      }
    }
    protectedTokens = baselineTokens.filter((token) => {
      const left = quota.get(token.norm) ?? 0;
      if (left <= 0) return false;
      quota.set(token.norm, left - 1);
      return true;
    });
  }
  const approved = hardFreeze
    ? []
    : contracts.flatMap((contract) => contract.allowedValueChanges).map((change) => ({ before: normValue(change.before), after: normValue(change.after), raw: change }));
  effective.approvedValueChanges = approved.length;
  const expected: ValueToken[] = [];
  for (const token of protectedTokens) {
    const change = approved.find((entry) => entry.before === token.norm);
    if (change === undefined) {
      expected.push(token);
    } else if (change.after !== "") {
      expected.push({ raw: change.raw.after, norm: change.after, kind: token.kind });
    }
  }
  const candidateNorms = candidateTokens.map((token) => token.norm);
  // 顺序守恒只在「数字必须原位不动」的契约下要求（锚范围 / 硬冻结：审计、润色、编译修复）；整目标软策略
  // （系统修订底线）下合法的句子重组会改变数字先后——按多重集守恒判定（删一个再在别处插入同值仍守恒，
  // 但此时编辑区间已被 span / 单元机制限定在本目标内；跨目标移动由范围守卫负责）。历史回放实证：4 个已接受
  // 的重组补丁仅因换序被拒（见 docs/research/M15_20_EDIT_CONTRACT_P0_CLOSURE.md）
  const orderStrict = hardFreeze || anchorContracts.length > 0;
  const preserved = orderStrict
    ? isSubsequence(expected.map((token) => token.norm), candidateNorms)
    : isSubMultiset(expected.map((token) => token.norm), candidateNorms);
  if (!preserved) {
    const expectedCounts = multisetCount(expected.map((token) => token.norm));
    const candidateCounts = multisetCount(candidateNorms);
    const baselineCounts = multisetCount(baselineTokens.map((token) => token.norm));
    const missing: string[] = [];
    for (const [value, count] of expectedCounts) {
      for (let i = 0; i < count - (candidateCounts.get(value) ?? 0); i += 1) missing.push(value);
    }
    const introduced = [...candidateCounts.entries()].flatMap(([value, count]) => Array.from({ length: Math.max(0, count - (baselineCounts.get(value) ?? 0)) }, () => value));
    if (missing.length === 0) {
      violations.push({ code: "EDIT_CONTRACT_VALUE_ORDER_CHANGED", detail: "受保护数值未按原顺序出现（删除后在别处重新插入 / 换序）" });
    }
    for (const value of missing.slice(0, 12)) {
      const replacement = introduced.length > 0;
      violations.push({
        code: replacement ? "EDIT_CONTRACT_PROTECTED_VALUE_CHANGED" : "EDIT_CONTRACT_PROTECTED_VALUE_REMOVED",
        value,
        detail: replacement
          ? `受保护数值 ${value} 被替换（候选新增 ${introduced.slice(0, 6).join("、")}）${hardFreeze ? "——硬禁改约束：任何批准都不能解除" : "——无对应的结构化用户批准"}`
          : `受保护数值 ${value} 被删除${hardFreeze ? "——硬禁改约束" : "——无对应的结构化用户批准"}`,
      });
    }
  }
  // R2：整目标软策略只按多重集守恒——补「同一句内两个受保护值在两个指标标签之间互换」的语义交换检查。
  // 只判定交换（A:v,B:w → A:w,B:v，同句、两值在基线中唯一出现）：单向挪动 / 多次出现的值 / 非同句重写
  // 不在此判定（历史回放实证这些形态以合法改写为主，强行判定会系统性误拒）
  if (!orderStrict) {
    const protectedNorms = new Set(expected.map((token) => token.norm));
    const baselineCounts = multisetCount(baselineTokens.map((token) => token.norm));
    const unique = (norm: string) => protectedNorms.has(norm) && baselineCounts.get(norm) === 1;
    const baselineBindings = extractValueBindings(baseline).filter((binding) => unique(binding.norm));
    const candidateBindings = extractValueBindings(candidate).filter((binding) => unique(binding.norm));
    const has = (bindings: readonly ValueBinding[], label: string, norm: string, sentence?: number) =>
      bindings.some((binding) => binding.label === label && binding.norm === norm && (sentence === undefined || binding.sentence === sentence));
    const reported = new Set<string>();
    for (const first of baselineBindings) {
      for (const second of baselineBindings) {
        if (second.sentence !== first.sentence || second.label === first.label || second.norm === first.norm) continue;
        if (reported.has(first.norm) || reported.has(second.norm)) continue;
        if (has(baselineBindings, first.label, second.norm) || has(baselineBindings, second.label, first.norm)) continue;
        const swapped = candidateBindings.find((binding) => binding.label === first.label && binding.norm === second.norm &&
          has(candidateBindings, second.label, first.norm, binding.sentence));
        if (swapped === undefined) continue;
        reported.add(first.norm);
        reported.add(second.norm);
        violations.push({
          code: "EDIT_CONTRACT_VALUE_REBOUND",
          value: first.norm,
          detail: `受保护数值互换：${first.label}=${first.norm}、${second.label}=${second.norm} 在候选中变为 ${first.label}=${second.norm}、${second.label}=${first.norm}（数值多重集守恒但含义交换）——无对应的结构化用户批准`,
        });
      }
    }
  }
  if (!allowNew) {
    const allowedNew = multisetCount([...baselineTokens.map((token) => token.norm), ...approved.map((entry) => entry.after).filter((value) => value !== "")]);
    for (const token of candidateTokens) {
      const left = allowedNew.get(token.norm) ?? 0;
      if (left > 0) {
        allowedNew.set(token.norm, left - 1);
        continue;
      }
      if (!violations.some((violation) => violation.code === "EDIT_CONTRACT_NEW_VALUE" && violation.value === token.norm)) {
        violations.push({ code: "EDIT_CONTRACT_NEW_VALUE", value: token.norm, detail: `契约禁止新增数值，候选引入 ${token.raw}` });
      }
    }
  }

  // ---- 引用：取最严策略 ----
  const citationStrictness = (policy: EditContractConstraints["citationPolicy"]): number =>
    policy === "preserve_existing_no_new" ? 2 : policy === "preserve_existing" ? 1 : 0;
  const strictness = Math.max(...contracts.map((contract) => citationStrictness(contract.constraints.citationPolicy)));
  const protectedKeys = new Set(contracts.flatMap((contract) => contract.constraints.protectedCitationKeys));
  const baselineKeys = new Set(extractCitationKeys(input.target, baseline).keys);
  const candidateKeys = new Set(extractCitationKeys(input.target, candidate).keys);
  for (const key of new Set([...(strictness >= 1 ? baselineKeys : []), ...[...protectedKeys].filter((key) => baselineKeys.has(key))])) {
    if (!candidateKeys.has(key)) violations.push({ code: "EDIT_CONTRACT_CITATION_REMOVED", value: key, detail: `契约要求保留的引用 \\cite{${key}} 被删除` });
  }
  if (strictness >= 2) {
    for (const key of candidateKeys) {
      if (!baselineKeys.has(key)) violations.push({ code: "EDIT_CONTRACT_CITATION_ADDED", value: key, detail: `契约禁止新增引用，候选引入 \\cite{${key}}` });
    }
  }
  return finish();
}

function isSubMultiset(needle: readonly string[], haystack: readonly string[]): boolean {
  const counts = multisetCount(haystack);
  for (const value of needle) {
    const left = counts.get(value) ?? 0;
    if (left <= 0) return false;
    counts.set(value, left - 1);
  }
  return true;
}

function isSubsequence(needle: readonly string[], haystack: readonly string[]): boolean {
  let index = 0;
  for (const value of haystack) {
    if (index < needle.length && needle[index] === value) index += 1;
  }
  return index === needle.length;
}

/** 范围外段落按序出现：首段为前缀、末段为后缀、中段依序（空白归一后） */
function segmentsPreservedInOrder(outside: readonly string[], candidate: string): boolean {
  const segments = outside.map((segment) => segment.trim());
  const first = segments[0] ?? "";
  const last = segments.length > 1 ? segments[segments.length - 1]! : "";
  let position = 0;
  if (first !== "") {
    if (!candidate.startsWith(first)) return false;
    position = first.length;
  }
  for (let index = 1; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    if (segment === "") continue;
    const found = candidate.indexOf(segment, position);
    if (found < 0) return false;
    position = found + segment.length;
  }
  if (segments.length > 1 && last !== "") {
    if (!candidate.endsWith(last)) return false;
    if (candidate.length - last.length < position) return false;
  }
  return true;
}

/** 违规的紧凑描述（patch 记录 / 指令状态说明用） */
export function describeEditContractVerdict(verdict: EditContractVerdict, max = 4): string {
  if (verdict.ok) return "EDIT_CONTRACT_SATISFIED";
  const codes = [...new Set(verdict.violations.map((violation) => violation.code))];
  return `EDIT_CONTRACT_VIOLATION[${codes.join(",")}]: ${verdict.violations.slice(0, max).map((violation) => violation.detail).join("；")}`;
}
