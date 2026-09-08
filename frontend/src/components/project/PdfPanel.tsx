import { PaperPreview } from "./PaperPreview.js";
import { useRef, useState } from "react";

import { ErrorState, Loading } from "../common/StateViews.js";
import { RegistryStatus } from "../common/StatusBadge.js";
import { EXTRACTION_QUALITY_STYLES, statusStyleOf } from "../common/status.js";
import { formatBytes, formatDateTime } from "../../utils/format.js";
import { fileToBase64, MAX_PDF_UPLOAD_BYTES, validatePdfFile } from "../../utils/file.js";
import { useExtractCitations, usePaper, useReparsePaperPdf, useUploadPaperPdf } from "../../hooks/queries.js";
import { formatApiError, formatApiErrorDetail } from "../../utils/errors.js";
import type { PaperSectionView } from "../../types/paper.js";

/**
 * 「PDF 与结构」：左侧文档信息（文件、解析器、页数、质量、时间），
 * 右侧论文结构——章节按层级缩进，页范围落在右侧栏位。不做 PDF 视觉 viewer。
 */

/** 结构来源 → 人读标签（只标注非目录识别的例外行，避免刷屏） */
const SECTION_SOURCE_LABEL: Record<PaperSectionView["source"], string | undefined> = {
  toc: undefined,
  "heading-pattern": "标题识别",
  "whole-document": "全文",
};

