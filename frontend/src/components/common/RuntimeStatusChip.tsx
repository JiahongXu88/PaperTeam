import { useRuntimeStatus } from "../../hooks/queries.js";

/**
 * Runtime 状态徽标（M4.1）：消费 M3.8 去 Gateway 化后的 Pi schema。
 *
 * 显示：Runtime（provider=pi + version + phase）与模型就绪相位；
 * Backend 不可达时明确提示（此时 healthCheck 无法到达，属网络层错误）。
 */

type Tone = "ok" | "warn" | "error";

export function RuntimeStatusChip() {
  const { data, isPending, isError } = useRuntimeStatus();

  if (isPending) {
    return (
      <span className="runtime-chip" data-testid="runtime-chip" title="正在获取 Runtime 状态…">
        <span className="dot dot-muted" aria-hidden="true" />
        Runtime 检测中…
      </span>
    );
  }

  if (isError || data === undefined) {
    return (
      <span
        className="runtime-chip"
        data-testid="runtime-chip"
        title="无法连接 PaperTeam Backend（GET /api/runtime/status）"
      >
        <span className="dot dot-error" aria-hidden="true" />
        Backend 未连接
      </span>
    );
  }

  const runtimeTone: Tone = data.runtime.phase === "healthy" ? "ok" : "error";
  const modelTone: Tone =
    data.model.phase === "configured" ? "ok" : data.model.phase === "unknown" ? "warn" : "warn";
  const modelText =
    data.model.phase === "configured"
      ? `模型已配置${data.model.model !== undefined ? `（${data.model.model}）` : ""}`
      : data.model.phase === "not_configured"
        ? "模型未配置"
        : "模型状态未知";

  return (
    <span
      className="runtime-chip"
      data-testid="runtime-chip"
      title={`${data.runtime.detail}｜${data.model.detail}`}
    >
      <span className={`dot dot-${runtimeTone}`} aria-hidden="true" />
      Pi {data.runtime.version}
      <span className="runtime-chip-sep" aria-hidden="true">·</span>
      <span className={`dot dot-${modelTone}`} aria-hidden="true" />
      {modelText}
    </span>
  );
}
