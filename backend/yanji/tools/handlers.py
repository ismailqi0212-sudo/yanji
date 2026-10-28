"""业务工具入口；由Registry调用，不自己启动Agent或改写循环。"""

import asyncio
import re
from ..common import AppError, clone, dumps, finite, unique
from ..context.assembler import ASSETS
from ..research.artifacts import (
    make_card,
    financial_chart,
    scenario_result,
    financial_comparisons,
)
from ..research.plan import remember_gaps, save_plan, update_gap
from ..research.validation import validate_answer
from .documents import calculate, evidence, refs, search
from .document_analysis import build_worksheet, analyze_documents, extract_series
from .registry import ToolRegistry
from .execution import ToolExecutionPipeline
from .finance import normalize_symbol


async def financial_tool(name, args, context):
    workspace = context["workspace"]
    finance = context["finance"]
    key = dumps([name, args])
    if key in workspace.financial_cache:
        raise AppError("本次查询已执行，请使用已返回结果，不重复查询")
    ticker = args["ticker"]
    if name == "getIncomeStatements":
        workspace.event("查询年度财务", ticker)
        data = await finance.financials(
            ticker, args.get("years", 3), args.get("frequency", "annual")
        )
        source = workspace.source(
            data,
            ("最新累计财务 · " if args.get("frequency") == "latest" else "年度财务 · ")
            + data["name"],
        )
        workspace.artifact(
            make_card(
                "financials",
                data["name"]
                + (
                    " · 累计期财务"
                    if args.get("frequency") == "latest"
                    else " · 年度财务"
                ),
                data,
                [source["id"]],
            )
        )
        computed = financial_comparisons(
            [dict(kind="financials", data=data, sourceIds=[source["id"]])]
        )
        workspace.calculations.extend(computed)
        result = {"sourceId": source["id"], **data, "computed": computed}
    elif name == "getStockPrices":
        workspace.event("查询行情与估值", ticker)
        price, quote = await asyncio.gather(
            finance.market(ticker), finance.quote(ticker), return_exceptions=True
        )
        if isinstance(price, Exception) and isinstance(quote, Exception):
            raise AppError("行情源暂不可用，请稍后再试")
        data = {
            **(price if not isinstance(price, Exception) else {}),
            **({"quote": quote} if not isinstance(quote, Exception) else {}),
        }
        data["sourceUrl"] = (
            price["sourceUrl"]
            if not isinstance(price, Exception)
            else quote["sourceUrl"]
        )
        source = workspace.source(data, "行情与估值 · " + ticker)
        display = clone(data)
        if "bars" in display:
            display["bars"] = display["bars"][-120:]
        workspace.artifact(
            make_card("market", data.get("name", ticker), display, [source["id"]])
        )
        result = {"sourceId": source["id"], **data}
        if "bars" in result:
            result["bars"] = result["bars"][-10:]
    else:
        old = next(
            (
                c
                for c in workspace.chat["cards"]
                if c["kind"] == "market"
                and c["data"].get("symbol") == normalize_symbol(ticker)
            ),
            None,
        )
        if old:
            workspace.seen.update(old["sourceIds"])
            return {"sourceId": old["sourceIds"][0], **old["data"].get("quote", {})}
        data = await finance.quote(ticker)
        source = workspace.source(data, "估值指标 · " + ticker)
        workspace.artifact(
            make_card("market", data["name"], dict(quote=data), [source["id"]])
        )
        result = {"sourceId": source["id"], **data}
    workspace.seen.add(source["id"])
    workspace.financial_cache.add(key)
    return result


async def find_company(args, context):
    return await context["finance"].search(args["query"])


async def get_filings(args, context):
    data = await context["finance"].filings(args["ticker"])
    workspace = context["workspace"]
    source = workspace.source(data, "公司披露目录 · " + data["name"])
    workspace.seen.add(source["id"])
    workspace.artifact(
        make_card("filings", data["name"] + " · 最新披露", data, [source["id"]])
    )
    return {"sourceId": source["id"], **data}


