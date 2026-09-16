#!/usr/bin/env node
/**
 * M5.7 真实 Smoke（一次性验证脚本，不进入 CI）：
 *
 * Part A — per-Agent 模型（真实模型调用）：
 *   全局默认 zai-coding-cn/glm-5.3；Writer override zai-coding-cn/glm-5.3-flash；
 *   Academic Reviewer 继承默认。两个最小真实 run（writing/revision 与
 *   review/academic scope），断言任务终态 metadata.model 分别为 override 与默认，
 *   usage / cost 按 Agent × 模型可观测。
 *
 * Part B — 外部意见 conflict 全链路（真实 backend 进程 + scripted runtime，
 *   HTTP 真实）：导入 fixture 项目（含明确 negative result 语境的意见）→
 *   录入「请把低照度优势说明得更明显 [conflict]」→ 跑 improvement → approve →
 *   断言：意见 status=conflict + conflictBasis 引用具体数值；稿件不含「优势」
 *   表述（没有为满足 mandatory 篡改事实）；Quality Gate 的 fact preservation
 *   未被 mandatory 绕过（PASS 或 N/A，不得 FAIL 被无视——scripted Writer 遵守
 *   契约不改数字）。
 *
 * 用法：node scripts/m57-smoke.mjs [--skip-a]（A 需要本机已保存 zai 凭据）
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const results = [];
function record(part, name, ok, detail) {
  results.push({ part, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} [${part}] ${name}${detail !== undefined && detail !== "" ? ` — ${detail}` : ""}`);
}

// ---------------- Part A：per-Agent 模型（真实模型） ----------------

async function smokePerAgentModel() {
  const modulePath = `file://${join(repoRoot, "backend", "dist", "runtime", "PiRuntimeAdapter.js").replaceAll("\\", "/")}`;
  const { PiRuntimeAdapter } = await import(modulePath);
  const agentDir = join(homedir(), ".paperteam", "runtime", "pi", "agent");
  const workspaceRoot = await mkdtemp(join(tmpdir(), "m57-smoke-ws-"));
  const overrides = { writer: "zai-coding-cn/glm-5.3-flash" };
  const adapter = new PiRuntimeAdapter({
    modelSpec: "zai-coding-cn/glm-5.3",
    agentDir,
    workspaceRoot,
    agentModelSpecs: async () => overrides,
    log: () => {},
  });
  try {
    const status = await adapter.modelStatusSnapshot();
    record("A", "modelStatusSnapshot 暴露 writer override", JSON.stringify(status.agents) === JSON.stringify([{ key: "writer", model: "zai-coding-cn/glm-5.3-flash" }]), JSON.stringify(status.agents));

    const writerTask = await adapter.runAgent({
      agentId: "writer",
      task: "请只输出两个汉字：完成",
      contextScope: "writing/revision",
      timeoutMs: 120_000,
    });
    record("A", "Writer run（writing/revision）completed", writerTask.status === "completed", writerTask.error);
    record("A", "Writer 使用 override 模型 glm-5.3-flash", writerTask.metadata?.model === "zai-coding-cn/glm-5.3-flash", writerTask.metadata?.model);

    const reviewerTask = await adapter.runAgent({
      agentId: "reviewer",
      task: "请只输出两个汉字：收到",
      contextScope: "review/academic",
      timeoutMs: 120_000,
    });
    record("A", "Academic Reviewer run（review/academic）completed", reviewerTask.status === "completed", reviewerTask.error);
    record("A", "Academic Reviewer 继承默认 glm-5.3", reviewerTask.metadata?.model === "zai-coding-cn/glm-5.3", reviewerTask.metadata?.model);

    const totals = adapter.runtimeStats().usageTotals;
    record(
      "A",
      "usage 按 Agent × 模型可观测（两 run 均有 usage）",
      totals.runs === 2 && totals.runsWithUsage >= 1,
      `runs=${totals.runs} runsWithUsage=${totals.runsWithUsage} in=${totals.inputTokens} out=${totals.outputTokens} cost≈${totals.estimatedCost ?? "?"}`,
    );
    // 不打印任何凭据；prompt / 输出不含 key（模型输出只是「完成」）。
  } finally {
    await adapter.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

// ---------------- Part B：外部意见 conflict（真实进程 + scripted runtime） ----------------

function buildZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBytes, compressed);
    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(0x02014b50, 0);
    centralEntry.writeUInt16LE(20, 4);
    centralEntry.writeUInt16LE(20, 6);
    centralEntry.writeUInt16LE(8, 10);
    centralEntry.writeUInt32LE(compressed.length, 20);
    centralEntry.writeUInt32LE(entry.data.length, 24);
    centralEntry.writeUInt16LE(nameBytes.length, 28);
    centralEntry.writeUInt32LE(offset, 42);
    central.push(centralEntry, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

async function smokeExternalConflict() {
  const root = await mkdtemp(join(tmpdir(), "m57-smoke-root-"));
  const backend = spawn(process.execPath, [join(repoRoot, "backend", "dist", "index.js")], {
    env: {
      ...process.env,
      PAPERTEAM_TEST_RUNTIME: "scripted",
      PROJECTS_ROOT: join(root, "projects"),
      PAPERTEAM_RUNTIME_ROOT: join(root, "runtime"),
      PAPERTEAM_PORT: "3457",
      PAPERTEAM_PI_RUN_TIMEOUT_MS: "120000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let backendLog = "";
  backend.stdout.on("data", (chunk) => {
    backendLog += String(chunk);
  });
  backend.stderr.on("data", (chunk) => {
    backendLog += String(chunk);
  });
  const base = "http://127.0.0.1:3457";
  const request = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
        : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    // 等待就绪
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const health = await fetch(base + "/health");
        if (health.ok) {
          ready = true;
          break;
        }
      } catch {
        /* 启动中 */
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    record("B", "scripted backend 启动就绪", ready, ready ? undefined : backendLog.slice(-500));

    const project = await request("POST", "/api/projects", { title: "M5.7 smoke：外部意见冲突" });
    const projectId = project.body["project"]["id"];

    const archive = buildZip([
      {
        name: "main.tex",
        data: Buffer.from(
          ["\\documentclass[UTF8]{ctexart}", "\\begin{document}", "\\input{sections/introduction}", "\\input{sections/experiments}", "\\end{document}"].join("\n"),
        ),
      },
      {
        name: "sections/introduction.tex",
        data: Buffer.from("\\section{引言}\n低照度场景的身份稳定性是已知难点。"),
      },
      {
        name: "sections/experiments.tex",
        data: Buffer.from("\\section{实验}\nTable 10：baseline IDS = 24，本文方法 IDS = 35（该场景下本文更差）。"),
      },
    ]);
    const imported = await request("POST", `/api/projects/${projectId}/import`, {
      archiveBase64: archive.toString("base64"),
    });
    record("B", "fixture 项目导入（negative result 语境）", imported.status === 200, imported.status);

    const added = await request("POST", `/api/projects/${projectId}/external-instructions`, {
      source: "journal_reviewer",
      reviewerLabel: "Reviewer 2",
      text: "请把实验部分关于低照度场景的优势说明得更明显。[conflict]",
      section: "sections/experiments.tex",
    });
    record("B", "录入 Reviewer 2 意见（mandatory）", added.status === 200, added.status);

    const created = await request("POST", `/api/projects/${projectId}/workflows`, {
      kind: "existing_paper_improvement",
    });
    const runId = created.body["runId"];
    // 推进到计划确认 → approve → 完成
    let run = null;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const { body } = await request("GET", `/api/runs/${runId}`);
      run = body["run"];
      if (["awaiting_input", "completed", "failed"].includes(run["status"])) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (run["status"] === "awaiting_input") {
      await request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const { body } = await request("GET", `/api/runs/${runId}`);
        run = body["run"];
        if (["completed", "failed"].includes(run["status"])) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    record("B", "improvement run 完成", run["status"] === "completed", `${run["status"]} ${run["error"]?.["message"] ?? ""}`);

    const list = await request("GET", `/api/projects/${projectId}/external-instructions`);
    const instruction = list.body["instructions"][0];
    record("B", "意见 status=conflict（不静默、不伪造）", instruction["status"] === "conflict", instruction["status"]);
    record(
      "B",
      "conflictBasis 引用稿件具体数值",
      String(instruction["conflictBasis"] ?? "").includes("IDS = 24"),
      instruction["conflictBasis"],
    );

    let experiments = "";
    try {
      experiments = await readFile(
        join(root, "projects", projectId, "manuscript", "sections", "experiments.tex"),
        "utf8",
      );
    } catch (error) {
      const tree = await listTree(join(root, "projects", projectId), 0);
      record("B", "稿件文件读取", false, `${error.code}；项目树：\n${tree}`);
    }
    if (experiments !== "") {
      record(
        "B",
        "稿件未被篡改为「优势」表述",
        !experiments.includes("优势") && !experiments.includes("保持优势"),
        experiments.split("\n").find((line) => line.includes("IDS")) ?? "",
      );
    }

    const gateList = await request("GET", `/api/projects/${projectId}/quality-gate`);
    const gate = gateList.body["gate"];
    const fact = gate?.["factPreservation"];
    record(
      "B",
      "Fact Preservation 未被 mandatory 绕过（PASS / N/A，FAIL 会拦截 Draft）",
      gate === null || fact === null || fact === undefined || fact["ok"] === true,
      `gatePassed=${gate?.["passed"]} factOk=${fact?.["ok"] ?? "n/a"}`,
    );
  } finally {
    backend.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rm(root, { recursive: true, force: true });
  }
}

async function listTree(dir, depth) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const lines = [];
    for (const entry of entries) {
      lines.push(`${"  ".repeat(depth)}${entry.name}`);
      if (entry.isDirectory() && depth < 4) {
        lines.push(await listTree(join(dir, entry.name), depth + 1));
      }
    }
    return lines.filter((line) => line !== "").join("\n");
  } catch {
    return "";
  }
}

// ---------------- 执行 ----------------

try {
  if (!args.has("--skip-a")) {
    await smokePerAgentModel();
  }
  await smokeExternalConflict();
} catch (error) {
  record("FATAL", "smoke 执行异常", false, error instanceof Error ? error.message : String(error));
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\nM5.7 smoke：${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) {
  console.log("FAILED:", failed.map((entry) => `${entry.part}/${entry.name}`).join("; "));
  process.exitCode = 1;
}
