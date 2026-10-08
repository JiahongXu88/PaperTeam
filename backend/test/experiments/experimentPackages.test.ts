import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ExperimentPackageService } from "../../src/experiments/ExperimentPackageService.js";
import { startTestStack, scriptedIdeaRuntime, type TestStack } from "../helpers/testStack.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
const fixture = (name: string) => join(import.meta.dirname, "..", "fixtures", "experiments", name);

async function setup(): Promise<{ stack: TestStack; projectId: string }> {
  const stack = await startTestStack(scriptedIdeaRuntime().runtime, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
  const created = await stack.request("POST", "/api/projects", { title: "Synthetic experiment package", researchIdea: "synthetic test", workflowKind: "idea_to_paper" });
  expect(created.status).toBe(201);
  return { stack, projectId: (created.body["project"] as { id: string }).id };
}

async function upload(stack: TestStack, projectId: string, name: string) {
  const bytes = await readFile(fixture(name));
  const response = await fetch(`http://127.0.0.1:${stack.port()}/api/projects/${projectId}/experiment-packages`, {
    method: "POST", headers: { "Content-Type": "application/zip", "X-Package-Name": name }, body: bytes,
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("experiment package ZIP and product chain", () => {
  it("rejects traversal, case collision, symlink and extreme compression before Source writes", async () => {
    const { stack, projectId } = await setup();
    for (const name of ["synthetic-malicious-traversal.zip", "synthetic-malicious-duplicate.zip", "synthetic-malicious-symlink.zip", "synthetic-malicious-ratio.zip"]) {
      const result = await upload(stack, projectId, name);
      expect(result.status, name).toBe(422);
      expect((result.body["error"] as { code: string }).code, name).toBe("EXPERIMENT_ARCHIVE_UNSAFE");
    }
    expect((await stack.stack.sources.list(projectId))).toHaveLength(0);
  });

  it("imports real ZIP bytes through existing parsers, preserves provenance, gates datasets until confirmation, and survives re-instantiation", async () => {
    const { stack, projectId } = await setup();
    const first = await upload(stack, projectId, "synthetic-normal.zip");
    expect(first.status).toBe(201);
    const item = first.body["package"] as { packageId: string; files: Array<{ path: string; sourceId?: string; parseStatus: string }>; observations: Array<{ path: string; metric: string; value: number; row?: number; column?: string; sourceId: string; blockId: string }>; relationCandidates: Array<{ groupId: string; matchedFields: string[] }>; groups: Array<{ id: string; status: string }> };
    expect(item.files.some((entry) => entry.path === "main/results.csv" && entry.parseStatus === "ok" && entry.sourceId)).toBe(true);
    expect(item.files.some((entry) => entry.path === "logs/main_train.log" && entry.parseStatus === "unsupported")).toBe(true);
    expect(item.observations).toContainEqual(expect.objectContaining({ path: "main/results.csv", metric: "HOTA", value: 63.4, row: 2, column: "D" }));
    expect(item.relationCandidates).toContainEqual(expect.objectContaining({ groupId: "main", matchedFields: expect.arrayContaining(["model", "dataset", "seed"]) }));
    const second = await upload(stack, projectId, "synthetic-normal.zip");
    expect(second.status).toBe(200);
    expect(second.body["created"]).toBe(false);
    const before = await stack.request("GET", `/api/projects/${projectId}/figures/datasets`);
    expect(before.body["datasets"]).toEqual([]);
    const confirmed = await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${item.packageId}/confirm`, { groupIds: ["main", "baseline-a", "ablation-no-attention", "shared-config"] });
    expect(confirmed.status).toBe(200);
    const data = await stack.request("GET", `/api/projects/${projectId}/figures/datasets`);
    const datasets = data.body["datasets"] as Array<{ sourceId: string; blockId: string; datasetHash: string; columns: string[] }>;
    const mainSource = item.files.find((entry) => entry.path === "main/results.csv")!.sourceId!;
    const configSource = item.files.find((entry) => entry.path === "config/model.json")!.sourceId!;
    expect(datasets.some((entry) => entry.sourceId === configSource)).toBe(false);
    const main = datasets.find((entry) => entry.sourceId === mainSource)!;
    expect(main.datasetHash).toMatch(/^[a-f0-9]{64}$/);
    expect(main.columns).toContain("HOTA");
    const datasetResponse = await stack.request("GET", `/api/projects/${projectId}/figures/datasets/${main.sourceId}/${main.blockId}`);
    const dataset = datasetResponse.body["dataset"] as { inlineDataset: { columns: string[]; rows: unknown[][] } };
    expect(dataset.inlineDataset.rows[0]).toContain(63.4);
    const spec = { plotType: "bar", data: { origin: { sourceId: main.sourceId, blockId: main.blockId }, datasetHash: main.datasetHash, x: ["method"], series: [{ name: "HOTA", column: "HOTA" }], inlineDataset: dataset.inlineDataset }, axis: { xLabel: "Method", yLabel: "HOTA" }, title: "Synthetic HOTA" };
    const generated = await stack.request("POST", `/api/projects/${projectId}/figures/generate`, { kind: "plot", spec });
    expect(generated.status).toBe(200);
    const figId = ((generated.body["figure"] as { record: { figId: string } }).record).figId;
    const manuscript = stack.store.manuscriptDir(projectId);
    await mkdir(join(manuscript, "sections"), { recursive: true });
    await writeFile(join(manuscript, "outline.json"), JSON.stringify({ title: "Synthetic Test Paper", sections: [{ id: "results", file: "results.tex", title: "Results" }] }));
    await writeFile(join(manuscript, "main.tex"), "\\documentclass[UTF8]{ctexart}\n\\begin{document}\n\\input{sections/results}\n\\end{document}\n");
    await writeFile(join(manuscript, "sections", "results.tex"), "\\section{Synthetic Results}\n");
    const insertion = await stack.request("POST", `/api/projects/${projectId}/figures/insert`, { figId, mode: "append", sectionId: "results", caption: "Synthetic HOTA values from the uploaded test package.", label: "synthetic-hota", referenceSentence: "Synthetic result shown in \\ref{fig:synthetic-hota}." });
    expect(insertion.status).toBe(200);
    expect(await readFile(join(manuscript, "sections", "results.tex"), "utf8")).toContain(`figs/generated/${figId}.pdf`);
    const build = await stack.request("POST", `/api/projects/${projectId}/build`, {});
    expect(build.status).toBe(200);
    const evidence = await stack.request("POST", `/api/projects/${projectId}/sources/${mainSource}/records/evidence`, { row: 2, column: "D", claim: "The synthetic test observation has HOTA 63.4." });
    expect(evidence.status).toBe(201);
    expect(evidence.body["evidence"]).toEqual(expect.objectContaining({ verificationLevel: "user_confirmed", verificationStatus: "unverified" }));
    await stack.stack.retrieval.rebuild(projectId);
    expect((await stack.stack.retrieval.search(projectId, "synthetic-protocol-v1")).results).toHaveLength(0);
    const reloaded = new ExperimentPackageService(stack.store, stack.stack.sources, stack.stack.ingestion, stack.stack.parsedDocuments);
    expect((await reloaded.get(projectId, item.packageId)).groups.find((entry) => entry.id === "main")?.status).toBe("confirmed");
    const edited = await stack.request("PATCH", `/api/projects/${projectId}/experiment-packages/${item.packageId}`, { path: "main/results.csv", role: "baseline_result", groupId: "baseline-edited" });
    expect(edited.status).toBe(200);
    expect((await reloaded.get(projectId, item.packageId)).groups.find((entry) => entry.id === "main")?.status).not.toBe("confirmed");
  });

  it("keeps partial parser failures visible and rejects confirmation after Source deletion or manifest corruption", async () => {
    const { stack, projectId } = await setup();
    const result = await upload(stack, projectId, "synthetic-incomplete.zip");
    expect(result.status).toBe(201);
    const item = result.body["package"] as { packageId: string; status: string; files: Array<{ path: string; parseStatus: string; sourceId?: string }> };
    expect(item.status).toBe("partial");
    expect(item.files.find((entry) => entry.path === "broken.csv")?.parseStatus).toBe("failed");
    expect(item.files.find((entry) => entry.path === "unknown.bin")?.parseStatus).toBe("unsupported");
    const sourceId = item.files.find((entry) => entry.path === "results.csv")?.sourceId!;
    await stack.stack.sources.remove(projectId, sourceId);
    const confirm = await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${item.packageId}/confirm`, { groupIds: ["main"] });
    expect(confirm.status).toBe(409);
    const manifest = join(stack.store.projectDir(projectId), "experiments", item.packageId, "manifest.json");
    await writeFile(manifest, "{broken json", "utf8");
    const get = await stack.request("GET", `/api/projects/${projectId}/experiment-packages/${item.packageId}`);
    expect(get.status).toBe(500);
    expect((get.body["error"] as { code: string }).code).toBe("EXPERIMENT_MANIFEST_CORRUPTED");
  });

  it("holds incompatible protocols as conflicts and persists an author grouping edit", async () => {
    const { stack, projectId } = await setup();
    const conflict = await upload(stack, projectId, "synthetic-protocol-conflict.zip");
    expect(conflict.status).toBe(201);
    const item = conflict.body["package"] as { packageId: string; groups: Array<{ id: string; status: string; conflicts: string[] }> };
    expect(item.groups.find((group) => group.id === "main")?.status).toBe("conflict");
    expect(item.groups.find((group) => group.id === "main")?.conflicts).toContainEqual(expect.stringContaining("protocol 不一致"));
    const confirm = await stack.request("POST", `/api/projects/${projectId}/experiment-packages/${item.packageId}/confirm`, { groupIds: ["main"] });
    expect(confirm.status).toBe(409);
    const edited = await stack.request("PATCH", `/api/projects/${projectId}/experiment-packages/${item.packageId}`, { path: "main/results.csv", role: "baseline_result", groupId: "baseline-edited" });
    expect(edited.status).toBe(200);
    const reloaded = await stack.request("GET", `/api/projects/${projectId}/experiment-packages/${item.packageId}`);
    expect(((reloaded.body["package"] as { files: Array<{ groupId: string }> }).files[1]?.groupId)).toBe("baseline-edited");
  });
});
