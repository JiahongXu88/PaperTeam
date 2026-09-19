# M8 Roadmap Proposal — Research Intelligence（提案稿）

> 日期：2026-09-19 · 状态：**proposed（M7.1d Self Review 的产出，只提案不实施）**
> 上游：[PAPERTEAM_SELF_REVIEW_M7.md](PAPERTEAM_SELF_REVIEW_M7.md)（差距分析）
> / [M7_SCOPE_FREEZE.md](M7_SCOPE_FREEZE.md)（M7.2/M7.3 既有安排）
> 纪律：本文不预设结论——每个候选方向都带**进入条件**（数据门槛）与
> **不进入条件**；M8 入口须照 M7 流程先做 Scope Freeze + DECISIONS 登记。

---

## 0. 定位与前置

M8 与 M7 既有里程碑的关系（不重叠、不重排）：

| 既有安排 | 归属 | 与 M8 的关系 |
|---|---|---|
| M7.2 FullTextResolver（P-D 断点，D-0042 挂接点已冻结） | M7 | **M8 硬前置**——没有全文，一切检索增强的价值都被 chunker 截断 |
| M7.1 验收后半段（promote → 全文 → verified 磁盘证据） | M7 | 同上 |
| M7.3 Research Intelligence（方向冻结：Reference Paper Intelligence + Evaluation live 扩展） | M7 | M8 吸收其「Evaluation live 扩展」维度并具体化；Reference Paper Intelligence 的引证网络维度并入 M8.3 候选 |

**M8 候选主题一句话**：把 PaperTeam 从「单轮检索 + 人工驱动」升级为
「计划驱动、可度量、证据复利」的研究调研工作台——**不改变 HITL 定位，
不新增 Agent，不追无人值守长循环**（Self Review §5 结论 1）。

---

## 1. 候选方向（按 Self Review P0→P2 映射）

### M8.1 — Discovery Observability（P0-3，建议为 M8 第一步）

- **内容**：评估框架内新增只读 discovery 统计（候选量 / promote 率 /
  拒绝原因分布 / provider resultCount 与健康 / query 多样性），per-project
  可导出。复用 M6.8 纪律：评估只读被测系统，零行为改动。
- **为什么先做**：M7.3 启动前置（M7_SCOPE_FREEZE §6）与 Self Review
  P0-3 同判——没有数据，后面每个方向都是拍脑袋。
- **进入条件**：M7.1 验收后半段完成（有真实 promote 数据可统计）。
- **不进入条件**：无。
- **规模预估**：小（评估目录内新增 runner + 报告 schema；零业务代码）。

### M8.2 — Web Search 开箱可用（P0-1）

- **内容**：部署面（compose 默认含 SearXNG + doctor 检查 + 文档），
  可选评估非 SearXNG 的 Web provider（若引入才需 DECISIONS 登记，
  D-0033/D-0036 不重开前提下）。
- **进入条件**：无硬依赖，可独立推进；与 M8.1 无序。
- **不进入条件**：若真实项目数据显示用户全走学术源、Web 候选 promote
  率≈0（M8.1 产出），降级为 backlog。
- **规模预估**：小（部署 + 文档；架构零改动）。

### M8.3 — Research Plan 一等产物 + 引证网络透传（P1-1 + P2-2）

- **内容**：
  1. research.idea 产物增加「下一轮检索计划」结构（query × 理由 × 期望
     覆盖），前端（M7.1c 面板延伸）提供查看/编辑/执行入口——执行走既有
     检索 HTTP 面，无新 Agent、无新 workflow stage；
  2. 候选详情透传 OpenAlex references/cited-by（provider 已返回、当前
     未透传），支撑滚雪球式扩展（系统综述方法论标配）。
- **外部证据**：Gemini 可编辑研究计划（DR 交互标配）；STORM 视角问题集；
  Connected Papers 型引证扩展（Self Review §4 P1-1/P2-2）。
- **进入条件**：M8.1 数据显示 literaturePlan 残差非空率显著（用户确实
  需要「下一轮」）；引证透传部分只需 M7.2 完成（全文在手才读得动引证图）。
