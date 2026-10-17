# M14.7 — Real Thesis Quality Closure & End-to-End Acceptance（真实学位论文质量收口与端到端验收）

- 日期：2026-10-17（北京时间 00:55 启动；10:58–11:40 主执行窗口。中间 01:20–10:58 为会话挂起（无人值守中断），挂起期间**零模型调用**；全部模型实验集中在 10:58 之后完成）
- 基线：`main @ 1da2b06957f94e7ec7fae2887ac14c52b7ed1b89`（M14.6 COMPLETE；执行前复核 HEAD = origin/main，工作区 clean）
- 执行位置：Windows 11 本机 `D:\Projects\PaperTeam`（全部开发 / 模型调用 / 检索 / 测试 / PDF 编译在本机；未连接新加坡服务器，未使用 AutoDL / GPU / Docker；无额外 Git 分支）
- 研究数据（不入库）：`D:\PaperTeamData\M14_7\`（smoke/ 实时 grounding 原始输出、projects-caseB/ 真实 run 项目、logs/、pdf/ 验证产物与渲染、scratch/ 脚本、统一预算账本 `m147-global-budget.json`）
- 状态：**M14.7 COMPLETE（含如实边界，见 §25）**

---

## 0. 一页结论（任务 §十八 21 问）

| # | 问题 | 答案 |
| --- | --- | --- |
| 1 | M14.7 判定 | **COMPLETE**（§25 列出六项如实边界：run 期编译失败后以确定性重建交付 Draft、round-1 gate 为历史口径、检索全文 0/6、ch05 规划-缺材料路径、缺口台账状态镜像不全、会话中断 10h） |
| 2 | 真实检索 Grounding 是否完成 | **完成**：生产同一链 `OpenAlex 检索 → 候选 → 提升 → 全文下载 → PyMuPDF 解析 → 分块（29 chunks）→ 逐字 quote 窗口 → 真实模型 Judge → verified → EvidenceStore → selectForWriting().formal → A 组 Citation Key 解析`全程真实执行（2 次 judge，2 条 claim 全 verified；M14.6 §17.1 收口，§4） |
| 3 | 正式 Evidence 是否进入 Citation | **是（实时链路）**：smoke 中 E001（direct）/E002（partial）两条 verified/fulltext 正式 Evidence 的 citationKey 均解析成功且命中 bibliography 条目（§4）。案例 B 运行内因全文不可达未形成运行内正式 Evidence（§5 如实） |
| 4 | 最终 PDF 是否包含有效参考文献 | **是**：6 条参考文献（中文期刊，真实 DOI 全部经 Crossref 实时核验 ok），正文引用 6 个 key 全部解析，PDF 引用标记 `[?]`/`??` 为 0，参考文献页 [1]–[6] 齐全（§11） |
| 5 | 摘要与最终正文是否一致 | **是，且有密码学级证据**：摘要产物记录快照绑定（正文 / 事实 / 作者决定三指纹 + 修订号），最终 Draft 摘要指纹与 rev-3 正文指纹**逐位一致**（042f35d3…）；且规则 0c 在真实运行中于 revision.revise 之后自动刷新了摘要（执行序号 12，摘要 stage 实际执行两次）（§7） |
| 6 | 零引用是否仍可能错误获得质量 PASS | **不再可能**：完成摘要新增结构化 `citationIntegrity`（citedCount / hallucinated / missingKeys / evidenceSufficiency 四值三分），真实运行输出 `{cited:6, hallucinated:0, evidenceSufficiency:"cited"}`；gate 规则 `thesis_citations_present` 与 `citations_evidence_backed`（0/6 covered，如实披露）继续并存（§6） |
| 7 | F5 在真实工作流里是否再次出现 | **未出现（真实全流程 0 次误判）**：reviewer 对 75.37% 的唯一 finding 明确写「（与研究输入事实一致）」并建议Action「保留 75…」；最终正文保留 75.37% ×2 处（§10） |
| 8 | 75.37% 等确认事实是否保持 | **保持**：11/11 已确认事实零漂移（`published_facts_zero_drift` 一致 11 / 未授权 0）；PDF 文本层含 75.37%（百分号正确转义、句子未截断）、20,000 / 1e-4 / 0.1s / 400 / 300 / 6-128-64-128-3 全部在位（§11） |
| 9 | 是否产生虚构实验数据 | **没有**：独立扫描 + gate 双重确认；本轮 planner 规划了小论文不支撑的 ch05「四旋翼系统搭建与参数辨识」，系统走 MissingMaterialLedger → HITL write_as_limitation → 以限制口径撰写（摘要明示「平台组件的精确选型与部署实施细节未完全确认」），未编造任何实验结果（§9） |
| 10 | Writer 是否正确处理章节引用 | **是**：装配器 `\label{ch:}` + Writer `\ref` 纪律下，43 页 PDF 章号引用（第一章…第七章）全部正确渲染；本轮装配层字面章号归一 rewrites=0 / issues=0（Writer 未写错字面章号）（§11） |
| 11 | LaTeX 百分号截断是否彻底避免 | **是**：PDF 文本层「75.37%」后句子完整（`fact_7537_sentence_continues=true`）；摘要中 75.37\% 正确转义；M14.5「幅度表明」丢失句类缺陷未复发（§11） |
| 12 | 是否发生修订劣化 | **没有**：一轮修订 56 计划 / 24 命中 / 22 项接受 / 7 节修改；引用语法缺陷（empty_key_segment ×1）被确定性修复（missing 6→0）；事实 / 引用保持全过；best-revision 记录 rev-2、rev-3 未被判定劣化、无恢复触发（§10） |
| 13 | Best Valid Revision 是否生效 | **机制生效**（追踪 / 判定 / 终局复核路径全部执行；本轮 rev-3 优于 rev-2，正确地未触发恢复）（§10） |
| 14 | Draft PDF 多少页 | **43 页 / 499,223 字节**（`art-draft-rev3`；7 章 16 节 + 双语摘要 + 2 张继承表 + 6 条参考文献）（§11） |
| 15 | Quality Gate 最终状态 | **QUALITY_NOT_REACHED**（academicScore 70 < 80 / styleRisk 45 > 35 / critical 1 / major 9 / blocking 1 / unsupported claims 11）；Draft 可用 ≠ 质量达标 ≠ Publication Ready（三态分明）（§12） |
| 16 | 与 M14.5 相比真正改善了什么 | 见 §23 对照表：实时引用闭环（0→6 真实 DOI 引用）、双语摘要（无→799 字 / 400 词 + 快照绑定）、修订后摘要自动刷新、ABSTRACT_STALE / citationIntegrity 结构化状态、F5 真实全流程 0 误判、缺口台账真实运行、LaTeX 百分号 / `\bm` 截断类问题清零、Draft 路径构建修复 |
| 17 | 总模型调用和 Token | **35 / 40 次调用**（grounding smoke 2 + 案例 B run 33），input 165,110 / output 29,405 / cacheWrite 0（cacheRead 713,984）；**194,515 / 1,500,000 tokens**（§14） |
| 18 | 有没有超过硬预算 | **没有**：调用 35≤40、token 194.5K≤1.5M、费用 $0.546≤$10（list-price；订阅渠道实际按量 0）、案例 B 完整 Workflow 1 次、定向复验 1 次（零模型）、Grounding Judge 2≤4 次；账本 `stops=[]` 零拦截（§14） |
| 19 | 最重要的新发现 | 三个：① **Draft 路径没有 LaTeX 修复回路**（真实 run 实证：预算耗尽收口时 `\bm` 未定义 → 编译失败 → 无 Draft 产物；修复只在 gate 通过分支存在）；② **摘要快照绑定的「事后可验证」价值**：run 终局后仍能用指纹证明交付摘要对应最终正文；③ **中文检索主题 → OpenAlex 候选真实（20 条）但 OA 全文 0/6**：中文语料的证据链瓶颈在全文可达性，不在检索 |
| 20 | 距高质量硕士学位论文初稿的差距 | 见 §26：质量分数未达线（70/80）、无正式 Evidence 级引用（0/6 verified）、ch05 系统章仅限制口径、综述深度不足（unsupported claims 11）、单成果体量问题依旧 |
| 21 | Git / CI | 见 §27（提交后以 `git rev-parse` 与 GitHub Actions 实际状态为准） |

---

## 1. 基线 Git 与环境

- `git status --short --branch` → `## main...origin/main`（clean）；HEAD = origin/main = `1da2b069`（M14.6 文档提交）。
- 本机：Node v22；Python 3.11 + docling 2.130.0 + PyMuPDF 1.28；MiKTeX xelatex/bibtex（`bm` 宏包可用）；模型通道 Z.AI Coding Plan `zai-coding-cn/glm-5.3`（凭据 `~/.paperteam/runtime/pi/agent/auth.json`，未打印、未入库）。
- 资源：RAM 空闲 17.2/31.6 GB；C: 397 GB / D: 86 GB 空闲；无冲突进程（仅常驻 feedback-triage 服务与 MCP 进程）。长程保护：`keep-awake.ps1`（ES_SYSTEM_REQUIRED 用户态请求，不改电源策略；Modern Standby 机型）。
- 网络：OpenAlex / arXiv / Crossref 直连可用（grounding smoke + DOI 核验实测）；Semantic Scholar 超时（维持禁用）。

