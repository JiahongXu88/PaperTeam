/**
 * docling 解析默认上限（M17.2.2；纯常量，config 与 DoclingParser 共用）。
 * 实测口径见 docs/research/M17_2_2_EVIDENCE_GROUND_PARSER_RELIABILITY.md。
 */
export const DOCLING_DEFAULT_LIMITS = {
  /** 单篇总时长硬上限 */
  timeoutMs: 1_800_000,
  /** 单篇无进展上限（解析器每完成一批页面续期） */
  idleTimeoutMs: 300_000,
  /** 首次模型下载上限（与文档解析分开计时） */
  warmupTimeoutMs: 1_800_000,
  /** 离线预检只 import docling + 查缓存，不加载模型（实测 25s；高负载机器 import 可达分钟级） */
  preflightTimeoutMs: 300_000,
} as const;
