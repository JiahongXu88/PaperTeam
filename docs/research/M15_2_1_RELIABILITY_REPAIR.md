# M15.2.1 — Scientific Verification Reliability Repair（工程研究记录）

- 日期：2026-10-23
- 基线：main @ `6b44d8a37bb6400eab5aa870a293cff1d2a30dd4`（M15.2 PARTIAL 终态）
- 性质：M15.2 PARTIAL 后的低成本定向修复；**不是** M15.3、不是 Quality Gate 迁移、不是新模型实验
- 数据空间：`D:\PaperTeamData\M15\M15_2_1`（历史只读数据在 `D:\PaperTeamData\M15\M15_2`）
- 预算：**零付费模型调用**（未重跑 144 DEV + 48 SEALED，未跑任何新的大规模模型评测；PaperTeam Reviewer 模型配置未改动、未替换）

## 0. 一句话结果

**M15.2.1 ENGINEERING PASS（代码层修复）**：四个根因（N05 崩溃、N09 跨表假唯一、N03 严重度机械降级、复合意见部分反证整体撤回）全部修复且有测试；旧 SEALED 重放（EXPOSED_REGRESSION）唯一错误强判 N09-P05 翻转为弃权、1 条正判强判保留；DEV_NEW 5 条合法正判零损失；17 个新冻结配对案例 17/17；全量回归绿。**本 PASS 不能据此宣布 M15.2 COMPLETE，更不涉及 M15.3、Academic Score 校准或生产 Quality Gate V2 上线。**

## 1. 问题与根因（来自 M15.2 PARTIAL 审计）

| 编号 | 现象 | 根因 |
| --- | --- | --- |
| N05（P0-A） | `recomputeDerived` 在无行标签数据行上 `.find(...)!` 非空断言 → TypeError → 整篇 claim-audit 消失 | 派生复算假设参照行必有行标签；异常未被按条隔离 |
| N09（P0-B） | 复现表（缩写列名 MF1/MaF1）单元格经列维不可见 → 公平对比表成唯一候选 → 假 UNIQUE → 论断值与绑定值不一致仍出 `VERIFIED_CONTRADICTED`（SEALED 唯一 WRONG_STRONG，N09-P05） | 唯一性只在「解析成功进入候选集的单元格」内判断；跨表同名词行的数值竞争不可见；「复现」限定词未被绑定表语境解释 |
| N03（P0-C） | 真实注入的 Critical 缺陷被 `CRITICAL_REQUIRES_VERIFICATION` / `AUTHOR_OR_EXTERNAL_CAPPED_AT_MAJOR` 机械压成 major | 核验等级（有没有证书）与严重度（影响多大）被耦合在 severity 裁决里；「未核验」被当成「反证」 |
| P1（N1648BF8 r2 #47） | 复合意见（≥2 子断言）凭单条部分反证被整体 REFUTED → 整组撤回候选 → minor | 定向复核缺少逐子断言覆盖校验；撤回条件 `some(REFUTED) && !some(CONFIRMED)` 过宽 |

## 2. 修复内容（全部 SHADOW_ONLY）

### P0-A（N05）单条隔离与崩溃防护
- `backend/src/review/claimCertificate.ts`：`recomputeDerived` 参照行无行标签 → 不崩溃，fail-closed 记 `DERIVED_ROW_LABEL_MISSING`（行枚举不完整 → 复算覆盖不可证完整 → 不出证书）；新增 `certifierErrorCertificate`（claimCertificate.ts:988）把证书器异常按条兜底为有界诊断的 `CERTIFIER_ERROR:<Type>:<msg>`（不泄漏论文原文 / 模型原始输出）。
- `backend/src/review/claimAudit.ts`：`certificateFor` try/catch；异常条数 >0 时账本如实披露 `PARTIAL_AUDIT`（claimAudit.ts:1052），其余论断照常核验。
- `backend/src/workflow/definitions.ts`：shadow 构建的 catch 记日志（此前静默）。

