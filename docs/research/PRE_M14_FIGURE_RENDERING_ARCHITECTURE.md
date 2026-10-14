# Pre-M14 工作包 A — 学术图表生成技术路线调研（静态分析 + 本机探针）

> **日期：2026-10-13。执行：Claude Code（Pre-M14 调研子代理，静态分析 + 本机探针；A/B 实验章节由主会话补入）。基线：`215de15`（main）。性质：只读调研，未新增任何 Renderer，未安装外部 Skill，未修改产品代码，未执行 git 写操作。**
>
> **一句话结论：PaperTeam 应当采用「统一 Figure Contract + 多 Renderer 架构」作为*架构形态*，但在 M14 内只保留 TikZ/pgfplots 这一个*生产 Renderer*——即「Contract 先行、单 Renderer 落地、Renderer 注册表留空位」。理由：现有 figures 模块的七条不变量（specHash/figId 确定性、datasetHash 自洽、来源锚反查、caption 真实性守卫、manifest lineage、受控插入、Writer 图形白名单）中六条本就与 TeX 无关，只有 FigureCompiler/codegen/latexEscape 三文件绑定 TeX；把它们从 `FigureCompiler.generate` 的隐式耦合里抽成显式接口成本低、收益是让 heatmap/箱线/多面板等图型未来能以受控脚本 Renderer 接入。外部 Skill（TingxiYu/academic-figure-skill）**不能**作为 Renderer 直接接入：其 Copy-First 规则以作者私有数据硬编码脚本为「生产脚本」，多个脚本内含随机模拟数据，QA 只做源码字符串匹配、零数据校验，典型字体基线在中文标签下必然出 tofu（本机探针实证）；它只能作为「排版规范参考」被人工消化，不能作为可执行组件。**

---

## 1. 摘要与建议

| 问题 | 结论 |
| --- | --- |
| 继续单一 TikZ/pgfplots 后端，还是 Contract + 多 Renderer？ | **Contract + 多 Renderer 架构，但 M14 内 Renderer 集合 = {pgfplots-plot, tikz-diagram}**。不在 M14 引入 Python/R 运行时。 |
| 现有 FigureCompiler 能否原样成为 Contract 的一个实例？ | 能。`PlotSpec`/`DiagramSpec` 即 `FigureIntent.spec` 的两个判别联合成员；`computeSpecHash`/`deriveFigId` 即 identity 函数；`GeneratedFigureRecord` 即 lineage 记录——唯一需要泛化的字段是 `assets: { tex; pdf }`（`figureStore.ts:58`）与 `compiler.diagnostics` 自由文本（`figureStore.ts:67`）。 |
| 外部 Skill 可否接入？ | **否（作为 Renderer）**。可作为 typography/color/journal-specs 的参考资料被人工采纳为 codegen 常量；其 `assets/figures/*` 脚本不满足数据真实性、确定性与中文排版三条红线。 |
| 本机依赖现状（证据） | Rscript、dot（Graphviz）、gs、magick、inkscape 均未安装；Python 3.11.9 + matplotlib 3.11.2 + numpy 2.4.6 + pandas 3.0.6 + scipy 1.17.1 在位，**无 seaborn**；MiKTeX 25.12 xelatex/pdffonts 在位，pgfplots/ctex/fontspec/xeCJK/standalone/svg 宏包齐备。 |
| 中文字体（探针） | pgfplots+ctex：SimSun CID TrueType 子集嵌入，矢量，17.9 KB，首编 4.6 s / 二编 3.2 s；matplotlib 默认字体：中文全部落到 LastResortHE 占位字形（tofu）但文本层仍可抽出中文——**"抽得出字 ≠ 画得出字"**；Skill 基线写法（`font.family="sans-serif"` + `font.sans-serif=[...]`）**不触发字形回退**，必 tofu；只有 `font.family=["Arial","SimSun"]` 列表形态才回退成功。 |
| 不能牺牲的维度 | 数据逐字节来源 + hash 绑定（`assertOriginFaithful`）、caption 真实性硬闸、确定性身份（同 spec 同 figId）、零 LLM 生成数值、Writer 不手写图形命令、受控插入路径。任何 Renderer 接入都必须通过同一套闸门，否则不接。 |

---

## 2. 现状基线：FigureCompiler 能力边界与不变量（带坐标）

### 2.1 模块清单（`backend/src/figures/`，共 12 文件 3,938 行）

