import { toolEffects } from "../research/effects.mjs";
/** Lazy domain handlers; injected effects stage business results before verification. */
import { buildOperatingWorksheet } from "./documents/operating-worksheet.mjs";
import { analyzeUploadedDocuments } from "./documents/long-analysis.mjs";
import { savePlan, updateGap } from "../research/plan.mjs";
import { readCurrentReport, proposeRevision } from "../reports/revisions.mjs";
import { companyFilings } from "./financial/filings.mjs";
import { extractSeries } from "./documents/material-chart.mjs";
import { searchSymbols } from "./financial/market.mjs";
import { search, evidence, calculate } from "./documents/documents.mjs";
import {
  makeCard,
  financialChart,
  scenarioResult,
} from "../research/artifacts.mjs";
import { deliverResearch } from "../research/delivery.mjs";

/** Registry invokes this lazy legacy handler; it does not choose tools or assemble context. */
export async function handle_buildOperatingWorksheet(context, a) {
  const { cid, run, seen, calculations, signal, effects } = context;
  const { getProject, event, addSource, addArtifact } = toolEffects(effects);
  return buildOperatingWorksheet(
    { cid, run, seen, signal, effects, modelService: context.modelService },
    a,
  );
}

/** Registry invokes this lazy legacy handler; it does not choose tools or assemble context. */
export async function handle_analyzeDocuments(context, a) {
  const { cid, run, seen, calculations, signal, effects } = context;
  const { getProject, event, addSource, addArtifact } = toolEffects(effects);
  return analyzeUploadedDocuments(
    { cid, run, seen, signal, effects, modelService: context.modelService },
    a.focus || run.question,
  );
}

/** Registry invokes this lazy legacy handler; it does not choose tools or assemble context. */
export async function handle_planResearch(context, a) {
  const { cid, run, seen, calculations, signal, effects } = context;
  const { getProject, event, addSource, addArtifact } = toolEffects(effects);
  event(cid, run.id, "制定研究计划", a.goal);
  return savePlan(cid, run.id, a, effects);
}

/** Registry invokes this lazy legacy handler; it does not choose tools or assemble context. */
export async function handle_updateResearchGap(context, a) {
  const { cid, run, seen, calculations, signal, effects } = context;
  const { getProject, event, addSource, addArtifact } = toolEffects(effects);
  return updateGap(cid, a, seen, effects);
}

/** Registry invokes this lazy legacy handler; it does not choose tools or assemble context. */
export async function handle_readCurrentReport(context, a) {
  const { cid, run, seen, calculations, signal, effects } = context;
  const { getProject, event, addSource, addArtifact } = toolEffects(effects);
  return readCurrentReport(cid, effects);
}

/** Registry invokes this lazy legacy handler; it does not choose tools or assemble context. */
export async function handle_proposeReportRevision(context, a) {
  const { cid, run, seen, calculations, signal, effects } = context;
  const { getProject, event, addSource, addArtifact } = toolEffects(effects);
  return proposeRevision({ cid, run, seen, calculations, effects }, a);
}

/** Registry invokes this lazy legacy handler; it does not choose tools or assemble context. */
export async function handle_getCompanyFilings(context, a) {
  const { cid, run, seen, calculations, signal, effects } = context;
  const { getProject, event, addSource, addArtifact } = toolEffects(effects);
  const c = getProject(cid);
  let result;
  if (run.sourceMode === "documents")
    throw new Error("本轮仅使用上传报告，不查询外部公告目录");
  event(cid, run.id, "查询公司披露", a.ticker);
  const data = await companyFilings(a.ticker),
    source = addSource(cid, data, "公司披露目录 · " + data.name);
  seen.add(source.id);
  addArtifact(
    cid,
    run.id,
    makeCard("filings", data.name + " · 最新披露", data, [source.id]),
  );
  result = { sourceId: source.id, ...data };
  return result;
}

/** Registry invokes this lazy legacy handler; it does not choose tools or assemble context. */
export async function handle_findCompany(context, a) {
  const { cid, run, seen, calculations, signal, effects } = context;
  const { getProject, event, addSource, addArtifact } = toolEffects(effects);
  const c = getProject(cid);
  let result;
  event(cid, run.id, "识别公司", a.query);
  result = await searchSymbols(a.query);
  return result;
}

/** Registry invokes this lazy legacy handler; it does not choose tools or assemble context. */
export async function handle_searchFilings(context, a) {
  const { cid, run, seen, calculations, signal, effects } = context;
  const { getProject, event, addSource, addArtifact } = toolEffects(effects);
  const c = getProject(cid);
  let result;
  event(cid, run.id, "检索财报", a.query);
  result = search(c, a.query, [], 4).map((e) => {
    seen.add(e.id);
    return {
      sourceId: e.id,
      documentId: e.documentId,
      page: e.page,
      name: e.name,
      text: e.text,
    };
  });
  return result;
}

/** Registry invokes this lazy legacy handler; it does not choose tools or assemble context. */
export async function handle_readPage(context, a) {
  const { cid, run, seen, calculations, signal, effects } = context;
  const { getProject, event, addSource, addArtifact } = toolEffects(effects);
  const c = getProject(cid);
  let result;
  const d = c.documents.find((d) => d.id === a.documentId);
  if (!d || !Number.isInteger(a.page) || a.page < 1 || a.page > d.pages.length)
    throw new Error("无效的材料或页码");
  event(cid, run.id, "阅读原文", d.name + " · " + a.page);
  result = d.chunks
    .filter((e) => e.page === a.page)
    .map((e) => {
      seen.add(e.id);
      return { sourceId: e.id, page: e.page, text: e.text };
    });
  return result;
}

