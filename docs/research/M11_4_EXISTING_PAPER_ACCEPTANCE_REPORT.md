# M11.4 Completion Report

状态：**PARTIAL — deterministic import accepted; model-stage blocked by runtime channel mismatch**  
更新：2026-10-04（Asia/Shanghai）  
Git 基线：`main` @ `73357234129a59e5e1954e105df25ed339f424d3`，与 `origin/main` 一致；开工时工作区干净。  
真实 fixture：`D:\PaperTeamData\M10.3-real-paper-case`（原目录只读；未复制或修改）。

## 1. Git

- 当前任务起点：`7335723 fix(model-settings): support Z.AI general API connectivity`
- 开工状态：`main`，`HEAD == origin/main`，working tree clean。
- 当前实现未提交；最终状态、commit、push 待完成。

## 2. Real Fixture

- MANIFEST 确认主稿为冻结 CEA 投稿版 `manuscript/source/paper.tex`，bibliography 为 `refs.bib`（25 entries），含 10 个 PDF figure；另有 26 页 LaTeX PDF、19 页 Word 投稿 PDF。
- 反馈材料：`feedback/response_to_reviewers.md`、`response_submission_system_text.txt`、`response_letter_submitted.pdf`、`revision_change_log.md`、`response_QA.md`。
- 回复 Markdown 明确将意见标为“要点归纳”，每项包含意见要点、作者回应与修改位置；它不是 reviewer 原始逐字稿。人工 ground truth 只能按语义对照。
- 已确认确定性 parser 的目标块：编辑意见 1 条 + 外审意见 1–4 共 4 条；author response 不作为意见导入。
- source fixture 未改动。正确目录结构的验收项目为 `p-ee063d5608ff`；无效扁平化打包诊断项目为 `p-4b7ad6e615bc`。两者均位于默认 `backend/projects` workspace，不进入 git。

## 3. Existing Paper Ingestion

- 已有 `/api/projects/import-paper` 支持 PDF / LaTeX；`LatexImporter`、existing-paper workflow 与 M10.4.4 dispatch 已存在。
- 成功通过 `/api/projects/import-paper` 导入真实 LaTeX 工程，12 个工程文件。首个 ZIP 因 `paper.bbl` 不属于允许类型被拒绝并回滚；过滤后的一次试包把 `figs/` 扁平化，baseline compile 检出缺图；修正 ZIP 内目录为 `figs/` 后导入 `p-ee063d5608ff`，baseline compile `xelatex+bibtex PASS`。
- 真实主稿结构：4 个 section、15 个 subsection、10 个 figure、11 个 table、36 个公式/算法环境、49 个 cite 命令、25 个 bibliography entries。编译得到 26 页 A4 PDF（3,635,757 bytes）。
- 正确导入工程含 `paper.tex`、`refs.bib` 与 10 个 `figs/*.pdf`；原始 fixture 未改。临时 ZIP 与 26 张 PDF 渲染 PNG 仍在本机临时目录；删除命令被执行策略拒绝，未纳入 Git。

## 4. Reviewer Comment Batch Import

- 已增加确定性 Markdown parser、`ExternalInstructionStore.addBatch` 原子有序写入与预览/批量导入 API：
  - `POST /api/projects/:id/external-instructions/parse`
  - `POST /api/projects/:id/external-instructions/batch`
- 已增加前端解析预览和显式确认；复用现有 ExternalInstruction 数据模型，不增加生产依赖。
- 正确项目 `p-ee063d5608ff` 真实服务预览：`sourceBlocks=5`、`parsed=5`、`parserDuplicates=0`、`existingDuplicates=0`；确认导入后 `created=5`、重复 `0`，5 条状态均 `pending`。ID 与上一项目同文指纹：`x-599c4c2121`（Editor）、`x-7a549a1a7d`（Reviewer 1）、`x-e667067fc9`（Reviewer 2）、`x-11a99c04f6`（Reviewer 3）、`x-d6fdd433f0`（Reviewer 4）。重复提交验证 `created=0 / duplicateIds=5 / persisted=5`。
- 前端增加现有状态 coverage：total / handled / partially handled / unresolved / conflict（需作者决策）/ pending。
- parser 测试覆盖编辑/Reviewer 标题、显式意见要点、排除作者回应、保守整段 fallback、顺序、去重与超长拒绝。
- 定向测试：`backend/test/review/externalInstructions.test.ts` 22/22 PASS。

## 5. Comment Parsing

- 真实 fixture dry-run 与服务预览结果一致：1 Editor + 4 reviewer；0 遗漏、0 parser duplicate；作者回应未进入评论。
- parser 不调用模型、不臆造意见；未识别结构整段保留；重复项显式计数。

## 6. Priority Semantics

- 既有逻辑将外部意见放入 mandatory 计划；确定性 Fact/Citation Gate 仍为安全边界。
- 新导入默认 `pending`，不会因作者回复而标成已处理。
- 本轮未生成真实 Revision Plan（配置 blocker）。既有单测验证 external mandatory 优先级及 conflict 留档；全量已有 Fact/Citation gate 回归通过。

## 7. Finding Dispatch

- 既有 M10.4.4 heading/section dispatch 实现与测试位于 `backend/src`、`backend/test/workflow/m1044DispatchE2E.test.ts`、`backend/test/manuscript/m1044DispatchMatch.test.ts`。
- 真实评论到稿件 target 覆盖尚未运行。

## 8. Revision Plan

- 既有 `revisionPlan.ts` 支持 external instruction linkage（`instructionId`、`sourceText`、mandatory）。
- 真实计划需先于任何 Writer 调用检查；尚未生成。

