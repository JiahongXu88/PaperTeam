import { create } from "zustand";

/**
 * 全局 UI 状态（Zustand）。Server state 一律走 TanStack Query，这里只放跨页面共享的
 * 纯 UI 状态，不复制任何 API 数据。主题偏好在 theme/ 单独持久化。
 */

interface UiState {
  /** 用户已关闭「模型未配置」提示横幅（本次会话内不再显示） */
  modelBannerDismissed: boolean;
  dismissModelBanner: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  modelBannerDismissed: false,
  dismissModelBanner: () => set({ modelBannerDismissed: true }),
}));
