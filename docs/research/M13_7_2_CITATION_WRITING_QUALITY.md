# M13.7.2 — Citation Intent & Academic Writing Quality

日期：2026-10-11。审计基线：`main @ a81176e1947415d76836714d23261d0518432609`。

本轮复用既有 A/B 证据分组、atomic claim × citation group、三档语义模式、Fact/Style Reviewer、Revision 与 Style Invariant Checker。没有新增生产依赖、数据库、平行 EvidenceStore 或默认自动润色；没有修改科研事实、补造公式或推断 Baseline/Ours 归属。

## 1. 根因审计

| 现有能力 | 实际断点 | 本轮修复 |
| --- | --- | --- |
| A/B 引用分组 | key 关联一条 Evidence 被误读为整篇来源可支持所有事实；metadata-only 可进 A | A 只表示来源关联；Writer 逐条消费 support/level/quote/chunk；metadata-only 不计入 A/覆盖 |
| Verified Evidence 注入 | Writer 的引文仅前 120 字，未展示 partial/direct；正确支撑句可能位于被截掉的后半段 | 引文有界扩展到 2000 字，展示强度和核验层级；partial.claim 不视为完整事实；Reviewer 同样获得引文 |
| 证据供给 | direct-first 后截断，单一来源可以占满快照 | 保留源内 direct-first，在截断前轮转不同来源；不强制凑引用、不修改 formal 资格 |
| 引用组语义核验 | 统一要求文献支撑命题；背景相关性和事实支持未分离；对立观点容易被误读 | 引用用途提示 + judge 的 intent/relevance 投影，原句保留归因；背景相关不生成完整支持 |
| 引用组溯源 | judge 引文一律附到第一条 evidence，其他组成员证据被丢弃 | 原始组证据全部保留；keyQuote 单独保存，不跨来源附写 |
| Claim Grounding | binding 只检查 formal，不核对绑定记录的支持质量 | 对不满足质量边界的绑定确定性纠正；partial 不能计完整 SUPPORTED，数值 partial 不绑定；保留原 reviewerVerdict 与纠正原因 |
| 数值修复候选 | 任意一个特征数值命中且允许子串匹配 | 所有特征数值须精确 token 命中；外部文献不能作为本文实验结果的修复依据 |
| 实验策略 | Outline、Writer、Experiment Policy 明文要求写“待补实验” | 禁止伪造结果不变；改为准确说明具体评测限制，内部授权状态不复制进正文 |
| 证据不足提示 | 推荐“有报道指出”“尚待验证”，与 transparent disclosure 分级叠加，容易形成重复免责 | 不用弱措辞包装未支持事实；集中表述科学限制；Reviewer 建议也遵守正文边界 |
| Style Polish | 默认 suggest_only；minor 不自动修订；apply_once 需用户选择 | 默认与选择语义不变；改善生成源头、既有技能与审查要求，增加来源边界守卫 |

另一个重要根因是触发策略：新 Review 的 `citationSemanticMode` 默认 **off**，所以“已有引用语义能力”不等于“该 Run 执行过语义核验”。历史 request 缺字段仍按 **full** 解释。本轮不擅自更改默认值，将用途和来源边界同时注入 Writer 与 Fact Reviewer；off 不会被包装成已完成语义核验。

主要调用链：Research Evidence Supply → EvidenceSelectionService → Writer；CitationIntegrityService → decomposition → group judge；Reviewer → Claim Grounding → Quality Gate / claim repair → Revision；显式 apply_once → style plan → Writer → invariants → 复审 / Gate / build。Quick Review 仍为只读。

## 2. 引用与证据语义

- **Citation Metadata Verified**：来源身份与书目真实性，不代表正文内容成立。
- **Evidence Verified**：某条有来源/锚点的记录通过核验；partial 仍为 partial。
- **Citation Relevance**：当前用途与来源相关。background 可以 relevant 且没有完整事实支持。
- **Claim Supported**：当前命题在对象、数值、机制、归因和范围上获得支持。仅完整 SUPPORTED 对应 `claimSupported=true`。

