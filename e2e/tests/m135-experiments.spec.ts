import { crc32 } from "node:zlib";

import { expect, test } from "./fixtures.js";

/**
 * M13.5 实验 split 核对 + 研究论文实验数据入口（合成数据，无真实材料）：
 * - 研究论文创建表单说明实验数据在创建后上传；项目概览有显著上传入口；
 * - 上传合成多 split ZIP（单文件 Dev25 / Confirmation13 / Full38）→
 *   摘要卡 → 范围表（三行）→ 多范围组不能整组确认 → 按范围确认 +
 *   显式授权后才进入 workflow-context（隔离边界）；
 * - 指标浏览按范围筛选 + 分页；文件清单搜索。
 * 全程只操作本测试创建的项目（e2e 栈本身用隔离 RUNTIME_ROOT 启动）。
 */

function buildStoreZip(entries: Array<{ path: string; data: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const data = Buffer.from(entry.data, "utf8");
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // store
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

const MULTI_SPLIT_ZIP = buildStoreZip([
  { path: "main/results.csv", data: "method,dataset,split,HOTA,IDSW\nOurs,Syn,Dev25,60.1,12\nOurs,Syn,Confirmation13,62.3,10\nOurs,Syn,Full38,61.5,11\n" },
  { path: "results/baseline-a0.csv", data: "method,dataset,split,HOTA,IDSW\nBase,Syn,Dev25,55.0,17\n" },
  { path: "notes/readme.md", data: "synthetic notes\n" },
]);

test.describe.serial("M13.5 实验范围核对与上传入口", () => {
  test("研究论文创建：说明实验数据上传时机 + 概览上传入口直达实验数据页", async ({ page }) => {
    await page.goto("/projects/new");
    await page.getByLabel(/论文标题/).fill(`M13-5 E2E Split Scopes ${Date.now().toString(36)}`);
    await page.getByLabel("研究想法", { exact: true }).fill("Synthetic multi-split acceptance. Safe to delete.");
    // 创建表单解释实验数据在创建后上传（不要求创建时就有）
    await expect(page.getByTestId("experiment-data-hint")).toContainText("创建项目后");
    await page.getByRole("button", { name: "创建项目" }).click();
    await expect(page).toHaveURL(/\/projects\/p-[a-z0-9]+$/, { timeout: 60_000 });

    // 概览：显著的上传实验数据入口
    const card = page.getByTestId("experiment-data-card");
    await expect(card).toBeVisible();
    await card.getByTestId("upload-experiment-data-cta").click();
    await expect(page.getByRole("tabpanel", { name: /实验数据包/ })).toBeVisible();
  });

  test("上传多 split ZIP → 摘要卡 + 范围表；多范围组不能整组确认", async ({ page, request }) => {
    test.setTimeout(180_000);
    await page.goto("/projects");
    const projectLink = page.getByRole("link", { name: /M13-5 E2E Split Scopes/ }).first();
    await projectLink.click();
    await expect(page).toHaveURL(/\/projects\/p-[a-z0-9]+$/, { timeout: 60_000 });
    const projectId = page.url().split("/").pop() ?? "";
    await page.getByRole("tab", { name: "实验数据包" }).click();

    await page.getByLabel("选择实验 ZIP").setInputFiles({ name: "m135-multi-split.zip", mimeType: "application/zip", buffer: MULTI_SPLIT_ZIP });
    await page.getByRole("button", { name: "上传实验包" }).click();
    await expect(page.getByRole("heading", { name: /m135-multi-split\.zip/ })).toBeVisible({ timeout: 120_000 });

    // 摘要卡：文件 3、指标 8
    await expect(page.locator(".experiment-summary-card").filter({ hasText: "指标观测" }).locator(".experiment-summary-value")).toHaveText("8");
    // 范围表：main 组三行（Dev25 / Confirmation13 / Full38），组卡片无「确认此组」按钮
    const scopeTable = page.getByTestId("scope-table-main");
    await expect(scopeTable).toBeVisible();
    await expect(scopeTable.locator("tbody tr")).toHaveCount(3);
    await expect(scopeTable.getByText("Dev25", { exact: true })).toBeVisible();
    await expect(scopeTable.getByText("Confirmation13", { exact: true })).toBeVisible();
    await expect(scopeTable.getByText("Full38", { exact: true })).toBeVisible();
    const mainGroup = page.locator("details.experiment-group").filter({ has: page.locator("code", { hasText: /^main$/ }) });
    await expect(mainGroup).not.toContainText("确认此组");
    await expect(mainGroup).toContainText("请在上表按范围分别确认");

    // 未确认：workflow-context 为空（隔离缺省）
    const before = await request.get(`/api/projects/${projectId}/experiment-packages/workflow-context`);
    expect((await before.json() as { observations: unknown[] }).observations).toHaveLength(0);
  });

  test("按范围确认 → 显式授权进入工作流；未授权范围隔离", async ({ page, request }) => {
    test.setTimeout(180_000);
    await page.goto("/projects");
    await page.getByRole("link", { name: /M13-5 E2E Split Scopes/ }).first().click();
    const projectId = page.url().split("/").pop() ?? "";
    await page.getByRole("tab", { name: "实验数据包" }).click();

    // 定向确认 main@Dev25（范围行按码位序排列，first() 会命中 Confirmation13）
    await page.getByTestId("scope-row-main@Dev25").getByRole("button", { name: "确认此范围" }).click();
    await expect(page.getByText(/作者确认已保存/)).toBeVisible({ timeout: 30_000 });
    // baseline-a0 是单范围组：确认此组
    const baselineGroup = page.locator("details.experiment-group").filter({ has: page.locator("code", { hasText: /^baseline-a0$/ }) });
    await baselineGroup.getByRole("button", { name: "确认此组" }).click();
    await expect(page.getByText(/作者确认已保存/)).toBeVisible({ timeout: 30_000 });

    // main@Dev25 已确认但仍未授权 → context 仍无 main 观测（只有 baseline 自动放行）
    let context = await (await request.get(`/api/projects/${projectId}/experiment-packages/workflow-context`)).json() as { observations: Array<{ groupId: string; split?: string }> };
    expect(context.observations.every((observation) => observation.groupId !== "main")).toBe(true);

    // 显式授权 main@Dev25 → main 的 Dev25 观测进入，其余范围仍隔离
    const devRow = page.getByTestId("scope-row-main@Dev25");
    await devRow.getByRole("button", { name: "允许进入工作流" }).click();
    await expect(devRow.getByText("允许进入工作流")).toBeVisible({ timeout: 30_000 });
    context = await (await request.get(`/api/projects/${projectId}/experiment-packages/workflow-context`)).json() as { observations: Array<{ groupId: string; split?: string }> };
    const mainObservations = context.observations.filter((observation) => observation.groupId === "main");
    expect(mainObservations.length).toBe(2);
    expect(mainObservations.every((observation) => observation.split === "Dev25")).toBe(true);
  });

  test("指标浏览：按范围筛选与分页；文件清单搜索", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/projects");
    await page.getByRole("link", { name: /M13-5 E2E Split Scopes/ }).first().click();
    await page.getByRole("tab", { name: "实验数据包" }).click();

    // 指标浏览：范围筛选只剩 Dev25 的观测（main 2 + baseline 2 = 4）
    await page.getByLabel("按评测范围筛选").selectOption("Dev25");
    await expect(page.getByText(/共 4 条/)).toBeVisible({ timeout: 30_000 });
    // 来源定位包含路径与行列
    await expect(page.locator("td code", { hasText: "main/results.csv" }).first()).toBeVisible();

    // 文件清单：搜索过滤（限定文件表；指标表的来源定位列也含该路径）
    const filesDetails = page.locator("details").filter({ hasText: /^文件清单/ });
    await filesDetails.first().locator("> summary").click();
    await page.getByLabel("搜索文件").fill("baseline");
    await expect(page.getByTestId("file-row-results/baseline-a0.csv")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("file-row-main/results.csv")).toBeHidden();
  });
});
