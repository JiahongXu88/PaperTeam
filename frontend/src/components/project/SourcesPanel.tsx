import { useRef, useState } from "react";

import { ErrorState, Loading } from "../common/StateViews.js";
import { formatApiError, formatApiErrorDetail } from "../../utils/errors.js";
import { formatBytes, formatDateTime } from "../../utils/format.js";
import { fileToBase64, MAX_SOURCE_UPLOAD_BYTES, validateSourceFile } from "../../utils/file.js";
import { useImportSource, useSources, useUploadSource } from "../../hooks/queries.js";
import type {
  BibTexImportResultView,
  SourceImportMode,
  SourceItemView,
  SourceOrigin,
  SourceResolveNote,
  SourceRole,
  SourceStatus,
  SourceType,
} from "../../types/sources.js";

/**
 * 「文献库」：项目 Sources（M6.2 能力的前端消费，M7.0 对齐）。
 *
 * 入库五种方式（全部复用既有后端端点，无新 API）：
 * PDF/文件上传、DOI、arXiv、URL、BibTeX——标识符导入只建 canonical 记录
 * （DOI/arXiv 默认经 ScholarlyResolver 补全元数据，未命中如实记录不伪造；
 * URL 不抓正文）。导入 ≠ 证据：Evidence 走 M6.5 grounding 管道，与库独立。
 */

type AddMode = "pdf" | SourceImportMode;

const ADD_MODES: ReadonlyArray<{ id: AddMode; label: string; hint: string }> = [
  { id: "pdf", label: "PDF / 文件", hint: "上传 PDF、BibTeX、文本等原始文件（≤20MB）" },
  { id: "doi", label: "DOI", hint: "如 10.1000/xyz.2024.001；默认补全元数据" },
  { id: "arxiv", label: "arXiv", hint: "如 2401.12345 或 cs/0501034；默认补全元数据" },
  { id: "url", label: "URL", hint: "http(s) 链接；只存链接记录，不抓取正文" },
  { id: "bibtex", label: "BibTeX", hint: "粘贴 BibTeX 原文，支持多条，逐条导入" },
];

const ORIGIN_LABELS: Record<SourceOrigin, string> = {
  USER_ADDED: "手动上传",
  DOI_IMPORT: "DOI 导入",
  ARXIV_IMPORT: "arXiv 导入",
  URL_IMPORT: "URL 导入",
  BIBTEX_IMPORT: "BibTeX 导入",
  AGENT_RETRIEVED: "检索入库",
};

const TYPE_LABELS: Record<SourceType, string> = {
  pdf: "PDF",
  bibtex: "BibTeX",
  text: "文本",
  markdown: "Markdown",
  image: "图片",
  doi: "DOI",
  arxiv: "arXiv",
  url: "URL",
  metadata: "元数据",
};

const STATUS_LABELS: Record<SourceStatus, string> = {
  available: "已就绪",
  metadata_only: "仅元数据",
  pending: "待解析",
  partial: "部分解析",
  failed: "解析失败",
  rejected: "已否决",
};

/** status → chip tone（失败/否决=警示色，不是红色错误——条目保留可重试，语义与 Evidence 约定一致） */
function statusTone(status: SourceStatus): string {
  if (status === "available") return "chip-tone-info";
  if (status === "failed" || status === "rejected") return "chip-tone-warn";
  return "";
}

const ROLE_LABELS: Record<SourceRole, string> = {
  evidence: "证据来源",
  reference: "参考范文",
  both: "证据 + 参考",
};

const SOURCE_ROLE_OPTIONS: ReadonlyArray<{ value: SourceRole; label: string }> = [
  { value: "both", label: "证据 + 参考（默认）" },
  { value: "evidence", label: "证据来源" },
  { value: "reference", label: "参考范文" },
];

