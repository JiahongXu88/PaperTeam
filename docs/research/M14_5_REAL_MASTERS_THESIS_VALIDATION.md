# M14.5 — Real Master's Thesis Generalization & Convergence Validation（真实硕士学位论文泛化与收敛验收）

- 日期：2026-10-16（北京时间 16:55–19:30，连续一轮）
- 基线：`origin/main @ e4456e02fd90dce2a6124b5b3364ac37b811bd6e`（M14.4 COMPLETE；执行前复核 HEAD = origin/main，工作区 clean）
- 执行位置：Windows 11 本机 `D:\Projects\PaperTeam`（全部开发 / 模型调用 / 测试 / PDF 编译在本机；未连接新加坡服务器，未使用 AutoDL / 远程 GPU / Docker）
- 研究数据（不入库）：`D:\PaperTeamData\M14_5\`（generation-inputs / heldout / projects-caseB / logs / evaluation / scratch / 全局预算账本）
- 状态：**M14.5 COMPLETE（含如实边界，见 §19）**；真实 Workflow 终态：**Draft generated（QUALITY_NOT_REACHED，modelBudgetExhausted=true）**——两个层级分开报告（§15.3）

---

## 0. 一页结论

| 任务问题 | 答案 |
| --- | --- |
| 单篇小论文 → 硕士学位论文场景能否处理 | 能——真实 CDC 2023 小论文（7 页）经完整 `thesis_from_papers` 在本机产出 6 章 16 节 42 页 Draft PDF；但系统只规划了小论文能支撑的内容（真实学位论文 123 页 / 6 章中约 37% 的无论文材料没有被「补写」——这是正确行为） |
| 能否识别已有 / 缺失材料 | 已有：11 条来源核验事实（10 表格 + 1 正文结果）全部可追溯；缺失：Planner 以 `scopeConcerns` 明确声明「单一成果扩展、体量偏薄」；**但系统没有机制列出「硕士论文还需要哪些实验」**——缺口只能从「没有规划这些章」间接看出（§8 / §19） |
| 章节规划是否合理 | 合理：绪论 / 相关理论 / 数据采集与预测器 / NDP-NMPC 控制器 / 实时实验 / 总结，递进主线与小论文研究脉络一致；与真实学位论文核心章 3–5 章一一对应（§15） |
| 无实验数据时是否正确暂停 | 本案例小论文**本身含实验结果**，缺材料章检测（含本轮新增的「数值结果无事实支撑」规则）未触发是正确判断；缺材料暂停路径由确定性 E2E 与本轮新单测覆盖，真实模型下通过「任意 HITL 节点暂停 → 进程退出 → 重新附着 → Resume」验证（§9） |
| M14.4 bounded logicalSpan 是否生效 | 生效：run1 候选超出引文范围 + 改公式 → 拒绝、原稿逐字节保留；run2 四个单元候选接受，变更窗口 35–149 字符、文件其余部分逐字节不变（§11） |
| 修订劣化 / 无限消耗是否避免 | run1 暴露新问题：零接受修订仍提交新修订号并再审一整轮（reviewer 噪声 → 伪 REGRESSION，白烧 3 次）——本轮修复为「零接受 = 无进展，直接 stalled」；run2 由 run 级预算在第二轮 review 前优雅停止（§11–§13） |
| 预算内合法终止 | 是：跨实验总预算 50 次调用由测试编排器账本硬性执行，最终 **50/50 恰好用满、0 次被拒**；run 级 27/27 触发 planner 优雅降级（overflow HITL → Draft）（§13） |
| 科研事实正确的 Draft PDF | 42 页 Draft：正文全部数值均可追溯到小论文（独立扫描「不在小论文也不在事实集」的数值 = 0），两张继承表格逐格完好；Quality Gate 如实 FAIL（§14） |

## 1. 基线 Git 与环境

- `git status --short --branch` → `## main...origin/main`（clean）；`git rev-parse HEAD` = `origin/main` = `e4456e02`；CI 双绿（run 38875459097 / 38875459012，M14.4 收口提交）。
- 本机：Node v22.22.3；Python 3.11.9 + docling 2.130.0（HF 模型已缓存：layout-heron / docling-models）+ PyMuPDF 1.28.0；MiKTeX xelatex / latexmk（ctexbook 探针编译 1.1s 通过）；无 Docker（WSL Ubuntu 停止状态，未启动）。
- 模型通道：Z.AI Coding Plan 订阅渠道 `zai-coding-cn/glm-5.3`（Pi 内置 provider；凭据在 `~/.paperteam/runtime/pi/agent/auth.json`，未打印、未入库）。per-call 估算费用为 provider list-price（订阅渠道实际按量支出 0）。
- 长程运行保护：`keep-awake.ps1 300`（Modern Standby 曾冻结过往 A/B）。

## 2. 案例 B 的实际材料与版本