## 9. Real Revision E2E

- 尚未启动。唯一 blocker 为当前 runtime channel 不符合用户指定的 `general_api`；GLM 余额停止条件未触发；本轮模型调用为 0。

## 10. Comment Coverage

- 当前 total=5；handled=0、partially_handled=0、unresolved=0、conflict/author decision=0、pending=5。尚未进入返修，不能把 pending 计作完成。

## 11. Reviewer Comment Response Trace

- 当前有 external instruction status、revision plan linkage、revision outcome 与 change log；尚未验证是否足以导出可读的逐条 trace。

## 12. Fact Preservation

- 复用 M11.2.1 / M11.2.3 已冻结机制；真实返修前后尚无对比。

## 13. Citation Preservation

- 复用现有 `citationPreservation` 确定性 Gate；真实返修前后尚无对比。

## 14. Figure / Table / LaTeX Integrity

- 正确导入副本的 10 个 figure 和 25 个 bibliography entries 在位；baseline compile 通过，PDF 共 26 页。返修前后差分尚不存在。

## 15. Ground Truth Comparison

- 采用 `response_to_reviewers.md` 的意见要点与 `revision_change_log.md` 比较方向及章节覆盖，不要求字符串一致。
- 尚未比对 PaperTeam revision。

## 16. Revised PDF

- **修订稿 PDF 未生成**。已成功生成的是未改动基线稿 PDF（26 页），不能作为 Revised Draft 交付。

## 17. Codex Manual Product Inspection

- Codex 对基线 PDF 抽查渲染页 1、13、17、26：中文/英文摘要、正文公式、图表和参考文献页面可读，未见裁切/重叠。仅为 Codex 人工视觉检查，不是独立 Reviewer，也不是修订稿检查。

## 18. Tests

- backend full tests（`npm test -- --maxWorkers=1`）：**2377 passed / 0 failed / 15 skipped（2392 tests；215 passed files + 3 skipped files）**，耗时 334.26 秒。跳过项为 live smoke tests。
- frontend full tests：**280 passed / 0 failed / 0 skipped（27 files）**。
- root `npm run typecheck`：通过（backend + frontend）。
- root `npm run build`：通过（backend + frontend）；frontend build 有既有 bundle >500 kB 提示。
- 定向 backend external instruction tests：22/22；frontend panel tests：8/8。此前高并发运行出现的临时超时/Windows `EBUSY` 在单 worker 全量运行中未复现。

## 19. Runtime / Tokens / Cost

- 截至本报告：本轮 PaperTeam 模型请求 0、GLM tokens 0、usage cost `$0`；没有发生扣费的模型调用。
- dev runtime：Pi 1.0.1 healthy；model=`zai/glm-5.3`、provider=`zai`、configurationSource=`stored`、credential exists=`true`、source=`stored`。`GET /api/settings/model` 显示 `apiChannel=coding_plan`。本机 `C:\Users\Administrator\.paperteam\settings\model.json` 保存了模型，但没有 `apiChannel=general_api` 绑定，因此该运行时回落默认 `coding_plan`。这只能证明当前 runtime 的通道配置，不代表个人 Key 不存在或账户余额为零。个人 Key 的 credential 内容未读取；未启动模型任务。

## 20. GLM API Quota Status

- `NOT_TRIGGERED`。没有余额/额度错误；runtime usage totals 为 0 runs / 0 tokens / 0 estimated cost；本轮实际 GLM 成本 `$0`。这是本地 usage，不是账户余额读数；本轮没有证据表明账户余额为零。
- 遇到明确余额/额度耗尽或 HTTP 402 时立即停止所有新模型调用，并将状态改为 `GLM_API_QUOTA_EXHAUSTED`。

## 21. Known Limitations

- fixture 反馈是作者总结的意见要点，不是外审原文。
- 当前 runtime 通道是 coding_plan，不符合用户明确指定的 general_api；未擅自修改设置或尝试付费模型请求。
- 正确项目的基线编译 PDF 已生成，但 revised PDF、真实 dispatch/plan/revision/gate 尚未执行。
- 一次无效打包试项目 `p-4b7ad6e615bc` 保留作诊断记录；正式恢复点为 `p-ee063d5608ff`。
- 临时诊断文件仍在本机：`D:\Projects\PaperTeam\tmp\pdfs\m114-baseline-*.png`（26 张，gitignored）与 `C:\Users\Administrator\AppData\Local\Temp\paperteam-m114-fixture.zip`。删除命令被执行策略拒绝两次；文件未进入 Git，未尝试绕过策略。

## 22. Verdict

**PARTIAL — RUNTIME_API_CHANNEL_MISMATCH**。真实论文正确 ingest 并 baseline compile；批量导入 5 条（编辑 1 + reviewer 4），漏掉 0、重复 0，当前 pending 5。停在 `p-ee063d5608ff` / `external-instructions.batch`。本地状态确认模型 credential exists=`true` / stored，但本次 dev runtime 的 `apiChannel` 是默认 `coding_plan`；保存配置中缺少 `general_api` 通道绑定。它不表示个人 Key 不存在或账户余额为零。因通道与用户指定不一致，没有调用模型；本地 usage 为 0 requests / 0 tokens / `$0`，未触发 `GLM_API_QUOTA_EXHAUSTED`。恢复已保存 General API 通道配置并确认该 PaperTeam runtime 读取到后，从此项目继续 Dispatch / Revision Plan；先审计划再调用 Revision。当前 M11.4 不可 COMPLETE，不可进入 M11 Closure。