function ResolveNoteLine({ resolve }: { resolve: SourceResolveNote }) {
  if (resolve.outcome === "match") {
    return (
      <p className="note note-success" role="status">
        <span>
          <span className="note-mark">✓</span> 元数据已通过 {resolve.provider ?? "学术源"} 补全。
        </span>
      </p>
    );
  }
  const labels: Record<SourceResolveNote["outcome"], string> = {
    match: "",
    mismatch: "外部记录与给定信息不一致，已按原样入库",
    ambiguous: "外部命中多条候选，元数据未自动填充",
    not_found: "学术源未收录，仅按给定标识入库",
    unresolved: "元数据解析暂未完成（可稍后重试补全）",
  };
  return (
    <p className="note" role="status">
      <span>
        <span className="note-mark">!</span> {labels[resolve.outcome]}
        {resolve.note !== undefined ? `（${resolve.note}）` : ""}
      </span>
    </p>
  );
}

function SourceRow({ source }: { source: SourceItemView }) {
  const meta = source.metadata;
  const title = meta.title ?? source.originalName ?? source.fileName ?? source.sourceId;
  return (
    <li className="source-row">
      <div className="source-row-main">
        <span className="source-title" title={title}>
          {title}
        </span>
        <span className="source-chips">
          <span className="chip" title="入库方式">{ORIGIN_LABELS[source.origin]}</span>
          {source.sourceType !== undefined ? (
            <span className="chip chip-outline">{TYPE_LABELS[source.sourceType]}</span>
          ) : null}
          <span className={`chip ${statusTone(source.status)}`}>{STATUS_LABELS[source.status]}</span>
          <span className="chip chip-outline" title="文献在项目中的角色">{ROLE_LABELS[source.sourceRole]}</span>
        </span>
      </div>
      <div className="source-row-meta">
        {meta.authors !== undefined && meta.authors.length > 0 ? (
          <span className="source-authors" title={meta.authors.join("; ")}>
            {meta.authors[0]}
            {meta.authors.length > 1 ? " 等" : ""}
          </span>
        ) : null}
        {meta.year !== undefined ? <span>{meta.year}</span> : null}
        {meta.venue !== undefined ? <span className="source-venue">{meta.venue}</span> : null}
        {source.bytes > 0 ? <span className="muted">{formatBytes(source.bytes)}</span> : null}
        <span className="muted mono">{source.sourceId}</span>
        <span className="muted">{formatDateTime(source.updatedAt) ?? "—"}</span>
      </div>
    </li>
  );
}

