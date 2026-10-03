# M11.3 Pre-Acceptance Report

日期：2026-10-03/04（夜间专项）　执行人：Claude（GLM-5.3）　性质：Read-only 质量审计 + Case B 通用性预验收

数据基线：Case A = `e2e/.tmp/m1112-survey-e2e/projects/p-6de7674cd29e`（MOT Survey，冻结态 r8）；Case B 见 §6。

---

## 1. Case A Current State（MOT Survey）

| 项 | 值 |
|---|---|
| 项目 | `p-6de7674cd29e`（documentType=survey，29 文献 → 29 matrix entries → 70 synthesis） |
| 终态 | r8：**QUALITY_NOT_REACHED**，Draft PDF 冻结（256KB） |
| academicScore | 77（threshold 80） |
| claim grounding | 65 claims：39 SUPPORTED / 13 PARTIALLY_SUPPORTED / **13 UNSUPPORTED** / 0 CONTRADICTED |
| gate | FAIL ×4 规则：`unsupported_critical_claims_zero`(13)、`blocking_issues_zero`(4)、`open_critical_major_zero`(critical=2 major=5)、`academic_score_threshold`(77<80) |
| corpus | 29 源：fulltext resolved 24 / not_found 2 / failed 3；matrix 口径 fulltext 23 / abstract_only 6 |
| evidence store | 206 条全 verified；**7 个源零证据**（S011/S014/S016/S024/S025/S026/S028） |

完整修订轨迹（iteration-history）：

| 轮 | academic | critical | major | blocking | styleRisk | 标注 |
|---|---|---|---|---|---|---|
| rev1 | **81** | 2 | 8 | 3 | 38 | — |
| rev2 | 72 | 0 | 14 | 1 | 35 | IMPROVED |
| rev3 | 72 | 1 | 5 | 1 | 33 | REGRESSION |
| rev4 | **80** | **0** | 8 | **0** | 40 | IMPROVED |
| rev5 | 79 | 1 | 3 | 1 | 40 | REGRESSION |
| rev6 | 78 | 1 | 4 | 1 | 42 | CONVERGED |
| rev7 | 78 | 0 | 12 | 2 | 25 | REGRESSION |
| rev8 | 77 | 2 | 5 | 4 | 30 | REGRESSION |

## 2. Unsupported Claim Audit（13 条逐项分类）

判定材料：`review-r8-fact.json`（claim+note 含 reviewer 归因）、`claim-grounding-r8.json`、`sources/index.json`（全文状态）、`evidence/evidence.jsonl`（每源证据计数）、正文 tex。

分类目说明：A=已有 Evidence Writer 未用 / B=已有全文 Evidence 未 Ground / C=claim 太强应弱化 / D=应删除 / E=需 targeted evidence search / F=Reviewer 误报 / G=需作者裁决。

