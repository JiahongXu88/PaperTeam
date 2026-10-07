# 开发指南（Development）

> 面向贡献者与二次开发。系统设计见 [ARCHITECTURE.md](ARCHITECTURE.md)；
> 安装与环境自检见 [getting-started.md](getting-started.md)；贡献流程见
> 仓库根 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 1. 命令

根 `package.json` 是唯一开发入口：

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 构建 backend 并同时启动 Backend :3000 + Vite :5173（`scripts/dev.mjs`） |
| `npm run doctor` | 环境自检：Node（复用 engines，单一事实源）/ 依赖 / PDF 工具链 |
| `npm run install:all` | 安装 backend + frontend 依赖 |
| `npm run build` | backend `tsc` + frontend 构建 |
| `npm run typecheck` | 前后端类型检查 |
| `npm test` | backend + frontend 全部 vitest |
| `npm run evaluation` | M6.8 评估框架 CLI（`backend/src/evaluation/`） |

backend 测试正式口径为 4 workers（`vitest run --maxWorkers=4`，见
`backend/package.json`）：PDF / Docling 子进程用例对内存敏感，默认 19 workers
在高负载下会触发取消超时。E2E：`cd e2e && npm install && npm test`
（Playwright，本机 Chrome；scripted 测试栈；各套件按环境门控跳过）。

## 2. 测试层次（CLAUDE.md 口径）

1. **Unit / Integration**（`npm test`）——编排引擎与业务服务为真实实现，
   仅 AgentRuntime 注入脚本化实现（`PAPERTEAM_TEST_RUNTIME=scripted`）：
   Workflow / checkpoint / SSE / HTTP / React / LaTeX 编译全真实，只有模型
   输出是确定性脚本，不需要模型 / 外网。
2. **Playwright E2E**（`e2e/`）——浏览器级确定性回归。
3. **Claude Browser Acceptance**（[BROWSER_ACCEPTANCE.md](BROWSER_ACCEPTANCE.md)）——
   探索式验收；不替代 Playwright，发现稳定 Bug 先复现、修复、再固化成回归。

可靠性工作的固定节奏：失败形态 → 确定性复现 → 修复 → 回归用例
（见 `docs/research/` 各报告）。

## 3. 仓库结构

```text
PaperTeam/
├── package.json         # 根开发入口（dev / doctor / build / typecheck / test）
├── scripts/             # dev 启动器 / doctor / 各里程碑真实运行脚本（研究记录）
├── frontend/            # React 工作台（React 19 + Vite 7 + TanStack Query + Zustand）
├── backend/             # Node 后端（原生 HTTP，无 Web 框架）
│   ├── src/workflow/    # WorkflowOrchestrator + 四类 workflow 定义（确定性编排）
│   ├── src/agents/      # Researcher / Writer / Reviewer / Citation / Feasibility 服务
│   ├── src/quality/     # Quality Gate / Build Gate / Revision Task Gate
│   ├── src/survey/      # 综述矩阵 / 综合 / 大纲 / 写作不变量
│   ├── src/search/      # 学术检索 Provider 层（OpenAlex / S2 / arXiv / AMiner / SearXNG）
│   ├── src/ingestion/   # Docling / pymupdf 双链文档解析
│   ├── src/settings/    # 模型设置 / 自定义 Provider 存储
│   ├── src/evaluation/  # M6.8 离线评估框架（非产品运行时）
│   └── tools/           # Python 子进程工具（parse_paper_pdf.py / parse_document_docling.py）
├── e2e/                 # Playwright 浏览器级 E2E（仅测试工具）
├── evaluation/          # 可靠性评估报告与校准记录
└── docs/                # 文档（PRD / 架构 / API 契约 / ADR / 状态 / 研究报告）
```

## 4. Runtime 说明（Pi in-process）

- Agent Runtime 为 **Pi SDK**（`@earendil-works/pi-coding-agent`，in-process，
  版本以 `backend/package.json` 精确 pin 为准）。业务层只面向 `AgentRuntime`
  契约 v2（`startAgent` → 句柄：事件流 / 取消 / result），Pi SDK import 限制
  在 Runtime 适配层（`backend/src/runtime/`）。
- **角色映射**：无 agent 注册表概念；角色（systemPrompt + 工具白名单）由适配
  层按 contextScope 前缀解析；会话维度 `projectId × agentId × contextScope`。
- **历史**：OpenClaw（2026.8→2026.9.1）是 M3.5/M3.6 的历史 Runtime 基线；
  M3.8 起迁移到 Pi 并移除全部 OpenClaw 运行时依赖（git 历史即回退机制）。
- 长程治理（M5.1/M5.2）：分层超时（通用 300s / 长任务 900s，env 可调）、全局
  并发上限与有界等待队列、上下文预算（超限回转/拒绝，绝不静默截断）、会话
  TTL/GC。详见 ARCHITECTURE §6。

## 5. 关键 env（完整见 `.env.example`）

| 变量 | 作用 |
| --- | --- |
| `PAPERTEAM_PI_MODEL` / `PAPERTEAM_PI_API_KEY` | 模型与 Key（优先级高于 UI 保存） |
| `PAPERTEAM_PI_RUN_TIMEOUT_MS` / `PAPERTEAM_PI_LONG_RUN_TIMEOUT_MS` | 通用 / 长任务超时 |
| `PAPERTEAM_PI_MAX_CONCURRENT_RUNS` / `PAPERTEAM_PI_MAX_QUEUED_RUNS` | 全局并发与等待队列 |
| `PAPERTEAM_PROJECTS_ROOT` / `PAPERTEAM_RUNTIME_ROOT` | 项目与运行时数据目录 |
| `PAPERTEAM_TEST_RUNTIME` | `scripted` = 测试注入确定性 Agent 实现 |

## 6. 约定

- **架构红线**（Authoritative State / 会话 / 事件 / 双 Gate / 零新 Agent 倾向）
  见 [ARCHITECTURE.md](ARCHITECTURE.md) §2 与 [DECISIONS.md](DECISIONS.md)。
- 前端 UI 文案注册表在 `frontend/src/constants/projectMeta.ts` 与
  `frontend/src/components/common/status.ts`；新增 kind / 终态 / documentType
  必须同步注册，避免裸英文内部值漏给用户。
- API 变更走 [API_CONTRACT.md](API_CONTRACT.md) 契约纪律。
- 不提交 `projects/`、`backend/projects/`、`.env`、`~/.paperteam`（已 gitignore）。
