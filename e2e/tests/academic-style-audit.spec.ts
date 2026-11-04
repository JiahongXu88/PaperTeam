import { deflateRawSync } from "node:zlib";

import { expect, test } from "./fixtures.js";

/**
 * M17.1 默认学术风格审查：真实 UI 可见性回归。
 *
 * 用户不勾选任何选项、不输入 Prompt：导入含一处样板自谦句的中文 LaTeX 工程 → 系统性改进（HITL 自动批准）→
 * Review 页「学术风格与防御性表达」卡显示 已审查 / 已定点修订（before/after）/ 免责声明，且无 AI 率。
 *
 * 运行前提：scripted 栈（与 evidence-gate.spec.ts 同一配方，PAPERTEAM_TEST_RUNTIME=scripted，无模型调用；
 * scripted Reviewer 对「粗浅的尝试」样板句报一条可删除的自谦，语义复核恒 EQUIVALENT——人工构造夹具），
 * 然后 PAPERTEAM_E2E_STYLE=1 运行；其它环境自动跳过。
 */

const ENABLED = process.env.PAPERTEAM_E2E_STYLE === "1";

function zip(entries: Array<{ name: string; text: string }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.text, "utf8");
    const compressed = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, compressed);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(8, 10);
    head.writeUInt32LE(compressed.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);
    offset += local.length + name.length + compressed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

const ARCHIVE = zip([
  { name: "main.tex", text: ["\\documentclass[UTF8]{ctexart}", "\\begin{document}", "\\input{sections/introduction}", "\\input{sections/experiments}", "\\input{sections/discussion}", "\\bibliographystyle{unsrt}", "\\bibliography{references}", "\\end{document}"].join("\n") },
  { name: "sections/introduction.tex", text: "\\section{引言}\n准确率提升 12.4% \\cite{a}。" },
  { name: "sections/experiments.tex", text: "\\section{实验}\n在两个数据集上验证。" },
  { name: "sections/discussion.tex", text: "\\section{讨论}\n在两个数据集上验证，MOTA 为 71.3 \\cite{a}。本文仅是一次粗浅的尝试，敬请批评指正。由于未在夜间场景数据上验证，结论能否推广到低照度条件尚不确定。" },
  { name: "references.bib", text: "@article{a, title={A Good Paper}, year={2020}}" },
]);

test.describe("M17.1 默认学术风格审查（Review 页可见）", () => {
  test.skip(!ENABLED, "PAPERTEAM_E2E_STYLE 未设置（需要 scripted 栈）");

  let projectId = "";

  test.afterEach(async ({ request }) => {
    if (projectId === "") return;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await request.post(`/api/projects/${projectId}/archive`)).ok()) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
    await request.delete(`/api/projects/${projectId}`);
  });

  test("无需任何设置：审查覆盖 / 定点修订对比 / 免责声明可见", async ({ page, request }) => {
    test.setTimeout(180_000);
    const created = await request.post("/api/projects", { data: { title: "M17.1 风格默认必检 E2E" } });
    projectId = ((await created.json()) as { project: { id: string } }).project.id;
    expect((await request.post(`/api/projects/${projectId}/import`, { data: { archiveBase64: ARCHIVE.toString("base64") } })).ok()).toBe(true);
    const run = await request.post(`/api/projects/${projectId}/workflows`, { data: { kind: "existing_paper_improvement" } });
    const runId = ((await run.json()) as { runId: string }).runId;
    const deadline = Date.now() + 150_000;
    for (;;) {
      const state = ((await (await request.get(`/api/runs/${runId}`)).json()) as { run: { status: string; awaiting?: { stageId: string; options?: string[] } } }).run;
      if (state.status === "completed") break;
      if (state.status === "failed" || state.status === "cancelled" || Date.now() > deadline) throw new Error(`run ${state.status}（${state.awaiting?.stageId ?? "-"}）`);
      if (state.status === "awaiting_input") {
        const options = state.awaiting?.options ?? [];
        const decision = options.includes("accept_draft") ? "accept_draft" : options.includes("approve") ? "approve" : options[0];
        await request.post(`/api/runs/${runId}/resume`, { data: { decision } });
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
    }

    await page.goto(`/projects/${projectId}?tab=review`);
    const card = page.getByTestId("academic-style-audit-card");
    await expect(card).toBeVisible();
    await expect(page.getByTestId("academic-style-coverage")).toHaveText("已审查");
    await expect(page.getByTestId("academic-style-revision")).toContainText("→ rev");
    await expect(page.getByTestId("academic-style-fixed")).toContainText("本文仅是一次粗浅的尝试");
    await expect(page.getByTestId("academic-style-fixed")).toContainText("（整句删除）");
    await expect(card).toContainText("不是对作者身份或 AI 生成来源的鉴定");
    // 免责声明里会出现「不输出 AI 率」字样；断言的是不存在任何数值化的 AI 率 / 概率
    await expect(card).not.toContainText(/AI ?(率|概率)\s*[:：]?\s*\d/);
    await page.screenshot({ path: "test-results/m17-1-style-card.png", fullPage: true });
  });
});
