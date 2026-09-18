# PaperTeam 项目状态

> 更新日期：2026-09-18（**M6.8 Agent Reliability Evaluation Framework
> COMPLETE**——建立评估基建回答三个实验问题，不新增产品功能（红线：
> 零新增 Agent、不改 Runtime / Workflow 核心 / Evidence Pipeline /
> Writer / Reviewer）：`backend/src/evaluation/`（datasets/metrics/runners/
> cli）+ `npm run evaluation` 统一入口（scenario 选择 / HITL 策略）+
> `evaluation/reports/*.json` 结构化报告 + `evaluation/calibration/
> records.jsonl` 人工校准接口（prediction vs humanLabel 一致率 + Exp3
> prefer-<arm> 偏好）；高质量小数据集（Exp1 六 / Exp2 七 / Exp3 五），
> 自造学术语料 + ground truth 标注 + 结构校验（脏数据拒绝运行）；三
> 实验：①Evidence Grounding 三臂（plain-llm / rag / paperteam）注入
> fabricated quote / unsupported claim / metadata mismatch——错误率
> 25.0%→7.1%→0%（unsupported 17.9%→0% 仅 paperteam，rag 持平）且
> 正例 coverage 100% 无损；②Revision Safety 两臂注入
> [fact:mutate]/[cite:drop]/[strength:escalate]（scriptedRuntime 同源
> 故障）——存活率 / 零信号放行 100%→0%、干净对照零误拦、拦截点前移至
> revision.validate；③Agent Workflow 两臂——traceability 0→60%（无语料
> 场景按 M6.6 口径诚实计 0）、反捏造 40→100%、完整度 24→100%、人工
> 偏好 null（无校准记录不伪造）；scripted 离线边界如实声明（度量确定性
> 安全机制对注入故障的拦截率与管线保障，非真实模型生成质量——live run
> 属后续）；评估代码零 import 测试辅助、临时根即用即删；详见下方 M6.8
> 条目与 docs/research/M6.8_EVALUATION_REPORT.md、DECISIONS.md D-0040。
> 同日 **M6.7 Revision Safety & Quality Gate Evolution
> COMPLETE**——修订闭环从「Reviewer 发现问题 → Writer 修改」升级为
> 「Revision Plan（条目生命周期）→ Evidence-aware Revision → Revision
> Validation → Quality Gate（Revision Gate）」：RevisionPlanItem 升级为
> 带 riskLevel / relatedEvidenceIds / 状态机的 Revision Item（planned(≡pending)
> → applied → validated / rejected / needs_review / approved，非法流转确定性
> 拒绝）；新增 `revision.validate` stage（修订写入后、复审前，纯确定性：
> Fact / Citation Preservation 复用 M5.6 + Claim Strength 强 claim 弱证据
> 升级检测 + Evidence Re-validation 关联证据再核验 + 新增引用 evidence-backed
> 覆盖，结果按文件归因到条目并回写终态）；Reviewer 结构化输出新增
> evidenceRequirement（required / optional / none）；Writer reviseSection
> 直接读取结构化 Revision Item（id / 风险 / 关联证据 / 修改前依据）；
> Quality Gate 新增 revision_items_resolved 与 claim_strength_guard 两条规则
> （rejected / needs_review 阻断 Final；用户 approve 覆盖并记录在案）；
> HITL `hitl.revision_validation`（approve / reject=恢复修订前快照 /
> needs_review=保留但阻断 Final）；产物 `reviews/revision-validation-r*.json`；
> 红线维持：零新增 Agent、Runtime / Retrieval / Evidence Grounding 不动；
> 详见下方 M6.7 条目与 DECISIONS.md D-0039；下一节点 **M6.8 Evaluation
> Framework**。同日 **M6.6 Evidence-aware Writing Loop COMPLETE**——
> Writer / Reviewer 真正消费 Verified Evidence：EvidenceSelectionService
> （usableEvidence 从 workflow definitions 下沉；正式证据 = verified +
> sourceId + chunkId 三件套，legacy unverified 派生标识
> legacy_unverified 不再自动注入 prompt）；writer 的 evidence_query 升级
> formalOnly 视图（构造边界强制 verified + 锚点，Agent 传参不可放宽）；
> Writer/Reviewer prompt 保留 digest 快照（兼容迁移）但只含 verified、
> 行内关联 bib key（EvidenceRecord → source metadata → citation）并加
> evidence_query / get_chunk 主动查询指引；Quality Gate 新增
> citations_evidence_backed 规则（citation ↔ verified evidence 覆盖可检测；
> 默认呈现不阻断，requireEvidenceBackedCitations=true 才参与判定）；
> 详见下方 M6.6 条目与 DECISIONS.md D-0038；（M6.6 原计划的「M6.7 收口
> （Researcher legacy path 迁移 + usableEvidence 完全退役）」被修订安全
> 里程碑取代，legacy 收口并入 M6.8 Evaluation 前置清理）**；同日
> **M6.5 Evidence Grounding Pipeline COMPLETE**——
> evidence/ 域：EvidenceCandidate 候选-转正状态机（pending → verified /
> mismatch / rejected / unverifiable）+ 三段核验管道 EvidenceGroundingService
> （quote 逐字校验（确定性）/ metadata 核验（共享 ScholarlyResolver）/
> 复用 Citation 角色的语义 judge（唯一 LLM 阶段））+ Evidence 工具面
> （get_chunk / propose_evidence / evidence_query；grounded EvidenceStore 写入
> 唯一入口在核验管道，工具零写路径）+ idea_to_paper 新增 evidence.ground
> stage（research 后 feasibility 前）；详见下方 M6.5 条目与 DECISIONS.md
> D-0037；下一节点 **M6.6 Agent Integration（Writer/Reviewer 消费侧重构）**；
> 同日 **M6.4 Project RAG & Hybrid Retrieval COMPLETE**——
> retrieval/ 域：确定性 SourceChunk 管线（稳定 ID / section-aware /
> page provenance / contentHash 失效）+ 进程内 BM25 lexical（中英 bigram
> tokenizer）+ optional dense（EmbeddingProvider 抽象 + 缓存 identity）+
> RRF hybrid + metadata filter + Context Budget Packing + retrieve_library
> 工具 + 固定 benchmark（Recall@K / MRR）；详见下方 M6.4 条目与
> DECISIONS.md D-0036；下一节点 **M6.5 Evidence Pipeline & Agent Integration**；
> 同日 **M6.3 Research Discovery & Academic/Web Search COMPLETE**——
> search/ 域：共享 ProviderHttpClient（超时/退避/Retry-After 双硬帽/熔断/健康四态）
> + OpenAlex primary / S2 fallback / arXiv preprint / AMiner China-secondary 四学术
> Provider + SearXNG optional Web Search + SourceIdentity 去重带权重 RRF 融合 +
> 显式 Candidate 持久化 + Provider Health API + Researcher search_papers v2 /
> search_web 工具；详见下方 M6.3 条目与 DECISIONS.md D-0035；2026-09-16
> **M6.2 Project Literature Library COMPLETE**——
> SourceIdentity 分层身份键 / CandidateSource Discovery 状态 / 五种入库路径
> （PDF·DOI·arXiv·URL·BibTeX）/ metadata 可信分层 merge / Evidence 引用删除
> 保护 / 老项目 lazy 兼容；详见下方 M6.2 条目与 DECISIONS.md D-0034；同日
> **M6.1 Search/RAG 架构冻结 COMPLETE**——6 开源项目源码
> 静态分析 + PaperTeam 盘点 + ADR D-0033 冻结（六层最小接口 / SearXNG 独立服务 /
> 无 Vector DB / 内部零 MCP）；**M6.0 M5 Baseline Freeze**——M5 冻结为完成基线、全量验证
> 与文档状态统一，M6 进入准备阶段；**M5.7 最终产品化收口**：per-Agent Provider / Model 配置
> （Settings agents 字段 + contextScope 确定性路由 + 会话级模型解析 + 失效 override
> 结构化失败，credential 与 override 解耦）+ 外部专家 / 导师 / 用户修改意见驱动修订
> （原文逐字保存、mandatory 最高业务优先级、`%%%PT-OUTCOMES%%%` 执行报告、确定性
> handled / conflict 状态机、冲突如实报告不篡改事实，安全 Gate 口径不变）；
> **M5.0–M5.7 全部 COMPLETE，M5 COMPLETE**；同日 **M5.6 事实安全收口**：pair-02
> 独立模型盲评暴露修订改写实验事实后，新增确定性 **Fact Preservation Gate**
>（表格数值 / 正文数字 / 公式 / 方向结论 / 数据集划分 / 硬件 / 占位回归 / 无依据新增；
> 授权只认计划 + Evidence；篡改稿拒绝冻结 Draft）+ Writer 修订契约与三个学术 Skill
> 收紧（不新增第四个 Skill）；真实模型最终 A/B 两臂 fact mutation 均被 Gate FAIL 拦截；
> pair-02 离线回归确认盲评全部主要问题可被确定性规则命中；
> 09-15 **M5.5 ✅ COMPLETE**：WSL2 + Docker Engine 真实验收；**Citation Preservation Gate**
>（确定性，Prompt 不是 Gate）、长论文执行超时分层、CI 首次全绿、修复后真实论文 A/B
>（A8 / B6 两臂均 Draft、引用丢失 0、Style Polish 真实触发并被 Invariant Checker 挡下）；
> pairwise 口径调整为 **Independent Model Pairwise Evaluation**（独立外部模型盲评，
> human review optional）；09-14 首轮验收：真实 26 页中文论文 A/B + Quick Review + 材料不足提案；
> 同日 **M5.4 Chinese Academic Style Revision Loop ✅
> COMPLETE**：stylePolicy suggest_only / apply_once、Style Invariant Checker、
> style-only HITL + 修订 + 强制复审、Quick Review 只读红线、M5 eval corpus；
> 同日 **M5.3 Controlled Academic Skill Integration ✅ COMPLETE**：三个学术 Skill 审计入库 + role/contextScope 路由 + 会话级版本
> 固定 + assigned/accessed 观测 + 受控 install/update + Skills 设置页；
> 09-12 **M5.2 Long-Running Governance ✅ COMPLETE 收口**：
> context budget / session rotation / TTL·GC·容量 / 观测面与安全自愈；
> 09-11 M5.2 全局并发与有界受理、M5.1 两批完成、**M5 启动：M5.0 计划
> 冻结**；2026-09-10 **M4.8 Product Closure 完成，M4 ✅ COMPLETE**；同日
> M4.7 Draft/Final + Writer–Reviewer Closure；M4.6 Evidence Workbench；
> 2026-09-09：M4.5 HITL UI / M4.4 Workflow Live View；更早见历史）

## 当前阶段

**M4 — MVP Complete（✅，2026-09-10，v0.1.0-mvp）**：M4.8 Product Closure +
Version Experience + Public Repository Readiness 收口后，M4 全部完成。定位
**MVP / Alpha**（非 Production Stable）。

**M5 — Chinese Academic Quality & Long-Running Reliability（✅ COMPLETE，2026-09-11 启动 →
2026-09-16 收口）**：阶段定义与边界见 [M5_PLAN.md](M5_PLAN.md)——主线为
中文论文质量、长程 Runtime 可靠性（M5.1 ✅ / M5.2 ✅ 收口）、学术 Skill 受控
接入（M5.3 ✅）、Style Revision Loop（M5.4 ✅）、单机 Linux / Docker 部署
（M5.5 ✅ 2026-09-15 真实 Docker 验收）、真实论文 A/B 验收
（M5.6 ✅ 2026-09-16 — Fact Preservation 收口，见 [M5_ACCEPTANCE.md](M5_ACCEPTANCE.md)）、
最终产品化（M5.7 ✅ 2026-09-16 — per-Agent 模型配置 + 外部意见修订体验）。
**M5 整体：✅ COMPLETE（2026-09-16，M5.0–M5.7 全绿）— engineering goals achieved,
Skill quality gain not consistently demonstrated**（两轮独立盲评均判 Skill 开启臂
危害更小（2/2）但两臂都有事实违规且都被 Gate 拦截；Reviewer 分数两轮互为翻转；
如实记录，不宣称 Skill 已被证明提高论文质量；不打 tag——本语料无 Evidence、
Final 无法达成）。旧文档中「M5 = Visual Reviewer /
Skill / Deployment / System Admin（可选方向）」的表述已被取代：
Visual Reviewer 与 System Admin 移出 M5（见 M5_PLAN §2 非目标清单）。

**M5.7 Final Productization & Revision UX（✅ 2026-09-16）**：

- **Per-Agent Provider / Model Configuration**：Settings 的 `model.json` 新增
  `agents` 字段（writer / researcher / academicReviewer / factReviewer /
  styleReviewer / citationReviewer；`agentModelKeyForScope` 按 contextScope 前缀
  确定性路由，review/section、review/summary 归 academicReviewer）。Runtime 在
  初始化 / reconfigure 时经 `agentModelSpecs` 回调解析 override：会话按 scope
  使用各自模型（context budget preflight、任务终态 `metadata.model`、
  `modelStatusSnapshot().agents` 诊断全部按会话口径——usage / cost 可归因到
  Agent × 模型）；override 失效（不在注册表 / 无凭据）→ 该 Agent run 结构化失败
  （MODEL_NOT_CONFIGURED + 修复指引），不静默回落。credential 解耦：agents 只存
  provider/model 规格，Key 按 provider 复用官方 credential store（GET 永不回 key）；
  删除自定义提供商连带清除指向它的 override；PUT 缺省 `agents` 字段 = 保持现有
  override（旧客户端兼容；旧 model.json 无 agents 字段正常加载）。UI：模型设置页
  「Agent 独立模型配置」（默认全部继承并显示实际生效模型；单 Agent 展开独立
  Provider / Model / 测试连接；activeRuns>0 保存 409 不变）。**未引入 Model
  Router / 自动 fallback / 成本路由**。
- **External Expert / Advisor Revision Instructions**：`reviews/external-instructions.json`
  逐字保存外部意见（来源 / Reviewer 标识 / 涉及章节 / 幂等指纹 id；API GET / POST /
  DELETE）。意见进入确定性 RevisionPlan 为 `external_instruction` 条目、
  `priority=mandatory`（排序与派发先于内部意见；内部 Reviewer 建议冲突时让位），
  原文 `sourceText` 随计划留档；revision.apply / revision.revise 独立通道派发，
  Writer prompt 专用区块 + 事实红线 + `%%%PT-OUTCOMES%%%` 单行执行报告
  （applied / conflict / not_applicable + 依据）。**确定性状态机**：handled =
  报告 applied 且目标文件真实变化（stage diff 补记）+ 下一轮 gate fact
  preservation 复核通过（失败自动降级 unresolved 重派）；conflict = 与实验事实
  冲突（保留依据，不自动改事实，不重复派发）；applied 无实据 → unresolved；
  章节指错 → unresolved + 说明。UI：改进页外部意见面板（输入 + 状态徽章 +
  冲突依据 / 可选建议）+ 修订计划面板（MUST · Reviewer 2 来源标识、conflict /
  handled 关联展示）；`external_instructions.updated` SSE 事件驱动缓存失效。
- **安全边界不变**：Fact / Citation Preservation 与 Style Invariant 判定口径
  完全不受 mandatory 影响（授权仍只认计划点名旧值+新值（或 Evidence 含新值）；
  负结果→优势 hard rule 不放开）；Quick Review 保持 100% 只读（无修订 stage，
  天然不派发外部意见）；无外部意见 / 无 agent override 时全部行为与旧版一致。
- 测试：后端 +59（agentModel 25 / agentModelSettings 10 / externalInstructions 18 /
  workflow e2e 6），前端 +12（AgentModelPanel 5 / ExternalInstructions + RevisionPlan 7）；
  build / typecheck / test 全绿。真实 smoke：per-Agent 双 scope 实跑（writer override
  vs 继承默认的 metadata.model 验证）+ scripted 后端外部意见 conflict 全链路。

**M6 — Research Discovery & RAG（进行中：2026-09-16 M6.0 baseline established；
2026-09-16 M6.1 架构冻结 COMPLETE；2026-09-16 M6.2 Literature Library COMPLETE；
2026-09-17 M6.3 Research Discovery & Search COMPLETE；2026-09-17 M6.4
Project RAG & Hybrid Retrieval COMPLETE；2026-09-17 M6.5 Evidence Grounding
Pipeline COMPLETE；2026-09-17 M6.6 Evidence-aware Writing Loop COMPLETE；
2026-09-18 M6.7 Revision Safety & Quality Gate Evolution COMPLETE；2026-09-18
M6.8 Agent Reliability Evaluation Framework COMPLETE）**：

- **M6.8 Agent Reliability Evaluation Framework（✅ 2026-09-18）**：
  - **范围**：评估基建（不新增产品功能）——回答三个实验问题：Evidence
    Grounding 是否降低错误 / Revision Safety 是否降低事实漂移 / Agent
    Workflow 是否比普通 LLM 或 RAG 更可靠。代码
    `backend/src/evaluation/`（types / datasets / metrics / runners / cli）
    + `scripts/evaluation.mjs`（`npm run evaluation` 统一入口：experiment
    / scenario 选择、hitl-policy、out 目录、--list）+ 报告
    `evaluation/reports/*.json`（schemaVersion=1 事实源 + Markdown 摘要）
    + 人工校准 `evaluation/calibration/records.jsonl`（JSONL：claim /
    prediction / humanLabel / reason → 一致率 + 逐 prediction 分组 +
    Exp3 prefer-<arm> 偏好；脏行如实计数不炸报告）。**不含**：新增
    Agent / 修改 Runtime / Workflow 核心 / Evidence Pipeline / Writer /
    Reviewer（红线维持）、真实模型 live 评估（后续节点）、大规模数据集
    （明确选择高质量小数据）。
  - **数据集**：Exp1 六场景（自造中英学术语料 2-3 来源 × 正例 2-3 +
    故障 1-3）/ Exp2 七场景（三类注入 + 干净对照 2）/ Exp3 五场景
    （语料·修订环·无语料·中文·多轮收敛，各附代表性单次生成基线）。
    结构校验（needle 逐字、fabricated quote 不在语料、marker↔注入类别
    一致、metadataCorrupted 必配 authoritativeYear、正例不得锚定损坏
    元数据来源——首轮实跑发现的数据设计错误反推的规则）CLI 启动与
    测试双重执行，脏数据拒绝运行。
  - **Exp1（grounding）**：三臂 plain-llm（零核验自报入池）/ rag（真实
    RetrievalService 条件化：命中即用 chunk 逐字切片替换 quote，无核验；
    跨语言无词重叠不命中如实计入——M6.4 Known Limitation 口径）/
    paperteam（三段核验；metadata 权威记录与语义 judge 用数据集内置
    ground-truth 确定性替身，如实标注）。指标 unsupported claim /
    fabricated citation / evidence coverage + 处置通道计数；「处置 vs
    ground truth」一致性自检（不一致 → issues + 非零退出码，本轮
    0 不一致）。
  - **Exp2（revision safety）**：两臂 baseline（Reviewer→Writer 直通；
    同源故障由 scriptedRevision 物化——与 paperteam 臂同一份注入实现）
    vs paperteam（WorkflowOrchestrator 全链路 + revision.validate +
    Gate + HITL 策略默认 reject）；指标三类存活率 + false acceptance +
    false rejection（over-blocking）。
  - **Exp3（agent workflow）**：两臂 plain-llm（scenario 携带代表性单次
    生成，缺陷如实标注）vs paperteam（完整 idea_to_paper；带语料场景
    run 前预置 anchored 候选、经 evidence.ground 真实转正）；指标 claim
    correctness（可追溯 verified evidence）/ citation correctness（反
    捏造）/ completeness（stage+章节+论断+引用四项平均）/ human
    preference（无记录 null 不伪造）。
  - **结果**（evaluation/reports/，scripted 离线确定性）：Exp1
    fabricated 25.0%→7.1%（rag）→0%（paperteam）、unsupported
    17.9%→17.9%（rag 持平——引文真实≠论断被支撑）→0%、coverage 100%
    无损、处置通道 accepted 16 / quote_mismatch 5 / judge 5 / metadata 2
    与故障类一一对应；Exp2 三类存活率与零信号放行 100%→0%、干净对照
    零误拦、全部场景 Final、拦截点前移至 revision.validate（gate 安全
    规则全程 PASS——故障修订从未到达 gate，M6.7 分层按设计生效）；Exp3
    traceability 0→60%（无语料场景按 M6.6 口径诚实计 0）、反捏造
    40→100%、完整度 24→100%。
  - **测试**：后端 +32（scenarios 7 / metrics 12 / faultInjection 7
    （含 [cite:drop] 全链路 e2e）/ report 4 / baseline 2）；全量 1203
    通过 0 失败（M6.7 基线 1171 零回归）；`tsconfig.build.json` 全绿。
    已知环境事实：全量 tsc（含 test/）在当前 node_modules（typescript
    ^5.7.0 区间漂移至 5.9.3）下有 17 个存量类型错误，stash 验证在
    HEAD 上同样存在，非本轮引入、不在本轮顺手修（避免混入无关 diff）。
    决策 D-0040；报告 docs/research/M6.8_EVALUATION_REPORT.md（含论文
    主张映射与诚实约束、后续 live run 计划）。

- **M6.7 Revision Safety & Quality Gate Evolution（✅ 2026-09-18）**：
  - **范围**：修订安全闭环——Revision ≠ Correct Revision。RevisionPlanItem
    生命周期化（状态机 / riskLevel / relatedEvidenceIds）、`revision.validate`
    stage（修订写入后、复审前的四类确定性复核 + 条目归因）、Claim Strength
    Gate（强 claim 弱证据升级检测）、Evidence Re-validation（关联证据再核验）、
    Quality Gate Revision Gate（revision_items_resolved / claim_strength_guard）、
    HITL `hitl.revision_validation`、Reviewer evidenceRequirement 结构化输出、
    Writer 直接读取结构化 Revision Item。**不含**：新增 Agent / Revision Agent
    （红线维持：少量角色 Agent + 强 Tool + Evidence Layer + Quality Gate）、
    Runtime / Retrieval / Evidence Grounding 改动、Writer 大改（reviseSection
    增参兼容，issues 通道保留）。
  - **Revision Item 生命周期（§5）**：字段映射 problem≡finding、
    instruction≡requestedChange、planned≡pending（M4.7 名称兼容）；新增
    `riskLevel`（确定性派生：fact / citation / external → high，major →
    medium，表达 / 语法 → low）与 `relatedEvidenceIds`（finding evidenceRef ∪
    citation 条目经 bib key 关联的 verified evidence，evidenceLinks 与
    matchBibliographyKey 同源）。状态机（review/revisionItemStatus.ts）：
    planned → applied → validated / rejected / needs_review；rejected →
    planned（重派发）/ approved（用户）；needs_review → approved / rejected /
    validated；validated / approved / skipped 为终态——非法流转（如
    planned → validated 跳过执行、终态复活）确定性抛错，不做部分应用。
    每次流转补写 appliedAt / appliedRevision / targetChanged / resolvedAt /
    resolution（机器可读原因码 + 人读说明）。
  - **Revision Validation stage（§6-§9）**：`revision.validate` 在
    revision.revise / revision.apply 之后、尾部重走（citation.verify）之前执行，
    纯确定性无 LLM。四类复核：① Fact Preservation（复用 M5.6 compute
    —sourceRevision → revision 窗口）；② Citation Preservation（复用 M5.6）；
    ③ Claim Strength（M6.7 新：checkClaimStrengthEscalation 句级 diff——
    弱表述→强表述 / 新增强句，授权 = 计划文本或关联 formal evidence 文本包含
    强 marker 或同数字；strong+insufficient → block、strong+partial →
    warning、strong+direct 合法）；④ Evidence Re-validation（条目
    relatedEvidenceIds 在修订后仍存在且仍 formal（verified + 锚点））。
    违规按**文件级归因**到条目（口径与派发侧 sectionMatches 一致；摘要引用
    归组装根 main.tex），applied → validated / rejected / needs_review 终态
    回写计划。产物 `reviews/revision-validation-r{round}.json`（含 fact /
    citation 明细、claim findings、citation delta（新增引用 evidence-backed
    覆盖）、evidence recheck、用户决策）。诚实边界：targetChanged=false 不
    构成拒绝——「要求是否落实」由下一轮复审仲裁（finding 指纹再现 → 新计划
    重派发）；本层只裁四类确定性违规。
  - **Claim Strength Gate（§8）**：claim strength（weak / moderate / strong
    marker）× evidence support（direct / partial / insufficient，来自关联
    formal evidence 的 supportStrength）矩阵；升级到 strong 且未授权 →
    block（条目 rejected）/ warning（条目 needs_review）。与 Fact /
    Citation Preservation 互补：数字没变、引用没动但「可能改善→显著提升」
    的强度漂移在此拦截。启发式与 styleInvariants 同级（marker 级，非语义
    理解；宁可漏报不制造海量误报）。
  - **Quality Gate Revision Gate（§10）**：新增两条规则——
    `revision_items_resolved`（rejected / needs_review > 0 → FAIL；用户
    approve → 按决策放行并记录）与 `claim_strength_guard`（block 级 finding
    > 0 → FAIL；warning 计数可解释）。输入对齐被审阅修订才消费（旧 / 不对齐
    如 restore 后 → 规则不出现，与 Preservation null 同纪律）；明细随 gate
    产物落盘。M5.6 两层 Preservation 规则口径不变。
  - **HITL（§11）**：`hitl.revision_validation`（validation blocked 时出现，
    先于复审）：approve（条目 → approved，Revision Gate 放行）/ reject
    （ManuscriptRevisionStore.restore 恢复 sourceRevision 快照 = 新的不可变
    修订，历史不改写）/ needs_review（保留修订但 Revision Gate 阻断 Final，
    Draft 路径不受阻）。回答新鲜度按 validationId（防 Writer 输出与原文相同、
    created=false 时修订号撞号导致误判已回答）。用户最终控制：validated 是
    机器复核终态，不接受用户翻转（要推翻走 reject）。
  - **Reviewer 结构化输出（§13）**：ReviewIssue 新增可选
    `evidenceRequirement`（required / optional / none；非法值丢弃不整条
    拒绝），prompt 明确要求 fact / evidence_gap 给 required；确定性兜底
    按 category 推断（needsEvidence 优先消费显式声明）。
  - **Writer 接入（§12）**：reviseSection 新增 `revisionItems` / `itemEvidence`
    参数——prompt 渲染「修订计划条目（结构化）」区块（id / kind / riskLevel /
    needsEvidence 约束 / 修改要求 / 关联证据「修改前依据」：修改后表述必须
    仍被其支撑否则弱化）；issues 通道保留（旧调用 / 执行期派生回退兼容）。
  - **测试**：后端 +31（revisionItemStatus 5 / claimStrength 8 /
    revisionValidation 9 / revisionGate 5 / 全链路 e2e 3）+ M5.6 gate e2e
    适配（生命周期断言：机器 rejected → 用户 approved 留档）；全量 1171
    通过 0 失败。scriptedRuntime 新增 `[strength:escalate]` 标记。决策 D-0039。

