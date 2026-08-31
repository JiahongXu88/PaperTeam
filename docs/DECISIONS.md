# PaperTeam 技术决策记录（ADR）

> 状态取值：`proposed`（提议中）/ `accepted`（已接受）/ `superseded`（已被取代，注明替代者）。
> 新决策追加在文末，不修改历史条目。

---

## D-0001 Web 前端 + Linux Server 架构

- **日期**：2026-08-31
- **状态**：accepted

**背景**：目标用户（本科生、硕博研究生、科研人员、教师）不应接触命令行、Git、LaTeX 环境或 OpenClaw 配置；系统需支持长期部署与日常运维。

**决策**：浏览器是唯一用户入口；论文写作、Agent 调度、模型调用、LaTeX 编译、PDF 生成、版本管理、日志与系统维护全部在 Linux 服务器完成。

**影响**：前端只需 Web 技术栈；服务器端需要完整的运维能力，因此产品包含系统管理后台（诊断、日志、Command Center、Web Terminal）。

---

## D-0002 使用 OpenClaw 作为 Agent Runtime

- **日期**：2026-08-31
- **状态**：accepted

**背景**：Agent Team 需要 Session、Task、事件流、多 Agent 调度等成熟能力，自研成本高。

**决策**：第一版 Agent Runtime 采用 OpenClaw（OpenClaw Gateway），Agent 以 OpenClaw 体系承载。

**影响**：服务器需常驻 OpenClaw Gateway 并纳入运维（状态监控、重启、诊断）；Gateway 作为内部服务，不对外暴露。

---

## D-0003 以 AgentRuntimeAdapter 隔离 Runtime

- **日期**：2026-08-31
- **状态**：accepted

**背景**：业务层若直接耦合 OpenClaw API，未来替换或扩展 Agent Runtime 的成本极高。

**决策**：Backend 只依赖统一的 `AgentRuntime` 接口（runAgent / getTask / cancelTask / sendMessage / streamEvents / healthCheck），由 `OpenClawRuntimeAdapter` 提供第一版实现。

**影响**：业务层表达"调用哪个 Agent、执行什么任务、输入什么文件、获取状态与结果"，不感知 Gateway 细节；未来可替换 Runtime、新增 Agent / Reviewer / 模型而不动业务层。

---

## D-0004 LaTeX 作为论文主格式

- **日期**：2026-08-31
- **状态**：accepted

**背景**：学术论文需要专业排版、模板（学校/期刊）、公式图表与稳定编译产物；Markdown 等格式无法满足。

**决策**：论文主格式为 LaTeX；服务器使用 XeLaTeX + latexmk + Biber 编译输出 PDF；版本用 Git 管理，前端只暴露业务版本号（V12/V13…）。

**影响**：服务器需安装 TeX Live（体积较大，Docker 镜像需考虑体积控制）；需要 LaTeX Engineer Agent 处理编译错误与排版问题；Writer Agent 输出 LaTeX 而非纯文本。

---

## D-0005 双模式前端：论文工作台 + 系统管理后台

- **日期**：2026-08-31
- **状态**：accepted

**背景**：普通用户与管理员的关注点、权限、使用频率完全不同。

**决策**：前端提供两种工作模式并支持顶部切换——论文工作台（普通用户）与系统管理后台（管理员）。

**影响**：权限模型至少分两级；普通用户界面隐藏 session / agentId / Gateway 等技术信息，只展示业务阶段。

---

## D-0006 多 Agent 覆盖写作、事实核验、学术审稿、文风审查、视觉审稿

- **日期**：2026-08-31
- **状态**：accepted

**背景**：论文质量是多维的（事实真实性、学术质量、AI 文风风险、视觉排版），单一 Agent 无法覆盖。

**决策**：Agent Team 分工——Paper Manager（调度）、Researcher（文献与 Evidence）、Writer（写作）、Fact Checker（事实核验，输出 SUPPORTED / PARTIALLY_SUPPORTED / UNSUPPORTED / CONTRADICTED）、Academic Reviewer（学术评分）、Style Reviewer（AI 文风风险 0~100）、Final Editor（汇总修改）、LaTeX Engineer（编译修复）、Visual Reviewer（PDF 页面级视觉审查，使用视觉模型）。

**影响**：需要统一的 Evidence Store 与 Review Aggregator；全面审稿三个 Reviewer 可并行；修改闭环有默认通过条件（critical 事实错误 = 0、Academic Score ≥ 80、Style Risk ≤ 35）。

---

## D-0007 服务器端使用 Docker 部署（后续）

- **日期**：2026-08-31
- **状态**：accepted（尚未实施）

**背景**：Linux 服务器手动部署组件多（Node.js、OpenClaw、TeX Live、Poppler、数据库），环境漂移与迁移成本高。

**决策**：后续服务器端使用 Docker 部署，部署配置收敛到仓库 `docker/` 目录。

**影响**：需规划镜像划分（TeX Live 体积）、compose 结构与数据卷（projects/、数据库、日志）；第一阶段开发可先以裸机/systemd 方式运行，Docker 化不阻塞 MVP。
