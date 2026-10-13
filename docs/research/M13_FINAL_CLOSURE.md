# M13 Final Closure — Production Writing Reliability, Scientific Integrity & Full Workflow Acceptance

日期：2026-10-13。执行环境：公司 Windows 工作站 `D:\Projects\PaperTeam`（Node 22.22.3 / Python 3.11.9 / MiKTeX XeTeX 4.16 + BibTeX 4.2 / docling 2.130.0）。全部工程、测试、真实模型调用、PDF 编译在本机完成；未触碰新加坡 ECS、AutoDL、远程 Docker、GPU；未新增数据库。真实模型验收通过既有 PiRuntimeAdapter（生产等价接线）调用 Z.AI Coding Plan 通道 `zai-coding-cn/glm-5.3`；用户的模型偏好（`glm/claude-fable-5-1`）与 `~/.paperteam` 授权文件只在原位读取，未修改。本机同时运行着用户自己的 PaperTeam dev 栈（端口 3000，项目 `p-14afa81bd7fa`，RealPaperRound2 监控）——本轮全部验收使用独立数据根 `D:\PaperTeamData\M13_Final_Closure\projects`，未触碰该项目。Claude Code（Fable 5.1）只做工程、人工核对与报告，不计入论文工作流的模型用量。

**裁决：`M13 PARTIAL — BLOCKERS REMAIN`。** 本轮范围内的科研事实缺陷（A1–A4）与 Reviewer 方差复核（B）全部以确定性代码 + 回归测试 + 历史真实数据重放落地，守卫只增不减；真实 Topic → PDF 从「创建项目」入口在生产 Orchestrator 上**完整执行到合法终态**（Draft / QUALITY_NOT_REACHED；重跑终态 Draft / build gate 失败），并暴露并修复了 3 个此前任何夹具验收都没有触发的生产缺陷。但两件事阻止把 M13 判为 COMPLETE：(1) 真实检索在本机网络条件下只能得到摘要（arXiv PDF 下载 60 s/1.3 MB、OpenAlex / Semantic Scholar 匿名池 429、Retry-After ≈ 18 h），而**综述工作流在「全部来源仅有摘要」时不产生任何正式 Evidence**（Fact Reviewer 无可绑定、Quality Gate 结构性不可通过），这是产品缺口而非守卫过严；(2) 重跑虽然真实编译出 7 页中文 PDF（`build/main.pdf`），但修订 Writer 把引用 key `huang2024mambamot` 误写为 `huang2024mabbamot`，bibtex 缺条目 → build gate 如实判失败、Draft 工件未登记——该漏洞已在 `revision.validate` 层 fail-closed 修复（真实快照重放证明会被拦截），但预算（66 / 80 任务）不足以再做一次完整复验。M13.0–M13.6 与 M13 Stability 的既有 PASS 不变；M13.7 的写作质量结论最终定为「B2 结构性收益成立、有害重复无可信改善」。**NOT READY_FOR_M14**（两项阻断见 §15；清除路径明确、工程量有界）。

---

## 1. Executive Summary

| 维度 | 结果 |
| --- | --- |
| 起始 / 结束 Git | 起始 `eff150b0da3a7f2a71ff326ca74311fcdc79b7b2`（= origin/main = GitHub main，CI + Linux Integration success）；工程提交 `10c1f33`（LIVE 前冻结：A1–A3 + B + 驱动）、`094eebb`（A4 + run 1 缺陷）、收口提交 = 本报告所在 HEAD（以 `git rev-parse HEAD` / origin/main 为准） |
| A1 否定性命题 grounding | 新增 `claimStance`（refutation / uncertainty / assertion 三立场）+ 四条件联合判定；历史真实项目 p-8ddfa9fda825 r2/r3/r4 恰好只翻转那条被阻断三轮的拒绝句，其余 claim 零变化；用户真实返修项目 8 轮 18–27 条 UNSUPPORTED 零变化 |
| A2 Reviewer → Revision 污染 | 审稿意见「不是事实证据」进入 Reviewer / 修订 Writer / 摘要分支三处 prompt；新增确定性 Named Reference Provenance Guard（候选级 + 摘要级 + revision.validate 级）；真实重放 0 误报 |
| A3 Planner partial 升级 | 大纲 prompt 规则 2b；Planning → Writing 边界一次性 keyPoint 标注（精度优先，有记录的已知盲区） |
| A4 句级归因 | 新增多 key 引用归因稀释信号（只读产物 + fact 模式 digest）；真实 run 中 11 个多 key 句全部因「key 无证据」被如实跳过，0 误报 |
| B Reviewer 方差 | 有界对称带内复核（[75, 85) 触发、≤ 2 份额外采样、中位数、事实类 finding 并入、意见类须跨样本重现）；生产默认开、测试栈默认关；Gate 阈值与双层终态零改动 |
| C B2 最终定论 | 结构组织改善成立；有害重复无可信改善（撤回该主张）；真实 Topic → PDF 稿件有害重复下界 1.0% / 上界 2.2%、词面 26%；默认保持开启 |
| D Topic → PDF | 真实执行：创建项目 → 10 条检索 → 55 候选 / 14 入库 → 14 篇 abstract_only → 矩阵 14 → 综合 8 → 大纲 9 节 → 写作 9 节 → citation.verify → 三路 review → gate FAIL → 修订 → validate（fact preservation 拒绝、restore）→ 复审 → stalled → accept_draft → build.draft；run 1 编译失败（摘要下划线，已修）；重跑编译出 7 页 PDF 但 bibtex 缺条目 → 工件未登记 |
| 真实运行缺陷（修复） | ① 摘要纯文本未转义 `_ & # %`（`writeMainTex`）；② 文献库状态词泄漏正文（synthesis 文案 + Writer 规则 9）；③ 修订新增不存在的 cite key 只记提示不拒绝（`citation_unknown_key` fail-closed） |
| E 回归 | 研究论文实验门禁 / 已有论文返修（M11.4 38 + 16 + 5 + Revision Fidelity 29 + …）全部通过；无真实实验数据夹具重用 |
| 测试 | 后端全量 vitest 两次（修改前基线 295 文件 / 3269 通过；收口 HEAD 见 §14）；前端 334 通过；typecheck / build 前后端通过；`git diff --check` 通过 |
| 模型用量 | 66 Runtime 任务 / 76 assistant turns（上限 80 / 120）；非缓存 input 197,505 / output 41,552 / cacheRead 813,312；SDK estimatedCost 0.6708（不是账单）；模型侧 981 s；两次 run 墙钟 18.2 + 9.2 分 |
| 资源 | 驱动进程 RSS 峰值 191 MB；系统可用内存最低 4.58 GB（32 GB 机器，同时运行用户 dev 栈 + Claude Code）；无 docling 子进程启动（全文 0/14）；LaTeX 两次编译正常退出 |

