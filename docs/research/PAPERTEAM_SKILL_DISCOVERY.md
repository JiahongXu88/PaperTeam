# PaperTeam Skill Discovery — 科研类 Skill 生态调研报告

> 调研日期：2026-09-20 ｜ 调研方式：**PaperTeam 自身 Research Discovery 能力**（M6.3/M7.1 同源工具面）+ GitHub API 定向核查
> 性质：只读调研，未修改任何代码、未安装任何 Skill、未改变架构
> 姊妹篇：`PAPERTEAM_SELF_REVIEW_M7.md`（外部 AI Research **系统**对比）——本文聚焦可接入的** Skill / MCP 生态**，二者互补

---

## 1. Research Scope

### 1.1 调研目标

评估 2024-2026 开源社区中适合 PaperTeam 集成的科研类 Skill，覆盖五个类别：

| 类别 | 关注点 | 主要映射 Agent |
| --- | --- | --- |
| C1 Academic Writing | structure improvement / paragraph rewriting / academic tone / argument strengthening | Writer |
| C2 Literature Review | literature survey / related work / paper analysis / citation organization | Researcher |
| C3 Academic Reviewer | paper review / reviewer simulation / peer review | Reviewer |
| C4 AI Detection / Humanization | sentence variation / academic style normalization / reducing generic LLM patterns（**非**简单替换词） | Writer |
| C5 Research Agent | query planning / evidence collection / citation verification | Researcher / Evidence |

### 1.2 调研方法（复用 PaperTeam 自身能力）

**主检索 instrument = PaperTeam Research Discovery**，与 `m71d-selfreview-research.mjs` 完全同源的调用面：

- `createScholarlyTools(...)` 产出的 Agent 会话同款工具对象（`search_papers` / `search_web` / `save_candidates` / `lookup_paper`），服务栈 `buildServiceStack` 与 `backend/src/index.ts` 同源装配；
- Web Search 经仓库自带 SearXNG 模板（`docker/searxng/settings.yml`，cn.bing + baidu 引擎）以独立容器提供（`PAPERTEAM_SEARXNG_URL`）；
- 一次性脚本置于仓库外临时目录（工作区零污染），原始调用记录存 `%TEMP%\pt-skill-discovery\raw-search-results.json`（不进仓库）。

**补充 instrument**：GitHub REST Search API（`gh api`，已认证）——用于 star/fork/license/维护状态核查与 repo 定向检索。原因见 §1.4 能力边界。

### 1.3 检索计划与执行记录（搜索记录）

**Web 检索（search_web，经 SearXNG）**：24 个 query，**24/24 成功**（status=degraded = 部分引擎无响应，结果如实携带 degraded 事实）：

| 类别 | query 数 | tag 前缀示例 |
| --- | --- | --- |
| C1 writing | 4 | `scientific writing claude skill site:github.com` 等 |
| C2 litreview | 4 | `arxiv MCP server site:github.com` 等 |
| C3 reviewer | 3 | `LLM peer review simulation open source site:github.com` 等 |
| C4 humanize | 4 | `AI text detector / AI humanizer / academic paraphrase` 等 |
| C5 research agent | 5 | `deep research claude skill` / `K-Dense scientific skills` 等 |
| 生态锚点 | 4 | `anthropics skills` / `superpowers` / `awesome claude skills` / `modelcontextprotocol agents` |

**学术检索（search_papers）**：10 个 query（2024+ 为主），**59 条结果**，provider 健康如实：arXiv `ok`（主力）；OpenAlex HTTP 503 → 熔断（连续失败 ≥3 开路，30s 半开探测）；Semantic Scholar 429 限流 → 60s 冷却。高价值命中：

- *Scientific Agent Skills: A Library of Procedural Knowledge for Research Agents*（2026，arXiv:2609.00065——后经 GitHub 核查即 K-Dense 仓库配套论文）
- *Agent Skills for Large Language Models: Architecture, Acquisition, Security, and the Path Forward*（2026）
- *Adversarial Paraphrasing: A Universal Attack for Humanizing AI-Generated Text*（2025，C4 风险分析依据）
- *HalluCiteChecker* / *CiteCheck: Retrieval-Grounded Detection of LLM Citation Hallucinations*（2026/2025，引用核验同类工作）
- *Agent Laboratory* / *Can LLMs Generate Novel Research Ideas?*（研究 agent 佐证）

**查证（lookup_paper ≠ 检索）**：3/3 `match`（AgentReview EMNLP 2024 / AI Scientist / Si et al. 100+ NLP researchers）。
**候选落盘（save_candidates）**：3 次（a2-litreview-gen / a3-peer-review-llm / a4-ai-text-detection 各存 2 条，saved=2 merged=0），验证候选管线可用。

**GitHub API 补充**：~20 个 search query（五类关键词 + org 定向）+ ~40 次 repo 元数据核查 + 12 份 README 精读（含 K-Dense `scientific-writing` / `peer-review` 两个 SKILL.md 抽样）。

