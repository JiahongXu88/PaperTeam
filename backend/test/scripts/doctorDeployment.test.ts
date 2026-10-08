/**
 * M12 Batch 3 Part D：doctor 部署形态测试（development / deployment 语义分离）。
 *
 * 以子进程运行真实 scripts/doctor.mjs（显式 PAPERTEAM_DEPLOYMENT——跨平台
 * 确定性；自动检测路径依赖宿主机 docker 状态，不做断言）：
 * - deployment=docker：宿主机 node_modules 检查降级为 PASS 说明项（部署形态
 *   前端预编译进 web 镜像——修复 Docker 生产形态的 frontend deps 假 FAIL）；
 * - deployment=native：backend 依赖仍 FAIL 级、frontend 依赖降 WARN（静态
 *   产物可在他处构建）；
 * - 非法形态值 → 警示并回落 development 检查语义。
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const doctorScript = join(repoRoot, "scripts", "doctor.mjs");
const DOCTOR_MODE_TEST_TIMEOUT_MS = 10_000;

interface DoctorRun {
  code: number;
  stdout: string;
}

function runDoctor(extraEnv: Record<string, string>): DoctorRun {
  // These cases assert deployment-mode reporting, not host toolchain availability.
  // Hide host commands so TeX compilation, Python/Docling imports and Docker probes
  // cannot make a mode assertion depend on CI machine speed or installed tools.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
  );
  const result = spawnSync(process.execPath, [doctorScript], {
    encoding: "utf8",
    timeout: DOCTOR_MODE_TEST_TIMEOUT_MS,
    cwd: repoRoot,
    env: { ...env, PATH: "", PAPERTEAM_PDF_PYTHON: "", PAPERTEAM_DOCLING_PYTHON: "", ...extraEnv },
  });
  if (result.error) throw result.error;
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
  };
}

describe("doctor 部署形态（M12 Batch 3 Part D）", () => {
  it("deployment=docker：依赖检查降级为部署说明（不再假 FAIL frontend deps）", () => {
    const run = runDoctor({ PAPERTEAM_DEPLOYMENT: "docker" });
    expect(run.stdout).toContain("检查形态 docker");
    // 宿主机 node_modules 不是 docker 部署的运行时事实 → PASS 说明项
    expect(run.stdout).toMatch(/\[OK\s+\] backend \/ frontend 依赖：部署模式（docker）/);
    expect(run.stdout).toContain("部署模式（docker）：前端已预编译进独立 web 镜像");
    expect(run.stdout).toContain("部署模式（docker）：xelatex / bibtex / pgfplots / tikz / standalone 在 backend 镜像内");
    // 不再出现 development 形态的 frontend 依赖 FAIL
    expect(run.stdout).not.toMatch(/FAIL\s*\] frontend 依赖/);
  }, DOCTOR_MODE_TEST_TIMEOUT_MS);

  it("deployment=native：backend 依赖仍为 FAIL 级语义；frontend 依赖降 WARN", () => {
    const run = runDoctor({ PAPERTEAM_DEPLOYMENT: "native" });
    expect(run.stdout).toContain("检查形态 native");
    // backend deps 在 native 是真实运行时依赖（缺失时 FAIL 语义保留；
    // 本机与 CI 均已安装 → PASS 行，但检查名与语义不变）
    expect(run.stdout).toMatch(/\[OK\s+\] backend 依赖：已安装/);
    expect(run.stdout).toMatch(/\[(OK\s+|WARN)\] frontend 依赖：/);
    // native 形态不做 docker 说明
    expect(run.stdout).not.toContain("部署模式（docker）：前端已预编译");
  }, DOCTOR_MODE_TEST_TIMEOUT_MS);

  it("非法形态值 → 警示并按 development 检查（frontend 依赖回到 FAIL 级语义）", () => {
    const run = runDoctor({ PAPERTEAM_DEPLOYMENT: "k8s" });
    expect(run.stdout).toContain('PAPERTEAM_DEPLOYMENT="k8s" 不是合法值');
    expect(run.stdout).toMatch(/\[(OK\s+|FAIL)\] backend 依赖：/);
    expect(run.stdout).toMatch(/\[(OK\s+|FAIL)\] frontend 依赖：/); // development：FAIL 级（安装了则 OK，但不是部署说明项）
    expect(run.stdout).not.toMatch(/backend \/ frontend 依赖：部署模式/);
  }, DOCTOR_MODE_TEST_TIMEOUT_MS);
});
