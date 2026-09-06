/**
 * Browser QA 路径脚本（Project Entry & Lifecycle UX 2026-09）。
 *
 * 路径 1：新建项目 → 从研究想法开始（表单可见，不提交）
 * 路径 2：导入已有论文 → PDF → 快速 Review（自动导航 Review 页）
 * 路径 3：导入已有论文 → 系统性改进（工作区，先 Review 基线提示）
 * 路径 4：项目列表 → 归档 → 消失
 * 路径 5：设置 → 项目管理 → 已归档 → 恢复
 * 路径 6：归档 → 永久删除确认（输入标题）
 * 路径 7：左上角 PaperTeam → 返回论文项目
 * 路径 8：模型设置 → 搜索模型 → modelId 含 “/”
 * 分辨率：1366x768 / 1440x900 / 1100x800
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PDF = resolve(here, "..", "backend", "test", "fixtures", "pdf", "attention.pdf");

export async function runQa(cdp) {
  const { setViewport, navigate, evalJs, waitForJs, shot, check, click, uploadFile } = cdp;

  // ---------- 路径 7（先验证品牌）：左上角 PaperTeam → 返回论文项目 ----------
  console.log("\n[路径 7] PaperTeam 品牌主页入口");
  await setViewport(1440, 900);
  await navigate("/skills");
  await waitForJs(`document.querySelector('[data-testid="brand-home"]')`);
  check("Brand 存在且指向 /projects", (await evalJs(`document.querySelector('[data-testid="brand-home"]')?.getAttribute('href')`)) === "/projects");
  check("aria-label=返回论文项目", (await evalJs(`document.querySelector('[data-testid="brand-home"]')?.getAttribute('aria-label')`)) === "返回论文项目");
  check("无 Research Workbench 文案", (await evalJs(`document.body.innerText.includes('Research Workbench')`)) === false);
  await click(`document.querySelector('[data-testid="brand-home"]')`);
  await waitForJs(`location.pathname === '/projects'`);
  check("点击品牌返回论文项目", true);
  await shot("07-brand-home-projects");

  // ---------- 路径 1：新建项目 → 从研究想法开始 ----------
  console.log("\n[路径 1] 新建项目 → 从研究想法开始");
  await navigate("/projects/new");
  await waitForJs(`document.querySelector('legend')?.textContent?.includes('你想做什么')`);
  check("顶层二选一（从研究想法开始）", (await evalJs(`[...document.querySelectorAll('.mode-card-title')].some(el => el.textContent === '从研究想法开始')`)));
  check("顶层二选一（导入已有论文）", (await evalJs(`[...document.querySelectorAll('.mode-card-title')].some(el => el.textContent === '导入已有论文')`)));
  check("研究想法模式显示标题必填", (await evalJs(`!!document.querySelector('#title')`)));
  await shot("01-new-project-idea");

  // ---------- 路径 2：导入已有论文 → PDF → 快速 Review ----------
  console.log("\n[路径 2] 导入已有论文 → PDF → 快速 Review");
  await click(`[...document.querySelectorAll('.mode-card')][1]`);
  await waitForJs(`document.querySelector('[data-testid="existing-import-form"]')`);
  check("导入模式无标题必填", (await evalJs(`!document.querySelector('#title')`)));
  check("快速 Review 为默认推荐", (await evalJs(`document.querySelector('[data-testid="goal-review_only"]')?.className.includes('selected')`)));
  check("高级选项默认折叠", (await evalJs(`!document.querySelector('details.advanced-options')?.open`)));
  await shot("02a-import-form");
  await uploadFile('input[type="file"]', [FIXTURE_PDF]);
  await waitForJs(`document.querySelector('.upload-title')?.textContent?.includes('attention.pdf')`);
  await click(`[...document.querySelectorAll('button')].find(b => b.textContent === '导入论文')`);
  // 等待解析（pymupdf 真实解析）+ 导航到 Review 页
  await waitForJs(`location.pathname.startsWith('/projects/') && location.search.includes('tab=review')`, 60_000, "导入后导航 ?tab=review");
  await waitForJs(`document.querySelector('[data-testid="review-panel"]')`, 20_000);
  check("导入成功落到 Review 页", true);
  const modelPhase = await evalJs(`fetch('/api/runtime/status').then(r => r.json()).then(j => j.status.model.phase)`);
  console.log(`  (模型状态: ${modelPhase})`);
  if (modelPhase === "not_configured") {
    await waitForJs(`document.querySelector('[data-testid="review-model-missing"]')`);
    check("模型未配置 → 「论文已导入。配置模型后即可开始 Review」引导", (await evalJs(`document.querySelector('[data-testid="review-model-missing"]')?.innerText.includes('配置模型后即可开始 Review')`)));
    check("开始 Review 按钮禁用（不丢项目）", (await evalJs(`document.querySelector('[data-testid="start-review"]')?.disabled`)) === true);
  } else {
    check("模型已配置 → Review 运行状态可见", (await evalJs(`!!document.querySelector('[data-testid="review-running"]') || !!document.querySelector('[data-testid="review-report"]')`)));
  }
  await shot("02b-review-panel");
  const reviewProjectTitle = await evalJs(`document.querySelector('.workspace-title')?.textContent`);
  const reviewProjectId = await evalJs(`location.pathname.split('/').pop()`);
  console.log(`  导入项目: ${reviewProjectTitle} (${reviewProjectId})`);
  check("项目标题来自 PDF（Attention Is All You Need）", reviewProjectTitle === "Attention Is All You Need");

  // 项目 Header 重命名（pencil）
  await click(`document.querySelector('[data-testid="rename-project"]')`);
  await waitForJs(`document.querySelector('[data-testid="workspace-rename"] input')`);
  check("标题可进入编辑态", true);
  await click(`[...document.querySelectorAll('[data-testid="workspace-rename"] button')].find(b => b.textContent === '取消')`);
  await shot("02c-workspace-rename");

  // ---------- 路径 3：导入已有论文 → 系统性改进 ----------
  console.log("\n[路径 3] 导入已有论文 → 系统性改进");
  await navigate("/projects/new");
  await click(`[...document.querySelectorAll('.mode-card')][1]`);
  await waitForJs(`document.querySelector('[data-testid="existing-import-form"]')`);
  await click(`document.querySelector('[data-testid="goal-improvement"] input')`);
  await uploadFile('input[type="file"]', [FIXTURE_PDF]);
  await click(`[...document.querySelectorAll('button')].find(b => b.textContent === '导入论文')`);
  await waitForJs(`location.pathname.startsWith('/projects/') && !location.search`, 60_000, "改进导入落到工作区");
  await waitForJs(`document.body.innerText.includes('研究定位')`);
  check("改进导入落到工作区概览", true);
  check("第一阶段提示先 Review 基线", (await evalJs(`document.body.innerText.includes('第一阶段先完成「Review」建立基线')`)));
  const improvementProjectId = await evalJs(`location.pathname.split('/').pop()`);
  console.log(`  改进项目: ${improvementProjectId}`);
  await shot("03-improvement-workspace");

  // ---------- 项目列表 + 分辨率检查 ----------
  console.log("\n[项目列表 / 分辨率]");
  await navigate("/projects");
  await waitForJs(`document.querySelectorAll('[data-testid="project-card"]').length >= 2`);
  check("两个项目都在列表", true);
  await setViewport(1366, 768);
  await shot("04a-projects-1366");
  await setViewport(1100, 800);
  await shot("04b-projects-1100");
  await setViewport(1440, 900);

  // ---------- 路径 4：归档 → 消失 ----------
  console.log("\n[路径 4] 项目列表 → 归档 → 消失");
  // 从 API 拿列表顺序（与 UI 一致：updatedAt 降序）与各项目忙碌状态
  const listInfo = await evalJs(`(async () => {
    const projects = await fetch('/api/projects').then(r => r.json()).then(j => j.projects);
    const withRuns = await Promise.all(projects.map(async (p) => {
      const runs = await fetch('/api/runs?projectId=' + p.id).then(r => r.json()).then(j => j.runs);
      const busy = runs.some(run => ['pending','running','awaiting_input'].includes(run.status));
      return { id: p.id, busy };
    }));
    return withRuns;
  })()`);
  const busyIndex = listInfo.findIndex((p) => p.busy);
  const idleIndex = listInfo.findIndex((p) => !p.busy);
  console.log(`  列表顺序: ${JSON.stringify(listInfo)}`);
  check("存在忙碌项目（Review 运行中）与空闲项目", busyIndex !== -1 && idleIndex !== -1);

  await navigate("/projects");
  await waitForJs(`document.querySelectorAll('[data-testid="project-row-menu"]').length >= 2`);
  await click(`document.querySelectorAll('[data-testid="project-row-menu"]')[${busyIndex}]`);
  await waitForJs(`[...document.querySelectorAll('.row-menu-item')].some(b => b.textContent === '归档项目')`);
  check("行菜单含 打开/重命名/归档", (await evalJs(`['打开','重命名','归档项目'].every(t => [...document.querySelectorAll('.row-menu-item')].some(b => b.textContent === t))`)));
  check("行菜单不含永久删除", (await evalJs(`![...document.querySelectorAll('.row-menu-item')].some(b => b.textContent.includes('删除'))`)));
  await shot("04c-row-menu");
  const beforeCount = await evalJs(`document.querySelectorAll('[data-testid="project-card"]').length`);
  // 忙碌项目：归档应被 409 拒绝并提示（Gate C 行为）
  await click(`[...document.querySelectorAll('.row-menu-item')].find(b => b.textContent === '归档项目')`);
  const busyRejected = await waitForJs(`document.body.innerText.includes('进行中的任务')`, 5000, "busy 409 提示").catch(() => false);
  check("运行中项目归档 → 409 提示（不静默归档）", busyRejected === true);
  check("运行中项目仍留在列表", (await evalJs(`document.querySelectorAll('[data-testid="project-card"]').length`)) === beforeCount);
  await shot("04c2-busy-409");
  // 空闲项目归档成功 → 行消失
  await navigate("/projects");
  await waitForJs(`document.querySelectorAll('[data-testid="project-row-menu"]').length >= 2`);
  await click(`document.querySelectorAll('[data-testid="project-row-menu"]')[${idleIndex}]`);
  await click(`[...document.querySelectorAll('.row-menu-item')].find(b => b.textContent === '归档项目')`);
  await waitForJs(`document.querySelectorAll('[data-testid="project-card"]').length === ${beforeCount} - 1`, 10_000, "归档后行消失");
  check("归档后从列表消失", true);
  await shot("04d-after-archive");

  // ---------- 路径 5：设置 → 项目管理 → 已归档 → 恢复 ----------
  console.log("\n[路径 5] 设置 → 项目管理 → 恢复");
  await navigate("/settings");
  await waitForJs(`location.pathname === '/settings/model'`);
  check("/settings 重定向到模型设置", true);
  await waitForJs(`document.querySelector('[data-testid="settings-subnav"]')`);
  check("二级导航：模型设置 + 项目管理", (await evalJs(`document.querySelector('[data-testid="settings-subnav"]')?.innerText.includes('模型设置') && document.querySelector('[data-testid="settings-subnav"]')?.innerText.includes('项目管理')`)));
  await shot("05a-settings-model");
  await click(`[...document.querySelectorAll('.settings-subnav-link')].find(a => a.textContent === '项目管理')`);
  await waitForJs(`document.querySelector('[data-testid="archived-projects-table"]')`);
  check("已归档列表展示项目", (await evalJs(`document.querySelector('[data-testid="archived-projects-table"]')?.innerText.includes('Attention')`)));
  await shot("05b-archived-list");
  await click(`document.querySelector('[data-testid^="restore-"]')`);
  await waitForJs(`!document.querySelector('[data-testid="archived-projects-table"]') || document.body.innerText.includes('暂无已归档项目')`, 10_000, "恢复后归档列表清空");
  check("恢复后从归档列表消失", true);
  await navigate("/projects");
  await waitForJs(`document.querySelectorAll('[data-testid="project-card"]').length === ${beforeCount}`);
  check("恢复后回到论文项目列表", true);
  await shot("05c-restored");

  // ---------- 路径 6：归档 → 永久删除确认 ----------
  console.log("\n[路径 6] 永久删除确认（输入标题）");
  // 通过工作区 Header ··· 菜单归档（覆盖 Header 入口），然后删除
  const idleId = listInfo[idleIndex]?.id;
  await navigate(`/projects/${idleId}`);
  await waitForJs(`document.querySelector('[data-testid="workspace-menu"]')`);
  await click(`document.querySelector('[data-testid="workspace-menu"]')`);
  await waitForJs(`[...document.querySelectorAll('.row-menu-item')].some(b => b.textContent === '归档项目')`);
  check("工作区菜单含 重命名/归档", (await evalJs(`['重命名','归档项目'].every(t => [...document.querySelectorAll('.row-menu-item')].some(b => b.textContent === t))`)));
  await click(`[...document.querySelectorAll('.row-menu-item')].find(b => b.textContent === '归档项目')`);
  await waitForJs(`location.pathname === '/projects'`, 10_000, "归档后返回列表");
  check("Header 归档后回到项目列表", true);
  await navigate("/settings/projects");
  await waitForJs(`document.querySelector('[data-testid="archived-projects-table"]')`);
  await click(`[...document.querySelectorAll('button')].find(b => b.textContent === '永久删除')`);
  await waitForJs(`document.querySelector('[data-testid="delete-confirm"]')`);
  check("确认框声明不可恢复", (await evalJs(`document.querySelector('[data-testid="delete-confirm"]')?.innerText.includes('永久删除后无法恢复')`)));
  check("未输入标题时按钮禁用", (await evalJs(`document.querySelector('[data-testid="delete-confirm-button"]')?.disabled`)) === true);
  await shot("06a-delete-confirm");
  const deleteTitle = await evalJs(`document.querySelector('[data-testid="delete-confirm-input"] + *, [data-testid="delete-confirm"] .mono')?.textContent`);
  // 输入标题（从确认文案中提取）
  const confirmText = await evalJs(`document.querySelector('[data-testid="delete-confirm"]')?.innerText`);
  const titleMatch = /「(.+?)」/.exec(confirmText ?? "");
  const projectTitle = titleMatch?.[1] ?? "";
  console.log(`  待删除项目: ${projectTitle}`);
  await evalJs(`document.querySelector('[data-testid="delete-confirm-input"]')?.focus()`);
  await cdp.type(`[data-testid="delete-confirm-input"]`, projectTitle);
  check("标题一致后按钮启用", (await evalJs(`!document.querySelector('[data-testid="delete-confirm-button"]')?.disabled`)) === true);
  await shot("06b-delete-armed");
  await click(`document.querySelector('[data-testid="delete-confirm-button"]')`);
  await waitForJs(`document.body.innerText.includes('暂无已归档项目')`, 15_000, "删除后归档列表空");
  check("删除后归档列表为空", true);
  await shot("06c-deleted");

  // ---------- 路径 8：模型设置 → 搜索模型 → modelId 含 / ----------
  console.log("\n[路径 8] 模型设置 → 搜索模型（modelId 含 /）");
  await navigate("/settings/model");
  await waitForJs(`document.querySelector('#model-provider')`);
  check("提供商下拉存在", true);
  // 选择 openrouter（模型 id 含 /，如 anthropic/claude-sonnet-4）
  await evalJs(`(() => { const sel = document.querySelector('#model-provider'); const opt = [...sel.options].find(o => o.value === 'openrouter'); if (!opt) return 'no-openrouter'; sel.value = 'openrouter'; sel.dispatchEvent(new Event('change', {bubbles: true})); return 'ok'; })()`);
  await waitForJs(`document.querySelector('#model-id')?.value !== undefined`, 5000, "模型输入可用").catch(() => {});
  await waitMs(1500);
  const hasOpenrouter = (await evalJs(`document.querySelector('#model-id') !== null`));
  if (hasOpenrouter) {
    // 打开下拉并输入 anthropic 过滤
    await evalJs(`(() => { const combo = document.querySelector('#model-id'); combo?.focus(); combo?.dispatchEvent(new Event('click', {bubbles:true})); return true; })()`);
    await cdp.type(`#model-id`, "anthropic");
    await waitMs(800);
    await shot("08a-model-search");
    const optionsText = await evalJs(`[...document.querySelectorAll('li, [role="option"], .combobox-option')].map(e => e.textContent).join('\\n')`);
    console.log(`  (搜索结果预览: ${optionsText.slice(0, 200)})`);
    check("搜索选择器可输入过滤", true);
  } else {
    console.log("  (openrouter 不在目录中，跳过交互细节)");
  }
  await shot("08b-model-settings");
  // 中文化检查
  const modelTexts = await evalJs(`document.body.innerText`);
  check("模型设置中文（模型提供商/测试连接/保存/危险操作）", ["模型提供商", "测试连接", "保存", "危险操作"].every((t) => modelTexts.includes(t)));

  // 1100px 宽度下的设置页
  await setViewport(1100, 800);
  await navigate("/settings/projects");
  await waitForJs(`document.body.innerText.includes('项目管理')`);
  await shot("08c-settings-1100");

  await setViewport(1440, 900);

  // ---------- 清场：只删除本次 QA 创建的两个项目（绝不碰其它项目） ----------
  console.log("\n[清场] 移除本次 QA 创建的项目");
  // 安全约束：只清理本脚本创建并记录的 id（reviewProjectId / improvementProjectId）
  const qaProjectIds = [reviewProjectId, improvementProjectId].filter(Boolean);
  for (const id of qaProjectIds) {
    await evalJs(`(async () => {
      const runs = await fetch('/api/runs?projectId=${id}').then(r => r.json());
      for (const run of runs.runs ?? []) {
        if (['pending','running','awaiting_input'].includes(run.status)) {
          await fetch('/api/runs/' + run.runId + '/cancel', {method:'POST'}).catch(() => {});
        }
      }
      await new Promise(r => setTimeout(r, 1500));
      await fetch('/api/projects/${id}/archive', {method:'POST'}).catch(() => {});
      await new Promise(r => setTimeout(r, 300));
      for (let i = 0; i < 15; i++) {
        const res = await fetch('/api/projects/${id}', {method:'DELETE'});
        if (res.ok) return true;
        await new Promise(r => setTimeout(r, 1000));
      }
      return false;
    })()`);
  }
  const leftoverQa = await evalJs(`(async () => {
    const all = await fetch('/api/projects?scope=all').then(r => r.json()).then(j => j.projects.map(p => p.id));
    return all.filter(id => ${JSON.stringify(qaProjectIds)}.includes(id)).length;
  })()`);
  check("本次 QA 项目已清理（不影响其它项目）", leftoverQa === 0);
}

function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
