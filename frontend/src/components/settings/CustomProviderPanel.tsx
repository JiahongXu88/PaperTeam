import { useEffect, useMemo, useRef, useState } from "react";

import {
  useDeleteCustomProvider,
  useDiscoverCustomProviderModels,
  useSaveCustomProvider,
  useTestCustomProviderModel,
} from "../../hooks/queries.js";
import type {
  CustomProviderApi,
  CustomProviderInput,
  CustomProviderView,
  DiscoveredModelView,
  ModelDiscoveryErrorCodeView,
} from "../../types/api.js";
import { formatApiError } from "../../utils/errors.js";

/**
 * 自定义模型提供商（Anthropic / OpenAI 兼容网关、私有部署）的列表与编辑表单。
 *
 * M13.4 重构（参考 CC Switch 的供应商配置 UX）：
 * 用户流程 = 服务名称 → API 地址 → API Key → 获取模型 → 选择模型 →
 * 测试连接 → 保存。Provider ID 由服务端自动生成（高级设置只读显示）；
 * 协议 / 认证头 / 额外请求头 / 发现路径收入默认折叠的高级设置；
 * 模型列表优先自动发现（Backend 代发请求，复用已保存凭据），
 * 目录不可用时手动添加兜底；上下文窗口等元数据缺省为保守值并明确
 * 标记「未经上游验证」。
 *
 * 安全约束：API Key 只经本表单发往同源 Backend（编辑时不回显，留空 =
 * 继续使用已保存 Key）；目录发现与测试连接均由 Backend 完成，凭据不进
 * 浏览器存储 / URL / 日志。
 */

const API_LABEL: Record<CustomProviderApi, string> = {
  "anthropic-messages": "Anthropic Messages",
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
};

const API_HELP: Record<CustomProviderApi, string> = {
  "anthropic-messages": "请求 {Base URL}/v1/messages；Claude 官方与多数公司网关使用此协议。",
  "openai-completions": "请求 {Base URL}/chat/completions（Base URL 需含 /v1，如 https://api.openai.com/v1）；OpenAI 兼容网关、vLLM、Ollama 等常用。",
  "openai-responses": "请求 {Base URL}/responses（Base URL 需含 /v1）；仅 OpenAI Responses API 兼容的服务使用。",
};

/** 未提供目录元数据时的保守默认（明确标记「未经上游验证」，可修改） */
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 8_192;

const DISCOVERY_ERROR_LABEL: Record<ModelDiscoveryErrorCodeView, string> = {
  AUTH_FAILED: "认证失败：请检查 API Key 是否正确、是否有该服务的权限",
  NOT_SUPPORTED: "该服务未提供模型目录接口（这不代表网关不可用）：请手动添加 Model ID",
  RATE_LIMITED: "请求被限流：请稍后重试",
  SERVER_ERROR: "网关服务错误：请稍后重试或检查服务状态",
  TIMEOUT: "请求超时：请检查网络或稍后重试",
  BAD_RESPONSE: "目录响应无法解析（格式不符合 {data:[...]} 等已知结构）",
  REDIRECTED: "请求被重定向到其他主机，已拒绝转发认证信息；请改用最终地址",
  NETWORK: "无法连接网关：请检查地址与网络",
  UNKNOWN: "未知错误",
};

const TEST_CODE_LABEL: Record<string, string> = {
  AUTH_FAILED: "API Key 无效或认证失败",
  MODEL_NOT_FOUND: "找不到所选模型",
  PROVIDER_UNAVAILABLE: "模型服务不可达（网络或上游故障）",
  RATE_LIMITED: "请求受限（限流 / 配额 / 账户余额不足）",
  TIMEOUT: "连接超时，请检查网络或模型服务",
  BAD_REQUEST: "请求被服务拒绝（模型或参数不支持，详见详细信息）",
  THINKING_INCOMPATIBLE: "网关没有支持 thinking 的渠道：探针对推理模型会携带 thinking 字段。若该模型经此网关不需要 thinking，展开模型把「thinking 参数」设为「不发送」后重试",
  UNKNOWN: "未知错误",
};

interface ModelEntry {
  key: number;
  id: string;
  name: string;
  contextWindow: string;
  maxTokens: string;
  reasoning: boolean;
  image: boolean;
  /** M13.5：omit = 该网关不能携带 thinking/reasoning 字段（见 CustomProviderModelInput） */
  thinkingRequest: "auto" | "omit";
  /** 数值来自上游目录或用户显式编辑；false = 保守默认值（UI 标记未验证） */
  metadataVerified: boolean;
}

