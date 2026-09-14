# Provenance — academic-writing-zh

- **来源仓库**: https://github.com/K-Dense-AI/scientific-agent-skills
- **Pin revision（immutable commit SHA）**: `0b2afe68a5f9379097ad815e028af664f1e222b7`
  （`main`，2026-09-13 09:27:11 -0700，"Add new images for AlphaGenome, Folklore
  variant evidence, and Genomic intelligence"；审计时 `git ls-remote` 取得，
  之后 upstream 若更新不影响本 pin）
- **上游 Skill**: `skills/scientific-writing`（tree `ae5fac6462c292e31e8f75337ad4735c127146b4`）
- **源文件路径**: `skills/scientific-writing/SKILL.md`
  （上游 metadata.version "2.1"；同目录 `UPSTREAM_SKILL.md` 为该文件 verbatim 快照，
  sha256（LF 归一化）`f6026e7d79cd3133e9343a7d6e6c5e06f4ad061888efb6a73fcb95e073eebf67`）
- **License**: MIT（同目录 LICENSE 为上游仓库根 `LICENSE.md` 原件，版权
  "Copyright (c) 2025 K-Dense Inc."；sha256（LF 归一化）
  `09b02a3c9df3053c55531d503357a9c7cde275970e6c3ceaa1ddf5f0e90b40c1`）
- **收录 / 适配日期**: 2026-09-14（M5.3）
- **形态**: PaperTeam academic adaptation（非 verbatim；SKILL.md 正文为 PaperTeam
  重写，frontmatter description 为 PaperTeam 中文描述；上游原始 description 记录于
  skill.json `originalDescription`）。

## 上游未收录的内容（审计结论）

上游 skill 目录共 33 个文件：SKILL.md、`assets/`（9 个模板 / 指南）、
`references/`（12 篇参考）、`scripts/`（9 个 Python CLI）。PaperTeam **只收录
SKILL.md 快照 + LICENSE**，原因：

- `scripts/*.py`（scaffold / validate_manifest / audit_claims / check_consistency /
  check_references / lint_manuscript 等）假设 Python 3.11 + 本地文件工作流；
  PaperTeam Writer / Reviewer 不持有 shell，事实核验由 EvidenceStore、Citation
  Verification、Quality Gate 的确定性代码完成，不引入第二套 claim / evidence 登记
  工件（`claims.csv` / `source_manifest.json` / `consistency_manifest.json`）；
- `assets/` 模板面向 Markdown 稿件与 IMRAD 医学报告规范（CONSORT / PRISMA /
  STROBE 等），与中文工科 LaTeX 论文场景不匹配；
- `references/*.md` 中与本适配直接相关的原则（`writing_principles.md`：
  accuracy before fluency、numbers and units、methods and results、limitations、
  language review）已吸收进 SKILL.md §1–§4；其余（authorship / confidentiality /
  journal policies / figures）不属于 Writer 写作任务面。

## PaperTeam 修改内容

1. 语言与对象：英文通用科学写作 → 中文工科论文（句式、翻译腔、术语一致、
   量与单位、评价词纪律、人称）。
2. 结构：删除上游 12 步工作流（scaffold → guideline → evidence record → … →
   lint and approve），代之以 PaperTeam 任务面：只写 prompt 要求的章节 / 摘要；
   新增「章节边界」表（方法 / 实验 / 结果 / 讨论 / 结论）。
3. 事实纪律：保留 no fabrication / evidence binding / scientific fidelity，
   重述为「不补造实验、不补造数字、不虚构 citation、claim ≤ evidence、明确
   uncertainty」；Evidence 使用方式对齐 PaperTeam 任务 prompt 的 `[E001]` 列表
   与参考文献 key 白名单。
4. 新增 LaTeX 保持规则（`\cite` key 集合、公式、`\label`/`\ref`、环境配对、
   输出形态）与修订模式附加规则（逐条对应、最小修改、证据不足只能弱化 / 删除）。
5. 删除上游「Citing Scientific Agent Skills」对生成内容的指令性要求：软件层面
   attribution 记录于本文件与 LICENSE；**不**向用户论文 bibliography 自动插入
   上游论文引用（见 SKILL.md §8）。
6. 删除上游 confidentiality / authorship / disclosure / reporting-guideline
   coverage 章节（PaperTeam 单机本地运行、无外发；署名与披露属于用户责任面）。

## 上游署名建议（如实记录，不自动执行）

上游 CITATION.cff 与 SKILL.md 建议在受其实质帮助的成果中引用：
Kassis, T., Agarwal, V., He, Y., Patel, D., & Brueckner, A. M. (2026). *Scientific
Agent Skills: A Library of Procedural Knowledge for Research Agents*.
arXiv:2609.00065. https://doi.org/10.48550/arXiv.2609.00065

PaperTeam 的立场：这是对软件 / 方法来源的 attribution，已在此记录；是否在用户
论文中引用由用户决定，PaperTeam 不会自动修改用户论文的参考文献。
