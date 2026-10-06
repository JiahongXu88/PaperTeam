# M11.4 Reliability Closure（Attempt 8 → Attempt 9）

状态：IN PROGRESS（2026-10-07）。基线 HEAD `a44847a`（Attempt 8 收口后）。

## 1. Executive conclusion（占位，收口时更新）

Attempt 8 三次 clean run 的失败经 forensic 重建后，绝大多数为 **system-owned 契托缺陷**
（机器兜底条目缺字段 / 作者裁决标记被覆盖 / patch 级校验覆盖不全 / removed 类违规不可
确定性恢复 / claim↔finding 归因结构性词面失配），模型行为方差在这些缺陷上被放大为
不同 run 的不同 FAIL 形态。本轮以 machine-owned invariant 修复为主线。

## 2. Attempt 8 Failure Matrix

数据源：`D:\PaperTeamData\M11_4_Attempt8_Revalidation\{run1-engineering,run2-engineering,run3-acceptance}`
+ 项目目录 `projects\p-db07e4273daa(8a) / p-e4f0737aa7e4(8b) / p-85d7749054b9(8c)`。

### 8a（run1，p-db07e4273daa）— deterministic detector 伪影（已修，replay=合法）

终态 completed/draft，verdict FAIL，qualityStatus SYSTEM_FAILED。失败因子：numberRuns
区间连字符负数、全文 containment 兜底缺失、归因对称 Jaccard、公式 alpha-rename、
hedging 误判 placeholder、feasibility LOW。全部由 `2b4b170`+`04e4655` 修复；
`m114-replay-attempt8-r3.mjs` 回放 = 任务层 7/7 PASS → AUTHOR_DECISION_REQUIRED。
**结论：system artifact，非模型问题。**

### 8b（run2，p-e4f0737aa7e4）— Writer 未授权删除 + 修复链缺口

| 环节 | 事实 |
|---|---|
| r1（revision.apply） | Writer 为 Editor「创新性凝练」重写引言段，删除既有事实 `56.8\% AP`（YOLOv7 COCO AP，带 \cite{Wang2023YOLOv7}）；patch 级候选校验只查方向翻转/新增事实 → 放行并提交 rev-2 |
| gate r2 | fact_preservation FAIL（removedFacts 1）——检测正确 |
| r2（revision.revise） | 计划含 `fact-preserve:e2b2573c34e5f9b7:0`（restoreValues=["56.8%"]），restorable=false（numericAnchors 显式排除 removed 类）→ 派发 Writer；Writer 仍未恢复，反在消融节新增「尚待核实统一/尚待验证」hedging |
| gate r3 | pairwise placeholder regression（数值缺失 + 占位增加）+ cumulative 未解决漂移 1 项 |
| 终态 | build.draft FACT_PRESERVATION_FAILED（permanent 1/2）→ run failed |

根因：**(S1) patch 级候选校验覆盖不全**（removedFacts/placeholderRegressions/formulaChanges
不进 per-patch 检查，违规进修订后才在 gate 爆炸，bounded repair 从未触发）；
**(S2) removed 类违规无确定性恢复路径**（Writer 是唯一修复者且失败）；
**(M1) Writer 未授权删除既有事实**（模型行为；guard 终检正确拦截）。

### 8c（run3，p-85d7749054b9）— comment closure 管道 + 归因

| Comment | 基线事实 | Plan | Writer | 意见终态 | 失败原因 |
|---|---|---|---|---|---|
| Editor | — | modify×4（正确链接） | 落实 | handled | — |
| R1 引用≥20篇 | 基线 25 refs（前提可被反驳） | **机器 fallback 条目（模型未链接 commentRefs），无 actionType** | skipped（REVISION_ACTION_TYPE_REQUIRED） | unresolved | **S3：fallback 条目缺 actionType**；`a44847a` 校验的 `validateStructuredPlanItem` 生产链路零调用点（死代码） |
| R2 缺少边缘部署实验 | **基线已有 subsec:edge_deploy（1495.63ms/0.669FPS，E001 支撑）——前提被基线反驳** | author_decision×2 + modify（target 误指 subsec:metrics） | 对误指 target 如实报 not_applicable；patch(6fb262a03c64) 另有 accepted | unresolved（“派发章节均不适用”） | **S4：applyDispatchOutcome 把 AUTHOR_DECISION_REQUIRED statusNote 覆盖成 plain unresolved**；M2：Planner 未发现基线覆盖（refutation vs coverage 语义缺口） |
| R3 UA-DETRAC 定位 | — | 同 R1（fallback 无 actionType） | skipped | unresolved | 同 S3 |
| R4 极端场景 | — | modify（正确） | 落实 | handled | — |

