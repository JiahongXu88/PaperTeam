# M14.0 工作包 C：中文硕士学位论文 LaTeX 模板技术调研

> - 日期：2026-10-13（探针编译与收尾于 2026-10-14 凌晨完成）
> - 执行：Claude Code（Pre-M14 调研子代理）
> - 基线：`D:\Projects\PaperTeam` Git HEAD `215de15`（main）
> - 性质：**只读调研，未改任何产品代码**；唯一写操作是本报告。编译探针在仓库外
>   `D:\PaperTeamData\AcademicFigureSkillEvaluation\scratch-templates\` 进行。
> - 边界声明：**用户所在学校模板未指定，本报告不把任何高校格式定义为 PaperTeam 统一标准**。
>   所有高校模板只作为「学校模板适配器」候选评估；推荐路线的默认形态是不绑定任何高校的
>   generic-ctexbook 适配器。
> - 事实来源纪律：模板事实全部来自本次经 `gh api`（HTTPS_PROXY=127.0.0.1:7890）读取的公开
>   仓库文件 / README、CTAN JSON 元数据（`curl -x`）、本机 MiKTeX `kpsewhich` 与实际编译日志；
>   PaperTeam 事实全部来自本次读取的源码并给出文件:行坐标。读不到或未展开核实的统一标注
>   「未核实」并汇总于 §9。调研中后段（2026-10-14 00:xx）本机 7890 代理关闭，个别补充读取未能
>   完成，已如实标注。

---

## 0. 摘要结论（10 条）

1. **十个模板中有九个以 `ctexbook` 为基类**（zjuthesis 例外：`ctexrep`），全部要求
   XeLaTeX（多数也支持 LuaLaTeX），没有一个走 pdfLaTeX 主路径（ucasthesis 声称兼容 pdflatex
   但以 xelatex 为主）。PaperTeam 现有 `xelatex` 编排在引擎层**无需更换**。
2. **参考文献后端是最大的分叉点**：thuthesis / ustcthesis / sysu-thesis / fduthesis / ucasthesis
   同时支持 bibtex+natbib 与 biblatex；**NJUThesis、hustthesis 类内直接 `\RequirePackage{biblatex}`，
   zjuthesis / SJTUThesis / pkuthss 示例工程默认 biblatex+biber**。PaperTeam `LatexCompiler`
   目前只编排 bibtex（`backend/src/latex/LatexCompiler.ts:221-244`），**接入这五个模板必须新增
   biber 编排**。
3. **发现一个现有编译器在 biblatex 下的静默漏判**：`UNDEFINED_CITATION_PATTERN`
   （`LatexCompiler.ts:95`）匹配 natbib/LaTeX 的反引号写法 ``Citation `key' on page``，而本机
   探针实测 biblatex 发出的是直引号 `LaTeX Warning: Citation 'vaswani2017' on page 1 undefined`
   （probe-ctexbook-biblatex/p1.out:150）。若只加 biber 调用而不改该正则，biblatex 文档的
   「引用未解析」终检会失效（PDF 带 `[?]` 却通过 Build Gate）。
4. **本机 MiKTeX 25.12 已装 7/10 个类**（thuthesis、njuthesis、pkuthss、sjtuthesis(sjtutex)、
   hustthesis、fduthesis、sysuthesis），缺 ustcthesis / zjuthesis / ucasthesis（这三者不在 CTAN）。
   `gb7714-2015.bbx`、`gbt7714-numerical.bst`、`gbt7714-author-year.bst`、biber 2.21 均就绪。
5. **两个编译探针均成功**：(A) ctexbook + biblatex-gb7714-2015 + biber：25 s 四步、0 未解析引用；
   (B) thuthesis 7.7.1 `degree=master` + natbib + bibtex：**首轮 xelatex 冷启动 133 s**（热重跑 5 s），
   13 页、封面正确。冷启动 133 s **已超过** PaperTeam 默认编译超时 120 s
   （`backend/src/config/config.ts:330`、`backend/src/serviceStack.ts:346`）。
6. **Writer 契约是「以 `\section{标题}` 开始的片段」**（`backend/src/writer/WriterService.ts:2052,2134`），
   而学位论文章节是 `\chapter`。需要一个确定性的标题层级提升（section→chapter）步骤，建议放在
   模板渲染/staging 层而不是改 Writer，并保持逐行 1:1 以不破坏 `diagnostics.ts` 的文件/行归属。
7. 组装根 `main.tex` 目前硬编码 `\documentclass[UTF8]{ctexart}` + `unsrt`
   （`backend/src/manuscript/ManuscriptService.ts:139-172`），且 Writer 提示词硬编码「可用宏包只有
   amsmath/amssymb/natbib/graphicx（ctexart）」（`WriterService.ts:1560,2134,2198`）。这是模板化要
   抽象出去的两处单点。
8. 许可证：7 个 LPPL-1.3c（thuthesis、NJUThesis、ustcthesis、hustthesis、fduthesis、sjtutex 类部分、
   pkuthss tex/ 部分、sysuthesis.cls 文件头）；zjuthesis MIT；**ucasthesis GPL-3**（cls 文件头）；
   sysu-thesis 仓库 LICENSE 为 GPL-3 但 cls 文件头为 LPPL（**不一致**）。LPPL 对「修改后再分发」有
   改名义务，PaperTeam **不应 vendoring 并修改任何 .cls**；CTAN 已收录的类应依赖发行版安装，
   未收录者按 D-0025/D-0030 的 pin SHA + LICENSE + PROVENANCE 契约随附且不修改。
9. 维护活跃度分三档：**活跃**（ustcthesis v5.0.2 2026-09-27、thuthesis v7.7.1 2026-05、
   NJUThesis v1.5.1 2026-06、sysu-thesis v2.1.1 2026-06、hustthesis v2.1.0 2026-03、SJTUThesis v2.3.1
   2026-03）；**停滞**（zjuthesis 最后 release 2023-11、fduthesis 2023-05、pkuthss 2024-03）；
   **事实上无维护**（ucasthesis 最后提交 2021-10、唯一 release 2018）。
10. **推荐路线**：先做与学校无关的 `generic-ctexbook` 适配器（硕士/博士/本科只影响封面文案），
    `ThesisDocumentModel` 作为唯一事实源，`TemplateAdapter` 只负责「模型 → 前置/后置 LaTeX +
    章节 emit + 编译 recipe」；第一批学校适配器候选为 **thuthesis**（CTAN、LPPL、key=value、双后端、
    本机探针已过）与 **ustcthesis/sysu-thesis 家族**（同构 API），**NJUThesis** 作为 biblatex-only 的
    代表。不推荐优先接入 zjuthesis（ctexrep + 元数据全在 documentclass 选项 + 固定目录宏驱动）、
    ucasthesis（GPL、无维护）、pkuthss（LaTeX2e 经典风格、停滞）。

---

## 1. 调研对象与元数据总表

数据来源：`gh api repos/<r>`、`/releases`、`/commits`、`/contents/.github/workflows`、
`/issues?state=all&since=2026-07-15`（2026-10-13 取数）；CTAN `https://ctan.org/json/2.0/pkg/<p>`；
本机 `kpsewhich`。

| 模板（仓库） | Stars | 许可证（API / 文件头） | 最近 release | 最近 push / 提交 | 90 天内 issue+PR 活动 | open issues | CI | CTAN 版本 | 本机 MiKTeX |
|---|---|---|---|---|---|---|---|---|---|
| 清华 tuna/thuthesis | 5465 | LPPL-1.3c | v7.7.1 2026-05-26 | 2026-08-18 / 2026-06-17 `Revert "Deprecate survey and translation environments" (#1069)` | 3 | 10 | `test.yml`（setup-texlive-action、l3build、`make all-dev`、多 OS matrix） | thuthesis 7.7.1（2026-05-26） | 已装 `tex/latex/thuthesis/thuthesis.cls` |
| 南大 nju-lug/NJUThesis | 705 | LPPL-1.3c | v1.5.1 2026-06-02 | 2026-06-11 `feat: 支持在导言区自行载入 biblatex 以应用补丁 (#317)` | 0 | 14 | `build.yml`/`release.yml`（自装 TeX Live、`l3build check -e xetex`、`latexmk -xelatex` 三个测试文档） | njuthesis 1.5.1（2026-05-30） | 已装（含 graduate/undergraduate/postdoctoral .def） |
| 北大 CasperVector/pkuthss | 627 | API null；README.txt：tex/ 与 doc/readme LPPL 1.3+，copy.tex/origin.tex New BSD，其余 public domain | v1.9.4 2024-03-07 | 2024-04-25 / 2024-04-20 | 0 | 4 | 无（`.github/workflows` 404） | CTAN JSON 请求异常，**未核实**；cls 头 `2024/03/07 v1.9.4` | 已装 `tex/latex/pkuthss/` |
| 中科大 ustctug/ustcthesis | 2130 | LPPL-1.3c | v5.0.2 2026-09-27 | 2026-09-27 `Bump to v5.0.2` | 6 | 1 | `test.yml`/`release.yml`（install-texlive、`make main`、`latexmk -lualatex main.tex`、`make test`） | 不在 CTAN（JSON 无记录） | **缺** |
| 上交 sjtug/SJTUThesis（类在 sjtug/SJTUTeX） | 3879 | 仓库 Apache-2.0；README L122-124：sjtutex 类 LPPL 1.3c，其余 Apache 2.0 | v2.3.1 2026-03-12 | 2026-05-20 / 2026-03-12 | 0 | 8 | `build.yml`/`release.yml` | 以 `sjtutex` 收录（本次只查 sjtuthesis 名无记录；sjtutex 本身**未经 CTAN JSON 核实**） | 已装 `tex/latex/sjtutex/sjtuthesis.cls`（ProvidesExplClass 2.3.1） |
| 浙大 TheNetAdmin/zjuthesis | 3776 | MIT | v10.0.1 2023-11-13 | 2025-12-08 `feat: add TrueBlankPage option` | 0 | 38 | `build_test.yml`/`pr_test.yml`/`release_code.yml` | 不在 CTAN | **缺** |
| 国科大 mohuangrui/ucasthesis | 3917 | API null；`Style/ucasthesis.cls` L6-9 与 `Thesis.tex` 头：GPL v3+ | v1.0 2018-01-30 | 2024-02-29 / 2021-10-29 `add gallery` | 1 | 23 | 无 | 不在 CTAN | **缺** |
| 华科 hust-latex/hustthesis（非官方） | 186 | LPPL-1.3c | v2.1.0 2026-03-06 | 2026-06-25（dependabot） | 0 | 4 | `ci.yml` + `_build/_check/_release.yml` | hustthesis 2.1.0（2026-03-06） | 已装（cls、-d/-m.def、.bbx/.cbx） |
| 中大 SYSU-SCC/sysu-thesis | 966 | 仓库 LICENSE GPL-3.0；`sysuthesis.cls` L3-8 LPPL 1.3c（**不一致**） | v2.1.1 2026-06-15 | 2026-09-04 `将参考文献格式更新至最新版 (#142)` | 2 | 5 | `test.yml` | sysuthesis **1.0.0（2026-02-06）**，落后 GitHub v2.1.1 | 已装（sysuthesis.cls、sysuvisual.sty） |
| 复旦 stone-zeng/fduthesis | 1047 | LPPL-1.3c | v0.9a 2023-05-27 | 2024-12-08 / 2024-05-06 | 0 | 23 | `main.yml`（含 `texlive-win.profile`，即测 Windows TeX Live） | fduthesis 0.9a（2023-05-27） | 已装（fduthesis.cls、fduthesis-en.cls） |

