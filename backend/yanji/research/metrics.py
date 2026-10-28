"""经营指标对齐和单季推导：只做有证据、同口径的运算。"""

import re
from ..common import AppError, clone, finite, unique
from ..tools.documents import compact

PERIOD = re.compile(r"^20\d{2}(?:-(?:Q[1-4]|H1|9M))?$")
NON_FLOW = re.compile(
    r"月活|日活|用户|订阅者|人数|余额|平均|arpu|mau|dau|subscriber|margin|ratio|rate|average|单价|百分比|增长率|毛利率",
    re.I,
)


def safe_measure_kind(metric, kind, unit):
    if kind == "flow" and (
        NON_FLOW.search(metric)
        or re.search(r"[%％]|人/|/月|per user|/user", unit, re.I)
    ):
        return "average"
    return kind


def align_operating_facts(facts):
    groups = {}
    for fact in facts:
        if (
            not PERIOD.fullmatch(fact.get("period", ""))
            or not finite(fact.get("value"))
            or not fact.get("sourceId")
        ):
            continue
        kind = safe_measure_kind(fact["metric"], fact["kind"], fact["unit"])
        key = tuple(
            compact(fact.get(k, ""))
            for k in ("company", "metric", "scope", "unit", "currency")
        ) + (kind, compact(fact.get("calendar", "")))
        if key not in groups:
            groups[key] = dict(
                id=f"metric-{len(groups)}",
                **{
                    k: fact.get(k)
                    for k in (
                        "metric",
                        "company",
                        "unit",
                        "currency",
                        "scope",
                        "calendar",
                    )
                },
                kind=kind,
                cells={},
            )
        row = groups[key]
        candidate = {
            k: fact.get(k)
            for k in ("value", "rawValue", "sourceId", "quote", "page", "documentId")
        }
        old = row["cells"].get(fact["period"])
        if old is None:
            row["cells"][fact["period"]] = dict(
                value=fact["value"],
                status="reported",
                sourceIds=[fact["sourceId"]],
                candidates=[candidate],
            )
        else:
            old["candidates"].append(candidate)
            old["sourceIds"] = unique([*old["sourceIds"], fact["sourceId"]])
            if old["status"] == "conflict" or old["value"] != fact["value"]:
                old.update(status="conflict", value=None)
    rows = list(groups.values())
    for row in rows:
        if (
            row["kind"] != "flow"
            or not row.get("calendar")
            or re.search("未知|unknown", row["calendar"], re.I)
        ):
            continue

        def derive(target, operands):
            if target in row["cells"]:
                return
            cells = [row["cells"].get(p) for p in operands]
            if any(
                not c or c["status"] == "conflict" or not finite(c["value"])
                for c in cells
            ):
                return
            value = float(
                format(cells[0]["value"] - sum(c["value"] for c in cells[1:]), ".12g")
            )
            row["cells"][target] = dict(
                value=value,
                status="derived",
                sourceIds=unique([s for c in cells for s in c["sourceIds"]]),
                formula=" − ".join(operands),
                operands=[
                    dict(period=p, value=c["value"], sourceIds=c["sourceIds"])
                    for p, c in zip(operands, cells)
                ],
                candidates=[],
            )

        for year in unique(p[:4] for p in row["cells"]):
            derive(year + "-Q2", [year + "-H1", year + "-Q1"])
            derive(year + "-Q3", [year + "-9M", year + "-H1"])
            derive(year + "-Q4", [year, year + "-9M"])
            derive(year + "-Q4", [year, year + "-Q1", year + "-Q2", year + "-Q3"])

    def rank(period):
        return int(period[:4]) * 10 + dict(
            Q1=1, H1=2, Q2=3, **{"9M": 4, "Q3": 5, "Q4": 6}
        ).get(period[5:], 7)

    return dict(
        rows=rows,
        periods=sorted(set(p for r in rows for p in r["cells"]), key=rank),
        conflicts=sum(
            c["status"] == "conflict" for r in rows for c in r["cells"].values()
        ),
        fromMaterials=True,
    )


