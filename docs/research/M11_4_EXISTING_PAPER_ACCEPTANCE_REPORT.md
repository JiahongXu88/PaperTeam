# M11.4 Final Acceptance Report

**结论：FAIL — M11.4 Existing Paper Revision Product Acceptance 未完成。** 正确的返修前稿成功导入，5 条意见和本地实验资料均进入新项目；但 Writer 在首次修订后触发事实守卫失败，后续整稿修订又产生 17 项被拒变更。Candidate 已在读取人工 ground truth 前冻结。未发布 PaperTeam Revised PDF。不得将本轮标为 COMPLETE，也不得进入 M11.5 Closure。

更新：2026-10-05（Asia/Shanghai）

Project：`p-083018b5b6b7`

Workflow：`w-9fce598c257f`（最终状态 cancelled；revision 3 和其 validator 在 cancel 请求生效前已完成）

Fixture：`D:\PaperTeamData\M10.3-real-paper-case`（源目录未修改）

PaperTeam：`D:\Projects\PaperTeam`
配额：未触发 `GLM_API_QUOTA_EXHAUSTED`；未发现 402、余额不足或 billing 错误。

## 1. Verdict

- **M11.4：FAIL。** 核心返修安全性未通过：rev 2 Quality Gate 失败；rev 3 revision validation 的 17 项均 rejected、blocked=true。返修流程没有生成可接受的安全 Candidate，也没有形成完整的最终 comment outcome trace。
- Candidate 已冻结为 `PAPERTEAM_CANDIDATE`, project `p-083018b5b6b7`, revision 3，SHA256 `768DDC404E38BAC8E19F445074A0AF9BA0F4688AC737F307D298C71B3EB16246`。冻结记录位于项目运行数据 `acceptance/PAPERTEAM_CANDIDATE_FREEZE.json`，不是版本控制文件。
- 返修前 baseline、评论导入、实验材料接入、section 级计划和引用结构检查通过；这些部分不能抵销事实守卫失败。
- 没有发现必须补做的新物理实验。已有板端和极端场景数据已进入 PaperTeam Source/Evidence 路径。

## 2. Git

- 开始前：`main`；`HEAD == origin/main == 7dbfdb58584543e06fd6e2c10b908e27990c86ce`；working tree clean。
- 本次没有修改产品代码。只更新本报告和 `docs/PROJECT_STATUS.md`；运行项目、candidate、临时编译产物均在 gitignored 项目数据或 `%TEMP%`。
- 两份文档已提交到本地 `main`；未 push。最终 working tree clean，HEAD/`origin/main` 对照以收尾时 `git log` 为准。无 fixture、PDF、API Key、`auth.json`、凭证或实验大文件加入 Git。

## 3. Why Previous Attempt Was Invalid

**Attempt 1（历史，无效生成实验）**：项目 `p-ee063d5608ff` 从人工 READY 最终稿 `manuscript/source/paper.tex` 出发，再处理同一批 reviewer comments。此稿已经包含人工返修，不能回答“PaperTeam 能否从返修前稿完成返修”。保留为历史工作流、工程问题和 coverage/trace 参考；本轮未从该项目续跑生成式 Revision，也未覆盖其数据。

**Attempt 2（本报告验收实验）**：新建 `p-083018b5b6b7`，导入 `manuscript/historical/paper_before_revision.tex`，而非人工最终稿。两个源 SHA 不同。未将人工稿、回复或 change log 导入 PaperTeam。Candidate revision 3 冻结记录写入后，才读取 held-out 内容用于后验比较。

## 4. Generation Set vs Evaluation Set

**GENERATION_SET（允许进入项目、Source、Evidence、Prompt、Plan 或 Writer context）**

- `manuscript/historical/paper_before_revision.tex`、同目录 bibliography 和 10 张原始图表资源。
- `feedback/response_to_reviewers.md` 中 1 条 Editor + 4 条 Reviewer 的意见文本；只抽取意见块，作者回复没有导入。
- `experiments/reports/submission_basis/rdk_x3_full_pipeline_report.md`、`extreme_scene_experiment_report.md`、`fair_ablation_new_detector.md`。
- `experiments/data/board_c0_20260904/`、`experiments/data/fair_ablation/` 的结构化原始与聚合结果。
- 一次有界的 targeted literature search；没有采纳候选文献、没有添加 citation。

**EVALUATION_SET（candidate 冻结后才打开）**

