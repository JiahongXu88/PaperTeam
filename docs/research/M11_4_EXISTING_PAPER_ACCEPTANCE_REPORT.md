# M11.4 Completion Report

状态：**PARTIAL / AUTHOR_DECISION_REQUIRED** — 真实工作流已推进到安全返修与质量门；不满足 M11.4 COMPLETE 条件。
更新：2026-10-05（Asia/Shanghai）
项目：p-ee063d5608ff；恢复 run：w-c6a9c9d45c86（终态 cancelled，保留 checkpoints）。
Fixture：D:\PaperTeamData\M10.3-real-paper-case（源目录未修改）。
Quota：未触发 GLM_API_QUOTA_EXHAUSTED；未发现余额耗尽错误。

## 1. Git

- 基线：main，HEAD 与 origin/main 均为 0ae283333eac92c15d2de134dc5d2e1f81dd132e；开工时 clean。
- 本轮改动含 Review cancellation/timeout 收敛、checkpoint continue、Reviewer 4 计划链接回退、后台 ingestion drain 测试清理及文档。最终提交和推送状态见本节更新。
- 无 node_modules、fixture、项目运行产物或凭证文件进入版本控制。

## 2. Real Fixture

- 真实 CEA 投稿稿件与作者整理的 Reviewer 反馈、response letter、revision change log 均在 fixture。反馈 Markdown 标明意见为归纳要点，不是审稿人逐字原文；作者回复只用于 ground truth 对照，不作为评论导入。
- **最终 checkpoint 审计发现输入稿版本问题**：`manuscript/source/paper.tex` 与项目首次导入文件及当前 restore revision 5 的 `main.tex` SHA256 相同；fixture 的 `manuscript/VERSION_README.md` 将其标为 `论文返修稿_20260905_v1`、READY 的投稿前最终返修版本。稿件已经含有这些评论对应的人工修改。fixture 另有 `manuscript/historical/paper_before_revision.tex`（返修前稿），但它没有作为本项目输入。
- 因此，本轮不是在原始返修前稿上重做人工 revision 的等价测试；comment unresolved 是 PaperTeam 处理状态，不能推断人工返修内容不存在。恢复时须先确定验收要检查“已有最终稿的意见覆盖”还是“从返修前稿重演 revision”。
- 额外数据源确实在 fixture 内：`experiments/reports/submission_basis/rdk_x3_full_pipeline_report.md`、`extreme_scene_experiment_report.md`、`fair_ablation_new_detector.md`，以及 `experiments/data/board_c0_20260904/` 与 `experiments/data/fair_ablation/` 原始/聚合结果。此前的 “writer evidence_query=0” 表示这些材料没有进入 PaperTeam 当前 Evidence Store，不表示作者没有实验数据。
- 主稿包含 4 个 section、15 个 subsection、10 个 figure、11 个 table、36 个公式/算法环境、49 个 cite 命令及 25 条 bibliography。
- fixture 原件保持不变；验收运行使用项目副本 p-ee063d5608ff。

## 3. Existing Paper Ingestion

- 使用既有 LaTeX import API 导入真实论文，12 个工程文件。
- 原始基线 xelatex+bibtex 编译 PASS，26 页。Citation baseline：25 cited keys，0 missing，0 hallucinated。
- 原稿导入、基线 build 和原始稿检查通过；最终修订稿 PDF 未生成。

## 4. Reviewer Comment Batch Import

- 批量导入 5 条：1 条 Editor + Reviewer 1–4；parser 输出 5、导入 5、重复 0、漏项 0。评论 ID：x-599c4c2121、x-7a549a1a7d、x-e667067fc9、x-11a99c04f6、x-d6fdd433f0。
- 重复提交确定性验证无新增且仍保留 5 条。前端提供解析确认与 coverage 展示。
- 原始反馈含作者回复，parser 未将回复误导入为评论。

## 5. Comment Parsing

