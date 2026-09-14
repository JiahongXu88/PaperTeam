# M5 Acceptance（真实论文 A/B 验收记录，2026-09-14）

> 结论先行：**M5 PARTIAL**。M5.3 / M5.4 ✅ COMPLETE；M5.5 🟡 IMPLEMENTED / AWAITING
> REAL DOCKER ACCEPTANCE（本机无 Docker / WSL）；M5.6 已用真实中文工科论文 + 真实模型
> 跑出 A/B 与 Quick Review / 材料不足 / 长程运行证据，但 **A/B 的两臂都以 Quality Gate
> FAIL（Draft）收口、修复 Writer 引用回归后的 A3 因 provider 429 未完成、Docker E2E 未
> 执行**，因此 M5 不能诚实标记 COMPLETE。所有数字来自 `~/.paperteam-acceptance/**/summary.json`
> （本地保留，不入库；论文正文不出现在本文件，只有计数 / 指纹 / 章节数）。

## 1. Environment

| 项 | 值 |
|---|---|
| 主机 | Windows 11 Home（开发机；无 Docker Desktop / WSL） |
| Node | 22（root engines `>=22.22.3`） |
| LaTeX | MiKTeX 25.12：latexmk 4.88 + XeTeX 4.16 |
| PDF | Python 3.11.9 + pymupdf 1.28.0 |
| 模型 / provider | `zai-coding-cn/glm-5.3`（两臂完全相同；Key 经 Settings UI 保存的 auth.json，不在仓库） |
| Runtime 配置 | 全部默认，除 `PAPERTEAM_PI_RUN_TIMEOUT_MS=900000`（见 §4 第一轮发现）；A 臂 `PAPERTEAM_DISABLED_SKILLS=academic-writing-zh,academic-review,academic-style-zh` |
| Quality Gate 阈值 | 默认不变：academic ≥ 80、styleRisk ≤ 35、unsupported critical claims = 0、blocking = 0、critical+major = 0、hallucinated = 0（**未降低任何阈值**） |
| Git SHA（验收代码） | A1/B1/A2/B2/QR/idea：`67efc6d`（+ 未提交的 usage 观测面）；A3/B3：含 Writer 引用修复的工作区（本次提交） |
| 执行器 | `scripts/m5-acceptance.mjs`（启动独立 backend、导入 PDF、驱动 run、自动回答 HITL、采集指标） |

## 2. Corpus（本地输入，不入库）

- 一篇 **26 页中文工科论文 PDF**（车载多目标跟踪方向；PaperMap 36 节；`references.bib` 重建 25 条、正文 22 处引用、20 个被引 key）。sha256 前缀 `…`（见本地 summary.json `corpus.sha256`）。
- 材料不足提案：仅一句研究想法（无数据集 / 实现 / 实验）。
- Eval corpus A–E（`backend/test/fixtures/eval/style-corpus/`）用于 deterministic hard check（M5.4 测试全绿）。

## 3. A/B 设计

| | A（对照） | B（M5 能力） |
|---|---|---|
| 学术 Skill | 关闭（`PAPERTEAM_DISABLED_SKILLS`） | 开启（academic-writing-zh / academic-review / academic-style-zh） |
| stylePolicy | suggest_only | apply_once |
| 其他 | 相同模型 / provider / 参数 / PDF / 阈值 / Reviewer 结构 / 900s 执行超时 | 同 |

工作流：Existing Paper Improvement（导入 → 重建 → 理解 → 引用核验 → 三路审稿 → 目标评估 →
改进计划（HITL approve）→ 逐节修订 → 复审 → Gate → bounded 修订 → HITL → Draft/Final）。

## 4. 运行记录与结果

### 4.1 第一轮（默认 300s 执行超时）——两臂都失败（Runtime 配置发现）

| run | 结果 | 原因 |
|---|---|---|
| B1（Skill 开） | `failed` @ review.run，15.5 min，$0.37 | academic / style Reviewer 读取 Skill 后 6–14 轮工具调用，两次尝试均 300s 执行超时（fact Reviewer 22–139s 完成） |
| A1（Skill 关） | `failed` @ revision.apply，36 min，$0.56 | Writer 单节修订（重建稿单节 1100+ 行）两次 300s 超时；Reviewer 最长 263s |

判定：**D. Runtime 配置**（不是 Skill 缺陷，也不是模型故障）——默认 300s 对 20+ 页真实论文
过短。处置：验收改用 900s；compose 部署默认 900s；`.env.example` 注明。默认值未在代码中改动。

### 4.2 第二轮（900s；含当时未发现的 Writer 引用回归）——两臂均完成为 Draft

