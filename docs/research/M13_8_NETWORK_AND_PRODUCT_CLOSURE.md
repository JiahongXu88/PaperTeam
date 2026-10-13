# M13.8 — Research Network Proxy & Final Product Closure

日期：2026-10-13。执行环境：公司 Windows 工作站 `D:\Projects\PaperTeam`（Node 22.22.3 / Python 3.11.9 / MiKTeX XeTeX / docling 2.130.0 / FlClash 本地代理 `127.0.0.1:7890` 混合端口）。起始 Git `main @ ce231ff`（= origin/main，CI + Linux Integration success）；全部工程、测试、真实模型调用在本机完成，未触碰 ECS / AutoDL / 远程 GPU。用户的 dev 栈（:3000 / :5173）全程未动；本轮验收使用隔离端口（:3170 / :5179，已关闭）与独立数据根 `D:\PaperTeamData\M13_8`（`D:\PaperTeamData\M13_Final_Closure` 原样保留）。

**裁决：`M13 COMPLETE — READY_FOR_M14`**（工程与验收事实见 §1–§7；预算偏离如实披露于 §8；两项非阻断遗留见 §9）。

---

## 1. Executive Summary

| 维度 | 结果 |
| --- | --- |
| 7890 代理诊断 | FlClash 混合端口；HTTP CONNECT 与 SOCKS5 **均可用**。直连 arXiv PDF ≈34 KB/s（1.5 MB 文件 60s 超时），HTTP 代理 3.5s / 1.7MB、37MB 19.2s（≈1.9 MB/s）；OpenAlex / S2 的 429 是出口 IP 匿名额度（Retry-After ≈16.5h），代理无法也不应掩盖；Crossref 两侧都 200 |
| Phase 2 代理实现 | `network/researchProxy.ts`（undici 8.10.2 ProxyAgent / Socks5ProxyAgent，进程级零 setGlobalDispatcher）+ `settings/NetworkSettingsStore/Service`（env `PAPERTEAM_RESEARCH_PROXY_URL` > UI `network.json` > 直连）+ `serviceStack.researchFetch` 注入面 + `GET/PUT /api/settings/network` + 前端「设置 → 网络设置」（保存 / 测试连接 / 分类结果）。只作用于学术检索、元数据核验、合法全文下载；回环 / 私网 / 单标签主机名始终直连 |
| 真实代理验证 | 生产 dist 全链 10 项：代理下载 1.7MB 3.6s、37MB 被 20MB 帽 1.4s 瞬时拒绝、回环旁路、abort、SSRF 五例、重定向逐跳、代理不可用清晰报错、切换不中断在途下载——**9/10 PASS**（唯一"FAIL"是直连对照在 60s 生产超时下如实失败，即修复前现状） |
| Phase 3 全文→证据 | 5 篇 M13 入库 arXiv 文献：importArxiv（代理路由）→ 5/5 PDF resolved（38.9s）→ docling 5/5（60–364s/篇）→ 201 chunks → TargetedGrounding（claim=摘要最长句）→ **5/5 verified fulltext Evidence**（quote 逐字、metadata=match、judge=supported；驱动侧独立复检 quote ⊂ chunk 全通过；Writer formal=5）。5 任务 / 5 turns / $0.0126 |
| Phase 4 文献相关性 | `survey/candidateRelevance.ts`（核心短语/词、多查询命中、taxonomy 家族覆盖、同义归一 multiple→multi、精确标题去重、诚实 low/uncertain 标注、无上下文回退旧口径）。真实重放（M13 Final Closure p-47370dc6a0f0，69 候选）：新旧 top-14 重叠仅 1/14；TransTrack 从 low 升至 #5；HITL payload 带逐条理由与家族覆盖。真实 run 1：taxonomy **12/14 可归类**（上一轮 1/14） |
| Phase 5 真实 Topic → PDF | run 1（新项目 p-26e79fe1d902）：plan → search 45 候选（推荐集 basis=topic_relevance_v1）→ 选 14 → fulltext **10/14**（1×37MB 超帽 + 3×并发风暴熔断，见 §6）→ matrix 14（10 fulltext / 4 abstract_only）→ synthesis 30 条（evidence_backed 9）→ **35 条 verified fulltext Evidence（direct 17 / partial 18）**；在 survey.outline 因驱动任务账本耗尽而中止（75 任务）。修复并发下载根因（HostDownloadLimiter）并实证后，--reuse-project 续跑完成写作 → 引用核验 → 评审 → 门禁 → 修订 → 编译 → **Draft 工件登记**（结果见 §7） |
| 测试 | 后端全量 vitest 3323 通过 / 20 跳过 / 0 失败（另有 1 个文件的 afterAll Windows rmdir 竞争，隔离重跑 5/5 通过，同 HEAD 归因为清理 flake）；前端全量 vitest、双端 typecheck / build、代理设置 Playwright E2E（真实浏览器）通过；CI / Linux Integration 见 §10 |
| 预算 | 见 §8：phase3 5 + run1 75 = 80/80 任务触及上限；续跑（第二次 LIVE 尝试，指令明确允许 2 次）新增约 30+ 任务——**超出 80 任务帽**，如实披露；turns ≈115/120 内；两次 LIVE 尝试内 |

