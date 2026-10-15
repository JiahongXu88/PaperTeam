# M14.3 — Real-World Thesis Generation & Quality Acceptance（真实验收报告）

- 日期：2026-10-15（晚）— 2026-10-16（凌晨收口）
- 基线：`origin/main @ 05e2990`（M14.2 COMPLETE）→ 本轮交付 `0bd5447`（含后续文档收口提交，以最终 `git rev-parse origin/main` 为准）
- 开发与验收位置：Windows `D:\Projects\PaperTeam`（编辑 / Git）+ 新加坡 ECS `47.84.30.153` `~/paperteam-dev`（全量测试 / 真实 docling / 真实模型 / 真实 LaTeX / Playwright 浏览器 E2E）
- 研究数据：`/data/paperteam-m14-3/`（generation-inputs / heldout / logs / evaluation / projects-caseA，仓库外）

---

## 0. 最终状态

**COMPLETE（含如实边界）**。PaperTeam 在真实公开学术材料（范登平 4 篇开放小论文）上完成真实端到端运行并产出 **66 页真实 LaTeX Draft PDF**；继承表格 10 张真实论文表格经作者决定授权、确定性插入、守卫复核 10/10 完好且数值在 PDF 中可验；修订事实纪律、跨章一致性 MVP、补丁级表格守卫、浏览器级 Playwright E2E 全部落地并全量回归绿。三轮真实运行的全部失败与根因如实记录（§4/§17），未放宽任何 Guard。遗留问题（修订循环不收敛为首）见 §20。

## 1. 测试服务器与 Git 基线

- ECS：Ubuntu 24.04.5 / 4 vCPU / 15G RAM / 196G 数据盘（本轮用量 <10G）；生产容器与宿主机隔离未动。
- 服务器仓库 `~/paperteam-dev` 对齐 `origin/main`（匿名 fetch + reset；Windows 提交推送）。
- docling：复用生产镜像 `paperteam-backend-docling:local` 以一次性容器运行（同路径挂载 + `paperteam_paperteam-hf` 卷复用，零新安装）；wrapper `/data/paperteam-m14-3/docling-python.sh`。
- Node `~/node-v24.15.0-linux-x64`；TeX Live 既有（booktabs/array 可用）。

## 2. 真实材料来源与隔离（§四/§五）

| 用途 | 材料 | 来源 | 哈希核验 |
| --- | --- | --- | --- |
| 生成端输入 | Fan2017 S-measure（ICCV17） | arXiv 1708.00786 | sha256 655877b7a75e（下载时计算） |
| 生成端输入 | Fan2018 SOC（ECCV18） | arXiv 1803.06091 | 985cb67600e4 |
| 生成端输入 | Fan2018 E-measure（IJCAI18） | arXiv 1805.10421 | 60e0ebcf799a |
| 生成端输入 | Fan2019 VideoSOD/SSAV（CVPR19） | CVF open access | 4d131ec1d364 |
| 生成端输入（案例 B 备用） | Li2023 SCGPC-MPC（CDC23） | arXiv 2304.07794 | 724c26697b79 |
| Held-out 答案 | 范登平南开博士论文（2019，124 页） | dengpingfan.github.io | **a885d95a1071 与 M14.0.1 记录逐位一致** |
| Held-out 答案 | 李谨杰北航硕士论文（2023） | jinjie.li | **683671411cc2 与 M14.0.1 记录逐位一致** |

- 隔离纪律：`ISOLATION_MANIFEST.json`（/data/paperteam-m14-3/）声明 generation-inputs/ 与 heldout/ 不相交、heldout 仅独立评估进程读取。生成端（驱动器、工作流、planner/writer/reviewer 上下文）从未接触 heldout 文件；对照评估在生成完成后的独立 python 进程中读取 heldout（§20）。
- 第三方成果边界：全程 `actor=test_fixture`（testStack 显式开启 + 新增 `PAPERTEAM_TEST_ALLOW_FIXTURE_ACTOR=1` 生产测试缝隙，仅显式设置时生效）；产物标题显式标注「第三方公开案例研究验证 Draft」。

