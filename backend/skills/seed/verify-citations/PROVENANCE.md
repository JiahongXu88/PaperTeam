# Provenance — verify-citations

- **来源仓库**: https://github.com/Agents4Academia-AI/citation_verification
- **Pin revision**: `ae85ae3d51a275a57f7aa80db22870995e3d0275` (main, 2026-08-11,
  "tables: verify the ✓/✗ cells of comparison tables against the cited papers (#44)")
- **源文件路径**: `.claude/skills/verify-citations/SKILL.md`
- **License**: MIT（同目录 LICENSE 为上游原件，版权 "Agents4Academia team contributors"）
- **收录日期**: 2026-09-06
- **形态**: SKILL.md 为上游原件 verbatim（未修改）。

## 审计记录（M4.3 收录前）

- Skill 目录无附带 scripts、无 `allowed-tools` frontmatter——纯 prompt 合约；
- 方法层（never decide from memory / (claim, citation) 单记录 / 确定性 severity
  派生 / evidence 必须来自实际检索）与 PaperTeam M4.3.5 实现一致，可直接作为
  Citation/Reviewer 角色的审稿方法指引；
- 上游"表格由 Python 确定性渲染"的 frozen seam 在 PaperTeam 中由
  CitationIntegrityService 的结构化记录（非模型手排表格）承担；
- 无 shell 依赖：宿主只需提供检索类工具（PaperTeam 的 lookup_paper 满足）。
