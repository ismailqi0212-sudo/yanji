/**
 * Persistence port called by application assembly, loop instrumentation and the
 * legacy run-state adapter. It owns run/trace persistence, not model decisions,
 * prompts, tool business execution or credential storage. Implementations are
 * injected; importing this module must never open or recover a database.
 */
export class SessionStore {
  /** Report application records lifecycle telemetry, not a draft business commit. */
  updateReportJob(sessionId, changes) {
    throw new Error("SessionStore.updateReportJob not implemented");
  }
  /** ModelService begins durable IO accounting; not a prompt/credential archive. */
  startModelCall(call) {
    throw new Error("SessionStore.startModelCall not implemented");
  }
  /** ModelService finishes accounting exactly once; not a financial result commit. */
  finishModelCall(call) {
    throw new Error("SessionStore.finishModelCall not implemented");
  }
  /** Validated report adapter submits a draft with version guards; no model IO in this boundary. */
  commitReport(sessionId, runId, report, expected, audit) {
    throw new Error("SessionStore.commitReport not implemented");
  }
  /** Called by runtime to load a detached run snapshot; does not resume execution. */
  load(sessionId, runId) {
    throw new Error("SessionStore.load not implemented");
  }
  /** Called before a step; records a durable event and returns a run-scoped span. */
  beginStep(sessionId, runId, metadata) {
    throw new Error("SessionStore.beginStep not implemented");
  }
  /** Called by a span to append a completed immutable round, not overwrite history. */
  appendStep(sessionId, runId, step) {
    throw new Error("SessionStore.appendStep not implemented");
  }
  /** Called by adapters to preserve a resumable snapshot; does not run the agent. */
  checkpoint(sessionId, runId, snapshot) {
    throw new Error("SessionStore.checkpoint not implemented");
  }
  /** Called by legacy adapters to commit an observation; not a tool implementation. */
  commitObservation(sessionId, runId, call, result, metadata) {
    throw new Error("SessionStore.commitObservation not implemented");
  }
  /** Called by assembly to persist a terminal reason; does not cancel in-flight IO. */
  finish(sessionId, runId, outcome) {
    throw new Error("SessionStore.finish not implemented");
  }
}
