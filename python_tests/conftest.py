import asyncio
import json
import pytest_asyncio
import httpx
from yanji.app import create_app


def call(name, args, usage=10):
    return dict(
        usage=usage,
        tool_calls=[
            dict(
                id="call-" + name,
                type="function",
                function=dict(
                    name=name, arguments=json.dumps(args, ensure_ascii=False)
                ),
            )
        ],
    )


class FakeModel:
    """模拟协议而非模型智能；用确定输出检查工具、版本、取消和引用的执行边界。"""

    def __init__(self):
        self.inputs = []
        self.bad_report = False
        self.bad_delivery = False
        self.wait = None

    async def __call__(self, messages, *, tools=None, force=None, **options):
        self.inputs.append((messages, tools, force))
        if self.wait is not None:
            await self.wait.wait()
        names = {t["function"]["name"] for t in tools or []}
        observations = {
            m["name"]: json.loads(m["content"]) for m in messages if m["role"] == "tool"
        }
        if force in ("extractOperatingFacts", "analyzeDocumentPart"):
            payload = json.loads(messages[-1]["content"])
            source = payload["sources"][0]
            if force == "extractOperatingFacts":
                return call(
                    force,
                    dict(
                        facts=[
                            dict(
                                company="Example",
                                metric="营业收入",
                                period=period,
                                kind="flow",
                                value=value,
                                rawValue=str(value),
                                unit="元",
                                currency="CNY",
                                scope="合并",
                                calendar="12月",
                                sourceId=source["id"],
                                quote=source["text"],
                            )
                            for period, value in [("2023", 100), ("2024", 120)]
                        ]
                    ),
                )
            return call(
                force,
                dict(
                    findings=[
                        dict(
                            topic="经营变化",
                            text="收入增长，原因需要补充证据。",
                            quote=source["text"],
                            sourceId=source["id"],
                        )
                    ],
                    metrics=[
                        dict(
                            metric="revenue",
                            period=period,
                            value=value,
                            rawValue=str(value),
                            unit="元",
                            currency="CNY",
                            scope="合并",
                            sourceId=source["id"],
                        )
                        for period, value in [("2023", 100), ("2024", 120)]
                    ],
                ),
            )
        if force == "alignOperatingMetrics":
            return call(force, dict(groups=[]), 5)
        if force == "writeReport":
            payload = next(
                json.loads(m["content"])
                for m in messages
                if m["role"] == "user" and m["content"].startswith("{")
            )
            source = (payload.get("selected") or payload.get("confirmed"))[0][
                "sourceIds"
            ][0]
            return call(
                force,
                dict(
                    title="研究初稿",
                    sections=[
                        dict(
                            title="收入增长与风险边界",
                            content=f"收入[120元](evidence:{'invented' if self.bad_report else source})，原因仍需核实。",
                        )
                    ],
                ),
            )
        if "proposeReportRevision" in names:
            if "readCurrentReport" not in observations:
                return call("readCurrentReport", {})
            if "searchFilings" not in observations:
                return call("searchFilings", dict(query="收入"))
            report = observations["readCurrentReport"]
            sources = observations["searchFilings"]
            sid = sources[0]["sourceId"]
            return call(
                "proposeReportRevision",
                dict(
                    sectionId=report["sections"][0]["id"],
                    title=report["sections"][0]["title"],
                    content=f"收入[120元](evidence:{sid})，驱动因素仍需核实。",
                    reason="补充原文",
                    sourceIds=[sid],
                    remainingGaps=["核对业务驱动"],
                ),
            )
        preflight = None
        for m in messages:
            if m["role"] == "user" and "系统已执行上传材料前置阅读" in m["content"]:
                preflight = json.loads(m["content"][m["content"].index("{") :])
        if preflight:
            sid = (
                preflight.get("sourceIds")
                or [
                    m["sourceId"]
                    for d in preflight.get("documents", [])
                    for m in d["metrics"]
                ]
            )[0]
            if "calculate" not in observations:
                return call(
                    "calculate",
                    dict(operation="growth", values=[120, 100], sourceIds=[sid]),
                )
            return call(
                "deliverResearch",
                dict(
                    summary="已整理收入变化。",
                    findings=[
                        dict(
                            title="收入增长，原因待验证",
                            body=f"收入增长[20%](evidence:{sid})，尚不能确定业务驱动。",
                            kind="inference",
                            sourceIds=[sid],
                        )
                    ],
                    gaps=["业务驱动需要进一步原文"],
                ),
            )
        if force == "deliverResearch":
            return call(
                "deliverResearch",
                dict(
                    summary="已核对并保留缺口。", findings=[], gaps=["原因仍需原文核实"]
                ),
            )
        if not observations:
            return call("getIncomeStatements", dict(ticker="hk09899", years=3))
        source = observations.get("getIncomeStatements", {}).get("sourceId")
        if "calculate" not in observations:
            return call(
                "calculate",
                dict(operation="growth", values=[120, 100], sourceIds=[source]),
            )
        if "createChart" not in observations:
            return call(
                "createChart", dict(sourceId=source, metric="revenue", kind="line")
            )
        if "createScenario" not in observations:
            return call("createScenario", dict(sourceId=source, growth=5, years=1))
        percent = "99.99" if self.bad_delivery and force != "deliverResearch" else "20"
        return call(
            "deliverResearch",
            dict(
                summary="已完成财务比较。",
                findings=[
                    dict(
                        title="收入增长",
                        body=f"收入增长[{percent}%](evidence:C1)，原因仍需原文。",
                        kind="fact",
                        sourceIds=["C1"],
                    )
                ],
                gaps=["原文原因待查"],
            ),
        )


