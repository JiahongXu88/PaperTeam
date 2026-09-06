import { useEffect, useMemo, useRef, useState } from "react";

import type { ModelOptionView } from "../../types/api.js";

/**
 * 模型搜索选择器（UX Polish 2026-09）。
 *
 * 轻量自研 combobox（不引入 UI 框架），解决单 provider 动辄数百上千条
 * 模型时原生 select 无法使用的问题：
 * - 输入即筛选（displayName / modelId，不区分大小写）
 * - 键盘：↑↓ 移动高亮、Enter 选中、Esc 关闭
 * - 只渲染前 N 条匹配（不做全量 DOM）；截断时提示剩余数量
 * - 主视觉 displayName，次要 modelId（含上下文窗口读数）
 */

/** 下拉最多渲染的匹配条数（超出提示剩余数，避免千级 DOM） */
const MAX_RENDERED = 50;

/** 上下文窗口 → 简洁读数（200k / 1M） */
function formatContext(window: number): string {
  return window >= 1_000_000
    ? `${(window / 1_000_000).toFixed(window % 1_000_000 === 0 ? 0 : 1)}M 上下文`
    : `${Math.round(window / 1000)}k 上下文`;
}

function matches(model: ModelOptionView, query: string): boolean {
  if (query === "") {
    return true;
  }
  const lower = query.toLowerCase();
  return (
    model.displayName.toLowerCase().includes(lower) || model.modelId.toLowerCase().includes(lower)
  );
}

export function ModelCombobox({
  models,
  value,
  onChange,
  disabled,
  loading,
  emptyHint,
  id,
}: {
  models: ModelOptionView[] | undefined;
  /** 当前选中的 modelId（可含 "/"，如 anthropic/claude-sonnet-4） */
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
  loading?: boolean;
  /** 无匹配模型时的空态提示（区分「目录为空」与「筛选无结果」） */
  emptyHint?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = useMemo(
    () => (models ?? []).filter((model) => matches(model, query)),
    [models, query],
  );
  const rendered = filtered.slice(0, MAX_RENDERED);
  const hidden = filtered.length - rendered.length;

  const selected = (models ?? []).find((model) => model.modelId === value);

  // 点击外部关闭
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  // 高亮条目滚入可视区
  useEffect(() => {
    const list = listRef.current;
    if (list === null) {
      return;
    }
    const item = list.children[highlight] as HTMLElement | undefined;
    item?.scrollIntoView?.({ block: "nearest" });
  }, [highlight, open]);

  const openList = () => {
    setQuery("");
    setHighlight(Math.max(0, filtered.findIndex((m) => m.modelId === value)));
    setOpen(true);
  };

  const select = (modelId: string) => {
    onChange(modelId);
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        openList();
        return;
      }
      setHighlight((index) => Math.min(index + 1, rendered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (open && rendered[highlight] !== undefined) {
        select(rendered[highlight].modelId);
      } else if (!open) {
        openList();
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="combobox" ref={rootRef} data-testid="model-combobox">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={id !== undefined ? `${id}-listbox` : undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        value={open ? query : (selected?.displayName ?? value)}
        placeholder={
          loading ? "加载模型目录…" : (models === undefined || models.length === 0) ? (emptyHint ?? "暂无模型") : "搜索模型…"
        }
        onFocus={() => {
          if (!disabled) {
            openList();
          }
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setHighlight(0);
          if (!open) {
            setOpen(true);
          }
        }}
        onKeyDown={onKeyDown}
        data-testid="model-combobox-input"
      />
      {open ? (
        <ul
          className="combobox-list"
          role="listbox"
          id={id !== undefined ? `${id}-listbox` : undefined}
          ref={listRef}
        >
          {rendered.map((model, index) => (
            <li
              key={model.modelId}
              role="option"
              aria-selected={model.modelId === value}
              className={`combobox-option${index === highlight ? " highlighted" : ""}${
                model.modelId === value ? " selected" : ""
              }`}
              onMouseEnter={() => setHighlight(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(model.modelId)}
            >
              <span className="combobox-option-name">
                {model.displayName}
                {model.contextWindow !== undefined ? (
                  <span className="combobox-option-ctx">（{formatContext(model.contextWindow)}）</span>
                ) : null}
              </span>
              <span className="combobox-option-id">{model.modelId}</span>
            </li>
          ))}
          {rendered.length === 0 ? (
            <li className="combobox-empty" role="presentation">
              {models !== undefined && models.length === 0
                ? (emptyHint ?? "该提供商暂无模型目录")
                : `没有匹配「${query}」的模型`}
            </li>
          ) : null}
          {hidden > 0 ? (
            <li className="combobox-more" role="presentation">
              还有 {hidden} 个匹配模型，输入关键词缩小范围
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
