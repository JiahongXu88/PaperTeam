# M11.3 — Survey Product Acceptance & Quality Stability

日期：2026-10-04　执行人：Claude（GLM-5.3）　性质：产品级验收（Reviewer 稳定性审计 + 四项产品修复 + 双真实 Case 终验）

数据基线：Case A = `e2e/.tmp/m1112-survey-e2e/projects/p-6de7674cd29e`（MOT，冻结态 r8 → M11.2.3 续至 r11/rev9）；
Case B = `e2e/.tmp/case-b-survey/projects/p-8c225ac897ec`（多模态视觉编码，FACT_PRESERVATION_FAILED 终态 @ rev3）。
Runtime baseline：Pi 1.0.1（零 upstream 改动）。

---

## 0. 执行摘要

| 验收维度 | 交付 | 状态 |
|---|---|---|
| A. Reviewer 方差量化 | 同一冻结稿 5 次独立采样（i.i.d.，独立会话）+ 生产 r9–r11 verdict 一致性分析 + finding 主题聚类 | ✅（§3–§4） |
| B. Evidence 短路加固 | 候选证据三层门槛（记录质量 / 来源合法性 / 数值锚定）+ 修复 M11.2.3 投影从未命中的键形 bug | ✅（§5） |
| C. Corpus Freeze | `corpus-snapshot.json` 冻结基线；普通 resume 确定性 no-op；显式 `POST /survey/corpus/refresh`（revision+指纹+staleness 传播） | ✅（§6） |
| D. 确定性 LaTeX/Citation 修复 | digest 句界安全截断（根因）+ `citationSyntax` 检测/修复 + build finding 确定性反证 | ✅（§7） |
| E. 终态语义 | `classifyTerminalStatus` 五类终态统一口径（backend completion/HITL + 前端徽章，不再把 QUALITY_NOT_REACHED 显示成系统崩溃） | ✅（§8） |
| F/G. 双 Case 终验 | Case A（MOT）与 Case B（降级语料）在冻结语义下真实续跑至诚实终态 | 见 §9–§10 |

最重要的根因发现：**MOT 连续三轮修不掉的「9.2 节 \cite 未闭合截断」build critical 是 review digest 的视图截断伪影**（`buildManuscriptDigest` 每节 2500 字符硬切，恰落在 `\cite{ng2023traffic` 的 `ng` 之间；稿件本身完好、build gate PASS）——Writer 按伪影修稿当然修不掉。同因修复后该 finding 由确定性反证兜底（§7）。

## 1. Git

- commit：`704eaf2`（main，已 push）
- 基线：`9302c9d`（M11.2.3 PASS 后）
- 变更摘要：产品代码 ~10 文件（claimGrounding/claimResolution/definitions/serviceStack/httpServer/MatrixService/ReviewerService/ReviewAggregator/revisionOutcome/status）+ 新增 4 源模块（`citation/citationSyntax.ts`、`survey/CorpusSnapshotService.ts`、`review/reviewerStability.ts`、errors 扩展）+ 新增 5 测试文件（57 用例）+ 3 驱动脚本 + 2 文档
- 检查：无 secret、无论文 PDF 入库、无 model dump、无 e2e temp（gitignored）

## 2. What M11.3 Was Validating

Survey 主场景从「已经能跑」推进到「可作为产品功能使用」的八个问题（任务书 §2）：

1. 重复 Review 的质量判断稳定性 → §3–§4（量化完成）
2. deterministic safety × stochastic reviewer 的组合 → §7 反证机制 + §12 gate 策略提案
3. Evidence Resolution 是否真正补对证据 → §5（词面假友短路已关闭）
4. Resume 是否偷改语料 → §6（冻结语义 + Case B 实测）
5. 确定性结构错误不再烧 LLM → §7（digest 根因 + 归一修复 + 反证）
6. 跨主题泛化 → §11（Case A vs Case B）
7. QUALITY_NOT_REACHED 作为正常产品终态 → §8
8. PDF 可信/可追溯/可解释 → §9–§10 + §13 人工检查

## 3. Reviewer Stability（Phase A 实测）

**方法**：冻结稿（MOT rev9 终态）× 5 次独立采样。每次采样在独立项目副本上运行（sessionKey 按 projectId 派生 → 副本 = 全新会话，采样间零历史泄漏）；共享输入从副本 1 确定性构建（digest 20220 chars / formal evidence 20 条 / citationDigest cited=29 missing=0 hallucinated=0 / surveyDigest 7 行 / reviewProfile=survey / 同一模型配置）。脚本 `scripts/m113-reviewer-stability.mjs`，统计逻辑 `backend/src/review/reviewerStability.ts`（纯函数，测试覆盖）。

**指标分布（5 采样；min / median / mean±σ / max）**：

