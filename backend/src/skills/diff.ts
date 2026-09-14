/**
 * Skill 更新预览用的有界 diff（M5.3）：文件级变化摘要 + SKILL.md 行级 diff。
 * 纯函数、确定性、无外部依赖；行级 diff 用 LCS（skill 文本 ≤ 数千行，O(n·m) 可接受，
 * 超界直接降级为「全部替换」摘要而不是失败）。
 */

import type { SkillFileChange, SkillLineDiff } from "./types.js";

export interface FileSnapshot {
  /** 相对路径（POSIX 分隔） */
  path: string;
  bytes: number;
  sha256: string;
}

/** 两个文件快照集合 → 文件级变化（按路径排序） */
export function diffFileSets(current: FileSnapshot[], candidate: FileSnapshot[]): SkillFileChange[] {
  const currentMap = new Map(current.map((file) => [file.path, file]));
  const candidateMap = new Map(candidate.map((file) => [file.path, file]));
  const paths = Array.from(new Set([...currentMap.keys(), ...candidateMap.keys()])).sort();
  return paths.map((path) => {
    const before = currentMap.get(path);
    const after = candidateMap.get(path);
    if (before === undefined && after !== undefined) {
      return { path, status: "added", candidateBytes: after.bytes };
    }
    if (before !== undefined && after === undefined) {
      return { path, status: "removed", currentBytes: before.bytes };
    }
    const status = before!.sha256 === after!.sha256 ? "unchanged" : "modified";
    return { path, status, currentBytes: before!.bytes, candidateBytes: after!.bytes };
  });
}

const MAX_LCS_CELLS = 4_000_000; // 2000 × 2000 行
const MAX_HUNK_LINES = 200;

/** 行级 diff（有界样本）；行尾归一化后比较 */
export function diffLines(currentText: string, candidateText: string): SkillLineDiff {
  const a = currentText.replace(/\r\n/g, "\n").split("\n");
  const b = candidateText.replace(/\r\n/g, "\n").split("\n");
  if (a.length * b.length > MAX_LCS_CELLS) {
    // 超界降级：不做 LCS，按整体替换汇报（仍给出计数与有界样本）
    const hunks = [
      ...a.slice(0, MAX_HUNK_LINES / 2).map((line) => `- ${line}`),
      ...b.slice(0, MAX_HUNK_LINES / 2).map((line) => `+ ${line}`),
    ];
    return { added: b.length, removed: a.length, hunks, truncated: true };
  }
  // LCS 长度表（后缀形式），随后回溯生成编辑脚本
  const n = a.length;
  const m = b.length;
  const table: Uint32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i += 1) {
    table[i] = new Uint32Array(m + 1);
  }
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = table[i]!;
    const next = table[i + 1]!;
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const hunks: string[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  const push = (line: string): void => {
    if (hunks.length < MAX_HUNK_LINES) {
      hunks.push(line);
    }
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      removed += 1;
      push(`- ${a[i]}`);
      i += 1;
    } else {
      added += 1;
      push(`+ ${b[j]}`);
      j += 1;
    }
  }
  while (i < n) {
    removed += 1;
    push(`- ${a[i]}`);
    i += 1;
  }
  while (j < m) {
    added += 1;
    push(`+ ${b[j]}`);
    j += 1;
  }
  return { added, removed, hunks, truncated: added + removed > hunks.length };
}