function AddSourceForm({ projectId }: { projectId: string }) {
  const [mode, setMode] = useState<AddMode>("pdf");
  const upload = useUploadSource(projectId);
  const importSource = useImportSource(projectId);

  const [identifier, setIdentifier] = useState("");
  const [urlTitle, setUrlTitle] = useState("");
  const [bibtex, setBibtex] = useState("");
  const [sourceRole, setSourceRole] = useState<SourceRole>("both");
  const [enrich, setEnrich] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);
  const [encoding, setEncoding] = useState(false);

  const resetForm = () => {
    setIdentifier("");
    setUrlTitle("");
    setBibtex("");
    if (fileInput.current !== null) {
      fileInput.current.value = "";
    }
  };

  const onPickFile = async (file: File | undefined) => {
    setLocalError(null);
    if (file === undefined) {
      return;
    }
    const problem = validateSourceFile(file);
    if (problem !== null) {
      setLocalError(problem);
      resetForm();
      return;
    }
    let contentBase64: string;
    try {
      setEncoding(true);
      contentBase64 = await fileToBase64(file);
    } catch (readError) {
      setLocalError(`读取文件失败：${readError instanceof Error ? readError.message : String(readError)}`);
      resetForm();
      return;
    } finally {
      setEncoding(false);
    }
    upload.mutate({ fileName: file.name, contentBase64, sourceRole }, { onSettled: resetForm });
  };

  const submitImport = () => {
    setLocalError(null);
    const value = identifier.trim();
    if (value === "") {
      setLocalError("请先填写标识符");
      return;
    }
    const role = sourceRole;
    if (mode === "doi") {
      importSource.mutate({ mode: "doi", payload: { doi: value, sourceRole: role, ...(enrich ? {} : { enrich: false }) } }, { onSuccess: resetForm });
    } else if (mode === "arxiv") {
      importSource.mutate({ mode: "arxiv", payload: { arxivId: value, sourceRole: role, ...(enrich ? {} : { enrich: false }) } }, { onSuccess: resetForm });
    } else if (mode === "url") {
      const title = urlTitle.trim();
      importSource.mutate(
        { mode: "url", payload: { url: value, ...(title !== "" ? { title } : {}), sourceRole: role } },
        { onSuccess: resetForm },
      );
    }
  };

  const submitBibtex = () => {
    setLocalError(null);
    const content = bibtex.trim();
    if (content === "") {
      setLocalError("请先粘贴 BibTeX 内容");
      return;
    }
    importSource.mutate({ mode: "bibtex", payload: { content, sourceRole } }, { onSuccess: resetForm });
  };

  const busy = encoding || upload.isPending || importSource.isPending;
  const active = ADD_MODES.find((entry) => entry.id === mode);
  const importResult = importSource.data;

  return (
    <section className="panel section-block">
      <div className="section-head">
        <h2>添加文献</h2>
      </div>
      <div className="action-row source-mode-row" role="group" aria-label="添加方式">
        {ADD_MODES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`btn btn-small${mode === entry.id ? " is-active" : ""}`}
            aria-pressed={mode === entry.id}
            onClick={() => {
              setMode(entry.id);
              setLocalError(null);
            }}
            disabled={busy}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {active !== undefined ? <p className="field-help">{active.hint}</p> : null}

      {mode === "pdf" ? (
        <label className="upload-zone">
          <input
            ref={fileInput}
            type="file"
            accept=".pdf,.bib,.txt,.md,.csv,.png,.jpg,.jpeg"
            aria-label="上传文献文件"
            onChange={(event) => void onPickFile(event.target.files?.[0])}
            disabled={busy}
          />
          <span className="upload-title">
            {encoding ? "读取文件…" : upload.isPending ? "上传中…" : "点击选择文献文件"}
          </span>
          <span className="upload-hint">
            PDF / .bib / 文本 / 图片，单个不超过 {Math.floor(MAX_SOURCE_UPLOAD_BYTES / (1024 * 1024))}MB；
            相同内容的文件不会重复入库。
          </span>
        </label>
      ) : mode === "bibtex" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitBibtex();
          }}
        >
          <div className="field">
            <label htmlFor="source-bibtex">BibTeX 原文</label>
            <textarea
              id="source-bibtex"
              value={bibtex}
              onChange={(event) => setBibtex(event.target.value)}
              rows={6}
              placeholder={"@article{demo2024,\n  title = {…},\n  doi = {…},\n}"}
              disabled={busy}
              spellCheck={false}
            />
          </div>
          <div className="field">
            <label htmlFor="source-role-bibtex">文献角色</label>
            <select
              id="source-role-bibtex"
              value={sourceRole}
              onChange={(event) => setSourceRole(event.target.value as SourceRole)}
              disabled={busy}
            >
              {SOURCE_ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="form-actions">
            <button type="submit" className="btn" disabled={busy || bibtex.trim() === ""}>
              {importSource.isPending ? "导入中…" : "导入 BibTeX"}
            </button>
          </div>
        </form>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitImport();
          }}
        >
          <div className="field">
            <label htmlFor="source-identifier">
              {mode === "doi" ? "DOI" : mode === "arxiv" ? "arXiv ID" : "URL"}
            </label>
            <input
              id="source-identifier"
              type="text"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              placeholder={mode === "doi" ? "10.1000/xyz.2024.001" : mode === "arxiv" ? "2401.12345" : "https://example.org/paper"}
              disabled={busy}
            />
          </div>
          {mode === "url" ? (
            <div className="field">
              <label htmlFor="source-url-title">标题（可选；帮助同名页面识别）</label>
              <input
                id="source-url-title"
                type="text"
                value={urlTitle}
                onChange={(event) => setUrlTitle(event.target.value)}
                disabled={busy}
              />
            </div>
          ) : (
            <div className="field field-inline">
              <label>
                <input
                  type="checkbox"
                  checked={enrich}
                  onChange={(event) => setEnrich(event.target.checked)}
                  disabled={busy}
                />{" "}
                自动补全元数据（DOI / arXiv → 学术源解析）
              </label>
            </div>
          )}
          <div className="field">
            <label htmlFor="source-role">文献角色</label>
            <select
              id="source-role"
              value={sourceRole}
              onChange={(event) => setSourceRole(event.target.value as SourceRole)}
              disabled={busy}
            >
              {SOURCE_ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="form-actions">
            <button type="submit" className="btn" disabled={busy || identifier.trim() === ""}>
              {importSource.isPending ? "导入中…" : "导入文献"}
            </button>
          </div>
        </form>
      )}

      <div className="panel-stack" style={{ marginTop: "var(--s-3)" }}>
        {localError !== null ? (
          <p className="form-error" role="alert">
            {localError}
          </p>
        ) : null}
        {upload.isError ? (
          <ErrorState title="上传失败" message={formatApiError(upload.error)} detail={formatApiErrorDetail(upload.error)} />
        ) : null}
        {upload.isSuccess ? (
          <p className="note note-success" role="status">
            <span>
              <span className="note-mark">✓</span>{" "}
              {upload.data.created ? "已上传并加入文献库。" : "相同内容的文件已在库中（未重复创建）。"}
            </span>
          </p>
        ) : null}
        {importSource.isError ? (
          <ErrorState title="导入失败" message={formatApiError(importSource.error)} detail={formatApiErrorDetail(importSource.error)} />
        ) : null}
        {importResult !== undefined && !("results" in importResult) ? (
          <>
            <p className="note note-success" role="status">
              <span>
                <span className="note-mark">✓</span>{" "}
                {importResult.created ? "已导入文献库。" : "文献库中已有同一文献（未重复创建）。"}
              </span>
            </p>
            {importResult.resolve !== undefined ? <ResolveNoteLine resolve={importResult.resolve} /> : null}
          </>
        ) : null}
        {importResult !== undefined && "results" in importResult ? (
          <BibtexResultNote result={importResult} />
        ) : null}
      </div>
    </section>
  );
}

