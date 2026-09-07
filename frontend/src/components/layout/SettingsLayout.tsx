import { NavLink, Outlet } from "react-router-dom";

/**
 * 设置的二级导航：模型 / 外观 / 项目管理。
 * 设置在全局只有一个一级入口（侧栏「设置」），进入后在这里切换。
 */
const SUB_NAV: ReadonlyArray<{ to: string; label: string }> = [
  { to: "/settings/model", label: "模型设置" },
  { to: "/settings/appearance", label: "外观" },
  { to: "/settings/projects", label: "项目管理" },
];

export function SettingsLayout() {
  return (
    <section className="page">
      <nav className="settings-subnav" aria-label="设置导航" data-testid="settings-subnav">
        {SUB_NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end className={({ isActive }) => `settings-subnav-link${isActive ? " active" : ""}`}>
            {item.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </section>
  );
}