| 指标 | min | median | mean±σ | max | range |
|---|---|---|---|---|---|
| academicScore | 75 | 80 | 80.6±3.3 | 84 | **9** |
| styleRisk | 22 | 32 | 31.4±5.4 | 38 | **16** |
| fact claims 枚举 | 37 | 56 | 59.4±13.9 | 77 | **40（2.1×）** |
| supported | 20 | 31 | 30.6±8.1 | 43 | 23 |
| partiallySupported | 8 | 17 | 14.0±4.6 | 19 | 11 |
| unsupported | 9 | 16 | 14.8±3.5 | 19 | 10 |
| **contradicted** | 0 | 0 | 0±0 | 0 | **0（稳定）** |
| critical | 0 | 0 | 0.4±0.5 | 1 | 1 |
| **blocking 计数** | 1 | 1 | 1±0 | 1 | **0（稳定）** |
| major | 4 | 7 | 6.4±1.6 | 8 | 4 |
| minor | 13 | 16 | 15.8±1.7 | 18 | 5 |

**关键读数**：
- 同一冻结稿的 academicScore 在 **75–84** 之间摆动——80 分门槛正好落在分布中心，**单次 review 的 PASS/FAIL 是抛硬币**（3/5 采样 ≥80，2/5 <80）。
- claim 枚举方差 2.1 倍（37↔77）：M11.2.3 §14.7 观测（65→41）不是异常，是 reviewer 的常态行为。unsupported 计数 9–19，直接动摇 `unsupported_critical_claims_zero` 类「清零」目标的可重复性。
- contradicted 恒 0、blocking 计数恒 1：**存在稳定维度**（见 §4 与 §12 的分野）。

**生产数据交叉验证（r9–r11 claim grounding，claimId 稳定指纹）**：跨三轮 88 个独立 claimId 中，62 个只出现一轮（枚举不稳定），26 个出现 ≥2 轮——**26/26 verdict 完全一致（含 5 个三轮全出现且判定不变）**。即：**reviewer 的判定是稳定的，不稳定的是它选择枚举哪些 claim**。（三轮审的还是三个不同修订，一致性更强。）

## 4. Stable vs Unstable Findings

- **精确键匹配**：113 个独立 finding 键，**5/5 全采样复现 = 0 个**——finding 级「逐字身份」跨采样完全不稳定（每次模型挑不同问题、用不同措辞）。
- **主题级聚类**（关键词确定性归簇，非 embedding）：

| 主题 | 出现采样数 | 条数 |
|---|---|---|
| 摘要覆盖边界 / 六类 vs 七族口径不一 | **5/5** | 12 |
| 未核验 / 待全文限定类披露问题 | 4/5 | 20 |
| 引用支撑缺口（未引用 / 支撑不足） | 4/5 | 7 |
| 编号列举（其一/其二…机械结构） | 3/5 | 4 |
| 模板化句式 | 2/5 | 7 |
| 旧版残留文件（未被 \input 的历史节） | 1/5 | 1 |

- **结论**：finding 的**语义主题高度稳定**（摘要口径 5/5、披露类 4/5），**措辞与选例完全不稳定**。产品上可复用的是主题级信号（人类验收 / 报告聚合），不是单条 finding 的身份。
- **digest 伪影的复现率**：r9–r11 生产轮 3/3 报出的截断 critical，在 5 采样中仅 **1/5**（s4）复现——确定性输入缺陷也只有 20% 的 finding 触发率。此前三轮修订全部烧在这个 20% 概率的伪影上。

## 5. Evidence Resolution Quality Gate（Phase B）

**根因（M11.2.3 §14.8 的定案）**：`use_existing_evidence` 第 1 级只要词面候选 ≥1 即短路。真实案例（MOT #5 claim，点名 miah2024learning/wang2022extendable/zaech2022learnable 三篇 abstract-only 文献）：候选 E013/E005/E002/E017 来自**完全无关的源**（SMILEtrack/ContrasTR/…），matchedTerms=2–3（transformer/学习/度 等通用词），Writer 绑定不成，r9–r11 反复同判。

**校准实验否定了纯词面阈值**：SUPPORTED 正例 claim 与其真实绑定证据的 coverage 低至 0.059–0.071（语义支撑但词面换述），与假友的 0.067–0.100 完全重叠——**coverage 无法区分真假支持**。

**落地门槛（`findEvidenceCandidates` 单一收口，三层）**：
1. **记录质量**：`verificationLevel ≠ metadata`（metadata-only 不冒充正文证据）+ `supportStrength` 达 claim 所需最低等级（含数字 claim 要求 direct；strength 缺失 fail-closed）——全部使用现有字段，零 schema 改动（Case A 真实库 208 条全部携带 direct/partial + fulltext）；
2. **来源合法性**：claim 文本点名具体文献（出现完整 bib key）→ 严格限定点名源；否则章节引用面（outline literatureRefs 投影）；无信息 → 不限定；
3. **数值锚定**：claim 含特征数字（小数 / ≥3 位非年份整数）→ 证据文本须含其中至少一个。

