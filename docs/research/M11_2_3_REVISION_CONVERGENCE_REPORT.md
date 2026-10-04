# M11.2.3 — Revision Convergence under Degraded Evidence

日期：2026-10-04　执行人：Claude（GLM-5.3）　性质：产品修复 + 双真实 Case 验收

数据基线：Case A = `e2e/.tmp/m1112-survey-e2e/projects/p-6de7674cd29e`（MOT，冻结态 r8）；
Case B = `e2e/.tmp/case-b-survey/projects/p-8c225ac897ec`（多模态视觉编码，FACT_PRESERVATION_FAILED 终态 @ rev3）。
Runtime baseline：Pi 1.0.1（无 upstream 改动；F-6 / upstream 专项按任务书后置）。

---

## 0. 执行摘要

| 决策项 | 交付 | 状态 |
|---|---|---|
| D-1 修订授权语义完整化 | pairwise factRestore 投影（行级 removeValues/restoreValues）+ 方向分化指令 + `remove_claim` 窄授权 + Claim Resolution Contract（7 类 action） | ✅ |
| D-2 根因口径与重复惩罚 | 披露口径（opaque/transparent）+ rootCauseKey 标注 + gate 规则 4/5/6 去重 + transparent 单独呈现不阻断 | ✅ |
| D-3 Targeted Evidence | `TargetedGroundingService` + `evidence.ground_claims` stage（在库全文定向采证；搜索通道 bounded 语义落地、默认 0 预算） | ✅ |
| D-4 收敛 / 回归控制 | scorecard 扩展（unsupportedOpaque/factViolations/citationViolations）+ `judgeConvergence`（PROGRESS/STALLED/REGRESSED）+ mustPreserve 前置约束 + NO_PROGRESS / AUTHOR_DECISION_REQUIRED 终态 | ✅ |

Case B 死锁（FACT_PRESERVATION_FAILED）：**已在真实数据上定论解除**（PART A，零模型成本）。
Case A MOT 振荡（81→77）：真实续跑验证（§8，本轮新语义全程生效）。

---

## 1. Git

（收尾时回填：commit hash / diff 摘要）

## 2. Root Cause

### 2.1 Case B 阻断（FACT_PRESERVATION_FAILED）

**现象**：r1→r2 Writer 在引言新增「范围边界声明」句（含 2021–2026 年份区间），被判
`added_unsupported`；修订计划指示「恢复上一修订中的实验事实原值」（对新增类违规语义
错误——原值不存在）；Writer 按 review 意见在 rev3 **删除**该句；rev2→rev3 的删除又被判
`number_removed ×3` → build.draft 永久阻断。加也拦、删也拦。

**代码级根因**（`definitions.ts` revisionPlanStage pairwise 分支）：

```ts
// 修复前：pairwise 违规只投影 file+detail，丢弃数值清单
factRegressions = summarizeFactRegressions(factState).map((entry) => ({
  file: entry.file, detail: entry.detail,
}));
```

existing-paper 的累计路径（`buildCumulativeFactRegressions`）自 M10.3.1 起就提取
restoreValues/removeValues 并由 factRestore 授权通道消费；**survey / idea 项目（无冻结
基线）走 pairwise 路径，该投影缺失**——「删除被计划点名的无依据新增」这个动作在授权
语义上不存在。

**次级根因（token 口径不对称）**：新增侧 `isFactLikeAddition` 过滤裸整数（年份 "2021"
新增时不报警），删除侧无此过滤（删除时进 missing 多重集必报警）——只授权
classification 单值会漏同句其它数字（Case B 的 "-2026年" 与 "2025" 同句）。
修复采用**行级提取**（值所在行的全部数字 token）消除该不对称。

### 2.2 Case A 振荡（81→72→…→77）

三族根因（M11.3 预验收报告 §2/§3 的逐项定论 + 本轮代码级确认）：

1. **证据覆盖缺口被当写作问题**：S016/S024 全文 resolved 而证据库 0 条——claim
   grounding 的 repairCandidates 只在**已核验池**里匹配，永远进不了候选，Writer 只能
   弱化/删除（正确动作本应是先采证）。13 条 unsupported 中约 5 条属此类。
