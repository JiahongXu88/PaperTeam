import type { ReactNode } from "react";

/** 加载 / 错误（可重试，技术细节可折叠）/ 空态 —— 全应用统一的三种非成功状态 */

export function Loading({ label = "加载中…" }: { label?: string }) {
  return (
    <div className="state-block" role="status" aria-live="polite">
      <span className="loading-line">
        <span className="spinner" aria-hidden="true" />
        <span>{label}</span>
      </span>
    </div>
  );
}

export function ErrorState({
  title = "加载失败",
  message,
  detail,
  onRetry,
  children,
}: {
  title?: string;
  message?: string;
  /** 技术细节（错误码 / HTTP 状态），折叠展示 */
  detail?: string;
  onRetry?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="state-block state-error" role="alert">
      <strong>{title}</strong>
      {message !== undefined && message !== "" ? <span>{message}</span> : null}
      {detail !== undefined ? (
        <details className="details-block">
          <summary>技术细节</summary>
          <div className="details-body mono">{detail}</div>
        </details>
      ) : null}
      {onRetry !== undefined || children !== undefined ? (
        <div className="action-row">
          {onRetry !== undefined ? (
            <button type="button" className="btn btn-small" onClick={onRetry}>
              重试
            </button>
          ) : null}
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return (
    <div className="state-block state-empty">
      <strong>{title}</strong>
      {description !== undefined && description !== "" ? <span>{description}</span> : null}
      {children}
    </div>
  );
}
