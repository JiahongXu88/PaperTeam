# M11.4 Final Acceptance Report

**最新结论：FAIL — Attempt 5 在 `assessment.target` 连续遭遇 GLM request timeout，run 终态 `SYSTEM_FAILED`；未到达 Planner/Writer，故 M11.4 产品验收仍未完成。** Attempt 2 和 Attempt 4 的历史结论保留在下文；Attempt 5 未冻结 Candidate、未读取 Human Final/作者回复/change log/PDF，详见文末「Attempt 5 — Validation-Aware Final Blind Revalidation」。不启动 Attempt 6 或 M11.5。

更新：2026-10-05（Asia/Shanghai；Attempt 5）

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

状态：immutable revision boundary 实现完成；完整 M11.4.2 **尚未 COMPLETE**，还需补齐多 patch 同文件的 Citation attribution，以及 fake Writer 在 invocation 内直接写盘（scope 内/外）后恢复 workspace 的 workflow-level regression。
Attempt 1–3 的历史事实不变；本阶段没有 Attempt 4，没有创建验收项目、Reviewer/Writer smoke 或调用 GLM。GLM calls = 0。

- **Attempt 3 根因修复**：此前 `latestFile` 是 Writer 调用后读取的，且被当成 scope diff 的 before，直接写入的其他章节因此从比较中消失。另一个问题是 handled comment 使用全局 Fact/Citation `ok` 回写状态，导致一个失败 patch 污染无关 comment。
- **Tool restriction**：Pi `createAgentSession` 使用已有 `tools` allowlist。Existing-paper scoped revision 现在通过 `toolPolicy: "read_only"` 创建单独 `writing/revision-proposal` 会话，只含 `read/grep/find/ls`，不含 `write/edit/apply_patch`。普通 `writing/revision` 仍保留原 Writer 权限，不影响新论文写作及其他 Writer 场景。该边界同时由 PaperTeam snapshot hash 检查兜底。
- **Immutable snapshot / apply**：每个 section patch 在调用前固定 `fileBefore` 全文和解析出的目标 span（含原文 SHA-256）。Writer 只返回 section proposal；系统以 `applyRevisionSpan(fileBefore, span, proposal)` 在内存构造 candidate。`checkGlobalRevisionScope(fileBefore, candidate, [span])` 对完整文件差异判定，而不是比较 Writer 后的 workspace。
- **Workspace integrity**：Writer 调用完成或抛错后立即读取文件。hash 不同则以 snapshot 恢复文件并返回 `DIRECT_WORKSPACE_MUTATION`，该 invocation 不进入 apply。Apply 前再次核对 baseline，失配 fail closed；确定性写盘后再读 `actualFinalFile`，要求其 SHA-256 等于 candidate，并对 immutable snapshot 再跑 global scope diff，否则恢复 snapshot 并拒绝。文档尾部内容仍由 source hygiene guard 拒绝。当前测试分别验证 tool allowlist 和 hash 检测，但尚无 fake Writer 对 workspace 直接写入后验证恢复/拒绝的 workflow-level 回归，因此该恢复路径仍需用确定性集成 fixture 锁定。
- **Patch-level outcome**：scope 错误信息携带 patch hash 与 logical target。Gate reverify 按 resolutionTrace 的 file/section 与 Fact finding 的 file/section 做确定性匹配，只降级自身被命中的 comment；already_satisfied NO-OP 不参与 handled patch 回写。Citation Preservation 的文件级报告仅在该文件恰有一个 handled patch owner 时归因；多 patch 同文件时仍只阻断 Candidate，具体 Citation violation 未归属到 patch/comment。这一剩余缺口阻止 M11.4.2 COMPLETE。Candidate publish gate 的全局安全要求未降低。
- **Regression tests**：新增 6 个确定性用例：immutable global diff 捕获目标外变化、clean scoped diff / stale baseline、全文 hash direct mutation 检测、多个不重叠 patch、proposal-only Writer policy 且普通 Writer 保持默认权限、单个 comment patch Fact FAIL 不污染其他 handled / NO-OP。原有协议 current/superseded 覆盖继续通过；scripted runtime 同时识别 proposal-only revision scope。
- **验证**：backend 全量 `npm test -- --maxWorkers=1` — 216 files passed / 3 skipped；2399 passed / 15 skipped。最终 targeted revision/external-instruction/workflow 回归 — 5 files / 52 tests passed；backend typecheck/build PASS。Frontend — 27 files / 280 tests passed；typecheck/build PASS（既有 Vite >500 kB chunk warning）。`git diff --check` PASS。未执行任何真实 M11.4 acceptance，也未生成 Revised PDF。

