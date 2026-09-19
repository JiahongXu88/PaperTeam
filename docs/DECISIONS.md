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
- **状态**：superseded（Runtime 本体由 D-0020 取代：M3.8 迁移到 Pi in-process）

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
- **状态**：accepted（**M4.7 已实现**：`artifacts/` 产物域 + FinalizeService
  双 Gate 对齐校验；Build 通过即冻结 Draft PDF，`POST /finalize` 在条件不
  满足时 422 拒绝；见 API_CONTRACT §1.2e）

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
- **状态**：accepted（部分取代：「独立 OpenClaw Runtime」部分由 D-0020 取代——OpenClaw
  实例与 Bootstrap 已移除；「方案 A」（角色不拆独立 agent、隔离靠 contextScope、
  会话标识默认 main）在 Pi 下延续）（M3.5 Runtime Bootstrap 实现时冻结）

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
   启动。OpenClaw 版本精确 pin 在根 package.json（当前 2026.9.1，与
   `@openclaw/gateway-client` / `gateway-protocol` 同版本，protocol v4），以项目本地
   npm 安装获取，不 vendoring 源码、不依赖全局安装、不依赖任何 OpenClaw 源码
   checkout（本地任意目录）。
3. **模型凭据边界**：Bootstrap 绝不搬运或复用任何其他项目的凭据；Gateway 无凭据
   也能健康启动，模型未配置由 `GET /api/runtime/status` 如实上报
   （`runtime.phase = model_not_configured`），不阻塞 dev 启动。用户为 PaperTeam
   配置模型的方式是把 provider API Key 写进独立 state 的 `.env`
   （`~/.paperteam/runtime/openclaw/.env`，OpenClaw 官方支持的凭据位置）。

**影响**：`npm run dev` 成为唯一开发入口（自动：检查 Node/依赖 → 准备隔离 state →
启动 Gateway → 等 healthy → 启动 Backend → Ctrl+C 优雅关闭双进程、无孤儿）；
`POST /api/projects/:id/generate` 之外的 Runtime 细节对用户不可见。该决策把
"Runtime Bootstrap"从未决问题清单移入已实现。

## D-0019 M3.7 Runtime Feasibility：新增 side-by-side PiRuntimeAdapter，默认 Runtime 仍为 OpenClaw

- **日期**：2026-09-04
- **状态**：accepted（M3.7 完成时冻结；「默认仍为 OpenClaw / side-by-side 保留」
  部分由 D-0020 取代，正式迁移已执行）

**背景**：评估「PaperTeam 直接嵌入 Pi SDK（@earendil-works/pi-coding-agent
0.84.4，官方 embedding API）」是否比「经 OpenClaw Gateway 子进程」更合适。触发
因素是公司项目换 Pi，但评估本身以 PaperTeam 的真实需求为准，不预设答案。

**决策**：

1. **Side-by-side，不动默认**：新增 `PiRuntimeAdapter`（`PAPERTEAM_AGENT_RUNTIME=pi`
   启用），OpenClaw 2026.9.1 保持 production/default baseline；不删除任何
   OpenClaw / Runtime Bootstrap 代码；前端零感知。
2. **嵌入方式**：官方 `createAgentSession()` in-process（不 spawn CLI、不用 RPC
   mode、不包本地 server）——验证的核心价值就是 in-process Runtime。会话用
   `SessionManager.inMemory()`：Workspace / checkpoint 是业务事实源（D-0013），
   Runtime session 是可丢弃执行上下文，不为它建持久化。
3. **角色映射沿用方案 A 的精神**（D-0018）：Pi 无 agent 注册表，角色差异落到
   Adapter 内部最小映射（contextScope 前缀 → systemPrompt + 工具白名单），
   任务级指令仍由业务 prompt 内联；不新建 Workflow Agent 层。
4. **sessionKey 派生共享**（`runtime/sessionKey.ts`）：两个 Adapter 产生一致
   key，provider 切换不改变上层会话语义（含 GenerationService 的显式透传）。
5. **auto-compaction 关闭**（in-memory settings）：M3 流程不依赖 compaction，
   关闭避免长会话隐式摘要的不确定性；其 abort 边界未验证且不影响 PaperTeam。

**影响**：A/B 验证（Level 1 + Level 2 真实 SDK × 官方 faux provider + Windows
进程实测）全部 P0 项通过，结论 **MIGRATE TO PI（建议）**——Pi 以明显更简单的
架构（无 Gateway / WebSocket / 握手 / RPC 轮询 / 子进程 / 端口）覆盖 PaperTeam
当前全部 Runtime 需求；cancelTask / streamEvents 在 Pi 侧先行实现（受 Contract
v1 限制对上层暂不可达，`listActiveTasks()` 为 v2 的最小 seam）。正式迁移（默认
切换、OpenClaw 退役）留待后续任务与独立决策；Level 3 真实 provider LLM E2E
因本机无凭据 NOT VERIFIED，迁移前建议补做。

---

## D-0020 M3.8 Pi Runtime Migration：Pi 成为唯一正式 Runtime；AgentRuntime 契约升级 v2

- **日期**：2026-09-04
- **状态**：accepted

**背景**：M3.7（D-0019）以 side-by-side 方式完成 Pi 可行性验证，结论 MIGRATE TO
PI：Pi 以 in-process 架构（无 Gateway / WebSocket / 握手 / RPC 轮询 / 子进程 /
端口）覆盖 PaperTeam 当前全部 Runtime 需求。同时 AgentRuntime Contract v1 存在
结构性缺陷——`runAgent()` 阻塞到任务终态才返回，调用方运行期间拿不到 taskId，
`cancelTask` / `streamEvents` 对上层天然不可达——而 M4 前端需要实时状态展示与
运行中取消。

**决策**：

1. **Pi 为唯一正式 Runtime**：`@earendil-works/pi-coding-agent` 0.84.4 精确 pin，
   in-process 嵌入。删除 `PAPERTEAM_AGENT_RUNTIME` selector 与双 Runtime 装配分支
   ——不为「可能切回」保留一套不用的 Runtime，git 历史即回退机制。
2. **OpenClaw 全套退役**：OpenClawRuntimeAdapter、Gateway client（WebSocket /
   握手 / RPC / health）、Runtime Bootstrap（runtime.json / token / port /
   supervisor / state 准备）、三个 npm 依赖（openclaw、@openclaw/gateway-client、
   @openclaw/gateway-protocol）全部移除；用户磁盘旧 state 无害忽略。
3. **AgentRuntime Contract v2**：`startAgent(input)` 立即返回
   `AgentRunHandle{taskId, sessionKey, events(), cancel(), result()}`——taskId
   在执行开始时即可得（排队不阻塞句柄）；事件流 replay + live、settle 后自然
   结束；取消幂等（queued 短路 / running 真实 abort）；result Promise 缓存；
   close 收敛全部 active run。`runAgent()` 保留为 start + await result 的
   convenience（既有业务调用点零改动）。v1 的 cancelTask / streamEvents /
   sendMessage 从契约移除；getTask 保留（已完结任务回溯）。
4. **事件与取消的归一化边界**：Pi 原始事件对象不透传业务层（Pi Event →
   AgentEvent → Domain Event → SSE）。取消归因以 Adapter 侧取消意图
   （cancelRequested）为准——工具执行中 abort 时 SDK 终态为
   `stopReason="error" + "This operation was aborted"`（LLM 流中断才是
   `"aborted"`），不依赖 SDK 的 stopReason 编码差异。
5. **dev 直启**：`npm run dev` = Node 检查 → 依赖检查 → 构建 → 直启
   backend/dist/index.js；无 Gateway 子进程 / 端口 / state 准备。
6. **RuntimeStatus 去 Gateway 化**：诊断形状为 runtime（provider/phase/version）+
   model（configured/not_configured）+ agents + sessions；Runtime 健康 ≠ 模型
   就绪（无 API Key = runtime healthy + model not_configured）。

**影响**：M3 业务层零改动（runAgent convenience 保持语义）；Reviewer 三路并发 /
隔离 / checkpoint 恢复等全量回归通过；tool execution 的 AbortSignal 取消传导
经真实 SDK（fauxProvider + customTools 慢工具）专项实证；测试从 280 调整为 230
（OpenClaw 架构专属测试随架构删除，v2 语义新增覆盖）。未来需要 Web Search 等
扩展能力时优先 Pi custom tool / MCP / 独立服务，不为单一工具恢复完整 Gateway。

## D-0021 M4.3 PDF 解析采用 pymupdf 子进程（Windows + stdout JSON 协议），pymupdf4llm 不作核心依赖

Python 依赖隔离在 `backend/tools/`（`parse_paper_pdf.py`：execFile 无 shell、
PYTHONIOENCODING=utf-8、超时、stdout 单 JSON、stderr 仅日志）；领域组装
（sections/chunks/ID/质量分级）全部在 TypeScript 侧可单测。pymupdf4llm 经实测
评估后不采用为依赖：其 markdown re-flow 破坏 chunk 文本与 PDF 原文的 1:1
对应（引用 provenance 需要），且核心需求（页文本/TOC/字号）由 pymupdf 原生
API 覆盖。pymupdf 为 AGPL/商业双许可——本地内部工具形态下无实际约束，若未来
对外提供闭源服务需重新评估（或换 pypdfium2）。

## D-0022 GROBID 本轮 defer：numeric 引用正则可解，部署成本（Java 21/Docker + 常驻内存）超出 M4.3 范围

GROBID（Apache 2.0）的 callout↔reference 精细关联（F1 0.76-0.91）对
author-year 风格与复杂版式有真实价值，留作 M4.3.8/M5 的增强通道评估
（届时以 `ScholarlyStructureParser` seam 接入 REST 服务形态，不走子进程）。
本轮 numeric（[n] 自识别）+ 标题正则 + author-year best-effort 已覆盖目标
论文风格；「关联不上就 unresolved，不猜」是安全下界。

## D-0023 引用核验两层分离：metadata truth（确定性外部核验）≠ semantic support（LLM judge + 真实证据）；NOT_FOUND ≠ 捏造 ≠ 检索失败

借鉴 RefWarden（Agents4Academia-AI/citation_verification,
MIT, pin ae85ae3）。三层语义严格区分：provider 网络/5xx/超时 → UNRESOLVED；
≥2 权威 not_found → NOT_FOUND；≥3 全一致零 error 且有可查字段 → 才标
probable fabrication。语义 judge 只拿 claim + canonical + 真实检索证据
（evidenceLevel=abstract 如实标注），禁止凭记忆；judge 的 keyQuote 必须逐字
来自证据否则剥离；真实性未确立 → semantic SKIPPED；无证据 →
INSUFFICIENT_EVIDENCE（不阻断，人工复核）。severity 由
(existence, verdict, priority) 确定性派生，模型不定级。Citation Integrity
硬规则并入现有 QualityGate（不另造平行 Gate Engine）。

