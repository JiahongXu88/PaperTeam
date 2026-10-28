#!/usr/bin/env python3
"""M15.10 Phase B：脱敏专家标注包构建器（确定性、零模型）。

输入：
  - M15_10/phase-b/corpus-fresh/{cjig-fresh-manifest.json, parsed/*.json}（12 新鲜 CJIG 族）
  - M15_9/phase-c/materialized/b1-original/manuscript/（MOT 作者稿，第 13 族，DEV_ONLY）
  - M15_9/phase-c/guideline-artifacts/{cjig,cea}.json（官方要求 → 包内 venue 单）

输出（phase-b/ 下）：
  - ANNOTATOR_PACKET_1/、ANNOTATOR_PACKET_2/：同一批 13 样本、不同随机次序与匿名
    编号（P1-Sxx / P2-Axx），隐藏一切系统输出；含委托书、rubric 指南、CSV 模板、
    两刊要求单、逐样本脱敏正文。
  - packet-build/deid-report.json：逐样本脱敏命中与残留风险 grep 结果。

脱敏纪律（任务书 §B2）：
  - 移除：作者/单位/基金/收稿日期/DOI/刊名卷期/页眉页脚/版权块/邮箱/网址；
  - 保留：题目、摘要、关键词、正文、图表题注、参考文献（自引可间接暴露身份——
    已在 README 与 label-source-audit 登记为不可完全去标识局限）；
  - 不改写正文任何实质内容。

CLI：python scripts/m1510-build-packets.py [--seed 1510]
"""

import argparse
import hashlib
import json
import random
import re

BASE = r"D:/PaperTeamData/M15/M15_10"
M159 = r"D:/PaperTeamData/M15/M15_9"
SEED_DEFAULT = 1510

# ---------------------------------------------------------------------------
# 脱敏规则（CJIG docling 文本项）
# ---------------------------------------------------------------------------

# 整行丢弃：期刊题录/版权/身份类模式（命中即丢，不区分大小写）
DROP_PATTERNS = [
    r"版权声明", r"^Copyright", r"All rights reserved", r"京ICP备",
    r"中国图象图形学报", r"Journal of Image and Graphics",
    r"第\s*\d+\s*卷\s*第\s*\d+\s*期", r"总第\s*\d+\s*期", r"Vol\.?\s*\d+.*No\.?\s*\d+",
    r"收稿日期", r"修回日期", r"录用日期", r"预出版日期",
    r"基金资助", r"基金项目", r"国家自然科学基金", r"国家重点研发计划", r"^\s*Fund[:：]",
    r"作者简介", r"通信作者", r"联系人[:：]?", r"^\s*About the author",
    r"E-?mail", r"@\s*[\w.-]+\.(com|cn|org|edu|net|ac)",
    r"\bDOI\b", r"\bdoi\b", r"10\.11834/", r"dx\.doi\.org", r"doi\.org",
    r"http[s]?://", r"www\.", r"\.shtml", r"\.pdf\b",
    r"引用本文", r"Cite this", r"本文引用", r"Citation[:：]",
    r"中国精品科技期刊", r"科技核心期刊", r"中文核心期刊", r"中国国际影响力",
    r"精品科技期刊", r"开放获取", r"Open Access", r"CC BY",
    r"扫描?关注微信", r"二维码",
    r"数据集上传", r"Fig\.?\s*\d+\s*$",
    r"[（(]第\s*\d+\s*页[）)]",
    # 作者简介正文（头部被分离时的残文签名）
    r"\d{4}\s*年生\s*[，,]\s*[男女]", r"主要研究方向\s*为",
    r"received the .{0,40}degree", r"^\s*(Prof|Mr|Ms|Dr)\.?[:：\s]",
]

# 封面/题录页专用（仅作用于 <60 字符短行——避免误伤正文）
MASTHEAD_PATTERNS = [
    r"刊名题字", r"Title inscription", r"Editor-in-Chief", r"China Society of Image",
    r"主\s*编[:：]?", r"副\s*主\s*编", r"编辑出版[:：]?", r"主管单位", r"主办单位",
    r"通信地址", r"邮\s*编", r"电\s*话", r"广告发布登记号", r"总\s*发\s*行", r"订\s*购",
    r"邮政信箱", r"报刊发行局", r"全国各地邮局", r"月.?刊", r"创刊", r"图片新闻", r"目\s*次",
    r"^\s*\d{6}\s*$", r"^\s*0\d{2,3}-\d{7,8}", r"^\s*[\d\-]{10,}\s*$",
    # 英文封面/页眉残留
    r"Address No\.", r"Zip code", r"Telephone", r"Distributed by", r"Domestic",
    r"Overseas", r"Printed by", r"Superintended", r"Sponsored by", r"P\.?\s?O\.?\s?Box",
    r"Editor, Publisher", r"Website", r"CODEN", r"ISSN", r"^CN\s?\d", r"P\.\s?R\.\s?China",
    r"Zhongguo Tuxiang Tuxing Xuebao", r"^Volume\s+\d+", r"Published\s+[A-Z]",
    r"邮发代号", r"发行代号", r"国内定价", r"印刷装订", r"海外发行", r"网\s*址", r"电子信箱",
]