- `manuscript/source/paper.tex`（人工最终稿；SHA256 `EC7CE798200D36E682602A0DCBECCD85D368CF4E014BA6A38FFB5A473EFBDE89`）。
- `feedback/response_to_reviewers.md` 中作者回复段落。
- `feedback/revision_change_log.md` 中人工修改记录。
- 人工最终稿 PDF 及相关 final-only 核对材料。

生成前只读到 fixture 文件存在与少量版本元数据；未读取人工修改答案，也没有将该元数据交给 GLM、Planner、Writer、Reviewer、Evidence 或 Research。Candidate freeze SHA/状态记录于 `2026-10-04T23:13:35Z`，随后才打开人工回复和 change log。人工材料不曾回灌生成链。

## 5. Pre-Revision Baseline

- 路径：`D:\PaperTeamData\M10.3-real-paper-case\manuscript\historical\paper_before_revision.tex`
- 大小：74,516 bytes；SHA256 `423CF0E0C66612AD7C801785D60F183367BCFDA5D46C1E32E1610B2F87E46D30`。
- Held-out 人工稿：77,731 bytes；SHA256 `EC7CE798200D36E682602A0DCBECCD85D368CF4E014BA6A38FFB5A473EFBDE89`。与返修前稿不同。
- 正文 inventory：4 sections、15 subsections、16 subsubsections、10 figures、11 tables、34 equation environments、39 labels、22 refs、49 cite commands；25 个唯一 bib keys，25/25 被引用。
- 独立 baseline xelatex+bibtex PASS，26 页，0 build errors，missing citations=0、hallucinated citations=0。

## 6. Existing Paper Import

- 新建项目名：`M11.4 Existing Paper Final Acceptance — Pre Revision Baseline`；ID `p-083018b5b6b7`。
- 只从返修前稿及其 `refs.bib`、`figs/` 导入，共 12 个工程资产，0 import warnings。
- 导入谱系指向 `paper_before_revision.tex`；首次编译 revision 1 PASS，产物为 PaperTeam 自己构建的 baseline PDF（26 页）。未用人工最终稿 PDF 冒充产品产物。

## 7. Reviewer Comment Import

- 来源：`feedback/response_to_reviewers.md` 的真实评论摘要块，共 5 条：Editor 1 + Reviewers 1–4。
- 批量输入 5 → parsed 5 → imported 5；0 lost、0 duplicated。作者回复没有进入评论。
- IDs：`x-599c4c2121`、`x-7a549a1a7d`、`x-e667067fc9`、`x-11a99c04f6`、`x-d6fdd433f0`。

## 8. Local Experiment Evidence

- 32 项来源文件通过 `Source → fulltext/structured content → chunks → EvidenceStore` 接入；不是把报告全文塞入 Writer Prompt。
- RDK X3：报告 + `board_c0_20260904` 原始聚合数据形成 E001–E003。源数据复核结果：C0 完整链路 E2E `1495.6306 ± 4.1880 ms`、约 `0.669 FPS`；ByteTrack A `901.5368 ± 0.6848 ms`；每组 500 帧、3 次重复；另有 18 分钟稳定性报告。候选没有授权改变这些测量事实。
- Extreme scene：fair-ablation 新微调检测器协议与 `fair_ablation` 原始数据支持低照度/高密度结果（E006–E013、E015）。例如低照度 A/C IDF1 `.76058/.75073`、IDS `24/35`；高密度 A/C IDF1 `.74752/.74531`、IDS `45/47`；对应 GT 帧数均来自 raw metrics。明确排除旧协议报告 S002 的 COCO 预训练模型值，不用 E014（标记 unverifiable）。
- Reviewer 2 和 4 均不再被判定为“没有实验数据”；没有真正缺失的物理测量要求。
- Literature：有界 targeted search 未得到可直接采纳的候选；baseline 已有 25 个相关 bib keys，未增添未经验证文献。

## 9. Finding Dispatch

- 5/5 外部意见与 plan items 链接；workflow dispatch 报告 `matched=5, unmatched=0, multiTarget=0`。
- 计划文本分别定位到引言贡献边界、引言车辆跟踪相关工作、`subsec:edge_deploy`、`subsec:datasets`、`subsec:extreme_scene`，并写明 rationale / action。Project 是单文件 LaTeX，schema 的 `section` 值为 `main.tex`，所以章节定位细节保存在 action 文本，而不是结构化 section ID。
- Dispatch/plan 达到可读的 section-level 精度；但 Writer 最终以整份 `main.tex` 为目标输出，没能执行最小范围约束。

## 10. Revision Plan

