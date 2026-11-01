# QualityReport 契约（quality-report/v1）

- 实现：`backend/src/quality/qualityReport.ts`（纯函数）；生成点：`evaluateProjectQualityGate`（`backend/src/workflow/definitions.ts`，workflow `quality.gate` 与手动 `POST /quality-gate` 共用）
- 持久化：嵌入 `reviews/quality-gate-r{n}.json` 的 `gate.qualityReport`；读取统一经 `qualityReportOf(gate)`
- 前端：`frontend/src/types/qualityReport.ts`（同构类型）、`frontend/src/components/project/QualityReportLayers.tsx`（纯呈现，不重算）

## 1. 唯一事实源规则
1. `gate.passed` **只**从 `qualityReport.overall.finalizable` 派生；规则层原布尔与之不同时写入 `compat.difference` 并在 `gate.reasons` 追加 `quality_report:` 原因。
2. `gate.publicationReadiness.verdict` 从 `overall.status` 派生（PASS→READY，NEEDS_AUTHOR_DECISION→AUTHOR_DECISION_REQUIRED，其余→NOT_READY）；UI 文案为「无阻断项（不代表可投稿）」。
3. Finalize（`backend/src/artifacts/FinalizeService.ts`）在新鲜度检查之后要求 `qualityReportOf(gate).overall.finalizable`。
4. `GET /quality-gate` 返回顶层 `qualityReport`（旧产物 = 只读投影）；`rounds[].overall` 同源。

## 2. 层与状态
| 层 | 内容 | FAIL 的含义 |
|---|---|---|
| L0 | 覆盖、结构、事实 / 引用保持、未分类规则（fail-closed） | 完整性失败 |
| L1 | 跨节数值一致性、作者数据复算、引用元数据、已核验证据矛盾 | **已证实缺陷** |
| L2 | 模型 blocking / critical / major 计数、论断支撑（模型抽取）、未校准分数、claim 级影子审计 | 不出现 FAIL：模型阻断意见 → `NEEDS_VERIFICATION` |
| L3 | 编辑契约、patch 实质、任务层检查、待作者批准的数值修改 | 修订闭环失败 |
| L4 | 目标期刊水平 | 恒 `UNVALIDATED`，永不阻断、永不宣称通过 |

条目状态：`PASS | FAIL | NOT_EVALUATED | NOT_APPLICABLE | NEEDS_VERIFICATION | NEEDS_AUTHOR_DECISION | UNVALIDATED`；每条带 `evidenceGrade`（deterministic / author_data_recomputed / metadata_lookup / verified_evidence / llm_judgment / uncalibrated_score / edit_contract / author_decision / unclassified）与可选 `reasonCode`。

`overall.status` 优先级：FAIL > NOT_EVALUATED（任一必需未评估）> NEEDS_VERIFICATION > NEEDS_AUTHOR_DECISION > PASS；`finalizable = PASS | NEEDS_AUTHOR_DECISION`。非必需未评估项列入 `overall.unknowns` 并写进 `statement`（不静默）。

## 3. 有意的语义变化（相对 M15.20）
- `academic_non_regression`：未校准学术分相对基线回退超容差，由任务层硬 FAIL 改为作者裁决项（`advisory: true`，`UNCALIBRATED_SCORE_REGRESSION`）。依据：同稿重复评审 SD 5–12、容差 10 —— 分数不能承担硬门；警示保留。
- `cross_section_numeric_consistency`：被审修订快照缺失 / 无被审修订 → **必需** NOT_EVALUATED（移除核验输入工件不得放行）。
- 任务层 `deterministic_guards`：非必需 NOT_EVALUATED 的守卫不再写成「全过」（判定不变）。

## 4. 历史兼容
- 无 `qualityReport` 的旧产物经 `deriveLegacyQualityReport` 投影（`binding.entry = legacy_projection`）；规则缺 `status` 或缺 `verification` → L0 追加必需 NOT_EVALUATED `legacy_artifact_complete` → 不可冻结，需重新评估（确定性、零模型）。
- 零规则产物 → L0 必需 NOT_EVALUATED `gate_rules_present`。
- 旧产物不改写；重新评估会生成新的同轮产物。

## 5. 外部效度约束
`externalValidity = { independentHumanLabels: 0, scoreCalibrated: false, targetJournalValidated: false }`。只有按 `D:\PaperTeamData\M15\LongRunClosure\E3-calibration\CALIBRATION_PACKAGE.md` 回收独立人类标签并通过预注册线后，才允许修改这三项的来源；代码中不存在把它们置为 true 的路径。