| 用途 | 文件 | sha256 | 来源 |
| --- | --- | --- | --- |
| **Generation Input（唯一）** | `generation-inputs/Li2023_NDP_NMPC_CDC_arXiv2304.07794v2.pdf`（7 页） | `724c26697b79…aebba`（与 M14.0.1 记录逐位一致） | arXiv 2304.07794v2；Crossref DOI 10.1109/CDC49753.2023.10383632（IEEE CDC 2023）；学位论文答辩时为 "Submitted" |
| Held-out | `heldout/zh_li_jinjie_buaa_master2023.pdf`（123 页） | `683671411cc2…095e`（逐位一致） | 作者主页自存档 |
| Held-out 派生 | `heldout/case_li_jinjie_buaa_master2023.{json,md}` | — | M14.0.1 Evidence Matrix（Oracle） |

- 书目元数据纠错：M14.3 驱动器中案例 B 规格曾写成另一篇论文的标题与作者（"Sequential convex generation … self-triggered mini-max MPC"，Li/Han/Ren）；本轮以 arXiv 首页与 Crossref 为准改为 "Nonlinear MPC for Quadrotors in Close-Proximity Flight with Neural Network Downwash Prediction"（Li, Han, Yu, Lin, Li, Ren）。M14.3 未实际运行案例 B，故未暴露。
- 未纳入生成端：ICRA 2022 室内定位论文（学位论文成果列表有、正文无对应——范围排除属作者决定）、ICRA 2023 第四作者论文、workshop 论文（无全文）。
- 真实用户边界：第三方公开成果，全部作者决定以 `actor=test_fixture` 显式标记（testStack `allowTestFixtureActor`）；产物标题标注「第三方公开案例研究验证 Draft」。

## 3. Held-out 隔离证据

`D:\PaperTeamData\M14_5\ISOLATION_MANIFEST.json` 声明并逐项检查：

| 检查面 | 结论 |
| --- | --- |
| 工作流输入目录 | 驱动器只读 `generation-inputs/`（1 个文件）；`projects-caseB/` 新建空根 |
| ResearchInputRegistry | 每个项目只登记 1 个输入（`ri-be699de35f19`，contentHash = 小论文 sha256） |
| Retrieval Index / Evidence | testStack 缺省关闭全部学术 provider 与全文下载（`thesis.evidence_supply` 如实 degraded：queries 0 / candidates 0 / formalEvidence 0）——没有任何网络路径能到达 li-jinjie.github.io |
| Model Context | Planner / Writer / Reviewer prompt 只含 ResearchInput 文本投影、事实表、贡献、大纲；M14.0.1 报告从未进入任何 prompt |
| 文件工具 | Pi 角色白名单 read/grep/find/ls（Writer +write/edit），workspaceGuard 限定 `<projectsRoot>/<projectId>`；无 web/fetch/bash 工具 |
| 项目级缓存 | runtimeRoot `~/.paperteam` 只有凭据与 provider 设置；无跨项目缓存 |
| 评估程序 | `scratch/heldout_eval.py` 是唯一读取 heldout/ 的进程，在生成端全部停止后运行 |

未发现泄露；两次生成验收均有效。

## 4. 真实论文解析与事实结果（Phase B，零模型调用）

`test/thesis/m145CaseBFactBaseline.e2e.test.ts`（env 门控 `PAPERTEAM_M145_FACTS=1`；runtime 任何调用即抛错）在真实 docling + PyMuPDF 上：

| 项 | 结果 |
| --- | --- |
| 解析 | docling 2.130.0（TableFormer）69s；152 blocks / 3 tables / 7 页；parse=full_text |
| 版本 / 来源 | arXiv 2304.07794v2，publicationStatus=published（asOf 2023-12）；单输入无版本关系；0 冲突 |
| 表格事实（修复前） | 10 条 table_cell，全部文本层核验 verified——但 **Table II 两条标签错误**（`Adam | Layers = 20,000`、`Adam | Initialization = 1e-4`），**Table III 六条行标签错误**（`N | Value = 0.1s`、`Qp,xy | Value = 400` 等） |
| 表格事实（修复后） | `Adam | Epoch = 20,000`、`Adam | Learning Rate = 1e-4`、`dtpred = 0.1s`、`Qp,z = 400`、`Qv,xyz = 1`、`Rω,xyz = 10`、`Rfc = 10` 全部正确；11/11 verified |
| 正文事实（修复前 → 后） | 0 → 1：`75.37%`（numeric_result / metric=error，摘要 "a 75.37% reduction in tracking error in height"，blockId + page 溯源，文本层核验 verified） |
| 继承表格候选 | 入选后 2 张（Table II / III；Table I 被 TableFormer 合并为单行多值单元格，不可逐格抽取） |
| 图内数值 | Fig. 6 的 L=1.589 / 1.022 / 0.518 仅在文本层出现于图内，不成为事实（设计口径：figure_embedded 不参与比较） |

**M14.0.1 关注点复核**：
- 小论文**不包含**学位论文 2.4 节参数辨识的原始测量过程（只有 Table I 结果）、4.1–4.2 轨迹生成 / 微分平坦、4.3.4 悬停油门观测器、4.4–4.5 仿真与单机实飞、5.2–5.4 分布式编队、第六章平台——这些材料**确实无法从小论文获得**（§15 定量确认）。
- 版本差异：学位论文表 9 谱归一化损失（1.6288 / 1.0523 / 0.6645 / 0.6250 / 0.6185）与小论文 Fig. 6（1.589 / 1.022 / 0.518）不同——生成端两次 run 均**未写入任一方数值**（Fig. 6 数值为图内文本不成为事实；表 9 在 held-out 中）。
- 事实状态分区：`source_verified` 11（全部）；`author_confirmed` 11（test_fixture 确认，有显式标记）；`unresolved_conflict` 0；`unverified_candidate` 0；`missing_material`（章级）0——原因见 §8。