- **M6.6 Evidence-aware Writing Loop（✅ 2026-09-17）**：
  - **范围**：让 Writer / Reviewer 真正消费 Verified Evidence——Evidence
    使用策略下沉（EvidenceSelectionService）、writer 工具 formalOnly 视图、
    Writer / Reviewer prompt 的 evidence-aware 改造（digest 只含 verified +
    工具查询指引）、citation 生成关联（EvidenceRecord → bib key）、Quality
    Gate citations_evidence_backed 规则。**不含**：新增 Agent / Evidence
    Agent（红线维持）、Runtime / Pi adapter 改动、Retrieval 层改动、
    Researcher legacy 路径删除（M6.7 收口）、工具装配集中化重构
    （roleCustomTools 现状记为 Known Limitation）。
  - **Evidence 使用策略（§10 唯一事实源 EvidenceSelectionService）**：
    正式证据 = `verificationStatus=verified` 且 sourceId + chunkId 锚点
    齐备；pending/unverified/plausible/mismatch/unverifiable/not_found 一律
    不得进入 Writer / Reviewer 正式上下文。`isFormalEvidence` 纯函数被
    workflow 选择与 writer 工具视图共用——不存在两套口径。legacy
    unverified 派生标识 `legacy_unverified`（classifyEvidence），存量记录
    不迁移不删除，M6.7 收口。
  - **writer evidence_query formalOnly 视图**：`evidenceToolsForRole`
    的 writer 分支构造 query 工具时传 `formalOnly: true`——无论 Agent
    运行期传什么 status，强制 verified + 锚点过滤（使用策略在构造边界
    生效，不信任运行期参数）；reviewer / citation 保持全量视野（识别
    evidence_gap 需要看到未核验线索；正式判定口径由 prompt 约束
    「只有 verified 可作 SUPPORTED 依据」）。
  - **Writer 接入（兼容迁移，非拆除）**：digest 注入机制保留（静态快照
    仍是初始上下文），但内容只含 verified formal 池（旧 usableEvidence
    的「trusted<3 时 unverified 兜底」行为废除）；digest 行内关联 bib key
    （`- [E001]（cite: gao2023survey）claim…`，DOI 精确 / 归一化 title+年份
    匹配）——Writer 引用生成优先使用有已核验证据支撑的 key；无 verified
    时显式提示弱化论断并指向 evidence_query 确认。planOutline /
    writeSection / reviseSection（含 abstract 分支）全部接入。
  - **Reviewer 接入（fact 模式重点）**：digest 行带 chunk 锚点；fact 模式
    增加主动核验指引——逐 claim 先 evidence_query（claimContains /
    sourceId）再判定，需要原文用 get_chunk 回查，只有 verified 可作
    SUPPORTED / PARTIALLY_SUPPORTED 依据，unverified 只是线索；无 verified
    时「所有强论断应标 UNSUPPORTED（可用 evidence_query 查询确认）」。
    academic / style 模式不带 fact 工具指引（职责不混淆）。
  - **Quality Gate**：新增确定性 `computeEvidenceCitationCoverage`
    （cited keys ↔ verified formal evidence；匹配规则与 bib key 关联同源）
    + `citations_evidence_backed` 规则：默认呈现覆盖计数（可检测不阻断——
    M6.6 接入期存量项目覆盖率必然低）；threshold
    `requireEvidenceBackedCitations=true` 时未覆盖引用阻断 Final。覆盖
    明细随 gate 产物落盘（quality-gate-r*.json）。
  - **可观测性**：review.run / writing.sections stage 结果新增
    evidenceFormal / evidenceExcluded（legacyUnverified / untrusted /
    verifiedMissingAnchor 分类计数）。
  - **测试**：后端 +26（evidenceSelection 10 / evidenceTools writer 视图 3 /
    evidenceCitationCoverage+Gate 8 / reviewerEvidencePrompt 3 /
    WriterService digest 2 更新），M6.5 / M6.4 / Writer / Reviewer 全量
    回归绿。决策 D-0038。

- **M6.5 Evidence Grounding Pipeline（✅ 2026-09-17）**：
  - **范围**：「检索到的原文段落」升级为「可信证据」——EvidenceCandidate
    候选-转正分离、三段核验管道（quote 逐字 / metadata / 语义 judge）、
    Evidence 工具面（get_chunk / propose_evidence / evidence_query）、
    idea_to_paper `evidence.ground` stage 接线、Researcher 兼容双路径、
    EvidenceStore appendBatch、HTTP candidates/ground 端点。**不含**：
    Evidence Agent / 第五角色（D-0009 拒绝）、Reviewer/Writer prompt 的
    evidence digest 拆除（只提供 evidence_query 能力，消费侧重构属 M6.6）、
    候选队列 HITL 确认语义、usableEvidence 下沉（审计 P1）。
  - **核心不变量**：Retrieved ≠ Verified ≠ Grounded——检索层（M6.4）零
    EvidenceStore 写路径红线不变；Agent 提案只入候选队列；grounded 写入唯一
    入口是 EvidenceGroundingService（appendBatch）；候选状态转换唯一入口是
    EvidenceCandidateStore.markResolved（终态保护）。工具层零写路径三重钉死
    （EvidenceReadAccess 只读投影类型 + 装配边界 + 行为测试）。
  - **三段核验**：Stage 1 quote 逐字校验（确定性：NFKC / 去零宽与软连字符
    U+00AD / 空白折叠 / 小写归一后子串匹配，最小 6 字符；失败 → mismatch
    终态——Agent 虚构引文在此拦截）；Stage 2 metadata（确定性；共享
    ScholarlyResolver；mismatch → 终态短路不进 judge；not_found/unresolved
    如实记录不阻塞——离线部署全链路可用，D-0023 口径）；Stage 3 语义 judge
    （唯一 LLM 阶段；复用 Citation 角色 scope citation/evidence/<id>；
    prompt 只喂 claim+quote+chunk 原文；supported→verified+direct /
    partially_supported→verified+partial / unsupported→rejected /
    insufficient_evidence→unverifiable 不伪造裁决；keyQuote 伪造剥离）。
  - **状态机**：pending → verified（带 evidenceId 回填）/ mismatch（quote 或
    metadata 不一致，终态）/ rejected（judge unsupported，终态）/
    unverifiable（chunk 缺失 / resolver 不可用 / judge 失败或无法判断——
    可 retry）；幂等（verified 重复 ground 复用 evidenceId；同文提案去重）。
  - **接线**：evidence.ground 位于 research.idea 后 research.feasibility 前
    （feasibility 与 Reviewer 消费的 evidence stats 必须是核验后口径；零候选
    no-op 通过、scripted/离线栈无感）；Researcher JSON evidence 字段带
    sourceId+chunkId+quote 锚定 → 候选管道（提案失败降级 legacy 追加）；
    无锚定 → legacy unverified 追加（输出契约与既有测试零变化）。
  - 测试：后端 +50（quoteVerification 10 / candidates 3 / EvidenceStore
    appendBatch +1 / 三段核验全路径 20 / 工具与权限矩阵 7（含安全红线「全部
    角色工具轮询后 evidence.jsonl 零写入」）/ stage E2E 2 + httpWorkflowApi
    序列更新）；全量 1115 通过零回归。决策 D-0037。

- **M6.4 Project RAG & Hybrid Retrieval（✅ 2026-09-17）**：
  - **范围**：「资料已入库且有全文后，Agent 如何稳定、准确、可追溯地找到当前
    需要的内容」——SourceChunk 管线、项目级 Retrieval Index、lexical / optional
    dense / hybrid、metadata filter、结果可追溯、Context Budget Packing、
    retrieve_library 工具、固定 benchmark。**不含**：Search Provider 新能力 /
    FullTextResolver（网络全文下载）/ Evidence 自动验证 / RetrievedChunk→
    EvidenceStore / Writer 自动检索编排 / reranker / Vector DB（全部 D-0033
    边界维持；M6.5 才做 Evidence Grounding）。
  - **Chunk 管线（`retrieval/{chunking,SourceChunker,ChunkStore}.ts`）**：
    section（TOC/markdown 标题）→ paragraph → sentence → word 四级切分；
    target 400 / max 600 / overlap 60 token（`estimateTextTokens` 同口径贯穿
    切分/嵌入/打包；env `PAPERTEAM_RETRIEVAL_CHUNK_*` 可调）；**稳定 chunkId
    `<sourceId>:<sectionId>:<节内序号>:<内容hash10>`**（节内序号保证前置章节
    漂移不破坏后续 ID；内容不变 rebuild 逐字节不变）；页码 provenance 来自
    pymupdf blocks（parser 无法提供时缺省，不伪造）。输入边界：PDF 走 paper 域
    PyMuPdfParser（`deriveDocumentStructure` 复用出口）优先、builtin 文本层
    回退（<200 字符判无全文）；text/markdown 直读；metadata-only / bibtex /
    image 结构化 skip（full_text_unavailable）——abstract 永不冒充全文。
    落盘 `sources/chunks/<sourceId>.jsonl` + `index.json` manifest（绑定
    contentHash，stale 自动重生成）+ 向量旁车；全部 Derived State 可删可重建。
  - **Lexical（`lexicalIndex.ts` + `tokenize.ts`）**：进程内 BM25
    （k1=1.2 b=0.75，零 Elasticsearch）；中英兼容 tokenizer——英文小写词 +
    连字符标识符整体/部分双索引（MRG-DTM），中文连续段 bigram + 尾单字
    （无分词服务依赖）；**章节标题并入索引 token 流**（正文保持纯净）；
    排序确定性（score 降序、并列 chunkId 字典序）；source 级增删 df 同步维护。
  - **Dense optional + 缓存 identity（`embedding.ts`）**：EmbeddingProvider
    抽象（identity 字段）；pi-ai 无 embedding API（盘点结论）→ M6.4 唯一实现
    是确定性测试 provider（token 哈希袋，验证机制不代表真实语义）；生产默认
    不注册 = lexical-only 健康运行（红线：dense 不可用 ≠ 服务失败）。向量旁车
    缓存 key = chunkId + contentHash + provider identity——换模型 / chunk 文本
    变化才重嵌，未变化重启零嵌入（测试钉死）；嵌入/查询失败降级 lexical +
    diagnostics.denseNote；显式 mode=hybrid 无 provider → EMBEDDING_UNAVAILABLE
    (422)，默认 auto 永不因此失败。
  - **Hybrid（`RetrievalService.ts`）**：RRF k=60 两通道等权（与 M6.3 fusion
    同思想；量纲无关不相加裸分数）；双通道命中合并单条（channels 双标记）；
    邻近 chunk 去重（同 source 同 section 连续 ≤2，防 overlap 副本刷屏）；
    metadata filter（sourceIds / sourceRole / section 前缀 / year 区间 /
    sourceType，打分前生效）。**索引新鲜度 = 文献库签名自动增量刷新**
    （sourceId:contentHash:updatedAt 对比；新增补建 / stale 重生成 / 孤儿清理 /
    损坏自愈）；每项目操作 promise 链串行、search 读不可变快照（rebuild 中
    检索不悬挂不损坏）；项目间状态零共享（跨项目泄漏测试钉死）。
  - **Context Budget Packing（`contextPacker.ts`）**：token 预算内贪心选择——
    邻近冗余（相邻 ordinal 跳过）、来源多样性（未限定 source 时单 source
    ≤50%+2）、source 限定查询不强插其他来源；引用标记
    `[SRC:S001 CHUNK:<chunkId> SECTION:Method PAGE:4-5]`（M6.5 回溯锚点）。
  - **retrieve_library 工具（`tools.ts`）**：Pi customTools（scholarlyTools 同
    模式）；**按会话 projectId 闭包构造**（roleCustomTools seam 扩展
    `(role, projectId)`——项目隔离由构造边界保证，Agent 无法跨项目）；
    researcher / writer / reviewer 三角色注册（最小接线，不改 workflow 不自动
    检索）；输出 packedContext + per-chunk 标记；工具描述明示
    「retrieved passages ≠ verified evidence」；**全程零 EvidenceStore 写路径**
    （域测试 + HTTP 测试 + 工具测试三处钉死）。
  - **HTTP API**：`POST /api/projects/:id/retrieval/search`（query / topK /
    mode / filter / budgetTokens→packed）、`POST .../retrieval/rebuild`
    （可选 sourceId；metadata-only 单源重建 422 SOURCE_NOT_INDEXABLE）、
    `GET .../retrieval/stats`；删除 source 连带索引失效（磁盘 + 内存 + manifest）。
    错误码 +4：SOURCE_NOT_INDEXABLE(422) / RETRIEVAL_NOT_READY(503) /
    EMBEDDING_UNAVAILABLE(422) / INVALID_RETRIEVAL_FILTER(400)。
  - **验证**：新增测试 **108**（tokenize 9 / chunking 17 / sourceChunker 8 /
    lexicalIndex 10 / embedding 6 / contextPacker 8 / retrievalService 21 /
    tools 6 / retrieval.http 10 / benchmark 4 / performance 2 + fixtures；
    全离线确定性，真实 pymupdf 仅 attention.pdf 一个 fixture 测试与既有
    pdfIngest 同口径）。**Benchmark**（固定 fixture：6 source×多章节 + 1 fake
    PDF 页级源，22 queries 五类）：lexical R@1=0.86 R@5=0.90 R@10=0.90
    MRR=0.87 section-hit=1.00 exact-R@5=1.00；hybrid(mock dense) R@1=0.81
    R@5=0.95 R@10=1.00 MRR=0.86——mock dense≈词重叠，验证融合机制；
    跨语言语义查询（无词重叠）如实计入且当前不命中（Known Limitation）。
    **性能冒烟**：4290 chunks lazy 索引 619ms、查询 p50=1.8ms p95=2.6ms、
    并发 80 查询 27ms、堆增量 ~11MB。`npm run build` / `typecheck` 全绿；
    后端 1072 passed / 11 skipped（M6.3 基线 964/7，零回归）；前端 184 passed
    （本轮无前端改动）。真实启动冒烟（scripted backend + HTTP）：上传→检索
    （中/英）→打包标记→stats→rebuild→hybrid 422→evidence 空→删除无幽灵，
    全链路通过。
  - **M6 next step：M6.5 Evidence Pipeline & Agent Integration**
    （RetrievedChunk → EvidenceCandidate → quote 逐字校验 → EvidenceStore →
    Writer/Reviewer 接线；实施入口见 ADR §11）。

- **M6.3 Research Discovery & Academic/Web Search（✅ 2026-09-17）**：
  - **范围**：「PaperTeam 如何可靠地发现资料」——共享 Provider HTTP 基建、
    真发现型学术检索（非标题查证）、可选 Web 检索、多源聚合降级、Provider
    Health、Search Result → CandidateSource、Researcher 最小检索工具。**不含**
    Embedding / Vector DB / Lexical Index / RAG / Chunking / Reranker / Evidence
    自动验证（M6.4+）；FullTextResolver 按 ADR §11 实施顺序不属 M6.3，未实现。
  - **共享基建（`search/providerHttp.ts`）**：全部 provider 共用一个
    ProviderHttpClient——per-request timeout + AbortSignal 组合、类型化错误
    （7 kind）、重试集（429 / 500-599 / 网络 / 超时；4xx 与业务信封错误不重试）、
    指数退避 + 有界抖动（sleep 不持锁）、**Retry-After 双格式（delay-seconds /
    HTTP-date）+ 双硬帽**（请求内等待 ≤5s，超帽立即失败进冷却；provider 冷却
    封顶 60s）、**熔断按尝试计数**（连续 3 次临时失败尝试 → open 30s →
    half-open 探测 → close）、**限流≠宕机**（429/AMiner 40306 独立冷却自动恢复，
    不累计熔断失败）、HTTP-200 信封业务错误钩子穿透（AMiner 形态）。健康四态
    （healthy/degraded/rate_limited/unavailable）由真实请求结果统一维护。
  - **Academic Providers**：OpenAlex（primary；works search + 年份区间 / is_oa
    filter + mailto 礼貌池（PAPERTEAM_OPENALEX_MAILTO，回退 CITATION_CONTACT_EMAIL）
    + 倒排摘要重建复用 scholarly.ts）/ Semantic Scholar（enrichment+fallback；
    匿名可调，可选 x-api-key；429 经共享 client 冷却）/ arXiv（preprint；Atom
    XML 沿用既有轻量正则解析，无新 XML 依赖，年份客户端过滤）/ AMiner（China
    secondary；**仅免费端点** `/api/paper/search`（size≤20，Authorization 裸
    token），付费端点（pro/qa/relation/detail…）一律不接入且被测试钉死；信封
    code 40306→rate_limited / 其余→business_error，HTTP 200 绝不判 healthy；
    无 API Key 不注册，不影响其余源）。Crossref 不做 discovery（MetadataResolver
    职责不变，ScholarlyResolver 零改动语义）。
  - **融合与去重（`fusion.ts`）**：SourceIdentity 分层键去重（M6.2 identity.ts
    原样复用，无第二套 dedup）；带权重倒数排名 score=Σ weight/(60+rank)
    （openalex 1.0 / s2 0.9 / arxiv 0.8 / aminer 0.7；确定性排序无 ML reranker）；
    字段互补合并只填空缺（provider A 缺失不覆盖 provider B 有效）；**arXiv
    preprint 与 DOI 正式版键不同不 collapse**（M6.2 纪律延续）。
  - **Web Search（optional）**：SearXNGProvider（`GET /search?format=json`；
    URL 经 canonicalUrl 归一去重合并；unresponsive_engines 非空 → degraded）；
    未配置 PAPERTEAM_SEARXNG_URL / 服务离线 / JSON API 未启用（403→结构化
    misconfigured）均不阻塞启动与学术链路（503 SEARCH_PROVIDER_NOT_CONFIGURED /
    502 结构化错误）。compose 增 `--profile research` 可选 searxng 服务 +
    docker/searxng/settings.yml 模板（json format 开 / limiter 关 / cn.bing +
    baidu 大陆引擎白名单，engine 名与上游一致）。
  - **编排与降级**：AcademicSearchService 有界并发 fan-out（mapWithConcurrency，
    并发 4）+ timeout 隔离（单源超时/熔断/冷却只进 diagnostics）+ partial
    success（≥1 源成功即返回）+ 全源失败 502（**不伪造空结果**）；
    WebSearchService 单源直通 + degraded 如实上报。ResearchDiscoveryService
    唯一入口：**检索默认零持久化**，`saveAsCandidates: number[]` 显式写入
    CandidateStore（origin=academic_search/web_search、provider、`query`
    provenance——CandidateSource 最小新增字段）；promotion 复用 M6.2 幂等链路。
  - **HTTP API**：`POST /api/projects/:id/research/academic-search`（query/
    limit 1-50 默认 10/yearFrom·yearTo/openAccessOnly/saveAsCandidates）、
    `POST /api/projects/:id/research/web-search`、`GET /api/research/providers`
    （健康观测，无敏感信息）。错误码新增 SEARCH_ALL_PROVIDERS_FAILED(502) /
    SEARCH_PROVIDER_NOT_CONFIGURED(503)。
  - **Researcher 工具（scholarlyTools v2）**：search_papers 升级真发现检索
    （多源聚合 + 诊断；输出明确标注 candidate sources 非 verified evidence；
    未装配 discovery 的最小栈回退 resolver 查证形检索）；新增 search_web
    （SearXNG，未配置如实 not_configured 不抛错）；lookup_paper 语义不变。
    工具不写 EvidenceStore、不自动持久化候选。
  - **配置**：PAPERTEAM_SEARXNG_URL / PAPERTEAM_OPENALEX_MAILTO /
    PAPERTEAM_SEMANTIC_SCHOLAR_API_KEY / PAPERTEAM_AMINER_API_KEY /
    PAPERTEAM_SEARCH_DISABLED_PROVIDERS / PAPERTEAM_SEARCH_TIMEOUT_MS（全部可选，
    零配置时 OpenAlex+arXiv+匿名 S2 可用）。无 SearXNG 时 backend / Academic
    Search / Literature Library 全部正常（测试钉死）。
  - **验证**：新增后端测试 **72**（providerHttp 20 / academicProviders 17 /
    academicSearchService 13 / searxng 12 / researchDiscovery.http 9 / config 1；
    全部离线 mock HTTP；live smoke 4 个默认跳过，PAPERTEAM_LIVE_SMOKE=1 显式
    开启）。`npm run build` / `typecheck` 全绿；后端 964 passed / 11 skipped
    （M6.2 基线 892/7，零回归）；前端 184 passed 不变（本轮无前端改动——无
    Sources 页面，最小适配需求为零）。
  - **M6 next step：M6.4 Project RAG & Hybrid Retrieval**（sources chunk 管线 +
    RetrievalIndex 进程内 lexical + retrieve_library 工具 + Context Budget
    Packing；实施入口见 ADR §11）。

- **M6.2 Project Literature Library（✅ 2026-09-16）**：
  - **范围**：把「文献进入 PaperTeam 后怎么存在」做正确——Source Domain /
    Identity / Persistence / Import / Candidate lifecycle / Parse lifecycle /
    HTTP API。**不含任何检索**（Web / Academic Search / Embedding / RAG /
    Agent 自动检索均属 M6.3+，本轮零实现，符合 D-0033）。
  - **领域模型**：`SourceIdentity`（`sources/identity.ts`，D-0033 §12 草案落地）：
    分层确定性键 **DOI > arXiv ID > PMID > 归一标题指纹+年份+一作 family >
    canonical URL**；键是精确相等不是相似度（仅标题不构成身份）；DOI / arXiv /
    URL / PMID 各自归一化（`https://doi.org/…` / `doi:…` / 大小写 / 版本号 /
    utm 追踪参数 / 尾斜杠全部折叠）；**arXiv preprint 与 DOI 正式版是两个
    身份两条 Source，互不覆盖**——版本关系用轻量 `workKey` + `versionType`
    （preprint/conference/journal）+ `relatedSourceIds` 表达（`POST
    /sources/:sid/link` 显式建立；不做自动识别、不引入 Knowledge Graph）。
  - **CandidateSource ≠ SourceItem**：候选是 **Discovery State**（"发现到了
    一个可能有价值的资料"），持久化于独立文件 `sources/candidates.json`
    （pending_review → accepted/rejected；accepted 记 promotedSourceId）；
    正式文献仍在 authoritative 的 `sources/index.json` + `papers/` +
    `parsed/`。promotion 幂等（重入返回同一 Source；library 已有同身份 →
    merge 不复制；目标 Source 被删后可重新入库）。候选必须携带可判等键。
  - **入库路径（五种）**：PDF 上传（既有，+contentHash sha256 判重：同项目
    重复上传返回既有条目不新建）／DOI 导入（复用 ScholarlyResolver.lookup，
    resolved 级元数据；未命中如实记录、不伪造）／arXiv 导入（ID 归一 +
    resolver）／URL 导入（canonical URL + metadata placeholder，不抓正文
    ——ContentFetcher 属后续节点）／BibTeX 导入（自研最小 parser：花括号
    平衡值 / @string·@comment 跳过 / 损坏条目按行报错不中断；条目类型 →
    versionType 映射）。metadata-only 条目（fileName 为空、status=
    metadata_only）如实表达「有元数据无全文」。
  - **Metadata merge**（`sources/metadataMerge.ts`）：条目级可信水位线
    **user > resolved > inferred**——低可信只填空缺不覆盖（resolved 不覆盖
    用户改过的 title，但会纠正 PDF 抽取的错标题）；`POST /sources/:sid/enrich`
    对既有条目做 resolver 补全。
  - **Parse lifecycle**：沿用 pending → available/partial/failed（+ rejected /
    metadata_only）；解析产物 `parsed/<id>.json` 绑定 `analysisHash`——内容
    变化（contentHash 不一致）时拒绝写入旧产物（stale 防护）；老条目无 hash
    不校验（lazy 兼容）。Chunk 化属 M6.4。
  - **删除语义（D-0034）**：删候选 ≠ 删正式 Source（引用只有 candidate →
    source 单向）；删正式 Source 清理 papers 文件 + parsed 产物 + 索引条目，
    但**被 Evidence 引用时 409 SOURCE_IN_USE 阻止删除**（最小正确：不做
    cascade / tombstone）。
  - **HTTP API**：sources 子资源新增 `POST /sources/import/{doi|arxiv|url|
    bibtex}`、`GET/POST /sources/candidates`、`DELETE /sources/candidates/:cid`、
    `POST /sources/candidates/:cid/{promote|reject}`、`POST /sources/:sid/
    {enrich|link}`、PATCH 扩展 versionType；sources 路由补项目存在性校验
    （修复对不存在项目导入会创建孤儿目录的隐患）。重复上传返回 200+
    created=false（新建 201）。
  - **Backward Compatibility**：全部新字段 optional（identity / contentHash /
    sourceType / workKey / metadataProvenance / arxivId / abstract）；老项目
    index.json 原样可读，身份从 metadata **动态推导**（identityFromMetadata，
    不重写旧文件）；无 schema migration。测试覆盖 M5 形状老数据（无新字段
    条目 + 无 hash 条目）。
  - **代码组织**：`sources/` 域内新增 identity.ts / CandidateStore.ts /
    SourceImportService.ts / bibtex.ts / metadataMerge.ts，SourceStore.ts /
    PdfAnalyzer.ts / ScholarlyResolver.ts（未改）复用；ServiceStack 装配
    `candidates` + `sourceImport`（与 citationIntegrity **共享同一
    ScholarlyResolver 实例**，缓存 / 礼貌间隔 / telemetry 一体；离线部署
    providers=[] → 导入按 unresolved 如实记录不外呼）。未动 Workflow /
    Runtime / 前端（无 Sources 页面，无需适配）。
  - **验证**：新增后端测试 **74**（identity 19 / literatureLibrary 域 35 /
    literatureLibrary.http 13 / bibtex 7）；覆盖指令 20 项行为（项目隔离 /
    PDF 判重 / DOI·arXiv 归一 / 候选分离与幂等 promotion / merge 分层 /
    hash 失效 / restart 持久化 / 删除保护 / 老数据兼容 / 越权与非法输入 /
    BibTeX / URL 归一）。`npm run build` / `typecheck` / `test` 全绿
    （后端 892 passed / 7 skipped（既有 live smoke skip），前端 184 passed）。
  - **M6 next step：M6.3 Research Discovery & Academic/Web Search**
    （`search/` 域 + ProviderHttpClient + AcademicSearchService 真检索语义 +
    WebSearchService + SearXNG compose + 融合去重 → CandidateSource 产出；
    实施入口见 ADR §11）。

