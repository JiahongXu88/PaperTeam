# M11.4 Reliability Closure（Attempt 8 → Attempt 9）

状态：CLOSED（2026-10-07）。基线 `a44847a` → 收口 HEAD `32ada11`（23 项修复，14 commits）。

## 1. Executive conclusion

**COMPLETE。** Attempt 8 的三类失败经 forensic 重建后，绝大多数是 system-owned 契托
缺陷（机器兜底条目缺字段 / 合法终态标记被覆盖 / patch 级校验覆盖不全 / removed 类
不可确定性恢复 / 归因缺 lineage 主通道 / noop 契约与基线覆盖现实冲突 / 兜底被条目
上限吞掉）。本轮以 **machine-owned invariant** 为主线共实施 23 项修复；每次真实 run
暴露的新缺口均以确定性修复+回归测试收口。post-fix 真实 Existing Paper runs 共 21 次：
迭代段 12 次（每个失败形态 → 修复+回归），合法终态 10 次（含 O 的双层全过 PASS +
Final 冻结）；**最终 HEAD（32ada11）上 S/T/U 三连全部合法终态（7/7 checks 全过）**。
GLM-5.3 + 当前 Harness 已能稳定完成 bounded revision 并进入合法产品终态；PaperTeam
从「偶尔能正确返修」提升为「能够稳定、重复地完成真实 Existing Paper Revision」。

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

## 3.5 Post-fix Run D（p-e24f6f0b89d2 / w-0149bdd71618）——**7/7 PASS，合法终态 №1**

verdict=**AUTHOR_DECISION_REQUIRED**（Editor/R2/R4 handled + R1/R3 author_decision，
0 open）；守卫 9/9 全过；修订引入 claim 0；修改区间 blocking 0；buildOk=true
（Draft PDF art-draft-rev3.pdf 产出）；academic 76 vs 基线 66。候选级拦截+修复在
生产路径工作（rev-2：3 patches 1 fail→1 repair 成功；rev-3：4 patches 2 repair
attempts 1 成功）。

## 3.6 Run E（w-b5e989fe6426）——阶段失败暴露 noop 契约缺口（F16）

Planner 按 F7 提示正确发现基线覆盖，对 3 条意见计划 noop——但 noop 契约强制
EV 绑定，而「参考文献 ≥20 篇（基线 25）/已有部署章节」的覆盖证明是稿件本身，
无 Evidence 可绑 → structured repair 两轮无解 → MODEL_REPAIR_EXHAUSTED 阶段失败。
**F16（d41bf3e）**：已满足的证明 = coverageQuote 逐字核验（确定性）；EV 绑定降
为增强项（绑了才校验状态/协议）。

## 3.7 Run F（p-f46df30c945d / w-77bcef64d020)——6/7,F16 生效 + 节略引文缺口（F17）

**4/5 意见 already_satisfied**（Editor/R1/R3/R4 的 noop 引文逐字核验通过——
F16 打通的合法闭环首次批量落地）；守卫全过；修改区间 blocking 0；buildOk=true。
唯一 FAIL：R2 的 noop 引文用「……」节略拼接两段真实原文 → 逐字 includes 拒绝 →
plain unresolved → 任务层 FAIL。
**F17（801dd55）**：① 节略引文核验（省略号分段逐字 + 顺序递增 + 防碎片下限）；
② noop 核验失败 → AUTHOR_DECISION_REQUIRED（基线覆盖无法机器确认 = 作者裁决，
不是系统失败）。

## 3.8 Run G（p-b378779941fa / w-2b553692dd8e）——**7/7 PASS，任务层完整成功（终态 №2）**

verdict=**PASS**：外审意见闭环 **5/5**（Editor handled + R1/R2/R3/R4 全部
already_satisfied——R2 的 edge_deploy noop 引文经节略引文核验通过）；守卫 9/9；
修订引入 0；修改区间 blocking 0；buildOk=true；qualityStatus=**REVISION_TASK_COMPLETE**
（分层语义完整落地：任务成功 + Publication NOT_READY——academic 76<80 属全稿层，
如实呈现不阻断任务层）；Draft PDF 产出。

## 3.9 Run H（p-32bc3d63d06a）——6/7，20 条上限吞掉兜底（F18）

4/5 already_satisfied（noop 链路稳定），唯一 FAIL：模型恰好用满 20 条计划上限，
fallback 的 `items.length >= 20` 守卫把未链接的 R4 **静默丢弃** → 意见 pending。
**F18（bb06f5b）**：「外部意见不得从计划消失」机器不变量优先于条目上限——
兜底条目不再受 20 条模型上限约束（含回归测试：20 条模型条目 + 1 未链接意见 → 21 条）。

