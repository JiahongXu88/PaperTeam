import { describe, expect, it } from "vitest";
import { locateLatexSections } from "../../src/review/revisionScope.js";
import {
  baseSpanId,
  buildUnitEditContext,
  fileBodySpan,
  isUnitSpanId,
  locateFileSpans,
  mergeAdjacentUnits,
  partitionSpanIntoUnits,
  relocateRevisionSpan,
  resolveUnitByQuotes,
} from "../../src/review/logicalSpan.js";

/** 生成约 `chars` 字符的章节正文（每段约 240 字符，段间空行）。
 *  每段含两处唯一 token（p${i} / obs ${i}），保证任意 60+ 字符窗口不可跨段重复。 */
export function chapterBody(chars: number, marker = "para"): string {
  const parts: string[] = [];
  let total = 0;
  let index = 1;
  while (total < chars) {
    const line = `Paragraph ${index}: p${index} ${marker} analysis of the proposed method with citation (obs ${index}).\\cite{ref${(index % 7) + 1}} The measured accuracy stays 8${index % 10}.${index % 10}\\%.`;
    parts.push(line);
    total += line.length + 2;
    index += 1;
  }
  return parts.join("\n\n");
}

describe("M14.1a locateLatexSections（既有定位器的长文档缺陷修复）", () => {
  it("嵌套花括号标题（\\mbox{-} 复合词）不再漏切，正文归入正确 span", () => {
    const tex = [
      String.raw`\section{Introduction}`,
      "Intro text.",
      String.raw`\subsection{MRG\mbox{-}DTM}`,
      "Fusion text.",
      String.raw`\section{Experiments}`,
      "Exp text.",
    ].join("\n");
    const spans = locateLatexSections("main.tex", tex);
    // 旧实现 [^}]* 读不出 \mbox 标题：MRG\mbox 之后在 `}` 处截断，`-DTM}` 漏匹配
    expect(spans.map((span) => span.heading)).toEqual([
      "Introduction",
      String.raw`MRG\mbox{-}DTM`,
      "Experiments",
    ]);
    expect(spans[1]!.content).toContain("Fusion text.");
    expect(spans[1]!.content).not.toContain("Intro text.");
  });

  it("同名标题获得唯一 logicalSection id（第二个 #2），不再坍缩到第一个", () => {
    const tex = [
      String.raw`\section{Method}`,
      "First method body.",
      String.raw`\section{Method}`,
      "Second method body.",
    ].join("\n");
    const spans = locateLatexSections("main.tex", tex);
    expect(spans.map((span) => span.logicalSection)).toEqual(["section:Method", "section:Method#2"]);
    expect(spans[1]!.content).toContain("Second method body.");
  });

  it("starred 变体与短标题参数仍被识别", () => {
    const tex = [String.raw`\section*{Notes}`, "Body."].join("\n");
    const spans = locateLatexSections("main.tex", tex);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.heading).toBe("Notes");
  });
});

describe("M14.1a partitionSpanIntoUnits（有界编辑单元）", () => {
  const heading = String.raw`\section{Method}` + "\n";
  const span = locateLatexSections("sections/method.tex", heading + chapterBody(30_000))[0]!;

  it("30k 章节被切成有界单元；单元拼接与原文逐字节一致（零丢失）", () => {
    const { units } = partitionSpanIntoUnits(span, 9_000);
    expect(span.content.length).toBeGreaterThan(30_000 - 500);
    expect(units.length).toBeGreaterThanOrEqual(3);
    for (const unit of units) {
      expect(unit.content.length).toBeLessThanOrEqual(9_000);
      expect(isUnitSpanId(unit.logicalSection)).toBe(true);
    }
    expect(units.map((unit) => unit.content).join("")).toBe(span.content);
    // 覆盖区间连续且无缝
    for (let index = 1; index < units.length; index += 1) {
      expect(units[index]!.start).toBe(units[index - 1]!.end);
    }
  });

  it("12k 章节（略高于旧截断阈值）同样完整切分", () => {
    const small = locateLatexSections("f.tex", heading + chapterBody(12_500))[0]!;
    const { units } = partitionSpanIntoUnits(small, 9_000);
    expect(units.length).toBeGreaterThanOrEqual(2);
    expect(units.map((unit) => unit.content).join("")).toBe(small.content);
  });

  it("跨空行的 LaTeX 环境不被切断（环境整块保留在单一单元）", () => {
    const env = [String.raw`\begin{align}`, "a &= b \\", "", "c &= d \\", String.raw`\end{align}`].join("\n");
    const tex = "Para one.\n\n" + env + "\n\nPara two.";
    const { units, oversizeUnits } = partitionSpanIntoUnits(fileBodySpan("f.tex", tex), 60);
    expect(units.some((unit) => unit.content.includes(String.raw`\begin{align}`) && unit.content.includes(String.raw`\end{align}`))).toBe(true);
    expect(oversizeUnits).toBe(0);
    expect(units.map((unit) => unit.content).join("")).toBe(tex);
  });

  it("单元上下文：前 800 字只读上下文与单元计数", () => {
    const { units } = partitionSpanIntoUnits(span, 9_000);
    const last = units[units.length - 1]!;
    const context = buildUnitEditContext(span, last, units);
    expect(context.unitCount).toBe(units.length);
    expect(context.before.length).toBeLessThanOrEqual(800);
    expect(context.after).toBe(""); // 最后一个单元之后是章节末尾
  });
});

