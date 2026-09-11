# PaperTeam 项目状态

> 更新日期：2026-09-10（**M4.8 Product Closure 完成，M4 ✅ COMPLETE**；同日
> M4.7 Draft/Final + Writer–Reviewer Closure；M4.6 Evidence Workbench；
> 2026-09-09：M4.5 HITL UI / M4.4 Workflow Live View；更早见历史）

## 当前阶段

**M4 — MVP Complete（✅，2026-09-10，v0.1.0-mvp）**：M4.8 Product Closure +
Version Experience + Public Repository Readiness 收口后，M4 全部完成。定位
**MVP / Alpha**（非 Production Stable）。下一阶段为 M5（Optional / Future，
未开始）：Visual Reviewer、Skill install/update、Deployment、System Admin。

**M4.8 — Product Closure + Version Experience + Public Repository Readiness
（✅ 完成，2026-09-10）**：
**M4.8 — Product Closure + Version Experience + Public Repository Readiness
（✅ 完成，2026-09-10）**：
M4 收口三件事——(A) **版本体验**：版本历史 / 确定性比较 / 不可变恢复；
(B) **产品闭环**：Existing Paper Improvement 浏览器全链路可达（PDF 确定性
重建 + 改进入口）+ 摘要成为一等修订目标（治本 M4.7 遗留）；(C) **公开仓库
收口**：README / 架构图 / 截图 / Quick Start / Known Limitations / Release。

- **版本域（后端权威）**：`VersionService` 把修订链（`ManuscriptRevisionStore`）
  与 review / gate / build / artifact / iteration / plan 关联成
  `ManuscriptVersionDTO`（对齐口径与 FinalizeService 一致；前端拿到即展示、
  绝不拼装猜测）。HTTP：`GET /versions`、`GET /versions/compare?from=&to=`、
  `POST /revisions/:n/restore`（活跃 run 409）。
- **确定性 Compare（零 LLM，D-0028 相关纪律）**：两修订快照逐文件内容对比
  （modified / unchanged / added / removed）+ LCS 行级增删规模（超界退化为
  行数差）+ 两端 review / gate 记分对照；章节标题取自该修订快照内的大纲。
- **Restore = 新修订（D-0027）**：把 rev{n} 快照复制回工作树，以
  `source=revision.restore` + `restoredFrom={n}` 走正常 commit 流程产生新修订；
  历史登记与快照、旧 Draft / Final 产物永不改动；旧 review / gate / build
  结论因修订前进自然 stale（Finalize 对齐校验拒绝偷用旧结论）；内容与当前
  一致时 `created=false`（幂等事实）。
- **版本 UI（论文产出 tab 内，无新一级导航）**：版本时间线（修订号 / 当前
  版本 / Final / Draft / 恢复来源 / 审稿轮次 / 门禁结论 / 迭代 outcome /
  计划计数）+ 比较（双下拉 + 章节状态表 + 记分对照）+「恢复此版本」行内
  确认（文案如实：创建新修订、历史不删除、旧门禁过期需复审）。Final 后
  继续修订的语义：Final 卡明确「最终版本 修订 N 的 Final / 当前工作版本
  修订 M 尚未 Final」双事实；两份 Final 可并存为历史。
- **摘要治本（D-0029）**：digest 有大纲时单列 `[abstract]` 块（组装根只留
  结构说明）；摘要类 section 引用（摘要 / abstract / main.tex（摘要））只
  路由到摘要目标——载体 `outline.abstract`（修订写回 outline.json，
  writeMainTex 重组生效），绝不落入组装根；Writer 摘要修订输出纯文本
  （结构校验拒绝 LaTeX 结构）。
- **Improvement 浏览器闭环（D-0028）**：PDF 导入（goal=improvement）项目在
  `import.parse` 无 main.tex 时由 `PaperReconstructor` 确定性重建（零 LLM）：
  outline / sections/secNN.tex / references.bib / 组装根；LaTeX 特殊字符
  转义、`[n]` 标记按提取器 relations 映射 `\cite{refN}`、子章节合并 ≤20；
  **如实边界：文本级重建，不含原图 / 原版式**。改进计划 prompt 携带真实
  章节文件清单（此前「必须是现有章节文件之一」无清单无法执行）。Review
  tab 新增「开始系统性改进」入口（此前该路径从浏览器不可达）。
- **测试**：Backend 565 passed（新增 版本域 7 / 重建与 Improvement 全链路 3 /
  摘要路由 1 / 版本域重启恢复 1 / 真实 smoke 回归 issues-omission 1）+
  Frontend 161（新增 VersionHistory 5）；build / typecheck 双侧干净。
- **E2E**：`e2e/tests/version.spec.ts`（A–F + V，7 例：历史展示 / 比较 /
  恢复新修订与历史不变（API 权威核验）/ 恢复后 Finalize 409 如实拒绝 /
  Final 后继续修订双事实 / 重新过 Gate 两份 Final 并存 / Light-Dark 视觉）；
  `e2e/tests/improvement.spec.ts`（I + V，2 例：浏览器全链路 PDF 导入 UI →
  改进入口 → 重建 → 计划 HITL 面板确认 → 修订 → 真实 latexmk 构建 →
  Draft → 复审 → Gate → Final → 查看 / 下载；视觉 + 1100px 无溢出）。
  既有套件复验零回归（hitl 7 / evidence-gate 7 / paper-artifacts 10 全绿）。
- **重启恢复**：`versionRestart` 集成测试——同一 projects 根两栈先后运行，
  awaiting HITL 跨进程恢复（recoverInterruptedRuns 同 index.ts 入口）、
  resume 推进到 Final、版本 / 计划 / 迭代 / 产物清单跨栈一致、重启后
  restore 语义不变。
- **公开仓库收口**：README 重写（30 秒理解定位 / 核心能力 / Mermaid 架构与
  产品流程图 / 截图 / Quick Start / Known Limitations 真实清单 / M4 MVP
  定位）；ARCHITECTURE / API_CONTRACT（§1.2f）/ DECISIONS（D-0027~D-0029）
  同步；secret / 私密数据 / 绝对路径扫描清洁；`v0.1.0-mvp` tag +
  Release Notes（docs/RELEASE_NOTES_M4.md）。
- **真实模型 Improvement smoke（2026-09-10/11，zai-coding-cn/glm-5.3 + 本机
  MiKTeX latexmk 4.88；输入 arXiv 1706.03762「Attention Is All You Need」
  15 页 PDF，4 个 run / 7 个修订 / 约 2 小时模型时间）**：
  - **全链路真实达成**：PDF 导入 → `import.parse` 确定性重建（23 节→10
    个一级章节，40 条 references→bib，callout→`\cite` 映射）→ `import.
    baseline_build` 真实 latexmk 编译重建稿通过 → Researcher 论文理解
    （13 weaknesses，真实工具调用 ~15min）→ citation.verify（40 条真实
    metadata 核验）→ 三路审稿 ×6 轮 → 可行性 INSUFFICIENT（诚实）→ 改进
    计划 → HITL approve → Writer 真实逐节修订（revision.apply，rev2/4/7）→
    bounded revision.revise → 复审 → **Quality Gate FAIL（可解释 5 阻止项：
    16 条 UNSUPPORTED claims / 8 blocking / critical 8 major 15 / 学分
    73<80 / 可行性 INSUFFICIENT）** → stalled HITL `accept_draft`（真实
    CONVERGED 路径）→ **真实 latexmk 构建（7.9s）→ Draft 冻结
    art-draft-rev7** → `POST /finalize` 422 如实拒绝（不降 Gate、不伪造）→
    restore rev1 → rev3/rev6（历史不动）。
  - **真实 smoke 驱动出的两处产品修复**：① 真实 Reviewer 复审偶发省略
    `issues` 字段 → 旧解析判结构失败、整轮昂贵审稿作废（run 1 以此失败
    2/2）——修复为 issues 缺省/null = 无发现（与 claims 口径一致，存在但
    非数组仍拒绝）；② 真实 Writer 按论文原内容重写章节时重新引入
    `tikzpicture`，而 ctexart 组装前导只含 amsmath/amssymb/natbib →
    "Environment tikzpicture undefined" → 修复循环未除净 → Build FAIL 无
    Draft（run 3 以此结束）——修复为修订 / 修复 prompt 明示可用宏包契约
    （图形以文字描述或 table 呈现），修复后 run 4 的 revision.apply 输出
    tikz-free，手动真实构建（同一生产代码路径 `POST /build`）通过并冻结
    Draft。
  - **诚实边界（如实记录）**：run 4 的 bounded `revision.revise` 因单次
    Agent 调用超时（默认 300s）失败 2/2——真实模型在本机延迟下重写大
    章节可超时（可用 `PAPERTEAM_PI_RUN_TIMEOUT_MS` 调大）；该 stage 的
    完成路径由 run 3 真实验证（两轮自动修订 → 收敛 HITL）。最终版本链
    rev1-7 完整保留四类来源（审稿快照 / 应用改进 / 自动修订 / 版本恢复）。

两个闭环落地——(A) **Draft / Final 产物闭环**：Build Gate 产出真实 PDF、
Draft 即时冻结、Final 双 Gate 校验后冻结、产物不可变可下载；(B) **Writer–
Reviewer 修订闭环**：审稿意见 → 确定性修订计划 → Writer 逐节修订 → 强制
复审 → 确定性收敛判定（PASS / IMPROVED / CONVERGED / REGRESSION），不收敛
与超限交给 HITL。7 个 commit（a1f5df8 → ed51b2e）。

- **manuscript 修订域（Authoritative）**：`ManuscriptRevisionStore`——每个
  改稿动作（outline.plan / writing.sections / revision.revise / apply /
  repair_latex / review 快照）提交**内容哈希幂等**的不可变修订号；gate /
  build / artifact 记录各自携带对齐修订，Finalize 据此拒绝 stale 结论。
- **确定性修订计划（D-0026）**：`revision.plan` stage 纯代码派发
  critical/major finding 与引用缺失（`reviews/revision-plan-r{round}.json`
  落盘）；minor / gate 阻止项只记录不派发（防非收敛循环）。Writer 只是
  计划的执行者，禁止凭空新造文献。
- **收敛判定（确定性无 LLM）**：每轮 gate 与上一轮 scorecard 对比得
  PASS / IMPROVED / CONVERGED / REGRESSION，逐轮追加 iteration-history；
  CONVERGED / REGRESSION / 计划空 → `hitl.revision_stalled`（两轮记分卡
  对比 payload）；预算耗尽（默认 2 轮 + HITL revise_more ≤3）→
  `hitl.revision_overflow`。两节点均 accept_draft / revise_more / cancel；
  **accept_draft 在预算尚余时也被尊重**（E2E 驱动出的修复）。
- **LaTeX 诊断 + bounded repair loop**：compile.log 结构化解析（文件 / 行号
  / 错误 / 附近行）→ `revision.repair_latex` 每项目自动修复 ≤2 次，最小
  上下文（只给受影响文件 + 诊断，绝不整篇论文 + 整份日志），可取消；
  修复即改稿 → 既有结论过期，复审后才能 Final。
- **Draft / Final 产物域**：`artifacts/` 不可变 manifest
  （art-draft-rev{n}.pdf / art-final-rev{n}.pdf）；**Build 通过即冻结 Draft
  （质量语义不参与，D-0015）**；`FinalizeService` 纯确定性双 Gate 校验
  （零 LLM：不允许「Final Reviewer Agent 判断能不能 Final」）。
- **HTTP（见 API_CONTRACT §1.2e）**：artifacts 清单 / 元数据 / download
  （**只经 manifest 解析，不接受任何路径参数，防 path traversal**；inline
  缺省 = 浏览器原生 viewer，`?disposition=attachment` 才落盘）/ finalize
  （活跃 run 409；条件不满足 422 可行动文案）/ build 记录 / build/log /
  revisions / iterations / revision-plan。
- **前端 PaperPanel**（项目 tab「论文产出」，quick-review 项目不显示）：
  Final 卡（冻结修订 / 通过轮次 / 查看 / 下载）+ Draft 卡（可用性 + 「当前
  版本可以作为 Draft，但尚未满足 Final 要求」边界文案）+ 构建状态卡
  （工具 / 耗时 / 对齐修订 / 结构化诊断 / 编译日志折叠）+ 迭代历史卡
  （每轮 outcome：首轮 / 有实质改善 / 已通过 / 不再收敛 / 出现退化）+
  产物历史（不可变清单）。标记 Final 按钮**永远可点**，资格由后端判定，
  422 拒绝如实呈现——绝无前端 `if (buildOk && qualityOk)` 自行产生 Final
  的路径。
- **测试**：Backend 553 passed（新增 revisionLoop 收敛语义 6 + 组装根
  main.tex 修订 / 修复两条回归、FinalizeService / ArtifactStore / repair loop /
  修订幂等等 suites）+ Frontend（PaperPanel / API 层）；`npm run typecheck`
  双侧干净。