## D-0024 长文档 Review 采用 PaperMap + 短生命周期 section task，禁止整篇 PDF 塞进增长型 Session

PDF → 确定性解析 → PaperMap（导航图 + 单 section 摘要，指纹缓存）→ 每个
section 一个受控 context（论文概览 + 其他章节**摘要** + 当前章节 chunks +
可选引用），scope `review/section/<id>` 稳定、从磁盘事实源确定性重建。
其他章节全文绝不进入当前章节上下文（隔离证明测试）；摘要失败不阻塞
（status=failed 可重跑）；token 控制经 telemetry 可审计。

## D-0025 Skill Store 独立于 ~/.pi；第三方 Skill 必须仓库内审计 seed + pin revision + LICENSE，按角色注入

PaperTeam 数据目录 `<runtimeRoot>/skills/installed/`；仓库内
`backend/skills/seed/`（审计产物：SKILL.md + skill.json + LICENSE +
PROVENANCE.md [+ UPSTREAM_SKILL.md]）→ 启动幂等安装（contentHash）。
Pi 注入 `DefaultResourceLoader({noSkills: true, additionalSkillPaths})`：
技能面完全 PaperTeam 自控、用户 ~/.pi 不受影响、progressive disclosure 保持
（仅 name/description/location 进 system prompt）。外部 skill 不自动可信；
本轮白名单两项（verify-citations 原件 verbatim；paper-search 为受控工具
wrapper，原件保留、wrapper 注明）。paper-search 的工具面由 PaperTeam 受控
`search_papers`/`lookup_paper` 提供（共享 ScholarlyResolver 缓存），不给
Agent shell。中文简介一次生成持久化（模型不可用 → summary_pending，discovery
不失败）。Install/Uninstall/Update/绑定编辑留 M5。

## D-0026 PaperTeam 在 Pi 之上确立有界 Writer–Reviewer Outer Review Loop

- **日期**：2026-09-08
- **状态**：accepted（**M4.7 已实现**：Revision Plan 一等落盘 artifact
  `revision-plan-r{round}.json`；CONVERGED / REGRESSION 确定性终止
  （`review/revisionOutcome.ts`）→ `hitl.revision_stalled`；iteration-history
  每轮 scorecard / outcome / planId；强制复审 + gate/build 结论与修订对齐。
  见 ARCHITECTURE §7 / §13）

**背景**：Pi SDK in-process 成为唯一 Runtime（D-0020）后，需要明确 PaperTeam
自身的核心质量迭代机制如何分层。Pi 负责单 Agent 内部的 agent loop（LLM →
tool call → tool execution → tool result → LLM → …）；跨专业 Agent 的协作与
Workflow 状态推进由 PaperTeam WorkflowOrchestrator 负责。M3.2 已实现 bounded
revision 基线：Review（fact / academic / style）→ 确定性聚合 → Quality Gate →
Writer Revision → Re-verify → 循环 ≤2 轮 → 超限 HITL。下一阶段将其升级为
Reviewer 结构化评价驱动的 Iterative Writer–Reviewer Quality Loop，并把它正式
定义为 PaperTeam 的核心 Outer Agent Loop——不是给前端加一个「自动修改」按钮。

**决策**：

1. **两层 loop 严格分层**：Pi inner agent loop 回答「单个 Agent 如何完成一次
   任务」；PaperTeam outer review loop 回答「Writer / Reviewer 等专业 Agent
   如何协作、Workflow 状态如何推进」。PaperTeam 不重新实现 Pi 的
   tool-calling agent loop；WorkflowOrchestrator 只负责角色调用、状态机、
   循环、分支、checkpoint、cancel、backpressure、quality gate、artifact /
   version 关联。
2. **Reviewer 产出结构化 findings / scorecard；score 是信号，不是最终
   权威**。评价沿用既有领域模型（ReviewIssue / ReviewSummary 的
   academicScore、styleRisk、fact verdicts、severity / blocking 计数），概念上
   收敛为 Review Scorecard。最终判定权始终在确定性 Quality Gate：critical
   factual error、unsupported critical claim、hallucinated / invalid citation、
   unresolved blocking issue、target requirement 未满足时，即使总分高于阈值也
   必须 FAIL。Build Gate 与 Quality Gate 分离（D-0015）保持不变。
3. **Revision Plan 是 WorkflowOrchestrator 生成的确定性业务 artifact / task
   contract，不新增 RevisionPlanner Agent**（Agent Team 保持 4 角色，D-0009）。
   Quality Gate 失败后，由结构化 Review Findings、Citation 问题与 Quality
   Gate blockers 确定性生成 Revision Plan 交给 Writer 执行；修订后的版本必须
   重新 Review，不自评通过。当前实现以执行期从最新 ReviewSummary + 引用报告
   派生修订指令为等价物（`collectRevisionDirectives`）；把 Revision Plan
   固化为一等落盘 artifact 属于下一阶段。未来若确需 LLM 做复杂 revision
   planning，再单独决策。
4. **循环有界，终止语义四态**：PASS（Quality Gate 通过）；MAX_ITERATIONS
   （达到配置的最大自动迭代轮数 → Human Checkpoint；现有「自动修订 ≤2 轮 +
   HITL revise_more ≤3」即其已实现形态）；CONVERGED（连续若干轮改善低于
   阈值，继续消耗模型成本价值很低 → Human Checkpoint）；REGRESSION（修订
   修复部分问题但导致重要质量维度明显退化 → 停止盲目继续修改，保留 / 恢复
   较优版本供人工决策）。CONVERGED / REGRESSION 的判定与阈值为
   planned / configurable，不与已实现参数混淆。
5. **Workspace / artifacts / checkpoint 是事实来源**：manuscript / evidence /
   review artifacts / workflow checkpoint 落盘并按轮关联；Review Loop 必须能在
   Runtime Session 丢失后从磁盘事实状态恢复。Reviewer 每轮以当前
   manuscript + 当前 evidence + 当前 rubric 为评价依据，不依赖上一轮聊天
   记忆（防 reviewer anchoring、保证可复现）。是否引入 round-scoped
   sessionKey，本决策不冻结。
6. **并发边界**：outer iteration 严格按版本顺序串行（vN review → revision →
   vN+1 review）；Review stage 内部可按 section / review lens 有界并发
   fan-out，且必须是 bounded concurrency（`PAPERTEAM_REVIEW_CONCURRENCY`，
   当前默认 3）而非无界 Promise.all。后续增强方向：provider / model capacity
   感知、统一 backpressure、retry / cancel / partial progress / telemetry。

**影响**：PRD §9.5（修改闭环与 Iterative Writer–Reviewer Loop）、
ARCHITECTURE（Outer Review Loop 章节）与 PROJECT_STATUS（下一阶段规划）按本
决策对齐；版本与可观测性（每轮 revision / review / scorecard / findings /
revision plan / gate 结果 / iteration 关联）与产品 UI 的迭代历史展示列入下一
阶段规划。

## D-0027 版本恢复（Restore）= 创建新的不可变修订，绝不改写历史

- **状态**：accepted（2026-09-10，M4.8 实现）
- **背景**：M4.7 建立了 manuscript 不可变修订链（ManuscriptRevisionStore，内容哈希
  幂等）与 Draft / Final 产物闭环；M4.8 补版本体验时需要「回到历史版本」的能力。
  常见做法是回滚（删除后续修订 / 把旧内容标记为 current），但这会破坏
  「review / gate / artifact 按 revision 对齐」的整套事实体系。
- **决策**：`POST /api/projects/:id/revisions/:n/restore` 把 rev{n} 快照复制回
  工作树，随后以 `source=revision.restore` + `restoredFrom={n}` 走正常 commit
  流程产生**新的**修订号。历史修订登记与快照、旧 Draft / Final 产物永不改动；
  旧 review / gate / build 结论因修订前进自然 stale，恢复后的版本必须重新
  构建 + 重新审稿才能再次 Final（Finalize 对齐校验天然拒绝偷用旧结论）。
  内容与当前一致时返回 `created=false`（幂等事实，不虚增修订）。
- **理由**：版本对齐（reviewedRevision / build.revision / artifact.revision）是
  M4.7 全部 stale 防护的基础；任何「覆盖式回滚」都会让历史结论失去可信锚点。
  追加式恢复让「恢复过什么」本身成为可审计的历史事实。
- **影响**：VersionService.restore / RevisionStore.restore；版本历史 UI 的
  「恢复此版本」确认文案（「创建新的当前修订，现有版本历史不会被删除」）；
  e2e version.spec C/D。

## D-0028 Existing Paper Improvement 的 PDF 输入经确定性重建进入改进闭环（不引入新 Agent）

- **状态**：accepted（2026-09-10，M4.8 实现）
- **背景**：PDF 导入 + goal=improvement 的项目此前在 `import.parse` 处必失败
  （缺 main.tex），且改进工作流没有任何浏览器入口——「系统性改进」对 PDF
  用户是死路。两条可选路径：(a) 新增「PDF 理解 Agent」把论文改写为 LaTeX；
  (b) 确定性代码把已解析的 PaperDocument 重建为可修订稿件。
- **决策**：采用 (b)。`PaperReconstructor`（零 LLM）从 PaperDocument 重建
  outline / sections/secNN.tex / references.bib / 组装根：正文与摘要经 LaTeX
  特殊字符转义，`[n]` 引用标记按提取器 relations 映射为 `\cite{refN}`，子章节
  合并以满足大纲上限。改进计划 prompt 携带真实章节文件清单（此前的「section
  必须是现有章节文件之一」在无清单时无法执行）。前端 Review tab 提供改进入口。
  **如实边界**：重建是文本级的（不含原图 / 原版式，公式以转义文本呈现），
  UI 文案与 Known Limitations 明示。
- **理由**：重建是结构搬运不是内容生成——LLM 参与只会引入改写风险与成本；
  Writer 的逐节修订本就是改进闭环的内容工作。确定性重建可从 checkpoint 幂等
  重放（import.parse 结果可复现）。
- **影响**：import.parse 阶段内嵌重建（结果携带 reconstructedFromPdf 事实）；
  PaperDocument 新增解析器摘要持久化；e2e improvement.spec 全链路与真实模型
  smoke 走同一条代码路径。

## D-0029 摘要（abstract）是一等修订目标：载体 outline.abstract，禁止路由到组装根 main.tex