### 1.4 能力边界发现（本调研自身的方法学结论）

1. **SearXNG CN 引擎模板对 GitHub 生态覆盖弱**：24 个 web query 中 GitHub 域名命中仅 8 条、去重后 5 个 repo（且多为噪音，如 PaperMC——Minecraft 服务端）；结果被 baike.baidu / 词典站 / zhihu 占据。`site:github.com` 约束基本未被 cn.bing/baidu 遵守。**结论：PaperTeam Web Search 对"工程生态型"检索目标覆盖不足，学术库检索（arXiv）反而有效**——该缺口直接支撑 M8.2「Web Search 开箱可用」的优先级判断（当前模板面向文献场景调优）。
2. **学术 provider 当日健康**：OpenAlex 503 / S2 429，arXiv 单provider 仍产出 59 条可用结果——多源冗余设计经受住了单日双源故障。
3. star ≠ 维护（lishix520 / AI-Scientist 高star但停滞）；license 缺失在高star项目同样存在（199-bio）。

### 1.5 排除口径

按任务要求排除：纯 prompt 模板合集、无维护项目、低质量合集、与论文场景无关工具。生态 index 仓库（awesome 系列）仅作导航资源收录，不计入推荐。

---

## 2. Academic Writing Skills（C1）

### 2.1 K-Dense-AI/scientific-agent-skills ⭐ P0

| 项 | 值 |
| --- | --- |
| 名称 | Scientific Agent Skills（原 Claude Scientific Skills） |
| 地址 | https://github.com/K-Dense-AI/scientific-agent-skills |
| 类型 | Agent Skill 库（开放 Agent Skills 标准 + Agent Plugins 打包；Cursor / Claude Code / Codex / Antigravity 通用） |
| star/fork | **45,694 ★ / 4,149 f** ｜ MIT ｜ v2.68.0 ｜ 最近推送 2026-09-14（活跃） |
| 功能 | **166 个科研 skill**，覆盖生信/化学/临床/ML/材料/物理等 + 100+ 科学数据库；与 PaperTeam 直接相关的：`scientific-writing`（草稿/修订/审计，**显式 evidence provenance**、起草-验证-提交阶段分离、"不发明证据不隐瞒不确定性"、人类作者控制科学决策）、`peer-review`（证据有界的评审草稿 + 确定性本地 CLI，零网络/零模型调用）、`literature-review`、`research-lookup`、`bgpt-paper-search` |
| 适配 Agent | Writer（scientific-writing）、Reviewer（peer-review）、Researcher（literature-review / research-lookup） |
| 集成成本 | **低**（SKILL.md 为 Markdown 指令 + 可选离线 CLI；可只借鉴方法论，也可整包作 plugin 引入） |
| 优点 | ① 有 arXiv 论文（2609.00065）背书 ② CI 双工作流（security-scan + skill-tests）③ MIT ④ 哲学与 PaperTeam 高度同源：evidence provenance / 阶段分离 / 确定性 CLI / HITL（"accountable human authors control scientific decisions"）⑤ 规模最大、维护最勤 |
| 缺点 | ① 166 个 skill 绝大多数是湿实验/生信领域，与论文生产线无关，须**精选摘取**而非整包引入 ② 公司（K-Dense Inc.）主导，存在商业化引流（BYOK 产品导流） ③ skill 内容面向通用 agent，无 PaperTeam 式确定性 Gate 约束 |
| 推荐 | **P0——立即尝试**（先精读 `scientific-writing` v2.1 与 `peer-review` v2.2 两个 SKILL.md，对照 Writer/Reviewer 现有 prompt 找差距） |

### 2.2 WenyuChiou/academic-writing-skills ⭐ P0

