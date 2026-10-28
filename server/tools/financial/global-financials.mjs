import { normalizeSymbol } from "./market.mjs";
import { sourceNumber as num } from "./quote.mjs";
const headers = {
  "User-Agent": "YanjiResearch/1.0 (local desktop financial research)",
  Accept: "application/json",
};
let tickerCache;
const cache = new Map();
async function json(url) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error("公开财务源返回 " + r.status);
  return r.json();
}
export function parseA(raw, symbol, frequency = "annual") {
  const rows = raw?.result?.data;
  if (!raw?.success || !rows?.length)
    throw new Error("该证券暂无结构化财务数据");
  const code = symbol.slice(2) + "." + symbol.slice(0, 2).toUpperCase();
  return {
    symbol,
    name: rows[0].SECURITY_NAME_ABBR,
    source: "东方财富A股财务指标",
    sourceUrl:
      "https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/Index?type=web&code=" +
      symbol,
    frequency,
    unit: "人民币元；比率为百分数",
    note: "非年度数据为年初至报告期末累计，不能当作单季；财务指标按披露口径。",
    rows: rows
      .map((r) => {
        if (r.SECUCODE !== code) throw new Error("财务证券代码不匹配");
        return {
          period: r.REPORT_DATE.slice(0, 10),
          reportType: r.REPORT_TYPE,
          currency: "人民币",
          revenue: num(r.OPERATE_INCOME_PK ?? r.TOTALOPERATEREVE),
          grossProfit: null,
          attributableProfit: num(r.PARENTNETPROFIT),
          grossMargin: num(r.XSMLL),
          roe: num(r.ROEJQ),
          netMargin: num(r.XSJLL),
          eps: num(r.EPSJB),
          operatingCashFlow: num(r.NETCASH_OPERATE_PK),
          totalAssets: num(r.TOTAL_ASSETS_PK),
          totalLiabilities: num(r.LIABILITY),
          equity: num(r.TOTAL_EQUITY_PK),
          debtRatio: num(r.ZCFZL),
          deductedProfit: num(r.KCFJCXSYJLR),
        };
      })
      .sort((a, b) => a.period.localeCompare(b.period)),
    fetchedAt: new Date().toISOString(),
  };
}
export function parseSEC(raw, symbol, limit = 5) {
  const facts = raw?.facts?.["us-gaap"];
  if (!facts) throw new Error("该公司暂缺US-GAAP标准化财务，请上传报告");
  const keys = {
    revenue: [
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "Revenues",
      "SalesRevenueNet",
    ],
    grossProfit: ["GrossProfit"],
    attributableProfit: ["NetIncomeLoss"],
    operatingCashFlow: ["NetCashProvidedByUsedInOperatingActivities"],
    totalAssets: ["Assets"],
    totalLiabilities: ["Liabilities"],
    equity: ["StockholdersEquity"],
    eps: ["EarningsPerShareDiluted"],
  };
  const series = {};
  for (const [metric, tags] of Object.entries(keys)) {
    const merged = [];
    for (const [priority, tag] of tags.entries())
      for (const [unit, points] of Object.entries(facts[tag]?.units || {}))
        for (const p of points) {
          if (
            !["10-K", "10-K/A"].includes(p.form) ||
            !Number.isFinite(p.val) ||
            !p.end ||
            !p.filed
          )
            continue;
          const duration = p.start
            ? (Date.parse(p.end) - Date.parse(p.start)) / 86400000
            : 0;
          if (
            ["totalAssets", "totalLiabilities", "equity"].includes(metric)
              ? !!p.start
              : duration < 300 || duration > 400
          )
            continue;
          if (unit !== (metric === "eps" ? "USD/shares" : "USD")) continue;
          merged.push({ ...p, tag, priority });
        }
    merged.sort(
      (a, b) => b.filed.localeCompare(a.filed) || a.priority - b.priority,
    );
    series[metric] = new Map();
    for (const p of merged)
      if (!series[metric].has(p.end)) series[metric].set(p.end, p);
  }
  const dates = [...series.revenue.keys()]
    .sort()
    .slice(-Math.max(2, Math.min(8, limit)));
  if (!dates.length) throw new Error("未取得完整年度收入，不能构造财务表");
  return {
    symbol,
    name: raw.entityName,
    source: "SEC EDGAR Company Facts",
    sourceUrl: "https://www.sec.gov/edgar/browse/?CIK=" + raw.cik,
    profitLabel: "净利润（US-GAAP）",
    frequency: "annual",
    unit: "USD元；EPS为USD/股；比率为百分数",
    note: "仅完整年度10-K，按最新申报的可比数展示（可能含重述），不是时点回测数据；净利润为US-GAAP NetIncomeLoss，核对公司报表定义。未推算自由现金流。",
    rows: dates.map((period) => {
      const r = {
        period,
        currency: "USD",
        reportType: "年度",
        roe: null,
        netMargin: null,
        grossMargin: null,
        debtRatio: null,
      };
      const lineage = {};
      for (const [metric, map] of Object.entries(series)) {
        const p = map.get(period);
        r[metric] = p?.val ?? null;
        if (p)
          lineage[metric] = {
            tag: p.tag,
            start: p.start || null,
            end: p.end,
            filed: p.filed,
            accession: p.accn,
            form: p.form,
          };
      }
      if (r.revenue > 0) {
        if (r.grossProfit !== null)
          r.grossMargin = (r.grossProfit / r.revenue) * 100;
        if (r.attributableProfit !== null)
          r.netMargin = (r.attributableProfit / r.revenue) * 100;
      }
      if (r.totalAssets > 0 && r.totalLiabilities !== null)
        r.debtRatio = (r.totalLiabilities / r.totalAssets) * 100;
      r.lineage = lineage;
      return r;
    }),
    fetchedAt: new Date().toISOString(),
  };
}
export async function globalFinancials(input, limit = 5, frequency = "annual") {
  const symbol = normalizeSymbol(input),
    key = symbol + ":" + limit + ":" + frequency;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 900000) return hit.data;
  let data;
  if (symbol.startsWith("us")) {
    if (frequency !== "annual")
      throw new Error(
        "美股当前提供完整年度10-K；季度请上传10-Q，避免将累计值误作单季",
      );
    if (!tickerCache)
      tickerCache = await json(
        "https://www.sec.gov/files/company_tickers.json",
      );
    const ticker = symbol.slice(2).replace(".", "-"),
      company = Object.values(tickerCache).find((x) => x.ticker === ticker);
    if (!company)
      throw new Error("SEC未找到该美股代码，部分ADR使用IFRS，请上传年报");
    const raw = await json(
      "https://data.sec.gov/api/xbrl/companyfacts/CIK" +
        String(company.cik_str).padStart(10, "0") +
        ".json",
    );
    data = parseSEC(raw, symbol, limit);
  } else {
    const url = new URL(
      "https://datacenter.eastmoney.com/securities/api/data/v1/get",
    );
    for (const [k, v] of Object.entries({
      reportName: "RPT_F10_FINANCE_MAINFINADATA",
      columns: "ALL",
      filter:
        '(SECUCODE="' +
        symbol.slice(2) +
        "." +
        symbol.slice(0, 2).toUpperCase() +
        '")' +
        (frequency === "annual" ? '(REPORT_TYPE="年报")' : ""),
      pageSize: Math.max(2, Math.min(8, limit)),
      sortColumns: "REPORT_DATE",
      sortTypes: "-1",
    }))
      url.searchParams.set(k, v);
    data = parseA(await json(url), symbol, frequency);
  }
  cache.set(key, { at: Date.now(), data });
  return data;
}
