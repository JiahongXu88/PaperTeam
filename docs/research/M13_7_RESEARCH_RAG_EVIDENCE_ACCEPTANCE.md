# M13.7 Research → RAG → Evidence 阶段验收

日期：2026-10-11。验收代码：`77ee8b9518f617491e86ca94ee96f0ee93d4031a`。

**结论：PASS（本阶段范围）**。研究后有界证据供给的程序验收、新加坡隔离 Linux 构建/回归、公开论文真实检索与 Grounding、Writer 消费证据均通过。完整论文质量、真实业务全流程与所有外部失败场景不在本次通过声明中。

本报告整合首次本地验收和后续服务器续验，早期 `REMOTE_BLOCKED` / `LIVE_MODEL_BLOCKED` 已解除。工程实现说明见 [RESEARCH_EVIDENCE_SUPPLY.md](RESEARCH_EVIDENCE_SUPPLY.md)。本次文档迁移仅整理报告、索引和复用脚本，没有再次修改 Research/RAG/Evidence 源码、运行全量测试或调用模型。

## 1. 根因与修复前复现

原始提交为 `177525ee85f24711db7214538f62be913a9368c8`。调用链为：

```text
research.idea → ResearcherService.research → evidence.ground
→ feasibility/outline → hitl.evidence_supply → writing.sections
→ EvidenceSelectionService.selectForWriting
```

原 `evidence.ground` 仅处理已有 EvidenceCandidate，待审文献 CandidateSource 没有自动变成可检索的正式 Source；原 HITL 提示依赖手动 Promote。即使后来入库取得全文，Researcher 已结束，也不会自动补充新的 claim/source/chunk/quote 锚点提案。两个时序断点使 Writer 正式证据池为空。

历史公共脱敏报告中的“79 pending”是待审文献数，不能解释成79条带 quote 的证据候选，也不能推断历史 Source/Chunk 数。本次在原始提交独立副本运行合成复现：到 feasibility HITL 时，CandidateSource=1、Source=0、EvidenceCandidate=0、formal Evidence=0。

另修复了 quote 窗口重组空白导致逐字锚点失真、仅对 pending 去重导致终态提案重复，以及并发 grounding 的重复追加风险。未找到可确认的私人研究项目实际数据根；未读取、修改、复制或重跑其研究材料，未改变任何实验授权或 held-out isolation。

## 2. 实施范围与边界

在 `idea_to_paper` 现有 `evidence.ground` 内先运行 `ResearchEvidenceSupply`，保留 stage ID；`topic_survey` 原有文献遴选/冻结语料语义不变。

1. 最多考察12条非 rejected 的 academic_search 候选，含 accepted 以支持恢复；排除 manual/web。要求 title/authors/year 和 DOI/arXiv/PMID，按已有身份键去重；标题/摘要与项目主题至少重叠两个有效 token（过滤英文停用词和单字符），记录 selectionReason。
2. 最多准备6个 Source。`deferFullText` 避免 Promote 后台和同步供给重复获取全文；复用合法 FullTextResolver、ingestion、SourceChunker。无全文/无可索引内容不采证，遇429诚实停止。
3. 最多使用6条 Researcher 已有明确论断：优先 evidence.claim，其次 domainOverview 句子；不把研究问题、潜在贡献或计划 topic 当作已支持结论。
4. 每 claim 使用 lexical Top-K=6，最多尝试3个 chunk，quote 为连续原文切片；最多18次自动语义核验尝试。首个 verified 即满足该 claim；judge 失败/不可用或限流停止批次。没有接入 dense embedding。
5. 保留 quote、metadata、semantic judge 三段核验及 Writer evidence-only 视图，不降低质量守卫阈值。Source 身份本身不是 claim 支持证据。
6. 全状态候选去重、store 写锁内再次去重、项目内 grounding 串行化；保留 append/markResolved 恢复守卫，在来源准备、采证及 verified 写入前检查取消。
7. 记录候选审查/选择/去重、promotion 成败、全文/chunks、提案/verified/rejected/unverifiable、失败分类和 claim 哈希→source→chunk 映射。阶段日志不输出研究全文；自动成功后不强制技术性手动 Promote，未覆盖缺口仍保留人工补给路径。

原实现提交涉及以下9个文件；本次迁移没有再改动它们：

- `backend/src/evidence/ResearchEvidenceSupply.ts`
- `backend/src/evidence/TargetedGroundingService.ts`
- `backend/src/evidence/EvidenceGroundingService.ts`
- `backend/src/evidence/candidates.ts`
- `backend/src/sources/SourceImportService.ts`
- `backend/src/workflow/definitions.ts`
- `backend/test/evidence/researchEvidenceSupply.test.ts`
- `backend/test/workflow/evidenceSupply.test.ts`
- `docs/research/RESEARCH_EVIDENCE_SUPPLY.md`