| 项 | 值 |
| --- | --- |
| 地址 | https://github.com/WenyuChiou/academic-writing-skills |
| 类型 | Agent Skill（开放格式；Claude Code / ChatGPT / Codex / OpenCode / Hermes 兼容），双 skill：`academic-writing-skills` + `paper-review` |
| star/fork | 59 ★ / 7 f ｜ MIT ｜ v1.1.6 ｜ 2026-09-18（活跃）｜ **有 CI 测试** |
| 功能 | 稿件全生命周期：Research framing → 论证架构 → 扩展大纲（每段指定读者功能/可辩护论断/授权证据/推断边界/**nonclaims**）→ **Evidence-led drafting** → 双向对齐（top-down 与 bottom-up）→ 四遍全文评审（论证结构/证据范围/学术写作/交付完整性）→ 修订传播；`paper-review` 只评审不改稿 |
| 适配 Agent | Writer（主）+ Reviewer（paper-review skill） |
| 集成成本 | **低**（纯 Markdown skill，无依赖） |
| 优点 | ① 方法论与 PaperTeam 的 Evidence-first 惊人一致：每段先声明"授权证据"、显式 nonclaims（与 Claim Strength Gate 同型思想）② 双向对齐 ≈ PaperTeam 论断-引用语义核验的自上而下/自下而上双视角 ③ 有测试有版本管理，工程质量高于其 star 数 ④ 评审/写作分离尊重 HITL |
| 缺点 | ① star 低、单一作者，长期维护风险 ② 无代码级工具，全部靠指令约束 ③ 无中文文档 |
| 推荐 | **P0——立即尝试**（其"扩展大纲 + nonclaims + 双向对齐"可以直接增强 Writer 大纲确认与 Reviewer 审稿维度） |

### 2.3 K-Dense-AI/claude-scientific-writer（P1）

| 项 | 值 |
| --- | --- |
| 地址 | https://github.com/K-Dense-AI/claude-scientific-writer |
| 类型 | 单 skill（通用科学写作者）｜ 2,375 ★ / 273 f ｜ MIT ｜ 2026-08-19 |
| 功能 | 通用 scientific writer skill（scientific-agent-skills 的单件发行版形态） |
| 集成成本 | 低 |
| 优点/缺点 | 与 §2.1 的 `scientific-writing` 同源，能力被 166-skill 库覆盖；单件形态更轻 |
| 推荐 | **P1**——若只想要写作单件不想引整库，用这个入口 |

### 2.4 zLanqing/codex-claude-academic-skills（P1）

| 项 | 值 |
| --- | --- |
| 地址 | https://github.com/zLanqing/codex-claude-academic-skills |
| 类型 | 三 skill 套件（office-academic / research-writing / 科学计算）｜ 4,102 ★ / 228 f ｜ MIT ｜ 2026-05-14 |
| 功能 | 中文科研人员工作流：论文阅读报告、学术 PPT/Word 生成、论文写作 |
| 适配 Agent | Writer（及未来报告/交付物形态） |
| 集成成本 | 低-中（中文场景对齐 PaperTeam 中文用户群） |
| 优点 | 中文生态最高star学术 skill 套件；覆盖"论文→PPT/Word 报告"交付物链 |
| 缺点 | 更新间隔 4 个月；office 侧产物（docx/pptx）与 PaperTeam 的 LaTeX/Draft-Final 产物线不同构 |
| 推荐 | **P1**（作为中文写作 prompt 参考；交付物形态不同构，不直接接） |

### 2.5 其余 C1 候选（P2）

| 候选 | star | 判定理由 |
| --- | --- | --- |
| lishix520/academic-paper-skills | 1,318 ★ / MIT | strategist+composer 双 skill + **平台风格学习（分析 8-10 篇样本论文提取写作规范）**+ 7 维 35 点 reviewer 模拟；但 **2026-01 起停滞**，且哲学/交叉学科定位。风格学习方法论值得借鉴，仓库本身 P2 |
| delibae/claude-prism | 1,784 ★ | 离线优先的科学写作**工作台产品**（LaTeX+Python+100 skills 打包），不是可嵌入 skill——形态不匹配，P2 |
| cLin-c/paper-skill | 108 ★ / MIT | 学术写作/润色/评审/翻译 prompt 库——接近纯 prompt 模板合集，按口径排除，P2 |

---

## 3. Review Skills（C3）

### 3.1 wanshuiyin/Anti-Autoresearch ⭐ P0

| 项 | 值 |
| --- | --- |
| 地址 | https://github.com/wanshuiyin/Anti-Autoresearch |
| 类型 | 评审侧取证 skill（ARIS 生态外向审计件；Claude Code/Codex skill 形态）｜ 156 ★ / 8 f ｜ MIT ｜ 2026-09-09（活跃）｜ 母体 ARIS ~12.5k ★（arXiv:2605.03042） |
| 功能 | **第三方来稿审计**：46 条完整性模式 × 8 族（A 数值自洽 / B 方法与范围 / C baseline 诚信 / D 实验诚信 / E 引用诚信 / F 表面信号(封顶 minor) / G 证明推导 / H 评测设计），产出 **span 锚定的 reviewer-ready 报告**；显式**不做**不透明 AI 文本判定（无作者署名概率）；AI 写作风格印象单列**零判定权重**隔离区（integrity CLEAN 与风格印象解耦） |
| 适配 Agent | Reviewer（审稿维度）+ Evidence（核验模式词表） |
| 集成成本 | **低**（模式词表 + span 报告格式可直接借鉴；无需引入其代码） |
| 优点 | ① 哲学与 PaperTeam 完全同构：确定性检查、span 锚定、不做不透明判定、风格印象零权重隔离——等价于 PaperTeam 的"Gate 规则可解释 + Retrieved≠Verified≠Grounded" ② 8 族词表是现成的 Reviewer 审计清单扩充素材（H 评测设计/数据泄漏/LLM-judge 有效性是 PaperTeam 现有 13+ Gate 规则未覆盖的维度）③ 中英双 README |
| 缺点 | ① star 低、个人项目 ② 其 F 族（表面信号）与 PaperTeam 学术诚实定位需再审视边界 ③ 面向"审他人来稿"，与 PaperTeam 自产稿件的 Reviewer 闭环需裁剪 |
| 推荐 | **P0——立即尝试**（把 8 族模式词表映射进 Reviewer 三路审稿与 Quality Gate 规则候选清单；span 锚定报告格式对齐 PaperTeam 深链处理入口） |

### 3.2 Ahren09/AgentReview（P2）

EMNLP 2024 (Oral) 官方实现｜432 ★ / 54 f ｜ Apache-2.0 ｜ 2026-05-10。**评审过程模拟**（reviewer/AC/author 多 agent 动力学研究），定位是研究工具而非生产审稿器——与 PaperTeam Reviewer 的生产闭环不同构。P2（其评审阶段/角色分解可作 Reviewer 三路审稿的对照参考；M7 Self Review 已收录其论文）。

### 3.3 其余 C3 候选（P2）

| 候选 | star | 判定理由 |
| --- | --- | --- |
| xf686/Meet-Reviewer-2 | 44 ★ / MIT | "红队你的论文草稿" skill，思路（投稿前模拟 Reviewer 2 攻击）可借鉴，规模小 P2 |
| maxidl/openreviewer | 17 ★ / **无 license** | OpenReviewer 论文配套（ML 会议评审生成），2025-06 停更 + 无 license，P2 |
| Agents4Academia-AI/auto-reviewer | 10 ★ | 10 阶段 claim/evidence map 评审管线，思路与 PaperTeam 论断-引用核验同型但规模太小，P2 |
| FanBroWell/AI-paper-reviewer | 38 ★ | 通用 LLM 评审工具，无差异化能力，P2 |
| PaperDebugger/paperdebugger | 1,540 ★ | Chrome 扩展（Overleaf 内嵌）+ MCP 编排 Research→Critique→Revision；**AGPL-3.0** + 浏览器扩展形态与 PaperTeam 后端集成不匹配（PaperTeam 对 AGPL 一贯进程边界隔离，如 SearXNG），P2 |

---

## 4. Humanization / AI Style Reduction Skills（C4）

> PaperTeam 立场先行：目标是**学术风格归一化 / 消除泛 LLM 腔调 / 句式变化**（可验证的写作质量维度），**不是**规避 AI 检测（学术诚实边界）。任何 humanization 都必须被 Fact/Citation Preservation Gate 约束（数值/引用/协议不可触碰）。

### 4.1 epoko77-ai/im-not-ai（P1——方法论标杆）

| 项 | 值 |
| --- | --- |
| 地址 | https://github.com/epoko77-ai/im-not-ai（Humanize KR） |
| 类型 | CLI skill（Claude Code / Copilot CLI / Codex CLI / Gemini CLI；Claude Code plugin marketplace 可装）｜ **5,648 ★ / 611 f** ｜ MIT ｜ v2.3.2 ｜ 2026-09-06 |
| 功能 | 韩文 AI 痕迹去除：**10 大类 × 70 子模式**（翻译腔/机械并列/"결론적으로"式 AI 惯用语/被动滥用/句首连词滥用/emoji·bullet 滥用…），每模式带严重度 **S1/S2/S3**，**span 级探测**后润文；**内容一字不动，只改文体** |
| 适配 Agent | Writer（风格归一化 stage 的方法论蓝本） |
| 集成成本 | 中（语言绑定韩文——**引入的是方法不是 skill 本体**：模式清单 × 严重度 × span 探测 × 内容保持的框架） |
| 优点 | ① 恰好满足任务"不要简单替换词"的要求：模式库 + 严重度分级 + span 定位 ② "内容零改动"约束与 Fact Preservation Gate 同构 ③ 多 CLI 生态验证了工程形态 |
| 缺点 | ① 韩文专用，模式库不可直接复用于英/中文学术文本 ② 5.6k star 主要来自韩文社区 |
| 推荐 | **P1**——为 Writer 设计"学术风格归一化" stage 时，按此框架自建英/中学术模式库（S1/S2/S3 分级 + span 报告 + changelog） |

### 4.2 MADEVAL/HumanAI（P1）

37 ★ / 9 f ｜ MIT ｜ v4.0 ｜ 2026-07-12。任意 LLM 的 SKILL.md 系统：**5 阶段管线**（cleanup → specificity → tone → rhythm → proofread）、9 语言、单阶段可跳过（需声明理由）、输出带 changelog。本质是结构化 prompt skill（按口径处于"纯 prompt 模板"边界），但管线结构/changelog/模式声明机制值得 Writer 风格 stage 借鉴。**P1（轻量验证）**。

### 4.3 检测器与学术证据（P2——只作风险标定，不作集成）

| 候选 | star | 说明 |
| --- | --- | --- |
| YuchuanTian/AIGC_text_detector | 470 ★ / Apache-2.0 | ICLR'24 Spotlight（Multiscale PU detection）官方代码 |
| Imalwayshere/Open-Detector | 242 ★ / MIT | BERT 学术 AI 文本检测模型 |
| liamdugan/raid | 215 ★ / 98 f / MIT | ACL 2024 最大 AI 文本检测 benchmark |
| martiansideofthemoon/ai-detection-paraphrases | 205 ★ | NeurIPS'23：**改写即可绕过检测器**——humanization 与检测军备竞赛的实证 |
| ksanyok/TextHumanize | 77 ★ / NOASSERTION | 离线规则式 25 语言；license 不明，P2 |
| rudra496/StealthHumanizer | 137 ★ | **明确拒绝**：以"bypass GPTZero/Turnitin"为卖点，属检测规避取向，与 PaperTeam 学术诚实定位冲突 |

**学术证据（来自本次学术检索）**：*Adversarial Paraphrasing: A Universal Attack for Humanizing AI-Generated Text*（2025）与 DEFACTIFY 系列共享结论——检测器对针对性改写鲁棒性差。**风险结论：PaperTeam 不应把"过检测"作为任何 stage 的目标函数**；风格归一化的验收标准应是可解释的模式消除报告（im-not-ai 式），而非检测器得分。

---

## 5. Research Agent Skills（C5）

### 5.1 199-biotechnologies/claude-deep-research-skill（P1）

| 项 | 值 |
| --- | --- |
| 地址 | https://github.com/199-biotechnologies/claude-deep-research-skill |
| 类型 | Claude Code skill ｜ 1,048 ★ / 116 f ｜ **无 license（默认版权保留）** ｜ 2026-04-11 |
| 功能 | 8 阶段 deep research 管线、**source credibility scoring**、多 provider 搜索（Brave/Serper/Exa/Jina/Firecrawl 经其 search-cli）、自动验证、ultradeep 模式 |
| 适配 Agent | Researcher（M8.3 Research Plan / M8.4 受控多轮检索的对照设计） |
| 集成成本 | 低（借鉴方法论）——但**代码复用受 license 阻断** |
| 优点 | "source credibility scoring"与 PaperTeam metadata 可信分层 + provider 健康四态同型；8 阶段拆分粒度适合对照 M8.3 |
| 缺点 | 无 license；依赖付费搜索 API keys |
| 推荐 | **P1**（只读借鉴阶段划分与可信度评分维度） |

### 5.2 Weizhena/Deep-Research-skills（P1）

2,199 ★ / 178 f ｜ MIT ｜ 2026-08-23。两阶段（大纲生成→深度调查）**HITL 全程受控** skill，中英双语，方法论来自 arXiv:2511.18743（RhinoInsight：通过行为/上下文控制改进 deep research）。与 M8.3「Research Plan 一等产物」+ M8.4「受控多轮检索」的设想高度同型。**P1**（MIT 允许文本级借鉴；OpenCode 侧依赖 exa，Claude Code 侧依赖自有 web-search agent，PaperTeam 场景映射到自身 discovery）。

### 5.3 Galaxy-Dawn/claude-scholar（P1）

5,571 ★ / 436 f ｜ MIT ｜ 2026-08-27。半自动科研助手（Claude Code/Codex/Kimi/OpenCode 多分支），覆盖文献综述/编码/实验/报告/写作/项目知识管理。作为**工作流编排参考**（其阶段化+知识管理切分）有对照价值；本体是面向个人开发者的工作流合集，与 PaperTeam 产品形态不同构。**P1（对照参考）**。

### 5.4 blazickjp/arxiv-mcp-server（P1——技术点直击 Evidence 精度）

| 项 | 值 |
| --- | --- |
| 地址 | https://github.com/blazickjp/arxiv-mcp-server |
| 类型 | MCP server（PyPI `arxiv-mcp-server==0.7.2`，MCP Registry 收录）｜ 3,168 ★ / 258 f ｜ Apache-2.0 ｜ 2026-08-26 ｜ **有 CI 测试** |
| 功能 | 差异化能力：**原始 LaTeX 分节读取**（paper ID → outline → 单节 → citations 工作环）、arXiv metadata 生成 BibTeX、topic 订阅；论文本地落盘 |
| 适配 Agent | Evidence（quote 逐字核验精度）+ Researcher |
| 集成成本 | 低（技术借鉴：`arxiv-to-prompt` 式 LaTeX 源获取；同类还有 takashiishida/arxiv-latex-mcp 146★） |
| 优点 | PaperTeam 的 quote 核验当前消费 PDF 抽取文本（pymupdf block 边界断词曾致 false negative，见引用核验修复记录）；**arXiv 论文改用 LaTeX 源可消除抽取伪差**，M7.2 FullTextResolver 已具备同条目补挂 fulltext 的挂点 |
| 缺点 | 与 M7.2 存在能力重叠（须以"技术借鉴"而非"服务引入"方式落地）；非 arXiv 来源无 LaTeX 源 |
| 推荐 | **P1**——作为 M8 候选增强项登记：FullTextResolver 增加 `sourceType=latex` 精确 quote 通道 |

### 5.5 openags/paper-search-mcp（P1——provider 覆盖对照）

2,664 ★ / 275 f ｜ MIT ｜ 2026-08-17。多源检索（arXiv/**PubMed/bioRxiv**/OpenAlex…）MCP + CLI + **Claude Code skill 三形态**，free-first 原则、源透明（明示各源全文本能力差异）。对 PaperTeam 的价值：**PubMed/bioRxiv 是 PaperTeam discovery 未覆盖的源**（生医场景缺口）；其"源能力差异显式化"设计与 PaperTeam diagnostics 同型。注意其 Sci-Hub 通告区（灰区能力，PaperTeam 不可采用）。**P1（provider 扩展候选清单）**。

