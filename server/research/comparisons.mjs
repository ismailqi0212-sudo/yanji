export function financialComparisons(cards) {
  const results = [];
  for (const card of cards.filter(
    (c) => c.kind === "financials" && c.data.frequency !== "latest",
  )) {
    const rows = card.data.rows;
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i],
        b = rows[i - 1];
      if (a.attributableProfit > 0 && Number.isFinite(a.operatingCashFlow))
        results.push({
          operation: "ratio",
          metric: "经营现金流/净利润",
          period: a.period,
          values: [a.operatingCashFlow, a.attributableProfit],
          result: a.operatingCashFlow / a.attributableProfit,
          sourceIds: card.sourceIds,
        });
      if (!b) continue;
      for (const metric of [
        "revenue",
        "grossProfit",
        "attributableProfit",
        "operatingCashFlow",
        "totalAssets",
        "totalLiabilities",
        "equity",
        "eps",
      ])
        if (Number.isFinite(a[metric]) && b[metric] > 0)
          results.push({
            operation: "growth",
            metric,
            period: a.period,
            previous: b.period,
            values: [a[metric], b[metric]],
            result: (a[metric] / b[metric] - 1) * 100,
            sourceIds: card.sourceIds,
          });
      for (const metric of ["grossMargin", "netMargin", "roe", "debtRatio"])
        if (Number.isFinite(a[metric]) && Number.isFinite(b[metric]))
          results.push({
            operation: "percentage_points",
            metric,
            period: a.period,
            previous: b.period,
            values: [a[metric], b[metric]],
            result: a[metric] - b[metric],
            sourceIds: card.sourceIds,
          });
    }
  }
  return results.map((r) => ({
    ...r,
    display:
      r.result.toFixed(2) +
      (r.operation === "growth"
        ? "%"
        : r.operation === "ratio"
          ? "倍"
          : "个百分点"),
  }));
}
