import { PaperPreview } from "./PaperPreview.js";
import { Link } from "react-router-dom";

import { Icon } from "../common/Icon.js";
import { RegistryStatus } from "../common/StatusBadge.js";
import { EXTRACTION_QUALITY_STYLES, statusStyleOf } from "../common/status.js";
import { ProjectStatusBadge } from "./Badges.js";
import { WORKFLOW_KIND_LABELS } from "../../constants/projectMeta.js";
import {
  isRunActive,
  useCitations,
  useCitationIntegrity,
  useCreateWorkflowRun,
  useExportReviewReport,
  useExtractCitations,
  usePaper,
  usePaperReviewReport,
  useProjectRuns,
  useRuntimeStatus,
} from "../../hooks/queries.js";
import { formatApiError } from "../../utils/errors.js";
import { formatBytes, formatDateTime } from "../../utils/format.js";
import type { ProjectView, WorkflowKind } from "../../types/api.js";

/**
 * 项目右侧栏（所有标签页共用）：只放真实存在的信息与动作。
 *   论文信息：PDF 文件、页数 / 章节、大小、解析质量、领域、状态、时间
 *   下一步：由 PDF / 引用 / Review 的真实状态推导（跳到对应标签页）
 *   快捷操作：开始 / 重新 Review、导出 Review 报告（.md）、提取引用
 *   引用核验：参考文献 / 正文引用 / 真实性核验概况
 * 不存在的能力（下载 PDF、分享、笔记、对话式分析）不做入口。
 */

export type AsideTab = "pdf" | "evidence" | "citations" | "review" | "workflow";

export function isExistingPaper(kind: WorkflowKind | undefined): boolean {
  return kind === "existing_paper_improvement" || kind === "existing_paper_review";
}

