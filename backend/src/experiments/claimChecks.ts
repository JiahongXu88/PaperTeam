/**
 * M14.9.5.4 预先登记的实验论断复算（claim checks）：论文语句 → 作者实验包中的原始输入（文件哈希）→ 登记的
 * 过滤与计算 → 复算值 → verdict。纯确定性（无 LLM），只读实验包已解析的结构化记录（ParsedDocumentStore），
 * 不新建证据库，不把几十万条观测塞进 prompt。
 *
 * 纪律（任务书 M14.9.5.4 P0-1）：
 *   - 登记 ≠ 核验：只有「前提全部成立 + 确定性复算」才给出 CONSISTENT / CONTRADICTED；缺列、错协议、文件哈希不符
 *     （过期修订）、冲突版本、越界 / 未授权输入、稿件锚点失效一律 NOT_EVALUATED，绝不猜测、绝不换相似实验。
 *   - 三个维度分开记录：授权（作者确认 + 授权进入工作流）、来源真实性（作者提供、哈希绑定，未经外部独立核验）、
 *     推导正确性（PaperTeam 按登记口径复算）。复算一致不等于 Verified Evidence，更不等于外部独立核验。
 *   - 计算语言是白名单表达式（数字 / 列名 / $参数 / + - * / 比较 / && || ! / min max abs），不执行任何代码。
 */
import { sha256Hex } from "../util/hash.js";
import type { ParsedDocument, ParsedRecordBlock } from "../ingestion/types.js";

export const CLAIM_CHECK_PLAN_SCHEMA = "paperteam.claim-checks/v1";
export const CLAIM_CHECK_LEDGER_SCHEMA = "paperteam.claim-check-ledger/v1";
export const CLAIM_CHECK_PLAN_FILE = "claim-checks.json";
const MAX_CHECKS = 50;
const MAX_ROWS = 200_000;

export interface ClaimCheckFileRef {
  /** 实验包内相对路径（与 manifest 的 file.path 完全一致；不允许绝对路径 / ..） */
  path: string;
  /** 登记时该文件的 sha256（与包内文件哈希不符 = 数据已变化 / 过期修订 → NOT_EVALUATED） */
  sha256: string;
  /** 可选：限定实验包哈希（重新导入的新包不会被静默替换使用） */
  packageHash?: string;
}
export interface ClaimCheckParamRef extends ClaimCheckFileRef {
  /** JSON / YAML 叶子路径（解析器的 jsonPath 记法，如 $.frozen_parameters.alpha_iou） */
  jsonPath: string;
}
export type ClaimCheckProtocolAssertion =
  /** 包内来源清单（如 SOURCES.json）在 jsonPath 处记录的 sha256 必须等于数据源文件哈希 */
  | { kind: "source_manifest_sha256"; manifest: ClaimCheckParamRef }
  /** 某个 JSON / YAML 字段必须等于给定值（协议 / schema / 参数声明） */
  | { kind: "json_equals"; ref: ClaimCheckParamRef; equals: string | number }
  /** 选中行的某列取值必须全部在给定集合内（越界数据 → 协议不符） */
  | { kind: "column_values_in"; column: string; values: string[] };

export interface ClaimCheckSpec {
  id: string;
  title: string;
  /** 缺省 true：登记即声明「这条论断需要复算」，无法复算 → Gate NOT_EVALUATED（必需） */
  required?: boolean;
  /** core = 论文核心结论所依赖的论断（矛盾 → major finding）；supporting = 支撑性数值（矛盾 → minor finding） */
  materiality: "core" | "supporting";
  claim: { quote: string; value: number; kind?: "number" | "boolean"; unit?: string };
  /** 逐行数据源（CSV / XLSX 等表格）；scalar 计算可省略 */
  source?: ClaimCheckFileRef & { sheet?: string };
  /** 计算参数；同一参数给出多个来源时必须一致，否则 CONFLICTING_VERSIONS */
  parameters?: Record<string, ClaimCheckParamRef[]>;
  protocol: { id: string; description?: string; assertions: ClaimCheckProtocolAssertion[] };
  filters?: Array<{ column: string; equals: string }>;
  calculation: { aggregate: "count" | "sum" | "mean" | "min" | "max" | "scalar"; where?: string; value?: string; description: string };
  compare?: { tolerance?: number; note?: string };
  /** 适用条件（如「成对反事实，不模拟全局匈牙利分配」）——随 verdict 一起呈现 */
  conditions?: string;
}
export interface ClaimCheckPlan {
  schema: typeof CLAIM_CHECK_PLAN_SCHEMA;
  registeredAt?: string;
  registeredBy?: string;
  note?: string;
  checks: ClaimCheckSpec[];
}

export type ClaimCheckVerdict = "CONSISTENT" | "CONTRADICTED" | "NOT_EVALUATED";
export type ClaimCheckGapCode =
  | "INVALID_SPEC" | "MANUSCRIPT_ANCHOR_NOT_FOUND" | "OUT_OF_PACKAGE" | "SOURCE_NOT_AVAILABLE" | "PACKAGE_VERSION_MISMATCH"
  | "SOURCE_HASH_MISMATCH" | "CONFLICTING_VERSIONS" | "UNAUTHORIZED_INPUT" | "SOURCE_NOT_PARSED" | "SOURCE_NOT_TABULAR"
  | "COLUMN_MISSING" | "VALUE_MISSING" | "PARAMETER_MISSING" | "PROTOCOL_MISMATCH" | "EMPTY_SELECTION" | "EXPRESSION_ERROR";

export interface ClaimCheckSourceUse {
  role: "data" | "parameter" | "protocol";
  name?: string;
  path: string;
  packageId: string | null;
  packageHash: string | null;
  sourceId: string | null;
  fileHash: string | null;
  groupId: string | null;
  authorization: "AUTHORIZED" | "UNAUTHORIZED" | "UNKNOWN";
}

