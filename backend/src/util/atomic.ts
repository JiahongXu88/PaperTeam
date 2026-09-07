/**
 * 文件安全写入工具。
 *
 * checkpoint / project.json / evidence 等结构化状态都经过这里落盘：
 *   临时文件 → write + fsync + close → atomic rename
 * 进程在任意时刻中断都不会留下「半个 JSON」；rename 在同一目录内原子生效。
 * （目录级 fsync 在 Windows 上不可用，跳过；同一目录 rename 已足够安全。）
 *
 * Windows 上目标文件被杀毒软件 / 索引器短暂占用时 rename 会报 EPERM / EBUSY，
 * 这里做有限次退避重试，而不是把偶发占用当成写失败抛给业务层。
 */

import { open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const RENAME_RETRY_DELAYS_MS = [20, 60, 150, 400];

/** 原子写入文本文件（utf8）：tmp → fsync → rename；失败时清理临时文件 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}-${Date.now()}.tmp`);
  try {
    const handle = await open(tmpPath, "w");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

/** 原子写入 JSON（带换行，便于 diff 与人工检查） */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2) + "\n");
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      const delayMs = RENAME_RETRY_DELAYS_MS[attempt];
      if ((code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") || delayMs === undefined) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
