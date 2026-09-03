# PaperTeam 产品需求文档（PRD）

> 2026-09-03 产品设计冻结版：明确"从研究 Idea 到论文交付 + 已有论文改造"的双工作流定位、
> Target Feasibility Assessment、少量专业 Agent + Skill、确定性 Workflow 编排与
> Build Gate / Quality Gate 分离。已实现范围以 [PROJECT_STATUS.md](PROJECT_STATUS.md) 为准。

## 1. 产品概述

### 1.1 产品名称

PaperTeam

### 1.2 产品定位

PaperTeam 是一个**从研究 Idea 到论文交付、以及已有论文系统性改造的 AI 多 Agent 学术研究与论文生产工作台**（AI Multi-Agent Academic Research & Paper Workbench）。

核心链路：

```text
Idea → Research → Feasibility → Evidence → Writing → Review → Revision → LaTeX / PDF
```

系统不只是"论文写作 Agent"。写作只是链路的一环：在写作之前，系统先做领域调研、
Related Work、Research Gap、Novelty / Contribution 分析与目标可行性评估；在写作之后，
系统做引用核验、学术审稿、文风审查与有界修改闭环。对已有论文，系统支持导入、
理解、审计与逐节改造。

系统支持两类一级工作流：

1. **Idea-to-Paper**：从研究 Idea 出发，经调研、可行性评估与用户确认，产出新论文。
2. **Existing-Paper Improvement**：导入已有 LaTeX 论文项目，系统性理解、审计与改造。

系统采用"本地浏览器 + Linux 服务器"的使用方式。用户只需通过浏览器操作，Agent 调度、
模型调用、LaTeX 编译、PDF 生成、版本管理、日志与系统维护等工作均由服务器完成。

### 1.3 产品目标

1. 覆盖从研究 Idea 到论文交付的完整链路，而不只替代"打字写论文"环节。
2. 支持已有论文（LaTeX 项目）的系统性改造与提升。
3. 让非技术用户无需接触命令行、Git、LaTeX 环境或 OpenClaw 配置即可使用。
4. 建立可重复执行、可恢复、可暂停等待用户输入（HITL）的论文生产工作流。
5. 将论文内容质量、事实真实性、引用完整性、AI 文风风险以直观方式展示，并用明确的
   Gate 控制论文能否标记为 Final。
6. 对目标论文档次做出诚实的可行性评估，不承诺现有研究条件无法支撑的目标。
7. 支持长期部署在 Linux 服务器上，通过浏览器进行日常使用与系统维护。
8. 为未来替换或扩展 Agent Runtime 保留统一接口边界。

### 1.4 产品原则

以下原则是 PaperTeam 的产品底线，同时约束 PRD 与后续架构实现：

1. **诚实的 Target Feasibility Assessment**：系统必须基于现有 Idea、Novelty、Evidence、
   实验条件与 Methodology 诚实判断目标论文层级能否被支撑；无法支撑时明确说明差距，
   而不是声称可以达到（见第 8 章）。
2. **Evidence-based Writing**：写作优先基于项目文献库与 Evidence Store；缺乏可靠来源时
   显式标记证据不足，不为完成文字而虚构论文、数据或引用。
3. **Workspace 是事实来源**：`manuscript/`、`sources/`、`evidence/`、`reviews/`、
   workflow state 与 artifacts 是 Authoritative State；`context.yaml` 等是可重建的
   Derived Context；OpenClaw Session 只是可丢弃的 Runtime Context。业务流程不能依赖
   Chat History 才能恢复（见 9.6）。
4. **确定性编排**：流程状态、Stage 推进、重试、超时、Checkpoint、分支与循环由后端
   确定性代码（WorkflowOrchestrator）负责；LLM 只负责内容理解、语义判断、论文分析与
   审稿。不使用 LLM Agent 做流程编排（见第 7 章、第 9 章）。
5. **少量专业 Agent + Skill**：Agent Team 保持小规模（Researcher / Writer / Reviewer /
   Citation）；角色细化优先通过 Skill 完成，不持续拆分新 Agent（见第 7 章）。
6. **Build Gate 与 Quality Gate 分离**：能否编译与是否达到质量要求是两个独立判定；
   Quality Gate 失败不阻止 Draft PDF 生成，但阻止标记 Final（见第 10 章）。
7. **有界迭代**：修改循环必须有最大轮数上限，超限进入 Human Checkpoint，不无限自动循环。
8. **可恢复**：WorkflowRun 记录 checkpoint，失败/中断后可 resume；恢复依据是 Workspace
   状态而非对话历史。

---

## 2. 目标用户

### 2.1 普通用户

主要包括：

- 本科生
- 硕士研究生
- 博士研究生
- 科研人员
- 教师

普通用户主要关注：

- 提出研究 Idea 并获得领域调研与可行性评估
- 上传论文和资料（文献 / 参考论文 / 已有 LaTeX 项目）
- 继续撰写论文、修改章节
- 进行论文审稿与逐节改造
- 查看事实问题与引用核验结果
- 查看 AI 文风风险
- 查看 Draft / Final PDF
- 查看历史版本

### 2.2 管理员

管理员主要负责：

- 查看服务器运行状态
- 查看 OpenClaw Gateway 状态
- 管理 Agent 与 Skill
- 配置模型
- 查看任务、WorkflowRun 与 Session
- 查看日志
- 修改系统配置
- 运行系统诊断
- 重启相关服务
- 查看和管理服务器文件
- 在必要时通过 Web Terminal 操作服务器

---

## 3. 整体系统架构

```text
用户浏览器
   │
   ▼
PaperTeam Web
   │
   ▼
PaperTeam Backend
   │
   ├── Project / Evidence / Artifacts（事实来源）
   ├── WorkflowOrchestrator（确定性流程编排，不是 Agent）
   ├── Runtime（AgentRuntimeAdapter，唯一 Agent 入口）
   ├── LaTeX（编译与 Build Gate）
   ├── PDF（编译输出与页面渲染）
   ├── File / Version（文件与 Git 版本管理）
   └── Admin（系统管理后台）
   │
   ▼
OpenClaw Gateway（Agent Runtime）
   │
   ├── Researcher    领域调研、文献检索、Evidence 生成、可行性分析
   ├── Writer        基于大纲与 Evidence 的分节写作与修改
   ├── Reviewer      审稿（fact / academic / style 三类 Skill）
   └── Citation      引用核验与 references.bib 治理
   │
   ▼
Linux Server
   ├── Paper Workspace（projects/）
   ├── LaTeX Environment
   ├── Git Repository（论文版本）
   ├── PDF Renderer
   ├── Model Providers
   └── Logs
```

