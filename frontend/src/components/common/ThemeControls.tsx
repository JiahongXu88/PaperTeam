import { useTheme } from "../../theme/ThemeProvider.js";
import type { ThemeMode } from "../../theme/theme.js";

const OPTIONS: ReadonlyArray<{ value: ThemeMode; label: string; description: string }> = [
  { value: "system", label: "跟随系统", description: "随操作系统的浅色 / 深色设置自动切换" },
  { value: "light", label: "浅色", description: "档案白纸面，适合日间长时间阅读" },
  { value: "dark", label: "深色", description: "低亮度阅览室配色，减少夜间刺眼" },
];

/**
 * 主题选择：分段单选（三选一）。用于设置 → 外观；侧栏用紧凑版 ThemeCycleButton。
 */
export function ThemeSegmented({ name = "theme-mode" }: { name?: string }) {
  const { mode, setMode } = useTheme();
  return (
    <div className="segmented" role="radiogroup" aria-label="外观主题" data-testid="theme-segmented">
      {OPTIONS.map((option) => (
        <label key={option.value} className="segmented-option" title={option.description}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={mode === option.value}
            onChange={() => setMode(option.value)}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

export function themeModeLabel(mode: ThemeMode): string {
  return OPTIONS.find((option) => option.value === mode)?.label ?? mode;
}

/** 侧栏紧凑切换：点击在 浅色 → 深色 → 跟随系统 之间循环；aria-label 说明当前与下一状态 */
export function ThemeCycleButton() {
  const { mode, resolved, setMode } = useTheme();
  const next: ThemeMode = mode === "system" ? (resolved === "dark" ? "light" : "dark") : mode === "light" ? "dark" : "system";
  const label = `外观：${themeModeLabel(mode)}（当前${resolved === "dark" ? "深色" : "浅色"}），点击切换为${themeModeLabel(next)}`;
  return (
    <button
      type="button"
      className="icon-btn theme-cycle"
      aria-label={label}
      title={label}
      data-testid="theme-cycle"
      onClick={() => setMode(next)}
    >
      {resolved === "dark" ? (
        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <circle cx="8" cy="8" r="3" />
          <path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}
