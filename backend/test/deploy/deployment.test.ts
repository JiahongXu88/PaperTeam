/**
 * M5.5 单机 Linux / Docker 部署：自动化可验证部分。
 * - Readiness（/ready）：Runtime + 文件系统 + TeX / Python 工具链；ready 与 degraded 语义；latex 探测缓存
 * - 停机预算配置：PAPERTEAM_SHUTDOWN_TIMEOUT_MS 默认 / 范围
 * - 部署文件契约（Dockerfile / compose.yml / nginx.conf / .dockerignore / CI）：
 *   不 COPY .env、不写 Key、多阶段、非 texlive-full、backend 不对外发布端口、双 volume、
 *   stop_grace_period ≥ shutdown 预算、同源反向代理 + SSE 不缓冲、Linux 路径纯净（无 C:\ / cmd.exe / PowerShell）
 * - Linux 跨平台：源码里 Windows 分支全部由 platform 门控，无 cmd.exe / PowerShell 调用
 *
 * 真实 docker compose build / up / restart / persistence 验收不在本文件（需要 Docker 主机，见 docs/DEPLOYMENT.md）。
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../../src/config/config.js";
import { ReadinessProbe } from "../../src/runtime/readiness.js";
import type { AgentRuntime, AgentTask, RuntimeHealth } from "../../src/runtime/types.js";
import { scriptedIdeaRuntime, startTestStack } from "../helpers/testStack.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (relative: string): Promise<string> => readFile(join(REPO, relative), "utf8");

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pt-ready-"));
  tempDirs.push(dir);
  return dir;
}

function fakeRuntime(ok: boolean): AgentRuntime {
  const health: RuntimeHealth = {
    ok,
    provider: "pi",
    status: ok ? "healthy" : "unhealthy",
    detail: ok ? "fake healthy" : "fake broken",
    latencyMs: 1,
    checkedAt: new Date().toISOString(),
  };
  return {
    provider: "pi",
    healthCheck: async () => health,
    runAgent: async () => {
      throw new Error("not used");
    },
    startAgent: async () => {
      throw new Error("not used");
    },
    getTask: async (): Promise<AgentTask> => {
      throw new Error("not used");
    },
    close: async () => {},
  };
}

describe("M5.5 Readiness（/ready ≠ /health）", () => {
  it("Runtime 健康 + 两个数据根可写 + 工具链可用 → ready，无 degraded；latex 探测结果缓存", async () => {
    let probes = 0;
    let now = 1_000_000;
    const probe = new ReadinessProbe({
      runtime: fakeRuntime(true),
      paths: [
        { label: "PROJECTS_ROOT", path: join(await tmp(), "projects") },
        { label: "PAPERTEAM_RUNTIME_ROOT", path: join(await tmp(), "runtime") },
      ],
      latex: {
        detectTool: async () => {
          probes += 1;
          return "latexmk";
        },
      },
      pdfParser: { checkAvailability: async () => ({ available: true }) },
      cacheMs: 60_000,
      now: () => now,
    });
    const first = await probe.check();
    expect(first.ready).toBe(true);
    expect(first.degraded).toEqual([]);
    expect(first.checks.filesystem.every((entry) => entry.ok)).toBe(true);
    expect(first.checks.latex).toMatchObject({ ok: true, tool: "latexmk", cached: false });
    const second = await probe.check();
    expect(second.checks.latex.cached).toBe(true);
    expect(probes).toBe(1);
    now += 61_000;
    await probe.check();
    expect(probes).toBe(2);
    // 探针文件已清理
    for (const entry of first.checks.filesystem) {
      expect(await readdir(entry.path)).toEqual([]);
    }
  });

  it("TeX / Python 缺失 → 仍 ready 但 degraded 如实列出；Runtime 不健康或数据根不可写 → 503 语义", async () => {
    const root = await tmp();
    const blocker = join(root, "not-a-dir");
    await writeFile(blocker, "file", "utf8"); // 目录位置被文件占用 → mkdir 失败 → 不可写
    const degradedProbe = new ReadinessProbe({
      runtime: fakeRuntime(true),
      paths: [{ label: "PROJECTS_ROOT", path: join(root, "projects") }],
      latex: {
        detectTool: async () => {
          throw new Error("latexmk 与 xelatex 均不可用");
        },
      },
      pdfParser: { checkAvailability: async () => ({ available: false, detail: "缺少 pymupdf" }) },
    });
    const degraded = await degradedProbe.check();
    expect(degraded.ready).toBe(true);
    expect(degraded.degraded).toHaveLength(2);
    expect(degraded.degraded.join("\n")).toMatch(/latex.*不可用/);
    expect(degraded.degraded.join("\n")).toMatch(/pdf.*pymupdf/);

    const unhealthy = await new ReadinessProbe({ runtime: fakeRuntime(false), paths: [] }).check();
    expect(unhealthy.ready).toBe(false);
    expect(unhealthy.checks.runtime.ok).toBe(false);
    expect(unhealthy.checks.latex).toMatchObject({ ok: false, tool: null });

    const unwritable = await new ReadinessProbe({
      runtime: fakeRuntime(true),
      paths: [{ label: "PROJECTS_ROOT", path: join(blocker, "projects") }],
    }).check();
    expect(unwritable.ready).toBe(false);
    expect(unwritable.checks.filesystem[0]!.ok).toBe(false);
  });

  it("HTTP：GET /ready 200 / 503；HEAD 允许；未配置 → 503", async () => {
    const readyProbe = new ReadinessProbe({
      runtime: fakeRuntime(true),
      paths: [{ label: "PROJECTS_ROOT", path: join(await tmp(), "p") }],
      latex: { detectTool: async () => "xelatex" },
      pdfParser: { checkAvailability: async () => ({ available: true }) },
    });
    const okStack = await startTestStack(scriptedIdeaRuntime().runtime, { readiness: readyProbe });
    try {
      const ready = await okStack.request("GET", "/ready");
      expect(ready.status).toBe(200);
      expect(ready.body["ready"]).toBe(true);
      expect((ready.body["checks"] as Record<string, unknown>)["latex"]).toMatchObject({ ok: true, tool: "xelatex" });
      const health = await okStack.request("GET", "/health");
      expect(health.status).toBe(200);
      expect(health.body["status"]).toBe("ok");
    } finally {
      await okStack.cleanup();
    }
    const brokenStack = await startTestStack(scriptedIdeaRuntime().runtime, {
      readiness: new ReadinessProbe({ runtime: fakeRuntime(false), paths: [] }),
    });
    try {
      const notReady = await brokenStack.request("GET", "/ready");
      expect(notReady.status).toBe(503);
      expect(notReady.body["ready"]).toBe(false);
    } finally {
      await brokenStack.cleanup();
    }
    const noProbe = await startTestStack(scriptedIdeaRuntime().runtime);
    try {
      expect((await noProbe.request("GET", "/ready")).status).toBe(503);
    } finally {
      await noProbe.cleanup();
    }
  });
});

describe("M5.5 停机预算配置", () => {
  it("PAPERTEAM_SHUTDOWN_TIMEOUT_MS 默认 30s；范围 1s-10min；非法值 ConfigError", () => {
    expect(loadConfig({}).shutdownTimeoutMs).toBe(30_000);
    expect(loadConfig({ PAPERTEAM_SHUTDOWN_TIMEOUT_MS: "40000" }).shutdownTimeoutMs).toBe(40_000);
    expect(() => loadConfig({ PAPERTEAM_SHUTDOWN_TIMEOUT_MS: "10" })).toThrow(ConfigError);
    expect(() => loadConfig({ PAPERTEAM_SHUTDOWN_TIMEOUT_MS: "abc" })).toThrow(ConfigError);
  });
});

describe("M5.5 部署文件契约（Dockerfile / compose / nginx / .dockerignore / CI）", () => {
  it("Dockerfile：多阶段 backend + web；不 COPY .env / 密钥；Node 22 满足 engines；非 texlive-full；工具链齐全；exec 形式入口", async () => {
    const dockerfile = await read("Dockerfile");
    // 注释行只是说明；密钥 / 路径纯净性检查针对真实指令
    const instructions = dockerfile
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(dockerfile).toMatch(/FROM .* AS frontend-build/);
    expect(dockerfile).toMatch(/FROM .* AS backend-build/);
    expect(dockerfile).toMatch(/FROM .* AS backend\n/);
    expect(dockerfile).toMatch(/FROM nginx:.* AS web/);
    expect(instructions).not.toMatch(/COPY\s+\.env/);
    expect(instructions).not.toMatch(/auth\.json/);
    expect(instructions).not.toMatch(/API_KEY\s*=|ANTHROPIC|OPENAI_API|sk-[A-Za-z0-9]{10,}/);
    expect(instructions).not.toMatch(/texlive-full/);
    for (const dep of ["python3", "texlive-xetex", "texlive-lang-chinese", "latexmk", "biber", "git", "fonts-noto-cjk", "pymupdf"]) {
      expect(dockerfile).toContain(dep);
    }
    // engines：root package.json 允许 Node 22.22.3+ / 24.15+ / 25.9+；镜像用 node:22
    const rootPkg = JSON.parse(await read("package.json")) as { engines: { node: string } };
    expect(rootPkg.engines.node).toContain(">=22");
    expect(dockerfile).toMatch(/NODE_IMAGE=node:22-/);
    // 运行必需内容：dist / 生产 node_modules / seed / tools
    expect(dockerfile).toMatch(/COPY backend\/skills \.\/skills/);
    expect(dockerfile).toMatch(/COPY backend\/tools \.\/tools/);
    expect(dockerfile).toMatch(/npm prune --omit=dev/);
    expect(dockerfile).toMatch(/ENTRYPOINT \["paperteam-entrypoint"\]/);
    expect(dockerfile).toMatch(/CMD \["node", "dist\/index\.js"\]/);
    expect(dockerfile).toMatch(/HEALTHCHECK/);
    // 数据根由环境变量指向 volume，不落在容器可写层的仓库目录
    expect(dockerfile).toMatch(/PROJECTS_ROOT=\/data\/projects/);
    expect(dockerfile).toMatch(/PAPERTEAM_RUNTIME_ROOT=\/data\/runtime/);
    // Linux 路径纯净
    expect(dockerfile).not.toMatch(/[A-Za-z]:\\|cmd\.exe|powershell/i);
    const entrypoint = await read("docker/backend-entrypoint.sh");
    expect(entrypoint).toMatch(/setpriv --reuid=paperteam/);
    expect(entrypoint).toMatch(/exec "\$@"/);
    expect(entrypoint).not.toMatch(/\r/);
  });

  it("compose.yml：双 named volume 挂到两个数据根；backend 只 expose 不 publish；web 唯一对外端口；env_file 可缺省；stop_grace_period ≥ 停机预算；无密钥", async () => {
    const compose = await read("compose.yml");
    expect(compose).toMatch(/paperteam-projects:\/data\/projects/);
    expect(compose).toMatch(/paperteam-runtime:\/data\/runtime/);
    expect(compose).toMatch(/PROJECTS_ROOT: \/data\/projects/);
    expect(compose).toMatch(/PAPERTEAM_RUNTIME_ROOT: \/data\/runtime/);
    const backendBlock = compose.slice(compose.indexOf("  backend:"), compose.indexOf("  web:"));
    expect(backendBlock).toMatch(/expose:\n\s+- "3000"/);
    expect(backendBlock).not.toMatch(/\n\s+ports:/);
    expect(backendBlock).toMatch(/required: false/);
    const grace = Number(/stop_grace_period: (\d+)s/.exec(backendBlock)![1]);
    const budget = Number(/PAPERTEAM_SHUTDOWN_TIMEOUT_MS: "(\d+)"/.exec(backendBlock)![1]);
    expect(grace * 1000).toBeGreaterThan(budget);
    const webBlock = compose.slice(compose.indexOf("  web:"), compose.indexOf("volumes:\n  paperteam-projects:"));
    expect(webBlock).toMatch(/ports:\n\s+- "\$\{PAPERTEAM_WEB_PORT:-8080\}:80"/);
    expect(webBlock).toMatch(/condition: service_healthy/);
    expect(compose).not.toMatch(/API_KEY:|ANTHROPIC_API_KEY|sk-[A-Za-z0-9]{10,}/);
    expect(compose).not.toMatch(/[A-Za-z]:\\|cmd\.exe|powershell/i);
  });

  it("nginx.conf：静态 + /api /health /ready 同源反代到 backend:3000，SSE 不缓冲长超时", async () => {
    const nginx = await read("docker/nginx.conf");
    expect(nginx).toMatch(/server backend:3000/);
    expect(nginx).toMatch(/location ~ \^\/\(api\|health\|ready\)/);
    expect(nginx).toMatch(/proxy_buffering off/);
    expect(nginx).toMatch(/proxy_read_timeout 3600s/);
    expect(nginx).toMatch(/try_files \$uri \$uri\/ \/index\.html/);
  });

  it(".dockerignore 排除密钥 / 依赖 / 运行数据；.gitignore 继续忽略 .env 与 auth 材料；CI 在 ubuntu 跑 build / typecheck / test + docker build", async () => {
    const dockerignore = await read(".dockerignore");
    for (const entry of [".env", "**/node_modules", "projects/", "runtime/", "**/auth.json"]) {
      expect(dockerignore).toContain(entry);
    }
    const gitignore = await read(".gitignore");
    expect(gitignore).toMatch(/^\.env$/m);
    expect(gitignore).toMatch(/^\/runtime\/$/m);
    expect(gitignore).toMatch(/^projects\/$/m);
    const ci = await read(".github/workflows/ci.yml");
    expect(ci).toMatch(/runs-on: ubuntu-latest/);
    expect(ci).toMatch(/npm run build/);
    expect(ci).toMatch(/npm run typecheck/);
    expect(ci).toMatch(/npm test/);
    expect(ci).toMatch(/target: backend/);
    expect(ci).toMatch(/target: web/);
    expect(ci).toMatch(/\/ready/);
  });
});

describe("M5.5 Linux 跨平台审计（源码）", () => {
  it("backend 源码没有 cmd.exe / PowerShell 调用；Windows 分支全部由 process.platform 门控", async () => {
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.name.endsWith(".ts")) {
          files.push(full);
        }
      }
    };
    await walk(join(REPO, "backend", "src"));
    expect(files.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (/cmd\.exe|powershell\.exe|spawn\("cmd"|spawn\("powershell"/i.test(code)) {
        offenders.push(file);
      }
      if (/shell:\s*true/.test(code)) {
        offenders.push(`${file} (shell:true 无平台门控)`);
      }
      if (/["'`][A-Za-z]:\\\\/.test(code)) {
        offenders.push(`${file} (硬编码 Windows 盘符路径)`);
      }
    }
    expect(offenders).toEqual([]);
    const latex = await read("backend/src/latex/LatexCompiler.ts");
    expect(latex).toMatch(/const IS_WINDOWS = process\.platform === "win32"/);
    expect(latex).toMatch(/shell: IS_WINDOWS/);
    const pdf = await read("backend/src/paper/pdfToolchain.ts");
    expect(pdf).toMatch(/"python3"/); // Linux 候选
  });
});
