# M13.7.3 — Cross-Section Academic Writing Quality

日期：2026-10-11。指定基线：`main @ a80e949bd189d452e646090922891b8564da8812`。

**验收结论：PARTIAL；跨章节写作质量目标未达标。** 真实模型复现了机械重复、重复引用和未覆盖机制扩写；候选的显式前文上下文未带来可确认的质量改善，却增加输入与费用。因此撤回候选生产代码，仅提交验收脚本、固定公开素材、可重现候选补丁及报告。不能把“不合入本候选”解释为“不需要改进”。所有失败产物保留。

## 1. 实现审计与实际缺口

| 环节 | 已有实现 | 缺口及本轮覆盖范围 |
| --- | --- | --- |
| Outline Planner | 普通路径从 research gaps / potential contributions 规划；Survey 从 taxonomy / comparison / gap / future 等结构化 synthesis 规划，refs 校验且 speculative 限于展望 | 有事实与类型约束，但没有定义/论述的主要展开章节或全篇术语表；本次固定大纲，不宣称检验了真实 Planner 输出 |
| Writer | 两个逐章入口串行写作；普通章节获得标题列表、当前节 keyPoints、Evidence 与实验授权视图；Survey 获得本节 synthesis/literature refs 的有界投影 | 其他章节 keyPoints 和正文没有显式传入；依赖会话历史或文件工具来获取前文，不能只据 prompt 缺字段断言模型完全看不到前文 |
| Runtime | 同项目 `writing/sections` 复用会话，FIFO；会话可轮转且不持久，Workspace/checkpoint 是事实源 | 正常连续写作确实能看到前文历史；轮转/重启后缺少显式恢复的论述上下文。本次 runner 保留共享历史，没有人为清空会话以夸大缺陷 |
| 跨章节检查 | Survey writing invariants 有覆盖、引用和 speculative 边界；事实与引用链有既有 Guard | 没有确定性全篇语义去重或术语/定义一致性证明；同源多次引用不等于错误，不能以 key 次数作唯一判断 |
| Reviewer | fact / academic / style 三路；style 已检查重复、术语漂移、重复免责与未来贡献 | 生产 digest 每节 3600 字符、最多 24 节、总计 60000 字符；长节后部可能不可见，不能保证发现所有跨节矛盾。本次三路审查直接消费候选正文，不是生产 digest/grounding/gate 链 |
| Revision | 计划按目标节/逻辑 span 派发，关联 Evidence，引用冻结、事实保持、patch 验证与复审 | 跨节协调取决于问题定位和计划派发；不是全篇同时去重。本轮没有修改 Revision Planner，也没有证明跨节修订闭环有效 |
| Style Polish | 默认 `suggest_only`；显式选择 `apply_once` 才执行，按节只改指定句；保护引用多重集、数字单位、公式、结构、术语、方向、来源边界 | 无法安全承担跨节搬移贡献、删除带事实的重复段落。相关行为和用户选择语义均未改变 |
| M13.7.2 Evidence / Citation | direct/partial + quote 边界、引用用途、来源与命题支持分离、外部论文不能证明本文结果 | 长文中改善了明显 partial 扩写，但具体机制仍可能超出 quote；Citation semantic 默认 off，不能把生成正文当作已通过语义核验 |

主要路径：`WriterService.buildOutlinePrompt/buildSurveyOutlinePrompt` → `writingSectionsStage/surveyWritingSectionsStage` → `WriterService.writeSection`；`buildManuscriptDigest` → `ReviewerService` → Claim Grounding / Quality Gate → scoped Revision；用户选择后才进入 Style Polish。

## 2. 固定素材、版本与预算

公开资产：[验收脚本](../../scripts/acceptance/cross-section-writing-live.mjs)、[素材与运行说明](../../scripts/acceptance/fixtures/m13-7-3/README.md)、[未合入候选补丁](../../scripts/acceptance/fixtures/m13-7-3/rejected-candidate.patch)。复用 M13.7.2 的 PiRuntimeAdapter、模型设置、技能路由与 LIVE 运行方式，没有新增 Agent、生产依赖或独立服务。

| 样本 | 内容 | 证据范围 |
| --- | --- | --- |
| 开发样本 `dev.json` | Transformer：引言、架构、证据分析、局限性、结论 | 复用上一轮公开论文的 grounded fulltext 引文及 direct/partial 记录；partial.claim 包含无卷积，但 quote 未覆盖该子命题 |
| 最终样本 `frozen.json` | 开放域问答：引言、稠密检索、检索增强生成、比较与局限性、结论 | 两篇公开摘要；没有实验数值。DPR partial 负例含“所有领域及所有语言均优于 BM25”，quote 只覆盖机制，不覆盖普遍性能保证 |