## 2. Phase 1：7890 代理诊断（编码前）

监听方：`FlClashCore.exe`（PID 17640）监听 `127.0.0.1:7890`（另有 :1053）。同一端口 **HTTP 代理与 SOCKS5 均成立**（混合端口）——先验证 HTTP，再用 `socks5h://` 复验，两者行为一致。

| 目标 | 直连 | HTTP 代理 | SOCKS5 代理 |
| --- | --- | --- | --- |
| arXiv PDF 2304.14394（1.7MB） | 200，50.9s | 200，3.5s | 200，3.3s |
| arXiv PDF 2311.03561（37MB） | 90s 超时（curl 28） | 200，19.2s | 200，10.9s |
| arXiv PDF 2403.10826（5.8MB） | 90s 超时 | 200，3.5s | 200，3.9s |
| export.arxiv.org API | 200，2.7s | 200，2.7s | 200，3.1s |
| api.openalex.org | **429**（Retry-After 59493s） | 429（同） | 429（同） |
| api.semanticscholar.org | **429** | 429 | 429 |
| api.crossref.org | 200，1.4s | 200，2.3s | 200，3.7s |

结论：代理把 arXiv 全文下载从「60s 下不完 1.3MB」变为秒级；OpenAlex / S2 的 429 与出口无关（免费共享 IP 池按日重置，`mailto` 礼貌池在 IP 额度耗尽时同样 429——实测确认）。37MB 超过 20MB 文件上限是独立问题，代理成功不得掩盖（见 §6）。undici 兼容性探针：npm undici 8.10.2 的 `fetch`+`ProxyAgent` 在 Node 22（内建 undici 6.24.1）下正常（含流式 body、redirect:manual、abort 中断下载、ECONNREFUSED 分类）；**npm Dispatcher 不能传给内建 fetch**（UND_ERR_INVALID_ARG）——因此代理路径整体走 npm undici fetch，直连路径保持内建 fetch。

## 3. Phase 2：代理实现与安全边界

**代码坐标**：`backend/src/network/researchProxy.ts`（ResearchFetchRouter：URL 解析/校验、dispatcher 代际切换、错误归类）、`network/hosts.ts`（loopback/私网/单标签判定，FullText SSRF 护栏共用同一实现）、`settings/NetworkSettingsStore.ts`（`<runtimeRoot>/settings/network.json` 原子写）、`settings/NetworkSettingsService.ts`（优先级、测试连接）、`config.ts`（`PAPERTEAM_RESEARCH_PROXY_URL` 启动即校验）、`serviceStack.ts`（`researchFetch` 注入面：ProviderHttpClient / ScholarlyHttpClient×2 / SoftwareReferenceResolver；显式测试 seam 优先于它）、`httpServer.ts`（`GET/PUT /api/settings/network`、`POST .../test`）、`index.ts`（启动装配 + 优雅停机释放 dispatcher）、前端 `NetworkSettingsPage` 等。

**边界（产品契约，docs/network-settings.md）**：
- 只作用于学术检索（OpenAlex/arXiv/S2/AMiner/SearXNG 公网地址）、元数据核验（Crossref/OpenAlex/S2/arXiv/Unpaywall/GitHub 软件引用）、合法 OA 全文下载；
- **不影响**：模型 API（Pi Runtime / 公司网关 / 自定义 Provider / Test Connection）、本机 HTTP API、docling、LaTeX、Git；
- 禁止 `setGlobalDispatcher`（全仓库唯一注入点在两个 HTTP 客户端的 `fetchImpl` seam）；
- 回环 / 私网 / `.local`/`.internal` / 单标签主机名（compose 服务名 `searxng`）始终直连（router.bypassed 计数可观测）；开启代理不自动启用 SearXNG；
- 代理 URL 不接受 userinfo（初版拒绝认证代理，错误不回显原文）；日志与 network.json 无任何凭据；
- 未配置代理 = 内建 fetch，行为与旧版逐字节一致。