| 指标 | A2（Skill 关） | B2（Skill 开 + apply_once） |
|---|---|---|
| 状态 / 产物 | completed → **Draft**（Final blocked） | completed → **Draft**（Final blocked） |
| 总时长 | 45.2 min | 48.5 min |
| 修订轮 | apply + 1 revise（预算 2 → overflow → accept_draft） | apply + 1 revise（同） |
| 首轮审稿 issues（critical/major/minor） | 31（1/9/21），academic 74，styleRisk 25，unsupported claims 9 | 26（5/6/15），academic 66，styleRisk 30，unsupported 15 |
| 末轮审稿 | 24（3/7/14），academic **56**，styleRisk **40** | 22（3/5/14），academic **72**，styleRisk **30** |
| 迭代结论 | IMPROVED（academic 62→56 仍标 IMPROVED：规则集相同、major 5→7 未触发 REGRESSION） | REGRESSION（r3）→ IMPROVED（r4） |
| Gate 末轮失败规则 | 5 条（含 style_risk_threshold 40 > 35） | 4 条（style_risk 通过） |
| finding 带 reason 比例（r1） | 15/31 | 9/26 |
| finding 有位置 / 有动作 | 31/31 / 31/31 | 26/26 / 26/26 |
| Style Polish | 不适用 | **未触发**：当时实现只在 Gate PASS 后提供，B2 Gate 未通过（已修：Draft 路径也提供一次，见 §6） |
| LaTeX 编译 | latexmk 4.0s PASS，Draft PDF | latexmk 4.2s PASS，Draft PDF（317 KB） |
| tokens（in / out / cacheRead） | 345,687 / 231,740 / 1,717,440 | 467,333 / 233,400 / 2,378,688 |
| estimated cost（provider list-price） | $1.95（19 runs，45 turns） | $2.30（21 runs，70 turns） |
| Reviewer 成本 / 时长 | $0.51 / 18.6 min | $1.23 / 29.1 min |
| Writer 成本 / 时长 | $1.34 / 30.4 min | $0.99 / 28.9 min |
| accessed skills（真实读取） | 无（verify-citations / paper-search 被分配但未读） | academic-review、academic-style-zh 在首轮被读取；academic-writing-zh 在 1/10 次 Writer 调用中被读取；verify-citations / paper-search 未读 |

**硬指标（基线 rev-1 → 最终 rev）**

| 指标 | A2 | B2 |
|---|---|---|
| citation key 数 | 29 → **0**（全部 20 个 key 被删） | 29 → **0**（同） |
| final 中不在 bib 的 key（虚构引用） | 0 | 0 |
| 数字 token 数 | 951 → 293（新增 19 个基线不存在的数字） | 951 → 542（新增 18 个） |
| 数学片段 | 0 → 225 | 0 → 280 |
| styleSignals（表面模式） | 0 → 1 | 0 → 0 |
| 编译 | PASS | PASS |
| Quick Review 修订变化 | — | — |

**发现 C（Writer regression，两臂共有）**：Existing-Paper 项目没有 research artifact
bibliography，修订 prompt 写成「无可用文献：不要使用 \\cite」，Writer 据此把重建稿的
全部 `\\cite{refN}` 删光；`citation.verify` 之后 citedCount=0，而 Gate 的引用规则
（hallucinated=0 / 结构合法）全部通过——**引用保持不在 Gate 口径内**。这不是
Skill 或模型问题，A/B 两臂完全一致。已修复（§6）并补测试；新增数字多为 Writer
把 PDF 重建文本里的表格 / 公式改写成 LaTeX 数学时产生（数学片段 0 → 225/280），
其中是否有编造数值需人工核对（未做，见 §8）。

**A/B 观察（诚实口径）**：B 的末轮 academicScore 更高（72 vs 56）、styleRisk 更低
（30 vs 40，A 因此多挂一条 gate 规则）、REGRESSION 被收敛判定捕获；但 B 的首轮
Reviewer 更严格（unsupported 15 vs 9、critical 5 vs 1），成本 +18%、Reviewer 时长
+56%。这些数字来自同一 Reviewer 结构的模型输出，**不能作为 B 质量更好的证明**——
人工 pairwise 评价未完成（§8）。可确定的是：Skill 路由与 accessed 观测在真实运行中
按设计工作；Skill 显著增加 Reviewer 工具轮次与延迟。

### 4.3 第三轮（修复 Writer 引用回归后）

| run | 结果 |
|---|---|
| A3（Skill 关） | `failed` @ review.run：provider **429 速率限制**（`code 1302`），两次尝试 15s 内失败；4 个 backend 并发（A3/B3/A2/QR）触发；判定 **E. Provider failure**，不是产品缺陷；`citation.verify` 299s，unverifiable 20（外部学术库同时限流） |
| B3（Skill 开） | 本文写作时仍在运行（review.run → assessment.target 已过，预计 ~50 min）；结果以本地 `B/improvement-2026-09-14T10-0*/summary.json` 为准，未纳入本表 |

### 4.4 场景 C：Quick Review（只读红线）

