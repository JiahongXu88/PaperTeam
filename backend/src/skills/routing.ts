/**
 * Skill 路由（M5.3）：role + contextScope → 应注入的 Skill id 集合。
 *
 * 背景：M4.3 的 skillDirsForAgent(role) 只有 role 粒度，而三个 Reviewer lens
 * （fact / academic / style）共用 role=reviewer、Writer 的普通写作与 style 润色
 * 也共用 role=writer——粒度不足以让「正确的 Skill 进入正确的工作流」。
 *
 * 设计（最小兼容扩展，不引入 workflow/stage 维度）：
 * - 规则按 (role, scopePrefix) 匹配，scopePrefix 为归一化 contextScope 的前缀
 *   （"review/style" 命中 "review/style" 与 "review/style/..."）；
 * - 最长前缀优先；无任何前缀命中 → 该角色的默认绑定（scopePrefix 缺省）；
 * - 旧 role-only 调用（scope=undefined）恒命中默认绑定：researcher / citation /
 *   reviewer(verify-citations) / writer 的既有行为不退化，且 writer 默认获得
 *   academic-writing-zh（普通写作场景）。
 *
 * 路由表是业务定义（代码内控常量）；如允许编辑，只能在 approved catalog +
 * ALLOWED_CONTEXT_SCOPES 集合内选择（本轮 UI 只读展示）。
 */

export interface SkillRoute {
  role: string;
  /** contextScope 前缀（缺省 = 角色默认） */
  scopePrefix?: string;
  skillIds: readonly string[];
  /** 展示用说明 */
  note: string;
}

export const DEFAULT_SKILL_ROUTES: readonly SkillRoute[] = [
  // ---- Researcher：既有绑定保持 ----
  { role: "researcher", skillIds: ["paper-search"], note: "调研（含 existing-analysis）" },
  // ---- Citation：既有绑定保持 ----
  {
    role: "citation",
    skillIds: ["paper-search", "verify-citations"],
    note: "引用真实性 / 语义核验",
  },
  // ---- Reviewer：按 lens 分派（三个 lens 不拿相同 Skill 集）----
  {
    role: "reviewer",
    skillIds: ["verify-citations"],
    note: "默认（旧 role-only 调用 / 未识别 scope）：保持 M4.3 行为",
  },
  {
    role: "reviewer",
    scopePrefix: "review/fact",
    skillIds: ["verify-citations"],
    note: "fact lens：claim ↔ Evidence；引用核验所需 Skill",
  },
  {
    role: "reviewer",
    scopePrefix: "review/academic",
    skillIds: ["academic-review"],
    note: "academic lens：可执行审稿 finding",
  },
  {
    role: "reviewer",
    scopePrefix: "review/style",
    skillIds: ["academic-style-zh"],
    note: "style lens：中文学术表达（非 AI detector）",
  },
  {
    role: "reviewer",
    scopePrefix: "review/section",
    skillIds: ["academic-review"],
    note: "Existing Paper 分章节审阅：以 academic 审稿方法为主",
  },
  // ---- Writer：普通写作 vs style-polish ----
  {
    role: "writer",
    skillIds: ["academic-writing-zh"],
    note: "默认（普通写作 / legacy write）",
  },
  {
    role: "writer",
    scopePrefix: "writing/outline",
    skillIds: ["academic-writing-zh"],
    note: "大纲规划",
  },
  {
    role: "writer",
    scopePrefix: "writing/sections",
    skillIds: ["academic-writing-zh"],
    note: "分节写作",
  },
  {
    role: "writer",
    scopePrefix: "writing/revision",
    skillIds: ["academic-writing-zh"],
    note: "academic revision（依据审稿问题修订）",
  },
  {
    role: "writer",
    scopePrefix: "writing/improvement-plan",
    skillIds: ["academic-writing-zh"],
    note: "Existing Paper 改进计划",
  },
  {
    role: "writer",
    scopePrefix: "writing/style-polish",
    skillIds: ["academic-writing-zh", "academic-style-zh"],
    note: "style-only 润色（M5.4 Style Revision Loop）",
  },
  {
    role: "writer",
    scopePrefix: "writing/repair",
    skillIds: [],
    note: "LaTeX 编译修复：只修语法，不需要写作 Skill",
  },
];

/** 允许出现在绑定中的 contextScope 前缀集合（绑定编辑的合法取值域） */
export const ALLOWED_CONTEXT_SCOPES: readonly string[] = Array.from(
  new Set(
    DEFAULT_SKILL_ROUTES.map((route) => route.scopePrefix).filter(
      (scope): scope is string => scope !== undefined,
    ),
  ),
).sort();

/** approved catalog 的 skill id 全集（路由只能引用这些 id） */
export const APPROVED_SKILL_IDS: readonly string[] = Array.from(
  new Set(DEFAULT_SKILL_ROUTES.flatMap((route) => [...route.skillIds])),
).sort();

function scopeMatches(prefix: string, scope: string): boolean {
  return scope === prefix || scope.startsWith(`${prefix}/`);
}

/**
 * 解析应注入的 skill id（有序、去重）。
 * scope 应已归一化（sanitizeContextScope）；未归一化的输入按小写处理。
 */
export function resolveSkillIds(
  role: string,
  contextScope?: string,
  routes: readonly SkillRoute[] = DEFAULT_SKILL_ROUTES,
): string[] {
  const scope = contextScope?.trim().toLowerCase();
  const candidates = routes.filter((route) => route.role === role);
  if (candidates.length === 0) {
    return [];
  }
  let best: SkillRoute | undefined;
  if (scope !== undefined && scope !== "") {
    for (const route of candidates) {
      if (route.scopePrefix !== undefined && scopeMatches(route.scopePrefix, scope)) {
        if (best === undefined || route.scopePrefix.length > (best.scopePrefix?.length ?? -1)) {
          best = route;
        }
      }
    }
  }
  if (best === undefined) {
    best = candidates.find((route) => route.scopePrefix === undefined);
  }
  return best === undefined ? [] : Array.from(new Set(best.skillIds));
}