## 5. Contribution 提取（真实模型）

- run1：7 提案 / 7 逐字锚定（method ×4、experiment_result ×2、dataset ×1）；linkedFactIds 全空（修复前 75.37% 不是事实）。
- run2：8 提案 / 8 逐字锚定（method ×3、experiment_result ×2、dataset、limitation、conclusion）；`c-158cec2ab2`「高度跟踪误差降低 75.37%」确定性链接到正文事实 `Fe3a22903bd650e6b`。
- 真实第三方成果经 `confirm_contribution`（test_fixture）确认后才进入 Planner；未确认贡献不会出现在规划上下文。

## 6. Storyline 与 Outline（真实模型）

run2 主线（节选）：「围绕四旋翼近距垂直飞行中的下洗扰动补偿问题，按“问题动机—数据采集与神经网络预测器构建—预测器与 NMPC 集成—实时机载实验验证—开源与总结”的递进主线组织……」（structure=progressive；relations 6 条；contributionsOrder 覆盖全部 8 条）。

**scopeConcerns（模型自述，未经任何提示诱导）**：「论文由单一已发表成果扩展而来，核心贡献集中于一个方法与其实验验证，作为硕士学位论文体量偏薄，建议在背景章节扩充……并在方法与实验章节适度增加分析深度以满足学位论文篇幅要求。」——这是系统对「单篇小论文不足以支撑完整硕士论文」的直接判断。

两级大纲：6 章 16 节（run1：6 章 13 节，repair 1 次）；全部通过确定性校验（贡献恰被一章拥有 / experiment 章拥有贡献 / 文件名唯一 / 单节章标题一致）。

## 7. Chapter Mapping（run2，hitl.outline_confirm approve 后冻结）

| 章 | responsibility | owns | factIds | 节 |
| --- | --- | --- | --- | --- |
| ch01 绪论 | introduction | — | 0 | intro-background / intro-problem / intro-organization |
| ch02 相关理论与研究现状 | literature_review | c-e6c1ffb3c3（limitation） | 0 | lit-quadrotor-model / lit-nmpc / lit-downwash |
| ch03 下洗数据采集与神经网络预测器设计 | method | c-7c8e046833 / c-2ccd5cd9b0 / c-8565e023f6 | 8 | method-data-collection / method-mlp-predictor / method-prediction-validation |
| ch04 NDP-NMPC 轨迹跟踪控制器设计 | method | c-7ee050eab9 | 4 | method-nmpc-formulation / method-ndp-integration |
| ch05 实时轨迹跟踪实验与结果分析 | experiment | c-158cec2ab2 / c-c69fb29e82 | 6 | exp-setup / exp-tracking-results / exp-discussion |
| ch06 总结与展望 | conclusion | c-3e54570506 | 1 | concl-summary / concl-future |

每章 sourceInputIds 均为唯一输入；mappingStatus proposed → confirmed；outlineFingerprint 冻结。

## 8. 已有研究与缺失研究的区分

- **已有（小论文支撑）**：下洗数据采集 + MLP 预测器 + 谱归一化（ch03）、NDP-NMPC 与安全约束（ch04）、预测实验与双机实时跟踪实验（ch05，75.37%）、开源（ch06）。
- **缺失（真实学位论文独有，小论文无法支撑）**：参数辨识实验过程、Minimum Snap / 微分平坦、悬停油门卡尔曼观测器、分布式编队 NMPC 与多机仿真、六自由度仿真平台 / GPU、ROS 实物系统章。
- 系统行为：**没有为这些内容规划任何章节、没有写入任何相关实验结果**（§15.1 定量：8 个主题中「以完成时态声称做过」= 0）。Writer 对小论文未提供的量化评测明确写「本节以定性方式给出验证结论，量化误差统计可结合开源代码与数据集复现核验」等限制口径。
- **如实缺口**：`missingMaterialChapters` 只对「已规划但无事实」的章报警；对「硕士论文应有但未规划」的材料，产品层没有「材料缺口清单」（任务 §六要求的六要素清单）——本轮未新建该能力（不扩展大规模基础架构），列入 §20 建议 1。Planner 的 scopeConcerns 是目前唯一的显式信号。
- 本轮新增的缺材料规则（§17 F2）：experiment 章拥有**含具体数值**的 experiment_result 贡献、而该数值不对应任何可用事实 → 缺材料 → 作者决定。对 run1 的状态（75.37% 尚不是事实）会触发暂停；run2 中 75.37% 已成为核验 + 确认事实，规则正确地不触发。

## 9. HITL 决策与 Resume（真实模型、真实 checkpoint）

