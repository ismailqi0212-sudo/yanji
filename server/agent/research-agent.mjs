import { ContextAssembler } from "../context/context-assembler.mjs";
import { researchPolicy } from "../context/research-policy.mjs";
import { SessionMemoryProvider } from "../memory/providers/session-memory.mjs";
import { NullLongTermMemoryProvider } from "../memory/providers/null-long-term-memory.mjs";
import { sessionStore, traceForRun } from "../trace/runtime-store.mjs";
import { routeTask } from "./router.mjs";
import { prepareRepair } from "./repair-delivery.mjs";
/** Application assembly: inject LLM, tools and memory into the generic loop. */
import { getProject, id, now } from "../memory/store.mjs";
import {
  updateRun,
  event,
  saveCheckpoint,
  recordObservation,
} from "../memory/run-state.mjs";
import { initialWorkingMemory } from "../memory/context.mjs";
import { runtimeModel } from "../llm/runtime-model.mjs";
import { registerRun, cancelRun } from "./run-controls.mjs";
import { createResearchTools } from "../tools/registry.mjs";
import { AgentRuntimeFactory } from "./runtime-factory.mjs";
export { addSource } from "../memory/run-state.mjs";

export function start(cid, question, options = {}) {
  const chat = getProject(cid);
  if (chat.runs.some((run) => run.status === "running"))
    throw new Error("请先等待当前任务结束或停止");
  const text = String(question || "")
    .trim()
    .slice(0, 8000);
  if (!text) throw new Error("请输入研究问题");
  if (
    options.mode === "revision" &&
    !chat.report?.sections.some((section) => section.id === options.sectionId)
  )
    throw new Error("章节不存在");
  const user = { id: id(), role: "user", text, at: now(), cardIds: [] };
  const assistant = {
    id: id(),
    role: "assistant",
    text: "",
    at: now(),
    cardIds: [],
  };
  const route = routeTask(chat, text, options);
  const run = {
    id: id(),
    messageId: assistant.id,
    question: text,
    mode: options.mode || "research",
    sourceMode: route.sourceMode,
    route,
    sectionId: options.sectionId,
    baseReportVersion: chat.report?.version,
    at: now(),
    status: "running",
    stage: "planning",
    round: 0,
    events: [],
    records: [],
    usage: 0,
  };
  sessionStore.createRun(cid, run, user, assistant);
  const controller = new AbortController();
  const release = registerRun(run.id, controller);
  execute(cid, run, controller)
    .catch(() => {})
    .finally(release);
  return run;
}
export function stop(cid, rid) {
  cancelRun(rid);
  updateRun(cid, rid, (chat, run) => {
    if (run.status === "running") {
      run.status = "cancelled";
      run.stage = "stopped";
      if (chat.reportJob?.runId === rid)
        Object.assign(chat.reportJob, {
          status: "cancelled",
          stage: "stopped",
          error: "任务已停止",
        });
      run.error = "已停止，已取得的数据保留";
      run.termination = { reason: "cancelled", at: now() };
    }
  });
}
async function execute(cid, run, controller) {
  const timer = setTimeout(
    () => controller.abort(),
    run.route?.timeoutMs || 420000,
  );
  try {
    const initial = getProject(cid),
      working = initialWorkingMemory(initial, run);
    const modelService = runtimeModel(
      cid,
      run.id,
      controller.signal,
      "agent-decision",
    );
    const context = {
      cid,
      run,
      signal: controller.signal,
      modelService,
      ...working,
    };
    const tools = createResearchTools(context);
    const assembler = new ContextAssembler({
      systemPolicy: () => researchPolicy(run),
      shortTermMemory: new SessionMemoryProvider({
        loadSession: () => structuredClone(initial),
        run,
      }),
      longTermMemory: new NullLongTermMemoryProvider(),
      toolRegistry: tools,
    });
    const factory = new AgentRuntimeFactory({
      assemble: async () => ({
        llm: (messages, options) => modelService.complete(messages, options),
        registry: tools,
        errorFeedback: tools.errorFeedback,
        assembler,
        trace: traceForRun(cid, run.id),
        memory: {
          observe: (call, result, metadata) =>
            recordObservation(cid, run.id, call, result, metadata),
          checkpoint: (state) =>
            saveCheckpoint(cid, run.id, { ...state, ...working }),
        },
        onEvent: (type, data) => {
          if (type === "thinking") {
            event(
              cid,
              run.id,
              data.step === 1 ? "理解研究任务" : "读取观察并继续研究",
              "第" + data.step + "轮",
            );
            updateRun(
              cid,
              run.id,
              (_, r) =>
                (r.stage = data.step === 1 ? "planning" : "researching"),
            );
          }
          if (type === "acting")
            updateRun(
              cid,
              run.id,
              (_, r) => (r.stage = data.terminal ? "checking" : "researching"),
            );
          if (type === "tool_error")
            event(cid, run.id, "工具反馈，继续补查", data.error);
        },
        onText: (text) => updateRun(cid, run.id, (_, r) => (r.liveText = text)),
        onUsage: (tokens) =>
          updateRun(cid, run.id, (_, r) => {
            // Usage is recorded exactly once by ModelService.
            r.liveText = "";
          }),
      }),
    });
    const runtime = factory.create({
      sessionId: cid,
      runId: run.id,
      sourceMode: run.sourceMode,
      signal: controller.signal,
      maxSteps: run.route.maxSteps,
      maxToolCalls: run.route.maxToolCalls,
    });
    const outcome = await runtime.run(
      { task: { goal: run.question, sourceMode: run.sourceMode } },
      {
        requireTerminal: true,
        initialActions: tools.requiredFirst
          ? [
              {
                name: tools.requiredFirst.function.name,
                args: { focus: run.question },
              },
            ]
          : [],
        recovery: {
          maxSteps: 2,
          maxToolCalls: 2,
          prepare: (failure) => {
            if (run.mode === "revision" || failure.reason === "cancelled")
              return null;
            const stored = getProject(cid).runs.find((r) => r.id === run.id);
            if (
              !stored.records.some(
                (t) => t.name === "deliverResearch" && t.result?.error,
              )
            )
              return null;
            return prepareRepair({ ...context, tools });
          },
        },
      },
    );
    if (outcome.reason !== "completed")
      throw Object.assign(new Error(outcome.error?.message || "研究未完成"), {
        code: outcome.error?.code,
        outcome,
      });
    sessionStore.finish(cid, run.id, {
      reason: "completed",
      steps: outcome.steps,
      toolCalls: outcome.toolCalls,
      recoveredAfterValidation: outcome.recovered,
    });
    updateRun(cid, run.id, (chat, r) => {
      if (r.status !== "running") return;
      r.status = "completed";
      r.stage = run.mode === "revision" ? "awaiting_confirmation" : "completed";
      r.finishedAt = now();
      r.liveText = "";
      if (outcome.recovered) {
        r.recoveredAfterValidation = true;
        r.error = null;
      }
      chat.messages.find((message) => message.id === r.messageId).text =
        outcome.result.summary || "研究完成。";
      r.events.push({
        at: now(),
        label:
          run.mode === "revision"
            ? "修改建议已生成，等待确认"
            : outcome.recovered
              ? "已核对并修复交付"
              : "研究完成",
        detail: outcome.steps + "轮 · " + outcome.toolCalls + "次工具调用",
      });
    });
  } catch (error) {
    sessionStore.finish(cid, run.id, {
      reason: controller.signal.aborted
        ? "cancelled"
        : error.code === "BUDGET_EXHAUSTED"
          ? "budget_exhausted"
          : error.outcome?.reason || "failed",
      error: error.message,
      steps: error.outcome?.steps,
      toolCalls: error.outcome?.toolCalls,
      phase: error.outcome?.phase,
      recoveryAttempted: error.outcome?.recoveryAttempted,
    });
    updateRun(cid, run.id, (_, r) => {
      if (r.status === "running") {
        r.status = controller.signal.aborted ? "cancelled" : "failed";
        r.stage = "stopped";
        r.error = controller.signal.aborted
          ? "任务已停止或超时"
          : error.message;
        r.finishedAt = now();
        r.liveText = "";
      }
    });
  } finally {
    clearTimeout(timer);
  }
}
