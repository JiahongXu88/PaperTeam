import { useEffect, useState } from "react";

import { ErrorState, Loading } from "../components/common/StateViews.js";
import { PageHeader } from "../components/common/PageHeader.js";
import {
  useClearModelApiKey,
  useModelOptions,
  useModelSettings,
  useSaveModelSettings,
  useTestModelConnection,
} from "../hooks/queries.js";
import type { ModelSettingsView } from "../types/api.js";

/**
 * Model Settings 页面（Visual Redesign 2026-09）。
 *
 * 安全约束（docs/API_CONTRACT.md）：
 * - API Key 输入框每次进入页面保持空白，永不回填已保存值；
 * - Show/Hide 只作用于用户本次刚输入的值；
 * - 不保存 Key 到 localStorage/sessionStorage/URL；
 * - GET 响应不含 key 本体（只显示「已配置」状态与来源）。
 */

const SOURCE_LABEL: Record<ModelSettingsView["configurationSource"], string> = {
  environment: "环境变量",
  stored: "本地存储",
  not_configured: "未配置",
};

const KEY_SOURCE_LABEL: Record<ModelSettingsView["apiKeySource"], string> = {
  environment: "环境变量提供",
  stored: "本地已保存",
  none: "无",
};

/** 测试失败分类 → 人读文本 */
const TEST_CODE_LABEL: Record<string, string> = {
  AUTH_FAILED: "认证失败（API Key 无效或无权限）",
  MODEL_NOT_FOUND: "模型不存在",
  PROVIDER_UNAVAILABLE: "Provider 不可达",
  RATE_LIMITED: "触发限流",
  TIMEOUT: "超时",
  UNKNOWN: "未知错误",
};

/** 上下文窗口 → 简洁读数（200k / 1M） */
function formatContext(window: number): string {
  return window >= 1_000_000
    ? `${(window / 1_000_000).toFixed(window % 1_000_000 === 0 ? 0 : 1)}M ctx`
    : `${Math.round(window / 1000)}k ctx`;
}

export function ModelSettingsPage() {
  const settingsQuery = useModelSettings();

  if (settingsQuery.isPending) {
    return (
      <section className="page">
        <Loading label="加载模型配置…" />
      </section>
    );
  }
  if (settingsQuery.isError) {
    return (
      <section className="page">
        <ErrorState
          title="模型配置加载失败"
          message={settingsQuery.error instanceof Error ? settingsQuery.error.message : String(settingsQuery.error)}
          onRetry={() => void settingsQuery.refetch()}
        />
      </section>
    );
  }
  return <ModelSettingsBody settings={settingsQuery.data} />;
}

