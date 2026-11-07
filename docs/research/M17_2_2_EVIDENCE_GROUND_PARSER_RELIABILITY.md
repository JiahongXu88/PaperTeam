# M17.2.2 Evidence Grounding 全文解析冷启动与超时可靠性收口

> 公开版说明：本仓库公开。本报告只使用匿名文献编号（P1–P4，均为开放获取论文）与聚合耗时，不含作者未发表研究的任何数值、
> 方法、数据集或原文；原始 PDF、解析产物、运行日志与诊断明细保存在仓库外的私有目录。
> 本阶段**未调用任何付费大模型**，未运行新的论文生成工作流。

## 0. 结论

- **根因（源码 + 实测确证）**：不是「首次下载模型」——模型当时已缓存。三个因素叠加：
  ① 全文解析期间 stage 收不到任何进度，900 s 无进展 watchdog 必然触发；
  ② 单篇 600 s 硬上限低于本机 CPU 的真实解析耗时（4 篇中 3 篇离线也需 824–1282 s，且全部能成功）；
  ③ 每篇解析都联网核对模型版本，而本机直连 HuggingFace 不可达，白白等待超时（同一篇联网 503 s vs 离线 269 s）。
  另有取消不传导（超时后旧解析继续占用唯一并发槽）与误导性错误文案（硬编码「首次解析含模型下载」）。
- **已解决（本机工程层）**：最终代码在一次批次内解析原 4 篇全部成功（合计 27.5 min，单篇进度最大间隔 ≤ 38 s），冷启动（隔离空缓存）
  与依赖不可达负例均为可预期、有界、可诊断的结果；stage watchdog 未放宽、未关闭。
- 本阶段**不代表** M17.2 真实论文闭环完成：`M17_2_COMPLETE` 仍为 **NO**。

## 1. 失败现场（M17.2.1 真实验收）

- `evidence.ground` 两次尝试均以「Stage evidence.ground 执行超时（900000ms 内无进展）」失败；4 篇开放获取 PDF 下载成功，
  每篇都以「解析超时（600000ms；首次解析含模型下载，重试会使用已缓存模型）」落盘为 failed。
- 失败发生在写作之前，仅消耗 1/30 次模型调用。

## 2. 调用链与超时层（修复前，`63c1fa2`）

| 层 | 位置 | 修复前行为 |
|---|---|---|
| Stage 无进展 watchdog | `WorkflowOrchestrator` `IdleDeadline(stage.timeoutMs=900s)` | 只由 `ctx.emitProgress` 续期 |
| 供给编排 | `evidenceGroundStage` → `supplyResearchEvidence` | `progress` 回调只写日志，**不续期**；全文解析期间 stage 对 watchdog 完全静默 |
| 全文挂载 | `SourceImportService.tryResolveFullText` → `onFullTextAttached` → `ingestInBackground` | 后台解析与供给的 `ingest` 合并为同一在途任务 |
| 文档解析 | `IngestionService.ingest` → `DoclingParser.parseFile` → `execFile(timeout=600s)` | 单一硬上限；被杀即报「首次解析含模型下载」（**硬编码文案，无论是否真的在下载**） |
| 取消 | stage abort | **不传入** ingest / parser：stage 超时后旧解析继续占用唯一的解析并发槽 |
| 模型资源 | docling 子进程（无 `HF_ENDPOINT`、无代理） | 每篇解析启动时联网核对模型版本 |

## 3. 根因证据（只读调查，修改代码前完成）

环境：Windows 11，Intel Core Ultra 5 125H（14C/18T，CPU 推理）、32 GB；Python 3.11.9、docling 2.130.0、torch 2.14（CPU）。
样本：上一轮失败所用的同 4 篇开放获取 PDF（原始 hash 复用，私有目录留存），匿名为 P1（24 页）、P2（31 页）、P3（41 页）、P4（10 页）。

