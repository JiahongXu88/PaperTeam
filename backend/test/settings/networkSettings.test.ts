/**
 * Network Settings（M13.8）：Store 持久化 / Service 优先级与保存生效 / 测试连接分类。
 * 全部离线：router 用假 dispatcher 工厂，探测 router 与 TCP 探测注入 canned 结果。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Dispatcher } from "undici";
import { afterAll, describe, expect, it } from "vitest";

import { BusinessError } from "../../src/errors.js";
import { ResearchFetchRouter, ResearchProxyError, type ResearchProxyConfig } from "../../src/network/researchProxy.js";
import {
  NetworkSettingsService,
  type NetworkCheckResult,
  type NetworkProbeRouter,
} from "../../src/settings/NetworkSettingsService.js";
import { NetworkSettingsStore } from "../../src/settings/NetworkSettingsStore.js";

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function settingsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pt-network-settings-"));
  tempDirs.push(dir);
  return dir;
}

function fakeRouter() {
  const created: ResearchProxyConfig[] = [];
  const router = new ResearchFetchRouter({
    directFetch: (async () => new Response("direct")) as typeof fetch,
    proxiedFetch: async () => new Response("proxied"),
    createDispatcher: (config) => {
      created.push(config);
      return { close: async () => {}, destroy: async () => {} } as unknown as Dispatcher;
    },
    releaseGraceMs: 100,
  });
  return { router, created };
}

type Canned = (url: string) => Response | Error;

/** 探测 router 假实现：按 URL 主机返回 canned Response / 抛错；记录请求 */
function probeRouterFactory(canned: Canned) {
  const seen: Array<{ url: string; config: ResearchProxyConfig | null }> = [];
  let closed = 0;
  const factory = (config: ResearchProxyConfig | null): NetworkProbeRouter => ({
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      seen.push({ url, config });
      const outcome = canned(url);
      if (outcome instanceof Error) {
        throw outcome;
      }
      return outcome;
    }) as typeof fetch,
    close: async () => {
      closed += 1;
    },
  });
  return { factory, seen, closedCount: () => closed };
}

function pdfResponse(): Response {
  const bytes = Buffer.concat([Buffer.from("%PDF-1.5\n"), Buffer.alloc(4096, 0x41)]);
  return new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } });
}

const allOk: Canned = (url) => {
  if (url.includes("export.arxiv.org")) return new Response("<feed></feed>", { status: 200 });
  if (url.includes("arxiv.org/pdf")) return pdfResponse();
  if (url.includes("openalex")) return new Response('{"results":[]}', { status: 200 });
  if (url.includes("semanticscholar")) return new Response('{"total":1,"data":[]}', { status: 200 });
  if (url.includes("crossref")) return new Response('{"status":"ok"}', { status: 200 });
  return new Response("?", { status: 404 });
};

function byId(checks: NetworkCheckResult[]): Record<string, NetworkCheckResult> {
  return Object.fromEntries(checks.map((check) => [check.id, check]));
}

describe("NetworkSettingsStore", () => {
  it("缺省 / 损坏 / 形状不符 → 空偏好；保存后可读回（原子写含 version / savedAt）", async () => {
    const dir = await settingsDir();
    const store = new NetworkSettingsStore({ settingsDir: dir });
    expect(await store.load()).toEqual({});
    await writeFile(join(dir, "network.json"), "{not json", "utf8");
    expect(await store.load()).toEqual({});
    await writeFile(join(dir, "network.json"), JSON.stringify({ proxy: { enabled: true, protocol: "http", host: "", port: 7890 } }), "utf8");
    expect((await store.load()).proxy).toBeUndefined();
    await store.save({ proxy: { enabled: true, protocol: "http", host: "127.0.0.1", port: 7890 } });
    const loaded = await store.load();
    expect(loaded.proxy).toEqual({ enabled: true, protocol: "http", host: "127.0.0.1", port: 7890 });
    expect(typeof loaded.savedAt).toBe("string");
    const onDisk = JSON.parse(await readFile(join(dir, "network.json"), "utf8")) as Record<string, unknown>;
    expect(onDisk["version"]).toBe(1);
    expect(JSON.stringify(onDisk)).not.toContain("password");
  });
});