- final plan 5 items、5/5 instruction linkage、0 internal item；priority 字段为 high，外部意见在 runtime dispatch 中按 mandatory 处理。
- Editor、Reviewer 1、2、4 的 baseline coverage check 判定已满足，规划 NO-OP 并列出 required evidence / mustPreserve / expected outcome；Reviewer 3 计划只在 UA-DETRAC 数据集段落补一句范围说明，沿用既有 citation。
- Plan 有可检查的逐条 target、reason、action 和 evidence 约束。问题发生在 Writer 执行：no-op 项仍被带入整篇写作，获批的一句修改也未被限定为唯一 diff。

## 11. Real Revision

- **rev 2 / revision.apply**：Writer 针对 `main.tex` 输出整篇文件，虽然计划只要求一个小句子或 NO-OP。dispatch 5/5 命中。rev 2 Quality Gate 失败：新增 2 条 unsupported claim、6 项方向性事实变化、blocking/critical/major 未清零，学术评分 60（门槛 80）。Citation verifier：25 cited keys、0 missing、0 hallucinated、1 unverifiable。
- 系统确定性派生 43 项修订计划（22 planned，含 5 条 external），再次向 Writer 派发。`revision.revise` 耗时 8m26s，提交 **rev 3**，随后 validation 17 项全拒绝、`blocked=true`。Candidate 中出现对极端场景旧 COCO 协议的错误插入、非必要摘要/方法/公式改写，以及 `\end{document}` 后的内部修订说明文本。
- Workflow 在 revision 3 validator 完成后被取消；没有继续重复模型修订。Candidate 冻结 SHA 已记录。rev 2 的 Quality Gate 已失败；rev 3 的 validator blocked。不得关闭 Guard 或人工把 ground truth 回填来取得 PASS。
- 收敛结论：本轮终态为 **FAIL / SYSTEM_FAILED safety gate**，非作者缺实验或科研决策阻塞。

## 12. Comment Outcomes

workflow 的 `external-instructions.json` 中 5 条最后均为 `unresolved`（备注为派发章节不适用/未报告结果）；没有完整 response trace artifact。下表是冻结后 Codex 对 Candidate 与 Human Final/change log 的后验评价，不回灌 Writer。

| Comment | Human Resolution Summary | PaperTeam Candidate Summary | Intent Match | Safety | Final status |
|---|---|---|---|---|---|
| `x-599c4c2121` Editor | 重整四项贡献，明确 MRG-DTM、尺度自适应损失、多数据集/极端分析、RDK X3 部署的边界；未虚构创新点。 | Plan 将其判为已覆盖/NO-OP；Writer 后续改动摘要与方法叙述且附加内部说明，系统 outcome 仍 unresolved。贡献边界未被 trace 确认。 | PARTIAL | FAIL（整稿存在事实漂移） | unresolved |
| `x-7a549a1a7d` Reviewer 1 | 增补 6 篇 2021–2024 相关文献，19→25，补充车辆跟踪、遮挡、相机运动补偿与边缘部署工作。 | 返修前稿已 25 keys 且含相关主题；Candidate 保留 25 keys，未增删引用。对本轮 baseline 来说无需补引文。 | FULL（baseline already covered） | PASS（citation 结构） | addressed（基线已满足；系统仍记 unresolved） |
| `x-e667067fc9` Reviewer 2 | 增加完整 RDK X3 部署、表格、500×3 测量、18 分钟稳定性及非实时限制。 | 返修前稿已含 §3.8 与表格，Evidence E001–E003 数值一致；Candidate 保留核心部署材料，但没有独立 trace 确认且整稿 Guard 失败。 | FULL（内容与证据在 baseline 已存在） | FAIL（Candidate 整体不安全） | unresolved |
| `x-11a99c04f6` Reviewer 3 | 说明 UA-DETRAC 固定监控视角的域差异，仅代表道路交通共性问题，以 BDD100K/板端实验补足车载定位。 | Candidate 新增一句明确 BDD100K 支撑车载第一视角，但重复前文固定监控说明；保留了较宽的“车载级”措辞。 | PARTIAL | FAIL（冗余且整体事实 Guard 失败） | partially_addressed |
| `x-d6fdd433f0` Reviewer 4 | 增加公平协议的低照度、高密度指标及失效模式，承认低照度下 IDS 更差、高密度主要受检测召回限制。 | Candidate 保留表格结构/数值，但在极端场景协议插入 COCO 预训练旧协议描述，与当前 fair-ablation 来源和正文协议冲突；并有大范围事实/方法改写。 | PARTIAL | FAIL（Evidence misuse / unsupported） | unresolved |