| HITL | run1 | run2 |
| --- | --- | --- |
| hitl.scope_and_version | include（1 输入）→ 事实确认 10 条 → 表格授权 2/2 → confirm_contribution 7 | include → 事实确认 11 → 表格授权 2/2 → confirm_contribution 8 |
| hitl.fact_conflicts | 未出现（0 冲突） | 未出现 |
| hitl.outline_confirm | approve | **合法暂停**（PAUSE_AT）：进程退出，`checkpoint.json` status=awaiting_input / awaiting=hitl.outline_confirm；**重新附着**（新进程，PROJECT_ID/RUN_ID）→ approve → 工作流继续（thesis.evidence_supply → writing …） |
| hitl.author_decision | 未出现（missingChapters=[]，§8） | 未出现 |
| hitl.revision_stalled | accept_draft（REGRESSION） | — |
| hitl.revision_overflow | — | accept_draft（run 级预算耗尽） |
| 重复 Resume 幂等探针 | — | 两处 HITL 回答后立即重复提交 → **HTTP 409 WORKFLOW_INVALID_STATE**（「无法对状态为 running 的 WorkflowRun 执行 resume」），不产生第二次决定 |

- 生产栈拒绝 test_fixture actor（M14.2 `readThesisActor` 409；本轮未改）；未确认材料不会自动 authorConfirmed（Phase B 基线：authorConfirmed=0 直至显式决定）。
- Resume 后沿用的版本与事实集合：run2 part2 的写作 prompt 事实表 = 11 条（与 part1 确认集合一致），contentHash 不变。

## 10. 真实 Workflow 运行过程

| | run1（基线，未调优） | run2（修复后定向复验） |
| --- | --- | --- |
| 代码 | e4456e02 + 驱动器预算/暂停补丁 | 本轮全部修复（§17） |
| 模型调用 | 23（贡献 1 / 大纲 2 / 写作 13 / review 3 / 修订 1 / **第二轮 review 3**） | 27 = part1 3（贡献 1 / 大纲 2）+ part2 24（evidence 0 / 写作 16 + 装配 3 / review 3 / 修订 1） |
| 墙钟 | 701s（docling 60s；写作 6.5 min；review+修订+review 2 min） | 161s + 361s |
| 节 / 字节 | 13 节 59,509 B | 16 节 60,709 B；2 张继承表格插入 |
| review r1 | 24 issues（3 critical / 11 major / 3 blocking），academicScore 71，styleRisk 45，coverage digest 56/56 单元 100% | 21 issues（3 critical / 10 major / 4 blocking），academicScore 76，styleRisk 35，coverage 65/65 100% |
| 修订 | 14 planned：1 锚定命中 → 候选**被拒**（REVISION_TARGET_QUOTE_SCOPE_VIOLATION + 改写公式 `q_{p,xy}=400`/`q_{q,xyz}=0.1`）；13 无锚点 unresolved → revisedSections 0 | 13 planned：3 命中（1 多目标）→ **4 单元候选全部接受**（scope/fact/citation/evidence 守卫全过）；10 无锚点 unresolved |
| 第二轮 review | 跑了（相同正文）→ 26 issues / 70 分 → judgeOutcome **REGRESSION** → stalled → accept_draft | **未启动**（run 级预算 27/27 → budgetExhausted → overflow HITL → accept_draft） |
| 终态 | completed / Draft `art-draft-rev2` 40 页 / QUALITY_NOT_REACHED | completed / Draft `art-draft-rev2` 42 页 / QUALITY_NOT_REACHED / modelBudgetExhausted=true |

驱动器断言缺陷（§17 F6）：run1 的 vitest 断言 `draftArtifact` 失败——产物清单字段是 `artifactId`，旧驱动读 `id`；产物实际已注册（manifest + PDF 492 KB）。

## 11. Revision Convergence 验收（M14.4 机制在真实模型下）

### 11.1 bounded logicalSpan
- Finding → targetQuote：run2 reviewer 的 3 条带逐字引文的 finding 命中 4 个段落单元（`section:预测器安全性与有效性验证#u2`、`subsection:结果小结#u2`、`subsection:有效性评价#u3`、`subsection:实验验证结论#u2`）；10 条无引文 finding 全部 unresolved（事件 `revision.dispatch_unresolved`，不猜位置）。
- 真实修改范围（rev-1 → rev-2，公共前后缀逐字节比对）：

| 文件 | 文件长度 | 授权单元 | 变更窗口 | 变动 |
| --- | --- | --- | --- | --- |
| method-prediction-validation.tex | 2,410 → 2,420 字符 | #u2 | [187, 222) 35 → 45 字符 | 删除「依据本章的科研事实纪律」工作流措辞 |
| exp-tracking-results.tex | 1,313 → 1,344 | #u2 | [1182, 1274) 92 → 123 | 「降低 75.37%」→「显著降低」+ 限制说明 |
| exp-discussion.tex | 1,175 → 1,205 | #u3 | [342, 376) 34 → 64 | 同上 |
| concl-summary.tex | 1,274 → 1,296 | #u2 | [891, 1040) 149 → 171 | 同上 |

