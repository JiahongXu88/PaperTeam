/**
 * M11.4 Quality Gate Calibration Audit — 确定性 bug 修复回归。
 *
 * 两个实证缺陷（Attempt 7 clean run p-d12dc28ad850 / w-80ffbbbf69a5）：
 *
 * 1. splitSingleFileDigest 截断盲区：36 块的真实返修稿被 18 块上限
 *    截去实验章后半（主对比 / 消融 / 极端场景 / 边缘部署 / 结论），
 *    reviewer 只见 44% 正文，实验充分性恒 25/35；且每块裸 slice(0,2600)
 *    无句界保护无截断告知（M11.3 Phase D 只修了分节路径）。
 * 2. claimGapAudit 无数字 claim 转述路线：claim（reviewer 转述短语）与
 *    冻结基线整段的 Jaccard ≥ 0.35 数学上不可达（短 claim 对长段落上限
 *    ≈ |claim|/|段落|），r1 审阅冻结基线自身仍产出 1 条
 *    revision_introduced —— 基线既有 claim 经转述一律误判为修订引入。
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { computeClaimGapAudit } from "../../src/review/claimGapAudit.js";
import { buildManuscriptDigest } from "../../src/workflow/definitions.js";
import type { WorkflowServices } from "../../src/workflow/definitions.js";

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// BUG-1：单文件 digest 截断盲区
// ---------------------------------------------------------------------------

describe("M11.4 audit：单文件 digest 不再截盲实验章", () => {
  /** 25 个 subsection（旧 18 块上限必然丢弃尾部）+ 尾部唯一标记 */
  function buildLongSingleFile(): string {
    const parts: string[] = [
      String.raw`\documentclass{article}`,
      String.raw`\begin{document}`,
      String.raw`\title{单文件返修稿}\maketitle`,
      String.raw`\begin{abstract}摘要声称 MRG-DTM 降低遮挡恢复过程中的身份切换。\end{abstract}`,
      String.raw`\section{方法}`,
    ];
    for (let i = 1; i <= 24; i += 1) {
      parts.push(String.raw`\subsection{方法小节 ${i}}` + `\n方法小节 ${i} 的正文内容。`.repeat(3));
    }
    parts.push(String.raw`\section{实验与结果}`);
    parts.push(String.raw`\subsection{消融实验}`);
    parts.push("消融实验最终结果标记 XYZQPUV 出现在最后一个 subsection。");
    parts.push(String.raw`\begin{table}[h]\begin{tabular}{ll}A & 1 \\ B & 2\end{tabular}\end{table}`);
    parts.push(String.raw`\end{document}`);
    return parts.join("\n\n");
  }

  async function digestFor(content: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "m114-digest-"));
    tempRoots.push(root);
    await mkdir(join(root, "p-test", "manuscript"), { recursive: true });
    await writeFile(join(root, "p-test", "manuscript", "main.tex"), content, "utf8");
    const services = {
      projects: { manuscriptDir: (projectId: string) => join(root, projectId, "manuscript") },
      manuscript: { loadOutline: async () => null },
    } as unknown as WorkflowServices;
    return buildManuscriptDigest(services, "p-test");
  }

  it("超过 18 块的单文件：最后一个 subsection（含实验标记）仍进入 digest", async () => {
    const digest = await digestFor(buildLongSingleFile());
    expect(digest).toContain("消融实验");
    expect(digest).toContain("XYZQPUV"); // 旧 18 块上限下不可见
    expect(digest).toContain("方法小节 24"); // 旧 18 块上限下不可见
  });

  it("超预算块使用句界安全截断并附系统注（不再裸 slice）", async () => {
    const longBody = "这一段是很长的正文。".repeat(400); // ~4600 chars > 2600 预算
    const digest = await digestFor(
      [
        String.raw`\documentclass{article}\begin{document}`,
        String.raw`\section{长节}`,
        longBody,
        String.raw`\section{短节}`,
        "短节内容。",
        String.raw`\end{document}`,
      ].join("\n\n"),
    );
    expect(digest).toContain("系统截断"); // DIGEST_TRUNCATION_NOTE 出现
    expect(digest).toContain("短节内容。"); // 截断只作用于超预算块本身，后续块不受影响
  });
});