## 2. M13 各子阶段实际状态（审计，不重测已有证据）

| 子阶段 | 状态 | 依据 |
| --- | --- | --- |
| M13.0 Storage Decision | COMPLETE（`DATABASE_DECISION = NO_GO`，文件后端保留） | `M13_0_STORAGE_ARCHITECTURE_ASSESSMENT.md`；本轮未引入任何数据库 |
| M13.1 File-backed reliability Batch 1/2 | COMPLETE | `M13_1_CODEX_HANDOFF.md`（EvidenceStore 前向兼容、Figure write-ahead / SHA-256 恢复、SIGKILL 子进程测试） |
| M13 Stability Hardening Batch 3 | COMPLETE | `M13_STABILITY_HARDENING_BATCH3.md`（RevisionStore 损坏 fail-closed、restore intent、ExternalInstructionStore 并发） |
| M13.2 Experiment Packages | PASS（Browser 目录上传 NOT_IMPLEMENTED 如实保留） | `M13_2_EXPERIMENT_PACKAGE_ACCEPTANCE.md` |
| M13.3 Real Experiment Acceptance | PASS（带限制） | `M13_3_REAL_EXPERIMENT_ACCEPTANCE.md`；本轮 `test/experiments/*`（47 用例）全绿 |
| M13.4 Model Provider UX | COMPLETE | `M13_4_MODEL_PROVIDER_UX_ACCEPTANCE.md`；本轮公司网关配置原位可用（`GET /api/runtime/status` healthy） |
| M13.5 / 13.5.1 / 13.5.2 | COMPLETE | 真实工作流就绪、上传可靠性、输出截断处理；`experimentSplitScopes` / `experimentUpload.proxy.http` 全绿 |
| M13.6 Experiment Onboarding + 429 Recovery | COMPLETE | 本轮真实 run 的 `ScholarlyHttpClient` 行为可观测：OpenAlex Retry-After 64,880 s 超过单请求等待帽 → 让位并冷却 120 s、恢复轮补查、「如实返回不可判定」（§7.4） |
| M13.7 Research → RAG → Evidence | PASS（本阶段范围） | `M13_7_RESEARCH_RAG_EVIDENCE_ACCEPTANCE.md` |
| M13.7.2–7.9 | 各报告结论不变（7.9 PASS — Ready for Production Integration） | 本轮不重测 |
| M13.7.10 / 7.11 B2 生产集成与 E2E | 工程 PASS；质量结论本轮定论（§6） | 本轮 |
| M13.7 收口 | **PARTIAL → 本轮定论**：事实边界缺陷全部修复；写作质量结论见 §6；Topic → PDF 见 §7 | 本轮 |

`docs/PROJECT_STATUS.md` 此前只登记了 M13.0 / 13.1 / 13.2 / 13.3 / Batch 3，缺 M13.4–M13.7；本轮补齐索引（只补事实，不新增功能宣称）。

## 3. 起始基线与真实 Git 状态

- 开始：`main` = `eff150b0da3a7f2a71ff326ca74311fcdc79b7b2`，工作区干净，GitHub CI（#38345020452）与 Linux Integration（#38345020445）均 success。
- 首个 LIVE 请求前冻结：`10c1f33`（A1–A3 + B 的生产代码与测试、`topic-to-pdf-live.mjs` 驱动、`claim-grounding-replay.mjs`）。全部 LIVE 请求期间 `backend/dist` 为该提交的构建（run 1）与 `094eebb` 的构建（重跑；差异 = A4 只读信号 + 状态词文案 + 摘要转义，全部在 run 1 之后修改并 build）。
- 本轮没有创建分支、没有安装依赖、没有修改 `auth.json` / `model.json`、没有打印任何密钥。

## 4. 本轮发现与修复的缺陷

