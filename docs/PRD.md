# PaperTeam 产品需求文档（PRD）

## 1. 产品概述

### 1.1 产品名称
PaperTeam

### 1.2 产品定位
PaperTeam 是一个面向学术论文写作、审稿、事实核验、文风优化、LaTeX 编译与论文质量评估的 AI 多 Agent 工作台。

系统采用“本地浏览器 + Linux 服务器”的使用方式。用户只需通过浏览器操作，论文写作、Agent 调度、模型调用、LaTeX 编译、PDF 生成、版本管理、日志与系统维护等工作均由服务器完成。

### 1.3 产品目标
1. 让非技术用户无需接触命令行、Git、LaTeX 环境或 OpenClaw 配置即可完成论文写作与审稿。
2. 建立可重复执行的论文写作与审稿工作流。
3. 将论文内容质量、事实真实性、引用完整性、AI 文风风险和视觉排版质量以直观方式展示。
4. 支持多个专业 Agent 分工协作，并能够自动完成研究、写作、审稿、修改和重新验证。
5. 支持长期部署在 Linux 服务器上，通过浏览器进行日常使用与系统维护。
6. 为未来替换或扩展 Agent Runtime 保留统一接口边界。

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
- 上传论文和资料
- 继续撰写论文
- 修改章节
- 进行论文审稿
- 查看事实问题
- 查看 AI 文风风险
- 查看最终 PDF
- 查看历史版本

### 2.2 管理员
管理员主要负责：
- 查看服务器运行状态
- 查看 OpenClaw Gateway 状态
- 管理 Agent
- 配置模型
- 查看任务和 Session
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
   ├── Project
   ├── Workflow
   ├── Runtime
   │    └── AgentRuntimeAdapter
   ├── LaTeX
   ├── PDF
   ├── File
   ├── Version
   └── Admin
   │
   ▼
OpenClaw Gateway
   │
   ├── Paper Manager
   ├── Researcher
   ├── Writer
   ├── Fact Checker
   ├── Academic Reviewer
   ├── Style Reviewer
   ├── Final Editor
   ├── LaTeX Engineer
   └── Visual Reviewer
   │
   ▼
Linux Server
   ├── Paper Workspace
   ├── LaTeX Environment
   ├── Git Repository
   ├── PDF Renderer
   ├── Model Providers
   └── Logs