**M11.4.2 implementation verdict**：PARTIAL — immutable boundary、Pi tool restriction、global scope diff、stale baseline 与 Fact/comment isolation 已实现并通过测试；需新增 direct-write recovery workflow regression、多 patch 同文件 Citation attribution 和完整 patch validation record。**M11.4 Product Acceptance** 仍为 FAIL / pending revalidation。停止点：`NOT_READY`。本阶段无 Attempt 4；补齐上述实现与回归后再由用户决定真实验收时间。

## 29. M11.4.3 Patch Validation & Workflow Boundary Closure

状态：**COMPLETE — READY_FOR_M11_4_ATTEMPT_4**。此前首次执行 M11.4.3 时只完成部分实现并报告 PARTIAL；本次从原 working tree 继续完成余项。未运行 Attempt 4、未创建真实论文验收项目、未调用真实 Reviewer/Writer 或 GLM；GLM calls = 0。M11.4 Product Acceptance 仍为 **FAIL / pending revalidation**。

- **Workflow direct mutation boundary**：使用真实 Existing Paper revision orchestration 与 deterministic fake Writer，覆盖 Conclusion 越界写盘、Datasets 授权区内直接写盘及 restore 失败。两个可恢复路径均检测 hash 变化、恢复 immutable Writer-before snapshot 并验证恢复后 SHA；拒绝返回 patch，revision 仍在原 rev-1、无 candidate freeze、comment 未被错误标记 handled。恢复失败抛出 `REVISION_WORKSPACE_RECOVERY_FAILED` 并停止 stage。direct mutation / recovery failure 是不可重试 contract failure，fake Writer 调用一次即停止。
- **Immutable scope baseline**：保留 snapshot→candidate global scope diff、stale baseline 与 `\end{document}` source hygiene guard；proposal scope 拒绝会持久化失败的 patch record（scope/apply/failedStage），不推进 candidate。既有 revision scope regression 证明 diff 依据 immutable input。
- **Citation attribution**：同文件多 patch 按 occurrence logical section / target span 映射，proposal citation key delta 用于 section 位移后的确定性归因；合法 added key 也留下 occurrence finding，删除 key 映射至原 occurrence。唯一命中记录 patchId / planItemId / commentId；未归因写入 `UNATTRIBUTED_CITATION_VIOLATION`，多重命中写入 `AMBIGUOUS_PATCH_ATTRIBUTION` 并阻断 publish。移除 file-owner fallback。Workflow 回归验证 Introduction missing cite 只令 Patch/Comment A 失败，Datasets Patch/Comment B 仍通过。
- **PatchValidationRecord**：每个实际 MODIFY patch 写入 `reviews/patch-validation-rev-{revision}.json`，按 revision 独立保存；记录 ID、target、evidence/protocol IDs、前后及 proposal hashes、scope、workspace recovery、Fact/Citation finding IDs 与 key deltas、Evidence recheck、apply 状态、overall 和 failure stage，不存论文全文。Writer direct mutation 与 scope reject 也保存失败 record；NO-OP / author decision 不制造 patch record。
- **Summary、comment 与 publish gate**：revision validation 将 Fact / Citation / Evidence 结果回填对应 records；`RevisionValidationSummary` 聚合 patch pass/fail 与 unattributed violation。Comment outcome 只消费自身关联 records；缺少 patch 归属的 candidate-level finding 不污染 sibling comment。NO-OP 保留既有 coverage/evidence trace。Quality Gate 消费 summary，并要求 patch、Fact、Citation、Evidence、现有 gate 与 Build 条件通过，publishable 才可为 true。
- **Test-first 与 targeted**：本轮新增确定性测试 10 个（两个新 test files），先运行失败的归因测试，再完成接线修复。最终重点 targeted：8 files / 159 tests passed；补充 Revision/Workflow/External Instructions/Fact/Citation/Evidence/Writer policy 回归 16 files / 256 tests passed。
- **Full regression**：Backend `npm test`：218 files passed / 3 skipped；2409 passed / 15 skipped。Frontend `npm test`：27 files / 280 passed。Backend 与 frontend typecheck、build 均 PASS；frontend build 有既有 Vite 大 chunk 提示。GLM calls = 0。
- **Git**：本次工程修复已提交并推送至 `origin/main`；最终 HEAD 与 `origin/main` 相同，working tree clean，`git diff --check` PASS。无 secrets、凭证、真实 fixture、生成 PDF、临时文件或依赖改动进入提交。

