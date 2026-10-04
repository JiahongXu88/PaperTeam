# M11.4 Preparation — Existing Paper Revision Product Acceptance Plan

日期：2026-10-04　执行人：Claude（GLM-5.3）　性质：**只读审计 + fixture 发现 + 验收设计**（零产品代码修改；M11.3 PASS 后的准备工作）

---

## 1. Current Capability（现有能力盘点，只读审计）

Existing Paper（`existing_paper_improvement` workflow + PDF Review Foundation）当前已具备：

| 环节 | 现状 | 证据 |
|---|---|---|
| ingestion | PDF 解析（PaperParser）+ 单文件 LaTeX 导入（LatexImporter，M10.3 按 \section 切块防截断失明） | `paper/PdfParser` / `import/` |
| paper import | `/api/projects/:id/import`（PDF）+ latex-import 路径 | httpServer |
| **reviewer comments** | ExternalInstructions（M5.7）：journal_reviewer/editor/advisor/user 四来源、逐字保存、确定性状态机（pending→handled/conflict/unresolved + gate 复核闭环）、HTTP CRUD | `review/externalInstructions.ts` + `/external-instructions` 端点 |
| manual revision feedback | 同上（source=user 的用户手工意见；与外审意见同一 mandatory 通道） | 同上 |
| finding dispatch | 分节 review（SectionReviewScheduler 并发 + 覆盖诊断 M10.4.4 heading 层匹配）→ 确定性 RevisionPlan（外部意见 mandatory 优先于内部建议） | `paper/SectionReview*` / `review/revisionPlan.ts` |
| revision plan | 计划 schema 断言 + 条目状态机 + rejectedItems（M9.10） | 同上 |
| fact preservation | **累计口径**（冻结基线 + 授权台账 + carry-forward + 确定性恢复 restore_facts，M10.3.1） | `quality/cumulativeFactPreservation.ts` |
| citation preservation | 修订前后 \cite 多重集比对 + 授权通道 | `quality/citationPreservation.ts` |
| quality gate | 双 gate（quality + build）+ claim 适用性审计（pre-existing / 作者数据覆盖 / 修订引入，M10.3.1 G2） | `review/claimGapAudit.ts` |
| PDF | xelatex+bibtex 显式编排 + 编译诊断 + Draft/Final 冻结 | `latex/` / `artifacts/` |
| 真实 E2E 底子 | M10.3 真实案例 15/18 条目 verified（24 verified 证据 / 引用 26 零删 / PDF 29 页 / $10.11）；M10.3.1 G1/G2 + M10.4.x 性能与覆盖加固 | 各 M10 报告 |

## 2. Known Gaps（产品级真实验收缺口）

1. **评论批量导入缺失**：ExternalInstructions 只有逐条 POST——真实审稿意见是一份结构化文档（多位 reviewer × 多条 comment + 页码引用），当前需人工逐条转录；「Comment Parsing」（把 response letter / 审稿文件解析为带 provenance 的 instruction 条目）在产品层**没有入口**（M11.4 验收链 §55 的第一步就是它）；
2. **官方意见的优先级语义未在真实文档级验证**：单条 mandatory 优先已有测试；但「整份真实审稿意见 × 内部 Reviewer 建议」的规模冲突（几十条 vs 内部发现）从未在真实 fixture 上跑过；
3. **Response/Change Trace 的成文输出**：条目级状态机完整，但「给期刊的逐条回复信」级产物（作者真实答复 vs 系统修订 trace 的对齐文档）没有生成物——M10.3 只做到内部 trace；
4. **Experiment Gate 不存在**（任务书 §45 已明确不属 M11.3/M11.4——审稿意见中的「补实验」类要求只能走 CONFLICT/作者决策，本验收不试图自动化）；
5. **评论-位置锚定**：ExternalInstructions 无页码/章节结构化字段（原文逐字保存了，但定位到稿件位置靠人工填 section 或模型推断）。

## 3. Real Acceptance Fixture（真实验收输入包）

