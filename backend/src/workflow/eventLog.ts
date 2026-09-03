/**
 * Domain Event JSONL 日志（M3.0）。
 *
 * 每个 run 一份 events.jsonl（追加写）。读取时容忍损坏行：
 * 损坏行计入 skipped、不中断（日志是进度记录，不是判定依据）。
 * 事件是 PaperTeam Domain Event（workflow.* / stage.* / quality_gate.*），
 * 不写入 OpenClaw 的 tool call / token / 协议帧（分层见 ARCHITECTURE §2.3）。
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { WorkflowDomainEvent } from "./types.js";

export interface EventLogReadResult {
  events: WorkflowDomainEvent[];
  /** 损坏 / 无法解析的行数 */
  skippedLines: number;
  /** 解析出的最大 seq（空文件为 0） */
  maxSeq: number;
}

/** 追加一条事件（单行 JSON） */
export async function appendEventLine(eventsPath: string, event: WorkflowDomainEvent): Promise<void> {
  await mkdir(dirname(eventsPath), { recursive: true });
  await appendFile(eventsPath, JSON.stringify(event) + "\n", "utf8");
}

/** 读取全部事件（容忍损坏行；保持文件顺序） */
export async function readEventLog(eventsPath: string): Promise<EventLogReadResult> {
  let raw: string;
  try {
    raw = await readFile(eventsPath, "utf8");
  } catch {
    return { events: [], skippedLines: 0, maxSeq: 0 };
  }
  const events: WorkflowDomainEvent[] = [];
  let skippedLines = 0;
  let maxSeq = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as WorkflowDomainEvent;
      if (typeof parsed === "object" && parsed !== null && typeof parsed.seq === "number") {
        events.push(parsed);
        maxSeq = Math.max(maxSeq, parsed.seq);
        continue;
      }
      skippedLines += 1;
    } catch {
      skippedLines += 1;
    }
  }
  return { events, skippedLines, maxSeq };
}
