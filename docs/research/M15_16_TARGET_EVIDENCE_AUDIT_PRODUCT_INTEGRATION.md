# M15.16 — Target Journal Evidence Audit 产品接入（P0-A / P0-B）

日期：2026-10-31 · 基线：main @ 3d3c973（M15.15 结束态）
产物状态：`M15_16_PRODUCT_INTEGRATION = COMPLETE`（真实用户路径验收通过；flag 缺省关闭）
里程碑：`M15_TARGET_JOURNAL_QUALITY = INCOMPLETE`（学术质量校准未做，判定不变）

## 0. 一句话

本轮把 M15.15 已验证的「贡献级先前工作证据审计 + 官方投稿要求机检」接入正式产品：
Target 面板新增实验性**证据审计**入口（feature flag 缺省关闭）与 **PDF-only 文献类官方条款机检**；
用户在真实本地服务上以真实模型完成 CJIG 场景端到端验收。系统仍不判断期刊录用水平。

## 1. 交付范围

### P0-A 证据审计（实验性，缺省关闭）

- **服务端** `backend/src/target/TargetEvidenceAuditService.ts`（新）：
  - Pool 三通道（移植 M15.14 `build-pool` 并生产化）：
    A 稿件自引（`ReferenceExtractor` → 共享 `ScholarlyResolver`，Crossref/OpenAlex，缓存+礼貌间隔+telemetry 复用）；
    B 外部检索（`AcademicSearchService`，题名/摘要拉丁词 top-8；**中文稿无拉丁词 → 如实跳过并记 buildNote**——M15.15 空查询根因纪律）；
    C 在库全文升级（候选 × `SourceStore` 身份匹配 DOI>arXiv>compact 标题指纹 → `ChunkStore` 确定性方法节摘录（M15.15 `pickExcerpts` 移植，≤3 段/6000 字符）→ `verified_fulltext` 级）。
  - 复用 `ContributionAuditService` 原样：3 次有界模型调用 + 解析重试物理账、四守卫（锚校验 / pool 身份解析 / 时间因果 / 四态规则）、priorQuote 回放、fulltextBasis 降级。
  - 只读红线：不 import 新 source、不写 EvidenceStore、benchmark role=reference 隔离不触碰（读 chunk 仅作 advisory 材料）。
  - 防陈旧：工件 `inputFingerprint`（manuscriptSha256+poolFingerprint+promptVersion+documentType+venueId）；GET 零网络重算当前稿指纹 + 修订号 → `stale` 标记。
  - 运行元数据 `research/target-evidence-audit-meta.json`：pool 构建统计 / 模型调用账 / 解析失败标志。
- **Feature flag** `PAPERTEAM_TARGET_EVIDENCE_AUDIT_ENABLED`（缺省 false）→ config → serviceStack → `targets.evidenceAudit=null`（缺省）；HTTP：GET 返 `{enabled:false,audit:null}`（前端区块不渲染），POST → 403 `TARGET_EVIDENCE_AUDIT_DISABLED`。
- **路由**：`GET/POST /api/projects/:id/target/evidence-audit`（venueId 自动取自已冻结官方指南工件）。
- **前端** `TargetPanel.tsx` 第 7 区块（仅 enabled 时渲染）：逐贡献（声称 quote+锚+支撑）、最近先前工作（真实标题/年份/DOI/arXiv、内容级 chip、quote 回放状态）、四态徽章、行动清单（可改写 / 需真实实验·Author Decision / 含实验目的）、守卫行、构建说明、陈旧警示、advisory 免责声明。

### P0-B PDF-only 文献类官方条款机检

- `guidelineFacts.ts`：事实源分层——TeX 存在 → 全字段（既有行为零变化）；无 TeX 但有解析产物 → `source:"pdf"`，仅参考文献观测（`pdfReferenceStatsOf`：`ReferenceExtractor` 条目 → entryCount / withYear / recent10y / withDoi，**年份未解析与 DOI 未识别条目数单独披露**）；都无 → `exists:false`。
- `TargetGuidelineService` 判定升级（PDF 口径）：
  - `references.recent10yRatio`：**区间分析**——未解析年份任意取值的占比区间 [low, high]；全区间 ≥ 阈值 → PASS、全区间 < 阈值 → VIOLATION/ADVISORY、跨越阈值 → `NOT_EVALUATED(pdf_year_parse_indeterminate)` 并披露区间；
  - `references.doiCoverage`：逐条可辨识 = 每条印有 DOI → PASS；部分未识别 → `NOT_EVALUATED(pdf_doi_coverage_indeterminate)`（印刷 DOI 解析失败与作者未提供在 PDF 上不可区分，**绝不判 VIOLATION**）；
  - `references.count`：PDF 条目口径 PASS/VIOLATION（含风格与抽取器备注披露）；
  - 非参考文献字段：`NOT_EVALUATED(pdf_no_observation_point)`（缺要素 ≠ 可判违规）；
  - 渲染/排版类保持 `no_deterministic_checker`。