Reviewer 2 / 4 的真实实验材料已在 fixture 且进入 EvidenceStore，不需要作者补实验。Reviewer 3 的新增一句与 human resolution 意图接近但写法重复。Reviewer 1 在正确 baseline 上已满足数量和主题覆盖，因此未加 citation 是正确的最小修改选择。

## 13. Fact Preservation

- **FAIL。** rev 2 Gate 识别出 6 项结论方向变化及 2 条 revision-introduced unsupported claim；rev 3 validation 拒绝 17/17 修订项，blocked=true。
- Candidate 包括更改摘要结论、方法/算法步骤、轨迹稳定性损失公式文字和极端场景协议。系统定位到一处将原有阈值影响解释替换成方法贡献描述的方向性漂移。Writer 还引入旧 COCO 预训练协议描述，不能用旧报告来覆盖当前 fair-ablation 数据。
- 这些候选变更未通过 Guard；本报告不会将“守卫发现并拒绝”表述为 fact preservation PASS。

## 14. Citation Preservation

- Candidate 保留 25 个唯一 citation keys、49 条 cite commands；相对 baseline 0 removed、0 added、0 hallucinated、0 missing。rev 3 validator 报告 `uncoveredAddedKeys=0`。
- Citation Preservation 的结构性检查 **PASS**。一次 citation metadata 检查有 1 项 unverifiable；不是 missing/hallucinated citation。

## 15. Figure / Table / Equation Integrity

- Candidate inventory 与 baseline 一致：10 figures、11 tables、34 equation environments、39 labels；refs 从 22 到 23（新增 UA-DETRAC/BDD100K 交叉引用），LaTeX 结构可编译。
- 结构计数不能证明公式语义保持；rev 3 validation 对 17 项修订全部拒绝，其中包括公式/方法改写。因此 figure/table/equation **整体完整性不能判 PASS**。未发现表图资源路径丢失。

## 16. Revised PDF

- **PaperTeam Revised Draft PDF：未生成/未发布。** Fact Preservation/Quality Gate 未通过，不满足导出条件。
- 为回答 LaTeX 可编译性，在 `%TEMP%` 的独立副本上对冻结 rev 3 运行 xelatex → bibtex → xelatex×2，全部返回码 0，临时输出 26 页。该临时编译文件不是 PaperTeam artifact，也不是交付 PDF；未拿人工最终稿 PDF 冒充。
- `\end{document}` 后的多余内部说明不会进入 PDF，仍属于源稿污染问题；因此不能将“编译成功”当成可发布。

## 17. Held-Out Ground Truth Comparison

- Human Final 与 pre-revision baseline 不同，且 human final / response / change log 都是在 Candidate freeze 后读取。
- Change log 记录人工以最小必要修改完成 comments：引言贡献重组与近年文献补充；RDK X3 部署结果及限制；UA-DETRAC 视角边界；公平协议极端场景表格和失效说明；保留原表 4–9 数值。
- PaperTeam 的确从返修前稿出发且拿到了真实实验 Evidence，但执行器没有尊重 plan 中的 NO-OP 与单句 scope，且在恢复轮误用旧协议 Evidence、写入不相关修改。Human Final 不是字符串匹配目标，但其中严格限缩修改范围、呈现实测不利结果的策略优于 Candidate。

## 18. Comment-by-Comment Human vs PaperTeam Comparison

| ID | Human change log / response | PaperTeam 结果 | Intent / safety |
|---|---|---|---|
| Editor | 四点贡献重整，并明确对已有方法的贡献边界。 | Plan 识别为已经覆盖；Candidate 仍产生超出计划的摘要/方法改写，trace unresolved。 | PARTIAL；整体安全 FAIL。 |
| Reviewer 1 | 增补 6 篇近期论文，参考文献 25 篇。 | Correct baseline 已有 25 篇与对应主题，Candidate 保留原 key 集；不需再追加。 | FULL（合理的 different-by-baseline）；citation safety PASS。 |
| Reviewer 2 | RDK X3 完整链路、性能/稳定性表、明确未达实时帧率。 | baseline 已有同一实验与数值，E001–E003 可回溯；Candidate 没有保留逐条 outcome trace。 | FULL 内容覆盖；系统 trace unresolved，安全总门失败。 |
| Reviewer 3 | 说明固定监控域差异、道路 MOT 共性定位及车载证据补充。 | 加入 BDD100K 车载第一视角说明，但重复“固定监控”句，且仍有过强“车载级”字眼。 | PARTIAL；可在安全小修中合并，不需新科研判断。 |
| Reviewer 4 | 报告公平协议下低照度 IDS 恶化、高密度检测召回瓶颈；承认局限。 | 候选保留结果，但新增旧 COCO detector 协议说明与当前实验来源冲突；revision validation 全拒绝。 | PARTIAL / unsafe；不能视作已解决。 |