| # | section | claim（摘） | 涉及文献 | 现状 | 分类 | 建议动作 | 置信 |
|---|---|---|---|---|---|---|---|
| 1 | appearance-embedding-reid | 模板移植到农业番茄跟踪计数 | ge2022tracking = **S024 全文 resolved，证据 0 条** | 正文已加摘要级限定 | **B** | 对 S024 定向 evidence grounding（确定性，无需新检索） | 高 |
| 2 | appearance-embedding-reid | Deep OC-SORT 选择性吸收外观+自适应加权；自承未根除噪声 | maggiolino2023deep = **S016 全文 resolved，证据 0 条** | 正文自注「尚待证据级核验」 | **B** | 对 S016 定向 grounding | 高 |
| 3 | appearance-embedding-reid | SMILEtrack PRB-Net 优于 YOLOX；模块移植 ByteTrack 验证叠加性 | wang2024smiletrack = S005 resolved，13 条证据但 E013/E103 不覆盖 PRB-Net/移植 | 综合表述 | **B** | 定向补 ground S005 的检测端对比与移植实验段落 | 高 |
| 4 | learned-e2e | ContrasTR 指出 DETR 对象级嵌入缺乏细粒度外观 | ContrasTR = S009 resolved，E005 不含该表述 | 引申定位 | **B 或 D** | 先查 S009 全文：有此表述→补 ground（B）；无→删除该引申（D） | 中 |
| 5 | learned-e2e | 学习式关联三路线及共同主张 | **S011/S014/S025/S026/S028 五篇全部 not_found/failed**（获取重试 4-5 次未成） | 正文已声明「待全文核验」 | **E（备 C）** | targeted fulltext 重试（换 OA 源/手动 PDF）；不可得则整组降级删除 | 高 |
| 6 | multimodal-3d | 混合级融合因分支众多显著拖慢推理 | 无对应源 | 综合推断，E020/E110 仅支持标定/偏移重要性 | **C** | 弱化为已支持范围（时间偏移与空间标定代价），删「显著拖慢」 | 高 |
| 7 | cross-method-comparison | BoostTrack 65.45/32.79→15.35/3.05 FPS | BoostTrack = S004 resolved（14 证据） | **M11.2.1 已授权删除的数值在比较节回潮** | **D（备注 B 可行）** | 按既定授权删除；若想保留须先 ground S004 的 FPS 表格 | 高 |
| 8 | cross-method-comparison | DeepSORT 模板 +0.05 / UCMCTrack >1000FPS / RFS 削减 99.5% | UCMCTrack = S006 resolved（11 证据）等 | 同上：回潮数值 | **D（备注 B）** | 同 #7；UCMCTrack 1000FPS 疑可从 S006 全文 ground | 高 |
| 9 | cross-method-comparison | ContrasTR 以历史记忆余弦相似度分配 ID | S009 resolved，E005 未覆盖机制细节 | 机制描述 | **B** | 定向 ground S009 的匹配机制段落 | 高 |
| 10 | cross-method-comparison | 重型学习式外观 vs 近零开销自适应外观速度两极分化 | S016（0 证据）+ S005（速度证据 0） | 已加「据报告」限定 | **B+C** | 补 ground 双方速度数据；不足则保留限定措辞降为弱表述 | 中 |
| 11 | research-gaps | 六处自述局限（MOT16 7 序列/GLOA car-only/雷达标定/karle 36%/BoT-SORT GMC/SMILEtrack FPS），均已加「据其原文自述且未经独立核验」 | 各源 | **M11.2.1 typed weakening 成果，透明呈现** | **G（政策）+E** | 口径决策：透明自述类是否计入 zero-UNSUPPORTED gate（见 §5 P-3）；证据侧可对 yang2022video 等 resolved 源补 ground | 高 |
| 12 | research-gaps | STDFormer 未建模相机运动（E198 部分支持）+ UAV 性能远逊 + Cell-TRACTR 时序受限 | S013 resolved（11 证据）/ S002 resolved（10 证据） | 前半有据后半未限定 | **C+D** | 「未建模相机运动」保留（E198 支撑）；「性能远逊」「Cell-TRACTR 受制于编解码器效率」未限定且无证据→弱化或删 | 高 |
| 13 | future-directions | RTU++ 将长期跟踪信息利用列为改进目标 | RTU++ = S025 not_found | 已加「据其摘要、待全文核验」 | **E（备 C）** | S025 全文获取成功→ground；否则维持摘要级限定（口径同 #11） | 中 |

**分类统计**：B 主分类 5 条（#1#2#3#9 + #10 半）+ 备选若干；C 3；D 3（#7#8 回潮数值 + #4 备）；E 2；G/口径 1（#11）。

**核心可行动发现：13 条中约 5 条可经「定向 evidence grounding」确定性修复（全文已在库、零新检索）**。零证据源清单：S016（Deep OC-SORT）、S024（番茄）为"resolved 却零证据"的纯 pipeline 缺口；S005/S009/S013/S002/S004/S006 为"有证据但覆盖不足"。

## 3. Academic Score Audit（77/80 的真实组成）

六维：覆盖完整性 80 / 分类与组织 78 / 文献均衡性 76 / 比较与论证 76 / 引用支撑 78 / 写作质量 78 → overall 77。

**哪些是真问题（内容侧，修稿可消除）：**

