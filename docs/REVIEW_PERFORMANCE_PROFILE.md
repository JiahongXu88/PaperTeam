# Review 性能画像（2026-09-07 实测；2026-09-08 并发优化后更新）

> 诊断数据来源：
> 1. **冷启动全量运行**（2026-09-07 优化前基线）：真实论文（26 页 / 36 节 / 25 条引用 / 63 条 claim-citation），
>    全新 workspace，模型 `zai-coding-cn/glm-5.3`，阶段耗时与调用画像来自 run checkpoint
>    （stageHistory startedAt/finishedAt + stageResults 内新增 telemetry）。
> 2. **用户日常运行**（对照）：同一论文在上一个 workspace 的最近一次 completed run。
> 3. **并发优化后**（2026-09-08）：同一论文、同一模型，`scripts/benchmark-review.mjs`
>    真实 A/B（1/2/3/4 × 前 12 节）+ 全量 33 节验证。

> **2026-09-08 起引用语义核验默认关闭（CitationSemanticMode，见
> API_CONTRACT / PRD）**：新 Review 缺省 `off`——`citation.claims` stage 不再
> 进入，上表中的 citation.claims 行与"6 次语义 judge"调用在默认配置下为 0。
> 需要注意：**关闭语义核验不会解决 Review 的最大性能问题**——按本画像，
> citation.claims 仅占 3.1%（冷）/ 2.0%（暖），且其中 57 条 INSUFFICIENT_
> EVIDENCE 本就是零模型调用的确定性短路，真实省掉的只有 6 次 judge
> （≈99.6s 冷启动）。**最大瓶颈仍然是 `review.sections`（85.9%）**。本功能的
> 目的定位是：减少非必要的 Citation Audit、降低信息噪音、贴合真实科研
> Review 使用习惯，而非加速。`contradiction_only` 模式的 judge 调用次数与
> `full` 相同（只有拿到真实证据的 claim 才调用），变化只在判定口径与报告
> 噪音。

## 0. 优化后速览（2026-09-08，并发化落地）

| Stage | 优化前 | 优化后（C=3 全量实测） | 加速 |
| --- | ---: | ---: | ---: |
| paper.ensure | 317.6s | 127.6s | 2.5×（章节摘要并发 3） |
| citation.metadata | 36.3s | 23.3s | —（未改；当日网络更快） |
| citation.claims | 99.7s | 99s | —（按纪律不动） |
| **review.sections** | **2763.8s（串行）** | **985.3s（并发 3）** | **2.81×** |
| review.aggregate | <1s | <1s | — |
| **Total** | **3217.5s（53.6 min）** | **1234.6s（20.6 min）** | **2.61×** |

优化后全量 run：33/33 节完成、0 失败、0 重试、0 次 429；156 条 findings
按论文顺序输出（并发完成顺序乱序，最终输出确定性有序）；每节完成即写
per-section journal（`paper/review-sections/<runId>/<sectionId>.json`，33 个文件）。

## 1. 冷启动全量运行（优化前基线，2026-09-07）

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

## 6. Review 并发 Benchmark（2026-09-08 真实 A/B）

方法：`scripts/benchmark-review.mjs --levels 1,2,3,4 --limit 12`（每档独立
backend + 独立 PROJECTS_ROOT 命名空间；首档冷启动后，后续档复制 paper-map +
citation 产物预热，把测量窗口隔离到 review.sections；同一批固定代表章节
= 文档前 12 节；模型 `zai-coding-cn/glm-5.3`）。

| C | wall(s) | speedup | sum(s) | 单请求 avg(s) | p95 排队(s) | maxObserved | 重试 | 429 | 失败 |
| --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| 1 | 1086 | 1.00× | 1086 | 90.5 | 940 | 1 | 0 | 0 | 0 |
| 2 | 567 | 1.92× | 1116 | 93.0 | 474 | 2 | 0 | 0 | 0 |
| 3 | 364 | 2.98× | 1016 | 84.7 | 270 | 3 | 0 | 0 | 0 |
| 4 | 303 | 3.58× | 1127 | 93.9 | 209 | 4 | 0 | 0 | 0 |

全量验证（C=3，33 节，冷启动端到端）：review.sections 985s（sum 2674s，
有效并发 2.71×）、run 总时长 1234.6s、33 calls / 0 失败 / 0 重试、
findings 156 条按论文顺序、journal 33 文件。

### 默认并发度 = 3（`PAPERTEAM_REVIEW_CONCURRENCY`，范围 1-8）

选择依据（不只看 wall time）：

- C=1→2→3 近乎线性加速（1.92× / 2.98×），且 **C=3 的单请求平均延迟最低**
  （84.7s < 基线 90.5s）——provider 侧零排队迹象。
- C=4 在 12 节窗口内再快 17%（364→303s），但单请求平均延迟升到四档最高
  （93.9s，比 C=3 高 10.6%）——provider 侧串行化的第一个信号；且 12 节零
  429 不能证明 33 节持续压力下的稳定（本轮无重复采样，10% 级差异在噪声内）。