**顺带修复的真实 bug**：M11.2.3 的 section 引用投影**从未生效**——投影键 `x.tex` vs claim.section `sections/x.tex` 键形不一致 + literatureRefs 是 entryId（`M-S005`）而非 sourceId。现统一 `normalizeSectionKey` + `literatureRefSourceIds` 剥前缀（双键兼容旧投影）。

**回归矩阵**（`test/review/evidenceSupportQuality.test.ts` 15 用例）：强支持（引用源+direct+数值锚定）→ 候选保留；词面假友（claim 点名他源）→ 不短路；metadata-only → 排除；同源但 claim 含数字而证据 partial → 不接受；数值 claim 无数字候选 → 排除；未验证 → 排除（既有口径）。

**冻结基线联动**（§6）：resolution context 的源可采证性现受 corpus snapshot 约束——基线口径 abstract_only 的源即使磁盘已有全文 chunks 也不参与定向采证（不改变当前 Run 的 Research Basis）。

## 6. Corpus Freeze（Phase C）

**语义**：
- `research/corpus-snapshot.json`：首次 survey.fulltext 完成后冻结（revision=0）。逐源记录两个独立事实：`hasFulltext`（磁盘）与 `basisDepth`（matrix 消费的解释深度——研究基线）；
- **普通 resume**：快照在 → survey.fulltext 是确定性 no-op（不 promote、不重试解析、不 ingest）——**resume ≠ refresh corpus**。网络恢复不得改变已冻结 Research Basis（Case B 实录 5/25→13/25 的隐式漂移通道关闭）；
- **显式补齐**：`POST /api/projects/:id/survey/corpus/refresh`（refresh_missing_fulltext）——补齐 → matrix 可升级条目失效（abstract_only 源已有全文 → 下次构建按 fulltext 重建）→ matrix 指纹变化 → Synthesis/Outline 按既有 staleness 链重算 → 快照 revision+1 + 指纹重算。**语料变而指纹不变是被禁止的**；
- matrix 构建后 `syncBasisDepth` 对齐基线深度（指纹变化、revision 不动）。

**真实测试**：Case B（§10）在磁盘已漂移（基线 5/25、磁盘 18/25 有文件）的项目上预冻结后 fullText 默认开启续跑——网络可下载也不补齐，快照指纹不变。

**测试**（`test/survey/corpusSnapshot.test.ts` 8 用例）：freeze 幂等 / refresh 补齐+revision+1+指纹变化 / refresh 无补齐指纹不变 / syncBasisDepth / 损坏 fail-closed（CORPUS_SNAPSHOT_CORRUPTED）/ 资格口径（reference/rejected 排除）/ matrix 可升级条目失效（真实 stores）/ **survey.fulltext stage 快照在 = no-op**（真实 stack 接线）。

## 7. Deterministic LaTeX / Citation Repair（Phase D）

**根因修复（digest 视图）**：`sliceForDigest`——绝不切在 `\cite{…}` 族命令内部（回退到命令边界）、句界回退（。！？；换行）、截断附显式系统注（「完整内容以 manuscript 文件为准，截断处不构成稿件缺陷，不要据此报 build/结构问题」）；单节预算 2500→3600、节上限 15→24、总量 40k→60k。**这是 MOT 伪影的第一因修复**——reviewer 从此看到的截断自带解释。

**确定性检测与修复**（`backend/src/citation/citationSyntax.ts`，新）：
- `detectCitationSyntaxIssues`：未闭合 \cite（旧 StaticCitationChecker 正则只匹配已闭合命令，未闭合形式不可见）/ 空 cite / 空 key 段 / 同命令重复 key；
- `repairCitationSyntax`：只修 outcome 唯一明确的问题——空命令移除（含前置 `~` 收缩）、空段清理、重复 key 去重（保序）、**key 完整命中 bib 的未闭合补右括号**；**绝不猜 key**（残缺 key / 行内尾随文本的真截断嫌疑 → 不修，标 unresolved 留编译诊断 / Gate / 作者决策）；
- 接线：`revision.revise` 在修订提交前对全部 sections 归一（与 Writer 改动同修订号，守卫同口径核验）。

**确定性反证（disconfirmation）**：`review.run` 聚合后，build 类「截断 / cite 未闭合」指控与真实文件检测交叉核验——真实文件无对应问题 = digest 视图伪影 → finding 移出 issues/counts（不再阻断、不派发 Writer 修复——修一个不存在的问题只会引入回归），单独保留在 `disconfirmedIssues` 透明展示。belt（反证兜底）+ suspenders（digest 根因修复）。

**测试**（`test/citation/citationSyntax.test.ts` 13 用例 + `m113StatusSemantics.test.ts` digest 部分）：安全可修的截断语法 / 正常多 key cite 零改动 / 残缺 key 不猜 / 真文件有未闭合时指控成立（不误反证）/ fake citation 不经此层（Integrity 层继续拦）/ MOT 伪影现场回归（预算点落在命令内部 → 回退到边界）。