1. 2 个 critical 均为 **r7→r8 修订引入的回归**：Hybrid-SORT 自述短板被改写为全面优势（方向反转）+ DiffusionTrack/Cell-TRACTR 负结果证据被删。这不是初始写作缺陷，是修订行为缺陷。
2. 「关键分歧」小节**文本截断**（\cite 处断句，后续条目缺失）×2 处 blocking —— 编译/组稿级真问题。
3. 三条 minor「上轮已报未修复」：子族粒度口径不一 / shi2023global 双名（OADA vs GLOA）未对应 / guan2025multi 定位描述不符 —— 修订轮没有消化 reviewer 的 carry-forward issue。

**哪些是 rubric / 口径结构性因素：**

4. **同一根因多规则重复惩罚**：r8 的 2 critical 同时导致 `blocking_issues_zero`、`open_critical_major_zero` 失败，相关 claim 又计入 `unsupported_critical_claims_zero` —— 4 条失败规则里 3 条由同一批回归喂料。
5. **透明自述类论断计入 zero-UNSUPPORTED**：#11 六处已按诚实降级口径限定，仍被判 UNSUPPORTED 并喂 gate。reviewer 判定本身无误（证据库确无记录），是 gate 口径把「透明但未核验」与「无中生有」同罪。
6. 摘要级 6 篇（evidence_gap major）压低 文献均衡性/引用支撑 两维 —— 属 corpus 获取限制（OA not_found/failed），非写作缺陷。

**是否残留原创论文 reviewer 逻辑：无。** academic 模式在 survey profile 下使用七维综述 rubric（覆盖/taxonomy/均衡/比较公正/引用支撑/gap 依据/anti-listing），prompt 明确禁用「研究空白/创新点/实验充分性」原创标准（`ReviewerService.ts:546-561` 实读确认）。

**77 是"论文差"还是"机制问题"：** 分数轨迹 81→72→72→80→79→78→78→77 表明**修订环不收敛（振荡）**：rev4 曾达 80/0critical/0blocking，此后每轮修复一批问题引入另一批。77 是振荡的当前相位，不是论文质量的单调度量。六维均分 76-80、无单维崩坏，与"整体质量接近门槛、被修订回归与口径规则压住"的读法一致。

## 4. Potential Reviewer False Positives

| 假设 | 核验结果 |
|---|---|
| Reviewer 找不到已有 Evidence | **部分成立，但不是 reviewer 的错**：S016/S024 全文 resolved 而证据库 0 条 —— reviewer 只见 evidence store 不见原始 PDF，如实报「零记录」。根因在 evidence pipeline 覆盖，非判定端 |
| 引用存在但绑定错位 | 未见（citation 核验 29/0/0，claim→evidence 绑定错误未见实例） |
| 弱化措辞仍被判强 claim | **不成立**：reviewer note 明确认可限定（"已按摘要级口径限定，属透明呈现但无已核验证据"），判 UNSUPPORTED 的依据是证据库无记录而非误读强度 |
| multi-source synthesis 被逐句误判 | 未见实例 |
| future speculation 误判为 factual | 未见（prompt 有专项规则，r8 无该类误报） |

结论：**本轮无语义级 reviewer 误判**。"假阳性感"来自 (a) evidence 覆盖缺口被如实报告 (b) gate 口径问题（§3.5）。

## 5. Proposed Fixes（仅 Proposal，今晚一律不实施）

| # | 提案 | 针对 | 性质 | 预期效果 |
|---|---|---|---|---|
| P-1 | 对 S016/S024/S005/S009/S004/S006/S013/S002 跑定向 evidence grounding 补采（chunk 检索 + quote 核验，零新文献检索） | #1#2#3#9 + #7#8 数值 | 确定性管线操作 | UNSUPPORTED 13 → 预计 ≤8 |
| P-2 | G1 累计事实守卫白名单扩到 cross-method-comparison（回潮数值拦截） | #7#8 的产品级根因 | 产品修复（fact-preserve 扩围） | 修订回归类 blocking 消除 |
| P-3 | gate 口径：已限定的「自述类」论断（据其原文自述/摘要级+声明待核验）在 zero-UNSUPPORTED 规则中单独计数或豁免 | #11（+#5#13 部分） | **口径决策，需作者裁决** | 透明降级不再被 gate 阻断 |
| P-4 | 摘要级 5 篇（S011/S014/S025/S026/S028）targeted fulltext 换源重试；仍不可得→按 #5 处理 | #5#13 | 检索运维 | 语料完整性 |
| P-5 | 修订环收敛机制（振荡 81→77；carry-forward minor 从未消化；critical 回归反复出现） | 整体 | **策略决策，需作者裁决**（候选：修订轮只允许 carry-forward 全消化才进下一轮 / 回归检测回滚 / 最好轮次快照取胜） | 决定 M11.3 能否开工 |

