# Review 性能画像（2026-09-07，真实论文实测）

> 本轮只做诊断与必要 telemetry，不做大规模性能重构。数据来源：
> 1. **冷启动全量运行**（本次诊断）：真实论文（26 页 / 36 节 / 25 条引用 / 63 条 claim-citation），
>    全新 workspace，模型 `zai-coding-cn/glm-5.3`，阶段耗时与调用画像来自 run checkpoint
>    （stageHistory startedAt/finishedAt + stageResults 内新增 telemetry）。
> 2. **用户日常运行**（对照）：同一论文在上一个 workspace 的最近一次 completed run。

## 1. 冷启动全量运行（本次实测）

run `w-9d475ea05dc3`（2026-09-07 23:01–23:54，completed）：

| Stage | start → end | 耗时 | 占比 | 说明 |
| --- | --- | ---: | ---: | --- |
| paper.ensure | 15:01:02 → 15:06:20 | 317.6s | 9.9% | PDF 解析 288ms；其余 = 36 节摘要（36 次模型调用，串行，全部成功） |
| citation.extract | 15:06:20 | <1s | ~0% | 确定性提取（25 refs / 63 callouts） |
| citation.metadata | 15:06:20 → 15:06:56 | 36.3s | 1.1% | 27 次外部查询（crossref 24 + openalex 3），网络 35.3s——纯网络耗时，无浪费 |
| citation.claims | 15:06:56 → 15:08:36 | 99.7s | 3.1% | 63 条 claim：57 条确定性短路（零模型）+ 6 次 judge（99.6s，平均 16.6s/次）——stage 耗时 ≈ 纯模型时间 |
| review.sections | 15:08:36 → 15:54:39 | 2763.8s | **85.9%** | 33 节（36 节中 3 节无正文跳过）× 平均 83.7s/节，完全串行；0 失败 0 解析失败 |
| review.aggregate | 15:54:40 | <1s | ~0% | 确定性聚合（167 findings） |
| **Total** | | **3217.5s（53.6 min）** | 100% | |

模型调用总量：36（PaperMap 摘要）+ 6（语义 judge）+ 33（章节审阅）= **75 次**。

## 2. 用户日常运行（对照，全部缓存命中时）

| Stage | 耗时 | 占比 |
| --- | ---: | ---: |
| paper.ensure | 419s | 13.1% |
| citation.extract | <1s | ~0% |
| citation.metadata | 32s | 1.0%（记录复用） |
| citation.claims | 65s | 2.0%（记录复用） |
| review.sections | 2685s | **83.9%** |
| review.aggregate | <1s | ~0% |
| **Total** | **3201s（53.4 min）** | |

## 3. Top Bottlenecks（按真实耗时排序）

1. **Section Review — 85.9%（冷）/ 83.9%（用户对照运行）**。33 节串行，
   每节 1 次模型调用平均 **83.7s**（平均 prompt 4,852 chars / 输出 1,849 chars——
   延迟主要是模型推理本身，不是上下文规模）。节内已有退避重试；无任何跨节并发。
2. **PaperMap 摘要 — 9.9%（仅冷启动）**。36 节摘要串行（317.6s − 0.3s parse ≈ 8.8s/节）。
   指纹缓存命中时为 0（warm run 里 paper.ensure 只剩骨架重算）。
3. **语义 judge — 3.1%（冷）/ 2.0%（暖）**。本论文只有 6 条 claim 拿到可判证据
   （57 条 INSUFFICIENT_EVIDENCE 全部是"学术库记录无摘要"的确定性短路，零模型调用——
   不存在"无证据仍调 LLM"的浪费）。
4. **Scholarly Lookup — 1.1%（冷）/ 1.0%（暖）**。27 次查询无重复、无 429；
   in-process 查询缓存 + 磁盘记录双层去重生效。
5. **PDF parse — 288ms**，可忽略。

## 4. 串行 / 并发审计（代码事实）

