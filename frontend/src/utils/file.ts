/** 浏览器端文件读取与校验（导入论文 / 替换 PDF 共用） */

/** PDF 上传上限（与 Backend PaperIngestService.MAX_PAPER_PDF_BYTES 一致） */
export const MAX_PDF_UPLOAD_BYTES = 50 * 1024 * 1024;

/** 选择文件后的即时校验；合法返回 null */
export function validatePdfFile(file: File): string | null {
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    return "只接受 .pdf 文件";
  }
  if (file.size === 0) {
    return "文件为空";
  }
  if (file.size > MAX_PDF_UPLOAD_BYTES) {
    return `PDF 超过 ${Math.floor(MAX_PDF_UPLOAD_BYTES / (1024 * 1024))}MB 上限`;
  }
  return null;
}

/**
 * File → base64。优先 FileReader.readAsDataURL：浏览器原生编码，不在主线程拼接
 * 几十 MB 的二进制字符串；没有 FileReader 的环境退回 arrayBuffer 分块编码。
 */
export async function fileToBase64(file: File): Promise<string> {
  if (typeof FileReader === "function") {
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
  return arrayBufferToBase64(await file.arrayBuffer());
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
