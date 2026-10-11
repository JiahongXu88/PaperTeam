# M13.7.6 — Revision LIVE Closure

日期：2026-10-11。基线：`main @ 95127fb6f06a65b877a02516fb51769d4324c10b`。

**结论：PARTIAL。** A 的真实 Planner → Dispatch / 作者裁决恢复通过；C 在真实模型暴露字段错位后，最小修复并完成精确 targetQuote 复验。B 的初次公式候选合法，但后续 Validation 暴露 Patch Evidence 接线遗漏；修复后复验又暴露 `protocol=unspecified` 被误当真实协议。最后一次 B 的真实 Writer 越过引文翻译原句，被 Scope Guard 拒绝，B 正例验收仍 FAIL。D 没有完成生产闭环，所有场景均未执行完整真实 Review/Gate，不能宣称 Revision Task Complete 或整体返修闭环 PASS。

## 1. 审计与范围

阅读 M13.7.5 Targeted Repair、M11.4 Reliability Closure，审计 `plan.improvement → collectRevisionDirectives → revision.apply/revise → computeFactPreservationForCandidate → revision.validate`、Evidence Selection、Claim Grounding/Resolution、Review/Gate 和既有定向测试。开始时 HEAD 与指定基线一致、main 工作区干净。

复用 `scripts/acceptance/revision-fidelity-live.mjs` 和生产服务栈、生产 Stage；没有重写 Harness、新建 Agent/数据库/第二套校验器，没有关闭或降低任何事实、引用、Evidence 或 Scope Guard。使用四节英文合成手稿，含 0.25、82.4%、两条原公式、既有 citation；不使用私人论文。

LIVE 使用既有个人 `zai/glm-5.3` 配置及新加坡专用 SSH 身份、严格主机信任文件；独立 checkout/runtime/projects。模型、构建、定向和全量测试均在新加坡运行。复用已安装 lockfile 依赖及已有验收镜像，未安装新依赖、开端口或部署服务。全量测试使用 2 CPU、最多 2 workers；模型调用始终串行。

## 2. LIVE 暴露的修复

### C1：局部引文被写入 noop 字段

初次真实 C 的 Planner 输出 `coverageQuote="The model use a compact adapter."`，没有 `targetQuote`。Writer 确实仅 use→uses，候选通过，但只能统计为**节级成功**。不能把结果恰好局部等同于机器约束已生效。

`WriterService` 的 JSON 示例补入既有 targetQuote 字段；生产 Stage 将合法逻辑节的 content 传给字段规范化。仅 modify、缺少显式 targetQuote、coverageQuote 在精确 file/section 的原文中逐字且唯一时，将其收窄为 targetQuote。缺失/重复引文、noop/作者裁决不转；显式但失效的 targetQuote 不被替换。后续仍走原 Scope Guard。

最终真实 C 的模型**原生**输出 `targetQuote="The model use a compact adapter.\cite{base}"`，未依赖人工加引文；Writer 首轮接受，稿件只改一个 s。额外生产回归证明，错位字段经规范化后，同节无关句改写仍被 `REVISION_TARGET_QUOTE_SCOPE_VIOLATION` 拒绝。

### B1：apply 路径的 Patch Evidence 未进入 Validation

初次 B 的真实 Planner 定位 `main.tex#sec:method`，绑定 E001；Writer 使用原授权式 `L = L_{task} + \lambda L_{reg}`，保留全部原文与原公式，候选 Guard 首轮接受。离线读取最终产物发现 `revision.validate` 将 Patch Evidence 标为非正式：

1. 旧 runner 的作者来源仅有 user_confirmed + quote + section，缺少 sourceId/chunk 锚点。补齐合成作者定义的来源身份，仍明确为作者材料，不冒充外部文献。
2. 生产 evaluateRevisionValidation 仅收集 RevisionPlan 中 applied 条目的 Evidence，而 `revision.apply` 没有 RevisionPlan。新增可选 patchEvidenceIds，Stage 从已落盘 Patch 传入，复用原 isFormalEvidence 检查并集；缺失/失效 Patch Evidence 还会使 Validation.ok=false。没有新增校验器，也没有把 user_confirmed 自动当作正式锚定证据。

初次 B 的失败结果和未锚定输入完整保留，不能把初次 Patch 接受写成最终验证通过。生产回归分别验证正式作者来源通过、未锚定来源保持拒绝。

### B2：protocol 摘要占位值被误当实验协议

补齐来源后的真实 B Planner 输出 `section=manuscript/main.tex`（既有合法 alias 已正确处理）、`protocolId=unspecified`。该值来自 Evidence alias 的 `protocol=unspecified` 展示；校验器错误要求 E001 必须属于名为 unspecified 的 current 协议。模型在有界字段修复中误转 author_decision_required，仍未完成 B。

