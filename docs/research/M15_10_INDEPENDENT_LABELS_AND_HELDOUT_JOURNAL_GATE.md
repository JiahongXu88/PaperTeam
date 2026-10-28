# M15.10 — 独立专家标签获取与目标期刊 Quality Gate 盲测校准

- 日期：2026-10-28（晚） · 任务书：M15.10（P0，属 M15） · DATA-FIRST
- 基线：`727f711a0787cdfce88adaefafc2af65c235c6a8`（M15.9 收口，== origin/main，clean）→ 本轮提交见 §10
- 数据根（仓库外）：`D:\PaperTeamData\M15\M15_10\`（phase-a/b/c + budget + MANIFEST.json；116 文件 SHA256 全账）
- 预算：任务保护上限 600；**真实模型调用 0 次**（本轮全部为零模型工作；docling 为本地确定性解析组件）

## 0. 第一屏裁决（任务书 §8-#10：不模棱两可）

**本轮裁决 = `DATA_BLOCKED`**（数据/实验工程状态：`DATA_BLOCKED`；M15 总体：`M15_INCOMPLETE` 维持）。

限制写在第一屏：
1. **独立人类专家标签 = 0 份**。两目标期刊（CJIG/CEA）官网今日直抓取证确认：审稿意见均仅送达作者（CJIG 双向盲审、CEA 单盲），无任何公开评议渠道 → `PUBLIC_HUMAN_LABELS_AVAILABLE = NOT_AVAILABLE`（两刊）。开放评审平台（OpenReview/F1000 等）不含两刊内容，且 venue 语义不可迁移，只能作方法辅助——不得冒称目标期刊标签。
2. **Phase D 期刊级盲测未启动**（前置门 5 条件的标签侧全部未满足；导入器对空模板实测输出 `cjig 0/10、cea 0/10` blockers）。因此期刊级 false-ready / false-reject / balanced accuracy / abstention / coverage / A0–A3 差异全部 **NOT_EVALUATED**——本轮无任何"判别准确率"结论，也不存在以内部 Gate/官方格式符合率/已发表身份冒充的替代品。
3. **已完成的是唯一合法路径的全部前置工作**：13 个 held-out 候选 paper family（12 个与 M15.9 benchmark 严格隔离的新鲜 CJIG OA 族 + 1 个作者综述稿 DEV_ONLY）采集/解析/脱敏就绪；双盲评审包×2（不同次序/编号、隐藏一切系统输出）就绪；六维 rubric/CSV 契约/导入校验器/冻结协议（含预登记阈值与 SCIENTIFIC_EVIDENCE_INSUFFICIENT 触发条款）在**标签数=0 时冻结**。恢复 COMPLETE 的唯一路径：真实评审回填 CSV → 校验冻结 → 前置门满足 → 一次性开封盲测。

## 1. Phase A——基线与标签资源审计（零模型）

产物：`phase-a/BASELINE_AND_LABEL_AUDIT.md` + `label-source-audit.json`。要点：

- **四类标签 taxonomy 不可互相顶替**（任务书 §Phase A）：T1 客观指南标签（M15.9 已冻结消费，≠学术质量档位）、T2 注入缺陷 oracle（Layer A 域）、**T3 独立专家学术质量标签（=0，本轮核心缺口）**、T4 编辑决定/发表状态（不可合法获得；发表≠达标、未发表≠负样本、引用数只作采样分层）。指定基线材料 11 项全部读取，无 MISSING。
- **M15.9 协议覆盖核对**：其预登记门（G-A1/A2/SP/NEG/UI）全部面向 Layer A；Layer B 行明文 `LABELS_INSUFFICIENT`→期刊级指标 NOT_EVALUATED——**未预注册任何期刊级阈值**。结论：M15.10 必须新预注册（本轮 Phase C 执行；标签不存在，冻结天然先于开封）。
- **family 清单与 held-out 资格**：M15.9 CJIG/CEA benchmark 48 族=污染（隔离）；B1 MOT 族=M15.9 rubric 开发语料→`DEV_ONLY`；F1-F8=T2 不可顶替；本轮新鲜 12 族=held-out 候选 ✓；作者自有稿=待协调候选。
- **B1 公开评议取证**（2026-10-28 官网直抓，快照+SHA256 留存）：
  - CJIG `http://www.cjig.cn/zh/info/13449/`："采用双向盲审的同行评议机制……评审结果及评审意见由本刊编辑汇总后及时通知作者"——仅通知作者，非公开；
  - CEA `http://cea.ceaj.org/CN/column/column17.shtml`："执行单盲同行评审制度"，2 名外审（分歧第 3 人），修改意见经"作者查稿"模块送达——非公开。
  - 工具如实用记：WebSearch/webReader MCP 当日 429 配额耗尽（2026-11-03 重置）；不影响结论方向（官网一手证据优先于搜索摘要）。

