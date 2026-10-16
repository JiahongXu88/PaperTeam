# M14.6 — Thesis Quality & Evidence Closure（学位论文质量与证据闭环）

- 日期：2026-10-16 → 2026-10-17（北京时间 21:50 → 次日 00:30，连续一轮）
- 基线：`main @ b59bf0d45359a93aaa8bf773329a80cffe3f26bd`（M14.5 COMPLETE；执行前复核 HEAD = origin/main，工作区 clean）
- 执行位置：Windows 11 本机 `D:\Projects\PaperTeam`（全部开发 / 模型调用 / 测试 / PDF 编译在本机；未连接新加坡服务器，未使用 AutoDL / GPU / Docker；无额外 Git 分支）
- 研究数据（不入库）：`D:\PaperTeamData\M14_6\`（smoke/ 真实模型原始输出与判定、pdf/ 真实编译产物与文本层、logs/、scratch/、跨实验预算账本 `m146-global-budget.json`）
- 状态：**M14.6 COMPLETE（含如实边界，见 §18）**

---

## 0. 一页结论（任务 §十五 21 问）

| # | 问题 | 答案 |
| --- | --- | --- |
| 1 | M14.6 判定 | **COMPLETE**（§18 列出三项如实边界：实时检索的 grounding 段未真实跑、历史 Draft 的字面章号只能部分自动归一、bibtex 崩溃以 bibtex8 回退而非根因修复） |
| 2 | F5 是否经过真实模型复验 | 是：4 次真实 Reviewer 调用（1 基线 + 3 verify；fact 模式、产品同一 `reviewMode` 路径 + 同款 digest / policy 组合），原始输出全部落盘并可零调用回放判定（§3） |
| 3 | Reviewer 是否还会误判 75.37% | 不会（本轮 4 次实录 0 次）：claim 判 `SUPPORTED`，note 直接引用「与研究输入已确认事实一致（75.37%，来源 ri-be699de35f19 S001 p1，作者已确认）」。另加确定性反证器兜底：若模型再以「无实验数据 / 未授权」要求删值，finding 移出阻断口径、不进修订计划、不铸弱化授权（§3.4） |
| 4 | 无来源数值是否仍被阻断 | 是：反例 62.4% / 3.8 ms 被判 `evidence_gap/critical/blocking`、claim `UNSUPPORTED`，并明确「仅保留与已确认事实一致的 75.37%」（§3.3）；确定性侧反证器对不在事实表的数值永不反证（单测 + E2E 反例） |
| 5 | MissingMaterialLedger 是否完成 | 完成：类型 / 文件后端 / 确定性 A/B 类提案 / 幂等 upsert / 决定应用 / 版本失效（stale）/ 重评估 / 阻断判定 / HITL + HTTP + 前端面板 + 有界模型提案（§5–§7） |
| 6 | 案例 B 产生什么缺口清单 | 确定性：A 类 0 条（案例 B 无缺材料章——与 M14.5 判定一致）、B 类 1 条（Planner scopeConcerns「单一成果扩展、体量偏薄」）；模型提案 6 条（ch02 综述扩充 / ch03 数据采集与训练记录 / ch04 方法分析深度 / ch05 消融对比 + 结果维度 / ch06 展望依据）（§6） |
| 7 | 缺口是作者确认还是模型建议 | 全部 `proposed`（模型 / Planner 建议）；状态只能经作者决定改变；模型提案 0 条把 held-out 独有研究写成既定事实（§6） |
| 8 | HITL 能否处理 | 能：`hitl.author_decision` payload 新增 `materialGaps`，带 `gapId` 的决定经同一 resume 入口写入 `missing_material_decision` 并镜像 `writing_pause`；E2E 覆盖 proposed → write_as_limitation → 限制口径写出；HTTP `GET/POST /thesis/missing-materials` 与前端缺口面板（§7） |
| 9 | 双语摘要与关键词 | 正确：`thesis.abstract` stage（正文初稿后 1 次调用；Final 前刷新）→ 事实守卫零违规才写入 thesis.json；案例 B 真实正文一次生成即过守卫（中文 640 字 / 英文 342 词 / 关键词 5+5）（§8） |
| 10 | 摘要是否出现事实幻觉 | 否：守卫检查数值全部出自事实表 / 正文、中英一致；真实摘要含 75.37% / 0.1s / 1e-4 / 20,000 全为已确认事实；两条 advisory 诚实揭示「75.37% 在 rev-2 正文中已被 M14.5 误弱化为『显著降低』」（§8） |
| 11 | 参考文献是否从可核验来源生成 | 是（确定性闭环）：4 条 Crossref 实时核验的真实 DOI 作为正式 Evidence → Writer A 组 key → 正文 \cite → references.bib → `\bibliography` → citation.verify cited>0 / missing 0 / hallucinated 0 → 真实 xelatex+bibtex PDF 含参考文献条目（Hewing）（§10–§11）。实时检索到正式 Evidence 的 grounding 段未真实跑（预算），标记未验收 |
| 12 | 学术搜索 Provider 本地是否可用 | 可用：OpenAlex / arXiv / Crossref 直连 200（Semantic Scholar 超时）；探针两主题各 6 结果、8 候选、4 提升、全文 1 解析成功（29 chunk）/ 1 落地页 / 1 not_found；零模型调用。M14.5 零引用的直接原因是 testStack 缺省禁用全部 provider，不是生产配置缺失（§9） |
| 13 | PDF 是否实际包含摘要和参考文献 | 是：Part A 真实编译 PDF（PyMuPDF 文本层）含「摘要」「Abstract」「参考文献」与作者名 Hewing，0 个 `??`；Part B 案例 B 真实正文 PDF 含双语摘要、且 M14.5 被 `%` 注释吞掉的「幅度表明」整句恢复（§11） |
| 14 | 章节编号问题是否修复 | 根治路径修复：装配器为每章发 `\label{ch:<id>}`，Writer 收到全文章序并被要求以 `第\ref{ch:…}章` 引用；写作期与装配层对字面章号按标题确定性归一（强证据改写、弱证据只报告）。历史 Draft（案例 B rev-2）：「第五章为总结与展望」→ 第六章（正确）；「第四章为实验验证」因窗口同时命中两章二元组而**只报告不改写**（§12） |
| 15 | 工作流元注记是否仍污染 | 写作期确定性剥离高置信元注记（「依据本章的科研事实纪律」等）+ Gate 规则 `workflow_meta_notes_absent`；真实 Revision 候选 0 命中（§13） |
| 16 | 是否出现合法事实被错误弱化 | 本轮 0 次：真实 Revision 两次运行 `detectConfirmedFactRemoval` 均为空、75.37% 保留；候选级新增 `unauthorized_fact_removal`（已确认事实被删即拒绝）；gate 增加「上一修订存在 → 当前缺失」差分（§3.5） |
| 17 | 真实模型调用 / Token / 费用 | **8 / 10 次**；input 21,021 / output 10,075 / cacheRead 25,984 tokens；list-price 估算 **$0.081**（Z.AI Coding Plan 订阅渠道实际按量支出 0）（§14） |
| 18 | 全量测试与 PDF 编译 | 后端全量：见 §16（本节以最终清洁运行为准）；前端 36 文件 / 351 用例全绿；双端 typecheck/build 绿；真实 xelatex 两部分验收通过 |
| 19 | 新的主要遗留 | ① 实时检索 → 正式 Evidence 的 grounding 段未真实验收；② 历史 Draft 字面章号只能部分归一（新 Draft 走 \ref 根治）；③ MiKTeX bibtex 间歇崩溃（环境）以 bibtex8 回退；④ 摘要刷新只在 gate 通过路径执行（Draft 保留写作期摘要）（§18） |
| 20 | 是否值得重跑案例 B 端到端 | 值得（下一轮）：F5 / 摘要 / 引用 / 章号 / 百分号五项都已有确定性 + 真实 smoke 证据；建议以 ≤40 次调用、启用 OpenAlex + arXiv、保留本轮预算纪律重跑（§19） |
| 21 | Git / CI | 见 §20（提交后以 `git rev-parse` 与 GitHub Actions 实际状态为准） |

---

## 1. 基线 Git 与环境

- `git status --short --branch` → `## main...origin/main`（clean）；HEAD = origin/main = `b59bf0d4`。
- 本机：Node v22；MiKTeX 25.12（xelatex / bibtex / bibtex8）；Python 3.11 + PyMuPDF 1.28（PDF 文本层——mingw pdftotext 对 Adobe-GB1 字体集解码失败不可用）；无 Docker。
- 模型通道：Z.AI Coding Plan `zai-coding-cn/glm-5.3`（Pi 内置 provider；凭据在 `~/.paperteam/runtime/pi/agent/auth.json`，未打印、未入库）。
- 预算：跨实验总账本 `D:\PaperTeamData\M14_6\m146-global-budget.json`（上限 10 次 / 600k token；复用 M14.5 `GlobalBudgetLedger`，每个 smoke 以独立 experimentId 记账；重启不重置、失败重试不获新额度）。