## 3.10 Runs I–U（迭代收尾段 → 稳定收敛）

| Run | HEAD | verdict | 失败→修复 |
|---|---|---|---|
| I | bb06f5b | **PASS**（5/5 already_satisfied，单轮） | — |
| J | bb06f5b | 阶段失败 | FACT_CHANGE 修复两轮耗尽 → **F19**（3c58d4d）：确定性降级 author_decision_required |
| K | 3c58d4d | **AUTHOR_DECISION_REQUIRED**（7/7） | — |
| L | 3c58d4d | **AUTHOR_DECISION_REQUIRED**（7/7） | — |
| M | 3c58d4d | 阶段失败 | 全 author_decision 计划零派发目标被当契约违反 → **F20**（60bc7c6）：revision.skipped 合法跳过 |
| N | 60bc7c6 | **AUTHOR_DECISION_REQUIRED**（7/7；一个 run 集齐 handled/already_satisfied/conflict/author_decision 四种合法闭环） | — |
| O | 60bc7c6 | **PASS（双层全过）**：gate.passed=true、completion=**final**、Publication **READY**、art-final-rev3.pdf 冻结、academic=80 | — |
| P | 60bc7c6 | FAIL | metric 方向翻转分两步各过 pairwise、仅 cumulative 可见 → **F21**（534cf5c）：候选校验加冻结基线口径（违规并集） |
| Q | 534cf5c | FAIL（6/7） | evidence_gap finding 不引数值、标签在 section 字段 → **F22**（373e8f5）：共享标识符指纹档 |
| R | 373e8f5 | FAIL（6/7） | 同一基线表问题的第三种措辞（claim 无数值、section 名变体）→ **F23**（32ada11）：**字节级表格 lineage**（引用数值全部位于与冻结基线逐字一致的表格 → baseline_inherited；词面归因不可枚举，改用内容字节证据） |
| S | **32ada11（最终）** | **AUTHOR_DECISION_REQUIRED**（7/7） | — |
| T | **32ada11（最终）** | **AUTHOR_DECISION_REQUIRED**（7/7） | — |
| U | **32ada11（最终）** | **AUTHOR_DECISION_REQUIRED**（7/7） | — |

**最终 HEAD 三连 S/T/U 全部合法终态（7/7 checks）——稳定性验收达标。**

## 4. Implemented fixes（汇总）——续

| # | commit | 修复 | 类别 |
|---|---|---|---|
| F19 | 3c58d4d | FACT_CHANGE 修复耗尽 → 确定性降级（machine resolve actionType） | machine-owned |
| F20 | 60bc7c6 | 零派发条目轮次合法跳过（revision.skipped） | routing |
| F21 | 534cf5c | 候选校验冻结基线口径（跨轮累积漂移提交前拦截） | preserve-by-construction |
| F22 | 373e8f5 | 归因共享标识符指纹档（tab:/fig: 规范标签） | attribution |
| F23 | 32ada11 | 字节级表格 lineage 归层（内容字节证据 > 章节名启发式） | attribution |

## 4. Implemented fixes（汇总）

| # | commit | 修复 | 类别 |
|---|---|---|---|
| F1 | a7ecb13 | fallback 条目 actionType=author_decision_required | machine-owned |
| F2 | 153029b | AUTHOR_DECISION_REQUIRED/EVIDENCE_ONLY 标记 sticky | machine-owned |
| F3 | a7ecb13 | 候选校验补 removed/placeholder/formula + mustPreserve span 前置投影 | preserve-by-construction |
| F4 | d6b407b | removed 类确定性段落恢复 | deterministic repair |
| F5 | 755ebdd | claimIndex lineage + 数值指纹归因档 | machine-owned |
| F6 | a7ecb13 | improvement plan 稳定 id（单编号空间） | lineage |
| F7 | a7ecb13 | 意见↔基线章节 noop 机会提示 | input enrichment |
| F8 | 71f66b9 | patch-backed outcome 覆盖（机器 lineage > 自报） | machine-owned |
| F9 | 71f66b9 | author-input modify 条目确定性重分类 | machine-owned |
| F10 | 71f66b9 | 待作者确认/裁决 → PLACEHOLDER_PATTERN | detector |
| F11 | 14eeec8 | 修订元注记正文污染候选级拒绝（revision_meta_text） | guard |
| F12 | 14eeec8 | 同参数等值赋值重述=格式等价 | detector |
| F13 | 591864a | changedFacts（含表格 cell）进候选校验 | guard |
| F14 | 0634a66 | strictPlanTextAuthorization：候选级与 cumulative 同授权标准 | anti-laundering |
| F15 | 0634a66 | 归因强证据档跨 category（弱证据档保留 fact/evidence_gap 门） | attribution |
| F16 | d41bf3e | noop 已满足证明=引文逐字核验，EV 绑定降为增强 | contract |
| F17 | 801dd55 | 节略引文核验 + noop 核验失败→作者裁决 | contract |
| F18 | bb06f5b | 兜底不受 20 条模型上限约束（意见保守不变量） | machine-owned |

