import { AgentLoop } from "./agent-loop.mjs";
import {
  legacyContextAssembler,
  contextState,
} from "../context/context-assembler.mjs";
/**
 * Compatibility adapter for old integrations/tests. New application assembly uses
 * AgentLoop directly. All control flow remains inside AgentLoop; this adapter
 * only translates ports and converts non-success outcomes to legacy exceptions.
 */
export async function runAgentLoop(options) {
  const {
    tools,
    messages = [],
    state,
    maxSteps = 9,
    maxToolCalls = 32,
    ...rest
  } = options;
  const registry = options.registry || {
    list: () =>
      tools.schemas.map((s) => ({
        ...s.function,
        terminal: s.function.name === tools.finish.function.name,
      })),
    invoke: (...args) => tools.execute(...args),
  };
  const assembler =
    options.assembler || legacyContextAssembler(messages, tools);
  const initial = contextState(state, messages, { maxSteps, maxToolCalls });
  const loop = new AgentLoop({
    ...rest,
    registry,
    assembler,
    errorFeedback: tools?.errorFeedback || options.errorFeedback,
  });
  const outcome = await loop.run({
    state: initial,
    signal: options.signal,
    maxSteps,
    maxToolCalls,
    requireTerminal: true,
    initialActions: tools?.requiredFirst
      ? [
          {
            name: tools.requiredFirst.function.name,
            args: { focus: initial.task.goal },
          },
        ]
      : [],
  });
  if (outcome.reason !== "completed") {
    const error = Object.assign(
      new Error(outcome.error?.message || outcome.reason),
      { code: outcome.error?.code, outcome },
    );
    throw error;
  }
  return {
    result: outcome.result,
    steps: outcome.steps,
    toolCalls: outcome.toolCalls,
  };
}