仅将**未注册为真实协议**的精确 `unspecified` 占位值按缺省处理。若存在同名真实协议则保留；fair-ablation 推断、真实协议不一致、superseded Evidence 拒绝均保留。未改变科学表达式或模型角色。

### B3：精确引文边界的重复换行误拒

协议字段修复后的真实 Planner 给出完整 modify、E001 绑定及原公式 targetQuote。Writer 原样保留原文并在原公式之后加入授权公式，但最长公共 prefix/suffix 的差异对齐把原有尾换行吸收到插入前缀，报引文之外变化。最小修复既有 checkRevisionScope：直接核对授权区间外的固定 prefix/suffix 字节，并检查候选长度不能让两者重叠；hash/stale 检查保留。没有扩大 targetQuote，也不允许任一节外或引文外字节变化。

固定回归覆盖不变、合法换行边界插入、替换、prefix/suffix 越界、尾换行删除、候选过短与 stale hash；生产公式插入回归连同 Validation 通过。随后沿用**该真实 Planner 已落盘计划**继续生产 revision.apply，调用新的真实 Writer，不回放或筛选旧 Writer 输出。新 Writer 把原有三句英文翻译为中文，Scope Guard 正确拒绝，稿件保持基线。该旧 runner 创建的是 zh 项目而手稿为英文，存在全局目标语言与局部逐字保持约束的竞争；不能仅据此断言 GLM 对一致语言输入同样失败。B 因此最终 FAIL；边界误拒修好不等于模型正例已通过。

## 3. 分阶段结果与口径

表中 PASS 仅指该列阶段；N/A 表示未执行/不适用。Revision Validation 是真实生产确定性 Stage，但 runner 使用合成空 pre-review summary，不是三路真实 Review，也不是完整 Workflow/Task Gate。

| 场景 / 轮次 | Planner Valid | Writer Proposal Valid | Patch First-pass Accepted | Patch Repaired | Author Decision Required | Revision Validation Passed | Revision Task Complete |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A 初次 + 新服务实例恢复 | PASS | N/A | N/A | N/A | PASS | N/A（无 Patch；零条目验证返回 ok） | N/A |
| B 初次，未锚定作者来源 | PASS | PASS | PASS | N/A | N/A | FAIL（最终 Patch evidence=false） | N/A |
| C 初次，未生成 targetQuote | PASS（节级） | PASS | PASS | N/A | N/A | PASS（确定性） | N/A |
| C 修复后复验 | PASS（句级） | PASS | PASS | N/A | N/A | PASS（确定性） | N/A |
| B 补锚点后，protocol 占位误判 | PASS（结构，科学决策错误） | N/A | N/A | N/A | 意外触发，正例要求未满足 | N/A（无 Patch） | N/A |
| B 协议修复后（live-4） | PASS | PASS（内容合法；Guard 误拒） | FAIL | N/A | N/A | N/A（未应用；零差异验证 ok 不算通过） | N/A |
| B Scope 修复后续跑（live-5） | 复用 live-4 的真实计划 | FAIL（翻译引文外三句） | FAIL（正确拒绝） | N/A | N/A | N/A（未应用；Patch summary=false） | N/A |
| D 机制扩写闭环 | N/A | N/A | N/A | N/A | N/A | N/A | N/A |

A 的 rationale 具体列出损失项、符号定义、权重取值、计算过程，并明确不能将 adapter weight 0.25 当作损失权重。生产 Dispatch 为 0，稿件逐字不变，无公式 Patch。重建服务实例后从磁盘读取 AUTHOR_DECISION_REQUIRED，并执行后续 revision.plan/revision.revise，额外 Runtime 任务为 0；这证明服务重载恢复，不是完整进程崩溃与 Workflow 自动恢复证明。

C 的原生 targetQuote 生成统计：初次 0/1，修复后 1/1；两次真实输出均恰好只改 use→uses，只有后一次计句级 Scope 成功。新旧数字、公式、citation 及同节其他内容均字节不变。Patch、意见 trace 和验证产物可重载读取。

B 的来源追踪：Fact Guard 的 formulaAuthorizations 将表达式绑定 E001 和计划条目；E001 的作者确认等级、sourceId 和 chunk 保留。作者材料只证明本合成作者定义已授权，**不证明该公式有原创贡献**；外部公式应保持外部 source 身份，不因为可授权写入就自动成为作者原创。本轮没有额外外部文献公式 LIVE 正例，不能宣称其原创性归属已完成真实模型专项验收。