## 3. 受控程序验收（不等同 LIVE）

| 指标 | 原始提交 | 修复后夹具 | 同项目重复执行 |
| --- | ---: | ---: | ---: |
| CandidateSource 总数 / pending | 1 / 1 | 1 / 0 | 1 / 0 |
| Source / 全文来源 | 0 / 0 | 1 / 1 | 1 / 1 |
| Chunk | 0 | 1 | 1 |
| EvidenceCandidate | 0 | 1 | 1 |
| Verified / Writer formal | 0 | 1 | 1 |
| 本轮新增提案 | 0 | 1 | 0 |

使用真实存储、合成 PDF 原文解析、lexical RAG、现有三段 Grounding 和 Writer 消费路径；全文下载器、scholarly provider、语义 judge 是受控替身。它们验证程序边界，不能充当真实 provider 成功率。

| 验收项 | 结果 |
| --- | --- |
| A 有全文、原文 quote 和支持 claim | PASS；controlled judge，Writer 实际 writing/sections 输入可见 |
| B metadata-only | PASS；不能直接提案或转正 |
| C quote 不存在 / 反向 claim | PASS；mismatch / unsupported → rejected，重试不会伪造成功 |
| D 重复、中断、并发、项目隔离 | PASS；取消恢复、judge 恢复、并发 propose/ground 不重复；其他项目正式池为空 |
| E 原工作流和质量守卫 | PASS；topic_survey、existing-paper、实验授权回归通过 |
| F 统计与成本边界 | PASS；完整阶段计数、锚点映射、429停止、12/6上限及排除条件覆盖 |

## 4. 新加坡 Linux 与部署验证

SSH 已通过实际公钥认证验证账号/密钥匹配；主机 ED25519 指纹由可信云控制台独立确认后才建立信任。全程启用严格主机校验，仅使用已授权账号和密钥，没有根据文件名推断匹配、猜测其他凭据或关闭指纹校验。初次连接停在 host trust 阶段，不能误报网络不通或公钥授权失败；一次 Windows keyscan KEX 不兼容由支持的客户端解决。

公开环境基线：Ubuntu 24.04.5、kernel 6.8.0-139、4 vCPU、约15 GiB可见内存、4 GiB swap、79 GiB磁盘（初始约36 GiB可用）；Docker 29.8.2、Compose v5.6.0，Node 22.23.3、PyMuPDF 1.28.2。实际运行 whoami、hostname、uname、free、df、docker version 核对环境。具体地址、账号、主机名、指纹和个人路径不在公开报告中披露。

独立 clone 已推送的 main，确认上述代码 SHA；使用独立验收目录、镜像标签、Compose project 和 projects/runtime/hf-cache 数据根。既有部署保持原提交和容器/volume，未升级、覆盖或停止。测试 API 仅绑定 `127.0.0.1:18080`，原服务仅绑定回环地址；无认证服务未暴露公网。新旧服务 health=ok / ready=true，XeLaTeX、BibTeX、PyMuPDF 就绪。

仅在服务器内部复用已有授权模型配置到隔离 runtime，凭据权限600；未从 Windows 同步凭据，也未把服务器 auth.json、模型配置或私人数据导回 Windows。构建上下文排除 runtime/projects/hf-cache/logs/凭据环境文件；凭据未进入镜像或 Git。

高负载任务串行执行：构建/回归2 CPU，回归8 GiB，LIVE runner4 GiB；常驻隔离服务6 GiB上限、模型并发1。收尾约14 GiB可用内存、swap使用0，load average 0.17/0.60/0.45，隔离服务空闲约83 MiB。隔离服务保留且仅回环监听，临时 LIVE runner 已退出，既有服务仍健康。

## 5. 真实 Search → Source → Chunk → Grounding → Writer

