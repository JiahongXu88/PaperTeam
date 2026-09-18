# M6 Final Summary — Research Discovery & Evidence-grounded Pipeline

> 日期：2026-09-18 · 状态：**M6 COMPLETE（M6.0–M6.9 全部完成，Documentation
> Freeze）** · 架构冻结：D-0041 · 最终流水线：ARCHITECTURE §1.3
> 状态事实源：[PROJECT_STATUS.md](../PROJECT_STATUS.md)；本文是 M6 的
> 里程碑级总览，不重复各子里程碑明细。

---

## 1. Overview

M6 的目标：让 PaperTeam 从「凭模型记忆写作」升级为「**以经过核验的证据
为地基的研究-写作系统**」。回答两个问题：

1. **资料从哪来**——多源学术 / Web 检索（Research Discovery）、项目级
   文献库（Literature Library）、项目内检索（Retrieval / RAG）；
2. **资料凭什么可信**——检索结果不直接等于证据（Retrieved ≠ Verified ≠
   Grounded）：候选-转正状态机 + 三段核验（Evidence Grounding）、写作 /
   审稿消费侧只认 verified 证据（Evidence-aware Writing Loop）、修订过程
   的事实安全（Revision Safety）；并以可重复实验（Evaluation Framework）
   与真实多模型评估（Multi-model Evaluation）验证整套主张。

M6 里程碑（全部 ✅）：

| 里程碑 | 内容 | 决策 |
| --- | --- | --- |
| M6.0 | M5 baseline freeze | — |
| M6.1 | Search/RAG 开源调研 + 架构冻结 | D-0033 |
| M6.2 | Project Literature Library | D-0034 |
| M6.3 | Research Discovery & Academic/Web Search | D-0035 |
| M6.4 | Project RAG & Hybrid Retrieval | D-0036 |
| M6.5 | Evidence Grounding Pipeline | D-0037 |
| M6.6 | Evidence-aware Writing Loop | D-0038 |
| M6.7 | Revision Safety & Quality Gate Evolution | D-0039 |
| M6.8 | Agent Reliability Evaluation Framework（scripted） | D-0040 |
| M6.9 | Multi-model Reliability Evaluation（live） | D-0041（冻结） |

M6 全程红线：零新增 Agent（D-0009 贯穿）、不改 Runtime / Workflow 核心、
评估只读被测系统。

## 2. Major Contributions

### 2.1 Evidence-grounded Research Agent

PaperTeam 的最终形态在 M6 定型并冻结（D-0041）：确定性 Workflow 编排 +
四个角色 Agent（Researcher / Writer / Reviewer / Citation）+ 强 Tool 层 +
Evidence Layer + Quality Gate。Agent 能力扩展不开新角色，走「工具 +
证据层 + 门禁」——Agent 可以**使用**证据（evidence_query / get_chunk），
但**不能定义**什么是证据（写入路径单点化，Agent 提案只入候选队列）。

### 2.2 Retrieval ≠ Evidence

M6 最重要的架构区分：**检索到的原文段落不是证据**。三层各自职责与
红线——Search（发现，默认零持久化，snippet 最高 plausible）；Retrieval
（索引是 Derived State，零 EvidenceStore 写路径，工具输出明示
"retrieved passages ≠ verified evidence"）；Evidence（唯一转正通道是
三段核验）。该不变量（Retrieved ≠ Verified ≠ Grounded）在类型（只读
投影）、装配（构造边界）、测试（行为断言）三重钉死，并经 M6.6 架构
审计确认无第二套口径。

### 2.3 Verified Evidence Pipeline

「候选 → 转正」两段式供给（M6.5）+ 消费侧收紧（M6.6）：

- **EvidenceCandidate 状态机**（pending → verified / mismatch / rejected /
  unverifiable），转换唯一入口 markResolved；grounded 写入唯一入口
  EvidenceGroundingService（appendBatch）——工具层零写路径。
- **三段核验**：Stage 1 quote 逐字校验（确定性，归一化子串匹配——虚构
  引文在此拦截）；Stage 2 metadata 核验（确定性，权威记录裁决年份 /
  作者 / DOI 错位；not_found 不阻塞，离线部署可用）；Stage 3 语义 judge
  （唯一 LLM 阶段，复用 Citation 角色，prompt 只见 claim + quote + chunk
  原文，无法判断 → unverifiable 不伪造裁决）。
- **消费侧**：EvidenceSelectionService 唯一使用策略（正式证据 = verified
  + sourceId + chunkId 锚点三件套）；writer 的 evidence_query formalOnly
  视图（构造边界强制，Agent 传参不可放宽）；Quality Gate
  citations_evidence_backed 覆盖检测。

### 2.4 Revision Safety

M6.7 把修订闭环从「Reviewer 发现问题 → Writer 修改」升级为
「**Revision ≠ Correct Revision**」的完整安全链：RevisionPlanItem
生命周期状态机（planned → applied → validated / rejected / needs_review，
非法流转确定性拒绝）→ `revision.validate` stage 四类确定性复核（Fact /
Citation Preservation + Claim Strength 升级检测 + Evidence Re-validation）→
Revision Gate 两条规则（rejected / needs_review / block 阻断 Final，用户
approve 留痕放行）→ HITL `hitl.revision_validation`（reject = 恢复修订前
快照）。数字没变、引用没动但「可能改善 → 显著提升」的强度漂移在此层
拦截。

