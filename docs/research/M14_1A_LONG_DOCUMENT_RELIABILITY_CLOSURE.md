# M14.1a — Long-Document Reliability Foundation（收口报告）

- 日期：2026-10-14
- 基线：`cd2b92fd8d853e8546fc90fe2422ae7bbaa2724b`（M13 COMPLETE / Pre-M14 / M14.0.1 PARTIAL 之后）
- 范围：P0-1 长章节 logicalSpan 局部修改；P0-2 分章 Review 与可证明覆盖；P0-3 章节级幂等与中断恢复
- 方法纪律（本轮明确要求并执行）：**先复现、再最小修复**；复用既有 span / patch / journal / checkpoint 基础设施，不建平行架构；**禁止词法相似度猜测定位**；局部失败不得标成功；恢复必须核验输入指纹 + 输出哈希；100% coverage 只来自实际成功完成的审查

---

## 1. 初始审计与缺陷定位（先复现）

能力差距审计结论（对照 cd2b92f 源码，全部以 `git stash` 回基线复跑新测试验证失败）：

**已实现且可复用（不重复开发）**：
- `RevisionSpan` 契约 + `applyRevisionSpan` / `checkGlobalRevisionScope` / `checkRevisionScope`（`review/revisionScope.ts`）——不可变前后缀守卫、stale 哈希拒绝、原子拼接；
- 候选级 Guard 链（`definitions.ts` 修订循环）：fact preservation 六类违规、citation 增删、结构损伤、meta 文本、具名实体，全部候选提交前拦截 + 有界修复（≤2 次）；
- `PatchValidationRecord` lineage（`review/patchValidation.ts`）：patchId=原文哈希、attempt/parent、审计工件按修订号落盘；
- `mapWithConcurrency` + journal + 指纹复用模式（`paper/SectionReviewScheduler.ts`）——P0-2 的 journal 直接沿用该语义；
- Workflow checkpoint / `recoverInterruptedRuns` / revision commit 指纹幂等（P0-3 的恢复底座）。

**真实缺陷（本轮修复，均有基线复现测试）**：
1. **P0-1**：`WriterService.ts:1579` `slice(0, 12_000)`——>12k 章节尾部从未进入 prompt，而输出整体替换输入；outline/多文件章节目标是整文件覆写（`definitions.ts` `listRevisionTargets`），不经过任何候选级守卫；
2. **P0-1**：`locateLatexSections` 标题正则 `\{([^}]*)\}` 读不出嵌套花括号标题（`\subsection{MRG\mbox{-}DTM}`）；同名标题产生相同 logicalSection，`.find()` 永远命中第一个；
3. **P0-1**：目标不可解析时整 run fatal（`Revision target no longer resolves`）；章节 .tex 写入非原子（裸 `writeFile`）；
4. **P0-2**：`buildManuscriptDigest` `files.sections.slice(0, 24)` 静默丢弃第 25 个文件起；每节 3600 / 总 60k 截断——90k 文档约 2/3 正文从未进入 Review 而 gate 照常出全文分数；`ReviewSummary` 无覆盖字段；跨章问题无双位置；
5. **P0-3**：`writing.sections` 的 writing-plan 只记不读（`beginWritingPlan` 重置全部 planned），stage 重试重写全部章节——既有测试 `argumentUnitWriting.e2e.test.ts` 明确钉死 2+5=7 次 Writer 调用。

**复现验证**：`git stash` 回基线后运行新测试，10 个用例失败（12k 截断尾部丢失 ×2、定位器 ×4、整文件覆写/多 finding/兄弟 patch/unresolved ×6 中命中 6、同名标题 ×1）；恢复修复后全绿。

## 2. P0-1 最终实现

**契约**（复用 `RevisionSpan`，未新建编辑引擎）：`file` + `logicalSection`（章节 span id；单元为 `spanId#uN` / 合并 `#uM-N`）+ `originalHash` + `start/end` + 只读相邻上下文（前后 800 字，不入可编辑文本）。模型只产出**目标单元的完整替换文本**；定位、哈希、范围、应用、守卫全部确定性代码。

**流程**：`Finding → 展开长文件为 span/单元（expandLongFileTargets）→ 原文锚点绑定指令（resolveDirectiveUnit）→ 真实 Writer（单元文本 + 只读上下文，无截断）→ 既有候选 Guard 链 → applyRevisionSpan 原子应用 → PatchValidationRecord lineage`。