**已发现且就绪：`D:\PaperTeamData\M10.3-real-paper-case\`**（M10.3 输入包，SHA 登记于 MANIFEST.json，2026-09-29 冻结）：

| 要素 | 内容 |
|---|---|
| 主稿 | `manuscript/source/paper.tex`（CEA 投稿冻结版 v1，26 页 PDF 同包）+ refs.bib（25 条）+ figs（10 PDF 全解析） |
| **真实审稿意见（第一轮）** | `feedback/response_to_reviewers.md`（真实外审意见 + 作者真实逐条回复）+ `response_submission_system_text.txt` + `response_letter_submitted.pdf`（已提交回复信原件） |
| 修订真相 | `feedback/revision_change_log.md`（作者实际改动清单 = 可对照的 ground truth） |
| 实验上下文 | `experiments/` + `context/historical-phase-reports/`（补实验类意见的处置依据） |
| 边界 | **第二轮审稿意见磁盘无记录，不得虚构**（M10.3 已登记）；验收以第一轮意见为输入 |

该 fixture 完整覆盖 M11.4 验收输入要求（真实论文 + 官方意见 + 修订 ground truth），**无需从互联网下载任何东西**。

## 4. Acceptance Criteria（验收标准设计）

主链（任务书 §55）：

Existing Paper + Reviewer Comments → Comment Parsing → Finding Priority → Revision Plan → Revision → Fact Preservation → Citation Preservation → **Response / Change Trace** → Review → Gate → Revised PDF

| # | 验收项 | 判据（草案） |
|---|---|---|
| A1 | 意见导入 | 真实 response_to_reviewers.md 解析为 instruction 条目：逐字保真（sourceText 可回溯原文）、reviewer 归属、零丢条（意见条数对账） |
| A2 | 优先级 | 每条官方意见在计划中 mandatory 且先于内部建议派发；与内部建议冲突时保留官方诉求并如实报 CONFLICT |
| A3 | 修订安全 | 累计 Fact/Citation Preservation 全程通过（或授权台账覆盖全部 delta）；冻结基线的实验事实零漂移 |
| A4 | 修订质量 | Gate 语义与 M11.3 一致（诚实终态可接受：PASS / QUALITY_NOT_REACHED / NO_PROGRESS） |
| A5 | Response Trace | 每个 instruction 条目 → 修订 diff → （若实施）回复要点 的三方对齐文档；未实施条目如实标注（CONFLICT / 作者决策 / 补实验类） |
| A6 | PDF | 修订 PDF 可编译、引用零幻觉、与 change_log 的方向性一致（不要求逐字重合作者原改） |
| A7 | 对照 ground truth | 系统修订方向 vs 作者 revision_change_log 的重合度报告（描述性指标，不做硬门） |

**特别红线**（§55 末句）：用户手动输入 / Reviewer 官方意见的优先级**必须**高于内部 Reviewer 建议——A2 为硬门。

## 5. Expected Work（预计工作量，按依赖排序）

1. **Comment Parsing 入口**（最大缺口）：`feedback/` 文档 → instruction 条目的解析服务（结构切分 + provenance 保真 + 人工确认 HITL；不做全自动静默导入）+ 前端批量导入 UI（最小：文件上传 + 预览确认）；
2. **Response / Change Trace 产物**：instruction×revision×response 三方对齐文档生成（确定性投影，无新 LLM 判定）；
3. 评论条目的位置锚定字段（可选，降低派发盲区）；
4. 验收驱动脚本 + 上述 A1–A7 判据的自动核对；
5. （后置）Experiment Gate 的 HITL 表达——补实验类意见的显式「作者决策」终态呈现（M11.3 的 AUTHOR_DECISION_REQUIRED 语义直接复用）。

## 6. No-Go Decisions（本阶段不做 / 需作者裁决）

- **不自动执行补实验**（审稿意见的实验类要求只走 CONFLICT / 作者决策——数据与算力属于作者）；
- **不从互联网获取任何 fixture**（已有真实包）；
- **不改 M11.3 刚冻结的 survey 链路**（Existing Paper 与 Survey 共享的尾部机制——gate 语义 / resolution ladder——若 M11.4 需要差异行为，走配置或独立分支，不回改 survey 口径）；
- **第二轮审稿意见不存在**：验收以第一轮为准；如作者后续提供第二轮材料，可作为加测样本而非基线。

---
*本文件是 M11.4 的开工提案；实施前需作者对 §5 工作量与 §6 裁决项确认。M11.3 交接状态见 [M11_3_SURVEY_PRODUCT_ACCEPTANCE.md](M11_3_SURVEY_PRODUCT_ACCEPTANCE.md)。*
