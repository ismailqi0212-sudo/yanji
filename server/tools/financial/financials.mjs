import { globalFinancials } from "./global-financials.mjs";
import { normalizeSymbol } from "./market.mjs";
import { sourceNumber } from "./quote.mjs";
const endpoint = "https://datacenter.eastmoney.com/securities/api/data/v1/get";
export function parseFinancials(raw, reports, input, frequency = "annual") {
  const symbol = normalizeSymbol(input);
  if (!symbol.startsWith("hk"))
    throw new Error(
      "结构化多年财务目前支持港股；A股、美股请上传财报，行情估值仍可查询。",
    );
  const code = symbol.slice(2) + ".HK";
  const rows = raw?.result?.data;
  const list = reports?.result?.data?.[0]?.REPORT_LIST;
  if (
    !raw?.success ||
    !Array.isArray(rows) ||
    !rows.length ||
    !Array.isArray(list)
  )
    throw new Error("财务数据或报告币种缺失，请上传年报核验");
  const result = rows
    .map((r) => {
      if (r.SECUCODE !== code) throw new Error("财务证券代码不匹配");
      const report = list.find(
        (x) =>
          x.SECUCODE === code &&
          x.REPORT_DATE?.slice(0, 10) === r.REPORT_DATE?.slice(0, 10),
      );
      if (!report?.CURRENCY) throw new Error("未能核对财报币种，停止展示金额");
      return {
        period: r.REPORT_DATE.slice(0, 10),
        currency: report.CURRENCY,
        reportType: frequency === "annual" ? "年度" : r.REPORT_TYPE,
        revenue: sourceNumber(r.OPERATE_INCOME),
        grossProfit: sourceNumber(r.GROSS_PROFIT),
        attributableProfit: sourceNumber(r.HOLDER_PROFIT),
        grossMargin: sourceNumber(r.GROSS_PROFIT_RATIO),
        roe: sourceNumber(r.ROE_AVG),
        netMargin: sourceNumber(r.NET_PROFIT_RATIO),
        eps: sourceNumber(r.BASIC_EPS),
        operatingCashFlow: sourceNumber(r.NETCASH_OPERATE),
        totalAssets: sourceNumber(r.TOTAL_ASSETS),
        totalLiabilities: sourceNumber(r.TOTAL_LIABILITIES),
        equity: sourceNumber(r.TOTAL_PARENT_EQUITY),
        debtRatio: sourceNumber(r.DEBT_ASSET_RATIO),
        cash: sourceNumber(r.END_CASH),
      };
    })
    .sort((a, b) => a.period.localeCompare(b.period));
  return {
    frequency,
    symbol,
    name: rows[0].SECURITY_NAME_ABBR,
    source: "东方财富港股财务指标",
    sourceUrl: `https://emweb.securities.eastmoney.com/PC_HKF10/FinancialAnalysis/index?type=web&code=${symbol.slice(2)}`,
    fetchedAt: new Date().toISOString(),
    unit: "金额为报告币种元；毛利率与ROE为百分数",
    note: "报表币种由年度报告列表核对，与股票报价币种分开；净利润为归属权益持有人口径。",
    rows: result,
  };
}
export async function financialData(input, limit = 5, frequency = "annual") {
  const symbol = normalizeSymbol(input);
  if (!symbol.startsWith("hk"))
    return globalFinancials(input, limit, frequency);
  const filter = `(SECUCODE="${symbol.slice(2)}.HK")`;
  async function get(params) {
    const url = new URL(endpoint);
    for (const [k, v] of Object.entries({
      ...params,
      source: "F10",
      client: "PC",
    }))
      url.searchParams.set(k, String(v));
    const r = await fetch(url, { signal: AbortSignal.timeout(18000) });
    if (!r.ok) throw new Error("财务接口暂不可用");
    return r.json();
  }
  const [raw, reports] = await Promise.all([
    get({
      reportName: "RPT_HKF10_FN_MAININDICATOR",
      columns: "ALL",
      filter: filter + (frequency === "annual" ? '(DATE_TYPE_CODE="001")' : ""),
      pageSize: Math.max(2, Math.min(8, Number(limit) || 5)),
      sortColumns: "STD_REPORT_DATE",
      sortTypes: "-1",
    }),
    get({
      reportName: "RPT_CUSTOM_HKSK_APPFN_CASHFLOW_SUMMARY",
      columns:
        "SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,START_DATE,REPORT_DATE,FISCAL_YEAR,CURRENCY,ACCOUNT_STANDARD,REPORT_TYPE",
      filter,
    }),
  ]);
  return parseFinancials(raw, reports, symbol, frequency);
}