**关键决策**：
- 删除 `slice(0, 12_000)`；单元尺寸由 `partitionSpanIntoUnits`（段落块贪心装箱，不切 LaTeX 环境/显示公式）有界构造（默认 9000，`revisionUnitMaxChars` 可配）——**上下文仍然有界，不是把整章塞给模型**；
- 单元定位只认**唯一原文锚点**（targetQuote / 引号片段，空白不敏感、省略号分段）；缺失 / 多次出现 / 跨章 = `unresolved` 事件 + 计数，不派发、不猜（**无词法相似度兜底**——按本轮要求删除了初版的词法匹配）；
- 同 span 内重叠绑定合并为一个目标（一次调用），多条 targetQuote 区间两两重叠/嵌套时按并集授权，不相交仍拒绝（`REVISION_TARGET_QUOTE_UNRESOLVED`）；
- 严格 id 优先：指令 `logicalSection` 精确命中某 span 时不再经 heading/路径模糊匹配派给同文件其它 span（同名标题防误派）；定位器同标题副本 id 化（`#2/#3`）、平衡花括号读标题（与 `latexHeadings.ts` 同口径）；
- stale / 不可定位：fail-closed 记 patch 记录（`REVISION_TARGET_STALE/UNRESOLVED`）+ 跳过该目标（兄弟目标继续），同修订号既往工件**合并**不覆盖；不再整 run fatal；
- 同文件兄弟单元按内容重定位（前方插入偏移容忍）；单元自身内容变化 = stale；
- 章节文件写入全部 `writeFileAtomic`（tmp→fsync→rename）。

**Guard 不回归证明**：单元目标走**同一**候选校验环（scope/fact/citation/结构/meta/实体）与同一 `revision.validate` / gate；新增回归 `revisionFidelity`、`directMutationRecovery`、`structureGuard`、`existingPaper` 等 141 个既有用例全绿。

## 3. P0-2 最终实现与 Coverage 定义

**触发**：`digestIsLossy`（任一节 >3600 / 总量 >60k / 文件 >24——与既有 digest 预算同口径）为真 → 单元模式；否则**短论文行为零变化**（digest 三路 review，coverage 以 digest 模式完整记录）。

**单元模式**：每 Review Unit 一次有界全文审查（`ReviewerService.reviewUnit`，scope `review/academic/unit`；单元文本完整不截断，另附章节标题与全文档章节索引），per-unit journal 原子落盘 `reviews/review-units/r{round}/<unitId>.json`（含完整 outcome：issues + 分数）；同 snapshot + 单元指纹匹配的完成单元在 stage 重试 / 进程重启后**零模型调用复用**；单次跨章一致性审查（`reviewCrossChapter`，输入为各章 1200 字摘要，**非全文**；失败降级为无跨章 finding，不影响正文覆盖）。

**Coverage 定义（确定性）**：`computeReviewCoverage(plan, round, records)`——只把 `status=completed` 且 `snapshotId`（全文档文件哈希指纹）与单元内容哈希**双双匹配**的记录计入；单元彼此不相交、拼接零丢失，重叠上下文从不计入 targetChars，覆盖率不可能虚高。**100% = 计划纳入审查的目标正文范围全部由成功完成的 Review Unit 覆盖**；不证明模型理解了全部内容，学术质量由其余 gate 规则独立判定。产物：`reviews/review-coverage-r{N}.json` + `ReviewSummary.coverage`。

**Gate 集成**：新规则 `review_coverage_complete`（legacy 产物无字段 → `review_coverage_complete_not_applicable` 中性呈现）；`academic_score_threshold` 在覆盖不完整时**强制 FAIL**（部分视图分数不得推导全文学术质量）；分数本身 = 完成单元 academicScore/riskScore 的字符加权聚合（确定性、可追溯；无默认值填充）。

**跨章 Finding**：`ReviewIssue.relatedSections?: string[]` 双（多）位置；跨章 issue 强制 `blocking=false`（待核验，系统不自动把任一版本当权威——修复建议是核验步骤，不是改写）。

**修订语义不受破坏**：`Revision Task Complete / Publication Ready` 判定链路未改动；digest 模式（全部短论文与既有 e2e）coverage 恒完整。

## 4. P0-3 恢复机制

复用 runtime checkpoint / stage 重试 / revision 指纹幂等，只补齐**章节级**跳过：

- `WritingPlanSectionRecord` 新增 `fileName` + `outputHash`（完成时与落盘内容同构哈希）；
- `beginWritingPlan`：同 run 同指纹的既往 `written` 记录，仅当磁盘输出仍与 `outputHash` 一致时保留（否则回退 planned）——**输入指纹 + 输出产物双核验，缺一不跳**；
- 写作循环（idea 与 survey 两路径）：`resumableWrittenSection` 命中 → 零 Writer 调用复用（产物按原文件计入重复报告 / usage 统计）；stage 结果新增 `sectionsReused`；
- 既有测试 `argumentUnitWriting.e2e.test.ts` 的「重试全重写」断言（2+5=7）按 M14.1a 语义**有意翻转**为 2+3=5；
- revision 中断重放：目标按当前磁盘内容重定位；已应用单元产出等价替换 → `targetChanged=false` → 不落盘、不新增修订（stale/不可定位路径由单元级测试覆盖）。

