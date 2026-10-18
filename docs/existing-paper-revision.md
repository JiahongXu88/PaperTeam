# 已有论文返修（Existing Paper Revision）

> 面向技术读者：按审稿意见修订已有论文的完整链路、分层判定语义与安全边界。
> 使用视角的简介见 [product-guide.md](product-guide.md)。

## 1. 输入

| 输入 | 说明 |
| --- | --- |
| 已有论文 | PDF（≤30MB，确定性重建为可修订稿件）或 LaTeX 工程压缩包（直接在原稿上修改） |
| 外部修改意见 | 期刊外审专家 / 编辑 / 导师 / 本人要求 / 其他；单条录入或 Markdown 批量导入；**原文逐字保存** |
| 可选真实材料 | 你的实验数据、报告、表格等（入库后作为定向证据源） |

快速 Review 是同一导入入口的只读分支：引用核验 + 分章节审阅 + 导出报告，
不进入修订。

## 2. 链路（stage 序列）

```text
导入解析 → 基线编译（xelatex+bibtex 真实通过）→ 结构与清单 → 基线审阅
→ 引用核验 → 目标评估（可行性复用，逐条适用性）
→ 研究计划（确认）→ 计划执行 → 定向证据补充（evidence.supply.review）
→ 改进计划（确认，进入授权台账）→ 受限修订（scoped patches）
→ 修订校验 → 引用复核 → 三路审阅 → 质量门禁
   ├─ 未通过 → 有界修订循环（不收敛 / 超限 → 人工决策）
   └─ 通过 → Draft → Final → 返修追踪报告（Revision Trace）
```

关键机制：

- **定向证据补充**：按意见从你的本地材料做 Targeted Grounding，只有 verified
  证据会追加；Planner 使用 run 内 `C#` / `EV#` 别名，确定性解析。
- **受限修订**：Writer 以只读工具 + 补丁提案工作（无直接写盘通道）；每个
  patch 有 span 重叠 / 越界 / 过期基线守卫，apply 前后双重 hash 复核。
- **补丁校验（Patch Validation）**：scope / workspace 完整性 / 直接改动 /
  fact / citation / evidence / apply 七类确定性判定，逐 patch 记录
  PatchValidationRecord；校验失败的补丁进入确定性修复或回滚，不会带病落盘。
- **结构化修复（Structured Repair）**：计划条目字段非法时，机器给出可修复
  字段清单让 Planner 定向修复（bounded 轮次），不整轮重试。

## 3. 分层判定（M11.4 核心）

返修完成有**两层独立判定**，不要合并理解：

### 返修任务层（Revision Task）

问题：*审稿意见是否全部闭环，且修订本身安全？*

- verdict 三态：`PASS` / `FAIL` / `AUTHOR_DECISION_REQUIRED`。
- 组成：意见闭环（逐条 handled / already_satisfied / conflict /
  author_decision，由确定性引文核验与 patch lineage 推导，不采信模型自称）、
  确定性守卫全过、patch 实质性、修订引入的 claim / blocking finding = 0、
  学术分非回归（基线 −10 容差）。
- 任务层成功即可产出 Draft（终态 `REVISION_TASK_COMPLETE`），不再追问投稿层。

### 投稿就绪层（Publication Readiness）

问题：*整篇论文当前是否达到可投稿状态？*

- verdict 三态：`READY` / `NOT_READY` / `AUTHOR_DECISION_REQUIRED`。
- 消费全稿规则（学术分 / blocking finding / 基线继承风险清单）；
  `academicScore >= 80` 在此层生效，但**不是任务层硬门**。

**Revision Task Success ≠ Publication Ready。** 用户可以成功完成返修、拿到
修订稿 Draft，同时收到诚实的「未达投稿就绪」结论与剩余风险清单。工作流页
完成态会同时展示两层徽章。

## 4. 意见的四类结局

| 结局 | 含义 |
| --- | --- |
| handled | 已由具体 patch 闭环（引文 / lineage 证明） |
| already_satisfied | 基线稿本已满足（确定性核验，如节略引文逐字匹配） |
| conflict | 意见与实验事实 / 证据冲突：如实标记并给出依据，不伪造、不篡改、不静默忽略 |
| author_decision | 需要作者判断（灰区 claim、无证据表格数值、「评审断言被材料反驳」类语义） |

处理状态是**确定性判定**（机器推导 + 必要时降级为作者裁决），不采信模型自称。

## 5. 可靠性结论（M11.4）

21 次真实运行（同一 fixture / 基线 SHA / Coding Plan 通道）完成可靠性收口：
合法终态 10 次（含双层全过 + Final 冻结的 O run 与最终 HEAD 上 S/T/U 三连
AUTHOR_DECISION_REQUIRED）；comment closure failure = 0；guard false
positive = 0；Writer 越权事实改写进入冻结产物 = 0；held-out isolation 未
破坏。详见 [research/M11_4_RELIABILITY_CLOSURE.md](research/M11_4_RELIABILITY_CLOSURE.md)。

## 6. 已知边界

- PDF 重建是文本级；图表与版式不进入修订上下文。
- 「无证据支撑的表格数值只能作者确认」是产品语义（诚实呈现），不是缺陷。
- 学术分 80 投稿线未做全量校准（provisional floor 未启用）；分层 gate 的
  校准实验见 [research/M11_4_QUALITY_GATE_BENCHMARK.md](research/M11_4_QUALITY_GATE_BENCHMARK.md)。

## 7. 继续返修、增量复审与补丁候选（M14.8.1）

