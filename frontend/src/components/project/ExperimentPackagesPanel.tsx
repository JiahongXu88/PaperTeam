import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { ErrorState, Loading } from "../common/StateViews.js";
import {
  applyExperimentWorkflowUse,
  confirmExperimentGroups,
  confirmExperimentMetricEvidence,
  ensureExperimentPackagesUpgraded,
  EXPERIMENT_ARCHIVE_MAX_BYTES,
  experimentArchiveLimitMessage,
  editExperimentFile,
  getExperimentPackage,
  listExperimentPackages,
  queryExperimentObservations,
  requestExperimentUnderstanding,
  setExperimentScopeWorkflowUse,
  rebuildExperimentPackage,
  uploadExperimentPackage,
  type ExperimentRole,
  type ExperimentPackageView,
  type ExperimentSplitScopeView,
  type MetricObservationView,
} from "../../api/experimentPackages.js";
import { formatApiError } from "../../utils/errors.js";

/**
 * 实验数据工作台（M13.5 重构；M13.6 收敛用户操作成本）。
 *
 * 信息架构：上传实验包 →（v1 旧包自动升级）→ 用于当前论文（一次勾选提交
 * = 确认 + 授权）→ AI 辅助整理 / 范围明细 / 指标浏览（核对与高级操作）。
 * 面向不熟悉内部概念（Source/Group ID）的作者：
 * - 普通单范围包：上传解析后一次「用于本文写作」完成全部手续；
 * - 多范围包（Dev25/Confirmation13/Full38）：汇总勾选「哪些允许用于当前
 *   论文」一次提交；未勾选范围不进入工作流上下文（科研隔离边界不放宽）；
 * - 确认 ≠ 授权 ≠ Evidence Verification 的边界在 UI 与文案显式保留；
 * - 指标浏览走服务端过滤 + 分页（不把全部观测塞进 DOM、不自动选优）；
 * - AI 建议可逐条采纳（仍走确定性 editFile，不自动写事实）。
 */

const roles: ExperimentRole[] = ["main_result", "baseline_result", "ablation_result", "experiment_config", "training_log", "evaluation_log", "dataset_description", "figure_asset", "notebook", "source_code", "documentation", "unknown"];

const ROLE_LABEL: Record<ExperimentRole, string> = {
  main_result: "主结果",
  baseline_result: "基线结果",
  ablation_result: "消融结果",
  experiment_config: "实验配置",
  training_log: "训练日志",
  evaluation_log: "评测日志",
  dataset_description: "数据集说明",
  figure_asset: "图片资产",
  notebook: "Notebook",
  source_code: "源代码",
  documentation: "文档",
  unknown: "待定",
};

const GROUP_ROLE_LABEL: Record<string, string> = { main: "主实验", baseline: "基线", ablation: "消融", other: "其他" };

const PARSE_LABEL: Record<string, string> = { pending: "等待解析", ok: "已解析", partial: "部分解析", failed: "解析失败", unsupported: "不支持的类型" };

const directionLabel = (direction: string) => (direction === "higher" ? " ↑" : direction === "lower" ? " ↓" : "");

const SPLIT_LABEL = (split: string) => (split === "unknown" ? "未声明范围" : split);

const WORKFLOW_USE_LABEL: Record<ExperimentSplitScopeView["workflowUse"], string> = {
  allowed: "允许进入工作流",
  excluded: "已排除",
  undecided: "未决定",
};

function scopeStatusText(scope: ExperimentSplitScopeView): string {
  if (scope.status === "confirmed") return "已确认";
  if (scope.status === "conflict") return "有矛盾";
  return "待核对";
}

/** 步骤完成态引导（当前包；纯计算，不用 hook） */
function stepState(item: {
  status: string;
  files: Array<{ parseStatus: string }>;
  groups: Array<{ status: string; splitScopes?: ExperimentSplitScopeView[] }>;
  semanticSuggestions?: unknown;
}) {
  {
    const parsed = item.status === "ready" || item.status === "partial";
    const understood = item.semanticSuggestions !== undefined;
    const allScopes = item.groups.flatMap((group) => group.splitScopes ?? []);
    const confirmedScopes = allScopes.filter((scope) => scope.status === "confirmed");
    const workflowReady = confirmedScopes.filter((scope) => scope.workflowUse === "allowed");
    return { parsed, understood, allScopes, confirmedScopes, workflowReady };
  }
}

