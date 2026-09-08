import { ErrorState, Loading } from "../components/common/StateViews.js";
import { PageHeader } from "../components/common/PageHeader.js";
import { RegistryStatus } from "../components/common/StatusBadge.js";
import { SKILL_STATUS_STYLES, statusStyleOf } from "../components/common/status.js";
import { useRegenerateSkillSummary, useSkills } from "../hooks/queries.js";
import { formatApiError, formatApiErrorDetail } from "../utils/errors.js";
import type { SkillView } from "../types/paper.js";

/**
 * Skills：Agent 可用的专业能力。主信息 = 名称 + 中文简介 + 分配给哪些角色 + 状态；
 * 来源 / 修订版本 / 许可证 / 工具 / 路径折叠进「来源与技术信息」。
 * 不显示 Install / Uninstall 等尚未实现的写操作。
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

function SkillItem({ skill }: { skill: SkillView }) {
  const regenerate = useRegenerateSkillSummary();
  const status = statusStyleOf(SKILL_STATUS_STYLES, skill.status);

  return (
    <article className="skill-item" id={`skill-${skill.id}`}>
      <div className="skill-head">
        <h2 className="skill-name mono">{skill.name}</h2>
        <RegistryStatus style={status} />
        {skill.summaryStatus === "summary_pending" ? <span className="chip">简介待生成</span> : skill.summaryStatus === "stale" ? <span className="chip chip-tone-warn">简介待更新</span> : null}
      </div>

      {skill.chineseSummary !== undefined ? (
        <p className="skill-summary">{skill.chineseSummary}</p>
      ) : (
        <p className="skill-summary muted">中文简介待生成：模型配置后会自动补齐；下面是原始描述。</p>
      )}
      {skill.chineseSummary === undefined ? <p className="skill-original">{skill.originalDescription}</p> : null}

      {skill.assignedAgents.length > 0 ? (
        <div className="skill-tags">
          <span className="skill-tags-label">分配给</span>
          {skill.assignedAgents.map((agent) => (
            <span key={agent} className="chip">
              {roleLabel(agent)}
            </span>
          ))}
        </div>
      ) : null}

      <div className="skill-footer">
        <button type="button" className="btn-link" onClick={() => regenerate.mutate(skill.id)} disabled={regenerate.isPending}>
          {regenerate.isPending ? "生成中…" : "重新生成中文简介"}
        </button>
        {regenerate.isError ? <span className="form-error">生成失败：{formatApiError(regenerate.error)}</span> : null}
        <details className="details-block">
          <summary>来源与技术信息</summary>
          <div className="details-body">
            {skill.wrapperNote !== undefined ? <p style={{ marginBottom: "var(--s-3)" }}>{skill.wrapperNote}</p> : null}
            <dl className="meta-list meta-list-2col">
              <div>
                <dt>来源</dt>
                <dd className="mono">
                  {skill.sourceRepo ?? skill.sourceType}
                  {skill.sourceRevision !== undefined ? ` @ ${skill.sourceRevision.slice(0, 7)}` : ""}
                </dd>
              </div>
              <div>
                <dt>版本 / 修订版本</dt>
                <dd className="mono">
                  {skill.version ?? "—"}
                  {skill.sourceRevision !== undefined ? ` / ${skill.sourceRevision.slice(0, 12)}` : ""}
                </dd>
              </div>
              <div>
                <dt>许可证</dt>
                <dd>{skill.license ?? "—"}</dd>
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
            </dl>
          </div>
        </details>
      </div>
    </article>
  );
}

export function SkillsPage() {
  const { data, isPending, isError, error, refetch } = useSkills();

  if (isPending) {
    return (
      <section className="page">
        <PageHeader title="Skills" sub="Agent 可用的专业能力" />
        <Loading label="加载 Skills…" />
      </section>
    );
  }
  if (isError) {
    return (
      <section className="page">
        <PageHeader title="Skills" sub="Agent 可用的专业能力" />
        <ErrorState title="Skills 加载失败" message={formatApiError(error)} detail={formatApiErrorDetail(error)} onRetry={() => void refetch()} />
      </section>
    );
  }
  if (data.skills.length === 0) {
    return (
      <section className="page">
        <PageHeader title="Skills" sub="Agent 可用的专业能力" />
        <div className="state-block state-empty">
          <strong>当前没有已安装的 Skill</strong>
          <span>Skill 安装后自动按 Agent 角色注入对应任务。</span>
        </div>
      </section>
    );
  }

  return (
    <section className="page">
      <PageHeader title="Skills" sub={`${data.skills.length} 个已安装能力，按 Agent 角色绑定；任务只加载 Skill 名称与简介，正文按需读取。`} />
      <div className="skill-list">
        {data.skills.map((skill) => (
          <SkillItem key={skill.id} skill={skill} />
        ))}
      </div>

      <section className="panel">
        <div className="section-head">
          <h2>角色绑定</h2>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Agent 角色</th>
                <th>Skills</th>
              </tr>
            </thead>
            <tbody>
              {data.bindings.map((binding) => (
                <tr key={binding.agentRole}>
                  <td>{roleLabel(binding.agentRole)}</td>
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
