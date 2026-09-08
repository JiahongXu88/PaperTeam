import { useState } from "react";

import { ErrorState, Loading } from "../components/common/StateViews.js";
import { PageHeader } from "../components/common/PageHeader.js";
import { ModelCombobox } from "../components/common/ModelCombobox.js";
import { ProviderCombobox } from "../components/common/ProviderCombobox.js";
import { CustomProviderPanel } from "../components/settings/CustomProviderPanel.js";
import {
  useClearModelApiKey,
  useCustomProviders,
  useModelOptions,
  useModelSettings,
  useSaveModelSettings,
  useTestModelConnection,
} from "../hooks/queries.js";
import { formatApiError, formatApiErrorDetail } from "../utils/errors.js";
import type { ModelSettingsView, ModelTestResultCode } from "../types/api.js";

/**
 * 模型设置。
 *
 * 安全约束（docs/API_CONTRACT.md）：API Key 输入框每次进入页面为空，永不回填已保存值；
 * 显示 / 隐藏只作用于本次输入；不写 localStorage / URL；GET 响应不含 key 本体。
 * provider + modelId 由后端 DTO 显式提供（modelId 可含 "/"），前端不拆字符串。
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

const TEST_CODE_LABEL: Record<ModelTestResultCode, string> = {
  AUTH_FAILED: "API Key 无效或认证失败",
  MODEL_NOT_FOUND: "找不到所选模型",
  PROVIDER_UNAVAILABLE: "模型服务不可达",
  RATE_LIMITED: "请求过于频繁，请稍后重试",
  TIMEOUT: "连接超时，请检查网络或模型服务",
  UNKNOWN: "未知错误",
};

export function ModelSettingsPage() {
  const settingsQuery = useModelSettings();

  if (settingsQuery.isPending) {
    return (
      <div className="page">
        <PageHeader level={2} title="模型设置" />
        <Loading label="加载模型配置…" />
      </div>
    );
  }
  if (settingsQuery.isError) {
    return (
      <div className="page">
        <PageHeader level={2} title="模型设置" />
        <ErrorState
          title="模型配置加载失败"
          message={formatApiError(settingsQuery.error)}
          detail={formatApiErrorDetail(settingsQuery.error)}
          onRetry={() => void settingsQuery.refetch()}
        />
      </div>
    );
  }
  return <ModelSettingsBody settings={settingsQuery.data} />;
}

function ModelSettingsBody({ settings }: { settings: ModelSettingsView }) {
  const [providerId, setProviderId] = useState(settings.provider ?? "");
  const [modelId, setModelId] = useState(settings.modelId ?? "");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const providersQuery = useModelOptions();
  const modelsQuery = useModelOptions(providerId === "" ? undefined : providerId);
  const customProvidersQuery = useCustomProviders();
  const save = useSaveModelSettings();
  const clearKey = useClearModelApiKey();
  const test = useTestModelConnection();

  const providers = providersQuery.data !== undefined && "providers" in providersQuery.data ? providersQuery.data.providers : undefined;
  const models = modelsQuery.data !== undefined && "models" in modelsQuery.data ? modelsQuery.data.models : undefined;
  const selectedModel = providerId !== "" && modelId !== "" ? `${providerId}/${modelId}` : "";
  const selectedProvider = providers?.find((provider) => provider.id === providerId);

  // 改了模型 / provider 之后，上一次的测试结果与「已保存」提示不再对应当前选择
  const resetFeedback = () => {
    test.reset();
    save.reset();
  };

  const onProviderChange = (next: string) => {
    setProviderId(next);
    setModelId("");
    resetFeedback();
  };

  const handleSave = () => {
    if (selectedModel === "") {
      return;
    }
    const typedKey = apiKeyInput.trim();
    save.mutate(
      { model: selectedModel, ...(typedKey !== "" ? { apiKey: typedKey } : {}) },
      { onSuccess: () => setApiKeyInput("") },
    );
  };

  const handleTest = () => {
    if (selectedModel === "") {
      return;
    }
    const typedKey = apiKeyInput.trim();
    test.mutate({ model: selectedModel, ...(typedKey !== "" ? { apiKey: typedKey } : {}) });
  };

  const handleClearKey = () => {
    setConfirmClear(false);
    clearKey.mutate(undefined, { onSuccess: () => setApiKeyInput("") });
  };

  return (
    <div className="page">
      <PageHeader level={2} title="模型设置" sub="配置 Agent 使用的模型与 API Key；保存后新的任务立即使用新配置。优先级：环境变量 > 本地保存。" />

      <div className="settings-grid">
        <section className="settings-block" aria-label="当前配置">
          <h2 className="panel-title">当前配置</h2>
          <dl className="kv settings-status">
            <div className="kv-row">
              <dt>Runtime</dt>
              <dd>
                <span className="mono">Pi {settings.runtimeVersion}</span> {settings.runtimePhase === "healthy" ? <span className="status status-tone-ok">正常</span> : <span className="status status-tone-danger">异常</span>}
              </dd>
            </div>
            <div className="kv-row">
              <dt>生效来源</dt>
              <dd>{SOURCE_LABEL[settings.configurationSource]}</dd>
            </div>
            <div className="kv-row">
              <dt>模型</dt>
              <dd className="mono">{settings.model ?? "（未配置）"}</dd>
            </div>
            <div className="kv-row">
              <dt>API Key</dt>
              <dd>
                {settings.apiKeyConfigured ? (
                  <span data-testid="api-key-configured">
                    <span className="status status-tone-ok">已配置</span> <span className="muted">{KEY_SOURCE_LABEL[settings.apiKeySource]}</span>
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
              <span>当前模型配置由环境变量提供（优先级更高）。仍可保存本地配置：在环境变量不存在时生效。</span>
            </p>
          ) : null}
          {settings.envOverride && settings.savedModel !== undefined && settings.savedModel !== settings.model ? (
            <p className="note note-info">
              <span>
                本地保存值：<span className="mono">{settings.savedModel}</span>（当前被环境变量覆盖为 <span className="mono">{settings.model}</span>）
              </span>
            </p>
          ) : null}
        </section>

        <form
          className="settings-block settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            handleSave();
          }}
        >
          <h2 className="panel-title">模型与凭据</h2>
          <div className="field">
            <label htmlFor="model-provider">模型提供商</label>
            <ProviderCombobox id="model-provider" providers={providers} value={providerId} onChange={onProviderChange} />
            {selectedProvider !== undefined ? (
              <span className="field-help">
                {selectedProvider.modelCount} 个模型
                {selectedProvider.authConfigured ? "，已有可用凭据" : selectedProvider.apiKeyLoginSupported ? "，需要在下方填写 API Key" : "，只接受环境变量凭据"}
                {selectedProvider.source === "custom" ? "；自定义提供商，可在下方编辑" : ""}
              </span>
            ) : (
              <span className="field-help">输入首字母即可筛选；小众提供商折叠在「其他」里</span>
            )}
          </div>

          <div className="field">
            <label htmlFor="model-id">模型</label>
            <ModelCombobox
              id="model-id"
              models={models}
              value={modelId}
              onChange={(next) => {
                setModelId(next);
                resetFeedback();
              }}
              disabled={providerId === ""}
              loading={providerId !== "" && models === undefined}
              emptyHint={providerId === "" ? "请先选择模型提供商" : "该提供商暂无模型目录"}
            />
            <span className="field-help">{providerId === "" ? "请先选择模型提供商" : "输入名称或 Model ID 筛选；Model ID 可以包含「/」"}</span>
          </div>

          <div className="field">
            <label htmlFor="model-api-key">API Key</label>
            <div className="input-group">
              <input
                id="model-api-key"
                type={showKey ? "text" : "password"}
                value={apiKeyInput}
                onChange={(event) => setApiKeyInput(event.target.value)}
                placeholder={settings.apiKeyConfigured ? "留空则保留当前 Key" : "输入 API Key"}
                autoComplete="off"
                spellCheck={false}
                data-testid="api-key-input"
              />
              <button type="button" className="btn" onClick={() => setShowKey((value) => !value)} aria-pressed={showKey}>
                {showKey ? "隐藏" : "显示"}
              </button>
            </div>
            {settings.apiKeyConfigured ? (
              <span className="field-help" data-testid="api-key-hint">
                API Key 已配置（{KEY_SOURCE_LABEL[settings.apiKeySource]}）；留空保存则保留当前 Key。Key 只发往本机 Backend，不会回显。
              </span>
            ) : (
              <span className="field-help">Key 只发往本机 Backend 保存，不会回显，也不会写入浏览器存储。</span>
            )}
          </div>

          <div className="form-actions settings-actions">
            <button type="button" className="btn" onClick={handleTest} disabled={selectedModel === "" || test.isPending} data-testid="test-connection" title="用当前填写的模型与 Key 发起一次最小调用（不保存）">
              {test.isPending ? "测试中…" : "测试连接"}
            </button>
            <button type="submit" className="btn btn-primary" disabled={selectedModel === "" || save.isPending} data-testid="save-model">
              {save.isPending ? "保存中…" : "保存"}
            </button>
          </div>

          {save.isError ? (
            <p className="form-error" role="alert" data-testid="save-error">
              保存失败：{formatApiError(save.error)}
            </p>
          ) : null}
          {save.isSuccess ? (
            <p className="note note-success" role="status" data-testid="save-success">
              <span>
                <span className="note-mark">✓</span> 已保存{settings.envOverride ? "。当前进程仍以环境变量为准，本地配置在环境变量不存在时生效" : "，新的 Agent 任务将使用新配置"}。
              </span>
            </p>
          ) : null}
          {test.data !== undefined ? (
            <div data-testid="test-result">
              {test.data.ok ? (
                <p className="note note-success" role="status">
                  <span>
                    <span className="note-mark">✓</span> 连接正常：{test.data.provider}/{test.data.model}（{test.data.latencyMs}ms）
                  </span>
                </p>
              ) : (
                <div className="note note-error" role="alert">
                  <span>
                    <span className="note-mark">✗</span> {TEST_CODE_LABEL[test.data.code ?? "UNKNOWN"]}
                    {test.data.detail !== undefined ? (
                      <details className="details-block" style={{ marginTop: "var(--s-2)" }}>
                        <summary>详细信息</summary>
                        <div className="details-body mono">{test.data.detail}</div>
                      </details>
                    ) : null}
                  </span>
                </div>
              )}
            </div>
          ) : null}
          {test.isError ? (
            <p className="form-error" role="alert">
              测试请求失败：{formatApiError(test.error)}
            </p>
          ) : null}
        </form>
      </div>

      <CustomProviderPanel
        providers={customProvidersQuery.data}
        loading={customProvidersQuery.isPending}
        onSaved={(savedProviderId) => {
          if (savedProviderId !== providerId) {
            onProviderChange(savedProviderId);
          }
        }}
      />

      <section className="danger-zone" aria-labelledby="danger-title">
        <div className="danger-kicker">危险操作</div>
        <div className="section-head">
          <h2 className="panel-title" id="danger-title">
            清除本地保存的 API Key
          </h2>
        </div>
        <p className="panel-sub" style={{ marginBottom: "var(--s-3)" }}>
          只删除本机保存的 Key，不影响模型偏好；若环境变量仍在提供 Key，模型保持可用。
        </p>
        <div className="action-row">
          {confirmClear ? (
            <span className="inline-confirm" role="group" aria-label="确认清除 API Key">
              <span>清除后如果没有环境变量提供凭据，模型将变为未配置。</span>
              <button type="button" className="btn btn-small btn-danger" onClick={handleClearKey} disabled={clearKey.isPending} data-testid="clear-key-confirm">
                确认清除
              </button>
              <button type="button" className="btn btn-small" onClick={() => setConfirmClear(false)}>
                取消
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => setConfirmClear(true)}
              disabled={!settings.apiKeyConfigured || settings.apiKeySource !== "stored" || clearKey.isPending}
              data-testid="clear-key"
            >
              {clearKey.isPending ? "清除中…" : "清除已保存的 API Key"}
            </button>
          )}
          {clearKey.isError ? (
            <span className="form-error" role="alert">
              清除失败：{formatApiError(clearKey.error)}
            </span>
          ) : null}
          {clearKey.isSuccess ? (
            <span className="note note-success" role="status" data-testid="clear-success">
              <span>
                <span className="note-mark">✓</span> 已清除本地保存的 API Key{settings.apiKeyConfigured ? "（环境变量仍在提供凭据，模型保持已配置）" : ""}。
              </span>
            </span>
          ) : null}
        </div>
      </section>
    </div>
  );
}
