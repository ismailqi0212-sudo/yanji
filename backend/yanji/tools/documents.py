"""财报解析、关键词检索和确定性计算。所有函数都不调用 LLM。

PDF页码使用物理页；原始文件和旧chunk ID保持独立，引用不会因语言迁移改变。
"""

import hashlib
import io
import logging
from contextvars import ContextVar
import re
import unicodedata
from pathlib import Path
from opencc import OpenCC
from pypdf import PdfReader
from docx import Document
from docx.text.paragraph import Paragraph
from docx.table import Table
from ..common import AppError, finite, now, uid, unique

_simplify = OpenCC("hk2s")


_pdf_warnings = ContextVar("pdf_warnings", default=None)


class _PdfLogCollector(logging.Handler):
    """把解析器的重复字体警告转成材料限制；不向日志倾倒PDF内部内容。"""

    def emit(self, record):
        collector = _pdf_warnings.get()
        if collector is not None and record.levelno >= logging.WARNING:
            collector.add(
                "PDF存在字体或编码兼容提示，部分字符可能缺失，请对照原文核验。"
            )


_pdf_logger = logging.getLogger("pypdf")
_pdf_logger.addHandler(_PdfLogCollector())
_pdf_logger.propagate = False


def searchable_text(value):
    text = _simplify.convert(unicodedata.normalize("NFKC", str(value)).lower())
    return re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])", "", text)


def compact(value):
    return re.sub(r"[\s,，]", "", searchable_text(value or ""))


def chunk_text(text, size=1100):
    result = []
    pos = 0
    while pos < len(text):
        end = min(pos + size, len(text))
        if end < len(text):
            newline = text.rfind("\n", pos, end)
            if newline > pos + size * 0.55:
                end = newline
        result.append(dict(text=text[pos:end], offset=pos))
        if end == len(text):
            break
        pos = max(pos + 1, end - 120)
    return result


def parse_document(buffer, name):
    ext = Path(name).suffix.lower()
    warnings = []
    if ext == ".pdf":
        font_warnings = set()
        warning_token = _pdf_warnings.set(font_warnings)
        try:
            reader = PdfReader(io.BytesIO(buffer))
            if len(reader.pages) > 600:
                raise AppError("首版单份 PDF 最多支持 600 页，请拆分相关章节后导入。")
            pages = [
                dict(number=i + 1, text=(page.extract_text() or "").strip())
                for i, page in enumerate(reader.pages)
            ]
        except AppError:
            raise
        except Exception as error:
            raise AppError("PDF 无法解析，请确认文件未损坏或加密") from error
        finally:
            _pdf_warnings.reset(warning_token)
        warnings.extend(sorted(font_warnings))
        if any(len(page["text"]) < 20 for page in pages):
            warnings.append(
                "部分页面没有可提取文字，可能包含扫描件或图片。表格请对照原文核验。"
            )
    elif ext == ".docx":
        # Word表格也是正文，不能只读取paragraphs把经营指标表丢掉。
        paragraphs = []
        document = Document(io.BytesIO(buffer))

        def read_blocks(container):
            for block in container.iter_inner_content():
                if isinstance(block, Paragraph) and block.text.strip():
                    paragraphs.append(block.text)
                elif isinstance(block, Table):
                    for row in block.rows:
                        text = "\t".join(cell.text for cell in row.cells)
                        if text.strip():
                            paragraphs.append(text)

        read_blocks(document)
        pages = [dict(number=i + 1, text=text) for i, text in enumerate(paragraphs)]
        warnings.append("Word 按段落定位；不提供原文件页码。")
    elif ext in (".txt", ".md", ".markdown"):
        try:
            text = buffer.decode("utf-8")
        except UnicodeDecodeError as error:
            raise AppError("文件不是可读取的 UTF-8 文本。") from error
        if "\x00" in text:
            raise AppError("文件不是可读取的 UTF-8 文本。")
        pages = [
            dict(number=i + 1, text=text)
            for i, text in enumerate(re.split(r"\n\s*\n", text))
            if text.strip()
        ]
    else:
        raise AppError("支持 PDF、DOCX、TXT 和 Markdown。")
    if sum(len(page["text"].strip()) for page in pages) < 20:
        raise AppError("没有提取到足够文字。请使用有文字层的文件，或粘贴相关原文。")
    return dict(pages=pages, warnings=warnings, type=ext[1:])


