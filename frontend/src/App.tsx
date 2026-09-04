import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";

import { AppRoutes } from "./router/index.js";

/**
 * App 根组件（M4.1）：
 * - QueryClientProvider：Server State（缓存 / 重试 / 失效）；
 * - BrowserRouter：路由；
 * - 默认重试 1 次且只对 5xx / 网络错误重试（4xx 业务错误重试无意义）。
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
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
