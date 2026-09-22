import { existsSync } from "node:fs";
import { expect, test } from "./fixtures.js";
import { resolvePdfPath } from "./fixtures.js";

/**
 * M9.3 Literature FullText Activation 的浏览器级 E2E（真实 backend + 真实网络）：
 *
 *   1. 文献库全文状态列：metadata-only 条目「全文未获取」；有文件条目「全文已获取」；
 *   2. 单篇「获取全文」：arXiv 条目（1801.00653，小体积可控）真实走
 *      resolver → 下载 → 挂载 → 状态列翻转为「全文已获取」；
 *   3. 勾选批量 + 混合 summary：arXiv 条目 + url-only 条目（Web 候选定位）
 *      一起批量 → 汇总行如实呈现「已获取 1 ｜ 不可自动获取 1」；
 *   4. 手动上传 PDF fallback：url-only 条目上传本地 PDF → 全文已获取；
 *   5. Evidence 边界：全程 GET /evidence 为空（全文 ≠ Evidence）。
 *
 * 网络依赖：arxiv.org（~110KB PDF，本机带宽实测 <60s 下载帽内）；不依赖模型。
 */

const STAMP = `${Date.now().toString(36)}`;
const TITLE = `E2E M9.3 全文激活 ${STAMP}`;
/** 小体积真实 arXiv 论文（~110KB）：与 scripts/m93-fulltext-smoke.mjs 同选型理由 */
const ARXIV_ID = "1801.00653";

/** 上传用本地 PDF：优先仓库 fixture（离线可控），env 可覆盖 */
function manualPdfPath(): string {
  const fromEnv = process.env.PAPERTEAM_E2E_FULLTEXT_PDF;
  if (fromEnv !== undefined && fromEnv.trim() !== "" && existsSync(fromEnv)) {
    return fromEnv;
  }
  return resolvePdfPath();
}

test.describe.serial("M9.3 文献库全文激活", () => {
  let projectId = "";

  test.afterAll(async ({ request }) => {
    if (projectId !== "") {
      await request.post(`/api/projects/${projectId}/archive`);
      await request.delete(`/api/projects/${projectId}`);
    }
  });

  test("全文状态列 + 单篇获取 + 批量混合 summary + 手动上传 fallback", async ({ page }) => {
    test.setTimeout(240_000);

    // 建项目（idea 入口；全文链路不依赖模型）
    await page.goto("/projects/new");
    await page.getByLabel(/论文标题/).fill(TITLE);
    await page.getByLabel("研究想法", { exact: true }).fill("E2E：M9.3 文献全文激活。");
    await page.getByRole("button", { name: "创建项目" }).click();
    await expect(page).toHaveURL(/\/projects\/p-[a-z0-9]+$/);
    projectId = new URL(page.url()).pathname.split("/", 3)[2] ?? "";

    // 进文献库页签
    await page.getByRole("tab", { name: "文献库" }).click();
    await expect(page.getByRole("heading", { name: "文献列表" })).toBeVisible();

    // 1) 导入 arXiv（关 enrich：元数据确定性离线，全文链路才是被测对象）
    await page.getByRole("button", { name: "arXiv", exact: true }).click();
    await page.getByLabel("arXiv ID").fill(ARXIV_ID);
    await page.getByLabel(/自动补全元数据/).uncheck();
    await page.getByRole("button", { name: "导入文献" }).click();
    await expect(page.getByText("已导入文献库。")).toBeVisible();

    // 2) 导入 url-only 条目（Web 候选定位：不可自动获取）
    await page.getByRole("button", { name: "URL", exact: true }).click();
    await page.getByLabel("URL", { exact: true }).fill(`https://blog.example.org/m93-e2e-${STAMP}`);
    await page.getByRole("button", { name: "导入文献" }).click();
    await expect(page.getByText("已导入文献库。").first()).toBeVisible();

    // 状态列如实（行以入库方式 chip 定位：metadata-only 条目标题未补全前是 sourceId）
    const arxivRow = page.locator(".source-row", { hasText: "arXiv 导入" });
    await expect(arxivRow.getByText("全文未获取")).toBeVisible();
    await expect(arxivRow.getByRole("button", { name: "获取全文" })).toBeEnabled();
    const urlRow = page.locator(".source-row", { hasText: "URL 导入" });
    await expect(urlRow.getByText("不可自动获取")).toBeVisible();
    expect(await urlRow.getByRole("button", { name: "获取全文" }).isDisabled()).toBe(true);

    // 3) 批量：勾选两条 → 批量获取全文（真实网络 arXiv 下载在 60s 帽内）
    await arxivRow.getByRole("checkbox").check();
    await urlRow.getByRole("checkbox").check();
    await page.getByTestId("batch-resolve-fulltext").click();
    await expect(page.getByText(/批量获取完成：共 2 ｜ 已获取 1/)).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(/不可自动获取 1/).first()).toBeVisible();

    // arXiv 行状态翻转（真实文件 + provenance chip title 带来源）
    await expect(arxivRow.getByText("全文已获取")).toBeVisible({ timeout: 30_000 });
    await expect(arxivRow.locator('.chip[title*="全文来源：arxiv"]')).toBeVisible();

    // 4) 手动上传 PDF fallback（url-only 行）
    await urlRow.getByLabel(/上传 PDF 全文/).setInputFiles(manualPdfPath());
    await expect(page.getByText(/已挂载手动上传的 PDF 全文/)).toBeVisible({ timeout: 60_000 });
    await expect(urlRow.getByText("全文已获取")).toBeVisible();

    // 5) Evidence 边界：全程零 Evidence（全文激活 ≠ 证据核验）
    const evidence = await page.request.get(`/api/projects/${projectId}/evidence`);
    expect(evidence.ok()).toBeTruthy();
    expect(((await evidence.json()) as { evidence: unknown[] }).evidence).toEqual([]);

    // 检索可查（retrieve_library 语义的 HTTP 面）
    const search = await page.request.post(`/api/projects/${projectId}/retrieval/search`, {
      data: { query: "paper", topK: 5 },
    });
    expect(search.ok()).toBeTruthy();
    const body = (await search.json()) as { results: Array<{ chunk: { sourceId: string } }> };
    expect(body.results.length).toBeGreaterThan(0);
  });
});