export interface ClaimCheckResult {
  id: string;
  title: string;
  materiality: "core" | "supporting";
  required: boolean;
  claimAnchor: { quote: string; found: boolean; file: string | null; line: number | null; manuscriptRevision: number | null; manuscriptSha256: string };
  manuscriptValue: number;
  valueKind: "number" | "boolean";
  protocol: { id: string; status: "VERIFIED_BY_SOURCE" | "DECLARED_ONLY" | "MISMATCH" | "NOT_CHECKED"; assertions: Array<{ kind: string; ok: boolean; detail: string }> };
  sources: ClaimCheckSourceUse[];
  filters: Array<{ column: string; equals: string }>;
  calculation: ClaimCheckSpec["calculation"];
  parameters: Record<string, number>;
  rows: { total: number; afterFilters: number; selected: number } | null;
  derivedValue: number | null;
  verdict: ClaimCheckVerdict;
  gaps: Array<{ code: ClaimCheckGapCode; detail: string }>;
  evidence: {
    authorization: "AUTHORIZED" | "UNAUTHORIZED" | "UNKNOWN";
    sourceAuthenticity: "AUTHOR_SUPPLIED_UNVERIFIED";
    hashBinding: "MATCH" | "MISMATCH" | "UNKNOWN";
    derivation: "RECOMPUTED_BY_PAPERTEAM" | "NOT_RECOMPUTED";
    externalVerification: "NOT_EXTERNALLY_VERIFIED";
    /** 最高只到「由作者数据确定性复算」——永远不是 verified */
    level: "RECOMPUTED_FROM_AUTHOR_DATA" | "NOT_EVALUATED";
  };
  conditions?: string;
  tolerance: number;
  limitations: string[];
}

export interface ClaimCheckLedger {
  schema: typeof CLAIM_CHECK_LEDGER_SCHEMA;
  planSha256: string | null;
  planError?: string;
  manuscriptRevision: number | null;
  manuscriptSha256: string;
  results: ClaimCheckResult[];
  counts: { registered: number; consistent: number; contradicted: number; notEvaluated: number };
  /** results 的确定性哈希（不含时间戳）：prompt / finding / Gate 引用同一账本 */
  ledgerHash: string;
}

/** Gate 规则 experiment_claims_recomputed 的输入摘要 */
export interface ClaimCheckGateSummary {
  registered: number;
  consistent: number;
  contradicted: Array<{ id: string; materiality: "core" | "supporting"; manuscriptValue: number; derivedValue: number | null }>;
  notEvaluated: Array<{ id: string; reason: string; required: boolean }>;
  ledgerHash: string;
  experimentPackages: number;
}

/** 评估环境：实验包视图 + 只读加载器（ExperimentPackageService.claimCheckEnvironment 提供） */
export interface ClaimCheckEnvironment {
  packages: ReadonlyArray<{
    packageId: string;
    packageHash: string;
    files: ReadonlyArray<{ path: string; hash: string; sourceId?: string; parseStatus: string; groupId: string; role: string }>;
    groups: ReadonlyArray<{ id: string; status: string; splitScopes?: ReadonlyArray<{ status: string; workflowUse: string; filePaths: readonly string[] }> }>;
  }>;
  loadDocument(sourceId: string): Promise<ParsedDocument | null>;
  /** Source 的当前内容哈希（已删除 → null） */
  sourceHash(sourceId: string): Promise<string | null>;
  manuscript: { revision: number | null; files: ReadonlyArray<{ file: string; content: string }> };
}

// ---------------- 计划校验 ----------------

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/;
const SHA_PATTERN = /^[a-f0-9]{64}$/;

function invalidPath(path: string): boolean {
  return path === "" || path.includes("..") || path.includes("\\") || /^[/~]/.test(path) || /^[A-Za-z]:/.test(path) || path.includes("\0");
}

/** 计划结构校验（PUT 入口与读取时共用）；返回问题清单（空 = 合法） */
export function validateClaimCheckPlan(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== "object" || value === null) return ["计划必须是 JSON 对象"];
  const plan = value as Record<string, unknown>;
  if (plan["schema"] !== CLAIM_CHECK_PLAN_SCHEMA) problems.push(`schema 必须为 ${CLAIM_CHECK_PLAN_SCHEMA}`);
  const checks = plan["checks"];
  if (!Array.isArray(checks)) return [...problems, "checks 必须是数组"];
  if (checks.length > MAX_CHECKS) problems.push(`checks 最多 ${MAX_CHECKS} 条`);
  const ids = new Set<string>();
  checks.forEach((raw, index) => {
    const at = `checks[${index}]`;
    if (typeof raw !== "object" || raw === null) { problems.push(`${at} 不是对象`); return; }
    const check = raw as Record<string, unknown>;
    const id = check["id"];
    if (typeof id !== "string" || !ID_PATTERN.test(id)) problems.push(`${at}.id 非法`);
    else if (ids.has(id)) problems.push(`${at}.id 重复：${id}`);
    else ids.add(id);
    if (check["materiality"] !== "core" && check["materiality"] !== "supporting") problems.push(`${at}.materiality 必须为 core | supporting`);
    const claim = check["claim"] as Record<string, unknown> | undefined;
    if (typeof claim?.["quote"] !== "string" || (claim["quote"] as string).trim().length < 8) problems.push(`${at}.claim.quote 至少 8 字（稿件原文逐字摘录）`);
    if (typeof claim?.["value"] !== "number" || !Number.isFinite(claim["value"])) problems.push(`${at}.claim.value 必须是有限数字`);
    const refs: Array<[string, unknown]> = [];
    if (check["source"] !== undefined) refs.push([`${at}.source`, check["source"]]);
    for (const [name, list] of Object.entries((check["parameters"] as Record<string, unknown> | undefined) ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) problems.push(`${at}.parameters.${name} 名称非法`);
      if (!Array.isArray(list) || list.length === 0) problems.push(`${at}.parameters.${name} 必须是非空数组`);
      else list.forEach((ref, refIndex) => refs.push([`${at}.parameters.${name}[${refIndex}]`, ref]));
    }
    const protocol = check["protocol"] as Record<string, unknown> | undefined;
    if (typeof protocol?.["id"] !== "string" || !Array.isArray(protocol["assertions"])) problems.push(`${at}.protocol 需要 id 与 assertions[]`);
    else for (const assertion of protocol["assertions"] as Array<Record<string, unknown>>) {
      if (assertion?.["kind"] === "source_manifest_sha256") refs.push([`${at}.protocol.manifest`, assertion["manifest"]]);
      else if (assertion?.["kind"] === "json_equals") refs.push([`${at}.protocol.ref`, assertion["ref"]]);
      else if (assertion?.["kind"] !== "column_values_in") problems.push(`${at}.protocol.assertions 含未知 kind`);
    }
    for (const [where, ref] of refs) {
      const record = ref as Record<string, unknown> | undefined;
      if (typeof record?.["path"] !== "string") { problems.push(`${where}.path 缺失`); continue; }
      if (typeof record["sha256"] !== "string" || !SHA_PATTERN.test(record["sha256"] as string)) problems.push(`${where}.sha256 必须是 64 位十六进制`);
    }
    const calculation = check["calculation"] as Record<string, unknown> | undefined;
    const aggregate = calculation?.["aggregate"];
    if (!["count", "sum", "mean", "min", "max", "scalar"].includes(aggregate as string)) problems.push(`${at}.calculation.aggregate 非法`);
    else {
      if (aggregate !== "scalar" && check["source"] === undefined) problems.push(`${at}：逐行计算需要 source`);
      if (["sum", "mean", "min", "max", "scalar"].includes(aggregate as string) && typeof calculation?.["value"] !== "string") problems.push(`${at}.calculation.value 缺失`);
      for (const field of ["where", "value"] as const) {
        const expression = calculation?.[field];
        if (expression === undefined) continue;
        try { parseExpression(String(expression)); } catch (error) { problems.push(`${at}.calculation.${field}：${(error as Error).message}`); }
      }
    }
    if (typeof calculation?.["description"] !== "string") problems.push(`${at}.calculation.description 缺失`);
  });
  return problems;
}

