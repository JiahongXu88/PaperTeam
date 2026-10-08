# M13.1 Codex handoff — P1 file-backed reliability

## Batch 2 — Durable Figure insertion（2026-10-08）

基线 `main == origin/main == 9bd2fbc8cdf2784edb6f8d99257ac9b3c0241286`，工作区干净。沿用 `DATABASE_DECISION = NO_GO`。本批没有修改真实论文文件、启动 ECS 或调用模型。

### 状态模型与不变量

`manuscript/figs/generated/insertion-intent.json` 是每项目单条 write-ahead intent。`pending` 在第一项业务写入前原子持久化，包含规范化请求指纹、目标 `.tex` 路径、目标文件及可选 `main.tex` 与 Figure manifest 的前后 SHA-256、预期内容、修订号和原响应。`complete` 只在 Manuscript、graphicx、manifest lineage、派生 Visual Inventory 全部写入后记录。新操作覆盖上一条已完成的 receipt；不引入通用事务引擎。

`FigureService.insert/generate/list/get` 在共同的项目级进程内锁下先恢复 pending 操作。恢复对所有业务文件先做全量指纹预检：只接受原始状态或本次操作的目标状态；任何第三种状态返回 HTTP 409 `FIGURE_RECOVERY_REQUIRED`，保留现有字节，不自动回滚。随后只补写仍处于原始状态的文件，重建 `manuscript-visuals.json`，最后标记 intent complete。单文件写入继续走原有 tmp+fsync+rename。inventory 是派生视图，恢复时从当前 Manuscript 重建。intent 写入前崩溃意味着业务文件尚未写；intent 写后任一边界崩溃由下一次 Figure API 调用恢复。恢复失败保持 pending，阻断后续 Figure 操作。

append 使用稳定请求指纹和 receipt 返回相同成功响应；因 label 在 intent 中提前确定，目标文件写后重试不会重新分配 label。即使较晚再次请求且 receipt 已被新操作覆盖，manifest 的 `insertedIn` 也阻止同一 figId 再 append。replace 在写前计算新旧图完整 lineage，保持目标环境的位置和 label；如果 manifest 对该 slot 声称的旧图与手稿资产不同，则阻断。重新编译同一图时保留现有 `insertedIn/supersededBy`，避免另一路生成操作抹掉 lineage。目标为 `main.tex` 时 graphicx 与目标变换合并为一次写入，避免旧 main 内容覆盖 Figure。

现有 Scope、来源/数据陈旧、caption truthfulness 与作者确认检查仍在准备 intent 之前执行；HTTP 请求字段保持兼容，不要求前端 idempotency key。`FigureStore.loadManifest` 仅将 ENOENT 当作空 manifest，其他读取错误上抛。

### 故障注入与验证

- 定向 Figure HTTP 测试：append 在 target/main/before-manifest/manifest/before-inventory/inventory 边界，replace 在 target/before-manifest/manifest/before-inventory/inventory 边界注入异常；写入前的故障点注入模拟 `EIO`。每次使用重新构造的 FigureService 重试并检查 Figure 环境仅一次、manifest lineage、graphicx 和 Inventory。
- 独立 Node 子进程通过 `vite-node` 运行真实 `FigureService.insert()`，目标 `.tex` 写后 `SIGKILL`，父进程从磁盘 pending intent 恢复。同一请求重复调用返回相同 label。测试用环境开关只在 `NODE_ENV=test` 生效。
- append 与 replace 的故障后外部手稿编辑均返回 `FIGURE_RECOVERY_REQUIRED`，不覆盖编辑、不伪造 lineage；连续两次 replace 验证旧→中→新链。
- Windows 本地：`test/figures/figureHttp.test.ts` 25/25 PASS；Figure + Manuscript 定向回归 11 files / 160 tests PASS（其中原有 figureReal smoke 执行了 3 次小型 TeX 编译）；backend typecheck PASS；`git diff --check` PASS。`EXCEPTION_RECOVERY_PASS`、`PROCESS_RESTART_RECOVERY_PASS`、`ABRUPT_PROCESS_TERMINATION_PASS` 均有测试证据。Linux 结果以本批最终 commit 的 CI 为准。

修改文件：`backend/src/figures/{FigureService,figureStore,insertionRecovery}.ts`、`backend/src/errors.ts`、`backend/test/figures/{figureHttp.test,figureCrashChild}.ts`、本 handoff 与 `docs/PROJECT_STATUS.md`。