## 8. Product Status Semantics（Phase E）

`classifyTerminalStatus`（`revisionOutcome.ts`，纯函数）统一五类终态，三处消费同口径：

| 终态 | 语义（用户可读） | 呈现 |
|---|---|---|
| PASS | 质量验收通过，论文已冻结 | 绿 |
| QUALITY_NOT_REACHED | 论文已生成，但自动质量验收未达目标；Draft 可用，剩余问题见质量报告 | **amber（不再是红色系统崩溃）** |
| NO_PROGRESS | 自动修订已达收敛上限，继续自动修改预计收益有限；当前稿可作为 Draft 使用 | amber |
| AUTHOR_DECISION_REQUIRED | 剩余问题需要作者提供研究判断或额外数据（语言模型改稿无法解决） | accent |
| SYSTEM_FAILED | 事实/引用守卫未满足（冻结产物不安全）——系统级失败 | **红（唯一）** |

- backend：`quality.gate` stage 结果带 `terminalStatus/terminalMessage`；planSharedTail 的 completion summary 带 `qualityStatus/qualityStatusMessage`；stalled/overflow HITL payload 的 failureClass 由同一函数产生（guard 前缀判定收敛进纯函数）；
- frontend：`TERMINAL_STATUS_STYLES` + `TERMINAL_STATUS_HINTS` 注册表；StalledPayload 渲染终态徽章 + 可读说明（`hitl-terminal-status`）；WorkflowPanel 完成态按 qualityStatus 区分 note-warn / note-success（Draft+质量未达 ≠ 任务失败红叉）；
- 测试：`m113StatusSemantics.test.ts`（classify 六分支 + completion summary 两分支）+ `HitlPanel.test.tsx` 2 用例（NO_PROGRESS amber 语义 / SYSTEM_FAILED danger 语义）。

## 9. Case A — MOT Final Acceptance（Phase F）

起点：M11.2.3 终态 r11（rev9，score 74，blocking=1＝digest 伪影 critical，unsupOpaque=1＝假友短路）。
驱动：`scripts/m113-case-final.mjs caseA`（项目副本 + 预冻结语料 + fullText 默认开启 + HITL：stalled→revise_more×1→accept_draft）。

**语料冻结（§31 硬门「Corpus snapshot stable」）**：冻结 revision=0 / fingerprint=af5b9350b99c28f9（29 源，磁盘 24 全文，基线 23 fulltext + 6 abstract）；**运行后指纹与 revision 逐字节不变**（fullText 开启、网络可用，全程零补齐零漂移）——resume ≠ refresh 的产品语义在真实 run 上成立。

**新语义三轮（r12–r14，run w-c1fe4c23a00c）**：

| 轮 | rev | outcome | score | crit | maj | blk | style | unsupOpaque | factV | 失败规则 |
|---|---|---|---|---|---|---|---|---|---|---|
| r11（基线） | 9 | IMPROVED | 74 | 1 | 1 | 1 | 50 | 1 | 0 | academic/blocking/critical_major/style/unsupported |
| **r12** | 9 | IMPROVED | **83** | **0** | 7 | **0** | 38 | 13 | 0 | critical_major/style/unsupported（**blocking 首次归零**） |
| r13 | 10 | IMPROVED | 84 | 0 | 6 | 0 | **25** | 18 | 1 | fact_preservation/critical_major/unsupported |
| r14 | 11 | IMPROVED | 78 | 0 | 3 | 0 | 32 | 7 | **0** | academic/critical_major/unsupported |

- **digest 根因修复的直接效果**：r12 起 blocking 连续三轮 0、critical 0（r9–r11 的伪影 critical 消失；disconfirmed=0——伪影不再产生，反证机制为兜底而非主路径）；score 74→83/84/78（r12/13/14 的波动再次示范 ±5 的 judge 方差）；
- **Evidence-First 阶梯真实运转**：r12/r13 的 resolution = use_existing_evidence 9/11 + ground_existing_source 4/7；定向采证对回潮数值 claim（65.45 FPS / +0.834 / 36% / 1000 FPS / 99.5%）真实执行，**judge 如实拒绝全部不相干候选（EC241–267 无一硬配），evidence store 保持 208 条零污染**；
- **收敛控制**：r13 出现 1 次 pairwise fact violation → r14 自动归零（修复一轮机会语义按设计工作）；三轮 outcome 全 IMPROVED、无 REGRESSION；
- **残留缺口（如实）**：r14 终态 7 条 opaque unsupported（回潮数值类，采证不可得、按「据其原文自述且未经独立核验」透明披露呈现）+ major=2 + academic 78<80。

**终态**：`completed / label=draft / qualityStatus=QUALITY_NOT_REACHED / qualityOutcome=IMPROVED`——诚实终态语义首次以产品口径落盘（completion summary 携带 qualityStatus + 用户可读 message）。

**§31 硬门逐项**：