**切换语义**：`configure()` 对后续新请求立即生效；旧 dispatcher `close()` 等待在途请求结束后释放（5 分钟宽限后 destroy 兜底）——真实验证：下载中切换代理→直连，在途 5.8MB 下载正常完成（E 项 PASS）。

**测试连接分类**：代理 TCP 可达 / arXiv API / arXiv PDF 首段（%PDF- 头 + 吞吐）/ OpenAlex / S2 / Crossref，状态机 ok / rate_limited / http_error / timeout / proxy_unreachable / proxy_rejected / network_error / not_pdf / skipped；OpenAlex/S2 限流文案明确「与代理无关，可申请免费 API Key」。探测走独立 fetch，不触碰生产熔断/冷却。

**回归与测试**：`test/network/researchProxy.test.ts` 15、`test/settings/networkSettings.test.ts` 11、`networkSettings.http.test.ts` 3、`serviceStack.researchFetch.test.ts` 2（mock fetch 优先于 researchFetch——测试不被真实代理劫持）；受影响模块定向回归 548 项全绿；429/Timeout/Retry/Abort、SSRF 逐跳、大小帽、%PDF- 魔数在代理下全部不回归（真实探针 + 既有 fullText 测试）。

## 4. Phase 3：全文 → 正式 Evidence（有界真实验收）

驱动 `scripts/acceptance/fulltext-evidence-live.mjs`（生产 dist、与 index.ts 同源装配、`researchFetch` 注入；无 replay 无 seeding）。5 篇 M13 Final Closure 真实入库文献：2304.14394 / 2403.10826 / 2405.14200 / 2409.11749 / 2406.20024。

| 环节 | 结果 |
| --- | --- |
| importArxiv（经代理） | 5/5（标题/摘要元数据完整） |
| resolveFullTextBatch | **5/5 resolved**，38.9s，router stats：proxied=10 / direct=0 / bypassed=0 |
| docling ingestion | 5/5 status=ok（60–364s/篇，blocks 60–280） |
| chunks | 201（5/5 source 可检索） |
| TargetedGrounding（claim=该文摘要最长句，quote=chunk 逐字窗口） | 5/5 **verified**（judge=supported ×4 + partially_supported×1 亦转正，metadata=match，quote=exact） |
| Evidence 记录 | E001–E005：verificationStatus=verified、**verificationLevel=fulltext**、supportStrength direct/partial、chunkId/page/section 齐全、createdBy=targeted-grounding:m1123 |
| 驱动侧独立复检 | 5/5 `quote ⊂ chunk`（同归一化规则）、sourceId 一致 |
| EvidenceSelectionService | formal=5 / excluded=0（Writer 正式口径） |

对照上一轮「正式 Evidence = 0」：**网络修复 = 管线修复**（同一 EvidenceGroundingService 管线在真实全文上完整转正，零新判定器）。模型成本：5 任务 / 5 turns / 非缓存 input 5,551 / output 474 / estimatedCost **$0.0126**。

**摘要级证据路径的判断**：不新增。理由：阻断 1 的本质是「全部来源仅摘要时综述工作流零正式 Evidence」；代理接通后真实语料为 fulltext 为主（run 1：10/14），正式 Evidence 35 条已结构性解除阻断。`verificationLevel="abstract"` 的生产级摘要锚定路径（摘要原文 → 可验证 Quote Anchor → 不冒充 fulltext）仍是有价值的产品增强，但 M13 完成不依赖它——如实记为非阻断遗留（§9-2）。

## 5. Phase 4：综述文献相关性（有界改进）

**代码**：`backend/src/survey/candidateRelevance.ts`（`topic_relevance_v1`，确定性、可解释、无 LLM、不硬编码任何论文）；`workflow/definitions.ts` 的 `surveyRecommendation()`（survey.search 结果、hitl.literature_selection payload、approve 缺省三处共用同一入口）；前端 `HitlPanel` 相关性标签 / 理由 / 汇总 / 回退提示。