- **状态**：accepted（2026-09-10，M4.8 实现；取代 M4.7 的「留在计划不派发」过渡处理）
- **背景**：M4.7 真实 smoke 暴露 Reviewer 把摘要类 finding 归到
  `main.tex（摘要）`，`sectionMatches` 的 `ref.includes(stem)` 把它路由到组装根
  → Writer 收到 `\documentclass` 全文 → DoD 拒绝。M4.7 的修复是「组装根绝不
  作为修订目标，该 finding 留在计划里」——防住了失败，但摘要问题永远修不了。
- **决策**：摘要类 section 引用（摘要 / abstract / main.tex（摘要））只路由到
  摘要修订目标；目标的独立可写载体是 `outline.abstract`（修订写回 outline.json，
  `writeMainTex` 重组时生效），写入路径绝不指向 main.tex。digest 有大纲时单列
  `[abstract]` 块（组装根只留结构说明），Reviewer prompt 明确摘要归 "abstract"。
  Writer 摘要修订输出纯文本（结构化校验拒绝 LaTeX 结构）。
- **理由**：组装根是确定性产物（含摘要的渲染位），把它当 Writer 目标必然产生
  「整篇骨架当章节输出」的 DoD 失败；摘要需要的是稳定 identity + 独立载体，
  而不是更宽松的模糊匹配。
- **影响**：definitions.ts（digest / sectionMatches / listRevisionTargets /
  revise 写回）、WriterService（摘要修订 prompt 与校验）、revisionLoop 回归
  测试（main.tex（摘要）/ 摘要 两种归属写法）。

## D-0030 学术 Skill 受控接入：审计 seed + 完整 SHA + 不可变版本快照 + role/contextScope 路由 + assigned ≠ accessed

- **日期**：2026-09-14（M5.3）
- **决策**：三个学术 Skill（academic-writing-zh / academic-review /
  academic-style-zh）只以仓库内审计 seed 进入 PaperTeam：external seed 必须
  pin 完整 40 位 commit SHA（拒绝 main / latest / tag）、随附 LICENSE 原件 +
  PROVENANCE.md + 上游 verbatim 快照；SKILL.md 为 PaperTeam 学术适配正文
  （非原样接入）。Skill Store 以 `versions/<id>/<contentHash>/` 不可变快照
  作为注入路径，会话 generation 内固定；已安装 skill 的 seed 变化只标记
  update available，需预览 diff 后应用。路由由 role + contextScope 前缀决定
  （代码内控常量），三个 Reviewer lens 不共享 Skill 集。任务终态区分
  assigned（放进 available_skills 的版本引用）与 accessed（仅 Pi `read`
  工具真实命中快照文件时记录；无事件 → unknown），绝不把「注入」当「使用」。
- **理由**：Skill 只是增强写作 / 审稿方法，事实系统（EvidenceStore /
  Citation Verification / Quality Gate）必须唯一；上游 Humanizer 的「像人」
  改写目标与学术写作冲突，上游 Python 工具会诱使放宽 Reviewer 权限；漂移的
  revision 与运行中换版会让 A/B 与故障归因失去基准；假报 accessed 会污染
  质量评测结论。
- **不做**：开放 Marketplace、任意 URL / `skills add <url>` 安装、执行第三方
  Skill 脚本、自动向用户论文 bibliography 插入上游论文引用（软件 attribution
  记录于 PROVENANCE / LICENSE，与论文引用分离）。
- **影响**：`backend/skills/seed/academic-*`、`skills/{types,routing,diff,
  SkillRegistry}.ts`、`runtime/types.ts`（`AgentTask.skills` /
  `SessionDiagnosticEntry.assignedSkills` 可选字段）、PiRuntimeAdapter
  （`roleSkills` / 版本固定 / accessed 观测）、`/api/skills*` 路由、
  Skills 页、`PAPERTEAM_DISABLED_SKILLS`。

## D-0031 语言润色是用户显式选择的 style-only 修订：stylePolicy + 显式 revisionReason + 确定性 invariant 守卫，不改 minor 全局语义

- **日期**：2026-09-14（M5.4）
- **决策**：保留 D-0026「critical / major → planned、minor → skipped」；风格问题
  通常是 minor，不通过抬高 severity 让它进入修订。新增 run 选项 `stylePolicy`
  （`suggest_only` 默认 / `apply_once`），apply_once 在 Quality Gate 通过后
  以 HITL 询问一次，用户勾选的 style minor finding 由 `buildStylePolishPlan`
  生成独立 style plan（`revisionReason=style_polish`），Writer 以 style-only
  指令（`writing/style-polish`，注入 academic-writing-zh + academic-style-zh）
  修订，写回前必须通过确定性 Style Invariant Checker（citation key / 数字单位 /
  公式 / LaTeX 结构 / 受保护术语 / 否定·比较·结论强度哨兵）；任一失败即不覆盖
  当前修订并记录具体 invariant，不自动重试；通过则提交新修订，旧 review /
  gate / build 结论按既有新鲜度规则失效并重走。默认最多一轮。
- **理由**：D-0026 的 minor 不派发是收敛纪律，不能为「让 Writer 改」而破坏；
  语言润色最大的风险是顺手改事实，必须由代码而非 prompt 守卫；PaperTeam 不做
  AI detector，style 的目标是可定位、可修改的表达质量问题。
- **不做**：自动无限润色循环、AI 概率 / 检测器分数、Quick Review 中的任何修改
  入口（携带 stylePolicy 直接 400）、在文档中把哨兵词计数夸大为语义等价证明。
- **影响**：`review/{stylePolicy,styleInvariants,styleSignals}.ts`、
  `RevisionPlan.revisionReason`、`ReviewIssue.reason`、WriterService
  `polishSectionStyle`、definitions（`hitl.style_polish` / `revision.style_polish` /
  planner）、`/api/projects/:id/style-polish`、HitlPanel / ReviewPanel / PaperPanel、
  eval corpus 与人工评价模板。

## D-0032 单机 Docker 形态：web(nginx) + backend 两容器、volume 为事实源、/ready 与 /health 分离、可配置优雅停机

- **日期**：2026-09-14（M5.5）
- **决策**：单机单用户部署用两容器 compose：`web`（nginx 静态资源 + `/api`
  `/health` `/ready` 同源反代，唯一对外端口）与 `backend`（只在内部网络 expose）。
  `PROJECTS_ROOT` / `PAPERTEAM_RUNTIME_ROOT` 各挂 named volume，容器可写层不保存
  用户数据；镜像不含 `.env` / `auth.json` / Key，密钥经 `.env`（env_file，可缺省）
  或 Settings UI 注入。TeX 只装模板与导入论文真实需要的包集（不装 texlive-full）。
  `/health` 只回答「进程活着、Runtime 可初始化」，新增 `/ready` 回答「可工作」
  （Runtime + 数据根可写 + TeX / Python 状态，缺失记 degraded，不调用模型）。
  SIGTERM 处理改为「停止受理 → 取消在途 run → checkpoint 落盘 → 释放会话 →
  退出」，硬退出预算由 `PAPERTEAM_SHUTDOWN_TIMEOUT_MS` 配置并小于 compose
  `stop_grace_period`。
- **理由**：Backend 现状不提供静态文件服务，nginx 反代比在 Backend 增加静态服务
  改动更小且天然满足「Backend 不暴露公网 / 同源 /api」；固定 5s 硬退出会让长任务
  状态落盘不完整；readiness 与 liveness 混用会让编排器在 TeX 缺失时误判进程死亡。
- **不做**：K8s / HA / autoscaling / 多租户 / Redis / 外部队列 / 登录 / System Admin；
  在 readiness 中真实调用 LLM。
- **如实边界**（2026-09-15 更新）：决策当日开发机无 Docker / WSL；随后按「不擅自安装
  Docker Desktop」纪律安装 WSL2 + Docker Engine，对同一 checkout 完成真实 build / up /
  restart / down·up 持久化 / 容器内 XeLaTeX 中文 PDF 与 PyMuPDF 解析 / SIGTERM 优雅停机
  验收，全部通过——M5.5 COMPLETE（docs/DEPLOYMENT.md §7、docs/M5_ACCEPTANCE.md §4.7）。

---

## D-0033 M6 Search / Academic Search / RAG / Evidence 架构：六层最小接口 + SearXNG 独立服务 + 扩展既有 Scholarly 生态 + 无 Vector DB + 内部零 MCP

- **日期**：2026-09-16（M6.1，架构冻结）
- **决策**：M6 Search/RAG 采用六层能力分离（WebSearchProvider /
  AcademicSearchProvider / MetadataResolver（既有 ScholarlyResolver.lookup）/
  FullTextResolver / LiteratureLibrary（SourceStore 扩展）/ RetrievalService+
  RetrievalIndex），各自最小 TypeScript 接口（草案见
  docs/research/M6.1_SEARCH_RAG_ADR.md §12）。Web Search 以 **SearXNG 独立
  HTTP 服务**（Docker、json format、limiter 关、中国引擎白名单 cn.bing+baidu）
  承担，optional——不可用时降级 unavailable，学术主链路不受影响；不 bundling
  子进程、不复制其代码（AGPL 进程边界隔离）。学术检索=扩展既有
  ScholarlyResolver 生态：**检索（search）与核验（lookup）两接口分开**；
  OpenAlex primary、S2 enrichment/fallback、AMiner China secondary+enrichment
  （免费层先行，付费端点默认关闭）、Crossref 只做 MetadataResolver、
  Unpaywall 属 FullTextResolver。跨源同一性=分层确定性键（DOI>arXiv>PMID>
  归一标题+年份+一作 strong>预印本合并偏正式版）产出 SourceIdentity；多源
  融合借 SearXNG 带权重倒数排名。**共享 ProviderHttpClient**（超时/退避+抖动/
  Retry-After 优先+硬帽/类型化错误/TTL 缓存/每 provider 速率档/熔断+半开/
  限流≠宕机）收敛两份 fetchJson。Index=Derived State：chunk 落盘（含
  paper/section/page/contentHash）+进程内 lexical 索引+可选 dense
  （EmbeddingProvider），**第一版零 Vector DB / 零外部数据库进程、无 reranker**。
  Evidence 边界加严：snippet 最多 plausible（abstract 级），verified 只能经
  quote 逐字匹配 chunk / 元数据核验 / 只见真实证据的 LLM judge；LLM 不得据
  检索摘要生成事实直写 EvidenceStore。**内部零 MCP**（TS interface + Pi
  customTools；MCP 仅远期对外暴露可选项）。Google 不是任何环节的依赖。
