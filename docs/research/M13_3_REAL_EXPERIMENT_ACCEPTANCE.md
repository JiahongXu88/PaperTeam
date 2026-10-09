# M13.3 Real Experiment Acceptance & GLM-Assisted Understanding

> 状态：**PASS（带明确限制）** · 2026-10-09 · 工程主线 `d67daa6a` → `main`
>
> M13.2 用合成实验包验证了机制；本轮用作者真实科研材料——Phase 9.0
> 车辆多目标跟踪反事实试用期模拟（dev-25，四臂 A0–A3，TrackEval，
> 源材料判定 **NO-GO — ACCOUNTING**）——完成首次真实数据验收，暴露并
> 修复了确定性缺陷，落地了受控的 GLM 辅助语义理解，并补齐了真实浏览器
> 端到端与真实模型链路。本报告可公开：不含任何未发表实验数值明细。

## 1. Git Baseline 与环境

- 起点 `d67daa6a28bf4c33915b5dba440bbb1d010cdeef`（HEAD == origin/main，tree clean）；
  终点见 §9。
- Windows：真实 ZIP `SHA-256 0ebbbfd9…22e85`（482,200 B / 17 文件，与声明一致，
  只读校验后未修改）；SSH 私钥复制入 `%USERPROFILE%\.ssh\paperteam-sg-key.pem`
  （复制非移动；ACL 收敛为当前用户只读；OpenSSH 指纹核对一致）。
- 主机身份：ED25519 指纹与受信记录**逐字一致**后才写入 known_hosts；
  `StrictHostKeyChecking=no` 未使用。跨境链路对 sntrup761 大 KEX 包会被
  中间设备重置，SSH config 固定 `curve25519-sha256` 解决。
- ECS（Ubuntu 24.04，4 vCPU / 16 GiB，磁盘 51%）：两容器 healthy，8080 仅绑
  `127.0.0.1`；既有 8 个项目与三个数据卷（projects / runtime / hf-cache，
  compose override 绑定 /data）完整保留，全程未用任何 prune / down -v。
  远程访问经 SSH 隧道（本机 18080/18081 → ECS 回环）。

## 2. 模型配置切换（个人 GLM API 凭据）

| 项 | 切换前 | 切换后（实测） |
| --- | --- | --- |
| Provider / Model | `zai-coding-cn/glm-5.3` | `zai/glm-5.3` |
| API 通道 | Coding Plan（内置 Coding endpoint） | 按量 API `general_api` → `https://api.z.ai/api/paas/v4` |
| Key 来源 | stored（auth.json，Coding Plan） | 作者经 SSH 隧道在「设置 → 模型设置」浏览器输入并保存（stored） |

- 环境变量优先级风险预先排除：服务器无 `PAPERTEAM_PI_API_KEY` /
  `PAPERTEAM_PI_MODEL` 覆盖，UI 保存即时生效；运行期 `activeRuns=0` 后才操作。
- Test Connection：`zai/glm-5.3` **ok**（作者保存时 1778 ms；复核 1035 ms；
  日志确认按量通道生效）。GLM-5.3 不支持关闭 thinking——通用 API 通道上必须
  显式给最低档位（否则 400 code 1210），该规则已同步进语义理解调用路径。
- 记录口径：作者自述账户类型为智谱 BigModel 国内通用 API，实际配置选择了
  `zai`（Global 家族 provider）+ general_api 并实测连通——以实测为准，本报告
  不替作者改写。Key 全程未进入聊天 / Git / 日志 / 报告；旧 Coding Plan Key
  被同 Provider 覆盖保存（回退需作者在控制台取回，已提示）。

## 3. 真实 ZIP 盲测基线（修复前，冻结产物）

隔离项目经已部署 API 上传（SHA-256 复核一致；未调用 LLM、未注入任何
标准答案）：

- 17/17 文件登记；解析 ok 15 / partial 1（`cps_commit_log.json` 触 20k 块上限
  诚实截断）/ **unsupported 1（`.jsonl`）**。
