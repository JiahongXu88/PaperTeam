# M12 Batch 3 — Academic Figure Generation Product Closure 实施报告

> **日期：2026-10-08。执行：Claude Code。基线：`02d3c0f`（M12.2.5 收口 + 真实服务器部署），全程 main 未建分支。**
>
> **一句话结论：C4–C6 一次完成——学术图表从已验证的底层 FigureCompiler（C1–C3）升级为可操作产品：数据集候选（sourceId+blockId 锚）→ PlotSpec/DiagramSpec → 确定性 pgfplots/TikZ → 矢量 PDF 资产 → 受控手稿插入（append/replace + label lineage）→ 真实 xelatex 构建；caption↔dataset 真实性守卫（三桶数值声明分桶 + 跨桶混淆拦截 + UNVERIFIED 作者确认通道）与 Writer 图形白名单守卫落地；Runtime Doctor 修复 Docker 生产形态假失败并区分部署形态。阿里云新加坡 ECS 直接以新代码验收（真实容器内 xelatex 编译 + 真实 HTTP 链路）。**

---

## 1. 实施范围

| 任务 | 状态 | 要点 |
|---|---|---|
| C4 Figure API | ✅ | 8 端点（datasets 列表/单集、validate、generate、list、get、insert、B4 资产服务）；`figures/FigureService.ts` 编排（per-project 串行化 manifest 互斥）；来源锚反查防数据篡改（inlineDataset 与声称 source 块 hash 不一致 → 拒绝生成） |
| C4 Figure UI | ✅ | `FiguresPanel.tsx`（数据图构建器 / 方法图构建器 / 图表库三段）+ ProjectPage「学术图表」tab；`api/figures.ts`；PDF 内联预览（浏览器原生 viewer）+ 新标签打开 |
| C5 Manuscript Insertion | ✅ | `figures/insertion.ts` 确定性 env emitter（includegraphics 路径恒为 figs/generated/<figId>.pdf + caption 全量转义 + label 白名单）；append（outline 章节目标 + 引用句 + 自动 label 派生/消歧）/ replace（label 保持 + 区间外字节不动 + supersededBy lineage）；模板 graphicx + 存量 main.tex 幂等注入；Writer 三处 TikZ 禁令改「资产白名单」语义 |
| C6 Truthfulness Guards | ✅ | `figures/truthfulness.ts`：数值声明三桶（value/delta/relative）确定性核验、百分点↔相对百分比跨桶混淆拦截、计数/全称/单位 UNVERIFIED（AUTHOR_REVIEW_REQUIRED + confirmUnverified 作者确认通道）；`figures/writerGraphicsGuard.ts`：Writer 输出 tikz/pgfplots 恒禁 + includegraphics 集合与基线一致（不增不删不改）；数据陈旧（来源变化 → 插入 409） |
| Part D Doctor 修复 | ✅ | development / deployment=docker / deployment=native 三形态（显式 env > compose 服务自动检测 > development）；docker 形态不再要求宿主机 node_modules/TeX（检查真正必要的运行时事实：compose 服务健康 / 同源 /health+/ready / 数据 volume）；FigureCompiler 真实编译探针（standalone+pgfplots 最小图，dev/native 形态） |
| Part E Linux Real Acceptance | ✅ | 新加坡 ECS 容器内真实执行（见 §12–§14） |

## 2. Figure API（C4）

路由组（`httpServer.ts` figures resource，全部 project-scoped + `getRequired`）：

```text
GET    /api/projects/:id/figures                        → { figures: FigureView[] }
GET    /api/projects/:id/figures/datasets               → { datasets: DatasetCandidate[] }
GET    /api/projects/:id/figures/datasets/:sid/:block   → { dataset: DatasetPayload }
POST   /api/projects/:id/figures/validate               → { result: ok+captionValidation | errors[] }
POST   /api/projects/:id/figures/generate               → { figure: { record, cached, captionValidation } }
GET    /api/projects/:id/figures/:figId                 → { figure: FigureView + spec + captionValidation }
POST   /api/projects/:id/figures/insert                 → { insertion: InsertResult }
GET    /api/projects/:id/figures/generated/:name        → PDF 字节（B4 既有，manifest 登记先于读盘）
```

设计要点：