- **理由**：M6.1 对 6 个开源项目（SearXNG / agent-search / paper-search-mcp /
  aminer-open-skill / semantic-scholar-mcp / openalex-research-mcp，全部源码
  级静态分析）+ PaperTeam 自身盘点的结论（证据：docs/research/
  M6.1_SEARCH_RAG_OSS_ANALYSIS.md）：PaperTeam 已有 provider 抽象 70% 雏形，
  正确路径是扩 seam 而非引入框架；所有被分析项目均不宜作运行时依赖（Python/
  单源/成熟度/AGPL），价值全部在模式层（SearXNG 聚合纪律与打分公式、
  agent-search 的 canonical_url/SSRF/预算护栏/代码拼参考文献、s2-mcp 的
  Retry-After 与错误分层、openalex-mcp 薄原语+厚编排、AMiner 三方去重与
  HTTP-200 信封穿透、paper-search-mcp 伪统一反面教训）；single-user×每项目
  几十篇规模下外部索引引擎是纯开销。
- **不做**：嵌入/修改 SearXNG 源码；引入 agent-search/任一 MCP server 作运行
  时依赖；万能统一 SearchProvider；Milvus/Qdrant/Elasticsearch/Redis；
  第一版 cross-encoder reranker；爬虫/反 CAPTCHA 兜底；内部 MCP 化；Google
  依赖；AMiner 付费端点接入（先实测计费矛盾再议）。
- **影响**：M6.2（Literature Library）→ M6.3（Search Service + 共享 HTTP
  基建 + SearXNG compose）→ M6.4（Retrieval/RAG）→ M6.5（Evidence pipeline
  + workflow 接线）实施顺序冻结（ADR §11）；新增 docs/research/ 目录承载
  调研报告与 ADR 正文；零第三方源码进入 PaperTeam Git（第三方 clone 位于
  仓库外 PaperTeam-M6-Research/）。

## D-0034 M6.2 Literature Library：候选与正式文献分文件持久化 + 分层身份键精确判等 + 条目级元数据可信水位线 + Evidence 引用阻止删除

- **日期**：2026-09-16（M6.2，Project Literature Library）
- **决策**：在 D-0033 六层架构的 LiteratureLibrary 层落地四项：
  1. **CandidateSource 与 SourceItem 分文件持久化**：候选（Discovery
     State，"发现到了可能有价值的资料"）存 `sources/candidates.json`
     （pending_review → accepted/rejected，accepted 记 promotedSourceId）；
     正式文献保持 authoritative 的 `sources/index.json` + `papers/` +
     `parsed/`。引用方向只有 candidate → source 单向：删除候选不影响正式
     Source；promotion 幂等（重入返回同一条目；library 已有同身份 → merge
     不复制；目标被删后可重新入库）。候选必须携带可判等键（仅标题拒绝）。
  2. **SourceIdentity 分层确定性键、精确判等**：DOI > arXiv ID > PMID >
     归一标题指纹+年份+一作 family > canonical URL；键是精确相等不是相似
     度。arXiv preprint 与 DOI 正式版是**两个身份两条 Source**（多 Provider
     检索不会互相覆盖）；版本关系用轻量 workKey + versionType +
     relatedSourceIds（`POST /sources/:sid/link` 显式建立），不做自动识别、
     不引入 Knowledge Graph。老项目身份从 metadata 动态推导
     （identityFromMetadata），不重写旧 index.json（无 migration）。
  3. **条目级元数据可信水位线 user > resolved > inferred**：低可信 merge
     只填空缺不覆盖（resolver 正式记录不覆盖用户改过的字段，但纠正 PDF
     抽取的推测字段）。M6.2 不做字段级 provenance 追踪（已知保守边界：
     任一字段被 user PATCH 后，条目水位线=user，后续 resolved 数据对该条目
     只填空缺），够用且可测试；真实需要字段级时再演进。
  4. **删除语义**：删正式 Source 清理 papers 文件 + parsed 产物 + 索引
     条目；**被 Evidence 引用（EvidenceSourceRef.sourceId）时 409
     SOURCE_IN_USE 阻止删除**。选择阻止而非 cascade / tombstone 的理由：
     Evidence 对 Source 是弱引用（无外键），cascade 会发明本轮不存在的
     语义，tombstone 需要改 Evidence 读取路径——阻止是最小、正确、可测试
     的行为；用户先处理引用即可删。
- **理由**：M6.1 ADR §5 数据流表把 CandidateSource 定为"候选清单是事实、
  但非 authoritative"——分文件是其在文件系统上的直接表达；PaperTeam 已有
  SourceStore 布局（papers/parsed/index.json）复用而非另起数据库（D-0013）；
  promotion 幂等与精确判等防止 M6.3 多 Provider 检索产生重复条目；
  preprint/正式版独立是学术场景真实需求（arXiv→会议→期刊扩展版）。
- **不做**：字段级 provenance；自动跨版本识别（需 provider 元数据能力，
  M6.3+）；cascade / tombstone 删除；metadata-only 条目的全文挂接
  （FullTextResolver 属 M6.3）；候选的批量导入 UI。
- **影响**：sources/ 域新增 identity.ts / CandidateStore.ts /
  SourceImportService.ts / bibtex.ts / metadataMerge.ts；ServiceStack 装配
  sourceImport（与 citationIntegrity 共享 ScholarlyResolver 实例）；
  httpServer sources 子资源路由扩展（import / candidates / enrich / link）；
  全部新字段 optional，M1–M5 项目零迁移可读。

## D-0035 M6.3 Research Discovery：共享 ProviderHttpClient（Retry-After 双硬帽 + 按尝试计数熔断 + 限流≠宕机）+ 检索默认零持久化（显式 saveAsCandidates）+ search 与 lookup 双接口

- **日期**：2026-09-17（M6.3，Research Discovery & Academic/Web Search）
- **状态**：accepted
- **决策**：在 D-0033 冻结架构下落地 M6.3，新增三项可复核的实现级决策：
  1. **ProviderHttpClient 是唯一 HTTP 执行与状态观测点**（backend/src/search/
     providerHttp.ts）：全部 provider（学术 4 家 + SearXNG）共享一个实例——
     timeout / AbortSignal 组合 / 类型化错误（timeout/aborted/http_error/
     rate_limited/network_error/circuit_open/business_error）/ 指数退避+有界抖动 /
     重试集（429+500-599+网络+超时；4xx 与业务信封错误不重试）/ **Retry-After
     双格式（delay-seconds + HTTP-date）双硬帽**（单请求内等待 ≤5s——超帽立即
     失败进冷却，不为一个几小时的 Retry-After 阻塞请求；provider 冷却封顶 60s）。
     **熔断按「尝试」计数**：连续 3 次临时失败尝试（含重试）即开路——单用户
     规模下一个完整失败的请求（3 次尝试）足以证明该源当前不可用；**限流≠宕机**：
     429 / AMiner 40306 走独立冷却（不累计熔断失败、到期自动恢复无需探测），
     连续网络/5xx 失败走熔断（open 30s → half-open 探测 → close）。退避 sleep
     不持锁（s2-mcp head-of-line 教训）；HTTP-200 信封业务错误经 envelope 钩子
     穿透（AMiner code 40301/40302/40307 → degraded，绝不当 healthy）。
  2. **检索默认零持久化，候选保存是显式动作**：search API 返回归一化融合结果，
     只有请求携带 `saveAsCandidates: number[]`（结果下标）才写 CandidateStore
     （origin=academic_search/web_search，provider=融合后最强源，`query` 字段
     记录发现检索词——CandidateSource 的 M6.3 最小扩展）。一次检索 100 条结果
     不无条件污染 sources/candidates.json；检索链路不存在 EvidenceStore 写路径
     （snippet 最高 plausible 属 M6.5）；promotion 复用 M6.2 幂等链路不变。
     全部失败 → SEARCH_ALL_PROVIDERS_FAILED（502，≠空结果）；无 provider /
     未配置 SearXNG → SEARCH_PROVIDER_NOT_CONFIGURED（503，不阻塞启动）。
  3. **search（发现）与 lookup（核验）双接口并存，不合并**：AcademicSearchProvider
     .search 是真关键词检索（无相似度门控），与既有 ScholarlyResolver.resolve 的
     查证语义（标题 variant + 门控裁决）分开实现与分开消费（search_papers v2 vs
     lookup_paper 工具）；融合 = SourceIdentity 分层键去重（M6.2 identity.ts 复用，
     零第二套 dedup）+ 带权重倒数排名 score=Σ weight/(60+rank)（SearXNG 公式，
     无 ML reranker）+ 字段互补合并（缺失不覆盖有效；preprint/正式版键不同不
     collapse）。
- **理由**：D-0033 §6 冻结了 ProviderHttpClient 的职责清单但把参数与状态机留给
  实现期；M6.1 分析报告 §7（s2-mcp Retry-After 教科书 + 持锁退避反面）、§3.5
  （SearXNG 熔断时长）、§10.3（健康模型）给出了全部证据输入。按尝试计数熔断是
  对「连续失败 ≥3 次」在单用户低频场景下的落地口径（一次完整失败的请求=3 次
  观测），行为被 providerHttp.test.ts 钉死。「默认零持久化」是对 M6.2
  CandidateStore「候选清单是事实」的对称纪律：发现是高频动作，事实只应显式记录。
- **不做**：per-provider 速率档位串行原语（当前 4 provider 并发 fan-out + 共享
  client 重试已满足限流礼貌，真实命中限流时 ProviderHttpClient 冷却兜底——
  ADR 中该条按 YAGNI 推迟，需要时后补）；检索缓存（第一版不做，ADR §39 授权）；
  FullTextResolver（ADR §11 实施顺序未列入 M6.3，属 M6.4+）；Crossref 检索化
  （维持 MetadataResolver 职责）。
- **影响**：backend/src/search/ 域 11 个新文件；serviceStack 装配 discovery
  （与 citationIntegrity 共享 resolver 的对称位置）；httpServer 新增
  /api/projects/:id/research/{academic,web}-search + GET /api/research/providers；
  scholarlyTools 升级（search_papers v2 真检索 + search_web）；compose 增
  `--profile research` 的可选 searxng 服务（docker/searxng/settings.yml 模板：
  json format 开 / limiter 关 / cn.bing+baidu 白名单）；测试 +72（providerHttp
  20 / academicProviders 17 / academicSearchService 13 / searxng 12 /
  researchDiscovery.http 9 / config 1，全部离线；live smoke 默认跳过）。

## D-0036 M6.4 Project RAG：确定性 chunk 身份（sourceId:节:节内序号:内容hash）+ 中英 bigram tokenizer + BM25 进程内索引（标题并入索引文本）+ EmbeddingProvider 抽象与缓存 identity 失效 + RRF hybrid + 检索库签名自动增量刷新

