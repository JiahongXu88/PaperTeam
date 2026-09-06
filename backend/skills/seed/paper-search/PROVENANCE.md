# Provenance — paper-search

- **来源仓库**: https://github.com/openags/paper-search-mcp
- **Pin revision**: `234678ab231074a7977320978ee0496dcdaddd1f` (main,
  "Merge pull request #99 from FaintFlower/fix/star-history-chart")
- **源文件路径**: `claude-code/SKILL.md`（同目录 UPSTREAM_SKILL.md 为上游原件 verbatim）
- **License**: MIT（同目录 LICENSE 为上游原件，版权 "OPENAGS"）
- **收录日期**: 2026-09-06
- **形态**: PaperTeam-compatible wrapper（SKILL.md 正文按宿主受控工具面改写；
  frontmatter description 保持原义）。

## 审计记录（M4.3 收录前）

- 上游 SKILL.md 的每条命令都假设全局 `paper-search` CLI（shell）——PaperTeam
  角色默认不持有 shell，故正文改写为受控工具调用（search_papers / lookup_paper），
  不冒充上游原件（原件保留为 UPSTREAM_SKILL.md）；
- 上游同等能力以 MCP server（paper-search-mcp PyPI 包）存在；PaperTeam 选择
  自建轻量 connector（backend/src/citation/scholarly.ts）而非引入 Python
  服务——Windows 部署成本与测试可控性优先；
- MIT 许可允许修改重发布，条件是保留版权与许可声明（LICENSE 已随附）。