**M11.4.3 verdict**：**COMPLETE — READY_FOR_M11_4_ATTEMPT_4**。这不是 M11.4 Product Acceptance PASS；须另行进行 Attempt 4 真实重验证。本次按要求停止于此，不运行 Attempt 4，不开始 M11.5。

## 30. Attempt 4 — Final Real Revalidation

**日期：2026-10-05。Verdict: FAIL。** Attempt 4 在全新隔离项目中使用指定返修前论文和 5 条真实外审意见完成产品链路。Fact Preservation 与 Candidate Gate 正确拒绝了不安全修改；没有安全 Candidate Freeze、PaperTeam Revised Draft PDF 或 held-out Human Final 对照。不得启动 Attempt 5。

### 1. Verdict

Attempt 4 **FAIL**。硬门未通过：6 个真实 RevisionPatch 对应的 PatchValidationRecord 中 4 pass、2 fail；两条失败均为 Fact Preservation metric-direction flip。NO-OP 缺少可机器验证的 Evidence linkage，因此按 `NOOP_EVIDENCE_REQUIRED` 失败关闭；5 条外部评论全部保留 unresolved。Candidate 不可发布。额外的隔离限制：在候选冻结前，助手工具输出曾展示真实作者回复段落；该内容没有导入项目或提供给 GLM，但人的盲评隔离已受污染，故不能声称本次完全盲测。人工最终稿、change log、最终 PDF 未读取。

### 2. Git

开始时分支 `main`，working tree clean，`HEAD == origin/main == fe30db3c4af049d60a9e082d3f28db6155e28134`。本次仅更新本报告与 `docs/PROJECT_STATUS.md`；验证后提交并推送文档。最终 hash 与 clean 状态见本节完成后的 Git 验证记录。

### 3. Project / Run

全新隔离 Project `p-5a7c00eb2fc1`，Run `w-8a058823c601`。Attempt 4 未复用此前三个 Project。Run 因候选 gate 失败而取消收尾；随后通过 revision restore 将工作稿恢复到 baseline 内容，形成 revision 5。无 Attempt 5。

### 4. Baseline Integrity

基线是指定的 `manuscript/historical/paper_before_revision.tex`，SHA-256 `423CF0E0C66612AD7C801785D60F183367BCFDA5D46C1E32E1610B2F87E46D30`。与人工最终稿区分；本轮导入 Product 工作文件后 SHA 完全一致。配套导入原 bibliography 与 figures/assets；导入 API 接受 12 项且无 warning，baseline xelatex+bibtex build PASS。初始 citation 检查：25 keys，missing 0、hallucinated 0、unused 0、duplicate/bad/mismatched 0、unverifiable 1。返修拒绝后恢复稿 SHA 仍等于基线。

### 5. Generation vs Evaluation Isolation

返修生成链只接触返修前论文、解析后的真实外审意见、原 bibliography/figures/tables 和本地实验材料；人工最终稿、revision change log、最终 PDF 未打开，未进入 Planner、Writer、Reviewer、Evidence 或 Prompt。**例外：**在 Candidate Freeze 前，读取真实 `response_to_reviewers.md` 的工具输出时，助手看到了作者回复段落。回复没有作为 Project Source 上传，GLM 的运行 Source trace 未包含它（Writer accessed=none）；但人类评估者的知识隔离已经受影响。后续没有用该信息改写或重跑 Candidate，也没有打开其他 held-out 材料。

### 6. Comment Import

Parser batch 显示 5 个独立 comment blocks；5 parsed、5 imported、0 lost、0 duplicated。评论集合为 1 Editor + 4 Reviewers。导入输入仅包含 comment 摘要/问题，不包含作者回复文本。

### 7. Local Evidence

上传并接入 3 份指定报告、board_c0_20260904 与 fair_ablation 数据文件，以及 baseline Source，共 24 accepted Sources（9 个 `.log` 因扩展名白名单被拒；日志不是本轮必需的合法文本证据）。报告经 Source→structured/fulltext→chunks→EvidenceStore，未整篇塞入 Writer prompt。研究执行 8 queries / 7 executed / 1 web query failed（本地 SearXNG 不可用）；Semantic Scholar 限流。自动 `research.propose` 新增 0，`evidence.ground` 处理/验证 0。运行中按真实 Source chunk 建立 E001–E007；RDK X3 与两条 fair-ablation 数值记录均有来源锚点。物理实验材料存在，不构成实验缺口。

### 8. Revision Plan

