import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient, ApiError } from "../src/api/client.js";

/** 统一 API Client 行为（M4.1）：JSON、错误映射、网络失败收敛 */

function mockFetchOnce(implementation: typeof fetch) {
  return vi.fn(implementation) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiClient", () => {
  it("GET：请求同源相对路径并解析 JSON 响应", async () => {
    const fetchMock = mockFetchOnce(async () =>
      new Response(JSON.stringify({ value: 42 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await apiClient.get<{ value: number }>("/api/demo");
    expect(result).toEqual({ value: 42 });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/demo",
      expect.objectContaining({ method: "GET", headers: expect.objectContaining({ Accept: "application/json" }) }),
    );
  });

  it("POST：发送 JSON body 与 Content-Type", async () => {
    const fetchMock = mockFetchOnce(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await apiClient.post("/api/demo", { title: "T" });
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/demo");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ title: "T" }));
  });

  it("非 2xx：映射为 ApiError（status + Backend code/message）", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce(
        async () =>
          new Response(
            JSON.stringify({
              status: "error",
              error: { code: "INVALID_REQUEST", message: "请求体必须包含非空字符串字段 title" },
            }),
            { status: 400 },
          ),
      ),
    );

    const error = await apiClient.post("/api/projects", {}).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(400);
    expect(apiError.code).toBe("INVALID_REQUEST");
    expect(apiError.message).toContain("title");
    expect(apiError.isNotFound).toBe(false);
  });

  it("404：isNotFound 为 true（ProjectPage 据此渲染「项目不存在」）", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce(
        async () =>
          new Response(
            JSON.stringify({
              status: "error",
              error: { code: "PROJECT_NOT_FOUND", message: "论文项目不存在：p-x" },
            }),
            { status: 404 },
          ),
      ),
    );

    const error = (await apiClient.get("/api/projects/p-x").catch((cause: unknown) => cause)) as ApiError;
    expect(error.isNotFound).toBe(true);
  });

  it("网络层失败（Backend 未启动）：收敛为 NETWORK_ERROR（status=0）", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const error = (await apiClient.get("/api/projects").catch((cause: unknown) => cause)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
    expect(error.code).toBe("NETWORK_ERROR");
    expect(error.message).toContain("无法连接");
  });

  it("非 JSON 响应体：抛 INVALID_RESPONSE 而不是语法错误", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce(async () => new Response("<html>502</html>", { status: 502 })),
    );

    const error = (await apiClient.get("/health").catch((cause: unknown) => cause)) as ApiError;
    expect(error.code).toBe("INVALID_RESPONSE");
    expect(error.status).toBe(502);
  });
});
