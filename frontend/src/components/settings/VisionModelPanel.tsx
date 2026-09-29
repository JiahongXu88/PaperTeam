import { useState } from "react";

import { ModelCombobox } from "../common/ModelCombobox.js";
import { ProviderCombobox } from "../common/ProviderCombobox.js";
import { useModelOptions, useSaveModelSettings, useTestModelConnection } from "../../hooks/queries.js";
import { formatApiError, formatApiErrorDetail } from "../../utils/errors.js";
import type {
  ModelOptionView,
  ModelProviderOptionView,
  ModelSettingsView,
} from "../../types/api.js";

/**
 * Vision 模型配置（M10.2，单 slot 极简面板）。
 *
 * 默认「继承默认」（默认模型 image-capable 时自动复用；否则图片分析不可用，
 * 状态如实呈现）；选择「自定义」后仅列出目录声明 image input 的模型
 * （能力判定唯一依据 = catalog input 元数据，不按名字猜）。
 * 保存走 PUT /api/settings/model 的 visionModel 字段（null = 清除）。
 */

type Mode = "inherit" | "custom";

function isImageCapable(model: ModelOptionView): boolean {
  return Array.isArray(model.input) && model.input.includes("image");
}

export function VisionModelPanel({ settings }: { settings: ModelSettingsView }) {
  const vision = settings.vision;
  const saved = vision?.savedModel;
  const [mode, setMode] = useState<Mode>(saved !== undefined ? "custom" : "inherit");
  const savedProvider = saved?.split("/")[0] ?? settings.provider ?? "";
  const savedModelId = saved !== undefined ? saved.slice(saved.indexOf("/") + 1) : "";
  const [providerId, setProviderId] = useState(savedProvider);
  const [modelId, setModelId] = useState(savedModelId);
  const save = useSaveModelSettings();
  const test = useTestModelConnection();

  const providersQuery = useModelOptions();
  const modelsQuery = useModelOptions(mode === "custom" && providerId !== "" ? providerId : undefined);
  const providers: ModelProviderOptionView[] | undefined =
    providersQuery.data !== undefined && "providers" in providersQuery.data
      ? providersQuery.data.providers
      : undefined;
  const allModels = modelsQuery.data !== undefined && "models" in modelsQuery.data ? modelsQuery.data.models : undefined;
  const models = allModels !== undefined ? allModels.filter(isImageCapable) : undefined;

  const defaultModelSpec = settings.savedModel ?? settings.model ?? "";
  const selectedSpec = mode === "custom" && providerId !== "" && modelId !== "" ? `${providerId}/${modelId}` : "";
  const dirty =
    mode === "custom"
      ? selectedSpec !== "" && selectedSpec !== saved
      : saved !== undefined;

  const handleSave = () => {
    if (defaultModelSpec === "") {
      return;
    }
    save.mutate({
      model: defaultModelSpec,
      ...(mode === "custom" && selectedSpec !== "" ? { visionModel: selectedSpec } : { visionModel: null }),
    });
  };

  return (
    <section className="settings-block" aria-label="Vision 模型配置" data-testid="vision-model-panel">
      <h2 className="panel-title">Vision 模型（图片分析）</h2>
      <p className="panel-sub">
        用于文献图片（PDF figure / 上传图片 / Notebook 图片输出）的视觉分析。
        默认继承默认模型——仅当默认模型支持图片输入时自动复用；否则需在此显式
        选择支持图片输入的模型（只列出目录声明 image input 的模型）。凭据按
        Provider 共用（在上方配置），此处不保存任何 Key。
      </p>
      <div className="agent-model-row">
        <div className="agent-model-row-head">
          <span className="agent-model-name">Vision Model</span>
          <select
            value={mode}
            onChange={(event) => {
              const next = event.target.value as Mode;
              setMode(next);
              if (next === "custom" && providerId === "") {
                setProviderId(settings.provider ?? "");
                setModelId("");
              }
              save.reset();
              test.reset();
            }}
            aria-label="Vision 模型来源"
            data-testid="vision-model-mode"
          >
            <option value="inherit">继承默认</option>
            <option value="custom">自定义</option>
          </select>
        </div>
        {mode === "inherit" ? (
          <span className="field-help" data-testid="vision-model-effective">
            {vision?.source === "default_model" && vision.model !== undefined ? (
              <>
                复用默认模型：<span className="mono">{vision.model}</span>（目录已声明 image input）
              </>
            ) : vision?.source === "vision_setting" && vision.model !== undefined ? (
              <>
                显式 Vision 模型：<span className="mono">{vision.model}</span>
              </>
            ) : (
              <>图片分析当前不可用：{vision?.detail ?? "未配置任何模型"}</>
            )}
          </span>
        ) : (
          <div className="agent-model-custom">
            <div className="field">
              <label htmlFor="vision-provider">Provider</label>
              <ProviderCombobox
                id="vision-provider"
                providers={providers}
                value={providerId}
                onChange={(next) => {
                  setProviderId(next);
                  setModelId("");
                  save.reset();
                  test.reset();
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="vision-model">Model（仅支持图片输入的模型）</label>
              <ModelCombobox
                id="vision-model"
                models={models}
                value={modelId}
                onChange={(next) => {
                  setModelId(next);
                  save.reset();
                  test.reset();
                }}
                disabled={providerId === ""}
                loading={providerId !== "" && models === undefined}
                emptyHint={
                  providerId === ""
                    ? "请先选择 Provider"
                    : models !== undefined && models.length === 0
                      ? "该提供商目录中没有声明 image input 的模型"
                      : "该提供商暂无模型目录"
                }
              />
            </div>
            <div className="form-actions">
              <button
                type="button"
                className="btn btn-small"
                onClick={() => selectedSpec !== "" && test.mutate({ model: selectedSpec })}
                disabled={selectedSpec === "" || test.isPending}
                data-testid="vision-model-test"
                title="用当前选择的 provider/model 发起一次最小调用（使用该 Provider 已保存的凭据；不保存）"
              >
                {test.isPending ? "测试中…" : "测试连接"}
              </button>
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
                    <span className="note-mark">✗</span> 测试失败：{test.data.detail?.slice(0, 160) ?? test.data.code}
                  </span>
                </p>
              )
            ) : null}
          </div>
        )}
      </div>
      <div className="form-actions settings-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleSave}
          disabled={!dirty || defaultModelSpec === "" || save.isPending}
          data-testid="save-vision-model"
          title={defaultModelSpec === "" ? "请先保存默认模型" : "保存 Vision 模型配置"}
        >
          {save.isPending ? "保存中…" : "保存 Vision 配置"}
        </button>
      </div>
      {save.isError ? (
        <p className="form-error" role="alert" data-testid="vision-model-save-error">
          保存失败：{formatApiError(save.error)}
          <details className="details-block" style={{ marginTop: "var(--s-2)" }}>
            <summary>详细信息</summary>
            <div className="details-body mono">{formatApiErrorDetail(save.error)}</div>
          </details>
        </p>
      ) : null}
      {save.isSuccess ? (
        <p className="note note-success" role="status" data-testid="vision-model-save-success">
          <span>
            <span className="note-mark">✓</span> 已保存 Vision 模型配置。
          </span>
        </p>
      ) : null}
    </section>
  );
}