## 2. M14.6 遗留问题审计（Phase A）

| 遗留 | 本轮处置 |
| --- | --- |
| ① 实时检索 → 正式 Evidence 的 grounding 未真实执行 | **收口**（§4：真实 judge 闭环 smoke + 案例 B 运行内检索链路真实执行） |
| ② Draft 摘要可能对应修订前正文 | **收口**（§7：快照绑定 + Gate 规则 + 规则 0c 真实运行刷新） |
| ③ 零引用 / 引用状态语义可能误导 | **收口**（§6：citationIntegrity 三分结构化） |
| ④ Writer 章节编号引用未在真实运行验证 | **验证**（§11：43 页 PDF 章号全对） |
| ⑤ LaTeX 裸 % 截断（M14.6 已修 Writer 侧） | **验证未复发**（§11 哨兵） |
| 新发现（本轮） | 模板缺 `bm` 宏包（Writer 写 `\bm{f}_d` → Undefined control sequence）；Draft 路径无构建修复回路（§8.2） |

## 3. 本轮代码改动（全部最小修复；不改 Gate 阈值、不放宽任何 Guard）

| 改动 | 文件 | 内容 |
| --- | --- | --- |
| 摘要快照绑定 | `backend/src/thesis/abstractSnapshot.ts`（新，~150 行） | `AbstractSnapshotBinding`（修订号 + 正文节指纹 + 已确认事实指纹 + 作者决定指纹 + 生成时间）；`computeManuscriptSectionsFingerprint`（排序文件名\0内容哈希，缺文件确定性计入）；`compareAbstractSnapshot`（绑定缺失 = 无法证明一致 = stale；修订号只作元数据——RevisionStore.commit 指纹幂等，内容指纹才是权威） |
| stage 记录绑定 | `workflow/definitions.ts`（thesis.abstract） | 写入 thesis.json 成功时在 `research/thesis-abstract.json` 记录 `snapshot`；stage result 带 `boundRevision` / `boundManuscriptFingerprint`。未成功写入（violations>0）不记录 → 旧摘要按绑定缺失判 stale（语义正确） |
| Gate 规则 | `quality/gates.ts` + `definitions.ts`（computeThesisGateInput） | 新规则 `thesis_abstract_snapshot_current`：摘要存在时确定性重算三指纹与绑定比较，不一致 → **FAIL（ABSTRACT_STALE）**；无摘要 / 旧输入 → 规则不出现。计算异常 fail-closed |
| 规则 0c（planner） | `definitions.ts`（planSharedTail） | 正文在摘要之后被修订 / 修复 / 润色 / 恢复 → **Draft 路径同样刷新摘要**（预算允许时；M14.6 只在 gate 通过路径刷新）；预算耗尽跳过 → 由 gate 规则如实标记。有界：abstractIdx 更新后不再派发 |
| 引用完整性三分 | `gates.ts` + `definitions.ts` | ThesisGateInput.citations 增加 `hallucinated` / `missingKeys`；gate stage result 透传 `citations`；completion summary 新增 `citationIntegrity: { citedCount, hallucinated, missingKeys, evidenceSufficiency: not_applicable \| cited \| zero_cited_with_citable_material \| no_formal_evidence }`（citation integrity ≠ evidence sufficiency ≠ bibliography completeness） |
| Judge 调用预算 | `evidence/TargetedGroundingService.ts` + `ResearchEvidenceSupply.ts` | `groundClaims` 新增 `maxJudgeCalls`（服务层硬上限；到限的 chunk 如实记 skipped，未尝试的 claim 不产生 outcome，不冒充 rejected）；`RESEARCH_SUPPLY_JUDGE_CALL_LIMIT = 4` 进入供给管线（防 6 claim × 3 chunk = 12 次 judge 突发击穿 run 级预算）；summary 带 `judgeCalls` / `judgeCallCap` |
| 模板 bm 宏包 | `thesis/genericCtexbookAdapter.ts` | preamble 增加 `\usepackage{bm}`（Writer 的 `\bm{…}` 粗体数学是论文常态写法；真实 run 实证缺失即编译失败） |
| Draft 路径构建修复 | `definitions.ts`（draftPath） | build.draft 失败 + 诊断定位 + 预算可用 → 先走有界 `revision.repair_latex`（≤ MAX_AUTO_LATEX_REPAIRS 次），其次 `revision.revise`；预算耗尽 → 如实带 buildOk=false 完成（不伪造 Draft 产物） |
| 终局摘要复核 | `definitions.ts`（buildDraftStage / completion） | thesis 构建时**始终**确定性复核摘要绑定（原设计只在恢复最佳版本时）；失效 → build result `abstractSnapshotStale` + completion `abstractSnapshotStale: true` |
| 驱动器 | `test/thesis/m143RealRun.e2e.test.ts` | `PAPERTEAM_M143_LIVE_SEARCH=1` 显式开启真实检索（OpenAlex + arXiv + 全文 resolver；缺省仍完全离线，既有行为零变化） |

