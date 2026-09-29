/**
 * M10.1.1 测试共用：确定性二进制图片 fixture 生成（PNG / JPEG 头部）。
 * 纯字节构造（zlib + crc32），零外部依赖、离线、逐字节稳定。
 */

import { deflateSync } from "node:zlib";

/** PNG（8-bit RGB，单色填充；头部结构完整可读尺寸） */
export function makePng(width: number, height: number, rgb: [number, number, number] = [200, 30, 30]): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type RGB
  const ihdr = chunk("IHDR", ihdrData);
  const stride = width * 3 + 1; // 每行前置 filter 字节 0
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * 3;
      raw[offset] = rgb[0]!;
      raw[offset + 1] = rgb[1]!;
      raw[offset + 2] = rgb[2]!;
    }
  }
  const idat = chunk("IDAT", deflateSync(raw, { level: 9 }));
  const iend = chunk("IEND", Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, idat, iend]);
}

/** JPEG（SOI + SOF0 + EOI；尺寸可解析的最小结构——头部级 fixture） */
export function makeJpeg(width: number, height: number): Buffer {
  const sof = Buffer.alloc(12);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof[2] = 0x00;
  sof[3] = 0x0b; // 段长 11
  sof[4] = 0x08; // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 0x01; // 1 component
  sof[10] = 0x01;
  sof[11] = 0x00;
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), sof, Buffer.from([0xff, 0xd9])]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