| # | 假设 | 测量 | 结论 |
|---|---|---|---|
| H1 | 首次解析在下载模型 | 失败当日布局 / 表格模型已在本机 HF 缓存；日志中 `Loading weights 770/770` 每次 < 2 s 完成（本地加载）；本机直连 huggingface.co 15 s 超时、镜像 2 s 可达，而 docling 子进程环境里既无 `HF_ENDPOINT` 也无代理 | **否定「下载」**；但**确证每篇解析都在联网核对模型版本**：P4 联网解析 503 s（首次加载权重在 121 s，期间多段 0 % CPU），同文件离线（`HF_HUB_OFFLINE=1`）269 s、产出逐字相同 |
| H2 | 文档本身在本机 CPU 上就超过 600 s | 原脚本离线逐篇：P4 269 s / P1 1282 s / P2 824 s / P3 999 s，**全部成功**，峰值 RSS 1.6–2.9 GB | **确证**：4 篇中 3 篇的真实计算量超过单篇 600 s 硬上限；硬上限与「是否下载」无关 |
| H3 | Stage 看不到解析器内部进展 | 源码：供给链路的 `progress` 只写日志；全文解析期间 stage 无任何 `emitProgress` | **确证**：一篇需 > 900 s 的论文必然触发 stage 无进展超时，与解析器是否健康无关 |
| H4 | 解析器内部「真实进度」的粒度不够 | docling 只在每批页面完成时产生 profiling 日志；P1 单页（重表格）TableFormer 连续 **337 s** 无日志，期间进程 CPU 持续 200–400 %（最低 202 %） | **确证**：仅凭页面批次信号会把真实计算误判为无进展（修复第一版在 P1 上即复现此误杀，见 §5） |
| H5 | 并发 / 内存压力 | 解析并发上限 1（M12.2.5 既有）；供给链路逐篇串行；峰值 RSS ≤ 2.9 GB / 32 GB | 否定（本机）；不改并发 |
| H6 | 线程数 / 表格模式 | P4：线程 4→8 总时长 −3 %；TableFormer FAST −33 % 但改变表格结构输出 | 不采用（收益小或改变解析结果） |
| H7 | 取消后子进程不退出 | 源码：stage abort 不传入 ingest；`execFile` 只在自身 timeout 时 kill | **确证**：超时后的旧解析继续占用唯一并发槽，重试与其串行排队 |

失败机理（两次尝试完全吻合日志）：尝试 1 中 P1 跑满 600 s 被杀 → P2 开始解析 → 自上次 stage 进度起 900 s 无进展 → stage 超时；
尝试 2 对 P3、P4 重演（P4 联网解析在当时负载下也超过 600 s）。

## 4. 最小修复

改动面：`backend/src/ingestion/DoclingParser.ts`、`backend/tools/parse_document_docling.py`、`IngestionService.ts`、`ResearchEvidenceSupply.ts`、
`workflow/definitions.ts`（两处供给调用）、`config.ts` / `index.ts` / `serviceStack.ts`（配置接线）、新增 `ingestion/doclingLimits.ts`；无新 Runner / Runtime / 状态机。

1. **解析进度上报（对应 H3、H4）**：解析脚本向 stderr 写 `PAPERTEAM_PROGRESS {json}`：启动 / 模型加载 / docling 流水线每批页面完成 /
   序列化；另有 **CPU 存活心跳**：每 30 s 检查进程 CPU 时间，期间确实消耗 ≥ 5 s CPU 才发 `working`。挂起（等网络、死锁）不耗 CPU →
   没有心跳 → 无进展上限照常触发。`DocumentParseOptions.onProgress` → `IngestionService.ingest(…, { onProgress })`（加入在途解析的调用方同样收到）→
   `supplyResearchEvidence` `heartbeat` → `ctx.emitProgress`（节流 ≤ min(15 s, stage 上限 / 10)）。**stage 的 900 s 无进展 watchdog 保持不变、未关闭。**
2. **分层超时（对应 H2）**：单篇 600 s 硬上限 → 无进展上限 300 s（`PAPERTEAM_DOCLING_IDLE_TIMEOUT_MS`）+ 单篇总时长上限 30 min
   （`PAPERTEAM_DOCLING_TIMEOUT_MS`）。三类终止（无进展 / 总时长 / 取消）都 kill 子进程，promise 在子进程退出后才 settle。
3. **模型资源预检与 warmup（对应 H1）**：首次解析前 `--preflight` 离线确认所需模型（与 docling 解析时同一取模型函数）是否已缓存：
   命中 → 解析子进程 `HF_HUB_OFFLINE=1`（用户显式设置优先）；缺失 → `--warmup` 单独下载（`WAITING_FOR_DEPENDENCY`，独立上限
   `PAPERTEAM_DOCLING_WARMUP_TIMEOUT_MS`，不占文档解析预算）。下载失败 → `INGESTION_PARSER_UNAVAILABLE`，消息写明「依赖下载问题，不是文档内容问题」
   与恢复动作（`HF_ENDPOINT` 镜像或手动 `--warmup`）；失败不缓存，下次重新预检。离线解析期缓存缺失 / 损坏 → `model_unavailable` → 同类不可用错误并重新预检。
   预检自身超时 / 不可判定 → 本次按旧行为联网解析（仍受分层上限约束），不误报为文档失败。并发解析共享一次预检。`PAPERTEAM_DOCLING_MODEL_PREFLIGHT=false` 可回到旧行为。
