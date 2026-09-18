/**
 * 人工校准（Human Calibration）：读 JSONL 记录、校验、计算自动指标与人工
 * 标注的一致率（用于验证自动指标的信度）。
 *
 * 记录文件（evaluation/calibration/records.jsonl，人工维护、逐行 JSON）：
 *   {"experiment":1,"scenarioId":"g1-rag-survey","arm":"plain-llm",
 *    "claim":"…","prediction":"unsupported","humanLabel":"unsupported",
 *    "reason":"…","recordedAt":"2026-09-18T00:00:00Z"}
 *
 * 纪律：解析失败的行如实计入 malformed + parseErrors（不静默丢弃、不让
 * 单行脏数据炸掉整个报告）；prediction/humanLabel 的取值空间由使用方约定
 * （这里只做一致性比较，不硬编码枚举）。
 */

import type { CalibrationRecord, CalibrationSummary } from "../types.js";

export function parseCalibrationRecords(text: string): {
  records: CalibrationRecord[];
  parseErrors: string[];
} {
  const records: CalibrationRecord[] = [];
  const parseErrors: string[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "") {
      return;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (
        ![1, 2, 3].includes(parsed["experiment"] as number) ||
        typeof parsed["scenarioId"] !== "string" ||
        typeof parsed["arm"] !== "string" ||
        typeof parsed["claim"] !== "string" ||
        typeof parsed["prediction"] !== "string" ||
        typeof parsed["humanLabel"] !== "string" ||
        typeof parsed["reason"] !== "string"
      ) {
        parseErrors.push(`第 ${index + 1} 行：字段缺失或类型不符`);
        return;
      }
      records.push({
        experiment: parsed["experiment"] as 1 | 2 | 3,
        scenarioId: parsed["scenarioId"],
        arm: parsed["arm"],
        claim: parsed["claim"],
        prediction: parsed["prediction"],
        humanLabel: parsed["humanLabel"],
        reason: parsed["reason"],
        ...(typeof parsed["recordedAt"] === "string" ? { recordedAt: parsed["recordedAt"] } : {}),
      });
    } catch (error) {
      parseErrors.push(`第 ${index + 1} 行：${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return { records, parseErrors };
}

export function summarizeCalibration(records: readonly CalibrationRecord[], parseErrors: readonly string[] = []): CalibrationSummary {
  const perPrediction = new Map<string, { total: number; agreed: number }>();
  let agreed = 0;
  for (const record of records) {
    const entry = perPrediction.get(record.prediction) ?? { total: 0, agreed: 0 };
    entry.total += 1;
    if (record.prediction === record.humanLabel) {
      entry.agreed += 1;
      agreed += 1;
    }
    perPrediction.set(record.prediction, entry);
  }
  return {
    records: records.length + parseErrors.length,
    valid: records.length,
    malformed: parseErrors.length,
    agreementRate: records.length > 0 ? agreed / records.length : null,
    perPrediction: [...perPrediction.entries()]
      .map(([prediction, entry]) => ({ prediction, total: entry.total, agreed: entry.agreed }))
      .sort((a, b) => b.total - a.total),
    parseErrors: [...parseErrors],
  };
}

/**
 * 人工偏好（Experiment 3 humanPreference）：同一 scenario 下 humanLabel
 * 为 "prefer-<arm>" 的记录占比。返回 null = 该场景没有偏好记录。
 */
export function computeHumanPreference(
  records: readonly CalibrationRecord[],
  experiment: 3,
  scenarioId: string,
  arm: "plain-llm" | "paperteam",
): number | null {
  const relevant = records.filter(
    (record) =>
      record.experiment === experiment &&
      record.scenarioId === scenarioId &&
      record.humanLabel === `prefer-${arm}`,
  );
  const total = records.filter(
    (record) => record.experiment === experiment && record.scenarioId === scenarioId,
  );
  if (total.length === 0) {
    return null;
  }
  return relevant.length / total.length;
}