边界：项目锁只覆盖本进程 FigureService；其他 Manuscript 工作流、外部编辑器及跨进程写入不共享该锁。恢复采用前后哈希检测，能阻断已发生的额外修改，但不能提供跨进程原子 compare-and-swap。已完成 receipt 仅保存最近一笔；旧请求在后续操作后不会保证返回旧成功响应，但同一 figId 不会重复 append。电源断电后的目录 rename 持久性、跨进程同时写、完整生产 Docker 路径和真实服务器均未验证。本批因此是受控单进程架构下的 Figure 恢复机制，不宣称跨进程事务隔离。

Doctor CI timing flake：待 Figure CI 收口后调查；若未调查，标记 NOT VERIFIED。下一步 Claude 应先核对最终 CI / Linux Integration，然后处理 doctor timing flake 与 `RevisionStore.restore` 静态风险评估，不展开第二套恢复框架。

Git commit 与 CI run：待推送后补记；提交无法在自身内容中准确记录最终 SHA，以 Git 历史和最终汇报为准。

- 日期：2026-10-08。开始 SHA：`0673e08140cae0a672463e16ac7ed6c1164180f3`；开始时 `main == origin/main`，工作区干净。
- 架构决策沿用 M13.0：`DATABASE_DECISION = NO_GO`，继续 File-backed Storage。

## 已完成：EvidenceStore 前向兼容

`EVIDENCE_STORE_FORWARD_COMPAT = PASS`。Root Cause：`loadAll()` 跳过当前版本无法识别的 JSONL 行，但 `updateVerification()` 和 `markUsage()` 把可识别记录数组全量序列化，导致这些行在一次普通更新后被静默物理删除。可识别记录的未知字段原本由 `JSON.parse` 对象及对象展开保留。

- `backend/src/evidence/EvidenceStore.ts`：读取时保留原始行与可识别记录的行号；更新只替换目标行，其他行原样写回。当前无法识别的行仍不进入 `get/list/query/stats` 的业务记录集合，不能凭未知状态绕过当前判断。可解析但状态未知的记录 ID 参与下一条 canonical `E###` 分配，避免撞号。既有 `verificationStatus` 更新校验、source/provenance 字段、队列及原子写保持原有路径。
- `backend/test/evidence/EvidenceStore.test.ts`：覆盖未来顶层及嵌套字段、未来状态行、损坏行，经读取、两次更新、落盘、重新加载后的保持和隔离；验证后续 ID 不与未来状态记录撞号。修复提交：`1474bb9`。
- 验证：`EvidenceStore.test.ts` 10/10 PASS（单 worker）；backend `typecheck` PASS；`git diff --check` PASS。未执行全量 Vitest、Docker、真实模型/服务器测试。

## Figure 插入一致性：DEFERRED（源码审计，非验收通过）

`FigureService.insert()` 依次原子写目标 `.tex`、可选 `main.tex`、`FigureStore.recordInsertion()` 的 manifest、`manuscript-visuals.json` 派生清单。单文件原子性和项目内队列存在，但多文件序列没有持久 intent、补偿或启动恢复。目标 `.tex` 写后中断：append 重试若无显式 label 可分配新 label 并重复插入；replace 重试会再替换同一位置，但 manifest 尚未标记旧图 `supersededBy`。manifest 写后中断：派生清单过期；简单回滚可能覆盖已完成的并发或后续编辑。PDF 资产在插入前检查且由 FigureStore 管理，本轮未发现插入路径写新的 PDF。

建议 Claude 下一步：设计小型持久 intent/恢复点或幂等对账，先定义以手稿内容、manifest lineage 和资产存在性为依据的恢复规则；覆盖 append/replace 在各写入边界的故障注入、重试、旧图 lineage 与既有插入保护。`main.tex` 和派生清单也须纳入恢复。保留现有 Revision Scope、Fact、Citation、Evidence Guard。不要把仅有异常捕获的内存回滚当作崩溃恢复。

## 状态与后续

- Doctor CI flake 未审计（可选任务）。Evidence 记录若含无法解析的残缺 ID，无法据此分配下一 ID；跨进程并发仍是 M13.0 已登记的架构边界。未检查现有用户数据，也未启动服务器。
- CI 状态：代码及首版 handoff 提交 `02152b0` 的 [CI run 37755159341](https://github.com/JiahongXu88/PaperTeam/actions/runs/37755159341) 与 [Linux Integration run 37755159401](https://github.com/JiahongXu88/PaperTeam/actions/runs/37755159401) 均为 Success。本文档状态补记提交会重新触发 CI，其结果应以最终 HEAD 的 Actions 页面为准。
- 最终 Git SHA：本文件所在的 handoff 提交（`git rev-parse HEAD`；提交无法在自身内容中写入自身 SHA）。代码修复 SHA：`1474bb9`。