- **不进入条件**：残差率低（单轮已够）则 1 缓行；2 独立价值成立可先行。
- **规模预估**：中（前端为主 + 产物 schema 小扩展；research.json schema
  变更须走 DECISIONS——这是本文唯一触碰既有契约的点，需在 M8 freeze 时
  明确）。

### M8.4 — 受控多轮检索循环（P1-2，依赖 M8.3）

- **内容**：计划驱动的有界多轮（执行 M8.3 计划 → 新结果率低于阈值自动
  停 → 每轮结果仍只进 pending 候选）；循环编排在确定性服务层。
- **外部证据**：DR 产品 5–30 分钟自主循环；PaperQA2 候选答案驱动再检索。
  反向证据同样重要：PaperTeam 定位是研究工作台不是自动报告机（Self
  Review §5），故只做「计划驱动的受控多轮」，不做无人值守长循环。
- **进入条件**：M8.3 落地 + M8.1 数据证明单轮覆盖不足（如残差计划平均
  长度 ≥N、或用户手动二次检索频率高）。
- **不进入条件**：M8.1 数据显示单轮够用（候选 promote 率健康、残差低）。
- **规模预估**：中-大（新服务层循环 + 停止条件 + 护栏测试；红线重申：
  无新 Agent、无 Runtime/Workflow 改动——循环在服务层，Agent 会话仍是
  单轮语义）。

### M8.5 — Discovery 评估场景 Exp4（P1-4，可并行）

- **内容**：评估框架新增 Exp4：种子文献集 → discovery 命中率/排序质量
  （scripted 起步）；后续 live 化 + 多模型 judge（P2-3 合并于此）。
- **进入条件**：M8.1 落地（统计基建复用）。
- **不进入条件**：M8.1/M8.3 数据显示检索质量已满足当前用户规模。
- **规模预估**：中（完全在 evaluation/ 目录，业务零改动）。

### M8.6 — Verified 证据综合视图「研究 wiki」（P2-1，长期）

- **内容**：verified evidence 上的项目级综合（主题/冲突/演进视图），
  文件优先落盘（D-0013 纪律内），EvidenceStore 写路径不动。
- **进入条件**：真实项目 verified 证据量达到阈值（M8.1 度量），且 M7.2
  全文链路成熟（综合对象以全文证据为主）。
- **不进入条件**：证据量小（逐条检索已够用）；或与 M7.3 Reference
  Paper Intelligence 设计合并更优时（届时统一 freeze）。
- **规模预估**：大（独立设计冻结 + 新前端视图 + 综合 prompt 工程）。

---

## 2. 建议编排（提案，非决定）

```text
M8.0 Scope Freeze（数据输入 = M7.1 验收后半段 + M7.2 完成后的真实使用数据）
  ├── M8.1 Discovery Observability   ← 建议第一批（地基）
  ├── M8.2 Web Search 开箱可用        ← 可并行（部署面）
  ├── M8.3 研究计划 + 引证透传        ← 第二批（M8.1 数据 gate）
  │     └── M8.4 受控多轮循环         ← 第三批（M8.3 + 数据 gate）
  └── M8.5 Exp4 检索评估             ← 跟随 M8.1（并行池）
  M8.6 研究 wiki                     ← 长期池，独立设计冻结
```

**排除项**（Self Review §5 结论，M8 维持冻结）：无人值守长循环自动报告、
竞争性多 agent 辩论、新增 Search/Planner Agent、Vector DB、RAG 重构、
检索持久化默认化。

---

## 3. 决策链（进入 M8 前须登记）

1. D-00xx：M8 范围冻结（本提案裁剪后的版本，复用 M7 冻结流程）；
2. 若 M8.3 触发 research.json schema 变更 → 独立登记（唯一契约触点）；
3. 若 M8.2 引入非 SearXNG Web provider → 登记（否则仅部署面改动免登）。

---

## 4. 一句话总结

**M7 把检索能力接成闭环；M8 让闭环可度量、可计划、可复利——顺序是
「先有数据（M8.1），再谈纵深（M8.3/8.4），最后谈综合（M8.6）」。**