全部章节 < 9,000 字符（M14.3 R3 形态）；范围外逐字节保持；其余 12 个文件未动；patch lineage 4 条 accepted。
- run1 反例：唯一命中单元的候选越出引文区间且改写两处公式 → `candidate_validation` 拒绝（rootViolationIds scope_violation + unauthorized_formula_change）→ 原稿逐字节保留（rev-1/rev-2 全部 13 个 section 文件 `filecmp` 相同）。

### 11.2 Revision Quality（可比性）
- run1 r1→r2 的正文**完全相同**（0 接受）：26 vs 24 issues、70 vs 71 分、major 13 vs 11——这是 reviewer 噪声，不是修订劣化；judgeOutcome 按确定性计数判 REGRESSION 并停止（停止正确，但第二轮 review 本不该启动）。
- run2 只有一轮 review（预算），**无跨轮比较**——不做任何「修订提升质量」的宣称；修订效果只能从确定性守卫（4 候选全过）与内容（弱化未被 reviewer 认可的数值、删工作流措辞）描述。
- Fact Violations 0 / Citation Violations 0 / 继承表格 2/2 完好（两次 run）。

### 11.3 Early Stop
| 条件 | 真实触发 |
| --- | --- |
| 连续无进展 / Guard 持续拒绝 | run1：候选被拒 → 0 接受（旧行为再审一轮；本轮修复后直接 stalled——场景 I 确定性回放） |
| Blocking 增加 / 重问题上升 | run1 r2：major 11→13 → REGRESSION → stalled |
| 轮次上限 | 未到（maxRevisionRounds=2） |
| 模型调用预算 | run2：run 级 27/27 → 第二轮 review 未启动 → overflow HITL |
| Token 预算 | 未到（run2 146K < 1.5M） |

### 11.4 Best Valid Revision
- 两次 run 的 `reviews/best-revision.json` 均以 rev-1（gateRound 1）为最佳基线；run1 rev-2 与 rev-1 分数带内（71 vs 70）且守卫同干净 → INCONCLUSIVE 保守保留（不恢复；正文本来相同）；run2 无第二轮 gate → 无比较。
- 终局 Draft 由 build.draft 自动完成（无人工恢复 rev）；`restoredBestFrom` 未触发（无可证明劣化）。诊断全部保留（patch-validation / iteration-history / stalled payload）。

## 12. Guard 与 Best Valid Revision（候选级实录）

| 守卫 | run1 | run2 |
| --- | --- | --- |
| quote 区间授权 | 1 拒 | 4 过 |
| unauthorized_formula_change | 1 拒（`q_{p,xy}=400`、`q_{q,xyz}=0.1` 被删改） | 0 |
| citation / evidence | 过 | 过 |
| 内容塌缩 | 未触发 | 未触发 |
| 继承表格守卫块 | 完好 | 完好（inherited_tables_intact） |
| published_facts_zero_drift | PASS | PASS |

备注：run1 被拒候选所改的 `q_{p,xy}=400` 正是**错误事实标签**（Table III 成对键值列缺陷）流入正文的实例——reviewer 正确地发现正文（400）与表格（Qp,xy=300）矛盾；根因在事实抽取（§17 F3），已修复并在 run2 消失（正文写 Qp,z=400）。

## 13. Budget Ledger 实际效果

- 两层预算（任务 §8.2）：
  1. run 级 `RunBudgetLedgerRuntime`（M14.4，`research/model-ledger.json`）：run1 23/44；run2 **27/27**（part1 3 + part2 24，重新附着后账本续接不重置）→ `budgetExhausted` → planner 不再派发 review.run → overflow HITL → Draft；completion summary `modelBudgetExhausted: true`。
  2. 跨实验总账本（本轮新增，测试编排器层 `test/helpers/globalBudgetLedger.ts`，文件 `m145-global-budget.json`）：上限 50 调用 / 1.8M token；**最终 50/50 调用、0 次拦截（stops=[]）**；两个实验（caseB-run1 23、caseB-run2 27）共享同一账本；上限只能收紧；重启不重置；失败重试不获新额度（单测 2 例）。
- 预检结论（启动真实模型前）：账本持久化 ✅；重启不重置 ✅（run2 part2 从 3 续到 27）；失败重试不重复获额 ✅（单测）；不同 run 共享总额 ✅；子 Agent 同受约束（Proxy 同时拦截 runAgent / startAgent）✅；在途调用预留（启动前计数）✅；env 经驱动器真正传入 testStack `runBudget` ✅。
- 预算耗尽后系统没有再启动任何模型调用；账本为 50/50 后本轮未再做任何真实模型实验（§19 限制 1）。

## 14. Draft PDF（run2 `art-draft-rev2`）

- 42 页 ctexbook（generic-ctexbook；xelatex 5.2s；0 未解析引用 `??`）；目录 ✓；六章章标题与节结构齐全；继承表格 `表3.1 TABLE II…（继承自 …）`、`表3.2 TABLE III…` 在 PDF 中；缺材料声明：「定性」9 处、「限制」9 处、「缺少」3 处。
- 如实缺项：无摘要（outline.abstract 为空——Planner 未生成，模板不伪造）；无参考文献（evidence supply degraded → bibliography 0；`citation.verify` citedCount 0 / hallucinated 0）；绪论「论文组织」把实验写成「第四章」而实际为第五章（reviewer 已指出，属 Writer 跨节编号一致性缺陷，未修）。
- 三态分明：Draft PDF 已生成 ≠ Workflow completed 的 qualityStatus（QUALITY_NOT_REACHED）≠ Publication Ready（否）。