| 文件 | 行数 | 职责 | TeX 绑定？ |
| --- | --- | --- | --- |
| `spec.ts` | 635 | typebox schema（`PlotSpecSchema` L175–205、`DiagramSpecSchema` L207–239）+ 语义校验 + 规范化。`PlotType = line \| bar \| grouped_bar \| scatter`（L84）；`semantic` 仅元数据不派生 renderer（L85–86）；`computeDatasetHash = fingerprintJson({columns, rows})`（L261–263）；datasetHash 不一致 → 硬拒（L326–330）；missingPolicy reject/skip_row 不填 0（L384–390）；DiagramSpec Kahn 判环（L564–594）。 | **否**（唯一 TeX 痕迹：文件头注释提到转义在 codegen；node id slug 白名单 L62 是为 TikZ node 名安全，但本身是通用约束） |
| `pgfplotsCodeGen.ts` | 229 | `formatNumber`（L48–61：toFixed(10) 去尾零、≥1e21 BigInt，无科学计数）；`prepareRows` 稳定排序（L74–129）；`renderPlotTeX`（L182–229）standalone + `\pgfplotsset{compat=1.18}` 钉死；CJK 探测 → 条件 `\usepackage[UTF8]{ctex}`（L209–212）。 | **是** |
| `tikzCodeGen.ts` | 275 | 布局全在 TS 侧算绝对 mm 坐标（L35–42 常量；`layoutPipeline` L68–164 最长路径分层；`layoutComparison` L167–191）；样式块固定（L45–56）。 | **是** |
| `latexEscape.ts` | 124 | 唯一转义出口（L53–71 全套特殊字符、`\`→`\textbackslash{}`）；`containsCjk` 码点谓词（L101–124）。 | **是**（转义），`containsCjk` 通用 |
| `FigureCompiler.ts` | 471 | spec 校验 → specHash/figId → 缓存（L294–303）→ `xelatex --version` 探测（L442–455）→ codegen → mkdtemp 隔离 → 单遍 xelatex（L326–330）→ 五类失败（L154–159：invalid_spec / tool_unavailable / package_missing / compile_failed / timeout）→ `%PDF-` 魔数（L396）→ `persistFigure`。默认超时 60 s（L265）。 | **是** |
| `figureStore.ts` | 279 | `computeSpecHash`（L38）、`deriveFigId = fig-<12hex>`（L43）；`GeneratedFigureRecord`（L47–68）；原子写；`planInsertion` supersededBy lineage（L214–239）。 | 仅 `assets: { tex: string; pdf: string }`（L58） |
| `datasets.ts` | 234 | ParsedTableBlock / 连续 structured_record 游程 → `DatasetPayload`；`coerceCell` 确定性数值化（L53–79：不补零不发明）；三类身份 source_parsed / manual / diagram（由 FigureService.toView L390–395 投影）。 | **否** |
| `truthfulness.ts` | 401 | caption 数值声明三桶 value/delta/relative + count/ignore（L95–127）；数值面只取 `spec.data.x` 与 `series` 列（L231–238）；>100 行跳过差值 → unverified（L131）。 | **否**（输入是 `NormalizedPlotSpec`，只读 `data.*` 与 `axis.xLabel/yLabel`） |
| `FigureService.ts` | 748 | per-project 串行锁（L141–155）；`generate` 内 `assertOriginFaithful`（L297–318：origin 声称 source 块 → 重新提取并比对 datasetHash，不等 → `FigureDatasetStaleError`）；`stalenessOf`（L412–454）；`insert` 硬闸：caption violation 422 / unverified 需 `confirmUnverified` / 陈旧 409 / 已有论文禁 append（L509–552）。 | **否**（通过 `compiler.generate` 间接依赖） |
| `insertion.ts` | 206 | 确定性 figure 环境 emitter（L38–50：路径恒 `figs/generated/<figId>.pdf`）；宽度白名单（L35）；append/replace 纯函数。 | 产物形态是 LaTeX，但只依赖 PDF 资产名 |
| `insertionRecovery.ts` | 157 | write-ahead intent + 前后指纹校验恢复；校验 `assets.pdf === <figId>.pdf`（L65–66）。 | **否** |
| `writerGraphicsGuard.ts` | 79 | Writer 输出恒禁 tikz/pgfplots 环境与宏包；`\includegraphics` 多重集与基线一致。 | 守卫对象是 TeX，但与 Renderer 无关 |

相邻：`vision/figureAssets.ts:69` `GENERATED_ASSET_PATTERN = /^fig-[0-9a-f]{12,64}\.pdf$/`（生成图资产只服务 PDF）；`latex/LatexCompiler.ts` 整稿编译与图编译刻意分层（`FigureCompiler.ts:4–11` 说明有意不共享 spawn 实现）；`latex/diagnostics.ts:37–47` `FONT_ISSUE_PATTERN/HINT`。消费方：`httpServer.ts`（8 端点）、`serviceStack.ts`、`writer/WriterService.ts`（三处禁令 + 双挂点守卫）。工作流 `definitions.ts` 对 figures 零引用（图表链目前不在 Orchestrator stage 内，仅 HTTP/UI 驱动）。

### 2.2 不变量清单（哪些是后端无关的）

| # | 不变量 | 落点 | 后端无关？ |
| --- | --- | --- | --- |
| I1 | 同规范化 spec → 同 specHash → 同 figId；数据变必改 specHash（canonical 范围含 inlineDataset） | `figureStore.ts:11–19`, `spec.ts:5–16` | 是 |
| I2 | datasetHash 必须与 inlineDataset 内容一致，否则 invalid_spec | `spec.ts:326–330` | 是 |
| I3 | 声称 source 锚的数据必须逐字节等于来源块当前内容 | `FigureService.ts:297–318` | 是 |
| I4 | caption 定量声明须被 dataset 支撑；无法校验 → UNVERIFIED 要作者确认；insert 是硬闸 | `truthfulness.ts`, `FigureService.ts:519–546` | 是 |
| I5 | manifest append-only lineage（supersededBy），资产永不删 | `figureStore.ts:197–239` | 是 |
| I6 | 插入路径恒由 figId 派生；Writer 不得手写 `\includegraphics`/tikz | `insertion.ts:45`, `writerGraphicsGuard.ts` | 是 |
| I7 | 字节确定性 TeX（同 spec 同 .tex）；PDF 字节级可复现**不在 v1**（M12.0 §13 诚实降级） | `pgfplotsCodeGen.ts:6–17`, M12.0 §13 | **绑定 TeX**（但「源级确定性」概念可迁移） |
| I8 | 零 LLM 参与图表链（spec 由表单/确定性提取产生；LLM 起草 DiagramSpec 未实现） | Batch 3 §18.3 | 是（契约层面） |

### 2.3 静态分析新发现（对现状的两条诚实记录）

1. **`Missing character` 在 exit 0 时不被上报。** `FigureCompiler.ts:344–379` 只在 `result.code !== 0` 时读取日志并匹配 `FONT_ISSUE_PATTERN`（该模式含 `Missing character`，`diagnostics.ts:37–38`）。本机探针（§5.2）显示：去掉 ctex 的 pgfplots 中文图 xelatex **exit 0**、产出合法 PDF、日志含 21 行 `Missing character`、字形缺失。现有 codegen 靠 `containsCjk` 条件插入 ctex 规避了这一路径，但对「ctex 在位却缺某个生僻字/符号」的情形仍是静默。建议（M14 可做）：成功路径也扫描 `.log` 的 `Missing character` 计数并写入 `compiler.diagnostics`，或升级为 `compile_failed`。
2. **`GeneratedFigureRecord.assets` 形态把 `tex` 定为必填**（`figureStore.ts:58`），`insertionRecovery.ts:65–66` 只校验 `assets.pdf`。若将来加入非 TeX Renderer，`tex` 需泛化为 `source: { kind: "tex" | "script"; file: string }`——这是 Contract 化时唯一需要 schema 迁移的字段（manifest `schemaVersion` 1 → 2，可加载旧记录做 additive 兼容）。

---

## 3. 外部 Skill 解剖：TingxiYu/academic-figure-skill（commit `1df9940`，Apache-2.0）

来源：`D:\PaperTeamData\AcademicFigureSkillEvaluation\skill-source\academic-figure-skill`（只读）。

### 3.1 结构与统计（实测）

| 项 | 数值 / 事实 |
| --- | --- |
| `assets/figures/` 目录数 | 32（其中 `basic-plots` / `multipanel` / `other` 仅 `_README.md`，无脚本；实际有脚本的图型目录 29） |
| Python 脚本 | 51（assets 35 + scripts 16）；R 脚本 20（`.R` 16 + `.r` 4） |
| 预览 PNG / PDF | 108 PNG + 7 PDF，`assets/` 共 83 MB |
| 数据文件 | **0 个** CSV/TSV/XLSX/JSON 随脚本分发 |
| Python 依赖（`^import/^from` 顶层模块计数） | matplotlib 70、numpy 35、pandas 10、scipy 7、sklearn 3、seaborn 3、statannotations 2、sankeyplot 1、dateutil 1 |
| R 依赖（`library()` 计数） | ggplot2 16、dplyr 12、tidyr 6、patchwork 6、MASS 4、GGally 4、linkET 3（GitHub-only，经 devtools 3）、ggplotify 3、data.table 3、RColorBrewer 3、ComplexHeatmap 3（Bioconductor）、viridis / tidyverse / ggridges / ggnewscale / factoextra / circlize / FactoMineR 各 2、vegan / showtext / readr / grid / forcats / Matrix 各 1 |
| `scripts/` | 16 个工具脚本共 6,383 行：`compose.py` 586、`qa_validator.py` 270、`generate_atlas.py` 1,655、各类 check_* 与 eval/benchmark runner |
| 许可证 | Apache-2.0（`LICENSE`）；README_EN L84：「示例图由项目**私有数据资产**生成，仅作风格参考……私有资产持续更新，关注公众号」 |

### 3.2 工作流与「Copy-First」规则的真实语义（SKILL.md）

- Step 4/5：匹配到 `assets/figures/<type>/` 脚本 → **复制整个脚本，只改数据路径那一行**（"Modify ONLY the data path"），`subprocess.run` 执行，产出 PNG 再由 `compose.py` 以 `Image.open()/imshow` 贴入面板（"native run"）。
- 「VISUAL ADAPT」：列名不同时搜索替换列名；「Data range compatibility check」允许在数据含 ≤0 时**丢弃 log 变换**、零值域时**跳过归一化**——即视觉系统优先于数据语义。
- 数据完整性规则写得很硬（"Use ALL user-provided data… Reducing it is fabricating evidence"），但执行主体是 LLM 自律，没有任何机器闸门。

### 3.3 对数据真实性的含义（关键风险，带坐标）

| 发现 | 证据 | 含义 |
| --- | --- | --- |
| 「生产脚本」内数据硬编码 | `assets/figures/BarAblation/plot_bar_ablation.py` L7–18：`'result': np.array([0.88, 0.84, 0.82, 0.81, 0.74])`；`LineTrend/plot_trend.py` L8–16：33 个月出版计数矩阵硬编码 | 「只改数据路径」对这类脚本**无路径可改**；LLM 要么改字面量（失去「只改一行」保证），要么保留作者数据出图（**直接产出假数据图**） |
| 随机模拟数据 | `volcano/rnaseq_deseq2_standard.py` L76–87：`np.random.seed(42) # Remove in production` 生成 log2FC/p 值；`CorrelationMatrix/*.R` 读 `simulated_data.csv`；`DensityHeatmap/plot_DensityHeatmap.R` L33 `matrix(rnorm(12*12))`；`GroupedBarChart/*.py` L77–83 `np.random.normal` 抖动点；`StackedBarScatter.py` L323–324 以 `default_rng` 噪声**造出两组新数据列** | 预览 PNG 与「生产质量」声称建立在模拟/私有数据上；复制执行等于把模拟数据带入论文 |
| 读取不存在的私有文件 | `KernelDensity/*.R` 读 `real_value.csv`/`pred_value.csv`；`MantelCorrelation/plot_MantelCorrelation1.r` L13–14 读 `./dataset/微生物数据.txt`、`环境数据.txt`；`PCA/plot_PCA.R` 需三文件 TSV | 脚本不可复现运行；`assets/` 零数据文件 |
| QA 不校验数据 | `scripts/qa_validator.py` 全部检查（AP-0..AP-7, CL-1..CL-7）是对**脚本源码的字符串/正则匹配**（如 L41–45 检查 `"font.family"` 字符串是否出现、L71–85 检查 `cmap='jet'` 字面量）；Pass 2/3（VI/VV）明确标注「LLM-executed」 | 不存在 datasetHash、来源锚、caption↔数据一致性等任何机器可验证的真实性检查 |
| 「向量优先」与实现矛盾 | `compose.py` `compose_cross_language` L~470–510：R 面板经 `png(type="cairo")` 栅格化后 `mpimg.imread → ax.imshow` 贴入；最终 `save_cns_figure` 输出的 "vector PDF master" 中 R 面板是 300 dpi 位图 | 混合 Python/R 多面板的「矢量交付」只对 Python 面板成立 |
| 字体基线与中文冲突 | `references/typography.md` COPY VERBATIM 块：`"font.family": "sans-serif", "font.sans-serif": ["Arial","Helvetica","Liberation Sans"]`；`checklist.md` AP-7 把非 Arial/Helvetica 判 FAIL | 本机探针 §5.1：该写法下中文全部 tofu；且规则禁止换成 CJK 字体 |