Revision Plan 有 17 个最终条目，5/5 external comments linked。Plan 分出 modify、noop、author_decision_required 等 typed action，没有强迫所有评论 MODIFY。问题是 Evidence ID 没写入 `relatedEvidenceIds`：虽然部分 rationale 提及 E001/E002/E003，最后数组仍为空；三轮计划后仍如此。一个 Research 查询因本地检索服务不可用不影响 comment linkage，但降低了新增文献研究覆盖。

### 9. NO-OP / Author Decision

NO-OP 未调用 Writer。确定性 coverage/evidence/protocol verification 对缺少 `relatedEvidenceIds` 的条目返回 `NOOP_EVIDENCE_REQUIRED`，因此没有把评论伪标为 addressed。5 条外部 comment 最终都 unresolved。部分计划项提出作者对训练/损失实现歧义作决定；这是模型建议的科学决策问题，不是缺少物理实验，也未冒充外审评论完成。

### 10. Scoped Writer

Existing Paper Writer 实际 allowlist 为 `read/grep/find/ls`；无 `write/edit/apply_patch`。6 次 section-level revision proposal/apply invocation 使用局部 logical target 与必要上下文，由 PaperTeam deterministic apply。Writer invocation 期间 workspace hash 未变，direct mutation=0；未触发 recovery。`revision.revise` 有一次 stale target contract error，workflow 自动重试后成功，未重复绕过安全门。

### 11. Patch Validation Records

rev2 持久化 6/6 `PatchValidationRecord`，4 pass、2 fail。记录均覆盖 workspace integrity、scope、fact、citation、evidence、apply、overall。失败项 Fact 为 `metric_direction_flip`；summary fail-closed，`publishable=false`。summary 另记录 5 个 `UNATTRIBUTED_FACT_VIOLATION`，说明 Fact finding 到 patch/comment 的归因仍有缺口。rev3 验证阶段也持久化 6 条记录，其中 4 pass、2 fail；未进入可发布状态。

### 12. Scope Integrity

Writer 前 immutable whole-file snapshot 与最终文件作 global diff，`scopeOk=true`，outside-scope diff=0。Patch 的逻辑 section scope 验证通过；workspace hash 在 Writer 前后相同。该项真实验证了 M11.4.3 的直接写盘防御和全局范围检查。

### 13. Fact Preservation

**FAIL。** rev1→rev2 发现 6 项结论方向漂移，quality gate 同时发现 revision-introduced unsupported claim；rev3 bounded revision 后同类 metric-direction flip 仍存在，累计未经授权漂移仍被拒。Guard 没有降低，也没有通过不安全 Candidate。相同核心 Fact root cause 连续两轮无改善，按 bounded policy 停止 Writer 修订。

### 14. Citation Preservation

rev2 / rev3 Citation Preservation 均 PASS；missing=0、hallucinated=0，citation keys 仍为 25。rev2 citation verify 另有 unverifiable=1；rev3 为 unverifiable=4。没有因 unverifiable 将 missing/hallucinated 计数伪报为 0；报告保留该限制。多 patch 同文件的 attribution 路径实际执行，PatchValidation summary citation attribution 为 pass。

### 15. Evidence Protocol Integrity

fair_ablation_new_detector 的 A/B 比较作为 `current` protocol Evidence；旧 `old_coco_pretrained_detector` 明确标为 `superseded`。Planner 将 Reviewer 4 关联到当前 protocol；旧 COCO Evidence 没有作为当前 claim 支持材料提供给 Writer。Protocol scope gate 未见绕过。报告中 2 条 fair-ablation current evidence 与 1 条 superseded COCO 历史记录可区分。

### 16. Comment Outcomes

五条 external comment 最终状态：Editor unresolved；Reviewer 1 unresolved；Reviewer 2 unresolved；Reviewer 3 unresolved；Reviewer 4 unresolved。原因均为候选无法通过所需 closure/gates（包括 NO-OP Evidence linkage 缺失以及修改项 Fact validation fail）；系统没有把任一评论标成 addressed。独立 NO-OP 结果没有被其他 patch 的失败误判为成功。

### 17. Candidate Publish Gate

`PatchValidationSummary.publishable=false`，Fact FAIL，quality gate FAIL（blocking findings、unsupported claim、Fact drift、patch summary 等）。因此 Candidate Freeze 不允许、不曾发生；held-out ground truth 保持未读。没有把临时 revision 或 restored baseline 当作返修 Candidate。

### 18. Revised PDF

