# M16 工程可靠性收口（Engineering Reliability Closure）

```
M16 ENGINEERING CLOSURE: CLOSED
A 语言漂移与 repair: 根因 = 单元输出顶层 JSON 不合法（中文正文里的未转义 ASCII 引号等）时解析器静默回退到内层 issue 碎片 → 单元记 completed 但 0 issue / 无分数 / claims 缺失 → 论断修复；语言漂移是放大因素（英文指令漏点名 summary）。修后历史 35 次不合法输出 28 次只加转义完整恢复（结构 0 不符）、7 次如实失败走重试；M8OGl34Pmg 形态注入测试零修复调用；漂移只记录不花调用；中文稿 prompt 不变
B Hybrid 预算和终态: 有调用上限时论断修复为跨章 / 整稿预留额度、单元重试只为未开始的首审让路（PAPERTEAM_REVIEW_STAGE_CALL_RESERVE，缺省 on）；整稿 required / executed / skippedReason / callsUsed 落 coverage，未执行 → Gate review_whole_paper_reported = NOT_EVALUATED「不是 hybrid」；上限 7 的脚本压力样本：on 整稿完成、off 复现饿死；四种终态 + off 兼容均有测试
C Finding locator: 定位引用三态 VALID / INVALID / UNVERIFIABLE；新留出集旧 22 条「不存在」→ 0 INVALID / 10 UNVERIFIABLE / 12 VALID（全是转写稿丢失编号的公式），证书判定 520 条 0 变化；作者源稿上预登记无效引用 100% INVALID，合法 \label / 编号 / 引文键 0 误拒
D 数值证书: 现有 TEXT_TABLE_VALUE / TABLE_MULTIPLIER 两类；新集漏斗 520 → 293 → 251 → 106 → 101 → 12 → 0（缺输入 8、语义欠定 4）；未发现可安全新增的确定性类型，不实现新核验器；既有 2 个正例、0.036% 硬负例、来源门测试零回归
真实模型调用: 14/24
完整生产 review: 1/1
全量测试/E2E/CI/Linux: backend 438 files 全过（见 E5）；frontend 41 files / 385 passed；typecheck + build 双端 exit 0；Playwright m15-quality-report 2/2（smoke.spec 1-3 为既有失败，见 E5）；CI 与 Linux Integration 在 6b2b37b 上均 success
仍未解决的工程风险: 模型输出语言仍有随机性（指令补齐的效果仅 n=1 smoke，未统计证实）；结构性坏 JSON（缺开引号 / 单引号键）仍触发单元重试花调用；转写稿表格部分丢失时 C 的 INVALID 残余误判风险（未见实例）；smoke.spec 1-3 既有失败未修
L4 Academic Validity: EXTERNAL_VALIDITY_LIMITED (unchanged)
Git HEAD / origin/main / working tree: 代码提交 6b2b37b（CI + Linux Integration 绿）；本报告为其后的 docs-only 提交，最终 HEAD == origin/main == ls-remote 与 clean 工作区记录在 ACCEPTANCE.json
```

