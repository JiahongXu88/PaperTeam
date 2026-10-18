# M14.9.1 — Academic Review Neutrality A/B 与可靠性修复

> 基线 `3c8629b`（M14.9-MOT）。本文只记录机制、口径与汇总结论；被审论文全文、审稿原始输出、投影臂文本与
> 实验账本均在仓库外的实验根（`D:\PaperTeamData\M14_9_1_ReviewNeutrality`），不入库。

## 1. 零模型评分归因（M14.9 冻结产物）

- **74 分来源**：长文档单元模式（`digestIsLossy`）。43 个单元中 36 个有分单元的 `academicScore` 按字符数加权平均
  （7 个仅标题单元不参与），复算 74.405；第 6 轮 11 个单元新执行、25 个请求指纹相同的合法缓存。单元 prompt 只要求单一
  `academicScore`（「本单元学术质量」）——**没有五维 rubric、没有目标档次、没有 80 分文字**；带内复核只在非长文档模式
  执行，74 是单次采样聚合。同一单元内容在不同轮被独立重审的 16 对样本，单元分差 0–14，组内 SD 均值 2.6。
- **元数据可见性**：用生产 `buildReviewCoveragePlan` 逐轮重建 6 轮 × 43 单元，snapshotId 与全部 unitFingerprint 逐一一致；
  作者署名、单位、通信邮箱、红字待确认说明与导言区基金注释全部位于 `\maketitle` 之前，**不在任何单元原文中**。
  因此该 74 分与 81 条 Major 在结构上不可能经由稿件输入受到这些字段影响（证据类型：输入可见性的确定性证明；
  不是对模型内部推理的因果证明）。
- **81 条 Major**：逐条阅读（含定位片段与所在单元处置）后，科研内容 / 学术写作 79、无法验证 2（作者实验数值在证据库
  无已核验记录——工作流证据边界）、投稿格式 / 元数据 0；只读根因聚合 60 个根因、21 条同根因重复（未改变 Gate 计数）。
  全部 6 轮 1,300+ 条 finding 中关键词命中 133 条，语义复核后与署名 / 基金 / Word 排版相关的为 0（「作者」= 作者主张、
  「模板」= 外观模板、「单位」= 统计单位）。第 5→6 轮只改 1 节，Major 59→81，主要来自汇总型单元的重新采样。
- **Gate 失败是两条独立规则**：`academic_score_threshold`（74 < 80）与 `open_critical_major_zero`（major 81）；不能合并
  解释为「扣了 6 分」。
- **独立终审**是另一审稿程序（单次全文、prompt 显式要求检查投稿规范并附期刊指南与 Word 模板全文）：其 M1 为投稿元数据、
  M2 / M8 为格式与写作 / 披露混合、M3–M7 为科研问题；创新性 2/5 来自「H1/H4 属已有机制族变体」的判断，不是 74/100 的分项。

## 2. 输入投影与确定性内容等价门

- `review/blindReviewInput.ts`：raw（原始 LaTeX + 参考文献源）/ naive_text（用户方案：简单 Markdown + 全局关键词整行
  删除）/ structured_blind_md（按 LaTeX 结构转写，公式原文、表格单元格、图注、引用键、参考文献保留，只按字段 / span
  移除作者、单位、邮箱、`\thanks`、致谢、源码注释）/ format_only_md（同一转写 + 回填身份字段）；期刊 PDF 文本层只做同一
  基底上的字段 span 移除（首页作者 / 单位 / 通信作者 / 分类号 / doi / 基金 / 作者简介 / 收稿日期、每页页眉）。
- `review/reviewInputEquivalence.ts`：独立正则从原稿抽取科研清单（数值多重集、数学块、引用键、题注词元、逐表数值、章节、
  参考文献、正文词元），任何缺失 → `INVALID_INPUT`，该臂不得评分。
- 6 个家族上：structured_blind_md 6/6 VALID（LaTeX 家族数值 / 公式 / 引用 / 题注 / 表格 / 参考文献 100%，词元覆盖
  ≥ 99.78%，剩余差异为重音命令）；naive_text 仅 2/6 VALID——在英文锚点与期刊 PDF 上误删「…University…」「吉林大学学报」
  参考文献行、`mAP@0.5`（被当成邮箱）与硬件配置行。元数据变形（换作者 / 单位 / 基金 / 注释 / 致谢）后盲化输出逐字节不变；
  正文「清华大学发布的公开数据集」类句子保留（回归锁定）。