### 5.6 已在 M7 Self Review 评估过的系统型项目（P2，此处仅登记生态位置）

| 候选 | star/fork | license | 2026 状态 | 一句话判定 |
| --- | --- | --- | --- | --- |
| assafelovic/gpt-researcher | 29,538/4,017 | Apache-2.0 | 活跃 | 自主 deep research **系统**，非 skill；与 discovery 重叠，P2 |
| stanford-oval/storm | 31,453 | MIT | 2025-09 后缓 | 报告型 survey 生成系统，M7 已评估，P2 |
| Alibaba-NLP/DeepResearch | 19,975/1,527 | Apache-2.0 | 2026-02 后缓 | 通义 deep research 系统，报告生成为主，P2 |
| dzhng/deep-research | 19,703/2,000 | MIT | 2026-04 后缓 | 迭代式研究 assistant，无 skill 化形态，P2 |
| Future-House/paper-qa | 9,226/921 | Apache-2.0 | 活跃 | 引用接地 RAG 库（paper-qa2），**P1 保留**：其 citation-grounded 问答与 Evidence 综合视图（M8.6 研究 wiki）相关，M7 已收录 |
| SakanaAI/AI-Scientist | 14,591 | **NOASSERTION** | 2025-12 停 | license 受限 + 停更，P2 |
| SamuelSchmidgall/AgentLaboratory | 5,854 | MIT | 2025-08 停 | 人机协作研究工作流，停更，P2 |
| lingzhi227/agent-research-skills | 350/39 | 无 license | 2026-02 缓 | deep-research 学术综述 skill，无 license，P2 |
| 917Dhj/DeepPaperNote | 1,098/78 | MIT | 活跃 | 单论文深读→Obsidian 笔记，**阅读侧**（非生产侧），P2 |

