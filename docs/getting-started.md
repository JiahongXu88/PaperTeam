# 上手指南（Getting Started）

> 目标：从 clean 仓库到打开工作台、配好模型、跑通第一条链路。面向使用者；
> 开发者请再读 [development.md](development.md)。

## 1. 前置条件

| 依赖 | 版本 / 说明 | 何时需要 |
| --- | --- | --- |
| Node.js | 22.22.3+ / 24.15+ / 25.9+（以根 `package.json` 的 `engines` 为准） | 必需 |
| Python 3 + `pymupdf` | `python -m pip install "pymupdf>=1.24"` | 导入已有论文 PDF、解析材料 |
| LaTeX（`xelatex` + `bibtex`） | MiKTeX / TeX Live 均可 | 编译 Draft / Final PDF；快速 Review 不需要 |
| Docling（可选） | `pip install docling` | 材料结构化解析（版面 / 表格）；缺省回退 pymupdf |

已在 Windows 11 上完整验证；Linux 由 CI（ubuntu + Node 22）与 Docker 镜像覆盖。
macOS 未做系统验证，依赖均为跨平台包。

## 2. 安装与启动

```bash
git clone https://github.com/JiahongXu88/PaperTeam.git
cd PaperTeam
npm run install:all   # 安装 backend 与 frontend 依赖
npm run doctor        # 环境自检（只报告，不修改）
npm run dev           # 构建 backend 并同时启动 Backend :3000 + Vite :5173
```

- `npm run doctor` 逐项检查 Node 版本、依赖、PDF 工具链（Python 候选：
  `PAPERTEAM_PDF_PYTHON` > `python` > `python3` > `py -3`），缺失项会给安装命令。
- 打开 **http://localhost:5173**（Vite 将 `/api`、`/health` 同源代理到 :3000）。
- 不配置模型应用也能启动：Agent 调用返回结构化失败（`model not_configured`），
  不会伪造成功。导入论文 PDF 若缺 pymupdf，返回 `503 PDF_PARSER_UNAVAILABLE`
  并附安装命令。

## 3. 配置模型（必需一步）

推荐走 UI：**设置 → 模型设置** → 选择 Provider / Model，粘贴 API Key，
「测试连接」通过后保存。

- Key 只经同源 Backend 保存到本机 `~/.paperteam`（Pi credential），不进仓库、
  任何接口不回显；清除入口在同一页面。
- 也可用环境变量（`PAPERTEAM_PI_MODEL` / `PAPERTEAM_PI_API_KEY`，复制
  `.env.example` 为 `.env`）；优先级：环境变量 > UI 保存。
- 支持 Pi 内置 Provider、OpenAI 兼容网关与自定义 Provider；Z.AI Key 需按类型
  选择 API 通道（Coding Plan / 按量）。详见
  [model-configuration.md](model-configuration.md)。

## 4. 跑通第一条链路（不花模型钱的路径）

1. 新建项目 → 「创建新论文」→ 填标题即可创建（不启动任务）。
2. 在项目内浏览各标签页（文献发现 / 文献库 / 证据 / 工作流……）。
3. 真实任务需要模型：从最小的「快速 Review」开始（一篇 PDF → 引用核验 +
   分章节审阅），或从综述主题开始（主题 → 综述闭环，关键节点 HITL 确认）。

## 5. 常见问题

| 症状 | 处理 |
| --- | --- |
| `PDF_PARSER_UNAVAILABLE` | 装 Python 3.10+ 与 pymupdf；`npm run doctor` 复查 |
| LaTeX 编译失败 | 确认 `xelatex`、`bibtex` 在 PATH；中文需要 ctex / Fandol 字体（TeX Live 装 `texlive-lang-chinese`，MiKTeX 自动按需装包） |
| 模型调用失败 | 模型设置里「测试连接」；Z.AI 用户检查 API 通道是否与 Key 类型匹配（Coding Plan Key ≠ 按量 endpoint） |
| 端口占用 | `PAPERTEAM_PORT` 改后端端口；Vite 固定 5173（strictPort） |
| Windows 下 LaTeX 超时只杀 shell | 已知遗留（`shell:true`），见 PROJECT_STATUS 限制清单 |

## 6. Docker（可选）

单机单用户；唯一对外端口 8080（nginx），backend 不直接暴露：

```bash
cp .env.example .env
docker compose build && docker compose up -d
curl -fsS http://localhost:8080/ready
```

镜像内已含 Python/pymupdf、XeLaTeX/bibtex 与中文字体。依赖审计与验收清单见
[DEPLOYMENT.md](DEPLOYMENT.md)。
