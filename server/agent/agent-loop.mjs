import { abortable } from "./abortable.mjs";
import { parseDecision } from "./decision-parser.mjs";

/** Single explicit orchestration loop; depends on registry.list/invoke and injected ports only. */
export class AgentLoop {
  constructor({
    llm,
    registry,
    assembler,
    memory = {},
    trace,
    errorFeedback = (e) => ({
      error: e.message,
      ...(e.code ? { code: e.code } : {}),
    }),
    onEvent = () => {},
    onText = () => {},
    onUsage = () => {},
  }) {
    Object.assign(this, {
      llm,
      registry,
      assembler,
      memory,
      trace,
      errorFeedback,
      onEvent,
      onText,
      onUsage,
    });
  }
  /**
   * Runtime factory invokes a fresh run. Returns a structured outcome for every
   * exit; it does not create sessions, persist UI status or implement domain rules.
   * Recovery may provide one bounded replacement configuration, not another loop.
   */
  async run({
    state: input = {},
    signal,
    maxSteps = 9,
    maxToolCalls = 32,
    initialActions = [],
    phase = "research",
    stepOffset = 0,
    requireTerminal = false,
    recovery,
    llmOptions = {},
  } = {}) {
    const state = structuredClone(input);
    state.task ??= {};
    state.trajectory ??= [];
    let ports = { registry: this.registry, assembler: this.assembler },
      phaseSteps = 0,
      phaseCalls = 0,
      totalSteps = 0,
      totalCalls = 0,
      hostIndex = 0,
      recovered = false,
      recoveryUsed = false;
    let activeLLMOptions = { ...llmOptions };
    let stepLimit = maxSteps,
      callLimit = maxToolCalls,
      currentPhase = phase;
    const outcome = (reason, result, error) => ({
      runId: state.runId,
      parentRunId: state.parentRunId,
      reason,
      steps: totalSteps,
      toolCalls: totalCalls,
      phase: currentPhase,
      recovered: recovered && reason === "completed",
      recoveryAttempted: recoveryUsed,
      ...(result ? { result, summary: result.summary } : {}),
      ...(error
        ? {
            error: {
              code: error.code || error.name || "ERROR",
              message: error.message || String(error),
            },
          }
        : {}),
    });
    const checkpoint = async (step) => {
      state.progress = { step, toolCalls: phaseCalls };
      const assembled = await ports.assembler.build(structuredClone(state));
      await this.memory.checkpoint?.({
        messages: assembled.messages,
        trajectory: structuredClone(state.trajectory),
        step,
      });
    };
    const recover = async (failure) => {
      if (!recovery || recoveryUsed || signal?.aborted) return false;
      recoveryUsed = true;
      const next = await recovery.prepare(
        structuredClone(failure),
        structuredClone(state),
      );
      if (!next) return false;
      if (
        !Number.isInteger(next.maxSteps) ||
        next.maxSteps < 1 ||
        next.maxSteps > recovery.maxSteps ||
        !Number.isInteger(next.maxToolCalls) ||
        next.maxToolCalls < 1 ||
        next.maxToolCalls > recovery.maxToolCalls
      )
        throw new Error("恢复配置超出预先声明预算");
      const allowed = await ports.registry.list(),
        subset = await next.registry.list();
      if (
        !subset.length ||
        subset.some(
          (e) => !e.terminal || !allowed.some((old) => old.name === e.name),
        )
      )
        throw new Error("恢复阶段只能使用原范围内的交付工具");
      ports = { registry: next.registry, assembler: next.assembler };
      activeLLMOptions = { ...(next.llmOptions || {}) };
      currentPhase = "repair";
      stepLimit = next.maxSteps;
      callLimit = next.maxToolCalls;
      phaseSteps = 0;
      phaseCalls = 0;
      state.trajectory = [];
      state.phase = currentPhase;
      recovered = true;
      return true;
    };
    try {
      if (
        !Number.isInteger(maxSteps) ||
        maxSteps < 0 ||
        !Number.isInteger(maxToolCalls) ||
        maxToolCalls < 0
      )
        throw new Error("无效运行预算");
      // Host preflight and model rounds share this one loop and invocation path.
      for (;;) {
        if (signal?.aborted)
          return outcome(
            "cancelled",
            undefined,
            signal.reason || new Error("任务已取消"),
          );
        const host = hostIndex < initialActions.length;
        if (!host && phaseSteps >= stepLimit) {
          const failure = outcome(
            "budget_exhausted",
            undefined,
            Object.assign(
              new Error(
                "研究达到本轮预算，已保存数据和过程。请缩小问题继续研究。",
              ),
              { code: "BUDGET_EXHAUSTED" },
            ),
          );
          if (await recover(failure)) continue;
          return failure;
        }
        let span,
          roundError,
          roundStatus = "continued",
          completed,
          hostFailed = false,
          budgetBlocked = false;
        const step = host ? 0 : stepOffset + totalSteps + 1;
        try {
          span = await this.trace?.beginStep({
            step,
            phase: host ? "preflight" : currentPhase,
            actor: host ? "host" : "model",
          });
          state.phase = currentPhase;
          state.limits = { maxSteps: stepLimit, maxToolCalls: callLimit };
          state.progress = { step, toolCalls: phaseCalls };
          if (!host)
            state.trajectory.push({ type: "round", step: phaseSteps + 1 });
          const descriptors = await ports.registry.list(),
            terminal = descriptors.find((e) => e.terminal);
          state.availableTools = structuredClone(descriptors);
          const assembled = await ports.assembler.build(structuredClone(state));
          let response, decision;
          if (host) {
            const requested = initialActions[hostIndex++];
            const call = {
              id: requested.id || "host-source-ingestion",
              actor: "host",
              function: {
                name: requested.name,
                arguments: JSON.stringify(requested.args || {}),
              },
            };
            response = { actor: "host", tool_calls: [call] };
            this.onEvent("preparing", { name: requested.name });
          } else {
            phaseSteps++;
            totalSteps++;
            this.onEvent("thinking", {
              step,
              phase: currentPhase,
              finishing:
                phaseSteps >= stepLimit - 2 || phaseCalls >= callLimit - 1,
            });
            response = await abortable(
              () =>
                this.llm(assembled.messages, {
                  ...activeLLMOptions,
                  signal,
                  tools: assembled.tools,
                  force: assembled.force,
                  onText: (text) => {
                    if (!signal?.aborted) this.onText(text);
                  },
                }),
              signal,
            );
          }
          await span?.decision(response);
          if (!host) this.onUsage(response?.usage || 0);
          decision = parseDecision(response);
          if (signal?.aborted) {
            roundStatus = "cancelled";
            return outcome(
              "cancelled",
              undefined,
              signal.reason || new Error("任务已取消"),
            );
          }
          let projected = response || {};
          if (decision.kind === "finish") {
            if (!requireTerminal) {
              completed = { done: true, summary: decision.summary };
            } else if (
              terminal &&
              decision.output &&
              typeof decision.output === "object" &&
              !Array.isArray(decision.output)
            ) {
              const call = {
                id: "declared-finish-" + step,
                actor: "model_finish",
                function: {
                  name: terminal.name,
                  arguments: JSON.stringify(decision.output),
                },
              };
              decision = {
                ...decision,
                kind: "act",
                actions: [{ call, args: decision.output }],
              };
              projected = { ...response, tool_calls: [call] };
            } else decision = { ...decision, kind: "invalid" };
          }
          if (!host)
            state.trajectory.push({
              type: "decision",
              response: projected,
              completed: !!completed,
            });
          for (const action of decision.actions || []) {
            if (signal?.aborted) break;
            const { call, args } = action;
            const startedAt = new Date().toISOString(),
              start = performance.now();
            let result, error;
            try {
              if (action.error)
                throw Object.assign(new Error(action.error.message), {
                  code: action.error.code,
                });
              const descriptor = descriptors.find(
                (e) => e.name === call.function?.name,
              );
              if (!descriptor) throw new Error("未知或当前模式不可用的工具");
              if (completed) result = { skipped: true, reason: "本轮已交付" };
              else if (phaseCalls >= callLimit) {
                budgetBlocked = true;
                result = {
                  error: "工具预算已用完，请基于现有证据交付并保留缺口",
                  code: "BUDGET_EXHAUSTED",
                };
              } else {
                phaseCalls++;
                totalCalls++;
                this.onEvent("acting", {
                  name: call.function.name,
                  phase: currentPhase,
                  terminal: !!descriptor.terminal,
                });
                result = await abortable(
                  () =>
                    ports.registry.invoke(call.function.name, args, {
                      callId: call.id,
                      signal,
                    }),
                  signal,
                );
                if (result?.done && descriptor.terminal) completed = result;
              }
            } catch (e) {
              error = e;
              result = this.errorFeedback(e);
              this.onEvent("tool_error", {
                name: call.function?.name,
                error: e.message,
              });
              if (host) hostFailed = true;
            }
            const timing = { startedAt, durationMs: performance.now() - start };
            await span?.observation(call, args, result, timing, error);
            await this.memory.observe?.(call, result, { step, ...timing });
            state.trajectory.push(
              host
                ? { type: "preflight", result }
                : { type: "observation", call, result },
            );
          }
          await checkpoint(host ? 0 : step);
          if (signal?.aborted) {
            roundStatus = "cancelled";
            return outcome(
              "cancelled",
              undefined,
              signal.reason || new Error("任务已取消"),
            );
          }
          if (completed) {
            roundStatus = "completed";
            return outcome("completed", completed);
          }
          if (hostFailed)
            throw new Error(
              "前置工具失败：" +
                (state.trajectory.at(-1)?.result?.error || "未能读取材料"),
            );
          if (host && budgetBlocked)
            throw Object.assign(new Error("前置行动达到工具预算"), {
              code: "BUDGET_EXHAUSTED",
            });
        } catch (error) {
          roundError = error;
          roundStatus = signal?.aborted ? "cancelled" : "failed";
        } finally {
          await span?.end({ status: roundStatus, error: roundError });
        }
        if (roundError) {
          const failure = outcome(
            signal?.aborted
              ? "cancelled"
              : roundError.code === "BUDGET_EXHAUSTED"
                ? "budget_exhausted"
                : "failed",
            undefined,
            roundError,
          );
          if (await recover(failure)) continue;
          return failure;
        }
      }
    } catch (error) {
      return outcome(
        signal?.aborted ? "cancelled" : "failed",
        undefined,
        error,
      );
    }
  }
}
