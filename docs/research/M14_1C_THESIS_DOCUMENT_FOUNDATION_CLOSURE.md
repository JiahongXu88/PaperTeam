# M14.1c — Thesis Document Foundation & Scientific Data Closure

- 日期：2026-10-15
- 基线：`origin/main @ eba490baeb5345e58a3bb9f531efbe9ea9f5944d`（M14.1b COMPLETE）
- 状态：**COMPLETE**（真实材料回归待补，见 §14）
- 开发与验收位置：新加坡 ECS `47.84.30.153`（Ubuntu 24.04.5）`~/paperteam-dev`；Windows 本地仅承担代码编辑 / 同步 / 最终 Git 提交

---

## 1. 初始 Git 基线

- `origin/main` = `eba490b`（docs(m14.1b): close Research Input & Scientific Fact Management）。
- 本轮全部生产改动基于 `eba490b`，交付 commit 见 §16。

## 2. 服务器环境（实测）

| 项 | 值 |
| --- | --- |
| OS | Ubuntu 24.04.5 LTS，内核 6.8.0-139-generic |
| CPU / RAM | 4 vCPU Xeon 6982P-C / 15 GiB（+4 GiB swap） |
| 磁盘 | 根盘 79G（本轮后余 ~28G）；数据盘 /data 196G |
| Node.js | v24.15.0（官方二进制 tarball，`~/node-v24.15.0-linux-x64`，满足根 engines `>=24.15.0 <25`） |
| TeX | texlive-xetex / texlive-lang-chinese / texlive-bibtex-extra / latexmk / biber 2.19（本轮 apt 安装，含 Fandol 与 Noto CJK 字体） |
| gbt7714 | `gbt7714.sty` + `gbt7714-numerical.bst` 可用（GB/T 7714-2015）；biblatex-gb7714 样式不在发行版 → biber 路径用标准 biblatex numeric 验证 |
| PDF 工具 | poppler-utils（pdftotext / pdfinfo） |
| Python | 3.12.3（本轮未用 PyMuPDF：验收走 pdftotext；生产 docling/PyMuPDF 在既有 Docker 镜像内） |

资源瓶颈判定：无。4C/15G 足够承载本轮全部测试（全量 vitest ~90s 峰值内存远低于上限；TeX 全套安装占用 ~4G 根盘后仍有余量）。生产容器（backend-docling / web）与宿主机测试完全隔离，未停止任何既有业务。

服务器连接坑：EIP 已由记忆中的 `47.84.6.91` 变为 `47.84.30.153`（同一物理主机 `iZt4nfjh0vsa2httqmpgziZ`），known_hosts 需 accept-new 接受新地址的 host key。

## 3. 实际开发与测试位置

- 代码编辑：Windows `D:\Projects\PaperTeam`（轻量）。
- 全部测试 / build / 真实 LaTeX 编译：服务器 `~/paperteam-dev`（`tar-over-ssh` 增量同步，node_modules 只装一次）。
- 最终 Git commit / push：Windows（服务器无 GitHub 凭据，不引入新 credential）。

## 4. 已有能力复用情况（不重复造轮子）

| 复用 | 说明 |
| --- | --- |
| `LatexCompiler` | 保留 staging 统一工作目录 / 显式编排 / compile.log / 结构化错误；只扩展后端选择与检测正则 |
| M14.1b 事实契约 | `ScientificFact / FactConflict / TableAlignment / AuthorDecision` 全部加法式扩展（新增 method 枚举值、decision 类型、evidence 可选字段），无第二套冲突系统 |
| `ScientificFactStore` | 原样复用（见 §8 性能实测判决） |
| `SectionReviewScheduler` | 未改动（journal 指纹已绑定分节全文 = 快照失效机制内建） |
| Outline / Writer 契约 | Writer 的 `\section` 输出契约零改动；`manuscript/sections/` 仍是唯一正文事实源 |
| `latexHeadings` | 已支持 `\chapter` 解析，未动 |

真正新增：`thesisDocumentTypes.ts`、`genericCtexbookAdapter.ts`、`thesisAssembler.ts`、`ThesisDocumentService.ts`、`thesisRoutes.ts`、`bodyTextFacts.ts`、噪声表分类、对齐作者裁决、LatexCompiler biber 通道与未定义引用检测修复。

## 5. ThesisDocumentModel 与 generic-ctexbook 模板