- 指标观测 2,155 条，抽查 `overall.A0–A3` 与源文件**浮点全精度一致**；
  provenance（sourceId + blockId + jsonPath）完整。
- 分组只有 `main`（9 个结果类 JSON 并入一组）与 `unresolved`；
  **A0–A3 四臂结构完全丢失**；4 个 TrackEval 原生 `pedestrian_summary.txt`
  被归类 documentation，无指标提取；NO-GO 判定字符串无处呈现。
- 未确认时 workflow-context 为空（边界正确）；无任何伪造成功。

人工对照（文件/行/字段级来源）与错误分类（A 解析 / B 确定性映射 /
C 语义 / D 不可验证 / E 工作流图表）存于私有审计文档；D 类（dev-25 与
full38/confirmation 协议关系、数据集身份等）明确标注
`NOT_ESTABLISHED_BY_SOURCE`，系统不得补齐。

## 4. 真实数据驱动的确定性修复

全部先有可复现证据、后有最小修改，合成回归测试固化（store-ZIP fixture
构造器，无任何真实指标硬编码）：

| 缺陷（分类） | 修复 |
| --- | --- |
| `.jsonl` 行流不支持（A） | 新 `jsonlStructured` 解析器：每行一条 structured_record、物理行 provenance；registry / SourceStore / 实验包登记打通 |
| 空白对齐表按纯文本处理（A） | `.txt` 整文件表判定（同列数 + ≥80% 数值格）→ table 块保留列结构；结果角色下表格数值以行列锚进入观测 |
| 兄弟目录同名结果文件无臂分组（B） | 候选平行实验臂 `arm-<dir>`（A0–A3 实测全部命中）；仅为候选，角色语义不自动推断 |
| 指标方向未知（B） | 标准 MOT 指标方向词表（HOTA/IDF1… higher，IDSW/Frag lower；未收录保持 unknown） |
| 双标度并存无告警（B） | 同组比率型指标小数/百分数混用告警；计数型（逐片段 1 vs 池化 79）经真实材料证伪后排除 |
| verdict 不呈现（B） | 源材料判定原样登记（`reportedVerdicts`）：仅顶层非数组叶子，逐条 decision 噪声被真实材料暴露后排除 |
| 长单元格毁掉图表数据集（E） | 数据集视图单元格单行化 + 300 字符有界截断（原始记录不动） |
| 远程弱带宽不可用（E） | 包载荷有界化：列表回摘要、详情/变更回前 200 条观测 + 总数；隧道实测 17 s → 2.5 s |

真实 ZIP 第三轮复验（修复后）：唯一 verdict =
“PHASE9.0 NO-GO — ACCOUNTING”；无假告警；4 臂组就位；jsonl 零指标观测
（行流是特征数据，进图表不进 context——防淹没设计）。

## 5. GLM 辅助语义理解（受控）

- `POST /experiment-packages/:id/understand`：一次有界调用（生效默认模型按
  **调用时**存储偏好解析；上下文 = 清单 + 每文件 ≤40 条带值观测 + ≤2 段
  文档片段 + verdicts；材料以不可信数据框定，防注入）。
- 确定性校验：锚点必须是包内真实路径；findings 引用的小数/大数值必须与
  锚定文件观测**逐值相等**（小整数结构性参数豁免）；不合格整条丢弃并记
  note。全部建议恒为 `needs_author_confirmation`，不自动改写任何角色/分组。
- **真实 ZIP 实测**（`zai/glm-5.3`，9,121 tok，¥0.018，49 s）：17/17 文件
  角色建议 + 9 条 findings，**0 条被丢弃**——全部数值（0.6261264028064554
  级浮点、79/78/73、2074=T1b1697+T2 373+T1a 4 等）经逐值核对成立；
  A0→baseline、A3→oracle 对照（从中止原因 `oracle_no_prov_gt` 推断）等
  判断与人工对照一致；NO-GO 以「源材料报告」口径转述，未被反转。
- 对照结论（A 确定性 only vs B +GLM）：确定性层给出结构（臂组、方向、
  verdict、告警），GLM 层补上语义角色与关系——B 的增量是真实的且
  **全部可验证**；错误关联 0、伪造数值 0（validator 实测拦截捏造值）。
  成本：每包一次 ≈ ¥0.02 / 9k tok / 15–50 s。