任务层另因 `no_revision_blocking_findings` FAIL：2 条 blocking/critical finding
（摘要“均优于”过度声明；主表 vs 消融表数值不一致）。claim-gap-audit 已把对应 claim
（c-b03ab081f2f4 摘要声明 / c-d508d2b1eb60 主表数值）判为 excluded_pre_existing
（作者级），但 **claim↔finding 词面归因结构性失配**（finding 是对问题的元描述，与
claim 原文 token 重叠 <0.5；composite section 标签）→ 归层退回 section 名启发式 →
modified_existing → 任务层 FAIL。**S5：归因缺 lineage 主通道**。M3：Writer 对已计划
的摘要弱化执行不彻底（真实模型语义缺口）。

### 8b/8c 共因（root-cause tree）

```
不同 run 不同 FAIL 形态
├── S1 patch 候选校验 ⊊ 提交级校验（8b 删除事实进修订）
│     └── preserve-by-construction 只在 span 级，未覆盖 span 内数值删除/占位替换
├── S2 removed 类违规不可确定性恢复（8b 二轮无出口 → permanent FAIL）
├── S3 机器 fallback 条目不满足自身派发契约（8c R1/R3 unresolved）
│     └── a44847a 修复未接线（validateStructuredPlanItem 无调用点）
├── S4 意见状态机 last-write-wins，合法终态标记（AUTHOR_DECISION_REQUIRED）可被覆盖（8c R2）
├── S5 claim↔finding 归因仅词面（无 creator-side lineage；无数值指纹档）（8c 2 blocking）
└── 语义缺口：评论前提被基线/Evidence 反驳时无 noop/already_satisfied 发现通道（8c R2/R1）
     └── Planner 输入无「意见 ↔ 基线章节」相关性提示
```

机器职责 vs 模型职责审计结论：canonical ID / actionType 合法性 / 意见终态聚合 /
patch 级授权校验 / 恢复路径 / 归因 lineage 均应为机器职责——Attempt 8 中这六项各有
一处缺口；模型职责（计划意图 / 修改文本 / 意见落实验证）的行为方差因此被放大为
任务层 FAIL 而非被系统吸收。

## 3. 本轮修复（进行中）

| # | 修复 | 类型 | 状态 |
|---|---|---|---|
| F1 | fallback 计划条目 actionType=author_decision_required（机器自有字段） | machine-owned | DONE 153029b 前身 / a7ecb13 |
| F2 | applyDispatchOutcome 保留 AUTHOR_DECISION_REQUIRED/EVIDENCE_ONLY_RECORDED 标记（sticky terminal marker） | machine-owned | DONE 153029b |
| F3 | patch 候选校验补 removed/placeholder/formula 三类 + mustPreserve 前置注入（span 数值投影 − 授权值） | preserve-by-construction | DONE a7ecb13 |
| F4 | factRestore 支持 removed 类（冻结段锚点 + 当前段最佳匹配 + 引用守卫） | deterministic repair | DONE d6b407b |
| F5 | 归因：claimIndex creator-side lineage + 数值指纹档（≥半数 claim 数值出现在 finding 描述） | machine-owned | DONE 755ebdd |
| F6 | improvement plan 持久化稳定 id（improvement:N 统一 numbering：directive/trace/patch 同源） | lineage | DONE a7ecb13 |
| F7 | Planner 输入：意见 ↔ 基线章节相关性提示（noop 机会提示，不改决策权） | input enrichment | DONE a7ecb13 |

