/** 通用状态组件（M4.1）：加载 / 错误重试 / 空态 */
import type { ReactNode } from "react";

export function Loading({ label = "加载中…" }: { label?: string }) {
  return (
    <div className="state-block" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({
  title = "加载失败",
  message,
  onRetry,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="state-block state-error" role="alert">
      <strong>{title}</strong>
      {message !== undefined && message !== "" ? <span>{message}</span> : null}
      {onRetry !== undefined ? (
        <button type="button" className="btn" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="state-block state-empty">
      <strong>{title}</strong>
      {description !== undefined && description !== "" ? <span>{description}</span> : null}
      {children}
    </div>
  );
}