# 单位/机构线索（段落级命中即丢——多见于首页脚注与作者单位块）
AFFILIATION = (
    r"(大学|学院|研究所|研究院|科学院|实验室|重点实验室|公司|集团|医院|中心|工程院"
    r"|University|Institute|College|Laboratory|Academy|Department|School of|Corp|Inc\.?\b)"
)

# 页 1-2 的短行（<100 字符、无句号）且含 顿号/逗号+数字 上标残留——疑似作者行
def looks_like_author_line(text: str) -> bool:
    if len(text) > 100:
        return False
    if "。" in text or "." in text.replace("...", ""):
        return False
    if not re.search(r"[，、,]", text):
        return False
    # 中文人名模式（2-4 字汉字 + 可选数字上标）或英文姓名模式
    zh = re.findall(r"[\u4e00-\u9fff]{2,4}\d{0,3}", text)
    en = re.findall(r"[A-Z][a-z]+ [A-Z]\.?\s?[A-Z]?[a-z]*", text)
    return (len(zh) >= 2 and len("".join(zh)) >= 6) or len(en) >= 2


def looks_like_paper_title(text: str) -> bool:
    """中文论文题锚：10-45 字、无句读、汉字占比足够、且不含题录页词汇。"""
    if not (10 <= len(text) <= 45):
        return False
    if re.search(r"[。：:；;，,]", text):
        return False
    if re.search(r"主管|主办|编辑出版|通信|发行|订购|印刷|定价|邮编|题字|地址|电话|信箱|学报编辑部|应用物理|空天信息", text):
        return False
    zh = re.findall(r"[一-鿿]+", text)
    return sum(len(z) for z in zh) >= 8


def deidentify(items):
    """返回 (保留文本块列表, 丢弃统计)——items 为 {label,text,page} 列表。

    三段策略：① 题录/身份模式丢弃；② 定位论文题锚——其前的全部内容
    （封面/目录/题录页）整体丢弃；③ 题锚后 2 页内的作者行/单位块丢弃。
    """
    drop_re = [re.compile(p, re.I) for p in DROP_PATTERNS]
    masthead_re = [re.compile(p) for p in MASTHEAD_PATTERNS]
    affil_re = re.compile(AFFILIATION)

    # 题锚：第一个满足题形态、且后文 20 项内**同页**出现 摘要(Abstract) 与 关键词(Keywords)
    # 的项——封面/目次页的题录不会误触发（目次条目后文跨页才见摘要，同页要求排除之）
    anchor = None
    for i, it in enumerate(items):
        text = (it.get("text") or "").strip()
        if not looks_like_paper_title(text):
            continue
        page = it.get("page")
        window = items[i : i + 20]
        has_abs = any(
            ("摘要" in (x.get("text") or "") or "摘 要" in (x.get("text") or "") or "Abstract" in (x.get("text") or ""))
            and x.get("page") == page
            for x in window
        )
        has_kw = any(
            ("关键词" in (x.get("text") or "") or "Keywords" in (x.get("text") or "") or "Key words" in (x.get("text") or ""))
            and x.get("page") == page
            for x in window
        )
        if has_abs and has_kw:
            anchor = i
            break

    kept, dropped = [], []
    for idx, it in enumerate(items):
        text = (it.get("text") or "").strip()
        if not text:
            continue
        page = it.get("page") or 0
        label = it.get("label") or ""
        if anchor is not None and idx < anchor:
            dropped.append({"page": page, "label": label, "reason": "before-title-anchor", "preview": text[:50]})
            continue
        if any(r.search(text) for r in drop_re):
            dropped.append({"page": page, "label": label, "reason": "pattern", "preview": text[:50]})
            continue
        if len(text) < 60 and any(r.search(text) for r in masthead_re):
            dropped.append({"page": page, "label": label, "reason": "masthead", "preview": text[:50]})
            continue
        # 题锚后 30 项内的疑似作者行
        if anchor is not None and idx <= anchor + 30 and looks_like_author_line(text):
            dropped.append({"page": page, "label": label, "reason": "author-line", "preview": text[:50]})
            continue
        # 题锚后 2 页内的单位块（含机构词且长度 < 400、非摘要区）
        if (
            anchor is not None
            and page <= ((items[anchor].get("page") or 0) + 2)
            and len(text) < 400
            and affil_re.search(text)
            and "摘要" not in text
            and "Abstract" not in text
        ):
            dropped.append({"page": page, "label": label, "reason": "affiliation", "preview": text[:50]})
            continue
        kept.append({"page": page, "label": label, "text": text})
    return kept, dropped