## 2. Phase B3——held-out 样本采集（与 benchmark 严格隔离）

- 采集器 `scripts/m1510-collect-samples.mjs`（复用 M15.9 采集纪律：Crossref 快照缓存池、≥900ms 礼貌间隔、分层轮转）：候选池 340 篇（主题命中 364 − benchmark 24 DOI 确定性排除）；分层（年份桶 × 排除后池内引用三分位重算 × 文章类型）轮转选中 **12 篇**，**12/12 官网 OA PDF 全文下载成功**（CC BY-NC-ND 4.0，非商业研究标注用途；副本+SHA256 仅存仓库外数据目录）。采样概率/层池大小/排除原因全部入 manifest（`phase-b/corpus-fresh/cjig-fresh-manifest.json`）。
- 解析：`scripts/m1510-parse-pdf-text.py`（docling 2.130.0，`do_ocr=False` 与 backend 工具同纪律；TableFormer 开）——12/12 成功，页码/标签/阅读顺序齐全。
- 真实负类/档位问题如实处理：不按发表/未发表定档（B3 红线）；档位由评审按冻结 rubric 自然产生；引用三分位只用于**采样分层**。第 13 族 = MOT b1-original 作者稿（未发表，潜在低档位来源）——族级标注 `DEV_ONLY`（M15.9 rubric 臂输出已存在，只可作校准分析，不计入独立盲测）。

## 3. Phase B2——双盲评审任务包（本轮核心交付）

`phase-b/` 下全部就绪（内容自足，评审员无需任何其他背景）：

| 文件 | 内容 |
|---|---|
| `EXPERT_ANNOTATION_REQUEST.md` | 一页中文委托书：目的/工作量（13 篇 × 2 刊 ≈15-20h 可分批）/保密授权/利益冲突/独立性四条（不得检索出处、不得参考 AI 评价、评审间互不讨论、按真实标准评）/交付结构 |
| `EXPERT_RUBRIC_AND_INSTRUCTIONS.md` | 六维四档 rubric（m1510-rubric-v1，继承 M15.9 表单骨架）：novelty/contribution/technical_soundness/experimental_adequacy（survey 口径=文献覆盖与综合深度，不因缺实验降档；research 口径缺关键实验不得高于 WEAK）/relevance/clarity；每维 STRONG/ADEQUATE/WEAK/INSUFFICIENT_EVIDENCE 锚定（ADEQUATE 中线=该刊已发表论文一般水平）；overall 四档含 UNDECIDABLE；逐维证据要求（页码+章节+短语）+confidence 三档 |
| `ANNOTATOR_PACKET_1/`、`ANNOTATOR_PACKET_2/` | 同一批 13 样本、**不同随机次序与匿名编号空间**（P1-S01…/P2-A01…，seed 1510 登记）；含 README、委托书、指南、CSV 模板、两刊官方要求单（M15.9 guideline 工件渲染，逐条带官网出处）、13 篇脱敏正文 |
| `labels_template.csv` + `labels_schema.json` + `LABEL_IMPORT_GUIDE.md` | 24 列 CSV 契约（评审匿名 ID/包前缀/样本 ID/venue/类型判读/六维+证据/overall+理由/confidence/missing_info/COI/notes/日期）；V1-V10 导入规则；冻结流程与下游边界 |
| `HUMAN_ACTION_REQUIRED.md` | 用户卡点清单：协调 2 名（+1 仲裁备选）评审、分别发送两包、回收 CSV；明确"不需要专家做的事"；说明为何不可绕过 |