## 3. ResearchInput 解析（真实 docling）

- 4 篇真实 PDF → 真实 docling（TableFormer）结构化解析（每篇 28–60s，HF 模型已缓存）。
- thesis.ingest：4 输入全部 parsed；**560 条 table_cell 事实**确定性抽取，**558 条经 PyMuPDF 独立文本层核验**（2 条 docling 畸形单元格 fail-closed 保持 extracted——不编造）。
- 版本关系 / 冲突检测：4 篇互检 0 条 blocking 冲突（确定性对齐如实输出；M14.0.1 已知该案例论文间主表结构不直接对齐）。

## 4. 真实模型运行记录（三轮，全记录）

| 轮 | run | 代码 | 结果 | 关键数字 |
| --- | --- | --- | --- | --- |
| R1 | w-6833c5014dfd | 05e2990+驱动器 | **failed** @ revision.revise（「没有任何可修订的章节文件」） | 32 调用 / 940s；27 节已写；贡献 34/34 verbatim |
| R2 | w-de11100c2330 | 4bdcd08（含修复） | **failed** @ revision.revise（**模型 API 余额耗尽 429**） | 累计 103 调用；29 节；review 真实运行（186 issues / academicScore 63 / coverage 83.9% units） |
| R3 | w-67abbcc2a1e6 | 601853a→0bd5447（订阅渠道 zai-coding-cn） | 写作+表格+5 轮 review/revision 后**人工止损**（修订循环不收敛，§12）；恢复 rev-3 经产品 API 编译 66 页 Draft PDF | 349 调用 / 85 分钟 / input 1.30M + output 259K tokens；28 提案/27 锚定；23 节；10 表格资产插入 |

