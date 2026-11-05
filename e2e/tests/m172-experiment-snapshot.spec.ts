import { expect, test } from "./fixtures.js";

/**
 * M17.2 实验事实快照（合成数据，SYNTHETIC，无真实材料）：
 * - 直接选择多个 CSV（不打 ZIP）上传 → 浏览器端确定性打包，复用实验包上传链路；
 * - 文件 metadata 声明单位：详细表比例（0–1）与汇总表百分数同一结果 → 未声明前标度冲突、冻结按钮不可用，声明后解除；
 * - 「用于本文写作」后冻结快照：对比表把绝对差写成「个百分点」、相对变化单列；workflow-context 带快照版本。
 * 全程只操作本测试创建的项目。
 */

const BASELINE = "method,dataset,protocol,HOTA (%),IDSW\nbase,SYN-A,TE-v1,47.250,820\n";
const MAIN = "method,dataset,protocol,HOTA (%),IDSW\nours,SYN-A,TE-v1,49.830,778\n";
const MAIN_DETAILED = "seq,HOTA\nCOMBINED,0.49830\n";

test.describe.serial("M17.2 实验事实快照", () => {
  test("多文件上传 → 单位声明解除标度冲突 → 冻结 → 确定性对比", async ({ page, request }) => {
    test.setTimeout(180_000);
    const created = await request.post("/api/projects", { data: { title: `M17-2 E2E Snapshot ${Date.now().toString(36)}`, researchIdea: "Synthetic snapshot acceptance. Safe to delete.", workflowKind: "idea_to_paper" } });
    const projectId = ((await created.json()) as { project: { id: string } }).project.id;
    await page.goto(`/projects/${projectId}?tab=experiments`);

    await page.getByLabel("选择实验 ZIP").setInputFiles([
      { name: "baseline_results.csv", mimeType: "text/csv", buffer: Buffer.from(BASELINE) },
      { name: "main_results.csv", mimeType: "text/csv", buffer: Buffer.from(MAIN) },
      { name: "main_detailed.csv", mimeType: "text/csv", buffer: Buffer.from(MAIN_DETAILED) },
    ]);
    await page.getByRole("button", { name: "上传实验包" }).click();
    await expect(page.getByRole("heading", { name: "experiment-files-3.zip" })).toBeVisible({ timeout: 120_000 });

    // 详细表补方法 / 数据集 / 协议（文件内没有这些列）
    await page.getByRole("region", { name: "文件清单" }).locator("summary").first().click();
    const editor = page.getByTestId("file-metadata-main_detailed.csv");
    await editor.locator("summary").click();
    await editor.getByLabel("main_detailed.csv 方法").fill("ours");
    await editor.getByLabel("main_detailed.csv 数据集").fill("SYN-A");
    await editor.getByLabel("main_detailed.csv 评测协议").fill("TE-v1");
    await editor.getByRole("button", { name: "保存 metadata" }).click();
    await expect(page.getByRole("status").filter({ hasText: "文件 metadata 已更新" })).toBeVisible();

    await page.getByTestId("use-for-paper-submit").click();
    await expect(page.getByRole("status").filter({ hasText: "已更新用于当前论文的实验范围" })).toBeVisible();
    // 单位未声明：0.49830 与 49.830 → 标度冲突；冻结不可用
    const conflicts = page.getByTestId("snapshot-conflicts");
    await expect(conflicts).toContainText("标度未确认");
    await expect(conflicts).toContainText("0.49830");
    await expect(page.getByRole("button", { name: "冻结为新版本快照" })).toBeDisabled();

    // 声明详细表为比例 → 重新确认 → 冲突解除（编辑器保存后保持展开）
    await editor.evaluate((element) => { (element as HTMLDetailsElement).open = true; });
    await editor.getByLabel("main_detailed.csv 指标单位").fill("HOTA=ratio");
    await editor.getByRole("button", { name: "保存 metadata" }).click();
    await expect(page.getByRole("status").filter({ hasText: "文件 metadata 已更新" })).toBeVisible();
    await page.getByTestId("use-for-paper-submit").click();
    await expect(page.getByTestId("snapshot-conflicts")).toHaveCount(0);

    const table = page.getByTestId("snapshot-comparisons");
    await expect(table).toContainText("+2.580 个百分点");
    await expect(table).toContainText("+5.46%（相对）");
    await page.getByRole("button", { name: "冻结为新版本快照" }).click();
    await expect(page.getByTestId("snapshot-active")).toContainText("efs-0001");
    await expect(page.getByTestId("snapshot-active")).toContainText("有效");

    const context = await request.get(`/api/projects/${projectId}/experiment-packages/workflow-context`);
    const body = (await context.json()) as { snapshot?: { snapshotId: string; status: string }; comparisons?: Array<{ absoluteDifference: string }> };
    expect(body.snapshot).toMatchObject({ snapshotId: "efs-0001", status: "valid" });
    expect(body.comparisons?.some((comparison) => comparison.absoluteDifference.startsWith("+2.58"))).toBe(true);
  });
});
