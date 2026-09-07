import { PageHeader } from "../components/common/PageHeader.js";
import { ThemeSegmented, themeModeLabel } from "../components/common/ThemeControls.js";
import { useTheme } from "../theme/ThemeProvider.js";

/** 设置 → 外观：主题三选一（跟随系统 / 浅色 / 深色），偏好保存在本机浏览器 */
export function AppearanceSettingsPage() {
  const { mode, resolved } = useTheme();
  return (
    <div>
      <PageHeader title="外观" sub="主题偏好只保存在这台设备的浏览器里，不上传。" />
      <div className="settings-grid">
        <div className="settings-block">
          <h2 className="panel-title">主题</h2>
          <p className="panel-sub">
            当前：{themeModeLabel(mode)}
            {mode === "system" ? `（系统为${resolved === "dark" ? "深色" : "浅色"}）` : ""}
          </p>
        </div>
        <div className="settings-block">
          <ThemeSegmented />
          <p className="field-help" style={{ marginTop: "var(--s-3)" }}>
            「跟随系统」会随操作系统的浅色 / 深色设置实时切换；侧栏底部的图标也可以快速切换。
          </p>
        </div>
      </div>
    </div>
  );
}
