import type { SourceItem } from "../sources/SourceStore.js";

/** Prefer local sources aligned with an intent and its named current protocol. */
export function selectReviewerSourceIds(comment: string, sources: readonly SourceItem[]): string[] {
  const intent = comment.toLowerCase();
  const names = (source: SourceItem) => `${source.fileName ?? ""} ${source.metadata.title ?? ""}`.toLowerCase();
  if (/rdk\s*x3|deployment performance|部署性能|板端/.test(intent)) {
    return sources.filter((source) => /rdk[_ -]?x3|board_c0_20260904/.test(names(source))).map((source) => source.sourceId);
  }
  if (/ablation|extreme scene|low.light|high.density|消融|极端场景|低照度|高密度/.test(intent)) {
    // Historical COCO-pretrained sources remain in the library but are excluded
    // from grounding a current-protocol request.
    return sources.filter((source) => /fair[_ -]?ablation[_ -]?new[_ -]?detector|fair[_ -]?ablation/.test(names(source))).map((source) => source.sourceId);
  }
  return sources.map((source) => source.sourceId);
}