function ModelSettingsBody({ settings }: { settings: ModelSettingsView }) {
  // 表单状态：provider/model 从当前生效配置种子；key 输入永远从空白开始
  const [providerId, setProviderId] = useState(settings.provider ?? "");
  const [modelId, setModelId] = useState(settings.model?.split("/")[1] ?? "");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);

  const providersQuery = useModelOptions();
  const modelsQuery = useModelOptions(providerId === "" ? undefined : providerId);

  const save = useSaveModelSettings();
  const clearKey = useClearModelApiKey();
  const test = useTestModelConnection();

  const providers =
    providersQuery.data !== undefined && "providers" in providersQuery.data
      ? providersQuery.data.providers
      : undefined;
  const models =
    modelsQuery.data !== undefined && "models" in modelsQuery.data
      ? modelsQuery.data.models
      : undefined;

  const selectedModel = providerId !== "" && modelId !== "" ? `${providerId}/${modelId}` : "";

  // 保存/清除成功后：状态刷新由 invalidate 驱动；这里清空一次性 key 输入
  useEffect(() => {
    if (save.isSuccess || clearKey.isSuccess) {
      setApiKeyInput("");
    }
  }, [save.isSuccess, clearKey.isSuccess]);

  const handleSave = () => {
    if (selectedModel === "") {
      return;
    }
    const typedKey = apiKeyInput.trim();
    save.mutate({
      model: selectedModel,
      ...(typedKey !== "" ? { apiKey: typedKey } : {}),
    });
  };

  const handleTest = () => {
    if (selectedModel === "") {
      return;
    }
    const typedKey = apiKeyInput.trim();
    test.mutate({
      model: selectedModel,
      ...(typedKey !== "" ? { apiKey: typedKey } : {}),
    });
  };

  const handleClearKey = () => {
    const confirmed = window.confirm(
      "确定清除已保存的 API Key？清除后，如果没有环境变量提供凭据，模型将变为未配置状态。",
    );
    if (confirmed) {
      clearKey.mutate();
    }
  };

  return (
    <section className="page">
      <PageHeader
        title="Model Settings"
        sub="配置 Pi Runtime 的模型与 API Key；保存后新的 Agent Run 即使用新配置。优先级：环境变量 > 本地保存。"
      />

      <dl className="settings-status">
        <div className="aside-row">
          <dt>Runtime</dt>
          <dd>
            <span className="mono">Pi {settings.runtimeVersion}</span>{" "}
            {settings.runtimePhase === "healthy" ? (
              <span className="status status-tone-ok">正常</span>
            ) : (
              <span className="status status-tone-danger">异常</span>
            )}
          </dd>
        </div>
        <div className="aside-row">
          <dt>生效配置</dt>
          <dd>{SOURCE_LABEL[settings.configurationSource]}</dd>
        </div>
        <div className="aside-row">
          <dt>Model</dt>
          <dd className="mono">{settings.model ?? "（未配置）"}</dd>
        </div>
        <div className="aside-row">
          <dt>API Key</dt>
          <dd>
            {settings.apiKeyConfigured ? (
              <span data-testid="api-key-configured">
                <span className="status status-tone-ok">已配置</span>
                <span className="muted">（{KEY_SOURCE_LABEL[settings.apiKeySource]}）</span>
              </span>
            ) : (
              <span data-testid="api-key-missing">
                <span className="status status-tone-warn">未配置</span>
              </span>
            )}
          </dd>
        </div>
      </dl>

      {settings.envOverride ? (
        <p className="note note-warn" data-testid="env-override-note" role="status">
          <span>
            当前模型配置由环境变量提供（优先级更高）。仍可保存本地配置：
            将在环境变量不存在时生效（含下次以无环境变量方式启动时）。
          </span>
        </p>
      ) : null}
      {settings.envOverride && settings.savedModel !== undefined && settings.savedModel !== settings.model ? (
        <p className="note note-info">
          <span>
            本地保存值：<span className="mono">{settings.savedModel}</span>（当前被环境变量覆盖为{" "}
            <span className="mono">{settings.model}</span>）
          </span>
        </p>
      ) : null}

      <form className="panel settings-form" onSubmit={(event) => event.preventDefault()}>
        <div className="section-head">
          <h2 className="panel-title">模型配置</h2>
        </div>
        <div className="panel-stack" style={{ gap: "var(--s-5)" }}>
          <div className="field">
            <label htmlFor="model-provider">Provider</label>
            <select
              id="model-provider"
              value={providerId}
              onChange={(event) => {
                setProviderId(event.target.value);
                setModelId("");
              }}
              disabled={providers === undefined}
            >
              <option value="">{providers === undefined ? "加载中…" : "选择 Provider"}</option>
              {providers?.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}（{provider.id}）
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="model-id">Model</label>
            <select
              id="model-id"
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              disabled={providerId === "" || models === undefined}
            >
              <option value="">
                {providerId === ""
                  ? "先选择 Provider"
                  : models === undefined
                    ? "加载中…"
                    : models.length === 0
                      ? "（该 Provider 暂无模型目录）"
                      : "选择模型"}
              </option>
              {models?.map((model) => (
                <option key={model.modelId} value={model.modelId}>
                  {model.displayName}
                  {model.contextWindow !== undefined
                    ? `（${formatContext(model.contextWindow)}）`
                    : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="model-api-key">API Key</label>
            <div className="input-group">
              <input
                id="model-api-key"
                type={showKey ? "text" : "password"}
                value={apiKeyInput}
                onChange={(event) => setApiKeyInput(event.target.value)}
                placeholder="输入新 API Key"
                autoComplete="off"
                spellCheck={false}
                data-testid="api-key-input"
              />
              <button
                type="button"
                className="btn"
                onClick={() => setShowKey((value) => !value)}
              >
                {showKey ? "Hide" : "Show"}
              </button>
            </div>
            {settings.apiKeyConfigured ? (
              <p className="field-help" data-testid="api-key-hint">
                API Key 已配置（{KEY_SOURCE_LABEL[settings.apiKeySource]}）；留空保存则保留当前 Key。
              </p>
            ) : null}
            <div className="action-row" style={{ marginTop: 4 }}>
              <button
                type="button"
                className="btn btn-small"
                onClick={handleTest}
                disabled={selectedModel === "" || test.isPending}
                data-testid="test-connection"
                title="测试当前填写的模型与 Key（不落盘）"
              >
                {test.isPending ? "测试中…" : "Test Connection"}
              </button>
            </div>
          </div>

          <div className="form-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSave}
              disabled={selectedModel === "" || save.isPending}
              data-testid="save-model"
            >
              {save.isPending ? "保存中…" : "Save"}
            </button>
          </div>

          {save.isError ? (
            <p className="form-error" role="alert" data-testid="save-error">
              保存失败：{save.error instanceof Error ? save.error.message : String(save.error)}
            </p>
          ) : null}
          {save.isSuccess ? (
            <p className="note note-success" role="status" data-testid="save-success">
              <span>
                <span className="note-mark">✓</span> 已保存
                {settings.envOverride
                  ? "（注意：当前进程环境变量优先，本地配置在环境变量不存在时生效）"
                  : "，新的 Agent Run 将使用新配置"}
                。
              </span>
            </p>
          ) : null}

          {test.data !== undefined ? (
            <div data-testid="test-result">
              {test.data.ok ? (
                <p className="note note-success" role="status">
                  <span>
                    <span className="note-mark">✓</span> Connection OK：{test.data.provider}/{test.data.model}
                    （{test.data.latencyMs}ms）
                  </span>
                </p>
              ) : (
                <p className="note note-error" role="alert">
                  <span>
                    <span className="note-mark">✗</span>{" "}
                    {TEST_CODE_LABEL[test.data.code ?? "UNKNOWN"] ?? test.data.code}
                    {test.data.detail !== undefined ? `：${test.data.detail}` : ""}
                  </span>
                </p>
              )}
            </div>
          ) : null}
          {test.isError ? (
            <p className="form-error" role="alert">
              测试请求失败：{test.error instanceof Error ? test.error.message : String(test.error)}
            </p>
          ) : null}
        </div>
      </form>

      <div className="danger-zone">
        <div className="danger-kicker">Danger Zone</div>
        <div className="section-head">
          <h2 className="panel-title">清除本地保存的 API Key</h2>
        </div>
        <p className="panel-sub" style={{ marginBottom: 12 }}>
          清除后不影响模型偏好；若环境变量仍在提供 Key，模型保持可用。
        </p>
        <div className="action-row">
          <button
            type="button"
            className="btn btn-danger"
            onClick={handleClearKey}
            disabled={!settings.apiKeyConfigured || settings.apiKeySource !== "stored" || clearKey.isPending}
            data-testid="clear-key"
          >
            {clearKey.isPending ? "清除中…" : "Clear saved API Key"}
          </button>
          {clearKey.isError ? (
            <span className="form-error" role="alert">
              清除失败：{clearKey.error instanceof Error ? clearKey.error.message : String(clearKey.error)}
            </span>
          ) : null}
          {clearKey.isSuccess ? (
            <span className="note note-success" role="status" data-testid="clear-success">
              <span>
                <span className="note-mark">✓</span> 已清除本地保存的 API Key
                {settings.apiKeyConfigured ? "（环境变量仍在提供凭据，模型保持已配置）" : ""}。
              </span>
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );
}