/** Registry invokes this lazy legacy handler; it does not choose tools or assemble context. */
export async function handle_calculate(context, a) {
  const { cid, run, seen, calculations, signal, effects } = context;
  const { getProject, event, addSource, addArtifact } = toolEffects(effects);
  const c = getProject(cid);
  let result;
  if (
    !Array.isArray(a.sourceIds) ||
    !a.sourceIds.length ||
    a.sourceIds.some((s) => !seen.has(s))
  )
    throw new Error("计算需要关联已读来源");
  if (!Array.isArray(a.values)) throw new Error("请提供数字数组");
  result = {
    id:
      "C" + (calculations.filter((c) => /^C\d+$/.test(c.id || "")).length + 1),
    ...calculate({
      ...a,
      values: a.values.map((v) =>
        typeof v === "string" && /^-?[\d,]+(?:\.\d+)?$/.test(v)
          ? Number(v.replaceAll(",", ""))
          : v,
      ),
    }),
    sourceIds: a.sourceIds,
  };
  result.display =
    result.result.toFixed(2) +
    (a.operation === "growth"
      ? "%"
      : a.operation === "percentage_points"
        ? " 个百分点"
        : "");
  calculations.push(result);
  event(
    cid,
    run.id,
    "核对计算结果",
    `${a.operation} → ${Number(result.result.toPrecision(8))}`,
  );
  return result;
}

/** Registry invokes this lazy legacy handler; it does not choose tools or assemble context. */
export async function handle_chartFromFilings(context, a) {
  const { cid, run, seen, calculations, signal, effects } = context;
  const { getProject, event, addSource, addArtifact } = toolEffects(effects);
  const c = getProject(cid);
  let result;
  event(cid, run.id, "整理财报时间序列", a.query);
  const data = await extractSeries(c, a.query, {
    signal,
    modelService: context.modelService,
  });
  const sourceIds = [...new Set(data.rows.map((r) => r.sourceId))];
  sourceIds.forEach((s) => seen.add(s));
  const card = addArtifact(
    cid,
    run.id,
    makeCard("chart", data.title, data, sourceIds),
  );
  result = {
    cardId: card.id,
    sourceIds,
    unit: data.unit,
    scope: data.scope,
    rows: data.rows,
  };
  return result;
}

/** Registry invokes this lazy legacy handler; it does not choose tools or assemble context. */
export async function handle_createChart(context, a) {
  const { cid, run, seen, calculations, signal, effects } = context;
  const { getProject, event, addSource, addArtifact } = toolEffects(effects);
  const c = getProject(cid);
  let result;
  if (!seen.has(a.sourceId)) throw new Error("先查询财务数据");
  const source = evidence(c, a.sourceId);
  if (!source?.data?.rows) throw new Error("该来源没有年度财务序列");
  const data = financialChart(source.data, a.sourceId, a.metric, a.kind);
  const card = addArtifact(
    cid,
    run.id,
    makeCard("chart", data.title, data, [a.sourceId]),
  );
  event(cid, run.id, "生成图表", data.title);
  result = {
    cardId: card.id,
    sourceId: a.sourceId,
    note: "图表已在对话中显示，用户可下载或切图型。",
  };
  return result;
}

/** Registry invokes this lazy legacy handler; it does not choose tools or assemble context. */
export async function handle_createScenario(context, a) {
  const { cid, run, seen, calculations, signal, effects } = context;
  const { getProject, event, addSource, addArtifact } = toolEffects(effects);
  const c = getProject(cid);
  let result;
  const source = evidence(c, a.sourceId);
  if (!seen.has(a.sourceId) || !source?.data?.rows?.length)
    throw new Error("先查询年度财务");
  const rows = source.data.rows,
    last = rows.at(-1),
    prev = rows.at(-2);
  if (source.data.frequency === "latest")
    throw new Error("累计期不能直接作为年度情景基准，请先查年度数据");
  if (last.revenue === null || last.grossMargin === null)
    throw new Error("收入或毛利率缺失，不能建立模型");
  const input = {
    baseRevenue: last.revenue,
    growth: Number.isFinite(a.growth)
      ? a.growth
      : prev?.revenue > 0
        ? Number(((last.revenue / prev.revenue - 1) * 100).toFixed(2))
        : 0,
    margin: Number.isFinite(a.margin)
      ? a.margin
      : Number(last.grossMargin.toFixed(2)),
    years: Number.isInteger(a.years) ? a.years : 2,
  };
  const data = {
    name: source.data.name,
    basePeriod: last.period,
    currency: last.currency,
    input,
    rows: scenarioResult(input),
    note: "用户指定参数优先，其余参数参考最新历史数据；可编辑值均为情景假设，不是公司预测。",
  };
  const scenarioSource = addSource(
    cid,
    { ...data, growthRate: input.growth, grossMargin: input.margin },
    "用户情景假设 · " + data.name,
  );
  seen.add(scenarioSource.id);
  const card = addArtifact(
    cid,
    run.id,
    makeCard("scenario", "假设沙盘 · " + data.name, data, [
      a.sourceId,
      scenarioSource.id,
    ]),
  );
  event(cid, run.id, "建立假设沙盘", data.name);
  result = {
    cardId: card.id,
    sourceIds: card.sourceIds,
    note: data.note,
  };
  return result;
}

/** Registry invokes this lazy legacy handler; it does not choose tools or assemble context. */
export async function handle_deliverResearch(context, a) {
  const { cid, run, seen, calculations, signal, effects } = context;
  const { getProject, event, addSource, addArtifact } = toolEffects(effects);
  return deliverResearch({ cid, run, seen, calculations, effects }, a);
}