def add_document(chat, buffer, name, data_dir, date=""):
    digest = hashlib.sha256(buffer).hexdigest()
    old = next((d for d in chat["documents"] if d["hash"] == digest), None)
    if old:
        return dict(duplicate=True, document=old)
    parsed = parse_document(buffer, name)
    did = uid()
    filename = did + Path(name).suffix.lower()
    file = Path(data_dir) / "files" / filename
    file.write_bytes(buffer)
    file.chmod(0o600)
    chunks = [
        dict(id=f"{did}:{page['number']}:{i}", page=page["number"], **chunk)
        for page in parsed["pages"]
        for i, chunk in enumerate(chunk_text(page["text"]))
    ]
    document = dict(
        id=did,
        name=name,
        date=date,
        hash=digest,
        file=filename,
        parserVersion=3,
        parser="pypdf",
        at=now(),
        chunks=chunks,
        status="partial" if parsed["warnings"] else "ready",
        **parsed,
    )
    return dict(duplicate=False, document=document)


def evidence(chat, sid):
    for source in chat.get("researchSources", []):
        if source["id"] == sid:
            return source
    for document in chat["documents"]:
        for chunk in document["chunks"]:
            if chunk["id"] == sid:
                return {
                    **chunk,
                    "documentId": document["id"],
                    "name": document["name"],
                    "type": document["type"],
                    "date": document["date"],
                }
    return None


def refs(text):
    return re.findall(r"evidence:([a-zA-Z0-9:-]+)", str(text or ""))


def search(chat, query, doc_ids=(), limit=8):
    terms = []
    for word in re.findall(r"[a-z0-9_.%\-]+|[\u4e00-\u9fff]+", searchable_text(query)):
        terms.extend(
            [word[i : i + 2] for i in range(len(word) - 1)]
            if len(word) > 2 and re.search(r"[\u4e00-\u9fff]", word)
            else [word]
        )
    terms = unique(terms)
    rows = []
    for document in chat["documents"]:
        if doc_ids and document["id"] not in doc_ids:
            continue
        for chunk in document["chunks"]:
            text = searchable_text(chunk["text"])
            score = sum(1 + min(len(t), 5) * 0.1 for t in terms if t in text)
            if score:
                rows.append(
                    {
                        **chunk,
                        "documentId": document["id"],
                        "name": document["name"],
                        "date": document["date"],
                        "type": document["type"],
                        "score": score,
                    }
                )
    return sorted(rows, key=lambda r: -r["score"])[: min(limit, 12)]


def calculate(args):
    operation, values = args.get("operation"), args.get("values")
    if (
        not isinstance(values, list)
        or not 1 <= len(values) <= 30
        or not all(finite(x) for x in values)
    ):
        raise AppError("计算输入必须是有限数字数组，最多 30 项。")
    warning = ""
    if operation == "sum":
        result = sum(values)
    elif operation in ("subtract", "percentage_points"):
        if len(values) != 2:
            raise AppError("差值需要两个数字")
        result = values[0] - values[1]
        if operation == "percentage_points":
            warning = "输入应为百分数本身，例如 30.2 和 28.1，结果单位为百分点。"
    elif operation == "ratio":
        if len(values) != 2 or values[1] == 0:
            raise AppError("比率需要两个数字，分母不能为零")
        result = values[0] / values[1]
    elif operation == "growth":
        if len(values) != 2 or values[1] <= 0:
            raise AppError("上期为零或负数，不使用常规同比增长率；请说明特殊基数。")
        result = (values[0] / values[1] - 1) * 100
    else:
        raise AppError("不支持该计算")
    if not finite(result):
        raise AppError("计算结果超出范围")
    return dict(operation=operation, values=values, result=result, warning=warning)
