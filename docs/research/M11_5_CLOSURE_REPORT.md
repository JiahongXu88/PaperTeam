# M11.5 Closure Report — Product, Documentation & Open-Source Closure

> 日期：2026-10-07 · 基线 SHA：`c62e9da`（M11.4 Reliability Closure 收口点）
> 性质：M11 最后阶段——产品能力 / 文档 / GitHub 首页 / Quick Start / 开源
> 呈现的收口，不新增核心 Agent 功能。

## 1. Executive Summary

**M11.5 COMPLETE；M11 COMPLETE；READY_FOR_M12。** 本轮以「先审计、后重写」
完成开源呈现收口：全量产品能力审计（前端 IA / 后端能力双代理代码级取证）→
README benchmark 研究（10 个成功开源项目）→ 英文主 README + 中文
README.zh-CN 双语重写（从 293 行技术架构说明书转为产品首页）→ 8 篇新文档 +
docs 导航 + research 索引 → 最小 UI IA 修复 6 项（documentType 标签、
workflow 叫法统一、综述项目侧栏、tab 命名、M11.4 分层终态渲染）→ MIT
LICENSE / CONTRIBUTING / SECURITY 三件套 → Quick Start 逐条真实验证 →
全量回归绿。语言策略与许可证为作者裁决项（本轮询问确认：英文主 README +
中文副版；MIT）。

## 2. M11 Final Capability Inventory（与代码一致）

**已实现（代码 + 测试 + 真实验收）**：

- 四类 workflow：`idea_to_paper` / `topic_survey` / `existing_paper_review` /
  `existing_paper_improvement`（`backend/src/workflow/kinds.ts`）；后端按
  documentType 派生（survey → topic_survey），前端不暴露内部名。
- 研究论文链路：feasibility（HIGH/MEDIUM/LOW/INSUFFICIENT + requiredExperiments
  实验清单）→ HITL 确认 → target_feasibility gate 阻止低可行 Final。
- 综述链路（M11.1–M11.3）：Matrix（chunk anchor fail-closed）→ Synthesis
  （grounding 判定表，LLM 无权自评）→ Outline（refs 契约）→ 写作不变量 →
  survey 四规则 gate；真实双 Case 到 PDF（54 cited / 0 hallucinated）。
- 已有论文返修（M10.3–M11.4）：意见导入（5 来源，逐字保存）→ 定向证据补充
  → scoped patches + PatchValidationRecord（7 类确定性判定）→ 分层判定
  （Revision Task 三态 / Publication Readiness 三态）→ Draft/Final；21 次真实
  run 可靠性收口（comment closure failure=0、guard false positive=0、
  越权事实改写进冻结产物=0）。
- 基础设施：证据接地（Retrieved ≠ Verified ≠ Grounded）、文献库五入库、
  混合检索零 Vector DB、引用双层核验、事实/引用保持守卫、Draft/Final 双
  冻结、不可变版本链、11 个 HITL 决策点、模型设置（7 Agent 键 / Z.AI 双
  通道 / 自定义 Provider 三协议）、docling+pymupdf 双链解析、Pi SDK 1.0.1
  in-process Runtime、scripted 测试 Runtime、Docker/Linux 部署（M5.5 真实
  验收）。

**仅设计 / 未来**：figure/图表生成（未实现，README 未声称）；MCP / 外部
Harness 集成（未实现，未声称）；Visual Reviewer（文本层审阅，README 限制
清单如实列出）；学术 80 分线全量校准（provisional floor 未启用）；多用户 /
鉴权。

## 3. Topic-to-paper 状态

对外表达为「创建新论文 → 论文类型（研究论文 / 综述论文）」。综述 = 近全
自动闭环（4 个 HITL 确认点）；研究论文 = 可行性 + 实验清单边界（不伪造结
果）。产品指南 §2 明确实验数据边界；README "Research honesty" 一节四条不
做清单。UI 侧 documentType 选择器真实存在（NewProjectPage），README 操作
描述与 UI 一致。

## 4. Existing Paper Revision 状态

