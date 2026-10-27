/**
 * Research 网络装配（M15.8.1）：initResearchNetwork 优先级语义、真实 harness
 * （bootstrap → buildServiceStack.researchFetch → ProviderHttpClient → downloadPdf）
 * 的全文下载代理路径、probeResearchNetwork fail-fast 分类、M15.8 运行脚本接线守卫。
 *
 * 全部离线（除显式 env 门控的 live 项）：dispatcher / proxiedFetch / directFetch /
 * 探测 router / TCP 探测均为注入 fake，不访问公网、不创建真实连接。
 *
 * 背景（回归对象）：M15.8 真实 E2E 脚本自行 buildServiceStack 未配 researchFetch，
 * 学术请求全程直连；公司网络下 arXiv 不可达 → 25 篇文献 19 篇 metadata_only。
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Dispatcher } from "undici";
import { afterAll, describe, expect, it } from "vitest";

import { LatexCompiler } from "../../src/latex/LatexCompiler.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import { buildServiceStack } from "../../src/serviceStack.js";
import { initResearchNetwork, probeResearchNetwork } from "../../src/network/researchNetworkBootstrap.js";
import type { ResearchNetworkBootstrap } from "../../src/network/researchNetworkBootstrap.js";
import { ProviderHttpClient } from "../../src/search/providerHttp.js";
import { downloadPdf } from "../../src/search/fullText.js";
import { NetworkSettingsStore } from "../../src/settings/NetworkSettingsStore.js";
import { AGENT_IDS, createScriptedRuntime } from "../helpers/testStack.js";

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function settingsDirWith(proxy: { enabled: boolean; protocol?: string; host?: string; port?: number }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pt-net-bootstrap-"));
  tempDirs.push(dir);
  await writeFile(
    join(dir, "network.json"),
    JSON.stringify({
      version: 1,
      proxy: { enabled: proxy.enabled, protocol: proxy.protocol ?? "http", host: proxy.host ?? "127.0.0.1", port: proxy.port ?? 7890 },
      savedAt: "2026-10-27T00:00:00.000Z",
    }),
    "utf8",
  );
  return dir;
}

interface RouterObservatory {
  directCalls: string[];
  proxiedCalls: string[];
  dispatchers: unknown[];
}

/** fake router 构造参数：记录 direct / proxied 调用，不出网 */
function observingRouterOptions(pdfFor?: (url: string) => Response | undefined): RouterObservatory & {
  routerOptions: { directFetch: typeof fetch; proxiedFetch: (url: string, init: RequestInit | undefined, dispatcher: Dispatcher) => Promise<Response>; createDispatcher: () => Dispatcher; releaseGraceMs: number };
} {
  const observatory: RouterObservatory = { directCalls: [], proxiedCalls: [], dispatchers: [] };
  return {
    ...observatory,
    routerOptions: {
      directFetch: (async (input: string | URL | Request) => {
        observatory.directCalls.push(String(input));
        return new Response("direct", { status: 200 });
      }) as typeof fetch,
      proxiedFetch: async (url, _init, _dispatcher) => {
        observatory.proxiedCalls.push(String(url));
        const canned = pdfFor?.(String(url));
        if (canned !== undefined) return canned;
        return new Response("proxied", { status: 200 });
      },
      createDispatcher: () => {
        const dispatcher = { close: async () => {}, destroy: async () => {} } as unknown as Dispatcher;
        observatory.dispatchers.push(dispatcher);
        return dispatcher;
      },
      releaseGraceMs: 50,
    },
  };
}

/** 带文本层的最小 PDF（%PDF- 头 + 一定体积，通过 downloadPdf 魔数与大小护栏） */
function minimalPdf(): Buffer {
  const head = Buffer.from("%PDF-1.4\n");
  return Buffer.concat([head, Buffer.alloc(8 * 1024, 0x42), Buffer.from("\n%%EOF\n")]);
}

