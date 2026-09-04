import { Link, Outlet } from "react-router-dom";

import { RuntimeStatusChip } from "../common/RuntimeStatusChip.js";
import { useRuntimeStatus } from "../../hooks/queries.js";
import { useUiStore } from "../../stores/uiStore.js";

/**
 * 应用布局（M4.1）：顶栏（品牌 + Runtime 状态徽标）+ 模型未配置横幅 + 页面 Outlet。
 */

function ModelConfigBanner() {
  const { data, isPending, isError } = useRuntimeStatus();
  const dismissed = useUiStore((state) => state.modelBannerDismissed);
  const dismiss = useUiStore((state) => state.dismissModelBanner);

  if (isPending || isError || data === undefined || dismissed) {
    return null;
  }
  if (data.model.phase !== "not_configured") {
    return null;
  }
  return (
    <div className="model-banner" role="status">
      <span>
        Runtime 正常，但模型未配置（{data.model.detail}）。Workflow 需要模型凭据，请参考
        .env.example 配置后重启 Backend。
      </span>
      <button type="button" className="btn btn-small" onClick={dismiss}>
        知道了
      </button>
    </div>
  );
}

export function AppLayout() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/projects" className="brand">
          PaperTeam
        </Link>
        <RuntimeStatusChip />
      </header>
      <ModelConfigBanner />
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