对外表达：导入 PDF/LaTeX → 粘贴意见 → 定向证据 → 计划确认 → 受限修订 →
逐条结局（handled / already_satisfied / conflict / author_decision）→
Draft + 投稿就绪性。不暴露 PatchValidationRecord / alias / canonical ID 等
内部术语（下沉到 docs/existing-paper-revision.md）。**Revision Task Success ≠
Publication Ready** 在 README、product-guide、existing-paper-revision 三处
一致表述，且本轮起 UI 完成态真实渲染两层徽章（此前数据已解析但零消费——
见 §11）。

## 5. M11.4 Reliability 总结（README 口径）

"the revision workflow completed a reliability program of 21 real runs with
zero guard false positives and zero fabricated-content leaks"——具体数字
（23 项修复、S/T/U 三连、RSS 150-330MB 等）保留在 PROJECT_STATUS 与
research 报告，README 不堆内部里程碑（M11.4.6 / Attempt 7-9 / F23 等不出
现在首页）。

## 6. README Audit 发现（重写前）

- 状态停留在 **M6 COMPLETE**（M7–M11 全部缺失）。
- Pi SDK 版本过时（写 0.84.4 精确 pin，实际 1.0.1）。
- 已有论文路径描述停留在 M10.3 之前（无意见驱动返修、无分层判定）。
- 「这是什么」直接面向内部术语（evidence.ground、formalOnly、Gate 规则名）。
- Known Limitations 与 Quick Review 表述准确，予以保留精神。
- Quick Start 命令真实可执行（本轮复验），予以保留并精简。
- 截图 4 张在用、3 张孤儿（paper-output-dark / review-light /
  workflow-light）。

## 7. README Benchmark（10 项目研究）

样本：Dify ~158k、Open WebUI ~154k、RAGFlow ~92k、OpenHands ~90k、LobeChat
~83k、AnythingLLM ~67k、paperless-ngx ~46k、Khoj ~38k、Langfuse ~35k、
JabRef ~4.8k（star 为 2026-10-07 时点；逐 README 原文结构分析）。

**借鉴的 8 条原则**：① 第一屏 = 任务语言一句话 + 产品截图 + badge ≤ 3；
② 价值主张用动词句式（JabRef/Khoj 式）不用形容词堆砌；③ Quick Start =
前置显式 + 单一主路径 ≤5 行 + 成功判据；④ Feature 按用户工作流分桶
（JabRef 的 Collect/Organize/Cite/Share 模式），8-12 条为限；⑤ 自托管 AI
产品的信任章节（数据流向 / Key / 无 telemetry）是标配且 PaperTeam 门槛更
高（未发表稿件）；⑥ README 是橱窗与路由器，深度内容一律外移 docs；⑦ 研
究者工具需要 Citation / 研究使用段落（暂缓：项目尚无论文，未来可加）；
⑧ 演示优先级 demo > GIF > 静态截图（当前用真实截图，GIF/demo 列为 M12
候选）。

**不照搬**：badge 洪水（Dify ~30）；33 条 feature 平铺（Open WebUI）与逐行
provider 矩阵（AnythingLLM，下沉 docs）；营销化形容词（对研究者受众反效）；
企业三档板块（无商业版，会出现空节）；star history 图（新项目曲线平缓反
暴露弱点）；每 feature 一截图（维护成本）；开发者 setup 混入主 README
（移 CONTRIBUTING/development.md）。

## 8. README 信息架构决定

结构（英文主 / 中文副同构）：Hero（一句定位 + 截图 + 2 badge）→ What you
can do with it（两场景各 4-6 条）→ Key features（9 条能力表）→ Quick
start（4 行命令 + 可选依赖表 + Docker 3 行）→ How it works（两张极简
mermaid + 一句"流程控制是确定性代码"）→ Research honesty（四条不做）→
Privacy & data → Documentation（12 行导航表）→ Project status（alpha 定位
+ 诚实限制）→ Contributing → License。目标读者：先非技术（30 秒知道它是
什么、能帮什么、怎么启动、不会伪造结果），技术读者经 Documentation 表
3 跳内到 ARCHITECTURE/development/API。

