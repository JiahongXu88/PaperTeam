/**
 * M10.1.1 图片资产登记单测：PNG/JPG 签名 + 尺寸 + 资产复制；
 * 损坏 / 伪签名明确失败。只登记不理解（无 Vision / OCR）。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

import { afterAll, describe, expect, it } from "vitest";

import { DocumentParseFailedError } from "../../src/errors.js";
import { ImageAssetParser } from "../../src/ingestion/imageAsset.js";
import type { ParsedFigureBlock } from "../../src/ingestion/types.js";
import { makeJpeg, makePng } from "./binaryFixtures.js";

const PARSER = new ImageAssetParser();
const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function withTempDir(): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "img-")), "");
  tempDirs.push(dir);
  return dir;
}

describe("M10.1.1 ImageAssetParser（登记，不理解）", () => {
  it("PNG：签名 + 尺寸 + 资产复制到 figuresDir（quality=full）", async () => {
    const dir = await withTempDir();
    const png = makePng(320, 240);
    const sourcePath = join(dir, "figure.png");
    await writeFile(sourcePath, png);
    const extraction = await PARSER.parseFile(sourcePath, { figuresDir: join(dir, "figures") });
    expect(extraction.mimeType).toBe("image/png");
    expect(extraction.quality).toBe("full");
    const block = extraction.blocks[0] as ParsedFigureBlock;
    expect(block.type).toBe("figure");
    expect(block.width).toBe(320);
    expect(block.height).toBe(240);
    expect(block.assetName).toBe("img-001.png");
    const copied = await readFile(join(dir, "figures", "img-001.png"));
    expect(copied.equals(png)).toBe(true);
    // 登记不产生文本内容（不描述图片）
    expect((block as unknown as { text?: string }).text).toBeUndefined();
    expect((block as unknown as { caption?: string }).caption).toBeUndefined();
  });

  it("JPEG：签名 + 尺寸 + .jpg 资产扩展名", async () => {
    const dir = await withTempDir();
    const jpeg = makeJpeg(800, 600);
    const sourcePath = join(dir, "photo.jpg");
    await writeFile(sourcePath, jpeg);
    const extraction = await PARSER.parseFile(sourcePath, { figuresDir: join(dir, "figures") });
    expect(extraction.mimeType).toBe("image/jpeg");
    const block = extraction.blocks[0] as ParsedFigureBlock;
    expect(block.width).toBe(800);
    expect(block.height).toBe(600);
    expect(block.assetName).toBe("img-001.jpg");
  });

  it("内容签名与扩展名不符（.png 实为文本）→ 明确失败", async () => {
    await expect(
      PARSER.parseBuffer(Buffer.from("definitely not an image", "utf8"), "fake.png"),
    ).rejects.toThrow(DocumentParseFailedError);
    await expect(
      PARSER.parseBuffer(Buffer.from("definitely not an image", "utf8"), "fake.png"),
    ).rejects.toThrow(/签名/);
  });

  it("损坏图片（截断 PNG：IHDR 不完整）→ 登记成功但无尺寸 + partial + note", async () => {
    const png = makePng(64, 64);
    const truncated = png.subarray(0, 10); // 只有签名 + 2 字节
    const extraction = await PARSER.parseBuffer(truncated, "broken.png");
    expect(extraction.quality).toBe("partial");
    const block = extraction.blocks[0] as ParsedFigureBlock;
    expect(block.width).toBeUndefined();
    expect(block.height).toBeUndefined();
    expect(extraction.notes.some((note) => note.includes("尺寸不可读"))).toBe(true);
  });

  it("空文件（0 字节）→ 明确失败", async () => {
    await expect(PARSER.parseBuffer(Buffer.alloc(0), "empty.png")).rejects.toThrow(/0 字节/);
  });
});