async def search_filings(args, context):
    rows = search(context["workspace"].chat, args["query"], limit=4)
    context["seen"].update(r["id"] for r in rows)
    return [
        dict(
            sourceId=r["id"],
            **{k: r[k] for k in ("documentId", "page", "name", "text")},
        )
        for r in rows
    ]


async def read_page(args, context):
    doc = next(
        (
            d
            for d in context["workspace"].chat["documents"]
            if d["id"] == args["documentId"]
        ),
        None,
    )
    if (
        not doc
        or type(args["page"]) is not int
        or not 1 <= args["page"] <= len(doc["pages"])
    ):
        raise AppError("无效的材料或页码")
    rows = [c for c in doc["chunks"] if c["page"] == args["page"]]
    context["seen"].update(r["id"] for r in rows)
    return [dict(sourceId=r["id"], page=r["page"], text=r["text"]) for r in rows]


async def calculate_tool(args, context):
    if not args.get("sourceIds") or any(
        s not in context["seen"] for s in args["sourceIds"]
    ):
        raise AppError("计算需要关联已读来源")
    data = calculate(args)
    data.update(
        id="C"
        + str(
            1
            + sum(
                bool(re.fullmatch(r"C\d+", c.get("id", "")))
                for c in context["calculations"]
            )
        ),
        sourceIds=args["sourceIds"],
    )
    data["display"] = f"{data['result']:.2f}" + {
        "growth": "%",
        "percentage_points": " 个百分点",
    }.get(args["operation"], "")
    context["calculations"].append(data)
    return data


async def create_chart(args, context):
    if args["sourceId"] not in context["seen"]:
        raise AppError("先查询财务数据")
    source = evidence(context["workspace"].chat, args["sourceId"])
    if not source or not source.get("data", {}).get("rows"):
        raise AppError("该来源没有年度财务序列")
    data = financial_chart(
        source["data"],
        source["id"],
        args.get("metric", "revenue"),
        args.get("kind", "line"),
    )
    card = context["workspace"].artifact(
        make_card("chart", data["title"], data, [source["id"]])
    )
    return dict(
        cardId=card["id"],
        sourceId=source["id"],
        note="图表已在对话中显示，用户可下载或切图型。",
    )


async def chart_from_filings(args, context):
    data = await extract_series(args["query"], context)
    ids = unique(r["sourceId"] for r in data["rows"])
    context["seen"].update(ids)
    card = context["workspace"].artifact(make_card("chart", data["title"], data, ids))
    return dict(
        cardId=card["id"],
        sourceIds=ids,
        unit=data["unit"],
        scope=data["scope"],
        rows=data["rows"],
    )


async def create_scenario(args, context):
    workspace = context["workspace"]
    source = evidence(workspace.chat, args["sourceId"])
    if (
        args["sourceId"] not in context["seen"]
        or not source
        or not source.get("data", {}).get("rows")
    ):
        raise AppError("先查询年度财务")
    data = source["data"]
    rows = data["rows"]
    last = rows[-1]
    prev = rows[-2] if len(rows) > 1 else {}
    if data.get("frequency") == "latest":
        raise AppError("累计期不能直接作为年度情景基准，请先查年度数据")
    if not finite(last.get("revenue")) or not finite(last.get("grossMargin")):
        raise AppError("收入或毛利率缺失，不能建立模型")
    inputs = dict(
        baseRevenue=last["revenue"],
        growth=args.get(
            "growth",
            round((last["revenue"] / prev["revenue"] - 1) * 100, 2)
            if finite(prev.get("revenue")) and prev["revenue"] > 0
            else 0,
        ),
        margin=args.get("margin", round(last["grossMargin"], 2)),
        years=args.get("years", 2),
    )
    result = dict(
        name=data["name"],
        basePeriod=last["period"],
        currency=last["currency"],
        input=inputs,
        rows=scenario_result(inputs),
        note="用户指定参数优先，其余参考最新历史数据；均为情景假设，不是公司预测。",
    )
    scenario_source = workspace.source(
        {**result, "growthRate": inputs["growth"], "grossMargin": inputs["margin"]},
        "用户情景假设 · " + data["name"],
    )
    workspace.seen.add(scenario_source["id"])
    card = workspace.artifact(
        make_card(
            "scenario",
            "假设沙盘 · " + data["name"],
            result,
            [source["id"], scenario_source["id"]],
        )
    )
    return dict(cardId=card["id"], sourceIds=card["sourceIds"], note=result["note"])