### 5.1 文档模型（`backend/src/thesis/thesisDocumentTypes.ts`）

- 覆盖：中文/英文标题、作者与学位信息（**全部可选，不伪造导师/学校**）、中英文摘要、中英文关键词、目录、正文章节、图/表目录、参考文献后端、附录、致谢。
- 章节映射：`ThesisChapter.sections[]` 按 file 引用 outline sections；校验强制**每个 outline section 恰好映射一次**（未映射 = 正文丢失，重复 = 内容重复，均为违规）。
- 单节章一致性：promoted 模式下章标题来自节自身首行标题，模型标题须归一一致。

### 5.2 章节层级：wrapper / promoted 双模式（Writer 不动）

- **wrapper**（多节章）：装配层生成 `\chapter{章标题}` + 各节原样 `\input`（节文件逐字复制）。
- **promoted**（单节章）：对节文件**副本**做同行原地标题改名（`\section→\chapter`、`\subsection→\section`、`\subsubsection→\subsection`、`\paragraph→\subsubsection`；含星号/可选参数形态）——**行数与行号不变**，正文、`\label`、`\ref`、`\cite` 完全不触碰 → logicalSpan / 文件行号映射保持。
- 源目录只读：装配产物进独立 `manuscript-thesis/`，可随时删除重建。
- 确定性：同输入两次装配 byte-identical（测试覆盖）。

### 5.3 generic-ctexbook（默认模板，`fontset=fandol` 可移植字体）

- `ctexbook` + amsmath/amssymb/graphicx；摘要用 `\chapter*{摘要/Abstract}` + `\addcontentsline`（实测 ctexbook 无 abstract 环境——book 基类不带，验收前探明）。
- 参考文献：缺省 **bibtex + gbt7714（GB/T 7714-2015 国标）**；模型可选 biber（biblatex numeric）。无 references.bib 时不加载任何参考文献宏包（biblatex `\addbibresource` 对缺失文件直接报错）。
- 适配器接口（`ThesisTemplateAdapter`：preamble / frontmatter / backmatter）为未来 thuthesis / NJUThesis / ustcthesis 预留注册位；本轮只实现 generic-ctexbook，不冒充任何高校标准，不携带第三方 `.cls`。

## 6. LaTeX 编译路径

### 6.1 BibTeX / Biber 双通道

- 后端解析：**显式配置 > 产物判定**（`main.bcf` 含 biblatex 控制标记 → biber；`main.aux` 含 `\bibdata` → bibtex）。不因一次编译失败改猜。
- 显式配置与文档形态错配（如 biblatex 文档配 bibtex）→ 明确失败，不静默跳过参考文献。
- biber 路径失败检测：非零退出、`.blg` 的 `ERROR/FATAL` 行（真实 biber 形态 `ERROR - …`）、缺失条目（`Missing BibTeX data for citation key`，错误信息列出 key 名）。
- `compile()` 支持按调用覆盖后端（学位论文模型声明流入编译）；`detectTool()` 现报告全部可用后端（如 `xelatex+bibtex+biber`）。

### 6.2 未定义引用漏检修复（M14.0 预研实锤 bug）

旧正则 `/Citation \`[^']+' on page \d+ undefined/` 只认 natbib 反引号措辞；biblatex 警告用**直引号** `Citation 'key' …` → PDF 出现 `[?]` 而编译器声称成功。现在多信号检测：

- 两种引号形态的 `Citation … undefined` 与 `Reference … undefined`（交叉引用也拦）；
- 汇总行兜底（`There were undefined references.` / biblatex undefined citations 摘要行不折行，防长 key 折行漏配）；
- biber 已跑而日志仍要求 `Please (re)run Biber` → 判**引用链不收敛**失败（重跑 xelatex 无意义，不静默通过）；
- Rerun 追加轮次补 biblatex 措辞（`Please rerun LaTeX`）。

### 6.3 超时策略

- 普通论文编译预算不变（`LATEX_COMPILE_TIMEOUT_MS` 缺省 120s）。
- 新增 `LATEX_THESIS_COMPILE_TIMEOUT_MS`（缺省 **600s**，上限 1800s）——依据 M14.0 实测高校模板冷启动 133s+ 超过旧预算；学位论文走独立预算，不把全部任务设为无限。
- `serviceStack` 兜底实例不再硬编码 120_000，改由 config 注入。

### 6.4 真实编译证据（服务器，`scripts/acceptance/thesis-compile-check.mjs`，10/10 PASS）

