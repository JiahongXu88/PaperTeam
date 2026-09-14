# Provenance — academic-review

- **来源仓库**: https://github.com/K-Dense-AI/scientific-agent-skills
- **Pin revision（immutable commit SHA）**: `0b2afe68a5f9379097ad815e028af664f1e222b7`
  （`main`，2026-09-13 09:27:11 -0700，"Add new images for AlphaGenome, Folklore
  variant evidence, and Genomic intelligence"；审计时 `git ls-remote` 取得）
- **上游 Skill**: `skills/peer-review`（tree `5521fbe04d1868847f76765c08edfc9d7632f7f7`）
- **源文件路径**: `skills/peer-review/SKILL.md`
  （上游 metadata.version "2.2"；同目录 `UPSTREAM_SKILL.md` 为该文件 verbatim 快照，
  sha256（LF 归一化）`3422beafc240aa7d2703e71fe16e3400269a5ea17045d8b390a30efe58c3de67`）
- **License**: MIT（同目录 LICENSE 为上游仓库根 `LICENSE.md` 原件，版权
  "Copyright (c) 2025 K-Dense Inc."；sha256（LF 归一化）
  `09b02a3c9df3053c55531d503357a9c7cde275970e6c3ceaa1ddf5f0e90b40c1`）
- **收录 / 适配日期**: 2026-09-14（M5.3）
- **形态**: PaperTeam academic adaptation（非 verbatim；SKILL.md 正文为 PaperTeam
  重写；上游原始 description 记录于 skill.json `originalDescription`）。

## 上游未收录的内容（审计结论）

上游 skill 目录共 22 个文件：SKILL.md、`assets/`（9 个模板 / 目录）、
`references/`（6 篇参考）、`scripts/`（7 个 Python CLI）。PaperTeam **只收录
SKILL.md 快照 + LICENSE**：

- `scripts/*.py`（validate_review_intake / select_reporting_guidelines /
  validate_claim_evidence / audit_statistics_reproducibility / audit_citations /
  generate_review_scaffold / lint_review）是本地 Python CLI；PaperTeam Reviewer
  角色只读、不持有 shell（`read/grep/find/ls`），**不因上游附带工具而扩大 Reviewer
  权限**；其中「citation key 一致性 / 格式」类确定性检查 PaperTeam 已由
  StaticCitationChecker 与 Citation Verification 以受控 service 提供，无需暴露脚本；
- `assets/` 的 intake / 报告规范（CONSORT / PRISMA / STROBE 等）面向医学期刊审稿
  流程，与工科论文的 fact / academic / style 三 lens 不匹配；
- `references/common_issues.md` 中「claim–evidence alignment」常见错配与
  「constructive response（位置 → 结果或缺失 → 问题 → 有界动作）」已吸收进
  SKILL.md §1 / §4；`ethical_review_practice.md`（保密 / 授权 / 渠道分离）、
  `statistical_reproducibility.md`（临床统计细节）不属于本 lens。

## PaperTeam 修改内容

1. 删除上游「authorization / confidentiality / intake gate / editor channel」
   流程（PaperTeam 单机本地、用户即作者，无期刊审稿授权语境）。
2. 把上游「Location / Observation / Evidence or criterion / Why it matters /
   Requested action」五要素映射为 PaperTeam ReviewIssue 字段（section /
   description / suggestedAction / severity），新增「可执行性自测：能否直接交给
   Writer 执行」。
3. 新增严重度口径（critical / major / minor 与 blocking 的关系），明确不为促成
   修改而抬高严重度。
4. 评审顺序改为工科论文五层（问题定义 → 方法 → 实验 → 论证 → 写作），对应
   PaperTeam academic 评分维度。
5. 明确边界：引用真伪归 Citation Verification，逐条 claim 核验归 fact lens，
   不宣布录用 / 拒稿决定。
6. 删除上游「Citing Scientific Agent Skills」指令：软件层面 attribution 记录于
   本文件与 LICENSE；不向被审稿件 / 用户论文添加引用。

## 上游署名建议（如实记录，不自动执行）

上游建议在受其实质帮助的成果中引用 Kassis, T. et al. (2026). *Scientific Agent
Skills: A Library of Procedural Knowledge for Research Agents*. arXiv:2609.00065。
PaperTeam 在此如实记录该建议；是否引用由用户决定，PaperTeam 不自动修改用户论文
的参考文献。