# ---------------------------------------------------------------------------
# LaTeX（MOT b1-original）→ 纯文本
# ---------------------------------------------------------------------------

def latex_to_text(tex: str) -> str:
    tex = re.sub(r"(?m)%.*$", "", tex)
    tex = re.sub(r"\\begin\{(abstract|figure\*?|table\*?|equation\*?)\}([\s\S]*?)\\end\{\1\}",
                 lambda m: m.group(2), tex)
    tex = re.sub(r"\\cite\{([^}]*)\}", r"[\1]", tex)
    tex = re.sub(r"\\ref\{([^}]*)\}", r"\1", tex)
    tex = re.sub(r"\\(section|subsection|subsubsection|paragraph)\*?\{([^}]*)\}", r"\n\n## \2\n", tex)
    tex = re.sub(r"\\(title|author|date|maketitle|input|include|bibliographystyle|bibliography|documentclass|usepackage|newcommand|begin\{document\}|end\{document\})\s*(\{[^}]*\})*", "", tex)
    tex = re.sub(r"\\[a-zA-Z]+(\[[^\]]*\])?(\{[^{}]*\})?", lambda m: m.group(2) or "", tex)
    tex = re.sub(r"[ \t]+", " ", tex)
    tex = re.sub(r"\n{3,}", "\n\n", tex)
    return tex.strip()


def render_bib(bib_path) -> str:
    entries = []
    try:
        content = open(bib_path, encoding="utf-8").read()
    except OSError:
        return ""
    for m in re.finditer(r"@\w+\{([^,]+),([\s\S]*?)\n\}", content):
        key, body = m.group(1), m.group(2)
        fields = dict(re.findall(r"(\w+)\s*=\s*[{\"]([^\n}]*)[}\"]", body))
        title = fields.get("title", "")
        year = fields.get("year", "")
        author = fields.get("author", "")
        entries.append(f"[{key}] {author}. {title}. {year}.")
    return "\n".join(entries)


# ---------------------------------------------------------------------------
# venue 单（M15.9 冻结 guideline 工件 → 人类可读）
# ---------------------------------------------------------------------------