interface FormState {
  /** "" = 新建（服务端自动生成 id）；编辑时为既有 id */
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  api: CustomProviderApi;
  authHeader: boolean;
  headersText: string;
  modelsPath: string;
  models: ModelEntry[];
}

let rowKey = 0;

function newEntry(options?: { id?: string; name?: string; contextWindow?: number; metadataVerified?: boolean }): ModelEntry {
  rowKey += 1;
  return {
    key: rowKey,
    id: options?.id ?? "",
    name: options?.name ?? "",
    contextWindow: String(options?.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
    maxTokens: String(DEFAULT_MAX_TOKENS),
    reasoning: false,
    image: false,
    thinkingRequest: "auto",
    metadataVerified: options?.metadataVerified ?? false,
  };
}

function emptyForm(): FormState {
  return {
    id: "",
    name: "",
    baseUrl: "",
    apiKey: "",
    api: "anthropic-messages",
    authHeader: true,
    headersText: "",
    modelsPath: "",
    models: [],
  };
}

function formFrom(provider: CustomProviderView): FormState {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: "",
    api: provider.api,
    authHeader: provider.authHeader,
    headersText: Object.entries(provider.headers)
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n"),
    modelsPath: provider.modelsPath ?? "",
    models: provider.models.map((model) => {
      rowKey += 1;
      return {
        key: rowKey,
        id: model.id,
        name: model.name === model.id ? "" : model.name,
        contextWindow: String(model.contextWindow),
        maxTokens: String(model.maxTokens),
        reasoning: model.reasoning,
        image: model.input.includes("image"),
        thinkingRequest: model.thinkingRequest === "omit" ? "omit" : "auto",
        metadataVerified: model.metadataVerified ?? false,
      };
    }),
  };
}

/** 脏检查快照：排除 row key 与 apiKey（Key 单独参与比较） */
function formSnapshot(form: FormState): string {
  return JSON.stringify({
    id: form.id,
    name: form.name,
    baseUrl: form.baseUrl,
    api: form.api,
    authHeader: form.authHeader,
    headersText: form.headersText,
    modelsPath: form.modelsPath,
    models: form.models.map(({ key: _key, ...rest }) => rest),
  });
}

/** 解析额外请求头文本；格式非法时返回错误文案 */
function parseHeadersText(text: string): { headers: Record<string, string> } | { error: string } {
  const headers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
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
  return { headers };
}

/** 表单 → 请求体；返回错误文案 = 前端即可判定的缺失项（其余交给 Backend 校验） */
function toInput(form: FormState): { input: CustomProviderInput } | { error: string } {
  const headers = parseHeadersText(form.headersText);
  if ("error" in headers) {
    return headers;
  }
  const models = form.models.filter((row) => row.id.trim() !== "");
  if (models.length === 0) {
    return { error: "请至少添加一个模型（自动发现或手动输入 Model ID）" };
  }
  for (const row of models) {
    if (!/^\d+$/.test(row.contextWindow.trim()) || !/^\d+$/.test(row.maxTokens.trim())) {
      return { error: `模型 ${row.id} 的上下文窗口 / 最大输出必须是正整数` };
    }
  }
  return {
    input: {
      id: form.id.trim(),
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      api: form.api,
      authHeader: form.authHeader,
      headers: headers.headers,
      models: models.map((row) => ({
        id: row.id.trim(),
        name: row.name.trim() === "" ? row.id.trim() : row.name.trim(),
        reasoning: row.reasoning,
        contextWindow: Number(row.contextWindow.trim()),
        maxTokens: Number(row.maxTokens.trim()),
        input: row.image ? ["text", "image"] : ["text"],
        ...(row.metadataVerified ? { metadataVerified: true } : {}),
        ...(row.thinkingRequest === "omit" ? { thinkingRequest: "omit" as const } : {}),
      })),
      ...(form.modelsPath.trim() !== "" ? { modelsPath: form.modelsPath.trim() } : {}),
    },
  };
}

