import { useState } from "react";

import { ErrorState, Loading } from "../components/common/StateViews.js";
import { useRegenerateSkillSummary, useSkills } from "../hooks/queries.js";

/**
 * Skills 页面（M4.3.7）：已安装 Skill 的元数据展示——中文简介（主要）、
 * 原始 description（次要可折叠）、Assigned Agents、来源与 pin revision、
 * License、Allowed Tools、Status。
 *
 * 不显示 Install/Uninstall/Update 等未实现功能的按钮（M5 再做写操作）。
 */

function SkillCard({ skill }: { skill: import("../types/paper.js").SkillView }) {
  const [showOriginal, setShowOriginal] = useState(false);
  const regenerate = useRegenerateSkillSummary();
  return (
    <div className="panel skill-card">
      <div className="skill-head">
        <h2 className="mono">{skill.name}</h2>
        <span className={`chip status-${skill.status}`}>{skill.status}</span>
        {skill.summaryStatus === "stale" ? <span className="chip">简介待更新</span> : null}
      </div>
      {skill.chineseSummary !== undefined ? (
        <p className="skill-summary">{skill.chineseSummary}</p>
      ) : (
        <p className="skill-summary skill-summary-pending">
          中文简介待生成（模型未配置时显示原始描述；模型可用后自动补齐）。
        </p>
      )}
      <dl className="meta-grid">
        <div>
          <dt>Assigned Agents</dt>
          <dd>{skill.assignedAgents.length > 0 ? skill.assignedAgents.join(", ") : "—"}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>
            {skill.sourceRepo !== undefined ? (
              <>
                {skill.sourceRepo}
                {skill.sourceRevision !== undefined ? (
                  <>
                    {" @ "}
                    <span className="mono">{skill.sourceRevision.slice(0, 7)}</span>
                  </>
                ) : null}
              </>
            ) : (
              skill.sourceType
            )}
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
          <dd>{skill.allowedTools.length > 0 ? skill.allowedTools.join(", ") : "（无工具假设）"}</dd>
        </div>
        <div>
          <dt>Installed</dt>
          <dd className="mono">{skill.installedPath}</dd>
        </div>
      </dl>
      {skill.wrapperNote !== undefined ? (
        <p className="form-note">{skill.wrapperNote}</p>
      ) : null}
      <div className="action-row">
        <button
          type="button"
          className="btn-link"
          onClick={() => setShowOriginal((value) => !value)}
        >
          {showOriginal ? "收起原始描述" : "查看原始描述"}
        </button>
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
      {showOriginal ? (
        <p className="skill-original">{skill.originalDescription}</p>
      ) : null}
    </div>
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
        <div className="panel">
          <h2>Skills</h2>
          <p className="panel-empty">尚未安装任何 Skill。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <p className="page-sub">Skills</p>
          <h1>已安装的 Academic Skills</h1>
          <p className="form-note">
            {data.skills.length} 个 Skill；按 Agent 角色绑定注入 Pi 会话
            （progressive disclosure：仅名称与描述进入系统提示，正文按需读取）。
          </p>
        </div>
      </div>
      <div className="panel-stack">
        {data.skills.map((skill) => (
          <SkillCard key={skill.id} skill={skill} />
        ))}
        <div className="panel">
          <h2>Agent 绑定</h2>
          <table className="runs-table">
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
                  <td>{binding.skillIds.length > 0 ? binding.skillIds.join(", ") : "（无）"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
