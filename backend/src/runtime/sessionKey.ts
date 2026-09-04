/**
 * Runtime 会话标识的统一派生（M3.7 从 OpenClawRuntimeAdapter 抽出共享）。
 *
 * 派生规则（M3.0，ARCHITECTURE §6.3）是 PaperTeam 的业务事实，与具体
 * Runtime 实现无关——PiRuntimeAdapter 按本规则产生稳定 sessionKey，
 * 上层（如 GenerationService 的 sessionKey 透传/回写）语义不随实现变化：
 *   显式复用 > 按 projectId（+ contextScope）派生 > undefined（由实现兜底）
 */

import type { RunAgentInput } from "./types.js";

/** PaperTeam 派生 Runtime 会话的前缀（sessionKey 形如 agent:{agentId}:{peer}） */
const SESSION_PEER_PREFIX = "paperteam";

/** contextScope 的 scope 分隔符（projectId 与 scope 之间） */
const SESSION_SCOPE_SEPARATOR = "--";

/**
 * 解析本次运行的会话：显式复用 > 按 projectId（+ contextScope）派生 > undefined。
 *
 * 派生规则：
 *   无 scope：agent:{agentId}:paperteam-{projectId}
 *   有 scope：agent:{agentId}:paperteam-{projectId}--{scope}
 * 同一 Project × Agent × Scope 稳定复用；任一维度不同则隔离。
 */
export function resolveSessionKey(input: RunAgentInput): string | undefined {
  const explicit = input.sessionKey?.trim();
  if (explicit) {
    return explicit;
  }
  const projectId = input.projectId?.trim();
  if (projectId && input.agentId) {
    // peer 部分保留 opaque id；scope 归一化保证非法字符不会破坏
    // sessionKey 结构或造成 scope 串会话。
    const scope = sanitizeContextScope(input.contextScope);
    const peer = scope
      ? `${SESSION_PEER_PREFIX}-${projectId}${SESSION_SCOPE_SEPARATOR}${scope}`
      : `${SESSION_PEER_PREFIX}-${projectId}`;
    return `agent:${input.agentId}:${peer}`;
  }
  return undefined;
}

/**
 * contextScope 安全归一化：小写；允许 [a-z0-9/_-]；其余字符折叠为 "-"；
 * 首尾分隔符去除、连续 "-" 压缩、长度上限 48。
 * 注意折叠不完全单射（如空格与字面 "-" 会折叠到同一 scope）——scope 取值
 * 由 PaperTeam 代码内控（少量固定常量），不接受用户自由输入，因此可接受；
 * 该函数的目标是保证非法字符不会破坏 sessionKey 结构或注入额外 ":"。
 */
export function sanitizeContextScope(scope: string | undefined): string | undefined {
  const raw = scope?.trim();
  if (!raw) {
    return undefined;
  }
  const normalized = raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9/_-]/g, "-")
    .replaceAll(/-{2,}/g, "-")
    .replace(/^[-/]+/, "")
    .replace(/[-/]+$/, "")
    .slice(0, 48)
    .replace(/[-]+$/, "");
  return normalized === "" ? undefined : normalized;
}