未生成 PaperTeam Revised Draft PDF。仅有 baseline import build 的 PDF/构建产物，不是 revised deliverable。Candidate 未 publishable，故不进行返修稿 PDF 交付或 PDF 视觉验收。

### 19. Held-Out Human Comparison

未执行，也不允许执行：没有安全 Candidate Freeze。人工最终稿、作者回复的其他部分、revision_change_log、人工最终 PDF 未读取。由于工具输出曾展示作者回复段落，人的 blind evaluation 已污染；未来若重做真实盲测，应在新评估环境中避免对该材料进行读取，且不得把它回灌本轮 Writer。

### 20. Cost / Runtime

Run trace：27 agent runs（4 researcher、7 reviewer、16 writer），73 assistant turns；input 154,177、output 43,365、cacheRead 794,432、cacheWrite 0。估算费用 `$0.61320612`（provider list-price 估算，不是实际账单）；聚合 task duration 2,308.9 秒，wall runtime 约 41 分 34 秒。成本高于理想的 scoped revision；主要是 research/reviewer 多轮与 16 次 Writer agent run，且三轮 Plan、bounded revise/review 反复运行。token 统计不等于 GLM 实际计费明细。

### 21. Pi Upstream Investigation

无证据指向 Pi Runtime / Pi 1.0.1 / provider SDK 的 upstream 问题；未创建或评论 Pi issue，也无 workaround。观察到的问题位于 PaperTeam 的 Planner/Writer 输出与 patch attribution；stale target 曾被 PaperTeam workflow 自动恢复。无需 Pi 调查。

### 22. Tests

Backend full suite：`npm --prefix backend test -- --testTimeout=30000`，218 files passed / 3 skipped，2409 passed / 15 skipped。Frontend `npm --prefix frontend test`：27 files、280 passed。Backend/frontend `npm run typecheck` 与 `npm run build` 均 PASS。早先默认 timeout full-suite 执行分别遇到一个 trace 间歇失败和一个 5 秒测试超时；对应单文件复跑通过，延长 timeout 后最终全量后端回归通过。Frontend 有既存 mock-query stderr warning；build 有既存 Vite >500 kB chunk warning。测试结果是本地代码回归，不会改变真实产品验收 FAIL。

### 23. Known Limitations

- Planner 未稳定把理由中提及的 Evidence IDs 填入机器可验证字段，NO-OP 无法闭环。
- Writer 在 scoped proposal 中仍输出造成方向事实漂移的内容，Fact Guard 正确挡住；bounded 第二轮没有改善。
- PatchValidationSummary 有未归因 Fact findings，需作为后续工程/产品 blocker 保留，不能降级 Gate。
- 自动 research/evidence grounding 本轮受本地搜索与学术服务限制；已提供的本地实验材料仍在 EvidenceStore。
- 人类评估者读取到作者回复段落，盲测隔离不完整；模型生成链未获得该内容。
- 无 publishable Candidate、Revised PDF 或 held-out comparison。

### 24. M11.4 Verdict

**M11.4 — FAIL。** 真实产品问题仍在：NO-OP Evidence linkage 不完整、Fact Preservation 连续拒绝 Writer 生成；同时 summary attribution 不完整。虽然 direct mutation、global scope、citation 与 protocol 门表现正确，不能抵消 Candidate 不可发布。没有降低 Guard、没有人工答案回灌、没有创建 Attempt 5。

### 25. M11.5 Closure Readiness

**NOT READY FOR M11.5 CLOSURE。** 不启动 M11.5。当前只记录少数 blocker：模型/Planner 结构化 Evidence linkage；Writer 对受保护事实的稳定 preservation；PatchValidationSummary 的 Fact finding attribution；以及评估者 blind isolation 的流程污染。应由后续明确授权的工作处理并安排新验收，当前不自动重跑。

## M11.4.4 Validation-Aware Revision Harness

**第一次 M11.4.4 实现检查点（策略/helper 部分完成）**：已将结构化 Planner repair 接入 `WriterService.planImprovement`，并在 `revision.apply` 中加入 scoped candidate validation、最多两次 patch-local Writer repair、失败记录与 fail-closed 路径。当时 held-out reader 尚未接入 acceptance reader/orchestrator，且 workflow regression matrix 不完整；故该检查点未标记 COMPLETE。第一次检查时的验证结果及历史结论保留如下。

