# Claude Browser Acceptance（浏览器探索式验收工具）

> 状态：Pre-M9.4 交付（2026-09-22）。定位是**开发工具**，不是产品功能；
> 与 Playwright E2E 的分工、隔离与安全边界见下文。任何 Browser / CDP 接入
> 都只属于 Developer Tooling，不进入 backend runtime、frontend 产品包、
> Agent Runtime 或任何 production dependency（架构决策 D-0033 不变）。

## 1. Purpose

PaperTeam 已有确定性的 Playwright E2E（`e2e/`）。本工具在其上增加一层
**Claude 主导的探索式浏览器验收**：以真实用户视角打开真实 Frontend，
走真实 UI 路径（点击 / 输入 / 上传 / 刷新），并观察 Console、Network、
页面状态——用于发现 Playwright 固定用例覆盖不到的 UI 接线问题与长流程状态问题。

## 2. Playwright vs Claude Browser Acceptance

| | Playwright E2E（`e2e/tests/`） | Claude Browser Acceptance（本工具） |
| --- | --- | --- |
| 性质 | 固定、确定性、可重复 | 探索式、agent 主导、交互式 |
| 运行环境 | 本机 / CI | 本机（Claude Code 会话内；**默认不进 CI**） |
| 断言 | 代码内断言 | Claude 阅读 snapshot / console / network 后人工判断 |
| 回归固化 | 本身就是回归 | 发现稳定产品 Bug 后**下沉**为 Playwright regression |
| 浏览器 | Playwright 自启自管 | 独立隔离实例（见 §7），互不干扰 |

两者是上下游关系：Unit / Integration → Playwright E2E → Claude Browser Acceptance。
**Claude Browser Acceptance 不替代 Playwright**，也不修改任何现有 Playwright 用例。

## 3. Architecture

```
Claude Code
   │  （重启后的会话：原生 MCP 工具；当前会话无 MCP 时：Bash + mcp-bridge.mjs）
   ▼
@playwright/mcp connector（Browser Control Tool，e2e devDependency）
   │  --cdp-endpoint（bridge/launcher 路径）或自启（.mcp.json 路径）
   ▼
CDP（仅 127.0.0.1）
   ▼
Dedicated Chromium/Chrome（独立测试 profile，绝不触碰用户日常 Chrome）
   ▼
PaperTeam localhost（npm run dev 或 scripted 测试栈）
```

组件（全部在 `e2e/acceptance/`，仅测试工具）：

- **`browser.mjs`** — acceptance 浏览器生命周期（`start` / `status` / `stop`）：
  启动一台带独立 user-data-dir 的本机 Chrome，开 loopback-only 调试端口；
  stop 前校验目标进程命令行确实携带我们的 profile，只关闭自己启动的浏览器。
- **`mcp-bridge.mjs`** — 通用 MCP stdio 桥：spawn 本地 connector，完成 initialize
  握手后转发**单次**工具调用（`--list` / `--call <tool> --args <json>`）。
  它只是连接层，不含任何浏览器动作语义或业务逻辑。
- **`selftest.mjs`** — launcher 行为自测（见 §8）。
- **`.mcp.json`**（仓库根）— 给重启后的 Claude Code 会话注册原生
  `playwright-browser` MCP 工具（同一 connector 的 standalone 模式）。

## 4. Prerequisites

- Node（满足根 package.json engines）与 `npm run install:all`
- 本机 Chrome（`channel: chrome`，与 Playwright E2E 同一依赖；可用
  `PAPERTEAM_ACCEPTANCE_CHROME` 指向其它 chromium 可执行文件）
- `cd e2e && npm install`（含 `@playwright/mcp` devDependency）

## 5. How to start PaperTeam

优先复用现有开发启动流程，**没有第二套启动系统**：

```bash
npm run dev        # backend :3000 + vite :5173（真实生产 dev server）
```

Safe / Deterministic 模式（不产生任何真实模型费用，见 §9）用 scripted 栈
（与 `e2e/tests/*.spec.ts` 文件头注释同一配方）：