background 评价真实性与相关性；method 核对实际机制；result 需要对应结果证据；comparison 核对所转述观点而非要求文献赞同本文。本文实验结果另以本研究授权观测为据，不能用外部相关论文证明。

没有为背景新增“SUPPORTED 的另一种含义”。背景相关使用 relevance 独立呈现，事实 verdict 保持 INSUFFICIENT_EVIDENCE/info；明确不相关在 full 为 UNSUPPORTED，在 contradiction_only 保持其已有可用 verdict 范围。无摘要的 metadata-only 仍零 judge 调用，相关性未知，不伪造内容判断。

语义版本更新为 v6，使旧缓存不能冒充新用途核验；已有产物不删除。新增字段可选，旧 judge 三字段输出仍可解析。三档 mode、历史默认、Gate 阈值、引用冻结与事实保持纪律保留。Coverage 的 supportByKey 是来源级 direct/partial/other 计数，绝不是 claim-support 证明；原覆盖检查的强制开关不变。

## 3. 中文学术写作与风格边界

复用并补充 `academic-writing-zh`、`academic-style-zh` seed、Writer 和 Style Reviewer。区分内部检索/核验/授权记录与科研限制：删掉或不生成工作报告式注记，不等于删除负结果、尚缺评测或来源限制。方法说明实际方法，未来实验留在展望/局限性，不计为已完成贡献。

Style Invariant Checker 保留引用多重集、数字单位、公式、LaTeX 结构、术语和结论方向守卫，增加 `source_boundaries`：保守检查“仅、部分、摘要、全文、尚缺、尚未、负结果”等边界标记；“只在→仅在”允许同义归一。该检查是必要条件，不是语义等价证明，不能检测所有归因互换或同词反向改写；既有复审仍必要。

`scanStyleSignals` 新增 workflow_note，仅作为确定性测量，不当作 AI 检测分数，也不取代 Reviewer 或 Gate。不以单个 academicScore 宣称成功。

技能更新仍遵守 SkillRegistry 的既有版本固定语义：已安装 seed 变化默认只显示 update available，不自动覆盖用户安装版本。新增生成/审查纪律直接进入业务 prompt，既有安装也能获得本轮代码规则；若要消费新 skill 正文，需走已有技能更新入口。验收中的 baseline/current seed 目录分别固定，不修改服务器正式技能库。

## 4. 固定验收与服务器隔离

新增 `backend/test/citation/citationIntentWriting.test.ts`：固定中英文命题与证据，覆盖相关背景、无 Evidence 的背景不等于已证明、不相关真实文献、本文实验不能借外部论文证明、对立文献准确转述、partial 不升级、所有特征数字精确匹配、证据来源轮转、正文工作注记、科研限制保留，以及公式/数值/key/结论方向/来源边界守卫。既有 mode、Style Polish 选择与 Quick Review 回归继续运行。

SSH 使用家庭电脑的专用新加坡凭据与主机信任文件。所有 CPU 密集测试使用服务器独立 checkout 和仓库外数据根；没有覆盖正式环境或容器数据。复用既有 Node 22 / PyMuPDF 镜像与 lockfile 依赖，不安装新依赖、不发布新端口。真实模型 runner 无 HTTP 服务。

先对整理版 `scripts/acceptance/linux-checks.sh` 执行 bash -n / --help，随后实际运行其串行 typecheck/build/全量 Vitest，2 CPU、最多 2 worker、6/8 GiB 限额。前端另执行 typecheck/build/test。

首次定向验收 109 通过 / 5 失败：两个误报（正常“系统梳理了检索”及“只在→仅在”）已修正；其余为 digest/keyQuote 新契约的旧断言。首次完整运行 3080 通过 / 10 失败 / 22 跳过：4 项来自隔离副本缺根部署文件，补齐原基线文件；其余来自旧提示断言及一条缺 supportStrength 的 fixture，更新为明确的 direct/fulltext 条件。未降低阈值、删除负例或跳过失败测试。

