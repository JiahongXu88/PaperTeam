# M15.17 — Target-Journal Evidence-Gap-Driven Revision & Reassessment

日期：2026-10-31 · 基线：main @ 720f0a69（M15.16 结束态）
裁决：`M15_17_REVISION_INTEGRATION = PARTIAL`（G3 真实模型执行腿被三个真实交互依次阻断——两个已修复入库、链路由集成测试证明；见 §3/§9 逐项）
里程碑：`M15_TARGET_JOURNAL_QUALITY = INCOMPLETE`（学术质量校准未做，判定不变）

## 0. 一句话

把 M15.16 已产品化的「目标期刊证据审计」接入既有论文修改体系：审计 gapPlan 经**确定性分类门禁**转为
可检查的修订计划，作者逐项决策后可改写项转入**外部修改意见通道**（由既有 improvement 工作流的真实
Writer + Patch/Fact/Citation/Scope 守卫执行），需真实实验项停在**既有作者裁决闭环**（不伪造数据），
修订后以确定性复评给出逐项闭环状态——三类证据分离与「不构成录用判断」纪律全程不变。

## 1. 架构与状态转换（Phase A 冻结）

```
审计执行（M15.16，既有）                    审计快照冻结（既有）
TargetEvidenceAuditService.evaluate  →  research/target-contribution-audit.json
                                             inputFingerprint{manuscriptSha256, poolFingerprint,
                                             promptVersion, documentType, venueId} + manuscriptRevision
        │
        ▼  [新增] POST /target/evidence-audit/revision-plan（零模型）
可修改候选（确定性分类 B2）            锚投影（quote 回放核验，不猜位置）
REWRITE_ELIGIBLE / NEEDS_REAL_EXPERI-  claimQuote → manuscript sections/*.tex
MENT_OR_AUTHOR_INPUT / NEEDS_TARGETED_ （escape 逆变换 + \cite/[n] 对齐 + CJK 剥空白回退；
EVIDENCE / EVIDENCE_INSUFFICIENT /     多命中→节序 hint tie-break；零命中→UNMAPPABLE）
UNMAPPABLE_TARGET
        │  research/target-audit-revision-plan.json（幂等；绑定审计指纹+修订号）
        ▼  [新增] POST .../decide（作者逐项 approve/reject；≠自动批准改稿）
现有 Revision Plan / 外部意见转入路径（既有，最小扩展）
  - REWRITE_ELIGIBLE → ExternalInstruction(source=target_audit, pending, section 限定)
    · buildRevisionPlan：target_audit → priority=high（不高于真人意见 mandatory）
    · 派发文案如实标注 advisory；指令文本内嵌「」原文锚（单元级定位）
  - NEEDS_REAL_EXPERIMENT 等 → statusNote=AUTHOR_DECISION_REQUIRED（永不派发 Writer；
    进入既有作者裁决队列 / revision.report / revisionTaskGate AUTHOR_DECISION_REQUIRED）
        │
        ▼  用户启动 existing_paper_improvement run（既有编排，零改动）
原有 HITL（既有）                       应用（既有）
hitl.research_plan / evidence_supply /   revision.apply → writer.reviseSection
plan_confirm / revision_validation       （proposalOnly + patch pipeline + 全守卫）
        │
        ▼  [新增] POST .../reassess（零模型；指令状态+patch lineage+守卫结果）
复评 → VALIDATED_FIXED / PARTIALLY_ADDRESSED / STILL_OPEN / NEEDS_AUTHOR_DECISION /
       ALREADY_SATISFIED / AUTHOR_REJECTED / NOT_EVALUATED → TargetPanel 展示
```

接点源码：分类/投影/决策/复评 `backend/src/target/TargetAuditRevisionService.ts`（新）；指令通道
`backend/src/review/externalInstructions.ts`（+source=target_audit、add() pending 态受控 statusNote）；
优先级 `backend/src/review/revisionPlan.ts:280`（target_audit→high）；装配 `backend/src/target/services.ts`
+ `backend/src/serviceStack.ts:1001`；路由 `backend/src/httpServer.ts:2381-2482`；前端
`frontend/src/api/target.ts`（+4 API）+ `TargetPanel.tsx`（7b 区块）。

