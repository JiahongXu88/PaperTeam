import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { ErrorState, Loading } from "../common/StateViews.js";
import { confirmExperimentGroups, confirmExperimentMetricEvidence, editExperimentFile, getExperimentPackage, listExperimentPackages, uploadExperimentPackage, type ExperimentRole } from "../../api/experimentPackages.js";
import { formatApiError } from "../../utils/errors.js";

const roles: ExperimentRole[] = ["main_result", "baseline_result", "ablation_result", "experiment_config", "training_log", "evaluation_log", "dataset_description", "figure_asset", "notebook", "source_code", "documentation", "unknown"];

export function ExperimentPackagesPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  const [evidenceIndex, setEvidenceIndex] = useState<number | null>(null);
  const [claim, setClaim] = useState("");
  const list = useQuery({ queryKey: ["experiment-packages", projectId], queryFn: () => listExperimentPackages(projectId) });
  const currentId = selectedId ?? list.data?.[0]?.packageId ?? null;
  const detail = useQuery({ queryKey: ["experiment-package", projectId, currentId], queryFn: () => getExperimentPackage(projectId, currentId!), enabled: currentId !== null });
  const refresh = async (packageId: string) => {
    await queryClient.invalidateQueries({ queryKey: ["experiment-packages", projectId] });
    await queryClient.invalidateQueries({ queryKey: ["experiment-package", projectId, packageId] });
    await queryClient.invalidateQueries({ queryKey: ["figure-datasets", projectId] });
  };
  const upload = useMutation({
    mutationFn: async () => { if (!file) throw new Error("请选择 ZIP 文件"); return uploadExperimentPackage(projectId, file); },
    onSuccess: async (item) => { setSelectedId(item.packageId); setMessage("已读取实验包；请检查候选分组与指标，再确认可用结果。"); await refresh(item.packageId); },
  });
  const edit = useMutation({
    mutationFn: (input: { path: string; role: ExperimentRole; groupId: string }) => editExperimentFile(projectId, currentId!, input),
    onSuccess: async () => { setMessage("文件分类已更新，先前分组确认已失效。"); await refresh(currentId!); },
  });
  const confirm = useMutation({
    mutationFn: (groupIds: string[]) => confirmExperimentGroups(projectId, currentId!, groupIds),
    onSuccess: async () => { setMessage("作者确认已保存；有来源的数据现在可在学术图表中选择。"); await refresh(currentId!); },
  });
  const evidence = useMutation({
    mutationFn: async () => {
      const observation = detail.data?.observations[evidenceIndex ?? -1];
      if (!observation) throw new Error("请选择一条指标");
      return confirmExperimentMetricEvidence(projectId, observation, claim);
    },
    onSuccess: (result) => { setMessage(`已登记 ${result.evidence.id}：${result.evidence.verificationLevel} / ${result.evidence.verificationStatus}；仍需独立核验。`); setEvidenceIndex(null); setClaim(""); },
  });
  return <section className="panel" aria-label="实验数据包">
    <h2>实验数据包</h2>
    <p className="muted">上传 ZIP 后查看文件、候选关系和真实解析值。分类与分组是建议；作者确认不等于 Evidence Verification。</p>
    <div className="form-row">
      <label>选择 ZIP <input aria-label="选择实验 ZIP" type="file" accept=".zip,application/zip" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
      <button type="button" disabled={!file || upload.isPending} onClick={() => upload.mutate()}>{upload.isPending ? "上传并解析中…" : "上传实验包"}</button>
    </div>
    <p className="muted">上限：ZIP 16 MiB、200 个文件、单文件 20 MiB、解压总量 64 MiB；不会执行包内代码。目录可先在本机压缩为 ZIP。</p>
    {upload.isError && <p role="alert" className="run-error">{formatApiError(upload.error)}</p>}
    {evidence.isError && <p role="alert" className="run-error">{formatApiError(evidence.error)}</p>}
    {(edit.isError || confirm.isError) && <p role="alert" className="run-error">{formatApiError(edit.error ?? confirm.error)}</p>}
    {message && <p role="status">{message}</p>}
    {list.isPending ? <Loading label="加载实验包…" /> : list.isError ? <ErrorState title="实验包加载失败" message={formatApiError(list.error)} onRetry={() => void list.refetch()} /> : <>
      {list.data?.length === 0 && <p className="panel-empty">尚无实验数据包。</p>}
      {list.data && list.data.length > 0 && <label>选择实验包 <select aria-label="实验包" value={currentId ?? ""} onChange={(event) => setSelectedId(event.target.value)}>
        {list.data.map((item) => <option key={item.packageId} value={item.packageId}>{item.originalName} · {item.status}</option>)}
      </select></label>}
    </>}
    {currentId && (detail.isPending ? <Loading label="加载实验包详情…" /> : detail.isError ? <ErrorState title="实验包详情加载失败" message={formatApiError(detail.error)} onRetry={() => void detail.refetch()} /> : detail.data && <>
      <h3>{detail.data.originalName}</h3>
      <p className="muted">状态：{detail.data.status} · SHA-256：{detail.data.packageHash.slice(0, 16)}… · 已解析 {detail.data.files.filter((entry) => entry.parseStatus === "ok").length}/{detail.data.files.length} 文件</p>
      {detail.data.warnings.length > 0 && <ul>{detail.data.warnings.map((warning, index) => <li key={index} className="note-warn-line">{warning}</li>)}</ul>}
      {detail.data.relationCandidates.length > 0 && <><h3>配置与结果关联候选</h3><ul>{detail.data.relationCandidates.map((relation) => <li key={`${relation.configPath}-${relation.groupId}`}>
        {relation.configPath} → {relation.groupId} · {relation.status}；相符：{relation.matchedFields.join(", ") || "无"}；冲突：{relation.conflictingFields.join(", ") || "无"}
      </li>)}</ul></>}
      <h3>实验分组</h3>
      <ul>{detail.data.groups.map((group) => <li key={group.id}>
        <strong>{group.id}</strong> · {group.role} · {group.status} · {group.filePaths.length} 文件
        <div className="muted">依据：{group.basis}</div>
        {group.conflicts.map((conflict) => <p key={conflict} className="run-error">{conflict}</p>)}
        {group.status !== "confirmed" && <button type="button" disabled={confirm.isPending || group.status === "conflict"} onClick={() => confirm.mutate([group.id])}>确认此组</button>}
      </li>)}</ul>
      {detail.data.groups.some((group) => group.status === "candidate") && <button type="button" disabled={confirm.isPending} onClick={() => confirm.mutate(detail.data!.groups.filter((group) => group.status === "candidate").map((group) => group.id))}>批量确认无冲突分组</button>}
      <h3>文件清单</h3>
      <div style={{ overflowX: "auto" }}><table><thead><tr><th>路径</th><th>大小</th><th>类型 / 解析</th><th>候选角色</th><th>实验组</th><th>来源</th></tr></thead><tbody>
        {detail.data.files.map((entry) => <tr key={entry.path}>
          <td>{entry.path}<br /><small>SHA {entry.hash.slice(0, 12)}…</small></td><td>{entry.bytes} B</td><td>{entry.kind} / {entry.parseStatus}{entry.warning && <small className="run-error"> {entry.warning}</small>}</td>
          <td><select aria-label={`${entry.path} 角色`} value={entry.role} disabled={edit.isPending} onChange={(event) => edit.mutate({ path: entry.path, role: event.target.value as ExperimentRole, groupId: entry.groupId })}>{roles.map((role) => <option key={role} value={role}>{role}</option>)}</select><small>{entry.roleBasis} · {entry.roleConfidence}</small></td>
          <td><input aria-label={`${entry.path} 分组`} defaultValue={entry.groupId} key={`${entry.path}-${entry.groupId}`} onBlur={(event) => { const groupId = event.target.value.trim(); if (groupId && groupId !== entry.groupId) edit.mutate({ path: entry.path, role: entry.role, groupId }); }} /></td>
          <td>{entry.sourceId ?? "未建立 Source"}</td>
        </tr>)}
      </tbody></table></div>
      <h3>指标观测（原始值）</h3>
      <p className="muted">单位与优化方向为 unknown 时不计算相对提升；同一模型的多 seed 不自动选优。每行保留来源锚。</p>
      <div style={{ overflowX: "auto" }}><table><thead><tr><th>实验组</th><th>Method</th><th>Dataset</th><th>Seed</th><th>Metric</th><th>Value</th><th>来源</th></tr></thead><tbody>
        {detail.data.observations.slice(0, 100).map((observation, index) => <tr key={`${observation.sourceId}-${observation.blockId}-${observation.metric}-${index}`}>
          <td>{observation.groupId}</td><td>{observation.method ?? "—"}</td><td>{observation.dataset ?? "—"}</td><td>{observation.seed ?? "—"}</td><td>{observation.metric}</td><td>{observation.value}</td>
          <td>{observation.path} · {observation.sourceId}/{observation.blockId} {observation.sheet ?? ""} {observation.row ? `row ${observation.row}` : ""} {observation.column ?? observation.jsonPath ?? ""}<br />
            {detail.data!.groups.some((group) => group.id === observation.groupId && group.status === "confirmed") && <button type="button" onClick={() => { setEvidenceIndex(index); setClaim(""); }}>作为作者确认的 Evidence…</button>}
          </td>
        </tr>)}
      </tbody></table></div>
      {detail.data.observations.length > 100 && <p className="muted">仅预览前 100 条；原始解析记录保存在 Source 中。</p>}
      {evidenceIndex !== null && <div className="panel"><label>论文 claim（必须包含原始数值）<input aria-label="Evidence claim" value={claim} onChange={(event) => setClaim(event.target.value)} /></label>
        <button type="button" disabled={!claim.trim() || evidence.isPending} onClick={() => evidence.mutate()}>确认这条来源数据</button><button type="button" onClick={() => setEvidenceIndex(null)}>取消</button>
        <p className="muted">该操作只登记 user_confirmed / unverified，不会自动提升为 grounded_verified。</p>
      </div>}
      {detail.data.groups.some((group) => group.status === "confirmed") && <p><Link to={`?tab=figures`}>用已确认数据生成学术图表 →</Link></p>}
      <p className="muted">已解析 ≠ 已关联 ≠ 作者已确认 ≠ Evidence Verification。实验包不会自动生成 Verified Evidence。</p>
    </>)}
  </section>;
}