- **M6.1 Search/RAG Open-source Research & Architecture Freeze（✅ 2026-09-16）**：
  - **范围与纪律**：只读源码静态分析 + 架构冻结；**零业务代码实现、零第三方
    源码进入 PaperTeam**（6 个外部仓库浅克隆于仓库外
    `D:\Projects\PaperTeam-M6-Research`，非 submodule）；未动 Runtime / Workflow /
    Frontend；未新增任何依赖。
  - **分析对象（commit / license）**：searxng f725cc7（AGPL-3.0）、
    agent-search d97c735（MIT）、paper-search-mcp e3d7046（MIT，远端 main 唯一
    HEAD，单文件早期版）、aminer-open-skill 7ccfa90（MIT，AMiner 官方）、
    semantic-scholar-mcp 38b3aa8（MIT）、openalex-research-mcp 29294c3（MIT）；
    每项目均完成「架构 / 关键模块 / 请求路径 / 错误模型 / 数据模型 / 借鉴 /
    不借鉴」源码级分析（含 SearXNG 一次完整搜索请求的调用链追踪）。
  - **产出文档**：`docs/research/M6.1_SEARCH_RAG_OSS_ANALYSIS.md`（静态分析
    报告：PaperTeam 盘点 + 6 项目逐项 + 19 维对比矩阵 + 大陆可用性 + 15 个
    架构问题 + M6.4 RAG 初步架构 + Evidence 数据流）、
    `docs/research/M6.1_SEARCH_RAG_ADR.md`（ADR 正文 + TS 接口草案 + 拒绝
    方案 + 实施顺序）、DECISIONS.md **D-0033**（决策登记）。
  - **冻结结论（D-0033）**：六层最小接口（WebSearchProvider /
    AcademicSearchProvider / MetadataResolver / FullTextResolver /
    LiteratureLibrary / RetrievalService+RetrievalIndex）；Web Search =
    SearXNG 独立 HTTP 服务（optional，Docker + json format + limiter 关 +
    中国引擎白名单；不 bundling / 不复制源码——AGPL 进程边界隔离）；学术
    检索 = 扩展既有 ScholarlyResolver 生态（检索与核验两接口分开；OpenAlex
    primary / S2 enrichment / AMiner China-secondary+enrichment 免费层先行 /
    Crossref 只做 MetadataResolver / Unpaywall 属 FullTextResolver）；跨源
    同一性 = 分层确定性键产出 SourceIdentity；共享 ProviderHttpClient（超时/
    退避/Retry-After/类型化错误/熔断/限流≠宕机）；Index = Derived State
    （chunk 落盘 + 进程内 lexical + 可选 dense；**第一版零 Vector DB / 零外部
    数据库进程 / 无 reranker**）；Evidence 边界加严（snippet 最多 plausible，
    verified 只经 quote 逐字匹配 / 元数据核验 / 只见真实证据的 judge）；
    **内部零 MCP**（TS interface + Pi customTools）；Google 非依赖。
  - **关键源码发现（择要）**：SearXNG JSON API 默认关闭且 limiter 开启时 API
    限 4 次/小时/IP（必须自部署改配置）；打分 = 带引擎权重倒数排名融合（借
    用）；agent-search 的 "chunk-level citations" 宣称与代码不符（实为源级
    编号 + 代码拼参考文献），canonical_url 去重与 SSRF 逐跳校验值得 TS 移植；
    paper-search-mcp 无 provider 抽象（4 套字段并存，反面样本）；AMiner 无
    前向引用端点 / 搜索无精确引用数 / 免费层无完整摘要 / 按调用计费（不能
    Primary；HTTP-200 信封业务错误需穿透）；s2-mcp 的 Retry-After RFC 解析 +
    30s 硬帽教科书级、退避持锁 head-of-line 与无熔断是要超越处；openalex-mcp
    31 工具 = 3 个 HTTP 原语（薄原语 + 厚编排）。
  - **验证**：PaperTeam 仓库本轮仅文档变更（docs/research/ 新增 + DECISIONS /
    PROJECT_STATUS）；`git status` 干净提交，无第三方源码混入。
  - **M6 next step：M6.2 Project Literature Library**（候选文献清单 + DOI /
    arXiv / URL 导入路径 + AGENT_RETRIEVED 写入方 + SourceIdentity 落库；
    实施入口详见 ADR §11）。

- **M6.0 M5 Baseline Freeze & Documentation Closure（✅ 2026-09-16）**：
  - Freeze 日期 2026-09-16；**M5 冻结基线 commit `8e8c9bf`**（M5 最终状态）；
    M6.0 收口提交 = 紧随其后的 `docs(m6): freeze M5 baseline and open M6`
    （提交后 main HEAD 即 M6 起点）。
  - 冻结验证（本轮实际输出）：M5 = COMPLETE；`npm run build` PASS；
    `npm run typecheck` PASS；backend vitest **818 passed / 7 skipped / 0 failed**
    （75 个测试文件 = 74 passed + 1 skipped live smoke，共 825 例）；frontend vitest
    **184 passed / 0 failed**（24 个测试文件）。CI（ubuntu install / build /
    typecheck / test + docker build smoke）静态核验无变化；真实 Docker 验收以
    M5.5（2026-09-15）结果为准，本轮不重跑。
  - 唯一非文档修复：`backend/test/deploy/deployment.test.ts` 读取部署契约文件时
    归一化 CRLF 行尾——Windows checkout（core.autocrlf=true）把 compose.yml 转为
    CRLF 导致断言失败（环境行尾问题，非 M5 回归；与 ec13c97 / ac67230 同类的
    平台无关化修复，test-only，ubuntu 行为不变）。
  - 文档统一：CHANGELOG 移除残留的「M5（进行中）」旧段并按最终状态归并 M5.1–M5.7
    条目（M5.5 不再是 AWAITING、M5.6 不再是 PARTIAL）；README Known Limitations
    移除已完成的「Docker 部署未实现」；ARCHITECTURE §1 与 DECISIONS D-0032 的
    「真实 Docker 验收待执行 / AWAITING」更新为已通过（2026-09-15）。
  - **M6 next step：M6.1 Search/RAG Open-source Research & Architecture Freeze
    （✅ 同日完成，见上方 M6.1 条目）**。
- M6 计划方向（**截至 M6.1 未实现任何 Search / RAG 业务代码**；实施顺序已由
  D-0033 / ADR §11 冻结为 M6.2 Literature Library → M6.3 Search Service →
  M6.4 Retrieval/RAG → M6.5 Evidence Pipeline）：Research Discovery、
  Web / Academic Search、Project Literature Library、RAG / Retrieval、
  Evidence-grounded Retrieval、Reference Paper Intelligence、Multimodal Review
  （后两者为 M6+ backlog，不在 M6.2–M6.5 编号内）。

**M5.1 Runtime Lifecycle Reliability — 第一批（✅ 2026-09-11）**：
AgentRuntime 契约 v2 形状不变（唯一扩展：`AgentEvent.seq?` 可选字段 +
`event_gap` 合成事件类型），`PiRuntimeAdapter` 三项可靠性修复，全部先以
红测试证明缺陷再修复：

- **AbortSignal 语义统一（任务 B）**：`RunAgentInput.signal` 改由
  `startAgent()` 统一消费（新增唯一消费点 `attachAbortSignal`：pre-aborted
  立即进入取消语义 / 排队中短路 / 运行中 `session.abort()` 传导；监听器
  `{once}` + settle 后显式移除双保险，无 leak）。`runAgent()` 退化为
  `startAgent + await result` 的纯 convenience，删除了原先只在 wrapper 层
  监听 signal 的第二套实现（直接调用 startAgent 时 signal 被完全忽略的
  缺陷由此消除）。cancel 幂等增强：并发 cancel（signal + handle.cancel）
  经 `abortRequested` 防重复触发 `session.abort()`。
- **事件缓冲慢消费者修复（任务 C）**：修复前 events 数组「既做 replay
  buffer 又丢最旧」而消费者用数组下标当游标——前部裁剪后下标错位，
  慢消费者**静默漏事件**（红测试实证：读 10 条后缓冲裁剪，第 11 条交付
  直接跳到缓冲头，漏 ~700 条无任何提示）；另有迭代器「唤醒先于注册」
  竞态可致消费者永久悬挂（红测试超时实证）。修复：事件带任务内单调
  递增 `seq`，缓冲前部裁剪以 `bufferStartSeq` 记账，每订阅者独立逻辑
  游标；消费者落后于淘汰窗口（或订阅晚于截断）时先交付
  `type="event_gap"` 合成事件（data: missedFrom/missedTo/missedCount），
  再从缓冲头继续——缺口绝不静默。等待路径注册后复查，消除竞态悬挂。
  缓冲上限保持 500；settle 后 drain、多订阅独立、提前 break 清理全部
  保持（1203 事件快消费者零 gap 全量 / 慢消费者精确 gap 等场景覆盖）。
- **queued cancellation（任务 D）**：修复前排队的任务即使早已 cancel，
  也要等前序 run 完成获得 session 后才 settle（红测试实证：A 挂起 10
  分钟场景下 B 的 cancel 同样卡 10 分钟）。per-session 调度从
  `queueTail` promise 链改为**显式 FIFO 队列 + 泵**（`pumpSessionQueue`）：
  cancelRun 对 queued 任务直接从队列摘除并即时终态 cancelled（不等前序
  run，不 abort 正在运行的任务，不阻塞后续排队者）；「取消先于入队」
  与「派发交接窗口」两个竞态路径分别由 acquireSession 入队前检查与后台
  链取消检查兜底；close / releaseProjectSessions 同步即时收敛 queued
  任务，close 增加迟到会话清扫（close 窗口内并发创建的会话不再泄漏）。
- **测试**：PiRuntimeAdapter 专项 32 → 51 用例（新增 AbortSignal 8 /
  事件缓冲 7 / queued cancel 4，均含红→绿过程）；`npm run build` /
  `typecheck` / `npm test` 全绿（Backend 565 → 584 passed，Frontend 161
  不变）。业务层零改动（全部走 runAgent，signal 语义由 startAgent 内建
  自动生效）。

**M5.1 Runtime Lifecycle Reliability — 第二批（✅ 2026-09-11）**：
timeout 分层 + 统一结构化终态 + run 级 usage 基础采集（M5.2 第一步
提前落地）三项，51 → 73 专项用例：

- **Timeout 分层（任务 E）**：按真实生命周期阶段分层计时——
  `init`（懒初始化）→ `session`（会话获取/创建）→ `queue`（等待同会话
  独占权）→ `execution`（session.prompt 开始后）。配置兼容：
  `runTimeoutMs` 保留为 execution 阶段兼容默认值
  （`executionTimeoutMs ?? runTimeoutMs ?? 300000`），新增可选
  `PAPERTEAM_PI_{EXECUTION,QUEUE,SESSION,INIT}_TIMEOUT_MS`（queue /
  session / init 缺省不限，保持既有行为）。QUEUE_TIMEOUT 到点从队列
  即时摘除（不等前序 run、不误伤后续排队者）；EXECUTION_TIMEOUT 真实
  调用 `session.abort()`；SESSION_TIMEOUT 识别迟到成功的创建并销毁
  不入池（等待者计数，无幽灵会话）；INIT_TIMEOUT 超时后共享
  initPromise 继续后台收敛、惠及后续任务。timeout 与 manual cancel
  竞态以「首个 session.abort 发起者」唯一归因（`abortInitiator` 只记
  首个；cancel 先到 → cancelled，deadline 先到 → timed_out），close /
  releaseProjectSessions 并发时同样不双 abort、不覆盖归因。
- **统一结构化终态（任务 F）**：`AgentTaskStatus` 新增 `timed_out`；
  无论 result resolve 还是 reject，全部终态写入任务记录（**reject 不再
  丢状态**——修复前 timed_out 任务 getTask 报「不存在」）。终态携带
  `errorCode`（`*_TIMEOUT` / `RUN_FAILED` / `PROMPT_REJECTED` /
  `MODEL_NOT_CONFIGURED`）、`timeoutPhase`、`queuedAt` 与
  `queueDurationMs` / `executionDurationMs` / `totalDurationMs`（settle
  时统一注入，非负；未到达的阶段不携带字段）。settle first-wins 由
  既有 `settled` 守卫保证；reject 通道语义不变（AgentTimeoutError 携
  phase，HTTP 504 / Stage timeout 分类不受影响）。
- **Run 级 usage 基础采集（任务 G，M5.2 第一步）**：`message_end` 送达
  的 assistant 消息按 Pi 原生 usage（pi-ai 0.84.4 `Usage`）累计进
  `AgentTask.usage`（inputTokens / outputTokens / cacheReadTokens /
  cacheWriteTokens 增量求和；**totalTokens 是上下文规模快照 →
  contextTokens 取最后一个有效值，绝不跨 turn 累加**；estimatedCost
  为 provider list-price 估算求和，未返回则缺省不伪造）。forwarder 仅
  在本 run 独占会话期间挂载 + Pi subscribe 纯 live 无 replay → 会话
  复用不重复计算历史 turn。cancelled / timed_out / failed run 保留已
  产生的 usage；无 usage 的 run 整个字段缺省。不做 Dashboard /
  Pricing Service / Context Rotation（按 M5_PLAN 边界）。
- **测试**：PiRuntimeAdapter 专项 51 → 73（新增 timeout 分层 11 /
  结构化终态 2 / usage 9，其中 Level 2 真实 SDK 链路 2）；Backend
  584 → 606 passed，Frontend 161 不变；build / typecheck / test 全绿。
  兼容性：`runAgent(input.timeoutMs)` 语义不变（execution 阶段），
  业务层（Writer/Reviewer/Researcher 等 runAgent 调用方）零改动。
- **M5.1/M5.2 剩余**：context budget、session rotation / TTL / GC 已随
  M5.2 收口完成（见下节与 2026-09-12 记录）；global concurrency 与
  背压已于 09-11 完成；usage 的 Dashboard / Pricing 展示层仍属后续。

**M5.2 Long-Running Governance — 全局并发与有界受理（✅ 2026-09-11）**：
Runtime 层最后一道全局 admission / execution guard 进驻
`PiRuntimeAdapter`（进程内实现，无 Redis / BullMQ / 外部 scheduler），
跨 project / agentId / contextScope / Reviewer 类型 / Workflow 统一生效，
73 → 83 专项用例：

- **两层语义**：既有 per-session FIFO（同 sessionKey 串行）不变，新增
  全局 execution permit——整个进程同时真实进入 `session.prompt` 的 run
  数 ≤ `maxConcurrentRuns`（FIFO 派发）。关键不变量：permit 只在任务
  **到达 session 队头后**申请，同 session 的排队任务不提前占用全局
  permit（A1 运行 / A2 同会话排队 / B1 异会话 → A1+B1 并行，A2 不挡路）。
- **有界受理（bounded admission）**：已受理未执行任务（等待会话创建 /
  per-session FIFO / 全局 permit 三种执行前等待合计）≤ `maxQueuedRuns`；
  占满后 startAgent 立即结构化失败 `failed(RUNTIME_QUEUE_FULL)`（句柄
  返回 + getTask 可回溯，错误含 queued/active/maxQueued/maxConcurrent
  四个数字；不建会话、不进队列、不伪装成 QUEUE_TIMEOUT）。
- **QUEUE_TIMEOUT 协作**：全局 permit 等待属于 queue 阶段，由既有的
  `queueTimeoutMs` 统一覆盖；deadline 自进入 session 队列起算，**跨
  FIFO → permit 阶段切换不重置**（排队时长是原始 deadline 的证据，
  测试以 queueDurationMs ≈ timeout 而非 timeout+前段等待 断言）。
- **记账收口在 settle（first-wins）**：completed / failed（含
  PROMPT_REJECTED / RUN_FAILED）/ cancelled（排队取消、AbortSignal、
  close）/ timed_out（queue / execution）全路径经
  `releaseAdmission` 释放 permit 或等待容量并 FIFO 唤醒后继，无槽位
  泄漏；取消 permit 等待者立即从等待队列摘除、永不「复活」。
- **配置与诊断**：`PAPERTEAM_PI_MAX_CONCURRENT_RUNS`（默认 4，1-64；
  ≥ Reviewer 三路 fan-out + 一路余量）/ `PAPERTEAM_PI_MAX_QUEUED_RUNS`
  （默认 32，0-1024，0=不允许等待）；非法值 ConfigError 拒绝启动
  （容量契约是正确性约束，不同于可静默回退的并发调优项）。
  `runtimeStats()` / `GET /api/runtime/status` 新增 maxConcurrentRuns /
  maxQueuedRuns / activeExecutions / queuedRuns（可选字段，实现未暴露
  时缺省）；不做前端设置 UI。
- **测试**：PiRuntimeAdapter 专项 73 → 83（新增 10：全局并发上限采样
  断言、同会话不占 permit、有界受理、AbortSignal 取消等待者、
  QUEUE_TIMEOUT 沿用原 deadline、execution timeout / 两种 failure 路径
  释放 permit、close 收敛记账归零、非法构造拒绝）；config 新增 1、
  runtimeStatus 透传 1。Backend 606 → 618 passed，Frontend 161 不变；
  build / typecheck / test 全绿（M5.1 cancel / timeout / usage 与
  Workflow reviewer concurrency 全部保持通过）。

**M5.2 Long-Running Governance — Context Budget / Rotation / TTL·GC·容量 /
观测面与自愈（✅ 2026-09-12，M5.2 收口）**：

- **Context Budget（任务 H；`runtime/pi/contextBudget.ts` + Adapter
  preflight）**：事实源唯一——`contextWindow` / `maxTokens` 直接取
  resolved Pi Model（pi-ai `Model` 必填字段），PaperTeam 不维护模型
  上下文表。**当前占用三态**：measured（上一 run provider 实测
  `usage.totalTokens` 回写，最可靠）> estimated（CJK 感知会话消息估算，
  1.5 token/CJK 字符 vs Pi chars/4 对中文低估 3-6 倍的修正）> unknown
  （消息面不可读；绝不伪装成 0，诊断面如实 `contextTokens: null`）。
  **输出预留公式** `reserve = min(maxTokens, ⌈contextWindow×25%⌉, 32768)`
  （可配 `PAPERTEAM_PI_OUTPUT_RESERVE_TOKENS`，1024-262144，恒被夹紧到
  模型真实能力内；参照 Pi 自身 compaction 默认 reserve 16384 与长论文
  单轮输出形态，200k 窗口 + 128k maxTokens 模型只预留 32k，不机械
  预留完整 maxTokens）。**preflight**（任务成为会话队头、prompt 之前）：
  `当前占用 + 下次输入估算 + 输出预留 > contextWindow` → rotation；
  **oversized 单输入**（`估算输入 + 预留 > 窗口`，即使全新会话也装不下）
  在 startAgent 受理前即 `failed(CONTEXT_BUDGET_EXCEEDED)`（不建会话、
  不排队、不调用 provider、不静默截断 Evidence / 稿件 / Review；错误
  含 contextWindow / estimatedInputTokens / reservedOutputTokens /
  availableTokens 四个数字，不落 prompt 内容）。
- **Session Rotation（任务 I）**：`ManagedSession` 是稳定调度容器
  （sessionKey / FIFO 队列 / activeTaskId 不变），内部 Pi AgentSession
  按 `generation`（1 起，rotation +1）替换——rotation 只发生在安全边界
  （本任务已独占会话队头 + 持有全局 permit + 尚未 prompt），绝不 dispose
  正被他人使用的会话。触发条件：(1) context budget 压力（measured /
  estimated 基准）；(2) **runCount ≥ maxRunsPerSession 兜底**——仅当
  context 占用不可得（模型无窗口元数据 / unknown 基准；contextWindow
  可靠时 context budget 优先）；(3) `needsRotation` 自愈标记。不做摘要
  迁移（old conversation → LLM summary → new conversation）：Workspace /
  checkpoint + 本轮业务 prompt 是新会话的完整事实源。rotation 重建失败
  → 当前任务结构化失败，容器标记待重建，下一安全边界重试（绝不复用
  已 dispose 的旧会话）；重建与 `sessionTimeoutMs` 竞速。
- **TTL / GC / 容量（任务 J）**：会话 idle 判定 = 无 activeTaskId + 无
  排队 + 无「已命中会话尚未入队」的在途任务（`pendingArrivals` 计数
  覆盖 obtainSession → 入队 的 microtask 窗口）——active / queued / 到达
  中的会话绝不被回收。TTL 过期（默认 30 分钟，`PAPERTEAM_PI_SESSION_
  IDLE_TTL_MS` 60s-24h）→ unsubscribe + dispose + 出池（GC 计数
  reason=idle_ttl）；GC 由周期定时器（unref，不阻止退出；间隔
  clamp(TTL/4, 1s, 60s)）+ 任务 settle 机会式 + 容量闸门三路触发，
  测试经注入时钟 / 显式 `sweepIdleSessions()` 驱动。**容量硬上限**
  （默认 16，`PAPERTEAM_PI_MAX_SESSIONS` 1-256）：新建会话时池内 + 在建
  达上限 → 先收 TTL 过期、再 LRU 淘汰 idle；全部忙 →
  `failed(RUNTIME_SESSION_CAPACITY)`（结构化拒绝，绝不取消 active run /
  删除有排队的会话）。`reconfigure` / `releaseProjectSessions` / `close`
  与 GC / rotation 的竞态由容器级幂等 `disposeManaged`（disposed 标记）
  保证不双重释放、无幽灵会话。
- **观测面（任务 K1/K2）**：`runtimeStats()` 新增 busySessions /
  idleSessions / maxSessions / sessionRotations / sessionGcEvictions /
  contextBudgetRejects / contextPressureSessions（占用 ≥75% 的会话数；
  全部可选字段向后兼容）；`sessionDiagnostics()` 逐会话暴露 sessionKey /
  role / generation / runCount / 创建与最近使用时间 / idleMs / busy /
  queueDepth / contextTokens·Window·Basis·Percent / needsRotation /
  lastRotationReason——不含 prompt 内容 / 工具输出 / 密钥 / 工作区路径；
  `GET /api/runtime/status` 经 `sessions.details` 透传（有界 ≤ maxSessions）。
- **安全自愈（任务 K3）与真实边界（K4）**：仅确定性低风险自愈——
  execution timeout 或 prompt 异常后底层会话状态不确定 → 标记
  `needsRotation`，下一安全边界重建（manual cancel 不触发：M3.8 已验证
  abort 后会话可继续使用）。**绝不自动重试业务任务**（Writer 修订 /
  Reviewer 调用失败不复活、failed 不改 success）——自愈只恢复 Runtime
  后续可用性。进程 crash 边界如实：内存中 AgentSession / 在-flight 模型
  调用无法迁移，不伪造恢复；已完成 stage 由 Workspace/checkpoint 保留，
  未完成调用由 Workflow 层按既有语义处理；Runtime 重启后从空会话池
  开始，无脏恢复。