| 硬门 | 结果 |
|---|---|
| citation hallucination = 0 | ✓（r12–r14 每轮 cited=29 missing=0 hallucinated=0 mismatched=0） |
| missing bibliography = 0 | ✓ |
| Fact Preservation pass | ✓（r14 factV=0，终态失败规则不含 fact_preservation） |
| Citation Preservation pass | ✓（全程未失败） |
| dangling refs = 0 | ✓（build gate rev11 diagnostics=0） |
| unsupported new gap = 0 | ✓（无新增 gap；7 条为遗留回潮数值） |
| speculative leakage hard violation = 0 | ✓ |
| build pass / PDF exists | ✓（build-gate passed@rev11，art-draft-rev11.pdf 260KB） |
| Revision regression = 0 | ✓（终态 factV=0/citeV=0） |
| Corpus snapshot stable | ✓（指纹逐字节不变） |

**软指标**：score 分布（本轮 83/84/78 + Phase A 的 75–84）；stable blocking findings = 无（blocking 恒 0）；style 32<35 达标；academic 78<80 未达标（QUALITY_NOT_REACHED 如实呈现，未降阈值）。

**运行观测**：68 min / 111 turns / tokens 912,674 in / 419,271 out / 4,742,464 cacheRead / **$4.36**。

**Phase B 效果边界（如实登记）**：数值类 claim 全部正确脱离短路（数值锚定 + direct 要求生效）；但**同节跨论文假友仍会命中 use_existing_evidence**（claim 谈 Deep OC-SORT、候选来自同节引用的 SMILEtrack 证据——章节级来源合法性无法区分同节内的不同论文；Writer 收到候选后可诚实拒绝绑定，无错误绑定风险，但派发浪费存在）。跟进候选：claim 文本含源标题特征词时升级为 claim_named 严格 scoping。

## 10. Case B — Degraded Evidence Final Acceptance（Phase G）

起点：FACT_PRESERVATION_FAILED 死锁终态（rev3，M11.2 遗留 + M11.2.3 PART A 已在离线 delta 上证明授权解除）；磁盘语料已漂移（基线 5/25，磁盘 18/25 有文件与 chunks）。
驱动：`scripts/m113-case-final.mjs caseB`（副本 + **预冻结语料** + fullText 默认开启——网络可下载，冻结语义是唯一防线）。

**语料冻结（§34 核心验证）**：预冻结 revision=0 / fingerprint=187f7e72afd8acbd（25 源，**磁盘 18 全文 vs 基线 5 fulltext + 20 abstract**）；**运行后指纹不变、matrix 深度保持 5/20、evidence store 保持 18 条零污染**（基线外 chunks 未被定向采证消费——resolution context 的冻结约束生效）。fullText 全程开启而零补齐：磁盘上 13 个「网络恢复后可得」的全文文件自始至终没有改变本研究 Run 的 Research Basis。**Resume ≠ Refresh Corpus 在真实降级场景成立。**

**死锁解除后的完整链路（run w-7bb4470d623b，r4–r7）**：

| 轮 | rev | outcome | score | crit | maj | blk | style | unsupO | factV | 失败规则 |
|---|---|---|---|---|---|---|---|---|---|---|
| r3（死锁基线） | 3 | IMPROVED | 71 | 0 | 1 | 0 | 42 | — | — | fact_preservation 在列 |
| r4 | 3 | IMPROVED | 77 | 0 | 2 | 0 | 42 | 8 | 3 | fact_preservation（旧 delta 遗留计数） |
| r5 | 4 | IMPROVED | 79 | 0 | 1 | 0 | 44 | 8 | **0** | academic/style/unsupported（**fact 清零**） |
| r6 | 5 | CONVERGED | 79 | 0 | 1 | 0 | 46 | 8 | 0 | 同上 |
| r7 | 6 | CONVERGED | 79 | 0 | 1 | 0 | 48 | 8 | 0 | 同上 |

- **FACT_PRESERVATION_FAILED 不再发生**：r4 的 factV=3 是旧 delta 的遗留计数，r5 起新修订全部干净通过守卫（M11.2.3 授权语义在真实 E2E 全链路验证——此前只有离线 PART A 证据）；
- **resolution 阶梯完整运转**（r4–r6 稳定）：use_existing_evidence 4 / ground_existing_source 1 / **weaken_claim_strength 1 / remove_claim 2**——弱化与整条删除分支首次在真实 run 被派发执行；
- **收敛停止**：r6/r7 连续 CONVERGED → stalled HITL（第一次 failureClass=QUALITY_NOT_REACHED、revise_more 后 STALLED→**NO_PROGRESS**）→ accept_draft → PDF；
- 残留 8 条 opaque unsupported 全部是**摘要级语料的综合层 claim**（GPT-4V/Gemini 代表性、三路线归纳、token 压缩主张等）——80% abstract-only 语料的证据上限，系统如实报告而不硬编（§49 论点实证：降级语料下诚实终态正确）。

