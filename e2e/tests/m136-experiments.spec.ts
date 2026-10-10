import { crc32 } from "node:zlib";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "./fixtures.js";

/**
 * M13.6 实验数据 Auto-Onboarding（合成数据，无真实材料；隔离 e2e 根）：
 * - v1 旧包打开实验页时自动升级（ensure-upgraded）：main 组从整组 conflict
 *   变为三范围候选，页面出现「已自动升级」反馈，无需手动「重新整理分组」；
 * - 「用于当前论文」汇总选择：多范围包默认只勾选已授权范围；一次提交 =
 *   确认 + 授权（workflow-context 只含勾选范围）；取消勾选 = 显式排除，
 *   立即反映到 workflow-context；
 * - 冲突范围不可勾选（不偷偷放行）。
 * 全程只操作本测试创建的项目（隔离 PROJECTS_ROOT）。
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
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDirectory, end]);
}

const MULTI_SPLIT_ZIP = buildStoreZip([
  { path: "main/results.csv", data: "method,dataset,split,HOTA,IDSW\nOurs,Syn,Dev25,60.1,12\nOurs,Syn,Confirmation13,62.3,10\nOurs,Syn,Full38,61.5,11\n" },
  { path: "results/baseline-a0.csv", data: "method,dataset,split,HOTA,IDSW\nBase,Syn,Dev25,55.0,17\n" },
]);
const CONFLICT_ZIP = buildStoreZip([
  { path: "main/a.csv", data: "split,protocol,HOTA\nDev25,P1,60.0\nDev25,P2,61.0\n" },
]);

async function createIdeaProject(page: import("@playwright/test").Page, title: string): Promise<string> {
  await page.goto("/projects/new");
  await page.getByLabel(/论文标题/).fill(title);
  await page.getByLabel("研究想法", { exact: true }).fill("Synthetic M13.6 acceptance. Safe to delete.");
  await page.getByRole("button", { name: "创建项目" }).click();
  await expect(page).toHaveURL(/\/projects\/p-[a-z0-9]+$/, { timeout: 60_000 });
  const match = /\/projects\/(p-[a-z0-9]+)/.exec(page.url());
  expect(match, "project id from url").not.toBeNull();
  return match![1]!;
}

async function openExperimentsTab(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("tab", { name: "实验数据包" }).click();
  await expect(page.getByRole("heading", { name: "实验数据" })).toBeVisible();
}

async function uploadZip(page: import("@playwright/test").Page, zip: Buffer, name: string): Promise<void> {
  await page.getByLabel("选择实验 ZIP").setInputFiles({ name, mimeType: "application/zip", buffer: zip });
  await page.getByRole("button", { name: "上传实验包" }).click();
  await expect(page.getByText(/实验包已读取/)).toBeVisible({ timeout: 90_000 });
}

/** 把 v2 manifest 降级回 v1（模拟 M13.5 之前导入的旧包） */
async function downgradeToV1(projectsRoot: string, projectId: string, packageId: string): Promise<void> {
  const path = join(projectsRoot, projectId, "experiments", packageId, "manifest.json");
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown> & { groups: Array<Record<string, unknown>> };
  raw["schemaVersion"] = 1;
  for (const group of raw.groups) {
    const scopes = group["splitScopes"] as Array<{ split: string }> | undefined;
    delete group["splitScopes"];
    if ((scopes?.length ?? 0) > 1) {
      group["status"] = "conflict";
      group["conflicts"] = [`split 不一致：${scopes!.map((scope) => scope.split).join(" / ")}`];
    }
  }
  await writeFile(path, JSON.stringify(raw), "utf8");
}

test("v1 旧包打开实验页自动升级到范围级；「用于当前论文」一次提交确认 + 授权并立即反映到 workflow-context", async ({ page }) => {
  const projectId = await createIdeaProject(page, "M13.6 e2e auto-onboarding");
  await openExperimentsTab(page);
  await uploadZip(page, MULTI_SPLIT_ZIP, "m136-multi-split.zip");

  // 降级为 v1（模拟旧包）后刷新页面：面板加载时自动 ensure-upgraded
  const listResponse = await page.request.get(`/api/projects/${projectId}/experiment-packages`);
  const packages = ((await listResponse.json()) as { packages: Array<{ packageId: string }> }).packages;
  const packageId = packages[0]!.packageId;
  const projectsRoot = process.env.PAPERTEAM_E2E_PROJECTS_ROOT;
  test.skip(projectsRoot === undefined, "需要 PAPERTEAM_E2E_PROJECTS_ROOT 指向隔离数据根");
  await downgradeToV1(projectsRoot!, projectId, packageId);
  await page.reload();
  await expect(page.getByRole("heading", { name: "实验数据" })).toBeVisible();

  // 自动升级反馈出现；三范围在「用于当前论文」中可见且默认未勾选（多范围组须显式选择）
  await expect(page.getByText(/已自动升级 1 个旧版实验包/)).toBeVisible({ timeout: 30_000 });
  const devCheck = page.getByTestId("use-for-paper-check-main@Dev25");
  await expect(devCheck).toBeVisible();
  await expect(devCheck).not.toBeChecked();
  await expect(page.getByTestId("use-for-paper-check-main@Confirmation13")).not.toBeChecked();
  await expect(page.getByTestId("use-for-paper-check-main@Full38")).not.toBeChecked();
  // 单范围 baseline 组默认勾选（普通单范围包一次提交即可）
  await expect(page.getByTestId("use-for-paper-check-baseline-a0@Dev25")).toBeChecked();

  // 一次提交：勾选 Dev25 → 确认 + 授权合一
  await devCheck.check();
  await page.getByTestId("use-for-paper-submit").click();
  await expect(page.getByText(/已更新用于当前论文的实验范围/)).toBeVisible();

  // workflow-context 只含 Dev25 的 main 观测（baseline 尚未提交？——不：默认勾选随本次提交一起生效）
  const context = (await (await page.request.get(`/api/projects/${projectId}/experiment-packages/workflow-context`)).json()) as {
    observations: Array<{ groupId: string; split?: string }>;
  };
  expect(context.observations.length).toBe(4); // main/Dev25 2 条 + baseline/Dev25 2 条
  expect(context.observations.every((entry) => entry.split === "Dev25")).toBe(true);

  // 取消勾选 Dev25（main）+ baseline 一起排除 → 显式排除立即生效
  await page.getByTestId("use-for-paper-check-main@Dev25").uncheck();
  await page.getByTestId("use-for-paper-check-baseline-a0@Dev25").uncheck();
  await page.getByTestId("use-for-paper-submit").click();
  await expect(page.getByText(/个范围已排除/).first()).toBeVisible();
  const after = (await (await page.request.get(`/api/projects/${projectId}/experiment-packages/workflow-context`)).json()) as {
    observations: unknown[];
  };
  expect(after.observations).toHaveLength(0);
});

test("有冲突的范围不可勾选（不偷偷放行）；冲突说明可见", async ({ page }) => {
  const projectId = await createIdeaProject(page, "M13.6 e2e conflict scope");
  await openExperimentsTab(page);
  await uploadZip(page, CONFLICT_ZIP, "m136-conflict.zip");
  const check = page.getByTestId("use-for-paper-check-main@Dev25");
  await expect(check).toBeVisible();
  await expect(check).toBeDisabled();
  await expect(page.getByText(/协议矛盾|未解决冲突/).first()).toBeVisible();
});
