/**
 * Research 代理路由（M13.8）单元测试：全部离线——dispatcher 工厂 / 代理路径 fetch /
 * 直连 fetch 全部注入假实现，不访问公网、不创建真实 ProxyAgent。
 */

import type { Dispatcher } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isPrivateOrLocalHost, shouldBypassResearchProxy } from "../../src/network/hosts.js";
import {
  ResearchFetchRouter,
  ResearchProxyConfigError,
  ResearchProxyError,
  classifyProxyFailure,
  formatResearchProxyUrl,
  normalizeResearchProxyConfig,
  parseResearchProxyUrl,
  sameResearchProxyConfig,
  type ResearchProxyConfig,
} from "../../src/network/researchProxy.js";

/** 可观测的假 dispatcher：记录 close / destroy；close 可挂起以模拟在途请求 */
function fakeDispatcher(options: { closeHangs?: boolean } = {}) {
  let resolveClose: (() => void) | undefined;
  const dispatcher = {
    closed: false,
    destroyed: false,
    close: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          if (options.closeHangs) {
            resolveClose = () => {
              dispatcher.closed = true;
              resolve();
            };
            return;
          }
          dispatcher.closed = true;
          resolve();
        }),
    ),
    destroy: vi.fn(async () => {
      dispatcher.destroyed = true;
    }),
    finishClose: () => resolveClose?.(),
  };
  return dispatcher;
}

const PROXY: ResearchProxyConfig = { protocol: "http", host: "127.0.0.1", port: 7890 };

