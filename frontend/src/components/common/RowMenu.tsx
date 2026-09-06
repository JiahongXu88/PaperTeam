import { useEffect, useRef, useState } from "react";

/**
 * 轻量「···」行菜单（项目行 / 工作区 Header 共用）。
 *
 * 交互约束：
 * - 触发按钮 aria-haspopup="menu" + aria-expanded，键盘可达；
 * - 打开后 Esc 关闭、点击菜单外部关闭、动作点击后关闭；
 * - 不在 <Link> 内嵌套 button——菜单按钮由调用方放在 Link 之外。
 */
export interface RowMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

export function RowMenu({
  items,
  label = "更多操作",
  testId,
}: {
  items: RowMenuItem[];
  /** 触发按钮的可访问名称 */
  label?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDocClick = (event: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="row-menu" ref={rootRef}>
      <button
        type="button"
        className="row-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        data-testid={testId}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">···</span>
      </button>
      {open ? (
        <div className="row-menu-popover" role="menu" aria-label={label}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={`row-menu-item ${item.danger === true ? "row-menu-item-danger" : ""}`}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 内联重命名（项目行 / 工作区标题共用）：input + 保存 / 取消 */
export function InlineRename({
  initial,
  onCommit,
  onCancel,
  maxLength = 200,
  testId,
}: {
  initial: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
  maxLength?: number;
  testId?: string;
}) {
  const [value, setValue] = useState(initial);
  const trimmed = value.trim();
  return (
    <span className="inline-rename" data-testid={testId}>
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && trimmed !== "") {
            onCommit(trimmed);
          }
          if (event.key === "Escape") {
            onCancel();
          }
        }}
        autoFocus
        aria-label="项目标题"
        maxLength={maxLength + 1}
      />
      <button
        type="button"
        className="btn btn-small btn-primary"
        disabled={trimmed === "" || trimmed === initial.trim()}
        onClick={() => onCommit(trimmed)}
      >
        保存
      </button>
      <button type="button" className="btn btn-small" onClick={onCancel}>
        取消
      </button>
    </span>
  );
}
