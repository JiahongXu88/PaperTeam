/**
 * M14.7：摘要快照绑定（Abstract Snapshot Binding）。
 *
 * 问题（M14.6 遗留 §17.4）：正文经 Revision 后，最终 Draft 可能仍保留写作完成时的
 * 摘要——没有任何结构化记录能回答「这份摘要对应哪一版正文 / 哪一组科研事实」，
 * 也无法在事后判定摘要是否过期。
 *
 * 方案：摘要产物（research/thesis-abstract.json）在**写入 thesis.json 成功**时记录
 * 快照绑定（当前修订号 + 三个内容指纹），质量 Gate 用确定性重算比较判定新鲜度：
 *   - manuscriptFingerprint：manuscript/sections/*.tex 逐字节指纹（摘要概括的正文）；
 *   - confirmedFactFingerprint：已确认事实集合（factId + surface）指纹；
 *   - authorDecisionFingerprint：作者决定状态指纹（受限口径章等摘要输入）。
 *
 * 判定语义（任务 §5）：
 *   - 不一致 → ABSTRACT_STALE（Gate 规则 thesis_abstract_snapshot_current FAIL；
 *     Draft 仍可构建预览，但不得视为「摘要同步 / 结构完整」）；
 *   - 一致 → current（可以证明正文未变化时不重复生成）；
 *   - 摘要存在但绑定缺失（历史产物）→ 视为 stale（无法证明一致就不宣称一致）。
 *
 * 修订号只作元数据：RevisionStore.commit 是指纹幂等的（正文未变不产生新修订号），
 * 且 thesis.json 本身位于工作树内——用修订号判定新鲜度会把「无实质变化」误判为
 * 过期；内容指纹才是权威口径。
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { sha256Hex } from "../util/hash.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { AuthorDecision, FactView } from "./researchInputTypes.js";

export interface AbstractSnapshotBinding {
  schemaVersion: 1;
  /** 摘要生成（并写入 thesis.json）时的修订号（元数据；不参与新鲜度判定，见文件头） */
  revision: number;
  /** manuscript/sections/*.tex 内容指纹（排序后的 文件名\0内容 串接哈希） */
  manuscriptFingerprint: string;
  /** 已确认事实集合指纹（factId|surface 排序） */
  confirmedFactFingerprint: string;
  /** 作者决定状态指纹（type:decisionId 排序；decisionId 已是 payload 指纹） */
  authorDecisionFingerprint: string;
  generatedAt: string;
}

/** 摘要新鲜度比较所需的当前态（Gate 侧现场重算） */
export interface AbstractSnapshotCurrentState {
  revision: number;
  manuscriptFingerprint: string;
  confirmedFactFingerprint: string;
  authorDecisionFingerprint: string;
}

export interface AbstractSnapshotFreshness {
  current: boolean;
  detail: string;
}

/**
 * 正文节文件指纹。文件缺失按 `<missing>` 计入（确定性——缺文件本身是可检测的状态
 * 变化，不抛错中断 Gate；写作期缺节由 writing.sections 的 DoD 负责）。
 */
export async function computeManuscriptSectionsFingerprint(
  projects: ProjectStore,
  projectId: string,
  files: readonly string[],
): Promise<string> {
  const sectionsDir = join(projects.manuscriptDir(projectId), "sections");
  const hash = createHash("sha256");
  hash.update(`paperteam-abstract-snapshot-v1:${projectId}`);
  for (const file of [...files].sort()) {
    let content: string;
    try {
      content = await readFile(join(sectionsDir, file), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        hash.update(`\n${file}\0<missing>`);
        continue;
      }
      throw error;
    }
    hash.update(`\n${file}\0`);
    hash.update(content);
  }
  return hash.digest("hex");
}

export function computeConfirmedFactFingerprint(facts: readonly FactView[]): string {
  return sha256Hex(
    facts.map((fact) => `${fact.factId}|${fact.surface}`).sort().join("\n"),
  );
}

export function computeAuthorDecisionFingerprint(decisions: readonly AuthorDecision[]): string {
  return sha256Hex(
    decisions.map((decision) => `${decision.type}:${decision.decisionId}`).sort().join("\n"),
  );
}

/** 绑定 vs 当前态的确定性比较（绑定缺失 = 无法证明一致 → stale） */
export function compareAbstractSnapshot(
  bound: AbstractSnapshotBinding | undefined,
  current: AbstractSnapshotCurrentState,
): AbstractSnapshotFreshness {
  if (bound === undefined) {
    return {
      current: false,
      detail:
        "ABSTRACT_STALE：摘要缺少快照绑定（历史产物 / 生成未成功写入），无法证明与当前正文一致——本 Draft 摘要不得视为已同步",
    };
  }
  const diffs: string[] = [];
  if (bound.manuscriptFingerprint !== current.manuscriptFingerprint) diffs.push("正文已变化");
  if (bound.confirmedFactFingerprint !== current.confirmedFactFingerprint) diffs.push("已确认事实集合已变化");
  if (bound.authorDecisionFingerprint !== current.authorDecisionFingerprint) diffs.push("作者决定状态已变化");
  return diffs.length === 0
    ? {
        current: true,
        detail: `摘要绑定当前快照（生成于 rev-${bound.revision} @ ${bound.generatedAt}；正文 / 事实 / 决定指纹一致）`,
      }
    : {
        current: false,
        detail: `ABSTRACT_STALE：摘要生成后${diffs.join("、")}（绑定 rev-${bound.revision} @ ${bound.generatedAt}）——本 Draft 摘要与最终正文不一致，不得视为摘要同步`,
      };
}