**终态**：`completed / label=draft / qualityStatus=NO_PROGRESS / qualityOutcome=CONVERGED`（「自动修订已达收敛上限」语义，非系统错误）。

**§36 验收重点逐项**：

| 重点 | 结果 |
|---|---|
| 0 hallucinated citation | ✓（cited=25 missing=0 hallucinated=0 mismatched=0；unverifiable=1 如实） |
| abstract_only 不被当 fulltext | ✓（matrix 5/20 保持；7/12 节带摘要级披露 marker） |
| transparent unverified disclosure 正确 | ✓（「据其摘要…尚未经全文核验」「此为文献自述的对照性刻画」等系统化出现） |
| Evidence Resolution 不错误短路 | ✓（数值类全脱离短路 + judge 拒绝全部假友；同节跨论文残留见 §9 边界） |
| Fact Preservation 不死锁 | ✓（r5 起零违规，修订链畅通至收敛） |
| Citation Preservation 不退化 | ✓（全程未失败） |
| Revision 不引入 regression | ✓（factV/citeV 终态 0；三轮 IMPROVED 后 CONVERGED） |
| 诚实终态 | ✓（NO_PROGRESS + Draft PDF art-draft-rev6.pdf 200KB + build gate passed@rev6 diagnostics=0） |

**运行观测**：25 min / 50 turns / tokens 411,275 in / 175,958 out / 2,959,232 cacheRead / **$2.12**。

## 11. Cross-topic Generalization

| 维度 | Case A（MOT 数据关联） | Case B（MLLM 视觉编码） |
|---|---|---|
| corpus | 29 源 | 25 源 |
| fulltext ratio（基线） | 83%（23/29 matrix 口径） | **20%（5/25）** |
| 磁盘漂移（冻结前） | 24/29（+1） | **18/25（+13）** |
| 冻结后漂移 | 0（指纹不变） | **0（指纹不变，matrix 保持 5/20）** |
| unclassified ratio | 7/29（明确处理为背景/场景文献） | 15/25（「综述与系统报告」类正式纳入 + 预计标注） |
| synthesis | 70 条（M11.1.2 产物复用） | 30 条（复用） |
| 首轮 academic | 81（r1，全语料时代） | 66（r1，降级） |
| 本轮续跑 | 74→83/84/78 | 71→77/79/79/79 |
| blocking（终段） | 0（连续 3 轮） | 0（连续 6 轮） |
| citations | 29 cited / 0 幻觉 | 25 cited / 0 幻觉 |
| unsupported（终态） | 7 opaque（回潮数值，透明披露呈现） | 8 opaque（摘要级综合 claim，语料上限） |
| 修订回归 | 1 次（r13）→ 下轮归零 | 0 |
| 终态 | QUALITY_NOT_REACHED（IMPROVED） | **NO_PROGRESS（CONVERGED）** |
| PDF | art-draft-rev11.pdf 260KB | art-draft-rev6.pdf 200KB |
| duration / turns / cost | 68 min / 111 / $4.36 | 25 min / 50 / $2.12 |

**泛化结论**：两个主题、两种语料质量（83% vs 20% 全文）、两种漂移历史（+1 vs +13）下：冻结语义、resolution 阶梯、修订收敛、守卫零违规、引用零幻觉、诚实终态（两种不同终态类别各得其一）全部成立。降级语料不阻断链路，只如实压低质量上限并以 NO_PROGRESS 停机——「在质量达不到时诚实知道没达到」的产品定义被两个 Case 同时满足。

## 12. Reviewer Gate Policy Proposal（任务 §40）

基于 §3–§4 实测方差的四选项分析（**本阶段不实施——产品策略决策留给作者**）：

| 选项 | 内容 | 复杂度 | 成本/轮 | 风险 |
|---|---|---|---|---|
| A. 单次 score（现状） | academicScore ≥80 一次定 | 零 | 1× | 实测同稿 75–84——阈值附近 PASS/FAIL ≈ 抛硬币；修订环会被方差驱动振荡（r1–r8 实录） |
| B. median / majority | N 次 review 取中位 | 低（并行 3–5 路） | 3–5× | 成本线性涨；枚举方差仍在（unsupported 9–19），清零类 gate 依旧不可重复 |
| C. deterministic hard gate + score soft signal | 守卫/引用/事实保持类 = 硬门（实测稳定：contradicted 0、blocking 计数恒 1、verdict 26/26 一致）；academicScore/style = 软信号（报告呈现分布，不阻断） | 中（gate 规则重分类） | 1× | 学术质量下限失去硬约束——需产品确认「质量未达标」以 QUALITY_NOT_REACHED 终态呈现是否可接受 |
| D. stable finding based | 只对主题级稳定 finding（≥N/5 采样复现）派发修订 | 高（需多采样 + 主题归簇进产品） | 3–5× | 主题聚类是启发式；单采样内无法判定稳定性 |