- **per-project 串行化**：`FigureService` 内 promise 链互斥（figureStore 的 manifest 读-改-写无锁契约由本层兑现）；尾部 promise 永不 reject（前序失败不死锁后续）。
- **来源锚反查（防篡改的第一道闸）**：`generate` 对 `origin={sourceId, blockId}` 的 plot spec 重新提取来源块数据并比对 datasetHash——inlineDataset 被修改后重算 hash 绕过 spec 自洽校验的攻击路径在此被拒（409 FIGURE_DATASET_STALE："图表数据必须逐字节来自其声称的来源"）。manual origin 无此检查（如实标注的合法入口）。
- **caption 真实性预检 advisory**：generate/validate 返回 captionValidation 但不阻断（图资产本身是数据忠实的；caption 是草稿）；**insert 时成为硬闸**（见 §9）。
- **编译错误结构化透出**：FigureCompiler 五类失败（invalid_spec/tool_unavailable/package_missing/compile_failed/timeout）经 `figureFailureToBusinessError` 映射 HTTP 码——UI 不会只看到 "Figure generation failed"。

## 3. Figure UI（C4）

`frontend/src/components/project/FiguresPanel.tsx`（自包含，遵循 TargetPanel 模式）：

- **数据图构建器**：数据集下拉（fileName/块/行列/sourceRole 徽章——reference 源标注「benchmark 参照」，benchmark 对比是合法消费语义）→ 载荷加载 → 图型/X 列/Series 多选/轴标题/图内标题/caption/图例/缺失值策略 → 「校验 Spec」（错误列表 + caption 守卫预览）→「生成图表」（loading 态标注 xelatex 编译中）。
- **方法图构建器**：layout/variant/标题 + 结构化节点行（id/label/group/role）+ 连接行（from/to/label）增删编辑；comparison 变体自动切换 left/right 角色选项。
- **图表库**：figId（=specHash 派生，确定性徽章语义）+ kind/plotType/semantic/来源类（来源数据/手动数据/方法图）+ caption + 来源锚（sourceId#blockId）+ 生成时间 + 编译耗时 + 资产在盘状态 + 已插入位置（file+label）+ 陈旧警告（数据已过期，附原因）+ 已被替换徽章；操作：打开 PDF / 内联预览（iframe 嵌浏览器原生 PDF viewer）/ 插入论文。
- **插入表单**：模式（append/replace）+ 章节选择（outline 投影，未生成章节禁用）/目标文件 + label/replaceLabel + caption（预填）+ 正文引用句 + 「我已核对 caption」确认框（UNVERIFIED 作者通道）；已有论文项目固定 replace 语义 + 边界提示。
- 空态（无数据集→引导上传；无图表→引导生成）、错误（服务端 detail 折叠展示）、成功反馈（插入结果 note：文件/label/graphicx/替换原路径）齐备。

不做大规模 UI 重构：新增 tab 一行 + 组件一个 + CSS 追加一节（form-row/chip-select/figure-preview 等，token 全部复用既有 CSS 变量）。

## 4. Dataset Provenance（数据入口与三类来源纪律）

`figures/datasets.ts`（纯函数，零模型）：

- **候选提取**：ParsedTableBlock（PDF docling 表格；空表头补列号、重复表头唯一化）+ 连续 ParsedRecordBlock 游程（CSV/XLSX/JSON 投影；按 header 首现序对齐列、缺格 null 不填零、游程区间 blockId 形态 `B0001-B0003`）。
- **数值化**：确定性 coerce（千分位剥离/科学计数/失败保留字符串/空→null）；datasetHash 与 spec 同源函数（`computeDatasetHash = fingerprintJson({columns,rows})`）。
- **三类数据身份**（UI 徽章 + manifest 记录）：
  - `source_parsed`：origin={sourceId, blockId}——已解析 Source 的数据（可反查、可检测陈旧）；
  - `manual`：origin={origin:"manual", note}——用户手动数据（必须显式 note，UI 恒显「手动数据」徽章；**不自动获得任何 Verified Evidence 身份**）；
  - `diagram`：方法图（无数据集，dataOrigin 由编译器固定标注）。
- 不存在「让模型编数据」的入口：generate 的 spec 校验 + 来源锚反查构成双向闸（自洽 hash + 来源一致）。

## 5. PlotSpec / DiagramSpec / FigureCompiler（C1–C3 既有，本轮消费）

