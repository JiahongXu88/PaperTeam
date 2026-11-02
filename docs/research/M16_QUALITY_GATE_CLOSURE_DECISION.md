# M16 续期收口 · 最终答卷（对照 M15 原始 Quality Gate 目标）

- 日期：2026-11-02 · 执行：Claude（Opus 5.5）· 起点 `8791708` → 本轮提交见 §6
- 分报告：`M16_M15_ORIGINAL_GOAL_GAP_MATRIX.md` · `M16_QUALITY_GATE_CLOSURE_IMPLEMENTATION.md` · `M16_QUALITY_GATE_CLOSURE_VALIDATION.md`
- M15 / M16 既有提交、报告、冻结协议与历史结论（M15 TJA LIMITED、M16 首轮 EVALUATION_BLOCKED、M16 收口 BENCHMARK_VALIDATED）未改动。未启动 M17。

## 最终判定：**M16_CLOSURE_PRODUCT_VALIDATED_EXTERNAL_VALIDITY_LIMITED**

产品能给出可追溯、部分经确定性核验的具体学术问题，覆盖不完整时如实标注，修订链路不越权；但「生产 Reviewer 是否优于一次全文审稿」预注册主指标 INCONCLUSIVE，且在与人类专家关注点对齐上生产链路显著更弱（主要差在整稿问题）；中文期刊没有独立质量标签，学术水平判断仍不能宣称达刊。

## 1. 最初想做什么

用户输入论文与目标期刊，系统能说清：已证实的问题与依据、不能确定的部分、需要补什么、修改后哪些问题真的关闭——四问（Completeness / Correctness / Severity / Calibration）+ 受控修订闭环；不得把 CI 绿、Gate PASS、模型自评或尺子区分力当作学术质量已验证。

## 2. 真正完成了什么（按五个目标）

| 目标 | 结论 | 依据 |
|---|---|---|
| Completeness | **PASS**（修了 1 个假完整缺陷） | 多文件 LaTeX 根 main.tex 正文此前不进任何审查单元而覆盖仍报 100%，已修（`d5f0052`，基线 4/4 FAIL → 4/4 PASS）；真实运行中 3 个单元被服务商内容过滤拒绝 → 覆盖 60.5%、Gate FAIL，无假 PASS |
| Correctness | **部分验证** | 12 篇新留出集上，生产 findings 89.6% 可在原文定位；人类审稿没写、但脚本可在原文复算成立的 major 缺陷 **7 个根因 / 6 篇**（数值矛盾、无法推出的 9.4×、方法名与自身参考文献不符…）；同时有 1 条 major 被复算反证、6.8% 条目引用了不存在的定位（DANGLING） |
| Severity | **PASS（含反例）** | L1 已证实 / L2 模型意见（NEEDS_VERIFICATION）/ 作者裁决 / L4 UNVALIDATED 分离；新修：部分覆盖下「0 条 major」不再显示 PASS（`b38cb62`，基线 FAIL → PASS）；反例：被反证的 0.036% major、57 条 major 中仅 2 条与人类意见对齐 → 模型严重度未校准，只能作 AI 风险意见 |
| Calibration / Journal Fit | **LIMITED** | 官方规则合规（CJIG / PLOS ONE）有原文出处；学术水平：英文 ML 会议参考可区分「读没读论文」（尺子 4 项 PASS），但中文期刊独立标签为 0，L4 恒 UNVALIDATED，不输出达刊判断或录用概率 |
| Revision Closure | **PASS（scripted）** | 合法修复 → VALIDATED_FIXED；越权换数 / 删句 → 拒绝；需补实验 → 不派发；本轮在当前 HEAD 重跑 44 个文件 603 例通过；本轮未改修订代码 |

## 3. 生产 Reviewer vs 单次全文（n = 12，新留出集）

| | 结果 |
|---|---|
| 预注册主指标 hybridSpec P@all − S@10 | **−7.6pp [−16.4, +1.0] → INCONCLUSIVE** |
| P@10 − S@10 / judgeSpec / 命中条目率 | −13.6 [−21.4, −5.7] / −19.2 [−30.4, −8.3] / −27.9 [−40.4, −13.9]（生产显著更弱） |
| 漏检结构 | 单次全文命中而生产漏掉的 53 条人类意见中 68% 为整稿层面 |
| 可定位 / 独立核验 | 生产 LOCATED 89.6% vs 18.6%；确定性核验成立 7 根因 vs 0（单次全文条目不带引文，结构上难以核验） |
| 成本 | 188 vs 12 次调用（15.7×），67 vs 2.6 分钟（26×） |