**DIFFERENT_BUT_REASONABLE**：Reviewer 1 不再新增文献是正确差异，因为要求的 25 条在真实 baseline 中已存在。Reviewer 3 关于 BDD100K 的一句补充方向合理，但需去重和收窄措辞。

**MISS / material gap**：Reviewer 4 的协议版本被混写；Candidate 未形成可用的逐条 comment response/outcome trace；Editor intent 未有可确认终态。Reviewer 2 的证据内容存在，但状态未关闭。

## 19. Codex Manual Inspection

1. 5/5 comments 均有持久化状态，但都是 `unresolved`，缺少 resolution summary/remaining issue 的完成态 trace。
2. External priority 为 mandatory，高于内部意见；Fact/Citation/Evidence hard guard 未被关闭。
3. 修改与目标有局部对应，但多数已有覆盖项被计划为 NO-OP 后仍被整稿重写。
4. Reviewer 2/4 不是缺实验；真实资料入库成功。Reviewer 4 revision 引入了旧 COCO 协议混淆。
5. 存在过度修改：摘要、算法步骤、loss 说明、极端场景协议被改；另在 `\end{document}` 后残留内部修订说明。
6. RDK X3 和 fair-ablation 数值有原始证据；candidate 对 COCO 协议的使用是错源/错范围。
7. Fact Preservation FAIL；Citation Preservation 的键集安全 PASS。
8. citations 全部对应已有 bib keys；新增 hallucinated=0、missing=0。
9. figures/tables/labels/ref 数量完整，但公式内容保护失败，整体结构完整性不等于科学安全。
10. 独立临时 LaTeX 编译通过，26 页；源尾存在 `\end{document}` 后垃圾内容。
11. 原有主章节、图表和标签结构保留；正文产生额外 subsubsection 和多处无关改写。
12. 未见 Reviewer 要求以外新增物理数据，但产生了未经计划授权的学术叙述。
13. unresolved 未被系统伪装为 addressed；外部状态机诚实地留在 unresolved。
14. 未生成或检查 PaperTeam Revised PDF 的版面，因为没有满足 Guard 导出条件。

## 20. Runtime / Tokens / Cost

- Runtime 使用 Z.AI / GLM-5.3 / General API（按量）；未切 Provider、模型或渠道。
- workflow 性能报告：22 assistant turns，219,956 input / 75,158 output tokens，209,792 cache-read；估算 list-price **$0.6932**，wall time 27m57s。
- 最慢阶段 `revision.revise` 8m26s。Cost 为运行报告估值，非实际账单余额查询。
- 未输出 API Key、`auth.json` 或私密 header。

## 21. Tests

- Backend full: `npm test -- --maxWorkers=1` — **2382 passed / 0 failed / 15 skipped**（215 test files passed，3 skipped；2397 tests；368.62 s）。
- Frontend full: `npm test` — **280 passed / 0 failed / 0 skipped**（27 test files；13.53 s）。
- Backend `npm run typecheck`: PASS。
- Frontend `npm run typecheck`: PASS。
- Backend `npm run build`: PASS。
- Frontend `npm run build`: PASS；Vite 提示有大于 500 kB 的 chunk（既有 bundle size warning）。
- M11.4 **产品验收仍 FAIL**；全量测试绿不代表 candidate 安全通过。

## 22. Pi Upstream Findings

- 没有发现可复现的 Pi 1.0.1 provider/streaming/Abort/retry/cancel 缺陷。本次阻断发生于 Writer 未遵循 PaperTeam 计划 scope、Candidate safety guards 正常拒绝的路径；无独立最小 repro，不创建 upstream issue。
- Review timeout/cancel、active request cleanup、sibling reviewer settle 与 ingestion test cleanup 等上一轮已修复事项不在本轮重复调查；本轮运行未显示其回归。

## 23. Known Limitations

- 全文单文件项目的结构化 `section` 字段退化为 `main.tex`；章节 targets 只存在于 action 文本。Dispatch 命中正确，但 Writer 收到完整文件修订任务，实际修改范围控制不足。
- 首次 Writer 输出 30,040 input / 22,358 output tokens；恢复 Writer 输出 59,491 / 27,618，内容范围和成本都偏大。
- citation metadata 有 1 项 unverifiable；未影响 key-level citation safety，但不能宣称每条引文元数据均通过外部核验。
- 没有生成对外 Revised PDF、完整 resolved trace 或 M11.5 closure 文件。

