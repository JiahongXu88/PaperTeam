import { useRuntimeStatus } from "../../hooks/queries.js";
/** Compact status, full diagnostics remain in model settings. */
export function RuntimeStatusChip() {
  const { data, isPending, isError } = useRuntimeStatus();
  const ready = data?.runtime.phase === "healthy" && data.model.phase === "configured" && data.tools?.pdfParser?.phase !== "unavailable";
  const label = isPending ? "连接中…" : isError ? "服务未连接" : ready ? "研究环境就绪" : "环境需要配置";
  return <div className="runtime-compact" data-testid="runtime-chip" title={data ? `Pi Runtime ${data.runtime.version} · ${data.model.detail}` : label}><span className={`dot dot-${ready ? "ok" : isError ? "error" : "warn"}`} /><span>{label}</span></div>;
}
