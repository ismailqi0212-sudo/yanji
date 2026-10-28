import { randomUUID } from "node:crypto";
import { abortable } from "../agent/abortable.mjs";

/** Runtime injects transport and ledger. Owns scoped model IO/usage, never prompts, tools or business commits. */
export class ModelService {
  constructor({ transport, recorder, scope = {}, signal, timeoutMs = 120000 }) {
    Object.assign(this, { transport, recorder, signal, timeoutMs });
    this.metadata = Object.freeze(structuredClone(scope));
  }
  /** Tool pipeline derives invocation-local attribution; does not create another agent or mutable shared state. */
  scope(metadata) {
    return new ModelService({
      ...this,
      scope: { ...this.metadata, ...metadata },
    });
  }
  /** Loop/composite services call complete; transport receives cancellation, ledger excludes credentials/messages. */
  async complete(messages, options = {}, metadata = {}) {
    const signals = [
      this.signal,
      options.signal,
      AbortSignal.timeout(this.timeoutMs),
    ].filter(Boolean);
    const signal = AbortSignal.any(signals);
    signal.throwIfAborted();
    const call = {
      ...this.metadata,
      ...metadata,
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      status: "running",
    };
    await this.recorder?.startModelCall(call);
    const start = performance.now();
    let response, error;
    try {
      response = await abortable(
        () =>
          this.transport(messages, {
            ...options,
            signal,
            onText: options.onText
              ? (text) => {
                  if (!signal.aborted) options.onText(text);
                }
              : undefined,
          }),
        signal,
      );
      signal.throwIfAborted();
      return response;
    } catch (e) {
      error = e;
      throw e;
    } finally {
      await this.recorder?.finishModelCall({
        ...call,
        finishedAt: new Date().toISOString(),
        durationMs: performance.now() - start,
        status: error ? (signal.aborted ? "cancelled" : "failed") : "completed",
        usage: typeof response?.usage === "number" ? response.usage : 0,
        usageKnown: response?.usageKnown ?? typeof response?.usage === "number",
        decision: response
          ? {
              content: response.content,
              tool_calls: structuredClone(response.tool_calls),
              decision: structuredClone(response.decision),
            }
          : undefined,
        error: error
          ? { code: error.code || error.name, message: error.message }
          : undefined,
      });
    }
  }
}
