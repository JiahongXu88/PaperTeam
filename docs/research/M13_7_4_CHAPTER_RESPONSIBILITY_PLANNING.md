# M13.7.4 — Chapter Responsibility Planning

日期：2026-10-11。审计及 Baseline：`main @ af65ce45afc08123f7253d3e62146abf4f9a8081`。

**裁决：PARTIAL；候选不合入生产。** 完成架构审计、轻量职责契约候选、真实两主题 A/B、held-out 重复采样、真实 Planner 检查及回归。没有证实稳定减少无意义的跨章节重复，仍有 quote 未覆盖的事实细节；开发最终候选写作费用比基线增加 25.1%，规划还产生失败修复成本。因此撤回所有生产与测试夹具改动，只交付可复现失败资产、验收脚本和报告。不能将结构测试通过等同于写作质量通过。

## 1. M13.7.3 根因与架构审计

上一轮失败 patch 是实验资产，本轮未重新应用。其做法是写作时回灌其他章 keyPoints、第一章及近期章节摘录、上一章结尾；没有先把定义与机制的主展开职责固化为可校验状态。模型已有历史却仍完整复述 RAG 等定义，输入 +56.9%、费用 +34.7%，缺少可确认收益。问题不能简单归因于“Writer 不知道前文”。

| 审计问题 | 结论与路径 |
| --- | --- |
| Outline 只有标题/keyPoints 吗？ | 不止：`manuscript/ManuscriptService.ts` 已有 id/file/title/长度/要点，Survey 还有 synthesisRefs/literatureRefs；但确实没有 concept owner、各章必答问题和跨章职责契约。 |
| 能否在已有 Outline 扩展？ | 可以。`WriterService.planOutline` 解析 JSON，`validateOutline` 验证；`ManuscriptService.saveOutline` 原子落盘到 `manuscript/outline.json`，`normalizeOutlineRefs` 保留顶层扩展字段。无需新增 Agent、Stage、数据库或记忆系统。 |
| 能否生成简洁映射？ | 可以表达 `term → owner → brief/reference`；五章固定人工契约消费测试可运行。真实模型生成的可靠性未通过，不能把“能表达”冒充“能稳定生成”。 |
| Session 实际包含前文吗？ | 是。两个逐章入口均串行调用 `WriterService.writeSection`，使用同项目 `writing/sections`；`PiRuntimeAdapter` 管理共享会话与 FIFO。正常连续运行可获得历史。rotation 在安全边界替换 generation；它不是持久科研事实源。 |
| Outline 如何到 Writing？ | 普通：`outline.plan` → `saveOutline` → HITL → `writingSectionsStage` 的 `loadOutline` → `writeSection`。Survey：`survey/OutlineService.build` → 相同落盘/HITL → `loadSurveyWritingInputs` → `buildSurveySectionContext` → `surveyWritingSectionsStage` → `writeSection`。已有完整 outline 参数可直接承载契约，不需新增传递通道。 |
| Resume / rotation 如何保留？ | 候选随 authoritative outline 保存，每次 prompt 都从 outline 投影，与历史无关。Survey 跳过写作的结构指纹必须包含契约，候选已修改这一实际判定路径；旧稿无契约时不迁移、不猜 owner。 |
| Survey Evidence 如何分配？ | Matrix entry → sourceId；Synthesis 绑定 evidenceIds；Outline 保存 synthesis/literature refs；`sectionContext.ts` 按 refs 解析正式 Evidence、来源和 citation 白名单。候选不替代这个链，也不允许职责授予新的支持强度。 |
| Reviewer 能保证跨章一致吗？ | 不能。Fact/Academic/Style 已有重复、术语漂移、范围/事实问题检查；Style 明确检查重复免责和未来实验冒充贡献。生产 digest 每章/全文有界，长章后部可能不可见；仍依赖模型发现与 issue 定位。本轮没有修改 Reviewer 或把参考分数当质量门。 |

本轮回应是**先规划在哪里展开，再按章投影**，完全不注入前文原文或结尾，也没有额外上一章摘要调用。

## 2. 候选契约与真实接入

完整源码与五个测试见 [rejected-candidate.patch](../../scripts/acceptance/fixtures/m13-7-4/rejected-candidate.patch)。以下为结构示意，实际内容在输入夹具中：