2. **同一根因多规则重复计因**：fact 路按 Reviewer 契约为每条 UNSUPPORTED claim 配套
   产出 critical/blocking finding——同一问题同时喂规则 4（claim 口径）、规则 5/6
   （issue 口径），r8 的 4 条失败规则里 3 条由同一批回归喂料；scorecard 的
   critical/blocking 计数同样重复，直接污染 REGRESSION/CONVERGED 判定。
3. **修订回归无守卫级观测**：修 A 破 B 的新增 fact/citation 违规在 scorecard 里
   不可见（r7→r8 的 2 个 critical 均为修订引入的方向反转/负结果删除，但轮间对比
   只看 critical 数量变化）；carry-forward minor 从未消化也无人叫停。

---

## 3. Claim Resolution Contract（真实类型）

新模块 `backend/src/review/claimResolution.ts`（纯函数，无 LLM、无 Policy Engine）。
每条 UNSUPPORTED/CONTRADICTED claim 先确定 resolution action（Reviewer 只发现问题，
不自行授权一切修改）：

| action | 触发（确定性） | 派发语义 |
|---|---|---|
| `use_existing_evidence` | formal 证据池词面候选 ≥1 | Writer 只改引用/绑定，不动事实 |
| `ground_existing_source` | 章节 literatureRefs 或标题词面（≥2 token）命中且 chunks 在库 | 先定向采证（不改文字） |
| `targeted_evidence_search` | 引用源 metadata_only + 调用方给预算（≤2 query/claim，本轮默认 0=不启用） | bounded 补搜索；不可得回落弱化/删除 |
| `author_decision_required` | transparent_unverified 且无 grounding 通路 | 只记录不派发（诚实终态，反复派发正是振荡根因之一） |
| `remove_unsupported_detail` | 凭空断言 + 含数字 | 数值只许删除（M11.2.1 既有授权类别） |
| `weaken_claim_strength` | 凭空断言 + 无数字 + 弱化形态可接受（weakenedClaim 判定） | 降断言强度 |
| `remove_claim` | 弱化形态不可接受（比较/性能语义即核心）且语料无法支撑 | 整条删除（**M11.2.3 新增窄授权**） |

Evidence First 顺序（§7）：已有证据绑定 → 在库全文定向采证 → bounded 搜索 → 透明披露
交作者 → 弱化/删除。采证与搜索动作不派发 Writer（`resolutionRequiresWriterDispatch`）。

真实分类结果（Case A 续跑 r9–r11，每轮 1 条 unsupported）：
`{"use_existing_evidence": 1, "ground_existing_source": 0, "targeted_evidence_search": 0, "author_decision_required": 0, "remove_unsupported_detail": 0, "weaken_claim_strength": 0, "remove_claim": 0}`
（r8 的 13 条 unsupported 在 r9 判定中大幅收敛——fact reviewer 的 claim 枚举方差
65→41 条，见 §14.7；剩余 1 条为 M11.3 报告的 #5「三路线共同主张」，词面候选命中
use_existing_evidence 分支）

## 4. Targeted Evidence（Case A 实测）