## 2. M14.5 遗留问题审计（Phase A，只读）

五路并行只读审计（F5 事实上下文 / 摘要链路 / 证据与文献链路 / Writer 一致性 / 缺材料与 HITL）得出的实际缺口：

| 缺口 | 审计结论（改动前） |
| --- | --- |
| F5 事实口径 | `renderThesisFactPolicyLines` 只注入三路 digest 与单元 review；跨章一致性审查无事实块；**digest 模式尾句「稿件中的具体实验数值只可能来自『已授权进入工作流』的范围」未随 M14.5 更新**（单元模式更新了）；零实验包时 Experiment Policy 先输出「本项目当前没有已导入的实验数据……不得出现任何具体实验指标数值」再接事实表——同一 prompt 两条自相矛盾指令；事实行只含 surface + key，无 Fact ID / 来源锚点 / 核验状态；Revision Plan 没有任何「finding 与已确认事实冲突」的确定性检查，`needsEvidence` 条目自动铸造 weaken / remove 授权；`checkFactDrift` 把已确认值被删除判为 `absent`（不阻断） |
| MissingMaterialLedger | 不存在：`missingMaterialChapters` 每次重算、无持久化；`writing_pause` 决定只绑 chapterId 不绑输入版本；范围建议只有 storyline.scopeConcerns 字符串 |
| Abstract | Planner prompt 从不要求摘要；`thesis.json` 无 abstractZh/En；模板遇空直接省略摘要页；无任何 Gate / readiness 规则看摘要；无自动化 PDF 文本断言 |
| Bibliography | **testStack 缺省 `disabledProviders` 含全部学术 provider**（M14.3/14.5 驱动器跑在 testStack 上）→ evidence_supply 降级；生产栈缺省 OpenAlex + arXiv + 匿名 S2 开启；Gate 对 cited=0 无任何规则（`hallucinated_citations_zero` 与 `citation_structure_valid` 均 PASS） |
| Writer 一致性 | 装配器不发 `\label{ch:…}`；Writer 看不到章序、未被告知 \ref；元注记守卫只作用于修订候选（`REVISION_META_TEXT_PATTERN`）不作用于初次写作与 Gate；模板化表达无规则 |
| **新发现** | 真实 42 页 Draft（art-draft-rev2.pdf）中 Writer 写出的裸 `75.37%` 被 LaTeX 当注释起点：「误差降低 75.37% 的幅度表明，……」整句后半在 PDF 中消失（PyMuPDF 复核：「幅度表明」0 命中）——合法事实在编译产物中被静默截断，所有文本层守卫看不到 |

