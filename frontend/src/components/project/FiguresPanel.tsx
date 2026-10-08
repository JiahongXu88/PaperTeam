import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ErrorState, Loading } from "../common/StateViews.js";
import { getProject } from "../../api/projects.js";
import {
  generateFigure,
  generatedFigurePdfUrl,
  getFigureDataset,
  insertFigure,
  listFigureDatasets,
  listFigures,
  listManuscriptSections,
  validateFigureSpec,
  type CaptionValidationView,
  type DatasetCandidateView,
  type DatasetPayloadView,
  type FigureView,
  type InsertResultView,
} from "../../api/figures.js";
import { formatApiError, formatApiErrorDetail } from "../../utils/errors.js";
import { formatDateTime } from "../../utils/format.js";

/**
 * 学术图表工作区（M12 Batch 3 · C4/C5）。
 *
 * 三段：数据图构建器（结构化数据集 → PlotSpec → pgfplots 矢量 PDF）/
 * 方法图构建器（DiagramSpec → TikZ）/ 图表库（lineage + 预览 + 受控插入论文）。
 *
 * 语义红线（与 backend 一致）：
 * - 数据必须来自项目内已解析的结构化数据集（sourceId+blockId 锚）或显式
 *   manual 标注——不存在「让模型编数据画图」的入口；
 * - 插入是受控 action（append/replace）：已有论文项目只能 replace（修订安全
 *   边界）；caption 定量声明经确定性守卫（violation 拦截 / unverified 需作者
 *   确认）。
 */

const PLOT_TYPE_LABELS: Record<string, string> = {
  line: "折线图",
  bar: "柱状图",
  grouped_bar: "分组柱状图",
  scatter: "散点图",
};

const ORIGIN_CLASS_META: Record<FigureView["dataOriginClass"], { label: string; tone: string }> = {
  source_parsed: { label: "来源数据", tone: "ok" },
  manual: { label: "手动数据", tone: "warn" },
  diagram: { label: "方法图", tone: "neutral" },
};

function CaptionValidationBadge({ validation }: { validation: CaptionValidationView | undefined }) {
  if (validation === undefined) {
    return null;
  }
  const meta =
    validation.verdict === "pass"
      ? { label: "题注校验通过", tone: "ok" }
      : validation.verdict === "unverified"
        ? { label: "需作者确认", tone: "warn" }
        : { label: "数据不支持", tone: "danger" };
  return (
    <span className={`chip chip-tone-${meta.tone}`} data-testid="caption-validation-badge">
      {meta.label}
    </span>
  );
}

function CaptionIssues({ validation }: { validation: CaptionValidationView }) {
  if (validation.issues.length === 0) {
    return <p className="muted">caption 无定量声明或全部有数据支撑。</p>;
  }
  return (
    <ul className="note-list" data-testid="caption-validation-issues">
      {validation.issues.map((issue, index) => (
        <li key={index} className={issue.level === "violation" ? "run-error" : issue.level === "unverified" ? "note-warn-line" : "muted"}>
          [{issue.claim}] {issue.message}
        </li>
      ))}
    </ul>
  );
}

// ---- 数据图构建器 ----

interface PlotBuilderState {
  datasetKey: string;
  plotType: "line" | "bar" | "grouped_bar" | "scatter";
  xColumn: string;
  seriesColumns: string[];
  xLabel: string;
  yLabel: string;
  title: string;
  caption: string;
  legend: boolean;
  missingPolicy: "reject" | "skip_row";
}

