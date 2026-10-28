import * as OpenCC from "opencc-js";
const simplify = OpenCC.Converter({ from: "hk", to: "cn" });
/** Pure alignment and quarter arithmetic. No LLM arithmetic and no inferred missing values. */
export const PERIOD = /^20\d{2}(?:-(?:Q[1-4]|H1|9M))?$/;
const normalized = (s) =>
  simplify(String(s || ""))
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
const nonFlow =
  /月活|日活|用户|订阅者|人数|余额|平均|arpu|mau|dau|subscriber|margin|ratio|rate|average|单价|百分比|增长率|毛利率/i;
export function safeMeasureKind(metric, kind, unit) {
  if (kind !== "flow") return kind;
  if (nonFlow.test(metric) || /[%％]|人\/|\/月|per user|\/user/i.test(unit))
    return "average";
  return "flow";
}
const periodRank = (p) =>
  Number(p.slice(0, 4)) * 10 +
  ({ Q1: 1, H1: 2, Q2: 3, "9M": 4, Q3: 5, Q4: 6 }[p.slice(5)] || 7);
export function alignOperatingFacts(facts) {
  const map = new Map();
  for (const f of facts) {
    if (!PERIOD.test(f.period) || !Number.isFinite(f.value) || !f.sourceId)
      continue;
    const kind = safeMeasureKind(f.metric, f.kind, f.unit);
    const key = [
      f.company,
      f.metric,
      f.scope,
      f.unit,
      f.currency,
      kind,
      f.calendar || "",
    ]
      .map(normalized)
      .join("|");
    if (!map.has(key))
      map.set(key, {
        id: "metric-" + map.size,
        metric: f.metric,
        company: f.company,
        unit: f.unit,
        currency: f.currency,
        scope: f.scope,
        kind,
        calendar: f.calendar,
        cells: {},
      });
    const row = map.get(key),
      old = row.cells[f.period];
    const candidate = {
      value: f.value,
      rawValue: f.rawValue,
      sourceId: f.sourceId,
      quote: f.quote,
      page: f.page,
      documentId: f.documentId,
    };
    if (!old)
      row.cells[f.period] = {
        value: f.value,
        status: "reported",
        sourceIds: [f.sourceId],
        candidates: [candidate],
      };
    else {
      old.candidates.push(candidate);
      old.sourceIds = [...new Set([...old.sourceIds, f.sourceId])];
      if (old.status === "conflict" || old.value !== f.value) {
        old.status = "conflict";
        old.value = null;
      }
    }
  }
  const rows = [...map.values()];
  for (const row of rows) {
    if (
      row.kind !== "flow" ||
      !row.calendar ||
      /未知|unknown/i.test(row.calendar)
    )
      continue;
    const years = [
      ...new Set(Object.keys(row.cells).map((p) => p.slice(0, 4))),
    ];
    function derive(target, operands) {
      if (row.cells[target]) return;
      const cells = operands.map((p) => row.cells[p]);
      if (
        cells.some(
          (c) => !c || c.status === "conflict" || !Number.isFinite(c.value),
        )
      )
        return;
      const value = Number(
        (
          cells[0].value - cells.slice(1).reduce((sum, c) => sum + c.value, 0)
        ).toPrecision(12),
      );
      row.cells[target] = {
        value,
        status: "derived",
        sourceIds: [...new Set(cells.flatMap((c) => c.sourceIds))],
        formula: operands.join(" − "),
        operands: operands.map((p, i) => ({
          period: p,
          value: cells[i].value,
          sourceIds: cells[i].sourceIds,
        })),
        candidates: [],
      };
    }
    for (const year of years) {
      derive(year + "-Q2", [year + "-H1", year + "-Q1"]);
      derive(year + "-Q3", [year + "-9M", year + "-H1"]);
      derive(year + "-Q4", [year, year + "-9M"]);
      derive(year + "-Q4", [year, year + "-Q1", year + "-Q2", year + "-Q3"]);
    }
  }
  return {
    rows,
    periods: [...new Set(rows.flatMap((r) => Object.keys(r.cells)))].sort(
      (a, b) => periodRank(a) - periodRank(b),
    ),
    conflicts: rows.reduce(
      (n, r) =>
        n +
        Object.values(r.cells).filter((c) => c.status === "conflict").length,
      0,
    ),
    fromMaterials: true,
  };
}
export function operatingChart(data, rowId, view = "annual") {
  if (!["annual", "quarter"].includes(view))
    throw new Error("图表只能按年度或单季展示，不能混合累计口径");
  const row = data.rows.find((r) => r.id === rowId);
  if (!row) throw new Error("经营指标不存在");
  const periods = data.periods.filter((p) =>
    view === "annual" ? /^\d{4}$/.test(p) : /-Q[1-4]$/.test(p),
  );
  if (!periods.some((p) => Number.isFinite(row.cells[p]?.value)))
    throw new Error("该口径没有可绘制数据，请补充报告或切换期间");
  return {
    title: row.company + " · " + row.metric,
    unit: row.unit,
    scope: row.scope + " · " + (view === "annual" ? "年度" : "单季"),
    fromMaterials: true,
    kind: "line",
    rows: periods.map((period) => ({
      period,
      value: row.cells[period]?.value ?? null,
      sourceId: row.cells[period]?.sourceIds[0],
      sourceIds: row.cells[period]?.sourceIds || [],
      formula: row.cells[period]?.formula,
    })),
    sourceName: "上传报告；单季派生公式保留在经营底稿",
  };
}