export function ProjectAside({ project, onOpenTab }: { project: ProjectView; onOpenTab: (tab: AsideTab) => void }) {
  const paper = usePaper(project.id);
  const citations = useCitations(project.id);
  const integrity = useCitationIntegrity(project.id);
  const reviewReport = usePaperReviewReport(project.id);
  const runs = useProjectRuns(project.id);
  const runtimeStatus = useRuntimeStatus();
  const startReview = useCreateWorkflowRun();
  const exportReport = useExportReviewReport(project.id);
  const extract = useExtractCitations(project.id);

  const doc = paper.data?.document;
  const hasDoc = doc !== null && doc !== undefined;
  const summary = citations.data?.summary;
  const citationsReady = summary !== undefined && summary.extracted;
  const report = integrity.data?.report ?? undefined;
  const semanticTotal = report?.semantic?.total ?? 0;
  const hasReport = reviewReport.data !== null && reviewReport.data !== undefined;
  const reviewAvailable = isExistingPaper(project.workflowKind);
  const reviewRun = runs.data?.find((run) => run.workflowKind === "existing_paper_review");
  const reviewActive = isRunActive(reviewRun);
  const modelConfigured = runtimeStatus.data?.model.phase === "configured";

  const nextSteps: Array<{ label: string; tab: AsideTab }> = [];
  // HITL 待确认最优先：任何工作流停在 awaiting_input 时，进入项目即可看到入口
  const awaitingRun = runs.data?.find((run) => isRunActive(run) && run.status === "awaiting_input");
  if (awaitingRun !== undefined) {
    nextSteps.push({ label: "有 1 个任务等待确认", tab: "workflow" });
  }
  if (!paper.isPending && !hasDoc) {
    nextSteps.push({ label: "上传论文 PDF", tab: "pdf" });
  } else if (reviewAvailable && !reviewReport.isPending && !hasReport && !reviewActive) {
    nextSteps.push({ label: "开始 Review（引用核验 + 分章节审阅）", tab: "review" });
  }
  if (hasDoc && !citations.isPending && !citationsReady) {
    nextSteps.push({ label: "提取并核验引用", tab: "citations" });
  }
  if (citationsReady && !integrity.isPending && semanticTotal === 0) {
    nextSteps.push({ label: "语义核验引用是否支持论断", tab: "citations" });
  }

  const checkedTotal = report?.metadataByStatus !== undefined ? Object.values(report.metadataByStatus).reduce((sum, count) => sum + count, 0) : 0;

  return (
    <aside className="workspace-aside" aria-label="项目概要" data-testid="project-aside">
      <section className="aside-card">
        <div className="aside-paper">
          <span className="aside-paper-icon" aria-hidden="true">
            <Icon name="file-pdf" />
          </span>
          <div className="aside-paper-text">
            <h2 className="aside-paper-name">论文信息</h2>
            <span className="aside-paper-meta">
              {paper.isPending
                ? "加载中…"
                : hasDoc
                  ? `PDF · ${doc.pageCount} 页 · ${formatBytes(doc.bytes)}`
                  : "尚未上传论文 PDF"}
            </span>
          </div>
        </div>
        {hasDoc && <PaperPreview title={doc.title ?? project.title} />}
        <dl className="info-rows">
          {hasDoc ? (
            <>
              <dt>文件</dt>
              <dd className="mono" title={doc.originalFileName}>
                {doc.originalFileName}
              </dd>
              <dt>结构</dt>
              <dd>
                {doc.sectionCount} 节 · {doc.chunkCount} 个文本块
              </dd>
              <dt>解析质量</dt>
              <dd>
                <RegistryStatus style={statusStyleOf(EXTRACTION_QUALITY_STYLES, doc.parse.extractionQuality)} />
              </dd>
            </>
          ) : null}
          {project.researchField ? (
            <>
              <dt>领域</dt>
              <dd>{project.researchField}</dd>
            </>
          ) : null}
          <dt>类型</dt>
          <dd>{WORKFLOW_KIND_LABELS[project.workflowKind ?? "idea_to_paper"]}</dd>
          <dt>状态</dt>
          <dd>
            <ProjectStatusBadge status={project.status} />
          </dd>
          <dt>创建时间</dt>
          <dd>{formatDateTime(project.createdAt) ?? "—"}</dd>
          <dt>更新时间</dt>
          <dd>{formatDateTime(project.updatedAt) ?? "—"}</dd>
        </dl>
        {hasDoc && <button type="button" className="btn btn-primary btn-block" onClick={() => onOpenTab("pdf")}><Icon name="book" />查看论文结构</button>}
        {!paper.isPending && !hasDoc ? (
          <button type="button" className="btn btn-primary btn-block" onClick={() => onOpenTab("pdf")}>
            <Icon name="upload" />
            上传论文 PDF
          </button>
        ) : null}
      </section>

      {nextSteps.length > 0 ? (
        <section className="aside-card aside-section">
          <h2 className="aside-title">下一步</h2>
          <div className="aside-actions">
            {nextSteps.slice(0, 2).map((step) => (
              <button key={step.label} type="button" className="aside-next-item" onClick={() => onOpenTab(step.tab)}>
                {step.label}
                <Icon name="chevron-right" />
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {hasDoc ? (
        <section className="aside-card aside-section">
          <h2 className="aside-title">快捷操作</h2>
          <div className="aside-actions">
            {reviewAvailable && !reviewActive ? (
              <button
                type="button"
                className="btn btn-block"
                onClick={() => startReview.mutate({ projectId: project.id, kind: "existing_paper_review" })}
                disabled={startReview.isPending || !modelConfigured}
                title={modelConfigured ? undefined : "需要先在「设置 → 模型设置」配置模型"}
                data-testid="aside-start-review"
              >
                <Icon name={hasReport ? "refresh" : "play"} />
                {startReview.isPending ? "启动中…" : hasReport ? "开始新一轮 Review" : "开始 Review"}
              </button>
            ) : null}
            {reviewAvailable && reviewActive ? (
              <button type="button" className="btn btn-block" onClick={() => onOpenTab("workflow")}>
                <Icon name="clock" />
                查看任务进度
              </button>
            ) : null}
            {hasReport ? (
              <button type="button" className="btn btn-block" onClick={() => exportReport.mutate()} disabled={exportReport.isPending} title="下载完整 Review 报告（Markdown，UTF-8）">
                <Icon name="download" />
                {exportReport.isPending ? "导出中…" : "导出 Review 报告"}
              </button>
            ) : null}
            {!citationsReady && !citations.isPending ? (
              <button type="button" className="btn btn-block" onClick={() => extract.mutate()} disabled={extract.isPending}>
                <Icon name="list" />
                {extract.isPending ? "提取引用中…" : "提取引用"}
              </button>
            ) : null}
          </div>
          {startReview.isError ? (
            <p className="form-error" role="alert">
              启动失败：{formatApiError(startReview.error)}
            </p>
          ) : null}
          {exportReport.isError ? (
            <p className="form-error" role="alert">
              导出失败：{formatApiError(exportReport.error)}
            </p>
          ) : null}
          {extract.isError ? (
            <p className="form-error" role="alert">
              提取失败：{formatApiError(extract.error)}
            </p>
          ) : null}
          {!modelConfigured && reviewAvailable && !reviewActive && runtimeStatus.data !== undefined ? (
            <p className="field-help">
              模型未配置，Review 暂不可用。<Link to="/settings/model">前往模型设置</Link>
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="aside-card aside-section">
        <h2 className="aside-title">
          <button type="button" className="aside-title-link" onClick={() => onOpenTab("citations")}>
            引用核验
            <Icon name="chevron-right" />
          </button>
        </h2>
        <dl className="kv">
          {citations.isPending ? (
            <div className="kv-row">
              <dt>状态</dt>
              <dd className="muted">加载中…</dd>
            </div>
          ) : !citationsReady ? (
            <div className="kv-row">
              <dt>状态</dt>
              <dd>
                <span className="status">未提取</span>
              </dd>
            </div>
          ) : (
            <>
              <div className="kv-row">
                <dt>参考文献</dt>
                <dd>{summary.references} 条</dd>
              </div>
              <div className="kv-row">
                <dt>正文引用</dt>
                <dd>{summary.callouts} 处</dd>
              </div>
              {summary.unresolvedRelations > 0 ? (
                <div className="kv-row">
                  <dt>待关联</dt>
                  <dd>{summary.unresolvedRelations}</dd>
                </div>
              ) : null}
              <div className="kv-row">
                <dt>真实性核验</dt>
                <dd>{checkedTotal > 0 ? `${checkedTotal} / ${summary.references}` : <span className="muted">未开始</span>}</dd>
              </div>
              <div className="kv-row">
                <dt>语义核验</dt>
                <dd>{semanticTotal > 0 ? `${semanticTotal} 条` : <span className="muted">未开始</span>}</dd>
              </div>
            </>
          )}
        </dl>
      </section>
    </aside>
  );
}
