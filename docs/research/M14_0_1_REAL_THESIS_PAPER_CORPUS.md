# M14.0.1 — Real Thesis–Paper Corpus（真实学位论文—小论文语料报告）

> 日期：2026-10-14（UTC 04:57–07:30）。执行：Claude Code 主会话 + 10 个子代理会话（3 个发现代理、7 个逐案例分析代理）。基线：`main @ 1f983ff`（Pre-M14 研究已入库）。
> 性质：**只读研究**。未改任何产品代码、未安装 Skill、未建分支。原始 PDF、解析文本、映射 JSON 与日志保存在 `D:\PaperTeamData\M14_0_1_RealThesisPaperStudy\`（不入库）。本报告只引用可公开核验的元数据、链接、页码与短引文。
> 配套报告：[映射分析](M14_0_1_THESIS_PAPER_MAPPING_ANALYSIS.md) · [工作流决策](M14_0_1_EVIDENCE_BASED_WORKFLOW_DECISIONS.md) · [Skill 可行性](M14_0_1_THESIS_SKILL_FEASIBILITY.md)。

## 0. 结论摘要

| 项 | 结果 |
| --- | --- |
| 候选学位论文记录 | **32 条**（30 篇全文已下载并读取 + 2 条仅元数据的中科院软件所示例）。预算上限 30 篇全文，未超出。 |
| 进入核验的候选 | **15 组**（预算上限 15） |
| 正式全文映射样本（内地高校） | **9 组**：博士 6（范登平/南开、白烨/中科院自动化所、刘磊/中科院计算所、张蒙/北理工、来斯惟/中科院自动化所、邓栋/清华）；硕士 3（宋品皓/北大深研院、李谨杰/北航、Sanyal/重庆邮电大学·国际学生）。中国学生 8 组。 |
| 控制样本（港澳） | 1 组：Li Qimai / 香港理工大学 博士 2023（英文论文，逐字复用可直接度量） |
| 反例 / 受限候选 | 6 组：吴建军（USTC 硕士，核心章无已发表论文）、郑烨（深大硕士，开放期刊 PDF 对脚本屏蔽）、晏小辉（公开副本缺成果附录）、郑家麒（同济硕士，唯一论文不可核验）、Sahoo（重邮硕士，仅摘要级匹配）、陈波（PDF 字体 CMap 损坏） |
| 深度研究 | 3 组深度（范登平、白烨、李谨杰）+ 7 组中等深度 |
| 覆盖的关系类型 | A 单篇成果型（李谨杰；以及多篇论文内部的「一篇 → 一章」单元）、B 多篇整合型（9 组）、C 差异/冲突型（在 7 组中实际观察到数值/版本冲突） |
| 硕士目标（≥4） | **未达成**：中国学生硕士正式样本 2 组（宋品皓、李谨杰）+ 1 组国际学生（Sanyal）。原因见 §6 可得性缺陷。 |
| 最终状态 | **PARTIAL**（见 §7） |

## 1. 研究协议

### 1.1 来源与访问规则

- 只使用合法开放全文：arXiv、作者本人控制的主页/GitHub Pages、高校自有开放机构库、开放获取出版商页面（CVF、AAAI OJS、ACL Anthology、PMLR、Zenodo）。
- CNKI/万方只允许作线索；本轮实际未访问。任何登录页、验证码、JS 反爬守卫、WAF 挑战均**不绕过**，记为访问受限。
- 下载即计算 sha256 与页数（PyMuPDF），记录 UTC 访问时间；全部记录见 `sources/candidates_*.json` 与 `sources/candidate_index.json`。

### 1.2 身份与关系等级

- 身份：`VERIFIED` / `PROBABLE` / `UNVERIFIED` / `REJECTED`。`VERIFIED` 要求：学位论文题名页（作者、导师、学校、年份）+ 论文内「在学期间成果」列表或等价自述 + 小论文第一页作者/机构/合作者与之一致 + 至少一条独立交叉证据（同一作者站点托管、邮箱、基金号、致谢名单等）。
- 关系：`DIRECT_STATEMENT` / `VERIFIED_CONTENT_MATCH` / `METADATA_ONLY` / `INFERENCE` / `UNVERIFIED`。`VERIFIED_CONTENT_MATCH` 要求可定位到页码的公式、表格数值、实验协议或正文片段对应。
- 工具：`tools/thesis_tools.py`（PyMuPDF 逐页抽取；英—英用 7 词 shingle 重叠；中—英用「≥3 字符小数 token」逐页共现（`numoverlap`），因为中文学位论文是英文论文的翻译，词面重叠为零）。所有自动结果都经人工复核页面文本。

### 1.3 正式入选标准

学位论文真实且身份 `VERIFIED`；至少一篇关联小论文真实且作者身份 `VERIFIED`；两者相关正文均已合法读取；存在 `DIRECT_STATEMENT` 或 `VERIFIED_CONTENT_MATCH`；至少记录一项成果对应关系。仅有元数据/摘要/弱关联的候选只进入候选目录。

## 2. 候选发现过程

三条并行渠道（各自日志：`logs/discovery_authorpages.md`、`logs/discovery_arxiv.md`、`logs/discovery_repositories.md`）：

| 渠道 | 方法 | 产出 | 关键事实 |
| --- | --- | --- | --- |
| 作者自建主页 / GitHub Pages | GitHub 代码搜索（`gh api search/code`）+ 主页抓取；WebSearch 对本模型不可用（API 400），Bing/Google/百度对脚本降级 | 12 篇中文学位论文（8 篇含成果附录） | 全部由作者本人站点托管（用户名/主页与作者一致）；样本偏向有 `*.github.io` 主页的人 |
| arXiv | arXiv API `co:` 字段检索 "PhD thesis / dissertation / Master thesis"，逐篇题名页筛国内高校 | 12 篇（约 2,300 条 thesis 标记记录中，内地学位仅约十余篇；40 篇抽检题名页 38 篇为海外学位） | 需走本机 7890 代理（直连约 50 KB/s）；1 篇（2211.02650）字体损坏被拒 |
| 机构知识库 | 探测约 60 个 `ir.*.ac.cn` / `ir.*.edu.cn` 主机 + 港校 | 内地 **0** 篇开放全文；香港理工大学 6 篇（经 OAI-PMH 发现，HTML 界面对脚本有验证码） | 中科院软件所、北师大机构库可见题录但下载跳转登录；厦大/清华机构库整站 SSO；中科院自动化所/计算所/沈阳自动化所主机不可达；HKUST 验证码循环、HKU/CUHK WAF 挑战 |

**可得性结论（OBSERVED）**：内地高校学位论文的合法开放全文，在本机环境下**几乎只能通过作者自我存档**（个人主页、GitHub、arXiv）获得；没有任何一个内地机构库向匿名脚本提供全文。开放获取期刊（软件学报、IJSI、IEEE Access、ACM TACO）对脚本客户端返回 JS 守卫/418/403，是「开放 ≠ 机器可得」的实证。

## 3. 正式样本（9 组内地 + 1 组控制）

页码为 PDF 页索引（自 1 起）。sha256 取前 12 位，完整值见 `mappings/case_*.json`。

### 3.1 范登平 — 南开大学 工学博士 2019（深度案例）

- 学位论文：《认知规律启发的显著性物体检测方法与评测》，导师 刘晓光、程明明，软件工程/计算机视觉，二〇一九年五月（p1）；124 页；sha256 `a885d95a1071`。来源：作者主页 <https://dengpingfan.github.io/pages/Publication.html>（PDF 链接见 `mappings/case_fan_dengping_nankai_phd2019.json`）。全文已读。
- 身份 `VERIFIED`：题名页 + p122–124「在学期间的学术论文与研究成果」（6 篇已发表、4 篇投稿、3 项专利）+ 四篇小论文首页作者 Deng-Ping Fan / Ming-Ming Cheng（南开）+ 同一作者站点托管。
- 关联小论文（均开放全文）：
  1. Structure-measure, ICCV 2017 — arXiv [1708.00786](https://arxiv.org/abs/1708.00786)
  2. Salient Objects in Clutter (SOC), ECCV 2018 — arXiv [1803.06091](https://arxiv.org/abs/1803.06091)
  3. Enhanced-alignment Measure, IJCAI 2018 — arXiv [1805.10421](https://arxiv.org/abs/1805.10421)
  4. Shifting More Attention to Video Salient Object Detection, CVPR 2019 — [CVF 开放版](https://openaccess.thecvf.com/content_CVPR_2019/papers/Fan_Shifting_More_Attention_to_Video_Salient_Object_Detection_CVPR_2019_paper.pdf)
- 关系：四篇均 `VERIFIED_CONTENT_MATCH`（表 5.1 ↔ ICCV Table 1 51/52 小数相同；表 6.1 ↔ IJCAI 主表 60/63；表 4.2 ↔ CVPR Table 4 17/18；表 3.2 ↔ SOC 11/14 其余为节号）。

### 3.2 白烨 — 中国科学院自动化研究所 / 中国科学院大学 工学博士 2021（深度案例）

- 《基于语言知识迁移的端到端语音识别方法研究》，导师 陶建华，模式识别与智能系统，2021-06；134 页；sha256 `da2a2199328b`；作者主页托管（见 JSON）。全文已读。
- 身份 `VERIFIED`：p127–129 作者简历与 10 篇第一作者论文（含 DOI）；论文首页 Ye Bai @ NLPR-CASIA，合作者 易江燕/陶建华/温正棋/田正坤/张帅 与致谢 p131–132 一致；基金号 173211KYSB20190049 同时出现在简历与论文中。
- 关联小论文（arXiv 作者稿）：Interspeech 2019 LST [1907.06017](https://arxiv.org/abs/1907.06017)（DOI 10.21437/Interspeech.2019-1554）；TASLP 2021a [1912.01777](https://arxiv.org/abs/1912.01777)（10.1109/TASLP.2021.3066274）；Interspeech 2020 LASO [2005.04862](https://arxiv.org/abs/2005.04862)（10.21437/Interspeech.2020-1600）；TASLP 2021b [2102.07594](https://arxiv.org/abs/2102.07594)（10.1109/TASLP.2021.3082299）。
- 关系：`DIRECT_STATEMENT`（图 1.3 p26 把第 3/4/5 章分别标注为 "Interspeech 19"、"IEEE TASLP 21a"、"Interspeech 20, IEEE TASLP 21b"）+ `VERIFIED_CONTENT_MATCH`（TASLP 21a 全部 13 张表 ↔ 表 3.1–3.10/4.1–4.5 数值相同；TASLP 21b Table III ↔ 表 5.3 p92 逐行相同）。

### 3.3 刘磊 — 中国科学院计算技术研究所 工学博士 2014

- 《多核系统内存资源管理优化技术的研究》，导师 吴承勇、冯晓兵，计算机系统结构，2014-05；119 页；sha256 `5abc70b60ff7`；来源 <https://liulei-sys-inventor.github.io/>。全文已读。
- 身份 `VERIFIED`：p119 作者简介列 ISCA-2014 / TACO-2014 / PACT-2012 第一作者；三篇作者副本同站托管，首页署名 Lei Liu, SKL Computer Architecture, ICT, CAS，合作者 Zehan Cui / Chengyong Wu（导师）。
- 关联小论文（作者副本，页眉标注 "Revised 2016-01-01"，即论文发表后的修订稿）：PACT 2012（DOI 10.1145/2370816.2370869）；ACM TACO 2014（10.1145/2579672）；ISCA 2014（10.1109/ISCA.2014.6853214）。
- 关系：`VERIFIED_CONTENT_MATCH`（第三章 p51 与 PACT/TACO 共享 99.22%/5.7% 等 workload-11 分析数值；第四章 p80/82 与 ISCA 共享关联规则 support/confidence 37.1%/94.4%、34.3%/83.3%、23.8%/87.9%、39.5%/87.2%/90.5%；第五章 TOC 与 ISCA §4–6 HVR/决策树/buddy 系统一一对应）。

### 3.4 张蒙 — 北京理工大学 工学博士 2019

- 《不确定系统的数据驱动自适应优化控制研究》，导师 甘明刚，控制科学与工程，答辩 2019-06（p2）；141 页；sha256 `1a519b3ad09b`；来源 <https://xavipotter.github.io/>。全文已读。
- 身份 `VERIFIED`：p138 发表论文清单 7 篇；四篇作者副本同站托管，署名 Meng Zhang & Ming-Gang Gan, School of Automation, BIT。
- 关联小论文：IEEE Access 2019（10.1109/ACCESS.2019.2891575，金色 OA；IEEE Xplore 对脚本返回 418，读取作者副本）；JFI 2019（10.1016/j.jfranklin.2019.05.020）；Neurocomputing 2020（10.1016/j.neucom.2019.12.001）；ASCC 2017。
- 关系：Access ↔ 第三章 `VERIFIED_CONTENT_MATCH`（p57 共享 0.2134/2.139/6.402/6.508；PSO + 二自由度直升机）；JFI ↔ 第四章（直流力矩电机伺服、跳变动态，结构匹配）；Neurocomputing ↔ 第六章（p117 共享 0.025/0.05/0.075；中枢神经系统手臂运动实例）；ASCC ↔ 第三章 §3.3 `INFERENCE`。**第五章无任何已发表论文对应。**

### 3.5 来斯惟 — 中国科学院自动化研究所 工学博士 2016（arXiv 托管中文论文）

- 《基于神经网络的词和文档语义向量表示方法研究》（arXiv 题 "Word and Document Embeddings based on Neural Network Approaches"），导师 赵军，模式识别与智能系统，2016-01；143 页；arXiv [1611.05962](https://arxiv.org/abs/1611.05962)；sha256 `4f5697fdd7f6`。全文已读。
- 身份 `VERIFIED`：PDF p139 发表文章目录 6 条；p141 简历邮箱 swlai@nlpr.ia.ac.cn 与两篇第一作者论文作者块邮箱一致。
- 关联小论文：AAAI 2015 "Recurrent Convolutional Neural Networks for Text Classification"（AAAI OJS 开放版）；arXiv [1507.05523](https://arxiv.org/abs/1507.05523) "How to Generate a Good Word Embedding"（IEEE Intelligent Systems 2016 正式版闭源，`METADATA_ONLY`）。
- 关系：均 `VERIFIED_CONTENT_MATCH`（AAAI 式 (1)–(10) = 式 (5.9)–(5.17)，Table 1 = 表 5-2，Table 2 拆为表 5-3…5-6 数值相同；arXiv 论文 Tables 1,3–10 ↔ 表 3-1…3-10 逐位相同）。

### 3.6 邓栋 — 清华大学 博士 2016（arXiv 托管中文论文）

- 《Error-Tolerant Big Data Processing》（中文正文；题名页 p1 英文 / p2 中文：计算机科学与技术系，导师 李国良，二〇一六年六月）；152 页；arXiv [1712.06223](https://arxiv.org/abs/1712.06223)；sha256 `9019712e1aff`。全文已读；**arXiv 版缺简历/成果附录、致谢与声明页**。
- 身份 `VERIFIED`：四篇已读论文均署 Dong Deng + Guoliang Li（清华），学生邮箱 dd11@mails.tsinghua.edu.cn；自引 [60]–[69] 在 §1.2 p17–18 列出 11 篇本人论文。
- 关联小论文（4 篇全文；PVLDB 为开放，SIGMOD 读作者组主页副本）：Faerie SIGMOD 2011；Pass-Join PVLDB 2012；Set-join PVLDB 2016；Pivotal SIGMOD 2014。另 7 篇 `METADATA_ONLY`/`PROBABLE`。
- 关系：四篇均 `VERIFIED_CONTENT_MATCH`（表 2.4 = Faerie Table 4 逐位；表 3.1–3.3 与 2500/700/15,000/5000/130 s 等数值 = Pass-Join；表 4.1–4.3 = Set-join；表 5.1–5.4 与 215/256/671/82 ms = Pivotal；7 词 shingle 重叠的页区 21–47 / 52–84 / 91–114 / 120–144 与章节边界吻合）。

### 3.7 宋品皓 — 北京大学深圳研究生院 硕士 2022（arXiv 托管中文论文）

- 《基于域泛化的水下机器人目标鲁棒检测》（arXiv 题 "Robust Object Detection of Underwater Robot based on Domain Generalization"），导师 刘宏，计算机应用技术，2022-06；103 页；arXiv [2503.19929](https://arxiv.org/abs/2503.19929)（2025 年上传）；sha256 `b6841724a4e6`。全文已读。
- 身份 `VERIFIED`：p100 成果列表（ICIP 2020、AAAI 2022、2 项专利）；两篇论文署北大深圳 Key Lab of Machine Perception + Hong Liu；arXiv 记录提交人 Pinhao Song。
- 关联小论文：ICIP 2020 — arXiv [2004.06333](https://arxiv.org/abs/2004.06333)（`VERIFIED_CONTENT_MATCH`，表 3.1 p61 = Table 1 111/111 小数相同）；AAAI 2022（第三作者，开放版）`METADATA_ONLY`（正文零对应）。**未列入成果却构成第二、四章的两篇预印本**：Boosting R-CNN arXiv [2206.13728](https://arxiv.org/abs/2206.13728)（答辩后 22 天上传；表 2.2 p50 155/160 相同）、DMC arXiv [2104.02230](https://arxiv.org/abs/2104.02230)（表 4.1 p81 108/110）。
- 说明：这是「硕士学位论文大部分建立在尚未发表的研究上」的直接证据（≈44 页核心章来自答辩时未发表的预印本）。

### 3.8 李谨杰 — 北京航空航天大学 硕士 2023（深度案例）

- 《基于模型预测的无人机密集编队跟踪控制算法研究》，导师 任章，导航、制导与控制，论文编号 10006SY2003533（2023）；123 页；sha256 `683671411cc2`；来源 <https://li-jinjie.github.io/>（作者简介 p123 给出同一主页 jinjie.li）。全文已读。
- 身份 `VERIFIED`：p120 成果 4 篇；两篇 arXiv 论文首页署 Jinjie Li, Liang Han, Zhang Ren（北航）。
- 关联小论文：CDC 2023（答辩时为 "Submitted"）arXiv [2304.07794](https://arxiv.org/abs/2304.07794)（Crossref DOI 10.1109/CDC49753.2023.10383632）— `VERIFIED_CONTENT_MATCH`（p53 四旋翼参数 0.0094/0.0134/0.0145/1.5344/3.7611 相同；p98「RMSE 降低了 75.37%」= 论文摘要 "75.37% reduction"；ACADOS/热启动/RTI；谱归一化推导）；ICRA 2022 arXiv [2203.00356](https://arxiv.org/abs/2203.00356) `METADATA_ONLY`（正文无对应，属范围排除）；ICRA 2023（第四作者）`METADATA_ONLY`。

### 3.9 Sunny Sanyal — 重庆邮电大学 硕士 2019（国际学生，英文论文）

- "Data Aggregation Techniques for Internet of Things"，99 页；arXiv [1907.11367](https://arxiv.org/abs/1907.11367)；sha256 `7681164efe1a`。全文已读。身份 `VERIFIED`（题名页 + p98 成果与 CSC 奖学金 + ICC 论文首页 Sanyal/Wu @ CQUPT）。
- 关联小论文：ICC 2019 "Federated Filtering" arXiv [1905.01138](https://arxiv.org/abs/1905.01138) — `VERIFIED_CONTENT_MATCH`（第 4 章 p73–88，16 页 ≥15% shingle 重叠，论文正文 39% 被复用；式 15 → 式 4.15；图 3–5 → 图 4.3–4.6）；IEEE Access 2018（金色 OA 但 Xplore 反爬）与 EAI MobiMedia 2017（Cloudflare 403）仅摘要级/`INFERENCE`。

### 3.10 控制样本：Li Qimai — 香港理工大学 计算学系 博士 2023

- "Learning on graphs with graph convolution"，导师 Xiao-Ming Wu，214 页；PolyU Electronic Theses 开放条目（OAI-PMH 发现，比特流 `200 application/pdf`）；sha256 `b542a87a8b8a`。全文已读。身份 `VERIFIED`。
- 关联小论文（arXiv）：AAAI 2018 [1801.07606](https://arxiv.org/abs/1801.07606)；CVPR 2019 [1901.09993](https://arxiv.org/abs/1901.09993)（v1 与 v3 为两个不同的稿本）；IJCAI 2019 [1906.01210](https://arxiv.org/abs/1906.01210)；KDD 2021 [1909.12038](https://arxiv.org/abs/1909.12038)。
- 关系：均 `VERIFIED_CONTENT_MATCH`；正文 172 页中 **23% 的 7-gram 逐字出现在论文中**（79 页 ≥15%、23 页 ≥50%）。用途：对照中文论文的「翻译式继承」。

## 4. 反例与受限候选（已读学位论文全文，但不计入正式样本）

| 候选 | 事实 | 等级 | 教训 |
| --- | --- | --- | --- |
| 吴建军，中国科学技术大学 硕士 2014《基于用户物品成对分块的协同过滤算法》（导师 唐珂；sha `3393f289aa88`；作者站点托管） | 唯一已发表论文 CloudCom-Asia 2013（DOI 10.1109/CloudCom-Asia.2013.88，闭源）在正文仅作为 [50] 在总结与展望 p64 被引一次；核心第 3–4 章无对应论文 | 身份 `VERIFIED`；关系 `METADATA_ONLY`，**无章节对应** | §5.5 场景 1 实证：学位论文核心可以完全没有已发表小论文 |
| 郑烨，深圳大学 电子信息硕士 2023《多路径方法在神经网络验证中的研究与应用》（导师 刘嘉祥；sha `01949d1173f1`） | p64 列软件学报 2022 33(7)（DOI 10.13328/j.cnki.jos.006585）、IJSI 译文（10.21655/ijsi.1673-7288.00281）、ESEC/FSE 2022 MpBP（10.1145/3540250.3558924）。软件学报与 IJSI 的 PDF 端点对脚本返回 JS 守卫；ACM 403；Zenodo 制品 7029261 两次 403 | 身份 `VERIFIED`；关系 `INFERENCE`（第 3 章 ↔ 方法论文，第 4 章 ↔ 工具论文） | 最佳的中文「单篇成果型」候选，被「开放获取但不可脚本访问」阻断 |
| 晏小辉，中科院计算所 博士 2014《短文本话题建模》（导师 程学旗） | 公开副本删去成果附录；正文 p7/p9 描述 BTM/在线 BTM/CBTM | 身份 `PROBABLE`；关系 `INFERENCE` | 没有成果列表时，论文自身无法支撑身份与关系核验 |
| 郑家麒，同济大学 硕士 2017（探地雷达，arXiv [1812.07495](https://arxiv.org/abs/1812.07495)） | 唯一论文《交通科技》2017(02) 无 Crossref/arXiv 记录；第 3–4 章（46% 页数）无发表对应 | 身份 `VERIFIED`；论文存在性 `UNVERIFIED` | 其他学科对照：论文优先的学位论文 |
| Subhadeep Sahoo，重庆邮电大学 硕士 2020（arXiv [2008.07255](https://arxiv.org/abs/2008.07255)） | 三篇论文均闭源；第 2/3 章概述与论文摘要 61–83% 覆盖；第 4 章无结果（"will be published in later version" p74）；作者非任何论文第一作者 | 身份 `VERIFIED`；关系仅摘要级 | 摘要级匹配不足以进入正式样本；成果列表中的 TSP 条目的题名/作者与正式版不一致 |
| 陈波，中科院软件所 博士 2018 | PDF 中文 CMap 损坏，文本层不可读；未 OCR | 未核验 | 自动解析失败必须显式标注，而不是当作事实 |

未进一步核验（预算）：陈帅飞（北交大 2023）、林铮（南开 2023，公开副本截断于个人简历前）、李易诚（清华 统计学 2026）、Lyu Ruike（清华 EE 2026，8 篇成果）、Tao Shengyu（清华 2025，PDF 第 37 页后空白）、Sayed（华北电力 2020）、Haq（北理工 2017）、刘永鑫（华南理工 2018）、Yang Binbin（协和/清华 2020）；香港理工其余 5 篇；中科院软件所两条仅元数据条目（沈垚杰 2025、梁蕙霖 2026）。已拒绝：arXiv 2211.02650（字体损坏）。

## 5. 身份验证证据类型统计（15 组核验）

| 证据类型 | 出现次数 | 备注 |
| --- | ---: | --- |
| 题名页（作者/导师/学校/年份） | 15/15 | 全部可读（陈波除外） |
| 论文内成果列表 | 12/15 | 晏小辉、邓栋（arXiv 版缺附录）、林铮缺失 |
| 小论文首页机构/合作者一致 | 11/15 | 其余论文全文不可得 |
| 同一作者站点托管学位论文与小论文 | 5 | 刘磊、张蒙、范登平（部分）、李谨杰、郑烨 |
| 邮箱/基金号/致谢名单交叉 | 4 | 来斯惟、白烨、邓栋、Sanyal |
| arXiv 记录提交人 / 自述 DOI | 3 | 宋品皓、Sahoo、Li Qimai（PolyU 元数据） |

**OBSERVED**：没有任何一篇学位论文在正文中逐章声明「本章成果发表于 …」；最接近的是白烨的研究路线图（图 1.3）。成果归属几乎总是**全局**的（附录列表），这意味着「章节—论文」映射不能从学位论文文本自动抽取，必须由作者给出或由内容匹配推断。

## 6. 样本限制与选择偏差

1. **可得性偏差**：样本几乎全部来自作者自我存档，偏向有个人主页/GitHub 习惯的计算机类研究者与顶会作者（范登平、来斯惟、邓栋、Li Qimai 均为高被引作者）；普通院校、无主页的作者被系统性排除。
2. **学科偏差**：CS/AI 为主（9/10），控制（张蒙、李谨杰）与通信（Sanyal/Sahoo）少量，其他理工科仅同济一篇。
3. **年代**：2014–2023；2014 年的三篇（刘磊、晏小辉、吴建军）反映旧格式。
4. **语言**：中文论文 8 篇；英文（内地）2 篇为国际学生；控制样本为英文。
5. **版本偏差**：读到的是作者公开副本，有三例（范登平、张蒙、Sahoo）可证明在答辩后被修订（引用了 2021–2022 文献、填入 2020 年卷期、更新成果状态）；小论文方面读到的多为 arXiv 作者稿或「Revised 2016」作者副本，而非出版社定稿。
6. **规模**：9+1 组不足以推断全国硕博论文的普遍规律；所有跨案例统计都只对本语料成立。

## 7. 状态判定：PARTIAL

- 已达成：真实中国高校学位论文（10 篇内地 + 1 篇港校全文读取）；同一作者小论文真实且身份核验；章节关系有页码级证据；三类关系均有真实观察；反例保留；来源链接与哈希齐备；预算内（见决策报告 §9）。
- 未达成：中国学生硕士正式样本 2 组（目标 ≥4）；最佳中文单篇硕士案例（郑烨）因开放期刊的脚本屏蔽未能读取小论文全文；内地机构库零开放全文导致无法做随机抽样。
- 对架构决策置信度的影响见决策报告 §0。

## 8. 数据目录（不入库）

```text
D:\PaperTeamData\M14_0_1_RealThesisPaperStudy\
├── research-manifest.json        协议、预算、来源探测、代理账本
├── sources\candidates_*.json     三渠道候选记录（含 sha256/页数/成果列表/访问时间）
├── sources\candidate_index.json  统一索引（32 条）
├── sources\paper_lookup_batch1.json  arXiv/Crossref/Unpaywall 解析结果
├── thesis\*.pdf                  30 篇学位论文 PDF（+ PolyU 下载的 HTTP 头证据）
├── papers\*.pdf                  已读小论文（arXiv/CVF/AAAI/PVLDB/作者副本）
├── extracted\*.pages.json        逐页文本
├── mappings\case_*.{md,json}     15 份逐案例 Evidence Matrix
├── logs\discovery_*.md           发现日志、探测 HTTP 证据
└── tools\thesis_tools.py / write_cases_main.py
```