- **E2E（`e2e/paper-artifacts.spec.ts`，10 例，scripted 栈 + 本机真实
  MiKTeX latexmk）**：A gate 通过 → 真实编译 → Final 冻结（inline 查看 /
  attachment 下载 / 产物历史）；C fail→修订→复审通过→Final；D REGRESSION
  / E CONVERGED → stalled HITL → accept → Draft；F 预算耗尽 → overflow →
  accept；B 复用其终态验证 Draft 语义（质量门禁不阻塞 Draft；finalize 422
  拒绝且**不出现「因此 PDF 无法生成」错误语义**）；G 真实编译失败 → bounded
  修复成功 → 复审 → Final；H 修复耗尽 → Build FAIL → overflow（buildOk=false）
  → 无 PDF + finalize BUILD 拒绝；I 快速 Review 只读红线（无论文产出 tab、
  完成后零产物）；J Light/Dark + 1100px 无横向溢出。全套 10/10（1.1m）。
- **E2E 驱动出的两处真实修复**：stalled accept_draft 在修订预算尚余时被
  忽略（planner 仍自动再修一轮）；revision.revise 修订 prompt 章节标题用
  了大纲 id 而非人类标题。均先以 E2E 复现、再修、再全量回归。
- **真实模型 smoke 驱动出的修复（2026-09-10）**：真实 Reviewer 会把摘要类
  finding 归到 `main.tex（摘要）`，`sectionMatches` 的宽松匹配
  （`ref.includes(stem)`，stem="main"）把它路由到组装根 main.tex → Writer
  收到 `\documentclass` 全文、按指令返回完整骨架 → DoD 拒绝（2/2）→ run
  failed。修复：**有大纲时组装根 main.tex 绝不作为修订目标 / 修复目标**
  （`listRevisionTargets` 跳过；repair 侧同样过滤，诊断只指向组装根时记一次
  空尝试走既有耗尽路径）；该条 finding 留在计划里不派发（复审可见，最坏走
  收敛 HITL）。scripted Writer 增加「修订 prompt 含 \documentclass → 返回
  完整骨架」镜像 + 回归测试，防此类回归静默通过。
- **真实模型 smoke（2026-09-10，zai-coding-cn/glm-5.3 + 本机 MiKTeX
  latexmk 4.88，run w-b974e4333932）**：真实小论文全链路（研究主题：中文
  商品评论情感分类的少样本示例选择策略实证研究）——调研 2.5min（5 gaps /
  bibliography）→ 可行性 MEDIUM → HITL → 大纲（8 节）→ HITL → 分节写作 →
  引用核验（hallucinated=0）→ **三轮审稿 × 两轮修订**（iteration：
  首轮 null → IMPROVED（critical 2/major 8/学分 42 → 2/3/47）→ CONVERGED
  （2/4/49，失败规则集相同））→ `hitl.revision_stalled`（outcome=CONVERGED，
  呈报两轮记分卡）→ accept_draft → **真实 latexmk 编译（5.6s，exitCode 0）
  产出 165KB PDF** → Draft 冻结（art-draft-rev4）。**诚实结果：Draft PASS，
  Final correctly blocked**——论文无真实实验（Writer 如实以「待实验产出后
  填充」占位而非编造数据），academicScore=49 < 80 等五项 gate 阻止如实
  上报；`POST /finalize` 422 QUALITY_GATE_FAILED（可行动文案）；产物下载
  200 inline（浏览器原生 viewer）；`..%2f` 路径穿越 404。本 run 的 reviewer
  再次把摘要 critical finding 归到 `main.tex（摘要）`——修复后正确留在计划
  里不派发，revision.revise 顺利完成，组装根完好。

**M4.6 — Evidence Workbench + Quality Gate UI（✅ 完成，2026-09-10）**：
把「这篇论文里的核心论断，依据是什么？可靠吗？」做成一等公民页面——
Evidence 工作台 tab + 质量门禁面板。**后端只做最小补口**（审计先行：
Evidence / Review / Citation / QualityGate 四域产物与关系全部核对），
前端严格只渲染后端事实，不自行推断。

- **后端最小补口（无新架构）**：`ReviewArtifactStore` 新增 gate 产物读取
  （`gateFileName` / `gateRounds` / `loadGate` 防御式校验）；HTTP 新增
  `GET /api/projects/:id/quality-gate`（?round= 历史轮，返回
  `{rounds[], round, gate, reviewSummary, latestReviewRound, stale}`，
  round 隔离由产物结构保证——quality-gate-r{n}.json 内嵌同轮
  reviewSummary）；`POST /evidence` 支持可选核验字段
  （verificationStatus / verificationLevel / supportStrength，枚举校验 400）。
  QualityGate 评估逻辑零改动（仍为确定性代码，前端绝不重算 PASS/FAIL）。
- **修复（既有接线缺口）**：`CITATION_METADATA_ENABLED=0` 此前只接到旧
  CitationService，quick review 的 `citation.metadata` stage 仍会真实外呼
  Crossref/OpenAlex（网络慢时整条 run 停滞，e2e 偶发超时根因）——现在
  serviceStack 把 metadataEnabled / metadataTimeoutMs / contactEmail 一并
  接到 citationIntegrity 的 resolver（disabled → 空 provider 集逐条
  UNRESOLVED，不外呼；显式注入的测试 providers 优先）。
- **Evidence 工作台**（`EvidencePanel`，项目 tab「证据」，URL state）：
  ledger 概况（总数 / 已核验 / 待核验 / 需注意 / 被正文使用 / 来源）+
  本地筛选（状态 segmented / 章节 / 来源 / 搜索 id-claim-摘要-引文-DOI）+
  行内截断展开 + 详情 provenance（文献 / DOI / 页码 / 章节 / 核验方式 /
  使用记录）+ 低重量「确认已核验」（unverified 行才出现）。中文状态标签
  （unverified 待核验 / verified 已核验 / plausible 大体可信 / mismatch
  与来源不符 / unverifiable 无法核验 / not_found 未找到来源），Domain 枚举
  不动；mismatch/not_found/unverifiable + contradictory 计入「需注意」，
  INSUFFICIENT/无法核验用中性/警示色不用红色；未落库的字段（如 finding
  的 evidenceIds）只防御性渲染、不虚构。
- **质量门禁 UI**（`QualityGatePanel`，挂在 WorkflowPanel 内；Overview
  克制质量状态卡；Review tab 仅 improvement 类型显示结论条）：结论徽标 +
  阈值行 + 阻止项清单（ruleId → 中文注册表 + 前往处理深链 `?tab=evidence
  &attention=1` 等，按 ruleId 映射不按 reason 字符串匹配）+ 15 条规则清单
  （通过 / 未通过 / 不参与判定；citationIntegrity 4 条与
  citation_semantic_verification_off 中性展示）+ 同轮审稿上下文（round
  隔离可视化）+ 历史轮次切换（轻量 select，逐轮 refetch）+ 过期提示
  （stale = gate 轮次 < 最新 review 轮次，手动重评按钮）+ Draft/Final 边界
  文案（未通过 ≠ 不能生成 PDF）。semanticMode=off 的快速 Review 项目如实
  显示「不运行门禁」空态，Overview 不显示质量卡。
- **集成**：阶段时间线 quality.gate 完成行「查看门禁详情」滚动入口；HITL
  修订耗尽 payload「查看详细问题」入口；Overview 质量状态卡（含过期 /
  未评估态）。
- **测试**：Backend 514（新增 GateApi 3：空态 shape / fail→pass 两轮 rounds
  desc / ?round= 隔离与 404/400 / 9 条基础规则集；httpResources +1 手工登记
  核验字段；serviceStack 3：metadata 接线回归）+ Frontend 141（新增
  EvidencePanel 7 / QualityGatePanel 10）全部 PASS。
- **E2E（`e2e/evidence-gate.spec.ts`，7 例，scripted 栈）**：A1 完整
  idea_to_paper（fail→pass 修订环）产出两轮 gate；A2 工作台全交互（筛选 /
  搜索 / 详情 provenance / 确认已核验 / URL 保持）；B r1 FAIL（可解释阻止
  项 / academicScore=66 实际值 / 9 规则 / Overview 卡 / 时间线入口）；C r2
  PASS 轮次切换（同轮 review 一起切）；D 真实矛盾证据 → gate FAIL → 深链
  证据页需注意筛选；E semanticMode=off 空态不出现假 0/0 或误 FAIL；F
  Light/Dark × 1440/1100 无横向溢出截图留档。全套 7/7（scripted 栈离线化
  后 13s）。既有套件复验：hitl 7/7、smoke 7/7（默认栈）、workflow 4+1skip
  （无模型栈）+ 模型门控 E 真实链路通过、visual 10/10（含新
  project-evidence 路由，5 视口 × 2 主题）。
- **视觉 QA**：6 张 m46 截图（Light/Dark × 证据页 / 门禁 FAIL / 门禁 PASS）
  模型走查两轮——克制红色（仅徽标 + 阻止项描边 + 单条未通过 pill）、PASS
  不满屏绿、深色主题真实生效；Pass 1 发现「查看门禁详情」竖排（grid 列约
  束）与阈值行对比度不足，修复后复验通过。
- **真实数据只读 smoke**：默认栈全部真实项目（6 个，均为 quick-review
  类型）× 新端点全部 200——如实空态（无 evidence.jsonl / gate 产物，不虚
  构）；当前无 idea/improvement 类型真实项目，带产物路径由 e2e + 单测覆盖。

**M4.5 — HITL UI（✅ 完成，2026-09-09）**：把 Backend 既有的
`awaiting_input` / resume / cancel 产品化到前端——用户能看懂「为什么停住」，
并可 继续 / 调整 / 修改 / 取消，Workflow 正确恢复。**Backend 引擎零改动**
（审计确认 awaiting 已随 checkpoint 持久化、resume 有并发与状态防护、
SSE 事件与 replay 齐备）；本轮新增的是前端决策面板与 scripted E2E 栈。

- **HITL 决策面板 `HitlPanel`**（统一 shell + 按 `awaiting.stageId` 差异化
  payload renderer，不做每 Stage 一套）：prompt（为什么暂停）+ 业务上下文
  （可行性结论等级徽章 / 理由 / 缺口 / 实验 / 建议；大纲标题 + 摘要 + 章节
  列表；改进计划条目 + 优先级；修订耗尽的 Gate 结论 + 审稿规模）+ 动作
  **严格按 `awaiting.options` 渲染**（未提供的动作不出现，杜绝「前端四个
  按钮、后端 400」）。
- **真实 decision 契约**（前端 `HitlDecisionInput` 类型化 union，与
  backend definitions.ts 一致）：`approve`（继续）/ `adjust`（仅可行性节点：
  targetProfile / targetVenue ≥一项，评估建议来自 payload）/ `revise`
  （仅大纲 / 改进计划节点：非空 feedback，本地校验前置拦截空提交）/
  `accept_draft` + `revise_more`（仅修订耗尽节点）/ `cancel`（走 decision
  通道留档 `inputs`，行内确认，终态来自 Backend）。表单空值禁用提交 +
  文案提示；pending 期间全部动作禁用（防双击重复 resume）。
- **过期请求与错误 UX**：resume 409（WORKFLOW_INVALID_STATE，含并发重复 /
  已在其它页面 resume）→ 展示 Backend 中文 message + 折叠 detail，并失效
  run 列表取权威状态——待办已处理则面板自然消失，页面不卡死。
- **恢复语义**：待办数据全部来自 `GET /api/runs`（checkpoint 持久化），
  **浏览器刷新与 Backend 重启均可恢复 awaiting**（e2e 覆盖刷新；真实模型
  smoke 覆盖重启）；SSE `workflow.awaiting_input` / `workflow.resumed`
  驱动面板出现 / 消失，无需手动刷新。
- **联动**：概览「当前任务」卡 awaiting 时显示等待确认 + 「前往处理」主
  按钮；侧栏「下一步」首项「有 1 个任务等待确认」；Review 页对其它工作流
  的 awaiting 显示提醒 + 跳转（决策统一在工作流页）；Timeline awaiting
  一等化（M4.4 已有，填充等待点 + 状态文字）。
- **测试**：Backend 507（新增并发 double-resume：慢速 onInput 下两个
  resume 恰好一个成功一个 409、workflow.resumed 事件唯一、单 awaiting
  invariant）+ Frontend 124（新增 HitlPanel 10：payload 渲染 / options
  严格渲染 / approve / adjust / revise 校验与 payload 裁剪 / cancel 走
  decision 通道 / 409 stale 处理 / 重新挂载恢复）全部 PASS。