function StructureRow({ section }: { section: PaperSectionView }) {
  const source = SECTION_SOURCE_LABEL[section.source];
  return (
    <div className="section-row" data-level={section.level}>
      <span className="section-name" style={{ paddingLeft: `${(section.level - 1) * 18}px` }}>
        {section.title}
      </span>
      <span className="section-src">{source}</span>
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
  const reparse = useReparsePaperPdf(projectId);
  const extract = useExtractCitations(projectId);
  const fileInput = useRef<HTMLInputElement>(null);
  const [encoding, setEncoding] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const resetInput = () => {
    if (fileInput.current !== null) {
      fileInput.current.value = "";
    }
  };

  const onPickFile = async (file: File | undefined) => {
    setLocalError(null);
    if (file === undefined) {
      return;
    }
    const problem = validatePdfFile(file);
    if (problem !== null) {
      setLocalError(problem);
      resetInput();
      return;
    }
    let contentBase64: string;
    try {
      setEncoding(true);
      contentBase64 = await fileToBase64(file);
    } catch (readError) {
      setLocalError(`读取文件失败：${readError instanceof Error ? readError.message : String(readError)}`);
      resetInput();
      return;
    } finally {
      setEncoding(false);
    }
    upload.mutate({ fileName: file.name, contentBase64 }, { onSettled: resetInput });
  };

  if (isPending) {
    return <Loading label="加载 PDF 状态…" />;
  }
  if (isError) {
    return <ErrorState title="PDF 状态加载失败" message={formatApiError(error)} detail={formatApiErrorDetail(error)} onRetry={() => void refetch()} />;
  }

  const busy = encoding || upload.isPending || reparse.isPending;
  const uploadErrors = (
    <>
      {upload.isError ? (
        <ErrorState title="上传失败" message={formatApiError(upload.error)} detail={formatApiErrorDetail(upload.error)} />
      ) : null}
      {localError !== null ? (
        <p className="form-error" role="alert">
          {localError}
        </p>
      ) : null}
    </>
  );

  const document = data.document;
  if (document === null || document === undefined) {
    return (
      <section className="panel section-block">
        <div className="section-head">
          <h2>上传最终 PDF</h2>
        </div>
        <label className="upload-zone">
          <input
            ref={fileInput}
            type="file"
            accept=".pdf,application/pdf"
            aria-label="上传最终 PDF（.pdf）"
            onChange={(event) => void onPickFile(event.target.files?.[0])}
            disabled={busy}
          />
          <span className="upload-title">{encoding ? "读取文件…" : upload.isPending ? "上传并解析中…" : "点击选择 PDF 文件"}</span>
          <span className="upload-hint">
            .pdf 文件，不超过 {Math.floor(MAX_PDF_UPLOAD_BYTES / (1024 * 1024))}MB。最终 PDF 是引用核验与 Review 的正式输入（只读分析，不修改原文件）。
          </span>
        </label>
        <div className="panel-stack" style={{ marginTop: "var(--s-3)" }}>
          {uploadErrors}
        </div>
      </section>
    );
  }

  const quality = statusStyleOf(EXTRACTION_QUALITY_STYLES, document.parse.extractionQuality);
  const sections = data.sections ?? [];
  const tocCount = sections.filter((section) => section.source === "toc").length;
  const headingCount = sections.length - tocCount;

  return (
    <div className="doc-grid">
      <aside className="doc-info aside-card" aria-label="文档信息">
        <h2 className="aside-title">源文档</h2>
        <PaperPreview title={document.title ?? document.originalFileName} />
        {document.title !== undefined ? <p className="doc-info-title reading">{document.title}</p> : null}
        <p className="doc-info-file">
          <span className="mono">{document.originalFileName}</span>
          <span className="muted">{formatBytes(document.bytes)}</span>
        </p>
        <dl className="kv">
          <div className="kv-row">
            <dt>解析器</dt>
            <dd className="mono">
              {document.parse.parserId}
              {document.parse.parserVersion ? ` ${document.parse.parserVersion}` : ""}
            </dd>
          </div>
          <div className="kv-row">
            <dt>页数</dt>
            <dd>{document.pageCount}</dd>
          </div>
          <div className="kv-row">
            <dt>章节 / 文本块</dt>
            <dd>
              {document.sectionCount} / {document.chunkCount}
            </dd>
          </div>
          <div className="kv-row">
            <dt>解析质量</dt>
            <dd>
              <RegistryStatus style={quality} />
            </dd>
          </div>
          <div className="kv-row">
            <dt>解析时间</dt>
            <dd className="muted">{formatDateTime(document.parse.parsedAt) ?? "—"}</dd>
          </div>
        </dl>
        {document.parse.notes !== undefined && document.parse.notes.length > 0 ? (
          <details className="details-block" style={{ marginTop: "var(--s-3)" }}>
            <summary>解析备注（{document.parse.notes.length}）</summary>
            <ul className="details-body notes-list">
              {document.parse.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          </details>
        ) : null}
        <div className="action-row" style={{ marginTop: "var(--s-4)" }}>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => reparse.mutate()}
            disabled={busy}
            title="用已上传的文件重新解析（解析器更新后使用；引用与 Review 结果会清空，需要重跑）"
          >
            {reparse.isPending ? "重新解析中…" : "重新解析"}
          </button>
          <label className={`btn btn-small${busy ? " is-disabled" : ""}`}>
            {encoding ? "读取中…" : upload.isPending ? "替换中…" : "替换 PDF"}
            <input
              ref={fileInput}
              type="file"
              accept=".pdf,application/pdf"
              aria-label="替换最终 PDF（.pdf）"
              className="visually-hidden"
              onChange={(event) => void onPickFile(event.target.files?.[0])}
              disabled={busy}
            />
          </label>
        </div>
        <div className="panel-stack" style={{ marginTop: "var(--s-3)" }}>
          {uploadErrors}
          {reparse.isError ? <ErrorState title="重新解析失败" message={formatApiError(reparse.error)} detail={formatApiErrorDetail(reparse.error)} /> : null}
        </div>
      </aside>

      <section className="panel section-block doc-structure">
        <div className="section-head">
          <h2>论文结构</h2>
          <div className="action-row">
            <span className="section-note">
              {sections.length} 个章节
              {tocCount > 0 ? `，目录识别 ${tocCount}${headingCount > 0 ? `，标题识别 ${headingCount}` : ""}` : "（按标题识别）"}
            </span>
            <button type="button" className="btn btn-small" onClick={() => extract.mutate()} disabled={extract.isPending} title="提取结果在「引用核验」标签页查看">
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
          <p className="form-error" role="alert" style={{ marginTop: "var(--s-3)" }}>
            提取失败：{formatApiError(extract.error)}
          </p>
        ) : null}
        {extract.isSuccess ? (
          <p className="note note-success" role="status" style={{ marginTop: "var(--s-3)" }}>
            <span>
              <span className="note-mark">✓</span> 已提取 {extract.data.summary.referenceCount} 条参考文献、{extract.data.summary.calloutCount} 处正文引用，可在「引用核验」查看与核验。
            </span>
          </p>
        ) : null}
      </section>
    </div>
  );
}
