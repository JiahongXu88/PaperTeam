# M13.0 — Storage Architecture Assessment（数据库存储架构只读评估）

> **日期：2026-10-08。执行：Claude Code。基线：`30964ed`（M12 Batch 3 收口）+ 本轮 M12 收口文档提交。全程只读静态分析 + 真实数据目录测量；不修改任何业务 Store，不安装数据库，不启动 ECS，不在 Windows 执行重型 benchmark。**
>
> **一句话结论：NO-GO —— 继续文件存储（Keep File-backed）。当前 26 个真实项目、全部元数据 store 均 KB 级（evidence 最大 2 行/2.8KB，checkpoint 32KB，events 59KB），1.5GB 体量几乎全部是任何方案都必须留在文件系统的二进制资产（PDF/解析文档/TeX）；发现的实际问题（EvidenceStore 更新类写放大、四处无补偿多文件序列、跨进程零保护）全部可以在文件侧以既有的原子写/队列/补偿模式修复，且都不构成"必须数据库"的证据。SQLite 是唯一可辩护的备选（若触发量化再评估触发器），PostgreSQL 与单用户自托管双平台定位冲突。CI events.jsonl flake（a20a528）归因 = 测试同步缺陷暴露真实异步写序窗口，不是持久化缺陷。**

---

## 1. Executive Summary（执行摘要）

核心问题：**PaperTeam 当前基于文件系统的存储设计是否仍然满足业务需求？如果需要数据库，应该选择 SQLite、PostgreSQL，还是继续文件存储？**

结论要点：

1. **规模现实**：26 个真实项目 / 1.5GB / 每项目约 270 文件 65MB；体量主体是 PDF（最大 3.6MB）、Docling 解析文档（1–3MB/篇）、TeX 与图表资产——这些在任何混合方案里都留在文件系统。**结构化元数据的真实体量是 KB 级**：evidence.jsonl 最大 2 行 / 2.8KB，candidates 15 行 / 27KB，sources/index.json 13KB，checkpoint.json 32KB，events.jsonl 59KB。
2. **架构现实**：20+ 个 store 全部共享同一套自研原语——`writeFileAtomic`（tmp+fsync+rename，Windows EPERM/EBUSY 重试）+ per-project 进程内 promise 队列。设计假设 = **单用户、单进程**（`config.ts:226-228` 明示）。零锁文件、零跨进程互斥、零数据库、零 ORM。
3. **发现的真实问题**（全部代码级定位）：EvidenceStore 更新类操作全量重写的写放大；rewrite 对不可解析行的**静默物理压实**（前向兼容隐患）；四处无补偿/无守护的多文件写序列（图表插入、RevisionStore.restore、修订条目状态、来源删除索引失效）；一批绕过 store 层的非原子裸 writeFile。**没有一个是当前已发生的数据丢失事故，也没有一个只有数据库能修。**
4. **flake 归因**：M12 Batch 3 CI 的 events.jsonl 事件持久化时序 flake（修复于 `a20a528`）= **测试等待口径缺陷暴露了真实的"终态先于事件落盘可见"窗口**——checkpoint-before-commit 是有意的崩溃安全设计，事件日志按设计滞后一步且读侧容忍。分类：测试同步问题，非异步一致性缺陷，非事务边界缺陷。
5. **决策**：**NO-GO — Keep File-backed**。附带（a）按优先级排序的文件侧加固清单；（b）量化再评估触发器（evidence >10k 条/项目、跨项目分析成为真实需求、多进程/多用户立项）；（c）届时才执行的 benchmark 设计（本轮只设计不运行）。若未来必须引入数据库：**SQLite（better-sqlite3）是唯一候选**，PostgreSQL 仅当产品转向多用户 SaaS 时重新评估。

## 2. Current Storage Architecture（当前持久化架构）

双根目录，`backend/src/index.ts:219` 装配：

- **项目工作区** `PROJECTS_ROOT`（默认 `./projects`，`config.ts:299`、`:807-812`）→ `projects/<projectId>/`，固定子树 `manuscript/ sources/ evidence/ reviews/ build/ workflow/ research/ artifacts/`（`ProjectStore.ts:134-143`）。
- **用户运行时根** `~/.paperteam`（或 `PAPERTEAM_RUNTIME_ROOT`，`config.ts:368-381`）→ `settings/`（model.json、custom-providers.json）、`skills/`、`runtime/pi/agent/`（**Pi 官方凭据 store `auth.json`——API Key 不属于 PaperTeam 业务存储**）。

共享原语（全部 store 复用，无其它公共持久化工具）：

| 原语 | 位置 | 行为 |
|---|---|---|
| `writeFileAtomic` | `backend/src/util/atomic.ts:27-45` | tmp（`.<name>.<pid>-<ms>-<单调seq>.tmp`）→ write → **fsync** → rename；M8.5 修复同毫秒 tmp 碰撞（`:19-23` 记录的 ≥4 次同毫秒写碰撞真实事故） |
| `renameWithRetry` | `atomic.ts:52-66` | EPERM/EBUSY/EACCES 退避重试 [20,60,150,400]ms（Windows AV/索引器防御） |
| per-project promise 队列 | 各 store 内 `Map<string, Promise>` | 进程内串行化；模式首见于 `ProjectStore.writeQueues`（`ProjectStore.ts:161-162`） |
| 崩溃 tmp 清理 | `sources/CandidateStore.ts:428-437` | 仅 CandidateStore 做了 stale-tmp 扫除 |
| 目录 fsync | **无** | Windows 上刻意跳过（`atomic.ts:8` 注释） |