```

---

## 4. 页面结构

系统提供两种主要工作模式：

### 4.1 论文工作台
面向普通用户。

主要页面：
1. 首页看板
2. 我的论文
3. 论文写作
4. 论文审稿
5. 文献与证据
6. PDF 查看
7. 历史版本
8. 项目设置

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

# 5. 论文项目管理

## 5.1 新建论文

用户输入：
- 论文名称
- 研究方向
- 论文类型
- 学校或期刊模板
- 语言
- 备注

创建后自动生成论文项目目录。

示例：

```text
projects/thesis-001/
├── main.tex
├── chapters/
├── figures/
├── tables/
├── sources/
├── evidence/
├── reviews/
├── data/
├── build/
└── project.json
```

## 5.2 项目首页

显示：
- 论文名称
- 当前版本
- 当前任务状态
- 当前章节进度
- 学术质量评分
- 事实可信度
- AI 文风风险
- 引用完整度
- 当前严重问题数量
- 最近一次编译时间
- 最近一次审稿时间

主要操作：
- 继续写论文
- 全面审稿
- 查看 PDF
- 上传资料
- 查看问题
- 查看历史版本

---

# 6. 资料上传与文献管理

## 6.1 文件上传

支持：
- PDF
- DOCX
- TXT
- Markdown
- CSV
- XLSX
- PNG
- JPG
- BibTeX

支持拖拽上传。

## 6.2 文献识别

上传文献后自动提取：
- 标题
- 作者
- 年份
- DOI
- 来源
- 摘要
- 关键词

## 6.3 文献状态

每篇文献显示：
- 信息完整
- 缺少 DOI
- 信息待确认
- 已进入 Evidence Store

## 6.4 Evidence Store

系统建立统一证据库。

建议结构：

```json
{
  "evidence_id": "E023",
  "claim": "论文可支持的事实性观点",
  "source": {
    "title": "",
    "authors": [],
    "year": 2026,
    "doi": "",
    "url": ""
  },
  "location": "Section 4.2 / Table 3",
  "evidence": "",
  "confidence": 0.94
}
```

Evidence 用于：
- Writer 写作
- Fact Checker 核验
- Citation Reviewer 核验
- Academic Reviewer 判断论据充分性

---

# 7. Agent Team

## 7.1 Paper Manager

职责：
- 接收用户任务
- 分析任务目标
- 选择需要调用的 Agent
- 调度论文工作流
- 汇总各 Agent 结果
- 判断是否进入下一阶段
- 判断是否需要修改或重新审稿
- 向前端输出任务状态

## 7.2 Researcher

职责：
- 根据论文主题检索文献
- 阅读用户上传文献
- 读取已有 Evidence
- 提取可引用事实
- 生成 Evidence
- 标记证据不足部分
- 为 Writer 和 Reviewer 提供研究材料

## 7.3 Writer

职责：
- 根据论文大纲、已有正文、Evidence 和用户要求撰写内容
- 输出 LaTeX
- 使用统一引用格式
- 对缺乏证据的内容做显式标记
- 保持章节结构和术语一致性

## 7.4 Fact Checker

职责：
- 将正文拆分为 factual claims
- 对每个 claim 查询 Evidence
- 必要时进一步读取原始文献
- 判断事实性声明是否有充分证据
- 输出结构化事实审查结果

状态统一为：
- SUPPORTED
- PARTIALLY_SUPPORTED
- UNSUPPORTED
- CONTRADICTED

问题等级：
- critical
- major
- minor

## 7.5 Academic Reviewer

职责：
- 从学术审稿角度评价论文质量
- 检查问题定义
- 检查方法合理性
- 检查创新性
- 检查实验设计
- 检查消融实验
- 检查结果解释
- 检查逻辑完整性
- 检查相关工作覆盖度
- 输出学术评分及问题列表

建议评分维度：

| 维度 | 分值 |
|---|---:|
| 问题定义 | 20 |
| 方法合理性 | 20 |
| 实验充分性 | 20 |
| 论证逻辑 | 20 |
| 写作质量 | 20 |

## 7.6 Style Reviewer

职责：
- 检查模板化表达
- 检查连接词滥用
- 检查重复句式
- 检查段落结构机械化
- 检查空洞评价
- 检查信息密度
- 检查无证据评价词
- 检查不必要总结
- 输出 AI 文风风险评分

输出：
- AI 文风风险：0~100
- 问题位置
- 问题类型
- 修改建议

## 7.7 Final Editor

职责：
- 汇总 Fact Checker、Academic Reviewer、Style Reviewer 的意见
- 修改论文正文
- 修复 critical 和 major 问题
- 保持论文结构、引用和术语一致
- 输出新版本 LaTeX
- 提交重新验证

## 7.8 LaTeX Engineer

职责：
- 解决 LaTeX 编译错误
- 修复引用和交叉引用问题
- 修复图片和表格布局问题
- 修复公式、浮动体和页面布局问题
- 确保论文能够稳定编译

## 7.9 Visual Reviewer

主要模型：
- GLM-5.3-Flash 或其他支持视觉输入的模型

职责：
- 对编译后的论文 PDF 页面进行视觉审查
- 检查页面布局
- 检查图表可读性
- 检查公式排版
- 检查表格是否越界
- 检查图片清晰度
- 检查字体一致性
- 检查浮动体位置
- 检查留白
- 检查图表和正文是否存在明显视觉矛盾

输出：

```json
{
  "page": 7,
  "element": "Figure 4",
  "severity": "major",
  "problem": "",
  "suggestion": ""
}
```

---

# 8. 核心论文工作流

## 8.1 写作流程

```text
用户提交写作任务
      ↓
Paper Manager
      ↓
Researcher
      ↓
Evidence 更新
      ↓
Writer
      ↓
LaTeX Draft
      ↓
Fact Checker
      ↓
Academic Reviewer
      ↓
Style Reviewer
      ↓
Final Editor
      ↓
重新验证
      ↓
完成
```

## 8.2 全面审稿流程

```text
论文当前版本
     ↓
同时执行
 ┌──────────────┬────────────────┬──────────────┐
 Fact Checker   Academic Reviewer Style Reviewer
 └──────────────┴────────────────┴──────────────┘
                      ↓
                Review Aggregator
                      ↓
                生成综合审稿报告
```

## 8.3 修改闭环

建议默认通过条件：

```text
Critical factual errors = 0
Unsupported important claims = 0
Academic score >= 80
Style risk <= 35
```

不满足条件时：

```text
Review
  ↓
Final Editor
  ↓
Fact Checker
  ↓
