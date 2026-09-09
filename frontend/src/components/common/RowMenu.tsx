import { useEffect, useId, useRef, useState } from "react";

/**
 * 「···」行菜单（项目行 / 工作区标题共用）。
 *
 * 键盘：触发按钮 Enter/Space/↓ 打开并把焦点移到第一项；菜单内 ↑↓ 循环、
 * Home/End、Esc 关闭并把焦点还给触发按钮；点击外部关闭。
 * 触发按钮由调用方放在 <Link> 之外——菜单永不嵌套在链接里。
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
    const first = menuRef.current?.querySelector<HTMLElement>("[role=menuitem]");
    first?.focus();
    const onDocClick = (event: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  };

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const menuItems = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
    const index = menuItems.findIndex((item) => item === document.activeElement);
    const focusAt = (next: number) => menuItems[(next + menuItems.length) % menuItems.length]?.focus();
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        close(true);
        break;
      case "ArrowDown":
        event.preventDefault();
        focusAt(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusAt(index - 1);
        break;
      case "Home":
        event.preventDefault();
        focusAt(0);
        break;
      case "End":
        event.preventDefault();
        focusAt(menuItems.length - 1);
        break;
      case "Tab":
        close(false);
        break;
      default:
        break;
    }
  };

  return (
    <div className="row-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="row-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={label}
        data-testid={testId}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span aria-hidden="true">···</span>
      </button>
      {open ? (
        <div className="row-menu-popover" role="menu" id={menuId} aria-label={label} ref={menuRef} onKeyDown={onMenuKeyDown}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={`row-menu-item${item.danger === true ? " row-menu-item-danger" : ""}`}
              onClick={() => {
                close(false);
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
  const unchanged = trimmed === "" || trimmed === initial.trim();
  return (
    <span className="inline-rename" data-testid={testId}>
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !unchanged) {
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
      <button type="button" className="btn btn-small btn-primary" disabled={unchanged} onClick={() => onCommit(trimmed)}>
        保存
      </button>
      <button type="button" className="btn btn-small" onClick={onCancel}>
        取消
      </button>
    </span>
  );
}

/**
 * 行内确认：用于归档这类可撤销但不该误触的动作。
 * 不弹系统 confirm，也不做模态——在原位置给出「确认 / 取消」。
 */
export function InlineConfirm({
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  pending = false,
  danger = false,
  testId,
}: {
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  pending?: boolean;
  danger?: boolean;
  testId?: string;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);
  return (
    <span
      className="inline-confirm"
      role="group"
      aria-label={message}
      data-testid={testId}
      onKeyDown={(event) => {
        // Escape 关闭确认（回到安全态）；Tab 在按钮间正常移动
        if (event.key === "Escape" && !pending) {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <span>{message}</span>
      <button
        ref={confirmRef}
        type="button"
        className={`btn btn-small${danger ? " btn-danger" : " btn-primary"}`}
        onClick={onConfirm}
        disabled={pending}
      >
        {pending ? "处理中…" : confirmLabel}
      </button>
      <button type="button" className="btn btn-small" onClick={onCancel} disabled={pending}>
        取消
      </button>
    </span>
  );
}