## 3. F5：实际根因与真实模型复验（Phase B）

### 3.1 根因
M14.5 修复后 prompt 仍存在三处口径不一致（§2 第一行）。真实失败形态（M14.5 run1/run2 实录）：reviewer 以「本项目当前没有已导入的实验数据 / 不在授权范围 / 仅见于外部来源」为由把 75.37% 判 critical+blocking，revision.plan 原样派发并铸造 `weaken_claim_strength` + `remove_unsupported_detail` 授权，修订改成「显著降低」。

### 3.2 修复（确定性）
| 改动 | 文件 |
| --- | --- |
| 统一口径块 `composeExperimentAndResearchFactPolicyLines`：有已确认事实 + 零实验包 → 不再输出「没有实验数据」行，改为「数据来源 = 研究输入事实表」；有实验包则并列；事实行统一渲染 `- 75.37%（error）｜事实 Fe3a…｜来源 ri-be699de35f19 S001 p1 B0004｜来源核验 verified｜作者已确认`（Writer / Reviewer / Revision 三方同一行；≤30 行） | `backend/src/thesis/researchFactPolicy.ts`（新）、`thesisWritingContext.ts`、`workflow/definitions.ts`（review.run / 跨章审查 / 修订纪律） |
| digest 模式尾句更新为「…或上述研究输入已确认事实；与已确认事实一致的数值不得判为无实验数据 / 未授权 / 仅见于外部来源」；跨章审查新增同一 policy 块与「多章复述同一已确认事实不是冲突」 | `agents/ReviewerService.ts` |
| 确定性反证器 `disconfirmFactFindingsAgainstResearchFacts`：A 全部特征数值 ∈ 已确认事实 ∧ B 理由为来源/授权缺失 ∧ C 删除/弱化动作针对该数值（±25 字符窗口含数值或数值类名词）∧ D 无「属授权 / 保留 / 表中仅有 / 与事实一致」承认措辞 → finding 移出 issues（不计 blocking/critical）、保留 disconfirmedIssues 并写 `disconfirmReason`、summary 新增 `researchFactDisconfirmed` | `thesis/factFindingDisconfirmation.ts`（新）、`definitions.ts` review.run |
| 已确认事实 → claim grounding 授权观测（与实验包观测同口径）：数值全部命中的 UNSUPPORTED claim 披露为 `author_experiment_data`，`deriveClaimGroundingWeakeningAuthorizations` 不再对其铸「数值只许删除」授权 | `factFindingDisconfirmation.ts`、`review/weakeningAuthorization.ts` |
| 候选级：`detectConfirmedFactRemoval(before, candidate)` → 已确认事实表面消失即 `unauthorized_fact_removal`（进既有 repair 通道，mustPreserve 点名该值）；Gate：上一修订存在、当前缺失 → `published_facts_zero_drift` 计为未授权变更 | `definitions.ts` revision.revise / computeThesisGateInput |
| 修订纪律新增「禁止删除上述数值；以无数据为由要求删值的意见不成立」 | `definitions.ts` renderThesisRevisionDiscipline |

### 3.3 真实模型复验（Smoke A，产品同一调用路径）
- 驱动：`backend/test/thesis/m146F5Reviewer.smoke.test.ts`（env 门控）；digest 由 run2 rev-1 的 `exp-tracking-results.tex` + `concl-summary.tex` 按 `buildManuscriptDigest` 同款格式构造；事实表 = 案例 B 11 条已确认事实；`ReviewerService.reviewMode({mode:"fact"})`。
- **基线（M14.5 口径，1 次）**：7 issues；75.37% 的 claims = `SUPPORTED` + `PARTIALLY_SUPPORTED`；唯一提及 75.37% 的 finding 明确写「75.37% 本身属授权数值，但机理解释未经核验」→ 要求弱化机理归因、保留数值。结论：M14.5 的事实表注入在 fact 模式**本次**有效；但 prompt 仍自相矛盾（§3.1），不可依赖。
- **verify（M14.6 统一口径，legit + counter，3 次含首跑）**：
  - legit：4 issues；claim「…高度跟踪误差降低75.37%」= `SUPPORTED`，note「与研究输入已确认事实一致（75.37%，来源 ri-be699de35f19 S001 p1，作者已确认）；正文亦恰当限定适用范围」；提及 75.37% 的唯一 finding 针对「实验顺利完成即表明满足实时性要求」的推断（合法意见），且括注「表中仅有参数与 75.37% 误差值」。
  - counter（注入「横向位置跟踪误差亦降低了 62.4%，NMPC 单步平均求解时间为 3.8 ms」）：5 issues；`evidence_gap/critical/blocking`「这两个具体实验指标数值不在研究输入已确认事实表内，也无实验包授权或已核验证据支撑」→「删除或弱化这两个数值表述；仅保留与已确认事实一致的 75.37% 结论」；claim 62.4%/3.8 ms = `UNSUPPORTED`；75.37% claim 仍 `SUPPORTED`。
  - 零调用回放判定（`PAPERTEAM_M146_F5_REPLAY`）：legit `misjudged7537=0 / asksToRemove7537=0 / productionDisconfirmed=0 / claims7537=[SUPPORTED]`；counter `counterHits=1 / counterClaims=[UNSUPPORTED]`。
