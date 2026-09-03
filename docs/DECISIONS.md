# PaperTeam 技术决策记录（ADR）

> 状态取值：`proposed`（提议中）/ `accepted`（已接受）/ `superseded`（已被取代，注明替代者）。
> 新决策追加在文末，不修改历史条目。

---

## D-0001 Web 前端 + Linux Server 架构

- **日期**：2026-08-31
- **状态**：accepted

**背景**：目标用户（本科生、硕博研究生、科研人员、教师）不应接触命令行、Git、LaTeX 环境或 OpenClaw 配置；系统需支持长期部署与日常运维。

**决策**：浏览器是唯一用户入口；论文写作、Agent 调度、模型调用、LaTeX 编译、PDF 生成、版本管理、日志与系统维护全部在 Linux 服务器完成。

**影响**：前端只需 Web 技术栈；服务器端需要完整的运维能力，因此产品包含系统管理后台（诊断、日志、Command Center、Web Terminal）。

---

## D-0002 使用 OpenClaw 作为 Agent Runtime

- **日期**：2026-08-31
- **状态**：accepted

**背景**：Agent Team 需要 Session、Task、事件流、多 Agent 调度等成熟能力，自研成本高。

**决策**：第一版 Agent Runtime 采用 OpenClaw（OpenClaw Gateway），Agent 以 OpenClaw 体系承载。

**影响**：服务器需常驻 OpenClaw Gateway 并纳入运维（状态监控、重启、诊断）；Gateway 作为内部服务，不对外暴露。

---

## D-0003 以 AgentRuntimeAdapter 隔离 Runtime

- **日期**：2026-08-31
- **状态**：accepted

**背景**：业务层若直接耦合 OpenClaw API，未来替换或扩展 Agent Runtime 的成本极高。

**决策**：Backend 只依赖统一的 `AgentRuntime` 接口（runAgent / getTask / cancelTask / sendMessage / streamEvents / healthCheck），由 `OpenClawRuntimeAdapter` 提供第一版实现。

**影响**：业务层表达"调用哪个 Agent、执行什么任务、输入什么文件、获取状态与结果"，不感知 Gateway 细节；未来可替换 Runtime、新增 Agent / Reviewer / 模型而不动业务层。

---

## D-0004 LaTeX 作为论文主格式

- **日期**：2026-08-31
- **状态**：accepted

**背景**：学术论文需要专业排版、模板（学校/期刊）、公式图表与稳定编译产物；Markdown 等格式无法满足。

**决策**：论文主格式为 LaTeX；服务器使用 XeLaTeX + latexmk + Biber 编译输出 PDF；版本用 Git 管理，前端只暴露业务版本号（V12/V13…）。

**影响**：服务器需安装 TeX Live（体积较大，Docker 镜像需考虑体积控制）；需要 LaTeX Engineer Agent 处理编译错误与排版问题（后归为确定性工具，见 D-0009）；Writer Agent 输出 LaTeX 而非纯文本。

---

## D-0005 双模式前端：论文工作台 + 系统管理后台

- **日期**：2026-08-31
- **状态**：accepted

**背景**：普通用户与管理员的关注点、权限、使用频率完全不同。

**决策**：前端提供两种工作模式并支持顶部切换——论文工作台（普通用户）与系统管理后台（管理员）。

**影响**：权限模型至少分两级；普通用户界面隐藏 session / agentId / Gateway 等技术信息，只展示业务阶段。

---

## D-0006 多 Agent 覆盖写作、事实核验、学术审稿、文风审查、视觉审稿

- **日期**：2026-08-31
- **状态**：superseded（2026-09-03，由 D-0008 / D-0009 取代）

**背景**：论文质量是多维的（事实真实性、学术质量、AI 文风风险、视觉排版），单一 Agent 无法覆盖。

**决策**：Agent Team 分工——Paper Manager（调度）、Researcher（文献与 Evidence）、Writer（写作）、Fact Checker（事实核验，输出 SUPPORTED / PARTIALLY_SUPPORTED / UNSUPPORTED / CONTRADICTED）、Academic Reviewer（学术评分）、Style Reviewer（AI 文风风险 0~100）、Final Editor（汇总修改）、LaTeX Engineer（编译修复）、Visual Reviewer（PDF 页面级视觉审查，使用视觉模型）。

