import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkCitations, parseBib } from "../../src/citation/StaticCitationChecker.js";
import { collectLatexFiles } from "../../src/manuscript/LatexFiles.js";
import { extractInlineBibliography, renderInlineBibliographyAsBib } from "../../src/manuscript/inlineBibliography.js";

/**
 * M14.8-MOT：GB/T 7714 内联 thebibliography 稿件（中文期刊常见，无 .bib）。
 * 真实论文暴露：collectLatexFiles 只认 \bibliography{}，导致每个 \cite 都是
 * missingKey、元数据核验零条目、Writer 允许引用 key 为空。
 */

const TEX = String.raw`\documentclass{ctexart}
\begin{document}
跟踪基准见 \cite{Wen2020UADETRAC}，中文工作 \cite{Xiong2023Lidar3DMOT, Du2026Turn}。
% \bibitem{Commented2020} 注释里的条目不算
\begin{thebibliography}{99}
\small
\bibitem{Wen2020UADETRAC} Wen L, Du D, Cai Z, et al. UA-DETRAC: A new benchmark and protocol for multi-object detection and tracking[J]. Computer Vision and Image Understanding, 2020, 193: 102907.
\bibitem{Xiong2023Lidar3DMOT} 熊珍凯, 程晓强, 吴幼冬, 等. 基于激光雷达的无人驾驶3D多目标跟踪[J]. 自动化学报, 2023, 49(10): 2073-2083.
\bibitem{Specker2021} Specker A, Stadler D. An occlusion-aware multi-target multi-camera tracking system[C]//Proc of CVPR Workshops. 2021: 4173-4182.
\bibitem[Du et al.]{Du2026Turn} 都双丽, 刘梓扬, 赵明华, 等. 面向车辆转弯场景的轨迹状态更新与关联增强多目标跟踪[J/OL]. 中国图象图形学报, 2026: 1-15 [2026-10-16]. DOI: 10.11834/jig.260001.
\bibitem{Yolo} Jocher G, Qiu J. Ultralytics YOLO11[R/OL]. 2024. \url{https://github.com/ultralytics/ultralytics}.
\bibitem{NoMarker} Some free text without a GB/T type marker.
\end{thebibliography}
\end{document}
`;

let dir = "";
afterEach(async () => {
  if (dir !== "") await rm(dir, { recursive: true, force: true });
  dir = "";
});

describe("extractInlineBibliography", () => {
  it("解析 key、题名、年份、DOI 与文献类型（GB/T 7714）", () => {
    const items = extractInlineBibliography(TEX);
    expect(items.map((item) => item.key)).toEqual(["Wen2020UADETRAC", "Xiong2023Lidar3DMOT", "Specker2021", "Du2026Turn", "Yolo", "NoMarker"]);
    const [wen, xiong, specker, du, yolo, none] = items;
    expect(wen).toMatchObject({ type: "article", year: 2020, title: "UA-DETRAC: A new benchmark and protocol for multi-object detection and tracking" });
    expect(xiong).toMatchObject({ type: "article", year: 2023, title: "基于激光雷达的无人驾驶3D多目标跟踪" });
    expect(specker).toMatchObject({ type: "inproceedings", year: 2021 });
    expect(du).toMatchObject({ year: 2026, doi: "10.11834/jig.260001" });
    expect(yolo?.text).toContain("https://github.com/ultralytics/ultralytics");
    expect(yolo?.text).not.toContain("\\url");
    // 无类型标识：key 仍存在，不臆造题名 / 年份
    expect(none).toMatchObject({ key: "NoMarker", type: "misc" });
    expect(none?.title).toBeUndefined();
    expect(none?.year).toBeUndefined();
  });

  it("渲染的 BibTeX 可被 parseBib 读回（key / 题名 / 年份 / DOI 一致）", () => {
    const parsed = parseBib(renderInlineBibliographyAsBib(extractInlineBibliography(TEX)));
    expect(parsed.malformed).toBe(0);
    expect(parsed.entries.map((entry) => entry.key)).toHaveLength(6);
    expect(parsed.entries.find((entry) => entry.key === "Du2026Turn")).toMatchObject({ year: 2026, doi: "10.11834/jig.260001" });
    expect(parsed.entries.find((entry) => entry.key === "Xiong2023Lidar3DMOT")?.title).toBe("基于激光雷达的无人驾驶3D多目标跟踪");
  });
});

describe("collectLatexFiles + checkCitations：内联参考文献", () => {
  it("无 \\bibliography 时内联 \\bibitem 作为参考文献来源，\\cite 不再全是 missingKey", async () => {
    dir = await mkdtemp(join(tmpdir(), "pt-inline-bib-"));
    await writeFile(join(dir, "main.tex"), TEX, "utf8");
    // 同目录有未被引用的 refs.bib：不应被当成参考文献（未经 \bibliography 引用）
    await writeFile(join(dir, "refs.bib"), "@article{Other, title={x}}", "utf8");
    const files = await collectLatexFiles(dir);
    expect(files.bibSource).toBe("thebibliography");
    expect(files.bibPath).toBeNull();
    const result = checkCitations(files.allTex.map((file) => ({ file: file.relativePath, content: file.content })), files.bibContent);
    expect(result.missingKeys).toEqual([]);
    expect(result.citedKeys).toEqual(["Du2026Turn", "Wen2020UADETRAC", "Xiong2023Lidar3DMOT"]);
    expect(result.unusedKeys).toEqual(["NoMarker", "Specker2021", "Yolo"]);
  });

  it("显式 \\bibliography{refs} 时仍以 .bib 文件为准（bibSource=file）", async () => {
    dir = await mkdtemp(join(tmpdir(), "pt-inline-bib-"));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "main.tex"), String.raw`\documentclass{article}\begin{document}\cite{A}\bibliography{refs}\end{document}`, "utf8");
    await writeFile(join(dir, "refs.bib"), "@article{A, title={Alpha}, year={2020}}", "utf8");
    const files = await collectLatexFiles(dir);
    expect(files.bibSource).toBe("file");
    expect(files.bibPath).toBe("refs.bib");
    expect(checkCitations(files.allTex.map((file) => ({ file: file.relativePath, content: file.content })), files.bibContent).missingKeys).toEqual([]);
  });

  it("既无 .bib 也无内联参考文献：bibSource=null，缺失 key 如实报告", async () => {
    dir = await mkdtemp(join(tmpdir(), "pt-inline-bib-"));
    await writeFile(join(dir, "main.tex"), String.raw`\documentclass{article}\begin{document}\cite{A}\end{document}`, "utf8");
    const files = await collectLatexFiles(dir);
    expect(files.bibSource).toBeNull();
    expect(checkCitations(files.allTex.map((file) => ({ file: file.relativePath, content: file.content })), files.bibContent).missingKeys).toEqual(["A"]);
  });
});
