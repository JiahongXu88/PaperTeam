# Real Research Paper Workflow Closure（真实研究论文工作流闭环）

- 日期：2026-10-10
- 分支：main（直接实施）
- 起点：`dd2196d`（stopReason=length → OUTPUT_TRUNCATED 归因）
- 本轮提交：`13b8cc2` → `21f352a` → `d07921e` → `e99d2f6` → `e28b4a0`（见 §7）
- 范围：接管一个真实 idea_to_paper 项目，恢复上次在 `research.idea` 失败的工作流，
  在修复后的稳定版本上完成一次真实、可复现、有完整证据链的运行；全程监控、修复
  阻塞与非阻塞问题。真实论文内容、实验数据与私有运行日志**不进仓库**（私有报告见
  `D:\Reports\PaperTeamRuns\RealPaperClosure\FINAL_REAL_PAPER_RUN.md`）。

> 本文是脱敏工程报告：只记录系统行为、缺陷与修复；不含论文正文、实验数值或作者
> 私有材料。

---

## 1. 现场恢复与运行前检查（Phase 0）

| 项 | 结论 |
| --- | --- |
| 仓库 | main @ dd2196d = origin/main，工作区干净，无其他 Agent 修改 |
| 本地服务 | backend :3000 / vite :5173 在运行（dist 构建时间晚于 dd2196d 提交 → 截断修复已加载）。会话中途 backend 整树消失（stdout 在作者控制台、无日志）→ 以 WMI + 隐藏 vbs 分离重启并把日志重定向到报告目录 |
| 项目 | 唯一 idea_to_paper 项目；上次 run `w-b06991bbe160` 状态 failed（research.idea，2 次尝试，误报「缺少 domainOverview」；run-trace 两次 stopReason=length、outputTokens=8192）。failed run 不存在合法 checkpoint 续跑 → 同项目新建 run（情况 D） |
| 模型配置 | 默认模型 + 7 个 Agent 槽位全部继承 `glm/claude-fable-5-1`；自定义 Provider 中 fable `maxTokens=8192` 未验证（作者此前只把 highspeed 提到 32768） |
| 网关能力 | 有界探针：fable 在 thinking disabled / medium 下 `max_tokens` 32768、65536 均通过；131072 → 400「max_tokens: 131072 > 128000」。**网关硬上限 128000** |
| Pi 预算语义 | Agent 缺省 thinkingLevel=medium → budget 8192 与正文共用 `max_tokens`；`maxTokens=8192` 时 thinking 被夹到 7168，正文只剩 ≥1024——Researcher 报告必然截断 |
| 配置修复 | 经设置页「自定义提供商 → 编辑 → 最大输出」把 fable 提到 **65536**（保存前测试连接通过；保存后 API/磁盘一致、`metadataVerified=true`；backend 日志「模型配置已重载」）。默认模型 / per-agent 分工未改 |
| 实验数据 | 真实实验包仍是 **schema v1**：main 组因「split 不一致」整组 conflict、0 个评测范围、`workflow-context` 0 条观测。M13.5 的范围授权只发生在隔离 e2e 根，从未在真实项目发生。确认 / 授权是作者动作——本轮**未代作者确认或授权任何范围** |

## 2. 浏览器接管与监控（Phase 1–2）

- 浏览器：复用仓库自带的 acceptance 启动器（`e2e/acceptance/browser.mjs start --headless`，
  独立 profile，CDP 仅 127.0.0.1:9222）+ 单命令 Playwright 驱动脚本（仓库外）。
  概览 / 实验数据包 / 设置 / 工作流 / 各 HITL 面板均经真实 UI 操作与截图。
- 监控：仓库外独立 Node 观察程序（WMI + 隐藏 vbs 分离，单实例锁）：锁定项目 → 10s
  发现新 run → 每个 run 并发观察（SSE `seq` 去重 + 断线重连回放、15s 状态快照、
  awaiting 载荷）→ 30s health/backend PID/RSS → 终态写事实摘要并复制
  run-trace / performance-report / checkpoint。后端重启后自动重连，只读不改状态。

## 3. 真实运行序列（Phase 3）