**脱敏**（`scripts/m1510-build-packets.py`，确定性三段策略：题录/身份模式丢弃 → 论文题锚（同页 摘要+关键词 双确认）前内容整体丢弃 → 题锚后作者行/单位块丢弃）：移除作者/单位/基金/收稿日期/DOI/刊名卷期/页眉页脚/版权块/邮箱/作者简介；保留题目/摘要/关键词/正文/图表题注/参考文献。逐样本残留 grep：命中仅为参考文献 arXiv URL 与硬件规格（合法内容）；**已知不可完全去标识局限如实登记**（题目可检索、自引暴露——靠独立性声明"不得检索"约束，包 README 明示）。

## 4. Phase C——协议与冻结（标签数=0 时，先于一切开封）

- `phase-c/PROTOCOL_FROZEN.md`：预登记 G-IRR（两评审加权 κ≥0.40 否则 `SCIENTIFIC_EVIDENCE_INSUFFICIENT`）/G-FR（期刊级 false-ready 观测=0 + Wilson 上界）/G-FR2/G-FREJ/G-BA（≥0.75 探索性）/G-COV/G-NEG（M15.8.6 N1/N2/H 零回归）/G-STRATA + 统计纪律（n<8 只报点值；禁"准确率 X%"总体宣称）；**SCIENTIFIC_EVIDENCE_INSUFFICIENT 四触发条款**（任一 gold-decidable venue <8 族 / κ 不达标且仲裁后仍不达标 / 档位坍缩单档 / coverage<50%）。
- 六维→金标准映射预注册：双评审 overall 同档→gold；相邻档→`DISPUTED_ADJACENT`（边界样本，第三仲裁 lineage 全留，无仲裁→UNDECIDABLE）；隔档→必仲裁；原始分歧**永不投票合并**；`DIM_OVERALL_TENSION` 仅审计不覆盖；二分类口径将 NEAR/UNDECIDABLE 排除出 FP/FN 分母（防边界样本污染）。
- 泄漏四红线（评估族不进任何 benchmark profile；标签不进任何 arm 输入；M15.9 臂产物不进新项目目录；双包映射不进模型输入）+ 盲态输入对齐（专家与系统看同一脱敏文本）+ 开封纪律（不可回调阈值；迭代需新版本+全新 held-out）。
- `sample-manifest.json`（13 族：12 held-out 候选 + mot-b1 DEV_ONLY；benchmarkDois=24 隔离集；双包映射；每族 textSha256）+ `label-policy.json` + `ablation-plan.json`（A0=内部 Gate 确定性子检查 **NOT_RUN_FULL**——M15.9 已裁决内部 Gate 非期刊级判别器；A1=M12 readiness；A2=M15.9 指南+rubric（`m159-rubric-v1` 零改动）；A3=A2−benchmark 带；A2 复测×4 族方差；Phase D 预算 ≤80 调用）。
- 冻结指纹（SHA256）回填于协议 §8；`deviations.md` 建立只追加登记。

## 5. 导入器与测试（仓库内最小必要改动）