describe("NetworkSettingsService：优先级与保存生效", () => {
  it("无 env、未保存 → 直连 none；启动装配不建 dispatcher", async () => {
    const dir = await settingsDir();
    const { router, created } = fakeRouter();
    const service = new NetworkSettingsService({ store: new NetworkSettingsStore({ settingsDir: dir }), router });
    expect(await service.applyStartupConfiguration()).toBeNull();
    const status = await service.getStatus();
    expect(status.source).toBe("none");
    expect(status.effective).toBeNull();
    expect(status.envOverride).toBe(false);
    expect(status.saved).toBeNull();
    expect(created).toHaveLength(0);
    expect(status.scope.appliesTo.length).toBeGreaterThan(0);
    expect(status.scope.notAppliedTo.join(" ")).toContain("模型");
  });

  it("保存启用 → router 立即切换（后续请求）；保存关闭 → 回直连但保留输入；非法输入 400", async () => {
    const dir = await settingsDir();
    const { router, created } = fakeRouter();
    const service = new NetworkSettingsService({ store: new NetworkSettingsStore({ settingsDir: dir }), router });
    const saved = await service.save({ enabled: true, protocol: "http", host: "127.0.0.1", port: "7890" });
    expect(saved.source).toBe("stored");
    expect(saved.effective).toEqual({ protocol: "http", host: "127.0.0.1", port: 7890 });
    expect(saved.effectiveUrl).toBe("http://127.0.0.1:7890");
    expect(router.current()).toEqual({ protocol: "http", host: "127.0.0.1", port: 7890 });
    expect(created).toHaveLength(1);
    const disabled = await service.save({ enabled: false, protocol: "http", host: "127.0.0.1", port: 7890 });
    expect(disabled.source).toBe("none");
    expect(disabled.effective).toBeNull();
    expect(disabled.saved).toEqual({ enabled: false, protocol: "http", host: "127.0.0.1", port: 7890 });
    expect(router.current()).toBeNull();
    await expect(service.save({ enabled: true, protocol: "http", host: "", port: 7890 })).rejects.toBeInstanceOf(BusinessError);
    await expect(service.save({ enabled: true, protocol: "http", host: "user:pw@h", port: 7890 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    // 非法输入不落盘、不改 router
    expect(router.current()).toBeNull();
    // 重启装配：stored enabled=false → 直连
    const restarted = new NetworkSettingsService({ store: new NetworkSettingsStore({ settingsDir: dir }), router: fakeRouter().router });
    expect(await restarted.applyStartupConfiguration()).toBeNull();
  });

  it("env 覆盖：生效 env；保存被接受但不改 router；状态如实标 environment", async () => {
    const dir = await settingsDir();
    const { router, created } = fakeRouter();
    const service = new NetworkSettingsService({
      store: new NetworkSettingsStore({ settingsDir: dir }),
      router,
      envProxyUrl: "socks5://10.0.0.2:1080",
    });
    expect(await service.applyStartupConfiguration()).toEqual({ protocol: "socks5", host: "10.0.0.2", port: 1080 });
    const status = await service.save({ enabled: true, protocol: "http", host: "127.0.0.1", port: 7890 });
    expect(status.source).toBe("environment");
    expect(status.envOverride).toBe(true);
    expect(status.effective).toEqual({ protocol: "socks5", host: "10.0.0.2", port: 1080 });
    expect(status.saved).toEqual({ enabled: true, protocol: "http", host: "127.0.0.1", port: 7890 });
    expect(router.current()).toEqual({ protocol: "socks5", host: "10.0.0.2", port: 1080 });
    expect(created).toHaveLength(1);
  });

  it("重启装配：stored enabled=true → router 使用保存值", async () => {
    const dir = await settingsDir();
    await new NetworkSettingsStore({ settingsDir: dir }).save({ proxy: { enabled: true, protocol: "http", host: "127.0.0.1", port: 7890 } });
    const { router } = fakeRouter();
    const service = new NetworkSettingsService({ store: new NetworkSettingsStore({ settingsDir: dir }), router });
    expect(await service.applyStartupConfiguration()).toEqual({ protocol: "http", host: "127.0.0.1", port: 7890 });
    expect(router.current()).toEqual({ protocol: "http", host: "127.0.0.1", port: 7890 });
  });
});

describe("NetworkSettingsService.test：探测与分类", () => {
  async function makeService(canned: Canned, connectOk = true) {
    const dir = await settingsDir();
    const probe = probeRouterFactory(canned);
    const service = new NetworkSettingsService({
      store: new NetworkSettingsStore({ settingsDir: dir }),
      router: fakeRouter().router,
      createProbeRouter: probe.factory,
      connectProbe: async () => (connectOk ? { ok: true } : { ok: false, code: "ECONNREFUSED" }),
      hints: { openalexMailto: "ops@example.org", semanticScholarApiKey: "s2-secret-key" },
      probeTimeoutMs: 2_000,
    });
    return { service, probe };
  }

  it("全部可达：ok=true，PDF 头合法并给出吞吐；探测 router 用候选配置且用后关闭；返回值不含 key", async () => {
    const { service, probe } = await makeService(allOk);
    const result = await service.test({ enabled: true, protocol: "http", host: "127.0.0.1", port: 7890 });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("proxy");
    expect(result.proxy).toBe("http://127.0.0.1:7890");
    const checks = byId(result.checks);
    expect(checks["proxy"]!.status).toBe("ok");
    expect(checks["arxiv_api"]!.status).toBe("ok");
    expect(checks["arxiv_pdf"]!.status).toBe("ok");
    expect(checks["arxiv_pdf"]!.bytes).toBeGreaterThan(0);
    expect(checks["arxiv_pdf"]!.throughputKBps).toBeGreaterThanOrEqual(0);
    expect(checks["openalex"]!.status).toBe("ok");
    expect(checks["semantic_scholar"]!.status).toBe("ok");
    expect(checks["crossref"]!.status).toBe("ok");
    expect(probe.seen.every((entry) => entry.config?.port === 7890)).toBe(true);
    expect(probe.seen.some((entry) => entry.url.includes("mailto=ops%40example.org"))).toBe(true);
    expect(probe.closedCount()).toBe(1);
    expect(JSON.stringify(result)).not.toContain("s2-secret-key");
    expect(result.summary).toContain("5/5");
  });

  it("候选 enabled=false：直连对照测试，proxy 项 skipped，mode=direct", async () => {
    const { service, probe } = await makeService(allOk);
    const result = await service.test({ enabled: false, protocol: "http", host: "127.0.0.1", port: 7890 });
    expect(result.mode).toBe("direct");
    expect(result.proxy).toBeUndefined();
    expect(byId(result.checks)["proxy"]!.status).toBe("skipped");
    expect(result.ok).toBe(true);
    expect(probe.seen.every((entry) => entry.config === null)).toBe(true);
  });

  it("代理端口拒绝连接：学术探测全部 skipped，ok=false，摘要点名代理", async () => {
    const { service, probe } = await makeService(allOk, false);
    const result = await service.test({ enabled: true, protocol: "http", host: "127.0.0.1", port: 7899 });
    expect(result.ok).toBe(false);
    const checks = byId(result.checks);
    expect(checks["proxy"]!.status).toBe("proxy_unreachable");
    expect(checks["proxy"]!.detail).toContain("代理软件");
    expect(checks["arxiv_pdf"]!.status).toBe("skipped");
    expect(probe.seen).toHaveLength(0);
    expect(result.summary).toContain("http://127.0.0.1:7899");
  });

  it("429 + Retry-After → rate_limited（OpenAlex 说明与代理无关、提示 API Key）；HTML 落地页 → not_pdf；5xx → http_error", async () => {
    const { service } = await makeService((url) => {
      if (url.includes("openalex")) return new Response('{"error":"budget"}', { status: 429, headers: { "retry-after": "59493" } });
      if (url.includes("semanticscholar")) return new Response("{}", { status: 429 });
      if (url.includes("arxiv.org/pdf")) return new Response("<html>landing</html>", { status: 200 });
      if (url.includes("crossref")) return new Response("boom", { status: 503 });
      return allOk(url);
    });
    const result = await service.test({ enabled: true, protocol: "http", host: "127.0.0.1", port: 7890 });
    const checks = byId(result.checks);
    expect(checks["openalex"]!.status).toBe("rate_limited");
    expect(checks["openalex"]!.retryAfterSeconds).toBe(59493);
    expect(checks["openalex"]!.detail).toContain("与代理无关");
    expect(checks["openalex"]!.detail).toContain("API Key");
    expect(checks["semantic_scholar"]!.status).toBe("rate_limited");
    expect(checks["arxiv_pdf"]!.status).toBe("not_pdf");
    expect(checks["crossref"]!.status).toBe("http_error");
    expect(checks["crossref"]!.httpStatus).toBe(503);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("限流");
  });

  it("请求阶段代理错误 → proxy_unreachable；超时 → timeout；其它网络错误带 cause code", async () => {
    const { service } = await makeService((url) => {
      if (url.includes("export.arxiv.org")) return new ResearchProxyError("proxy_unreachable", "http://127.0.0.1:7890", "unreachable");
      if (url.includes("arxiv.org/pdf")) return Object.assign(new Error("probe timeout"), { name: "AbortError" });
      if (url.includes("crossref")) return new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ENOTFOUND" }) });
      return allOk(url);
    });
    const result = await service.test({ enabled: true, protocol: "http", host: "127.0.0.1", port: 7890 });
    const checks = byId(result.checks);
    expect(checks["arxiv_api"]!.status).toBe("proxy_unreachable");
    expect(checks["arxiv_pdf"]!.status).toBe("timeout");
    expect(checks["crossref"]!.status).toBe("network_error");
    expect(checks["crossref"]!.detail).toContain("ENOTFOUND");
    expect(result.ok).toBe(false);
  });

  it("test() 无参 = 测当前生效配置（env 优先）", async () => {
    const dir = await settingsDir();
    const probe = probeRouterFactory(allOk);
    const service = new NetworkSettingsService({
      store: new NetworkSettingsStore({ settingsDir: dir }),
      router: fakeRouter().router,
      envProxyUrl: "http://127.0.0.1:7890",
      createProbeRouter: probe.factory,
      connectProbe: async () => ({ ok: true }),
    });
    const result = await service.test();
    expect(result.mode).toBe("proxy");
    expect(probe.seen.every((entry) => entry.config?.host === "127.0.0.1")).toBe(true);
  });
});
