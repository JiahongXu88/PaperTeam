# M15.8.1 Research Proxy 接线修复与真实全文获取恢复

- 日期：2026-10-27
- 基线：`99cdb69524a0f6e3ce801a9d3d74551085dc739d`（M15.8 收口 HEAD；本地 == origin/main，工作区 clean）
- 数据根：`D:\PaperTeamData\M15\M15_8`（原始 journal / 论文 / 预算账本未动）
- 裁决：**NETWORK_RECOVERY_PASS**（代理链路修复 + 15/16 全文恢复 + 0 模型调用；S011 为真实 not_found）

## 1. 问题与证据

M15.8 真实 E2E（p-6f05e6980fda）25 篇入选文献中 19 篇全文最初获取失败（后补 3），
终局 16 篇 metadata_only。当时的假设是「arXiv CDN 对 undici 长波节流」。本次
Phase A 实测推翻了「仅站点故障」的单因解释，定论为**混合根因**：

1. **harness 漏注入（主因，代码缺陷）**：`scripts/m158-p-survey-e2e.mjs` 与
   `scripts/m158-p-fulltext-backfill.mjs` 自行调用 `buildServiceStack(...)` 时未传
   `researchFetch`，学术请求（ProviderHttpClient / ScholarlyHttpClient / 全文下载）
   全部退回内建 fetch **直连**；preflight 也用全局 `fetch` 直连 arXiv/OpenAlex。
   生产入口 `backend/src/index.ts` 的装配（ResearchFetchRouter +
   NetworkSettingsService + `researchFetch` 注入）一直是正确的——只有脚本漏线。
2. **本机网络环境（次因，环境事实）**：公司网络直连学术站点大面积不可达
   （`proxy-diagnosis.json`：arXiv API/PDF、Semantic Scholar、Crossref 直连全部
   超时 / `UND_ERR_CONNECT_TIMEOUT`，仅 OpenAlex 偶尔可达）。本机
   `127.0.0.1:7890`（FlClashCore，**mixed 口：HTTP CONNECT 与 SOCKS5 双通**）完全
   可用：同 URL 三路对照——Node 内建 fetch 直连 30s 超时 FAIL；经
   ResearchFetchRouter 走 7890 完整下载 2,215,244B / 2.5s / `%PDF-`；`curl.exe
   --proxy` 显式代理同样 200 / 同字节数。sha256 三方一致
   （`bdfaa68d8984f0dc…`）。
3. **保存设置未启用（环境事实）**：`~/.paperteam/settings/network.json` 保存了
   `127.0.0.1:7890` 但 `enabled=false`——即使生产入口在该机器上启动也会直连。

原始诊断数据（不入库）：`D:\PaperTeamData\M15\M15_8\network-repair\proxy-diagnosis.json`。

## 2. 改动

### 2.1 共享装配（消除脚本/生产漂移）

- 新增 `backend/src/network/researchNetworkBootstrap.ts`：
  - `initResearchNetwork(options)`：创建 ResearchFetchRouter + NetworkSettingsService
    并 `applyStartupConfiguration()`，语义与 index.ts 原内联实现逐字一致
    （env `PAPERTEAM_RESEARCH_PROXY_URL` > network.json enabled > 直连）；生产与
    真实运行脚本共用同一套初始化。
  - `probeResearchNetwork(bootstrap)`：0 模型 fail-fast 预检，复用
    NetworkSettingsService.test() 的六项探测（proxy / arxiv_api / arxiv_pdf /
    openalex / semantic_scholar / crossref），输出结构化结论
    `PASS / PROXY_UNREACHABLE / ARXIV_PDF_TIMEOUT / TARGET_RATE_LIMITED /
    ACADEMIC_UNREACHABLE`。代理已配置但核心路径不可用 → 脚本结构化退出，不静默
    降级直连、不消耗模型预算；直连模式保留旧 openalex 兜底语义。
- `backend/src/index.ts`：改为调用 `initResearchNetwork`（行为不变，消除双份装配）。

### 2.2 M15.8 脚本接线（7 个真实运行脚本）

`m158-p-survey-e2e` / `m158-p-fulltext-backfill` / `m158-p-preground` /
`m158-p-buildcheck` / `m158-g7-reproducibility` / `m158-h-author-decision` /
`m158-n-negative-e2e` 全部：

- 装配 `initResearchNetwork` 并向 `buildServiceStack` 传
  `researchFetch: researchNet.router.fetch`；