## 2. 交付清单

### 后端
- `backend/src/target/TargetAuditRevisionService.ts`（新，~900 行）：
  - **分类门禁（B2，不信任模型 actionType 单独放行）**：requires_real → NEEDS_REAL_EXPERIMENT；can_rewrite
    需同时满足「贡献锚已核验 + quote 可投影到唯一可编辑章节」；INSUFFICIENT_EVIDENCE 且无可解析先前工作 →
    NEEDS_TARGETED_EVIDENCE；锚未核验 → EVIDENCE_INSUFFICIENT；PDF-only 无可编辑稿 / quote 不可定位 →
    UNMAPPABLE_TARGET（fail-closed，不猜位置）。
  - **防陈旧（B1）**：生成与决策绑定审计 inputFingerprint + evaluatedAt + 修订号 + venue；不一致 →
    409 TARGET_AUDIT_STALE / TARGET_AUDIT_PLAN_INVALID_STATE。换稿 / 换期刊 / 重新审计 / 修订号前进
    全部确定性阻断；已决策计划不允许被新审计静默覆盖。
  - **幂等**：同一审计工件 + 同修订号重复生成 → 同 planId 直接返回；决策重试经指令内容哈希 id 去重。
  - **禁止项快照**：目标文件数值 token + \cite key（protectedInventory 同口径）写入计划项。
  - **复评（Phase C，零模型）**：指令状态机（handled=Writer applied+真实变化+gate 复核）+ patch 校验
    工件 commentIds lineage + 守卫结果 → 逐项闭环；审计此时陈旧与否如实披露（auditStaleNow），闭环判定
    不依赖重新审计。
- `externalInstructions.ts`：+`target_audit` source（advisory 标签）；`add()` 允许 pending 态携带
  AUTHOR_DECISION_REQUIRED / EVIDENCE_ONLY_RECORDED 前缀 statusNote（白名单；人工通道语义不变）。
- `revisionPlan.ts`：target_audit → priority=high（真人意见仍 mandatory 并先序）；派发文案源感知。
- `errors.ts`：+TARGET_AUDIT_STALE(409) / TARGET_AUDIT_PLAN_INVALID_STATE(409)。
- 路由：GET/POST `/target/evidence-audit/revision-plan`、POST `.../decide`、POST `.../reassess`
  （flag off → enabled:false / 403，与 evidence-audit 同 fail-closed）。
- **零改动红线复核**：gates.ts / qualityPolicyV2 / factPreservation / citationPreservation /
  revisionScope / patchValidation / WorkflowOrchestrator 全部未触碰（git diff 确认）；N1/N2/H 不变量
  经原有回归套件验证。

### 前端
- `api/target.ts`：计划 / 决策 / 复评视图类型 + 4 API。
- `TargetPanel.tsx` 7b 区块（随审计 flag 渲染）：空态 + 生成按钮（审计 stale 时禁用）；分组徽章
  （五类分类）；逐项锚 / 先前工作身份 / 禁止变更清单 / 允许范围 / 实验需求包；逐项 批准/不采纳；
  转入提示；复评报告（闭环汇总 + patch lineage + 守卫 ✓✗ + 免责声明）。
- `ExternalInstructionsPanel.tsx` + `types/api.ts`：target_audit 来源标签。

### 测试（新增 38 例）
- `targetAuditRevision.test.ts`（30，含 P1 逐字锚提取 2 例）：可比化纯函数（escape 逆 / [n]↔\cite / CJK 剥空白 / 最小长度
  CJK 口径）；投影（唯一 / 多命中 tie-break / 不猜位置 / 引用标记替换后仍可命中）；分类门禁五分支；
  服务编排（无审计 fail-closed / 换稿 409 / 幂等 / venue 切换 409 / 重新审计拒覆盖 / 决策幂等 /
  部分决策补交 / patch lineage 复评 / 作者拒绝终态）；接入纪律（target_audit=high 且真人先序 /
  AUTHOR_DECISION 条目 skipped / add() pending statusNote 白名单 / 指令文案指纹锚）。