| # | 缺陷（真实样本） | 根因 / 坐标 | 处理 |
| --- | --- | --- | --- |
| 1 | 对 partial 命题的正确拒绝句「G=2.27 与 2.4 倍寿命超越并非同一指标，不可据此判定优劣」被改判 UNSUPPORTED，三轮阻断 gate，resolution 要求删数值（M13.7.11 §5.4） | `claimGrounding.ts` `meetsEvidenceSupportQuality`：含任意数字的 claim 绑 partial 一律 fail；claim 无立场字段 | **修复**：`review/claimStance.ts`（见 §5.1）；`claimResolution.ts` 阶梯 4c `author_decision_required`；`weakeningAuthorization.ts` 不为锚定数值铸「只许删除」授权 |
| 2 | Reviewer 点名「2021 Krinner 等阈值实验」→ 修订把「阈值实验、早期重复码演示」写进摘要限制句（M13.7.11 §5.4） | 修订 Writer prompt 规则 6 豁免「问题清单中出现的内容」；摘要分支无事实冻结规则；无任何守卫识别无数字的具名文献 | **修复**：三处 prompt（§5.2）+ `review/namedReferenceGuard.ts` 接入候选管线 / 摘要路径 / `revision.validate`（新拒绝类别 `named_reference`）+ 前端标签 |
| 3 | 真实 Planner 把 partial E012 写成比较维度 keyPoint「寿命增益维度的直接可比性（G 与寿命倍数）」（M13.7.11 §6） | 大纲 prompt 对 partial 零指引；keyPoints 原样进 Writer | **修复**：`buildOutlinePrompt` 规则 2b；`writer/partialKeyPoints.ts` 在两条写作 stage 的 Planning → Writing 边界一次性标注（§5.3） |
| 4 | 「微波腔光子数态等离散变量…\cite{ni, sivak}」：Ni 独有机制让 Sivak 共同承担（M13.7.9 §11） | 全部既有层按「组共同支撑」口径工作，没有层比较每个 key 与句子（审计 §5.4） | **新增信号**：`review/multiKeyAttribution.ts`（精度优先、只读、仅 fact 模式 digest） |
| 5 | 同一冻结稿三次 review PASS / FAIL / FAIL(2 major + 79)（M13.7.11 §5.4） | M11.3 量化的方差；阈值 80 在分布中心 | **新增机制**：`review/academicConfirmation.ts` 带内复核（§5.5） |
| 6 | **真实 run 1**：`build.draft` 编译失败 `Missing $ inserted`——摘要含 `track_query_based` | `writeMainTex` 把纯文本摘要原样放进 `\begin{abstract}`；章节 .tex 由 Writer 正确写成 `\_` | **修复**：`escapeAbstractPlainText`（只转义未转义的 `_ & # %`，不碰 `$ { } \`）；测试 +1；重跑编译通过 |
| 7 | **真实 run 1**：正文出现「其余 13 篇文献均处于未归类状态，尚待人工修正其 taxonomy 标签」「unclassified」（style major） | `SynthesisService.buildTaxonomyItems` 把工作流指令写进 synthesis claim；Writer 无状态词纪律 | **修复**：synthesis 文案改为学术表述 + 综述 Writer 规则 9；测试 +2 |
| 8 | **真实重跑**：修订 Writer 把 `huang2024mambamot` 写成 `huang2024mabbamot`，`revision.validate` 只记提示（uncoveredAddedKeys），下一轮 citation.verify / gate 才判失败，bibtex 缺条目 → build gate 失败 | 综述章节级修订不经过 span 候选管线（无 `citation_hallucinated` 检查）；validate 的新增 key 只有「无 evidence 支撑」提示级口径 | **修复**：`revisionValidation.ts` 新增 `knownBibKeys` 输入，新增 key 不在 bibliography → 条目 rejected（`citation_unknown_key`，fail-closed）；`revision.validate` stage 传入 bib keys；真实快照重放 rev3 → rev4 由 ok=true 变 blocked=true（§5.6）；测试 +1 |
| 9 | 真实 run：全文下载 0/14（arXiv PDF 60 s/1.3 MB → 超时 → 连续失败 ≥ 3 熔断；1 篇 37 MB 超 20 MB 上限） | 外部网络；熔断为设计行为 | **记录**（§7.3、§15）；注意「超大小上限」目前也计入熔断连续失败 |
| 10 | 真实 run：推荐集按年份降序 + 仅 arXiv 可用 → 14 篇多为 2024–2026 外围工作（点跟踪 / 单目标 / 多模态 VOT），奠基工作（TransTrack / TrackFormer / MOTR）未入选，taxonomy 13/14 unclassified | `recommendedSurveyCandidateIds` 按「学术形态优先、年份降序」，与主题相关性无关；OpenAlex / S2 429 | **记录**（产品限制；HITL literature_selection 正是用户修正点）。验收按系统推荐集截断，不按内容挑选 |

## 5. Grounding / Reviewer / Planner 事实安全验证

### 5.1 A1：claimStance（否定性命题）

设计（`backend/src/review/claimStance.ts`）：
- 三立场：`refutation`（并非同一指标 / 分属不同…指标 / 不可|不能|无法 + 判定|比较|换算|排序|等同… / 不构成|不等价于|不意味着 / 英文 not comparable / cannot be used to rank…）、`uncertainty`（尚无法判断 / 仍是开放问题 / 有待验证 / 尚无证据表明 / 能否…尚无定论…）、其余 `assertion`。**否定形态的事实断言（未超越 / 不优于 / 低于 / 未达到）仍是 assertion**——否定词 ≠ 拒绝命题。uncertainty 先于 refutation 判定（「现有证据尚无法判断」同时含两类谓词时取不确定性）。
- 豁免四条件（缺一不可）：立场 ≠ assertion；绑定记录 `supportStrength === "partial"`；claim 的全部特征数字（小数 / ≥ 3 位整数，去年份）锚定在正式证据池任一记录；claim 与该 partial 记录词项重叠 ≥ 2。满足 → 保持 PARTIALLY_SUPPORTED（**不升为 SUPPORTED**），`supportBoundary` 记录依据，entry 新增 `stance` / `numbersAnchored`。不满足 → M11.3 原口径。
- resolution 阶梯新增 4c：UNSUPPORTED 的拒绝 / 不确定性立场 + 数字全部锚定 → `author_decision_required`（basis `refutation_numbers_anchored` / `uncertainty_numbers_anchored`），不再「数值只许删除」；context 未提供证据池 → 保守回落数值阶梯。`deriveClaimGroundingWeakeningAuthorizations` 对该类 claim 不铸 `remove_unsupported_detail`。
- 对抗测试（`claimStance.test.ts` 16 + `partialRefutationGrounding.test.ts` 15）：池外数值（3.1 倍）→ 仍 UNSUPPORTED；否定形态事实断言「并未超越盈亏平衡」→ UNSUPPORTED；正面可比性主张 → UNSUPPORTED；reviewer 自判 UNSUPPORTED → 不升级；绑 direct → 行为不变；无数字拒绝句绑 partial → 仍 PARTIALLY（原口径）；gate 规则 `unsupported_critical_claims_zero` 修复前后对照。
- **历史真实数据重放**（`scripts/acceptance/claim-grounding-replay.mjs`，只读；产物 `D:\PaperTeamData\M13_Final_Closure\replay\*.json`）：

| 项目 | 轮 | 修复前 sup/part/unsup/opaque | 修复后 | 变化 |
| --- | --- | --- | --- | --- |
| p-8ddfa9fda825（M13.7.11 Arm B） | r1 | 18/0/0/0 | 18/0/0/0 | 0 |
| | r2 | 14/2/1/1 | 14/3/0/0 | 1：那条拒绝句 UNSUPPORTED → PARTIALLY（stance=refutation，anchored） |
| | r3 | 13/3/1/1 | 13/4/0/0 | 1（同句另一措辞） |
| | r4 | 15/2/1/1 | 15/3/0/0 | 1（「分属不同实验的指标设定」措辞） |
| p-14afa81bd7fa（用户真实返修项目，只读） | r1–r8 | unsup 18/18/27/25/25/22/21/21 | 完全相同 | **0 verdict 变化**（opaque 计数差异来自重放未传 authorizedObservations，与本修复无关） |

即修复精确命中 M13.7.11 的真实阻断，不放宽任何其它 claim。

### 5.2 A2：Reviewer Finding → Revision 事实污染

- 数据通道审计（代码事实）：finding `description` + `suggestedAction` → 计划条目 `problem` / `instruction` → Writer issue `description = problem（计划要求：instruction）` + `（建议：…）`——意见文本两次原样到达 Writer；修订 prompt 规则 6 曾写「不得新增本章节当前内容**与问题清单中**都不存在的…」（意见里的内容被豁免）；摘要分支没有事实冻结规则；`revision.validate` 的 added facts 只认数字 / 表格 / 公式 / 硬件 / 强化标记。
- 修复：Reviewer 三路共同纪律（意见是修改方向不是事实证据；缺口类意见只以类别描述）；修订 Writer 规则 6 去掉豁免 + 新增 6b（意见点名的文献 / 实验 / 机制若不在 Evidence 中不得写入正文，包括限制句）+ 摘要分支 3b；问题块标题标注「审稿意见 = 修改方向，不是事实证据」。合法学术语言优化不受影响（规则 7 / 7b 不变；意见文本仍完整到达）。
- 确定性守卫 `review/namedReferenceGuard.ts`：拉丁具名词（首字母大写 ≥ 3 字符——仅 CJK 主导稿件；内部大小写混排 ByteTrack / 全大写缩写 GKP；作者引用形态 Krinner 等 / et al. / (2021)），允许词表 = 修订前全部稿件文本 + 证据池 claim / quote / 标题 / 作者 + 参考文献 key / 标题；**审稿意见与计划文本不在允许词表内**。接入三处：候选 patch 循环（`unsupported_named_reference` → 有界修复）、摘要路径（一次修复，仍失败则保留原摘要、`targetChanged=false`）、`evaluateRevisionValidation`（新类别 `named_reference` → rejected → `hitl.revision_validation`）。测试 10 + 2。
- 真实数据：两次真实修订（rev1 → rev2、rev3 → rev4）重放 `namedReferences = []`——0 误报；本轮真实 run 没有出现意见文献泄漏样本（无正例可展示，正例来自 M13.7.11 的真实样本并以单测锁定）。

### 5.3 A3：Planner 的 partial 升级

- `buildOutlinePrompt` 规则 2b：partial = 待核验命题，只能作待研究问题 / 比较维度 / 研究空白，keyPoints 用「尚不能判断 / 待核验」口径，不得写成结论、不得钉给 framing / conclude、术语只能来自 Evidence 文本。
- `writer/partialKeyPoints.ts`：肯定式 keyPoint 与某条 partial 记录词面高度重合（≥ 5 项且 ≥ 30%，或 ≥ 7 项，或共享特征数字且 ≥ 3 项）且无 direct 记录同等支撑 → 追加「待核验命题：partial 证据 E0xx 仅提出该命题…」标注。只标注不删除、幂等、内存副本（落盘大纲与写作计划指纹不变）；两条写作 stage（普通 / 综述）共用一处。
- **已知盲区（以测试记录）**：Planner 改写后的维度名「寿命增益维度的直接可比性（G 与寿命倍数）」只共享 4 项 / 23%，不会被标注——该情形由 compare 任务块的 partial 命题清单与规则 2b 覆盖；逐字搬运 partial 片段的要点会被标注（可接受的口径提示）。
- 本轮真实 run 的正式证据池为空，该守卫未被触发（0 条标注）。

### 5.4 A4：句级 claim / citation 归因

审计结论（读码）：Citation Integrity 的 judge 明确按「引用组共同支撑、不要求任何一篇单独覆盖」口径（`semanticVerifier.ts`），且只处理已上传 PDF 的 callout；Fact Reviewer 每条 claim 只有一个 `evidenceId`；`writingInvariants.multiKeyCiteRatio` 还奖励多 key 形态——**没有任何层会抓到「Ni 独有机制 + \cite{ni,sivak}」**。新增 `review/multiKeyAttribution.ts`：句子含多 key cite、每个 key 都有正式证据、句子含机制 / 数字内容、无分述标记（分别 / 前者后者 / respectively），且区分性词项恰好只命中一篇 ≥ 2 项其余零命中 → 记一条 finding（attributedKey / uncoveredKeys / matchedTerms）。产物 `reviews/citation-attribution-r{n}.json`；只注入 fact 模式 prompt（academic / style 逐字节不变）；不是 gate 规则、不自动改稿。测试 7 + 1。真实 run：r3 5 句 / r4 6 句多 key 引用全部 `key_without_evidence` 跳过（证据池为空）——0 误报，也说明该信号依赖正式证据存在。

### 5.5 B：Reviewer / Quality Gate 稳健性

- 事实基础：M11.3 5 次采样 academicScore 75–84（σ 3.3）、fact verdict 26/26 一致、finding 枚举不稳定；M13.7.11 同稿 PASS / FAIL / FAIL。
- 机制（`review/academicConfirmation.ts` + `review.run` 接线）：主 academic 样本分数 ∈ [threshold − band, threshold + band)（缺省 5 → [75, 85)）→ 追加 ≤ 2 份独立 academic 采样 → **中位数**进 gate；fact / evidence_gap / citation / build 类 critical / major 任一样本发现即并入（稳定事实错误不因其它样本未发现而忽略）；academic / style 类 critical / major 只有 ≥ 2 份样本在同一章节都给出才并入（单样本意见级 major 不阻断）；minor 只保留主样本。对称带 = 不偏向 PASS 也不偏向 FAIL。全部样本落盘 `academic-confirmation-r{n}-s{k}.json`，`summary.academicConfirmation` 与 gate 规则 7 明细可解释。配置 `QUALITY_ACADEMIC_CONFIRMATION_BAND` / `_SAMPLES`（生产缺省 5 / 2；`buildServiceStack` 缺省 0 = 关，scripted harness 行为不变）。
- 不触及：Gate 阈值 / 规则集、`Revision Task Success` vs `Publication Readiness` 双层判定、M11.4 不变量、no-progress / Author Decision 边界。
- 测试：聚合逻辑 10 + scripted e2e 接线 2（band=5 → 3 份采样、中位数、落盘；band=0 → 1 份、无字段）。真实 run：四轮 academicScore 64 / 64 / 63 / 70 均低于带下界，未触发（LIVE N/A，如实记录）。

### 5.6 真实 run 缺陷的确定性收口

- 摘要转义：`Manuscript.test.ts` 新增用例（`_ & # %` 转义、已转义不重复）；重跑 `xelatex` 三遍正常。
- 未知 cite key：`revisionValidation.test.ts` 新增用例；`scripts/acceptance/revision-validation-replay.mjs`（只读）对真实项目快照重放：