- **Soak 回归（任务 L；`test/runtime/LongRunningGovernance.test.ts`）**：
  planner 驱动 fake provider 模拟 160 runs（4 project × 2 scope ×
  2 agent，completed / cancelled / failed / timed_out / RUNTIME_QUEUE_FULL
  混合），全程采样断言：activeExecutions ≤ maxConcurrentRuns、
  queuedRuns ≤ maxQueuedRuns、managedSessions ≤ maxSessions、单会话
  maxConcurrent ≤ 1、dispose-后-prompt 与 pending-中-dispose 两哨兵
  全程零违规、同 sessionKey 的实际执行顺序是提交顺序的严格子序列
  （rotation 不破坏 FIFO）、160 runs 后 activeExecutions / queuedRuns /
  activeRuns 全部归零、事件迭代器自然排空、GC 周期回收 idle 会话至零、
  close 后每会话 disposeCount 恰为 1、无 unhandled rejection。
- **测试与配置**：新增 34 个后端用例（Level 1：context budget 6 +
  rotation 3 + TTL/GC/容量 6 + 观测面 1；Level 2 真实 SDK：getContextUsage
  measured 链路 / 小窗 rotation 保 sessionKey / oversized provider 零调用
  3；纯函数 contextBudget 12；soak 1；config 1；runtimeStatus 1）。
  配置新增（全部严格校验，非法 ConfigError）：
  `PAPERTEAM_PI_MAX_RUNS_PER_SESSION`（默认 32）/ `PAPERTEAM_PI_SESSION_
  IDLE_TTL_MS`（默认 1800000）/ `PAPERTEAM_PI_MAX_SESSIONS`（默认 16）/
  `PAPERTEAM_PI_OUTPUT_RESERVE_TOKENS`（可选）。Backend 618 → 652
  passed，Frontend 161 不变；build / typecheck / test 全绿。真实 Pi SDK
  Level 2 用 faux provider（原生 usage 语义）验证 context usage 读取 /
  rotation / dispose-重建，无需真实模型烧 token。auto-compaction 全程
  保持关闭（`SettingsManager.inMemory({compaction:{enabled:false}})`）。

**M5.3 Controlled Academic Skill Integration（✅ 2026-09-14）**：范围先在
M5_PLAN 重定义（从「install / update / diff / 绑定 UI」产品化表面收敛为「三个
审计、固定版本、学术适配的 Skill 真正进入正确的 Writer / Reviewer 工作流」），
然后落地：

- **三个 Academic Skill 审计入库**（`backend/skills/seed/`）：
  `academic-writing-zh`（← K-Dense-AI/scientific-agent-skills
  `skills/scientific-writing` @ `0b2afe68a5f9379097ad815e028af664f1e222b7`，
  MIT © K-Dense Inc.）、`academic-review`（← 同仓库 `skills/peer-review`，
  同 SHA）、`academic-style-zh`（← op7418/Humanizer-zh @
  `91f3d394db8419c20d67ebe22a96cf8fee0a404b`，MIT © 歸藏）。每个 seed：
  PaperTeam 适配 SKILL.md（中文工科写作 / 可执行审稿 finding / 中文学术
  表达；不是 AI detector；不建立第二套事实系统；不使用上游 Python 脚本；
  不放宽 Reviewer 只读）+ skill.json（`upstreamPath` / `upstreamContentHash`
  / `purpose`）+ LICENSE 原件 + PROVENANCE.md（commit / 日期 / 源路径 /
  修改内容 / 上游署名建议如实记录但不自动写进用户论文 bibliography）+
  UPSTREAM_SKILL.md verbatim 快照。三个 seed 的 SKILL.md 均显式声明不向用户
  论文参考文献插入上游引用（测试断言）。
- **SkillRegistry → 受控 Skill Store**：`installed/<id>/`（skill.json + 当前
  副本）+ `versions/<id>/<contentHash>/`（不可变快照 = 注入路径）。seed 校验
  拒绝：非 40 位 SHA revision（main / latest / v2）、缺 LICENSE、缺
  PROVENANCE.md、UPSTREAM_SKILL.md 与记录 hash 不符；hash 行尾归一化
  （Windows autocrlf 与 Linux 一致）；`bundleHash` 覆盖整目录。篡改
  （installed 或快照与记录不符）→ `integrity=tampered`、不注入、
  `ensureInstalled` 从完整一方自愈。已安装 skill 的 seed 变化**不自动
  应用**（`update.available`），`previewUpdate`（current / candidate hash +
  revision + 文件级 diff + SKILL.md 行 diff，有界）→ `applyUpdate`（新快照 +
  切指针 + 安装后重校验）。`catalog()` = approved seed 列表；`install(id)`
  只接受 seed id。`PAPERTEAM_DISABLED_SKILLS` 配置禁用（可见不注入）。
- **role + contextScope 路由**（`skills/routing.ts`，最长前缀优先，role-only
  回退默认绑定）：researcher→paper-search；citation→paper-search +
  verify-citations；reviewer 默认 / `review/fact`→verify-citations、
  `review/academic` / `review/section`→academic-review、`review/style`→
  academic-style-zh；writer 默认 / outline / sections / revision /
  improvement-plan→academic-writing-zh、`writing/style-polish`→
  academic-writing-zh + academic-style-zh、`writing/repair`→无。三个
  Reviewer lens 不拿相同 Skill 集；旧 `skillDirsForAgent(role)` 继续有效。
- **会话级版本固定 + assigned ≠ accessed**（PiRuntimeAdapter）：新增
  `roleSkills(role, scope)` 选项；`createPiSession` 在会话创建 / rotation
  边界解析一次并存入 `ManagedSession.assignedSkills`（generation 内不变，
  快照目录不可变，运行中任务不会读到新版）；任务终态新增可选
  `AgentTask.skills = { assigned[{id, sourceRevision, contentHash}],
  accessed, accessBasis }`——accessed 只在 `tool_execution_start(read)` 的
  path 落在快照目录内时记录，grep / find 不算；本 run 未收到任何 Pi 事件
  → `accessBasis=unknown`、`accessed=null`（绝不伪造）。
  `sessionDiagnostics` 暴露 `contextScope` / `assignedSkills`。契约 v2 只加
  可选字段。
- **HTTP**：`GET /api/skills` → `{skills, catalog, bindings(role+scope),
  allowedContextScopes}`；`GET /api/skills/:id/provenance`；
  `GET /api/skills/:id/update-preview`；`POST /api/skills/:id/install`
  （非 approved id 404；带 url / path / repo 400）；`POST /api/skills/:id/
  update`（body.candidateHash 与当前 seed 不符 400）；`POST /api/skills`
  405（无任意 URL 安装面）。
- **Skills 页（最小 Skill Settings UI）**：用途 / 来源 / 固定 revision /
  content hash 摘要 / 许可证 / 绑定 chips（role · contextScope）/ 状态 chips
  （有可用更新 / 配置禁用 / 内容被改写）；「预览更新」→ hash / revision /
  文件表 / 行 diff →「应用更新」（必须先预览，携带预览候选 hash）；
  approved catalog 未安装项「安装」；「查看来源与许可」拉取 PROVENANCE /
  LICENSE / 上游快照校验；绑定表新增 contextScope 列。没有 URL 输入框、
  没有 marketplace。
- **测试**：backend 新增 `test/skills/academicSkills.test.ts`（18：路由 5、
  seed 校验 4、install / update / 禁用 / diff 4、adapter 版本固定 +
  三 lens 不同 Skill + accessed 观测 3、HTTP 2）+ 更新
  `skillRegistry.test.ts`（9）；frontend 新增 `SkillsPageM53.test.tsx`（3）。
  Backend 652 → 670 passed（7 skipped 不变），Frontend 161 → 164 passed；
  build / typecheck / test 全绿。
- **如实边界**：绑定编辑 UI 未做（路由为代码内控常量，只读展示；如放开只能
  在 approved catalog + `ALLOWED_CONTEXT_SCOPES` 内选）；旧版本快照保留不
  GC（纯文本、可审计）；accessed 观测依赖 Pi `read` 工具事件，Agent 若用
  其他方式读取不会计入（宁缺勿假）；Skill 是否改善产出质量留 M5.6 A/B。

**M5.4 Chinese Academic Style Revision Loop（✅ 2026-09-14）**：在不破坏
D-0026「critical / major → planned、minor → skipped」的前提下，增加用户显式
选择的语言润色目标（D-0031）：

- **stylePolicy**（`review/stylePolicy.ts`；POST /api/projects/:id/workflows 的
  `stylePolicy` 字段，随 run.request 持久化）：`suggest_only`（默认）只展示
  建议；`apply_once` 在 Quality Gate 通过后进入 HITL `hitl.style_polish`
  （payload：style minor finding 列表 location / issue / reason /
  proposedAction / severity + defaultSelectedIds），用户 apply（可携带
  `selectedFindingIds`）→ `revision.style_polish` stage：
  `buildStylePolishPlan`（只含选中的 style minor，`revisionReason=style_polish`、
  priority low、status planned；`buildRevisionPlan` 默认规则不动）→
  `WriterService.polishSectionStyle`（contextScope `writing/style-polish` →
  academic-writing-zh + academic-style-zh；prompt 携带受保护内容清单：citation
  key / 数字单位 / 数学片段数 / LaTeX 结构 / glossary 术语）→
  `checkStyleInvariants` 逐章节校验 → **all-or-nothing**：全部通过才写回 +
  `revisions.commit("revision.style_polish")`；任一失败 → 不覆盖当前修订、
  结果 `failed` + 具体 invariant 落盘（`reviews/style-polish-r{n}.json`）、
  不自动重试（maxAttempts 1）。planner：只有 `changed=true` 的润色才算改稿
  → 尾部 citation.verify / review.run / quality.gate / build 整段重走；skip /
  failed / noop 直接进入构建；最多一轮（countCompletions）。
- **Style Invariant Checker**（`review/styleInvariants.ts`）：A citation key
  多重集；B 数字 literal + 单位（`\%` 归一化）；C 数学片段（$…$ / \[…\] /
  equation·align 等）；D \ref / \label / \eqref / \begin / \end 多重集；E 受保护
  术语不减少（`manuscript/glossary.json` 可选）；F 哨兵词（未 / 无法 / 并非 /
  不能 / 不显著 / 低于 / 高于 / 优于 / 差于 / 增加 / 降低 / 显著 / 导致 / 因此 /
  证明 / 表明 / 可能 …）计数变化即阻断。如实边界：F 是保守哨兵，不是语义等价
  证明；文档不夸大为「形式化证明语义相同」。
- **Style Reviewer 输出**：ReviewIssue 新增可选 `reason`（`proposedAction` 作
  suggestedAction 别名）；style prompt 要求 location / issue / reason /
  proposedAction / severity、连接词防误报、禁止 AI 概率类字段；解析只挑已知
  字段，`FORBIDDEN_DETECTOR_FIELDS` 永不进入结果 / 落盘。
- **Quick Review 红线**：`createExistingPaperReviewDefinition` 的 stage 集合不含
  任何 revision.* / writing.* / hitl.style_polish；POST workflows（kind=
  existing_paper_review）携带 stylePolicy（任何值）→ 400；前端
  `createWorkflowRun` 对 review kind 不发送该字段。
- **HTTP / UI**：`GET /api/projects/:id/style-polish` → `{plan, result,
  reviewedRevision, reReviewed}`；Domain Event `style_polish.applied /
  style_polish.skipped`；ReviewPanel 高级选项「语言风格建议（仅系统性改进）」
  select；HitlPanel `hitl.style_polish` 可勾选 finding → 「应用语言润色（N 条）」
  / 「仅保留建议」；PaperPanel「语言润色」卡（状态 / 选中条数 / rev a → b /
  invariant 结果 / 复审状态 / 违规明细）；stage 标签与时间线补齐。
- **M5 eval corpus**（补齐 M5.0 延后项）：`backend/test/fixtures/eval/style-corpus/`
  五段自建可公开中文工科段落（A 事实完整 / B 材料不足 / C 机械空泛 / D 正常 /
  E 敏感不变量）+ `review/styleSignals.ts`（确定性表面模式扫描：模板开场 /
  模糊归因 / 宣传式评价词 / 空泛总结 / 机械排比 / 机械过渡 / 夸大；eval 工具，
  不进 gate、不是 AI detector；单个「此外 / 然而 / 因此」不计信号）+
  `docs/eval/M5_STYLE_EVAL_TEMPLATE.md` 人工评价模板（事实保持 / 术语一致 /
  清晰 / 建议可执行性 / false positive / 过度润色 / 耗时 / token / cost）。
- **scripted runtime**：`[style:findings]` / `[style:violate]` 项目标记驱动
  style finding 与 invariant 违反路径（`writing/style-polish` 输出只改表达）。
- **测试**（`test/review/stylePolish.test.ts` 17）：invariants（纯表达改写通过；
  citation 删 / 换、数字 / 单位、公式 / label / 环境、术语减少、否定 / 比较 /
  强度哨兵各阻断）；readStylePolicy；默认 plan minor 仍 skipped；style plan
  只含选中 minor 且不抬 severity；Reviewer 输出丢弃 AI 概率字段；corpus C 命中
  / A·B·D 零信号 / 连接词不误报；e2e：suggest_only 不改稿、apply_once 全链路
  （HITL → 计划 → 润色 → 新修订 → review/gate/citation 各 2 次 → Final，
  非法 payload 409）、violate 失败保留原稿且不重试仍可 Final、skip、无 finding
  不询问、Quick Review 400 + 定义无修订 stage。frontend `StylePolish.test.tsx`
  6（HITL 勾选 / apply payload / skip / 禁用；状态卡 applied / failed / 空；
  createWorkflowRun 发送规则）。Backend 670 → 687 passed（7 skipped 不变），
  Frontend 164 → 170 passed；build / typecheck / test 全绿。
- **如实边界**：idea_to_paper 的启动目前无前端入口（run 由 API 创建），
  stylePolicy 对其经 API 生效；润色只在 gate PASS 后提供一次（gate 反复
  失败 → 走既有 HITL / Draft 路径，不叠加润色）；语义等价只能靠 invariant +
  复审 + 人审，A/B 质量证据留 M5.6。

**M5.5 Linux / Docker Deployment（✅ COMPLETE，2026-09-15 真实 Docker 验收通过）**：
单机单用户 Linux / Docker 部署的代码、配置、CI 与自动化测试于 09-14 完成；09-15 在
WSL2 + Docker Engine 主机上对同一 git checkout 完成全部真实验收（见末尾验收记录）。

- **依赖审计**（以源码 / doctor 为准，见 docs/DEPLOYMENT.md §2）：Node 22
  （root engines）、Pi SDK 0.84.4、Python3 + pymupdf（`pdfToolchain` 候选 +
  `backend/tools/parse_paper_pdf.py`）、latexmk / xelatex（`LatexCompiler`）、TeX 包
  ctexart / amsmath / amssymb / natbib（模板）+ 导入论文常用 xcolor / graphicx /
  hyperref / pgf / biblatex、中文字体（Fandol + Noto CJK）、git（Backend 运行时不
  调用，可选）、Skill seed 与 tools 目录（相对 dist 解析，必须随镜像）。
- **Dockerfile**（多阶段）：frontend-build → backend-build（tsc + `npm prune
  --omit=dev`）→ `backend`（`node:22-bookworm-slim` + apt：python3/venv、git、
  texlive-xetex / latex-base / latex-recommended / lang-chinese / pictures /
  bibtex-extra、biber、latexmk、fonts-noto-cjk；**不装 texlive-full**；venv 安装
  pymupdf；`PAPERTEAM_PDF_PYTHON` 指向 venv；`PROJECTS_ROOT=/data/projects`、
  `PAPERTEAM_RUNTIME_ROOT=/data/runtime`；TEXMFVAR 可写目录；HEALTHCHECK /health；
  exec 形式 ENTRYPOINT）→ `web`（nginx:1.27-alpine + Frontend dist +
  `docker/nginx.conf`）。镜像不含 .env / auth.json / 任何 Key（`.dockerignore` +
  测试断言）。
- **compose.yml**：`backend`（`expose: 3000`，不 publish；`env_file: .env
  required:false`；双 named volume `paperteam-projects` / `paperteam-runtime`；
  `PAPERTEAM_SHUTDOWN_TIMEOUT_MS=40000`；`stop_grace_period: 45s`；healthcheck）+
  `web`（`${PAPERTEAM_WEB_PORT:-8080}:80`，`depends_on: service_healthy`）。用户
  只访问一个地址，`/api` 同源；nginx 对 `/api|/health|/ready` 反代、SSE
  `proxy_buffering off` + 3600s 读超时。
- **entrypoint**：root 启动只为修正首挂载空 volume 的属主（属主不对才 chown），
  随后 `setpriv` 降权到 `paperteam` 再 `exec node`（PID 1 = node，SIGTERM 直达）。
- **Readiness**（`runtime/readiness.ts` + `GET /ready`）：Runtime healthCheck +
  两个数据根可创建可写（写入并删除探针文件）+ latexmk / xelatex 探测（60s 缓存）
  + Python / pymupdf；`ready = runtime && filesystem`，TeX / Python 缺失记入
  `degraded`（能力降级但可服务）；200 / 503；不调用模型。`/health` 保持 liveness。
- **优雅停机专项审计**（`registerShutdown`）：旧实现固定 5s 硬退出对长任务过短
  → 改为 ① `server.close()` 停止受理 → ② `orchestrator.close()`（queued 即时
  终态、running 协作式 abort、checkpoint 随 stage 落盘）→ ③ `runtime.close()`
  （会话释放、定时器清理）→ ④ `closeAllConnections` + exit 0；兜底
  `PAPERTEAM_SHUTDOWN_TIMEOUT_MS`（默认 30s，1s-10min）超时 exit 1 并记日志。
- **Linux 跨平台**：源码审计（测试）——无 cmd.exe / PowerShell 调用；`shell:true`
  仅 `LatexCompiler` 且由 `IS_WINDOWS` 门控；无硬编码盘符路径；python 候选含
  `python3`；数据根默认 `~/.paperteam` 在容器由环境变量覆盖。Windows 开发体验不变。
- **CI**：`.github/workflows/ci.yml`——ubuntu-latest + Node 22：install / build /
  typecheck / test；`docker-build` job：buildx 构建 backend + web 两目标（不 push）
  + toolchain smoke（pymupdf / latexmk / xelatex 版本）+ 容器内 `/ready` 探测 +
  `docker stop -t 45`。
- **测试**（`test/deploy/deployment.test.ts` 9）：ReadinessProbe（ready / degraded /
  不可写 / 缓存 / 探针清理）、HTTP /ready 200 / 503 / 未配置 503、停机预算配置
  默认与范围、Dockerfile / compose / nginx / .dockerignore / .gitignore / CI 契约
  （无 COPY .env、无 Key、多阶段、非 texlive-full、backend 不 publish、双 volume、
  grace > 预算、SSE 不缓冲、Linux 路径纯净）、backend 源码跨平台审计。Backend 687
  → 696 passed，Frontend 170 不变；build / typecheck / test 全绿。
- **真实 Docker 验收（2026-09-15，✅）**：开发机原本无 Docker / WSL；按「不擅自安装
  Docker Desktop（公司环境无法确认商业授权）」的纪律，安装 WSL 2.7.14（官方 MSI，
  Microsoft 签名验证）+ Ubuntu 24.04（官方 rootfs，SHA256 + GPG 验签）+ Docker Engine
  29.8.0 / Compose v5.5.1 / buildx（官方 apt 包，GPG 指纹验证），对 `/mnt/d/Projects/
  PaperTeam`（与 Windows 同一 checkout、同一 HEAD）执行 docs/DEPLOYMENT.md §7 全部清单：
  build 573 s（backend 1.99 GB / web 83.5 MB；deb.debian.org / pypi.org 从该网络几乎不可达
  → Dockerfile 新增构建期 `APT_MIRROR` / `PIP_INDEX_URL` build-arg，缺省官方源）；
  up 8 s 健康、`/ready` degraded 空、Windows 主机访问 Web UI 与同源 API；project +
  marker + 5 个已安装 Skill 经 `restart` 与 `down && up`（不带 -v）持久化；容器内
  XeLaTeX + ctex + bibtex 产出含中文的 PDF（Fandol 字体）；容器内 Python + PyMuPDF 解析
  fixture PDF（15 页 / 23 节）；`docker compose stop` → `shutting down (SIGTERM)` →
  `stopped cleanly`、exit 0、无 zombie / unhandled；日志无 Windows 路径。明细见
  docs/M5_ACCEPTANCE.md §4.7。

**M5.6 Real Paper Acceptance & Release（✅ COMPLETE 2026-09-16 — engineering goals
achieved, Skill quality gain not consistently demonstrated）**：完整记录见
[M5_ACCEPTANCE.md](M5_ACCEPTANCE.md)，Release Notes 见 [RELEASE_NOTES_M5.md](RELEASE_NOTES_M5.md)。

- **材料与方法**：本机已有的 26 页中文工科论文 PDF（本地输入，不入库）；
  `scripts/m5-acceptance.mjs` 启动独立 backend（arm A：`PAPERTEAM_DISABLED_SKILLS`
  关闭三个学术 Skill + suggest_only；arm B：Skill 开 + apply_once）、导入 PDF、驱动
  Improvement run、自动回答 HITL、采集 stage 时间线 / 审稿计数 / gate / 修订 /
  硬指标（citation key / 数字 / 公式 多重集对比、styleSignals）/ usage（新增
  `runtimeStats.usageTotals` + per-task usage 日志含 assigned / accessed）。
- **结果**：第一轮两臂都在默认 300s 执行超时失败（B：带 Skill 的 Reviewer 6–14 轮
  工具调用；A：Writer 单节修订）→ 改 900s 重跑；第二轮两臂均完成为 **Draft
  （Build PASS，Quality Gate 如实 FAIL：unsupported claims / blocking / critical+major /
  academic 56–72 < 80；阈值未动）**；B 末轮 academic 72 vs A 56、styleRisk 30 vs 40，
  B 成本 +18%、Reviewer 时长 +56%；Skill accessed 观测在生产日志中成立
  （academic-review / academic-style-zh 被真实读取，verify-citations / paper-search 未读）。
  Quick Review 34.8 min、177 findings、**revision 0→0、mutatedFiles 0**。材料不足提案：
  feasibility MEDIUM + 5 项明确缺失，不编造。长程：4 backend 并发 ~1.5h、≥150 run，
  无 budget / capacity 拒绝。
- **验收驱动修复**：① Writer 引用回归——Existing-Paper 无 research bibliography 时
  修订 prompt 写「不要使用 \cite」导致重建稿全部 `\cite` 被删且 Gate 未察觉；改为
  research artifact ∪ references.bib（`manuscriptBibliography`）+ prompt 保留引用；
  ② Style Polish 在 Draft 路径（Gate 失败、accept_draft 后）也提供一次（否则真实论文
  几乎没有润色机会），新增 e2e 测试；③ compose 默认 `PAPERTEAM_PI_RUN_TIMEOUT_MS=900000`；
  ④ usage 观测面；⑤ CI 装 pymupdf。Backend 696 → 698 passed，Frontend 170。
- **09-15 收口**（详见 M5_ACCEPTANCE §4.3 / §4.7 / §4.8 / §6.6–6.8）：
  ① **Citation Preservation Gate**（`quality/citationPreservation.ts`）——以修订快照为事实源，比较
  被审阅修订与前一修订实际被引用的 key；无计划依据的丢失 → `citation_keys_preserved` FAIL，
  全部删光 hard fail，历史回归 FAIL；有依据的删除只认结构化计划（citation_missing / 显式点名 /
  证据不足条目命中章节）；`revision.plan` 派发 `citation_removed` 恢复条目；Draft 路径明确暴露；
  Quick Review 不受影响；10 类测试 + scripted 回归 + 前端标签。② **长论文执行超时分层**
  `PAPERTEAM_PI_LONG_RUN_TIMEOUT_MS`（默认 900 s，只给 Writer / Reviewer / Researcher 逐 run
  覆盖），通用 300 s 与 Runtime 契约不变。③ **CI**：两处 Windows 假设修正后 GitHub Actions
  ubuntu 首次 success（含 docker-build smoke）。④ **fact verdict 近似值归一**（真实模型输出
  "CONTRADICTION" 曾让整条 run 失败）。⑤ **修复后真实 A/B（A8 / B6）**：两臂 Draft、引用丢失 0
  （gate 产物 `citation_keys_preserved` 真实 PASS）、无超时 / 429；B6 Style Polish 真实触发，
  sec2 / sec3 因丢失公式 / 表格 / ref5 被 Invariant Checker 挡下（原稿保留）；A $1.65 / 51.8 min，
  B $3.52 / 83 min。⑥ **盲评包** `~/.paperteam-acceptance/pairwise/`（pair-01 = A2 vs B2，
  pair-02 = A8 vs B6，随机顺序 + 解盲映射隔离）。B3 / A4 与 A5 / B4 / A6 / B5 因主机 Modern
  Standby 中断（落盘证据仍有效），A7 因 verdict 契约偏差失败——均如实记录。