### 3.4 Skill 中可借鉴的部分（人工消化，不作可执行接入）

- `references/journal-specs.md`/`export-specs.md` 的物理尺寸纪律（89 mm / 183 mm 栏宽、≥5 pt 字号下限、pdf.fonttype 42）→ 可映射为 `RenderOptions` 的 `widthMm` 预设与 codegen 字号常量。
- `color-palettes.md`/`compose.py` 的 CATEGORICAL/DIVERGING 六色与期刊变体 → 可作 pgfplots `cycle list` 常量（纯数据，Apache-2.0 允许，需保留 NOTICE）。
- `figure-contract.md` 的「一图一结论 / 证据链 / 评审风险」五点 → 可作为 FigureIntent 的 `claim`/`evidenceRole` 字段的产品语义参考（非代码）。
- `multipanel-layout.md` 反冗余审计 → 若将来做多面板（pgfplots `groupplots`），作为设计检查单。

---

## 4. 技术路线对比表

路线：**R1** PaperTeam pgfplots/TikZ（现状）；**R2** Matplotlib/Seaborn；**R3** R ggplot2 / ComplexHeatmap；**R4** Graphviz/Mermaid/TikZ 流程图；**R5** Skill 的 compose.py 混合多面板；**R6** PDF/SVG 交付与 LaTeX 插入方式。标注「实证」= 本仓库/本机证据；「推断」= 基于文档或常识。

### 4.1 维度 (1)–(2)：图型覆盖

