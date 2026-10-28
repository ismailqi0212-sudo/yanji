"""长文分批提取与经营底稿。LLM候选必须通过原文匹配再进入底稿。"""

import asyncio
import hashlib
import re
import unicodedata
from json_repair import repair_json
from ..common import AppError, dumps, finite, now, unique
from ..context.assembler import ASSETS, extraction_messages
from ..research.artifacts import make_card
from ..research.metrics import PERIOD, align_operating_facts, apply_operating_groups
from .documents import compact, search


def batches(chunks, max_chars=60000):
    result = []
    batch = []
    size = 0
    for chunk in chunks:
        if batch and size + len(chunk["text"]) > max_chars:
            result.append(batch)
            batch = []
            size = 0
        batch.append(chunk)
        size += len(chunk["text"])
    if batch:
        result.append(batch)
    return result


def output(response, name):
    call = next(
        (c for c in response.get("tool_calls", []) if c["function"]["name"] == name),
        None,
    )
    if not call:
        raise AppError("模型未返回可校验结果：" + name)
    data = repair_json(call["function"]["arguments"], return_objects=True)
    if not isinstance(data, dict):
        raise AppError("模型返回结构不完整")
    return data


def raw_number(raw):
    raw = re.sub(r"[\s,，%％]", "", unicodedata.normalize("NFKC", str(raw or "")))
    try:
        return float(re.sub(r"^\((.*)\)$", r"-\1", raw)) if raw else None
    except ValueError:
        return None


def validate_operating_facts(data, chunks):
    facts = []
    rejected = []
    by_id = {c["id"]: c for c in chunks}
    for fact in data.get("facts", []):
        source = by_id.get(fact.get("sourceId"))
        quote = compact(fact.get("quote"))
        raw = compact(fact.get("rawValue")).replace("%", "")
        if (
            not source
            or not raw
            or not PERIOD.fullmatch(fact.get("period", ""))
            or not finite(fact.get("value"))
            or raw_number(fact.get("rawValue")) != fact["value"]
            or fact.get("kind") not in ("flow", "stock", "ratio", "average")
            or not all(
                isinstance(fact.get(k), str) and fact[k].strip()
                for k in ("company", "metric", "unit", "scope", "calendar")
            )
            or len(quote) < 8
            or quote not in compact(source["text"])
            or raw not in quote
        ):
            rejected.append("数字、期间或引文不完整")
            continue
        facts.append(
            {**fact, "page": source["page"], "documentId": source["documentId"]}
        )
    return dict(facts=facts, rejected=rejected)


def validate_part(data, chunks):
    findings = []
    metrics = []
    rejected = []
    by_id = {c["id"]: c for c in chunks}
    for finding in data.get("findings", []):
        source = by_id.get(finding.get("sourceId"))
        quote = compact(finding.get("quote"))
        if not source or len(quote) < 8 or quote not in compact(source["text"]):
            rejected.append("引文未匹配原文")
            continue
        findings.append(
            {**finding, "page": source["page"], "documentId": source["documentId"]}
        )
    for metric in data.get("metrics", []):
        source = by_id.get(metric.get("sourceId"))
        raw = compact(metric.get("rawValue")).replace("%", "")
        if (
            not source
            or not raw
            or raw not in compact(source["text"])
            or not finite(metric.get("value"))
            or raw_number(metric.get("rawValue")) != metric["value"]
            or not re.fullmatch(r"20\d{2}(?:年度|年)?", metric.get("period", ""))
            or not str(metric.get("unit", "")).strip()
            or not str(metric.get("scope", "")).strip()
        ):
            rejected.append("指标数字、来源或年度口径未通过核对")
            continue
        metrics.append(
            {
                **metric,
                "period": metric["period"][:4],
                "page": source["page"],
                "documentId": source["documentId"],
            }
        )
    return dict(findings=findings, metrics=metrics, rejected=rejected)