来源为 [Attention Is All You Need](https://arxiv.org/abs/1706.03762)、[DPR v3](https://arxiv.org/abs/2004.04906v3)、[RAG v4](https://arxiv.org/abs/2005.11401v4)。DPR/RAG 的标题、来源页与引文范围已人工核对；摘要记录未伪装成全文核验，也不是本轮 Evidence Judge 全链重新采证。故意更强的 partial.claim 是负例，不是真实论文的结论。

两个 JSON 在候选实现前冻结，SHA256 在资产目录同时保存 LF/CRLF 两种换行形式（内容相同，避免 Git 换行转换使校验失效）；主题不同。开发样本用于确认缺陷，最终样本仅进行一次三版本比较，看到不利结果后没有继续据此调 Prompt 重跑。每节要求约 350 字，相同 Outline、文献池、Evidence、补充要求及空实验授权视图。

版本 A：`a81176e1947415d76836714d23261d0518432609`，M13.7.2 前；版本 B：`a80e949bd189d452e646090922891b8564da8812`，M13.7.2 后；版本 C：在 B 上应用公开的 rejected candidate patch。服务器 A/B 源文件与对应 Git 对象经换行归一后吻合；原始 source/dist 哈希留在私人 code manifest。所有版本使用相同 Runtime adapter 和设置，Writer 业务 prompt builder 与可用 seed skill 来自对应版本。

模型为服务器已授权 `zai/glm-5.3`，没有角色模型覆盖。没有声称提供商支持固定随机种子或完全确定性；采样设置沿用同一配置，没有扫参。每个版本五章共享一段会话历史，版本之间独立；只读工具，要求不查询额外事实。Writer 两份中文技能可用，但实际 `accessed=[]`，不宣称技能正文被读取。

串行执行 10 次开发 A/B + 10 次最终 A/B + 5 次候选 + 3 次候选 Reviewer = **28 次实际模型请求 / 28 assistant turns**。另有 1 次凭据目录只读挂载导致初始化失败，发生在 provider 请求前；保留日志并按保守预算计入，**29/32 reservations**。后续复用同一父目录 ledger，每次先预留预算再派发；脚本拒绝覆盖既有输出。单次任务 180 秒上限，取消信号 190 秒；并发为 1。

这是一项连续多章节 prompt 验收：调用真实版本 Writer prompt 与 Pi adapter，保留生成顺序和历史。**不是 `idea_to_paper` / `topic_survey` E2E**；没有执行真实 Planner、Survey synthesis、在线研究供给、生产 writeSection 输出校验、引用语义 judge、Grounding/Gate、自动修订或论文编译。本次综述类内容通过通用章节 prompt 生成；Survey 专有 prompt 的多源综合效果仅做代码审计，不能从本次 LIVE 推导。

## 3. 实际生成规模与逐项证据

字符统计按逐章原输出计算，含 LaTeX 与空白；汉字数单列。正文共 **25 章、14542 字符 / 11288 汉字**，另有三份 Reviewer 输出。

| 阶段/版本 | 章节 | 字符 / 汉字 | cite 命令 / key 出现次数 |
| --- | ---: | ---: | ---: |
| 开发 A | 5 | 2974 / 2342 | 11 / 11 |
| 开发 B | 5 | 2814 / 2121 | 12 / 12 |
| 最终 A | 5 | 2985 / 2322 | 13 / 13 |
| 最终 B | 5 | 3071 / 2387 | 14 / 15 |
| 最终 C | 5 | 2698 / 2116 | 13 / 13 |

以下路径相对于私人数据根 `D:\PaperTeamData\M13_7_3`。原文、prompt、usage 均保留，可逐句核对；表中短引文来自本轮模型输出。

| 问题 | 原文位置与证据 | 观察 |
| --- | --- | --- |
| 开发重复机制 | `dev-live2/after-architecture.output.txt`：“摒弃了循环结构，完全依靠注意力机制”；`after-analysis.output.txt` 再次描述同一机制；`after-limitations.output.txt` 又解释“摒弃循环结构、完全依靠注意力机制捕捉全局依赖” | B 已有前文会话历史，仍然重复，不能单归因于没有前文 |
| 开发 partial 边界 | A 的 architecture / analysis / limitations 使用“舍弃了循环与卷积”；B 对应机制只转述循环与注意力 | M13.7.2 在连续正文中仍有明确改善；不是本轮新修复 |
| 最终 partial 扩写 | `frozen-ab/before-retrieval.output.txt`：“在所有领域及所有语言上均优于 BM25”；A 的 scope / conclusion 再次重复 | 来自 partial.claim 的错误普遍化，还被免责语包装；A 的引言也有较弱版本 |
| B 保住明显边界但仍暗示证据 | `frozen-ab/after-scope.output.txt`：“关于 DPR 相对 BM25 的性能优势，目前可见的证据停留在摘要所述的层面” | 所给 quote 没有性能比较；不能仅因没有绝对保证就宣称引用完全准确 |
| C 核心机制重复 | `frozen-fixed/fixed-introduction.output.txt`：“嵌入由简单的双编码器框架”；`fixed-retrieval.output.txt` 再次完整展开；`fixed-scope.output.txt`、`fixed-conclusion.output.txt` 再述 | B 的双编码器出现于 3 章，C 为 4 章；出现次数只是定位信号，人工阅读确认仍有无新信息的完整复述 |
| RAG 定义反复展开 | 最终 A/B/C 的 introduction、generation、scope、conclusion 均包含序列到序列参数记忆与稠密索引非参数记忆的完整定义 | 三个版本均为 4 章，没有减少；摘要/结论必要呼应不全部判错，但比较章节重新展开定义没有新增分析 |
| 重复限制 | C 的 retrieval / generation 均以缺证据、未评测结束，scope 集中说明后 conclusion 再完整说明 | 必要限制保留了，但没有做到集中展开与简短承接 |
| 新增/延续的无证据机制 | `frozen-fixed/fixed-retrieval.output.txt`：“词项匹配的权重不再是人工设定的统计量……端到端学习的参数” | quote 不覆盖这些训练/稀疏权重细节。B 也扩写近邻搜索与稀疏语义局限；本候选未解决这一风险 |
| 不自然工作状态表达 | C conclusion：“这一计划的实施情况将视后续证据与实验的进展而定” | Reviewer 也指出过程性措辞。词面 workflow_note=0 不代表不存在工作报告式表达 |
| 术语、衔接、贡献 | B 使用 token，C 统一为“词元”；均区分组件/系统，未来评测没有变成已完成贡献；章节有自然回指 | 小样本未出现明确自相矛盾；不能把既有正常表现算成本轮提升 |

引用 key 均来自给定两篇真实来源，没有伪造第三篇文献；但“key 存在”与“句子得到支持”不同。C 比 B 少 1 个 cite 命令、少 2 次 key 出现，源于句子组织变化，不能单据计数判断引用更准确或必要引用未损失。

## 4. 候选实现、回归与不合入决定

候选在两个初始写作入口显式传入本轮已写章节；Writer 展示其他章节 keyPoints、第一节与近期章节的有界原文、上一节结尾，明确它们不是 Evidence。普通与 Survey Outline 提示增加章节主要职责；Reviewer 要求对跨节问题给出两处原句，区分必要呼应与重复。新增三个测试验证上下文独立存在、有界摘录且不改原文、目标节不回灌和科学限制保护。

这些测试证明了组织上下文的传递与预算约束，**不能证明生成质量提高**。最终样本中 RAG 完整定义重复仍为 4 章，双编码器出现从 3 章变为 4 章，重复限制仍存在。C 正文比 B 短约 12%，但没有获得更好的论述分工，不能用篇幅变化宣称成功。

三路 Reviewer 均完成。Style 给出机制重复、重复限制与过程性措辞的可核对例子，riskScore=50 仅作辅助。Fact 对训练细节给出 PARTIALLY_SUPPORTED，却将其解释为“合理阐释”且没有对应 required fact issue；因此不能把它的“事实风险低”摘要视为通过。直接 Review 输出还把多个章节合并进 section 字符串，未经生产归一与派发，不能声称跨节 Revision 可直接执行。

| 验收问题 | 结论 |
| --- | --- |
| 多章节重复是否减少 | 未证实；核心定义重复未下降，部分词面信号变差 |
| 必要重复是否被误删 | 无独立实验、摘要范围、未来计划限定均保留；没有发生改写既有稿件的删除，不能等同 Style 修订安全证明 |
| 定义/贡献/实验范围矛盾 | 三版本未见明确的内部范围反转；A 有外部性能普遍化错误；没有本文实验结果被虚构 |
| 引用是否准确 | 来源/key 真实；部分具体句子超出 quote，准确性不完全通过 |
| partial 是否不再扩成完整事实 | B/C 未写 DPR 全领域全语言保证；B/C 仍有其他无覆盖机制扩写，不能宣称所有事实边界已解决 |
| Token/延迟是否增加 | C 输入比 B +56.9%，SDK 估算费用 +34.7%；本次串行任务耗时 -10.2%，单次样本波动不能证明更快 |
| Guard 误报/回归 | 既有模式、引用、事实、Style、Survey 回归通过；未发现新增确定性 Guard 误报。LIVE 未执行这些 Gate，Fact Reviewer 的漏报/弱归因仍在 |

由于实效未达到目标且成本增加，生产 Writer/Outline/Reviewer 改动已撤回。候选源码与测试保存在公开 patch 和私人归档，方便独立复现失败；没有降低阈值、删除负例或把失败样本移出统计。既有 Style `suggest_only` 未改，Revision 补公式、Baseline/Ours 归属和数据库均未处理。

## 5. 隔离执行、测试与发布

SSH 使用家庭电脑已有专用新加坡配置。服务器使用独立 repo / candidate 目录与仓库外数据根，复用现有 Node 22、PyMuPDF 镜像及 lockfile 依赖；不新装依赖、不发布端口、不改正式服务与原有数据卷。仅在服务器隔离数据根内复用授权，凭据未导出。

复用 `scripts/acceptance/linux-checks.sh`：后端 typecheck/build 与 Vitest 串行，2 CPU、最多 2 workers。候选 **3094 通过 / 22 跳过，281 文件通过 / 8 跳过，149.99 秒**；typecheck/build 通过。撤回候选后，最终交付代码另重跑同一检查：**3091 通过 / 22 跳过，280 文件通过 / 8 跳过，155.44 秒**，typecheck/build 通过。GitHub 发布状态见本轮最终汇报及私人日志，避免把候选结果冒充最终 HEAD 检查。

前端代码未改，服务器额外 typecheck/build/test **334/334，通过 33 文件，31.22 秒**。`node --check`、`git diff --check`、候选 `git apply --check` 通过。源码版本核对区分 CRLF 与 LF，不将换行差异视为内容变更。

首个 LIVE 初始化失败保留；首次 checks 启动因一次性 shell 的 CRLF 在 `pipefail` 处退出，规范化该私人脚本行尾后另存启动日志再跑，未丢弃失败记录。没有业务测试失败被隐藏。未验证真实论文公式、数值与重要引用去重安全，因为本样本没有实验数值或公式；相关确定性守卫仅由既有回归覆盖。

本次提交范围为报告、研究索引、通用串行验收脚本、公开输入与失败候选 patch；main 提交并 push，最终 HEAD/origin/main、clean、GitHub CI 与 Linux Integration 必须按该提交检查，不能沿用基线绿色状态。

## 6. 实际 Token、估算成本与耗时

| 阶段 | input | output | cache read | SDK estimatedCost | 任务秒数之和 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 开发 A | 7335 | 1630 | 16256 | 0.02166756 | 42.219 |
| 开发 B | 10427 | 1581 | 26048 | 0.02832668 | 36.792 |
| 最终 A | 8105 | 1732 | 17792 | 0.02359372 | 40.266 |
| 最终 B | 10680 | 1702 | 26240 | 0.02926320 | 39.758 |
| 最终 C | 16753 | 1568 | 34880 | 0.03942220 | 35.721 |
| 候选三路 Review | 8610 | 4843 | 2624 | 0.03404544 | 59.587 |
| 合计 | **61910** | **13056** | **123840** | **0.17631880** | **254.343** |

cache write=0；输入+输出 **74966**，含缓存读取合计 **198806**，不能重复累计 contextTokens。任务时间之和约 **4 分 14 秒**，不包含工程审计、构建、传输与 CI 等待。SDK estimatedCost 不是实际账单，工具未提供提供商实收账单或 Codex 工程会话 Token/成本；不能用验收增量冒充总工程费用。

私人根 `D:\PaperTeamData\M13_7_3` 保存所有 A/B/C 原文、逐章 prompt、失败记录、usage、版本 manifest、模型预算、构建与测试日志。归档只收集白名单实验产物，排除 runtime auth / 模型设置 / projects；公开 Git 不含私人原文或授权数据。

## 7. 下一轮方向

1. 优先研究论述责任规划：在写作前确定定义/机制主要展开章节，把其他章节约束为概括或承接；验证模型是否真正执行，不继续单纯增加前文摘录。
2. 单独建立带公式、文献数值、负结果和必须重复限定的去重安全样本；采用新的未见主题作最终验收。本轮 frozen 只能作为已知回归样本。
3. 为跨章节 Reviewer 问题保留可执行的一节目标与另一节逐字证据，区分重复与事实冲突，再验证 scoped Revision + Guard + 复审完整闭环。
4. 在真实长篇 workflow 中验证会话轮转、Survey synthesis 多源论述、审稿 digest 后部可见性和 citation semantic 模式；本轮不声称这些已验证。
5. 改进具体机制句的 quote 覆盖核对。摘要未给出的检索/训练细节不能以“合理阐释”放过，也不能借免责声明免除事实支撑责任。