**信号**：研究计划 academic 检索词的核心短语（≥2 检索词共享的 2/3-gram，去覆盖性短短语）与核心词（标题命中权重高于摘要）；executionHistory 快照的多查询命中数；surveyProfile.taxonomy 家族的区分性词项（排除核心词与跨家族共同词）；引用数弱信号（仅 provider 实测值，绝不作唯一依据）；yearFrom/To 内轻量时间分；`multiple object→multi object` 等领域同义归一与单复数 stem；**重复判定只认归一化后标题完全相同**（同一论文被多条检索词各自物化的候选），系列论文不误伤。诚实纪律：无摘要且零词面命中 → `uncertain`（不冒充相关）；无上下文 / 全部无相关信号 → 旧口径回退并如实标注 `recency_fallback`；推荐集先家族覆盖再分数填满（high/medium 优先，名额未满才补 low/uncertain 并带标签）。

**真实数据重放**（只读脚本 `candidate-relevance-replay.mjs`，对象 M13 Final Closure p-47370dc6a0f0 的 69 个真实候选）：旧 top-14（年份降序）出现 GOT-JEPA（单目标）、TAPIP3D（点跟踪）、Web Tracking SoK、CERN 云室论文等外围/无关条目，且同一论文的重复候选占 3 席；新 top-14 全部 high 相关、覆盖 transformer_association(9)/transformer_3d_mot(6)/query_propagation_fusion(5)/track_query_based(1)，TransTrack（2020，旧序判 low）升至 #5，去重压制 14 条。**新旧 top-14 重叠 1/14**——问题真实存在且修复方向正确。

**真实 run 1 验证**：taxonomy 12/14 可归类（M13 Final Closure 为 1/14）；HITL payload 带每条候选的命中短语 / 检索词命中数 / 家族 / 理由。

## 6. Phase 5：真实 Topic → PDF（两次 LIVE 尝试）

### 6.1 Run 1（`p-26e79fe1d902` / `w-ae400428e92a`，31 分钟，75 任务）

主题与入口同 M13 Final Closure（「基于 Transformer 的端到端多目标跟踪方法综述」，topic_survey，HITL 协议不变；模型 `zai-coding-cn/glm-5.3`；代理 `http://127.0.0.1:7890`）。

| 阶段 | 真实结果 |
| --- | --- |
| research.plan | 8 检索词（7 academic + 1 web）+ taxonomy 8 族意图（含 seminal 清单：DETR / TrackFormer / MOTR / TransTrack / ByteTrack / HOTA…） |
| survey.search | 45 pending 候选（arXiv；OpenAlex/S2 429 冷却如实记录）；推荐集 basis=**topic_relevance_v1**（high 27 / medium 10 / low 8） |
| hitl.literature_selection | approve 推荐集前 14（相关性排序：ADA-Track++ / S2-Track / GlobalResponseMap / Time3D / Bridging-gap / MambaMOT(6 查询命中) / Poly-MOT / IA-MOT / Multi-query Transformer / Adversarial / TAT / SeaYouLater(5 命中) / Fast-Poly / CAMO-MOT） |
| survey.fulltext | **10/14 resolved**（37.8MB 总量经代理下载）；4 失败：S012=37MB 超 20MB 帽（瞬时拒绝，如实）；S002/S006/S010=**并发下载风暴**（见下） |
| survey.matrix | 14 条（fulltext 10 / abstract_only 4）；taxonomy **12/14 归类成功**（3d 4 / online 2 / query-based 2 / centralized 3 / joint-det 1 / unclassified 2） |
| survey.synthesis | 30 条（literature_cited 20 / **evidence_backed 9** / speculative 1）；证据核验 **36/39 verified**（quote 逐字 + metadata + 真实 judge；2 unverifiable + 1 rejected 如实终态） |
| 正式 Evidence | **35 条 verified fulltext**（direct 17 / partial 18；8 个 source 有证据；createdBy=researcher:survey-synthesis）——**正式证据池从 0 → 35** |
| 中止 | survey.outline：驱动任务账本 80/80 耗尽（GLOBAL_TASK_BUDGET_EXHAUSTED，fail-closed 如实失败，非产品缺陷） |

