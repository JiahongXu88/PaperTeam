/**
 * M14.9.5 P0：人工 QA 的可审计交接——与源 / 投影 / 被审稿件哈希绑定的输入 QA 证明（零模型、确定性）。
 *
 * 输入保真门对 run-in 小节号、无法逐列定位的表头、上标、私用区字形等只能给 REQUIRES_HUMAN_QA。人工对照原 PDF
 * 逐项核对后，以本证明记录：核对了保真报告中的哪一条疑点（findingKey）、在原文哪一页 / 区域 / 渲染图核对、
 * 结论（与原文一致 / 不一致）、核对人与时间。证明不是自由布尔开关：
 *   - 源证据哈希、投影文本哈希（及被审稿件哈希，若绑定）任一变化 → INVALIDATED（原文或转换文本变了，证明失效）；
 *   - 只能把 REQUIRES_HUMAN_QA 升级为 VALID_FOR_SCORING，且必须逐条覆盖全部人工 QA 疑点并给出原文定位；
 *   - 永远不能覆盖 INVALID_INPUT / SOURCE_INCOMPLETE（硬缺陷只能修投影后重跑保真门）；
 *   - 任一条核对为「不一致」→ 有效状态 INVALID_INPUT（人工确认的保真缺陷）。
 */

import { createHash } from "node:crypto";

import { canon } from "./inputFidelityText.js";
import type { Box, FidelityFinding, FidelityStatus, InputFidelityReport } from "./inputFidelityTypes.js";

export const INPUT_QA_ATTESTATION_SCHEMA = "paperteam.input-qa-attestation/v1";

export interface InputQaAttestationItem {
  /** 保真报告中被核对疑点的稳定键（fidelityFindingKey） */
  findingKey: string;
  code: string;
  /** 原文定位：页码必填；区域 / 渲染图至少给一项 */
  page: number;
  region?: Box;
  sourceImage?: { path: string; sha256: string };
  result: "MATCHES_SOURCE" | "MISMATCH";
  note?: string;
}

export interface InputQaAttestation {
  schema: typeof INPUT_QA_ATTESTATION_SCHEMA;
  sourceSha256: string;
  projectionSha256: string;
  /** 被审稿件（如由投影生成的 main.tex）的 sha256；产品内使用证明时必须绑定 */
  manuscriptSha256?: string;
  attestedBy: string;
  attestedAt: string;
  method: string;
  items: InputQaAttestationItem[];
}