- 产物：`smoke/f5-legit-baseline-20261016142603.json`、`smoke/f5-legit+counter-verify-20261016145147.json`（完整 prompt / 原始 issues / claims / usage）、`smoke/f5-replay-20261016155030.json`。
- 教训（记入测试注释）：smoke 判定器首版把「删除另一论断、保留 75.37%」的合法意见计为误判——判定口径已对齐产品反证器的 D 条件（同句 + 承认措辞）。

### 3.4 确定性回归（F5）
- 单测 `factFindingDisconfirmation.test.ts`（8）：M14.5 两条真实 finding 反证成立；62.4% 反例、机理归因（基线真实输出）、指标口径类、只要求补充说明、style 类、无事实时 → 不反证；CJK 相邻数字 / 千分位 / `\%` 转义形态匹配。
- 单测 `researchFactPolicy.test.ts`（4）：零包 + 事实 → 无「没有已导入的实验数据」行；无事实 → 与 `renderExperimentPolicyLines` 逐字节一致（非 thesis 项目零变化）。
- E2E `thesisFactFindingDisconfirm.e2e.test.ts`（2）：reviewer 以「无实验数据」要求删 0.724 → summary `researchFactDisconfirmed` 1 条、issue 移出、`counts.blocking=0`、修订计划无该条目、fact-authorizations 无该值、Writer 从未被要求删 0.724、原稿保留；反例 0.913 → 不反证、留在 issues、计划派发且 `mustPreserve` 含 0.724。
- E2E `thesisRevisionGuard.e2e.test.ts`（升级）：Review 建议 0.724→0.9 → **候选级** `unauthorized_fact_removal` 拒绝（patch-validation `rootViolationIds`）、原稿逐字节保留、`published_facts_zero_drift` 零漂移（此前要等 gate 才 FAIL）。

### 3.5 真实 Revision 复验（Smoke D，2 次）
合法意见「删除或弱化『远大于开销』的对比性判断，保留误差降低事实本身」+ M14.6 修订纪律 → `WriterService.reviseSection`：两次运行 `detectConfirmedFactRemoval` 均为空、75.37% 保留（3→2 次提及：被弱化的对比句本身含一次）、裸百分号 0、元注记 0。第二次运行 Writer 只返回了目标小节（1313→449 字符）——在产品路径这是 bounded logicalSpan 的单元替换形态；若作为整节修订则会被 `revision_content_loss` 守卫拒绝（本 smoke 只守事实，如实记录）。产物 `smoke/revision-2026101615{5821,0051}.json`。

## 4. Writer / Reviewer / Revision 事实上下文对照（改动后）

| 角色 | 入口 | 事实行 | 范围 | 额外 |
| --- | --- | --- | --- | --- |
| Writer（写作） | `buildThesisSectionContext` | `renderResearchFactLine`（Fact ID / 来源 / 核验 / 确认 / 冲突） | 本章 factIds ∪ owner 贡献 linkedFactIds | 源文本投影、章序 + \ref 纪律、继承表格 |
| Reviewer（三路 digest / 单元 / 跨章） | `composeExperimentAndResearchFactPolicyLines` | 同一行 | 全部已确认事实（≤30） | Experiment Policy 合成、尾句统一 |
| Revision（Writer 修订） | `renderThesisRevisionDiscipline` | 同一行 | 本章（无映射 → 全局） | 禁止删值 + 「无数据」意见不成立 |
| Revision Plan / Gate | 确定性 | — | 全部已确认事实 | 反证器 / 候选级删除拒绝 / gate 差分 |

`source_verified` 未确认事实只以计数 + 口径出现于三方，不自动升级（单测断言）。

## 5. MissingMaterialLedger 设计与实现（Phase C）

