/**
 * DiagramSpec → TikZ TeX 确定性 codegen（M12.3 C2）。
 *
 * 设计纪律：
 *
 * 1. 布局全部在 TypeScript 侧确定性计算（分层 + 定间距），输出绝对坐标的
 *    \node at (x,y)——不使用 TikZ 自动布局（automatic placement 对同 spec
 *    理论上确定，但依赖 TeX 版本的盒子测量；TS 侧计算是字节级确定性的
 *    强保证）。分层算法：主流水线节点按「最长路径层号」（Kahn 拓扑序上
 *    取 max(前驱层)+1，无入边为 0），层内顺序 = spec 声明序。
 *
 * 2. 两个模板 = 布局变体（M12.0 §12 冻结），没有通用矢量图形语言、没有
 *    任意 TikZ 逃生舱：
 *    - pipeline：主流水线沿 layout 方向逐层排布（vertical 上→下 /
 *      horizontal 左→右），annotation 节点挂在它连接的主流水线节点旁
 *      （跨轴偏移，多个注释沿主轴堆叠）；
 *    - comparison：left/right 两组各成一列（horizontal 左右两列 /
 *      vertical 上下两行），组内顺序 = spec 声明序。
 *
 * 3. 间距常量固定（mm，见下方常量）——同 spec 同坐标，输出字节稳定。
 *
 * 4. 注入安全：节点 label 经 escapeLatexMultiline（受控换行：spec 中的 LF
 *    → TikZ 行分隔符 + align=center 样式；用户无法自行构造行分隔符——其
 *    输入中的反斜杠已被转义为 textbackslash 文本形态）；边标签 / group
 *    标签 / 标题经 escapeLatex。node id 是 schema 层白名单 slug，直接用作
 *    TikZ node 名，不可能构成 TeX 语法。
 *
 * 5. 输出顺序固定：样式块 → 节点（主流水线 spec 序 → 注释 spec 序 /
 *    comparison：left 序 → right 序）→ 边（spec 序）→ group 背景框
 *    （spec 序，on background layer + fit）→ 标题。
 */

import { escapeLatex, escapeLatexMultiline } from "./latexEscape.js";
import { formatNumber } from "./pgfplotsCodeGen.js";
import type { NormalizedDiagramSpec } from "./spec.js";

// ---- 间距常量（mm；全部为整数或半整数，坐标经 formatNumber 输出定点） ----

const LAYER_PITCH_MM = 18;
const IN_LAYER_PITCH_MM = 45;
const ANNOTATION_OFFSET_MM = 55;
const ANNOTATION_STACK_MM = 12;
const COMPARISON_GAP_MM = 60;
const TITLE_OFFSET_MM = 8;

/** tikzpicture 样式块（clean academic default；样式行序固定） */
const STYLE_LINES: readonly string[] = [
  "  stage/.style={rectangle, draw, thick, rounded corners=2pt, align=center, font=\\small, minimum height=9mm, minimum width=24mm, fill=black!4},",
  "  annotation/.style={rectangle, draw=black!60, dashed, align=center, font=\\footnotesize\\itshape, text=black!75, inner sep=2pt},",
  "  leftbox/.style={rectangle, draw, thick, rounded corners=2pt, align=center, font=\\small, minimum height=9mm, minimum width=24mm, fill=black!8},",
  "  rightbox/.style={rectangle, draw, thick, rounded corners=2pt, align=center, font=\\small, minimum height=9mm, minimum width=24mm, fill=black!16},",
  "  arr/.style={-{Stealth[length=2.4mm]}, thick},",
  "  annotarr/.style={-{Stealth[length=2mm]}, thin, dashed, black!60},",
  "  grplab/.style={font=\\footnotesize\\bfseries, text=black!60},",
  "  figtitle/.style={font=\\normalsize\\bfseries},",
  "  edge label/.style={font=\\footnotesize, fill=white, inner sep=1pt},",
  "  grpbox/.style={rectangle, rounded corners=3pt, draw=black!50, dashed, inner sep=5mm}",
];

/** 布局产物：node id → 绝对坐标（mm）与样式名 */
interface NodeBox {
  id: string;
  label: string;
  x: number;
  y: number;
  style: "stage" | "annotation" | "leftbox" | "rightbox";
}

