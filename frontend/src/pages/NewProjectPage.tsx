import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import { ErrorState } from "../components/common/StateViews.js";
import { PageHeader } from "../components/common/PageHeader.js";
import {
  DOCUMENT_TYPE_OPTIONS,
  TARGET_PROFILE_OPTIONS,
} from "../constants/projectMeta.js";
import { useCreateProject, useImportProjectPdf, useRuntimeStatus } from "../hooks/queries.js";
import { createWorkflowRun } from "../api/runs.js";
import { formatApiError } from "../utils/errors.js";
import { fileToBase64 } from "../utils/file.js";
import type {
  CreateProjectInput,
  ExistingPaperGoal,
  ImportProjectPdfInput,
} from "../types/api.js";

/**
 * 新建项目页（Project Entry UX 2026-09）。
 *
 * 顶层只问一件事：你想做什么？
 *   A. 从研究想法开始（idea_to_paper：标题 + 研究想法 + 定位字段）
 *   B. 导入已有论文（File First：PDF + 目标，导入即建项目，标题自动生成，
 *      不要求用户先手填标题；其余定位字段折叠进「高级选项」）
 */

/** 与 Backend ProjectStore 一致的长度上限（前端提前拦截） */
const LIMITS = {
  title: 200,
  researchIdea: 8000,
  researchField: 200,
  targetVenue: 300,
  language: 50,
} as const;

/** PDF 上传上限（与 Backend PaperIngestService 一致） */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

type EntryMode = "idea" | "existing";

interface FormState {
  title: string;
  researchIdea: string;
  researchField: string;
  documentType: string;
  targetProfile: string;
  targetVenue: string;
  language: string;
}

const INITIAL_FORM: FormState = {
  title: "",
  researchIdea: "",
  researchField: "",
  documentType: "",
  targetProfile: "",
  targetVenue: "",
  language: "",
};

/** 返回错误文案；合法返回 null（只校验填写了的字段） */
function validateIdeaForm(form: FormState): string | null {
  if (form.title.trim() === "") {
    return "论文标题不能为空";
  }
  if (form.title.trim().length > LIMITS.title) {
    return `论文标题不能超过 ${LIMITS.title} 个字符`;
  }
  if (form.researchIdea.trim().length > LIMITS.researchIdea) {
    return `研究想法不能超过 ${LIMITS.researchIdea} 个字符`;
  }
  if (form.researchField.trim().length > LIMITS.researchField) {
    return `研究领域不能超过 ${LIMITS.researchField} 个字符`;
  }
  if (form.targetVenue.trim().length > LIMITS.targetVenue) {
    return `目标期刊 / 会议不能超过 ${LIMITS.targetVenue} 个字符`;
  }
  if (form.language.trim().length > LIMITS.language) {
    return `写作语言不能超过 ${LIMITS.language} 个字符`;
  }
  return null;
}

/** 只提交非空字段（Backend 对空串视为「不设置」，显式裁剪更干净） */
function toPicked(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function toCreateInput(form: FormState): CreateProjectInput {
  return {
    title: form.title.trim(),
    workflowKind: "idea_to_paper",
    ...(toPicked(form.researchIdea) !== undefined ? { researchIdea: toPicked(form.researchIdea) } : {}),
    ...(toPicked(form.researchField) !== undefined ? { researchField: toPicked(form.researchField) } : {}),
    ...(toPicked(form.documentType) !== undefined ? { documentType: toPicked(form.documentType) } : {}),
    ...(toPicked(form.targetProfile) !== undefined ? { targetProfile: toPicked(form.targetProfile) } : {}),
    ...(toPicked(form.targetVenue) !== undefined ? { targetVenue: toPicked(form.targetVenue) } : {}),
    ...(toPicked(form.language) !== undefined ? { language: toPicked(form.language) } : {}),
  };
}

export function NewProjectPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<EntryMode>("idea");

  return (
    <section className="page page-narrow">
      <PageHeader
        title="新建项目"
        breadcrumb={
          <>
            <Link to="/projects">论文项目</Link>
            <span className="crumb-sep" aria-hidden="true">/</span>
            <span>新建项目</span>
          </>
        }
      />
      {mode === "idea" ? (
        <IdeaForm onSwitchMode={() => setMode("existing")} navigate={navigate} />
      ) : (
        <ExistingPaperForm onSwitchMode={() => setMode("idea")} navigate={navigate} />
      )}
    </section>
  );
}