4. **取消传导（对应 H7）**：stage `signal` → `ingest` → parser：发起方取消即终止子进程且**不落 failed 文档**；加入他人在途解析的调用方取消只结束自己的等待；排队中取消不 spawn。
5. **错误分类**：删除硬编码的「首次解析含模型下载」；超时消息给出「最后进度」（如 `pipeline table p15`）。

不采用：提高或关闭 stage watchdog、跳过全文解析、改用摘要 / snippet 代替全文、改变 docling 解析选项（OCR / 表格模式 / 线程）、默认把下载源改成第三方镜像（保持用户显式配置）。

## 5. 测试与真实 PDF 复验

### 5.1 单元 / 集成（零模型）

| 范围 | 新增 / 扩展 | 覆盖 |
|---|---|---|
| `doclingReliability.test.ts`（新） | 13 | 有进度的长解析不被误杀；无进展 → 有界失败且子进程被终止（pid 探活）；持续进度但超总上限 → 有界失败；在跑 / 排队取消；缓存命中 → 离线解析且并发只预检一次；缓存缺失 → 独立 warmup（`waiting_for_dependency`）；warmup 失败 / 超时 → `INGESTION_PARSER_UNAVAILABLE`、不执行文档解析、失败不缓存；离线期 `model_unavailable` → 重新预检；预检自身超时 → 不误报文档失败；旧脚本兼容；**生产脚本 CPU 心跳：耗 CPU → 发心跳，挂起 → 0 心跳** |
| `ingestionService.test.ts` | +3 | 发起方取消不落 failed 文档且可重试；加入方收到进度、取消只结束自己的等待；超时类失败仍如实落 failed（文案不提模型下载） |
| `researchEvidenceSupply.test.ts` | +4 | 解析进度到达 stage 心跳、stage signal 传入 ingest；解析失败只计失败、不产生 Evidence；**workflow 级**：解析时长 12 s ≫ stage 无进展上限 5 s 且持续报进度 → stage 通过；完全不报进度 → stage 仍按 watchdog 超时失败、解析收到取消、无 Evidence |
| `config.test.ts` | +1 | 分层上限默认值 / 合法值 / 越界报错 |
| `doclingReal.smoke.test.ts` | 扩展 | 真实 docling + 生产同款预检（Linux Integration 干净 runner 上走「缺失 → warmup → 离线解析」），断言拿到真实流水线进度 |

### 5.2 本机真实 PDF（零模型；均为真实执行）

| 场景 | 条件 | 结果 |
|---|---|---|
| 基线（修复前脚本） | P4 联网 / 4 篇离线 | P4 联网 503 s；离线 P4 269 / P1 1282 / P2 824 / P3 999 s，全部成功，峰值 RSS 1.6–2.9 GB |
| 冷启动负例 | 隔离空 HF 缓存、无 `HF_ENDPOINT`（直连不可达） | 190 s 内有界失败：`INGESTION_PARSER_UNAVAILABLE`「依赖下载问题，不是文档内容问题」+ 恢复动作；未启动文档解析 |
| 冷启动正例 | 隔离空 HF 缓存、`HF_ENDPOINT` 镜像（文档化恢复路径） | 预检 20 s → warmup 下载 506 MB / 94 s → 离线解析 327 s；产出与基线逐字一致 |
| 热缓存（修复第一版） | 用户既有全局缓存（只读复用） | P2/P3/P4 成功；**P1 被 300 s 无进展上限误杀**（单页 TableFormer 337 s 无页面级信号、CPU 持续 ≥ 202 %）→ 据此加入 CPU 存活心跳 |
| 热缓存（最终代码） | 原 4 篇、原失败顺序、一次批次 | **4/4 成功**：P1 673 s、P2 347 s、P3 470 s、P4 158 s，合计 27.5 min；进度最大间隔 ≤ 38 s；无残留子进程 |

产出一致性：4 篇正文字符数与修复前逐字一致；P2 块数 529 vs 基线 530（基线计数取自 Python 原始输出，Node 侧映射会丢弃空表格块，字符数相同）。
未改变 docling 解析选项（OCR 关、TableFormer ACCURATE、图片 2×）。冷启动使用隔离缓存目录，未改动用户全局缓存。

### 5.3 生产通路 smoke（零付费模型；真实 `node dist/index.js`，未配置任何模型）

- HTTP 上传真实 PDF → 生产后台解析链（与 `onFullTextAttached` 同一入口）：预检命中 → 离线解析 171 s → `status=ok`、structured、10 页 / 153 块；
  source `contentHash` = 文件 SHA-256；检索重建 41 个 docling chunk，命中结果带 sourceId / chunkId / 页码 provenance。