describe("initResearchNetwork：env > network.json > 直连", () => {
  it("UI 保存的启用配置（未设 env）→ 生效 stored 代理", async () => {
    const dir = await settingsDirWith({ enabled: true });
    const obs = observingRouterOptions();
    const net = await initResearchNetwork({ settingsDir: dir, routerOptions: obs.routerOptions, log: () => {} });
    expect(net.source).toBe("stored");
    expect(net.effectiveUrl).toBe("http://127.0.0.1:7890");
    expect(net.envOverride).toBe(false);
    expect(obs.dispatchers.length).toBe(1);
    // 路由行为：公网目标走 proxied
    await net.router.fetch("https://arxiv.org/pdf/1706.03762");
    expect(net.router.stats().proxied).toBe(1);
    await net.router.close();
  });

  it("env 与保存值冲突：env 生效；保存 disabled 不屏蔽 env", async () => {
    const dir = await settingsDirWith({ enabled: false, port: 9999 });
    const obs = observingRouterOptions();
    const net = await initResearchNetwork({
      settingsDir: dir,
      envProxyUrl: "http://127.0.0.1:7890",
      routerOptions: obs.routerOptions,
      log: () => {},
    });
    expect(net.source).toBe("environment");
    expect(net.envOverride).toBe(true);
    expect(net.effectiveUrl).toBe("http://127.0.0.1:7890"); // 而非保存的 9999
    expect(obs.dispatchers.length).toBe(1);
    await net.router.close();
  });

  it("无 env 且保存 enabled=false → 直连（source=none）", async () => {
    const dir = await settingsDirWith({ enabled: false });
    const obs = observingRouterOptions();
    const net = await initResearchNetwork({ settingsDir: dir, routerOptions: obs.routerOptions, log: () => {} });
    expect(net.source).toBe("none");
    expect(net.effective).toBeNull();
    expect(obs.dispatchers.length).toBe(0);
    await net.router.fetch("https://arxiv.org/pdf/1706.03762");
    expect(obs.directCalls.length).toBe(1); // 直连 = 内建 fetch 语义（这里是注入 direct）
    await net.router.close();
  });

  it("localhost / 私网 / 单标签主机在代理启用时仍直连（bypass 计数）", async () => {
    const dir = await settingsDirWith({ enabled: true });
    const obs = observingRouterOptions();
    const net = await initResearchNetwork({ settingsDir: dir, routerOptions: obs.routerOptions, log: () => {} });
    for (const url of ["http://127.0.0.1:8787/api", "http://10.1.2.3/x", "http://searxng/search"]) {
      await net.router.fetch(url);
    }
    const stats = net.router.stats();
    expect(stats.proxied).toBe(0);
    expect(stats.bypassed).toBe(3);
    expect(obs.proxiedCalls.length).toBe(0);
    await net.router.close();
  });
});

describe("真实 harness：bootstrap → buildServiceStack → 全文下载经代理", () => {
  it("UI 保存配置（无 env）下，OA PDF 下载走 researchFetch：proxied>0 且直连 fetch 未被调用", async () => {
    const dir = await settingsDirWith({ enabled: true });
    const pdf = minimalPdf();
    const obs = observingRouterOptions(
      (url) => (url.includes("arxiv.org/pdf/") ? new Response(pdf, { status: 200, headers: { "content-type": "application/pdf" } }) : undefined),
    );
    const net = await initResearchNetwork({ settingsDir: dir, routerOptions: obs.routerOptions, log: () => {} });

    const root = await mkdtemp(join(tmpdir(), "pt-net-harness-"));
    tempDirs.push(root);
    const stack = buildServiceStack({
      runtime: createScriptedRuntime().runtime,
      projects: new ProjectStore({ root }),
      latex: new LatexCompiler({ timeoutMs: 1_000 }),
      agentIds: { ...AGENT_IDS },
      researchFetch: net.router.fetch,
      fullText: {
        resolvers: [
          {
            name: "arxiv",
            async resolve() {
              return { kind: "found", url: "https://arxiv.org/pdf/2401.99999", source: "arxiv" };
            },
          },
        ],
      },
      log: () => {},
    });
    const project = await stack.projects.create("代理接线 harness");
    const { source } = await stack.sourceImport.importArxiv(project.id, { arxivId: "2401.99999", enrich: false });
    expect(source.status).toBe("metadata_only");

    const result = await stack.sourceImport.tryResolveFullText(project.id, source.sourceId);
    expect(result.outcome).toBe("resolved");
    // 核心断言：请求经代理、直连 fetch 零调用
    expect(net.router.stats().proxied).toBeGreaterThan(0);
    expect(obs.directCalls.filter((url) => url.includes("arxiv.org"))).toHaveLength(0);
    expect(obs.proxiedCalls.some((url) => url.includes("arxiv.org/pdf/2401.99999"))).toBe(true);
    // provenance 诚实：resolver 名（不是 manual-upload）
    const after = await stack.sources.getRequired(project.id, source.sourceId);
    expect(after.fileName).toBeDefined();
    expect(after.fullText?.resolver).toBe("arxiv");
    expect(after.fullText?.url).toContain("arxiv.org/pdf/2401.99999");
    await net.router.close();
  });
});

