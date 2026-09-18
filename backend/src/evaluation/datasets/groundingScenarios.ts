/**
 * Experiment 1 数据集：Evidence Grounding Evaluation（6 个场景）。
 *
 * 语料为自造学术示例文本（与 M6.4 retrieval benchmark 同风格：确定性、
 * 离线、无真实论文搬运）。每个场景：
 * - corpus：2-3 个来源（其中至多一个 metadataCorrupted=true 用于
 *   metadata_mismatch 故障注入）；
 * - supportable：正例论断（needle 逐字存在于对应来源正文 → 可走通三段核验）；
 * - faults：注入故障提案，带 ground truth 标注（claimSupported /
 *   quoteVerbatim / metadataCorrect 由 faultClass 派生，见 metrics 模块）。
 *
 * needle 纪律：needle 必须是 content 的逐字子串（不含前后空格），
 * scenario 校验测试逐条验证；fabricated quote 必须不出现在任何语料中。
 */

import type { GroundingScenario } from "../types.js";

/** 确定性 filler（seeded LCG——同 seed 恒同输出；把 section 撑到多 chunk 规模） */
function filler(seed: number, count: number, prefix: string): string {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const words: string[] = [];
  for (let i = 0; i < count; i += 1) {
    words.push(`${prefix}${(next() % 997).toString(36)}${i % 13}`);
  }
  return words.join(" ");
}

function body(sentences: string[], seed: number): string {
  return sentences.map((sentence, index) => `${sentence} ${filler(seed + index, 24, "f")}.`).join("\n\n");
}

// ---- g1：RAG 幻觉综述（EN） ----

const g1: GroundingScenario = {
  kind: "grounding",
  id: "g1-rag-survey",
  title: "RAG 幻觉缓解综述证据核验",
  description: "英文综述语料：正例（检索降低事实错误率）+ 捏造引文 + 越界论断 + 元数据年份错位",
  corpus: [
    {
      fileName: "rag-survey.md",
      title: "A Survey of Retrieval-Augmented Generation",
      year: 2023,
      authors: ["Gao, Yunfan"],
      content: [
        "# Introduction",
        body(
          [
            "Retrieval-augmented generation mitigates hallucination by grounding generation in retrieved passages.",
            "Fact error rates drop measurably when external knowledge is injected at inference time.",
            "Retrieval quality remains the dominant factor in end-to-end answer accuracy.",
          ],
          11,
        ),
        "# Method",
        body(
          [
            "Dense retrievers and sparse lexical retrievers are combined through reciprocal rank fusion in recent systems.",
            "Faithfulness checking compares generated claims against the retrieved evidence span.",
          ],
          22,
        ),
        "# Experiments",
        body(
          [
            "On open-domain QA benchmarks the average factual error rate decreases by 38 percent with retrieval enabled.",
            "Reranking improves precision at five by a visible margin across three datasets.",
          ],
          33,
        ),
      ].join("\n"),
    },
    {
      fileName: "rag-eval.md",
      title: "Evaluating Retrieval-Augmented Systems",
      year: 2024,
      authors: ["Liu, Chen"],
      content: [
        "# Protocol",
        body(
          [
            "A reproducible evaluation protocol reports hallucination rate, citation precision and coverage separately.",
            "Small corpora expose retrieval brittleness more sharply than large ones.",
          ],
          44,
        ),
        "# Results",
        body(["Fixed seed runs reproduce identical metrics across restarts in our framework."], 55),
      ].join("\n"),
    },
    {
      // metadataCorrupted：存储年份写成 2035（权威记录 = 2024）→ Stage 2 mismatch
      fileName: "rag-small.md",
      title: "RAG under Small Corpora",
      year: 2035,
      authors: ["Wang, Lei"],
      metadataCorrupted: true,
      authoritativeYear: 2024,
      content: [
        "# Study",
        body(
          [
            "Small domain corpora of fifty documents already stabilize lexical retrieval behavior.",
            "Hallucination rate saturates once retrieval precision at five exceeds 0.8.",
          ],
          66,
        ),
      ].join("\n"),
    },
  ],
  supportable: [
    {
      claim: "Retrieval-augmented generation 通过把生成锚定在检索段落上缓解幻觉",
      locator: { fileName: "rag-survey.md", needle: "Retrieval-augmented generation mitigates hallucination by grounding generation in retrieved passages." },
    },
    {
      claim: "开放域 QA 基准上启用 retrieval 后平均事实错误率下降 38%",
      locator: { fileName: "rag-survey.md", needle: "On open-domain QA benchmarks the average factual error rate decreases by 38 percent with retrieval enabled." },
    },
    {
      claim: "可复现评估协议应分别报告 hallucination rate、citation precision 与 coverage",
      locator: { fileName: "rag-eval.md", needle: "A reproducible evaluation protocol reports hallucination rate, citation precision and coverage separately." },
    },
  ],
  faults: [
    {
      id: "g1-f1",
      faultClass: "fabricated_quote",
      claim: "retrieval quality 是端到端答案精度（answer accuracy）的主导因素",
      quote: "Retrieval quality alone explains 92 percent of variance in final answer correctness across all settings.",
      locator: { fileName: "rag-survey.md", needle: "Retrieval quality remains the dominant factor in end-to-end answer accuracy." },
      ragRetrievable: true,
    },
    {
      id: "g1-f2",
      faultClass: "unsupported_claim",
      claim: "启用 retrieval 后事实错误率下降 92%",
      quote: "On open-domain QA benchmarks the average factual error rate decreases by 38 percent with retrieval enabled.",
      locator: { fileName: "rag-survey.md", needle: "On open-domain QA benchmarks the average factual error rate decreases by 38 percent with retrieval enabled." },
      ragRetrievable: true,
    },
    {
      id: "g1-f3",
      faultClass: "metadata_mismatch",
      claim: "五十篇文档的 small domain corpora 已能稳定 lexical retrieval 行为",
      quote: "Small domain corpora of fifty documents already stabilize lexical retrieval behavior.",
      locator: { fileName: "rag-small.md", needle: "Small domain corpora of fifty documents already stabilize lexical retrieval behavior." },
      ragRetrievable: true,
    },
  ],
};