## 15. Held-out 评估（生成停止后，独立进程 `heldout_eval.py`）

### 15.1 章节结构
| Held-out（李谨杰 123 页） | 生成端 run2（42 页） | 对应 |
| --- | --- | --- |
| 第一章 绪论（1.2 三类综述） | ch01 绪论 + ch02 相关理论与研究现状 | ✓（综述三主题：四旋翼建模 / NMPC / 下洗，与 1.2.1–1.2.3 一致） |
| 第二章 动力学建模及参数辨识 | ch02 lit-quadrotor-model（仅理论） | 部分：建模有、**参数辨识实验无**（正确缺失） |
| 第三章 下洗气流扰动估计 | ch03 数据采集与预测器 | ✓ |
| 第四章 非线性 MPC 轨迹跟踪 | ch04 NDP-NMPC 控制器 | 部分：NMPC/热启动有；Minimum Snap / 微分平坦 / 悬停观测器 / 仿真无（正确缺失） |
| 第五章 多机密集编队 | ch05 实时跟踪实验（双机） | 部分：双机实验有；分布式编队算法与多机仿真无（正确缺失） |
| 第六章 仿真环境与实物系统 | — | 无（正确缺失） |
| 结论 | ch06 总结与展望 | ✓ |

真实学位论文独有主题 8 项（参数辨识实验 / Minimum Snap / 微分平坦 / 悬停油门观测器 / 分布式编队 NMPC / 六自由度平台 / ROS 实物章 / 多机仿真）：生成端**以完成时态声称做过 = 0/8**；仅在综述或展望中以术语提及（如「参数辨识」「微分平坦」「六自由度」）。

### 15.2 科研事实
| 事实 | 小论文 | 学位论文 | 生成端 | 项目事实 |
| --- | --- | --- | --- | --- |
| 四旋翼参数 0.0094 / 0.0134 / 0.0145 / 1.5344 / 3.7611 / 0.1372 / 2.8158 | ✓ | ✓ | ✗ | ✗（Table I 单元格合并，未抽取） |
| 75.37% | ✓ | ✓ | ✓ | ✓ |
| 20,000 / 1e-4 / 300 / 400 / 6-128-64-128-3 | ✓ | 部分 | ✓ | ✓（结构串除外） |
| Fig. 6 损失 1.589 / 1.022 / 0.518 | ✓（图内） | ✗ | ✗ | ✗ |
| 表 9 损失 1.6288 / 1.0523 / 0.6645 / 0.6250 / 0.6185（版本冲突） | ✗ | ✓ | ✗ | ✗ |

- 独立数值扫描：生成端全部 distinct 数值中「既不在小论文文本也不在项目事实集」= **0**（run1、run2 均为 0）；与 held-out 共享 ≥2 位小数的页面 = 0（没有通过任何渠道继承学位论文独有数值）。
- 同实验异值（表 9 vs Fig. 6）：系统未取任一方——正确；该冲突只有在作者提供学位论文版材料时才会进入 `unresolved_conflict`。

### 15.3 质量比较（定量 + 必要人工评价）
- 研究主线：与真实论文一致（下洗建模 → 预测 → NMPC 集成 → 实验），缺真实论文的「编队」升华层（材料不在小论文）。
- 已有贡献覆盖：小论文 8 条贡献全部进入章节；真实论文摘要 4 项成果中 (1)(2 的 NMPC 部分)(3 的双机实飞) 被覆盖，(2 轨迹生成)(3 编队)(4 平台) 未覆盖 = 正确缺失。
- 科研事实保持率：写入正文的事实 100% 可追溯（0 虚构）；修订后 75.37% 在三处被弱化为「显著降低」——这是 reviewer 误判（§17 F5）导致的**合法事实被弱化**，不是编造，但说明 Reviewer 口径缺陷会反向损失信息。
- 引用可靠性：0 引用（检索未配置），无幻觉。
- 学术表达：reviewer 指出工作流措辞污染正文（「依据本章的科研事实纪律…」）、跨节章号不一致、模板化小结——真实缺陷，未修（§19）。
- Review/Revision 收敛：run1 两轮即停（REGRESSION）；run2 一轮 + 预算停。章节重复：无；无依据结论：reviewer 10 条 UNSUPPORTED 中 7 条源于「无实验包」口径误判（§17 F5），2 条为具名文献无引用（真实缺陷），1 条开源陈述。

## 16. Token / 成本 / 耗时

| 实验 | 调用 | input | output | cacheRead | 估算费用（list-price） | 墙钟 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| caseB-run1 | 23 | 150,766 | 30,809 | 339,008 | $0.435 | 701s |
| caseB-run2 part1 | 3 | 9,802 | 6,321 | 3,776 | $0.043 | 161s |
| caseB-run2 part2 | 24 | 110,563 | 19,593 | 445,248 | $0.357 | 361s |
| **合计（全局账本）** | **50 / 50** | 271,131 | 56,723 | 788,032 | $0.834（订阅渠道实际按量支出 0） | ≈20 min 模型实验 |

