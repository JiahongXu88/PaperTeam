# M16 后续 · 最终验收（确定性科学发现入产品 + 整稿 / 章节互补审稿验证）

**最终状态：`M16_VERIFIED_FINDINGS_AND_HYBRID_VALIDATED`**（中文目标期刊 L4 主观学术效度仍 **EXTERNAL_VALIDITY_LIMITED**）

- 日期 2026-11-02 · 执行 Claude（Opus 5.5）· 起点 `757d74b`（HEAD == origin/main == ls-remote，已核对）
- 不改写的前序报告：`M16_CLOSURE_DECISION.md`、`M16_QUALITY_GATE_CLOSURE_*.md` 等（本轮零修改）；冻结目录 `D:\PaperTeamData\M16\OriginalQualityGateGoalClosure\` 在上一轮提交后零文件变化（`find -newer` 核对）
- 分报告：[M16_VERIFIED_FINDINGS_PRODUCT_INTEGRATION.md](M16_VERIFIED_FINDINGS_PRODUCT_INTEGRATION.md)（工作包 A / D）· [M16_WHOLE_PAPER_REVIEW_OPTION_STUDY.md](M16_WHOLE_PAPER_REVIEW_OPTION_STUDY.md)（工作包 B / C）
- 外部证据：`D:\PaperTeamData\M16\VerifiedFindingsHybridReview\`（`PROTOCOL.md`、`MANIFEST.json`、`DEVIATIONS.md`、`A/` 开发回放、`B/` 选篇与尺子门、`C/` 生产 / 裁判 / 计分 / 盲化核验、`E/` 测试日志、`budget/calls.jsonl`；不含密钥）

选这个状态而不是 `…_HYBRID_INCONCLUSIVE` 的理由与边界：预注册唯一入口判定 ADOPT，任务书 G3 的「独立核验无安全回退、成本可接受」也成立，所以默认已切换；但 hybrid 只是把单元生产拉回到单次全文的水平（C − S +1.4pp CI 跨 0），不是胜过它。这个状态的意思是「hybrid 相对当前生产的采纳得到了独立验证」，不是「审稿达到期刊水平」。

## 1. Gate

| Gate | 结论 | 证据 |
|---|---|---|
| G0 基线与冻结 | **PASS** | 起点三方一致；旧报告 / 冻结目录零修改；新留出 12 篇与上一轮 12 篇零重叠、与开发回放不交叉；协议在首次模型调用前冻结（sha256 `0625463…8157`），偏差 #1–#4 均在相关数据读取之前登记 |
| G1 真实验证入产品 | **PASS（适用面窄）** | 生产入口 `evaluateProjectQualityGate` 执行 `verifyFindings`；L1 规则 `review_findings_certified` 只在证书成立 + 可信来源时 FAIL，从不 PASS；真实 HTTP 测试证明 Gate / QualityReport L1 / API / Journal Assessment `BLOCKED_BY_VERIFIED_ISSUE` 消费同一事实；0.036% 反例、约数、下界、无表引用、竞争表、转写来源全部 fail-closed；「可定位」与「已证实」分开计数。新集 520 条 finding 0 证书（详见 A 报告 §7） |
| G2 整稿候选工程可行性 | **PASS** | 不接触专家参考；输入模式（FULL_TEXT / GLOBAL_DIGEST）与字符数如实记录；失败 / 被预算拒绝如实记 failed、不影响覆盖率；恒 L2；关闭时单元 prompt 逐字节不变。开关在有效性明确之前缺省关闭，判定后才切 on |
| G3 独立评测有效性 | **PASS** | 尺子门 4/4 PASS 后才跑生产；A/B/C 配对 + 负对照 + CI + 实测成本；预注册判定 ADOPT_HYBRID_DEFAULT；盲化独立核验 SYNTH 0 REFUTED |
| G4 用户可见语义 | **PASS** | 同一 `gate.verifiedFindings` 进入 API / UI / QualityReport；L1 与转写证书分开展示；旧产物 / 未执行 → 「未评估」；无「达刊」措辞；验证不授权改稿（EditContract 未改） |
| G5 回归与交付 | **PASS（CI 见 §6）** | 见 §6 |

## 2. M15 原始五项目标：本轮证据与当前边界

| 目标 | 最新状态 | 本轮证据 | 能说 / 不能说 |
|---|---|---|---|
| Completeness | **PASS** | 新集 YiyG1tHDxq 因预算上限覆盖 17/18 → Gate 如实不完整；整稿条目不计覆盖率 | 能说「哪些正文被审过」；不能用整稿意见冒充逐章覆盖 |
| Correctness | **部分验证（提升）** | 确定性证书首次进入生产 L1 出口；历史 7 个可复算根因复核 7/7 正确、2 个自动化支持；新集产品证书 0（全部 fail-closed）；参考外盲化核验 83 条中 7 条 INDEPENDENTLY_VERIFIED / 0 REFUTED | 能说「这条数值矛盾经确定性复算成立」（作者源稿时）；不能说未证书化的 AI 意见是对的或错的 |
| Severity | **PASS（含反例，未校准）** | L1 已核验 / L2 AI 意见 / 转写证书三态分离；整稿条目强制 L2 不阻断；严重度无真值 → NOT_EVALUATED | 能说证据层级；不能说模型严重度准确 |
| Calibration / Journal Fit | **LIMITED** | 英文 ML 会议参考上尺子有区分力；中文期刊独立标签仍为 0 | 官方格式规则可判；不输出达刊判断或录用概率 |
| Revision Closure | **PASS（scripted）** | 修订 / EditContract 代码本轮未改；后端全量（含修订防越权回归集）通过 | 证书不等于授权；修改仍逐项授权 |

## 3. 冻结协议摘要

1. 选篇：CoCoReviewBench（CC BY 4.0）候选池 176 篇，按 `sha256("m16-verified-findings|id")` 排序，accept / reject 各 6，单元数 ≤ 16（v2 重算，跳过 5 篇 > 16）。
2. 顺序：`generate`（S）→ `judge1`（S + 4 负对照）→ `score-b` 尺子门（MID 10pp）→ 全 PASS 才串行生产 12 篇 → `judge2` → `score-c` → `verify-pool` / 盲写规格 / `verify-score`。
3. 判定：§5.3 唯一入口（主指标 ≥ +5pp 且 CI 下界 > 0；整稿子指标 > 0 且 CI 下界 > 0；反套话 CI 下界 > 0；安全全成立）。
4. 冻结后不改检出 / 证书 / 整稿 prompt；一次纠偏只允许修事实越权 / 假 PASS 类缺陷且不重跑。

## 4. 预算与偏差账本

| 项 | 预算 | 实测 |
|---|---|---|
| S generate | 12 | 12 |
| judge1 | 12 | 12 |
| 生产（含整稿 / 跨章 / 修复调用） | ≈ 200（单篇上限 21） | 212（单元 + 修复 192，跨章 10，整稿 10） |
| judge2 | 12 | 12 |
| **合计** | **≤ 260** | **248**（单一模型 `zai-coding-cn/glm-5.3`，Z.AI Coding Plan；未改项目缺省模型 / provider） |

估算费用 ≈ $3.0（S / 裁判 $0.52 实记；生产按同价折算，ESTIMATED）。无 infra replay，无重跑。

偏差（`DEVIATIONS.md`）：
1. `select.mjs` 读旧选篇文件的计数字段报错 → 非列表按空集（选篇前，零模型）。
2. 6 篇 accept 论文上一轮曾被零模型 dry-run → 披露，不影响留出资格。
3. M8OGl34Pmg：单元输出漂移成中文 → 9 次论断修复 → 上限用尽，跨章 / 整稿被拒；不重跑，计 C = B。
4. YiyG1tHDxq 同因（7 次修复），另有 1 单元未审；judge2 前登记「只看整稿执行篇」敏感性分析（不替代主判定）。

一次纠偏（工作包 A，冻结前、已开封开发集上）：倍数证书错误继承到点名「缺 up to 限定」的 finding → 加「finding 必须点名该表」双钥匙并回归测试。之后停止调整。

内存 / 进程：生产全程串行；每篇结束可用内存 6.9–14.8 GB（总 31.6 GB），无 OOM，node 进程数恒定 10（非本任务进程未动）；生产期间未跑全量测试。本任务启动的 E2E 后端（3100）与 Vite（5173）已在验收后停止。遗留的非本任务 Vite：PID 25192（端口 5177）、PID 14800（端口 5178），只报告、未终止。

## 5. 产品变更（本轮提交）

- `5c07413` verified-findings/v1、L1 规则 `review_findings_certified`、整稿综合通道、前端 `VerifiedFindingsPanel`。
- `1997eba` / `3a01ef7` / `29a4b23` / `19ff18c` 实验脚本 `scripts/m16-verified-findings/`（选篇修复、串行运行器、敏感性分析）。
- 本报告所在提交：整稿综合缺省 on（`PAPERTEAM_REVIEW_WHOLE_PAPER=off` 回滚）、`.env.example`、配置缺省测试、三份报告。

## 6. 测试与交付

| 项 | 结果 |
|---|---|
| Backend 全量（串行于真实运行之后，`--maxWorkers=4`，缺省切换后） | 435 文件 / 4782 测试通过（26 文件 / 47 测试 skipped，均为需真实模型或外部环境的 smoke）；日志 `E/backend-test-final.log` |
| Backend typecheck / build | 通过 |
| Frontend 测试 | 41 文件 / 384 测试通过 |
| Frontend typecheck / build | 通过（仅 chunk 体积提示） |
| 浏览器 E2E（Chrome，scripted runtime，隔离目录） | `m15-quality-report` 2/2、`m15-target-journal` 3/3 通过 |
| 修订防越权回归 | 包含在后端全量中通过；修订代码本轮未改 |
| `git diff --check` | 干净 |
| CI / Linux Integration | 推送后核查，结论见提交后的首屏摘要（无法查询则记 NOT_VERIFIED） |

## 7. 新增了什么、没有什么

新增、可被验证、对真实作者有用：
- 作者 LaTeX 源稿中「正文数值与所引表格不符」「N× 无法由所引表格推出」两类缺陷，在被审稿件上逐格复算成立时，成为 Quality Gate / QualityReport L1 的已核验缺陷，附单元格、区间与复算过程；转写稿只到「转写证书，需对照原件」；其余一律未评估，不静默 PASS。
- 长文档审稿缺省追加一次整稿综合审查，补上单元审稿漏掉的研究问题 / 基线 / 实验充分性类意见（新集整稿子指标 +27.3pp），恒为待核验意见。

没有：
- 全称比较、派生口径、符号字面量、缩写全称、公式推导的确定性核验（7 个历史根因中 5 个）。
- 在 PDF 转写的已发表论文上，证书路径几乎不适用（新集 0 / 520）。
- 单元生产在人类参考对齐上弱于单次全文（−13.4pp），hybrid 只追平；严重度未校准；中文期刊学术水平无独立标签。

下一步：没有未修完的工程阻断。若要把 L4 / 严重度从 LIMITED / 未校准推进，依赖的是**外部**数据（中文目标期刊的独立专家标签、作者源稿样本），不是本仓库的待办缺陷；本轮不创建新阶段。