- Attempt 4 root causes 保持 §30 原结论：Planner 缺结构化 Evidence linkage、Writer 出现 metric direction flip、Fact finding attribution 不完整；blind evaluation 因 freeze 前展示作者回复而污染。
- `revisionHarness.ts` 提供结构化字段动作契约、EvidenceStore membership/status/protocol 校验、窄字段 repair prompt、typed patch directive、预算/no-progress/escalation 决策、最终 patch 选择和 held-out reader。Planner 实际执行由 `WriterService.planImprovement` 校验并在最多 2 次结构化修复后拒绝；fact-changing item 必须链接 verified Evidence。
- `revision.apply` 对 scoped patch 候选运行 global scope、Fact 和未知 citation key 检查；失败只对当前 patch 重试，保留 root violation/attempt lineage，重复根因提前停止。候选不通过时不落盘，并将失败 validation 绑定到当前 revision，供 Gate fail closed。Revision Validation 保留失败 attempt 历史并按最终 patch record 汇总。
- Escalation 目前仅实现 provider/model agnostic deterministic policy；未接入任何 provider switching。没有配置 escalation model 时返回 exhausted；真实强模型调用数为 0。
- Held-out reader 通过 manifest 中 `heldOutPaths` 与 Candidate Freeze 时间戳实施路径级读取限制并检查 realpath containment；但仓库尚无 acceptance reader/orchestrator 接入此 API，因此端到端执行代理隔离未证实。
- workflow/Writer 单测覆盖 direction flip fail-closed、有界 retry、Citation candidate rejection、Planner missing Evidence repair、E999/superseded reject 与两次耗尽；policy tests 覆盖 escalation 禁用/启用、no-progress、final patch 选择、held-out freeze predicate。仍缺部分 unsupported/protocol/NO-OP isolation 与 Candidate Freeze acceptance integration tests。
- 验证：Backend full（4 workers）220 passed / 3 skipped，2422 passed / 15 skipped；Frontend 280 passed；backend/frontend typecheck 与 build 通过。默认高并行 backend run 曾有 2 项超时/trace 失败，重跑 4 workers 全绿；相应取消和 trace 文件独立重跑通过。GLM calls = 0；未运行 Attempt 5；未创建真实论文验收 Project；未调用真实 Reviewer/Writer；未调查 Pi upstream（当前无 evidence 指向 Pi）。尚未 commit/push。
- 第一次检查点结论：**NOT_READY**。当时 `revision.apply` 在成功 repair 后仍因最后一条 attempt 是 initial FAIL 而提前 `continue`；此真实断点在本次 continuation 中复现并修复。

**Continuation — Repair Promotion & Revalidation Closure（仍属 M11.4.4，没有创建 M11.4.5）**

- 根因：Writer repair response 已更新局部 `result`，validators 也运行在安全的 `fileBefore` 和不可变 revision snapshot 上；但成功后 promotion 前的分支只看历史 `finalAttempt.overall === "fail"`，未看 `acceptedAttempt`，因此丢掉通过的修复候选，且没有新 accepted record。修复后只在没有通过的 attempt 时 fail closed；成功 attempt 继续落盘并创建独立 patch version。
- lineage：`P.a0` 初次失败、`P.a1/a2` repair 分别保存；包含 parent attempt、repair finding IDs、root violations、model role 和 final status。attempt history 保留 initial FAIL；summary 以通过的 accepted version 为 final、按 logical lineage 计数，并另列 attempt、repair success/exhaustion。Comment validation 同样选 lineage 最终通过记录。
- workflow E2E：Fake Writer 首次输出 metric direction flip 和 unsupported numeric claim，Fact Guard FAIL；targeted repair 恢复方向并移除无支持细节，attempt 1 完整验证 PASS，Comment handled，Candidate patch summary publishable。Initial FAIL 与 Repair PASS 两条记录均留存。Citation hallucination 删除 invalid key 后 repair attempt PASS。持续错误 repair 在第二次相同输出/根因时 bounded no-progress；promotion artifact 保存失败会恢复 baseline 并 fail loud 为 `REPAIR_PIPELINE_ERROR`。
- Planner：结构化输出在 `WriterService.planImprovement` 实际链路进行 bounded repair；Evidence 缺链可修复，unknown/superseded Evidence 被拒绝。修复响应只更新初次失败字段；合法项 action、comment linkage、intent 和 target 从原始 plan 继承。超过预算以 `MODEL_REPAIR_EXHAUSTED` 停止，不继续 Writer。
- Acceptance read boundary：新增 `AcceptanceEvaluationReader` 作为 fixture/acceptance 专用读取入口，封装 generation read、held-out read 和 freeze。Freeze 前 human final/author response、change log、final PDF 拒绝；共享 response 文件仅解析并返回 Editor/Reviewer blocks，作者回复段落不会返回；Candidate gate 不 publishable 时拒绝 freeze，freeze 后 evaluation reader 才允许读取 held-out。该路径不改全局文件权限，也未执行真实 acceptance attempt。
- Gate / provider：所有 repair 候选仍需 scope、Fact、Citation、Evidence 检查并成功 apply 才能被接纳；未降低 Candidate Gate。默认不自动换模型/provider；无 escalation model 时 bounded exhausted。GLM calls = 0，未运行 Attempt 5、未创建真实论文项目、未调用真实 Reviewer/Writer、未进入 M11.5，未调查 Pi upstream。
- Targeted 终验：workflow patch repair / Citation / Fact、Planner、PatchValidation summary、Held-out reader 和 model routing 回归通过；核心 metric direction → targeted repair → PASS workflow E2E 同时断言 initial fail history、repair pass record、summary final version、logical vs attempt count、Comment handled。Promotion error rollback/classification 和 no-progress 亦有回归。
- 全量终验：backend `npm test -- --testTimeout=30000 --maxWorkers=4` — 220 files passed / 3 skipped，2425 passed / 15 skipped；frontend `npm test` — 27 files / 280 passed；root `npm run typecheck`、`npm run build` 均 PASS。Frontend build 有既存 Vite >500 kB chunk warning。`git diff --check` PASS。无 GLM/provider 调用。实现 commit `223b979`（`feat(revision): complete validation-aware repair harness`）已推送 `origin/main`；文档闭环记录随后的 docs commit 推送后再次确认 HEAD == origin/main 且 working tree clean。M11.4 Product Acceptance 仍为 **FAIL / pending Attempt 5**；本次只将实现状态标为 COMPLETE 与 READY_FOR_M11_4_ATTEMPT_5，不代表真实产品验收通过。