| 维度 | R1 pgfplots/TikZ | R2 Matplotlib | R3 R | R4 流程图工具 | R5 compose.py |
| --- | --- | --- | --- | --- | --- |
| 常规统计图 / 对比 / 消融 | line/bar/grouped_bar/scatter 4 型（实证 `spec.ts:84`）；箱线/小提琴/误差棒/热图**未实现**（pgfplots 本身支持 `boxplot`、`matrix plot`、error bars——推断：模板扩展成本中等，每型一个 codegen 函数 + golden） | 全覆盖（实证：Skill 35 脚本覆盖 29 型）；seaborn 本机未装 | 全覆盖；ComplexHeatmap 是生信热图事实标准（推断） | 不适用 | 面板排版层，图型由 R2/R3 提供 |
| 热图 | pgfplots `matrix plot`/`colormap` 可做数值热图（推断）；聚类树状图需自算布局 | `imshow`/seaborn `clustermap` | ComplexHeatmap 最强 | — | — |
| 算法结构 / 模型框架 / 流程图 | DiagramSpec 两模板 pipeline/comparison，DAG only，TS 侧确定性布局（实证 `tikzCodeGen.ts`）；无自由形状/环路 | 不适合 | 不适合 | Graphviz `dot` 自动分层布局最成熟但本机未装（实证 `which dot` 空）；Mermaid 需 headless Chrome（M12.0 §12 表）；TikZ 自身 `graphdrawing` 库需 LuaTeX（推断） | — |

### 4.2 维度 (3)：数据真实性与可追溯

| 维度 | R1 | R2 / R3（自写模板） | R2 / R3（Skill 脚本） | R5 |
| --- | --- | --- | --- | --- |
| 数据能否逐字节来自来源 | **是**：inlineDataset 内嵌 spec、datasetHash 自洽、`assertOriginFaithful` 反查（实证 I2/I3） | **可以**，前提是 host 以文件注入数据、脚本只读该文件、脚本本身受版本控制（推断） | **否**：数据硬编码/模拟/私有（实证 §3.3） | 面板来源若是 R 脚本 PNG，数据链断在栅格化处 |
| hash 绑定 | specHash 覆盖 inlineDataset（实证） | 需 Contract 把 datasetHash + scriptHash + envFingerprint 纳入 identity（见 §6.3） | 无 | 无 |
| 防模型编数据 | 零 LLM 参与（实证） | 若 LLM 写脚本则不可防；若脚本是产品模板则可防 | SKILL.md 靠 LLM 自律 | 同左 |
| caption 真实性 | `truthfulness.ts` 只依赖 `spec.data`，**对任何 Renderer 可复用**（实证） | 同左可复用 | 不存在 | 不存在 |

### 4.3 维度 (4)：中文字体与排版质量

| 维度 | R1 | R2 | R3 | R4 | R6 插入方式 |
| --- | --- | --- | --- | --- | --- |
| 字体与正文一致 | **原生一致**：ctex 自动选字体与手稿 ctexart 同依赖面（实证 `latexEscape.ts:92–98`；探针：SimSun + CM/LM 嵌入） | 默认 DejaVu Sans / Arial，与正文宋体/LM 不一致（探针）；`pgf` backend 可借 TeX 排字但要求 Python 侧也装 TeX 并双倍编译时间（推断） | cairo_pdf + showtext 可嵌中文，字体需系统安装；与正文一致性靠人工选同名字体（推断） | Graphviz 中文需 fontconfig 配置（推断） | `\includegraphics{pdf}`：字体在图内自带，正文无感；`svg` 包需 inkscape 外部转换（本机未装，实证）；`standalone` 已是 R1 现状 |
| 公式字体 | `$...$` 原生 LaTeX 数学（推断：codegen 目前全量转义 `$`，公式**未开放**，`latexEscape.ts:56–66`） | mathtext 近似或 `usetex`（再依赖 TeX） | plotmath，非 LaTeX | 无 | — |
| 尺寸单位 | `widthCm/heightCm`（`spec.ts:101–105` 4–40 cm）；pgfplots `width` 含轴标签 | mm→inch 换算，`bbox_inches="tight"` 会改变最终尺寸（Skill 自己在 `_panel_label` 注释里承认裁切问题） | mm 直接 | — | 插入宽度白名单 `0.x\textwidth`（`insertion.ts:35`） |
| 中文回退行为 | 探针：有 ctex 完整；无 ctex **exit 0 静默缺字**（§2.3 发现 1） | 探针：默认 tofu（LastResortHE）；`font.family` 列表形态回退成功；`font.sans-serif` 形态**不回退** | 推断：无 showtext 时 cairo 直接缺字 | — | — |

### 4.4 维度 (5)：Windows/Linux 一致性

| 维度 | R1 | R2 | R3 | R4 |
| --- | --- | --- | --- | --- |
| 字体回退 | Windows 中易 / TeX Live Fandol，由 ctex 决策；CI 容器 figure-smoke 含 CJK 用例（实证 M12.2.5 §3.4） | Fandol **对 matplotlib 不可见**（探针：`findfont("FandolSong")` NOT FOUND，字体只在 MiKTeX 树）→ Linux 容器需另装 `fonts-noto-cjk` 且脚本按名引用；Windows 用 SimSun、Linux 用 Noto → **同 spec 不同字形/不同 PDF** | Windows GDI vs cairo 差异是 Skill 自述「#1 recurring bug」（`r-rendering.md`） | fontconfig 差异（推断） |
| dpi / 栅格 | 纯矢量，无 dpi 概念 | 矢量为主，`rasterized=True` 与 PNG 面板引入 dpi | cairo 300 dpi PNG 面板 | — |
| 路径 / spawn | `IS_WINDOWS` shell 门控已有（`FigureCompiler.ts:87–99`） | 需同款 spawn seam；Python 可执行名 `python`/`py -3`/`python3` 三态（仓库 docling 子进程已有先例） | `Rscript` 路径三态 | `dot` 路径 |
| 确定性 | .tex 字节级同；PDF 含时间戳（I7） | matplotlib PDF 含 CreationDate 与字体子集名随机前缀（探针：同脚本两次运行子集 tag 不同，如 `HLCUZM+`/`BJCAQE+`）→ 字节级不可比，需 `SOURCE_DATE_EPOCH` + metadata 固定（推断） | 同左 | 同左 |

### 4.5 维度 (6)：依赖与维护成本

| 路线 | 新增运行时 | 本机现状 | Docker 镜像影响 | 维护面 |
| --- | --- | --- | --- | --- |
| R1 | 零（TeX 已是正文编译必需） | 全在位 | 已含 texlive-pictures/latex-extra/lang-chinese（实证 `Dockerfile:51–59`，刻意不装 texlive-full） | TS 代码，与仓库同语言同测试 |
| R2 | Python 3 + matplotlib + numpy（+pandas/scipy 按需）；seaborn 可选 | Python/matplotlib 在位，seaborn 缺 | 基镜像目前无 Python 科学栈（docling 变体 +~4 GB torch，M12.2.5 §3.5）；matplotlib+numpy 约 +150–250 MB（推断） | 第二语言、版本漂移（matplotlib 3.x 默认样式变化）、字体安装 |
| R3 | R + CRAN/Bioconductor/GitHub 包（linkET 需 devtools 从 GitHub 装——国内网络不可达问题仓库已有记录） | **Rscript 未安装** | r-base + ggplot2 + ComplexHeatmap 约 +500 MB–1 GB（推断） | 第三语言；Bioconductor 版本锁定复杂 |
| R4 | Graphviz 二进制 / Node mermaid-cli + Chromium | **dot 未安装** | graphviz 约 +50 MB；Chromium +300 MB（推断） | 布局非 TS 可控 |
| R5 | R2 + R3 + PIL | — | 叠加 | 最高 |