export function ExperimentPackagesPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  const [uploadValidationError, setUploadValidationError] = useState("");
  const list = useQuery({ queryKey: ["experiment-packages", projectId], queryFn: () => listExperimentPackages(projectId) });
  const currentId = selectedId ?? list.data?.[0]?.packageId ?? null;
  const detail = useQuery({ queryKey: ["experiment-package", projectId, currentId], queryFn: () => getExperimentPackage(projectId, currentId!), enabled: currentId !== null });
  const refresh = async (packageId: string) => {
    await queryClient.invalidateQueries({ queryKey: ["experiment-packages", projectId] });
    await queryClient.invalidateQueries({ queryKey: ["experiment-package", projectId, packageId] });
    await queryClient.invalidateQueries({ queryKey: ["figure-datasets", projectId] });
  };
  const refreshAll = async () => {
    await queryClient.invalidateQueries({ queryKey: ["experiment-packages", projectId] });
    if (currentId !== null) {
      await queryClient.invalidateQueries({ queryKey: ["experiment-package", projectId, currentId] });
      await queryClient.invalidateQueries({ queryKey: ["figure-datasets", projectId] });
    }
  };
  // M13.6：v1 旧包自动升级（幂等 POST；每个会话至多自动触发一次，失败如实
  // 展示并保留「重新整理分组」高级入口，不自动重试轰炸）
  const ensureUpgrade = useMutation({
    mutationFn: () => ensureExperimentPackagesUpgraded(projectId),
    onSuccess: async (result) => {
      if (result.upgraded.length > 0) {
        setMessage(
          `已自动升级 ${result.upgraded.length} 个旧版实验包到范围级核对` +
            (result.resetConfirmations.length > 0
              ? `；${result.resetConfirmations.length} 个旧确认因范围划分变化需重新核对（未偷偷放行）`
              : ""),
        );
        await refreshAll();
      }
    },
  });
  const ensureAttempted = useRef(false);
  useEffect(() => {
    if (
      !ensureAttempted.current &&
      !ensureUpgrade.isPending &&
      list.data !== undefined &&
      list.data.some((entry) => (entry.schemaVersion ?? 2) < 2)
    ) {
      ensureAttempted.current = true;
      ensureUpgrade.mutate();
    }
  }, [list.data, ensureUpgrade]);
  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("请选择 ZIP 文件");
      return uploadExperimentPackage(projectId, file);
    },
    onSuccess: async (item) => {
      setSelectedId(item.packageId);
      setMessage("实验包已读取。下一步：核对实验范围与指标，或先运行 AI 辅助实验理解。");
      await refresh(item.packageId);
    },
  });
  const edit = useMutation({
    mutationFn: (input: { path: string; role: ExperimentRole; groupId: string }) => editExperimentFile(projectId, currentId!, input),
    onSuccess: async () => {
      setMessage("文件分类已更新；该包的全部确认与工作流授权已失效，请重新核对。");
      await refresh(currentId!);
    },
  });
  const confirm = useMutation({
    mutationFn: (input: { groupIds?: string[]; scopeIds?: string[] }) => confirmExperimentGroups(projectId, currentId!, input.groupIds ?? [], input.scopeIds),
    onSuccess: async () => {
      setMessage("作者确认已保存。确认 = 记录真实；是否允许进入论文工作流需单独授权。");
      await refresh(currentId!);
    },
  });
  const workflowUse = useMutation({
    mutationFn: (input: { scopeId: string; use: "allowed" | "excluded" }) => setExperimentScopeWorkflowUse(projectId, currentId!, input.scopeId, input.use),
    onSuccess: async () => {
      await refresh(currentId!);
    },
  });
  // M13.5.3：旧版（v1）包显式重新整理分组——升级到范围级核对；不改数据，确认与授权失效
  const rebuild = useMutation({
    mutationFn: () => rebuildExperimentPackage(projectId, currentId!),
    onSuccess: async () => {
      setMessage("已按当前规则重新整理分组并升级到范围级核对；该包既有的确认与工作流授权已失效，请按范围重新核对。");
      await refresh(currentId!);
    },
  });
  // M13.6「用于当前论文」：一次提交 = 所选范围确认 + 授权；取消勾选 = 显式排除
  const useForPaper = useMutation({
    mutationFn: (selection: { groupIds?: string[]; scopeIds?: string[]; excludeScopeIds?: string[] }) =>
      applyExperimentWorkflowUse(projectId, currentId!, selection),
    onSuccess: async (_item, selection) => {
      const allowedCount = (selection.groupIds?.length ?? 0) + (selection.scopeIds?.length ?? 0);
      const excludedCount = selection.excludeScopeIds?.length ?? 0;
      setMessage(
        `已更新用于当前论文的实验范围：${allowedCount} 个范围已确认并授权进入工作流` +
          (excludedCount > 0 ? `；${excludedCount} 个范围已排除（立即生效于后续运行）` : "") +
          "。未勾选的范围不会进入论文上下文。",
      );
      await refresh(currentId!);
    },
  });

  const item = detail.data;
  const steps = item !== undefined ? stepState(item) : undefined;

  return (
    <section className="panel" aria-label="实验数据包">
      <h2>实验数据</h2>
      <p className="muted">
        上传实验 ZIP 后：AI 辅助整理 → 核对实验范围与指标 → 作者确认 → 用于论文写作。
        解析与建议只是辅助；作者确认不等于 Evidence Verification，实验包不会自动生成 Verified Evidence。
      </p>

      {/* 步骤 1：上传 */}
      <div className="form-row">
        <label>
          选择 ZIP <input aria-label="选择实验 ZIP" type="file" accept=".zip,application/zip" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setUploadValidationError(""); upload.reset(); }} />
        </label>
        <button type="button" disabled={!file || upload.isPending} onClick={() => {
          if (file && file.size > EXPERIMENT_ARCHIVE_MAX_BYTES) {
            setUploadValidationError(experimentArchiveLimitMessage(file));
            return;
          }
          setUploadValidationError("");
          upload.mutate();
        }}>
          {upload.isPending ? "上传并解析中…" : "上传实验包"}
        </button>
      </div>
      <p className="muted">上限：ZIP 16 MiB、200 个文件、单文件 20 MiB、解压总量 64 MiB；不会执行包内代码。目录可先在本机压缩为 ZIP。</p>
      {uploadValidationError && <p role="alert" className="run-error">{uploadValidationError}</p>}
      {upload.isError && (
        <p role="alert" className="run-error">
          {formatApiError(upload.error)}
        </p>
      )}
      {(edit.isError || confirm.isError || workflowUse.isError || useForPaper.isError || ensureUpgrade.isError) && (
        <p role="alert" className="run-error">
          {formatApiError(edit.error ?? confirm.error ?? workflowUse.error ?? useForPaper.error ?? ensureUpgrade.error)}
        </p>
      )}
      {message && <p role="status">{message}</p>}

      {list.isPending ? (
        <Loading label="加载实验包…" />
      ) : list.isError ? (
        <ErrorState title="实验包加载失败" message={formatApiError(list.error)} onRetry={() => void list.refetch()} />
      ) : (
        <>
          {list.data?.length === 0 && <p className="panel-empty">尚无实验数据包：上传实验 ZIP 后开始整理。</p>}
          {list.data !== undefined && list.data.length > 0 && (
            <label>
              选择实验包{" "}
              <select aria-label="实验包" value={currentId ?? ""} onChange={(event) => setSelectedId(event.target.value)}>
                {list.data.map((entry) => (
                  <option key={entry.packageId} value={entry.packageId}>
                    {entry.originalName} · {PARSE_LABEL[entry.status] ?? entry.status} · {entry.observationCount} 条指标
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}

      {currentId !== null &&
        (detail.isPending ? (
          <Loading label="加载实验包详情…" />
        ) : detail.isError ? (
          <ErrorState title="实验包详情加载失败" message={formatApiError(detail.error)} onRetry={() => void detail.refetch()} />
        ) : (
          item !== undefined && (
            <>
              <h3>{item.originalName}</h3>

              {/* 解析摘要卡 */}
              <div className="experiment-summary-grid">
                <SummaryCard label="文件" value={item.files.length} hint={`已解析 ${item.files.filter((entry) => entry.parseStatus === "ok").length} · 部分 ${item.files.filter((entry) => entry.parseStatus === "partial").length} · 失败 ${item.files.filter((entry) => entry.parseStatus === "failed").length} · 不支持 ${item.files.filter((entry) => entry.parseStatus === "unsupported").length}`} />
                <SummaryCard label="实验组" value={item.groups.length} hint={`已确认 ${item.groups.filter((group) => group.status === "confirmed").length} · 待处理 ${item.groups.filter((group) => group.status === "candidate").length} · 有冲突 ${item.groups.filter((group) => group.status === "conflict").length}`} />
                <SummaryCard label="待确认范围" value={steps?.allScopes.filter((scope) => scope.status === "candidate").length ?? 0} hint={`共 ${steps?.allScopes.length ?? 0} 个评测范围（split）`} />
                <SummaryCard label="指标观测" value={item.observationCount ?? item.observations.length} hint="真实解析值；不自动选优" />
              </div>

              <NextStepGuidance item={item} workflowReadyCount={steps?.workflowReady.length ?? 0} />

              {/* 用于当前论文（M13.6：一次勾选提交 = 确认 + 授权） */}
              <UseForPaperSection item={item} pending={useForPaper.isPending} onApply={(selection) => useForPaper.mutate(selection)} />

              {item.warnings.length > 0 && (
                <details className="details-block">
                  <summary>警告（{item.warnings.length}）</summary>
                  <ul>
                    {item.warnings.map((warning, index) => (
                      <li key={index} className="note-warn-line">
                        {warning}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              <details className="details-block">
                <summary>源材料判定与技术详情</summary>
                <p className="muted">SHA-256：{item.packageHash.slice(0, 16)}… · schema v{item.schemaVersion} · 导入于 {new Date(item.importedAt).toLocaleString()}</p>
                {(item.reportedVerdicts?.length ?? 0) > 0 && (
                  <>
                    <p className="muted">以下判定原样引自包内文件的 verdict/decision 字段；PaperTeam 不重算、不解读、不据此自动得出任何结论。</p>
                    <ul>
                      {item.reportedVerdicts!.map((verdict, index) => (
                        <li key={index}>
                          <strong>{verdict.value}</strong> <small>—— {verdict.path} · {verdict.field}</small>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {item.relationCandidates.length > 0 && (
                  <>
                    <strong>配置与结果关联候选</strong>
                    <ul>
                      {item.relationCandidates.map((relation) => (
                        <li key={`${relation.configPath}-${relation.groupId}`}>
                          {relation.configPath} → {relation.groupId} · {relation.status === "conflict" ? "字段冲突" : "候选"}；相符：{relation.matchedFields.join(", ") || "无"}；冲突：{relation.conflictingFields.join(", ") || "无"}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </details>

              {/* 步骤 2：AI 辅助实验理解 */}
              <UnderstandingSection projectId={projectId} packageId={currentId} item={item} applyEdit={edit.mutate} editPending={edit.isPending} />

              {/* 步骤 3：核对实验范围与分组 */}
              <ScopesSection item={item} confirmPending={confirm.isPending} onConfirm={(input) => confirm.mutate(input)} onWorkflowUse={(input) => workflowUse.mutate(input)} workflowPending={workflowUse.isPending} onRebuild={() => rebuild.mutate()} rebuildPending={rebuild.isPending} rebuildError={rebuild.error instanceof Error ? rebuild.error.message : null} />

              {/* 步骤 4：指标浏览 */}
              <MetricsBrowser projectId={projectId} packageId={currentId} confirmedGroupIds={new Set(item.groups.filter((group) => group.status === "confirmed").map((group) => group.id))} />

              {/* 步骤 5：文件清单（默认折叠） */}
              <FilesSection item={item} editPending={edit.isPending} onEdit={(input) => edit.mutate(input)} />

              {/* 用于论文写作 */}
              <WorkflowReadySection item={item} workflowReadyScopes={steps?.workflowReady ?? []} />
            </>
          )
        ))}
    </section>
  );
}

function SummaryCard({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="experiment-summary-card" data-testid={`summary-${label}`}>
      <div className="experiment-summary-value">{value}</div>
      <div className="experiment-summary-label">{label}</div>
      <div className="muted experiment-summary-hint">{hint}</div>
    </div>
  );
}

function NextStepGuidance({ item, workflowReadyCount }: { item: { status: string; semanticSuggestions?: unknown; groups: Array<{ status: string; splitScopes?: ExperimentSplitScopeView[] }> }; workflowReadyCount: number }) {
  const allScopes = item.groups.flatMap((group) => group.splitScopes ?? []);
  const pendingScopes = allScopes.filter((scope) => scope.status === "candidate").length;
  const conflicts = item.groups.filter((group) => group.status === "conflict").length;
  let text: string;
  if (item.status === "inventory" || item.status === "importing") text = "正在解析包内文件…";
  else if (conflicts > 0) text = "存在需要处理的冲突（见「核对实验范围与分组」）；真正的矛盾不能通过改名消除。";
  else if (pendingScopes > 0 && workflowReadyCount === 0) text = `下一步：在「用于当前论文」中勾选允许使用的实验范围并一次提交（共 ${pendingScopes} 个待确认范围）——一次提交即完成确认与授权。`;
  else if (workflowReadyCount === 0) text = allScopes.some((scope) => scope.status === "confirmed")
    ? "范围已确认。若要用于当前论文工作流，请在「用于当前论文」中勾选相应范围。"
    : "下一步：在「用于当前论文」中勾选范围并提交，或先运行 AI 辅助实验理解。";
  else text = `${workflowReadyCount} 个实验范围已确认并允许进入论文工作流；可以启动论文流程或生成学术图表。`;
  return (
    <p className="note" role="status" data-testid="experiment-next-step">
      <span>{text}</span>
    </p>
  );
}

/**
 * 「用于当前论文」汇总选择（M13.6）：
 * - 单范围、无冲突的普通实验组默认勾选——一次提交即完成「确认 + 允许进入
 *   工作流」（上传到当前论文项目的意图即默认写作使用意图）；
 * - 多范围组逐范围勾选（Dev25 / Confirmation13 / Full38 必须显式选择，
 *   不因同包其它范围被选中而放行）；
 * - 已授权范围的取消勾选 = 显式排除（excludeScopeIds，立即生效）；
 * - 有冲突 / 组级冲突的范围不可勾选（须先在明细区解决矛盾）。
 */
function UseForPaperSection({
  item,
  pending,
  onApply,
}: {
  item: ExperimentPackageView;
  pending: boolean;
  onApply: (selection: { groupIds?: string[]; scopeIds?: string[]; excludeScopeIds?: string[] }) => void;
}) {
  interface Row {
    key: string;
    groupId: string;
    scopeId?: string;
    split: string;
    observationCount: number;
    metricCount: number;
    multiScope: boolean;
    disabled: boolean;
    reason?: string;
    previouslyAllowed: boolean;
    defaultChecked: boolean;
  }
  const rows = useMemo<Row[]>(() => {
    const result: Row[] = [];
    for (const group of item.groups) {
      const scopes = group.splitScopes ?? [];
      if (scopes.length === 0) continue; // 无观测组（文档/配置）不参与工作流授权
      for (const scope of scopes) {
        const scopeConflicts = scope.status === "conflict" || scope.conflicts.length > 0;
        const groupConflicts = group.conflicts.length > 0 || group.status === "conflict";
        result.push({
          key: scope.id,
          groupId: group.id,
          scopeId: scope.id,
          split: scope.split,
          observationCount: scope.observationCount,
          metricCount: scope.metricCount,
          multiScope: scopes.length > 1,
          disabled: scopeConflicts || groupConflicts,
          reason: scopeConflicts
            ? "该范围存在协议矛盾，需先在「核对实验范围与分组」处理"
            : groupConflicts
              ? "所在实验组有未解决冲突"
              : undefined,
          previouslyAllowed: scope.workflowUse === "allowed",
          // 单范围无冲突组：默认勾选（未处理过）或保持当前授权状态；
          // 多范围组：只有已授权的默认勾选（confirmation / held-out 必须显式选择）
          defaultChecked:
            scopes.length === 1 && !scopeConflicts && !groupConflicts
              ? scope.workflowUse === "allowed" || scope.status === "candidate"
              : scope.workflowUse === "allowed",
        });
      }
    }
    return result;
  }, [item]);
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries(rows.map((row) => [row.key, row.defaultChecked])));
  // 跟随服务端事实重新同步：包切换或行集合/默认值变化（如 v1 自动升级后
  // rows 从空变为三范围、授权提交后的回读）时重置勾选状态；纯刷新（签名
  // 不变）不打断用户进行中的勾选
  const rowsSignature = `${item.packageId}:${rows.map((row) => `${row.key}=${row.defaultChecked ? 1 : 0}`).join(",")}`;
  const [initializedFor, setInitializedFor] = useState(rowsSignature);
  if (initializedFor !== rowsSignature) {
    setInitializedFor(rowsSignature);
    setChecked(Object.fromEntries(rows.map((row) => [row.key, row.defaultChecked])));
  }
  const toggle = (key: string) => setChecked((previous) => ({ ...previous, [key]: !previous[key] }));
  const submit = () => {
    const groupIds = rows
      .filter((row) => !row.multiScope && row.scopeId !== undefined && checked[row.key] === true && !row.disabled)
      .map((row) => row.groupId);
    const scopeIds = rows
      .filter((row) => row.multiScope && row.scopeId !== undefined && checked[row.key] === true && !row.disabled)
      .map((row) => row.scopeId!);
    const excludeScopeIds = rows
      .filter((row) => row.previouslyAllowed && checked[row.key] !== true)
      .map((row) => row.key);
    onApply({
      ...(groupIds.length > 0 ? { groupIds } : {}),
      ...(scopeIds.length > 0 ? { scopeIds } : {}),
      ...(excludeScopeIds.length > 0 ? { excludeScopeIds } : {}),
    });
  };
  const allowedCount = rows.filter((row) => checked[row.key] === true && !row.disabled).length;
  const parsed = item.status === "ready" || item.status === "partial";
  return (
    <section className="panel experiment-step" aria-label="用于当前论文">
      <h3>用于当前论文</h3>
      <p className="muted">
        这些实验结果中，哪些允许用于当前论文？勾选后一次提交即可完成「确认记录真实 + 允许进入写作上下文」；
        未勾选的范围不会进入论文上下文（也不会被标成明确排除）。确认集 / held-out 等独立评测范围必须由你显式勾选。
      </p>
      {rows.length === 0 ? (
        <p className="muted">该包没有可用的实验结果范围（无指标观测）。上传包含结果文件的实验 ZIP 后可在此选择。</p>
      ) : (
        <>
          <ul className="suggestion-list" data-testid="use-for-paper-list">
            {rows.map((row) => (
              <li key={row.key} data-testid={`use-for-paper-row-${row.key}`}>
                <label className={row.disabled ? "muted" : undefined}>
                  <input
                    type="checkbox"
                    data-testid={`use-for-paper-check-${row.key}`}
                    aria-label={`允许 ${row.groupId}（${SPLIT_LABEL(row.split)}）用于当前论文`}
                    disabled={pending || row.disabled || !parsed}
                    checked={checked[row.key] === true}
                    onChange={() => toggle(row.key)}
                  />{" "}
                  实验组 <code>{row.groupId}</code> · 范围 {SPLIT_LABEL(row.split)}
                  {row.multiScope ? "" : "（单一范围）"} · {row.observationCount} 条观测 / {row.metricCount} 种指标
                  {row.split === "unknown" ? <span className="note-warn-line">（未声明评测范围：确认前请核对数据口径）</span> : ""}
                </label>
                {row.reason !== undefined && <div className="run-error">{row.reason}</div>}
              </li>
            ))}
          </ul>
          <div className="action-row">
            <button type="button" className="btn btn-primary" data-testid="use-for-paper-submit" disabled={pending || !parsed} onClick={submit}>
              {pending ? "提交中…" : `用于本文写作（${allowedCount} 项）`}
            </button>
            <span className="muted">
              已确认 + 授权 ≠ 外部核验（Verified Evidence）；论文中的实验数值仍只来自这些授权观测。
            </span>
          </div>
        </>
      )}
    </section>
  );
}

function UnderstandingSection({
  projectId,
  packageId,
  item,
  applyEdit,
  editPending,
}: {
  projectId: string;
  packageId: string;
  item: ExperimentPackageView;
  applyEdit: (input: { path: string; role: ExperimentRole; groupId: string }) => void;
  editPending: boolean;
}) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const understand = useMutation({
    mutationFn: () => requestExperimentUnderstanding(projectId, packageId),
    onSuccess: async (result) => {
      const suggestions = result.semanticSuggestions;
      setMessage(
        suggestions
          ? `语义理解完成（模型 ${suggestions.model}，${(suggestions.durationMs / 1000).toFixed(1)}s，输入 ${suggestions.usage?.input ?? "?"} tok）：角色建议 ${suggestions.roleSuggestions.length} 条、发现 ${suggestions.findings.length} 条——全部需作者确认，可逐条采纳。`
          : "语义理解未产生建议。",
      );
      await queryClient.invalidateQueries({ queryKey: ["experiment-package", projectId, packageId] });
    },
  });
  const suggestions = item.semanticSuggestions;
  const appliedPaths = useMemo(() => new Set(item.files.filter((file) => file.roleBasis === "作者修改").map((file) => file.path)), [item.files]);
  return (
    <section className="panel experiment-step" aria-label="AI 辅助实验理解">
      <h3>AI 辅助实验理解</h3>
      <p className="muted">
        用当前生效的默认模型对本包做一次有界语义理解，产出角色建议与发现陈述。建议经确定性校验（锚点与数值逐条核对），全部
        <em> 需作者确认</em>——采纳后仍走确定性校验与业务状态机，不会自动改写观测或生成 Evidence。
      </p>
      <div className="form-row">
        <button type="button" disabled={understand.isPending || item.status === "inventory" || item.status === "importing"} onClick={() => understand.mutate()}>
          {understand.isPending ? "理解中…" : "运行语义理解"}
        </button>
        {suggestions !== undefined && (
          <span className="muted">
            模型 {suggestions.model} · {(suggestions.durationMs / 1000).toFixed(1)}s{suggestions.usage?.totalTokens !== undefined ? ` · ${suggestions.usage.totalTokens} tok` : ""} · {new Date(suggestions.generatedAt).toLocaleString()}
          </span>
        )}
      </div>
      {understand.isError && (
        <p role="alert" className="run-error">
          {formatApiError(understand.error)}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {suggestions !== undefined && (
        <div className="panel">
          {suggestions.roleSuggestions.length > 0 && (
            <>
              <strong>角色建议（可逐条采纳）</strong>
              <ul className="suggestion-list">
                {suggestions.roleSuggestions.map((suggestion, index) => {
                  const current = item.files.find((file) => file.path === suggestion.path);
                  const alreadyApplied = appliedPaths.has(suggestion.path) || (current !== undefined && current.role === suggestion.suggestedRole && current.groupId === suggestion.suggestedGroupId);
                  return (
                    <li key={index}>
                      <code>{suggestion.path}</code> → 识别为 {ROLE_LABEL[suggestion.suggestedRole]} / 组 <code>{suggestion.suggestedGroupId}</code>
                      <div className="muted">{suggestion.rationale}（依据：{suggestion.anchors.join("、")}）</div>
                      <div className="action-row">
                        <button
                          type="button"
                          className="btn btn-small"
                          disabled={editPending || alreadyApplied || current === undefined}
                          onClick={() => applyEdit({ path: suggestion.path, role: suggestion.suggestedRole, groupId: suggestion.suggestedGroupId })}
                        >
                          {alreadyApplied ? "已采纳/已是该分类" : "采纳"}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {suggestions.findings.length > 0 && (
            <>
              <strong>发现陈述（数值已逐条核对）</strong>
              <ul>
                {suggestions.findings.map((finding, index) => (
                  <li key={index}>
                    {finding.claim} <small>（可信度 {finding.confidence} · 锚点：{finding.anchors.join("、")}）</small>
                  </li>
                ))}
              </ul>
            </>
          )}
          {suggestions.notes.length > 0 && (
            <>
              <strong>校验记录</strong>
              <ul>
                {suggestions.notes.map((note, index) => (
                  <li key={index} className="note-warn-line">
                    {note}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function ScopesSection({
  item,
  confirmPending,
  onConfirm,
  onWorkflowUse,
  workflowPending,
  onRebuild,
  rebuildPending,
  rebuildError,
}: {
  item: ExperimentPackageView;
  confirmPending: boolean;
  onConfirm: (input: { groupIds?: string[]; scopeIds?: string[] }) => void;
  onWorkflowUse: (input: { scopeId: string; use: "allowed" | "excluded" }) => void;
  workflowPending: boolean;
  onRebuild: () => void;
  rebuildPending: boolean;
  rebuildError: string | null;
}) {
  const [batchConfirm, setBatchConfirm] = useState(false);
  const [rebuildConfirm, setRebuildConfirm] = useState(false);
  // v1 旧包：没有观测级范围（splitScopes），同文件多 split 会被整组判冲突且无法按范围确认
  const legacy = item.schemaVersion < 2;
  const batchTargets = item.groups
    .filter((group) => group.status === "candidate" && (group.splitScopes ?? []).length === 1 && (group.splitScopes?.[0]?.status ?? "") === "candidate")
    .map((group) => group.splitScopes![0]!.id);
  return (
    <section className="panel experiment-step" aria-label="核对实验范围与分组">
      <h3>核对实验范围与分组</h3>
      <p className="muted">
        实验组按来源文件归类；同一结果文件可能包含多种评测范围（如开发集 / 确认集 / 完整集），需要分别核对。
        确认 = 该范围的记录真实、归属正确；「允许进入工作流」是独立的授权——确认集 / held-out 材料未经显式授权不会进入论文写作上下文。
      </p>
      {legacy && (
        <div className="callout" data-testid="legacy-package-notice">
          <p>
            该实验包仍按旧版规则分组（schema v{item.schemaVersion}）：自动升级未能完成（通常是解析仍在进行或刚失败）。
            「重新整理分组」是用当前规则重建实验组与评测范围的高级恢复操作（不改任何文件分类、归属或指标数值），升级到范围级核对。
          </p>
          <p className="muted">代价：该包既有的组确认与工作流授权全部失效，需要按范围重新核对。常规情况下打开本页或启动工作流时会自动完成升级，无需手动操作。</p>
          {rebuildConfirm ? (
            <span className="inline-confirm" role="group" aria-label="确认重新整理分组">
              <span>确定重新整理分组？既有确认与授权将失效。</span>
              <button type="button" className="btn btn-small btn-primary" data-testid="rebuild-package-confirm" disabled={rebuildPending} onClick={() => { onRebuild(); setRebuildConfirm(false); }}>
                确定
              </button>
              <button type="button" className="btn btn-small" onClick={() => setRebuildConfirm(false)}>
                取消
              </button>
            </span>
          ) : (
            <button type="button" className="btn btn-small" data-testid="rebuild-package" disabled={rebuildPending} onClick={() => setRebuildConfirm(true)}>
              {rebuildPending ? "正在重新整理…" : "重新整理分组（升级到范围级核对）"}
            </button>
          )}
          {rebuildError && <p className="run-error">{rebuildError}</p>}
        </div>
      )}
      {item.groups.map((group) => {
        const scopes = group.splitScopes;
        const multiScope = (scopes?.length ?? 0) > 1;
        const confirmedScopeCount = scopes?.filter((scope) => scope.status === "confirmed").length ?? 0;
        return (
          <details key={group.id} className="details-block experiment-group" open={group.status !== "confirmed"} data-testid={`experiment-group-${group.id}`}>
            <summary>
              {GROUP_ROLE_LABEL[group.role] ?? group.role} · <code>{group.id}</code>
              <span className="muted">
                {" "}
                · {group.filePaths.length} 文件 · {group.status === "confirmed" ? "已确认" : group.status === "conflict" ? "有冲突" : "待确认"}
                {multiScope ? ` · ${scopes!.length} 个评测范围（已确认 ${confirmedScopeCount}）` : ""}
              </span>
            </summary>
            <div className="muted">分组依据：{group.basis}</div>
            {group.conflicts.map((conflict) => (
              <p key={conflict} className="run-error">
                {conflict}
              </p>
            ))}
            {scopes !== undefined && scopes.length > 0 ? (
              <div style={{ overflowX: "auto" }}>
                <table className="data-table" data-testid={`scope-table-${group.id}`}>
                  <thead>
                    <tr>
                      <th>评测范围（split）</th>
                      <th className="num">指标条数</th>
                      <th className="num">指标种数</th>
                      <th>来源文件</th>
                      <th>协议</th>
                      <th>状态</th>
                      <th>用于论文工作流</th>
                      <th aria-label="操作" />
                    </tr>
                  </thead>
                  <tbody>
                    {scopes.map((scope) => (
                      <tr key={scope.id} data-testid={`scope-row-${scope.id}`}>
                        <td>{SPLIT_LABEL(scope.split)}</td>
                        <td className="num">{scope.observationCount}</td>
                        <td className="num">{scope.metricCount}</td>
                        <td>
                          {scope.filePaths.map((path) => (
                            <div key={path}>
                              <code>{path}</code>
                            </div>
                          ))}
                        </td>
                        <td>{scope.protocols.length > 0 ? scope.protocols.join(" / ") : "—"}</td>
                        <td>
                          {scopeStatusText(scope)}
                          {scope.conflicts.map((conflict) => (
                            <div key={conflict} className="run-error">
                              {conflict}
                            </div>
                          ))}
                        </td>
                        <td>{scope.status === "confirmed" ? WORKFLOW_USE_LABEL[scope.workflowUse] : "（确认后可授权）"}</td>
                        <td>
                          {scope.status !== "conflict" && scope.status !== "confirmed" && (
                            <button type="button" className="btn btn-small" disabled={confirmPending || group.status === "conflict"} onClick={() => onConfirm({ scopeIds: [scope.id] })}>
                              确认此范围
                            </button>
                          )}
                          {scope.status === "confirmed" && (
                            <span className="action-row">
                              {scope.workflowUse !== "allowed" && (
                                <button type="button" className="btn btn-small" disabled={workflowPending} onClick={() => onWorkflowUse({ scopeId: scope.id, use: "allowed" })}>
                                  允许进入工作流
                                </button>
                              )}
                              {scope.workflowUse !== "excluded" && (
                                <button type="button" className="btn btn-small" disabled={workflowPending} onClick={() => onWorkflowUse({ scopeId: scope.id, use: "excluded" })}>
                                  {scope.workflowUse === "allowed" ? "改为排除" : "排除"}
                                </button>
                              )}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">该组没有指标观测（普通文档 / 配置等），不影响实验范围核对。</p>
            )}
            {!multiScope && group.status !== "confirmed" && group.status !== "conflict" && (
              <button type="button" className="btn btn-small" disabled={confirmPending} onClick={() => onConfirm({ groupIds: [group.id] })}>
                确认此组
              </button>
            )}
            {multiScope && group.status === "candidate" && <p className="muted">该组包含多个评测范围：请在上表按范围分别确认，不能整组一键确认。</p>}
          </details>
        );
      })}
      {batchTargets.length > 0 && (
        <div className="action-row">
          {batchConfirm ? (
            <span className="inline-confirm" role="group" aria-label="确认批量确认范围">
              <span>
                将确认 {batchTargets.length} 个无冲突、单一范围实验组（{batchTargets.map((id) => id.split("@")[0]).join("、")}）。确认前请已抽查各组数值；普通文档不在此列。
              </span>
              <button type="button" className="btn btn-small btn-primary" disabled={confirmPending} onClick={() => { onConfirm({ groupIds: batchTargets.map((id) => id.split("@")[0]) }); setBatchConfirm(false); }}>
                确认
              </button>
              <button type="button" className="btn btn-small" onClick={() => setBatchConfirm(false)}>
                取消
              </button>
            </span>
          ) : (
            <button type="button" className="btn btn-small" onClick={() => setBatchConfirm(true)}>
              批量确认无冲突的单一范围组（{batchTargets.length} 个）
            </button>
          )}
        </div>
      )}
    </section>
  );
}

const METRICS_PAGE_SIZE = 50;

function MetricsBrowser({ projectId, packageId, confirmedGroupIds }: { projectId: string; packageId: string; confirmedGroupIds: Set<string> }) {
  const [split, setSplit] = useState("");
  const [groupId, setGroupId] = useState("");
  const [metric, setMetric] = useState("");
  const [method, setMethod] = useState("");
  const [path, setPath] = useState("");
  const [page, setPage] = useState(1);
  const [evidenceTarget, setEvidenceTarget] = useState<MetricObservationView | null>(null);
  const [claim, setClaim] = useState("");
  const [message, setMessage] = useState("");
  const query = useQuery({
    queryKey: ["experiment-observations", projectId, packageId, split, groupId, metric, method, path, page],
    queryFn: () => queryExperimentObservations(projectId, packageId, { ...(split !== "" ? { split } : {}), ...(groupId !== "" ? { groupId } : {}), ...(metric !== "" ? { metric } : {}), ...(method !== "" ? { method } : {}), ...(path !== "" ? { path } : {}), page, pageSize: METRICS_PAGE_SIZE }),
  });
  const queryClient = useQueryClient();
  const evidence = useMutation({
    mutationFn: async () => {
      if (evidenceTarget === null) throw new Error("请选择一条指标");
      return confirmExperimentMetricEvidence(projectId, evidenceTarget, claim);
    },
    onSuccess: (result) => {
      setMessage(`已登记 ${result.evidence.id}：${result.evidence.verificationLevel} / ${result.evidence.verificationStatus}；仍需独立核验。`);
      setEvidenceTarget(null);
      setClaim("");
    },
  });
  const resetFilters = () => {
    setSplit("");
    setGroupId("");
    setMetric("");
    setMethod("");
    setPath("");
    setPage(1);
  };
  const result = query.data;
  const totalPages = result !== undefined ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1;
  return (
    <section className="panel experiment-step" aria-label="指标浏览">
      <h3>指标浏览</h3>
      <p className="muted">真实解析值（单位与优化方向未知时不计算相对提升；多 seed 不自动选优）。每条可定位到源文件与行列。</p>
      <div className="form-row experiment-filter-row">
        <label>
          评测范围
          <select aria-label="按评测范围筛选" value={split} onChange={(event) => { setSplit(event.target.value); setPage(1); }}>
            <option value="">全部</option>
            {result?.facets.splits.map((value) => (
              <option key={value} value={value}>
                {SPLIT_LABEL(value)}
              </option>
            ))}
          </select>
        </label>
        <label>
          实验组
          <select aria-label="按实验组筛选" value={groupId} onChange={(event) => { setGroupId(event.target.value); setPage(1); }}>
            <option value="">全部</option>
            {result?.facets.groupIds.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          指标
          <select aria-label="按指标筛选" value={metric} onChange={(event) => { setMetric(event.target.value); setPage(1); }}>
            <option value="">全部</option>
            {result?.facets.metrics.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          Method
          <input aria-label="按 method 筛选" value={method} placeholder="包含匹配" onChange={(event) => { setMethod(event.target.value); setPage(1); }} />
        </label>
        <label>
          来源文件
          <input aria-label="按来源路径筛选" value={path} placeholder="包含匹配" onChange={(event) => { setPath(event.target.value); setPage(1); }} />
        </label>
        <button type="button" className="btn btn-small" onClick={resetFilters}>
          重置筛选
        </button>
      </div>
      {query.isPending ? (
        <Loading label="加载指标…" />
      ) : query.isError ? (
        <ErrorState title="指标加载失败" message={formatApiError(query.error)} onRetry={() => void query.refetch()} />
      ) : result !== undefined ? (
        <>
          <p className="muted">
            共 {result.total} 条 · 第 {result.page}/{totalPages} 页
          </p>
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>范围</th>
                  <th>实验组</th>
                  <th>Method</th>
                  <th>Seed</th>
                  <th>指标</th>
                  <th>值</th>
                  <th>来源定位</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {result.observations.map((observation, index) => (
                  <tr key={`${observation.sourceId}-${observation.blockId}-${observation.metric}-${index}`}>
                    <td>{observation.split !== undefined ? SPLIT_LABEL(observation.split) : "—"}</td>
                    <td>{observation.groupId}</td>
                    <td>{observation.method ?? "—"}</td>
                    <td>{observation.seed ?? "—"}</td>
                    <td>
                      {observation.metric}
                      {directionLabel(observation.direction)}
                    </td>
                    <td>{observation.value}</td>
                    <td>
                      <code>{observation.path}</code>
                      <small>
                        {" "}
                        {observation.sheet !== undefined ? `${observation.sheet} ` : ""}
                        {observation.row !== undefined ? `行 ${observation.row}` : ""} {observation.column ?? observation.jsonPath ?? ""}
                      </small>
                    </td>
                    <td>
                      {confirmedGroupIds.has(observation.groupId) && (
                        <button type="button" className="btn btn-small" onClick={() => { setEvidenceTarget(observation); setClaim(""); }}>
                          作为作者确认的 Evidence…
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="action-row">
            <button type="button" className="btn btn-small" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
              上一页
            </button>
            <button type="button" className="btn btn-small" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>
              下一页
            </button>
          </div>
        </>
      ) : null}
      {evidenceTarget !== null && (
        <div className="panel">
          <label>
            论文 claim（必须包含原始数值）
            <input aria-label="Evidence claim" value={claim} onChange={(event) => setClaim(event.target.value)} />
          </label>
          <button type="button" disabled={!claim.trim() || evidence.isPending} onClick={() => evidence.mutate()}>
            确认这条来源数据（{evidenceTarget.metric} = {evidenceTarget.value}）
          </button>
          <button type="button" onClick={() => setEvidenceTarget(null)}>
            取消
          </button>
          <p className="muted">该操作只登记 user_confirmed / unverified，不会自动提升为 grounded_verified。</p>
        </div>
      )}
      {evidence.isError && (
        <p role="alert" className="run-error">
          {formatApiError(evidence.error)}
        </p>
      )}
      {message && (
        <p role="status" onDoubleClick={() => void queryClient.invalidateQueries({ queryKey: ["experiment-package", projectId, packageId] })}>
          {message}
        </p>
      )}
    </section>
  );
}

const FILES_PAGE_SIZE = 20;

function FilesSection({ item, editPending, onEdit }: { item: NonNullable<ReturnType<typeof getExperimentPackage> extends Promise<infer T> ? T : never>; editPending: boolean; onEdit: (input: { path: string; role: ExperimentRole; groupId: string }) => void }) {
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  /** 用户在本会话中刚选过的角色（路径 → 角色）：组名 blur 提交时用最新
   * 选择，避免刷新竞态把刚改的角色用过期 entry.role 回写掉 */
  const roleDrafts = useRef(new Map<string, ExperimentRole>());
  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return item.files.filter(
      (file) =>
        (keyword === "" || file.path.toLowerCase().includes(keyword)) &&
        (roleFilter === "" || file.role === roleFilter) &&
        (statusFilter === "" || file.parseStatus === statusFilter),
    );
  }, [item.files, search, roleFilter, statusFilter]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / FILES_PAGE_SIZE));
  const visible = filtered.slice((page - 1) * FILES_PAGE_SIZE, page * FILES_PAGE_SIZE);
  const pendingCount = item.files.filter((file) => file.groupId === "unresolved").length;
  return (
    <section className="panel experiment-step" aria-label="文件清单">
      <details className="details-block">
        <summary>
          文件清单（{item.files.length} 个文件{pendingCount > 0 ? ` · ${pendingCount} 个待分组` : ""}；默认折叠，可搜索筛选）
        </summary>
        <div className="form-row experiment-filter-row">
          <label>
            搜索
            <input aria-label="搜索文件" type="search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="按路径搜索" />
          </label>
          <label>
            角色
            <select aria-label="按角色筛选" value={roleFilter} onChange={(event) => { setRoleFilter(event.target.value); setPage(1); }}>
              <option value="">全部</option>
              {roles.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABEL[role]}
                </option>
              ))}
            </select>
          </label>
          <label>
            解析状态
            <select aria-label="按解析状态筛选" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }}>
              <option value="">全部</option>
              {Object.entries(PARSE_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted">
          共 {filtered.length} 个 · 第 {page}/{totalPages} 页
        </p>
        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>路径</th>
                <th>大小 / 解析</th>
                <th>角色（{ROLE_LABEL.unknown} 需处理）</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {visible.map((entry) => (
                <tr key={entry.path} data-testid={`file-row-${entry.path}`}>
                  <td>
                    <code>{entry.path}</code>
                    <br />
                    <small className="muted">SHA {entry.hash.slice(0, 12)}…</small>
                  </td>
                  <td>
                    {entry.bytes} B · {PARSE_LABEL[entry.parseStatus] ?? entry.parseStatus}
                    {entry.warning !== undefined && (
                      <small className="run-error"> {entry.warning}</small>
                    )}
                  </td>
                  <td>
                    {ROLE_LABEL[entry.role] ?? entry.role} · 组 <code>{entry.groupId}</code>
                    <br />
                    <small className="muted">
                      {entry.roleBasis} · {entry.roleConfidence === "high" ? "高置信" : "候选"}
                    </small>
                  </td>
                  <td>
                    <details className="details-block">
                      <summary>修改分类</summary>
                      <div className="form-row">
                        <select aria-label={`${entry.path} 角色`} defaultValue={entry.role} disabled={editPending} onChange={(event) => { roleDrafts.current.set(entry.path, event.target.value as ExperimentRole); onEdit({ path: entry.path, role: event.target.value as ExperimentRole, groupId: entry.groupId }); }}>
                          {roles.map((role) => (
                            <option key={role} value={role}>
                              {ROLE_LABEL[role]}
                            </option>
                          ))}
                        </select>
                        <input
                          aria-label={`${entry.path} 分组`}
                          defaultValue={entry.groupId}
                          key={`${entry.path}-${entry.groupId}`}
                          onBlur={(event) => {
                            const groupId = event.target.value.trim();
                            if (groupId !== "" && groupId !== entry.groupId) onEdit({ path: entry.path, role: roleDrafts.current.get(entry.path) ?? entry.role, groupId });
                          }}
                        />
                      </div>
                      <p className="muted">修改任一文件会使该包的全部确认与工作流授权失效（需重新核对）。</p>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="action-row">
          <button type="button" className="btn btn-small" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
            上一页
          </button>
          <button type="button" className="btn btn-small" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>
            下一页
          </button>
        </div>
      </details>
    </section>
  );
}

function WorkflowReadySection({ item, workflowReadyScopes }: { item: NonNullable<ReturnType<typeof getExperimentPackage> extends Promise<infer T> ? T : never>; workflowReadyScopes: ExperimentSplitScopeView[] }) {
  const legacyConfirmed = item.groups.filter((group) => group.status === "confirmed" && group.splitScopes === undefined);
  return (
    <section className="panel experiment-step" aria-label="用于论文写作">
      <h3>用于论文写作</h3>
      {workflowReadyScopes.length > 0 ? (
        <>
          <p>
            已确认并允许进入当前论文工作流的实验范围：{workflowReadyScopes.map((scope) => `${scope.id.split("@")[0]}（${SPLIT_LABEL(scope.split)}）`).join("、")}。
            这些观测会作为作者确认的实验上下文进入研究/写作流程；它们仍不是 Verified Evidence——引用前走 Evidence 核验。
          </p>
          <p>
            <Link to="?tab=figures">用已确认数据生成学术图表 →</Link>
          </p>
        </>
      ) : legacyConfirmed.length > 0 ? (
        <p className="muted">
          已确认实验组：{legacyConfirmed.map((group) => group.id).join("、")}（旧版整组确认；其观测按既有规则进入工作流上下文）。
        </p>
      ) : (
        <p className="muted">尚无确认并授权的实验范围。在「用于当前论文」中勾选范围并一次提交即可。</p>
      )}
      <p className="muted">已解析 ≠ 已关联 ≠ 作者已确认 ≠ 允许进入工作流 ≠ Evidence Verification。</p>
    </section>
  );
}
