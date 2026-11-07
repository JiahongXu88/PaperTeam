import { expect, test } from "./fixtures.js";

/**
 * M17.2.1 作者方法事实（合成数据，SYNTHETIC，无真实材料）：
 * - 研究想法原文中的「符号 = 值」与「去掉 X」被预填为候选，明确标注未确认；
 * - 作者在表中修正取值、补充适用配置后确认 → 生成 mfs-0001；workflow-context 带有效方法事实；
 * - 撤销后显示「已撤销」，workflow-context 不再含权威事实。
 * 全程只操作本测试创建的项目。
 */

const IDEA = "Synthetic method-facts acceptance (safe to delete): 门控过滤模块，去掉邻域门控、λ=0.35、k=12 的规则（cfg-a）。";

test.describe.serial("M17.2.1 研究方法事实", () => {
  test("候选预填 → 作者修正并确认 → 写作上下文消费 → 撤销失效", async ({ page, request }) => {
    const created = await request.post("/api/projects", { data: { title: `M17-2-1 E2E MethodFacts ${Date.now().toString(36)}`, researchIdea: IDEA, workflowKind: "idea_to_paper" } });
    const projectId = ((await created.json()) as { project: { id: string } }).project.id;
    await page.goto(`/projects/${projectId}?tab=experiments`);

    const section = page.getByRole("region", { name: "研究方法事实" });
    await expect(section.getByTestId("method-facts-none")).toContainText("未经确认");
    const editor = section.getByTestId("method-facts-editor");
    await expect(editor.getByLabel("符号或组件名")).toHaveCount(3);
    await expect(editor.getByLabel("组件状态")).toHaveValue("REMOVED");

    // 作者修正：k 的适用配置补为 cfg-a
    const kRow = editor.locator("tr").filter({ has: page.locator('input[value="k"]') });
    await kRow.getByLabel("适用配置").fill("cfg-a");
    await section.getByTestId("method-facts-confirm").click();
    await expect(section.getByTestId("method-facts-message")).toContainText("mfs-0001");
    await expect(section.getByTestId("method-facts-active")).toContainText("有效");

    const context = await (await request.get(`/api/projects/${projectId}/experiment-packages/method-facts`)).json() as { state: { status: string; sheet: { facts: Array<{ subject: string; scope: string[]; valueText?: string }> } } };
    expect(context.state.status).toBe("valid");
    expect(context.state.sheet.facts.find((fact) => fact.subject === "k")).toMatchObject({ valueText: "12", scope: ["cfg-a"] });

    await section.getByLabel("撤销原因").fill("E2E 撤销");
    await section.getByTestId("method-facts-revoke").click();
    await expect(section.getByTestId("method-facts-active")).toContainText("已撤销");
    const revoked = await (await request.get(`/api/projects/${projectId}/experiment-packages/method-facts`)).json() as { state: { status: string } };
    expect(revoked.state.status).toBe("revoked");
  });
});
