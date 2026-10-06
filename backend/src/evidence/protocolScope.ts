import type { EvidenceRecord } from "./EvidenceStore.js";

export interface EvidenceProtocolRequirement {
  protocolId: string;
}

/** Recognize only explicit protocol-bearing fixture/source names; never infer from claim wording. */
export function inferExperimentProtocolScope(sourceName: string): EvidenceRecord["protocolScope"] | undefined {
  const normalized = sourceName.toLowerCase().replaceAll("\\", "/").split("/").pop() ?? sourceName.toLowerCase();
  if (/fair[_-]ablation[_-]new[_-]detector/.test(normalized)) {
    return { protocolId: "fair_ablation_new_detector", status: "current" };
  }
  if (/old[_-]coco[_-]pretrained|coco[_-]pretrained[_-]detector/.test(normalized)) {
    return { protocolId: "old_coco_pretrained_detector", status: "superseded" };
  }
  // This report documents the earlier COCO-pretrained detector experiment. The
  // current fair ablation is explicitly the new-detector report below.
  if (/(?:^|-)extreme_scene_experiment_report\.md$/.test(normalized)) {
    return { protocolId: "old_coco_pretrained_detector", status: "superseded" };
  }
  return undefined;
}

/** Fail closed for current-protocol support; unscoped records remain usable for non-experimental claims. */
export function isEvidenceEligibleForProtocol(
  evidence: EvidenceRecord,
  requirement?: EvidenceProtocolRequirement,
): boolean {
  if (requirement === undefined) return true;
  const scope = evidence.protocolScope;
  return scope !== undefined && scope.status === "current" && scope.protocolId === requirement.protocolId;
}

export function filterEvidenceForProtocol<T extends EvidenceRecord>(
  records: readonly T[],
  requirement?: EvidenceProtocolRequirement,
): T[] {
  return records.filter((record) => isEvidenceEligibleForProtocol(record, requirement));
}