相关基础包（CTAN JSON，2026-10-13）：`biblatex-gb7714-2015` 1.1x（2026-06-10，LPPL）；`gbt7714`
3.1.1（2026-09-27，LPPL）；`ctex` 2.6.5（LPPL）。本机：`gb7714-2015.bbx`、`gbt7714.sty`、
`gbt7714-numerical.bst`、`gbt7714-author-year.bst`、`ctexbook.cls`、`biblatex.sty`、`fontspec.sty`、
`xeCJK.sty` 全部 `kpsewhich` 命中。

---

## 2. 逐维度对比总表

每格注明来源（文件:行 或 README 段）。「—」= 未发现该特性；「未核实」= 本次未读到。

### 2.1 文档类基类 / 引擎 / 源码形态 / 编译配置

| 模板 | 基类（LoadClass） | 引擎 | 源码形态 | latexmk / 构建 |
|---|---|---|---|---|
| thuthesis | `\LoadClass[a4paper,UTF8,zihao=-4,scheme=plain,fontset=none]{ctexbook}[2017/04/01]`（thuthesis.dtx:1783） | XeLaTeX（example.tex `% !TEX program = xelatex`）；latexmkrc 同时定义 `$lualatex` | **.dtx + .ins 文学化编程**，README L71「执行 `xetex thuthesis.ins`」；发布 zip 直接含 .cls（README L64） | latexmkrc：`$pdf_mode=5`、xelatex `-shell-escape -no-pdf` + xdvipdfmx、`$bibtex_use=1.5`、nomencl 自定义依赖；Makefile；CI l3build |
| NJUThesis | `LoadClass { ctexbook } [ 2018/04/01 ]`（njuthesis.cls:803，ProvidesExplClass） | xelatex 或 lualatex（README-CTAN「requires either xelatex or lualatex」） | .dtx（source/），用户用 template/ 下现成 .tex/.def；`l3build unpack` 仅供开发者（README L53） | README L32 `latexmk -xelatex`；source/latexmkrc；CI 用 `l3build check -e xetex` |
| pkuthss | `\LoadClass[zihao = -4]{ctexbook}[2014/03/06]`（pkuthss.cls:72，LaTeX2e 经典 `\DeclareOption`） | 未在 README.txt 声明（指向 pkuthss.pdf）；MiKTeX 已装；**未核实** | 直接 .cls + .def（tex/）；doc/example 含 latexmkrc、Make.bat | 顶层 Makefile 只做 dist/qa/bump（Makefile:1-18）；示例 Makefile 读取失败（未核实） |
| ustcthesis | `\LoadClass` 位于 ustcthesis.cls:317（参数跨行，基类名未展开核实；按 `\frontmatter/\chapter/\mainmatter` 用法为 ctexbook 家族）；`ProvidesExplClass{ustcthesis}{2026-09-27}{5.0.2}`（L24）；L21 要求 TeX Live 2021+ | XeLaTeX（main.tex `% !TEX program = xelatex`）；CI 另跑 `latexmk -lualatex` | 直接 .cls（147 KB expl3） | latexmkrc：`$pdf_mode=5`、xelatex `-no-pdf` + xdvipdfmx、`$bibtex_use=1.5`、glossaries/nomencl 依赖；README L42-50 `latexmk -xelatex main.tex` |
| SJTUThesis | `LoadClass { ctexbook }`（sjtuthesis.cls:262，ProvidesExplClass 2.3.1） | 仅 xelatex/lualatex（cls 定义 `unsupported-engine` 消息 L34；README L40 需切 XeLaTeX） | 类在独立仓库 SJTUTeX / CTAN sjtutex；本仓库是示例工程 | `.latexmkrc`：`$pdf_mode=5`、`$bibtex_use=2`、`ensure_path('TEXINPUTS','./texmf//')`；`Compile.bat`（README L69-71） |
| zjuthesis | **`\LoadClass[zihao=-4,UTF8]{ctexrep}`**（zjuthesis.cls，`\RequirePackage{kvoptions}`） | XeTeX（README L44）；`latexmk -pdflua` 可选（L82） | 直接 .cls + `config/{packages,commands,path,version}.tex` + `config/format/` | `.latexmkrc`：`$out_dir="out"`、`$pdf_mode=5`、`@default_files=('zjuthesis.tex')`；README L81「**请务必使用此 latexmk 命令**」；L155 issue 只受理 latexmk 产生的问题 |
| hustthesis | `LoadClass { ctexbook }`（hustthesis.dtx:1320） | XeLaTeX 或 LuaLaTeX（README.zh-cn L18）；推荐 TeX Live 2026（L16-17） | .dtx（单文件 147 KB） | `.latexmkrc`：`$pdf_mode=5`、`$out_dir='build'`、`-shell-escape`，默认目标是 dtx 文档 |
| sysu-thesis | `\LoadClass[UTF8,a4paper,scheme=plain,zihao=-4,fontset=none]{ctexbook}[2017/04/01]`（sysuthesis.cls:425）；L27-29 要求 TeX Live 2017+ | XeLaTeX（main.tex 头）；latexmkrc 定义 lualatex | 直接 .cls（106 KB） | latexmkrc 与 ustcthesis 同构（`$pdf_mode=5`、`$bibtex_use=1.5`）；README L47-59 `latexmk -xelatex main.tex` |
| fduthesis | `LoadClass { ctexbook }`（fduthesis.cls:210，ProvidesExplClass） | XeLaTeX（README L30 `% !TeX program = XeLaTeX`） | .dtx（source/fduthesis.dtx + -doc.dtx + -logo.dtx），CTAN 发布 .cls；另有 `fduthesis-en.cls` | source/latexmkrc；CI 含 Windows TeX Live profile |
| ucasthesis | `\LoadClass[UTF8,a4paper,zihao=-4]{ctexbook}`（Style/ucasthesis.cls:65，`ProvidesClass ... 2014/10/01 v1.0`） | README L24 声称 pdflatex/xelatex/lualatex 皆可 | 直接 .cls + `Style/artratex.sty`（文档设置）+ `Style/artracom.sty` | `artratex.sh` / `artratex.bat` 自制脚本 |

### 2.2 封面 / 声明页 / 学位类型

