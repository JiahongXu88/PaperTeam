# PaperTeam — Claude 开发指引

AI 多 Agent 学术研究与论文工作台（React 前端 + Node 后端 + Pi in-process Runtime）。
上手先读 `README.md` 与 `docs/ARCHITECTURE.md`；架构红线见 `docs/DECISIONS.md`（ADR）。

## 测试层次

Unit / Integration（`npm test`）→ Playwright E2E（`e2e/`，确定性回归）→
Claude Browser Acceptance（`docs/BROWSER_ACCEPTANCE.md`，探索式验收）。

对 UI / E2E 相关的业务变更：条件允许时，除了自动测试，还应执行一次
Claude Browser Acceptance（真实浏览器走用户路径，检查 Console / Network /
截图）。它**不替代** Playwright——发现稳定产品 Bug 时先复现、修复，
再固化成 Playwright regression。
