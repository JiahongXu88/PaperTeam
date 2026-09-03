/**
 * 文件安全写入工具（M3.0）。
 *
 * checkpoint / project.json / evidence 等结构化状态都经过这里落盘：
 *   临时文件 → write + fsync + close → atomic rename
 * 进程在任意时刻中断都不会留下「半个 JSON」；rename 在同一目录内原子生效。
 * （目录级 fsync 在 Windows 上不可用，跳过；同一目录 rename 已足够安全。）
 */

import { open, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 原子写入文本文件（utf8）：tmp → fsync → rename */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}-${Date.now()}.tmp`);
  const handle = await open(tmpPath, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmpPath, filePath);
}

/** 原子写入 JSON（带换行，便于 diff 与人工检查） */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2) + "\n");
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