Attempt 8 数据回放验证：8a（p-db07e4273daa）replay 无回归（7/7 → AUTHOR_DECISION_REQUIRED）；
**8c（p-85d7749054b9）closure replay = AUTHOR_DECISION_REQUIRED 7/7 全过**（实际 8c：FAIL，
reviewer_requirements_closed 2/5 + 2 条任务层 blocking finding；修复后两条 finding 均正确
归因到 excluded_pre_existing claim，R1/R2/R3 全部合法闭环）。回放脚本：
`scripts/m114-replay-attempt8-closure.mjs`。

## 3.1 Post-fix Run 1（p-c923662f9c48 / w-aa6dd4a4ed08）——FAIL，三个新缺口

相对 Attempt 8 的实质改善（修复生效面）：模型正确链接 R1/R3（不再掉 fallback）；
**R2 派发到正确 target subsec:edge_deploy**（8c 误指 subsec:metrics）；R4 的
AUTHOR_DECISION_REQUIRED 标记 sticky 生效（合法 author_decision 闭环）；
18/18 条目带稳定 id + actionType。但终态仍 FAIL（reviewer_requirements_closed
4/5 差 R2 / revision_introduced 1 条 / no_revision_blocking_findings 3 条）：

| 新失败 | 根因 | 修复 |
|---|---|---|
| R2：improvement:5 命中 edge_deploy、候选 patch 全守卫通过并 accepted、目标真实变更——但 Writer 自报行写 not_applicable，聚合只信自报 → 意见 unresolved（§14 违背：closure 应由 accepted patches 推导） | **S6：机器 patch lineage 与模型自报冲突时无仲裁规则** | F8 applyPatchBackedOutcomeOverrides：确定性 patch 归因（accepted+target 对应+真实变更）覆盖 not_applicable/unreported 自报（conflict/applied 不覆盖）[71f66b9] |
| 【待作者确认：…】问句被实体写进正文（4 处），评审判 blocking + unsupported claim | **S7：Planner 把「由作者确认 X 二选一写明」的作者决策语义写进 modify 条目**（actionType 合法性未由机器判定） | F9 reclassifyAuthorInputActions：modify 且 action 含 待/需/由作者确认 → 确定性重分类 author_decision_required（模型给 intent、machine resolve actionType，§13）+ planner 提示规则 9/10 [71f66b9] |
| 同上正文占位未被 placeholder 守卫发现（评审层才发现） | **S8：待+作者+确认 不含 待确认 子串，PLACEHOLDER_PATTERN 结构性漏检** | F10 pattern 增补 待作者确认/裁决/决定（对冲语豁免不变）[71f66b9] |
| J_trk 与 L_smooth 循环评测风险声明 = 修订引入 UNSUPPORTED claim（improvement:10 计划的分析性论断） | M4：模型计划新增无证据分析性论断 | planner 提示规则 10（预防）+ 事实核验守卫（拦截，既有）——模型行为残余风险，按 §43 以多 run 统计 |

## 3.2 Post-fix Run A（p-fce3f34e28c3 / w-33b0172083f5）——FAIL，三个新缺口（同源）

修复生效面：意见闭环检查 PASS（5/5 全部合法 author_decision，sticky 标记工作正常；
reclassification 兜底 0 触发——模型自己写了 12 条 author_decision）；revision_introduced
claims 0；patch_substance PASS；academic 非回归 PASS。失败三症状**同一根因**：

Writer 把执行注记「【修订说明】f-60cada…（λ_smooth=0.5 与表8 …）」实体写进正文
（rev-2 干净、rev-3 污染 1 处）→ ① 裸 λ_ 进 text mode → LaTeX 编译失败
（buildOk=false）；② 注记内 λ_smooth=0.5 平文本赋值 → cumulative_fact_preservation
unauthorized 新增；③ 结论新增对冲表述与摘要正面声明自相矛盾（模型语义失误，
被复审正确判 blocking——修改区间问题）。