### P0-B（N09）跨表假唯一性，三层防线
- **B1 表格解析**（`backend/src/review/latexTable.ts:475,520`）：分块数据表的「分组行 + Source/Metric 局部表头」在首个数据行后重复出现时，块后数据行继承该块的列头路径（此前一律沿用首块 → 跨块单元格错位、竞争单元格不可见）；无法对齐 / 覆盖不全 → 记 `IN_BODY_REPEATED_HEADER`（下游 TABLE_PARSE_ISSUES 拒绝出证）。普通整行分组行（非重复表头）不受影响。
- **B2 跨表数值竞争**（`backend/src/review/claimCertificate.ts:635`）：`bindTextAtom` 里，论断数值与绑定单元格不一致（`compareAtoms` 关系 ≠ OVERLAP，即将按差异出证）而该数值**逐字出现在其他表格的表格体内**时 → 跨表归属不可证 → 拒绝出证 `VALUE_APPEARS_IN_OTHER_TABLE:<tableIds>`（≤3 个表 id）。**只拦差异出证路径**：数值一致的绑定本身已有数值印证，不受影响。设计动机：值不一致证书是错误强判的风险面。
- **B3 限定词家族**（`claimCertificate.ts:291,656`）：reproduce/replicate 家族、fair、original、复现 —— 论断带这些限定词而绑定候选的表格语境（caption/label/行组/表头上层）整个家族都不出现 → 不是同一观察量，拒绝出证 `UNEXPLAINED_QUALIFIER:<词>`。家族内互通（「Reproduction results」caption 能解释「reproduced」）。显式 `\ref` **不豁免**。
- 通用性：无任何按 N09 表名 / arXiv ID / 数字 84.78、92.20 的特殊分支；FRESH 案例用完全不同的领域 / 名称 / 数值命中同一机制。

### P0-C（N03）核验等级 ≠ 严重度
- `backend/src/review/findingAdjudication.ts`：删除 `CRITICAL_REQUIRES_VERIFICATION` 与 `AUTHOR_OR_EXTERNAL_CAPPED_AT_MAJOR` 两个机械降级规则；严重度只允许两类确定性改动——上调 `CERTIFIED_CORE_CONTRADICTION_AT_LEAST_MAJOR`（证书证实的核心矛盾 ≥ major），下调 `DOCUMENT_CONTEXT_CONTRADICTS_WITHDRAWAL_CANDIDATE`（反证）/ `PARSE_UNRELIABLE_CAPPED_AT_MINOR`（可证转写损坏）。未核验状态如实记录在 verification 轴。
- 规则口径 `finding-adjudication-rules/v1 → v2`（schema 结构不变）；读取方契约同步：上调须证书规则码、下调须反证 / 转写规则码，未核验轴上的 critical 裁决合法（findingAdjudication.ts:31,233）。

### P1 复合意见不得凭部分反证整体撤回
- `backend/src/review/findingVerification.ts`：契约 `finding-recheck/v1 → v2`；新增确定性 `findingSubAssertions`（句界 / 分号 / `,\s+(and|but)` 独立子句拆分，不设上限——解析侧 refutedPoints ≤8 条使 >8 子断言的整条覆盖数学上不可能，天然 fail-closed）。整体 REFUTED 须逐子断言给出 `refutedPoints`：point 逐字取自意见原文、evidenceQuote 逐字落在候选片段中，且每个子断言都被覆盖；覆盖不全 → 降级 `PARTIALLY_REFUTED_BY_DOCUMENT_CONTEXT`（findingVerification.ts:24,232,320）。
- 裁决侧撤回条件收紧（findingAdjudication.ts:233）：根因内**每条**被复核的 finding 都整条 REFUTED 才是撤回候选；部分反驳 / 未定 / 失败成员在 → 不整组撤回（UNRESOLVED 成员此前不阻断撤回，现为保守方向）。

生产隔离：`backend/src/quality/gates.ts` 与 `revisionTaskGate.ts` 源码未改且 blob 与基线逐位一致（86e5378…/b1fe280…）；生产阈值 80/35、Major 零容忍、NOT_EVALUATED、Existing Paper Revision、HITL、Style suggest_only 语义全部不变。

## 3. UNIT_SYNTHETIC（确定性单元 / 合成测试，零模型）

