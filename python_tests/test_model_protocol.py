import json
import pytest
import httpx
from yanji.llm.model import ModelClient
from yanji.tools.finance import (
    parse_a,
    parse_sec,
    parse_quote,
    parse_tencent,
    parse_us_symbol,
    source_number,
)
from yanji.common import AppError


async def test_sse_transport_reassembles_tool_fragments_and_usage():
    fragments = [
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call1",
                                "function": {
                                    "name": "calculate",
                                    "arguments": '{"opera',
                                },
                            }
                        ]
                    }
                }
            ]
        },
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "function": {
                                    "arguments": 'tion":"sum","values":[1,2]}'
                                },
                            }
                        ]
                    }
                }
            ]
        },
        {"choices": [], "usage": {"total_tokens": 12}},
    ]
    content = (
        "".join("data: " + json.dumps(f) + "\n\n" for f in fragments)
        + "data: [DONE]\n\n"
    )

    def handle(request):
        payload = json.loads(request.content)
        assert payload["tool_choice"]["function"]["name"] == "calculate"
        assert request.headers["Authorization"] == "Bearer fake-key"
        return httpx.Response(
            200, content=content, headers={"content-type": "text/event-stream"}
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        model = ModelClient(
            lambda: dict(baseUrl="https://example.test", model="test", key="fake-key"),
            client,
        )
        response = await model(
            [dict(role="user", content="计算")],
            tools=[{"type": "function", "function": {"name": "calculate"}}],
            force="calculate",
        )
    assert json.loads(response["tool_calls"][0]["function"]["arguments"])["values"] == [
        1,
        2,
    ]
    assert response["usage"] == 12 and response["usageKnown"] is True


async def test_json_transport_missing_usage_is_marked_unknown():
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda r: httpx.Response(
                200, json={"choices": [{"message": {"content": "ok"}}]}
            )
        )
    ) as client:
        model = ModelClient(
            lambda: dict(baseUrl="https://example.test", model="test", key="fake-key"),
            client,
        )
        response = await model([])
        assert response["usageKnown"] is False and response["content"] == "ok"


@pytest.mark.parametrize(
    "raw,value",
    [
        ("-", None),
        ("", None),
        (True, None),
        (" 1.2 ", 1.2),
        ("-2", -2),
        ("1,200", None),
    ],
)
def test_source_numbers_preserve_missing(raw, value):
    assert source_number(raw) == value


def test_sec_annual_filter_latest_restatement_and_lineage():
    def point(
        value, start="2023-01-01", end="2023-12-31", filed="2024-02-01", form="10-K"
    ):
        return dict(
            val=value, start=start, end=end, filed=filed, form=form, accn="accession"
        )

    facts = {
        "Revenues": {
            "units": {
                "USD": [
                    point(100),
                    point(110, filed="2025-02-01"),
                    point(40, start="2023-10-01", form="10-Q"),
                    point(999, filed="2026-01-01", form="8-K"),
                ]
            }
        },
        "NetIncomeLoss": {"units": {"USD": [point(10)]}},
        "Assets": {
            "units": {
                "USD": [
                    dict(val=200, end="2023-12-31", filed="2024-02-01", form="10-K")
                ]
            }
        },
    }
    data = parse_sec(
        {"facts": {"us-gaap": facts}, "entityName": "Example", "cik": 123}, "usEX"
    )
    row = data["rows"][0]
    assert row["revenue"] == 110 and row["totalAssets"] == 200
    assert row["grossProfit"] is None
    assert row["lineage"]["revenue"]["filed"] == "2025-02-01"
    assert row["netMargin"] == pytest.approx(10 / 110 * 100)


def test_a_share_parser_rejects_other_security_and_preserves_cumulative_scope():
    raw = {
        "success": True,
        "result": {
            "data": [
                dict(
                    SECUCODE="002027.SZ",
                    SECURITY_NAME_ABBR="Example",
                    REPORT_DATE="2024-09-30",
                    REPORT_TYPE="三季报",
                    TOTALOPERATEREVE=120,
                )
            ]
        },
    }
    data = parse_a(raw, "sz002027", "latest")
    assert data["frequency"] == "latest" and data["rows"][0]["reportType"] == "三季报"
    assert data["rows"][0]["grossProfit"] is None
    with pytest.raises(AppError):
        parse_a(raw, "sh600519")


def test_quote_keeps_negative_pe_and_missing_zero_multiple():
    raw = {
        "rc": 0,
        "data": dict(
            f57="09899",
            f58="Example",
            f164=-12,
            f163=0,
            f116=100,
            f47=20,
            f86=1700000000,
        ),
    }
    data = parse_quote(raw, "hk09899")
    assert data["metrics"]["peTtm"] == -12 and data["metrics"]["peStatic"] is None
    assert data["metrics"]["volume"] == 20 and data["currency"] == "HKD"


def test_market_bars_validate_ohlc_and_a_share_volume_unit():
    raw = {
        "code": 0,
        "data": {
            "sz002027": {
                "qfqday": [
                    ["2024-01-01", "10", "12", "13", "9", "20"],
                    ["2024-01-02", "10", "12", "8", "9", "20"],
                    ["bad", "10", "12", "13", "9", "20"],
                ]
            }
        },
    }
    data = parse_tencent(raw, "sz002027")
    assert len(data["bars"]) == 1 and data["bars"][0]["volume"] == 2000


def test_us_symbol_exchange_is_verified_from_provider():
    fields = [""] * 36
    fields[0] = "200"
    fields[1] = "Apple"
    fields[2] = "AAPL.OQ"
    fields[35] = "USD"
    assert (
        parse_us_symbol('v="' + "~".join(fields) + '";', "usAAPL")["exchange"]
        == "NASDAQ"
    )
    fields[35] = "HKD"
    with pytest.raises(AppError):
        parse_us_symbol('v="' + "~".join(fields) + '";', "usAAPL")
