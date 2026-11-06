# M17.2 实验数据导入、语义理解与证据约束的论文写作闭环

> 公开版说明：本仓库公开，作者的 MOT 实验结果尚未发表。本报告去除了具体实验数值、方法名与数据集名（以〈值〉/ 主方法 M / 基线 / 消融 A / 数据集 D 代替）；完整版（含逐值溯源）保存在 `D:\PaperTeamData\M17_2\M17_2_REPORT_FULL_PRIVATE.md`。文件 sha256 只标识文件，不泄露内容。

## 收口更新（2026-11-07）：公开历史清理 + 修复后真实模型运行

本节是 M17.2 的现行判定；下文「最终判定」及以后各节为 2026-11-05 初版记录，保留原文。仍按公开版口径去除具体数值、方法名、数据集名与稿件原文。

**隐私历史清理。** 初版提交（含其测试夹具、注释与一条提交说明）混入了作者未发表实验的数值与标识；后续的去敏提交只清理了一部分。
本次用 `git-filter-repo --sensitive-data-removal` 定向改写 M17.2 范围内 3 个提交（只替换受影响文件的历史版本与那条提交说明，夹具换成重新选取、算术自洽的独立合成值，
去敏提交因此变为空提交被剪除），受控推送 main（`--force-with-lease` 带精确旧 SHA，tag 未动）。改写后全部可达历史对私有匹配清单零命中；
HEAD tree 的差异只有注释、测试夹具与本报告中的提交号，生产逻辑不变；新 HEAD 的 CI 与 Linux Integration 均通过。
回显旧提交说明的 2 个 Actions 运行日志与 3 个构建记录 artifact 已删除。**残留**：旧提交按完整 SHA 在 GitHub 网页 / API 上仍可访问，
需仓库所有者向 GitHub Support 申请清除（尚未提交）；第三方已有的 clone / 缓存无法控制。本仓库无 fork、无 PR。
防回归约定不变：公开仓库的夹具、注释、提交说明一律用独立合成值，绝不从真实数据抄数或保留真实效应量（哪怕标注 SYNTHETIC）；不把真实值写成版本化黑名单。

**修复后真实运行**（预登记协议 v2，付费调用前冻结；同一真实数据、同一模型 `zai-coding-cn/glm-5.3`，全局上限 30 次，本轮唯一一次 idea_to_paper；新增研究代理）：
- 导入→冻结在真实浏览器 UI 中重做，快照内容哈希与初版逐字一致（跨栈、跨日重建）。
- 运行用满 30/30 次调用（约 27 分钟），停在 `hitl.revision_stalled`（修订已收敛、质量门禁未过）。该停点未预登记，按协议停止且**未自动接受草稿**；
  经作者明确批准后执行 `accept_draft`（零模型调用），产品构建门禁通过，生成 **5 页 Draft PDF**（xelatex+bibtex，0 诊断、0 未解析引用）。Draft，非 Final。
- Writer：稿件全部 58 个数字逐条对账；**45 个实验定量值 45 正确 / 0 错误 / 0 不可判断**（正文 30 + 结果表 15，含 pp / 相对 % 区分与两条聚合断言的复算），
  其余 13 个为结构性数字。结果表 `\label` 存在、正文引用可解析，无未检验的「显著」表述。修订前后稿件数值集合完全相同。
- 原 3 个缺陷：结果表悬空引用（D1）未复发；作者数据披露截断（D3）未复发（实验结论均按作者实验数据披露处理，门禁不再记为 opaque）；
  无指标名的相对变化误归属（D2）原形态未复发。
- 新发现：
  - **D4**（已修，零模型重放验证）：「X、Y 与 Z 分别为 +a、+b 个百分点」并列句中，核查器把数字按位置归到最后一个指标，产生 1 条 major 误报
    （detail 还把计数差写成 pp）。修为枚举片段内核对、不一致记 unbound；新增回归用例（修复前失败、修复后通过）；用修复后代码重放真实稿件：16/16 一致、0 finding。
  - **D5**（未修）：修订阶段新写入了一个与作者给定值不符的方法参数；修订事实保全只保护已有数值，未拦截新增错误值。
  - **D6**（未修）：方法节对一个方法组件的描述与作者说明相反（大纲起即误读）；审稿与守卫均未发现 D5 / D6。
  - LLM 事实审稿仍对作者实验数据报 critical「无已核验证据」，已被门禁按归因规则排除（不计入 open critical）。
  - 门禁未过的其余原因为 3 条学术 major（方法细节不足以复现、只消融一个超参、单次运行无统计检验）与一项 NOT_EVALUATED 的文献类断言；去掉 D4 误报仍不过。

| 判定 | 结果 |
|---|---|
| PRIVACY_HISTORY_REWRITE | **PASS** |
| PUBLIC_RESIDUAL_EXPOSURE | **REMAINS**（旧 SHA 直链待 GitHub Support；已检查：可达历史、匿名 clone、Actions 日志 / artifact、PR / fork、events API） |
| DATA_INTEGRITY | **PASS** |
| WRITING_CONSUMPTION | **PARTIAL**（快照数据消费 45/45 正确、表与引用正确；但真实运行中出现 D4 误报，且 D5 错误作者参数未被拦截） |
| REAL_MODEL_E2E | **PARTIAL**（真实产品路径到 PDF 已打通，经作者合法决定；质量门禁 FAIL，D4 只经重放验证，D5 / D6 未修） |
| PDF_GENERATION | **PASS**（本轮真实模型运行经产品构建生成 Draft PDF） |
| M17_2_COMPLETE | **NO** |