| 修订 | 落盘的 validate 结论（当时） | 当前 dist 重放 |
| --- | --- | --- |
| rev3 → rev4（修订 Writer 误写 `huang2024mabbamot`） | ok=true、blocked=false、仅 `uncoveredAddedKeys` 提示 | **blocked=true**：taxonomy 节 3 个条目 rejected（`citation_unknown_key`），其余 9 条目 validated；namedReferences = [] |
| rev1 → rev2（摘要 2023 → 2024） | blocked（fact_preservation） | blocked（fact_preservation，同一条目）——M11.4 口径不变 |

## 6. B2 写作质量最终结论（任务 C）

依据：M13.7.9（夹具 held-out：9.8% → 0.0%）、M13.7.10（真实 Planner：9.8% → 7.0% / 8.6%，非等价 baseline）、M13.7.11（同条件生产 A/B：A 0.0% 已低于区分度下限、B 4.1%）、本轮真实 Topic → PDF 稿件（生产只读报告 `academic-redundancy-rev1.json`：66 句 / 3626 字，有害下界 1.0%（1 句 M）/ 上界 2.2%，词面复述 26%，路标句 0，角色 framing / develop×2 / compare×4 / conclude×2 全部合法）。

| 判断 | 结论 |
| --- | --- |
| B2 确实改善结构组织 | **成立**（framing / conclude 文献身份表、compare 节逐条处理 partial、无 `\ref` 路标段、conclude 短；本轮真实稿路标句 0） |
| B2 确实改善有害重复 | **不成立 / 撤回该主张**（同条件 A/B baseline 本身 0.0%；单样本；本轮无对照臂） |
| B2 无实质性回归 | 成立（事实 / 引用 / Gate / 编译 / Resume 全部通过；本轮真实 run 必保事实无夹具可核，引用越界 0） |
| 数据不足以判断的指标 | 有害重复的可计量改善（需 ≥ 3 个独立主题的同条件 A/B，本轮不做） |

