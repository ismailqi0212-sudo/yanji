"""研究产物的数据结构和确定性运算；不请求模型、不写数据库。"""

from ..common import AppError, finite, now, uid, unique

LABELS = dict(
    revenue="营业收入",
    grossMargin="毛利率",
    attributableProfit="归属股东利润",
    grossProfit="毛利",
    operatingCashFlow="经营现金流",
    totalAssets="总资产",
    totalLiabilities="总负债",
    equity="股东权益",
    netMargin="净利率",
    debtRatio="资产负债率",
    eps="每股收益",
)


def make_card(kind, title, data, source_ids=()):
    return dict(
        id=uid(),
        kind=kind,
        title=title,
        data=data,
        sourceIds=unique(source_ids),
        selected=False,
        version=1,
        at=now(),
    )


def scenario_result(data):
    base, growth, margin, years = (
        data.get(k) for k in ("baseRevenue", "growth", "margin", "years")
    )
    if (
        not all(finite(v) for v in (base, growth, margin, years))
        or base < 0
        or not -100 < growth <= 500
        or not 0 <= margin <= 100
        or int(years) != years
        or not 1 <= years <= 3
    ):
        raise AppError("请核对假设：增速需大于-100%，毛利率0–100%，年数1–3")
    return [
        dict(
            period=f"情景第{i + 1}年",
            revenue=base * (1 + growth / 100) ** (i + 1),
            grossProfit=base * (1 + growth / 100) ** (i + 1) * margin / 100,
        )
        for i in range(int(years))
    ]


def financial_chart(data, source_id, metric="revenue", kind="line"):
    if metric not in LABELS:
        raise AppError("不支持该指标")
    currencies = unique(r.get("currency") for r in data["rows"])
    ratio = metric in ("grossMargin", "netMargin", "debtRatio")
    if not ratio and len(currencies) != 1:
        raise AppError("报告币种不同，不能直接合并")
    return dict(
        title=data["name"]
        + " · "
        + (
            data.get("profitLabel", LABELS[metric])
            if metric == "attributableProfit"
            else LABELS[metric]
        ),
        unit="%" if ratio else str(currencies[0]) + "元",
        scope="披露累计期间，非单季"
        if data.get("frequency") == "latest"
        else "年度，合并口径",
        kind="bar" if kind == "bar" else "line",
        metric=metric,
        rows=[
            dict(period=r["period"], value=r.get(metric), sourceId=source_id)
            for r in data["rows"]
        ],
        sourceName=data.get("source"),
    )


def mark_stale(chat, card_id):
    if chat.get("report") and card_id in chat["report"].get("cardVersions", {}):
        chat["report"]["stale"] = True


def financial_comparisons(cards):
    results = []
    for card in cards:
        if card["kind"] != "financials" or card["data"].get("frequency") == "latest":
            continue
        rows = card["data"]["rows"]
        for i, a in enumerate(rows):
            profit = a.get("attributableProfit")
            if finite(profit) and profit > 0 and finite(a.get("operatingCashFlow")):
                results.append(
                    dict(
                        operation="ratio",
                        metric="经营现金流/净利润",
                        period=a["period"],
                        values=[a["operatingCashFlow"], profit],
                        result=a["operatingCashFlow"] / profit,
                        sourceIds=card["sourceIds"],
                    )
                )
            if not i:
                continue
            b = rows[i - 1]
            for metric in (
                "revenue",
                "grossProfit",
                "attributableProfit",
                "operatingCashFlow",
                "totalAssets",
                "totalLiabilities",
                "equity",
                "eps",
            ):
                if finite(a.get(metric)) and finite(b.get(metric)) and b[metric] > 0:
                    results.append(
                        dict(
                            operation="growth",
                            metric=metric,
                            period=a["period"],
                            previous=b["period"],
                            values=[a[metric], b[metric]],
                            result=(a[metric] / b[metric] - 1) * 100,
                            sourceIds=card["sourceIds"],
                        )
                    )
            for metric in ("grossMargin", "netMargin", "roe", "debtRatio"):
                if finite(a.get(metric)) and finite(b.get(metric)):
                    results.append(
                        dict(
                            operation="percentage_points",
                            metric=metric,
                            period=a["period"],
                            previous=b["period"],
                            values=[a[metric], b[metric]],
                            result=a[metric] - b[metric],
                            sourceIds=card["sourceIds"],
                        )
                    )
    for item in results:
        item["display"] = (
            f"{item['result']:.2f}"
            + {"growth": "%", "ratio": "倍", "percentage_points": "个百分点"}[
                item["operation"]
            ]
        )
    return results
