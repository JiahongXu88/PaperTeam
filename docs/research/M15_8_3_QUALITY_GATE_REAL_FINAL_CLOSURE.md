# M15.8.3 — Quality Gate Real Final Closure

- 日期：2026-10-27
- 基线：`106592ff023514bf6a780b7be2266b5b5771ec1c`（→ `de988bd` 披露指引修复）
- 数据根：`D:\PaperTeamData\M15\M15_8\M15_8_3\`（预登记含 append-only 偏离、p40 账本、run 证据快照、SHA256 manifest）
- 裁决：**M15_8_3_PARTIAL（P = QUALITY_NOT_REACHED @ 40/40）**——真实生产 Gate 仍未 PASS，无 Final PDF；N1/N2/H 按前置未启动（n1 0/8、h 0/12 未动）；预算内完成的增量：E018/E019 两条 verified evidence 经产品管道入库、65,213 claim 六轮复发问题解决（SUPPORTED + finding 消失）、披露口径机制首次在生产 run 中闭环（r14 transparent=1）。M15 保持 **INCOMPLETE**。

## 0. 一屏结论

用户授权的 40 次 P 预算按预登记串行执行：**先修数据状态（G7 指纹恢复消灭 55+ 调用级联）→ run 外补证（E018/E019）→ 两段续跑**。第一段（21 调用）证明 G7 恢复与预置证据完全生效（matrix/synthesis/outline/writing 全 0 调用；65,213 在 r10 即 SUPPORTED，六轮复发的 fact-major 同步消失），但暴露**fixed-point 收敛缺陷**：r10→r12 三轮计划条目全部 executed+validated 而阻断 8→7→7 不动——计划处方文本本身被下一轮 claim 重抽为新 opaque claim。落地最小修复（needsEvidence 指令携带披露契约的标记词形；分类器/Gate 语义零改动）后第二段（16 调用）建立真实收敛速度：opaque 7→6→**5 + transparent 1**（14 轮以来首次有 claim 进入透明披露口径）、gate major 7→3→2——但预算恰在拐点耗尽。剩余 5 条 opaque claim 均为「归因转述无核验证据」型，理论出口已全部打通（披露口径/语料升级），量差 ≈3-5 轮修订（12-20 调用）或一次 55+ 调用的完整语料升级。

## 1. 执行序列（全部有产物坐标）

| 步骤 | 调用 | 结果 |
|---|---|---|
| 零模型 preflight | 0 | r9 真实阻断=4 claim+3 major（非 r6 旧口径）；级联定量 55+ 不可行；G7 副本 matrix 指纹与 synthesis 记录**逐字节相等**（`07f8d054…7749`） |
| claim-resolution 重算 | 0 | tripwire 账本实证 0 调用；ground 3 / remove 0（65,213 从 remove 翻转为 ground） |
| preground | 3 | E018←S025 **judge=supported**（65,213 逐字）；E019←S022 partial（cazila 比较段）；1 次模型 env 配置失败如实入账 |
| G7 matrix 恢复 | 0 | 25 条目恢复；run 内 matrix/synthesis/outline/writing 全部幂等复用（事件序列实证 0 调用） |
| 第一段 run w-76bb6fbc0256 | 21 | r10（E018 绑定 SUPPORTED ✓）→ r11 → r12 fixed-point 实证 → overflow→accept_draft；Draft rev12 |
| 披露指引修复 | 0 | `de988bd`（指令侧；回归含指令句→分类器闭环断言） |
| 第二段 run w-567237ed652d | 16 | r13（6 opaque）→ r14（**5 opaque + 1 transparent**、major→2）→ 40/40 硬停在 r15 前；Draft rev14 |

## 2. r14 剩余阻断（5 opaque + 2 gate major）

- c-008ccd7c3300 lealtaixe/MOTChallenge 基准演进（E016 partial 边界）
- c-5c87a171ea04 wernholm 计算效率定位（「仅作文献定位」不在标记表）
- c-a4cbf906eee8 检测感知方向定位
- c-349031b82296 cazila 比较（E019 partial 边界）
- c-72c973b78e7a kirillova 场景覆盖
- major：结论/正文的机制性断言同步 + 学术深度分歧（审稿自给 fallback=「显式声明证据所限仅作文献定位」——该措辞同样不在标记表）

**共性**：全部是「对被引文献的归因转述 + 无核验证据」型；产品出口=（a）披露标记补齐（部分措辞如「仅作文献定位」未进 `DISCLOSURE_UNVERIFIED_MARKERS`——指令侧已引导用「未经独立核验」，r13→r14 已见 1 条走通）；（b）完整语料升级（refresh→matrix 16→synthesis→outline→重写 ≈55+，一次性根治深度与证据两面）。

## 3. 预算与诚实边界

| 账本 | 上限 | 实用 | tokens（in/out） | list-price |
|---|---|---|---|---|
| p40（P） | 40 | **40** | 430,921 / 52,299 | $1.2331（Coding Plan 边际 $0，额度如实计） |
| n1 | 8 | 0 | 前置未满足 | — |
| h | 12 | 0 | 前置未满足 | — |

零模型操作（preflight、resolution 重算、G7 恢复、补充审计 A-D）实证 0 调用。无 false_ready（14 轮 gate 全部如实 FAIL）；Draft 构建合法（rev12/rev14，Build PASS）；HITL 全部按预登记策略应答；证据库 19 条全 verified、零伪造。

## 4. 本阶段工程交付

- `de988bd`：披露指引修复（`revisionPlan.ts` appendEvidenceDisclosureGuidance + 回归 2 例含闭环断言）+ `m1582-recompute-resolution.mjs`（零模型重算脚本）。
- 生产实证修复链：R5 守卫（M15.8.2）→ D-2 锚回落（本轮 E018 生产验证）→ 披露指引（本轮 r14 transparent=1 首证）。
- 补充任务 A-D：见 `M15_8_3_ADDITIONAL_QUALITY_AND_EFFICIENCY_AUDIT.md`。

## 5. 续跑授权请求（不自行追加）

两条路径（按性价比排序）：
1. **披露口径收尾 ≈12-20 调用**：续 `--continue`，r15+ 指令继续携带标记词形引导（已验证 ~1 条/轮速度，或可在指令中点名全部剩余 claim）；预期 3-5 轮内 rule 4 清零 → major 同步 → PASS → Final → 再启动 N1/N2/H（8+12）。
2. **完整语料升级 ≈55-70 调用**：refresh→matrix 16→synthesis→outline→9 节重写（一次性根治内容深度与证据覆盖，M15.8.2 §6 同一清单）。

## 6. 测试 / Git / CI

- 见最终提交说明（全量 vitest + typecheck + build + frontend typecheck）；CI / Linux Integration 于最终 HEAD 回填。
- M15 总目标：**INCOMPLETE**（P 未 PASS、无 Final）。本报告不以「阻断项减少」「机制验证成功」替代最终产品目标。
