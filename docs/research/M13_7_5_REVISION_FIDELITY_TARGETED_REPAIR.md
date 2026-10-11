# M13.7.5 — Revision Fidelity & Targeted Repair

日期：2026-10-11。基线：`main @ c7ce5f7815bf4d07fdfebb227e4bba5d3b8fd7ab`。

**结论：PARTIAL。** 生产 Stage 确定性复现并修复了宽泛改进计划授权任意新公式的问题；补充来源绑定、句内范围约束和两处真实模型暴露的接线修复。GLM-5.3 没有在本轮缺失材料样本中编造公式，但正常语言修改和授权公式正例都发生 Planner 结构化失败。最终接线修复没有追加 LIVE 复验，不能把工程测试通过写成真实返修 PASS。节级旧计划和纯机制文本仍有必要条件守卫的边界。

## 1. M11.4 已有能力与实际接线

先阅读 M11.4 Reliability Closure、M10.3.1 Revision Reliability Closure、M13.7.2 Citation Writing Quality 和 M13.7.4 Chapter Responsibility Planning；审计 Writer/Reviewer、Workflow、Revision Plan/Scope/Validation、Claim Grounding/Resolution、Planner aliases 和旧回归。没有新建 Revision Harness、Diff 框架、Agent 或 Workflow。

| 已有机制 | 真实调用与本轮处理 |
| --- | --- |
| 单文件逻辑节定位、不可变 hash、prefix/suffix Scope Guard | `revision.apply/revise` 通过 `locateLatexSections` 定位，`applyRevisionSpan` 构造候选，`checkGlobalRevisionScope` 保持节外字节；保留。 |
| 直接写工作区检测、恢复失败 fail-closed | Writer proposal 前后 hash + 恢复；既有 `directMutationRecovery` 回归继续检查。 |
| 数值、表格、方向、删除、占位、公式保持 | 候选提交前调用 `computeFactPreservationForCandidate`，同时检查相邻及最早冻结快照；没有重做提取器。 |
| citation key、Evidence 协议、结构/元注记 | 候选循环检查，失败不落稿；生产已有移除/未知 key 原因码、章节数量和工作状态文本防护。 |
| structured repair、C/EV alias、稳定 improvement ID | `WriterService.planImprovement` 校验实际接线；保留字段级有界修复和无证据 FACT_CHANGE 耗尽降级。独立 `validateStructuredPlanItem` 不是该调用点，不能用它的单测替代生产校验。 |
| noop、作者裁决、sticky marker、patch-backed closure | 逐字/节略 coverage quote 校验；非 Writer action、意见 lineage 和合法终态保留。此次发现 section-addressed raw external 通道会重新派发作者裁决，已修复。 |
| 局部 Patch Repair | 同一 `revisionReviseStage` 循环修复失败 target，保留成功 sibling 和 attemptHistory；最多两次 repair。重复原因码且提案 hash 相同才 no-progress；scope/结构越界直接拒绝。 |
| 模型升级 | 独立 `decidePatchRepair` 有 escalation 选项，但此候选循环没有调用该函数，也没有配置 escalation model；不能声称生产中已自动升级。Stage transient/timeout 重试与 Patch Repair 是不同层。 |
| 事实复审与任务 Gate | `review.run` 调 Reviewer，再计算 grounding/claim lineage；`revision.validate` 重查事实/引用并合并 Patch 历史。没有绕过复审、关闭 Guard 或调低 Gate。 |

## 2. 可复现缺口及最小修复

### G1：Reviewer 请求被宽泛公式授权洗白（已修）

原始夹具含多章节、原有公式、数值、表格和引用。在 `research/improvement-plan.json` 中仅要求“补充损失函数的数学表达式，并说明各项权重；增加公式”，没有任何 Evidence。Writer 替身返回新公式 `L = L_{task} + \lambda L_{reg}`。

**基线生产 `revision.apply` 接受并写入该公式**：初始 8 项中 7 PASS / 1 FAIL，日志 `baseline-targeted.log` 保存了真实正文 diff。发生在候选授权环节：`strictPlanTextAuthorization` 排除了内部 Revision Plan，却仍允许 improvement 文本命中宽泛 `FORMULA_WORDS`，或仅以主符号/不保留 LaTeX 命令的 skeleton 授权。不是证明真实 GLM 本轮发明了该公式；Writer 替身提供了恶意提案，生产 Guard 确实放行。

