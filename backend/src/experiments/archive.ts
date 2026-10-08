import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { openPromise, type Entry, type ZipFile } from "yauzl";

import { BusinessError } from "../errors.js";

export const PACKAGE_LIMITS = {
  archiveBytes: 16 * 1024 * 1024,
  fileBytes: 20 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  entries: 200,
  depth: 8,
  ratio: 100,
} as const;

export interface ArchiveEntryInfo {
  path: string;
  size: number;
  compressedSize: number;
}

function unsafe(message: string): never {
  throw new BusinessError("EXPERIMENT_ARCHIVE_UNSAFE", message);
}

function safePath(entry: Entry): string {
  const name = entry.fileName;
  if (!name || name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[a-zA-Z]:/.test(name)) {
    unsafe("ZIP 包含绝对路径、盘符或非法分隔符");
  }
  const segments = name.replace(/\/$/, "").split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.trim() !== segment)) {
    unsafe("ZIP 包含路径穿越或非规范路径");
  }
  if (segments.length > PACKAGE_LIMITS.depth || name.length > 512) {
    unsafe("ZIP 目录层级或路径长度超过上限");
  }
  const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
  const directory = name.endsWith("/");
  if (unixType !== 0 && unixType !== 0o100000 && !(directory && unixType === 0o040000)) {
    unsafe("ZIP 包含符号链接或特殊文件");
  }
  if (entry.isEncrypted() || !entry.canDecodeFileData() || (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)) {
    unsafe("ZIP 包含加密文件或不支持的压缩方法");
  }
  return segments.join("/").normalize("NFC");
}

export async function hashArchive(filePath: string): Promise<{ hash: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    const data = chunk as Buffer;
    bytes += data.length;
    if (bytes > PACKAGE_LIMITS.archiveBytes) {
      throw new BusinessError("EXPERIMENT_ARCHIVE_LIMIT", "ZIP 超过 16 MiB 上限");
    }
    hash.update(data);
  }
  return { hash: hash.digest("hex"), bytes };
}

/** Central-directory pass first, then bounded one-file-at-a-time streams. No extraction to paths. */
export async function visitArchive(
  filePath: string,
  onFile?: (entry: ArchiveEntryInfo, data: Buffer) => Promise<void>,
): Promise<ArchiveEntryInfo[]> {
  let zip: ZipFile;
  try {
    zip = await openPromise(filePath, { lazyEntries: true, validateEntrySizes: true, autoClose: false });
  } catch {
    throw new BusinessError("EXPERIMENT_ARCHIVE_UNSAFE", "ZIP 中央目录损坏或格式不受支持");
  }
  const entries: ArchiveEntryInfo[] = [];
  const paths = new Set<string>();
  let total = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      zip.once("error", reject);
      zip.once("end", resolve);
      zip.on("entry", (entry: Entry) => {
        void (async () => {
          const path = safePath(entry);
          const key = path.toLocaleLowerCase("en-US").normalize("NFC");
          if (paths.has(key)) unsafe("ZIP 包含重复或 Unicode/大小写冲突路径");
          paths.add(key);
          if (entry.fileName.endsWith("/")) {
            zip.readEntry();
            return;
          }
          if (entries.length >= PACKAGE_LIMITS.entries) unsafe("ZIP 文件数量超过 200");
          if (entry.uncompressedSize > PACKAGE_LIMITS.fileBytes) unsafe("ZIP 单文件超过 20 MiB");
          total += entry.uncompressedSize;
          if (total > PACKAGE_LIMITS.totalBytes) unsafe("ZIP 解压总量超过 64 MiB");
          if (entry.uncompressedSize > 0 && entry.uncompressedSize / Math.max(1, entry.compressedSize) > PACKAGE_LIMITS.ratio) {
            unsafe("ZIP 压缩比超过 100:1");
          }
          const info = { path, size: entry.uncompressedSize, compressedSize: entry.compressedSize };
          entries.push(info);
          if (onFile !== undefined) {
            const stream = await zip.openReadStreamPromise(entry);
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of stream) {
              const data = chunk as Buffer;
              size += data.length;
              if (size > PACKAGE_LIMITS.fileBytes || size > entry.uncompressedSize) unsafe("ZIP 文件流超过声明大小");
              chunks.push(data);
            }
            if (size !== entry.uncompressedSize) unsafe("ZIP 文件流大小不一致");
            await onFile(info, Buffer.concat(chunks, size));
          }
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    throw new BusinessError("EXPERIMENT_ARCHIVE_UNSAFE", "ZIP 文件损坏或读取失败");
  } finally {
    zip.close();
  }
  if (entries.length === 0) unsafe("ZIP 不含文件");
  return entries;
}

export function sourceNameFor(path: string, hash: string): string {
  const original = basename(path);
  const extension = extname(original).toLowerCase();
  const safeStem = original.slice(0, -extension.length).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 55) || "file";
  return `${safeStem}_${hash.slice(0, 8)}${extension}`;
}
