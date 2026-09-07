/**
 * 指纹工具：stage 复用与内容变更检测的统一 sha256 指纹。
 */

import { createHash } from "node:crypto";

/** 二进制内容 sha256（hex） */
export function sha256Hex(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * 结构化对象指纹：键排序后 JSON 序列化再哈希——同内容不同键序结果一致。
 * 用于 chunk / reference / claim 等业务对象的稳定指纹（stage 缓存判据）。
 */
export function fingerprintJson(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