def render_venue_sheet(venue_id: str) -> str:
    art = json.load(open(f"{M159}/phase-c/guideline-artifacts/{venue_id}.json", encoding="utf-8"))
    lines = [f"# 目标期刊官方投稿要求单：{art['displayName']}", ""]
    lines.append(f"> 来源：官网（{art['identity']['officialSite']}）；摘录与访问日期见每条末尾。")
    lines.append("> 本单只含官方明文要求；未量化的学术水平要求（创新性程度等）以您对该刊已发表论文一般水平的判断为准。")
    lines.append("")
    lines.append("## 期刊范围与栏目")
    lines.append(art["scope"]["scopeStatement"])
    lines.append(f"（出处：{art['scope']['sourceUrl']}）")
    lines.append("")
    lines.append("## 官方要求（逐条）")
    for req in art["requirements"]:
        hard = "硬性" if req.get("hard") else "软性/结构"
        lines.append(
            f"- **[{req['id']}｜{hard}]** {req.get('officialQuote','')}（出处：{req.get('sourceUrl','')}；{req.get('effectiveDate','')}）"
        )
    lines.append("")
    lines.append("## 文章类型")
    for t in art.get("articleTypes", []):
        lines.append(f"- {t.get('labelZh', t.get('id',''))}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

RESIDUAL_GREP = [r"10\.11834", r"doi", r"@", r"http", r"收稿", r"基金", r"通信作者", r"作者简介", r"中国图象图形学报"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=SEED_DEFAULT)
    args = ap.parse_args()

    fresh = json.load(open(f"{BASE}/phase-b/corpus-fresh/cjig-fresh-manifest.json", encoding="utf-8"))
    ok_papers = [p for p in fresh["papers"] if p.get("pdfSha256")]

    samples = []
    for p in ok_papers:
        stem = p["pdfFile"].replace(".pdf", "")
        parsed = json.load(open(f"{BASE}/phase-b/corpus-fresh/parsed/{stem}.json", encoding="utf-8"))
        kept, dropped = deidentify(parsed["items"])
        samples.append({
            "familyKey": f"fresh-{p['doi'].replace('/', '_').replace('.', '-').lower()}",
            "doi": p["doi"],
            "title": p["title"],
            "year": p["year"],
            "docTypeGuess": p["documentTypeGuess"],
            "source": "cjig-corpus-fresh",
            "kept": kept,
            "droppedCount": len(dropped),
            "droppedPreview": dropped[:12],
            "textSha256Input": parsed["pdfSha256"],
        })

    # MOT b1-original（DEV_ONLY 族）
    import os
    b1_dir = f"{M159}/phase-c/materialized/b1-original/manuscript"
    main_tex = open(f"{b1_dir}/main.tex", encoding="utf-8").read()
    body = latex_to_text(main_tex)
    for sec in sorted(os.listdir(f"{b1_dir}/sections")):
        if sec.endswith(".tex"):
            body += "\n\n" + latex_to_text(open(f"{b1_dir}/sections/{sec}", encoding="utf-8").read())
    body += "\n\n## 参考文献\n" + render_bib(f"{b1_dir}/references.bib")
    b1_items = [{"page": None, "label": "paragraph", "text": para.strip()} for para in body.split("\n") if para.strip()]
    samples.append({
        "familyKey": "mot-b1",
        "doi": None,
        "title": "多目标跟踪评测指标体系综述（作者投稿稿）",
        "year": 2026,
        "docTypeGuess": "survey",
        "source": "author-manuscript",
        "kept": b1_items,
        "droppedCount": 0,
        "droppedPreview": [],
        "textSha256Input": None,
    })
    assert len(samples) == 13, f"expect 13 samples, got {len(samples)}"

    def sample_md(sample) -> str:
        out = [f"# 稿件正文（{sample['title'] if sample['source']=='author-manuscript' else '（题目见正文首行）'}）", ""]
        for it in sample["kept"]:
            prefix = {"section_header": "## ", "title": "# "}.get(it["label"], "")
            out.append(prefix + it["text"] if prefix else it["text"])
        return "\n".join(out)

    rng1 = random.Random(args.seed)
    rng2 = random.Random(args.seed + 1)
    order1 = list(range(13))
    order2 = list(range(13))
    rng1.shuffle(order1)
    rng2.shuffle(order2)

    packets = {}
    for prefix, order, rng in (("P1", order1, rng2), ("P2", order2, rng1)):
        # P1 用 S 序号、P2 用 A 序号；同包内编号顺序 = 打乱后的样本顺序
        ids = []
        for i, idx in enumerate(order, start=1):
            tag = f"S{i:02d}" if prefix == "P1" else f"A{i:02d}"
            ids.append(f"{prefix}-{tag}")
        packets[prefix] = list(zip(ids, order))

    deid_report = {"seed": args.seed, "samples": []}
    import shutil
    for prefix, entries in packets.items():
        pdir = f"{BASE}/phase-b/ANNOTATOR_PACKET_{prefix[-1]}"
        os.makedirs(f"{pdir}/samples", exist_ok=True)
        for doc in ("EXPERT_ANNOTATION_REQUEST.md", "EXPERT_RUBRIC_AND_INSTRUCTIONS.md", "labels_template.csv"):
            shutil.copyfile(f"{BASE}/phase-b/{doc}", f"{pdir}/{doc}")
        open(f"{pdir}/venue-cjig.md", "w", encoding="utf-8").write(render_venue_sheet("cjig"))
        open(f"{pdir}/venue-cea.md", "w", encoding="utf-8").write(render_venue_sheet("cea"))
        for sample_id, idx in entries:
            sample = samples[idx]
            md = sample_md(sample)
            open(f"{pdir}/samples/{sample_id}.md", "w", encoding="utf-8").write(md)

    # 脱敏报告（残留风险 grep）
    for idx, s in enumerate(samples):
        text = "\n".join(it["text"] for it in s["kept"])
        residual = {p: len(re.findall(p, text, re.I)) for p in RESIDUAL_GREP}
        deid_report["samples"].append({
            "familyKey": s["familyKey"],
            "doi": s["doi"],
            "title": s["title"],
            "source": s["source"],
            "keptItems": len(s["kept"]),
            "droppedItems": s["droppedCount"],
            "droppedPreview": s["droppedPreview"],
            "residualHits": residual,
            "textSha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        })
    json.dump(deid_report, open(f"{BASE}/packet-build/deid-report.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    # phase-c/sample-manifest.json（双包匿名 ID ↔ 真实族映射；私有数据目录，不随包分发）
    bench = json.load(open(f"{M159}/phase-b/corpus/cjig/cjig-manifest-v2.json", encoding="utf-8"))
    families = {}
    for s in deid_report["samples"]:
        dev_only = s["source"] == "author-manuscript"
        families[s["familyKey"]] = {
            "doi": s["doi"],
            "source": s["source"],
            "devOnly": dev_only,
            **({"devReason": "M15.9 rubric A2/A3 开发语料（臂输出已存在）——只可作校准分析，不计入独立盲测"} if dev_only else {}),
            "title": s["title"],
            "textSha256": s["textSha256"],
        }
    sample_manifest = {
        "schemaVersion": 1,
        "generatedAt": __import__("datetime").datetime.now().astimezone().isoformat(timespec="seconds"),
        "purpose": "M15.10 专家标注双包映射（私有）：匿名 sampleId ↔ 真实 paper family；导入器唯一解析入口",
        "seed": args.seed,
        "orders": {"P1": order1, "P2": order2},
        "packets": {
            prefix: {
                "samples": [{"sampleId": sid, "familyKey": samples[idx]["familyKey"]} for sid, idx in entries]
            }
            for prefix, entries in packets.items()
        },
        "families": families,
        "benchmarkDois": [p["doi"].lower() for p in bench["papers"]],
        "isolationNote": "12 fresh 族与 benchmark 24 DOI 确定性排除（见 phase-b/corpus-fresh/cjig-fresh-manifest.json）；mot-b1 族 DEV_ONLY",
        "rightsVerifiedAt": None,
    }
    json.dump(sample_manifest, open(f"{BASE}/phase-c/sample-manifest.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"[m1510-packets] sample-manifest → {BASE}/phase-c/sample-manifest.json")

    # 双包 README
    for prefix, entries in packets.items():
        n = prefix[-1]
        readme = f"""# ANNOTATOR_PACKET_{n} 评审包使用说明

- 您的评审员匿名 ID：__________（自拟，交表时填入 CSV 的 reviewer_id 列）
- 本包含 13 篇脱敏稿件（samples/ 目录，编号 {prefix}-S01… 或 {prefix}-A…），请按任意顺序逐篇评审；
- 每篇稿件在**两本目标期刊口径下各评一次**（venue-cjig.md 与 venue-cea.md 为官方要求单）：
  - 六个通用维度（novelty/contribution/technical_soundness/experimental_adequacy/clarity）一次阅读给出；
  - relevance 与 overall 分别按 CJIG、CEA 口径各给一次；
  - CSV 中每篇稿件两行（venue=cjig / venue=cea），sample_id 填本包编号（{prefix}-…）；
- 填表交付：labels_template.csv（列含义见 EXPERT_RUBRIC_AND_INSTRUCTIONS.md 与 CSV 表头）；
- 独立性：不得检索稿件出处/录用结果/被引；不得参考任何 AI 评价；不与其他评审员讨论；
- 稿件为 PDF 解析文本：图与公式的视觉细节可能缺失，图表以题注呈现；因图缺失无法判断的维度请选 INSUFFICIENT_EVIDENCE；
- 脱敏说明：已移除作者/单位/基金/DOI/刊名等身份信息；参考文献列表保留（自引可能间接暴露身份，属已知不可完全去标识局限——请勿据此检索）。

包内容：EXPERT_ANNOTATION_REQUEST.md（委托条款）｜EXPERT_RUBRIC_AND_INSTRUCTIONS.md（评分指南）｜labels_template.csv（交付表）｜venue-cjig.md、venue-cea.md（期刊要求单）｜samples/（13 篇稿件）
"""
        open(f"{BASE}/phase-b/ANNOTATOR_PACKET_{n}/README.md", "w", encoding="utf-8").write(readme)

    print(f"[m1510-packets] built: P1 order={order1} / P2 order={order2}")
    print(f"[m1510-packets] deid-report → {BASE}/packet-build/deid-report.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