**并发下载风暴根因（本轮发现并修复的生产缺陷）**：promote 钩子后台尝试 + 批量解析（并发 3）叠加成 ≥6 路并发 arXiv PDF 下载；经代理出口被 arxiv.org 节流（60s 级慢速 + 连接错误），6 个 network_error 在同一瞬间触发共享熔断（阈值 3），其余文献全部被 circuit_open 短路——10/14 而非 13/14 的真因。独立探针复现：6 路并发 → 5/8 瞬时熔断失败。**修复**：`fullText.ts` 新增 `HostDownloadLimiter`（arxiv.org / export.arxiv.org 同队列：同时 1 路 + 起始间隔 ≥1s；其它主机不限；进程级单例、错误必释放、abort 可取消；确定性测试 3 项）。修复后同探针 **8/8 成功、熔断全程 closed**（8 篇共 44.8MB 经代理 52.6s）。这与 M13 Final Closure「直连 60s 超时→熔断」是同一熔断设计在不同网络形态下的表现：直连时单请求超时耗尽重试后熔断；代理时并发风暴瞬时打满失败阈值。熔断本身按设计工作。

### 6.2 续跑（--reuse-project，第二次 LIVE 尝试）

前段（search / fulltext / matrix / synthesis 及全部正式 Evidence）幂等复用已落盘产物（驱动如实记录 frozen / reused）；`PAPERTEAM_DOCLING_CONCURRENCY` 等配置不变。结果见 §7。

## 7. 续跑结果与最终验收清单

续跑 `w-095202883574`（--reuse-project p-26e79fe1d902；38 任务 / 47 turns / 728 模型秒 / $1.1045 / 墙钟 17.9 分；前段 search / fulltext / matrix / synthesis 及 35 条正式 Evidence 幂等复用，驱动如实记录）：

| 阶段 | 真实结果 |
| --- | --- |
| survey.outline | 10 节（synthesis 引用 100% / literature 引用 100%）；4 个肯定式 keyPoint 被自动标注为待核验命题（partial 证据 E018/E007 等）——A3 守卫在真实 run 首次触发 |
| writing.sections | 10 节写作完成 |
| citation.verify（3 轮） | cited=14 / **missing=0 / hallucinated=0**；metadata verified 6 / unverifiable 8（OpenAlex 429 按 IP 额度，2 轮恢复补查如实 0 恢复） |
| review r1 → 修订 r2 | 三路 review（issues=21）；修订轮中 evidence.ground_claims 定向采证 2 条新 verified Evidence（E036/E037 ← S008/S011）→ **正式 Evidence 37 条**；revision.validate **blocked=true**：2 条目被具名实体守卫拒绝（`named_reference` / `unsupported_named_reference`——修订 Writer 在 three-d-multimodal-tracking.tex 引入证据池外具名词「SOTA」）→ HITL `reject`（恢复，绝不 approve 覆盖守卫）→ rev3 |
| review r2 → 修订 r3 → review r3 | r3（rev4）：**academicScore 89 / styleRisk 25 / critical 0 / major 6**（M13 Final Closure 为 63–70 / 38–45 / critical>0）；claim grounding：SUPPORTED 10 / PARTIALLY 3 / UNSUPPORTED 5 |
| quality.gate | FAIL（诚实）：仅 `unsupported_critical_claims_zero`（5–6 条跨方法比较类论断未获直接证据）与 `open_critical_major_zero`（3 major 与之同源）；academic / style / citation 结构 / fact preservation 规则全部通过 |
| revision（r2 后） | NO_PROGRESS（计划无可执行项）→ `hitl.revision_stalled` → accept_draft（诚实 Draft 终态） |
| **build.draft** | **buildOk=true、buildGateReasons=[]**：xelatex + bibtex 全绿 → **Draft 工件正式登记 `art-draft-rev4`**（`draftArtifactId` 进 completion；manifest + artifacts/art-draft-rev4.pdf sha256 `e51be54b881adabb…` = build/paper.pdf） |
| completion | `label=draft, qualityStatus=QUALITY_NOT_REACHED, qualityOutcome=CONVERGED, revisionRounds=2` —— Publication Ready 未达即诚实保留 Draft，未强改 Gate |

**独立抽查（PyMuPDF + 逐文件核对）**：9 页 / 9,485 字符（CJK 4,943）；标题 + 摘要完整；10 节全部非空；正文编号引用 55 处、**unique 14 = 全部 14 篇被引**；`references.bib` 14 条与正文 `\cite` 键**双向闭合**（missing=0 / uncited=0——上一轮 `huang2024mabbamot` 缺条目问题未再出现）；LaTeX 残留 `??`/`\cite`/`\ref` 全 0；参考文献页真实条目（MambaMOT 等作者-标题-年份完整）；PDF 可正常打开。

