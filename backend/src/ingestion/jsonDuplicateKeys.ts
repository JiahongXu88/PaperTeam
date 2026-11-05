/**
 * M17.2 JSON 重复键检测：JSON.parse 对同一对象内的重复键静默取最后一个值——实验结果 JSON 里
 * 「同键两值」恰是版本冲突的典型形态，不能让它悄悄消失。这里只做词法扫描（不求值、不改解析结果），
 * 返回重复键所在的 JSON path，供解析 note 如实登记；解析值仍按 JSON 标准语义（后者覆盖）。
 */

const MAX_REPORTED = 20;

export function findDuplicateJsonKeys(text: string): string[] {
  const duplicates: string[] = [];
  // 栈帧：对象 = 已见键集合 + 路径；数组 = 当前下标 + 路径
  type Frame = { kind: "object"; path: string; keys: Set<string>; pendingKey: string | null; expectKey: boolean } | { kind: "array"; path: string; index: number };
  const stack: Frame[] = [];
  let index = 0;
  const childPath = (): string => {
    const top = stack[stack.length - 1];
    if (top === undefined) return "$";
    if (top.kind === "array") return `${top.path}[${top.index}]`;
    return `${top.path}.${top.pendingKey ?? "?"}`;
  };
  const readString = (): string | null => {
    // index 指向起始引号
    let result = "";
    index += 1;
    while (index < text.length) {
      const char = text[index]!;
      if (char === "\\") {
        const next = text[index + 1];
        if (next === "u") {
          const code = Number.parseInt(text.slice(index + 2, index + 6), 16);
          result += Number.isFinite(code) ? String.fromCharCode(code) : "";
          index += 6;
          continue;
        }
        result += next === "n" ? "\n" : next === "t" ? "\t" : next ?? "";
        index += 2;
        continue;
      }
      if (char === "\"") {
        index += 1;
        return result;
      }
      result += char;
      index += 1;
    }
    return null;
  };
  while (index < text.length && duplicates.length < MAX_REPORTED) {
    const char = text[index]!;
    const top = stack[stack.length - 1];
    if (char === "{") {
      stack.push({ kind: "object", path: childPath(), keys: new Set(), pendingKey: null, expectKey: true });
      index += 1;
    } else if (char === "[") {
      stack.push({ kind: "array", path: childPath(), index: 0 });
      index += 1;
    } else if (char === "}" || char === "]") {
      stack.pop();
      index += 1;
    } else if (char === ",") {
      if (top?.kind === "object") top.expectKey = true;
      else if (top?.kind === "array") top.index += 1;
      index += 1;
    } else if (char === "\"") {
      const value = readString();
      if (value === null) break;
      if (top?.kind === "object" && top.expectKey) {
        if (top.keys.has(value)) duplicates.push(`${top.path}.${value}`);
        top.keys.add(value);
        top.pendingKey = value;
        top.expectKey = false;
      }
    } else {
      index += 1;
    }
  }
  return duplicates;
}
