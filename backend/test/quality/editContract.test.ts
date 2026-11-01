import { describe, expect, it } from "vitest";

import {
  buildEditContract,
  extractValueTokens,
  isContractFresh,
  preservingPolicyContract,
  systemRevisionPolicyContract,
  validateCandidateEdit,
  type EditContract,
} from "../../src/quality/editContract.js";
import {
  E1_ABSTRACT_AFTER_REAL,
  E1_ABSTRACT_BEFORE,
  E1_ABSTRACT_EXTRA_DELETIONS,
  E1_ABSTRACT_LEGAL_QUALIFY,
  E1_ABSTRACT_NUMBERS_ONLY,
  E1_ANCHOR,
  E1_SEC01_BEFORE,
} from "../fixtures/editContract/e1-derived.js";

/** 审计改写契约（与 TargetAuditRevisionService.decide 生成口径一致：锚范围 + 硬禁改 + 禁新增值 / 引用） */
function auditContract(baseContent: string, file = "abstract", extra: Partial<Parameters<typeof buildEditContract>[0]> = {}): EditContract {
  return buildEditContract({
    projectId: "p-test",
    source: { kind: "target_audit_rewrite", ref: "tap-x:ta-sg-34ced22fcb", instructionId: "x-620aab7c7d" },
    authority: [
      { kind: "frozen_protocol", ref: "target-audit-rewrite-policy/v1" },
      { kind: "synthetic_test_actor", ref: "approval-test-1", actor: "synthetic-fixture-actor" },
    ],
    target: { carrier: file === "abstract" ? "abstract" : "file", file, baseContent },
    anchors: [E1_ANCHOR],
    allowedOps: ["qualify", "weaken", "replace_wording"],
    constraints: { numericProtect: "all_existing", allowNewValues: false, hardNumericFreeze: true, citationPolicy: "preserve_existing_no_new" },
    ...extra,
  });
}

const codes = (verdict: ReturnType<typeof validateCandidateEdit>): string[] => [...new Set(verdict.violations.map((violation) => violation.code))].sort();

describe("extractValueTokens（数值 token 化与归一化边界）", () => {
  it("小数 / 斜杠并列 / 百分数 / 负号 / 科学计数 / 千分位 / 标识符", () => {
    const tokens = extractValueTokens("HOTA 5.402/6.075, 12\\% and 1,234 runs; $-0.5$ vs −0.25; $1.2\\times10^{-3}$; IDF1 on MOT17 with YOLOv8");
    expect(tokens.map((token) => token.norm)).toEqual(["5.402", "6.075", "12%", "1234", "-0.5", "-0.25", "1.2e-3", "IDF1", "MOT17", "YOLOv8"]);
  });

  it("结构性参数（\\cite / \\label / \\ref / 尺寸）中的数字不是事实值；连接号不是负号", () => {
    const tokens = extractValueTokens("see \\cite{smith2020} and Fig.~\\ref{fig:3}\\label{eq:2} \\vspace{2mm} RGB–infrared range 20--80 frames");
    expect(tokens.map((token) => token.norm)).toEqual(["20", "80"]);
  });

  it("小数末尾 0 是格式（0.25 ≡ 0.250，与既有事实守卫同口径）；5.402 与 5.42 不等价", () => {
    expect(extractValueTokens("0.250")[0]!.norm).toBe(extractValueTokens("0.25")[0]!.norm);
    expect(extractValueTokens("5.402")[0]!.norm).not.toBe(extractValueTokens("5.42")[0]!.norm);
  });
});