- **E2E（`e2e/hitl.spec.ts`，7 例）**：新增 `PAPERTEAM_TEST_RUNTIME=scripted`
  测试栈（`src/runtime/scriptedRuntime.ts`：编排器 / checkpoint / SSE / HTTP /
  React 全真实，仅模型输出为确定性脚本；testStack.ts 改为复用同一实现，
  单一事实源）——A approve→自动恢复 B revise→重规划 C 刷新恢复 D cancel
  E 他端 resume 后旧页面让位 F/G Light+Dark 视觉 + 1100px 无横向溢出。
  无模型栈全套 e2e 同步复验无回归（21 passed / 8 skipped）。
- **真实 smoke**：真实 zai-coding-cn/glm-5.3 idea_to_paper → 真实推进至
  `hitl.feasibility_confirm`（awaiting payload 携带真实可行性结论）→
  **Backend 重启后 GET run 仍 awaiting** → resume approve → outline.plan
  真实重规划 → cancel 终态；inputs / events 留档验证。
- **视觉**：5 张截图（可行性 Light/Dark、大纲 + revise 表单 Light、大纲
  Dark、取消确认 Dark）人工 review——与现有 Panel / Chip / Note / Btn 语言
  一致，warning 强调（非 danger），无临时后台感。

**M4.7 已完成（见顶部章节）；M4.8 见顶部章节；M4 已 COMPLETE。**

---

**Citation Semantic Verification Correctness Hardening（✅ 2026-09-09）**：

**Citation Semantic Verification Correctness Hardening（✅ 2026-09-09）**：
语义核验粒度从「sentence × every reference」升级为「**atomic claim ×
citation group**」，修正系统性 false positive，并用真实 Attention Is All
You Need PDF（arXiv 1706.03762）完整 E2E 验证。

- **根因**：旧 `buildClaimRecords` 把 callout 句子整句绑到组内每篇文献
  （`[35, 2, 5]` 展开成 3 条记录，每篇被要求单独支撑整个复合句）——组内
  分工被错判成「单篇不支持」（真实复现：[2] Bahdanau 被判 UNSUPPORTED，
  理由是「未提及 RNN/LSTM/GRU 被确立为 SOTA」）；且 callout 展开后丢失
  组归属（rawText 不保留）。
- **新算法（v4 → v5）**：句子 → 原子论断（`claimDecomposition.ts`：结构化模型
  批量拆解，批 8 句 / 上限 24 调用 / 版本化缓存；简单句与无证据句零拆解
  调用；任何失败退确定性兜底=整句单论断）→ 论断绑定邻近引用组（按标记
  位置；v5 收紧：预告性/组织性表述——「下文将描述 X」——markers 留空，
  不继承句内引用组；model 计划严格绑定，fallback 计划保持全组兜底）→
  (原子论断 × 引用组) 一条记录（`referenceIds`
  全组成员共同承担；anchor=首成员兼容旧展示；`groupRawText` 保留
  `[35, 2, 5]` 原文）→ 组证据合并 judge（每成员 abstract/repo 描述，
  上限 6 篇）。
- **verdict 收紧**：UNSUPPORTED 仅当证据与论断主题相关且足够具体（未提及/
  笼统/无法判断 => INSUFFICIENT_EVIDENCE）；CONTRADICTED 必须带逐字来自
  证据的反向 keyQuote（引不出 => 确定性降级 INSUFFICIENT_EVIDENCE +
  reasonCode UNQUOTED_CONTRADICTION）；PARTIALLY_SUPPORTED 不因组内单篇
  只承担部分责任而触发；**INSUFFICIENT_EVIDENCE = 无法自动判断 ≠ 论文
  问题**：severity 由 minor → **info**（不构成任何级别 Finding），UI 标签
  「无法自动判断」中性色 + 帮助文案，导出标题/未解决列表改为「不代表引用
  存在问题」口径；contradiction_only judge 三值
  （CONTRADICTED / NO_CONTRADICTION_DETECTED / INSUFFICIENT_EVIDENCE）。
- **组员分层**：真实性未确立（NOT_FOUND/PROVIDER_ERROR/AMBIGUOUS）或无摘要
  的组员不参与证据（记 `excludedReferenceIds`，Layer 1 单独报问题）；全员
  不可判 → SKIPPED；组内可判成员全无摘要 → 确定性短路（零模型调用）。
- **缓存失效**：`SEMANTIC_VERIFICATION_VERSION` 3 → 5 进指纹 + 记录新增
  `semanticVersion` 字段；`listClaimRecords` 只返回当前版本记录（旧版本
  记录保留在磁盘、不删除用户数据，但不再读出）；提取层 v3（callout
  rawText）与拆解层 v2 各自独立指纹。
- **真实 E2E**：arXiv 官方 PDF（D:\Tmp\attention-is-all-you-need.pdf，15 页，
  sha256 bdfaa68d…df697，不入库）；真实产品链路（import-pdf API →
  existing_paper_review 工作流 citationSemanticMode=full）+ 真实模型
  zai-coding-cn/glm-5.3 + 真实 Crossref/OpenAlex/S2/arXiv 检索；Introduction
  的 RNN/LSTM/GRU/MT 复合句拆出原子论断、`[35,2,5]` 组级共同核验——
  修复前 [2] 单篇 UNSUPPORTED 的 false positive 消除（详见本轮报告）。
- **测试**：backend 503（新增 claimDecomposition 11 例 + 语义核验 v4 重写
  11 例：复合句分组 / 组共同支撑 / 组员不完整不自动 UNSUPPORTED /
  metadata-only / 证据不足不进 Finding / 逐字引文矛盾 / 无证据零模型调用 /
  拆解兜底与缓存 / contradiction 三值）+ frontend 112 全部 PASS；无任何
  特定论文特判（grep 审计）。

---

**M4.4 — Workflow Live View + SSE + Cancel + Progress（✅ 完成，2026-09-09）**：
把 Backend 既有 Workflow / Domain Event SSE / 取消 / 进度能力正式产品化到前端。

- **Workflow Live View（项目工作区「工作流」标签）**：当前任务卡（类型 / 状态 /
  开始时间 + 客户端 timer 已运行时长 / 阶段进度）+ **Stage Timeline**
  （completed / running / awaiting / failed / cancelled / pending 六态；每行带
  状态文字不只靠颜色；条件 stage 标「按需」；stage → 中文标签与三种 kind 的
  顺序模板集中在 `status.ts`，与 backend definitions.ts 对齐）+ 最近运行历史
  （可点击切换查看）。runId / 时间戳 / 每阶段尝试与耗时 / 并发画像收进折叠
  「详细信息」。
- **分章节 Review 进度**：`17 / 33` 确定性计数 + 细进度条（completed/total，
  非虚假百分比）+ `运行中 N / 等待 M / 已重试 R / 失败 F`（backend
  `stage.progress` 载荷新增 `started` / `retried`；active = started -
  completed - failed，queued = total - started）。`maxObservedConcurrency`
  只在详细信息（Performance Details）展示。
- **SSE 数据层 `useWorkflowEvents`**：页面级订阅（存在活跃 run 时建立），
  先订阅后 replay、seq 去重（重连 replay 不重复应用）、`stage.*` 事件直接
  增量更新 TanStack Query 缓存（run 列表），`awaiting_input` / 终态走
  invalidate 取权威状态（review 类 run 终态连带失效报告 / 引用 / 项目缓存）；
  终态关闭连接；活跃时 3s 轮询保留为 SSE 故障兜底。耗时用客户端 timer 基于
  server 时间戳，不轮询后端。
- **取消**：`取消任务`（btn-danger 描边样式）→ 行内确认（文案如实：
  已完成阶段与结果保留、未开始不执行、进行中调用被中断）→ pending 禁用
  → settle 窗口显示「正在取消…」→ 终态「已取消」。**Backend 两处最小修复**：
  ① `cancel()` 对已 cancelled 的 run 幂等返回（completed/failed 仍 409）；
  ② `verifyMetadata` 接受 AbortSignal 逐条循环检查中止（此前引用真实性核验
  全程不响应取消，e2e 实测取消要等整轮网络扫描 ~90s+）。AgentRun 级取消
  （queued 停止派发 + active abort）经审计确认 Review 并发版本已解决（既有
  专项测试），无需改动。
- **awaiting_input / failed / completed**：等待确认块（prompt + options +
  「交互处理将在下一阶段提供」的如实说明 + 真实可用的取消入口，不做假
  approve 按钮）；失败块（稳定中文文案 + 失败阶段 + 重试建议 + 折叠技术
  detail）；完成块（总耗时 / 阶段数 / 已审阅 N/M 节 + 查看 Review / 查看引用
  核验 / 导出报告真实入口）。
- **联动**：概览新增「当前任务」摘要卡（状态 + 阶段 + 进度 + 查看工作流）；
  Review 页运行中显示阶段清单 + 「工作流」入口；Review 完成后报告缓存经
  SSE 终态失效自动刷新；右侧栏「查看任务进度」指向工作流。
- **验证**：Backend 486（新增 SSE 重连 replay 去重 ×2 + cancel 幂等 +
  verifyMetadata 取消 + progress 载荷断言）+ Frontend 112（新增
  workflowEvents 7 + WorkflowPanel 7）全部 PASS；Playwright 新增
  `workflow.spec.ts`（无模型栈：时间线 SSE 推进 / 取消 / reload 恢复 / 失败态
  / 联动入口；模型门控：小论文完整链路 → completed → 报告就绪，单节短调用量级）
  + visual.spec 增 `project-workflow` 路由（浅/深 × 5 视口）；真实 GLM 小论文
  smoke（1 页 / 1 节 / 3 引用，58s 完成）验证真实 SSE → 前端实时更新 → 报告。
  浏览器视觉 review：浅/深 × 1366/1440/1920/1100w 运行中 / 终态 / 详情截图
  检查，修复亚秒耗时「00:00」噪音。

**下一阶段：M4.5 HITL UI**（awaiting_input 的 approve / adjust / revise 交互；
backend resume API 与事件载荷已就绪，前端结构已预留等待确认块）。

---

**引用语义核验可配置（CitationSemanticMode，2026-09-09 完成）**：引用两层
核验明确分层——Layer 1 真实性 / metadata 核验**始终执行**；Layer 2
Claim-Citation 语义核验改为 Review Run 配置（`off` / `contradiction_only` /
`full`），**新 Review 缺省 `off`**（`citation.claims` stage 真实跳过、语义
模型调用 0；旧持久化 run 无字段按 `full` 解释）。模式随 run `request`
持久化并写入每轮聚合报告，off 轮不携带语义统计（历史轮记录按 run 隔离，
不污染本轮报告 / Markdown 导出）；Quality Gate 语义类规则仅在 mode ≠ off
时参与（contradiction_only 下只有明确矛盾参与判定）。`contradiction_only`
为保守中间档：judge 只回答 `CONTRADICTED / NO_CONTRADICTION_DETECTED`，
无证据 → `SKIPPED`（不产生 INSUFFICIENT_EVIDENCE 噪音），模式进入 claim
指纹（与 full 记录不互相沿用）。前端在「开始 Review」与导入页的高级选项
提供配置（默认关闭，含帮助文案），off 轮报告显示克制的「引用语义核验
未开启」+ 低权重「进行语义核验」入口（跳转引用核验面板手动补跑）。
性能语义如实记录：关闭语义核验只省 ~3.1% 冷启动耗时（6 次 judge），
最大瓶颈仍是 review.sections（见 REVIEW_PERFORMANCE_PROFILE.md）。
测试：backend 482（新增 citationSemanticMode 全链路 9 例 + Gate 3 例 +
导出 3 例 + 服务级 contradiction 路径）+ frontend 98（ReviewPanel 模式
UI 5 例、导入高级选项 1 例）全部 PASS；真实论文 PDF（26 页 / 25 引用）
Fake-Runtime smoke 验证 off 轮语义模型调用 = 0。

**Project Hardening & Real Paper E2E 完成（2026-09-07）：M4.3 全部子里程碑含 M4.3.8 真实用户论文 E2E 收口，产品进入可用状态；下一步 M4/M5 规划另行决定。** 此前基线——M4.3 Foundation Complete（M4.3.0 Review Domain Model → M4.3.7 Minimal UI）。 Final PDF 正式成为 Existing
Paper 的 Review 输入：PDF → pymupdf 确定性解析 → pages/sections/chunks（页
provenance）→ PaperMap + 受控 section review context（其他章节全文绝不进
入当前章节的审稿上下文）；引用完整性两层核验（文献真实性=外部学术库确
定性核验，NOT_FOUND≠捏造；(claim,citation) 单记录语义核验，模型禁止凭记
忆判定、judge 引文必须逐字来自检索证据）；Skill Registry 落地（两项审计
过的 MIT Academic Skill，pin revision + LICENSE + PROVENANCE，按角色注入
Pi 会话，progressive disclosure 保持）。M4.0-M4.2 的 React Workbench 基线
保持。React 19 +
TypeScript + Vite + React Router 7 + TanStack Query 5 + Zustand 5（npm，
frontend/ 独立包）；`npm run dev` 一键双进程（Backend :3000 + Vite :5173，
`/api`、`/health` 经 Vite proxy 同源转发，任一退出联动全退）。前端只消费
[API_CONTRACT.md](API_CONTRACT.md) 冻结的 DTO，不依赖 Backend 内部对象；
Runtime Status 完全适配 Pi schema。Project
List / Create Project（双模式）/ Project Workspace 基础壳就绪。
**M4.2.5 Live Model Integration Gate ✅（2026-09-05）：真实 Provider
`zai-coding-cn/glm-5.3` 经运行中 Backend 全链路验证（单 Agent smoke /
live SSE / Workflow 至首个 HITL / 真实 cancel），L3 Live Provider E2E
verified（见下）。当时的下一阶段「Workflow Live View + SSE + Cancel」
已于 M4.4（2026-09-09）完成。**