**恢复边界（如实声明）**：覆盖优雅重启（stage 重试、`recoverInterruptedRuns` 重跑 stage）与进程硬杀（journal/计划/checkpoint 均原子写，崩溃不留半个 JSON；未完成 stage 从头重执行但已完成章节/单元被 journal 跳过）；磁盘级部分写由 tmp+rename 消除；**不**覆盖revision store 本身损坏（`REVISION_RECOVERY_REQUIRED` 既有口径不变）。

## 5. 主要代码变更

| 文件 | 变更 |
|---|---|
| `backend/src/review/logicalSpan.ts` | **新增**：编辑单元切分 / 唯一锚点解析 / 内容重定位 / 只读上下文 |
| `backend/src/review/coverageLedger.ts` | **新增**：覆盖计划 / journal 记录 / 覆盖计算（纯确定性） |
| `backend/src/review/revisionScope.ts` | `locateLatexSections`：平衡花括号标题、同标题唯一 id、短标题参数 |
| `backend/src/writer/WriterService.ts` | 删除 12k 截断；`unitContext` 只读上下文区块 |
| `backend/src/workflow/definitions.ts` | P0-1 展开/绑定/stale/严格 id/原子写；P0-2 单元模式 + journal + 覆盖产物；P0-3 恢复跳过（两路径）；quote 并集授权 |
| `backend/src/agents/ReviewerService.ts` | `reviewUnit` / `reviewCrossChapter` / `relatedSections` |
| `backend/src/review/ReviewAggregator.ts` | `ReviewSummary.coverage` |
| `backend/src/review/reviewArtifacts.ts` | unit journal / coverage 工件持久化；`fileName`/`outputHash` |
| `backend/src/quality/gates.ts` | `review_coverage_complete` + academic 强制联动 |
| `backend/src/runtime/scriptedRuntime.ts` | 新 scope 的 fake（unit / consistency） |
| `backend/src/serviceStack.ts` | `revisionUnitMaxChars` 装配 |

## 6. 测试与通过情况

新增 45 个用例 / 6 个文件：
- `test/review/logicalSpan.test.ts`（16）：切分零丢失、环境不切、锚点命中/歧义/缺失、stale 三态、同标题 id、合并边界；
- `test/review/coverageLedger.test.ts`（13）：lossy 触发矩阵、计划/指纹、覆盖只计完成、旧 snapshot 不计、跨轮 reused；
- `test/workflow/longChapterRevision.test.ts`（6）：30k 章节末尾修订逐字节保持、prompt 含尾部原文（无 12k 截断）、多 finding 合并、兄弟单元顺序应用、unresolved 不标成功、同名标题 #2；
- `test/workflow/longDocumentReview.test.ts`（4）：10 章 90k 全调度 + 尾部覆盖 + 100% + 加权分数 + 跨章双位置；失败注入 → 覆盖下降 + gate 拒绝；abort 中断 → journal 恢复复用且 finding 不丢；短文档 digest 兼容；
- `test/workflow/chapterRecovery.test.ts`（5）：断点续写、幂等重放、篡改重写、指纹失效全重写、revision 重放不重复修改；
- `test/workflow/m141aIntegration.test.ts`（1）：三 P0 串联闭环（review → 修订 → snapshot 失效全重审 → journal 恢复）。

更新既有断言：`argumentUnitWriting.e2e`（重试复用语义）、`GateApi`（规则集 +1）、`scriptedRuntime` 新 scope。既有 P0-1 相关回归 141 用例全绿。全量后端回归见 §8；`npm run typecheck`（前后端）、`npm run build`、`git diff --check` 通过。

## 7. 长文档规模与修改保持验证

- 12.5k / 20k / 30k 章节均验证（真实 stage 路径）：目标单元替换、单元外**逐字节不变**（含跨文件兄弟文件）、文件长度变化 = 精确注入长度；
- 章节头/中/尾独立修改路径由锚点任意位置覆盖（末尾锚点专项 ×4 用例）；
- 公式/引用/标签：切分不跨环境（`splitBlocks` 深度守卫）+ citation 增删守卫 + 结构损伤守卫三重保持。

## 8. Review 覆盖率与失败注入实测