决定：B2 保持生产默认开启（`PAPERTEAM_ARGUMENT_UNIT_WRITING` 可关）；M13 完成判定不以「有害重复显著下降」为条件。

## 7. Topic → PDF 真实 Workflow 执行记录（任务 D）

### 7.1 主题与入口

- 主题：「基于 Transformer 的端到端多目标跟踪方法综述」（中文；研究领域「计算机视觉 / 多目标跟踪」；`yearFrom=2020`）。理由：arXiv 开放全文丰富、是作者本人研究方向（M14 学位论文可复用）、不是任何 fixture 使用过的主题。
- 入口：驱动 `scripts/acceptance/topic-to-pdf-live.mjs`（dist 生产模块 + 进程内 HTTP server + 生产 `WorkflowOrchestrator`）：`POST /api/projects {title, documentType:"survey", language:"zh", researchField}` → `POST /api/projects/:id/workflows {kind:"topic_survey", yearFrom}`。**无 replay、无 seeding、无冻结大纲、无伪造 Evidence**；安全检查拒绝默认 projects 根与其它活动 run。
- HITL 协议（LIVE 前固定，逐次落盘 `result.hitl`）：research_plan → approve；literature_selection → approve 并提交候选集 = 系统推荐集（学术形态优先、年份降序）∩ arXiv 优先，截断 14（带宽 / docling 时长上界，**非内容挑选**）；matrix_confirm / outline_confirm → approve；revision_validation → `reject`（恢复，绝不 approve 覆盖守卫；最多 2 次后 needs_review）；revision_stalled / overflow → accept_draft。未注入任何 reviewer 判定、证据、来源或 gate 结果。

### 7.2 Run 1（`p-47370dc6a0f0` / `w-5627960b9fee`，18.2 分，50 任务）

| 阶段 | 真实结果 |
| --- | --- |
| research.plan | 1 任务（33 s）：5 个研究问题、6 族 taxonomy 意图、10 条查询（8 academic + 2 web） |
| survey.search | 8/10 执行（2 web 失败：SearXNG 未配置，按设计不阻断）；OpenAlex / Semantic Scholar 429 冷却 → 候选来自 arXiv；55 pending 候选 |
| hitl.literature_selection | 推荐 25 → 选 14（全部 arXiv 身份；2023–2026） |
| survey.fulltext | 14/14 失败：1 篇 37 MB 超 20 MB 上限；其余 arXiv PDF 下载超时（本机实测 60 s / 1.3 MB）→ 熔断；语料冻结 revision 0、fulltextBasis 0 → **14 篇全部 abstract_only** |
| survey.matrix | 14 任务（95 s）；14 条 abstract_only / draft；methodFamily 13 unclassified + 1 transformer_3d_mot |
| survey.synthesis | 12 任务；8 条 synthesis（7 literature_cited + 1 speculative；evidence_backed 0/0） |
| survey.outline | 1 任务；9 节（framing / develop×2 / compare×4 / conclude×2 全部合法角色） |
| writing.sections | 9 任务（88 s）；12,249 字节；writing-plan + academic-redundancy-rev1 产物 |
| citation.verify | cited 14 / missing 0 / hallucinated 0 / verified 6 / unverifiable 8（rate_limited；55 req / 3×429 / 恢复 2 轮） |
| review.run r1 | fact（2 turns）/ academic / style；academicScore 64、styleRisk 38；0 critical / 8 major / 12 minor；fact claims 15：4 SUPPORTED / 8 PARTIALLY / 3 UNSUPPORTED（全部 opaque；**正式证据池 = 0**） |
| quality.gate r1 | FAIL：unsupported_critical_claims_zero(3) / open_critical_major_zero(5) / academic 64 / styleRisk 38 |
| revision.plan r1 | 24 条目 / 8 planned（claim resolution：weaken 2 / remove_claim 1；无数值删除） |
| revision.revise | 7 任务 → rev2（含摘要） |
| revision.validate | **blocked**：fact preservation `prose_number` 2023 → 2024（摘要年份被改）→ `hitl.revision_validation` → 驱动 `reject` → `revision.restore` → rev3（= rev1 内容） |
| review.run r2 → gate r2 | 同样四条规则失败（64 / 38 / 3 unsupported / 5 major） |
| revision.plan r2 | planned 0 → NO_PROGRESS → `hitl.revision_stalled` → accept_draft |
| build.draft | **编译失败**（`Missing $ inserted`：摘要 `track_query_based`）→ completion `label=draft, QUALITY_NOT_REACHED, qualityOutcome=CONVERGED, revisionRounds=1`，无 PDF |

### 7.3 重跑（`w-3dc8fcc9039b`，同项目，修复摘要转义后；9.2 分，16 任务）

前段全部幂等复用（research.plan 1 任务重生成计划；search 跳过；fulltext / matrix / synthesis / outline / writing 复用，0 Writer 任务）。citation.verify → review r3（rev3；8 claims 全 UNSUPPORTED；1 critical / 11 major；63 / 38）→ gate FAIL → plan（12 planned）→ revision.revise 9 任务 → rev4 → validate ok（当时口径）→ citation.verify（missing=1：`huang2024mabbamot`）→ review r4（rev4：critical citation ×2 指出拼写错误；70 / 45；8 claims 全 UNSUPPORTED）→ gate FAIL（7 条规则含 `citation_structure_valid`、`survey_citation_keys_valid`）→ outcome REGRESSION → stalled → accept_draft → build.draft：xelatex 三遍成功、bibtex `I didn't find a database entry for "huang2024mabbamot"` → build gate 如实判「LaTeX 编译失败」→ **`build/main.pdf`（7 页、151,837 字节、sha256 `9b8b8be80605df808d26ab2f3f1798a8d9d0c215852577b68f8c0055b02ee3fc`）已生成但未登记为 Draft 工件**；completion `label=draft, qualityStatus=SYSTEM_FAILED`。

