import { AgentRuntimeFactory } from "../agent/runtime-factory.mjs";
import { registerRun } from "../agent/run-controls.mjs";
import { ToolRegistry } from "../tools/tool-registry.mjs";
import { reportTool } from "./report-schema.mjs";
import { runtimeModel } from "../llm/runtime-model.mjs";
import { sessionStore, traceForRun } from "../trace/runtime-store.mjs";
import { id, now } from "../memory/store.mjs";

/** Writer supplies domain validation/commit and context ports. Owns report run lifecycle, never financial rules or another retry loop. */
export async function runReport({
  cid,
  mode,
  assembler,
  execute,
  maxTokens,
  signal,
  transport,
  onEvent = () => {},
}) {
  const run = {
    id: id(),
    mode,
    question: mode === "report" ? "编成研报" : "修改章节",
    at: now(),
    status: "running",
    stage: "writing",
    round: 0,
    events: [],
    records: [],
    usage: 0,
  };
  sessionStore.createRun(cid, run);
  const controller = new AbortController(),
    release = registerRun(run.id, controller);
  const combined = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const service = runtimeModel(cid, run.id, combined, mode, transport);
  const registry = new ToolRegistry({
    execution: {
      async run({ execute, callId }) {
        try {
          return await execute({ callId });
        } catch (error) {
          sessionStore.recordToolVerification(cid, run.id, {
            callId,
            name: "writeReport",
            status:
              error.code === "VERIFICATION_REJECTED" ? "rejected" : "error",
            error: { code: error.code || error.name, message: error.message },
          });
          throw error;
        }
      },
    },
    entries: [
      {
        ...reportTool.function,
        category: "delivery",
        terminal: true,
        preconditions: ["confirmed-materials"],
        produces: [mode === "report" ? "report-version" : "section-proposal"],
        load: async () => async (args, context) =>
          execute(args, { ...context, runId: run.id, signal: combined }),
      },
    ],
  });
  try {
    onEvent("started", { runId: run.id });
    const factory = new AgentRuntimeFactory({
      assemble: async () => ({
        llm: (messages, options) => service.complete(messages, options),
        registry,
        assembler: assembler(registry),
        trace: traceForRun(cid, run.id),
        errorFeedback: (error) => ({
          error: error.message,
          code: error.code,
          instruction:
            "删除无依据数字，复制computed中已有display，不心算。重新完整输出writeReport。",
        }),
        memory: {
          observe: (call, result, metadata) =>
            sessionStore.commitObservation(cid, run.id, call, result, metadata),
          checkpoint: (state) => sessionStore.checkpoint(cid, run.id, state),
        },
        onEvent,
      }),
    });
    const runtime = factory.create({
      sessionId: cid,
      runId: run.id,
      signal: combined,
      maxSteps: 2,
      maxToolCalls: 2,
    });
    const outcome = await runtime.run(
      { task: { goal: run.question } },
      { phase: mode, requireTerminal: true, llmOptions: { maxTokens } },
    );
    if (outcome.reason !== "completed") {
      const stored = sessionStore.load(cid, run.id);
      const last = stored.records.findLast((r) => r.result?.error)?.result;
      throw Object.assign(
        new Error(
          outcome.error?.message && outcome.reason !== "budget_exhausted"
            ? outcome.error.message
            : last?.error || "报告未通过校验，请重试",
        ),
        { code: last?.code || outcome.error?.code, outcome },
      );
    }
    sessionStore.finish(cid, run.id, {
      reason: "completed",
      steps: outcome.steps,
      toolCalls: outcome.toolCalls,
    });
    sessionStore.updateRun(cid, run.id, (_, r) =>
      Object.assign(r, {
        status: "completed",
        stage: "completed",
        finishedAt: now(),
      }),
    );
    return outcome.result;
  } catch (error) {
    sessionStore.finish(cid, run.id, {
      reason: combined.aborted
        ? "cancelled"
        : error.outcome?.reason || "failed",
      error: error.message,
    });
    sessionStore.updateRun(cid, run.id, (_, r) =>
      Object.assign(r, {
        status: combined.aborted ? "cancelled" : "failed",
        stage: "stopped",
        error: error.message,
        finishedAt: now(),
      }),
    );
    throw error;
  } finally {
    release();
  }
}