详细架构（含 WorkflowRun / StageContract / 事件分层 / Session contextScope）见
[ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 4. 页面结构

系统提供两种主要工作模式：

### 4.1 论文工作台

面向普通用户。

主要页面：

1. 首页看板
2. 我的论文（按 Idea-to-Paper / Existing-Paper Improvement 两类项目展示）
3. 新建项目（两类入口，见 5.1）
4. 论文写作
5. 论文审稿
6. 文献与证据（项目文献库 + Evidence Store + Reference Paper）
7. PDF 查看
8. 历史版本
9. 项目设置

### 4.2 系统管理

面向管理员。

主要页面：

1. 系统状态
2. OpenClaw
3. Agent 管理
4. 模型管理
5. Workflow 配置
6. 日志
7. 文件管理
8. 系统诊断
9. Command Center
10. Web Terminal

页面顶部提供明显的模式切换入口：

```text
[论文工作台] [系统管理]
```

---

## 5. 论文项目管理

## 5.1 两类项目入口

新建项目时，用户首先选择一级工作流类型：

```text
○ 从研究 Idea 开始（Idea-to-Paper）
● 导入已有 LaTeX 论文（Existing-Paper Improvement）
```

两类项目共用同一套 Workspace 结构、文献库、Evidence Store、审稿与修改闭环；
差异只在前置阶段（调研/可行性 vs 导入/理解/审计）与最终产物形态。

## 5.2 Idea-to-Paper：新建项目输入

用户输入：

- **研究 Idea**（必填，自然语言描述）
- **研究领域**（必填）
- **已有材料**（可选：实验数据、笔记、草稿、前置工作说明等）
- **documentType**：目标论文类型（见 5.4）
- **targetProfile**：目标论文档次（见 5.4）
- **targetVenue**（可选）：目标具体期刊 / 会议 / 高校要求（见 5.4）
- **可选参考论文 PDF**：可标记为 reference / evidence / both（见 6.11）
- 语言、备注

产品行为约定：

- 新项目创建后，系统**不直接进入写作**；先由 Researcher 完成领域调研与
  Target Feasibility Assessment，产出调研报告与可行性结论，经用户确认后才进入
  Evidence / Outline / Writing（见 9.2）。
- 用户可以随时在项目设置中调整 targetProfile / targetVenue；调整后系统在下一个
  Checkpoint 重新评估可行性。

## 5.3 Existing-Paper Improvement：导入已有论文

MVP 阶段仅支持 **LaTeX 项目**导入，例如：

```text
main.tex
sections/*.tex（或 chapters/*.tex）
references.bib
figures/
```

**当前阶段不支持 DOCX → LaTeX 转换**（进入 backlog，未来单独评估）。

导入行为：

- 系统解析项目结构（入口文件、章节文件、bib、图表资源）
- 执行 **Baseline Compile**：先验证原项目在服务器 LaTeX 环境下能否编译，记录基线
  编译状态与产物
- 原始导入内容做版本快照，后续改造在快照之上进行，可回溯

导入后的流程见 9.3。

## 5.4 documentType / targetProfile / targetVenue

目标定位使用**三个不同维度**表达，不使用单一 `paperLevel` 混用：

- **documentType**：论文的类型形态。示例：
  - undergraduate_thesis（本科毕业论文）
  - master_thesis（硕士学位论文）
  - doctoral_thesis（博士学位论文）
  - journal_article（期刊论文）
  - conference_paper（会议论文）
- **targetProfile**：论文的目标档次。示例：
  - 普通课程论文
  - 本科毕业论文 / 本科优秀毕业论文
  - 硕士学位论文 / 博士学位论文
  - 普通期刊 / 核心期刊 / 高水平期刊
  - 普通会议 / 高水平会议 / 顶会 / 顶刊
- **targetVenue**（可选）：具体目标 venue 或要求来源。示例：
  - CVPR、NeurIPS、IEEE TSE
  - 具体中文期刊
  - 具体高校的论文格式与评审要求

> 以上为概念模型与示例枚举，**本轮不冻结最终 enum 值**；实现时由数据模型统一定义，
> 并允许 targetProfile 与 targetVenue 组合使用（如 journal_article × 核心期刊 ×
> 《计算机学报》）。

targetProfile / targetVenue 会影响：

- Target Feasibility Assessment 的评判基准（见第 8 章）
- Reference Style Profile 的参考维度选择（见 6.12）
- Academic Review 的评审标准与 Quality Gate 的通过条件（见第 10 章）

## 5.5 项目目录结构

创建后自动生成论文项目目录：

```text
projects/thesis-001/
├── manuscript/          # 论文正文（main.tex、sections/）
│   └── sections/
├── figures/
├── tables/
├── sources/             # 项目文献库（原始文件与解析产物）
│   ├── papers/          # 原始论文文件（PDF / BibTeX 等）
│   ├── parsed/          # 解析后的结构化内容
│   └── metadata/        # 文献元数据
├── evidence/            # Evidence Store 数据
├── reviews/             # 审稿报告
├── data/
├── build/               # 编译产物（Draft / Final PDF）
├── context.yaml         # Derived Context（可重建，非事实来源）
├── workflow/            # WorkflowRun 状态与 checkpoint
└── project.json
```

目录约定说明：

- `sources/` 承载项目文献库的原始论文与解析产物，`evidence/` 承载 Evidence Store 数据，
  原始论文、解析数据、Evidence 三者保持清晰边界，不混用
- `manuscript/`、`sources/`、`evidence/`、`reviews/`、`workflow/` 与 build artifacts
  是 Authoritative State；`context.yaml` 及 outline summary、section status、
  terminology summary 等是 Derived Context，可随时由事实来源重新生成
- 以上为逻辑划分；检索索引等派生产物的物理存放位置由实现决定

## 5.6 项目首页

显示：

- 论文名称、项目类型（Idea-to-Paper / Existing-Paper Improvement）
- documentType / targetProfile / targetVenue
- 当前 WorkflowRun 状态（含 awaiting_input 提示）
- 当前版本（Draft / Final 标记）
- 当前章节进度
- 学术质量评分、事实可信度、AI 文风风险、引用完整度
- 当前严重问题数量
- 最近一次编译时间与最近一次审稿时间
- Target Feasibility 结论（若已评估）

主要操作：

- 继续 / 恢复工作流
- 全面审稿
- 查看 PDF
- 上传资料
- 查看问题
- 查看历史版本

---

## 6. 资料上传与文献管理

## 6.1 项目文献库（Project Literature Library）

每个论文项目拥有一个独立的项目文献库，作为该项目全部参考文献及其解析内容的统一存放与检索单元：

```text
论文项目 A → 项目文献库 A
论文项目 B → 项目文献库 B
```

基本约定：

- 默认情况下，不同项目之间的文献、检索索引与 Evidence 相互隔离
- 第一版不建设跨项目的全局公共文献知识库
- 项目文献库的生命周期与论文项目绑定：
  - 用户关闭浏览器后仍然保留
  - 后续继续该论文时仍可使用
  - 删除论文项目时，可随项目一起删除
  - 用户可主动从项目文献库中删除某一篇文献
- 项目文献库是一项产品能力，不与任何具体存储或数据库技术绑定；第一版允许采用轻量级
  本地存储与索引实现，具体选型由后续 Architecture / ADR 决定

「文献与证据」页面是项目文献库的管理入口。

## 6.2 添加参考文献

在「文献与证据」页面提供明显的「添加参考文献」入口。

最终产品能力覆盖以下来源（第一版实现时可分阶段支持）：

- 上传本地 PDF
- 上传 BibTeX
- 输入 DOI 导入
- 输入 arXiv 链接 / ID 导入
- 输入论文 URL 导入

除参考文献外，项目仍支持上传一般性资料：

- PDF、DOCX、TXT、Markdown、CSV、XLSX、PNG、JPG、BibTeX

支持拖拽上传。上传的资料统一存放于项目 `sources/` 目录（见 5.5），其中被识别为文献的
条目纳入项目文献库管理。

## 6.3 文献识别

文献进入项目文献库后自动提取：

- 标题、作者、年份、DOI、来源、摘要、关键词

## 6.4 文献来源

系统区分文献进入项目文献库的方式：

- USER_ADDED：用户主动上传或导入
- AGENT_RETRIEVED：Researcher 网络检索获得

「用户上传」只说明文献的进入方式，不代表其内容绝对可信。USER_ADDED 不等于事实意义上的
Trusted 来源，用户上传的文献同样需要经过 Evidence 提取与核验流程。

## 6.5 文献状态

每篇文献具有明确的生命周期状态：

- 解析中：正在提取元数据与正文
- 可使用：解析完成，可被 Agent 检索与引用
- 信息待确认：元数据缺失或存疑（如缺少 DOI），需用户确认
- 验证通过：文献内容与引用信息经过核验
- 已拒绝 / 不建议引用：质量不满足要求或被判定不适合引用
- 解析失败：无法解析，可重新上传或删除

## 6.6 重点参考（Preferred Reference）

用户可将某篇文献标记为「重点参考」：

- Agent 检索、Evidence 提取与写作时提高该文献的优先级
- 标记在前端可见，可随时取消

## 6.7 文献解析与项目级检索

文献加入项目文献库后，系统需要建立可供 Agent 使用的结构化内容：

```text
PDF / 文献
   ↓
元数据提取
   ↓
正文解析
   ↓
按章节 / 段落等合理粒度建立可检索内容
   ↓
项目级检索索引
   ↓
Researcher / Writer / Reviewer / Citation 查询
```

以上为产品能力要求，不限定必须使用特定关系型数据库或向量检索实现；第一版允许采用
轻量级本地存储与索引，具体技术由后续 Architecture / ADR 决定。

## 6.8 文献管理能力

用户在「文献与证据」页面可以：

- 查看已添加的论文列表
- 搜索文献
- 删除文献
- 查看解析状态
- 查看标题、作者、年份、DOI、来源等元数据
- 标记 / 取消「重点参考」
- 设置 / 修改 sourceRole（evidence / reference / both，见 6.11）
- 查看某篇文献产生了哪些 Evidence
- 查看某篇 Reference Paper 生成的 Style Profile 摘要（见 6.12）
- 查看论文正文中哪些引用使用了这篇文献

## 6.9 Evidence Store

系统为每个项目建立 Evidence Store。分工：

- Project Literature Library：保存和检索「原始参考资料」
- Evidence Store：保存「从原始资料中提取出来、能够支撑论文具体 Claim 的证据」

二者构成上下游关系：

```text
Project Literature Library（原始文献）
        ↓
Researcher 阅读 / 检索
        ↓
Evidence Store（结构化证据）
        ↓
Writer / Reviewer（fact review skill）/ Citation
```

Evidence 必须能够反向定位原始文献。数据模型草案（字段方向，见第 23 章）：

```json
{
  "evidence_id": "E023",
  "claim": "该 Evidence 支撑的具体观点",
  "evidence": "证据内容摘要",
  "quote": "原始文献中的直接引文（可选）",
  "source": {
    "paper_id": "P012",
    "title": "",
    "authors": [],
    "year": 2026,
    "doi": "",
    "url": ""
  },
  "location": { "page": 7, "section": "4.2", "chunk": "para-12" },
  "verificationStatus": "verified",
  "verificationMethod": "fulltext_quote_match",
  "supportStrength": "direct",
  "verificationLevel": "fulltext",
  "relatedSections": ["sections/introduction.tex"],
  "usedBy": ["draft-v3"],
  "createdBy": "researcher",
  "createdAt": "2026-09-03T00:00:00Z"
}
```

关键字段语义：

- **verificationStatus**（核验状态）：`unverified / verified / plausible / mismatch /
  unverifiable / not_found`
- **supportStrength**（支撑强度）：`direct / partial / indirect / contradictory` —— 表达
  证据与 claim 的语义支撑关系，是 Quality Gate 的重要依据
- **verificationLevel**（核验深度）：`metadata / abstract / fulltext / user_confirmed` ——
  表达核验依据看了多深（仅元数据、仅摘要、全文、用户人工确认）
- **verificationMethod**：核验方式（如全文引文匹配、元数据交叉验证、用户确认等）
- **relatedSections / usedBy**：证据与论文章节、版本的关联，支持引用反查
- **confidence**（数值）：仅作为辅助字段，**不得成为 Quality Gate 的核心判定依据**。
  系统不依赖 LLM 自评的 `confidence = 0.94` 这类虚假精确数字做关键决策

**存储口径**：EvidenceStore M3.1 默认采用文件优先——项目级 `evidence/evidence.jsonl`
作为持久化存储。EvidenceStore 保持接口抽象；M3 阶段项目内查询优先使用内存索引 /
文件扫描等轻量实现，**不提前引入数据库**；SQLite 是否引入以及具体索引方式，待真实
出现数据规模、查询性能、并发或跨项目检索需求后再评估。

Evidence 不应成为与原始论文失去关联的孤立文本。Evidence 用于：

- Writer 写作（只用可支撑的 Evidence 支撑论述）
- Reviewer 的 fact review skill（核验正文 Claim）
- Citation Agent（引用与 bib 治理）
- Reviewer 的 academic review skill（判断论据充分性）

## 6.10 资料检索范围控制

用户可为论文任务选择资料检索范围：

- 仅使用当前项目文献库
- 优先使用项目文献库，证据不足时允许网络检索
- 允许 Researcher 自由补充外部文献

默认采用：

> 优先使用项目文献库，证据不足时允许 Researcher 补充网络检索。

前端可表现为：

```text
参考资料范围：
○ 仅项目文献库
● 优先项目文献库，不足时联网检索
○ 允许自由检索
```

该设置约束 Researcher 的检索行为（见 7.2）。

## 6.11 Evidence Source 与 Reference Paper（sourceRole）

用户上传的论文 PDF 具有两种**不同语义角色**，系统不将其混为一个概念：

### Evidence Source（证据来源）

回答：**"这篇论文说了什么？"**

用于：

- Literature Research
- Evidence Extraction
- Claim Verification
- Citation

### Reference Paper（参考范文）

回答：**"这类论文通常怎么写？"**

用于：

- 论文结构参考（章节组织、章节比例）
- Argument Structure（Introduction 论证链、Related Work 组织方式）
- Method 呈现方式、Experiment 组织方式
- Figure / Table 风格、Citation Density
- 页面布局与视觉呈现

### sourceRole

每篇上传论文可标记：

```text
sourceRole:
- evidence    仅作为证据来源
- reference   仅作为写作参考
- both        两者皆是（默认可设为 both）
```

sourceRole 可在「文献与证据」页面随时修改；同一篇论文在不同角色下进入不同的处理
链路（evidence → Evidence 提取与核验；reference → 多模态结构分析，见 6.12）。

## 6.12 Reference Paper 多模态分析（Reference Style Profile）

Reference Paper 不只做文本抽取。未来由 **Multimodal Paper Analysis** 能力对参考论文进行
结构、方法与呈现模式分析，覆盖：

- Abstract 信息组织
- Introduction 论证链
- Related Work 分类与组织方式
- Method 章节图文关系
- Experiment 结构（Benchmark / Baseline / Ablation 的组织）
- Figure / Table 的使用方式
- 每章节长度与图表密度、引用密度
- 页面布局与视觉呈现方式

分析产物是 **Reference Style Profile**（结构化风格画像），例如：

- 常见章节结构
- 平均章节比例（如 Experiment 占比）
- Figure / Table 使用方式
- Method 章节组织模式
- Related Work 风格
- 该 documentType / targetProfile 下常见的写作模式

Style Profile 供 Writer（章节规划与呈现方式）与 Reviewer（结构合理性）使用。

> **产品边界**：参考论文用于"结构、方法与呈现模式分析"，**不是内容抄袭**。系统不将
> Reference Paper 的内容、图表或文字复制进目标论文；其价值只体现在风格画像层面。

---

## 7. Agent Team

## 7.1 编排原则：WorkflowOrchestrator 不是 Agent

论文流程编排由 Backend 的 **WorkflowOrchestrator** 负责，它是**确定性的 TypeScript
代码，不是 LLM Agent**：

- **代码负责**：状态、Stage 推进、retry、timeout、checkpoint、resume、branch、loop、
  hard gate
- **LLM（Agent / Skill）负责**：内容理解、语义判断、论文分析、审稿

原设计中作为流程控制 Agent 的 **Paper Manager 不再存在**（见 DECISIONS D-0008；
历史规划见 7.8）。

## 7.2 Researcher

职责：

- **Idea Research**：根据研究 Idea 与领域做领域调研，产出领域现状、Related Work、
  Research Gap、Novelty / Contribution 分析（Idea-to-Paper 前置阶段）
- 参与 Target Feasibility Assessment 的证据收集（见第 8 章）
- 根据资料检索范围检索文献：优先项目文献库与已有 Evidence，不足时受控补充网络检索
  （见 6.10）
- 阅读用户上传文献（Evidence Source 角色）
- 提取可引用事实，生成 Evidence，标记证据不足部分
- 为 Writer 和 Reviewer 提供研究材料

检索策略：

- 默认优先搜索项目文献库和已有 Evidence
- 网络检索获得的新论文可进入项目文献库，来源标记为 AGENT_RETRIEVED，先作为候选文献，
  经解析与确认后再用于写作与引用
- 「重点参考」文献在检索与 Evidence 提取中享有更高优先级（见 6.6）

## 7.3 Writer

职责：

- **Section-based Writing**：根据大纲、已有正文、Evidence、Reference Style Profile 和
  用户要求**分节**撰写内容（不一次性生成整篇论文）
- 优先基于已有 Evidence 和项目文献库写作，引用须指向项目文献库中的真实文献
- 不得为了完成文字而虚构论文、数据或引用
- 缺乏可靠来源时，显式标记证据不足，不强行生成看似有据的内容
- 输出 LaTeX，使用统一引用格式，保持章节结构和术语一致性
- **Revision**：根据 Reviewer 汇总意见逐节修改论文（有界修改闭环中的一环，见 9.5）

## 7.4 Reviewer

Reviewer 是一个 Agent，通过**不同 Skill** 承担三类审稿视角；三类 skill 可并行执行
（有限 fan-out / join）：

### fact checking skill

- 将正文拆分为 factual claims
- 对每个 claim 查询 Evidence，必要时回读项目文献库原始文献
- 沿可追溯链路核验：正文引用 → Evidence → 原始论文具体位置（页码 / Section / 段落）
- 输出结构化事实审查结果

核验结论状态：

- SUPPORTED
- PARTIALLY_SUPPORTED
- UNSUPPORTED
- CONTRADICTED

问题等级：critical / major / minor

### academic review skill

- 从学术审稿角度评价论文质量：问题定义、方法合理性、创新性、实验设计、消融实验、
  结果解释、逻辑完整性、相关工作覆盖度
- 结合 targetProfile / targetVenue 的评审标准
- 输出学术评分及问题列表

建议评分维度（示例，权重可按 documentType 调整）：

| 维度 | 分值 |
|---|---:|
| 问题定义 | 20 |
| 方法合理性 | 20 |
| 实验充分性 | 20 |
| 论证逻辑 | 20 |
| 写作质量 | 20 |

### style review skill

- 检查模板化表达、连接词滥用、重复句式、段落结构机械化、空洞评价、信息密度、
  无证据评价词、不必要总结
- 输出 AI 文风风险评分（0~100）、问题位置、问题类型、修改建议

## 7.5 Citation

职责：

- 核验正文引用与 references.bib 的一致性
- 逐条核验 bib 条目的真实性（标题 / 作者 / 年份 / DOI 是否真实存在且匹配）
- 核验引用语义是否与被引文献内容一致（配合 Evidence 与 Evidence Source）
- 标记 hallucinated citation 与 not_found citation
- 维护引用格式统一与 bib 治理（重复条目、缺失字段、未引用条目）

引用核验结论参与 Quality Gate（见第 10 章）。

## 7.6 确定性组件（不是 Agent）

以下能力是后端确定性代码 / 工具 / 服务，不封装为 LLM Agent：

- **WorkflowOrchestrator**：流程编排（见第 9 章）
- **LaTeX Compiler / Build Gate**：编译、编译日志解析、Build Gate 判定（见第 10 章）
- **Quality Gate 判定器**：基于结构化审稿结果与 Evidence 状态做确定性判定
- **Evidence Store**：证据存取与检索
- **ProjectStore / 版本管理**：项目与 Git 版本

## 7.7 Agent 拆分准则

Agent 角色细化**优先通过 Skill 完成**。只有同时满足以下实际需求之一，才考虑把 Skill
拆成独立 Agent：

- 需要不同模型（如视觉模型）
- 需要独立长期上下文
- 需要不同权限
- 需要真正独立的并行资源

仅"职责描述不同"不构成拆分理由。

## 7.8 历史 Agent 角色的归置

早期 PRD 规划过约 9 个 Agent（Paper Manager、Researcher、Writer、Fact Checker、
Academic Reviewer、Style Reviewer、Final Editor、LaTeX Engineer、Visual Reviewer）。
按新架构归置如下（历史决策 D-0006 已标记 superseded）：

| 旧角色 | 归置 |
|---|---|
| Paper Manager | 移除；职责由确定性 WorkflowOrchestrator 承担（D-0008） |
| Researcher | 保留，扩展 Idea Research 与 Feasibility 支持 |
| Writer | 保留，改为 Section-based Writing 并承担 Revision |
| Fact Checker | 并入 Reviewer 的 fact checking skill |
| Academic Reviewer | 并入 Reviewer 的 academic review skill |
| Style Reviewer | 并入 Reviewer 的 style review skill |
| Final Editor | 移除；汇总修改由 Writer（revision）+ WorkflowOrchestrator（编排）承担 |
| LaTeX Engineer | 确定性 LaTeX 修复工具 / 服务（LaTeX repair loop，M4+） |
| Visual Reviewer | 移出 M3，进入 M4+ backlog |
| （新增）Citation | 新增独立 Agent：引用核验与 bib 治理 |
| Experiment Agent（曾设想） | 不进入 M3；backlog / M4+，除非产品正式扩展为自动科研实验平台 |

---

## 8. Target Feasibility Assessment

这是 PaperTeam 的核心产品原则之一（D-0011）。

## 8.1 问题

系统不允许出现：

```text
用户选择 CVPR
→ Agent 声称能够生成 CVPR 水平论文
```

论文层级由 Novelty、Methodology、实验与 Evidence 决定，不是由写作决定的。

## 8.2 原则

> Agent 必须基于现有 Idea、Novelty、Evidence、实验条件、Methodology 与目标要求，
> 诚实判断目标论文层级是否能够被支撑。

评估在两个时机发生：

- **Idea-to-Paper**：Researcher 调研之后、进入 Evidence / Outline / Writing 之前
- **Existing-Paper Improvement**：论文理解与审稿之后，形成 Target Level Assessment 与
  Improvement Plan 之前

## 8.3 评估结论

使用离散结论，不使用虚假精确数字（如"83% 成功概率"）：

```text
HIGH          当前条件有望支撑目标层级
MEDIUM        存在明确差距，但有可行路径补齐
LOW           差距显著，需要大量补充工作才可能达到
INSUFFICIENT  当前条件不足以合理声称达到该层级
```

## 8.4 无法达到目标时的必答问题

若结论为 LOW / INSUFFICIENT（或 MEDIUM 且有重大缺口），系统必须明确回答：

- 为什么无法达到目标
- 当前缺失什么
- 哪些问题**仅靠写作无法解决**（如缺少真实实验、缺少 Novelty）
- 应补充哪些实验 / Evidence / Novelty
- 或者建议调整目标（下调 targetProfile / targetVenue）

例如，目标为高水平会议时，系统应指出可能缺失：

- 足够 Novelty、方法创新
- Benchmark、实验、Ablation、Baseline
- 数据
- 可验证 Contribution

并明确说明：当前条件不足以合理声称达到该级别。

## 8.5 用户交互

- 评估报告在进入写作前呈现给用户（Human Checkpoint）
- 用户可以选择：调整目标、补充材料后重新评估、或在知情前提下继续（系统如实记录
  已知差距，最终 Quality Gate 仍按目标标准执行）

---

## 9. 核心工作流

## 9.1 两类一级 Workflow

```text
NewPaperWorkflow（Idea-to-Paper）        ExistingPaperWorkflow
        │                                       │
      Idea                              Existing LaTeX 导入
        │                                       │
  Researcher 调研                          项目结构解析
        │                                       │
   领域现状 / Related Work                 Baseline Compile
        │                                       │
   Research Gap / Novelty                  论文理解
        │                                       │
   Target Feasibility ──┐            Citation / Evidence Audit
        │               │                   │
        │            （LOW/INSUFFICIENT      Academic Review
        │             → 用户决策）           │
   用户确认 ◄──────────┘             Target Level Assessment
        │                               │
        └──────────┬────────────► Improvement Plan
                   │                   │
                   │              用户确认
                   │                   │
                   ▼                   │
        Evidence / Outline ◄───────────┤
                   │                   │
                Writing                │（逐节 Revision 复用同一闭环）
                   │                   │
                 Review ◄──────────────┤
                   │                   │
                Revision               │
                   │                   │
              Re-review ◄──────────────┘
                   │
            Build Gate + Quality Gate
                   │
             Draft / Final PDF
```

两条 Workflow 共享后段能力：Evidence、Review、Revision、Build、Quality Gate。

## 9.2 Idea-to-Paper 流程

```text
Idea
  ↓
Researcher 调研（领域现状、Related Work、Research Gap、Novelty / Contribution 分析）
  ↓
Target Feasibility Assessment（见第 8 章）
  ↓
Human Checkpoint（用户确认目标与方向）
  ↓
Evidence / Outline
  ↓
Writing（Section-based，逐节生成）
  ↓
Review（fact / academic / style 并行）
  ↓
Quality Gate 判定
  ↓
通过 → Revision 收尾 → Final
失败 → Revise（Writer 逐节修改）→ Re-verify → 最多 N 轮 → Human Checkpoint
  ↓
Draft PDF（Build Gate 通过即可）/ Final Paper（双 Gate 通过）
```

**产品红线：不要一上来就让 Writer 生成论文。** 写作之前必须有调研、可行性评估与
用户确认。

## 9.3 Existing-Paper Improvement 流程

```text
Existing LaTeX（main.tex / sections/*.tex / references.bib / figures/）
  ↓
项目结构解析
  ↓
Baseline Compile（记录基线编译状态）
  ↓
论文理解（结构、贡献、论证、实验）
  ↓
Citation / Evidence Audit（引用真实性、Claim 支撑度）
  ↓
Academic Review
  ↓
Target Level Assessment（对照目标档次的差距分析）
  ↓
Improvement Plan（分节改造计划）
  ↓
Human Checkpoint（用户确认改造计划）
  ↓
逐节 Revision（Writer，基于 Evidence 与 Style Profile）
  ↓
Re-review（Reviewer + Citation）
  ↓
Final LaTeX / PDF（双 Gate 通过后标记 Final）
```

MVP 阶段仅支持 LaTeX 项目导入；不支持 DOCX → LaTeX 转换。

## 9.4 Workflow 结构原则

不引入复杂 DAG / Graph Workflow Engine。Workflow 由以下结构组成：

- **线性主干**（stage 依次推进）
- **有限条件分支**（如 Quality Gate 通过 / 失败）
- **bounded loop**（修改循环最多 N 轮，默认 3，可配置）
- **少量并行 fan-out / join**（如三类 review skill 并行、多节 Revision 并行）

每个 Stage 的契约由 **StageContract** 描述（M3.0 核心抽象，详见
[ARCHITECTURE.md](ARCHITECTURE.md)），至少包括：

- stage id
- required inputs
- produced outputs
- definition of done（DoD）
- retry policy
- failure type
- max attempts

示例（WriterStage）：

- requires：outline、evidence
- produces：`sections/introduction.tex` 等分节文件
- DoD：文件存在、非空、LaTeX 格式合法

## 9.5 修改闭环（有界）

```text
Review（fact / academic / style + Citation）
  ↓
Review Aggregation（汇总为结构化问题清单）
  ↓
Quality Gate 判定
  ↓
未通过 → Writer 逐节 Revision → Re-verify（fact skill + Citation 复核）
  ↓
循环计数 +1；达到最大轮数 N → Human Checkpoint（呈报剩余问题，由用户决策）
  ↓
通过 → 可标记 Final
```

建议默认通过条件（Quality Gate 默认规则，阈值可按 targetProfile 配置）：

```text
Critical factual errors = 0
Unsupported / contradictory critical claims = 0
Hallucinated citation = 0
Not_found citation = 0
Unresolved critical / major review issues = 0
Academic score ≥ 80
Style risk ≤ 35
Target requirement 达标（对照 targetProfile / targetVenue）
```

## 9.6 Human-in-the-Loop（HITL）Checkpoint

Workflow 在关键节点进入 `awaiting_input` 状态，暂停等待用户输入：

- Target Feasibility 评估后的方向确认（Idea-to-Paper）
- Improvement Plan 确认（Existing-Paper Improvement）
- Outline 确认（可选）
- bounded loop 达到最大轮数后的介入决策

HITL 约定：

- WorkflowRun 进入 `awaiting_input`，前端明确提示用户待办
- 用户输入后 `workflow.resumed`，从 checkpoint 继续
- Workflow 状态持久化（`workflow/` 目录），服务重启后可恢复；恢复依据是 Workspace
  状态与 checkpoint，**不依赖 OpenClaw Chat History**

## 9.7 异步 WorkflowRun

当前 `POST /api/projects/:id/generate` 是同步调用（M2 遗留形态）。M3.0 起论文生产以
异步 **WorkflowRun** 承载：

```text
POST /api/projects/:id/workflows   → { runId }
GET  /api/runs/:runId              → { status, currentStage, ... }
GET  /api/runs/:runId/events（SSE）→ progress / events
POST /api/runs/:runId/resume       → 提交 HITL 输入
POST /api/runs/:runId/cancel       → 取消
```

WorkflowRun 状态：

```text
pending / running / awaiting_input / completed / failed / cancelled
```

进度事件是 **PaperTeam Domain Event**（如 workflow.started、stage.started、
stage.completed、stage.failed、workflow.awaiting_input、workflow.resumed、
quality_gate.failed、workflow.completed）。Domain Event 与 OpenClaw Runtime Event 是
两个层次的概念，不能混用（见 ARCHITECTURE.md 事件分层）。

---

## 10. Build Gate 与 Quality Gate

## 10.1 概念

| | Build Gate | Quality Gate |
|---|---|---|
| 回答的问题 | 文档**能否构建** | 论文质量**是否允许进入 Final** |
| 判定内容 | LaTeX 语法、references.bib 可用、图片资源、依赖 packages、编译结果 | hallucinated citation、not_found citation、unsupported critical claim、unresolved review issue、target requirement 未达到、Evidence 不足 |
| 判定者 | 确定性代码（编译器 + 日志解析） | 确定性代码（基于 Reviewer / Citation 的结构化结果与 Evidence 状态） |
| 失败的后果 | 无法产出 PDF | **仍允许生成 Draft PDF**，但不允许标记 Final / Ready |

## 10.2 规则

```text
Draft PDF：
    只要求 Build Gate 通过。

Final Paper：
    必须 Build Gate + Quality Gate 全部通过。
```

**禁止**把 Quality 语义塞进 Build Gate，例如：

```text
not_found citation → 禁止 LaTeX 编译        ✗ 不允许
```

正确行为：not_found citation 不影响编译；Draft PDF 照常产出（带问题标注），但
Quality Gate 阻止其标记为 Final，问题清单呈报给修改闭环与用户。

## 10.3 产品呈现

- PDF 页面明确区分 Draft 与 Final 状态
- Quality Gate 未通过时，展示阻止项清单（引用问题 / 事实问题 / 审稿遗留 / 目标差距）
- 用户始终可以查看、下载 Draft PDF

---

## 11. LaTeX 系统

## 11.1 论文文件结构

```text
manuscript/
├── main.tex
├── references.bib
├── sections/
│   ├── introduction.tex
│   ├── related-work.tex
│   ├── method.tex
│   ├── experiments.tex
│   └── conclusion.tex
└── figures/
```

（项目工作区整体结构见 5.5。）

## 11.2 编译能力

服务器需要支持：

- XeLaTeX
- latexmk
- BibTeX / Biber
- PDF 输出
- 编译错误捕获
- 编译日志解析

编译结果供 Build Gate 判定使用。

## 11.3 PDF 页面渲染

支持将 PDF 转换为页面图片，用于未来的 Visual Reviewer（M4+）。

建议：

- 默认 150~200 DPI
- 每次按 3~5 页分批审查
- 每个问题关联页码

---

## 12. 普通用户界面

## 12.1 首页看板

显示：

```text
论文：XXXX（Idea-to-Paper / 已有论文改造）

当前状态：第三章正在审稿（WorkflowRun: running / awaiting_input 时提示待办）

Target Feasibility: MEDIUM（差距：缺少对比实验）

Academic Score   84
Fact Score       94
Style Risk       27
Citation Score   91

Critical Issues  0
Major Issues     3

当前版本：Draft v12（Quality Gate 未通过：2 项引用待核验）
```

主要按钮：

- 继续 / 恢复工作流
- 全面审稿
- 自动修改
- 查看 PDF（Draft / Final）
- 上传资料

## 12.2 写作页面

用户选择：

- 写新章节
- 修改已有章节
- 补充文献
- 扩充实验分析
- 润色表达

选择章节并输入自然语言要求。用户无需编写 Agent Prompt。

## 12.3 审稿页面

采用"论文体检报告"方式展示。

显示：

- 总分
- 事实可信度
- 学术质量
- AI 文风风险
- 引用完整度
- Critical / Major / Minor 问题数量
- Quality Gate 状态与阻止项清单

问题卡片：

```text
第三章 3.2 节

严重级别：Major

问题：
正文声称准确率提升 12.4%，
当前实验数据仅支持 8.7%。

[查看原文] [查看 Evidence]
[自动修改]
```

## 12.4 PDF 页面

采用左右双栏：

```text
┌────────────────────────┬──────────────────────┐
│                        │ Page 7               │
│       Paper PDF        │                      │
│      （Draft v12）      │ Figure 4 字体过小     │
│                        │ Table 2 接近越界      │
│                        │                      │
│                        │ [自动修复]            │
└────────────────────────┴──────────────────────┘
```

点击问题后 PDF 自动定位到对应页。Draft / Final 状态明显标注。

## 12.5 任务状态

用户看到业务阶段（WorkflowRun stage 的业务投影）：

```text
✓ 领域调研
✓ 可行性评估（MEDIUM，已确认）
✓ 生成大纲
✓ 生成初稿
✓ 核验事实
● 正在进行学术审稿
○ 文风检查
○ 质量门判定
○ 生成最终版本
```

隐藏底层 session、agentId、runId 和 Gateway 技术信息。awaiting_input 时显示明确的
用户待办入口。

---

## 13. 历史版本

服务器使用 Git 维护论文版本。

前端只展示业务版本：

```text
V12（Draft）
V13（Draft）
V14（Final）
```

每个版本显示：

- 创建时间
- 修改说明
- 修改来源（哪个 WorkflowRun / stage）
- Build Gate / Quality Gate 结果
- Academic Score / Fact Score / Style Risk

支持：

- 查看版本
- 查看 Diff
- 恢复版本
- 下载版本 PDF

Existing-Paper Improvement 项目的初始导入快照是一个特殊版本（baseline）。

---

## 14. AgentRuntime 与 Session

## 14.1 目标

PaperTeam Backend 通过统一 Runtime 接口调用底层 Agent 系统（当前为 OpenClaw）。

业务层只表达：

- 调用哪个 Agent（含 Skill 上下文）
- 执行什么任务
- 输入什么项目和文件
- 获取任务状态
- 获取结果

## 14.2 Session 原则

- **Project ≠ Session**：Project 是论文业务对象；OpenClaw Session 是 Agent 的
  Runtime 上下文，可重建、可丢弃，不承担项目事实来源
- 同一 Project 的同一 Agent 会话保持上下文连续；不同 Project 互不污染
- M3 并行 Reviewer 等场景进一步引入 **contextScope**：会话维度为
  `projectId × agentId × contextScope`（如 Reviewer 的 fact / academic / style 三个
  scope 各自独立），详见 ARCHITECTURE.md
- 业务恢复不依赖 Chat History：恢复依据是 Workspace 事实状态与 workflow checkpoint

---

## 15. 系统管理后台

## 15.1 系统状态

显示：

- Linux Server：CPU / 内存 / 磁盘
- Gateway、Agent Runtime、LaTeX、PDF Renderer、Model Provider 状态
- 最近异常

快捷操作：重启 Gateway、重新加载配置、健康检查、查看日志。

## 15.2 Agent 管理

显示全部 Agent 与 Skill：

- 状态、模型、Prompt / AGENTS.md、Workspace、最近执行时间、最近错误

支持：修改模型、编辑 AGENTS.md、保存、测试 Agent。

## 15.3 模型管理

配置：Provider、API Base、API Key、默认文本模型、默认视觉模型、Timeout、Retry。

显示：请求次数、成功率、失败次数、平均响应时间。

支持：测试连接、保存配置。

## 15.4 Workflow 配置

支持配置：

- 修改闭环最大轮数（bounded loop N）
- Quality Gate 阈值（Academic Pass Score、Style Risk Max、引用与事实硬规则开关）
- 各 Stage 重试策略
- 并发数（fan-out 上限）
- 资料检索范围默认值

## 15.5 WorkflowRun / Session

显示：

- 当前运行 WorkflowRun（项目、workflow 类型、当前 stage、状态、开始时间、已运行时间）
- awaiting_input 的待办列表
- Session（含 contextScope）占用情况

支持：查看详情、查看事件流、取消运行。

---

## 16. 日志系统

日志来源：

- PaperTeam Backend
- OpenClaw Gateway
- Agent
- Model Provider
- LaTeX
- System

支持：实时查看、搜索、时间筛选、Level 筛选、下载、自动滚动。

等级：INFO / WARN / ERROR。

提供"AI 分析日志"功能。

---

## 17. 系统诊断

系统诊断自动检测：

- Gateway 是否运行、端口是否监听
- Model Provider 是否可用
- LaTeX 是否安装
- PDF Renderer 是否可用
- 磁盘空间
- Git Repository
- Project Workspace
- Agent 配置

结果示例：

```text
Gateway unavailable

✓ Linux 正常
✓ Node.js 正常
✗ OpenClaw Gateway stopped
✓ Model API 正常

建议操作：
[启动 Gateway]
[查看日志]
[打开终端]
```

---

## 18. Command Center

提供固定服务器运维能力。

支持：

- Gateway status / restart / 查看日志
- CPU / Memory / Disk
- Git status / Git log
- LaTeX compile
- 清理临时文件

所有执行结果在页面显示。

---

## 19. Web Terminal

系统管理高级功能。

技术实现建议：

```text
Browser → WebSocket → PaperTeam Backend → PTY → Linux Shell
```

前端可使用 xterm.js；服务端可使用 node-pty。

功能：命令输入、实时输出、Ctrl+C、Terminal resize、Session 管理、自动断开、操作日志。

需要管理员身份验证。

---

## 20. 文件管理

可浏览服务器指定工作目录。

支持：查看目录 / 文件、编辑文本文件、上传、下载、新建文件夹、重命名。

重点目录：projects、agents、logs、config。

对 AGENTS.md、openclaw.json 等配置提供专门编辑入口。

---

## 21. 用户与权限

## 21.1 普通用户

权限：管理论文项目（两类工作流）、上传资料、发起 WorkflowRun、发起审稿、查看 PDF、
查看报告、管理项目版本、处理 HITL 待办。

## 21.2 管理员

额外权限：系统配置、Agent 配置、模型配置、Gateway 管理、日志、系统诊断、
Command Center、Web Terminal、文件管理。

---

## 22. 服务器部署

## 22.1 推荐环境

Linux：Ubuntu Server。

核心组件：Node.js、OpenClaw Gateway、PaperTeam Backend、Git、Python、TeX Live
（XeLaTeX / latexmk / Biber）、Poppler、PDF Renderer。

## 22.2 服务

建议长期运行：PaperTeam Backend、OpenClaw Gateway、Web Frontend、Database。

支持 systemd 管理。

## 22.3 网络

用户只需访问：

```text
https://paper.example.com
```

OpenClaw Gateway 作为服务器内部服务访问。

---

## 23. 数据模型草案

> 本草稿冻结**概念与字段方向**，不冻结最终 enum 值。存储口径：EvidenceStore M3.1
> 采用项目级 `evidence/evidence.jsonl` 文件持久化（接口抽象保持，项目内查询使用
> 内存索引 / 文件扫描等轻量实现）；M3 不提前引入数据库，SQLite 及其余结构化状态
> 存储（后续可切 PostgreSQL）的引入条件，待真实数据规模 / 查询性能 / 并发 /
> 跨项目检索需求出现后再评估。文件内容仍存放于项目 Workspace。

```text
Project
  id, title, workflowKind (idea_to_paper | existing_paper_improvement),
  documentType, targetProfile, targetVenue?, language,
  status, runtimeSessionKey?, createdAt, updatedAt

SourceItem（项目文献库条目）
  source_id, file, metadata (title/authors/year/doi/...),
  sourceRole (evidence | reference | both),
  origin (USER_ADDED | AGENT_RETRIEVED),
  status, preferred (重点参考)

ReferenceStyleProfile
  profile_id, source_id, documentType, targetProfile,
  章节结构 / 章节比例 / 图表与引用密度 / 组织模式等结构化画像

Evidence
  evidence_id, claim, evidence/summary, quote,
  source, location (page/section/chunk),
  verificationStatus (unverified|verified|plausible|mismatch|unverifiable|not_found),
  verificationMethod, supportStrength (direct|partial|indirect|contradictory),
  verificationLevel (metadata|abstract|fulltext|user_confirmed),
  confidence? (辅助), relatedSections, usedBy, createdBy, createdAt

FeasibilityReport
  report_id, project_id, verdict (HIGH|MEDIUM|LOW|INSUFFICIENT),
  gaps[], recommendations[], suggestedTargetProfile?, createdAt

Outline
  outline_id, project_id, sections[] (id, title, targetLength, status)

ReviewReport
  review_id, run_id, kind (fact|academic|style), scores, issues[], createdAt

Issue
  issue_id, review_id, section, severity (critical|major|minor),
  description, claim_ref?, evidence_ref?, status (open|resolved|waived)

CitationRecord
  citation_key, bib_entry, verificationStatus, evidence_refs[], usedIn[]

WorkflowRun
  run_id, project_id, workflowKind, status
  (pending|running|awaiting_input|completed|failed|cancelled),
  currentStage, stageHistory[], checkpoints[], createdAt, updatedAt

StageContract（设计态，非运行数据）
  stage_id, requiredInputs, producedOutputs, doD, retryPolicy,
  failureType, maxAttempts

PaperVersion
  version, label (draft|final), gateResults (build|quality),
  scores, commit, createdAt

SystemLog
AgentTask
```

---

## 24. API 方向草案

已实现（M2 / M2.1）：

```text
GET  /health
POST /api/projects                {title}
GET  /api/projects/:id
POST /api/projects/:id/generate   {prompt}   # 同步，M3.0 后由 WorkflowRun 取代
```

M3 方向草案：

```text
# WorkflowRun（M3.0）
POST /api/projects/:id/workflows        创建运行 → {runId}
GET  /api/runs/:runId                   运行状态
GET  /api/runs/:runId/events            SSE 进度 / Domain Event
POST /api/runs/:runId/resume            提交 HITL 输入
POST /api/runs/:runId/cancel            取消运行

# Existing LaTeX 导入（M3.1/3.2）
POST /api/projects/:id/import           导入 LaTeX 项目并做结构解析 + Baseline Compile

# 文献与证据（M3.1）
POST /api/projects/:id/sources          上传 / 导入文献（含 sourceRole）
GET  /api/projects/:id/sources
GET  /api/projects/:id/evidence
POST /api/projects/:id/evidence/:id/verify

# 可行性（M3.1）
GET  /api/projects/:id/feasibility      最近一次 FeasibilityReport

# 审稿与质量（M3.2）
POST /api/projects/:id/review
GET  /api/projects/:id/quality-gate     Gate 结果与阻止项

# 构建（M3.2）
POST /api/projects/:id/build            Build Gate + Draft PDF

# 版本
GET  /api/projects/:id/versions

# 管理
/api/admin/health
/api/admin/agents
/api/admin/models
/api/admin/runs
/api/admin/logs
/api/admin/files
/api/admin/diagnostics
/api/admin/terminal
```

---

## 25. 实时通信

需要 WebSocket 或 SSE（WorkflowRun 进度优先 SSE）。

用途：

- WorkflowRun 进度（Domain Event：workflow.started / stage.started / stage.completed /
  stage.failed / workflow.awaiting_input / workflow.resumed / quality_gate.failed /
  workflow.completed）
- LaTeX 编译状态
- 日志
- Web Terminal
- 审稿结果推送

事件分层：OpenClaw Runtime Event 经 RuntimeAdapter 转换为 WorkflowOrchestrator 关心的
运行信号，再对外发布为 PaperTeam Domain Event；两层事件不混用（见 ARCHITECTURE.md）。

---

## 26. 非功能需求

## 26.1 可用性

普通用户使用系统时无需：SSH、Git 命令、LaTeX 命令、OpenClaw 命令、Linux 命令。

## 26.2 可观测性

需要能够查看：

- 当前 WorkflowRun 与 Stage
- Agent 执行状态
- 模型请求
- Gateway 状态
- 系统日志
- LaTeX 编译日志

## 26.3 可恢复性

支持：

- WorkflowRun checkpoint / resume（含服务重启后恢复）
- Stage 重试（按 StageContract 的 retry policy）
- awaiting_input 的人工恢复
- LaTeX 编译错误显示
- 版本恢复
- Gateway 重启
- 系统诊断

恢复依据是 Workspace 事实状态，不依赖 Chat History。

## 26.4 安全

需要：

- 用户认证
- 管理员权限
- API Key 加密存储
- Web Terminal 二次验证
- Terminal 操作日志
- HTTPS
- 文件访问路径限制

## 26.5 可扩展性

Agent Runtime 通过 AgentRuntimeAdapter 与业务系统隔离。

后续可扩展：

- 新 Agent / 新 Skill
- 新模型（含视觉模型）
- 新论文模板
- 新 Runtime
- 新文献检索源

---

## 27. M3 Roadmap

已完成的基础（详见 [PROJECT_STATUS.md](PROJECT_STATUS.md)）：

- **M1 Backend Runtime Skeleton**：Backend 工程、`AgentRuntime` 抽象、
  `OpenClawRuntimeAdapter`、Gateway 健康检查
- **M2 Agent Invocation + Project + LaTeX**：`runAgent()` 真实调用链、ProjectStore、
  WriterService、GenerationService、LatexCompiler、最小 HTTP API
- **M2.1 OpenClaw 2.0 Runtime Upgrade**：官方 Gateway SDK（2026.8.1 / protocol v4）、
  Project ↔ Session 隔离与 runtimeSessionKey 持久化
- **Architecture Research & Product Design Refresh**：竞品调研（vs PaperKit / Open
  Academic Paper Machine / AutoResearchClaw）与本轮产品/架构方向冻结
  （DECISIONS D-0008~D-0015）

### M3.0 — Workflow Foundation

- WorkflowOrchestrator（确定性编排）
- WorkflowRun / Stage 运行时
- StageContract 抽象
- 异步 API（runId + 状态查询 + SSE）
- checkpoint / resume
- Domain Event 流（workflow.* / stage.* / quality_gate.*）
- HITL awaiting_input / resume
- Session contextScope（projectId × agentId × contextScope）

### M3.1 — Research & Evidence

- Idea Research（领域现状 / Related Work / Research Gap / Novelty 分析）
- Literature Research（项目文献库 + 受控网络检索）
- Target Feasibility Assessment
- PDF Reference Paper Analysis（Multimodal → Reference Style Profile）
- EvidenceStore（project-scoped `evidence/evidence.jsonl` 文件实现；含 supportStrength / verificationLevel / 反向定位）
- Citation Verification
- Section-based Writer
- context derived state（context.yaml 等蒸馏产物）

### M3.2 — Review & Revision

- Reviewer（fact / academic / style 三 skill）
- Review aggregation
- bounded revision loop（含超限 Human Checkpoint）
- Quality Gate
- Existing LaTeX Improvement workflow（导入 / 解析 / Baseline Compile / 理解 / 审计 /
  逐节改造）

### M4+

- frontend workbench（完整前端工作台）
- Visual Reviewer（视觉审稿）
- LaTeX repair loop（确定性修复工具链）
- version management（完整版本管理体验）
- optional Experiment subsystem（仅当产品正式扩展为自动科研实验平台）
- self-learning / evolution evaluation（系统自评估与演进）

---

## 28. MVP 核心验收场景

## 场景一：Idea-to-Paper

用户：

1. 选择"从研究 Idea 开始"新建项目
2. 输入 Idea、领域、目标（documentType=conference_paper，targetProfile=高水平会议，
   targetVenue=CVPR），上传 2 篇参考论文（标记 reference）
3. 点击开始调研

系统：

1. Researcher 完成领域调研与 Novelty 分析
2. 输出 Target Feasibility Assessment：INSUFFICIENT（缺少 Benchmark 与 Baseline 实验）
3. 暂停等待用户（awaiting_input）

用户选择下调 targetProfile 至"核心期刊"并确认。

4. 系统继续：Evidence / Outline → 分节 Writing → Review → 修改闭环 → Draft PDF

验收：

- 全程能看到 WorkflowRun 业务阶段与 awaiting_input 待办
- 可行性报告说明差距与建议，未出现"声称可达 CVPR"
- 正文引用可追溯到项目文献库与 Evidence
- Quality Gate 通过后版本标记为 Final

## 场景二：Existing-Paper Improvement

用户：

1. 选择"导入已有 LaTeX 论文"，上传 main.tex / sections/ / references.bib / figures/
2. 设置 targetProfile=核心期刊

系统：

1. 结构解析 + Baseline Compile（记录基线）
2. 论文理解 + Citation / Evidence Audit + Academic Review
3. 输出 Target Level Assessment 与 Improvement Plan
4. awaiting_input，用户确认计划
5. 逐节 Revision → Re-review → Final PDF

验收：

- 基线快照可回溯
- Citation Audit 标出 not_found / hallucinated 引用
- 未通过 Quality Gate 前版本只能是 Draft

## 场景三：Quality Gate 不阻止编译

系统：

1. 正文存在 1 条 not_found citation
2. 用户点击"构建 Draft PDF"

验收：

- Build Gate 通过，Draft PDF 正常产出（带问题标注）
- 版本标记为 Draft；Quality Gate 阻止 Final
- 问题清单进入修改闭环

## 场景四：Gateway 故障

管理员进入系统管理。

系统显示：

```text
OpenClaw Gateway: Error
```

管理员：

1. 点击健康检查
2. 查看诊断结果
3. 查看日志
4. 点击重启 Gateway

验收：

- 全过程可在浏览器完成
- Gateway 恢复后状态自动刷新
- 进行中的 WorkflowRun 不因 Runtime 抖动丢失（可 resume）

---

## 29. 产品最终体验目标

普通用户的核心操作流程应控制为：

```text
新建项目（Idea 或 导入已有论文）
   ↓
上传资料 / 确认可行性与计划
   ↓
告诉系统要做什么
   ↓
查看论文与审稿结果
   ↓
处理待办（awaiting_input）直到 Final
```

用户主要看到：

- 论文（Draft / Final）
- PDF
- 可行性结论
- 分数与问题
- 修改结果
- 版本

系统内部负责：

- Workflow 编排与恢复
- Agent / Skill 调度
- Evidence 与引用核验
- OpenClaw / LaTeX / Git / 模型 / 日志 / 自动化

最终达到：

> 系统内部具备完整的研究、写作、审稿、验证与工程能力，诚实地评估目标可行性；
> 普通用户只需通过浏览器完成从 Idea 到 Final 论文、或已有论文改造的全过程。