Batch 1 冻结的 spec/校验/codegen/编译/缓存（figId=specHash 前 12hex；同 spec 恒同图；数据变化必然改变 specHash 的结构保证）本轮零改动直接消费；`figureStore.ts` additive 扩展：`recordInsertion`（插入 lineage 回写：目标图 insertedIn + 同位旧图清除 insertedIn 并记 supersededBy）+ `loadSpec`（插入时守卫复读 spec）+ record 增可选 `supersededBy`（append-only lineage，旧资产永不删除）。

## 6. Manuscript Insertion（C5）

确定性 emitter（`figures/insertion.ts`）：

```latex
\begin{figure}[htbp]
    \centering
    \includegraphics[width=0.85\textwidth]{figs/generated/<figId>.pdf}
    \caption{<escapeLatex(caption)>}
    \label{fig:<labelBody>}
\end{figure}
```

- **append**（仅非已有论文项目）：目标 = outline 章节（sections/<file>，须在 \input 文档图内且已生成）或显式 file（normalizeTexPath 防穿越 + 文档图内校验）；文件末尾追加环境 + 可选引用句（文本转义 + 恰好一个受控 `\ref{fig:<label>}` + `~` 保留 nbsp 语义）；label 显式冲突即拒（409），缺省从 caption 派生 slug 并自动消歧（-2/-3）。
- **replace**（所有项目类型）：按 label 定位同文件 figure 环境（visualInventory 同款解析），只替换该环境区间（区间内容必须确实含目标 \label——防行号错位静默替换错误环境）；label/placement/环境外字节一字不动 → 正文全部 \ref 继续解析；同 figId 同 label 的重复替换走同一确定性重写路径（caption/宽度更新如实落盘，无静默跳过）；previousPath 记录被替换资产。
- **模板闭环**：`writeMainTex` 增 `\usepackage{graphicx}`；存量 main.tex 缺 graphicx 时在 documentclass 后幂等注入一行。
- **插入后**：manifest lineage（insertedIn{file,label,revision} + supersededBy）+ visual inventory 重建（research/manuscript-visuals.json 与 .tex 同步，generatedFiguresUsed 立即可见）。

## 7. Label / Caption / Reference 处理

- label：`fig:` 前缀 + 安全 slug 白名单（`[A-Za-z0-9][A-Za-z0-9_.-]*`）；全稿冲突检查经 visualInventory 投影（跨全部 .tex）。
- caption：最终 caption 在插入时快照进环境（转义）+ manifest（record.caption 为生成时草稿）；insert 可覆盖（守卫按最终值重跑）。
- 引用句：append 可选；必须包含当前 label 的正确 `\ref`（否则 INVALID_REQUEST）；文本部分转义、`\ref` 是本模块产出的唯一受控 TeX 命令；`~` 保留为 nbsp（"图~\ref{...}" 标准写法；单独 ~ 无注入面）。

## 8. Writer TikZ 安全边界（禁令 → 资产白名单）

M12.0 冻结语义落地——**Writer 不允许输出任意原始 TikZ/PGFPlots，但正文可以引用已登记图表**：

