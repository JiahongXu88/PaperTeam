/**
 * M14.6：学位论文「正式 Evidence → 引用 → 参考文献」闭环的共享驱动（确定性 E2E 与真实 LaTeX 验收共用）。
 *
 * 真实来源元数据（2026-10-16 Crossref 实时核验；fixture 不访问网络、不伪造 DOI）：
 *   10.1146/annurev-control-090419-075625  Hewing et al. 2020, Annu. Rev. Control Robot. Auton. Syst. 3:269-296
 *   10.1109/TRO.2021.3098436               Shi et al. 2022, IEEE T-RO 38:1063-1079
 *   10.1109/IROS.2017.8202165              Preiss et al. 2017, IROS pp. 250-257
 *   10.1109/CDC49753.2023.10383632         Li et al. 2023, IEEE CDC pp. 2122-2128
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import type { TestStack } from "./testStack.js";

export const REAL_REFERENCES = [
  {
    fileName: "hewing2020.pdf",
    title: "Learning-Based Model Predictive Control: Toward Safe Learning in Control",
    authors: ["Lukas Hewing", "Kim P. Wabersich", "Marcel Menner", "Melanie N. Zeilinger"],
    year: 2020,
    doi: "10.1146/annurev-control-090419-075625",
    venue: "Annual Review of Control, Robotics, and Autonomous Systems",
    claim: "学习型模型预测控制将学到的模型或约束纳入 MPC 以在保证安全的前提下提升性能。",
    chunk: "Learning-based MPC combines learned system models or constraints with model predictive control to improve performance while maintaining safety guarantees.",
  },
  {
    fileName: "shi2022.pdf",
    title: "Neural-Swarm2: Planning and Control of Heterogeneous Multirotor Swarms Using Learned Interactions",
    authors: ["Guanya Shi", "Wolfgang Hönig", "Xichen Shi", "Yisong Yue", "Soon-Jo Chung"],
    year: 2022,
    doi: "10.1109/TRO.2021.3098436",
    venue: "IEEE Transactions on Robotics",
    claim: "多旋翼集群近距飞行中的气动交互可由神经网络学习并用于规划与控制。",
    chunk: "Neural-Swarm2 learns the aerodynamic interactions between multirotors in close proximity and uses the learned model for planning and control.",
  },
  {
    fileName: "preiss2017.pdf",
    title: "Downwash-aware trajectory planning for large quadrotor teams",
    authors: ["James A. Preiss", "Wolfgang Hönig", "Nora Ayanian", "Gaurav S. Sukhatme"],
    year: 2017,
    doi: "10.1109/IROS.2017.8202165",
    venue: "2017 IEEE/RSJ International Conference on Intelligent Robots and Systems (IROS)",
    claim: "下洗效应在大规模四旋翼编队轨迹规划中须显式建模为竖直方向的安全约束。",
    chunk: "Downwash from quadrotors flying above must be modeled as an asymmetric vertical safety constraint in trajectory planning for large teams.",
  },
  {
    fileName: "li2023.pdf",
    title: "Nonlinear MPC for Quadrotors in Close-Proximity Flight with Neural Network Downwash Prediction",
    authors: ["Jinjie Li", "Liang Han", "Haoyang Yu", "Yuheng Lin", "Qingdong Li", "Zhang Ren"],
    year: 2023,
    doi: "10.1109/CDC49753.2023.10383632",
    venue: "2023 62nd IEEE Conference on Decision and Control (CDC)",
    claim: "将神经网络下洗预测器嵌入 NMPC 可在近距飞行中补偿下洗扰动。",
    chunk: "A neural network downwash predictor is integrated into nonlinear MPC to compensate downwash disturbance during close-proximity flight.",
  },
] as const;

/** 在项目中登记真实元数据来源并写入正式 Evidence（verified + sourceId + chunk 锚点） */
export async function seedFormalEvidence(stack: TestStack, projectId: string): Promise<string[]> {
  const sourceIds: string[] = [];
  for (const ref of REAL_REFERENCES) {
    const { source } = await stack.stack.sources.add(projectId, {
      fileName: ref.fileName,
      content: Buffer.from(`%PDF-1.5\n${ref.title}\n${ref.chunk}`, "utf8"),
      sourceRole: "evidence",
      metadata: { title: ref.title, authors: [...ref.authors], year: ref.year, doi: ref.doi, venue: ref.venue },
    });
    sourceIds.push(source.sourceId);
    await stack.stack.evidence.append(
      projectId,
      {
        claim: ref.claim,
        quote: ref.chunk,
        source: { sourceId: source.sourceId, title: ref.title, authors: [...ref.authors], year: ref.year, doi: ref.doi },
        location: { page: 1, section: "related_work", chunk: ref.chunk.slice(0, 96) },
        verificationStatus: "verified",
        verificationMethod: "test_fixture:crossref_verified_metadata",
        supportStrength: "direct",
        verificationLevel: "fulltext",
      },
      "test_fixture",
    );
  }
  return sourceIds;
}

export interface ThesisRunView {
  status: string;
  awaiting?: { stageId: string; payload?: Record<string, unknown> };
  stageResults?: Record<string, Record<string, unknown>>;
  completion?: { label: string; summary?: Record<string, unknown> };
  error?: { message?: string };
}

/**
 * 种子研究输入（含 0.724 表格事实）+ 事实确认 + 正式 Evidence → 启动 thesis_from_papers 并驱动全部 HITL 到终态。
 */