## 24. M11.4 Verdict

**FAIL — Existing Paper Revision Product Acceptance 未通过。** Attempt 2 的结论见历史记录；Attempt 3 的 scoped Writer 调用和 protocol Evidence 已接入，但 Writer 对工作区的直接文件写入绕过了冻结基线 scope diff，Fact Preservation 发现 6 项方向漂移并阻止 Candidate 导出。不能以守卫曾经拒绝不安全候选来宣称返修能力通过。

## 25. M11.5 Closure Readiness

**Not ready。** M11.4 未通过，不进入 M11.5 Closure Readiness Audit。后续收口应先让 scope guard 对冻结的 writer 前文件快照与最终文件做差分，并关闭可绕过结构化 patch 的直接写文件通道；再修复 patch 级 Fact outcome 归因，之后才可按授权建立新的隔离验收项目。不得复用 Attempt 3 生成项目或降低 Guard。

### Attempt history

- **Attempt 1 — invalid baseline:** `p-ee063d5608ff` 从 Human Final 再返修，作为历史实验保留，不纳入本轮产品能力结论。
- **Attempt 2 — correct baseline:** `p-083018b5b6b7` 从 `paper_before_revision.tex` 起跑；candidate rev 3 SHA 与 Guard 结果按上文记录；最终失败。
- 产品修复与测试提交见 §26–§27。Attempt 3 记录见 §27；由于 Attempt 3 已触发事实安全失败，不启动第四次验收。

## 26. M11.4.1 Controlled Existing-Paper Revision Scope（implementation checkpoint）

更新：2026-10-05。Attempt 1 / Attempt 2 结论和产物保持不变。以下记录 M11.4.1 产品实现与 Attempt 3 验收；Attempt 3 发现仍有 scope enforcement 缺陷，因此 **M11.4.1 implementation 未达到 COMPLETE，M11.4 继续 FAIL**。

- **Typed action / NO-OP dispatch**：`RevisionPlanItem.actionType` 增加 `modify | noop | author_decision_required | evidence_only`。`collectPlanDirectives` 只派发 planned 且可执行的条目；NO-OP 必须携带 `logicalSection`、原文 `coverageQuote` 和证据 IDs，并由系统核验 quote 确实存在于当前目标、证据状态有效、协议适用后，才写入 `already_satisfied` resolution trace。自然语言中的 “NO-OP / already covered” 不触发关闭。未通过核验时不调用 Writer，保留 unresolved trace 和 remaining issue。
- **Single-file logical targets / patches**：新增轻量 LaTeX heading / label 定位器；单文件 `main.tex` 的 section-level target 作为 Writer 输入。按当前 target 内容生成局部替换，apply 前重新解析目标并检查 SHA-256；目标内容已变化则 fail closed。Apply 后 scope guard 检查差异只能落在授权 span；同时检查 `\end{document}` 后是否新增内容，并在一轮开始时拒绝重叠 patch。Fact / Citation Preservation 仍独立运行。
- **Evidence protocol scope**：EvidenceRecord 支持 `{protocolId,status}`。来自明确命名来源 `fair_ablation_new_detector` 的 Evidence 标为 current；`old_coco_pretrained_detector` 标为 superseded。结构化实验数据和 fulltext grounding 均继承来源协议。Revision item 指定 `protocolId` 后，只有相同 protocol 且 status=current 的 Evidence 进入该 Writer 上下文；NO-OP 也执行同一适用性检查。
- **Comment outcome trace**：外部意见持久化 `resolutionTrace`，包含 comment / plan item / action / target / evidence / patch / verification / status / summary / remaining issue。修改项在实际 diff 后记录结果；后续 gate 同时核验 Fact 和 Citation Preservation，失败回退 unresolved，成功更新 trace verification。NO-OP 在 coverage + evidence verification 成功后进入 already_satisfied。
- **Regression coverage**：新增 scope/protocol fixtures 覆盖四 NO-OP + 一 MODIFY、RDK X3 的 baseline quote + verified Evidence、局部 subsection patch、摘要越界、范围内数字仍由 Fact Guard 判定、旧 COCO 协议拒绝、document end 后追加文本拒绝、overlap 检测及 Comment trace。该组测试证明纯机制边界；仍需真实 Attempt 3 验收实际成本、五条评论终态、Citation/Fact gate、PDF 与 held-out 对照。
- **验证**：backend `npm test -- --maxWorkers=1` — 216 files passed / 3 skipped；2393 passed / 15 skipped；backend typecheck/build PASS。frontend `npm test` — 280 passed；typecheck/build PASS（保留既有 >500 kB chunk warning）。`git diff --check` PASS，修复 commits 已 push 到 `origin/main`。
- **当前限制**：Attempt 3 暴露 scope guard 使用了 writer 后的文件作为比较基线；见下节。没有通过 Guard 的 Candidate Freeze、Revised PDF 或 Human Final 后验比较；没有读取 Human Final/change log用于生成。