- `targetHttp.test.ts` +3：flag 双态路由契约（403 / 409 / 400 / 404）。
- `workflow/targetAuditRevisionWorkflow.test.ts`（1 大例，scripted 全流程）：PDF 导入 → run 暂停 →
  审计工件 → 计划（分类+投影）→ 决策 → 恢复 run → revision.apply 真实派发（可改写 handled；需实验
  不派发）→ 修订号前进 → 复评（VALIDATED_FIXED + NEEDS_AUTHOR_DECISION）。
- `TargetPanel.test.tsx` +4：flag off 不渲染；空态真实点击 generate；计划渲染 + approve 真实调用
  decide；陈旧计划决策入口关闭。

## 3. 真实 E2E 验收（Phase E）

环境：真实 backend（生产栈 / Pi runtime）+ `PAPERTEAM_TARGET_EVIDENCE_AUDIT_ENABLED=true`；
数据 `D:\PaperTeamData\M15\M15_17\`（MANIFEST 含 SHA256，36 文件）。样本复用 M15.16 合法私有语料：case-R
（中文研究论文 PDF）× CJIG；综述替换样本见 B0。**模型通道如实记录**：前段走公司 GLM 网关
（claude-opus-5-5，8 次成功调用 ≈$2–3 量级），中期个人配额 402 耗尽后按任务书切换 **Z.AI Coding CN**
（zai-coding-cn/glm-5.3，订阅制）完成全部后续调用。物理会话合计 53（含 ~6 次 402 失败尝试），
成功调用 ≈ 45–47，预算 120 内。UI 验收（Chrome CDP 真实点击）：全新项目「生成计划→批准转入」、
case-R 决策+复评报告、综述闭环报告、换稿项目决策阻断——**关键断言全部通过**（4 截图存档
`e2e/ui/00–03*.png`）。

<!-- E2E-RESULTS -->

### A. case-R（中文研究论文 PDF × CJIG，只读项目）——零伪改动闭环 ✓

- 审计：真实模型 4 次调用 / 135s / pool 12；gapPlan 4 项（3 × requires_real + 1 × can_rewrite）。
- 计划（零模型）：3 项 NEEDS_REAL_EXPERIMENT_OR_AUTHOR_INPUT + **1 项 can_rewrite 被门禁降级为
  UNMAPPABLE_TARGET**（只读项目无可编辑稿——不猜位置改写），与 M15.16「5/5 需实验」口径同向
  （本轮审计其中 1 项判 can_rewrite，被确定性分类正确拦截）。
- 决策：4 项全部批准 → 4 条 AUTHOR_DECISION_REQUIRED 指令（pending + 受控 statusNote；零派发）；
  幂等重试不重复建指令。
- 复评：4 × NEEDS_AUTHOR_DECISION，**VALIDATED_FIXED=0**——零修改、零伪数据，待补实验清单完整可见。

### B0. b1（作者中文综述 PDF）不可重建——如实记录并按任务书替换样本

b1 与 CJIG 已刊综述 PDF（jig_220670「红外—可见光跨模态行人检测综述」等）解析产物均为近无结构
（正文并入单一节 / "Whole Document"+References；TOC 缺失）→ PaperReconstructor 需 ≥3 个有效正文节
→ import.parse fail-closed（IMPORT_VALIDATION，E2E B0 步骤自动化留痕，projectId p-94b1ae3c4e38）。
按任务书 Phase E「选有真实来源的其他可编辑综述样本」改用 **arXiv:2609.08265「Tracking-by-detection
in Multi-object Tracking: Survey and Experiments」（KAIST 2026，开放获取，39 TOC 节）**——真实综述、
与项目 MOT 领域同域、解析结构完整（重建 4 个章节文件）。

### B. MOT 综述（arXiv 2609.08265 × CJIG，goal=improvement）——三轮真实闭环

**三轮执行记录（全部真实模型）**：

| 轮 | 审计 | 计划 | 执行 | 复评终态 |
|---|---|---|---|---|
| 1（glm 网关） | 4 调用/183s；5 gap（1 can_rewrite + 4 需实验） | 1 REWRITE（投影 sec01）+4 需实验；全批准 → 5 指令 | run 至 research.propose 因 **glm 网关 402 个人配额耗尽**失败（外部阻断）；切 Z.AI Coding CN 通道重跑；run 完成 revision.apply，但可改写指令派发 unmatched（**逐字锚失配**→修复 P1）；build.draft 被 FACT_PRESERVATION_FAILED 拦截（**守卫按设计工作**：3→4 未授权事实改写，Draft 阻止） | —（失败态如实留痕） |
| 2（restore→重审计→Z.AI） | 4 调用；5 gap（1 can_rewrite） | tap-559bffd7996c-rev5：1 REWRITE（texAnchor 提取成功）+2 需实验；全批准 | run 完成（draft，30 阶段）；规划器把可改写指令拆为 modify（弱化过强表述，措辞与引用保护完全正确）+ author_decision（区分定位子需作者）两条——modify 条绑定失败（**规划器转述引文近似**→修复 P2）；指令按「部分子要求待作者」保守开放 | 1 STILL_OPEN + 2 NEEDS_AUTHOR_DECISION（复评细化后为 PARTIALLY_ADDRESSED 形态） |
| 3（重审计→Z.AI） | 3 调用/69s；**2 gap（全部 requires_real——当前稿的可改写缺口已不在审计视野，模型变异）** | 2 NEEDS_REAL；全批准 → 2 作者裁决指令 | run 完成（draft，28 阶段；rev9=restore_facts） | **2 NEEDS_AUTHOR_DECISION，VALIDATED_FIXED=0——零伪改动，待补实验清单完整** |

**G3 判定依据**：真实模型链路中「审计→计划→决策→指令」与「作者裁决终态」两段完整验证；可改写项的
**真实执行**在三轮中分别被三个不同的真实交互阻断（402 配额 / 逐字锚失配 / 规划器拆条绑定），前两个
已诊断并修复入库（P1/P2 提交，单测+脚本化集成测试锁定），第三个的修复（sourceText 携带指令原文）
在第三轮时审计已不再产出可改写项（诚实行为：当前稿无该缺口）。完整执行链（含 VALIDATED_FIXED）
由 **scripted 全流程集成测试**证明（真实 PDF 导入→审计→计划→决策→派发→守卫→修订→复评）。
按任务书严格口径，G3 判 **PARTIAL**。

<!-- E2E-RESULTS-C -->

### C. 负例验证汇总

| 负例 | 结果 |
|---|---|
| 1 stale（换稿/换刊/重审计/修订前进） | UI 实测：换稿项目计划区块渲染且**决策阻断** ✓；单测：指纹/evaluatedAt/修订号/venue 四路 409 ✓；HTTP 契约 ✓。E2E 脚本 C1 场景因 402 事件后重构未复跑（等价覆盖见前述） |
| 2 无法核验 quote / prior-work | 分类门禁降级（EVIDENCE_INSUFFICIENT / UNMAPPABLE）单测 ✓；case-R 真实数据 1 条 can_rewrite 被判 UNMAPPABLE ✓ |
| 3 Guard 拒绝（删引用/篡改数值） | 守卫文件零改动 + 既有回归（fact/citation preservation 套件 57 例）全绿 ✓；真实 run 中 FACT_PRESERVATION_FAILED 实际拦截 ✓ |
| 4 flag off | GET enabled:false / POST 403（HTTP 契约测试）；前端区块不渲染（UI 测试）；原有路径不变（全量回归）✓ |
| 5 全部需实验 → 零伪改动 | case-R 真实复评 4×NEEDS_AUTHOR_DECISION / VALIDATED_FIXED=0 ✓；综述第三轮 2×NEEDS_AUTHOR_DECISION / 0 ✓ |
| 6 幂等/恢复 | decide 重试不重复建指令（真实 A6 + 单测）✓；reassess 幂等（B10 真实 + 单测）✓；failed run → 新 run 链路（指令队列/计划工件持久化）三轮实证 ✓ |

## 4. 真实 E2E 发现并修复的问题（本轮交付的一部分）

- **逐字锚失配（P1 修复，提交 4f778ea）**：首轮综述 run 中可改写指令派发 unmatched
 （「指定章节未匹配到稿件文件」）。根因：派发端单元定位（resolveUnitByQuotes →
  anchorPattern）是**逐字**匹配，而指令内嵌的 PDF 原文锚在重建 TeX 中因 %/&/_ 转义与
  [n]→\cite 替换必然失配；长章节（>9000 字符）展开为多编辑单元且无整 span 回退 →
  绑定失败。修复：计划期 `extractTexVerbatimQuote`（归一化对齐 + 索引映射回原始 TeX
  字节），指令以「TeX 逐字锚」优先、PDF 原文锚随后；+2 单测锁定逐字回放。该问题只可能
  在真实长文档 E2E 中暴露（scripted 短章节 / 单测 fixture 均不触发）——真实验收的直接产物。
- **事实保持守卫真实触发**：首轮综述 run 在 build.draft 被
  FACT_PRESERVATION_FAILED 阻止（修订 3→4 存在未经授权的事实改写）——M5.6/M10.4.3
  守卫在真实路径按设计拦截（系统诚实失败，未产出违规 Draft）。处置：restore 回基线
  修订 → 按二轮审计重新计划/决策/执行（即真实用户的返修路径）。

## 5. 发现的既有问题（如实记录，不在本轮修）

- **targetChanged 与落盘守卫的顺序差**（definitions.ts:3931 vs 4103-4137）：文件级目标的 targetChanged
  在内容塌缩 / 守卫表格拒绝**之前**计算——候选被拒落盘时指令状态机仍可能按「已处理」流转（scripted
  测试中复现；真实模型下塌缩拒绝路径罕见）。属修订引擎既有行为，本轮不触碰（影响面在 external
  instruction 状态聚合，不在守卫本身）；建议 M15.18 前专项复核。
- revisionLoop 全量并行下的 5s 超时 flaky（M15.16 已知形态；隔离复跑 8/8 全过）。

## 6. 三类证据分离与科学不变量复核

- 官方指南 / benchmark 观测带 / 贡献审计三工件三区块不变；本闭环只消费贡献审计工件（advisory），
  不触碰 guideline / profile / rubric 语义。
- **不升格证据**：pool 候选 / 摘要 / verified_fulltext 材料只作为指令内归因上下文；不写 EvidenceStore；
  指令文本明令「不得新增文献」「不得新增数值」；引用守卫（citationPreservation / MISSING_CITATION_KEY）
  与事实守卫（factPreservation / cumulative）判定口径零变化。
- **审计不高于真人意见**：buildRevisionPlan 中 target_audit → high；improvement 派发伪条目仅当
  instructionId 关联时沿用既有 mandatory 语义（与真人意见同规则，非新增层级）。
- **审计不改 Gate**：qualityPolicyV2 / gates.ts 零改动；复评结论是 advisory 报告，不进任何质量门。
- 无「达到 CJIG/CEA 录用水平」「录用概率」输出；复评报告携带免责声明。

## 7. 复现路径

1. `cd backend && npm run build && PROJECTS_ROOT=<隔离目录> PAPERTEAM_TARGET_EVIDENCE_AUDIT_ENABLED=true PAPERTEAM_PORT=<p> node dist/index.js`
2. `node scripts/m1517/e2e-acceptance.mjs --base http://127.0.0.1:<p>`（HTTP 全链：case-R 零修改闭环 /
   b1 真实修订闭环 / stale 负例 / 幂等）