**Review 并发优化完成（2026-09-08）**：分章节 Review 有界并发落地
（`SectionReviewScheduler` + `PAPERTEAM_REVIEW_CONCURRENCY`，默认 3；真实
benchmark：review.sections 2.81×、run 总时长 2.61×，详见
`docs/REVIEW_PERFORMANCE_PROFILE.md` 与「历史」）。**2026-09-08 文档轮**：
确立下一阶段核心架构方向——Iterative Writer–Reviewer Outer Review Loop
（[D-0026](DECISIONS.md)，见下节规划）。

## M4.9 Iterative Review Loop / Review Quality Optimization（✅ 已由 M4.7 实现，本节保留为当时的规划记录）

> **2026-09-10 注**：本节 2026-09-08 冻结的规划（score-driven loop / scorecard
> 一等化 / revision-plan-driven Writer / 强制复审 / 收敛终止 / 并发增强 /
> iteration history）已由 **M4.7 全部实现**（D-0026；见顶部 M4.7 章节），
> 下列「PLANNED」标注为历史记录。

> 2026-09-08 文档轮确立（DECISIONS D-0026、PRD §9.5、ARCHITECTURE §13）。
> **本节为规划，尚未实现**；里程碑编号在既有 M4.4-M4.8 前端页面预留号
> （见 ARCHITECTURE §8.3）之后顺延取 M4.9，实际优先级与执行顺序由后续
> M4/M5 规划决定，不因编号隐含排序。

已具备的基线（CURRENT，非本里程碑交付）：

- **M3.2 bounded revision loop（baseline）**：Review（fact / academic /
  style 三路并行，独立 contextScope 会话）→ 确定性聚合（ReviewSummary 按
  round 落盘）→ Quality Gate（9 条基础规则 + Citation Integrity 硬规则，
  全部确定性判定）→ Writer 逐节修订（修订指令在执行期从最新审稿汇总 + 引用报告确定性
  派生；不允许新造文献）→ 回到引用核验 / 三路审稿 / Gate → 自动修订 ≤2 轮
  + HITL revise_more ≤3 → 超限 HITL（accept_draft / revise_more / cancel）。
  评分只是 Gate 的两条规则——blocking issue、unsupported critical claim、
  捏造 / not_found 引用等硬规则不因总分高而豁免。
- **Review 有界并发（2026-09-08 完成）**：分章节 Review 经
  `SectionReviewScheduler` + `mapWithConcurrency` 有界并发
  （`PAPERTEAM_REVIEW_CONCURRENCY` 默认 3、范围 1-8；固定 runner 池——
  任务开始受 limit 约束，backpressure 语义而非无界 Promise.all；每节独立
  contextScope / Pi session；单节失败隔离（failedSections 继续）；节内
  退避重试；取消停止派发并中断在途模型调用；结果按论文顺序确定性重排；
  每节完成即写 per-section journal 供 stage 重试 / 崩溃恢复）；PaperMap
  章节摘要同为有界并发（`PAPERTEAM_SUMMARY_CONCURRENCY`）。三路
  manuscript review 为 3 个固定 lens 并行（天然有界）。真实 benchmark
  （C=3，全量 33 节）：review.sections 2763.8s → 985.3s（2.81×）、run
  总时长 3217.5s → 1234.6s（2.61×），0 失败 / 0 重试 / 0 次 429。
- **按轮产物**：`reviews/review-r{n}-{mode}.json`、`review-summary-r{n}.json`、
  `quality-gate-r{n}.json`、`existing-review-r{n}.json`（round 从 1 递增）。

规划内容（PLANNED，均未实现）：

- **score-driven Writer ↔ Reviewer loop**：review 轮次从「修订的附带步骤」
  升级为驱动循环的一等输入——每轮 scorecard 既决定下一轮 Revision Plan，
  也参与终止判定
- **structured review scorecard 一等化**：跨轮维度变化对比（哪些问题被
  修复 / 仍存在 / 新增、哪些维度提高 / 退化）；score 保持为信号，
  Quality Gate 仍是最终确定性权威
- **revision-plan-driven Writer**：Revision Plan 固化为一等落盘 artifact /
  task contract（与该轮 scorecard、gate 结果关联；当前为执行期派生指令）；
  **不新增 RevisionPlanner Agent**
- **re-review 强制**：修订后的版本必须重新 Review，不自评通过
- **convergence / regression / max iteration 停止条件**：新增 CONVERGED
  （连续轮改善低于阈值 → Human Checkpoint）与 REGRESSION（重要维度明显
  退化 → 停止盲目修改并保留 / 恢复较优版本）终止态，阈值 configurable；
  PASS / MAX_ITERATIONS 已在 baseline 实现
- **review parallelism & backpressure 增强**：provider / model capacity
  感知的动态并发上限、跨 stage 统一 backpressure、partial progress 产品化
  呈现
- **iteration history / observability**：每轮 revision / review / scorecard /
  findings / revision plan / gate 结果 / workflow iteration / agent 执行
  trace 的关联与查询；前端迭代历史 UI（Round N 分数走势、问题演化、
  REGRESSION 时恢复较优版本）

## M4.3 — PDF Review + Citation Integrity + Skill Registry（✅ Foundation Complete，2026-09-06）

> M4.3.8（真实用户论文全文 Review E2E）不在本轮；本轮以真实公开论文
> （arXiv 1706.03762）完成集成 smoke。