### 7.4 外部依赖实况

OpenAlex：匿名池持续 429，`Retry-After` 64,880 → 63,609 s（≈ 18 h）→ `ScholarlyHttpClient` 让位 + 120 s 冷却 + 恢复轮；Semantic Scholar：429；arXiv API：间歇 429 / 超时后可用（export.arxiv.org 200 需 30 s）；arXiv PDF：60 s / 1.3 MB；Crossref 200；SearXNG 未部署（可选）。provider 状态面板运行结束时三者 `healthy / circuit closed`。

### 7.5 执行类别（如实分级）

本轮是**真实 Topic → PDF 全链路**（创建项目 → 16 个 stage → build.draft），不是 Stage Replay。终态是合法的 Draft（QUALITY_NOT_REACHED / build gate 失败），**不是 Final**；原因分层：
- 结构性：abstract-only 语料 → 正式 Evidence 0 → Fact Reviewer 无可绑定 → `unsupported_critical_claims_zero` 不可能通过（守卫按设计工作；产品缺口见 §15-1）。
- 质量：覆盖面 / taxonomy 未建立（文献集外围）、academic 63–70、styleRisk 38–45 —— Reviewer 的 major findings 事实上准确（见 §9）。
- 工程：摘要转义（已修）、未知 key fail-closed（已修，未 live 复验）。

## 8. 真实学术来源、Evidence 与引用数量

| 项 | 数量 |
| --- | --- |
| 检索候选（pending） | 55（8 条 academic 查询 × 10 快照去重） |
| 入库来源（accepted / promote） | 14（全部 arXiv 身份：2604.00452、2508.13000、2504.01321、2505.00534、2504.14717、2405.14200、2403.10826、2406.20024、2405.08909、2403.13443、2409.11749、2409.06617、2311.03561、2304.14394） |
| 全文解析 | 0 / 14（network）；interpretationDepth 14 × abstract_only |
| 正式 Evidence（verified + 锚点） | **0** |
| bibliography 条目 | 14（canonical，确定性渲染） |
| 正文 `\cite` 命令 | 42（rev1）；多 key 8；全部 14 篇被引（literatureCoverage 1.0） |
| citation.verify | cited 14 / missing 0 / hallucinated 0；metadata verified 6 / unverifiable 8（rate_limited）；rev4 missing 1（拼写错误） |
| 凭空新增文献 / DOI | 0（key 白名单 + canonical bibliography；rev4 的错 key 被 gate 捕获） |

## 9. PDF 完整性与质量检查（独立抽查，PyMuPDF）

对象：重跑产出 `build/main.pdf`（rev4；未登记工件）。

| 检查 | 结果 |
| --- | --- |
| 页数 / 字符 | 7 页 / 7,019 字符（CJK 3,512）；逐页 730–1,535 字符，无空页 |
| 字体 | SimSun / SimHei / KaiTi（ctexart Windows 字体）+ Latin Modern；中文正常渲染 |
| 首页 | 标题「基于Transformer 的端到端多目标跟踪方法综述：方法分类、演进趋势与融合策略分析」、摘要存在；**无关键词**（综述模板未设 keywords） |
| 章节 | 1 引言；2 按摘要线索的方法初步归组；3 演进趋势；4 跨方法比较一：数据依赖；5 跨方法比较二：遮挡与非线性运动；6 综合分析：多模态融合机制的研究共识；7 覆盖空缺；8 未来方向；9 结论——9 节全部非空 |
| 参考文献 | 「参考文献」标题存在；正文内编号引用 56 处；条目 [1]…（14 篇 arXiv 条目，作者 / 标题 / 年份完整） |
| LaTeX 残留 | `??` 0、`\cite` 0、`\ref` 0 |
| 重复 | 逐字重复句 1 处（`track_query_based、transformer_association、query_propagation_fusion、…` 五族清单在摘要与覆盖空缺章各出现一次）；生产重复报告有害下界 1.0% |
| 事实 ↔ Evidence | 正式证据 0 → 所有具体机制 / 比较论断均为摘要转述；Fact Reviewer r4 标出 8 条 UNSUPPORTED（跨路线权衡、互补性、趋势措辞、归因）；稿件自身在多处写明「基于摘要层面」「不足以支持直接比较」，结论末尾集中说明局限 |
| 结论夸大 | 未见（结论与摘要措辞已弱化为「初步观察显示…迹象」） |
| 引用未解析 | rev4 的 `huang2024mabbamot` 在 bibtex 中缺条目（gate 已判失败）；PDF 文本未出现 `[?]`（natbib numbers 下缺失条目不渲染问号） |
| 内部状态词 | rev1 正文含「unclassified」「尚待人工修正」（style major 已指出）；rev4 摘要仍有「部分方法族标签归类尚待完善」；修复（§4-7）在 LIVE 之后 build，未 live 复验 |

## 10. Research Article Experiment Gate 回归（任务 E1）

未重跑耗时的完整研究论文生成；复用 M13.7.11 的真实证据（idea_to_paper 真实 Planner：feasibility LOW、requiredExperiments 3 / missingRequirements 4，停在 Experiment Requirement 边界；6/6 合法角色；28/28 canonical evidenceIds）+ 本轮确定性回归：`test/experiments/*`（experimentPackages 6、experimentPackagesM133 4、experimentSplitScopes 8、experimentUpgrade 6、experimentWorkflowContext 11、experimentAgentPolicy 8、experimentUpload.proxy.http 4）、`agents/feasibilityPrompt` 1、`workflow/evidenceGroundStage` 2、`workflow/revisionLoop`（含「feasibility INSUFFICIENT → adjust」用例）全部通过。未使用任何未经授权的 Confirmation / Held-out 实验数据，未进行有界 smoke（无需：本轮改动不触及实验门禁代码）。

## 11. Existing Paper Revision 回归（任务 E2）

`review/m114ReliabilityClosure` 38、`quality/m114Attempt8Regressions` 16、`quality/m114AuditRegressions` 5、`workflow/revisionFidelity` 29、`workflow/existingPaper` 10、`workflow/existingPaperReview` 4、`quality/factPreservation` 37、`quality/citationPreservation` 21、`review/revisionValidation` 15（+2 本轮）、`revisionScope` 19、`workflow/m113StatusSemantics` 12、`workflow/factPreservationGate` / `citationPreservationGate`、`revisionValidationFlow` 3——全部通过；Scoped Patch / Fact Preservation / Citation Preservation / Lineage Attribution / Author Decision / 双层终态判定不变。真实返修项目 p-14afa81bd7fa 的 claim grounding 8 轮重放零变化（§5.1）。新增的两类拒绝（`named_reference`、`citation_unknown_key`）只会让 validate 更严，且在真实 rev1 → rev2 重放上不产生新拒绝。