使用公开论文 [Attention Is All You Need](https://arxiv.org/abs/1706.03762)：真实 arXiv 搜索返回5项，仅显式保存匹配1706.03762的一项；下载真实全文并进行 PyMuPDF text_only 解析、lexical 检索、生产 Grounding 和真实 `zai/glm-5.3` judge/Writer。PDF SHA256：`bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697`。

研究输入是人工明确给定的公开架构论断；没有重跑整轮 Researcher 或完整 idea_to_paper。

| 阶段 | CandidateSource | Source | Chunk | EvidenceCandidate | Verified / Writer formal |
| --- | ---: | ---: | ---: | ---: | ---: |
| 初始 | 0 | 0 | 0 | 0 | 0 |
| 搜索并选存 | 1 | 0 | 0 | 0 | 0 |
| 首轮低质量分块 | 1 | 1 | 16 | 3 | 0 |
| 修正验收解析器配置 | 1 | 1 | 36 | 4 | 1 partial |
| 收窄到原文明示论断 | 1 | 1 | 36 | 5 | 2：1 direct + 1 partial |
| 同论断重复执行 | 1 | 1 | 36 | 5 | 2，稳定无新增 |

S001 为正式 Source。E001 的原策略 verdict=partially_supported，supportStrength=partial，不宣称为直接支持。E002 为 quote=exact / metadata=match / judge=supported / supportStrength=direct / verificationLevel=fulltext。两条 quote 均独立检查为当前 chunk 的逐字子串，锚点 `S001:SEC01:0003:ebde7e2ce6`，page2 Introduction。没有手工追加或改写 verified 状态。

最终 Writer 从 `selectForWriting` 返回值中仅选 direct 记录，生成256字符的短段落，使用 bibliography key `vaswani2017attention`；内容仅描述无递归、注意力建立输入输出依赖，没有沿用 partial 证据未直接覆盖的 convolution 论断。原始 LaTeX 和逐次 usage 见私人归档。

首轮失败保留：验收脚本只为 ingestion 指定 PyMuPDF，未给 serviceStack 传 pdfPythonCommand；RAG 回退 builtin，词间空格丢失，3次真实 judge 均 inconclusive，Verified=0。仅修正验收脚本后重建36 chunks，未改业务代码或阈值。另一次脚本 ReferenceError 在模型调用前结束，调用数0。原3条未核验候选仍是 unverifiable。

修正轮为部分支持；随后收窄 claim 到原文明示范围，获得 direct 证据并验证 Writer。重复执行不增加 Source、EvidenceCandidate 或 Evidence。累计7次真实调用：5 judge + 2 Writer；没有完整论文重跑。

## 6. 测试、失败记录与耗时

以下是实施/续验时已实际取得的结果，本次文档收口没有重跑。

| 验证 | 结果 / 耗时 |
| --- | --- |
| 原始基线 | 合并结果3058通过 / 19跳过；另1项原始断点复现通过 |
| 受影响模块 | 阶段性51/51通过；最终新增供给文件12/12；最终提示/链路定向17/17 |
| Windows 最终 typecheck / build | 均退出0 |
| Windows 最终后端全量 | 3070通过 / 19跳过 / 0失败；281文件通过 / 6跳过；163.31 s |
| Linux 后端 / 前端 npm ci | 已有lockfile；4 s / 2 s，未重建前端 |
| Linux typecheck / build | PASS；12 s / 9 s |
| Linux 镜像打包 | PASS；13 s，复用服务器既有基础镜像 |
| Linux 首轮错误环境全量 | 3033通过 / 33失败 / 23跳过；139.57 s |
| Linux 修正环境全量 | 3067通过 / 22跳过 / 0失败；279文件通过 / 8跳过；151.05 s，外层152 s |
| 真实搜索 | 0.419 s，返回5，选存1 |
| 首轮全文/分块阶段累计 | 1.572 s，16 chunks |
| 首轮 LIVE | 24.229 s；3 judge，0 Verified |
| 修正解析器后 LIVE | 12.313 s；supply7.784 s，Writer4.315 s，重复0.185 s |
| 收窄论断后 LIVE | 13.852 s；supply10.153 s，Writer3.479 s，重复0.188 s |

失败归因与纠正：

- 基线副本最初缺 frontend node_modules，proxy 测试无法加载；补齐既有依赖路径后该4项通过，组合基线如表。未观察到 SSE timing 失败。
- 新增测试最初辅助函数签名/TXT补挂不符接口，改为既有 minimalPdf 和正确接口；阶段性全量3067通过/19跳过。最终树第二次全量3069通过/1失败/19跳过，是旧测试仍要求诊断含 Promote；更新提示契约并补充 manual 排除计数断言后，最终3070通过，未放宽证据守卫。
- Linux 首轮继承 NODE_ENV=production，故障注入未生效；PATH未使用Python虚拟环境，PDF测试失败。改用 NODE_ENV=test 和虚拟环境PATH，在同一提交全部通过。
- Docker build 不支持传入 --cpus、npm test 重复 maxWorkers 参数，均是有效构建/测试启动前失败，修正命令后完成。
- SSH曾 connection reset；通过远端容器及落盘日志接回任务，后续长任务用nohup，未并行重复启动重负载。

主要实际命令包括：git status/rev-parse/ls-remote/fetch、原始提交 git archive、rg 静态检查、后端 npm run typecheck / npm run build / npm test、定向 vitest run、Docker镜像构建及隔离Compose、服务器 curl /health /ready、gh api 查询和 git diff --check。远程全量使用 `vitest run --maxWorkers=2`，显式 NODE_ENV=test 和Python虚拟环境PATH；Windows续验仅做SSH/Git/文件读写/轻量编排，无新的全量测试或Docker构建。

## 7. Token、CI 与代码状态

| 真实模型指标 | 总计 |
| --- | ---: |
| 调用 / assistant turns | 7 / 7 |
| inputTokens | 7807 |
| outputTokens | 594 |
| cacheReadTokens | 6848 |
| cacheWriteTokens | 0 |
| SDK estimatedCost | 0.01532388 |

输入与输出合计8401；加缓存读取累计15249。这是多次调用的增量总计，不是单次上下文长度；estimatedCost 不是实际账单。Codex自身本轮总Token/账单未由工具提供。

验收代码提交已推送，实施收尾时 HEAD / origin/main / GitHub main 一致、工作区clean。2026-10-11服务器续验收尾确认：

- [CI](https://github.com/JiahongXu88/PaperTeam/actions/runs/38120367017)：completed/success。
- [Linux Integration](https://github.com/JiahongXu88/PaperTeam/actions/runs/38120367020)：completed/success，native和Docker均完成。

这是上述代码SHA的历史CI结果，不表示后续文档提交已经完成CI。

## 8. 复用脚本与数据归档

检查远程一次性脚本后，保留串行构建/回归的通用能力为 [scripts/acceptance/linux-checks.sh](../../scripts/acceptance/linux-checks.sh)。脚本从自身位置解析仓库根，不嵌入SSH地址/账号/私钥路径、不复制凭据、无自动安装/拉取/部署步骤。要求服务器本地已有Node构建镜像、含PyMuPDF的测试镜像和lockfile已安装依赖；2CPU、最多2个Vitest worker，构建6GiB/回归8GiB，flock防同一输出根并发，日志必须在仓库外。

在隔离Linux checkout的项目根运行，例如：

```bash
PAPERTEAM_ACCEPTANCE_IMAGE=your-local-backend-image \
PAPERTEAM_ACCEPTANCE_OUTPUT=../PaperTeamData/M13_7/linux-checks \
bash scripts/acceptance/linux-checks.sh
```

SSH连接与主机信任使用各自本地配置，不在仓库硬编码。一次性登录排障、特定测试项目恢复和模型调用脚本保留为私人原始证据；没有将它们作为可重放的公共采证工具。原远端脚本曾bash -n通过；本次整理版本仅做语法/帮助检查，未再次执行其构建/回归命令。

公开报告默认属于 `docs/research/`。原始报告、原始日志、公开论文验收JSON、定位信息及一次性脚本归档到仓库外 `D:\PaperTeamData\M13_7`；包含Windows归档文件的SHA256清单和服务器验收日志/脚本压缩包。服务器凭据和私人论文不在此次归档导出范围。公开版本不含私钥/API Key正文，并去除服务器IP/账号/主机名/指纹/个人密钥路径、私人研究项目标识与实验内部代号。原错误目录中的本次重复报告在确认归档完整后清理，不影响其他报告。

## 9. 已知限制与下一步

- 真实LIVE仅验证一篇公开论文和人工给定论断，不是Researcher整轮或完整idea_to_paper端到端验收；没有完整论文/投稿质量声明。
- 本次解析为PyMuPDF text_only，未验证Docling图表、公式或版面结构；没有真实dense embedding。
- A–F负例主要由受控judge/provider验证；未覆盖真实外部服务全部故障、论文类型或跨语言领域。lexical主题筛选对跨语言同义表达保守。
- partial与direct不同；首次Writer曾沿用partial证据未直接覆盖的卷积表述，最终收窄claim并仅用direct记录补验。后续应继续检查普通Writer流程对partial证据的表述边界，不将本次人工过滤宣称为通用Writer规则修复。
- Windows SSH隧道和完整Web UI尚未实际验收；服务仅回环监听，可按本地SSH配置访问。
- 后续CPU密集构建/测试优先使用隔离Linux checkout；更新源码/lockfile/镜像时同步检查，避免影响既有部署。科研授权和人工决策边界继续保持。