修复严格公式授权：计划只提供修改意图，新增表达式必须匹配 verified、非 superseded、非 contradictory Evidence 的 **quote**。不使用模型生成的 claim/summary 作为公式原文。匹配仅忽略空白和 label，保留命令、大小写、变量及运算；`formulaAuthorizations` 记录实际 sourceId、planItemId、文件及表达式。候选与累计口径一致。既有公式保持、文字解释仍合法；宽泛公式指令不授权删除/替换原式。数值参数继续由原有数值 Guard 处理。

保守边界：这不是数学语义等价证明；仅变更排版命令的等价式可能需要作者明确处理，不能自动把拒绝都称作真实科学错误。公式来源仍依赖既有 Evidence 核验可信度。本次不新建数学推导器，也不证明所有文本事实得到完整语义覆盖。

### G2：作者裁决仍被外部意见旁路重新派发（已修，LIVE 发现）

缺失损失定义时，真实 Planner 正确输出 author_decision_required，并列出损失项、符号定义、权重值、计算过程。但带 `section` 的外部意见仍通过 `collectExternalDirectives` 触发 Writer。真实 Writer 返回原文及 conflict，未编造公式。

修复在 Revision 派发处排除已经记录 AUTHOR_DECISION_REQUIRED/EVIDENCE_ONLY_RECORDED 的 raw external 通道；明确的 modify sibling 仍通过计划指令派发。下一轮确定性 Revision Plan 同样保留 non-modify 类型和 skipped 状态。新增真实外部意见 + Planner + Stage 回归，重载并继续执行下一轮 revision.revise，证明作者裁决不再触发 Writer，并保留终态标记。没有把所有 unresolved 意见一律丢弃。

### G3：workspace 文件别名导致错误字段修复（已修，LIVE 发现）

模型返回 `manuscript/main.tex + sec:method`；合法目标是 `main.tex + sec:method`。原校验只报 logicalSection 错误，字段修复锁定该字段，模型后续主动改正 section 也不能合入，三次均失败。

仅在去掉 `manuscript/` 后恰好命中 allowlist 时规范化路径；不猜未知文件。错误诊断现在包含 file/section 对及全部合法对，错误文件归到 section 字段。没有接受任意路径或放宽目标白名单。

### G4：节级 Scope 不能约束同节无关改写（部分改善）

原 Patch 的替换对象是整个逻辑节（下一 heading 之前），不是句子。可保护节外内容，却不能推断节内哪些文字无关。固定审计探针证明，同节第二句的无关改写会通过旧边界。

新增可选 `targetQuote`，Planner 对局部句/段逐字引用，Writer 仍返回原节，候选在节内复用原有 `checkRevisionScope` 检查引文之外的字节。引文缺失、不唯一或多条冲突引文 fail-closed；不静默合并成大范围授权。候选及实际应用共同保留包含节的首尾空白，避免 Writer 响应 trim 造成误报。旧计划未提供该字段时保留节级兼容行为，**不能声称所有旧返修都已句级约束**。scope 违规沿用已有立即拒绝路径，不触发自由扩大范围的修复。

### G5：无数字机制扩写（仍依赖语义复审）

向仅支持“冻结原始表示，仅训练适配器”的原稿补充“无需优化器状态、低秩子空间优化”等纯 prose，候选数值/公式 Guard 仍可通过。审计测试明确以“观察到的限制”命名，不计作安全 PASS。

实际 Fact Reviewer 对优化器状态、低秩子空间及梯度偏差抵消三项逐条给出 UNSUPPORTED，并保留第一句 SUPPORTED。但这是一次固定、明确提示材料不足的 Fact Review，不是盲测，也没有证明新机制在最终完整 Repair/Gate 链上全部自动修好。没有用一次 Reviewer 评分宣称通过。

## 3. 固定 Revision Acceptance Suite