- 异常/正常退出统一经 `finish()`（或等价清理）关闭 HTTP server 与代理
  dispatcher（在途请求自然结束）。

`m158-p-survey-e2e.mjs` 额外：

- 新增 `--proxy-preflight` 零模型模式（六项探测 + 结构化结论后退出）；
- `--fresh` 的 preflight-1 从「全局 fetch 直连 arXiv 重试 3 次 + openalex 兜底」
  改为 `probeResearchNetwork`（经 Research router，代理模式下核心路径必须全通）；
- dry-run 增加 `research-fetch-wired` 自检项；driver log 记录代理来源与
  `router.stats()`。`--resume` / `--continue` 语义、journal、预算账本不变。

`m158-p-fulltext-backfill.mjs` 重写（正规化）：

- **正规通道优先且唯一**：`resolveFullTextBatch`（resolver 链 → `downloadPdf`
  的 SSRF 逐跳护栏 / 20MB 帽 / `%PDF-` 魔数 / arXiv 主机串行节流 → attachFile →
  provenance = resolver 名）。**移除**旧版「curl 下载 + attachManualFullText」
  回退——自动下载冒称用户手动上传违反 provenance 诚实性；
- fail-fast 预检（代理已配置且不可用 → 结构化退出 4）；
- 有界多轮 sweep（缺省 2 轮、轮间隔 10s；网络长波用多轮比内联重试高效）；
- **显式 docling 收尾**：`onFullTextAttached` 的 `ingestInBackground` 是进程内
  后台任务，脚本退出即被杀（实测 parsed=0 的原因）；脚本对已挂载但无结构化
  产物的条目做幂等同步解析；
- 分层如实记账：downloaded（文件 + resolver provenance）/ parsed（docling 结构化
  产物）/ chunked（检索 chunk）；grounded / verified 属 Evidence 核验管道（模型
  调用），本脚本 0 模型不触碰、不代答；
- 产物：`network-repair/fulltext-recovery-manifest.json`（每 sourceId 前后状态、
  SHA256、字节数、下载 URL、解析状态、router stats、代码版本）+
  `fulltext-recovery-summary.md`；`--report-only --targets=` 支持合并盘点。

### 2.3 arXiv export 镜像有界回退（downloadPdf）

`backend/src/search/fullText.ts`：`downloadPdf` 在 arxiv.org(`/www`) 的 `/pdf/`
路径下载失败（网络类：terminated / 超时 / 熔断 / 5xx·429 / 重定向超限）时，按
arXiv 官方 `export.arxiv.org` 镜像做**一次**有界回退。确定性失败（非 PDF 内容、
取消、SSRF 拒绝）不回退；每跳护栏照常；`finalUrl` 如实记录镜像地址
（provenance 可审计）。实测依据：`arxiv.org/pdf/2105.04322` 经代理
`ERR_HTTP2_STREAM_ERROR` 2/2 复现，同文件 export 镜像 2/2 稳定（4,993,185B）。
本次恢复的最终成功路径均为 arxiv.org 直连（h2 流错误为间歇性，sweep 2 恢复），
镜像回退作为护栏存在并被单测覆盖。

### 2.4 诊断脚本（可复现，零模型）

`scripts/m158-network-diagnose.mjs`：只读诊断——env/保存设置事实、7890 端口
HTTP+SOCKS5 能力、完整 OA PDF 三路 A/B（直连 / router 代理 / curl 显式代理）、
六项服务探测代理 vs 直连对照；产物 `proxy-diagnosis.json`（无凭据）。

## 3. 测试

新增 `backend/test/network/researchNetworkBootstrap.test.ts`（20 项，其中 1 项
live 门控）：

- bootstrap 语义：stored 启用生效 / env 覆盖（保存 disabled 不屏蔽 env）/ 无配置
  直连 / localhost·私网·单标签 bypass 计数；
- **真实 harness 集成**：UI 保存配置（无 env）下 bootstrap →
  buildServiceStack.researchFetch → ProviderHttpClient → downloadPdf 的 OA PDF
  下载走代理：`proxied > 0` 且直连假 fetch 零调用，provenance 记 resolver 名；
- probe 分类：PROXY_UNREACHABLE / ARXIV_PDF_TIMEOUT / TARGET_RATE_LIMITED /
  PASS（代理核心路径）/ 直连 openalex 兜底 PASS / ACADEMIC_UNREACHABLE；
