import { useEffect, useState } from "react";

import { ErrorState, Loading } from "../components/common/StateViews.js";
import { PageHeader } from "../components/common/PageHeader.js";
import { useNetworkSettings, useSaveNetworkSettings, useTestNetworkSettings } from "../hooks/queries.js";
import { formatApiError, formatApiErrorDetail } from "../utils/errors.js";
import type {
  NetworkCheckStatus,
  NetworkCheckView,
  NetworkProxyInput,
  NetworkProxyProtocol,
  NetworkSettingsView,
} from "../types/api.js";

/**
 * 设置 → 网络设置（M13.8）：学术检索 / 文献元数据核验 / 合法全文下载的出口代理。
 *
 * 产品边界（页面文案明确说明）：只作用于学术服务访问，不影响模型 API 连接。
 * 配置非敏感（不接受账号密码），保存在本机 PaperTeam 数据目录；保存后对后续学术请求
 * 生效，不中断正在执行的任务。「测试连接」用当前表单值（可未保存）逐项探测并分类。
 */

const SOURCE_LABEL: Record<NetworkSettingsView["source"], string> = {
  environment: "环境变量 PAPERTEAM_RESEARCH_PROXY_URL",
  stored: "本地保存",
  none: "未配置（直连）",
};

const PROTOCOL_OPTIONS: ReadonlyArray<{ value: NetworkProxyProtocol; label: string; hint: string }> = [
  { value: "http", label: "HTTP", hint: "HTTP CONNECT 隧道代理（Clash / mihomo 等的混合端口可直接使用）" },
  { value: "socks5", label: "SOCKS5（实验性）", hint: "SOCKS5 代理；Node 侧支持标记为实验性，优先选择 HTTP" },
];

const STATUS_LABEL: Record<NetworkCheckStatus, { text: string; tone: "ok" | "warn" | "danger" | "muted" }> = {
  ok: { text: "可访问", tone: "ok" },
  rate_limited: { text: "限流", tone: "warn" },
  http_error: { text: "HTTP 错误", tone: "danger" },
  timeout: { text: "超时", tone: "danger" },
  proxy_unreachable: { text: "代理不可连接", tone: "danger" },
  proxy_rejected: { text: "代理拒绝", tone: "danger" },
  network_error: { text: "网络错误", tone: "danger" },
  not_pdf: { text: "非 PDF", tone: "danger" },
  skipped: { text: "未探测", tone: "muted" },
};

export function NetworkSettingsPage() {
  const settingsQuery = useNetworkSettings();

  if (settingsQuery.isPending) {
    return (
      <div className="page">
        <PageHeader level={2} title="网络设置" />
        <Loading label="加载网络设置…" />
      </div>
    );
  }
  if (settingsQuery.isError) {
    return (
      <div className="page">
        <PageHeader level={2} title="网络设置" />
        <ErrorState
          title="网络设置加载失败"
          message={formatApiError(settingsQuery.error)}
          detail={formatApiErrorDetail(settingsQuery.error)}
          onRetry={() => void settingsQuery.refetch()}
        />
      </div>
    );
  }
  return <NetworkSettingsBody settings={settingsQuery.data} />;
}

function initialForm(settings: NetworkSettingsView): { enabled: boolean; protocol: NetworkProxyProtocol; host: string; port: string } {
  const seed = settings.saved ?? (settings.effective !== null ? { ...settings.effective, enabled: true } : null);
  return {
    enabled: seed?.enabled ?? false,
    protocol: seed?.protocol ?? "http",
    host: seed?.host ?? "",
    port: seed !== null ? String(seed.port) : "",
  };
}