| 验收项 | 结果 |
| --- | --- |
| generic-ctexbook 装配（10 章 + 附录：promoted 2 / wrapper 9） | PASS |
| bibtex 路径冷启动 | PASS — `xelatex+bibtex`，**1944ms**，PDF 150,407B / **45 页** |
| bibtex 路径热启动 | PASS — 1940ms |
| biber 路径（biblatex） | PASS — `xelatex+biber`，4530ms |
| 缺失引用正确失败 | PASS — `\cite{missing-entry-2026}` → `LATEX_COMPILE_FAILED`（[?] 回归守卫在真实 TeX 上验证） |
| 长章节内容不丢失 | PASS — 5/5 哨兵字符串（含第 10 章 promoted、附录推导）在 pdftotext 抽取文本中命中 |
| 目录 / 章节层级 / 参考文献解析 | PASS — 目录✓ 章节✓ 参考文献✓（gbt7714 样式对英文题名做大小写归一，断言按大小写不敏感）引用编号 [1][2]✓ |
| 双语摘要 | PASS — zh✓ en✓ |
| 页数（长文档形态） | 45 页 |

fixture 纪律：10 章 28 节 + 附录全部为**明确标注的合成测试内容**（每节首行声明），参考文献为合成条目。

## 7. 正文科研事实扩展

### 7.1 确定性正文抽取（`backend/src/thesis/bodyTextFacts.ts`）

- 从 ParsedDocument **文本块原文**建立候选（不从模型生成内容建立来源事实），句切分后按「指标词 / 参数词 / 数据集量词 + 关系词 + 数值」匹配：
  - 数值实验结果 / 指标：准确率、召回率、查准率、mAP、AP、IoU、F1、Top-1/5、PSNR、SSIM、FPS、MOTA、IDSW、耗时/延迟、吞吐等（中英文双词典）；
  - 数据集规模：`118,287 张` / `500 images` 等量词形态 → `dataset` 事实；
  - 方法参数：学习率 / batch size / epochs / 动量 / 权重衰减 / 阈值 / 温度 / 窗口大小 → `parameter` 事实（参数语境关系词可缺省：`学习率 0.001`）。
- provenance：verbatim quote（≤400 字）+ blockId + page + section；数值锚定在关系词后开头（禁止中窗跳跃——`epochs of training on 4 GPUs` 不会把 GPU 数当 epoch 值）；未知字母单位（`88.1 on`）回退纯数值。
- factId 确定性（输入 + 内容版本 + 块 + 序号 + 偏移），重放幂等。
- 数据集语境（`在 X 数据集上` / `on the X dataset`）进入 `key.dataset`；方法名候选（`SSAA 的准确率`）进入 `key.subject`——可比性键由既有 FactKey 承担，**不同数据集 / 指标的数值不会被当作同键冲突**（沿用 M14.1b 纪律）。
- 来源核验：正文事实走既有 `checkQuoteAgainstDocumentText`（quote 对文档全文逐字命中），由 `verifyFacts` 统一驱动——与表格事实同一验证流程。

### 7.2 图内数据边界（如实分级，不夸大）

| 层级 | 处理 |
| --- | --- |
| 文本层可靠暴露（矢量图文字，bbox 与 figure 块相交） | 抽取为事实但 `key.condition=figure_embedded_text` 单独标记——**不参与正文/表格数值比较**，只作候选呈现 |
| bbox 缺失 | 不标记图内（宁缺勿错，不猜「在图附近」） |
| 数值只在图片像素中 | **不产生任何记录**（无 OCR / 视觉理解，如实缺省；留给后续多模态） |

### 7.3 与表格抽取并存

`ResearchInputService.extractFacts` 现在一次产出表格 + 正文事实；`skippedCandidates`（发现数值候选但语境不可靠）透明计数，不猜。

## 8. 表格关系确认与存储优化

### 8.1 候选对齐作者裁决（复用 AuthorDecisionStore，无第二套系统）

