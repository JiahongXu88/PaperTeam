import { useState } from "react";

import { ModelCombobox } from "../common/ModelCombobox.js";
import { ProviderCombobox } from "../common/ProviderCombobox.js";
import { useModelOptions, useSaveModelSettings, useTestModelConnection } from "../../hooks/queries.js";
import { formatApiError, formatApiErrorDetail } from "../../utils/errors.js";
import type {
  AgentModelKey,
  AgentModelSettingView,
  ModelProviderOptionView,
  ModelSettingsView,
  ModelTestResultCode,
} from "../../types/api.js";

/**
 * Agent 独立模型配置（M5.7）。
 *
 * 默认全部「继承默认」；为个别 Agent 选「自定义」后展开该行的
 * Provider / Model / 测试连接。行内只保存 provider/model 规格——
 * API Key 与凭据按 Provider 共用（Settings 主表单），不在此保存。
 * 保存走 PUT /api/settings/model 的 agents 字段（整体替换）。
 */

export const AGENT_MODEL_LABELS: Record<AgentModelKey, string> = {
  writer: "Writer · 写作",
  researcher: "Researcher · 调研",
  academicReviewer: "Academic Reviewer · 学术审稿",
  factReviewer: "Fact Reviewer · 事实核验",
  styleReviewer: "Style Reviewer · 文风审稿",
  citationReviewer: "Citation Reviewer · 引用核验",
};

const TEST_CODE_LABEL: Record<ModelTestResultCode, string> = {
  AUTH_FAILED: "API Key 无效或认证失败",
  MODEL_NOT_FOUND: "找不到所选模型",
  PROVIDER_UNAVAILABLE: "模型服务不可达",
  RATE_LIMITED: "请求过于频繁，请稍后重试",
  TIMEOUT: "连接超时，请检查网络或模型服务",
  UNKNOWN: "未知错误",
};

type RowMode = "inherit" | "custom";

interface RowState {
  mode: RowMode;
  providerId: string;
  modelId: string;
}

function rowStateOf(agent: AgentModelSettingView): RowState {
  if (agent.source === "agent_override" && agent.overrideProvider !== undefined) {
    return {
      mode: "custom",
      providerId: agent.overrideProvider,
      modelId: agent.overrideModelId ?? "",
    };
  }
  return { mode: "inherit", providerId: "", modelId: "" };
}

export function AgentModelPanel({ settings }: { settings: ModelSettingsView }) {
  const agents = settings.agents ?? [];
  const [rows, setRows] = useState<Record<string, RowState>>(() =>
    Object.fromEntries(agents.map((agent) => [agent.key, rowStateOf(agent)])),
  );
  const save = useSaveModelSettings();

  const defaultModelSpec = settings.savedModel ?? settings.model ?? "";

  const updateRow = (key: AgentModelKey, patch: Partial<RowState>) => {
    setRows((previous) => ({ ...previous, [key]: { ...previous[key]!, ...patch } }));
    save.reset();
  };

  const handleSave = () => {
    if (defaultModelSpec === "") {
      return;
    }
    const agentsPayload: Record<string, string | null> = {};
    for (const agent of agents) {
      const row = rows[agent.key];
      if (row?.mode === "custom" && row.providerId !== "" && row.modelId !== "") {
        agentsPayload[agent.key] = `${row.providerId}/${row.modelId}`;
      } else {
        agentsPayload[agent.key] = null;
      }
    }
    save.mutate({ model: defaultModelSpec, agents: agentsPayload });
  };

  const dirty = agents.some((agent) => {
    const row = rows[agent.key];
    if (row === undefined) {
      return false;
    }
    if (row.mode === "inherit") {
      return agent.source === "agent_override";
    }
    return agent.override !== `${row.providerId}/${row.modelId}`;
  });

  return (
    <section className="settings-block" aria-label="Agent 独立模型配置" data-testid="agent-model-panel">
      <h2 className="panel-title">Agent 独立模型配置</h2>
      <p className="panel-sub">
        默认全部继承上方默认模型；为个别 Agent 选择「自定义」可独立指定 Provider / Model。
        凭据与 API Key 按 Provider 共用（在上方配置），Agent 配置不保存任何 Key。
        保存后新的 Agent 任务生效；有任务运行中时保存会被拒绝（409）。
      </p>
      <div className="agent-model-list">
        {agents.map((agent) => (
          <AgentModelRow
            key={agent.key}
            agent={agent}
            row={rows[agent.key] ?? rowStateOf(agent)}
            defaultModel={settings.model ?? settings.savedModel}
            defaultProvider={settings.provider}
            onUpdate={(patch) => updateRow(agent.key, patch)}
          />
        ))}
      </div>
      <div className="form-actions settings-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleSave}
          disabled={!dirty || defaultModelSpec === "" || save.isPending}
          data-testid="save-agent-models"
          title={defaultModelSpec === "" ? "请先保存默认模型" : "保存全部 Agent 的模型配置"}
        >
          {save.isPending ? "保存中…" : "保存 Agent 配置"}
        </button>
      </div>
      {save.isError ? (
        <p className="form-error" role="alert" data-testid="agent-model-save-error">
          保存失败：{formatApiError(save.error)}
          <details className="details-block" style={{ marginTop: "var(--s-2)" }}>
            <summary>详细信息</summary>
            <div className="details-body mono">{formatApiErrorDetail(save.error)}</div>
          </details>
        </p>
      ) : null}
      {save.isSuccess ? (
        <p className="note note-success" role="status" data-testid="agent-model-save-success">
          <span>
            <span className="note-mark">✓</span> 已保存 Agent 模型配置，新的 Agent 任务将使用各自配置。
          </span>
        </p>
      ) : null}
    </section>
  );
}