async def build_worksheet(args, context):
    workspace = context["workspace"]
    chat = workspace.chat
    if not chat["documents"]:
        raise AppError("请先上传连续多期财报")
    # 同一任务对同批材料重复提问时复用已生成底稿，不再耗费整批模型调用。
    old = next(
        (
            c
            for c in chat["cards"]
            if c["kind"] == "worksheet"
            and [d["id"] for d in c["data"].get("documents", [])]
            == [d["id"] for d in chat["documents"]]
            and c["data"].get("focus") == args.get("focus")
        ),
        None,
    )
    if old:
        workspace.seen.update(old["sourceIds"])
        return {"cardId": old["id"], "reused": True, **worksheet_summary(old["data"])}
    facts = []
    warnings = []
    semaphore = asyncio.Semaphore(2)

    async def worker(index, doc):
        async with semaphore:
            chunks = [{**chunk, "documentId": doc["id"]} for chunk in doc["chunks"]]
            parts = batches(chunks)
            workspace.progress(
                index, dict(status="reading", parts=len(parts), completedParts=0)
            )
            local = []
            local_warnings = list(doc.get("warnings", []))
            for part, items in enumerate(parts):
                context["token"].check()
                workspace.event(
                    "整理经营数据", f"{doc['name']} · {part + 1}/{len(parts)}批"
                )
                response = await context["model"].complete(
                    extraction_messages(
                        "operatingPart",
                        dict(
                            focus=args.get("focus") or context["run"]["question"],
                            metrics=args.get("metrics", [])[:12],
                            document=doc["name"],
                            sources=[
                                {k: c[k] for k in ("id", "page", "text")} for c in items
                            ],
                        ),
                    ),
                    tools=[ASSETS["schemas"]["extractTool"]],
                    force="extractOperatingFacts",
                    max_tokens=6500,
                    metadata=dict(
                        purpose="operating-extraction",
                        documentId=doc["id"],
                        batch=part + 1,
                    ),
                )
                checked = validate_operating_facts(
                    output(response, "extractOperatingFacts"), items
                )
                local.extend(
                    {**fact, "documentName": doc["name"]} for fact in checked["facts"]
                )
                if checked["rejected"]:
                    local_warnings.append(
                        f"{doc['name']}第{part + 1}批：{len(checked['rejected'])}项候选值未通过引文核对"
                    )
                workspace.progress(index, dict(completedParts=part + 1))
            workspace.progress(
                index,
                dict(
                    status="completed", processedPages=len({c["page"] for c in chunks})
                ),
            )
            return local, local_warnings

    results = await _gather_workers(
        [worker(i, d) for i, d in enumerate(chat["documents"])]
    )
    for extracted, notes in results:
        facts.extend(extracted)
        warnings.extend(notes)
    if not facts:
        raise AppError("未提取到可核对的经营指标。请指定少量指标，或补充含文字的报告。")
    aligned = dict(facts=facts, warnings=[])
    if len(facts) > 1:
        try:
            payload = [
                dict(
                    id=i,
                    **{
                        k: f.get(k)
                        for k in (
                            "company",
                            "metric",
                            "period",
                            "value",
                            "unit",
                            "currency",
                            "scope",
                            "kind",
                            "calendar",
                        )
                    },
                    quote=f.get("quote", "")[:160],
                )
                for i, f in enumerate(facts)
            ]
            response = await context["model"].complete(
                extraction_messages("alignment", payload),
                tools=[ASSETS["schemas"]["alignmentTool"]],
                force="alignOperatingMetrics",
                max_tokens=4000,
                metadata=dict(purpose="metric-alignment"),
            )
            aligned = apply_operating_groups(
                facts, output(response, "alignOperatingMetrics").get("groups", [])
            )
        except Exception as error:
            context["token"].check()
            aligned["warnings"].append(
                "名称归并未完成，保留原始名称分行：" + str(error)
            )
    context["token"].check()
    data = {
        **align_operating_facts(aligned["facts"]),
        "documents": [dict(id=d["id"], name=d["name"]) for d in chat["documents"]],
        "focus": args.get("focus"),
        "cacheKey": hashlib.sha256(
            dumps([d["hash"] for d in chat["documents"]]).encode()
        ).hexdigest(),
        "facts": facts,
        "alignment": [
            {
                k: f.get(k)
                for k in (
                    "sourceId",
                    "period",
                    "metric",
                    "company",
                    "alignmentReason",
                    "originalIdentity",
                )
            }
            for f in aligned["facts"]
        ],
        "warnings": unique([*warnings, *aligned["warnings"]]),
        "notes": "只覆盖本轮提取的指标；同名不同口径不强行合并。派生单季值保留公式，空白不代表零。LLM表头和业务口径仍需原文核对。",
    }
    ids = unique(f["sourceId"] for f in facts)
    workspace.seen.update(ids)
    card = workspace.artifact(make_card("worksheet", "经营数据底稿", data, ids))
    return {"cardId": card["id"], **worksheet_summary(data)}