function NetworkSettingsBody({ settings }: { settings: NetworkSettingsView }) {
  const [form, setForm] = useState(() => initialForm(settings));
  const save = useSaveNetworkSettings();
  const test = useTestNetworkSettings();

  // 保存成功后服务端回传新状态；表单与之对齐（例如端口字符串归一化）
  useEffect(() => {
    if (save.isSuccess && save.data !== undefined) {
      setForm(initialForm(save.data));
    }
  }, [save.isSuccess, save.data]);

  const portNumber = Number.parseInt(form.port.trim(), 10);
  const portValid = Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;
  const hostValid = form.host.trim() !== "";
  const formValid = !form.enabled || (hostValid && portValid);

  const payload = (): NetworkProxyInput => ({
    enabled: form.enabled,
    protocol: form.protocol,
    host: form.host.trim() === "" ? "127.0.0.1" : form.host.trim(),
    port: portValid ? portNumber : 7890,
  });

  const update = (patch: Partial<typeof form>) => {
    setForm((current) => ({ ...current, ...patch }));
    save.reset();
    test.reset();
  };

  return (
    <div className="page">
      <PageHeader
        level={2}
        title="网络设置"
        sub="学术检索与文献下载的出口代理。仅作用于学术检索、文献元数据核验和合法全文下载，不影响模型 API 连接。"
      />

      <div className="settings-grid">
        <section className="settings-block" aria-label="当前生效配置">
          <h2 className="panel-title">当前生效配置</h2>
          <dl className="kv settings-status">
            <div className="kv-row">
              <dt>学术网络</dt>
              <dd data-testid="network-effective">
                {settings.effective !== null ? (
                  <>
                    <span className="status status-tone-ok">代理</span> <span className="mono">{settings.effectiveUrl}</span>
                  </>
                ) : (
                  <span className="status status-tone-neutral">直连</span>
                )}
              </dd>
            </div>
            <div className="kv-row">
              <dt>生效来源</dt>
              <dd data-testid="network-source">{SOURCE_LABEL[settings.source]}</dd>
            </div>
            {settings.saved !== null ? (
              <div className="kv-row">
                <dt>本地保存</dt>
                <dd className="mono" data-testid="network-saved">
                  {settings.saved.enabled ? "启用" : "关闭"} · {settings.saved.protocol}://{settings.saved.host}:{settings.saved.port}
                </dd>
              </div>
            ) : null}
            <div className="kv-row">
              <dt>本次运行</dt>
              <dd className="muted">
                代理 {settings.routerStats.proxied} 次 · 直连 {settings.routerStats.direct} 次 · 旁路 {settings.routerStats.bypassed} 次
              </dd>
            </div>
          </dl>
          {settings.envOverride ? (
            <p className="note note-warn" data-testid="network-env-override" role="status">
              <span>当前由环境变量 PAPERTEAM_RESEARCH_PROXY_URL 提供（优先级更高）。仍可保存本地配置：在环境变量不存在时生效。</span>
            </p>
          ) : null}
          <div className="hitl-list">
            <h3>作用范围</h3>
            <ul>
              {settings.scope.appliesTo.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <h3>不受影响</h3>
            <ul>
              {settings.scope.notAppliedTo.map((item) => (
                <li key={item} className="muted">
                  {item}
                </li>
              ))}
            </ul>
            <p className="field-help">{settings.scope.bypass}。</p>
          </div>
        </section>

        <form
          className="settings-block settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (formValid) {
              save.mutate(payload());
            }
          }}
          data-testid="network-form"
        >
          <h2 className="panel-title">学术检索代理</h2>

          <div className="field">
            <label className="checkbox-row" htmlFor="network-proxy-enabled">
              <input
                id="network-proxy-enabled"
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => update({ enabled: event.target.checked })}
                data-testid="network-enabled"
              />
              <span>启用代理</span>
            </label>
            <span className="field-help">
              关闭时学术请求直连（与旧版本一致）。开启后只有学术检索、元数据核验与全文下载走代理；本机 / 内网地址始终直连。
            </span>
          </div>

          <div className="field">
            <label id="network-protocol-label">代理类型</label>
            <div className="segmented" role="radiogroup" aria-labelledby="network-protocol-label" data-testid="network-protocol">
              {PROTOCOL_OPTIONS.map((option) => (
                <label key={option.value} className="segmented-option" title={option.hint}>
                  <input
                    type="radio"
                    name="network-protocol"
                    value={option.value}
                    checked={form.protocol === option.value}
                    onChange={() => update({ protocol: option.value })}
                    data-testid={`network-protocol-${option.value}`}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </div>

          <div className="field">
            <label htmlFor="network-proxy-host">代理地址</label>
            <input
              id="network-proxy-host"
              type="text"
              value={form.host}
              onChange={(event) => update({ host: event.target.value })}
              placeholder="127.0.0.1"
              autoComplete="off"
              spellCheck={false}
              data-testid="network-host"
            />
            <span className="field-help">主机名或 IP；不要带 http:// 前缀、端口或账号信息（暂不支持需要认证的代理）。</span>
          </div>

          <div className="field">
            <label htmlFor="network-proxy-port">代理端口</label>
            <input
              id="network-proxy-port"
              type="text"
              inputMode="numeric"
              value={form.port}
              onChange={(event) => update({ port: event.target.value })}
              placeholder="7890"
              autoComplete="off"
              data-testid="network-port"
            />
            {form.enabled && form.port.trim() !== "" && !portValid ? (
              <span className="form-error" role="alert">
                端口必须是 1–65535 的整数
              </span>
            ) : (
              <span className="field-help">常见本地代理软件（Clash / mihomo）默认混合端口 7890。</span>
            )}
          </div>

          <div className="form-actions settings-actions">
            <button
              type="button"
              className="btn"
              onClick={() => test.mutate(payload())}
              disabled={!formValid || test.isPending}
              data-testid="network-test"
              title="用当前填写的配置探测代理与各学术服务（不保存；关闭开关时为直连对照）"
            >
              {test.isPending ? "测试中…" : "测试连接"}
            </button>
            <button type="submit" className="btn btn-primary" disabled={!formValid || save.isPending} data-testid="network-save">
              {save.isPending ? "保存中…" : "保存配置"}
            </button>
          </div>

          {save.isError ? (
            <p className="form-error" role="alert" data-testid="network-save-error">
              保存失败：{formatApiError(save.error)}
            </p>
          ) : null}
          {save.isSuccess ? (
            <p className="note note-success" role="status" data-testid="network-save-success">
              <span>
                <span className="note-mark">✓</span> 已保存
                {settings.envOverride
                  ? "。当前进程仍以环境变量为准，本地配置在环境变量不存在时生效"
                  : "，后续的学术检索 / 全文下载请求立即使用新配置（正在执行的请求不受影响）"}
                。
              </span>
            </p>
          ) : null}
          {test.isError ? (
            <p className="form-error" role="alert" data-testid="network-test-error">
              测试失败：{formatApiError(test.error)}
            </p>
          ) : null}
          {test.data !== undefined ? <TestResultView result={test.data} /> : null}
        </form>
      </div>
    </div>
  );
}

function TestResultView({ result }: { result: NonNullable<ReturnType<typeof useTestNetworkSettings>["data"]> }) {
  return (
    <div data-testid="network-test-result" className="network-test-result">
      {result.ok ? (
        <p className="note note-success" role="status">
          <span>
            <span className="note-mark">✓</span> {result.summary}
          </span>
        </p>
      ) : (
        <p className="note note-warn" role="status">
          <span>{result.summary}</span>
        </p>
      )}
      <ul className="source-list" data-testid="network-test-checks">
        {result.checks.map((check) => (
          <CheckRow key={check.id} check={check} />
        ))}
      </ul>
      <p className="field-help">
        模式：{result.mode === "proxy" ? `代理 ${result.proxy ?? ""}` : "直连"} · 用时 {Math.round(result.durationMs / 100) / 10}s。
        OpenAlex / Semantic Scholar 的匿名限流按出口 IP 计，与代理是否可用无关。
      </p>
    </div>
  );
}

function CheckRow({ check }: { check: NetworkCheckView }) {
  const status = STATUS_LABEL[check.status];
  return (
    <li className="source-row" data-testid={`network-check-${check.id}`}>
      <div className="source-row-main">
        <span className="source-row-title">
          {check.label} <span className="muted mono">{check.target}</span>
        </span>
        <span className="source-row-meta">
          <span className={`status status-tone-${status.tone}`} data-testid={`network-check-status-${check.id}`}>
            {status.text}
          </span>
          {check.httpStatus !== undefined ? <span className="chip">HTTP {check.httpStatus}</span> : null}
          {check.latencyMs !== undefined ? <span className="chip">{check.latencyMs}ms</span> : null}
          {check.throughputKBps !== undefined ? <span className="chip">{check.throughputKBps} KB/s</span> : null}
        </span>
      </div>
      <p className="field-help">{check.detail}</p>
    </li>
  );
}
