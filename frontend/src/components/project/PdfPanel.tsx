import { useRef, useState } from "react";

import { ErrorState, Loading } from "../common/StateViews.js";
import { formatDateTime } from "../../utils/format.js";
import {
  useExtractCitations,
  usePaper,
  useUploadPaperPdf,
} from "../../hooks/queries.js";
import { ApiError } from "../../api/client.js";

/**
 * Final PDF 面板（M4.3.7）：上传（Read-only Review 输入）+ 解析状态 +
 * Paper Structure（sections / page ranges / chunk counts）。
 * 不做 PDF 视觉 viewer（浏览器原生预览属后续里程碑）。
 */

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

export function PdfPanel({ projectId }: { projectId: string }) {
  const { data, isPending, isError, error, refetch } = usePaper(projectId);
  const upload = useUploadPaperPdf(projectId);
  const extract = useExtractCitations(projectId);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const onPickFile = async (file: File | undefined) => {
    setUploadError(null);
    if (file === undefined) {
      return;
    }
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setUploadError("只接受 .pdf 文件");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError("PDF 超过 50MB 上限");
      return;
    }
    const contentBase64 = await fileToBase64(file);
    await upload.mutateAsync({ fileName: file.name, contentBase64 });
    if (fileInput.current !== null) {
      fileInput.current.value = "";
    }
  };

  if (isPending) {
    return <Loading label="加载 Final PDF 状态…" />;
  }
  if (isError) {
    return (
      <ErrorState
        title="PDF 状态加载失败"
        message={error instanceof Error ? error.message : String(error)}
        onRetry={() => void refetch()}
      />
    );
  }

  const document = data.document;
  if (document === null || document === undefined) {
    return (
      <div className="panel-stack">
        <div className="panel">
          <h2>上传 Final PDF</h2>
          <p className="panel-empty">
            尚未上传最终论文 PDF。Final PDF 是 Existing Paper 的正式 Review 输入
            （Read-only 审阅，不修改 PDF）。
          </p>
          <label className="upload-row">
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,application/pdf"
              aria-label="上传 Final PDF（.pdf）"
              onChange={(event) => void onPickFile(event.target.files?.[0])}
              disabled={upload.isPending}
            />
            {upload.isPending ? <span className="form-note">解析中（pymupdf）…</span> : null}
          </label>
          {upload.isError ? (
            <p className="form-error">
              上传失败：{upload.error instanceof ApiError ? upload.error.message : String(upload.error)}
            </p>
          ) : null}
          {uploadError !== null ? <p className="form-error">{uploadError}</p> : null}
          {data.note !== undefined ? <p className="form-note">{data.note}</p> : null}
        </div>
      </div>
    );
  }

  const parseStage = (data.stages?.["parse"] ?? {}) as Record<string, unknown>;
  const meta: Array<[string, string]> = [
    ["文件", `${document.originalFileName}（${formatBytes(document.bytes)}）`],
    ["解析器", `${document.parse.parserId}${document.parse.parserVersion ? ` ${document.parse.parserVersion}` : ""}`],
    ["页数", String(document.pageCount)],
    ["解析质量", document.parse.extractionQuality],
    ["章节 / 块", `${document.sectionCount} sections / ${document.chunkCount} chunks`],
    ["解析状态", String(parseStage["status"] ?? "—")],
    ["解析时间", formatDateTime(document.parse.parsedAt) ?? "—"],
  ];

  return (
    <div className="panel-stack">
      <div className="panel">
        <h2>Final PDF</h2>
        {document.title !== undefined ? <p className="doc-title">{document.title}</p> : null}
        <dl className="meta-grid">
          {meta.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="action-row">
          <label className="btn btn-small">
            {upload.isPending ? "替换中…" : "替换 PDF"}
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,application/pdf"
              aria-label="替换 Final PDF（.pdf）"
              style={{ display: "none" }}
              onChange={(event) => void onPickFile(event.target.files?.[0])}
              disabled={upload.isPending}
            />
          </label>
        </div>
        {upload.isError ? (
          <p className="form-error">
            上传失败：{upload.error instanceof ApiError ? upload.error.message : String(upload.error)}
          </p>
        ) : null}
        {uploadError !== null ? <p className="form-error">{uploadError}</p> : null}
      </div>

      <div className="panel">
        <h2>Paper Structure</h2>
        <p className="form-note">
          sections 来自 PDF outline（TOC），无 outline 时退化为标题正则识别；chunk 带页码 provenance。
        </p>
        <table className="runs-table">
          <thead>
            <tr>
              <th>Section</th>
              <th>层级</th>
              <th>页范围</th>
              <th>来源</th>
            </tr>
          </thead>
          <tbody>
            {(data.sections ?? []).map((section) => (
              <tr key={section.sectionId}>
                <td>
                  <span className="mono">{section.sectionId}</span> {section.title}
                </td>
                <td>{section.level}</td>
                <td>
                  p{section.pageStart}-{section.pageEnd}
                </td>
                <td>{section.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="action-row">
          <button
            type="button"
            className="btn btn-small"
            onClick={() => extract.mutate()}
            disabled={extract.isPending}
          >
            {extract.isPending ? "提取引用中…" : "提取引用"}
          </button>
          {extract.isError ? (
            <span className="form-error">
              提取失败：{extract.error instanceof Error ? extract.error.message : String(extract.error)}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** File → base64（arrayBuffer 优先；部分环境如 jsdom 只有 FileReader） */
async function fileToBase64(file: File): Promise<string> {
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
