import { NavLink, Outlet } from "react-router-dom";

/**
 * Settings 二级导航（Project Entry & Lifecycle UX 2026-09）。
 *
 * 设置只有一个全局一级入口（侧栏「设置」），进入后在此切换：
 *   /settings/model     模型设置
 *   /settings/projects  项目管理（已归档项目：恢复 / 永久删除）
 */
const SUB_NAV: ReadonlyArray<{ to: string; label: string; end?: boolean }> = [
  { to: "/settings/model", label: "模型设置", end: true },
  { to: "/settings/projects", label: "项目管理", end: true },
];

export function SettingsLayout() {
  return (
    <section className="page">
      <nav className="settings-subnav" aria-label="设置导航" data-testid="settings-subnav">
        {SUB_NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `settings-subnav-link ${isActive ? "active" : ""}`}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </section>
  );
}