**影响**：需要统一的 Evidence Store 与 Review Aggregator；全面审稿三个 Reviewer 可并行；修改闭环有默认通过条件（critical 事实错误 = 0、Academic Score ≥ 80、Style Risk ≤ 35）。

**取代说明**：竞品调研与产品方向复盘后，9-Agent 规划被收敛——Paper Manager 的编排职责改由确定性 WorkflowOrchestrator 承担（D-0008）；Fact Checker / Academic Reviewer / Style Reviewer 并入 Reviewer 的三个 Skill（D-0009）；Final Editor 职责并入 Writer（revision）+ 编排器；LaTeX Engineer 归为确定性工具（M4+）；Visual Reviewer 移入 M4+。多维度审稿可并行、修改闭环默认通过条件等思想由 D-0009 与 PRD Quality Gate 规则延续。

---

## D-0007 服务器端使用 Docker 部署（后续）

- **日期**：2026-08-31
- **状态**：accepted（尚未实施）

**背景**：Linux 服务器手动部署组件多（Node.js、OpenClaw、TeX Live、Poppler、数据库），环境漂移与迁移成本高。

**决策**：后续服务器端使用 Docker 部署，部署配置收敛到仓库 `docker/` 目录。

**影响**：需规划镜像划分（TeX Live 体积）、compose 结构与数据卷（projects/、数据库、日志）；第一阶段开发可先以裸机/systemd 方式运行，Docker 化不阻塞 MVP。

---

## D-0008 Workflow 编排使用确定性 Backend WorkflowOrchestrator

- **日期**：2026-09-03
- **状态**：accepted

**背景**：原规划由 Paper Manager 作为 LLM Agent 负责流程调度与汇总。竞品调研与自身实践表明：用 LLM 做确定性流程编排不可靠（状态漂移、不可重放、无法稳定 resume），论文生产流程的推进规则本质是确定性逻辑，不需要语义判断。

**决策**：流程编排由 Backend TypeScript 确定性代码实现（WorkflowOrchestrator），Paper Manager 不再作为流程控制 Agent 存在。代码负责：状态、stage 推进、retry、timeout、checkpoint、resume、branch、loop、hard gate；LLM 只负责内容理解、语义判断、论文分析与审稿。取代 D-0006 中 Paper Manager 的调度职责。

**影响**：Workflow 可测试、可重放、可恢复；Agent 失败重试策略上收到 StageContract 层；AgentRuntime 层保持无编排职责。M3.0 以此为第一优先建设项。

---

## D-0009 M3 采用少量专业 Agent + Skill，初始 Agent Team 为 Researcher / Writer / Reviewer / Citation

- **日期**：2026-09-03
- **状态**：accepted

**背景**：D-0006 规划了约 9 个 Agent。实践与调研结论：大量细粒度 Agent 带来调度与上下文成本，多数"角色差异"只是 Prompt / Skill 差异；盲目拆 Agent 不提升质量。

**决策**：M3 Agent Team 收敛为 4 个：Researcher（调研与 Evidence）、Writer（分节写作与 revision）、Reviewer（审稿）、Citation（引用核验与 bib 治理）。角色细化优先通过 Skill 完成（Reviewer 下设 fact checking / academic review / style review 三个 skill，可并行）。仅当满足以下实际需求之一才拆独立 Agent：需要不同模型、需要独立长期上下文、需要不同权限、需要真正独立并行资源。取代 D-0006 的 Agent 划分。

**影响**：LaTeX Engineer 归为确定性工具（M4+ repair loop）；Visual Reviewer 移入 M4+；Experiment Agent 移出 M3（backlog / M4+，除非产品正式扩展为自动科研实验平台）；Final Editor 职责由 Writer revision + 编排器承担。

---

## D-0010 支持两类一级 Workflow：Idea-to-Paper 与 Existing-LaTeX Improvement

- **日期**：2026-09-03
- **状态**：accepted

**背景**：产品定位升级为"从研究 Idea 到论文交付，以及已有论文改造"的工作台；只支持从零写作无法覆盖已有论文系统性提升的真实需求。

