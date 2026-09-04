import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { render } from "@testing-library/react";

/** 测试用 QueryClient：关闭重试（错误立即呈现，测试确定性） */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

/** 渲染页面组件（QueryClientProvider + MemoryRouter；AppLayout 的
 * Runtime 徽标与页面数据默认经 vi.mock 的 api 层提供） */
export function renderWithProviders(
  ui: ReactElement,
  { route = "/", client = createTestQueryClient() }: { route?: string; client?: QueryClient } = {},
) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}