| 链路 | 执行方式 | 证据 |
| --- | --- | --- |
| references metadata verification | **完全串行**（逐条 → 每 provider 串行 → 每 query variant 串行） | `CitationIntegrityService.verifyMetadata` for-loop；`ScholarlyResolver.resolve`/`runPlan` |
| claim semantic verification | **完全串行**（逐条；短路零成本） | `verifyClaims` for-loop |
| section review | **完全串行**（逐节；节内 3 次退避重试） | `definitions.ts reviewSectionsStage` for-loop |
| PaperMap summaries | **完全串行**（逐节摘要） | `PaperMapService.ensureMap` for-loop |
| Pi Runtime 会话 | 每任务独立 sessionKey（scope 隔离），**无 session 序列化瓶颈**——串行全部来自编排代码本身 | backend.log：每 scope 独立「创建会话」 |
| 外部 scholarly providers | 串行 + 限流友好（error 即停、单次重试） | `ScholarlyResolver` |

结论：慢的原因不是会话争用，而是**所有模型调用链路按顺序逐个执行**（设计取向：
确定性顺序 + rate-limit 友好）。33 节 × 84s 的串行是主要成本。

## 5. Provider 画像（本次冷启动）

| Provider | calls | not_found | errors | cache_hits | totalMs |
| --- | ---: | ---: | ---: | ---: | ---: |
| crossref | 24 | 3 | 0 | 0 | 28,666 |
| openalex | 3 | 0 | 0 | 0 | 6,648 |
| semantic-scholar | 0（未被需要：前序已命中） | — | — | — | — |
| arxiv | 0 | — | — | — | — |
| GitHub（software） | 1（API） | 0 | 0 | 0 | ~1s |

- 同一 reference 未被重复查询（27 calls / 25 refs / 0 cache_hits，无冗余）。
- 本轮无 429/503；无 API Rate Limit 问题。语义 judge 与 scholarly 限流是两类不同问题，
  本论文只命中前者（模型延迟）。

## 6. Performance Optimization Backlog（本轮不实施）

| 优先级 | 项 | 预计收益 | 风险 | 改动范围 |
| --- | --- | --- | --- | --- |
| P0 | **Section Review 有界并发**（如 3 路-worker 小池；findings 收集后确定性重排） | 33×84s → ~15-18 min（−65% 总时长） | Provider 限流（需并发≤3 + 429 退避复用现有节内重试）；进度事件语义从"第 N 节"改为"已完成 N 节" | `reviewSectionsStage`（单文件，~40 行） |
| P1 | **PaperMap 摘要有界并发**（仅冷启动收益） | 5.3 min → ~1.5-2 min | 同上（低：摘要无顺序依赖） | `PaperMapService.ensureMap` |
| P1 | **证据预取（abstract enrichment）**：crossref 命中但无 abstract 时补查 OpenAlex/S2 摘要 | 产品价值 > 性能：57 条 INSUFFICIENT_EVIDENCE 大部分可转为真实 verdict；顺带提升语义核验覆盖率 | +20 次外部查询（~25s 串行）；provider 限流 | `CitationIntegrityService.verifyScholarlyReference`（+1 步 enrichment） |
| P1 | **语义 judge claim batching**（多条 claim 一次判定，仅同 reference 同证据） | 当前只 6 次调用，收益小；证据预取落地后放大 | verdict 归因正确性（需逐条校验）；中 | `semanticVerifier` |
| P2 | **metadata 并行 / 持久 resolver 缓存** | 冷启动 116s → ~40s；暖运行已 ~0 | 限流风险 > 收益；磁盘记录已去重 | 低价值，暂缓 |
| P2 | **章节审阅换非推理/小模型** | 平均 83.7s/节主要是模型推理延迟（prompt 仅 4.8k chars）；换快速模型可能 3-5× | verdict/finding 质量；必须先 A/B 对照 | 配置化（按 stage 选模型） |
| P2 | **章节 prompt 预算收紧**（其它节摘要截断） | 平均 84s 中上下文规模占比小，收益有限 | 上下文缺失可能漏报；需 A/B | `ReviewContextBuilder` |

**本轮已顺手修复的确定性性能 bug**：语义核验上限此前按"处理条数"计——
57 条零模型短路也会占 30 条额度（两轮才能刷新完）；现改为**只约束模型调用**，
确定性短路全部免费完成（`verifyClaims` modelBudget 语义）。

## 7. 复现方式

```bash
# 冷启动全量（全新 workspace）
PROJECTS_ROOT=<empty-dir> PAPERTEAM_PORT=3210 node backend/dist/index.js
# → POST /api/projects → POST paper/pdf（D:\Tmp\paper.pdf）→ POST workflows kind=existing_paper_review
# → 完成后读 workflow/runs/<runId>/checkpoint.json 的 stageHistory + stageResults telemetry
```
