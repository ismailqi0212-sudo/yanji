import { operatingPartMessages } from "../../context/extraction-context.mjs";
import { toolEffects } from "../../research/effects.mjs";
export { worksheetTool } from "../task-schemas.mjs";
import { alignOperatingMetrics } from "./align-operating.mjs";
/** Focused document extraction feeds a deterministic, persistent operating worksheet. */
import { createHash } from "node:crypto";
import { jsonrepair } from "jsonrepair";
import { tool } from "../definition.mjs";
import { model } from "../../llm/client.mjs";
import { makeCard } from "../../research/artifacts.mjs";
import { documentBatches } from "./long-analysis.mjs";
import { searchableText } from "./documents.mjs";
import {
  alignOperatingFacts,
  PERIOD,
} from "../../research/operating-series.mjs";
const str = { type: "string" };
const extractTool = tool(
  "extractOperatingFacts",
  "从本批文字提取直接披露的经营指标原值，不计算单季或比率。",
  {
    facts: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        properties: {
          company: str,
          metric: str,
          period: str,
          kind: { type: "string", enum: ["flow", "stock", "ratio", "average"] },
          value: { type: "number" },
          rawValue: str,
          unit: str,
          currency: str,
          scope: str,
          calendar: str,
          sourceId: str,
          quote: str,
        },
        required: [
          "company",
          "metric",
          "period",
          "kind",
          "value",
          "rawValue",
          "unit",
          "currency",
          "scope",
          "calendar",
          "sourceId",
          "quote",
        ],
        additionalProperties: false,
      },
    },
  },
  ["facts"],
);
const normalized = (s) => searchableText(String(s)).replace(/[\s,，]/g, "");
export function validateOperatingFacts(data, chunks) {
  const facts = [],
    rejected = [];
  for (const f of data.facts || []) {
    const source = chunks.find((c) => c.id === f.sourceId),
      raw = String(f.rawValue || "")
        .normalize("NFKC")
        .replace(/[\s,，%％]/g, "");
    const value = Number(raw.replace(/^\((.*)\)$/, "-$1"));
    if (
      !source ||
      !raw ||
      !PERIOD.test(f.period) ||
      !Number.isFinite(f.value) ||
      value !== f.value ||
      !["flow", "stock", "ratio", "average"].includes(f.kind) ||
      ![f.company, f.metric, f.unit, f.scope, f.calendar].every(
        (v) => typeof v === "string" && v.trim(),
      ) ||
      normalized(f.quote).length < 8 ||
      !normalized(source.text).includes(normalized(f.quote)) ||
      !normalized(f.quote).includes(
        normalized(f.rawValue).replace(/[%％]/g, ""),
      )
    ) {
      rejected.push("数字、期间或引文不完整");
      continue;
    }
    facts.push({ ...f, page: source.page, documentId: source.documentId });
  }
  return { facts, rejected };
}
export async function buildOperatingWorksheet(
  { cid, run, seen, signal, effects, modelService },
  args = {},
  llm = model,
) {
  const { getProject, updateRun, event, addArtifact } = toolEffects(effects);
  const chat = getProject(cid);
  if (!chat.documents.length) throw new Error("请先上传连续多期财报");
  const focus = String(args.focus || run.question),
    metrics = (args.metrics || []).slice(0, 12);
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        files: chat.documents.map((d) => d.hash),
        focus,
        metrics,
      }),
    )
    .digest("hex");
  const previous = chat.runs
    .find((r) => r.id === run.id)
    ?.records.find(
      (r) => r.name === "buildOperatingWorksheet" && r.result?.cardId,
    );
  const old =
    (previous && chat.cards.find((c) => c.id === previous.result.cardId)) ||
    chat.cards.find((c) => c.kind === "worksheet" && c.data.cacheKey === key);
  if (old) {
    old.sourceIds.forEach((s) => seen.add(s));
    updateRun(cid, run.id, (c, r) => {
      const m = c.messages.find((m) => m.id === r.messageId);
      if (!m.cardIds.includes(old.id)) m.cardIds.push(old.id);
    });
    return { cardId: old.id, reused: true, ...summary(old.data) };
  }
  const facts = [],
    warnings = [];
  let cursor = 0;
  async function worker() {
    while (cursor < chat.documents.length) {
      const index = cursor++,
        doc = chat.documents[index],
        batches = documentBatches(doc.chunks);
      updateRun(cid, run.id, (_, r) => {
        r.documentProgress ??= chat.documents.map((d) => ({
          id: d.id,
          name: d.name,
          pages: d.pages.length,
          status: "queued",
        }));
        Object.assign(r.documentProgress[index], {
          status: "reading",
          parts: batches.length,
          completedParts: 0,
        });
      });
      for (let i = 0; i < batches.length; i++) {
        signal?.throwIfAborted();
        event(
          cid,
          run.id,
          "整理经营数据",
          `${doc.name} · ${i + 1}/${batches.length}批`,
        );
        const response = await (
          modelService
            ? (messages, options) =>
                modelService.complete(messages, options, {
                  purpose: "operating-extraction",
                  documentId: doc.id,
                  batch: i + 1,
                })
            : llm
        )(operatingPartMessages({ doc, focus, metrics, batches, i }), {
          tools: [extractTool],
          force: "extractOperatingFacts",
          maxTokens: 6500,
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
            : AbortSignal.timeout(120000),
        });
        if (!modelService)
          updateRun(cid, run.id, (_, r) => (r.usage += response.usage || 0));
        const call = response.tool_calls?.find(
          (t) => t.function.name === "extractOperatingFacts",
        );
        if (!call) throw new Error("经营数据提取未返回结构化结果");
        const checked = validateOperatingFacts(
          JSON.parse(jsonrepair(call.function.arguments)),
          batches[i],
        );
        facts.push(
          ...checked.facts.map((f) => ({ ...f, documentName: doc.name })),
        );
        if (checked.rejected.length)
          warnings.push(
            `${doc.name}第${i + 1}批：${checked.rejected.length}项候选值未通过引文核对`,
          );
        updateRun(cid, run.id, (_, r) =>
          Object.assign(r.documentProgress[index], { completedParts: i + 1 }),
        );
      }
      updateRun(cid, run.id, (_, r) =>
        Object.assign(r.documentProgress[index], {
          status: "completed",
          processedPages: new Set(doc.chunks.map((c) => c.page)).size,
        }),
      );
      warnings.push(...(doc.warnings || []).map((w) => `${doc.name}：${w}`));
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(2, chat.documents.length) }, worker),
  );
  signal?.throwIfAborted();
  if (!facts.length)
    throw new Error(
      "未提取到可核对的经营指标。请指定少量指标，或补充含文字的报告。",
    );
  event(cid, run.id, "对齐指标名称", "核对单位、会计年度与重叠期披露值");
  let aligned = { facts, warnings: [] };
  try {
    aligned = await alignOperatingMetrics(facts, {
      signal,
      llm: modelService
        ? (messages, options) =>
            modelService.complete(messages, options, {
              purpose: "metric-alignment",
            })
        : llm,
    });
    updateRun(cid, run.id, (_, r) => {
      if (!modelService) r.usage += aligned.usage || 0;
      if (aligned.call)
        r.records.push({
          callId: aligned.call.id,
          actor: "model",
          name: "alignOperatingMetrics",
          args: aligned.call.function.arguments,
          result: { facts: aligned.facts.length, warnings: aligned.warnings },
          at: new Date().toISOString(),
        });
    });
  } catch (error) {
    signal?.throwIfAborted();
    aligned.warnings.push("名称归并未完成，保留原始名称分行：" + error.message);
  }
  const data = {
    ...alignOperatingFacts(aligned.facts),
    documents: chat.documents.map((d) => ({ id: d.id, name: d.name })),
    cacheKey: key,
    focus,
    facts,
    alignment: aligned.facts.map((f) => ({
      sourceId: f.sourceId,
      period: f.period,
      metric: f.metric,
      company: f.company,
      reason: f.alignmentReason,
      originalIdentity: f.originalIdentity,
    })),
    warnings: [...new Set([...warnings, ...aligned.warnings])],
    notes:
      "只覆盖本轮提取的指标；同名不同口径不强行合并。派生单季值保留公式，空白不代表零。LLM表头和业务口径仍需原文核对。",
  };
  const sourceIds = [...new Set(facts.map((f) => f.sourceId))];
  sourceIds.forEach((s) => seen.add(s));
  const card = addArtifact(
    cid,
    run.id,
    makeCard("worksheet", "经营数据底稿", data, sourceIds),
  );
  event(
    cid,
    run.id,
    "底稿已整理",
    `${data.rows.length}组指标 · ${data.periods.length}个期间 · ${data.conflicts}处冲突`,
  );
  return { cardId: card.id, ...summary(data) };
}
function summary(data) {
  return {
    metricCount: data.rows.length,
    periods: data.periods,
    conflicts: data.conflicts,
    warnings: data.warnings,
    note: "表格已显示，可点指标画图与下载。不要重复抄表；空缺及冲突需要补充报告或人工核对。",
    sourceIds: [...new Set(data.facts.map((f) => f.sourceId))].slice(0, 16),
    metrics: data.rows.map((r) => ({
      metric: r.metric,
      company: r.company,
      unit: r.unit,
      kind: r.kind,
      periods: Object.keys(r.cells),
    })),
  };
}