- run completed（label=review），34.8 min，$1.82，74 runs（33 节审阅 + 章节摘要）。
- **revision before == after == 0；manuscript 目录 mutatedFiles = 0**（零写入）。
- 177 findings（critical 1 / major 38 / minor 124 / info 14；academic 90 / consistency 45 / style 27 / citation 10 / fact 5）。
- 引用真实性：25 条参考文献，VERIFIED 16、PROVIDER_ERROR 9（外部库限流，如实标记）、probableFabrications 0。
- accessed：分章节审阅 `review/section/*` 34/37 次真实读取 academic-review；章节摘要任务走 reviewer 默认绑定（verify-citations）且未读取。

### 4.5 场景 B：材料不足提案（idea_to_paper，stop-at outline）

- research.idea 432s → feasibility **MEDIUM**，明确列出 5 项缺失（无实现、无数据集、无
  Baseline 对比、无算力规划、Evidence 全部未核验）与 5 项需补实验；**没有编造实验 / 数据 /
  引用**（理由文本引用的都是公开基线与数据集名称，作为"需要什么"而非"已有什么"）。
- 大纲生成后按设计取消（不烧写作 token）；$0.59，8 runs。
- Gate 未被降低（该场景未进入 gate）。

### 4.6 场景 E：长程 Runtime

- 4 个 backend 进程并发运行 ~1.5 h，总计 ≥ 150 个 Agent run；无 CONTEXT_BUDGET_EXCEEDED /
  RUNTIME_QUEUE_FULL / RUNTIME_SESSION_CAPACITY；A1 出现 1 次会话轮换（rotation）；
  timeout 分层如实产出 `EXECUTION_TIMEOUT`（A1/B1）；取消（idea 场景 cancel）即时终态；
  usage 观测面（`runtimeStats.usageTotals` + per-task 日志）覆盖全部 run。
- 未覆盖：进程重启 / checkpoint 恢复（本轮未刻意制造），优雅停机（Windows 下 kill 为强制终止）。

### 4.7 场景 F：Docker E2E

**未执行**：本机无 Docker / WSL。GitHub Actions 的 docker-build job 是第一处真实构建反馈
（首跑因 ubuntu 缺 pymupdf 失败于测试阶段，已修；docker 阶段尚未跑到）。

## 5. Human evaluation

**未完成**。模板见 `docs/eval/M5_STYLE_EVAL_TEMPLATE.md`；A2 / B2 的 Draft PDF 与逐轮
finding 保存在本地 `~/.paperteam-acceptance/{A,B}/improvement-*/`，可按模板做 blind pairwise。
本文件不用 Reviewer 自评分数替代人工评价。

## 6. 验收驱动出的修复（本次提交）

1. **Writer 引用回归**：修订 / 润色的可引用 key 改为 research artifact ∪ `manuscript/references.bib`
   （`manuscriptBibliography`），修订 prompt 增加「保留现有 \\cite，不得整体删光」。
2. **Style Polish 在 Draft 路径也提供一次**（Gate 未通过、用户 accept_draft 后、build.draft 前），
   否则真实论文几乎永远没有润色机会；测试新增（gate 持续失败 → stalled/overflow → 润色 → 强制复审 → Draft）。
3. **Runtime 观测**：`runtimeStats.usageTotals` + per-task usage 日志（含 assigned / accessed skills）。
4. **部署默认**：compose `PAPERTEAM_PI_RUN_TIMEOUT_MS=900000`；`.env.example` 注明长论文建议值。
5. **CI**：ubuntu 安装 pymupdf。

## 7. Known limitations

- Quality Gate 不检查「修订是否删除了原有引用」（本次靠硬指标发现）；建议后续加入
  `citation_keys_preserved` 规则或修订 DoD。
- 硬指标里的「新增数字」只能判「基线不存在」，不能判「编造」——需人工核对。
- Style Polish 真实模型证据依赖 B3（运行中）；B2 因当时的 Gate-PASS 限制未触发。
- 外部学术库（Crossref/OpenAlex）在并发下 PROVIDER_ERROR，引用真实性核验有 9/25 未决。
- Windows 下无法验证 SIGTERM 优雅停机。

## 8. Final verdict

- 场景 A（完整论文全链路）：**Draft PASS / Final blocked（Gate 如实 FAIL）**，两臂一致，阈值未动。
- 场景 B（材料不足）：**PASS**（明确缺失、不编造）。
- 场景 C（Quick Review 只读）：**PASS**（零修订、零写入）。
- 场景 D（Style Polish）：**未在真实模型上触发**（B2 设计限制；B3 待定）。
- 场景 E（长程 Runtime）：**PASS**（有界、可观测、结构化终态）。
- 场景 F（Docker）：**BLOCKED**（无 Docker 主机）。
- **M5：PARTIAL** — blocked at M5.5（真实 Docker 验收）与 M5.6（人工评价未做、Style Polish 真实证据待 B3、A3 因 429 未完成）。