function PlotBuilder({
  projectId,
  datasets,
  onGenerated,
}: {
  projectId: string;
  datasets: DatasetCandidateView[];
  onGenerated: () => void;
}) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<PlotBuilderState>({
    datasetKey: "",
    plotType: "line",
    xColumn: "",
    seriesColumns: [],
    xLabel: "",
    yLabel: "",
    title: "",
    caption: "",
    legend: true,
    missingPolicy: "reject",
  });
  const [payload, setPayload] = useState<DatasetPayloadView | null>(null);
  const [payloadError, setPayloadError] = useState<string | null>(null);
  const [validation, setValidation] = useState<
    { ok: true; captionValidation?: CaptionValidationView } | { ok: false; errors: string[] } | null
  >(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionDetail, setActionDetail] = useState<string | null>(null);

  const loadDataset = useMutation({
    mutationFn: async (candidate: DatasetCandidateView) => getFigureDataset(projectId, candidate.sourceId, candidate.blockId),
    onSuccess: (loaded) => {
      setPayloadError(null);
      setPayload(loaded);
      setState((prev) => ({
        ...prev,
        xColumn: loaded.columns[0] ?? "",
        seriesColumns: loaded.columns.slice(1, 2),
      }));
    },
    onError: (error) => {
      setPayload(null);
      setPayloadError(formatApiError(error));
    },
  });

  const columns = payload?.columns ?? [];

  const buildSpec = () => {
    const candidate = datasets.find((entry) => `${entry.sourceId}::${entry.blockId}` === state.datasetKey);
    if (payload === null || candidate === undefined) {
      return null;
    }
    return {
      plotType: state.plotType,
      ...(state.title.trim() !== "" ? { title: state.title.trim() } : {}),
      ...(state.caption.trim() !== "" ? { caption: state.caption.trim() } : {}),
      data: {
        origin: { sourceId: candidate.sourceId, blockId: candidate.blockId },
        datasetHash: payload.datasetHash,
        x: [state.xColumn],
        series: state.seriesColumns.map((column) => ({ name: column, column })),
        missingPolicy: state.missingPolicy,
        inlineDataset: payload.inlineDataset,
      },
      axis: {
        ...(state.xLabel.trim() !== "" ? { xLabel: state.xLabel.trim() } : {}),
        ...(state.yLabel.trim() !== "" ? { yLabel: state.yLabel.trim() } : {}),
        legend: state.legend,
      },
    };
  };

  const validateSpec = useMutation({
    mutationFn: async () => {
      const spec = buildSpec();
      if (spec === null) {
        throw new Error("请先选择数据集");
      }
      return validateFigureSpec(projectId, "plot", spec);
    },
    onSuccess: (result) => {
      setActionError(null);
      setValidation(result);
    },
    onError: (error) => {
      setActionError(formatApiError(error));
      setActionDetail(formatApiErrorDetail(error) ?? null);
    },
  });

  const generate = useMutation({
    mutationFn: async () => {
      const spec = buildSpec();
      if (spec === null) {
        throw new Error("请先选择数据集");
      }
      return generateFigure(projectId, "plot", spec);
    },
    onSuccess: (result) => {
      setActionError(null);
      setActionDetail(null);
      setValidation(
        result.captionValidation !== undefined
          ? { ok: true, captionValidation: result.captionValidation }
          : null,
      );
      void queryClient.invalidateQueries({ queryKey: ["figures", projectId] });
      onGenerated();
    },
    onError: (error) => {
      setActionError(formatApiError(error));
      setActionDetail(formatApiErrorDetail(error) ?? null);
    },
  });

  const toggleSeries = (column: string) => {
    setState((prev) => ({
      ...prev,
      seriesColumns: prev.seriesColumns.includes(column)
        ? prev.seriesColumns.filter((entry) => entry !== column)
        : [...prev.seriesColumns, column],
    }));
  };

  return (
    <section className="panel section-block" data-testid="plot-builder">
      <div className="section-head">
        <h2>数据图</h2>
        <span className="muted">结构化数据集 → PlotSpec → pgfplots 矢量 PDF</span>
      </div>
      {datasets.length === 0 ? (
        <p className="panel-empty" data-testid="plot-builder-empty">
          还没有可用的结构化数据集——在「文献库」上传 CSV / XLSX / JSON（或解析含表格的 PDF）后回到这里。
        </p>
      ) : (
        <div className="form-grid">
          <label>
            <span>数据集</span>
            <select
              value={state.datasetKey}
              data-testid="plot-dataset-select"
              onChange={(event) => {
                const key = event.target.value;
                setState((prev) => ({ ...prev, datasetKey: key }));
                setPayload(null);
                setValidation(null);
                const candidate = datasets.find((entry) => `${entry.sourceId}::${entry.blockId}` === key);
                if (candidate !== undefined) {
                  loadDataset.mutate(candidate);
                }
              }}
            >
              <option value="">选择数据集…</option>
              {datasets.map((dataset) => (
                <option key={`${dataset.sourceId}::${dataset.blockId}`} value={`${dataset.sourceId}::${dataset.blockId}`}>
                  {dataset.fileName} · {dataset.kind === "table" ? "表格块" : "记录游程"} · {dataset.rowCount} 行
                  {dataset.locationHint !== undefined ? ` · ${dataset.locationHint}` : ""}
                  {dataset.sourceRole === "reference" ? " · benchmark 参照" : ""}
                </option>
              ))}
            </select>
          </label>
          {loadDataset.isPending ? <p className="muted">加载数据集…</p> : null}
          {payloadError !== null ? <p className="form-error">{payloadError}</p> : null}
          {payload !== null ? (
            <>
              <p className="muted" data-testid="plot-dataset-meta">
                列（{payload.columns.length}）：{payload.columns.join("、")}；行数 {payload.rowCount}；
                datasetHash <code>{payload.datasetHash.slice(0, 12)}…</code>
                {payload.caption !== undefined ? `；来源题注：${payload.caption.slice(0, 80)}` : ""}
              </p>
              <div className="form-row-3">
                <label>
                  <span>图型</span>
                  <select
                    value={state.plotType}
                    data-testid="plot-type-select"
                    onChange={(event) =>
                      setState((prev) => ({ ...prev, plotType: event.target.value as PlotBuilderState["plotType"] }))
                    }
                  >
                    {Object.entries(PLOT_TYPE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>X 列{state.plotType === "bar" || state.plotType === "grouped_bar" ? "（类目）" : "（数值）"}</span>
                  <select
                    value={state.xColumn}
                    data-testid="plot-x-select"
                    onChange={(event) => setState((prev) => ({ ...prev, xColumn: event.target.value }))}
                  >
                    {columns.map((column) => (
                      <option key={column} value={column}>
                        {column}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>缺失值策略</span>
                  <select
                    value={state.missingPolicy}
                    data-testid="plot-missing-select"
                    onChange={(event) =>
                      setState((prev) => ({ ...prev, missingPolicy: event.target.value as PlotBuilderState["missingPolicy"] }))
                    }
                  >
                    <option value="reject">reject（有缺失即拒绝）</option>
                    <option value="skip_row">skip_row（跳过缺失行）</option>
                  </select>
                </label>
              </div>
              <fieldset className="form-section">
                <legend>
                  Series（数值列，{state.seriesColumns.length} 个；来源：{columns.length} 列）
                </legend>
                <div className="chip-row" data-testid="plot-series-list">
                  {columns.map((column) => (
                    <label key={column} className="chip-select">
                      <input
                        type="checkbox"
                        checked={state.seriesColumns.includes(column)}
                        onChange={() => toggleSeries(column)}
                      />
                      {column}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="form-row-3">
                <label>
                  <span>X 轴标题</span>
                  <input
                    value={state.xLabel}
                    data-testid="plot-xlabel"
                    onChange={(event) => setState((prev) => ({ ...prev, xLabel: event.target.value }))}
                    placeholder="如 epoch / method"
                  />
                </label>
                <label>
                  <span>Y 轴标题</span>
                  <input
                    value={state.yLabel}
                    data-testid="plot-ylabel"
                    onChange={(event) => setState((prev) => ({ ...prev, yLabel: event.target.value }))}
                    placeholder="如 HOTA (%)"
                  />
                </label>
                <label>
                  <span>图内标题</span>
                  <input
                    value={state.title}
                    data-testid="plot-title"
                    onChange={(event) => setState((prev) => ({ ...prev, title: event.target.value }))}
                    placeholder="可选"
                  />
                </label>
              </div>
              <label>
                <span>Caption（题注；数值声明会经确定性守卫校验）</span>
                <textarea
                  value={state.caption}
                  data-testid="plot-caption"
                  rows={2}
                  onChange={(event) => setState((prev) => ({ ...prev, caption: event.target.value }))}
                  placeholder="如：HOTA 随训练轮次的收敛曲线（数据：experiment_runs.csv）"
                />
              </label>
              <label className="chip-select">
                <input
                  type="checkbox"
                  checked={state.legend}
                  onChange={(event) => setState((prev) => ({ ...prev, legend: event.target.checked }))}
                />
                显示图例（多 series 建议）
              </label>
              {validation !== null ? (
                <div className="note note-info" data-testid="plot-validation-result">
                  <CaptionValidationBadge validation={"captionValidation" in validation ? validation.captionValidation : undefined} />
                  {validation.ok ? (
                    <CaptionIssues validation={validation.captionValidation ?? { verdict: "pass", issues: [] }} />
                  ) : (
                    <ul>
                      {validation.errors.map((error, index) => (
                        <li key={index} className="run-error">
                          {error}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
              {actionError !== null ? (
                <p className="form-error" role="alert" data-testid="plot-action-error">
                  {actionError}
                  {actionDetail !== null ? <span className="muted prewrap">（{actionDetail}）</span> : null}
                </p>
              ) : null}
              <div className="btn-row">
                <button
                  type="button"
                  className="btn"
                  data-testid="plot-validate"
                  disabled={payload === null || state.seriesColumns.length === 0 || validateSpec.isPending}
                  onClick={() => validateSpec.mutate()}
                >
                  校验 Spec
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  data-testid="plot-generate"
                  disabled={payload === null || state.seriesColumns.length === 0 || generate.isPending}
                  onClick={() => generate.mutate()}
                >
                  {generate.isPending ? "生成中…（xelatex 编译）" : "生成图表"}
                </button>
              </div>
            </>
          ) : null}
        </div>
      )}
    </section>
  );
}

// ---- 方法图构建器 ----

interface DiagramNodeDraft {
  id: string;
  label: string;
  group: string;
  role: "stage" | "annotation" | "left" | "right";
}

interface DiagramEdgeDraft {
  from: string;
  to: string;
  label: string;
}

function DiagramBuilder({
  projectId,
  onGenerated,
}: {
  projectId: string;
  onGenerated: () => void;
}) {
  const queryClient = useQueryClient();
  const [layout, setLayout] = useState<"vertical" | "horizontal">("vertical");
  const [variant, setVariant] = useState<"pipeline" | "comparison">("pipeline");
  const [title, setTitle] = useState("");
  const [nodes, setNodes] = useState<DiagramNodeDraft[]>([
    { id: "input", label: "输入视频", group: "", role: "stage" },
    { id: "detector", label: "检测器\n(YOLO)", group: "", role: "stage" },
    { id: "tracker", label: "跟踪器", group: "", role: "stage" },
  ]);
  const [edges, setEdges] = useState<DiagramEdgeDraft[]>([
    { from: "input", to: "detector", label: "" },
    { from: "detector", to: "tracker", label: "" },
  ]);
  const [validation, setValidation] = useState<{ ok: true } | { ok: false; errors: string[] } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionDetail, setActionDetail] = useState<string | null>(null);

  const buildSpec = () => {
    const groups = [
      ...new Set(nodes.map((node) => node.group).filter((group) => group.trim() !== "")),
    ].map((id) => ({ id }));
    return {
      layout,
      variant,
      ...(title.trim() !== "" ? { title: title.trim() } : {}),
      nodes: nodes.map((node) => ({
        id: node.id.trim(),
        label: node.label,
        ...(node.group.trim() !== "" ? { group: node.group.trim() } : {}),
        role: node.role,
      })),
      edges: edges
        .filter((edge) => edge.from.trim() !== "" && edge.to.trim() !== "")
        .map((edge) => ({
          from: edge.from.trim(),
          to: edge.to.trim(),
          ...(edge.label.trim() !== "" ? { label: edge.label.trim() } : {}),
        })),
      ...(groups.length > 0 ? { groups } : {}),
    };
  };

  const validateSpec = useMutation({
    mutationFn: () => validateFigureSpec(projectId, "diagram", buildSpec()),
    onSuccess: (result) => {
      setActionError(null);
      setValidation(result.ok ? { ok: true } : { ok: false, errors: result.errors });
    },
    onError: (error) => {
      setActionError(formatApiError(error));
      setActionDetail(formatApiErrorDetail(error) ?? null);
    },
  });

  const generate = useMutation({
    mutationFn: () => generateFigure(projectId, "diagram", buildSpec()),
    onSuccess: () => {
      setActionError(null);
      setActionDetail(null);
      void queryClient.invalidateQueries({ queryKey: ["figures", projectId] });
      onGenerated();
    },
    onError: (error) => {
      setActionError(formatApiError(error));
      setActionDetail(formatApiErrorDetail(error) ?? null);
    },
  });

  const updateNode = (index: number, patch: Partial<DiagramNodeDraft>) => {
    setNodes((prev) => prev.map((node, i) => (i === index ? { ...node, ...patch } : node)));
  };
  const updateEdge = (index: number, patch: Partial<DiagramEdgeDraft>) => {
    setEdges((prev) => prev.map((edge, i) => (i === index ? { ...edge, ...patch } : edge)));
  };

  return (
    <section className="panel section-block" data-testid="diagram-builder">
      <div className="section-head">
        <h2>方法图</h2>
        <span className="muted">DiagramSpec（nodes / edges / groups）→ TikZ 流程图</span>
      </div>
      <div className="form-row-3">
        <label>
          <span>布局</span>
          <select value={layout} data-testid="diagram-layout" onChange={(event) => setLayout(event.target.value as "vertical" | "horizontal")}>
            <option value="vertical">纵向</option>
            <option value="horizontal">横向</option>
          </select>
        </label>
        <label>
          <span>模板</span>
          <select value={variant} data-testid="diagram-variant" onChange={(event) => setVariant(event.target.value as "pipeline" | "comparison")}>
            <option value="pipeline">流水线 / 架构</option>
            <option value="comparison">双列对比</option>
          </select>
        </label>
        <label>
          <span>图内标题</span>
          <input value={title} data-testid="diagram-title" onChange={(event) => setTitle(event.target.value)} placeholder="可选" />
        </label>
      </div>
      <fieldset className="form-section">
        <legend>节点（{nodes.length}）</legend>
        {nodes.map((node, index) => (
          <div key={index} className="form-row-4">
            <input
              value={node.id}
              aria-label={`节点 ${index + 1} id`}
              onChange={(event) => updateNode(index, { id: event.target.value })}
              placeholder="id（slug）"
            />
            <input
              value={node.label}
              aria-label={`节点 ${index + 1} label`}
              onChange={(event) => updateNode(index, { label: event.target.value })}
              placeholder="标签（可多行）"
            />
            <input
              value={node.group}
              aria-label={`节点 ${index + 1} group`}
              onChange={(event) => updateNode(index, { group: event.target.value })}
              placeholder="分组（可选）"
            />
            <select
              value={node.role}
              aria-label={`节点 ${index + 1} role`}
              onChange={(event) => updateNode(index, { role: event.target.value as DiagramNodeDraft["role"] })}
            >
              {variant === "comparison" ? (
                <>
                  <option value="left">left（左侧）</option>
                  <option value="right">right（右侧）</option>
                </>
              ) : (
                <>
                  <option value="stage">stage（主流水线）</option>
                  <option value="annotation">annotation（侧注释）</option>
                </>
              )}
            </select>
            <button type="button" className="btn btn-small" aria-label={`删除节点 ${index + 1}`} onClick={() => setNodes((prev) => prev.filter((_, i) => i !== index))}>
              删除
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-small"
          data-testid="diagram-add-node"
          onClick={() =>
            setNodes((prev) => [...prev, { id: "", label: "", group: "", role: variant === "comparison" ? "left" : "stage" }])
          }
        >
          + 添加节点
        </button>
      </fieldset>
      <fieldset className="form-section">
        <legend>连接（{edges.length}；DAG——回边会被拒绝）</legend>
        {edges.map((edge, index) => (
          <div key={index} className="form-row-4">
            <input
              value={edge.from}
              aria-label={`连接 ${index + 1} from`}
              onChange={(event) => updateEdge(index, { from: event.target.value })}
              placeholder="from"
            />
            <input
              value={edge.to}
              aria-label={`连接 ${index + 1} to`}
              onChange={(event) => updateEdge(index, { to: event.target.value })}
              placeholder="to"
            />
            <input
              value={edge.label}
              aria-label={`连接 ${index + 1} label`}
              onChange={(event) => updateEdge(index, { label: event.target.value })}
              placeholder="边标签（可选）"
            />
            <button type="button" className="btn btn-small" aria-label={`删除连接 ${index + 1}`} onClick={() => setEdges((prev) => prev.filter((_, i) => i !== index))}>
              删除
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-small"
          data-testid="diagram-add-edge"
          onClick={() => setEdges((prev) => [...prev, { from: "", to: "", label: "" }])}
        >
          + 添加连接
        </button>
      </fieldset>
      {validation !== null && !validation.ok ? (
        <ul data-testid="diagram-validation-errors">
          {validation.errors.map((error, index) => (
            <li key={index} className="run-error">
              {error}
            </li>
          ))}
        </ul>
      ) : null}
      {actionError !== null ? (
        <p className="form-error" role="alert" data-testid="diagram-action-error">
          {actionError}
          {actionDetail !== null ? <span className="muted prewrap">（{actionDetail}）</span> : null}
        </p>
      ) : null}
      <div className="btn-row">
        <button type="button" className="btn" data-testid="diagram-validate" disabled={validateSpec.isPending} onClick={() => validateSpec.mutate()}>
          校验 Spec
        </button>
        <button
          type="button"
          className="btn btn-primary"
          data-testid="diagram-generate"
          disabled={nodes.length === 0 || generate.isPending}
          onClick={() => generate.mutate()}
        >
          {generate.isPending ? "生成中…（TikZ 编译）" : "生成方法图"}
        </button>
      </div>
    </section>
  );
}

// ---- 插入表单 ----

function InsertForm({
  projectId,
  figure,
  sections,
  existingPaper,
  onDone,
  onClose,
}: {
  projectId: string;
  figure: FigureView;
  sections: Array<{ id: string; title: string; file: string; exists: boolean }>;
  existingPaper: boolean;
  onDone: () => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"append" | "replace">(existingPaper ? "replace" : "append");
  const [sectionId, setSectionId] = useState("");
  const [file, setFile] = useState("");
  const [label, setLabel] = useState("");
  const [caption, setCaption] = useState(figure.caption);
  const [referenceSentence, setReferenceSentence] = useState("");
  const [replaceLabel, setReplaceLabel] = useState("");
  const [confirmUnverified, setConfirmUnverified] = useState(false);
  const [result, setResult] = useState<InsertResultView | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionDetail, setActionDetail] = useState<string | null>(null);

  const insert = useMutation({
    mutationFn: () =>
      insertFigure(projectId, {
        figId: figure.figId,
        mode,
        ...(mode === "append" && sectionId !== "" ? { sectionId } : {}),
        ...(file.trim() !== "" ? { file: file.trim() } : {}),
        ...(mode === "append" && label.trim() !== "" ? { label: label.trim() } : {}),
        caption: caption.trim(),
        ...(mode === "append" && referenceSentence.trim() !== "" ? { referenceSentence: referenceSentence.trim() } : {}),
        ...(mode === "replace" && replaceLabel.trim() !== "" ? { replaceLabel: replaceLabel.trim() } : {}),
        ...(confirmUnverified ? { confirmUnverified: true } : {}),
      }),
    onSuccess: (insertion) => {
      setResult(insertion);
      setActionError(null);
      setActionDetail(null);
      onDone();
    },
    onError: (error) => {
      setActionError(formatApiError(error));
      setActionDetail(formatApiErrorDetail(error) ?? null);
    },
  });

  return (
    <div className="insert-form panel-inner" data-testid="figure-insert-form">
      <div className="section-head">
        <h3>插入论文：{figure.figId}</h3>
        <button type="button" className="btn btn-small" onClick={onClose}>
          收起
        </button>
      </div>
      {existingPaper ? (
        <p className="note note-warn">
          <span>已有论文项目：只支持 replace（受控替换既有图——label 与位置保持不变，正文 \ref 全部继续解析）；新增图表须经修订工作流的获批 action。</span>
        </p>
      ) : null}
      <div className="form-row-2">
        <label>
          <span>模式</span>
          <select value={mode} data-testid="insert-mode" onChange={(event) => setMode(event.target.value as "append" | "replace")}>
            <option value="append">append（章节末尾追加新图环境）</option>
            <option value="replace" disabled={!existingPaper && figure.insertedIn === undefined && replaceLabel.trim() === ""}>
              replace（替换既有 figure 环境）
            </option>
          </select>
        </label>
        {mode === "append" && !existingPaper ? (
          <label>
            <span>目标章节</span>
            <select value={sectionId} data-testid="insert-section" onChange={(event) => setSectionId(event.target.value)}>
              <option value="">选择章节…</option>
              {sections.map((section) => (
                <option key={section.id} value={section.id} disabled={!section.exists}>
                  {section.title}（{section.file}）{section.exists ? "" : "· 未生成"}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label>
            <span>目标文件（相对 manuscript/；须在 \input 文档图内）</span>
            <input value={file} data-testid="insert-file" onChange={(event) => setFile(event.target.value)} placeholder={existingPaper ? "如 sections/results.tex 或 main.tex" : "可选：默认按章节推导"} />
          </label>
        )}
      </div>
      {mode === "replace" ? (
        <label>
          <span>替换目标的 figure label（保留原名；正文 \ref 不动）</span>
          <input value={replaceLabel} data-testid="insert-replace-label" onChange={(event) => setReplaceLabel(event.target.value)} placeholder="如 fig:architecture 或 fig:results-comparison" />
        </label>
      ) : (
        <label>
          <span>Label（缺省从 caption 派生；显式冲突会被拒绝）</span>
          <input value={label} data-testid="insert-label" onChange={(event) => setLabel(event.target.value)} placeholder="如 results-comparison（自动加 fig: 前缀）" />
        </label>
      )}
      <label>
        <span>Caption（最终题注；数值声明经确定性守卫）</span>
        <textarea value={caption} rows={2} data-testid="insert-caption" onChange={(event) => setCaption(event.target.value)} />
      </label>
      {mode === "append" ? (
        <label>
          <span>正文引用句（可选；须包含目标 \ref，追加在图环境后）</span>
          <input value={referenceSentence} data-testid="insert-reference" onChange={(event) => setReferenceSentence(event.target.value)} placeholder="如 实验结果如图~\ref{fig:xxx} 所示。" />
        </label>
      ) : null}
      <label className="chip-select">
        <input type="checkbox" checked={confirmUnverified} data-testid="insert-confirm-unverified" onChange={(event) => setConfirmUnverified(event.target.checked)} />
        我已核对 caption（UNVERIFIED 声明确认无误——作者确认将记录在案）
      </label>
      {actionError !== null ? (
        <p className="form-error" role="alert" data-testid="insert-error">
          {actionError}
          {actionDetail !== null ? <span className="muted prewrap">（{actionDetail}）</span> : null}
        </p>
      ) : null}
      {result !== null ? (
        <div className="note note-info" data-testid="insert-success">
          <span>
            已插入 {result.file}（label <code>{result.label}</code>
            {result.graphicxInjected ? "；main.tex 已补 graphicx" : ""}
            {result.previousPath !== undefined ? `；替换了原资产 ${result.previousPath}` : ""}）。
            编译 PDF 请到「论文产出」发起构建。
          </span>
          {result.captionValidation !== undefined ? <CaptionValidationBadge validation={result.captionValidation} /> : null}
        </div>
      ) : null}
      <button
        type="button"
        className="btn btn-primary"
        data-testid="insert-submit"
        disabled={insert.isPending || caption.trim() === "" || (mode === "append" && !existingPaper && sectionId === "" && file.trim() === "")}
        onClick={() => insert.mutate()}
      >
        {insert.isPending ? "插入中…" : mode === "append" ? "插入图表" : "替换图表"}
      </button>
    </div>
  );
}

// ---- 图表库 ----

function FigureLibrary({
  projectId,
  figures,
  sections,
  existingPaper,
}: {
  projectId: string;
  figures: FigureView[];
  sections: Array<{ id: string; title: string; file: string; exists: boolean }>;
  existingPaper: boolean;
}) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [insertId, setInsertId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const refresh = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: ["figures", projectId] }).then(() => undefined);

  return (
    <section className="panel section-block" data-testid="figure-library">
      <div className="section-head">
        <h2>图表库（{figures.length}）</h2>
        <span className="muted">figId = specHash 派生；同 spec 恒同图（确定性）</span>
      </div>
      {figures.length === 0 ? (
        <p className="panel-empty" data-testid="figure-library-empty">
          还没有生成图表——用上方构建器从真实数据生成第一张图。
        </p>
      ) : (
        <div className="gutter-list">
          {figures.map((figure) => {
            const origin = ORIGIN_CLASS_META[figure.dataOriginClass];
            return (
              <div key={figure.figId} className="gutter-row" data-testid="figure-row">
                <div className="gutter-body">
                  <span className="run-title">
                    <code>{figure.figId}</code>
                    <span className={`chip chip-tone-${origin.tone}`}>{origin.label}</span>
                    {figure.kind === "plot" && figure.plotType !== undefined ? (
                      <span className="chip">{PLOT_TYPE_LABELS[figure.plotType] ?? figure.plotType}</span>
                    ) : (
                      <span className="chip">TikZ 方法图</span>
                    )}
                    {figure.semantic !== undefined ? <span className="chip">{figure.semantic === "ablation" ? "消融" : "基准对比"}</span> : null}
                    {figure.stale !== undefined ? (
                      <span className="chip chip-tone-danger" title={figure.stale.detail}>
                        数据已过期
                      </span>
                    ) : null}
                    {figure.supersededBy !== undefined ? <span className="chip chip-tone-neutral">已被替换</span> : null}
                    {figure.insertedIn !== undefined ? (
                      <span className="chip chip-tone-ok" title={`label ${figure.insertedIn.label}`}>
                        已插入 {figure.insertedIn.file}
                      </span>
                    ) : null}
                  </span>
                  <span className="run-meta">
                    {figure.caption !== "" ? figure.caption.slice(0, 120) : "（无题注）"}
                  </span>
                  <span className="run-meta muted">
                    {figure.title !== undefined ? `${figure.title} · ` : ""}
                    {figure.dataOriginClass === "source_parsed"
                      ? `来源 ${figure.sourceId}#${figure.blockId}`
                      : figure.dataOriginClass === "manual"
                        ? "手动数据"
                        : "无数据集（方法图）"}
                    {" · "}
                    {formatDateTime(figure.createdAt)}
                    {figure.compiler !== undefined ? ` · 编译 ${figure.compiler.durationMs}ms` : ""}
                  </span>
                  {figure.stale !== undefined ? <span className="run-meta run-error">{figure.stale.detail}</span> : null}
                  {!figure.assetPresent ? <span className="run-meta run-error">PDF 资产缺失（请重新生成）</span> : null}
                </div>
                <div className="gutter-side btn-row-vertical">
                  <a
                    className="btn btn-small"
                    href={generatedFigurePdfUrl(projectId, figure.figId)}
                    target="_blank"
                    rel="noreferrer"
                    data-testid={`figure-open-${figure.figId}`}
                  >
                    打开 PDF
                  </a>
                  <button
                    type="button"
                    className="btn btn-small"
                    data-testid={`figure-preview-toggle-${figure.figId}`}
                    onClick={() => setPreviewId(previewId === figure.figId ? null : figure.figId)}
                  >
                    {previewId === figure.figId ? "收起预览" : "预览"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    data-testid={`figure-insert-toggle-${figure.figId}`}
                    disabled={!figure.assetPresent || figure.supersededBy !== undefined}
                    onClick={() => setInsertId(insertId === figure.figId ? null : figure.figId)}
                  >
                    插入论文
                  </button>
                </div>
                {previewId === figure.figId ? (
                  <div className="figure-preview" data-testid="figure-preview">
                    <iframe
                      src={generatedFigurePdfUrl(projectId, figure.figId)}
                      title={`${figure.figId} PDF 预览`}
                      style={{ width: "100%", height: "380px", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)" }}
                    />
                  </div>
                ) : null}
                {insertId === figure.figId ? (
                  <InsertForm
                    projectId={projectId}
                    figure={figure}
                    sections={sections}
                    existingPaper={existingPaper}
                    onDone={refresh}
                    onClose={() => setInsertId(null)}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ---- 主面板 ----

export function FiguresPanel({ projectId }: { projectId: string }) {
  const project = useQuery({
    queryKey: ["project", projectId, "meta-for-figures"],
    queryFn: ({ signal }) => getProject(projectId, signal),
  });
  const figures = useQuery({
    queryKey: ["figures", projectId, "list"],
    queryFn: ({ signal }) => listFigures(projectId, signal),
  });
  const datasets = useQuery({
    queryKey: ["figures", projectId, "datasets"],
    queryFn: ({ signal }) => listFigureDatasets(projectId, signal),
  });
  const sections = useQuery({
    queryKey: ["figures", projectId, "sections"],
    queryFn: ({ signal }) => listManuscriptSections(projectId, signal),
  });

  const existingPaper = useMemo(
    () =>
      project.data?.workflowKind === "existing_paper_improvement" ||
      project.data?.workflowKind === "existing_paper_review",
    [project.data?.workflowKind],
  );

  const refreshFigures = (): Promise<void> =>
    figures.refetch().then(() => undefined);

  if (project.isPending) {
    return <Loading label="加载图表工作区…" />;
  }
  if (project.isError || project.data === undefined) {
    return (
      <ErrorState
        title="图表工作区加载失败"
        message={formatApiError(project.error)}
        detail={formatApiErrorDetail(project.error)}
        onRetry={() => void project.refetch()}
      />
    );
  }

  return (
    <div className="panel-stack">
      <PlotBuilder projectId={projectId} datasets={datasets.data ?? []} onGenerated={refreshFigures} />
      <DiagramBuilder projectId={projectId} onGenerated={refreshFigures} />
      {figures.isPending ? (
        <Loading label="加载图表库…" />
      ) : figures.isError ? (
        <ErrorState
          title="图表库加载失败"
          message={formatApiError(figures.error)}
          detail={formatApiErrorDetail(figures.error)}
          onRetry={() => void figures.refetch()}
        />
      ) : (
        <FigureLibrary
          projectId={projectId}
          figures={figures.data ?? []}
          sections={sections.data ?? []}
          existingPaper={existingPaper}
        />
      )}
    </div>
  );
}
