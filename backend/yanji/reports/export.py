"""将已保存报告导出Markdown；不重新调用模型、不改变报告版本。"""

import re
from ..common import AppError, finite
from ..tools.documents import evidence
from ..research.artifacts import LABELS


def value(number):
    return f"{number:,.4f}".rstrip("0").rstrip(".") if finite(number) else "—"


def escape(text):
    return str(text or "").replace("|", "/").replace("\n", " ")


def export_markdown(chat):
    report = chat.get("report")
    if not report:
        raise AppError("请先编成研报")
    body = "\n\n".join(f"## {s['title']}\n\n{s['content']}" for s in report["sections"])
    appendices = []
    for card in report.get("artifacts", []):
        data = card["data"]
        text = "### " + card["title"] + "\n\n"
        if card["kind"] == "worksheet":
            periods = data["periods"]
            text += (
                "* 为累计流量差分的单季值；空缺和冲突不等于零。\n\n| 公司 / 指标 | 单位 | "
                + " | ".join(map(escape, periods))
                + " |\n|---|---|"
                + "---:|" * len(periods)
                + "\n"
            )
            for row in data["rows"]:
                cells = []
                for period in periods:
                    cell = row["cells"].get(period)
                    cells.append(
                        "—"
                        if not cell
                        else "冲突待核对"
                        if cell["status"] == "conflict"
                        else value(cell["value"])
                        + (" *" if cell["status"] == "derived" else "")
                    )
                text += (
                    "| "
                    + escape(row["company"] + " / " + row["metric"])
                    + " | "
                    + escape(row["unit"])
                    + " | "
                    + " | ".join(cells)
                    + " |\n"
                )
        elif card["kind"] == "financials":
            metrics = [
                key for key in LABELS if any(finite(r.get(key)) for r in data["rows"])
            ]
            text += (
                "单位："
                + str((data["rows"] or [{}])[0].get("currency", "未核实"))
                + "元；"
                + (
                    "累计披露期，非单季"
                    if data.get("frequency") == "latest"
                    else "年度、合并口径"
                )
                + "；比率为%，EPS为元/股。\n\n| 期间 | "
                + " | ".join(LABELS[k] for k in metrics)
                + " |\n|---|"
                + "---:|" * len(metrics)
                + "\n"
            )
            text += "\n".join(
                "| "
                + r["period"]
                + " | "
                + " | ".join(value(r.get(k)) for k in metrics)
                + " |"
                for r in data["rows"]
            )
        elif card["kind"] == "chart":
            text += (
                f"单位：{data['unit']}；{data['scope']}\n\n| 期间 | 数值 |\n|---|---:|\n"
                + "\n".join(
                    f"| {r['period']} | {value(r['value'])} |" for r in data["rows"]
                )
            )
        else:
            inputs = data["input"]
            text += (
                f"用户情景假设：收入增速{inputs['growth']}%，毛利率{inputs['margin']}%，测算{inputs['years']}年。基准收入为{data['basePeriod']}的{value(inputs['baseRevenue'])}{data['currency']}元。下表为假设推演，不是历史事实或公司指引。\n\n| 情景期间 | 收入 | 毛利 |\n|---|---:|---:|\n"
                + "\n".join(
                    f"| {r['period']} | {value(r['revenue'])} | {value(r['grossProfit'])} |"
                    for r in data["rows"]
                )
            )
        appendices.append(text)
    sources = []
    for i, sid in enumerate(report["sourceIds"]):
        source = evidence(chat, sid)
        sources.append(
            f"{i + 1}. "
            + (source.get("name", "来源失效") if source else "来源失效")
            + (
                " · PDF物理页" + str(source["page"])
                if source and source.get("type") == "pdf"
                else ""
            )
            + (" · " + source["date"] if source and source.get("date") else "")
            + (
                " · " + source["sourceUrl"]
                if source and source.get("sourceUrl")
                else ""
            )
        )
    text = (
        f"# {report['title']}\n\n版本 {report['version']} · {report['at']}"
        + (" · 引用底稿已更新，请复核" if report.get("stale") else "")
        + "\n\n"
        + body
        + "\n\n## 图表与数据附录\n\n"
        + "\n\n".join(appendices)
        + "\n\n## 来源\n\n"
        + "\n\n".join(sources)
    )
    return re.sub(
        r"\[([^\]]*)\]\(evidence:([a-zA-Z0-9:-]+)\)",
        lambda m: (
            m[1]
            + "〔"
            + str(
                report["sourceIds"].index(m[2]) + 1
                if m[2] in report["sourceIds"]
                else 0
            )
            + "〕"
        ),
        text,
    )