- **最终判定（2026-09-16 更新，M5_ACCEPTANCE §8）**：M5.0–M5.6 全部 COMPLETE——
  engineering goals achieved；Skill 质量增益为「方向性盲评偏好（2/2）、样本量不足以宣称
  稳定提升」，如实记录。human pairwise 保留为 optional（DoD 调整为 Independent Model
  Pairwise Evaluation，调整原因见 M5_ACCEPTANCE §5）。**不打 tag**：Final 产物在本语料上
  无法达成（无 Evidence 支撑的既有论文），发布版本条件不满足（见 RELEASE_NOTES_M5）。

**M4.8 — Product Closure + Version Experience + Public Repository Readiness
（✅ 完成，2026-09-10）**：
**M4.8 — Product Closure + Version Experience + Public Repository Readiness
（✅ 完成，2026-09-10）**：
M4 收口三件事——(A) **版本体验**：版本历史 / 确定性比较 / 不可变恢复；
(B) **产品闭环**：Existing Paper Improvement 浏览器全链路可达（PDF 确定性
重建 + 改进入口）+ 摘要成为一等修订目标（治本 M4.7 遗留）；(C) **公开仓库
收口**：README / 架构图 / 截图 / Quick Start / Known Limitations / Release。

- **版本域（后端权威）**：`VersionService` 把修订链（`ManuscriptRevisionStore`）
  与 review / gate / build / artifact / iteration / plan 关联成
  `ManuscriptVersionDTO`（对齐口径与 FinalizeService 一致；前端拿到即展示、
  绝不拼装猜测）。HTTP：`GET /versions`、`GET /versions/compare?from=&to=`、
  `POST /revisions/:n/restore`（活跃 run 409）。
- **确定性 Compare（零 LLM，D-0028 相关纪律）**：两修订快照逐文件内容对比
  （modified / unchanged / added / removed）+ LCS 行级增删规模（超界退化为
  行数差）+ 两端 review / gate 记分对照；章节标题取自该修订快照内的大纲。
- **Restore = 新修订（D-0027）**：把 rev{n} 快照复制回工作树，以
  `source=revision.restore` + `restoredFrom={n}` 走正常 commit 流程产生新修订；
  历史登记与快照、旧 Draft / Final 产物永不改动；旧 review / gate / build
  结论因修订前进自然 stale（Finalize 对齐校验拒绝偷用旧结论）；内容与当前
  一致时 `created=false`（幂等事实）。
- **版本 UI（论文产出 tab 内，无新一级导航）**：版本时间线（修订号 / 当前
  版本 / Final / Draft / 恢复来源 / 审稿轮次 / 门禁结论 / 迭代 outcome /
  计划计数）+ 比较（双下拉 + 章节状态表 + 记分对照）+「恢复此版本」行内
  确认（文案如实：创建新修订、历史不删除、旧门禁过期需复审）。Final 后
  继续修订的语义：Final 卡明确「最终版本 修订 N 的 Final / 当前工作版本
  修订 M 尚未 Final」双事实；两份 Final 可并存为历史。
- **摘要治本（D-0029）**：digest 有大纲时单列 `[abstract]` 块（组装根只留
  结构说明）；摘要类 section 引用（摘要 / abstract / main.tex（摘要））只
  路由到摘要目标——载体 `outline.abstract`（修订写回 outline.json，
  writeMainTex 重组生效），绝不落入组装根；Writer 摘要修订输出纯文本
  （结构校验拒绝 LaTeX 结构）。
- **Improvement 浏览器闭环（D-0028）**：PDF 导入（goal=improvement）项目在
  `import.parse` 无 main.tex 时由 `PaperReconstructor` 确定性重建（零 LLM）：
  outline / sections/secNN.tex / references.bib / 组装根；LaTeX 特殊字符
  转义、`[n]` 标记按提取器 relations 映射 `\cite{refN}`、子章节合并 ≤20；
  **如实边界：文本级重建，不含原图 / 原版式**。改进计划 prompt 携带真实
  章节文件清单（此前「必须是现有章节文件之一」无清单无法执行）。Review
  tab 新增「开始系统性改进」入口（此前该路径从浏览器不可达）。
- **测试**：Backend 565 passed（新增 版本域 7 / 重建与 Improvement 全链路 3 /
  摘要路由 1 / 版本域重启恢复 1 / 真实 smoke 回归 issues-omission 1）+
  Frontend 161（新增 VersionHistory 5）；build / typecheck 双侧干净。
- **E2E**：`e2e/tests/version.spec.ts`（A–F + V，7 例：历史展示 / 比较 /
  恢复新修订与历史不变（API 权威核验）/ 恢复后 Finalize 409 如实拒绝 /
  Final 后继续修订双事实 / 重新过 Gate 两份 Final 并存 / Light-Dark 视觉）；
  `e2e/tests/improvement.spec.ts`（I + V，2 例：浏览器全链路 PDF 导入 UI →
  改进入口 → 重建 → 计划 HITL 面板确认 → 修订 → 真实 latexmk 构建 →
  Draft → 复审 → Gate → Final → 查看 / 下载；视觉 + 1100px 无溢出）。
  既有套件复验零回归（hitl 7 / evidence-gate 7 / paper-artifacts 10 全绿）。
- **重启恢复**：`versionRestart` 集成测试——同一 projects 根两栈先后运行，
  awaiting HITL 跨进程恢复（recoverInterruptedRuns 同 index.ts 入口）、
  resume 推进到 Final、版本 / 计划 / 迭代 / 产物清单跨栈一致、重启后
  restore 语义不变。
- **公开仓库收口**：README 重写（30 秒理解定位 / 核心能力 / Mermaid 架构与
  产品流程图 / 截图 / Quick Start / Known Limitations 真实清单 / M4 MVP
  定位）；ARCHITECTURE / API_CONTRACT（§1.2f）/ DECISIONS（D-0027~D-0029）
  同步；secret / 私密数据 / 绝对路径扫描清洁；`v0.1.0-mvp` tag +
  Release Notes（docs/RELEASE_NOTES_M4.md）。
- **真实模型 Improvement smoke（2026-09-10/11，zai-coding-cn/glm-5.3 + 本机
  MiKTeX latexmk 4.88；输入 arXiv 1706.03762「Attention Is All You Need」
  15 页 PDF，4 个 run / 7 个修订 / 约 2 小时模型时间）**：
  - **全链路真实达成**：PDF 导入 → `import.parse` 确定性重建（23 节→10
    个一级章节，40 条 references→bib，callout→`\cite` 映射）→ `import.
    baseline_build` 真实 latexmk 编译重建稿通过 → Researcher 论文理解
    （13 weaknesses，真实工具调用 ~15min）→ citation.verify（40 条真实
    metadata 核验）→ 三路审稿 ×6 轮 → 可行性 INSUFFICIENT（诚实）→ 改进
    计划 → HITL approve → Writer 真实逐节修订（revision.apply，rev2/4/7）→
    bounded revision.revise → 复审 → **Quality Gate FAIL（可解释 5 阻止项：
    16 条 UNSUPPORTED claims / 8 blocking / critical 8 major 15 / 学分
    73<80 / 可行性 INSUFFICIENT）** → stalled HITL `accept_draft`（真实
    CONVERGED 路径）→ **真实 latexmk 构建（7.9s）→ Draft 冻结
    art-draft-rev7** → `POST /finalize` 422 如实拒绝（不降 Gate、不伪造）→
    restore rev1 → rev3/rev6（历史不动）。
  - **真实 smoke 驱动出的两处产品修复**：① 真实 Reviewer 复审偶发省略
    `issues` 字段 → 旧解析判结构失败、整轮昂贵审稿作废（run 1 以此失败
    2/2）——修复为 issues 缺省/null = 无发现（与 claims 口径一致，存在但
    非数组仍拒绝）；② 真实 Writer 按论文原内容重写章节时重新引入
    `tikzpicture`，而 ctexart 组装前导只含 amsmath/amssymb/natbib →
    "Environment tikzpicture undefined" → 修复循环未除净 → Build FAIL 无
    Draft（run 3 以此结束）——修复为修订 / 修复 prompt 明示可用宏包契约
    （图形以文字描述或 table 呈现），修复后 run 4 的 revision.apply 输出
    tikz-free，手动真实构建（同一生产代码路径 `POST /build`）通过并冻结
    Draft。
  - **诚实边界（如实记录）**：run 4 的 bounded `revision.revise` 因单次
    Agent 调用超时（默认 300s）失败 2/2——真实模型在本机延迟下重写大
    章节可超时（可用 `PAPERTEAM_PI_RUN_TIMEOUT_MS` 调大）；该 stage 的
    完成路径由 run 3 真实验证（两轮自动修订 → 收敛 HITL）。最终版本链
    rev1-7 完整保留四类来源（审稿快照 / 应用改进 / 自动修订 / 版本恢复）。

两个闭环落地——(A) **Draft / Final 产物闭环**：Build Gate 产出真实 PDF、
Draft 即时冻结、Final 双 Gate 校验后冻结、产物不可变可下载；(B) **Writer–
Reviewer 修订闭环**：审稿意见 → 确定性修订计划 → Writer 逐节修订 → 强制
复审 → 确定性收敛判定（PASS / IMPROVED / CONVERGED / REGRESSION），不收敛
与超限交给 HITL。7 个 commit（a1f5df8 → ed51b2e）。

- **manuscript 修订域（Authoritative）**：`ManuscriptRevisionStore`——每个
  改稿动作（outline.plan / writing.sections / revision.revise / apply /
  repair_latex / review 快照）提交**内容哈希幂等**的不可变修订号；gate /
  build / artifact 记录各自携带对齐修订，Finalize 据此拒绝 stale 结论。
- **确定性修订计划（D-0026）**：`revision.plan` stage 纯代码派发
  critical/major finding 与引用缺失（`reviews/revision-plan-r{round}.json`
  落盘）；minor / gate 阻止项只记录不派发（防非收敛循环）。Writer 只是
  计划的执行者，禁止凭空新造文献。
- **收敛判定（确定性无 LLM）**：每轮 gate 与上一轮 scorecard 对比得
  PASS / IMPROVED / CONVERGED / REGRESSION，逐轮追加 iteration-history；
  CONVERGED / REGRESSION / 计划空 → `hitl.revision_stalled`（两轮记分卡
  对比 payload）；预算耗尽（默认 2 轮 + HITL revise_more ≤3）→
  `hitl.revision_overflow`。两节点均 accept_draft / revise_more / cancel；
  **accept_draft 在预算尚余时也被尊重**（E2E 驱动出的修复）。
- **LaTeX 诊断 + bounded repair loop**：compile.log 结构化解析（文件 / 行号
  / 错误 / 附近行）→ `revision.repair_latex` 每项目自动修复 ≤2 次，最小
  上下文（只给受影响文件 + 诊断，绝不整篇论文 + 整份日志），可取消；
  修复即改稿 → 既有结论过期，复审后才能 Final。
- **Draft / Final 产物域**：`artifacts/` 不可变 manifest
  （art-draft-rev{n}.pdf / art-final-rev{n}.pdf）；**Build 通过即冻结 Draft
  （质量语义不参与，D-0015）**；`FinalizeService` 纯确定性双 Gate 校验
  （零 LLM：不允许「Final Reviewer Agent 判断能不能 Final」）。
- **HTTP（见 API_CONTRACT §1.2e）**：artifacts 清单 / 元数据 / download
  （**只经 manifest 解析，不接受任何路径参数，防 path traversal**；inline
  缺省 = 浏览器原生 viewer，`?disposition=attachment` 才落盘）/ finalize
  （活跃 run 409；条件不满足 422 可行动文案）/ build 记录 / build/log /
  revisions / iterations / revision-plan。
- **前端 PaperPanel**（项目 tab「论文产出」，quick-review 项目不显示）：
  Final 卡（冻结修订 / 通过轮次 / 查看 / 下载）+ Draft 卡（可用性 + 「当前
  版本可以作为 Draft，但尚未满足 Final 要求」边界文案）+ 构建状态卡
  （工具 / 耗时 / 对齐修订 / 结构化诊断 / 编译日志折叠）+ 迭代历史卡
  （每轮 outcome：首轮 / 有实质改善 / 已通过 / 不再收敛 / 出现退化）+
  产物历史（不可变清单）。标记 Final 按钮**永远可点**，资格由后端判定，
  422 拒绝如实呈现——绝无前端 `if (buildOk && qualityOk)` 自行产生 Final
  的路径。
- **测试**：Backend 553 passed（新增 revisionLoop 收敛语义 6 + 组装根
  main.tex 修订 / 修复两条回归、FinalizeService / ArtifactStore / repair loop /
  修订幂等等 suites）+ Frontend（PaperPanel / API 层）；`npm run typecheck`
  双侧干净。
- **E2E（`e2e/paper-artifacts.spec.ts`，10 例，scripted 栈 + 本机真实
  MiKTeX latexmk）**：A gate 通过 → 真实编译 → Final 冻结（inline 查看 /
  attachment 下载 / 产物历史）；C fail→修订→复审通过→Final；D REGRESSION
  / E CONVERGED → stalled HITL → accept → Draft；F 预算耗尽 → overflow →
  accept；B 复用其终态验证 Draft 语义（质量门禁不阻塞 Draft；finalize 422
  拒绝且**不出现「因此 PDF 无法生成」错误语义**）；G 真实编译失败 → bounded
  修复成功 → 复审 → Final；H 修复耗尽 → Build FAIL → overflow（buildOk=false）
  → 无 PDF + finalize BUILD 拒绝；I 快速 Review 只读红线（无论文产出 tab、
  完成后零产物）；J Light/Dark + 1100px 无横向溢出。全套 10/10（1.1m）。
- **E2E 驱动出的两处真实修复**：stalled accept_draft 在修订预算尚余时被
  忽略（planner 仍自动再修一轮）；revision.revise 修订 prompt 章节标题用
  了大纲 id 而非人类标题。均先以 E2E 复现、再修、再全量回归。
- **真实模型 smoke 驱动出的修复（2026-09-10）**：真实 Reviewer 会把摘要类
  finding 归到 `main.tex（摘要）`，`sectionMatches` 的宽松匹配
  （`ref.includes(stem)`，stem="main"）把它路由到组装根 main.tex → Writer
  收到 `\documentclass` 全文、按指令返回完整骨架 → DoD 拒绝（2/2）→ run
  failed。修复：**有大纲时组装根 main.tex 绝不作为修订目标 / 修复目标**
  （`listRevisionTargets` 跳过；repair 侧同样过滤，诊断只指向组装根时记一次
  空尝试走既有耗尽路径）；该条 finding 留在计划里不派发（复审可见，最坏走
  收敛 HITL）。scripted Writer 增加「修订 prompt 含 \documentclass → 返回
  完整骨架」镜像 + 回归测试，防此类回归静默通过。
- **真实模型 smoke（2026-09-10，zai-coding-cn/glm-5.3 + 本机 MiKTeX
  latexmk 4.88，run w-b974e4333932）**：真实小论文全链路（研究主题：中文
  商品评论情感分类的少样本示例选择策略实证研究）——调研 2.5min（5 gaps /
  bibliography）→ 可行性 MEDIUM → HITL → 大纲（8 节）→ HITL → 分节写作 →
  引用核验（hallucinated=0）→ **三轮审稿 × 两轮修订**（iteration：
  首轮 null → IMPROVED（critical 2/major 8/学分 42 → 2/3/47）→ CONVERGED
  （2/4/49，失败规则集相同））→ `hitl.revision_stalled`（outcome=CONVERGED，
  呈报两轮记分卡）→ accept_draft → **真实 latexmk 编译（5.6s，exitCode 0）
  产出 165KB PDF** → Draft 冻结（art-draft-rev4）。**诚实结果：Draft PASS，
  Final correctly blocked**——论文无真实实验（Writer 如实以「待实验产出后
  填充」占位而非编造数据），academicScore=49 < 80 等五项 gate 阻止如实
  上报；`POST /finalize` 422 QUALITY_GATE_FAILED（可行动文案）；产物下载
  200 inline（浏览器原生 viewer）；`..%2f` 路径穿越 404。本 run 的 reviewer
  再次把摘要 critical finding 归到 `main.tex（摘要）`——修复后正确留在计划
  里不派发，revision.revise 顺利完成，组装根完好。

**M4.6 — Evidence Workbench + Quality Gate UI（✅ 完成，2026-09-10）**：
把「这篇论文里的核心论断，依据是什么？可靠吗？」做成一等公民页面——
Evidence 工作台 tab + 质量门禁面板。**后端只做最小补口**（审计先行：
Evidence / Review / Citation / QualityGate 四域产物与关系全部核对），
前端严格只渲染后端事实，不自行推断。

- **后端最小补口（无新架构）**：`ReviewArtifactStore` 新增 gate 产物读取
  （`gateFileName` / `gateRounds` / `loadGate` 防御式校验）；HTTP 新增
  `GET /api/projects/:id/quality-gate`（?round= 历史轮，返回
  `{rounds[], round, gate, reviewSummary, latestReviewRound, stale}`，
  round 隔离由产物结构保证——quality-gate-r{n}.json 内嵌同轮
  reviewSummary）；`POST /evidence` 支持可选核验字段
  （verificationStatus / verificationLevel / supportStrength，枚举校验 400）。
  QualityGate 评估逻辑零改动（仍为确定性代码，前端绝不重算 PASS/FAIL）。
- **修复（既有接线缺口）**：`CITATION_METADATA_ENABLED=0` 此前只接到旧
  CitationService，quick review 的 `citation.metadata` stage 仍会真实外呼
  Crossref/OpenAlex（网络慢时整条 run 停滞，e2e 偶发超时根因）——现在
  serviceStack 把 metadataEnabled / metadataTimeoutMs / contactEmail 一并
  接到 citationIntegrity 的 resolver（disabled → 空 provider 集逐条
  UNRESOLVED，不外呼；显式注入的测试 providers 优先）。
- **Evidence 工作台**（`EvidencePanel`，项目 tab「证据」，URL state）：
  ledger 概况（总数 / 已核验 / 待核验 / 需注意 / 被正文使用 / 来源）+
  本地筛选（状态 segmented / 章节 / 来源 / 搜索 id-claim-摘要-引文-DOI）+
  行内截断展开 + 详情 provenance（文献 / DOI / 页码 / 章节 / 核验方式 /
  使用记录）+ 低重量「确认已核验」（unverified 行才出现）。中文状态标签
  （unverified 待核验 / verified 已核验 / plausible 大体可信 / mismatch
  与来源不符 / unverifiable 无法核验 / not_found 未找到来源），Domain 枚举
  不动；mismatch/not_found/unverifiable + contradictory 计入「需注意」，
  INSUFFICIENT/无法核验用中性/警示色不用红色；未落库的字段（如 finding
  的 evidenceIds）只防御性渲染、不虚构。
- **质量门禁 UI**（`QualityGatePanel`，挂在 WorkflowPanel 内；Overview
  克制质量状态卡；Review tab 仅 improvement 类型显示结论条）：结论徽标 +
  阈值行 + 阻止项清单（ruleId → 中文注册表 + 前往处理深链 `?tab=evidence
  &attention=1` 等，按 ruleId 映射不按 reason 字符串匹配）+ 15 条规则清单
  （通过 / 未通过 / 不参与判定；citationIntegrity 4 条与
  citation_semantic_verification_off 中性展示）+ 同轮审稿上下文（round
  隔离可视化）+ 历史轮次切换（轻量 select，逐轮 refetch）+ 过期提示
  （stale = gate 轮次 < 最新 review 轮次，手动重评按钮）+ Draft/Final 边界
  文案（未通过 ≠ 不能生成 PDF）。semanticMode=off 的快速 Review 项目如实
  显示「不运行门禁」空态，Overview 不显示质量卡。
- **集成**：阶段时间线 quality.gate 完成行「查看门禁详情」滚动入口；HITL
  修订耗尽 payload「查看详细问题」入口；Overview 质量状态卡（含过期 /
  未评估态）。
- **测试**：Backend 514（新增 GateApi 3：空态 shape / fail→pass 两轮 rounds
  desc / ?round= 隔离与 404/400 / 9 条基础规则集；httpResources +1 手工登记
  核验字段；serviceStack 3：metadata 接线回归）+ Frontend 141（新增
  EvidencePanel 7 / QualityGatePanel 10）全部 PASS。
- **E2E（`e2e/evidence-gate.spec.ts`，7 例，scripted 栈）**：A1 完整
  idea_to_paper（fail→pass 修订环）产出两轮 gate；A2 工作台全交互（筛选 /
  搜索 / 详情 provenance / 确认已核验 / URL 保持）；B r1 FAIL（可解释阻止
  项 / academicScore=66 实际值 / 9 规则 / Overview 卡 / 时间线入口）；C r2
  PASS 轮次切换（同轮 review 一起切）；D 真实矛盾证据 → gate FAIL → 深链
  证据页需注意筛选；E semanticMode=off 空态不出现假 0/0 或误 FAIL；F
  Light/Dark × 1440/1100 无横向溢出截图留档。全套 7/7（scripted 栈离线化
  后 13s）。既有套件复验：hitl 7/7、smoke 7/7（默认栈）、workflow 4+1skip
  （无模型栈）+ 模型门控 E 真实链路通过、visual 10/10（含新
  project-evidence 路由，5 视口 × 2 主题）。
- **视觉 QA**：6 张 m46 截图（Light/Dark × 证据页 / 门禁 FAIL / 门禁 PASS）
  模型走查两轮——克制红色（仅徽标 + 阻止项描边 + 单条未通过 pill）、PASS
  不满屏绿、深色主题真实生效；Pass 1 发现「查看门禁详情」竖排（grid 列约
  束）与阈值行对比度不足，修复后复验通过。
- **真实数据只读 smoke**：默认栈全部真实项目（6 个，均为 quick-review
  类型）× 新端点全部 200——如实空态（无 evidence.jsonl / gate 产物，不虚
  构）；当前无 idea/improvement 类型真实项目，带产物路径由 e2e + 单测覆盖。

**M4.5 — HITL UI（✅ 完成，2026-09-09）**：把 Backend 既有的
`awaiting_input` / resume / cancel 产品化到前端——用户能看懂「为什么停住」，
并可 继续 / 调整 / 修改 / 取消，Workflow 正确恢复。**Backend 引擎零改动**
（审计确认 awaiting 已随 checkpoint 持久化、resume 有并发与状态防护、
SSE 事件与 replay 齐备）；本轮新增的是前端决策面板与 scripted E2E 栈。

- **HITL 决策面板 `HitlPanel`**（统一 shell + 按 `awaiting.stageId` 差异化
  payload renderer，不做每 Stage 一套）：prompt（为什么暂停）+ 业务上下文
  （可行性结论等级徽章 / 理由 / 缺口 / 实验 / 建议；大纲标题 + 摘要 + 章节
  列表；改进计划条目 + 优先级；修订耗尽的 Gate 结论 + 审稿规模）+ 动作
  **严格按 `awaiting.options` 渲染**（未提供的动作不出现，杜绝「前端四个
  按钮、后端 400」）。
- **真实 decision 契约**（前端 `HitlDecisionInput` 类型化 union，与
  backend definitions.ts 一致）：`approve`（继续）/ `adjust`（仅可行性节点：
  targetProfile / targetVenue ≥一项，评估建议来自 payload）/ `revise`
  （仅大纲 / 改进计划节点：非空 feedback，本地校验前置拦截空提交）/
  `accept_draft` + `revise_more`（仅修订耗尽节点）/ `cancel`（走 decision
  通道留档 `inputs`，行内确认，终态来自 Backend）。表单空值禁用提交 +
  文案提示；pending 期间全部动作禁用（防双击重复 resume）。
- **过期请求与错误 UX**：resume 409（WORKFLOW_INVALID_STATE，含并发重复 /
  已在其它页面 resume）→ 展示 Backend 中文 message + 折叠 detail，并失效
  run 列表取权威状态——待办已处理则面板自然消失，页面不卡死。
- **恢复语义**：待办数据全部来自 `GET /api/runs`（checkpoint 持久化），
  **浏览器刷新与 Backend 重启均可恢复 awaiting**（e2e 覆盖刷新；真实模型
  smoke 覆盖重启）；SSE `workflow.awaiting_input` / `workflow.resumed`
  驱动面板出现 / 消失，无需手动刷新。
- **联动**：概览「当前任务」卡 awaiting 时显示等待确认 + 「前往处理」主
  按钮；侧栏「下一步」首项「有 1 个任务等待确认」；Review 页对其它工作流
  的 awaiting 显示提醒 + 跳转（决策统一在工作流页）；Timeline awaiting
  一等化（M4.4 已有，填充等待点 + 状态文字）。
- **测试**：Backend 507（新增并发 double-resume：慢速 onInput 下两个
  resume 恰好一个成功一个 409、workflow.resumed 事件唯一、单 awaiting
  invariant）+ Frontend 124（新增 HitlPanel 10：payload 渲染 / options
  严格渲染 / approve / adjust / revise 校验与 payload 裁剪 / cancel 走
  decision 通道 / 409 stale 处理 / 重新挂载恢复）全部 PASS。