| 新失败 | 根因 | 修复 |
|---|---|---|
| 【修订说明】元注记入正文 | S9：修订元文本无候选级拦截 | F11 REVISION_META_TEXT_PATTERN 候选级拒绝（revision_meta_text 失败码 → bounded repair）+ prompt 7c/规则 f |
| λ_smooth=0.5 unauthorized | 同上（污染源）；另有同参数等值重述（0.50↔0.5/全角＝）格式等价未识别 | F11（源头）+ F12 assignment_format_restatement（同 LHS 数值等价 → formatChanges） |
| 结论 vs 摘要自相矛盾 | M5：模型弱化时新增并存反表述而非改写原论断 | prompt 7b/规则 10（弱化=改原论断；不得并存反向表述）——行为残余风险按多 run 统计 |
| 5/5 意见全 punt 作者决策（合法但低质） | 规则 9/10 措辞过度吓退（Editor 凝练类也无端 punt） | 规则 9 加反 punt 条款（真依赖作者输入才 author_decision） |

## 3.3 Post-fix Run B（p-8fb1a3cc92fc / w-9ce79eedf543）——6/7 PASS，最后一个候选校验洞

修复生效面（相对 Run A 全部好转）：**no_revision_blocking_findings PASS**（元注记污染与
自相矛盾消失）；buildOk=true；revision_introduced 0；**R2 经 patch-backed override
合法 handled**（Writer 自报 not_applicable 被机器 lineage 覆盖）；Editor handled；
R4 conflict（合法作者裁决闭环）；R1/R3 author_decision。意见闭环 2 handled +
3 author_decision = 0 open ✓。唯一 FAIL 因子：

Writer 给 tab:baseline_source 的 DeepSORT 来源 cell 追加「（自实现，ReID 特征
统一为 128 维，非官方实现）」——对基线公平性的诚实澄清（评审方向正确），但未走
计划授权（expectedFactChanges+Evidence），且 **F3 候选校验的 changedFacts 类未映射**
（8b 是删除类、这次是修改类）→ patch 层放行 → gate 层判 table_cell 漂移 →
round-2 无法恢复（表格 cell 非段落恢复对象）→ cumulative 守卫 FAIL。

**F13（14eeec8 后补）**：changedFacts（未授权值变更，含表格 cell）进候选校验
（unauthorized_fact_change → bounded repair；mustPreserve 点名旧值）。合法保留该类
澄清的通道是计划 expectedFactChanges + Evidence 绑定（提示规则 4 既有）。

## 3.4 Post-fix Run C（p-af86ff877f8f / w-c470dca1adf0）——5/7 PASS，两个深层缺口

修复生效面：意见闭环 PASS（Editor/R3 handled、R4 conflict、R1/R2 author_decision）；
patch_substance PASS；revision_introduced 0；buildOk=true；academic 79 vs 基线 70。
两个残留 FAIL（真实数据回放验证修复均有效，`.tmp-dbg` probe）：

1. **授权标准不一致（洗白通道）**：round-2 Writer 按修订计划 finding 条目的
   instruction（含新公式 $\mathbf{g}_t^k=\beta\bar{f}+(1-\beta)f_{t'}$）新增公式——
   pairwise/candidate 层用**未经用户批准的修订计划文本**授权放行（lenient ok=true），
   cumulative 层按「只认已批准台账+Evidence」判漂移（不可恢复）→ 守卫 FAIL。
   **F14**：`strictPlanTextAuthorization`（patch 候选级启用）= 与 cumulative 同
   标准——修订计划文本不进新增授权（restoreAuths 恢复方向保留）；真实数据验证
   STRICT 口径 formula_added=1 被拦。
2. **category 标签噪声挡住数值指纹**：主表/消融矛盾 finding 本轮被学术审稿人标
   `category=academic`（8c 同款被标 fact）——归因的 category 过滤把它挡在数值
   指纹档外 → 误层 modified_existing → 任务层 blocking。**F15**：归因分层证据
   强度——强证据档（数值指纹/逐字引用/直接 id join）任意 category；弱证据档
   （章节+词元覆盖）仅 fact/evidence_gap。真实数据验证 excludedBlocking 3→4。

（后续章节 9-20 在收口时补：deterministic regressions / real-run 结果 / 稳定性统计 /
memory audit / Docker / tests / git / final readiness。）
