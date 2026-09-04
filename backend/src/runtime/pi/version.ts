/**
 * Pi Runtime 版本锁定（M3.7 Feasibility baseline）。
 *
 * 与 backend/package.json 的 @earendil-works/pi-coding-agent 精确 pin
 * 保持一致（禁止 ^ / ~ / latest）；诊断服务展示用。
 * pi-coding-agent 对内部包（pi-agent-core / pi-ai / pi-protocol /
 * pi-client / pi-tui）依赖 ^0.84.4，0.x 语义下只在 0.84.x 内解析，
 * 不会被 0.85+ 污染。
 */
export const PI_RUNTIME_VERSION = "0.84.4";