### 4.6 维度 (7)：与 FigureService / FigureStore / Truthfulness Guard 的兼容性

| 组件 | 与 Renderer 的耦合 | 接非 TeX Renderer 需改动 |
| --- | --- | --- |
| `FigureService` | 只调 `compiler.generate({kind, spec, store})`（L278/L288） | 把 `compiler` 换成 `RendererRegistry.resolve(intent).render(...)`；其余（锁、反查、守卫、插入）零改动 |
| `FigureStore` | `assets.tex` 必填 | `assets.source` 泛化 + schemaVersion 2 |
| `truthfulness.ts` | 无 | 无 |
| `datasets.ts` | 无 | 无 |
| `insertion.ts` / `figureAssets.ts` | 只认 `fig-<hex>.pdf` | 无（要求所有 Renderer 产出 PDF 主件；SVG/PNG 只能作附属预览） |
| `writerGraphicsGuard.ts` | 无 | 无 |
| HTTP/UI | `kind: "plot" \| "diagram"` 两值 | `kind` 扩展为 Contract 的 intent 判别键；UI 表单按 capability 显示 |

---

## 5. 本机探针结果

探针目录：`D:\PaperTeamData\AcademicFigureSkillEvaluation\scratch-arch\`（仓库外，426 KB，含 `probe_mpl.py`、`probe_pgf.tex`、`probe_pgf_noctex.tex`、全部 PDF 与 .log）。环境：Windows 11、Python 3.11.9、matplotlib 3.11.2、pymupdf（`fitz`）、MiKTeX 25.12（XeTeX 4.16）、`pdffonts` 来自 MiKTeX。总耗时约 6 分钟。

### 5.1 matplotlib 中文标签 PDF（同一张 89 mm × 60 mm 折线图，中英混排标题/轴名/图例，`pdf.fonttype=42`）

| 配置 | 字节 | 嵌入字体（pdffonts，全部 `emb=yes sub=yes`） | 结果 |
| --- | --- | --- | --- |
| 默认（DejaVu Sans） | 17,477 | `DejaVuSans` + **`LastResortHE-Regular`** | 中文全部为 LastResort 占位字形（tofu）；**但 `fitz.get_text()` 仍抽出「训练轮次 Epoch…准确率」**（ToUnicode 映射存在）——文本抽取通过而视觉失败 |
| `font.sans-serif=["SimSun","Arial"]` | 21,543 | `SimSun` ×2 子集（CID TrueType Identity-H） | 正确；拉丁字符也用 SimSun（与期刊 Arial 要求冲突） |
| `font.sans-serif=["Arial","SimSun"]`（Skill 基线写法 + 加 CJK 尾项） | 30,149 | `ArialMT` + `LastResortHE` | **不回退，tofu**；`font.sans-serif` 的语义是「取第一个可用字体」，不是字形级回退 |
| `font.sans-serif=["Arial","SimHei"]` / `["Arial","Microsoft YaHei"]` / fonttype 3 | 25,919 / 25,919 / 16,393 | 同上 ArialMT + LastResort | 同上，与 TTC/TTF 无关 |
| **`font.family=["Arial","SimSun"]`**（列表直接放 family） | 27,537 | `ArialMT` + `SimSun` | **回退成功**：拉丁 Arial、中文 SimSun |
| `font.family=["Arial","SimHei"]` | 24,985 | `ArialMT` + `SimHei` | 回退成功 |
| `["FandolSong","Arial"]` | 30,149 | `LastResortHE` + `ArialMT` | FandolSong 对 matplotlib 不可见（仅在 MiKTeX 字体树 `fonts/opentype/public/fandol/`，不在系统字体目录） |

字体管理器可见的 CJK 字体：DengXian、FangSong、KaiTi、Microsoft YaHei(UI/Light)、NSimSun、SimHei、SimSun(-ExtB/-ExtG)。Noto Sans/Serif SC-VF 在 `C:\Windows\Fonts` 但 matplotlib 3.11 对可变字体 VF 的处理未探（推断：按名不可用）。每图渲染 0.75–1.0 s。全部 PDF 0 个 image 对象、34 个 drawing 对象 → 矢量。

**结论**：matplotlib 能嵌中文、能矢量，但 (a) 正确写法与 Skill 强制的 COPY VERBATIM 基线互斥；(b) 跨平台字体名不同导致同 spec 不同 PDF；(c) 「文本可抽出」不能作为中文正确渲染的验收依据，必须查嵌入字体表（是否出现 LastResort）或栅格比对。

### 5.2 pgfplots 中文标签 PDF（同数据，standalone + pgfplots compat 1.18，codegen 同款骨架）

| 配置 | exit | 耗时 | 字节 | 嵌入字体 | 结果 |
| --- | --- | --- | --- | --- | --- |
| `\usepackage[UTF8]{ctex}`（= `containsCjk` 命中后 codegen 实际产出） | 0 | 首次 4,608 ms / 二次 3,163 ms | 17,933 | `CMR10`、`CMMI10`（Type 1C）、**`SimSun`（CID TrueType）**、`LMRoman10-Regular`（CID Type 0C），全部 emb/sub | 正确；0 image、20 drawing → 矢量；`get_text()` 含「准确率」 |
| 无 ctex | **0** | 2,280 ms | 8,672 | `CMR10`、`CMMI10`、`LMRoman10` | **静默缺字**：日志 21 行 `Missing character: There is no 训 in font [lmroman10-regular]`；文本层抽出 `\uffff`；PDF 合法 |

**结论**：(a) R1 的中文正确性完全依赖 `containsCjk` 探测——它是守卫而非兜底，`.log` 的 `Missing character` 在 exit 0 下不被 `FigureCompiler` 读取（§2.3）；(b) ctex 使编译时间 +40–100%，PDF +9 KB（SimSun 子集），仍远小于 matplotlib 同图；(c) 字体族与手稿（ctexart → 同一 ctex 决策）天然一致，这是 R2/R3 无法免费获得的。

### 5.3 依赖现状（证据）

```text
which Rscript dot gs magick inkscape  → 全部 not found
python -c "import seaborn"            → ModuleNotFoundError
kpsewhich pgfplots.sty ctex.sty fontspec.sty xeCJK.sty standalone.cls svg.sty pgf.sty tikz.sty → 全部命中
```

对 Skill 的直接含义：其 20 个 R 脚本（含 3DHeatmap、DensityHeatmap、CorrelationMatrix、PCA、Mantel、Ridge、KDE、PairedBox 等 11 个图型目录）在本机**一个都跑不了**；3 个 seaborn 脚本、2 个 statannotations、1 个 sankeyplot 脚本亦不可运行。SKILL.md Step 2 对此的处置是「告诉用户装 R，或接受 Python 回退（更低质量）」——即用户侧安装负担。

---

## 6. 架构建议与最小接口草案

### 6.1 裁决

**采用统一 Figure Contract + Renderer 注册表；M14 只注册两个既有 Renderer（`pgfplots-plot@1`、`tikz-diagram@1`）。** 不是「为了接 Skill 而多 Renderer」，而是「把 FigureService↔FigureCompiler 之间已经存在的隐式契约显式化」。收益：(1) 未来加 heatmap/boxplot 可先在 pgfplots 内加模板，若确需 matplotlib（如密度/流形图），接入点与闸门已就位；(2) 测试 seam 从 `runner` 注入（`FigureCompiler.ts:254`）提升为 Renderer 注入，HTTP 集成测试不变；(3) manifest 记录带 `renderer` 字段后，lineage 可追溯「这张图是谁画的、用什么环境画的」。

拒绝的替代：
- **直接接入 Skill 作为 Renderer**——违反 I2/I3/I8（§3.3）。
- **现在就加 Python Renderer**——没有具体图型需求驱动；破坏 Node-only 部署面（M12.0 §11.1 表、§17 拒因仍成立）；中文一致性倒退（§5.1）。
- **保持隐式耦合不动**——`assets.tex` 必填与 `kind` 两值硬编码会让第一次扩展变成散弹式修改。

### 6.2 最小接口草案（TypeScript，仅类型，不实现）

```ts
// ---- 1. FigureIntent：作者/系统想要什么图（Renderer 无关） ----
export type FigureKind = "plot" | "diagram";          // 现状两值；future: "heatmap" | "multipanel"
export interface FigureIntent<S = unknown> {
  kind: FigureKind;
  /** 规范化后的 spec（PlotSpec / DiagramSpec 是其两个既有实例） */
  spec: S;
  /** 可选渲染偏好：缺省由注册表按 kind 选唯一 Renderer */
  renderer?: RendererId;                              // "pgfplots-plot@1" | "tikz-diagram@1"
  /** 面向产品的语义（只作标注/检索，不派生 renderer；对齐 spec.semantic） */
  semantic?: "benchmark_comparison" | "ablation";
}