export function CustomProviderPanel({
  providers,
  loading,
  authConfiguredById,
  onSaved,
}: {
  providers: CustomProviderView[] | undefined;
  loading: boolean;
  /** 编辑表单判断「留空 = 继续使用已保存 Key」时需要凭据状态（列表条目自带，容错独立提供） */
  authConfiguredById?: Record<string, boolean>;
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
        接入 Anthropic / OpenAI 兼容的网关或私有部署：填写名称、地址与 API Key，
        点击「获取可用模型」自动拉取模型列表，选择后保存即可在上方「模型提供商」中使用。
        API Key 与内置提供商一样只保存在本机 Backend。
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
          authConfigured={editing.id !== "" && (authConfiguredById?.[editing.id] ?? providers?.find((provider) => provider.id === editing.id)?.authConfigured === true)}
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
  authConfigured,
  onCancel,
  onSaved,
}: {
  initial: FormState;
  /** 编辑对象已有保存的凭据（控制 API Key 帮助文案） */
  authConfigured: boolean;
  onCancel: () => void;
  onSaved: (providerId: string) => void;
}) {
  const isEdit = initial.id !== "";
  const [form, setForm] = useState(initial);
  const [localError, setLocalError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [catalog, setCatalog] = useState<DiscoveredModelView[] | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(true);
  const catalogBlockRef = useRef<HTMLDivElement | null>(null);
  const [search, setSearch] = useState("");
  const [manualId, setManualId] = useState("");
  const [testModelId, setTestModelId] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(
    initial.api !== "anthropic-messages" || initial.authHeader !== true || initial.headersText !== "" || initial.modelsPath !== "" || isEdit,
  );
  const save = useSaveCustomProvider();
  const discover = useDiscoverCustomProviderModels();
  const test = useTestCustomProviderModel();

  const initialSnapshot = useMemo(() => formSnapshot(initial), [initial]);
  const dirty = formSnapshot(form) !== initialSnapshot || form.apiKey !== "";

  const update = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [field]: value }));
    setLocalError(null);
    save.reset();
  };

  const updateEntry = (key: number, patch: Partial<ModelEntry>) => {
    setForm((current) => ({
      ...current,
      models: current.models.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    }));
    setLocalError(null);
  };

  const addModel = (options: { id: string; name?: string; contextWindow?: number; metadataVerified?: boolean }) => {
    setForm((current) => {
      if (current.models.some((row) => row.id === options.id)) {
        return current;
      }
      return { ...current, models: [...current.models, newEntry(options)] };
    });
    setLocalError(null);
  };

  const removeModel = (id: string) => {
    setForm((current) => ({ ...current, models: current.models.filter((row) => row.id !== id) }));
    if (testModelId === id) {
      setTestModelId("");
      test.reset();
    }
  };

  const runDiscovery = () => {
    const baseUrl = form.baseUrl.trim();
    if (baseUrl === "") {
      setLocalError("请先填写 API 地址");
      return;
    }
    const headers = parseHeadersText(form.headersText);
    if ("error" in headers) {
      setLocalError(headers.error);
      return;
    }
    const typedKey = form.apiKey.trim();
    discover.mutate(
      {
        baseUrl,
        api: form.api,
        authHeader: form.authHeader,
        headers: headers.headers,
        ...(form.modelsPath.trim() !== "" ? { modelsPath: form.modelsPath.trim() } : {}),
        ...(typedKey !== "" ? { apiKey: typedKey } : {}),
        ...(isEdit ? { providerId: form.id } : {}),
      },
      {
        onSuccess: (result) => {
          if (result.ok) {
            setCatalog(result.models ?? []);
            setSearch("");
            setCatalogOpen(true);
            setLocalError(null);
          } else {
            setCatalog(null);
          }
        },
      },
    );
  };

  const addManualModel = () => {
    const id = manualId.trim();
    if (id === "") {
      setLocalError("请输入 Model ID");
      return;
    }
    if (/\s/.test(id)) {
      setLocalError("Model ID 不能包含空白字符");
      return;
    }
    if (form.models.some((row) => row.id === id)) {
      setLocalError(`模型 ${id} 已在列表中`);
      return;
    }
    addModel({ id });
    setManualId("");
    setLocalError(null);
  };

  const runTest = () => {
    const modelId = (testModelId !== "" ? testModelId : form.models[0]?.id ?? "").trim();
    if (modelId === "") {
      setLocalError("请先选择要测试的模型");
      return;
    }
    const converted = toInput(form);
    if ("error" in converted) {
      setLocalError(converted.error);
      return;
    }
    const typedKey = form.apiKey.trim();
    test.mutate({
      provider: converted.input,
      modelId,
      ...(typedKey !== "" ? { apiKey: typedKey } : {}),
    });
  };

  const submit = () => {
    if (form.name.trim() === "" || form.baseUrl.trim() === "") {
      setLocalError("请填写服务名称与 API 地址");
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

  const requestCancel = () => {
    if (!dirty) {
      onCancel();
      return;
    }
    setConfirmDiscard(true);
  };

  const filteredCatalog = useMemo(() => {
    if (catalog === null) {
      return [];
    }
    const keyword = search.trim().toLowerCase();
    if (keyword === "") {
      return catalog;
    }
    return catalog.filter(
      (entry) => entry.id.toLowerCase().includes(keyword) || (entry.name ?? "").toLowerCase().includes(keyword),
    );
  }, [catalog, search]);

  const groupedCatalog = useMemo(() => {
    const groups = new Map<string, DiscoveredModelView[]>();
    for (const entry of filteredCatalog) {
      const group = entry.ownedBy ?? "";
      const list = groups.get(group);
      if (list === undefined) {
        groups.set(group, [entry]);
      } else {
        list.push(entry);
      }
    }
    return [...groups.entries()];
  }, [filteredCatalog]);

  // 目录收起（M13.5）：点击目录区域外或按 Esc 关闭；已选模型与搜索词不丢失
  //（选择存在 form.models，搜索词存在 state，重新展开即恢复）
  useEffect(() => {
    if (catalog === null || !catalogOpen) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (catalogBlockRef.current !== null && event.target instanceof Node && !catalogBlockRef.current.contains(event.target)) {
        setCatalogOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [catalog, catalogOpen]);

  const discoveryResult = discover.data;
  const selectedCount = form.models.length;

  return (
    <form
      className="settings-form custom-provider-form"
      data-testid="custom-provider-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h3 className="panel-title">{isEdit ? `编辑 ${initial.name || initial.id}` : "添加自定义提供商"}</h3>

      <fieldset className="form-section">
        <legend>基本信息</legend>
        <div className="field">
          <label htmlFor="cp-name">
            服务名称 <span className="required">*</span>
          </label>
          <input
            id="cp-name"
            type="text"
            value={form.name}
            placeholder="如：公司 GLM 网关"
            autoComplete="off"
            onChange={(event) => update("name", event.target.value)}
            data-testid="custom-provider-name"
          />
          <span className="field-help">仅用于界面显示，可以是任意语言</span>
        </div>
        <div className="field">
          <label htmlFor="cp-base-url">
            API 地址 <span className="required">*</span>
          </label>
          <input
            id="cp-base-url"
            type="url"
            value={form.baseUrl}
            placeholder="https://api.example.com"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => update("baseUrl", event.target.value)}
            data-testid="custom-provider-base-url"
          />
          <span className="field-help">
            网关根地址，不含 /v1/messages、/chat/completions 等路径后缀（协议在高级设置中选择）
          </span>
        </div>
        <div className="field">
          <label htmlFor="cp-api-key">API Key{isEdit && authConfigured ? "（留空则继续使用已保存的 Key）" : ""}</label>
          <div className="input-group">
            <input
              id="cp-api-key"
              type={showKey ? "text" : "password"}
              value={form.apiKey}
              autoComplete="off"
              spellCheck={false}
              placeholder={isEdit ? (authConfigured ? "留空则继续使用已保存的 Key" : "输入新的 API Key") : "输入网关分发的 API Key（本地免认证服务可留空）"}
              onChange={(event) => update("apiKey", event.target.value)}
              data-testid="custom-provider-api-key"
            />
            <button type="button" className="btn" onClick={() => setShowKey((value) => !value)} aria-pressed={showKey}>
              {showKey ? "隐藏" : "显示"}
            </button>
          </div>
          <span className="field-help">只发往本机 Backend 保存（不回显）；获取模型与测试连接都会使用它</span>
        </div>
      </fieldset>

      <fieldset className="form-section">
        <legend>模型</legend>
        <div className="discovery-bar">
          <button
            type="button"
            className="btn btn-primary"
            onClick={runDiscovery}
            disabled={discover.isPending}
            data-testid="discover-models"
            title="由 Backend 请求网关的模型目录（OpenAI 兼容 /v1/models 等）；不会向浏览器暴露 Key"
          >
            {discover.isPending ? "获取中…" : "获取可用模型"}
          </button>
          {discoveryResult !== undefined && discoveryResult.ok ? (
            <span className="discovery-status ok" data-testid="discovery-status" role="status">
              ✓ {discoveryResult.models?.length ?? 0} 个模型
              {discoveryResult.sourcePath !== undefined ? `（来自 ${discoveryResult.sourcePath}）` : ""}
              {discoveryResult.authSource === "stored" ? "，使用已保存的 Key" : ""}
              {discoveryResult.truncated ? "，已截断" : ""}
            </span>
          ) : discoveryResult !== undefined && !discoveryResult.ok ? (
            <span className="discovery-status error" data-testid="discovery-status" role="alert">
              {DISCOVERY_ERROR_LABEL[discoveryResult.code ?? "UNKNOWN"]}
            </span>
          ) : (
            <span className="discovery-status muted">从网关自动拉取模型列表；目录不可用时可在下方手动添加</span>
          )}
        </div>
        {discoveryResult !== undefined && !discoveryResult.ok && discoveryResult.detail !== undefined ? (
          <p className="note note-warn" role="status">
            <span>{discoveryResult.detail}</span>
          </p>
        ) : null}
        {discover.isError ? (
          <p className="form-error" role="alert">
            获取失败：{formatApiError(discover.error)}
          </p>
        ) : null}

        {catalog !== null ? (
          <div className="model-catalog-block" ref={catalogBlockRef} data-testid="model-catalog-block">
            <div className="catalog-toolbar">
              <button
                type="button"
                className="btn btn-small"
                onClick={() => setCatalogOpen((value) => !value)}
                aria-expanded={catalogOpen}
                aria-controls="cp-model-catalog"
                data-testid="toggle-model-catalog"
              >
                {catalogOpen ? "收起模型目录" : `展开模型目录（${catalog.length} 个）`}
              </button>
              <span className="muted catalog-toolbar-status">
                已选 {selectedCount} 个
                {search.trim() !== "" ? " · 搜索生效中" : ""}
              </span>
            </div>
            {catalogOpen ? (
              <>
                <div className="field">
                  <label htmlFor="cp-model-search">搜索模型</label>
                  <input
                    id="cp-model-search"
                    type="search"
                    value={search}
                    placeholder="按 Model ID 或名称筛选"
                    onChange={(event) => setSearch(event.target.value)}
                    data-testid="model-search"
                  />
                </div>
                <div
                  className="model-catalog"
                  id="cp-model-catalog"
                  role="group"
                  aria-label="可用模型列表"
                  data-testid="model-catalog"
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setCatalogOpen(false);
                    }
                  }}
                >
                  {groupedCatalog.length === 0 ? (
                    <p className="model-catalog-empty muted">
                      {catalog.length === 0 ? "目录为空：该服务返回了 0 个模型，可手动添加" : "没有匹配的模型"}
                    </p>
                  ) : (
                    groupedCatalog.map(([group, entries]) => (
                      <div key={group} className="model-catalog-group">
                        {group !== "" ? <div className="model-catalog-group-label muted">{group}</div> : null}
                        {entries.map((entry) => {
                          const checked = form.models.some((row) => row.id === entry.id);
                          return (
                            <label key={entry.id} className="model-catalog-row">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(event) =>
                                  event.target.checked
                                    ? addModel({
                                        id: entry.id,
                                        name: entry.name,
                                        contextWindow: entry.contextWindow,
                                        metadataVerified: entry.contextWindow !== undefined,
                                      })
                                    : removeModel(entry.id)
                                }
                                data-testid={`catalog-model-${entry.id}`}
                              />
                              <span className="mono">{entry.id}</span>
                              {entry.name !== undefined && entry.name !== entry.id ? <span className="muted">{entry.name}</span> : null}
                              {entry.contextWindow !== undefined ? (
                                <span className="model-catalog-meta muted">{Math.round(entry.contextWindow / 1000)}k 上下文</span>
                              ) : null}
                            </label>
                          );
                        })}
                      </div>
                    ))
                  )}
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        <div className="manual-add-row">
          <label className="visually-hidden" htmlFor="cp-manual-model">
            手动添加 Model ID
          </label>
          <input
            id="cp-manual-model"
            type="text"
            value={manualId}
            placeholder="手动添加 Model ID（目录不支持时使用）"
            spellCheck={false}
            onChange={(event) => setManualId(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addManualModel();
              }
            }}
            data-testid="manual-model-id"
          />
          <button type="button" className="btn btn-small" onClick={addManualModel} data-testid="add-manual-model">
            添加
          </button>
        </div>

        {form.models.length > 0 ? (
          <div className="selected-models" data-testid="selected-models">
            <div className="selected-models-head muted">
              已选模型 <span className="num">{selectedCount}</span> 个；点击展开可编辑名称、上下文窗口等参数
            </div>
            {form.models.map((entry) => (
              <details key={entry.key} className="selected-model">
                <summary>
                  <span className="mono">{entry.id}</span>
                  {entry.name.trim() !== "" && entry.name !== entry.id ? <span className="muted">（{entry.name}）</span> : null}
                  {!entry.metadataVerified ? (
                    <span className="badge-unverified" title="上下文窗口 / 最大输出为保守默认值，未经上游目录确认">
                      未验证
                    </span>
                  ) : null}
                  {entry.thinkingRequest === "omit" ? (
                    <span className="badge-unverified" title="该网关不携带 thinking 字段（注册层不发送）">
                      无 thinking
                    </span>
                  ) : null}
                </summary>
                <div className="form-grid selected-model-body">
                  <div className="field">
                    <label htmlFor={`model-name-${entry.key}`}>显示名称</label>
                    <input
                      id={`model-name-${entry.key}`}
                      type="text"
                      value={entry.name}
                      placeholder="留空则用 Model ID"
                      onChange={(event) => updateEntry(entry.key, { name: event.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`model-context-${entry.key}`}>上下文窗口</label>
                    <input
                      id={`model-context-${entry.key}`}
                      type="text"
                      inputMode="numeric"
                      value={entry.contextWindow}
                      aria-describedby={`model-context-help-${entry.key}`}
                      onChange={(event) => updateEntry(entry.key, { contextWindow: event.target.value, metadataVerified: true })}
                    />
                    <span className="field-help" id={`model-context-help-${entry.key}`}>
                      {entry.metadataVerified ? "" : "默认保守值，未经上游验证；"}确认后可修改
                    </span>
                  </div>
                  <div className="field">
                    <label htmlFor={`model-max-${entry.key}`}>最大输出</label>
                    <input
                      id={`model-max-${entry.key}`}
                      type="text"
                      inputMode="numeric"
                      value={entry.maxTokens}
                      onChange={(event) => updateEntry(entry.key, { maxTokens: event.target.value, metadataVerified: true })}
                    />
                  </div>
                  <div className="field">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={entry.reasoning}
                        onChange={(event) => updateEntry(entry.key, { reasoning: event.target.checked })}
                      />
                      <span>模型支持推理（能力标记）</span>
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={entry.image}
                        onChange={(event) => updateEntry(entry.key, { image: event.target.checked })}
                      />
                      <span>支持图片输入</span>
                    </label>
                    <span className="field-help">「支持推理」描述模型能力，不影响请求编码</span>
                  </div>
                  <div className="field">
                    <label htmlFor={`model-thinking-${entry.key}`}>thinking 参数（网关兼容）</label>
                    <select
                      id={`model-thinking-${entry.key}`}
                      value={entry.thinkingRequest}
                      onChange={(event) => updateEntry(entry.key, { thinkingRequest: event.target.value as ModelEntry["thinkingRequest"] })}
                      data-testid={`model-thinking-request-${entry.id}`}
                    >
                      <option value="auto">自动（按模型能力发送）</option>
                      <option value="omit">不发送（网关不支持 thinking 字段）</option>
                    </select>
                    <span className="field-help">
                      部分网关按「请求里是否出现 thinking 字段」选择渠道：模型本身支持推理、但网关没有
                      thinking 渠道时，任何 thinking 请求（含关闭指令）都会失败——此处改为「不发送」即可正常调用，
                      代价是该模型经此网关不使用思考能力。
                    </span>
                  </div>
                </div>
                <div className="action-row">
                  <button type="button" className="btn btn-small btn-danger" onClick={() => removeModel(entry.id)}>
                    移除模型
                  </button>
                </div>
              </details>
            ))}
          </div>
        ) : (
          <p className="muted" data-testid="no-models-hint">
            尚未选择模型：点击「获取可用模型」，或在上方手动输入 Model ID。
          </p>
        )}
      </fieldset>

      <fieldset className="form-section">
        <legend>测试连接（保存前）</legend>
        <div className="test-row">
          <div className="field">
            <label htmlFor="cp-test-model">测试模型</label>
            <select
              id="cp-test-model"
              value={testModelId !== "" ? testModelId : form.models[0]?.id ?? ""}
              onChange={(event) => {
                setTestModelId(event.target.value);
                test.reset();
              }}
              disabled={form.models.length === 0}
              data-testid="test-model-select"
            >
              {form.models.length === 0 ? <option value="">（请先选择模型）</option> : null}
              {form.models.map((entry) => (
                <option key={entry.key} value={entry.id}>
                  {entry.id}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="btn"
            onClick={runTest}
            disabled={form.models.length === 0 || test.isPending}
            data-testid="test-custom-provider"
            title="用当前配置发起一次最小真实调用（不保存；测试成功 ≠ 已保存）"
          >
            {test.isPending ? "测试中…" : "测试连接"}
          </button>
        </div>
        {test.data !== undefined ? (
          test.data.ok ? (
            <p className="note note-success" role="status" data-testid="custom-test-result">
              <span>
                <span className="note-mark">✓</span> 连接正常：{test.data.model}（{test.data.latencyMs}ms）。保存后即可在默认模型与
                Per-Agent 配置中选择。
              </span>
            </p>
          ) : (
            <div className="note note-error" role="alert" data-testid="custom-test-result">
              <span>
                <span className="note-mark">✗</span> {TEST_CODE_LABEL[test.data.code ?? "UNKNOWN"] ?? "测试失败"}
                {test.data.detail !== undefined ? (
                  <details className="details-block" style={{ marginTop: "var(--s-2)" }}>
                    <summary>详细信息</summary>
                    <div className="details-body mono">{test.data.detail}</div>
                  </details>
                ) : null}
              </span>
            </div>
          )
        ) : null}
        {test.isError ? (
          <p className="form-error" role="alert">
            测试请求失败：{formatApiError(test.error)}
          </p>
        ) : null}
      </fieldset>

      <details className="advanced-block" data-testid="advanced-settings" open={advancedOpen}>
        <summary
          onClick={(event) => {
            event.preventDefault();
            setAdvancedOpen((value) => !value);
          }}
        >
          高级设置（协议 / 认证 / 发现路径 / 技术详情）
        </summary>
        <div className="advanced-body">
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
                {form.api === "anthropic-messages" ? "不勾选则用 Anthropic 原生的 x-api-key 头；多数公司网关需要 Bearer。" : "OpenAI 协议本就使用 Bearer，此项通常保持勾选。"}
              </span>
            </div>
          </div>
          <div className="field">
            <label htmlFor="cp-models-path">模型发现路径（可选）</label>
            <input
              id="cp-models-path"
              type="text"
              value={form.modelsPath}
              placeholder="自动（/v1/models 或 /models，按地址推导）"
              spellCheck={false}
              onChange={(event) => update("modelsPath", event.target.value)}
            />
            <span className="field-help">仅影响「获取可用模型」，不影响推理路径；网关目录在非标准位置时填写，如 /openai/v1/models</span>
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
            <span className="field-help">不能放 Authorization / x-api-key 等认证头，Key 请填在上方</span>
          </div>
          <div className="field">
            <label htmlFor="cp-provider-id">Provider ID（只读）</label>
            <input
              id="cp-provider-id"
              type="text"
              value={isEdit ? form.id : "保存时自动生成"}
              readOnly
              disabled={!isEdit}
              className="mono"
              data-testid="custom-provider-id"
            />
            <span className="field-help">系统内部唯一标识（模型规格写作 id/model-id），由服务端自动生成并保持不变</span>
          </div>
        </div>
      </details>

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
        {confirmDiscard ? (
          <span className="inline-confirm" role="group" aria-label="确认放弃未保存的修改">
            <span>有未保存的修改。</span>
            <button
              type="button"
              className="btn btn-small btn-danger"
              onClick={onCancel}
              data-testid="confirm-discard"
            >
              放弃修改
            </button>
            <button type="button" className="btn btn-small" onClick={() => setConfirmDiscard(false)}>
              继续编辑
            </button>
          </span>
        ) : (
          <button type="button" className="btn" onClick={requestCancel} disabled={save.isPending} data-testid="cancel-edit">
            取消
          </button>
        )}
        <button type="submit" className="btn btn-primary" disabled={save.isPending} data-testid="save-custom-provider">
          {save.isPending ? "保存中…" : isEdit ? "保存修改" : "保存提供商"}
        </button>
      </div>
    </form>
  );
}