- **日期**：2026-09-17（M6.4，Project RAG & Hybrid Retrieval）
- **状态**：accepted
- **决策**：在 D-0033 第 6 层（RetrievalService+RetrievalIndex）落地 M6.4，六项实现级决策：
  1. **稳定 chunkId = `<sourceId>:<sectionId>:<节内序号4位>:<内容hash10>`**（sha256 前
     10 hex）。序号是**节内**序号而非全局序号——前置章节 chunk 数漂移不影响后续章节
     的 ID（局部性）；内容不变 rebuild 后 chunkId 逐字节不变（确定性 chunker + 固定
     hash，retrievalService 测试钉死）；某节内容变化只影响该节受影响边界之后的
     chunk。全局 ordinal 只用于邻近去重与展示，不进 ID。不引入 diff engine。
  2. **chunk 输入边界**：只有「有真实全文」的 Source 进 chunk——PDF 走 paper 域
     PyMuPdfParser（blocks 带页码 + TOC 章节，复用 `deriveDocumentStructure` 出口）
     优先、builtin 文本层回退（无页码单节，<200 字符判 full_text_unavailable）；
     text/markdown 直读（markdown 标题→章节）；metadata_only / bibtex / image
     一律 skip + 结构化 reason（full_text_unavailable）——**abstract/snippet 永不
     冒充全文索引**。M6.2 contentHash 绑定 manifest entry：内容变 → stale → 自动
     重生成；chunk 落盘 `sources/chunks/<sourceId>.jsonl` + `index.json` manifest
     + `<sourceId>.vectors.json` 向量旁车（全部 Derived State，可删可重建）。
  3. **token 口径统一**：chunk 切分（section→paragraph→sentence→word 四级、
     target 400 / max 600 / overlap 60 token，env 可调）、embedding、Context
     Budget Packing 全部用 `estimateTextTokens`（CJK 1.5/char、其他 chars/4）——
     同一估算贯穿索引与预算，不引入 tokenizer 依赖。overlap 在同节相邻 chunk 间
     以「上一 chunk 尾部（句子对齐、超预算词截尾）」携带，chunk 上限放宽到
     max+overlap；相邻 run 在检索/打包两层做邻近去重（≤2 连续）。
  4. **Lexical = 进程内 BM25（k1=1.2 b=0.75）+ 中英兼容 tokenizer**：英文
     `[a-z0-9][a-z0-9'-]*` 小写化、连字符标识符（MRG-DTM）整体+部分双索引；
     中文连续段 bigram + 尾单字（无词典、无分词服务）；**章节标题并入索引 token
     流**（chunk.text 保持纯正文）——"method"/"results" 型查询靠标题命中。排序
     确定性：score 降序、并列 chunkId 字典序。零 Elasticsearch（D-0033 拒绝项）。
  5. **Dense optional + 缓存 identity**：EmbeddingProvider 抽象（name/dimensions/
     identity + embedDocuments/embedQuery）。pi-ai 无 embedding API（盘点结论），
     M6.4 唯一实现是确定性测试 provider（token 哈希袋，语义≈词重叠——只验证机制，
     不代表真实语义召回）；生产默认不注册 → lexical-only 健康运行。向量旁车缓存
     key = chunkId + chunk contentHash + provider identity：换 provider/模型/
     维度或 chunk 文本变化 → 重嵌，未变化重启零嵌入。显式 mode=hybrid 而无
     provider → EMBEDDING_UNAVAILABLE(422)；默认 auto 路径永不因 dense 失败
     （嵌入/查询失败降级 lexical + denseNote）。**Hybrid = RRF k=60 等权**
     （与 M6.3 fusion 同思想；量纲无关，不相加裸分数）。
  6. **索引新鲜度 = 文献库签名自动增量刷新**：每次检索前对比 sources 签名
     （sourceId:contentHash:updatedAt，读 index.json 成本可忽略）；变化才串行
     刷新——新 source 补建、stale 重生成、孤儿清理 + manifest 对账，磁盘 chunk
     文件损坏/manifest 损坏按 Derived State 自愈重建。每项目操作经 promise 链
     串行（load/rebuild/invalidate 互斥），search 读不可变快照（rebuild 中检索
     用旧快照继续、交换原子生效）。retrieve_library 工具按会话绑定的 projectId
     闭包构造（roleCustomTools seam 扩展为 `(role, projectId)`）——项目隔离由
     构造边界保证；工具描述明示「retrieved passages ≠ verified evidence」，
     检索/打包/统计全程零 EvidenceStore 写路径。
- **理由**：D-0033 §2-7 冻结了「chunk 落盘 + 进程内 lexical + 可选 dense +
  无 Vector DB」的骨架但把 ID 稳定性 / 中文 tokenization / 缓存失效键 /
  新鲜度策略留给实现期。稳定 ID 是 M6.5 Evidence 与未来 citation/review
  finding 引用 chunk 的前提（随机 UUID 会让全部下游引用在 rebuild 后悬空）；
  bigram 是无词典 CJK 检索的最小可用方案（单字区分度不足，whitespace 切分
  对中文完全失效——指令红线）；签名刷新修复了「首次加载后新增文献永远不进
  索引」的真实缺陷（increment 测试钉死）。benchmark：22 queries（exact/en/
  zh/mixed/semantic 五类）固定 fixture——lexical R@1=0.86 R@5=0.90 R@10=0.90
  MRR=0.87 section-hit=1.00；hybrid(mock dense) R@5=0.95 R@10=1.00——mock dense
  ≈ 词重叠，该对比只证明融合机制，真实语义价值待真实 provider（如实记录）。
- **不做**：真实 embedding vendor 接入（pi-ai 无 API，不新增账号系统）；dense-only
  模式（无独立价值场景）；跨语言语义 bridging（当前 lexical 与 mock dense 都
  无法命中，benchmark 语义型查询如实计入）；Writer/Reviewer 自动检索编排与
  Evidence 写入（M6.5）；reranker（D-0033 维持拒绝）；chunk 级前端 UI（验收靠
  backend + benchmark）。
- **影响**：backend/src/retrieval/ 新域 10 文件（types/tokenize/chunking/
  SourceChunker/ChunkStore/lexicalIndex/embedding/contextPacker/
  RetrievalService/tools）；serviceStack 装配 retrieval（chunker 复用 paper 域
  PyMuPdfParser）；httpServer 新增 /api/projects/:id/retrieval/{search,rebuild,
  stats} + 删除 source 时索引失效；PiRuntimeAdapter roleCustomTools seam 加
  projectId；index.ts 为 researcher/writer/reviewer 注册 retrieve_library；
  SourceStore.remove 连带清理 chunk 产物；config 增 PAPERTEAM_RETRIEVAL_CHUNK_
  {TARGET,MAX,OVERLAP}_TOKENS；错误码 +4（SOURCE_NOT_INDEXABLE 422 /
  RETRIEVAL_NOT_READY 503 / EMBEDDING_UNAVAILABLE 422 / INVALID_RETRIEVAL_
  FILTER 400）。测试 +108（retrieval 域全离线；真实 pymupdf 仅 1 个 fixture
  测试，与既有 pdfIngest 同口径）。

## D-0037 M6.5 Evidence Grounding：候选-转正分离（EvidenceCandidate 状态机）+ 三段核验管道（quote 逐字 / metadata / 复用 Citation 角色语义 judge）+ Evidence 工具面只读写候选 + evidence.ground stage 位于 research 与 feasibility 之间

- **日期**：2026-09-17（M6.5，Evidence Grounding Pipeline）
- **状态**：accepted
- **决策**：落地 M6.1 ADR §11 的 Evidence Grounding，采用审计推荐方案 C（Hybrid：工具面 + 确定性核验管道 + 复用 Citation 角色），五项决策：
  1. **候选-转正分离**：新增 EvidenceCandidate（`evidence/candidates.jsonl`；
     sourceId+chunkId+claim+quote 四元组）与 EvidenceRecord 分离存储。状态机
     pending → verified / mismatch / rejected / unverifiable（unverifiable 可
     retry，其余终态；转换只经 markResolved，终态保护 + verified 必带
     evidenceId）。Retrieved ≠ Verified ≠ Grounded：检索结果与 Agent 提案都
     只是候选，不触碰 EvidenceStore。不修改 EvidenceRecord 结构（六态
     verificationStatus + supportStrength 口径不变，Quality Gate 消费不变）。
  2. **三段核验管道**（EvidenceGroundingService，grounded 写入唯一入口）：
     Stage 1 quote 逐字校验（确定性；归一化 = NFKC / 去零宽与软连字符——
     U+00AD 断词教训 / 空白折叠 / 小写；归一化后子串匹配，最小 6 字符防空洞；
     失败 → mismatch 终态）；Stage 2 metadata 核验（确定性；与 sourceImport /
     citationIntegrity 共享同一 ScholarlyResolver 实例；mismatch → mismatch
     终态；not_found / unresolved / ambiguous 如实记录但**不阻塞**——D-0023
     「NOT_FOUND ≠ 检索失败 ≠ 证据问题」，离线部署 resolver 空 provider 全
     链路可用）；Stage 3 语义 judge（唯一 LLM 阶段；**复用 Citation 角色**，
     scope `citation/evidence/<candidateId>`，不新增第五 Agent——D-0009 四
     准则全部不满足：同模型 / 短生命周期任务 / 无新权限 / 无独立并行资源）。
     judge prompt 只喂 claim + quote + chunk 原文（不见摘要与文献库 digest——
     v4/v5 蒸馏污染教训）；supported → verified+direct / partially_supported →
     verified+partial / unsupported → rejected / insufficient_evidence →
     unverifiable（不伪造裁决）；judge keyQuote 伪造剥离。
  3. **Evidence 工具面**（evidence/tools.ts）：get_chunk（按 chunkId 精确回取
     原文——M6.4 引用标记的直接消费，quote 校验锚点）/ propose_evidence（只入
     候选队列，明确返回「不是已核验证据」）/ evidence_query（只读查证）。
     角色权限矩阵唯一事实源 evidenceToolsForRole：researcher=3 工具、
     writer=evidence_query、reviewer·citation=get_chunk+evidence_query、
     default=无；write_evidence 类工具**不存在**（状态机由核验管道独占）。
     工具纪律与 scholarlyTools/retrieve_library 同款：薄壳、无状态、失败
     结构化返回、projectId 闭包隔离；evidence_query 拿 EvidenceReadAccess
     只读投影（类型层面无写方法）。
  4. **workflow 接线**：idea_to_paper 新增 `evidence.ground` stage，位置
     research.idea 之后、research.feasibility 之前——feasibility 证据统计与
     后续 Reviewer 消费的必须是核验后口径（零候选 no-op 通过，scripted/
     离线栈无感；幂等：只处理 pending；DoD = 队列无 pending；单轮上限 100，
     超限由 stage 重试语义续跑）。existing_paper 流程不接入（其 research
     阶段零 evidence）。Researcher 兼容双路径：JSON evidence 字段带
     sourceId+chunkId+quote 的锚定条目走候选管道（propose 校验失败降级
     legacy 追加，单条坏候选不炸 research 阶段）；无锚定条目保持 legacy
     unverified 追加（输出契约不变）。
  5. **批量写与幂等**：EvidenceStore 新增 appendBatch（一次 loadAll + 一次
     追加写，消除批量转正的 O(n²) 读盘；append/appendBatch 共用
     buildRecord 字段校验收口）；grounded 记录幂等（重复 ground 已 verified
     候选复用 evidenceId；append 与 markResolved 之间的中断窗口由「同文
     verified 记录查重复用」守卫兜底）。HTTP 增 GET /evidence/candidates 与
     POST /evidence/ground（批次或单条 + retry）。
