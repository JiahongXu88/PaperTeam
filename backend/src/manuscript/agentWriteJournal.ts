/**
 * M15 长程 A2：Agent 文件写入日志（workflow/agent-writes.jsonl）。
 *
 * 受控 write / edit 工具（runtime/pi/workspaceGuard.ts）每次成功写入 manuscript/ 后追加一行
 * {at, path, sha256}。日志位于 workflow/——Agent 文件工具对该目录不可读不可写，因此 Agent 无法抹掉
 * 自己的写入记录。review.snapshot 用它区分「Agent 写入但从未经编辑契约校验提交」与「非 Agent 的工作区改动」
 * （作者在磁盘上的编辑 / 服务端写入）：前者不得被快照吸收为正式修订。
 *
 * 信任边界（如实）：同一 OS 用户的其它进程可以直接改磁盘文件或本日志；本机制证明的是
 * 「经 PaperTeam Agent 工具的写入可识别」，不是「改动一定来自人类」。
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { ProjectStore } from "../project/ProjectStore.js";

export const AGENT_WRITE_JOURNAL_FILE = "agent-writes.jsonl";

export interface AgentWriteEntry {
  at: string;
  /** 相对 manuscript/ 的 POSIX 路径 */
  path: string;
  sha256: string;
}

export function sha256Text(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export class AgentWriteJournal {
  private readonly projects: ProjectStore;
  private readonly now: () => Date;

  constructor(options: { projects: ProjectStore; now?: () => Date }) {
    this.projects = options.projects;
    this.now = options.now ?? (() => new Date());
  }

  private journalPath(projectId: string): string {
    return join(this.projects.workflowDir(projectId), AGENT_WRITE_JOURNAL_FILE);
  }

  /** 记录一次 Agent 写入；路径不在 manuscript/ 下时忽略（写边界已由 workspaceGuard 保证）。 */
  async record(projectId: string, absPath: string, content: string): Promise<void> {
    const rel = relative(this.projects.manuscriptDir(projectId), absPath);
    if (rel === "" || rel.startsWith("..") || rel.includes(`..${sep}`)) return;
    const entry: AgentWriteEntry = {
      at: this.now().toISOString(),
      path: rel.split(sep).join("/"),
      sha256: sha256Text(Buffer.from(content, "utf-8")),
    };
    await mkdir(this.projects.workflowDir(projectId), { recursive: true });
    await appendFile(this.journalPath(projectId), `${JSON.stringify(entry)}\n`, "utf-8");
  }

  /** 读取全部记录；损坏行按「无法判定」抛错由调用方 fail closed。 */
  async list(projectId: string): Promise<AgentWriteEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.journalPath(projectId), "utf-8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return [];
      throw error;
    }
    const entries: AgentWriteEntry[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      const parsed = JSON.parse(line) as Partial<AgentWriteEntry>;
      if (typeof parsed.at !== "string" || typeof parsed.path !== "string" || typeof parsed.sha256 !== "string") {
        throw new Error("agent-writes.jsonl 记录结构无效");
      }
      entries.push({ at: parsed.at, path: parsed.path, sha256: parsed.sha256 });
    }
    return entries;
  }
}