- 三处 prompt（buildRepair `WriterService.ts:1247`、revise `:1435`、survey `:1858`）改写：可用宏包 amsmath/amssymb/natbib/**graphicx**；tikz/pgfplots 环境与命令恒禁；**不手写 \includegraphics**（插图由图表流水线受控 action 完成）；正文允许 `\ref{fig:...}` 引用已存在 label；需要新图时在执行报告说明需求而非自行编造。
- 确定性守卫 `figures/writerGraphicsGuard.ts` 双挂点：
  - `writeSection`（全新章节）：输出含任何 \includegraphics → InvalidLatexOutputError；
  - `reviseSection`（修订）：输出与基线的 \includegraphics 路径多重集必须一致（新增=未登记资产注入、删除=破坏已插入资产、改路径=两者兼有 → 全拒）；tikz/pgfplots 环境与 \usepackage 图形宏包恒拒。
- 产品主路径 = 结构化 insertion action（HTTP API + 确定性 emitter），Writer 自由 LaTeX 编辑不经过本路径。

## 9. Revision Scope 验证（M11 边界不被图表后门绕过）

- **已有论文项目**（existing_paper_improvement / existing_paper_review）：append 被拒（403 FIGURE_SCOPE_VIOLATION："新增图表环境必须走受控替换或修订工作流的获批 action"）；replace 放行且物理上不可能越界（只动目标环境区间、label 保持、区间外字节不动）——「Reviewer 只要求修改 Results 某张 Figure」的合法动作恰好等于 replace 的能力面。
- **新论文项目**：按已确认 outline 插入（章节必须在 outline 且已生成）。
- 集成测试锁定（`figureHttp.test.ts`）：已有论文 append 403 / replace 200（作者老图 figures/author-plot.pdf → figs/generated/、label 与正文 \ref 原样）/ graphicx 不重复注入。

## 10. Figure Truthfulness Guards（C6）

`figures/truthfulness.ts`（纯函数、确定性、零模型）——caption 定量声明的分桶核验：

| 桶 | 判定 | 支撑面 | 失败 |
|---|---|---|---|
| value | 小数（测量值信号）或比较语境数值 | x/series 列全部数值单元格；回退成对差值（行内跨列 + 列内跨行，按声明精度舍入比较） | violation |
| delta | "X points / X 个百分点 / X pp" | 成对绝对差值；跨桶命中相对差 → **百分点↔百分比混淆 violation** | violation |
| relative | "X% / 百分之X / by X percent" | 成对相对差 (b-a)/a×100；跨桶命中绝对差 → 混淆 violation | violation |
| count | "N 个/种/行/… / N datasets/methods" | 行数/列数/series 数 | unverified |
| ignore | 图表编号（Figure 3/Table 2/epoch 100 前缀排除）+ 标识符内嵌数字（MOT17/B0001——前后紧邻字母排除） | — | 不参与 |

附加检查：全称量词（所有/全部/all/every）→ unverified；单位不兼容（caption 数字紧邻单位 vs 轴标签单位；百分点族与 % 视为兼容族）→ unverified；missingPolicy=skip_row 披露 info；>100 行数据集差值计算跳过 → unverified（防 O(n²) 也防误判）。

**执行点**：validate/generate 返回 advisory；**insert 硬闸**——violation → 422 FIGURE_CAPTION_UNSUPPORTED（附 issue 明细：claim + 数据锚样本）；unverified 且无 `confirmUnverified:true` → 422 FIGURE_CAPTION_UNVERIFIED（AUTHOR_REVIEW_REQUIRED；确认后放行并在响应记录 authorConfirmedUnverified）。纯定性 caption 恒 pass（不误杀）。

任务书核心反例被测试锁定：数据 62.1→63.4，caption "improves by 5 points" → violation（实际差 1.3）；"by 1.3 points" → pass；"by 2.09%"（真实相对差）→ pass；"by 50 points"（数据 50→75，绝对差 25、相对差 50%）→ 百分点混淆 violation。

**TeX/File 安全**（§15 要求全覆盖）：LaTeX 控制序列注入（caption/引用句文本全量转义，`\input{x}` → 无害文本，golden 测试锁定）；arbitrary file include（includegraphics 路径恒由 figId 派生，不接受用户路径；宽度表达式白名单）；unsafe asset path / path traversal（插入目标经 normalizeTexPath + 文档图内校验；资产读取走 B4 既有 13 类攻击面测试的 generated 路由）；symlink escape（B4 realpath 包含校验既有）；duplicate label（全稿冲突检查）；unregistered artifact（manifest 登记 + PDF 在盘双检，missing → 404/409）；stale specHash（同 specHash 缓存语义 + figId↔specHash 一一对应既有）；modified datasetHash（生成时来源锚反查 + 插入时陈旧硬闸）；missing generated PDF（pdfAssetExists 检查）。

## 11. Runtime Doctor 修复（Part D）

`scripts/doctor.mjs` 重构为形态感知：

- **形态判定**：`PAPERTEAM_DEPLOYMENT=docker|native` 显式 > 自动检测（本仓库 compose 有运行中 paperteam 服务；docker CLI 不可用/无 compose/无服务 → 保守落 development；非法值如实警告并落 development 不再自动检测）。
- **deployment=docker**（真实服务器形态）：宿主机 node_modules/TeX/Python/pymupdf 不是运行时事实（前端预编译进 web 镜像、后端依赖与工具链在 backend 镜像内、构建期已 kpsewhich 三验）→ 检查真正必要的运行时事实：docker CLI / compose 服务健康（State+Health）/ 同源 `/health`+`/ready`（fetch，PAPERTEAM_WEB_PORT 支持 127.0.0.1:8080 形态）/ 数据 named volume 在位。**修复了 Docker 生产形态 "frontend dependencies FAIL" 假失败**。
- **deployment=native**：backend 依赖仍 FAIL 级（真实运行时）；frontend 依赖降 WARN（静态产物可在他处构建）。
- **development**：语义与 M12.2.5 完全一致（两项依赖均 FAIL 级）。
- **FigureCompiler 检查补齐**：dev/native 形态新增「图表编译探针」——standalone+pgfplots 最小数据图真实编译一次（宏包在位 ≠ 能编译；字体/版本/权限问题只有真实编译能暴露；失败=WARN 附 TeX 包安装建议）；docker 形态由镜像构建期三验 + CI figure-smoke 覆盖（如实标注）。

## 12. Linux Server Real Acceptance（Part E）

真实环境：阿里云新加坡 ECS（Ubuntu 24.04 / 4 vCPU / 16 GiB / 200G 数据盘 / Docker Compose / backend-docling 镜像 / TeX Live + pgfplots/TikZ/CJK / GLM Z.AI Coding Plan）。执行记录（收口回填）：

| Smoke | 内容 | 结果 |
|---|---|---|
| A Dataset→Figure | 真实 CSV 上传 → ingestion → datasets API → PlotSpec → 容器内真实 xelatex → 矢量 PDF 落盘 → HTTP 资产服务 | 见 §14 |
| B Diagram | DiagramSpec → TikZ → 矢量 PDF → 预览 API | 见 §14 |
| C Manuscript Insertion | 有界真实 workflow 产出手稿 → 插入（caption+label+\ref+graphicx）→ POST /build → 真实 xelatex+bibtex → 含图 PDF | 见 §14 |
| D Invalid Data | 篡改 datasetHash / 无支撑数值声明 / 缺失 source / 非法 series —— 拒绝或要求作者处理 | 见 §14 |
| E Existing Paper Scope | 受控 fixture：合法 replace / 跨章节 append 拒绝 / 未登记图 / 错误 caption | 见 §14 |

## 13. 真实工作流 / 模型验收（§19）

有界（bounded）真实论文工作流：idea_to_paper 真实 GLM 运行产出章节手稿（不重复大额推理——模型能力前序里程碑已验收，本轮只为给 Figure 插入提供真实手稿载体），随后 Figure 插入 + 真实构建。数字收口回填（见 §14）。

## 14. 验收数字（收口回填区）

> 本节在最终收口提交时回填真实数字（CI run / 部署 commit / smoke 时长与产物 SHA / 磁盘）。

## 15. 测试

| 套件 | 数字 |
|---|---|
| 新增 backend 测试 | datasets 4 + truthfulness 16 + insertion 10 + writerGraphicsGuard 8 + figureHttp（HTTP 集成）10 + doctor 部署形态 3 = **51** |
| backend 全量（新加坡服务器，4 workers + pymupdf 补装后） | 267 files / **2,860 passed / 0 failed** / 25 skipped（skipped = live-smoke 门 + docling 门 + 宿主机无 TeX 的 figureReal 门——容器内有 TeX，CI docker job 覆盖） |
| frontend | 30 files / **292 passed**（287 → +5 组件测试） |
| backend/frontend typecheck、双端 build、`git diff --check`、`check-docs-links`（298 链接） | PASS |

测试纪律：fakeFigureRunner 注入（testStack 新 seam `figureRunner`，缺省即注入——全栈离线可测图表链）；HTTP 集成测试直接驱动真实路由（startTestStack 真 HTTP server）；doctor 测试以子进程运行真实脚本（显式 env 保证跨平台确定性）。

## 16. Bugs Found & Fixed（本轮实施中）

1. doctor.mjs 误用 TS 语法（`as const`）于 .mjs —— SyntaxError；改纯 JS 数组。
2. 非法 PAPERTEAM_DEPLOYMENT 值警告后仍走自动检测（提示语与行为不一致）——显式设置过形态即不再自动检测。
3. caption 守卫三处假阳性：全称量词正则要求尾随空白（"所有数据集"不命中）；单位 token 过松（"achieves" 词尾 s 误判单位；"(%)" 形态 \b 失效）——改为词边界 lookaround + 数字紧邻 + 百分点/% 兼容族；标识符内嵌数字（MOT17）误判为数值声明——前后紧邻字母排除（视觉检查同款口径）。
4. 引用句转义把 `~` 变成可见波浪号（"图~\ref" 标准写法被破坏）——引用句文本单独转义路径，~ 还原 nbsp 语义。
5. applyReplacement 不校验区间内容含目标 label（行号错位时可能静默替换错误环境）——区间内 \label 校验 + label_not_found。
6. value 桶小数声明不回退差值（"by 1.3" 对 62.1→63.4 被误判 violation）——差值回退不再限整数声明。

## 17. 文件清单

**新建 backend src（6）**：`figures/{datasets,truthfulness,insertion,FigureService,writerGraphicsGuard}.ts`
**新建 frontend（2）**：`api/figures.ts`、`components/project/FiguresPanel.tsx`
**新建 test（6）**：`test/figures/{datasets,truthfulness,insertion,writerGraphicsGuard,figureHttp}.test.ts`、`test/scripts/doctorDeployment.test.ts`、（前端）`test/FiguresPanel.test.tsx`
**新建验收脚本（3）**：`scripts/{m12b3-figure-acceptance,m12b3-smoke-e-scope,m12b3-smoke-c-continue}.py`（真实服务器 Part E 驱动；可复跑）
**修改 backend（6）**：`figures/figureStore.ts`（recordInsertion/loadSpec/supersededBy）、`errors.ts`（+10 code）、`serviceStack.ts`（figures 服务 + 注入 seam）、`httpServer.ts`（figures 路由组 + 请求体 helper）、`manuscript/ManuscriptService.ts`（模板 graphicx）、`writer/WriterService.ts`（三处禁令改写 + 双挂点守卫）、`test/helpers/testStack.ts`（fakeFigureRunner + figures seam）
**修改 frontend（3）**：`pages/ProjectPage.tsx`（tab）、`styles/components.css`（追加图表工作区样式）
**修改 scripts（1）**：`doctor.mjs`（形态感知重写）
**文档**：本报告 + `PROJECT_STATUS.md` / `ARCHITECTURE.md`（§20 增量 M12 三行）/ `research/README.md` / `product-guide.md`（§6 学术图表 + 限制清单更新）/ `README.md` + `README.zh-CN.md`（核心能力表 +学术图表行）

## 18. 已知限制

1. 图型覆盖 = 4 类数据图 + 2 类方法图模板（冻结范围）；任意格式实验 ZIP 自动识别不在能力内（任务书明令不得宣称）。
2. caption 守卫的语义启发式（桶分类/单位族）有保守边界：无法可靠校验的声明归 UNVERIFIED 而非放行——极端措辞可能多要一次作者确认（假阴性方向）。
3. LLM 起草 DiagramSpec 未实现（产品走结构化表单；模型只允许生成 spec 的 seam 留待后续——本轮零模型参与图表链）。
4. figureTypeMix / tableStyle（target profile visuals 维）仍未实现（Batch 2 遗留，如实 note）。
5. 大数据集（>100 行）的成对差值声明不校验（防 O(n²) 误判）→ UNVERIFIED。
6. 生成图 PDF 的字节级可复现（SOURCE_DATE_EPOCH）仍不在 v1（M12.0 冻结的诚实降级项）。
7. Browser E2E 未执行（服务器无浏览器自动化）；UI 验收 = 前端组件测试（5 用例：空态/库渲染/数据集→生成/插入表单/已有论文 replace 语义）+ 已部署生产 bundle 含 Figures tab 的验证 + 真实 HTTP 链路全量驱动——如实区分：Component/API integration PASS，Browser E2E Not Verified。

## 19. M12 Figure Generation Demo Script（最短演示路径）

```text
1. 上传/选择实验数据
   项目 →「文献库」→ 上传 experiment.csv（或已解析 PDF 的表格块）
   →「学术图表」→ 数据图构建器 → 数据集下拉（显示 fileName/行列/来源角色）
2. 生成学术图表
   选图型 / X 列 / Series / 轴标题 / caption →「校验 Spec」（守卫预览）
   →「生成图表」（容器内真实 xelatex，秒级）→ 图表库出现新行
3. 检查溯源
   图表库行：来源徽章（来源数据 S001#B0001-B0004）+ datasetHash 派生 figId
   + 「打开 PDF」查看矢量产物（浏览器原生 viewer）
4. 插入手稿
   行内「插入论文」→ 选章节 / caption（守卫实时校验数值声明）/ label
   → 插入（label 自动分配 + 引用句 + 模板 graphicx）
5. 编译 PDF
   「论文产出」→ 构建 → Draft PDF（真实 xelatex+bibtex；图随稿编译）
```

演示红线：不宣称支持任意格式乱序 ZIP 实验包自动识别（未实现）；方法图走
DiagramSpec 表单（模板化 TikZ，非自由绘图）。

## 20. Git / CI / 部署记录

- **提交**：`6db034e`（feat(figures): M12 Batch 3 产品收口，34 files / +5,969 −40）+ `a20a528`（fix(test): events.jsonl 时序 flake 轮询修复——CI 并行负载下终态可见先于 workflow.completed 事件落盘，既有测试的等待口径缺口，非本轮功能性回归）。
- **GitHub CI**：`6db034e` 首跑 Test 步 1 失败（上述 flake，docker job 连带 skip）→ `a20a528` **CI run 37728925205 success**（ubuntu test 全量 + docker build smoke：镜像构建 / 容器 ready / **容器内真实图表编译 smoke（figure-smoke.mjs 5 用例含 CJK + specHash 缓存）** / restart 持久化 / compose down-up）。
- **Linux Integration**：**run 37728925181 @ a20a528 success**（docling native 全链 + backend-docling 镜像内解析 + 无残留子进程 + HF 缓存落 volume）。
- **doctor 精修**：docker 形态的 docling 检查按容器内 venv 探测判定（compose ps 的 Image 字段可能是 sha256 digest，不可靠）——本服务器如实报「backend-docling 镜像在运行」。
- **服务器部署**：`git pull`（HEAD == origin/main）→ `docker compose build`（backend-docling + web 两目标，工作树规范形态）→ `up -d` 滚动重建 → 双容器 healthy；`.env` / compose.override / 三 volume / 模型配置 / HF 缓存全部保留；**Runtime Doctor 自动检测 docker 形态全 PASS（exit 0）**。
- **服务器宿主机增量**：Node 22.20.0（~/.local 用户目录 tarball，未动系统）+ pymupdf（pip --user）——为「Server First」执行全量回归所需；镜像内依赖不受影响。

## 21. 下一阶段建议

1. M12 Final Closure：三条产品线 Demo 打磨 + README 截图更新 + M12_3 收口报告合并视图。
2. 修订工作流的 insert_figure 计划条目类型（M11 修订计划 ↔ 图表 action 的审批桥——本轮以「replace-only + 修订工作流内不改」的保守边界替代）。
3. 图表批量（一个 dataset 派生多图）与 spec 模板库。
4. Writer 报告「需要新图」需求的接单闭环（执行报告 → Figures 待办）。

---

## 22. M12 完成度判定

- **M12.3（Academic Figure Generation）**：C1–C6 全部 COMPLETE（C1–C3 Batch 1 + C4–C6 本轮，真实服务器验收）。
- **M12.1（Target Publication Intelligence）**：Batch 2 COMPLETE（未回归）。
- **M12.2（Multimodal Review）**：Batch 2 COMPLETE 含真实视觉模型验收（未回归）。
- **M12 FEATURE COMPLETE = true**（三条产品线各自达到 MVP 验收标准，本轮全量回归零失败）。
- **M12 最终 Closure / Demo Acceptance**：本报告 + M12_2_5 + Batch 1/2 报告构成完整验收记录；未验证项如实登记（Browser E2E、任意实验 ZIP 识别、完整长论文自动生成——均不在 M12 验收口径内，也不得计入完成项）。READY_FOR_M12_FINAL_CLOSURE = true（收尾性质：README 能力截图 / Demo 打磨，无新工程面）。

---

**M12 Batch 3 — COMPLETE（C4 Figure API/UI + C5 Manuscript Insertion + C6 Figure Guards + Part D Doctor + Part E 真实服务器验收）。M12.3 COMPLETE。**
