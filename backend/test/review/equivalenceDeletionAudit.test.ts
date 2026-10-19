/**
 * M14.9.3：M14.9.1 等价门的删除侧审计。M14.9.1 把「授权删除行」整体排除出清单，被误删的正文因此
 * 从未进入「应保留」集合（M14.9.2 盲化器 v1 吞掉引言却 16/16 VALID 的直接原因）。现在每段授权删除
 * 逐行剔除可证明的元数据 / 署名行，余下内容仍像正文 → INVALID_INPUT。
 */
import { describe, expect, it } from "vitest";

import { auditAuthorizedRemovals, checkEquivalence, pdfTextInventory } from "../../src/review/reviewInputEquivalence.js";

const LINES = [
  "低照度场景下的车辆检测方法研究",
  "张三1，李四2，王五1",
  "1.某大学计算机学院，某市 100000",
  "作者简介：张三（1990—），男，博士，讲师，研究方向为计算机视觉。",
  "近年来，城市道路监控视频的规模快速增长，人工巡检难以覆盖全部路段。本文关注低照度条件下的车辆检测问题，",
  "现有方法在夜间场景中的召回率明显下降，漏检会直接影响后续的轨迹关联与事件分析。",
  "1 方法",
  "实验数据来自某大学交通研究中心公开发布的监控数据集，该数据集的建设得到国家自然科学基金支持。",
];
const raw = LINES.join("\n");
const keep = (dropped: number[]) => LINES.filter((_line, index) => !dropped.includes(index + 1)).join("\n");

describe("等价门删除侧审计", () => {
  it("只删署名 / 单位 / 作者简介 → VALID（与 M14.9.1 行为一致）", () => {
    const dropped = [2, 3, 4];
    const inventory = pdfTextInventory(raw, new Set(dropped));
    expect(auditAuthorizedRemovals(inventory)).toEqual([]);
    expect(checkEquivalence(inventory, { arm: "structured_blind_md", text: keep(dropped), redactions: [], figuresNotEvaluated: 0, notes: [] }).status).toBe("VALID");
  });

  it("作者简介后连带删掉引言（v1 缺陷形态）→ 保留侧数值 / 词元齐全也判 INVALID_INPUT", () => {
    const dropped = [2, 3, 4, 5, 6];
    const inventory = pdfTextInventory(raw, new Set(dropped));
    const report = checkEquivalence(inventory, { arm: "structured_blind_md", text: keep(dropped), redactions: [], figuresNotEvaluated: 0, notes: [] });
    expect(report.metrics.numbersMissing).toBe(0);
    expect(report.metrics.tokenCoverage).toBe(1);
    expect(report.status).toBe("INVALID_INPUT");
    expect(report.reasons.join("")).toContain("授权删除越界");
  });

  it("正文中出现「某大学 / 国家自然科学基金」的整句被当作元数据删除 → 越界", () => {
    const dropped = [2, 3, 4, 8];
    const inventory = pdfTextInventory(raw, new Set(dropped));
    expect(auditAuthorizedRemovals(inventory)).toHaveLength(1);
  });
});
