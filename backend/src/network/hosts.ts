/**
 * 主机名判定（字面量级，无 DNS）：loopback / 私网 / 保留地址 / 本地后缀。
 *
 * 两处消费：
 * - FullText 下载 SSRF 护栏（M7.2；拒绝向内网地址下载）；
 * - Research 代理路由（M13.8；回环与内网地址保持直连，不进代理）。
 * 单一实现，避免两套判定漂移。
 */

/** 内网 / 本地主机判定（字面量级；IPv4 / IPv6 / 保留后缀） */
export function isPrivateOrLocalHost(host: string): boolean {
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".localdomain")
  ) {
    return true;
  }
  // IPv4 字面量
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4 !== null) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    ) {
      return true;
    }
    return false;
  }
  // IPv6 字面量（含 ::ffff:IPv4 映射）
  if (host.includes(":")) {
    const lower = host.toLowerCase();
    if (lower === "::" || lower === "::1") {
      return true;
    }
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
    if (mapped !== null) {
      return isPrivateOrLocalHost(mapped[1]!);
    }
    const hextet = /^([0-9a-f]{1,4})(?::|$)/.exec(lower);
    if (hextet !== null) {
      const first = Number.parseInt(hextet[1]!, 16);
      if (
        (first >= 0xfc00 && first <= 0xfdff) || // fc00::/7 unique-local
        (first >= 0xfe80 && first <= 0xfebf) // fe80::/10 link-local
      ) {
        return true;
      }
    }
    return false;
  }
  return false;
}

/**
 * 代理旁路判定（M13.8）：回环 / 私网 / 保留地址，以及无点号的单标签主机名
 * （Docker compose 服务名如 `searxng`、内网短名）一律直连——本机 SearXNG、
 * 内网服务不应被送进学术代理。公网域名（含点号且非本地后缀）才走代理。
 */
export function shouldBypassResearchProxy(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "") {
    return true;
  }
  if (isPrivateOrLocalHost(host)) {
    return true;
  }
  if (!host.includes(".") && !host.includes(":")) {
    return true; // 单标签主机名（compose 服务名 / 内网短名）
  }
  return false;
}