唯一最小后续动作：给 Writer / Revision 加确定性的「新增数字来源守卫」（新出现的数字必须能追溯到冻结快照、作者研究输入 / metadata 或已核验引用，否则拒绝落盘或标记），
随后用同一协议再做一次 ≤30 次的真实运行验证。D6 这类方法描述保真问题需作者在 Draft 上人工核对，本轮不自动处理。M17.3 应在此之后进入。

## 最终判定（初版，2026-11-05）

**一句话**：真实实验文件经产品 UI 上传、作者补 metadata / 确认、冻结为可追溯的实验事实快照，这一段在真实 MOT 数据上可靠；真实模型（`zai-coding-cn/glm-5.3`，30 次上限内）写出的结果与讨论，其每个实验数字都与冻结快照一致，审稿逐条核到源单元格。但同一次真实运行暴露了 3 个由本轮代码引入的缺陷，导致结果表没有附上、构建因悬空引用失败、质量门禁把正确结论记为“无支撑”。三者均已修复，并有回归测试与零模型确定性重放证据，但修复后没有再跑一次真实模型。因此写作消费判定为 PARTIAL，本轮不是 COMPLETE。

| 维度 | 判定 |
|---|---|
| M17_2_DATA_INTEGRITY | **PASS**（真实 数据集 D TrackEval 文件；协议 §3 五项全部满足，见 §5 / §8） |
| M17_2_WRITING_CONSUMPTION | **PARTIAL**（真实路径：Writer 正确消费 ✓、Reviewer 逐条复核 ✓（1 条误报）、结果表 ✗、PDF ✗（PDF_NOT_GENERATED，并停在 AUTHOR_DECISION_REQUIRED）；修复后仅有零模型重放证据） |
| M17_2_COMPLETE | **NO** |

与 M17.1 的关系：M17.1 风格审查按产品默认（on）在真实运行中执行（第 1 轮覆盖 7/7 单元，2 条「必要限定」判 KEEP；第 2 轮因预算耗尽 PARTIAL 并如实记 SKIPPED_BUDGET）。本轮没有开展 M17.1B 独立风格 A/B，没有使用其 60 次预算，没有改其冻结候选与协议；M17_1_REAL_PAPER_EFFECT 仍未验收。

## 1. Git 与环境