// ---------------------------------------------------------------------------
// BUG-2：claimGapAudit 无数字 claim 的转述覆盖
// ---------------------------------------------------------------------------

describe("M11.4 audit：无数字 claim 的转述 pre-existing 判定", () => {
  // 冻结基线句取自真实 fixture（r1 误判样本的原文形态）
  const FROZEN = [
    "\\begin{abstract}",
    "消融实验验证了运动残差门控写入、运动兼容读取和轨迹稳定性约束的有效性。",
    "MRG-DTM 机制显著降低了遮挡恢复过程中的身份切换次数。",
    "本文在 RDK X3 车载边缘计算平台上完成了完整算法链路的部署验证。",
    "\\end{abstract}",
  ].join("\n");
  const frozenFiles = [{ file: "main.tex", content: FROZEN }];

  function auditFor(claims: { claimId: string; claim: string }[]) {
    return computeClaimGapAudit({
      projectId: "p1",
      round: 3,
      baselineRevision: 1,
      unsupportedClaims: claims.map((entry) => ({
        claimId: entry.claimId,
        section: "abstract",
        claim: entry.claim,
        verdict: "UNSUPPORTED",
        evidenceFormal: false,
        repairCandidates: [],
      })),
      issues: [],
      frozenFiles,
      authorEvidence: [],
    });
  }

  it("reviewer 转述基线句（词序/措辞变化）→ excluded_pre_existing（旧 Jaccard 路线全部误判 revision_introduced）", () => {
    const audit = auditFor([
      // r3 实际误判样本：c-025da1b5642e 的转述形态
      { claimId: "c-a", claim: "消融实验验证门控写入、兼容读取、稳定性约束三组件有效性" },
      // r1 实际误判样本：c-025da1b5642e 前身（审阅对象=冻结基线自身）
      { claimId: "c-b", claim: "消融实验验证了运动残差门控写入、运动兼容读取和轨迹稳定性约束的有效性。" },
      // r3 实际误判样本：c-eb3e94630d33 的转述形态
      { claimId: "c-c", claim: "MRG-DTM 降低遮挡恢复过程中的身份切换" },
    ]);
    const byId = new Map(audit.claims.map((claim) => [claim.claimId, claim]));
    expect(byId.get("c-a")?.applicability).toBe("excluded_pre_existing");
    expect(byId.get("c-b")?.applicability).toBe("excluded_pre_existing");
    expect(byId.get("c-c")?.applicability).toBe("excluded_pre_existing");
    expect(audit.counts.revisionIntroduced).toBe(0);
  });

  it("基线不存在其实质内容的新 claim（新概念词元）→ 仍 revision_introduced", () => {
    const audit = auditFor([
      { claimId: "c-new", claim: "本文首次将神经符号推理引入车辆跟踪框架" },
      { claimId: "c-new2", claim: "系统在 TUM 数据集上取得 SOTA 排名" },
    ]);
    const byId = new Map(audit.claims.map((claim) => [claim.claimId, claim]));
    expect(byId.get("c-new")?.applicability).toBe("revision_introduced");
    expect(byId.get("c-new2")?.applicability).toBe("revision_introduced");
    expect(audit.counts.revisionIntroduced).toBe(2);
  });

  it("数值 claim 路线不受影响：全数值命中 → pre-existing；含新数值 → revision_introduced", () => {
    const frozenWithNumbers = [
      { file: "main.tex", content: "对比实验显示 MOTA 提升 12.4，IDF1 达到 71.3。" },
    ];
    const audit = computeClaimGapAudit({
      projectId: "p1",
      round: 3,
      baselineRevision: 1,
      unsupportedClaims: [
        { claimId: "c-n1", section: "实验", claim: "MOTA 提升 12.4", verdict: "UNSUPPORTED", evidenceFormal: false, repairCandidates: [] },
        { claimId: "c-n2", section: "实验", claim: "MOTA 提升 15.9", verdict: "UNSUPPORTED", evidenceFormal: false, repairCandidates: [] },
      ],
      issues: [],
      frozenFiles: frozenWithNumbers,
      authorEvidence: [],
    });
    const byId = new Map(audit.claims.map((claim) => [claim.claimId, claim]));
    expect(byId.get("c-n1")?.applicability).toBe("excluded_pre_existing");
    expect(byId.get("c-n2")?.applicability).toBe("revision_introduced");
  });
});