describe("validateCandidateEdit —— E1 硬性负例（派生夹具）", () => {
  it("E1-NUM：审计禁改数字，候选 5.402→3.312 / 11.549→9.798 → 拒绝", () => {
    const verdict = validateCandidateEdit({ target: "abstract", baseline: E1_ABSTRACT_BEFORE, candidate: E1_ABSTRACT_NUMBERS_ONLY, contracts: [auditContract(E1_ABSTRACT_BEFORE)] });
    expect(verdict.ok).toBe(false);
    expect(codes(verdict)).toContain("EDIT_CONTRACT_PROTECTED_VALUE_CHANGED");
    expect(codes(verdict)).toContain("EDIT_CONTRACT_NEW_VALUE");
    expect(verdict.violations.map((violation) => violation.value)).toEqual(expect.arrayContaining(["5.402", "11.549", "3.312", "9.798"]));
  });

  it("E1-SENT：数字保留、锚句限定，但额外删掉两句无关句 → 拒绝并指出越界句子", () => {
    const verdict = validateCandidateEdit({ target: "abstract", baseline: E1_ABSTRACT_BEFORE, candidate: E1_ABSTRACT_EXTRA_DELETIONS, contracts: [auditContract(E1_ABSTRACT_BEFORE)] });
    expect(verdict.ok).toBe(false);
    expect(codes(verdict)).toEqual(["EDIT_CONTRACT_OUT_OF_SCOPE"]);
    const sentences = verdict.violations.map((violation) => violation.sentence ?? "").join("\n");
    expect(sentences).toContain("components are intentionally simple");
    expect(sentences).toContain("validate reliability as an informative control signal");
  });

  it("E1 真实落盘形态（换数 + 删句 + 重排版）→ 范围与数值同时违规", () => {
    const verdict = validateCandidateEdit({ target: "abstract", baseline: E1_ABSTRACT_BEFORE, candidate: E1_ABSTRACT_AFTER_REAL, contracts: [auditContract(E1_ABSTRACT_BEFORE)] });
    expect(verdict.ok).toBe(false);
    expect(codes(verdict)).toEqual(expect.arrayContaining(["EDIT_CONTRACT_OUT_OF_SCOPE", "EDIT_CONTRACT_PROTECTED_VALUE_CHANGED", "EDIT_CONTRACT_NEW_VALUE"]));
  });

  it("E1-APPROVE：硬禁改下即便附带「用户批准的值对」也不生效（禁改优先，契约登记冲突）", () => {
    const contract = auditContract(E1_ABSTRACT_BEFORE, "abstract", {
      allowedValueChanges: [{ before: "5.402", after: "3.312", approvalId: "approval-test-2" }, { before: "11.549", after: "9.798", approvalId: "approval-test-2" }],
    });
    expect(contract.allowedValueChanges).toEqual([]);
    expect(contract.conflicts.map((conflict) => conflict.kind)).toContain("approval_conflicts_with_hard_freeze");
    const verdict = validateCandidateEdit({ target: "abstract", baseline: E1_ABSTRACT_BEFORE, candidate: E1_ABSTRACT_NUMBERS_ONLY, contracts: [contract] });
    expect(verdict.ok).toBe(false);
    expect(verdict.effective.hardNumericFreeze).toBe(true);
    expect(verdict.effective.approvedValueChanges).toBe(0);
  });

  it("E1-APPROVE（叠加）：普通计划契约的值对批准不能越过同目标审计契约的硬禁改", () => {
    const planContract = buildEditContract({
      projectId: "p-test",
      source: { kind: "improvement_plan_item", ref: "improvement:1", planItemId: "improvement:1" },
      authority: [{ kind: "synthetic_test_actor", ref: "approval-plan-1" }],
      target: { carrier: "abstract", file: "abstract", baseContent: E1_ABSTRACT_BEFORE },
      anchors: [E1_ANCHOR],
      constraints: { numericProtect: "all_existing" },
      allowedValueChanges: [{ before: "5.402", after: "3.312", approvalId: "approval-plan-1" }, { before: "11.549", after: "9.798", approvalId: "approval-plan-1" }],
    });
    const verdict = validateCandidateEdit({ target: "abstract", baseline: E1_ABSTRACT_BEFORE, candidate: E1_ABSTRACT_NUMBERS_ONLY, contracts: [auditContract(E1_ABSTRACT_BEFORE), planContract] });
    expect(verdict.ok).toBe(false);
    expect(codes(verdict)).toContain("EDIT_CONTRACT_PROTECTED_VALUE_CHANGED");
  });

  it("E1-PATH（sec01 副本）：审计契约只授权摘要载体 → 目标不符拒绝；系统策略下换数同样拒绝", () => {
    const candidate = E1_SEC01_BEFORE.replace("5.402/6.075 points", "3.312/6.075 points").replace("11.549/12.789 points", "9.798/12.789 points");
    const audit = validateCandidateEdit({ target: "sections/sec01.tex", baseline: E1_SEC01_BEFORE, candidate, contracts: [auditContract(E1_ABSTRACT_BEFORE)] });
    expect(codes(audit)).toContain("EDIT_CONTRACT_TARGET_MISMATCH");
    const policy = validateCandidateEdit({
      target: "sections/sec01.tex",
      baseline: E1_SEC01_BEFORE,
      candidate,
      contracts: [systemRevisionPolicyContract({ projectId: "p", file: "sections/sec01.tex", carrier: "file", baseContent: E1_SEC01_BEFORE, frozenContent: E1_SEC01_BEFORE, stageId: "revision.apply" })],
    });
    expect(policy.ok).toBe(false);
    expect(codes(policy)).toContain("EDIT_CONTRACT_PROTECTED_VALUE_CHANGED");
  });

  it("E1-STALE：批准后目标内容变化 → enforceBaseHash 拒绝；isContractFresh=false", () => {
    const contract = auditContract(E1_ABSTRACT_BEFORE);
    const changed = `${E1_ABSTRACT_BEFORE} Extra.`;
    expect(isContractFresh(contract, changed)).toBe(false);
    const verdict = validateCandidateEdit({ target: "abstract", baseline: changed, candidate: E1_ABSTRACT_LEGAL_QUALIFY, contracts: [contract], enforceBaseHash: true });
    expect(codes(verdict)).toContain("EDIT_CONTRACT_STALE");
  });

  it("系统修订软策略（整目标）：合法的句子重组改变数字先后 → 按多重集守恒放行（历史回放 4 例误拒的修复）", () => {
    const base = "Method A reaches 5.402 HOTA and 11.549 IDF1 on BENCH-A.";
    const reordered = "On BENCH-A, method A reaches 11.549 IDF1 and 5.402 HOTA.";
    const policy = systemRevisionPolicyContract({ projectId: "p", file: "sections/s.tex", carrier: "file", baseContent: base, frozenContent: base, stageId: "revision.revise" });
    expect(validateCandidateEdit({ target: "sections/s.tex", baseline: base, candidate: reordered, contracts: [policy] }).ok).toBe(true);
    // 多重集减少（删掉一个受保护值）仍拒绝
    expect(validateCandidateEdit({ target: "sections/s.tex", baseline: base, candidate: "On BENCH-A, method A reaches 11.549 IDF1.", contracts: [policy] }).ok).toBe(false);
  });

  it("删除后在别处插入同值（硬冻结 / 锚范围契约：数字须原位）→ 拒绝", () => {
    const base = "Method A reaches 5.402 HOTA and 11.549 IDF1 on BENCH-A.";
    const candidate = "Method A reaches 11.549 IDF1 and 5.402 HOTA on BENCH-A.";
    const verdict = validateCandidateEdit({
      target: "abstract",
      baseline: base,
      candidate,
      contracts: [buildEditContract({ projectId: "p", source: { kind: "improvement_plan_item", ref: "i" }, authority: [{ kind: "system_policy", ref: "x" }], target: { carrier: "abstract", file: "abstract", baseContent: base }, constraints: { hardNumericFreeze: true } })],
    });
    expect(codes(verdict)).toEqual(["EDIT_CONTRACT_VALUE_ORDER_CHANGED"]);
  });

  it("不可结构化的限制 → UNENFORCEABLE（fail closed，不假装已执行）", () => {
    const contract = buildEditContract({
      projectId: "p",
      source: { kind: "improvement_plan_item", ref: "i" },
      authority: [{ kind: "system_policy", ref: "x" }],
      target: { carrier: "abstract", file: "abstract", baseContent: E1_ABSTRACT_BEFORE },
      constraints: { unenforceable: ["不要让语气显得过于自信"] },
    });
    expect(contract.status).toBe("unenforceable");
    const verdict = validateCandidateEdit({ target: "abstract", baseline: E1_ABSTRACT_BEFORE, candidate: E1_ABSTRACT_LEGAL_QUALIFY, contracts: [contract] });
    expect(codes(verdict)).toEqual(["EDIT_CONTRACT_UNENFORCEABLE_CONSTRAINT"]);
  });

  it("无契约的写入 → EDIT_CONTRACT_MISSING", () => {
    const verdict = validateCandidateEdit({ target: "abstract", baseline: "a b c d", candidate: "a b c e", contracts: [] });
    expect(codes(verdict)).toEqual(["EDIT_CONTRACT_MISSING"]);
  });
});