**决策**：PaperTeam 支持两类一级工作流：Idea-to-Paper（Idea → 调研 → 可行性 → Evidence → 写作 → 审稿 → 修改 → 论文）与 Existing-Paper Improvement（导入已有 LaTeX 项目 → 解析 → Baseline Compile → 理解 → 审计 → 评估 → 计划 → 逐节改造）。两条 Workflow 共享 Evidence、Review、Revision、Build、Quality Gate 后段能力。Existing 导入 MVP 仅支持 LaTeX 项目，不做 DOCX → LaTeX 转换。

**影响**：Project 数据模型引入 workflowKind；新建项目入口分为两类；导入项目需版本快照（baseline）；文档结构需同时描述两条流程。

---

## D-0011 目标档次必须进行 Target Feasibility Assessment，不得承诺无法支撑的目标

- **日期**：2026-09-03
- **状态**：accepted

**背景**：若用户选择 CVPR 而系统直接声称能生成 CVPR 水平论文，是根本性的产品失信；论文层级由 Novelty、Methodology、实验与 Evidence 决定，不是由写作决定。

**决策**：系统在进入写作前（Idea-to-Paper）与制定改造计划前（Existing-Paper Improvement）必须进行 Target Feasibility Assessment：基于现有 Idea、Novelty、Evidence、实验条件、Methodology 与目标要求诚实判断目标层级能否被支撑；结论使用离散档位（HIGH / MEDIUM / LOW / INSUFFICIENT），不使用"83% 成功概率"这类虚假精确数字。无法支撑时必须说明：为什么达不到、缺什么、哪些问题仅靠写作无法解决、应补哪些实验 / Evidence / Novelty、或建议调整目标。

**影响**：成为 PaperTeam 明确产品原则（写入 PRD）；评估后设 Human Checkpoint；targetProfile / targetVenue 调整后重新评估；Quality Gate 按 targetProfile 标准执行。

---

## D-0012 Reference Paper 与 Evidence Source 是不同语义角色，PDF 可标 evidence / reference / both

- **日期**：2026-09-03
- **状态**：accepted

**背景**：用户上传的论文 PDF 存在两种不同用途：回答"这篇论文说了什么"（供引用与核验）与回答"这类论文通常怎么写"（供结构、方法与呈现模式参考）。混为一个概念会导致检索目标错位与误用风险。

**决策**：数据模型引入 sourceRole（evidence / reference / both）。Evidence Source 进入 Evidence 提取与核验链路；Reference Paper 进入多模态结构分析，产出 Reference Style Profile（章节结构、章节比例、图表与引用密度、组织模式等），供 Writer 与 Reviewer 参考。参考论文用于"结构、方法与呈现模式分析"，不是内容抄袭。目标论文档次用 documentType（类型形态）/ targetProfile（档次）/ targetVenue（具体目标）三个维度表达，不使用单一 paperLevel。

**影响**：文献库需支持 sourceRole 标记与按角色的处理管线；Style Profile 是 Derived 产物，可重建；写作与审稿 Prompt 可引用 Style Profile 但禁止复制参考论文内容。

---

## D-0013 Workspace / Evidence / Artifacts 是 authoritative state；Derived Context 可重建；Runtime Session 不作为业务真相

- **日期**：2026-09-03
- **状态**：accepted

**背景**：竞品与 M2.1 经验表明：把对话历史或会话状态当作项目事实来源，会导致流程无法恢复、无法审计、无法迁移。LLM 上下文是易失且不可信的存储。

**决策**：状态分三层——Authoritative State：manuscript/、sources/、evidence/、reviews/、workflow state、artifacts，是项目事实来源；Derived Context：context.yaml、outline summary、section status、terminology summary 等蒸馏产物，可随时由事实来源重新生成，不得成为第二份事实数据库；Runtime Context：OpenClaw Session，disposable，可重建，不承担项目真相。业务流程不能依赖 Chat History 才能恢复；恢复依据是 Workspace 状态与 workflow checkpoint。

**影响**：所有 Stage 产出必须落盘为 Authoritative State；Derived Context 只作为 Agent 输入优化；Session 可随时丢弃重建（M2.1 的 Project ≠ Session 映射是该原则的最小实现，M3 扩展为 projectId × agentId × contextScope）。

---

## D-0014 Workflow 使用线性 Stage + bounded loop + limited fan-out/join，不引入 DAG Engine

- **日期**：2026-09-03
- **状态**：accepted

