#!/usr/bin/env python3
"""M15.10 Phase B：docling PDF → 阅读顺序文本抽取（零模型）。

对 M15.10 新鲜样本 PDF 逐篇解析，产出：
  parsed/<stem>.json  —— {ok, parser, pdfPath, pageCount, items:[{label,text,page}], sha256}
  parsed/<stem>.txt   —— 人类可读阅读顺序文本（label 前缀行 + 正文）

用途：为脱敏标注包（ANNOTATOR_PACKET_*）提供底稿文本。确定性纪律：
OCR 关闭（do_ocr=False，与 backend/tools/parse_document_docling.py 一致——
不用 OCR 猜内容）；仅读取顺序 + 标签 + 页码，不抽图片资产。

CLI：python scripts/m1510-parse-pdf-text.py [--in <pdf-dir>] [--out <parsed-dir>]
（缺省指向 D:/PaperTeamData/M15/M15_10/phase-b/corpus-fresh/{pdf,parsed}）
"""

import hashlib
import json
import os
import sys

from docling.document_converter import DocumentConverter

PDF_DIR = r"D:/PaperTeamData/M15/M15_10/phase-b/corpus-fresh/pdf"
OUT_DIR = r"D:/PaperTeamData/M15/M15_10/phase-b/corpus-fresh/parsed"

MAX_TEXT_CHARS = 20000


def main() -> int:
    pdf_dir = PDF_DIR
    out_dir = OUT_DIR
    argv = sys.argv[1:]
    for i, a in enumerate(argv):
        if a == "--in" and i + 1 < len(argv):
            pdf_dir = argv[i + 1]
        elif a == "--out" and i + 1 < len(argv):
            out_dir = argv[i + 1]
    os.makedirs(out_dir, exist_ok=True)
    pdfs = sorted(f for f in os.listdir(pdf_dir) if f.lower().endswith(".pdf"))
    if not pdfs:
        print(f"[m1510-parse] no pdf under {pdf_dir}", file=sys.stderr)
        return 1

    import docling
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions

    # 确定性纪律（与 backend/tools/parse_document_docling.py 一致）：
    # do_ocr=False——不做 OCR（扫描件如实降级）；TableFormer 表格结构开启。
    pipeline_options = PdfPipelineOptions()
    pipeline_options.do_ocr = False
    pipeline_options.do_table_structure = True
    converter = DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)}
    )
    failures = []
    for name in pdfs:
        stem = name[:-4]
        out_json = os.path.join(out_dir, f"{stem}.json")
        out_txt = os.path.join(out_dir, f"{stem}.txt")
        if os.path.exists(out_json):
            print(f"[m1510-parse] skip (exists) {stem}")
            continue
        pdf_path = os.path.join(pdf_dir, name)
        raw = open(pdf_path, "rb").read()
        pdf_sha = hashlib.sha256(raw).hexdigest()
        try:
            result = converter.convert(pdf_path)
            doc = result.document
            items = []
            for item, _level in doc.iterate_items():
                label = getattr(item, "label", None)
                label = str(getattr(label, "value", label) or "").lower()
                text = str(getattr(item, "text", "") or "").strip()
                if not text:
                    continue
                provs = getattr(item, "prov", []) or []
                page = None
                if provs:
                    # docling 2.x ProvenanceItem 的页码字段是 page_no（1-based）
                    raw_page = getattr(provs[0], "page_no", None) or getattr(provs[0], "page", None)
                    try:
                        page = int(raw_page) if raw_page else None
                    except (TypeError, ValueError):
                        page = None
                items.append(
                    {"label": label, "text": text[:MAX_TEXT_CHARS], "page": page}
                )
            page_count = int(result.pages and len(result.pages) or 0) or None
            payload = {
                "ok": True,
                "parser": {"id": "docling", "version": getattr(docling, "__version__", "unknown")},
                "pdfPath": pdf_path,
                "pdfSha256": pdf_sha,
                "pageCount": page_count,
                "items": items,
            }
            with open(out_json, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, ensure_ascii=False)
            with open(out_txt, "w", encoding="utf-8") as fh:
                for it in items:
                    fh.write(f"[{it['label']}|p{it['page']}] {it['text']}\n")
            print(f"[m1510-parse] ok {stem} ({len(items)} items, {page_count}p)")
        except Exception as exc:  # noqa: BLE001 —— 失败逐篇记录，不中断其余
            failures.append({"pdf": name, "error": str(exc)[:300]})
            print(f"[m1510-parse] FAIL {stem}: {exc}", file=sys.stderr)
    if failures:
        with open(os.path.join(out_dir, "_failures.json"), "w", encoding="utf-8") as fh:
            json.dump(failures, fh, ensure_ascii=False, indent=1)
        return 1
    print(f"[m1510-parse] done {len(pdfs)} pdfs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