真实数据分布（2026-10-08 实测 `projects/`）：26 项目 / 1.5GB；典型项目 113 json + 92 pdf + 26 jsonl + 17 tex + 9 bib；最大文件 = 产物 PDF 3.6MB、解析文档 1–3MB/篇、图表 PDF 1.1MB。**元数据/状态文件最大不过几十 KB。**

值得一提的既有事实：Pi 运行时自身内嵌 SQLite（`~/.paperteam/runtime/openclaw/agents/main/agent/openclaw-agent.sqlite`，实测 614KB）——嵌入式数据库在本生态是常态，但那是 runtime 自有状态，不是 PaperTeam 业务数据；业务层至今零数据库。

## 3. Store Inventory（全部持久化组件清单）

按域归类，原子性/并发/恢复三列是静态代码事实（路径:行号）：

### 3.1 项目与工作流

| 组件 | 文件/格式 | 写策略 | 原子 | 并发 | 崩溃恢复 |
|---|---|---|---|---|---|
| ProjectStore（`project/ProjectStore.ts:156`） | `project.json`（schemaVersion 1） | 全量原子重写 | ✅ | per-project 队列 `:435-460` | 损坏→项目从列表隐藏（`:245-253`）；防御性 normalize `:494` |
| WorkflowRunStore（`workflow/runStore.ts:24`） | `runs/<runId>/checkpoint.json` | 全量原子重写 `:55-59` | ✅ | 编排器单写者 | `recoverInterruptedRuns()`（`WorkflowOrchestrator.ts:375+`）重启恢复；校验 runId `:74` |
| 同上 `stages/<seq>-<stage>-a<attempt>.json` | 阶段审计记录 | 裸 writeFile `:96`（文件名含序号+尝试号，覆盖风险≈0） | ❌ | 编排器单写者 | 唯一命名=天然幂等 |
| eventLog（`workflow/eventLog.ts`） | `events.jsonl` | **append-only** `:24-27`（无 fsync） | ❌（by design） | 编排器 emitChain 单写者 | 撕裂行→跳过+计数 `:30-58`；"日志是进度记录不是判定依据"（头注 `:3-8`） |
| run-trace / performance-report | `run-trace.json` + `.md` | 原子（`WorkflowOrchestrator.ts:881-895`） | ✅ | 编排器 | 失败仅记日志（观测性数据，"如实缺失"） |

### 3.2 文献与证据

| 组件 | 文件/格式 | 写策略 | 原子 | 并发 | 崩溃恢复 |
|---|---|---|---|---|---|
| SourceStore（`sources/SourceStore.ts:303`） | `sources/index.json` + `papers/*` + `parsed/<id>.json` | 索引/解析原子；原始上传裸 writeFile `:457,:749`（只新增） | 索引✅ | per-project 队列 `:319-330` | **索引损坏→硬错误不静默清空**（`:487-497`，防历史被覆盖）；contentHash/analysisHash 陈旧检测 `:690-695` |
| CandidateStore（`sources/CandidateStore.ts:120`） | `sources/candidates.json` | 全量原子重写 `:411-419` + stale-tmp 清扫 | ✅ | 队列 `:145-156`（M8.5 P0 并发修复） | 损坏→结构化 `CANDIDATE_STORE_CORRUPTED` fail-closed `:443-451` |
| **EvidenceStore**（`evidence/EvidenceStore.ts:145`） | `evidence/evidence.jsonl` | **新增=append；updateVerification/markUsage=全量原子重写**（`:179-193`/`:310-363`/`:366-388`→`rewrite() :448-454`） | 混合 | 队列 `:161-172`（M9.4 重复 E-id 修复） | 撕裂行跳过+计数 `:408-446`；非 ENOENT 读错误上抛防重写清库 `:414-420`；**无 delete 方法** |
| EvidenceCandidateStore（`evidence/candidates.ts:115`） | `evidence/candidates.jsonl` | append `:183` + markResolved 全量原子重写 `:275` | 混合 | 队列 `:135` | 同上容错读 |
| ChunkStore（`retrieval/ChunkStore.ts:51`） | `chunks/<sid>.jsonl` + `.vectors.json` + `index.json` | 全部原子重写（`:154-158`/`:191-194`/`:110-113`） | ✅ | **store 内无锁**（`:115` 注释：调用方串行化） | 派生态：损坏→null→重建；manifest 损坏→`RETRIEVAL_NOT_READY` |

### 3.3 稿件、修订与产物