## 6. Case B（第二真实 Survey Topic 通用性验收）

| 项 | 值 |
|---|---|
| 主题 | **多模态大模型中的视觉编码方法**（探针：OpenAlex 2021+ 样本 OA 率 C 72% > A 56% > B 36%；与 MOT 分布差异最大） |
| 项目 / run | `p-8c225ac897ec` / `w-ea70c0defd30`（`e2e/.tmp/case-b-survey/`，数据保留） |
| 输入路径 | 正式 workflow：只输入 Topic 创建项目 + 启动（4 个前置 HITL 自动 approve，payload 已记录；零中间 API 代跑） |
| 遴选 | 87 候选 → 推荐 25 → 全部入选（目标区间 15–25 ✓） |
| 全文 | **resolved 5 / failed 21**（arXiv PDF 直连超时→熔断 + unpaywall 422；矩阵口径 fulltext 5 / abstract_only 20） |
| Matrix | 25 entries；unclassified **15**（60%）；已归类 10 分入 native_early_fusion(3)/video_temporal_encoding(2) 等 8 族 |
| Synthesis | 30 条（taxonomy 9 / future_direction 7 / comparison 4 / consensus 4 / research_gap 4 / disagreement 1 / trend 1）；grounding literature_cited 23 |
| Outline | 12 节，synthesis 覆盖 100% / literature 覆盖 100%，warnings 3（非阻断）；speculative 4 条全部隔离在展望章节 |
| Writing | 完成（12 节 + main.tex） |
| Citation | **25 cited / 0 missing / 0 hallucinated**（新主题全链引用完整性满分） |
| Review | r1 三路 25 issues（fact 10 / academic 6 / style 等）；r1 academic=**66**、claims 45、unsupported 16；修订后 r2 academic=**72** |
| Revision | 修订 1→2 完成（66→72）；修订 2→3 触发事实守卫 |
| Gate / 终态 | **FACT_PRESERVATION_FAILED**（build.draft permanent，重试 1/2 耗尽）：「修订 2→3 存在未经 RevisionPlan/Evidence 授权的事实改写」→ **无 PDF 产物** |
| 运行观测 | 57 min；99 agent tasks / 125 model turns / 66 tool calls；tokens in 634k / out 305k / **cacheRead 4.32M**；**$3.35**；最长 turn 221s（p50 16s）；runtime error spans **0**（唯一 error span = build.draft 工作流级阻断，非 Runtime） |

**归因（§15 要求）**：失败不是基础设施故障，也不是 Pi 1.0.1 回归——是**已知 M11.2 问题家族在新主题上复现**：事实守卫正确拦截了修订 2→3 中未经授权的事实改写（守卫行为正确），说明 M11.2.1 的 typed-weakening 授权通道在「降级语料 + 高弱化压力」场景下覆盖不足（writer 的弱化/改写超出授权类别）。这与 M11.2 PARTIAL 时登记的待裁决项（授权通道认计划指示的弱化删除 / 报告值 vs 作者事实分层）是同一根因，Case B 提供了第二个真实样本。

**质量读数**：r1=66 直接反映语料降级（80% abstract-only + 60% unclassified）；修订后 72。若全文可得率恢复到 Case A 水平（83%），质量基线预期显著上移——此推断今晚未验证（受网络条件限制）。

## 7. Case A vs Case B

