import type { ReactNode } from "react";

import type { StatusStyle, StatusTone } from "./status.js";

/**
 * 登记簿状态徽标：dot + 标签（Visual Redesign 2026-09）。
 *
 * 全应用统一的状态语言——children 作为单一文本节点渲染，
 * 便于 ledger 场景输出「Label N」这样的整体文本。
 */

export function StatusBadge({
  label,
  tone = "neutral",
  children,
}: {
  label?: string;
  tone?: StatusTone;
  children?: ReactNode;
}) {
  return (
    <span className={`status status-tone-${tone}`}>
      {children ?? label}
    </span>
  );
}

/** 由 status.ts 注册表条目直接渲染 */
export function RegistryStatus({ style, count }: { style: StatusStyle; count?: number }) {
  return (
    <StatusBadge label={style.label} tone={style.tone}>
      {count === undefined ? style.label : `${style.label} ${count}`}
    </StatusBadge>
  );
}
