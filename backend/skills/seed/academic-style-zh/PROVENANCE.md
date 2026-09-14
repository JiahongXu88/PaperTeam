# Provenance — academic-style-zh

- **来源仓库**: https://github.com/op7418/Humanizer-zh
- **Pin revision（immutable commit SHA）**: `91f3d394db8419c20d67ebe22a96cf8fee0a404b`
  （`main`，2026-01-19 15:45:46 +0800，"docs: 添加 npx 一键安装方式（推荐）"；
  审计时 `git ls-remote` 取得，upstream 后续更新不影响本 pin）
- **上游 Skill**: 仓库根 `SKILL.md`（name `humanizer-zh`）
- **源文件路径**: `SKILL.md`（同目录 `UPSTREAM_SKILL.md` 为该文件 verbatim 快照，
  sha256（LF 归一化）`e0edbdbc9008644263d5573fb59beac95794e188fd99c35012bfd79e9ae4beeb`）
- **License**: MIT（同目录 LICENSE 为上游原件，版权 "Copyright (c) 2026 歸藏"；
  sha256（LF 归一化）`aa00e74769e1b9d8e7fa7094dbfcca9b129a0ded6dce1cf4da050b99146d2fa7`）
- **上游的上游**（按上游 README 声明如实记录）：核心文件翻译自
  blader/humanizer；实用工具部分参考 hardikpandya/stop-slop；模式来源为
  Wikipedia:Signs of AI writing（WikiProject AI Cleanup）。
- **收录 / 适配日期**: 2026-09-14（M5.3）
- **形态**: PaperTeam academic adaptation（非 verbatim；SKILL.md 正文为 PaperTeam
  重写；上游原始 description 记录于 skill.json `originalDescription`）。

## 审计结论：为什么不能原样接入

上游目标是「去除 AI 痕迹、更像人类书写」，其中大量做法与学术写作冲突：

- 「个性与灵魂」章节要求有观点、承认复杂感受、适当使用「我」、允许混乱、
  跑题与半成型想法、对感受要具体——学术论文不允许；
- 「使用具体细节而不是模糊的主张」在没有 Evidence 约束时会诱导补造细节；
- 「质量评分 1–10 / 总分 50」以「去 AI 痕迹」为标准，与 PaperTeam 不做 AI
  detector 的立场冲突；
- 上游 `allowed-tools: Read / Write / Edit / AskUserQuestion` 假设编辑器式直接
  改写；PaperTeam Reviewer 只读，Writer 的 style 修订必须经 revision plan 与
  invariant 检查（M5.4）。

## PaperTeam 修改内容

1. **保留**（改写为中文学术语境）：夸大意义、宣传式语言、模糊归因、模板化
   段落（「挑战与未来展望」→「随着 … 快速发展 … 研究热点」类开场）、AI 高频
   词 / 冗余过渡、同义词循环（→ 术语漂移）、填充短语 / 过度限定、通用积极
   结论（→ 空泛总结）、节奏单一、机械排比（三段式）；新增翻译腔 / 不自然
   表达一类。
2. **移除 / 禁止**：第一人称与个人视角、个人感受、题外话、故意混乱、故意
   语法错误、口语化、arbitrary specific details、绕过 AI 检测器、上游评分表。
   移除与中文学术无关的模式（标题大小写、表情符号、弯引号、协作交流痕迹、
   知识截止免责声明、谄媚语气、粗体 / 内联标题列表——LaTeX 论文场景不适用）。
3. **新增硬约束**（§3）：数值 / 单位、表格事实、公式与 `\label`/`\ref`、
   citation key、专业术语、否定关系、比较方向、因果方向、结论强度不得改变。
4. **新增连接词防误报规则**：「此外 / 然而 / 因此」不因出现而报错，只在逻辑
   不符或机械节奏时报告；新增 false positive 控制章节（正常学术段落应零或
   极少 finding）。
5. **新增输出结构**：location / issue / reason / proposedAction / severity；
   明确不输出 AI 概率、检测分数。
6. **新增 Writer style-only 润色规则**（§5），对应 M5.4 Style Revision Loop 的
   invariant 检查口径。

## 署名

上游 MIT 许可要求保留版权与许可声明：LICENSE 已随附，本文件记录来源链
（Humanizer-zh → blader/humanizer / hardikpandya/stop-slop → Wikipedia）。
这是软件层面的 attribution，PaperTeam 不会因此修改用户论文的参考文献或致谢。
