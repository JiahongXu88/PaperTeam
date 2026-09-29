/**
 * 图片资产登记 parser（M10.1.1）：PNG / JPG / JPEG → DocumentExtraction。
 *
 * 只登记，不理解的纪律：无 Vision、无 OCR、无图片描述、不自动产
 * Evidence（内容理解属 M10.2）。登记内容 = 内容签名 + 尺寸（header 可读
 * 时）+ 资产落位（复制到 sources/figures/<sourceId>/，与 docling 抽图
 * 同目录同语义）；签名与扩展名不符 → 明确失败，不信文件名。
 */

import { copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { DocumentParseFailedError } from "../errors.js";
import { imageDimensions, imageSignature } from "./imageHeaders.js";
import type {
  DocumentExtraction,
  DocumentParseOptions,
  DocumentParser,
  ParsedFigureBlock,
} from "./types.js";

export class ImageAssetParser implements DocumentParser {
  readonly id = "image";

  async parseFile(absolutePath: string, options?: DocumentParseOptions): Promise<DocumentExtraction> {
    let buffer: Buffer;
    try {
      buffer = await readFile(absolutePath);
    } catch (error) {
      throw new DocumentParseFailedError(
        `无法读取文件：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.parseBuffer(buffer, basename(absolutePath), options?.figuresDir, absolutePath);
  }

  /**
   * @param sourcePath 原始文件绝对路径（figuresDir 提供时复制为登记资产）
   */
  async parseBuffer(
    buffer: Buffer,
    fileName: string,
    figuresDir?: string,
    sourcePath?: string,
  ): Promise<DocumentExtraction> {
    if (buffer.byteLength === 0) {
      throw new DocumentParseFailedError("图片文件为空（0 字节）");
    }
    const signature = imageSignature(buffer);
    if (signature === null) {
      throw new DocumentParseFailedError(
        "图片内容签名与扩展名不符（非 PNG/JPEG 或文件损坏）",
      );
    }
    const notes: string[] = [];
    const dimensions = imageDimensions(buffer, signature);
    if (dimensions === null) {
      notes.push("图片尺寸不可读（头部损坏或非标准结构）——已登记，无 width/height");
    }
    const extension = signature === "image/png" ? ".png" : ".jpg";
    let assetName: string | undefined;
    if (figuresDir !== undefined && sourcePath !== undefined) {
      try {
        await mkdir(figuresDir, { recursive: true });
        assetName = `img-001${extension}`;
        await copyFile(sourcePath, join(figuresDir, assetName));
      } catch (error) {
        // 资产复制失败不吞登记：块照常产出（无 assetName），note 如实记录
        assetName = undefined;
        notes.push(
          `图片资产复制失败：${error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120)}`,
        );
      }
    }
    const block: ParsedFigureBlock = {
      blockId: "B0001",
      type: "figure",
      provenance: { fileName },
      ...(assetName !== undefined ? { assetName } : {}),
      ...(dimensions !== null && dimensions !== undefined
        ? { width: dimensions.width, height: dimensions.height }
        : {}),
    };
    return {
      parser: { id: this.id },
      mode: "structured",
      quality: notes.length > 0 ? "partial" : "full",
      mimeType: signature,
      blocks: [block],
      notes,
    };
  }
}