## 9. README → docs 下沉内容

| 原 README 内容 | 去向 |
| --- | --- |
| 18 行核心能力大表（内部模块名密集） | 精简为 9 条用户能力表；细节分入 product-guide / evidence-and-citations |
| M1–M6 milestone 长段 | PROJECT_STATUS（已有）+ research 索引（新增） |
| Runtime 说明（Pi/角色映射/OpenClaw 历史） | development.md §4 |
| 技术栈表 / 目录结构 | development.md §3 |
| 测试与 E2E 说明 | development.md §2 |
| Docker 细节 | DEPLOYMENT.md（已有）+ getting-started §6 摘要 |
| Z.AI 双通道说明 | model-configuration.md §5 |
| Known Limitations 清单 | product-guide §7（保留全部七条） |

## 10. Docs 结构变化

新增 8 篇：`getting-started.md`、`product-guide.md`、
`existing-paper-revision.md`、`evidence-and-citations.md`、
`model-configuration.md`、`development.md`、`research/README.md`（75 份报告
的里程碑索引）、research/M11_5_CLOSURE_REPORT.md（本文）。更新 3 篇：
ARCHITECTURE.md（头部 M7–M11 现状 + §20 增量索引 + Pi 1.0.1 三处）、
PROJECT_STATUS.md（顶部 M11.5 条目）、.env.example（版本注释）。职责分工：
README=产品首页 / PROJECT_STATUS=工程状态 / ARCHITECTURE=技术架构 /
getting-started=安装 / product-guide=使用 / research/=证据。历史报告零删除
零重命名。

## 11. Product IA 一致性（最小修复 6 项）

1. `DOCUMENT_TYPE_OPTIONS` 补 `research_article=研究论文` / `survey=综述
   论文`——此前项目概览与列表行直接向用户显示英文内部值。
2. 新增 `WORKFLOW_KIND_RUN_LABELS`，统一任务记录 / 最近活动中同一 kind 的
   第三套叫法（topic_survey 曾被叫「从想法到论文」「论文生成」）。
3. ProjectAside：综述项目不再出现硬编码 `idea_to_paper` 的「生成论文」按钮
   （改为「综述调研」+ 正确 kind + 对应链路说明）。
4. 项目 tab「Discovery」更名「文献发现」（消除 HITL 提示引用不存在的页面
   名；中文 UI 一致性）。
5. 项目列表页副标题 / 空态补综述路径。
6. **M11.4 分层终态 UI 落地**：`completion.revisionTaskVerdict /
   publicationReadiness` 此前已解析但零组件消费——CompletedBlock 现渲染
   「返修任务 <徽章> · 投稿就绪性 <徽章>」；REVISION_TASK_COMPLETE 文案从
   「另见报告」改为真实呈现（新注册表 REVISION_TASK_VERDICT_STYLES /
   PUBLICATION_READINESS_STYLES）。

未做（记录为 M12 候选）：NewProjectPage 无「学位论文」档（产品语义上
documentType 展示侧的 thesis/期刊/会议建议值与创建侧两档并存）；Quality
Gate 面板对 `gate.revisionTask / publicationReadiness` 明细（含 checks 与
baselineInheritedRisks 清单）的逐项渲染。

## 12. Quick Start 验证（2026-10-07 本机实跑）

| 命令 | 结果 |
| --- | --- |
| `npm run install:all` | PASS（backend+frontend 依赖就绪） |
| `npm run doctor` | PASS：Node 24.15.0（engines 匹配）、双端依赖、Python 3.14.4 + pymupdf 1.28.2、Git |
| `npm run dev`（PAPERTEAM_TEST_RUNTIME=scripted） | PASS：backend :3000 `/health` `/ready` 全绿（runtime/filesystem/latex=xelatex+bibtex/pdf 四类检查 ok）、Vite :5173 HTTP 200、`/api/projects` 代理 200；测毕 taskkill 树杀 + netstat 验证端口释放 |
| `docker compose` | 未在本轮重跑（M5.5 已真实验收；CI 每次 push 构建两镜像并 smoke /ready） |

