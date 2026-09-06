import { useRef, useState } from "react";

import { ErrorState, Loading } from "../common/StateViews.js";
import { RegistryStatus } from "../common/StatusBadge.js";
import { EXTRACTION_QUALITY_STYLES, statusStyleOf } from "../common/status.js";
import { formatDateTime } from "../../utils/format.js";
import {
  useExtractCitations,
  usePaper,
  useUploadPaperPdf,
} from "../../hooks/queries.js";
import { ApiError } from "../../api/client.js";
import type { PaperSectionView } from "../../types/paper.js";

/**
 * Final PDF 面板（Visual Redesign 2026-09）：文档工作台双栏。
 *
 * 左：文档信息（sticky）——文件、解析器、页数、章节/块、质量、时间；
 * 右：Paper Structure——按层级缩进的结构树 + 页范围 + 来源。
 * counts 保持为 metadata，不再各自成卡。不做 PDF 视觉 viewer（后续里程碑）。
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

/** 结构来源 → 人读标签（仅非 outline 的例外行标注，避免标签刷屏） */
const SECTION_SOURCE_LABEL: Record<PaperSectionView["source"], string | undefined> = {
  toc: undefined,
  "heading-pattern": "headings",
  "whole-document": "whole",
};

function StructureRow({ section }: { section: PaperSectionView }) {
  const src = SECTION_SOURCE_LABEL[section.source];
  return (
    <div className="section-row" data-level={section.level}>
      <span
        className="section-name"
        style={{ paddingLeft: `${(section.level - 1) * 18}px` }}
      >
        {section.title}
      </span>
      {src !== undefined ? <span className="section-src">{src}</span> : <span className="section-src" />}
      <span className="section-pages" title="页范围">
        p{section.pageStart}
        {section.pageEnd !== section.pageStart ? `-${section.pageEnd}` : ""}
      </span>
    </div>
  );
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
      <section>
        <div className="section-head">
          <h2>上传 Final PDF</h2>
        </div>
        <label className="upload-zone">
          <input
            ref={fileInput}
            type="file"
            accept=".pdf,application/pdf"
            aria-label="上传 Final PDF（.pdf）"
            onChange={(event) => void onPickFile(event.target.files?.[0])}
            disabled={upload.isPending}
          />
          <span className="upload-title">{upload.isPending ? "解析中（pymupdf）…" : "点击选择 PDF 文件"}</span>
          <span className="upload-hint">
            .pdf，不超过 50MB。Final PDF 是 Existing Paper 的正式 Review 输入（Read-only 审阅，不修改 PDF）。
          </span>
        </label>
        {upload.isError ? (
          <p className="form-error" style={{ marginTop: 12 }}>
            上传失败：{upload.error instanceof ApiError ? upload.error.message : String(upload.error)}
          </p>
        ) : null}
        {uploadError !== null ? (
          <p className="form-error" style={{ marginTop: 12 }}>
            {uploadError}
          </p>
        ) : null}
        {data.note !== undefined ? (
          <p className="note note-info" style={{ marginTop: 12 }}>
            <span>{data.note}</span>
          </p>
        ) : null}
      </section>
    );
  }

  const quality = statusStyleOf(EXTRACTION_QUALITY_STYLES, document.parse.extractionQuality);
  const sections = data.sections ?? [];
  const tocCount = sections.filter((s) => s.source === "toc").length;
  const headingCount = sections.length - tocCount;

  return (
    <div className="doc-grid">
      <div className="doc-info">
        <div className="section-head" style={{ marginBottom: 10 }}>
          <h2 className="aside-title" style={{ fontSize: "var(--fs-label)", fontWeight: 600, color: "var(--ink-700)", letterSpacing: "0.02em" }}>
            源文档
          </h2>
        </div>
        {document.title !== undefined ? <p className="doc-info-title reading">{document.title}</p> : null}
        <p className="doc-info-file">
          {document.originalFileName} · {formatBytes(document.bytes)}
        </p>
        <dl className="doc-info-rows">
          <div className="aside-row">
            <dt>解析器</dt>
            <dd className="mono">
              {document.parse.parserId}
              {document.parse.parserVersion ? ` ${document.parse.parserVersion}` : ""}
            </dd>
          </div>
          <div className="aside-row">
            <dt>页数</dt>
            <dd>{document.pageCount}</dd>
          </div>
          <div className="aside-row">
            <dt>章节 / 块</dt>
            <dd>
              {document.sectionCount} sections / {document.chunkCount} chunks
            </dd>
          </div>
          <div className="aside-row">
            <dt>解析状态</dt>
            <dd>
              <RegistryStatus style={quality} />
            </dd>
          </div>
          <div className="aside-row">
            <dt>解析时间</dt>
            <dd className="muted">{formatDateTime(document.parse.parsedAt) ?? "—"}</dd>
          </div>
        </dl>
        <div className="action-row" style={{ marginTop: 16 }}>
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
          <p className="form-error" style={{ marginTop: 10 }}>
            上传失败：{upload.error instanceof ApiError ? upload.error.message : String(upload.error)}
          </p>
        ) : null}
        {uploadError !== null ? <p className="form-error" style={{ marginTop: 10 }}>{uploadError}</p> : null}
      </div>

      <section>
        <div className="section-head">
          <h2>Structure</h2>
          <div className="action-row">
            <span className="section-note">
              {sections.length} 个章节
              {tocCount > 0
                ? ` · outline ${tocCount}${headingCount > 0 ? ` · headings ${headingCount}` : ""}`
                : "（标题正则识别）"}
            </span>
            <button
              type="button"
              className="btn btn-small btn-primary"
              onClick={() => extract.mutate()}
              disabled={extract.isPending}
              title="提取结果在「Citations」页查看与核验"
            >
              {extract.isPending ? "提取引用中…" : "提取引用"}
            </button>
          </div>
        </div>
        {sections.length > 0 ? (
          <div className="section-list">
            {sections.map((section) => (
              <StructureRow key={section.sectionId} section={section} />
            ))}
          </div>
        ) : (
          <p className="panel-empty">未识别到章节结构。</p>
        )}
        {extract.isError ? (
          <p className="form-error" style={{ marginTop: 12 }}>
            提取失败：{extract.error instanceof Error ? extract.error.message : String(extract.error)}
          </p>
        ) : null}
      </section>
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
