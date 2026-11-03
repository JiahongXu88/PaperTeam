# 发表目标配置与证据驱动审稿策略：产品最小闭环收口

```
PUBLICATION TARGET + REVIEW POLICY: COMPLETE（零模型验收；真实模型行为 NOT_EVALUATED）
起始 HEAD: 3f5304a9958c25a46c60c8994c6b40f436b3b877（HEAD == origin/main == ls-remote，工作区 clean）
真实模型调用: 0/12 · 完整生产工作流: 0/1
未启动 M17: CONFIRMED
```

- 日期 2026-11-03 · 执行 Claude（Opus 5.5）· 仓库 `D:\Projects\PaperTeam`（直接在 main 上，无新分支）
- 仓库外临时产物：`D:\PaperTeamData\PublicationTargetPolicy\`（编辑脚本、隔离 E2E 栈的项目 / 运行目录、验收截图 2 张）；未写入任何 M15 / M16 冻结目录。
- 本文是本轮唯一新增报告；历史报告未修改。最终 commit / CI 状态见文末「交付」一节。

## 1. 审计摘要（编码前）

### 1.1 现有能力（复用，不平行重建）

| 面 | 真实入口 | 结论 |
|---|---|---|
| 项目定位字段 | `ProjectStore`：`documentType` / `targetProfile`（自由字符串 12 档建议值：`core_journal` / `top_journal` …）/ `targetVenue`（自由文本）| 无体系、无层级校验、无年份、无期刊身份；`targetProfile` 只以「结合目标档次标准执行（目标档次：X）」一句进入 **digest 模式** academic prompt；**单元审查与整稿综合审查完全看不到目标** |
| 期刊事实 | `target/journal/`：内置 CJIG / PLOS ONE profile（`target-journal-profile/v1`，逐句官方原句 + 来源 + TTL + 原句回放）、`journal-assessment/v1`（五态，不产 passed、不预测录用）| 已是「期刊事实」的唯一来源；`indexing[]` 带 `SELF_DECLARED` / `UNVERIFIED` |
| 审稿 | `review.run`（`workflow/definitions.ts`，idea_to_paper / existing_paper_improvement / topic_survey / thesis 四个工作流共用）→ digest 三路 `reviewAll`，或长文档 `reviewUnit` × N → `reviewCrossChapter` → `reviewWholePaper` | 一个接线点覆盖四个工作流；**快速 Review（existing_paper_review）走 PDF SectionReview 链路，不经 review.run** |
| 稿型 | `reviewProfile: "survey"` 只换 digest academic rubric；整稿 prompt 恒为研究论文口径（强基线 / 消融 / 实验充分性）| 综述 / 学位论文在整稿审查中被套用研究论文口径（缺口） |
| QualityReport | `quality-report/v1` L0–L4；L4 恒 UNVALIDATED；`buildQualityReport` 单入口 | 不知道本轮审稿用了什么目标 |
| 修订与终止 | `revision.plan`：外部意见 mandatory；critical / major finding planned；minor skipped。`planSharedTail`：任务层 PASS → REVISION_TASK_COMPLETE 直接完成；STALLED / REGRESSED / 无可派发 → `hitl.revision_stalled`；轮数预算 → overflow；`revisionTask` 与 `publicationReadiness` 已分层 | 终止状态机已完整（无需新建）。**缺口**：整稿综合审查的 major（`origin=whole_paper_synthesis`，恒 AUTHOR_CHECK_REQUIRED 的主观建议，常需新实验 / 新文献）会被当作必修 Writer 任务派发 |
| Run 冻结 | `WorkflowState.request` 随 checkpoint 持久化 | 无政策快照；审稿每轮现读 `project.targetProfile`（运行中改设置会漂移） |
| M16 守卫 | 严格 JSON 解析 / 不回退碎片、整稿预算预留、`coverage.wholePaper`、locator 三态、证书入口 | 本轮不触碰 |

### 1.2 最小改动与数据流

```
项目设置 publicationTarget（publication-target/v1，体系内校验）
  └─ WorkflowOrchestrator.createRun → freezeReviewPolicy → WorkflowState.reviewPolicy（review-policy/v1，checkpoint 持久化）
       └─ review.run 只读 ctx.state.reviewPolicy
            ├─ reviewUnit：单元政策块（只含 unit/both 作用域维度）→ 进入请求指纹
            ├─ reviewWholePaper：按稿型替换问题类别 + 冻结目标 + 纪律；要求 policyDimension
            ├─ reviewAll（digest）：设置了目标时替代旧「目标档次」行（只 academic）
            └─ ReviewSummary.reviewPolicy（摘要）
                 ├─ quality.gate → QualityReport.binding.reviewPolicy + L4 文案（不参与任何判定）
                 ├─ revision.plan：冻结政策的 run → 整稿 AI 建议 skipped（下一轮可选改进）
                 └─ revision.report：新增「零、本轮目标与终止」五问段
  Journal Assessment：请求未指定期刊 → 沿用项目目标期刊（已核验 id 或自填名）
