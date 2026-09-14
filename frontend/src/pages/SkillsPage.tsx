import { useState } from "react";

import { ErrorState, Loading } from "../components/common/StateViews.js";
import { PageHeader } from "../components/common/PageHeader.js";
import { RegistryStatus } from "../components/common/StatusBadge.js";
import { SKILL_STATUS_STYLES, statusStyleOf } from "../components/common/status.js";
import {
  useApplySkillUpdate,
  useInstallSkill,
  useRegenerateSkillSummary,
  useSkillProvenance,
  useSkillUpdatePreview,
  useSkills,
} from "../hooks/queries.js";
import { formatApiError, formatApiErrorDetail } from "../utils/errors.js";
import type { SkillBindingView, SkillCatalogEntry, SkillView } from "../types/paper.js";

/**
 * Skills（M5.3 受控 Skill 设置）：approved catalog 内的 Skill 一览——名称 / 用途 /
 * 来源 / 固定 revision / 安装状态 / hash 摘要 / 绑定的 role + contextScope /
 * update 状态；支持 install approved Skill、预览并应用审计过的更新、查看 provenance。
 * 没有 Marketplace、没有任意 URL 输入框、绑定只读展示（路由为代码内控常量）。
 */

const AGENT_ROLE_LABELS: Record<string, string> = {
  researcher: "调研",
  writer: "写作",
  reviewer: "审阅",
  citation: "引用核验",
};

function roleLabel(role: string): string {
  const label = AGENT_ROLE_LABELS[role];
  return label !== undefined ? `${label}（${role}）` : role;
}

function shortHash(hash: string | undefined): string {
  return hash !== undefined && hash !== "" ? hash.slice(0, 12) : "—";
}

function bindingsOf(skillId: string, bindings: SkillBindingView[]): SkillBindingView[] {
  return bindings.filter((binding) => binding.skillIds.includes(skillId));
}