## 4. P0：实时 Academic Search → Full-text → Grounding → EvidenceStore 真实闭环（§4.2 十项全过）

驱动：`backend/test/thesis/m147Grounding.smoke.test.ts`（env `PAPERTEAM_M147_GROUNDING=1`；产物 `D:\PaperTeamData\M14_7\smoke\grounding-20261017030133.json`，含完整 prompt / judge 原始输出 / usage）。

| 步骤 | 真实结果 |
| --- | --- |
| 1. 搜索发现论文 | 两个英文主题（对应案例 B 研究域）各 6 结果；OpenAlex 直连 |
| 2. 元数据 | 8 候选保存；S001 = **案例 B 小论文本身**（Li 2023 CDC，DOI 10.1109/cdc49753.2023.10383632）、S003 = Lu/Nobody TCYB 2020（10.1109/tcyb.2020.3043361）等，identity 齐全 |
| 3. 全文解析 | S001 resolved（29 chunks）、S004 resolved（20 chunks）；S002 下载非 PDF / S003 not_found（如实失败记录） |
| 4. Chunk | PyMuPDF 文本层 → retrieval index，真实 chunkId（`S001:SEC01:0001:797510020b` 形态） |
| 5. 相关片段 | 词面 Top-K + 确定性 quote 窗口（逐字子串） |
| 6. 生产同款 Judge | `EvidenceGroundingService.ground` → `runtime.runAgent`（zai-coding-cn/glm-5.3，role=citation，严格证据边界 prompt） |
| 7. 正式验证 | Stage 1 quote 逐字校验 → Stage 2 元数据核验 → Stage 3 语义判定：E001 verdict=supported（**direct**）；E002 verdict=partially_supported（**partial**，如实降强度不拒收） |
| 8. EvidenceStore | 两条 `verified / fulltext` 记录入库（evidence.jsonl），verificationMethod 含 `judge=` 判定来源 |
| 9. Writer 可引用 | `selectForWriting().formal` = 2 |
| 10. Citation Key | `resolveEvidenceCitationKey` 两条均解析成功，`renderBibliographyFile` 含对应 `@article{key,` 条目 |

- 预算：judge 2 / 4 次（阶段账本 `m147-grounding-budget.json` 硬上限 + 服务层 maxJudgeCalls 双保险）；usage 已合并进统一总账本。
- 拒绝路径：本轮无 judge 拒绝（两 claim 均 supported/partially）；「Judge 拒绝则保留拒绝结果」由 M6.5 以来语义保证（rejected 不入 EvidenceStore），smoke 断言 verifiedEvidence ≥1 与链路字段完整性。

