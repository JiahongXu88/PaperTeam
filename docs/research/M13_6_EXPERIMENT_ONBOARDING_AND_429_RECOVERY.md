# M13.6 — Experiment Data Auto-Onboarding & Rate-Limit Recovery

- 日期：2026-10-10
- 分支：main（直接实施）；本轮 5 个提交 `a00fdf5 → 2712b13 → 1644314 → 9945119 → 2b09bda`
- 范围：实验数据包自动兼容与低操作成本使用（Phase 1）、学术元数据核验 429
  自动恢复与字段修复（Phase 2）、回归 / 真实项目 / 浏览器验收（Phase 3）
- 私有验收报告（真实项目截图与细节）在 `D:\Reports\PaperTeamRuns\M13_6`，
  不入仓库

---

## 1. Phase 1：实验数据使用体验

### 1.1 真实项目 Workflow Context = 0 的确认

真实项目 `p-14afa81bd7fa` 的 A2e 包（`ep-9fa6ff16…`，25 文件 / 36 观测）
停留在 schema v1：`rebuild()` 时代的「组内 split 不一致整组判 conflict」把
main 组锁死，且 v1 包只在作者编辑文件分类后才会 rebuild；确认（confirm）
与授权（workflowUse）是两个独立操作，作者面对「有冲突」没有任何不改数据的
出口。与任务描述完全一致。

### 1.2 v1 → v2 自动兼容（`ensureSchemaUpgraded`）

- 触发点均为显式动作（不在普通 GET 里做副作用）：实验数据页加载时
  （列表含 v1 → 前端自动 POST `/ensure-upgraded`，每会话一次）与论文工作流
  启动前（`POST /workflows` 运行前检查，best-effort 不阻断启动）。
- 确定性 + 幂等：升级 = 用当前规则 rebuild 派生结构；原始 ZIP、Source ID、
  hash、文件分类与数值逐字保持（真实项目升级前后 36 条观测逐条一致，
  packageHash 不变）；重复调用与重启后均 no-op。
- 旧确认保守映射：仅当重建后无冲突、观测内容签名（锚点 + 数值序列）与升级
  前一致、且恰好单一范围（或无观测组）时，v1「整组确认 = 进入工作流」语义
  映射为 scope confirmed + allowed。多范围 / 内容变化 / 出现冲突 → 保持待
  确认并给出原因（真实项目 main 组三范围全部回到待确认，未偷偷放行）。
- 显式「重新整理分组」保留为高级诊断 / 恢复操作。

### 1.3 「确认 + 授权」合并为一次作者操作（`applyWorkflowUse`）

新交互链：上传 → 自动解析 → 自动分组与检查 → 「用于当前论文」汇总选择 →
一次提交。服务端仍走正式状态机（不是前端隐藏按钮）：

- `POST /:packageId/use-for-paper`：`groupIds`（单范围组）+ `scopeIds`
  （多范围组的范围）= 确认 + 授权合一；`excludeScopeIds` 显式取消授权，
  立即生效于后续 run。先整体校验后应用（任一目标非法整批拒绝，无半应用）。
- 普通单范围、无冲突组在 UI 默认勾选（上传意图 = 默认写作使用意图），
  一次点击完成全部手续；多范围组逐范围勾选（Dev25 / Confirmation13 /
  Full38 必须显式选择，不因同包其它范围被选中而放行）；有冲突 /
  unknown 范围继续显式提示，冲突范围不可勾选。
- 未选中范围保持 undecided（不进入上下文，也不标成明确排除）。

### 1.4 科学真实性边界（未放宽）

- 四层概念继续分离：已上传 ≠ 机器检查通过 ≠ 允许用于本文 ≠ Verified
  Evidence。快捷确认只合并 1→3 的操作成本，不把上传等同于核验。
- Fact Guard / Evidence Guard / Citation Guard / workspace 文件隔离 /
  held-out 隔离全部保留；`workflowContext` 仍是结构化注入的唯一入口。

### 1.5 Agent 口径一致（NB-11 / NB-6 收口）

- **数值级**（Experiment Context，授权观测表 + 数值纪律）：Researcher（既有）、
  **Outline Planner（新）**、Writer（既有）、**Revision（新）**。大纲 / 摘要
  与正文遵守同一数值纪律——摘要不再能写正文禁写的自述数值。
- **政策级**（Experiment Policy，范围级授权视图，无具体数值）：
  **Feasibility（新）**与**三路 Reviewer（新）**共享同一口径（哪些范围可用、
  哪些不可用、零授权时禁写数值）。
- **NB-6**：`POST /workflows` 运行前轮换项目空闲会话
  （`rotateProjectIdleSessions`）——旧 run 的会话历史（可能含过期授权的实验
  数值）不再泄入新 run；产品化方案，不依赖重启 backend。
- 未授权范围的既有防线不变：workspaceGuard 文件工具隔离 + 结构化上下文
  零注入。

## 2. Phase 2：429 自动恢复

### 2.1 原状定论

- 检索栈（`ProviderHttpClient`）已有成熟机制（maxRetries / Retry-After /
  退避 / 冷却 / 健康四态）——未推翻，只补一个跨栈共享冷却挂钩。
- `ScholarlyResolver`：固定 300ms 盲重试一次、瞬时错误**进缓存**、无
  provider 冷却、无取消信号——31 条引用 × 4 provider 顺序查询会对限流中的
  provider 持续加压（请求风暴），且 429 结果被缓存复用。
- bib 层 `CitationService`/`metadataProviders` 无重试层但同样无冷却感知，
  逐条 × 逐 provider 顺序轰炸。