| 套件 | 覆盖 | 结果 |
| --- | --- | --- |
| `claimAuditReliabilityRepair.test.ts`（新，5） | N05 崩溃防护 + CERTIFIER_ERROR 隔离（vi.mock 故障注入）+ PARTIAL_AUDIT 披露 + 独立验证来源不受隔离影响 | 5/5 |
| `latexTableRepeatedHeader.test.ts`（新，3） | B1：完整重复块继承 / PARTIAL 记 IN_BODY_REPEATED_HEADER / 普通分组行不受影响 | 3/3 |
| `claimCertificateCrossTable.test.ts`（新，7） | N09 全链：绑定 AMBIGUOUS 双理由码、端到端 NOT_CERTIFIED、\ref 不豁免、三个正判控制（值一致 / fair+ref / 注入矛盾）、账本级 REVIEWER_SUSPECTED + 可校验 | 7/7 |
| `findingAdjudicationN03.test.ts`（新，6） | P0-C：grounded critical 保留、EXTERNAL/AUTHOR 不降级、证书上调 + blocking、转写降级保留、契约（伪造降 / 升 → MALFORMED）、taskScope 边界 | 6/6 |
| `findingVerificationComposite.test.ts`（新，9） | P1：拆分规则、无覆盖降级、全覆盖 REFUTED、捏造 / 片外 point 不计、1/2 部分覆盖、单断言旧路径、解析 ≤8 界、裁决撤回收紧 | 9/9 |
| 既有相邻回归 | claimAudit 18、claimCertificate 27、findingVerificationAdjudication 7（其中 1 处期望按 N03 解耦更新） | 52/52 |

## 4. EXPOSED_REGRESSION（旧 SEALED / DEV 重放；已开封语料，不宣称 held-out 泛化）

harness：`M15_2/scripts/eval_pairs.mjs`，`M152_DIST` 指向修复后 dist，与 M15.1 构建（f2e7804）并行对照。产物：`M15_2_1/analysis/eval_pairs_sealed_regression.json`、`eval_pairs_devnew_regression.json`。

**SEALED_FINAL（93 案）**

| 口径 | M15.2 基线 | M15.2.1 修复后 |
| --- | --- | --- |
| WRONG_STRONG | 1（N09-P05） | **0** |
| CORRECT_STRONG | 1（N03-P02） | **1（同一条，保留）** |
| ABSTAIN | 83 | 84 |
| NOT_INJECTABLE | 8 | 8 |

N09-P05 翻转机制（通用路径，非特判）：`BINDING_AMBIGUOUS:UNEXPLAINED_CONTEXT` + `VALUE_APPEARS_IN_OTHER_TABLE:4b44c3069fef0a56,57c97dbb30f5999e` + `UNEXPLAINED_QUALIFIER:reproduced` → `REVIEWER_SUSPECTED`（ABSTAIN 类）。N09-P04（本已弃权）额外获得跨表理由码，判决不变。

**DEV_NEW（98 案）**：基线 {CORRECT_STRONG 5, ABSTAIN 88, NOT_INJECTABLE 5} → 修复后**逐项相同**；5 条合法正判（N01-P01、N01-P12、N14-P03、N02-P01、N02-P03）全部保留，零损失、零新增错误强判。合法正判损失清单：**空**。

## 5. FRESH_FROZEN（新冻结配对案例；FRESH_SANITY_ONLY）

