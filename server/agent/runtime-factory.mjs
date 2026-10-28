import { randomUUID } from "node:crypto";
import { AgentLoop } from "./agent-loop.mjs";
/**
 * Composition factory for isolated, optionally nested agent runs. It creates no
 * role agents or delegation tools by default. assemble(scope) must supply fresh
 * stateful registry/memory ports; stateless LLM transport may be shared.
 */
export class AgentRuntimeFactory {
  constructor({
    assemble,
    allowChildren = false,
    maxDepth = 1,
    maxChildren = 1,
  }) {
    Object.assign(this, { assemble, allowChildren, maxDepth, maxChildren });
  }
  /** Application creates one runtime per run; no database or global mutable run state is owned here. */
  create({
    sessionId,
    runId = randomUUID(),
    parentRunId,
    categories,
    sourceMode,
    signal,
    depth = 0,
    maxSteps = 9,
    maxToolCalls = 32,
  } = {}) {
    const controller = new AbortController(),
      combined = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
    const scope = {
      sessionId,
      runId,
      parentRunId,
      categories: categories ? structuredClone(categories) : undefined,
      sourceMode,
      depth,
    };
    let used = false,
      childrenCreated = 0;
    return {
      scope: structuredClone(scope),
      /** Owner cancels this run and linked children; external side effects are not rolled back. */
      cancel: () => controller.abort(),
      /** Execute once with bounded configuration; configuration errors throw, AgentLoop outcomes are structured. */
      run: async (state = {}, config = {}) => {
        if (used) throw new Error("运行实例已使用，请创建新实例");
        used = true;
        if (config.maxSteps > maxSteps || config.maxToolCalls > maxToolCalls)
          throw new Error("不能扩大运行预算");
        if (
          config.recovery &&
          (config.recovery.maxSteps > maxSteps ||
            config.recovery.maxToolCalls > Math.max(1, maxToolCalls))
        )
          throw new Error("恢复预算超出运行范围");
        const dependencies = await this.assemble(structuredClone(scope), {
          signal: combined,
        });
        const upstream = dependencies.registry;
        const scopedRegistry = {
          list: async () =>
            (await upstream.list()).filter(
              (e) =>
                (!scope.categories || scope.categories.includes(e.category)) &&
                (!scope.sourceMode ||
                  !e.sourceModes ||
                  e.sourceModes.includes(scope.sourceMode)),
            ),
          invoke: async (name, args, metadata) => {
            if (!(await scopedRegistry.list()).some((e) => e.name === name))
              throw new Error("运行范围不允许调用此工具");
            return upstream.invoke(name, args, metadata);
          },
        };
        const loop = new AgentLoop({
          ...dependencies,
          registry: scopedRegistry,
        });
        return loop.run({
          ...config,
          state: {
            ...structuredClone(state),
            ...structuredClone(scope),
            task: {
              ...state.task,
              sourceMode: scope.sourceMode || state.task?.sourceMode,
            },
          },
          signal: combined,
          maxSteps: config.maxSteps ?? maxSteps,
          maxToolCalls: config.maxToolCalls ?? maxToolCalls,
        });
      },
      /** Reserve an isolated child scope; no role agent, tool or model is started automatically. */
      createChild: (options) => {
        if (!this.allowChildren || depth >= this.maxDepth)
          throw new Error("子运行未启用或已达到最大深度");
        if (childrenCreated >= this.maxChildren)
          throw new Error("已达到子运行数量上限");
        const selected = options.categories || scope.categories;
        if (
          scope.categories &&
          selected?.some((c) => !scope.categories.includes(c))
        )
          throw new Error("子运行不能扩大工具分类权限");
        const childMode = options.sourceMode || scope.sourceMode;
        if (
          scope.sourceMode &&
          scope.sourceMode !== "hybrid" &&
          childMode !== scope.sourceMode
        )
          throw new Error("子运行不能扩大资料范围");
        if (options.maxSteps > maxSteps || options.maxToolCalls > maxToolCalls)
          throw new Error("子运行不能扩大预算");
        childrenCreated++;
        return this.create({
          sessionId,
          runId: options.runId,
          parentRunId: runId,
          categories: selected,
          sourceMode: childMode,
          signal: combined,
          depth: depth + 1,
          maxSteps: options.maxSteps ?? maxSteps,
          maxToolCalls: options.maxToolCalls ?? maxToolCalls,
        });
      },
    };
  }
}
