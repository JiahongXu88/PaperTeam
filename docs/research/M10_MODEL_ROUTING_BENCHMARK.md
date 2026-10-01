# M10.4.2 — Model Routing Benchmark（模型路由对 Existing Paper Revision Agent 的影响）

日期：2026-10-02　判定：**完成（可重复基准建立 + 4 配置 7 次真实运行实测；flash 两级否决、strict-harness 质量坍塌、发现 tier 无关的 fact-preserve 派生去重缺口——维持 all-strong 为唯一可行生产默认）**

---

## 0. 任务边界（先说不做什么）

- **不**修改核心 Revision 逻辑、**不**修改 Fact Gate / Quality Gate / Writer / Reviewer / Revision Loop（§7 红线审计：`definitions.ts` 与全部 gate/review/revision 服务文件零改动）。
- 新增能力只有两类：**per-role 模型路由配置**（planner / writer / reviewer 独立指定模型，M5.7 机制的 planner 分键扩展）与**基准编排器**（同输入逐 arm 真实运行 + 产物收割 + 路由验证）。
- 所有实验使用**同一输入**（§2），不修改论文内容；质量结论全部来自系统自有守卫的如实输出。

## 1. Research Question

M10.4.0 已证明 Revision Writer 是主要成本源（模型 latency 100% 由长生成主导，p95 224s / max 459s）；M10.4.1 已证明简单分节改造无收益（NO-GO）。本研究的问句：

> **RQ**：在固定输入与固定 harness 守卫下，按角色（planner / writer / reviewer）下调模型档位（strong → flash）、或收紧编排预算（revision 轮次），对 Existing Paper Revision 的**性能**（时长 / 模型调用 / tokens / 成本）与**质量**（事实违规 / 引用保持 / unsupported claims / Quality Gate / LaTeX 编译）有何影响？是否存在「可接受质量下的降本档位」？

子问句：
- RQ1：flash 作为 writer（仅写作位降档）是否保住契约与质量？（A2 ×2）
- RQ2：flash 作为默认（除 reviewer 外全降档）链路是否成立？（A3）
- RQ3：不动模型、只收紧 harness 预算（revision rounds 2→1）能否以质量换成本？（A4）
- RQ4：all-strong 基线在同 harness 下的方差与失败模式？（A1 ×2 + M10.4.0 历史样本）

## 2. Experimental Setup

### 2.1 固定输入（全部 arm 逐字节同源）

| 项 | 值 |
|---|---|
| 输入包 | `D:\PaperTeamData\M10.3-real-paper-case.zip`，SHA256 `b5d78f38242350fcd9ad872e245f584e092a864771c339d7c8f5f435677d7bd4`（编排器每次运行前重算断言）——与 M10.3 / M10.3.1 / M10.4.0 完全同一 ZIP |
| manuscript | 冻结版 `paper.tex`（77,731B，MANIFEST SHA 复核一致） |
| evidence | user_confirmed 实验证据同一注册脚本（battery/MOT/assoc/board-C0，≥9 条）+ 真实检索候选 promote 3 条（同一遴选策略） |
| reviewer instructions | 5 条第一轮意见（already_satisfied）+ 4 条作者目标（pending），逐字同源 |
| revision plan 输入 | 同一 run prompt / author goals / 意见摘要通道（plan 本身由 planner 在流内生成——它是路由研究对象，不是固定输入） |
| vision | 固定 `zai-coding-cn/glm-5.3-flash`（非本研究路由对象） |

### 2.2 执行环境

- 真实 GLM（`zai-coding-cn` 直连）+ 真实检索（OpenAlex/arXiv 等）+ docling + xelatex；每 arm **全新临时 PROJECTS_ROOT**，模型配置经 `PUT /api/settings/model` 显式下发（含 `agents` 整体替换——臂间零残留；arm 顺序 all-strong 收尾，磁盘偏好自动回基线）。
- 度量采集复用 M10.4.0 trace：每个 `model.turn` span 自带 `stage.id` / `model.label` / in·out·cache tokens / estimatedCost；质量取终局 `quality-gate-*.json`、`claim-gap-audit-*.json` 与产物存在性。
- **路由验证**：按 stage→角色族（`plan.improvement`→planner；`revision.*`→writer；`review.*`/`citation.*`→reviewer；其余→default）断言每个 model.turn 的实际模型与配置一致——全部通过（§4.2）。
- **复跑协议**：每 arm 至多 2 次尝试、全部如实报告（A3 因第一阶段即决定性失败且重跑无信息增益，保持 1 次）；不「重跑到成功为止」。
- 代码基线：全部 7 次运行均在 HEAD `7e51a34`。M10.4.0 历史样本在其原 HEAD `459019f`（其后两笔 commit ec7cf76/3525850 修正了事实提取噪声与 fact-preservation 配对——guard 语义有微调，见 §5.3 脚注）。