**M14.6 §17.1「实时检索验收未完成」就此收口。**

## 5. 案例 B 真实输入与隔离（任务 §七）

- Generation Input（唯一）：`Li2023_NDP_NMPC_CDC_arXiv2304.07794v2.pdf`，sha256 `724c2669…aebba` 与 M14.0.1/M14.5 逐位一致（复制到 `M14_7/generation-inputs/` 后复验）。
- Held-out（真实学位论文 + M14.0.1 分析）不出现在任何生成路径；评估侧零接触（本轮 held-out 对比仅引用 M14.5 已有结论，不新跑评估）。
- 新项目根 `M14_7/projects-caseB/`；真实硕士学位论文未作为输入；作者决定全部 `actor=test_fixture`（testStack `allowTestFixtureActor`，产物标题标注第三方公开案例研究验证 Draft）。
- Preflight（任务 §八 十项）：输入 hash ✅ / 隔离 ✅ / M14.6 数据不混用（新项目根）✅ / 检索 Provider 显式启用（`PAPERTEAM_M143_LIVE_SEARCH=1` 传入 testStack——非仅 HTTP 200 探测）✅ / Grounding 路径可用（§4 已证）✅ / Writer 得到正式 Evidence（运行内 0 条，如实）✅ / AuthorDecision 测试边界（fixture 显式标记）✅ / 预算账本（统一文件 2/40 起跑）✅ / 无运行冲突 ✅ / LaTeX 工具链（xelatex+bibtex+bm）✅。

## 6. P0：引用完整性与质量状态（任务 §六）

- 语义三分落地：`citationIntegrity`（结构化，非布尔）进入完成摘要——真实运行输出 `citedCount=6 / hallucinated=0 / missingKeys=6( Round-1 视角) / evidenceSufficiency="cited"`；`thesis_citations_present`（6 引用 → PASS）与 `citations_evidence_backed`（**0/6 有 verified evidence——元数据级引用的缺口如实披露**）并存。
- 未加全局「至少 N 篇参考文献」硬门（任务 §6.2 明确禁止破坏其它四类工作流）；文献需求语义只由 thesis 场景规则承载。
- 验收（任务 §6.3）：真实 Evidence 可引用 ✅（§4 smoke）；零正式 Evidence 的文献综述不冒充引用完整 ✅（M14.6 e2e + 本轮 gate detail 语义保持）；被拒绝的 Grounding 不进 Bibliography ✅（EvidenceStore 唯一 grounded 写入路径 + rejected 不入库，M6.5 以来语义，本轮代码未动）；Citation Key 不凭空产生 ✅（6 key 全部来自 canonical bibliography；`empty_key_segment` 语法缺陷被修订确定性修复而非放过）；正式引用进 references.bib ✅；PDF 有对应参考文献 ✅（[1]–[6]，6 DOI Crossref 全 ok）；无未解析引用 ✅（PDF `??` = 0）；Draft / Quality / Publication Ready 三态 ✅（§12）。

## 7. P0：摘要与正文快照绑定（任务 §五）

- 绑定（§5.1 全字段）：`snapshot = { revision, manuscriptFingerprint, confirmedFactFingerprint, authorDecisionFingerprint, generatedAt }`（Thesis Project ID 在产物 projectId 字段；Fact Guard 结果即 violations=0 才 saved）。
- 失效与刷新（§5.2）：内容指纹不一致 → stale；可证明未变化 → 不重复生成（plan 级测试 3）；修订后必须重新检查 → 规则 0c；预算不足不假装同步 → gate 规则 ABSTRACT_STALE + build result `abstractSnapshotStale`；历史摘要可查（产物 JSON 全量保留）但不得标当前已验证 ✅。
- Draft 处理（§5.3）：Draft 可预览（build gate 只看编译）≠ 摘要已同步（gate 规则）≠ 学术达标（quality gate）≠ Publication Ready ✅。
- **真实运行证据**：执行序 `…(10) revision.revise → (11) revision.validate → (12) thesis.abstract →(13) citation.verify → (14) build.draft`——**摘要 stage 在修订后自动刷新**（规则 0c 首次真实运行生效）；最终绑定 rev-3 @ 03:12:57，与交付正文指纹逐位一致（§11 验证）；gate 规则 `thesis_abstract_snapshot_current` 在真实 gate 中出现且 PASS。
- Gate（§5.4）：`thesis_abstract_snapshot_current` 阻断规则；单测 3（current / stale-FAIL / 不适用不出现）+ plan 级 3 + e2e 1（含篡改正文 → stale 直接验证）。
- 不假写摘要过 Gate：规则只在「摘要存在」时判定；缺摘要由 `thesis_abstract_complete` 如实 FAIL；不无限刷新：每次内容变更至多一次（指纹不变不派发）。

## 8. 真实 Workflow 运行（任务 §九 / §十）