| 组件 | 文件/格式 | 写策略 | 原子 | 并发 | 崩溃恢复 |
|---|---|---|---|---|---|
| ManuscriptRevisionStore（`manuscript/RevisionStore.ts:62`） | `revisions.json`（schemaVersion 1）+ `revisions/rev-N/` 快照 | 注册表原子 `:272`；快照逐文件 copy（集合非原子） | 注册表✅ | commit/restore 队列 `:66,:114-121,:159-165` | 内容指纹幂等 `:353-362`；损坏→current:0 `:364`；孤儿 rev 目录无害 |
| ArtifactStore（`artifacts/ArtifactStore.ts:60`） | `artifacts/manifest.json` + `art-*.pdf` | copy→tmp→rename→manifest 原子（资产先行/登记殿后）`:219-249` | ✅ | 队列 `:274-282` | manifest 损坏→空（可重冻结）；冻结失败零半个产物 `:236-241` |
| FigureStore（`figures/figureStore.ts:86`） | `figs/generated/{manifest.json,*.spec.json,*.tex,*.pdf}` | manifest/spec/tex 原子；PDF 二进制原子变体 `:240-263` | ✅ | **无锁**（`:25-27`：调用方 FigureService `withProjectLock` `:142-157` 串行化） | manifest 损坏→`FigureStoreCorruptedError` fail-closed `:128-132` |
| 稿件工作区 | `manuscript/**`（.tex/.bib） | 工作流阶段裸 writeFile（`definitions.ts:1687,:2279` 等） | ❌ | 编排器阶段序 | 指纹幂等 + 快照恢复 |
| LaTeX 编译 | `build/` | `main.pdf`→`paper.pdf` rename `:276` | — | per-project `withCompileLock`（`quality/gates.ts:140-148`） | 编译日志 best-effort |

### 3.4 评审、目标与调研 artifact

| 组件 | 文件 | 原子 | 并发 | 恢复 |
|---|---|---|---|---|
| ReviewArtifactStore（`review/reviewArtifacts.ts:56`） | `reviews/*-r<n>.json` 家族 + `iteration-history.json` | ✅ 全部 writeJsonAtomic | 无锁（round 文件写一次 + 单写者） | 防御性结构读→null→重算 round |
| ReviewerService 裸写 | `reviews/review-r<n>-<mode>.json`（`agents/ReviewerService.ts:326`） | ❌ 裸 writeFile | 阶段序 | 防御读 |
| ExternalInstructionStore（`review/externalInstructions.ts:342`） | `reviews/external-instructions.json`（schemaVersion 1） | ✅ `:363-370` | **RMW 无队列无锁** `:378,:423,:456` | 防御读 |
| Target 三件套（M12.1） | `research/target-{benchmark,profile,readiness}.json` | ✅ | 无锁（单写者服务层） | 全部 fail-closed 损坏错误 |
| Survey 双 store + CorpusSnapshot | `research/{survey,survey-synthesis,corpus-snapshot}.json` | ✅ | 无锁 | fail-closed + 新鲜度封套 |
| ResearcherService 裸写 | `research/research.json`（`:200,:382,:790,:821`）、`feasibility.json`（`FeasibilityService.ts:213-217`） | ❌ 裸 writeFile 非原子 | researchLoop `withLock`（`researchLoop.ts:933-948`） | 防御读 |
| 视觉清单/门禁/引用报告 | `manuscript-visuals.json`、`build-gate.json`、`quality-gate-r<n>.json`、`citation-report.json`、`fact-authorizations.json` 台账等 | ✅ | — | fail-closed / 防御读 |

### 3.5 用户级与运行时

| 组件 | 文件 | 原子 | 恢复 |
|---|---|---|---|
| ModelSettingsStore（`settings/ModelSettingsStore.ts:158`） | `~/.paperteam/settings/model.json` | ✅ `:210-223` | 损坏→`{}` `:166-194`；无密钥（头注 `:4-7`） |
| CustomProviderStore（`settings/CustomProviderStore.ts:71`） | `settings/custom-providers.json` | ✅ `:109-113` | 坏条目跳过 `:96-106`；auth 头禁入 `:64` |
| **Provider 凭据（API Key）** | Pi 官方 `<agentDir>/auth.json`（`config.ts:89,:392-394`；写路径 `ModelSettingsService.ts:847-881`） | Pi 自有 | 不属业务库——**引入数据库不应改变它的位置** |
| SkillRegistry（`skills/SkillRegistry.ts:168`） | `skills/installed/<id>/skill.json` + 不可变 `versions/` | ✅ `:775-778` | sha256 完整性标记篡改 `:727-731` |
| Usage/Cost | **无专用 store**——进程内 `RuntimeUsageTotals`（`runtime/statusService.ts:86-87`）+ trace span 属性（`observability/trace.ts:452-454,:587-589`）随 `run-trace.json` 间接落盘 | ✅（trace） | 进程退出即失未 flush span（`trace.ts:482-484` 如实记录）；成本=牌价估算（`traceReport.ts:386`） |
| Runtime 配置 | env + `.env` **只读**解析（`config/envFile.ts:21-39`）——不持久化 | — | — |

**不存在/已澄清项**（按审计候选目录如实记录）：不存在独立 Usage 数据库表或 usage.json 台账；不存在 Search/RAG 元数据库（检索=BM25 内存 + chunk 文件 + vectors sidecar）；不存在 figure 独立数据库（manifest.json）；Target Profile 是三个 JSON artifact 不是库表；Agent Events 无 event_gap 修复机制（见 §7）。

## 4. Read/Write Access Patterns（数据访问模式）

基于真实调用点（非臆测未来需求）：