def worksheet_summary(data):
    return dict(
        metricCount=len(data["rows"]),
        periods=data["periods"],
        conflicts=data["conflicts"],
        warnings=data["warnings"],
        note="表格已显示，可点指标画图与下载。不要重复抄表；空缺及冲突需要补充报告或人工核对。",
        sourceIds=unique(f["sourceId"] for f in data["facts"])[:16],
        metrics=[
            dict(
                metric=r["metric"],
                company=r["company"],
                unit=r["unit"],
                kind=r["kind"],
                periods=list(r["cells"]),
            )
            for r in data["rows"]
        ],
    )


async def analyze_documents(args, context):
    workspace = context["workspace"]
    chat = workspace.chat
    if not chat["documents"]:
        raise AppError("请先上传报告")
    semaphore = asyncio.Semaphore(2)

    async def worker(index, doc):
        async with semaphore:
            cache_key = hashlib.sha256(
                (doc["hash"] + "|" + str(args.get("focus", ""))).encode()
            ).hexdigest()
            cached = chat.get("documentAnalysisCache", {}).get(cache_key)
            if cached:
                workspace.progress(
                    index,
                    dict(
                        status="completed",
                        processedPages=cached["processedPages"],
                        cached=True,
                    ),
                )
                return cached
            chunks = [{**c, "documentId": doc["id"]} for c in doc["chunks"]]
            parts = batches(chunks)
            findings = []
            metrics = []
            rejected = []
            workspace.progress(
                index, dict(status="reading", parts=len(parts), completedParts=0)
            )
            for part, items in enumerate(parts):
                context["token"].check()
                workspace.event(
                    "长文阅读", f"{doc['name']} · {part + 1}/{len(parts)}批"
                )
                response = await context["model"].complete(
                    extraction_messages(
                        "documentPart",
                        dict(
                            document=doc["name"],
                            focus=args.get("focus") or context["run"]["question"],
                            part=part + 1,
                            totalParts=len(parts),
                            sources=[
                                {k: c[k] for k in ("id", "page", "text")} for c in items
                            ],
                        ),
                    ),
                    tools=[ASSETS["schemas"]["partTool"]],
                    force="analyzeDocumentPart",
                    max_tokens=2600,
                    metadata=dict(
                        purpose="document-part", documentId=doc["id"], batch=part + 1
                    ),
                )
                checked = validate_part(output(response, "analyzeDocumentPart"), items)
                findings.extend(checked["findings"])
                metrics.extend(checked["metrics"])
                rejected.extend(checked["rejected"])
                workspace.progress(
                    index,
                    dict(
                        completedParts=part + 1,
                        processedPages=len(
                            {
                                c["page"]
                                for c in chunks
                                if c["page"] <= items[-1]["page"]
                            }
                        ),
                    ),
                )
            data = dict(
                documentId=doc["id"],
                name=doc["name"],
                hash=doc["hash"],
                fromMaterials=True,
                processedPages=len({c["page"] for c in chunks}),
                pages=len(doc["pages"]),
                readChars=sum(len(c["text"]) for c in chunks),
                parts=len(parts),
                findings=findings,
                metrics=metrics,
                warnings=[
                    *doc.get("warnings", []),
                    *(
                        [f"{len(rejected)}项候选引文或指标未通过原文匹配，已排除"]
                        if rejected
                        else []
                    ),
                ],
                at=now(),
            )
            chat.setdefault("documentAnalysisCache", {})[cache_key] = data
            workspace.progress(
                index, dict(status="completed", processedPages=data["processedPages"])
            )
            return data

    results = await _gather_workers(
        [worker(i, d) for i, d in enumerate(chat["documents"])]
    )
    for data in results:
        ids = unique(f["sourceId"] for f in [*data["findings"], *data["metrics"]])
        workspace.seen.update(ids)
        if not any(
            c["kind"] == "documentAnalysis" and c["data"].get("hash") == data["hash"]
            for c in chat["cards"]
        ):
            workspace.artifact(
                make_card(
                    "documentAnalysis",
                    data["name"],
                    {**data, "findings": data["findings"][:16]},
                    ids,
                )
            )
    return dict(
        origin="uploaded_documents",
        documents=[{**d, "findings": d["findings"][:16]} for d in results],
        note="已逐批阅读全部可提取文字；扫描页未阅读。引文和数字通过原文匹配，但期间和表格列对应仍需人工核对。",
    )