共同主题：**把 comment closure / actionType 合法性 / 授权标准 / 归因主通道全部
收回机器职责**；模型行为方差（自报失真、越权改写、元文本污染、分析性论断、
计划文本洗白）被确定性拦在提交前或诚实转入作者裁决通道，不再放大为任务层 FAIL。

## 5. Deterministic regressions

`backend/test/review/m114ReliabilityClosure.test.ts`（36 用例，全绿）逐条回放真实
失败形态：fallback actionType（8c R1/R3）、sticky 标记（8c R2）、span 内删除/占位
检测输入（8b）、removed 类恢复（含歧义 skip）、数值指纹归因 + claimIndex lineage
（含越界/无佐证拒绝）、patch-backed 覆盖、author-input 重分类、【待作者确认】占位、
同参数等值重述、表格 cell 修改检测、strict 候选授权（lenient vs strict 对照）、
academic 跨 category 归因（含误伤对照）、evidence-free noop、节略引文（含顺序颠倒
拒绝）、20 条上限外兜底。另有 8c closure 回放脚本（scripts/m114-replay-attempt8-
closure.mjs：8c 真实产物 → 修复后代码 = AUTHOR_DECISION_REQUIRED 7/7）与 8a 回放
（无回归）。守卫语义零放宽：事实/引用/证据/Scope 全部保留且更早拦截。

## 6-8. Planner / Writer / Comment closure findings（结论）

- **Planner**：actionType 合法性、意见保守（不得消失）、author-input 重分类、
  noop 机会提示与引文证明全部由机器 owning；结构化修复保持 bounded（≤2）。
  Planner structured repair 在 post-fix runs 中 0 次耗尽（E 的耗尽是契约不可满足
  所致，已修）。
- **Writer**：proposal-only + span 限定不变；候选级校验补齐六类事实违规
  （direction/added/removed/placeholder/formula/changed）+ 元注记污染 + 结构损伤，
  bounded patch repair（≤2）在生产路径真实触发并成功（run D：3 次修复 2 成功）。
  post-fix runs 中 **Writer 越权事实改写 0 次进入冻结产物**（全部被提交前拦截或
  修复）。
- **Comment closure**：由「LLM 自报 + last-write-wins」改为「accepted patch lineage /
  确定性引文核验 / sticky 终态标记 / 作者裁决标记」的确定性推导；意见状态机的
  合法终态集合（handled / already_satisfied / conflict / author_decision）在最终
  3 连 run 中全部实证出现过。

## 9-10. 见 §3.1-§3.10（逐 run 记录）与 §4（修复汇总）

## 11. Real-run results & stability statistics

post-fix 真实 runs 共 **21 次**（全部：新 Project/新 Run/同 fixture/同 baseline
SHA 423CF0E0…/coding_plan 通道）：

| 段 | Runs | 结果 |
|---|---|---|
| 迭代段（每个失败 → 确定性修复 + 回归） | 1, A, B, C, E, F, H, J, M, P, Q, R（12 次） | 12 个新失败形态 → F8-F23 |
| 合法终态 | D, G, I, K, L, N, O, S, T, U（10 次） | 见 §3.5-§3.10 |
| **最终 HEAD（32ada11）三连** | **S, T, U** | **AUTHOR_DECISION_REQUIRED ×3，7/7 checks 全过** |

- 合法终态率（去重迭代段后）：10/10 达最终 HEAD 前 runs 中 7/10；最终 HEAD 3/3
- PASS 分布：G/I/O（O 为双层全过 + Final 冻结 + Publication READY）；其余合法终态
  为 AUTHOR_DECISION_REQUIRED（剩余项全部为 §13 真实作者级问题）
- 非法 FAIL / 阶段失败：最终 HEAD **0**；迭代段全部转为修复（每个有 commit + 回归）
- Planner：最终 3 run 结构化修复 0 触发；J 的修复耗尽由 F19 确定性降级兜底
- Writer：越权事实改写进入冻结产物 = **0**（提交前候选校验拦截 + bounded repair）；
  run D 实测 repair 通道真实工作（3 次 repair 2 成功）
- Comment closure failures（最终 3 run）：0；guard false positives：0；
  guard true positives（迭代段实证）：【待作者确认】正文、cell 漂移、公式洗白、
  方向翻转（均被正确拦截并驱动修复）