- Provider：zai-coding-cn / glm-5.3；费用口径：Pi usage 的 estimatedCost（provider list-price）；预算主键为调用数与 token（input+output+cacheWrite），不依赖费用。
- 本机资源：docling 单路 69s/篇（CPU torch）；xelatex 5s；全量后端测试 342s（2 workers）；无 GPU；无明显 RSS 压力。
- 整轮墙钟 ≈ 2.5h（< 4h 上限）。

## 17. 发现并修复的实际问题

| # | 问题（失败证据） | Root Cause | 修复 | 定向测试 | 真实复验 |
| --- | --- | --- | --- | --- | --- |
| F1 | run1：修订 0 接受仍提交 rev-2 并再审一整轮（3 次调用）→ 相同正文被 reviewer 噪声判 REGRESSION | `planSharedTail` 以 reviseIdx > reviewIdx 一律重走 citation→review；无「零接受」语义 | `reviseAppliedNothing`：revise 零接受且最新 → 直接 stalled（accept_draft → Draft；revise_more → 复审）| thesisConvergence 场景 I（review 恰 1 次、stalled gateRound=1、原稿逐字节保留、Draft 注册） | run2 未触发（4 候选接受）；由确定性回放证明 |
| F2 | run1：ch05 拥有「75.37%」贡献却无事实支撑，缺材料检测不拦，Writer 写入后 reviewer 阻断 | `missingMaterialChapters` 只看「有无任何可写事实」 | experiment 章拥有含具体数值的 experiment_result 贡献且数值无可用事实 → missing（`statementHasNumericClaim`） | thesisPlanner 2 例 | run2 中 75.37% 已成事实 → 正确不触发 |
| F3 | Table III「Parameter\|Value×3」六条行标签错误 → 正文 `q_{p,xy}=400`（reviewer 抓到） | 成对键值列表头未识别，整行取首列为行标签 | `isPairedKeyValueHeader` + 数值单元格行标签取左侧键 | m145CaseBRegressions | Phase B 基线复跑：`Qp,z=400`、`dtpred=0.1s` ✓；run2 正文正确 |
| F4 | Table II 堆叠子表头 → `Adam\|Initialization=1e-4`，Draft 写「初始化参数取为 1e-4」 | 子表头行被当数据行 | `detectStackedSubHeaders`（保守：全文本行 + 后随数值行 + 非表头复本） | m145CaseBRegressions（含 3 反例） | 基线复跑：`Adam\|Learning Rate=1e-4` ✓ |
| F5 | reviewer 把作者已确认事实（75.37%、超参数）判为「本项目没有已导入的实验数据 / 未授权」→ 全部 blocking；修订随之删掉正确数值 | Reviewer 的 Experiment Policy 只读实验包；thesis 项目的 ResearchInput 事实对 reviewer 不可见（Writer 可见） | `renderThesisFactPolicyLines` 注入三路 review 与单元 review prompt | m145 单测 + thesis.e2e 路径 A 断言 review prompt 含事实表与 0.724 | **未真实复验**（预算 50/50 已用满——如实 PARTIAL 项，见 §19） |
| F6 | 正文「75.37% reduction in tracking error」零正文事实 | 指标词典无误差类；「数值在前」句式不匹配 | 误差/RMSE/tracking error 词条 + `percentChangeBefore` + 降低了/下降了 关系词 | m145CaseBRegressions（含反例） | 基线复跑 1 条 numeric_result ✓；run2 贡献链接 ✓ |
| F7 | 驱动器 `draftArtifact` 永远 undefined（断言假失败） | 读 `item.id`，契约为 `artifactId` | 兼容读取 | run2 真实断言通过 | ✓ |
| F8 | 驱动器在工作流启动前刷新表格候选 → 输入尚未入选 → 0 候选永不授权 | `refreshTableCandidates` 只对 scope=included 构建 | 移到入选 + 事实确认之后 | run1/run2 各授权 2/2 | ✓ |
| F9 | 案例 B 书目元数据错误（§2） | M14.3 规格手误 | 更正 | — | ✓ |
| F10 | 单 run 预算无法约束多次实验合计 | M14.4 设计边界 | 编排器层 GlobalBudgetLedger（§13） | globalBudgetLedger 2 例 | 50/50 实测 |

未做（刻意）：不改 Gate 阈值；不放宽 Fact/Citation/Evidence Guard；不为案例硬编码标题/数值；不重建 Workflow / Runtime。

## 18. 自动化测试与回归

