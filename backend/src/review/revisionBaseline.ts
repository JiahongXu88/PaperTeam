/**
 * Revision Baseline（M10.3 Stage C：确定性、无 LLM）。
 *
 * 正式修改前从 current manuscript 建立事实基线（research/revision-baseline.json）：
 * - 主表格关键数字（表 label/caption + 单元格原文）
 * - 正文数字 token（值语义多重集）
 * - 公式片段（归一化多重集）
 * - 方向性结论句（负结果 / 持平 / 优势）
 * - citation keys / 图片引用 / 硬件型号 / 占位符
 *
 * 用途：
 * 1. 修订可追溯——「改了什么」有冻结前的机器可读事实源（与不可变修订快照
 *    互补：快照是全文，baseline 是提取后的结构化事实投影）；
 * 2. 冲突检测——MANIFEST / 实验记录 / user_confirmed Evidence 与基线数字的
 *    不一致在计划期暴露，而不是在 gate 期炸裂；
 * 3. 报告输入——Revision Trace 报告的「修订前事实」一列。
 *
 * 提取器与 Fact Preservation 同口径（表格 / 数字 / 公式 / 方向句 / 硬件），
 * 但只读不判：baseline 不做授权判定，授权仍是 Fact Preservation 的职责。
 */

import { createHash } from "node:crypto";

import { extractCitationKeys } from "../citation/StaticCitationChecker.js";
import { extractMathSegments, extractNumericTokens } from "./styleInvariants.js";

export interface BaselineTexFile {
  /** 相对 manuscript 目录的 POSIX 路径 */
  file: string;
  content: string;
}

export interface RevisionBaseline {
  schemaVersion: 1;
  generatedAt: string;
  /** 参与提取的文件（相对路径） */
  files: string[];
  /** 内容指纹（拼接文件内容的 sha256；修订后重算可快速判漂移） */
  contentHash: string;
  tables: {
    file: string;
    label: string | null;
    caption: string;
    rowCount: number;
    /** 行单元格原文（≤ BASELINE_MAX_TABLE_ROWS；含表头行） */
    rows: string[][];
  }[];
  /** 每文件正文数字 token 多重集（去表格/数学环境；≤ BASELINE_MAX_NUMBERS） */
  numbers: { file: string; tokens: string[] }[];
  /** 数学片段（归一化；≤ BASELINE_MAX_FORMULAS/文件） */
  formulas: { file: string; segments: string[] }[];
  /** 方向性结论句（含指标 / 优势-劣势-持平词；≤ BASELINE_MAX_CLAIMS/文件） */
  claims: { file: string; sentences: string[] }[];
  citationKeys: string[];
  figures: string[];
  hardware: string[];
  /** 占位符出现次数（待回填 / TBD 等；>0 即基线本身含未定事实） */
  placeholders: number;
  notes: string[];
}

const BASELINE_MAX_TABLE_ROWS = 80;
const BASELINE_MAX_NUMBERS = 400;
const BASELINE_MAX_FORMULAS = 60;
const BASELINE_MAX_CLAIMS = 40;
const BASELINE_MAX_HARDWARE = 20;

const TABLE_ENV_PATTERN = /\\begin\{table\*?\}([\s\S]*?)\\end\{table\*?\}/g;
const TABULAR_PATTERN = /\\begin\{tabular[xX*]*\}{[^}]*}([\s\S]*?)\\end\{tabular[xX*]*\}/;

const HARDWARE_PATTERN =
  /(RDK\s?X\d|RK\d{4}|Jetson\s?[A-Za-z]+\d*|Xavier(?:\s?NX)?|Orin(?:\s?NX)?|旭日[^\s，。；]{0,4}|地平线|树莓派|Raspberry\s?Pi\s?\d*|RTX\s?\d{3,4}|GTX\s?\d{3,4}|\b(?:V100|A100|H100|A800|H800)\b|Intel\s?[A-Za-z]+\s?\d{4,}|i[3579]-\d{4,}[A-Za-z]*)/g;
const PLACEHOLDER_PATTERN = /(待回填|待补充|待验证|待确认|待归档|暂无数据|待实验产出|TBD|TODO)/g;

const ADVANTAGE_WORDS = /(优于|更优|更好|更强|领先|保持优势|优势明显|明显优势|全面超过|胜过|反超)/;
const DISADVANTAGE_WORDS = /(更差|劣于|差于|落后|劣势|不及|不如|恶化|退化|退步|额外增加|仍较敏感)/;
const PARITY_WORDS = /(基本一致|大致相当|差异不大|相差不大|性能相当|接近|相近|相当)/;
const METRIC_PATTERN =
  /(IDF1|MOTA|IDS\b|ID Switch|HOTA|DetA|AssA|Frag\b|FPS|fps|mAP|AP\b|RSS|Norm-IDS|latency|Latency|漏检|误报|延迟|内存|温度|精度|身份切换|召回|查准)/;

