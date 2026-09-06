import type { ReactNode } from "react";

/**
 * 页头（Visual Redesign 2026-09）：标题 + 说明 + 右侧主操作。
 * 面包屑由调用方以 children 传入（保持各页面自由度）。
 */
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
        {breadcrumb !== undefined ? <div className="breadcrumb">{breadcrumb}</div> : null}
        <h1 className="page-title">{title}</h1>
        {sub !== undefined ? <p className="page-sub">{sub}</p> : null}
      </div>
      {actions !== undefined ? <div className="action-row">{actions}</div> : null}
    </header>
  );
}
