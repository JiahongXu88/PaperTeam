/**
 * M13.5.4 Agent 工作区隔离（Workspace Guard）。
 *
 * 背景（真实 run w-b5596d231aaa 暴露）：Agent 会话的 cwd 是整个项目目录，
 * 内置 read / ls / grep / find 工具对路径没有任何限制。Writer 用 ls + read
 * 直接读到了实验包的原始文件（sources/papers/S0xx-overall_metrics.csv、
 * A2E_VALIDATION_REPORT.md）与 experiments/<pkg>/manifest.json，把作者
 * **尚未确认 / 尚未授权**的 Confirmation13 / Full38 数值写进了实验章节——
 * M13.5 的范围级授权（workflowContext 零注入）在文件工具层被整体绕过。
 *
 * 设计（不建第二套工具系统）：Pi 的内置文件工具工厂接受 `operations`
 * 注入，且 customTools 同名会覆盖内置注册（agent-session `_refreshToolRegistry`
 * 后写入）。这里用官方工厂 + 受控 operations 生成同名工具，按角色白名单注入
 * 为 customTools：
 *   - 读边界：只允许项目目录 + 只读附加根（skill 快照目录）；项目内
 *     `experiments/`、`workflow/` 整体不可见；`sources/{papers,parsed,chunks}`
 *     下属于 EXPERIMENT_PACKAGE 来源的条目不可见（来源清单解析失败时整个
 *     sources/ 不可见——fail closed）。
 *   - 写边界：write / edit 只允许 `manuscript/` 下（稿件是 Writer 的唯一产物）。
 *   - ls 过滤隐藏条目；find 用自实现的受控 glob；grep 自实现（Pi 内置 grep
 *     走 ripgrep 子进程，无法经 operations 拦截文件读取）。
 *
 * 授权数据的合法入口不变：作者确认 + 授权的观测经
 * ExperimentPackageService.workflowContext 进入 Researcher / Writer prompt。
 */
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  createEditToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface WorkspaceGuardPolicyInput {
  /** 会话工作目录 = 项目目录（projectsRoot/<projectId>） */
  projectDir: string;
  /** 只读附加根（skill 版本快照目录等；绝对路径） */
  readOnlyRoots?: string[];
  /** EXPERIMENT_PACKAGE 来源的 sourceId（sources/{papers,parsed,chunks}/<id>[-.]… 受保护） */
  protectedSourceIds: string[];
  /** 来源清单不可用时置 true：整个 sources/ 受保护（fail closed） */
  protectAllSources?: boolean;
  /** 可写子目录（相对 projectDir；缺省 ["manuscript"]） */
  writableDirs?: string[];
  /** 受保护子目录（相对 projectDir；缺省 ["experiments", "workflow"]） */
  protectedDirs?: string[];
}

export interface WorkspaceGuardPolicy {
  readonly projectDir: string;
  canRead(absPath: string): boolean;
  canWrite(absPath: string): boolean;
  /** 列目录时应隐藏的条目（= 不可读） */
  isHiddenEntry(absDir: string, entryName: string): boolean;
  describeDenial(absPath: string, mode: "read" | "write"): string;
}

export const DEFAULT_PROTECTED_DIRS = ["experiments", "workflow"] as const;
export const DEFAULT_WRITABLE_DIRS = ["manuscript"] as const;
const PROTECTED_SOURCE_SUBDIRS = new Set(["papers", "parsed", "chunks"]);
/** sources/{papers,parsed,chunks} 条目名 → sourceId（win32 路径已小写化，故大小写不敏感） */
const SOURCE_ENTRY_ID = /^(s\d+)(?:[-.]|$)/i;

const CASE_INSENSITIVE = process.platform === "win32";
function norm(path: string): string {
  const resolved = resolve(path);
  return CASE_INSENSITIVE ? resolved.toLowerCase() : resolved;
}
function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