- 意见闭环合法终态全集实证：handled / already_satisfied / conflict /
  author_decision（N 单 run 集齐四种）

## 13. Remaining Author Decisions（真实作者级）

- 主表 vs 消融表数值矛盾（71.2/74.0/8200 vs 68.1/72.5/10800）——基线固有，需作者
  核对实验记录（当前以 baseline_inherited 呈现于投稿层风险清单）
- 摘要「均取得改善」与极端场景负面结果的矛盾（弱化口径需作者定夺）
- UA-DETRAC 定位表述、λ_smooth 最终取值说明、L_mem 梯度路径、模板外推速度来源
  （runs 中以 author_decision 诚实保留）
- Publication 层 academicScore 70-79 < 80：全稿质量层如实 NOT_READY（§47 允许）

## 14. Model reliability conclusion

GLM-5.3 + 修复后 Harness：**未达 MODEL_RELIABILITY_LIMIT**。模型行为方差仍存在
（自报失真、元注记污染、分析性论断倾向、计划洗白尝试），但每一类都被确定性
机制拦截或转合法通道；最终 HEAD 上任务层不再因模型行为失败。无需强模型 A/B。

## 15-16. Memory / resource audit（§50-64 义务）

方法：外部采样器（最大 node 进程 RSS + freeCommit/freePhys，60s 粒度，193 样本，
2.7h 窗口）+ performance-report spans 对齐；未加进程内 telemetry（避免闭环中途改
代码；外部口径满足审计数据需求）。

| 窗口 | RSS min/max/end | freeCommit min | 说明 |
|---|---|---|---|
| run1 纯工作流 | 152/309/163 MB | 4.88 GB | 阶段后回落 |
| runA/B（含并行全量测试） | 137/**1126**/168 MB | 2.91 GB | 峰值=vitest 4 workers，非工作流 |
| runC 纯工作流 | 168/251/169 MB | 4.77 GB | 回落 |
| runD-F（部分并行测试） | 123/751/168 MB | 2.72 GB | 同上 |
| runG/H 纯工作流 | 168/328/180 MB | 3.50 GB | 回落 |

结论：**无泄漏证据**——工作流进程 RSS 稳定在 150-330MB 带，每阶段后回落基线；
>700MB 峰值全部来自与工作流并行的本地 vitest 全量回归（4 workers），非 workflow
对象累积；Docling/Python 子进程按既有验证任务后退出（本 fixture 源为 md/json/csv，
未触发 PDF 解析）。Windows commit limit 23.2GB（含 pagefile），纯工作流最低余量
3.5GB，混合负载最低 2.63GB——16GB 开发机可用但并行「全量测试 + 真实 run」时偏紧
（freePhys 最低 1.68GB）。§78B 满足：合理峰值 + 无不必要累积 + 实测证据。

## 17. Docker / Linux recommendation（只读审计，§65）

M5.5 单机 Docker 路径已具备且设计健全：多阶段构建（backend/web 两 target）、
非 root 运行 + volume 事实源（PROJECTS_ROOT=/data/projects）、HEALTHCHECK 只探
/health、密钥仅运行时注入、TeX 包集按需、支持镜像站构建。迁 32GB Linux 服务器
= build + volume 迁移 + env 注入，无需代码改动。**建议**（非必需）：后续把
「真实 run + 全量回归」常驻到 Linux 容器以消除 Windows commit 压力与并行测试的
资源竞争；本机 16GB 继续可用于单 run 开发。

## 18. Tests

Backend full（4 workers，最终 HEAD 32ada11）：**229 files / 2538 passed / 0 failed**
（3 skipped 为 live-smoke 门；执行期偶发单测超时为本机已知资源 flake，复跑即绿——
全程约 10 次全量中出现 3 次，均在并行真实 run 时）。Frontend：27 files /
281 passed。Backend/Frontend typecheck PASS、build PASS（保留既有 Vite >500kB
chunk warning）。`git diff --check` PASS。

## 19. Git

14 commits（153029b→32ada11），全部 push；工作树 clean；
HEAD==origin/main==32ada11。

## 20. Final readiness

- Revision Task Gate 分层语义实证工作：G/I 达 REVISION_TASK_COMPLETE（任务成功 +
  Publication NOT_READY 并存呈现）；O 达**双层全过**（completion=final、
  Publication READY、art-final-rev3.pdf 冻结）；S/T/U 达 AUTHOR_DECISION_REQUIRED
  （守卫全过，剩余全部真实作者级）
- Draft PDF 正确：合法终态 runs 全部 buildOk=true 且产出 Draft/Final PDF
- Publication NOT_READY 可接受（§47）：剩余为真实作者级问题（§13）
- **M11.4 COMPLETE → READY_FOR_M11_5_CLOSURE**