- 按「速度 + 429 + 失败率 + p95 + 稳定性」的综合标准，C=3 是带安全余量的
  甜点；需要极限速度的用户可显式设 `PAPERTEAM_REVIEW_CONCURRENCY=4`。

## 7. 并发化实现要点（2026-09-08）

- `util/concurrency.ts` 的 `mapWithConcurrency`：固定 runner 池，任务开始受
  limit 约束（backpressure：不是先建 N 个 Promise 再压住）；worker 异常不
  泄漏 permit、不传染其它节；AbortSignal 停止调度并等 running settle；
  结果按输入顺序（执行顺序不确定，输出确定）。
- `paper/SectionReviewScheduler.ts`：每节独立 contextScope（`review/section/<id>`
  → 独立 Pi session，sessionKey = projectId × agentId × scope）；节内 3 次
  退避重试（429/503，可被取消信号打断）；单节最终失败 → failedSections、
  其余节继续；全部失败才 transient 上抛；取消时 queued 停止派发 + active 经
  signal→AgentRunHandle.cancel() 协作式中断。
- per-section journal：一节一文件原子写（无共享 read-modify-write，并发天然
  安全）；stage 重试 / 崩溃恢复（同 runId）按指纹复用已完成节，零模型调用。
- PaperMap 摘要（paper.ensure）同样并发（`PAPERTEAM_SUMMARY_CONCURRENCY=3`，
  复用同一原语）；citation 链路按纪律不动。
- telemetry（run checkpoint 持久化）：maxObservedConcurrency / sections* /
  queueWaitMs p50-p95 / reviewSectionsWallMs vs sumSectionDurationMs / 429
  启发式计数；进度事件从「第 N 节」改为「已完成 N / total」。

## 8. Performance Optimization Backlog（剩余项，未实施）

> P0「Section Review 有界并发」与 P1「PaperMap 摘要有界并发」已于 2026-09-08
> 落地（见 §6/§7），从 backlog 移除。

| 优先级 | 项 | 预计收益 | 风险 | 改动范围 |
| --- | --- | --- | --- | --- |
| P1 | **证据预取（abstract enrichment）**：crossref 命中但无 abstract 时补查 OpenAlex/S2 摘要 | 产品价值 > 性能：57 条 INSUFFICIENT_EVIDENCE 大部分可转为真实 verdict；顺带提升语义核验覆盖率 | +20 次外部查询（~25s 串行）；provider 限流 | `CitationIntegrityService.verifyScholarlyReference`（+1 步 enrichment） |
| P1 | **语义 judge claim batching**（多条 claim 一次判定，仅同 reference 同证据） | 当前只 6 次调用，收益小；证据预取落地后放大 | verdict 归因正确性（需逐条校验）；中 | `semanticVerifier` |
| P2 | **metadata 并行 / 持久 resolver 缓存** | 冷启动 ~23-36s；暖运行已 ~0 | 限流风险 > 收益；磁盘记录已去重 | 低价值，暂缓 |
| P2 | **章节审阅换非推理/小模型（model routing）** | 平均 81-94s/节主要是模型推理延迟（prompt 仅 ~4.9k chars）；换快速模型可能 3-5× | verdict/finding 质量；必须先 A/B 对照 | 配置化（按 stage 选模型） |
| P2 | **章节 prompt 预算收紧**（其它节摘要截断） | 平均延迟中上下文规模占比小，收益有限 | 上下文缺失可能漏报；需 A/B | `ReviewContextBuilder` |
| P2 | **C=4 默认值再评估**（多采样 + 全量持续压力数据后） | 12 节窗口 C=4 比 C=3 快 17%；若持续压力下 429 仍为 0 且 avg 延迟不涨，可上调默认 | provider 限流；单采样证据不足 | 只改默认值 |

**2026-09-07 顺手修复的确定性性能 bug**：语义核验上限此前按"处理条数"计——
57 条零模型短路也会占 30 条额度（两轮才能刷新完）；现改为**只约束模型调用**，
确定性短路全部免费完成（`verifyClaims` modelBudget 语义）。

## 9. 复现方式

```bash
# 并发 A/B（前 12 节，1/2/3/4 四档；结果写本地临时目录 pt-benchmark/<ts>/）
node scripts/benchmark-review.mjs --levels 1,2,3,4 --limit 12
# 全量 33 节单档验证（冷启动端到端）
node scripts/benchmark-review.mjs --full --concurrency 3
# 手动单跑（全新 workspace）
PROJECTS_ROOT=<empty-dir> PAPERTEAM_PORT=3210 PAPERTEAM_REVIEW_CONCURRENCY=3 node backend/dist/index.js
# → POST /api/projects/import-pdf（<本地论文 PDF 路径>）→ POST workflows kind=existing_paper_review
# → 完成后读 workflow/runs/<runId>/checkpoint.json 的 stageHistory + stageResults telemetry
```