- 新决定类型 `table_alignment_confirmation`（confirmed / rejected + rationale）；resume 输入映射 `confirm_table_alignment` / `reject_table_alignment`。
- 确认 → `status=comparable` + `basis=author_decision` + `decisionId` 可追溯 → 进入冲突检测；拒绝 → `not_comparable` + `evidence.rejectionReason`。
- 确定性重算不覆盖作者裁决（`upsertAlignments` 既有 author_decision 保留语义）。
- **决定与内容版本绑定**：alignmentId 由双方 contentHash 派生——版本变化产生新 alignmentId，旧决定不自动适用（测试覆盖）。
- **原始数值不被覆盖**：裁决只改对齐状态，不动任何 fact 的 value（测试覆盖）。
- 候选展示信息：`evidence.columnLabelsSample`（两侧数据列表头样本）+ 既有 rowPairs/计数证据。
- 确定性对齐新增**列重排 candidate 规则**：列标签集合相等但顺序不同（multiset 相等）→ candidate（此前这类形态完全不产生对齐记录 = 漏判）。

### 8.2 噪声表格定向过滤（封面 / 目录误判）

`classifyTableNoise` 保守规则（多条共同证据才判噪声）：

- 目录页码形态：≥2 整列为非降序小整数，或 1 列页码 + 首列 ≥60% 章节标签形态（`第X章` / `Chapter n` / 参考文献 / 致谢 / 附录）；
- 封面区：page≤2 无题注无标签且全部短文本；
- 退化网格：**仅单列**（单行多列的键值形态 `Overall: 0.999` 是真实数据，不判噪声——初版规则误杀此形态，被 M14.1b 既有回归测试拦下后修正）。

双向验证：3 个定向命中用例 + 2 个反例守卫（正文页无题注真实数据表 / 有题注混合数值表不误杀）。噪声表跳过事实抽取与对齐候选并计数（`skippedNoiseTables`），**只降权不删除**——解析产物仍在，误判可人工补登记。

### 8.3 存储性能实测（任务 7.3：先测量再决定）

服务器 `scripts/acceptance/fact-storage-bench.mjs`（合成 M14.0.1 真实观察规模 1,832 facts，两次运行一致）：

```
facts=1832, file=2.40MB
upsertFacts(全量首次写入)  23ms
load()（JSON.parse 全文件） 13ms
list(filter)              15ms → 611 条
applySourceChecks(500条)  44ms（含全文件重写）
heap 增量                  16.0MB
```

**判决：维持单文件存储，不做拆分 / 不引入数据库。** 真实观察规模下最重路径 <50ms，远低于任何可感知阈值；按任务纪律「仍足够就不为技术复杂度重构」。

## 9. Review Coverage 兼容性（低成本复用，不重构）

- `existing_paper_review` 的 `review.aggregate` 报告新增**显式覆盖块** `review.coverage`：`{reviewableSections, reviewed, skipped, failed, complete}`——实际审阅范围可证明；`failedSections > 0` 或 reviewed+skipped 未覆盖全部章节时 `complete=false`，**未完成审查不得冒充 Full Review PASS**（加法式字段，既有消费者不受影响）。
- Snapshot 失效：核实 `SectionReviewScheduler` 的 journal 指纹由分节 chunk 全文 + 引用上下文 + 指令构成——PDF 快照变化 → 指纹失配 → journal 记录不可复用（失效机制本已内建，未重复建设）。
- 不重构 PDF Review 工作流（按任务边界，如需深度改造留给后续里程碑）。

## 10. HTTP 接口（为 M14.2 预留稳定入口）

```
GET  /api/projects/:id/thesis/templates   已实现模板列表
GET  /api/projects/:id/thesis/document    读取模型（无则 model=null）
PUT  /api/projects/:id/thesis/document    保存（对当前 outline 校验；违规 400）
POST /api/projects/:id/thesis/assemble    确定性装配 → manuscript-thesis/
POST /api/projects/:id/thesis/compile     编译装配产物（学位论文预算；同步接口）
```

模型持久化 `manuscript/thesis.json`；编译产物 `build-thesis/paper.pdf`。完整 thesis_from_papers 工作流不在本轮（M14.2）。

## 11. 自动化测试（全部在服务器执行）

| 层 | 文件 | 用例 |
| --- | --- | --- |
| 编译器单元（fake 工具链） | `backend/test/LatexCompiler.test.ts`（扩展） | 28（原 17 + 新 11：biber 通道 5、未定义引用 3 措辞回归、不收敛、错配、rerun 措辞） |
| 文档模型 / 装配 | `backend/test/thesis/thesisDocument.test.ts`（新） | 17（校验 5、层级变换 4、装配 6、模式 1、确定性 1） |
| 正文事实 | `backend/test/thesis/bodyTextFacts.test.ts`（新） | 10（中英指标、数据集/参数、裸数字拒判、图内边界 3、幂等、聚合入口） |
| 对齐确认 / 噪声 | `backend/test/thesis/tableAlignmentConfirmation.test.ts`（新） | 12（噪声 6 含双向守卫、确认/拒绝/版本绑定/resume 映射/NotFound 5、纯函数 1） |
| HTTP | `backend/test/thesis/thesisRoutes.test.ts`（新） | 5 |

