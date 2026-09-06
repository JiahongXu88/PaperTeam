import { Link, NavLink, Outlet } from "react-router-dom";

import { RuntimeStatusChip } from "../common/RuntimeStatusChip.js";
import { useProjects, useRuntimeStatus } from "../../hooks/queries.js";
import { useUiStore } from "../../stores/uiStore.js";

/**
 * 应用布局（Visual Redesign 2026-09）：书脊式深墨侧栏 + 纸白内容区。
 *
 * 侧栏：品牌 → Workspace 导航（Projects / Skills）→ Recent 项目快捷入口
 * （真实 listProjects 数据）→ 底部 Settings 与 Runtime 状态指示灯。
 */

function ModelConfigBanner() {
  const { data, isPending, isError } = useRuntimeStatus();
  const dismissed = useUiStore((state) => state.modelBannerDismissed);
  const dismiss = useUiStore((state) => state.dismissModelBanner);

  if (isPending || isError || data === undefined || dismissed) {
    return null;
  }
  if (data.model.phase !== "not_configured") {
    return null;
  }
  return (
    <div className="model-banner" role="status">
      <span>
        Runtime 正常，但模型尚未配置。可在
        <Link to="/settings/model">「模型设置」</Link>
        保存模型与 API Key，之后再开始需要模型的任务。
      </span>
      <button type="button" className="btn btn-small" onClick={dismiss}>
        知道了
      </button>
    </div>
  );
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `sidebar-link${isActive ? " active" : ""}`;

/** 最近项目快捷入口（真实数据，最多 5 个；仅列表已有缓存时渲染） */
function SidebarRecent() {
  const { data } = useProjects();
  if (data === undefined || data.length === 0) {
    return null;
  }
  return (
    <div className="sidebar-recent">
      <span className="sidebar-label">最近项目</span>
      {data.slice(0, 5).map((project) => (
        <Link key={project.id} to={`/projects/${project.id}`} className="sidebar-recent-link" title={project.title}>
          {project.title}
        </Link>
      ))}
    </div>
  );
}

export function AppLayout() {
  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <Link to="/projects" className="sidebar-brand">
          <span className="sidebar-brand-name">PaperTeam</span>
          <span className="sidebar-brand-sub">Research Workbench</span>
        </Link>
        <nav className="sidebar-nav" aria-label="全局导航">
          <NavLink to="/projects" className={navLinkClass}>
            <span className="link-text">论文项目</span>
          </NavLink>
          <NavLink to="/skills" className={navLinkClass}>
            <span className="link-text">Skills</span>
          </NavLink>
        </nav>
        <SidebarRecent />
        <div className="sidebar-footer">
          <NavLink to="/settings/model" className={navLinkClass}>
            <span className="link-text">设置</span>
          </NavLink>
          <RuntimeStatusChip />
        </div>
      </aside>
      <div className="app-body">
        <ModelConfigBanner />
        <main className="app-main">
          <div className="app-main-inner">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