必要时重新 Academic Review
  ↓
生成新版本
```

## 8.4 PDF 视觉检查

```text
LaTeX
  ↓
latexmk / XeLaTeX
  ↓
paper.pdf
  ↓
PDF 页面渲染
  ↓
Visual Reviewer
  ↓
visual-review.json
  ↓
LaTeX Engineer
  ↓
重新编译
```

---

# 9. LaTeX 系统

## 9.1 论文文件结构

```text
paper/
├── main.tex
├── references.bib
├── chapters/
│   ├── 01-introduction.tex
│   ├── 02-related-work.tex
│   ├── 03-method.tex
│   ├── 04-experiments.tex
│   └── 05-conclusion.tex
├── figures/
├── tables/
├── data/
├── evidence/
├── reviews/
└── build/
```

## 9.2 编译能力

服务器需要支持：
- XeLaTeX
- latexmk
- BibTeX / Biber
- PDF 输出
- 编译错误捕获
- 编译日志解析

## 9.3 PDF 页面渲染

支持将 PDF 转换为页面图片，用于 Visual Reviewer。

建议：
- 默认 150~200 DPI
- 每次按 3~5 页分批审查
- 每个问题关联页码

---

# 10. 普通用户界面

## 10.1 首页看板

显示：

```text
论文：XXXX

当前状态：第三章正在审稿

Academic Score   84
Fact Score       94
Style Risk       27
Citation Score   91

Critical Issues  0
Major Issues     3
```

主要按钮：
- 继续写论文
- 全面审稿
- 自动修改
- 查看 PDF
- 上传资料

## 10.2 写作页面

用户选择：
- 写新章节
- 修改已有章节
- 补充文献
- 扩充实验分析
- 润色表达

选择章节并输入自然语言要求。

用户无需编写 Agent Prompt。

## 10.3 审稿页面

采用“论文体检报告”方式展示。

显示：
- 总分
- 事实可信度
- 学术质量
- AI 文风风险
- 引用完整度
- Critical / Major / Minor 问题数量

问题卡片：

```text
第三章 3.2 节

严重级别：Major

问题：
正文声称准确率提升 12.4%，
当前实验数据仅支持 8.7%。

[查看原文]
[自动修改]
```

## 10.4 PDF 页面

采用左右双栏：

```text
┌────────────────────────┬──────────────────────┐
│                        │ Page 7               │
│       Paper PDF        │                      │
│                        │ Figure 4 字体过小     │
│                        │ Table 2 接近越界      │
│                        │                      │
│                        │ [自动修复]            │
└────────────────────────┴──────────────────────┘
```

点击问题后 PDF 自动定位到对应页。

## 10.5 任务状态

用户看到业务阶段：

```text
✓ 检索相关文献
✓ 生成初稿
✓ 核验事实
● 正在进行学术审稿
○ 文风检查
○ 生成最终版本
```

隐藏底层 session、agentId 和 Gateway 技术信息。

---

# 11. 历史版本

服务器使用 Git 维护论文版本。

前端只展示业务版本：

```text
V12
V13
V14
V15
```

每个版本显示：
- 创建时间
- 修改说明
- 修改来源
- Academic Score
- Fact Score
- Style Risk

支持：
- 查看版本
- 查看 Diff
- 恢复版本
- 下载版本 PDF

---

# 12. AgentRuntimeAdapter

## 12.1 目标

PaperTeam Backend 通过统一 Runtime 接口调用底层 Agent 系统。

业务层只表达：
- 调用哪个 Agent
- 执行什么任务
- 输入什么项目和文件
- 获取任务状态
- 获取结果

## 12.2 核心接口

```ts
interface AgentRuntime {
  runAgent(input: RunAgentInput): Promise<AgentTask>;

  getTask(taskId: string): Promise<AgentTask>;

  cancelTask(taskId: string): Promise<void>;

  sendMessage(
    sessionId: string,
    message: string
  ): Promise<void>;

  streamEvents(
    taskId: string,
    onEvent: (event: AgentEvent) => void
  ): Promise<void>;