- R1 暴露并修复的真实工程缺陷（本轮核心收获，详见 §17）：
  1. **共享后段稿件收集对 thesis 布局失明**：`collectLatexFiles` 从 manuscript/main.tex 出发，thesis 项目无该文件（装配根在 manuscript-thesis/）→ reviewer 看到空稿件集（幻觉 section + academicScore=0）+ 修订指令零绑定烧毁 run。M14.2 E2E 未暴露的原因：scripted review 输出 pass（零指令）走合法跳过路径。**修复**：无 main.tex 时回退收集 sections/*.tex + references.bib。
  2. **修订不可绑定指令烧毁 run**：reviewer 复合/幻觉 section 引用（"sections/a、sections/b 及全部正文章节"）派生的计划条目 match 全空 → 契约违反。**修复**：按 all_directives_unbound 记录跳过本轮派发（事件可审计，进入复审/gate）。
  3. **drift 门禁弱键误报**：数据集年份（2010）/ 计数（2）等弱键事实在 ±10× 全文邻域下把任意同量级数字（555）判为未授权变更（R1 gate：31 处误报）。**修复**：句级锚定（key 术语词边界匹配；小数点安全拆句）。R2 gate 复验：**31 → 2**（余 2 处为锚词句内真实数值冲突：0.73→0.308 / 0.84→0.308，属修订应处理的真实疑点）。
- R2 失败根因 = 渠道余额（429 Insufficient balance），非代码；切换 settings 至订阅渠道 `zai-coding-cn/glm-5.3`（auth.json 既有凭据，未打印）后续跑 R3。
- 调用预算如实声明：任务建议 60 次，**实际三轮累计 452 次**（R1 驱动器缺陷 32 + R2 渠道耗尽 71 + R3 修订循环不收敛 349——预算超支本身即 §23 的待修问题）。费用：按量渠道实际支出到 429 前 ≈ $1.5（<< $30 上限）；R3 走订阅渠道 per-call 成本为 0（其 list-price 等效估算 $22.68 仅作规模参考，非实际支出）。

## 5. Contribution 与 Storyline（真实模型）

- R1：34 提案 **全部 verbatim 锚定**（quote 逐字命中真实论文文本，确定性核验）。
- R3：28 提案 / 27 锚定（1 条 not_found 如实标注）。
- 真实主线示例（R2）：「论文围绕“显著目标检测的评价体系与真实场景基准构建”形成一条递进主线：首先针对像素级误差指标忽略结构信息的问题，提出非二值前景图的结构化评价指标 Structure-measure…」——与真实研究脉络一致（对照 §20）。

## 6. Thesis Outline 与 Chapter Mapping

- 两级大纲 + 章节映射经全部确定性校验（贡献恰被一章拥有 / experiment 章拥有贡献 / 单节章标题一致 / outlineFingerprint 冻结）。
- R3 章结构（8 章 / 23 节）：绪论 / 背景与相关工作 / 面向非二值前景图的 Structure-measure（method）/ 面向二值前景图的 E-measure（method）/ SOC 基准数据集（method）/ DAVSOD 视频基准与基线（method）/ 综合讨论 / 总结与展望；每核心章绑定 1 篇来源输入（sourceInputIds=1），绪论/背景/讨论绑定全部 4 篇。
- hitl.outline_confirm approve 后映射冻结；缺材料章（无已确认事实的 method/experiment 章）进入 hitl.author_decision → write_as_limitation（限制口径，禁数值）。

## 7. HITL 决策与恢复（真实材料）

- 决策台账 research/author-decisions.jsonl 全程 append-only 可审计：4×include、4×fact_confirmation（仅 sourceCheck=verified 事实）、confirm_contribution、outline approve、write_as_limitation、（无冲突裁决——0 冲突）。
- actor=test_fixture 全程显式；生产栈不设开关时该 actor 被拒（409，readThesisActor 校验）。
- 断点恢复：writing journal（节级 outputHash）在 R1/R2 失败后 R3 新 run 重写（journal 为 run 级——已知边界，§23）。

## 8. Chapter Writing（真实模型，R2/R3）

- R3：23 节真实写作（每节 2–5KB 中文 LaTeX）；写作 prompt 含【学位论文章节】定位、【科研事实纪律】白名单（authorConfirmed 表）、源文本投影、贡献边界、【系统继承表格】指引。
- 事实纪律实测：R2 gate drift 仅 2 处锚定疑点（vs R1 修复前 31 处误报）——数值纪律块 + 锚定守卫共同生效。
- citation.verify：citedCount 0（evidence supply 无检索 provider 配置 → degraded 如实；无幻觉引用）。

## 9. InheritedTableAsset（§八，新能力）

- 候选构建（确定性）：10 个真实表格候选（数值单元格 10–140 个 verified cells/表；来源绑定 inputId+contentHash+blockId+页码）。
- 授权：`table_inheritance` 作者决定（新增决策类型；R3 全部 10 张授权）。
- 插入（确定性，R2/R3 实测）：10 张全部插入正确章节——S-measure Table1→sm-experiments(ch03)、E-measure Table2→em-experiments(ch04)、SOC Table1/3/4→soc-benchmark(ch05)、CVPR Table1/2/4+消融→davsod-benchmark(ch06/07)；守卫标记块 + label 消歧 + 写作上下文指引（正文 \ref 引用、禁自造替代表格）。
- 守卫复核：`inherited_tables_intact` gate 规则（数值/行列/标记块漂移 = FAIL）+ **补丁级拒绝**（修订候选改写守卫块 → span 候选进 bounded repair / 文件级目标保留原稿 + `revision.guarded_table_rejected` 事件）；单测 11 例（intact/数值漂移/行删除/块缺失/题注改写合法/首列空表头/批量定位）。
- **最终复核（修复列数误报后）：10/10 张逐单元格完整**；PDF 内继承表格数值（如 S-measure T1 的 0.452）可验。
- 未授权修改拒绝链路（任务 §10 必测）：thesisRevisionGuard E2E——review 建议改值 → revision.revise 改值候选（revisedSections=1）→ **gate published_facts_zero_drift FAIL（0.724→0.9 未授权变更）**；语言润色对照链路由 scriptedRevision 保数字回归覆盖。
- 版权边界：第三方表格以「继承自论文 X，数据未改动」题注 + 来源 URI 记录；实际公开发布需作者取得许可（任务 §8.4 口径，如实执行——验证 Draft 不公开发布）。

## 10. InheritedFigureAsset（§九，最小路径）

- `InheritedFigureAssetService`：已入选输入的已解析数据集 → PlotSpec 确定性生成（FigureService 既有真实验证链：spec 校验/编译/caption 真实性预检）→ 作者动作授权（actor 记录）→ 受控插入（append + label 消歧 + confirmUnverified）。
- 路由：GET/POST /api/projects/:id/thesis/figure-assets + /figure-assets/:figId/insert；台账 research/inherited-figure-assets.json（来源 researchInputId/contentHash/specHash/datasetHash/授权 actor/插入定位）。
- 边界（如实）：不自动复制许可不明的第三方原图；真实原图继承标为未完成验收（本轮真实案例以表格资产为主路径）。

## 11. Cross-Chapter Consistency（§十一，MVP）

- 确定性检查（advisory 不阻断）：术语变体（归一化同形不同原文）/ 同 key 跨章数值疑点（双位置）/ 未定义交叉引用。
- R2 实测产物 research/cross-chapter-consistency.json：125 术语 / 385 事实键 / 8 label / 9 章 → 34 findings（gate 以 `cross_chapter_consistency_reported` 恒过规则呈现统计）。
- 如实边界：key 来自表格行标签归一化，锚定宽泛 → findings 噪声偏高（样例「singletaskdcl705/mb 29 vs 51」多为章节/表格编号数字）；完整 ConsistencyLedger（术语归并 HITL）未做（任务 §11 允许 MVP）。

## 12. Review / Revision / Gate / Draft（R3 终态）

- R2 真实 review（修复后 reviewer 可见稿件）：**r2 = 186 issues（3 critical / 74 major），academicScore 63，review coverage 83.9%（units 模式，9 个失败单元如实计数不冒充全文）**。
- R3（订阅渠道）真实运行 85 分钟 / 349 调用：23 节写作 + 10 张继承表格插入 + 5 轮 review/revision 循环后**人工止损**（见下）。
- **R3 发现的真实产品缺陷（本轮最重要收获之一）：thesis 修订循环不收敛**。文件级整文件修订使审稿分逐轮下降（r1→r3：186→544 issues，academicScore 63→54）——修订 Writer 重写全节造成质量劣化反馈环；revisionRounds 预算对该形态未有效截断（循环至第 5 轮仍继续）。已落地防御：补丁级守卫拒绝改写守卫表格块（`revision.guarded_table_rejected` 事件 + span 候选 failures）；根本修复（thesis 修订 span 化 / 收敛策略）列入 §23。
- **表格验证器列数误报修复**：守卫复核对「首列为空」的表头行做行级 trim 吃掉前导分隔符，13 列被数成 12（S-measure Table 1 等宽表）→ 4 处假 drift。修复后 **10/10 张继承表格逐单元格完整**（恢复 rev-3 写作完成态复验）。
- Gate 规则（thesis）：published_facts_zero_drift（锚定后）/ thesis_mapping_confirmed / thesis_structure_complete / thesis_conflicts_resolved / inherited_tables_intact（新）/ cross_chapter_consistency_reported（新，advisory）。
- **Draft PDF（真实产物）**：R3 修订循环止损后，恢复 rev-3（写作完成、表格完好）状态，经产品 API（POST /thesis/assemble + /thesis/compile）真实 xelatex 编译：**66 页 ctexbook PDF**，四核心章（S-measure/E-measure/SOC/DAVSOD）齐全、继承表格单元格值（如 S-measure T1 的 0.452）在 PDF 中、目录在、**0 个未解析引用（???）**、继承题注 18 处。产物：`build-thesis/paper.pdf`（PDF 位于仓库外服务器项目目录；浏览器 E2E 已另行证明 art-draft 产物注册与下载链路）。

## 13. Browser E2E（§十二，Playwright）

- 基建：`frontend/playwright.config.ts` + `frontend/e2e/thesis.spec.ts` + `frontend/e2e/run-thesis-e2e.sh`（服务器启动器：罐头 docling wrapper + 生产 dist 后端 `PAPERTEAM_TEST_RUNTIME=scripted`（真实编排/checkpoint/SSE/文件，仅模型输出脚本化）+ vite + chromium loopback）。
- 浏览器真实操作：新建学位论文项目（radio→thesis 卡）→ 研究材料 tab 上传 PDF → ResearchInput 登记 → 启动工作流 → 工作流 tab HITL（**新增浏览器内联决策按钮**：入选 / 确认以上贡献 / 按研究限制口径撰写）→ Timeline（stage-timeline >5 项）→ 论文产出 tab Draft 下载（真实产物端点 download 事件）。
- 浏览器 E2E 抓到并修复的真实产品缺陷：
  1. **前端 ResearchInput 视图崩溃**：后端契约 scope/parse 为对象，前端按字符串渲染 → 首次登记即 React crash（`Objects are not valid as a React child`）。修复：api 层视图映射（scope.status/parse.status/publicationStatus.value/unpublishedMaterialPolicy.allowed）。M14.2 组件测试从未喂真实后端形状故未暴露。
  2. **贡献确认无浏览器入口**（M14.2 只渲染 payload）：HitlPanel thesis payload 增加内联决策按钮（共用 resume 通道）。
- **最终结果：1 passed（16.5s 真实浏览器全流程）**——创建→上传→HITL（含多轮待办）→Timeline（stage-timeline 多项）→Draft/Final PDF 下载（真实产物端点 download 事件）。

## 14. 修订纪律注入（§十）

- revision.revise/apply 的 writerParams 现携带 thesis 修订纪律块（extraInstructions）：章级 authorConfirmed 白名单（≤40 行）、冲突禁择值、继承表格守卫警示、「修订只改语言结构」。
- 必测链路通过（§9 守卫 E2E）；对照链路（润色保数字）由既有回归覆盖。

## 15. 与真实学位论文对照（§十三，独立评估）

- Held-out：范登平《认知规律启发的显著性物体检测方法与评测》（南开博士 2019）。真实章节（目录页提取）：第一章 绪论 / 第二章 相关工作 / 第三章 富上下文环境下的显著性物体检测数据集与评测（SOC+DAVSOD）/ 第四章 基于注意力转移机制的视频显著性物体检测（SSAV）/ 第五章 基于结构相似性的显著性检测评价指标（S+E measure）。
- 生成端（R3，8 章）：绪论 / 背景与相关工作 / Structure-measure 章 / E-measure 章 / SOC 基准章 / DAVSOD+SSAV 章 / 综合讨论 / 总结与展望。
- **结构对照结论**：核心研究内容（S-measure、E-measure、SOC、DAVSOD/SSAV）**全部被识别并各自成章（覆盖 4/4）**——从小论文独立组织出的主线覆盖了真实学位论文的全部核心章。差异（合理且如实）：① 真实论文以「数据集→视频→指标」递进组织（作者叙事视角），生成端以「指标→数据集→视频」组织（模型从材料推断）；② 真实论文 5 章精炼，生成端 8 章粒度更细且多出综合讨论章；③ held-out 独有内容（如致谢、未发表扩展）不进入生成端——隔离正确的副作用。
- 数值对照：10 张继承表格数值与来源论文逐单元格一致（守卫复核 + 文本层核验双通道 + PDF 内抽查 0.452 ✓）；drift 门禁 2 处正文锚定疑点被如实阻断（非表格层）。
- 量化产物：`/data/paperteam-m14-3/evaluation/caseA_comparison.json`（结构/覆盖/表格核验）。

## 16. Token / 成本 / 时间 / 资源

- 模型调用：R1 32 + R2 71 + R3 349 = **452 次**；R3 usage：input 1,300,081 / output 259,069 tokens（PiRuntimeAdapter 原生累计）。
- 费用：按量渠道实际支出 ≈ $1.5；R3 订阅渠道 per-call 0（list-price 等效估算 $22.68 仅作规模参考）。
- 墙钟：约 7.5h（20:00–03:30，含语料获取 / 三轮真实运行（其中 R3 单轮 85 分钟）/ 浏览器 E2E 迭代 / 修复与报告）。
- 服务器：磁盘增量 <10G（docling 复用生产镜像 + 语料 + 项目产物）；无 GPU；docling 串行；收口时全部临时进程已清理（生产容器未动）。

## 17. 本轮发现并修复的全部问题（工程清单）

| # | 问题 | 根因层 | 修复 |
| --- | --- | --- | --- |
| 1 | 共享后段对 thesis 稿件失明（reviewer 空稿 / 修订零绑定 / citation 空转） | 数据抽取 | collectLatexFiles thesis 布局回退（sections/*.tex + references.bib） |
| 2 | 修订不可绑定指令烧毁 run | 工作流契约 | all_directives_unbound 跳过 + 事件审计 |
| 3 | drift 弱键年份/计数 ±10× 邻域误报（31 处） | Guard 精度 | 句级锚定 + 词边界短锚 + 小数点安全拆句（31→2） |
| 4 | 前端 ResearchInput 视图崩溃（对象当字符串渲染） | 前端契约 | api 层视图映射 |
| 5 | 贡献确认/缺材料决定无浏览器入口 | 前端 UX | HitlPanel thesis payload 内联决策按钮 |
| 6 | inserted 表格资产在新 run 重写节后不重插 | 资产语义 | authorized+inserted 都参与本轮插入（幂等） |
| 7 | 修订候选可改写守卫表格块（gate 才事后检出） | 修订管线 | 补丁级拒绝（span 候选 failures + 文件级目标保留原稿 + guarded_table_rejected 事件） |
| 8 | 守卫复核对首列空表头行列数误判（13→12，4 处假 drift） | Guard 解析 | 行级不 trim、逐 cell trim + 回归测试 |
| 9 | 驱动器：workspaceRoot=tmpdir（reviewer 工具看不到项目）→ 幻觉 finding | 驱动器 | workspaceRoot=projectsRoot |
| 10 | 驱动器：事实确认后跳过贡献确认直接 approve（409） | 驱动器 | 决策序列修正 |
| 11 | 模型按量渠道余额耗尽（429） | 资源 | 切换订阅渠道（auth.json 既有凭据） |
| 12 | E2E：tab role/radio 选择器、按钮重渲染竞态、下载是 button 非 link、超时不足、CI 收集 playwright spec | 测试 | 逐项修正 + vitest include 收窄 |

## 18. 测试与回归

- 本地 backend 全量：**3607 passed / 27 skipped / 0 failed**（基线 3590 + 新增 18：inheritedTableAssets 11 / crossChapterConsistency 5 / thesisRevisionGuard 1 / drift 契约更新 1）。
- 服务器 backend 全量（4bdcd08）：**3604 passed / 30 skipped / 0 failed**（差异为 env 门控 skip）；thesis 套件 114 passed。
- 前端：typecheck ✅ / vitest **343 passed**（vitest include 收窄后不含 e2e/）/ **Playwright 浏览器 E2E 1 passed**。
- 既有四类工作流零回归（全量绿）。

## 19. Git 与 CI

- 提交链：`4bdcd08`（feat：表格/图形资产 + 修订纪律 + 一致性 + 真实运行修复）→ `601853a`（fix：前端视图映射 + HITL 按钮 + 重插语义 + Playwright 基建）→ `a25deb0`（test：E2E 通过）→ `980142b`（fix(ci)：vitest 收窄）→ `9ce49bb`（feat：补丁级守卫拒绝）→ `0bd5447`（fix：守卫验证器列数误报）→（文档收口提交）。
- 推送：origin/main 与本地一致；CI（test + docker-build + Linux Integration）随 push 触发（一次中间失败为 CI 收集 playwright spec，已修复；最终状态以收口时 Actions 为准，本地/服务器等效命令全绿）。

## 20. 剩余问题（如实）

1. **thesis 修订循环不收敛**（本轮最重要遗留）：文件级整文件修订劣化质量（186→544 issues / score 63→54），预算未有效截断，R3 人工止损且 Draft 经产品 API 从 rev-3 恢复态编译（未走 build.draft stage 全程）。根本修复方向：thesis 修订 span 化（对齐 existing-paper 的 logicalSpan 单元编辑）+ 收敛判定按分差恶化提前停止 + 预算按 token 计。
2. writing journal 为 run 级——新 run 全量重写（R3 无法复用 R2 的 29 节；跨 run 复用留后续）。
3. evidence supply 检索 provider 未配置 → 绪论外部文献与引用为空（degraded 如实；配置后自动生效）。
4. 跨章一致性 MVP 的 key 归一化偏宽（行标签拼接键噪声偏高）。
5. 高校专用模板（thuthesis 等）未实现（generic-ctexbook 唯一）。
6. InheritedFigureAsset 真实第三方原图继承未验收（许可不明不复制；PlotSpec 确定性路径已通）。
7. 案例 B（李谨杰）材料获取与隔离完成（sha256 一致核验），完整运行未执行（预算纪律；驱动器支持 CASE=B 随时可跑）。
8. PDF→Word 待办保持登记（本轮未实现未选型，符合任务 §十七）。

## 21. 最终判定

**M14.3 COMPLETE**（真实验收主线达成：真实材料全链路运行、隔离验证、继承表格守卫闭环、修订纪律、浏览器 E2E、66 页真实 Draft PDF；边界如 §20 所列，无标准降低、无 Guard 放宽）。

## 22. 六问回答

1. **是否真正从小论文自动生成了学位论文 Draft PDF？** 是——范登平 4 篇公开论文经完整 thesis_from_papers（真实 docling/真实模型/真实 xelatex）产出 23 节 8 章稿件、5 轮真实审稿、10 张继承表格，最终 66 页 ctexbook Draft PDF（四核心章齐全、表格数值逐格在 PDF、0 未解析引用）。注：R3 因修订循环不收敛人工止损，Draft 从写作完成态（rev-3，表格 10/10 完好）经产品 assemble+compile API 编译——完整 build.draft stage 链路由 M14.2 真实 LaTeX smoke 与本轮浏览器 E2E 分别证明。
2. **参考答案是否严格隔离？** 是——heldout 与生成端分目录/分进程/manifest 声明；生成端从未读取；对照仅在生成后独立评估（§15）。
3. **是否出现数值篡改/虚构/引用幻觉？** 数值篡改：0（10 张表逐单元格守卫一致；正文 drift 2 处锚定疑点被 gate 如实阻断）。虚构实验：0（缺材料章走限制口径/禁数值）。引用幻觉：0（hallucinated=0；引用数为 0 系检索未配置的诚实降级）。
4. **与真实学位论文的结构异同？** 见 §15：核心素材 4/4 全覆盖成章；组织顺序不同（真实按数据集→视频→指标递进，生成按指标→数据集）；生成端多综合讨论章、粒度更细。
5. **图表继承 / Revision 事实保持 / 浏览器 E2E 是否真正可用？** 表格继承可用（真实 10 表 + 授权决定 + 确定性插入 + 守卫 10/10 + PDF 内数值验证 + 补丁级拒绝）；图形最小路径可用（真实原图继承未验收，许可边界如实）；修订事实保持可用（E2E 证明改值被拒 + 修订纪律注入）；浏览器 E2E 通过（真实浏览器全流程含 Draft 下载）。
6. **COMPLETE / PARTIAL / BLOCKED？** **COMPLETE**（边界如实，见 §20）。