一句话：**单次全文更像人类审稿人（抓整稿问题），生产链路更像逐段校对员（抓可定位、可复算的局部错误）**。二者互补，生产链路没有证明「全面更好」。

## 4. 用户现在能用到什么 / 还不能保证什么

能用到：分层质量报告（L0–L4）里看到已证实缺陷与模型意见的区别；每条模型 finding 带原文引文与位置；覆盖不全、核验未执行时明确 NOT_EVALUATED；目标期刊官方规则逐条合规与出处；受 EditContract 约束的修订与复评。

还不能保证：
1. 模型 major / critical 的严重度未校准；产品**没有**把模型 finding 自动做确定性复算（本轮 7 个核验成立的缺陷是评测脚本复算的，在产品里它们仍是 L2「待核验」）；
2. 整稿层面的问题（基线、实验充分性、创新性）生产链路明显漏得多；
3. 中文期刊学术水平、录用可能性：无外部效度；
4. 结论范围：英文 ML 会议、15k–60k 字节、≤ 16 审查单元的论文；内容安全过滤会让涉及有害内容示例的论文覆盖不全。

## 5. 是否再改 Reviewer：**YES（有界，本轮未改）**

证据：整稿意见漏检 68%（预注册改造触发线 70%，未达）、P@10 显著弱于单次全文。建议的唯一有界改造：在单元审查之外加一次整稿综合审查（复用单次全文 prompt，约 +1 次调用 / 篇），并把可定位的数值类 finding 接到现有确定性复算（`claimCertificate` / 表格数值）以从 L2 升到 L1。本轮未实施：触发线未达；剩余预算（36 次）不够在未开封数据上做同口径验证；本留出集已开封，不能再当独立终验。为什么不再启动无限修复：再改就需要新的未开封样本与 ≥ 200 次调用的同口径复测；没有这笔数据与预算，继续调 prompt 只会在已开封集上过拟合。

## 6. 交付（实测）

| 门 | 结果 |
|---|---|
| G0 基线与目标 | **PASS**：起点 HEAD = origin/main = `8791708`，clean；M15 交接文档已读；协议冻结（sha256 `d309c76f…`）；预算 / 隔离 / 偏差见 VALIDATION §1 |
| G1 输入完整性 | **PASS**：A1 修复 + 4 例零模型回归；PDF 公式仍 FORMULA_UNVERIFIED（不参与对照） |
| G2 Benchmark 有效性 | **PASS**：新留出集 G1–G4 全过；问题级证据链见 VALIDATION §5 |
| G3 学术发现 | **INCONCLUSIVE**：主指标 −7.6 [−16.4, +1.0]；7 个独立核验根因 |
| G4 Severity 与结论 | **PASS**：分层分离 + 部分覆盖纠偏 + 反例（反证 major、未对齐 major） |
| G5 修订 | **PASS（scripted）**：合法修复 / 越权拒绝 / 需补实验不派发 / 409 陈旧拒绝 |
| G6 用户产品 | **PARTIAL**：UI / API 给出具体问题、引文位置、NOT_EVALUATED / UNVALIDATED 与下一步，拒绝假达刊（浏览器 E2E 5/5）；但模型 finding 的确定性复算未接入产品，独立核验成立的缺陷在产品里仍显示为「待核验」 |
| G7 工程交付 | 后端 build / typecheck PASS；后端全量 `vitest --maxWorkers=4`：432 文件通过 / 26 跳过，4,741 例通过 / 47 跳过 / **0 失败**；前端 typecheck / build PASS、测试 380/380；浏览器 E2E（隔离 scripted 栈 :3100 / :5192，零模型）`m15-quality-report` R / V + `m15-target-journal` J1–J3 **5/5**（首次运行因未设 `PAPERTEAM_E2E_M15/TJA` 全部 skipped，已更正重跑）；Git / CI 见下 |

本轮提交：`d5f0052`（A1 根 main.tex 覆盖）· `b38cb62`（部分覆盖计数规则）· 本报告与评测工具提交（见 Git 状态）。

模型调用：真实 **224 / 260**（账本 230 行，含 6 行已披露的重复记录）；独立人工新增 0；完整生产工作流 12 / 12。
