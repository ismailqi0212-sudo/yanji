/**
 * Sole application registration catalog. Descriptions are import-safe; business
 * modules load only on invoke. Add a descriptor+loader here to add an app tool.
 * Contracts below are planner metadata; they do not replace business validation.
 */
import { financialSchemas } from "./financial-schemas.mjs";
import { finishTool, otherTools } from "./schemas.mjs";
import {
  worksheetTool,
  analyzeTool,
  planTool,
  gapTool,
  readReportTool,
  revisionTool,
} from "./task-schemas.mjs";

/** Lazy provider factory; per-invocation workspace owns its rollback-safe query cache. */
function financialLoader(name) {
  return async (context) => {
    const { createFinancialTools } = await import("./financial/providers.mjs");
    return (args, invocation = context) =>
      createFinancialTools(invocation).execute(name, args);
  };
}
/** Lazy legacy domain adapter; no loop/prompt knowledge and no eager DB initialization. */
const domainLoader = (name) => async (context) => {
  const handlers = await import("./research-handlers.mjs");
  const handler = handlers["handle_" + name];
  if (typeof handler !== "function") throw new Error("工具实现不存在：" + name);
  return (args, invocation = context) => handler(invocation, args);
};
const allModes = ["research", "revision"];
const allSources = ["documents", "external", "hybrid"];
/** Package a provider schema with policy, optional skill contracts and implementation factory. */
function entry(schema, metadata) {
  const { name, description, parameters } = schema.function;
  return {
    name,
    description,
    parameters,
    sourceModes: allSources,
    modes: allModes,
    preconditions: [],
    produces: [],
    load: domainLoader(name),
    ...metadata,
  };
}
const byName = new Map(otherTools.map((s) => [s.function.name, s]));

export const researchToolCatalog = [
  ...financialSchemas.map((s) =>
    entry(s, {
      category: "data",
      sourceModes: ["external", "hybrid"],
      preconditions: ["company.identifier"],
      produces: ["source.external", "artifact.financial-data"],
      load: financialLoader(s.function.name),
    }),
  ),
  entry(byName.get("getCompanyFilings"), {
    category: "data",
    sourceModes: ["external", "hybrid"],
    preconditions: ["company.identifier"],
    produces: ["source.filing-directory", "artifact.filings"],
  }),
  entry(byName.get("findCompany"), {
    category: "data",
    sourceModes: ["external", "hybrid"],
    produces: ["company.identifier"],
  }),
  entry(byName.get("searchFilings"), {
    category: "data",
    sourceModes: ["documents", "hybrid"],
    preconditions: ["session.documents"],
    produces: ["source.document-chunk"],
  }),
  entry(byName.get("readPage"), {
    category: "data",
    sourceModes: ["documents", "hybrid"],
    preconditions: ["session.documents", "document.page"],
    produces: ["source.document-chunk"],
  }),
  entry(analyzeTool, {
    category: "analysis",
    sourceModes: ["documents", "hybrid"],
    bootstrap: "documents",
    preconditions: ["session.documents"],
    produces: ["artifact.document-analysis", "source.document-chunk"],
  }),
  entry(worksheetTool, {
    category: "analysis",
    sourceModes: ["documents", "hybrid"],
    bootstrap: "operating-metrics",
    preconditions: ["session.documents"],
    produces: ["artifact.worksheet", "source.document-chunk"],
  }),
  entry(byName.get("calculate"), {
    category: "verification",
    preconditions: ["evidence.observed"],
    produces: ["calculation.verified"],
  }),
  entry(byName.get("chartFromFilings"), {
    category: "analysis",
    sourceModes: ["documents", "hybrid"],
    preconditions: ["session.documents"],
    produces: ["artifact.chart", "source.document-chunk"],
  }),
  entry(byName.get("createChart"), {
    category: "analysis",
    preconditions: ["source.financial-series.observed"],
    produces: ["artifact.chart"],
  }),
  entry(byName.get("createScenario"), {
    category: "analysis",
    preconditions: ["source.annual-financials.observed"],
    produces: ["artifact.scenario", "source.user-assumptions"],
  }),
  entry(planTool, { category: "planning", produces: ["research.plan"] }),
  entry(gapTool, {
    category: "planning",
    preconditions: ["research.plan"],
    produces: ["research.gap-update"],
  }),
  entry(readReportTool, {
    category: "data",
    modes: ["revision"],
    preconditions: ["report.exists"],
    produces: ["report.snapshot"],
  }),
  entry(revisionTool, {
    category: "delivery",
    modes: ["revision"],
    terminal: true,
    preconditions: ["report.version-matched", "evidence.observed"],
    produces: ["artifact.pending-revision"],
  }),
  entry(finishTool, {
    category: "delivery",
    modes: ["research"],
    terminal: true,
    preconditions: ["evidence.observed"],
    produces: ["research.answer", "artifact.findings"],
  }),
];

/** Lookup for compatibility routing; it reads registration metadata rather than a second allowlist. */
export function registeredTool(name) {
  return researchToolCatalog.find((e) => e.name === name);
}

/** Application-specific schema configuration stays with registration, outside Registry/Loop. */
export function createResearchToolCatalog(context) {
  return researchToolCatalog.map((entry) => {
    if (entry.name !== finishTool.function.name) return entry;
    const configured = {
      ...entry,
      parameters: structuredClone(entry.parameters),
    };
    configured.parameters.properties.findings.maxItems =
      context.run?.route?.maxFindings || 5;
    return configured;
  });
}