- `backend/src/target/expertLabels.ts`（新，纯函数模块，**零 HTTP/零 Gate 接线**——不违反 Phase E 红线）：RFC4180 CSV 解析（引号字段含逗号/换行）、V1-V10 校验（枚举/必填/唯一键/包归属/跨包独立/COI 剔除/证据启发/盲测前置门/benchmark DOI 泄漏 manifest 级拒绝/确定性无时间戳）、freeze（行级+总 SHA256、`blindTestTriggered`）。
- `scripts/m1510-label-tools.mjs`：validate/freeze CLI（零模型）。对真实 manifest 实测：空模板→`ok:true, blindTestTriggered:false`（blockers 如实列 0/10）；合成 52 行全量→冻结产物生成（`packet-build/smoke/`，SYNTHETIC_TOOLING_ONLY，永不入金标准）——**即使标签"齐全"，`rightsVerifiedAt=null` 仍正确阻止盲测门**。
- `backend/test/target/expertLabels.test.ts`：21 用例覆盖任务书 §7 要求——标签导入校验、重复 family/泄漏拒绝（V9 manifest 级）、不完整标签不触发盲测（V8 三态：缺评审/单刊/rights 缺失）、正确 abstention（V7 UNDECIDABLE/INSUFFICIENT 合法）、确定性结果复现（V10 逐字节）、枚举完整性。21/21 通过。
- 红线核对：gates.ts / qualityPolicyV2.ts / Target{Benchmark,Profile,Gap}Service / 前端 **零改动**（M15.8.6 N1/N2/H 保护锚零触碰——G-NEG 的本轮形态）；不搞第二套 Gate。

## 6. Phase D / Phase E 状态

- **Phase D 未启动**（合法：标签 0）。按协议 §4，启动前置五条件由导入器 V8 机检 + 人工确认；未满足时允许的零模型工作（数据验收/导入器测试/负例回归复验）已全部完成。
- **Phase E 零产品改动**：无实际盲测缺口 → 不引入任何新 Gate/阈值/校准工件；目标期刊层保持 M15.9 的 ADVISORY_UNCALIBRATED 语义；唯一仓库改动 = 研究工具（采集/解析/构建/校验四脚本 + expertLabels 纯模块 + 测试）与本报告。

## 7. 预算与如实账

- 模型调用：**0**（completeSimple 0 / runAgent 0 / 其他 0）；失败 0。`budget/budget-ledger.json` 物理计数口径（GlobalBudgetLedger 不覆盖 completeSimple 通道——M15.9 已披露，沿用）。
- 零模型完成的网络工作：CJIG 文章页+PDF 抓取 12×2 次（900ms 间隔）、官网取证页 4 次、Crossref 快照复用（0 新调用）。

## 8. 最终答卷（任务书 §8 十问逐条）

