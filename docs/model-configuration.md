# 模型配置（Model Configuration）

> PaperTeam 不绑定任何模型厂商：在 UI 里配置 Provider / Model / API Key，
> 或用环境变量。本文说明配置面、按角色覆盖、Z.AI 双通道与 Key 存储策略。

## 1. 配置入口与优先级

- UI：**设置 → 模型设置**（推荐）。保存后新的任务立即使用新配置。
- 环境变量：`PAPERTEAM_PI_MODEL` / `PAPERTEAM_PI_API_KEY`（复制
  `.env.example` 为 `.env`）。
- 优先级：**环境变量 > UI 本地保存**。页面上会显示当前生效来源。
- 「测试连接」用当前填写的模型与 Key 发起一次最小真实调用（不保存），与
  保存后的真实任务走同一 Runtime、同一通道。
- 不配置模型：应用正常启动，Agent 调用返回结构化失败（`model not_configured`），
  不伪造成功。
- 在途任务运行中切换配置会被拒绝（409），避免同一 run 混用两个模型。

## 2. API Key 存储与安全

- Key 只经同源 Backend 保存到本机 `~/.paperteam`（Pi credential，
  `<agentDir>/auth.json`），**不进仓库、不进项目目录、任何接口不回显**；
  前端不写 localStorage，编辑框不回填。
- 「清除本地保存的 API Key」入口在同一页面（危险操作区）。
- 凭据按 Provider 共用，不按角色重复存 Key。

## 3. 按角色独立配置（Per-Agent）

七个业务 Agent 键可分别指定 Provider / Model（缺省继承全局默认）：

| 键 | 角色 |
| --- | --- |
| `writer` | Writer（章节写作 / 修订 / 润色） |
| `improvementPlanner` | 改进计划 Planner（与 Writer 分键，M10.4.2） |
| `researcher` | Researcher（调研 / 可行性支持） |
| `academicReviewer` / `factReviewer` / `styleReviewer` | 三路审阅 |
| `citationReviewer` | 引用核验 |

运行记录按 Agent × 模型归因 token / 成本（工作流「详细信息」可查）。
另有独立的 Vision 模型配置（图片分析用）。

## 4. Provider 支持

- **Pi 内置 Provider**（含 `zai` / `zai-coding-cn`），模型目录可在页面拉取。
- **自定义 Provider**：Base URL + 三种协议（anthropic-messages /
  openai-completions / openai-responses）+ 认证方式 + 额外请求头 + 自建模型
  目录（每个模型可声明「支持推理」「支持图片输入」与上下文窗口 / 最大输出）。
  适配各类 OpenAI 兼容网关。

## 5. Z.AI 双通道（重要）

Z.AI 的两种 Key **不能从内容判断**，必须按 Key 类型显式选择 API 通道：

| 通道 | Key 类型 | Endpoint |
| --- | --- | --- |
| Coding Plan（默认） | Z.AI Coding Plan 订阅 Key | Pi 内置 Coding endpoint |
| 按量 API | 个人充值 / API 余额 Key | `zai` → `https://api.z.ai/api/paas/v4`；`zai-coding-cn` → `https://open.bigmodel.cn/api/paas/v4` |

选错通道的表现是测试连接 TIMEOUT / 不可用；测试连接与保存后的真实任务使用
同一通道、同一 endpoint。

## 6. reasoning（推理档位）

- 模型 metadata 驱动：自定义 Provider 在模型目录里声明「支持推理」；
  内置模型由目录携带。
- 档位在测试连接与任务调用中按模型能力解析（如 GLM-5.3 不支持 off → 最低档）。

## 7. Runtime 层相关变量

完整列表见 `.env.example`；常用：`PAPERTEAM_PI_RUN_TIMEOUT_MS`（通用 300s）、
`PAPERTEAM_PI_LONG_RUN_TIMEOUT_MS`（长任务 900s，Writer/审稿按整篇论文输入）、
`PAPERTEAM_PI_MAX_CONCURRENT_RUNS`（全局并发，默认 4）、
`PAPERTEAM_PI_MAX_QUEUED_RUNS`（等待队列，默认 32）。