### 2.3 模型与价目（zai-coding-cn 目录）

| 模型 | in $/M | out $/M | cacheRead $/M | 备注 |
|---|---|---|---|---|
| glm-5.3（strong） | 0.6 | 2.2 | 0.11 | reasoning，text |
| glm-5.3-flash | 0.075 | 0.25 | 0.015 | reasoning，text+image；单价 ≈1/8 |

## 3. Model Configurations

新增配置能力（最小改动）：
1. **`improvementPlanner` 分键**：`writing/improvement-plan` scope 原先路由到 `writer` 键（M5.7），本次分出独立键——planner 与 writer 的模型偏好可分别配置（`backend/src/settings/ModelSettingsStore.ts` 的 `AgentModelKey` + `agentModelKeyForScope`，前端 Settings 面板同步）。未配置时继承默认，行为不变。
2. **基准编排器** `scripts/m1042-model-routing-benchmark.mjs`：arm 定义（default 模型 + agents override + harness env）→ 顺序真实运行 `scripts/m1031-real-e2e.mjs`（M10.4.2 钩子：`M1031_MODEL_DEFAULT` / `M1031_MODEL_AGENTS` / `M1031_EXPORT_DIR`）→ 产物收割至 `D:\PaperTeamData\M10.4.2-outputs\<arm>\` + 聚合 `benchmark-results.json`。复跑单 arm：`node scripts/m1042-model-routing-benchmark.mjs --arm A2`。
3. **driver 容错**：run 硬失败（fail-closed 守卫阻断）不再中断驱动——WARN 后继续收割 trace/gate/audit/摘要（终态断言仍如实 FAIL，退出码仍非零）。基准模式下「失败」是一等实验结局。

| Arm | label | default | planner | writer | reviewer 四路 | harness | 对应问句 |
|---|---|---|---|---|---|---|---|
| A1 | all_strong | glm-5.3 | strong（继承） | strong（继承） | strong（继承） | 默认（rounds=2） | RQ4 基线 |
| A2 | planner_strong_writer_flash | glm-5.3 | strong（继承） | **flash** | strong（继承） | 默认 | RQ1 |
| A3 | all_flash_except_reviewer | **flash** | flash（继承） | flash（继承） | **strong（override）** | 默认 | RQ2 |
| A4 | strict_harness_strong_writer | glm-5.3 | strong | strong | strong | **WORKFLOW_MAX_REVISION_ROUNDS=1**（默认 2） | RQ3 |

A4 的「stricter harness」只动**编排预算**（revision 循环轮次上限），不触碰任何 gate 阈值/规则（任务红线）。

## 4. Results Table

### 4.1 主表（7 次运行，全部如实报告）

| 运行 | 配置 | 终态 | wall(s) | turns | in tok | out tok | cacheRead | cost | 累计事实违规 | 引用保持 | 修订引入 unsupported | Quality Gate | PDF |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| M10.4.0 基线¹ | all-strong | completed(Draft) | 3,139 | 79 | 627,278 | 338,245 | 2,184,832 | $2.93 | 1（未授权数值新增） | ✅ | 9 | FAIL（3 规则，作者级） | 29 页（修订稿） |
| A1·attempt-1 | all_strong | **failed**@build.draft | 3,316 | 74 | 593,123 | 324,541 | 1,641,792 | $2.69 | r3 累计 0（resolved 1）；**rev2→3 未授权改写被 pairwise 守卫阻断** | ✅（r3） | 6 | 未达终局 | 无² |
| A1·attempt-2 | all_strong | **failed**@revision.plan | 2,468 | 67 | 372,770 | 252,679 | 1,196,672 | $1.94 | r1 累计 **2** 未解决 | ✅（r1） | 1 | FAIL（8 规则，r1） | 无² |
| A2·attempt-1 | flash writer | **failed**@revision.plan | 4,276 | 66 | 497,009 | 317,279 | 1,389,440 | $1.89 | 派生阶段即失败（§5.2） | ✅ | 6（r2 前） | 未达终局 | 无² |
| A2·attempt-2 | flash writer | **failed**@build.draft | 4,087 | 64 | 633,154 | 367,690 | 1,686,976 | $2.14 | r3 累计 **1** 未解决；rev2→3 未授权改写被 pairwise 守卫阻断 | ✅ | 7 | FAIL（9 规则，r3） | 无² |
| A3·attempt-1 | flash 默认 | **failed**@import.understand | 373 | 5 | 45,337 | 14,682 | 93,376 | $0.01 | 未达 | 未达 | 未达 | 未达 | 无 |
| A4 | strict harness（rounds=1） | completed(Draft，overflow) | 2,758 | 57 | 379,256 | 287,444 | 1,062,784 | **$2.07** | **20 未解决**（cumulative FAIL） | ✅ | 3 | **FAIL（6 规则**，含 fact_preservation/cumulative） | 29 页（修订稿） |

¹ M10.4.0 为历史样本：同输入同配置，但其 HEAD（459019f）早于本基准两笔 fact-extraction/pairing 修正 commit（ec7cf76/3525850），guard 语义略有差异——作为量级参照，不参与本基准均值比较。
² run 在 build.draft 前终止时，导出目录中的 paper.pdf 为 **import 阶段基线编译产物**（冻结稿编译，非修订稿）；「修订稿 PDF」仅在 run 走到 build.draft 时产生（M10.4.0/A4 两例）。
注：turns=assistant 模型调用数；cost=usage.cost 落盘值合计（list-price 估算）；「未达」= run 在该度量产生前已终止。

### 4.2 路由验证（全部通过——降档实验的受控性成立）

| 运行 | planner turns | writer turns | reviewer turns | other turns | 结论 |
|---|---|---|---|---|---|
| A1·1 / A1·2 | 8 / 3 ×strong | 2 / 1 ×strong | 40 / 36 ×strong | 24 / 27 ×strong | ✅ |
| A2·1 / A2·2 | 4 / 3 ×strong | **3 / 4 ×flash** | 33 / 37 ×strong | 26 / 20 ×strong | ✅（flash 精确落在 writer 位，零泄漏） |
| A3·1 | —（未达） | —（未达） | —（未达） | 5 ×flash | ✅（default=flash 生效；链路止于 import） |
| A4 | 4×strong | 1×strong | 32×strong | 20×strong | ✅ |

### 4.3 关键单点观测（trace 逐 turn）

- **whole-file 重写时延**（writer 位）：strong = **590s / 67.7K out 单 turn**（A1·1）；flash = **892s+764s**（A2·1）、**815s+340s**（A2·2）——flash 在等量任务上稳定需要 2 段长生成、**首段即 ≈1.4× 于 strong 的总时延**。单价低 8× 但调用结构（更长/更多段）与时延反向吃掉收益：A2 两轮总成本 $1.89/$2.14 vs A1 的 $1.94/$2.69——**writer 降档实际省 ≤$0.5，而 wall 反增 25–65%**（A2 两轮 4,276/4,087s vs A1·2 2,468s）。
- plan.improvement（strong planner，A1/A2 同档）：单 turn 128–266s / 9.9–20.6K out，与基线一致——planner 分键后行为无漂移。
- A2·1 一例 422s / 0 output token 的 review turn（流式中断后重试收敛）——strong reviewer 亦有长尾，未影响终态。

## 5. Analysis

### 5.1 RQ2（A3）：flash 默认在第一个契约点即不可用——两级否决的第一级

flash 作为 default（承担 import.understand / research / assessment 全部结构化输出）在 **import.understand 即失败**：论文理解 JSON 输出 2/2 次尝试不可解析 → run 终止（fail-closed 正确），代价 $0.01 / 6 分钟。结论：**flash 不能作为该 agent 的默认档**——问题不在「质量略降」而在结构化输出契约不可靠，链路没有机会暴露下游质量。

### 5.2 RQ1（A2 ×2）：flash writer 无新增失败模式，但也无净收益——两级否决的第二级

- **时延**：flash 的 whole-file 重写稳定慢于 strong（§4.3）；A2 两轮 wall（4,276/4,087s）**反超**同槽 all-strong（A1·2 2,468s）。「writer 降档省时」不成立。
- **成本**：A2 成本 $1.89/$2.14 vs A1 $1.94/$2.69——降档净省 ≤$0.5/run（<20%），因为成本大头在 reviewer/planner 的 strong 调用与 cache/input，flash 只打折 output 段。
- **失败点与 all-strong 同构**：A2·1 死于 `revision.plan` 的计划 schema 断言（duplicate `fact-preserve` id）；A2·2 死于 `build.draft` 的 pairwise fact 守卫——**正是 A1·2 与 A1·1 各自死亡的同一对守卫点**（§5.3）。flash writer 没有引入任何 strong 未见的失败模式；它同样过不了这些守卫。
- 两次 A2 的中间质量（r1/r3 gate）与 all-strong 同类：citation 保持 ✅、修订引入 unsupported 1–7 条、累计事实违规 1–2 条——**质量维度亦无可分辨改善**（本就没人指望 flash 更好，重要的是没有更坏的新形态）。

### 5.3 RQ4（A1 ×2 + 历史样本）：主导结论不是「strong 更好」，而是**tier 无关的 harness 缺口浮出**

- 同槽 all-strong 三样本结局：M10.4.0 completed（1 违规入 Draft）¹、A1·1 failed@build.draft（pairwise）、A1·2 failed@revision.plan（dup id）。
- **关键交叉观察**：A1·2（strong writer）与 A2·1（flash writer）死于**完全相同的故障**——Writer 在 ≥2 处做了同一未授权事实修改 → fact checker 产出两条同 `violationKey` 的 regression → `revisionPlan.ts` 的 `fact-preserve:<violationKey>` id 派生**无去重** → M9.10 `duplicate_item_id` 断言 fail-closed 拒绝整计划。该缺口与模型档位无关（两档都触发），是 M9.7.6「sectionMatches 多目标产生重复 id」的姊妹缺陷（确定性派生侧）。
- 共同底线：**所有 7 次运行的失败都是「守卫正确阻断」而非「坏稿漏网」**——包括 A4 的 20 违规也是被 gate 如实记录后经 overflow HITL 人工决策放行的 Draft（fail-closed 语义未被绕过）。
- 脚注：A1·1/A1·2 与 M10.4.0 的结局差异部分来自 guard 版本（3525850 located-swap-pairing 使 pairwise 检查更精确）+ 方差，不能全归因方差；本基准内部 5 次运行 guard 版本一致，横向可比。

### 5.4 RQ3（A4）：收紧编排预算是「用质量换成本」，且兑换率极差

A4（rounds 2→1，模型全 strong）：成本 $2.07（−29% vs M10.4.0）/ wall 2,758s（−12%），是本基准**唯一走到修订稿 PDF 的运行**；代价是 **20 条未授权事实违规直接进入 Draft**（vs 基线 1 条）+ Quality Gate 6 规则 FAIL（含 fact_preservation 与 cumulative）。机制：修订循环的 r2/r3 轮正是「守卫发现 → restore/repair → 复核」的质量主通道；砍掉轮次 = 砍掉修复机会，Writer 单轮的未授权改动不再有出口。29 页 PDF 与引用保持说明「产物完整性」不受影响——坏的是**事实纪律**。结论：**harness 预算不构成降本手段**（质量坍塌 20×，成本仅省 29%）。

### 5.5 成本与时延结构

- 成本结构以 cacheRead（1.0–2.2M tokens）+ input + strong output 为主；**writer 档位只作用于 output 段单价**，而 flash 的更长/分段生成与反超的 wall 把结构收益吃掉（§5.2）。
- 真正的降本杠杆与 M10.4.0 §6 结论一致：调用次数×长度的结构优化（review 逐节 fan-out 批量化、计划输入瘦身、cache 命中），而非模型档位。M10.4.1 已否定分节派发；下一候选是 review fan-out 粒度。

### 5.6 样本量与方差声明

每 arm ≤2 个真实样本 + 1 个历史同配置样本；单 run 方差显著（all-strong wall 2,468–3,316s、结局 completed/failed 并存）。本报告结论**不以均值差为依据**，而以（a）失败模式的机制归因与交叉复现（§5.2/5.3：两档命中同一守卫点）、（b）路由验证通过的受控对照、（c）守卫的确定性输出（fact violations / gate 规则）为依据。均值级数字（如「A4 省 29%」）仅作方向参考。

## 6. Recommendation for future Model Policy

1. **生产默认：all-strong（planner / writer / reviewer 全 glm-5.3）**。flash 两级否决（默认位契约不可靠 A3；writer 位时延反超 + 无质量增益 A2×2）后，不存在「可接受质量」的降档配置；strict-harness（A4）以 20× 事实违规换 29% 成本，同样不可接受。
2. **flash 的合规位：vision 与短调用辅助**（现状即如此——vision 固定 flash，本研究未改动）。不进入任何承担结构化输出契约或长生成的角色。
3. **per-role 路由机制保留为实验基建**（M5.7 agents override + 本次 planner 分键）：模型目录演进（新档位/新 provider/新定价）时可零代码重跑本基准——`node scripts/m1042-model-routing-benchmark.mjs --arm <id>`，输入 SHA 与路由验证自动断言；`benchmark-results.json` 按臂覆盖合并，支持增量补样。
4. **harness 预算红线：revision rounds 不作为成本手段**。压缩时长的正道是调用结构（review fan-out、计划输入瘦身、cache 命中），任何此类改动后用本基准重测。
5. **最高优先工程跟进（本基准的直接发现，不属本任务范围）**：`fact-preserve` 计划派生按 `violationKey` 去重（`revisionPlan.ts`，M9.7.6 姊妹缺陷）。它在本基准 7 次运行中 2 次（A1·2 strong / A2·1 flash，tier 无关）把 run 杀死在 repair 派生点；修复后该类失败会转为「repair 循环内可恢复」，A1/A2 的完成率预期显著上升——届时应重跑本基准复核本报告结论。
6. **守卫语义确认（Model Policy 的实验前提）**：全部失败结局均为 fail-closed（阻断产物）而非漏网；在测试过的所有档位下，Fact Gate / Quality Gate 语义完整性未被触碰。模型路由实验可以放心做——风险被守卫封顶在「白跑一次」而非「产出坏稿」。

## 7. 改动清单与红线审计

| 文件 | 改动 | 性质 |
|---|---|---|
| `backend/src/settings/ModelSettingsStore.ts` | `AgentModelKey` 增加 `improvementPlanner` + `writing/improvement-plan` scope 分键路由 | 配置能力（未配置时行为不变） |
| `frontend/src/types/api.ts` / `frontend/src/components/settings/AgentModelPanel.tsx` | 同步键类型与面板标签 | 配置能力 |
| `backend/test/runtime/agentModel.test.ts` | 分键路由断言（+3 例） | 测试 |
| `scripts/m1031-real-e2e.mjs` | M10.4.2 钩子（arm 标签 / 模型 default / agents / 产物导出）+ run 硬失败容错收割 + trace 按模型×stage 聚合 | 测试驱动 |
| `scripts/m1042-model-routing-benchmark.mjs` | 新增基准编排器 | 测试驱动 |
| `docs/research/M10_MODEL_ROUTING_BENCHMARK.md` | 本报告 | 文档 |

红线核对：`Fact Gate / Quality Gate / Revision Loop / Writer / Reviewer / Researcher / Citation / Evidence` 服务文件**零改动**；`definitions.ts`（全部 stage 语义）**零改动**；A4 的 harness 差异经环境变量（`WORKFLOW_MAX_REVISION_ROUNDS`）注入，属既有配置面。回归：backend **1989 passed / 0 failed**（3 skipped 文件为既有跳过）；frontend AgentModelPanel 测试通过。

产物归档：`D:\PaperTeamData\M10.4.2-outputs\`（benchmark-results.json、A1–A4 各自 trace/gate/audit/plan/tex/pdf、attempt-1 补救目录 A1-attempt1 / A2-attempt1 / A3-attempt1、每运行 performance-report.md）。
