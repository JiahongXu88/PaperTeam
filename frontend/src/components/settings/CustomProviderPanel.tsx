import { useState } from "react";

import { useDeleteCustomProvider, useSaveCustomProvider } from "../../hooks/queries.js";
import type { CustomProviderApi, CustomProviderInput, CustomProviderView } from "../../types/api.js";
import { formatApiError } from "../../utils/errors.js";

/**
 * 自定义模型提供商（Anthropic / OpenAI 兼容网关、私有部署）的列表与编辑表单。
 *
 * 配置本体（Base URL / 协议 / 模型目录 / 额外请求头）由 Backend 持久化并注入 Pi Runtime；
 * API Key 与内置提供商走同一条保存路径（本机 auth.json，不回显）。
 */

const API_LABEL: Record<CustomProviderApi, string> = {
  "anthropic-messages": "Anthropic Messages",
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
};

const API_HELP: Record<CustomProviderApi, string> = {
  "anthropic-messages": "请求 {Base URL}/v1/messages；Claude 官方与多数 Claude 兼容网关使用此协议。",
  "openai-completions": "请求 {Base URL}/chat/completions；OpenAI 兼容网关、vLLM、Ollama 等通常使用此协议。",
  "openai-responses": "请求 {Base URL}/responses；仅 OpenAI Responses API 兼容的服务使用。",
};

interface ModelRow {
  key: number;
  id: string;
  name: string;
  contextWindow: string;
  maxTokens: string;
  reasoning: boolean;
  image: boolean;
}

interface FormState {
  id: string;
  name: string;
  baseUrl: string;
  api: CustomProviderApi;
  authHeader: boolean;
  headersText: string;
  models: ModelRow[];
  apiKey: string;
}

let rowKey = 0;

function emptyRow(): ModelRow {
  rowKey += 1;
  return { key: rowKey, id: "", name: "", contextWindow: "200000", maxTokens: "8192", reasoning: false, image: false };
}

function emptyForm(): FormState {
  return {
    id: "",
    name: "",
    baseUrl: "",
    api: "anthropic-messages",
    authHeader: true,
    headersText: "",
    models: [emptyRow()],
    apiKey: "",
  };
}

function formFrom(provider: CustomProviderView): FormState {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    api: provider.api,
    authHeader: provider.authHeader,
    headersText: Object.entries(provider.headers)
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n"),
    models: provider.models.map((model) => {
      rowKey += 1;
      return {
        key: rowKey,
        id: model.id,
        name: model.name,
        contextWindow: String(model.contextWindow),
        maxTokens: String(model.maxTokens),
        reasoning: model.reasoning,
        image: model.input.includes("image"),
      };
    }),
    apiKey: "",
  };
}

