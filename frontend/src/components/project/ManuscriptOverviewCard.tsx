import { ErrorState } from "../common/StateViews.js";
import { Icon } from "../common/Icon.js";
import { useManuscriptOverview } from "../../hooks/queries.js";
import { formatApiError, formatApiErrorDetail } from "../../utils/errors.js";
import { formatDateTime } from "../../utils/format.js";
import type { ManuscriptOverviewView, WorkflowKind } from "../../types/api.js";

/**
 * 当前稿件信息卡（M7.0.3，项目概览首屏）。
 *
 * 让用户一眼明确「这里是你正在修改的论文稿件」——与「文献库」里的参考文献
 * PDF 相区分（Manuscript ≠ Literature Source）。全部事实来自 Backend 聚合
 * 视图（GET /api/projects/:id/manuscript 的 overview），前端不自行拼装。
 */

/** sourceType → 展示标签（与 Backend 判定口径一一对应） */
const SOURCE_TYPE_LABELS: Record<ManuscriptOverviewView["sourceType"], string> = {
  latex: "LaTeX 工程导入",
  pdf: "PDF 论文导入",
  generated: "系统生成稿件",
  none: "尚未创建稿件",
};

/** 快速 Review 只读不修改稿件，入口指向论文结构而非产出 */
function primaryTab(workflowKind: WorkflowKind | undefined): "paper" | "pdf" {
  return workflowKind === "existing_paper_review" ? "pdf" : "paper";
}

function primaryTabLabel(workflowKind: WorkflowKind | undefined): string {
  return workflowKind === "existing_paper_review" ? "查看论文结构" : "查看论文产出";
}

function buildText(build: ManuscriptOverviewView["build"]): string {
  if (build === null) {
    return "未构建";
  }
  if (build.stale) {
    return `已过期（构建于 rev ${build.revision}，之后稿件有修改）`;
  }
  const at = formatDateTime(build.checkedAt) ?? "";
  return `${build.passed ? "通过" : "失败"}${at !== "" ? `（${at}）` : ""}`;
}

export function ManuscriptOverviewCard({
  projectId,
  workflowKind,
  onOpenTab,
}: {
  projectId: string;
  workflowKind: WorkflowKind | undefined;
  onOpenTab: (tab: "paper" | "pdf") => void;
}) {
  const { data, isPending, isError, error, refetch } = useManuscriptOverview(projectId);

  return (
    <section className="panel section-block" data-testid="manuscript-card">
      <div className="section-head">
        <h2>当前稿件</h2>
        {data !== undefined ? <span className="chip chip-outline">{SOURCE_TYPE_LABELS[data.sourceType]}</span> : null}
      </div>
      {isPending ? <p className="panel-empty">加载中…</p> : null}
      {isError ? (
        <ErrorState title="稿件信息加载失败" message={formatApiError(error)} detail={formatApiErrorDetail(error)} onRetry={() => void refetch()} />
      ) : null}
      {data !== undefined ? (
        <>
          <p className="workflow-summary-line" data-testid="manuscript-title-line">
            「{data.title}」是本项目正在修改的论文稿件；「文献库」中的 PDF 是参考文献，不是稿件本身。
          </p>
          <dl className="meta-list meta-list-2col">
            <div>
              <dt>稿件来源</dt>
              <dd>{SOURCE_TYPE_LABELS[data.sourceType]}</dd>
            </div>
            <div>
              <dt>当前修订</dt>
              <dd>{data.currentRevision > 0 ? `rev ${data.currentRevision}` : "尚无修订"}</dd>
            </div>
            <div>
              <dt>章节</dt>
              <dd>{data.sectionCount > 0 ? `${data.sectionCount} 节` : "—"}</dd>
            </div>
            <div>
              <dt>参考文献</dt>
              <dd>{data.referenceCount > 0 ? `${data.referenceCount} 条` : "—"}</dd>
            </div>
            <div>
              <dt>构建状态</dt>
              <dd data-testid="manuscript-build">{buildText(data.build)}</dd>
            </div>
          </dl>
          {workflowKind === "existing_paper_review" ? (
            <p className="note note-info" style={{ marginTop: "var(--s-3)" }}>
              <span>快速 Review 只读分析现有论文，不修改稿件正文。</span>
            </p>
          ) : null}
          <button
            type="button"
            className="btn"
            style={{ marginTop: "var(--s-3)" }}
            onClick={() => onOpenTab(primaryTab(workflowKind))}
            data-testid="manuscript-goto"
          >
            {primaryTabLabel(workflowKind)}
            <Icon name="chevron-right" />
          </button>
        </>
      ) : null}
    </section>
  );
}