**背景**：复杂 DAG / Graph Workflow Engine（节点任意连线、动态图）会显著抬高实现与调试成本，而论文生产流程的主干是线性 + 少量循环与并行，表达力收益远低于复杂度代价。

**决策**：Workflow 由线性主干 + 有限条件分支 + bounded loop（修改循环最多 N 轮，超限进入 Human Checkpoint）+ 少量并行 fan-out / join（如三类 review skill 并行）组成，不引入 DAG / Graph Engine。每个 Stage 以 StageContract 描述（stage id、required inputs、produced outputs、definition of done、retry policy、failure type、max attempts）。

**影响**：WorkflowOrchestrator 可保持纯 TypeScript 确定性实现；流程图在文档与 UI 中均可线性呈现；若未来出现真正需要动态图的场景再单独立 ADR。

---

## D-0015 Build Gate 与 Quality Gate 分离；Draft 可在 Quality Gate 失败时构建，Final 必须全部 Gate 通过

- **日期**：2026-09-03
- **状态**：accepted

**背景**：文档能否构建与论文质量是否达标是两个独立问题。若把质量语义塞进编译门（如 not_found citation 禁止编译），用户将无法获得任何产物来评估与迭代，调试与审稿流程被阻断。

**决策**：Build Gate 只判定文档能否构建（LaTeX 语法、references.bib、图片、packages、编译结果）；Quality Gate 判定论文质量是否允许进入 Final（hallucinated citation、not_found citation、unsupported critical claim、unresolved review issue、target requirement 未达到、Evidence 不足）。Draft PDF 只要求 Build Gate 通过；Final 必须 Build Gate + Quality Gate 全部通过；Quality Gate 失败不禁止编译。

**影响**：版本引入 draft / final 标记；PDF 页面区分 Draft / Final 并展示 Quality Gate 阻止项清单；Quality Gate 判定是确定性代码，基于 Reviewer / Citation 的结构化结果与 Evidence 状态（supportStrength / verificationLevel），不以 LLM 自评数值 confidence 为核心依据。

---

## D-0016 contextScope 会话派生规则：projectId × agentId × contextScope，`--` 分隔

- **日期**：2026-09-03
- **状态**：accepted（M3.0 实现时冻结）

**背景**：并行 Reviewer（fact / academic / style 三 skill）共享同一 Agent 定义但需要独立上下文，互不污染（D-0013 的会话维度扩展）。需要冻结 sessionKey 派生规则，且不得破坏 OpenClaw sessionKey 结构（`agent:{agentId}:{peer}`）或造成 scope 串会话。

**决策**：会话维度扩展为 `projectId × agentId × contextScope`；派生规则：

```text
无 scope：agent:{agentId}:paperteam-{projectId}
有 scope：agent:{agentId}:paperteam-{projectId}--{scope}
```

scope 归一化：小写；允许 `[a-z0-9/_-]`；其余字符折叠为 `-`；不产生 `:` 注入；长度 ≤ 48。
scope 取值由 PaperTeam 代码内控（少量固定常量，如 `review/fact`），不接受用户自由输入，
因此折叠的非单射性（空格与字面 `-` 折叠到同一 scope）不构成实际风险。
显式 `sessionKey` 仍优先于派生；M2.1 的无 scope 行为保持不变（回归测试覆盖）。

**影响**：OpenClaw 特有标识仍只存在于 Adapter 内部；业务层通过 `RunAgentInput.contextScope`
表达会话隔离意图；ProjectStore 继续只保存不透明引用。

---

## D-0017 参考论文多模态分析走消息内本地路径（agent 内置 pdf 工具），不把 PDF 作为 agent RPC 附件

- **日期**：2026-09-03
- **状态**：accepted