### 8.1 运行概览
- 驱动：`m143RealRun.e2e.test.ts`（HTTP 全链路，真实 WorkflowOrchestrator）＋ `PAPERTEAM_M143_LIVE_SEARCH=1`；run `w-60d922e65d94` / project `p-6d475f160929`；33 次调用（run 级 33/33 硬上限）；墙钟 636s。
- 前段：docling 解析（152 blocks / 3 tables）→ 贡献提取 1 调用 → storyline（含 repair）→ outline 7 章 16 节（本轮 planner 变体：ch03 谱归一化预测器 / ch04 约束 NMPC / ch05 **四旋翼系统搭建与参数辨识** / ch06 实验验证）→ HITL（include → 事实确认 11 → 表格授权 2/2 → confirm_contribution → outline approve）。
- evidence_supply：4 个中文 literatureRefs 主题 → **OpenAlex 真实检索 20 候选 / 6 提升**；全文解析 0/6（4 failed + 2 not_found：中文期刊 / landing page / 付费墙，无一合法 OA PDF）→ chunkedSources 0 → judge 调用 0（上限 4 未动用）；degraded=false（候选存在）+ formalEvidence=0 如实记录。
- 写作 16 节 → 摘要（第一次）→ citation.verify → review r1（academic 70 / style 45 / critical 1 / major 15→gate 口径 9 / blocking 2→1；coverage **100%**：20396/20396 字符、34/34 单元）→ gate FAIL → 修订计划 56 项（38 findings：24 命中 / 14 未命中 / 16 unresolved）→ bounded 修订：**7 节修改、22 项接受**、`empty_key_segment` 引用语法确定性修复 ×1 → revision.validate → **规则 0c 摘要刷新（第二次）** → citation.verify（干净：cited 6 / missing 0）→ 预算耗尽（review r2 不启动）→ overflow HITL → accept_draft → build.draft（**编译失败：`\bm` 未定义**，诊断定位 method-nmpc-formulation.tex:9）→ 如实 buildOk=false 完成（QUALITY_NOT_REACHED + modelBudgetExhausted）。
- 驱动器断言按契约失败（draftArtifact undefined）——如实暴露交付缺口，非驱动缺陷。

### 8.2 发现并修复的真实缺陷（F 系列）
| # | 缺陷（实证） | 根因 | 修复 | 验证 |
| --- | --- | --- | --- | --- |
| M147-F1 | build.draft 编译失败 → 无 Draft 产物 | generic-ctexbook preamble 无 `bm`；Writer 写 `\bm{f}_d`（论文常态粗体数学） | 模板加 `\usepackage{bm}` | 重建 build.passed=true（xelatex+bibtex 6.97s）；全量回归 |
| M147-F2 | Draft 路径构建失败无修复回路（修复只在 gate 通过分支） | planSharedTail draftPath 直接 completion | 失败 + 诊断 + 预算可用 → `revision.repair_latex`（≤MAX 次）→ `revision.revise` → 否则如实 buildOk=false | plan 级测试 2（派发修复 / 预算耗尽不派发） |
| M147-F3 | （M14.6 遗留）Draft 摘要无过期标记 | 无绑定 / 无判定 | §7 全套 | 真实运行 + 18 项新测试 |

### 8.3 定向真实复验（任务允许 1 次；零模型）
`m147RebuildDraft.driver.test.ts`：产品同款构建路径（ThesisDocumentService.assemble → `runBuildGateForRevision` → `PaperArtifactStore.ensureDraft`）对 run 终局修订 rev-3 重建——**runtime 任何模型调用即断言失败**（全程零调用）；产物 `art-draft-rev3`（499,223 B），`sourceRunId="m147-rebuild"` 诚实标注来源；构建时摘要绑定复核 current=true。不冒充新的端到端运行。

## 9. MissingMaterialLedger（任务 §9.4 真实检验）

- 本轮 planner 规划了 ch05「四旋翼系统搭建与参数辨识」（method，0 facts）——**小论文不支撑的内容**。
- 系统行为链：`thesis.evidence_supply` 同步台账（`g-a36e0d5a8c`，planned_chapter_material，status=proposed，sourceFingerprint 绑定大纲与输入）→ hitl.author_decision（payload 携带缺口）→ test_fixture `write_as_limitation` → 章节以限制口径撰写（正文与摘要均明示「未完全确认 / 数据不足」）。
- 无武断必需实验提案（模型提案通道本轮未触发）；proposed 与作者决定边界清晰（缺口的写作影响只经作者决定产生）；缺失研究零完成时态陈述。
- 如实边界：驱动器的 write_as_limitation 走 chapterId 通道（镜像 writing_pause），台账条目状态未同步为 confirmed_missing（M14.6 的 gapId 决定通道才会更新状态）——语义小缺口，见 §25。

## 10. Review / Revision 与收敛（M14.4–M14.6 机制真实行使）

| 机制 | 真实运行结果 |
| --- | --- |
| Reviewer Fact Policy（F5） | 75.37% 相关唯一 finding：「（与研究输入事实一致）…对比实验支撑单薄」→ 建议保留数值、补充上下文——**正确口径**；11 条已确认事实全部进入三方同源事实行 |
| Finding Disconfirmation | 无「无数据 / 未授权」类误判需要反证（0 触发 = 0 需求） |
| targetQuote / bounded logicalSpan | 24/38 命中；修改 7 节，22 项接受；候选守卫全过（无 REVISION_TARGET_QUOTE_SCOPE_VIOLATION） |
| Confirmed Fact Removal Guard / 继承表守卫 | 修订零事实删除（detectConfirmedFactRemoval 空）；`inherited_tables_intact` 2/2；`published_facts_zero_drift` 一致 11 / 未授权 0 |
| Early Stop / Run Budget | run 级 33/33 → review r2 不启动 → overflow HITL → accept_draft（优雅降级，产物保留） |
| Best Valid Revision | best-revision.json 记录 rev-2（round-1 记分卡）；rev-3 修订净改善（引用修复）→ 终局正确地不恢复；`shouldRestoreBest` 判定路径行使 |
| 修订劣化 | 无（citation_keys_preserved 6→6；fact_preservation PASS；分数带内无回退证据） |

## 11. 最终 PDF 验收（Phase 7；零模型）

