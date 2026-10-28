# M15.8.4 — Evidence-Grounded Quality Convergence

- 日期：2026-10-28
- 基线：`961544f063f9a2d932df81e2ff66645215f5454b`（main == origin/main，clean；本轮零 backend/src 变更，新增 1 个操作者脚本）
- 数据根：`D:\PaperTeamData\M15\M15_8\M15_8_4\`（Phase A 逐项账本 `phase-a/CLAIM_LEDGER.md`、p32 账本、E020/E021 采证报告、run 证据快照 SHA256 manifest）
- 裁决：**M15_8_4_PARTIAL（P = 语料结构性上限 @ 32/32）**——真实生产 Gate 仍未 PASS（r16：7 opaque + 3 gate major）、无新 Final；**核心结论：现有语料状态（6 篇 fulltext-basis 源 + 21 条 verified evidence）不能支撑该生产 Quality Gate 对本综述的完全证据绑定要求**，缺失材料清单见 §4。M15 保持 **INCOMPLETE**。

## 0. 一屏结论

按任务书拒绝「批量披露」与「全量重研」两条捷径，走真实质量路线：Phase A 零模型逐项账本把 r14 的 5 opaque + 2 major 精确定性（1 条证据检索失败可补、1 条真实证据合法缺失、2 条行文口径问题、其余为分类器口径 × basis 闸门）；Phase B 经产品管道定向补证 **E020（S001 指标统一化史，judge=supported）/ E021（S001 指标互补性，judge=supported）**；Phase C/D 续跑中 Writer 实质增写了有据的指标比较内容（r15 E021 双绑定 **SUPPORTED**——深度 major 的实质素材落地）并对齐了口径不一致。但 r15→r16 暴露**硬核**：剩余 7 条 opaque claim 的支撑材料全部位于 basis 受限源（S003/S004/S009/S010/S011/S022），其中 S011 连合法 OA 都不存在——在本语料状态下**永不可补证**；同时审稿新发现「披露限定语高频重复形成模板化痕迹」的 style major（反向印证任务书禁批量披露的先见）。连续两轮同根因无实质进展（Phase D 停止条件触发），如实终止。

## 1. Phase A 逐项账本（零模型，`phase-a/CLAIM_LEDGER.md`）

| Claim | 定性 | 处置与结果 |
|---|---|---|
| c-008ccd7c3300（lealtaixe/MOTChallenge/演进） | 证据检索失败（basis 闸门；真实支撑在 S001:SEC05） | E020 落地（judge=supported）；r16 词面绑定未命中（claim 重抽措辞漂移）——内容支撑已在库，绑定待措辞对齐 |
| c-5c87a171ea04（wernholm 计算效率定位） | **真实证据合法缺失**（S011 无 OA，M15.8.1 OpenAlex 定论） | 永不可补证；ladder（弱化已到头→删除或 Author Decision） |
| c-a4cbf906eee8（检测感知归类，两节口径不一） | 真实行文不一致（审稿成立） | 按审稿处方对齐（一致性修复，非批量披露） |
| c-349031b82296（cazila 比较「实时」） | 稿件措辞超出证据（E019 不含实时结论） | 对齐 E019 范围；**数字复述不可行**（数字 claim 需 direct 级，E019 为 partial 且 S022 basis 受限不可重采） |
| c-72c973b78e7a（kirillova 归类+覆盖面） | 分类器口径 × basis + meta 判断 | 按审稿处方维持类别级定位 |
| MAJOR-fact（口径不一致） | 成立 | r15 起对齐 |
| MAJOR-academic（单源比较/深度） | 成立 | E019 定性扩写 + E021 实质比较素材（r15 双绑定 SUPPORTED） |

## 2. Phase B/C/D 执行（p32：2 preground + 30 run = 32/32）

- **Preground（2 调用）**：E020/E021 均 judge=supported、quote=exact、metadata=match（`phase-b/preground-report.json`）。操作者起草 requests（claim 措辞取自 chunk 忠实概括）+ 产品三段核验——judge 可拒，非制造证据。
- **Run w-590dd2e3e2bd（30 调用，10 min）**：front 全指纹复用；r15 复审（E021 双绑定 SUPPORTED ✓；但同时 7 opaque——审稿重抽方差 + 披露限定语被新 academic major 批为模板化）；r15 修订（rev16）→ r16 复审（7 opaque 同硬核 + 3 major）→ REGRESSED → revise_more → **32/32 硬停**（run failed；无新 Draft 构建，最新合法 Draft 仍为 rev14）。
- **Phase D 停止条件分析（按任务书要求）**：r14(5+1T/2M) → r15(7/6M) → r16(7/3M)——同根因连续无实质进展。逐条核对 r16 硬核：**4 条 taxonomy/归因 claim 的源全部 basis 受限（S009/S011/S003 + 合并条）、2 条绑定 partial 证据（E019/E002）且其源不可重采、1 条词面绑定漂移**。这不是 Review/Planning/Evidence Supply 的循环缺陷（r15 修订确实执行且 E020/E021 实质生效），而是**语料证据供给的结构性上限**。

## 3. 质量变化的真实评估（非 Gate 分数）

- **真实提升**：指标互补性/适用边界的实质比较内容进入 decomposed-metrics（E021 SUPPORTED 绑定 ×2）——这正是任务书 Phase C 点名的「MOTA、IDF1、HOTA 互补性和适用边界」；基准章节获得 S001 逐字历史证据（E020）；两节口径不一致修复；cazila 叙述对齐证据范围。
- **新发现的质量问题**：披露限定语高频重复（r15 academic major）——M15.8.3 披露指引的过度应用副作用；r15 修订已开始收敛该问题。
- **未解决**：§4 硬核清单（语料上限）。
- 过度删减/空泛化检查：未见（rev16 章节长度与引文保持；Draft rev14 为最新合法构建）。

## 4. 缺失研究材料清单（Gate PASS 的必要条件，非充分）

| 源 | 现状 | 阻断的 claim | 升级路径 |
|---|---|---|---|
| S004 dendorfer2020motchallenge | abstract_only basis | MOTChallenge 平台/协议/排行榜具体内容 | matrix 条目 fulltext 重建 |
| S009 sanmiguel2022detection | abstract_only | 检测感知/比较公平性归类与机制 | 同上 |
| S003 kirillova2024into | abstract_only | 恶劣大气条件取向 + 覆盖面判断 | 同上 |
| S022 cazila2025comparison | abstract_only（E019 partial） | SORT/DeepSORT/JDE 比较的 direct 级证据 | 重建后重采（quote 含数字逐字） |
| S010 karunasekera2019 | abstract_only（E002 partial） | 两步范式代表（direct 升级） | 同上 |
| S002 bashar2022pursuit | abstract_only | 学术深度 major 的理想素材（§5 指标专章） | 同上 |
| **S011 wernholm2025fast** | **metadata_only——合法 OA 不存在** | 计算效率维度定位 | **无路径**（仅 bib 标题自证；需 Author Decision 接受定位性表述或删除） |

升级 = M15.8.2 定义的完整链（refresh → matrix 16 条重建 → synthesis → outline → 重写 ≈55-70 调用）；S011 为永久例外。

## 5. 预算与诚实边界

| 账本 | 上限 | 实用 | tokens | list |
|---|---|---|---|---|
| p32 | 32 | **32** | 见 `phase-a/final-p32-ledger.json` | 记录在账本 |
| N1/H | 8/12 | 0/0（前置未动） | — | — |

16 轮 gate 全部如实 FAIL（零 false_ready）；证据库 21 条全 verified（E020/E021 quote=exact judge=supported）；无守卫放松、无批量披露（披露仅用于审稿处方的单条一致性修复，且其副作用已被审稿识别并回修）。

## 6. 结论

- G1/G2（真实 PASS + Final）未达成；本轮**排除了**「再修几轮就能过」的可能性——剩余阻断是语料证据供给上限，不是工程或收敛缺陷。
- 两条可请求的后续授权（互斥或组合）：
  1. **完整语料升级 ≈55-70**（§4 清单落地；S011 除外走 Author Decision）——唯一能让本综述在本 Gate 语义下 PASS 的路径；
  2. **接受 Draft 终态**：以 rev14 Draft + 21 条 verified evidence + 本账本作为 M15 的诚实交付（Gate 语义保持不动）。
- M15 总目标：**INCOMPLETE**。

## 7. 测试 / Git / CI（回填）

- 本地：backend `tsc --noEmit` 0 错（本轮零 backend/src 变更；新增 scripts/m1584-preground-targeted.mjs）；`git diff --check` clean。
- Git：`961544f → d52f32f` 直推 main；工作区 clean；HEAD == origin/main。
- **CI success（run 40621230913，attempt 2，4m17s；attempt 1 失败=compose smoke 的 nginx 就绪竞态 flake——backend 5.5s 即 healthy 后 web 容器启动仅 66ms 即被 curl，连接重置；与本轮改动无关（文档+独立脚本），重跑即过）+ Linux Integration success（run 40621230853，3m48s）@`d52f32f`**。
- M15 总目标：**INCOMPLETE**（本报告不以机制验证/质量增量替代最终产品目标）。
