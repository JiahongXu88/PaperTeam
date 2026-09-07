import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import {
  applyTheme,
  readStoredThemeMode,
  resolveTheme,
  subscribeSystemTheme,
  writeStoredThemeMode,
  type ResolvedTheme,
  type ThemeMode,
} from "./theme.js";

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => readStoredThemeMode());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(mode));

  // mode 变化 → 立即应用；system 模式下跟随操作系统切换
  useEffect(() => {
    const next = resolveTheme(mode);
    setResolved(next);
    applyTheme(next);
    if (mode !== "system") {
      return;
    }
    return subscribeSystemTheme(() => {
      const followed = resolveTheme("system");
      setResolved(followed);
      applyTheme(followed);
    });
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    writeStoredThemeMode(next);
    setModeState(next);
  }, []);

  const value = useMemo(() => ({ mode, resolved, setMode }), [mode, resolved, setMode]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === null) {
    throw new Error("useTheme 必须在 ThemeProvider 内使用");
  }
  return context;
}