## 27. M11.4 Real Acceptance Attempt 3 — FAIL

**项目与输入**

- Project `p-1fdaa03d9189`，Run `w-d4b399ef87e2`。输入为正确 pre-revision baseline `D:\PaperTeamData\M10.3-real-paper-case\manuscript\historical\paper_before_revision.tex`，项目导入为单文件 `main.tex`；baseline `contentHash=8e08f8fa9224a70d8dff972264a348b888f930c9b017e0d934a6eb4f55959849`。
- 5 条 comments 导入。Plan 6 项：4 MODIFY、Reviewer 1 文献数量要求 1 NO-OP、同一 Reviewer 1 comment 的主题文献缺口 1 author_decision_required。NO-OP 和 author-decision 子项均未派给 Writer。NO-OP trace 确认了原文 quote 与 E006；同一 comment 保留 `improvement:5` / `improvement:6`、E006、scope/evidence verification，并正确保持 unresolved（仍有作者决策）。
- 4 个 MODIFY patch 共调用 Writer 4 次，合计 10,859 input / 6,727 output tokens，成本估算 $0.05765。Run trace 截止停止时为 14 model turns、52,287 input / 11,710 output tokens、估算 $0.15192。费用是 provider list-price 估算。

**首轮 Candidate 与 Gate**

- rev 2 记录 4 个 patch；每条 trace 显示 `scope=true`、citation=true。Citation 核验 25 keys、missing=0、hallucinated=0、unverifiable=1。
- Fact Preservation **FAIL**：rev-1→rev-2 有 6 项结论方向漂移，Quality Gate 另报 1 条 revision-introduced unsupported claim。变化跨到训练策略、消融/轨迹稳定性和结论等未授权 section。Fact Guard 正确阻止不安全 Candidate 发布。
- RDK X3 的 E001 与 Reviewer 4 fair-ablation 的 E003/E005 按当前协议进入计划；没有发现旧 COCO protocol Evidence 被派给本轮 Writer。单文件逻辑 section patch 生效，但全局范围检查没有捕获工作区直接写入。
- Comment outcome：Reviewer 1 复合 comment 的 NO-OP + author decision trace 已正确聚合；其余 4 条修改 comment 均被整篇 revision 的 Fact FAIL 一起回退为 unresolved，并标记 `fact=false`。系统没有把具体失败归因到对应 patch。
- rev 2 不构成通过 Guard 的 Candidate Freeze；未生成 PaperTeam Revised Draft PDF。Human Final、作者回复和 change log 均未读取，held-out comparison 未执行。未进入 M11.5。

**根因与停止点**

- `backend/src/workflow/definitions.ts` 在调用 Writer 前读取 `fileBefore`，但 Writer Pi 会话持有项目 `write/edit` 工具。Apply 后重新读取 `latestFile`，并用 `checkRevisionScope(latestFile, candidate, latestSpan)` 做 scope check。若 Writer 已直接改写其他章节，这些变化已进入 `latestFile`，因而不出现在此处差分里；记录中的 `scope=true` 是假阳性。Fact Preservation 后续检测到 6 项方向漂移并挡住发布。
- `reverifyHandledInstructions` 使用全局 `factPreservation.ok` 将每条 handled comment 一并降级，没有基于 patch/target 的归因。这是 Comment outcome trace 的第二个剩余 blocker。
- Quality Gate 失败后 Workflow 已进入 bounded `revision.revise`。为避免再次调用 Writer，停止 Backend；未生成 rev 3。Attempt 3 判 FAIL，不做第四次真实验收。

**验证与 Git**

- Backend full tests：216 passed / 3 skipped files；2393 passed / 15 skipped tests。Backend typecheck/build PASS。Frontend full tests：280 passed；typecheck/build PASS（既有 Vite chunk warning）。
- 修复 commits `fa3fb9a`、`f5ad478`、`c9b4f55` 已 push。文档改动前 `HEAD == origin/main == c9b4f55d859cc8d2a692bb05a587e24220d9bb7c`，working tree clean。文档更新后的 diff check 与 Git 同步待本次收尾。