// ---- g2：多目标跟踪（ZH） ----

const g2: GroundingScenario = {
  kind: "grounding",
  id: "g2-mot-zh",
  title: "中文多目标跟踪语料证据核验",
  description: "中文语料：正例 + 捏造引文（锚定真实 chunk）+ 越界论断（把『有所提升』夸大为『大幅超越』）",
  corpus: [
    {
      fileName: "mot-zh.md",
      title: "基于深度学习的多目标跟踪方法研究",
      year: 2024,
      authors: ["张, 明"],
      content: [
        "# 引言",
        body(
          [
            "多目标跟踪需要在连续视频帧中检测并关联目标实例。",
            "遮挡与密集场景是数据关联的主要难点。",
          ],
          77,
        ),
        "# 方法",
        body(
          [
            "本文采用卡尔曼滤波预测目标运动，并结合外观特征进行数据关联。",
            "关联代价矩阵融合运动距离与表观相似度两个部分。",
          ],
          88,
        ),
        "# 实验与分析",
        body(
          [
            "在公开数据集上所提数据关联策略相比基线将 MOTA 提升了 1.9 个百分点。",
            "消融实验验证了运动模型在遮挡场景下的有效性。",
          ],
          99,
        ),
      ].join("\n"),
    },
    {
      fileName: "mot-en.md",
      title: "Multi-Object Tracking with ByteTrack",
      year: 2022,
      authors: ["Zhang, Yifu"],
      content: [
        "# Method",
        body(
          [
            "ByteTrack keeps low-confidence detections as candidates for occluded objects.",
            "The data association step uses IoU overlap and Kalman filter motion prediction.",
          ],
          111,
        ),
        "# Experiments",
        body(["ByteTrack reaches MOTA 80.3 on the MOT17 test set."], 122),
      ].join("\n"),
    },
  ],
  supportable: [
    {
      claim: "多目标跟踪需要在连续视频帧中检测并关联目标实例",
      locator: { fileName: "mot-zh.md", needle: "多目标跟踪需要在连续视频帧中检测并关联目标实例。" },
    },
    {
      claim: "ByteTrack 在 MOT17 测试集上达到 MOTA 80.3",
      locator: { fileName: "mot-en.md", needle: "ByteTrack reaches MOTA 80.3 on the MOT17 test set." },
    },
    {
      claim: "所提数据关联策略在公开数据集上相比基线提升 MOTA 1.9 个百分点",
      locator: { fileName: "mot-zh.md", needle: "在公开数据集上所提数据关联策略相比基线将 MOTA 提升了 1.9 个百分点。" },
    },
  ],
  faults: [
    {
      id: "g2-f1",
      faultClass: "fabricated_quote",
      claim: "遮挡与密集场景是数据关联的主要难点",
      quote: "实验表明本文方法在所有遮挡场景下将跟踪成功率提升至 99.2%，全面解决了遮挡问题。",
      locator: { fileName: "mot-zh.md", needle: "遮挡与密集场景是数据关联的主要难点。" },
      ragRetrievable: true,
    },
    {
      id: "g2-f2",
      faultClass: "unsupported_claim",
      claim: "所提关联策略大幅超越 ByteTrack 等现有方法",
      quote: "在公开数据集上所提数据关联策略相比基线将 MOTA 提升了 1.9 个百分点。",
      locator: { fileName: "mot-zh.md", needle: "在公开数据集上所提数据关联策略相比基线将 MOTA 提升了 1.9 个百分点。" },
      ragRetrievable: true,
    },
    {
      id: "g2-f3",
      faultClass: "fabricated_quote",
      claim: "ByteTrack 保留低置信度检测作为遮挡目标的候选",
      quote: "ByteTrack discards all low-confidence detections because they are provably harmful in dense scenes.",
      locator: { fileName: "mot-en.md", needle: "ByteTrack keeps low-confidence detections as candidates for occluded objects." },
      ragRetrievable: true,
    },
  ],
};