| 子里程碑 | 状态 | 说明 |
|---|---|---|
| M4.3.0 Domain Model | ✅ | `paper/types.ts`（PaperDocument/Page/Section/Chunk/PaperMap + 防御性读取守卫）、`citation/integrity.ts`（ReferenceEntry / CitationCallout / CanonicalPaperRecord / CitationVerificationRecord / **ClaimCitationRecord**（(claim,citation) 单记录，借鉴 RefWarden）+ `deriveClaimSeverity` 确定性派生）、`review/finding.ts`（ReviewFinding，provenance 强制）、`skills/types.ts`（SkillMetadata + frontmatter 解析）。全部 JSON 可序列化，无 Pi 类型泄漏 |
| M4.3.1 PDF Ingestion | ✅ | `backend/tools/parse_paper_pdf.py`（pymupdf 1.28.2 子进程，UTF-8 stdout JSON、无 shell）+ `PdfParser` seam + 确定性 section/chunk 组装（TOC > 标题正则 > 整档；References 章节标题+[n] 双确认补齐）+ `PaperStore`（paper/source + parsed/{document.json,pages/,sections.json,chunks.jsonl} + stages.json）+ 上传校验（%PDF- 头 / 50MB / basename 归一化 / sha256 幂等替换）。真实 PDF：15 页 / 23 sections / 27 chunks / quality=good；重启后全新实例可重建 |
| M4.3.2 Long-document Context | ✅ | `PaperMapService`（骨架确定性 + 单 section 摘要一次调用、指纹缓存、失败容忍）+ `ReviewContextBuilder`（论文概览 + 全文导航摘要 + 仅当前章节 chunks + 可选引用注入；分项 budget）。**隔离证明**：Method 上下文不含其他章节全文；**会话无关证明**：Runtime Session 全弃后从磁盘确定性重建 |
| M4.3.3 Citation Extraction | ✅ | `ReferenceExtractor`（numeric [n] 条目 + 跨行合并 + 章节边界正文剥离；title/authors/year/venue/doi/arXiv best-effort；Unicode 安全）+ callout（[1]/[2,3]/[4-7] 展开为逐条 relation；范围内空缺=unresolved、超范围=invalid，不猜；author-year best-effort）；真实 PDF 40 条 references / 51 callouts / 关联可追踪 |
| M4.3.4 Metadata Verification | ✅ | `ScholarlyResolver`（crossref/openalex/semantic-scholar/arxiv 轻量 connector；标题+作者重合+年份±1 门控；重复收录合并；DOI 精确优先；重试×1 + LRU 查询缓存 + 礼貌间隔 + telemetry）。**失败语义**：网络/5xx/超时=error→UNRESOLVED（绝不 NOT_FOUND）；≥2 权威 not_found=NOT_FOUND；≥3 全一致零 error 才 probable fabrication。逐条文件持久化 + 指纹跳过。live：真实论文 VERIFIED / 虚构文献 not_found / S2 429 优雅降级 |
| M4.3.5 Semantic Verification | ✅ | judge 链路 atomic claim × citation group（v4，2026-09-09）：句子→原子论断拆解（模型批量+确定性兜底+版本化缓存）→ 论断绑定邻近引用组 → 组证据合并→LLM→verdict；组内文献共同支撑（不再 sentence×每篇 笛卡尔积）；真实性未确立组员排除（Layer 1 单独报）；无摘要→INSUFFICIENT_EVIDENCE 确定性短路（零模型调用，含拆解层）；**judge 伪造引文剥离**（keyQuote 必须逐字来自证据；CONTRADICTED 引不出逐字引文→降级 INSUFFICIENT）；UNSUPPORTED 需证据相关且具体；INSUFFICIENT=无法判断≠论文问题（info 不进 Finding）；severity 确定性派生；Citation Integrity 4 硬规则并入 QualityGate（INSUFFICIENT_EVIDENCE 不阻断只标人工复核）；citation 角色（scope citation/*）；模型调用/拆解/上下文规模 telemetry；记录带 semanticVersion（旧版本=过期缓存不读出） |
| M4.3.6 Skill Registry | ✅ | `SkillRegistry`（仓库内审计 seed → `<runtimeRoot>/skills/installed`，contentHash 幂等、变化标 stale；LICENSE/PROVENANCE 随附）；seeds：**verify-citations**（Agents4Academia-AI/citation_verification, MIT, pin `ae85ae3` 原件 verbatim）+ **paper-search**（openags/paper-search-mcp, MIT, pin `234678a`，PaperTeam 兼容 wrapper + UPSTREAM_SKILL.md 原件保留）；绑定 researcher→paper-search、citation→双、reviewer→verify-citations、writer→无；Pi 注入 `DefaultResourceLoader({noSkills, additionalSkillPaths})`（用户 ~/.pi 不受影响）；`search_papers`/`lookup_paper` 受控工具（共享 resolver 缓存）；中文简介一次生成持久化（模型未配置→summary_pending 不失败） |
| M4.3.7 Minimal UI | ✅ | ProjectPage 新增 PDF / Structure 与 Citations 标签（上传/解析状态/sections 表；两层核验摘要 chips + 逐条 status/canonical/疑似捏造告警 + 分步操作）；全局 Skills 页（中文简介为主、原始描述折叠、来源@revision/license/绑定，**无未实现的 Install/Uninstall 按钮**）；全部 server state 走 TanStack Query |
| M4.3.7.5 Model Settings UI | ✅ | `Settings → Model`（/settings/model）：前端配置模型与 API Key，无需手工环境变量。后端 `ModelSettingsService` + `/api/settings/model` 路由组（GET 状态/PUT 保存/DELETE key/GET options/POST test）；存储完全复用 Pi 官方能力——偏好 `<runtimeRoot>/settings/model.json`（原子写，非敏感），Key 经 `ModelRuntime.login/logout` 落 `agentDir/auth.json`（不自建第二套 credential，无 deep import）；优先级 env（PAPERTEAM_PI_*）> stored，env 覆盖时 UI 明示且 savedModel 如实展示；`reconfigure()` 只影响新 Agent Run（在途 run>0 → 409 MODEL_CONFIG_BUSY，前置检查先于落盘）；Test Connection 走 `completeSimple` 最小真实调用（可携带未保存 Key 覆盖式注入，失败六分类+脱敏）；**Key 只进不出**：任何 GET 无 key 字段、日志零请求体、sentinel 回归测试覆盖；重启持久化（启动装配 resolveStartupModelSpec：env 缺省时 stored 自动生效，smoke 实证） |
| Visual Redesign + UX/中文一致性 Polish | ✅ | Design Tokens + 深墨侧栏/纸白内容 + 统一状态注册表（2026-09-06）；UX Polish：全站中文优先（导航/表单/状态/错误码集中映射 `formatApiError`）、模型设置改**模型搜索选择器**（筛选/键盘/截断渲染，displayName 主视觉 + modelId 次要）、**modelId 含斜杠 bug 修复**（`parseModelSpec` 接受 openrouter `anthropic/claude-sonnet-4` 形态，DTO 显式 provider+modelId，前端不再 split 猜测，前后端回归测试）、Tab 状态进 URL（?tab=，无效回退概览）、未开放模块退出一级导航、Existing Paper 创建后直达 PDF 上传、侧栏保持完整宽度（修复窄窗口导航空白）、Design Token 收口（页面级 hex 全部入 token） |
| M4.3.8 用户论文 E2E | ✅ 2026-09-07 | 用户真实论文（26 页中文，36 节 / 25 条参考文献）从产品入口导入 → 快速 Review 全链路完成，见「Project Hardening & Real Paper E2E」节 |

外部选型结论：**pymupdf adopt**（本机已有 1.28.2；pymupdf4llm 评估后不作为核心依赖——markdown re-flow 破坏 chunk↔原文对应）；**GROBID defer**（callout↔reference 关联有价值但 Java21/Docker 部署超出本轮，`ScholarlyStructureParser` seam 未建、待 M4.3.8/M5 评估）；**RefWarden adopt+借鉴**（(claim,citation) 模型/never-from-memory/确定性 severity）；**paper-search 借鉴 provider 设计 + wrapper 收录**（不自建多平台搜索框架、不引入其 Python MCP server）。

## M4.0-M4.2 — React Web Workbench（✅ 完成，2026-09-04）

| 项 | 状态 | 说明 |
|---|---|---|
| M4.0 API Contract | ✅ 完成 | 新增 `docs/API_CONTRACT.md`（端点清单 / DTO / SSE 载荷 / 变更纪律）；审计确认 Backend 已有全部 Project/Workflow/Run/SSE/Evidence/Review/Import 端点，唯一缺口 `GET /api/projects` 已补（`ProjectStore.listMetadata()`，updatedAt 降序，损坏 project.json 跳过）；DTO 边界：Pi AgentSession / Pi event / AgentRunHandle / WorkflowState 全量不进前端 |
| M4.1 Frontend Skeleton | ✅ 完成 | `frontend/` 独立 npm 包：React 19.2 / TS 5.9（strict）/ Vite 7 / react-router-dom 7.18 / @tanstack/react-query 5.102 / zustand 5.0；目录 `api/ components/ pages/ router/ stores/ hooks/ types/ constants/ utils/ styles/`；统一 API Client（ApiError：status/code/NETWORK_ERROR 收敛，404 判定）；Server State 全走 TanStack Query（retry 仅 5xx/网络错误），UI State 走 Zustand（唯一状态：模型未配置横幅 dismiss）；路由 `/`→redirect、`/projects`、`/projects/new`、`/projects/:projectId`、`*`→404；顶栏 RuntimeStatusChip（30s 轮询，Pi schema）+ 模型未配置横幅 |
| M4.2 Project Workbench | ✅ 完成 | ProjectsPage（列表/空态/错误重试/真实字段卡片）；NewProjectPage（Idea-to-Paper 全字段表单 + 双模式选择；校验镜像 Backend 长度上限；Existing-Paper 显示「导入 API 已开放、上传 UI 后续提供」如实提示）；ProjectPage（研究定位真实字段 + WorkflowRun 记录表 + Workflow/Evidence/Review/Artifacts 导航入口标注 M4.3-M4.7，无 mock 数据）；loading/empty/error/not found/form validation/retry/响应式齐备 |
| Dev 双进程 | ✅ 完成 | `scripts/dev.mjs`：backend 依赖/构建检查 + frontend 依赖检查 → 同时 spawn `backend/dist/index.js`（[backend] 前缀）与 Vite（[vite] 前缀）；任一子进程退出 → taskkill 进程树联动退出；Windows 实测 vite 被杀 → backend 联动 → 3000/5173 全释放；根脚本 `build/typecheck/test` 覆盖前后端 |
| 测试 | ✅ 通过 | Backend 234/234（新增 4：GET /api/projects ×3 + listMetadata 排序）；Frontend 24/24（apiClient 6 / projectsApi 4 / ProjectsPage 5 / NewProjectPage 4 / routing 5；Vitest 3 + RTL，`globals: false` 下显式 cleanup）；前端 `tsc --noEmit` 与 production build 通过 |

## M4.2.5 — Live Model Integration Gate（✅ PASS，2026-09-05）

验证型里程碑（无代码改动）。真实 Provider `zai-coding-cn/glm-5.3`（Pi 0.84.4 in-process，`model.phase=configured`）经**运行中 Backend 的公开 HTTP API** 完成 L3 全链路验证。四项验证：

| 项 | 结果 | 说明 |
|---|---|---|
| 单 Agent live smoke | ✅ | `POST /api/projects/:id/generate`（Writer 真实 GLM 调用 10.3s，`manuscript/main.tex` 落盘 1657 字符，内容切题非模板；LaTeX 编译因本机无 TeX 工具 graceful 降级） |
| live 事件流 | ✅ | SSE `GET /api/runs/:runId/events`：replay 边界清晰（`: replay 完成` 注释），此后 4 条 **LIVE** 域事件按 seq 递增实时到达（research.idea 完成 +248s、feasibility 完成 +348s、awaiting_input +348s），stageId 归属正确 |
| Workflow E2E 至首个 HITL | ✅ | run `w-93366adfc650`（项目 `p-b76342cc5b69`）：research.idea（真实 GLM 248s，6 gaps / 21 bibliography / 12 evidence）→ research.feasibility（100s，level=LOW）→ `hitl.feasibility_confirm` **awaiting_input**；checkpoint/events.jsonl/stage 记录/research/feasibility 产物全落盘；activeRuns 归零、managedSessions=3 |
| 真实 cancel | ✅ | run `w-5386755ccb0c`（项目 `p-1131d9dd8cad`）：research.idea 真实生成中（activeRuns=1）POST cancel → 边界语义（在途 LLM 跑完提交结果，循环检查点终结）→ `workflow.cancelled`，终态 cancelled；同项目 run `w-43719502d7c0` 在**复用的同一 research 会话**上新 taskId 完成 research（58s）→ cancel 后会话可复用；全程 runtime healthy |

验证边界（如实记录）：AgentEvent 级（message_update 增量）事件与 AgentRuntime 级 mid-stream `session.abort()` 对真实 Provider 的直接观测，因凭据仅存在于运行中 Backend 进程（`PAPERTEAM_PI_API_KEY` → `setRuntimeApiKey` 仅内存，不落盘；子进程脚本 `modelStatus=not_configured`，符合设计）而无公开观测面——前者经 M3.8 L2（真实 SDK + fauxProvider 假流）覆盖同一映射代码，后者以 Workflow 边界 cancel + runAgent 幂等语义间接验证。凭据安全：Key 未落盘/未入日志/未入库（工作区产物 0 命中；`.env.example` 仅占位符）；Pi 全程 in-process（无 Gateway 进程、无 18789/18790 端口）；回归 build/typecheck/test 全绿（234+24）。测试项目保留：`p-b76342cc5b69`（M4.2.5 Live Model E2E，停于 HITL，可作 M4.3 实时 Workflow UI 演示）、`p-1131d9dd8cad`（M4.2.5 Live Cancel Test，cancelled ×2）。

## M3 — 两条一级业务工作流（✅ 完成）

M3 交付两条一级业务工作流（真实编排引擎 + 真实业务服务，测试中以脚本化 Agent Runtime 全链路验证）：

- **Idea-to-Paper**：调研 → 可行性评估（HITL approve/adjust）→ 大纲（HITL approve/revise）→ 分节写作 → 引用核验 → 三路审稿 → Quality Gate →（bounded 修订 ≤2 轮 + 超限 HITL）→ Build Gate → Final（双 Gate 通过）/ Draft。
- **Existing-LaTeX Improvement**：导入（防 Zip Slip）→ 结构解析 → Baseline Compile → 论文理解 → 引用审计 → 审稿 → 目标评估 → 改进计划（HITL）→ 逐节改造 →（共享审稿/修订/构建后段）。

## M3.8 — Pi Runtime Migration & Runtime Contract v2（✅ 完成，2026-09-04）

| 项 | 状态 | 说明 |
|---|---|---|
| Pi 成为唯一 Runtime | ✅ 完成 | 删除 `PAPERTEAM_AGENT_RUNTIME` selector 与 openclaw 装配分支；index.ts 直接构造 `PiRuntimeAdapter`；业务层仍只面向 `AgentRuntime` 契约（Pi SDK import 限制在 Runtime 层） |
| OpenClaw 基础设施移除 | ✅ 完成 | 删除 `OpenClawRuntimeAdapter`、`runtime/openclaw/gatewayClient`、`backend/src/dev/` 全目录（cli / gatewayHealth / openclawState / runtimeConfig / runtimePaths / supervisor）、Gateway health / handshake / RPC / token / port / runtime.json 全部逻辑；`npm ls openclaw`、`npm ls @openclaw/gateway-client`、`npm ls @openclaw/gateway-protocol` 根与 backend 均为空；用户磁盘上的旧 `~/.paperteam/runtime/openclaw/` state 无害忽略（不主动删除） |
| AgentRuntime Contract v2 | ✅ 完成 | `startAgent(input)` → `AgentRunHandle{taskId, sessionKey, events(), cancel(), result()}`：taskId 在执行开始时立即可得（排队不阻塞句柄返回）；`events()` replay+live、settle 后自然结束、多订阅独立、break 清理订阅；`cancel()` 幂等（queued 标记短路 / running 真实 abort）；`result()` Promise 缓存可重复 await；`close()` 收敛全部 active run 并 dispose 会话。`runAgent()` 保留为 start + await result 的 convenience（业务层 9 处调用点零改动）。v1 的 `cancelTask` / `streamEvents` / `sendMessage` 从契约移除（`getTask` 保留查询已完结任务） |
| 事件流正式接通 | ✅ 完成 | Pi `session.subscribe()` 事件映射为 PaperTeam `AgentEvent`（agent_start / message_start / message_update / message_end / tool_execution_start / update / end / agent_end / agent_settled / turn_start / turn_end）；原始 Pi 事件对象不透传业务层；L2 实证运行中消费（不等任务结束） |
| 取消正式接通 | ✅ 完成 | normal generation 取消（M3.7 实证保持）；**tool execution 取消（M3.8 新增实证）**：customTools 注入可控慢工具 → 执行中 cancel → SDK AbortSignal 真实传导 → 工具停止 → 任务 settle cancelled。工具中 abort 的 SDK 终态实测为 `stopReason="error" + "This operation was aborted"`（LLM 流中断才是 `"aborted"`），Adapter 以取消意图（cancelRequested）归因，不依赖 SDK 编码差异。cancel 已完成/已取消任务幂等 no-op；cancel 后同 session 可继续使用；compaction abort 仍为上游边界（auto-compaction 已禁用、manual compact 未使用） |
| dev 启动链简化 | ✅ 完成 | `npm run dev` → `scripts/dev.mjs`（Node 检查 → backend 依赖检查 → 构建）→ 直启 `backend/dist/index.js`（Pi SDK in-process）。不再安装 OpenClaw / 生成 Gateway state / 寻找端口 / spawn Gateway / 等待 health / 监督子进程 |
| RuntimeStatus 去 Gateway 化 | ✅ 完成 | `GET /api/runtime/status` 新形状：`runtime{provider, phase, version, detail, latencyMs}`（Pi 0.84.4）+ `model{phase, model?, providers, detail}` + `agents{roles}` + `sessions{activeRuns, managedSessions}`；gateway / gatewayRuntimeVersion / gatewayClientSdk / protocolVersion / not_applicable 占位全部删除。healthCheck 语义统一：Runtime 健康（SDK 可加载 / 未关闭 / 初始化正常）≠ 模型就绪（not_configured 单独报告） |
| Model / Auth 收口 | ✅ 完成 | `PAPERTEAM_PI_MODEL` / `PAPERTEAM_PI_API_KEY`（env override，不进日志）/ `agentDir`（默认 `<PAPERTEAM_RUNTIME_ROOT>/runtime/pi/agent`，与 `~/.pi` 隔离）/ `PAPERTEAM_PI_RUN_TIMEOUT_MS`；Key 不硬编码、不落日志；模型未配置 → 结构化失败 + `model.not_configured`；**M4.3.7.5 起前端 Settings UI 同级配置**（env > stored 优先级；Key 复用 Pi auth.json，见 M4.3.7.5 行） |
| 会话隔离回归 | ✅ 完成 | projectId × agentId × contextScope sessionKey 派生保持稳定（纯函数测试 + PiRuntimeAdapter L1 全链路测试）；同 logical session 复用、不同 project / 角色 / reviewer 三 scope 互不串、三路并发、取消一路不影响其它两路 |
| 测试迁移 | ✅ 完成 | 删除 OpenClaw 架构专属测试（OpenClawRuntimeAdapter / runAgent mock-Gateway 集成 / bootstrap / supervisor / versionPins / mockGateway fixture）；业务测试的 fake runtime 全部迁到 v2 接口；PiRuntimeAdapter 测试升级 v2（startAgent 句柄 / 运行中事件 / cancel 幂等 / 排队取消 / result 缓存 / close 收敛 / tool abort 专项） |
| 回归 | ✅ 通过 | `npm run build` / `npm run typecheck` / `npm test` **230/230**（OpenClaw 专属测试移除后总数下降，评价标准为覆盖真实架构）；M3 全量 Workflow 业务测试零回归 |

## M3.7 — Pi Runtime Feasibility & Adapter Spike（✅ 完成，2026-09-04）

Side-by-side 可行性验证：不改变默认 Runtime（当时为 openclaw），新增 Pi 候选实现并用真实代码 + 测试回答「PaperTeam 直接嵌入 Pi SDK 是否比经 OpenClaw Gateway 更合适」。

| 项 | 状态 | 说明 |
|---|---|---|
| PiRuntimeAdapter | ✅ 完成 | 官方 `createAgentSession()` in-process 嵌入（无子进程 / RPC / Gateway）；会话 = `SessionManager.inMemory(cwd)`（Runtime session 可丢弃，Workspace/checkpoint 是事实源）；sessionKey 派生与 OpenClaw 完全一致（`runtime/sessionKey.ts` 共享，GenerationService 显式透传兼容）；per-session 串行 + 跨 session 并发（创建 in-flight 去重）；timeout = 定时器 + `session.abort()`；auto-compaction 经 in-memory settings 关闭 |
| 角色 → Pi 配置映射 | ✅ 完成 | contextScope 前缀 → researcher/writer/reviewer/default：`systemPromptOverride` + 工具白名单（researcher/reviewer 只读，writer 可写文件，无人持有 shell）；systemPrompt 到达 LLM 上下文有 L2 测试实证 |
| 验证分层 | ✅ L1+L2 / **L3 verified（2026-09-05）** | L1 fake session 纯单元 + L2 真实 SDK + 官方 `fauxProvider` 假流：初始化 / 健康 / runAgent 成败 / timeout / 事件顺序与归属 / **abort（LLM 流中取消 → cancelled，会话可复用）** / session 复用 / project·contextScope 隔离 / **Reviewer 三路并发（独立会话、输出不串）** / close·dispose；L3 真实 provider LLM 于 M4.2.5 经运行中 Backend + `zai-coding-cn/glm-5.3` 验证（见 M4.2.5 节） |
| Windows 生命周期 | ✅ 实测 | pi 模式 Backend：零子进程、不占 Gateway 端口（18790）、kill 后无孤儿、端口释放；OpenClaw 基线 `npm run dev` 同日复验正常（Gateway 7.6s ready、health 200、优雅关闭） |
| 回归 | ✅ 通过 | `npm run build` / `npm run typecheck` / `npm test` 280/280（零回归）；顺带修复全量并发下偶发的 orchestrator cancel/awaiting_input 竞态（独立 commit） |
| 结论 | **MIGRATE TO PI（建议）** | P0 验证项全部通过；正式迁移由 **M3.8 执行完毕**（本表为历史记录） |

## M3.6 — Runtime Baseline Upgrade（✅ 完成，2026-09-04）

| 项 | 状态 | 说明 |
|---|---|---|
| OpenClaw 2026.8.2 → 2026.9.1 | ✅ 完成 | openclaw = `@openclaw/gateway-client` = `@openclaw/gateway-protocol` = **2026.9.1**（三处统一精确 pin，protocol v4 不变）；lockfile 更新；版本锚点测试防漂移。**（历史基线；M3.8 起 OpenClaw 不再参与运行，三处依赖已移除）** |
| SDK / Protocol 兼容性 | ✅ 无需适配 | 静态核对 + 编译 + 真机验证：`PROTOCOL_VERSION=4` 不变；RPC `agent`（两段式验收）/ `agent.wait` / `chat.history` 行为不变；未发现影响 PaperTeam 的 breaking change |
| Node Runtime 兼容 | ✅ 完成 | `scripts/dev.mjs` 改为复用根 package.json `engines.node` 作为唯一事实源（微型解析器，不新增依赖），Node 26+ 可用 |
| runtime.json 存量升级迁移 | ✅ 完成 | 旧 `openclawVersion` 自动迁移到当前 pin（端口 / token 保留）；单测 + 真机 E2E 双验证。**（M3.8 起 runtime.json 机制随 Bootstrap 移除；用户磁盘旧文件无害忽略）** |
| 回归 | ✅ 通过 | `npm test` 255 通过；真机 `npm run dev`：Gateway 约 6s 就绪、health 200、Backend 3000 监听、进程树唯一、优雅关闭级联无孤儿、端口全部释放 |

## M3.5 — Runtime Bootstrap / M3 Closure（✅ 完成）

| 项 | 状态 | 说明 |
|---|---|---|
| Runtime Bootstrap | ✅ 完成 | 仓库根 `npm run dev`：Node 版本检查 → 依赖自动安装 → 构建 → 准备独立 state → 启动 Gateway → 等 /health 就绪 → 启动 Backend → Ctrl+C 优雅关闭。**（M3.8 起该链路简化为直启 Backend，见 M3.8 表）** |
| 独立 OpenClaw state | ✅ 完成 | state 在用户级 `~/.paperteam/runtime/openclaw/`；路径解析硬校验与全局 `~/.openclaw` 不相等/不嵌套（D-0018） |
| Agent 映射（方案 A） | ✅ 完成 | Researcher/Writer/Reviewer/Citation 默认全部映射默认 agent `main`，会话隔离靠 contextScope（D-0016/D-0018）；映射在 config 层（env 可覆盖）。**（M3.8 起语义保留：会话标识默认 main，仅作 sessionKey 组成段）** |
| Runtime 诊断 | ✅ 完成 | `GET /api/runtime/status`（gateway/runtime/agents/model 分区）。**（M3.8 去 Gateway 化，形状见 M3.8 表）** |
| 优雅关闭 | ✅ 完成 | Ctrl+C：Backend 先停（编排器取消活跃 run、checkpoint 落盘、断开 SSE）→ Gateway 后停；Windows 真实控制台 Ctrl+C E2E 验证（无孤儿、端口释放） |
| 模型凭据边界 | ✅ 完成 | Bootstrap 不搬运/复用任何其他项目凭据；用户把 provider API Key 写入独立 state。**（M3.8 起：`PAPERTEAM_PI_API_KEY` / agentDir auth.json / 标准环境变量）** |

## M3.5 真实环境验证（本机 dev smoke + E2E）

以下为 2026-09-03 在全新机器（未装全局 OpenClaw、无 TeX、无模型凭据）上的真实运行结果（OpenClaw 基线，历史记录）：

1. **`npm run dev` 三次真实启动**：首次自动初始化 `~/.paperteam` state → Gateway 18790 健康（首次约 3s ready）→ Backend 3000 监听 → `GET /health` ok。
2. **`GET /api/runtime/status` 真实输出**：`gateway: healthy`、`runtime: model_not_configured`、四个角色映射 `main` 全部 `configured`、`model: not_configured`。
3. **真实 Idea-to-Paper E2E（无模型凭据路径）**：run 真实推进到 `research.idea` → 经真实 Gateway RPC 返回网关权威错误 → Stage transient 重试 2/2 → failed 终态（`AGENT_RUN_FAILED`）；SSE replay 正常。
4. **Ctrl+C E2E（Windows 真实控制台事件）**：Backend/Gateway/cli 依次优雅退出、端口全部释放、无残留进程。
5. **未真实验证的内容**（如实记录）：带真实模型凭据的完整 Idea-to-Paper 全链路；TeX 真实编译（本机无 pdflatex/xelatex/latexmk）；多模态 PDF 分析。

## M3.0 — Workflow Foundation（✅ 完成）

| 项 | 状态 | 说明 |
|---|---|---|
| WorkflowOrchestrator | ✅ 完成 | 确定性 TS 引擎（非 Agent）：stage 推进、retry（按失败分类）、timeout、checkpoint/resume、HITL、协作式取消（AbortSignal 传播）、DoD 硬校验、bounded loop（由 plan() 纯函数表达，可从 checkpoint 重放） |
| WorkflowRun 异步 API | ✅ 完成 | `POST /api/projects/:id/workflows` → 202 `{runId}`；`GET /api/runs/:runId`；`GET /api/runs?projectId=`；`POST /resume`、`POST /cancel`；同一项目存在进行中 run 时拒绝新建（409） |
| StageContract | ✅ 完成 | `StageSpec`：id / requiredInputs / producedOutputs / maxAttempts / timeoutMs / retryable 失败分类 / execute / verifyDod（DoD）。Agent 返回文本 ≠ 成功：产出必须通过 DoD |
| checkpoint 持久化 | ✅ 完成 | `projects/<id>/workflow/runs/<runId>/{checkpoint.json,events.jsonl,stages/}`；checkpoint 原子写（tmp → fsync → rename）；终态「先持久化、后提交内存」 |
| 进程重启恢复 | ✅ 完成 | `recoverInterruptedRuns()`：running/pending 从 checkpoint 重启（已成功 stage 不重复执行）；awaiting_input 保持等待可 resume；事件 seq 与磁盘日志对齐 |
| Domain Event | ✅ 完成 | events.jsonl（追加写、损坏行容忍）；`workflow.*`、`stage.*`、`quality_gate.*`、`build_gate.*`；不含 sessionKey/token/内部事件 |
| SSE | ✅ 完成 | `GET /api/runs/:runId/events`：先订阅后 replay（seq 去重）保证不重不漏；15s 心跳；断开只清理连接 |
| HITL awaiting_input | ✅ 完成 | 通用机制：进入待办 → resume 校验 decision → `onInput` 返回 `"cancel"` 可直接取消 run |
| contextScope | ✅ 完成 | `RunAgentInput.contextScope`；sessionKey 派生 `agent:{agentId}:paperteam-{projectId}--{scope}`；scope 归一化；M2.1 无 scope 行为保持（回归测试） |
| 旧 generate API | ✅ 保留 | M2 同步端点与响应契约不变（标 deprecated） |

## M3.1 — Research & Evidence（✅ 完成）

| 项 | 状态 | 说明 |
|---|---|---|
| 项目研究定位字段 | ✅ 完成 | `workflowKind / researchIdea / researchField / documentType / targetProfile / targetVenue / language`；创建携带、`PATCH /api/projects/:id` 更新；旧版 project.json 向后兼容 |
| Researcher | ✅ 完成 | Idea Research 结构化输出校验后落盘 `research/research.json`；候选 Evidence 以 unverified 进入 EvidenceStore；候选 bibliography 去重 |
| Target Feasibility | ✅ 完成 | HIGH/MEDIUM/LOW/INSUFFICIENT 离散结论；LOW/INSUFFICIENT 必须给出差距；HITL adjust 更新目标后重评估（≤3 次） |
| EvidenceStore | ✅ 完成 | 项目级 `evidence/evidence.jsonl`：append/get/list/query/updateVerification/markUsage/stats；损坏行容忍；项目隔离 |
| Citation 静态核验 | ✅ 完成 | `\cite` 族 ↔ references.bib：missing/unused/duplicate/bad；零依赖 |
| Citation metadata 核验 | ✅ 完成 | Provider 抽象 + CrossRef/OpenAlex/arXiv：404 → not_found、网络故障 → unverifiable（绝不因网络判 not_found）；开关与上限可配 |
| Reference PDF 接入 | ✅ 完成 | SourceStore：上传（base64，20MB 上限）、sourceRole、preferred、删除；原始文件与解析产物隔离 |
| PDF 分析 | ✅ 完成（文本层）| `BuiltinPdfAnalyzer`：零依赖文本/结构层；extractionQuality 如实分级 |
| 多模态扩展点 | ✅ 接口就绪 / ⏳ 受环境约束 | `MultimodalAnalyzer` 接口 + `AgentMultimodalAnalyzer`（本地路径交 Runtime 侧 pdf 能力）；能力不可用返回明确 capability-gap，不伪造成功 |
| Section-based 手稿 | ✅ 完成 | outline.json（≥3 节校验）；章节正文片段校验；`main.tex` 由确定性代码组装（不交给 LLM）；references.bib 确定性生成 |
| Derived Context | ✅ 完成 | `context.yaml` 可随时删除重建；`GET /context?rebuild=true` |

## M3.2 — Review & Revision（✅ 完成）

| 项 | 状态 | 说明 |
|---|---|---|
| Reviewer | ✅ 完成 | 单 Agent 三 skill：fact / academic / style；统一 ReviewIssue |
| contextScope 隔离 | ✅ 完成 | review/fact、review/academic、review/style 三个独立会话 |
| 并行 fan-out | ✅ 完成 | `Promise.all` 三路并行；无 dangling 连接/定时器 |
| Review aggregation | ✅ 完成 | 确定性聚合；无 LLM 参与聚合 |
| bounded revision loop | ✅ 完成 | 默认最多 2 轮自动修订；引用核验问题进入修订指令；超限 → HITL |
| Build Gate | ✅ 完成 | 编译结果 + include + bib 可用；只判「能否构建」（D-0015） |
| Quality Gate | ✅ 完成 | 9 条确定性规则；报告落盘 + 事件 |
| Draft/Final 规则 | ✅ 完成 | Draft = Build Gate 通过；Final = 双 Gate 通过 |
| Existing-LaTeX 导入 | ✅ 完成 MVP | 零依赖 ZIP 读取器（防 Zip Slip）；结构识别；原始快照；Baseline Compile best-effort |
| Existing-Paper workflow | ✅ 完成 | 导入校验 → baseline → 论文理解 → 引用审计 → 审稿 → 目标评估 → 改进计划 → HITL → 逐节改造 → 共享后段 |

## M3 API 一览（实际实现）

> Workflow API（`POST /api/projects/:id/workflows` + `/api/runs/*`）是**主入口**；
> 下列 review / citation-check / build / quality-gate 等细粒度端点是调试 / 手动操作 /
> 工具 API，前端（M4）不自行串联它们——编排由 WorkflowOrchestrator 在后端完成。

```text
GET    /health                                    存活探针（含 Pi Runtime 实时健康）
GET    /api/runtime/status                        Runtime 诊断（runtime/agents/model/sessions，Pi schema）
POST   /api/projects                              创建项目 {title, workflowKind?, researchIdea?, …}
GET    /api/projects/:id                          项目元数据
PATCH  /api/projects/:id                          更新研究定位字段
POST   /api/projects/:id/generate                 M2 同步写作+编译（deprecated，保留兼容）
POST   /api/projects/:id/workflows                创建异步 WorkflowRun {kind, prompt?} → 202 {runId}
GET    /api/runs?projectId=xxx                    run 列表
GET    /api/runs/:runId                           run 状态 / 待办 / 错误
GET    /api/runs/:runId/events                    SSE（replay + 实时 Domain Event）
POST   /api/runs/:runId/resume                    HITL 输入 {decision, payload?}
POST   /api/runs/:runId/cancel                    取消
POST   /api/projects/:id/import                   导入 LaTeX 项目（archiveBase64 | files）
GET    /api/projects/:id/import                   最近导入报告
POST   /api/projects/:id/sources                  上传文献 {fileName, contentBase64, sourceRole?…}
GET    /api/projects/:id/sources                  文献列表
GET|PATCH|DELETE /api/projects/:id/sources/:sid   详情 / 角色 / 删除
POST   /api/projects/:id/sources/:sid/analyze     PDF 分析 {mode: builtin|multimodal}
GET|POST /api/projects/:id/evidence               Evidence 列表（查询参数）/ 手工添加
POST   /api/projects/:id/evidence/:eid/verify     更新核验状态
GET    /api/projects/:id/feasibility              最近可行性报告
POST   /api/projects/:id/citation-check           引用核验（静态 + metadata）
GET    /api/projects/:id/citation-report          最近引用报告
POST   /api/projects/:id/review                   独立全面审稿（三路并行 + 聚合）
GET    /api/projects/:id/reviews                  审稿汇总列表
POST   /api/projects/:id/quality-gate             Quality Gate 评估（基于最新 artifacts）
GET    /api/projects/:id/quality-gate?round=N     gate 轮次读取：rounds 列表 + 指定轮 gate + 同轮 reviewSummary + stale（M4.6）
POST   /api/projects/:id/build                    Build Gate + Draft PDF
GET    /api/projects/:id/manuscript               大纲 + 章节状态
GET    /api/projects/:id/context?rebuild=true     Derived Context
POST   /api/projects/:id/paper/pdf                上传 Final PDF + 解析（M4.3）
GET    /api/projects/:id/paper                    PDF 状态 + sections + stages（M4.3）
POST   /api/projects/:id/paper/reparse            重跑解析（M4.3）
GET    /api/projects/:id/paper/chunks?sectionId=  chunk 明细（M4.3）
GET|POST /api/projects/:id/paper/map              PaperMap 读/重建（M4.3）
GET    /api/projects/:id/paper/review-context     section review 上下文预览（M4.3）
POST   /api/projects/:id/citations/extract        引用提取（确定性，M4.3）
GET    /api/projects/:id/citations                提取摘要 + references（M4.3）
POST   /api/projects/:id/citations/verify-metadata 真实性核验（外部学术库，M4.3）
GET    /api/projects/:id/citations/metadata       逐条核验记录（M4.3）
POST   /api/projects/:id/citations/verify-claims  (claim,citation) 语义核验（M4.3）
GET    /api/projects/:id/citations/claims         语义核验记录（M4.3）
GET    /api/projects/:id/citations/integrity      完整性汇总 + gate 输入（M4.3）
POST   /api/projects/import-pdf                   已有论文 File-First 导入（2026-09-07）
GET    /api/projects?scope=archived|all            归档/全量列表（默认 active，2026-09-07）
POST   /api/projects/:id/archive|restore           归档 / 恢复（2026-09-07）
DELETE /api/projects/:id                           永久删除（仅已归档；2026-09-07）
PATCH  /api/projects/:id                           研究定位 + title 重命名（2026-09-07）
GET    /api/projects/:id/paper-review              快速 Review 聚合报告（2026-09-07）
GET    /api/skills                                Skill 列表 + 绑定（M4.3）
GET    /api/skills/:id                            Skill 详情（M4.3）
POST   /api/skills/:id/summary                    重新生成中文简介（M4.3）
```

## 测试与验证

- **当前（2026-09-10，M4.8）：Backend 565 passed（+7 个默认跳过的 live smoke）+ Frontend 161 + 浏览器级 E2E（Playwright，`e2e/`，需运行中的 dev 栈）**：默认栈 smoke 7 / visual 全通过；无模型栈 workflow 4+1skip（D 模型未配置失败路径 + E 模型门控）；scripted 栈 hitl 7 / evidence-gate 7（需 `PAPERTEAM_TEST_RUNTIME_REVIEW=fail,pass` 驱动两轮 gate）/ paper-artifacts 10（本机真实 MiKTeX）/ **version 7（M4.8，`PAPERTEAM_E2E_VERSION=1`）/ improvement 2（M4.8，`PAPERTEAM_E2E_IMPROVEMENT=1`）全部通过**。
- 历史基线（M4.3）：**Backend 285 + Frontend 34 个测试全部通过**（vitest；backend 29 个测试文件 + 1 个默认跳过的 live smoke（`PAPERTEAM_LIVE_SMOKE=1` 显式启用，真实公网）；frontend 6 个测试文件。M4.3 新增 51 个 backend 测试：domain model 9 / PDF 真实 PDF e2e 8 / context builder 7 / 引用提取 4 / scholarly 10 + live 4 / 语义核验 4 / skill registry 9；frontend 新增 10：skills/pdf/citations 视图）。构成：M1/M2 业务与 Project/LaTeX/HTTP、M3 Workflow / Evidence / Review / Revision / HITL / Quality Gate / Domain Event / SSE / checkpoint、M3.8 Runtime 层（PiRuntimeAdapter L1 fake session 纯单元 + L2 真实 SDK × 官方 fauxProvider、contextScope 派生、RuntimeStatus Pi 形状、config Pi 块）、M4.0 Project List API。
  M3.8 新增/强化覆盖——Contract v2（`startAgent` 立即返回句柄、运行中 `events()` 消费 replay+live+settle 终止、多订阅独立、`cancel()` 幂等含已完成/已取消、排队任务取消不误伤同会话前序 run、`result()` Promise 缓存、timeout 路径 reject 一致、`close()` 收敛全部在途 run 并 dispose、getTask 运行中/已完结语义）；**tool execution abort 专项**（真实 SDK：工具执行中 cancel → AbortSignal 传导 → 工具停止 → cancelled）；OpenClaw 架构专属测试（mock Gateway 集成 / bootstrap / supervisor / versionPins）随架构删除，业务测试全部迁到 v2 fake runtime。
- `npm run typecheck`、`npm run build` 通过（backend 与根入口均验证）；无 lint 脚本（package.json 未定义）。
- 测试策略：编排引擎与业务服务为真实实现，仅 AgentRuntime 注入脚本化 fake
  （按 contextScope 返回结构化输出）；LaTeX 编译注入 fake runner；metadata provider 注入 fake fetch。

## 非阻塞环境验证项（Non-blocking Validation Gaps）

以下为**环境验证缺口，不是设计决策，不阻塞代码交付**：

1. **带真实模型凭据的完整 Idea-to-Paper E2E**：M3.7/M3.8 已用真实 Pi SDK + 官方 fauxProvider 验证全部 Runtime 语义（初始化 / 单轮 / 事件 / 取消 / 工具取消 / 并发 / 隔离）；**L3 Live Provider E2E 已于 M4.2.5（2026-09-05）verified**——真实 `zai-coding-cn/glm-5.3` 经运行中 Backend 验证单 Agent / SSE / Workflow 至首个 HITL / cancel（见 M4.2.5 节）。**M4.5（2026-09-09）已用真实模型验证 HITL 决策链**：真实推进至 feasibility awaiting → Backend 重启恢复 → resume approve → outline 重规划 → cancel。HITL resume 之后的完整论文链（写作 → 审稿 → 修订 → PDF）仍未跑真实模型（有意节省额度，按需）。
2. **TeX Live 真实编译**：本机未安装 pdflatex/xelatex/latexmk；LatexCompiler 与 Build Gate 的编译路径经注入式 runner 覆盖，真实 PDF 编译待有 TeX 环境的机器验证。
3. **多模态 PDF 视觉级分析 E2E**：依赖具备视觉/PDF 能力的模型与沙箱路径授权，当前环境无法真实跑通（返回 capability-gap 如实报告，不伪造成功）。
4. **Citation metadata providers 真实网络**：M4.3 已用真实 crossref/openalex/arxiv 跑通 live smoke（含 S2 429 降级、虚构文献 not_found）；长期限流形态待部署环境观察。
5. **GLM 语义核验 live**：本轮模型未配置（凭据按规范仅运行时注入），语义核验以 Fake Runtime 全场景覆盖 + 真实 backend 降级路径验证；待模型配置后做 GLM-5.3 live 语义 smoke（M4.3.8 顺带）。
6. **GROBID**：callout↔reference 精细关联与 author-year 复杂版式的增强通道，部署成本（Java 21/Docker）超出本轮；M4.3.8/M5 评估（见 DECISIONS）。

## M3 遗留问题（真实问题，均不阻塞验收）

1. Outline HITL 当前仍为强制节点（PRD 标记 Outline 确认为可选）；当前实现两处 HITL（feasibility/outline）都必经，计划 M4 前端 / Workflow 配置化处理。
2. EvidenceStore 的 update/markUsage 是全量原子重写（规模内可接受）；索引/数据库迁移条件仍按未决问题 2 评估。
3. 修订循环对「需要改 bib 本身」的引用问题只能删除/弱化引用，不会替用户新造文献条目（有意为之：防伪造引用）；bib 自动新增策略未实现，补文献属于 Researcher/用户输入路径。
4. Pi compaction abort 未验证（上游边界）：auto-compaction 已禁用、manual compact 未使用；若未来启用需专项验证其取消边界。
5. Workflow cancel 为边界语义（stage 服务不监听 AbortSignal，在途 LLM 调用跑完后于循环检查点终结；M4.2.5 真实验证确认）；AgentRuntime 级 mid-stream abort 对真实 Provider 的直接观测无公开 API 面（L2 已覆盖同一代码路径）。
6. Windows 下若 dev 父进程被外部硬杀（非 Ctrl+C），Backend 进程可能残留（正常 Ctrl+C 已验证优雅退出）；Pi 路径无任何 Runtime 子进程，硬杀 Backend 即全部回收。

（M3.5~M3.7 时代与 OpenClaw Gateway 相关的遗留项——runAgent 每次连接、Windows Gateway 硬杀孤儿、Gateway 版本 RPC、Bootstrap/生命周期——已随 M3.8 迁移消失，从本清单移除。）

## 未决设计问题

1. documentType / targetProfile 建议值集合的前端呈现（存储层保持自由字符串，不冻结）。
2. EvidenceStore 索引与 SQLite 迁移条件（同前）。
3. M4+ 前端技术栈、Docker/compose、TeX Live 镜像体积控制。

## Project Hardening & Real Paper E2E（✅ 完成，2026-09-07）

全项目 Review / 加固 / 前端重设计 / 真实论文 E2E 一轮（不改产品语义、不换 Runtime、不降低引用真实性要求）：

- **PDF 导入根因修复**：真实论文导入 400「PDF 解析器输出了非法 JSON」——MuPDF C 层把 `MuPDF error: syntax error ...` 警告直接写到 fd 1，与 JSON 混在 stdout。修复：`parse_paper_pdf.py` 解析期间 `dup2(2,1)` 把 fd 1 重定向到 stderr、结果 JSON 经保留的原 stdout fd 作为最后一行输出、`mupdf_display_errors(False)`；Node 侧只取最后一行非空 JSON，错误分为 `PDF_PARSE_FAILED`(422) / `PDF_PARSER_UNAVAILABLE`(503)。新增 `pdfToolchain.ts`（python/python3/py -3 / `PAPERTEAM_PDF_PYTHON` 探测 + 缓存）、`npm run doctor`、启动自检与 `/api/runtime/status.tools.pdfParser`、前端侧栏/横幅提示。中文论文：中文标题/摘要启发、中文编号章节（"3.1 总体框架"、"第 X 章"）、GB/T 7714 与 IEEE 引号式参考文献解析、以标题块为锚的 block→section 分配（同页多章节不再整页归入首节）。
- **Review 韧性**：`review.sections` 只审有正文的章节（<80 字符的标题节记为 emptySections 跳过而非失败）；单节失败先节内退避重试（3 次，5s/20s），持续失败记 `failedSections` 继续下一节，全部失败才 stage 级重试；取消信号贯通 PaperMap 摘要 / 语义核验 / 单节审阅（在途模型调用立即 abort，不再等 stage 边界）；stage 超时改为**空闲超时**（连续 timeoutMs 无进度汇报才判超时，长论文不再被固定预算杀掉）；进度快照 `run.progress` 进 DTO，前端阶段清单实时显示"第 n / N 节、已记录 k 条发现"。
- **Backend 加固**：BusinessError 新增 `NOT_FOUND`/`PDF_*`，`toBusinessError` 不再泄漏内部异常文案；HTTP 层上传体积上限、base64 字段校验、枚举参数校验、405；ProjectStore 每项目串行 `mutate()` + 原子写；SourceStore/EvidenceStore 损坏索引显式报错、404 语义统一；Orchestrator emit 链不被单次写失败污染、超时 abort 在途 stage、同项目并发 createRun 互斥、cancel 期间 stage 抛错归为 cancelled；`writeJsonAtomic` Windows EPERM/EBUSY 重试；`tsconfig` 开启 noUnused*/noImplicitReturns。
- **前端重设计（frontend-design skill，"编辑部校对台"方向）**：archival white 纸面 + ink indigo 强调、状态色 verdigris/ochre/vermilion、页面级标题 serif、左侧数字栏（gutter）替代卡片堆叠；无阴影/渐变；正式 Dark Mode（跟随系统 / 浅色 / 深色，`paperteam.theme` localStorage，`index.html` 首帧前脚本防闪烁，token 全覆盖，设置 → 外观 + 侧栏快捷切换）；App Error Boundary（"页面出现异常"，重新加载 / 返回论文项目，dev 才显示堆栈）；错误码集中映射（MODEL_CONFIG_BUSY / PROJECT_BUSY / NOT_FOUND / AUTH_FAILED / TIMEOUT / RATE_LIMITED / PDF_PARSE_FAILED …）；全部页面 loading / empty / error 三态；行内确认替代 `window.confirm`；tabs/menu a11y（role/aria-selected/键盘）。
- **浏览器级 E2E**：`e2e/`（Playwright，channel chrome，可 `PAPERTEAM_E2E_CDP_URL` connectOverCDP 复用已开浏览器，端口经 env 配置）；`smoke.spec.ts` 16 步用户路径（导入 → 自动 Review → 真实 cancel → 引用提取 → Skills → 模型设置 → 主题切换持久化 → 归档/恢复/删除确认 → 清理自建项目）；`visual.spec.ts` 浅/深 × 1366x768 / 1440x900 / 1920x1080 / 1100w 截图 + 无水平溢出 + 深色真实生效断言。旧 `scripts/browser-qa*.mjs`（手写 CDP client）删除。
- **真实论文 E2E（用户 PDF，不入库）**：26 页、36 节（42 chunks）、25 条参考文献（25/25 解析出标题/年份/作者）、49 处正文引用 / 63 条关联全部可解析；文献真实性 22 VERIFIED / 3 NOT_FOUND / 0 疑似捏造；语义核验 63 条（上限 30 条进入 judge）：2 支持 / 1 部分支持 / 3 不支持 / 39 证据不足 / 18 跳过；分章节审阅 33 / 36 节（3 节仅标题），226 条发现（严重 0 / 主要 59 / 次要 125 / 提示 42），单次完整审阅 29.5 分钟（≈54 s/节，glm-gateway Anthropic 兼容通道）。第一次 stage 尝试因笔记本进入待机 88 分钟被固定超时杀掉——由此引入空闲超时语义。PaperMap 摘要 / 文献元数据 / 语义核验结果按指纹复用，重跑零重复模型调用。

