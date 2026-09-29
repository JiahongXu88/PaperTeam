#!/usr/bin/env python3
"""PaperTeam 结构化文档解析工具（docling adapter 的 Python 侧）。

由 backend/src/ingestion/DoclingParser.ts 经 child_process.execFile 调用
（无 shell，无注入面）。协议与 parse_paper_pdf.py 一致：argv = PDF 绝对路径
+ 可选图片输出目录 + 可选公式开关；stdout 最后一行是单个 JSON 对象；
日志 / 告警走 stderr；stdout 解析期间经 fd 重定向隔离 C 层噪声。

职责边界（成熟组件负责解析，PaperTeam 负责抽象 / provenance）：
  docling = 版面分析 + 阅读顺序 + 表格结构（TableFormer）+ 图片检测
            + 可选公式 LaTeX（--formulas，需额外模型下载）；
  Node    = ParsedDocument 归一化、块 id、上限、持久化、Evidence 语义。

确定性纪律：OCR 默认关闭（do_ocr=False）——扫描件如实产出稀疏文本 +
notes 说明，不用 OCR 模型猜内容。首次解析会下载布局 / 表格模型
（HuggingFace 缓存，国内可用 HF_ENDPOINT=https://hf-mirror.com）。
"""

import json
import os
import sys

MAX_BLOCKS = 20000          # 块总数上限（与 Node 侧 INGESTION_LIMITS 对齐）
MAX_TABLE_ROWS = 500        # 单表格行数上限
MAX_TEXT_CHARS = 20000      # 单文本块字符上限
MAX_NOTES = 20

TEXT_LABELS = {
    "paragraph": "paragraph",
    "title": "title",
    "section_header": "section_header",
    "list_item": "list_item",
    "caption": "caption",
    "page_header": "paragraph",
    "page_footer": "paragraph",
    "text": "paragraph",
    "footnote": "paragraph",
    "document_index": "paragraph",
    "code": "paragraph",
    "checkbox_selected": "paragraph",
    "checkbox_unselected": "paragraph",
    "key_value_region": "paragraph",
    "picture_caption": "caption",
    "table_caption": "caption",
    "formula": "formula",
}


def label_of(item) -> str:
    """item.label 小写字符串。docling-core 的 label 是 str-Enum——
    str(label) 会得到 "DocItemLabel.PARAGRAPH"，必须取 .value。"""
    label = getattr(item, "label", None)
    if label is None:
        return ""
    value = getattr(label, "value", label)
    return str(value).lower()


def iter_body_items(document):
    """iterate_items 产出 (item, level) 元组（docling 2.x）；兼容裸 item。"""
    for entry in document.iterate_items():
        if isinstance(entry, tuple):
            yield entry[0]
        else:
            yield entry


def main() -> int:
    protocol_out = os.fdopen(os.dup(1), "w", encoding="utf-8", closefd=True)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    def emit(payload: dict) -> None:
        protocol_out.write(json.dumps(payload, ensure_ascii=False))
        protocol_out.write("\n")
        protocol_out.flush()

    args = sys.argv[1:]
    formulas = "--formulas" in args
    figures_dir = None
    for arg in args:
        if arg.startswith("--figures-dir="):
            figures_dir = arg.split("=", 1)[1]
    positional = [a for a in args if not a.startswith("--")]
    if len(positional) != 1:
        emit({"ok": False, "code": "usage", "error": "用法: parse_document_docling.py <pdf-path> [--figures-dir=DIR] [--formulas]"})
        return 2
    pdf_path = positional[0]

    try:
        from docling.document_converter import DocumentConverter, PdfFormatOption
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions
    except ImportError:
        emit({
            "ok": False,
            "code": "dependency_missing",
            "error": "docling 未安装（PaperTeam 结构化解析依赖 docling，请运行: pip install docling）",
        })
        return 3

    try:
        result = convert(pdf_path, figures_dir, formulas)
        emit(result)
        return 0
    except Exception as exc:  # noqa: BLE001（任何失败收敛为结构化错误，不 traceback）
        emit({"ok": False, "code": "parse_failed", "error": f"docling 解析失败：{exc}"[:400]})
        return 4