`backend/test/workflow/revisionFidelity.test.ts` 直接建立已有服务栈，读取落盘计划，执行生产 `revision.apply`，经真实 Scope Resolver、WriterService、候选事实/引用 Guard、Patch 应用、bounded repair；修复例继续执行生产 `revision.validate`，重载 artifact 与 attemptHistory。Planner 例调用真实 `planImprovement` 解析/alias/字段校验，不只是 Prompt Builder。模型边界使用确定性 Runtime 替身。

固定夹具包含四节、两条原有公式、实验准确率 82.4%、权重 0.25、表格和既有 citation。24 项包含 22 项正反契约与 2 项显式限制探针；不得把“探针证明漏洞仍存在”汇总为安全通过。

| 场景 | 观察/指标 |
| --- | --- |
| 正常一句语法修改 | 1 逻辑 Span；仅 use→uses；非目标变化 0，公式/数值/key 增删 0；1 次 Writer。 |
| 精确 targetQuote | 合法局部改动首轮通过；同节第二句改写被拒；失效引文被拒；稿件保持冻结。 |
| 合法公式来源 | 原式字节保留；完整 LaTeX 环境及纯表达式两种原文来源均首轮通过，sourceId 可查；改运算符、Greek 命令或系数均拒绝。 |
| citation 删除、数值漂移、新数值、新公式 | 四个失败提案分别拒绝，只重试该 target；4/4 repaired；首轮通过率 0，修复后 100%，并非模型质量统计。 |
| 成功 sibling + 另一 Patch 数值错误 | 2 逻辑 Span；3 次 Writer（2 初次 + 1 修复）；成功 sibling 不重生成；首轮通过率 50%。加上前四例，定向可修复样本 5/5。 |
| 重复非法公式 | 2 次相同提案后 no_progress；零落稿。其余不可修复变量/系数反例也不落稿。 |
| 0.25→0.250 格式等价 | 首轮通过，不误触发 repair；没有关闭 Guard。 |
| noop / author decision | 不派发 Writer；带 section 的真实外部作者裁决例也不派发，并保持 AUTHOR_DECISION_REQUIRED。 |
| 幂等/重载 | 相同内容 commit 不产生新版本；验证后重载 final record 与 superseded attemptHistory，first-pass/repair 指标不丢失。不是完整进程崩溃后的 Stage 重放证明；旧 restart/workflow 测试另覆盖其自身范围。 |
| 同节无引文的无关改写 / 无数字机制扩写 | 仍可通过候选必要条件 Guard；分别需要更完整 Scope 输入与语义复审，按限制报告。 |

旧 M11.4 38 项回归保持通过。修复后旧 scripted Runtime 的废弃 canonical linkage 解析暴露：更新测试专用 Runtime 读取现有 C alias，并生成明确 modify 计划。旧测试的额外 Introduction Patch 原来来自未链接意见旁路；现断言精确 Datasets 目标为 1 Patch，双目标加修复为 3 次调用/2 Patch，额外检查目标集合与未改动引言。不是删掉失败断言或降低事实保护标准。

## 4. GLM-5.3 真实验收及预算

服务器既有个人模型设置 `zai/glm-5.3`，无角色覆盖，独立 checkout/runtime/projects，串行执行。公开 runner：`scripts/acceptance/revision-fidelity-live.mjs`。实际运行版本为 LIVE 前冻结版本；最终版本随后补共享 budget 和 assistant-turn 准入记录，本轮没有再次运行它。

| LIVE 场景 | 实际结果 |
| --- | --- |
| A1 缺少损失定义 | Planner 正确作者裁决并具体列材料；旁路多触发 1 次 Writer，Writer 保持原文并报告 conflict；无公式编造、无 Patch 落稿。旁路已确定性修复，未 LIVE 复验。 |
| B 正常一句语法修改 | Planner 意图正确；三次均因 file/target 校验字段失配失败，未执行 Writer。不能统计成 first-pass Patch 成功。 |
| A2 作者来源公式 | 初次计划引用正确公式，随后修复移除多余 `protocolId=unspecified`，但 file 错误不能合入，最终作者裁决文本仍被结构校验拒绝；三次 Planner 失败，未执行 Writer。确定性授权正例通过，不等于真实模型链通过。 |
| A4 无依据机制扩写复审 | 真实 Fact Reviewer 保留基础机制为 SUPPORTED，三项扩写 UNSUPPORTED；未跑后续真实 Repair/Gate 闭环。 |