- **脚本接线守卫**（回归对象）：7 个 m158 运行脚本必须装配 initResearchNetwork
  并传 `researchFetch`；survey/backfill 必须走 probeResearchNetwork；backfill
  不得再调 `attachManualFullText` / `execFile("curl")`；
- live（`PAPERTEAM_LIVE_NETWORK_TESTS=1` 门控，不入默认 CI）：真实 7890 全文件
  下载 2,215,244B / `%PDF-` / sha256，与 Phase A 三路对照一致。

`backend/test/search/fullText.test.ts` 追加 4 项：镜像回退成功（finalUrl=镜像）、
非 PDF 不回退、非 arxiv 主机不回退、镜像也失败时如实抛错（不递归）。

既有回归：network / settings / search / sources 全部通过；全量 backend 套件
exit 0；frontend typecheck 通过。测试 seam 优先级不变（`search.fetchImpl` /
`citation.fetchImpl` 显式注入仍优先于 researchFetch——mock 不被代理劫持）。

## 4. 真实恢复结果（p-6f05e6980fda，0 模型）

| 指标 | 值 |
| --- | --- |
| 恢复前 | 25 sources：9 available / 16 metadata_only |
| 恢复后 | 25 sources：23 available / 1 partial（S022 扫描件，文本层薄）/ 1 metadata_only（S011） |
| 恢复成功 | 15/16（S003 S005 S007 S009 S010 S013 S014 S015 S016 S017 S020 S022 S023 S024 S025） |
| 分层 | downloaded 15 / parsed（docling structured）15 / chunked 15；grounded·verified 未运行（0 模型边界） |
| 未恢复 | S011（DOI 10.1109/lcsys.2025.3573880，OpenAlex 明确无 OA PDF——真实 not_found，非网络问题） |
| 模型调用 | 0（预算账本硬顶 1，实测 calls=0；两轮 backfill + 合并盘点三进程均为 0） |
| 代理计数 | run1 routerProxied=41 / run2=17（学术请求全部经 7890；本机 API 旁路） |

已恢复条目均带：文件（%PDF- 头 + 字节数 + SHA256，见 manifest）、resolver
provenance（`oa-url`，URL 为最终下载地址）、chunk 检索可用；docling 结构化解析
由 `--report-only` 合并盘点轮补齐。原始清单：`network-repair/
fulltext-recovery-manifest.json` + `fulltext-recovery-summary.md`。

Evidence 边界保持：本次**不创建 / 不改写任何 Evidence**；grounded / verified 仍
属模型核验管道（未运行，未追加模型预算）。冻结的 selection / matrix / synthesis
未触碰；journal 与预算账本原样保留（backfill 账本为独立文件且 calls=0）。

## 5. 限制与如实声明

- S011 无法恢复是**合法 OA 不存在**（OpenAlex `not_found`），不是网络问题；
  「成功率 100%」不成立，为 15/16。
- S022（jaiai.org）为扫描版 PDF：文件已挂载、docling/chunk 可用性以实际产物为
  准，文本层薄（616 chars / 15 页图像），状态如实为 `partial`。
- arXiv 主 CDN 经代理的 `ERR_HTTP2_STREAM_ERROR` 为**间歇性**（本次最终全部
  直连成功）；镜像回退是护栏而非本批恢复的必要路径。
- OpenAlex / Semantic Scholar 的 429 为出口 IP 配额（与代理功能无关）。
- 本机 UI 保存的代理仍是 `enabled=false`；本次恢复经 env
  `PAPERTEAM_RESEARCH_PROXY_URL=http://127.0.0.1:7890` 注入。持久启用请走
  「设置 → 网络设置」（对正确装配的生产/脚本进程自动生效）。
- **不宣布 M15 完成**：M15 总目标仍须真实 Quality Gate PASS + Final PDF +
  负例/HITL 验收；本次仅修复网络与研究数据基础。

## 6. 结论

根因定性：**「harness 漏注入 researchFetch」与「本机网络直连学术站点不可达」
混合**（前者为主因、可修；后者为环境事实、由 7890 代理解决）；「走了代理但站点
仍故障」仅在 arXiv 主 CDN 间歇 h2 流错误上部分成立（镜像护栏 + 多轮 sweep 覆盖）。
真实经 7890 成功下载：是（15 篇恢复 + 3 篇不同论文完整下载验证：
1706.03762 / 2105.04322（export 镜像）/ S025 = 1902.03604，9,043,488B）。
metadata_only：16 → 1（S011 真实 not_found）。Verified Evidence 边界保留。0 LLM 成立。
