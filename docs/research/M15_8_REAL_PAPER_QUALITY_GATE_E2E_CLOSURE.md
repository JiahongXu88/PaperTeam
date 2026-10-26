# M15.8 — Real-Paper Quality Gate E2E Closure

- 日期：2026-10-26
- 裁决：**M15_8_PARTIAL**（真实正向 READY/Final 未达成——P 场景在修订闭环收敛中耗尽预登记预算（r6 仍剩 2 条 unsupported claim + 2 条 major）；G4/G6/G7 达成；G5 部分达成；无 false_ready、无语义篡改、无 HITL 越权）
- 仓库起点/终点：main `0c515ee` → `9eef50a`（P 驱动）→ `bafb0db`（驱动族）→ 本报告收口提交（见 §8；全部直推 main）
- 数据根：`D:\PaperTeamData\M15\M15_8\`（预登记、账本、全部场景产物——不入 Git）
- 预登记：`PRE_REGISTERED_E2E_GATES.md`（frozen body sha256 `bcba434c…33b48f`；Dev #1 append-only，正文未动）
- 模型通道：Z.AI Coding Plan `zai-coding-cn/glm-5.3`（Pi Runtime；订阅额度内，list-price ≈$3.81）

## 0. 一屏结论 + G1–G8 决策表

**最初问题（「Quality Gate 必须修好，质量必须达标」的正向闭环）在本轮未完成。** 首次以真实 topic_survey 全链（Topic→Research→Synthesis→Writing→Review→Gate→PDF）运行生产 Gate：6 轮修订把 unsupported claims 从 10 压到 2、major 从 3 压到 2、blocking 清零、15 条引用经 scholarly 全数真实核验（0 幻觉 0 缺失 0 不可验证）、survey 契约全过、分数门已 ADVISORY 化不阻断——但**预算在收敛完成前硬停**，未产出 passed=true 与 Final。阻断不是 Gate 工程缺陷：是材料（arXiv CDN 对本机网络的间歇节流 → 19/25 文献全文缺失 → 采证无材料）× 预算（预登记硬顶）的组合。

| # | 门槛 | 判定 | 证据 |
|---|---|---|---|
| G1 | 真实正向 READY | **NO** | gate r6 `passed=false`（unsupported 2 + major 2）；r1-r6 轨迹 `m158-p-trajectory.json` |
| G2 | 真实 Final PDF | **NO** | Finalize 正确拒绝（422 QUALITY_GATE_FAILED）；Draft PDF 存在（`art-draft-rev5.pdf` sha `4d2ba588…`，Build Gate PASS） |
| G3 | 核验齐备（NOT_EVALUATED(required)=0） | **NO** | citation.verify 真实执行且 15/15 PASS；evidence 17 条 verified 真实；但 rule 4 FAIL（2 条未支撑论断）——非空条件通过从未发生 |
| G4 | 真实负例阻断 | **YES（fresh N2 + 锚）** | N2：注入 key 损坏 → citation.verify `missing=1` → `citation_structure_valid` FAIL + Finalize 422（变异特异，零模型）；N1：gate FAIL + Finalize 拒绝（基线阻断；变异特异检出由 C 族 45 run 重放 REMAIN_BLOCKED@HEAD + M15.7 mutated r2 在盘锚（fact_preservation 对未授权数值编辑真实触发，本轮复核未翻转）承担） |
| G5 | 作者决策不越界 | **PARTIAL** | fresh H 未执行（预算耗尽）；语义由 P 真实 episode 部分佐证：revision_stalled ×2（REGRESSED/STALLED 收敛检测真实触发，操作者按预登记策略应答，系统无自动批准）、Draft 可构建 ✓、Finalize 拒绝 ✓、无伪造证据 ✓；A2（待决状态跨重启保持）未演示 |
| G6 | 语义不混用 | **YES** | R 重放 111/111 `ASSESSMENT_INCOMPLETE` + `REMAIN_BLOCKED`（A22/B44/C45）@当前 HEAD；identity/monotonicity/falseReady 全 0；本轮零后端 src 变更（diff 审计：仅 scripts/ + 文档）；M15.7 锚未翻转 |
| G7 | 可复现 | **YES** | 冻结产物双入口重评：20/20 共享规则 status+detail 全等（2 规则因 latestValidation 对齐窗口省略——设计内）；Finalize 确定性 422；Draft PDF 字节级一致 |
| G8 | 测试与远程收口 | 见 §8 | backend typecheck/build 零错；全量两次 4341/0/42（基线+终态）；frontend typecheck ✓；CI/Linux Integration 于最终 HEAD（§8 实测回填） |

**G1/G2/G3 任一不成立 → 按任务书规定裁决 M15_8_PARTIAL。**

## 1. P — 正向场景（核心事实）

- 项目 `p-6f05e6980fda`（topic_survey，zh，MOT 评测指标综述）；4 个真实 run 实例（w-bbfd87fd9712 → w-5b29a208cb9a → w-d00409085580 → w-dd1fd1bbd731，含两次预算事件重启）。
- **真实全链执行**：research.plan → survey.search（25 篇来源，学术 provider 合法获取）→ survey.fulltext（docling 结构化解析）→ survey.matrix → survey.synthesis（**17 条 verified evidence 经 judge+metadata 真实核验入库**）→ survey.outline → writing.sections（9 节，21KB，digest 模式）→ **citation.verify（15 引文 scholarly 18 HTTP 请求全数核验：0 幻觉/0 缺失/0 不可验证）** → review.run ×6 轮 → quality.gate ×6 轮 → revision.plan/revise/validate ×2 轮 → revision_stalled HITL ×2 → build（Build Gate PASS，Draft PDF 冻结）。
- **HITL 19 次全部落盘**（journal）；操作者按预登记策略应答（front approve / stalled ≤2 次 revise_more）；系统侧零自动批准。
- **Gate 轨迹**：r1 `unsupported 10 + blocking 1 + major 2` → r4 `11/0/1`（STALLED）→ r5 `4/-/3` → r6 `2/-/2`；`academic_score_threshold` 全程 ADVISORY（76<80 → 不阻断，policy_aware 生产臂真实生效）；survey 契约 4 规则全过；citation 2 规则全过。
- **收敛中的预算终点**：r6 后修订验证 HITL approve 触发 recheck → tail 账本 72/72 硬停 → run failed。**未发生 false_ready**（Gate 在每一步都如实拒绝）。
- **本综述是系统验收工件，不是用户原创可投稿稿件**（预登记 §3.P 声明）。

### P 未达成的真实根因链（按因果排序）

1. **材料层（主因）**：25 篇入选文献中 19 篇全文未落地——arXiv CDN 对本机网络呈长波间歇节流（实测：同 URL curl 3/3 成功与 node fetch/undici 全超时交替出现；export 镜像同象限；非 arXiv 出版商全部可达）。全文缺失 → targeted grounding 无材料 → r1-r4 的 unsupported claims 无法转 verified → 修订策略退化为弱化/删除（claim-resolution r4：6 use_existing + 2 remove + 3 weaken，0 ground）。
2. **预算层**：语料经系统推荐集扩到 25 篇（协议目标 8-12），matrix+synthesis 消耗 79/96 → Dev #1 tail 72；P 的修订闭环 6 轮把 tail 耗尽（Dev #1 自设条款禁止 gate 结果出现后的任何预算追加——遵守）。
3. **内容层（残余）**：r6 仍剩 2 条 unsupported（弱化后仍被判 opaque）+ 2 major——趋势单调向好（r4→r6：11→2），但无法证明「再一轮必过」。

### §5.D 受控修复实际行使

- 全文回填（0 模型）：curl 下载 + 产品 `attachManualFullText`（provenance=manual-upload）——3 篇落地（S002/S004/S019）后网络长波转坏，sweep 2 轮未再获得；回填产物与失败清单 `m158-p-backfill-report.json`。
- LaTeX 预检（0 模型）：Build Gate PASS（Draft PDF 冻结）。
- preground（0 次执行）：claim-resolution r4 无 ground_existing_source 条目——无可采证项，如实跳过。

## 2. N — 负例（变异特异 + 基线，零模型）

- **N2（引用 key 损坏，变异特异 ✓）**：`bashar2022pursuit` → `bashar2022pursuitx`（manifest 双向 sha256）；真实 citation.verify 复跑（16 HTTP 请求）→ `missing=1` 精确命中 → `citation_structure_valid` FAIL → gate `passed=false` → **Finalize 422 QUALITY_GATE_FAILED**。全程 0 模型调用（账本绊线 0/1）。
- **N1（数值矛盾注入，CE1 方法论）**：真实已发表 HOTA 值对（0.801/0.775/0.768）双插入 + 结论侧翻转（0.801→0.877）；gate FAIL（基线 2+2 保持）+ Finalize 拒绝 ✓；**变异特异的 fresh 检出未执行**（需新一轮 review，预算耗尽；fact_preservation 只看被审窗口，评审后编辑不在窗口内——如实呈现）。数值矛盾检出能力由锚证明：C 族 45 注入 run（abstract_vs_table_number 等 24 项登记变异）在当前 HEAD 重放 **45/45 REMAIN_BLOCKED**（本报告 §3 R 重放）+ M15.7 mutated r2 在盘复核（fact_preservation 对 497→431 未授权编辑真实触发，未翻转）。
- 基线（P 自身 r6 的 2+2 失败）在两份 N 报告中如实入账——负例阻断不因基线已 FAIL 而虚增。

## 3. R — 第三方只读语义（零模型重放，当前 HEAD）

`m157-policy-shadow-replay` 全量重放至 `m158-r-shadow-replay-report.json`：111/111 `ASSESSMENT_INCOMPLETE`（published 只读=诚实评估缺口，非投稿 READY）、`REMAIN_BLOCKED` A22/B44/C45、恒等违规 0、单调性违规 0、FALSE_READY 0、解锁 0。**语义分离在当前 HEAD 成立**（该重放同时充当 G6 的「本轮改动未破坏既有语义」证明——本轮零后端 src 变更）。

## 4. H — 作者决策边界（PENDING_BUDGET，部分佐证）

fresh H（注入无证据实验论断 → 合法 HITL 停止 → 重启保持）未执行：预算在 P 耗尽后，任何 run 启动即被账本拒绝。已获得的语义证据（来自 P 真实运行）：convergence STALLED/REGRESSED 检测真实触发 revision_stalled HITL；操作者（非系统）应答；Draft 与 Final 分离正确（Draft PASS + Final 拒绝）；证据库无任何伪造记录（17 条全 verified 且 provenance 可溯）。**A2（跨重启待决保持）与「缺实验数据稿件的活体停止」未演示**——留待续轮。

## 5. G7 — 确定性复现（零模型）

冻结副本上生产双入口（POST /quality-gate）重评：**20/20 共享规则 status+detail 逐字节全等**；`revision_items_resolved`/`claim_strength_guard` 2 规则因 latestValidation 对齐窗口（运行后新验证记录）按设计省略——不是不确定性；Finalize 确定性 422；Draft PDF 复跑**字节级一致**。对照文件 `m158-g7-report.json` + `m158-g7-addendum.json`。

## 6. 预算与成本总账（如实，含事故）

| 账本 | 上限 | 实用 | 说明 |
|---|---|---|---|
| budget-ledger.json（主） | 96 | **94** | 79（语料/matrix/synthesis）+ 15（事故：--continue 首启 ledger env 顺序 bug，旧账本继续烧到 94 才被杀——Dev #1 快照时点为 79，事故记录原写 +1 系低估，此处更正） |
| budget-ledger-p-tail.json（Dev #1） | 72 | **72** | 写作/审稿/修订 6 轮 + recheck 硬停 |
| n1/n2/backfill/buildcheck/g7 绊线 | 各 1 | **0** | 全部零模型实证 |
| **会话合计** | 授权 168（96+72） | **166** | tokens：in 906,919 / out 93,504 / cacheR 另计；list-price ≈ $3.81（Coding Plan 边际 $0） |

无预算硬顶突破（94≤96、72≤72、166≤168）；事故消耗 15 次如实单列不剔除。

## 7. 本轮工程交付（源码）

- **零后端 src 变更**（生产 Gate/规则/阈值逐字节未动——本轮全部阻断是材料/预算层，非产品 bug；units rule 4 缺口经 Phase C 审计维持 M15.6 边界，见 `PHASE_C_UNITS_CLAIM_AUDIT.md`）。
- scripts/（可绝对路径复跑）：`m158-p-survey-e2e.mjs`（真实全链驱动 + crash journal + --continue）、`m158-n-negative-e2e.mjs`（变异引擎 + 双向 sha256 manifest + 机器断言）、`m158-h-author-decision.mjs`（A1-A5 断言族，本轮未获预算执行）、`m158-g7-reproducibility.mjs`、`m158-p-fulltext-backfill.mjs`（产品 attachManualFullText 通道 + export 镜像重写）、`m158-p-preground.mjs`（与 evidence.ground_claims 同构）、`m158-p-buildcheck.mjs`。
- 外部数据根全量产物清单见 `D:\PaperTeamData\M15\M15_8\`（预登记/BCG/账本/轨迹/N-H-R-G7 报告/驱动日志）。

## 8. 测试、提交与远程收口

- 本地：backend typecheck ✓ / build ✓ / 全量 vitest **4341 passed / 0 failed / 42 skipped（exit 0）**（基线与终态两次同口径，`logs/baseline-full-tests.log` + `logs/final-full-tests.log`）；frontend typecheck ✓。
- 提交链：`9eef50a`（P 驱动）→ `bafb0db`（驱动族）→ 收口提交（本报告 + PROJECT_STATUS）。
- CI / Linux Integration（最终 HEAD `2099673`，2026-10-26）：**CI success（run [40349628284](https://github.com/JiahongXu88/PaperTeam/actions/runs/40349628284)，attempt 1，7m35s）+ Linux Integration success（run [40349628145](https://github.com/JiahongXu88/PaperTeam/actions/runs/40349628145)，attempt 1，10m37s）**。工作树 clean，HEAD == origin/main == `2099673f8d770c34839339d94c02dd6f098dae5e`。

## 9. 下一轮最小必需事项（诚实清单）

1. **用户授权的续跑预算**（P 修订闭环距收敛 2 条 claim；projectId p-6f05e6980fda journal 可 --continue 续跑；预计 1-2 轮 review+revise ≈ 8-15 调用）。预登记硬顶已被遵守到停止——续跑属新一轮授权，不自批。
2. **arXiv 全文获取的工程加固**（产品级）：网络出口对 arXiv PDF CDN 的长波节流（undici 形态被节流、curl 可达）——建议 ProviderHttpClient 增加 curl 子进程回落或 export 镜像自动切换 + 长退避 sweep；这是材料层主因的根治项。
3. H 活体腿（预算 8-12）+ N1 fresh reviewer 检出腿（3 调用）补齐 G5/G4 至全绿。
4. units 模式 rule 4（M15.6/M15.8 双轮确认的边界）：author 模式 claim-audit 抽取契约的授权与预算决策（每单元 +1 调用）——产品决策非工程缺陷，如实保留。
