# M15.8.6 — Writing Consumption → Real Review/Gate → Final PDF → N1/N2/H 终局验收

- 日期：2026-10-28
- 基线：`6e9fc49c64c6cbdeff7cde10e0bafaf586751c60`（M15.8.5 收口；main == origin/main，clean）→ 本轮 `（本报告 commit）`
- 数据根：原始数据 `D:\PaperTeamData\M15\M15_8\M15_8_6\`（预登记 / 三账本 / 各 phase 产物 / 断言复评——不入 Git）；项目数据沿用 `D:\PaperTeamData\M15\M15_8\projects-root\p-6f05e6980fda`
- 裁决：**M15_COMPLETE（A=CORPUS_UPGRADE_PASS + B 全项达成）**
  - P：真实 Quality Gate **PASS**（r27，required 规则全过、NOT_EVALUATED(required)=0）→ Finalize 真实执行 → **art-final-rev25.pdf** 冻结（SHA256 `f3a3b28d7fbe759e82cfa72c410c15e14418abf8a001b95c82627ac13a0a7dab`，10 页，24 条文献，可打开、书目/引用完整）；
  - N1：fresh 数值矛盾变异被 fresh Reviewer **特异性检出**（两条 critical finding 明确指出 0.801↔0.877 跨节矛盾），Gate FAIL，Finalize 拒绝；N2：坏 key 检出（missing=1），Gate FAIL，Finalize 422，零模型；H：A1–A5 全部成立（HITL 停靠 + 重启保持 + Draft 可构建 + Finalize 双拒 + 无自动填值）；
  - 预算：P 87/240、N1 20/20、H 19/20、N2 0 —— 合计 126 ≤ 280 保护上限；旧账本零触碰（p70 冻结 63/70 只读）。

## 0. 一屏结论

M15.8.5 把研究基线升到 12/25 fulltext-basis + 47 条 verified 证据但预算止步写作层；本轮在放宽
的 240 次授权内用**三个真实 run** 完成闭环：run1（38 调用）以 matrix 幂等跳过（built=0
skipped=25）+ synthesis 复用（指纹一致）的零级联形态，让 Writer **全量重写 9 节**（rev-18，
输入 evidenceFormal=47 / synthesisItems=24 / matrixEntries=25）——r18 Gate 从旧稿的
7 unsupported + 3 major 直接降到 5+2；随后 r18→r21 三轮修订收敛到 2 unsupported，两条均为
「数字/事实范围超出 partial 证据边界」类（E025 MOTChallenge 构成、E002 深度 vs 手工实时性）。
Phase C 用两轮**定向补证**（6 调用，产品三段核验管道、judge 可拒）落 E049/E051/E052 三条
direct 证据（E050 首轮锚到摘要 chunk 判 partial，第二轮加 SEC04:0006 独有拉丁锚后 E052 direct）；
对 r24 唯一剩余阻断——S011（Wernholm TGOSPA，无合法 OA）的定位性提及——按预登记条款删除
实质断言、保留元数据聚合引文（0 模型，处置落档）。run3（28 调用）r27 Gate PASS 并真实
Finalize。P 全程未触碰 Gate 阈值、未批量插披露、未删除科学比较内容（成稿全文人工审读：
MOTChallenge 构成/雾基准四级增强/深度-手工分歧双视角/四类覆盖空缺均实质在场，披露标记仅 2 处）。
Phase D 首次执行 N1/N2/H：N1 以新驱动 `m1586-n1-fresh.mjs`（隔离根 + fresh Reviewer）实证
注入的 ByteTrack HOTA 0.801↔0.877 矛盾被 fact reviewer 两条 critical blocking finding 点名、
两条注入 claim 均判 UNSUPPORTED、Gate FAIL、Finalize 拒绝；N2 零模型路径检出单坏 key；
H 修复了两处从未执行过的脚本缺陷（EvidenceStore 构造 API 漂移、A1 断言时序）后全项通过。

## 1. Phase A — 零模型启动核验（全部磁盘实证）

| 项 | 结论 | 证据 |
|---|---|---|
| 仓库 | `D:\Projects\PaperTeam` @ 6e9fc49c = origin/main，clean | git rev-parse 双侧一致 |
| 活跃状态 | 8 个 run 全部终态；无活跃 workflow/升级 | 逐 run checkpoint status |
| 研究链 | corpus-snapshot revision 2（25 源）；matrix 12 fulltext + 13 abstract；synthesis 24 items（matrixFingerprint 055125e1…）；outline 9 节 31 refs 悬空 0 | survey.json / survey-synthesis.json / outline.json |
| 证据 | 47 条（direct 26 / partial 21，E001–E047） | evidence.jsonl 计数 |
| 写作跳过判定 | rev-1（唯一 writing.sections 修订）快照 outline ≠ 当前 outline → surveyWritingSkippable=false，9 节必然全量重写 | 结构对比（节名含 metric-evolution 等新节） |
| 上一 Gate | r17 FAIL（unsupported 7 + major 5；证据库当时 21 条）→ 本轮首个新评审为 r18 | quality-gate-r17.json |
| 网络 | 代理 7890 → arXiv 200；open.bigmodel.cn 直连可达；auth.json 含 zai-coding-cn/glm 凭据 | curl + 凭据存在性（不回显） |
| 旧账本 | p70 冻结 63 settled / 70（in 123,669 / out 20,664 / cacheRead 825,600），只读副本入 M15_8_6\phase-a | p70-frozen-readonly-copy.json |
| 构建 | backend dist 自 HEAD 重建（tsc exit 0） | npm run build |

注：dry-run 自检时 GlobalBudgetLedger 构造器对旧 96 账本做了一次 limits-tighten 无操作重写
（内容语义零变化：entries 94、status、limits 均不变）——如实入账，无调用增减。

预登记：`M15_8_6\phase-a\PRE_REGISTRATION.md`（验收条件冻结于首轮模型调用前）。

## 2. Phase B — Writer 真实消费新基线（run1 w-954b4856ebd6，38 调用）

- 入口：`m158-p-survey-e2e.mjs --continue`（同项目新 run；tail 账本 p240.json；HITL 沿用预
  登记策略：front approve / stalled 先 revise_more ≤2 / overflow accept_draft）。
- **零级联**：matrix stage `built=0 skipped=25 failed=0`（幂等跳过合规——M15.8.5 升级后的指纹
  链自洽）；synthesis `复用既有 artifact（matrix 指纹未变，24 条）`；outline 未重规划。
- **写作消费**：`writing.sections` stage.completed = sectionsWritten 9 / bytesTotal 15,738 /
  revision 18 / **synthesisItems 24 / matrixEntries 25 / bibliographyEntries 25 /
  evidenceFormal 47**。rev-18 快照与 rev-1 逐节 SHA 全变（含 5 个 rev-1 不存在的新节文件）。
- 评审消费链：r22 claim-grounding 使用 18 条不同证据，其中 **10 条来自 M15.8.5 升级集
  （E022–E047）**——新基线不只是被写入，也被审稿链真实消费。
- 逐节核验（非复制/非追加/非掏空）：r18 相对 r17 的实质变化包括新节 metric-evolution /
  metric-meta-evaluation-and-alternatives 的两条改进路径叙事、coverage-gaps 四类空缺、
  benchmark-protocols 的 MOTChallenge 构成与雾基准细节——均为有证据绑定的综述内容。

## 3. Phase C — Review / 定向补证 / S011 处置 / Gate PASS / Finalize

收敛轨迹（Gate unsupported / major）：

| 轮 | 触发 | 结果 | 剩余 |
|---|---|---|---|
| r18 | run1 新稿首评 | 5 / 2 | E025/E002 partial 边界类 + 其他 |
| r19–r21 | 3 轮修订（stalled REGRESSED → accept_draft） | 2 / 0 | c-83a0360a（E025）、c-2d3fb392（E002） |
| — | 定向补证第一轮（5 调用）：E049 direct（S004:SEC03:0002）、E051 direct（S018:SEC17:0001）、E050 partial（误锚摘要 chunk） | — | — |
| — | 定向补证第二轮（1 调用）：E052 direct（S018:SEC04:0006，加 Hungarian/battery/powered/robotic 独有锚） | — | — |
| r22–r24 | run2（15 调用） | 2→1→1 | S011 TGOSPA 定位性提及（opaque） |
| — | S011 处置（0 模型）：删 2 处实质断言、保留聚合元数据引文（处置记录 phase-c\S011_TGOSPA_DISPOSITION.md；r23 的 ground_existing_source 处方经 0 模型 grep 证伪——25 源 chunks 中 TGOSPA/wernholm 零命中） | — | — |
| r25–r27 | run3（28 调用） | 0 / 0 | — |

- **r27 Gate PASS 明细**：required 全过——hallucinated=0、citation missing/dup/bad=0、
  contradictory=0、unsupported=0、blocking=0、critical/major=0、academicScore 81（≥80）、
  styleRisk 32（≤35）、coverage 7929/7929 字符（9/9 单元）、citation_keys_preserved
  （rev-24→rev-25 100→100 处 / 24→24 key）、fact_preservation 授权 0 变更、
  revision_items validated=1 rejected=0、claim_strength 无升级、outline 契约/引用白名单/
  synthesis 可回溯全过。NOT_EVALUATED 仅 2 条且均 optional（cross_section_numeric_consistency
  NO_TABLES——综述无结果表；target_feasibility 本工作流不适用）。
- **Finalize 真实执行**：`art-final-rev25.pdf`（185,043 字节；manifest kind=final revision=25，
  buildGate+qualityGate 双记录，sourceRunId w-49bb1230e048）。PDF 打开核验：10 页 / 11,629
  提取字符 / 参考文献节在场 / 24 个互异引文编号 / SHA256
  `f3a3b28d7fbe759e82cfa72c410c15e14418abf8a001b95c82627ac13a0a7dab`。
- **人工审读**（成稿全文 + 披露密度扫描）：实质综述比较在场（基准两路线、指标演进三断层、
  两路径互补、共识与分歧双视角、范式-评测互动、四类空缺、有据未来方向）；「据其报道」仅 2 处、
  「未经独立核验/尚缺全文」0 处——无模板化披露膨胀；S011 删除仅限无证据定位句（聚合引文保留，
  结论与批评节的既有 transparent 提及未动）；无新的无支撑关键论断；MOTA/IDF1/HOTA、
  DetA/AssA 的机制与适用边界跨节一致；不同文献比较均按 direct/partial 证据强度约束措辞。

## 4. Phase D — N1 / N2 / H（隔离副本，真实负例）

### N1 fresh 数值矛盾（20/20 调用，PASS）
- 驱动：新脚本 `scripts/m1586-n1-fresh.mjs`（隔离根 M15_8_6\phase-d\n1；变异 = 正文注入
  真实已发表值句 + 结论侧 0.801→0.877 翻转；author-edit 修订入账；run 到 revision HITL 即停
  不批准）。变异引擎双跑确定性 ✅（首轮曾误将结论句写入按字母序的末文件
  tracker-paradigms…，修正为显式定位 metric-evolution/conclusion 后复验）。
- **特异性检出证据**：r28 claim-grounding 把两条注入句各抽为独立 claim
  （c-5e2248217254 metric-evolution「0.801…」/ c-b817700f8024 conclusion「0.877…」）均判
  **UNSUPPORTED / opaque_assertion**；fresh fact reviewer 产出两条 **critical blocking**
  finding，明确写出「与 sections/conclusion.tex 末尾同一句式给出的 ByteTrack 0.877 **直接
  矛盾**」「与前章 0.801 矛盾；不能以『大致』措辞规避」。
- Gate：r28 FAIL（unsupported 2 = 恰为两条注入 claim——对 r27 PASS 基线的干净归因）；
  r29（1 轮修订后）仍 FAIL。Finalize 拒绝 ✅。
- 脚本 exit 5 的根因 = gate 文件**字典序**排序误读旧 r9（数字序 r28 > r9）；已修为数值序，
  并以 0 模型复评脚本（phase-d\n1\reeval-n1-assertions.mjs）对在盘 r28/r29 产物重算四断言
  全真（phase-d\n1\n1-fresh-assertion-reeval.json）。

### N2 引用 key 损坏（0 模型，PASS）
- `m158-n-negative-e2e.mjs --case n2`（zero-model，账本硬顶 1 绊线零触发）：单 key
  bashar2022pursuit → bashar2022pursuitx；citation.verify missing=1/unused=1；
  citation_structure_valid FAIL（missing=1）；Gate FAIL；Finalize 422。变异前后 sha256 +
  offset 入 mutation manifest。产物归档 phase-d\n2\。

### H 作者决策与重启保持（19/20 调用，PASS）
- `m158-h-author-decision.mjs`（隔离根 projects-root-h；注入无证据自研实验论断
  「HOTA 0.672→0.756 / IDSW↓31%」；WORKFLOW_MAX_REVISION_ROUNDS=1）。
- 首次执行暴露两处脚本缺陷（该脚本自 M15.8 写就后从未运行过）：①证据快照用裸 ProjectStore
  构造 EvidenceStore（API 漂移 TypeError）→ 改直读 evidence.jsonl；②A1 断言在阶段 5 作者
  accept_draft **之后**读 run.status 复评（恒 false）→ 改为停靠时刻快照
  （statusAtHitlReach）。两处修复时 0 模型消耗（崩溃于 bootServer 前 / 断言为纯读）。
- 断言（修复后以在盘证据链复评全真）：**A1** run 停在 hitl.revision_stalled@awaiting_input
  不自完成（finalStatusBeforeRestart=awaiting_input）；**A2** 进程级重启后仍
  awaiting_input@hitl.revision_stalled；**A3** 待决期 Draft 构建成功（Build/Quality 分离）；
  **A4** finalize 双拒（待决期 409 活跃互斥；终结后 422 gate FAIL）；**A5** 无自动填值
  （evidence 54→54 零新增；注入论断被合法删除/改写而非补造数据；accept_draft 为操作者代行
  作者决策且登记于 manifest，非系统自动批准）。产物归档 phase-d\h\。

## 5. Phase E — 效率与成本实测（账本逐调用统计 phase-e\budget-summary.mjs）

| 账本 | 调用 | input | output | cacheRead | list-price 估算* |
|---|---|---|---|---|---|
| P（p240） | 87/240 | 807,424 | 97,124 | 2,683,392 | ≈ ¥6.93 |
| N1（n1-20） | 20/20 | 166,168 | 18,949 | 307,008 | ≈ ¥1.21 |
| H（h-20） | 19/20 | 205,250 | 21,840 | 390,656 | ≈ ¥0.80 |
| N2 | 0 | 0 | 0 | 0 | ¥0 |

\* 按智谱开放平台 glm-5.3 近似公开价（in ¥4/M、out ¥16/M、cache-read ¥0.8/M）折算的
list-price 量级；实际消耗走 Z.AI Coding Plan 订阅额度（adapter 侧 estimatedCost 合计 2.26）。

P 分阶段调用：writer/section 9 + writer/revision 23 + reviewer×3 31 + citation 21 +
research-plan 3。失败/重试：全程无 AGENT_RUN_FAILED；唯一非模型重试为 N2 scholarly HTTP
crossref 429 一次（冷却后成功）。矩阵→综合→证据的逐条 judge 成本本轮为 0（幂等跳过），
定向补证 judge 6 次——验证 M15.8.5「proposal judge 按产出计费」的教训已内化进预算规划。

## 6. 工程改动（本轮 commit）

| 文件 | 性质 | 说明 |
|---|---|---|
| `scripts/m1586-n1-fresh.mjs` | 新增 | N1 fresh 变异特异检出驱动（隔离根 + fresh Reviewer + 数值序 gate 轮取） |
| `scripts/m158-h-author-decision.mjs` | 修复 | EvidenceStore 构造 API 漂移（直读文件）×2；A1 断言停靠时刻快照 |
| `docs/research/M15_8_6_*.md` / `docs/PROJECT_STATUS.md` | 文档 | 本报告 + 状态页（保留 M15.8.1–8.5 历史结论） |

无 runtime/产品行为改动（Gate 阈值、评审 prompt、证据管道零触碰）。

## 7. 验收问答（任务 §8-6）

1. **Writer 是否实际消费最新基线？** 是——rev-18 全量重写 9 节，stage 输入
   evidenceFormal=47 / synthesisItems=24 / matrixEntries=25；r22 评审链实际绑定 18 条证据
   （10 条来自升级集）。逐阶段调用：run1 38（含写作 9/修订/评审）。
2. **新旧稿差异与事实漂移？** 新增 5 个节文件、全部节 SHA 变化；引用 key 集 24 条无丢失
   （r27 citation_keys_preserved 100→100）；无事实漂移（fact_preservation 授权 0 变更链）。
3. **与旧 r16/r17 差异及阻断归宿？** r16=7 opaque+3 major、r17=7 unsupported+5 major（旧基线
   21 证据）→ r18 5+2 → r21 2+0 → r27 0+0。两条 partial 边界阻断由 E049/E051/E052 三条
   direct 证据**真实解决**；S011 阻断按预登记**合法删除**（保留元数据引文）；无阈值/披露类
   绕行。r24 出现过的 1 条 KITTI/UA_DETRAC 提法在 r25 收敛段由常规修订消化。
4. **Final PDF？** `artifacts/art-final-rev25.pdf`，SHA256
   `f3a3b28d7fbe759e82cfa72c410c15e14418abf8a001b95c82627ac13a0a7dab`，revision 25，
   Gate round 27（passed=true / reviewedRevision 25），10 页 / 24 引文 / 冻结 manifest 双 gate 记录。
5. **N1/N2/H fresh？** 全部 fresh：N1 真实 Reviewer 特异检出（本轮新注入、本轮新评审）；
   N2 真实 Citation Verify（本轮新变异）；H 真实 run + 进程级重启。零 replay 冒充。
6. **调用与成本？** P 87 / N1 20 / H 19 / N2 0；tokens 见 §5；list-price 合计 ≈ ¥8.9。
7. **终态裁决？** **M15_COMPLETE**——A（CORPUS_UPGRADE_PASS：写作层消费已实证）与 B
   （P PASS + Final + N1/N2/H 全 fresh 通过 + 回归绿）均达成。
8. **仓库状态？** 见 §8（commit 后 HEAD == origin/main、CI + Linux Integration 双绿为终态条件）。

## 8. 遗留与边界（如实）

- S011（Wernholm TGOSPA）永久无合法 OA：本文按预登记以元数据引文收尾；若未来需要展开其
  内容，属 Author Decision（用户裁决是否引入其它合法获取渠道），不由系统代批。
- r27 的 cross_section_numeric_consistency 为 NOT_EVALUATED（NO_TABLES，optional）——综述无
  结果表属形态事实，非规避；N1 已另行实证跨节数值矛盾的 fresh 检出能力。
- 剩余 12 源 fulltext 升级（S005/S007/S013–S020/S023–S025）未执行——本轮 Gate 已闭合，
  无科学缺口迫使升级；如后续扩展综述范围可再按 CorpusUpgradeService 产品路径执行。
- M15_8_4\phase-b\preground-report.json 被本轮定向补证脚本复写（脚本 OUT_DIR 沿用旧路径），
  原件已备份于 M15_8_6\phase-a\m1584-preground-report.original-backup.json。