**推荐：C**（与任务书 §4「Deterministic Safety = Hard Boundary，LLM Reviewer = Quality Signal」的分层一致）。理由：实测稳定性的分布不是均匀噪声——守卫类与 verdict 级判定几乎完全稳定，score 与枚举高度随机；把硬门放在稳定维度、软信号放在随机维度，成本零增加。**变更属 gate 产品策略，须作者裁决后才改 production 阈值口径**（本阶段 zero 改动，QUALITY_NOT_REACHED 终态如实呈现）。

## 13. Human Product Inspection（Claude Manual Inspection）

执行人：Claude（GLM-5.3）直接阅读两 Case 终稿 artifacts（sections + PDF + 引用报告），**未调用任何额外 Reviewer 模型**。14 项逐项：

| # | 检查项 | Case A（MOT） | Case B（MLLM 视觉编码） |
|---|---|---|---|
| 1 | 像综述不是论文列表 | ✓ 按方法体系组织（两级分类树 + 主题章节 + 跨方法比较） | ✓ 按技术路线组织，明确声明「不按一家族一节」防碎片化 |
| 2 | taxonomy 有逻辑 | ✓ 两级树 + 未归类 7 篇的处置逐篇交代 | ✓ 六家族 + 「综述与系统报告」类正式纳入（15 篇，预计标注诚实） |
| 3 | trend 真实存在 | ✓ 各族演进叙述带年份与引用（2022–2024 谱系） | ✓ 「研究焦点回摆到基础视觉感知」等脉络有引用支撑 |
| 4 | comparison 横向 | ✓ 按维度（遮挡/运动建模/外观依赖/复杂度）跨族比较 | ✓ 路线分野（组合式 vs 原生/无编码器）按架构假设对照 |
| 5 | consensus 多源 | ✓ 跨域共识引两篇独立综述（guan2025multi + yao2023radar） | ✓ 两方之争（涌现推理收益 vs 基础感知缺陷）多源呈现 |
| 6 | disagreement 公平 | ✓ 五项分歧双方均有证据，BoostTrack 混合证据如实呈现 | ✓ 两方之争 + 场景约束分化，未见偏袒单方 |
| 7 | gap grounded | ✓ 覆盖空缺量化（「条目数为零」）+ 每条局限带引用 | ✓ 空缺（token 压缩/查询重采样/box 级粒度）由覆盖统计推出 |
| 8 | future 区分 speculative | ✓ 「文献明确提出」vs「由空缺推断…仅具推测性质」两类显式分列 | ✓ 同样显式两类 + 「并非已核验的结论」强调 |
| 9 | 无 fake citation | ✓ 29 cited / 0 hallucinated（静态+元数据双核验） | ✓ 25 cited / 0 hallucinated |
| 10 | citation 与 claim 大体匹配 | ✓ 抽查 RTU++/BoostTrack/UCMCTrack 等条目匹配 | ✓ 抽查 IVE/NaViL/EVEv2 等匹配（含 979M 参数等具体数字带引用） |
| 11 | 无明显事实漂移 | ✓ 回潮数值以「据其原文自述且未经独立核验」披露呈现（gate 如实计 unsupported） | ✓ 摘要级转述均带「据其摘要」限定 |
| 12 | 无重复 AI 模板化表达 | △ 「其一/其二」编号结构 + 「据其原文自述且未经独立核验」公式化重复（styleRisk 32 过门但偏高） | △ 同类模式存在（styleRisk 48 未过门，如实计入终态） |
| 13 | 章节衔接自然 | ✓ 引言含路线图与阅读指南，节间交叉引用（见第 10 节） | ✓ 分类章导航 + 各章在统一问题框架下展开 |
| 14 | PDF 完整可读 | ✓ art-draft-rev11.pdf 260KB / build gate passed / diagnostics 0 | ✓ art-draft-rev6.pdf 200KB / build gate passed / diagnostics 0 |

**人工结论**：12 项 ✓ + 2 项 △（两 Case 的模板化表达均真实存在但受 style gate 监督且如实计分）。两份 PDF 均为结构完整、引用干净、边界诚实的可用综述草稿——Case A 接近发表质量（78/80 + 披露类残留），Case B 是降级语料下的诚实上限（79/80 + 摘要级上限）。

## 14. Tests

| 项 | 数字 |
|---|---|
| backend vitest | **2353 通过 / 0 失败**（217 文件；新增 57 用例：evidenceSupportQuality 15 / citationSyntax 13 / corpusSnapshot 8 / reviewerStability 10 / m113StatusSemantics 11） |
| backend typecheck / build | 0 错误 / 通过 |
| frontend vitest | **273 通过 / 0 失败**（新增 2：终态语义渲染 ×2） |
| frontend typecheck / build | 0 错误 / 通过 |
| M11.2.1 12 类安全场景（weakeningAuthorization 22 用例） | 全部保持通过 |
| M11.2.3 resolution/convergence（61 用例） | 全部保持通过 |
| 已知 flake | `fullText.http.test.ts` 清理期 ENOTEMPTY（Windows temp rmdir 既有问题，13/13 测试本体通过；单独复验通过） |