3. `cd frontend && npx vite`（另终端）+ `node scripts/m1517/ui-acceptance.mjs`（浏览器真实点击）
4. 单测：`backend && npx vitest run test/target/targetAuditRevision.test.ts test/workflow/targetAuditRevisionWorkflow.test.ts test/target/targetHttp.test.ts`；
   `frontend && npx vitest run test/TargetPanel.test.tsx`

## 8. 未覆盖 / 风险 / 下阶段

- **未覆盖**：NEEDS_TARGETED_EVIDENCE 项的自动定向补证（本轮诚实停在作者决策——补证后重新审计即可
  重分类）；多在库全文 pool 升级规模化（M15.16 遗留，不变）；Linux Integration 对最终 HEAD 的结果
  （推送后核对）；targetChanged 顺序差（§4）。
- **风险**：整文件目标（< 9000 字符章节）无 span patch 记录——复评 lineage 退化为指令状态机 +
  resolutionTrace（已在报告中如实区分标注）；claimQuote 含 [n] 引用标记时长文件单元锚定位可能失败
  （fail-closed 成 unresolved，不误派发）。
- **下阶段（M15.18 真实投稿场景系统验收）尚需**：目标期刊投稿包（cover letter / highlights / 格式
  检查）能力；CEA 全文语料；§5 顺序差修复；**把作者批准状态馈入改进规划器**（本轮实证：规划器把
  作者已批准的 target_audit 可改写指令拆条后，author_decision 子条会翻转指令状态并阻断原始派发通道
  ——建议规划输入携带「该指令已经作者批准执行」上下文，或对 target_audit REWRITE 项走独立派发面）；
  真实用户对闭环报告的可用性反馈。