**Verdict**：M11.4.1 implementation **PARTIAL / FAIL**；M11.4 Product Acceptance **FAIL**。下一步 blocker 是以不可变 writer 前快照与最终文件计算全局 diff，并阻断/隔离 Writer 对项目文件的直接写入；同时实现 patch 级 Fact outcome attribution。不要降低 Guard、复用 Attempt 3 作为新生成项目或盲目重跑。

## 28. M11.4.2 Immutable Revision Boundary（engineering implementation）

状态：immutable revision boundary 实现完成；完整 M11.4.2 **尚未 COMPLETE**，等待补齐多 patch 同文件的 Citation attribution。Attempt 1–3 的历史事实不变；本阶段没有 Attempt 4，没有创建验收项目、Reviewer/Writer smoke 或调用 GLM。GLM calls = 0。

- **Attempt 3 根因修复**：此前 `latestFile` 是 Writer 调用后读取的，且被当成 scope diff 的 before，直接写入的其他章节因此从比较中消失。另一个问题是 handled comment 使用全局 Fact/Citation `ok` 回写状态，导致一个失败 patch 污染无关 comment。
- **Tool restriction**：Pi `createAgentSession` 使用已有 `tools` allowlist。Existing-paper scoped revision 现在通过 `toolPolicy: "read_only"` 创建单独 `writing/revision-proposal` 会话，只含 `read/grep/find/ls`，不含 `write/edit/apply_patch`。普通 `writing/revision` 仍保留原 Writer 权限，不影响新论文写作及其他 Writer 场景。该边界同时由 PaperTeam snapshot hash 检查兜底。
- **Immutable snapshot / apply**：每个 section patch 在调用前固定 `fileBefore` 全文和解析出的目标 span（含原文 SHA-256）。Writer 只返回 section proposal；系统以 `applyRevisionSpan(fileBefore, span, proposal)` 在内存构造 candidate。`checkGlobalRevisionScope(fileBefore, candidate, [span])` 对完整文件差异判定，而不是比较 Writer 后的 workspace。
- **Workspace integrity**：Writer 调用完成或抛错后立即读取文件。hash 不同则以 snapshot 恢复文件并返回 `DIRECT_WORKSPACE_MUTATION`，该 invocation 不进入 apply。Apply 前再次核对 baseline，失配 fail closed；确定性写盘后再读 `actualFinalFile`，要求其 SHA-256 等于 candidate，并对 immutable snapshot 再跑 global scope diff，否则恢复 snapshot 并拒绝。文档尾部内容仍由 source hygiene guard 拒绝。
- **Patch-level outcome**：scope 错误信息携带 patch hash 与 logical target。Gate reverify 按 resolutionTrace 的 file/section 与 Fact finding 的 file/section 做确定性匹配，只降级自身被命中的 comment；already_satisfied NO-OP 不参与 handled patch 回写。Citation Preservation 的文件级报告仅在该文件恰有一个 handled patch owner 时归因；多 patch 同文件时仍只阻断 Candidate，具体 Citation violation 未归属到 patch/comment。这一剩余缺口阻止 M11.4.2 COMPLETE。Candidate publish gate 的全局安全要求未降低。
- **Regression tests**：新增 6 个确定性用例：immutable global diff 捕获目标外变化、clean scoped diff / stale baseline、全文 hash direct mutation 检测、多个不重叠 patch、proposal-only Writer policy 且普通 Writer 保持默认权限、单个 comment patch Fact FAIL 不污染其他 handled / NO-OP。原有协议 current/superseded 覆盖继续通过；scripted runtime 同时识别 proposal-only revision scope。
- **验证**：backend 全量 `npm test -- --maxWorkers=1` — 216 files passed / 3 skipped；2399 passed / 15 skipped。最终 targeted revision/external-instruction/workflow 回归 — 5 files / 52 tests passed；backend typecheck/build PASS。Frontend — 27 files / 280 tests passed；typecheck/build PASS（既有 Vite >500 kB chunk warning）。`git diff --check` PASS。未执行任何真实 M11.4 acceptance，也未生成 Revised PDF。

**M11.4.2 implementation verdict**：PARTIAL — immutable boundary、Pi tool restriction、global scope diff、direct mutation recovery、stale baseline 与 Fact/comment isolation 已实现并通过测试；多 patch 同文件 Citation attribution 和完整 patch validation record 尚未实现。**M11.4 Product Acceptance** 仍为 FAIL / pending revalidation。停止点：`NOT_READY`。本阶段无 Attempt 4；补齐上述实现与回归后再由用户决定真实验收时间。