/** pipeline 布局：最长路径分层（仅 stage↔stage 边参与；annotation 挂靠连接对象） */
function layoutPipeline(spec: NormalizedDiagramSpec): NodeBox[] {
  const vertical = spec.layout === "vertical";
  const stageNodes = spec.nodes.filter((node) => node.role === "stage");
  const annotationNodes = spec.nodes.filter((node) => node.role === "annotation");
  const stageIds = new Set(stageNodes.map((node) => node.id));

  const preds = new Map<string, string[]>([...stageIds].map((id) => [id, [] as string[]] as const));
  const succs = new Map<string, string[]>([...stageIds].map((id) => [id, [] as string[]] as const));
  for (const edge of spec.edges) {
    if (stageIds.has(edge.from) && stageIds.has(edge.to)) {
      succs.get(edge.from)?.push(edge.to);
      preds.get(edge.to)?.push(edge.from);
    }
  }

  // Kahn 拓扑序（初始队列与入队序都来自 spec 声明序——确定性）；层号 = 最长路径
  const indegree = new Map<string, number>(
    [...stageIds].map((id) => [id, preds.get(id)?.length ?? 0] as const),
  );
  const queue = stageNodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id);
  const layer = new Map<string, number>();
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) {
      break;
    }
    order.push(id);
    const predecessorLayers = (preds.get(id) ?? []).map((p) => (layer.get(p) ?? 0) + 1);
    layer.set(id, predecessorLayers.length === 0 ? 0 : Math.max(...predecessorLayers));
    for (const next of succs.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) {
        queue.push(next);
      }
    }
  }
  // 校验层已拒绝环；防御性断言（拓扑序未覆盖全部节点 = 环漏网）
  if (order.length !== stageNodes.length) {
    throw new Error("layoutPipeline：分层未覆盖全部主流水线节点（环应被校验层拒绝）");
  }

  // 分层分组（层号升序；层内 spec 声明序）→ 绝对坐标
  const layers: string[][] = [];
  for (const id of order) {
    const nodeLayer = layer.get(id) ?? 0;
    const bucket = layers[nodeLayer] ?? (layers[nodeLayer] = []);
    bucket.push(id);
  }
  const position = new Map<string, { x: number; y: number }>();
  layers.forEach((ids, layerIndex) => {
    ids.forEach((id, indexInLayer) => {
      const count = ids.length;
      if (vertical) {
        position.set(id, {
          x: (indexInLayer - (count - 1) / 2) * IN_LAYER_PITCH_MM,
          y: -layerIndex * LAYER_PITCH_MM,
        });
      } else {
        position.set(id, {
          x: layerIndex * IN_LAYER_PITCH_MM,
          y: ((count - 1) / 2 - indexInLayer) * LAYER_PITCH_MM,
        });
      }
    });
  });

  const boxes: NodeBox[] = stageNodes.map((node) => {
    const pos = position.get(node.id) ?? { x: 0, y: 0 };
    return { id: node.id, label: node.label, x: pos.x, y: pos.y, style: "stage" as const };
  });

  // annotation：挂在第一条相关边的主流水线节点旁；同对象多注释沿主轴堆叠
  const stackCount = new Map<string, number>();
  for (const node of annotationNodes) {
    const edge = spec.edges.find((candidate) => candidate.from === node.id || candidate.to === node.id);
    const partnerId = edge === undefined ? undefined : edge.from === node.id ? edge.to : edge.from;
    const partner = partnerId === undefined ? undefined : position.get(partnerId);
    if (partner === undefined) {
      // 校验层已保证 annotation 有边且不连 annotation——到达这里即契约破坏
      throw new Error(`layoutPipeline：annotation ${node.id} 没有布局锚点（校验层应已拒绝）`);
    }
    const stack = stackCount.get(partnerId ?? "") ?? 0;
    stackCount.set(partnerId ?? "", stack + 1);
    boxes.push({
      id: node.id,
      label: node.label,
      x: vertical ? partner.x + ANNOTATION_OFFSET_MM : partner.x + stack * ANNOTATION_STACK_MM,
      y: vertical ? partner.y - stack * ANNOTATION_STACK_MM : partner.y - ANNOTATION_OFFSET_MM,
      style: "annotation",
    });
  }
  return boxes;
}