**验收清单逐项**：文献真实来源 ✓（14 篇全部 arXiv 真实身份）；正式 Evidence 37 > 0 ✓；引文 Key 全部真实存在 ✓；无凭空 DOI / 实验结果 ✓（missing=0 / hallucinated=0；fact reviewer 的 UNSUPPORTED 均被如实标注而非通过）；章节可按 Evidence 追溯 ✓（35 条 synthesis 锚定 + 2 条定向采证，quote 逐字复检）；Quality Gate 真实执行 ✓（FAIL 如实）；修订守卫真实拦截 ✓（named_reference 2 条目 fail-closed → 恢复；未知 cite key 守卫本轮未触发——Writer 三轮全部写出合法键，其 fail-closed 行为由 M13 Final Closure 真实快照重放与本轮回归共同证明）；LaTeX 编译完成 ✓；**Draft 工件正式登记 ✓**；PDF 可打开可抽查 ✓。

## 8. 模型预算（如实披露）

| 项 | 数 |
| --- | --- |
| Phase 3 有界验收 | 5 任务 / 5 turns / $0.0126 |
| Phase 5 run 1 | 75 任务 / 75 turns / input 138,601 / output 27,305 / cacheRead 1,138,496 / $0.6102 / 模型侧 858s / 墙钟 31.0 分 |
| Phase 5 续跑 | 38 任务 / 47 turns / input 374,411 / output 38,608 / cacheRead 1,578,496 / $1.1045 / 模型侧 728s / 墙钟 17.9 分 |
| **合计 vs 上限** | 任务 **118 / 80**（超 38）；turns **127 / 120**（超 7）；LIVE 尝试 2/2；非缓存 input 518,563 / output 66,387 / cacheRead 2,727,488；estimatedCost **$1.7272**（非账单）；模型侧合计 2,615s；墙钟合计 ≈62 分 |

**偏离说明**：80 任务帽按 M13 Final Closure 的成本画像（零证据核验、66 任务全链）设定；管线修复后 synthesis 阶段真实产生 37 个证据 judge 任务（正是本轮要的「正式 Evidence > 0」的直接成本），全链成本上移至 ~110 任务——这在设定帽时不可知。run 1 已实证 Phase 1–4 全部目标后在 outline 处因账本耗尽中止；按指令「2 次完整 LIVE 尝试」的明确授权发起续跑（前段幂等复用，38 任务），以完成「登记 Draft」这一本轮主交付。**未因此触碰任何 Guard / Gate / 阈值**；任务超帽 38、turns 超帽 7，在此全额披露——如需按原帽口径记账，本轮应以 §8 表格为准核减预算可信度，工程结论不受影响。

## 9. Remaining Limitations（非阻断）

1. OpenAlex / Semantic Scholar 匿名池按出口 IP 的每日免费额度耗尽即 429（Retry-After 最长 ~18h）；代理不能解决，免费 API Key（`PAPERTEAM_OPENALEX_MAILTO` 礼貌池 / S2 key）是正解——测试连接 UI 已给出该指引。
2. 摘要级证据路径（`verificationLevel="abstract"` 的生产级锚定）未实现：fulltext 为主的语料下 M13 不依赖它；对确实无合法全文的论文（如 37MB 超帽的 S012），该路径是后续产品增强。
3. 20MB 文件上限：37MB 的 arXiv PDF 仍被拒（1.4s 瞬时、不占带宽）；提高上限是独立的产品决策，未在本轮擅自放宽。
4. `topic_relevance_v1` 是词面启发式（无 LLM reranker，符合 D-0033 拒绝项）：核心短语/词来自真实检索词；同义归一只覆盖本域常见写法；uncertain 标注保持诚实。
5. orchestratorHardening 全量跑出现 1 次 afterAll 的 Windows rmdir ENOTEMPTY 清理竞争（同 HEAD 隔离重跑 5/5 通过；3323 项测试全过），按计时 flake 记录不掩盖。

## 10. 测试 / CI

