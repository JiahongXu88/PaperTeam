# PaperTeam

面向学术论文**写作、审稿、事实核验、文风优化、LaTeX 编译与论文质量评估**的 AI 多 Agent 工作台。

普通用户只需通过浏览器使用；论文写作、Agent 调度、模型调用、LaTeX 编译、PDF 生成、版本管理、日志与系统维护全部由 Linux 服务器完成。

## 文档

| 文档 | 说明 |
|---|---|
| [docs/PRD.md](docs/PRD.md) | 产品需求文档 |
| [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md) | 项目当前状态与已确定决策 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 系统架构说明 |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 技术决策记录（ADR） |

## 目录结构

```text
PaperTeam/
├── frontend/   # Web 前端（论文工作台 + 系统管理后台）
├── backend/    # PaperTeam Backend（API / Workflow / Runtime / LaTeX / 版本管理）
├── agents/     # Agent 定义与配置（AGENTS.md 等）
├── docker/     # Docker 部署配置
└── docs/       # 项目文档
```

## 快速开始

项目尚处于初始化阶段，开发与部署指南待补充。

## 环境变量

参考 [.env.example](.env.example)：复制为 `.env` 后填入真实值。`.env` 已被 Git 忽略，**不要提交任何真实 Key**。
