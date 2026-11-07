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
notes 说明，不用 OCR 模型猜内容。

模型资源（M17.2.2）：布局 / 表格模型来自 HuggingFace 缓存。
  --preflight  离线检查所需模型是否已缓存（不下载、不加载模型）；
  --warmup     下载所需模型（首次运行；国内可设 HF_ENDPOINT=https://hf-mirror.com）。
两者 stdout 最后一行同样是单个 JSON（code=models_ready / models_missing /
model_download_failed）。模型已缓存时 Node 侧以 HF_HUB_OFFLINE=1 启动解析，
避免每篇文档都联网核对模型版本。

进度协议（M17.2.2）：解析期间向 stderr 写 `PAPERTEAM_PROGRESS {json}` 行
（启动 / 模型加载完成 / docling 流水线某 stage 完成一批页面 / 序列化），
Node 侧据此续期无进展超时；进度行不改变解析结果。
"""

import json
import logging
import os
import sys
import threading
import time

MAX_BLOCKS = 20000          # 块总数上限（与 Node 侧 INGESTION_LIMITS 对齐）
MAX_TABLE_ROWS = 500        # 单表格行数上限
MAX_TEXT_CHARS = 20000      # 单文本块字符上限
MAX_NOTES = 20
PROGRESS_PREFIX = "PAPERTEAM_PROGRESS "
# docling 流水线在 DEBUG 级别为每个 stage 的每批页面记一条 PIPELINE_PROFILING 日志：
# 这是解析器内部真实推进的唯一公开信号（版本漂移时只失去页面级进度，不影响解析）
PIPELINE_LOGGER = "docling.pipeline.standard_pdf_pipeline"
# CPU 存活心跳：docling 只在「一批页面」完成时记日志，重页面（大表格 / 大图）的单批可持续数分钟。
# 每 CPU_BEAT_INTERVAL 秒检查一次本进程 CPU 时间；期间确实消耗了 >= CPU_BEAT_MIN_SECONDS 的 CPU
# 才发 working 进度。挂起（等网络 / 死锁）不耗 CPU → 不发心跳 → Node 侧无进展上限照常触发；
# 失控循环由 Node 侧单篇总时长上限兜底。
CPU_BEAT_INTERVAL = 30.0
CPU_BEAT_MIN_SECONDS = 5.0

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


def emit_progress(phase, **fields):
    """stderr 进度行（独占一行：前置换行，避免与 tqdm 的 \\r 进度条粘连）。"""
    try:
        payload = {"phase": phase, **fields}
        sys.stderr.write("\n" + PROGRESS_PREFIX + json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stderr.flush()
    except Exception:  # noqa: BLE001（进度是观测，不影响解析）
        pass


class PipelineProgressHandler(logging.Handler):
    """docling PIPELINE_PROFILING 日志 → 进度行；其余 WARNING 以上原样进 stderr。"""

    def emit(self, record):
        try:
            message = str(record.msg)
            args = record.args if isinstance(record.args, tuple) else ()
            if message.startswith("PIPELINE_PROFILING Stage preprocess") and len(args) >= 2:
                emit_progress("pipeline", stage="preprocess", pages=[int(p) for p in args[1]])
            elif message.startswith("PIPELINE_PROFILING Stage") and len(args) >= 3:
                emit_progress("pipeline", stage=str(args[0]), pages=[int(p) for p in args[2]])
            elif record.levelno >= logging.WARNING:
                sys.stderr.write(record.getMessage() + "\n")
        except Exception:  # noqa: BLE001
            pass


def install_progress_hook():
    logger = logging.getLogger(PIPELINE_LOGGER)
    logger.setLevel(logging.DEBUG)
    logger.addHandler(PipelineProgressHandler())
    logger.propagate = False


def start_cpu_heartbeat():
    """后台守护线程：进程 CPU 时间确实推进时发 working 进度（见 CPU_BEAT_* 注释）。"""
    def beat():
        last = time.process_time()
        while True:
            time.sleep(CPU_BEAT_INTERVAL)
            now = time.process_time()
            if now - last >= CPU_BEAT_MIN_SECONDS:
                emit_progress("working", cpuSeconds=round(now - last, 1))
            last = now

    threading.Thread(target=beat, name="paperteam-cpu-heartbeat", daemon=True).start()


def required_models():
    """当前管线（OCR 关、表格结构开）需要的模型：[(名称, 获取函数)]。获取函数在离线模式下
    只查缓存（未缓存抛错），联网模式下下载——与 docling 解析时的取模型路径完全相同。"""
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.models.stages.table_structure.table_structure_model import TableStructureModel
    from docling.models.utils.hf_model_download import download_hf_model

    spec = PdfPipelineOptions().layout_options.model_spec
    return [
        (f"{spec.repo_id}@{spec.revision}", lambda: download_hf_model(repo_id=spec.repo_id, revision=spec.revision)),
        ("table_structure", TableStructureModel.download_models),
    ]


def is_model_unavailable(exc) -> bool:
    """离线模式下模型缓存缺失 / 损坏（huggingface_hub 的本地条目错误）。"""
    seen = set()
    current = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        name = type(current).__name__
        text = str(current)
        if name in ("LocalEntryNotFoundError", "OfflineModeIsEnabled") or "HF_HUB_OFFLINE" in text \
                or "local_files_only" in text or "outgoing traffic has been disabled" in text:
            return True
        current = current.__cause__ or current.__context__
    return False


def model_report(download: bool) -> dict:
    """--preflight（download=False，离线只查缓存）/ --warmup（download=True）。"""
    try:
        models = required_models()
    except ImportError as exc:
        return {"ok": False, "code": "preflight_unsupported", "error": f"当前 docling 版本不支持模型预检：{exc}"[:400]}
    report = []
    for name, fetch in models:
        if download:
            emit_progress("warmup", model=name)
        started = time.monotonic()
        try:
            path = fetch()
            report.append({"repo": name, "cached": True, "path": str(path), "seconds": round(time.monotonic() - started, 2)})
        except Exception as exc:  # noqa: BLE001
            if download:
                return {"ok": False, "code": "model_download_failed", "models": report,
                        "error": f"{name} 下载失败：{type(exc).__name__}: {exc}"[:400]}
            report.append({"repo": name, "cached": False, "error": f"{type(exc).__name__}: {exc}"[:200]})
    missing = [m for m in report if not m["cached"]]
    return {"ok": True, "code": "models_missing" if missing else "models_ready", "models": report}


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
    if "--preflight" in args or "--warmup" in args:
        warmup = "--warmup" in args
        if not warmup:
            # 预检必须离线：只回答「缓存里有没有」，绝不触发下载（须在 import huggingface_hub 前设置）
            os.environ["HF_HUB_OFFLINE"] = "1"
        try:
            import docling  # noqa: F401
        except ImportError:
            emit({"ok": False, "code": "dependency_missing",
                  "error": "docling 未安装（PaperTeam 结构化解析依赖 docling，请运行: pip install docling）"})
            return 3
        emit(model_report(download=warmup))
        return 0

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
        if is_model_unavailable(exc):
            # 依赖问题（离线模型缓存缺失 / 损坏），不是 PDF 内容问题
            emit({"ok": False, "code": "model_unavailable", "error": f"{type(exc).__name__}: {exc}"[:400]})
            return 5
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

    started = time.monotonic()
    emit_progress("loading")
    install_progress_hook()
    start_cpu_heartbeat()
    converter = DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)}
    )
    converter.initialize_pipeline(InputFormat.PDF)  # 模型加载单独计时（与逐页解析区分）
    init_seconds = round(time.monotonic() - started, 2)
    emit_progress("converting")
    conversion = converter.convert(pdf_path)
    convert_seconds = round(time.monotonic() - started - init_seconds, 2)
    emit_progress("serializing")
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
        "timings": {"initSeconds": init_seconds, "convertSeconds": convert_seconds},
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