export function createWorkspaceGuardPolicy(input: WorkspaceGuardPolicyInput): WorkspaceGuardPolicy {
  const projectDir = norm(input.projectDir);
  const readOnlyRoots = (input.readOnlyRoots ?? []).map(norm);
  const protectedIds = new Set(input.protectedSourceIds.map((id) => (CASE_INSENSITIVE ? id.toLowerCase() : id)));
  const protectAllSources = input.protectAllSources === true;
  const writableDirs = new Set((input.writableDirs ?? [...DEFAULT_WRITABLE_DIRS]).map((dir) => (CASE_INSENSITIVE ? dir.toLowerCase() : dir)));
  const protectedDirs = new Set((input.protectedDirs ?? [...DEFAULT_PROTECTED_DIRS]).map((dir) => (CASE_INSENSITIVE ? dir.toLowerCase() : dir)));

  /** 项目内相对路径段（已归一化）；不在项目内返回 null */
  const segmentsOf = (absPath: string): string[] | null => {
    const path = norm(absPath);
    if (!isInside(projectDir, path)) return null;
    const rel = relative(projectDir, path);
    return rel === "" ? [] : rel.split(sep);
  };

  const isProtectedInProject = (segments: string[]): boolean => {
    const first = segments[0];
    if (first === undefined) return false;
    if (protectedDirs.has(first)) return true;
    if (first === "sources") {
      if (protectAllSources) return true;
      const sub = segments[1];
      const entry = segments[2];
      if (sub !== undefined && PROTECTED_SOURCE_SUBDIRS.has(sub) && entry !== undefined) {
        const match = SOURCE_ENTRY_ID.exec(entry);
        if (match !== null && protectedIds.has(CASE_INSENSITIVE ? match[1]!.toLowerCase() : match[1]!)) return true;
      }
    }
    return false;
  };

  const canRead = (absPath: string): boolean => {
    const segments = segmentsOf(absPath);
    if (segments !== null) return !isProtectedInProject(segments);
    const path = norm(absPath);
    return readOnlyRoots.some((root) => isInside(root, path));
  };

  const canWrite = (absPath: string): boolean => {
    const segments = segmentsOf(absPath);
    if (segments === null) return false;
    const first = segments[0];
    if (first === undefined || !writableDirs.has(first)) return false;
    return !isProtectedInProject(segments);
  };

  const describe = (absPath: string): string => {
    const path = norm(absPath);
    return isInside(projectDir, path) ? relative(projectDir, path).split(sep).join("/") || "." : basename(absPath);
  };

  return {
    projectDir: input.projectDir,
    canRead,
    canWrite,
    isHiddenEntry: (absDir, entryName) => !canRead(join(absDir, entryName)),
    describeDenial: (absPath, mode) =>
      mode === "read"
        ? `路径受 PaperTeam 工作区隔离保护，Agent 不可读取：${describe(absPath)}。实验原始数据包（experiments/）、运行状态（workflow/）与实验包来源文件只能经作者确认并授权的结构化实验上下文进入写作；项目目录之外的文件一律不可访问。`
        : `Agent 只能写入 manuscript/ 下的稿件文件，不能写入：${describe(absPath)}。`,
  };
}

// ---------------------------------------------------------------------------
// 受控工具
// ---------------------------------------------------------------------------

export interface WorkspaceGuardToolsOptions {
  /** 会话 cwd（工具路径解析基准） */
  cwd: string;
  /** 需要生成的工具名（按角色白名单；未知名字忽略） */
  toolNames: readonly string[];
}

const GUARDED_TOOL_NAMES = ["read", "ls", "find", "grep", "write", "edit"] as const;
export type GuardedToolName = (typeof GUARDED_TOOL_NAMES)[number];

function denyRead(policy: WorkspaceGuardPolicy, absPath: string): never {
  throw new Error(policy.describeDenial(absPath, "read"));
}
function denyWrite(policy: WorkspaceGuardPolicy, absPath: string): never {
  throw new Error(policy.describeDenial(absPath, "write"));
}
async function pathExists(absPath: string): Promise<boolean> {
  try {
    await access(absPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** 极简 glob → RegExp（支持 ** / * / ? / {a,b}；按 posix 相对路径匹配） */
export function globToRegExp(pattern: string): RegExp {
  let out = "^";
  let i = 0;
  const specials = new Set([".", "+", "^", "$", "(", ")", "|", "[", "]", "\\"]);
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      out += "[^/]";
      i += 1;
    } else if (ch === "{") {
      const close = pattern.indexOf("}", i);
      if (close === -1) {
        out += "\\{";
        i += 1;
      } else {
        const alternatives = pattern
          .slice(i + 1, close)
          .split(",")
          .map((alt) => alt.replace(/[.+^$()|[\]\\*?{}]/g, (c) => `\\${c}`));
        out += `(?:${alternatives.join("|")})`;
        i = close + 1;
      }
    } else {
      out += specials.has(ch) ? `\\${ch}` : ch;
      i += 1;
    }
  }
  return new RegExp(out + "$");
}

const SKIP_DIR_NAMES = new Set(["node_modules", ".git"]);

/** 受控深度遍历：只进入可读目录，跳过隐藏条目；返回绝对路径（文件） */
async function walkReadable(policy: WorkspaceGuardPolicy, rootDir: string, limit: number, signal?: AbortSignal): Promise<string[]> {
  const files: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0 && files.length < limit) {
    if (signal?.aborted) break;
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    entries.sort();
    for (const name of entries) {
      if (SKIP_DIR_NAMES.has(name) || policy.isHiddenEntry(dir, name)) continue;
      const full = join(dir, name);
      let info;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) stack.push(full);
      else if (info.isFile()) {
        files.push(full);
        if (files.length >= limit) break;
      }
    }
  }
  return files;
}

