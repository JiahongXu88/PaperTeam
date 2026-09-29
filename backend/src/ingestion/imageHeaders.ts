/**
 * PNG / JPEG 头部读取（M10.1.1 图片资产登记）。
 *
 * 只读 header（尺寸 + magic），不解码像素、不引入图像库。签名与扩展名
 * 交叉校验是「不信文件名」防线的图片侧落地。
 */

export type ImageSignature = "image/png" | "image/jpeg";

/** 内容签名（前 8 字节判定；未知返回 null） */
export function imageSignature(buffer: Buffer): ImageSignature | null {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  return null;
}

/** PNG 尺寸（IHDR；结构不符返回 null——损坏如实呈现） */
export function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) {
    return null;
  }
  // 长度(4) + "IHDR"(4) 之后是 width/height（big-endian，偏移 16/20）
  if (buffer.toString("latin1", 12, 16) !== "IHDR") {
    return null;
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width === 0 || height === 0) {
    return null;
  }
  return { width, height };
}

/** JPEG 尺寸（扫描 SOFn 标记段；上限 1024 段防损坏文件死循环） */
export function jpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  const SOF_MARKERS = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2; // 跳过 SOI
  let guard = 0;
  while (offset + 9 < buffer.length && guard < 1024) {
    guard += 1;
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (SOF_MARKERS.has(marker)) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      if (width === 0 || height === 0) {
        return null;
      }
      return { width, height };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // 无长度段
      continue;
    }
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2) {
      return null; // 段长度非法——损坏
    }
    offset += 2 + segmentLength;
  }
  return null;
}

/** 按签名读尺寸（未知签名 / 损坏返回 null） */
export function imageDimensions(buffer: Buffer, signature: ImageSignature): { width: number; height: number } | null {
  return signature === "image/png" ? pngDimensions(buffer) : jpegDimensions(buffer);
}