| 模板 | 元数据入口 | 学位类型 | 封面与声明 |
|---|---|---|---|
| thuthesis | `\documentclass[degree=master]{thuthesis}` + `\thusetup{key=value}`（thusetup.tex：title/title*/degree-category/department/discipline/author/supervisor/associate-supervisor/co-supervisor/date/secret-level/secret-year/include-spine/clc/udc…） | `degree = doctor|master|bachelor|postdoc`；`degree-type = academic|professional`；`style-override=schwarzman`；`language=chinese|english`（example.tex 注释） | `\maketitle`、`\input{data/committee}`、`\copyrightpage[file=…]`、`\statement[file=…]`、`\input{data/comments}` / `resolution`（example.tex）；`output=print|electronic`、`thesis-type=proposal` |
| NJUThesis | `\njusetup[info]{title, title*, author, author*, keywords, keywords*, grade, student-id, department, major, supervisor, submit-date, field, chairman, reviewer, clc, udc, defend-date, confer-date, bottom-date, supervisor-contact}`（template/njuthesis-setup.def） | `type .choices = bachelor|master|doctor|postdoctoral`（cls:621）；`degree .choice`（L625）；`anonymous` bool 盲审（L652） | `\maketitle`；type 分别由 njuthesis-graduate/undergraduate/postdoctoral.def 实现 |
| pkuthss | `\pkuthssinfo{cthesisname, ethesisname, thesiscover, ctitle, etitle, cauthor, eauthor, date, studentid, school, cmajor, emajor, direction, mentorlines, cmentor, ementor, ckeywords, ekeywords, degreetype(1/2/0), blindid, discipline}`（doc/example/thesis.tex） | 无 degree 选项；学位名是**用户填写文本**（`cthesisname={博士学位论文}`），`degreetype` 1 学术/2 专业/0 不显示 | `\maketitle` / `\makeblind`（`\newif\ifblind`）；版权页 `chap/copy.tex`、原创性声明 `chap/origin.tex` 由用户 `\include` |
| ustcthesis | `\documentclass[degree=doctor]{ustcthesis}` + `\ustcsetup{title, title*, author, student-id, discipline, supervisor, practice-supervisor, date, clc, udc, department, research-direction, secret-level, secret-year, math-style, math-font, keywords, keywords*}`（ustcsetup.tex、chapters/abstract.tex） | `degree = doctor|master|bachelor`；`degree-type = academic|professional|engineering`；`language = chinese|english`；`review` 盲审（cls:121-146） | `\maketitle`、`\declarationoforiginality[file=…]`、**`\declarationofaiusage[purpose=none|文献检索|语言润色|数据处理]`**（main.tex，AI 使用声明页）、`\include{chapters/innovations}`（博士创新性说明） |
| SJTUThesis | `\documentclass[type=master]{sjtuthesis}` + `\sjtusetup{info={zh/title, en/title, zh/keywords, en/keywords, zh/author, id, zh/supervisor, zh/department, zh/major, zh/degree, date, fund…}, style={…}, name={bib, ack, achv}}`（setup.tex） | `type = doctor|master|bachelor`（默认 master）；`review` 盲审；`lang = zh|en|de|ja`；`preset = base|jwc`（main.tex 注释、cls:143-212） | `\maketitle`、`\copyrightpage[file=…]`（main.tex） |
| zjuthesis | **全部作为 documentclass 选项**：ClassNumber、Security、StudentName、StudentID、AdvisorName、Grade、Major、Department、SubmitDate、Title、TitleEng、Topic、ColaboratorName…（zjuthesis.tex / cls `\DeclareStringOption`） | `Degree = undergraduate|graduate` + `GradLevel = master|doctor` + `Type = thesis|design` + `Period = proposal|paper|final` + `BlindReview` + `Language` | 由 `\inputpage{cover}` 等宏读取固定目录 `body/graduate/…`（zjuthesis.tex 宏 `\inputgraduate`） |
| hustthesis | `\documentclass[type=doctor]{hustthesis}` + `\hustsetup{info={title, title*, degree=academic|professional, degree*, author, author*, student-id, clc, major, major*, supervisor, supervisor*, date, committee}, style={toc-depth}}`（demo/main.tex） | `type = doctor|master`（只有 -d/-m 两个 .def，**无本科**） | `\maketitle` = `\makezhtitle` + `\makecommittee`（硕士默认不生成）+ `\makeentitle`（demo 注释） |
| sysu-thesis | `\documentclass[fontset=fandol,degree=bachelor]{sysuthesis}` + `\sysusetup{title, title*, author, author*, speciality, supervisor, practice-supervisor, date, professional-type, department, student-id, secret-level, secret-year, reviewer, math-style, math-font, cite-style, keywords, keywords*, keywords**}`（sysusetup.tex、docs/abstract.tex） | `degree = doctor|master|bachelor`；`degree-type = academic|professional`；`language = chinese|english`（main.tex 注释） | `\maketitle`、`\copyrightpage`（main.tex） |
| fduthesis | `\fdusetup{style={font-size, fullwidth-stop}, info={title, title*, author, supervisor, major, degree=academic, department, student-id, keywords, keywords*, clc}}`（README L33-51） | `type .choices`（cls:152；README：博士/硕士/本科）；`degree = academic|professional`（cls:935） | 未核实（README 片段未含声明页命令） |
| ucasthesis | `Tex/Frontinfo.tex`（**未读取**，键名未核实） | documentclass 选项 `oneside|twoside|print`、`fontset`、`scheme=plain`（国际生）、`draftversion`（Thesis.tex 注释）；本/硕/博靠 Frontinfo 文本 | `\maketitle`（中文）、`\MAKETITLE`（英文）、`\makedeclaration`（Tex/Frontmatter.tex） |

### 2.3 摘要 / 关键词

| 模板 | 中文摘要 | 英文摘要 | 关键词 |
|---|---|---|---|
| thuthesis | `\begin{abstract}…\end{abstract}` | `\begin{abstract*}` | 在摘要环境内 `\thusetup{keywords={a, b}}` / `keywords*`，西文逗号分隔自动转换（data/abstract.tex；dtx L667-672） |
| NJUThesis | `abstract` 环境（cls:2030） | `abstract*`（cls:2040） | `\njusetup[info]{keywords=…, keywords*=…}`（setup.def） |
| pkuthss | `cabstract` 环境（cls:456） | `eabstract` / `beabstract`（cls:464-477） | `\pkuthssinfo{ckeywords=…, ekeywords=…}` |
| ustcthesis | `abstract`（cls:2683） | `abstract*`（L2701）、另有 `enabstract`（L2758） | `\ustcsetup{keywords=…, keywords*=…}`（chapters/abstract.tex） |
| SJTUThesis | `\begin{abstract}[zh]` | `\begin{abstract}[en]`（contents/abstract.tex） | `zh / keywords` / `en / keywords`（setup.tex info） |
| zjuthesis | 由 body 目录下 `abstract.tex` 提供（config/commands.tex L39-113 目录注释）；环境形态**未核实** | 同左 | 未核实 |
| hustthesis | `abstract`（dtx:2975） | `abstract*`（dtx:2980） | 摘要环境内 `\keywords 关键词1；关键词2` / `\keywords* k1, k2`（demo/main.tex） |
| sysu-thesis | `abstract`（cls:2362） | `abstract*`（L2406）；**`abstract**` 第三语言（法语）**（L2456） | `\sysusetup{keywords, keywords*, keywords**}`（docs/abstract.tex） |
| fduthesis | `abstract`（cls:1393） | `abstract*`（L1395） | `\fdusetup{info={keywords, keywords*}}`（README） |
| ucasthesis | **手写** `\intobmk\chapter*{摘\quad 要}` + 正文 + `\keywords{…}` | `\intobmk\chapter*{Abstract}` + `\KEYWORDS{…}`（Tex/Frontmatter.tex） | 命令 `\keywords` / `\KEYWORDS` |

### 2.4 目录 / 图表目录 / 编号深度 / 公式 / 定理

| 模板 | 目录命令 | secnumdepth / tocdepth | 公式编号 | 定理环境 |
|---|---|---|---|---|
| thuthesis | `\tableofcontents`、`\listoffigures`、`\listoftables`、`\listoffiguresandtables`、`\listofalgorithms`（dtx 文档段；example.tex） | `secnumdepth=3`、`tocdepth=2`（dtx:4109-4110） | 重定义 `\theequation`（dtx:3728；ctexbook 默认按章，括号全角/半角由选项控制 dtx 文档段「公式编号两边的括号样式」） | 内置 axiom/theorem/definition/proposition/lemma/conjecture/proof/corollary/example/exercise/assumption/remark/problem（dtx:864-890），需用户先 `\usepackage{amsthm}` 或 ntheorem（thusetup.tex） |
| NJUThesis | `\tableofcontents`；`\njusetup[tableofcontents/dotline]{chapter}`（setup.def） | grep 无 `secnumdepth/tocdepth` 显式设置 → 未核实（继承 ctexbook） | 未核实 | `\njusetup[theorem]{…}`、`[math]{…}`（setup.def；cls:1607-1731 theorem style/type 键） |
| pkuthss | `\tableofcontents`（thesis.tex） | `secnumdepth=3`、`tocdepth=2`（cls:286-287） | 未核实 | — （用户自备） |
| ustcthesis | `\tableofcontents`、`\listoffigures`、`\listoftables`、`\listoffiguresandtables`（main.tex） | `secnumdepth` 3 或 4（cls:2485-2486, 2564；视 degree/section-style） | 未核实（`math-style = TeX|ISO|GB` 影响符号） | 内置 `ustc` theoremstyle 与 theorem/assertion/axiom/corollary/lemma/proposition/assumption/definition/example/remark（cls:3626-3684），需 `\usepackage{amsthm}`（ustcsetup.tex） |
| SJTUThesis | `\tableofcontents`、`\listoffigures`、`\listoftables`、`\listofalgorithms`（main.tex） | `\ctex_set:n { secnumdepth = 3 }`（cls:647） | 未核实（`math-style=ISO|TeX`） | `sjtu` theoremstyle，`\newtheorem` 循环生成（cls:1351-1414）；setup.tex 载入 amsthm |
| zjuthesis | 由 `ListOfContents/ListOfFigures/ListOfTables/ListOfAlgorithms` 布尔选项控制（cls） | `\changelocaltocdepth` 宏（commands.tex:302-305） | `chngcntr` 宏包；`algorithm[chapter]`（packages.tex） | — |
| hustthesis | `\tableofcontents`；`style={toc-depth=section|subsection}`（demo；dtx:3026-3028 映射 ctex tocdepth） | 见左 | 未核实 | 未核实 |
| sysu-thesis | 同 ustcthesis（main.tex） | 未核实 | sysusetup.tex 给出按章 `x-x` 改法注释（`\theequation` 慎用） | 内置（cls `proof` 环境 L3490；其余与 ustc 同构，未逐一核实） |
| fduthesis | `\tableofcontents`（README） | 未核实 | 未核实 | `style .tl_set = \l__fdu_thm_style_tl`（cls:821） |
| ucasthesis | `\tableofcontents`、`\listoffigures`、`\listoftables` + `\intobmk*`（Thesis.tex） | 未核实 | 未核实 | README 2019-02-20 条目「增加定理、定义、证明等数学环境」（artratex `math` 选项） |

