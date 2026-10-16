/**
 * M14.6（F5）：Experiment Policy 与研究输入事实的统一口径块。
 */
import { describe, expect, it } from "vitest";

import { renderExperimentPolicyLines } from "../../src/experiments/experimentPolicy.js";
import {
  composeExperimentAndResearchFactPolicyLines,
  renderResearchFactLine,
  renderResearchFactTableLines,
  RESEARCH_FACT_POLICY_HEADER,
} from "../../src/thesis/researchFactPolicy.js";
import type { FactView } from "../../src/thesis/researchInputTypes.js";

function fact(factId: string, surface: string, metric: string, verification: FactView["verification"] = "author_confirmed"): FactView {
  return {
    factId,
    researchInputId: "ri-be699de35f19",
    kind: "numeric_result",
    key: { metric },
    surface,
    value: { raw: surface, numeric: Number(surface.replace("%", "")), unit: surface.endsWith("%") ? "%" : undefined },
    verification,
    sourceCheck: "verified",
    conflictStatus: "none",
    location: "S001 p1 B0004",
  };
}

const EMPTY_POLICY = { entries: [], legacyConfirmedGroupIds: [] };

describe("M14.6 F5 — 统一事实口径块", () => {
  it("有已确认事实 + 零实验包：不再出现『没有已导入的实验数据』行，改为数据来源 = 研究输入事实表", () => {
    const lines = composeExperimentAndResearchFactPolicyLines(EMPTY_POLICY, {
      facts: { authorConfirmed: [fact("F1", "75.37%", "error")], sourceVerifiedUnconfirmed: [fact("F2", "0.12", "rmse", "source_verified")], conflicted: [] },
      inputs: { included: [{ inputId: "ri-be699de35f19", inputType: "published_paper", title: "NMPC 下洗论文", workId: "w", contentHash: "724c26697b79ee5f", scope: "included", parseStatus: "full_text" }] },
    });
    const text = lines.join("\n");
    expect(text).not.toContain("本项目当前没有已导入的实验数据");
    expect(text).toContain("本项目没有导入独立的实验包");
    expect(text).toContain(RESEARCH_FACT_POLICY_HEADER);
    expect(text).toContain("- 75.37%（error）｜事实 F1｜来源 ri-be699de35f19 S001 p1 B0004｜来源核验 verified｜作者已确认");
    expect(text).toContain("ri-be699de35f19《NMPC 下洗论文》#724c26697b79");
    expect(text).toContain("另有 1 条仅来源核验、未经作者确认的事实");
    expect(text).not.toContain("0.12（"); // 未确认事实不列数值（不自动升级）
    expect(text).toContain("不在上表、也无实验包授权或已核验 Evidence 支撑的具体数值");
  });

  it("无已确认事实：与 renderExperimentPolicyLines 逐字节一致（非 thesis 项目零变化）", () => {
    expect(composeExperimentAndResearchFactPolicyLines(EMPTY_POLICY, null)).toEqual(renderExperimentPolicyLines(EMPTY_POLICY));
    expect(
      composeExperimentAndResearchFactPolicyLines(EMPTY_POLICY, { facts: { authorConfirmed: [], sourceVerifiedUnconfirmed: [fact("F2", "0.12", "rmse", "source_verified")], conflicted: [] } }),
    ).toEqual(renderExperimentPolicyLines(EMPTY_POLICY));
  });

  it("有实验包 + 有已确认事实：两者并列为合法来源", () => {
    const policy = {
      entries: [{ packageId: "p1", groupId: "g1", scopeId: "s1", split: "test", status: "confirmed" as const, workflowUse: "allowed" as const, observationCount: 3, metricCount: 2 }],
      legacyConfirmedGroupIds: [],
    };
    const text = composeExperimentAndResearchFactPolicyLines(policy, { facts: { authorConfirmed: [fact("F1", "75.37%", "error")], sourceVerifiedUnconfirmed: [], conflicted: [] } }).join("\n");
    expect(text).toContain("实验组 g1");
    expect(text).toContain("除上述实验包范围外，以下研究输入已确认事实同为本论文合法的实验数据与参数来源");
    expect(text).toContain("- 75.37%（error）");
  });

  it("事实行渲染：单位去重、冲突标注、表上限 30 行", () => {
    expect(renderResearchFactLine(fact("F1", "75.37%", "error"))).not.toContain("单位 %");
    const conflicted = { ...fact("F3", "0.5", "mae"), conflictStatus: "unresolved" as FactView["conflictStatus"] };
    expect(renderResearchFactLine(conflicted)).toContain("冲突 unresolved");
    const many = Array.from({ length: 35 }, (_, index) => fact(`F${index}`, `${index}.5`, "m"));
    const lines = renderResearchFactTableLines({ facts: { authorConfirmed: many, sourceVerifiedUnconfirmed: [], conflicted: [] } });
    expect(lines.filter((line) => line.startsWith("- ")).length).toBe(30);
    expect(lines.some((line) => line.includes("其余 5 条已确认事实略"))).toBe(true);
  });
});