/** 模式切换卡（两份表单共用；当前模式高亮，点击另一张切换） */
function ModeCards({ current, onSelect }: { current: EntryMode; onSelect: (mode: EntryMode) => void }) {
  return (
    <div className="mode-cards">
      <label className={`mode-card ${current === "idea" ? "selected" : ""}`}>
        <input
          type="radio"
          name="entryMode"
          value="idea"
          checked={current === "idea"}
          onChange={() => onSelect("idea")}
        />
        <span className="mode-card-top">
          <span className="mode-card-dot" aria-hidden="true" />
          <span className="mode-card-title">从研究想法开始</span>
        </span>
        <span className="mode-card-desc">
          从一个研究想法出发，完成调研、证据整理、写作与审稿，最终生成论文。
        </span>
      </label>
      <label className={`mode-card ${current === "existing" ? "selected" : ""}`}>
        <input
          type="radio"
          name="entryMode"
          value="existing"
          checked={current === "existing"}
          onChange={() => onSelect("existing")}
        />
        <span className="mode-card-top">
          <span className="mode-card-dot" aria-hidden="true" />
          <span className="mode-card-title">导入已有论文</span>
        </span>
        <span className="mode-card-desc">
          上传论文 PDF，先做快速 Review（引用核验 + 分章节审阅），或进入系统性改进流程。
        </span>
      </label>
    </div>
  );
}

// ============================================================
// 模式 A：从研究想法开始
// ============================================================