const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024;
const GREP_DEFAULT_LIMIT = 100;
const GREP_MAX_OUTPUT_BYTES = 50 * 1024;
const GREP_MAX_LINE_LENGTH = 500;
const GREP_WALK_LIMIT = 5000;

function looksBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, Math.min(buffer.length, 8192));
  return probe.includes(0);
}

function createGuardedGrepTool(policy: WorkspaceGuardPolicy, cwd: string): ToolDefinition {
  return defineTool({
    name: "grep",
    label: "Search file contents",
    description:
      "Search file contents for a pattern within the project workspace. Returns matching lines as path:line: text (paths relative to the search root). " +
      `Output is truncated to ${GREP_DEFAULT_LIMIT} matches or ${GREP_MAX_OUTPUT_BYTES / 1024}KB; long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars. ` +
      "Protected material (experiments/, workflow/, experiment-package sources) is never searched.",
    promptSnippet: "Search file contents for patterns",
    parameters: Type.Object({
      pattern: Type.String({ description: "Regex pattern to search for (literal=true to match as plain text)" }),
      path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
      glob: Type.Optional(Type.String({ description: "Glob filter for file names, e.g. *.tex" })),
      ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
      literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal text (default: false)" })),
      context: Type.Optional(Type.Number({ description: "Lines of context around each match (default: 0)" })),
      limit: Type.Optional(Type.Number({ description: `Maximum matches (default: ${GREP_DEFAULT_LIMIT})` })),
    }),
    execute: async (_toolCallId, params, signal) => {
      const searchPath = resolve(cwd, params.path ?? ".");
      if (!policy.canRead(searchPath) || !(await pathExists(searchPath))) {
        throw new Error(`Path not found: ${params.path ?? "."}`);
      }
      const source = params.literal === true ? params.pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`) : params.pattern;
      let regex: RegExp;
      try {
        regex = new RegExp(source, params.ignoreCase === true ? "i" : "");
      } catch (error) {
        throw new Error(`Invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`);
      }
      const globRe = params.glob !== undefined && params.glob.trim() !== "" ? globToRegExp(params.glob.trim()) : undefined;
      const limit = Math.max(1, params.limit ?? GREP_DEFAULT_LIMIT);
      const contextLines = params.context !== undefined && params.context > 0 ? Math.floor(params.context) : 0;
      const info = await stat(searchPath);
      const files = info.isDirectory() ? await walkReadable(policy, searchPath, GREP_WALK_LIMIT, signal) : [searchPath];
      const lines: string[] = [];
      let matches = 0;
      let bytes = 0;
      let truncated = false;
      for (const file of files) {
        if (signal?.aborted || matches >= limit || truncated) break;
        const rel = info.isDirectory() ? relative(searchPath, file).split(sep).join("/") : basename(file);
        if (globRe !== undefined && !globRe.test(rel) && !globRe.test(basename(file))) continue;
        let buffer: Buffer;
        try {
          const fileInfo = await stat(file);
          if (fileInfo.size > GREP_MAX_FILE_BYTES) continue;
          buffer = await readFile(file);
        } catch {
          continue;
        }
        if (looksBinary(buffer)) continue;
        const text = buffer.toString("utf-8").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        for (let index = 0; index < text.length; index += 1) {
          if (!regex.test(text[index]!)) continue;
          matches += 1;
          const from = Math.max(0, index - contextLines);
          const to = Math.min(text.length - 1, index + contextLines);
          for (let k = from; k <= to; k += 1) {
            const marker = k === index ? ":" : "-";
            const content = text[k]!.length > GREP_MAX_LINE_LENGTH ? `${text[k]!.slice(0, GREP_MAX_LINE_LENGTH)}…` : text[k]!;
            const line = `${rel}${marker}${k + 1}${marker} ${content}`;
            bytes += Buffer.byteLength(line) + 1;
            if (bytes > GREP_MAX_OUTPUT_BYTES) {
              truncated = true;
              break;
            }
            lines.push(line);
          }
          if (truncated || matches >= limit) break;
        }
      }
      const footer = truncated
        ? [`[output truncated at ${GREP_MAX_OUTPUT_BYTES / 1024}KB]`]
        : matches >= limit
          ? [`[match limit ${limit} reached]`]
          : [];
      return {
        content: [{ type: "text", text: lines.length === 0 ? "No matches found" : [...lines, ...footer].join("\n") }],
        details: { matches, truncated },
      };
    },
  });
}

/** 生成受控文件工具（同名覆盖 Pi 内置工具；只生成 toolNames 中列出的） */
export function createWorkspaceGuardTools(policy: WorkspaceGuardPolicy, options: WorkspaceGuardToolsOptions): ToolDefinition[] {
  const wanted = new Set(options.toolNames);
  const cwd = resolve(options.cwd);
  const tools: ToolDefinition[] = [];
  const assertRead = (absPath: string): void => {
    if (!policy.canRead(absPath)) denyRead(policy, absPath);
  };
  const assertWrite = (absPath: string): void => {
    if (!policy.canWrite(absPath)) denyWrite(policy, absPath);
  };

  if (wanted.has("read")) {
    tools.push(
      createReadToolDefinition(cwd, {
        operations: {
          access: async (absPath) => {
            assertRead(absPath);
            await access(absPath, constants.R_OK);
          },
          readFile: async (absPath) => {
            assertRead(absPath);
            return readFile(absPath);
          },
        },
      }) as ToolDefinition,
    );
  }
  if (wanted.has("ls")) {
    tools.push(
      createLsToolDefinition(cwd, {
        operations: {
          exists: async (absPath) => policy.canRead(absPath) && (await pathExists(absPath)),
          stat: async (absPath) => {
            assertRead(absPath);
            return stat(absPath);
          },
          readdir: async (absPath) => {
            assertRead(absPath);
            return (await readdir(absPath)).filter((name) => !policy.isHiddenEntry(absPath, name));
          },
        },
      }) as ToolDefinition,
    );
  }
  if (wanted.has("find")) {
    tools.push(
      createFindToolDefinition(cwd, {
        operations: {
          exists: async (absPath) => policy.canRead(absPath) && (await pathExists(absPath)),
          glob: async (pattern, searchRoot, { ignore, limit }) => {
            assertRead(searchRoot);
            const matcher = globToRegExp(pattern);
            const ignores = ignore.map(globToRegExp);
            const files = await walkReadable(policy, searchRoot, GREP_WALK_LIMIT);
            const results: string[] = [];
            for (const file of files) {
              const rel = relative(searchRoot, file).split(sep).join("/");
              if (ignores.some((re) => re.test(rel))) continue;
              if (matcher.test(rel) || matcher.test(basename(file))) {
                results.push(file);
                if (results.length >= limit) break;
              }
            }
            return results;
          },
        },
      }) as ToolDefinition,
    );
  }
  if (wanted.has("grep")) {
    tools.push(createGuardedGrepTool(policy, cwd));
  }
  if (wanted.has("write")) {
    tools.push(
      createWriteToolDefinition(cwd, {
        operations: {
          mkdir: async (dir) => {
            if (!policy.canWrite(join(dir, "x"))) denyWrite(policy, dir);
            await mkdir(dir, { recursive: true });
          },
          writeFile: async (absPath, content) => {
            assertWrite(absPath);
            await writeFile(absPath, content, "utf-8");
          },
        },
      }) as ToolDefinition,
    );
  }
  if (wanted.has("edit")) {
    tools.push(
      createEditToolDefinition(cwd, {
        operations: {
          access: async (absPath) => {
            assertWrite(absPath);
            await access(absPath, constants.R_OK | constants.W_OK);
          },
          readFile: async (absPath) => {
            assertWrite(absPath);
            return readFile(absPath);
          },
          writeFile: async (absPath, content) => {
            assertWrite(absPath);
            await mkdir(dirname(absPath), { recursive: true });
            await writeFile(absPath, content, "utf-8");
          },
        },
      }) as ToolDefinition,
    );
  }
  return tools;
}

export function isGuardedToolName(name: string): name is GuardedToolName {
  return (GUARDED_TOOL_NAMES as readonly string[]).includes(name);
}
