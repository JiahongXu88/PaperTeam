import { useRuntimeStatus } from "../../hooks/queries.js";

/**
 * 侧栏底部的环境指示：Runtime / 模型 / PDF 解析依赖各一行（dot + 文字）。
 * Backend 不可达时只显示一行「服务未连接」。
 */

type Tone = "ok" | "warn" | "error" | "muted";

function Line({ tone, text, title }: { tone: Tone; text: string; title?: string }) {
  return (
    <span className="sidebar-runtime-line" title={title}>
      <span className={`dot dot-${tone}`} aria-hidden="true" />
      <span className="rt-text">{text}</span>
    </span>
  );
}

export function RuntimeStatusChip() {
  const { data, isPending, isError } = useRuntimeStatus();

  if (isPending) {
    return (
      <div className="sidebar-runtime" data-testid="runtime-chip">
        <Line tone="muted" text="正在检测运行环境…" />
      </div>
    );
  }
  if (isError || data === undefined) {
    return (
      <div className="sidebar-runtime" data-testid="runtime-chip">
        <Line tone="error" text="服务未连接" title="无法连接 PaperTeam 后端服务，请确认服务已启动" />
      </div>
    );
  }

  const modelText =
    data.model.phase === "configured"
      ? `模型已配置${data.model.model !== undefined ? `：${data.model.model}` : ""}`
      : data.model.phase === "not_configured"
        ? "模型未配置"
        : "模型状态未知";
  const pdf = data.tools?.pdfParser;

  return (
    <div className="sidebar-runtime" data-testid="runtime-chip">
      <Line
        tone={data.runtime.phase === "healthy" ? "ok" : "error"}
        text={`Pi Runtime ${data.runtime.version}`}
        title={data.runtime.detail}
      />
      <Line tone={data.model.phase === "configured" ? "ok" : "warn"} text={modelText} title={data.model.detail} />
      {pdf !== undefined && pdf.phase !== "unknown" ? (
        <Line
          tone={pdf.phase === "ready" ? "ok" : "error"}
          text={pdf.phase === "ready" ? "PDF 解析可用" : "PDF 解析依赖缺失"}
          title={pdf.detail}
        />
      ) : null}
    </div>
  );
}
