# M15.8.2 — Evidence Recovery & Real Quality Gate / Final PDF Closure

- 日期：2026-10-27
- 基线：`bd9bbc0ff832ec86973fb9d6cba98da07b18cf31`（main == origin/main，clean；M15.8.1 收口 HEAD）
- 数据根：`D:\PaperTeamData\M15\M15_8\M15_8_2\`（预登记 `PRE_REGISTERED_E2E_GATES.md`、blocker ledger、账本、run 证据快照——不入 Git）
- 裁决：**M15_8_2_PARTIAL（P = BUDGET_EXHAUSTED）**——正向 READY/Final 未达成；N1/N2/H 按预登记前置（P clean PASS）未启动、预算未消耗；三项结构性工程缺陷定性与修复落地（R5 生产实证生效；D-2/D-3 修复就绪待下一授权会话行使）；无 false_ready、无语义篡改、无 HITL 越权。

## 0. 一屏结论

M15.8.1 恢复的 15 篇全文**确实包含**两条 r6 阻断 claim 的逐字支撑材料（Phase A 零模型核验：
S025 摘要 chunk 含 "65,213 pixel masks…semi-automatic…two existing tracking datasets"；
S006 §5 chunk 含 "online…real-time + accurate track trajectory across multiple frames"），
但 P 续跑在 32/32 预算硬停时 gate r9 仍 `passed=false`（unsupported 4 + major 3，较 r6
回归）。回归不是材料缺失，而是三个**结构性死锁**（§2）+ 一次**预算编排失误**（§3）。
本轮把三个死锁全部定性到产物坐标并落地修复（其中 R5 守卫修复在本轮 run 内实证生效：
rev9 九个 section「执行报告」污染清零）；续跑所需的一揽子解锁已就绪，等待用户对追加
预算的单独授权。

## 1. Phase A 零模型盘点（冻结于首个模型调用前）

- 起点核实：`p-6f05e6980fda`（topic_survey，zh）r6 `passed=false`（unsupported 2 +
  major 2）；rev-7 当前稿；17 verified evidence；25 sources = 23 available + 1 partial
  （S022）+ 1 metadata_only（S011）；Draft PDF `art-draft-rev5.pdf`（Build Gate PASS）。
- **四条 blocker 逐项定性**（`M15_8_2/phase-a/`，含原文/引文/坐标/拟处置）：
  - **B1** `c-f1c72ee4efb1`（65,213 掩码）+ fact-major `f-4c44907c48bf` 同根：r6 resolution
    判 remove 所依据的「无 grounding 通路」是 S025 恢复前的陈旧前提 → **CANDIDATE_FOUND_
    NOT_VERIFIED**（S025:SEC03:0001:09fbce9d3b 逐字支撑）。
  - **B2** `c-1696503d0138`（gad2022multiple 挑战）：绑定 E001（摘要级，judge=partially_
    supported）边界不足；S006:SEC11:0001:e5bee79383（§5 Current Research Challenges）
    逐字支撑具体枚举 → CANDIDATE_FOUND_NOT_VERIFIED。
  - **B3** fact-major `f-d2c5886ee71a`（结论趋势超证据）：rev7 已弱化且 validation 判
    validated（唯一全绿项）。
  - **B4** academic-major `f-e3e052e2cab3`（「无中立第一手梳理」与 S002 §5 MOT Metrics
    专章事实不符）：rev7 fallback 改写已执行，被 R5 污染连累判 rejected。
  - **R5（新增定性）**：r6→rev7 Writer 把「执行报告：…（f-/c- 内部 ID）」无书名号段落写进
    正文，双守卫漏检；污染段落数字/实体反被事实守卫保护 → 清除补丁被拒 → 卡在稿内。
- NOT_EVALUATED(required)=0：`cross_section_numeric_consistency`（NO_TABLES，not
  required）、`target_feasibility`（not required）如实记录，不阻断也不算通过。

## 2. 三项结构性缺陷（全部产物坐标化 + 修复落地）

| # | 缺陷 | 证据坐标 | 修复（本轮落地，commit 见 §5） |
|---|------|----------|--------------------------------|
| R5 | 修订执行报告无书名号形态 + f-/c- 12hex 内部 ID 双守卫漏检（M11.4 Run A / M14.9-MOT 家族第三变体） | `revision-validation-r6.json` rejectedItems（fact_preservation_violation + unsupported_named_reference ×2）；rev7 四处污染 | `writerCommentary.ts`（INTERNAL_ID 并入 f-/c- 12hex；词汇表 + 执行报告）+ `definitions.ts` REVISION_META_TEXT_PATTERN 行首无书名号分支 + 真实形态回归测试。**run 内实证**：rev9 污染 0/9，65,213 归因式保留 |
| D-2 | targeted grounding 词面通道对中文 claim × 英文 chunk 结构性零命中 → `no_candidate` → resolution 每轮 re-offer ground → claim 永远 UNSUPPORTED（r7/r8/r9 三轮实证） | run 事件 seq 63（0/2 verified）；r8/r9 ground stageResult（gad claim `no_candidate: 目标源（S006、S008）无词面命中 chunk`） | `TargetedGroundingService`：词面零命中时数值（千分位/小数/≥5 位，排除裸年份）/拉丁（≥3 字符）锚确定性回落（`claimAnchorTokens`/`selectAnchorWindow`/`anchorFallbackChunks` + `RetrievalService.readSourceChunks`）；quote 锚居中逐字切片；judge 三段核验不变（不硬配） |
| D-2 配套 | resolution 无跨轮记忆：同一（claim+源）no_candidate 后仍每轮 re-offer | claim-resolution r8/r9 同条目重复 `ground_existing_source` | `ClaimResolutionContext.priorNoCandidateGroundKeys`（claimFingerprint + 源签名；源集变化允许重试——basis 升级场景）+ plan stage 从同 run 前轮 ground outcomes 还原记忆 |
| D-3 | 恢复全文的 basis 闸门：冻结语料快照 basisDepth=abstract_only → `groundableInBasis=false` → 65,213/kirillova claim 直接落 remove 阶梯 | `corpus-snapshot.json`（S003/S017/S022/S025 abstract_only）；r7/r8/r9 resolution（remove_unsupported_detail×2/轮） | 设计正道行使：产品 API `POST /survey/corpus/refresh`（0 模型，18 条目失效，revision=1）+ 增量 `POST /survey/matrix/build`（S003/S017 → fulltext；S022/S025 因账本争抢拒付）+ 零模型 `scripts/m1582-corpus-sync.mjs`（buildCorpusRows 语义原样对齐快照）→ 24/25 可采证（S011 真实无 OA） |

**D-1（数值删除指令 vs 数值冻结守卫死锁）不单独修**：grounding 打通后 65,213 claim 走
verified 绑定（数值保留），remove 指令不再触发——死锁自然消解。若 grounding 被 judge
拒绝，数值阶梯仍是诚实回落（删除/定性化）。

## 3. P run `w-b294fb42225f`（32/32，16 min）

- 流程：front 指纹复用（research.plan 2）→ r7 审（3）→ gate r7 FAIL → plan（含 2 ground）
  → **evidence.ground_claims 0/2**（D-2）→ r7 写（7）→ validate → r8 审（3）→ gate r8
  FAIL（4+3，回归）→ plan → matrix 重建 2（我方 API 并发触发）→ r9 审（3）→ 写（4）→
  revision_stalled（REGRESSED）→ revise_more → **32/32 硬停**。
- 回归构成：r7 修订引入新 claim `c-c67d6d264a06`（sanmiguel/wernholm 双归属）+ 3 条既有
  claim 因 D-1/D-2/D-3 未解维持 UNSUPPORTED。convergence 检测器如实 REGRESSED。
- **操作者偏离自述**：matrix 重建与 run 修订循环并发争抢同一 32 账本是编排失误（4 次
  matrix 调用 2 被拒付且挤压 r9 余量）。正确顺序 = refresh + 全量 rebuild 先行，再启动 run。
- 诚实边界：全程无 false_ready（gate 每轮如实 FAIL）；citation 15/15 干净保持；证据库
  17 条零伪造；HITL 由驱动按预登记策略应答（approve ×4 front + revise_more ×1）。

## 4. 预算与成本（M15_8_2 新账本；旧 166 不变）

| 子账本 | 上限 | 实用 | 说明 |
|---|---|---|---|
| `budget/p.json`（P） | 32 | **32** | 26 run + 2 matrix settled + 4 run 尾段；拒付 2（S022/S025 matrix，stop 记录） |
| `budget/n1.json` | 8 | 0 | 前置（P clean PASS）未满足，未启动 |
| `budget/h.json` | 12 | 0 | 同上 |
| 阶段合计 | 52 | **32** | tokens：in 277,006 / out 24,019（p.json 汇总）；Z.AI Coding Plan 边际 $0（额度口径如实） |

零模型操作：preflight×2、dry-run、corpus refresh、corpus-sync、全部 Phase A 审计——
0 模型实证（账本 calls 不动）。

## 5. 工程交付（源码，全部测试通过）

- `2837324`（前置于 run）：R5 守卫修复 + 回归（writerCommentary 10/10）。
- 本次提交：D-2 锚回落 + no_candidate 记忆 + `readSourceChunks` + `m1582-corpus-sync.mjs`
  + 回归（targetedGrounding 8 新增、claimResolution 2c）；review/quality/evidence/
  retrieval 1293/1293、workflow 465/465、tsc 0 错、build 成功；全量套件与 CI 见 §7。

## 6. 续跑授权请求（不自行追加）

`--continue` + 新 P 账本。预算估算：matrix 重建 16（设计成本，refresh 已失效的条目）+
r10 审 3 + ground 2-4（S025/S006/S003 均已可采证且锚回落就绪）+ 写 3-5 + r11 审 3 +
build/final 0 ≈ **27-31**；建议授权 **40**（含一轮冗余）。预期终态：65,213 verified
绑定（S025）、gad claim 弱化收敛（no_candidate 记忆防循环）、kirillova/cazila 锚回落
或删除阶梯；P PASS 后按预登记执行 N1（8）/N2/H（12）。

## 7. 测试、Git 与 CI

- 本地：backend typecheck ✓ / build ✓ / 全量 vitest（见提交说明）✓；frontend typecheck ✓。
- Git：基线 `bd9bbc0` → `2837324`（R5）→ 本次收口提交；直推 main。
- CI / Linux Integration：最终 HEAD 结论于推送后回填（PENDING 不预测）。

## 8. 结论

G1/G2（正向 READY + Final）**未达成**（预算硬停）；G6 部分达成（R5 修复实证 + 既有语义
零回归 + 零 false_ready）；G3-G5/G7-G8 未进入判定（前置未满足）或待续跑。M15 总目标
保持 **INCOMPLETE**。与 M15.8 的差别：阻断根因从「材料缺失 × 预算」细化为「三个已定性
且已修复的结构性死锁 + 预算编排失误」，续跑的一揽子解锁已就绪。