**背景**：Reference Paper 视觉级分析（图表、版式、结构）需要把 PDF 交给具备视觉能力的
Agent。对照 OpenClaw 2026.8.1 源码确认：`agent` RPC 的 `attachments` 字段只接受
image/*（`acceptNonImage: false`，PDF 会被网关拒绝）；PDF 作为附件的路径只存在于
`chat.send` 入口。Agent 侧存在内置 `pdf` 工具（可读取本地/URL PDF，文本抽取 + 原生
PDF 输入或页面渲染的视觉分析）。

**决策**：PaperTeam 的 PDF 归自己管理（ingestion、存储、元数据、确定性文本层分析）；
多模态层通过 `AgentMultimodalAnalyzer` 扩展点实现——在消息文本中给出服务器本地
PDF 绝对路径，由 Agent 内置 pdf 工具完成视觉级分析。分析接口定义为本仓库的
`MultimodalAnalyzer`；能力不可用（Gateway 离线、模型无视觉能力、沙箱路径未授权）时
返回明确的 capability-gap 结果，不伪造验证成功。

**影响**：视觉图表级 PDF 分析 E2E 依赖部署环境（Gateway 在线 + 视觉模型 +
Agent 沙箱可读 PROJECTS_ROOT），列为 Non-blocking Validation Gap；确定性文本层分析
（BuiltinPdfAnalyzer）始终可用并如实报告抽取质量。

---

## D-0018 业务角色默认映射单一 OpenClaw agent（main），隔离靠 contextScope；PaperTeam 拥有独立 OpenClaw Runtime

- **日期**：2026-09-03
- **状态**：accepted（M3.5 Runtime Bootstrap 实现时冻结）

**背景**：两个问题一起决策。(1) M3 的四个业务角色（Researcher / Writer /
Reviewer / Citation）是否需要在 OpenClaw 注册四个独立 agent——此前真实 smoke 暴露
过"researcher 等 agentId 未注册"的失败。(2) PaperTeam 的开发/运行环境此前依赖
用户机器上已有的 OpenClaw 安装与全局 `~/.openclaw` state（与 AutoClaw 等其他项目
共用），既不可复现也有污染用户数据的风险。

**决策**：

1. **Agent 映射（方案 A）**：四个业务角色默认全部映射到 OpenClaw 默认 agent
   （`main`）。理由：业务角色的差异只在 prompt 与上下文，会话隔离已由 contextScope
   （D-0016）完整提供；四个角色不需要不同的模型、工具权限或独立长期上下文（对照
   D-0009 拆分准则，均不满足拆独立 Agent 的条件）；且全新 OpenClaw 安装只有
   `main`，默认即可用。映射保持在 Runtime/config 层
   （`OPENCLAW_{WRITER|RESEARCHER|REVIEWER|CITATION}_AGENT_ID`，缺省 `main`），
   业务 Service 不感知注册表；未来若某角色确需独立模型/权限，改环境变量即可，
   `GET /api/runtime/status` 会如实报告每个映射的 registered/missing。
2. **独立 OpenClaw Runtime（隔离三件套）**：PaperTeam 通过 Runtime Bootstrap
   运行自己的 OpenClaw 实例，按官方 multiple-gateways 的隔离清单使用
   `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` + 独立端口（默认 18790，避开
   全局常用 18789），state 放用户级 `%USERPROFILE%\.paperteam\runtime\openclaw\`。
   Bootstrap 在解析路径时硬校验与全局 `~/.openclaw` 既不相等也不嵌套，命中即拒绝
   启动。OpenClaw 版本精确 pin 在根 package.json（当前 2026.8.2，与
   `@openclaw/gateway-client` / `gateway-protocol` 同版本，protocol v4），以项目本地
   npm 安装获取，不 vendoring 源码、不依赖全局安装、不依赖任何 OpenClaw 源码
   checkout（如 `D:\Projects\openclaw`）。
3. **模型凭据边界**：Bootstrap 绝不搬运或复用任何其他项目的凭据；Gateway 无凭据
   也能健康启动，模型未配置由 `GET /api/runtime/status` 如实上报
   （`runtime.phase = model_not_configured`），不阻塞 dev 启动。用户为 PaperTeam
   配置模型的方式是把 provider API Key 写进独立 state 的 `.env`
   （`~/.paperteam/runtime/openclaw/.env`，OpenClaw 官方支持的凭据位置）。

**影响**：`npm run dev` 成为唯一开发入口（自动：检查 Node/依赖 → 准备隔离 state →
启动 Gateway → 等 healthy → 启动 Backend → Ctrl+C 优雅关闭双进程、无孤儿）；
`POST /api/projects/:id/generate` 之外的 Runtime 细节对用户不可见。该决策把
"Runtime Bootstrap"从未决问题清单移入已实现。
