import { Link, NavLink, Outlet, useLocation, useMatch } from "react-router-dom";

import { AppErrorBoundary } from "../common/ErrorBoundary.js";
import { Icon } from "../common/Icon.js";
import { RuntimeStatusChip } from "../common/RuntimeStatusChip.js";
import { ThemeCycleButton } from "../common/ThemeControls.js";
import { useProject, useProjects, useRuntimeStatus } from "../../hooks/queries.js";
import { useUiStore } from "../../stores/uiStore.js";

/**
 * 应用外壳：深色侧栏 + 内容列（顶栏 + 页面）。
 *
 * 侧栏只放真实可用的入口：论文项目 / Skills / 设置，加最近项目快捷入口；
 * 底部是运行环境指示。顶栏左侧是由路由推导的面包屑，右侧是主题切换与「新建项目」。
 * 品牌字标即"返回论文项目"。
 */

const RECENT_LIMIT = 5;

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
      <span>未找到 PDF 解析依赖，导入论文会失败。{pdf.detail} 安装后无需重启，稍候会自动恢复。</span>
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
      {data.slice(0, RECENT_LIMIT).map((project) => (
        <NavLink
          key={project.id}
          to={`/projects/${project.id}`}
          className={({ isActive }) => `sidebar-recent-link${isActive ? " active" : ""}`}
          title={project.title}
        >
          <Icon name="document" />
          <span className="sidebar-recent-title">{project.title}</span>
        </NavLink>
      ))}
      {data.length > RECENT_LIMIT ? (
        <Link to="/projects" className="sidebar-recent-link sidebar-recent-more">
          <Icon name="more" />
          <span className="sidebar-recent-title">更多项目</span>
        </Link>
      ) : null}
    </div>
  );
}

const SETTINGS_LABELS: Record<string, string> = {
  model: "模型设置",
  appearance: "外观",
  projects: "项目管理",
};

/** 顶栏面包屑：由当前路由推导（项目标题来自已缓存的项目查询） */
function TopbarBreadcrumb() {
  const location = useLocation();
  const projectMatch = useMatch("/projects/:projectId");
  const settingsMatch = useMatch("/settings/:section");
  const projectId = projectMatch?.params.projectId;
  const isProjectRoute = projectId !== undefined && projectId !== "new";
  const project = useProject(isProjectRoute ? projectId : undefined);

  let items: Array<{ label: string; to?: string }> = [];
  if (location.pathname === "/projects") {
    items = [{ label: "论文项目" }];
  } else if (location.pathname === "/projects/new") {
    items = [{ label: "论文项目", to: "/projects" }, { label: "新建项目" }];
  } else if (isProjectRoute) {
    items = [{ label: "论文项目", to: "/projects" }, { label: project.data?.title ?? "项目" }];
  } else if (location.pathname === "/skills") {
    items = [{ label: "Skills" }];
  } else if (location.pathname.startsWith("/settings")) {
    const section = settingsMatch?.params.section;
    items = section !== undefined && SETTINGS_LABELS[section] !== undefined ? [{ label: "设置", to: "/settings" }, { label: SETTINGS_LABELS[section] }] : [{ label: "设置" }];
  }

  if (items.length === 0) {
    return <div className="topbar-crumbs" />;
  }
  return (
    <nav className="topbar-crumbs" aria-label="位置">
      {items.map((item, index) => (
        <span key={`${index}-${item.label}`} className="topbar-crumb">
          {index > 0 ? (
            <span className="crumb-sep" aria-hidden="true">
              /
            </span>
          ) : null}
          {item.to !== undefined ? (
            <Link to={item.to}>{item.label}</Link>
          ) : (
            <span className="topbar-crumb-current" aria-current="page">
              {item.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

export function AppLayout() {
  const location = useLocation();
  // 项目列表与新建页自身已有「新建项目」入口，顶栏不重复
  const showCreate = location.pathname !== "/projects" && location.pathname !== "/projects/new";

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <Link to="/projects" className="sidebar-brand" aria-label="PaperTeam，返回论文项目" data-testid="brand-home">
          <span className="sidebar-brand-mark" aria-hidden="true" />
          <span className="sidebar-brand-text">
            <span className="sidebar-brand-name">PaperTeam</span>
            <span className="sidebar-brand-sub">Research with AI</span>
          </span>
        </Link>
        <nav className="sidebar-nav" aria-label="全局导航">
          <NavLink to="/projects" className={navLinkClass} end={false}>
            <Icon name="document" />
            <span>论文项目</span>
          </NavLink>
          <NavLink to="/skills" className={navLinkClass}>
            <Icon name="grid" />
            <span>Skills</span>
          </NavLink>
          <NavLink to="/settings" className={navLinkClass}>
            <Icon name="gear" />
            <span>设置</span>
          </NavLink>
        </nav>
        <SidebarRecent />
        <div className="sidebar-footer">
          <RuntimeStatusChip />
        </div>
      </aside>
      <div className="app-body">
        <header className="topbar">
          <TopbarBreadcrumb />
          <div className="topbar-actions">
            <ThemeCycleButton />
            {showCreate ? (
              <Link to="/projects/new" className="btn btn-primary">
                <Icon name="plus" />
                新建项目
              </Link>
            ) : null}
          </div>
        </header>
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