- **ReferenceExtractor v4**：出版年解析剔除 DOI/arXiv id/URL 标识符 span（arXiv `2004.10934` 内的 "2004" 不再当出版年）——P0-B 年份口径严谨性；条目切分/DOI 提取行为不变（回归锁定）。
- **回归 fixture** `backend/test/target/fixtures/cjigPdfReferenceStats.json`：7 份 CJIG PDF 脱敏结构化导出（逐条仅 number/year/hasDoi/hasArxiv），由 `scripts/m1516/build-cjig-fixture.mjs` 生成；**合计 465 条 / DOI 405 与 M15.15 金标准逐数一致**；本地样本存在时对拍重跑（CI 无样本 skip）。

### 衔接（边界内）

gapPlan 工件字段（actionType 四态 + experimentPlan + status=author_decision）即「供将来 Revision 消费的稳定只读结构」——本轮不自动执行论文修改、不伪造数据。

## 2. 真实用户路径验收（Phase D）

环境：真实 backend（生产栈、Pi runtime、生效模型 glm/claude-opus-5-5 经共享网关）+ vite dev 前端；`PAPERTEAM_TARGET_EVIDENCE_AUDIT_ENABLED=true`。原始数据：`D:\PaperTeamData\M15\M15_16\`（MANIFEST 含 SHA256；验收后测试项目已删除，工件已归档）。

| # | 验收项 | 结果 |
|---|---|---|
| 1 | case-R（CJIG 中文 PDF-only）导入 → 冻结 CJIG 指南 → 合规机检 | `references.count` PASS（41 条，PDF 口径披露）；`references.recent10yRatio` PASS（80%，区间 [80%,80%]——年份全解析）；`references.doiCoverage` NOT_EVALUATED（39/41 可辨识，2 条已知缺失形态如实呈现）；其余 9 条 NOT_EVALUATED 各带原因；CEA 差分：仅 4 条官方要求、无 DOI/近10年条款——**差异来自官方明文，非 CJIG 结论复制** |
| 2 | 证据审计（HTTP，case-R×CJIG，含在库 DBNet role=reference） | pool 12（**verified_fulltext 1**（DBNet 身份匹配 DOI→chunk 摘录升级）/ abstract 2 / metadata 9）；自引解析 18/20（真实 Crossref/OpenAlex）；模型 3 次 187s；**守卫全 0**；C4 链条：稿件原文锚 → DBNet 真实身份（doi:10.1609/aaai.v34i07.6812，pool_fulltext）→ quote 回放通过（`priorQuoteVerified=true`）→ 实现级比较（basis=fulltext）✓ |
| 3 | 研究论文实验缺口语义（case-R） | gapPlan 5 项全部 `requires_real_experiment_or_author_input` + `status=author_decision`（消融/基线/方差缺口，含 experimentPlan；不编造数字） |
| 4 | 换稿（b1 覆盖上传）→ GET | `stale=true`，`staleReason="稿件内容已变更（artifact 指纹 3da85… ≠ 当前 66212…）"` |
| 5 | b1（英文综述稿，documentType=survey）审计 | pool 12 全 abstract；gapPlan 5 项中 **4 项 `can_rewrite_from_existing_evidence`**（比较/归因/前后一致性缺口）；仅 1 项 requires_real（MOTA 排名分歧的度量学证据——claim-support 缺口，非「无原创实验」惩罚）✓ 综述不被错误阻断 |
| 6 | **浏览器真实点击**（Chrome DevTools Protocol，非 mock） | 打开 `/projects/:id?tab=target` → 断言空态 → **点击「执行证据审计」→ 真实模型 4 次 157s → 报告渲染**：4 贡献块（CJK 声称 quote 锚定）、先前工作身份（doi:）、四态徽章、行动清单两种语义 + Author Decision 注记、advisory 免责声明（DOM 断言 + 截屏 `e2e/ui/01-caseR-cjig-audit-report.png`）；b1 fresh 报告与 case-R stale 警示均渲染 ✓ |
| 7 | flag off（缺省） | GET `{enabled:false}`、POST 403；前端区块不渲染（UI 测试锁定）；全量回归中原有路径零变化 |

本 UI 轮 `anchorFailures=1`：模型产出一条无法在稿件逐字回放的声称 quote，被锚守卫**丢弃并计数**（不带病入工件）——守卫在真实路径触发，符合预期。

## 3. 成本 / 延迟（真实账）

| 运行 | 调用 | 延迟 | prompt chars | output chars |
|---|---|---|---|---|
| case-R×CJIG（HTTP） | 3 | 187s | 69,013 | 27,597 |
| b1 survey（HTTP） | 3 | 116s | 56,639 | 25,262 |
| case-R（UI 点击） | 4（含 1 次解析重试） | 157s | 55,317 | 22,663 |
| **合计** | **10** | — | ~181k in / ~75k out chars | |

粗估（gateway 定价未知，按 Opus 量级 $5/M in、$25/M out 折算 ≈0.13M tokens）：**三次合计 ≈ $0.8，单次审计 ≈ $0.2–0.3、2–3 分钟**。quote replay failure / downgrade：三次运行全部为 0（A5 轮 fulltext quote 回放成功）。结论：正常用户单次运行经济。

## 4. 三类证据分离（不变量复核）

官方 guideline（`target-guideline.json` 冻结快照）/ benchmark 观测带（`target-profile.json`）/ 贡献审计（`target-contribution-audit.json`，`provenance.basis="model_judgment_advisory"` + 免责声明）三工件三区块并列，互不冒充；面板无总分、无「达到期刊水平」按钮；`gates.ts`/`qualityPolicyV2`/N1/N2/H **零改动**（git diff 确认 quality/ 与 gates 无变更）；不输出录用概率。

## 5. 测试

- 新增：`backend/test/target/targetEvidenceAudit.test.ts`（15：纯函数/pool 三通道/空查询纪律/cutoff·自引·去重/解析错误计数/服务编排 fail-closed/工件+meta/陈旧/装配缺省关/PDF facts 分层）；`cjigPdfReferenceRegression.test.ts`（5：金标准一致/逐条-聚合自洽/真实统计上的区间判定/已知 2 条 DOI 缺失形态/本地对拍）；`targetGuideline.test.ts` +6（PDF 区间三分支/DOI 不可辨/字段无观测点/双输入 TeX 优先）；`targetHttp.test.ts` +2（flag 双态路由契约）；`frontend/TargetPanel.test.tsx` +3（off 不渲染/空态点击真实 API/报告渲染+陈旧）。
- 全量：backend **412 files / 4518 tests 全绿**（首轮 2 例 skills 超时为前端套件并行资源争抢——串行复跑全过，无新增确定性失败）；frontend **38 files / 367 tests 全绿**；backend+frontend `tsc --noEmit` 双双真实执行通过（M15.13/15 教训）；frontend `vite build` 通过；`git diff --check` PASS。

## 6. 复现路径

1. `cd backend && npm run build && PAPERTEAM_TARGET_EVIDENCE_AUDIT_ENABLED=true PAPERTEAM_PORT=<p> node dist/index.js`
2. `cd frontend && PAPERTEAM_PORT=<p> npx vite`
3. 前端导入 PDF 论文建项目（existing_paper_review）→ 目标投稿页 → PUT guideline（工件：M15_9 cjig.json/cea.json）→ 逐条对照 → 执行证据审计。
4. 脚本化驱动：`node scripts/m1516/e2e-acceptance.mjs --base http://127.0.0.1:<p>`（HTTP 全链）；`node scripts/m1516/ui-acceptance.mjs`（浏览器真实点击，需 vite 已起）；fixture 再生成：`node scripts/m1516/build-cjig-fixture.mjs`。