| 项 | 结果 |
| --- | --- |
| 后端全量（`npx vitest run --maxWorkers=2`，最终清洁运行） | **3,649 passed / 0 failed / 30 skipped（335 files；314s）**（第一次全量 3648 passed / 1 failed：failed 为本测试文件在源码补丁落盘中途被采集（`renderThesisFactPolicyLines is not a function`）+ orchestratorHardening 的 Windows 临时目录 ENOTEMPTY 清理竞态——两者隔离复跑均通过） |
| 新增确定性用例 | globalBudgetLedger 2 / m145CaseBRegressions 6 / thesisPlanner +2 / thesisConvergence 场景 I 1 = **11** |
| 既有定向回归（thesis 全家族 / longChapterRevision / bounded / convergence / guard / planner / facts / review）| 全绿（本文 §17 每项修复后立即复跑） |
| typecheck | 后端 ✅ / 前端 ✅ |
| build | 后端 ✅ / 前端 ✅ |
| `git diff --check` | ✅ |
| 五类 Workflow 回归 | idea_to_paper / topic_survey / existing_paper_improvement / existing_paper_review / thesis_from_papers 全量套件绿；F1 的零接受短路对四类旧工作流同样生效但只改变「零接受仍复审」这一病态轨迹（longChapterRevision 22 例绿） |

## 19. 剩余限制（如实）

1. **F5（Reviewer 事实口径）只有确定性验证，没有真实模型复验**：全局预算 50/50 在 run2 用满；按纪律不再启动模型。真实效果待下一轮首次 run 验证。
2. **没有「材料缺口清单」能力**：系统能避免编造、能在规划层声明体量偏薄，但不能输出任务 §六 的六要素清单；真实缺失只能由 held-out 对照（本轮）或作者判断得出。
3. Writer 真实缺陷未修：工作流措辞污染正文、跨节章号不一致、模板化小结；无摘要（Planner 未产出 abstract）；无参考文献（检索 provider 未配置）。
4. Table I（docling 单元格合并）不可逐格抽取——四旋翼参数未成为事实（也因此未进入 Draft，不构成错误）。
5. run2 只有一轮 review：修订前后质量不可比较（如实不比）；Early Stop 的「连续无进展」只由确定性回放与 run1 覆盖。
6. 两个真实案例（范登平博士 / 李谨杰硕士）不足以外推所有学位论文；本轮结论只对本语料成立。
7. 评估脚本的「以完成时态声称」判定是关键词启发式，人工复核了 8 个主题的命中上下文（均为综述 / 展望语境）。

## 20. 下一阶段建议

1. 「材料缺口清单」（MissingMaterialLedger）：以 Planner scopeConcerns + 章节责任模板（硕士论文常见章：建模与辨识 / 平台 / 多机扩展）为输入，生成作者可勾选的缺口条目（缺什么 / 属哪章 / 为何小论文不支撑 / 需何原始材料 / 可否先写理论 / 是否必须等实验）——纯确定性 + 一次模型提案，接入 hitl.author_decision。
2. 用 ≤10 次调用的定向 smoke 真实复验 F5（单元 review 对 75.37% 的判定）。
3. Writer 跨节编号一致性检查（intro-organization 与 chapter-mapping 对账，确定性）+ 工作流措辞黑名单守卫。
4. Planner 产出摘要（中英）与关键词；evidence supply 配置真实检索后补参考文献。
5. docling 合并单元格表格（Table I 形态）的拆分策略（按文本层逐行对齐）。

## 21. Git 与 CI 状态

见文末「最终交付」小节（提交后填写）。

---

## Case A（范登平）与 Case B（李谨杰）对比

| 维度 | Case A（M14.3，博士，4 篇） | Case B（M14.5，硕士，1 篇） |
| --- | --- | --- |
| 输入 | 4 篇开放论文（ICCV/ECCV/IJCAI/CVPR） | 1 篇 CDC 2023（答辩时 Submitted） |
| 论文类型 / 真实篇幅 | 博士 124 页 | 硕士 123 页 |
| 材料完整度 | 核心 4 章全部有论文对应（60% 页面） | 核心仅 ≈24% 页面有论文对应；≈37% 为无论文工程章 |
| 事实 | 560 表格事实 / 558 核验；10 张继承表格 | 11 事实（10 表格 + 1 正文）；2 张继承表格 |
| 规划 | 8 章 23 节 | 6 章 16 节（Planner 自述体量偏薄） |
| HITL | include×4 / fact_confirmation×4 / outline / write_as_limitation | include / fact_confirmation / outline（含真实暂停-重附着-Resume）/ stalled 或 overflow |
| 修订收敛 | R3：5 轮循环劣化（186→544 issues）人工止损 | run1 两轮即停；run2 一轮 + 预算停；候选级守卫拒绝 / 接受均有实录 |
| 资源 | 三轮 452 次调用（R3 349 / 85 min） | 两个实验 **50 次**（硬上限）/ ≈20 min |
| 终态 | 人工恢复 rev-3 后产品 API 编译 66 页 | 自动 build.draft 42 页（两次） |
| 最重要差异 | 多篇整合：冲突 / 版本 / 表格继承是主要风险 | 单篇扩展：**不编造缺失研究**是主要风险——系统守住了（0 虚构），但缺「缺口清单」 |

**最终判定：M14.5 COMPLETE（§15.2 必要条件逐项满足；§19 限制 1 使 F5 的真实效果留待下一轮）。真实 Workflow 终态：Draft generated（QUALITY_NOT_REACHED；modelBudgetExhausted）。**