## 3. 影子 A/B（shadow scoring comparator）

- 生产 `ReviewerService.reviewMode({mode:"academic"})`（digest 模式五维 rubric）+ 生产模型路由 + 生产 Skill 注入；每次调用
  全新会话、固定种子随机顺序、无臂标签 / 无门槛 / 无历史分数。它与生产 43 单元模式不是同一评分口径。
- 语料：被审论文 1 族（另一版本只做 QA）、《计算机工程与应用》2026 年已发表论文 2 篇（官网免费 PDF，本地使用）、英文
  MOT 锚点 1 篇评分 + 1 篇只做 QA。M12.1 target-benchmark 名义为该刊但实际无一篇来自该刊、几乎无全文，不能用作样本。
- 预算：任务级账本硬上限 32 次 / 1.5M token；实际 19 次、1,360,844 token（input 102 + output 157,276 + cacheWrite
  1,203,466；cacheRead 201,734 不计入）；第 20 次因「已用 + 在途预留 + 本次预留」超限在启动前被拒，账本持久化
  `BUDGET_EXHAUSTED`，其后计划中的 5 次（被审论文 D 臂第 2 次、锚点 D 臂、身份替换反例）未执行。计费金额：网关不返回，未知。
- 结果（合并组内 SD 2.93；单族差值噪声界 ±5.9）：Δ(盲化 − 原始) 四个家族为 +4.0 / +1.0 / +4.5 / +3.5，方向一致但均未超出
  采样噪声；被审论文朴素臂 Δ −1.0，格式成分 Δ(D−A) −1.5、身份成分 Δ(C−D) +5.5（均 n=1–2）。**finding 层**：被审论文原始
  LaTeX 臂 2/2 次、format_only 臂 1/1 次因题头作者单位 / 通信邮箱占位产出 build 类 major；盲化臂与朴素臂 0/4。期刊 PDF 原始
  臂未因基金 / 作者简介产生任何 finding。盲化臂另有 2 条由 `\multicolumn` 补位位置导致的表格伪影 minor（已修复，未重跑）。
  整稿单次评分对已知的一处「两类场景计数被合并」局部不一致 0/7 检出（生产单元模式检出）。
- 判定（预注册规则）：`METADATA_SCORING_CONTAMINATION = CONFIRMED`（仅 finding 层、仅影子比较器——身份字段可见时稳定
  产出 Major；分数层未超出噪声；生产 74/81 不受影响）；`BLIND_REVIEW_AB_VERDICT = INCONCLUSIVE`。

## 4. 产品改动

- **计划确认透明**（`HitlPlanConfirm.tsx` / `planConfirmView.ts`）：见 existing-paper-revision §9。
- **任务级预算账本**（`runtime/globalBudgetLedger.ts`，接入 `RunBudgetLedgerRuntime`）：调用前预留、超限拒绝、
  `BUDGET_EXHAUSTED` 持久化、上限只紧不松、跨进程锁；env 见 `.env.example`。
- **只读 Manifest 共享**（`ExperimentPackageService.readShared`）：真实 916 文件包上 3 个并发 workflowContext 堆峰值
  2.3 GB → 0.4 GB、RSS 2.44 → 0.80 GB，单次 workflowContext 2.8 s → 0.9 s（共享副本命中时）；写路径仍各自解析，save 后失效。
  剩余边界：单次解析 247 MB manifest 仍需约 0.85–1.4 GB 堆（结构性改造——观测分页 / 去重路径 / 紧凑 JSON——另提方案）。
- **单文件编译修复**（`review/scopedLatexRepair.ts`）：见 existing-paper-revision §9。
- **实验开关（缺省关闭、未经复核）**：`PAPERTEAM_REVIEW_INPUT_MODE=metadata_blind`（digest 视图按字段去身份元数据，保持
  LaTeX 表示）、`PAPERTEAM_REVIEW_NEUTRALITY_POLICY=1`（三路 / 单元 / 跨章 prompt 追加中立条款）。关闭时 prompt 与单元请求
  指纹逐字节不变；80 分门槛、权重与 Gate 规则未改动（`UNVALIDATED_PRODUCT_THRESHOLD` 仍成立）。
- **Harness**：`evaluation/reviewNeutrality*.ts` + `scripts/m1491-review-neutrality.mjs`（`--dry-run` / `--run` / `--compare`，
  配置与语料在仓库外）。