export async function runThesisCitationClosure(stack: TestStack, title: string): Promise<{ projectId: string; runId: string; run: ThesisRunView }> {
  const created = await stack.request("POST", "/api/projects", { title, language: "zh", documentType: "master_thesis" });
  expect(created.status).toBe(201);
  const projectId = (created.body["project"] as { id: string })["id"];

  const pdfText = "我们提出显著性检测方法 LSM。该方法在 DUTS 数据集上的 S 指标达到 0.724，超过基线的 0.667。消融实验见表1。";
  const { source } = await stack.stack.sources.add(projectId, { fileName: "cite-paper.pdf", content: Buffer.from(`%PDF-1.5\n${pdfText}`, "utf8") });
  await stack.stack.parsedDocuments.save(projectId, {
    schemaVersion: 1,
    sourceId: source.sourceId,
    fileName: "cite-paper.pdf",
    storedFileName: "cite-paper.pdf",
    kind: "pdf",
    mimeType: "application/pdf",
    parser: { id: "test-fixture", version: "1" },
    parseMode: "structured",
    status: "ok",
    pageCount: 2,
    blocks: [
      { blockId: "B0001", type: "text", text: pdfText, provenance: { page: 1 } },
      { blockId: "B0002", type: "table", headers: ["Method", "S ↑"], rows: [["Ours", "0.724"], ["Base", "0.667"]], rowCount: 2, columnCount: 2, caption: "表1 消融结果", provenance: { page: 2 } },
    ],
    counts: { text: 1, table: 1 },
    notes: [],
    contentHash: source.contentHash!,
    parsedAt: new Date().toISOString(),
  } as never);
  const textLayerDir = join(stack.store.projectDir(projectId), "research", "text-layers");
  await mkdir(textLayerDir, { recursive: true });
  await writeFile(
    join(textLayerDir, `${source.sourceId}-${source.contentHash!.slice(0, 12)}.json`),
    JSON.stringify({ sourceId: source.sourceId, contentHash: source.contentHash, parser: { id: "seed" }, pages: [{ page: 1, text: pdfText }, { page: 2, text: "Method S ↑ Ours 0.724 Base 0.667 表1 消融结果" }] }),
    "utf8",
  );
  const registered = await stack.request("POST", `/api/projects/${projectId}/research-inputs`, { sourceId: source.sourceId, inputType: "published_paper", title: "LSM 显著性方法", provenanceUri: "https://example.org/lsm" });
  expect(registered.status).toBeLessThan(300);
  const inputId = (registered.body["input"] as { inputId: string })["inputId"];
  await stack.stack.researchInputs.registry.refreshParse(projectId, inputId);
  await stack.stack.researchInputs.extractFacts(projectId, inputId);
  await stack.stack.researchInputs.verifyFacts(projectId, inputId);
  const facts = ((await stack.request("GET", `/api/projects/${projectId}/research-inputs/facts?inputId=${inputId}`)).body["facts"] as Array<{ factId: string; verification?: { sourceCheck?: string } }>) ?? [];
  const verified = facts.filter((fact) => fact.verification?.["sourceCheck"] === "verified").map((fact) => fact.factId);
  expect(verified.length).toBeGreaterThan(0);
  expect((await stack.request("POST", `/api/projects/${projectId}/research-inputs/decisions`, { actor: { kind: "test_fixture" }, payload: { type: "fact_confirmation", factIds: verified, outcome: "confirmed" } })).status).toBeLessThan(300);

  const sourceIds = await seedFormalEvidence(stack, projectId);
  expect(sourceIds).toHaveLength(4);
  expect((await stack.stack.workflowServices.evidenceSelection.selectForWriting(projectId)).formal.length).toBe(4);

  const start = await stack.request("POST", `/api/projects/${projectId}/workflows`, { kind: "thesis_from_papers" });
  expect(start.status).toBe(202);
  const runId = start.body["runId"] as string;
  const deadline = Date.now() + 200_000;
  let run: ThesisRunView = { status: "" };
  for (;;) {
    run = ((await stack.request("GET", `/api/runs/${runId}`)).body["run"] ?? {}) as ThesisRunView;
    if (run.status === "awaiting_input" && run.awaiting !== undefined) {
      const { stageId, payload } = run.awaiting;
      let decision = "approve";
      let body: Record<string, unknown> = { actorKind: "test_fixture" };
      if (stageId === "hitl.scope_and_version") {
        const proposed = (payload?.["inputs"] as { proposed?: Array<{ inputId: string }> } | undefined)?.proposed ?? [];
        const contributions = (payload?.["contributions"] as Array<{ id: string; status: string }> | undefined) ?? [];
        const unconfirmed = contributions.filter((item) => item.status === "proposed").map((item) => item.id);
        if (proposed.length > 0) {
          decision = "include";
          body = { inputId: proposed[0]!.inputId, actorKind: "test_fixture" };
        } else if (unconfirmed.length > 0) {
          decision = "confirm_contribution";
          body = { contributionIds: unconfirmed, actorKind: "test_fixture" };
        }
      } else if (stageId === "hitl.revision_overflow" || stageId === "hitl.revision_stalled") {
        decision = "accept_draft";
      } else if (stageId === "hitl.author_decision") {
        const missing = (payload?.["missingChapters"] as Array<{ chapterId: string }> | undefined) ?? [];
        decision = missing.length > 0 ? "write_as_limitation" : "approve";
        body = { ...(missing.length > 0 ? { subject: missing[0]!.chapterId } : {}), actorKind: "test_fixture" };
      } else if (stageId === "hitl.style_polish") {
        decision = "skip";
      }
      const resume = await stack.request("POST", `/api/runs/${runId}/resume`, { decision, payload: body });
      if (resume.status >= 300) throw new Error(`resume 失败（${stageId}/${decision}）：${JSON.stringify(resume.body).slice(0, 300)}`);
      continue;
    }
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") break;
    if (Date.now() > deadline) throw new Error(`引用闭环驱动超时（${run.status}）`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { projectId, runId, run };
}