### 2.5 参考文献

| 模板 | 后端 | 样式文件 | 顺序编码 / 著者-出版年 | 引用命令 |
|---|---|---|---|---|
| thuthesis | **双后端**：bibtex+natbib 默认（thusetup.tex `\usepackage[sort]{natbib}` + `\bibliographystyle{thuthesis-numeric}`）；biblatex 可选 | 仓库根：thuthesis-numeric/author-year/bachelor 的 `.bst` 与 `.bbx/.cbx`，`thuthesis-inline.cbx` | 两者皆有；`cite-style = inline`（dtx:932-940） | `\cite`、`\inlinecite`；author-year 用 natbib `\citep/\citet` |
| NJUThesis | **类内 `RequirePackage { biblatex }`**（cls:1543）→ biber 必需 | 由 `\njusetup[bib]{resource=…}` 指定（setup.def）；样式键未核实 | 未核实 | `\cite`（sample.tex）；`\printbibliography` |
| pkuthss | 类不载入 bib 包；示例 `\usepackage[backend=biber, style=caspervector, utf8, sorting=ecnyt]{biblatex}`，注释建议可改 `style=gb7714-2015`（thesis.tex） | biblatex-caspervector（CTAN 另一包，未核实） | sorting 选项 | `\cite`/`\parencite`/`\supercite`（thesis.tex FAQ 段） |
| ustcthesis | 双后端：natbib + `ustcthesis-numeric.bst`（默认）或 `biblatex style=ustcthesis-numeric|authoryear`（ustcsetup.tex） | 仓库根 `.bst` + `.bbx/.cbx` | 两者；`cite-style = super|inline|authoryear`（cls:208） | `\cite`；ustcsetup.tex 同时出现 `\bibliographystyle{…}` 与 `\addbibresource{references.bib}`（类内兼容处理，未细读） |
| SJTUThesis | 示例 `\usepackage[backend=biber,style=gb7714-2015]{biblatex}`（setup.tex）；类本身不载入 | biblatex-gb7714-2015 | 由 gb7714-2015 变体决定 | `\cite`；`\printbibliography[heading=bibintoc]` |
| zjuthesis | `\usepackage[style=gb7714-2015, gbcitelocal=chinese]{biblatex}`（config/packages.tex）→ biber | biblatex-gb7714-2015 | 同上 | `\cite` |
| hustthesis | **类内 `\RequirePackage[style=hustthesis]{biblatex}`**（dtx:1342）；hustthesis.bbx/.cbx 基于 gb7714-2015（dtx:3583, 3598）→ biber | 随类发布 | 未核实 | `\cite`；`\printbibliography` |
| sysu-thesis | 双后端：natbib + `sysuthesis-numerical.bst`（默认，`cite-style=super`）或 biblatex `sysuthesis-numeric|authoryear|inline`（sysusetup.tex） | 仓库根 `.bst` + `.bbx/.cbx` | 两者；旧式选项 `super/numbers/authoryear`（cls:401-403） | `\cite` |
| fduthesis | `bib-backend = bibtex|biblatex`（cls:1484-1492）；`bib-style = numerical|author-year|<其他>`（L1494-1510，默认 numerical L1719）；`bib-resource` | 内部 GB 样式（未核实文件名） | 两者 | `cite-style` 键（L1511） |
| ucasthesis | artratex 选项 `bibtex|biber`；`numbers|super|authoryear|alpha`（Thesis.tex 注释） | **仓库内自带副本** `Biblio/gbt7714-numerical.bst`、`gbt7714-author-year.bst`、biblatex `gb7714-2015`/`gb7714-2015ay`（artratex.sty:476-521） | 两者 | natbib / biblatex 原生命令 |

### 2.6 页眉页脚 / 前后置分区 / 附录 / 致谢 / 成果列表

| 模板 | 分区与页码 | 附录 | 致谢 | 发表成果 / 简历 |
|---|---|---|---|---|
| thuthesis | `\frontmatter`/`\mainmatter`/`\backmatter`（example.tex；fancyhdr dtx:1803） | `\appendix` + `\input{data/appendix}`；附录内图表公式「冠以附录序号」（data/appendix.tex） | `acknowledgements` 环境（data/acknowledgements.tex） | **`resume` 环境 + `achievements` 列表环境**（data/resume.tex）、`\statement`、committee/comments/resolution 页 |
| NJUThesis | `\mainmatter`（sample.tex；无显式 frontmatter，由 `\maketitle`/abstract 内部处理） | `\appendix` + `\chapter`（sample.tex） | `acknowledgement` 环境（cls:2053） | `preface`、`notation`/`notation*`（cls:2050-2162）；成果列表环境未发现 |
| pkuthss | 手写 `\frontmatter` + `\pagestyle{empty}` + `\pagenumbering{Roman}` + `\mainmatter` + `\backmatter`（thesis.tex） | `\appendix` + `\include{chap/encl1}` | `chap/ack.tex`（普通 chapter） | — |
| ustcthesis | `\frontmatter`/`\mainmatter`/`\backmatter`，章节用 **`\include`**（main.tex） | `\appendix` + `\include{chapters/appendix}` | `acknowledgments`/`acknowledgements` 环境（cls:3377-3398） | **`achievements` / `achievements*`（盲审版）/ `publications` / `theachievements[分类]`**（cls:3406-3449；chapters/achievements.tex） |
| SJTUThesis | 三分区 + `%TC:ignore` 字数统计标记（main.tex） | `\appendix` + `\captionsetup{list=no}` | `acknowledgements` 环境（cls:1156） | **`achievements` + `bibliolist`/`bibliolist*`（盲审）+ `resume`**（cls:1229-1252）；本科 `digest` 大摘要 |
| zjuthesis | `\coverstyle`/`\prevstyle`/`\bodystyle`/`\poststyle` 自定义页式 + `\resetpagecounter`（zjuthesis.tex） | `body/graduate/post/appendix.tex` | 未核实（post 目录） | `body/graduate/post/cv.tex` |
| hustthesis | `\frontmatter`/`\mainmatter`/`\backmatter`（demo） | `\appendix` + `\chapter`（demo） | `acknowledgements`（dtx:3215） | 未发现专用环境 |
| sysu-thesis | 同 ustcthesis（main.tex，用 `\input`） | `\appendix` + `docs/complementary.tex` | `acknowledgements`/`acknowledgments`（cls:3276-3293） | `achievements`/`publications`/`theachievements`（cls:3300-3312） |
| fduthesis | 未核实 | 未核实 | `acknowledgements`（cls:1471） | 未发现 |
| ucasthesis | `\frontmatter`/`\mainmatter`/`\backmatter` + `\intotoc*`（Thesis.tex） | `\appendix` + `Tex/Appendix.tex` | 手写 `\chapter[致谢]{致\quad 谢}`（Backmatter.tex） | 手写 `\chapter{作者简历及攻读学位期间发表的学术论文与研究成果}` + `\section*`（Backmatter.tex） |

### 2.7 字体依赖 / 跨发行版

| 模板 | 字体机制 | Windows / Linux 说明 |
|---|---|---|
| thuthesis | `fontset = windows|mac|ubuntu|fandol|none`，默认自动按 OS（dtx:326-333）；表 tab:fontset：windows = Times New Roman/Arial/Courier/中易宋黑仿楷；ubuntu = TeX Gyre + 思源/Fandol；fandol = TeX Gyre + Fandol；`font`/`cjk-font` 细粒度（含 noto） | dtx 明示「建议用户在提交终版前使用 Windows 平台的字体进行编译」；README L41 TeXPage 提供 Windows 字体；Overleaf 易超时（issue #984） |
| NJUThesis | `fontset`/`latin-font`/`cjk-font`/`math-font`/`font-path`（cls:655-675）；sample 用 `fontset = win` | CI 在 Linux TeX Live 跑三份测试文档 |
| pkuthss | 示例目录含 `ctex-fontset-pkuthss.def`（自定义 fontset） | 未核实 |
| ustcthesis | `fontset = auto|windows|mac|ubuntu|fandol|none`、`cjk-font = auto|windows|mac|noto|fandol|none`、`font`、`math-font`（cls:130-175） | README L12「兼容最新版 TeX Live、MacTeX、MiKTeX」；L18 ≥2021 |
| SJTUThesis | `cjk-font` 取值对应 `font/sjtu-cjk-font-{adobe,fandol,founder,hanyi,mac,ubuntu,windows}.def`（本机 sjtutex 目录）；`fontset` 已弃用并映射到 cjk-font（cls:173） | README L16 要求最新发行版并常更新 |
| zjuthesis | Overleaf 需按 `fonts/README.md` 上传字体（README L38）；devcontainer 安装字体（L93）；具体 `\setCJKmainfont` 配置**未核实**（代理关闭） | macOS ctex<2.5 宋体判断问题 issue #79（README L87） |
| hustthesis | `fontset = fandol|mac|macoffice|win|none`（dtx:1204）；`cjk-font = fandol|founder|mac|macoffice|noto|source|win|none`（L1195）；默认 mac→mac 否则 fandol（L1395-1397） | 推荐 TeX Live 2026 |
| sysu-thesis | `fontset = windows|mac|ubuntu|fandol`（main.tex）；devcontainer 探测文件存在时切 `cjk-font = noto`（sysusetup.tex） | README L7 兼容 TeX Live/MacTeX/MiKTeX；字体问题 issue #29 |
| fduthesis | `font`/`cjk-font` 键（cls:257-264） | CI 含 `texlive-win.profile` |
| ucasthesis | `fontset=<adobe|none|...>`，README 大段讨论 Windows PDF 拷贝乱码与字体配置 wiki | README L24 声称三 OS 兼容 |

