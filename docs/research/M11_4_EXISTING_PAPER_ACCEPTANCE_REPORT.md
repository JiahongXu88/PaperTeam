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
- 对要求设备实验或极端场景证据的意见标出作者决策；未引入新 citation 或无证据 claim。计划覆盖 reviewer intent，但最终执行仍受 Fact Guard 阻止。
- bounded targeted search 执行 7 个查询，未找到可验证证据（0 evidence records）；没有将开放式 research 接入写作。

## 9. Real Revision E2E

- 原 run Review attempt 1 timeout，attempt 2 完成并落盘。修复 lifecycle 后做单路真实 Review smoke，HTTP 200，结束 activeRuns/activeExecutions 均为 0。
- 后续修订产生了方向性事实偏移。确定性 revision validation 拒绝了 17 项 metric_direction_flip；先前 revision 对冻结基线也有 6 项事实保护问题。Workflow 按既有 reject/restore 路径恢复到冻结基线稿衍生版本（restore revision 5）。
- unsafe 修订未被接受；run 在 revision overflow HITL checkpoint 取消。没有继续消耗模型调用去追逐评分。

## 10. Comment Coverage

- 总计 5；Addressed 0；Partially addressed 0；Unresolved 5；Pending 0。
- 计划阶段识别出 2 条需作者决定（需要新增真实实验/边界场景数据）；它们仍以 unresolved 计入当前持久状态，不能计作已解决。
- External instruction 状态全部明确，无意见静默消失。

## 11. Reviewer Comment Response Trace

- 持久化的 external instruction、plan linkage、revision validation 和恢复记录可还原评论→计划→安全拒绝/未解决。
- 本轮没有生成完整、面向用户的逐条 Comment Response Trace artifact；这是产品验收缺口。当前报告不把内部 linkage 夸称为最终 response letter。

## 12. Fact Preservation

- **未通过真实返修验收。** Revision validator 在不安全稿件中发现 17 个方向性事实偏移；此前修订稿还记录 6 项相对冻结基线的事实保护问题。
- 系统拒绝 unsafe revision 并恢复到冻结稿衍生版本，体现 fail-closed 机制；但由于没有安全可接受的 revised manuscript，不能把 preservation 判为全通过。

## 13. Citation Preservation

- 修订审计：25 个既有唯一 citation keys 保持一致；0 removed、0 added、0 hallucinated、0 missing；有 1 个 citation unverifiable。
- Citation safety 检查通过。不存在新增幻觉引用。

## 14. Figure / Table / LaTeX Integrity

- 原始导入工程的 figures、tables、labels 和 LaTeX baseline 编译通过。
- unsafe revision 被拒绝并恢复；没有把该稿作为交付品。未对最终修订稿做 compile，因此 revised figure/table/LaTeX integrity 不可判 PASS。

## 15. Ground Truth Comparison

- 已读取作者 response 与 revision change log，作为语义比较依据。
- PaperTeam 识别出需补实验和边界条件证据的核心 intent，并正确拒绝伪造数据；但返修未被接受，无法完成最终人工修改与系统修改的逐条结果比较。ground truth 对照未完成。

## 16. Revised PDF

- **未生成 revised draft PDF。** 仅原始 baseline PDF 编译成功，因此 PDF 条件未满足。

## 17. Codex Manual Product Inspection

- 这是 Codex 对 artifact 的人工检查，不是独立 Reviewer 模型。
- 原始 baseline PDF 抽查页 1、13、17、26，可读且核心结构、图表、参考文献未见明显版式损坏。
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

- 主要 blocker 是科研决策：需要作者提供新增实验/真实数据并确认结果解释；系统不能替作者创造这些事实。
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

**PARTIAL / AUTHOR_DECISION_REQUIRED — M11.4 尚未 COMPLETE。** 已验证真实 import、批量 comment ingestion、5/5 计划 linkage、GLM General API runtime、Review lifecycle 收敛与 citation preservation；但事实保护拒绝返修、5 条评论均未最终解决、revised PDF 和完整 response trace 缺失。恢复点为原项目 p-ee063d5608ff 的安全恢复稿；待作者提供真实实验数据/科学判断后继续。M11 当前不能进入 Closure。