新增合计 **72 个确定性用例**。最终权威验证（服务器，全部退出码 0）：后端全量 **3559 passed / 25 skipped（3584）/ 0 failed**、前端全量 **342 passed / 0 failed**、前后端 typecheck、后端 build、`git diff --check`、编译验收 10/10、存储基准复跑（skipped 为既有 env 门控 smoke）。前端无产品改动（无新增 UI）。

## 12. 实际模型调用

**零。** 本轮全部能力为确定性代码 + 真实工具链（xelatex/bibtex/biber）验证，未调用任何 LLM（预算 4 次未用，无 A/B）。模型相关路径（model_candidate 事实、author_decision actor 纪律）由既有与新增单元测试以 test_fixture 覆盖。

## 13. 性能与内存

- LaTeX：冷/热 45 页学位论文 ~1.9s（bibtex）/ 4.5s（biber，biblatex 冷路径多两轮）——服务器 TeX Live 温态；学位论文预算 600s 面向真实高校模板冷启动（预研实测 133s+）。
- 事实存储：见 §8.3。
- 全量 vitest（4 workers）：~90s / 15GiB 机器无压力。

## 14. 已知限制

1. **真实科研材料回归待补**：M14.0.1 语料（范登平 / 李谨杰 / GLP 版本链）在公司电脑 `D:\PaperTeamData\M14_0_1_RealThesisPaperStudy`，家里电脑与服务器均无合法副本——本轮以仓库内确定性 fixture + env 门控 smoke 覆盖工程路径（`PAPERTEAM_M141B_REAL_MATERIAL=1` 门控测试随 M14.1b 保留），真实 PDF 回归标记**待补**（需语料可得时在服务器跑 `m141bRealMaterial.smoke` + 正文抽取扩展对照）。
2. 高校模板适配器（thuthesis 等）未实现（按范围排除）；biblatex-gb7714 样式不在 Ubuntu 发行版 → biber 路径用标准 numeric 样式验证编译链，GB/T 7714 排版样式只在 bibtex 路径。
3. 图内像素数值不做 OCR（如实标记边界，§7.2）。
4. `/thesis/compile` 为同步 HTTP（600s 上限）；长编译的异步任务化留给 M14.2 工作流。
5. 正文抽取词典为常见指标/参数子集，非全量学术词汇（保守宁漏勿错；skippedCandidates 透明计数）。
6. `writer` 仍以 ctexart 语境提示词写作（`WriterService` 的宏包白名单措辞）——学位论文装配不依赖 Writer 改动，但 M14.2 若让 Writer 直接产 thesis 章节，需评估提示词语境（本轮明确不动 Writer）。

## 15. M14.2 准备状态

- ✅ 文档模型 + 模板适配器 + 确定性装配 + 编译（bibtex/biber）+ 独立超时预算 + HTTP 入口。
- ✅ 事实层：表格 + 正文数值 / 数据集 / 参数 / 指标候选 → 三态验证 → 版本绑定冲突 → 作者裁决（含候选对齐）→ planner-context 严格分区。
- ✅ Review：existing_paper_review 覆盖可证明；长文档单元审查（M14.1a）不受影响。
- ⏳ 待 M14.2：`thesis_from_papers` 工作流编排（章节规划 → 逐章写作 → 章级审查 → 事实注入 prompt）、真实语料回归（限制 1）、高校模板第二适配器（可选）、PDF→Word 交付链（已登记待办，见 PROJECT_STATUS）。

## 16. Git 交付状态

- 本轮交付：`docs(m14.1c): close Thesis Document Foundation & Scientific Data Closure`（代码与文档同 commit；详见仓库）。
- 验证：commit 前 `git diff --check`；push 后 `origin/main` 与本地一致；工作区 clean。
- GitHub Actions：本轮无 CI 定义改动；按既有流水线随 push 触发，状态以仓库 Actions 页为准（本轮服务器本地测试不依赖 CI，CI 未完成不宣称替代）。
