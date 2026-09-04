import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Vite / Vitest 配置（M4.1）。
 *
 * Dev Server 通过 proxy 把 /api 与 /health 转发到 PaperTeam Backend，
 * 前端始终使用同源相对路径（无 CORS、生产部署同构）；后端端口可用
 * PAPERTEAM_PORT 覆盖（与 Backend 的端口环境变量同名同义）。
 */

const backendPort = process.env.PAPERTEAM_PORT ?? "3000";
const backendTarget = `http://127.0.0.1:${backendPort}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: backendTarget, changeOrigin: false },
      "/health": { target: backendTarget, changeOrigin: false },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    // 与 Backend 一致：不注入全局变量，显式 import（vitest/config + RTL）
    globals: false,
  },
});
