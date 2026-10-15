/**
 * M14.3 — InheritedTableAsset 单元测试（候选构建 / 渲染确定性 / 守卫复核 /
 * 授权决定应用）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import {
  buildInheritedTableCandidates,
  computeTableDataHash,
  escapeLatexText,
  extractGuardedTableBlocks,
  InheritedTableAssetStore,
  renderInheritedTableLatex,
  unescapeLatexText,
  verifyInheritedTableBlock,
  verifyInheritedTables,
} from "../../src/thesis/inheritedAssets.js";
import { extractTables } from "../../src/thesis/factExtraction.js";
import { newThesisFixture, tableBlock, textBlock } from "./fixtures.js";

const tempRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("M14.3 InheritedTableAsset", () => {
  describe("LaTeX escape / unescape round-trip", () => {
    it("特殊字符双向可逆", () => {
      const raw = "S-measure & 0.724 (S=92.6%) #1 _x_ {y} ~z^ a\\b";
      const escaped = escapeLatexText(raw);
      expect(escaped).not.toContain(" & ");
      expect(unescapeLatexText(escaped)).toBe(raw);
    });
  });

  describe("候选构建（确定性 + 核验门槛）", () => {
    it("已核验数值单元格 → 候选（cellFactIds 可追溯）；未核验 majority → 不建候选", async () => {
      const fx = await newThesisFixture();
      tempRoots.push(fx.root);
      const { inputId } = await fx.importPdf(
        {
          fileName: "ablation.pdf",
          blocks: [
            textBlock("B0001", 1, "We propose the method."),
            tableBlock("B0002", 2, ["Method", "S ↑", "maxF ↑"], [["Ours", "0.724", "0.811"], ["Base", "0.667", "0.743"]], "Table 1: Ablation results"),
          ],
          textLayer: [{ page: 2, text: "0.724 0.811 0.667 0.743" }],
        },
        "published_paper",
        { title: "Ablation Study" },
      );
      await fx.service.submitDecision(fx.projectId, {
        actor: { kind: "test_fixture" },
        payload: { type: "scope_decision", inputId, scope: "included" },
      });
      const extraction = await fx.service.extractFacts(fx.projectId, inputId);
      expect(extraction.created).toBeGreaterThan(0);
      const verification = await fx.service.verifyFacts(fx.projectId, inputId);
      expect(verification.verified).toBe(4);

      const registryFile = await fx.service.list(fx.projectId);
      const input = registryFile.inputs.find((entry) => entry.inputId === inputId)!;
      const document = await fx.documents.load(fx.projectId, input.version.sourceId);
      const facts = (await fx.service.facts.load(fx.projectId)).facts;
      const candidates = buildInheritedTableCandidates({
        projectId: fx.projectId,
        researchInput: input,
        tables: extractTables(document!),
        facts,
        now: new Date().toISOString(),
      });
      expect(candidates).toHaveLength(1);
      const candidate = candidates[0]!;
      expect(candidate.status).toBe("candidate");
      expect(candidate.cellFactIds).toHaveLength(4);
      expect(candidate.verification).toEqual({ numericCells: 4, verifiedCells: 4, conflictingCells: 0 });
      expect(candidate.captionZh).toContain("继承自 Ablation Study");
      // 幂等：重复构建产生相同 assetId / dataHash
      const again = buildInheritedTableCandidates({
        projectId: fx.projectId,
        researchInput: input,
        tables: extractTables(document!),
        facts,
        now: new Date().toISOString(),
      });
      expect(again[0]!.assetId).toBe(candidate.assetId);
      expect(again[0]!.dataHash).toBe(candidate.dataHash);
    });

    it("数值单元格全部未核验（无文本层）→ 不建候选", async () => {
      const fx = await newThesisFixture();
      tempRoots.push(fx.root);
      const { inputId } = await fx.importPdf(
        {
          fileName: "unverified.pdf",
          blocks: [tableBlock("B0001", 3, ["M", "S"], [["a", "0.5"], ["b", "0.6"]], "Table 2: numbers")],
          // 无 textLayer → sourceCheck=failed
        },
        "published_paper",
      );
      await fx.service.extractFacts(fx.projectId, inputId);
      await fx.service.verifyFacts(fx.projectId, inputId);
      const registryFile = await fx.service.list(fx.projectId);
      const input = registryFile.inputs.find((entry) => entry.inputId === inputId)!;
      const document = await fx.documents.load(fx.projectId, input.version.sourceId);
      const facts = (await fx.service.facts.load(fx.projectId)).facts;
      const candidates = buildInheritedTableCandidates({
        projectId: fx.projectId,
        researchInput: input,
        tables: extractTables(document!),
        facts,
        now: new Date().toISOString(),
      });
      expect(candidates).toHaveLength(0);
    });
  });

  describe("store + 授权决定", () => {
    it("table_inheritance 决定：authorized 状态落盘 + actor 可审计；候选重建不降级", async () => {
      const root = await mkdtemp(join(tmpdir(), "paperteam-assets-"));
      tempRoots.push(root);
      const projects = new ProjectStore({ root });
      const project = await projects.create("资产项目");
      const store = new InheritedTableAssetStore(projects);
      const now = new Date().toISOString();
      const asset = {
        schemaVersion: 1 as const,
        assetId: "ita-abcdef123456",
        projectId: project.id,
        status: "candidate" as const,
        source: { researchInputId: "ri-x", contentHash: "h", sourceId: "S001", blockId: "B0001", labelBasis: "parser_caption" as const },
        structure: { headerRow: ["M", "S"], rows: [["a", "0.5"]], labelColumnCount: 1 },
        captionZh: "表",
        dataHash: computeTableDataHash(["M", "S"], [["a", "0.5"]]),
        cellFactIds: [],
        verification: { numericCells: 1, verifiedCells: 1, conflictingCells: 0 },
        createdAt: now,
        updatedAt: now,
      };
      await store.upsert(project.id, [asset], now);
      expect((await store.load(project.id))!.assets).toHaveLength(1);
      // 直接变更授权态（applyDecision 的等价语义：load → mutate → save）
      const file = await store.load(project.id);
      const loaded = file!.assets.find((entry) => entry.assetId === asset.assetId)!;
      loaded.status = "authorized";
      loaded.authorization = { decisionId: "D1", actorKind: "test_fixture", authorizedAt: now };
      await store.save(project.id, file!);
      // 候选重建（同 assetId、candidate 态）不得降级
      await store.upsert(project.id, [asset], now);
      const after = await store.load(project.id);
      const entry = after!.assets.find((candidate) => candidate.assetId === asset.assetId)!;
      expect(entry.status).toBe("authorized");
      expect(entry.authorization!.decisionId).toBe("D1");
    });
  });

  describe("渲染 + 守卫复核", () => {
    const asset = {
      schemaVersion: 1 as const,
      assetId: "ita-0123456789ab",
      projectId: "p-test",
      status: "inserted" as const,
      source: { researchInputId: "ri-x", contentHash: "h", sourceId: "S001", blockId: "B0001", labelBasis: "parser_caption" as const },
      structure: {
        headerRow: ["Method", "S ↑", "maxF ↑"],
        rows: [
          ["Ours", "0.724", "0.811"],
          ["Base", "0.667", "0.743"],
        ],
        labelColumnCount: 1,
      },
      captionZh: "消融结果（继承自论文，数据未改动）",
      dataHash: computeTableDataHash(["Method", "S ↑", "maxF ↑"], [["Ours", "0.724", "0.811"], ["Base", "0.667", "0.743"]]),
      cellFactIds: [],
      verification: { numericCells: 4, verifiedCells: 4, conflictingCells: 0 },
      createdAt: "2026-10-15T00:00:00Z",
      updatedAt: "2026-10-15T00:00:00Z",
    };

    it("渲染块自复核通过；escape 内容可解析回原值", () => {
      const latex = renderInheritedTableLatex(asset);
      const blocks = extractGuardedTableBlocks(latex);
      expect(blocks.has("ita-0123456789ab")).toBe(true);
      const verification = verifyInheritedTableBlock(asset, blocks.get("ita-0123456789ab"));
      expect(verification.ok).toBe(true);
    });

    it("数值漂移（0.724 → 0.8）被拒绝", () => {
      const latex = renderInheritedTableLatex(asset).replace("0.724", "0.8");
      const verification = verifyInheritedTableBlock(asset, extractGuardedTableBlocks(latex).get("ita-0123456789ab"));
      expect(verification.ok).toBe(false);
      expect(verification.violations.join(" ")).toContain("cell_drift");
    });

    it("行删除被拒绝（row_count_drift）", () => {
      const latex = renderInheritedTableLatex(asset).replace("Base & 0.667 & 0.743 \\\\\n", "");
      const verification = verifyInheritedTableBlock(asset, extractGuardedTableBlocks(latex).get("ita-0123456789ab"));
      expect(verification.ok).toBe(false);
      expect(verification.violations.join(" ")).toContain("row_count_drift");
    });

    it("守卫块缺失被拒绝", () => {
      const verification = verifyInheritedTableBlock(asset, undefined);
      expect(verification.ok).toBe(false);
      expect(verification.violations[0]).toContain("guard_block_missing");
    });

    it("题注改写合法（数据不变则通过）", () => {
      const latex = renderInheritedTableLatex(asset).replace("消融结果（继承自论文，数据未改动）", "表 5.1 主要对比结果");
      const verification = verifyInheritedTableBlock(asset, extractGuardedTableBlocks(latex).get("ita-0123456789ab"));
      expect(verification.ok).toBe(true);
    });

    it("首列为空的表头行不被误判列数（真实案例：S-measure Table 1 13 列被数成 12）", () => {
      const wideAsset = {
        ...asset,
        structure: {
          headerRow: ["", "A", "B"],
          rows: [["x", "0.1", "0.2"]],
          labelColumnCount: 1,
        },
      };
      const latex = renderInheritedTableLatex(wideAsset);
      const verification = verifyInheritedTableBlock(wideAsset, extractGuardedTableBlocks(latex).get("ita-0123456789ab"));
      expect(verification.ok).toBe(true);
    });

    it("批量复核：混合文件定位", () => {
      const intact = renderInheritedTableLatex(asset);
      const other = { ...asset, assetId: "ita-fedcba987654" };
      const drifted = renderInheritedTableLatex(other).replace("0.811", "0.9");
      const result = verifyInheritedTables([asset, other], [
        { file: "s1.tex", latex: `正文\n${intact}` },
        { file: "s2.tex", latex: `正文\n${drifted}` },
      ]);
      expect(result.checked).toBe(2);
      expect(result.intact).toBe(1);
      expect(result.findings.filter((finding) => !finding.ok)).toHaveLength(1);
      expect(result.findings.find((finding) => !finding.ok)!.assetId).toBe("ita-fedcba987654");
    });
  });
});
