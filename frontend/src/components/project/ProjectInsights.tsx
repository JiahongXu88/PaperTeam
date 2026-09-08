import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { usePaper, usePaperReviewReport, useCitations, useProjectRuns, useInvalidateReviewOutputs, isRunActive } from "../../hooks/queries.js";
import { formatDateTime } from "../../utils/format.js";
import { RunStatusBadge } from "./Badges.js";
import { Icon } from "../common/Icon.js";

export function ProjectInsights({ projectId }: { projectId: string }) {
  const paper = usePaper(projectId);
  const report = usePaperReviewReport(projectId);
  const citations = useCitations(projectId);
  const runs = useProjectRuns(projectId);
  const doc = paper.data?.document;
  const review = report.data?.review;
  const active = isRunActive(runs.data?.find(run => run.workflowKind === "existing_paper_review"));
  const invalidateOutputs = useInvalidateReviewOutputs(projectId);
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active) invalidateOutputs();
    wasActive.current = active;
  }, [active, invalidateOutputs]);
  const summary = citations.data?.summary;
  return <div className="project-insights">
    <div className="project-milestones">
      <Link to={`/projects/${projectId}?tab=pdf`}><Icon name="file-pdf" /><span>论文文档<strong>{doc ? `${doc.pageCount} 页 · ${doc.sectionCount} 节` : paper.isError ? "暂时无法读取" : paper.isPending ? "加载中…" : "待导入 PDF"}</strong></span></Link>
      <Link to={`/projects/${projectId}?tab=review`}><Icon name="check-circle" /><span>Review<strong>{active ? "审阅进行中" : review ? `已审阅 ${review.sectionsReviewed} / ${review.sectionsTotal} 节` : report.isError ? "暂时无法读取" : report.isPending ? "加载中…" : "尚未审阅"}</strong></span></Link>
      <Link to={`/projects/${projectId}?tab=citations`}><Icon name="link" /><span>引用核验<strong>{summary?.extracted ? `${summary.references} 条文献 · ${summary.callouts} 处引用` : citations.isError ? "暂时无法读取" : citations.isPending ? "加载中…" : "尚未提取"}</strong></span></Link>
    </div>
    {review && <div className="project-findings-summary"><span>审阅发现 <strong>{review.findingsTotal}</strong></span>{([['critical','严重'],['major','主要'],['minor','次要'],['info','提示']] as const).map(([key,label]) => <span key={key} className={`mini-severity mini-${key}`}><i />{label} <b>{review.bySeverity[key] ?? 0}</b></span>)}<Link to={`/projects/${projectId}?tab=review`}>查看报告 <Icon name="chevron-right" /></Link></div>}
  </div>;
}

export function RecentActivity({ projectId, createdAt }: { projectId: string; createdAt: string }) {
  const runs = useProjectRuns(projectId);
  return <section className="home-activity card card-pad"><div className="section-head"><h2>最近活动</h2><Icon name="clock" /></div><p className="panel-sub">当前论文的工作记录</p><ol className="activity-list">
    {runs.isError && <li>任务记录暂时无法读取</li>}
    {runs.data?.slice(0,3).map(run => <li key={run.runId}><i /><div><span>{run.workflowKind === 'existing_paper_review' ? '论文 Review' : run.workflowKind === 'existing_paper_improvement' ? '论文改进' : '论文生成'}</span><time>{formatDateTime(run.updatedAt)}</time></div><RunStatusBadge status={run.status} /></li>)}
    <li><i /><div><span>创建论文项目</span><time>{formatDateTime(createdAt)}</time></div></li>
  </ol><Link className="home-text-link" to={`/projects/${projectId}`}>查看项目记录 <Icon name="chevron-right" /></Link></section>;
}