- 使用确定性 Markdown 解析；遵循保守分块、原文保留和去重规则。结果 5/5 与 fixture 意见块数一致，无静默丢失或臆造评论。
- fixture 提供的是作者摘要，所以不能声称已验证对任意审稿人原始格式的普遍解析能力。

## 6. Priority Semantics

- External reviewer/editor 意见进入 mandatory revision planning；确定性 Fact/Citation Safety 仍优先于任何外部修改要求。
- 本次真实链路未将外部意见降为 internal recommendation。安全冲突由确定性验证阻止。
- 批量导入后初始状态均 pending；最终状态均为 unresolved，未把计划或作者回复冒充完成。

## 7. Finding Dispatch

- 当前 target 指向主稿 main.tex；5 条外部意见都保留 instruction linkage。无评论被 dispatch 阶段静默丢弃。
- review 包含对论文缺失实验/边界条件的 findings；无法安全匹配到现有事实的内容进入作者决策，而未擅自写入实验结果。

## 8. Revision Plan

- 生成 17 个 plan items，5 条外部评论 linkage 为 5/5；Reviewer 4 的 linkage 缺口由确定性 fallback 修复并在同项目重规划。
- 对要求设备实验或极端场景证据的意见标出作者决策；未引入新 citation 或无证据 claim。计划有 17 项且外部 linkage 5/5，但 external items 的 section 是 `(global)`，只定位到 `main.tex`，未证明章节级 target 精度。
- 原始测量/报告在 fixture 已存在；7 个 bounded queries 的 0 个 verified evidence records 反映 Evidence Store handoff 不完整。应将已有报告与数据作为本地证据绑定后再评价，不应要求作者重做实验。
- bounded targeted search 执行 7 个查询，未找到可验证证据（0 evidence records）；没有将开放式 research 接入写作。

## 9. Real Revision E2E

- 原 run Review attempt 1 timeout，attempt 2 完成并落盘。修复 lifecycle 后做单路真实 Review smoke，HTTP 200，结束 activeRuns/activeExecutions 均为 0。
- 后续修订产生了方向性事实偏移。确定性 revision validation 拒绝了 17 项 metric_direction_flip；先前 revision 对冻结基线也有 6 项事实保护问题。Workflow 按既有 reject/restore 路径恢复到冻结基线稿衍生版本（restore revision 5）。
- unsafe 修订未被接受；run 在 revision overflow HITL checkpoint 取消。没有继续消耗模型调用去追逐评分。

## 10. Comment Coverage

- 总计 5；Addressed 0；Partially addressed 0；Unresolved 5；Pending 0。
- 持久状态中 5 条均为 unresolved；计划阶段把 Reviewer 2 与 Reviewer 4 标记为作者决策，因为当前 Evidence Store 未含外部本地实验资产。最终只读审计确认对应真实板端/极端场景报告与 raw data 在 fixture 中，故“作者尚未提供数据”并非准确 blocker。
- 只读比对显示当前导入的最终稿已经包含编辑意见、近年引用、RDK X3 部署、UA-DETRAC 视角边界与极端场景分析的人工修订内容。此类文本覆盖尚未被 PaperTeam 的 comment outcome/response trace 正式核验，所以 workflow status 仍保持 unresolved；不能静默改成 addressed。
- External instruction 状态全部明确，无意见静默消失。

## 11. Reviewer Comment Response Trace

- 持久化的 external instruction、plan linkage、revision validation 和恢复记录可还原评论→计划→安全拒绝/未解决。
- 本轮没有生成完整、面向用户的逐条 Comment Response Trace artifact；这是产品验收缺口。当前报告不把内部 linkage 夸称为最终 response letter。

## 12. Fact Preservation

- **候选返修未通过。** Revision validator 在不安全候选稿中发现 17 个方向性事实偏移；此前候选稿还记录 6 项相对冻结基线的事实保护问题。两者均未接受，revision 5 已按正式 restore 恢复到与导入 revision 1 相同 fingerprint 的稿件。当前保存稿没有保留候选漂移；这不等于 PaperTeam 成功产出了新的安全返修。
- 系统拒绝 unsafe revision 并恢复到冻结稿衍生版本，体现 fail-closed 机制；但由于没有安全可接受的 revised manuscript，不能把 preservation 判为全通过。