### 2.5 Multi-model Evaluation

M6.8 建立 scripted 离线确定性评估框架（三实验三/两臂 + 故障注入 + 人工
校准接口，被测系统零改动）；M6.9 将其 live 化并扩展到五个模型族
（GLM-5.3 / claude-fable-5-1 / gpt-5.4 / deepseek-v4-pro / qwen3.7-max，
anthropic-messages + openai-completions 两协议），全程确立诚实测量口径
（refused 是合法结果；same-model judge bias 显式标注；公开名归一化，
内部路由别名只经环境变量注入）。评估只读系统，不反向影响产品决策路径。

## 3. Evaluation Summary

### 3.1 Scripted 离线实验（M6.8；报告 docs/research/M6.8_EVALUATION_REPORT.md）

- **Exp1 Evidence Grounding**（三臂）：fabricated citation 25.0%（plain-llm）
  → 7.1%（rag）→ **0%（paperteam）**；unsupported claim 17.9% → 17.9%
  （rag 持平——引文真实 ≠ 论断被支撑）→ **0%**；正例 coverage 100% 无损。
- **Exp2 Revision Safety**（两臂）：[fact:mutate] / [cite:drop] /
  [strength:escalate] 注入下存活率与零信号放行 100% → **0%**；干净对照
  零误拦；拦截点前移至 revision.validate。
- **Exp3 Agent Workflow**（两臂）：claim traceability 0 → 60%（无语料
  场景按 M6.6 口径诚实计 0）；citation correctness 40 → 100%；
  completeness 24 → 100%。
- 边界：度量确定性安全机制对注入故障的拦截率与管线保障，非真实模型
  生成质量（live 化即 M6.9）。

### 3.2 Live 多模型评估（M6.9；报告 evaluation/reports/）

模型矩阵（scenario g1-rag-survey × 两臂 × 每臂 5 提案，claude-compatible
数据集全批统一）：

| model | family | Arm A（Plain LLM）fabricated | Arm B（PaperTeam pipeline） |
| --- | --- | --- | --- |
| GLM-5.3 | glm | 5/5 100% | leak 0，verified 80% |
| claude-fable-5-1 | anthropic | 5/5 100% | leak 0，verified 60% |
| gpt-5.4 | openai | 5/5 100% | leak 0，verified 80% |
| deepseek-v4-pro | deepseek | 5/5 100% | leak 0，verified 80% |
| qwen3.7-max | qwen | 5/5 100% | leak 0，verified 80% |
| **aggregate** | — | **25/25 fabricated** | **零捏造泄漏；metadata 拦截 6；转正 19/25（76%）** |

结论（限定 evaluated scenarios）：

- **Plain LLM：citation hallucination observed**——五个模型族全部出现
  引用捏造（quote 不在所声称来源），Arm A 25/25 提案 fabricated，不局限
  于单一模型族。
- **PaperTeam pipeline：zero fabricated evidence leakage**——三段核验下
  零捏造证据进入 verified 池（fabricatedLeaked=0 全模型）；本批管道实际
  拦截的是 metadata 陷阱（年份错位 6 条，Stage 2 权威记录裁决，全部未
  转正）；全文在场时五模型 quote 复制均逐字命中，quote 拦截路径本批
  未被触发——有效性证据是零泄漏与 metadata 拦截，**不是** fabricated
  拦截率。

### 3.3 Limitations（如实，不外推）

- **small scale**：每模型 1 场景 × 每臂 5 提案，比例指标不具统计效力
  （方向性证据，非显著性检验）；scripted 实验为高质量小数据集。
- **limited scenarios**：live 仅 Exp1 grounding 场景（RAG survey 域）；
  Exp2 / Exp3 未 live 化；未覆盖其他领域。
- **same-model judge bias**：judge 与生成同模型（报告显式标记），
  verifiedRate 跨模型对比含自评偏差。
- 其他：全部模型经同一网关（内容过滤 / 协议翻译 / 限流为公共混杂
  因子）；metadata 权威记录用数据集内置 ground-truth provider（非真实
  Crossref / OpenAlex）；结论限定 evaluated models（本批 5 个），不应
  表述为「所有模型」。

## 4. M7 Entry Point

M6 冻结（D-0041）后的候选方向（进入 M7.0 计划冻结时裁剪定界）：

1. **Evaluation live 扩展**：多场景 / 多领域、异模型 judge（消除
   same-model bias）、更大样本、Exp2 / Exp3 live 化。
2. **FullTextResolver**：D-0033 六层最小接口中唯一未实现层。
3. **Reference Paper Intelligence**（M6+ backlog 既有项）。
4. **Multimodal Review**（M6+ backlog 既有项）。
5. **遗留收口**：Researcher legacy 路径迁移、roleCustomTools 装配集中化
   （M6.6 Known Limitation）。

M6 冻结分层不再改动；扩展一律在其上叠加。
