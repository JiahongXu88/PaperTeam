/**
 * Claude-Compatible Evaluation Dataset（M6.9.2.1）。
 *
 * 背景：M6.8 frozen dataset 的防记忆噪声 token（filler 生成的 `fqj0` 式
 * 随机串）被公司 Claude Gateway 的 Claude 通道专属 safety filter 判定为
 * 序列/编码数据（stop_reason=refusal, category=bio），导致 M6.9.2 Arm B
 * （语料全文进 prompt）全部场景确定性被拦；同一网关的 GLM 通道同内容
 * 正常（证据见 evaluation/reports/live-claude-exp1.json 的 errors）。
 *
 * 修复原则（M6.9.2.1 任务纪律——只做 dataset compatibility）：
 * - frozen dataset 是唯一事实源：本模块不复制数据，import 后做纯确定性
 *   变换——只替换 corpus content 中的 filler token，其余一切（claim /
 *   evidence / citation 结构 / fault 注入 / 元数据）逐字段不变；
 * - 嵌入 frozen scenario 的 SHA-256 快照：frozen 被意外改动时校验失败，
 *   防止 claude-compatible 变体随之静默漂移（要改动 frozen 须先确认，
 *   再重算本文件快照表）；
 * - 替换 token（`random-term-<n>`，项目统一定义的 synthetic marker）
 *   满足：无语义、不接近 DNA/protein 序列、不接近编码串、不对应真实
 *   实体，且场景内唯一（保留防记忆效果）。
 *
 * 安全性有两层证据：(a) 本模块的确定性 pattern 校验（不引入任何新的
 * 字母数字紧凑混排串 / 核苷酸样串 / hex 样串）；(b) 网关实测探针
 * （见 M6.9.2.1 报告）。
 */

import { createHash } from "node:crypto";

import type { GroundingScenario } from "../types.js";
import { GROUNDING_SCENARIOS } from "./groundingScenarios.js";
import { validateGroundingScenario, type ScenarioValidationIssue } from "./index.js";

/**
 * M6.8 filler token 语法：`f` + base36(LCG state % 997，1-2 位) + 句内
 * 序号 i%13（1-2 位十进制）。大小写敏感——语料真实术语（MOT17 / F1 /
 * MOTA 等）不含小写 f 起头的字母数字混排 token，不受影响（已对全部
 * frozen 语料扫描验证：命中 984 token 全部为 filler，零误报）。
 * 纪律：只对本正则用 .match / .replace（/g 有 lastIndex 状态，禁用 .test）。
 */
const FROZEN_FILLER_TOKEN = /\bf[0-9a-z]{1,2}[0-9]{1,2}\b/g;

/** 项目统一定义的 synthetic marker：word-form、无语义、场景内唯一 */
const NOISE_MARKER = /\brandom-term-\d+\b/g;

function fillerCount(content: string): number {
  return (content.match(FROZEN_FILLER_TOKEN) ?? []).length;
}

function markerCount(content: string): number {
  return (content.match(NOISE_MARKER) ?? []).length;
}

