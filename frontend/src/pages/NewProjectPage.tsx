import { useState, type ChangeEvent, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import { ErrorState } from "../components/common/StateViews.js";
import { PageHeader } from "../components/common/PageHeader.js";
import {
  DOCUMENT_TYPE_OPTIONS,
  TARGET_PROFILE_OPTIONS,
} from "../constants/projectMeta.js";
import { useCreateProject } from "../hooks/queries.js";
import type { CreateProjectInput, WorkflowKind } from "../types/api.js";

/**
 * 创建项目页（Visual Redesign 2026-09）。
 *
 * 渐进式披露：先选「做什么」（两块模式卡），再按所选模式给出
 * 相关说明与字段侧重；字段集合本身与 POST /api/projects 的
 * CreateProjectInput 一一对应，校验规则镜像 ProjectStore。
 */

/** 与 Backend ProjectStore 一致的长度上限（前端提前拦截） */
const LIMITS = {
  title: 200,
  researchIdea: 8000,
  researchField: 200,
  targetVenue: 300,
  language: 50,
} as const;

interface FormState {
  title: string;
  workflowKind: WorkflowKind;
  researchIdea: string;
  researchField: string;
  documentType: string;
  targetProfile: string;
  targetVenue: string;
  language: string;
}

const INITIAL_FORM: FormState = {
  title: "",
  workflowKind: "idea_to_paper",
  researchIdea: "",
  researchField: "",
  documentType: "",
  targetProfile: "",
  targetVenue: "",
  language: "",
};

/** 返回错误文案；合法返回 null（只校验填写了的字段） */
function validate(form: FormState): string | null {
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
    return `目标 venue 不能超过 ${LIMITS.targetVenue} 个字符`;
  }
  if (form.language.trim().length > LIMITS.language) {
    return `写作语言不能超过 ${LIMITS.language} 个字符`;
  }
  return null;
}

/** 只提交非空字段（Backend 对空串视为「不设置」，显式裁剪更干净） */
function toInput(form: FormState): CreateProjectInput {
  const picked = (value: string): string | undefined => {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  };
  return {
    title: form.title.trim(),
    workflowKind: form.workflowKind,
    ...(picked(form.researchIdea) !== undefined ? { researchIdea: picked(form.researchIdea) } : {}),
    ...(picked(form.researchField) !== undefined ? { researchField: picked(form.researchField) } : {}),
    ...(picked(form.documentType) !== undefined ? { documentType: picked(form.documentType) } : {}),
    ...(picked(form.targetProfile) !== undefined ? { targetProfile: picked(form.targetProfile) } : {}),
    ...(picked(form.targetVenue) !== undefined ? { targetVenue: picked(form.targetVenue) } : {}),
    ...(picked(form.language) !== undefined ? { language: picked(form.language) } : {}),
  };
}

const MODE_HINTS: Record<WorkflowKind, { idea: string; placeholder: string }> = {
  idea_to_paper: {
    idea: "研究想法是 Idea → Paper 主线的起点：Researcher 会据此完成调研与可行性分析。",
    placeholder: "用一段话描述研究问题、动机与初步思路",
  },
  existing_paper_improvement: {
    idea: "可选。补充你希望改进的方向，便于后续审阅与改造。",
    placeholder: "可选：说明希望改进的方向（如实验、写作、引用）",
  },
};

export function NewProjectPage() {
  const navigate = useNavigate();
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
    const error = validate(form);
    setValidationError(error);
    if (error !== null) {
      return;
    }
    createProject.mutate(toInput(form), {
      onSuccess: (project) => {
        void navigate(`/projects/${project.id}`);
      },
    });
  };

  const submitting = createProject.isPending;
  const isExisting = form.workflowKind === "existing_paper_improvement";
  const ideaHint = MODE_HINTS[form.workflowKind];

  return (
    <section className="page page-narrow">
      <PageHeader
        title="New Project"
        breadcrumb={
          <>
            <Link to="/projects">My Papers</Link>
            <span className="crumb-sep" aria-hidden="true">/</span>
            <span>新建项目</span>
          </>
        }
      />

      <form className="panel" onSubmit={onSubmit} noValidate>
        <fieldset className="form-section">
          <legend>你想做什么？</legend>
          <p className="section-hint">选择工作流模式——创建后仍可补充下方任意字段。</p>
          <div className="mode-cards">
            <label className={`mode-card ${!isExisting ? "selected" : ""}`}>
              <input
                type="radio"
                name="workflowKind"
                value="idea_to_paper"
                checked={!isExisting}
                onChange={update("workflowKind")}
              />
              <span className="mode-card-top">
                <span className="mode-card-dot" aria-hidden="true" />
                <span className="mode-card-title">Idea → Paper</span>
              </span>
              <span className="mode-card-desc">
                从研究想法出发，经调研、证据、写作到评审，全流程生成论文。
              </span>
            </label>
            <label className={`mode-card ${isExisting ? "selected" : ""}`}>
              <input
                type="radio"
                name="workflowKind"
                value="existing_paper_improvement"
                checked={isExisting}
                onChange={update("workflowKind")}
              />
              <span className="mode-card-top">
                <span className="mode-card-dot" aria-hidden="true" />
                <span className="mode-card-title">已有论文改进</span>
              </span>
              <span className="mode-card-desc">
                导入现有论文（LaTeX 项目或最终 PDF），做引用核验、评审与系统性改进。
              </span>
            </label>
          </div>
          {isExisting ? (
            <div className="note note-warn" data-testid="import-note">
              <span>
                创建后即可导入现有论文：LaTeX 项目与最终 PDF 的上传界面将在后续里程碑提供，
                当前可经 Backend 已开放的 import API（POST /api/projects/:id/import）导入
                LaTeX 压缩包；最终 PDF 已可在工作区「PDF / Structure」上传。
              </span>
            </div>
          ) : null}
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
            <label htmlFor="researchIdea">研究想法（Research Idea）</label>
            <textarea
              id="researchIdea"
              name="researchIdea"
              rows={5}
              value={form.researchIdea}
              onChange={update("researchIdea")}
              placeholder={ideaHint.placeholder}
            />
            <span className="field-help">{ideaHint.idea}</span>
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
              <label htmlFor="targetVenue">目标 Venue</label>
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
              <select
                id="documentType"
                name="documentType"
                value={form.documentType}
                onChange={update("documentType")}
              >
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
              <select
                id="targetProfile"
                name="targetProfile"
                value={form.targetProfile}
                onChange={update("targetProfile")}
              >
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
          <ErrorState
            title="创建失败"
            message={
              createProject.error instanceof Error
                ? createProject.error.message
                : String(createProject.error)
            }
          />
        ) : null}

        <div className="form-actions">
          <Link to="/projects" className="btn">
            取消
          </Link>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? "创建中…" : "创建项目"}
          </button>
        </div>
      </form>
    </section>
  );
}