def apply_operating_groups(facts, groups):
    output = clone(facts)
    assigned = set()
    warnings = []

    def currency(value):
        return {
            "人民币": "cny",
            "rmb": "cny",
            "美元": "usd",
            "港元": "hkd",
            "欧元": "eur",
        }.get(compact(value), compact(value))

    def calendar(value):
        match = re.search(r"(\d{1,2})月", compact(value))
        return match[1] + "月" if match else compact(value)

    def compatible(a, b):
        unit = lambda f: re.sub(
            r"^(人民币|rmb|cny|美元|usd|港元|hkd|欧元|eur)", "", compact(f["unit"])
        )
        return (
            currency(a["currency"]) == currency(b["currency"])
            and unit(a) == unit(b)
            and calendar(a["calendar"]) == calendar(b["calendar"])
            and safe_measure_kind(a["metric"], a["kind"], a["unit"])
            == safe_measure_kind(b["metric"], b["kind"], b["unit"])
        )

    signature = lambda f: tuple(compact(f[k]) for k in ("company", "metric", "scope"))
    for group in groups or []:
        ids = group.get("factIds")
        if (
            not isinstance(ids, list)
            or not ids
            or any(
                type(i) is not int or i < 0 or i >= len(facts) or i in assigned
                for i in ids
            )
            or len(set(ids)) != len(ids)
        ):
            warnings.append("名称归并候选包含无效或重复编号，已忽略")
            continue
        buckets = []
        for i in ids:
            bucket = next(
                (b for b in buckets if compatible(facts[b[0]], facts[i])), None
            )
            if bucket is None:
                buckets.append([i])
            else:
                bucket.append(i)
        if len(buckets) > 1:
            warnings.append("归并建议含不同单位或期间口径，已分别核对，未换算混合")
        for bucket in buckets:
            first = facts[bucket[0]]
            parts = [facts[i] for i in bucket]
            connected = {signature(first)}
            while True:
                before = len(connected)
                for a in parts:
                    for b in parts:
                        if (
                            signature(a) in connected
                            and a["period"] == b["period"]
                            and a["value"] == b["value"]
                        ):
                            connected.add(signature(b))
                if len(connected) == before:
                    break
            if connected != {signature(f) for f in parts}:
                warnings.append(
                    first["metric"] + "：归并名称缺少同期间同数值交叉依据，保留分行"
                )
                continue
            for i in bucket:
                identity = {
                    k: facts[i].get(k)
                    for k in (
                        "company",
                        "metric",
                        "scope",
                        "unit",
                        "currency",
                        "calendar",
                    )
                }
                output[i].update({k: first.get(k) for k in identity})
                output[i].update(
                    originalIdentity=identity,
                    alignmentReason=str(group.get("reason") or "同期间披露值一致"),
                )
                assigned.add(i)
    return dict(facts=output, warnings=warnings)


def operating_chart(data, row_id, view="annual"):
    if view not in ("annual", "quarter"):
        raise AppError("图表只能按年度或单季展示，不能混合累计口径")
    row = next((r for r in data["rows"] if r["id"] == row_id), None)
    if not row:
        raise AppError("经营指标不存在")
    periods = [
        p
        for p in data["periods"]
        if re.fullmatch(r"\d{4}" if view == "annual" else r"\d{4}-Q[1-4]", p)
    ]
    if not any(finite(row["cells"].get(p, {}).get("value")) for p in periods):
        raise AppError("该口径没有可绘制数据，请补充报告或切换期间")
    return dict(
        title=row["company"] + " · " + row["metric"],
        unit=row["unit"],
        scope=row["scope"] + " · " + ("年度" if view == "annual" else "单季"),
        fromMaterials=True,
        kind="line",
        rows=[
            dict(
                period=p,
                value=row["cells"].get(p, {}).get("value"),
                sourceId=(row["cells"].get(p, {}).get("sourceIds") or [None])[0],
                sourceIds=row["cells"].get(p, {}).get("sourceIds", []),
                formula=row["cells"].get(p, {}).get("formula"),
            )
            for p in periods
        ],
        sourceName="上传报告；单季派生公式保留在经营底稿",
    )