class FakeFinance:
    async def financials(self, ticker, years=3, frequency="annual"):
        return dict(
            symbol="hk09899",
            name="Example",
            frequency=frequency,
            source="模拟公开财务",
            sourceUrl="https://example.test/filing",
            rows=[
                dict(
                    period="2023-12-31",
                    currency="CNY",
                    revenue=100,
                    grossProfit=20,
                    grossMargin=20,
                    attributableProfit=10,
                    operatingCashFlow=12,
                    totalAssets=200,
                    totalLiabilities=100,
                    equity=100,
                ),
                dict(
                    period="2024-12-31",
                    currency="CNY",
                    revenue=120,
                    grossProfit=30,
                    grossMargin=25,
                    attributableProfit=15,
                    operatingCashFlow=14,
                    totalAssets=220,
                    totalLiabilities=90,
                    equity=130,
                ),
            ],
        )

    async def market(self, ticker):
        return dict(
            symbol="hk09899",
            name="Example",
            currency="HKD",
            source="模拟行情",
            sourceUrl="https://example.test/price",
            bars=[
                dict(time="2024-01-01", open=10, close=12, high=12, low=9, volume=100)
            ],
        )

    async def quote(self, ticker):
        return dict(
            symbol="hk09899",
            name="Example",
            currency="HKD",
            sourceUrl="https://example.test/quote",
            metrics={"peTtm": 20},
        )

    async def search(self, query):
        return [dict(symbol="hk09899", name="Example", code="09899", exchange="HK")]

    async def filings(self, ticker):
        return dict(
            name="Example",
            symbol="usAAPL",
            sourceUrl="https://example.test",
            rows=[],
            note="仅目录",
        )


@pytest_asyncio.fixture
async def env(tmp_path, monkeypatch):
    monkeypatch.setenv("CHAT_NO_INHERIT", "1")
    model = FakeModel()
    finance = FakeFinance()
    app = create_app(tmp_path, transport=model, finance=finance, recover=False)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://127.0.0.1",
        headers={"x-yanji-client": "1"},
    ) as client:
        yield app, client, model
    await app.state.research.shutdown()
    app.state.store.db.close()


async def wait_run(app, cid, rid):
    for _ in range(400):
        run = app.state.sessions.load(cid, rid)
        if run["status"] != "running":
            return run
        await asyncio.sleep(0.005)
    raise AssertionError("后台任务没有结束")


def small_pdf(text="2024 Revenue 120 CNY; 2023 Revenue 100 CNY."):
    stream = f"BT /F1 12 Tf 40 750 Td ({text}) Tj ET"
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream",
    ]
    pdf = "%PDF-1.4\n"
    offsets = []
    for i, obj in enumerate(objects):
        offsets.append(len(pdf.encode()))
        pdf += f"{i + 1} 0 obj\n{obj}\nendobj\n"
    xref = len(pdf.encode())
    pdf += (
        "xref\n0 6\n0000000000 65535 f \n"
        + "".join(f"{x:010d} 00000 n \n" for x in offsets)
        + f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF"
    )
    return pdf.encode()