- 仓库 `D:\Projects\PaperTeam`，分支 main。初始：`git fetch` 后 HEAD = origin/main = `1645ad74db10486929843ffb802084f32feebae8`，工作区干净（与用户报告一致）。
- 提交：`342dc69` feat（主体实现 + 测试）→ `a63f942` fix（真实运行暴露的缺陷）→ 本报告与文档提交（见 §9 最终 SHA）。
- 真实数据与证据：`D:\PaperTeamData\M17_2\`——`PROTOCOL.md`（付费调用前冻结；§5.1 运行配置、§5.2 协议偏差）、`real_inputs\`（只读副本 + `SHA256SUMS.txt`）、`upload\trackeval_outputs.zip`（sha256 `d390f18847dfb6e8…`）、`runs\`（UI 截图 / trace / 快照 / 负例 / 重放 / 真实运行记录）、`live-stack\`（真实运行项目与账本）、`scripts\`、`baseline\`（全部测试日志）。公共仓库只含合成夹具。

## 2. 审计结论与复用

实施前现状矩阵（逐项 path:line 与测试）见附录 A。要点：

- **直接复用**（已生产接通）：ZIP 实验包上传与安全校验、哈希幂等；CSV / XLSX / JSON / YAML / 空白对齐 TXT 解析器；观测级范围确认与工作流授权；`workflowContext` 注入 Researcher / Outline / Writer / Revision；Reviewer 作者数据披露；预登记 claimChecks；`review/derivedFormula.ts` 区间算术；Figure pipeline；EditContract 写入守卫；全局预算账本；LatexCompiler 严格构建门禁。
- **本轮补齐**（在既有模块上最小增量，没有新建 Store / Engine / Runtime / 评分系统）：见 §4。
- **审计发现、本轮不做**：`idea_to_paper` 实际上没有「缺实验即暂停」HITL（只有 prompt 纪律），任务书以为有；长表（metric,value）不自动转置；CSV 小数逗号只告警。

## 3. 输入支持矩阵

| 输入 | 状态 | 说明 |
|---|---|---|
| ZIP（含 CSV / XLSX / JSON / YAML / TXT） | SUPPORTED | 既有链路 |
| 单个 / 多个 CSV·XLSX·JSON·TXT·YAML 直接上传 | SUPPORTED（新） | 浏览器端确定性 store ZIP（`frontend/src/api/storeZip.ts`），复用同一上传端点；同名路径拒绝；真实运行用两份 JSON 验证 |
| XLSX 多 sheet | SUPPORTED | sheet + 行 + 列字母定位 |
| XLSX 百分比数值格式 | SUPPORTED（新） | 0.669 → 单位 ratio（依据 xlsx_percent_format） |
| XLSX 公式 | PARTIAL | 取缓存值；无缓存值显式标注 + note，不执行不猜（新） |
| XLSX 合并单元格 | PARTIAL（新） | 从格标 mergedFrom，不作独立事实 |
| XLSX 宏 / 外部链接 | UNSUPPORTED（安全） | 从不执行 |
| CSV 分隔符 / 引号换行 / UTF-8 中文列名 | SUPPORTED | 既有 |
| CSV 小数逗号 | PARTIAL（新） | 告警不解析 |
| JSON 嵌套路径 | SUPPORTED | `$.a.b[0]` |
| JSON 重复键 | PARTIAL（新） | 后者覆盖 + 显式 note |
| JSON 中「方法在路径里」的汇总（如 `$.arms.base.pooled.HOTA`） | PARTIAL | 文件级 metadata 无法逐臂区分方法 → 缺身份，只可原样引用、不参与对比（真实 数据集 D′ 汇总即此情形） |
| TrackEval summary.txt / detailed.csv | SUPPORTED | 角色需作者指定；seq 列 = 子集；HOTA___AUC ≡ HOTA |
| 宽表 / 长表 | PARTIAL | 宽表完整；长表需作者整理 |
| 多 seed / 多 run | SUPPORTED（新，合成验证） | 不同 seed 不冲突；系统复算均值 / 样本标准差；与汇总不符 → 冲突 |
| 版本 | SUPPORTED（新，合成验证） | 同键不同版本不同值 → VERSION_CONFLICT |

## 4. 数据 schema、映射、作者确认与快照策略

**观测**（扩展既有 `MetricObservation`，字段全部可选，manifest schema 不升版本）：`unit`（percentage / ratio / count / fps / seconds / milliseconds / unknown）、`unitBasis`（cell_suffix / header / xlsx_percent_format / metric_vocabulary / author_metadata / none）、`rawText`、`subset`、`version`、`authorFilled`。与任务书逻辑字段的对应：datasetId→dataset、datasetSplit→split、methodId→method、baselineOrAblation→组角色、metricId→metricKey、evaluationProtocol→protocol、runId/seed、version、sourceLocator（`sha256:<fileHash> · 路径 · sheet · row · col / json path`）、fileHash、transformLineage（对比的 formula + operandRefs）、verificationStatus（快照只收 `author_confirmed`）、authorConfirmation（scopeId + confirmedAt）。

**单位只认显式证据**（`backend/src/experiments/metricUnits.ts:55` `headerUnit`、`:82` `parseMetricCell`），不按数量级猜；作者在文件 metadata 声明（`*` 只填补未声明指标，逐指标声明与显式单位矛盾 → 冲突）。

**作者确认点**（只有歧义才需作者）：①文件角色 / 组；②文件 metadata（`ExperimentPackageService.editFileMetadata`，只填补缺失，矛盾 → 组冲突）；③「用于本文写作」（确认 + 授权）；④冲突裁决：排除任一方（append-only `experiments/snapshots/decisions.json`）；⑤冻结。无歧义数据不需逐格确认——真实运行中作者操作为：2 次上传、6 次改角色、6 次填 metadata、1 次「用于本文写作」、1 次冻结。

**快照**（`backend/src/experiments/factSnapshot.ts`）：`buildFactSnapshotContent`（`:420`）→ `findConflicts`（`:231`；SAME_KEY_DIFFERENT_VALUE / VERSION_CONFLICT / UNIT_SCALE_UNRESOLVED / AGGREGATE_VS_RUN_MISMATCH，未裁决禁止冻结）+ `buildComparisons`（`:350`，两轮：先整体结果后逐子集；上限 2000 截断时显式 limitation）/ `compareFacts`（`:315`）。冻结文件 `efs-NNNN.json` 不可变、读取校验 contentHash；`activeSnapshotState` 每次读取校验事实仍在已确认 + 已授权范围且源哈希 / 值 / 单位 / metadata 未变，否则 stale（失效期间写作上下文为空，不回落实时数据）。

**派生对比**：只在同数据集 / 划分 / 协议 / 子集 / 指标 / 已知同量纲单位 / 同方向时生成；`percentage_point_difference`（pp）与 `relative_change_percent` 分开，均为 derivedFormula AST + 源文本显示精度区间；分母 0 / 区间含 0 → 相对变化不可算；参照为负 / 近 0 → limitation；方向未知只报差值；区间跨 0 → tie_within_rounding；`statisticalTests` 恒空。

**消费**：
- 单点切换 `eligibleWorkflowCandidates`——有快照时 workflowContext 只读快照（≤100 条观测 + ≤60 条确定性对比，主指标 / 方向已知优先、消融配额 ≥16）；无快照与 M17.1 逐字一致（测试锁定）。
- Writer：`writer/WriterService.ts` `renderSnapshotContextLines`（对比表 + pp/% / 跨协议 / 显著性纪律）。
- 结果表：`experiments/resultsTable.ts`（`renderSnapshotResultsTable` + `appendResultsTable`），写作阶段结果节末尾确定性追加，与初稿同一修订；列优先取正文提及的指标、原始指标名、单数据集列并入题注、最多 5 列。
- Reviewer：`review/experimentFactAudit.ts` `auditExperimentFacts`（pp↔% 混淆 / 幅度不在快照 / 无对比给幅度 / 无检验显著性 / 快照失效），finding 带 `experimentFact`（快照 id、对比 id、操作数定位），账本 `reviews/experiment-fact-audit-r{round}.json`；无法归属指标的幅度记 unbound 不出 finding（宁漏不误）。
- 审稿作者数据披露：有效快照时 = 快照整体事实 + 确定性差值（`snapshotDisclosureValues`）。
- 门禁：thesis「附实验包后继续」需有效非空快照。

## 5. 真实数据溯源链实例（C1，HOTA）

| 环节 | 内容 |
|---|---|
| 源文件 | `<主方法臂>/pedestrian_summary.txt` sha256 `602a9d23acab6b70…`；`<基线臂>/pedestrian_summary.txt` sha256 `b2d7f741abf890d8…`（TrackEval 原生输出，作者私有研究） |
| 单元格 | 两文件第 2 行 HOTA 列：`〈值〉`、`〈值〉`（单位 percentage，依据 author_metadata `*=percentage`） |
| 事实 | 快照 `efs-0001`（内容哈希 `ae565d204f6d…`，20742 条事实；干跑栈与真实栈独立构建，哈希逐字节一致） |
| 确定性计算 | `cmp-fae1a9bcfc99`：`percentage_point_difference([f-62dab2ed…],[f-ea8a27a…])` = +〈值〉 pp，区间 [〈值〉]；相对 +〈值〉%；outcome subject_better；limitation「单次确定性结果，来源无统计检验」 |
| Writer 输出 | 真实运行 `sections/experiments.tex` 第 5 行「HOTA 提高 〈值〉 个百分点」；同句 IDF1 +〈值〉 pp（〈值〉 对 〈值〉）、AssA +〈值〉 pp、IDSW 〈值〉→〈值〉（相对减少 〈值〉%） |
| Reviewer 复核 | `reviews/experiment-fact-audit-r1.json`：该主张 CONSISTENT → `cmp-fae1a9bcfc99`，操作数定位为上面两个单元格 |
| 交叉印证 | 同一结果在 `pedestrian_detailed.csv` COMBINED 行为 `〈值〉`（小数标度）：作者声明 `*=ratio` 后与 summary 判为同值；不声明时报 UNIT_SCALE_UNRESOLVED（§8 N2） |

## 6. 产品上传与处理过程记录

| 步骤 | 方式 | 证据 |
|---|---|---|
| 创建沙箱项目 | 生产 HTTP API | `runs/live-ui/trace.json` |
| 多文件上传两份作者汇总 JSON；ZIP 上传 TrackEval 原生输出 | **真实 UI**（Playwright 驱动 Chrome → Vite → 后端） | 截图 `runs/live-ui/02-*.png`、`03-*.png` |
| 改 6 个文件角色 / 组；填 6 份 metadata；「用于本文写作」；查看快照预览；冻结 | **真实 UI** | 截图 `04`–`07`；`snapshot-preview.json`、`active-snapshot.json`、`workflow-context.json` |
| 启动 idea_to_paper、按预登记作者决定处理 HITL | 生产 HTTP API（`scripts/drive_run.mjs`） | `runs/live-run.log`、`runs/live-run/run-final.json` |
| 研究 / 可行性 / 大纲 / 写作 / 引用核验 / 审稿 ×2 / 修订 / 构建 | **真实模型**（产品 Pi 运行时） | `live-stack/projects/p-5fc087673168/`、`live-stack/ledger.json` |
| 负例与 PDF 重放 | 零模型：生产 HTTP（脚本化运行时栈）+ 生产 dist 函数 | `runs/negatives/negatives.json`、`runs/replay/` |

分层说明：unit / integration（vitest，合成夹具）；Playwright（脚本化运行时，合成数据）；真实数据 UI + HTTP（零模型）；真实模型运行（1 次，30 次调用）；确定性重放（零模型，真实稿件）。

真实运行时间线：w-798cbcde74df，09:51:35 启动 → research.idea（1 次调用；文献检索在直连网络下 arXiv 超时、OpenAlex / S2 限流，未配置研究代理，按协议不中途改配置）→ evidence.ground → feasibility（LOW：单数据集）→ 大纲 6 节 → 写作 6 节（消费 efs-0001，60 条对比）→ 引用核验（8 引用、0 编造、2 无法核验）→ 审稿 r1 → 修订（5 项通过 EditContract 校验、0 拒）→ 审稿 r2（第 30 次调用后 1 次风格单元调用被账本拒绝）→ 质量门禁未过 → 停在 `hitl.revision_overflow`。按 PROTOCOL §5.2 追加 accept_draft → build.draft 失败（悬空引用）→ 10:13:35 结束。

## 7. 论文产物

- **真实运行：PDF_NOT_GENERATED**。build.draft 被 LatexCompiler 严格门禁拒绝（`Reference 'tab:exp-efs-0001' undefined`）。根因是缺陷 D1（§8.2）：Writer 写了 `Table~\ref{tab:exp-efs-0001}`，本轮的「已存在」判断按 label 子串匹配，于是跳过附表，同时还记了 `inserted: true`。另外运行在此之前已停在 **AUTHOR_DECISION_REQUIRED**（revision_overflow）。xelatex 的副产物 `build/main.pdf` 不是被接受的 Draft。
- **合法中间产物**：真实运行最终稿件 `live-stack/projects/p-5fc087673168/manuscript/`（修订 3，6 节）。
- **确定性重放（零模型，修复后代码）**：同一份真实稿件 + efs-0001，用生产 `appendResultsTable` / `renderSnapshotResultsTable` 补表，再用生产 `LatexCompiler` 编译 → `runs/replay/build/paper.pdf`（6 页，sha256 `6fa90007156dd474…`，xelatex+bibtex 5.9 s）。表 1 列为 HOTA / AssA / IDF1 / IDSW / DetA，三行 基线 / 主方法 M / 消融 A（消融），15 个数值逐一等于 TrackEval summary.txt；题注写明快照 id、内容哈希、单次运行、无统计检验。这是重放，不是产品工作流产物。
- 数字核对（`runs/final_number_scan.json`）：真实最终稿 33 个数字中，30 个等于快照事实或确定性差值；3 个是作者在研究想法中给出的方法超参数（不是实验结果）。全文没有「显著」/ p 值表述（核查 0 条 EXP_UNTESTED_SIGNIFICANCE）。

## 8. 负例与缺陷

### 8.1 预登记负例（真实 数据集 D 文件，零模型，最终代码复跑）

| 负例 | 结果 |
|---|---|
| N1 跨数据集（真实 数据集 D′ 汇总） | 0 条跨数据集对比；897 条事实因缺方法标识列入 limitation；作者撤回授权后不进快照 |
| N2 标度（真实 summary vs detailed） | 不声明单位：72 处 UNIT_SCALE_UNRESOLVED（双方 sha256 定位），冻结 409；声明 `*=percentage` / `*=ratio` 后 0 冲突 |
| N3 无检验显著性 | 「显著优于 base（p < 0.05）」→ EXP_UNTESTED_SIGNIFICANCE |
| N4 版本冲突（合成：基线 HOTA 改为 〈值〉，文件名标 SYNTHETIC） | SAME_KEY_DIFFERENT_VALUE，冻结 409；作者排除后可冻结，排除记录保留 |
| N5a pp 写成 % | 「提升了 〈值〉%」（把百分点差写成 %）→ EXP_PP_PERCENT_CONFUSION，绑定 `cmp-fae1a9bcfc99`（〈值〉 pp，相对应为 〈值〉%） |
| N5b 幅度不在快照 | 「提高 5.2 个百分点」→ EXP_DELTA_NOT_IN_SNAPSHOT |
| 对照 C1 / C3 | 「提高 〈值〉 个百分点（相对 〈值〉%）」2 条一致；消融「仅相差 〈值〉 个百分点」一致 |

合成夹具覆盖（`backend/test/experiments/m172FactSnapshot.test.ts`、`m172SnapshotHttp.test.ts`、`backend/test/ingestion/m172ParserFidelity.test.ts`；每类都有放行对照）：0.669 / 66.9% / 0,669、FPS vs s/frame（量纲不同不配对）、越低越好、协议缺失、多 seed（不冲突 / 均值 / 汇总不符）、版本冲突、作者排除、合并单元格、无缓存公式、百分比格式、JSON 重复键、源变化 / 授权撤回 → stale、重传幂等、冻结版本不被改写、thesis 门禁、无快照兼容。

### 8.2 真实模型运行暴露、本轮已修复的缺陷（`a63f942`）

| # | 缺陷 | 真实影响 | 修复与证据 |
|---|---|---|---|
| D1 | 结果表「已存在」按 label 子串判断，正文 `\ref` 命中就跳过 | 稿件悬空引用 → 构建失败；阶段记录误写 inserted=true | 只认同名 `\label`；inserted 以实际追加为准；回归用例 + 重放 PDF |
| D2 | 核查器在数字前无指标名时退化归属（把 IDSW「相对减少 x%」归到同句后文的 AssA） | 1 条 major 误报（r1、r2 各 1）；修订后引言该句保持原样，没有被改坏 | 未归属 → 与全部对比核对，不一致记 unbound 不出 finding；两方法点名时双方都要匹配；回归用例；重放 14/14 一致、0 finding |
| D3 | 审稿作者数据披露仍用 100 条写作上下文 | 5 条与快照完全一致的实验结论被记为 opaque UNSUPPORTED，质量门禁失败 | 有效快照时披露 = 快照整体事实 + 确定性差值；真实稿件重放：旧口径 0/5、新口径 5/5 覆盖（`runs/disclosure_replay.json`） |

另外，干跑中由真实数据暴露并修复（`342dc69`）的问题：HOTA___AUC 方向未知；逐阈值列挤占写作对比；summary / detailed 重复对比保留了长小数版本；对比上限挤掉后排指标的整体结果；`*` 单位与显式单位误报冲突；metadata 64 字符上限过紧、错误提示不清。

## 9. 测试、模型调用、CI 与限制

- **后端全量**：最终运行 `baseline/backend_tests_m172_final2.log`：447 文件通过 / 4933 通过 / 47 跳过 / **1 失败**（`orchestratorHardening` 的「stage 超时按无进展时长计」，计时类；本轮没有改 orchestrator，单独连跑 3 次 5/5 通过）。此前完整一轮 `round2` 为 448 文件 / 4931 通过 / 0 失败。基线 1645ad7 当时也有 1 个计时偶发失败（`rateLimitRecoveryLoop`，单独运行通过）。每轮全量都会出现 0–2 个不同的计时类偶发失败（均为 5 s 超时，单独运行通过），本报告不把它们写成全绿。
- **新增后端测试**：30 个（M17.2 三个文件）。**前端**：44 文件 / 396 通过（新增 4 个）；`tsc` 前后端均通过；`vite build` 通过。
- **Playwright**（脚本化运行时栈）：新增 `e2e/tests/m172-experiment-snapshot.spec.ts` 通过；与既有 m135 / m136 / experiment-real 一起：6 通过、6 跳过（依赖真实 ZIP / 旧项目根的环境门控用例）。
- `git diff --check` 通过。
- **真实模型**：1 次运行，账本 30/30 次（协议上限 30；另有 1 次被账本拒绝）；输入 307,610 tokens、输出 24,270、缓存读 1,288,128；账本估算费用 0.872（按 Pi 模型价格表计）；耗时 22 分钟。与 M17.1B 的 60 次账本完全独立。
- **CI**：`342dc69` CI success、Linux Integration success；`a63f942` 与文档提交见本节末（收口时核对）。
- **性能 / 资源**：真实 TrackEval 包产生 20742 条事实，快照文件约 30 MB；workflow-context 读取约 0.4 s；对比上限 2000（已显式标注截断）。

- CI 收口记录：`a63f942` 与文档提交的 CI / Linux Integration 状态在推送后核对，见下行。

## 10. 用户操作说明与下一步

操作说明已写入 `docs/product-guide.md` §2.1，接口写入 `docs/API_CONTRACT.md`「M17.2 additions」。简要步骤：实验数据包页上传（ZIP 或直接多选结果文件）→ 文件清单核对角色、补 metadata（方法 / 数据集 / 协议 / 单位）→「用于本文写作」→ 快照区处理冲突、查看确定性对比与溯源 → 冻结 → 运行论文工作流（Writer 只用快照数值与对比，结果节自动附表，审稿核对幅度与显著性）。源或授权变化后快照显示「已失效」，需重新冻结。

下一步（P1）：
1. **用修复后的代码重跑一次有界真实模型运行**（同协议、≤30 次，并配置研究代理），以产品路径得到 Draft PDF。这是把 WRITING_CONSUMPTION 从 PARTIAL 提升到 PASS 的唯一缺口。
2. `idea_to_paper` 增加真正的「缺实验数据」HITL 门禁（现在只有 prompt 纪律），只承认当前项目的有效快照。
3. 审稿作者数据披露仍是按数值匹配（既有语义）：改为指标感知，与 experimentFactAudit 对齐。
4. 快照存储压缩 / 允许作者把逐序列子集只作溯源不进快照（30 MB 级别）。
5. JSON 汇总「方法在路径里」的逐臂 metadata 映射（作者选择路径段 → 方法，不自动猜）；长表转置。
6. 「身份切换次数」等中文指标别名表（当前保守地不归属）。
7. 前端无 favicon 导致浏览器 404 噪声（既有，与本轮无关）。


## 附录 A 实施前审计与计划（2026-11-05，基线 1645ad7；按任务书要求在改代码前写入，原文保留）

### A.1 Git 现场核实
`D:\Projects\PaperTeam`，分支 main；`git fetch origin` 后 HEAD = origin/main = `1645ad74db10486929843ffb802084f32feebae8`，工作区干净（与用户报告一致）。

### A.2 现状矩阵（只读审计；path:line 均为 1645ad7 源码）

状态口径：PRODUCTION_CONNECTED = 真实 UI/HTTP → 服务 → 下游消费已接通且有历史真实运行；IMPLEMENTED_NOT_WIRED = 源码存在但无产品入口；PARTIAL = 部分满足；MISSING = 不存在。

| 能力 | 状态 | 证据 | 测试 |
|---|---|---|---|
| 实验包上传（ZIP，流式限额、安全校验、哈希幂等） | PRODUCTION_CONNECTED | `backend/src/httpServer.ts:1278-1365`；`experiments/ExperimentPackageService.ts:809` `importZip`；`experiments/archive.ts:8` `PACKAGE_LIMITS` | `test/experiments/archiveLimits.test.ts`、`experimentUpload.proxy.http.test.ts`；e2e `experiment-real.spec.ts`（M13.3 真实 ZIP） |
| 单文件 / 多文件 CSV·XLSX·JSON 直接上传为实验数据 | MISSING | 上传强制 `application/zip`（`httpServer.ts:1281`）；前端 `accept=".zip"`（`ExperimentPackagesPanel.tsx:214`）；Sources 页 `accept` 不含 xlsx/json（`SourcesPanel.tsx:443`）而 Figures 空态提示上传 XLSX/JSON（`FiguresPanel.tsx:232`），提示与能力不一致 | — |
| CSV 解析（分隔符嗅探、RFC4180 引号换行、UTF-8） | PRODUCTION_CONNECTED（无小数逗号 locale） | `ingestion/csvTabular.ts:124` `sniffDelimiter`、`:157` | `test/ingestion/csvTabular.test.ts` |
| XLSX 多 sheet、公式缓存值 | PARTIAL | `ingestion/xlsxTabular.ts:86-140`；公式取 `result`（`:173-175`），**无缓存值的公式静默变空**；**百分比 numFmt 被忽略**；合并单元格未标注 | `test/ingestion/xlsxTabular.test.ts:32`（无合并 / 百分比格式用例） |
| JSON 路径投影 | PARTIAL | `ingestion/structuredProjection.ts:59-139`（`$.a.b[0]`）；**重复键静默后者覆盖** | `test/ingestion/jsonYamlStructured.test.ts` |
| TrackEval 空白对齐表（summary.txt） | PRODUCTION_CONNECTED | `ingestion/textAsset.ts:341` `whitespaceTable`；但 `.txt` 默认归类为 documentation（`ExperimentPackageService.ts:218`），需作者改角色 | M13.3 真实材料 |
| 指标观测（sourceId/blockId/行/列/JSON path） | PRODUCTION_CONNECTED | `ExperimentPackageService.ts:341` `metricObservations` | `experimentPackages*.test.ts` |
| 单位 / 百分比 | MISSING（类型占位） | `unit` 恒为 `"unknown"`（`:368`、`:398`）；`"percentage"` 从未赋值；`"66.9%"` 文本不匹配数值正则被**静默丢弃**（`:353`） | — |
| 指标方向 | PARTIAL | MOT 词表 `METRIC_DIRECTION`（`:180-188`），其余 unknown（不猜） | — |
| 标度混用告警 | PARTIAL | `pushScaleConflictWarnings`（`:303`）仅同组同范围告警，不阻断 | `experimentPackagesM133.test.ts` |
| 单文件观测上限 | PARTIAL | 5000 条后**静默截断**（`:353`），TrackEval detailed.csv（25 行 × 270+ 列）即超限 | — |
| 作者确认 / 范围授权 / use-for-paper | PRODUCTION_CONNECTED | `confirm` `:1172`、`setScopeWorkflowUse` `:1230`、`applyWorkflowUse` `:1037`；前端 `UseForPaperSection`、`ScopesSection` | `experimentSplitScopes.test.ts`；e2e `m135/m136-experiments.spec.ts` |
| 作者补充 metadata（方法/数据集/划分/协议/单位） | MISSING | 只能改文件角色与组（`editFile` `:923`） | — |
| 跨文件同键不同值 / 版本冲突 / 协议不可比 / 汇总 vs run | PARTIAL | 仅 config 字段与结果行逐值比较（`rebuild` `:900-918`）与同范围 protocol 矛盾（`buildSplitScopes`）；**无同键不同值、无版本冲突、无汇总 vs run 检查** | — |
| 冻结版本化实验事实快照 / 源变化失效 | MISSING | `workflowContext`（`:1412`）每次实时计算，无版本、无快照 id、无失效提示 | — |
| 确定性派生对比（pp / 相对 % / 倍数） | IMPLEMENTED_NOT_WIRED（对实验包） | `review/derivedFormula.ts`（区间算术，`percentage_point_difference` / `relative_change_percent`）仅用于稿内论断证书 `review/claimCertificate.ts`；实验观测没有派生对比，Writer 只拿到原始值、自行心算提升 | `test/review/derivedFormula*.test.ts` |
| Writer 消费实验观测 | PRODUCTION_CONNECTED（仅 prompt 纪律） | `writer/WriterService.ts:2074` `renderExperimentContextLines`；注入 research.idea（`workflow/definitions.ts:7363`）、outline（`:7811`）、writing.sections（`:8294`）、revision（`:3382`） | `experimentAgentPolicy.test.ts:54-150` |
| 写作阶段确定性数字守卫 | MISSING | 初稿免于 `factPreservation`（`quality/factPreservation.ts:2441`）；无 p 值守卫 | — |
| Reviewer 数值核验 | PARTIAL | 预登记 claimChecks 在 review.run 产出确定性 finding（`definitions.ts:873-880`、`:1727`）；不检查 pp/%、方向、基线（`claimChecks.ts:668`，`claim.unit` 未使用）；`computeClaimGroundingReport` 按值匹配作者数据（`review/claimGrounding.ts:98-123`），不看指标/单位/范围 | `claimChecks.test.ts`、`authorExperimentDataClaims.test.ts` |
| 显著性措辞升级守卫 | PARTIAL | 修订时 `checkClaimStrengthEscalation`（`quality/claimStrength.ts:184`）、`countSignificanceAssertions`（`factPreservation.ts:1400`）；初稿不检查 | `claimStrength.test.ts` |
| 图表（来源 datasetHash 绑定、只用已确认实验来源） | PRODUCTION_CONNECTED（作者手动） | `figures/FigureService.ts:181-224`（`isConfirmedSource`）、`:297` `assertOriginFaithful`；`figures/truthfulness.ts:225` caption 数值核对 | `figures/truthfulness.test.ts`；e2e `experiment-real.spec.ts` 生成 PDF |
| 由实验事实确定性生成结果表 | MISSING | 唯一表生成器 `thesis/inheritedAssets.ts:300`（学位论文继承表） | — |
| 「无真实实验数据 → 暂停」门禁 | PARTIAL | **idea_to_paper 无此门禁**（仅 prompt 纪律；`hitl.evidence_supply` 只管文献，`definitions.ts:7986`）；thesis 有 `hitl.author_decision`（`:12192`，`ThesisPlannerService.ts:354`），但 `attach_experiment_package` 决定**不校验是否真的附加了实验数据**（`ThesisPlannerService.ts:389-396`「决策任意」） | `thesisPlanner.test.ts:285,304` |
| UI：快照 / 运行消费了哪份数据 | MISSING | 前端无快照指示、无 workflow-context 客户端 | — |
| EditContract / accepted-patch lineage | PRODUCTION_CONNECTED（M15.20） | 修订写入统一守卫 | 既有 |

### A.3 真实数据可得性
作者自有 MOT 研究仓库中数据集 D 的 TrackEval 原生输出（base / 主方法 M / 消融 A，summary.txt + detailed.csv），外加作者汇总脚本 JSON（数据集 D、数据集 D′）。只读复制到 `D:\PaperTeamData\M17_2\real_inputs\`（SHA256SUMS.txt）。协议见 `D:\PaperTeamData\M17_2\PROTOCOL.md`（付费调用前冻结）。缺：seed / 多次运行、FPS、统计检验、TrackEval 版本声明——如实登记，不补造。

### A.4 最小实现列表（复用优先，不新建 Store / Engine）
1. **上传**：前端把单个 / 多个 CSV·XLSX·JSON·TXT 打成确定性 stored ZIP，复用现有 ZIP 上传端点、安全校验、哈希幂等与解析器（零后端新上传端点）。
2. **保真解析补丁**：XLSX 百分比格式、无缓存公式、合并单元格从格标注；JSON 重复键告警；`66.9%` 显式后缀与表头单位（`(%)`、`FPS`、`ms`）识别，**只认显式证据**；观测上限截断显式告警；`seq/sequence` 作为上下文列。
3. **作者 metadata**：文件级补充 method / dataset / split / protocol / version / 指标单位（只填补缺失；与文件内显式值矛盾则报冲突，不覆盖）。
4. **事实快照**（`experiments/factSnapshot.ts`，复用实验包目录）：从「已确认 + 已授权」观测构建版本化快照；冲突分类 `SAME_KEY_DIFFERENT_VALUE / VERSION_CONFLICT / UNIT_SCALE_UNRESOLVED / PROTOCOL_NOT_COMPARABLE / MISSING_REQUIRED_METADATA / AGGREGATE_VS_RUN_MISMATCH`；阻断性冲突未裁决不得冻结；作者可排除事实；派生对比用 `derivedFormula`（pp 与相对 % 分开，区间舍入），保存 operandRefs + formula + 资格；读取时校验源哈希 / 授权，失效即 stale。
5. **单点接入**：`workflowContext` 在存在快照时只输出快照事实（stale → 空 + 失效标记），下游 Researcher / Outline / Writer / Revision / Reviewer 自动一致；Writer prompt 增加确定性对比表与快照 id。
6. **Reviewer 确定性核查**：review.run 中按快照核对稿件实验数值主张（pp↔% 混淆、与快照对比不符、无检验的显著性 / p 值），产出带快照 id 与来源定位的 finding；保留既有预登记 claimChecks。
7. **结果表**：由快照确定性生成 booktabs 表（零 LLM，来源脚注），走与 figure 插入相同的受控追加。
8. **thesis 门禁补洞**：`attach_experiment_package` 决定只有存在有效快照时才解锁。
9. **前端**：多文件上传、文件 metadata 编辑、快照预览（冲突双方来源 / 不可比 / 对比）、排除、冻结、版本与失效提示、表插入。

### A.5 关键负例与验收
见任务书 §7.1 的 12 类；每类配放行对照。真实验收按 PROTOCOL.md：模型调用 ≤ 30 次，独立于 M17.1B 账本。

### A.6 兼容性
manifest schema 不升版本：新增字段全部可选；无快照的项目 `workflowContext` 行为与 1645ad7 逐字节一致（回归测试锁定）。

### A.7 非 P0（本轮不做）
idea_to_paper 新增「缺实验」HITL 门禁（现状仅 prompt 纪律，列为 P1）；CSV 小数逗号 locale 解析（只告警不解析）；统计检验计算；ZIP 外的 Excel 宏 / 外链（从不执行）。
