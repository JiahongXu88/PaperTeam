# M15.14 — Target-Journal Contribution & Prior-Work Evidence Pilot（贡献级证据比较试点）

- 日期：2026-10-30 · 任务书：M15.14（属 M15；**M15_OVERALL=INCOMPLETE 维持**）
- 基线：`d04d39a`（== origin/main，clean）→ 本轮提交见 §10
- 数据根（仓库外）：`D:\PaperTeamData\M15\M15_14\`（MANIFEST.json 全文件 SHA256）
- 预算：300 保护上限；实际 **172 次真实物理模型调用**（DEV 22 + typing 13 + 四臂 97 + judge 44[含 DEV 10] + Phase D 9 + 重试摊入），估算 **$3.74**（1.02M in / 322k out / 3.42M cache），零未完成调用
- 指标性质：代理匹配测量（外部参照=PeerRead iclr_2017 公开人类评审真实内容；问题分段/typing/匹配为模型辅助 + investigator 复核；LLM_JUDGE_PROXY 局限沿袭 M15.11-13）

## 0. 第一屏裁决（任务书 §7 十问）

**本轮裁决 = `NO_MEASURABLE_GAIN`（机制工件与守卫有效，但对最强基线的贡献级问题覆盖率无可靠增益；附 `GENRE_MISMATCH` 观察）。不允许最小产品化；M15_OVERALL 仍 INCOMPLETE。**

| # | 问 | 答 |
|---|---|---|
| 1 | 原始"指定期刊学术质量差距"目标实现多少？ | 贡献级证据链**机制**建成并可审计（claim→prior→experiment→gap 工件+四态守卫+双锚 1.0+0 虚构）；但**学术准确率未超越强基线**（#5），且中文期刊主路径存在真实阻断点（Phase D：(a) 中文 PDF 参考文献解析 0 条 (b) 跨语言检索空白）。期刊级人类标签仍 0（M15.10 事实不变） |
| 2 | claim→prior→experiment→gap 真实证据链跑通几条？ | 13/13 英文稿族全部产出结构化工件（每族 2-5 贡献单元、逐贡献最近邻、已完成/缺失验证、gapPlan）。两条可复核实例：fam-q-01（OMG/k-shot：POTENTIAL_OVERLAP 对 Matching Networks+Memory-Augmented〔自引解析、摘要级〕；SOTA 声称 EVIDENCE_GAP→需补与 Matching Networks 同代对比=Author Decision）；fam-q-06（半监督解缠：novelty 质疑 ↔ "substantially overlaps Kingma M2/Sohn" 最近邻命中真实审稿人同一批评） |
| 3 | 先前工作内容等级与不确定量？ | HELD-OUT pool：156 候选（12/族），**65% abstract 级 / 35% metadata 级**；自引解析 6-17/20 每族。模型引用 pool 外工作 83 条（a0 52/a2 31）：35 条供应商核验存在、34 条 investigator 抽查 12/12 为真实文献（题名格式变体致指纹失配）、14 条供应商限流未验——**经核实虚构=0**；abstract 级不得断言实现级异同的约束在 prompt+守卫双层执行 |
| 4 | 目标期刊是否真正参与评价？ | Phase D 是真实链路 smoke 而非换刊名：CJIG 官方 guideline（M15_9 逐字取证工件）+ 24 篇冻结 benchmark 观测带 + 贡献风险三层并列，documentType（research/survey）语义实际生效（survey 不因缺实验降档）。但 Phase C 评分实验用 ICLR 2017 proxy（venue 语义不可迁移——沿用既有披露） |
| 5 | A2 相对最强基线的结果？ | **主口径双 FAIL**：TARGET 子集（115 问题族，10/10 族非零）族均覆盖率——A2 19.3%（宽松）/11.9%（严格一对一）vs **A0（最强）23.5%/12.1%**；A2−A0 宽松 **−4.2pp CI95[−11.6,+2.9]**、严格 **−0.2pp [−5.5,+4.4]**（实质打平）；对 A1（整稿 pass）宽松 −1.0pp、严格 +3.2pp [−2.6,+11.0]（ns）。逐族敏感性（per-family max 基线）宽松 −5.3/严格 −1.4pp。judge 局限：同模型盲态（fan-in 已由严格口径约束） |
| 6 | 确定性反证与高风险误断言？ | **0 经核实虚构引用/年份**（守卫强制：cutoff 违规引用标 timeCausalityViolation 不计有效；无 pool 支撑的 SUPPORTED_DIFFERENCE 服务层强制降级，2 例被捕获纠正、输出残留 0）；"无先前工作→创新成立"路径被四态规则结构性阻断 |
| 7 | M15.13 整稿 pass 增益与贡献审查互补？ | 本轮 A1（整稿 pass 单独 2 调用）TARGET 20.2%/8.7%——与 A2 无互补信号（A2+A1 未组合；A2−A1 严格 +3.2pp ns）。结论方向：**结构化分解（清册→比较→综合）与同材料 one-shot 在"发现问题"上等价**，贡献级结构的收益在可审计性（双锚/守卫/四态）而非覆盖率 |
| 8 | 成本/调用/墙钟/版本/分项？ | 172/300 调用、$3.74、~2.6h 模型墙钟。分项：a0 13 调 $0.33 / a1 27 调 $0.25 / a2 41 调 $0.49 / a2np 16 调 $0.22 / typing 13 调 $0.19 / judge 44 调 $1.27 / Phase D 9 调。模型 zai-coding-cn/glm-5.3（全程同模型）。a2 均值 3.2 调用/族（≤6 门 PASS）但单位成本劣于 A1（G4 unit FAIL） |
| 9 | 真实实验不足能否合法停在 Author Decision？ | 能，且被 13/13 族执行：requires_real_experiment 项恒置 author_decision 并带实验计划（目的/基线/数据/指标/预期证据），零生成数值 |
| 10 | 终局裁决？ | **NO_MEASURABLE_GAIN**：数据（115 TARGET 族，非 UNDERPOWERED）与机制（DEV 三族结构化工件可信、守卫全部生效）均有效，但 G1a（严格 ≥+8pp 且 CI>0）与 G1b（宽松 CI>0）双 FAIL、G2 消融 FAIL（a2−a2np=+0.0pp——**检索材料对覆盖率零贡献**）。G3 守卫 PASS（双锚 1.0/0 虚构/0 残留违规）；G4 成本半过。按预注册规则不允许最小产品化 |

## 1. 唯一科学问题与回答

**问**：把稿件声称的创新点逐项与可核验先前工作比较、并与论文自身实验证据相连（A2_NEW），能否比 (a) 同材料同预算最强合理通用基线（A0_STRONG）与 (b) 既有整稿 pass（A1_EXISTING）更准确发现真实审稿人指出的 novelty/contribution/related-work/claim-evidence 缺陷？

**答：不能（在预注册门下）。** A2 与同材料 one-shot 基线在 TARGET 子集覆盖率上统计不可区分（严格口径 −0.2pp 实质打平）。三轮关键事实：(1) **消融归零**——A2 去掉检索材料（a2np）覆盖率不降（+0.0pp），说明贡献审查的覆盖率不来自检索到的先前工作；(2) **锚守卫的召回代价**——A2 有 2/10 族因 claimQuote 无法核验而大幅降贡献数（fam-q-09 仅 1 贡献、fam-q-13 2 贡献），可审计性与召回存在结构性交换；(3) **体裁错配**——unmatched TARGET 问题多为提问式/软建议（"Can CKMs scale to…?"），声明式 findings 天然不覆盖提问体裁。正向证据：机制的**可审计性收益真实**（双锚率 1.0、0 虚构、时间因果守卫生效、四态语义区分有效、13/13 族 gapPlan 合法停靠），这正是"可追溯、可审计"的用户价值——但任务书要求的学术准确率门未过，诚实判定为无增益。

## 2. 与 M15.11-13 的纵向关系

- 本轮 A0（1 调用，含 pool 材料+贡献比较指令）TARGET 23.5%——**给强基线喂同批真实先前工作材料+具体指令后，它就是这个子集上的强参照**；M15.13 的 C0 one-shot（无材料）为通用口径 31.1%（全部问题族）不可直接比（子集不同、样本不同）。
- M15.13 结论"分节链价值不稳定"在本轮延伸为："贡献级结构化分解对覆盖率同样无净增益"——三轮一致的最终读数：**本模型上，结构化审查的价值不在发现更多问题，而在可验证性与定位**（M15.11-13 grounded ~99% + 本轮双锚 1.0/0 虚构）。
- 成本读数延续改善：13.3（M15.13 生产链）→ 本轮贡献审查 3.2 调用/族（但单位有效成本仍劣于 2.1 的 A1）。

## 3. 样本与盲态（Phase B/C 事实）

- 框：PeerRead iclr_2017 被拒 195 个新鲜合格族（排除 M15.13 已开封 17 paperId + M15.11/12 标题守卫）；seed=1514 → DEV 3 + HELD-OUT 10 + RESERVE 4；q-08 PDF 实体 >20MB 且 CDN 不可达 → 预注册替补规则 q-14 补位（deviations v2）。
- 冻结链：PROTOCOL_FROZEN（sha256 dbdab4d8…，2026-10-30T06:09Z，任何模型调用之前）→ pools 聚合哈希（eb14598f…，156 候选）→ predictions-frozen（30/30，missing=[]，06:57Z）→ 解封 extract（546 原子问题/514 可判读/511 问题族）→ typing 冻结（5a17d3f3…，investigator 0 纠错）→ 盲态 judge（34 次，语言中立 prompt 逐字沿用）。
- 时间因果：pool cutoff 2016-10-31（年份 ≤2016 保守过滤）；模型引用 cutoff 后工作被守卫标记并失效。
- pool 构建（零模型）：多供应商链 S2→arXiv→OpenAlex→Crossref（OpenAlex 匿名日预算耗尽的合法替代；生产栈本融合三家）+ 自引解析 + 摘要级优先排名；对供应商限流时点敏感（deviations v1——冻结文件+缓存为权威记录）。

## 4. 四臂与门（预注册 §5 判定）

| 门 | 阈值 | 实测 | 判定 |
|---|---|---|---|
| G1a 严格一对一（共同主口径） | A2−max ≥+8pp ∧ CI 下界>0 | A2−A0 **−0.2pp [−5.5,+4.4]** | **FAIL** |
| G1b 宽松（共同主口径） | A2−max >0 ∧ CI 下界>0 | A2−A0 **−4.2pp [−11.6,+2.9]** | **FAIL** |
| G2 消融 | a2−a2np 点估计>0 | **+0.0pp**（4 族） | **FAIL** |
| G3 守卫 | 0 虚构 ∧ 双锚≥0.70 ∧ 0 残留四态违规 | 虚构 0（12/12 抽样为真实文献）；双锚 **28/28=1.0**；捕获纠正 2、残留 0；cutoff 违规全失效 | **PASS** |
| G4 成本 | A2≤6 调用/族 ∧ 单位成本≤A1 | 3.2/族 PASS；调用/匹配 TARGET 问题 A2 劣于 A1（3.2 调@19.3% vs 2.1@20.2%） | **FAIL（半）** |
| G5 红线 | gates.ts/qualityPolicyV2/N1/N2/H 零改动 | git diff 0 文件（§10）；新代码 advisory only（零 gate 接线）；target 122+13 测试绿 | **PASS** |
| UNDERPOWERED | TARGET<60 或非零族<8 | 115 族 / 10/10 非零 | 未触发 |

## 5. 局限（诚实清单）

1. L1 judge/typing = 同模型盲态代理（LLM_JUDGE_PROXY）；matched 抽查 15 例真实、a1 有 2 例松匹配；严格一对一已约束 fan-in。
2. L2 体裁错配未被指标捕捉：TARGET 子集含大量提问式评审意见，声明式 findings 臂（三臂皆是）结构性不吃这部分分母——三臂对称承受，但压缩了所有臂的绝对值与差异空间。
3. L3 10 族小样本：CI 宽（±5-12pp）；−4.2pp 不能排除"真实小幅劣于"，−0.2pp 严格口径不能排除"小幅优于"——但 +8pp 级增益被排除（CI 上界 +4.4）。
4. L4 A2 的锚守卫在 2/10 族大幅降贡献（quote 不可核验即丢弃）：这是可审计性的代价亦是覆盖率损失来源；放宽为"标记不丢弃"是下一轮可检验假设，本轮按冻结协议不改。
5. L5 pool 为 abstract/metadata 级（无全文先前工作）：差异判断的粒度受限（prompt 已禁止实现级断言）；"全文级先前工作是否会改变结论"未测。
6. L6 PeerRead venue/年代漂移沿袭 M15.13（2017；跨轮数值不可比）。
7. L7 Phase D 中文路径缺口（参考文献解析 0 条/跨语言检索空白）——目标期刊主路径（中文刊）的真实阻断，本轮如实定位未修复。

## 6. 产品改动（入 main）

1. `backend/src/target/ContributionAuditService.ts`：贡献级审查核心（3 调用 extract→compare→synthesize；确定性守卫：quote 锚〔含 CJK 空白修复〕/pool 身份解析/时间 cutoff/四态规则强制；coverage ledger；fingerprint/staleness；工件 research/target-contribution-audit.json；**零 gate 接线、advisory only**）。13 单测（contributionAudit.test.ts）覆盖任务 §6 清单（锚拒绝/不存在引文/abstract 不强判/cutoff/同族去重指纹/检索失败→INSUFFICIENT/身份冲突优先级/实验缺口停 Author Decision/survey 语义/venue 不混/fingerprint 变化/重试）。
2. `scripts/m1514/` 14 个 harness 脚本（选样/采集/建项目/pool 多供应商链/四臂/冻结/评估链/守卫审计/typing 冻结/聚合/Phase D smoke/MANIFEST）。
3. **不动的**：gates.ts、qualityPolicyV2、M15.8.6 N1/N2/H、既有 Target 五服务、fullpaper/分节逻辑（A1 逐字复用）、EvidenceStore（pool 材料停留 candidate 层级，零写入）。
4. **未接线**（NO_MEASURABLE_GAIN）：无 HTTP/TargetPanel 默认功能变更——按预注册，仅交付模块+harness+测试。

## 7. 下一轮唯一优先建议

**停止在"发现更多问题"轴上堆机制（三轮证据一致：结构化不提高覆盖率）；把研究轴转向已证明有价值的可审计性——(a) 全文级先前工作（arXiv/Unpaywall 合法全文）能否把 POTENTIAL_OVERLAP 的判定从"可能重叠"推进到"可判定"；(b) 中文期刊主路径的两个阻断点（中文参考文献解析、跨语言检索）是否修复后能让贡献审查在真实投稿场景可用。** 若用户需要的是"找全问题"，A0 形态（one-shot+同批材料+具体指令）就是当前最优解且成本 1/3。任何下一轮必须用全新 held-out。

## 8. Git/CI 收口

见 §10 与 PROJECT_STATUS 收口条目。验证：backend typecheck/build ✓；target 域 135/135（122 既有 + 13 新增）；全量 vitest 见收口条目；`git diff --check` ✓；CI（GitHub CI + Linux Integration）以最终 HEAD 状态回查为准，不虚报。

## 9. 数据侧完整账

`D:\PaperTeamData\M15\M15_14\`：phase-a（盘点）/phase-b（协议冻结+deviations+选框+替补）/phase-c（projects+13 pool+缓存）/phase-d（projects-root+四臂输出+model-calls.jsonl 172 条+driver-log）/phase-e（预测冻结/问题族/typing 冻结/judge-raw 34/对齐/paired-metrics/audit-guards）/phase-d-journal（三案例工件+SUMMARY）/sequester（430 评审原文，仅内部）/MANIFEST.json（全文件 SHA256+可公开性分类）。PDF/评审原文不进公开仓库。
