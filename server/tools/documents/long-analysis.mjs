import { documentPartMessages } from "../../context/extraction-context.mjs";
import { toolEffects } from "../../research/effects.mjs";
export { analyzeTool } from "../task-schemas.mjs";
/** Whole-document map analysis. Every extracted text chunk is sent to the LLM,
 * in bounded long-context batches; validated evidence is retained with PDF pages. */
import { createHash } from "node:crypto";
import { jsonrepair } from "jsonrepair";
import { model } from "../../llm/client.mjs";
import { tool } from "../definition.mjs";
import { searchableText } from "./documents.mjs";
import { now } from "../../memory/store.mjs";
import { makeCard } from "../../research/artifacts.mjs";
const str = { type: "string" };
const partTool = tool(
  "analyzeDocumentPart",
  "只根据本批原文分析，返回可核验引文和直接披露指标，不计算、不补造。",
  {
    findings: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        properties: { topic: str, text: str, quote: str, sourceId: str },
        required: ["topic", "text", "quote", "sourceId"],
        additionalProperties: false,
      },
    },
    metrics: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        properties: {
          metric: {
            type: "string",
            enum: [
              "revenue",
              "grossProfit",
              "attributableProfit",
              "grossMargin",
              "operatingCashFlow",
              "netMargin",
            ],
          },
          period: str,
          value: { type: "number" },
          rawValue: str,
          unit: str,
          currency: str,
          scope: str,
          sourceId: str,
        },
        required: [
          "metric",
          "period",
          "value",
          "rawValue",
          "unit",
          "currency",
          "scope",
          "sourceId",
        ],
        additionalProperties: false,
      },
    },
  },
  ["findings", "metrics"],
);
export function documentBatches(chunks, maxChars = 60000) {
  const batches = [];
  let batch = [],
    size = 0;
  for (const chunk of chunks) {
    if (batch.length && size + chunk.text.length > maxChars) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(chunk);
    size += chunk.text.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
const normalized = (s) => searchableText(s).replace(/[\s,，]/g, "");
export function validatePart(data, chunks) {
  const findings = [],
    metrics = [],
    rejected = [];
  for (const f of data.findings || []) {
    const source = chunks.find((c) => c.id === f.sourceId);
    if (
      !source ||
      normalized(f.quote || "").length < 8 ||
      !normalized(source.text).includes(normalized(f.quote))
    ) {
      rejected.push("引文未匹配原文");
      continue;
    }
    findings.push({ ...f, documentId: source.documentId, page: source.page });
  }
  for (const m of data.metrics || []) {
    const source = chunks.find((c) => c.id === m.sourceId),
      raw = String(m.rawValue || "")
        .normalize("NFKC")
        .replace(/[\s,，%％]/g, ""),
      number = Number(raw.replace(/^\((.*)\)$/, "-$1"));
    if (
      !source ||
      !raw ||
      !normalized(source.text).includes(
        normalized(m.rawValue).replace(/[%％]/g, ""),
      ) ||
      !Number.isFinite(m.value) ||
      number !== m.value ||
      !/^20\d{2}(?:年度|年)?$/.test(m.period) ||
      !String(m.unit || "").trim() ||
      !String(m.scope || "").trim()
    ) {
      rejected.push("指标数字、来源或年度口径未通过核对");
      continue;
    }
    metrics.push({
      ...m,
      period: m.period.match(/20\d{2}/)[0],
      documentId: source.documentId,
      page: source.page,
    });
  }
  return { findings, metrics, rejected };
}
export async function analyzeUploadedDocuments(
  { cid, run, seen, signal, effects, modelService },
  focus,
) {
  const { getProject, putProject, event, updateRun, addArtifact } =
    toolEffects(effects);
  const initial = getProject(cid);
  if (!initial.documents.length) throw new Error("请先上传报告");
  const documents = initial.documents;
  const results = new Array(documents.length);
  let cursor = 0;
  const progress = (index, patch) =>
    updateRun(cid, run.id, (_, r) => {
      r.documentProgress ??= documents.map((d) => ({
        id: d.id,
        name: d.name,
        status: "queued",
        pages: d.pages.length,
      }));
      Object.assign(r.documentProgress[index], patch);
    });
  async function worker() {
    while (cursor < documents.length) {
      const index = cursor++,
        doc = documents[index],
        cacheKey = createHash("sha256")
          .update(doc.hash + ":long-analysis-v1")
          .digest("hex"),
        cached = getProject(cid).documentAnalysisCache?.[cacheKey];
      signal?.throwIfAborted();
      if (cached) {
        results[index] = cached;
        progress(index, {
          status: "completed",
          cached: true,
          parts: cached.parts,
          processedPages: cached.processedPages,
        });
        continue;
      }
      const batches = documentBatches(doc.chunks);
      const findings = [],
        metrics = [],
        rejected = [];
      progress(index, {
        status: "reading",
        parts: batches.length,
        completedParts: 0,
      });
      for (let part = 0; part < batches.length; part++) {
        signal?.throwIfAborted();
        const chunks = batches[part];
        event(
          cid,
          run.id,
          "长文阅读",
          doc.name +
            " · " +
            (part + 1) +
            "/" +
            batches.length +
            "批 · " +
            chunks[0].page +
            "–" +
            chunks.at(-1).page +
            "页",
        );
        const response = await (
          modelService
            ? (messages, options) =>
                modelService.complete(messages, options, {
                  purpose: "document-part",
                  documentId: doc.id,
                  batch: part + 1,
                })
            : model
        )(documentPartMessages({ doc, focus, part, batches, chunks }), {
          tools: [partTool],
          force: "analyzeDocumentPart",
          maxTokens: 2600,
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
            : AbortSignal.timeout(120000),
        });
        if (!modelService)
          updateRun(cid, run.id, (_, r) => (r.usage += response.usage || 0));
        const call = response.tool_calls?.find(
          (t) => t.function.name === "analyzeDocumentPart",
        );
        if (!call) throw new Error("长文分析未返回结构化结果");
        const checked = validatePart(
          JSON.parse(jsonrepair(call.function.arguments)),
          chunks,
        );
        findings.push(...checked.findings);
        metrics.push(...checked.metrics);
        rejected.push(...checked.rejected);
        progress(index, {
          completedParts: part + 1,
          processedPages: new Set(
            doc.chunks
              .filter((c) => c.page <= chunks.at(-1).page)
              .map((c) => c.page),
          ).size,
        });
      }
      const result = {
        documentId: doc.id,
        name: doc.name,
        hash: doc.hash,
        fromMaterials: true,
        processedPages: new Set(doc.chunks.map((c) => c.page)).size,
        pages: doc.pages.length,
        readChars: doc.chunks.reduce((n, c) => n + c.text.length, 0),
        parts: batches.length,
        findings,
        metrics,
        warnings: [
          ...doc.warnings,
          ...(rejected.length
            ? [rejected.length + "项候选引文或指标未通过原文匹配，已排除"]
            : []),
        ],
        at: now(),
      };
      const fresh = getProject(cid);
      fresh.documentAnalysisCache ??= {};
      fresh.documentAnalysisCache[cacheKey] = result;
      putProject(fresh);
      results[index] = result;
      progress(index, {
        status: "completed",
        processedPages: result.processedPages,
      });
    }
  }
  await Promise.all([worker(), worker()]);
  signal?.throwIfAborted();
  for (const data of results) {
    const sourceIds = [
      ...new Set([...data.findings, ...data.metrics].map((f) => f.sourceId)),
    ];
    sourceIds.forEach((id) => seen.add(id));
    const existing = getProject(cid).cards.find(
      (c) => c.kind === "documentAnalysis" && c.data.hash === data.hash,
    );
    if (!existing)
      addArtifact(
        cid,
        run.id,
        makeCard(
          "documentAnalysis",
          data.name,
          { ...data, findings: data.findings.slice(0, 16) },
          sourceIds,
        ),
      );
  }
  return {
    origin: "uploaded_documents",
    documents: results.map((d) => ({
      ...d,
      findings: d.findings.slice(0, 16),
    })),
    note: "已逐批阅读全部可提取文字；无文字的扫描页未阅读。每条引文和指标经过原文匹配，但语义、期间和表格列对应仍需人工核对。外部数据不是这些报告的内容。",
  };
}
