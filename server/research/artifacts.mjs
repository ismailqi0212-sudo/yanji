import { id, now } from "../memory/store.mjs";
export function scenarioResult(input) {
  const { baseRevenue, growth, margin, years } = input;
  if (
    ![baseRevenue, growth, margin, years].every(Number.isFinite) ||
    baseRevenue < 0 ||
    growth <= -100 ||
    growth > 500 ||
    margin < 0 ||
    margin > 100 ||
    !Number.isInteger(years) ||
    years < 1 ||
    years > 3
  )
    throw new Error("请核对假设：增速需大于-100%，毛利率0–100%，年数1–3");
  return Array.from({ length: years }, (_, i) => ({
    period: "情景第" + (i + 1) + "年",
    revenue: baseRevenue * (1 + growth / 100) ** (i + 1),
    grossProfit: (baseRevenue * (1 + growth / 100) ** (i + 1) * margin) / 100,
  }));
}
export function makeCard(kind, title, data, sourceIds = []) {
  return {
    id: id(),
    kind,
    title,
    data,
    sourceIds: [...new Set(sourceIds)],
    selected: false,
    version: 1,
    at: now(),
  };
}
export function financialChart(
  data,
  sourceId,
  metric = "revenue",
  kind = "line",
) {
  const labels = {
    revenue: "营业收入",
    grossMargin: "毛利率",
    attributableProfit: "归属股东利润",
    grossProfit: "毛利",
    operatingCashFlow: "经营现金流",
    totalAssets: "总资产",
    totalLiabilities: "总负债",
    equity: "股东权益",
    netMargin: "净利率",
    debtRatio: "资产负债率",
    eps: "每股收益",
  };
  if (!labels[metric]) throw new Error("不支持该指标");
  const currencies = new Set(data.rows.map((r) => r.currency));
  if (
    !["grossMargin", "netMargin", "debtRatio"].includes(metric) &&
    currencies.size !== 1
  )
    throw new Error("报告币种不同，不能直接合并");
  return {
    title:
      data.name +
      " · " +
      (metric === "attributableProfit"
        ? data.profitLabel || labels[metric]
        : labels[metric]),
    unit: ["grossMargin", "netMargin", "debtRatio"].includes(metric)
      ? "%"
      : [...currencies][0] + "元",
    scope:
      data.frequency === "latest" ? "披露累计期间，非单季" : "年度，合并口径",
    kind: kind === "bar" ? "bar" : "line",
    metric,
    rows: data.rows.map((r) => ({
      period: r.period,
      value: r[metric] ?? null,
      sourceId,
    })),
    sourceName: data.source,
  };
}
export function markReportStale(c, cardId) {
  if (c.report?.cardVersions?.[cardId] !== undefined) c.report.stale = true;
}