/** comparison 布局：left/right 两组各成一列（horizontal）/一行（vertical） */
function layoutComparison(spec: NormalizedDiagramSpec): NodeBox[] {
  const horizontal = spec.layout === "horizontal";
  const leftNodes = spec.nodes.filter((node) => node.role === "left");
  const rightNodes = spec.nodes.filter((node) => node.role === "right");
  const boxes: NodeBox[] = [];
  const place = (
    nodes: readonly NormalizedDiagramSpec["nodes"][number][],
    main: number,
    style: "leftbox" | "rightbox",
  ): void => {
    nodes.forEach((node, index) => {
      const count = nodes.length;
      boxes.push({
        id: node.id,
        label: node.label,
        x: horizontal ? main : (index - (count - 1) / 2) * IN_LAYER_PITCH_MM,
        y: horizontal ? ((count - 1) / 2 - index) * LAYER_PITCH_MM : main,
        style,
      });
    });
  };
  place(leftNodes, 0, "leftbox");
  place(rightNodes, horizontal ? COMPARISON_GAP_MM : -COMPARISON_GAP_MM, "rightbox");
  return boxes;
}

/** mm 坐标 → 定点字符串（如 "22.5mm"；formatNumber 保证无科学计数/尾零漂移） */
function mm(value: number): string {
  return `${formatNumber(value)}mm`;
}

/** DiagramSpec → 独立编译的 standalone TeX 文档（字节确定性） */
export function renderDiagramTeX(spec: NormalizedDiagramSpec): string {
  const boxes = spec.variant === "comparison" ? layoutComparison(spec) : layoutPipeline(spec);
  const vertical = spec.layout === "vertical";

  const lines: string[] = [
    "\\documentclass[border=2pt]{standalone}",
    "\\usepackage{tikz}",
    "\\usetikzlibrary{positioning,arrows.meta,fit,backgrounds}",
    "\\begin{document}",
    "\\begin{tikzpicture}[",
    ...STYLE_LINES,
    "]",
  ];

  // ---- 节点（布局序：主流水线/left → 注释/right；label 受控多行） ----
  for (const box of boxes) {
    lines.push(`\\node[${box.style}] (${box.id}) at (${mm(box.x)},${mm(box.y)}) {${escapeLatexMultiline(box.label)}};`);
  }

  // ---- 边（spec 序；annotation 相关边用虚线细箭头；标签位置由布局方向决定） ----
  const roleById = new Map(spec.nodes.map((node) => [node.id, node.role] as const));
  const labelPos = vertical ? "right=1mm" : "above=1mm";
  for (const edge of spec.edges) {
    const fromRole = roleById.get(edge.from);
    const toRole = roleById.get(edge.to);
    const style = fromRole === "annotation" || toRole === "annotation" ? "annotarr" : "arr";
    const label =
      edge.label === undefined
        ? ""
        : ` node[midway, ${labelPos}, edge label] {${escapeLatex(edge.label)}}`;
    lines.push(`\\draw[${style}] (${edge.from}) -- (${edge.to})${label};`);
  }

  // ---- group 背景框（spec 序；fit 成员 = spec 声明序） ----
  if (spec.groups.length > 0) {
    lines.push("\\begin{scope}[on background layer]");
    for (const group of spec.groups) {
      const members = spec.nodes.filter((node) => node.group === group.id);
      const fitList = members.map((node) => `(${node.id})`).join("");
      lines.push(`\\node[grpbox, fit=${fitList}] (${group.id}) {};`);
      if (group.label !== undefined) {
        lines.push(
          `\\node[grplab, anchor=south west] at ([xshift=2mm,yshift=2mm]${group.id}.north west) {${escapeLatex(group.label)}};`,
        );
      }
    }
    lines.push("\\end{scope}");
  }

  // ---- 标题（布局包围盒上方居中；坐标由 TS 侧计算，确定性） ----
  if (spec.title !== undefined) {
    const xCenter =
      (Math.min(...boxes.map((box) => box.x)) + Math.max(...boxes.map((box) => box.x))) / 2;
    const yTop = Math.max(...boxes.map((box) => box.y));
    lines.push(
      `\\node[figtitle, anchor=south] at (${mm(xCenter)},${mm(yTop + TITLE_OFFSET_MM)}) {${escapeLatex(spec.title)}};`,
    );
  }

  lines.push("\\end{tikzpicture}", "\\end{document}");
  return `${lines.join("\n")}\n`;
}