- 负例：损坏 PDF → 34 s 内 `status=failed`（内容错误，分类正确），无 Evidence、无残留子进程。
- 覆盖边界：`evidence.ground` 在真实模型下的全链路未运行（需要真实模型调用）；该 stage 的心跳 / watchdog / 取消语义由 workflow 级集成测试与 scripted 浏览器 E2E 覆盖。

### 5.4 常规回归

- Backend typecheck / build 通过；全量 vitest：4950 通过 / 26 失败 / 47 跳过。失败中 25 个为 `Test timed out in 5000ms`（与真实 docling smoke 的 13 min CPU 负载并行），
  1 个 ENOTEMPTY 清理竞态。将这 13 个失败文件在**修改前的 HEAD** 上同条件复跑：HEAD 失败 19 个，本轮工作区失败 17 个，**本轮失败集合是 HEAD 失败集合的子集**
  （无本轮独有失败）→ 记为既有的时序敏感用例，不是本轮引入。远程 CI（Linux）结果见 §7。
- 真实 docling smoke（含新预检路径）在全量中通过（2/2）。
- Frontend：build 通过，vitest 399/399（无前端改动）。
- Playwright：`evidence-gate`（scripted Runtime，7/7，含完整工作流经过 `evidence.ground`）、`m172-experiment-snapshot`、`m1721-method-facts`、`sources-fulltext` 全部通过（10/10）。
- `git diff --check` 通过。

## 6. 不变量（Evidence / Fact / Method Facts / Quality Gate）

- 解析失败或被取消的文献不产生 chunk、不进入 grounding，`supplyResearchEvidence` 计入 `ingestion_failed`；Search Result 仍只是候选，
  Evidence 仍须经全文 chunk → quote 逐字校验 → metadata 核验 → 语义判定（未改动）。
- 取消不落 failed 文档（避免「被取消」被当成「已解析失败」而在重试中被跳过）；真实解析失败（含无进展 / 总时长超时）仍如实落盘 `status=failed`。
- 依赖问题（模型下载失败、离线缓存缺失）报 `INGESTION_PARSER_UNAVAILABLE`，不再伪装成文档内容失败；PDF 仍按既有降级链处理（未改动）。
- Fact / Citation / Scope Guard、Experiment Fact Snapshot、Method Facts、Quality Gate 阈值与既有 Author Decision：代码未触及，回归全部通过。

## 7. 判定

| 项 | 判定 | 依据 |
|---|---|---|
| `M17_2_2_PARSER_ENGINEERING` | **PASS** | 源码级根因 + 针对性修复；冷启动 / 缓存 / 依赖故障 / 取消 / 子进程回收均有可复算测试；watchdog 未放宽；失败不升级为 Evidence；回归无本轮新增失败 |
| `M17_2_2_REAL_PDF_PREFLIGHT` | **PASS** | 原 4 篇真实 PDF 一次批次 4/4 成功；隔离冷启动正例 / 负例均真实执行 |
| `M17_2_2_PRODUCTION_PATH` | **PARTIAL** | 真实后端 HTTP 上传 → 生产解析链 → chunk provenance 已验证；`evidence.ground` 在真实模型下的整段未运行（只由集成测试与 scripted E2E 覆盖） |
| `READY_FOR_NEXT_REAL_MODEL_E2E` | **YES（附条件）** | 无解析器级 P0 阻塞；本机模型缓存就绪、4 篇解析约 28 min（在 stage watchdog 下有心跳）；模型凭据文件存在（仅核对存在性，未调用、未输出）；条件见 §8 |
| `M17_2_COMPLETE` | **NO（不变）** | 方法事实守卫与 PDF 产出仍需未来真实模型写作验证 |

最终提交与远程 CI：见提交说明与 GitHub Actions（CI / Linux Integration）；结果以远程为准。

## 8. 遗留与下一步

- 下一次真实 E2E 之前必须**重新冻结协议**（不能沿用 M17.2.1 被中断的协议）：代码 SHA = 本轮最终提交；样本与方法事实快照沿用 M17.2.1 的真实验收项目
  （作者已确认、适用范围已按作者更正收窄的同一份快照；不得按配置名扩展事实范围）；预算 ≤ 30 次调用；停止条件预登记。本轮未发起新的 Author Decision。
- 预期 `evidence.ground` 在本机耗时约 30 min（4 篇 CPU 解析）；若机器负载显著更高，单篇仍受 30 min 总上限约束。
- 遗留（非阻塞）：① 同一进程内若有**不相关**文献的后台解析正占用唯一并发槽，stage 自己的解析排队期间没有心跳（evidence.ground 的供给链路与同一文献的后台解析合并，不受影响）；
  ② 首次模型下载默认不改下载源，直连不可达的网络需按提示设置 `HF_ENDPOINT` 或手动 `--warmup`；③ 本机 26 个既有时序敏感用例（HEAD 同样失败）建议另行治理。