  healthCheck(): Promise<RuntimeHealth>;
}
```

## 12.3 任务状态

统一为：

```text
queued
running
completed
failed
cancelled
```

## 12.4 OpenClaw Runtime

第一版由 OpenClawRuntimeAdapter 对接：
- OpenClaw Gateway
- Agent
- sessions_spawn
- Session
- Task
- Event Stream

---

# 13. 系统管理后台

## 13.1 系统状态

显示：
- Linux Server
- CPU
- 内存
- 磁盘
- Gateway
- Agent Runtime
- LaTeX
- PDF Renderer
- Model Provider

显示最近异常。

快捷操作：
- 重启 Gateway
- 重新加载配置
- 健康检查
- 查看日志

## 13.2 Agent 管理

显示全部 Agent：
- 状态
- 模型
- Prompt
- Workspace
- 最近执行时间
- 最近错误

支持：
- 修改模型
- 编辑 AGENTS.md
- 保存
- 测试 Agent

## 13.3 模型管理

配置：
- Provider
- API Base
- API Key
- 默认文本模型
- 默认视觉模型
- Timeout
- Retry

显示：
- 请求次数
- 成功率
- 失败次数
- 平均响应时间

支持：
- 测试连接
- 保存配置

## 13.4 Workflow 配置

支持配置：
- 是否启用 Researcher
- 是否启用 Fact Checker
- 是否启用 Academic Reviewer
- 是否启用 Style Reviewer
- 是否启用 Visual Reviewer
- 并发数
- Academic Pass Score
- Style Risk Max
- 最大修改轮数

## 13.5 Session / Task

显示：
- 当前运行任务
- Agent
- 项目
- 状态
- 开始时间
- 已运行时间

支持：
- 查看详情
- 查看输出
- 取消任务

---

# 14. 日志系统

日志来源：
- PaperTeam Backend
- OpenClaw Gateway
- Agent
- Model Provider
- LaTeX
- System

支持：
- 实时查看
- 搜索
- 时间筛选
- Level 筛选
- 下载
- 自动滚动

等级：
- INFO
- WARN
- ERROR

提供“AI 分析日志”功能。

---

# 15. 系统诊断

系统诊断自动检测：
- Gateway 是否运行
- Gateway 端口是否监听
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

# 16. Command Center

提供固定服务器运维能力。

支持：
- Gateway status
- Gateway restart
- 查看 Gateway 日志
- CPU / Memory / Disk
- Git status
- Git log
- LaTeX compile
- 清理临时文件

所有执行结果在页面显示。

---

# 17. Web Terminal

系统管理高级功能。

技术实现建议：

```text
Browser
  ↓
WebSocket
  ↓
PaperTeam Backend
  ↓
PTY
  ↓
Linux Shell
```

前端可使用：
- xterm.js

服务端可使用：
- node-pty

功能：
- 命令输入
- 实时输出
- Ctrl+C
- Terminal resize
- Session 管理
- 自动断开
- 操作日志

需要管理员身份验证。

---

# 18. 文件管理

可浏览服务器指定工作目录。

支持：
- 查看目录
- 查看文件
- 编辑文本文件
- 上传
- 下载
- 新建文件夹
- 重命名

重点目录：
- projects
- agents
- logs
- config

对 AGENTS.md、openclaw.json 等配置提供专门编辑入口。

---

# 19. 用户与权限

## 19.1 普通用户

权限：
- 管理论文项目
- 上传资料
- 发起写作任务
- 发起审稿
- 查看 PDF
- 查看报告
- 管理项目版本

## 19.2 管理员

额外权限：
- 系统配置
- Agent 配置
- 模型配置
- Gateway 管理
- 日志
- 系统诊断
- Command Center
- Web Terminal
- 文件管理

---

# 20. 服务器部署

## 20.1 推荐环境

Linux：
- Ubuntu Server

核心组件：
- Node.js
- OpenClaw Gateway
- PaperTeam Backend
- Git
- Python
- TeX Live
- XeLaTeX
- latexmk
- Biber
- Poppler
- PDF Renderer

## 20.2 服务

建议长期运行：
- PaperTeam Backend
- OpenClaw Gateway
- Web Frontend
- Database

支持 systemd 管理。

## 20.3 网络

用户只需访问：

```text
https://paper.example.com
```

OpenClaw Gateway 作为服务器内部服务访问。

---

# 21. 数据存储

建议核心数据：

```text
Project
Document
Chapter
Evidence
Source
Review
Issue
AgentTask
PaperVersion
SystemLog
```

文件内容继续存放于项目 Workspace。

结构化状态存入数据库。

第一版数据库可使用：
- SQLite

后续可切换：
- PostgreSQL

---

# 22. API 模块

建议后端提供：

```text
/api/projects
/api/projects/:id/files
/api/projects/:id/write
/api/projects/:id/review
/api/projects/:id/revise
/api/projects/:id/pdf
/api/projects/:id/versions

