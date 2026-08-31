import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyEnvFile, findEnvFile, parseEnvFile } from "../src/config/envFile.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("parseEnvFile", () => {
  it("解析 KEY=VALUE、注释、空行与引号值", () => {
    const values = parseEnvFile([
      "# 注释行",
      "",
      "PAPERTEAM_PORT=3000",
      "OPENCLAW_GATEWAY_URL = http://127.0.0.1:18789 ",
      'OPENCLAW_GATEWAY_API_KEY="quoted-key"',
      "SESSION_SECRET='single-quoted'",
      "export NODE_ENV=production",
    ].join("\n"));

    expect(values).toEqual({
      PAPERTEAM_PORT: "3000",
      OPENCLAW_GATEWAY_URL: "http://127.0.0.1:18789",
      OPENCLAW_GATEWAY_API_KEY: "quoted-key",
      SESSION_SECRET: "single-quoted",
      NODE_ENV: "production",
    });
  });

  it("跳过无法解析的行", () => {
    const values = parseEnvFile("not an assignment\n=novalue\nANOTHER=1");
    expect(values).toEqual({ ANOTHER: "1" });
  });

  it("处理 CRLF 行尾", () => {
    const values = parseEnvFile("A=1\r\nB=2\r\n");
    expect(values).toEqual({ A: "1", B: "2" });
  });
});

describe("findEnvFile", () => {
  it("返回第一个存在的 .env 文件内容", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, ".env"), "A=1\nB=2\n", "utf8");

    const envFile = findEnvFile([
      join(dir, "missing", ".env"),
      join(dir, ".env"),
    ]);

    expect(envFile).not.toBeNull();
    expect(envFile?.path).toBe(join(dir, ".env"));
    expect(envFile?.values).toEqual({ A: "1", B: "2" });
  });

  it("所有候选都不存在时返回 null", () => {
    const dir = makeTempDir();
    expect(findEnvFile([join(dir, "a.env"), join(dir, "b.env")])).toBeNull();
  });
});

describe("applyEnvFile", () => {
  it("只补缺，不覆盖已有环境变量", () => {
    const target: Record<string, string | undefined> = { A: "real-env" };
    const applied = applyEnvFile(target, { A: "from-file", B: "from-file" });

    expect(applied).toEqual(["B"]);
    expect(target).toEqual({ A: "real-env", B: "from-file" });
  });

  it("空字符串视为未设置，允许 .env 补缺", () => {
    const target: Record<string, string | undefined> = { A: "" };
    applyEnvFile(target, { A: "from-file" });
    expect(target["A"]).toBe("from-file");
  });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "paperteam-envfile-"));
  tempDirs.push(dir);
  return dir;
}
