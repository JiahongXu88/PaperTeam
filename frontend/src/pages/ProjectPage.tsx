import { Link, useSearchParams, useParams } from "react-router-dom";

import { ErrorState, Loading } from "../components/common/StateViews.js";
import { ProjectStatusBadge, RunStatusBadge, WorkflowKindBadge } from "../components/project/Badges.js";
import { CitationsPanel } from "../components/project/CitationsPanel.js";
import { PdfPanel } from "../components/project/PdfPanel.js";
import { optionLabel, DOCUMENT_TYPE_OPTIONS, TARGET_PROFILE_OPTIONS } from "../constants/projectMeta.js";
import { useCitations, useCitationIntegrity, usePaper, useProject, useProjectRuns } from "../hooks/queries.js";
import { ApiError } from "../api/client.js";
import { formatApiError } from "../utils/errors.js";
import { formatDateTime } from "../utils/format.js";
import type { PaperDocSummary } from "../types/paper.js";

/**
 * Project Workspace（Visual Redesign 2026-09 / UX Polish 2026-09）。
 *
 * 结构：衬线标题 + 状态 → 项目级导航（当前只暴露真正可用的模块，
 * 规划中的 Workflow/Evidence/Review/Artifacts 不占一级导航）→ 内容。
 * 当前 Tab 进入 URL（?tab=），刷新 / 分享链接可恢复；无效值回退概览。
 */

type TabId = "overview" | "pdf" | "citations" | "workflow" | "evidence" | "review" | "artifacts";

interface TabEntry {
  id: TabId;
  label: string;
  milestone?: string;
}

/** 全量 Tab 定义（含未开放模块；未开放项暂不在一级导航渲染，里程碑完成后恢复） */
const TABS: ReadonlyArray<TabEntry> = [
  { id: "overview", label: "概览" },
  { id: "pdf", label: "PDF 与结构" },
  { id: "citations", label: "引用核验" },
  { id: "workflow", label: "工作流", milestone: "M4.4" },
  { id: "evidence", label: "证据", milestone: "M4.5" },
  { id: "review", label: "审稿 / 质量门禁", milestone: "M4.6" },
  { id: "artifacts", label: "草稿 / 最终 PDF", milestone: "M4.7" },
];

/** 一级导航只渲染当前真实可用的模块 */
const VISIBLE_TABS: ReadonlyArray<TabEntry> = TABS.filter((entry) => entry.milestone === undefined);

const COMING_DESCRIPTION: Record<string, string> = {
  workflow: "启动与跟踪工作流运行：阶段进度、等待确认、取消与恢复。",
  evidence: "研究证据库：文献检索结果、PDF 文本层分析与派生上下文。",
  review: "Reviewer 三路审阅与质量门禁结论、修订循环状态。",
  artifacts: "草稿与最终交付物：LaTeX 源、编译产物与版本历史。",
};

type OpenableTab = "pdf" | "citations";

/** URL ?tab= → TabId（仅接受已开放的 Tab；缺失 / 未开放 / 非法值回退概览） */
function tabFromParam(param: string | null): TabId {
  const found = VISIBLE_TABS.find((entry) => entry.id === param);
  return found !== undefined ? found.id : "overview";
}

/** WorkflowRun 完成标签（completion.label）→ 中文 */
const COMPLETION_LABELS: Record<string, string> = {
  final: "最终稿",
  draft: "草稿",
};