- 文件后端 `research/missing-material-ledger.json`（writeJsonAtomic + 每项目串行队列；ENOENT → 空；损坏 → `STAGE_CONTRACT_VIOLATION`）。
- 两类缺口：`planned_chapter_material`（A：消费 Planner `missingMaterialChapters`，不重算规则）、`proposed_scope_gap`（B：storyline.scopeConcerns 逐条，或有界模型提案）。
- 条目字段：`gapId`（`g-`+sha(type|chapterId|title) 稳定）、chapterId / contributionIds / sourceInputIds / title / description / whyInsufficient / supportingEvidence / requiredMaterials{kind,description} / canWriteWithoutMaterial / requiresExperiment / status / decisionId / decision / resolution / `sourceFingerprint`（含 outlineFingerprint + 输入 contentHash）/ `stale`。
- 状态：proposed → confirmed_missing / supplied / deferred / rejected → resolved；只有 `missing_material_decision`（新 AuthorDecision 类型，经 `ResearchInputService.submitDecision` 的同一作者决定链）能改状态；模型 / 系统只能 upsert proposed。
- 版本与恢复：指纹变化 → proposed 刷新内容、已决定条目标 `stale`（保留决定）；`reevaluate` 在章节获得可用事实后把 A 类置 resolved/facts_available；重复扫描幂等（created=0）。
- 接线：`thesis.evidence_supply` 同步台账（stage result `materialGaps`）；`hitl.author_decision` payload `materialGaps` + 选项扩展（`supply_research_record` / `supply_manuscript` / `confirm_missing` / `reject_gap`）；带 `gapId` 的 resume → `missing_material_decision`，对已规划章同时镜像 `writing_pause`（Planner 抑制与 Writer 限制口径都消费它）；决定后重评估。
- HTTP：`GET /api/projects/:id/thesis/missing-materials`、`POST …/missing-materials/:gapId/decision`。
- 前端：`MissingMaterialPanel`（研究材料工作台，紧接冲突块）+ `HitlPanel` 作者决定节点的缺口块（按类型给按钮；「缺口只有作者决定后才会影响写作；系统不会为缺失材料生成任何实验数值」）。
- 测试：单测 9（A/B 类派生、无误报、未知章拒绝、补材料→resolved、版本变化→stale、幂等、持久化、阻断判定）；E2E 3（HITL payload → gapId 决定 → 镜像 writing_pause → 限制口径写出；HTTP 决定 / 非法决定 4xx；幂等）。

## 6. 缺口清单真实案例（案例 B，Smoke B，1 次调用）
- 确定性：A 类 0（案例 B 的 ch05 实验章拥有含 75.37% 的 experiment_result 贡献且该数值已是作者确认事实——与 M14.5 §8 判定一致，不误报）；B 类 1（scopeConcerns）。
- 模型提案 6 条（全部 proposed、relatedChapterId ∈ 映射、各带 author_confirmation 需求）：ch02「补充四旋翼控制与气动扰动建模综述」/ ch04「扩展 NDP-NMPC 方法章节的分析深度」/ ch05「补充消融与对比性分析」+「扩展实验结果分析维度（目前仅单一指标 75.37%）」/ ch03「补充数据采集与训练过程的详细记录」/ ch06「补充展望方向」。
- held-out 独有主题（分布式编队 / 六自由度 / ROS / 参数辨识 / Minimum Snap / 微分平坦 / 悬停油门 / 多机仿真）在提案中出现 0 次完成时态陈述（`heldoutClaims=[]`）。
- 产物 `smoke/mm-proposal-20261016153800.json`。

## 7. HITL / Resume
- 同一 `hitl.author_decision` 节点，不建第二套状态机；`approve` 仍要求 Planner 缺材料章清零；gap 决定幂等（同 decisionId 不重复）；E2E 覆盖 proposed → write_as_limitation → completed，`author-decisions.jsonl` 同时含 `missing_material_decision` 与镜像 `writing_pause`，ledger 条目 `confirmed_missing/limitation`，`chaptersWithLimitationMode` 含该章。

## 8. Abstract（Phase D1）
- 新 stage `thesis.abstract`（正文初稿后、citation.verify 前；gate 通过且正文被修订后在 build 前刷新；Draft 路径不刷新、预算耗尽跳过——Draft 如实保留写作期摘要）。
- 输入：已确认研究主题 / 主线、已确认贡献、已写正文（有界投影）、作者已确认事实、限制口径章；`ThesisAbstractService.generate`（1 次 + ≤1 次修复）→ `checkThesisAbstractFacts` 守卫（数值须出自事实表 / 正文；中英数值一致；限制章不得写成完成；无 LaTeX / 元注记；关键词 3–6；长度）→ 零违规才写入 `thesis.json`；产物 `research/thesis-abstract.json`。
- Gate：`thesis_abstract_complete`（双语摘要 + 关键词齐备；缺失 → 结构不完整，Draft 仍可构建但不得标 Final/READY）。
- 真实（Smoke C，1 次）：案例 B rev-2 的 16 节真实正文 → attempts=1、violations=0、advisories=2（`number_not_in_body`：75.37% 出自事实表但 rev-2 正文已无该数值——正是 M14.5 误弱化留下的痕迹）；中文 640 字 / 英文 342 词；关键词「四旋翼；下洗效应；神经网络；非线性模型预测控制；轨迹跟踪」；数值 75.37% / 0.1s / 1e-4 / 20,000 全为已确认事实（Table II/III + 正文事实）；held-out 主题完成时态 0。
- 测试：单测 20（守卫各类违规、修复轮、解析拒绝）；E2E（`thesisBibliography.e2e`）断言 stage saved=true、`\chapter*{摘要}` / `\chapter*{Abstract}` 进装配产物；真实编译 PDF 文本层含摘要 / Abstract（§11）。