- **E2E（`e2e/hitl.spec.ts`，7 例）**：新增 `PAPERTEAM_TEST_RUNTIME=scripted`
  测试栈（`src/runtime/scriptedRuntime.ts`：编排器 / checkpoint / SSE / HTTP /
  React 全真实，仅模型输出为确定性脚本；testStack.ts 改为复用同一实现，
  单一事实源）——A approve→自动恢复 B revise→重规划 C 刷新恢复 D cancel
  E 他端 resume 后旧页面让位 F/G Light+Dark 视觉 + 1100px 无横向溢出。
  无模型栈全套 e2e 同步复验无回归（21 passed / 8 skipped）。
- **真实 smoke**：真实 zai-coding-cn/glm-5.3 idea_to_paper → 真实推进至
  `hitl.feasibility_confirm`（awaiting payload 携带真实可行性结论）→
  **Backend 重启后 GET run 仍 awaiting** → resume approve → outline.plan
  真实重规划 → cancel 终态；inputs / events 留档验证。
- **视觉**：5 张截图（可行性 Light/Dark、大纲 + revise 表单 Light、大纲
  Dark、取消确认 Dark）人工 review——与现有 Panel / Chip / Note / Btn 语言
  一致，warning 强调（非 danger），无临时后台感。

**M4.7 已完成（见顶部章节）；M4.8 见顶部章节；M4 已 COMPLETE。**

---

**Citation Semantic Verification Correctness Hardening（✅ 2026-09-09）**：

**Citation Semantic Verification Correctness Hardening（✅ 2026-09-09）**：
语义核验粒度从「sentence × every reference」升级为「**atomic claim ×
citation group**」，修正系统性 false positive，并用真实 Attention Is All
You Need PDF（arXiv 1706.03762）完整 E2E 验证。

- **根因**：旧 `buildClaimRecords` 把 callout 句子整句绑到组内每篇文献
  （`[35, 2, 5]` 展开成 3 条记录，每篇被要求单独支撑整个复合句）——组内
  分工被错判成「单篇不支持」（真实复现：[2] Bahdanau 被判 UNSUPPORTED，
  理由是「未提及 RNN/LSTM/GRU 被确立为 SOTA」）；且 callout 展开后丢失
  组归属（rawText 不保留）。
- **新算法（v4 → v5）**：句子 → 原子论断（`claimDecomposition.ts`：结构化模型
  批量拆解，批 8 句 / 上限 24 调用 / 版本化缓存；简单句与无证据句零拆解
  调用；任何失败退确定性兜底=整句单论断）→ 论断绑定邻近引用组（按标记
  位置；v5 收紧：预告性/组织性表述——「下文将描述 X」——markers 留空，
  不继承句内引用组；model 计划严格绑定，fallback 计划保持全组兜底）→
  (原子论断 × 引用组) 一条记录（`referenceIds`
  全组成员共同承担；anchor=首成员兼容旧展示；`groupRawText` 保留
  `[35, 2, 5]` 原文）→ 组证据合并 judge（每成员 abstract/repo 描述，
  上限 6 篇）。
- **verdict 收紧**：UNSUPPORTED 仅当证据与论断主题相关且足够具体（未提及/
  笼统/无法判断 => INSUFFICIENT_EVIDENCE）；CONTRADICTED 必须带逐字来自
  证据的反向 keyQuote（引不出 => 确定性降级 INSUFFICIENT_EVIDENCE +
  reasonCode UNQUOTED_CONTRADICTION）；PARTIALLY_SUPPORTED 不因组内单篇
  只承担部分责任而触发；**INSUFFICIENT_EVIDENCE = 无法自动判断 ≠ 论文
  问题**：severity 由 minor → **info**（不构成任何级别 Finding），UI 标签
  「无法自动判断」中性色 + 帮助文案，导出标题/未解决列表改为「不代表引用
  存在问题」口径；contradiction_only judge 三值
  （CONTRADICTED / NO_CONTRADICTION_DETECTED / INSUFFICIENT_EVIDENCE）。
- **组员分层**：真实性未确立（NOT_FOUND/PROVIDER_ERROR/AMBIGUOUS）或无摘要
  的组员不参与证据（记 `excludedReferenceIds`，Layer 1 单独报问题）；全员
  不可判 → SKIPPED；组内可判成员全无摘要 → 确定性短路（零模型调用）。
- **缓存失效**：`SEMANTIC_VERIFICATION_VERSION` 3 → 5 进指纹 + 记录新增
  `semanticVersion` 字段；`listClaimRecords` 只返回当前版本记录（旧版本
  记录保留在磁盘、不删除用户数据，但不再读出）；提取层 v3（callout
  rawText）与拆解层 v2 各自独立指纹。
- **真实 E2E**：arXiv 官方 PDF（D:\Tmp\attention-is-all-you-need.pdf，15 页，
  sha256 bdfaa68d…df697，不入库）；真实产品链路（import-pdf API →
  existing_paper_review 工作流 citationSemanticMode=full）+ 真实模型
  zai-coding-cn/glm-5.3 + 真实 Crossref/OpenAlex/S2/arXiv 检索；Introduction
  的 RNN/LSTM/GRU/MT 复合句拆出原子论断、`[35,2,5]` 组级共同核验——
  修复前 [2] 单篇 UNSUPPORTED 的 false positive 消除（详见本轮报告）。
- **测试**：backend 503（新增 claimDecomposition 11 例 + 语义核验 v4 重写
  11 例：复合句分组 / 组共同支撑 / 组员不完整不自动 UNSUPPORTED /
  metadata-only / 证据不足不进 Finding / 逐字引文矛盾 / 无证据零模型调用 /
  拆解兜底与缓存 / contradiction 三值）+ frontend 112 全部 PASS；无任何
  特定论文特判（grep 审计）。

---

**M4.4 — Workflow Live View + SSE + Cancel + Progress（✅ 完成，2026-09-09）**：
把 Backend 既有 Workflow / Domain Event SSE / 取消 / 进度能力正式产品化到前端。

- **Workflow Live View（项目工作区「工作流」标签）**：当前任务卡（类型 / 状态 /
  开始时间 + 客户端 timer 已运行时长 / 阶段进度）+ **Stage Timeline**
  （completed / running / awaiting / failed / cancelled / pending 六态；每行带
  状态文字不只靠颜色；条件 stage 标「按需」；stage → 中文标签与三种 kind 的
  顺序模板集中在 `status.ts`，与 backend definitions.ts 对齐）+ 最近运行历史
  （可点击切换查看）。runId / 时间戳 / 每阶段尝试与耗时 / 并发画像收进折叠
  「详细信息」。
- **分章节 Review 进度**：`17 / 33` 确定性计数 + 细进度条（completed/total，
  非虚假百分比）+ `运行中 N / 等待 M / 已重试 R / 失败 F`（backend
  `stage.progress` 载荷新增 `started` / `retried`；active = started -
  completed - failed，queued = total - started）。`maxObservedConcurrency`
  只在详细信息（Performance Details）展示。
- **SSE 数据层 `useWorkflowEvents`**：页面级订阅（存在活跃 run 时建立），
  先订阅后 replay、seq 去重（重连 replay 不重复应用）、`stage.*` 事件直接
  增量更新 TanStack Query 缓存（run 列表），`awaiting_input` / 终态走
  invalidate 取权威状态（review 类 run 终态连带失效报告 / 引用 / 项目缓存）；
  终态关闭连接；活跃时 3s 轮询保留为 SSE 故障兜底。耗时用客户端 timer 基于
  server 时间戳，不轮询后端。
- **取消**：`取消任务`（btn-danger 描边样式）→ 行内确认（文案如实：
  已完成阶段与结果保留、未开始不执行、进行中调用被中断）→ pending 禁用
  → settle 窗口显示「正在取消…」→ 终态「已取消」。**Backend 两处最小修复**：
  ① `cancel()` 对已 cancelled 的 run 幂等返回（completed/failed 仍 409）；
  ② `verifyMetadata` 接受 AbortSignal 逐条循环检查中止（此前引用真实性核验
  全程不响应取消，e2e 实测取消要等整轮网络扫描 ~90s+）。AgentRun 级取消
  （queued 停止派发 + active abort）经审计确认 Review 并发版本已解决（既有
  专项测试），无需改动。
- **awaiting_input / failed / completed**：等待确认块（prompt + options +
  「交互处理将在下一阶段提供」的如实说明 + 真实可用的取消入口，不做假
  approve 按钮）；失败块（稳定中文文案 + 失败阶段 + 重试建议 + 折叠技术
  detail）；完成块（总耗时 / 阶段数 / 已审阅 N/M 节 + 查看 Review / 查看引用
  核验 / 导出报告真实入口）。
- **联动**：概览新增「当前任务」摘要卡（状态 + 阶段 + 进度 + 查看工作流）；
  Review 页运行中显示阶段清单 + 「工作流」入口；Review 完成后报告缓存经
  SSE 终态失效自动刷新；右侧栏「查看任务进度」指向工作流。
- **验证**：Backend 486（新增 SSE 重连 replay 去重 ×2 + cancel 幂等 +
  verifyMetadata 取消 + progress 载荷断言）+ Frontend 112（新增
  workflowEvents 7 + WorkflowPanel 7）全部 PASS；Playwright 新增
  `workflow.spec.ts`（无模型栈：时间线 SSE 推进 / 取消 / reload 恢复 / 失败态
  / 联动入口；模型门控：小论文完整链路 → completed → 报告就绪，单节短调用量级）
  + visual.spec 增 `project-workflow` 路由（浅/深 × 5 视口）；真实 GLM 小论文
  smoke（1 页 / 1 节 / 3 引用，58s 完成）验证真实 SSE → 前端实时更新 → 报告。
  浏览器视觉 review：浅/深 × 1366/1440/1920/1100w 运行中 / 终态 / 详情截图
  检查，修复亚秒耗时「00:00」噪音。

**下一阶段：M4.5 HITL UI**（awaiting_input 的 approve / adjust / revise 交互；
backend resume API 与事件载荷已就绪，前端结构已预留等待确认块）。

---

**引用语义核验可配置（CitationSemanticMode，2026-09-09 完成）**：引用两层
核验明确分层——Layer 1 真实性 / metadata 核验**始终执行**；Layer 2
Claim-Citation 语义核验改为 Review Run 配置（`off` / `contradiction_only` /
`full`），**新 Review 缺省 `off`**（`citation.claims` stage 真实跳过、语义
模型调用 0；旧持久化 run 无字段按 `full` 解释）。模式随 run `request`
持久化并写入每轮聚合报告，off 轮不携带语义统计（历史轮记录按 run 隔离，
不污染本轮报告 / Markdown 导出）；Quality Gate 语义类规则仅在 mode ≠ off
时参与（contradiction_only 下只有明确矛盾参与判定）。`contradiction_only`
为保守中间档：judge 只回答 `CONTRADICTED / NO_CONTRADICTION_DETECTED`，
无证据 → `SKIPPED`（不产生 INSUFFICIENT_EVIDENCE 噪音），模式进入 claim
指纹（与 full 记录不互相沿用）。前端在「开始 Review」与导入页的高级选项
提供配置（默认关闭，含帮助文案），off 轮报告显示克制的「引用语义核验
未开启」+ 低权重「进行语义核验」入口（跳转引用核验面板手动补跑）。
性能语义如实记录：关闭语义核验只省 ~3.1% 冷启动耗时（6 次 judge），
最大瓶颈仍是 review.sections（见 REVIEW_PERFORMANCE_PROFILE.md）。
测试：backend 482（新增 citationSemanticMode 全链路 9 例 + Gate 3 例 +
导出 3 例 + 服务级 contradiction 路径）+ frontend 98（ReviewPanel 模式
UI 5 例、导入高级选项 1 例）全部 PASS；真实论文 PDF（26 页 / 25 引用）
Fake-Runtime smoke 验证 off 轮语义模型调用 = 0。

**Project Hardening & Real Paper E2E 完成（2026-09-07）：M4.3 全部子里程碑含 M4.3.8 真实用户论文 E2E 收口，产品进入可用状态；下一步 M4/M5 规划另行决定。** 此前基线——M4.3 Foundation Complete（M4.3.0 Review Domain Model → M4.3.7 Minimal UI）。 Final PDF 正式成为 Existing
Paper 的 Review 输入：PDF → pymupdf 确定性解析 → pages/sections/chunks（页
provenance）→ PaperMap + 受控 section review context（其他章节全文绝不进
入当前章节的审稿上下文）；引用完整性两层核验（文献真实性=外部学术库确
定性核验，NOT_FOUND≠捏造；(claim,citation) 单记录语义核验，模型禁止凭记
忆判定、judge 引文必须逐字来自检索证据）；Skill Registry 落地（两项审计
过的 MIT Academic Skill，pin revision + LICENSE + PROVENANCE，按角色注入
Pi 会话，progressive disclosure 保持）。M4.0-M4.2 的 React Workbench 基线
保持。React 19 +
TypeScript + Vite + React Router 7 + TanStack Query 5 + Zustand 5（npm，
frontend/ 独立包）；`npm run dev` 一键双进程（Backend :3000 + Vite :5173，
`/api`、`/health` 经 Vite proxy 同源转发，任一退出联动全退）。前端只消费
[API_CONTRACT.md](API_CONTRACT.md) 冻结的 DTO，不依赖 Backend 内部对象；
Runtime Status 完全适配 Pi schema。Project
List / Create Project（双模式）/ Project Workspace 基础壳就绪。
**M4.2.5 Live Model Integration Gate ✅（2026-09-05）：真实 Provider
`zai-coding-cn/glm-5.3` 经运行中 Backend 全链路验证（单 Agent smoke /
live SSE / Workflow 至首个 HITL / 真实 cancel），L3 Live Provider E2E
verified（见下）。当时的下一阶段「Workflow Live View + SSE + Cancel」
已于 M4.4（2026-09-09）完成。**

**Review 并发优化完成（2026-09-08）**：分章节 Review 有界并发落地
（`SectionReviewScheduler` + `PAPERTEAM_REVIEW_CONCURRENCY`，默认 3；真实
benchmark：review.sections 2.81×、run 总时长 2.61×，详见
`docs/REVIEW_PERFORMANCE_PROFILE.md` 与「历史」）。**2026-09-08 文档轮**：
确立下一阶段核心架构方向——Iterative Writer–Reviewer Outer Review Loop
（[D-0026](DECISIONS.md)，见下节规划）。

## M4.9 Iterative Review Loop / Review Quality Optimization（✅ 已由 M4.7 实现，本节保留为当时的规划记录）

> **2026-09-10 注**：本节 2026-09-08 冻结的规划（score-driven loop / scorecard
> 一等化 / revision-plan-driven Writer / 强制复审 / 收敛终止 / 并发增强 /
> iteration history）已由 **M4.7 全部实现**（D-0026；见顶部 M4.7 章节），
> 下列「PLANNED」标注为历史记录。

> 2026-09-08 文档轮确立（DECISIONS D-0026、PRD §9.5、ARCHITECTURE §13）。
> **本节为规划，尚未实现**；里程碑编号在既有 M4.4-M4.8 前端页面预留号
> （见 ARCHITECTURE §8.3）之后顺延取 M4.9，实际优先级与执行顺序由后续
> M4/M5 规划决定，不因编号隐含排序。

已具备的基线（CURRENT，非本里程碑交付）：

- **M3.2 bounded revision loop（baseline）**：Review（fact / academic /
  style 三路并行，独立 contextScope 会话）→ 确定性聚合（ReviewSummary 按
  round 落盘）→ Quality Gate（9 条基础规则 + Citation Integrity 硬规则，
  全部确定性判定）→ Writer 逐节修订（修订指令在执行期从最新审稿汇总 + 引用报告确定性
  派生；不允许新造文献）→ 回到引用核验 / 三路审稿 / Gate → 自动修订 ≤2 轮
  + HITL revise_more ≤3 → 超限 HITL（accept_draft / revise_more / cancel）。
  评分只是 Gate 的两条规则——blocking issue、unsupported critical claim、
  捏造 / not_found 引用等硬规则不因总分高而豁免。
- **Review 有界并发（2026-09-08 完成）**：分章节 Review 经
  `SectionReviewScheduler` + `mapWithConcurrency` 有界并发
  （`PAPERTEAM_REVIEW_CONCURRENCY` 默认 3、范围 1-8；固定 runner 池——
  任务开始受 limit 约束，backpressure 语义而非无界 Promise.all；每节独立
  contextScope / Pi session；单节失败隔离（failedSections 继续）；节内
  退避重试；取消停止派发并中断在途模型调用；结果按论文顺序确定性重排；
  每节完成即写 per-section journal 供 stage 重试 / 崩溃恢复）；PaperMap
  章节摘要同为有界并发（`PAPERTEAM_SUMMARY_CONCURRENCY`）。三路
  manuscript review 为 3 个固定 lens 并行（天然有界）。真实 benchmark
  （C=3，全量 33 节）：review.sections 2763.8s → 985.3s（2.81×）、run
  总时长 3217.5s → 1234.6s（2.61×），0 失败 / 0 重试 / 0 次 429。
- **按轮产物**：`reviews/review-r{n}-{mode}.json`、`review-summary-r{n}.json`、
  `quality-gate-r{n}.json`、`existing-review-r{n}.json`（round 从 1 递增）。

规划内容（PLANNED，均未实现）：

- **score-driven Writer ↔ Reviewer loop**：review 轮次从「修订的附带步骤」
  升级为驱动循环的一等输入——每轮 scorecard 既决定下一轮 Revision Plan，
  也参与终止判定
- **structured review scorecard 一等化**：跨轮维度变化对比（哪些问题被
  修复 / 仍存在 / 新增、哪些维度提高 / 退化）；score 保持为信号，
  Quality Gate 仍是最终确定性权威
- **revision-plan-driven Writer**：Revision Plan 固化为一等落盘 artifact /
  task contract（与该轮 scorecard、gate 结果关联；当前为执行期派生指令）；
  **不新增 RevisionPlanner Agent**
- **re-review 强制**：修订后的版本必须重新 Review，不自评通过
- **convergence / regression / max iteration 停止条件**：新增 CONVERGED
  （连续轮改善低于阈值 → Human Checkpoint）与 REGRESSION（重要维度明显
  退化 → 停止盲目修改并保留 / 恢复较优版本）终止态，阈值 configurable；
  PASS / MAX_ITERATIONS 已在 baseline 实现
- **review parallelism & backpressure 增强**：provider / model capacity
  感知的动态并发上限、跨 stage 统一 backpressure、partial progress 产品化
  呈现
- **iteration history / observability**：每轮 revision / review / scorecard /
  findings / revision plan / gate 结果 / workflow iteration / agent 执行
  trace 的关联与查询；前端迭代历史 UI（Round N 分数走势、问题演化、
  REGRESSION 时恢复较优版本）

## M4.3 — PDF Review + Citation Integrity + Skill Registry（✅ Foundation Complete，2026-09-06）

> M4.3.8（真实用户论文全文 Review E2E）不在本轮；本轮以真实公开论文
> （arXiv 1706.03762）完成集成 smoke。

