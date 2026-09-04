import { useState, type ChangeEvent, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import { ErrorState } from "../components/common/StateViews.js";
import {
  DOCUMENT_TYPE_OPTIONS,
  TARGET_PROFILE_OPTIONS,
} from "../constants/projectMeta.js";
import { useCreateProject } from "../hooks/queries.js";
import type { CreateProjectInput, WorkflowKind } from "../types/api.js";

/**
 * 创建项目页（M4.2）。
 *
 * 表单字段与 Backend POST /api/projects 的 CreateProjectInput 一一对应；
 * 校验规则镜像 ProjectStore（title 必填 ≤200，researchIdea ≤8000 等），
 * 其余为可选。Existing-Paper 模式：Backend 已开放 LaTeX 导入 API
 * （POST /api/projects/:id/import），上传 UI 将在后续里程碑提供。
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

  return (
    <section className="page page-narrow">
      <div className="page-head">
        <div>
          <h1>New Project</h1>
          <p className="page-sub">
            <Link to="/projects">My Papers</Link> / 新建项目
          </p>
        </div>
      </div>

      <form className="form-card" onSubmit={onSubmit} noValidate>
        <fieldset className="form-section">
          <legend>工作流模式</legend>
          <div className="radio-cards">
            <label className={`radio-card ${form.workflowKind === "idea_to_paper" ? "selected" : ""}`}>
              <input
                type="radio"
                name="workflowKind"
                value="idea_to_paper"
                checked={form.workflowKind === "idea_to_paper"}
                onChange={update("workflowKind")}
              />
              <span className="radio-card-title">Idea → Paper</span>
              <span className="radio-card-desc">从研究想法出发，全流程生成论文</span>
            </label>
            <label
              className={`radio-card ${form.workflowKind === "existing_paper_improvement" ? "selected" : ""}`}
            >
              <input
                type="radio"
                name="workflowKind"
                value="existing_paper_improvement"
                checked={form.workflowKind === "existing_paper_improvement"}
                onChange={update("workflowKind")}
              />
              <span className="radio-card-title">已有论文改进</span>
              <span className="radio-card-desc">导入现有 LaTeX 论文并改进</span>
            </label>
          </div>
          {form.workflowKind === "existing_paper_improvement" ? (
            <p className="form-note" data-testid="import-note">
              创建后可通过 Backend 已开放的导入 API（POST /api/projects/:id/import，支持
              LaTeX 压缩包）导入现有论文；上传界面将在后续里程碑提供。
            </p>
          ) : null}
        </fieldset>

        <div className="form-field">
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

        <div className="form-field">
          <label htmlFor="researchIdea">研究想法（Research Idea）</label>
          <textarea
            id="researchIdea"
            name="researchIdea"
            rows={5}
            value={form.researchIdea}
            onChange={update("researchIdea")}
            placeholder="用一段话描述研究问题、动机与初步思路"
          />
        </div>

        <div className="form-row">
          <div className="form-field">
            <label htmlFor="researchField">研究领域</label>
            <input
              id="researchField"
              name="researchField"
              value={form.researchField}
              onChange={update("researchField")}
              placeholder="如：信息检索"
            />
          </div>
          <div className="form-field">
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

        <div className="form-row">
          <div className="form-field">
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
          <div className="form-field">
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
        </div>

        <div className="form-field">
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
