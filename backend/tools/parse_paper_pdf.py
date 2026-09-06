#!/usr/bin/env python3
"""PaperTeam PDF 解析工具（M4.3.1）。

由 backend/src/paper/PdfParser.ts 经 child_process.execFile 调用（无 shell）。
协议：stdin 无输入；argv[1] = PDF 绝对路径；stdout 输出单个 JSON 对象；
日志/告警走 stderr。stdout 强制 UTF-8（Windows GBK 控制台兼容）。

职责边界（刻意保持薄）：
  Python = 原始提取：页文本块、TOC、文档元数据、标题/摘要启发式。
  Node   = 领域组装：section/chunk 划分、ID、质量评级、持久化。
（领域逻辑留在 TypeScript 侧可单测，Python 保持可替换的提取层。）
"""

import json
import sys

# Windows 默认 GBK：强制 UTF-8，否则非 ASCII 字符直接崩溃
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

MAX_BLOCKS = 20000          # 防御性上限（超大 PDF）
MAX_TEXT_CHARS = 2_000_000  # 提取总字符上限


def main() -> int:
    if len(sys.argv) != 2:
        print(json.dumps({"ok": False, "error": "用法: parse_paper_pdf.py <pdf-path>"}), flush=True)
        return 2
    pdf_path = sys.argv[1]
    try:
        import pymupdf  # noqa: PLC0415（延迟导入：依赖缺失时输出结构化错误而非 traceback）
    except ImportError:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "pymupdf 未安装（PaperTeam PDF 解析依赖 pymupdf>=1.24，"
                    "请运行: pip install pymupdf）",
                }
            ),
            flush=True,
        )
        return 3

    try:
        doc = pymupdf.open(pdf_path)
    except Exception as exc:  # noqa: BLE001（任何打开失败都收敛为结构化错误）
        print(json.dumps({"ok": False, "error": f"无法打开 PDF：{exc}"}, ensure_ascii=False))
        return 4

    try:
        result = extract(doc, pdf_path, pymupdf.__version__ if hasattr(pymupdf, "__version__") else "unknown")
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"解析失败：{exc}"}, ensure_ascii=False))
        return 5


def extract(doc, pdf_path: str, parser_version: str) -> dict:
    page_count = doc.page_count
    notes = []

    # ---- 页文本块（chunk 的 provenance 单位） ----
    blocks = []
    total_chars = 0
    for page_index in range(page_count):
        page = doc[page_index]
        page_number = page_index + 1
        for raw in page.get_text("blocks"):
            # block: (x0, y0, x1, y1, text, block_no, block_type)；type 0 = 文本
            if len(raw) < 7 or raw[6] != 0:
                continue
            text = normalize_block_text(str(raw[4]))
            if text == "":
                continue
            blocks.append({"page": page_number, "text": text})
            total_chars += len(text)
            if len(blocks) >= MAX_BLOCKS or total_chars >= MAX_TEXT_CHARS:
                notes.append(f"达到提取上限（blocks={len(blocks)}），后续内容截断")
                break
        if len(blocks) >= MAX_BLOCKS or total_chars >= MAX_TEXT_CHARS:
            break

    # ---- TOC（存在则作为 section 结构的权威来源） ----
    toc = [[entry[0], str(entry[1]), int(entry[2])] for entry in doc.get_toc(simple=True)]

    # ---- 标题：元数据 > 首页最大字号块 ----
    metadata_title = (doc.metadata or {}).get("title", "") or ""
    title = metadata_title.strip() if metadata_title.strip() else largest_font_line(doc)

    # ---- 摘要启发式：首页 "Abstract" 后的首段 ----
    abstract = extract_abstract(blocks)

    if not toc:
        notes.append("PDF 无 TOC outline；section 结构将退化为标题正则识别")
    if doc.is_encrypted:
        notes.append("PDF 带加密标记（pymupdf 已按空密码打开，内容可能不完整）")

    return {
        "ok": True,
        "parser": {"id": "pymupdf", "version": parser_version},
        "pdfPath": pdf_path,
        "pageCount": page_count,
        "title": title,
        "abstract": abstract,
        "toc": toc,
        "blocks": blocks,
        "totalChars": total_chars,
        "notes": notes,
    }


def normalize_block_text(text: str) -> str:
    # 统一换行符、去首尾空白；块内换行保留（Node 侧组 chunk 时再处理）
    joined = chr(13) + chr(10)
    return text.replace(joined, chr(10)).replace(chr(13), chr(10)).strip()


def largest_font_line(doc) -> str:
    """首页最大字号的文本行（论文标题的稳定信号；失败返回空串）。"""
    try:
        data = doc[0].get_text("dict")
    except Exception:  # noqa: BLE001
        return ""
    best_size, best_text = 0.0, ""
    for block in data.get("blocks", []):
        for line in block.get("lines", []):
            line_text = "".join(span.get("text", "") for span in line.get("spans", []))
            size = max((span.get("size", 0) for span in line.get("spans", [])), default=0)
            clean = line_text.strip()
            if not plausible_title(clean):
                continue
            if size > best_size and 3 <= len(clean) <= 200:
                best_size, best_text = size, clean
    return best_text


def plausible_title(text: str) -> bool:
    """标题候选过滤：排除页码、arXiv 侧边水印、邮箱行等噪声。"""
    if text.isdigit() or "@" in text:
        return False
    lowered = text.lower()
    if lowered.startswith("arxiv:") or "arxiv:" in lowered[:12]:
        return False
    return len(text) >= 3


def extract_abstract(blocks) -> str:
    """首页 Abstract 标记后的首段文本（best-effort，找不到返回空串）。"""
    for index, block in enumerate(blocks):
        if block["page"] != 1:
            continue
        text = block["text"]
        # 常见形态：独立 "Abstract" 行，或 "Abstract—..." / "Abstract: ..." 行内前缀
        if text.strip().lower() == "abstract" and index + 1 < len(blocks):
            return blocks[index + 1]["text"][:3000]
        for prefix in ("abstract—", "abstract:", "abstract "):
            lowered = text.lower()
            if lowered.startswith(prefix) and len(text) > len(prefix) + 40:
                return text[len(prefix) :].strip()[:3000]
    return ""


if __name__ == "__main__":
    sys.exit(main())