## 13. Citation Preservation

- 修订审计：25 个既有唯一 citation keys 保持一致；0 removed、0 added、0 hallucinated、0 missing；有 1 个 citation unverifiable。
- Citation safety 检查通过。不存在新增幻觉引用。

## 14. Figure / Table / LaTeX Integrity

- 原始导入工程的 figures、tables、labels 和 LaTeX baseline 编译通过。
- unsafe revision 被拒绝并恢复；没有把该稿作为交付品。未对最终修订稿做 compile，因此 revised figure/table/LaTeX integrity 不可判 PASS。

## 15. Ground Truth Comparison

- 已读取作者 response、revision change log、fixture 版本说明与实验报告。当前导入稿 SHA256 对应 frozen READY final revision，不是返修前稿；逐条人工 ground truth 修改已经体现在 baseline。
- PaperTeam 没有做可靠的 baseline comment coverage reconciliation，仍将意见计划化，并对已有论断进行了生成式重写；Fact Guard 正确拒绝危险候选稿。语义对照证据存在，但正式逐条 trace/outcome 未生成。若继续 M11.4，先核验当前稿是否满足各 comment，再决定是否有真实 delta，禁止无差异地再改写全文。

## 16. Revised PDF

- **未生成 revised draft PDF。** 仅原始 baseline PDF 编译成功，因此 PDF 条件未满足。

## 17. Codex Manual Product Inspection

- 这是 Codex 对 artifact 的人工检查，不是独立 Reviewer 模型。
- baseline/frozen final PDF 抽查页 1、13、17、26，可读且核心结构、图表、参考文献未见明显版式损坏。fixture 的 VERSION_README 记录该 26 页稿已独立编译审计；项目也对同一 SHA256 的导入稿 baseline compile PASS。
- 最终返修被拒绝且无 revised PDF，故无法执行修订稿的完整人工检查清单。

## 18. Tests

- Backend full: npm test -- --maxWorkers=1：**2382 passed / 0 failed / 15 skipped；215 passed files / 3 skipped files；共 2397 tests，耗时 362.34 秒**。跳过项为 live smoke。
- Frontend full：**280 passed / 0 failed / 0 skipped（27 files）**。
- Backend targeted Reviewer/Writer/Orchestrator：61/61 passed；Ingestion HTTP cleanup regression：13/13 passed。
- Backend typecheck、frontend typecheck、frontend build 均 PASS。Frontend build 有现存 chunk >500 kB 提示。
- 本次 backend build 在最终 ingestion cleanup patch 后需以收尾实跑结果补录。

## 19. Runtime / Tokens / Cost

- 估算总费用约 **$0.8067128**，来自累计 runtime usage counters；这是模型 usage 估算，不是账户余额查询。
- 已知 token 累计约 247,494 input / 86,443 output / 至少 257,856 cache-read；其中部分早期 cache-read counter 在进程安全重启后未保留，因此 cache-read 总量不完整。
- 最小 runtime smoke 成功；修复后的单路 Review smoke：15 input、1186 output、6976 cacheRead、2 turns、$0.00705316、89,254 ms。未输出或读取 credential 内容。
- PaperTeam runtime 使用已保存的 Z.AI / GLM-5.3 / General API；credential exists=true，source=stored。

## 20. GLM API Quota Status

- **NOT EXHAUSTED / NOT TRIGGERED。** 未收到 402、insufficient balance/quota 或 billing exhaustion。网络 timeout 不作为余额耗尽证据。
- 当前无 active model request。不要为追求分数重复启动无新信息的调用。

## 21. Known Limitations