```json
{
  "responsibility": {
    "version": 1,
    "concepts": [
      {"term": "LoRA（低秩适配）", "owner": "base", "reminder": "brief"}
    ],
    "chapters": [
      {"sectionId": "base", "goal": "展开低秩适配机制",
       "questions": ["冻结什么、训练什么？"],
       "dependsOn": ["introduction"], "evidenceIds": ["E1"]}
    ]
  }
}
```

每个 section 恰好一个 chapter；每个规范化 term 只有一个 owner。`brief` 是必要的简短提醒，`reference` 是回指，不表示一个概念只能出现一次。术语名称统一，定义范围以 Evidence quote 为准；没有另存由模型自造的“科学定义真值表”。概念 owner、目标与必答问题只管理论述，不证明事实。

限制：最多 16 个概念，term≤60 字符；goal≤120；每章 1–3 个问题、各≤100；dependsOn≤4；evidenceIds≤6；契约序列化≤6000 字符，任一逐章投影≤3000 字符。拒绝非法 owner、规范化重复 term、缺章/重复章、未知/自依赖章节、非法 canonical Evidence ID 及超限结构，不通过截断悄悄改变规划。英文大小写与 NFKC 可去重，同义词/别名的语义重复仍不能确定性识别；依赖图没有完整 DAG 校验。

| 候选文件 | 实际行为 |
| --- | --- |
| `backend/src/manuscript/chapterResponsibility.ts` | 类型、纯函数校验、当前章目标/问题和全篇概念映射投影、两类规划纪律；不接收正文、不删稿件。 |
| `backend/src/manuscript/ManuscriptService.ts` | Outline 扩展字段并接入已有 `validateOutline` / 保存校验；落盘与恢复沿用已有机制。loadOutline 原有原始 JSON 读取语义未另行重构。 |
| `backend/src/writer/WriterService.ts` | 普通/Survey Planner 同次规划输出契约；解析并验证，普通 ID 必须来自输入正式 Evidence，Survey evidenceIds 留空沿用 refs。两个初始章节 prompt 消费契约，revision/patch prompt 不受影响。 |
| `backend/src/workflow/definitions.ts` | 新普通规划入口要求契约；Survey outline fingerprint 加入契约，改变职责会使旧完成结果不能幂等跳过。两个 Writing 入口原本就传完整 outline，未添加未消费的旁路参数。 |
| `backend/src/survey/OutlineService.ts` | 新 Survey 规划要求契约，保留既有 refs/speculative 等校验。 |
| `backend/src/runtime/scriptedRuntime.ts`、`backend/test/survey/fixtures.ts` | 脚本 Runtime 默认大纲适配新规划输出协议；未改变真实 Runtime。 |
| `backend/test/manuscript/chapterResponsibility.test.ts` | 所有权/结构/长度/ID、保存后新 service 恢复、旧 Outline、两条真实 writeSection prompt 路由、新规划必需及伪造 ID 拒绝。 |

旧 Outline 不含字段时返回原提示，不补编 owner。新 workflow 显式要求字段；旧直接调用可维持原契约。科学限制、合法公式、数值、引用和必要定义回顾有明确保留要求。只是初始生成上下文，没有文本去重删除器；不能由此推导长论文中的科研信息不会遗漏。Existing Paper Revision 的事实/引用冻结/Patch 契约未改。

## 3. 冻结与真实实验边界

公开输入与冻结规则：[资产说明](../../scripts/acceptance/fixtures/m13-7-4/README.md)、[protocol.json](../../scripts/acceptance/fixtures/m13-7-4/protocol.json)、[SHA256](../../scripts/acceptance/fixtures/m13-7-4/freeze-sha256.json)、[runner](../../scripts/acceptance/chapter-responsibility-live.mjs)。