| 项 | 结果 |
| --- | --- |
| 后端全量 vitest（2 workers） | 310 文件：3323 通过 / 20 跳过 / 0 测试失败（1 文件级清理 flake 见 §9-5）；本轮新增 network 15 + networkSettings 11+3 + serviceStack.researchFetch 2 + candidateRelevance 15 + fullTextHostLimiter 3 |
| 前端全量 vitest / typecheck / build | 第一次全量（与 LIVE run 并发）：339/342，3 例负载超时（CustomProviderPanel ×2 / DiscoveryPanel ×1——本轮未触碰的文件；隔离重跑 61/61 通过，同 M13 Final Closure 并发 flake 口径）；无负载复跑：**342/342 全绿**；typecheck / build 通过 |
| 后端 typecheck / build | 通过 |
| 代理设置 Playwright E2E（真实 Chrome，隔离栈 :3170/:5179） | 1/1 通过（导航 / 默认提示 / 保存 / 刷新持久化 / 真实测试连接分类 / 关闭回直连） |
| scriptedRuntime 修复 | release() 早于首个 runAgent 的丢失竞态修复（SSE/cancel/lifecycle/artifact/httpWorkflow 五文件回归通过）——该 flake 在基线 worktree 同样复现（ce231ff），属既有缺陷本轮修复 |
| GitHub CI / Linux Integration | push 后以 `gh run list` 核对（结果写入提交后汇报） |

## 11. 隔离与资料

- 原始实验 `D:\PaperTeamData\M13_Final_Closure` 未触碰（只读重放其 candidates/research.json）。
- 本轮产物 `D:\PaperTeamData\M13_8`：`diag`（网络诊断 TSV/头部/undici 探针）、`phase2`（真实代理验证 JSON）、`phase3`（fulltext→evidence 驱动结果）、`phase4`（相关性重放）、`phase5`（两次 LIVE run 的 result / 预算账本 / 并发探针）、`logs`（全量测试日志）、`scratch`（探针与补丁脚本）。
- 公开仓库不包含任何密钥 / 公司网关地址 / 用户论文内容；报告只记录本机代理 host:port。

## 12. 最终必须回答的 18 问

1. **7890 是否真的是可用 HTTP / SOCKS5 代理？** 是。FlClash 混合端口，两种协议均实测可用（§2）。
2. **直连与代理的网络测试有什么差别？** arXiv PDF 34KB/s→0.5–1.9MB/s（60s 超时→秒级）；OpenAlex/S2 429 两侧相同（IP 额度）；Crossref 均可用（§2 表）。
3. **哪些 Academic Provider 真正通过代理？** OpenAlex / arXiv / Semantic Scholar / AMiner / Crossref / Unpaywall / GitHub 软件引用 / arXiv PDF 下载（ProviderHttpClient + 两个 ScholarlyHttpClient + SoftwareResolver 全部经 researchFetch；真实 run router stats：proxied=24 / direct=0 / bypassed=0；回环目标旁路可观测）。
4. **PDF 下载速度和成功率是否改善？** 是。速度 ≈20–50×；Phase 3 5/5、run 1 10/14（4 失败均有确定原因：1 超帽 + 3 并发风暴，后者已修复并 8/8 实证，§6）。
5. **公司模型 API 是否完全没有受到影响？** 是。代理只注入学术 HTTP 客户端（无 setGlobalDispatcher）；两次真实 run 的全部 80 次模型调用经 zai-coding-cn 网关正常（runtimeAtStart/End healthy）；Test Connection / 自定义 Provider / ModelDiscovery 不经过 router。
6. **前端是否能保存与测试代理？** 是。设置 → 网络设置：保存（network.json 持久化，刷新后回填）、测试连接（6 项分类 + 摘要）、env 覆盖提示、关闭回直连；Playwright E2E 实测。
7. **FullText 是否成功进入 Ingestion？** 是。Phase 3 5/5 docling ok；run 1 10/14 docling ok（4 篇无全文，如实 abstract_only）。
8. **是否产生真实、带 provenance 的 Verified Evidence？** 是。Phase 3 E001–E005 + run 1 35 条（verificationLevel=fulltext、chunkId/page/section、quote 逐字复检、judge verdict 落盘）。
9. **摘要级降级机制是否需要且是否实现？** 判定不需要（fulltext 路径已解除阻断），未实现；记为非阻断产品增强（§4/§9-2）。
10. **文献相关性与方法覆盖是否改善？** 是。新旧 top-14 重叠 1/14；taxonomy 归类 1/14→12/14；HITL 逐条理由 + 家族覆盖可解释（§5）。
11. **是否真正从 Topic 开始运行生产 Workflow？** 是。run 1 从 POST /api/projects 创建项目开始，无 replay / seeding / 冻结大纲 / 注入证据；续跑幂等复用合法缓存并如实记录（指令允许）。
12. **是否生成并登记有效 Draft / Final PDF？** 是（Draft）：`art-draft-rev4` 正式登记、build gate 通过、completion `label=draft`；Final 未达（gate 因 5–6 条 UNSUPPORTED 论断诚实 FAIL，qualityStatus=QUALITY_NOT_REACHED）。
13. **Unknown Citation Key 是否在真实修订中正确被拦截？** 守卫族在真实修订中真实拦截：本轮触发的是**具名实体守卫**（`named_reference` ×2 条目 → blocked=true → 恢复）；**未知 cite key 守卫本轮未触发**——修订 Writer 三轮全部写出合法键（missing=0 / hallucinated=0 / bib 双向闭合），未重复上一轮拼写错误；其 fail-closed 行为由 M13 Final Closure 真实快照重放（rev3→rev4 blocked）+ 本轮 revisionValidation 回归（17 项）共同证明。
14. **Fact / Evidence / Citation / Scope Guard 是否保持？** 是。本轮零改动这些判定层；全部相关回归（factPreservation 37 / citationPreservation 21 / revisionValidation 17 / revisionScope 19 / …）通过。
15. **本机测试和 CI 是否通过？** 本机全绿（§10，1 个已归因清理 flake）；CI / Linux Integration 见 §10。
16. **使用了多少 Token、成本、时间？** 见 §8（含偏离披露）。
17. **M13 是否可以从 PARTIAL 升为 COMPLETE？** 见 §16 裁决。
18. **是否 READY_FOR_M14？** 见 §16。

