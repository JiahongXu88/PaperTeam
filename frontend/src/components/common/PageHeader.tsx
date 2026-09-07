import type { ReactNode } from "react";

/** 页头：面包屑（可选）+ 衬线标题 + 一行说明 + 右侧主操作 */
export function PageHeader({
  title,
  sub,
  actions,
  breadcrumb,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        {breadcrumb !== undefined ? <nav className="breadcrumb" aria-label="位置">{breadcrumb}</nav> : null}
        <h1 className="page-title">{title}</h1>
        {sub !== undefined ? <p className="page-sub">{sub}</p> : null}
      </div>
      {actions !== undefined ? <div className="action-row page-head-actions">{actions}</div> : null}
    </header>
  );
}