// ---- g3：图神经网络引文分析（EN） ----

const g3: GroundingScenario = {
  kind: "grounding",
  id: "g3-gnn-citation",
  title: "GNN 引文分析证据核验",
  description: "英文语料：正例 + 越界论断（跨数据集泛化宣称）+ 元数据年份错位",
  corpus: [
    {
      fileName: "gnn.md",
      title: "Graph Neural Networks for Citation Analysis",
      year: 2021,
      authors: ["Chen, Wei"],
      content: [
        "# Introduction",
        body(["Graph neural networks learn representations by message passing."], 133),
        "# Method",
        body(
          [
            "Graph convolution aggregates neighbor features at each layer.",
            "Attention weights can replace fixed normalization in aggregation.",
          ],
          144,
        ),
        "# Experiments",
        body(
          [
            "On the Cora citation network node classification reaches 82 accuracy.",
            "The Citeseer and Pubmed datasets show consistent trends.",
          ],
          155,
        ),
      ].join("\n"),
    },
    {
      // metadataCorrupted：存储年份 2016（权威记录 = 2020）→ Stage 2 mismatch
      fileName: "gcn.md",
      title: "Semi-Supervised Classification with Graph Convolutional Networks",
      year: 2016,
      authors: ["Kipf, Thomas"],
      metadataCorrupted: true,
      authoritativeYear: 2020,
      content: [
        "# Model",
        body(
          [
            "The layer-wise propagation rule renormalizes the adjacency matrix with self loops.",
            "A two-layer graph convolutional network suffices for many citation benchmarks.",
          ],
          166,
        ),
      ].join("\n"),
    },
  ],
  supportable: [
    {
      claim: "图神经网络通过消息传递学习表示",
      locator: { fileName: "gnn.md", needle: "Graph neural networks learn representations by message passing." },
    },
    {
      claim: "Cora 引文网络上节点分类达到 82 的准确率",
      locator: { fileName: "gnn.md", needle: "On the Cora citation network node classification reaches 82 accuracy." },
    },
    {
      // 注意：正例只锚定元数据干净的来源——锚定 metadataCorrupted 来源的
      // 提案会被 Stage 2 正确拒绝（那是 metadata_mismatch 故障的语义）
      claim: "注意力权重可以替代聚合中的固定归一化",
      locator: { fileName: "gnn.md", needle: "Attention weights can replace fixed normalization in aggregation." },
    },
  ],
  faults: [
    {
      id: "g3-f1",
      faultClass: "unsupported_claim",
      claim: "该类方法在所有引文数据集上准确率均超过 90%",
      quote: "The Citeseer and Pubmed datasets show consistent trends.",
      locator: { fileName: "gnn.md", needle: "The Citeseer and Pubmed datasets show consistent trends." },
      ragRetrievable: true,
    },
    {
      id: "g3-f2",
      faultClass: "metadata_mismatch",
      claim: "逐层传播规则用自环对邻接矩阵做重归一化",
      quote: "The layer-wise propagation rule renormalizes the adjacency matrix with self loops.",
      locator: { fileName: "gcn.md", needle: "The layer-wise propagation rule renormalizes the adjacency matrix with self loops." },
      ragRetrievable: true,
    },
  ],
};