- **当前没有证据支持“作者尚未提供 RDK X3 / 极端场景实验数据”**：fixture 内已有 RDK X3 500 帧×3 组 benchmark、18 分钟稳定性报告及 raw aggregate；低照度/高密度报告和逐片段 raw metrics 也存在。缺口是这些本地材料没有被纳入 PaperTeam Evidence Store（本次 7 个 evidence queries 均返回 0 verified records）。不得再将此错误描述为实验不存在。
- 需明确的恢复决策是稿件 lineage：当前项目导入的是 READY 的人工最终返修稿；返修前快照另存为 `manuscript/historical/paper_before_revision.tex`。若目标是审验系统从原稿返修的能力，必须将该历史快照作为明确基线；若继续当前项目，则应审验现有 final draft 的 comment coverage 并只处理真实剩余差异。
- 已有作者 response 明确记录了 Reviewer 3 对 UA-DETRAC 域差异的解释，以及 Reviewer 4 对低照度额外 IDS、高密度检测召回瓶颈的披露；它们可作为 ground truth，不需作者重新决定同一解释。对 editor 与 Reviewer 1 的人工改动也有明确位置和引用变更记录。

## 23. Read-only Closeout: Comment-by-comment / Required Input

以下“workflow status”来自 `reviews/external-instructions.json`，5 条当前全为 `unresolved`；“稿件覆盖”是对导入稿与 fixture 的只读对照，不代表 PaperTeam 已经写出或登记 response trace。

| ID / 来源 | Reviewer intent 与 target | PaperTeam 当前状态 | 已有材料 / 未完成原因 |
|---|---|---|---|
| `x-599c4c2121` Editor | 凝练创新边界；摘要、引言贡献列表、结论第 4 段 | workflow unresolved；final manuscript 已含 ground-truth 改写 | `response_to_reviewers.md` 和 `revision_change_log.md` 记录了 4 点贡献组织及修改位置。剩余是 outcome trace，没有新增科研输入需求。 |
| `x-7a549a1a7d` Reviewer 1 | 补近期车载/交通跟踪研究，引用不少于 20 篇；引言第 3 段、不足总结、refs | workflow unresolved；final manuscript 已列相关文献、25 条 refs | frozen README 与 refs.bib 确认 25 条；ground truth 记录新增 6 篇。仍须核对引用内容/适配性并落 comment outcome；不能把 reference count alone 当完整语义验证。 |
| `x-e667067fc9` Reviewer 2 | 真实车载边缘平台部署性能；§3.8、Table 11，并同步摘要/贡献/结论 | workflow unresolved；final manuscript 已含 RDK X3 §3.8 / Table 11 | 真实报告与 board raw results 存于 fixture。C0 全链路 E2E 1495.63±4.19 ms / 0.669 FPS；ByteTrack 901.54±0.68 ms；500 帧×3 轮；18 分钟稳定性。系统未将来源材料导入 Evidence Store，且此前生成修订出现无关事实漂移。 |
| `x-11a99c04f6` Reviewer 3 | 说明 UA-DETRAC 固定监控视角与车载场景定位关系；§3.2.2 | workflow unresolved；final manuscript 已有域差异说明 | ground truth 明确不把 UA-DETRAC 称为车载第一视角数据，限定为道路交通共有问题，并用 RDK X3 部署补充工程证据。无需新的科研判断；需将现有完成状态写入 trace。 |
| `x-d6fdd433f0` Reviewer 4 | 低照度/高密度下性能与失效模式；§3.7/Table 10、§3.9、结论 | workflow unresolved；final manuscript 已有定量分析 | 3 类场景×9 clips×200 帧=5400 帧；raw extreme metrics 在 fixture。低照度 MRG-DTM IDS 35 vs IoU 24、Norm-IDS 1.89 vs 1.30；高密度 IDS 47 vs 45、Norm-IDS 0.78 vs 0.74。稿件如实记录低照度更差及高密度检测召回局限。 |

**作者输入分类**

