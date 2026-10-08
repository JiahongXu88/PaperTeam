# M13.1 Codex handoff — P1 file-backed reliability

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
- CI 状态：待 push 后核验。
- 最终 Git SHA：本文件所在的 handoff 提交（`git rev-parse HEAD`；提交无法在自身内容中写入自身 SHA）。代码修复 SHA：`1474bb9`。