## 7. 未覆盖 / 风险 / 下阶段

- **未覆盖**：CEA PDF 版式（M15_9 语料无 CEA 全文——观测带仍摘要级，不以 CJIG 带冒充）；纯中文作者开头条目（金标准已知限制）；Rubric/审计的专家校准（M15 仍 INCOMPLETE 的原因，不变）；verified_fulltext 依赖用户在库全文（本轮单篇 DBNet 升级验证；大规模在库匹配未压测）。
- **风险**：模型输出年解析重试（本 UI 轮 1 次）会 +1 调用；中文稿外部检索通道常跳过（自引通道为主——检索增强是可选后续）；`arxiv.org/abs` 著录的年份在 v4 后依赖 span 剥离（fixture 锁定）。
- **下阶段建议**：gapPlan → Revision 消费的接线（`requires_real_experiment` → Author Decision 队列已有语义基础）；CEA 全文语料获取后补观测带；多在库全文时 pool 升级的规模化评估。

## 8. 裁决

- **M15_16_PRODUCT_INTEGRATION = COMPLETE**——P0-A/P0-B 功能落地、flag 缺省关、真实用户路径（含浏览器真实点击与真实模型）验收通过、全量回归绿。
- **M15_TARGET_JOURNAL_QUALITY = INCOMPLETE**——独立学术质量校准未完成，本轮一切输出仍为 advisory，不构成录用判断。