## 9. Academic Search / Evidence 实际配置（Phase D2）
- 本机直连探测：OpenAlex 200（2.7s）、arXiv 200、Crossref 200；Semantic Scholar 超时（生产栈 provider 熔断降级）。
- 根因：M14.3/M14.5 驱动器使用 testStack，其缺省 `disabledProviders` 含全部学术 provider → `thesis.evidence_supply` 报 `SEARCH_PROVIDER_NOT_CONFIGURED` 降级。生产 `buildServiceStack` 缺省启用 OpenAlex + arXiv + 匿名 S2，Unpaywall 仅在 `PAPERTEAM_OPENALEX_MAILTO` 存在时注册。本轮未改任何 provider 配置（无需凭据）。
- 实时探针（`m146LiveSearch.smoke.test.ts`，零模型调用）：生产同一链 `academicSearch → saveAcademicCandidates → promoteCandidate → tryResolveFullText → prepareSource`；两主题各 6 结果（含 10.1109/cdc49753.2023.10383632 即案例 B 小论文本身、10.1109/tcyb.2020.3043361、10.48550/arxiv.2411.06707 等）、8 候选、4 提升、全文：1 解析成功（29 chunk）/ 1「下载内容不是 PDF（落地页 / 付费墙）」/ 1 not_found；`groundClaims`（模型判定）未执行——正式 Evidence 0 为预期。产物 `smoke/live-search-20261016155612.json`。

## 10. Citation / Bibliography 生成（确定性闭环）
- 固定 fixture（`test/helpers/thesisCitationFlow.ts`）：4 条 2026-10-16 Crossref 实时核验的真实 DOI（Hewing 2020 Annu. Rev. / Shi 2022 T-RO / Preiss 2017 IROS / Li 2023 CDC）作为 `sourceRole=evidence` 来源 + `verified/fulltext/direct` Evidence（sourceId + chunk 锚点），**不伪造 DOI**。
- E2E `thesisBibliography.e2e.test.ts`：Writer prompt A 组 key 非空 → 正文 \cite 的每个 key 都在 `references.bib`（含真实 DOI，无 `10.1234/` 合成项）→ 装配 `\bibliography{references}` → citation.verify `citedCount>0 / missing 0 / hallucinated 0` → gate `thesis_citations_present` 通过（detail「正文引用 N 个 bib key」）。
- Gate 规则 `thesis_citations_present`：适用 = 有 literature_review 章或大纲声明文献主题；阻断 = 适用 ∧ 零引用 ∧ **已有可引用材料**（正式 Evidence 或 bib 条目）；无可引用材料（检索降级 / 候选未成正式证据）→ 非阻断但 detail 明示「学术引用缺口……零幻觉不等于证据充足，Draft 不得视为引用完整」（不以 Gate 掩盖检索配置问题，也不为过关插入无关引用）。

## 11. PDF 编译验收（真实 xelatex / bibtex；PyMuPDF 文本层）
`m146RealLatex.smoke.test.ts`（env 门控，零模型调用）：
- **Part A（产品路径）**：§10 闭环以 realLatex 栈跑完 build.draft → `pages` 真实 PDF：`摘要` ✓ `Abstract` ✓ `参考文献` ✓ 作者名 Hewing ✓ `??` 0。
- **Part B（案例 B rev-2 真实正文 16 节）**：裸百分号 3 处转义 → PDF 含「幅度表明」✓（M14.5 真实 PDF 中丢失）、75.37% ✓、注入 Smoke C 双语摘要 ✓、`??` 0、编译 8.2s；章号：8 处强证据改写（如「第五章为总结与展望」→ 第六章 ✓），36 处弱证据只报告（含「第四章为实验验证」：窗口同时命中 ch03「下洗」与 ch05「实验」二元组 → 歧义）。
- **环境缺陷与修复**：MiKTeX 25.12 `bibtex` 对该 aux/bib 以 0xC0000374（堆损坏）崩溃且零输出（12 次重复 10 次；ASCII 折叠后仍 5/8；`bibtex8` 0/12）→ `LatexCompiler`：TeX 工具链 stdin 一律 `ignore`，bibtex 崩溃码 / 零输出非零退出 → 回退 `bibtex8`（步骤全部记入 compile.log）。
- 产物：`pdf/partA-citation-closure.pdf|.txt|-verdict.json|-compile.log|-references.bib`、`pdf/partB-caseB-rev2-m146.pdf|.txt|-verdict.json|-assembly.json`。

## 12. Writer 章节编号修复（Phase E）
- 装配器：wrapper 章 `\chapter{…}\label{ch:<id>}`；promoted 章在首个 `\chapter` 行尾追加（行数不变）。
- Writer：`renderChapterOrderLines`（全文章序 + 本章标记 + 「以 `第\ref{ch:…}章` 引用他章，不写字面序号」）进入每节 prompt。
- 确定性归一 `normalizeChapterReferences`（写作期对 Writer 输出 + 装配层对产物副本；源 manuscript 不动，bounded Revision 基线不受影响）：完整标题 / 标题前缀命中 → 改写（序号不符一并报告）；仅独有二元组（弱证据）且序号不符 → **只报告**（案例 B 实测会把「第一章…数据采集」误改到 ch03，故收紧）；超界 / 歧义 → 报告。统计进 stage result（`writerConsistency` / `assemblyChapterReferences`）。
- ctexbook 下 `\ref` 渲染为中文数字（第六章），与原文风格一致。