## 6. 真实浏览器 E2E（Playwright + 本机 Chrome，SSH 隧道）

`e2e/tests/experiment-real.spec.ts`（env 门控 `PAPERTEAM_E2E_REAL_ZIP`，
无私有数据入库，未设环境变量时整链 skip）：创建隔离项目 → 上传真实 ZIP →
17 文件断言 → arm-a0…a3 分组 → Source-Reported Verdict 呈现 → 无假告警 →
作者角色修改 + 三组确认 → workflow-context 有界断言（含 metrics.json 真值、
排除 jsonl）→ 真实数据集（2,074 行机会流）→ pgfplots 散点图
（score × cos_query_cand，**真实 XeLaTeX 编译**）→ PDF 字节 `%PDF-` 魔数
校验 → 收尾归档。5–8 张关键页截图存本机私有验收目录（含未发表材料，
不进公开仓库）。跨境隧道的 keep-alive 半开以导航重试兜底（测试基建层，
不改产品）。

## 7. Workflow 真实消费（Phase 7）

作者按 GLM 建议路径确认 6 组后（main / baseline-a0 / main-a1 / main-a2 /
ablation-a3 / opp-universe；txt 表格新增 156 条行列锚观测，总观测 2,311）：

- workflow-context：`author_confirmed_not_externally_verified`，截断至 100，
  数值与锚点抽查精确命中；无 jsonl 特征、无未确认组、无
  confirmation/full38 泄漏；未升级为 Verified Evidence。
- 真实 Agent 消费：隔离项目启动 `idea_to_paper`，`research.idea` 阶段
  **实测消费 100 条作者确认观测**（`confirmedExperimentObservations: 100`，
  真实 GLM researcher 调用），流程按设计停在可行性 HITL；未让模型重写任何
  真实稿件，验证后即取消运行。
- 已知限制：100 条上限按文件序截断，当前全部来自 `main` 组 JSON——臂级
  txt 观测会排在后面进不了 context（有界性优先；见 §10）。

## 8. ECS 持久化与回归

- 容器重启后：packageId/hash/17 文件/2,311 观测/6 组确认（含确认时间戳）/
  verdict / 语义建议（含模型归因与 usage）/ Source ID 全部不变。
- Backend vitest 2,932 用例（2,907+ 通过；3–5 个 SSE/时序用例为 Windows
  并行负载 flake，单跑全绿）；Frontend 294/294；双端 typecheck 通过；
  GitHub **CI 与 Linux Integration 全绿**；8 个既有项目未受影响。
- 测试项目留存：盲测基线项目（修复前状态）与最终验证项目各一，供复核；
  中间态与 E2E 临时项目已删（archive → delete）。

## 9. Git

- Commits（`d67daa6a` →）：`bed526c`（确定性理解 + JSONL/空白表/臂组/verdict/
  告警 + GLM 理解层 + 测试）、`6b4d304`（数据集单元格有界 + 类型别名）、
  `4ba2186`（verdict/告警噪声精化 + 真实 ZIP 浏览器 E2E）、`e1a2e1b`
  （语义调用按调用时模型解析）、`019fc00`（包载荷有界化）、`3c3e2c0`
  （契约文档）、`268b7bb`（thinking 最低档位）。
- 最终 HEAD == origin/main，working tree clean；ECS 部署同一提交。

## 10. 限制与下一步

1. 上下文 100 条截断的排序策略（臂级/汇总观测优先）值得做——真实包的
   txt 表观测当前进不了 workflow context。
2. `.jsonl` 行流不产指标观测是设计取舍（防特征值淹没）；若未来出现
   行流式指标表，需要作者显式通道。
3. 语义理解每包一次全量重跑；增量/缓存（包 hash 不变时复用）未做。
4. 盲测基线项目保留在服务器上供对照，后续可清理。
5. 远程带宽下 Docling PDF 解析大文件仍慢（与实验包无关，未在本轮范围）。