五次真实 Writer 提案中，候选首次接受 3 次（B 初次、C 两次），拒绝 2 次（B live-4 边界误拒、live-5 模型越界）；最终 post-validation 可用的真实 Patch 为 C 的两次。初次 B 的候选接受率不能代替最终 Evidence 验证结果。所有 LIVE Patch Repair 均未触发：Repaired=N/A，不能使用 summary 对空分母返回的 patchRepairSuccessRate=1 宣称 100% 修复率。多次开发复验不是同一 Patch 的 bounded repair。

## 4. D 未完成及生产边界

D 未跑真实 Claim Resolution → Revision → Patch Validation → Review/Gate。预算优先用于修复并复验 A/B/C，不另做一次独立 Reviewer 评分冒充闭环。

只读生产审计：revision.plan 的 computeClaimResolutions 当前受 isSurveyKind 限定；existing-paper 的 Evidence/Claim Repair 仍消费 Reviewer/grounding 指令，但不能据此宣称启用了 survey 的完整 resolution 合同。classifyClaimResolution 的 use_existing_evidence 分支接受词面 repairCandidates，这只是候选线索，不能视作完整机制支持。

“冻结表示、仅训练适配器”不能直接支持“无需优化器状态、低秩子空间优化、梯度偏差抵消”等具体机制。候选 Fact Guard 对无数字纯 prose 的语义边界仍在；本轮没有真实证明其后续弱化/删除、排除 hedge 保留、拒绝词面伪支持和成功 sibling 保持。没有在无 LIVE 证据情况下扩展业务重构来掩盖未完成。

## 5. 模型与资源统计

实际 **12 个 Runtime 任务 / 31 assistant turns**，其中 7 个 Planner 任务（含 1 次字段修复）、5 个 Writer proposal 任务；作者裁决恢复无额外模型任务。非缓存 input=35567、output=3835、cache read=45824、cache write=0；input+output=39402，计缓存读取总量=85226。SDK estimatedCost=**0.07858204**，任务秒数和=164.625，五段模型运行墙钟和=165.005 秒，不含段间工程审计/构建/测试。

共享预算原始准入为 12 Runtime 任务 / 20 observed turns；达到 20 后停止，随后因 B 的真实 Validation 缺口将准入阈值依次扩至 26、30、32，私人 model-budget.json 记录原因及时间。12 任务上限未提高。20 是建议目标，本轮实际超过，不能声称预算完全达标。工具交互会使单任务包含多个 assistant turns；准入阈值仅阻止下一任务，Runtime 不支持单任务严格 turns 上限，不能硬保证底层请求总数。

Token、SDK estimatedCost 不是提供商实收账单；不含本 Codex 工程会话、构建、测试和 CI。没有将 Runtime task 数冒充模型请求数。

## 6. 工程验证与交付

最终冻结源码：定向 **149/149 PASS**（WriterService 51、Revision Fidelity 29、Revision Scope 19、M11.4 38、Revision Validation 12）；其中保留两项显式限制探针，不能计作语义安全验收通过。新加坡后端完整 typecheck/build PASS；Vitest **3136 PASS / 22 SKIP / 0 FAIL（281 文件通过、8 文件跳过，151.43 秒）**，linux-checks.sh EXIT=0。22 项为既有需额外环境的 smoke 测试，不冒充已执行通过。runner node --check、git diff --check PASS。最终八个代码/测试/runner 文件逐个 SHA256 与新加坡实测版本一致。中间快照的全量日志同样保留，不代替最终冻结树验收。

前端未改动，未在新加坡追加前端回归；本次 GitHub CI 自身覆盖前端。未执行完整私人论文、LaTeX PDF 编译、长时间 E2E、真实科研实验或数学语义等价证明。

最终源码冻结包 `release-frozen-code.tgz` SHA256：`63aa014cf3e260d7a383e2a1d6b4d9ccf165926c8e649834173993033894b885`。原始模型 prompts/outputs、所有失败与成功 result、合成项目、usage、预算扩展记录、测试日志和 publication 记录存于 `D:\PaperTeamData\M13_7_6`；不归档 auth/settings。公开仅业务最小修复、合成回归、现有 runner、报告和研究索引。

按用户明确授权在 main 提交和 push，不创建分支。报告随该提交触发 GitHub CI / Linux Integration；其最终状态以本轮提交 SHA 在最终回复及私人 publication.json 核对，不引用基线绿灯代替本轮 CI。

## 7. 后续

下一轮先将 B 合成项目语言与英文原稿对齐，复验合法公式最终接受；该输入修正本轮未做 LIVE，不能先改标 PASS。随后给 D 单独小预算，真实执行 existing-paper 的 Reviewer UNSUPPORTED → Claim Resolution/Repair → Patch Validation → Review/Gate，并验证词面候选不等于语义支持与已通过 sibling 保持。本轮整体 PARTIAL 不因单元测试全绿改写为整体 PASS。
