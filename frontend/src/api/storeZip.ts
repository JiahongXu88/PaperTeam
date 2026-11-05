/**
 * M17.2：浏览器端把单个 / 多个实验结果文件（CSV / XLSX / JSON / TXT / YAML）打成确定性的 store-method ZIP，
 * 复用后端既有的实验包上传端点（流式限额、结构安全校验、内容哈希幂等、解析器）——不新增上传协议、不在前端解析内容。
 *
 * 确定性：条目按路径码位序排列，固定 DOS 时间戳（1980-01-01 00:00），无压缩、无额外字段；同一组文件字节 → 同一 ZIP 字节
 * → 同一 packageId（重复上传幂等）。文件名一律置 UTF-8 标志位（中文文件名不乱码）。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) crc = CRC_TABLE[(crc ^ data[index]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export const LOOSE_EXPERIMENT_EXTENSIONS = [".csv", ".xlsx", ".json", ".txt", ".yaml", ".yml"] as const;
const DOS_DATE_1980_01_01 = (0 << 9) | (1 << 5) | 1;
const UTF8_FLAG = 0x0800;

/** 纯函数：条目 → ZIP 字节（测试可直接断言字节稳定） */
export function buildStoreZipBytes(entries: ReadonlyArray<{ path: string; data: Uint8Array }>): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const chunks: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of sorted) {
    const name = encoder.encode(entry.path);
    const crc = crc32(entry.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, UTF8_FLAG, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, DOS_DATE_1980_01_01, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, entry.data.length, true);
    local.setUint32(22, entry.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), name, entry.data);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, UTF8_FLAG, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, 0, true);
    central.setUint16(14, DOS_DATE_1980_01_01, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, entry.data.length, true);
    central.setUint32(24, entry.data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), name);
    offset += 30 + name.length + entry.data.length;
  }
  const centralSize = centrals.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, sorted.length, true);
  end.setUint16(10, sorted.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...centrals, new Uint8Array(end.buffer)];
  const total = all.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(new ArrayBuffer(total));
  let cursor = 0;
  for (const chunk of all) { output.set(chunk, cursor); cursor += chunk.length; }
  return output;
}

/** 校验并打包：只接受实验结果类扩展名；路径取文件夹选择的相对路径或文件名；重名拒绝（不静默覆盖） */
export async function bundleExperimentFiles(files: readonly File[]): Promise<File> {
  if (files.length === 0) throw new Error("请选择至少一个实验结果文件");
  const seen = new Set<string>();
  const planned: Array<{ path: string; file: File }> = [];
  // 先完成全部校验再读取内容：任何一个文件不合规都不读取、不上传
  for (const file of files) {
    const path = ((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name).split(String.fromCharCode(92)).join("/");
    const lower = path.toLowerCase();
    if (!LOOSE_EXPERIMENT_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
      throw new Error(`不支持的文件类型：${file.name}（单独上传支持 ${LOOSE_EXPERIMENT_EXTENSIONS.join(" / ")}；其他文件请打包为 ZIP）`);
    }
    if (seen.has(path)) throw new Error(`文件路径重复：${path}`);
    seen.add(path);
    planned.push({ path, file });
  }
  const entries: Array<{ path: string; data: Uint8Array }> = [];
  for (const entry of planned) entries.push({ path: entry.path, data: await readBytes(entry.file) });
  const name = files.length === 1 ? `${files[0]!.name}.zip` : `experiment-files-${files.length}.zip`;
  return new File([buildStoreZipBytes(entries)], name, { type: "application/zip" });
}

async function readBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取文件：${file.name}`));
    reader.readAsArrayBuffer(file);
  });
}