```bash
npm --prefix backend run build
mkdir -p e2e/.tmp/acceptance/stack/runtime e2e/.tmp/acceptance/stack/projects
PAPERTEAM_TEST_RUNTIME=scripted CITATION_METADATA_ENABLED=0 \
PAPERTEAM_PORT=3170 \
PAPERTEAM_RUNTIME_ROOT="$(pwd)/e2e/.tmp/acceptance/stack/runtime" \
PROJECTS_ROOT="$(pwd)/e2e/.tmp/acceptance/stack/projects" \
node backend/dist/index.js
# 另一个终端：
cd frontend && PAPERTEAM_PORT=3170 npx vite --port 5179 --strictPort
```

## 6. How to start / connect browser

```bash
cd e2e
npm run browser:acceptance:start     # 启动（--headless 可选；默认有头便于旁观）
npm run browser:acceptance:status    # pid / port / CDP endpoint / profile
npm run browser:acceptance:stop      # 关闭（--purge 顺带删 profile）
```

之后 Claude 用 connector 工具操作浏览器。两种通道：

- **原生 MCP（首选）**：重启 Claude Code 后 `.mcp.json` 的 `playwright-browser`
  工具集自动可用（首次需在会话内批准该 MCP server）。该模式下 connector
  自启自管一台隔离浏览器，无需先跑 launcher。
- **MCP 桥（无需重启的会话）**：
  ```bash
  node e2e/acceptance/mcp-bridge.mjs --list
  node e2e/acceptance/mcp-bridge.mjs --call browser_navigate '{"url":"http://localhost:5173/"}'
  ```
  桥固定通过 `--cdp-endpoint` 连接 launcher 启动的那台浏览器（先 start）。

与 Playwright E2E 完全不抢浏览器：E2E 自启自管自己的实例；
acceptance 浏览器有独立 profile 与独立端口策略（见 §7/§8），
先跑 Playwright 再跑 Acceptance（或反过来）都互不影响。

## 7. Isolation

- acceptance 浏览器使用独立 user-data-dir：`e2e/.tmp/acceptance/profile`
  （bridge/launcher 路径）或 `e2e/.tmp/acceptance/mcp-chrome-profile`
  （`.mcp.json` 路径），均在 gitignored `e2e/.tmp/` 下。
- **绝不**读取用户日常 Chrome 的 Cookies、登录态、历史、扩展或密码数据；
  不复用、不挂载用户 profile。
- 测试结束 `stop --purge` 即可删除；profile 可随时安全重建。

## 8. CDP security

- 调试端口默认 `9222`（`--port` 或 `PAPERTEAM_ACCEPTANCE_PORT` 可改），
  被占用时自动向后找空闲端口（最多 +10）——**9222 不是架构常量**。
- Chrome 的 DevTools 服务只绑 `127.0.0.1`（我们从不传
  `--remote-debugging-address`）；`selftest.mjs` 用 netstat 核验无
  `0.0.0.0` / `[::]` 监听。
- `stop` 只 `taskkill` state.json 里记录、且命令行校验确属我们的那一个 pid；
  pid 被复用成无关进程时**拒绝 kill**（`refused-unverified-pid`）。
  绝不杀用户或其它工具的 Chrome。
- CI 不启动任何 remote debugging port（本工具默认不进 CI）。

launcher 行为由 `npm run browser:acceptance:selftest` 覆盖：start /
already-running / port-occupied 自动换端口 / status / stop / stale pid /
stale profile / 不杀无关进程 / loopback-only / bridge 冒烟。

## 9. Safe acceptance mode

验证浏览器交互能力时不必调用真实模型：

- 用 §5 的 scripted 栈（`PAPERTEAM_TEST_RUNTIME=scripted`）：编排 / HTTP /
  React / checkpoint 全真实，只有模型输出是确定性脚本；
- 隔离 `PAPERTEAM_RUNTIME_ROOT` + `PROJECTS_ROOT`（`e2e/.tmp/acceptance/stack/`），
  不污染开发数据；
- 项目创建 / Tab 切换 / 文献库 URL 导入 / 手动上传 PDF 等路径本身不依赖模型。
- 页面始终是**真实生产 frontend**（Vite dev server），不是 mock DOM。

