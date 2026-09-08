import { Icon } from "./Icon.js";
import { useTheme } from "../../theme/ThemeProvider.js";
import type { ThemeMode } from "../../theme/theme.js";

const OPTIONS: ReadonlyArray<{ value: ThemeMode; label: string; description: string }> = [
  { value: "system", label: "跟随系统", description: "随操作系统的浅色 / 深色设置自动切换" },
  { value: "light", label: "浅色", description: "偏暖浅色工作台，适合日间长时间阅读" },
  { value: "dark", label: "深色", description: "墨黑分层配色，减少夜间刺眼" },
];

/**
 * 主题选择：分段单选（三选一）。用于设置 → 外观；顶栏用紧凑版 ThemeCycleButton。
 */
export function ThemeSegmented({ name = "theme-mode" }: { name?: string }) {
  const { mode, setMode } = useTheme();
  return (
    <div className="segmented" role="radiogroup" aria-label="外观主题" data-testid="theme-segmented">
      {OPTIONS.map((option) => (
        <label key={option.value} className="segmented-option" title={option.description}>
          <input type="radio" name={name} value={option.value} checked={mode === option.value} onChange={() => setMode(option.value)} />
          {option.label}
        </label>
      ))}
    </div>
  );
}

export function themeModeLabel(mode: ThemeMode): string {
  return OPTIONS.find((option) => option.value === mode)?.label ?? mode;
}

/** 顶栏紧凑切换：点击在 浅色 → 深色 → 跟随系统 之间循环；aria-label 说明当前与下一状态 */
export function ThemeCycleButton() {
  const { mode, resolved, setMode } = useTheme();
  const next: ThemeMode = mode === "system" ? (resolved === "dark" ? "light" : "dark") : mode === "light" ? "dark" : "system";
  const label = `外观：${themeModeLabel(mode)}（当前${resolved === "dark" ? "深色" : "浅色"}），点击切换为${themeModeLabel(next)}`;
  return (
    <button type="button" className="icon-btn icon-btn-surface theme-cycle" aria-label={label} title={label} data-testid="theme-cycle" onClick={() => setMode(next)}>
      <Icon name={mode === "system" ? "monitor" : resolved === "dark" ? "moon" : "sun"} />
    </button>
  );
}