- **模型设置增强（2026-09-07 追加）**：「模型提供商」改为搜索选择器（首字母前缀筛选；分组 已有凭据 / 自定义 / 常用 / 其他折叠）；新增**自定义提供商**（`/api/settings/model/custom-providers`，Anthropic Messages / OpenAI Chat Completions / OpenAI Responses 三种协议，Base URL / Bearer / 额外请求头 / 模型目录参数；配置存 `settings/custom-providers.json`，Key 走 auth.json，启动时 `registerProvider` 重放；删除连带凭据与偏好）。Backend +17 / Frontend +4 测试。

遗留（不阻塞）：LatexCompiler `shell:true` 下 Windows 超时 kill 只杀 shell；语义核验 30 条上限与 INSUFFICIENT_EVIDENCE 占多数（无摘要文献）；项目列表状态字段沿用 M2 的 created/generated/failed，不反映 Review 运行中/完成（需要 list DTO 扩展）；Provider 偶发 503（外部）。

## Project Entry & Lifecycle UX（✅ 完成，2026-09-07）

产品入口与生命周期收口（不是视觉重设计；Modern Research Workbench 视觉体系保留）：

- **新建项目二选一**：「从研究想法开始」/「导入已有论文」；导入已有论文 **File First**——PDF + 目标（快速 Review 推荐 / 系统性改进）即提交，无标题必填，其余定位字段折叠进「高级选项」。`POST /api/projects/import-pdf` 一次调用完成 建项目→解析→自动标题（PDF 内标题优先，不可用则文件名去扩展名兜底；不调 LLM、不要求手填）；ingest/parse 失败回滚删除项目，无半成品。
- **existing_paper_review**：独立 WorkflowKind（completion label=`review`），复用 M4.3 Foundation——`paper.ensure`（PaperMap）→ `citation.extract` → `citation.metadata` → `citation.claims` → `review.sections`（ReviewContextBuilder 受控上下文 × SectionReviewService → ReviewFinding，≤40 节）→ `review.aggregate`（`reviews/existing-review-r*.json`）；不经过旧 manuscript review 链路。模型未配置时导入仍成功，Review 页给出「配置模型后即可开始 Review」引导。
- **项目生命周期**：`archivedAt` 独立生命周期字段（与 status 正交）；`POST /archive`（运行中 run → 409 PROJECT_BUSY，不静默归档）/ `POST /restore` / `DELETE`（仅已归档，否则 409 PROJECT_NOT_ARCHIVED；删除整个工作区 + `PiRuntimeAdapter.releaseProjectSessions` 释放项目会话；设置页输入完整标题确认）。默认列表与最近项目只显示未归档（`?scope=archived|all`）。
- **导航与 Settings**：PaperTeam 品牌即返回论文项目的主页入口（删 Research Workbench）；Settings 二级导航（模型设置 / 项目管理）；项目行重构为 row container + 主内容 Link + 「···」菜单（打开/重命名/归档），Header 支持编辑标题（PATCH title）。
- **验收**：Backend 338 + Frontend 73 测试（新增 import 回滚/自动标题/goal 映射/archive 过滤/restore/仅归档可删/忙碌保护/会话释放/Review 全链路 Fake Runtime）；build/typecheck 通过；Chrome 真实浏览器 8 条用户路径 × 3 分辨率（当时为手写 CDP 脚本，已被 `e2e/` Playwright 套件取代）全部通过。