## 12. 真实模型 Token、Cost、耗时（SDK estimatedCost 不是账单）

| Run | 任务 | turns | 非缓存 input / output | cacheRead | estimatedCost | 模型侧秒 | 墙钟 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| run 1（plan 1 / matrix 14 / synthesis 12 / outline 1 / sections 9 / review 6 / revision 7） | 50 | 55 | 137,382 / 26,027 | 562,560 | 0.4531 | 639 | 18.2 min |
| 重跑（plan 1 / review 6 / revision 9） | 16 | 21 | 60,123 / 15,525 | 250,752 | 0.2177 | 342 | 9.2 min |
| **合计** | **66 / 80** | **76 / 120** | 197,505 / 41,552 | 813,312 | **0.6708** | 981 | 27.4 min |

逐任务 prompt / output / usage 落盘 `D:\PaperTeamData\M13_Final_Closure\live\topic-run1{,-rerun}\*.prompt.txt / *.output.txt` 与 `result-*.json`；账本 `model-budget.json`（66 条预留，逐任务 turns）。Reviewer 对同一冻结稿的额外独立采样 0 次（带内复核未触发）。第二次完整 Topic → PDF 尝试未执行（剩余 14 任务不足以完成一次完整链路，且根因不在模型侧）。

## 13. 本机资源用量与进程生命周期

- 驱动进程（PiRuntimeAdapter + HTTP server + Orchestrator 同进程）RSS 峰值 191 MB（run 1）/ 187 MB（重跑）；活动 run 峰值 3（review 三路并行）；managed sessions 峰值 9。
- 系统可用内存：开始 6.8 GB → 最低 4.58 GB（32 GB 机器；同时运行用户 dev 栈 2 进程 + vite + 监控 + Claude Code 子代理 + 后台全量 vitest 2 workers）。无 docling 子进程（全文 0/14）；xelatex / bibtex 子进程每次编译正常退出；运行结束 server / orchestrator / adapter 全部 close，无残留 node 进程（用户 dev 栈 PID 4240 / 720 / 9384 / 16840 全程未动）。
- 用户的真实后端进程使用 `backend/dist`：本轮三次 rebuild dist 不影响已加载的进程（动态 import 仅 node 内建与 evaluation CLI），未重启该进程。

## 14. 单元、集成、全量、Browser E2E、CI

| 项 | 结果 |
| --- | --- |
| 定向单测（新增） | claimStance 16、partialRefutationGrounding 15、namedReferenceGuard 10、academicConfirmation 10、partialKeyPoints 10、factContaminationPrompts 4、multiKeyAttribution 7、attributionDigestAndStatusWords 3、revisionValidation +2、Manuscript +1、academicConfirmationWiring e2e 2 |
| 受影响模块定向回归 | 71 文件 931 测试（A1–B 后）；45 文件 504 测试（A4 后）；56 文件 701 测试（未知 key 后）全部通过 |
| 后端全量 vitest（2 workers） | 第一次（`10c1f33` 前）：295 文件通过 / 7 跳过，3269 通过 / 20 跳过，0 失败，494 s；第二次（收口 HEAD）：见 §14 末行 |
| 前端全量 vitest | 334 / 334 通过（与后端全量并发时 `QualityGatePanel` 1 用例超时 1 次，单独重跑通过——负载 flake，非回归） |
| typecheck | 后端 / 前端通过 |
| build | 后端 tsc 通过；前端 vite build 通过（chunk size 既有告警） |
| `git diff --check` | 通过（仅 CRLF 提示） |
| 既有 flake | `review/stylePolish` 的「apply_once + Gate 持续失败」用例在与真实 run 并发时失败 1 次，单独重跑 18/18 通过；全量第一次 0 失败 |
| Browser E2E | 本轮无 UI 路径变更（仅新增两个拒绝类别标签）；未执行 Playwright / Browser Acceptance（如实记录） |
| GitHub CI / Linux Integration | 起始 HEAD success；收口提交 push 后以 `gh run list` 核对（结果写入提交后的最终汇报） |

后端全量 vitest 第二次（收口 HEAD）：**297 文件通过 / 7 跳过，3281 测试通过 / 20 跳过，0 失败，374 s**（含本轮新增 81 个用例；日志 `logs\full-vitest-2.log`）。

## 15. Remaining Limitations（阻断 / 非阻断）

**阻断（M13 不判 COMPLETE 的原因）**
1. **abstract-only 语料无正式 Evidence**：`survey.matrix` 对 abstract_only 条目强制清空 anchors、不铸 Evidence；全文失败时综述工作流没有「摘要级 verified Evidence」路径（M13.7.9–7.11 的摘要级证据全部来自夹具 seeding）。结果是 Fact Reviewer 无可绑定、`unsupported_critical_claims_zero` 结构性不可通过、A4 信号全部 skip。清除路径：把来源摘要作为 `verificationLevel="abstract"` 的可锚定文本纳入 ingestion / grounding（数据模型已支持该等级），并带 M11.3 式校准；或在本机可获得全文的网络条件下再做一次完整 Topic → PDF。
2. **登记的 Draft / Final 工件未在真实 Topic 起点上产出**：run 1 因摘要转义失败、重跑因修订 Writer 拼写错误触发 bibtex 缺条目。两处根因都已确定性修复（§4-6 / §4-8）并有真实快照重放证据，但预算不足以 live 复验；需要一次 ≥ 20 任务的复验 run。

**非阻断（Known Limitations）**
3. 全文下载对本机网络极敏感（arXiv PDF 60 s/1.3 MB；超大小上限也计入熔断连续失败）；OpenAlex / S2 匿名池日配额用尽即 429 ≈ 18 h（可通过 `PAPERTEAM_OPENALEX_MAILTO` 礼貌池改善，本轮未配置任何邮箱）。
4. 候选推荐按年份降序而非主题相关性，在仅 arXiv 可用时产出外围文献集、taxonomy 13/14 unclassified——HITL literature_selection 是用户的修正点；本轮按系统推荐截断以避免内容挑选。
5. Reviewer 方差：带内复核机制已落地但真实 run 分数全部在带外，LIVE 未触发；意见级 major 的「跨样本重现」规则只覆盖 academic / style 类。
6. B2 有害重复的可计量改善无可信证据（§6）。
7. partialKeyPoints 对 Planner 改写式复述有已记录的盲区（§5.3）。
8. 修复 ②（状态词）与 ⑧（未知 key）在 LIVE 之后 build，未 live 复验；修复 ⑥ 已被重跑证实。
9. 综述模板无关键词字段；Browser E2E 本轮未跑。

