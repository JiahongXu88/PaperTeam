/**
 * M6.9.2.1 测试：claude-compatible evaluation dataset。
 *
 * 覆盖任务要求的四类校验：frozen 快照守卫（原始数据集未被修改的运行期
 * 证明）、结构一致性（claim/evidence/citation/fault 只允许 noise token
 * 变化）、替换完整性（filler 清零 / marker 形态与唯一性 / 去噪骨架逐字
 * 一致）、安全模式（不引入 bio / 编码串）。
 */

import { describe, expect, it } from "vitest";

import { GROUNDING_SCENARIOS } from "../../src/evaluation/datasets/groundingScenarios.js";
import {
  deriveClaudeCompatibleScenarios,
  GROUNDING_SCENARIOS_CLAUDE,
  validateClaudeCompatibleDataset,
} from "../../src/evaluation/datasets/claudeCompatible.js";
import type { GroundingScenario } from "../../src/evaluation/types.js";

const FILLER = /\bf[0-9a-z]{1,2}[0-9]{1,2}\b/g;
const MARKER = /\brandom-term-\d+\b/g;

function skeleton(content: string): string {
  return content.replace(FILLER, " ").replace(MARKER, " ").replace(/\s+/g, " ").trim();
}

describe("M6.9.2.1 claude-compatible dataset", () => {
  it("全量兼容性校验通过（frozen 快照 / 结构一致 / 只差 noise token / 安全模式 / M6.8 结构校验）", () => {
    expect(validateClaudeCompatibleDataset()).toEqual([]);
  });

  it("claim / evidence / citation / fault 注入逐字段与 frozen 一致（任务一致性要求 1-4）", () => {
    expect(GROUNDING_SCENARIOS_CLAUDE.length).toBe(GROUNDING_SCENARIOS.length);
    for (const [index, frozen] of GROUNDING_SCENARIOS.entries()) {
      const compatible = GROUNDING_SCENARIOS_CLAUDE[index]!;
      expect(compatible.id).toBe(frozen.id);
      expect(compatible.kind).toBe(frozen.kind);
      expect(compatible.title).toBe(frozen.title);
      expect(compatible.description).toBe(frozen.description);
      // claim 数量与内容
      expect(compatible.supportable).toEqual(frozen.supportable);
      // fault 注入数量 / 类别 / ground truth 标注
      expect(compatible.faults).toEqual(frozen.faults);
      // evidence（corpus）元数据逐字段一致
      expect(compatible.corpus.length).toBe(frozen.corpus.length);
      for (const [fileIndex, source] of frozen.corpus.entries()) {
        const compatibleSource = compatible.corpus[fileIndex]!;
        expect(compatibleSource.fileName).toBe(source.fileName);
        expect(compatibleSource.title).toBe(source.title);
        expect(compatibleSource.year).toBe(source.year);
        expect(compatibleSource.authors).toEqual(source.authors);
        expect(compatibleSource.metadataCorrupted).toBe(source.metadataCorrupted);
        expect(compatibleSource.authoritativeYear).toBe(source.authoritativeYear);
      }
    }
  });

  it("corpus 差异仅限 noise token：去噪骨架逐字一致、filler 清零、marker 计数相等且场景内唯一", () => {
    let markerTotal = 0;
    let fillerTotal = 0;
    for (const [index, frozen] of GROUNDING_SCENARIOS.entries()) {
      const compatible = GROUNDING_SCENARIOS_CLAUDE[index]!;
      const scenarioMarkers: string[] = [];
      for (const [fileIndex, source] of frozen.corpus.entries()) {
        const compatibleContent = compatible.corpus[fileIndex]!.content;
        // 除 noise token 外内容逐字相同
        expect(skeleton(compatibleContent)).toBe(skeleton(source.content));
        // 兼容语料不得残留 filler 式 token（会再次触发 Claude 通道 bio 过滤）
        expect(compatibleContent.match(FILLER) ?? []).toEqual([]);
        // 替换数守恒：frozen filler 数 = compatible marker 数
        const fillerInSource = source.content.match(FILLER) ?? [];
        const markers = compatibleContent.match(MARKER) ?? [];
        expect(markers.length).toBe(fillerInSource.length);
        // marker 形态：项目统一定义的 synthetic marker
        for (const marker of markers) {
          expect(marker).toMatch(/^random-term-\d+$/);
        }
        scenarioMarkers.push(...markers);
        fillerTotal += fillerInSource.length;
      }
      // 场景内唯一（防记忆效果）
      expect(new Set(scenarioMarkers).size).toBe(scenarioMarkers.length);
      markerTotal += scenarioMarkers.length;
    }
    // M6.8 frozen 语料规模锚点：41 个 body 句 × 24 filler token
    expect(fillerTotal).toBe(984);
    expect(markerTotal).toBe(984);
  });

  it("needle / locator 在兼容语料中仍然逐字存在（citation 结构不因替换漂移）", () => {
    for (const [index, frozen] of GROUNDING_SCENARIOS.entries()) {
      const compatible = GROUNDING_SCENARIOS_CLAUDE[index]!;
      const byFile = new Map(compatible.corpus.map((source) => [source.fileName, source.content]));
      for (const claim of frozen.supportable) {
        expect(byFile.get(claim.locator.fileName)?.includes(claim.locator.needle)).toBe(true);
      }
      for (const fault of frozen.faults) {
        if (fault.locator !== undefined) {
          expect(byFile.get(fault.locator.fileName)?.includes(fault.locator.needle)).toBe(true);
        }
      }
    }
  });

  it("替换 marker 不引入 bio / 编码模式（相对 frozen 的新增串差集为空）", () => {
    const families: Array<{ label: string; extract: (content: string) => string[] }> = [
      { label: "字母数字紧凑混排", extract: (text) => (text.match(/[a-z0-9]+/gi) ?? []).filter((run) => /[0-9]/.test(run) && /[a-z]/i.test(run)) },
      { label: "核苷酸样串", extract: (text) => (text.match(/[acgtun]+/gi) ?? []).filter((run) => run.length >= 5) },
      { label: "hex/base64 样串", extract: (text) => (text.match(/[a-f0-9]+/gi) ?? []).filter((run) => run.length >= 16) },
    ];
    for (const [index, frozen] of GROUNDING_SCENARIOS.entries()) {
      const frozenContent = frozen.corpus.map((source) => source.content).join("\n");
      const compatibleContent = GROUNDING_SCENARIOS_CLAUDE[index]!.corpus
        .map((source) => source.content)
        .join("\n");
      for (const family of families) {
        const frozenRuns = new Set(family.extract(frozenContent));
        const added = family.extract(compatibleContent).filter((run) => !frozenRuns.has(run));
        expect(added, `${family.label}（scenario ${frozen.id}）`).toEqual([]);
      }
    }
  });

  it("确定性：同一 frozen 输入恒得同一派生输出", () => {
    expect(deriveClaudeCompatibleScenarios(GROUNDING_SCENARIOS)).toEqual([...GROUNDING_SCENARIOS_CLAUDE]);
    expect(deriveClaudeCompatibleScenarios(GROUNDING_SCENARIOS)).toEqual(
      deriveClaudeCompatibleScenarios(GROUNDING_SCENARIOS),
    );
  });

  it("frozen 快照守卫：frozen scenario 被改动时校验失败（防兼容数据集静默漂移）", () => {
    const first = GROUNDING_SCENARIOS[0]!;
    const tampered: GroundingScenario[] = [
      {
        ...first,
        corpus: [
          { ...first.corpus[0]!, content: `${first.corpus[0]!.content} 被篡改的额外内容` },
          ...first.corpus.slice(1),
        ],
      },
      ...GROUNDING_SCENARIOS.slice(1),
    ];
    const issues = validateClaudeCompatibleDataset({ frozenScenarios: tampered });
    expect(issues.some((issue) => issue.problem.includes("SHA-256 快照不匹配"))).toBe(true);
  });

  it("结构守卫：supportable / faults / 元数据被改动时校验失败（只允许 noise token 变化）", () => {
    const first = GROUNDING_SCENARIOS[0]!;
    const tamperedSupportable: GroundingScenario[] = [
      { ...first, supportable: [...first.supportable, { claim: "多出来的正例", locator: first.supportable[0]!.locator }] },
      ...GROUNDING_SCENARIOS.slice(1),
    ];
    expect(
      validateClaudeCompatibleDataset({ frozenScenarios: tamperedSupportable }).some((issue) =>
        issue.problem.includes("supportable"),
      ),
    ).toBe(true);

    const tamperedYear: GroundingScenario[] = [
      {
        ...first,
        corpus: [{ ...first.corpus[0]!, year: first.corpus[0]!.year + 1 }, ...first.corpus.slice(1)],
      },
      ...GROUNDING_SCENARIOS.slice(1),
    ];
    expect(
      validateClaudeCompatibleDataset({ frozenScenarios: tamperedYear }).some((issue) =>
        issue.problem.includes("元数据"),
      ),
    ).toBe(true);
  });

  it("场景 id 与 frozen 相同（--scenario 选择器在两套数据集上行为一致）", () => {
    expect(GROUNDING_SCENARIOS_CLAUDE.map((scenario) => scenario.id)).toEqual(
      GROUNDING_SCENARIOS.map((scenario) => scenario.id),
    );
  });
});
