# M15 Target Journal Assessment — 验收报告

- 日期：2026-11-02 · 执行：Claude（Opus 5.5）· 基线 `7f133ee` → 本轮提交见 §9
- 验收合同 + 评测协议在任何外部评测与模型运行**之前**冻结：`D:\PaperTeamData\M15\TargetJournalAssessment\PROTOCOL.md`（sha256 `6a86bc3e7157ae8bb099565a53639790f302ef721cb2b56618d8602f9b6c197a`）；偏差追加在 `DEVIATIONS.md`（2 条，均发生在对应模型调用之前）
- 证据目录：`D:\PaperTeamData\M15\TargetJournalAssessment\`（`runlog.txt` append-only；`budget/calls.jsonl` 逐次调用账本）

> **最终状态：TARGET_JOURNAL_ENGINEERING_COMPLETE_EXTERNAL_VALIDITY_LIMITED**（理由见 §8）

## 1. 交付的产品能力
项目页「目标投稿」→「目标期刊评估」：选择期刊（内置 中国图象图形学报 / PLOS ONE）与文章类型 → 生成评估 → 四块可展开报告 → 逐条把可改写条目转入修改意见队列（随后走既有修订计划与 EditContract）。API 与 UI 同源（`journal-assessment/v1`），设计见 `M15_TARGET_JOURNAL_ASSESSMENT_ARCHITECTURE.md`。

| 实际支持 | 范围 |
|---|---|
| 期刊 | 2 个内置官方 profile（CJIG 16 条规则、PLOS ONE 10 条）；其他期刊 → `JOURNAL_PROFILE_UNVERIFIED`（不编造规则） |
| 稿型 | research / survey / systematic_review / dataset / code / protocol；受理关系逐刊取自官方页面，未写明 = 未知 |
| 稿件格式 | LaTeX 源码（全部检查器）；PDF-only（只有参考文献类，其余 NOT_EVALUATED）；图像像素、编译后版式、投稿系统字段一律不检查 |

## 2. G0–G7

| 门 | 结论 | 证据 |
|---|---|---|
| G0 原始目标 / 基线 / 可用性 | **PASS** | 开工 HEAD = origin/main = ls-remote = `7f133ee`，clean；交接文档已读；源码审计与 7 个第三方项目许可矩阵见研究报告 §1–§2 |
| G1 期刊规则来源可靠 | **PASS** | 2 个 profile 共 42 条原句；快照回放 CJIG 25/25、PLOS 17/17（`G1/replay-snapshot.json`）；在线复核 CJIG 25/25 VERIFIED_LIVE（两页与快照逐字节一致），PLOS 2 页网络失败 → 如实 UNREACHABLE（`G1/replay-live.json`）；单测证明 STALE / SOURCE_CHANGED / UNREACHABLE / 用户提供 fail-closed |
| G2 目标质量评估可用 | **PASS** | 5 个 API + 版本化工件 + UI；浏览器 E2E 3/3（`m15-target-journal.spec.ts`）；2 条真实运行均在真实栈 UI 中可打开（`ui-evidence/real-*.png`） |
| G3 与 Gate / Revision 正确集成 | **PASS** | 不产生任何 `passed`（HTTP 测试断言）；L1 FAIL + 模型全 STRONG 仍 BLOCKED（单测）；转入只经 `target_journal` 意见（priority high，低于真人）；评估后改稿 → 409（单测 + HTTP + 浏览器 J3）；既有分层报告 / 数值修改逐项批准 E2E 2/2 回归通过 |
| G4 外部参考验证诚实 | **PARTIAL**（有界执行，非校准） | D1 零模型 23 篇真实 CJIG 已发表论文；D2 CoCoReviewBench 12 篇真实审稿意见；D3 SurveyReview 8 篇真实审稿报告分数；D4 ReviseBench 许可缺失 → DATA_BLOCKED。中文期刊人工质量标签 = 0 → 无期刊级校准 |
| G5 受控模型与负例 | **PASS** | 付费调用 45/80、真实 E2E 2/2（§6）；负例全部 fail-closed（§4） |
| G6 工程回归 | **PASS**（见 §7 已知项） | 后端全量、前端 380/380、双端 typecheck / build、`git diff --check`、19 个浏览器 E2E；CI / Linux Integration 见 §9 |
| G7 Git 与透明交付 | 见 §9 | |

## 3. 真实运行（2 条，均为已有真实产物的只读副本；冻结源目录未写入）

| 运行 | 项目（副本） | 期刊 × 稿型 | 模型调用 | 结论 | 核验 |
|---|---|---|---|---|---|
| E2E-1 smoke | M15 长程真实运行项目（Attention 论文 PDF 导入重建的 LaTeX；真实 quality-gate r2） | PLOS ONE × 研究论文 | 1 | 首次：BLOCKED（缺 Acknowledgments） | **人工核实为检查器根因缺陷**：PDF 重建稿把 “Acknowledgements” 渲染为普通文本行（`sec19.tex:23`）。按合同第 1 次纠偏：识别独立成行标题并注明（回归测试含「正文句子不误判」反例）。零模型重放 → **INSUFFICIENT_EVIDENCE**（该项目质量门禁本身有必需未评估项：L1 跨节数值一致性 / 矛盾证据、L2 claim 级核验）——诚实结果 |
| E2E-2 冻结验证 | M15.9 中文综述合规对照稿（b1c） | CJIG × 综述 | 1 | **BLOCKED_BY_VERIFIED_ISSUE**：未检出中图分类号 | 人工 grep 核实稿件首页确无「中图分类号」；官方原句「首页页眉处请提供中图法分类号」；其余 11 条可判要求全部满足；稿型匹配「学者观点 / 前沿进展（小综述）」；近期 24 篇 CJIG 参照只作 POSITIVE_ONLY_REFERENCE；无质量门禁 → B 块如实未评估 |

第 2 次纠偏未使用。另做 1 处纯展示修改（C 块参照摘要截断），不影响任何判定。

## 4. 负例与 fail-closed（G5）

| 负例 | 结果 | 证据 |
|---|---|---|
| 官方原句消失（规则版本错误 / 页面变化） | 该条 NOT_EVALUATED + 结论 JOURNAL_PROFILE_UNVERIFIED | 单测 |
| 快照超 TTL | STALE → JOURNAL_PROFILE_UNVERIFIED | 单测 |
| 官方页面不可达 | UNREACHABLE，不升级为在线验证 | 单测 + 真实在线复核（PLOS 2 页） |
| 未知期刊 / 同名歧义 | UNVERIFIED，A 块为空 / 409 | 单测 |
| 缺图表 / 图表未读取像素 | 图表质量 `unassessed`，dpi / 三线表 author-check | 单测 + E2E-1 |
| 研究论文无任何图表 | author-check 风险（不判定为缺实验） | E2E-1 |
| 无稿件 / PDF-only | 格式类 NOT_EVALUATED → INSUFFICIENT_EVIDENCE | 单测 |
| 无 / 陈旧 / 必需未评估的质量门禁 | INSUFFICIENT_EVIDENCE | 单测 + E2E-1 |
| 跨稿型：叙述性综述 → PLOS ONE | 稿型 VERIFIED_MISMATCH → BLOCKED | 单测 + 浏览器 J2 |
| 跨语言：中文稿 → PLOS ONE | 语言 VERIFIED_MISMATCH → BLOCKED | 单测 + 浏览器 J2 |
| 官方未写明的稿型（CJIG 系统综述） | NOT_EVALUATED → INSUFFICIENT_EVIDENCE | 单测 |
| 不可改写条目转入修订 / 评估后改稿再转入 | skipped / 409 | 单测 + HTTP + 浏览器 J3 |
| M15.9 冻结变异族（题目 22 字 / 关键词 3 / 陈旧文献 / 非结构化摘要 / 文献 12 条） | 5/5 检出；合规对照 0 变异类误报 | `G5/mutation-families.json` |

## 5. 外部参考评测（G4，均按冻结协议只跑一次）

### D1 CJIG 已发表论文正向参照（零模型，N = 23）
| 规则 | SATISFIED | VIOLATED | NOT_EVALUATED |
|---|---|---|---|
| 参考文献 ≥ 15 | 20 | 0 | 3（新格式 DOI 论文未识别参考文献章节） |
| 近 10 年 ≥ 60% | 19 | 1 | 3 |
| 全部提供 DOI | 1 | 0 | 22（PDF 上「未识别」≠「未提供」） |
| 稿型受理 | 23 | 0 | 0 |

唯一 VIOLATED（10.11834/jig.260112，20/43 = 47%）逐条核对：抽取年份与原文一致（含 1943 / 1950 等经典文献），**非检查器误报**，是编辑部未严格执行或稿型为观点类——已发表论文不当负例，未据此调阈值。

### D2 CoCoReviewBench 已知参考类别召回（ICLR 2025，N = 12 篇，每篇平均 6.5 个人类缺陷类别）
| 指标 | A 单次 LLM | B 证据约束结构化（PaperTeam rubric 纪律） |
|---|---|---|
| 类别召回（均值，bootstrap 95% CI） | 0.711 [0.636, 0.786] | 0.651 [0.546, 0.762] |
| B − A | — | −0.060 [−0.134, +0.025]（跨 0） |
| 只计引文可定位条目的召回 | — | 0.632 [0.517, 0.751] |
| 引文确定性定位率 | — | 94.0% |
| 输入 / 输出 token | 138,836 / 7,158 | 139,020 / 14,776 |

人类参考 = 审稿人 weaknesses 段中未被冲突 / 反驳校验判为 incorrect 的意见（类别由原作者用 LLM 标注）；不报告 precision（人类未提及 ≠ 误报）。结论：证据约束**没有**提高召回（点估计略低、不显著），代价是约 2× 输出；收益是 94% 的问题可在原文中定位、可复核。（ii）PaperTeam 既有多 Agent Reviewer 未运行（超预算）→ NOT_EVALUATED。

### D3 SurveyReview 四维质量对齐（test split，N = 8 篇、25 个有参考分的维度）
| 指标 | A 官方四维指南 | B 指南 + 证据纪律 |
|---|---|---|
| MAE（{-2,-1,1,2}） | 1.84 [1.52, 2.16] | 1.88 [1.44, 2.24] |
| 符号一致率 | 0.24 [0.08, 0.44] | 0.28 [0.12, 0.48] |
| 人类判为负的维度中模型也判负 | 2/21（9.5%） | 3/21（14.3%） |
| 预测均值 vs 参考均值 | +1.00 vs −0.84 | +1.04 vs −0.84 |
| 引文定位率 | — | 74% |

结论：模型主观打分**系统性偏宽松**，几乎识别不出人类审稿人指出问题的维度。样本偏差：参考分来自审稿报告（报告天然偏批判）；「报告 → 分数」的转写方式 UNVERIFIED。这直接支撑设计：主观意见只展示、标注未校准、不进入结论。

### D4 修订有效性
ReviseBench 无许可证 → DATA_BLOCKED（未下载）。L3 修订闭环沿用 M15 长程冻结回放证据，本轮未重新校准。

## 6. 预算与成本
- 付费模型调用 **45 / 80**（E2E-1 1、E2E-2 1、D2 26 = 24 + 2 repair、D3 17 = 16 + 1 repair），0 次错误；真实 E2E **2 / 2**。
- token（D2 + D3，有 usage 的 43 次）：输入 431,366 / 输出 28,159；Pi 模型目录单价估算合计 0.74（订阅渠道，**不是账单**；实际费用未知）。
- 外部检索 / 下载：OpenAlex 2 次身份核对；官方页面抓取（快照 7 页 + 在线复核 7 页，PLOS 遵守 30 s Crawl-delay）；GitHub 公开数据经本机已配置代理下载（CoCoReviewBench 1 个 jsonl + 12 个 MD；SurveyReview 测试集 + 全文分片）。无付费服务、无 GPU。

## 7. 工程回归（G6）
- 后端：新增 `journalAssessment.test.ts` 21 例 + HTTP 1 例；全量 4708 通过 / 0 失败（首轮；`orchestratorHardening` 套件 Windows 临时目录 `ENOTEMPTY` 清理竞态，单独重跑 5/5 通过，与本改动无关）；纠偏后全量重跑：429 文件 / 4709 用例全部通过、0 失败（`G6-backend-full-2.log`）。
- 前端：380/380（新增 3），typecheck、build 通过。
- 浏览器 E2E（scripted 栈，本机 Chrome）：TJA 3/3、分层报告 2/2、证据门禁 7/7、HITL 7/7。既有的 3 个 E2E 失败（smoke / 运行中取消 / 真实编译失败，M15 长程 G15）未在本轮范围内。
- `git diff --check` 通过；文档相对链接检查 426 个全部有效。

## 8. 为什么不是 TARGET_JOURNAL_MVP_VALIDATED
产品主路径（G0–G3、G5、G6）通过，外部基准也有真实证据；但这些证据只说明：(a) 规则检查器在真实已发表 CJIG 论文上不误报（D1，仅参考文献类可判）；(b) 模型主观意见在英文领域既不比单次 LLM 召回更好（D2），也与人类质量分严重不一致（D3）。**没有任何中文期刊的独立人类质量标签**，所以「论文是否达到目标期刊学术要求」的主观部分仍无校准。按合同取 `ENGINEERING_COMPLETE_EXTERNAL_VALIDITY_LIMITED`。缺什么：目标期刊（或同类中文期刊）的独立专家质量标签，或含已确认拒稿的投稿记录——M15 长程 `E3-calibration` 校准包仍适用。

## 9. Git / CI
见交付说明（提交后补记：HEAD、origin/main、ls-remote、CI 与 Linux Integration 运行结果）。

## 10. 遗留与 Next Steps（不在本轮扩展）
1. 更多期刊 profile（同 schema 逐句摘录 + 回放脚本）；用户自带 profile 的导入 UI。
2. 编译后版式 / 图像检查器（dpi、三线表、图题双语）把对应 evidence_based 规则升级为可判定。
3. PDF 重建稿的章节标题保真（E2E-1 暴露：标题被渲染为普通行、表格环境丢失）——属导入链路，本轮只在检查器侧兼容。
4. M12 画像对中文稿的正文词数统计偏低（E2E-2 显示「正文 669 词」）——既有模块口径问题，C 块只作参照，未修。
5. 无需作者批准的科学问题；本轮未修改任何作者科研事实或数值。
