import { useEffect, useMemo, useRef, useState } from "react";

import type { ModelProviderOptionView } from "../../types/api.js";

/**
 * 模型提供商搜索选择器。
 *
 * Pi 注册表有 40 个左右 provider，绝大多数用户只认识十来个：
 * - 分组：已有凭据 → 自定义提供商 → 常用提供商 → 其他（默认折叠，一行展开）
 * - 输入即筛选：按名称 / id 前缀匹配（输入 "a" 只出现以 A 开头的；两个字符以上也允许包含匹配），
 *   有输入时折叠组自动参与匹配
 * - 键盘：↑↓ 移动高亮、Enter 选中、Esc 关闭
 */

/** 常用提供商（Pi provider id）；不在这里、又没有凭据、也不是自定义的进"其他" */
const MAJOR_PROVIDER_IDS = new Set([
  "anthropic",
  "openai",
  "google",
  "google-vertex",
  "amazon-bedrock",
  "azure-openai-responses",
  "deepseek",
  "zai",
  "zai-coding-cn",
  "moonshotai",
  "moonshotai-cn",
  "minimax",
  "minimax-cn",
  "qwen-token-plan-cn",
  "xai",
  "mistral",
  "openrouter",
  "groq",
  "github-copilot",
]);

type GroupKey = "ready" | "custom" | "major" | "other";

const GROUP_LABEL: Record<GroupKey, string> = {
  ready: "已有凭据",
  custom: "自定义提供商",
  major: "常用提供商",
  other: "其他提供商",
};

function groupOf(provider: ModelProviderOptionView): GroupKey {
  if (provider.authConfigured) {
    return "ready";
  }
  if (provider.source === "custom") {
    return "custom";
  }
  return MAJOR_PROVIDER_IDS.has(provider.id) ? "major" : "other";
}

function matches(provider: ModelProviderOptionView, query: string): boolean {
  const lower = query.toLowerCase();
  const name = provider.name.toLowerCase();
  const id = provider.id.toLowerCase();
  if (name.startsWith(lower) || id.startsWith(lower)) {
    return true;
  }
  return lower.length >= 2 && (name.includes(lower) || id.includes(lower));
}

type Row =
  | { kind: "group"; key: GroupKey; count: number }
  | { kind: "option"; provider: ModelProviderOptionView; index: number }
  | { kind: "toggle"; hidden: number };

export function ProviderCombobox({
  providers,
  value,
  onChange,
  disabled,
  id,
}: {
  providers: ModelProviderOptionView[] | undefined;
  value: string;
  onChange: (providerId: string) => void;
  disabled?: boolean;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [showOther, setShowOther] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const { rows, options } = useMemo(() => {
    const all = providers ?? [];
    const filtering = query.trim() !== "";
    const grouped: Record<GroupKey, ModelProviderOptionView[]> = { ready: [], custom: [], major: [], other: [] };
    for (const provider of all) {
      if (!filtering || matches(provider, query.trim())) {
        grouped[groupOf(provider)].push(provider);
      }
    }
    const rows: Row[] = [];
    const options: ModelProviderOptionView[] = [];
    const push = (key: GroupKey) => {
      const list = grouped[key];
      if (list.length === 0) {
        return;
      }
      rows.push({ kind: "group", key, count: list.length });
      for (const provider of list) {
        rows.push({ kind: "option", provider, index: options.length });
        options.push(provider);
      }
    };
    push("ready");
    push("custom");
    push("major");
    if (filtering || showOther) {
      push("other");
    } else if (grouped.other.length > 0) {
      rows.push({ kind: "toggle", hidden: grouped.other.length });
    }
    return { rows, options };
  }, [providers, query, showOther]);

  const selected = (providers ?? []).find((provider) => provider.id === value);

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

  useEffect(() => {
    const list = listRef.current;
    if (list === null) {
      return;
    }
    const item = list.querySelector<HTMLElement>(`[data-index="${highlight}"]`);
    item?.scrollIntoView?.({ block: "nearest" });
  }, [highlight, open]);

  const openList = () => {
    setQuery("");
    setShowOther(false);
    setHighlight(Math.max(0, options.findIndex((provider) => provider.id === value)));
    setOpen(true);
  };

  const select = (providerId: string) => {
    onChange(providerId);
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        openList();
        return;
      }
      setHighlight((index) => Math.min(index + 1, options.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (open && options[highlight] !== undefined) {
        select(options[highlight].id);
      } else if (!open) {
        openList();
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  const listboxId = id !== undefined ? `${id}-listbox` : undefined;

  return (
    <div className="combobox" ref={rootRef} data-testid="provider-combobox">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-activedescendant={open && id !== undefined && options[highlight] !== undefined ? `${id}-option-${highlight}` : undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled || providers === undefined}
        value={open ? query : selected !== undefined ? `${selected.name}（${selected.id}）` : value}
        placeholder={providers === undefined ? "加载提供商…" : "输入名称或 id 筛选，如 a / anthropic"}
        onFocus={() => {
          if (!disabled && providers !== undefined) {
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
        data-testid="provider-combobox-input"
      />
      {open ? (
        <ul className="combobox-list" role="listbox" id={listboxId} ref={listRef}>
          {rows.map((row) => {
            if (row.kind === "group") {
              return (
                <li key={`group-${row.key}`} className="combobox-group" role="presentation">
                  {GROUP_LABEL[row.key]}
                  <span className="combobox-group-count">{row.count}</span>
                </li>
              );
            }
            if (row.kind === "toggle") {
              return (
                <li key="toggle" className="combobox-toggle" role="presentation">
                  <button
                    type="button"
                    className="btn-link"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setShowOther(true)}
                    data-testid="provider-show-other"
                  >
                    显示其他 {row.hidden} 个提供商
                  </button>
                </li>
              );
            }
            const { provider, index } = row;
            return (
              <li
                key={provider.id}
                id={id !== undefined ? `${id}-option-${index}` : undefined}
                data-index={index}
                role="option"
                aria-selected={provider.id === value}
                className={`combobox-option${index === highlight ? " highlighted" : ""}${provider.id === value ? " selected" : ""}`}
                onMouseEnter={() => setHighlight(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(provider.id)}
              >
                <span className="combobox-option-name">{provider.name}</span>
                <span className="combobox-option-id">
                  {provider.id}
                  <span className="combobox-option-ctx">{provider.modelCount} 个模型</span>
                </span>
              </li>
            );
          })}
          {options.length === 0 ? (
            <li className="combobox-empty" role="presentation">
              没有匹配「{query}」的提供商
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
