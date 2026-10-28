"""公开金融数据适配器：A/HK 财务、SEC 年报、腾讯行情、东方财富估值。

Provider 输出保留来源与期间；模型不能自行决定币种或把累计季报改称单季。
"""

import asyncio
import json
import re
import time
from datetime import date, datetime, timezone
from urllib.parse import quote
import httpx
from ..common import AppError, clone, finite, now


def source_number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    if isinstance(value, str) and not re.fullmatch(r"[-+]?\d+(\.\d+)?", value.strip()):
        return None
    value = float(value)
    return value if finite(value) else None


def normalize_symbol(value):
    raw = re.sub(r"\s+", "", str(value).strip())
    lower = raw.lower()
    if not re.fullmatch(r"(sh|sz|bj)[.:]?\d{6}|hk[.:]?\d{1,5}", raw, re.I):
        ticker = re.sub(r"^(NASDAQ|NYSE|AMEX):", "", raw, flags=re.I)
        ticker = re.sub(r"^us(?=[A-Z])|^US[:.]", "", ticker)
        ticker = re.sub(r"\.(US|OQ|N|AM)$", "", ticker, flags=re.I).upper()
        if re.fullmatch(r"[A-Z][A-Z0-9]{0,9}(?:[.-][A-Z0-9]{1,4})?", ticker):
            return "us" + ticker
    match = re.fullmatch(r"(?:hk[.:]?(\d{1,5})|(\d{1,5})\.hk|(\d{5}))", lower)
    if match:
        code = next(x for x in match.groups() if x).zfill(5)
        if int(code) == 0 or int(code) >= 10000:
            raise AppError("当前仅支持港币普通股代码，不支持认股权证或其他币种柜台。")
        return "hk" + code
    explicit = ""
    match = re.fullmatch(r"(\d{6})\.(sh|sz|bj)", lower)
    if match:
        lower, explicit = match.groups()
    else:
        match = re.fullmatch(r"(sh|sz|bj)[.:]?(\d{6})", lower)
        if match:
            explicit, lower = match.groups()
    if not re.fullmatch(r"\d{6}", lower):
        raise AppError("请输入证券代码，例如 002027、01024.HK 或 AAPL。")
    exchange = (
        "sh"
        if re.match(r"600|601|603|605|688|689", lower)
        else "sz"
        if re.match(r"000|001|002|003|300|301", lower)
        else "bj"
        if re.match(r"4|8|920", lower)
        else None
    )
    if not exchange:
        raise AppError("当前支持 A 股、港股普通股与美股证券。请核对代码。")
    if explicit and explicit != exchange:
        raise AppError("代码与交易所不匹配，请检查后重试。")
    return exchange + lower


def parse_us_symbol(text, symbol):
    match = re.search(r'="([^"\n]*)"', text)
    fields = match[1].split("~") if match else []
    if len(fields) < 36 or fields[0] != "200" or not fields[1]:
        raise AppError("未找到该美股，请通过公司名称搜索后选择。")
    parts = re.fullmatch(r"(.+)\.(OQ|N|AM)", fields[2].upper())
    if not parts or parts[1] != symbol[2:] or fields[35] != "USD":
        raise AppError("无法核实美股交易所或报价币种，请选择其他代码。")
    exchange, market = {
        "OQ": ("NASDAQ", "105"),
        "N": ("NYSE", "106"),
        "AM": ("NYSE American", "107"),
    }[parts[2]]
    return dict(
        symbol=symbol,
        ticker=parts[1],
        providerSymbol="us" + fields[2].upper(),
        name=fields[1],
        exchange=exchange,
        emSecid=market + "." + parts[1],
        currency="USD",
        timeZone="America/New_York",
    )