| 子里程碑 | 状态 | 说明 |
|---|---|---|
| M4.3.0 Domain Model | ✅ | `paper/types.ts`（PaperDocument/Page/Section/Chunk/PaperMap + 防御性读取守卫）、`citation/integrity.ts`（ReferenceEntry / CitationCallout / CanonicalPaperRecord / CitationVerificationRecord / **ClaimCitationRecord**（(claim,citation) 单记录，借鉴 RefWarden）+ `deriveClaimSeverity` 确定性派生）、`review/finding.ts`（ReviewFinding，provenance 强制）、`skills/types.ts`（SkillMetadata + frontmatter 解析）。全部 JSON 可序列化，无 Pi 类型泄漏 |
| M4.3.1 PDF Ingestion | ✅ | `backend/tools/parse_paper_pdf.py`（pymupdf 1.28.2 子进程，UTF-8 stdout JSON、无 shell）+ `PdfParser` seam + 确定性 section/chunk 组装（TOC > 标题正则 > 整档；References 章节标题+[n] 双确认补齐）+ `PaperStore`（paper/source + parsed/{document.json,pages/,sections.json,chunks.jsonl} + stages.json）+ 上传校验（%PDF- 头 / 50MB / basename 归一化 / sha256 幂等替换）。真实 PDF：15 页 / 23 sections / 27 chunks / quality=good；重启后全新实例可重建 |
| M4.3.2 Long-document Context | ✅ | `PaperMapService`（骨架确定性 + 单 section 摘要一次调用、指纹缓存、失败容忍）+ `ReviewContextBuilder`（论文概览 + 全文导航摘要 + 仅当前章节 chunks + 可选引用注入；分项 budget）。**隔离证明**：Method 上下文不含其他章节全文；**会话无关证明**：Runtime Session 全弃后从磁盘确定性重建 |
| M4.3.3 Citation Extraction | ✅ | `ReferenceExtractor`（numeric [n] 条目 + 跨行合并 + 章节边界正文剥离；title/authors/year/venue/doi/arXiv best-effort；Unicode 安全）+ callout（[1]/[2,3]/[4-7] 展开为逐条 relation；范围内空缺=unresolved、超范围=invalid，不猜；author-year best-effort）；真实 PDF 40 条 references / 51 callouts / 关联可追踪 |
| M4.3.4 Metadata Verification | ✅ | `ScholarlyResolver`（crossref/openalex/semantic-scholar/arxiv 轻量 connector；标题+作者重合+年份±1 门控；重复收录合并；DOI 精确优先；重试×1 + LRU 查询缓存 + 礼貌间隔 + telemetry）。**失败语义**：网络/5xx/超时=error→UNRESOLVED（绝不 NOT_FOUND）；≥2 权威 not_found=NOT_FOUND；≥3 全一致零 error 才 probable fabrication。逐条文件持久化 + 指纹跳过。live：真实论文 VERIFIED / 虚构文献 not_found / S2 429 优雅降级 |
| M4.3.5 Semantic Verification | ✅ | judge 链路 atomic claim × citation group（v4，2026-09-09）：句子→原子论断拆解（模型批量+确定性兜底+版本化缓存）→ 论断绑定邻近引用组 → 组证据合并→LLM→verdict；组内文献共同支撑（不再 sentence×每篇 笛卡尔积）；真实性未确立组员排除（Layer 1 单独报）；无摘要→INSUFFICIENT_EVIDENCE 确定性短路（零模型调用，含拆解层）；**judge 伪造引文剥离**（keyQuote 必须逐字来自证据；CONTRADICTED 引不出逐字引文→降级 INSUFFICIENT）；UNSUPPORTED 需证据相关且具体；INSUFFICIENT=无法判断≠论文问题（info 不进 Finding）；severity 确定性派生；Citation Integrity 4 硬规则并入 QualityGate（INSUFFICIENT_EVIDENCE 不阻断只标人工复核）；citation 角色（scope citation/*）；模型调用/拆解/上下文规模 telemetry；记录带 semanticVersion（旧版本=过期缓存不读出） |
| M4.3.6 Skill Registry | ✅ | `SkillRegistry`（仓库内审计 seed → `<runtimeRoot>/skills/installed`，contentHash 幂等、变化标 stale；LICENSE/PROVENANCE 随附）；seeds：**verify-citations**（Agents4Academia-AI/citation_verification, MIT, pin `ae85ae3` 原件 verbatim）+ **paper-search**（openags/paper-search-mcp, MIT, pin `234678a`，PaperTeam 兼容 wrapper + UPSTREAM_SKILL.md 原件保留）；绑定 researcher→paper-search、citation→双、reviewer→verify-citations、writer→无；Pi 注入 `DefaultResourceLoader({noSkills, additionalSkillPaths})`（用户 ~/.pi 不受影响）；`search_papers`/`lookup_paper` 受控工具（共享 resolver 缓存）；中文简介一次生成持久化（模型未配置→summary_pending 不失败） |
| M4.3.7 Minimal UI | ✅ | ProjectPage 新增 PDF / Structure 与 Citations 标签（上传/解析状态/sections 表；两层核验摘要 chips + 逐条 status/canonical/疑似捏造告警 + 分步操作）；全局 Skills 页（中文简介为主、原始描述折叠、来源@revision/license/绑定，**无未实现的 Install/Uninstall 按钮**）；全部 server state 走 TanStack Query |
| M4.3.7.5 Model Settings UI | ✅ | `Settings → Model`（/settings/model）：前端配置模型与 API Key，无需手工环境变量。后端 `ModelSettingsService` + `/api/settings/model` 路由组（GET 状态/PUT 保存/DELETE key/GET options/POST test）；存储完全复用 Pi 官方能力——偏好 `<runtimeRoot>/settings/model.json`（原子写，非敏感），Key 经 `ModelRuntime.login/logout` 落 `agentDir/auth.json`（不自建第二套 credential，无 deep import）；优先级 env（PAPERTEAM_PI_*）> stored，env 覆盖时 UI 明示且 savedModel 如实展示；`reconfigure()` 只影响新 Agent Run（在途 run>0 → 409 MODEL_CONFIG_BUSY，前置检查先于落盘）；Test Connection 走 `completeSimple` 最小真实调用（可携带未保存 Key 覆盖式注入，失败六分类+脱敏）；**Key 只进不出**：任何 GET 无 key 字段、日志零请求体、sentinel 回归测试覆盖；重启持久化（启动装配 resolveStartupModelSpec：env 缺省时 stored 自动生效，smoke 实证） |
| Visual Redesign + UX/中文一致性 Polish | ✅ | Design Tokens + 深墨侧栏/纸白内容 + 统一状态注册表（2026-09-06）；UX Polish：全站中文优先（导航/表单/状态/错误码集中映射 `formatApiError`）、模型设置改**模型搜索选择器**（筛选/键盘/截断渲染，displayName 主视觉 + modelId 次要）、**modelId 含斜杠 bug 修复**（`parseModelSpec` 接受 openrouter `anthropic/claude-sonnet-4` 形态，DTO 显式 provider+modelId，前端不再 split 猜测，前后端回归测试）、Tab 状态进 URL（?tab=，无效回退概览）、未开放模块退出一级导航、Existing Paper 创建后直达 PDF 上传、侧栏保持完整宽度（修复窄窗口导航空白）、Design Token 收口（页面级 hex 全部入 token） |
| M4.3.8 用户论文 E2E | ✅ 2026-09-07 | 用户真实论文（26 页中文，36 节 / 25 条参考文献）从产品入口导入 → 快速 Review 全链路完成，见「Project Hardening & Real Paper E2E」节 |

外部选型结论：**pymupdf adopt**（本机已有 1.28.2；pymupdf4llm 评估后不作为核心依赖——markdown re-flow 破坏 chunk↔原文对应）；**GROBID defer**（callout↔reference 关联有价值但 Java21/Docker 部署超出本轮，`ScholarlyStructureParser` seam 未建、待 M4.3.8/M5 评估）；**RefWarden adopt+借鉴**（(claim,citation) 模型/never-from-memory/确定性 severity）；**paper-search 借鉴 provider 设计 + wrapper 收录**（不自建多平台搜索框架、不引入其 Python MCP server）。

## M4.0-M4.2 — React Web Workbench（✅ 完成，2026-09-04）

| 项 | 状态 | 说明 |
|---|---|---|
| M4.0 API Contract | ✅ 完成 | 新增 `docs/API_CONTRACT.md`（端点清单 / DTO / SSE 载荷 / 变更纪律）；审计确认 Backend 已有全部 Project/Workflow/Run/SSE/Evidence/Review/Import 端点，唯一缺口 `GET /api/projects` 已补（`ProjectStore.listMetadata()`，updatedAt 降序，损坏 project.json 跳过）；DTO 边界：Pi AgentSession / Pi event / AgentRunHandle / WorkflowState 全量不进前端 |
| M4.1 Frontend Skeleton | ✅ 完成 | `frontend/` 独立 npm 包：React 19.2 / TS 5.9（strict）/ Vite 7 / react-router-dom 7.18 / @tanstack/react-query 5.102 / zustand 5.0；目录 `api/ components/ pages/ router/ stores/ hooks/ types/ constants/ utils/ styles/`；统一 API Client（ApiError：status/code/NETWORK_ERROR 收敛，404 判定）；Server State 全走 TanStack Query（retry 仅 5xx/网络错误），UI State 走 Zustand（唯一状态：模型未配置横幅 dismiss）；路由 `/`→redirect、`/projects`、`/projects/new`、`/projects/:projectId`、`*`→404；顶栏 RuntimeStatusChip（30s 轮询，Pi schema）+ 模型未配置横幅 |
| M4.2 Project Workbench | ✅ 完成 | ProjectsPage（列表/空态/错误重试/真实字段卡片）；NewProjectPage（Idea-to-Paper 全字段表单 + 双模式选择；校验镜像 Backend 长度上限；Existing-Paper 显示「导入 API 已开放、上传 UI 后续提供」如实提示）；ProjectPage（研究定位真实字段 + WorkflowRun 记录表 + Workflow/Evidence/Review/Artifacts 导航入口标注 M4.3-M4.7，无 mock 数据）；loading/empty/error/not found/form validation/retry/响应式齐备 |
| Dev 双进程 | ✅ 完成 | `scripts/dev.mjs`：backend 依赖/构建检查 + frontend 依赖检查 → 同时 spawn `backend/dist/index.js`（[backend] 前缀）与 Vite（[vite] 前缀）；任一子进程退出 → taskkill 进程树联动退出；Windows 实测 vite 被杀 → backend 联动 → 3000/5173 全释放；根脚本 `build/typecheck/test` 覆盖前后端 |
| 测试 | ✅ 通过 | Backend 234/234（新增 4：GET /api/projects ×3 + listMetadata 排序）；Frontend 24/24（apiClient 6 / projectsApi 4 / ProjectsPage 5 / NewProjectPage 4 / routing 5；Vitest 3 + RTL，`globals: false` 下显式 cleanup）；前端 `tsc --noEmit` 与 production build 通过 |

## M4.2.5 — Live Model Integration Gate（✅ PASS，2026-09-05）

验证型里程碑（无代码改动）。真实 Provider `zai-coding-cn/glm-5.3`（Pi 0.84.4 in-process，`model.phase=configured`）经**运行中 Backend 的公开 HTTP API** 完成 L3 全链路验证。四项验证：

| 项 | 结果 | 说明 |
|---|---|---|
| 单 Agent live smoke | ✅ | `POST /api/projects/:id/generate`（Writer 真实 GLM 调用 10.3s，`manuscript/main.tex` 落盘 1657 字符，内容切题非模板；LaTeX 编译因本机无 TeX 工具 graceful 降级） |
| live 事件流 | ✅ | SSE `GET /api/runs/:runId/events`：replay 边界清晰（`: replay 完成` 注释），此后 4 条 **LIVE** 域事件按 seq 递增实时到达（research.idea 完成 +248s、feasibility 完成 +348s、awaiting_input +348s），stageId 归属正确 |
| Workflow E2E 至首个 HITL | ✅ | run `w-93366adfc650`（项目 `p-b76342cc5b69`）：research.idea（真实 GLM 248s，6 gaps / 21 bibliography / 12 evidence）→ research.feasibility（100s，level=LOW）→ `hitl.feasibility_confirm` **awaiting_input**；checkpoint/events.jsonl/stage 记录/research/feasibility 产物全落盘；activeRuns 归零、managedSessions=3 |
| 真实 cancel | ✅ | run `w-5386755ccb0c`（项目 `p-1131d9dd8cad`）：research.idea 真实生成中（activeRuns=1）POST cancel → 边界语义（在途 LLM 跑完提交结果，循环检查点终结）→ `workflow.cancelled`，终态 cancelled；同项目 run `w-43719502d7c0` 在**复用的同一 research 会话**上新 taskId 完成 research（58s）→ cancel 后会话可复用；全程 runtime healthy |

验证边界（如实记录）：AgentEvent 级（message_update 增量）事件与 AgentRuntime 级 mid-stream `session.abort()` 对真实 Provider 的直接观测，因凭据仅存在于运行中 Backend 进程（`PAPERTEAM_PI_API_KEY` → `setRuntimeApiKey` 仅内存，不落盘；子进程脚本 `modelStatus=not_configured`，符合设计）而无公开观测面——前者经 M3.8 L2（真实 SDK + fauxProvider 假流）覆盖同一映射代码，后者以 Workflow 边界 cancel + runAgent 幂等语义间接验证。凭据安全：Key 未落盘/未入日志/未入库（工作区产物 0 命中；`.env.example` 仅占位符）；Pi 全程 in-process（无 Gateway 进程、无 18789/18790 端口）；回归 build/typecheck/test 全绿（234+24）。测试项目保留：`p-b76342cc5b69`（M4.2.5 Live Model E2E，停于 HITL，可作 M4.3 实时 Workflow UI 演示）、`p-1131d9dd8cad`（M4.2.5 Live Cancel Test，cancelled ×2）。

## M3 — 两条一级业务工作流（✅ 完成）

M3 交付两条一级业务工作流（真实编排引擎 + 真实业务服务，测试中以脚本化 Agent Runtime 全链路验证）：

- **Idea-to-Paper**：调研 → 可行性评估（HITL approve/adjust）→ 大纲（HITL approve/revise）→ 分节写作 → 引用核验 → 三路审稿 → Quality Gate →（bounded 修订 ≤2 轮 + 超限 HITL）→ Build Gate → Final（双 Gate 通过）/ Draft。
- **Existing-LaTeX Improvement**：导入（防 Zip Slip）→ 结构解析 → Baseline Compile → 论文理解 → 引用审计 → 审稿 → 目标评估 → 改进计划（HITL）→ 逐节改造 →（共享审稿/修订/构建后段）。

## M3.8 — Pi Runtime Migration & Runtime Contract v2（✅ 完成，2026-09-04）

| 项 | 状态 | 说明 |
|---|---|---|
| Pi 成为唯一 Runtime | ✅ 完成 | 删除 `PAPERTEAM_AGENT_RUNTIME` selector 与 openclaw 装配分支；index.ts 直接构造 `PiRuntimeAdapter`；业务层仍只面向 `AgentRuntime` 契约（Pi SDK import 限制在 Runtime 层） |
| OpenClaw 基础设施移除 | ✅ 完成 | 删除 `OpenClawRuntimeAdapter`、`runtime/openclaw/gatewayClient`、`backend/src/dev/` 全目录（cli / gatewayHealth / openclawState / runtimeConfig / runtimePaths / supervisor）、Gateway health / handshake / RPC / token / port / runtime.json 全部逻辑；`npm ls openclaw`、`npm ls @openclaw/gateway-client`、`npm ls @openclaw/gateway-protocol` 根与 backend 均为空；用户磁盘上的旧 `~/.paperteam/runtime/openclaw/` state 无害忽略（不主动删除） |
| AgentRuntime Contract v2 | ✅ 完成 | `startAgent(input)` → `AgentRunHandle{taskId, sessionKey, events(), cancel(), result()}`：taskId 在执行开始时立即可得（排队不阻塞句柄返回）；`events()` replay+live、settle 后自然结束、多订阅独立、break 清理订阅；`cancel()` 幂等（queued 标记短路 / running 真实 abort）；`result()` Promise 缓存可重复 await；`close()` 收敛全部 active run 并 dispose 会话。`runAgent()` 保留为 start + await result 的 convenience（业务层 9 处调用点零改动）。v1 的 `cancelTask` / `streamEvents` / `sendMessage` 从契约移除（`getTask` 保留查询已完结任务） |
| 事件流正式接通 | ✅ 完成 | Pi `session.subscribe()` 事件映射为 PaperTeam `AgentEvent`（agent_start / message_start / message_update / message_end / tool_execution_start / update / end / agent_end / agent_settled / turn_start / turn_end）；原始 Pi 事件对象不透传业务层；L2 实证运行中消费（不等任务结束） |
| 取消正式接通 | ✅ 完成 | normal generation 取消（M3.7 实证保持）；**tool execution 取消（M3.8 新增实证）**：customTools 注入可控慢工具 → 执行中 cancel → SDK AbortSignal 真实传导 → 工具停止 → 任务 settle cancelled。工具中 abort 的 SDK 终态实测为 `stopReason="error" + "This operation was aborted"`（LLM 流中断才是 `"aborted"`），Adapter 以取消意图（cancelRequested）归因，不依赖 SDK 编码差异。cancel 已完成/已取消任务幂等 no-op；cancel 后同 session 可继续使用；compaction abort 仍为上游边界（auto-compaction 已禁用、manual compact 未使用） |
| dev 启动链简化 | ✅ 完成 | `npm run dev` → `scripts/dev.mjs`（Node 检查 → backend 依赖检查 → 构建）→ 直启 `backend/dist/index.js`（Pi SDK in-process）。不再安装 OpenClaw / 生成 Gateway state / 寻找端口 / spawn Gateway / 等待 health / 监督子进程 |
| RuntimeStatus 去 Gateway 化 | ✅ 完成 | `GET /api/runtime/status` 新形状：`runtime{provider, phase, version, detail, latencyMs}`（Pi 0.84.4）+ `model{phase, model?, providers, detail}` + `agents{roles}` + `sessions{activeRuns, managedSessions}`；gateway / gatewayRuntimeVersion / gatewayClientSdk / protocolVersion / not_applicable 占位全部删除。healthCheck 语义统一：Runtime 健康（SDK 可加载 / 未关闭 / 初始化正常）≠ 模型就绪（not_configured 单独报告） |
| Model / Auth 收口 | ✅ 完成 | `PAPERTEAM_PI_MODEL` / `PAPERTEAM_PI_API_KEY`（env override，不进日志）/ `agentDir`（默认 `<PAPERTEAM_RUNTIME_ROOT>/runtime/pi/agent`，与 `~/.pi` 隔离）/ `PAPERTEAM_PI_RUN_TIMEOUT_MS`；Key 不硬编码、不落日志；模型未配置 → 结构化失败 + `model.not_configured`；**M4.3.7.5 起前端 Settings UI 同级配置**（env > stored 优先级；Key 复用 Pi auth.json，见 M4.3.7.5 行） |
| 会话隔离回归 | ✅ 完成 | projectId × agentId × contextScope sessionKey 派生保持稳定（纯函数测试 + PiRuntimeAdapter L1 全链路测试）；同 logical session 复用、不同 project / 角色 / reviewer 三 scope 互不串、三路并发、取消一路不影响其它两路 |
| 测试迁移 | ✅ 完成 | 删除 OpenClaw 架构专属测试（OpenClawRuntimeAdapter / runAgent mock-Gateway 集成 / bootstrap / supervisor / versionPins / mockGateway fixture）；业务测试的 fake runtime 全部迁到 v2 接口；PiRuntimeAdapter 测试升级 v2（startAgent 句柄 / 运行中事件 / cancel 幂等 / 排队取消 / result 缓存 / close 收敛 / tool abort 专项） |
| 回归 | ✅ 通过 | `npm run build` / `npm run typecheck` / `npm test` **230/230**（OpenClaw 专属测试移除后总数下降，评价标准为覆盖真实架构）；M3 全量 Workflow 业务测试零回归 |

## M3.7 — Pi Runtime Feasibility & Adapter Spike（✅ 完成，2026-09-04）

Side-by-side 可行性验证：不改变默认 Runtime（当时为 openclaw），新增 Pi 候选实现并用真实代码 + 测试回答「PaperTeam 直接嵌入 Pi SDK 是否比经 OpenClaw Gateway 更合适」。

| 项 | 状态 | 说明 |
|---|---|---|
| PiRuntimeAdapter | ✅ 完成 | 官方 `createAgentSession()` in-process 嵌入（无子进程 / RPC / Gateway）；会话 = `SessionManager.inMemory(cwd)`（Runtime session 可丢弃，Workspace/checkpoint 是事实源）；sessionKey 派生与 OpenClaw 完全一致（`runtime/sessionKey.ts` 共享，GenerationService 显式透传兼容）；per-session 串行 + 跨 session 并发（创建 in-flight 去重）；timeout = 定时器 + `session.abort()`；auto-compaction 经 in-memory settings 关闭 |
| 角色 → Pi 配置映射 | ✅ 完成 | contextScope 前缀 → researcher/writer/reviewer/default：`systemPromptOverride` + 工具白名单（researcher/reviewer 只读，writer 可写文件，无人持有 shell）；systemPrompt 到达 LLM 上下文有 L2 测试实证 |
| 验证分层 | ✅ L1+L2 / **L3 verified（2026-09-05）** | L1 fake session 纯单元 + L2 真实 SDK + 官方 `fauxProvider` 假流：初始化 / 健康 / runAgent 成败 / timeout / 事件顺序与归属 / **abort（LLM 流中取消 → cancelled，会话可复用）** / session 复用 / project·contextScope 隔离 / **Reviewer 三路并发（独立会话、输出不串）** / close·dispose；L3 真实 provider LLM 于 M4.2.5 经运行中 Backend + `zai-coding-cn/glm-5.3` 验证（见 M4.2.5 节） |
| Windows 生命周期 | ✅ 实测 | pi 模式 Backend：零子进程、不占 Gateway 端口（18790）、kill 后无孤儿、端口释放；OpenClaw 基线 `npm run dev` 同日复验正常（Gateway 7.6s ready、health 200、优雅关闭） |
| 回归 | ✅ 通过 | `npm run build` / `npm run typecheck` / `npm test` 280/280（零回归）；顺带修复全量并发下偶发的 orchestrator cancel/awaiting_input 竞态（独立 commit） |
| 结论 | **MIGRATE TO PI（建议）** | P0 验证项全部通过；正式迁移由 **M3.8 执行完毕**（本表为历史记录） |

## M3.6 — Runtime Baseline Upgrade（✅ 完成，2026-09-04）

| 项 | 状态 | 说明 |
|---|---|---|
| OpenClaw 2026.8.2 → 2026.9.1 | ✅ 完成 | openclaw = `@openclaw/gateway-client` = `@openclaw/gateway-protocol` = **2026.9.1**（三处统一精确 pin，protocol v4 不变）；lockfile 更新；版本锚点测试防漂移。**（历史基线；M3.8 起 OpenClaw 不再参与运行，三处依赖已移除）** |
| SDK / Protocol 兼容性 | ✅ 无需适配 | 静态核对 + 编译 + 真机验证：`PROTOCOL_VERSION=4` 不变；RPC `agent`（两段式验收）/ `agent.wait` / `chat.history` 行为不变；未发现影响 PaperTeam 的 breaking change |
| Node Runtime 兼容 | ✅ 完成 | `scripts/dev.mjs` 改为复用根 package.json `engines.node` 作为唯一事实源（微型解析器，不新增依赖），Node 26+ 可用 |
| runtime.json 存量升级迁移 | ✅ 完成 | 旧 `openclawVersion` 自动迁移到当前 pin（端口 / token 保留）；单测 + 真机 E2E 双验证。**（M3.8 起 runtime.json 机制随 Bootstrap 移除；用户磁盘旧文件无害忽略）** |
| 回归 | ✅ 通过 | `npm test` 255 通过；真机 `npm run dev`：Gateway 约 6s 就绪、health 200、Backend 3000 监听、进程树唯一、优雅关闭级联无孤儿、端口全部释放 |

## M3.5 — Runtime Bootstrap / M3 Closure（✅ 完成）

| 项 | 状态 | 说明 |
|---|---|---|
| Runtime Bootstrap | ✅ 完成 | 仓库根 `npm run dev`：Node 版本检查 → 依赖自动安装 → 构建 → 准备独立 state → 启动 Gateway → 等 /health 就绪 → 启动 Backend → Ctrl+C 优雅关闭。**（M3.8 起该链路简化为直启 Backend，见 M3.8 表）** |
| 独立 OpenClaw state | ✅ 完成 | state 在用户级 `~/.paperteam/runtime/openclaw/`；路径解析硬校验与全局 `~/.openclaw` 不相等/不嵌套（D-0018） |
| Agent 映射（方案 A） | ✅ 完成 | Researcher/Writer/Reviewer/Citation 默认全部映射默认 agent `main`，会话隔离靠 contextScope（D-0016/D-0018）；映射在 config 层（env 可覆盖）。**（M3.8 起语义保留：会话标识默认 main，仅作 sessionKey 组成段）** |
| Runtime 诊断 | ✅ 完成 | `GET /api/runtime/status`（gateway/runtime/agents/model 分区）。**（M3.8 去 Gateway 化，形状见 M3.8 表）** |
| 优雅关闭 | ✅ 完成 | Ctrl+C：Backend 先停（编排器取消活跃 run、checkpoint 落盘、断开 SSE）→ Gateway 后停；Windows 真实控制台 Ctrl+C E2E 验证（无孤儿、端口释放） |
| 模型凭据边界 | ✅ 完成 | Bootstrap 不搬运/复用任何其他项目凭据；用户把 provider API Key 写入独立 state。**（M3.8 起：`PAPERTEAM_PI_API_KEY` / agentDir auth.json / 标准环境变量）** |

## M3.5 真实环境验证（本机 dev smoke + E2E）

以下为 2026-09-03 在全新机器（未装全局 OpenClaw、无 TeX、无模型凭据）上的真实运行结果（OpenClaw 基线，历史记录）：

1. **`npm run dev` 三次真实启动**：首次自动初始化 `~/.paperteam` state → Gateway 18790 健康（首次约 3s ready）→ Backend 3000 监听 → `GET /health` ok。
2. **`GET /api/runtime/status` 真实输出**：`gateway: healthy`、`runtime: model_not_configured`、四个角色映射 `main` 全部 `configured`、`model: not_configured`。
3. **真实 Idea-to-Paper E2E（无模型凭据路径）**：run 真实推进到 `research.idea` → 经真实 Gateway RPC 返回网关权威错误 → Stage transient 重试 2/2 → failed 终态（`AGENT_RUN_FAILED`）；SSE replay 正常。
4. **Ctrl+C E2E（Windows 真实控制台事件）**：Backend/Gateway/cli 依次优雅退出、端口全部释放、无残留进程。
5. **未真实验证的内容**（如实记录）：带真实模型凭据的完整 Idea-to-Paper 全链路；TeX 真实编译（本机无 pdflatex/xelatex/latexmk）；多模态 PDF 分析。

## M3.0 — Workflow Foundation（✅ 完成）

| 项 | 状态 | 说明 |
|---|---|---|
| WorkflowOrchestrator | ✅ 完成 | 确定性 TS 引擎（非 Agent）：stage 推进、retry（按失败分类）、timeout、checkpoint/resume、HITL、协作式取消（AbortSignal 传播）、DoD 硬校验、bounded loop（由 plan() 纯函数表达，可从 checkpoint 重放） |
| WorkflowRun 异步 API | ✅ 完成 | `POST /api/projects/:id/workflows` → 202 `{runId}`；`GET /api/runs/:runId`；`GET /api/runs?projectId=`；`POST /resume`、`POST /cancel`；同一项目存在进行中 run 时拒绝新建（409） |
| StageContract | ✅ 完成 | `StageSpec`：id / requiredInputs / producedOutputs / maxAttempts / timeoutMs / retryable 失败分类 / execute / verifyDod（DoD）。Agent 返回文本 ≠ 成功：产出必须通过 DoD |
| checkpoint 持久化 | ✅ 完成 | `projects/<id>/workflow/runs/<runId>/{checkpoint.json,events.jsonl,stages/}`；checkpoint 原子写（tmp → fsync → rename）；终态「先持久化、后提交内存」 |
| 进程重启恢复 | ✅ 完成 | `recoverInterruptedRuns()`：running/pending 从 checkpoint 重启（已成功 stage 不重复执行）；awaiting_input 保持等待可 resume；事件 seq 与磁盘日志对齐 |
| Domain Event | ✅ 完成 | events.jsonl（追加写、损坏行容忍）；`workflow.*`、`stage.*`、`quality_gate.*`、`build_gate.*`；不含 sessionKey/token/内部事件 |
| SSE | ✅ 完成 | `GET /api/runs/:runId/events`：先订阅后 replay（seq 去重）保证不重不漏；15s 心跳；断开只清理连接 |
| HITL awaiting_input | ✅ 完成 | 通用机制：进入待办 → resume 校验 decision → `onInput` 返回 `"cancel"` 可直接取消 run |
| contextScope | ✅ 完成 | `RunAgentInput.contextScope`；sessionKey 派生 `agent:{agentId}:paperteam-{projectId}--{scope}`；scope 归一化；M2.1 无 scope 行为保持（回归测试） |
| 旧 generate API | ✅ 保留 | M2 同步端点与响应契约不变（标 deprecated） |

## M3.1 — Research & Evidence（✅ 完成）

| 项 | 状态 | 说明 |
|---|---|---|
| 项目研究定位字段 | ✅ 完成 | `workflowKind / researchIdea / researchField / documentType / targetProfile / targetVenue / language`；创建携带、`PATCH /api/projects/:id` 更新；旧版 project.json 向后兼容 |
| Researcher | ✅ 完成 | Idea Research 结构化输出校验后落盘 `research/research.json`；候选 Evidence 以 unverified 进入 EvidenceStore；候选 bibliography 去重 |
| Target Feasibility | ✅ 完成 | HIGH/MEDIUM/LOW/INSUFFICIENT 离散结论；LOW/INSUFFICIENT 必须给出差距；HITL adjust 更新目标后重评估（≤3 次） |
| EvidenceStore | ✅ 完成 | 项目级 `evidence/evidence.jsonl`：append/get/list/query/updateVerification/markUsage/stats；损坏行容忍；项目隔离 |
| Citation 静态核验 | ✅ 完成 | `\cite` 族 ↔ references.bib：missing/unused/duplicate/bad；零依赖 |
| Citation metadata 核验 | ✅ 完成 | Provider 抽象 + CrossRef/OpenAlex/arXiv：404 → not_found、网络故障 → unverifiable（绝不因网络判 not_found）；开关与上限可配 |
| Reference PDF 接入 | ✅ 完成 | SourceStore：上传（base64，20MB 上限）、sourceRole、preferred、删除；原始文件与解析产物隔离 |
| PDF 分析 | ✅ 完成（文本层）| `BuiltinPdfAnalyzer`：零依赖文本/结构层；extractionQuality 如实分级 |
| 多模态扩展点 | ✅ 接口就绪 / ⏳ 受环境约束 | `MultimodalAnalyzer` 接口 + `AgentMultimodalAnalyzer`（本地路径交 Runtime 侧 pdf 能力）；能力不可用返回明确 capability-gap，不伪造成功 |
| Section-based 手稿 | ✅ 完成 | outline.json（≥3 节校验）；章节正文片段校验；`main.tex` 由确定性代码组装（不交给 LLM）；references.bib 确定性生成 |
| Derived Context | ✅ 完成 | `context.yaml` 可随时删除重建；`GET /context?rebuild=true` |

## M3.2 — Review & Revision（✅ 完成）

| 项 | 状态 | 说明 |
|---|---|---|
| Reviewer | ✅ 完成 | 单 Agent 三 skill：fact / academic / style；统一 ReviewIssue |
| contextScope 隔离 | ✅ 完成 | review/fact、review/academic、review/style 三个独立会话 |
| 并行 fan-out | ✅ 完成 | `Promise.all` 三路并行；无 dangling 连接/定时器 |
| Review aggregation | ✅ 完成 | 确定性聚合；无 LLM 参与聚合 |
| bounded revision loop | ✅ 完成 | 默认最多 2 轮自动修订；引用核验问题进入修订指令；超限 → HITL |
| Build Gate | ✅ 完成 | 编译结果 + include + bib 可用；只判「能否构建」（D-0015） |
| Quality Gate | ✅ 完成 | 9 条确定性规则；报告落盘 + 事件 |
| Draft/Final 规则 | ✅ 完成 | Draft = Build Gate 通过；Final = 双 Gate 通过 |
| Existing-LaTeX 导入 | ✅ 完成 MVP | 零依赖 ZIP 读取器（防 Zip Slip）；结构识别；原始快照；Baseline Compile best-effort |
| Existing-Paper workflow | ✅ 完成 | 导入校验 → baseline → 论文理解 → 引用审计 → 审稿 → 目标评估 → 改进计划 → HITL → 逐节改造 → 共享后段 |

## M3 API 一览（实际实现）

> Workflow API（`POST /api/projects/:id/workflows` + `/api/runs/*`）是**主入口**；
> 下列 review / citation-check / build / quality-gate 等细粒度端点是调试 / 手动操作 /
> 工具 API，前端（M4）不自行串联它们——编排由 WorkflowOrchestrator 在后端完成。

```text
GET    /health                                    存活探针（含 Pi Runtime 实时健康）
GET    /api/runtime/status                        Runtime 诊断（runtime/agents/model/sessions，Pi schema）
POST   /api/projects                              创建项目 {title, workflowKind?, researchIdea?, …}
GET    /api/projects/:id                          项目元数据
PATCH  /api/projects/:id                          更新研究定位字段
POST   /api/projects/:id/generate                 M2 同步写作+编译（deprecated，保留兼容）
POST   /api/projects/:id/workflows                创建异步 WorkflowRun {kind, prompt?} → 202 {runId}
GET    /api/runs?projectId=xxx                    run 列表
GET    /api/runs/:runId                           run 状态 / 待办 / 错误
GET    /api/runs/:runId/events                    SSE（replay + 实时 Domain Event）
POST   /api/runs/:runId/resume                    HITL 输入 {decision, payload?}
POST   /api/runs/:runId/cancel                    取消
POST   /api/projects/:id/import                   导入 LaTeX 项目（archiveBase64 | files）
GET    /api/projects/:id/import                   最近导入报告
POST   /api/projects/:id/sources                  上传文献 {fileName, contentBase64, sourceRole?…}
GET    /api/projects/:id/sources                  文献列表
GET|PATCH|DELETE /api/projects/:id/sources/:sid   详情 / 角色 / 删除
POST   /api/projects/:id/sources/:sid/analyze     PDF 分析 {mode: builtin|multimodal}
GET|POST /api/projects/:id/evidence               Evidence 列表（查询参数）/ 手工添加
POST   /api/projects/:id/evidence/:eid/verify     更新核验状态
GET    /api/projects/:id/feasibility              最近可行性报告
POST   /api/projects/:id/citation-check           引用核验（静态 + metadata）
GET    /api/projects/:id/citation-report          最近引用报告
POST   /api/projects/:id/review                   独立全面审稿（三路并行 + 聚合）
GET    /api/projects/:id/reviews                  审稿汇总列表
POST   /api/projects/:id/quality-gate             Quality Gate 评估（基于最新 artifacts）
GET    /api/projects/:id/quality-gate?round=N     gate 轮次读取：rounds 列表 + 指定轮 gate + 同轮 reviewSummary + stale（M4.6）
POST   /api/projects/:id/build                    Build Gate + Draft PDF
GET    /api/projects/:id/manuscript               大纲 + 章节状态
GET    /api/projects/:id/context?rebuild=true     Derived Context
POST   /api/projects/:id/paper/pdf                上传 Final PDF + 解析（M4.3）
GET    /api/projects/:id/paper                    PDF 状态 + sections + stages（M4.3）
POST   /api/projects/:id/paper/reparse            重跑解析（M4.3）
GET    /api/projects/:id/paper/chunks?sectionId=  chunk 明细（M4.3）
GET|POST /api/projects/:id/paper/map              PaperMap 读/重建（M4.3）
GET    /api/projects/:id/paper/review-context     section review 上下文预览（M4.3）
POST   /api/projects/:id/citations/extract        引用提取（确定性，M4.3）
GET    /api/projects/:id/citations                提取摘要 + references（M4.3）
POST   /api/projects/:id/citations/verify-metadata 真实性核验（外部学术库，M4.3）
GET    /api/projects/:id/citations/metadata       逐条核验记录（M4.3）
POST   /api/projects/:id/citations/verify-claims  (claim,citation) 语义核验（M4.3）
GET    /api/projects/:id/citations/claims         语义核验记录（M4.3）
GET    /api/projects/:id/citations/integrity      完整性汇总 + gate 输入（M4.3）
POST   /api/projects/import-pdf                   已有论文 File-First 导入（2026-09-07）
GET    /api/projects?scope=archived|all            归档/全量列表（默认 active，2026-09-07）
POST   /api/projects/:id/archive|restore           归档 / 恢复（2026-09-07）
DELETE /api/projects/:id                           永久删除（仅已归档；2026-09-07）
PATCH  /api/projects/:id                           研究定位 + title 重命名（2026-09-07）
GET    /api/projects/:id/paper-review              快速 Review 聚合报告（2026-09-07）
GET    /api/skills                                Skill 列表 + 绑定（M4.3）
GET    /api/skills/:id                            Skill 详情（M4.3）
POST   /api/skills/:id/summary                    重新生成中文简介（M4.3）
```

## 测试与验证

- **当前（2026-09-10，M4.8）：Backend 565 passed（+7 个默认跳过的 live smoke）+ Frontend 161 + 浏览器级 E2E（Playwright，`e2e/`，需运行中的 dev 栈）**：默认栈 smoke 7 / visual 全通过；无模型栈 workflow 4+1skip（D 模型未配置失败路径 + E 模型门控）；scripted 栈 hitl 7 / evidence-gate 7（需 `PAPERTEAM_TEST_RUNTIME_REVIEW=fail,pass` 驱动两轮 gate）/ paper-artifacts 10（本机真实 MiKTeX）/ **version 7（M4.8，`PAPERTEAM_E2E_VERSION=1`）/ improvement 2（M4.8，`PAPERTEAM_E2E_IMPROVEMENT=1`）全部通过**。
- 历史基线（M4.3）：**Backend 285 + Frontend 34 个测试全部通过**（vitest；backend 29 个测试文件 + 1 个默认跳过的 live smoke（`PAPERTEAM_LIVE_SMOKE=1` 显式启用，真实公网）；frontend 6 个测试文件。M4.3 新增 51 个 backend 测试：domain model 9 / PDF 真实 PDF e2e 8 / context builder 7 / 引用提取 4 / scholarly 10 + live 4 / 语义核验 4 / skill registry 9；frontend 新增 10：skills/pdf/citations 视图）。构成：M1/M2 业务与 Project/LaTeX/HTTP、M3 Workflow / Evidence / Review / Revision / HITL / Quality Gate / Domain Event / SSE / checkpoint、M3.8 Runtime 层（PiRuntimeAdapter L1 fake session 纯单元 + L2 真实 SDK × 官方 fauxProvider、contextScope 派生、RuntimeStatus Pi 形状、config Pi 块）、M4.0 Project List API。
  M3.8 新增/强化覆盖——Contract v2（`startAgent` 立即返回句柄、运行中 `events()` 消费 replay+live+settle 终止、多订阅独立、`cancel()` 幂等含已完成/已取消、排队任务取消不误伤同会话前序 run、`result()` Promise 缓存、timeout 路径 reject 一致、`close()` 收敛全部在途 run 并 dispose、getTask 运行中/已完结语义）；**tool execution abort 专项**（真实 SDK：工具执行中 cancel → AbortSignal 传导 → 工具停止 → cancelled）；OpenClaw 架构专属测试（mock Gateway 集成 / bootstrap / supervisor / versionPins）随架构删除，业务测试全部迁到 v2 fake runtime。
- `npm run typecheck`、`npm run build` 通过（backend 与根入口均验证）；无 lint 脚本（package.json 未定义）。
- 测试策略：编排引擎与业务服务为真实实现，仅 AgentRuntime 注入脚本化 fake
  （按 contextScope 返回结构化输出）；LaTeX 编译注入 fake runner；metadata provider 注入 fake fetch。

## 非阻塞环境验证项（Non-blocking Validation Gaps）

以下为**环境验证缺口，不是设计决策，不阻塞代码交付**：

1. **带真实模型凭据的完整 Idea-to-Paper E2E**：M3.7/M3.8 已用真实 Pi SDK + 官方 fauxProvider 验证全部 Runtime 语义（初始化 / 单轮 / 事件 / 取消 / 工具取消 / 并发 / 隔离）；**L3 Live Provider E2E 已于 M4.2.5（2026-09-05）verified**——真实 `zai-coding-cn/glm-5.3` 经运行中 Backend 验证单 Agent / SSE / Workflow 至首个 HITL / cancel（见 M4.2.5 节）。**M4.5（2026-09-09）已用真实模型验证 HITL 决策链**：真实推进至 feasibility awaiting → Backend 重启恢复 → resume approve → outline 重规划 → cancel。HITL resume 之后的完整论文链（写作 → 审稿 → 修订 → PDF）仍未跑真实模型（有意节省额度，按需）。
2. **TeX Live 真实编译**：本机未安装 pdflatex/xelatex/latexmk；LatexCompiler 与 Build Gate 的编译路径经注入式 runner 覆盖，真实 PDF 编译待有 TeX 环境的机器验证。
3. **多模态 PDF 视觉级分析 E2E**：依赖具备视觉/PDF 能力的模型与沙箱路径授权，当前环境无法真实跑通（返回 capability-gap 如实报告，不伪造成功）。
4. **Citation metadata providers 真实网络**：M4.3 已用真实 crossref/openalex/arxiv 跑通 live smoke（含 S2 429 降级、虚构文献 not_found）；长期限流形态待部署环境观察。
5. **GLM 语义核验 live**：本轮模型未配置（凭据按规范仅运行时注入），语义核验以 Fake Runtime 全场景覆盖 + 真实 backend 降级路径验证；待模型配置后做 GLM-5.3 live 语义 smoke（M4.3.8 顺带）。
6. **GROBID**：callout↔reference 精细关联与 author-year 复杂版式的增强通道，部署成本（Java 21/Docker）超出本轮；M4.3.8/M5 评估（见 DECISIONS）。

## M3 遗留问题（真实问题，均不阻塞验收）

1. Outline HITL 当前仍为强制节点（PRD 标记 Outline 确认为可选）；当前实现两处 HITL（feasibility/outline）都必经，计划 M4 前端 / Workflow 配置化处理。
2. EvidenceStore 的 update/markUsage 是全量原子重写（规模内可接受）；索引/数据库迁移条件仍按未决问题 2 评估。
3. 修订循环对「需要改 bib 本身」的引用问题只能删除/弱化引用，不会替用户新造文献条目（有意为之：防伪造引用）；bib 自动新增策略未实现，补文献属于 Researcher/用户输入路径。
4. Pi compaction abort 未验证（上游边界）：auto-compaction 已禁用、manual compact 未使用；若未来启用需专项验证其取消边界。
5. Workflow cancel 为边界语义（stage 服务不监听 AbortSignal，在途 LLM 调用跑完后于循环检查点终结；M4.2.5 真实验证确认）；AgentRuntime 级 mid-stream abort 对真实 Provider 的直接观测无公开 API 面（L2 已覆盖同一代码路径）。
6. Windows 下若 dev 父进程被外部硬杀（非 Ctrl+C），Backend 进程可能残留（正常 Ctrl+C 已验证优雅退出）；Pi 路径无任何 Runtime 子进程，硬杀 Backend 即全部回收。

（M3.5~M3.7 时代与 OpenClaw Gateway 相关的遗留项——runAgent 每次连接、Windows Gateway 硬杀孤儿、Gateway 版本 RPC、Bootstrap/生命周期——已随 M3.8 迁移消失，从本清单移除。）

## 未决设计问题

1. documentType / targetProfile 建议值集合的前端呈现（存储层保持自由字符串，不冻结）。
2. EvidenceStore 索引与 SQLite 迁移条件（同前）。
3. M4+ 前端技术栈、Docker/compose、TeX Live 镜像体积控制。

## Project Hardening & Real Paper E2E（✅ 完成，2026-09-07）

全项目 Review / 加固 / 前端重设计 / 真实论文 E2E 一轮（不改产品语义、不换 Runtime、不降低引用真实性要求）：

- **PDF 导入根因修复**：真实论文导入 400「PDF 解析器输出了非法 JSON」——MuPDF C 层把 `MuPDF error: syntax error ...` 警告直接写到 fd 1，与 JSON 混在 stdout。修复：`parse_paper_pdf.py` 解析期间 `dup2(2,1)` 把 fd 1 重定向到 stderr、结果 JSON 经保留的原 stdout fd 作为最后一行输出、`mupdf_display_errors(False)`；Node 侧只取最后一行非空 JSON，错误分为 `PDF_PARSE_FAILED`(422) / `PDF_PARSER_UNAVAILABLE`(503)。新增 `pdfToolchain.ts`（python/python3/py -3 / `PAPERTEAM_PDF_PYTHON` 探测 + 缓存）、`npm run doctor`、启动自检与 `/api/runtime/status.tools.pdfParser`、前端侧栏/横幅提示。中文论文：中文标题/摘要启发、中文编号章节（"3.1 总体框架"、"第 X 章"）、GB/T 7714 与 IEEE 引号式参考文献解析、以标题块为锚的 block→section 分配（同页多章节不再整页归入首节）。
- **Review 韧性**：`review.sections` 只审有正文的章节（<80 字符的标题节记为 emptySections 跳过而非失败）；单节失败先节内退避重试（3 次，5s/20s），持续失败记 `failedSections` 继续下一节，全部失败才 stage 级重试；取消信号贯通 PaperMap 摘要 / 语义核验 / 单节审阅（在途模型调用立即 abort，不再等 stage 边界）；stage 超时改为**空闲超时**（连续 timeoutMs 无进度汇报才判超时，长论文不再被固定预算杀掉）；进度快照 `run.progress` 进 DTO，前端阶段清单实时显示"第 n / N 节、已记录 k 条发现"。
- **Backend 加固**：BusinessError 新增 `NOT_FOUND`/`PDF_*`，`toBusinessError` 不再泄漏内部异常文案；HTTP 层上传体积上限、base64 字段校验、枚举参数校验、405；ProjectStore 每项目串行 `mutate()` + 原子写；SourceStore/EvidenceStore 损坏索引显式报错、404 语义统一；Orchestrator emit 链不被单次写失败污染、超时 abort 在途 stage、同项目并发 createRun 互斥、cancel 期间 stage 抛错归为 cancelled；`writeJsonAtomic` Windows EPERM/EBUSY 重试；`tsconfig` 开启 noUnused*/noImplicitReturns。
- **前端重设计（frontend-design skill，"编辑部校对台"方向）**：archival white 纸面 + ink indigo 强调、状态色 verdigris/ochre/vermilion、页面级标题 serif、左侧数字栏（gutter）替代卡片堆叠；无阴影/渐变；正式 Dark Mode（跟随系统 / 浅色 / 深色，`paperteam.theme` localStorage，`index.html` 首帧前脚本防闪烁，token 全覆盖，设置 → 外观 + 侧栏快捷切换）；App Error Boundary（"页面出现异常"，重新加载 / 返回论文项目，dev 才显示堆栈）；错误码集中映射（MODEL_CONFIG_BUSY / PROJECT_BUSY / NOT_FOUND / AUTH_FAILED / TIMEOUT / RATE_LIMITED / PDF_PARSE_FAILED …）；全部页面 loading / empty / error 三态；行内确认替代 `window.confirm`；tabs/menu a11y（role/aria-selected/键盘）。
- **浏览器级 E2E**：`e2e/`（Playwright，channel chrome，可 `PAPERTEAM_E2E_CDP_URL` connectOverCDP 复用已开浏览器，端口经 env 配置）；`smoke.spec.ts` 16 步用户路径（导入 → 自动 Review → 真实 cancel → 引用提取 → Skills → 模型设置 → 主题切换持久化 → 归档/恢复/删除确认 → 清理自建项目）；`visual.spec.ts` 浅/深 × 1366x768 / 1440x900 / 1920x1080 / 1100w 截图 + 无水平溢出 + 深色真实生效断言。旧 `scripts/browser-qa*.mjs`（手写 CDP client）删除。
- **真实论文 E2E（用户 PDF，不入库）**：26 页、36 节（42 chunks）、25 条参考文献（25/25 解析出标题/年份/作者）、49 处正文引用 / 63 条关联全部可解析；文献真实性 22 VERIFIED / 3 NOT_FOUND / 0 疑似捏造；语义核验 63 条（上限 30 条进入 judge）：2 支持 / 1 部分支持 / 3 不支持 / 39 证据不足 / 18 跳过；分章节审阅 33 / 36 节（3 节仅标题），226 条发现（严重 0 / 主要 59 / 次要 125 / 提示 42），单次完整审阅 29.5 分钟（≈54 s/节，glm-gateway Anthropic 兼容通道）。第一次 stage 尝试因笔记本进入待机 88 分钟被固定超时杀掉——由此引入空闲超时语义。PaperMap 摘要 / 文献元数据 / 语义核验结果按指纹复用，重跑零重复模型调用。