// ---- g4：神经语音合成（EN） ----

const g4: GroundingScenario = {
  kind: "grounding",
  id: "g4-tts",
  title: "神经语音合成证据核验",
  description: "英文语料：正例 + 捏造引文（把『主观 MOS 4.1』捏造成『客观得分全面第一』）",
  corpus: [
    {
      fileName: "tts.md",
      title: "Neural Speech Synthesis",
      year: 2020,
      authors: ["Shen, Jonathan"],
      content: [
        "# Introduction",
        body(["Neural speech synthesis generates mel-spectrograms autoregressively."], 177),
        "# Method",
        body(
          [
            "Tacotron predicts spectrogram frames from character embeddings.",
            "Attention aligns text and audio features during training.",
          ],
          188,
        ),
        "# Experiments",
        body(["Subjective MOS scores reach 4.1 in listening tests."], 199),
      ].join("\n"),
    },
  ],
  supportable: [
    {
      claim: "神经语音合成以自回归方式生成梅尔频谱",
      locator: { fileName: "tts.md", needle: "Neural speech synthesis generates mel-spectrograms autoregressively." },
    },
    {
      claim: "听测主观 MOS 得分达到 4.1",
      locator: { fileName: "tts.md", needle: "Subjective MOS scores reach 4.1 in listening tests." },
    },
  ],
  faults: [
    {
      id: "g4-f1",
      faultClass: "fabricated_quote",
      claim: "主观听测 MOS 得分达到 4.1",
      quote: "Our system ranks first on every objective benchmark with a margin of at least 1.2 MOS points.",
      locator: { fileName: "tts.md", needle: "Subjective MOS scores reach 4.1 in listening tests." },
      ragRetrievable: true,
    },
  ],
};

// ---- g5：PPO 强化学习（EN） ----