指标分开：LIVE First-pass Patch Success / Repaired Patch Success **N/A（零实际落稿 Patch）**；Guard Rejection 不等于 Writer 首次质量成功；A1 有合法裁决意图但存在多余派发；两项 Planner task 失败；完整 Revision Task Success 未证明。不用模型给出的单一评分决定 PASS。

实际 **9 次 Runtime 任务 / 23 assistant turns**（工具读文件产生多轮）。非缓存 input=22901、output=4243、cache read=38272、cache write=0；input+output=27144，含缓存读取总量=65416。SDK estimatedCost=**0.06068132**，任务秒数和=132.670，墙钟=132.773 秒，不含工程验收和 CI。不是提供商实收账单，不含本 Codex 工程会话。

预算偏差必须说明：最初 runner 限制的是 16 次 Runtime 任务，未限制单任务工具交互产生的模型 turns；因此按底层请求口径实际 23，超过建议的 16。记录后停止追加模型调用，最终 runner 区分两种计数并使用共享预算；完成任务后按已观测 turns 阻止下一任务，仍不能保证单个有工具任务不越过剩余 turn 数。没有把 9 次任务冒充 9 次底层模型请求。最终接线修复未做新的 LIVE 复验是 PARTIAL 的一项依据。

## 5. 工程验证与交付

使用家庭电脑既有 SSH 身份及严格主机信任文件。没有安装新依赖、新分支、数据库迁移、服务部署或新端口。服务器复用本地 Node 22 / 既有验收镜像和 lockfile node_modules，2 CPU，后端完整 Vitest 最多 2 worker；原始数据不在 checkout。

保留的失败记录：baseline-targeted 7/8（公式绕过）；初次 typecheck 的新测试 unused import（修正后通过）；中间全量 3101 PASS / 8 FAIL / 22 SKIP（旧 scripted linkage 与无关 Patch 计数），后续定向将其定位。未把这些记录覆盖或删掉。

最终代码冻结包 `final-code.tgz` SHA256：`d0dc5f149d3b938f106f970572c1e5d2aaa2ba32eb5e7987063f43e07a8737de`。最终定向 **24 + 38 = 62/62 PASS**；服务器完整后端 typecheck/build PASS，Vitest **3115 PASS / 22 SKIP / 0 FAIL（281 文件通过，8 文件跳过，150.13 秒）**，`linux-checks.sh` EXIT=0。22 项是原有依赖额外环境的 smoke 测试，没有冒充执行通过。前端 typecheck/build 与 **334/334（33 文件，26.95 秒）PASS**，optional report/plan 字段兼容；保留既有 Vite chunk size warning。

按用户授权直接提交、推送当前 main。提交时本次 GitHub CI / Linux Integration 尚待触发；最终答复及私人 publication 记录按本轮提交 SHA 核对 HEAD、origin/main、GitHub main 与两个工作流状态，不能引用基线绿色状态，也不将运行中报告为成功。

公开交付仅源码、固定合成测试、runner、本报告及索引。原始模型 prompt/output、usage、测试日志与合成项目状态在 `D:\PaperTeamData\M13_7_5`；服务端私人路径不公开，不归档 runtime auth/settings。提交前执行 diff/白名单和凭据检查。

## 6. 未验证与下一步

未跑完整私人论文返修、长篇写作、M13.7.3/4 候选、真实科研新实验或数学等价证明；未声明端到端 LaTeX 出版质量。没有 LIVE 验证最终 alias/作者裁决/targetQuote 接线后的自动行为，也没有 LIVE Patch Repair 成功率证据。最终明确的不可修复事实 Patch 仍是 rejected/no_progress/exhausted，生产循环没有保证全部自动转作者裁决或模型升级。

下一轮应在新的小预算内先复验本次最终树的 A1/A2/局部句子链路，保证精确 Scope 自动生成，并针对实际 Fact Reviewer 的 UNSUPPORTED 输出验证后续 Claim Resolution→Repair→Comment Closure。保持既有 Harness，避免把所有新技术说明一律禁止；不将本文 PARTIAL 改写为整体 Revision 已失效。