## 13. 元注记与风格
- `stripWorkflowMetaNotes`（写作期）：高置信句（「根据当前 Workflow」「系统已完成本阶段」「需要用户确认后继续」「Agent 将进一步处理」「按照提示词要求」「科研事实纪律」「本轮检索」「待作者确认」…）且 ≤120 字、无数字单位 / \cite / \ref → 整句剥离并计数；中置信只报告；「本文提出的系统」「神经网络模型」「模型预测控制」不命中（单测）。Gate `workflow_meta_notes_absent`（高置信 0 命中才过）。
- `scanTemplatedPhrasing`：enumerated_summary（本章首先…其次…最后）/ formulaic_transition（通过上述分析可以看出…）/ repeated_opener（同连接词 ≥3 连句）/ generic_summary（无数值无引用的小结）→ review.run 追加为 **minor style finding**（D-0026：minor 只记录不自动修订）+ Gate advisory `templated_phrasing_reported`；不触碰数值 / 事实。
- 修订候选新增 `unauthorized_fact_removal`（§3.5）；风格建议仍走既有 bounded logicalSpan Revision。
- 新增 `escapeBarePercentAfterDigits`：Writer 写作 / 修订 / 润色输出中紧跟数字的裸 `%` → `\%`（§2 新发现的真实 PDF 截断根因）；`checkFactDrift` / 删除检测比对前把 `\%` 还原。

## 14. 真实模型调用与费用（跨实验总账本）

| 实验 | 调用 | tokens（in+out+cacheW） | 说明 |
| --- | --- | ---: | --- |
| m146-f5-baseline | 1 | 5,902 | Smoke A 基线（M14.5 口径） |
| m146-f5-verify | 3 | 11,500 | Smoke A verify（首跑 legit 1 + legit/counter 2） |
| m146-missing-material | 1 | 3,215 | Smoke B |
| m146-abstract | 1 | 5,026 | Smoke C（一次通过，无修复轮） |
| m146-revision | 2 | 5,453 | Smoke D（首跑断言过严 → 修正断言后重跑 1 次） |
| **合计** | **8 / 10** | input 21,021 / output 10,075 / cacheRead 25,984 | list-price 估算 **$0.0805**（订阅渠道实际按量支出 0）；0 次拦截 |

未执行：整篇论文重生成、A/B、多轮 Review/Revision、实时检索的 grounding（模型判定）。

## 15. 本地资源与耗时
- 单次真实调用 9–32s；真实 xelatex 编译 8–17s；后端全量测试见 §16；前端全量 14s；整轮墙钟 ≈ 2.7h。无 GPU；并发有界（vitest `--maxWorkers=2`）。

## 16. 确定性与集成测试

| 项 | 结果 |
| --- | --- |
| 新增单测 | factFindingDisconfirmation 8 / researchFactPolicy 4 / latexSanitize 3 / missingMaterialLedger 9 / chapterReferences 16 / workflowMetaNotes 10 / templatedPhrasing 11 / thesisAbstract 20 |
| 新增 E2E | thesisFactFindingDisconfirm 2 / thesisMissingMaterialLedger 3 / thesisBibliography 1；thesisRevisionGuard 升级为候选级拒绝 |
| 既有回归调整（行为变化，非放宽） | thesisDefinition（`thesis.abstract` 进前段；author_decision 选项扩展）、thesisConvergence（`thesis.json` 进修订快照 → review.snapshot 多出 rev-2，最佳版本 / 恢复号整体 +1）、thesisDocument / thesisRoutes（章标签同行）、thesis.e2e（章序行使每节 prompt 含「核心方法设计」字样 → 按「本章「…」」定位） |
| 后端全量（`npx vitest run --maxWorkers=2`） | 见 §16.1 |
| 前端全量 | 36 文件 / 351 用例 passed；typecheck ✅ |
| typecheck / build | 后端 ✅ / 前端 ✅（§20 记录） |
| 真实模型 smoke（env 门控，不进 CI） | A（4）/ B（1）/ C（1）/ D（2）全部最终通过；A 回放零调用通过 |
| 真实编译 smoke | Part A / Part B 通过 |
| 五类 Workflow | idea_to_paper / topic_survey / existing_paper_improvement / existing_paper_review / thesis_from_papers 全量套件绿（非 thesis 项目：policy 块逐字节不变、模板化扫描与元注记 Gate 只对 thesis 启用、`\%` 转义对全部 Writer 输出生效） |

### 16.1 后端全量测试
`npx vitest run --maxWorkers=2`（提交前清洁运行）：**346 文件 passed / 21 skipped（367）；3,736 tests passed / 0 failed / 38 skipped；328s**（skipped = env 门控的真实模型 / 真实材料 / 真实编译 smoke）。

## 17. 未完成问题（本轮如实边界）
1. **实时检索 → 正式 Evidence** 的 grounding（模型判定）未真实执行：实时检索验收标记为 **部分**（检索 / 候选 / 全文 / 分块可达；正式 Evidence 形成未验证）。引用闭环以 Crossref 核验的真实元数据 fixture 完整验收。
2. 历史 Draft 的字面章号只能部分自动归一（强证据 8 / 弱证据 36 报告）；新 Draft 依赖 Writer 侧 \ref 纪律 + 装配层标签（本轮确定性 E2E 覆盖 `\label{ch:` 存在，未真实模型复验 Writer 是否遵守 \ref 写法）。
3. MiKTeX bibtex 间歇崩溃为环境问题，以 bibtex8 回退处理，未定位 bibtex 内部根因。
4. 摘要刷新只在 gate 通过路径；Draft（质量未达）保留写作期摘要，修订后的正文变化不回写摘要。
5. `thesis_citations_present` 在无可引用材料时非阻断（设计选择：材料缺口不以 Gate 掩盖），因此「零引用」的 Draft 仍可能 qualityStatus=PASS——Gate detail 与 stage result 明示缺口。
6. Smoke D 第二次运行 Writer 返回了部分节（产品路径由 `revision_content_loss` 守卫兜底，本 smoke 未复现该守卫）。

