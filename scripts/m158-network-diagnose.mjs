#!/usr/bin/env node
/**
 * M15.8.1 Phase A —— Research 代理链路只读诊断（0 模型调用）。
 *
 * 目的：确认本机 127.0.0.1:7890 的真实可用性（HTTP / SOCKS5 / mixed）、
 * 学术六项探测（proxy / arxiv_api / arxiv_pdf / openalex / semantic_scholar /
 * crossref）在「代理 vs 直连」下的表现，以及完整 OA PDF 下载的三路 A/B
 * （Node 内建 fetch 直连 / ResearchFetchRouter 走 7890 / curl --proxy）。
 *
 * 只读：不写任何项目 / 设置 / 预算账本；产物为
 * <M158_DATA_ROOT>\network-repair\proxy-diagnosis.json（无凭据）。
 *
 * 用法：node scripts/m158-network-diagnose.mjs [--probe-url <pdf-url>]
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const DATA_ROOT = process.env["M158_DATA_ROOT"] ?? "D:\\PaperTeamData\\M15\\M15_8";
const OUT_DIR = join(DATA_ROOT, "network-repair");
const OUT_PATH = join(OUT_DIR, "proxy-diagnosis.json");

// 完整下载探针：arXiv:1706.03762（Attention Is All You Need；与网络设置 UI 探测同源）
const PROBE_URL = process.env["M158_NETWORK_PROBE_URL"] ?? "https://arxiv.org/pdf/1706.03762";
const FULL_DOWNLOAD_TIMEOUT_MS = 120_000;
const DIRECT_COMPARE_TIMEOUT_MS = 30_000;

const { loadConfig } = await import(distUrl("config", "config.js"));
const { ResearchFetchRouter, formatResearchProxyUrl } = await import(distUrl("network", "researchProxy.js"));
const { NetworkSettingsService } = await import(distUrl("settings", "NetworkSettingsService.js"));
const { NetworkSettingsStore } = await import(distUrl("settings", "NetworkSettingsStore.js"));

await mkdir(OUT_DIR, { recursive: true });
const config = loadConfig();

// ---- 事实记录：env / 保存设置 ----
const ENV_KEYS = [
  "PAPERTEAM_RESEARCH_PROXY_URL",
  "PAPERTEAM_RUNTIME_ROOT",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
];
const envFacts = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key] === undefined ? "unset" : `set(len=${process.env[key].length})`]),
);
const store = new NetworkSettingsStore({ settingsDir: join(config.runtimeRoot, "settings") });
const savedSettings = await store.load();

// 候选代理 = env（若合法）> 保存值；两者皆无时用脚本参数缺省 127.0.0.1:7890（仅探测，不落盘）
const candidateFromEnvOrSaved =
  config.research.proxyUrl !== undefined
    ? { source: "environment", url: config.research.proxyUrl }
    : savedSettings.proxy !== undefined && savedSettings.proxy.enabled
      ? {
          source: "stored",
          url: formatResearchProxyUrl({
            protocol: savedSettings.proxy.protocol,
            host: savedSettings.proxy.host,
            port: savedSettings.proxy.port,
          }),
        }
      : { source: "default-probe", url: process.env["M158_NETWORK_CANDIDATE"] ?? "http://127.0.0.1:7890" };

const parseCandidate = (url) => {
  const parsed = new URL(url);
  return { protocol: parsed.protocol.replace(":", ""), host: parsed.hostname, port: Number(parsed.port) };
};
const candidate = parseCandidate(candidateFromEnvOrSaved.url);

// ---- 完整 PDF 下载（数组缓冲 + %PDF- 头 + SHA256）----
async function downloadFull(fetchFn, label, timeoutMs) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("download timeout")), timeoutMs);
  try {
    const response = await fetchFn(PROBE_URL, {
      headers: { "User-Agent": "PaperTeam/0.1 (M15.8.1 network diagnosis)", Accept: "application/pdf" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { path: label, ok: false, httpStatus: response.status, latencyMs: Date.now() - startedAt };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const head = buffer.subarray(0, 5).toString("latin1");
    return {
      path: label,
      ok: head === "%PDF-" && buffer.byteLength > 10_000,
      httpStatus: response.status,
      latencyMs: Date.now() - startedAt,
      bytes: buffer.byteLength,
      head: head.split("").map((c) => c.charCodeAt(0)).join(","),
      sha256: createHash("sha256").update(buffer).digest("hex"),
    };
  } catch (error) {
    const cause = error?.cause;
    return {
      path: label,
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: String(error?.name ?? error?.message ?? error).slice(0, 120),
      errorCode: typeof cause?.code === "string" ? cause.code : undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---- 三路 A/B：直连内建 fetch / router 走 7890 / curl --proxy ----
const diagnosis = {
  schema: "m158-network-diagnosis/v1",
  at: new Date().toISOString(),
  codeVersion: process.env["M158_CODE_VERSION"] ?? "unknown",
  probeUrl: PROBE_URL,
  configSource: candidateFromEnvOrSaved,
  candidate,
  envFacts,
  savedSettings,
  portCapability: null,
  fullDownloadAb: [],
  serviceTestProxy: null,
  serviceTestDirect: null,
  notes: [
    "只读诊断；未写任何项目 / 设置 / 预算账本，0 模型调用",
    "fullDownloadAb 三路同 URL 对照（router 为产品同一条 ResearchFetchRouter 路径）",
  ],
};

// 1) 端口能力：HTTP 与 SOCKS5 是否都被 7890 接受（Clash mixed-port 两者皆可）
{
  const capability = { httpConnect: null, socks5: null };
  const httpRouter = new ResearchFetchRouter({ releaseGraceMs: 5_000 });
  httpRouter.configure({ protocol: "http", host: candidate.host, port: candidate.port });
  try {
    const response = await httpRouter.fetch("https://export.arxiv.org/api/query?search_query=all:electron&max_results=1", {
      headers: { "User-Agent": "PaperTeam/0.1 (port capability probe)" },
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel().catch(() => {});
    capability.httpConnect = { ok: response.status === 200, httpStatus: response.status };
  } catch (error) {
    capability.httpConnect = { ok: false, error: String(error?.message ?? error).slice(0, 100) };
  } finally {
    await httpRouter.close().catch(() => {});
  }
  if (candidate.protocol === "http") {
    // 仅当候选为 http 时探测同端口 SOCKS5 能力（socks5h 域名解析在代理侧）
    const socksRouter = new ResearchFetchRouter({ releaseGraceMs: 5_000 });
    socksRouter.configure({ protocol: "socks5", host: candidate.host, port: candidate.port });
    try {
      const response = await socksRouter.fetch("https://export.arxiv.org/api/query?search_query=all:electron&max_results=1", {
        headers: { "User-Agent": "PaperTeam/0.1 (port capability probe)" },
        signal: AbortSignal.timeout(15_000),
      });
      await response.body?.cancel().catch(() => {});
      capability.socks5 = { ok: response.status === 200, httpStatus: response.status };
    } catch (error) {
      capability.socks5 = { ok: false, error: String(error?.message ?? error).slice(0, 100) };
    } finally {
      await socksRouter.close().catch(() => {});
    }
  }
  diagnosis.portCapability = capability;
}

// 2) 完整 PDF 三路 A/B
const abRouter = new ResearchFetchRouter({ releaseGraceMs: 5_000 });
try {
  abRouter.configure(candidate);
  diagnosis.fullDownloadAb.push(await downloadFull((url, init) => fetch(url, init), "node-built-in-direct", DIRECT_COMPARE_TIMEOUT_MS));
  diagnosis.fullDownloadAb.push(await downloadFull(abRouter.fetch, "research-router-proxy", FULL_DOWNLOAD_TIMEOUT_MS));
  // curl：显式 --proxy（不依赖 shell 环境变量）；-x http://host:port 对 https 目标即 HTTP CONNECT
  {
    const startedAt = Date.now();
    try {
      const tmp = join(OUT_DIR, "probe-curl-download.bin");
      const { stdout } = await execFileAsync(
        "curl",
        [
          "-sL",
          "--max-time",
          "90",
          "--proxy",
          `${candidate.protocol}://${candidate.host}:${candidate.port}`,
          "-o",
          tmp,
          "-w",
          "%{http_code}",
          PROBE_URL,
        ],
        { timeout: 100_000, maxBuffer: 10 },
      );
      const content = await readFile(tmp).catch(() => Buffer.alloc(0));
      const head = content.subarray(0, 5).toString("latin1");
      diagnosis.fullDownloadAb.push({
        path: "curl-explicit-proxy",
        ok: stdout.trim() === "200" && head === "%PDF-" && content.byteLength > 10_000,
        httpStatus: Number(stdout.trim()) || 0,
        latencyMs: Date.now() - startedAt,
        bytes: content.byteLength,
        sha256: content.byteLength > 0 ? createHash("sha256").update(content).digest("hex") : undefined,
      });
    } catch (error) {
      diagnosis.fullDownloadAb.push({
        path: "curl-explicit-proxy",
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: String(error?.message ?? error).slice(0, 120),
      });
    }
  }
} finally {
  await abRouter.close().catch(() => {});
}

// 3) 六项服务探测：代理模式 vs 直连（产品自身 NetworkSettingsService.test，候选显式传入）
{
  const service = new NetworkSettingsService({ store, router: new ResearchFetchRouter(), log: () => {} });
  diagnosis.serviceTestProxy = await service.test({
    enabled: true,
    protocol: candidate.protocol,
    host: candidate.host,
    port: candidate.port,
  });
  await new Promise((r) => setTimeout(r, 3_000)); // 相邻探测间隔（礼貌）
  diagnosis.serviceTestDirect = await service.test({
    enabled: false,
    protocol: candidate.protocol,
    host: candidate.host,
    port: candidate.port,
  });
}

// ---- 落盘（原子）----
await mkdir(OUT_DIR, { recursive: true });
const tmp = `${OUT_PATH}.tmp`;
await writeFile(tmp, JSON.stringify(diagnosis, null, 2), "utf8");
await rename(tmp, OUT_PATH);

const ab = diagnosis.fullDownloadAb;
console.log(`[diagnose] candidate=${candidateFromEnvOrSaved.url}（来源 ${candidateFromEnvOrSaved.source}）`);
console.log(
  `[diagnose] port http=${diagnosis.portCapability.httpConnect?.ok ?? "?"} socks5=${diagnosis.portCapability.socks5?.ok ?? "n/a"}`,
);
for (const result of ab) {
  console.log(
    `[diagnose] ${result.path}: ${result.ok ? "OK" : "FAIL"}${result.httpStatus ? ` HTTP ${result.httpStatus}` : ""}` +
      `${result.bytes ? ` ${result.bytes}B` : ""}${result.latencyMs ? ` ${result.latencyMs}ms` : ""}` +
      `${result.error ? ` err=${result.error}` : ""}`,
  );
}
console.log(`[diagnose] 六项探测（代理）ok=${diagnosis.serviceTestProxy.ok}：${diagnosis.serviceTestProxy.summary}`);
console.log(`[diagnose] 六项探测（直连）ok=${diagnosis.serviceTestDirect.ok}：${diagnosis.serviceTestDirect.summary}`);
console.log(`[diagnose] 落盘 ${OUT_PATH}`);
process.exit(0);
