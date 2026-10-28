# M15.9 — Target-Journal-Calibrated Quality Gate：真实期刊基准、独立判别实验与目标闭环

- 日期：2026-10-28 · 任务书：M15.9（P0，属 M15，不属 M16）
- 基线：`950279da3dcd3cafe75bd202a2b50d310243e23`（M15.8.6 终态收口）→ `42680c8`（状态纠偏）→ `f5a83f7`（Phase E 实现）→（终态 HEAD 见 §10）
- 数据根（仓库外）：`D:\PaperTeamData\M15\M15_9\`（phase-a…f + budget + MANIFEST.json）
- 预算：任务上限 600（保护性）；实际真实模型调用 **13 次** completeSimple（§8），零超支

## 0. 第一屏 20 问结论

| # | 问题 | 结论 |
|---|---|---|
| 1 | 里程碑口径纠偏是否先行落地？ | 是：`42680c8` 顶部裁决——M15_OVERALL=INCOMPLETE、M12=IMPLEMENTED_BASELINE/ADVISORY_UNCALIBRATED、M15.8.6 工程 PASS 历史事实保留；已推送 |
| 2 | 是否真的有目标期刊独立正/负质量标签？ | **否（如实）**：中文两刊无合法公开人类标签渠道 → `LABELS_INSUFFICIENT`；Layer A 客观缺陷 oracle 8 族已冻结并实测；专家标注任务包已交付（phase-c/expert-rubric-form.md） |
| 3 | 是否 held-out / 盲测？ | Layer A 变异集评估前冻结（mutation-register.json 全文件 SHA）；评估器盲态（登记不入项目目录/prompt；leakage-audit 275 文件 0 发现）；期刊级 held-out 因标签缺失 NOT_EVALUATED |
| 4 | 可重复的 false-ready 是多少？ | Layer A：**0**（G-A2 门，5 变异族全部被 A2 指南层点名且无一被判"无差距就绪"）；期刊级 false-ready NOT_EVALUATED（无标签，不编造） |
| 5 | 官方要求证据是否可溯源？ | 是：两刊官网 6 页快照 + SHA256 + 逐字摘录 + 访问日期（phase-b/guideline-evidence.json）；量化创新性量表两刊均 NOT_SPECIFIED（系统不编造数值门槛） |
| 6 | benchmark 真实性与覆盖？ | CJIG 24 篇（23 全文 OA，docling 解析 23/23；survey 11/research 13；年份桶×引用三分位×类型分层）；CEA 24 篇（元数据级——官网全文登录墙，如实 NOT_AVAILABLE） |
| 7 | 是否规避 top-cited 偏差？ | 是（采集器分层轮转；CJIG 候选池英文题名过滤偏差已登记 deviations #3） |
| 8 | A0/A1 旧基线是否先测？ | A0=M15.8.6 内部 Gate 锚（N1/N2/H fresh）+ F7 本轮零模型确定性复验；A1=M12 readiness 确定性（b1c 双刊 + F5） |
| 9 | A2 判别力？ | 指南层 **sensitivity 1.0 / specificity 1.0**（TP5/FP0/FN0/TN6）；rubric scope 差分 4/4 正确（bnet：CJIG 判范围外/CEA 判范围内，均带栏目依据） |
| 10 | A3 消融结论？ | 4 组对照中 3 组 A2≡A3、1 组分化（bnet×cea：A2 WEAK vs A3 NEEDS_EXPERT_REVIEW）——benchmark 带对该合成稿增加了确定性；样本量不足以宣称带的普遍增益（如实） |
| 11 | 同稿两刊结论是否有依据地不同？ | 是：F1（22 字题目）CJIG 硬性不符/CEA 符合；bnet 范围 CJIG 拒/CEA 收；b1-original CJIG 3 违规/CEA 1 违规——全部带官方条款原文出处 |
| 12 | 文章类型语义是否生效？ | 是：同稿 research 声明 → novelty/contribution 降 WEAK + rubric 主动点名"文章类型声明与综述内容不符"；survey 口径零"缺实验"惩罚措辞（G-TYPE PASS） |
| 13 | 无全文/缺数据是否如实降级？ | 是：CEA readiness=INSUFFICIENT_EVIDENCE（场景 4 实证）；无确定性检查器字段（300dpi/三线表/作者年格式/引言从 0 编号）NOT_EVALUATED 不冒充 |
| 14 | 综述是否被"缺实验"误伤？ | 否（见 #12；rubric 理由为综述口径的覆盖深度） |
| 15 | 内部 Gate 是否被放松？ | 否：gates.ts 零改动（guideline/rubric 零接线）；N1/N2/H 语义零触碰；全量测试 4404-4406/4451 通过（2-8 个并行负载闪失逐文件单跑全绿——仓库既有模式；CI 为准） |
| 16 | 是否第二套 Verdict 系统？ | 否：新层全部挂 target 域工件链（research/target-guideline*.json、target-rubric.json），advisory 呈现于 TargetPanel，不进任何 gate 规则 |
| 17 | 前端是否有强宣称？ | 否（Phase A grep 证据 + 新增块三处 advisory 声明 + NOT_EVALUATION 一等呈现 + "不构成录用判断"固定文案） |
| 18 | 预算与失败调用是否如实入账？ | 是：13 次 completeSimple 逐条 driver log（12-42s/次）；GlobalBudgetLedger 不覆盖 completeSimple 通道（calls=0）已如实披露并改用物理计数口径 |
| 19 | 什么仍未证实？ | 期刊级（人类标签）判别校准、期刊级 false-ready/false-reject 率、录用相关性——全部 NOT_EVALUATED，等待授权标注（任务包就绪） |
| 20 | M15 终局裁决？ | **M15_9_PARTIAL_ENGINEERING_PASS + PARTIAL_SCIENCE_DATA_BLOCKED**；M15_OVERALL 保持 INCOMPLETE（§9） |

## 1. 里程碑口径纠偏（任务 §1）

`42680c8`：四级口径落 PROJECT_STATUS 顶部（工程事实保留 / M12 降格 ADVISORY_UNCALIBRATED / 目标层 INCOMPLETE / 总体 INCOMPLETE）。README 复核零改动（本就 advisory-only 措辞）。独立小提交已推送，远端可见。

## 2. Phase A——现有能力代码级审计（零模型）

产物：`phase-a/EXISTING_CAPABILITY_AUDIT.md` + `capability-matrix.json`（14 能力逐条判定 + 源码坐标）。任务书 §2 的六条"已知限制"逐条核实为 TRUE（含 TargetGapService.ts:136-141 源码自证 benchmark_observation≠official、gates.ts:345-351 零阻断、S4306515068 等）。缺口 G1-G7 → 最小复用方案（本任务实现 G1/G2/G7，其余按需）。**未重复造轮子**：零第二套 Gate/文献仓库/评分中心。

## 3. Phase B——真实期刊官方要求与参照系

- **两刊（自主选取=研究样本，非用户指定投稿目标）**：中国图象图形学报（cjig：专业旗舰、T1 自述、月刊、OA CC BY-NC-ND、Crossref 10.11834）× 计算机工程与应用（cea：综合性、半月刊、EI+Scopus 自述、全文登录墙、DOI 10.3778 非 Crossref）。六项可观察差异（定位/刊频/题目字数 20 vs 25/摘要四段式 vs 无明文/参考文献 ≥15+60%+全 DOI vs 无数量明文/全文可得性）。
- **Guideline Evidence**（phase-b/guideline-evidence.json + raw/ SHA256SUMS）：投稿指南/撰稿要求/同行评议/开放获取 6 页逐字摘录；生效日期或"未找到"逐条标注；收录状态按编辑部自述记 medium。
- **语料**：采集器 `scripts/m159-collect-benchmark.mjs`（--list/--dry-run/--resume；≥900ms 礼貌间隔；Crossref polite pool）。CJIG 24 篇分层选中（候选池 23 全文 PDF docling 解析 23/23 成功，2 个 >20MB 超 SourceStore 上限——解析产物直灌+如实登记）；CEA 24 篇元数据级（2024-2026 六期）。
- **Phase D 顺带发现并修复的真实产品缺陷**：docling 解析块不含 provenance 字段 → TargetProfileService.generate 在真实 docling 语料上必崩（paperStats 直接解引用 `block.provenance.section`）。修复：paperStats 防御性可选链（缺节如实零贡献）+ IngestionService.buildParsedDocument 边界归一（补 fileName 级最小 provenance）+ 测试。此缺陷证明 M12 profile 此前从未在真实 docling 语料上跑通过——Phase A 标记的 UNVERIFIED 面被实测暴露。

## 4. Phase C——独立标签体系与盲测协议（评估前 FROZEN）

- `phase-c/PROTOCOL_FROZEN.md`：预登记门 G-A1/G-A2/G-SP/G-NEG/G-UI + 统计规则（n=1 族不计算 CI）+ 风险容忍度（false-ready 零容忍）；双层标签（A=确定性 mutation oracle；B=独立人类标签——**LABELS_INSUFFICIENT** 如实声明，CNKI/编辑部审稿意见非公开、无合法公开 reviewer feedback）。
- 变异登记 `mutation-register.json`：B1c 合规对照（13 字题目/5 关键词/四段摘要/24 条全近 10 年全 DOI——oracle 预检全绿）+ F1-F8 + bnet 合成范围差分稿 + b1c-as-research 类型场景稿 + b1-original 真实标本；全部文件 SHA256。
- 偏差 7 条如实追加（deviations.md）：F6 以 M15.8.6 N1 fresh 锚替代重跑、G-TYPE 聚合器编码修正（对齐冻结原文而非改标准）、关键词要素缺失语义精化（不影响统计族）等。
- 专家标注任务包交付：`phase-c/expert-rubric-form.md`（六维四档双盲表单 + 独立性要求 + 交付格式 + 冻结纪律）。

## 5. Phase D/E——基线、实现与消融实测

**A0（内部 Gate，不改算法原样）**：F7 引用 key 破坏 → StaticCitationChecker 确定性检出 missing=1（bashar2022pursuit）——citation.verify 同机制；F6 数值矛盾类由 M15.8.6 N1 fresh 锚承担（fact reviewer 点名跨节矛盾→Gate FAIL→Finalize 422；deviations #1）。

**A1（M12 readiness，确定性）**：

| 样本×刊 | overall | 说明 |
|---|---|---|
| b1c × cjig | PARTIALLY_MEETS_TARGET | 真实 24 篇语料带（正文词数 p25-p75=4577-10063、n=23 coverage；表 0.5-6；文献带不可用——docling 无 references 节标注，如实 null） |
| b1c × cea | **INSUFFICIENT_EVIDENCE** | CEA 无全文语料 → profile unavailable → 全维不可判（场景 4 实证：不假装） |
| b1c-f5 × cjig | PARTIALLY_MEETS_TARGET | 文献条数 12 落带外（带内下限由语料分布决定） |

**A2（官方要求 + rubric，本轮新增能力）——Layer A 全量矩阵**：

| family（venue） | 预期 | 实测 | 结果 |
|---|---|---|---|
| F1 题目 22 字（cjig） | VIOLATION title≤20 | HARD_VIOLATION（cjig-title-20） | **TP** |
| F1（cea） | 零违规（≤25） | COMPLIANT | **TN**（venue 差分成立） |
| F2 关键词 3（cjig） | VIOLATION 5~8 | HARD_VIOLATION（cjig-kw-58） | **TP** |
| F3 近 10 年 42%（cjig） | VIOLATION ≥60% | HARD_VIOLATION（cjig-refs-recent） | **TP** |
| F4 摘要单段（cjig） | VIOLATION 四要素 | HARD_VIOLATION（cjig-abs-struct） | **TP** |
| F5 文献 12 条（cjig） | VIOLATION ≥15 | HARD_VIOLATION（cjig-refs-15） | **TP** |
| b1c（cjig/cea） | 零 | COMPLIANT/COMPLIANT | **TN/TN** |
| bnet（cjig/cea） | 零（格式合规） | COMPLIANT/COMPLIANT | **TN/TN** |
| b1c-as-research（cjig） | 零 | COMPLIANT | TN |
| b1-original（cjig/cea） | 3 违规/1 违规 | 3（title 25 字>20、关键词要素缺失、摘要无四要素）/1（关键词缺失） | DEMO（不进统计） |

**sensitivity=1.0（5/5）、specificity=1.0（6/6）、false-ready=0**（n 小：点值逐族报告，不计算 CI——协议 §0）。

**A2 rubric（模型 advisory，13 次调用之一）scope 差分**：bnet×cjig inScope=**false**（正确：网络协议超出图像图形范围）且 overall=WEAK；bnet×cea inScope=**true**（正确：网络、通信与安全栏目）overall=WEAK（合成稿本身单薄，诚实）；b1c 双刊 inScope=true。**4/4 正确**。
**类型敏感**：同稿 research 声明 → novelty/contribution 从 ADEQUATE 降 WEAK，且 rationale 主动点名"文章类型声明（research）与综述内容不符，需按小综述栏目重定位"；survey 口径 WEAK 理由为"文献覆盖仅 25 篇、摘要级依据、无图无表"（综述口径），零"缺实验"措辞。
**A2 vs A3（去 benchmark 带）**：b1c 双刊与 bnet×cjig 三组 A2≡A3；bnet×cea A2=WEAK vs A3=NEEDS_EXPERT_REVIEW——带使判断更确定；4 组不足以宣称普遍增益（如实）。

## 6. Phase F——真实产品端到端场景

1. **同稿两刊差异**（b1-original/b1c/bnet × cjig vs cea）：结论不同且各有官方条款出处（§5 矩阵）——非"只换刊名"。✓
2. **不同质量稿**：F1-F5 变异族在对应维度全部产生可定位差距；bnet（研究论文缺实质深度）rubric WEAK。✓（不假报专家判别准确率）
3. **官方硬性要求不符**：F1-F5 + b1-original 共 8 条可复核 VIOLATION（每条带官方原句+URL+观测值）。✓
4. **无全文 benchmark**：CEA readiness=INSUFFICIENT_EVIDENCE；CEA 指南层结构字段 NOT_EVALUATED。✓
5. **文章类型**：b1c-as-research vs b1c 对照（§5）。✓
6. **Gap→修订→复评**：b1-original（CJIG 3 违规：题目 25 字、关键词缺失、摘要无四要素）→ B1c 合法文字修订 → 复评 COMPLIANT（三差距闭合）。**文字修复 vs 需新材料的区分**：题目/关键词/摘要结构=文字修复可闭合；F3 近 10 年文献 42%→60% 无法靠改写措辞（需真实补引 2017+ 文献=研究材料）；survey→research 转型需真实新实验（Author Decision 通道，模型不得伪造）。✓
7. **负例安全**：F7 确定性检出；F6 类由 M15.8.6 N1/N2/H fresh 锚（gate FAIL/Finalize 422/HITL 停靠）承担零回归；gates.ts 零改动。✓
- 指纹纪律：guideline frozenAt、benchmark revision/fingerprint、rubric promptVersion（m159-rubric-v1）+ inputFingerprint（manuscriptDigestSha256/scopeStatementSha256/bandsIncluded/model）全链在案；资料变动即失效重评。

## 7. 判别力与误差汇总

见 §5 矩阵 + `phase-d/m159-aggregate.json`（机读）。**七门全过**：

| 预登记门 | 结果 |
|---|---|
| G-A1 sensitivity≥0.9 | **PASS**（1.0，5/5） |
| G-A2 false-ready=0 | **PASS**（0） |
| G-SP specificity≥1.0 | **PASS**（1.0，0 FP） |
| G-NEG 负例零回归 | **PASS**（F7 检出 + M15.8.6 锚 + 全量测试） |
| G-SCOPE venue 差分 | **PASS**（4/4） |
| G-TYPE 类型敏感 | **PASS**（research 封顶 WEAK + survey 零缺实验惩罚） |
| G-SCN4 证据不足如实 | **PASS**（CEA INSUFFICIENT_EVIDENCE） |

误差与边界（诚实）：Layer A n=1/族（点值无 CI）；rubric 单次采样无重复性数据；CJIG 语料 24 篇中 1 篇为 31 块预出版短文（已入带，分位带稳健但如实登记）；docling 无节标题 → CJIG sectionPattern/文献带不可用（NOT_EVALUATED 而非发明）；**期刊级人类标签维度全部 NOT_EVALUATED**。

## 8. 预算与开销

- 真实模型调用：**13 次 completeSimple**（1 次 CJIG profile 摘要 + 12 次 rubric A2/A3），单次 12-42s，driver log 逐条在案（phase-d/m159-driver-log.txt）。
- GlobalBudgetLedger：completeSimple 通道不经过账本（calls=0）——已如实披露；任务预算按物理计数 13/600。零 runAgent 调用（无 workflow 重跑）；采集/解析/聚合/审计全部零模型。
- 失败调用：0；结构化 repair：0 次触发。

## 9. 终局裁决与验收门逐项证据

- **Engineering PASS（9.1）**：官方要求/语料/工件链可审计（guideline-evidence SHA + manifest + benchmark revision/fingerprint）✓；benchmark 源与 Evidence 隔离红线保持（role=reference；未升格）✓；API/UI 正确展示 unknown 与差距（NOT_EVALUATED 一等）✓；typecheck/build 双端绿 ✓；测试：target 88/88、quality 300/300、guideline 19/19、全量 4404-4406/4451（2-8 个并行负载闪失逐文件单跑全绿，仓库既有模式；CI 为准）✓；M15.8.6 保护锚零回归（gates.ts 零改动 + N1/N2/H 语义未触碰）✓。
- **Scientific Evaluation PASS（9.2）**：**不满足**——9.2.2 独立人类标签缺失（LABELS_INSUFFICIENT）；9.2.3 期刊级 held-out 判别 NOT_EVALUATED；9.2.4 中"明显不合格稿件不可接受达标误判"在 Layer A 客观缺陷域已证 false-ready=0，但期刊级质量档位判别未证。9.2.5 差距驱动修订例已交付（§6.6）。
- **合法状态：`M15_9_PARTIAL_ENGINEERING_PASS + PARTIAL_SCIENCE_DATA_BLOCKED`；M15_OVERALL=INCOMPLETE**。恢复 COMPLETE 的唯一路径：授权专家标注（表单/采样/独立性要求就绪）→ 标签冻结 → 期刊级 held-out 实测达预登记指标。

## 10. Git/CI 收口

- 提交链：`950279d`（基线）→ `42680c8`（§1 纠偏）→ `f5a83f7`（Phase E：G1/G2 服务+HTTP+前端+采集器+harness+测试）→ 本报告与收口提交（见 `git log`）。
- 验证：backend typecheck/build ✓、frontend typecheck/build ✓、全量 vitest 如 §9、git diff --check ✓、HEAD==origin/main、工作区 clean（终验见下）。
- CI：GitHub CI + Linux Integration 以最终 HEAD 状态为准（链接回填于 PROJECT_STATUS 收口条目）。
