// Fixture excerpts for verified-findings tests.
// Source: ICLR 2025 submissions via CoCoReviewBench (CC BY 4.0). HAND-EDITED excerpts, not verbatim and not product input:
// - captions / labels / \multicolumn added by hand; the real benchmark input had flattened headers and no captions;
// - "Table 3" in prose rewritten as Table~\ref{tab:70b}; clauses shortened; rows and whole tables removed;
// - DYSPEC CNN/0 Sequoia cell "0.90751s(6.42)" normalised to "0.90751(6.42)".
// They prove algorithm behaviour on well-formed LaTeX only; they are not evidence of detection on real papers.

export const DYSPEC_TEX = String.raw`\documentclass{article}
\title{DYSPEC: Faster Speculative Decoding with Dynamic Token Tree Structure}
\begin{document}
\begin{abstract}
Under low temperature setting, DYSPEC can improve the throughput up to $9.1\times$ and reduce the latency up to $9.4\times$ on Llama2-70B.
\end{abstract}
\section{Introduction}
Specifically, on the Llama2-70B model, DYSPEC achieves a $9.1 \times$ throughput improvement and $9.4 \times$ reduction in latency.
\section{Empirical Results}
The values in the table represent the average time taken to generate a single token in seconds, with the number of tokens accepted by the target model during a single validation in parentheses.

\begin{table}[htbp]\centering
\caption{latency per token. The draft model is JF68m and the target model is Llama2-7B.}\label{tab:7b}
\begin{tabular}{llllll}
\hline
Dataset & Temp & Ours & Sequoia & Specinfer & Baseline \\ \hline
C4 & 0 & 0.00730(5.25) & 0.00871(4.99) & 0.01289(3.32) & 0.02303 \\
OWT & 0 & 0.00960(3.79) & 0.01001(3.81) & 0.01489(2.54) & 0.02191 \\
\hline
\end{tabular}
\end{table}

In this scenario, the acceleration rate is roughly equivalent to the number of accepted tokens per target model step. DYSPEC achieves up to a 9.1x improvement in throughput and a 9.4x reduction in latency compared to auto-regressive generation, as demonstrated in Table~\ref{tab:70b}.

\begin{table}[htbp]\centering
\caption{latency per token. The draft model is Llama2-7B and the target model is Llama2-70B.}\label{tab:70b}
\begin{tabular}{llllll}
\hline
Dataset & Temp & Ours & Sequoia & Specinfer & Baseline \\ \hline
C4 & 0 & 0.53696(9.10) & 0.88920(6.08) & 1.14332(4.67) & 5.59650 \\
C4 & 0.6 & 0.78912(6.21) & 0.94550(5.72) & 0.92829(5.75) & 5.34781 \\
OWT & 0 & 0.78106(7.23) & 0.91815(6.41) & 1.10449(4.83) & 5.52462 \\
OWT & 0.6 & 0.87547(6.77) & 0.94224(6.07) & 0.97772(5.46) & 5.30340 \\
CNN & 0 & 0.81716(6.93) & 0.90751(6.42) & 1.10608(4.83) & 5.31049 \\
CNN & 0.6 & 0.89055(6.95) & 0.92659(6.07) & 0.92885(5.75) & 5.29280 \\
\hline
\end{tabular}
\end{table}
\section{Conclusion}
Specifically, on the Llama2-70B model with temperature $= 0$, DYSPEC achieves a $9.1 \times$ throughput improvement and $9.4 \times$ reduction in latency.
\end{document}
`;

export const SAMCP_TEX = String.raw`\documentclass{article}
\title{SAM-CP: Marrying SAM with Composable Prompts for Versatile Segmentation}
\begin{document}
\section{Experiments}
\begin{table}[htbp]\centering
\caption{Accuracy (\%) of open-vocabulary panoptic, instance and semantic segmentation.}\label{tab:ov}
\begin{tabular}{lllllllllllllll}
\hline
\multirow{2}{*}{Method} & \multirow{2}{*}{Backbone} & \multicolumn{5}{c}{COCO→ADE20K} & \multicolumn{5}{c}{ADE20K→COCO} & \multicolumn{3}{c}{COCO→Cityscapes} \\
 &  & PQ & SQ & RQ & AP & mIoU & PQ & SQ & RQ & AP & mIoU & PQ & AP & mIoU \\ \hline
FCCLIP [56] & CN-L & 26.8 & 71.5 & 32.3 & 16.8 & 34.1 & 27.0 & 78.0 & 32.9 & - & - & 44.0 & 26.8 & 56.2 \\
SAM-CP & CN-L & 27.2 & 77.7 & 32.9 & 17.0 & 31.8 & 28.6 & 78.4 & 34.5 & 21.9 & 34.3 & 41.0 & 29.3 & 47.9 \\
\hline
\end{tabular}
\end{table}

Open-vocabulary segmentation. Results are summarized in Table~\ref{tab:ov}. In COCO $\rightarrow$ Cityscapes, SAM-CP achieves a $40.6\%$ PQ, a $29.3\%$ AP and a $47.5\%$ mIoU for versatile segmentation, which brings the best Instance Segmentation performance.
\end{document}
`;

export const MECHANISM_TEX = String.raw`\documentclass{article}
\title{Mechanism identification}
\begin{document}
\section{Analysis}
Under the null hypothesis each of the $k$ mechanisms needs a pair of samples from the same class, which gives a 0.036\% probability for $k = 4$ and equal class probabilities.
\end{document}
`;