describe("probeResearchNetwork：fail-fast 分类", () => {
  type Canned = (url: string) => Response | Error;

  function probeFactory(canned: Canned) {
    return (_config: unknown): { fetch: typeof fetch; close: () => Promise<void> } => ({
      fetch: (async (input: string | URL | Request) => {
        const outcome = canned(String(input));
        if (outcome instanceof Error) throw outcome;
        return outcome;
      }) as typeof fetch,
      close: async () => {},
    });
  }

  const pdfOk: Canned = (url) => {
    if (url.includes("export.arxiv.org")) return new Response("<feed></feed>", { status: 200 });
    if (url.includes("arxiv.org/pdf")) return new Response(minimalPdf(), { status: 200 });
    if (url.includes("openalex")) return new Response('{"results":[]}', { status: 200 });
    if (url.includes("semanticscholar")) return new Response('{"total":0}', { status: 200 });
    if (url.includes("crossref")) return new Response('{"status":"ok"}', { status: 200 });
    return new Response("{}", { status: 404 });
  };

  async function bootstrapWith(canned: Canned, connect: () => Promise<{ ok: boolean; code?: string }>): Promise<ResearchNetworkBootstrap> {
    const dir = await settingsDirWith({ enabled: true });
    const obs = observingRouterOptions();
    return initResearchNetwork({
      settingsDir: dir,
      routerOptions: obs.routerOptions,
      createProbeRouter: probeFactory(canned),
      connectProbe: connect,
      log: () => {},
    });
  }

  it("代理 TCP 不可达 → PROXY_UNREACHABLE（不降级直连）", async () => {
    const net = await bootstrapWith(pdfOk, async () => ({ ok: false, code: "ECONNREFUSED" }));
    const diagnosis = await probeResearchNetwork(net);
    expect(diagnosis.status).toBe("PROXY_UNREACHABLE");
    expect(diagnosis.mode).toBe("proxy");
    await net.router.close();
  });

  it("代理可达但 arXiv PDF 超时 → ARXIV_PDF_TIMEOUT", async () => {
    const timeoutCanned: Canned = (url) => {
      if (url.includes("arxiv.org/pdf")) {
        const error = new Error("probe timeout");
        error.name = "TimeoutError";
        throw error;
      }
      return pdfOk(url);
    };
    const net = await bootstrapWith(timeoutCanned, async () => ({ ok: true }));
    const diagnosis = await probeResearchNetwork(net);
    expect(diagnosis.status).toBe("ARXIV_PDF_TIMEOUT");
    await net.router.close();
  });

  it("arXiv PDF 429 → TARGET_RATE_LIMITED（与代理功能无关的配额）", async () => {
    const limited: Canned = (url) => {
      if (url.includes("arxiv.org/pdf")) return new Response("too many requests", { status: 429, headers: { "retry-after": "60" } });
      return pdfOk(url);
    };
    const net = await bootstrapWith(limited, async () => ({ ok: true }));
    const diagnosis = await probeResearchNetwork(net);
    expect(diagnosis.status).toBe("TARGET_RATE_LIMITED");
    expect(diagnosis.test.checks.find((c) => c.id === "arxiv_pdf")?.retryAfterSeconds).toBe(60);
    await net.router.close();
  });

  it("核心路径全通 → PASS（代理模式）", async () => {
    const net = await bootstrapWith(pdfOk, async () => ({ ok: true }));
    const diagnosis = await probeResearchNetwork(net);
    expect(diagnosis.status).toBe("PASS");
    expect(diagnosis.mode).toBe("proxy");
    await net.router.close();
  });

  it("直连模式：arXiv 不可达但 OpenAlex 可达 → PASS（provider 非单点兜底）；全部不可达 → ACADEMIC_UNREACHABLE", async () => {
    const dir = await settingsDirWith({ enabled: false });
    const openalexOnly: Canned = (url) => {
      if (url.includes("openalex")) return new Response('{"results":[]}', { status: 200 });
      const error = new Error("fetch failed");
      (error as { cause?: { code: string } }).cause = { code: "UND_ERR_CONNECT_TIMEOUT" };
      throw error;
    };
    const net = await initResearchNetwork({
      settingsDir: dir,
      createProbeRouter: probeFactory(openalexOnly),
      connectProbe: async () => ({ ok: false, code: "ECONNREFUSED" }),
      log: () => {},
    });
    expect((await probeResearchNetwork(net)).status).toBe("PASS");

    const nothing: Canned = () => {
      throw new Error("fetch failed");
    };
    const net2 = await initResearchNetwork({
      settingsDir: dir,
      createProbeRouter: probeFactory(nothing),
      connectProbe: async () => ({ ok: false, code: "ECONNREFUSED" }),
      log: () => {},
    });
    expect((await probeResearchNetwork(net2)).status).toBe("ACADEMIC_UNREACHABLE");
    await net.router.close();
    await net2.router.close();
  });
});