- **理由**：M6.4 完成后 Agent 已能检索到带引用标记的原文段落，但 Evidence
  消费仍是「prompt 内联 digest + Researcher JSON 直写 unverified」——写路径
  无核验、读路径无工具面（审计 §2.4 评 Evidence 为唯一接口缺口）。方案 A
  （纯工具）不成立：verificationStatus/supportStrength 状态机是业务逻辑，
  违反 Tool=无状态红线；方案 B（Evidence Agent）不成立：D-0009 四准则逐一
  不满足且「找证据」的 agentic 部分已存在于 Researcher session 内。quote
  逐字校验消灭「Agent 虚构引文」（错一个数字即 mismatch 终态，测试钉死）；
  chunkId 内嵌内容 hash 使按 id 回取天然自校验（内容变 → 旧 id 失效 →
  unverifiable 可重建后 retry，绝不静默返回近似原文）；metadata 通道不阻塞
  是离线部署（resolver 空 provider）与 D-0023 语义分离的双重要求；judge 只
  见 chunk 原文延续 v4/v5 「证据边界」纪律。测试 +50（候选 store / quote
  归一化 / 三段核验全路径 / 工具与权限矩阵 / 安全红线「工具调用后
  evidence.jsonl 零写入」/ stage E2E）；全量 1115 通过零回归。
- **不做**：Evidence Agent / 第五角色（D-0009）；Reviewer/Reviewer prompt 的
  evidence digest 拆除（M6.5 只提供 evidence_query 能力，prompt 重构属
  M6.6——指令「本轮不要完全重构 Reviewer」）；write_evidence 类工具；
  Researcher legacy unverified 路径删除（兼容期保留，锚定提案成为主路径后
  收口）；usableEvidence 下沉 definitions.ts（审计 P1，随 M6.6 消费侧重构
  一并做）；候选队列 HITL 确认语义（M6.2 accept/reject 先例可后续挂接，
  当前自动核验已闭环）；真实 embedding / reranker（D-0033 拒绝项维持）。
