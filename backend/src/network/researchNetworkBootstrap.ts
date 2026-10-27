/**
 * Research 网络出口装配（M15.8.1 抽取）：生产入口（index.ts）与真实运行脚本
 * （scripts/m158-*.mjs）共用同一套初始化，消除「脚本漏配 researchFetch 直连
 * 学术站点」这类装配漂移（M15.8 实测事故根因）。
 *
 * 语义与 index.ts 原内联实现逐字一致：
 * - 优先级 env PAPERTEAM_RESEARCH_PROXY_URL > settings/network.json（enabled）> 直连；
 * - 只把 router.fetch 交给调用方注入 buildServiceStack.researchFetch——学术检索 /
 *   全文下载 / 元数据核验的 HTTP 客户端（ProviderHttpClient / ScholarlyHttpClient）；
 *   模型 Runtime / 本机 API / docling 不经过它（不触碰进程全局 dispatcher）；
 * - 脚本另可用 probeResearchNetwork 做 0 模型 fail-fast 预检：代理已配置但核心
 *   学术路径（代理可达 / arXiv API / arXiv PDF）不可用时结构化退出，不静默降级
 *   直连、不消耗模型预算。
 */

import {
  NetworkSettingsService,
  type NetworkConfigurationSource,
  type NetworkSettingsServiceOptions,
  type NetworkTestResult,
} from "../settings/NetworkSettingsService.js";
import { NetworkSettingsStore } from "../settings/NetworkSettingsStore.js";
import {
  ResearchFetchRouter,
  formatResearchProxyUrl,
  type ResearchProxyConfig,
  type ResearchFetchRouterOptions,
} from "./researchProxy.js";

/** 探测礼貌标识（与生产 provider 同源配置；绝不进入日志 / 返回值） */
export interface ResearchNetworkHints {
  openalexMailto?: string;
  semanticScholarApiKey?: string;
  crossrefMailto?: string;
}

export interface ResearchNetworkBootstrap {
  router: ResearchFetchRouter;
  networkSettings: NetworkSettingsService;
  /** 生效配置（null = 直连） */
  effective: ResearchProxyConfig | null;
  /** 生效配置的规范 URL（直连时 null；无凭据） */
  effectiveUrl: string | null;
  /** 生效配置来源：environment（env 覆盖）/ stored（UI 保存）/ none（直连） */
  source: NetworkConfigurationSource;
  envOverride: boolean;
}

export interface InitResearchNetworkOptions {
  /** network.json 所在目录（生产 = <runtimeRoot>/settings） */
  settingsDir: string;
  /** PAPERTEAM_RESEARCH_PROXY_URL（已由 config 校验规范化；存在即覆盖 UI 保存） */
  envProxyUrl?: string;
  hints?: ResearchNetworkHints;
  /** 测试注入：router 构造参数（fake dispatcher / fake proxied fetch；不出网） */
  routerOptions?: ResearchFetchRouterOptions;
  /** 测试注入：探测 router 工厂 / TCP 探测（NetworkSettingsService 同名 seam） */
  createProbeRouter?: NetworkSettingsServiceOptions["createProbeRouter"];
  connectProbe?: NetworkSettingsServiceOptions["connectProbe"];
  log?: (message: string) => void;
}

/** 生产与真实运行脚本共用的启动装配（内部即打印 research net 启动行） */
export async function initResearchNetwork(
  options: InitResearchNetworkOptions,
): Promise<ResearchNetworkBootstrap> {
  const log = options.log ?? (() => {});
  const router = new ResearchFetchRouter({ log, ...options.routerOptions });
  const networkSettings = new NetworkSettingsService({
    store: new NetworkSettingsStore({ settingsDir: options.settingsDir }),
    router,
    ...(options.envProxyUrl !== undefined ? { envProxyUrl: options.envProxyUrl } : {}),
    ...(options.hints !== undefined ? { hints: options.hints } : {}),
    ...(options.createProbeRouter !== undefined ? { createProbeRouter: options.createProbeRouter } : {}),
    ...(options.connectProbe !== undefined ? { connectProbe: options.connectProbe } : {}),
    log,
  });
  const effective = await networkSettings.applyStartupConfiguration();
  const source: NetworkConfigurationSource =
    options.envProxyUrl !== undefined ? "environment" : effective !== null ? "stored" : "none";
  log(
    `  research net: ${
      effective === null
        ? "直连（未配置代理）"
        : `代理 ${formatResearchProxyUrl(effective)}（来源 ${
            options.envProxyUrl !== undefined ? "PAPERTEAM_RESEARCH_PROXY_URL" : "settings/network.json"
          }；仅学术检索 / 全文下载 / 元数据核验）`
    }`,
  );
  return {
    router,
    networkSettings,
    effective,
    effectiveUrl: effective === null ? null : formatResearchProxyUrl(effective),
    source,
    envOverride: options.envProxyUrl !== undefined,
  };
}