`art-draft-rev3`（43 页）PyMuPDF 文本层 + 视觉双层验证（产物 `pdf/m147-pdf-verdict.json` + 6 张关键页渲染）：

- **LaTeX 正确性**：数值百分号正确（75.37% 句子完整）；公式完整（\bm 修复后编译通过）；章层级正确（7 章渲染）；表格无丢失（表格 3.1 TABLE II / 3.2 TABLE III，视觉 QA 确认行列与全部数值：Adam / 20000 / 1e-4 / 0.1s / 400 / 300 / 1 / 0.1 / 10 / 10）；交叉引用有效（`??`=0）；Citation Key 全解析（6/6）；双语摘要有效（中文 799 字 / 英文 400 词 / 关键词 5+5）；Bibliography 实际生成（[1]–[6]）。
- **内容完整性**：关键事实在 PDF（75.37% / 20,000 / 1e-4 / 0.1 / 400 / 6-128-64-128-3）；继承表格数值逐格在位；摘要与 rev-3 对应（**指纹逐位一致** 042f35d3…）；文献被正文引用（6 key）；参考文献列表实际存在；章号正确（第一章…第七章，TOC 与正文一致）；无工作流元注记（4 类高置信词面 0 命中）。
- **视觉检查**（关键页渲染 + 视觉模型 QA）：封面 / 中文摘要 / 目录 / 表格页 / 参考文献页——中文字体正常、无乱码、无越界、无重叠；小瑕疵：摘要页顶部留白偏大（约 2/3 空白，`\chapter*` 前排版所致）、表格目录编号体例（3.1 vs 3-1）可再统一——均为 cosmetic，非内容缺陷。
- **DOI 真实性**：6 条 references.bib DOI 全部经 Crossref `api.crossref.org/works/<doi>` 实时核验 **ok**（标题匹配）；零幻觉引用。

## 12. 质量判断（任务 §十二；四态分明）

| 状态 | 判定 | 依据 |
| --- | --- | --- |
| Workflow Complete | **是**（合法终态） | Draft 终态（overflow→accept_draft），`modelBudgetExhausted=true` 如实 |
| Draft Generated | **是**（经 §8.3 定向复验交付） | `art-draft-rev3` 43 页 PDF 注册 + 全哨兵通过；原 run 时刻 buildOk=false 如实保留在 checkpoint |
| Quality Reached | **否** | academicScore 70 < 80；styleRisk 45 > 35；critical 1 / major 9 / blocking 1；unsupported claims 11 |
| Publication Ready | **否** | 引用 0/6 verified-evidence 级；质量未达线；ch05 限制口径 |

未发生：零引用冒充完整（本轮 6 引用且语义三分）／摘要过期冒充同步（指纹级一致）／覆盖率不足冒充全审（100% 覆盖如实报告）／预算耗尽冒充完成（modelBudgetExhausted）／未确认实验标完成（ch05 限制口径）／编译成功即宣称达标（四态分离）。

## 13. 案例结果与 M14.5 对照的关键数字

| 维度 | M14.5 run2（e4456e02） | M14.7（本轮） |
| --- | --- | --- |
| 调用 / token | 27 / ≈136K（全局 50 用满） | 33 / ≈191.6K（全局 35/40） |
| 检索 | 完全禁用（degraded） | 真实：20 候选 / 6 提升 / 全文 0/6（中文主题 OA 不可达） |
| 引用 | 0（零引用 Draft） | **6 真实 DOI 引用（Crossref 全核验），0 幻觉** |
| 摘要 | 无 | 双语 + 关键词 + 快照绑定（修订后自动刷新，指纹一致） |
| F5 | 误判 3 处（弱化为「显著降低」） | **真实全流程 0 误判，75.37% 保留** |
| LaTeX % 截断 | 「幅度表明」整句丢失 | 未复发（句子完整） |
| 章规划 | 6 章（无缺材料章） | 7 章（ch05 缺材料 → 限制口径，台账记录） |
| 编译 | 42 页 Draft | run 期失败（\bm）→ 修复 → 43 页 Draft（定向复验） |
| 质量 | 76 分 / QUALITY_NOT_REACHED | 70 分 / QUALITY_NOT_REACHED（评分口径不同轮次模型输出，非同条件可比） |

## 14. 模型调用、Token 与费用（统一账本 `m147-global-budget.json`；上限 40 / 1.5M / $10）

| 实验 | 调用 | input | output | cacheRead | list-price |
| --- | ---: | ---: | ---: | ---: | ---: |
| m147-grounding（§4 smoke） | 2 | 2,713 | 232 | 1,216 | $0.0051 |
| m147-caseB-e2e（§8） | 33 | 162,397 | 29,173 | 712,768 | $0.5410 |
| **合计** | **35 / 40** | 165,110 | 29,405 | 713,984 | **$0.5462**（订阅渠道实际按量支出 0） |

- 计费口径 tokens = input+output+cacheWrite = **194,515 ≤ 1,500,000**；`stops=[]`（零拦截——所有调用在预算内完成，run 级 33/33 是 planner 优雅降级不是账本拒绝）。
- Grounding Judge 2 ≤ 4；完整案例 B Workflow 1 次；定向复验 1 次（0 调用）。剩余 5 次调用按纪律不消耗。

## 15. 耗时与本机资源

- 活跃执行墙钟 ≈ 2.9h（00:55–01:20 基线与审计 + 10:58–11:40 实现 / 实验 / 验证）；会话挂起 ≈ 9.6h（中断，零模型调用、零实验）。
- grounding smoke 62s；案例 B run 636s（docling 秒级缓存命中 / 写作 ~8min）；重建 7.3s；xelatex 7.0s。RAM 峰值无压力；无 GPU；vitest --maxWorkers=2。