- **Type A（必须真实、禁止生成）**：当前没有发现需要作者新做的实验输入。Reviewer 2 与 4 对应的真实实验报告和结果已在给定 fixture 中；若未来重新运行模型阶段，先以本地材料建立 evidence provenance，不得让 Writer创造数据。
- **Type B（作者科研判断）**：主要科学立场已在现有 `response_to_reviewers.md` / frozen final manuscript 中记录，包括 UA-DETRAC 的域差异、低照度下本文 IDS 恶化，以及 RDK X3 实测速度低于实时。没有证据要求作者重新决定这些相同立场；若作者准备改变它们才需要新确认。
- **Type C（可基于现有材料确定性处理）**：核对 comment 与 final manuscript 段落、引用及实验报告的对应；标注已覆盖/残余问题；生成逐条 response trace；对恢复后的稿件做确定性 LaTeX build 和 PDF 检查。这些尚未完成，原因是本轮进入停止调用/总结阶段，而不是缺材料。

**唯一需要用户明确的恢复决策**：验收基线应继续使用项目当前导入的 READY 人工最终返修稿（它已经含所有 ground-truth edits），还是要把 fixture 中的历史返修前稿作为“系统返修能力”测试 baseline。当前项目 `p-ee063d5608ff` 对应前者。没有该选择，不应盲目继续自动重写或把旧 run 直接续跑成最终返修。
- 外部意见目前可批量导入、解析、链接到计划并留有明确状态，但最终逐条 response trace artifact 与 revised PDF 缺失。
- 当前恢复项目仍为 p-ee063d5608ff；源 fixture 未改动。run w-c6a9c9d45c86 在 revision overflow HITL 终止。取得作者所需数据后从同项目的安全恢复版本继续，无需重新导入。
- 不进入 M11.5 Closure Readiness，因为 M11.4 未 PASS。

## Review Timeout / Cancellation Incident

- 原事件包含 original/retry 与 reviewer 子任务；观察到本地 Review sessions 有在途 outbound TLS 连接。客户端连接关闭后的 provider 远端状态无法观测，记录为 remote state unknown；不能简单归为 stale bookkeeping。
- 根因在 PaperTeam：review workflow 未传递 stage AbortSignal；Promise.all 首错即退出，没有取消/等待 sibling；timeout/retry 竞态可能让旧 stage 尚未收敛就启动 retry。
- 修复：ReviewerService 使用同一轮 linked AbortController，失败时取消 siblings 并等待 allSettled；workflow 传递 stage signal；timeout 后等待 stage promise settle 再决定 retry；checkpoint continue 复用已落盘阶段。另修复测试环境 ingestion background task drain，避免 teardown 与临时目录删除竞态。
- deterministic reviewer/workflow/runtime tests 与真实单路 Review smoke 通过；全量 backend suite 2382/0/15。收敛后 active request/execution/permit 为 0；没有 Pi 层故障证据，也未创建 Pi upstream issue。
- Review timeout incident 的调用已计入上方 usage；无 quota exhaustion。

## Pi Upstream Findings

- 未将该 incident 归因 Pi。PaperTeam 的信号传递与 Promise lifecycle 已足以解释并修复问题；没有进行独立 Pi repro，也未创建 upstream issue，避免无证据提交重复/噪声报告。
- 当前没有 evidence 显示 Pi 1.0.1 provider/streaming 边界存在此故障。

## 22. Verdict

**PARTIAL / AUTHOR_DECISION_REQUIRED — M11.4 尚未 COMPLETE；这不是整个项目 SYSTEM_FAILED。** 当前 run 在 overflow HITL 被取消。其间质量门对未接受的候选修订报告 SYSTEM_FAILED（事实上保护/证据守卫未通过）；候选已拒绝并 restore，不能将该候选作为当前稿。另发现 M11.4 起始稿是已完成的人工 final revision，而非返修前稿；证据源材料存在但未被导入 Evidence Store。尚缺 PaperTeam 可读的逐条响应 trace，以及 PaperTeam 产出的 post-workflow revised PDF/对应 gate 验收。恢复前先选择 baseline lineage；随后只核验现稿与评论的差异、导入已有本地证据、生成可追踪 outcome。不要重新导入评论或盲目重跑全文 revision。M11 暂不能进入 Closure。