/** 去除两种噪声 token 后的正文骨架（两者必须逐字一致 = 内容只差 noise token） */
function contentSkeleton(content: string): string {
  return content
    .replace(FROZEN_FILLER_TOKEN, " ")
    .replace(NOISE_MARKER, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================================
// 派生（纯函数，确定性：同 frozen 输入恒同输出）
// ============================================================

function substituteNoiseTokens(content: string, counter: { next: number }): string {
  return content.replace(FROZEN_FILLER_TOKEN, () => `random-term-${counter.next++}`);
}

function toClaudeCompatibleScenario(scenario: GroundingScenario): GroundingScenario {
  // 计数器按 scenario 全局递增 → 场景内 marker 唯一（防记忆效果）
  const counter = { next: 0 };
  return {
    ...scenario,
    corpus: scenario.corpus.map((source) => ({ ...source, content: substituteNoiseTokens(source.content, counter) })),
  };
}

/**
 * 从任意 frozen 输入派生 claude-compatible 副本（测试与快照重算共用）。
 * 场景间计数器独立重置（场景在各自独立的评估命名空间内运行）。
 */
export function deriveClaudeCompatibleScenarios(frozen: readonly GroundingScenario[]): GroundingScenario[] {
  return frozen.map(toClaudeCompatibleScenario);
}

export const GROUNDING_SCENARIOS_CLAUDE: readonly GroundingScenario[] = deriveClaudeCompatibleScenarios(
  GROUNDING_SCENARIOS,
);

// ============================================================
 // frozen 快照守卫
// ============================================================

/**
 * frozen grounding scenario 的 SHA-256 快照（canonical JSON = 模块字面量
 * 键序；M6.9.2.1 建档时计算）。运行期重算不一致 = frozen dataset 被改动
 * ——校验失败并拒绝评估，防止 compatible 变体静默漂移。要合法修改 frozen
 * 需同步重算本表（scripts 见测试注释）。
 */
const FROZEN_SCENARIO_SHA256: readonly string[] = [
  "c08918f29e70bfd8935cbc7b54be90547c98eca5443a27df9a467f56fdb9e953", // g1-rag-survey
  "80dbd93305933b7d789cf944f42c98a07d795768d9b6e70bdca597ae05018436", // g2-mot-zh
  "11a11e5e37ccf4220f645094a96eff46d618be36b8fc5a9d4257dfad62134bf5", // g3-gnn-citation
  "881a50dab5a9da5bb2ba6692c1fccf919d82cbb0cf710c9446347da82177d211", // g4-tts
  "55229502abf80e53ad7e844dd5ce9972ed064c00e19f0e5cf9c3c9760ba448f9", // g5-ppo
  "69960040d5d0645baccb8b4b2bd45dc64e5283e5e8ef0c951232bdc62b8b4da9", // g6-sentiment-zh
];

function scenarioSha256(scenario: GroundingScenario): string {
  return createHash("sha256").update(JSON.stringify(scenario), "utf8").digest("hex");
}

// ============================================================
// 安全模式（bio / 编码串启发式；与 frozen 差集判定——真实术语如 MOT17
// / F1 在 frozen 中本就存在，不算新增风险）
// ============================================================

/** ASCII 字母数字连续段中「同时含字母与数字」的紧凑混排串（fqj0 / 编码样） */
function compactMixedRuns(content: string): string[] {
  return (content.match(/[a-z0-9]+/gi) ?? []).filter((run) => /[0-9]/.test(run) && /[a-z]/i.test(run));
}

/** 核苷酸字母表（A/C/G/T/U/N）长度 ≥5 的连续段 */
function nucleotideLikeRuns(content: string): string[] {
  return (content.match(/[acgtun]+/gi) ?? []).filter((run) => run.length >= 5);
}

/** hex/base64 样长度 ≥16 的连续段 */
function hexLikeRuns(content: string): string[] {
  return (content.match(/[a-f0-9]+/gi) ?? []).filter((run) => run.length >= 16);
}

const UNSAFE_FAMILIES: ReadonlyArray<{ label: string; extract: (content: string) => string[] }> = [
  { label: "字母数字紧凑混排", extract: compactMixedRuns },
  { label: "核苷酸样串", extract: nucleotideLikeRuns },
  { label: "hex/base64 样串", extract: hexLikeRuns },
];

// ============================================================
// 校验（确定性、零 IO；失败 = 拒绝跑 claude-compatible 评估）
// ============================================================

function corpusMetadata(source: {
  fileName: string;
  title: string;
  year: number;
  authors?: string[];
  metadataCorrupted?: boolean;
  authoritativeYear?: number;
}): string {
  return JSON.stringify({
    fileName: source.fileName,
    title: source.title,
    year: source.year,
    authors: source.authors,
    metadataCorrupted: source.metadataCorrupted,
    authoritativeYear: source.authoritativeYear,
  });
}

/**
 * claude-compatible 数据集全量校验：
 * 1. frozen 快照（原始 frozen dataset 未被修改的运行期证明）；
 * 2. 结构一致（claim / evidence / citation / fault 注入只允许 noise token 变化）；
 * 3. corpus content 去噪骨架逐字一致 + filler 全替换 + marker 形态与场景内唯一；
 * 4. 安全模式：相对 frozen 不新增任何 bio / 编码样串；
 * 5. 复用 M6.8 validateGroundingScenario（needle 逐字、故障标注一致等）。
 *
 * options.frozenScenarios 仅供测试注入篡改样本；缺省用真实 frozen 数据集。
 */
export function validateClaudeCompatibleDataset(
  options: { frozenScenarios?: readonly GroundingScenario[] } = {},
): ScenarioValidationIssue[] {
  const frozen = options.frozenScenarios ?? GROUNDING_SCENARIOS;
  const compatible = GROUNDING_SCENARIOS_CLAUDE;
  const issues: ScenarioValidationIssue[] = [];
  const push = (scenarioId: string, problem: string) => issues.push({ scenarioId, problem });

  if (frozen.length !== compatible.length) {
    push("(dataset)", `场景数量不一致：frozen=${frozen.length} compatible=${compatible.length}`);
    return issues;
  }

  for (const [index, frozenScenario] of frozen.entries()) {
    const compatibleScenario = compatible[index]!;
    const id = frozenScenario.id;

    // 1. frozen 快照守卫
    const digest = scenarioSha256(frozenScenario);
    if (FROZEN_SCENARIO_SHA256[index] !== digest) {
      push(
        id,
        `frozen scenario SHA-256 快照不匹配（建档=${FROZEN_SCENARIO_SHA256[index]?.slice(0, 12)}… 实测=${digest.slice(0, 12)}…）：` +
          "frozen dataset 已被改动；确认合法后须重算 claudeCompatible.ts 的快照表并重新校验兼容性",
      );
    }

    // 2. 结构一致（除 corpus content 外逐字段）
    if (
      compatibleScenario.id !== id ||
      compatibleScenario.kind !== frozenScenario.kind ||
      compatibleScenario.title !== frozenScenario.title ||
      compatibleScenario.description !== frozenScenario.description
    ) {
      push(id, "顶层字段（id/kind/title/description）与 frozen 不一致");
    }
    if (JSON.stringify(compatibleScenario.supportable) !== JSON.stringify(frozenScenario.supportable)) {
      push(id, "supportable（claim/locator）与 frozen 不一致：只允许 corpus noise token 变化");
    }
    if (JSON.stringify(compatibleScenario.faults) !== JSON.stringify(frozenScenario.faults)) {
      push(id, "faults（fault 注入 ground truth）与 frozen 不一致：只允许 corpus noise token 变化");
    }

    if (compatibleScenario.corpus.length !== frozenScenario.corpus.length) {
      push(id, "corpus 来源数量不一致");
      continue;
    }

    const frozenContents: string[] = [];
    const compatibleContents: string[] = [];
    const scenarioMarkers: string[] = [];
    for (const [fileIndex, frozenSource] of frozenScenario.corpus.entries()) {
      const compatibleSource = compatibleScenario.corpus[fileIndex]!;
      if (corpusMetadata(compatibleSource) !== corpusMetadata(frozenSource)) {
        push(id, `corpus[${fileIndex}] 元数据与 frozen 不一致：${frozenSource.fileName}`);
      }

      // 3. content 只差 noise token
      if (contentSkeleton(compatibleSource.content) !== contentSkeleton(frozenSource.content)) {
        push(
          id,
          `corpus[${fileIndex}] 去噪骨架与 frozen 不一致（除 noise token 外内容必须逐字相同）：${frozenSource.fileName}`,
        );
      }
      const expected = fillerCount(frozenSource.content);
      const actual = markerCount(compatibleSource.content);
      if (actual !== expected) {
        push(id, `corpus[${fileIndex}] filler→marker 替换数不匹配（frozen filler=${expected}，marker=${actual}）：${frozenSource.fileName}`);
      }
      if (expected === 0) {
        push(id, `corpus[${fileIndex}] frozen 语料不含任何 filler token（结构异常，应人工核对）：${frozenSource.fileName}`);
      }
      const residualFiller = fillerCount(compatibleSource.content);
      if (residualFiller > 0) {
        push(id, `corpus[${fileIndex}] 兼容语料残留 ${residualFiller} 个 filler 式 token（会再次触发 Claude 通道 bio 过滤）：${frozenSource.fileName}`);
      }
      scenarioMarkers.push(...(compatibleSource.content.match(NOISE_MARKER) ?? []));

      frozenContents.push(frozenSource.content);
      compatibleContents.push(compatibleSource.content);
    }
    if (new Set(scenarioMarkers).size !== scenarioMarkers.length) {
      push(id, "marker 场景内不唯一（防记忆效果要求唯一）");
    }

    // 4. 安全模式：差集必须为空（真实术语 MOT17/F1 等两侧同在，不算新增）
    const frozenContent = frozenContents.join("\n");
    const compatibleContent = compatibleContents.join("\n");
    for (const family of UNSAFE_FAMILIES) {
      const frozenRuns = new Set(family.extract(frozenContent));
      const added = family.extract(compatibleContent).filter((run) => !frozenRuns.has(run));
      if (added.length > 0) {
        push(id, `兼容语料新增 ${family.label}（bio/编码过滤风险）：${added.slice(0, 5).join(" ")}`);
      }
    }

    // 5. M6.8 结构校验复用（needle 逐字存在、故障标注一致、正例不锚损坏元数据…）
    issues.push(...validateGroundingScenario(compatibleScenario));
  }
  return issues;
}