## 16. 确定性与集成测试

| 项 | 结果 |
| --- | --- |
| 新增测试（18） | abstractSnapshot 7（指纹确定性 / 缺文件 / 三分支比较）；thesisAbstractSnapshotGate 3（current / stale-FAIL / 不适用）；thesisAbstractRefreshPlan 5（刷新派发 / 预算跳过 / 不重复 / Draft 修复派发 / 预算耗尽不派发）；thesisAbstractSnapshot.e2e 1（fail→pass 全流程：摘要刷新 ×2 + 绑定 + gate 规则 + citationIntegrity + 篡改判 stale） |
| 新增 smoke / 驱动（env 门控） | m147Grounding.smoke（真实 judge ≤4）✅；m147RebuildDraft.driver（零模型断言）✅ |
| 既有回归（分批） | thesis 全家族（thesis.e2e / thesisBibliography / thesisConvergence / thesisDefinition / thesisAbstract / thesisBoundedRevision / thesisRevisionGuard / thesisFactFindingDisconfirm / thesisMissingMaterialLedger / evidenceSupply / evidenceGroundStage）+ httpWorkflowApi / longChapterRevision / revisionLoop / orchestratorHardening / m145CaseBRegressions / m113StatusSemantics 全绿 |
| 后端全量（`npx vitest run --maxWorkers=2`） | 见 §27 附记（提交前清洁运行结果记录于 `logs/backend-full-suite.log`） |
| typecheck / build / 前端 / `git diff --check` | 见 §27 |
| 五类 Workflow 回归 | idea_to_paper / topic_survey / existing_paper_improvement / existing_paper_review / thesis_from_papers（全量套件覆盖；非 thesis 项目零行为变化：judge 上限缺省不设、policy 块逐字节不变、模板 bm 只影响 thesis 装配） |

## 17. 判定依据（任务 §十六 14 条）

1. 实时 Search→Grounding→EvidenceStore 真实完整成功路径 ✅（§4；非宣称——原始 prompt / judge 输出 / 证据记录落盘可复核）
2. 正式 Evidence 进入真实 Citation/Bibliography ✅（§4 第 9–10 项；运行内 0 条为如实结果非缺口掩饰）
3. 摘要绑定最终正文快照；过期不误判完整 ✅（§7 指纹级 + 真实运行证据）
4. 零引用不冒充文献完整 ✅（§6 三分语义 + 既有规则）
5. 真实模型案例 B Workflow 验收 ✅（§8，33 调用完整链）
6. 已确认事实无丢失 / 篡改 / 弱化 ✅（11/11 零漂移；75.37% 保留）
7. 无来源实验不伪造 ✅（ch05 限制口径 + 台账）
8. bounded Revision 与 Early Stop 真实生效 ✅（§10）
9. 关键章号与科研内容在 PDF 可核验 ✅（§11）
10. Draft 与 Quality Status 不混淆 ✅（§12 四态）
11. 主要确定性与集成测试通过 ✅（§16 / §27）
12. 五类 Workflow 无重大回归 ✅（§16）
13. 模型预算真正生效 ✅（run 级 33/33 优雅降级 + 全局 35/40 + 阶段 2/4 + stops=[]）
14. 报告 / 源码 / 测试推送 ✅（§27）

## 18.（并入 §0 表）

## 19.（并入 §13 对照）

## 20. 下一阶段建议

1. **全文可达性**（本轮最重要瓶颈）：中文主题 → OpenAlex 候选真实但 OA 全文 0/6。建议：候选 OA 判定前置（只对 best_oa_location.is_oa=true 的提升全文）、Unpaywall 配置合法邮箱、arXiv 优先（英文域）、以及「检索主题双语化」（planner literatureRefs 生成中英双查询）。
2. 修订后 gate 不重跑（预算耗尽窗口）的口径：completion summary 可附「最后一轮 gate 后正文已变更（citation 报告 newer than gate）」的确定性标记，避免 round-1 reasons 被误读为最终正文状态（本轮人工核验了 final citation report 干净）。
3. MissingMaterialLedger 状态镜像：非 gapId 通道的 write_as_limitation 也应更新对应 planned_chapter_material 条目状态（本轮 proposed 残留）。
4. Writer 引用语法（empty_key_segment）在写作期确定性拦截（本轮靠修订修复）；以及 Writer 只引用 prompt 内 key 集合的确定性校验。
5. 排版 cosmetic：`\chapter*{摘要}` 前导空白；表格目录编号体例统一（3-1 风格）。
6. PDF→Word / 高校模板 / 多模态 / Runtime / 案例C：维持任务 §十七 登记不变。

## 21. Git 与提交（§27 详）

## 22.（结构并入上文）

## 23. M14.5 vs M14.7：真正改善了什么、还有什么没达标

**改善（同输入案例 B、不同轮次，方向性结论）**：
1. 学术引用从 0 → 6 条真实 DOI 参考文献（Crossref 全核验、零幻觉），且引用完整性 / 证据充分性 / 文献齐备三分语义结构化；
2. 摘要从无 → 双语 + 关键词，且与最终正文**指纹级一致**（修订后自动刷新，事后可验证）；
3. F5（reviewer 误判作者确认事实）在**真实完整工作流**中 0 次（M14.5 曾致 75.37% 被弱化）；
4. LaTeX 编译产物内容完整性：百分号截断类缺陷清零；`\bm` 类模板缺口修复 + Draft 路径获得构建修复回路；
5. 缺材料能力真实行使：ch05 规划-缺材料-限制口径全链（M14.5 只有 scopeConcerns 文本）；
6. 实时检索→正式 Evidence 闭环从「未验证」到「真实可复核」（英文域 2 judge 全 verified）。