// ---------------- 白名单表达式 ----------------

type Expr =
  | { type: "num"; value: number }
  | { type: "col"; name: string }
  | { type: "param"; name: string }
  | { type: "unary"; op: "-" | "!"; arg: Expr }
  | { type: "bin"; op: string; left: Expr; right: Expr }
  | { type: "call"; fn: "min" | "max" | "abs"; args: Expr[] };

const TOKEN = /\s*(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+|\$[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*|&&|\|\||<=|>=|==|!=|[-+*/()<>!,])/y;

export function parseExpression(source: string): Expr {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  let index = 0;
  while (index < source.length) {
    if (/^\s*$/.test(source.slice(index))) break;
    TOKEN.lastIndex = index;
    const match = TOKEN.exec(source);
    if (match === null) throw new Error(`表达式含不允许的字符：${source.slice(index, index + 12)}`);
    tokens.push(match[1]!);
    index = TOKEN.lastIndex;
  }
  let position = 0;
  const peek = (): string | undefined => tokens[position];
  const take = (expected?: string): string => {
    const token = tokens[position];
    if (token === undefined || (expected !== undefined && token !== expected)) throw new Error(`表达式语法错误：期望 ${expected ?? "token"}，得到 ${token ?? "结尾"}`);
    position += 1;
    return token;
  };
  const binary = (next: () => Expr, ops: string[]): (() => Expr) => () => {
    let left = next();
    while (peek() !== undefined && ops.includes(peek()!)) {
      const op = take();
      left = { type: "bin", op, left, right: next() };
    }
    return left;
  };
  const primary = (): Expr => {
    const token = take();
    if (token === "(") { const inner = or(); take(")"); return inner; }
    if (token === "-" || token === "!") return { type: "unary", op: token, arg: primary() };
    if (/^(\d|\.)/.test(token)) return { type: "num", value: Number(token) };
    if (token.startsWith("$")) return { type: "param", name: token.slice(1) };
    if (/^[A-Za-z_]/.test(token)) {
      if (peek() === "(") {
        if (token !== "min" && token !== "max" && token !== "abs") throw new Error(`不允许的函数：${token}`);
        take("(");
        const args: Expr[] = [or()];
        while (peek() === ",") { take(","); args.push(or()); }
        take(")");
        if (token === "abs" ? args.length !== 1 : args.length < 2) throw new Error(`${token} 参数个数不对`);
        return { type: "call", fn: token, args };
      }
      return { type: "col", name: token };
    }
    throw new Error(`表达式语法错误：${token}`);
  };
  const mul = binary(primary, ["*", "/"]);
  const add = binary(mul, ["+", "-"]);
  const cmp = (): Expr => {
    const left = add();
    if (peek() !== undefined && ["<", "<=", ">", ">=", "==", "!="].includes(peek()!)) {
      const op = take();
      return { type: "bin", op, left, right: add() };
    }
    return left;
  };
  const and = binary(cmp, ["&&"]);
  const or = binary(and, ["||"]);
  const expr = or();
  if (position !== tokens.length) throw new Error(`表达式多余内容：${tokens.slice(position).join(" ")}`);
  return expr;
}

function collectNames(expr: Expr, columns: Set<string>, params: Set<string>): void {
  switch (expr.type) {
    case "col": columns.add(expr.name); break;
    case "param": params.add(expr.name); break;
    case "unary": collectNames(expr.arg, columns, params); break;
    case "bin": collectNames(expr.left, columns, params); collectNames(expr.right, columns, params); break;
    case "call": expr.args.forEach((arg) => collectNames(arg, columns, params)); break;
    default: break;
  }
}

class MissingValueError extends Error {}

function evaluate(expr: Expr, column: (name: string) => number, param: (name: string) => number): number {
  switch (expr.type) {
    case "num": return expr.value;
    case "col": return column(expr.name);
    case "param": return param(expr.name);
    case "unary": return expr.op === "-" ? -evaluate(expr.arg, column, param) : evaluate(expr.arg, column, param) === 0 ? 1 : 0;
    case "call": {
      const values = expr.args.map((arg) => evaluate(arg, column, param));
      return expr.fn === "abs" ? Math.abs(values[0]!) : expr.fn === "min" ? Math.min(...values) : Math.max(...values);
    }
    case "bin": {
      if (expr.op === "&&") return evaluate(expr.left, column, param) !== 0 && evaluate(expr.right, column, param) !== 0 ? 1 : 0;
      if (expr.op === "||") return evaluate(expr.left, column, param) !== 0 || evaluate(expr.right, column, param) !== 0 ? 1 : 0;
      const a = evaluate(expr.left, column, param);
      const b = evaluate(expr.right, column, param);
      switch (expr.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": if (b === 0) throw new MissingValueError("除数为 0"); return a / b;
        case "<": return a < b ? 1 : 0;
        case "<=": return a <= b ? 1 : 0;
        case ">": return a > b ? 1 : 0;
        case ">=": return a >= b ? 1 : 0;
        case "==": return a === b ? 1 : 0;
        case "!=": return a !== b ? 1 : 0;
        default: throw new Error(`未知运算 ${expr.op}`);
      }
    }
  }
}

// ---------------- 稿件锚点 ----------------

/** 锚点比较的规范化：NFKC、LaTeX 不换行空格 ~ 与连续空白折叠（不改写任何字符内容） */
export function normalizeAnchorText(text: string): string {
  return text.normalize("NFKC").replace(/~/g, " ").replace(/\s+/g, " ").trim();
}

function locateQuote(files: ClaimCheckEnvironment["manuscript"]["files"], quote: string): { file: string; line: number } | null {
  const target = normalizeAnchorText(quote);
  for (const file of files) {
    const normalized = normalizeAnchorText(file.content);
    const at = normalized.indexOf(target);
    if (at < 0) continue;
    // 行号：在原文中按规范化前缀长度近似定位（逐行累积规范化长度）
    const lines = file.content.split(/\r?\n/);
    let consumed = 0;
    for (let index = 0; index < lines.length; index += 1) {
      consumed += normalizeAnchorText(lines[index]!).length + 1;
      if (consumed > at) return { file: file.file, line: index + 1 };
    }
    return { file: file.file, line: lines.length };
  }
  return null;
}

function quoteNumbers(quote: string): number[] {
  return [...normalizeAnchorText(quote).replace(/\{,\}/g, "").replace(/(\d),(?=\d{3}\b)/g, "$1").matchAll(/(?<![\d.])\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
}

// ---------------- 评估 ----------------

interface ResolvedFile {
  packageId: string;
  packageHash: string;
  path: string;
  hash: string;
  sourceId?: string;
  parseStatus: string;
  groupId: string;
  authorized: boolean;
}

function resolveFile(env: ClaimCheckEnvironment, ref: ClaimCheckFileRef): { file: ResolvedFile; others: string[] } | { code: ClaimCheckGapCode; detail: string } {
  if (invalidPath(ref.path)) return { code: "OUT_OF_PACKAGE", detail: `路径 ${ref.path} 不是实验包内相对路径（绝对路径 / .. / 反斜杠一律拒绝）` };
  const candidates: ResolvedFile[] = [];
  for (const item of env.packages) {
    for (const file of item.files) {
      if (file.path !== ref.path) continue;
      // 授权口径与 workflowContext 一致：文件落在实验范围内 → 范围须「已确认 + 授权进入工作流」（组级状态不参与）；
      // 不在任何范围内（配置 / 清单等无观测文件）→ 所在实验组须已确认
      const group = item.groups.find((entry) => entry.id === file.groupId);
      const scopes = (group?.splitScopes ?? []).filter((scope) => scope.filePaths.includes(file.path));
      const authorized = group !== undefined && (scopes.length > 0
        ? scopes.every((scope) => scope.status === "confirmed" && scope.workflowUse === "allowed")
        : group.status === "confirmed");
      candidates.push({ packageId: item.packageId, packageHash: item.packageHash, path: file.path, hash: file.hash, ...(file.sourceId !== undefined ? { sourceId: file.sourceId } : {}), parseStatus: file.parseStatus, groupId: file.groupId, authorized });
    }
  }
  if (candidates.length === 0) return { code: "SOURCE_NOT_AVAILABLE", detail: `项目实验包中没有 ${ref.path}` };
  const inPackage = ref.packageHash === undefined ? candidates : candidates.filter((candidate) => candidate.packageHash === ref.packageHash);
  if (inPackage.length === 0) {
    return { code: "PACKAGE_VERSION_MISMATCH", detail: `${ref.path} 只存在于其他实验包（${[...new Set(candidates.map((candidate) => candidate.packageHash.slice(0, 12)))].join("、")}），与登记的包 ${ref.packageHash!.slice(0, 12)} 不符` };
  }
  const matching = inPackage.filter((candidate) => candidate.hash === ref.sha256);
  if (matching.length === 0) {
    return { code: "SOURCE_HASH_MISMATCH", detail: `${ref.path} 当前哈希 ${[...new Set(inPackage.map((candidate) => candidate.hash.slice(0, 12)))].join("/")} ≠ 登记哈希 ${ref.sha256.slice(0, 12)}（数据已变化 / 过期修订，不使用）` };
  }
  return { file: matching[0]!, others: [...new Set(inPackage.filter((candidate) => candidate.hash !== ref.sha256).map((candidate) => candidate.hash.slice(0, 12)))] };
}

function cellValue(block: ParsedRecordBlock, header: string): string | undefined {
  return block.cells.find((cell) => cell.header === header)?.value;
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number): number {
  return Math.round(value * 1e10) / 1e10;
}

/**
 * 评估整个登记计划（确定性；同一计划 + 同一实验包 + 同一稿件修订 → 同一账本哈希）。
 * plan=null（未登记）→ 空账本；planError → 账本带错误、每条视为不可评估由调用方呈现。
 */
export async function evaluateClaimCheckPlan(plan: ClaimCheckPlan | null, env: ClaimCheckEnvironment, options: { planError?: string } = {}): Promise<ClaimCheckLedger> {
  const manuscriptSha256 = sha256Hex(env.manuscript.files.map((file) => `${file.file}\n${file.content}`).join("\n\0\n"));
  const results: ClaimCheckResult[] = [];
  const documents = new Map<string, Promise<ParsedDocument | null>>();
  const loadDocument = (sourceId: string): Promise<ParsedDocument | null> => {
    if (!documents.has(sourceId)) documents.set(sourceId, env.loadDocument(sourceId));
    return documents.get(sourceId)!;
  };
  for (const spec of plan?.checks ?? []) results.push(await evaluateOne(spec, env, loadDocument, manuscriptSha256));
  const counts = {
    registered: results.length,
    consistent: results.filter((result) => result.verdict === "CONSISTENT").length,
    contradicted: results.filter((result) => result.verdict === "CONTRADICTED").length,
    notEvaluated: results.filter((result) => result.verdict === "NOT_EVALUATED").length,
  };
  const planSha256 = plan === null ? null : sha256Hex(JSON.stringify(plan));
  return {
    schema: CLAIM_CHECK_LEDGER_SCHEMA,
    planSha256,
    ...(options.planError !== undefined ? { planError: options.planError } : {}),
    manuscriptRevision: env.manuscript.revision,
    manuscriptSha256,
    results,
    counts,
    ledgerHash: sha256Hex(JSON.stringify({ planSha256, planError: options.planError ?? null, manuscriptSha256, results })),
  };
}

async function evaluateOne(
  spec: ClaimCheckSpec,
  env: ClaimCheckEnvironment,
  loadDocument: (sourceId: string) => Promise<ParsedDocument | null>,
  manuscriptSha256: string,
): Promise<ClaimCheckResult> {
  const gaps: ClaimCheckResult["gaps"] = [];
  const limitations: string[] = [];
  const sources: ClaimCheckSourceUse[] = [];
  const valueKind = spec.claim.kind ?? "number";
  const tolerance = Math.max(0, spec.compare?.tolerance ?? 0);
  const anchor = locateQuote(env.manuscript.files, spec.claim.quote);
  if (anchor === null) {
    gaps.push({ code: "MANUSCRIPT_ANCHOR_NOT_FOUND", detail: "登记的论断原文不在被审修订中（稿件已修改或登记针对其他版本）：本条不复算、不沿用旧结论" });
  } else if (valueKind === "number" && !quoteNumbers(spec.claim.quote).some((value) => Math.abs(value - spec.claim.value) < 1e-9)) {
    gaps.push({ code: "INVALID_SPEC", detail: `登记的稿件值 ${spec.claim.value} 不在论断原文中出现（登记不自洽）` });
  }
  const protocolAssertions: ClaimCheckResult["protocol"]["assertions"] = [];
  const parameters: Record<string, number> = {};
  let dataFile: ResolvedFile | undefined;
  let hashBinding: ClaimCheckResult["evidence"]["hashBinding"] = "UNKNOWN";
  const use = (role: ClaimCheckSourceUse["role"], ref: ClaimCheckFileRef, resolved: ResolvedFile | undefined, name?: string): void => {
    sources.push({
      role, ...(name !== undefined ? { name } : {}), path: ref.path,
      packageId: resolved?.packageId ?? null, packageHash: resolved?.packageHash ?? null, sourceId: resolved?.sourceId ?? null,
      fileHash: resolved?.hash ?? null, groupId: resolved?.groupId ?? null,
      authorization: resolved === undefined ? "UNKNOWN" : resolved.authorized ? "AUTHORIZED" : "UNAUTHORIZED",
    });
  };
  /** 文件引用 → 已授权、哈希一致、已解析且来源存活的文档 */
  const open = async (role: ClaimCheckSourceUse["role"], ref: ClaimCheckFileRef, name?: string): Promise<{ file: ResolvedFile; document: ParsedDocument } | null> => {
    const resolved = resolveFile(env, ref);
    if ("code" in resolved) {
      use(role, ref, undefined, name);
      gaps.push({ code: resolved.code, detail: `${role === "data" ? "数据源" : role === "parameter" ? `参数 ${name}` : "协议依据"}：${resolved.detail}` });
      if (resolved.code === "SOURCE_HASH_MISMATCH" && role === "data") hashBinding = "MISMATCH";
      return null;
    }
    use(role, ref, resolved.file, name);
    if (resolved.others.length > 0) limitations.push(`${ref.path} 在实验包中另有不同哈希版本（${resolved.others.join("、")}），按登记哈希使用`);
    if (!resolved.file.authorized) {
      gaps.push({ code: "UNAUTHORIZED_INPUT", detail: `${ref.path} 所在实验组 ${resolved.file.groupId} 未经作者确认 / 未授权进入工作流` });
      return null;
    }
    if (resolved.file.sourceId === undefined || !["ok", "partial"].includes(resolved.file.parseStatus)) {
      gaps.push({ code: "SOURCE_NOT_PARSED", detail: `${ref.path} 未解析为结构化记录（${resolved.file.parseStatus}）` });
      return null;
    }
    const live = await env.sourceHash(resolved.file.sourceId);
    const document = await loadDocument(resolved.file.sourceId);
    if (live !== resolved.file.hash || document === null || document.contentHash !== resolved.file.hash) {
      gaps.push({ code: "SOURCE_HASH_MISMATCH", detail: `${ref.path} 的 Source / 解析产物已删除或与包内哈希不一致（不使用过期解析结果）` });
      if (role === "data") hashBinding = "MISMATCH";
      return null;
    }
    if (role === "data") hashBinding = "MATCH";
    return { file: resolved.file, document };
  };
  const readJsonCell = (document: ParsedDocument, jsonPath: string): string | undefined => {
    for (const block of document.blocks) {
      if (block.type !== "structured_record") continue;
      const value = cellValue(block, jsonPath);
      if (value !== undefined) return value;
    }
    return undefined;
  };

  // 参数（多来源必须一致）
  for (const [name, refs] of Object.entries(spec.parameters ?? {})) {
    const values: Array<{ value: number; path: string }> = [];
    for (const ref of refs) {
      const opened = await open("parameter", ref, name);
      if (opened === null) continue;
      const value = parseNumber(readJsonCell(opened.document, ref.jsonPath));
      if (value === null) gaps.push({ code: "PARAMETER_MISSING", detail: `参数 ${name}：${ref.path} 没有数值字段 ${ref.jsonPath}` });
      else values.push({ value, path: ref.path });
    }
    if (values.length > 0 && values.some((entry) => entry.value !== values[0]!.value)) {
      gaps.push({ code: "CONFLICTING_VERSIONS", detail: `参数 ${name} 的来源互相矛盾：${values.map((entry) => `${entry.path.split("/").pop()}=${entry.value}`).join(" vs ")}（不选择其一）` });
    } else if (values.length === refs.length && values.length > 0) {
      parameters[name] = values[0]!.value;
    }
  }

  // 数据源（逐行）
  let dataDocument: ParsedDocument | undefined;
  if (spec.source !== undefined) {
    const opened = await open("data", spec.source);
    if (opened !== null) { dataFile = opened.file; dataDocument = opened.document; }
  }

  // 表达式与列
  let whereExpr: Expr | undefined;
  let valueExpr: Expr | undefined;
  const columns = new Set<string>();
  const params = new Set<string>();
  try {
    if (spec.calculation.where !== undefined) whereExpr = parseExpression(spec.calculation.where);
    if (spec.calculation.value !== undefined) valueExpr = parseExpression(spec.calculation.value);
  } catch (error) {
    gaps.push({ code: "INVALID_SPEC", detail: `计算表达式非法：${(error as Error).message}` });
  }
  if (whereExpr !== undefined) collectNames(whereExpr, columns, params);
  if (valueExpr !== undefined) collectNames(valueExpr, columns, params);
  for (const filter of spec.filters ?? []) columns.add(filter.column);
  for (const assertion of spec.protocol.assertions) if (assertion.kind === "column_values_in") columns.add(assertion.column);
  if (spec.calculation.aggregate === "scalar" && columns.size > 0) gaps.push({ code: "INVALID_SPEC", detail: `scalar 计算不能引用数据列（${[...columns].join("、")}）` });
  for (const name of params) {
    if (spec.parameters?.[name] === undefined) gaps.push({ code: "INVALID_SPEC", detail: `表达式引用了未登记的参数 $${name}` });
  }

  // 表格行
  let rows: ParsedRecordBlock[] = [];
  let headers: string[] = [];
  if (dataDocument !== undefined) {
    const sheets = dataDocument.sheets ?? [];
    const sheet = spec.source?.sheet !== undefined ? sheets.find((entry) => entry.name === spec.source!.sheet) : sheets.length === 1 ? sheets[0] : undefined;
    if (dataDocument.kind !== "tabular" || sheet === undefined) {
      gaps.push({ code: "SOURCE_NOT_TABULAR", detail: `${spec.source!.path} 不是可逐行计算的单表数据${sheets.length > 1 ? `（${sheets.length} 个工作表，需登记 sheet）` : ""}` });
    } else {
      headers = sheet.headers ?? [];
      rows = dataDocument.blocks.filter((block): block is ParsedRecordBlock => block.type === "structured_record" && (sheets.length === 1 || block.provenance.sheet === sheet.name));
      if (rows.length > MAX_ROWS) gaps.push({ code: "INVALID_SPEC", detail: `数据行 ${rows.length} 超过上限 ${MAX_ROWS}` });
      const missing = [...columns].filter((column) => !headers.includes(column));
      if (missing.length > 0) gaps.push({ code: "COLUMN_MISSING", detail: `数据源缺少列：${missing.join("、")}（不匹配相似列）` });
      if (dataDocument.status === "partial") limitations.push(`${spec.source!.path} 解析状态 partial（结果只覆盖已解析行）`);
    }
  }

  // 协议核对
  let selected: ParsedRecordBlock[] = [];
  let afterFilters: ParsedRecordBlock[] = [];
  const canCompute = gaps.length === 0;
  if (canCompute && spec.source !== undefined) {
    afterFilters = rows.filter((row) => (spec.filters ?? []).every((filter) => (cellValue(row, filter.column) ?? "") === filter.equals));
  }
  for (const assertion of spec.protocol.assertions) {
    if (assertion.kind === "source_manifest_sha256") {
      const opened = await open("protocol", assertion.manifest);
      if (opened === null) { protocolAssertions.push({ kind: assertion.kind, ok: false, detail: "来源清单不可用" }); continue; }
      const recorded = readJsonCell(opened.document, assertion.manifest.jsonPath);
      const ok = dataFile !== undefined && recorded === dataFile.hash;
      protocolAssertions.push({ kind: assertion.kind, ok, detail: `${assertion.manifest.path.split("/").pop()} ${assertion.manifest.jsonPath} = ${recorded?.slice(0, 12) ?? "（无）"}；数据源 ${dataFile?.hash.slice(0, 12) ?? "（不可用）"}` });
    } else if (assertion.kind === "json_equals") {
      const opened = await open("protocol", assertion.ref);
      if (opened === null) { protocolAssertions.push({ kind: assertion.kind, ok: false, detail: "协议依据不可用" }); continue; }
      const recorded = readJsonCell(opened.document, assertion.ref.jsonPath);
      const ok = recorded !== undefined && (typeof assertion.equals === "number" ? parseNumber(recorded) === assertion.equals : recorded === assertion.equals);
      protocolAssertions.push({ kind: assertion.kind, ok, detail: `${assertion.ref.path.split("/").pop()} ${assertion.ref.jsonPath} = ${recorded ?? "（无）"}（要求 ${assertion.equals}）` });
    } else {
      const allowed = new Set(assertion.values);
      const outside = afterFilters.filter((row) => !allowed.has(cellValue(row, assertion.column) ?? ""));
      protocolAssertions.push({ kind: assertion.kind, ok: canCompute && outside.length === 0, detail: canCompute ? `${assertion.column} 越界行 ${outside.length}${outside.length > 0 ? `（如 ${cellValue(outside[0]!, assertion.column) ?? "空"}，行 ${outside[0]!.provenance.row ?? "?"}）` : ""}` : "未核对（前置条件不成立）" });
    }
  }
  const protocolStatus: ClaimCheckResult["protocol"]["status"] = spec.protocol.assertions.length === 0
    ? "DECLARED_ONLY"
    : protocolAssertions.every((assertion) => assertion.ok) ? "VERIFIED_BY_SOURCE" : canCompute ? "MISMATCH" : "NOT_CHECKED";
  if (protocolStatus === "MISMATCH") gaps.push({ code: "PROTOCOL_MISMATCH", detail: `协议 ${spec.protocol.id} 核对不一致：${protocolAssertions.filter((assertion) => !assertion.ok).map((assertion) => assertion.detail).join("；")}` });
  if (protocolStatus === "DECLARED_ONLY") limitations.push(`协议 ${spec.protocol.id} 只由登记声明，未与数据内的协议声明核对`);

  // 计算
  let derivedValue: number | null = null;
  let rowStats: ClaimCheckResult["rows"] = spec.source !== undefined ? { total: rows.length, afterFilters: afterFilters.length, selected: 0 } : null;
  if (gaps.length === 0) {
    const param = (name: string): number => {
      const value = parameters[name];
      if (value === undefined) throw new MissingValueError(`参数 $${name} 不可用`);
      return value;
    };
    try {
      if (spec.calculation.aggregate === "scalar") {
        derivedValue = round(evaluate(valueExpr!, () => { throw new MissingValueError("scalar 不读数据列"); }, param));
      } else {
        const values: number[] = [];
        for (const row of afterFilters) {
          const column = (name: string): number => {
            const value = parseNumber(cellValue(row, name));
            if (value === null) throw new MissingValueError(`行 ${row.provenance.row ?? "?"} 的 ${name} 为空或非数值`);
            return value;
          };
          if (whereExpr !== undefined && evaluate(whereExpr, column, param) === 0) continue;
          selected.push(row);
          if (valueExpr !== undefined) values.push(evaluate(valueExpr, column, param));
        }
        rowStats = { total: rows.length, afterFilters: afterFilters.length, selected: selected.length };
        if (spec.calculation.aggregate === "count") derivedValue = selected.length;
        else if (values.length === 0) gaps.push({ code: "EMPTY_SELECTION", detail: "过滤后没有数据行，无法计算 sum / mean / min / max" });
        else {
          const aggregate = spec.calculation.aggregate;
          derivedValue = round(aggregate === "sum" ? values.reduce((a, b) => a + b, 0)
            : aggregate === "mean" ? values.reduce((a, b) => a + b, 0) / values.length
              : aggregate === "min" ? Math.min(...values) : Math.max(...values));
        }
      }
    } catch (error) {
      derivedValue = null;
      selected = [];
      gaps.push({ code: error instanceof MissingValueError ? "VALUE_MISSING" : "EXPRESSION_ERROR", detail: (error as Error).message });
    }
  }
  const evaluated = gaps.length === 0 && derivedValue !== null;
  const verdict: ClaimCheckVerdict = !evaluated
    ? "NOT_EVALUATED"
    : Math.abs(derivedValue! - spec.claim.value) <= tolerance + 1e-12 ? "CONSISTENT" : "CONTRADICTED";
  if (evaluated && tolerance > 0) limitations.push(`比较容差 ${tolerance}${spec.compare?.note !== undefined ? `（${spec.compare.note}）` : ""}`);
  limitations.push("数据由作者提供、哈希绑定；PaperTeam 只做确定性复算，未经外部独立核验");
  const authorization: ClaimCheckResult["evidence"]["authorization"] = sources.length === 0
    ? "UNKNOWN"
    : sources.some((entry) => entry.authorization === "UNAUTHORIZED") ? "UNAUTHORIZED" : sources.every((entry) => entry.authorization === "AUTHORIZED") ? "AUTHORIZED" : "UNKNOWN";
  return {
    id: spec.id,
    title: spec.title,
    materiality: spec.materiality,
    required: spec.required !== false,
    claimAnchor: { quote: spec.claim.quote, found: anchor !== null, file: anchor?.file ?? null, line: anchor?.line ?? null, manuscriptRevision: env.manuscript.revision, manuscriptSha256 },
    manuscriptValue: spec.claim.value,
    valueKind,
    protocol: { id: spec.protocol.id, status: protocolStatus, assertions: protocolAssertions },
    sources,
    filters: spec.filters ?? [],
    calculation: spec.calculation,
    parameters,
    rows: rowStats,
    derivedValue: evaluated ? derivedValue : null,
    verdict,
    gaps,
    evidence: {
      authorization,
      sourceAuthenticity: "AUTHOR_SUPPLIED_UNVERIFIED",
      hashBinding: spec.source === undefined ? (sources.length > 0 && gaps.every((gap) => gap.code !== "SOURCE_HASH_MISMATCH") ? "MATCH" : hashBinding) : hashBinding,
      derivation: evaluated ? "RECOMPUTED_BY_PAPERTEAM" : "NOT_RECOMPUTED",
      externalVerification: "NOT_EXTERNALLY_VERIFIED",
      level: evaluated ? "RECOMPUTED_FROM_AUTHOR_DATA" : "NOT_EVALUATED",
    },
    ...(spec.conditions !== undefined ? { conditions: spec.conditions } : {}),
    tolerance,
    limitations,
  };
}

// ---------------- 投影：Gate / prompt / finding ----------------

export function summarizeClaimChecksForGate(ledger: ClaimCheckLedger | null, experimentPackages: number): ClaimCheckGateSummary {
  const results = ledger?.results ?? [];
  return {
    registered: results.length + (ledger?.planError !== undefined && results.length === 0 ? 1 : 0),
    consistent: results.filter((result) => result.verdict === "CONSISTENT").length,
    contradicted: results.filter((result) => result.verdict === "CONTRADICTED").map((result) => ({
      id: result.id, materiality: result.materiality, manuscriptValue: result.manuscriptValue, derivedValue: result.derivedValue,
    })),
    notEvaluated: [
      ...(ledger?.planError !== undefined ? [{ id: "(plan)", reason: `PLAN_INVALID ${ledger.planError.slice(0, 120)}`, required: true }] : []),
      ...results.filter((result) => result.verdict === "NOT_EVALUATED").map((result) => ({
        id: result.id, reason: result.gaps.map((gap) => gap.code).join("+"), required: result.required,
      })),
    ],
    ledgerHash: ledger?.ledgerHash ?? "",
    experimentPackages,
  };
}

const VALUE_TEXT = (result: Pick<ClaimCheckResult, "valueKind">, value: number | null): string =>
  value === null ? "—" : result.valueKind === "boolean" ? (value !== 0 ? "成立" : "不成立") : String(value);

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** 单条复算结果的 prompt 行（作者稿件口径；不含原始数据行） */
export function renderClaimCheckLine(result: ClaimCheckResult): string {
  const data = result.sources.find((entry) => entry.role === "data");
  const params = Object.entries(result.parameters);
  const head = `- [CC-${result.id}] 论断「${normalizeAnchorText(result.claimAnchor.quote).slice(0, 160)}」（稿件值 ${VALUE_TEXT(result, result.manuscriptValue)}）`;
  if (result.verdict === "NOT_EVALUATED") {
    return `${head}：未能复算（${result.gaps.map((gap) => `${gap.code}：${gap.detail}`).join("；").slice(0, 300)}）——这只说明 PaperTeam 无法用现有数据核对，不得据此认定论文有误，也不得写成已核验`;
  }
  return [
    head,
    `：数据 ${data !== undefined ? `${fileName(data.path)}（sha256 ${data.fileHash?.slice(0, 12) ?? "?"}，作者提供·未经外部核验）` : "（仅参数）"}`,
    params.length > 0 ? `；参数 ${params.map(([name, value]) => `${name}=${value}`).join("、")}` : "",
    `；协议 ${result.protocol.id}（${result.protocol.status === "VERIFIED_BY_SOURCE" ? "与数据内声明核对一致" : "仅登记声明"}）`,
    result.filters.length > 0 ? `；筛选 ${result.filters.map((filter) => `${filter.column}=${filter.equals}`).join("、")}` : "",
    `；计算：${result.calculation.description}`,
    `；复算值 ${VALUE_TEXT(result, result.derivedValue)} → ${result.verdict === "CONSISTENT" ? "与稿件一致（CONSISTENT）" : "与稿件不一致（CONTRADICTED）"}`,
    result.conditions !== undefined ? `。适用条件：${result.conditions}` : "",
  ].join("");
}

/** 本单元（或整稿）相关的复算结果 → prompt 块；没有相关结果时返回空数组（prompt 逐字节不变） */
export function renderClaimCheckBlock(results: readonly ClaimCheckResult[]): string[] {
  if (results.length === 0) return [];
  return [
    "",
    "===== 实验论断复算（PaperTeam 依据作者实验数据确定性复算；只读参考）=====",
    "口径：以下结果由 PaperTeam 按预先登记的协议、过滤与计算，从作者提供并授权的实验文件（哈希绑定）复算，未经外部独立核验。",
    ...results.map(renderClaimCheckLine),
    "使用口径：CONTRADICTED 的论断应在 finding 中写明 [CC-编号]、数据出处、计算与复算值，严重度按该论断在论文中的作用判断；CONSISTENT 的论断不要再以「数值无法核对 / 与实验数据不符」报告（表述或口径问题仍可照常报告）；未能复算的论断只能写成「需作者补充数据 / 待核验」，不能断言论文有错。",
  ];
}

/** 论断原文落在给定文本（单元原文 / 整稿）中的复算结果 */
export function claimChecksInText(results: readonly ClaimCheckResult[], text: string): ClaimCheckResult[] {
  const normalized = normalizeAnchorText(text);
  return results.filter((result) => normalized.includes(normalizeAnchorText(result.claimAnchor.quote)));
}

/** CONTRADICTED → 确定性 finding（rootCauseKey=claim-check:<id>；Gate 规则 4d 计因，规则 5/6 去重） */
export function claimCheckFinding(result: ClaimCheckResult, section: string, ledgerHash: string): {
  category: "fact"; severity: "major" | "minor"; section: string; description: string; suggestedAction: string; reason: string;
  evidenceRequirement: "required"; blocking: false; rootCauseKey: string; quote: string; evidenceRef: string;
  claimCheck: { id: string; verdict: "CONTRADICTED"; manuscriptValue: number; derivedValue: number | null; ledgerHash: string; dataSha256: string | null };
} {
  const data = result.sources.find((entry) => entry.role === "data");
  return {
    category: "fact",
    severity: result.materiality === "core" ? "major" : "minor",
    section,
    description: `实验论断复算不一致（CC-${result.id}）：稿件称「${normalizeAnchorText(result.claimAnchor.quote).slice(0, 120)}」为 ${VALUE_TEXT(result, result.manuscriptValue)}，按登记口径（${result.calculation.description}${result.conditions !== undefined ? `；${result.conditions}` : ""}）由 ${data !== undefined ? `${fileName(data.path)}（sha256 ${data.fileHash?.slice(0, 12) ?? "?"}）` : "登记参数"}复算为 ${VALUE_TEXT(result, result.derivedValue)}。`,
    suggestedAction: "核对该论断的定义、计数口径与数据；以复算结果修正数值或明确定义差异（数据为作者提供，修改前请作者确认）。",
    reason: "PaperTeam 确定性复算（预先登记的协议 / 过滤 / 计算；数据哈希绑定，未经外部独立核验）",
    evidenceRequirement: "required",
    blocking: false,
    rootCauseKey: `claim-check:${result.id}`,
    quote: result.claimAnchor.quote,
    evidenceRef: `claim-check:${result.id}`,
    claimCheck: { id: result.id, verdict: "CONTRADICTED", manuscriptValue: result.manuscriptValue, derivedValue: result.derivedValue, ledgerHash, dataSha256: data?.fileHash ?? null },
  };
}