- **继续返修**：已终结的 run 不可 resume；在同一项目上新建改进 run 即合法继续——以当前修订为输入，
  修订号、审稿轮次、外部意见、事实授权台账沿用；累计事实守卫与候选级「对冻结基线」口径的授权来源
  都是「本 run 计划 + 授权台账」（前 run 已批准的事实变更不会被重新判为未授权）。Planner 意见别名表
  优先收录未闭环意见且不截断。
- **增量复审**（长文档单元模式）：单元结果跨轮复用的唯一条件是请求指纹相同（完整单元 prompt +
  实际模型 + Skill 版本）且单元未改动、未被依赖失效；任一正文改动都会让摘要 / 引言 / 讨论 / 结论
  所在章节重审，引用改动单元 `\label` 的单元重审；跨章一致性审查恒为新执行；Runtime 无法证明模型
  一致时禁用复用。覆盖账本（`coverage.incremental`）区分 Fresh / 合法缓存（来源轮次）/ 依赖失效 /
  未审；`PAPERTEAM_REVIEW_INCREMENTAL=0` 关闭。
- **补丁候选落盘**：`reviews/patch-candidates/rev-N/`（接受与拒绝都记录 Writer 原始提案、校验提案、
  授权引文与失败原因），供确定性回放；同修订号的补丁校验产物被后续 run 覆盖前保留在
  `supersededArtifacts`。
- **引文授权**：提案先按 span 的换行风格对齐、引文外纯空白差异以原文回填（判定仍逐字节）；同一
  span 多处互不相交的引文逐个授权（不并集）；引文越界获得一次有界定向修复，其余范围违规直接拒绝。

## 8. 真实审查包导入与修订过程说明守卫（M14.9）

- **实验 ZIP 上限**：文件数 2000、路径段 16（真实审查包 916 文件、仓库同路径最深 13 级）；单文件 20 MiB、
  解压总量 64 MiB、压缩比 100:1、路径长度 512 不变。条目只按流读入内存、不按包内路径落盘。
  大型包（≈60 万条指标观测、manifest ≈250 MB）可导入；只读路径（view / list / workflowContext / 指标浏览）
  在 manifest 未变时共享同一份解析结果（M14.9.1：3 个并发 workflowContext 堆峰值 2.3 GB → 0.4 GB），单次解析仍需
  约 0.85–1.4 GB 堆；仅声明私有 Release 资产哈希的
  清单文件应由作者改为 documentation 角色，避免其字节数进入指标观测。
- **版本号不是数值事实**：数值提取不从「R5.1」「v2.5」的点后部分切出独立数字；未授权删除的展示位置取该数值
  实际减少的章节（不再取全文第一处文本匹配）。
- **修订过程说明守卫**：候选新增段落若含内部计划 / 补丁 ID 或修订流程词汇（校验失败、修改要求、重提交、本单元……），
  判 `revision_meta_text`（REVISION_PROCESS_COMMENTARY_IN_MANUSCRIPT）并走有界修复；修复 prompt 明令不得在
  替换文本中回应校验结果。已经进入稿件的此类段落在事实守卫的数值提取前剥离——删除它不构成删除事实。
- **整段删除被引段落**：候选 = 引文前原文去尾部空白 + 仅空白 + 引文后原文去首部空白时，段落分隔随删除消失
  不判为引文外改动；引文旁的任何新增仍越界。
- **已知边界（M14.9，已于 M14.9.1 收口，见 §9）**：单文件 LaTeX 工程的 `revision.repair_latex` 整文件改写失败；
  计划确认 HITL 不展示条目的 `actionType`。

## 9. 计划处置透明、任务级预算与单元级编译修复（M14.9.1）

- **计划确认（hitl.plan_confirm）**：每条计划显示 `actionType` 与处置——将自动执行（modify，仍过范围 / 事实 /
  引用 / 编译守卫）、不改稿（noop，引文核验失败则转作者决定）、需要作者决定 · 本轮不执行
  （author_decision_required）、只记录证据（evidence_only）、动作类型缺失 · 不会执行；显示原因、章节与
  logicalSection、证据缺口（声明改动事实但无关联证据）与对应外部意见的当前闭环状态。未派发条目在批准前
  集中汇总，必须勾选「已知悉」才能批准（会话内持久化，计划被重做后失效）；批准不改变动作类型、不绕过守卫，
  改变处置只能经「修改计划」反馈由 Planner 重新生成。
- **任务级预算账本**：`PAPERTEAM_GLOBAL_BUDGET_LEDGER`（+ `PAPERTEAM_GLOBAL_MAX_MODEL_CALLS` /
  `PAPERTEAM_GLOBAL_MAX_TOKENS`）让一个外层任务的多个 improvement run、复审与外部脚本共享同一硬上限：
  每次请求启动前预留「prompt 预估 + 输出上界」，超限拒绝启动（`MODEL_BUDGET_EXCEEDED`）并持久化
  `BUDGET_EXHAUSTED`；耗尽后 planner 的预算信号对新 run 同样生效（走既有 Draft 降级，不会自动开新的恢复 run）。
  per-run 上限（`WORKFLOW_MAX_*`）不变。
- **单文件稿件的编译修复**：main.tex 含 `\begin{document}` 且无大纲时，诊断行号映射到所在编辑单元
  （logicalSpan，≤9000 字符），Writer 只收到并只返回该单元；单元原文哈希、骨架 / 导言命令、花括号、`\cite`
  多重集、`\label` / `\ref` / `\includegraphics`、修订过程说明、长度漂移与整文件事实保持全部通过才落盘，单元外
  逐字节不变；导言区或无行号的错误如实记为不可修复（不扩大范围）。是否编译通过仍由下一次 build.draft 判定。