function makeRouter(overrides: { releaseGraceMs?: number } = {}) {
  const dispatchers: ReturnType<typeof fakeDispatcher>[] = [];
  const directCalls: string[] = [];
  const proxiedCalls: Array<{ url: string; dispatcher: unknown }> = [];
  const router = new ResearchFetchRouter({
    directFetch: (async (input: string | URL | Request) => {
      directCalls.push(String(input));
      return new Response("direct", { status: 200 });
    }) as typeof fetch,
    proxiedFetch: async (url, _init, dispatcher) => {
      proxiedCalls.push({ url, dispatcher });
      return new Response("proxied", { status: 200 });
    },
    createDispatcher: () => {
      const dispatcher = fakeDispatcher();
      dispatchers.push(dispatcher);
      return dispatcher as unknown as Dispatcher;
    },
    releaseGraceMs: overrides.releaseGraceMs ?? 1_000,
  });
  return { router, dispatchers, directCalls, proxiedCalls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("parseResearchProxyUrl / normalizeResearchProxyConfig", () => {
  it("http://host:port → http 配置；socks5 / socks5h → socks5", () => {
    expect(parseResearchProxyUrl("http://127.0.0.1:7890")).toEqual({ protocol: "http", host: "127.0.0.1", port: 7890 });
    expect(parseResearchProxyUrl(" socks5://proxy.local:1080 ")).toEqual({ protocol: "socks5", host: "proxy.local", port: 1080 });
    expect(parseResearchProxyUrl("socks5h://10.0.0.5:1080").protocol).toBe("socks5");
  });

  it("带账号密码的 URL 被拒绝，且错误信息不回显凭据", () => {
    expect(() => parseResearchProxyUrl("http://alice:s3cret@127.0.0.1:7890")).toThrow(ResearchProxyConfigError);
    try {
      parseResearchProxyUrl("http://alice:s3cret@127.0.0.1:7890");
    } catch (error) {
      expect((error as Error).message).not.toContain("s3cret");
      expect((error as Error).message).not.toContain("alice");
    }
  });

  it("缺端口 / 带路径或查询 / 非法协议 / 非 URL 一律拒绝", () => {
    expect(() => parseResearchProxyUrl("http://127.0.0.1")).toThrow(/端口/);
    expect(() => parseResearchProxyUrl("http://127.0.0.1:7890/path")).toThrow(/路径/);
    expect(() => parseResearchProxyUrl("http://127.0.0.1:7890/?x=1")).toThrow(/路径/);
    expect(() => parseResearchProxyUrl("https://127.0.0.1:7890")).toThrow(/协议/);
    expect(() => parseResearchProxyUrl("ftp://127.0.0.1:21")).toThrow(/协议/);
    expect(() => parseResearchProxyUrl("not a url")).toThrow(/不合法/);
  });

  it("字段级归一化：大小写 / 方括号 IPv6 / 字符串端口；非法值给出可读错误", () => {
    expect(normalizeResearchProxyConfig({ protocol: "HTTP", host: "[::1]", port: "7890" })).toEqual({ protocol: "http", host: "::1", port: 7890 });
    expect(() => normalizeResearchProxyConfig({ protocol: "http", host: "", port: 7890 })).toThrow(/不能为空/);
    expect(() => normalizeResearchProxyConfig({ protocol: "http", host: "http://127.0.0.1", port: 7890 })).toThrow(/协议前缀/);
    expect(() => normalizeResearchProxyConfig({ protocol: "http", host: "user@host", port: 7890 })).toThrow(/账号/);
    expect(() => normalizeResearchProxyConfig({ protocol: "http", host: "127.0.0.1", port: 0 })).toThrow(/端口/);
    expect(() => normalizeResearchProxyConfig({ protocol: "http", host: "127.0.0.1", port: "abc" })).toThrow(/端口/);
    expect(() => normalizeResearchProxyConfig({ protocol: "pac", host: "127.0.0.1", port: 1 })).toThrow(/代理类型/);
  });

  it("formatResearchProxyUrl：IPv6 加方括号；sameResearchProxyConfig 字段级相等", () => {
    expect(formatResearchProxyUrl({ protocol: "socks5", host: "::1", port: 1080 })).toBe("socks5://[::1]:1080");
    expect(formatResearchProxyUrl(PROXY)).toBe("http://127.0.0.1:7890");
    expect(sameResearchProxyConfig(PROXY, { ...PROXY })).toBe(true);
    expect(sameResearchProxyConfig(PROXY, { ...PROXY, port: 7891 })).toBe(false);
    expect(sameResearchProxyConfig(null, null)).toBe(true);
    expect(sameResearchProxyConfig(PROXY, null)).toBe(false);
  });
});

describe("shouldBypassResearchProxy / isPrivateOrLocalHost", () => {
  it("回环 / 私网 / 本地后缀 / 单标签主机名直连；公网域名走代理", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "searxng", "paperteam.local", "svc.internal"]) {
      expect(shouldBypassResearchProxy(host)).toBe(true);
    }
    for (const host of ["arxiv.org", "api.openalex.org", "export.arxiv.org", "8.8.8.8", "[2606:4700::1111]"]) {
      expect(shouldBypassResearchProxy(host)).toBe(false);
    }
    expect(isPrivateOrLocalHost("169.254.1.1")).toBe(true);
    expect(isPrivateOrLocalHost("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateOrLocalHost("fe80::1")).toBe(true);
    expect(isPrivateOrLocalHost("151.101.1.1")).toBe(false);
  });
});

describe("ResearchFetchRouter", () => {
  it("未配置代理：所有请求走直连 fetch（旧版行为），不创建 dispatcher", async () => {
    const { router, dispatchers, directCalls, proxiedCalls } = makeRouter();
    await router.fetch("https://api.openalex.org/works?search=x");
    await router.fetch(new URL("https://arxiv.org/pdf/1706.03762"));
    expect(directCalls).toHaveLength(2);
    expect(proxiedCalls).toHaveLength(0);
    expect(dispatchers).toHaveLength(0);
    expect(router.current()).toBeNull();
    expect(router.stats()).toEqual({ proxied: 0, direct: 2, bypassed: 0, retiring: 0 });
  });

  it("配置代理后：公网地址经 dispatcher；回环 / 私网 / 单标签主机名仍直连", async () => {
    const { router, dispatchers, directCalls, proxiedCalls } = makeRouter();
    router.configure(PROXY);
    expect(dispatchers).toHaveLength(1);
    await router.fetch("https://arxiv.org/pdf/2304.14394");
    await router.fetch("http://127.0.0.1:8080/search?q=x");
    await router.fetch("http://searxng:8080/search?q=x");
    await router.fetch("http://192.168.1.20:8080/search");
    expect(proxiedCalls.map((call) => call.url)).toEqual(["https://arxiv.org/pdf/2304.14394"]);
    expect(proxiedCalls[0]!.dispatcher).toBe(dispatchers[0]);
    expect(directCalls).toHaveLength(3);
    expect(router.stats()).toEqual({ proxied: 1, direct: 0, bypassed: 3, retiring: 0 });
  });

  it("切换配置：新请求立刻用新 dispatcher，旧 dispatcher 优雅 close；相同配置 no-op", async () => {
    const { router, dispatchers, proxiedCalls } = makeRouter();
    expect(router.configure(PROXY)).toEqual({ changed: true });
    expect(router.configure({ ...PROXY })).toEqual({ changed: false });
    expect(dispatchers).toHaveLength(1);
    expect(router.configure({ ...PROXY, port: 7891 })).toEqual({ changed: true });
    expect(dispatchers).toHaveLength(2);
    await router.fetch("https://api.crossref.org/works?rows=1");
    expect(proxiedCalls[0]!.dispatcher).toBe(dispatchers[1]);
    await Promise.resolve();
    expect(dispatchers[0]!.close).toHaveBeenCalledTimes(1);
    expect(dispatchers[0]!.destroyed).toBe(false);
    expect(router.stats().retiring).toBe(0);
    // 关闭代理：回到直连；第二个 dispatcher 退役
    expect(router.configure(null)).toEqual({ changed: true });
    expect(router.current()).toBeNull();
    await Promise.resolve();
    expect(dispatchers[1]!.close).toHaveBeenCalledTimes(1);
  });

  it("旧 dispatcher 在途请求超过宽限期：destroy 兜底（不中断前先等 close）", async () => {
    vi.useFakeTimers();
    const hanging = fakeDispatcher({ closeHangs: true });
    let created = 0;
    const router = new ResearchFetchRouter({
      directFetch: (async () => new Response("d")) as typeof fetch,
      proxiedFetch: async () => new Response("p"),
      createDispatcher: () => {
        created += 1;
        return (created === 1 ? hanging : fakeDispatcher()) as unknown as Dispatcher;
      },
      releaseGraceMs: 5_000,
    });
    router.configure(PROXY);
    router.configure({ ...PROXY, port: 7891 });
    expect(router.stats().retiring).toBe(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(hanging.destroyed).toBe(false);
    expect(router.stats().retiring).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(hanging.destroyed).toBe(true);
    expect(router.stats().retiring).toBe(0);
  });

  it("close()：关闭当前与退役中的全部 dispatcher，之后回到直连", async () => {
    const { router, dispatchers } = makeRouter();
    router.configure(PROXY);
    router.configure({ ...PROXY, port: 7891 });
    await router.close();
    expect(dispatchers.every((dispatcher) => dispatcher.close.mock.calls.length >= 1)).toBe(true);
    expect(router.current()).toBeNull();
  });

  it("代理模式下拒绝 Request 对象输入（内部客户端只传 string | URL）", async () => {
    const { router } = makeRouter();
    router.configure(PROXY);
    await expect(router.fetch(new Request("https://arxiv.org/pdf/1"))).rejects.toThrow(TypeError);
  });

  it("代理路径抛错：连不上代理 → ResearchProxyError(proxy_unreachable)，点名代理地址", async () => {
    const router = new ResearchFetchRouter({
      directFetch: (async () => new Response("d")) as typeof fetch,
      proxiedFetch: async () => {
        const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7890"), {
          code: "ECONNREFUSED",
          address: "127.0.0.1",
          port: 7890,
        });
        throw new TypeError("fetch failed", { cause });
      },
      createDispatcher: () => fakeDispatcher() as unknown as Dispatcher,
    });
    router.configure(PROXY);
    const error = await router.fetch("https://arxiv.org/pdf/1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ResearchProxyError);
    expect((error as ResearchProxyError).kind).toBe("proxy_unreachable");
    expect((error as Error).message).toContain("http://127.0.0.1:7890");
  });
});

describe("classifyProxyFailure", () => {
  it("目标站点的 ECONNREFUSED（非代理地址）原样抛出；AbortError / TimeoutError 原样", () => {
    const targetDown = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 151.101.1.1:443"), { code: "ECONNREFUSED", address: "151.101.1.1", port: 443 }),
    });
    expect(classifyProxyFailure(targetDown, PROXY)).toBe(targetDown);
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(classifyProxyFailure(abort, PROXY)).toBe(abort);
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    expect(classifyProxyFailure(timeout, PROXY)).toBe(timeout);
  });

  it("代理拒绝隧道（Proxy response 407）→ proxy_rejected；localhost 解析到 127.0.0.1 也算命中", () => {
    const rejected = new TypeError("fetch failed", { cause: new Error("Proxy response (407) !== 200 when HTTP Tunneling") });
    const classified = classifyProxyFailure(rejected, PROXY) as ResearchProxyError;
    expect(classified).toBeInstanceOf(ResearchProxyError);
    expect(classified.kind).toBe("proxy_rejected");
    const viaLocalhost = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7890"), { code: "ECONNREFUSED", address: "127.0.0.1", port: 7890 }),
    });
    expect((classifyProxyFailure(viaLocalhost, { ...PROXY, host: "localhost" }) as ResearchProxyError).kind).toBe("proxy_unreachable");
    expect(classifyProxyFailure("not an error", PROXY)).toBe("not an error");
  });
});