// ---- 0 模型 fail-fast 预检（复用 NetworkSettingsService.test 的六项探测）----

/** 结构化预检结论（脚本据此退出并落诊断，不静默降级直连） */
export type ResearchPreflightStatus =
  | "PASS"
  /** 代理已配置但 TCP 不可达 / 拒绝隧道 */
  | "PROXY_UNREACHABLE"
  /** 代理通、arXiv PDF 下载超时 / 网络错误 */
  | "ARXIV_PDF_TIMEOUT"
  /** 目标服务限流（429；按出口 IP 计，与代理功能无关） */
  | "TARGET_RATE_LIMITED"
  /** 直连模式下核心学术服务全不可达（旧 preflight 的 BLOCKED_EXTERNAL 同义） */
  | "ACADEMIC_UNREACHABLE";

export interface ResearchPreflightDiagnosis {
  status: ResearchPreflightStatus;
  /** 人类可读（中文；主机级目标，无 query / 凭据） */
  detail: string;
  mode: "proxy" | "direct";
  proxyUrl: string | null;
  /** NetworkSettingsService.test 的原样结果（审计 / 落盘用） */
  test: NetworkTestResult;
}

/**
 * 学术链路预检（0 模型）。代理模式要求核心路径（代理可达 + arXiv API + arXiv
 * PDF）全部 ok；直连模式放宽为「arXiv 或 OpenAlex 至少一项可用」（与 M15.8
 * 旧 preflight 的 openalex 兜底语义一致），全部不可达才判 ACADEMIC_UNREACHABLE。
 */
export async function probeResearchNetwork(
  bootstrap: ResearchNetworkBootstrap,
): Promise<ResearchPreflightDiagnosis> {
  const test = await bootstrap.networkSettings.test();
  const byId = new Map(test.checks.map((check) => [check.id, check]));
  const mode = test.mode;
  if (mode === "proxy") {
    if (test.ok) {
      return { status: "PASS", detail: test.summary, mode, proxyUrl: test.proxy ?? null, test };
    }
    const proxy = byId.get("proxy");
    if (proxy !== undefined && (proxy.status === "proxy_unreachable" || proxy.status === "proxy_rejected" || proxy.status === "timeout")) {
      return {
        status: "PROXY_UNREACHABLE",
        detail: `${proxy.detail}（已启用代理，不降级直连）`,
        mode,
        proxyUrl: test.proxy ?? null,
        test,
      };
    }
    const pdf = byId.get("arxiv_pdf");
    if (pdf !== undefined && pdf.status === "rate_limited") {
      return { status: "TARGET_RATE_LIMITED", detail: pdf.detail, mode, proxyUrl: test.proxy ?? null, test };
    }
    if (pdf !== undefined && (pdf.status === "timeout" || pdf.status === "network_error" || pdf.status === "not_pdf" || pdf.status === "http_error")) {
      return { status: "ARXIV_PDF_TIMEOUT", detail: pdf.detail, mode, proxyUrl: test.proxy ?? null, test };
    }
    return { status: "ARXIV_PDF_TIMEOUT", detail: test.summary, mode, proxyUrl: test.proxy ?? null, test };
  }
  // 直连：arXiv API / PDF 任一 ok 或 OpenAlex ok 即放行（provider 集合非单点）
  const arxivApi = byId.get("arxiv_api");
  const arxivPdf = byId.get("arxiv_pdf");
  const openalex = byId.get("openalex");
  const arxivOk = arxivApi?.status === "ok" || arxivPdf?.status === "ok";
  if (arxivOk || openalex?.status === "ok") {
    return { status: "PASS", detail: test.summary, mode, proxyUrl: null, test };
  }
  return { status: "ACADEMIC_UNREACHABLE", detail: test.summary, mode, proxyUrl: null, test };
}
