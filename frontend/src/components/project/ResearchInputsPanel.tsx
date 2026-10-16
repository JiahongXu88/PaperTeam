/**
 * M14.2：研究材料面板（thesis_from_papers 专属）。
 *
 * 职责（最小闭环）：
 * - 上传研究材料 PDF → 入文献库 → 登记为 ResearchInput（类型 + 标题）；
 * - 输入清单（入选 / 待决 / 排除 / 解析状态 + 版本分组）；
 * - 快捷作者决定：include / exclude / allow_unpublished / 确认全部事实；
 * - 未裁决冲突清单 + adopt_fact 裁决；
 * - 启动学位论文工作流（项目 kind 已是 thesis_from_papers）。
 *
 * 深层操作（贡献确认 / 版本选择 / 大纲确认 / 缺材料决定）在工作流 HITL
 * 面板完成——本面板不重复实现第二套 HITL。
 */

import { useRef, useState } from "react";

import { ErrorState } from "../common/StateViews.js";
import { Icon } from "../common/Icon.js";
import {
  useCreateWorkflowRun,
  useResearchConflicts,
  useResearchInputDecision,
  useResearchInputs,
  useUploadSource,
} from "../../hooks/queries.js";
import { registerResearchInput } from "../../api/researchInputs.js";
import { MissingMaterialPanel } from "./MissingMaterialPanel.js";
import { formatApiError } from "../../utils/errors.js";
import { fileToBase64, MAX_PDF_UPLOAD_BYTES, validatePdfFile } from "../../utils/file.js";
import { RESEARCH_INPUT_TYPE_OPTIONS, type ResearchInputType } from "../../types/researchInputs.js";

const SCOPE_LABELS: Record<string, string> = {
  proposed: "待决",
  included: "已入选",
  excluded: "已排除",
  superseded: "已取代",
};

const PARSE_LABELS: Record<string, string> = {
  pending: "待解析",
  full_text: "全文可解析",
  partial: "部分可解析",
  failed: "解析失败",
  metadata_only: "仅元数据",
  unsupported: "不支持",
};