README Quick Start 命令 = 上述实跑命令原样。

## 13. 开源 Hygiene

- **LICENSE**：新增 MIT（作者裁决项；此前仓库无任何 LICENSE = 公开但默认
  保留所有权利）。
- **CONTRIBUTING.md**：新增（setup / PR 前置命令 / 评审关注点：确定性优先、
  测试先行、科研诚实、零新 Agent 倾向 / 禁密钥与真实稿件 fixture）。
- **SECURITY.md**：新增（GitHub 私有 security advisory 渠道——真实机制非虚
  构邮箱；Key 暴露 / 数据外流 / 子进程注入 / 无鉴权边界四类关注点）。
- **Badges**：CI + MIT 两个（对比 benchmark 反例 Dify ~30 个）。
- GitHub repo description（Claude 无权限修改，建议文本）：
  `Self-hosted AI workbench for academic writing — evidence-grounded papers from a topic, and reviewer-comment revision of existing manuscripts.`
- 已核查：`projects/` 与 `backend/projects/` 均 gitignore、0 文件被跟踪
  （本机真实论文数据不入库）；公开文档无 `D:\` 路径、无密钥。
- 未新增：CODE_OF_CONDUCT（暂缓——先看是否真有外部流量）、issue/PR 模板
  （同上）、star history、在线 demo。

## 14. Screenshots / Demo 状态

复用既有 4 张（projects/evidence/sources 未用/paper-output light——注：
sources-light.png 本轮从 README 移除以控制篇幅，保留在仓库）。重拍决策：
现有 projects-light.png 内容为演示项目（无隐私），而当前本机项目列表包含
真实返修项目（不可截屏），故**不重拍列表页**。3 张孤儿图
（paper-output-dark / review-light / workflow-light）保留不删（历史资产）。
Demo GIF / 在线 demo = M12 候选。

## 15. Tests（全部实跑记录）

| 项 | 结果 |
| --- | --- |
| Frontend full | 27 files / 281 passed（含 1 例 tab 更名断言同步） |
| Frontend typecheck + build | PASS |
| Backend typecheck + build | PASS |
| Backend full（4 workers） | 229 files passed / 3 skipped，2,538 passed / 15 skipped / 0 failed（148.6s） |
| `git diff --check` | PASS（见 §18 提交前检查） |
| docs link check（新增 `scripts/check-docs-links.mjs`，零依赖） | 262 个相对链接全通过 |
| e2e（Playwright） | 本轮未跑（无 UI 行为级变更触及 e2e 断言面；CI 会跑全量） |

## 16. Remaining Limitations（README/口径一致）

真实实验数据边界（研究论文停在实验清单）；部分决定保留给作者；学术评分非
通用投稿预测器（80 线未全量校准）；部署仍是演进区（Windows 开发 / Linux
Docker，建议 32GB Linux 服务器做真实 run）；图表生成未实现；Visual
Reviewer 未实现；PDF 重建文本级；单用户无鉴权；无分页；EvidenceStore JSONL
规模边界。docs 翻译（英文）为 M12 项。

## 17. M12 候选（本轮记录，未启动）

1. 产品 UI：documentType 学位论文档 / Quality Gate 分层明细渲染 / Demo GIF。
2. 部署：32GB Linux 服务器迁移 + full regression 常态化。
3. 文档英文化（docs/ 全量）。
4. 论文图表 / figure 生成能力调研。
5. 更广 publication benchmark（quality gate 校准延续）。
6. 外部贡献者基建（CoC / issue 模板）按真实流量再定。

## 18. Git Final State

提交序列与最终 HEAD/origin/main 状态见下方提交记录（本轮按逻辑拆分为
UI 修复 / 开源三件套 / README 双语重写 / docs 体系 / 状态与报告五笔提交，
全部推送后 HEAD == origin/main、working tree clean——最终 SHA 记录于
PROJECT_STATUS.md 顶部条目）。
