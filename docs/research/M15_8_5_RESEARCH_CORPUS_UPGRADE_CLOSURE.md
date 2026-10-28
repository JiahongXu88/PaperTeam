# M15.8.5 — Research Corpus Upgrade & Evidence Lineage Closure

- 日期：2026-10-28
- 基线：`a69b048603398fb60a4f5e1d8bf6f7f22c6a2fdc`（M15.8.4 收口；main == origin/main，clean）→ 本轮 `649eb96` / `e42b986`
- 数据根：`D:\PaperTeamData\M15\M15_8\M15_8_5\`（Phase A 账本 / Phase D 升级产物 / p70 账本 / 预登记——不入 Git）
- 裁决：**CORPUS_UPGRADE_PARTIAL（研究层 PASS，写作层消费未验证）**；M15 保持 **INCOMPLETE**
  - 工程目标达成：真实项目 p-6f05e6980fda 在**产品路径**上从 6/25 摘要级研究基线升级到 **12/25 全文级**（关键 6 源全部成功），synthesis/outline 可追踪重建，新增 **26 条 verified 全文级证据**（16 条锚定升级源），旧 21 条证据与 r16 Gate / Draft rev14 零触碰；
  - 预算硬边界：D1 升级实耗 **63/70**（synthesis proposal 核验未纳入预估），余 7 次不足一个完整审稿循环（≥10-16）→ E1 写作续跑未启动，Writer 对新基线的消费**待后续预算**验证；N1/N2/H 前置未满足 **NOT_RUN**。

## 0. 一屏结论

Phase A 零模型审计把「24/25 PDF 在盘、研究基线仍 6/25」定性为四层叠加：冻结合同（正确，保留）×
升级编排未完成（refresh 是低级原语——一次性失效 18 条、无范围/无互斥/无进度，M15.8.2 的 ad-hoc
行使导致预算争抢半更新态、M15.8.3 G7 整体回滚）× **groundableInBasis null+hasFulltext 语义混用**
（部分重建态可采证面 6→24 的产品级漏洞，m1582-corpus-sync 历史 exploit 的根源）× harness 直写
快照（指纹非 canonical，后自愈）。Phase B 以最小增量产品化修复（CorpusUpgradeService 编排 +
scoped refresh/失效 + HITL 保护 + 闸门语义修复 + Finalize 研究链守卫 + availability 三层口径
API）；Phase C +14 确定性测试（升级 E2E / 幂等 0 调用 / scoped 最小增量 / 薄文本与 metadata_only
负例 / 断点熔断 / 双向互斥 / HITL / 闸门正反例 / Finalize 守卫）；Phase D 在真实项目执行 scoped
6 源升级（生产服务 + p70 账本，508s / 63 调用），全部指标机器可读落档。预算耗尽于研究层完成点，
写作层验证诚实留待后续授权。

## 1. 根因（任务 §8-1：为何 24/25 PDF 可用而只有 6/25 fulltext-basis）

| # | 机制 | 定性 | 证据坐标 |
|---|---|---|---|
| 1 | 普通 resume 不升级基线 | **产品冻结合同，正确**（M11.3 §13-19） | repro R1：buildMatrix 25 skipped/0 built、指纹与计数不变 |
| 2 | 显式 refresh 只是低级原语 | **升级编排未完成（本轮修复主体）**：一次性失效全部可升级条目（无 scoped）、不驱动 matrix/synthesis/outline 收尾、无 owner 互斥（HTTP 动作可与活跃 run 争抢账本）、无 X/25 进度语义 | repro R2：18 条一次性失效、重建需 18 调用、synthesis 立即过期；M15.8.2 §3 争抢实录 |
| 3 | basis 闸门 null 语义混用 | **产品 bug**：`basisDepth===null && hasFulltext` 把「matrix 未构建」（原意）与「条目被失效移除」混为一谈 | repro R3：失效未重建态可采证 24/25 而全文消费 6/25；definitions.ts:5485（修复前） |
| 4 | harness 旁路 + G7 回滚 | **历史事实**：m1582-corpus-sync 直写快照（指纹序列化与产品不一致）扩大可采证面；G7 把 M15.8.2 唯一一次部分升级（S003/S017）整体回滚——基线从此停在 6/25 | scripts/m1582-corpus-sync.mjs:44-48；当前 matrix updatedAt=10-26T11:52（早于 M15.8.2 全部动作） |

## 2. 修复点（任务 §8-2）

| 层 | 改动 | 文件 |
|---|---|---|
| 编排 | `CorpusUpgradeService`（新）：资格过滤 → scoped refresh → 增量 matrix 重建 → synthesis 全量重建 → outline 重规划；全失败熔断（不消费缺源矩阵）；幂等（重复升级 = 研究层 0 调用）；`research/corpus-upgrades.jsonl` 逐事件审计 | `backend/src/survey/CorpusUpgradeService.ts` |
| 范围 | `refresh(sourceIds?)` / `invalidateUpgradableEntries(sourceIds?, skipConfirmed?)`：有界升级 + HITL confirmed 条目保留待裁决 | `CorpusSnapshotService.ts` / `MatrixService.ts` |
| 闸门 | groundableInBasis：matrix 存在而条目缺席 = 不可采证；null 只保留给 matrix 未构建首跑 | `workflow/definitions.ts` |
| 终态 | FinalizeService 新增 survey 研究链新鲜度守卫（synthesis 过期 vs matrix → 拒绝 Final） | `artifacts/FinalizeService.ts` |
| API | `GET /survey/corpus/availability`（downloadedFile/parsedUsable/fulltextBasis 三层口径 + 下游新鲜度 + Author Decision 项）；`POST /survey/corpus/upgrade`；run 创建 ↔ 升级双向互斥（PROJECT_BUSY） | `httpServer.ts` / `serviceStack.ts` |
| 可见性 | matrix_confirm HITL payload 携带升级候选摘要（只提示，不自动触发——预算纪律） | `workflow/definitions.ts` |

无新事实源：升级服务只编排既有 snapshot/matrix/synthesis/outline 单写入口；journal 是派生审计
（append-only），事实源仍是产物本身。

## 3. 前后差分（任务 §8-3）

| 维度 | 升级前（Phase A ledger） | 升级后（upgrade-verify.json） |
|---|---|---|
| PDF 在盘 | 24/25 | 24/25（不变） |
| parsed/chunks 可用 | 24/25 | 24/25（不变） |
| matrix fulltext-basis | **6/25** | **12/25**（+S002 S003 S004 S009 S010 S022） |
| snapshot | revision 1 / fp `f50d48a9…` | revision 2 / fp `ffb8e5b9…`（basisDepth 升级传播） |
| synthesis | 30 items @ 旧基线 | 24 items @ 新矩阵（fp `055125e1…` 对齐） |
| outline | 9 节（旧结构） | 9 节**重组**（metric-evolution / metric-meta-evaluation-and-alternatives / metric-reliability-consensus…），31 refs 悬空 0 |
| verified evidence | 21 条（不变，逐 ID + createdAt 核验） | 21 + **26 新增**（E022-E047，全 fulltext 级；16 条锚定升级 6 源） |
| gate / Draft | r16 FAIL / rev14 | **零触碰**（sha 前后一致） |

关键 6 源逐条：全部 fulltext 深度重建成功（0 failed）、锚点 52/52 真实 chunkId（直读 chunk 文件
逐条核验；初版核验脚本的 52「失败」是驱动引用错服务——`e42b986` 修正后独立复核为 0 issue）、
S022 按实测 docling 产物（57 chunks/63k chars）判 eligible 而非沿用「薄文本」旧记录；S011 保持
metadata_only（`requiresAuthorDecision`，不无限重试）。其余 12 篇 eligible（S005 S007 S013-S020
S023-S025）留待后续升级——availability 如实呈现。

## 4. 下游新鲜度（任务 §8-4）

- matrix fingerprint `07f8d054…` → `055125e1…`；synthesis 重建后与当前矩阵一致（fail-closed 链）。
- outline 重规划（planningAttempts=1）；refs 全部指向新 synthesisId（悬空 0）。
- 24 条 synthesis items 中 **21 条引用升级源**（derivedFrom.entryIds / sourceIds 口径）。
- 写作消费路径（确定性验证，零模型）：当前大纲结构指纹 `0f7a839c1ba3760a` ≠ 最近
  writing.sections 修订快照 `78c67013cb9d8195` → 下一次 run 的 surveyWritingSkippable 判定
  必然全量重写（消费链在输入构造层闭环；**生成层消费未验证**——预算耗尽，见 §6）。
- 旧 run 冻结性：升级不改写在途输入（当时无活跃 run；互斥已测试钉住）；旧 journal/checkpoint
  原样；升级是 revision 2 的受控入口。

## 5. 可复现性与可靠性（任务 §8-5；Phase C 测试坐标 `backend/test/survey/`）

| 场景 | 结果 |
|---|---|
| E2E 升级链（真实 chunkId 锚断言 + synthesis fp 传播 + outline refs 失效重规划） | PASS（corpusUpgrade.test.ts） |
| 幂等：重复升级 = matrix/synthesis/outline 调用增量 0、revision 不空转 | PASS |
| 最小增量：scoped 只重建点名条目（未点名零调用）、未变条目内容保持 | PASS |
| 负例：薄文本（<5 非平凡 chunk）资格拦截 + skippedIneligible 点名；metadata_only 走 Author Decision；未知 sourceIds 拒绝；未冻结拒绝 | PASS |
| 断点恢复：重建全失败 → 熔断（synthesis 不消费缺源矩阵）；修复后重跑幂等补齐 | PASS |
| 并发互斥：活跃 run checkpoint → PROJECT_BUSY；升级中再入 → PROJECT_BUSY；run 创建于升级中 → PROJECT_BUSY | PASS |
| HITL：confirmed 条目不被自动失效（scoped 与全量路径都保留并上报） | PASS |
| basis 闸门：失效待重建 → 不可采证；matrix 未构建 → 可采证（原语义保留） | PASS |
| 陈旧 Gate：survey 半升级态（synthesis 过期）→ Finalize 拒绝；链新鲜 → 正常冻结 | PASS |
| 代理接线 | 未回归（本轮零下载；M15.8.1 的脚本接线守卫测试继续在套件中） |

本地定向回归（survey/workflow/sources/artifacts/version）834 通过；全量套件在本机并行负载下有
5s 超时型时序 flaky（revisionLoop 等，隔离复跑全过；**基线全套件同样存在不相交的负载 flaky**
——已按任务书保留首败与复跑证据）；**GitHub CI + Linux Integration 于 `649eb96` 双绿**（首跑）。

## 6. 性能与预算（任务 §8-6）

| 项 | 实测 |
|---|---|
| 升级总耗时 | 508s（scoped 6 源） |
| 模型调用 | **63**（matrix 6 + synthesis 22 batches + proposal 核验 ~35）/ 上限 70 |
| tokens | in 123,669 / out 20,664 / cacheRead 825,600；list $0.479（Coding Plan 边际 $0） |
| 重建/合法跳过 | built 6 / failed 0 / skipped 0（scoped）；重复升级 no-op 0 调用（测试钉住） |
| 无脑全量重建对比（**估计**，非实测） | 18 matrix + 22 synthesis + ~50 proposal 核验 + outline ≈ 90+ 调用——超 70 上限；scoped 6 源把 matrix 段从 18 压到 6，synthesis 段为全局视图固有成本（设计上不可细分，已在 §2 注明） |
| 预算偏离 | D1 预登记 ≤40、实耗 63——synthesis evidence proposal 的 judge 调用按验证产出计费（26 verified + 拒绝项核验）未纳入预估；预登记已如实回填 |

## 7. 真实 Gate / Final（任务 §8-7/8）

- r16 保持最新（7 opaque + 3 major，FAIL）——本轮**未跑新审稿**（预算），gate 文件 sha 前后一致。
- 无新 Final；最新合法 Draft 仍 rev14（sha 一致）。
- 下一步（需新预算授权 ≈30-40）：续跑 run → 全量重写（大纲指纹已变）→ r17+ 审稿 → Gate →
  Finalize（研究链新鲜度守卫已就位）。

## 8. N1/N2/H（任务 §8-9）

前置（P clean PASS）未满足 → **NOT_RUN**：n1 0/8、N2 未运行（零模型 replay 不冒充 fresh 检出）、
h 0/12。预算未挪用（p70 仅 P 消耗 63/70）。

## 9. 最终裁决（任务 §8-10）

- **CORPUS_UPGRADE_PARTIAL**：研究层升级在产品路径完整达成且全程可追踪（journal/指纹/锚点/
  证据 provenance）；但「Writer/Review 真实消费新全文」的生成层验证因预算硬停未执行（输入构造
  层的确定性消费链已验证）。**不宣称 CORPUS_UPGRADE_PASS**——严格口径要求写作消费实证。
- **M15：INCOMPLETE**。新真实质量缺口：升级后的 12/25 基线 + 47 条 verified 证据是否足以过
  Gate 需续跑实证；剩余 12 篇 eligible 源的升级（~30 调用，含 synthesis 固有成本）可作为后续
  选项；S011 计算效率维度仍需 Author Decision。

## 10. Git / CI

- `649eb96`（产品修复 + 测试 + 驱动脚本）、`e42b986`（驱动锚点核验修正）、`893ed6c`（本报告）
  直推 main；工作区 clean；HEAD == origin/main。
- **CI 与 Linux Integration 结果矩阵**：
  - `649eb96`：CI success（run 40633222290，6m12s，首跑无 flake）+ Linux Integration success
    （run 40633222318，10m55s）——产品代码提交双绿；
  - `e42b986`：两 run **cancelled**（推送 `893ed6c` 时同分支并发取消；其 4 行脚本改动被
    `893ed6c` 完整包含且后者全绿）；
  - `893ed6c`：CI success（run 40634624718，8m55s）+ Linux Integration success
    （run 40634624882，5m50s）。

## 11. 已测事实 / 确定性推断 / 未验证假设（区分）

- **已测事实**：§3-§5 全部表格（机器可读产物坐标见数据根 phase-a/phase-d）。
- **确定性规则推断**：下一次 run 必然重写全部章节（大纲结构指纹不匹配 + fail-closed 写作入口）；
  半升级态无法 Finalize（守卫 + 测试）。
- **未验证模型能力假设**：升级后材料对 opaque claim 清除率的实际影响（M15.8.4 §4 清单的 6 源已
  入基线，但 Gate 结果需真实审稿）；剩余 12 源升级的边际收益。