| 维度 | Case A（MOT 数据关联） | Case B（MLLM 视觉编码） |
|---|---|---|
| corpus | 29 源 | 25 源 |
| fulltext ratio | 83%（24/29 resolved） | **20%（5/25）**（网络条件） |
| unclassified ratio | 低（矩阵全 fulltext 精读） | **60%** |
| synthesis 分布 | 70 条 | 30 条（7 类全出现，结构完整） |
| evidence-backed ratio | 39+13/65=80%（r8） | r1 29/45≈64% |
| citation 密度/幻觉 | 29 keys / 0 幻觉 | 25 keys / **0 幻觉** |
| 首轮 academic | 81 | 66（语料降级主导） |
| 修订轮数 | 8 轮（M11.2 全程） | 2 轮后守卫阻断 |
| 终态 | Draft PDF（QUALITY_NOT_REACHED） | **无 PDF（FACT_PRESERVATION_FAILED）** |
| runtime 失败 | 0 | 0 |
| duration / turns / cost | 尾段 39min / 51 turns / $2.97 | 全程 57min / 125 turns / $3.35 |
| Pi 1.0.1 异常 | 0 | 0（cacheRead 4.3M、无 session 泄漏、无 retry 风暴、事件配对完整） |

定性对比（vs 0.84.4 基线 222 tasks / 352 turns / 2.5h）：单 turn 成本、token 结构、cacheRead 命中、会话生命周期全部同量级，无异常模式。

## 8. Generalization Verdict

**PARTIAL —— 基础能力已泛化，质量链未达开工条件。**

已泛化（跨主题成立）：

1. 端到端基础设施链：Topic → 检索 → 遴选 → 全文（诚实降级）→ Matrix → Synthesis → Outline（100%/100% 覆盖、validator 未误杀）→ Writing → Citation（零幻觉）
2. 降级鲁棒性：80% abstract-only 语料下 outline/组织检查全部通过，未 fail-closed 误杀
3. Runtime：Pi 1.0.1 两案例零异常

未泛化（阻断 M11.3 开工）：

1. **修订环授权语义不足**（Case B 复现 FACT_PRESERVATION 阻断；M11.2 遗留决策的第二样本）
2. 证据链深度依赖语料质量：abstract-only 占比高时 unsupported 率与学术分显著恶化，且 evidence pipeline 对「全文在库源」的覆盖不足（Case A 的 S016/S024 现象）
3. 修订环收敛性（Case A 振荡 81→77；Case B 66→72→阻断）

结论：M11.3 **尚不具备正式开工条件**——需先完成 §5 P-1（定向 grounding）、§9 D-1（授权语义裁决）、D-2/D-4（口径与收敛策略）。

## 9. Decisions Required Tomorrow

| # | 决策 | 背景 | 建议选项 |
|---|---|---|---|
| D-1 | **修订环授权语义**（阻断项） | Case A r8 修订回归 + Case B FACT_PRESERVATION_FAILED 双样本：守卫正确但授权通道覆盖不足 | (a) 授权通道认计划指示的弱化/删除（M11.2 候选）；(b) 报告值/作者事实分层；(c) 守卫阻断后自动生成恢复计划重试 |
| D-2 | gate 口径：透明自述类论断是否计入 zero-UNSUPPORTED | §3.5：诚实降级被 gate 阻断 vs 零证据论断零容忍的初衷 | (a) 单独计数不阻断；(b) 豁免「已声明待核验」类；(c) 维持现状 |
| D-3 | P-1 定向 evidence grounding 补采是否先行 | §2：13 条中约 5 条可确定性修复（S016/S024/S005/S009 等全文在库零/欠证据） | 建议先做（无新检索、低成本、直接消 unsupported） |
| D-4 | 修订环收敛策略（P-5） | 振荡 81→72→80→…→77；carry-forward minor 从未消化 | (a) carry-forward 全消化门；(b) 最优轮快照取胜；(c) 回归检测回滚 |
| D-5 | Case B 全文网络问题的运维决策 | arXiv 直连超时+unpaywall 422（node fetch 不走代理）；Case A 昨日可下载 | 代理/镜像源配置（hf-mirror 等既有绕障经验可复用） |
| D-6 | F-6 upstream Issue 是否提交 | A 类已定案，draft 就绪（升级报告 §8.5） | 建议提交（标题/正文/复现脚本齐备）；等作者确认 |
| D-7 | M11.3 开工时点 | §8：NOT READY | 待 D-1~D-4 落地后重估 |

---

*附：Case B 运行产物 `e2e/.tmp/case-b-survey/`（report.json + 项目数据全量保留）；Case B 驱动 `scripts/m113-case-b-survey.mjs`。*