- 日期 2026-11-03 · 执行 Claude（Opus 5.5）· 起点 `627a0f9`（HEAD == origin/main，执行前核对；工作区 clean）
- 外部证据：`D:\PaperTeamData\M16\EngineeringReliabilityClosure\`（`PROTOCOL.md` + sha256、`RUNLOG.md`、`ACCEPTANCE.json`、`replay-*.json`、`scratch/` 回放脚本、测试日志、smoke 产物与 `budget/calls.jsonl`）。历史目录只读，未写入。
- 本文是本轮唯一报告；不改写前序 M16 报告。

## E0 基线与再现 — PASS

| 项 | 事实 |
|---|---|
| Git | `D:\Projects\PaperTeam`，main，fetch 后 HEAD = origin/main = `627a0f91332c479c84082bd7076b24f90394655c`，clean |
| 配置 | `PAPERTEAM_REVIEW_WHOLE_PAPER` 缺省 on；产品缺省不限调用数（`PAPERTEAM_GLOBAL_MAX_MODEL_CALLS` / run 预算 0）；M16 实验 runner 设单次运行任务级账本上限 21 |
| 调用链 | `review.run`（`workflow/definitions.ts`）→ `ReviewerService.reviewUnit`（单元审稿 + 内联 claims + ≤1 次论断修复）→ 单元重试（≤3 次尝试）→ `reviewCrossChapter` → `reviewWholePaper` → `computeReviewCoverage` → `quality.gate`（`evaluateQualityGate`、`verifyFindings`）→ QualityReport L0–L4 / API / UI |
| 遗留进程 | vite 5177（PID 25192）、5178（PID 14800）非本任务启动，只记录未动 |
| 失败再现 | A/B：历史 C/production 调用记录只读回放；C/D：历史 verified-findings + 原文只读回放；均为零模型 |

## E1 工作包 A：语言漂移与无效修复循环 — PASS

### 根因（逐项证实，不凭「输出中文」一句断言）

| 假设 | 证据 | 结论 |
|---|---|---|
| 模型输出漂移成中文 | 12 篇英文稿 153 个单元：summary 中文 50、description 中文 14、「summary 英文 + description 中文」0；逐篇粘滞（M8OGl34Pmg 12/12） | **成立，但不是修复的直接触发** |
| 解析误判 | 232 次单元输出 35 次顶层 JSON 不合法；旧 `extractJsonObject` 对 34 次「从下一个 `{` 重试」→ 返回单条 issue 碎片 | **直接根因** |
| 错误分类 | 碎片无 `issues` → `parseIssues` 按「模型省略 issues」返回 []；单元记 completed、`issueCount` 0、分数 null；无 `claims` → ABSENT → 修复调用 | **成立：静默丢失 + 假覆盖** |
| 修复指令放大 | 修复 prompt 只补 claims（不重审），返回合法 claims；不会循环（`UNIT_CLAIM_REPAIR_MAX = 1`）；9 / 7 次 = 9 / 7 个碎片单元各 1 次 | 不是无界循环，是「每个碎片单元 1 次」 |
| 语言探测误报 | 产品此前没有语言探测；修复触发与语言无关 | 否 |
| 为什么与中文相关 | 中文正文引英文术语时写裸 ASCII 引号（`"real-world dynamics"`）；英文正文也会（qxRoo7ULCo `"Splatting" as "Splitting"`） | 漂移提高不合法 JSON 概率 |
| 为什么会漂移 | 单元英文指令只点名 `description / suggestedAction / reason`，漏了最先输出的 `summary`（digest 模式指令点名了 summary）；shared_session 下首个单元的语言延续 | 指令缺口（确定性可修） |

附带发现：一次修复调用的返回是 `401: {"code":"1000","message":"身份验证失败。"}`，旧解析器把 `{code,message}` 当成合法对象（YiyG1tHDxq #06）。

### 改动
- `backend/src/agents/outputParsing.ts`
  - `extractJsonObject(raw, what, { expectAnyKey, onRepair })`：顶层对象解析失败时先做**只加转义**修复（`repairJsonEscapes`：控制字符 → 非法反斜杠转义 → 未转义引号；不删改任何字符）；输出本身就是一个顶层对象（首字符 `{`、末字符 `}`）时**不再回退到内层碎片**，修复仍失败就抛 `StructuredOutputError`（调用方既有重试 / 失败路径）；`expectAnyKey` 拒绝不含预期顶层键的对象（错误体 / 碎片）。说明文字包裹 JSON 的旧兼容不变。
  - `escapeStrayQuotesInJsonStrings`：字符串内引号后（跳过空白）不是 `} ] :`、文本结束或「`,` + 值起始符」→ 视为字面量。结构错误（缺开引号、单引号键）修复后仍失败 → fail-closed。
- `backend/src/agents/ReviewerService.ts`
  - 单元审稿 `expectAnyKey = summary/issues/academicScore/riskScore/claims`；论断修复 / 独立抽取 `["claims"]`；跨章 / 整稿 `["issues","summary"]`。
  - `UNIT_EN_OUTPUT_DIRECTIVE` 点名 `"summary"` 与 claims 的 `"note"`（只影响英文稿；中文 / 未指定语言 prompt 逐字节不变）。
  - `detectUnitLanguageDrift`：英文稿下 summary / issue 自由文本 / claims note 的 CJK 占比 > 15% → `outputContract.languageDrift`（逐字引文不计）。**只记录：不翻译、不删 finding、不发修复调用。**
  - `outputContract.jsonRepairs` 记录实际生效的修复种类（provenance）。
- `backend/src/review/coverageLedger.ts` / `workflow/definitions.ts`：单元记录 `outcome.outputContract`；`coverage.outputContract = { expectedLanguage, jsonRepairedUnitIds, languageDriftUnitIds }`。
- `backend/src/quality/gates.ts`：informational 规则 `review_output_contract_reported`（L0，确定性；有漂移 / 预留跳过 → NOT_EVALUATED，否则 INFO；不参与判定）。

### 验证
| 证据 | 结果 |
|---|---|
| 历史回放（`replay-parse-after.json`） | 35 次不合法 → 28 完整恢复（stray_quote 26、invalid_escape 2）、7 次如实抛错；28 次恢复的 issue / claim 数与原文键数逐一相等（0 不符） |
| M8OGl34Pmg 形态注入（真实 `review.run` + 脚本 runtime） | 3 单元全部恢复 2 条 issue + 分数 + claims；**论断修复 0 次**；`jsonRepairs=["stray_quote"]`、`languageDrift=["summary","issues","claims"]`；引号字面量保留；coverage complete |
| 不可修复输出 | 单元第 1 次不可解析 → 第 2 次成功：attempts 2、issue 恢复；始终不可解析 → 单元 failed（error 含「顶层 JSON 对象不合法」）、coverage 不完整、`review_coverage_complete` FAIL——不再是「0 issue 的 completed」 |
| 错误体 | `401: {...}` 不被接受，走重试 |
| 中文稿对照 | prompt 不含英文语言指令；合法中文输出不报漂移、无 outputContract |
| 变异检查 | `outputParsing.ts` 换回 HEAD 版：A 组 3 个解析测试失败；恢复后通过 |

限额与 reason code：论断修复仍 ≤ 1 次 / 单元；单元尝试 ≤ 3；新增的只是「不可解析 → 抛错」（触发既有重试，可能比旧行为多花调用——旧行为是静默丢弃整单元的 finding，现在用调用换覆盖，并受 B 的准入约束）。

## E2 工作包 B：Hybrid 整稿预算与诚实终态 — PASS

### 改动
- `backend/src/review/reviewCallBudget.ts`（新）：调用准入（只在配置了调用上限时生效；无上限恒放行 = 行为零变化）。优先级：单元首审 > 单元重试 > 跨章 / 整稿（各 1）> 论断修复。
  - 单元重试准入：`剩余 − 未开始首审的单元数 ≥ 1`（正文覆盖不为整稿让路）；
  - 论断修复准入：`剩余 − 未开始首审 − 跨章/整稿预留 ≥ 1`；被拒 → `claimExtraction.repairSkippedReason = BUDGET_RESERVED_FOR_REQUIRED_STAGES`，账本保持 ABSENT / INVALID（不伪造为已抽取）；
  - `PAPERTEAM_REVIEW_STAGE_CALL_RESERVE=off` 回到旧的先到先得（回滚开关）。
- `backend/src/runtime/runBudget.ts`：`RunBudgetSnapshot.remainingCalls`（run 级与任务级取小；准入参考，硬约束不变）。
- `workflow/definitions.ts`：
  - 整稿记录 `{ status: completed | failed | skipped, required: true, executed, skippedReason?: BUDGET_EXHAUSTED | NO_BODY_TEXT, callsUsed, inputMode, … }`；预算已耗尽时不发起调用直接 skipped；调用被账本拒绝（MODEL_BUDGET_EXCEEDED）也记 skipped 而非 failed；
  - `coverage.callAccounting`：首审 / 重试 / 论断修复 / 跨章 / 整稿调用数，及为预留而未发出的重试 / 修复数（观测，供维护对账）；
  - 单元失败记录 `attempts` = 实际尝试次数；重试被预留拒绝时 error 前缀 `UNIT_RETRY_SKIPPED（BUDGET_RESERVED_FOR_REQUIRED_STAGES）`。
- `quality/gates.ts`：`review_whole_paper_reported`（L0 informational）——completed → INFO「已执行（hybrid；全文 / 仅摘要）」；failed / skipped → NOT_EVALUATED「要求的整稿综合审查未执行：本轮结果是纯单元审查，不是 hybrid」；未启用 → NOT_APPLICABLE。`reviewPurpose.ts` 只读视图把未执行的整稿列入 notEvaluated。
- 整稿 finding 仍不进正文覆盖率分母；单元覆盖不完整照旧 `review_coverage_complete` FAIL。

### 验证（`backend/test/workflow/reviewReliabilityClosure.test.ts`，真实 stage + 脚本 runtime + run 预算账本）
| 场景 | 结果 |
|---|---|
| 上限 7、3 单元全缺 claims、预留 on | 调用 ≤ 7；修复 2 次、跳过 1 次（账本 ABSENT + reason）；跨章、整稿 completed（executed、callsUsed 1）；Gate INFO |
| 同上、预留 off | 修复 3 次 → 整稿被拒：`skipped / BUDGET_EXHAUSTED / executed=false / callsUsed=0`；无整稿 finding；Gate NOT_EVALUATED「不是 hybrid」，规则 passed（informational） |
| 上限 6、一个单元首审不可解析 | 重试被准入（不为整稿牺牲覆盖）：coverage complete，整稿 completed |
| 四种终态 | 全部完成：complete + completed / INFO；单元部分失败 + 整稿完成：coverage FAIL + 整稿 completed；单元完成 + 整稿未执行：coverage PASS + 整稿 failed / NOT_EVALUATED；两者都不完整：coverage FAIL + NOT_EVALUATED |
| whole-paper=off | 无整稿调用、无 wholePaper 字段（旧产物兼容）、Gate NOT_APPLICABLE「纯单元审查」 |
| 旧测试 | `wholePaperSynthesis.test.ts`（off 时单元 prompt 逐字节相同、GLOBAL_DIGEST、失败如实）全过 |

代价：有上限且修复多时，部分单元论断账本不再补齐（ABSENT 如实呈现，claim audit 既有 ABSENT 路径处理）；无上限（产品缺省）时零变化。队列 / 公平性 / timeout / cancel / HITL / EditContract 未改。

## E3 工作包 C：Finding 定位引用 — PASS

### 测量与分类
- 6.8%（约 34 条）来自 M16 首轮评测脚本 `scripts/m16-goal-closure/bc.mjs` 的 locatability：**finding 级**，且把「引文不能逐字找到」与「定位编号在 Markdown 中找不到」合并为 DANGLING——不是「表 / 公式不存在」的比例。产品早已把引文不可定位单列为 `QUOTE_NOT_LOCATED`。
- 产品旧检测（`verifiedFindings.danglingReferences`）在新留出集 520 条中报 22 条「原文不存在」，**全部是公式编号**；12 篇转写稿 0 个编号公式环境（显示公式都是无编号 `\[…\]`，PDF → MD 丢了编号），其中 12 条所引编号原文正文自己就提到过（如 p4cLtzk4oe 正文「Eq. 9」「Eq. 10」）。即旧检测在不可判定处断言「不存在」。

### 改动
- `backend/src/review/findingLocators.ts`（新）：复用被审原文与 `buildCertificateDocument` 的表格索引（不另起事实源），每个引用三态：
  - 表 / 图 / 公式：编号连续 → 原文提到 / 标注到第 N 个即 1..N 存在；`n ≤ max(抽取对象数, 原文最大提及编号)` → VALID；超出且该类对象有结构 → INVALID；该类对象一个都没抽到：作者源稿（AUTHOR_SOURCE）→ INVALID，否则 → UNVERIFIABLE；
  - 公式：多行环境逐行计编号上界、`\nonumber` / `\notag` / 星号环境不计、`\tag` 计入；分节编号（3.2）/ 子公式（2a）/ `\numberwithin` / `\setcounter` → UNVERIFIABLE；
  - 数字引文：`\bibitem` 数或原文出现过的编号（含区间）内 → VALID；有编号体系而超出 → INVALID；无 → UNVERIFIABLE；
  - `\ref` / `\eqref` / `\cref` …：`\label` 唯一存在 → VALID；重复 → UNVERIFIABLE（DUPLICATE_LABEL）；原文有 `\label` 体系而缺失 → INVALID；无任何 `\label` → UNVERIFIABLE；`\cite{key}`：键在 `\cite` / `\bibitem` / `@entry` 中 → VALID；有 `\cite` 体系而缺失 → INVALID；否则 UNVERIFIABLE；
  - 中文写法 `表 N` / `图 N` / `式(N)` / `公式(N)` 同口径。
- `verifiedFindings.ts`：`anchor.locator`（三态 + 逐项 reason）、`anchor.reliable`（引文定位且无 INVALID）；`danglingReferences` 只列 INVALID（旧字段语义收紧为「确定性可判不存在」）；summary 增 `unverifiableLocators`、`reliablyLocated`。finding 文本、严重度、证书判定**不变**——证书只依赖被引表格的唯一解析，无效编号本来就解析不到表（`NO_TABLE_REFERENCE` / 绑定失败），不可能借它出证书。
- Gate 详情、`VerifiedFindingsPanel`：INVALID →「定位不可信（意见保留、待核验，不作为准确锚点）」；UNVERIFIABLE 单列「无法在本输入中核对：未知，不代表不存在，也不代表已核实」；「可定位」计数改用可靠定位口径（旧产物回退旧字段）。

### 验证
| 证据 | 结果 |
|---|---|
| 预登记无效引用（作者源稿：Table 5 / Figure 3 / Eq. (9) / `\ref{tab:missing}` / `\cite{ghost2019}` / 表 7 / 图 4 / 式(12)） | 8/8 INVALID |
| 合法引用（Table 2 / Fig. 1 / Eq. (3) 在 align 行内 / `\ref{tab:main}` / `\eqref{eq:loss}` / `\cite{lee2021}`） | 0 误拒 |
| align + `\nonumber` + `equation*` | 上界 3：Eq. (3) VALID、Eq. (4) INVALID |
| 不可判输入（重复 label、3.2、2a、`\numberwithin`、转写稿无编号公式 / 无 figure / 无 label / 无 cite、非作者源稿零结构） | 全部 UNVERIFIABLE，从不 VALID / VERIFIED |
| 新留出集回放 | 旧 22 条 → 0 INVALID / 10 UNVERIFIABLE / 12 VALID；另 150 条 finding 引用全部 VALID；证书状态 520 条 0 变化 |
| API / UI | `VerifiedFindingsPanel.test.tsx` 新增用例：「定位不可信」、未知单列、可靠定位计数 |

边界：节号（Section 5）、附录编号（Table A1）、算法 / 定理编号未纳入（不判，不报）；转写稿上表格部分丢失且原文从不提及时仍可能误判 INVALID（要求该类对象至少抽到一个且编号超出全部提及，风险已压到最低，未见实例）。

## E4 工作包 D：数值证书的实际可用性 — PASS（无安全可新增能力，未实现）

现有能力：`TEXT_TABLE_VALUE`（正文数值 vs 唯一绑定单元格）、`TABLE_MULTIPLIER`（「N× / up to N×」vs 所引表格全部候选比）；来源门：转写 / 未核验来源最多 `CERTIFIED_ON_TRANSCRIPT`。

新留出集资格漏斗（当前代码路径重算，与历史产物一致）：

| 阶段 | 条数 | 掉出原因 |
|---|---|---|
| finding | 520 | |
| 实质类（fact / academic / evidence_gap） | 293 | style / citation / build 不做数值证书 |
| 引文逐字定位 | 251 | 42 条引文不能定位 |
| 引文含数字 | 106 | |
| finding 点名所引数字（双钥匙之一） | 101 | |
| 产生检查 | 12（19 项） | 89 条：整数 59（计数 / 规模）、年份 10、编号样小整数 16、小数 4（引文本身是表格行，不是正文论断） |
| 证书 | **0** | eligible_but_missing_input 8（`BINDING_UNBOUND:NO_CELL_MATCHES_METRIC_AND_ROW` 6、`NO_TABLE_REFERENCE` 2）；semantics_underdetermined 4（`QUALIFIER_INEQUALITY` 3、`QUALIFIER_AGGREGATE` 1）；eligible_and_certified 0 |

解释：0 证书不是实现异常——主因是 PDF 转写稿的表格 / 指标绑定不唯一（缺输入），其次是不等式 / 聚合措辞（语义欠定）。0 证书也**不能**读成「误报率为 0」：没有证书就没有可核对的证书。

历史 7 个可复算根因：2 个（9.4× 倍数、40.6 / 47.5 vs 41.0 / 47.9）由现有两类覆盖；5 个（「consistently」全称比较、派生准确率口径、符号字面量互换、缩写全称核对、普遍性论断反例）都需要模型给出比较对象集合 / 口径 / 符号语义——交给确定性检查器只会把模型的解释包装成「已证实」。

裁决：**不新增核验器**（任务书允许的「审计与未支持理由完整」出口）。理由：本集掉出项中没有一类同时满足「可确定性复算 + 负例可隔离 + 可证伪」；唯一看似可做的符号字面量互换在已知复核样本中只有 1 例（6Ire5JaobL），无法建立负例隔离证据，且需要先确定「正文哪个符号对应表中哪一列」——这一步本身是语义绑定。L1 FAIL 依据、转写来源门、近似数 / 跨表竞争 / 聚合措辞的 fail-closed 均未改。回归：`verifiedFindings.test.ts`（9.4× / 41.0 正例、0.036% 硬负例、转写来源、展平表头、舍入相容、可复现倍数、竞争表）全部通过。

## E5 工程回归 — PASS

| 项 | 结果（日志在证据目录） |
|---|---|
| backend 全量 `vitest run --maxWorkers=4` | **438 files / 4823 passed / 47 skipped，0 failed**（`backend-test-final2.log`；含新增 `reviewReliabilityClosure`、`findingLocators`、`outputParsingRepair`） |
| backend typecheck / build | exit 0 / exit 0 |
| frontend 全量 / build（tsc + vite） | 41 files / 385 passed；exit 0 |
| `git diff --check` | 干净 |
| Playwright（scripted 栈，隔离目录，结束后按 PID 停止） | `m15-quality-report.spec` 2/2 passed（分层质量报告 / 门禁 UI）；`smoke.spec` 1-3 **失败，既有**：断言的「论文项目」标题在 2026-10 工作台改版中已移除（spec 最后修改 10-03），与本轮改动无关，未修；其余 spec 依赖 latexmk / 专用开关，按设计 skip |
| Claude Browser Acceptance | 未执行：本轮 UI 改动仅为 VerifiedFindingsPanel 两行文案 + 计数口径，已由组件测试覆盖 |
| CI / Linux Integration | 见 E6 |

## E6 交付与版本 — PASS

| 项 | 结果 |
|---|---|
| 提交 | `6b2b37b` 代码 + 测试（A/B/C）；其后一个 docs-only 提交（本报告 + `scripts/m16-engineering-closure/` smoke runner）。直接在 main，推送前确认 origin/main 为祖先，无 force push、无额外分支 |
| CI | `CI`（run 41579486979）success；`Linux Integration`（run 41579486983）success——均在 `6b2b37b` |
| 证据 | `D:\PaperTeamData\M16\EngineeringReliabilityClosure\`：PROTOCOL.md（+sha256）、RUNLOG.md、ACCEPTANCE.json、replay-*.json、scratch/、测试与 Playwright 日志、smoke/（dry + live 产物、calls/）、budget/calls.jsonl（14 行）。受限论文 / 原始评审 / 日志未入 Git |
| 历史目录 | 只读：输入 MD 与历史产物仅被读取；无写入 |

## 真实 smoke

PROTOCOL 在首次真实调用前登记（sha256 `9d5f1a0a…68d53`）。篇目 M8OGl34Pmg（已开封，**只作工程回归**），条件与 M16 当时一致（同 runner 逻辑复制、fidelity 适配器、单次上限 21、whole-paper on、`zai-coding-cn/glm-5.3`）。

| 运行 | 调用 | 单元 | 论断修复 | JSON 修复 | 漂移单元 | 跨章 | 整稿 | coverage |
|---|---|---|---|---|---|---|---|---|
| M16 当时（`VerifiedFindingsHybridReview`，只读引用） | 21（耗尽） | 12，其中 9 个被解析成碎片（0 issue） | 9 | — | 12/12 | 被拒 | 被拒（failed） | 12/12（但 9 个单元 finding 静默丢失） |
| 本轮 dry（scripted，claims 全缺） | 21 | 12 | 7（预留跳过 5） | 0 | 0 | completed | **completed** | 12/12 |
| 本轮 live | 14 | 12 | 0 | 0 | 0 | completed | **completed**（FULL_TEXT，8 条） | 12/12 |

判读（预先登记）：live n=1 没有出现漂移，不能归因于指令补齐——修复的证据是零模型回放与注入测试；smoke 证明真实链路下 coverage / callAccounting / 两条新 Gate 规则如实、整稿未被挤占。`run-result.backendDirty=true`：运行时本轮改动尚未提交（运行的就是本报告的代码）。真实调用 14/24，完整生产 review 1/1。

## 回滚开关
- `PAPERTEAM_REVIEW_STAGE_CALL_RESERVE=off`：B 的调用预留回到先到先得。
- `PAPERTEAM_REVIEW_WHOLE_PAPER=off`：整稿通道关闭（既有）。
- A 的解析修复与 C 的三态无开关：它们只把「静默丢失 / 错误断言」改为「如实失败 / 未知」，回滚等于恢复已知缺陷；如需回退，revert 对应提交。

## 仍未解决 / 范围外（Product Backlog，不自动开启）
- 模型输出语言仍有随机性：指令补齐后能否显著降低漂移只能由新的真实运行统计（本轮 smoke n=1 不足以判断）；漂移现已可见且不再放大调用。
- 不可修复的结构错误（缺开引号、单引号键）仍会让单元重试花调用。
- PDF 公式结构 / 复杂表格抽取（决定 C 的 UNVERIFIABLE 比例与 D 的缺输入比例）、期刊 profile 数量、中文期刊独立质量标签（L4）——均为范围外，未改。
- 本轮不意味着学术 Reviewer 优于全文 LLM、严重度已校准或中文目标期刊 L4 达标。
