# M15.3.3 — OA 单点映射 + Docling CI 稳定性修复

- 日期：2026-10-23；基线 `1f9e390`（== `origin/main`，工作树 clean）。交付两提交：**A `ec1f5c4` `fix(review): recognize OA as overall accuracy`（OA_ALIAS_PASS）**、**B `3b92ff0` `fix(ci): make Docling model source explicit and stabilize native smoke`（DOCLING_CI_PASS，含缓存命中证明）**。付费 Reviewer 模型调用 **0**；生产 Gate（`gates.ts` `19addc17…`、`revisionTaskGate.ts` `6d770342…`）与 Reviewer 模型配置逐字节未动。
- 预登记 `D:\PaperTeamData\M15\M15_3_3\PRE_REGISTERED_CHECKS.md`（任何代码修改之前冻结）；数据/日志全部在 `D:\PaperTeamData\M15\M15_3_3\`（仓库外）。

## 1. Line A：`oa: "accuracy"` 单条目（OA_ALIAS_PASS）

**变更**：`backend/src/review/claimCertificate.ts` SYNONYMS 追加 `oa: "accuracy",` + 1 行注释（净 2 行，生产唯一改动）；`backend/test/review/claimCertificate.test.ts` 新增 describe 块 9 例合成测试（+213 行，夹具全自写合成）。除此之外 backend/src 零改动，与 M15.3.2 §8 裁决 GO_ONE_ALIAS 的实现形态逐字一致。

**191 例零模型重放**（`M152_DIST` 指向生产 dist，`M15_2/scripts/eval_pairs.mjs` 原封不动，`diff_replay.py` 四级逐例差分）：

- SEALED 93 翻转全集 **恰 5 例、全部 N03**，逐例与预登记表及 M15.3.2 C1 沙箱完全一致：P01 ABSTAIN→**CORRECT_STRONG/VERIFIED_SUPPORTED**（绑定 `(Ours)|[ModelNet40,OA]=99.05@2e84e8c2:22,1` == oracle 真值格）、P03 ABSTAIN→**CORRECT_STRONG/VERIFIED_CONTRADICTED**（98.05 vs 99.05 DISJOINT，B2 无他表命中）、P04 保持 ABSTAIN（新理由 `PROPOSED_COUNTERPART_IS_NOT_THE_UNIQUE_BINDING` 双钥匙拒绝）、P07 保持 ABSTAIN（`TIED_CANDIDATES`，PointNet/PointNet++ 跨表并列）、P12 保持 ABSTAIN（首位理由变 `DERIVED_COLUMN_AMBIGUOUS`）。
- 汇总：CORRECT_STRONG 3→5（**3/57→5/57**，EXPOSED_REGRESSION 语义，非 held-out）、ABSTAIN 82→80（口径 {CS 3, AB 82, NI 8}→{CS 5, AB 80, NI 8}）、**WRONG_STRONG 0**；既有 8 条正确强判零损失（SEALED `N03-P02/N09-P01/N09-P03` + DEV_NEW 5 条），N09-P05 的 B2 `VALUE_APPEARS_IN_OTHER_TABLE:4b44c3069fef0a56,57c97dbb30f5999e` + B3 `UNEXPLAINED_QUALIFIER:reproduced` 逐字不变，N09-P12 双钥匙码不变。
- DEV_NEW 98 **零翻转**。生产 vs M15.3.2 C1 沙箱：双侧 0 翻转（生产实现 == 沙箱补丁验证，`diff_prod_vs_sandbox.json`）。

**合成测试（T1a–T6 六方向，敏感性验证）**：正例 T1a/T1b/T2b 改前红（NOT_CERTIFIED）改后绿；负例 T2a/T3b/T4/T5/T6 双侧绿（绝不出证书）。两处登记期望偏差（同 M15.3.1 S5 先例：按实测修正并注明，不改历史验收条件）：

- **T3b**：登记期望 NOT_CERTIFIED；基线实测 SUPPORTED——根因是 "OA-Net" 行键中的裸 `oa` 词元今日即与裸 `OA` 列头直接匹配（既有机制，与 `acc` 别名同类，非本轮引入）。断言改为锁定真实不变量：若出证书则 rowKey 必须含 CloudSort 行、绝不出 CONTRADICTED、绝不绑 OA-Net 行。
- **T4**：登记期望理由 `MULTIPLE_METRICS_BEFORE_VALUE`；实测首位理由 `PROPOSED_COUNTERPART_IS_NOT_THE_UNIQUE_BINDING`（claim 侧 top 候选为 mIoU×65.4，metricDistance 更近，≠ 提议 OA 格）。断言改析取式，NOT_CERTIFIED 双侧保持。

`claimCertificate.test.ts` 49/49（含既有 40 例零改动）；typecheck/build 通过。

## 2. Line B：Docling native CI 下载源与稳定性（DOCLING_CI_PASS）

### 2.1 取证（B1/B2，全部来自真实日志，非猜测）

`gh run view 39921420556`（08:00 触发）三 attempt：**attempt 1** 08:03 失败——test 1 于 152s 报 `Server disconnected without sending a response.`（test 2 通过）；**attempt 2** 08:24 失败——934s 处 `解析超时（880000ms…）`；**attempt 3** 4m45s 通过。前次 39905009080 也需第 2 attempt。**配置矛盾证明**：native smoke 步 env 块仅有 `CI: true`、无 HF_ENDPOINT（日志原文），而 `doclingReal.smoke.test.ts` beforeAll 在未设置时注入 `https://hf-mirror.com`，`DoclingParser.ts` L149 `env: { ...process.env }` 传入 Python 子进程——**实际下载端点是 hf-mirror.com（美国 runner 访问镜像站）**，与 workflow 旧注释「直连 HuggingFace」相反。镜像下载失败 = 瞬时网络错误高嫌疑（NETWORK_TRANSIENT 类）。docker job（`HF_HOME=/data/hf-cache` 直连官方源）同期稳定绿。

