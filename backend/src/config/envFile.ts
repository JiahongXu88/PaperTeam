import { readFileSync } from "node:fs";

/**
 * 极简 .env 文件支持（M1）。
 *
 * 语法约定（有意保持最小，不引第三方依赖）：
 * - 每行一条 `KEY=VALUE`，允许可选 `export ` 前缀
 * - `#` 开头的行与空行忽略
 * - 值两端空白剔除；成对的单引号 / 双引号会被剥掉
 * - 不做变量展开、不支持行内注释
 * - 无法解析的行直接跳过
 */

const ENV_LINE_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

export interface EnvFile {
  path: string;
  values: Record<string, string>;
}

export function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const match = ENV_LINE_RE.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1];
    if (!key) {
      continue;
    }
    values[key] = unquote(match[2] ?? "");
  }
  return values;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * 依次查找候选路径，返回第一个存在的 .env 文件内容。
 * 都不存在时返回 null（.env 是可选的，真实环境变量优先）。
 */
export function findEnvFile(candidatePaths: readonly string[]): EnvFile | null {
  for (const candidate of candidatePaths) {
    try {
      const content = readFileSync(candidate, "utf8");
      return { path: candidate, values: parseEnvFile(content) };
    } catch {
      // 文件不存在或不可读，继续尝试下一个候选路径
    }
  }
  return null;
}

/**
 * 将 .env 值合入目标环境：只补缺，不覆盖已存在的环境变量
 * （真实环境变量 / 进程注入的配置优先级更高）。
 * 返回实际写入的 key 列表。
 */
export function applyEnvFile(
  target: Record<string, string | undefined>,
  values: Record<string, string>,
): string[] {
  const applied: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (target[key] === undefined || target[key] === "") {
      target[key] = value;
      applied.push(key);
    }
  }
  return applied;
}