- **模型设置增强（2026-09-07 追加）**：「模型提供商」改为搜索选择器（首字母前缀筛选；分组 已有凭据 / 自定义 / 常用 / 其他折叠）；新增**自定义提供商**（`/api/settings/model/custom-providers`，Anthropic Messages / OpenAI Chat Completions / OpenAI Responses 三种协议，Base URL / Bearer / 额外请求头 / 模型目录参数；配置存 `settings/custom-providers.json`，Key 走 auth.json，启动时 `registerProvider` 重放；删除连带凭据与偏好）。Backend +17 / Frontend +4 测试。

遗留（不阻塞）：LatexCompiler `shell:true` 下 Windows 超时 kill 只杀 shell；语义核验 30 条上限与 INSUFFICIENT_EVIDENCE 占多数（无摘要文献）；项目列表状态字段沿用 M2 的 created/generated/failed，不反映 Review 运行中/完成（需要 list DTO 扩展）；Provider 偶发 503（外部）。

## Project Entry & Lifecycle UX（✅ 完成，2026-09-07）

产品入口与生命周期收口（不是视觉重设计；Modern Research Workbench 视觉体系保留）：

- **新建项目二选一**：「从研究想法开始」/「导入已有论文」；导入已有论文 **File First**——PDF + 目标（快速 Review 推荐 / 系统性改进）即提交，无标题必填，其余定位字段折叠进「高级选项」。`POST /api/projects/import-pdf` 一次调用完成 建项目→解析→自动标题（PDF 内标题优先，不可用则文件名去扩展名兜底；不调 LLM、不要求手填）；ingest/parse 失败回滚删除项目，无半成品。
- **existing_paper_review**：独立 WorkflowKind（completion label=`review`），复用 M4.3 Foundation——`paper.ensure`（PaperMap）→ `citation.extract` → `citation.metadata` → `citation.claims` → `review.sections`（ReviewContextBuilder 受控上下文 × SectionReviewService → ReviewFinding，≤40 节）→ `review.aggregate`（`reviews/existing-review-r*.json`）；不经过旧 manuscript review 链路。模型未配置时导入仍成功，Review 页给出「配置模型后即可开始 Review」引导。
- **项目生命周期**：`archivedAt` 独立生命周期字段（与 status 正交）；`POST /archive`（运行中 run → 409 PROJECT_BUSY，不静默归档）/ `POST /restore` / `DELETE`（仅已归档，否则 409 PROJECT_NOT_ARCHIVED；删除整个工作区 + `PiRuntimeAdapter.releaseProjectSessions` 释放项目会话；设置页输入完整标题确认）。默认列表与最近项目只显示未归档（`?scope=archived|all`）。
- **导航与 Settings**：PaperTeam 品牌即返回论文项目的主页入口（删 Research Workbench）；Settings 二级导航（模型设置 / 项目管理）；项目行重构为 row container + 主内容 Link + 「···」菜单（打开/重命名/归档），Header 支持编辑标题（PATCH title）。
- **验收**：Backend 338 + Frontend 73 测试（新增 import 回滚/自动标题/goal 映射/archive 过滤/restore/仅归档可删/忙碌保护/会话释放/Review 全链路 Fake Runtime）；build/typecheck 通过；Chrome 真实浏览器 8 条用户路径 × 3 分辨率（当时为手写 CDP 脚本，已被 `e2e/` Playwright 套件取代）全部通过。

## 历史

- **M4.4 Workflow Live View + SSE + Cancel + Progress（2026-09-09）**：见「当前阶段」节。
- **引用语义核验可配置（2026-09-09）**：见「当前阶段」节。

- **Review 并发优化（2026-09-08）**：profiling telemetry（e940607）→ 分章节
  Review 有界并发（`SectionReviewScheduler`，e4e8deb）+ PaperMap 章节摘要并发
  （0b9fcc1）；可重复真实 A/B benchmark harness（`scripts/benchmark-review.mjs`，
  8da4d83）。全量 33 节实测（C=3）：review.sections 2.81×、run 总时长 2.61×，
  0 失败 / 0 重试 / 0 次 429；默认并发度定为 3（依据见
  `docs/REVIEW_PERFORMANCE_PROFILE.md`）。
- **Outer Review Loop 架构方向冻结（2026-09-08，纯文档）**：D-0026 确立
  Iterative Writer–Reviewer Outer Review Loop（bounded baseline 之上的
  score-driven 增强；详见「下一阶段规划」节）。
- **Project Hardening & Real Paper E2E（2026-09-07）**：见上节。
- **Project Entry & Lifecycle UX（2026-09-07）**：见上节。
- **M4.3 PDF Review + Citation Integrity + Skill Registry**：Final PDF 成为 Existing Paper 正式 Review 输入；确定性解析（pymupdf 子进程）→ pages/sections/chunks；PaperMap + 受控 section context（隔离证明 + 会话无关重建证明）；引用提取（range 展开/不猜语义）；两层核验（NOT_FOUND≠捏造≠检索失败；语义 judge 禁止凭记忆、伪造引文剥离、确定性 severity）；Citation Integrity 规则并入 QualityGate；Skill Registry（两项 MIT 审计 skill pin revision 入库、按角色注入、中文简介持久化）；最小前端三视图；真实 PDF + 真实学术库 live smoke；285+34 测试。
- **M4.2.5 Live Model Integration Gate**：验证型里程碑（无代码改动）——真实 Provider `zai-coding-cn/glm-5.3` 经运行中 Backend 公开 API 完成 L3 验证：单 Agent smoke（10.3s 真实输出）、live SSE（4 条 LIVE 域事件实时推送）、Workflow E2E 至首个 HITL（checkpoint 全落盘）、真实 cancel（边界语义 + 会话复用）；凭据零泄漏，Pi 全程 in-process，234+24 测试零回归。
- **M3.8 Pi Runtime Migration & Contract v2**：Pi 成为唯一正式 Runtime（`@earendil-works/pi-coding-agent` 0.84.4 精确 pin）；OpenClaw 全套基础设施（Adapter / Gateway client / Bootstrap / supervisor / runtime.json / 三依赖）移除；`AgentRuntime` Contract v2（startAgent → 句柄：运行中事件流 / 取消 / result）；tool execution AbortSignal 取消传导实证；RuntimeStatus 去 Gateway 化；dev 直启 Backend；230 测试。**Pi + Node.js + npm 固化为 M4 Runtime baseline。**
- **M3.7 Pi Runtime Feasibility**：Side-by-side PiRuntimeAdapter 全项验证（in-process / 三路并发 / abort / 事件 / 隔离 / Windows 零 Gateway 子进程），结论 MIGRATE TO PI；280 测试。
- **M3.6 Runtime Baseline Upgrade**：OpenClaw 全家桶 2026.8.2 → **2026.9.1**（历史 baseline；Node 兼容检查收敛到根 package.json engines；runtime.json 存量版本自动迁移；255 测试 + 真机 Gateway E2E 回归）。
- **M3.5 Runtime Bootstrap / M3 Closure**：OpenClaw 独立 Runtime state（`~/.paperteam`）、`npm run dev` 一键启动、Agent 映射方案 A（D-0018）、`GET /api/runtime/status`、优雅关闭与无孤儿验证、254 测试。
- **M2.1 OpenClaw 2.0 Runtime Upgrade**：官方 `@openclaw/gateway-client/protocol`（protocol v4）、Project↔Session 隔离与 runtimeSessionKey 持久化（详见 git history）。
- **M2 Agent Invocation + Project + LaTeX**：runAgent 真实调用链、ProjectStore、WriterService、GenerationService、LatexCompiler、HTTP API。
- **M1 Backend Runtime Skeleton**：工程骨架、AgentRuntime 抽象、Runtime 健康检查。
- **Architecture Research & Product Design Refresh**：竞品调研与产品/架构方向冻结（D-0008~D-0015）。
