import { chartExtractionMessages } from "../../context/extraction-context.mjs";
import { search, searchableText } from "./documents.mjs";
import { model } from "../../llm/client.mjs";
import { tool } from "../definition.mjs";
import { jsonrepair } from "jsonrepair";
export function validateSeries(data, chunks) {
  if (
    !data.title ||
    !data.unit ||
    !data.scope ||
    !Array.isArray(data.rows) ||
    !data.rows.length ||
    data.rows.length > 20
  )
    throw new Error("未提取到同一口径的时间序列");
  const rows = data.rows.map((r) => {
    const source = chunks.find((c) => c.id === r.sourceId);
    if (!source) throw new Error("图表来源不存在");
    if (r.value !== null) {
      const raw = String(r.rawValue || "")
          .normalize("NFKC")
          .replace(/[ ,，\s]/g, ""),
        text = source.text.normalize("NFKC").replace(/[ ,，\s]/g, "");
      if (
        !raw ||
        !text.includes(raw) ||
        Number(raw.replace(/^\((.*)\)$/, "-$1")) !== r.value ||
        !Number.isFinite(r.value)
      )
        throw new Error("图表数字未能匹配原文，请缩小到一个指标重试");
    }
    if (!String(r.period || "").trim()) throw new Error("数据期间为空");
    return { period: String(r.period), value: r.value, sourceId: r.sourceId };
  });
  if (new Set(rows.map((r) => r.period)).size !== rows.length)
    throw new Error("相同期间有重复数据，请明确统计口径");
  if (!rows.some((r) => r.value !== null)) throw new Error("没有可绘制的数据");
  return {
    title: String(data.title),
    unit: String(data.unit),
    scope: String(data.scope),
    kind: "line",
    fromMaterials: true,
    sourceName: [
      ...new Set(
        chunks
          .filter((c) => rows.some((r) => r.sourceId === c.id))
          .map((c) => c.name),
      ),
    ].join("；"),
    rows: rows.sort((a, b) =>
      a.period.localeCompare(b.period, undefined, { numeric: true }),
    ),
  };
}
export function seriesFromAnalysis(c, query) {
  const metric = /毛利率/.test(query)
    ? "grossMargin"
    : /经营.*现金|經營.*現金/.test(query)
      ? "operatingCashFlow"
      : /归母|歸母|净利润|淨利潤/.test(query)
        ? "attributableProfit"
        : /毛利/.test(query)
          ? "grossProfit"
          : /收入|营收|營收/.test(query)
            ? "revenue"
            : null;
  if (!metric) return null;
  const active = new Set(c.documents.map((d) => d.hash));
  const entries = Object.values(c.documentAnalysisCache || {})
    .filter((d) => active.has(d.hash))
    .flatMap((d) => d.metrics.map((m) => ({ ...m, name: d.name })))
    .filter((m) => m.metric === metric);
  if (!entries.length) return null;
  const groups = new Map();
  for (const m of entries) {
    const key =
      searchableText(m.unit).replace(/人民币|cny|rmb/g, "") +
      "|" +
      searchableText(m.currency);
    const group = groups.get(key) || [];
    group.push(m);
    groups.set(key, group);
  }
  const candidates = [...groups.values()].sort(
    (a, b) =>
      new Set(b.map((m) => m.period)).size -
      new Set(a.map((m) => m.period)).size,
  );
  const group = candidates[0],
    periods = new Map();
  for (const m of group) {
    const existing = periods.get(m.period);
    if (existing && existing.value !== m.value)
      throw new Error(
        "同一年度在报告中提取到不同数值，请核对原文口径后选择来源，暂不自动连线",
      );
    periods.set(m.period, m);
  }
  if (periods.size < 2) return null;
  const labels = {
    revenue: "营业收入",
    grossProfit: "毛利",
    attributableProfit: "归母净利润",
    grossMargin: "毛利率",
    operatingCashFlow: "经营现金流",
  };
  return {
    title: labels[metric] + " · 上传报告",
    unit: group[0].unit,
    scope: "原报告年度合并口径，未换算单位",
    kind: "line",
    fromMaterials: true,
    sourceName: [...new Set(group.map((m) => m.name))].join("；"),
    rows: [...periods.values()]
      .sort((a, b) => a.period.localeCompare(b.period))
      .map((m) => ({ period: m.period, value: m.value, sourceId: m.sourceId })),
  };
}
export async function extractSeries(c, query, { signal, modelService } = {}) {
  if (!c.documents.length) throw new Error("请先上传财报");
  const analyzed = seriesFromAnalysis(c, query);
  if (analyzed) return analyzed;
  const chunks = c.documents
    .flatMap((d) => search(c, query, [d.id], 3))
    .slice(0, 18);
  if (!chunks.length) throw new Error("材料中未找到相关指标，请换一个名称");
  const seriesTool = tool(
    "extractSeries",
    "从原文提取一个指标，禁止换算、插值或估算。",
    {
      title: { type: "string" },
      unit: { type: "string" },
      scope: { type: "string" },
      rows: {
        type: "array",
        items: {
          type: "object",
          properties: {
            period: { type: "string" },
            value: { type: ["number", "null"] },
            sourceId: { type: "string" },
            rawValue: { type: "string" },
          },
          required: ["period", "value", "sourceId", "rawValue"],
          additionalProperties: false,
        },
      },
    },
    ["title", "unit", "scope", "rows"],
  );
  const r = await (
    modelService
      ? (messages, options) =>
          modelService.complete(messages, options, {
            purpose: "chart-extraction",
          })
      : model
  )(chartExtractionMessages({ query, chunks }), {
    tools: [seriesTool],
    force: "extractSeries",
    maxTokens: 2500,
    signal,
  });
  const call = r.tool_calls?.find((t) => t.function.name === "extractSeries");
  if (!call) throw new Error("未能提取图表数据");
  return validateSeries(
    JSON.parse(jsonrepair(call.function.arguments)),
    chunks,
  );
}