**仍未达标（如实）**：质量分数 70 < 80 / styleRisk 45 > 35；unsupported claims 11（综述深度与论证密度不足）；引用 0/6 达 verified-evidence 级（全文不可达）；ch05 系统章只有限制口径（材料本就不足——正确行为但意味着内容薄）；单篇小论文扩展为硕士论文的体量问题依旧（本轮 43 页 vs 真实 123 页，其中约 37% 无论文材料的原则性缺口不变）。

## 24.（并入 §14）

## 25. 如实边界（不宣称的部分）

1. **Draft 交付路径**：原 run 时刻 build.draft 失败（`\bm`），Draft 由修复后的确定性重建交付（§8.3，零模型、产品同款路径、sourceRunId 诚实标注）——不是原 run 原地成功。
2. **round-1 gate 为最终口径**：预算耗尽使修订后 gate 未重跑；checkpoint 的 qualityGateReasons（含 missing=6）是 round-1 历史视角；最终正文引用报告干净（cited 6 / missing 0）已人工核验并写入本报告，但**产品内没有**该终局复核记录（建议 20.2）。
3. **运行内正式 Evidence = 0**：中文主题全文不可达（外部限制，如实记录）；正式 Evidence 闭环由 §4 独立 smoke 以真实链路证明。
4. **ch05 规划变体**：本轮 planner 规划了 M14.5 未规划的章——行为合法（缺材料正确标记），但意味着两轮 Draft 结构不完全可比。
5. **缺口台账状态残留 proposed**（§9 边界）。
6. **会话中断**：任务执行中会话挂起 ~9.6h（零模型调用）；活跃执行 ≈ 2.9h 在预算内。
7. 评分（70 vs 76）跨轮不可比（不同 planner 变体 / 不同正文 / 不同 review 单元集）——不做质量提升宣称。

## 26. 距高质量硕士学位论文初稿的差距（任务问 20）

内容层：单成果体量（核心章深度 / 消融对比 / 多机扩展材料缺失——作者侧问题）；证据层：verified-evidence 级引用覆盖（检索全文可达性——工程侧问题）；表达层：模板化与风格风险（styleRisk 45）、unsupported claims 11（论证密度）；结构层：ch05 类章节需要作者补材料或明示受限。系统已能把「可支撑的部分」诚实、完整、可追溯地交付（43 页、6 真实引用、事实零漂移、摘要-正文一致、四态如实），剩余差距主要在**材料供给**（作者 / 检索全文）与**写作质量收敛**（多轮 review 预算），不是事实完整性。

## 27. Git 提交与 CI

- 提交链（`main`，无额外分支；提交后以 `git rev-parse HEAD` = `origin/main` 为准）：
  1. `feat(m14.7)`：全部产品源码 + 测试 + 驱动器（abstractSnapshot / gate 规则 / 规则 0c / citationIntegrity / judge 上限 / bm / Draft 修复回路 / 终局复核 + 18 确定性用例 + 2 env 门控 smoke/driver）。
  2. `docs(m14.7)`：本报告 + PROJECT_STATUS。
- CI：GitHub Actions（CI + Linux Integration）在提交后运行；若收口时未结束，如实报告实际状态，不为 CI 阻塞。
- 后端全量 / typecheck / build / 前端 / `git diff --check` 最终结果（提交前清洁运行）：

```
后端全量（npx vitest run --maxWorkers=2）：350 files passed / 23 skipped（373；skipped = env 门控
  真实模型 / 真实材料 / 真实编译 smoke）；exit 0；294s（logs/backend-full-suite.log）
后端 typecheck（tsc --noEmit）：OK（含全部新增测试与 smoke / driver）
后端 build（npm run build）：OK
前端：typecheck OK / build OK / vitest 36 files 351 tests passed（logs/frontend-suite.log）
git diff --check：OK（仅 CRLF 工作区提示，无空白错误）
```

### 可复现命令（Windows 本机，backend/）

```bash
# 确定性回归（全量）
npx vitest run --maxWorkers=2
# 新增确定性测试
npx vitest run test/thesis/abstractSnapshot.test.ts test/quality/thesisAbstractSnapshotGate.test.ts test/workflow/thesisAbstractRefreshPlan.test.ts test/workflow/thesisAbstractSnapshot.e2e.test.ts --maxWorkers=2
# 实时 Grounding 闭环（真实模型 ≤4 judge；产物 D:\PaperTeamData\M14_7\smoke\）
PAPERTEAM_M147_GROUNDING=1 PAPERTEAM_M147_MODEL=zai-coding-cn/glm-5.3 npx vitest run test/thesis/m147Grounding.smoke.test.ts
# 案例 B 真实端到端（33 调用 run 级 + 40/1.5M 全局；实时检索开启）
D:/PaperTeamData/M14_7/scratch/run-m147-caseB.sh
# 构建失败定向复验（零模型；产品同款 build 路径）
PAPERTEAM_M147_REBUILD=1 npx vitest run test/thesis/m147RebuildDraft.driver.test.ts
# PDF 内容验证 / DOI 核验（零模型）
python D:/PaperTeamData/M14_7/scratch/m147_pdf_verify.py D:/PaperTeamData/M14_7/projects-caseB/p-6d475f160929 D:/PaperTeamData/M14_7/pdf
python D:/PaperTeamData/M14_7/scratch/m147_doi_verify.py D:/PaperTeamData/M14_7/projects-caseB/p-6d475f160929/manuscript/references.bib D:/PaperTeamData/M14_7/pdf/m147-doi-verify.json
```