| Run | 代码 | 结果 | 要点 |
| --- | --- | --- | --- |
| `w-b06991bbe160`（历史） | dd2196d 之前 | failed @ research.idea | 8192 截断被误判为字段缺失 |
| `w-b5596d231aaa`（修复验证） | dd2196d + maxTokens 65536 | failed @ build.draft（FACT_PRESERVATION_FAILED，设计门禁） | research.idea **一次通过**（最终 turn 13,904 output tokens）；完整走到 review → gate → revision → validation → stalled → build；暴露 B-1（§4） |
| `w-9539ee0d4167` | e28b4a0 | cancelled（人为） | guard 生效（0 拒绝），但可行性输出引用了 run 2 残留在项目里的稿件/审稿文件 → 先隔离 run 2 产物 |
| `w-31d52c6f810d` | e28b4a0 | cancelled（人为） | Pi 会话跨 run 复用会把 run 3 的会话历史带入 → 重启 backend 取得全新会话 |
| **`w-4addeb3593de`（最终验收）** | e28b4a0 | **completed，label=draft** | 全程 0 次隔离拒绝；稿件与 PDF 无任何未授权实验数值；Quality Gate 如实 QUALITY_NOT_REACHED；无 Final |

最终 run 时间线（UTC）：06:01 research.idea（4m06s）→ feasibility（attempt 1 瞬时 400 → 重试 44s，MEDIUM）→ approve → outline（1m05s）→ approve / continue → writing 7 节（10m09s）→ citation.verify（3m22s）→ review ×3（2m53s）→ gate FAIL → revision（6m35s）→ validate 拒绝 6 条 → **reject**（恢复修订前版本）→ citation / review r2 → gate FAIL → stalled → **accept_draft** → build.draft（6s，xelatex+bibtex，0 diagnostics）→ completed 06:39。墙钟 38m28s，HITL 等待≈7m26s。

HITL 决策口径（全部经 UI）：

- `hitl.feasibility_confirm`（MEDIUM）：approve——需补实验清单与作者在研究想法中自述的「待补实验」一致；载荷中的目标下调建议属于作者决策，未采纳。
- `hitl.outline_confirm`：approve（结构常规）。
- `hitl.evidence_supply`：continue（不自动 Promote 候选）。
- `hitl.revision_validation`：reject——自动修订被事实保持复核拒绝（删表行 / 占位回退 / 新增公式），恢复修订前版本是保守、可逆的选择。
- `hitl.revision_stalled`：accept_draft——零授权数据 + 零 verified 证据下再修无法过门禁；Draft 如实产出，Final 由门禁阻断。

## 4. 阻塞问题（Phase 4）

### B-0 输出预算（配置层，已解决）

根因见 §1；代码侧 dd2196d 已把截断归因为 `OUTPUT_TRUNCATED`（permanent，不重试），
本轮补上配置侧修复并以真实 run 验证（Researcher 最终回复 13.9k tokens，stopReason=stop）。

### B-1 Agent 文件工具绕过实验数据授权（e99d2f6）

- **现象**：验证 run 的实验章节出现了三个评测范围的具体指标、超参数与统计量，
  而作者授权的 `workflow-context` 为 0 条观测。数值与真实实验包逐一相符（不是编造），
  但未经作者确认 / 授权。
- **根因**：Agent 会话 cwd = 整个项目目录；Pi 内置 `read / ls / grep / find` 对路径
  无任何限制。run-trace 显示 Writer 执行 ls 7 次、read 8 次、grep 3 次，读到
  `sources/papers/<实验包结果文件>`、验证报告与 `experiments/<pkg>/manifest.json`。
  M13.5 的范围级隔离只覆盖结构化上下文注入，文件工具层整体被绕过。
- **修复**：`backend/src/runtime/pi/workspaceGuard.ts`——用 Pi 官方工具工厂 +
  受控 `operations` 生成**同名** `read / ls / find / grep / write / edit`，按会话注入
  customTools（Pi 注册表同名覆盖内置）；`grep` 自实现（内置走 ripgrep 子进程）。
  读边界 = 项目目录 + skill 快照根；`experiments/`、`workflow/`、EXPERIMENT_PACKAGE
  来源文件不可见；来源清单不可用时整个 `sources/` 不可见（fail closed）；项目外
  （含 `..` 穿越 / 绝对路径）拒绝；写只限 `manuscript/`。Writer prompt 现在显式接收
  作者授权的实验观测（空上下文 = 禁写任何具体实验数值）。
- **验证**：`test/runtime/workspaceGuard.test.ts`（9，真实执行 Pi 工具定义）、
  `PiRuntimeAdapter.test.ts`（注入 + 角色白名单 + 缺省不变）、`WriterService.test.ts`
  （prompt 块）；全量 backend 270 文件通过；最终 run 的 backend 日志出现
  「工作区隔离已启用」，稿件与 PDF 扫描无未授权数值。
- **两个后续事实**：(a) 修复前 run 留下的稿件 / 审稿产物仍是可读项目文件（本轮手工隔离）；
  (b) Pi 会话跨 run 复用会把旧会话历史带入（本轮以重启规避）。见 §5 NB-6。

