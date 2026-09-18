# PaperTeam Evaluation（M6.8 — Agent Reliability Evaluation Framework）

评估基建（不是产品功能）：回答三个实验问题——

1. **Experiment 1（evidence-grounding）**：Evidence Grounding 是否降低错误？
   三臂对比 plain-llm / rag / paperteam（三段核验），注入 unsupported
   claims 与 fabricated citations，度量 unsupported claim rate / fabricated
   citation rate / evidence coverage。
2. **Experiment 2（revision-safety）**：Revision Safety 是否降低事实漂移？
   两臂对比 baseline（Reviewer→Writer 直通）vs paperteam（Plan→Writer→
   Validation→Gate 闭环），复用 scriptedRuntime 既有故障注入
   `[fact:mutate]` / `[cite:drop]` / `[strength:escalate]`，度量 fact
   violation / citation loss / claim escalation 存活率 + false acceptance /
   false rejection。
3. **Experiment 3（agent-workflow）**：Agent Workflow 是否比普通单次生成更
   可靠？两臂对比 plain-llm（单次生成）vs paperteam（完整
   idea_to_paper 管线），度量 claim correctness / citation correctness /
   completeness / human preference（校准记录）。

## 运行

```bash
npm run build                # 先构建 backend（CLI 从 dist 加载）
npm run evaluation           # 全部实验、全部场景 → evaluation/reports/
npm run evaluation -- --experiment 1
npm run evaluation -- --scenario g1-rag-survey --scenario r1-fact-mutate
npm run evaluation -- --experiment 2 --hitl-policy needs_review
npm run evaluation -- --list # 列出全部场景 id
npm run evaluation -- --out D:/Tmp/eval-reports
```

## 目录

```text
backend/src/evaluation/       # 框架代码（datasets / metrics / runners / cli）
backend/test/evaluation/      # 测试（场景校验 / 指标 / 注入 / 报告 / 基线对照）
scripts/evaluation.mjs        # npm run evaluation 入口
evaluation/reports/           # 生成的报告（JSON 事实源 + Markdown 摘要）
evaluation/calibration/       # 人工校准记录（records.jsonl，人工维护）
```

数据集是高质量小数据（Exp1: 6 / Exp2: 7 / Exp3: 5 个场景），全部确定性
自造学术语料 + ground truth 标注；结构校验见
`backend/src/evaluation/datasets/index.ts`（CLI 启动即校验，脏数据拒绝运行）。

## 人工校准

`evaluation/calibration/records.jsonl` 逐行 JSON（模板见
`records.example.jsonl`）：记录 experiment / scenarioId / arm / claim /
prediction（自动指标预测）/ humanLabel（人工标注）/ reason。runner 自动
计算自动指标与人工标注的一致率并写入报告——用于验证自动指标信度；
Experiment 3 的人工偏好用 `humanLabel: "prefer-plain-llm"` /
`"prefer-paperteam"`。

## 如实边界

scripted（无真实模型）实验度量的是**确定性安全机制对注入故障的拦截率与
管线保障**（traceability / 反捏造 / 完整度），不是真实模型的生成质量。
生成质量与人工偏好结论需要后续 live run + 人工校准记录（框架已预留）。