| 数据域 | 典型读操作 | 典型写操作 | 关联查询 | 并发模型 | 增长风险 |
|---|---|---|---|---|---|
| Project 列表 | 启动/刷新扫 `projects/*/project.json`（`ProjectStore.list`） | 创建/状态迁移（全量重写单文件） | 无 | 队列 | 26→500+ 项目时列表扫描线性变慢（当前毫秒级） |
| Workflow 历史 | run 目录枚举 + checkpoint 读 | checkpoint 原子重写（阶段边界/终态） | stageResults 内嵌（无跨文件 join） | 编排器单写者 | 每 run 一个目录，几十 KB；数量随使用线性 |
| Evidence lookup | `list()/query()` **全文件线性扫**（`EvidenceStore.ts:278-307`）；写作选择 cap 20（`EvidenceSelectionService.ts:95-122`）；agent 工具 cap 50（`evidence/tools.ts:220`） | append（新增）；**全量重写（每次 status/usage 变更）** | source 引用内嵌记录内；usedBy/relatedSections 内嵌 | 队列 | **写放大主风险域**（见 §8） |
| Source/Chunk 查询 | index.json 一次读入；chunk 按 sourceId 单文件读 | 索引 RMW；chunk 全量重写（重建态） | chunk→source 显式 id | 队列（chunk=调用方） | 解析文档 MB 级但已是文件；chunk 重建成本可控 |
| Reviewer findings | round 文件防御读 | round 递增写一次 | findings→claim/patch 经 id 引用，无 join 引擎 | 阶段序 | 线性、有界（每轮一文件） |
| Figure 索引 | manifest.json 读 | FigureService 串行化 RMW | specHash↔figId↔datasetHash 内容寻址 | 服务层锁 | 有界（人工生成速率） |
| Usage/Cost 统计 | trace 读 + 内存聚合 | 阶段边界 flush | span 属性 | 单进程 | 观测性数据，允许缺失 |
| 多 Agent 并发写 | — | **不同 Agent 写不同 store**（researcher→research.json、writer→稿件、grounding→evidence）：由工作流**阶段序**协调而非锁；历史竞态（M8.5 候选、M9.4 E-id）已用进程内队列修复 | — | 进程内 | 队列覆盖了全部已观测竞态 |
| **跨项目查询** | **当前不存在任何跨项目业务查询**（唯一跨项目操作=项目列表） | — | — | — | 纯未来设想 |

**当前真实需求 vs 未来可能需求**的结论：上表除"跨项目查询"与"Project 列表规模化"外全部是当前真实模式；这两项是可量化的未来项，不构成现在换库的理由。

## 5. Concurrency Model（并发模型）

- **进程内**：全部串行化 = per-project promise 队列（EvidenceStore `:161`、candidates `:135`、ArtifactStore `:274`、RevisionStore `:66`、FigureService `:143`、researchLoop `:933`、ProjectStore `:435`）。队列尾部永不因前序失败而死锁（enqueue 模式统一）。
- **进程间**：**零保护**。无 lockfile、无 mutex 库、无 p-limit。两个后端进程共享同一 `PROJECTS_ROOT` 会无检测地交错 append/rewrite（atomic.ts 的 pid+ts+seq tmp 命名只防 tmp 碰撞，不防丢更新）。这是**明示的设计假设**（`config.ts:226-228` 单用户本地工具），不是缺陷；但换库不解决它——SQLite 同样需要应用层纪律（单写者连接或 BUSY 重试策略），PostgreSQL 则要求全部 store 重写后才谈得上并发收益。
- **多 Agent**：Agent 事件单写者（编排器 emitChain `:974-1005`，链内分配 seq）；Agent 间不共享 store 写入点（阶段序协调）。
- **Windows 特有**：rename 会被 AV/索引器短暂打断——已有退避重试（`atomic.ts:52-66`），这是文件方案在 Windows 的真实成本，已付且已固化。

## 6. Atomicity and Transaction Boundaries（原子性与事务边界）

**单一文件级**：原子性由 writeFileAtomic 保证（tmp+fsync+rename），跨 20+ store 一致。

**跨文件序列**逐一审计并分类（已防护 / 理论可能 / 已发生）：

| # | 序列 | 位置 | 分类 | 说明 |
|---|---|---|---|---|
| 1 | 产物 PDF 冻结→manifest 登记 | `ArtifactStore.ts:219-249` | **已防护** | 资产先行+登记殿后+幂等重冻结；崩溃窗口只留无害孤儿 PDF |
| 2 | 证据晋升（evidence.jsonl append→candidates markResolved） | `EvidenceGroundingService.ts:352-404` | **已防护** | 显式幂等重试（`findGroundedRecord :387` 复用既有 id，注释 `:385-387` 记录） |
| 3 | **图表插入四连写**（section.tex→main.tex→figure manifest→视觉清单） | `FigureService.ts:447-639`（`:600-622`） | **理论可能** | 无 try/catch 无补偿：`:600` 后崩溃→稿件含图但 manifest 无 insertedIn；append 重试会因 `record.insertedIn===undefined` 检查（`:564`）放行而**可能产生重复环境**；仅 `:622` 失败→派生清单陈旧（`:610` 注释自认） |
| 4 | 修订补丁→补丁校验记录 | `definitions.ts:2332-2343` | **已防护** | 失败触发显式补偿回写 `fileBefore` + `REPAIR_PIPELINE_ERROR`（`:2339`）——全库仅有的两个补偿动作之一 |
| 5 | 修订应用→revisions.commit→条目状态迁移 | `definitions.ts:2348-2386` | 混合 | 修订记录=指纹幂等（**已防护**，`RevisionStore.ts:247-251`）；条目状态侧文件崩溃留 planned→重派发可恢复（**理论可能**，无守护） |
| 6 | **RevisionStore.restore**（rm 全工作区→快照拷回→新 commit） | `RevisionStore.ts:155-195` | **理论可能** | 破坏性序列无日志无守护；中途崩溃=半恢复工作区+无修订记录；恢复=人工重跑 restore（快照不可变，数据不丢） |
| 7 | 项目创建→导入失败补偿删除 | `ProjectImportService.ts:85-147` | **已防护** | 补偿 delete（`:103,:139`）+ 半成品不进列表（失败仅日志——补偿自身失败仍可能留半项目，有日志可查） |
| 8 | **checkpoint vs events.jsonl 终态时序** | `WorkflowOrchestrator.ts:943-970` | **已防护（by design）** | checkpoint 先落盘、事件后追加是**有意的崩溃安全设计**；读侧契约="checkpoint 是判定依据，日志是进度记录"（`eventLog.ts:4-5`）；§7 详述 |
| 9 | **来源删除→索引/manifest 失效** | `httpServer.ts:1183` | **理论可能** | 失效失败不回滚删除只记日志（防幽灵命中优先）——陈旧索引仅靠日志发现 |