def convert(pdf_path, figures_dir, formulas):
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions

    pipeline_options = PdfPipelineOptions()
    pipeline_options.do_ocr = False               # 确定性：不做 OCR（扫描件如实降级）
    pipeline_options.do_table_structure = True    # TableFormer 表格结构
    if figures_dir is not None:
        pipeline_options.generate_picture_images = True
        pipeline_options.images_scale = 2.0
    if formulas:
        pipeline_options.do_formula_enrichment = True

    converter = DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)}
    )
    conversion = converter.convert(pdf_path)
    document = conversion.document

    notes = []
    blocks = []
    section_stack = []  # (level, title)
    figure_index = 0

    def prov_of(item):
        # docling-core：item.prov 是 ProvenanceItem 列表（多 provenance 取首个）
        provs = getattr(item, "prov", None) or []
        prov = provs[0] if isinstance(provs, list) and provs else None
        page = getattr(prov, "page_no", None) if prov is not None else None
        bbox = getattr(prov, "bbox", None) if prov is not None else None
        coords = None
        if bbox is not None:
            coords = [
                round(float(getattr(bbox, attr)), 2)
                for attr in ("l", "b", "r", "t")  # docling：页面左下原点，0-100 归一
            ]
        out = {}
        if isinstance(page, int) and page > 0:
            out["page"] = page
        if coords is not None:
            out["bbox"] = coords
        ref = getattr(item, "self_ref", None)
        if isinstance(ref, str) and ref:
            out["ref"] = ref
        if section_stack:
            out["section"] = section_stack[-1][1]
        return out

    def clip_text(text):
        if len(text) > MAX_TEXT_CHARS:
            note_once(f"文本块超过 {MAX_TEXT_CHARS} 字符，已截断")
            return text[:MAX_TEXT_CHARS]
        return text

    def note_once(message):
        if len(notes) < MAX_NOTES and message not in notes:
            notes.append(message)

    items = list(iter_body_items(document))
    page_count = len(document.pages) if document.pages else None

    for item in items:
        if len(blocks) >= MAX_BLOCKS:
            note_once(f"块数达到上限 {MAX_BLOCKS}，后续内容截断")
            break
        label = label_of(item)
        kind = TEXT_LABELS.get(label)
        item_type = type(item).__name__

        if item_type == "SectionItem" or label == "document_index":
            continue  # 结构节点（非内容）；标题已作为 section_header 文本块处理

        if label in ("section_header", "title") and hasattr(item, "text"):
            text = clip_text(str(item.text or "").strip())
            if text:
                blocks.append({"type": "text", "textKind": "title" if label == "title" else "section_header", "text": text, **prov_of(item)})
                if label == "section_header":
                    # 扁平章节跟踪（provenance.section 是展示字符串；层级树属
                    # chunker 的 deriveDocumentStructure 职责，不在本层重建）
                    section_stack.clear()
                    section_stack.append((1, text))
            continue

        if item_type == "TableItem" or label == "table":
            table_block = table_of(item, prov_of(item), note_once)
            if table_block is not None:
                blocks.append(table_block)
            continue

        if item_type == "PictureItem" or label == "picture":
            figure_index += 1
            block = {"type": "figure", **prov_of(item)}
            caption = captions_of(item)
            if caption:
                block["caption"] = clip_text(caption)
            if figures_dir is not None:
                name = save_picture(item, figures_dir, figure_index)
                if name is not None:
                    block["imageFile"] = name
            blocks.append(block)
            continue

        if label == "formula" or item_type == "FormulaItem":
            # 未开启 formula enrichment 时 text 为空：仍登记块（页码 / bbox /
            # ref 可供 M10.2 定位），内容字段留空不伪造
            latex = None
            text = clip_text(str(getattr(item, "text", "") or "").strip())
            if text.startswith("$") and text.endswith("$") and len(text) > 1:
                latex = text[1:-1]
                text = ""
            block = {"type": "formula", **prov_of(item)}
            if latex:
                block["latex"] = latex
            if text:
                block["text"] = text
            blocks.append(block)
            continue

        if kind is not None and hasattr(item, "text"):
            text = clip_text(str(item.text or "").strip())
            if text:
                blocks.append({"type": "text", "textKind": kind, "text": text, **prov_of(item)})
            continue

    if page_count is not None:
        page_count = int(page_count)
    result = {
        "ok": True,
        "parser": {"id": "docling", "version": docling_version()},
        "pdfPath": pdf_path,
        "pageCount": page_count,
        "blocks": blocks,
        "notes": notes,
    }
    return result


def docling_version():
    try:
        import docling
        return getattr(docling, "__version__", "unknown")
    except Exception:  # noqa: BLE001
        return "unknown"


def table_of(item, prov, note_once):
    """TableItem → 网格（headers + rows）。优先 dataframe；退化用 markdown 文本。"""
    try:
        df = item.export_to_dataframe()
        headers = [("" if h is None else str(h)).strip() for h in df.columns.tolist()]
        rows = []
        for _, row in df.iterrows():
            rows.append([
                clip_cell("" if v is None else format_value(v), note_once)
                for v in row.tolist()
            ])
        if len(rows) > MAX_TABLE_ROWS:
            note_once(f"表格行数超过 {MAX_TABLE_ROWS}，已截断（原 {len(rows)} 行）")
            rows = rows[:MAX_TABLE_ROWS]
        block = {"type": "table", "headers": headers, "rows": rows, "rowCount": len(rows), "columnCount": len(headers), **prov}
        caption = captions_of(item)
        if caption:
            block["caption"] = caption[:MAX_TEXT_CHARS]
        return block
    except Exception:  # noqa: BLE001（dataframe 不可用时退化为 markdown 文本形态）
        try:
            text = item.export_to_markdown().strip()
        except Exception:  # noqa: BLE001
            text = str(getattr(item, "text", "") or "").strip()
        if not text:
            return None
        return {"type": "table", "headers": [], "rows": [], "rowCount": 0, "columnCount": 0, "textFallback": text[:MAX_TEXT_CHARS], **prov}


def captions_of(item):
    try:
        captions = getattr(item, "captions", None) or []
        texts = []
        for cap in captions:
            text = str(getattr(cap, "text", "") or "").strip()
            if text:
                texts.append(text)
        return " ".join(texts) if texts else None
    except Exception:  # noqa: BLE001
        return None


def format_value(value):
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if isinstance(value, float) and value == int(value) and abs(value) < 1e15:
        return str(int(value))  # dataframe 常把整数列读成 float（82.0 → 82）
    return str(value)


def clip_cell(value, note_once):
    if len(value) > 2000:
        note_once("单元格内容超过 2000 字符，已截断")
        return value[:2000]
    return value


def save_picture(item, figures_dir, index):
    """图片资产落盘（PIL image → figures-dir/fig-N.png）；失败返回 None。"""
    try:
        image = getattr(item, "image", None)
        pil = getattr(image, "pil_image", None) if image is not None else None
        if pil is None:
            return None
        os.makedirs(figures_dir, exist_ok=True)
        name = f"fig-{index:03d}.png"
        pil.save(os.path.join(figures_dir, name))
        return name
    except Exception:  # noqa: BLE001（资产抽取 best-effort；块本身仍登记）
        return None


if __name__ == "__main__":
    sys.exit(main())