function BibtexResultNote({ result }: { result: BibTexImportResultView }) {
  if (result.results.length === 0 && result.errors.length === 0) {
    return (
      <p className="note" role="status">
        <span>
          <span className="note-mark">!</span> 未解析到任何 BibTeX 条目，请检查格式。
        </span>
      </p>
    );
  }
  return (
    <>
      <p className="note note-success" role="status">
        <span>
          <span className="note-mark">✓</span> 导入完成：{result.results.length} 条
          {result.results.some((entry) => !entry.created)
            ? `（${result.results.filter((entry) => !entry.created).length} 条已在库中，未重复创建）`
            : ""}
          。
        </span>
      </p>
      {result.errors.length > 0 ? (
        <details className="details-block">
          <summary>{result.errors.length} 条解析失败（不影响已成功条目）</summary>
          <ul className="details-body notes-list">
            {result.errors.map((error, index) => (
              <li key={index}>
                第 {error.line} 行：{error.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

export function SourcesPanel({ projectId }: { projectId: string }) {
  const { data, isPending, isError, error, refetch } = useSources(projectId);

  return (
    <div className="panel-stack">
      <AddSourceForm projectId={projectId} />
      <section className="panel section-block">
        <div className="section-head">
          <h2>文献列表</h2>
          <span className="section-note">{data?.length ?? 0} 条</span>
        </div>
        {isPending ? (
          <Loading label="加载文献库…" />
        ) : isError ? (
          <ErrorState
            title="文献库加载失败"
            message={formatApiError(error)}
            detail={formatApiErrorDetail(error)}
            onRetry={() => void refetch()}
          />
        ) : data === undefined || data.length === 0 ? (
          <p className="panel-empty">
            还没有文献。上传 PDF、粘贴 BibTeX，或用 DOI / arXiv / URL 标识导入。
          </p>
        ) : (
          <ul className="source-list">
            {data.map((source) => (
              <SourceRow key={source.sourceId} source={source} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