修正轮后端 **3090 通过 / 22 跳过，0 失败**，typecheck/build 通过。之后 A 组提示进一步明确“本文实验以授权观测为据”，4 条旧提示字面断言相应更新；增加一个对比用途固定例。最终完整发布检查：**3091 通过 / 22 跳过 / 0 失败，280 文件通过 / 8 文件跳过，149.01 秒**；后端 typecheck/build 通过，最后用途/模式定向检查 **45/45** 通过。前端 **334/334、33 文件通过，26.77 秒**，typecheck/build 通过。`git diff --check` 与 LIVE 脚本 `node --check` 通过。

## 5. 真实模型前后对照

公开可复用脚本：[citation-writing-live.mjs](../../scripts/acceptance/citation-writing-live.mjs)。输入为仓库外已核验公开论文 Evidence；baseline 和 current 各独立输出，最多 14 次 run，每次 90 秒执行上限、100 秒取消信号，串行并发 1、只读工具，逐次保存 usage，不跑完整论文工作流，不做新的在线书目核验。

材料复用上一里程碑对公开 Transformer 论文获得的 direct/partial 两条真实记录：partial.claim 包含“无循环与卷积”，但逐字 quote 只明确“无循环、依赖注意力”。本轮不手工改成 direct，也不人工只选 direct 绕过 partial 问题。

首轮 14 次调用是 prompt-only 诊断（默认角色、无技能注入），不能当作完整生产角色链验收：

| 样本 | 基线 | 改进版 |
| --- | --- | --- |
| partial 正文 | “完全弃用了循环结构与卷积操作” | 仅写“摒弃了循环结构”，未扩写卷积 |
| 科研限制 | 小样本/跨域/开销限制保留，但附加未支持机制 | 限制仍保留，未复制本轮检索/作者确认/待补实验 |
| 相关背景 judge | SUPPORTED | background/relevant、INSUFFICIENT_EVIDENCE，未声称已证明 |
| 不相关背景 | 已为 UNSUPPORTED，没有 relevance 字段 | 保持 UNSUPPORTED，并独立标注 irrelevant |
| 本文结果借外部文献证明 | 已为 INSUFFICIENT_EVIDENCE | 未完整支持，独立说明 result 用途与来源缺口 |
| 对立来源归因 | 已正确 SUPPORTED | 保持准确转述，不因其不同于本文而报矛盾；首轮用途标签仍选 method，不能宣称标签完全准确 |

首轮仍发现：无 Evidence 的背景段落补写了具体机制。随后收紧背景段的句级自查提示，并修正验收脚本作用域。最终 14 次对照使用 writing/citation 生产角色，Writer 的两份中文技能进入可用清单；模型没有实际 read 技能正文（accessed=[]），因此这里证明的是角色、业务 prompt 与可用技能路由，不是技能正文消费或完整 workflow 验收。最终语义样本按真实记录的 fulltext 等级传入引文；首轮诊断将相同引文标为 abstract，不混作最终核验等级。

最终模型为服务器已授权的 `zai/glm-5.3`。结果如下：

| 固定样本 / 观察 | 基线 | 改进版 |
| --- | --- | --- |
| partial 正文超出 quote 的“无卷积” | 出现 | 未出现；仅陈述 quote 明示的无循环 / 注意力 |
| 方法与限制段超出 quote 的“无卷积” | 出现 | 未出现 |
| 无 Evidence 背景段 | 有具体架构与“广泛应用”表述 | 保留引用，未再补写具体计算机制，但仍有“广泛影响”等泛化评价 |
| 小样本、尚缺跨域、尚缺计算开销评测 | 保留 | 保留；未来评测没有变成已完成结果 |
| 相关背景 judge | SUPPORTED | background / relevant / INSUFFICIENT_EVIDENCE / claimSupported=false |
| 不相关背景 judge | INSUFFICIENT_EVIDENCE | background / irrelevant / UNSUPPORTED |
| 本文准确率借外部文献支撑 | INSUFFICIENT_EVIDENCE | result / irrelevant / UNSUPPORTED，未完整支持 |
| 对立文献准确转述 | SUPPORTED | comparison / relevant / SUPPORTED；没有把“不同于本文”判为矛盾 |
| workflow_note 表面计数 | 3 个 Writer 输出均为 0 | 均为 0，不能宣称本小样本已实证减少该问题 |

