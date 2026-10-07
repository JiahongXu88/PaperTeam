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