export interface AttestationCheck {
  /** VALID：哈希一致且全部疑点逐条核对一致；INVALIDATED：哈希不符（证明过期）；INCOMPLETE：疑点未全覆盖 / 未绑定稿件；
   *  REJECTED：格式非法或试图覆盖硬缺陷；MISMATCH_FOUND：人工核对发现投影与原文不一致 */
  verdict: "VALID" | "INVALIDATED" | "INCOMPLETE" | "REJECTED" | "MISMATCH_FOUND";
  reasons: string[];
  effectiveStatus: FidelityStatus;
  requiredFindings: number;
  coveredFindings: number;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** 保真报告 finding 的稳定键：code | blockId | page | 摘录（或说明）规范串哈希前 12 位 */
export function fidelityFindingKey(finding: Pick<FidelityFinding, "code" | "blockId" | "page" | "excerpt" | "detail">): string {
  return [finding.code, finding.blockId ?? "", finding.page ?? "", sha256(canon(finding.excerpt ?? finding.detail)).slice(0, 12)].join("|");
}

/** 与保真门 projectionSha256 同口径（CRLF 归一后的投影文本） */
export function projectionTextSha256(text: string): string {
  return sha256(text.replace(/\r\n?/g, "\n"));
}

/** 人工 QA 待核对清单模板（结果留空——模板本身永远不构成有效证明） */
export function attestationTemplate(report: InputFidelityReport, manuscriptSha256?: string): Omit<InputQaAttestation, "items"> & { items: Array<Omit<InputQaAttestationItem, "result" | "page"> & { page: number | null; result: null; detail: string; excerpt?: string }> } {
  return {
    schema: INPUT_QA_ATTESTATION_SCHEMA,
    sourceSha256: report.sourceSha256,
    projectionSha256: report.projectionSha256,
    ...(manuscriptSha256 !== undefined ? { manuscriptSha256 } : {}),
    attestedBy: "",
    attestedAt: "",
    method: "逐项对照原 PDF（页 / 区域 / 渲染图），确认投影文本与原文一致",
    items: report.findings.filter((finding) => finding.severity === "soft").map((finding) => ({
      findingKey: fidelityFindingKey(finding), code: finding.code, page: finding.page ?? null, result: null, detail: finding.detail,
      ...(finding.excerpt !== undefined ? { excerpt: finding.excerpt } : {}),
    })),
  };
}

/** 证明 × 当前保真报告（× 当前被审稿件哈希）→ 有效状态。纯函数，不读文件 */
export function checkInputQaAttestation(report: InputFidelityReport, attestation: unknown, options: { manuscriptSha256?: string; requireManuscriptBinding?: boolean } = {}): AttestationCheck {
  const required = report.findings.filter((finding) => finding.severity === "soft");
  const base = { requiredFindings: required.length, coveredFindings: 0 };
  const reject = (reasons: string[]): AttestationCheck => ({ verdict: "REJECTED", reasons, effectiveStatus: report.status, ...base });
  if (typeof attestation !== "object" || attestation === null) return reject(["证明不是 JSON 对象"]);
  const record = attestation as Partial<InputQaAttestation>;
  if (record.schema !== INPUT_QA_ATTESTATION_SCHEMA) return reject([`schema 不符：${String(record.schema)}`]);
  if (typeof record.attestedBy !== "string" || record.attestedBy.trim() === "") return reject(["缺少核对人（attestedBy）"]);
  if (typeof record.attestedAt !== "string" || Number.isNaN(Date.parse(record.attestedAt))) return reject(["核对时间（attestedAt）不是合法时间"]);
  if (!Array.isArray(record.items)) return reject(["缺少核对条目（items）"]);
  const stale: string[] = [];
  if (record.sourceSha256 !== report.sourceSha256) stale.push("源证据哈希与证明不符（源 PDF / 源证据已变化）");
  if (record.projectionSha256 !== report.projectionSha256) stale.push("投影文本哈希与证明不符（转换文本已变化）");
  if (options.manuscriptSha256 !== undefined && record.manuscriptSha256 !== undefined && record.manuscriptSha256 !== options.manuscriptSha256) stale.push("被审稿件哈希与证明不符（送审稿件已变化）");
  if (stale.length > 0) return { verdict: "INVALIDATED", reasons: stale, effectiveStatus: report.status, ...base };
  if (report.status === "INVALID_INPUT" || report.status === "SOURCE_INCOMPLETE") {
    return reject([`保真门判定 ${report.status}（硬缺陷）：人工 QA 证明不能覆盖，只能修正投影后重跑保真门`]);
  }
  if (report.status === "VALID_FOR_SCORING") return { verdict: "VALID", reasons: ["保真门已判 VALID_FOR_SCORING，无需人工 QA"], effectiveStatus: "VALID_FOR_SCORING", ...base };
  const byKey = new Map<string, InputQaAttestationItem>();
  const malformed: string[] = [];
  for (const item of record.items as unknown[]) {
    const entry = item as Partial<InputQaAttestationItem>;
    const located = typeof entry.page === "number" && Number.isInteger(entry.page) && entry.page >= 1 &&
      ((Array.isArray(entry.region) && entry.region.length === 4) || (typeof entry.sourceImage?.path === "string" && /^[0-9a-f]{64}$/.test(entry.sourceImage.sha256 ?? "")));
    if (typeof entry.findingKey !== "string" || (entry.result !== "MATCHES_SOURCE" && entry.result !== "MISMATCH") || !located) {
      malformed.push(`${String(entry.findingKey ?? "(无键)")}：缺少结论或原文定位（页码 + 区域 / 渲染图哈希）`);
      continue;
    }
    byKey.set(entry.findingKey, entry as InputQaAttestationItem);
  }
  const mismatches = [...byKey.values()].filter((item) => item.result === "MISMATCH");
  const covered = required.filter((finding) => byKey.get(fidelityFindingKey(finding))?.result === "MATCHES_SOURCE");
  const coverage = { requiredFindings: required.length, coveredFindings: covered.length };
  if (mismatches.length > 0) {
    return { verdict: "MISMATCH_FOUND", reasons: mismatches.map((item) => `${item.code} p${item.page}：人工核对与原文不一致${item.note !== undefined ? `（${item.note}）` : ""}`), effectiveStatus: "INVALID_INPUT", ...coverage };
  }
  const missing = required.filter((finding) => !byKey.has(fidelityFindingKey(finding)));
  if (missing.length > 0 || malformed.length > 0) {
    return { verdict: "INCOMPLETE", reasons: [...missing.map((finding) => `未核对：${finding.code}${finding.page !== undefined ? ` p${finding.page}` : ""}`), ...malformed], effectiveStatus: "REQUIRES_HUMAN_QA", ...coverage };
  }
  if (options.requireManuscriptBinding === true && record.manuscriptSha256 === undefined) {
    return { verdict: "INCOMPLETE", reasons: ["证明未绑定被审稿件哈希（manuscriptSha256）：无法确认送审稿件来自被核对的投影"], effectiveStatus: "REQUIRES_HUMAN_QA", ...coverage };
  }
  return { verdict: "VALID", reasons: [`${covered.length} 条人工 QA 疑点逐条对照原文核对一致（${record.attestedBy}，${record.attestedAt}）`], effectiveStatus: "VALID_FOR_SCORING", ...coverage };
}