function AgentModelRow({
  agent,
  row,
  defaultModel,
  defaultProvider,
  onUpdate,
}: {
  agent: AgentModelSettingView;
  row: RowState;
  /** 默认模型规格（展示「继承默认：…」用） */
  defaultModel?: string;
  /** 默认模型 provider 段（展开「自定义」时的预填；后端 DTO 提供，不拆字符串） */
  defaultProvider?: string;
  onUpdate: (patch: Partial<RowState>) => void;
}) {
  const providersQuery = useModelOptions();
  const modelsQuery = useModelOptions(row.providerId === "" ? undefined : row.providerId);
  const test = useTestModelConnection();

  const providers: ModelProviderOptionView[] | undefined =
    providersQuery.data !== undefined && "providers" in providersQuery.data
      ? providersQuery.data.providers
      : undefined;
  const models = modelsQuery.data !== undefined && "models" in modelsQuery.data ? modelsQuery.data.models : undefined;
  const selectedSpec = row.providerId !== "" && row.modelId !== "" ? `${row.providerId}/${row.modelId}` : "";
  // 继承态显示默认模型（不读 agent.effective——切回继承时它还是过期的 override 值）
  const effective =
    row.mode === "custom"
      ? selectedSpec !== ""
        ? selectedSpec
        : "（待选择模型）"
      : defaultModel ?? "（未配置）";

  const handleModeChange = (mode: RowMode) => {
    if (mode === "custom") {
      // 展开时预填当前继承的 provider，减少重复输入
      const provider = agent.overrideProvider ?? defaultProvider;
      onUpdate({
        mode,
        ...(row.providerId === "" && provider !== undefined ? { providerId: provider, modelId: "" } : {}),
      });
    } else {
      onUpdate({ mode, providerId: "", modelId: "" });
      test.reset();
    }
  };

  const handleProviderChange = (providerId: string) => {
    onUpdate({ providerId, modelId: "" });
    test.reset();
  };

  const handleTest = () => {
    if (selectedSpec === "") {
      return;
    }
    test.mutate({ model: selectedSpec });
  };

  return (
    <div className="agent-model-row" data-testid={`agent-model-row-${agent.key}`}>
      <div className="agent-model-row-head">
        <span className="agent-model-name">{AGENT_MODEL_LABELS[agent.key]}</span>
        <select
          value={row.mode}
          onChange={(event) => handleModeChange(event.target.value as RowMode)}
          aria-label={`${AGENT_MODEL_LABELS[agent.key]} 模型来源`}
          data-testid={`agent-model-mode-${agent.key}`}
        >
          <option value="inherit">继承默认</option>
          <option value="custom">自定义</option>
        </select>
      </div>
      {row.mode === "inherit" ? (
        <span className="field-help" data-testid={`agent-model-effective-${agent.key}`}>
          继承默认：<span className="mono">{effective}</span>
        </span>
      ) : (
        <div className="agent-model-custom">
          <div className="field">
            <label htmlFor={`agent-provider-${agent.key}`}>Provider</label>
            <ProviderCombobox
              id={`agent-provider-${agent.key}`}
              providers={providers}
              value={row.providerId}
              onChange={handleProviderChange}
            />
          </div>
          <div className="field">
            <label htmlFor={`agent-model-${agent.key}`}>Model</label>
            <ModelCombobox
              id={`agent-model-${agent.key}`}
              models={models}
              value={row.modelId}
              onChange={(next) => {
                onUpdate({ modelId: next });
                test.reset();
              }}
              disabled={row.providerId === ""}
              loading={row.providerId !== "" && models === undefined}
              emptyHint={row.providerId === "" ? "请先选择 Provider" : "该提供商暂无模型目录"}
            />
          </div>
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-small"
              onClick={handleTest}
              disabled={selectedSpec === "" || test.isPending}
              data-testid={`agent-model-test-${agent.key}`}
              title="用该 Agent 当前选择的 provider/model 发起一次最小调用（使用该 Provider 已保存的凭据；不保存）"
            >
              {test.isPending ? "测试中…" : "测试连接"}
            </button>
            {agent.source === "agent_override" && agent.authConfigured === false ? (
              <span className="field-help">该 Provider 尚无可用凭据，请先在上方配置 API Key</span>
            ) : null}
          </div>
          {test.data !== undefined ? (
            test.data.ok ? (
              <p className="note note-success" role="status">
                <span>
                  <span className="note-mark">✓</span> 连接正常：<span className="mono">{test.data.model}</span>（{test.data.latencyMs}ms）
                </span>
              </p>
            ) : (
              <p className="note note-error" role="alert">
                <span>
                  <span className="note-mark">✗</span> {TEST_CODE_LABEL[test.data.code ?? "UNKNOWN"]}
                  {test.data.detail !== undefined ? `（${test.data.detail.slice(0, 160)}）` : ""}
                </span>
              </p>
            )
          ) : null}
          {test.isError ? (
            <p className="form-error" role="alert">
              测试请求失败：{formatApiError(test.error)}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
