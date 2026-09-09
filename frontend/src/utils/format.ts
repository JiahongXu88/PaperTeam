/** 本地时间格式化：`YYYY-MM-DD HH:mm`；非法输入原样返回 */
export function formatDateTime(iso: string | undefined): string | undefined {
  if (iso === undefined || iso === "") {
    return undefined;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** 文件大小：B / KB / MB（保留一位小数） */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

/** 时长（毫秒）→ `mm:ss` 或 `h:mm:ss`；负数 / 非法输入返回 undefined */
export function formatDurationMs(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms < 0) {
    return undefined;
  }
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * 两个 ISO 时间点之间的时长；to 缺省（运行中）以当前时间计（客户端 timer，
 * 不向 Backend 发请求）。任一端非法返回 undefined（不虚构）。
 */
export function formatDurationBetween(
  fromIso: string | undefined,
  toIso: string | undefined,
  now: () => number = () => Date.now(),
): string | undefined {
  if (fromIso === undefined || fromIso === "") {
    return undefined;
  }
  const from = new Date(fromIso).getTime();
  if (Number.isNaN(from)) {
    return undefined;
  }
  const to = toIso !== undefined && toIso !== "" ? new Date(toIso).getTime() : now();
  if (Number.isNaN(to)) {
    return undefined;
  }
  return formatDurationMs(to - from);
}

/**
 * Stage 耗时展示：亚秒级（确定性 stage 常见）没有信息量，返回 undefined
 * （避免时间线上出现一排「00:00」噪音）。
 */
export function formatStageDuration(
  fromIso: string | undefined,
  toIso: string | undefined,
  now: () => number = () => Date.now(),
): string | undefined {
  if (fromIso === undefined || fromIso === "") {
    return undefined;
  }
  const from = new Date(fromIso).getTime();
  if (Number.isNaN(from)) {
    return undefined;
  }
  const to = toIso !== undefined && toIso !== "" ? new Date(toIso).getTime() : now();
  if (Number.isNaN(to)) {
    return undefined;
  }
  const ms = to - from;
  return ms >= 1_000 ? formatDurationMs(ms) : undefined;
}