function cleanCell(raw: string): string {
  return raw
    .replace(/\\(?:multicolumn|multirow)\{[^{}]*\}\{[^{}]*\}\{([^{}]*)\}/g, "$1")
    .replace(/\\[A-Za-z@]+\*?/g, " ")
    .replace(/[${}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTablesAndMath(content: string): string {
  let text = content.replace(/\r\n/g, "\n");
  text = text.replace(TABLE_ENV_PATTERN, " ");
  text = text.replace(TABULAR_PATTERN, " ");
  text = text.replace(/\\\[[\s\S]*?\\\]/g, " ").replace(/\\\(([\s\S]*?)\\\)/g, " ");
  text = text.replace(/\$\$[\s\S]*?\$\$/g, " ").replace(/(?<!\\)\$[^$\n]+?(?<!\\)\$/g, " ");
  return text;
}

function claimSentences(content: string): string[] {
  const text = content.replace(/\r\n/g, "\n");
  const sentences: string[] = [];
  let start = 0;
  const push = (end: number): void => {
    const raw = text.slice(start, end).trim();
    if (raw !== "" && (METRIC_PATTERN.test(raw) || ADVANTAGE_WORDS.test(raw) || DISADVANTAGE_WORDS.test(raw) || PARITY_WORDS.test(raw))) {
      sentences.push(raw.replace(/\s+/g, " ").slice(0, 240));
    }
    start = end + 1;
  };
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === "。" || ch === "！" || ch === "？" || ch === ";" || ch === "\n") {
      push(index);
    }
  }
  push(text.length);
  return sentences;
}

/** 确定性提取 manuscript 事实基线（纯函数；同输入同输出） */
export function buildRevisionBaseline(files: BaselineTexFile[], now = new Date().toISOString()): RevisionBaseline {
  const notes: string[] = [];
  const tables: RevisionBaseline["tables"] = [];
  const numbers: RevisionBaseline["numbers"] = [];
  const formulas: RevisionBaseline["formulas"] = [];
  const claims: RevisionBaseline["claims"] = [];
  const citationKeys = new Set<string>();
  const figures = new Set<string>();
  const hardware = new Set<string>();
  let placeholders = 0;

  for (const file of files) {
    const content = file.content;
    for (const key of extractCitationKeys(file.file, content).keys) {
      citationKeys.add(key);
    }
    for (const figure of [...content.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g)]) {
      const raw = (figure[1] ?? "").trim();
      if (raw !== "") {
        figures.add(raw.replaceAll("\\", "/"));
      }
    }
    placeholders += [...content.matchAll(PLACEHOLDER_PATTERN)].length;
    for (const match of content.matchAll(HARDWARE_PATTERN)) {
      if (hardware.size < BASELINE_MAX_HARDWARE) {
        hardware.add((match[0] ?? "").replace(/\s+/g, " "));
      }
    }

    let ordinal = 0;
    for (const envMatch of content.matchAll(TABLE_ENV_PATTERN)) {
      const body = envMatch[1] ?? "";
      const labelMatch = /\\label\{([^}]*)\}/.exec(body);
      const captionMatch = /\\caption\{([^}]*)\}/.exec(body);
      const tabularMatch = TABULAR_PATTERN.exec(body);
      const rows: string[][] = [];
      if (tabularMatch !== null) {
        const raw = tabularMatch[1] ?? "";
        for (const rawRow of raw.split(/\\\\(?!\()\s*(?:\[[^\]]*\])?/)) {
          const cells = rawRow.split("&").map((cell) => cleanCell(cell));
          if (cells.filter((cell) => cell !== "").length === 0 || cells.length < 2) {
            continue;
          }
          if (rows.length >= BASELINE_MAX_TABLE_ROWS) {
            notes.push(`${file.file} 第 ${ordinal + 1} 个表超过 ${BASELINE_MAX_TABLE_ROWS} 行，基线截断`);
            break;
          }
          rows.push(cells);
        }
      }
      tables.push({
        file: file.file,
        label: labelMatch !== null ? (labelMatch[1] ?? "").trim() : null,
        caption: cleanCell(captionMatch !== null ? (captionMatch[1] ?? "") : ""),
        rowCount: rows.length,
        rows,
      });
      ordinal += 1;
    }

    const proseTokens = extractNumericTokens(stripTablesAndMath(content));
    numbers.push({ file: file.file, tokens: proseTokens.slice(0, BASELINE_MAX_NUMBERS) });
    if (proseTokens.length > BASELINE_MAX_NUMBERS) {
      notes.push(`${file.file} 正文数字 token ${proseTokens.length} 个，基线截断为 ${BASELINE_MAX_NUMBERS}`);
    }

    const mathSegments = extractMathSegments(content);
    formulas.push({ file: file.file, segments: mathSegments.slice(0, BASELINE_MAX_FORMULAS) });
    if (mathSegments.length > BASELINE_MAX_FORMULAS) {
      notes.push(`${file.file} 公式片段 ${mathSegments.length} 个，基线截断为 ${BASELINE_MAX_FORMULAS}`);
    }

    const sentences = claimSentences(content);
    claims.push({ file: file.file, sentences: sentences.slice(0, BASELINE_MAX_CLAIMS) });
    if (sentences.length > BASELINE_MAX_CLAIMS) {
      notes.push(`${file.file} 方向性结论句 ${sentences.length} 句，基线截断为 ${BASELINE_MAX_CLAIMS}`);
    }
  }

  const contentHash = createHash("sha256")
    .update(files.map((file) => `${file.file}\n${file.content}`).join("\n\x00\n"))
    .digest("hex");

  return {
    schemaVersion: 1,
    generatedAt: now,
    files: files.map((file) => file.file),
    contentHash,
    tables,
    numbers,
    formulas,
    claims,
    citationKeys: [...citationKeys].sort(),
    figures: [...figures],
    hardware: [...hardware],
    placeholders,
    notes,
  };
}