def parse_tencent(raw, symbol, adjust="qfq", metadata=None):
    metadata = metadata or {}
    if raw.get("code") != 0 or symbol not in raw.get("data", {}):
        raise AppError("数据源未找到该股票，请核对证券代码。")
    data = raw["data"][symbol]
    key = "qfqday" if adjust == "qfq" and data.get("qfqday") else "day"
    bars = {}
    for row in data.get(key, []):
        if not isinstance(row, list) or len(row) < 6:
            continue
        try:
            if date.fromisoformat(row[0]).isoformat() != row[0]:
                continue
            op, close, high, low, volume = map(float, row[1:6])
            if (
                not all(finite(x) for x in (op, close, high, low, volume))
                or min(op, close, low) <= 0
                or high < max(op, close, low)
                or low > min(op, close)
                or volume < 0
            ):
                continue
            volume *= 1 if symbol.startswith(("sh688", "sh689", "hk", "us")) else 100
            bars[row[0]] = dict(
                time=row[0], open=op, close=close, high=high, low=low, volume=volume
            )
        except (TypeError, ValueError):
            continue
    rows = sorted(bars.values(), key=lambda r: r["time"])
    if not rows:
        raise AppError("日线数据不完整，暂无法展示。")
    qt = data.get("qt", {}).get(symbol, [])
    return dict(
        symbol=metadata.get("symbol", symbol),
        name=(qt[1] if len(qt) > 1 else metadata.get("name", symbol)),
        code=metadata.get("ticker", symbol[2:]),
        exchange=metadata.get("exchange", symbol[:2].upper()),
        currency=metadata.get("currency", "HKD" if symbol.startswith("hk") else "CNY"),
        timeZone=metadata.get(
            "timeZone", "Asia/Hong_Kong" if symbol.startswith("hk") else "Asia/Shanghai"
        ),
        source="腾讯证券公开行情",
        sourceUrl=f"https://gu.qq.com/{symbol}/gp",
        adjustment="前复权" if key == "qfqday" else "不复权",
        adjustmentNote="数据源本次仅返回不复权日线。"
        if adjust == "qfq" and key == "day"
        else "",
        volumeUnit="股",
        latestDate=rows[-1]["time"],
        bars=rows,
    )


