"""用已读证据核对引用与百分比；不宣称证明所有金额和因果判断。"""

import json
import re
import unicodedata
from ..common import AppError, finite, unique
from ..tools.documents import evidence, refs, searchable_text


def pdf_table_percentages(text):
    if not re.search("[%％]", text) or "百分比" not in text:
        return []
    values = []
    normalized = unicodedata.normalize("NFKC", text)
    for line in normalized.splitlines():
        for match in re.finditer(
            r"\(?-?\d[\d,]*\)?\s+(\(?)([+-]?\d+\.\d+)\)?(?=\s|$)", line
        ):
            value = float(match[2]) * (-1 if match[1] else 1)
            values.append(value)
            if value < 0 and re.search("成本|費用|费用", line):
                values.append(-value)
    compact = re.sub(r"\s", "", normalized)
    for match in re.finditer(r"\((\d{1,3}\.\d+)\)", compact):
        value = float(match[1])
        values.append(-value)
        labels = re.findall(
            r"([\u4e00-\u9fff]+)[^\u4e00-\u9fff]*$", compact[: match.start()]
        )
        if labels and re.search("成本|費用|费用", labels[0]):
            values.append(value)
    return values


def validate_answer(chat, args, seen, calculations=()):
    answer = args.get("answer")
    if not isinstance(answer, str) or not answer.strip() or len(answer) > 12000:
        raise AppError("请交付简洁的研究回答")
    answer = re.sub(
        r"\[(S[a-f0-9]{32})\](?!\()", lambda m: f"[来源](evidence:{m[1]})", answer
    )
    ids = unique([*args.get("sourceIds", []), *refs(answer)])
    if not ids or any(s not in seen or not evidence(chat, s) for s in ids):
        raise AppError("回答必须引用已读取的真实来源")
    if not refs(answer):
        raise AppError("请在正文中使用[来源](evidence:完整ID)")
    scoped = [
        c
        for c in calculations
        if c.get("sourceIds") and all(s in ids for s in c["sourceIds"])
    ]
    percentages = []
    for c in scoped:
        if c["operation"] in ("growth", "percentage_points", "ratio"):
            percentages.extend(
                [c["result"], c["result"] * 100]
                if c["operation"] == "ratio"
                else [c["result"]]
            )

    def scan(value, key=""):
        if isinstance(value, dict) and isinstance(value.get("rows"), list):
            for a in value["rows"]:
                for b in value["rows"]:
                    for k in ("grossMargin", "netMargin", "roe", "debtRatio"):
                        if finite(a.get(k)) and finite(b.get(k)):
                            percentages.append(a[k] - b[k])
                    if (
                        finite(a.get("revenue"))
                        and finite(b.get("revenue"))
                        and b["revenue"] > 0
                    ):
                        percentages.append((a["revenue"] / b["revenue"] - 1) * 100)
        if finite(value) and re.search(
            "margin|rate|roe|amplitude|percent|debtRatio", key, re.I
        ):
            percentages.append(value)
        elif isinstance(value, dict):
            for k, v in value.items():
                scan(v, k)
        elif isinstance(value, list):
            for v in value:
                scan(v, key)

    for sid in ids:
        source = evidence(chat, sid)
        if source["type"] == "web":
            try:
                scan(source.get("data") or json.loads(source["text"]))
            except (KeyError, ValueError, TypeError):
                pass
        else:
            percentages.extend(pdf_table_percentages(source["text"]))
            text = re.sub(
                r"(\d)\s*\.\s*(\d)", r"\1.\2", searchable_text(source["text"])
            )
            percentages.extend(
                float(m[1])
                for m in re.finditer(
                    r"([+-]?\d+(?:\.\d+)?)\s*(?:[%％]|个?百分点)", text
                )
            )
    for analysis in chat.get("documentAnalysisCache", {}).values():
        for metric in analysis.get("metrics", []):
            if (
                metric.get("sourceId") in ids
                and metric.get("metric") in ("grossMargin", "netMargin")
                and finite(metric.get("value"))
                and re.search("[%％]|百分", metric.get("unit", ""))
            ):
                percentages.append(metric["value"])
    for card in chat["cards"]:
        if card["kind"] == "worksheet":
            percentages.extend(
                f["value"]
                for f in card["data"].get("facts", [])
                if f.get("sourceId") in ids
                and f.get("kind") == "ratio"
                and re.search("[%％]", f.get("unit", ""))
            )
    for c in scoped:
        if c["operation"] == "subtract" and all(
            any(abs(n - v) < 1e-8 for n in percentages) for v in c["values"]
        ):
            percentages.append(c["result"])
    for match in re.finditer(r"([+−-]?\d+(?:\.\d+)?)\s*(?:[%％]|个?百分点)", answer):
        value = float(match[1].replace("−", "-"))
        digits = len(match[1].split(".")[1]) if "." in match[1] else 0
        tolerance = max(0.50001 * 10**-digits, abs(value) * 1e-12)
        decline = re.search(
            "下降|减少|回落|下滑|收窄|降低|减幅|跌",
            answer[max(0, match.start() - 12) : match.start()],
        )
        if not any(
            abs(n - value) <= tolerance
            or decline
            and value >= 0
            and abs(n + value) <= tolerance
            for n in percentages
        ):
            raise AppError(
                f"正文百分比{match[1]}未匹配工具结果或来源。请逐项按calculate原始结果重写，不要心算；已返回的工具结果可直接使用。"
            )
    return dict(answer=answer, sourceIds=ids)


def review_draft(chat, draft, source_ids, calculations):
    sections = draft.get("sections")
    if not sections:
        raise AppError("报告缺少有效章节")
    titles = set()
    citations = 0
    numeric = 0
    for section in sections:
        if (
            not isinstance(section.get("title"), str)
            or not isinstance(section.get("content"), str)
            or not section["content"].strip()
        ):
            raise AppError("章节缺少正文")
        if section["title"] in titles:
            raise AppError("章节标题重复，请合并重复内容")
        titles.add(section["title"])
        section["content"] = re.sub(
            r"（[^）\n]*稍后由程序插入。?）", "", section["content"]
        )
        used = refs(section["content"])
        citations += len(used)
        if any(s not in source_ids for s in used):
            raise AppError("稿件包含未确认来源，已拒绝写入")
        text = section["title"] + "\n" + section["content"]
        if re.search(r"[\d][\d,.]*\s*(?:[%％]|个?百分点)", text):
            numeric += 1
            if not used:
                raise AppError("含百分比的章节必须附上对应底稿来源")
        if used:
            validate_answer(
                chat,
                dict(answer=text, sourceIds=source_ids),
                set(source_ids),
                calculations,
            )
    from ..common import now

    return dict(
        kind="deterministic",
        checkedAt=now(),
        sourceCount=len(source_ids),
        citations=citations,
        numericSections=numeric,
        checks=["引用属于本次确认材料", "百分比与计算口径", "章节完整与去重"],
        limits="不代表因果解释、全部金额或投资判断已被证明；仍需对照原文审阅。",
    )
