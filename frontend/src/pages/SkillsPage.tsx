import { ErrorState, Loading } from "../components/common/StateViews.js";
import { PageHeader } from "../components/common/PageHeader.js";
import { useRegenerateSkillSummary, useSkills } from "../hooks/queries.js";
import type { SkillView } from "../types/paper.js";

/**
 * Skills 页面（Visual Redesign 2026-09）：每个 Skill 作为「能力」呈现。
 *
 * 主信息：skill 名 + 中文简介 + Assigned Agents + 状态；
 * 来源 / revision / license / 工具 / 路径收进「技术信息」折叠块。
 * 不显示 Install / Uninstall / Update 等未实现功能（M5 再做写操作）。
 */

function SkillCard({ skill }: { skill: SkillView }) {
  const regenerate = useRegenerateSkillSummary();

  return (
    <article className="skill-card" id={skill.name}>
      <div className="skill-head">
        <h2 className="skill-name">{skill.name}</h2>
        {skill.status === "installed" ? (
          <span className="status status-tone-ok">Installed</span>
        ) : (
          <span className="status status-tone-neutral">{skill.status}</span>
        )}
        {skill.summaryStatus === "stale" ? (
          <span className="chip">简介待更新</span>
        ) : null}
      </div>

      {skill.chineseSummary !== undefined ? (
        <p className="skill-summary">{skill.chineseSummary}</p>
      ) : (
        <p className="skill-summary skill-summary-pending">
          中文简介待生成（模型未配置时显示原始描述；模型可用后自动补齐）。
        </p>
      )}

      {skill.assignedAgents.length > 0 ? (
        <div className="skill-tags">
          {skill.assignedAgents.map((agent) => (
            <span key={agent} className="chip">
              {agent}
            </span>
          ))}
        </div>
      ) : null}

      <div className="skill-footer">
        <button
          type="button"
          className="btn-link"
          onClick={() => regenerate.mutate(skill.id)}
          disabled={regenerate.isPending}
        >
          {regenerate.isPending ? "生成中…" : "重新生成中文简介"}
        </button>
        {regenerate.isError ? (
          <span className="form-error">
            生成失败（{regenerate.error instanceof Error ? regenerate.error.message : "模型可能未配置"}）
          </span>
        ) : null}
      </div>

      <details className="details-block" style={{ marginTop: 14 }}>
        <summary>来源与技术信息</summary>
        <div className="details-body">
          {skill.wrapperNote !== undefined ? (
            <p className="skill-original" style={{ marginBottom: 12 }}>
              {skill.wrapperNote}
            </p>
          ) : null}
          <dl className="meta-list">
            <div>
              <dt>来源</dt>
              <dd className="mono">
                {skill.sourceRepo ?? skill.sourceType}
                {skill.sourceRevision !== undefined ? ` @ ${skill.sourceRevision.slice(0, 7)}` : ""}
              </dd>
            </div>
            <div>
              <dt>Version / Revision</dt>
              <dd className="mono">
                {skill.version ?? "—"}
                {skill.sourceRevision !== undefined ? ` / ${skill.sourceRevision.slice(0, 12)}` : ""}
              </dd>
            </div>
            <div>
              <dt>License</dt>
              <dd>{skill.license ?? "—"}</dd>
            </div>
            <div>
              <dt>Allowed Tools</dt>
              <dd>
                {skill.allowedTools.length > 0 ? skill.allowedTools.join(", ") : "（无工具假设）"}
              </dd>
            </div>
            <div>
              <dt>原始描述</dt>
              <dd>{skill.originalDescription}</dd>
            </div>
            <div>
              <dt>Installed</dt>
              <dd className="mono">{skill.installedPath}</dd>
            </div>
          </dl>
        </div>
      </details>
    </article>
  );
}

export function SkillsPage() {
  const { data, isPending, isError, error, refetch } = useSkills();

  if (isPending) {
    return (
      <section className="page">
        <Loading label="加载 Skills…" />
      </section>
    );
  }
  if (isError) {
    return (
      <section className="page">
        <ErrorState
          title="Skills 加载失败"
          message={error instanceof Error ? error.message : String(error)}
          onRetry={() => void refetch()}
        />
      </section>
    );
  }
  if (data === undefined || data.skills.length === 0) {
    return (
      <section className="page">
        <PageHeader title="Skills" sub="Agent 可用的专业能力" />
        <div className="panel-coming">
          <strong>尚未安装任何 Skill</strong>
          <span>Skill 将随 Backend skills 目录注入（当前里程碑为只读展示）。</span>
        </div>
      </section>
    );
  }

  return (
    <section className="page">
      <PageHeader
        title="Skills"
        sub={`${data.skills.length} 个已安装能力 · 按 Agent 角色绑定注入 Pi 会话`}
      />
      <div className="skill-list">
        {data.skills.map((skill) => (
          <SkillCard key={skill.id} skill={skill} />
        ))}
      </div>

      <section>
        <div className="section-head">
          <h2>Agent 绑定</h2>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Skills</th>
              </tr>
            </thead>
            <tbody>
              {data.bindings.map((binding) => (
                <tr key={binding.agentRole}>
                  <td className="mono">{binding.agentRole}</td>
                  <td>
                    {binding.skillIds.length > 0
                      ? binding.skillIds.map((skillId, index) => (
                          <span key={skillId}>
                            {index > 0 ? ", " : ""}
                            <a href={`#${skillId}`}>{skillId}</a>
                          </span>
                        ))
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="section-note" style={{ marginTop: 8 }}>
          仅名称与简介注入 Pi 系统提示，正文按需加载。
        </p>
      </section>
    </section>
  );
}
