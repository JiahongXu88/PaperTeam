import type { EvidenceRecord } from "../evidence/EvidenceStore.js";

/** Run-local transport aliases for planner references. Canonical IDs stay in storage. */
export interface PlannerAlias<T> {
  ref: string;
  canonicalId: string;
  value: T;
}

export function buildPlannerAliases<T>(items: readonly T[], prefix: "C" | "EV", idOf: (item: T) => string): PlannerAlias<T>[] {
  return items.map((value, index) => ({ ref: `${prefix}${index + 1}`, canonicalId: idOf(value), value }));
}

export function resolvePlannerRefs(refs: readonly string[], aliases: readonly { ref: string; canonicalId: string }[], prefix: "C" | "EV"): string[] {
  const byRef = new Map(aliases.map((alias) => [alias.ref.toUpperCase(), alias.canonicalId]));
  const resolved: string[] = [];
  for (const raw of refs) {
    if (typeof raw !== "string" || !new RegExp(`^${prefix}\\d+$`, "i").test(raw.trim())) {
      throw new Error(`INVALID_${prefix === "C" ? "COMMENT" : "EVIDENCE"}_ALIAS:${String(raw)}`);
    }
    const id = byRef.get(raw.trim().toUpperCase());
    if (id === undefined) throw new Error(`INVALID_${prefix === "C" ? "COMMENT" : "EVIDENCE"}_ALIAS:${raw}`);
    if (!resolved.includes(id)) resolved.push(id);
  }
  return resolved;
}

/** Planner may select only verified, non-superseded Evidence records. */
export function plannerEligibleEvidence(records: readonly EvidenceRecord[], limit = 30): EvidenceRecord[] {
  return records.filter((record) => record.verificationStatus === "verified" && record.protocolScope?.status !== "superseded").slice(0, limit);
}