本机字体事实：`C:\Windows\Fonts` 含 `simsun.ttc`、`simhei.ttf`、`simkai.ttf`、`simfang.ttf`、`msyh*.ttc`
（Windows 11 Home China）。探针 A 日志显示实际加载 SimSun ×6、SimHei ×3、KaiTi ×3。

---

## 3. 逐模板要点（含移植/适配难易度）

评分口径（仅供排序，不是质量评判）：**接口参数化程度**（元数据是否 key=value、是否能全部由程序
生成）/ **分发**（CTAN 可装 vs 需随附）/ **维护**（近 12 个月 release）/ **bib 后端兼容现有编译器**。

### 3.1 thuthesis（清华）— 适配首选候选

- 接口：`\documentclass[degree=…,degree-type=…,fontset=…]{thuthesis}` + `\thusetup{}` 全 key=value，
  封面/声明/成果页均由命令或环境产出，前后置部分完全可由程序 emit。
- 分发：CTAN 7.7.1 与 GitHub release 同步；MiKTeX 已装；LPPL-1.3c。
- bib：默认 bibtex+natbib（与现有 `LatexCompiler` 直接兼容），biblatex 可选。
- 风险：`.dtx` 源码不等于可用 .cls（需发行版或 release zip）；`\thusetup` 「配置里面不要出现
  空行」（thusetup.tex 注释，kvsetkeys 机制）→ 程序 emit 时必须保证无空行；`-shell-escape`
  出现在 latexmkrc 但探针未开启亦可编译；Overleaf 编译超时 issue 表明文档类加载开销大
  （本机冷启动 133 s，见 §4）。
- 本机探针 B 通过（13 页）。

### 3.2 NJUThesis（南大）— biblatex-only 代表

- 接口：expl3 `\njusetup[info]{}`、`[bib]{resource=}`、`[abstract]`、`[theorem]`… 分组键，参数化程度高；
  `type = bachelor|master|doctor|postdoctoral`，`anonymous` 盲审。
- 分发：CTAN 1.5.1，MiKTeX 已装；LPPL。CI 自装 TeX Live 并用 l3build 回归。
- bib：**类内加载 biblatex** → 必须 biber；2026-06 #317 允许用户在导言区先载入 biblatex 打补丁。
- 风险：最小示例无 `\frontmatter`（由类处理），与「三分区」通用模型有差异；成果列表无专用环境。

### 3.3 pkuthss（北大）— 停滞、经典 2e 风格

- 接口：`\pkuthssinfo{}` key=value，但学位名靠文本；无 degree 选项；布尔选项式 `\DeclareOption`。
- 分发：MiKTeX 已装；LPPL（tex/）；GitHub 为 gitea 镜像；无 CI；最后 release 2024-03。
- bib：示例默认 biblatex-caspervector（另一个 CTAN 包）+ biber；可换 gb7714-2015。
- 结构：前言区分页/页码全靠用户在 thesis.tex 手写（`\pagenumbering{Roman}` 等），
  适配层要 emit 的骨架更多。

### 3.4 ustcthesis（中科大）— 最活跃、接口最完整，但不在 CTAN

- 接口：expl3 键齐全（degree/degree-type/language/review/fontset/cjk-font/math-*/cite-style/section-style），
  环境齐全（innovations/abstract/abstract*/enabstract/notation/achievements/achievements*/theachievements），
  **含 AI 使用声明页** `\declarationofaiusage`。
- 分发：**不在 CTAN、本机缺** → 必须随附 .cls + .bst/.bbx/.cbx（LPPL 允许原样分发），pin tag v5.0.2。
- bib：双后端，默认 natbib（兼容现状）。
- 结构用 `\include`（每章独立 .aux），`LatexFiles.ts` 已支持 `\include`（L111-114）。

### 3.5 SJTUThesis / SJTUTeX（上交）

- 类在 CTAN `sjtutex`（本机已装 2.3.1），示例工程 Apache-2.0、类 LPPL。
- 接口：`\sjtusetup{info={zh / title, en / title …}}` 的 `zh/`、`en/` 前缀双语键是独特形态；
  `type`、`review`、`lang=zh|en|de|ja`。
- bib：示例 biblatex gb7714-2015 + biber（类不强制）。
- 盲审专用 `bibliolist*`/`achievements` 环境完善。

### 3.6 zjuthesis（浙大）— 不推荐优先接入

- `ctexrep` 基类；**全部元数据是 `\documentclass[...]` 选项**；正文由 `\inputbody{content}` 等宏读取
  固定目录 `body/graduate/content.tex`、`post/{appendix,cv,ref}.tex`——文件布局即接口，
  与 PaperTeam `sections/<file>.tex` 模型冲突最大；README 强制 latexmk 工作流（`$out_dir=out`），
  issue 只受理 latexmk 产生的问题。
- 最后 release 2023-11（commits 持续到 2025-12），open issues 38；MIT；非 CTAN。
- bib：biblatex gb7714-2015 + biber。

### 3.7 hustthesis（华科，非官方）

- CTAN 2.1.0，MiKTeX 已装，LPPL，CI 完整；只有 doctor/master。
- **类内 `\RequirePackage[style=hustthesis]{biblatex}`** → biber 必需；`\keywords`/`\keywords*` 是
  命令而非键；`style={toc-depth=…}`；README 推荐 TeX Live 2026（旧版本见 PR #49）→ MiKTeX 25.12
  兼容性**未核实**（未探针）。

### 3.8 sysu-thesis（中大）— ustcthesis 同构

- 接口/结构与 ustcthesis 同构（README L15 直接链接 ustctug wiki），`abstract**` 第三语言，
  `cite-style=super`。
- 分发：CTAN sysuthesis **1.0.0（2026-02）落后 GitHub v2.1.1（2026-06）**，本机装的是 CTAN 版；
  仓库 LICENSE GPL-3 与 cls 文件头 LPPL 不一致——接入前须向上游确认（§9）。

### 3.9 fduthesis（复旦）

- CTAN 0.9a（2023-05），MiKTeX 已装，LPPL；`bib-backend = bibtex|biblatex` 由类统一抽象，是
  「后端作为类选项」的好范例；CI 测 Windows TeX Live。
- 停滞：最后提交 2024-05，open issues 23。

### 3.10 ucasthesis（国科大）— 不推荐

- GPL-3（cls 头）；最后提交 2021-10；无 CI；非 CTAN；仓库内自带 gbt7714 .bst 副本（二次分发）；
  摘要/致谢/成果全部手写 `\chapter*`，无环境；`artratex.sty` 把 bib/排版选项揉在一个包里。

---

## 4. 本机可用性探针结果

环境：MiKTeX 25.12（MiKTeX-XeTeX 4.16、LuaHBTeX 1.24.0、MiKTeX-BibTeX 4.2、biber 2.21、
pdftoppm 24.04）。`MIKTEX_ENABLE_INSTALLER=1`。目录 `D:\PaperTeamData\AcademicFigureSkillEvaluation\scratch-templates\`。

### 4.1 探针 A：`probe-ctexbook-biblatex/`（generic-ctexbook 形态）

- 文档：`\documentclass[UTF8,zihao=-4,fontset=windows]{ctexbook}` + amsmath/graphicx +
  `\usepackage[backend=biber,style=gb7714-2015]{biblatex}` + `\addbibresource{references.bib}` + hyperref；
  `\frontmatter`/`\mainmatter`/`\appendix`/`\backmatter`，两章、一公式、两条引用，
  `\printbibliography[heading=bibintoc]`。
- 结果：xelatex pass1 **9 s**（exit 0）→ `biber main` **17 s**（找到 references.bib，输出 main.bbl）→
  xelatex ×2 → **总 25 s**；`main.log` 未解析引用 0；PDF 40 656 B；无自动装包（所需包已在本机）。
- 关键日志形态（pass1 stdout `p1.out`）：
  - L150 `LaTeX Warning: Citation 'vaswani2017' on page 1 undefined on input line 17.`（**直引号**）
  - L173 `Package biblatex Warning: Please (re)run Biber on the file:`
- 渲染首页（pdftoppm 40 dpi）：标题「探针文档」/ PaperTeam / 日期，正常。

### 4.2 探针 B：`probe-thuthesis/`（学校模板形态）

- 文档：`\documentclass[degree=master,fontset=windows]{thuthesis}` + `\thusetup{title…keywords*}` +
  amsthm + `\usepackage[sort]{natbib}` + `\bibliographystyle{thuthesis-numeric}` + hyperref；
  `\maketitle`、abstract/abstract*、toc、两章、`\bibliography{references}`、appendix、acknowledgements。
- 结果：**xelatex pass1 133 s（冷）**（exit 0；`Document Class: thuthesis 2026/05/26 7.7.1`）→ bibtex
  `You've used 2 entries` → xelatex ×2 → **总 143 s**；**热重跑单轮 5 s**；13 页、PDF 122 979 B；
  未解析引用 0。stdout 未出现 `installing` 字样，冷启动耗时成因（字体缓存 / xits 数学字体首次
  加载 / MiKTeX 包数据库刷新）**未定位**。
- 渲染首页：封面「探针文档 /（申请清华大学工学硕士学位论文）/ 培养单位：计算机科学与技术系 /
  学科：… / 研究生：张三 / 指导教师：李四 教授 / 二〇二六年十月」，格式正确。

### 4.3 对 PaperTeam 的直接含义

- 冷启动 133 s **> 默认 `DEFAULT_LATEX_COMPILE_TIMEOUT_MS = 120_000`**（config.ts:330；
  `serviceStack.ts:346` 亦硬编码 120_000；上限 `LATEX_TIMEOUT_MAX_MS = 1_800_000` config.ts:383）。
  学位论文 profile 需要更高的默认预算（建议 ≥ 600 s）与「冷/热」区分。