## Attempt 5 — Validation-Aware Final Blind Revalidation

**日期：2026-10-05。Verdict: FAIL / `SYSTEM_FAILED`。** Attempt 5 使用了新的隔离项目和正确返修前 baseline；blind path gate、真实评论解析/导入、真实 Source ingestion、baseline build、citation audit 与真实 GLM 审稿均通过。但 GLM-5.3 的 `assessment.target` 调用先后发生 300 秒 execution timeout 和 `Request timed out`，workflow 的两次 stage 尝试均失败，run 以 `AGENT_RUN_FAILED` 结束。流程未到达 Planner、Writer 或 Patch Harness，因此不能回答 Harness 是否能在真实 Writer 首次出错后完成安全修复。停止真实实验；不启动 Attempt 6 或 M11.5。

### Git / 隔离项目

- 开始时：`main`，`HEAD == origin/main == 518141e157e2918327c8bbf02ae47d4d4571471c`，working tree clean。
- 盲评 reader 的真实中文标题兼容缺陷在导入评论前暴露并修复：commit `f0c237f1441ae32f8c26e9064cdd4f05eb6161bb`，已推送 `origin/main`。新测试覆盖中文 Editor/Reviewer 标题及作者回复截断。
- 新项目：`p-f52b496cb6f3`；唯一 workflow run：`w-4c0cc322d84a`。项目和运行产物位于 `D:\PaperTeamData\M11.4-attempt5`，未使用 Attempt 1–4 的 Project。Run baseline SHA 与起始 SHA 一致。

### Baseline / Comments / Blind Gate

- Existing Paper baseline：`D:\PaperTeamData\M10.3-real-paper-case\manuscript\historical\paper_before_revision.tex`，SHA256 `423CF0E0C66612AD7C801785D60F183367BCFDA5D46C1E32E1610B2F87E46D30`。导入的是该文件副本，入口 `paper.tex`；含原始 `refs.bib` 与 10 个 PDF figures，共 12 个工程文件。真实 `xelatex+bibtex` baseline build PASS，26 页，0 import warnings。没有使用 `manuscript/source/paper.tex`。
- 返修前稿引用审计：25 个已引用 bibliography keys，`missing=0`、`hallucinated=0`。这是 baseline audit；Candidate 的 Citation Preservation 未运行。
- 评论经 `AcceptanceEvaluationReader.readReviewerComments()` 解析后才进入 Project：1 Editor + 4 Reviewer，5 parsed / 5 imported / 0 lost / 0 duplicated。评论 IDs 与历史 fixture 一致。Author response 没有作为 Source、指令或 prompt 输入。
- Candidate Freeze 前实际调用 path gate：人工最终稿、共享回复信原文件、`revision_change_log.md`、最终 PDF 四条直接读取均返回 `HELD_OUT_ACCESS_BLOCKED`；回复信的 comment-only reader 只返回 5 个评论块，不返回作者回复。未读取 Human Final、作者回复、change log 或 final PDF 的内容。没有 Candidate Freeze，因此也没有进入 held-out evaluation reader。

