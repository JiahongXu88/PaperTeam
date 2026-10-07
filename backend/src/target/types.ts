/**
 * Target Publication Intelligence 域类型（M12.1 A5；M12.0 §4.3 冻结 schema）。
 *
 * artifact 布局（project artifact，落 projects.researchDir）：
 *   research/target-benchmark.json   冻结的 benchmark 语料（本文件；revision 模式
 *                                    照抄 CorpusSnapshotService——冻结后普通读取
 *                                    no-op，显式 refresh 才 revision+1）
 *   research/target-profile.json     （A7，本轮不实现）
 *   research/target-readiness.json   （A8，本轮不实现）
 *
 * 语义红线：
 * - benchmark 论文在 SourceStore 里恒 `sourceRole="reference"`（D-0012：回答
 *   「这类论文通常怎么写」，不回答「claim 是否被支撑」）；它永远不进 evidence
 *   供给链（M12.0 §5 四道隔离）；
 * - fingerprint 只覆盖参与语料的行内容（含 citationCount/venue/excluded），
 *   确定性排序——同语料恒同指纹，不含时间戳/revision；
 * - citationCount 是发现时快照（provider provenance，LLM 不得生成）。
 */

/** 语料时间窗（发现范围；inclusive） */
export interface BenchmarkTimeWindow {
  from?: number;
  to?: number;
}

/** 目标三元组 + 研究领域（ProjectMetadata 对应字段的冻结快照） */
export interface BenchmarkTargetSpec {
  documentType: string;
  targetProfile: string;
  targetVenue?: string;
  researchField?: string;
  timeWindow?: BenchmarkTimeWindow;
}

/** 冻结语料单行（一篇 benchmark 论文） */
export interface TargetBenchmarkPaper {
  /** SourceStore 主键（sourceRole="reference"） */
  sourceId: string;
  /** 冻结时身份快照（identity.ts 分层键；跨 provider 判等审计） */
  identityKey: string;
  provenance: {
    provider: string;
    retrievedAt: string;
    queryUsed: string;
  };
  /** 复用 CandidateStore.selectionReason 语义（为什么进语料） */
  inclusionReason: string;
  /** 发现时快照（provider 实测；缺省 = provider 未提供） */
  citationCount?: number;
  /** 未归一化 venue 原文（诚实：不作 canonical 化） */
  venueRaw: string;
  /** 磁盘事实：发现/冻结时是否已有全文文件 */
  hasFullText: boolean;
  /** 冻结后显式剔除（revision 语义见 TargetBenchmarkService.exclude） */
  excluded?: { reason: string; at: string };
}

/** 语料充分性（A6；必须标记，不静默） */
export type BenchmarkSufficiency = "sufficient" | "insufficient";

/** 选择记录（A6 auto-select 的审计快照；additive——旧 artifact 无此块照常读） */
export interface TargetBenchmarkSelection {
  selectedAt: string;
  /** 选中目标数（带内 8–15，默认目标 12） */
  targetCount: number;
  sufficiency: BenchmarkSufficiency;
  /** insufficient 时的原因（候选不足 / venue 未解析等） */
  reason?: string;
  /** 结构化注意项（供未来 workflow 决定是否 required HITL；空 = 无） */
  requiresAttention: string[];
}

export interface TargetBenchmarkArtifact {
  schemaVersion: 1;
  /** 0 起；显式 refresh / addPaper +1；exclude 不加（同修订内剔除标记） */
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** 参与语料行的 sha256（见 benchmarkFingerprint；语料变指纹必变） */
  fingerprint: string;
  target: BenchmarkTargetSpec;
  papers: TargetBenchmarkPaper[];
  /** 选中快照（A6 discoverAndFreeze 写入；手动 freeze 可缺省） */
  selection?: TargetBenchmarkSelection;
  /** HITL 确认时间戳（A6 confirm；幂等——仅首次写入） */
  confirmedAt?: string;
}
