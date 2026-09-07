import { Link, NavLink, Outlet, useLocation } from "react-router-dom";

import { AppErrorBoundary } from "../common/ErrorBoundary.js";
import { RuntimeStatusChip } from "../common/RuntimeStatusChip.js";
import { ThemeCycleButton } from "../common/ThemeControls.js";
import { useProjects, useRuntimeStatus } from "../../hooks/queries.js";
import { useUiStore } from "../../stores/uiStore.js";

/**
 * 应用外壳：浅色纸面侧栏 + 内容列。
 *
 * 侧栏只放真实可用的入口：论文项目 / Skills / 设置，加最近项目快捷入口；
 * 底部是环境指示灯与主题切换。品牌字标即"返回论文项目"。
 */

function ModelConfigBanner() {
  const { data, isPending, isError } = useRuntimeStatus();
  const dismissed = useUiStore((state) => state.modelBannerDismissed);
  const dismiss = useUiStore((state) => state.dismissModelBanner);

  if (isPending || isError || data === undefined || dismissed || data.model.phase !== "not_configured") {
    return null;
  }
  return (
    <div className="model-banner" role="status">
      <span>
        模型尚未配置。导入与解析论文不受影响；开始 Review 前请先在
        <Link to="/settings/model">模型设置</Link>
        保存模型与 API Key。
      </span>
      <button type="button" className="btn btn-small" onClick={dismiss}>
        知道了
      </button>
    </div>
  );
}

function PdfToolchainBanner() {
  const { data } = useRuntimeStatus();
  const pdf = data?.tools?.pdfParser;
  if (pdf === undefined || pdf.phase !== "unavailable") {
    return null;
  }
  return (
    <div className="model-banner model-banner-danger" role="alert">
      <span>
        未找到 PDF 解析依赖，导入论文会失败。{pdf.detail} 安装后无需重启，稍候会自动恢复。
      </span>
    </div>
  );
}

const navLinkClass = ({ isActive }: { isActive: boolean }) => `sidebar-link${isActive ? " active" : ""}`;

/** 最近项目（未归档，最多 5 个；列表未加载时不占位） */
function SidebarRecent() {
  const { data } = useProjects();
  if (data === undefined || data.length === 0) {
    return null;
  }
  return (
    <div className="sidebar-recent">
      <span className="sidebar-label">最近项目</span>
      {data.slice(0, 5).map((project) => (
        <NavLink
          key={project.id}
          to={`/projects/${project.id}`}
          className={({ isActive }) => `sidebar-recent-link${isActive ? " active" : ""}`}
          title={project.title}
        >
          {project.title}
        </NavLink>
      ))}
    </div>
  );
}

export function AppLayout() {
  const location = useLocation();
  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <Link to="/projects" className="sidebar-brand" aria-label="PaperTeam，返回论文项目" data-testid="brand-home">
          <span className="sidebar-brand-mark" aria-hidden="true">
            <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M4 2.5h9l3 3V17.5H4z" strokeLinejoin="round" />
              <path d="M7 8h6M7 11h6M7 14h4" strokeLinecap="round" />
            </svg>
          </span>
          <span className="sidebar-brand-name">PaperTeam</span>
        </Link>
        <nav className="sidebar-nav" aria-label="全局导航">
          <NavLink to="/projects" className={navLinkClass} end={false}>
            论文项目
          </NavLink>
          <NavLink to="/skills" className={navLinkClass}>
            Skills
          </NavLink>
          <NavLink to="/settings" className={navLinkClass}>
            设置
          </NavLink>
        </nav>
        <SidebarRecent />
        <div className="sidebar-footer">
          <RuntimeStatusChip />
          <ThemeCycleButton />
        </div>
      </aside>
      <div className="app-body">
        <PdfToolchainBanner />
        <ModelConfigBanner />
        <main className="app-main">
          <div className="app-main-inner">
            <AppErrorBoundary resetKey={location.pathname}>
              <Outlet />
            </AppErrorBoundary>
          </div>
        </main>
      </div>
    </div>
  );
}