async def deliver(args, context):
    workspace = context["workspace"]
    chat = workspace.chat
    if not isinstance(args.get("findings"), list) or len(args["findings"]) > context[
        "run"
    ]["route"].get("maxFindings", 5):
        raise AppError("请按本轮要求合并重复分析，将资料缺口放入gaps。")

    def resolve(sid):
        return next(
            (c["sourceIds"] for c in context["calculations"] if c.get("id") == sid),
            [sid],
        )

    checked = []
    for finding in args["findings"]:
        if not finding.get("title") or not finding.get("body"):
            raise AppError("发现需要标题和正文")
        ids = unique(s for sid in finding.get("sourceIds", []) for s in resolve(sid))
        body = re.sub(
            r"evidence:(C\d+)\b",
            lambda m: "evidence:" + resolve(m[1])[0],
            finding["body"],
        )
        if not refs(body):
            body += " " + " ".join(
                f"[依据{i + 1}](evidence:{sid})" for i, sid in enumerate(ids)
            )
        valid = validate_answer(
            chat,
            dict(answer=body, sourceIds=ids),
            context["seen"],
            context["calculations"],
        )
        checked.append((finding, valid))
    if not checked and not args.get("gaps"):
        raise AppError("至少提供一条发现或明确缺口")
    for finding, valid in checked:
        workspace.artifact(
            make_card(
                "brief",
                finding["title"],
                dict(
                    body=valid["answer"],
                    kind=finding["kind"],
                    notes="",
                    gaps=[],
                    nextQuestions=[
                        q
                        for q in finding.get("nextQuestions", [])
                        if isinstance(q, str)
                    ][:2],
                ),
                valid["sourceIds"],
            )
        )
    if args.get("gaps"):
        remember_gaps(chat, context["run"], args["gaps"])
        workspace.artifact(make_card("gaps", "还需要核实", dict(items=args["gaps"])))
    return dict(done=True, summary=str(args.get("summary") or "研究结果已整理。"))


async def plan_tool(args, context):
    return save_plan(args, context)


async def gap_tool(args, context):
    return update_gap(args, context)


async def read_report(args, context):
    report = context["workspace"].chat.get("report")
    if not report:
        raise AppError("尚无研报")
    return {k: clone(report[k]) for k in ("title", "version", "sections", "sourceIds")}


async def propose_revision(args, context):
    from ..reports.service import propose_revision as propose

    return propose(args, context)


HANDLERS = dict(
    findCompany=find_company,
    getCompanyFilings=get_filings,
    searchFilings=search_filings,
    readPage=read_page,
    calculate=calculate_tool,
    createChart=create_chart,
    chartFromFilings=chart_from_filings,
    createScenario=create_scenario,
    deliverResearch=deliver,
    planResearch=plan_tool,
    updateResearchGap=gap_tool,
    readCurrentReport=read_report,
    proposeReportRevision=propose_revision,
    analyzeDocuments=analyze_documents,
    buildOperatingWorksheet=build_worksheet,
)


def create_tools(context, verifier=None):
    """每次运行装配一份Registry；声明来自静态JSON，执行实现是原生Python。"""
    entries = clone(ASSETS["catalog"])
    for entry in entries:
        name = entry["name"]
        if name in ("getStockPrices", "getIncomeStatements", "getFinancialMetrics"):

            async def handler(args, ctx, name=name):
                return await financial_tool(name, args, ctx)
        else:
            handler = HANDLERS[name]
        entry["load"] = lambda handler=handler: handler
        if name == "deliverResearch":
            entry["parameters"]["properties"]["findings"]["maxItems"] = context["run"][
                "route"
            ]["maxFindings"]
    return ToolRegistry(
        entries,
        execution=ToolExecutionPipeline(context, verifier),
        source_mode=context["run"]["sourceMode"],
        mode="revision" if context["run"].get("mode") == "revision" else "research",
    )
