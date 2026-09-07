import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";

import { AppRoutes } from "./router/index.js";
import { ThemeProvider } from "./theme/ThemeProvider.js";

/**
 * 根组件：QueryClientProvider（server state）→ ThemeProvider（纯 UI 偏好）→ 路由。
 * 查询默认只对 5xx / 网络错误重试一次；4xx 业务错误重试无意义。
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        const status = (error as { status?: number }).status ?? 0;
        return status >= 500 || status === 0 ? failureCount < 1 : false;
      },
      staleTime: 5_000,
      refetchOnWindowFocus: true,
    },
    mutations: { retry: false },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