## 9. 验收门

| 门 | 结论 | 证据 |
|---|---|---|
| G1 计划转换 | PASS | 分类门禁 28 单测 + HTTP 契约（409 stale / 400 非法体）+ E2E A4/B4；stale/venue/重审计全阻断 |
| G2 修订科学纪律 | PASS | 需实验项分类恒定 + AUTHOR_DECISION 指令永不派发（工作流集成测试断言）+ 指令禁令文本 + 守卫零放宽；case-R 零修改闭环（E2E A） |
| G3 真正闭环 | PARTIAL | 链路与终态由 scripted 全流程集成测试证明（含 VALIDATED_FIXED）；真实模型三轮：审计→计划→决策→作者裁决终态完整，可改写项执行被 402 配额/逐字锚失配/规划器拆条依次阻断（前二已修复入库，§4） |
| G4 复评诚实 | PASS | 七态分列 + auditStaleNow 如实 + 免责声明；无录用判断输出；不可复评项 NOT_EVALUATED |
| G5 UI/E2E | PASS | 浏览器真实点击（生成/决策/复评）+ flag off 不渲染（UI 测试 + HTTP 403）+ 既有入口不变 |
| G6 工程可靠性 | PASS | 双端 typecheck / build / git diff --check；全量回归（清洁环境后端 414 文件/4551 测试全绿、前端 38 文件/371 测试全绿；E2E 后端并行期间 revisionLoop 出现 5s 超时 flaky——与 M15.16 同款已知形态，停并行后清洁复跑全绿）；守卫文件零改动；最终 HEAD CI 见 §3 补记 |
| G7 证据与复现 | PASS | 私有数据 + SHA256 manifest + 模型调用账（§3）；公开仓库无私有全文 / 密钥；脚本可复现 |

**M15_17_REVISION_INTEGRATION = PARTIAL**——产品链路（分类/防陈旧/决策/转入/复评/守卫/flag）全部
落地并经真实与自动化验证；唯「真实模型下审计批准的可改写项自动执行」一腿在三轮真实 E2E 中被三个
不同交互依次阻断（glm 网关 402 配额耗尽、逐字锚失配[已修复 P1]、规划器拆条近似引文绑定[已修复
P2]），其完整闭环由 scripted 集成测试证明；第三轮审计对当前稿已无报告可改写缺口（诚实行为）。
**M15_TARGET_JOURNAL_QUALITY = INCOMPLETE**（无独立学术质量人类标签校准——本轮一切输出仍为
advisory，不构成录用判断）。
