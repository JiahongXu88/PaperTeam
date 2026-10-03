/**
 * Pi Runtime 版本锁定。
 *
 * 与 backend/package.json 的 @earendil-works/pi-coding-agent 精确 pin
 * 保持一致（禁止 ^ / ~ / latest）；诊断服务展示用。
 * 1.0.x 起内部包（pi-agent-core / pi-ai / pi-telemetry / pi-tui /
 * pi-mcp / chord / pi-codemode）随主包同版本发布，实测全部 resolved
 * 到同一版本，无多版本漂移。
 */
export const PI_RUNTIME_VERSION = "1.0.1";