async def _gather_workers(coroutines):
    """一个文档失败时取消同批其余任务，避免后台继续烧Token或写进度。"""
    tasks = [asyncio.create_task(c) for c in coroutines]
    try:
        return await asyncio.gather(*tasks)
    except BaseException:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise


def validate_series(data, chunks):
    if (
        not all(data.get(k) for k in ("title", "unit", "scope"))
        or not isinstance(data.get("rows"), list)
        or not 1 <= len(data["rows"]) <= 20
    ):
        raise AppError("未提取到同一口径的时间序列")
    by_id = {c["id"]: c for c in chunks}
    rows = []
    for row in data["rows"]:
        source = by_id.get(row.get("sourceId"))
        if not source:
            raise AppError("图表来源不存在")
        if row.get("value") is not None and (
            not finite(row["value"])
            or not compact(row.get("rawValue"))
            or compact(row["rawValue"]) not in compact(source["text"])
            or raw_number(row["rawValue"]) != row["value"]
        ):
            raise AppError("图表数字未能匹配原文，请缩小到一个指标重试")
        if not str(row.get("period", "")).strip():
            raise AppError("数据期间为空")
        rows.append({k: row[k] for k in ("period", "value", "sourceId")})
    if len({r["period"] for r in rows}) != len(rows):
        raise AppError("相同期间有重复数据，请明确统计口径")
    if not any(r["value"] is not None for r in rows):
        raise AppError("没有可绘制的数据")
    return dict(
        title=data["title"],
        unit=data["unit"],
        scope=data["scope"],
        kind="line",
        fromMaterials=True,
        sourceName="；".join(
            unique(
                c.get("name", "")
                for c in chunks
                if c["id"] in {r["sourceId"] for r in rows}
            )
        ),
        rows=sorted(rows, key=lambda r: r["period"]),
    )


async def extract_series(query, context):
    chat = context["workspace"].chat
    if not chat["documents"]:
        raise AppError("请先上传财报")
    metric = next(
        (
            name
            for pattern, name in [
                ("毛利率", "grossMargin"),
                ("经营.*现金|經營.*現金", "operatingCashFlow"),
                ("归母|歸母|净利润|淨利潤", "attributableProfit"),
                ("毛利", "grossProfit"),
                ("收入|营收|營收", "revenue"),
            ]
            if re.search(pattern, query)
        ),
        None,
    )
    active = {d["hash"] for d in chat["documents"]}
    entries = [
        m
        for analysis in chat.get("documentAnalysisCache", {}).values()
        if analysis["hash"] in active
        for m in analysis["metrics"]
        if m["metric"] == metric
    ]
    groups = {}
    for entry in entries:
        groups.setdefault(
            (compact(entry["unit"]), compact(entry["currency"])), []
        ).append(entry)
    if groups:
        group = max(groups.values(), key=lambda g: len({m["period"] for m in g}))
        periods = {}
        for item in group:
            if (
                item["period"] in periods
                and periods[item["period"]]["value"] != item["value"]
            ):
                raise AppError("同一年度提取到不同数值，请核对口径，暂不自动连线")
            periods[item["period"]] = item
        if len(periods) >= 2:
            return dict(
                title=query + " · 上传报告",
                unit=group[0]["unit"],
                scope="原报告年度合并口径，未换算单位",
                kind="line",
                fromMaterials=True,
                sourceName="上传报告",
                rows=[
                    {k: m[k] for k in ("period", "value", "sourceId")}
                    for _, m in sorted(periods.items())
                ],
            )
    chunks = [c for d in chat["documents"] for c in search(chat, query, [d["id"]], 3)][
        :18
    ]
    if not chunks:
        raise AppError("材料中未找到相关指标，请换一个名称")
    response = await context["model"].complete(
        extraction_messages(
            "chart",
            dict(
                query=query,
                chunks=[{k: c[k] for k in ("id", "name", "text")} for c in chunks],
            ),
        ),
        tools=[ASSETS["schemas"]["seriesTool"]],
        force="extractSeries",
        max_tokens=2500,
        metadata=dict(purpose="chart-extraction"),
    )
    return validate_series(output(response, "extractSeries"), chunks)