**通用模式总结**：没有共享事务设施，每个 store 自建幂等原语（内容指纹/artifactId/specHash/grounded-match）。全库仅两个真补偿动作（#4 回写、#7 删除）。**理论可能级 4 处（#3/#5b/#6/#9）都有文件侧修法**（补偿、恢复标记、或先登记后执行），不需要跨介质事务——而且注意：数据库事务**本来就覆盖不了**与 .tex/.pdf 文件写入组成的序列（跨介质一致性在所有方案里都要应用层补偿，见 §12）。

## 7. Crash Recovery（崩溃恢复）与 events.jsonl flake 归因

**恢复机制盘点**：

- 运行恢复：`recoverInterruptedRuns`（`WorkflowOrchestrator.ts:375-405`）扫盘重挂 pending/running（发 `workflow.recovered`）；`plan()` 是 WorkflowState 纯函数（`types.ts:179-187`），**不重执行阶段**；恢复基于 checkpoint+工作区 DoD，绝不基于 runtime 会话历史（D-0013，runStore 头注 `:10`）。HITL resume/cancel 的竞态收敛有文档化处理（`:269-278`、`:351-361`）。
- 撕裂读：JSONL 全部按行容错（跳过+计数）；JSON 元数据损坏按 store 分三档：fail-closed 硬错误（SourceStore 索引 / CandidateStore / FigureStore / survey / target）/ 防御降级（ProjectStore 隐藏项目 / ModelSettings 置空）/ 派生重建（chunk / parsed / vision）。
- events.jsonl：**append 无 fsync**——崩溃可能丢尾部事件（读侧容忍）；**无 event_gap 检测/修复**——SSE 重放靠 subscribe-before-replay 缓冲 + `seq>lastSeq` 去重（`httpServer.ts:3764-3858`），重连全量重放（忽略 Last-Event-ID）；磁盘重载时 `registerDiskHandle`（`:1023-1033`）把 `eventsSeq` 提到文件 maxSeq 防重启后 seq 回退。**结论：event_gap 当前没有业务消费方依赖，检测缺失不是缺陷；若未来要断点续传需补 Last-Event-ID 支持。**

**M12 Batch 3 CI flake（a20a528）最终归因**：

`git show a20a528` 只改测试（`WorkflowOrchestrator.test.ts` +14 行）。原测试等待 `waitForStatus("completed")`——读的是**内存** handle（`getRunWithProject` 优先 `this.handles`，`:186-189`）——而 `persistThenCommit` 的序是：checkpoint 落盘 → **内存生效（`:957`）** → `workflow.completed` 事件 appendFile（`:958`，异步未 await 完）。CI 并行负载下测试在事件落盘前注入坏行并断言 `events.length>=4`，读到 3 条而挂。

判定：**测试同步缺陷，暴露的是真实但按设计无害的内存先于磁盘窗口**。不是持久化一致性问题（checkpoint 已持久才可见终态，崩溃安全），不是事务边界问题（顺序有意且读侧契约明确），不是异步写入 bug（emitChain 已串行化、失败自吞不断链 `:1001-1003`）。修复=轮询 `readEventLog` 直至末条为 `workflow.completed`（与姊妹用例既有等待口径一致，`:881-897` 有同类注释）。**此 flake 不构成换库证据。**

## 8. Data Growth Risks（数据增长风险）

**EvidenceStore 写放大（唯一的结构性规模风险）**：

- 现状实测：最大 2 行 / 2.8KB——**距风险区 3–4 个数量级**。
- 机理：`updateVerification`/`markUsage` = 全读 + 全量重写 + fsync（`rewrite() :448-454`）。写作阶段经 `safeMarkUsage`（`definitions.ts:7874-7885`）**逐条**调用——引用 10 条证据的一节 = 10 次全文件重写。
- 外推（静态估算，非实测）：1k 条×1.4KB≈1.4MB 文件 → 单次字段变更 1.4MB 写+fsync；10k 条≈14MB → 10 次连续变更=140MB 写放大 + Windows AV 放大。**触发线建议 10k 条或 10MB。**
- 附带隐患：`rewrite()` 只写回通过校验的行（`:448-454` vs `:440-443`）——**不可解析行在下一次更新时被物理删除**（静默压实）。新版本写入的记录被旧版本二进制读到即丢。前向兼容风险，与规模无关，**应修**。
- schema：无 schemaVersion 字段（`:67-86`），"迁移"=逐行鸭子类型校验——与 figureStore/survey/target 的 fail-closed 版本检查形成对照，是全库最宽松的 store。

