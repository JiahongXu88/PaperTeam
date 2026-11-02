# M16 收口 — 最终裁决

- 日期：2026-11-02 · 执行：Claude（Opus 5.5）· 起点 `bdedfa3`
- 本文是 **M16 的延续与收口**（原状态 EVALUATION_BLOCKED），不开启 M17、不开新的 M16.x。
- 分报告：`M16_REVIEW_INPUT_FIDELITY_CLOSURE.md`（A）· `M16_BENCHMARK_VALIDITY_CLOSURE.md`（B）
- 证据（仓库外，不上 Git）：`D:\PaperTeamData\M16\ReviewFidelityAndBenchmark_Closure\`（`PROTOCOL.md` + `PROTOCOL.sha256`、`MANIFEST.json`、`DEVIATIONS.md`、`STOP_DECISIONS.json`、`budget/calls.jsonl`、`A/`、`B/`、`C/`、`E/`）
- M15 / M16 历史报告与冻结数据未改动；历史错误只在本轮 `DEVIATIONS.md` 追加说明。

## 0. 裁决

| 项 | 裁决 |
|---|---|
| **M16 CLOSURE** | **BENCHMARK_VALIDATED**（评测机制成立；Reviewer 对照无已证实增益） |
| INPUT_FIDELITY | Markdown（benchmark 适配）**PASS** · 原生 LaTeX **PASS** · PDF **PARTIAL**（文本层抽取丢公式结构，已有 FORMULA_UNVERIFIED 标注） |
| BENCHMARK_VALIDITY | **PASS**（held-out 16 篇；G1 +17.3 [10.8, 24.5] · G2 +11.7 [3.8, 18.8] · G3 +18.1 [9.2, 26.4]） |
| REVIEWER_COMPARISON | **NO_EVIDENCED_GAIN**（生产 Reviewer 真实运行 2 次，n = 2 只描述；两个方向都没有稳定差距） |
| 整稿缺口假设 | **NOT_SUPPORTED**（预注册 D 门槛未达；n = 2，总体层面仍未知） |
| PRODUCTION_CHANGE | 检出逻辑 **NOT_APPLIED**；输出语言契约修复 **APPLIED**（见 §4，不属于检出改造） |
| TARGET_JOURNAL_ACADEMIC_VALIDITY | **LIMITED**（外部证据只有英文 ML 会议评审） |

三条区分：**评测机制成立 ≠ Reviewer 有效**；**Reviewer 与人类关注点一致 ≠ 该刊投稿 / 录用保证**；**单个匹配指标上升 ≠ 论文质量上升**。

## 1. 公式损坏在哪里发生（问题 1）

在仓库外的 benchmark 适配器 `D:\PaperTeamData\M15\QualityGateCalibration\scripts\md_to_tex.mjs` 的 `markdownToLatex → bold → esc`：对每个正文块整体转义，不识别数学。产品没有 Markdown → LaTeX 路径，生产 LaTeX 链路对源码逐字直通，所以 Reviewer 读到 `\$\textbackslash{}mu\_k\^{}n\$`。新适配器 `scripts/m16-closure/md-to-tex-fidelity.mjs` 修复后，经真实 `review.run`（scripted，零模型）回放：两篇 M16 论文的 Reviewer 单元输入数学 402/402、212/212 逐字保留（旧 67/402、61/212），转义残留 1,042 / 666 → 0，正文数字与 `[n]` 100%，单元覆盖率 1。仍受限：图片内容（显式占位）、HTML 表格合并单元格（展平）、PDF 入口（文本层抽取）。

## 2. 新裁判能否区分（问题 2）

能。held-out 16 篇（Accept / Reject 各 8，冻结前未运行任何模型），主指标 hybridSpec@10：CORRECT 17.3%，MISMATCHED 0.0%，G0 0.0%（按构造），ATTACK（关键词填充套话）5.7%；只看裁判时 G0 9.0%、ATTACK 9.9%。三项预注册对照全部 CI 下界 > 0 且均值 ≥ 10pp。ATTACK 对照刚过 MID，说明廉价刷分仍有小幅残余；该尺子不能分辨 < 10pp 的系统差异。详见 B 报告 §4。

## 3. 公平对照：生产 Reviewer 是否真的运行（问题 4）

**是**：当前 main 的 LaTeX `review.run → quality.gate`（published_paper_assessment），真实服务链与 Pi runtime、产品 Settings 模型 `zai-coding-cn/glm-5.3`（启动时校验）、保真适配器输入、英文输出指令。选篇按预注册规则（held-out 每层第一篇且 dry-run 单元数 ≤ 18）：JWtrk7mprJ（accept，17 单元）、jbfDg4DgAk（reject，15 单元）。对照臂 S = 同篇 B 的 CORRECT 输出。同一 JUDGE_SYSTEM（与 B 逐字节相同），S 与 P 条目混合匿名乱序，每篇 1 次裁判。

| 篇（SPECIFIC 意见：整稿 / 局部） | 臂 | 条目 | hybridSpec | judgeSpec | SPECIFIC 整稿 / 局部（judge） |
|---|---|---|---|---|---|
| JWtrk7mprJ（8：4 / 4） | S@10 单次全文 | 10 | 25.0 | 25.0 | 25.0 / 25.0 |
| | P@10 生产（严重度前 10） | 10 | 0.0 | 0.0 | 0.0 / 0.0 |
| | P@all 生产全部 | 42 | **37.5** | 50.0 | 25.0 / 75.0 |
| jbfDg4DgAk（8：8 / 0） | S@10 | 10 | 12.5 | 12.5 | 12.5 / — |
| | P@10 | 10 | 0.0 | 0.0 | 0.0 / — |
| | P@all | 37 | 0.0 | 0.0 | 0.0 / — |

成本（物理调用 / 输入 / 输出 token / 墙钟；金额为模型目录估价，订阅渠道实际费用未知）：

| 篇 | S | P |
|---|---|---|
| JWtrk7mprJ | 1 次 / 16.3k / 0.6k / 13 s / ≈ $0.025 | 18 次（0 失败）/ 85.1k（+ 缓存读 597k）/ 22.6k / 7.2 min / ≈ $0.37 |
| jbfDg4DgAk | 1 次 / 13.1k / 0.7k / 17 s / ≈ $0.021 | 14 次（0 失败）/ 67.5k（+ 缓存读 308k）/ 18.3k / 5.6 min / ≈ $0.26 |

观察（描述性）：
1. **生产全部 findings 覆盖的具体意见可以多于单次全文**（JWtrk7mprJ 37.5 vs 25.0；多出的是局部意见，整稿意见两臂都是 1/4），但成本约 14–18 倍调用、20–33 倍墙钟、12–15 倍估价。
2. **生产「严重度前 10」两篇都是 0**：与人类意见对得上的生产条目全部是 minor，major 是局部的数学 / 算法问题。
3. **jbfDg4DgAk 的 0 不等于漏检**：人类意见几乎全是整稿层面的「缺少新基线（SWEET / EWD …）」「新颖性不足」，且 H5–H8 是参考文献列表碎片（gold 噪声）。生产的 3 条 major 是源稿可逐字核对的数学 / 算法问题，其中「Eq. (1) 与 Algorithm 3 的 z 分数分母为 γ√((1−γ)T)，单比例检验应为 √(γ(1−γ)T)」经执行者对源文逐字核对属实。人类参考没有这一条，匹配指标无法给分。这一条需要公式完整进入 Reviewer 才可能发现（A 的直接收益）。
4. **整稿问题**（强基线、实验充分性、创新性证据）：两篇共 12 条 SPECIFIC 整稿意见，S 命中 2 条、P 命中 1 条；单次全文命中、生产没命中的 SPECIFIC 意见只有 2 条（均为 QUAL-EXP）。不构成「生产结构稳定漏掉整稿问题」的证据。

**REVIEWER_COMPARISON = NO_EVIDENCED_GAIN**：n = 2，两篇方向相反；不宣称任一方优越。

## 4. 生产改造（问题 5）

- **检出逻辑：NOT_APPLIED，因为证据不支持，不是被前置条件阻断。** A 和 B 都通过了；D 的预注册条件是「两篇 P@all 均比 S@10 低 ≥ 10pp，且漏掉的 ≥ 70% 为整稿意见」，JWtrk7mprJ 上 P 反而更高，条件不满足。另外剩余预算（20 次）不足以对任何检出改造做一次同口径验证，所以也没有为凑臂数实现整稿复核 shadow 臂。
- **输出语言契约（APPLIED，不属于检出改造）**：`agents/ReviewerService.ts` 的 unit 模式 prompt 原来只写「稿件语言以该单元原文为准」，缺少 digest 模式已有的英文输出指令（M9.7.4 契约），导致英文论文在长文档模式下产出中文 findings（M16 生产臂的语言混杂即源于此）。修复后英文稿件追加 `UNIT_EN_OUTPUT_DIRECTIVE`；中文与未指定语言的 prompt 逐字节不变（单测断言）。本轮两次生产运行 79 条 findings 中 76 条为英文（M16 首轮全部为中文）。影响：英文稿件的 unit 请求指纹改变 → 升级后首轮增量复用失效、重审一次。

## 5. 可靠性语义是否保持（问题 6）

- L0–L4 QualityReport、EditContract、HITL、目标期刊官方规则 / Author Decision、UI：本轮**未修改**对应代码；后端全量测试与前端测试全部通过（§7）。
- 改动文件：`backend/src/agents/ReviewerService.ts`（unit prompt 英文输出指令，+1 导出常量）、`backend/test/review/reviewPurpose.test.ts`（+1 用例）、`backend/test/scripts/m16MdToTexFidelity.test.ts`（新增）、`scripts/m16-closure/*`（评测工具，不进产品）、本目录三份报告。
- LLM 推断仍只是 L2；本轮没有任何地方把裁判一致或多 Agent 一致升级为 L1。

## 6. 能力边界与下一步（问题 7）

可以用工程 / 确定性证据关闭的：
- benchmark 输入保真（A，PASS）；
- 评测量具对「不读论文 / 错配 / 关键词填充」的区分力（B，PASS，≥ 10pp 量级）；
- 生产链路无截断、无静默丢 finding（M16 已证，本轮两次运行 32 次调用 0 失败、覆盖率 1）。

仍需外部参考才能验证的：
- **问题是否真实**（而不只是与人类关注点一致）：参考不完备，生产独有的可核对问题（如 z 分数分母）匹配指标给 0；
- **严重度校准**（参考无严重度）；
- **中文期刊 / 其他学科**的学术质量判断；
- **生产 vs 单次的总体差异**（n = 2 只够描述）。

**下一步唯一的最小动作（不新开里程碑、不刷 Prompt）**：若要回答「生产 Reviewer 是否优于单次全文」，用本轮已冻结的尺子（同一 PROTOCOL、同一 JUDGE_SYSTEM、同一术语门）在**新的** held-out 上跑 ≥ 12 篇生产工作流（约 200 次调用），并预先固定「生产独有、可在原文逐字核对的问题」的确定性核验项作为第二指标。没有这笔预算与新样本，就保持现有生产审稿设计不变。

## 7. 工程门与交付

本机实测（2026-11-02；原始日志 `E/`）：

| 门 | 结果 |
|---|---|
| 后端 typecheck / build | PASS / PASS |
| 后端全量测试（`vitest --maxWorkers=4`） | 两次全量运行都**不是一次全绿**：第 1 次（与前端测试 / 构建并发）3 个文件 5 s 超时（`zaiApiChannel`、`unitContextReliability`、`unitContextSnapshot`）；第 2 次（无并发）这 3 个通过，另有 1 个失败：`ingestion/doclingReal.smoke`（真实 Docling，负载下 880 s 后 ingest=failed）。4 个文件单独重跑全部通过（69/69、2/2）。第 2 次：429 文件通过、26 跳过；4,717 用例通过、47 跳过、1 失败（上述 Docling smoke） |
| 定向单测 | `m16MdToTexFidelity` 7/7；`reviewPurpose` 19/19；`test/review/` 67 文件 800/800 |
| 前端 typecheck / 测试 / build | PASS / 380/380 / PASS（前端源码未改） |
| 文档链接检查 `scripts/check-docs-links.mjs` | OK（426 个） |
| `git diff --check` | PASS |
| 浏览器 E2E（隔离 scripted 栈 :3100 / :5192，零模型） | `m15-quality-report.spec.ts` R / V **2/2**；`m15-target-journal.spec.ts` J1–J3 **3/3**（M16 首轮未运行的 quality-report 本轮已运行） |
| 零模型输入保真回放（真实 `review.run`，scripted） | 4 次 dry（2 篇 × 旧 / 新适配器）+ 8 次 dry 选篇；见 A |

预算与运行账（`budget/calls.jsonl`）：

| 用途 | 调用 | 输入 / 输出 token |
|---|---|---|
| B DEV 裁判 | 4 | 11.9k / 2.2k |
| B held-out 生成（CORRECT） | 16 | 244.9k / 10.2k |
| B held-out 裁判 | 16 | 43.0k / 11.2k |
| C 生产工作流 JWtrk7mprJ | 18 | 85.1k / 22.6k（+ 缓存读 597k） |
| C 生产工作流 jbfDg4DgAk | 14 | 67.5k / 18.3k（+ 缓存读 308k） |
| C 裁判 | 2 | 7.0k / 0.8k |
| **合计** | **70 / 90**（0 失败、0 重试） | 459k / 65k；目录估价 ≈ $1.17（订阅渠道实际费用未知） |

完整生产工作流 2 / 2；新增人工标注 0；held-out 隔离：冻结（PROTOCOL sha256 `41bc8657…`、MANIFEST 含 16 篇 MD sha256）后只运行一轮，DEV 未发现实现 bug、未修改规则 / 阈值 / Prompt。