## 15. Cost

| 项 | turns | tokens(in/out/cacheRead) | cost | duration |
|---|---|---|---|---|
| Phase A 稳定性审计（5 采样 × 三路 review） | 15（service-direct 无 trace，按采样计） | 未仪表化（service-direct 路径无 run-trace） | ~$1.5–2（估） | 42 min |
| Case A 终验（r12–r14 + 3 修订 + Draft） | 111 | 912,674 / 419,271 / 4,742,464 | **$4.36** | 68 min |
| Case B 终验（r4–r7 + 3 修订 + Draft） | 50 | 411,275 / 175,958 / 2,959,232 | **$2.12** | 25 min |

**合计 ~$8–8.5**（预算 $10 内，硬上限 $15 未触及）。

## 16. Known Limitations（真实限制）

1. **主题级 finding 稳定性是关键词启发式归簇**（§4），不是语义理解——报告口径，非产品 gate 依据；
2. **主动 Refresh 的前端 UI 后置**（service + HTTP 已就绪，API_CONTRACT 已登记；产品暴露属 M11.4+ 决策）；
3. **Writer 修订中的 retrieve_library 工具不受冻结基线约束**（可检索到基线外 chunks）——resolution/grounding 主链已约束；事实守卫兜底；完整基线沙箱属后续加固；
4. **digest 总预算 60k**：超过 24 节 × 3600 的超大综述仍会带系统注截断（显式声明，不再产生伪影）；
5. **未闭合 cite 的自动补括号只覆盖「key 完整命中 bib」**——真截断（内容丢失）与残缺 key 一律不猜，留编译诊断 / 作者决策（原则：不确定不修）；
6. **verdict 一致性结论基于 26 条共享 claim**（生产 r9–r11）——样本中等，方向明确（0 不一致）但非大规模统计；
7. **Phase A 的 fact findings 无 rootCauseKey 匹配通道**（脚本直调 reviewAll，不经 review.run 的 tagIssueRootCauses）——finding 稳定性结论以主题级为准。

## 17. M11.3 Verdict

**PASS —— M11.3 — Survey Product Acceptance COMPLETE。**

任务书 §48 十项成功条件逐项：

| 条件 | 判定 | 证据 |
|---|---|---|
| A. Reviewer 方差已量化，产品验收不盲信单次分数 | ✓ | §3：同稿 score 75–84 / claims 37–77 / verdict 26/26 一致；§12 提案 C |
| B. Evidence Resolution 不再弱相关短路 | ✓（有登记边界） | §5 三层门槛 + §9 数值类全脱离短路；同节跨论文残留如实登记 |
| C. 普通 Resume 不隐式改变 Frozen Corpus | ✓ | §6 + §9/§10 两 Case 指纹逐字节不变（fullText 开启 + 网络可用） |
| D. Corpus refresh 有明确语义 | ✓ | §6 显式 refresh：revision+1 + 指纹重算 + matrix 失效 → staleness 链传播（测试覆盖） |
| E. 确定性结构错误不烧 Revision LLM | ✓ | §7 digest 根因修复（blocking 4→0）+ 归一修复 + 反证兜底 |
| F. MOT 可信终态 | ✓ | §9：QUALITY_NOT_REACHED + Draft rev11 + §31 硬门 10/10 |
| G. Case B 可信终态 | ✓ | §10：NO_PROGRESS + Draft rev6 + 死锁解除全链路验证 |
| H. 双 Case 0 幻觉 / 无守卫回归 / PDF 可生成 | ✓ | §11 对比表（54 cited / 0 hallucinated；终态 factV=citeV=0；双 PDF） |
| I. 终态不被误显示为 SYSTEM_FAILED | ✓ | §8 五类终态统一口径 + 前端徽章（backend+frontend 测试） |
| J. 全量测试绿 | ✓ | backend 2353/0 + frontend 273/0 + typecheck/build 通过；M11.2.1/M11.2.3 既有安全测试全保持 |

**Survey 主场景当前正式具备**：

Topic → Research → Literature → Fulltext（冻结）→ Matrix → Synthesis → Outline → Writing → Citation → Review → Revision（收敛）→ Gate → Draft PDF

且质量不足时有诚实终态（QUALITY_NOT_REACHED / NO_PROGRESS / AUTHOR_DECISION_REQUIRED），产品语义全部落盘。

**如实边界（不构成 FAIL，登记为 M11.4+ 输入）**：
1. academic ≥80 的硬阈值对 judge 方差敏感（§12 提案 C 待作者裁决）；
2. 同节跨论文的词面假友仍可命中 use_existing_evidence（Writer 可拒绝绑定，无错误绑定风险，但有派发浪费）；
3. 主动 Refresh UI 后置（service + HTTP 已就绪）。