function UpdatePanel({ skill }: { skill: SkillView }) {
  const [open, setOpen] = useState(false);
  const preview = useSkillUpdatePreview(skill.id, open);
  const apply = useApplySkillUpdate();
  const update = skill.update;
  if (update === undefined || !update.available) {
    return null;
  }
  return (
    <div className="skill-update" data-testid={`skill-update-${skill.id}`}>
      <div className="skill-update-head">
        <span className="chip chip-tone-warn">有可用更新</span>
        <span className="mono muted">
          {shortHash(update.currentHash)} → {shortHash(update.candidateHash)}
        </span>
        <button type="button" className="btn-secondary" onClick={() => setOpen((value) => !value)}>
          {open ? "收起预览" : "预览更新"}
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={!open || preview.isPending || preview.isError || apply.isPending}
          onClick={() => {
            if (preview.data !== undefined) {
              apply.mutate({ skillId: skill.id, candidateHash: preview.data.candidateHash });
            }
          }}
          title={!open ? "请先预览更新" : undefined}
        >
          {apply.isPending ? "应用中…" : "应用更新"}
        </button>
      </div>
      {apply.isError ? <p className="form-error">应用失败：{formatApiError(apply.error)}</p> : null}
      {open ? (
        preview.isPending ? (
          <Loading label="加载更新预览…" />
        ) : preview.isError ? (
          <p className="form-error">预览失败：{formatApiError(preview.error)}</p>
        ) : (
          <div className="skill-update-body">
            <dl className="meta-list meta-list-2col">
              <div>
                <dt>当前 hash</dt>
                <dd className="mono">{preview.data.currentHash}</dd>
              </div>
              <div>
                <dt>候选 hash</dt>
                <dd className="mono">{preview.data.candidateHash}</dd>
              </div>
              <div>
                <dt>当前 revision</dt>
                <dd className="mono">{preview.data.currentRevision ?? "—"}</dd>
              </div>
              <div>
                <dt>候选 revision</dt>
                <dd className="mono">{preview.data.candidateRevision ?? "—"}</dd>
              </div>
            </dl>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>文件</th>
                    <th>变化</th>
                    <th>字节（当前 → 候选）</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.data.files.map((file) => (
                    <tr key={file.path}>
                      <td className="mono">{file.path}</td>
                      <td>{file.status}</td>
                      <td className="mono">
                        {file.currentBytes ?? "—"} → {file.candidateBytes ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted">
              SKILL.md：+{preview.data.skillMdDiff.added} / −{preview.data.skillMdDiff.removed}
              {preview.data.skillMdDiff.truncated ? "（样本已截断）" : ""}
            </p>
            {preview.data.skillMdDiff.hunks.length > 0 ? (
              <pre className="skill-diff" data-testid="skill-diff">
                {preview.data.skillMdDiff.hunks.join("\n")}
              </pre>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}

function ProvenancePanel({ skill }: { skill: SkillView }) {
  const [open, setOpen] = useState(false);
  const provenance = useSkillProvenance(skill.id, open);
  return (
    <div className="skill-provenance">
      <button type="button" className="btn-link" onClick={() => setOpen((value) => !value)}>
        {open ? "收起来源与许可" : "查看来源与许可（PROVENANCE / LICENSE）"}
      </button>
      {open ? (
        provenance.isPending ? (
          <Loading label="加载审计材料…" />
        ) : provenance.isError ? (
          <p className="form-error">加载失败：{formatApiError(provenance.error)}</p>
        ) : (
          <div className="details-body">
            {provenance.data.upstreamSnapshot !== undefined ? (
              <p className="muted">
                上游快照 {provenance.data.upstreamSnapshot.file}：
                {provenance.data.upstreamSnapshot.matchesRecorded === true
                  ? "与记录 hash 一致"
                  : provenance.data.upstreamSnapshot.matchesRecorded === false
                    ? "与记录 hash 不一致"
                    : "未记录 hash"}
              </p>
            ) : null}
            <pre className="skill-provenance-text" data-testid={`skill-provenance-${skill.id}`}>
              {provenance.data.provenance || "（无 PROVENANCE.md）"}
            </pre>
            <details className="details-block">
              <summary>LICENSE</summary>
              <pre className="skill-provenance-text">{provenance.data.license || "（无 LICENSE）"}</pre>
            </details>
          </div>
        )
      ) : null}
    </div>
  );
}

function SkillItem({ skill, bindings }: { skill: SkillView; bindings: SkillBindingView[] }) {
  const regenerate = useRegenerateSkillSummary();
  const status = statusStyleOf(SKILL_STATUS_STYLES, skill.status);
  const bound = bindingsOf(skill.id, bindings);

  return (
    <article className="skill-item" id={`skill-${skill.id}`}>
      <div className="skill-head">
        <h2 className="skill-name mono">{skill.name}</h2>
        <RegistryStatus style={status} />
        {skill.integrity === "tampered" ? <span className="chip chip-tone-danger">内容被改写，已停用注入</span> : null}
        {skill.disabledByConfig ? <span className="chip chip-tone-warn">配置禁用（不注入）</span> : null}
        {skill.update?.available === true ? <span className="chip chip-tone-warn">有可用更新</span> : null}
        {skill.summaryStatus === "summary_pending" ? (
          <span className="chip">简介待生成</span>
        ) : skill.summaryStatus === "stale" ? (
          <span className="chip chip-tone-warn">简介待更新</span>
        ) : null}
      </div>

      {skill.purpose !== undefined ? <p className="skill-summary">{skill.purpose}</p> : null}
      {skill.chineseSummary !== undefined ? (
        <p className={skill.purpose !== undefined ? "skill-original" : "skill-summary"}>{skill.chineseSummary}</p>
      ) : skill.purpose === undefined ? (
        <>
          <p className="skill-summary muted">中文简介待生成：模型配置后会自动补齐；下面是原始描述。</p>
          <p className="skill-original">{skill.originalDescription}</p>
        </>
      ) : null}

      <dl className="meta-list meta-list-2col skill-meta">
        <div>
          <dt>来源</dt>
          <dd className="mono">{skill.sourceRepo ?? skill.sourceType}</dd>
        </div>
        <div>
          <dt>固定 revision</dt>
          <dd className="mono" title={skill.sourceRevision}>
            {skill.sourceRevision !== undefined ? skill.sourceRevision.slice(0, 12) : "—"}
          </dd>
        </div>
        <div>
          <dt>content hash</dt>
          <dd className="mono" title={skill.contentHash}>
            {shortHash(skill.contentHash)}
          </dd>
        </div>
        <div>
          <dt>许可证</dt>
          <dd>{skill.license ?? "—"}</dd>
        </div>
      </dl>

      <div className="skill-tags">
        <span className="skill-tags-label">绑定</span>
        {bound.length > 0 ? (
          bound.map((binding) => (
            <span key={`${binding.agentRole}:${binding.contextScope ?? "*"}`} className="chip">
              {roleLabel(binding.agentRole)}
              {binding.contextScope !== undefined ? ` · ${binding.contextScope}` : " · 默认"}
            </span>
          ))
        ) : (
          <span className="muted">未绑定任何角色</span>
        )}
      </div>

      <UpdatePanel skill={skill} />

      <div className="skill-footer">
        <button type="button" className="btn-link" onClick={() => regenerate.mutate(skill.id)} disabled={regenerate.isPending}>
          {regenerate.isPending ? "生成中…" : "重新生成中文简介"}
        </button>
        {regenerate.isError ? <span className="form-error">生成失败：{formatApiError(regenerate.error)}</span> : null}
        <ProvenancePanel skill={skill} />
        <details className="details-block">
          <summary>技术信息</summary>
          <div className="details-body">
            {skill.wrapperNote !== undefined ? <p style={{ marginBottom: "var(--s-3)" }}>{skill.wrapperNote}</p> : null}
            <dl className="meta-list meta-list-2col">
              <div>
                <dt>完整 revision</dt>
                <dd className="mono">{skill.sourceRevision ?? "—"}</dd>
              </div>
              <div>
                <dt>上游路径</dt>
                <dd className="mono">{skill.upstreamPath ?? "—"}</dd>
              </div>
              <div>
                <dt>版本</dt>
                <dd className="mono">{skill.version ?? "—"}</dd>
              </div>
              <div>
                <dt>bundle hash</dt>
                <dd className="mono">{shortHash(skill.bundleHash)}</dd>
              </div>
              <div>
                <dt>允许使用的工具</dt>
                <dd>{skill.allowedTools.length > 0 ? skill.allowedTools.join(", ") : "无工具假设"}</dd>
              </div>
              <div>
                <dt>原始描述</dt>
                <dd>{skill.originalDescription}</dd>
              </div>
              <div>
                <dt>安装路径</dt>
                <dd className="mono">{skill.installedPath}</dd>
              </div>
              <div>
                <dt>安装 / 更新时间</dt>
                <dd className="mono">
                  {skill.installedAt} / {skill.updatedAt}
                </dd>
              </div>
            </dl>
          </div>
        </details>
      </div>
    </article>
  );
}

function CatalogItem({ entry }: { entry: SkillCatalogEntry }) {
  const install = useInstallSkill();
  return (
    <article className="skill-item skill-item-catalog" id={`catalog-${entry.id}`}>
      <div className="skill-head">
        <h2 className="skill-name mono">{entry.name}</h2>
        <span className="chip">未安装（approved）</span>
      </div>
      {entry.purpose !== undefined ? <p className="skill-summary">{entry.purpose}</p> : null}
      <dl className="meta-list meta-list-2col skill-meta">
        <div>
          <dt>来源</dt>
          <dd className="mono">{entry.sourceRepo ?? "—"}</dd>
        </div>
        <div>
          <dt>固定 revision</dt>
          <dd className="mono">{entry.sourceRevision !== undefined ? entry.sourceRevision.slice(0, 12) : "—"}</dd>
        </div>
        <div>
          <dt>许可证</dt>
          <dd>{entry.license ?? "—"}</dd>
        </div>
      </dl>
      <div className="skill-footer">
        <button type="button" className="btn-primary" disabled={install.isPending} onClick={() => install.mutate(entry.id)}>
          {install.isPending ? "安装中…" : "安装"}
        </button>
        {install.isError ? <span className="form-error">安装失败：{formatApiError(install.error)}</span> : null}
      </div>
    </article>
  );
}

export function SkillsPage() {
  const { data, isPending, isError, error, refetch } = useSkills();
  const sub = "Agent 可用的专业能力（受控 Skill：仓库内审计、固定上游 revision）";

  if (isPending) {
    return (
      <section className="page">
        <PageHeader title="Skills" sub={sub} />
        <Loading label="加载 Skills…" />
      </section>
    );
  }
  if (isError) {
    return (
      <section className="page">
        <PageHeader title="Skills" sub={sub} />
        <ErrorState title="Skills 加载失败" message={formatApiError(error)} detail={formatApiErrorDetail(error)} onRetry={() => void refetch()} />
      </section>
    );
  }
  const notInstalled = data.catalog.filter((entry) => !entry.installed);
  if (data.skills.length === 0 && notInstalled.length === 0) {
    return (
      <section className="page">
        <PageHeader title="Skills" sub={sub} />
        <div className="state-block state-empty">
          <strong>当前没有已安装的 Skill</strong>
          <span>Skill 安装后自动按 Agent 角色与 contextScope 注入对应任务。</span>
        </div>
      </section>
    );
  }

  return (
    <section className="page">
      <PageHeader
        title="Skills"
        sub={`${data.skills.length} 个已安装能力，按 Agent 角色 + contextScope 绑定；任务只加载 Skill 名称与简介，正文按需读取；会话内 Skill 版本固定，更新只影响新会话。`}
      />
      <div className="skill-list">
        {data.skills.map((skill) => (
          <SkillItem key={skill.id} skill={skill} bindings={data.bindings} />
        ))}
      </div>

      {notInstalled.length > 0 ? (
        <section className="panel">
          <div className="section-head">
            <h2>可安装（approved catalog）</h2>
          </div>
          <div className="skill-list">
            {notInstalled.map((entry) => (
              <CatalogItem key={entry.id} entry={entry} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="section-head">
          <h2>角色 / contextScope 绑定</h2>
        </div>
        <p className="muted">绑定为代码内控路由（role + contextScope 前缀，最长前缀优先）；只能引用 approved catalog 中的 Skill。</p>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Agent 角色</th>
                <th>contextScope</th>
                <th>Skills</th>
              </tr>
            </thead>
            <tbody>
              {data.bindings.map((binding) => (
                <tr key={`${binding.agentRole}:${binding.contextScope ?? "*"}`}>
                  <td>{roleLabel(binding.agentRole)}</td>
                  <td className="mono">{binding.contextScope ?? "（默认）"}</td>
                  <td>
                    {binding.skillIds.length > 0
                      ? binding.skillIds.map((skillId, index) => (
                          <span key={skillId}>
                            {index > 0 ? "，" : ""}
                            <a href={`#skill-${skillId}`} className="mono">
                              {skillId}
                            </a>
                          </span>
                        ))
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}