M9.4 / M9.6 的真实模型验收复用同一套工具，只换启动栈。

## 10. How Claude should perform acceptance

每次一个动作、边看边走（exploratory）：

1. `browser_navigate` 打开页面 → `browser_snapshot` 读可访问性树；
2. 依据 snapshot 决定下一步：`browser_click`（元素 ref）/ `browser_type`
   （ref + text）/ `browser_file_upload`（选择器触发后给绝对路径）；
3. 关键节点：`browser_take_screenshot` 留证、`browser_console_messages`
   查错误、`browser_network_requests` 核对请求与状态码；
4. 刷新（重复 `browser_navigate`）验证状态持久。

核心交互（建项目 / 导航 / Tab / 点击 / 上传）必须走真实 UI；
API 只允许用于准备 fixture 与清理测试数据。

## 11. Console / Network / Screenshot

- Console：`browser_console_messages` 至少能发现 `console.error`、
  unhandled rejection、React runtime error（connector 汇报页面错误）。
  注意 bridge 通道下消息窗口是「本次连接期间」——每个动作调用返回其
  观察窗内的消息即可满足验收。
- Network：`browser_network_requests` 返回 method / URL / status。
  本工具**不采集、不落盘任何请求头**（从源头避免 Authorization / API Key
  泄露）；报告如需引用请求，只写 method + path + status。
- Screenshot：`browser_take_screenshot`（显式文件名相对仓库根）落盘到
  gitignored 的 `e2e/.tmp/acceptance/shots/`。**截图不入 Git**；只有既有
  Playwright visual snapshot 按原规则入库。

## 12. File upload

- 用仓库 fixture（如 `e2e/fixtures/tiny-paper.pdf`、
  `backend/test/fixtures/pdf/attention.pdf`）或新建极小 fixture；
  **不用用户私人文件**。
- connector 流程：点击触发 file chooser 的控件 → `browser_file_upload`
  传仓库内绝对路径 → 回到 UI 确认状态变化（如「全文已获取」）。

## 13. Bug → Playwright regression workflow

验收中发现疑似产品 Bug 时：

1. **复现**：在 acceptance 浏览器里重走路径确认可稳定触发；
2. **修复**：按正常开发流程改产品代码；
3. **固化**：Bug 稳定复现且属于产品行为 → 增加最小 Playwright regression
   （放 `e2e/tests/`，沿用现有 selector / 清理约定）；
4. 不把 agent 误点、网络偶发、测试环境问题硬写成 regression。

## 14. Shutdown / cleanup

```bash
cd e2e && npm run browser:acceptance:stop   # 关浏览器（--purge 删 profile）
# 关 scripted 栈 / dev 栈（Ctrl+C；后台起的按进程树 taskkill 并 netstat 核验）
```

结束后不应残留：Chrome 进程、debugging 端口、dev server、测试项目
（用 API 归档 + 删除）、`e2e/.tmp/acceptance/` 下不再需要的截图与 profile。

## 15. Known limitations

- **bridge 通道的事件窗口**：console / network 消息按「连接期间」采集，
  动作之间的空闲期事件不可回放（原生 MCP 通道无此限制——server 全程在线）。
- bridge 每次调用冷启动一个 connector 进程（约 1-3s 开销）；
  `.mcp.json` 原生通道无此开销。
- `.mcp.json` 的相对路径以「从仓库根启动 Claude Code」为前提；
  从其它目录启动时 profile 会落到别处（仍隔离，仅位置漂移）。
- `browser_file_upload` 需要先触发 file chooser；直接对 `<input type=file>`
  点击即可（PaperTeam 新建项目 / 文献库手动上传都是这种控件）。
- Windows 优先：launcher 的进程校验 / taskkill / netstat 路径是 win32 实现；
  其它平台需按 §8 的语义补齐（connector 本身跨平台）。
- Acceptance 浏览器与用户 Chrome 并存时是两个独立进程组；
  有头模式下桌面上会多一个 Chrome 窗口（属预期，可用 `--headless`）。