## 16. M13 Final Verdict

`M13 PARTIAL — BLOCKERS REMAIN`。理由：G1 的 1 / 2 / 4 / 6 / 7 / 8 / 9 满足；3 满足（完整执行到合法终态）但 5（真实可检查的**登记**工件）只达到「已编译 PDF 文件、未登记」；阻断 1 是产品缺口，阻断 2 是未 live 复验的已修缺陷。本轮没有降低任何 Guard / Gate 阈值；新增的全部守卫只会更严。

## 17. M14 Ready / Not Ready

**NOT READY_FOR_M14**（以上两项阻断清除后即可进入）。

---

## M14 Thesis Workflow — Handoff

**可复用能力（M13 已交付）**：确定性 Evidence 层级（direct / partial / unsupported + abstract / fulltext / user_confirmed）与 claim grounding（含否定性命题立场）；Reviewer → Revision 的事实隔离（意见非证据 + 具名实体守卫 + 未知 key fail-closed）；Planning → Writing 契约边界（角色 / 任务块 / partial 标注）；带内复核的 Quality Gate；Revision Fidelity（Scoped Patch / Fact & Citation Preservation / Lineage / Author Decision / 双层终态）；实验包摄取与 `workflowUse` 授权；figure 流水线；文件后端的崩溃恢复与 Resume；本轮的真实 Topic → PDF 驱动与三类只读重放脚本。

**小论文 → 学位论文真正缺的新能力**：(a) 多篇已发表 / 在投小论文 → 章节映射与去重合并（不是逐节写作而是「组织已有成果」）；(b) 跨章节统一符号 / 术语 / 数据集 / 基线的一致性账本；(c) 章节级 Evidence 继承：已发表成果的事实、数值、引用必须按「作者已发表」等级进入证据池并冻结，不得被 Reviewer 意见或 Writer 改写（可直接复用本轮的具名实体守卫 + 未知 key 守卫 + Fact Preservation 的 user_confirmed 等级）；(d) 学位论文模板（封面 / 目录 / 多级章节 / 附录 / 中英摘要 / 关键词）与长文档编译（现模板无 keywords、按 ctexart 单层）；(e) 文献综述章对接综述工作流（本轮 abstract-only 证据缺口必须先补）；(f) 实验章：实验不足时停在真实 `AUTHOR_DECISION_REQUIRED`——沿用 `research.feasibility` 的 requiredExperiments / missingRequirements 与实验包 split-scope 授权，禁止用任何未授权数据补写。

**输入与 Workflow 变化**：输入 = 已发表小论文 LaTeX / PDF（走 existing-paper 导入 + 冻结基线）+ 学位论文大纲 + 作者授权的实验包；Workflow 需新增「章节映射 / 合并计划 → 作者确认 → 按章 Writer（继承证据）→ 一致性校验 → 全文 Review」的阶段；Quality Gate 在双层判定之上增加「已发表成果零漂移」规则。

**保护已发表成果**：导入即冻结为 revision baseline（M10.3 既有），所有章节修订按 Scoped Patch + Fact Preservation 对账；已发表数值 / 表格 / 引用进入 `user_confirmed` 证据等级；任何修订新增的文献 / 实体 / key 走本轮的三道守卫。

**实验不足时**：feasibility LOW / INSUFFICIENT 直接进入 `AUTHOR_DECISION_REQUIRED`，Writer 不得生成实验结果；实验章只写已授权观测。

---

## 附：私人产物与可复核清单

`D:\PaperTeamData\M13_Final_Closure\`（不进 Git）：`projects\p-47370dc6a0f0`（完整项目：research / sources / manuscript / reviews / build / workflow runs 的 checkpoint 与 events）；`live\topic-run1`、`live\topic-run1-rerun`（逐任务 prompt / output、`result-*.json`、`project-*` 快照、`pdf-inspection-*.json/.txt`）；`model-budget.json`；`replay\`（claim grounding 重放 JSON、revision validation 重放）；`logs\`（两次全量 vitest、两次 run 日志）；`scratch\`（patch 脚本、PDF 抽查脚本、进度 / 内存脚本）。主要 artifact SHA256（前 16 位）：`build/main.pdf 9b8b8be80605df80`、`main.tex a31d6f0b5492588f`、`references.bib 7b05bdb217c309bb`、`outline.json 745c05ff4e1896ba`、`research.json 2ebec150b85e9774`、`survey.json 6da2f6b9c5e78fa4`、`survey-synthesis.json 78b5d6e95d4a3d4f`、`corpus-snapshot.json 8c053e67824fb14c`。公开报告不含网关地址、密钥、用户真实论文内容。

---

## M13.8 复验追加（2026-10-13；本节只追加，不改动上文 PARTIAL 的历史事实）

本轮（M13.8，报告见 [M13_8_NETWORK_AND_PRODUCT_CLOSURE.md](M13_8_NETWORK_AND_PRODUCT_CLOSURE.md)）清除了上文两项阻断，M13 裁决由 PARTIAL 升为 **COMPLETE — READY_FOR_M14**：

1. **阻断 1（abstract-only 零正式 Evidence）**：接入本机研究代理（`PAPERTEAM_RESEARCH_PROXY_URL` / 设置 → 网络设置；仅学术检索、元数据核验、合法全文下载，不影响模型 API）后，arXiv 全文下载从 60s/1.3MB 提速至秒级；真实语料 fulltext 10/14，生产管线产出 **37 条 verified fulltext Evidence**（含 chunk/page provenance、quote 逐字复检），Fact Reviewer 三轮真实运行（最终 SUPPORTED 10 / PARTIALLY 3 / UNSUPPORTED 5）。
2. **阻断 2（登记工件未产出）**：真实 Topic → PDF（run 1 + 幂等复用续跑）**正式登记 Draft 工件 `art-draft-rev4`**（build gate 通过；PDF 9 页抽查合格；bibtex 14 键双向闭合）；修订期具名实体守卫真实 fail-closed 拦截 ×2（恢复），未知 cite key 本轮未再出现（三轮 missing=0 / hallucinated=0）。

诚实保留：r3（rev4）academicScore 89 / styleRisk 25 / critical 0，Quality Gate 仍因 5–6 条跨方法比较论断 UNSUPPORTED 而 FAIL → 终态 **Draft / QUALITY_NOT_REACHED**（双层判定如实输出，未强改阈值；Publication Ready 未达即不判 Final）。文献遴选改为主题相关性排序（taxonomy 归类 1/14 → 12/14）。模型预算超出原帽（118/80 任务、127/120 turns；$1.73 estimatedCost），已在 M13.8 报告 §8 全额披露。