describe("validateCandidateEdit —— 合法正例（不得系统性误拒）", () => {
  it("原数值全部保留，仅在锚区间内加局部限定语（锚外逐字，含 PDF 断行差异）→ 通过", () => {
    const verdict = validateCandidateEdit({ target: "abstract", baseline: E1_ABSTRACT_BEFORE, candidate: E1_ABSTRACT_LEGAL_QUALIFY, contracts: [auditContract(E1_ABSTRACT_BEFORE)] });
    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it("作者经结构化批准的值对（非硬冻结契约）→ 精确放行，其它数值仍受保护", () => {
    const base = "Our model reaches 45.04 HOTA and 57.10 IDF1 at 30 FPS.";
    const contract = buildEditContract({
      projectId: "p",
      source: { kind: "improvement_plan_item", ref: "improvement:2", planItemId: "improvement:2" },
      authority: [{ kind: "synthetic_test_actor", ref: "approval-ok", actor: "synthetic-fixture-actor" }],
      target: { carrier: "file", file: "sections/sec05.tex", baseContent: base },
      allowedValueChanges: [{ before: "45.04", after: "45.042", approvalId: "approval-ok" }],
    });
    const ok = validateCandidateEdit({ target: "sections/sec05.tex", baseline: base, candidate: base.replace("45.04", "45.042"), contracts: [contract] });
    expect(ok.ok).toBe(true);
    const sneaky = validateCandidateEdit({ target: "sections/sec05.tex", baseline: base, candidate: base.replace("45.04", "45.042").replace("57.10", "57.108"), contracts: [contract] });
    expect(sneaky.ok).toBe(false);
    expect(sneaky.violations.map((violation) => violation.value)).toContain("57.1");
  });

  it("系统修订策略：拼写 / 语法 / 局部结构修改（不触数值）→ 通过；非冻结基线引入的值可被修正", () => {
    const frozen = "We evaluate on BENCH-A. The resuts show a gain of 3.1 points.";
    const current = "We evaluate on BENCH-A. The resuts show a gain of 3.1 points and 9.9 extra.";
    const candidate = "We evaluate on BENCH-A. The results show a gain of 3.1 points.";
    const verdict = validateCandidateEdit({
      target: "sections/sec03.tex",
      baseline: current,
      candidate,
      contracts: [systemRevisionPolicyContract({ projectId: "p", file: "sections/sec03.tex", carrier: "file", baseContent: current, frozenContent: frozen, stageId: "revision.revise" })],
    });
    expect(verdict.ok).toBe(true);
  });

  it("纯表述策略（润色 / 编译修复）：数字与引用逐个守恒；新增 / 删除引用即拒绝", () => {
    const base = "As shown in \\cite{a2020}, accuracy is 91.2\\%.";
    const contract = preservingPolicyContract({ projectId: "p", file: "sections/s.tex", carrier: "file", baseContent: base, kind: "style_polish_policy" });
    expect(validateCandidateEdit({ target: "sections/s.tex", baseline: base, candidate: "As reported in \\cite{a2020}, the accuracy is 91.2\\%.", contracts: [contract] }).ok).toBe(true);
    const dropped = validateCandidateEdit({ target: "sections/s.tex", baseline: base, candidate: "The accuracy is 91.2\\%.", contracts: [contract] });
    expect(codes(dropped)).toEqual(["EDIT_CONTRACT_CITATION_REMOVED"]);
  });

  it("未改动的写入总是通过（只读 / 无变化不制造违规）", () => {
    expect(validateCandidateEdit({ target: "abstract", baseline: E1_ABSTRACT_BEFORE, candidate: E1_ABSTRACT_BEFORE, contracts: [auditContract(E1_ABSTRACT_BEFORE)] }).ok).toBe(true);
  });
});

describe("M15 长程 A3（R2）：数值语义换绑（整目标软策略）", () => {
  const policyFor = (base: string) =>
    systemRevisionPolicyContract({ projectId: "p", file: "sections/s.tex", carrier: "file", baseContent: base, frozenContent: base, stageId: "revision.revise" });
  const check = (base: string, candidate: string) => validateCandidateEdit({ target: "sections/s.tex", baseline: base, candidate, contracts: [policyFor(base)] });

  it("负例：HOTA / IDF1 数值互换（多重集守恒）→ VALUE_REBOUND", () => {
    const base = "Method A reaches 5.402 HOTA and 11.549 IDF1 on BENCH-A.";
    const verdict = check(base, "Method A reaches 11.549 HOTA and 5.402 IDF1 on BENCH-A.");
    expect(codes(verdict)).toEqual(["EDIT_CONTRACT_VALUE_REBOUND"]);
    const preLabel = check("HOTA is 5.402 while IDF1 is 11.549 in our runs.", "HOTA is 11.549 while IDF1 is 5.402 in our runs.");
    expect(codes(preLabel)).toEqual(["EDIT_CONTRACT_VALUE_REBOUND"]);
  });

  it("不判定的形态（保守边界）：单向挪动 / 多次出现的值 / 跨句——交给其它守卫或不判定", () => {
    expect(check("Our tracker obtains 61.2 MOTA. It also obtains 58.4 IDF1 on the test split.", "Our tracker obtains 58.4 MOTA. It also obtains 61.2 IDF1 on the test split.").violations
      .some((violation) => violation.code === "EDIT_CONTRACT_VALUE_REBOUND")).toBe(false);
    expect(check("R5 uses 17 runs and HOTA gains 17 points.", "HOTA uses 17 runs and R5 gains 17 points.").ok).toBe(true);
  });

  it("回归：数字后接单词 in / ex / em 不是长度字面量（旧 token 化漏保护）", () => {
    expect(extractValueTokens("improves by 11.549 in IDF1 and 3 ex").map((token) => token.norm)).toEqual(["11.549", "IDF1", "3"]);
    expect(extractValueTokens("\\vspace{2cm} width 0.5in").filter((token) => token.kind === "number")).toEqual([]);
    const base = "It improves by 11.549 in IDF1 on the test split.";
    expect(check(base, "It improves by 9.798 in IDF1 on the test split.").ok).toBe(false);
  });

  it("正例：换序但绑定不变 / 改写措辞去掉标签 / 无标签数字 / 连字符指标名 → 放行", () => {
    const base = "Method A reaches 5.402 HOTA and 11.549 IDF1 on BENCH-A.";
    expect(check(base, "On BENCH-A, method A reaches 11.549 IDF1 and 5.402 HOTA.").ok).toBe(true);
    expect(check(base, "Method A improves the baseline by 5.402 HOTA points and by 11.549 IDF1 points on BENCH-A.").ok).toBe(true);
    expect(check("We train for 30 epochs with 4 GPUs.", "With 4 GPUs, we train for 30 epochs.").ok).toBe(true);
    expect(check("BLEU-4 reaches 27.3 and ROUGE-L reaches 41.0.", "ROUGE-L reaches 41.0 and BLEU-4 reaches 27.3.").ok).toBe(true);
  });

  it("锚范围 / 硬冻结契约下互换由顺序守恒拦截（不依赖标签绑定）", () => {
    const base = "Method A reaches 5.402 HOTA and 11.549 IDF1 on BENCH-A.";
    const strict = preservingPolicyContract({ projectId: "p", file: "sections/s.tex", carrier: "file", baseContent: base, kind: "style_polish_policy" });
    const verdict = validateCandidateEdit({ target: "sections/s.tex", baseline: base, candidate: "Method A reaches 11.549 HOTA and 5.402 IDF1 on BENCH-A.", contracts: [strict] });
    expect(verdict.ok).toBe(false);
  });
});