export function ResearchInputsPanel({ projectId }: { projectId: string }) {
  const inputs = useResearchInputs(projectId);
  const conflicts = useResearchConflicts(projectId);
  const uploadSource = useUploadSource(projectId);
  const decide = useResearchInputDecision(projectId);
  const createRun = useCreateWorkflowRun();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [inputType, setInputType] = useState<ResearchInputType>("published_paper");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const registerUpload = async (file: File) => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const upload = await uploadSource.mutateAsync({
        fileName: file.name,
        contentBase64: await fileToBase64(file),
      });
      const registered = await registerResearchInput(projectId, {
        sourceId: upload.source.sourceId,
        inputType,
        ...(title.trim() !== "" ? { title: title.trim() } : {}),
        ensureParsed: true,
      });
      setNotice(
        registered.created
          ? `已登记研究材料（${labelFor(inputType)}）：${title.trim() !== "" ? title.trim() : file.name}`
          : `该文件此前已登记（幂等，未重复创建）`,
      );
      setTitle("");
      void inputs.refetch();
      void conflicts.refetch();
    } catch (mutationError) {
      setError(formatApiError(mutationError as Error));
    } finally {
      setBusy(false);
    }
  };

  const onFile = (file: File | null) => {
    if (file === null) return;
    const invalid = validatePdfFile(file) ?? (file.size > MAX_PDF_UPLOAD_BYTES ? `文件过大（上限 ${Math.round(MAX_PDF_UPLOAD_BYTES / 1024 / 1024)}MB）` : null);
    if (invalid !== null) {
      setError(invalid);
      return;
    }
    void registerUpload(file);
  };

  const decision = async (payload: Record<string, unknown>, message: string) => {
    setError(null);
    try {
      await decide.mutateAsync(payload);
      setNotice(message);
    } catch (mutationError) {
      setError(formatApiError(mutationError as Error));
    }
  };

  const list = inputs.data?.inputs ?? [];
  const unresolved = conflicts.data ?? [];

  return (
    <section className="panel research-inputs-panel" data-testid="research-inputs-panel">
      <header className="panel-header">
        <h2>研究材料</h2>
        <p>
          上传你的研究成果（论文 / 手稿 / 实验报告），登记后由系统确定性提取科研事实与冲突。
          材料是否属于你的成果、发表状态与冲突数值，均由你确认——系统不会把他人的论文当作你的成果。
        </p>
      </header>

      <div className="research-inputs-register">
        <label className="field">
          <span>材料类型</span>
          <select value={inputType} onChange={(event) => setInputType(event.target.value as ResearchInputType)}>
            {RESEARCH_INPUT_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>标题（可选；缺省用文件名）</span>
          <input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder="如：SSAV: Selective State-Space Model for Saliency Detection" />
        </label>
        <div className="research-inputs-actions">
          <button
            type="button"
            className="btn"
            data-testid="research-input-upload"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            <Icon name="upload" /> {busy ? "登记中…" : "上传并登记 PDF"}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".pdf,application/pdf"
            hidden
            onChange={(event) => {
              onFile(event.target.files?.[0] ?? null);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            className="btn btn-primary"
            data-testid="thesis-start-run"
            disabled={createRun.isPending || list.length === 0}
            onClick={async () => {
              setError(null);
              try {
                await createRun.mutateAsync({ projectId });
                setNotice("学位论文工作流已启动——请到「工作流」面板处理作者确认节点。");
              } catch (runError) {
                setError(formatApiError(runError as Error));
              }
            }}
          >
            {createRun.isPending ? "启动中…" : "启动学位论文工作流"}
          </button>
        </div>
      </div>

      {error !== null ? <ErrorState>{error}</ErrorState> : null}
      {notice !== null ? <p className="panel-note" role="status">{notice}</p> : null}

      <div className="research-inputs-list" data-testid="research-inputs-list">
        <h3>研究输入（{list.length}）</h3>
        {inputs.isLoading ? <p className="panel-note">加载中…</p> : null}
        {list.length === 0 && !inputs.isLoading ? (
          <p className="panel-note">尚未登记任何研究材料。上传至少一份材料后即可启动学位论文工作流。</p>
        ) : null}
        <ul>
          {list.map((input) => (
            <li key={input.inputId} data-testid={`research-input-${input.inputId}`}>
              <div className="research-input-head">
                <strong>{input.title}</strong>
                <span className={`badge scope-${input.scope}`}>{SCOPE_LABELS[input.scope] ?? input.scope}</span>
                <span className="badge">{PARSE_LABELS[input.parseStatus] ?? input.parseStatus}</span>
                <span className="badge">{labelFor(input.inputType)}</span>
              </div>
              <div className="research-input-meta">
                <span>{input.inputId}</span>
                {input.versionLabel !== undefined ? <span>版本：{input.versionLabel}</span> : null}
                {input.publicationStatus !== undefined ? <span>发表状态：{input.publicationStatus}</span> : null}
              </div>
              <div className="research-input-ops">
                {input.scope === "proposed" ? (
                  <>
                    <button type="button" className="text-button" onClick={() => void decision({ type: "scope_decision", inputId: input.inputId, scope: "included", rationale: "面板快捷决定" }, `已入选：${input.title}`)}>入选</button>
                    <button type="button" className="text-button" onClick={() => void decision({ type: "scope_decision", inputId: input.inputId, scope: "excluded", rationale: "面板快捷决定" }, `已排除：${input.title}`)}>排除</button>
                  </>
                ) : null}
                {input.scope === "included" && input.unpublishedMaterialAllowed === undefined && input.inputType !== "published_paper" ? (
                  <button type="button" className="text-button" onClick={() => void decision({ type: "unpublished_material_policy", inputId: input.inputId, allowed: true, rationale: "面板快捷决定" }, `已允许未发表材料进入学位论文：${input.title}`)}>允许未发表材料</button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="research-inputs-conflicts" data-testid="research-inputs-conflicts">
        <h3>未裁决冲突（{unresolved.length}）</h3>
        {unresolved.length === 0 ? (
          <p className="panel-note">没有未裁决的数值冲突。</p>
        ) : (
          <ul>
            {unresolved.map((conflict) => (
              <li key={conflict.conflictId}>
                <div className="research-input-head">
                  <strong>{conflict.classification === "value_mismatch" ? "同实验异值" : conflict.classification}</strong>
                  <span className={`badge ${conflict.severity === "blocking" ? "badge-danger" : ""}`}>{conflict.severity}</span>
                </div>
                <ul className="conflict-parties">
                  {conflict.parties.map((party) => (
                    <li key={party.factId}><code>{party.raw}</code><span>{party.location}</span></li>
                  ))}
                </ul>
                <div className="research-input-ops">
                  {conflict.parties.slice(0, 2).map((party, index) => (
                    <button
                      key={party.factId}
                      type="button"
                      className="text-button"
                      onClick={() => void decision(
                        { type: "conflict_resolution", conflictId: conflict.conflictId, decision: "adopt_fact", adoptedFactId: party.factId, rationale: "面板快捷裁决" },
                        `已采纳${index === 0 ? "第一" : "第二"}方数值（${party.raw}）`,
                      )}
                    >
                      采纳 {party.raw}
                    </button>
                  ))}
                  <button type="button" className="text-button" onClick={() => void decision({ type: "conflict_resolution", conflictId: conflict.conflictId, decision: "keep_both", rationale: "面板快捷裁决" }, "已声明双方并存")}>并存声明</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <MissingMaterialPanel projectId={projectId} />
    </section>
  );
}

function labelFor(type: ResearchInputType): string {
  return RESEARCH_INPUT_TYPE_OPTIONS.find((option) => option.value === type)?.label ?? type;
}