describe("M14.1a resolveUnitByQuotes（原文锚点定位；无词法猜测）", () => {
  const heading = String.raw`\section{Method}` + "\n";
  const body = chapterBody(20_000);
  const spans = locateLatexSections("sections/method.tex", heading + body);
  const span = spans[0]!;
  const { units } = partitionSpanIntoUnits(span, 9_000);

  it("末尾单元中的唯一锚点命中该单元（不再受 12k 截断影响）", () => {
    const last = units[units.length - 1]!;
    const anchor = last.content.slice(Math.floor(last.content.length / 2), Math.floor(last.content.length / 2) + 60);
    const resolution = resolveUnitByQuotes(span, units, [anchor]);
    expect(resolution.unit?.logicalSection).toBe(last.logicalSection);
    expect(resolution.matchedBy).toBe("quote");
  });

  it("跨相邻单元的锚点合并两个单元为一个编辑目标", () => {
    const first = units[0]!;
    const second = units[1]!;
    const anchor = first.content.slice(-80) + "\n\n" + second.content.slice(0, 80);
    const resolution = resolveUnitByQuotes(span, units, [anchor]);
    expect(resolution.unit).toBeDefined();
    expect(resolution.unit!.start).toBe(first.start);
    expect(resolution.unit!.end).toBe(second.end);
    expect(baseSpanId(resolution.unit!.logicalSection)).toBe(span.logicalSection);
  });

  it("出现在两个单元的锚点 = 歧义（ANCHOR_AMBIGUOUS，不猜）", () => {
    const common = "Paragraph 3: para analysis of the proposed method with citation.";
    const dupBody = (common + "\n\nMiddle text.\n\n" + common + "\n\n" + chapterBody(400)).repeat(1);
    const dupSpan = locateLatexSections("g.tex", heading + dupBody)[0]!;
    const dupUnits = partitionSpanIntoUnits(dupSpan, 400).units;
    const resolution = resolveUnitByQuotes(dupSpan, dupUnits, [common]);
    expect(resolution.unit).toBeUndefined();
    expect(resolution.reason).toBe("ANCHOR_AMBIGUOUS");
  });

  it("无锚点 / 锚点不存在 → NO_ANCHOR / ANCHOR_NOT_FOUND", () => {
    expect(resolveUnitByQuotes(span, units, []).reason).toBe("NO_ANCHOR");
    expect(resolveUnitByQuotes(span, units, ["this sentence never exists in the chapter body at all"]).reason).toBe("ANCHOR_NOT_FOUND");
  });
});

describe("M14.1a relocateRevisionSpan（stale 拒绝与兄弟偏移容忍）", () => {
  const heading = String.raw`\section{Method}` + "\n";
  const source = heading + chapterBody(20_000);
  const span = locateLatexSections("sections/method.tex", source)[0]!;
  const { units } = partitionSpanIntoUnits(span, 9_000);
  const target = units[units.length - 1]!;

  it("兄弟单元先行修改（前方插入）后，未触及单元按内容重定位到新偏移", () => {
    const mutated = units[0]!.content.replace("Paragraph 1:", "Paragraph 1 (revised):") + units[1]!.content + target.content;
    const relocated = relocateRevisionSpan("sections/method.tex", mutated, target);
    expect(relocated).toBeDefined();
    expect(relocated!.originalHash).toBe(target.originalHash);
    expect(relocated!.end).toBe(mutated.length);
  });

  it("单元自身内容变化 → undefined（stale，不得套用旧 patch）", () => {
    const mutated = source.replace(target.content.slice(0, 60), "mutated prefix that changed the unit");
    expect(relocateRevisionSpan("sections/method.tex", mutated, target)).toBeUndefined();
  });

  it("章节标题被改名 → 基 span 不可定位 → undefined", () => {
    const renamed = source.replace(String.raw`\section{Method}`, String.raw`\section{Approach}`);
    expect(relocateRevisionSpan("sections/method.tex", renamed, target)).toBeUndefined();
  });
});

describe("M14.1a mergeAdjacentUnits / locateFileSpans", () => {
  it("合并区间与内容一致", () => {
    const tex = String.raw`\section{A}` + "\n" + chapterBody(20_000);
    const span = locateLatexSections("a.tex", tex)[0]!;
    const { units } = partitionSpanIntoUnits(span, 9_000);
    const merged = mergeAdjacentUnits(units, 0, 1);
    expect(merged.content).toBe(units[0]!.content + units[1]!.content);
    expect(merged.start).toBe(units[0]!.start);
    expect(merged.end).toBe(units[1]!.end);
  });

  it("无标题文件退化为整文件 span", () => {
    const spans = locateFileSpans("plain.tex", "No headings here.\n\nJust body.");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.content).toBe("No headings here.\n\nJust body.");
  });
});