/** 表单 → 请求体；返回错误文案时表示前端就能判定的缺失项（其余交给 Backend 校验） */
function toInput(form: FormState): { input: CustomProviderInput } | { error: string } {
  const headers: Record<string, string> = {};
  for (const line of form.headersText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator <= 0) {
      return { error: `请求头「${trimmed}」缺少冒号，格式应为 名称: 值` };
    }
    headers[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  const models = form.models.filter((row) => row.id.trim() !== "" || row.name.trim() !== "");
  if (models.length === 0) {
    return { error: "至少填写一个模型的 Model ID" };
  }
  for (const row of models) {
    if (row.id.trim() === "") {
      return { error: "每个模型都需要 Model ID" };
    }
    if (!/^\d+$/.test(row.contextWindow.trim()) || !/^\d+$/.test(row.maxTokens.trim())) {
      return { error: `模型 ${row.id} 的上下文窗口 / 最大输出必须是正整数` };
    }
  }
  return {
    input: {
      id: form.id.trim(),
      name: form.name.trim() === "" ? form.id.trim() : form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      api: form.api,
      authHeader: form.authHeader,
      headers,
      models: models.map((row) => ({
        id: row.id.trim(),
        name: row.name.trim() === "" ? row.id.trim() : row.name.trim(),
        reasoning: row.reasoning,
        contextWindow: Number(row.contextWindow.trim()),
        maxTokens: Number(row.maxTokens.trim()),
        input: row.image ? ["text", "image"] : ["text"],
      })),
    },
  };
}

export function CustomProviderPanel({
  providers,
  loading,
  onSaved,
}: {
  providers: CustomProviderView[] | undefined;
  loading: boolean;
  /** 保存成功后回调（上层据此把"模型提供商"切到刚保存的 provider） */
  onSaved?: (providerId: string) => void;
}) {
  const [editing, setEditing] = useState<FormState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const remove = useDeleteCustomProvider();

  return (
    <section className="settings-block custom-providers" aria-labelledby="custom-providers-title" data-testid="custom-providers">
      <div className="section-head">
        <h2 className="panel-title" id="custom-providers-title">
          自定义提供商
        </h2>
        {editing === null ? (
          <button type="button" className="btn" onClick={() => setEditing(emptyForm())} data-testid="add-custom-provider">
            添加自定义提供商
          </button>
        ) : null}
      </div>
      <p className="panel-sub">
        接入 Anthropic / OpenAI 兼容的网关或私有部署：填写 Base URL、协议与模型列表，保存后即可在上方「模型提供商」中选择。API Key 与内置提供商一样只保存在本机 Backend。
      </p>

      {loading ? <p className="muted">加载自定义提供商…</p> : null}
      {!loading && providers !== undefined && providers.length === 0 && editing === null ? (
        <p className="muted" data-testid="custom-providers-empty">
          尚未添加自定义提供商。
        </p>
      ) : null}
      {providers !== undefined && providers.length > 0 ? (
        <div className="table-scroll">
          <table className="data-table" data-testid="custom-providers-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>协议</th>
                <th>Base URL</th>
                <th className="num">模型</th>
                <th>凭据</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {providers.map((provider) => (
                <tr key={provider.id} data-testid={`custom-provider-${provider.id}`}>
                  <td>
                    <div>{provider.name}</div>
                    <div className="mono muted">{provider.id}</div>
                  </td>
                  <td>{API_LABEL[provider.api]}</td>
                  <td className="mono">{provider.baseUrl}</td>
                  <td className="num">{provider.models.length}</td>
                  <td>
                    {provider.authConfigured ? (
                      <span className="status status-tone-ok">已配置</span>
                    ) : (
                      <span className="status status-tone-warn">未配置</span>
                    )}
                  </td>
                  <td>
                    {confirmDelete === provider.id ? (
                      <span className="inline-confirm" role="group" aria-label={`确认删除 ${provider.name}`}>
                        <span>连同其本地 API Key 一起删除。</span>
                        <button
                          type="button"
                          className="btn btn-small btn-danger"
                          disabled={remove.isPending}
                          onClick={() =>
                            remove.mutate(provider.id, {
                              onSuccess: () => setConfirmDelete(null),
                            })
                          }
                          data-testid={`confirm-delete-${provider.id}`}
                        >
                          确认删除
                        </button>
                        <button type="button" className="btn btn-small" onClick={() => setConfirmDelete(null)}>
                          取消
                        </button>
                      </span>
                    ) : (
                      <span className="action-row">
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => {
                            setEditing(formFrom(provider));
                            remove.reset();
                          }}
                          data-testid={`edit-${provider.id}`}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          className="btn btn-small btn-danger"
                          onClick={() => setConfirmDelete(provider.id)}
                          data-testid={`delete-${provider.id}`}
                        >
                          删除
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {remove.isError ? (
        <p className="form-error" role="alert">
          删除失败：{formatApiError(remove.error)}
        </p>
      ) : null}

      {editing !== null ? (
        <CustomProviderForm
          initial={editing}
          existingIds={(providers ?? []).map((provider) => provider.id)}
          onCancel={() => setEditing(null)}
          onSaved={(providerId) => {
            setEditing(null);
            onSaved?.(providerId);
          }}
        />
      ) : null}
    </section>
  );
}

function CustomProviderForm({
  initial,
  existingIds,
  onCancel,
  onSaved,
}: {
  initial: FormState;
  existingIds: string[];
  onCancel: () => void;
  onSaved: (providerId: string) => void;
}) {
  const [form, setForm] = useState(initial);
  const [localError, setLocalError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const save = useSaveCustomProvider();
  const isEdit = existingIds.includes(initial.id) && initial.id !== "";

  const update = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [field]: value }));
    setLocalError(null);
    save.reset();
  };

  const updateRow = (key: number, patch: Partial<ModelRow>) => {
    setForm((current) => ({
      ...current,
      models: current.models.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    }));
    setLocalError(null);
  };

  const submit = () => {
    if (form.id.trim() === "" || form.baseUrl.trim() === "") {
      setLocalError("请填写提供商 id 与 Base URL");
      return;
    }
    const converted = toInput(form);
    if ("error" in converted) {
      setLocalError(converted.error);
      return;
    }
    const apiKey = form.apiKey.trim();
    save.mutate(
      { provider: converted.input, ...(apiKey !== "" ? { apiKey } : {}) },
      { onSuccess: (result) => onSaved(result.provider.id) },
    );
  };

  return (
    <form
      className="settings-form custom-provider-form"
      data-testid="custom-provider-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h3 className="panel-title">{isEdit ? `编辑 ${initial.id}` : "新建自定义提供商"}</h3>

      <fieldset className="form-section">
        <legend>提供商</legend>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="cp-id">
              提供商 id <span className="required">*</span>
            </label>
            <input
              id="cp-id"
              type="text"
              value={form.id}
              disabled={isEdit}
              placeholder="如 my-gateway"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => update("id", event.target.value.toLowerCase())}
            />
            <span className="field-help">小写字母、数字、连字符；模型规格写作 id/model-id，保存后不可改</span>
          </div>
          <div className="field">
            <label htmlFor="cp-name">显示名称</label>
            <input id="cp-name" type="text" value={form.name} placeholder="留空则用 id" onChange={(event) => update("name", event.target.value)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="cp-base-url">
            Base URL <span className="required">*</span>
          </label>
          <input
            id="cp-base-url"
            type="url"
            value={form.baseUrl}
            placeholder="https://api.example.com"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => update("baseUrl", event.target.value)}
          />
          <span className="field-help">不含 /v1/messages、/chat/completions 这类路径；协议决定请求路径</span>
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="cp-api">接口协议</label>
            <select id="cp-api" value={form.api} onChange={(event) => update("api", event.target.value as CustomProviderApi)}>
              {(Object.keys(API_LABEL) as CustomProviderApi[]).map((api) => (
                <option key={api} value={api}>
                  {API_LABEL[api]}
                </option>
              ))}
            </select>
            <span className="field-help">{API_HELP[form.api]}</span>
          </div>
          <div className="field">
            <label htmlFor="cp-auth-header">认证方式</label>
            <label className="check" htmlFor="cp-auth-header">
              <input
                id="cp-auth-header"
                type="checkbox"
                checked={form.authHeader}
                onChange={(event) => update("authHeader", event.target.checked)}
              />
              <span>用 Authorization: Bearer 发送 API Key</span>
            </label>
            <span className="field-help">
              {form.api === "anthropic-messages" ? "不勾选则用 Anthropic 原生的 x-api-key 头；多数网关需要 Bearer。" : "OpenAI 协议本就使用 Bearer，此项通常保持勾选。"}
            </span>
          </div>
        </div>
        <div className="field">
          <label htmlFor="cp-headers">额外请求头（可选）</label>
          <textarea
            id="cp-headers"
            rows={2}
            value={form.headersText}
            placeholder={"每行一个，格式 名称: 值\nX-Tenant: research"}
            spellCheck={false}
            onChange={(event) => update("headersText", event.target.value)}
          />
          <span className="field-help">不能放 Authorization / x-api-key 等认证头，Key 请填在下方</span>
        </div>
      </fieldset>

      <fieldset className="form-section">
        <legend>模型列表</legend>
        <div className="table-scroll">
          <table className="data-table model-rows" data-testid="custom-model-rows">
            <thead>
              <tr>
                <th>Model ID</th>
                <th>显示名称</th>
                <th>上下文窗口</th>
                <th>最大输出</th>
                <th>推理</th>
                <th>图片</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {form.models.map((row, index) => (
                <tr key={row.key}>
                  <td>
                    <input
                      type="text"
                      aria-label={`模型 ${index + 1} 的 Model ID`}
                      value={row.id}
                      placeholder="claude-sonnet-4-5"
                      spellCheck={false}
                      onChange={(event) => updateRow(row.key, { id: event.target.value })}
                    />
                  </td>
                  <td>
                    <input type="text" aria-label={`模型 ${index + 1} 的显示名称`} value={row.name} placeholder="留空则用 Model ID" onChange={(event) => updateRow(row.key, { name: event.target.value })} />
                  </td>
                  <td>
                    <input type="text" inputMode="numeric" aria-label={`模型 ${index + 1} 的上下文窗口`} value={row.contextWindow} onChange={(event) => updateRow(row.key, { contextWindow: event.target.value })} />
                  </td>
                  <td>
                    <input type="text" inputMode="numeric" aria-label={`模型 ${index + 1} 的最大输出`} value={row.maxTokens} onChange={(event) => updateRow(row.key, { maxTokens: event.target.value })} />
                  </td>
                  <td>
                    <input type="checkbox" aria-label={`模型 ${index + 1} 支持推理`} checked={row.reasoning} onChange={(event) => updateRow(row.key, { reasoning: event.target.checked })} />
                  </td>
                  <td>
                    <input type="checkbox" aria-label={`模型 ${index + 1} 支持图片输入`} checked={row.image} onChange={(event) => updateRow(row.key, { image: event.target.checked })} />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-small"
                      aria-label={`移除模型 ${index + 1}`}
                      disabled={form.models.length === 1}
                      onClick={() => setForm((current) => ({ ...current, models: current.models.filter((item) => item.key !== row.key) }))}
                    >
                      移除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="action-row">
          <button type="button" className="btn btn-small" onClick={() => setForm((current) => ({ ...current, models: [...current.models, emptyRow()] }))} data-testid="add-model-row">
            添加模型
          </button>
          <span className="field-help">「推理」只在服务端确实支持 thinking 时勾选，否则请求会带上不被接受的参数。</span>
        </div>
      </fieldset>

      <fieldset className="form-section">
        <legend>凭据</legend>
        <div className="field">
          <label htmlFor="cp-api-key">API Key{isEdit ? "（留空则保留已保存的 Key）" : ""}</label>
          <div className="input-group">
            <input
              id="cp-api-key"
              type={showKey ? "text" : "password"}
              value={form.apiKey}
              autoComplete="off"
              spellCheck={false}
              placeholder={isEdit ? "留空则保留当前 Key" : "可稍后在上方「模型与凭据」中填写"}
              onChange={(event) => update("apiKey", event.target.value)}
              data-testid="custom-provider-api-key"
            />
            <button type="button" className="btn" onClick={() => setShowKey((value) => !value)} aria-pressed={showKey}>
              {showKey ? "隐藏" : "显示"}
            </button>
          </div>
          <span className="field-help">只发往本机 Backend 保存，不会回显。</span>
        </div>
      </fieldset>

      {localError !== null ? (
        <p className="form-error" role="alert" data-testid="custom-provider-error">
          {localError}
        </p>
      ) : null}
      {save.isError ? (
        <p className="form-error" role="alert" data-testid="custom-provider-error">
          保存失败：{formatApiError(save.error)}
        </p>
      ) : null}

      <div className="form-actions">
        <button type="button" className="btn" onClick={onCancel} disabled={save.isPending}>
          取消
        </button>
        <button type="submit" className="btn btn-primary" disabled={save.isPending} data-testid="save-custom-provider">
          {save.isPending ? "保存中…" : isEdit ? "保存修改" : "保存提供商"}
        </button>
      </div>
    </form>
  );
}