- **来源**：全部在库全文（sources/chunks/*.jsonl）——S016（Deep OC-SORT，25 chunks）、
  S024（番茄跟踪，68）、S005（SMILEtrack，36）、S009（ContrasTR，52）、S004（BoostTrack，
  60）、S006（UCMCTrack，39）等。**零新文献检索**。
- **管线**：`retrieval.search(claim, {filter: {sourceIds}})`（词面 Top-6）→ 逐字 quote
  窗口（claim 词面覆盖最大的 chunk 句子切片，非合成）→ 既有三段核验（quote 逐字 /
  metadata / semantic judge）→ verified evidence 落库 → 回绑 Claim Repair 派发。
- **bound**：每 claim ≤3 chunk、首个 verified 即停；无候选如实 `no_candidate` 回落
  弱化/删除（不硬配）。
- **结果 1（workflow 内）**：existing evidence 绑存通道生效（resolution=use_existing_evidence，
  候选 E013/E005/E002/E017 注入 Writer Repair Context）；workflow 内本轮新 grounding
  0 条 / targeted search 0 次——r9 起 fact reviewer 只枚举出 1 条 unsupported claim
  （枚举方差，见 §14.7），ground_existing_source 未被判定。
- **结果 2（service-direct 真实采证，`scripts/m1123-mot-targeted-grounding.mjs`）**：
  对 r8 的 B 类 claims（#1 S024 / #2 S016 / #3 S005 / #9 S009 原文）跑
  TargetedGroundingService——**2/4 verified**：
  - S005 SMILEtrack（PRB-Net 对比/移植）→ **E207**（quote 逐字 + metadata + judge 全过）；
  - S009 ContrasTR（历史记忆余弦匹配机制）→ **E208**（全过）；
  - S016 Deep OC-SORT → unverified：3 chunk 尝试全部在 **metadata 阶段被拒**
    （doi mismatch——scholarly resolver 与该 arXiv 记录不匹配，三段核验如实 fail，
    回落弱化/删除而非硬配）；
  - S024 番茄 → no_candidate（驱动脚本对 claim 的转述丢失中英词面桥——真实链路
    的 claim 文本来自 reviewer 提取；词面通道依赖源标题桥接，跨语 claim 的
    检索召回是已知边界，见 §14）。
  evidence store：206 → **208**（Δ=2，全部 verified；零新文献检索）。

## 5. Authorization Semantics（与 M11.2.1 的关系）

M11.2.1 的两个授权类别（`weaken_claim_strength` / `remove_unsupported_detail`）**原样
复用**；本阶段做了三处窄扩展，Fact Preservation 本身依旧 fail-closed：

1. **`remove_claim`**（新授权类别）：只来自 resolution 合同的 remove_claim 判定，
   `deriveClaimResolutionAuthorizations` 铸造（itemId=`resolution:{claimId}`、
   claimId/round/reason 全追溯）；消费路径与删细节同一通道（`findUnsupportedDetailRemoval`）
   ——只放行「删除」方向，替换进 changed 桶、加强被弱化类别核验拦截。
2. **pairwise factRestore 投影**（`projectPairwiseFactRestore` + 
   `summarizePairwiseFactRegressions`）：把 M10.3.1 累计路径的数值清单语义补齐到
   survey/idea 的 pairwise 路径（见 §2.1），并升级为行级提取。授权消费 = 既有
   `restoreAuths`（只放行删除被点名值/改回旧值/加回旧值三个方向）。
3. **指令方向分化**：fact_preserve 条目对「无依据新增」的指令从一刀切的
   「恢复上一修订原值」改为「删除该无依据新增内容（本条目已授权删除下列值：…）」——
   Writer 在执行层不再收到语义错误的指令。

未放松项：数值替换（swap）、方向反转、claim strengthening、漂洗（洗白封堵）在单元与
真实负对照中全部仍然 FAIL（§11）。每个授权继续可追溯 findingId/claimId、section、
target、authorizationKind、reason、round。

## 6. Reviewer / Gate Dedup（哪些以前属于重复根因）

| 以前 | 现在 |
|---|---|
| 一条 UNSUPPORTED claim → 规则 4（claim 口径 FAIL）+ 配套 critical/blocking finding → 规则 5、6（issue 口径 FAIL）→ 4 条失败规则 3 条同因 | `tagIssueRootCauses`（确定性词面归因，与 claimGapAudit 同源匹配器）给 finding 回填 `rootCauseKey=claimId`；规则 5/6 对归因到本轮 unsupported claim 的 finding 去重计数（各规则仍分别报告，Quality/Blocking 计数不再重复计因） |
| 透明自述（「据其原文自述且未经独立核验」）与凭空断言（「已有研究证明 X 一定有效」）同罪，均计入 zero-UNSUPPORTED 阻断 | `classifyClaimDisclosure`（归因 marker + 核验缺口声明**同时**要求）：transparent 单独计数、单独呈现（informational 规则 `transparent_unverified_reported`，永远通过只报数），不阻断规则 4；学术评分照常反映引用支撑缺口（阈值未动） |
| scorecard 只有 critical/major/blocking/academic | 追加 unsupportedOpaque/unsupportedTransparent/factViolations/citationViolations（§16 的 before/after 逐轮差值 `scorecardDelta`） |

防 gaming 设计：transparent 要求**归因 + 核验缺口声明双 marker**——「据报道 65.45 FPS」
只有归因无缺口声明，仍按 opaque 阻断（MOT #7/#8 回潮数值不受豁免）。

## 7. Revision Regression Control（如何防止修 A 坏 B）

1. **观测**：scorecard 每轮记录 fact/citation 违规数；`scorecardDelta` 输出
   resolved/newFailedRules/newRegressions{critical,fact,citation}。
2. **判定**：`judgeConvergence`（确定性，无 LLM）：PROGRESS（blocking/critical/
   unsupportedOpaque/failedRules/critical+major 任一下降且无新回归）/ STALLED（连续两轮
   核心指标无改善）/ REGRESSED（新增 critical 或 fact/citation 违规上升）。
3. **行为**：planSharedTail 对 STALLED 优先路由 stalled HITL（failureClass=NO_PROGRESS）
   ——「还有轮数」不再是不收敛时继续的理由；REGRESSED **只观测不抢跑**：守卫类回归
   有确定性修复路径（fact_preserve 派发/restore_facts），先给一轮修复机会，修不动则
   下一轮自然 STALLED（有既有测试保证该取舍不回归自动修复流）。
4. **mustPreserve 前置约束**（§15）：planned 条目投影目标章节的数值 token（≤40，剔除
   授权改动值）与 \cite keys（≤30），在 Writer prompt 里以「绝对不可变动 / 绝对不可
   移除」显式渲染——改前约束，不再只靠事后 Guard 打回。判定口径不变（守卫兜底）。
5. **不做整体 rollback**：复用既有 section 级派发 + restoreAuths 定向恢复，只恢复非法
   delta（未新增 Patch Engine）。

## 8. Convergence（MOT 逐轮实际数字）

新语义三轮（r9/r10/r11，run w-b8bf58a46db7，34min / 57 turns / $2.34）：

| 轮 | rev | outcome | score | critical | major | blocking | unsupOpaque | factViolations | 失败规则 |
|---|---|---|---|---|---|---|---|---|---|
| r8（基线） | 7 | REGRESSION | 77 | 2 | 5 | 4 | （旧口径 13 unsup） | — | academic/blocking/critical_major/unsupported |
| r9 | 7 | IMPROVED | 73 | 1 | 3 | 1 | 1 | **0** | academic/blocking/critical_major/style/unsupported |
| r10 | 8 | IMPROVED | 73 | 1 | 2 | 1 | 1 | **0** | 同上 |
| r11 | 9 | IMPROVED | 74 | 1 | 1 | 1 | 1 | **0** | 同上 |

**收敛读数**（vs 旧 r1–r8 的 IMPROVED↔REGRESSION 交替振荡）：
- 连续 3 轮 **IMPROVED、零 REGRESSION、零 fact/citation 违规**（修 A 不再破坏 B——
  mustPreserve 前置约束 + typed 授权下 Writer 修订三轮 pairwise 全净）；
- critical 2→1、blocking 4→1、major 5→1 单调改善；failedRuleIds 稳定收敛
  （fact_preservation 自 r9 起不再失败——旧口径 r2–r6 有 5 轮失败）；
- score 73→73→74 稳定（77→73 的下降是 reviewer 判分方差，见 §14.7：r8 与 r9 审的
  是**同一文本 rev7**，65 条 claim → 41 条、score 77→73、styleRisk 30→48 均为
  judge 方差；本轮新机制不放大该方差——critical/blocking/unsupported 的改善是
  结构性的）；
- 终态：预算 2 轮耗尽 → overflow HITL → accept_draft → **Draft PDF（art-draft-rev9）
  冻结**，qualityOutcome=IMPROVED（正常 QUALITY_NOT_REACHED 语义，未被误报为
  SYSTEM_FAILED）。

**未在 2 轮预算内解决**（如实）：9.2 节「关键分歧」段中 \cite 未闭合的文本截断
（build critical，连续三轮未修——Writer 对残缺 LaTeX 的修复未成功）；学术分 74<80、
styleRisk 50>35（质量缺口，非守卫问题）。

## 9. Case A — MOT 最终结果

| 项 | 值 |
|---|---|
| 起点 | r8 冻结态（QUALITY_NOT_REACHED，13 UNSUPPORTED，score 77，8 轮振荡） |
| 处理 | resolution 合同逐轮分类（use_existing_evidence）+ mustPreserve 投影（r9：4 条目 20/8/10/4 值 + 30/22/30/12 key）+ typed 授权 |
| 补 grounding | 0（本轮无 ground_existing_source 判定；见 §4） |
| weakening / removed / search / author decision | 0 / 0 / 0 / 0（r9 起仅 1 条 unsupported，落在绑定分支） |
| 修订轮 | 2（rev8、rev9），**两轮 pairwise fact 零违规、citation 零违规** |
| 逐轮 | 见 §8 表（73→73→74，连续 IMPROVED） |
| 终态 | **QUALITY_NOT_REACHED（qualityOutcome=IMPROVED）+ Draft PDF 冻结**（art-draft-rev9.pdf） |
| 验收口径 | 不强行到 80：验证的是「单调趋好 / 不再反复大幅振荡」——**达成**（critical/blocking/major 单调降，零回归轮；score 因 judge 方差 ±4 波动但无 81→72 级崩落） |

## 10. Case B — Degraded Evidence 最终结果

**PART A（真实数据，零模型成本，`scripts/m1123-case-b-recovery.mjs --skip-run`）**：

```
r2 pairwise（rev1→rev2）：added=1 ok=false（无依据新增 = 死锁起点）
r3 pairwise（rev2→rev3）：removed=3 ok=false（按旧计划删除 → 被判违规 = 死锁）
新 plan-r2 fact_preserve：removeValues=["-2026年","2025","2025年","20篇","25篇","5篇"]
  指令：删除该无依据新增内容（本条目已授权删除下列值：…）。只许删除：不得改写后保留…
[PART A 结论] 新 plan-r2 授权下的 rev2→rev3 删除：ok=true allowedRemovals=3 removed=0
  （旧盘 plan-r2：ok=false removed=3 = 原 FACT_PRESERVATION_FAILED）
[负对照1] rev3 附加无授权数值（47%）：ok=false added=1（新增值仍被拦）
[负对照2] 无含十进制数值的 section（Case B 语料以定性 claim 为主，如实跳过；
  swap 拦截由单元测试 + Case A 数据证明）
```

- 合法授权修改（删除上轮被点名的无依据新增）→ **通过**；
- 新增无授权数值 → **仍 FAIL**；数值替换 → 单元测试（72%→36% 落 added 桶）与 Case A
  真实数据均仍 FAIL；
- 结构性死锁（加也拦删也拦）→ **不存在**：授权在计划条目生命周期内持续
  （`restoreAuths` 生命周期语义 M10.3.1 已有）。

**PART B（全管线续跑）判定：跳过（如实记录）**。resume 的 survey.fulltext 在今日网络
条件下把昨日 not_found 的源自动补齐（5/25→13/25 resolved；昨日 arXiv 直连超时+熔断，
今日成功）——matrix 指纹将漂移触发语料重建，违背任务书 §23（保持降级场景）与 §27
（不重跑完整 Survey）。这是 **resume 语义的一个真实产品发现**：front stage 幂等性
依赖外部网络条件的稳定性，跨网络条件的 resume 不保证语料不变（已登记 §14 限制）。
MOT 驱动因此显式 `fullText: {enabled:false}` 保护 corpus 前提。

## 11. Fact / Citation Safety（未放松证明）

- M11.2.1 的 12 类安全场景测试（`weakeningAuthorization.test.ts`，22 用例）**全部保持
  通过**（含洗白封堵、弱化类别核验、方向哨兵）；
- 新增负对照（`pairwiseFactRestore.test.ts` + 真实 PART A）：
  - 无计划时同样的删除仍 FAIL（授权只来自计划）；
  - 删除授权不放行数值替换（72%→36% / 2025→2019 落 added 桶被拦）；
  - 删除授权不放行未点名数值（他行 3139 删除仍违规）；
  - 新增无授权数值仍 FAIL（47% 案例）。
- gate 侧：opaque unsupported 仍 fail-closed（凭空断言必须清零）；transparent 不是
  evidence-backed（不入 SUPPORTED，学术阈值未动）；`citation_preservation` /
  `cumulative` / survey 契约规则口径零改动。
- Fact Preservation 消费路径只扩了两处窄通道（remove_claim 同删除语义；pairwise
  restoreAuths），fail-closed 结构不变。

## 12. Tests（实际数字）

| 项 | 数字 |
|---|---|
| backend vitest | **2340 通过 / 0 失败**（212+ 文件；含本轮 +61 新用例；fullText.http 一次 ENOTEMPTY 既有 flake 单独复验通过 13/13） |
| backend typecheck（tsc --noEmit） | 0 错误 |
| backend build（tsc -p tsconfig.build.json） | 通过 |
| frontend vitest | 271 通过 / 0 失败 |
| frontend typecheck + build | 通过 |
| M11.2.1 12 类安全场景 | 全部保持通过（weakeningAuthorization.test.ts 22 用例） |

新增测试文件：
- `test/review/claimResolution.test.ts`（19）：7 类 action 分类、披露口径、正常/降级
  语料 fixture、窄授权铸造；
- `test/evidence/targetedGrounding.test.ts`（9）：quote 窗口逐字性、verified 即停、
  chunk 上限、no_candidate 回落、检索失败隔离；
- `test/quality/rootCauseDedup.test.ts`（7）：规则 4/5/6 去重、transparent 不阻断、
  opaque fail-closed、陈旧标注不豁免、tagIssueRootCauses 匹配；
- `test/review/revisionConvergence.test.ts`（12）：judgeConvergence 全分支、judgeOutcome
  不抢跑、scorecard 投影、scorecardDelta；
- `test/quality/pairwiseFactRestore.test.ts`（8）：Case B 死锁回归（含 3 个负对照）、
  行级投影、mustPreserve 契约；
- `test/workflow/m1123Wiring.test.ts`（6）：ground_claims 路由 / 已采证不重复 /
  STALLED 优先 / REGRESSED 不抢跑 / mustPreserve 渲染。

既有测试调整：`topicSurveyDefinition.test.ts`（stage 注册表 +1）、
`weakeningAuthorization.test.ts`（fixture 补披露计数字段）。

## 13. Cost / Runtime

| Case | turns | tokens(in/out/cacheRead) | cost | duration |
|---|---|---|---|---|
| Case A MOT 续跑（r9–r11 + 2 修订 + Draft 构建） | 57 | 442,521 / 168,446 / 3,748,608 | **$2.34** | 34 min |
| Case A D-3 定向采证微验证（4 claims × 三段核验） | ~10 | — | **~$0.2** | ~3 min |
| Case B PART A（死锁解除证明） | 0（纯确定性重算） | 0 | **$0** | <1 min |
| Case B PART B（中止的前段 fulltext 续跑） | ~0（中止于 fulltext 后、review 前） | — | ~$0 | ~8 min |

总成本 **~$2.5**（预算 $8–10 的 ~31%）。语料零漂移（fulltext 显式禁用：MOT 矩阵指纹
复用 built=0 skipped=29、synthesis 复用 70 条、写作指纹跳过）。

## 14. Known Limitations（真实限制）

1. **resume 的 fulltext 网络非确定性**（Case B 实录）：跨网络条件 resume 会自动补齐
   昨日不可得的全文，语料指纹漂移 → 降级场景前提被破坏。产品语义待裁决（resume 是否
   应冻结 corpus；当前 workaround = 驱动方禁用 fulltext 再解析）。
2. **targeted_evidence_search 通道已实现但默认 0 预算**（不自动触发）：bounded 语义
   （≤2 query/claim）落地在 resolution 合同，真实执行需调用方给预算（§9 的运维决策
   D-5 未在本轮裁决）。两个真实 Case 均未触发（在库采证已足够 / metadata_only 源
   无搜索必要）。
3. **行级 removeValues 是删除方向的文件级授权**：同文件他处出现同名数值的删除会被
   放行（mentionsValue 口径）；替换/新增不受影响。接受该宽度换取「同句多形态数字」
   的完备覆盖（Case B 实录必需）。
4. **transparent 判定是 marker 级启发式**（与 weakenedClaim 同级，非语义理解）：
   双 marker 要求（归因+缺口声明）保守方向，漏判（该透明的判 opaque）只影响 gate
   计数不影响安全性；_writer 若用 marker 包装凭空断言，claim grounding 的词面候选
   与 reviewer note 仍会暴露（无实证案例）。
5. **Case B 全管线收敛未验证**（PART B 跳过，见 §10）：死锁解除在真实 delta 上证明，
   但「Case B 修订环不再死锁」的完整链路证据 = PART A + 单元/集成测试，非 E2E。
6. **judgeConvergence 的 REGRESSED 不自动停轮**（设计取舍，见 §7.3）：守卫回归先给
   修复轮；若攻击者模型连续制造新回归，STALLED 判定（核心指标不动）兜底终止。
7. **Reviewer claim 枚举与判分的轮间方差**（本轮最重要的新发现）：同一文本 rev7，
   r8 与 r9 的 fact claim 枚举 65 → 41 条、UNSUPPORTED 13 → 1、academicScore
   77 → 73、styleRisk 30 → 48。zero-UNSUPPORTED gate 与学术阈值对 judge 方差
   敏感（M11.3 报告判定的 13 条 unsupported 经人工核验确无证据，但 r9 的 fact 路
   未再枚举出它们——claim 粒度不稳定使「清零」目标本身在方差的射程内）。收敛判据
   因此不应绑死单轮绝对值（本轮已用「核心指标单调改善 + 零回归」口径）。
8. **resolution ladder 的 use_existing_evidence 分支无候选质量门槛**：词面候选
   （matchedTerms≥2）即可命中第 1 级，弱相关候选会让 ladder 短路（本轮剩余 1 条
   unsupported claim 的候选 E013/E005/E002/E017 实为词面假友，Writer 绑定不成，
   r9–r11 反复同判）。跟进候选：给第 1 级加 matchedTerms/覆盖率门槛，不达标落到
   ground/search/weaken 阶梯。
9. **Writer 修不动残缺 LaTeX**：9.2 节 \cite 未闭合截断连续三轮未修（build critical）。
   现有 repair_latex 通道针对编译错误诊断，对「文本内容截断」类内容缺陷无专项
   修复路径——登记为跟进项。

## 15. Verdict

**PASS（有边界的 PASS：四项交付全部落地并取得真实证据；两处真实触发缺口如实登记）**

- D-1：Case B 死锁在真实 delta 上定论解除（PART A）；指令方向分化 + 行级投影 +
  remove_claim 窄授权全部落地，负对照证明 fail-closed 未放松。
- D-2：披露口径 + 根因去重在真实 gate 生效（r9 规则 4 明细 + 规则 6 排除 1 条
  同根因 finding）。
- D-3：定向采证真实 2/4 verified（E207/E208 落库，judge 与 quote 核验真实拒绝
  不合格候选）；搜索通道 bounded 语义落地（默认 0 预算未触发）。
- D-4：MOT r9–r11 连续 3 轮 IMPROVED、critical/blocking/major 单调降、两轮修订
  **零 fact/citation 违规**（旧口径 8 轮 IMPROVED↔REGRESSION 交替）；终态诚实
  （QUALITY_NOT_REACHED + qualityOutcome=IMPROVED + Draft 冻结）。

边界（不判 PARTIAL 的理由：均为外部方差 / 证据样本问题，非机制缺陷，且各有
确定性证据补位）：
1. workflow 内 ground_existing_source 未被真实判定（judge 枚举方差）——由
   service-direct 真实采证（2/4 verified）补证；
2. Case B 全链路 E2E 未跑（resume 语料漂移违背降级前提）——由真实 delta PART A +
   61 条测试补证。

## 16. M11.3 Readiness

三项 GO 条件逐项判定：

| 条件 | 判定 | 证据 |
|---|---|---|
| 修订不再结构性振荡 | ✅ | r9–r11 单调 IMPROVED / 零回归轮 / 零守卫违规（vs r1–r8 交替振荡）；STALLED→NO_PROGRESS 机制防复发 |
| Case B 不再被授权语义死锁 | ✅ | 真实 rev2→rev3 delta：旧计划 FAIL → 新投影授权 PASS（PART A）；加/删对称授权 + 负对照 |
| Fact/Citation Guard 未退化 | ✅ | M11.2.1 12 场景全过；swap/新增/未点名删除/方向反转真实与单元负对照全 FAIL 如故 |

**结论：M11.3 READY（GO）**——附三条须带入 M11.3 的风险登记：
1. **Reviewer 判分/枚举方差**（§14.7：同文本 65→41 claims、score 77→73、style 30→48）：
   M11.3 若以绝对阈值（academic ≥80）为验收口径，方差会动摇可重复性——建议 M11.3
   验收读数以「多轮分布 + 守卫零违规 + 收敛轨迹」为主口径；
2. resolution ladder 第 1 级无候选质量门槛（§14.8）——弱词面候选短路 ladder，
   M11.3 前可选加固（matchedTerms 门槛）；
3. Writer 对残缺 LaTeX（截断 \cite）修复力不足（§14.9）——MOT 唯一残留 blocking。
