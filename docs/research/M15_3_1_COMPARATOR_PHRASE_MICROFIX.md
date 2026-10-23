# M15.3.1 — 比较对象短语微修复(Comparator Phrase Micro-Fix)

- 日期:2026-10-23;基线 `42d76e9`(== origin/main,工作树 clean);执行 M15.3.0 裁决 **GO_ONE_FIX**。
- 性质:单点确定性微修复 + 零模型全量重放回归。零付费模型调用、零真实 Reviewer E2E;预登记 `D:\PaperTeamData\M15\M15_3_1\PRE_REGISTERED_CHECKS.md`(改码前冻结),全部中间产物在同目录 `analysis\`(仓库外)。
- 定位:**M15.3.1 回归层微修复 PASS**(已开封 SEALED 的 EXPOSED_REGRESSION 语义;不构成独立泛化证明,不等于 M15 完成,不触发 Production Gate 上线)。

## 1. 假设与单点 diff

`bindTextAtom` 行维绑定早已用 `stripComparatorPhrases` 剥比较对象,但可解释性检查(L647)直接 `distinctiveTerms(plainLatexText(scopes.window))`,比较对象方法名(如句尾 "outperforming … SimpleHGN")被当成需要由绑定单元格解释的术语 → `UNEXPLAINED_TERM` 误拒。假设:该窗口先过同一剥离即消除误拒,其余路径零改动。

```diff
-  for (const term of distinctiveTerms(plainLatexText(scopes.window))) {
+  for (const term of distinctiveTerms(plainLatexText(stripComparatorPhrases(scopes.window)))) {
```

`backend/src/review/claimCertificate.ts` 净语义变化 1 行(+1 行注释);`git diff --stat` = 2 insertions / 1 deletion。未触碰:表格候选选择、metricDistance、UNIQUE、B2(`VALUE_APPEARS_IN_OTHER_TABLE`)、B3 限定词(segmentContext 路径)、segmentContext、派生量算法、解析器、阈值、Prompt、UI。

## 2. 预登记验收条件实测(5/5 通过)

| # | 停止条件(预登记原文要点) | 实测 |
|---|---|---|
| 1 | 191 例翻转全集恰 = {N09-P01→VS, N09-P03→VC},DEV_NEW 零翻转 | **SEALED flip=2(恰为该两例),DEV_NEW flip=0**;所有非翻转案例 verdict/status/reasons/binding 逐例全同(差分脚本含绑定单元格比较) |
| 2 | 任一侧 WRONG_STRONG > 0 → 中止 | **两侧均 0**(SEALED 3 正确强判 0 错;DEV_NEW 5 正确 0 错) |
| 3 | N09-P05 保持 NOT_CERTIFIED 且 B2/B3 理由不变 | 保持 ABSTAIN/REVIEWER_SUSPECTED;`VALUE_APPEARS_IN_OTHER_TABLE:4b44c3069fef0a56,57c97dbb30f5999e` + `UNEXPLAINED_QUALIFIER:reproduced` 逐字不变 |
| 4 | 6 个既有正确强判零丢失 | SEALED N03-P02 ✓;DEV_NEW N01-P01/N01-P12/N14-P03/N02-P01/N02-P03 ✓(判定与状态不变) |
| 5 | 收益为 0 或引入新拒绝/绑定路径 → 放弃 | 净收益 +2 正确强判;两例翻转的 newBinding 与 oldBinding **同一单元格**(`['RGCN']|['DBLP','Macro-F1']=94.65`、`['RGCN']|['Freebase','Macro-F1']=48.20`),仅消除误拒理由,无新拒绝模式 |

## 3. 191 例差分(零模型,同 harness 重建 dist 重放)

- 重放口径:`D:\PaperTeamData\M15\M15_2\scripts\eval_pairs.mjs`,`M152_DIST=D:/Projects/PaperTeam/backend/dist`(本轮重建),oracle/split_lock/candidate_freeze 原封不动;命令与产物哈希见 §6。
- SEALED 93:{CORRECT_STRONG 1→**3**, ABSTAIN 84→82, NOT_INJECTABLE 8, WRONG_STRONG 0};可证召回 1/57→**3/57**。
- DEV_NEW 98:{CORRECT_STRONG **5**(不变), ABSTAIN 88, NOT_INJECTABLE 5, WRONG_STRONG 0}。
- 翻转逐条(仅 2 条,均为消除 `UNEXPLAINED_TERM:SimpleHGN`,绑定单元格不变):

| caseId | trueRelation | old | new |
|---|---|---|---|
| N09-P01 | SAME_OBSERVABLE_CONSISTENT | ABSTAIN / REVIEWER_CONSISTENT | **CORRECT_STRONG / VERIFIED_SUPPORTED** |
| N09-P03 | SAME_OBSERVABLE_CONTRADICTED | ABSTAIN / REVIEWER_SUSPECTED | **CORRECT_STRONG / VERIFIED_CONTRADICTED** |

## 4. 测试(全部确定性、合成结构,不复制 N09 原文/数值/表名)

`backend/test/review/claimCertificate.test.ts` 新增 2 个 describe 共 14 例:

- **M15.3.1 主块 8 例**:正例 VS(outperforming 句尾比较对象 → SUPPORTED)、正例 VC(surpassing + 值冲突无他表同值 → CONTRADICTED)、反例×4(无比较关系陌生方法名 DeepProp → UNEXPLAINED_TERM;并列从句他方法名 → TIED 弃判;reproduced B3 限定词不变;B2 跨表同值不变)、边界 stripComparatorPhrases 函数级不过度剥离。
- **SYNTHETIC_SANITY 6 例(S1–S6,实现前登记期望)**:数据集名在比较短语内(S1 SUPPORTED)、主语句双模型名无比较词(S2 TIED 拒绝)、句首 Compared with(S3 SUPPORTED)、vs. 缩写(S4 SUPPORTED)、两表同值(S5)、两表同值不点数据集(S6 TIED 拒绝)。

**偏差记录(S5)**:登记期望 SUPPORTED,实测 NOT_CERTIFIED(B2)。stash 基线对照证明该输出与修复前**逐字节一致**(`VALUE_APPEARS_IN_OTHER_TABLE` + `UNEXPLAINED_TERM:GraphNet`)——方向 B `headerEntityScore` 使被比较行在多表同值场景抢得 top、值冲突触发 B2,属既有"宁弃勿错"防线,与本修复零交互;期望登记时漏算该路径,已按实测修正并在用例内注明。其余 5 例一次通过。测试敏感性:基线(未修复)上正例 VS/VC 失败、反例全过——正例由本修复启用,反例均为既有行为。

- 结果:`claimCertificate.test.ts` 40/40;backend 全量 **4185 passed / 0 failed**(40 skipped 为 live smoke 设计内跳过,无 flake);`npm run typecheck`/`npm run build` 通过;`git diff --check` 干净。
- 生产 Gate 零影响:`backend/src/quality/gates.ts`(sha256 `19addc17…b92c0e`)与 `revisionTaskGate.ts`(`6d770342…f3e72b`)与预登记基线逐字节一致,未改动。

## 5. 成本

付费模型调用 **0**;全部为确定性单测与零模型回放(SEALED+DEV_NEW 重放各一次,秒级)。开发代理为 Coding Plan GLM-5.3。

## 6. 可追溯性

| 项 | 值 |
|---|---|
| 基线 commit | `42d76e9707731921774bfc083b5e1d1e3421b2b3`(预登记记录源码 sha `29050bb5…56f559b`) |
| 修复后 `claimCertificate.ts` sha256 | `f6985317347f30cebacc8ebda480a45324e42cb26c672bc4974e6b1ea795c0a1`;`dist/review/claimCertificate.js` `fc894fe3…3e74f0c7` |
| 旧基线结果 | `M15_2_1/analysis/eval_pairs_{sealed,devnew}_regression.json`(sha 前 16:`c1e71cbc5ef54a30` / `0a0b68ce646c8b10`) |
| 新重放结果 | `M15_3_1/analysis/eval_pairs_{sealed,devnew}_m1531.json` + `diff_summary.json`(逐例差分)+ `diff_replay.py` |
| 重放命令 | `M152_DIST=D:/Projects/PaperTeam/backend/dist node eval_pairs.mjs --split SEALED_FINAL --sealed-final --out …` / `--split DEV_NEW --out …` |
| 源数据 | `split_lock.json` sha256 `fa8dd338…20062`;`candidate_freeze.json` `2bda99e8…65b91e` |

## 7. 局限与下一步(仅一项建议,未获批准不实施)

- 局限:收益验证限于已开封 SEALED 的 191 计分行(EXPOSED_REGRESSION),非作者隔离 held-out;`automated_truth` 非人工金标准;泛化性未证明。
- 下一步建议(唯一,需用户批准):**M15.3.2 缩写词典候选(oa↔accuracy 等)单独回归**——M15.3.0 §5 指出其与 A 无负交互的前提是 A 先行(本修复已落地),但仍需 191 例全量 diff + TIED 风险(N03-P07)逐一核验;不建议与任何其他改动合并。