| # | 问 | 答 |
|---|---|---|
| 1 | 已取得多少真实独立人类评审？ | **0 份**。来源/授权无从谈起；两刊各 0 个 family 有标签。已有：13 个待标族（12 held-out 候选 + 1 DEV_ONLY）+ 双包 + 契约，等 2 名独立评审 |
| 2 | 标签能否覆盖 ≥2 档位？ | **未知**（0 标签）。协议已预防：档位由评审产生（发表状态不预判）；若坍缩单档 → SCIENTIFIC_EVIDENCE_INSUFFICIENT（预注册条款） |
| 3 | 公开评议材料是否来自目标期刊？ | **否——目标期刊无公开评议渠道**（§1 取证）。开放评审平台不含两刊且 venue 语义（范围/栏目/档位基准）不可迁移，仅可作方法辅助（本轮未用） |
| 4 | 基准与 held-out 是否按族隔离？泄漏？ | **是/零**。新鲜 12 族与 benchmark 24 DOI 集合差证明（采集器确定性排除）；mot-b1 标 DEV_ONLY；导入器 V9 对"benchmark DOI 未标 devOnly"的 manifest 级 REJECT；双包映射不出现在任何模型输入（协议红线）。本轮模型调用 0 → 无模型侧泄漏面 |
| 5 | 预注册何时冻结？盲态？看后改阈值？ | 2026-10-28 晚，**标签数=0、预测数=0 时冻结**（sample-manifest/label-policy/ablation-plan SHA256 在协议 §8）；本轮无任何开封（无从看后改）；开封纪律预注册（迭代需新版本+全新 held-out） |
| 6 | CJIG/CEA 分别的 false-ready/false-reject/BA/abstain/coverage/CI/A0-A3 差异？ | **全部 NOT_EVALUATED**（Phase D 未启动——标签 0，前置门未满足）。不编造任何数值 |
| 7 | 期刊内容差距是否有真实学术证据支持？ | 本轮未产生新的差距判断（无模型调用）。既有 M15.9 Layer A 差距=官方条款级（非创新性判断）；"字数/文献量接近 benchmark→创新性达标"的风险已在协议中由"专家标签为唯一期刊级真值"约束 + abstention 通道约束 |
| 8 | M15.8.6 工程保护锚是否保留？ | **是**：gates.ts 零改动（本轮 git diff 可证）；N1 数值矛盾/N2 引用损坏/H 作者决策语义未触碰；quality 测试 300/300 全绿 |
| 9 | 模型调用/耗时/成本/git 改动/测试/同步？ | 模型 0 次 0 成本；耗时≈3.5h（采集+12 PDF 解析+包构建+协议+测试）；git 改动=4 脚本+1 模块+1 测试+2 文档（见 §10）；测试：新增 21/21、target+quality 409/409、全量见 §10；提交推送 origin/main |
| 10 | 终局裁决？ | **`DATA_BLOCKED`**（非 EXPERIMENT_FAIL——无实验失败，是数据不可得；非 SCIENTIFIC_EVIDENCE_INSUFFICIENT——证据链尚未开始；M15 总体 `M15_INCOMPLETE` 维持） |

## 9. 限制与边界（诚实清单）

1. 评审员尚未到位——本任务包价值在真实回填后才兑现；若用户无法协调，M15 无法 COMPLETE（无任何替代路径）。
2. 样本 12+1 族全部 CJIG OA 来源 + 作者稿：**CEA 原生语料全文不可得**（登录墙，不绕过）——两刊比较采用"同稿两刊"设计（同文本 × CJIG/CEA 双视角），CEA in-venue 原生样本需用户提供（HUMAN_ACTION_REQUIRED 可选项）。
3. 脱敏不可完全去标识（题目可检索/自引）——已靠独立性声明+README 明示约束；若评审员违规检索无法技术阻止（如实登记）。
4. 10 族/刊为小样本探索性下限——协议已预写"n<8 不判、CI 全报、禁总体准确率宣称"；即使首轮全过，结论限定于"本样本集判别一致"，不得外推全刊。
5. 盲测若启动，系统输入=脱敏文本（与专家对齐）——生产 PDF/LaTeX 输入的额外能力差异登记为外部效度局限。
6. A0 臂 NOT_RUN_FULL（预算+口径），期刊级指标以 A1/A2/A3 为主——这是 M15.9 §1 裁决的延续（内部 Gate 不是期刊级判别器）。

## 10. Git/CI 收口

- 本轮提交：① 工具与模块（采集/解析/构建/校验脚本 + expertLabels.ts + 21 测试）+ 本报告 + PROJECT_STATUS 更新（见 `git log`）。
- 验证：backend typecheck/build ✓；新增测试 21/21、target+quality 409/409；全量 vitest **4429 passed / 0 failed / 43 skipped（exit 0，单轮无闪失）**；CI（GitHub CI + Linux Integration）以最终 HEAD 为准，链接回填 PROJECT_STATUS。
- 数据：全部产物（含双包、协议、MANIFEST 116 文件 SHA256）在 `D:\PaperTeamData\M15\M15_10\`；公开仓库只含脱敏报告与工具源码——**不含**任何 PDF/评审包/身份映射。