可确认的改善是 partial 来源边界、背景相关与事实支持分离、不相关来源拒绝、对比用途准确归因。不能声称所有表达问题消失：仍有“广泛影响”“新的基础”之类评价，partial 段同一文献出现两次引用；来源轮转解决供给集中，不保证长论文中引用分布最优。本轮没有跨章节长文去重的真实效果统计，也没有只根据一个 academicScore 判成功。

## 6. 命令、Token 与产物

主要命令：`git status/rev-parse/diff --check/fetch/archive`、`rg` / PowerShell 只读文件审计、`ssh` / `scp`、`bash -n` / `--help`、既有 linux-checks.sh、后端 `npm run typecheck/build` 与 `vitest run --maxWorkers=2`、前端 `npm run typecheck/build/test`、有界 LIVE 脚本、最后 `git commit/push` 与 `gh run list/view`。未新建分支。

私人样本、原始 prompt/模型输出/usage、测试日志和一次性服务器编排脚本保存在本机 `D:\PaperTeamData\M13_7_2`；服务器同样在 checkout 外。授权配置只在服务器隔离副本内复用，不导出密钥、不提交原始模型记录。公开 Git 仅包含业务代码、固定受控测试、通用验收脚本与脱敏报告。

真实模型增量 usage（两轮均 COMPLETED，14+14 次；28 assistant turns）：

| 指标 | 首轮诊断 | 最终角色对照 | 合计 |
| --- | ---: | ---: | ---: |
| inputTokens | 13574 | 14302 | 27876 |
| outputTokens | 1753 | 1594 | 3347 |
| cacheReadTokens | 12352 | 14208 | 26560 |
| cacheWriteTokens | 0 | 0 | 0 |
| SDK estimatedCost | 0.02992832 | 0.03073048 | 0.06065880 |

输入+输出 **31223**；加缓存读取 **57783**。这是增量合计，不能累加 contextTokens 作为账单；SDK estimatedCost 不等于实际账单。Codex 自身工程会话的总 Token/账单工具未提供，不以模型验收 usage 冒充总工程成本。

私人归档 `private-artifacts-v2.tgz` 包含原始测试日志、两轮输入/输出/usage、固定公开来源输入与编排脚本，排除 runtime auth 与个人模型配置；Windows/服务器 SHA256 一致。首次压缩包因一次性脚本末行 CRLF 产生带 CR 的日志文件名而无法在 Windows 完整展开；只重命名隔离测试目录内该日志文件并另存 v2 压缩包，未修改业务或丢弃失败日志。

实现与报告在 main 一并提交、推送；提交后的 HEAD/origin/main、工作树与对应 GitHub CI 状态见本任务最终汇报，避免把基线或前一提交 CI 冒充新提交结果。

## 7. 未覆盖与后续方向

- 未重跑 40 分钟全论文生成；没有验证私人论文全量质量，也没有证明投稿可用。
- 用途提示与自身结果识别含保守词面规则；复杂跨句归因、别名与隐含比较仍依赖模型审查。
- 来源级轮转提高快照多样性，不等于按章节最佳相关性排序；不强制把所有证据写进论文。
- partial 不完整支持的确定性纠正不会自动证明哪个子命题成立，仍须核对原文。
- Style 默认 suggest_only，不保证已有稿件的 minor 风格问题自动消失；应由作者选择 apply_once 后复审。
- 语义 off 不执行完整引用语义核验；metadata-only 背景相关性保持未知。没有以“无矛盾”冒充“已证明”。
- Style 边界扫描是保守哨兵，不是语义等价证明；正文中正常的同义表达可能要求人工/事实复审。
- Revision Planner 补公式、Baseline/Ours 归属与数据库重构均留待独立任务。