**其余增长面**：events.jsonl 每 run 有界（实测 ≤59KB，summarizeResult 截断 200 字符/数组计数化，`:1159-1170`）；checkpoint 32KB 级（stageResults 增长线性但工作流阶段数有界）；解析文档/chunk 是文件资产不入库；项目数增长只影响列表扫描（500 项目仍亚秒级）。

## 9. SQLite Evaluation（SQLite 评估）

**技术面**（生态事实，2026-10 核验）：

- **better-sqlite3**：v12.1.0+ 恢复 Node 24 prebuild（N-API，[issue #137](https://github.com/WiseLibs/better-sqlite3/issues/137) 修复）；同步 API 与 SQLite 单写者模型契合、与现有 per-project 队列模型同构；TS 类型良好；需原生二进制（prebuild 覆盖 win32-x64/linux-x64 glibc；musl/Alpine 需源码编译——本项目用 glibc Ubuntu 无碍）。
- **node:sqlite（内置）**：Node ≥22.5 提供，免原生依赖，但实验状态（Stability 1.1）需盯版本矩阵；对"零额外依赖"最有吸引力，成熟度不如 better-sqlite3。
- **Drizzle/Kysely**：查询构建器 + migration 均支持 SQLite；Prisma 偏重（引擎二进制 + schema 流程）。**嵌入式单用户场景下薄驱动 + 手写 SQL + 显式 migration 脚本可能比 ORM 更简单**——现有代码风格（显式 SQL 感的 store 方法）也更适合。
- WAL：并发读 + 单写者，崩溃恢复成熟，备份=checkpoint+copy 文件。

**适配面**：

- Windows 本地：一个原生模块，`npm install` 即用，无服务进程——**唯一不破坏"零服务安装"约束的数据库选项**。
- Linux Docker：镜像加二进制层即可；数据文件入既有 volume。
- 与现有模型映射：单进程单写者=SQLite 最佳场景；per-project 队列天然映射为串行连接事务。
- 弱点：跨进程仍需应用纪律（或 BUSY 重试）；对"多 Agent 并发"无额外收益（本来就进程内串行）；**跨介质一致性不解决**（PDF/TeX 还在文件）；测试快照/fixture 体系要重建；26 个现有项目的 backfill 与双写验证是真实成本。

## 10. PostgreSQL Evaluation（PostgreSQL 评估）

技术能力无疑最强：事务隔离、多连接、丰富索引与查询计划、JSONB（EvidenceRecord 这类半结构化记录天然适配）、关系约束、成熟备份恢复与 migration 生态（官方驱动 pg / postgres.js + Kysely/Drizzle 均成熟）。

**但对本产品当前形态，成本压倒收益**：

- **Windows 独立运行是硬伤**：单用户本地工具要求用户先安装并运维一个 PostgreSQL Server（或强制 Docker-only），违反 §13 双平台约束的"禁止为 PG 强制 Windows 用户装库"红线。双后端（Win=file / Linux=PG）维护成本是两套 store 代码 + 两套测试矩阵——以当前单人维护带宽不现实。
- 收益错位：事务隔离/多连接/高并发写入全部指向多用户 SaaS——**预注册范围外**（M12.2.5 明示 no SaaS/multi-user/Auth/DB）。
- 运维：服务器进程、凭据、连接池、备份策略、CI 服务容器——每一项都是当前不存在的运维面。
- Docker 形态下可行且优雅，但"Linux Docker 下可行"不构成 Windows 本地用户被迫装库的理由。

**唯一正当化路径**：产品转向多用户/SaaS（架构红线变更），届时以新里程碑重新立项评估。

## 11. File-backed Optimization Evaluation（文件侧优化空间）

针对 §6/§8 发现的问题，文件侧修法（按优先级，全部复用既有原语模式）：

| 优先级 | 问题 | 文件侧修法 | 成本 |
|---|---|---|---|
| **P1** | EvidenceStore rewrite 静默压实（前向兼容数据丢失） | `rewrite()` 保留不可解析原始行（带 `_unparsed` 标记或原样保留字节）而非丢弃；或加 schemaVersion + 新字段宽容读 | 小（单函数） |
| **P1** | 图表插入四连写无守护（#3） | manifest 先行登记 intent（status=pending）→写 .tex→manifest 确认 insertedIn；或失败补偿回滚 .tex（已有 `fileBefore` 模式可抄 #4） | 中 |
| **P2** | EvidenceStore 更新类写放大 | 追加式 event journal（status/usage 变更 append 一行变更记录）+ 读时合并 + 阈值触发的后台压实——把全量重写变成 O(1) append | 中（读路径改合并） |
| **P2** | RevisionStore.restore 破坏性无日志（#6） | restore 前写 `restore-journal.json`（intent+快照指针）→完成删；启动发现 journal 提示重跑 | 小 |
| **P2** | 来源删除索引失效失败仅日志（#9） | 失效失败入重试队列（内存 + 落盘 pending 文件） | 小 |
| **P3** | ExternalInstructionStore RMW 无队列 | 套用统一 enqueue 模式（一行改动级别的机械工作） | 极小 |
| **P3** | ResearcherService/ReviewerService 裸 writeFile | 换 writeJsonAtomic（机械替换） | 极小 |
| **P3** | 索引/分页 | 若 Project 列表 >200：加启动级内存索引（已是事实）+ 分页 API；Evidence 若需高频查询：按 verificationStatus 分文件或内存缓存 | 按需 |

**结论**：文件侧有明确的、渐进的、低风险的改进路径，覆盖全部已发现问题；没有任何问题在文件侧"修不动"。

## 12. Hybrid Storage Boundaries（混合存储边界）

若未来触发数据库引入（§16 触发器），边界应如下设计（本轮只设计不实施）：

**数据库候选**：Project metadata / Workflow Run+Task / Event 索引（events.jsonl 保留为原始日志，库只存 seq 索引）/ Evidence metadata（记录本体 JSON 列）/ Source+Chunk 索引 / Review+Revision lineage / Figure metadata / Usage 聚合。

**永远留在文件系统**：PDF、LaTeX、图表 PDF、解析文档 JSON（MB 级）、实验原始数据/ZIP、Docling artifact、模型缓存——**实测 1.5GB 的 >95% 在这一类**，任何方案都不动它们。

**独立凭据存储（不动）**：API Key / Provider credentials / Pi auth 继续 `~/.paperteam` + Pi `auth.json`——**业务库不收编凭据**（现有 CustomProviderStore 禁 auth 头的纪律延续）。

**跨介质一致性（关键难点，所有方案共有）**：数据库事务覆盖不了文件写入。例：图表插入 = DB 记录 + .tex 修改 + PDF 资产，三者无法原子。**必须**沿用本评估 §6 的应用层补偿模式（intent 记录 → 执行 → 确认；或 fileBefore 回滚）。换言之，**引入数据库并不会消灭本报告发现的补偿逻辑需求，只是把它搬到 DB↔File 边界上**——这是"当前必须数据库"论证不成立的又一结构性理由。

## 13. Windows/Linux Compatibility（双平台适配）

| 方案 | Windows 本地（Mode A） | Linux Docker（Mode B） | 离线使用 | 用户须装 | 备份 | 迁移 | 环境独立性 |
|---|---|---|---|---|---|---|---|
| **File（现状）** | 零依赖 ✅ | 零依赖 ✅ | ✅ | 无 | tar 项目目录（文档已固化：`dual-runtime.md` tar 迁移 + 显式密钥排除） | 同左 | ✅ 完整保留 |
| **SQLite** | 一个原生模块（prebuild） | 镜像+二进制 | ✅ | 无服务 | `.backup` API / checkpoint+copy（**不能**热 copy WAL 活跃文件——需停写或 checkpoint） | DB 文件+项目目录双载体 | ✅（DB 文件不跨端共享也各自独立） |
| **PostgreSQL** | **须装 Server 或转 Docker-only ❌** | compose 服务 | ❌（须起库） | PG Server | pg_dump 管道 | 跨端 DB 导出导入 | ⚠️ 双后端撕裂风险 |

红线执行情况：本评估未为 PostgreSQL 强制任何 Windows 安装——正因如此 PG 被判出局（除非产品形态变更）。

## 14. Migration Risk（迁移风险）

即使 NO-GO，按 B11 要求登记"若触发"的迁移草案：

- **优先迁移**（触发后第一批）：EvidenceStore（收益最大：写放大+索引）→ Workflow run/event 索引（跨 run 查询）→ Usage 聚合（分析型）。
- **暂不动**：一切文件资产（§12）、凭据、skills、settings。
- **必须保留的不可破坏约束**：Canonical IDs（S001/E001/fig-/w-/rev- 命名跨文件引用密集）；Evidence verification status 与 protocolScope；Scope/Fact/Citation 守卫所依赖的字段拓扑；Patch lineage（commentIds/planItemIds/before-after hash）；held-out isolation（评估工具的路径边界语义——**held-out 是路径域概念，迁库时必须保留等价的访问边界**，或评估工具改走库层视图）；figure specHash/datasetHash 内容寻址；Source provenance（contentHash/analysisHash 链）。
- **Backfill**：26 项目 × KB 级 = 一次性脚本可完成；**双写验证期**（新旧并行读对比）至少覆盖一个真实工作流周期；回滚 = 切回文件读路径（旧文件在双写期未停写）。
- **风险评级**：中。风险不在数据量（极小）而在**引用拓扑完整性**（一个 id 语义漂移就会破坏守卫链）与双端验证成本。

## 15. Decision Matrix（决策矩阵）

权重由当前真实产品需求决定（单用户自托管 / 双平台 / 无已证实的性能痛点 / 26 项目 KB 级元数据），**评分为静态工程评估，非基准测试结果**（benchmark 见 §17）：

| 维度 | 权重 | File | SQLite | PostgreSQL |
|---|---|---|---|---|
| 当前必要性（解决已证实痛点） | 18 | 5（无痛点需库解决） | 3（解决的是外推风险） | 2 |
| 查询性能（当前数据量） | 9 | 4（全扫在 KB 级无感） | 5 | 5 |
| 并发写入（单进程现实） | 7 | 4（队列已覆盖观测竞态） | 4（收益同需应用纪律） | 5（能力闲置） |
| 一致性/事务 | 11 | 3（4 处理论缺口可文件侧修） | 5 | 5 |
| Windows 本地部署便利 | 11 | 5（零依赖） | 4（原生模块） | 1（须装服务） |
| Linux 部署便利 | 7 | 5 | 4 | 3（compose 服务+凭据） |
| 数据迁移风险 | 9 | 5（无迁移） | 2（backfill+双写验证） | 1（同左+跨端） |
| 运维成本 | 7 | 5 | 4（WAL/备份新知识面） | 2（服务运维全套餐） |
| 未来扩展（多用户/跨项目） | 4 | 2 | 3 | 5 |
| 开发投入 | 7 | 5 | 2（store 重写+测试重建） | 1 |
| 可测试性 | 5 | 5（文件即 fixture，现状 2,860 测试证明） | 4（内存库/临时文件） | 3（CI 服务容器） |
| 数据安全/备份 | 5 | 4（tar 即备份；无目录 fsync） | 4 | 3 |
| **加权总分（/5）** | **100** | **4.45** | **3.36** | **2.83** |

权重设计说明：未来扩展权重最低（4）不是为让 File 获胜而压低——是产品预注册范围（单用户自托管）使然；若范围变更多用户，该权重应升至 15+ 且 PG 复评。"当前必要性"给 File 5 分的逻辑：该维度衡量"方案解决已证实问题的程度"，文件方案无需解决任何已证实问题即满足现状。

## 16. Recommendation（推荐）

**NO-GO — Keep File-backed**，附三个附件：

1. **立即执行的文件侧加固清单**（§11 的 P1 两项应在下个工程批次落地；P2/P3 排入 backlog）。这些修复**无论未来是否换库都值得做**（补偿逻辑是跨方案需求，§12）。
2. **量化再评估触发器**（任一命中即重开评估，届时先跑 §17 benchmark 再决策）：
   - 单项目 evidence 记录 > 10,000 条或 evidence.jsonl > 10MB；
   - 出现真实的跨项目分析/检索产品需求（非设想）；
   - 立项多进程或多用户（架构红线变更）；
   - 项目数 > 500 且列表/全局操作出现可感知延迟。
3. **若触发，候选唯一 = SQLite**（better-sqlite3 优先，node:sqlite 作免依赖备选；薄驱动 + 显式 migration，不引入重 ORM）；PostgreSQL 仅当多用户 SaaS 立项时重开。

## 17. Proposed Implementation Phases and Benchmark Design（实施阶段与 benchmark 设计——只设计不执行）

**文件侧加固（NO-GO 路线的"实施"）**：

- Phase F1（P1）：EvidenceStore rewrite 保行 + 图表插入补偿/登记先行。
- Phase F2（P2）：EvidenceStore journal 化更新；restore journal；删除失效重试。
- Phase F3（P3）：裸 writeFile 原子化清扫；ExternalInstructionStore 入队。
- 每阶段：红测试证明缺陷 → 修复 → 回归；沿用 2,860 测试基线。

**数据库 benchmark（触发后执行；真实服务器重启后进行，不在 Windows 笔记本跑重型 I/O）**：

1. 数据集生成：1k / 10k / 100k evidence（真实记录形状采样放大）；100 / 1k project。
2. 负载：串行与 4/16 并发写者 × {append, updateVerification 批量, markUsage 连击}。
3. 查询：selectForWriting（cap20）、evidence_query（role 过滤）、stats、全表 list。
4. 对照臂：File 现状 vs File+journal（§11 P2）vs SQLite（WAL）。
5. 崩溃恢复：写中 kill -9 ×50 轮，校验丢失/撕裂分布。
6. 迁移演练：26 真实项目 backfill + 双写对比 + 抽样守卫链断言（canonical id / verification / lineage 零漂移）。
7. 通过线（预注册）：journal/File 臂在 10k evidence 写路径劣于 SQLite 不超过 2×，且崩溃恢复零数据丢失——则继续 File；否则 SQLite GO 复评。

## 18. Measurable Acceptance Criteria（可度量验收标准）

- 本评估自身：Store 清单与源码抽查一致性（每条目路径:行号可复核）✅；真实数据测量覆盖全部 26 项目 ✅；flake 归因有 diff 证据（a20a528）✅。
- 文件侧加固落地时：P1 两项各带"崩溃注入测试"（半写序列重放后状态一致或可恢复）；EvidenceStore 前向兼容测试（新字段记录经旧读路径再写回零丢失）。
- NO-GO 复评时：§16 触发器数值化监控（可在 doctor 或 statusService 加 evidence 计数暴露）。

## 19. Explicit Non-goals（明确非目标）

- 本轮不安装/引入任何数据库；不修改任何业务 Store、runtime adapter、Docker Compose、API 协议。
- 不宣称 SQLite/PostgreSQL 已实现或已被批准（见 D3 状态纪律）。
- 不做性能基准（服务器停机；Windows 禁重型 I/O）。
- 不为 PostgreSQL 设计 Windows 强制安装路径。
- 不把凭据迁入业务库（永远）。

## 20. Final Decision（最终判决）

```
DATABASE_DECISION = NO_GO — Keep File-backed
置信度：高（静态分析 + 全库代码级审计 + 真实数据测量；无未决关键证据）
再评估条件：§16 触发器（量化）+ §17 benchmark（届时执行）
若未来引入：SQLite-only（better-sqlite3 v12.1.0+ / node:sqlite 备选），PostgreSQL 挂起至多用户立项
```

**附：本轮服务器状态 `SERVER_NOT_STARTED = true`；无任何业务代码修改。**