- **影响**：backend/src/evidence/ 新增 6 文件（candidates / quoteVerification /
  chunkAccess / evidenceJudge / EvidenceGroundingService / tools）；
  EvidenceStore +appendBatch（append 重构为共用 buildRecord，行为不变）；
  ResearcherService 锚定双路径 + prompt 指引；definitions.ts +evidence.ground
  stage + WorkflowServices.evidenceGrounding；serviceStack 装配（researcher
  构造后移到 grounding 之后）；index.ts roleCustomTools 接 evidence 工具面；
  httpServer +/evidence/candidates +/evidence/ground；scriptedRuntime
  +citation/evidence/* 分支；errors +3 码（INVALID_CHUNK_ID 422 /
  CHUNK_NOT_FOUND 404 / SOURCE_NOT_FOUND 404）；前端 STAGE_LABELS/
  WORKFLOW_STAGE_SEQUENCES +evidence.ground（证据核验）。工具文件组织维持
  域内 tools.ts（retrieval/tools.ts 先例），集中 tools/ 目录收敛属审计 P1
  不在本轮。

## D-0038 M6.6 Evidence-aware Writing Loop：使用策略下沉 EvidenceSelectionService（usableEvidence 退役）+ writer 工具 formalOnly 视图 + digest 快照与主动查询双通道 + citations_evidence_backed Gate 规则（默认可检测不阻断）

- **日期**：2026-09-17（M6.6，Evidence-aware Writing Loop）
- **状态**：accepted
- **决策**：让 Writer / Reviewer 真正消费 Verified Evidence，六项决策：
  1. **使用策略唯一事实源**：新建 EvidenceSelectionService
     （backend/src/evidence/EvidenceSelectionService.ts），definitions.ts 的
     本地 usableEvidence 下沉至此（架构审计 P1：业务逻辑不堆 workflow
     definitions）。规则：正式证据（formal）= verificationStatus=verified
     且 source.sourceId 与 location.chunk（chunkId 锚点）齐备
     （isFormalEvidence 纯函数）；其余全部排除——unverified 派生标识
     legacy_unverified（classifyEvidence；存量记录不迁移不删除，M6.7
     收口）、plausible / mismatch / unverifiable / not_found 归 untrusted、
     verified 但缺锚点归 verified_missing_anchor（手工 / user_confirmed
     无 chunk 锚点的 verified 也不进正式上下文——三件套口径不打折）。
     **旧「trusted<3 时 unverified 兜底」行为废除**：digest 不再自动注入
     未核验线索；无 verified 时 prompt 显式提示弱化论断（宁可少说，不可
     拿未核验证据说满）。纯函数被 workflow 选择与 writer 工具视图共用，
     不存在两套口径。
  2. **writer 工具 formalOnly 视图**：evidenceToolsForRole 的 writer 分支
     构造 evidence_query 时传 formalOnly——构造边界强制 filter.status=
     verified + isFormalEvidence 过滤，Agent 运行期显式传 status=unverified
     也不放宽（策略不信任运行期参数；payload note 说明 writer 视图语义）。
     reviewer / citation 保持全量视野：识别 evidence_gap 需要看到未核验
     线索的存在；「只有 verified 可作 SUPPORTED 依据」的判定口径由
     prompt 约束（工具给视野，prompt 给纪律）。工具参数面零扩展
     （§M6.6-8：claimContains / sourceId / section / status M6.5 已满足）。
  3. **Writer prompt 双通道（兼容迁移，非拆除）**：digest 注入机制保留
     （静态快照仍是初始上下文——一次性给出可用的 verified 集合，避免
     每句 claims 都查一次工具烧 Token），内容改为只含 formal 池；行内
     关联 bib key：`- [E001]（cite: gao2023survey）claim…`，
     matchBibliographyKey = DOI 精确 → 归一化 title（+ 年份一致）
     （EvidenceRecord → source metadata → citation：引用生成优先使用有
     已核验证据支撑的 key）；附 evidence_query 主动查询指引（快照不够时
     按 claimContains / sourceId / section 查，无果弱化删除，不虚构）。
     planOutline / writeSection / reviseSection（含 abstract 分支）接齐。
  4. **Reviewer fact 模式主动核验**：digest 行带 chunk 锚点；fact 模式
     增加「逐 claim 先 evidence_query 后判定、get_chunk 回查原文、只有
     verified 可作 SUPPORTED / PARTIALLY_SUPPORTED 依据、unverified 只是
     线索」指引；无 verified 时「所有强论断应标 UNSUPPORTED（可用
     evidence_query 查询确认）」。academic / style 模式不带 fact 工具
     指引（Evidence 快照仍注入供学术评审参考）。
  5. **citations_evidence_backed Gate 规则**：新增确定性
     computeEvidenceCitationCoverage（quality/evidenceCitationCoverage.ts；
     cited keys（CitationReport.static）↔ formal evidence 的 bib key 集合，
     匹配规则与 matchBibliographyKey 同源单点）+ Quality Gate 新规则：
     **默认呈现覆盖计数不阻断**（接入期存量项目 verified 覆盖率必然低，
     直接阻断会全量误伤——检测能力先落地，阻断口径独立开关）；
     thresholds.requireEvidenceBackedCitations=true 时未覆盖引用阻断
     Final。覆盖明细（covered / uncovered / byKey）随 gate 产物落盘
     （quality-gate-r*.json）。bib 中不存在的 key 记未覆盖但不归本规则
     管（结构问题由既有 citation_structure_valid 处理，不双罚）。
  6. **可观测性**：review.run / writing.sections stage 结果新增
     evidenceFormal / evidenceExcluded（legacyUnverified / untrusted /
     verifiedMissingAnchor 分类计数）；workflow 本地 usableEvidence 改为
     evidenceSelection.selectForWriting 薄代理（revision.revise /
     outline.plan 等调用点签名不变）。
- **理由**：M6.5 建立了 Verified Evidence 供给，但消费侧仍是「workflow 塞
  静态 digest + unverified 兜底」——证据来源不透明、无法动态查询、无法保证
  verified 口径、生命周期未进 Agent loop（§M6.6-2 四问题）。双通道设计
  （快照 + 工具）兼顾两者：快照保证每次写作有基线证据可用（冷启动 / 低频
  场景不空转），工具通道允许按需深查（长尾 claim 不受快照限量 20 束缚）；
  「不自动全量注入、不逐句强制查询」对应 §M6.6-17 反淹没纪律。writer 视图
  在构造边界收紧而 reviewer 全量，是「写作用证据（strict）」与「审稿判
  缺口（aware）」的职责差异。Gate 默认不阻断是对接入期的诚实：规则的
  价值先在「可检测、可解释（gate 产物可见）」，阻断留给显式配置。
  测试 +26（selection 10 / 工具视图 3 / coverage+Gate 8 / reviewer prompt
  3 / writer digest 2）；全量 1141 通过零回归。
- **不做**：新增 Agent / Evidence Agent（红线）；Runtime / Pi adapter /
  Retrieval 改动；Researcher legacy unverified 路径删除（M6.7 收口）；
  工具装配集中化（roleCustomTools 单点已存在于 index.ts，RoleDefinition
  {tools,skills} 收敛记 Known Limitation）；evidence_query 参数扩展；
  逐句强制 evidence_query 或全量 Evidence 注入（§M6.6-17）。
- **影响**：backend/src/evidence/ +EvidenceSelectionService.ts；tools.ts
  writer 视图 formalOnly；WriterService digest 渲染 + 指引（4 处 prompt）；
  ReviewerService fact 指引 + digest 锚点；quality/ +evidenceCitationCoverage.ts
  + gates.ts 规则 16；definitions.ts WorkflowServices.evidenceSelection +
  usableEvidence 薄代理 + gate 接线 + stage 计数；serviceStack 装配。
  测试：evidenceSelection.test.ts（新）/ evidenceTools.test.ts（writer
  视图 +3、既有断言随语义升级调整）/ quality/evidenceCitationCoverage.test.ts
  （新）/ agents/reviewerEvidencePrompt.test.ts（新）/ WriterService.test.ts
  （+M6.6 describe）。

## D-0039 M6.7 Revision Safety：RevisionPlanItem 生命周期化（状态机 + riskLevel / relatedEvidenceIds）+ revision.validate stage（修订写入后、复审前四类确定性复核，条目级归因）+ Claim Strength Gate（强 claim 弱证据）+ Revision Gate 两规则 + hitl.revision_validation（approve / reject=恢复快照 / needs_review）

- **日期**：2026-09-18（M6.7，Revision Safety & Quality Gate Evolution）
- **状态**：accepted
- **决策**：把修订闭环从「Reviewer 发现问题 → Writer 修改」升级为
  「Revision Plan → Evidence-aware Revision → Revision Validation →
  Quality Gate → Accepted Manuscript」，核心原则 Revision ≠ Correct
  Revision（修改后的文本必须重新满足：Evidence 支持、Citation 一致、
  Fact 保持、Claim 强度合理）。八项决策：
  1. **升级既有 RevisionPlan 而非另造结构**（M4.7 D-0026 的计划是唯一
     事实源）：字段映射 problem≡finding、instruction≡requestedChange、
     planned≡pending（产物兼容，旧断言不因改名碎裂）；新增
     riskLevel（确定性派生：fact_preserve / citation_* / external →
     high；major → medium；minor / build / gate → low）与
     relatedEvidenceIds（finding 的 evidenceRef ∪ citation 条目经
     evidenceLinks（matchBibliographyKey 同源）关联的 verified
     evidence——Evidence Re-validation 的对象在计划期就固定）。
  2. **状态机（review/revisionItemStatus.ts，纯函数）**：planned →
     applied → validated / rejected / needs_review；rejected → planned
     （重派发，清执行痕迹）/ approved；needs_review → approved /
     rejected / validated；validated / approved / skipped 为终态。非法
     流转（planned → validated 跳过执行、终态复活）确定性抛错并列出
     全部违规，不做部分应用——状态损坏应当被发现而不是被吞掉。每次
     流转补写 appliedAt / appliedRevision / targetChanged / resolvedAt /
     resolution（reason 码 + 人读说明）。
  3. **revision.validate stage 的位置与职责**：revision.revise / apply
     写入之后、尾部重走（citation.verify → review.run → gate）之前。
     四类复核全部确定性无 LLM：Fact / Citation Preservation 复用 M5.6
     compute（sourceRevision → revision 窗口）；Claim Strength 与
     Evidence Re-validation 为 M6.7 新增。违规按**文件级归因**到条目
     （口径与派发侧 sectionMatches 一致；摘要引用归组装根 main.tex，
     因 writeMainTex 把 outline.abstract 组装进 main.tex）——保守归因：
     违规只可能来自被改写的文件，宁可重派一轮不静默放行。
  4. **Claim Strength 检测的诚实边界**：句级 diff + marker 启发式
     （与 styleInvariants 同级，不是语义理解）。只报「升级到 strong」
     的句子（强 marker 平移不报）；授权 = 计划条目文本或关联 formal
     evidence 文本包含该强 marker 或该句引用的数字（数字即强度依据）。
     矩阵：strong + insufficient → block（条目 rejected）；strong +
     partial → warning（条目 needs_review）；strong + direct → 合法
     （不产生 finding）。宁可漏报不制造海量误报。
  5. **targetChanged=false 不构成拒绝**：Writer 输出与原文逐字相同时，
     「修改要求是否真正落实」由下一轮复审仲裁（同 finding 指纹再现 →
     新计划重新派发，收敛判定照常生效）——验证层只裁四类确定性违规，
     不猜测 Writer 意图。（曾实现为 rejected，真实回退发现会把合法的
     「Writer 认为已处理」场景误判为失败并强制 HITL。）
  6. **Revision Gate 两规则**（输入对齐被审阅修订才消费；不对齐 / 无
     修订 → 规则不出现，与 Preservation null 同纪律）：
     revision_items_resolved（rejected / needs_review > 0 → FAIL）与
     claim_strength_guard（block > 0 → FAIL；warning 计数可解释）。
     用户 approve 覆盖自动判定（规则放行 + detail 记录「用户已明示
     接受」——覆盖必须可审计，不静默）。M5.6 两层 Preservation 规则
     口径不变（M6.7 是加层不是改尺）。
  7. **HITL 语义**：hitl.revision_validation 在 validation blocked 时
     出现（先于复审——Revision Validation → Quality Gate 的顺序即
     「先裁修订正确性，再审整体质量」）。approve：rejected /
     needs_review → approved（validated 是机器复核终态，不接受用户
     翻转——要推翻走 reject）。reject：ManuscriptRevisionStore.restore
     恢复 sourceRevision 快照 = 提交新的不可变修订（历史不改写；
     Preservation 对 restore 修订不可比较——不是 Writer 改稿）。
     needs_review：保留修订但阻断 Final（Draft 路径不受阻——质量语义
     不阻塞构建，D-0015 口径延伸）。回答新鲜度按 validationId：修订
     未产生新修订号时（Writer 输出与原文相同，commit created=false）
     revision 号会与前一轮撞号，按号判定会误把新一轮复核当成已回答。
  8. **消费侧最小改动**：Reviewer 结构化输出新增可选 evidenceRequirement
     （required / optional / none；非法值丢弃不整条拒绝，category 兜底）；
     Writer reviseSection 新增 revisionItems / itemEvidence 参数——prompt
     渲染「修订计划条目（结构化）」区块（含关联证据「修改前依据：修改后
     表述必须仍被其支撑否则弱化」）；issues 通道保留（旧调用 / 执行期
     派生回退兼容）。
- **理由**：M5.6 真实盲评暴露的两层 Preservation 只覆盖「数字变了吗 /
  引用少了吗」；pair 复核发现的第三类修订风险——证据弱但表达强
  （「可能改善」→「显著提升」）——不触发任何既有规则（数字没变、引用
  没动）。同样，M4.7 的修订计划是「派发清单」：派发过 ≠ 执行了 ≠ 修对
  了，条目没有终态，gate 无法回答「这轮修订解决了什么」。生命周期 +
  四类复核 + 条目归因把「修订正确性」变成确定性可判定对象；HITL 把
  最终接受权留给人（approve 留痕、reject 可回滚、needs_review 阻断
  Final 不阻断 Draft）。架构故事不靠加 Agent：少量角色 Agent + 强 Tool +
  Evidence Layer + Quality Gate 的分层在修订侧闭环。
  测试 +31（状态机 5 / claimStrength 8 / revisionValidation 纯函数 9 /
  Revision Gate 规则 5 / 全链路 e2e 3）+ M5.6 gate e2e 适配（断言升级为
  生命周期口径：机器 rejected → 用户 approved 留档）；全量 1171 通过
  零回归。
- **不做**：新增 Agent / Revision Agent（红线：流程纪律属于确定性代码，
  D-0008/D-0026 一脉）；Runtime / Retrieval / Evidence Grounding 改动；
  Writer 大改（reviseSection 增参兼容）；语义级 claim 强度理解
  （marker 启发式 + 复审仲裁 + 人审，不冒充语义等价证明）；前端
  专项 UI（HITL 决策面板按 options 泛化渲染，验证产物经 reviews/ API
  可查）。
- **影响**：backend/src/review/ +revisionItemStatus.ts +revisionValidation.ts
  （revisionPlan.ts 生命周期字段）、quality/ +claimStrength.ts（gates.ts
  规则 17/18）、workflow/definitions.ts（revision.validate /
  hitl.revision_validation stage + planner 接线 + revise 派发回写 +
  gate 消费）、agents/ReviewerService.ts（evidenceRequirement）、
  writer/WriterService.ts（结构化条目区块）、runtime/scriptedRuntime.ts
  （[strength:escalate] 标记）。测试：revisionItemStatus / claimStrength /
  revisionValidation / revisionGate（新）+ revisionValidationFlow（新 e2e）；
  citationPreservationGate / factPreservationGate / revisionLoop 断言随
  生命周期语义更新。

## D-0040 M6.8 Evaluation Framework：scripted 离线确定性评估（ground truth 数据集 + 三实验三/两臂 + fault injection 复用 scriptedRuntime 标记 + 人工校准接口），不新增产品功能

- **日期**：2026-09-18（M6.8，Agent Reliability Evaluation Framework）
- **状态**：accepted
- **决策**：为回答三个实验问题（Evidence Grounding 是否降低错误 / Revision
  Safety 是否降低事实漂移 / Agent Workflow 是否比普通 LLM 或 RAG 更可靠）
  建立 evaluation infrastructure——不新增 Agent、不改 Runtime / Workflow /
  Evidence Pipeline / Writer / Reviewer（M6.8 红线）。形态：
  - **代码位置**：`backend/src/evaluation/`（datasets / metrics / runners /
    cli；随 backend 构建进 dist），入口 `npm run evaluation`
    （`scripts/evaluation.mjs` → dist cli；与 benchmark-review 同约定：
    先 build 后跑）；报告 `evaluation/reports/*.json`（schemaVersion=1
    结构化事实源 + Markdown 摘要）；人工校准记录
    `evaluation/calibration/records.jsonl`（JSONL，人工维护）。
  - **数据集**：高质量小数据（Exp1 六场景 / Exp2 七场景 / Exp3 五场景），
    全部自造学术语料（与 M6.4 benchmark 同风格，确定性离线）+ ground
    truth 标注（faultClass / supportable locator / 期望 stage 章节引用）；
    结构校验（needle 逐字、fabricated quote 不在语料、marker↔注入类别
    一致、metadataCorrupted 来源必须配 authoritativeYear、正例不得锚定
    损坏元数据来源）在 CLI 启动与测试双重执行，脏数据拒绝运行。
  - **Experiment 1（grounding）**：三臂 plain-llm（零核验自报入池）/
    rag（真实 RetrievalService 条件化——检索命中即用 chunk 逐字切片
    替换 quote，无核验）/ paperteam（三段核验）。metadata 权威记录用
    数据集内置 ground-truth provider（确定性替身）；语义 judge 用
    ground-truth judge runtime（唯一 LLM 阶段的确定性替身）。指标：
    unsupported claim rate / fabricated citation rate / evidence
    coverage + 处置通道计数；运行期做「处置 vs ground truth」一致性
    自检（不一致记 issues 并以非零退出码暴露）。
  - **Experiment 2（revision safety）**：两臂 baseline（Reviewer→Writer
    输出直接接受——同源故障由 scriptedRevision 物化）vs paperteam
    （WorkflowOrchestrator 全链路 + revision.validate + Gate）。故障注入
    复用 scriptedRuntime 既有标记 [fact:mutate] / [cite:drop] /
    [strength:escalate]（唯一事实源，不重复实现）+ 干净对照场景度量
    误拦。HITL 策略可配置（默认 reject=安全缺省）。指标：三类存活率 +
    false acceptance + false rejection。
  - **Experiment 3（agent workflow）**：两臂 plain-llm（scenario 携带的
    代表性单次生成，缺陷如实标注）vs paperteam（完整 idea_to_paper；
    带语料场景 run 前预置 anchored 候选、经 evidence.ground 真实转正）。
    指标：claim correctness（可追溯到 verified evidence）/ citation
    correctness（反捏造）/ completeness（stage+章节+论断+引用四项平均）/
    human preference（校准记录驱动，无记录=null 不伪造）。
  - **人工校准**：records.jsonl 记录 claim / prediction / humanLabel /
    reason；runner 计算一致率 + 逐 prediction 分组；脏行如实计数不炸
    报告；Exp3 人工偏好用 humanLabel=prefer-<arm>。
- **理由**：M6.5/M6.6/M6.7 各自的单测钉死了机制行为，但「三个核心主张
  是否成立」需要可重复的对照实验与量化指标；评估必须独立于产品代码
  演化（不改被测系统）才能长期可信。scripted 离线口径的边界如实声明：
  度量的是确定性安全机制对注入故障的拦截率与管线保障（traceability /
  反捏造 / 完整度），不是真实模型生成质量——后者需要 live run（框架
  与校准接口已预留，属后续节点）。
- **不做**：真实模型 live 评估（成本与不稳定采样属后续节点）；新增 Agent /
  修改被测系统任何行为（红线）；大规模数据集（明确选择高质量小数据）；
  评估结果进 Quality Gate（评估只读系统，不反向影响产品决策路径）。
- **影响**：backend/src/evaluation/（新目录：types / datasets×4 / metrics×4 /
  runners×5 / cli）+ scripts/evaluation.mjs（新）+ evaluation/{README.md,
  calibration/records.example.jsonl, reports/}（新）+ 根 package.json
  scripts.evaluation；测试 backend/test/evaluation/×5（scenarios 7 /
  metrics 12 / faultInjection 7 / report 4 / baseline 2 = 32 用例）。
  产品代码零改动（src 侧唯一新增文件均在 evaluation/ 目录内）。

## D-0041 M6 Architecture Freeze：Evidence-grounded Research Agent 架构冻结（Search / Retrieval / Evidence / Evaluation 分层定型），后续扩展进入 M7

- **日期**：2026-09-18（M6 Documentation Freeze；M6 COMPLETE）
- **状态**：accepted
- **决策**：M6（M6.0 baseline freeze – M6.9 multi-model evaluation）收口，
  架构按当前实现形态冻结（总图 ARCHITECTURE §1.3，总览
  docs/research/M6_FINAL_SUMMARY.md）。冻结内容：
  - **Evidence-grounded Agent Architecture 定型**：确定性 Workflow 编排 +
    少量角色 Agent（Researcher / Writer / Reviewer / Citation——D-0009
    红线贯穿 M6 全程零新增 Agent）+ 强 Tool 层（search_papers /
    retrieve_library / get_chunk / propose_evidence / evidence_query）+
    Evidence Layer + Quality Gate。能力扩展走 Tool / Layer / Gate，不开
    新 Agent 角色。
  - **Search / RAG / Evidence 分层**（D-0033 六层最小接口的落地形态）：
    Research Discovery（§14，发现，默认零持久化）→ Literature Library
    （M6.2，SourceIdentity 身份键 + 候选-正式分离）→ Retrieval Layer
    （§15，Derived State，零 EvidenceStore 写路径）→ Evidence Grounding
    Layer（§16，候选-转正状态机 + 三段核验，grounded 写入唯一入口）→
    消费层（§17，EvidenceSelectionService 唯一使用策略）→ 修订安全
    （M6.7，Revision Item 生命周期 + revision.validate + Claim Strength
    Gate）→ Quality Gate → Final Manuscript。核心不变量
    **Retrieved ≠ Verified ≠ Grounded** 贯穿全链，写入路径单点化
    （EvidenceGroundingService.appendBatch / markResolved）。
  - **评估结果**（M6.8 scripted + M6.9 live/多模型，结论限定 evaluated
    scenarios）：scripted 三实验——fabricated 25.0%→7.1%（rag）→0%
    （paperteam）、unsupported 17.9%→0%（仅 paperteam）、revision 故障
    存活率 100%→0%（零误拦）、traceability 0→60%；live 五模型族
    （GLM-5.3 / claude-fable-5-1 / gpt-5.4 / deepseek-v4-pro /
    qwen3.7-max）——Plain LLM 25/25 提案捏造（逐模型 100%），PaperTeam
    pipeline 零捏造证据泄漏（fabricatedLeaked=0；metadata 陷阱拦截 6
    条、转正 19/25）。限制如实：小样本、有限场景、same-model judge
    bias、同一网关公共混杂（M6.9 报告 Limitations 同口径，不外推）。
  - **评估纪律**：评估只读被测系统（不反向影响产品决策路径）；公开文档
    与报告只使用公开模型名，内部路由别名只经
    `PAPERTEAM_EVAL_GLM53_GATEWAY_MODEL` 环境变量注入。
- **理由**：M6.1（D-0033）冻结的六层接口已在 M6.2–M6.9 逐层实现并被
  三层证据支撑（单元/集成测试钉死机制、scripted 对照实验量化拦截率、
  live 多模型评估验证真实模型行为）；分层与不变量经 M6.6 架构审计
  （AGENT_ARCHITECTURE_AUDIT.md）确认边界清晰。冻结使后续里程碑（M7）
  在稳定底座上扩展，避免持续重开已验证的分层决策。
- **不做**：不在 M6 冻结形态上重开已拒绝项（Vector DB / 外部索引引擎 /
  reranker / 内部 MCP / 第五角色 Agent / Evidence Agent）；FullTextResolver
  （D-0033 六层中唯一未实现层）、Reference Paper Intelligence、
  Multimodal Review、evaluation live 扩展（多场景 / 异模型 judge /
  Exp2·Exp3 live 化）、Researcher legacy 收口与 roleCustomTools 集中化
  ——全部进入 M7（Entry Point 见 PROJECT_STATUS「M7 — Entry Point」段）。
- **影响**：纯文档里程碑（Documentation Freeze，零代码改动）：PROJECT_STATUS
  （M6 COMPLETE + M7 Entry Point）、CHANGELOG（M6 完成记录 + M6.9 条目）、
  ARCHITECTURE（头部状态 + §1.3 M6 冻结架构 + §19 Live/Multi-model
  Evaluation）、docs/research/M6_FINAL_SUMMARY.md（新）与本决策。

## D-0042 M7 Research Discovery Architecture：Researcher Agent + Tools（不新增 Search / Planner Agent）

- **日期**：2026-09-19（M7.0 决策收口补登记；M7.1a 已实现 @ `017ad31`）
- **状态**：accepted
- **决策**：Research Discovery（用户研究问题 → 外部检索 → 候选 → 文献库 →
  证据）采用 **Researcher Agent + Tools** 架构收口，而不是新增 Search Agent /
  Planner Agent。四项内容（对应 M7_SCOPE_FREEZE §8 预告的登记范围）：
  1. **检索能力 = 既有工具面 + prompt 接线**：search_papers / search_web /
     lookup_paper 早已经 roleCustomTools 挂载 researcher 会话（M6.3）；M7.1a
     修复 P-A（ResearcherService 任务 prompt 重写为检索优先，禁止凭记忆断言
     文献存在性/年份/venue）并新增 save_candidates 工具（P-B：服务端检索缓存
     按下标回放，复用 saveAcademic/WebCandidates 单一写入口，Agent 无法按值
     伪造元数据入库）。
  2. **检索编排在确定性服务层**：provider 选择 / 并发 fan-out / 融合去重 /
     降级全部是 ResearchDiscoveryService 代码（D-0035）；query 生成是
     Researcher 既有职责，无独立 LLM 决策面——新增角色只会制造第二个持有
     检索能力的会话面（D-0009 四准则逐一不满足）。
  3. **FullTextResolver 挂接点冻结**（M7.2 实现位置）：SourceImportService
     .tryResolveFullText（promote 后台尝试 + 手动重试端点），下载 PDF 走既有
     importPdf 管线（contentHash 判重 + chunk 签名自动刷新）；chunker /
     检索 / Evidence 核验零改动。
  4. **Crossref 勘误声明**：M6.1 ADR §3 架构图中的 Crossref discovery 节点
     属文档张力——Crossref 保持 MetadataResolver 职责（D-0033「裁判与选手
     分离」），不做 discovery provider；M7.2 文档收口时勘误（零代码）。
- **理由**：保持最小 Agent 拓扑（D-0009 + D-0041 零重开）；复用既有
  SearchService 与 M6 全部测试资产（1545 行 search 测试不动）；避免 workflow
  扩张（保存发生在 Agent 会话内，无新 stage，research.json schema 零变化，
  候选必经用户 promote，HITL 不变）；Evidence-grounded pipeline 不变量延续
  （Retrieved ≠ Verified ≠ Grounded；discovery 链路无 EvidenceStore 写路径）。
- **不做**：Search Agent / Planner Agent / 第五角色；Runtime 与 Workflow 改动；
  Memory / 浏览器自动化 / Vector DB / RAG 重构（M7_SCOPE_FREEZE §5 八项
  红线全部维持）。
- **影响**：M7_SCOPE_FREEZE.md 正式生效（范围 = §4 四项最小改动集）；M7.1a
  已按本决策落地（`017ad31`：prompt 接线 + save_candidates + 进程内检索缓存
  + 护栏测试 +21，全量 1263 测试零回归）；M7.1 验收 = 冻结文档 §6-M7.1
  三条底线（真实项目端到端磁盘证据 / 红线回归全绿 / 全量测试零回归）；
  M7.1 真实 Agent 验证报告见 docs/research/M7.1_DISCOVERY_VALIDATION.md。
