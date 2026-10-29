# M15.12 — Efficient Whole-Paper Review & Independent Held-out Experiment（高效整稿审查与独立 held-out 实验）

- 日期：2026-10-29 · 任务书：M15.12（属 M15；**M15_OVERALL=INCOMPLETE 维持**）
- 基线：`e2aea33b91bb1bc56c14730e463cebfcb0471ce9`（M15.11 终态，== origin/main，clean）→ 本轮提交见 §9
- 数据根（仓库外）：`D:\PaperTeamData\M15\M15_12\`（phase-a/b/c/d/e + MANIFEST.json）；新 held-out 评审原文原位留在 `M15_11/sequester/`（未复制）
- 预算：600 保护上限；实际 **382 次真实物理调用**（DEV 26 + 正式四臂 312 + 修复 2 + typing 12 + 对齐 judge 48 + judge 缓存重放 0），估算成本 **$7.93**（2.17M in / 498k out / 10.4M cache-read）
- 指标性质：**代理匹配测量**（外部标签 = ICLR 2025 公开人类评审真实内容 CC BY 4.0；问题分段/typing/匹配由模型辅助 + investigator 复核；不构成无误差真值，更不是任何期刊的录用判据）

## 0. 第一屏裁决（预注册 §5.7 四选一）

**本轮裁决 = `PARTIAL_SIGNAL`（强信号、接近 GO）**——三门科学门以**不含零的配对 CI** 通过，但冻结成本门 G3 两项未达、top-K 门 G4 结构性未达，故不宣称 GO：

| 预注册门 | 阈值 | 实测 | 判定 |
|---|---|---|---|
| G1 主指标 HRI（C2−C0+） | ≥+8pp 且 CI95 下界 >−2pp | **+9.0pp，CI95 [+4.4, +13.8]**（严格一对一 +11.3 [+7.4,+15.3]） | **PASS** |
| G2a SERIOUS | ≥C0+−5pp 且 ≥+10pp | **+11.4pp [+2.8, +19.9]**（55.5% vs 44.1%） | **PASS** |
| G2b META（全局 pass 直接靶点） | 净改善可复核 | **+13.8pp [+2.1, +28.1]**；C2 命中而 C0+ 未命中 9 例 vs 反向 4 例（净 +5，逐例在 phase-e/paired-metrics + 审计记录） | **PASS** |
| G3 成本（调用） | C2 ≤ 21.5/族（旧 C1 35.9 的 60%） | **21.7/族**（=60.4%，超线 0.2 调用；目标带 18-20 未及） | **FAIL（边界）** |
| G3 成本（比值/墙钟） | C2/C0+ ≤~10×；墙钟 ≤3× C0 | 10.8×；墙钟 7.8×（调用时长和口径；工作流墙钟约 300s vs C0 61s ≈ 4.9×） | **FAIL** |
| G4 top-K | top-10 覆盖 ≥ 全量 60% | 22.1% vs 50.3%（=全量的 44%） | **FAIL（阈值结构性失准，见 §5.3）** |
| G5 守卫 | N1/N2/H 零回归 + gates.ts 零改动 | gates.ts/qualityPolicyV2 零改动（git diff 可证）；新增/相关测试全绿；全量回归 4446 passed + 12 个既有并行负载闪失（逐文件单跑全绿，仓库既有模式） | **PASS** |

**结论一句话**：在 12 个全新未开封 paper families（48 条 Official_Review → 612 个可判读问题族）上，PaperTeam 生产链 + 批量摘要 + 全文级 Goal–Method–Claim–Evidence pass（C2）相对成本公平的通用全局基线（C0+）取得**首个不含零 CI 的主指标增益**（+9.0pp），serious/meta 子集增益更大且通过严格一对一敏感性；每族调用从旧 C1 的 35.9 降至 21.7（−40%），但未达冻结的 60% 硬线与墙钟线——**globalReviewMode/priorityView 保持默认 off 的实验开关（当前实现即如此），B1 批量摘要作为可选模式一并保留**。M15 期刊级质量判别仍 NOT_EVALUATED；不能据此声称任何期刊录用水平。

## 1. 唯一研究问题与回答

**问**：PaperTeam 生产 Reviewer + 低成本全文级 Goal–Method–Claim–Evidence pass + PaperMap 批量摘要，相对合理的低成本通用全局基线（C0+）与原 one-shot 基线（C0），在全新公开真实人类审稿数据上能否保留 serious 识别信号并改善覆盖率与成本？

**答**：能（信号侧）——C2−C0+ +9.0pp（CI 不含零）、serious +11.4pp、meta +13.8pp、C2−C1opt +4.6pp [+2.3,+6.9]（全局 pass 自身增量独立显著）；成本侧部分——调用 −40%（35.9→21.7/族）、单位检出成本 198→88 调用/百匹配问题族（−56%），但绝对成本仍为 C0+ 的 10.8×、墙钟未达 3× 线。M15.11 指出的"两臂共同盲区 = 整稿级 meta 批评"被全局 pass 直接命中：meta 子集 C2 50.2% vs C0+ 36.4%。

## 2. 与 M15.11 的关系（纵向锚，读数须谨慎）

| | M15.11（12 族） | M15.12（12 新族） |
|---|---|---|
| C0 one-shot HRI | 33.5% | 44.8%（同 prompt 逐字重放） |
| PaperTeam 链 HRI | 37.0%（C1，35.9 调用/族） | 50.3%（C2，21.7 调用/族） |
| C1−C0 | +3.5pp [−2.8,+9.6] | C2−C0 +5.5pp [−0.5,+11.9]；**C2−C0+ +9.0pp [+4.4,+13.8]** |
| 单位检出（调用/百匹配问题族） | 198 | 88 |

**样本不可跨轮直接比较**（不同族、不同问题分布、本轮 serious 判定换为 taxonomy-first 口径 355/612 vs M15.11 regex 32/693）；C0 本轮基线本身高 11pp 说明本样本整体"更可对齐"。纵向唯一稳健读数：同 prompt C0 重放成功（纵向锚成立）+ 单位检出成本下降 56%。

**诚实披露（C0+ 弱于 C0）**：本轮的"合理增强基线"C0+（两步通用全局）总体 41.3% **低于** one-shot C0 44.8%（meta 36.4% vs 45.6%）——抽取步骤在本样本上未帮到通用模型。因此主对比 C2−C0+ 的 +9.0pp 须与 C2−C0 的 +5.5pp [−0.5,+11.9]（CI 含零，探索性）并列解读：**C2 对最强基线（本样本上=C0）的优势是 +5.5pp 探索性、对预注册主对照 C0+ 是 +9.0pp 显著**。

## 3. 样本与盲态（Phase C/D）

- 新 held-out = M15.11 未运行且评审未开封的 **cand-21..32**（4 未跑 HELD-OUT 优先 + RESERVE 升序，确定性规则冻结于预注册）；cand-33/34 备用未动用；cand-02..08（M15.11 未跑 DEV）按保守角色隔离不入正式样本。
- 资格：34 候选标题归一化零重复；版本对齐规则全部满足（invitations 无修订类 ⇒ PDF=审稿版）；每族 3-5 条实质 Official_Review。
- 泄漏证据链：M15.11 提取产物仅覆盖已跑 13 族（文件清单可证）→ 本轮 Phase A 只读元数据 → 四臂输出 **12/12 族 SHA256 冻结（2026-10-29T08:57:33Z，missing=[]）之后**才运行 extract-issues 解封 sequester；typing 冻结先于对齐 judge（typing 只见问题族）。LEAKAGE_AUDIT.md 记录全程。
- DEV = fam-cand-01 复用（M15.11 已开封），26 调用；prompt 工程性修正零次（v1 冻结文本直用）。

## 4. 四臂结果（族均；严格一对一敏感性并列）

| 指标 | C0 | C0+ | C1-opt | **C2** |
|---|---|---|---|---|
| HRI-Coverage | 44.8% | 41.3% | 45.8% | **50.3%** |
| HRI（严格一对一） | 17.5% | 17.4% | 24.7% | **28.8%** |
| SERIOUS-Coverage（n=355） | 46.3% | 44.1% | 49.7% | **55.5%** |
| META-Coverage（n=72） | 45.6% | 36.4% | 42.0% | **50.2%** |
| findings 总量（12 族） | 181 | 172 | 858 | 947 |
| 物理调用/族 | 1.0 | 2.0 | 19.5 | 21.7 |
| 估算成本/族 | $0.04 | $0.08 | $0.16 | $0.20 |
| Grounded Ratio | 100% | 97.7% | 99.3% | **99.4%** |
| 调用/百匹配问题族 | 5 | 10 | 91 | **88** |

- 配对差全表：C2−C0+ +9.0 [+4.4,+13.8]；C2−C1opt +4.6 [+2.3,+6.9]（**全局 pass 净增量，最干净的消融证据**）；C1opt−C0+ +4.4 [0.0,+9.1]；serious/meta 见 §0。
- 严格一对一口径下 C2 优势扩大（+11.3pp）——fan-in 过匹配主要抬升宽泛 finding 臂（C0/C0+），与 M15.11 investigator audit 预判一致；本轮两口径并列报告。

## 5. 质量与诚实清单

### 5.1 investigator audit（非独立人工专家）
- matched 抽查：C2 6/6 真匹配（1 例松：泛化建议↔目标-模型矛盾，judge 宽）；C0+ 5/5 真。
- 双臂共同未覆盖（8 例抽查）：深度数学验证（如 cand-23 收敛常数矛盾）、跨方法对比建议、定义级精度问题——**残余盲区=需符号演算/强领域知识的验证类**，非全局综合类（M15.11 盲区已被全局 pass 部分填补）。
- typing 复核：judge 判 612 族，investigator 纠错 10 处（1.6%；5 处 serious→false 呈现类误标、5 处 →true 漏标）；6 条 judge 缺判按保守默认。serious 子集 355/612（58%）显著宽于 M15.11 regex 口径（4.6%）——口径差如实声明，跨轮不可比。

### 5.2 AI-only 与 REFUTED
- UNVERIFIED_AI_ONLY（不称 FP）：C0 90 / C0+ 82 / C1-opt 726 / C2 796——细粒度风格/一致性观察为主（人类评审不写此类小项）。
- REFUTED：沿用 M15.11 判定——规则英文词序偏倚（C0/C0+ 英文输出 vs C1/C2 中文输出），**NOT_EVALUABLE，不作依据**（预注册 §4.3 预案生效）。

### 5.3 top-K 门的结构性失准（预注册错误，如实登记）
G4 阈值（top-10 覆盖 ≥ 全量 60%）在"每族 ~51 个问题族"的数学下不可达：10 条 finding 即使一一对应至多覆盖 ~20%。实测 22.1%（受 fan-in 加成已超朴素上限）。**正确的读数**：top-10（占 findings 的 ~10%）承载了 C2 全量匹配覆盖的 44%（22.1/50.3）——"少而准"视图成立但门阈值定错；deviation 已登记，不事后改门。

### 5.4 执行异常与修复
- fam-cand-23 全文 critique 输出 JSON 解析失败（数学论文长输出；软失败原无重试）→ deviation v3：同输入同指令重跑 1 次成功（7 findings/2 调用，修复预留列支），predictions 冻结前完成。**产品改进项（未做，防中途改代码）**：fullpaper pass 应有与分节 review 同构的解析重试（attempt 2）。
- fam-cand-23 仅解析出 2 节（数学排版致分节退化）——C1-opt 该族 3 调用；分节质量对 PDF 结构的依赖如实登记（全文 pass 恰好补位：该族 C2 仍 41.5% 覆盖）。

## 6. 产品改动（Phase B，已入 main）

1. **B1 PaperMap 批量摘要**（`paperMapSummaryMode:"batched"`，缺省 per-section=旧行为）：≤8 节/≤40k 字符一批、一次调用多节摘要；逐节存储格式/指纹复用/失败语义不变；新 scope `review/summary-batch/*` 绑空 skill（修掉摘要任务误挂 verify-citations 的现状 quirk）。实测 22 节 22 调用 → 3 批（本样本 c1opt 摘要均值 ~3 调用/族 vs M15.11 ~19.8）。
2. **B2 全文级 pass**（`globalReviewMode:"on"`，缺省 off）：新 stage `review.fullpaper`（抽取论证结构 → 全局批判，2 次有界调用）；Finding 增 additive `confidence`/`evidenceGap`；锚校验（sectionId 必须存在，非法整条计入 dropped）；可见性台账（导航索引 12k、被引用节全文 35k、截断如实登记）。
3. **B3 top-K 优先视图**（`priorityView:true`，缺省 off）：确定性 severity+类目权重排序、exact/Jaccard≥0.8 去重、serious/meta 标记；只加视图不改 findings/Gate。
4. 遥测修正：SectionReviewService.lastTelemetry stage 内取差值（原跨 run 累积——M15.11 报 193 调用/族的假象来源）。
5. 全部为 run-request 选项（沿 citationSemanticMode 通道），历史 run 零迁移；**不触碰 gates.ts / M15.8.6 N1/N2/H**。

## 7. 局限（诚实清单）

1. L1 judge/typing = 同模型盲态代理（LLM_JUDGE_PROXY）：绝对值均有噪声；fan-in 方向已由严格一对一敏感性约束（结论在该口径下更强）。
2. L2 12 族小样本：CI 虽不含零但样本量限制外推；meta 子集 n=72 的 CI 宽（[+2.1,+28.1]）。
3. L3 C0+ 弱于 C0：主对照的选择效应——C2 对"本样本最强基线 C0"的优势为探索性（+5.5pp，CI 含零）。
4. L4 成本门未全达：21.7>21.5（0.9% 超线）主要由 cand-32（41 页/45 调用）等长文拖高；墙钟 4.9-7.8×（取决于口径）。
5. L5 模型预训练可能见过公开评审（四臂对称；外部效度局限）。
6. L6 frame 仍为 ICLR 被拒投稿；**任何中文期刊录用水平声称依然不能做出**（M15.10 标签=0 事实未变）。
7. L7 B1 批量摘要无同族新旧直接对照（跨轮样本不同）——"信息覆盖无损"证据=测试 + c1opt 覆盖率不降（45.8% vs C0+ 41.3%），非直接 A/B。

## 8. 下一轮唯一优先建议

**把 C2 形态（批量摘要 + 全局 pass + top-K 视图）作为 PaperTeam 审阅的默认实验档位继续运行积累证据，同时修掉两个已知短板后再评估转正**：(a) fullpaper pass 解析重试（本次 cand-23 暴露）；(b) 分节+全文的调用分配优化（长文族 21.7→18-20 的空间在分节上限与摘要批大小）。若下一轮（新 held-out、预算内）复现 +8pp 级主指标增益并达成本门，则 GO_FOCUSED_REVIEW 转正；否则维持实验开关。**期刊级判别仍待 M15.10 人工标签路径，与本实验正交。**

## 9. Git/CI 收口

- 本轮提交：① Phase B 产品改动+测试（`04c1895`）；② 本报告 + PROJECT_STATUS + repair 脚本修正（见 git log 终态）。
- 验证：backend typecheck/build ✓；frontend typecheck ✓；定向回归：paperMapBatched 10/10、fullPaperReview 14/14、priorityView 6/6、existingPaperReviewModes 4/4、academicSkills 18/18、stylePolish 19/19、existingPaperReview 全链路 ✓；全量 vitest 4446 passed / 12 failed（revisionLoop/stylePolish/academicSkills 并行负载闪失，三文件合跑 45/45 全绿——仓库既有模式，CI 为准）。
- CI（GitHub CI + Linux Integration）以最终 HEAD 状态回查为准，不虚报。
- 数据侧完整账：`D:\PaperTeamData\M15\M15_12\MANIFEST.json`（SHA256 全账 + 可发布性分类）；机读指标 `phase-e/paired-metrics.json`；冻结链 `phase-c/sample-manifest.json` → `phase-e/predictions-frozen.json` → `phase-e/issue-typing-frozen.json`。
