import type { ReactNode } from "react";

/** 页头：面包屑（可选）+ 标题 + 一行说明 + 右侧主操作。level=2 用于设置等已有上级页头的二级页面 */
export function PageHeader({
  title,
  sub,
  actions,
  breadcrumb,
  level = 1,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
  level?: 1 | 2;
}) {
  return (
    <header className={`page-head${level === 2 ? " page-head-secondary" : ""}`}>
      <div className="page-head-text">
        {breadcrumb !== undefined ? <nav className="breadcrumb" aria-label="位置">{breadcrumb}</nav> : null}
        {level === 2 ? <h2 className="page-title page-title-secondary">{title}</h2> : <h1 className="page-title">{title}</h1>}
        {sub !== undefined ? <p className="page-sub">{sub}</p> : null}
      </div>
      {actions !== undefined ? <div className="action-row page-head-actions">{actions}</div> : null}
    </header>
  );
}