## 18. 判定
**M14.6 COMPLETE**（§十 门槛逐项：F5 真实复验 + 反例阻断 + 三方一致语义 ✅；Ledger 持久化 / 有源依据 / A-B 区分 / HITL / 版本失效 ✅；双语摘要生成 + 守卫 + 编译 ✅；真实 Evidence → 参考文献 ✅、零引用不再视为充分 ✅、章号一致机制 ✅、元注记可识别 / 阻断 ✅；预算内 smoke ✅；确定性回归 ✅；五类 Workflow 兼容 ✅；未降低任何 Guard、未调 academicScore 阈值）。§17 第 1 项按任务要求明示为「实时检索验收未完成」。

## 19. M14 后续产品建议
1. 用 ≤40 次调用重跑案例 B 端到端（OpenAlex + arXiv 启用、`PAPERTEAM_OPENALEX_MAILTO` 配置 Unpaywall），验证：Writer \ref 遵守、摘要 Gate、引用 Gate、F5 反证器在整轮循环中的触发统计。
2. 实时检索 grounding 的小预算 smoke（≤4 次 judge 调用）把 §17.1 收口。
3. 缺口账本 → 作者补材料的回路：`supplied` 后触发 ResearchInput 导入 / 事实抽取并自动 `reevaluate`（本轮只做了状态与指纹语义）。
4. 章号：Writer 真实遵守率测量；对历史 Draft 提供「人工确认后批量改写」HITL。
5. bibtex 崩溃根因（MiKTeX 25.12）上报 / 固定 bibtex8。
6. PDF→Word、高校模板家族、Runtime 替换：保持登记不变（任务 §十四）。

## 20. Git 与 CI 状态

- 提交链（`main`，无额外分支）：
  1. `01eb6d82` feat(m14.6)：全部生产源码 / 测试 / 配置样例 / 文档 / 本报告（62 个文件）。GitHub CI **failure**（typecheck：env 门控 smoke 中 `pdfPages` 声明未使用——本机最后一次 typecheck 发生在该 helper 加入之前，属提交前验证漏项）；Linux Integration 被后续提交取消。
  2. `686eecb8` fix(m14.6)：修正该 helper 的使用。GitHub Actions：**CI success（run 38933325130，6m43s）**；**Linux Integration success（run 38933324892，6m55s）**——双绿。
  3. 本节记录提交（docs）：以最终 `git rev-parse HEAD` = `origin/main` 为准；该提交触发的 CI 在报告落笔时尚在运行，不在此宣称结果。
- 工作区：`git status --short --branch` → clean；`git diff --check` ✅。
- 交付产物（本机，不入库）：`D:\PaperTeamData\M14_6\smoke\`（f5 基线 / verify / replay、mm-proposal、abstract、revision ×2、live-search）、`D:\PaperTeamData\M14_6\pdf\`（partA 引用闭环 PDF + 文本层 + compile.log + references.bib；partB 案例 B rev-2 PDF + 文本层 + 装配报告）、`D:\PaperTeamData\M14_6\logs\`（后端全量 / 各 smoke / CI 运行清单）、`m146-global-budget.json`。

### 可复现命令（Windows 本机，backend/ 目录）
```
# 确定性回归（全量）
npx vitest run --maxWorkers=2
# F5 真实复验（2 次调用）与零调用回放
PAPERTEAM_M146_F5_SMOKE=1 PAPERTEAM_M146_F5_MODE=verify PAPERTEAM_M146_F5_SCENARIOS=legit,counter PAPERTEAM_M146_MODEL=zai-coding-cn/glm-5.3 npx vitest run test/thesis/m146F5Reviewer.smoke.test.ts
PAPERTEAM_M146_F5_REPLAY="D:\PaperTeamData\M14_6\smoke\f5-legit+counter-verify-20261016145147.json" npx vitest run test/thesis/m146F5Reviewer.smoke.test.ts
# 缺口提案 / 摘要 / 修订（各 1 次调用）
PAPERTEAM_M146_MM_SMOKE=1 PAPERTEAM_M146_MODEL=zai-coding-cn/glm-5.3 npx vitest run test/thesis/m146MissingMaterial.smoke.test.ts
PAPERTEAM_M146_ABSTRACT_SMOKE=1 PAPERTEAM_M146_MODEL=zai-coding-cn/glm-5.3 npx vitest run test/thesis/m146Abstract.smoke.test.ts
PAPERTEAM_M146_REVISION_SMOKE=1 PAPERTEAM_M146_MODEL=zai-coding-cn/glm-5.3 npx vitest run test/thesis/m146Revision.smoke.test.ts
# 实时检索探针（零模型）与真实编译验收（零模型）
PAPERTEAM_M146_LIVE_SEARCH=1 npx vitest run test/thesis/m146LiveSearch.smoke.test.ts
PAPERTEAM_M146_REAL_LATEX=1 npx vitest run test/thesis/m146RealLatex.smoke.test.ts
```
