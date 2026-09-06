import { useRuntimeStatus } from "../../hooks/queries.js";

/**
 * Runtime 状态（Visual Redesign 2026-09）：收进侧栏底部，作为环境指示灯。
 *
 * 消费 M3.8 去 Gateway 化后的 Pi schema：Runtime（provider=pi + version +
 * phase）与模型就绪相位各占一行；Backend 不可达时明确提示（此时
 * healthCheck 无法到达，属网络层错误）。
 */

type Tone = "ok" | "warn" | "error";

export function RuntimeStatusChip() {
  const { data, isPending, isError } = useRuntimeStatus();

  if (isPending) {
    return (
      <span className="sidebar-runtime" data-testid="runtime-chip" title="正在获取 Runtime 状态…">
        <span className="sidebar-runtime-line">
          <span className="dot dot-muted" aria-hidden="true" />
          <span className="rt-label">Runtime 检测中…</span>
        </span>
      </span>
    );
  }

  if (isError || data === undefined) {
    return (
      <span
        className="sidebar-runtime"
        data-testid="runtime-chip"
        title="无法连接 PaperTeam 后端服务，请确认服务已启动"
      >
        <span className="sidebar-runtime-line">
          <span className="dot dot-error" aria-hidden="true" />
          <span className="rt-label">服务未连接</span>
        </span>
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
      className="sidebar-runtime"
      data-testid="runtime-chip"
      title={`${data.runtime.detail}｜${data.model.detail}`}
    >
      <span className="runtime-label">Runtime</span>
      <span className="sidebar-runtime-line">
        <span className={`dot dot-${runtimeTone}`} aria-hidden="true" />
        <span className="rt-text">Pi {data.runtime.version}</span>
      </span>
      <span className="sidebar-runtime-line">
        <span className={`dot dot-${modelTone}`} aria-hidden="true" />
        <span className="rt-label">{modelText}</span>
      </span>
    </span>
  );
}