// ---- 2. Dataset provenance（现状 DataOrigin + datasetHash 原样） ----
export type DataOrigin =
  | { sourceId: string; blockId?: string }            // 已解析 Source 块（可反查、可检陈旧）
  | { origin: "manual"; note: string };               // 手工数据如实标注
export interface DatasetProvenance {
  origin: DataOrigin;
  datasetHash: string;                                // fingerprintJson({columns, rows})
  inlineDataset: InlineDataset;                       // 数据一等公民，内嵌于 spec
}

// ---- 3. Renderer capability ----
export type RendererId = `${string}@${number}`;
export interface RendererCapability {
  id: RendererId;
  kinds: readonly FigureKind[];
  /** 该 renderer 能处理的 plotType / diagram variant 子集（用于 UI 与校验） */
  supports: { plotTypes?: readonly string[]; variants?: readonly string[]; cjk: boolean; math: boolean };
  /** 产出主件恒为 PDF；附属件可选 */
  outputs: { primary: "pdf"; auxiliary: readonly ("tex" | "svg" | "png" | "script")[] };
  /** 外部进程需求（探测与 doctor 用） */
  toolchain: { command: string; probeArgs: readonly string[]; packages?: readonly string[] };
  /** 该 renderer 的「源级确定性」声明 */
  determinism: "byte_stable_source" | "script_plus_env_fingerprint";
}

// ---- 4. Output artifacts ----
export interface RenderArtifacts {
  pdf: Buffer;                                        // 必须 %PDF- 魔数
  source: { kind: "tex" | "script"; fileName: string; content: string };   // 人可读、可改
  auxiliary?: Record<string, Buffer>;
  /** 渲染环境指纹（非 TeX renderer 的 identity 组成部分；TeX renderer 记录 engine 版本） */
  environment: EnvironmentFingerprint;
}
export interface EnvironmentFingerprint {
  rendererId: RendererId;
  toolVersion: string;                                // "MiKTeX-XeTeX 4.16" | "python 3.11.9/matplotlib 3.11.2"
  fontsUsed?: readonly string[];                      // 从产出 PDF 读回（pdffonts 口径），用于 tofu/LastResort 检测
  platform: NodeJS.Platform;
  scriptHash?: string;                                // 模板脚本内容 sha256（script renderer 必填）
}

// ---- 5. Truthfulness validation（现状 truthfulness.ts 原样；Renderer 无关） ----
export interface TruthfulnessHooks {
  validateCaption(caption: string, provenance: DatasetProvenance, usedColumns: string[]): CaptionValidation;
  assertOriginFaithful(projectId: string, provenance: DatasetProvenance): Promise<void>;   // FigureService 既有
}

// ---- 6. Compilation diagnostics（五类失败保留，新增字体层面） ----
export type FigureFailureKind =
  | "invalid_spec" | "tool_unavailable" | "package_missing" | "compile_failed" | "timeout"
  | "font_fallback_detected"     // 新增：exit 0 但 Missing character / LastResort 字体出现
  | "sandbox_violation";         // 新增：script renderer 触碰网络/越界文件
export interface RenderDiagnostics {
  durationMs: number;
  summary: string;                                    // 现状 compiler.diagnostics
  missingCharacters?: number;                         // 成功路径也扫描 .log
  logExcerpt?: string;
}

// ---- 7. Figure lineage（现状 GeneratedFigureRecord 的 additive 扩展，schemaVersion 2） ----
export interface GeneratedFigureRecordV2 {
  figId: string; kind: FigureKind; specHash: string; datasetHash?: string; dataOrigin: DataOrigin;
  renderer: RendererId;                               // 新增
  assets: { pdf: string; source: { kind: "tex" | "script"; file: string }; auxiliary?: string[] };  // tex → source
  environment?: EnvironmentFingerprint;               // 新增
  caption: string; insertedIn?: {...}; supersededBy?: string; createdAt: string;
  compiler?: RenderDiagnostics;
}