function IdeaForm({
  onSwitchMode,
  navigate,
}: {
  onSwitchMode: () => void;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const createProject = useCreateProject();
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [validationError, setValidationError] = useState<string | null>(null);

  const update =
    (field: keyof FormState) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      setForm((prev) => ({ ...prev, [field]: event.target.value }));
    };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const error = validateIdeaForm(form);
    setValidationError(error);
    if (error !== null) {
      return;
    }
    createProject.mutate(toCreateInput(form), {
      onSuccess: (project) => {
        void navigate(`/projects/${project.id}`);
      },
    });
  };

  return (
    <form className="panel" onSubmit={onSubmit} noValidate>
      <fieldset className="form-section">
        <legend>你想做什么？</legend>
        <ModeCards current="idea" onSelect={onSwitchMode} />
      </fieldset>

      <fieldset className="form-section">
        <legend>基本信息</legend>
        <div className="field">
          <label htmlFor="title">
            论文标题 <span className="required">*</span>
          </label>
          <input
            id="title"
            name="title"
            value={form.title}
            onChange={update("title")}
            placeholder="如：基于检索增强生成的学术写作辅助研究"
            maxLength={LIMITS.title + 1}
          />
        </div>
        <div className="field">
          <label htmlFor="researchIdea">研究想法</label>
          <textarea
            id="researchIdea"
            name="researchIdea"
            rows={5}
            value={form.researchIdea}
            onChange={update("researchIdea")}
            placeholder="用一段话描述研究问题、动机与初步思路"
          />
          <span className="field-help">研究想法是主线的起点：Researcher 会据此完成调研与可行性分析。</span>
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="researchField">研究领域</label>
            <input
              id="researchField"
              name="researchField"
              value={form.researchField}
              onChange={update("researchField")}
              placeholder="如：信息检索"
            />
          </div>
          <div className="field">
            <label htmlFor="targetVenue">目标期刊 / 会议</label>
            <input
              id="targetVenue"
              name="targetVenue"
              value={form.targetVenue}
              onChange={update("targetVenue")}
              placeholder="如：SIGIR 2027"
            />
          </div>
        </div>
      </fieldset>

      <fieldset className="form-section">
        <legend>论文定位</legend>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="documentType">论文类型</label>
            <select id="documentType" name="documentType" value={form.documentType} onChange={update("documentType")}>
              <option value="">未指定</option>
              {DOCUMENT_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="targetProfile">目标定位</label>
            <select id="targetProfile" name="targetProfile" value={form.targetProfile} onChange={update("targetProfile")}>
              <option value="">未指定</option>
              {TARGET_PROFILE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="language">写作语言</label>
            <input
              id="language"
              name="language"
              value={form.language}
              onChange={update("language")}
              placeholder="如：中文 / English（可选）"
              maxLength={LIMITS.language + 1}
            />
          </div>
        </div>
      </fieldset>

      {validationError !== null ? (
        <p className="form-error" role="alert" data-testid="validation-error">
          {validationError}
        </p>
      ) : null}
      {createProject.isError ? (
        <ErrorState title="创建失败" message={formatApiError(createProject.error)} />
      ) : null}

      <div className="form-actions">
        <Link to="/projects" className="btn">
          取消
        </Link>
        <button type="submit" className="btn btn-primary" disabled={createProject.isPending}>
          {createProject.isPending ? "创建中…" : "创建项目"}
        </button>
      </div>
    </form>
  );
}

// ============================================================
// 模式 B：导入已有论文（File First）
// ============================================================

const GOAL_OPTIONS: Array<{
  value: ExistingPaperGoal;
  title: string;
  desc: string;
  recommended?: boolean;
}> = [
  {
    value: "review_only",
    title: "快速 Review",
    desc: "只分析现有论文：引用真实性核验、论断-引用一致性、分章节审阅，汇总审阅报告。不自动修改论文。",
    recommended: true,
  },
  {
    value: "improvement",
    title: "系统性改进",
    desc: "先 Review 建立基线，再依据审阅发现进入后续修改与优化流程。",
  },
];

function ExistingPaperForm({
  onSwitchMode,
  navigate,
}: {
  onSwitchMode: () => void;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const importPdf = useImportProjectPdf();
  const runtimeStatus = useRuntimeStatus();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [goal, setGoal] = useState<ExistingPaperGoal>("review_only");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [researchField, setResearchField] = useState("");
  const [targetVenue, setTargetVenue] = useState("");
  const [targetProfile, setTargetProfile] = useState("");
  const [language, setLanguage] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const onPickFile = (picked: File | undefined) => {
    setValidationError(null);
    if (picked === undefined) {
      return;
    }
    if (!picked.name.toLowerCase().endsWith(".pdf")) {
      setValidationError("只接受 .pdf 文件");
      return;
    }
    if (picked.size > MAX_UPLOAD_BYTES) {
      setValidationError("PDF 超过 50MB 上限");
      return;
    }
    setFile(picked);
  };

  const onImport = async (event: FormEvent) => {
    event.preventDefault();
    if (file === null) {
      setValidationError("请先选择论文 PDF 文件");
      return;
    }
    setValidationError(null);
    const input: ImportProjectPdfInput = {
      fileName: file.name,
      contentBase64: await fileToBase64(file),
      goal,
      ...(toPicked(researchField) !== undefined ? { researchField: toPicked(researchField)! } : {}),
      ...(toPicked(targetVenue) !== undefined ? { targetVenue: toPicked(targetVenue)! } : {}),
      ...(toPicked(targetProfile) !== undefined ? { targetProfile: toPicked(targetProfile)! } : {}),
      ...(toPicked(language) !== undefined ? { language: toPicked(language)! } : {}),
    };
    await importPdf.mutateAsync(input).then(
      async ({ project }) => {
        if (goal === "review_only") {
          // 快速 Review：导入完成即自动启动审阅（模型已配置时；失败不阻断导航）
          if (runtimeStatus.data?.model.phase === "configured") {
            await createWorkflowRun(project.id, "existing_paper_review").catch(() => {});
          }
          void navigate(`/projects/${project.id}?tab=review`);
          return;
        }
        // 系统性改进：进入工作区，第一阶段先做 Review 基线
        void navigate(`/projects/${project.id}`);
      },
      () => {
        if (fileInput.current !== null) {
          fileInput.current.value = "";
        }
      },
    );
  };

  const submitting = importPdf.isPending;

  return (
    <form className="panel" onSubmit={(event) => void onImport(event)} noValidate data-testid="existing-import-form">
      <fieldset className="form-section">
        <legend>你想做什么？</legend>
        <ModeCards current="existing" onSelect={onSwitchMode} />
      </fieldset>

      <fieldset className="form-section">
        <legend>论文 PDF</legend>
        <label className="upload-zone">
          <input
            ref={fileInput}
            type="file"
            accept=".pdf,application/pdf"
            aria-label="选择论文 PDF（.pdf）"
            onChange={(event) => onPickFile(event.target.files?.[0])}
            disabled={submitting}
          />
          <span className="upload-title">
            {file !== null ? file.name : submitting ? "解析中…" : "点击选择 PDF 文件"}
          </span>
          <span className="upload-hint">
            .pdf 文件，不超过 50MB。导入后自动解析：论文标题将取自 PDF（缺失时用文件名），无需手填。
          </span>
        </label>
      </fieldset>

      <fieldset className="form-section">
        <legend>你希望先做什么？</legend>
        <div className="mode-cards">
          {GOAL_OPTIONS.map((option) => (
            <label
              key={option.value}
              className={`mode-card ${goal === option.value ? "selected" : ""}`}
              data-testid={`goal-${option.value}`}
            >
              <input
                type="radio"
                name="goal"
                value={option.value}
                checked={goal === option.value}
                onChange={() => setGoal(option.value)}
              />
              <span className="mode-card-top">
                <span className="mode-card-dot" aria-hidden="true" />
                <span className="mode-card-title">{option.title}</span>
                {option.recommended ? <span className="chip chip-recommend">推荐</span> : null}
              </span>
              <span className="mode-card-desc">{option.desc}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <details
        className="advanced-options"
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen((event.target as HTMLDetailsElement).open)}
      >
        <summary>高级选项（研究领域、目标期刊等，可选）</summary>
        <div className="form-grid" style={{ marginTop: 12 }}>
          <div className="field">
            <label htmlFor="import-research-field">研究领域</label>
            <input
              id="import-research-field"
              value={researchField}
              onChange={(event) => setResearchField(event.target.value)}
              placeholder="如：信息检索"
              maxLength={LIMITS.researchField + 1}
            />
          </div>
          <div className="field">
            <label htmlFor="import-target-venue">目标期刊 / 会议</label>
            <input
              id="import-target-venue"
              value={targetVenue}
              onChange={(event) => setTargetVenue(event.target.value)}
              placeholder="如：SIGIR 2027"
              maxLength={LIMITS.targetVenue + 1}
            />
          </div>
          <div className="field">
            <label htmlFor="import-target-profile">目标定位</label>
            <select
              id="import-target-profile"
              value={targetProfile}
              onChange={(event) => setTargetProfile(event.target.value)}
            >
              <option value="">未指定</option>
              {TARGET_PROFILE_OPTIONS.map((optionItem) => (
                <option key={optionItem.value} value={optionItem.value}>
                  {optionItem.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="import-language">写作语言</label>
            <input
              id="import-language"
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
              placeholder="如：中文 / English（可选）"
              maxLength={LIMITS.language + 1}
            />
          </div>
        </div>
      </details>

      {validationError !== null ? (
        <p className="form-error" role="alert" data-testid="validation-error">
          {validationError}
        </p>
      ) : null}
      {importPdf.isError ? (
        <ErrorState title="导入失败" message={formatApiError(importPdf.error)} />
      ) : null}
      {importPdf.isSuccess ? (
        <p className="note note-success" role="status">
          <span>
            <span className="note-mark">✓</span> 论文已导入，正在进入项目…
          </span>
        </p>
      ) : null}

      <div className="form-actions">
        <Link to="/projects" className="btn">
          取消
        </Link>
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? "导入中…" : "导入论文"}
        </button>
      </div>
    </form>
  );
}