describe("M15.8 运行脚本接线守卫（回归：脚本漏配 researchFetch → 全程直连）", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const RUN_SCRIPTS = [
    "m158-p-survey-e2e.mjs",
    "m158-p-fulltext-backfill.mjs",
    "m158-p-preground.mjs",
    "m158-p-buildcheck.mjs",
    "m158-g7-reproducibility.mjs",
    "m158-h-author-decision.mjs",
    "m158-n-negative-e2e.mjs",
  ];

  it.each(RUN_SCRIPTS)("%s：装配 initResearchNetwork 并向 buildServiceStack 传 researchFetch", async (file) => {
    const source = await readFile(join(repoRoot, "scripts", file), "utf8");
    expect(source).toContain('distUrl("network", "researchNetworkBootstrap.js")');
    expect(source).toMatch(/researchFetch:\s*researchNet\.router\.fetch/);
    expect(source).toContain("initResearchNetwork({");
  });

  it("survey E2E 与 backfill：学术 preflight 走 probeResearchNetwork（fail-fast）", async () => {
    for (const file of ["m158-p-survey-e2e.mjs", "m158-p-fulltext-backfill.mjs"]) {
      const source = await readFile(join(repoRoot, "scripts", file), "utf8");
      expect(source).toContain("probeResearchNetwork");
    }
  });

  it("backfill：不再用 curl+attachManualFullText 冒称手动上传（provenance 诚实）", async () => {
    const source = await readFile(join(repoRoot, "scripts", "m158-p-fulltext-backfill.mjs"), "utf8");
    expect(source).not.toMatch(/\.attachManualFullText\(/);
    expect(source).not.toMatch(/execFile\(\s*"curl"/);
    expect(source).toContain("resolveFullTextBatch");
  });
});

// ---- live 集成（默认关闭；PAPERTEAM_LIVE_NETWORK_TESTS=1 + PAPERTEAM_RESEARCH_PROXY_URL）----
describe("live：真实代理全文件下载（zero-LLM，env 门控）", () => {
  const live = process.env["PAPERTEAM_LIVE_NETWORK_TESTS"] === "1";
  const proxyUrl = process.env["PAPERTEAM_RESEARCH_PROXY_URL"] ?? "http://127.0.0.1:7890";
  it.skipIf(!live)("经 ResearchFetchRouter 从 arXiv 完整下载合法 OA PDF（%PDF- + SHA256）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pt-net-live-"));
    tempDirs.push(dir);
    await new NetworkSettingsStore({ settingsDir: dir }).save({
      proxy: { enabled: true, protocol: "http", host: new URL(proxyUrl).hostname, port: Number(new URL(proxyUrl).port) },
    });
    const net = await initResearchNetwork({ settingsDir: dir, log: () => {} });
    expect(net.effective).not.toBeNull();
    const http = new ProviderHttpClient({ fetchImpl: net.router.fetch });
    const downloaded = await downloadPdf("https://arxiv.org/pdf/1706.03762", { http });
    expect(downloaded.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(downloaded.bytes.byteLength).toBeGreaterThan(100_000);
    expect(downloaded.bytes.byteLength).toBeLessThanOrEqual(20 * 1024 * 1024);
    const sha256 = createHash("sha256").update(downloaded.bytes).digest("hex");
    console.log(`[live] arXiv 1706.03762 via ${proxyUrl}: ${downloaded.bytes.byteLength}B sha256=${sha256.slice(0, 16)}… router=${JSON.stringify(net.router.stats())}`);
    expect(net.router.stats().proxied).toBeGreaterThan(0);
    await net.router.close();
  }, 120_000);
});