### 2.2 修复（B3，四件套 + 单测）

1. **端点显式化**：docling-native job 级 `HF_ENDPOINT: https://huggingface.co`（测试 undefined 分支不再注入镜像；本机国内网络缺省镜像行为不变）。**库确实读取**：run 日志 `resolved constants.ENDPOINT host = huggingface.co`（huggingface_hub 1.33.0）。
2. **缓存路径先证实再入缓存**：诊断步用库内常量证实 `constants.HF_HUB_CACHE = /home/runner/.cache/huggingface/hub`（env 层 HF_HOME/HF_HUB_CACHE 均未设置）后才加 `actions/cache@v4`（path 仅 `~/.cache/huggingface/hub` + `~/.cache/docling` 模型目录，无 token/凭据文件；key `docling-models-v1-Linux-<docling版本>`，无 restore-keys 避免陈旧模型）。
3. **有界重试**：smoke 步对传输层瞬时错误特征（断连/重置/读超时等 + 首次解析下载期 `解析超时`）最多重试 1 次（attempt 2/2），重试前打印缓存状态；解析/schema/表格图块断言失败不匹配、二次失败真实退出——不吞错、不降级 PyMuPDF、不加大 880s/900s 超时。**本轮 0 次触发**（两次 run 均 attempt 1 通过）。
4. **脱敏诊断 + 观测**：诊断步仅输出主机名/路径（无 token/查询串）；pre/post-smoke `du`/`find` 缓存列表。docker job 零改动。
5. **B3.5 无网络单测**：抽 `resolveDefaultHfEndpoint` 纯函数（`src/ingestion/hfEndpoint.ts`）+ 4 例单测（未设置→镜像；显式官方源/自建网关→原样透传；空串视为显式设置）。

### 2.3 验收证据（B4）

| 项 | 证据 |
|---|---|
| 最终 HEAD CI | `3b92ff0`：CI run [39934891087](https://github.com/JiahongXu88/PaperTeam/actions/runs/39934891087) ✓；Linux Integration run [39934891082](https://github.com/JiahongXu88/PaperTeam/actions/runs/39934891082) ✓（docling-native 3m42s + docling-docker 16m39s，均 attempt 1） |
| 缓存命中（第二次 workflow_dispatch） | run [39937745281](https://github.com/JiahongXu88/PaperTeam/actions/runs/39937745281) ✓：`Cache hit for: docling-models-v1-Linux-2.142.1` → `Cache restored from key`（~469MB blob / 磁盘 506M），smoke 2/2 于 ~81s 完成且无模型下载；docker 6m14s |
| 真实结构化解析 | native：vitest 2 passed（结构化 blocks/表格/图/页码 provenance 断言）；docker：`rc=0` + 权重加载 770/770 + TableItem 导出 + `jq -e '.ok==true and .parser.id=="docling" and (.blocks|length)>50'` 硬门通过 |
| 端点 | 两次 run native 日志 `resolved constants.ENDPOINT host = huggingface.co`；`hf-mirror` 出现次数 **0** |
| 缓存路径 | `~/.cache/huggingface/hub/models--docling-project--docling-layout-heron/...`（post-smoke find 列表） |

**定性**：已证明修复的是「配置矛盾」（实际走镜像 → 显式官方源）并附可观测缓存；**不宣称长期网络不稳定被根治**——仅 2 次绿 run + 端点/缓存证据，镜像路径瞬时失败这一具体根因被消除，直连 HF 的长期稳定性由后续 run 持续检验（有界重试兜底传输层抖动）。

## 3. 局限与回归口径

- A 的 5/57 为 EXPOSED_REGRESSION 语义（SEALED 已开封，非 held-out）；`automated_truth` 非人工金标准；OA 唯一化依赖该文 caption 措辞，换文可能落 TIED（安全弃判）。
- 本机（Windows）全量 vitest 4190 passed / **8 failed**——4 个文件（doclingReal 全链、doclingConcurrency、stylePolish×5、m141aIntegration）在满负载并行下闪失，**逐文件单跑全部通过**（doclingReal 2/2、其余 39/39），与本轮改动无关（B 编辑前后语义逐字节等价已由 hfEndpoint 单测与隔离运行证明）；CI 权威结果为 Actions 全绿。
- B 的两次 run 均 attempt 1 通过，重试路径未被真实触发（仅静态存在 + 注释说明）；如未来触发，日志会显式标注 attempt 与缓存状态。

## 4. 可追溯性（`D:\PaperTeamData\M15\M15_3_3\`，仓库外）

| 项 | 值 |
|---|---|
| 预登记 | `PRE_REGISTERED_CHECKS.md`（代码修改前冻结） |
| A 重放产物 | `analysis/eval_pairs_{sealed,devnew}_{old,new}.json`（old `6f752512…`/`cccb6d5d…`、new `d8b0c3ca…`/`28ba1483…`）、`diff_m1533_oa.json` `ff60b5f2…`、`diff_prod_vs_sandbox.json` `e2e001dd…` |
| B 日志取证 | `ci_native_3b92ff0.log`、`ci_native_run2.log`、`ci_docker_3b92ff0.log`（gh --log 原始转储）+ 此前 39921420556 三 attempt 取证 |
| 保护锚复算 | `gates.ts` `19addc17dc68a6f8…`、`revisionTaskGate.ts` `6d77034251128124…`（== 预登记 §1） |
