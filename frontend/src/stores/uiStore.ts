import { create } from "zustand";

/**
 * 全局 UI State（M4.1，Zustand）。
 *
 * 边界约定（docs/ARCHITECTURE.md）：Server State 一律走 TanStack Query，
 * Zustand 只放跨页面共享的纯 UI 状态，不复制任何 API 数据。
 * 当前唯一状态：模型未配置横幅的 dismiss 标记（需在路由切换间保持）。
 */

interface UiState {
  /** 用户已关闭「模型未配置」提示横幅（Backend 重新变为已配置前不再显示） */
  modelBannerDismissed: boolean;
  dismissModelBanner: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  modelBannerDismissed: false,
  dismissModelBanner: () => set({ modelBannerDismissed: true }),
}));
