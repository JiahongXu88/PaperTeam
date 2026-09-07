import type { ReactNode } from "react";

import type { StatusStyle, StatusTone } from "./status.js";

/** 状态：dot + 文字（全应用统一的状态语言） */
export function StatusBadge({ label, tone = "neutral", children }: { label?: string; tone?: StatusTone; children?: ReactNode }) {
  return <span className={`status status-tone-${tone}`}>{children ?? label}</span>;
}

/** 由注册表条目直接渲染；count 存在时输出「标签 N」 */
export function RegistryStatus({ style, count }: { style: StatusStyle; count?: number }) {
  return (
    <StatusBadge tone={style.tone}>{count === undefined ? style.label : `${style.label} ${count}`}</StatusBadge>
  );
}
