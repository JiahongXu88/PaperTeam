# M16 — 学术审稿有效性与目标期刊质量判断：最终报告

- 日期：2026-11-02 · 执行：Claude（Opus 5.5）· 起点 `75374c8`
- 根因审计：`M16_REVIEW_VALIDITY_ROOT_CAUSE.md` · 基准与冻结协议：`M16_BENCHMARK_AND_PROTOCOL.md`
- 证据：`D:\PaperTeamData\M16\AcademicReviewValidity\`（`PROTOCOL.md` + `PROTOCOL.sha256`、`DEVIATIONS.md` 5 条、`budget/calls.jsonl`、`C/{single-pass,judge-*,survey-*,sealed-metrics}.json`、`C/production/<case>/{run-result.json,calls/,artifacts/}`、`E/` 工程门日志）

> **M16 总状态：EVALUATION_BLOCKED**（按冻结协议 §8：裁判区分力 V 未通过 → 「问题检出能力」类结论无有效测量）
> **Target Journal Academic Quality：EXTERNAL_VALIDITY_LIMITED**

## 1. 结论（先读这里）

1. **M15 的两个报警主要是测量问题。** D2 的 −6pp 可逐字复算（A 71.1% / B 65.1% / −6.0pp [−13.4, +2.5]），但它比较的是两个单次 Prompt，从未经过 PaperTeam 生产 Reviewer；输入截断 40k（12/12 篇，平均截掉 28%）；类别级召回无区分力——不读论文、恒输出最常见 8 类的平凡基线得 83.2%，高于两臂。D3 无量表 / 极性错误，但 84% 参考为负，常数 −1 即得 84% 符号一致。
2. **模型维度打分偏正向是真实的（REPLAY_CONFIRMED，含全新平衡样本）。** SurveyReview 正 / 负参考各 4 篇的新样本（22 个维度，参考均值 +0.05）上，模型只把 14% 的维度判负，审稿人判负的维度只有 27% 被判负（posRecall 100%，balanced accuracy 0.64，MAE 0.91）；按预注册规则「宽松复现」。这与 SurveyReview 原论文中零样本前沿模型普遍对齐差一致。
3. **原子级「问题检出」在本轮无法有效测量。** 用同模型族盲评裁判把 AI 条目与真实人类原子意见配对：不读论文的通用套话 G0 得 27.9%，全文单次 LLM 31.3%，差 +3.5pp [−8.2, +13.5]——CI 含 0，预注册的指标有效性门 V 不通过。人类意见中相当一部分本身是通用批评（「novelty limited」「only one dataset」），在 n = 8 上，这把指标地板抬到与模型几乎同高。
4. **PaperTeam 生产 LaTeX 链路没有已证实的信息丢失路径**（159 次历史运行 3,229 单元 0 失败；引文未定位不删 finding；无自动降级）。与单次 LLM 的对照（n = 2）被三项混杂污染（见 §3），只能作描述：生产 findings 是**单元局部、精确**的（定义自相矛盾、「首个」类过度声明、用同一 Silhouette 既调参又评估），人类审稿人主要提**整篇层面的缺口**（缺强基线、参数如何设置、相关工作不足），LaTeX 链路没有整篇审稿 pass（跨章一致性调用每章只看 1,200 字）。
5. **唯一实施的产品改动是展示限定**（预注册规则，S 结果触发）：目标期刊评估中模型 rubric 给出 STRONG / ADEQUATE 时，`uncertainty` 加入「正向判断不表示达到该刊学术要求」及 M16 数字；`benchmarkProvenance` 引用 M16。不改任何 verdict / passed / 门禁 / EditContract 语义（单测断言）。**没有改动生产审稿检出行为**（协议 §2 预先声明，封存集只跑一次，事后改动本轮无法验证）。

## 2. 预注册对照结果（封存集：CoCoReviewBench ICLR 2025，8 篇，Accept / Reject 各 4，人类弱点意见 15.8 条 / 篇）

同模型 `zai-coding-cn/glm-5.3`；主指标 recall@10 = 前 10 条覆盖的人类原子意见比例（裁判 = AI_JUDGED_AUXILIARY，GLM 同族，匿名乱序盲化）；论文级配对 bootstrap 95% CI。

| 臂 | recall@10 | 被匹配条目率（精度下界代理） | 类别级召回（M15 口径） |
|---|---|---|---|
| G0 通用套话（不读论文） | 27.9% [17.7, 39.4] | 33.8% | — |
| Atrunc（D2 臂 A，前 40k） | 25.7% [17.3, 35.0] | 38.6% | 76.1% |
| Afull（同 Prompt，全文） | 31.3% [27.1, 36.1] | 41.9% | 74.0% |
| Bfull（证据纪律，全文） | 20.0% [16.2, 24.4] | 32.1% | 76.8% |
| 平凡 top-8 类别基线 | — | — | **87.4%** |

| 预注册比较 | 差值 | 判定 |
|---|---|---|
| V 裁判区分力 Afull − G0 | +3.5pp [−8.2, +13.5] | **FAIL**（CI 含 0）→ 检出能力结论 EVALUATION_BLOCKED |
| H1 输入保真 Afull − Atrunc | +5.7pp [−1.6, +13.2] | INCONCLUSIVE（且 2/8 篇短于 40k，两臂输入相同） |
| H2 证据纪律 Bfull − Afull | −11.3pp [−14.8, −7.2] | CI 不含 0，但测量工具未过 V；另有替代解释：证据纪律让条目更具体，更少命中人类的笼统意见。**不作「证据约束损害检出」的结论** |

其他：Bfull 引文逐字可定位 97.4%（可定位 ≠ 正确）；只有 1 条自报 INSUFFICIENT_EVIDENCE。成本（8 篇合计）：Afull 9 次调用、输入 87k / 输出 5.6k token、112 s；Bfull 9 次、107k / 10.2k、161 s（输出约翻倍，与 M15 一致）。严重度一致性：参考无严重度 → NOT_EVALUATED。

## 3. 生产链路臂（n = 2，描述性）

| 篇 | 生产 findings（major / minor；build 类） | 调用 / 时长 | 生产 recall@10 / 全部 | Afull recall@10 | Bfull recall@10 |
|---|---|---|---|---|---|
| X7eAhXcps1（accept，8 条人类意见） | 55（10 / 45；build 21） | 24 次 / 11.1 min，输出 34k token | 0% / 0% | 37.5% | 25.0% |
| w5h443GIGo（reject，27 条） | 50（10 / 40；build 10） | 17 次 / 7.2 min，输出 23k token | 11.1% / 25.9% | 44.4% | 29.6% |

单元覆盖 24/24、17/17，0 失败调用；Gate / QualityReport 正常产出。**此对照不能用来判断生产链路优劣**，三项混杂均已在评分前记入 DEVIATIONS：
1. **适配器输入保真**：M15 `md_to_tex.mjs` 把行内数学 `$…$` 当普通文本转义，生产 Reviewer 读到的是 `\$\mu\_k\$` 之类的字面串，21 / 10 条 findings 花在这些转换伪影上（含 3 条 major）。事后剔除 build 类的前 10 条（POST_HOC）结果不变：0% / 11.1%。
2. **语言**：生产 findings 用中文写，人类参考与单次臂是英文——跨语言匹配可能不利于生产。
3. **条目数与口径**：生产 50–55 条按严重度取前 10；单次臂每篇 ≤ 10 条。

丢失路径取证：单次臂覆盖、生产未覆盖的人类意见（X7e：H4 / H5 / H8；w5h：8 条）全部是整篇层面的「缺对照 / 缺参数指导 / 基线弱 / 相关工作不足」类。生产各单元输出中没有对应陈述——是**审稿粒度**不覆盖，而不是 findings 被 schema / parser / 聚合删除（单元输出逐条可查：`C/production/<case>/calls/*.output.txt`）。生产独有覆盖 w5h 3 条（H10 / H15 / H27）。

## 4. 能力边界与产品结论

- **已证实缺陷（L1）**：确定性证据链路不变；本轮不涉及。
- **AI 学术风险（L2）**：原子级检出能力在本轮无有效测量（V 失败），无法给出可信的召回 / 精度数字；既有 DEV 证据（M15.12 / 13）显示 PDF 链路的整篇 pass 优于逐节缺省，但不显著优于强单次 Prompt。
- **主观维度判断**：系统性偏正向（全新平衡样本复现）。产品已把它标为「模型意见（未校准）」且不进结论；本轮加了正向判断的具体限定。
- **目标期刊层**：全部外部证据是英文 ML 会议 / 综述评审；CJIG 等中文期刊主观学术质量 = EXTERNAL_VALIDITY_LIMITED，不升级。
- **是否需要新增人工评审：本轮否。**

## 5. 下一步（唯一）

**停止本轮模型 / 架构改造；保留现有生产审稿设计。** 唯一明确的外部依赖：一组**规模足以压过通用意见地板**的独立人类参考——要么目标中文期刊的真实审稿意见（含拒稿），要么英文基准上 ≥ 30 篇且按「具体性」筛过人类意见的子集——用于先让 V 通过，再谈 LaTeX 链路是否需要整篇审稿 pass。没有这组参考之前，任何「检出能力提升」都不可证。若将来复测生产 LaTeX 链路，必须先修 MD → LaTeX 适配器的数学转义，并统一评审输出语言。

## 6. 预算与运行账

| 项 | 实际 / 上限 |
|---|---|
| 真实付费模型调用（含生产子调用、裁判、重试、预检） | **87 / 120**（预检 2、单次臂 26 = 24 + 2 次解析重试、生产 41、裁判 10、S 8；0 次调用错误） |
| 完整生产评估运行 | 2 / 2 |
| case-arm | 34 / 36 |
| token（账本记录） | 输入 641k、输出 86k、缓存读 1.59M；订阅渠道，**实际费用未知** |

封存集只运行一轮；没有替换样本、没有在结果后改 Prompt / 裁判 / 指标。

## 7. 工程与 Git

见仓库提交与本节附录（`E/gates.txt` 为原始门日志）。改动：`backend/src/target/journal/assessment.ts`（展示限定 + provenance）、`backend/test/target/journalAssessment.test.ts`（正 / 反 / 无 rubric 三态 + 结论不变 + 无 passed）、`scripts/m16-review-validity/*`、本目录三份报告。前端未改（M15.19 遗留 Vite 进程 25192 / 14800 仍在监听前端源码并向 `M15_19/e1/vite.log` 等追加 HMR 日志；本轮不改前端，未写入该日志，进程非本轮启动、未终止）。

### 工程门（2026-11-02，本机实测；日志 `E/`）
| 门 | 结果 |
|---|---|
| 后端 typecheck / build | PASS / PASS |
| 后端全量测试（`vitest --maxWorkers=4`） | 429 文件通过、26 跳过；4,710 用例通过、47 跳过、0 失败 |
| 前端 typecheck / 测试 / build | PASS / 380/380 / PASS |
| `git diff --check` | PASS |
| 浏览器 E2E `m15-target-journal.spec.ts`（隔离 scripted 栈 :3100 / :5191） | J1–J3 **3/3 通过** |
| 浏览器 E2E `m15-quality-report.spec.ts` | NOT_RUN（需另一 scripted 审稿配置；本轮未改其覆盖代码） |
| 定向单测 `journalAssessment.test.ts` | 22/22（新增 1：正向 rubric 加限定 / WEAK 与无 rubric 不加 / 结论不变 / 无 passed） |