- biber 可用且 25 s 内完成，biblatex 路线在本机可行。
- `TEX_PRODUCT_EXTENSIONS` 已包含 `.bcf`、`.run.xml`（LatexCompiler.ts:108,120），biblatex 产物
  清理不需改。

---

## 5. PaperTeam 对接分析（代码坐标）

### 5.1 现状坐标

| 关注点 | 坐标 | 事实 |
|---|---|---|
| 编译编排 | `backend/src/latex/LatexCompiler.ts:6-27`（头注释）、`:84` `XELATEX_ARGS` 硬编码 `main.tex`、`:217-256` | xelatex → 若 `main.aux` 含 `\bibdata{` 则 `bibtex main`（:224-230）→ xelatex ×2 + 最多 2 轮 Rerun（:92 `RERUN_PATTERN`、:101）；**无 biber 分支** |
| 未解析引用终检 | `LatexCompiler.ts:95` ``/Citation `[^']+' on page \d+ undefined/`` | 反引号开头；biblatex 实测为直引号（§4.1）→ **biblatex 文档漏判** |
| bibtex 0 条目守卫 | `:98` `/used 0 entries/i`、`:237-243` | 仅 bibtex `.blg`；biber `.blg` 格式不同（`INFO - Found BibTeX data source`），需另写守卫 |
| 工具探测 | `:151-156` `detectTool` | 只认 xelatex / bibtex |
| staging | `:320-337` | `cp(manuscriptDir, buildDir)` 全量复制 + 递归清理产物扩展名 |
| 诊断 | `backend/src/latex/diagnostics.ts:36-47` `FONT_ISSUE_PATTERN`/`FONT_ISSUE_HINT`；`:62-120` 解析 `!` 行 + `l.NNN` + 括号文件栈 | 字体缺失已分类并给 MiKTeX/TeX Live 提示；文件归属依赖 `(path` 栈 |
| Build Gate | `backend/src/quality/gates.ts:63-75`、`:78-110`；`:87` `/\\(bibliography|addbibresource)\{/` | bibMissing 已同时识别 `\addbibresource`；`compileLocks` per-project 串行（:137） |
| 根 main.tex 组装 | `backend/src/manuscript/ManuscriptService.ts:139-172` `writeMainTex` | `\documentclass[UTF8]{ctexart}`、amsmath/amssymb/graphicx、有 bib 时 `\usepackage[numbers]{natbib}`、`\title{}`/`\author{}`/`\date{}`/`\maketitle`、`abstract` 环境（纯文本转义）、`\input{sections/<file>}`、`\bibliographystyle{unsrt}` + `\bibliography{references}` |
| Outline 模型 | `ManuscriptService.ts:27-56` | `Outline{title, abstract?, sections[]}`；`OutlineSection{id, file, title, targetLengthWords?, keyPoints?, synthesisRefs?, literatureRefs?, argument?}`；**无作者/导师/学科/学位/英文摘要/关键词字段** |
| 章节文件名 | `ManuscriptService.ts:68` `/^[a-z0-9][a-z0-9-]{0,63}\.tex$/` | 扁平 `sections/`；无章/节层级 |
| 章节写入 | `:175-183` `writeSection` | 原样 trim 落盘 |
| bib 渲染 | `:190-195` → `backend/src/citation/bibliography.ts:29` `DeterministicBibType = "article" | "inproceedings" | "misc"` | 条目类型只有三种；无 `language`/`lang` 字段（gb7714 样式用 `language = {chinese}` 等区分中英文著录，**未核实**现有渲染是否能被样式正确分组） |
| Writer 输出契约 | `backend/src/writer/WriterService.ts:2052`、`:2134`（「以 `\section{标题}` 开始；不要 `\documentclass`…」）；`:1560`、`:2134`（「可用宏包只有 amsmath / amssymb / natbib / graphicx（ctexart 文档类）」）；`:2198`（整文档模式 `\documentclass[UTF8]{ctexart}`） | 校验：`:485` 拒绝 `\documentclass`/`\begin{document}`；`:664`、`:727` abstract 段禁止 `\section`/`\begin{` |
| writeMainTex 调用点 | `backend/src/workflow/definitions.ts:2582, 3282, 5101, 5610, 8203`；`:9386-9389` 注释「有大纲时根 main.tex 是 writeMainTex 的确定性组装产物」 | 五处调用、同一签名 `(projectId, outline, withBibliography)` |
| 多文件收集 | `backend/src/manuscript/LatexFiles.ts:63-64, 111-114`（`\input`/`\include` BFS）、`:81-89`（`\bibliography`/`\addbibresource`）、`:144-147`（includegraphics） | 已支持 `\include` 与 biblatex 资源声明 |
| 图插入 | `backend/src/figures/insertion.ts:38-52` | `figure[htbp]` + `\includegraphics[width=0.85\textwidth]{figs/generated/<figId>.pdf}`；`:178-184` 在 `^\\documentclass` 行后补 graphicx |
| 导入 | `backend/src/import/LatexImporter.ts:157-166, 233-238` | 任意含 `\documentclass` 的 .tex 可做入口并复制为 main.tex——**已能导入现成学位论文工程**（但 bib 后端限制同上） |
| 超时 | `backend/src/config/config.ts:330, 382-383, 510-513`；`backend/src/index.ts:281`；`serviceStack.ts:346` | 默认 120 s，环境变量 `LATEX_COMPILE_TIMEOUT_MS`，上限 1800 s |
| PRD | `docs/PRD.md:286-291` | `documentType` 已有 `undergraduate_thesis / master_thesis / doctoral_thesis` 枚举 |
| 第三方契约 | `docs/DECISIONS.md` D-0025（L417）、D-0030 | 审计 seed + pin 完整 40 位 SHA + LICENSE 原件 + PROVENANCE.md + 不可变版本快照 + 更新需预览 diff |

### 5.2 四个问题的回答

**Q1 现有 LaTeX Compiler（xelatex + bibtex）能否直接编译 ctexbook 类学位论文模板？**
能，前提是模板走 bibtex+natbib（thuthesis / ustcthesis / sysu-thesis / fduthesis(bib-backend=bibtex)
/ ucasthesis(bibtex)）。探针 B 以与 `LatexCompiler` 完全相同的四步（xelatex → bibtex → xelatex ×2）
通过。需要注意：(a) `-halt-on-error` 下 thuthesis 探针无错误；(b) 冷启动超时（§4.3）；
(c) `XELATEX_ARGS` 硬编码 `main.tex`，模板工程入口必须叫 main.tex（导入已有 `LatexImporter.ts:233-238`
的改名逻辑）。

**Q2 biblatex/biber 模板是否需要新增 biber 编排？**
需要，且不止「多调一次 biber」：
1. 触发条件：pass1 后 `main.bcf` 存在（biblatex 必产）而非 `\bibdata{`；
2. 调用 `biber main`，解析 biber `.blg`（`ERROR`/`WARN` 行；找不到 `.bib` 时 biber 报错）；
3. Rerun 判定补 `Please \(re\)run Biber`（实测措辞 §4.1）；
4. **修正 `UNDEFINED_CITATION_PATTERN` 为同时接受反引号与直引号**（例如 ``/Citation [`'][^']+' on page \d+ undefined/``），
   否则 biblatex 文档的终检形同虚设；
5. `detectTool` 增加 biber 探测，`compile()` 只在确认需要时硬性要求（与现有 bibtex 的降级策略一致，
   `LatexCompiler.ts:145-156` 注释）；
6. biber 与 biblatex 版本耦合（biblatex 3.21 ↔ biber 2.21，本机匹配；日志形态
   `Package: biblatex 2025/07/10 v3.21`），不匹配时 biber 报 "control file version mismatch"——应
   作为结构化错误分类（类似 `kind: "font"`），而非只给 exitCode。

**Q3 多文件 `\include`、前言/正文/后记分区、长文档编译时长与 timeout？**
- `\include` 产生每章 `.aux`，`cleanTexProducts` 递归清理（:327-337）覆盖；`LatexFiles.ts` 已收集
  `\include`；diagnostics 的文件栈对 `(./chapters/x.tex` 形态有效。
- 三分区由适配器 emit 到根 main.tex，章节文件内不出现 `\frontmatter` 等命令——这是 Writer 输出
  校验要新增的禁用清单（`\frontmatter|\mainmatter|\backmatter|\appendix|\chapter` 在片段中禁止，
  由适配器统一产出）。
- 时长：探针 B 热态单轮 5 s、13 页；真实论文 80-150 页、四轮 xelatex + bibtex/biber 预计 1-3 min
  热态，冷态再加 2 min 级一次性开销。建议：thesis profile 默认 600 s；记录 `durationMs` 分步
  （目前 `compile.log` 已含每步，但 `LatexCompileResult` 只有总时长）。

**Q4 Writer 只产章节正文，如何与模板解耦？**
Writer 契约维持「以本单元顶级标题开始的片段」，不感知模板。差异只在标题层级：论文 `\section`
vs 学位论文 `\chapter`。推荐在 **渲染/staging 层做确定性标题提升**（`\section`→`\chapter`、
`\subsection`→`\section`、`\subsubsection`→`\subsection`、`\paragraph`→`\subsubsection`），且：
- 规范存储（`manuscript/sections/*.tex`）保持 section 根，Review / Revision / `latexHeadings.ts` /
  `visualInventory.ts` 等现有消费者零改动；
- 提升在 `stageBuildWorkspace` 复制后、xelatex 前对 build/ 内文件执行，**逐行 1:1 替换**，
  `diagnostics.ts` 的 `l.NNN` 行号仍可直接映射回 manuscript 文件；
- 替代方案（Writer prompt 加 `headingLevel` 参数直接写 `\chapter`）会让 Writer 契约依赖模板，
  且 `WriterService.ts:664/727` 等校验与 `latexHeadings.ts` 都要分叉，不推荐。
Writer 提示词中「可用宏包只有 amsmath/amssymb/natbib/graphicx（ctexart）」这一行应改为由
适配器的 `capabilities.packagesAvailableToWriter` 注入（thuthesis/ustcthesis 示例工程额外提供
threeparttable/longtable/algorithm/siunitx 等，但 generic 适配器可以继续保守）。

---

## 6. 通用 Thesis Document Model + 学校模板适配层（草案）

> 草案为 TypeScript 类型描述，未落地任何代码。

### 6.1 ThesisDocumentModel

```ts
/** 学位论文文档模型：唯一事实源；由 Outline + 项目元数据 + 用户填写 HITL 派生，模板只读它 */
export interface ThesisDocumentModel {
  schemaVersion: 1;
  documentType: "undergraduate_thesis" | "master_thesis" | "doctoral_thesis" | "postdoc_report"; // 对齐 PRD §5.4
  degreeKind: "academic" | "professional" | "engineering";   // 专业学位；ustcthesis 多一个 engineering
  language: "zh" | "en";                                      // 主语言（封面/标题语言）
  metadata: {
    title: { zh: string; en?: string };
    author: { zh: string; en?: string; studentId?: string };
    supervisors: Array<{ name: { zh: string; en?: string }; title?: string; role: "primary" | "associate" | "co" | "practice" }>;
    institution: { university: { zh: string; en?: string }; department: { zh: string; en?: string } };
    discipline: { zh: string; en?: string };                  // 一级/二级学科或专业
    degreeCategory?: { zh: string; en?: string };             // 如 工学硕士 / Master of Science
    researchDirection?: string;
    classification?: { clc?: string; udc?: string };          // 中图分类号 / UDC
    secrecy?: { level: string; years?: number };              // 密级
    dates: { submit?: string; defense?: string; confer?: string }; // ISO 日期
    blindReview: boolean;                                     // 盲审：隐去姓名/导师/成果细节
  };
  frontMatter: {
    abstract: { zh: string; en?: string };                    // 纯文本（经单一出口转义），不含 LaTeX 结构
    keywords: { zh: string[]; en?: string[] };
    notation?: Array<{ symbol: string; meaning: string }>;    // 符号表（可选）
    lists: { figures: boolean; tables: boolean; algorithms: boolean };
  };
  body: {
    chapters: Array<{
      id: string;                 // = OutlineSection.id
      title: string;              // 章标题（适配器 emit \chapter）
      file: string;               // sections/<file>.tex（规范存储：section 根片段）
      headingShift: 1;            // 片段 \section → \chapter 的提升量（generic/thesis 固定 1）
    }>;
  };
  backMatter: {
    bibliography: { enabled: boolean; file: "references.bib"; style: "gb7714-2015-numeric" | "gb7714-2015-author-year"; citeStyle: "numeric" | "super" | "author-year" };
    appendices: Array<{ id: string; title: string; file: string }>;
    acknowledgements?: string;                                // 纯文本/受限 LaTeX，用户填写
    achievements?: Array<{ category: string; items: string[] }>; // 攻读学位期间成果；盲审时适配器降级为匿名形态
    resume?: string;
    declarations: { originality: boolean; copyright: boolean; aiUsage?: { purpose: string } }; // ustcthesis 已有 AI 使用声明页
  };
}
```

与现有 `Outline`（`ManuscriptService.ts:52-56`）的关系：`Outline.title` → `metadata.title.zh`；
`Outline.abstract` → `frontMatter.abstract.zh`；`Outline.sections[]` → `body.chapters[]`。
**新增且现有系统不产出**的字段：英文题名/摘要/关键词、作者/导师/学科/学位、成果列表、致谢、
声明选项——建议通过 HITL 表单 + 可选 Writer 翻译任务（英文摘要）填充，不让 Writer 产出前后置
LaTeX。

### 6.2 TemplateAdapter 接口

```ts
export interface TemplateCapabilities {
  degrees: Array<ThesisDocumentModel["documentType"]>;        // 支持的学位类型
  degreeKinds: Array<ThesisDocumentModel["degreeKind"]>;
  languages: Array<"zh" | "en">;
  bibliography: { backends: Array<"bibtex" | "biblatex">; defaultBackend: "bibtex" | "biblatex"; styles: string[]; citeStyles: Array<"numeric" | "super" | "author-year"> };
  blindReview: boolean;
  builtInEnvironments: { abstractZh: string; abstractEn: string; acknowledgements?: string; achievements?: string; notation?: string }; // 名称映射
  packagesAvailableToWriter: string[];                        // 注入 Writer 提示词的宏包白名单
  figurePathConvention: "relative-to-root";                   // insertion.ts 的 figs/generated/<id>.pdf 不变
  knownLimitations: string[];                                 // 如「hustthesis 无本科」「厦门/第三语言摘要不支持」
}

export interface CompileRecipe {
  engine: "xelatex" | "lualatex";
  engineArgs: string[];                                       // 如 ["-interaction=nonstopmode","-halt-on-error"]；-shell-escape 默认关闭
  bibliographyStep: "bibtex" | "biber" | "none";
  passesAfterBib: 2;                                          // + Rerun 上限沿用 MAX_RERUN_ROUNDS
  timeoutMs: { cold: number; warm: number };                  // thesis 默认 cold ≥ 600_000
  entryFile: "main.tex";
}

export interface TemplateProvenance {                        // D-0025 / D-0030 契约
  distribution: "texmf-package" | "bundled";                 // CTAN 发行版安装 vs 项目内随附
  packageName?: string; minVersion?: string;                  // texmf：kpsewhich 探测 + 版本下限
  upstreamRepo?: string; pinnedCommitSha?: string; pinnedTag?: string; // bundled：完整 40 位 SHA
  license: { spdx: string; file: string };                    // LICENSE 原件路径
  provenanceFile: string;                                     // PROVENANCE.md
  modified: false;                                            // LPPL 下随附文件不得修改（修改需改名）
}

export interface TemplateAdapter {
  id: string;                                                 // "generic-ctexbook" | "thuthesis" | ...
  displayName: string;
  capabilities: TemplateCapabilities;
  provenance: TemplateProvenance;
  requiredFonts: { preferredFontset: "windows" | "mac" | "fandol" | "noto" | "auto"; fallbackFontset: "fandol"; detectOnHost(): Promise<"windows" | "fandol" | "noto" | "unknown"> };
  /** 结构化校验：模型缺哪些模板必填项（如 thuthesis 要 degree-category）；fail-closed，不猜默认 */
  validate(model: ThesisDocumentModel): { ok: boolean; missing: string[]; warnings: string[] };
  /** 确定性 emit：根 main.tex（含 documentclass、setup 块、前置、\chapter+\input、后置）；字节稳定 */
  emitMain(model: ThesisDocumentModel, ctx: { withBibliography: boolean }): string;
  /** 可选附属文件（如 thusetup.tex 分离、bibliography 资源声明）；路径均相对 manuscript/ */
  emitAuxiliaryFiles(model: ThesisDocumentModel): Array<{ relativePath: string; content: string }>;
  /** 章节片段 → 模板章节：标题提升 + 禁用命令扫描；逐行 1:1，供 staging 层调用 */
  transformChapterFragment(fragment: string, chapter: ThesisDocumentModel["body"]["chapters"][number]): { content: string; violations: string[] };
  /** 参考文献策略：决定 ManuscriptService.writeBibliography 的渲染增强（如 gb7714 需 language 字段） */
  bibliographyPolicy(): { backend: "bibtex" | "biblatex"; styleDirective: string; requiresLanguageField: boolean };
  compileRecipe(): CompileRecipe;
}
```

### 6.3 `generic-ctexbook` 默认适配器与学校适配器共存

- **generic-ctexbook**：`\documentclass[UTF8,zihao=-4,fontset=<detected>]{ctexbook}`；封面由
  `\title/\author/\date` + 自绘 `titlepage`（仅列模型字段，不模仿任何高校版式）；abstract 用自定义
  `\chapter*{摘要}` + `\addcontentsline`；参考文献默认 **bibtex + `gbt7714-numerical.bst`**（与现有编译器
  零改动兼容，本机已装），可切 biblatex gb7714-2015（依赖 §5.2 Q2 的 biber 编排）；定理环境
  amsthm 自定义。它是「用户学校未指定」时的默认，也是 Build Gate / Review 回归的基准形态。
- **学校适配器**：实现同一接口，`provenance.distribution` 决定安装方式：CTAN 已收录（thuthesis、
  njuthesis、sjtutex、hustthesis、fduthesis、sysuthesis、pkuthss）→ `texmf-package`，启动时
  `kpsewhich <cls>` 探测，缺失时提示 MiKTeX 自动装包或 `tlmgr install`，**不随附**；未收录
  （ustcthesis、zjuthesis、ucasthesis）→ `bundled`，置于 `backend/templates/seed/<id>/` 原样文件 +
  LICENSE + PROVENANCE.md（pin tag + 40 位 SHA），复制进 manuscript/ 或 build/ 时不改一字。
- **选择与切换**：项目级 `templateId`（默认 generic-ctexbook）；切换模板 = 重新 `emitMain`，
  `sections/*.tex` 与 `references.bib` 不变（这正是解耦收益）；切换后旧 build-gate 记录按既有
  revision 新鲜度规则失效。
- **registry**：代码内常量注册表（对齐 D-0030「路由由代码内控常量决定」），不开放任意 URL 安装模板。

### 6.4 与 Writer / Workflow 解耦

- Writer：契约不变（section 根片段 + `\cite{key}` + 宏包白名单）。唯一新增：禁用命令清单
  （`\chapter|\frontmatter|\mainmatter|\backmatter|\appendix|\maketitle|\tableofcontents|\printbibliography|\bibliography`）
  进入 `WriterService.ts:485` 同级校验；白名单改为从适配器 `capabilities.packagesAvailableToWriter` 注入。
- Workflow：`definitions.ts` 五处 `writeMainTex(projectId, outline, withBib)` 调用改为经
  `ManuscriptService.writeMainTex` 内部委派 `adapter.emitMain(model)`——签名可保持，模型由
  `outline + project.thesisMetadata` 组装；Workflow 不感知模板。
- Build：`stageBuildWorkspace` 后插入 `adapter.transformChapterFragment` 渲染步骤（仅 build/）；
  `LatexCompiler` 增 `recipe` 参数（引擎/bib 步/超时），默认值等于现状。
- Review/Revision/Citation：读规范存储，无感知。Figure insertion 路径约定不变。

### 6.5 许可证纳入方式

- 原则：**不 vendoring 修改**；CTAN 包走发行版；非 CTAN 包按 D-0025/D-0030 原样随附 + pin + LICENSE
  + PROVENANCE。LPPL-1.3c 允许原样分发；修改则必须改名（故适配器所有定制都放在 PaperTeam 生成的
  main.tex/导言区，而不是改 .cls）。
- GPL-3（ucasthesis；sysu-thesis 仓库级）：对编译用户论文无影响，但随附进 PaperTeam 分发包会引入
  GPL 文件；**不随附** ucasthesis；sysuthesis 以 CTAN（cls 头 LPPL）版本依赖，并把「LICENSE 与 cls
  头不一致」记入 PROVENANCE 风险项。
- 模板随附的 `.bst/.bbx/.cbx`（ustcthesis 根目录）同属 LPPL，一并原样随附。
- 更新：bundled 模板更新 = 新 SHA + diff 预览（对齐 D-0030「update available 需预览 diff 后应用」）；
  texmf 模板更新由用户发行版负责，PaperTeam 只记录编译时 `Document Class: … <date> <version>` 日志行
  到 build-gate 记录（探针 B 日志已含该行）。

---

## 7. 维护成本与风险

| 风险 | 证据 | 缓解 |
|---|---|---|
| 模板更新改变接口 | thuthesis 2026-06 曾「Deprecate survey and translation environments」后 Revert（#1069）；sysu 2026-09 参考文献格式更新 #142；SJTUThesis `fontset` 弃用改 `cjk-font`（cls:173） | 适配器声明 `minVersion`/`testedVersions`；编译日志抓 `Document Class:` 版本行；每适配器一份本机 golden 探针 |
| MiKTeX 自动装包 | 本机已装 7/10；缺的三者不在 CTAN；`MIKTEX_ENABLE_INSTALLER` 需开启；自动装包会显著拉长首次编译 | 启动期 `kpsewhich` 预检并给出一键安装提示；bundled 模板绕过装包 |
| 冷启动超时 | 探针 B 133 s vs 默认 120 s | thesis recipe `timeoutMs.cold ≥ 600 s`；首次成功后记录 warm 基线 |
| 字体缺失 | 所有模板 Windows 字体集依赖中易宋黑仿楷；Linux 需 Fandol/Noto；diagnostics 已分类 | 适配器 `detectOnHost` 显式传 `fontset=`，不依赖类的 auto 探测；Docker 镜像内置 Fandol/Noto（diagnostics.ts:44-47 已声明） |
| biber/biblatex 版本不匹配 | 二者强耦合；本机 3.21/2.21 匹配 | 结构化识别 "control file version" 错误；`detectTool` 报告 biber 版本 |
| 终检漏判 | `UNDEFINED_CITATION_PATTERN` 直/反引号差异（§4.1） | 修正正则并加 biblatex 回归用例 |
| gb7714 中英文著录分组 | gb7714 样式按 `language` 字段区分；现有 `bibliography.ts` 无该字段（未核实样式在缺字段时的行为） | 适配器 `bibliographyPolicy.requiresLanguageField` 驱动渲染增强 |
| 许可证不一致 | sysu-thesis GPL-3 vs LPPL；ucasthesis GPL-3 | 见 §6.5 |
| 非 CTAN 模板停更 | zjuthesis release 2023、ucasthesis 2018 | 不列入第一批 |
| `-shell-escape` | thuthesis/hustthesis latexmkrc 默认开启；PaperTeam 当前不开 | 探针 B 不开也能编译；适配器 recipe 默认关闭，按需显式声明 |
| `\thusetup` 不能有空行 | thusetup.tex 注释 | emitMain 产出时去空行并做单测 |

---

## 8. 推荐技术路线（含不推荐）

1. **M14.1 基础**：`ThesisDocumentModel` + `TemplateAdapter` 接口 + `generic-ctexbook` 适配器
   （bibtex + gbt7714-numerical 默认）；`writeMainTex` 委派；staging 层标题提升；Writer 禁用清单；
   thesis compile recipe（冷启动预算）；`UNDEFINED_CITATION_PATTERN` 修正（即便暂不接 biblatex 也应修）。
2. **M14.2 biber 编排**：`.bcf` 触发 → `biber main` → biber `.blg` 守卫 → Rerun 措辞补充 → `detectTool`
   增 biber；generic 适配器开放 biblatex gb7714-2015 选项。
3. **M14.3 第一批学校适配器**（均作为可选、非标准）：
   - `thuthesis`（texmf，LPPL，bibtex 默认；本机探针已过）；
   - `ustcthesis`（bundled v5.0.2，LPPL，接口最完整，含 AI 使用声明页）与 `sysuthesis`（texmf，同构；
     注意 CTAN 版本滞后与许可证不一致）；
   - `njuthesis`（texmf，biblatex-only，验证 biber 路线）。
4. **第二批观察**：`sjtutex`（CTAN，双语键形态）、`fduthesis`（CTAN，但停滞）、`pkuthss`（停滞，经典 2e）。
5. **不推荐**：
   - `zjuthesis`：`ctexrep` + 元数据全在 documentclass 选项 + 固定目录宏驱动 + latexmk 强绑定，与
     文件模型冲突最大，且 release 停在 2023；
   - `ucasthesis`：GPL-3、2021 后无提交、无环境抽象、自带 .bst 副本；
   - 任何「fork 并修改 .cls 以适配 PaperTeam」的做法（LPPL 改名义务 + 维护负担）。
6. **不做**：把某一高校格式设为 PaperTeam 默认/统一标准；开放任意 URL 安装模板；让 Writer 产出
   前置/后置 LaTeX。

---

## 9. 未核实项清单

1. pkuthss 的 CTAN JSON 元数据（请求报错）；其编译引擎声明、`ctex-fontset-pkuthss.def` 内容、示例 Makefile。
2. ustcthesis.cls L317 `\LoadClass` 的基类名（跨行未展开）；`\addbibresource` 与 natbib 并存的类内处理。
3. sjtutex 本身的 CTAN JSON（只查了 sjtuthesis 名）。
4. zjuthesis 的字体声明（`config/format/format.tex`、`config/path.tex`）与摘要环境形态——代理关闭后读取失败。
5. NJUThesis 的 `\njusetup[bib]` 样式键取值、`secnumdepth/tocdepth` 显式设置、公式编号方式。
6. hustthesis 在 MiKTeX 25.12（非 TeX Live 2026）上能否编译（未探针）；成果列表环境。
7. fduthesis 的默认 `bib-backend`、声明页命令、前后置分区命令。
8. ucasthesis `Tex/Frontinfo.tex` 元数据键名。
9. 各模板公式编号具体格式（按章几乎是 ctexbook 默认，但未逐一展开 `\theequation`）。
10. thuthesis 探针冷启动 133 s 的成因（字体缓存 / 包数据库 / 数学字体）。
11. 现有 `bibliography.ts` 渲染的条目在 gb7714 样式下中英文分组的实际表现（无 `language` 字段）。
12. sysu-thesis 仓库 GPL-3 LICENSE 与 cls 文件头 LPPL 的权威口径（需向上游确认）。
13. biber 「control file version mismatch」错误的确切日志措辞（本机版本匹配，未触发）。

---

## 10. 参考链接（仅公开 URL）

- https://github.com/tuna/thuthesis · https://ctan.org/pkg/thuthesis
- https://github.com/nju-lug/NJUThesis · https://ctan.org/pkg/njuthesis · http://mirrors.ctan.org/macros/unicodetex/latex/njuthesis/njuthesis.pdf
- https://github.com/CasperVector/pkuthss · https://gitea.com/CasperVector/pkuthss
- https://github.com/ustctug/ustcthesis
- https://github.com/sjtug/SJTUThesis · https://github.com/sjtug/SJTUTeX · https://www.ctan.org/pkg/sjtutex
- https://github.com/TheNetAdmin/zjuthesis · https://thenetadmin.github.io/zjuthesis
- https://github.com/mohuangrui/ucasthesis
- https://github.com/hust-latex/hustthesis · https://www.ctan.org/pkg/hustthesis
- https://github.com/SYSU-SCC/sysu-thesis · https://ctan.org/pkg/sysuthesis
- https://github.com/stone-zeng/fduthesis · https://www.ctan.org/pkg/fduthesis
- https://ctan.org/pkg/biblatex-gb7714-2015 · https://ctan.org/pkg/gbt7714 · https://ctan.org/pkg/ctex
- https://www.latex-project.org/lppl/lppl-1-3c/
- 探针与下载的模板源码副本：`D:\PaperTeamData\AcademicFigureSkillEvaluation\scratch-templates\{src,probe-ctexbook-biblatex,probe-thuthesis}`（仓库外，非产品资产）