- 位置：`D:\PaperTeamData\M15\M15_2_1\fresh_frozen\`（cases.mjs 最终 SHA256 `acf1923c…`；运行前冻结声明 DECLARATION.md 含判定关系 / 阈值 / provenance / SHA 与修订记录）。
- 17 案例 / 6 配对族（跨表同名 ×4、法务唯一绑定 ×2、体内重复表头 ×3、无行标签 ×3、复合意见 ×3、严重度解耦 ×2），领域（检测 / 推荐 / 机器翻译）、模型名、数值、表名均不同于任何单元夹具——验证通用性。
- 结果：**17/17 PASS**。出证 5（SUPPORTED 4 + CONTRADICTED 1，全部对照案例）；弃权 6（缺陷案例按理由码：UNEXPLAINED_CONTEXT ×4、TIED_CANDIDATES ×1、DERIVED_REFERENCE_AMBIGUOUS+ROW_LABEL_MISSING ×1）；CERTIFIER_ERROR 0；账本 2/2 可用且 VALID；零错误强判、零正判损失。
- 诚实标注：案例与修复同作者（本会话），无作者隔离 → **FRESH_SANITY_ONLY**，不宣称独立泛化证据。两次夹具修正（行标签分词同形导致真二义、FI 裁决规格漏 quote 字段）如实记录于 DECLARATION.md 修订节，期望值自冻结起未改动。

## 6. 全量回归与兼容

- backend：typecheck ✓；build ✓；**全量 vitest 4172 passed / 40 skipped / 0 failed**（`--maxWorkers=4`；前两轮各 1 例不同测试在满负载下闪失——revisionLoop、deployment，均单跑通过，与 M15.2 收官时 stylePolish 两次闪失同模式，第三轮全绿，日志 `analysis/backend_vitest_run3.txt`）。
- frontend：typecheck ✓；vitest 364/364 ✓；build ✓。
- `git diff --check` ✓（仅既有 CRLF 提示，无空白错误）。
- 生产门未动：`gates.ts` / `revisionTaskGate.ts` 源码零改动、git blob 与基线一致（`86e537812484df548fdd264736fb32b47fd19031` / `b1fe280cd9c2a53eaed28411c3de8e3608334273`）。
- 契约版本：`finding-adjudication-rules/v2`、`finding-recheck/v2`（读方已同步；无下游按旧字面分支）。全部 M15.2.1 改动 SHADOW_ONLY，`productionGateImpact: NONE_SHADOW` 不变。
- 行为边界：existing_paper_improvement 无新增 Review 调用；事实 / 引文保留、HITL、外审范围、Quick Review 只读、Style suggest_only 均未触碰。

## 7. 预算与模型调用

- 付费模型调用：**0**。未重跑 M15.2 的 144 DEV + 48 SEALED，未发起任何新的大规模模型实验；≤4 次 GLM Reviewer 冒烟的额度未使用（接线问题全部由确定性测试与零模型重放覆盖，无需冒烟）。Reviewer 模型配置未读取、未替换、未绕过。
- 确定性算力：本地 vitest 三轮 + 两次零模型重放 + 17 案例冻结包，均为本地 CPU。

## 8. 结论与边界

**判定：M15.2.1 ENGINEERING PASS（代码层修复）。**

- 未解决 bug：无（四根因各有测试 + 重放 / 冻结证据）。
- 错误强判：SEALED 重放 0；FRESH 0。
- 整账本丢失：无（N05 形态下单条隔离、账本 VALID 有测试与 FRESH 案例）。
- 关键回归：无（全量绿；生产门逐位一致）。

**边界（不得越读）**：
1. 本 PASS 是代码层修复验收；**M15.2 仍为 PARTIAL**，不因本轮回升为 COMPLETE。
2. 不宣布 M15.3 启动、Academic Score 校准、生产 Quality Gate V2 上线。
3. 旧 SEALED 已开封，本轮只作 EXPOSED_REGRESSION；不宣称 held-out 泛化。FRESH 包为 FRESH_SANITY_ONLY（同作者）。
4. 弃权率口径未变：跨表 / 限定词检查只拦「归属不明的差异出证」，没有通过放松唯一性或把模型推断当证书刷召回。

## 9. 遗留与下一步（不构成本轮承诺）

- N09 家族其余 ABSTAIN（MULTIPLE_METRICS_BEFORE_VALUE、UNEXPLAINED_TERM 等）属设计内弃权，召回提升需 M15.3 的绑定语义研究，不是修复项。
- 满负载下个别 e2e 测试闪失（revisionLoop / deployment / stylePolish）建议单独开工程项治理（计时敏感断言或资源隔离）。
- 复合意见 refutedPoints 依赖模型如实输出逐字 point；解析侧已有 ≤8 与逐字校验兜底，模型侧遵从率待 M15.3 实测。