function ProjectRunsPanel({ projectId }: { projectId: string }) {
  const { data, isPending, isError, error, refetch } = useProjectRuns(projectId);

  if (isPending) {
    return <Loading label="加载工作流运行记录…" />;
  }
  if (isError) {
    return (
      <ErrorState
        title="运行记录加载失败"
        message={formatApiError(error)}
        onRetry={() => void refetch()}
      />
    );
  }
  if (data === undefined || data.length === 0) {
    return <p className="panel-empty">尚未开始工作流。运行界面即将开放。</p>;
  }
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>运行</th>
            <th>状态</th>
            <th>当前阶段</th>
            <th>完成</th>
            <th>更新时间</th>
          </tr>
        </thead>
        <tbody>
          {data.map((run) => (
            <tr key={run.runId}>
              <td className="mono">{run.runId}</td>
              <td>
                <RunStatusBadge status={run.status} />
              </td>
              <td>{run.currentStage ?? "—"}</td>
              <td>{run.completion !== undefined && run.completion !== null ? (COMPLETION_LABELS[run.completion.label] ?? run.completion.label) : "—"}</td>
              <td className="muted">{formatDateTime(run.updatedAt) ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 侧栏：文档与引用状态摘要（真实查询；标题可跳转到对应 tab） */
function WorkspaceAside({
  projectId,
  onOpenTab,
}: {
  projectId: string;
  onOpenTab: (tab: OpenableTab) => void;
}) {
  const paper = usePaper(projectId);
  const citations = useCitations(projectId);
  const integrity = useCitationIntegrity(projectId);

  const doc: PaperDocSummary | null | undefined = paper.data?.document;
  const summary = citations.data?.summary;
  const citationsReady = summary !== undefined && summary.extracted;
  const semanticTotal = integrity.data?.report?.semantic.total ?? 0;

  // 下一步建议：由真实状态推导，最多两条
  const nextSteps: Array<{ label: string; tab: OpenableTab }> = [];
  if (!paper.isPending && (doc === null || doc === undefined)) {
    nextSteps.push({ label: "上传最终 PDF", tab: "pdf" });
  }
  if (!citations.isPending && !citationsReady) {
    nextSteps.push({ label: "提取并核验引用", tab: "citations" });
  }
  if (citationsReady && !integrity.isPending && semanticTotal === 0) {
    nextSteps.push({ label: "语义核验引用是否支持论断", tab: "citations" });
  }

  return (
    <aside className="workspace-aside">
      {nextSteps.length > 0 ? (
        <div className="aside-block">
          <h2 className="aside-title">下一步</h2>
          <div className="aside-next">
            {nextSteps.map((step) => (
              <button
                key={step.label}
                type="button"
                className="aside-next-item"
                onClick={() => onOpenTab(step.tab)}
              >
                {step.label}
                <span className="aside-next-arrow" aria-hidden="true">›</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="aside-block">
        <button
          type="button"
          className="aside-title aside-title-link"
          onClick={() => onOpenTab("pdf")}
          title="打开 PDF 与结构"
        >
          最终 PDF <span className="aside-next-arrow" aria-hidden="true">›</span>
        </button>
        <dl className="aside-rows">
          {paper.isPending ? (
            <div className="aside-row">
              <dt>状态</dt>
              <dd className="muted">加载中…</dd>
            </div>
          ) : doc === null || doc === undefined ? (
            <button type="button" className="aside-row-click" onClick={() => onOpenTab("pdf")}>
              <span className="ck-label">状态</span>
              <span className="ck-value">
                <span className="status status-tone-neutral">未上传</span>
              </span>
            </button>
          ) : (
            <>
              <div className="aside-row">
                <dt>规模</dt>
                <dd>
                  <span className="aside-value">{doc.pageCount}</span> 页 ·{" "}
                  <span className="aside-value">{doc.sectionCount}</span> 节
                </dd>
              </div>
              <div className="aside-row">
                <dt>文档</dt>
                <dd className="mono" title={doc.originalFileName}>
                  {doc.originalFileName}
                </dd>
              </div>
              <div className="aside-row">
                <dt>解析质量</dt>
                <dd>
                  <span className={`status status-tone-${doc.parse.extractionQuality === "good" ? "ok" : doc.parse.extractionQuality === "partial" ? "warn" : "danger"}`}>
                    {doc.parse.extractionQuality === "good" ? "良好" : doc.parse.extractionQuality === "partial" ? "部分" : "较差"}
                  </span>
                </dd>
              </div>
            </>
          )}
        </dl>
      </div>

      <div className="aside-block">
        <button
          type="button"
          className="aside-title aside-title-link"
          onClick={() => onOpenTab("citations")}
          title="打开引用核验"
        >
          引用核验 <span className="aside-next-arrow" aria-hidden="true">›</span>
        </button>
        <dl className="aside-rows">
          {citations.isPending ? (
            <div className="aside-row">
              <dt>状态</dt>
              <dd className="muted">加载中…</dd>
            </div>
          ) : !citationsReady ? (
            <button type="button" className="aside-row-click" onClick={() => onOpenTab("citations")}>
              <span className="ck-label">状态</span>
              <span className="ck-value">
                <span className="status status-tone-neutral">未提取</span>
              </span>
            </button>
          ) : (
            <>
              <div className="aside-row">
                <dt>参考文献条目</dt>
                <dd>
                  <span className="aside-value">{summary.references}</span>
                </dd>
              </div>
              <div className="aside-row">
                <dt>正文引用</dt>
                <dd>
                  <span className="aside-value">{summary.callouts}</span>
                </dd>
              </div>
              {summary.unresolvedRelations > 0 ? (
                <div className="aside-row">
                  <dt>待关联</dt>
                  <dd>
                    <span className="aside-value">{summary.unresolvedRelations}</span>
                  </dd>
                </div>
              ) : null}
            </>
          )}
        </dl>
      </div>
    </aside>
  );
}

function ComingPanel({ entry }: { entry: TabEntry }) {
  return (
    <div className="panel-coming">
      <span className="coming-tag">{entry.milestone}</span>
      <strong>{entry.label}</strong>
      <span>{COMING_DESCRIPTION[entry.id]}</span>
      <span className="faint">即将开放，当前暂不可用。</span>
    </div>
  );
}

export function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  // Tab 状态进入 URL（?tab=overview|pdf|citations）：刷新 / 复制链接可恢复
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = tabFromParam(searchParams.get("tab"));
  const setTab = (next: TabId) => {
    setSearchParams(next === "overview" ? {} : { tab: next });
  };
  const { data, isPending, isError, error, refetch } = useProject(projectId);

  if (isPending) {
    return (
      <section className="page">
        <Loading label="加载项目…" />
      </section>
    );
  }

  if (isError) {
    const notFound = error instanceof ApiError && error.isNotFound;
    return (
      <section className="page">
        <ErrorState
          title={notFound ? "项目不存在" : "项目加载失败"}
          message={
            notFound
              ? `找不到项目 ${projectId}（可能已被删除，或链接有误）。`
              : formatApiError(error)
          }
          onRetry={notFound ? undefined : () => void refetch()}
        />
        <p>
          <Link to="/projects" className="btn">
            ← 返回项目列表
          </Link>
        </p>
      </section>
    );
  }

  const project = data!;
  const meta = [
    project.researchField,
    optionLabel(DOCUMENT_TYPE_OPTIONS, project.documentType),
    optionLabel(TARGET_PROFILE_OPTIONS, project.targetProfile),
    project.targetVenue,
    project.language,
  ].filter((part): part is string => part !== undefined && part !== "");

  return (
    <section className="page">
      <div>
        <h1 className="workspace-title">{project.title}</h1>
        <div className="workspace-badges">
          <WorkflowKindBadge kind={project.workflowKind} />
          <ProjectStatusBadge status={project.status} />
        </div>
        <div className="workspace-meta">
          <span>创建 {formatDateTime(project.createdAt)} · 更新 {formatDateTime(project.updatedAt)}</span>
          <span className="id-chip" title="项目 ID（技术标识）">
            {project.id}
          </span>
        </div>
      </div>

      <nav className="tabs" role="tablist" aria-label="项目工作区">
        {VISIBLE_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={`tab ${tab === entry.id ? "active" : ""}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {tab === "overview" ? (
        <div className="workspace-grid">
          <div className="panel-stack">
            <section>
              <div className="section-head">
                <h2>研究定位</h2>
              </div>
              {meta.length > 0 ? (
                <dl className="meta-list meta-list-2col">
                  {project.researchField ? (
                    <div>
                      <dt>研究领域</dt>
                      <dd>{project.researchField}</dd>
                    </div>
                  ) : null}
                  {project.documentType ? (
                    <div>
                      <dt>论文类型</dt>
                      <dd>{optionLabel(DOCUMENT_TYPE_OPTIONS, project.documentType)}</dd>
                    </div>
                  ) : null}
                  {project.targetProfile ? (
                    <div>
                      <dt>目标定位</dt>
                      <dd>{optionLabel(TARGET_PROFILE_OPTIONS, project.targetProfile)}</dd>
                    </div>
                  ) : null}
                  {project.targetVenue ? (
                    <div>
                      <dt>目标期刊 / 会议</dt>
                      <dd>{project.targetVenue}</dd>
                    </div>
                  ) : null}
                  {project.language ? (
                    <div>
                      <dt>写作语言</dt>
                      <dd>{project.language}</dd>
                    </div>
                  ) : null}
                </dl>
              ) : (
                <p className="panel-empty">尚未填写研究定位字段（编辑界面即将提供）。</p>
              )}
              {project.researchIdea ? (
                <div className="idea-block">
                  <h3>研究想法</h3>
                  <p className="prewrap">{project.researchIdea}</p>
                </div>
              ) : null}
              {project.workflowKind === "existing_paper_improvement" ? (
                <p className="note note-info" style={{ marginTop: 16 }}>
                  <span>
                    已有论文改进模式：在「PDF 与结构」上传论文最终 PDF 后即可提取并核验引用；
                    LaTeX 项目导入与改进流程界面将在后续里程碑提供。
                  </span>
                </p>
              ) : null}
            </section>

            <section>
              <div className="section-head">
                <h2>工作流运行记录</h2>
              </div>
              <ProjectRunsPanel projectId={project.id} />
            </section>
          </div>

          <WorkspaceAside projectId={project.id} onOpenTab={setTab} />
        </div>
      ) : tab === "pdf" ? (
        <PdfPanel projectId={project.id} />
      ) : tab === "citations" ? (
        <CitationsPanel projectId={project.id} />
      ) : (
        <ComingPanel entry={TABS.find((entry) => entry.id === tab)!} />
      )}
    </section>
  );
}