def parse_quote(raw, symbol):
    symbol = normalize_symbol(symbol)
    data = raw.get("data") or {}
    if (
        raw.get("rc") != 0
        or str(data.get("f57", "")).upper() != symbol[2:].upper()
        or not isinstance(data.get("f58"), str)
    ):
        raise AppError("估值数据源未返回该股票的有效快照。")
    hk, us = symbol.startswith("hk"), symbol.startswith("us")
    positive = lambda value: (
        n if (n := source_number(value)) is not None and n > 0 else None
    )
    nonnegative = lambda value: (
        n if (n := source_number(value)) is not None and n >= 0 else None
    )
    multiple = lambda value: n if (n := source_number(value)) != 0 else None
    metrics = {
        k: multiple(data.get(f))
        for k, f in dict(
            peTtm="f164", peStatic="f163", peDynamic="f162", pb="f167"
        ).items()
    }
    metrics.update(
        {
            k: positive(data.get(f))
            for k, f in dict(
                marketCap="f116",
                floatMarketCap="f117",
                totalShares="f84",
                floatShares="f85",
            ).items()
        }
    )
    metrics.update(
        {
            k: nonnegative(data.get(f))
            for k, f in dict(
                turnoverRate="f168", turnoverAmount="f48", amplitude="f171"
            ).items()
        }
    )
    volume = nonnegative(data.get("f47"))
    metrics["volume"] = None if volume is None else volume * (1 if hk or us else 100)
    epoch = source_number(data.get("f86"))
    as_of = (
        datetime.fromtimestamp(epoch, timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
        if epoch and 1e9 < epoch < 4.2e9
        else None
    )
    return dict(
        symbol=symbol,
        name=data["f58"],
        currency="USD" if us else "HKD" if hk else "CNY",
        timeZone="America/New_York"
        if us
        else "Asia/Hong_Kong"
        if hk
        else "Asia/Shanghai",
        source="东方财富公开报价",
        sourceUrl=f"https://quote.eastmoney.com/{'us/' + symbol[2:] if us else 'hk/' + symbol[2:] if hk else symbol}.html",
        asOf=as_of,
        metrics=metrics,
        conventions=dict(
            peTtm="滚动市盈率，数据源TTM口径；不等同于一致预期市盈率。",
            peStatic="静态市盈率，数据源静态口径。",
            peDynamic="动态市盈率，不等同于分析师预测。",
            pb="市净率，按数据源净资产口径。",
            currency="金额按报价币种，成交量和股本为股。",
            asOf="报价时间不代表财务报表截止日；快照不随历史走势图范围变化。",
        ),
    )


FIELDS = dict(
    revenue="OPERATE_INCOME",
    grossProfit="GROSS_PROFIT",
    attributableProfit="HOLDER_PROFIT",
    grossMargin="GROSS_PROFIT_RATIO",
    roe="ROE_AVG",
    netMargin="NET_PROFIT_RATIO",
    eps="BASIC_EPS",
    operatingCashFlow="NETCASH_OPERATE",
    totalAssets="TOTAL_ASSETS",
    totalLiabilities="TOTAL_LIABILITIES",
    equity="TOTAL_PARENT_EQUITY",
    debtRatio="DEBT_ASSET_RATIO",
    cash="END_CASH",
)


def parse_financials(raw, reports, symbol, frequency="annual"):
    symbol = normalize_symbol(symbol)
    rows = raw.get("result", {}).get("data") or []
    listing = (reports.get("result", {}).get("data") or [{}])[0].get(
        "REPORT_LIST"
    ) or []
    if not raw.get("success") or not rows or not listing:
        raise AppError("财务数据或报告币种缺失，请上传年报核验")
    result = []
    for row in rows:
        if row.get("SECUCODE") != symbol[2:] + ".HK":
            raise AppError("财务证券代码不匹配")
        report = next(
            (
                r
                for r in listing
                if r.get("SECUCODE") == row["SECUCODE"]
                and r.get("REPORT_DATE", "")[:10] == row.get("REPORT_DATE", "")[:10]
            ),
            None,
        )
        if not report or not report.get("CURRENCY"):
            raise AppError("未能核对财报币种，停止展示金额")
        result.append(
            dict(
                period=row["REPORT_DATE"][:10],
                currency=report["CURRENCY"],
                reportType="年度" if frequency == "annual" else row.get("REPORT_TYPE"),
                **{k: source_number(row.get(v)) for k, v in FIELDS.items()},
            )
        )
    return dict(
        frequency=frequency,
        symbol=symbol,
        name=rows[0]["SECURITY_NAME_ABBR"],
        source="东方财富港股财务指标",
        sourceUrl=f"https://emweb.securities.eastmoney.com/PC_HKF10/FinancialAnalysis/index?type=web&code={symbol[2:]}",
        fetchedAt=now(),
        unit="金额为报告币种元；比率为百分数",
        note="报表币种由报告列表核对，与报价币种分开。",
        rows=sorted(result, key=lambda r: r["period"]),
    )


def parse_a(raw, symbol, frequency="annual"):
    rows = raw.get("result", {}).get("data") or []
    if not raw.get("success") or not rows:
        raise AppError("该证券暂无结构化财务数据")
    result = []
    mapping = dict(
        attributableProfit="PARENTNETPROFIT",
        grossMargin="XSMLL",
        roe="ROEJQ",
        netMargin="XSJLL",
        eps="EPSJB",
        operatingCashFlow="NETCASH_OPERATE_PK",
        totalAssets="TOTAL_ASSETS_PK",
        totalLiabilities="LIABILITY",
        equity="TOTAL_EQUITY_PK",
        debtRatio="ZCFZL",
        deductedProfit="KCFJCXSYJLR",
    )
    for row in rows:
        if row.get("SECUCODE") != symbol[2:] + "." + symbol[:2].upper():
            raise AppError("财务证券代码不匹配")
        result.append(
            dict(
                period=row["REPORT_DATE"][:10],
                reportType=row.get("REPORT_TYPE"),
                currency="人民币",
                revenue=source_number(
                    row.get("OPERATE_INCOME_PK")
                    if row.get("OPERATE_INCOME_PK") is not None
                    else row.get("TOTALOPERATEREVE")
                ),
                grossProfit=None,
                **{k: source_number(row.get(v)) for k, v in mapping.items()},
            )
        )
    return dict(
        symbol=symbol,
        name=rows[0]["SECURITY_NAME_ABBR"],
        source="东方财富A股财务指标",
        sourceUrl=f"https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/Index?type=web&code={symbol}",
        frequency=frequency,
        unit="人民币元；比率为百分数",
        note="非年度数据为年初至报告期末累计，不能当作单季。",
        rows=sorted(result, key=lambda r: r["period"]),
        fetchedAt=now(),
    )


def parse_sec(raw, symbol, limit=5):
    facts = raw.get("facts", {}).get("us-gaap")
    if not facts:
        raise AppError("该公司暂缺US-GAAP标准化财务，请上传报告")
    keys = dict(
        revenue=[
            "RevenueFromContractWithCustomerExcludingAssessedTax",
            "Revenues",
            "SalesRevenueNet",
        ],
        grossProfit=["GrossProfit"],
        attributableProfit=["NetIncomeLoss"],
        operatingCashFlow=["NetCashProvidedByUsedInOperatingActivities"],
        totalAssets=["Assets"],
        totalLiabilities=["Liabilities"],
        equity=["StockholdersEquity"],
        eps=["EarningsPerShareDiluted"],
    )
    series = {}
    for metric, tags in keys.items():
        points = []
        for priority, tag in enumerate(tags):
            for unit, values in facts.get(tag, {}).get("units", {}).items():
                for point in values:
                    if (
                        point.get("form") not in ("10-K", "10-K/A")
                        or not finite(point.get("val"))
                        or not point.get("end")
                        or not point.get("filed")
                    ):
                        continue
                    if unit != ("USD/shares" if metric == "eps" else "USD"):
                        continue
                    if metric in ("totalAssets", "totalLiabilities", "equity"):
                        if point.get("start"):
                            continue
                    else:
                        try:
                            duration = (
                                date.fromisoformat(point["end"])
                                - date.fromisoformat(point["start"])
                            ).days
                        except (KeyError, ValueError):
                            continue
                        if not 300 <= duration <= 400:
                            continue
                    points.append({**point, "tag": tag, "priority": priority})
        points.sort(key=lambda p: p["priority"])
        points.sort(key=lambda p: p["filed"], reverse=True)
        series[metric] = {}
        for point in points:
            series[metric].setdefault(point["end"], point)
    dates = sorted(series["revenue"])[-max(2, min(8, int(limit))) :]
    if not dates:
        raise AppError("未取得完整年度收入，不能构造财务表")
    rows = []
    for period in dates:
        row = dict(
            period=period,
            currency="USD",
            reportType="年度",
            roe=None,
            netMargin=None,
            grossMargin=None,
            debtRatio=None,
            lineage={},
        )
        for metric, points in series.items():
            point = points.get(period)
            row[metric] = point["val"] if point else None
            if point:
                row["lineage"][metric] = dict(
                    tag=point["tag"],
                    start=point.get("start"),
                    end=point["end"],
                    filed=point["filed"],
                    accession=point.get("accn"),
                    form=point["form"],
                )
        if row["revenue"] > 0:
            if row["grossProfit"] is not None:
                row["grossMargin"] = row["grossProfit"] / row["revenue"] * 100
            if row["attributableProfit"] is not None:
                row["netMargin"] = row["attributableProfit"] / row["revenue"] * 100
        if (
            finite(row["totalAssets"])
            and row["totalAssets"] > 0
            and row["totalLiabilities"] is not None
        ):
            row["debtRatio"] = row["totalLiabilities"] / row["totalAssets"] * 100
        rows.append(row)
    return dict(
        symbol=symbol,
        name=raw.get("entityName"),
        source="SEC EDGAR Company Facts",
        sourceUrl="https://www.sec.gov/edgar/browse/?CIK=" + str(raw.get("cik")),
        profitLabel="净利润（US-GAAP）",
        frequency="annual",
        unit="USD元；EPS为USD/股；比率为百分数",
        note="仅完整年度10-K；按最新申报可比数展示，可能含重述；不是时点回测数据。",
        rows=rows,
        fetchedAt=now(),
    )


class FinanceProvider:
    """工具层注入，可用模拟HTTP替换；不写卡片、不拼LLM上下文。"""

    def __init__(self, client=None):
        self.client = client
        self.cache = {}
        self.pending = {}
        self.tickers = None

    async def request(self, url, params=None, text=False):
        client = self.client or httpx.AsyncClient(timeout=25, follow_redirects=True)
        try:
            response = await client.get(
                url,
                params=params,
                headers={
                    "User-Agent": "YanjiResearch/1.0 (local desktop financial research)",
                    "Accept": "application/json",
                },
            )
            if response.status_code >= 400:
                raise AppError(f"公开数据源返回 {response.status_code}，请稍后重试")
            return (
                response.content.decode("gb18030", errors="replace")
                if text
                else response.json()
            )
        finally:
            if not self.client:
                await client.aclose()

    async def cached(self, key, loader, ttl=600, stale_ttl=86400):
        hit = self.cache.get(key)
        if hit and time.monotonic() - hit[0] < ttl:
            return {**clone(hit[1]), "cached": True, "stale": False}
        if key in self.pending:
            return await asyncio.shield(self.pending[key])

        async def load():
            try:
                data = await loader()
                data["fetchedAt"] = now()
                self.cache[key] = (time.monotonic(), clone(data))
                if len(self.cache) > 100:
                    self.cache.pop(next(iter(self.cache)))
                return {**data, "cached": False, "stale": False}
            except Exception:
                if hit and time.monotonic() - hit[0] < stale_ttl:
                    return {
                        **clone(hit[1]),
                        "cached": True,
                        "stale": True,
                        "warning": "数据源暂不可用，展示最近缓存。",
                    }
                raise
            finally:
                self.pending.pop(key, None)

        task = asyncio.create_task(load())
        self.pending[key] = task
        try:
            return await task
        finally:
            if not task.done():
                task.cancel()

    async def resolve_us(self, symbol):
        async def load():
            return parse_us_symbol(
                await self.request("https://qt.gtimg.cn/q=" + quote(symbol), text=True),
                symbol,
            )

        return await self.cached("us:" + symbol, load, 86400, 86400)

    async def market(self, ticker):
        symbol = normalize_symbol(ticker)

        async def load():
            metadata = (
                await self.resolve_us(symbol) if symbol.startswith("us") else None
            )
            provider = metadata["providerSymbol"] if metadata else symbol
            raw = await self.request(
                "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get",
                {"param": f"{provider},day,,,640,qfq"},
            )
            return parse_tencent(raw, provider, "qfq", metadata)

        return await self.cached("market:" + symbol, load)

    async def quote(self, ticker):
        symbol = normalize_symbol(ticker)

        async def load():
            metadata = (
                await self.resolve_us(symbol) if symbol.startswith("us") else None
            )
            secid = (
                metadata["emSecid"]
                if metadata
                else (
                    "116."
                    if symbol.startswith("hk")
                    else "1."
                    if symbol.startswith("sh")
                    else "0."
                )
                + symbol[2:]
            )
            raw = await self.request(
                "https://push2.eastmoney.com/api/qt/stock/get",
                dict(
                    secid=secid,
                    fltt="2",
                    fields="f57,f58,f43,f60,f86,f116,f117,f162,f163,f164,f167,f168,f47,f48,f171,f84,f85",
                ),
            )
            return parse_quote(raw, symbol)

        return await self.cached("quote:" + symbol, load, 300)

    async def company(self, symbol):
        if self.tickers is None:
            self.tickers = await self.request(
                "https://www.sec.gov/files/company_tickers.json"
            )
        company = next(
            (
                r
                for r in self.tickers.values()
                if r["ticker"] == symbol[2:].replace(".", "-")
            ),
            None,
        )
        if not company:
            raise AppError("SEC未找到该代码，部分ADR使用IFRS，请上传年报")
        return company

    async def financials(self, ticker, years=5, frequency="annual"):
        symbol = normalize_symbol(ticker)
        if frequency not in ("annual", "latest"):
            raise AppError("财务期间口径无效")
        limit = max(2, min(8, int(years)))
        if symbol.startswith("us"):
            if frequency != "annual":
                raise AppError(
                    "美股当前提供完整年度10-K；季度请上传10-Q，避免将累计值误作单季"
                )
            company = await self.company(symbol)
            return parse_sec(
                await self.request(
                    f"https://data.sec.gov/api/xbrl/companyfacts/CIK{int(company['cik_str']):010d}.json"
                ),
                symbol,
                limit,
            )
        endpoint = "https://datacenter.eastmoney.com/securities/api/data/v1/get"
        if symbol.startswith("hk"):
            filt = f'(SECUCODE="{symbol[2:]}.HK")'
            raw, reports = await asyncio.gather(
                self.request(
                    endpoint,
                    dict(
                        reportName="RPT_HKF10_FN_MAININDICATOR",
                        columns="ALL",
                        filter=filt
                        + ('(DATE_TYPE_CODE="001")' if frequency == "annual" else ""),
                        pageSize=limit,
                        sortColumns="STD_REPORT_DATE",
                        sortTypes="-1",
                        source="F10",
                        client="PC",
                    ),
                ),
                self.request(
                    endpoint,
                    dict(
                        reportName="RPT_CUSTOM_HKSK_APPFN_CASHFLOW_SUMMARY",
                        columns="SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,START_DATE,REPORT_DATE,FISCAL_YEAR,CURRENCY,ACCOUNT_STANDARD,REPORT_TYPE",
                        filter=filt,
                        source="F10",
                        client="PC",
                    ),
                ),
            )
            return parse_financials(raw, reports, symbol, frequency)
        raw = await self.request(
            endpoint,
            dict(
                reportName="RPT_F10_FINANCE_MAINFINADATA",
                columns="ALL",
                filter=f'(SECUCODE="{symbol[2:]}.{symbol[:2].upper()}")'
                + ('(REPORT_TYPE="年报")' if frequency == "annual" else ""),
                pageSize=limit,
                sortColumns="REPORT_DATE",
                sortTypes="-1",
            ),
        )
        return parse_a(raw, symbol, frequency)

    async def search(self, query):
        if len(query.strip()) < 2:
            return []
        if len(query) > 40:
            raise AppError("请输入公司名称或证券代码。")
        text = await self.request(
            "https://smartbox.gtimg.cn/s3/", dict(q=query, t="all"), text=True
        )
        match = re.search(r'v_hint\s*=\s*"([^"\n]*)"', text)
        if not match:
            return []
        decoded = json.loads('"' + match[1] + '"')
        rows = []
        for row in decoded.split("^"):
            fields = row.split("~")
            if (
                len(fields) < 5
                or fields[4] not in ("GP", "GP-A")
                or fields[0] not in ("sh", "sz", "bj", "hk", "us")
            ):
                continue
            try:
                symbol = normalize_symbol(
                    fields[0] + (fields[1].upper() if fields[0] == "us" else fields[1])
                )
            except AppError:
                continue
            exchange = (
                {"OQ": "NASDAQ", "N": "NYSE", "AM": "NYSE American"}.get(
                    fields[1].upper().split(".")[-1], "US"
                )
                if fields[0] == "us"
                else fields[0].upper()
            )
            rows.append(
                dict(symbol=symbol, code=symbol[2:], exchange=exchange, name=fields[2])
            )
        return rows[:8]

    async def filings(self, ticker):
        symbol = normalize_symbol(ticker)
        if symbol.startswith("hk"):
            raise AppError(
                "港股公告目录暂未接入，请上传港交所公告；不以新闻标题替代公告原文"
            )
        if symbol.startswith("us"):
            company = await self.company(symbol)
            cik = int(company["cik_str"])
            raw = await self.request(
                f"https://data.sec.gov/submissions/CIK{cik:010d}.json"
            )
            recent = raw.get("filings", {}).get("recent")
            if not recent:
                raise AppError("暂未取得申报目录")
            rows = []
            for i, form in enumerate(recent["form"]):
                if form not in ("10-K", "10-Q", "8-K", "20-F", "6-K"):
                    continue
                description = (
                    recent.get("primaryDocDescription")
                    or ["公司申报"] * len(recent["form"])
                )[i]
                rows.append(
                    dict(
                        title=form + " · " + description,
                        date=recent["filingDate"][i],
                        period=recent["reportDate"][i],
                        url=f"https://www.sec.gov/Archives/edgar/data/{cik}/{recent['accessionNumber'][i].replace('-', '')}/{recent['primaryDocument'][i]}",
                    )
                )
            return dict(
                symbol=symbol,
                name=raw["name"],
                source="SEC EDGAR申报目录",
                sourceUrl=f"https://www.sec.gov/edgar/browse/?CIK={cik:010d}",
                rows=rows[:8],
                note="仅目录与公开链接，尚未读取正文，不能从文件标题推断经营影响。",
                fetchedAt=now(),
            )
        raw = await self.request(
            "https://np-anotice-stock.eastmoney.com/api/security/ann",
            dict(
                sr=-1,
                page_size=8,
                page_index=1,
                ann_type="A",
                client_source="web",
                stock_list=symbol[2:],
            ),
        )
        listing = raw.get("data", {}).get("list")
        if not isinstance(listing, list):
            raise AppError("暂无公告目录")
        rows = [
            dict(
                title=r["title"],
                date=r.get("notice_date", "")[:10],
                url=f"https://data.eastmoney.com/notices/detail/{symbol[2:]}/{r['art_code']}.html",
            )
            for r in listing
            if any(c.get("stock_code") == symbol[2:] for c in r.get("codes", []))
        ]
        name = next(
            (
                c.get("short_name")
                for r in listing[:1]
                for c in r.get("codes", [])
                if c.get("stock_code") == symbol[2:]
            ),
            symbol,
        )
        return dict(
            symbol=symbol,
            name=name,
            source="东方财富公司公告目录",
            sourceUrl=f"https://data.eastmoney.com/notices/stock/{symbol[2:]}.html",
            rows=rows,
            note="目录索引，尚未读取公告正文；请打开原文核验或上传后研究。",
            fetchedAt=now(),
        )
