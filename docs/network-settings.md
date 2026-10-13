# 网络设置（Research Network Proxy）

> M13.8。适用对象：在公司 / 校园网络下访问 arXiv、OpenAlex、Semantic Scholar、Crossref
> 很慢或不稳定，但本机已经运行了一个本地代理软件（Clash / mihomo / FlClash 等）的用户。

## 1. 它只影响什么

**仅作用于学术检索、文献元数据核验和合法开放获取全文下载，不影响模型 API 连接。**

| 经过代理（启用后） | 始终不经过 |
| --- | --- |
| 学术检索：OpenAlex / arXiv / Semantic Scholar / AMiner | 模型 API 请求（Pi Runtime、公司模型网关、自定义模型 Provider、Test Connection） |
| Web 检索 Provider（SearXNG 等**公网**地址） | 本机 PaperTeam HTTP API（前端 ↔ 后端） |
| 文献元数据核验：Crossref / OpenAlex / Semantic Scholar / arXiv / Unpaywall / GitHub（软件引用） | docling 本地解析、LaTeX 编译 |
| 合法 OA 全文 PDF 下载（FullTextResolver → arXiv / Unpaywall / OpenAlex 直链） | Git / GitHub 与用户其它程序 |

旁路规则：回环（127.0.0.1 / ::1 / localhost）、私网（10/8、172.16/12、192.168/16 等）、
`.local` / `.internal` 后缀与**无点号的单标签主机名**（如 compose 服务名 `searxng`）始终直连。
因此本机 SearXNG 不会被送进代理；开启代理也**不会**自动启用 SearXNG（Web Search 仍按
`PAPERTEAM_SEARXNG_URL` 是否配置决定）。

实现边界：代理只注入到学术 HTTP 客户端（`ProviderHttpClient` / `ScholarlyHttpClient` /
软件引用核验）的 `fetchImpl`，**不**修改 Node 进程的全局 dispatcher；未启用时这些客户端
使用内建 `fetch`，行为与旧版本一致。

## 2. 配置入口与优先级

1. 环境变量 `PAPERTEAM_RESEARCH_PROXY_URL`（可选，`.env` 可补缺），例如
   `PAPERTEAM_RESEARCH_PROXY_URL=http://127.0.0.1:7890`。存在即覆盖 UI 保存值。
2. **设置 → 网络设置**（UI）：启用开关 / 代理类型（HTTP；SOCKS5 实验性）/ 代理地址（提示
   `127.0.0.1`）/ 代理端口（提示 `7890`）/ 保存 / 测试连接。保存到
   `<PAPERTEAM_RUNTIME_ROOT>/settings/network.json`（非敏感；默认 `~/.paperteam/settings/`）。
3. 都没有 = 直连。

保存后对**后续新请求**立即生效：旧的代理连接池优雅退役（等待在途请求结束，超过 5 分钟宽限才
强制释放），正在执行的任务不会被中断。不需要重启后端。

接受的 URL 形态：`http://host:port`、`socks5://host:port`（`socks5h` 同义）。必须显式带端口；
**不接受账号密码**（初版明确拒绝需要认证的代理，错误信息不回显 URL 原文）；不接受路径 / 查询。

## 3. 测试连接

「测试连接」用**当前表单值**（可以尚未保存）逐项探测并分类，不经过生产客户端的熔断 / 冷却状态：

| 项 | 目标 | 说明 |
| --- | --- | --- |
| 代理可连接性 | 代理 host:port | TCP 连接；拒绝连接 → 「请确认代理软件已启动且端口正确」 |
| arXiv API | export.arxiv.org | 检索接口 |
| arXiv PDF 下载（首段） | arxiv.org（固定探测对象 arXiv:1706.03762，只读首 256KB） | 校验 `%PDF-` 头、首字节耗时、吞吐估算 |
| OpenAlex | api.openalex.org | 匿名额度按**出口 IP** 的每日预算计；用尽为 429 + Retry-After（与代理无关；可申请免费 API Key） |
| Semantic Scholar | api.semanticscholar.org | 匿名限流 429 常见；`PAPERTEAM_SEMANTIC_SCHOLAR_API_KEY` 可配 |
| Crossref | api.crossref.org | 引用元数据 |

状态分类：`ok` / `rate_limited` / `http_error` / `timeout` / `proxy_unreachable` / `proxy_rejected` /
`network_error` / `not_pdf` / `skipped`。「核心路径通过」= 代理可连接（或直连）+ arXiv API + arXiv PDF 全部 `ok`；
OpenAlex / Semantic Scholar 的限流不算代理失败。关掉开关再点「测试连接」= 直连对照。

## 4. 真实测量（2026-10-13，公司 Windows 工作站，FlClash 混合端口 7890）

| 目标 | 直连 | HTTP 代理 | SOCKS5 代理 |
| --- | --- | --- | --- |
| arXiv PDF 1.7 MB | 200，50.9 s（≈34 KB/s） | 200，3.5 s | 200，3.3 s |
| arXiv PDF 1.5 MB | 90 s 超时（1.46 MB 未完） | 200，3.5 s（5.8 MB 版本） | 200，3.9 s |
| arXiv PDF 37 MB | 90 s 超时 | 200，19.2 s（≈1.9 MB/s） | 200，10.9 s |
| export.arxiv.org API | 200，2.7 s | 200，2.7 s | 200，3.1 s |
| api.openalex.org | 429（Retry-After ≈ 16.5 h） | 429（同） | 429（同） |
| api.semanticscholar.org | 429 | 429 | 429 |
| api.crossref.org | 200，1.4 s | 200，2.3 s | 200，3.7 s |

结论：代理把 arXiv 全文下载从「60 s 内下不完 1.3 MB」变成「秒级」；OpenAlex / S2 的 429 是出口
IP 的匿名额度问题，代理不能也不应掩盖它。37 MB 的 PDF 仍受 20 MB 文件上限约束（独立问题）。

## 5. 安全

- 代理 URL 不接受 userinfo；配置文件与日志不含任何凭据；模型 API Key 从不经过代理。
- 全文下载的 SSRF 护栏（仅 https / 无 userinfo / 443 / 拒绝内网地址）、重定向逐跳校验、
  20 MB 大小帽、`%PDF-` 魔数校验在代理下不变。
- 取消（AbortSignal）、超时、重试、退避、熔断、429 冷却全部在 HTTP 客户端层，与出口无关。
- 代理不可用时如实报错（`研究代理不可连接（http://127.0.0.1:7890）：ECONNREFUSED`），不会伪装成功。

## 6. HTTP API

见 `docs/API_CONTRACT.md` §1.2n：`GET|PUT /api/settings/network`、`POST /api/settings/network/test`。
