import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// vitest globals: false 时 RTL 不会自动注册 cleanup —— 显式挂上，
// 避免用例间 DOM 泄漏（getBy* 命中多个元素）。
afterEach(() => {
  cleanup();
});