### 2.2 新机制（`ScholarlyHttpClient` + `ProviderCooldownRegistry`）

- **Retry-After 双格式**（秒数 / HTTP-date）优先；无头时指数退避 + 有界抖动
  （500ms 基数，不再固定 300ms）。
- **Provider 级冷却**：冷却期内所有组件直接短路（零网络请求）；registry
  跨栈共享——serviceStack 把同一个 registry 接给检索栈
  （`ProviderHttpClient`）与两个 citation 服务，同一上游（Semantic Scholar /
  Crossref / OpenAlex）一边 429，另一边的请求也被短路。其它 provider 不受
  影响。
- **有界**：单请求尝试上限（默认 3）、单请求等待帽（默认 10s，超帽让位）、
  冷却帽（默认 120s）；AbortSignal 在请求与等待中全程生效（stage 取消即时
  传播）；4xx（含 404）从不重试——权威否定语义保留。
- **限流 ≠ 不存在**：`LookupOutcome.error` 携带 `errorKind`（rate_limited /
  timeout / …）；CitationIntegrityService 落盘记录
  `PROVIDER_ERROR + providerError.kind + retryNotBefore`（重试资格与下一次
  可重试时间），NOT_FOUND 判定不受限流污染。
- **缓存纪律**：瞬时失败不进查询缓存（429 结果不能长期复用）；磁盘层
  PROVIDER_ERROR 记录本就不复用（下次核验自动补查）。
- **恢复 pass**：`verifyMetadata` / `CitationService.verify` 首轮后，因限流
  失败的条目若冷却结束时间落入预算（默认 60s）→ 等待后**只补查这些条目**
  （成功验证过的条目不重查、NOT_FOUND 结论不被覆盖）；超预算如实返回
  PROVIDER_ERROR。不要求重跑全部 Research。

### 2.3 元数据字段修复（真实 Run 26/31 未核验的主因）

- **OpenAlex 标题 = `display_name`**（旧 `title` 字段已弃用且真实返回为
  null——此前所有 OpenAlex 候选被 hasTitle 过滤光，贡献大量假 not_found）；
  venue 走 `primary_location.source.display_name`（host_venue 兜底）。
- **Crossref `container-title` 是数组**（旧代码按 string 读 → venue 恒缺）。
- **DOI 精确命中但响应缺标题**：按 DOI 存在性 verified 并如实标注「未做
  标题比对」（不虚构标题、不放弃权威命中）；标题检索候选全部缺标题 →
  unverifiable（不能声称 not_found）。不降低任何真实性标准：mismatch /
  ambiguous / not_found / provider_error 区分保留。
- 真实无公开出处的条目（如 MRG-DTM）继续如实未验证，不生成虚假文献信息。

### 2.4 可观测性

日志与 stage 结果可回答：谁被 429（`[scholarly-http] <provider> 429 限流…`）、
尝试次数、Retry-After 值、实际等待、冷却短路次数（telemetry.cooldownSkips）、
是否切换 provider（attempts 序列）、恢复 pass 等待 / 补查 / 成功数
（`rateLimitRecovery` 进 stage result）、还剩多少未验证（byStatus）。不含
API key 或敏感载荷。

## 3. 验收摘要

| 项 | 结果 |
| --- | --- |
| 后端全量 vitest | 3025 passed / 20 skipped；唯一失败为既有 SSE flake（`sseCancelSemantics`，stash 对照在干净 HEAD 上同样失败） |
| 前端 vitest | 334 passed |
| 双端 typecheck / build | 通过 |
| 新增回归 | experiments 14（升级幂等 / 签名保留 / 一次性授权 / 原子拒绝 / policy）、citation 21（429 矩阵 / 恢复 pass / 字段修复）、frontend 4、e2e 2 |
| Browser E2E | m136 2 项 + m135 回归 4 项（隔离数据根） |
| 真实项目（p-14afa81bd7fa） | 8/8：原包可见、无需重传、自动迁移 v2、三范围分别识别、可一次性选择（UI 呈现）、未授权范围 context=0、来源锚完好、浏览器与后端一致（截图在私有报告） |
| Live smoke（≤6 次真实请求） | Crossref 命中；OpenAlex 一次 429 → 后续查询被冷却短路（零请求）；S2 error 正确分类；telemetry 完整 |
| GitHub CI / Linux Integration | 推送后核验（见 §5） |

## 4. 剩余问题

1. `sseCancelSemantics` SSE flake 为既有问题（与本轮无关，干净 HEAD 复现）。
2. 高峰期公开学术库（OpenAlex / S2 匿名档）仍可能给出超过恢复预算的长冷却
   ——此时如实 PROVIDER_ERROR，下次核验自动补查；这是诚实口径而非缺陷。
3. 会话轮换只覆盖空闲会话；run 进行中复用的会话（理论上不存在：同项目无
   并发 run）不受影响。
4. 「用于当前论文」不覆盖 zero-scope 组（文档 / 配置）——它们本就不产生
   工作流观测。

## 5. 结论

- **M13.6 COMPLETE: true**
- **EXPERIMENT_ONBOARDING_READY: true**
- **RATE_LIMIT_RECOVERY_READY: true**
- **READY_FOR_NEXT_REAL_PAPER_RUN: true**（输入侧：作者在实验页一次勾选即可
  让授权范围进入上下文；恢复侧：citation.verify 遇 429 自动等待补查。下一
  次真实 run 的 citation 成功率提升幅度待该 run 的数据证明。）
