# PaperTeam 项目状态

> 更新日期：2026-08-31

## 当前阶段

**项目初始化完成**：仓库、目录结构、基础文档已就绪，尚未开始编码。

## 已确定的项目决策

| # | 决策 | 状态 |
|---|---|---|
| 1 | **Web 前端 + Linux Server 架构**：用户通过浏览器操作，论文写作、Agent 调度、LaTeX 编译、版本管理与系统维护全部在服务器端完成 | ✅ 已确定 |
| 2 | **Agent Runtime 使用 OpenClaw**：通过 OpenClaw Gateway 承载 Agent Team | ✅ 已确定 |
| 3 | **使用 AgentRuntimeAdapter 隔离 Runtime**：Backend 业务层只依赖统一的 `AgentRuntime` 接口，为未来替换或扩展 Runtime 保留边界 | ✅ 已确定 |
| 4 | **LaTeX 作为论文主格式**：XeLaTeX + latexmk 编译，输出 PDF；版本用 Git 管理，前端只暴露业务版本号 | ✅ 已确定 |
| 5 | **双模式前端**：普通用户的论文工作台 + 管理员的系统管理后台 | ✅ 已确定 |
| 6 | **多 Agent 覆盖完整论文流程**：多 Agent 写作（Researcher / Writer / Final Editor / LaTeX Engineer）、事实核验（Fact Checker）、学术审稿（Academic Reviewer）、文风审查（Style Reviewer）、视觉审稿（Visual Reviewer），由 Paper Manager 统一调度 | ✅ 已确定 |
| 7 | **服务器端后续使用 Docker 部署** | ✅ 已确定 |

各决策的背景与影响见 [DECISIONS.md](DECISIONS.md)。

## 待确定事项

- 前端技术栈选型
- 后端语言/框架选型（PRD 中 `AgentRuntime` 接口以 TypeScript 表达，倾向 Node.js 生态，待最终确认）
- 数据库第一版使用 SQLite（PRD 建议方案，待最终确认）
- Docker 部署细节（镜像划分、compose 结构、TeX Live 镜像体积控制）

## MVP 阶段划分（摘自 PRD §25）

1. **基础运行**：Linux 部署 + OpenClaw Gateway + Backend + 核心 Agent + AgentRuntimeAdapter + LaTeX 编译 + PDF 输出
2. **论文工作台**：项目列表 / 新建 / 上传资料 / 写作任务 / 全面审稿 / 审稿报告 / Workflow 进度 / PDF 查看 / 历史版本
3. **视觉审稿**：PDF 页面渲染 + Visual Reviewer + 问题定位 + LaTeX Engineer 自动修复闭环
4. **系统管理**：系统状态 / Gateway 管理 / Agent 管理 / 模型管理 / Workflow 配置 / 日志 / 系统诊断 / 文件管理 / Command Center / Web Terminal
