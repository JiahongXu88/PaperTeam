/**
 * 浏览器文件读取辅助（导入论文 / 上传 PDF 共用）。
 */

/** File → base64（arrayBuffer 优先；部分环境如 jsdom 只有 FileReader） */
export async function fileToBase64(file: File): Promise<string> {
  if (typeof file.arrayBuffer === "function") {
    return arrayBufferToBase64(await file.arrayBuffer());
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