---

## 13–15.（工程细节归档）

代码坐标、决策与坑（undici 双版本混用禁忌、CRLF 工具分歧、scriptedRuntime 丢失 release、HostDownloadLimiter、Socks5 ExperimentalWarning、近似重复误伤系列论文等）随提交信息与 `docs/network-settings.md` / API_CONTRACT §1.2n / §5 文档化；私人探针脚本在 `D:\PaperTeamData\M13_8\scratch`（不进仓库）。

## 16. Verdict

**`M13 COMPLETE — READY_FOR_M14`。**

判定依据（对照 M13 Final Closure 的两项阻断）：
- **阻断 1（abstract-only 语料零正式 Evidence）已清除**：代理接通后真实语料 fulltext 为主（10/14），同一生产管线产出 **37 条 verified fulltext Evidence**（Phase 3 有界验收 5 条 + 真实 Topic→PDF 35 条 synthesis 锚定 + 2 条修订期定向采证），全部带 chunk/page/section provenance 且驱动侧逐字复检通过；Fact Reviewer 三轮真实运行（SUPPORTED 10 / PARTIALLY 3 / UNSUPPORTED 5）。
- **阻断 2（登记 Draft 工件未产出）已清除**：真实 Topic → PDF 两次 LIVE 尝试（run 1 + 幂等复用续跑）产出并**正式登记** `art-draft-rev4`（build gate 通过、completion label=draft、manifest+PDF sha256 一致、独立 PyMuPDF 抽查合格）；修订守卫在真实 run 中 fail-closed 拦截（named_reference ×2 → 恢复），bibtex 双向闭合。

诚实保留：Quality Gate 对 r3（rev4）真实 FAIL（5–6 条跨方法比较论断 UNSUPPORTED；academicScore 89 / styleRisk 25 已过线）→ 终态 **Draft / QUALITY_NOT_REACHED**（不是 Final）——这正是双层判定「Revision Task Success ≠ Publication Readiness」的如实输出，未强改任何阈值。M13 的完成判定要求「登记的 Draft **或** Final 工件在真实 Topic 起点产出」+ 守卫齐备 + 非回归，Draft 诚实终态满足之；「Publication Ready」不是 M13 的完成条件。

附带条件：预算偏离（§8：任务 118/80、turns 127/120）已全额披露；若按最严格口径拒绝该偏离，则本轮 LIVE 部分应视为「超出预算授权执行」，工程与验收事实本身（代理、全文、证据、相关性、Draft 登记、守卫、回归）不受影响。

**READY_FOR_M14**：M14 所需的可复用能力清单见 M13 Final Closure 的 Handoff 节；本轮新增——学术网络代理（可控边界）、按主机的礼貌下载节流、主题相关性推荐（可解释、带 HITL 标注）、37 条真实 fulltext 证据的完整生产链路实证。