### Evidence / Workflow 进度

- 指定的 3 份实验报告及 `board_c0_20260904`、`fair_ablation` 数据共 23 个 Source 全部上传成功；23/23 有 structured document 与 blocks/chunks（合计 6,541 blocks），无整份报告直接塞给 Writer。Source role 为 `evidence`。
- 真实 run 完成 `import.parse`、`import.baseline_build`、`import.inventory`、`import.baseline`、`import.understand`、`citation.verify`、`review.run`；Review 三路完成，记录 23 findings。Citation 阶段报告 25 cited、0 missing、0 hallucinated。
- `assessment.target` 第一次调用：300,017 ms 后 `timed_out`，0 input/output token；workflow 启动配置内的第二次 stage 尝试。第二次调用以 `Request timed out` 失败，177,219 ms，0 input/output token。无 HTTP 402、insufficient balance、quota/billing exhausted 信号；timeout 不记作 quota exhaustion。
- `research.plan`、`plan.improvement`、`revision.apply` 均未执行；EvidenceStore 中没有 EvidenceRecord。因此 current fair-ablation / superseded old-COCO 的 Evidence protocol 尚未经过本 run 的 Planner/Harness 校验。不得将 Source ingestion 描述为 Evidence protocol PASS。

### Patch / Candidate / Held-Out 结果

| 指标 | Attempt 5 结果 |
|---|---|
| Planner first-pass valid rate / structured repairs | N/A：未到达 Planner；repair 0 |
| Logical patches / first-pass patch pass | N/A：Writer 未运行 |
| Targeted repair attempts / successes / exhausted | 0 / 0 / 0（Harness 未运行；成功率 N/A） |
| `metric_direction_flip` / Harness 修复成功 | 0 / 0（未运行） |
| unsupported claim / Citation repair | 0 / 0（未运行） |
| repair pipeline errors / unattributed violations | 0 / 0（未运行） |
| final accepted patches | 0；无 logical patch |
| direct workspace mutation / outside-scope diff | 0 observed；patch stage 未执行，故这两项未实证 |
| Fact Preservation | N/A：无 Candidate |
| Citation Preservation | N/A：无 Candidate；baseline missing/hallucinated 均为 0 |
| Comment outcomes | 5 条均 pending；workflow failure 前无 outcome，不伪标 addressed |
| Candidate publishable / freeze | false / 未冻结 |
| PaperTeam Revised PDF | 未生成 |
| held-out Human comparison | 未执行；没有 FULL/PARTIAL/DIFFERENT_BUT_REASONABLE/MISS 评级 |
| author experiment / decision | 本次未到达 Planner，不能作完整判定；输入材料已存在，不因本次 timeout 推断需补实验 |

### Usage / Regression / Final State

- Model：`Z.AI / zai/glm-5.3 / general_api`，沿用已保存的个人 Key；未切 provider/model/channel，也未输出凭据。
- Run trace：52,757 input tokens、8,684 output tokens、50,368 cache-read、18 assistant turns；估算 `$0.12516508`（provider list-price 估值，不是账单）；wall duration 678,757 ms（11 分 18.8 秒）。
- Quota exhaustion：**NO**。Pi upstream：没有证据显示是 Pi 1.0.1 产品缺陷；未提交 upstream issue。
- Full regression：Backend `npm test -- --testTimeout=30000 --maxWorkers=4` — 220 files passed / 3 skipped，2,426 passed / 15 skipped；Frontend `npm test` — 27 files、280 passed；root `npm run typecheck` 与 `npm run build` PASS。Build 有既存 Vite >500 kB chunk warning；tests 有既存 query/jsdom stderr warning。
- Attempt 5 结论：**M11.4 — FAIL / NOT_READY_FOR_M11_5**，唯一 blocker 为真实 run 在 `assessment.target` 两次 Provider request timeout（`SYSTEM_FAILED`）。没有将其混归为模型科学能力限制、额度耗尽或 Evidence Gap；不启动 Attempt 6。代码修复 commit 已推送；本报告及 `docs/PROJECT_STATUS.md` 随本次验收记录更新。
- M11.5 未启动；`READY_FOR_M11_5_CLOSURE`：**false**。