## 历史

- **M4.4 Workflow Live View + SSE + Cancel + Progress（2026-09-09）**：见「当前阶段」节。
- **引用语义核验可配置（2026-09-09）**：见「当前阶段」节。

- **Review 并发优化（2026-09-08）**：profiling telemetry（e940607）→ 分章节
  Review 有界并发（`SectionReviewScheduler`，e4e8deb）+ PaperMap 章节摘要并发
  （0b9fcc1）；可重复真实 A/B benchmark harness（`scripts/benchmark-review.mjs`，
  8da4d83）。全量 33 节实测（C=3）：review.sections 2.81×、run 总时长 2.61×，
  0 失败 / 0 重试 / 0 次 429；默认并发度定为 3（依据见
  `docs/REVIEW_PERFORMANCE_PROFILE.md`）。
- **Outer Review Loop 架构方向冻结（2026-09-08，纯文档）**：D-0026 确立
  Iterative Writer–Reviewer Outer Review Loop（bounded baseline 之上的
  score-driven 增强；详见「下一阶段规划」节）。
- **Project Hardening & Real Paper E2E（2026-09-07）**：见上节。
- **Project Entry & Lifecycle UX（2026-09-07）**：见上节。
- **M4.3 PDF Review + Citation Integrity + Skill Registry**：Final PDF 成为 Existing Paper 正式 Review 输入；确定性解析（pymupdf 子进程）→ pages/sections/chunks；PaperMap + 受控 section context（隔离证明 + 会话无关重建证明）；引用提取（range 展开/不猜语义）；两层核验（NOT_FOUND≠捏造≠检索失败；语义 judge 禁止凭记忆、伪造引文剥离、确定性 severity）；Citation Integrity 规则并入 QualityGate；Skill Registry（两项 MIT 审计 skill pin revision 入库、按角色注入、中文简介持久化）；最小前端三视图；真实 PDF + 真实学术库 live smoke；285+34 测试。
- **M4.2.5 Live Model Integration Gate**：验证型里程碑（无代码改动）——真实 Provider `zai-coding-cn/glm-5.3` 经运行中 Backend 公开 API 完成 L3 验证：单 Agent smoke（10.3s 真实输出）、live SSE（4 条 LIVE 域事件实时推送）、Workflow E2E 至首个 HITL（checkpoint 全落盘）、真实 cancel（边界语义 + 会话复用）；凭据零泄漏，Pi 全程 in-process，234+24 测试零回归。
- **M3.8 Pi Runtime Migration & Contract v2**：Pi 成为唯一正式 Runtime（`@earendil-works/pi-coding-agent` 0.84.4 精确 pin）；OpenClaw 全套基础设施（Adapter / Gateway client / Bootstrap / supervisor / runtime.json / 三依赖）移除；`AgentRuntime` Contract v2（startAgent → 句柄：运行中事件流 / 取消 / result）；tool execution AbortSignal 取消传导实证；RuntimeStatus 去 Gateway 化；dev 直启 Backend；230 测试。**Pi + Node.js + npm 固化为 M4 Runtime baseline。**
- **M3.7 Pi Runtime Feasibility**：Side-by-side PiRuntimeAdapter 全项验证（in-process / 三路并发 / abort / 事件 / 隔离 / Windows 零 Gateway 子进程），结论 MIGRATE TO PI；280 测试。
- **M3.6 Runtime Baseline Upgrade**：OpenClaw 全家桶 2026.8.2 → **2026.9.1**（历史 baseline；Node 兼容检查收敛到根 package.json engines；runtime.json 存量版本自动迁移；255 测试 + 真机 Gateway E2E 回归）。
- **M3.5 Runtime Bootstrap / M3 Closure**：OpenClaw 独立 Runtime state（`~/.paperteam`）、`npm run dev` 一键启动、Agent 映射方案 A（D-0018）、`GET /api/runtime/status`、优雅关闭与无孤儿验证、254 测试。
- **M2.1 OpenClaw 2.0 Runtime Upgrade**：官方 `@openclaw/gateway-client/protocol`（protocol v4）、Project↔Session 隔离与 runtimeSessionKey 持久化（详见 git history）。
- **M2 Agent Invocation + Project + LaTeX**：runAgent 真实调用链、ProjectStore、WriterService、GenerationService、LatexCompiler、HTTP API。
- **M1 Backend Runtime Skeleton**：工程骨架、AgentRuntime 抽象、Runtime 健康检查。
- **Architecture Research & Product Design Refresh**：竞品调研与产品/架构方向冻结（D-0008~D-0015）。