```

### 1.3 不做的内容

录用预测 / 分数线 / 「达到某分区」判定；分区数据库接入或爬虫；新的 Reviewer / Issue Ledger / QualityReport；新状态机或全局阈值变更；快速 Review（PDF 只读链路）接入政策；Pi / provider / 模型配置改动；M15/M16 实验重跑。

## 2. 数据契约

### 2.1 `publication-target/v1`（`backend/src/review/publicationPolicy.ts`）

| 字段 | 规则 |
|---|---|
| `scheme` | `none` / `chinese_index` / `cas` / `jcr`。`sci`/`scie` → 400「请在 cas 与 jcr 之间选择」；`ei`/`scopus` → 400「不是 SCI 分区」；`cscd`/`pku`/`core` → 400 引导到 `chinese_index` |
| `tier` | 体系内校验：`chinese_index` = PKU_CORE / CSCD / CSSCI（三个独立体系，不排序）；`cas` = 1–4；`jcr` = Q1–Q4（大小写归一）。跨体系层级 → 400 |
| `schemeYear` | 可选整数 1990..当前年+1；只记录意图 |
| `targetJournalId` | 必须是内置已核验 profile 的 id；与 `customJournalName` 互斥 |
| `customJournalName` | ≤200 字、无控制字符；**从不借用同名 profile 的事实** |
| 其他字段 | 拒绝（例如 `passThreshold`） |

存储：`project.json.publicationTarget`（缺省 = 未设置）。读路径防御：损坏 / 旧 schema → 丢弃该字段、项目照常可读。PATCH：对象 = 设置、`null` 或 `{scheme:"none"}` 无期刊 = 清除、缺省键 = 不修改；校验失败不进写锁、不落盘。`POST /api/projects` 与两个 import 入口经同一 `readResearchMeta` 接受该字段。旧字段 `targetProfile` / `targetVenue` 保留不动（Researcher / Feasibility / Benchmark 仍消费）。

### 2.2 层级事实（`tierFactOf`）

- `NOT_SET`：未设置层级。
- `USER_TARGET_UNVERIFIED`：**CAS / JCR 恒为此值**（系统未接入分区数据）；中文收录体系若无已核验 profile 自述同样为此值。
- `JOURNAL_SELF_DECLARED`：仅当「中文收录体系 + 已核验 profile + 官方页面自述（SELF_DECLARED，含原句与来源）」三者同时满足；文案明确「这是期刊自述，不代表本系统核实了最新名单」。例：CJIG + CSCD → 自述；CJIG + 北大核心 → profile 中为 UNVERIFIED → 不升级。

### 2.3 `review-policy/v1` 快照

`{policyVersion: "publication-review-policy/1", frozenAt, articleType: research|survey|thesis, articleTypeSource, target, targetJournal, tierFact, emphasis, focus[], baseline[], active, policyHash}`。

- `articleType` 与路由同源：`workflowKindForDocumentType(documentType)` 或 `workflowKind`（topic_survey → survey，thesis_from_papers → thesis，其余 research）。不改变 workflow 路由。
- `active = articleType ≠ research || target ≠ null`。**研究论文 + 无目标 → inactive → 所有 prompt 与请求指纹逐字节不变**（增量复审缓存不失效）。
- `policyHash` 不含 `updatedAt`；目标变化 → hash 变化 → 单元请求指纹变化 → 下一 run 重审受影响单元。

## 3. Rubric registry（受控、typed）

| 组 | 维度（id） | 作用域 |
|---|---|---|
| 底线（任何目标逐字相同） | fact_data_consistency / citation_reliability / locatable_evidence / method_evidence_match / honest_uncertainty | both |
| 研究论文 | contribution_boundary(W) / strong_baselines(W) / comparison_fairness / ablation(W) / experimental_setup_statistics / reproducibility / claim_result_match | W=整稿，其余 both |
| 综述 | coverage_scope(W) / search_inclusion_criteria(W) / representativeness_recency / taxonomy(W) / cross_study_synthesis / evidence_based_gaps(W) | — |
| 学位论文 | chapter_organization(W) / cross_chapter_consistency(W) / material_figure_provenance / version_fact_conflicts / argument_depth(W) | — |

发表目标 → `emphasis`（只改关注点**排序**与一句启发式说明，不改维度集合、不改底线）：

| 目标 | emphasis | 研究论文前置维度 |
|---|---|---|
| 未设置 | generic | registry 顺序 |
| CAS 1–2 / JCR Q1–Q2 | elevated | contribution_boundary, strong_baselines, ablation |
| CAS 3–4 / JCR Q3–Q4 | standard | claim_result_match, experimental_setup_statistics, reproducibility |
| 北大核心 / CSCD / CSSCI | domestic_index | contribution_boundary, experimental_setup_statistics, reproducibility（明示三体系独立、不比较高低） |

每个 active prompt 都附三条纪律：目标不是官方硬性标准 / 不设分数线 / 不预测录用；未出现在本文、已核验证据或检索结果中的「近期强基线」只能写「建议核对」，不得编造题名 / 年份 / DOI；需新实验 / 数据 / 作者判断的意见要写明且不要求虚构结果。综述额外：「无原创实验不是缺陷」；学位论文额外：「不套用单篇期刊论文规则」。

角色分工：单元政策块只列 unit/both 维度并声明「整稿层面的贡献 / 实验充分性 / 跨章问题由整稿与跨章审查负责」；整稿替换为 whole/both 维度清单并要求 `policyDimension`。`parseIssues` 只接受 registry 内 id（伪造 id 丢弃），**不改变 severity / blocking / verification**——整稿 finding 仍恒为 `blocking=false` + `AUTHOR_CHECK_REQUIRED`（L2）。

## 4. 生效范围

| 入口 | 是否生效 |
|---|---|
| idea_to_paper / existing_paper_improvement / topic_survey / thesis_from_papers 的 `review.run`（digest 与长文档单元 + 整稿） | ✅ 读 run 冻结快照 |
| 跨章一致性审查 | 不注入（只查跨章冲突，与目标无关） |
| fact / style 模式 | 不注入（底线与表达质量与目标无关；测试锁定逐字节不变） |
| 快速 Review（existing_paper_review，PDF SectionReview 链路） | ❌ 未接入（见 §9） |
| Journal Assessment | 请求未给期刊时沿用项目目标期刊；已核验 → 官方规则逐条；自填 → `JOURNAL_PROFILE_UNVERIFIED`、0 条规范 |
| QualityReport | `binding.reviewPolicy`（展示）+ L4 文案；**overall / finalizable 与无政策时完全相同**（测试锁定） |

## 5. Snapshot 与终止

- **冻结**：`createRun` 时 `freezeReviewPolicy(project, kind, now)` 写入 `WorkflowState.reviewPolicy`，随 checkpoint 原子持久化；`review.run` 只读快照（`readReviewPolicySnapshot` 防御：字段损坏 / 版本不符 → null = 旧行为）。T7 测试：run 暂停于 HITL 时把目标从 CAS 二区改为 JCR Q4 → 本 run 前后两轮都看到 CAS 二区、hash 不变；之后新建的 run 看到 JCR Q4。
- **旧评估不误用于新稿**：沿用既有机制——单元请求指纹含原文与政策；Journal Assessment 绑定 `manuscript.revision`（修订报告中若评估修订 ≠ 当前修订，明确提示「已过期，需重新评估」）；`convertToRevision` 的 409 陈旧拒绝不变。
- **终止（复用既有状态机，未改阈值）**：本轮唯一行为变化——冻结了政策的 run 中，`revision.plan` 把 `origin=whole_paper_synthesis` 的 finding 记为 `skipped`（note：「整稿 AI 学术建议（待作者核验）：进入下一轮可选改进清单，不自动派发 Writer」），不论 severity。已定位的 fact / citation / 单元 finding、外部意见（mandatory）、事实 / 引用回归派发均不变。若本轮剩余可派发为 0，沿用既有 `hitl.revision_stalled`（作者决定接受 Draft / 再修一轮），不会空转。旧 run（无快照）计划与升级前一致（测试锁定）。
- **REVISION_COMPLETE ≠ PUBLICATION_READY**：沿用 `revisionTaskVerdict` / `publicationReadiness` 分层；WorkflowPanel 在任务层 PASS 时追加一句明示；修订报告第零节同样写明。

## 6. 修订报告「零、本轮目标与终止」（`review/revisionGoalSummary.ts`，纯投影）

1. 本轮要解决什么：外部意见条数（并声明其优先于发表目标）+ 冻结政策版本 / hash / 稿型 / 目标与事实状态 / 关注点。
2. 已用可复核证据解决 vs AI 建议：指令状态机 handled/already_satisfied 计数；任务层判定（+ 投稿就绪层独立判定）；L2 AI 建议条数；L1 已证实失败条目。
3. 需补实验 / 来源 / 作者决定：conflict / unresolved / partially_handled 意见；`EXTERNAL_DATA_REQUIRED` 或建议补实验的 AI 意见（「系统不会虚构结果」）；任务层 AUTHOR_DECISION 原因。
4. 期刊投稿规范差距：只来自 `journal-assessment.json` 的 VIOLATED 官方条目（官方明确要求 / 官方建议 + 来源 URL）；资料未核实 → 不生成条目；评估修订过期 → 明示。
5. 下一步优先：已证实 → 未闭环外部意见 → 期刊官方阻断条目 → 按冻结关注点排序的 AI 建议。

## 7. 前端

- `PublicationTargetFields`（新组件，复用既有 `form-grid` / `field` / `field-help`）：体系 → 层级 → 年份 → 期刊（已核验 / 自填）；选项全部来自 `GET /api/publication-target/options`。接入「创建新论文 · 研究论文」（新增「发表目标（可选）」分组）、「综述论文」（折叠选项）、「修改已有论文」（高级选项，附「你的审稿意见优先」说明）。学位论文创建入口未加（学位论文不投期刊；稿型政策仍按 documentType 生效）。
- `PublicationTargetCard`（项目概览「研究定位」内）：当前目标、未核实提示、最近一次 run 冻结的政策、编辑态「新设置只影响下一次审稿 / 修订运行」。
- `QualityReportLayers`：显示 `binding.reviewPolicy` 与「不预测录用、不证明达到某分区 / 期刊学术水平」；旧产物无绑定 → 不显示。
- `WorkflowPanel`：任务层 PASS 时追加「返修任务完成 ≠ 投稿就绪 / ≠ 达到发表目标水平」。
- 无任何基于 tier 的前端成功徽章；所有状态文案取自后端字段。
- 截图（仓库外）：`D:\PaperTeamData\PublicationTargetPolicy\shots\01-create-publication-target.png`、`02-project-publication-target.png`。

## 8. 测试（实测）

| Gate | 用例（文件） | 结果 |
|---|---|---|
| T0 向后兼容 | 无目标研究论文 → 单元 / 整稿（中英）/ digest prompt 与无政策逐字节一致；旧 checkpoint / 损坏快照 → null；真实 `review.run` 旧 run 与 inactive 快照的全部调用 prompt 集合相同；旧 project.json 可读（`publicationTargetPolicy.test.ts` / `wholePaperSynthesis.test.ts` / `publicationTargetSnapshot.test.ts`） | PASS |
| T1 配置校验 | CAS≠JCR；SCI/EI/CSCD 引导；中文三体系独立；年份 / 互斥 / 未知字段；层级事实三态；自填名不借 profile；HTTP 400 不落盘（+ `publicationTargetHttp.test.ts`） | PASS |
| T2 Rubric 生效 | CAS 二区 vs JCR Q4 vs 北大核心关注点排序不同、底线相同、hash 不同；实际单元 / 整稿 prompt 内容断言；无「Q1≥90 分」/ 录用概率；policyDimension 白名单 | PASS |
| T3 稿型 | 研究 / 综述 / 学位论文映射；综述整稿类别不含基线 / 消融且声明「无实验不是缺陷」；学位论文不套期刊规则；真实 `review.run` 综述快照 → 单元与整稿 prompt 同一冻结政策 | PASS |
| T4 审稿与合规分离 | QualityReport overall 不受政策影响、L4 恒 UNVALIDATED；JA 已核验 / 自填 / 未指定三情形 | PASS |
| T5 修订终止 | 冻结政策 run：整稿 AI 建议 skipped、事实问题 planned；旧 run 不变；既有收敛 / stalled / overflow 测试全过 | PASS |
| T6 作者决策 | 报告五问：conflict 意见、需作者数据、未核实期刊、TASK_COMPLETE ≠ 投稿就绪、无录用措辞；既有 EditContract / Fact / Citation 测试全过 | PASS |
| T7 Snapshot | run 中途改设置 → 本 run 不变；新 run 更新；checkpoint 持久化 | PASS |
| T8 UI + API | 前端：创建发送 / 不发送 publicationTarget、项目卡、质量报告、无达标措辞（`frontend/test/PublicationTarget.test.tsx` 5）；Playwright `e2e/tests/publication-target.spec.ts` 3/3（scripted 栈） | PASS |
| T9 回归 / 交付 | 见下 | 见下 |

全量（本机 Windows）：
- Backend `npm test`（`vitest --maxWorkers=4`）：**441 files passed / 26 skipped；4850 tests passed / 47 skipped；0 failed**（skipped = 真实模型 / 环境门控 smoke，既有）。新增 3 个测试文件 25 例 + `wholePaperSynthesis.test.ts` 追加 2 例。
- Backend `tsc` typecheck + build：exit 0。
- Frontend vitest：42 files / 390 tests passed；typecheck + `vite build` exit 0（chunk-size 警告为既有）。
- Playwright（隔离 scripted 栈 :3100 + vite :5190）：`publication-target.spec` 3/3、`m15-target-journal.spec` 3/3、`m15-quality-report.spec` 2/2；`smoke.spec` 1-3 **失败（既有）**：首页标题「论文项目」10 月已删除，与本功能无关，未修。
- 真实模型调用 **0**；完整生产工作流 **0**。因此「真实模型是否遵守 policyDimension / 是否仍可能输出未经核实的文献名」= **NOT_EVALUATED**（prompt 纪律与解析白名单已由零模型测试锁定）。

## 9. 限制与剩余风险

1. **快速 Review（PDF 只读）不读取发表目标**：该链路走 SectionReviewService 的独立 prompt；要接入需另行设计（范围外）。UI 在快速 Review 项目中不展示发表目标卡；产品指南已写明。
2. **真实模型行为未评估**：关注点排序是否在真实输出中体现、模型是否仍可能点名未检索到的论文——纪律只在 prompt 层；没有新增「近期强基线」的检索调用（沿用既有受控检索管线，本轮未连接）。
3. **CAS / JCR 层级永远是「用户目标，未核实」**：未接入分区数据（按任务书范围外）；中文收录也只认两本内置 profile 的官方自述。
4. **emphasis 是启发式排序**，不是任何层级的官方标准，未经外部校准；QualityReport L4 维持 UNVALIDATED。
5. **整稿 AI 建议延后**只在冻结了政策的新 run 生效；若作者希望本轮处理某条整稿建议，需通过外部意见显式录入（mandatory，优先级最高）。
6. 旧 `targetProfile` 字段仍存在且仍进入 Researcher / Feasibility prompt；两个字段同时设置时，审稿以 `publicationTarget` 为准（digest academic 行被替换），其余 Agent 仍看旧字段。
7. 学位论文创建页未提供发表目标输入（可在项目概览设置）。

## 10. 回滚 / 兼容

- 无迁移：新字段全部可选；旧 project.json / checkpoint / review summary / gate 产物原样可读。
- 回滚 = 回退代码提交；已写入的 `publicationTarget` / `reviewPolicy` 字段在旧代码中被防御性读取忽略（`normalizeMetadata` 只保留已知字段；`WorkflowState` 多余字段无害）。
- 关闭开关不需要：未设置目标的研究论文 run 行为与升级前逐字节一致；如需完全停用，清除项目的 `publicationTarget` 即可（综述 / 学位论文稿型政策仍随 documentType 生效——这是本轮有意的行为变化，修复了整稿审查对综述套用研究论文口径）。

## 11. 交付

| 项 | 事实 |
|---|---|
| 代码提交 | `2865e152cd13d70611f1bdff7dbdfa099692a473`（35 files，+2530 / −30；推送前 fetch 确认 origin/main 仍为起点 3f5304a） |
| CI（2865e15） | `CI` run 41620463715 success |
| Linux Integration（2865e15） | run 41620463778：attempt 1 **failure**——`docling docker` job 构建镜像时 GitHub runner「No space left on device」（基础设施；同轮 `docling native` 真实全链 success）；只重跑失败 job，attempt 2 两个 job 均 success |
| 本报告 | 其后的 docs-only 提交；最终 HEAD / origin/main / ls-remote / 工作区与最终提交的 CI 状态见会话最终答复 |
| 分支 / MR | 直接在 main，无新分支、无 MR、无 force push |
