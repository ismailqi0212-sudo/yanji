import { ToolExecutionPipeline } from "../research/result-committer.mjs";
import { sessionStore } from "../trace/runtime-store.mjs";
import { ToolRegistry, modelTool } from "./tool-registry.mjs";
import { createResearchToolCatalog } from "./catalog.mjs";
import { getProject } from "../memory/store.mjs";

/**
 * Runtime composition/compatibility adapter. Loop keeps its current tools port
 * until step 6; discovery and execution both use the same ToolRegistry below.
 * This adapter neither implements business handlers nor writes session state.
 */
export function createResearchTools(context) {
  const { cid, run, calculations } = context;
  const runtimeContext = { ...context, financialCache: new Set() };
  const execution = new ToolExecutionPipeline({
    store: sessionStore,
    context: runtimeContext,
    verifier: context.verifier,
    publishMemory: (memory) => {
      context.seen.clear();
      for (const id of memory.seen) context.seen.add(id);
      calculations.splice(
        0,
        calculations.length,
        ...structuredClone(memory.calculations),
      );
      runtimeContext.financialCache.clear();
      for (const key of memory.financialCache)
        runtimeContext.financialCache.add(key);
    },
  });
  const entries = createResearchToolCatalog(context);
  const policy = {
    sourceMode: run.route?.sourceMode || run.sourceMode,
    mode:
      run.mode === "revision" || run.route?.intent === "revision"
        ? "revision"
        : "research",
    categories: context.categories,
  };
  const registry = new ToolRegistry({
    entries,
    execution,
    context: runtimeContext,
    policy,
  });
  const enabled = registry.list();
  const terminal = enabled.find((e) => e.terminal);
  if (!terminal)
    throw new Error("当前工具分组缺少交付工具，请包含delivery分类");
  const needsDocuments =
    getProject(cid).documents.length && policy.sourceMode !== "external";
  const bootstrap = needsDocuments;
  const first = needsDocuments
    ? enabled.find((e) => e.bootstrap && e.bootstrap === run.route?.skillId) ||
      enabled.find((e) => e.bootstrap === "documents")
    : null;
  if (bootstrap && !first)
    throw new Error("当前工具分组缺少上传材料前置读取能力");
  return {
    list: (filters) => registry.list(filters),
    invoke: (name, args, metadata) => registry.invoke(name, args, metadata),
    schemas: enabled.map(modelTool),
    requiredFirst: first ? modelTool(first) : undefined,
    finish: modelTool(terminal),
    execute: (name, args, metadata) => registry.invoke(name, args, metadata),
    errorFeedback: (error) => ({
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.code === "VERIFICATION_REJECTED"
        ? { status: "rejected", verification: { accepted: false } }
        : {}),
      ...(/百分比/.test(error.message)
        ? {
            calculated: calculations.map((c) => ({
              id: c.id,
              display: c.display,
            })),
            instruction:
              "复制computed或calculate的display，不心算、不自设阈值。若是两个已披露百分比相减的调整值，先calculate subtract；否则删除未核实数字，不要重复提交同一错误。",
          }
        : {}),
    }),
  };
}