| 场景 | 实测 |
|---|---|
| 10 章 × 9k（20 单元）正常 | coverage 100%（targetChars 全额 = 10 章全文），20 单元全调度，journal 20 文件 |
| Chapter 10 两单元失败 | ratio = 9/10 章字符比（精确到 1e-8），`failedUnits=2`，`review_coverage_complete` FAIL + `academic_score_threshold` FAIL，gate FAIL |
| 修订后重审 | snapshotId 变化 → `reusedUnits=0`，40/40 单元全新审查，旧结果零误用 |
| 同轮中断恢复 | journal 复用 6/20，补审 14，coverage 100%，复用单元 finding 保留 |
| 加权分数 | 20 单元全 90/10 → academicScore=90、styleRisk=10（字符加权，跨章 finding 不阻断） |

## 9. 真实模型 Smoke

- 环境：本机已配置公司 GLM 网关 provider（`glm/claude-fable-5-1`，Pi SDK 自管凭据，不经仓库/输出）；
- 场景：12.5k 合成章节（自造内容）→ `revision.apply` 真实 Writer 按尾部 targetQuote 生成单元替换 → 守卫全过 applied → 单元前缀逐字节不变、变更幅度有界、lineage 指向 `section:Method#u2`；随后真实 `reviewUnit` 一次：结构化输出解析成功（academicScore/issues 契约）；
- 调用数：**2**（预算 ≤6）；耗时 22.7s + 63.5s；渠道计费 `cost=0`（公司网关，无新增按量费用 ≤ $10 远未触及）；
- 复现命令：`PAPERTEAM_M141A_SMOKE=1 npx vitest run test/workflow/m141aRealModel.smoke.test.ts`。

## 10. 性能 / Token / 成本（可观测数据）

- 短论文：digest 路径零变化（同 prompt、同调用数），仅多一次确定性覆盖计算 + 一个 JSON 工件；
- 长文档单元模式：每单元 prompt ≈ 单元 ≤9000 字 + 索引（≪ 60k digest 方案的重复整篇）；journal 复用轮零模型调用；跨章审查输入为章节摘要（<30k）而非全文；真实 smoke 两调用合计 cache 写入 ~11.9k token，按量费用 0（网关渠道）；
- 断点恢复：N 章完成 1 章失败的重试成本从「全部重写」降为「补写 1 章」。

## 11. 仍然存在的限制

1. 单元定位只认唯一原文锚点：无锚点且指令泛指全章的意见会以 `unresolved` 滞留（诚实拒绝，不猜位置；需要 Planner 在意见里携带引文——M14.1b 可在 revision.plan 里把 finding description 投影为 targetQuote）；
2. 单块超 9000 字的巨型环境（长表/长推导）保持整块不切（宁可大 prompt 也不切坏结构）；
3. 跨章一致性审查输入是章节摘要，不是全文比对；跨章 finding 是待核验口径（blocking=false），完整事实冲突系统属 M14.1b/M14.2；
4. `existing_paper_review`（PDF 管线）未接入 coverage ledger（其 `review.sections` 已有 per-section journal 与 `sectionsReviewed/Total` 计数，口径不同，未动）；
5. legacy 旧产物（无 coverage 字段）按不适用呈现，历史判定不变；
6. revision 重放的幂等依赖「Writer 对已应用单元产出等价替换」或 stale 拒绝；真实模型若执意改写已改内容，由 quote 范围守卫兜底为 rejected，不是内容回滚。

## 12. 完成条件核对

- **P0-1**：长章节不再依赖整文件覆写（span/单元目标 + 候选守卫）；12k/30k 验证通过；头/中/尾可修订；未授权区域逐字节保持；stale/invalid 拒绝；Fact/Citation/Scope Guard 回归全绿 ✅
- **P0-2**：无静默漏审（>24 文件 / >3600 节 / >60k 全部切换单元模式）；单元完整调度；覆盖确定性可证；正常 100%；失败注入如实下降；gate 拒绝冒充；跨章双位置 ✅
- **P0-3**：章节状态可恢复（指纹 + 哈希双核验）；已完成不重生成；失败定向补做；重启无重复无损坏 ✅
- **工程验证**：自动化测试 / typecheck / build / 关键回归通过；真实模型局部修改 smoke 完成（2 调用）；Git 提交推送与 CI 见下 ✅

**M14.1a：COMPLETE**（上述限制均为如实披露的设计边界，非阻断项）。

## 13. M14.1b 建议下一步

1. `revision.plan`：finding → targetQuote 投影（消除 unresolved 滞留的主要来源）；
2. 跨章一致性升级：ConsistencyLedger 的确定性符号/数值抽取（M14.0 DEC 已定向），跨章 finding 进待核验队列 + HITL；
3. `existing_paper_review`（PDF 管线）接入同一 Coverage Ledger 口径；
4. thesis_from_papers 章节级写作直接复用本轮 `resumableWrittenSection` / journal 语义（ChapterWritingState 的工程底座已就位）。