const g5: GroundingScenario = {
  kind: "grounding",
  id: "g5-ppo",
  title: "PPO 证据核验",
  description: "英文语料：正例 + 越界论断（『匹配』被夸大为『全面超越』）",
  corpus: [
    {
      fileName: "ppo.md",
      title: "Proximal Policy Optimization",
      year: 2019,
      authors: ["Schulman, John"],
      content: [
        "# Introduction",
        body(["Policy gradient methods train agents directly from environment rewards."], 211),
        "# Method",
        body(["PPO clips the probability ratio to bound policy updates per batch."], 222),
        "# Experiments",
        body(["PPO matches full trust-region performance on Atari and MuJoCo at lower cost."], 233),
      ].join("\n"),
    },
  ],
  supportable: [
    {
      claim: "PPO 通过裁剪概率比来限制每批次的策略更新幅度",
      locator: { fileName: "ppo.md", needle: "PPO clips the probability ratio to bound policy updates per batch." },
    },
    {
      claim: "PPO 在 Atari 与 MuJoCo 上以更低成本匹配完整信赖域方法的性能",
      locator: { fileName: "ppo.md", needle: "PPO matches full trust-region performance on Atari and MuJoCo at lower cost." },
    },
  ],
  faults: [
    {
      id: "g5-f1",
      faultClass: "unsupported_claim",
      claim: "PPO 在所有连续控制任务上全面超越信赖域方法",
      quote: "PPO matches full trust-region performance on Atari and MuJoCo at lower cost.",
      locator: { fileName: "ppo.md", needle: "PPO matches full trust-region performance on Atari and MuJoCo at lower cost." },
      ragRetrievable: true,
    },
  ],
};

// ---- g6：中文情感分析（ZH） ----

const g6: GroundingScenario = {
  kind: "grounding",
  id: "g6-sentiment-zh",
  title: "中文商品评论情感分析证据核验",
  description: "中文语料：正例 + 捏造引文 + 越界论断（小样本结论夸大为通用结论）",
  corpus: [
    {
      fileName: "sentiment-zh.md",
      title: "中文商品评论情感分类的少样本方法研究",
      year: 2025,
      authors: ["李, 华"],
      content: [
        "# 引言",
        body(
          [
            "中文商品评论情感分类面临口语化表达与领域新词的挑战。",
            "少样本示例选择策略对分类稳定性影响显著。",
          ],
          244,
        ),
        "# 方法",
        body(["本文提出基于语义相似度的示例选择策略并结合对比学习训练。" ], 255),
        "# 实验",
        body(
          [
            "在三个电商数据集的小样本设置下该方法将宏平均 F1 提升了 2.3 个百分点。",
            "示例多样性对该策略的效果具有明显影响。",
          ],
          266,
        ),
      ].join("\n"),
    },
    {
      fileName: "fewshot-en.md",
      title: "In-Context Learning Example Selection",
      year: 2023,
      authors: ["Rubin, Ohad"],
      content: [
        "# Method",
        body(["Example selection via retrieval improves in-context learning accuracy."], 277),
      ].join("\n"),
    },
  ],
  supportable: [
    {
      claim: "少样本示例选择策略对中文情感分类稳定性影响显著",
      locator: { fileName: "sentiment-zh.md", needle: "少样本示例选择策略对分类稳定性影响显著。" },
    },
    {
      claim: "三个电商数据集的小样本设置下宏平均 F1 提升 2.3 个百分点",
      locator: { fileName: "sentiment-zh.md", needle: "在三个电商数据集的小样本设置下该方法将宏平均 F1 提升了 2.3 个百分点。" },
    },
    {
      claim: "经检索的示例选择能提升上下文学习准确率",
      locator: { fileName: "fewshot-en.md", needle: "Example selection via retrieval improves in-context learning accuracy." },
    },
  ],
  faults: [
    {
      id: "g6-f1",
      faultClass: "fabricated_quote",
      claim: "示例多样性对该策略的效果具有明显影响",
      quote: "实验证明无论任务与语言如何变化，该方法始终保持最优，无需任何调参。",
      locator: { fileName: "sentiment-zh.md", needle: "示例多样性对该策略的效果具有明显影响。" },
      ragRetrievable: true,
    },
    {
      id: "g6-f2",
      faultClass: "unsupported_claim",
      claim: "该方法在所有语言与任务上普遍适用",
      quote: "在三个电商数据集的小样本设置下该方法将宏平均 F1 提升了 2.3 个百分点。",
      locator: { fileName: "sentiment-zh.md", needle: "在三个电商数据集的小样本设置下该方法将宏平均 F1 提升了 2.3 个百分点。" },
      ragRetrievable: true,
    },
  ],
};

export const GROUNDING_SCENARIOS: readonly GroundingScenario[] = [g1, g2, g3, g4, g5, g6];