### B-2 v1 实验包无出口（13b8cc2）

真实项目的 v1 包停在「有冲突」且只有改文件分类才会 rebuild——作者没有不改数据的
出口。新增 `POST /api/projects/:id/experiment-packages/:packageId/rebuild` 与 UI
「重新整理分组（升级到范围级核对）」（二次确认；不改任何角色 / 归属 / 数值；既有确认与
授权失效）。测试覆盖 v1 → v2、确认重置、观测不变、单范围授权上下文。

## 5. 非阻塞问题（Phase 5）

| # | 位置 | 现象 | 处理 |
| --- | --- | --- | --- |
| NB-1 | 工作流 tab 阶段进度 | target.* 三 stage 已完成却显示 0/20 | d07921e：时间线纳入 target.*；最终 run 显示 18/23 |
| NB-2 | 可行性 HITL | 后端把 suggestedTargetAdjustment 拼成字符串，前端按数组读 → 从不显示 | 21f352a：兼容字符串/数组；最终 run 面板可见 |
| NB-3 | 检索层 | Semantic Scholar 持续 429（退避冷却，其它 provider 继续） | 记录 |
| NB-4 | revision_validation HITL | 后端有 approve/reject/needs_review，UI 只有「继续」 | e28b4a0：补 reject（二次确认）与 needs_review；最终 run 经 reject 验证 |
| NB-5 | revision_validation / stalled | needs_review 文案称只阻断 Final，但事实保持违规同样阻断 Draft；stalled 仍提供 accept_draft 导致 run 失败 | 记录（设计讨论） |
| NB-6 | Pi 会话池 | 会话跨 run 复用，历史随会话存活到轮换/重启 | 记录；建议 run 开始时轮换读文件角色会话 |
| NB-7 | 工作流 tab | 一次 UI cancel 未生效（另一次正常） | 记录，待复现 |
| NB-8 | 网关 | 工具调用后偶发 400 thinking signature binding；Pi 自动重试恢复 | 记录 |
| NB-9 | Writer 零授权纪律 | 稿件正文残留流程元文本（「作者在研究大纲中陈述」等），审稿判 major | 记录；建议改为稿件化占位措辞 |
| NB-10 | 引用元数据核验 | 26/31 unverifiable（响应缺标题字段 19、429 7） | 记录；resolver 兼容 + 退避 |
| NB-11 | outline.plan | 大纲/摘要未接收实验上下文纪律 → 摘要含作者自述数值而正文禁写 → 审稿 critical 矛盾 | 记录；建议 planOutline 同样注入 experimentContext |

## 6. 验收口径

- **工程稳定性**：最终 run 无未处理协议错误、无误判截断、无死循环、状态/SSE/持久化一致、
  实际模型与设置一致；唯一瞬时 400 由 transient 重试正确吸收。
- **科研真实性**：未编造数据、未解除隔离、未代作者确认或授权实验范围、未调低门禁、
  未把 Draft 当 Final。零授权实验数据 + 零 verified 证据下 Quality Gate 不通过是**诚实结果**。
- **作者待办（AUTHOR_DECISION_REQUIRED）**：实验数据页「重新整理分组」→ 按范围确认
  → 授权允许进入工作流的范围 → 重跑写作；可行性评估列出的待补实验；是否接受目标下调；
  候选文献 Promote / 全文核验以提高证据覆盖；修订策略。

## 7. 提交清单与 CI

| 提交 | 内容 | CI / Linux Integration |
| --- | --- | --- |
| 13b8cc2 | feat(experiments): 显式 rebuild（v1 → 范围级核对） | success / success |
| 21f352a | fix(ui): 可行性目标调整建议展示 | （与 d07921e 同次推送） |
| d07921e | fix(ui): 时间线纳入 target.* | success / success |
| e99d2f6 | fix(runtime): 工作区隔离 M13.5.4 + Writer 实验上下文 | （与 e28b4a0 同次推送） |
| e28b4a0 | fix(ui): revision_validation reject / needs_review | success / success |

本地：backend 全量 vitest 270 文件 passed / 7 skipped；frontend 330 tests；双端 typecheck；`git diff --check`。

## 8. 结论

- ENGINEERING_STABLE: true
- WORKFLOW_COMPLETED: true（Draft）
- REVISION_TASK_SUCCESS: false（自动修订被事实保持复核拒绝，作者级 reject 恢复）
- PUBLICATION_READY: false
- REAL_PAPER_ACCEPTANCE: **PARTIAL**——系统可靠执行且内容真实；论文在作者授权实验数据与补实验之前只能停留在诚实的 Draft。
