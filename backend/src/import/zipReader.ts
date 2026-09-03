/**
 * 极简 ZIP 读取器（M3.2，零第三方依赖）。
 *
 * 只支持 ZIP 常见的 stored（0）与 deflate（8）条目，按 Local File Header
 * 顺序读取。安全约束（防 Zip Slip）由 readZipEntries 强制：
 *   - 拒绝绝对路径、反斜杠、`..` 段
 *   - 拒绝目录穿越后仍越出的任何路径
 *   - 单文件 / 总大小 / 条目数上限
 */

import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export interface ZipLimits {
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 500,
  maxFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
};

const LOCAL_HEADER_SIGNATURE = 0x04034b50;

/**
 * 解析 ZIP 并返回安全条目。
 * @throws Error 当输入不是 ZIP、条目非法（穿越 / 超限）或数据损坏时
 */
export function readZipEntries(buffer: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntry[] {
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error("不是合法的 ZIP 归档（缺少 local file header）");
  }
  const entries: ZipEntry[] = [];
  let offset = 0;
  let totalBytes = 0;

  while (offset + 4 <= buffer.length) {
    // 数据描述符 / 中央目录等非 local header 结构到达即停止
    if (buffer.readUInt32LE(offset) !== LOCAL_HEADER_SIGNATURE) {
      break;
    }
    if (offset + 30 > buffer.length) {
      throw new Error("ZIP local header 不完整");
    }
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) {
      throw new Error("ZIP 条目数据不完整（归档损坏或截断）");
    }
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const safeName = requireSafeEntryName(name);
    const rawData = buffer.subarray(dataStart, dataEnd);

    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(rawData);
    } else if (method === 8) {
      try {
        data = inflateRawSync(rawData);
      } catch {
        throw new Error(`ZIP 条目 "${safeName}" 解压失败（deflate 数据损坏）`);
      }
    } else {
      throw new Error(`ZIP 条目 "${safeName}" 使用不支持的压缩方法（${method}）`);
    }

    if (data.length !== uncompressedSize) {
      // 尺寸不符仍可用（部分打包器写 0）；只做防御性大小校验
      if (uncompressedSize !== 0 && data.length !== uncompressedSize) {
        throw new Error(`ZIP 条目 "${safeName}" 尺寸校验失败`);
      }
    }
    if (data.length > limits.maxFileBytes) {
      throw new Error(`ZIP 条目 "${safeName}" 超过单文件上限（${limits.maxFileBytes} 字节）`);
    }
    totalBytes += data.length;
    if (totalBytes > limits.maxTotalBytes) {
      throw new Error(`ZIP 解压总大小超过上限（${limits.maxTotalBytes} 字节）`);
    }
    entries.push({ name: safeName, data });
    if (entries.length > limits.maxEntries) {
      throw new Error(`ZIP 条目数超过上限（${limits.maxEntries}）`);
    }
    offset = dataEnd;
  }

  if (entries.length === 0) {
    throw new Error("ZIP 归档中没有可读取的文件条目");
  }
  return entries;
}

/** 条目名安全化：拒绝绝对路径 / 反斜杠 / 穿越；返回 POSIX 风格相对路径 */
export function requireSafeEntryName(name: string): string {
  if (name === "") {
    throw new Error("ZIP 条目名为空");
  }
  if (name.includes("\\")) {
    throw new Error(`ZIP 条目名含反斜杠："${name}"`);
  }
  if (name.startsWith("/")) {
    throw new Error(`ZIP 条目名是绝对路径："${name}"`);
  }
  if (/^[a-zA-Z]:/.test(name)) {
    throw new Error(`ZIP 条目名含盘符："${name}"`);
  }
  const segments = name.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`ZIP 条目名包含路径穿越："${name}"`);
  }
  if (segments.length === 0 || (segments.length === 1 && segments[0] === "")) {
    throw new Error(`ZIP 条目名非法："${name}"`);
  }
  const normalized = segments.join("/");
  // 目录条目（以 / 结尾）跳过由调用方处理
  if (normalized.length > 300) {
    throw new Error("ZIP 条目名过长");
  }
  return normalized;
}