### 5.7 生态与标准（导航资源 + 机制参考）

| 候选 | star | 定位 |
| --- | --- | --- |
| anthropics/skills | 177,224 | 官方 Agent Skills 仓库（**skills/ + spec/ + template/**）；无科研写作类 skill（docx/pdf/pptx/xlsx 为办公件）——**价值在格式规范与 skill-creator 模板**，非内容 |
| openai/skills | 27,495 | OpenAI 官方 Codex Skills Catalog；curated 内容以开发工具为主（figma/deploy/CI），**无科研 skill**——证明科研 skill 生态目前由社区（K-Dense 等）供给 |
| obra/superpowers | 288,956 | 通用开发方法论 skill 框架（MIT）；与科研无关，仅证明 skill 生态规模，P2 |
| ComposioHQ/awesome-claude-skills（75,361★）/ VoltAgent/awesome-agent-skills（34,626★） | — | 生态索引；VoltAgent 收录 1000+ agent skill（K-Dense/ARIS 均被收录） |
| O0000-code/awesome-academic-skills | 28 / CC0 | 学术 skill 专用索引（按场景组织），小而准，可作后续追踪清单 |
| K-Dense-AI/claude-skills-mcp | 404 / Apache-2.0 | **把 skill 库经 MCP 服务化的机制参考**（若 PaperTeam 未来以 MCP 暴露自身 skill 面） |

---

## 6. Recommended Integration（分级推荐）

### P0 — 建议立即尝试（均为"读与借鉴"级接入，零代码依赖）

| # | 候选 | 动作 | 预期收益 |
| --- | --- | --- | --- |
| P0-1 | **K-Dense-AI/scientific-agent-skills**（§2.1） | 精读 `scientific-writing` v2.1、`peer-review` v2.2 SKILL.md，逐条对照 Writer/Reviewer 现有 prompt 与 Review 三路维度，登记差距清单 | 45.7k★/MIT/CI/论文背书的证据化写作与评审方法论直接对齐 |
| P0-2 | **WenyuChiou/academic-writing-skills**（§2.2） | 借鉴"扩展大纲（每段授权证据+nonclaims）+ 双向对齐 + 四遍评审"进 Writer 大纲 stage 与 Reviewer 维度 | 与 Evidence-first/Claim Strength Gate 同型的方法论增强 |
| P0-3 | **wanshuiyin/Anti-Autoresearch**（§3.1） | 把 8 族完整性模式词表映射为 Reviewer 审计维度与 Gate 规则候选（重点补 H 评测设计/数据泄漏/LLM-judge 有效性）；采纳其 span 锚定报告与"风格印象零权重隔离"设计 | Reviewer 审计覆盖面扩充 + 报告可解释性范式 |
| P0-4 | （方法学）**本调研的 SearXNG CN 模板 GitHub 覆盖缺口**（§1.4） | 登记进 M8.2「Web Search 开箱可用」的需求依据 | 工程生态型检索目标的引擎/模板选型输入 |

### P1 — 后续验证

| # | 候选 | 验证点 |
| --- | --- | --- |
| P1-1 | epoko77-ai/im-not-ai（§4.1 方法框架） | 为 Writer 自建英/中学术风格模式库（S1-S3×span×内容保持）；验收=模式消除报告，**非检测器得分** |
| P1-2 | MADEVAL/HumanAI（§4.2） | 5 阶段管线在 GLM/Claude 双模型族下的稳定性（skill 对模型族敏感） |
| P1-3 | blazickjp/arxiv-mcp-server（§5.4） | FullTextResolver `sourceType=latex` 精确 quote 通道（对 quote 核验 false negative 的根治性） |
| P1-4 | openags/paper-search-mcp（§5.5） | PubMed/bioRxiv provider 扩展的必要性评估（生医用户场景） |
| P1-5 | 199-bio deep-research skill（§5.1）+ Weizhena Deep-Research-skills（§5.2） | 对照设计 M8.3 Research Plan / M8.4 受控多轮检索（license 注意：前者无 license 只读借鉴） |
| P1-6 | Future-House/paper-qa（§5.6） | citation-grounded 问答模式对 M8.6 研究 wiki 的参考（M7 已收录，保持追踪） |
| P1-7 | Galaxy-Dawn/claude-scholar（§5.3） | 工作流编排对照（含中文用户习惯） |
| P1-8 | K-Dense-AI/claude-skills-mcp（§5.7） | skill 服务化机制（若 PaperTeam 未来暴露 MCP 面） |

### P2 — 不建议（含明确拒绝）

- **系统型 deep research 项目**（gpt-researcher / storm / 通义 DeepResearch / dzhng）：产品形态为完整系统而非 skill，与 PaperTeam discovery/orchestrator 职责重叠，M7 已有结论。
- **停滞或 license 受阻**：AI-Scientist（NOASSERTION+停更）、AgentLaboratory（停更）、lingzhi227（无 license）、maxidl/openreviewer（无 license+停更）、199-bio（无 license，仅 P1 方法论借鉴）。
- **形态不匹配**：claude-prism（工作台产品）、paperdebugger（浏览器扩展+AGPL）、zotero-mcp（5,090★，优秀但 PaperTeam 有自有文献库；仅当需要 Zotero 导入桥时升级评估）。
- **接近纯 prompt 模板**：cLin-c/paper-skill 等。
- **明确拒绝**：rudra496/StealthHumanizer——以绕过检测器为卖点，与学术诚实定位冲突。
- **检测器类**（AIGC_text_detector / Open-Detector / RAID）：只作风险标定证据，不作集成目标。

---

## 7. Integration Proposal

> 总原则（不因引入 skill 而动摇）：**Evidence-first 不变、HITL 不变、确定性编排不变**。Skill 只增强 Agent 的"能力面"（prompt 方法论/工具模式），**流程控制仍在 TypeScript WorkflowOrchestrator，质量保证仍在确定性 Gate**——Skill 不能定义什么是证据（Agent 只能提案）、不能跳过人工决策点、不能替代 Gate 判定。

### 7.1 Researcher：检索规划方法论（对应 M8.3/M8.4）

- **借鉴对象**：Weizhena 两阶段 HITL、199-bio 8 阶段 + source credibility scoring、lingzhi227 systematic lit review。
- **做法**：把"大纲先行 → 逐题深查 → 每步 HITL 确认"提炼为 Researcher 的 Research Plan prompt 模板；source credibility 维度并入现有 **metadata 可信分层 + provider 健康四态**（不另起评分体系）；多轮检索循环仍由 orchestrator 控制（取消/预算/断点）。
- **可验证性**：Plan 产物一等化（M8.3 既定方向），每轮检索的 query→provider→diagnostics 全记录（现状已有），Exp4 评估场景验证召回不劣化。

### 7.2 Writer：证据化写作 + 风格归一化

- **写作方法论**：采纳 WenyuChiou 的"扩展大纲：每段绑定授权证据 + 推断边界 + nonclaims"，与现有 **writer formalOnly 视图（只认 verified 证据）** 叠加——大纲阶段就完成 evidence 绑定， drafting 阶段消费 formalOnly 视图。
- **风格归一化 stage**（新增，受 Gate 约束）：
  - 框架：im-not-ai 式「模式库（英/中学术版）× 严重度 S1-S3 × span 报告 × changelog」；HumanAI 式 5 阶段管线（cleanup→specificity→tone→rhythm→proofread）作 stage 内部结构。
  - **硬边界**：只动文体，数值/公式/引用/协议/方向性结论一律冻结——由 **Fact Preservation + Citation Preservation 双 Gate** 事后强制复核（篡改即拒绝冻结 Draft，现有机制）；HumanAI 的 changelog 输出对齐 PaperTeam 修订注释格式。
  - **验收口径**：模式消除报告（可解释），不以检测器得分为目标函数（§4.3 风险结论）。
- **HITL**：风格归一化作为修订计划中的一个可选项（用户勾选），产出仍走 outline→draft→review 常规链。

### 7.3 Reviewer：审计维度扩充

- **借鉴对象**：Anti-Autoresearch 8 族词表（重点 A 数值自洽/D 实验诚信/E 引用诚信/G 证明推导/**H 评测设计与数据泄漏**）+ WenyuChiou 四遍评审（论证结构/证据范围/学术写作/交付完整性）。
- **做法**：8 族 × PaperTeam 现有 13+ Gate 规则做映射表——已覆盖的（A↔Fact Preservation、E↔引用 Layer1/2）确认口径，未覆盖的（H 族评测设计、G 族推导义务）进 Gate 规则候选清单，按"确定性可实现"标准筛选（纯代码可判定的先做，需判断的进 Reviewer prompt 维度而非 Gate）。
- **span 锚定**：Reviewer 意见统一带章节/段落 span + 深链处理入口（对齐现有 ruleId→中文说明→深链模式）；"风格印象"类意见单独分区零权重（不进 Gate 判定）。

### 7.4 Evidence：quote 精度通道（对应 M7.2 延伸）

- **借鉴对象**：arxiv-mcp-server 的 LaTeX 分节读取（技术）/ arxiv-latex-mcp（arxiv-to-prompt）。
- **做法**：FullTextResolver 为 arXiv 来源增加 `sourceType=latex` 通道——quote 逐字核验优先消费 LaTeX 源（消除 PDF 抽取断词/block 边界伪差），fallback 保持现有 PDF 抽取；provenance 记录实际消费源。**不引入 MCP server 本体**，技术内化为 resolver 分支。
- **可验证性**：用历史 false negative case（pymupdf block 断词样本）做 A/B 回归。

### 7.5 工程接入形态与风险控制

| 风险 | 控制 |
| --- | --- |
| license 合规 | 只采纳 MIT/Apache-2.0/CC0 的文本级内容并保留 attribution（K-Dense/WenyuChiou/Anti-Autoresearch/Weizhena 均合规）；无 license 项目（199-bio 等）只读借鉴思想不复用文本 |
| skill=未经证实的声明 | 任何引入的写作/评审能力先进 **evaluation 场景**（M6.8 框架）做 A/B，未验证不进默认链 |
| 模型族差异 | skill 多为 Claude/Codex 写就；PaperTeam 六 Agent 可配 GLM/Claude/GPT 等——每个 skill 增强须在目标模型族上过一遍（M6.9 多模型评估管线可复用） |
| 供应链 | skill 指令可能引导 agent 调外部服务（exa/付费 API）——PaperTeam 接入面限定为 prompt 方法论与离线确定性 CLI（K-Dense bundled CLI 恰好零网络零模型，同型约束） |
| scope 蔓延 | 本报告全部为 P0"读与借鉴"级动作；任何代码级集成（如 7.4）走 M8 提案流程登记 |

---

## 附录 A：调研执行环境与复现要点

- PaperTeam Discovery 一次执行：`search_web` 24/24 成功（SearXNG 以独立容器运行，settings 模板=仓库 `docker/searxng/settings.yml`，经 `PAPERTEAM_SEARXNG_URL` 注入）；`search_papers` 10 次 59 结果（arXiv ok / OpenAlex 503 熔断 / S2 429 冷却——多源冗余生效）；`lookup_paper` 3/3 match；`save_candidates` 3 次 6 候选落盘。
- 原始调用记录：`%TEMP%\pt-skill-discovery\raw-search-results.json`（仓库外，含每次调用的 params/diagnostics/latency/结果）。
- GitHub 核查：`gh api search/repositories`（~20 query）+ `gh api repos/{repo}` 元数据（stars/forks/pushed_at/license）+ 12 份 README 与 2 份 SKILL.md 抽样精读。
- star/数据快照日期：2026-09-20（star 为时点值，仅供量级判断）。

## 附录 B：本次调研如实声明

- WebSearch 通用引擎通道当日配额受限，GitHub 生态维度改用 GitHub 官方 API 定向检索完成（§1.2 已注明分工）；PaperTeam 自身 discovery 的 web 面结论（§1.4 能力缺口）不受此影响，其 24 次 search_web 调用真实执行且 24/24 返回结果。
- 本报告为调研文档：未修改代码、未安装 Skill、未改变架构；P0 动作均为"阅读与对照"，代码级建议均需走 M8 提案流程。
