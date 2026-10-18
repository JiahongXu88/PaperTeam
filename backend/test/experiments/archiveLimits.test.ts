/**
 * M14.9 实验 ZIP 上限：文件数 200 → 2000、目录层级 8 → 16（真实 R5.1 审查包 916 文件、最深 13 级）。
 * 边界两侧逐一验证，并锁定其余大小 / 压缩比 / 路径长度上限不变。全部内容为合成测试输入。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";

import { afterAll, describe, expect, it } from "vitest";

import { PACKAGE_LIMITS, visitArchive } from "../../src/experiments/archive.js";

const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });

/** 极简 store-method ZIP 写入（无压缩；archive.ts 接受 method 0） */
function buildStoreZip(entries: Array<{ path: string; data: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const data = Buffer.from(entry.data, "utf8");
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

async function zipFile(entries: Array<{ path: string; data: string }>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pt-archive-limits-"));
  dirs.push(dir);
  const file = join(dir, "package.zip");
  await writeFile(file, buildStoreZip(entries));
  return file;
}

const files = (count: number) => Array.from({ length: count }, (_, index) => ({ path: `files/f${index}.txt`, data: "SYNTHETIC" }));
const nested = (segments: number) => ({ path: [...Array.from({ length: segments - 1 }, (_, index) => `d${index}`), "results.csv"].join("/"), data: "metric,value\ntest,1\n" });

describe("experiment archive limits (M14.9)", () => {
  it("accepts exactly 2000 files and rejects 2001 with the configured limit in the message", async () => {
    expect(PACKAGE_LIMITS.entries).toBe(2000);
    expect(await visitArchive(await zipFile(files(2000)), async () => {})).toHaveLength(2000);
    await expect(visitArchive(await zipFile(files(2001)))).rejects.toMatchObject({
      code: "EXPERIMENT_ARCHIVE_UNSAFE", message: "ZIP 文件数量超过 2000",
    });
  });

  it("accepts 16 path segments and rejects 17 with a diagnosable depth message", async () => {
    expect(PACKAGE_LIMITS.depth).toBe(16);
    expect(await visitArchive(await zipFile([nested(16)]))).toHaveLength(1);
    await expect(visitArchive(await zipFile([nested(17)]))).rejects.toMatchObject({
      code: "EXPERIMENT_ARCHIVE_UNSAFE", message: expect.stringContaining("ZIP 目录层级超过上限（17 > 16）"),
    });
  });

  it("keeps the path-length guard separate from depth", async () => {
    const long = { path: `a/${"x".repeat(520)}.csv`, data: "metric,value\ntest,1\n" };
    await expect(visitArchive(await zipFile([long]))).rejects.toMatchObject({
      code: "EXPERIMENT_ARCHIVE_UNSAFE", message: expect.stringContaining("ZIP 路径长度超过上限"),
    });
  });

  it("leaves byte, total, ratio and path-length limits unchanged", () => {
    expect(PACKAGE_LIMITS).toMatchObject({
      archiveBytes: 16 * 1024 * 1024, fileBytes: 20 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, ratio: 100, pathLength: 512,
    });
  });
});
