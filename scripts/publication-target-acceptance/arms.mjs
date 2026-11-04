/**
 * 预先登记的对照臂（PROTOCOL.md §2）。A = 未设置发表目标；B = CAS 三区（用户设定、未核实）；C = CAS 一区（同为用户设定、未核实）。
 * 只比较「关注点 / 证据纪律」差异；不假设 C 比 B「更严格」是事实。
 */
export const ARMS = {
  A: { target: null, label: "未设置发表目标" },
  B: { target: { scheme: "cas", tier: "3" }, label: "中科院三区（用户设定，未核实）" },
  C: { target: { scheme: "cas", tier: "1" }, label: "中科院一区（用户设定，未核实）" },
  // 综述：S0 = 综述无目标（稿型政策仍 active）；S1 = 综述 + CSSCI（用户设定）
  S0: { target: null, label: "综述 · 未设置发表目标" },
  S1: { target: { scheme: "chinese_index", tier: "CSSCI" }, label: "综述 · CSSCI（用户设定，未核实）" },
};