/api/tasks
/api/tasks/:id

/api/admin/health
/api/admin/agents
/api/admin/models
/api/admin/logs
/api/admin/files
/api/admin/diagnostics
/api/admin/terminal
```

---

# 23. 实时通信

需要 WebSocket 或 SSE。

用途：
- Agent Task 状态
- Workflow 进度
- LaTeX 编译状态
- 日志
- Web Terminal
- 审稿结果推送

示例：

```json
{
  "type": "workflow.progress",
  "stage": "academic-review",
  "status": "running",
  "progress": 72
}
```

---

# 24. 非功能需求

## 24.1 可用性
普通用户使用系统时无需：
- SSH
- Git 命令
- LaTeX 命令
- OpenClaw 命令
- Linux 命令

## 24.2 可观测性
需要能够查看：
- 当前任务
- 当前 Workflow
- Agent 执行状态
- 模型请求
- Gateway 状态
- 系统日志
- LaTeX 编译日志

## 24.3 可恢复性
支持：
- Workflow 失败提示
- Agent Task 重试
- LaTeX 编译错误显示
- 版本恢复
- Gateway 重启
- 系统诊断

## 24.4 安全
需要：
- 用户认证
- 管理员权限
- API Key 加密存储
- Web Terminal 二次验证
- Terminal 操作日志
- HTTPS
- 文件访问路径限制

## 24.5 可扩展性
Agent Runtime 通过 AgentRuntimeAdapter 与业务系统隔离。

后续可扩展：
- 新 Agent
- 新模型
- 新 Reviewer
- 新论文模板
- 新 Runtime
- 新文献检索源

---

# 25. MVP 开发范围

## 第一阶段：基础运行

完成：
- Linux 部署
- OpenClaw Gateway
- PaperTeam Backend
- Paper Manager
- Researcher
- Writer
- Fact Checker
- Academic Reviewer
- Style Reviewer
- Final Editor
- 基础项目目录
- LaTeX 编译
- PDF 输出
- AgentRuntimeAdapter

## 第二阶段：论文工作台

完成：
- 项目列表
- 新建项目
- 上传资料
- 章节列表
- 写作任务
- 全面审稿
- 审稿报告
- Workflow 进度
- PDF 查看
- 历史版本

## 第三阶段：视觉审稿

完成：
- PDF 页面渲染
- Visual Reviewer
- GLM-5.3-Flash
- PDF 问题定位
- LaTeX Engineer
- 自动修复闭环

## 第四阶段：系统管理

完成：
- 系统状态
- Gateway 管理
- Agent 管理
- 模型管理
- Workflow 配置
- 日志
- 系统诊断
- 文件管理
- Command Center
- Web Terminal

---

# 26. MVP 核心验收场景

## 场景一：上传资料并生成章节

用户：
1. 新建论文
2. 上传参考文献
3. 选择“第三章”
4. 输入“根据现有资料完善方法章节”
5. 点击开始

系统：
1. Researcher 整理 Evidence
2. Writer 生成 LaTeX
3. Reviewer 自动审查
4. Final Editor 修改
5. 生成新版本

验收：
- 页面能看到完整执行状态
- 能查看最终章节
- 能查看审稿问题
- 能生成 PDF

## 场景二：全面审稿

用户点击：

```text
[全面审稿]
```

系统并行执行：
- Fact Checker
- Academic Reviewer
- Style Reviewer

验收：
- 输出总体评分
- 输出事实问题
- 输出学术问题
- 输出 AI 文风风险
- 所有问题关联章节位置

## 场景三：PDF 视觉检查

系统：
1. 编译 PDF
2. 渲染页面图片
3. Visual Reviewer 检查
4. 输出页码级问题

验收：
- 点击问题可以定位 PDF 页
- 能看到问题描述
- 能发起自动修复

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

---

# 27. 产品最终体验目标

普通用户的核心操作流程应控制为：

```text
新建论文
   ↓
上传资料
   ↓
告诉系统要做什么
   ↓
查看论文与审稿结果
```

用户主要看到：
- 论文
- PDF
- 分数
- 问题
- 修改结果
- 版本

系统内部负责：
- Agent
- Workflow
- OpenClaw
- LaTeX
- Git
- 模型
- Linux
- 日志
- 自动化

最终达到：

> 系统内部具备完整的 Agent、论文工程和服务器能力，而普通用户只需要通过浏览器完成论文写作、审稿、修改和结果查看。