// ---- 8. Manuscript insertion（现状 insertion.ts 原样） ----
export interface InsertionContract {
  /** 路径恒 figs/generated/<figId>.pdf；宽度白名单；caption 全量转义；label slug */
  renderFigureEnvironment(input: { figId: string; caption: string; labelBody: string; widthExpression?: string }): string;
}

// ---- Renderer 接口 ----
export interface FigureRenderer<S = unknown> {
  readonly capability: RendererCapability;
  validate(spec: unknown): SpecValidationResult<S>;   // 现状 validatePlotSpec / validateDiagramSpec
  canonicalize(spec: S): S;                           // 现状 normalize*
  render(spec: S, ctx: { buildDir: string; timeoutMs: number; runner: CommandRunner }): Promise<
    | { ok: true; artifacts: RenderArtifacts; diagnostics: RenderDiagnostics }
    | { ok: false; failure: FigureFailure }
  >;
}
```

### 6.3 现有 PlotSpec/DiagramSpec 如何成为 Contract 实例

- `FigureIntent<PlotSpec>` 的 `kind="plot"`、`renderer` 缺省解析到 `pgfplots-plot@1`；`validate` = `validatePlotSpec`，`canonicalize` = `normalizePlotSpec`（已在 validate 内完成），`render` = `renderPlotTeX` + 现 `FigureCompiler` 第 4–6 步。`DiagramSpec` 同理映射 `tikz-diagram@1`。
- `specHash = fingerprintJson(canonicalSpec)` 不变；**figId 不纳入 renderer**——理由：同 spec 换 renderer 是「同一张图的另一次渲染」，应表现为 manifest 同 figId 下 `renderer`/`environment` 字段变化并触发重编译，而不是产生新图身份。缓存键改为 `(specHash, rendererId)`。
- `FigureService.generate` 只需把 `this.compiler.generate(...)` 换成 `this.registry.resolve(kind, renderer).render(...)` + 持久化；来源反查、caption 守卫、锁、插入全部不动。

### 6.4 specHash/figId 确定性在非 TeX Renderer 下如何保持

TeX 路线的确定性是「同 spec → 字节相同的 .tex」（I7），PDF 本身已不保证字节相同。脚本 Renderer 的等价物：

```text
identity   = specHash                                   （不变：数据 + 图型 + 文本 + 尺寸）
renderKey  = sha256(specHash ‖ rendererId ‖ scriptHash ‖ envFingerprint.toolVersion ‖ fontsPolicyHash)
```

- `scriptHash`：模板脚本是**产品仓库内的受版本控制文件**（如 `backend/resources/renderers/matplotlib/line.py`），不是 LLM 生成、不是从 Skill 复制；数据以 host 写入的 `dataset.json` 注入，脚本只读该文件。
- `envFingerprint`：Python/matplotlib 版本 + 字体策略（显式 `font.family` 列表，§5.1 证实只有此形态回退正确）；跨平台字形差异如实记录在 record，不伪装一致。
- 成功后从 PDF 读回字体表（pymupdf 已是仓库依赖），出现 `LastResort*` 或 `Missing character` → `font_fallback_detected`，与 TeX 路线共用同一失败语义。

### 6.5 外部脚本执行的沙箱与超时边界（若将来启用 script renderer）

| 边界 | 规则 |
| --- | --- |
| 进程 | 与 `FigureCompiler.spawnCommand` 同构的 `CommandRunner`，`cwd = mkdtemp`，`timeoutMs` 默认 60 s 共享预算，超时 kill 进程树（Windows `taskkill /T` 坑见仓库记忆） |
| 文件 | 只允许读 `buildDir/dataset.json` 与模板脚本；产物只认 `buildDir/figure.pdf`；realpath 包含校验（复用 `figureAssets.ts` 手法） |
| 网络 | 禁止：`env` 清空代理变量 + `PYTHONNOUSERSITE=1` + 脚本模板静态扫描禁 `requests/urllib/socket/subprocess`（在模板入库时做一次，不在运行时信任） |
| 环境 | `MPLBACKEND=Agg`、`MPLCONFIGDIR=buildDir`（防用户 matplotlibrc 污染）、`SOURCE_DATE_EPOCH` 固定、`LC_ALL=C.UTF-8` |
| 输入 | 数据只来自 `DatasetProvenance.inlineDataset`（已过 I2/I3）；脚本不接受任何自由文本参数，文本经 JSON 注入由脚本自行转义 |
| 输出校验 | `%PDF-` 魔数、单页、字体表无 LastResort、无 image 对象（除非 capability 声明允许栅格层） |
| 失败归类 | spawn 失败 → tool_unavailable；ImportError 模式 → package_missing（附包名，对齐 TeX 的 `detectMissingPackage`）；其余非零 → compile_failed |

### 6.6 绝不能为接外部 Skill 牺牲的维度

1. **数据真实性**：数据必须由 host 注入并与 `datasetHash` 绑定；任何「复制脚本只改路径」「保留脚本内字面量数据」「随机抖动/模拟」都不得进入生产路径。
2. **不变量 I1–I6, I8**：specHash/figId 身份、来源反查、caption 硬闸、append-only lineage、受控插入、Writer 白名单、零 LLM 数值——与 Renderer 正交，接入任何 Renderer 都走同一 `FigureService`。
3. **确定性编译**：模板脚本受版本控制 + 环境指纹入账；不接受运行时由模型改写的脚本；不接受「视觉适配时丢弃 log 变换」这类数据语义改写。
4. **中文与正文一致**：Renderer capability 必须声明 `cjk: true` 并通过 PDF 字体表回读验证；不能靠 QA 字符串匹配 `"font.family"` 出现与否。

---

## 7. §A/B 实验结果（主会话填入）

完整实验见 [PRE_M14_ACADEMIC_FIGURE_SKILL_EVALUATION.md](PRE_M14_ACADEMIC_FIGURE_SKILL_EVALUATION.md)。与本报告架构结论直接相关的实证：

| 事实（22 个有效会话 + 臂 C，2026-10-14） | 对架构建议的含义 |
| --- | --- |
| Skill 臂 10 份交付中 **0 次 native run**（全部 param inherit / cross-type）；原因与 §3.3 静态发现一致（资产脚本硬编码私有数据 / 读不存在文件 / R 不可用 / 语义不匹配） | Skill 的「生产脚本库」不能成为 Renderer 的脚本来源；可借鉴的只有 references 中的排版 / 配色 / 导出常量（§3.4） |
| Skill 臂成本中位 6.07 vs 基线 0.78 USD（7.8×），时长 690 vs 163 s，等预算 6 USD 下 5/8 触顶、1/8 零交付 | 任何 LLM 驱动的脚本型 Renderer 与 FigureCompiler 的「秒级、确定性、可缓存」目标数量级不符；Renderer 必须是产品自有模板 + 数据注入（§6 沙箱规则） |
| 两臂 21 份脚本全部完整读入数据、无随机数造数；但 Skill 臂 2 份图上出现未授权派生量（Wilcoxon p 值、相对提升行），数值正确 | 真实性闸门不能依赖模型自律：`assertOriginFaithful` + caption 三桶核验必须对所有 Renderer 统一生效，派生量只能来自确定性代码并标注 |
| 臂 C 只能表达 8 任务中 4 个（第 5 个需删作者反馈边）；t1 / t3 图例遮挡数据、t2 中文类目重叠、无误差棒 / 置信带 / 对数轴 / 点标注、diagram 宽 250 mm | 落后项全部在 PlotSpec / DiagramSpec 表达面与 codegen，而不在 TeX 后端——支持「Contract 泛化但 Renderer 集合暂不扩」的建议 |
| 两臂 zh 任务 PDF 均嵌入 SimHei / SimSun、0 缺字形警告（模型自行用 `font_manager` 注册） | §5.1 的 tofu 风险是「照抄 Skill 基线」的风险，模型在被明确要求中文时会绕开；但产品代码不能依赖这种绕开 |
| Skill 自带 QA：字体检查对基线臂 11/11 判 FAIL（回退列表含 DejaVu Sans，而 PDF 实际嵌 Arial）；尺寸检查器 19/21 挂起 >60 s | 不把 Skill 的 `check_*.py` 接进任何 CI / Guard；真实性与排版检查应读 **PDF 字体表与页面几何**（§6 diagnostics 的 `font_fallback_detected`） |

---

## 8. 风险与不做清单

### 8.1 风险

| 风险 | 等级 | 处置 |
| --- | --- | --- |
| `Missing character` 在 exit 0 下静默（§2.3-1） | 中 | M14 在成功路径扫描 .log 计数并入 diagnostics（不改失败分类亦可先只记录） |
| Contract 化引入 manifest schemaVersion 2 | 低 | `loadManifest` 对 v1 做 additive 升级（`assets.tex → assets.source`，`renderer` 缺省 `pgfplots-plot@1`/`tikz-diagram@1`） |
| 图型扩展需求被「多 Renderer」话术拉向 Python | 中 | 规则：先在 pgfplots 内加模板（boxplot/error bars/matrix plot 皆原生），只有 pgfplots 结构性做不到的图型才评估 script renderer |
| Skill 的 Apache-2.0 代码片段被复制进仓库 | 低 | 只采纳调色板数值与尺寸常量（事实数据），不复制脚本；如引用需 NOTICE |
| 探针为单机 Windows 结论 | 中 | Linux 侧 matplotlib 字体行为未探（Fandol 对 matplotlib 不可见已证，Noto 需另装），列入 A/B 或 M14 CI |

### 8.2 不做清单（Pre-M14 明确不做）

- 不安装 R / Graphviz / seaborn / academic-figure-skill；不把 Skill 的 `assets/figures/*` 任何脚本带入仓库。
- 不新增 Python Renderer；不在 `Dockerfile` 加科学栈。
- 不开放任意 TikZ/pgfplots 逃生舱；不让 LLM 直接写 .tex 或 .py。
- 不实现 SVG 交付（xelatex 需 inkscape 转换，本机未装；PDF 主件足够）。
- 不承诺 PDF 字节级可复现（延续 M12.0 §13 诚实降级）。

---

## 9. 可复核清单

| # | 可复核项 | 方法 |
| --- | --- | --- |
| 1 | 代码坐标 | `backend/src/figures/*.ts` 行号以 `cat -n` 为准（基线 `215de15`） |
| 2 | 不变量 I1–I8 | `backend/test/figures/{spec,FigureCompiler,truthfulness,insertion,writerGraphicsGuard,figureHttp}.test.ts`（21+37+16+11+8+21 用例）；真实 smoke `figureReal.smoke.test.ts` 5 用例（需本机 TeX） |
| 3 | Skill 统计 | 在 skill-source 目录执行 `find assets scripts -name "*.py" \| wc -l`（51）、`-name "*.R"`（16）+ `-name "*.r"`（4）、`ls -d assets/figures/*/ \| wc -l`（32）、`rg -I -N -o "^(import\|from) [A-Za-z_][A-Za-z0-9_]*" -g "*.py" assets scripts \| sort \| uniq -c` |
| 4 | Skill 数据风险坐标 | `assets/figures/BarAblation/plot_bar_ablation.py:7-18`、`LineTrend/plot_trend.py:8-16`、`volcano/rnaseq_deseq2_standard.py:76-87`、`StackedBarScatter/plot_StackedBarScatter.py:323-324`、`DensityHeatmap/plot_DensityHeatmap.R:33`、`KernelDensity/plot_CorrelationDensity1.R:6-7`、`MantelCorrelation/plot_MantelCorrelation1.r:13-14` |
| 5 | Skill QA 为字符串匹配 | `scripts/qa_validator.py:39-85`（AP-0/AP-1）；文件头 L12–14 自述 Pass 2/3 为 LLM 执行 |
| 6 | Skill 私有数据声明 | `README_EN.md:84` |
| 7 | matplotlib 探针 | `python D:\PaperTeamData\AcademicFigureSkillEvaluation\scratch-arch\probe_mpl.py`；`pdffonts mpl_*.pdf` 看是否出现 `LastResortHE` |
| 8 | pgfplots 探针 | 同目录 `xelatex -interaction=nonstopmode -halt-on-error probe_pgf.tex` / `probe_pgf_noctex.tex`；`grep -c "Missing character" probe_pgf_noctex.log` → 21；`pdffonts probe_pgf.pdf` 含 `SimSun CID TrueType` |
| 9 | 依赖缺失 | `which Rscript dot gs magick inkscape`；`python -c "import seaborn"` |
| 10 | 既有裁决文档 | `docs/research/M12_0_FAST_ARCHITECTURE_AUDIT.md` §11–§13、§17；`M12_BATCH1_DETERMINISTIC_FOUNDATIONS.md` C1–C3；`M12_BATCH3_FIGURE_GENERATION_CLOSURE.md` §2/§4/§10/§18；`M12_2_5_LINUX_DUAL_RUNTIME_CLOSURE.md` §3.4；`docs/DECISIONS.md` 无 figure 专项 ADR（M12 决策冻结在 M12.0 文档内，D-0043 为最后一条） |
