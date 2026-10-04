/**
 * M11.3（Phase D）Deterministic Citation Syntax Repair 单元测试（§21–§24）。
 *
 * 覆盖：
 * - detect：未闭合 \cite（含跨行）/ 空 cite / 空 key 段 / 同命令重复 key ——
 *   旧 StaticCitationChecker 的正则只匹配已闭合命令，未闭合形式不可见；
 * - repair 安全边界：空命令移除 / 空段清理 / 重复 key 去重 / key 完整命中
 *   bib 的未闭合补右括号；**绝不猜 key**（残缺 key 不补、不换最像的 key）；
 * - 正常 \cite（含多 key）零改动；
 * - fake citation 不受影响（Citation Integrity 层继续拦）；
 * - disconfirm：build 类截断指控 vs 真实文件检测的交叉核验（MOT 伪影场景）。
 */

import { describe, expect, it } from "vitest";

import {
  detectCitationSyntaxIssues,
  disconfirmBuildFindings,
  repairCitationSyntax,
} from "../../src/citation/citationSyntax.js";

const BIB = ["ng2023traffic", "you2024multi", "aharon2022bot"];

describe("detectCitationSyntaxIssues", () => {
  it("未闭合 \\cite（行内无右括号）被检出——旧检查不可见的形式", () => {
    const tex = "带 ReID 的 StrongSORT 不适合实时\\cite{ng2023traffic\n下一行内容。";
    const issues = detectCitationSyntaxIssues([{ file: "sec.tex", content: tex }], BIB);
    expect(issues.filter((issue) => issue.kind === "unclosed_cite")).toHaveLength(1);
    expect(issues[0]?.line).toBe(1);
  });

  it("正常 \\cite（含多 key）零检出", () => {
    const tex = "低分检测二次关联范式~\\cite{aharon2022bot,you2024multi}已成为主导。";
    expect(detectCitationSyntaxIssues([{ file: "sec.tex", content: tex }], BIB)).toEqual([]);
  });

  it("空 cite / 空 key 段 / 重复 key 各自检出", () => {
    const tex = "一处\\cite{}空引用，一处\\cite{you2024multi,,aharon2022bot}空段，一处\\cite{you2024multi,you2024multi}重复。";
    const issues = detectCitationSyntaxIssues([{ file: "sec.tex", content: tex }], BIB);
    const kinds = issues.map((issue) => issue.kind).sort();
    expect(kinds).toEqual(["duplicate_key", "empty_cite", "empty_key_segment"]);
  });

  it("文件级未闭合（EOF 前无右括号）被检出", () => {
    const tex = "句末截断\\cite{aharon2022bot";
    const issues = detectCitationSyntaxIssues([{ file: "sec.tex", content: tex }], BIB);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe("unclosed_cite");
  });
});

describe("repairCitationSyntax（安全修复边界，§22）", () => {
  it("空 cite 命令整体移除", () => {
    const result = repairCitationSyntax("前文~\\cite{} 后文。", "sec.tex", BIB);
    expect(result.repaired).toBe(true);
    expect(result.content).toBe("前文 后文。");
    expect(result.fixes).toEqual([{ kind: "empty_cite", count: 1 }]);
  });

  it("空 key 段清理；同命令重复 key 去重（保序）", () => {
    const a = repairCitationSyntax("x~\\cite{you2024multi,,aharon2022bot}y", "sec.tex", BIB);
    expect(a.content).toBe("x~\\cite{you2024multi,aharon2022bot}y");
    const b = repairCitationSyntax("x~\\cite{you2024multi,you2024multi,aharon2022bot}y", "sec.tex", BIB);
    expect(b.content).toBe("x~\\cite{you2024multi,aharon2022bot}y");
    expect(b.fixes).toEqual([{ kind: "duplicate_key", count: 1 }]);
  });

  it("未闭合且 key 完整命中 bib → 补右括号（唯一明确，无猜测）", () => {
    const tex = "带 ReID 的 StrongSORT 不适合实时\\cite{ng2023traffic";
    const result = repairCitationSyntax(tex, "sec.tex", BIB);
    expect(result.content).toBe("带 ReID 的 StrongSORT 不适合实时\\cite{ng2023traffic}");
    expect(result.fixes).toEqual([{ kind: "unclosed_cite", count: 1 }]);
    expect(result.unresolved).toEqual([]);
  });

  it("未闭合且 key 残缺（不在 bib）→ 不修不猜，标 unresolved", () => {
    const tex = "据其报道\\cite{ng2023traf\n后续段落。";
    const result = repairCitationSyntax(tex, "sec.tex", BIB);
    expect(result.repaired).toBe(false);
    expect(result.content).toBe(tex);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.kind).toBe("unclosed_cite");
  });

  it("未闭合但行内尾随其它文本（真截断嫌疑）→ 不修，标 unresolved", () => {
    const tex = "句子\\cite{ng2023traffic，其后还有中文内容";
    const result = repairCitationSyntax(tex, "sec.tex", BIB);
    expect(result.repaired).toBe(false);
    expect(result.unresolved).toHaveLength(1);
  });

  it("正常多 key cite 与带可选参数 cite 零改动；fake citation 不经此层（key 存在性仍由 Integrity 层判）", () => {
    const tex = "正常~\\cite[page 7]{you2024multi,aharon2022bot}与捏造~\\cite{madeup2026fake}。";
    const result = repairCitationSyntax(tex, "sec.tex", BIB);
    expect(result.repaired).toBe(false);
    expect(result.content).toBe(tex);
    // madeup2026fake 形状合法（无结构问题）——不是本层职责，静态检查层报 missing
    expect(result.unresolved).toEqual([]);
  });
});

describe("disconfirmBuildFindings（视图伪影反证，MOT 实录场景）", () => {
  const truncationFinding = {
    category: "build",
    severity: "critical",
    blocking: true,
    description: "第 9.2 节「关键分歧」段中途截断：句子止于「不适合实时\\cite」，\\cite 命令未闭合，其后内容缺失",
  };
  const healthyFile = {
    file: "cross-method-comparison.tex",
    content:
      "带 ReID 的 StrongSORT 不适合实时\\cite{ng2023traffic}。BoostTrack 的消融属混合证据\\cite{you2024multi}。其三、其四、其五项分歧俱全。",
  };

  it("真实文件无结构问题 → 截断指控被反证（digest 伪影）", () => {
    const result = disconfirmBuildFindings([truncationFinding], [healthyFile], BIB);
    expect(result.disconfirmedCount).toBe(1);
    expect(result.isDisconfirmed(truncationFinding)).toBe(true);
  });

  it("真实文件确有未闭合 cite → 指控成立，不反证", () => {
    const brokenFile = { file: "x.tex", content: "句子\\cite{ng2023traffic\n后续" };
    const result = disconfirmBuildFindings([truncationFinding], [brokenFile], BIB);
    expect(result.disconfirmedCount).toBe(0);
    expect(result.isDisconfirmed(truncationFinding)).toBe(false);
  });

  it("非 build 类 / 非截断指控的 finding 不在反证范围", () => {
    const styleFinding = { category: "style", description: "句式重复" };
    const otherBuild = { category: "build", description: "缺少参考文献列表" };
    const result = disconfirmBuildFindings([styleFinding, otherBuild, truncationFinding], [healthyFile], BIB);
    expect(result.isDisconfirmed(styleFinding)).toBe(false);
    expect(result.isDisconfirmed(otherBuild)).toBe(false);
    expect(result.isDisconfirmed(truncationFinding)).toBe(true);
  });
});