| 样本 | 文献与固定五章 | 实际 Writer 路径 |
| --- | --- | --- |
| 开发 | [LoRA v2](https://arxiv.org/abs/2106.09685v2)、[QLoRA v1](https://arxiv.org/abs/2305.14314v1)；引言 / 低秩适配 / 量化适配 / 综合比较与局限性 / 结论与展望 | `buildSectionPrompt` 普通论文入口，中文综述内容。 |
| held-out | [FedAvg v4](https://arxiv.org/abs/1602.05629v4)、[SCAFFOLD v4](https://arxiv.org/abs/1910.06378v4)；引言 / 联邦聚合 / 异质性与局部修正 / 综合比较与局限性 / 结论与展望 | `buildSurveySectionPrompt` 专用入口，两组独立 A/B，顺序 A→B 与 B→A。 |

两组输入、大纲、文献池、逐字摘要 quote、direct/partial、写作要求、评分维度、模型和预算在首轮生成前冻结。partial `E9` 故意带更强普遍保证，但 quote 仅覆盖机制。所有来源及摘要摘录与上述版本页核对；是人工范围核对的验收 Evidence，不是生产 Grounding/Judge 新核验。没有复用 Transformer/DPR/RAG 作为新最终主题。

每节目标约 350 中文字，允许相同合理浮动，不以缩短稿件判提升。Baseline 为指定 main；Treatment 仅加职责契约；其他输入与 prompt builder 来自对应代码。每个 arm 五章共享独立会话历史，不人为清空前文夸大缺口。Survey 的表达上下文是手工固定的 synthesis/literature 投影，两组相同；没有宣称真实 Matrix/Synthesis 供给成功。

为了隔离消费机制，A/B 契约也是人工冻结的，不是从随机 Planner 生成后择优挑选。另用真实 `WriterService.planOutline` 检查两个模式能否生成合法契约，全部失败尝试与成本单独列出。这意味着本轮**没有证明自动 Outline → Writing 的真实端到端闭环**；受控 workflow 回归与 prompt LIVE 的证明范围分别报告。

开发先做 10 次 A/B，发现失败后只做一次调整：缩短投影、明确当前章完整展开清单及非 owner 提醒、比较章不重写定义。随后补跑 5 次 Treatment，与原开发 Baseline 比较，不冒充第二组独立基线。held-out 调用前固定候选源码/runner/输入哈希和时间，之后没有依据 held-out 调 Prompt。两组 held-out 全部保留。

服务器授权模型 `zai/glm-5.3`，无角色覆盖，所有 run 的模型设置哈希相同。没有声称固定随机种子或提供商输出完全确定。两份中文 Writer 技能可用，实际 `accessed=[]`，不声称读取技能正文。工具只读，不查询其他事实。

35 次章节请求 + 普通规划 3 次 + Survey 规划 2 次 = **40 次真实请求 / 40 assistant turns**。预算拒绝 Survey 第三次修复，未发出第 41 次。两个 Planner smoke 最后阶段短暂并行是编排错误：普通第三次已预留，Survey 读取包含该预留的 ledger 后继续预留，所以实际 ledger/request/turn 均为 40；正文 A/B 始终串行。runner 的共享 ledger 不支持并发事务，复现必须串行；不因本次未超额就声称并发预算安全。

## 4. 语义评价与可逐句核对证据

以下路径相对于私人根 `D:\PaperTeamData\M13_7_4`。每节 `.output.txt`、`.prompt.txt`、原始 quote、全稿和 result.json 全部保留。评价单位是带论述作用的机制/定义/限定句，关键词只用于定位。摘要/引言/结论的概括、比较维度需要的简短提醒、结论旁的适用限定均不自动计错。没有把所有重复词或同源引用统计为有害重复。

| 对比 | 可核对片段及语义判断 |
| --- | --- |
| 开发 Baseline 的完整再述 | `dev-live/before-extension.output.txt` 已比较共同冻结和量化差异；`before-comparison.output.txt` 再完整描述“在 Transformer 各层注入可训练的秩分解矩阵”及 QLoRA 的冻结量化模型→梯度→适配器过程。比较轴虽合理，完整技术前提的再次铺陈没有明显新增价值。 |
| 开发首次 Treatment | `dev-live/after-comparison.output.txt` 仍完整说明两种机制；`after-base.output.txt` 新增“这些矩阵以成对形式注入 Transformer 的各层”。quote 没有矩阵配对与前向计算细节。正文更长，不能判质量收益。 |
| 开发最终 Treatment | `dev-final/after-comparison.output.txt` 仍写“LoRA 在 Transformer 各层注入可训练的秩分解矩阵”与“QLoRA 则将梯度反向传播至低秩适配器”；`after-base.output.txt` 又介绍完整 QLoRA 路径。未得到更清晰的主要展开分工。引言/结论合理概括不另行机械报错。 |
| 新事实风险 | `dev-final/after-base.output.txt`：“因而无需为这些参数存储优化器状态”“低秩子空间内进行”；`after-introduction.output.txt`：“现有综述……系统梳理与比较仍相对有限”。给定 quote 不覆盖这些优化器/数学解释或研究空白判断；即使外部可能真实，也不满足本次 Evidence 范围。 |
| 两组 held-out 比较章 | 两个 Baseline 和两个 Treatment 都能按聚合层/局部更新层综合，短机制提醒参与回答比较问题，因此这部分不能仅因同词出现就判重复错误。没有观察到 Treatment 稳定增加新的分析层次；该样本基线本身已有合理综合，不能从接近表现推导收益。 |
| held-out 重复免责 | `heldout-1/before-base.output.txt`、`before-extension.output.txt` 末尾均重复本文不实验，comparison 集中限定后 conclusion 再限定；Treatment 对应两章同样出现。集中局限性与结论必要限定应保留，但方法章连续无新增意义的自我免责未稳定减少。第二组措辞有所变化，不构成两次一致提升。 |
| held-out 事实与范围 | `heldout-1/after-extension.output.txt`：“本地更新偏离全局最优方向”；`heldout-2/after-base.output.txt`：“将数据所有权留在本地”；`after-extension.output.txt`：“通过估计并抵消这一偏差”。quote 仅给客户端漂移/控制变量修正，没有最优方向、数据所有权或估计实现细节。Baseline 也有未覆盖的本地若干步、理想化有效性与显式偏差估计，故不是把旧风险全算为新增；Treatment 确实没有守住给定事实边界。 |
| 术语与定义 | 主概念基本一致，Treatment 增加统一中文术语/缩写提醒；两组没有明确的定义反转证据。Baseline 已基本正常，不能算新收益。 |
| 衔接 | 均有上一章/下一章或章节回指。held-out 部分输出生成了没有配对 label 的 LaTeX ref，包括 Baseline；未编译真实全文，不宣称交叉引用可用。组织连贯与可编译引用不是同一指标。 |
| partial 负例 | 各组未把 LoRA 任意任务同质量或 SCAFFOLD 任意条件全局最优写成已证明结论；有些 Baseline 还将其作为拒绝外推的负命题复述，这不算支持该命题。拒绝明显负例不代表其他细节全部获支持。 |
| 必要科研内容 | 两主题 owner 章核心机制、无本文实验、无统一复现、不能性能排序、未来评测均保留。没有通过删限制或清空正文压低重复。样本没有真实公式、负结果或本文数值，不能推导这些内容的 LIVE 去重安全。 |
| 正文工作状态 | 未见 Evidence ID、内部核验/授权编号泄露；仍有“现有证据不足”“尚未开展后续工作”等反复披露。科学材料范围限制可以成立，冗余披露与内部工作编号泄露分别评价，不以 workflow_note=0 宣称完全学术化。 |

本评价不是双盲多人打分，也不是全句自动语义证明；尤其机制短提醒和比较性复述的边界仍有人工判断成分。即使对争议复述全部从宽，**仍没有一致的正向差异，明确的无覆盖细节与规划失败已经足以否决上线**。未执行真实 Reviewer 打分来覆盖这些失败。

### 输出与引用核对

| run / arm | 字符 / 汉字 | cite 命令 / key 次数 |
| --- | ---: | ---: |
| 开发 Baseline | 3058 / 2233 | 18 / 18 |
| 开发首次 Treatment | 3194 / 2340 | 14 / 14 |
| 开发最终 Treatment | 2880 / 2101 | 16 / 16 |
| held-out 1 Baseline | 2730 / 1836 | 17 / 21 |
| held-out 1 Treatment | 3196 / 1843 | 21 / 26 |
| held-out 2 Treatment | 2982 / 1980 | 24 / 25 |
| held-out 2 Baseline | 3104 / 1850 | 20 / 25 |

35 章合计 **21144 字符 / 14183 汉字**。每稿均使用对应两篇合法文献，未知 key=0；没有伪造第三篇来源或本文实验数值。key 合法不等于句子得到支持，以上具体扩写使 Citation/Evidence 语义质量不能判 PASS。Treatment 不稳定减少引用次数，也无需强求减少。完整引用语义 Judge/Grounding/Gate 不在本次 LIVE 范围内。

## 5. 真实 Planner 失败

普通模型三次都把 `reminder` 写为概念说明自由文本，违反 `brief|reference`。owner 多为正确章节，错误信息却统一为 `invalid concept or owner`；已有 repair prompt 只回馈这个泛化错误和上轮 JSON，没有重新给出精确 enum/schema，模型未修正。三次返回模型文本均 completed，业务 `planOutline` 最终抛错。

Survey 前两次也未通过该字段校验；第三次修复被全局预算拒绝，因此结论是“已见两次校验失败、完整三次修复未完成”，不能宣称其全部修复预算已耗尽或业务通过。原文在 `plan-dev/`、`plan-survey/`。这一结果说明同次 Outline 规划可以减少独立调用，但若字段协议/修复诊断不清楚，会增加重试和成本；人工固定消费样本不能替代自动规划成功。

本轮不在看到 held-out 或规划失败后更改 enum 提示来制造首次通过。后续可以优先简化这一无必要枚举、提供字段级精确修复错误，但仍需新冻结样本复验。

## 6. Token、成本与时间

| 阶段 | input | output | cache read | SDK estimatedCost | 秒数之和 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 开发 Baseline | 12137 | 1786 | 25600 | 0.03150620 | 33.958 |
| 开发首次 Treatment | 12746 | 1856 | 30144 | 0.03384824 | 33.596 |
| 开发最终 Treatment | 18238 | 1733 | 24064 | 0.03941504 | 33.610 |
| held-out 1 Baseline | 12906 | 1440 | 30912 | 0.03244152 | 34.807 |
| held-out 1 Treatment | 14688 | 1600 | 34432 | 0.03655552 | 27.702 |
| held-out 2 Treatment | 14632 | 1563 | 34112 | 0.03623112 | 27.390 |
| held-out 2 Baseline | 12971 | 1558 | 30912 | 0.03305172 | 29.729 |
| 普通规划三次失败 | 7349 | 5360 | 10432 | 0.03658492 | 60.390 |
| Survey 两次失败 | 4406 | 2685 | 4160 | 0.01906400 | 25.959 |
| **总计** | **110073** | **19581** | **224768** | **0.29869828** | **307.141** |

cache write=0；input+output=129654，含缓存读取合计=354422；不重复累加 contextTokens。SDK estimatedCost 不是提供商实收账单，也不包含 Codex 工程会话成本。

最终开发 Treatment：非缓存 input +50.3%，input+cache read +12.1%，费用 **+25.1%**，超过冻结的 +20% 写作成本门；不同 cache 命中不能直接等同于 prompt 长度上涨 50%。两组 held-out 费用分别约 +12.7%、+9.6%，合计 +11.1%，正文汉字没有大幅压缩。仅五章共享历史就使反复投影在累积上下文中继续付费，轻量 JSON 本身不保证整体更便宜。规划失败另耗 **0.05564892**，已计入总额；该开销不能隐去或摊称免费的人工规划。

307.141 秒是任务秒数之和，因 Planner 短暂重叠不是墙钟总时长；不包含审计、传输、编译、回归或 CI 等待。held-out Treatment 的个别更快结果不足以证明稳定延迟收益。

## 7. 工程验证、隔离与交付

使用家庭电脑已配置的新加坡 SSH 凭据与严格主机校验。服务器独立 baseline/candidate checkout、独立 projects/runtime 数据根，仅服务器内复制已有授权，不导回、不提交凭据。复用现有 lockfile node_modules/镜像，无新依赖、无端口发布，不覆盖常驻服务。Typecheck/build/Vitest 2 CPU、最多 2 worker；模型 runner 4 GiB。Windows 只做读写、Git/SSH/归档编排，没有新增全量测试或 Docker 构建。

| 检查 | 实际结果 |
| --- | --- |
| 候选初次 typecheck/build | PASS。 |
| 候选初次定向 | 54 PASS / 1 FAIL；新增 Survey 测试替身缺 keyPoints，补齐后保留失败日志。 |
| 首次 linux-checks | build 写 dist 遇 EACCES：早期 root 容器创建输出而脚本按普通 UID 构建；只修正隔离 dist 所有权，未改生产权限。 |
| 候选首轮完整 | 3053 PASS / 43 FAIL / 22 SKIP；新规划要求契约而旧 scripted Runtime 默认输出无字段，补齐普通与 Survey 默认夹具；另修正不真正超限的长度测试输入。没有降低校验。 |
| 候选最终完整 | typecheck/build PASS；3095 PASS / 1 FAIL / 22 SKIP，280 文件 PASS / 8 SKIP，154.53 秒；旧 sectionReviewConcurrency 乱序完成断言失败，不能写全量绿色。 |
| 候选单独复跑 | 原并发文件 4/4 + 新契约文件 5/5 = **9/9 PASS**，3.20 秒；不改断言、超时或跳过。不能把这一单跑冒充同轮完整 3096/3096。 |
| 最终交付树 | 候选撤回后在服务器对最终后端树另跑 linux-checks：typecheck/build PASS，**3091 PASS / 22 SKIP / 0 FAIL**，280 文件 PASS / 8 SKIP，152.48 秒。 |
| Git / 资产 | 候选补丁 `git apply --check` PASS；最终 `git diff --check`、runner `node --check`、冻结 hash / 私人归档核对随发布记录保存。 |
| GitHub CI / Linux Integration | 按最终提交 SHA 检查并在最终汇报/私人 publication 记录公布；报告编辑时未启动本次提交 CI，不把基线或进行中状态写成成功。 |

主要命令：`rg`、PowerShell/Get-Content、`git status/rev-parse/archive/diff/apply --check/add/commit/push`、`ssh/scp`、`docker run`（独立受限容器）、`npm run typecheck/build`、`vitest run --maxWorkers=2`、`scripts/acceptance/linux-checks.sh`、定向单文件复跑、`gh api/run list/view`。直接在 main，不新建分支，不安装依赖。

公开交付仅本报告、研究索引、验收 runner、固定输入/协议/哈希、失败候选 patch 和说明。基线五份关键生产文件经 LF 归一与指定 Git 对象一致。私人归档 SHA256 为 `446b4cac96902acbefed9a99b542763bc0acfcc884bc8beea46238895ee2d963`，Windows 与服务器一致；报告六处核心风险摘录均经脚本验证为原输出的逐字子串。私人原文/上下文/usage、冻结候选哈希、全部失败日志及最终检查位于 `D:\PaperTeamData\M13_7_4`；白名单归档排除 runtime/settings/auth/projects，不将它们打包导出。

## 8. 质量门与未验证范围

| 上线条件 | 判定 |
| --- | --- |
| 明确且可重复的跨章质量收益 | **未达到**：开发未减少完整再述，held-out 两组未出现一致优势。 |
| 必要内容不丢失 | 两主题核心机制、限制和未来工作保留；真实公式/负结果/本文数值的 LIVE 场景未覆盖。 |
| 不新增事实或引用违规 | **未达到**：存在 quote 无覆盖细节和推断。未知 key=0 不等于语义准确。 |
| direct/partial 边界 | 明显 partial 普遍保证未升级；其他机制细节仍越界，不能判完全通过。 |
| 合理 Token 与费用 | held-out 写作增量在预算门内但没有收益；开发最终费用 +25.1%，并有失败规划开销，**未达到**。 |
| 两类 workflow 工程回归 | 实际接入及受控两类调用链得到测试；完整候选有一条并发失败，单跑通过；最终交付树另验。 |
| 新职责能自动稳定生成 | **未达到**：普通三次失败，Survey 两次失败后预算停止。 |

未验证：完整真实 `idea_to_paper`/`topic_survey` E2E、在线供给与真正 synthesis 生成、长篇强制 LIVE session rotation、作者 HITL UI、最终 LaTeX 编译、真实公式/数值/负结果的生成保持、完整 Citation semantic/Grounding/Gate/Revision 闭环、私人论文或提供商账单。既有 Runtime rotation/恢复、事实/公式/引用保护、Survey 和 Existing Paper 回归只证明各自工程契约，不扩大为本轮 LIVE 质量证明。

下一步应先改善字段级修复诊断与最小职责表示，再用新的冻结主题验证“owner 章展开、比较章直接推理”的实际遵守情况；同时考虑在现有 Reviewer 中定位两处原句，让针对性的跨章修订受既有事实与引用保护约束。不要继续追加前文原文，也不要把本失败候选直接恢复到 main。本轮最终结论保持 **PARTIAL**。
