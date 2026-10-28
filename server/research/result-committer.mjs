import { randomUUID } from "node:crypto";
import { ToolWorkspace } from "../tools/tool-result.mjs";
import {
  NoopVerifier,
  ToolVerificationError,
} from "../verification/verifier.mjs";

/**
 * Registry execution port. It stages effects, awaits verification, then delegates
 * the atomic business commit to SessionStore. It implements no tool or LLM logic.
 */
export class ToolExecutionPipeline {
  #tail = Promise.resolve();
  constructor({
    store,
    context,
    verifier = new NoopVerifier(),
    publishMemory,
  }) {
    Object.assign(this, { store, context, verifier, publishMemory });
  }
  /** Registry calls run; execute receives a fresh effects/memory port for this invocation only. */
  run(request) {
    const next = this.#tail.then(() => this.#execute(request));
    this.#tail = next.catch(() => {});
    return next;
  }
  /** Serialized per runtime to keep seen/calculation publication consistent; does not lock network globally. */
  async #execute({ entry, args, callId, execute }) {
    callId ??= randomUUID();
    const { cid, run, signal } = this.context;
    signal?.throwIfAborted();
    const snapshot = this.store.sessionSnapshot(cid);
    const workspace = new ToolWorkspace({
      sessionId: cid,
      runId: run.id,
      snapshot,
      memory: this.context,
      telemetry: {
        event: (...a) => this.store.event(...a),
        progress: (...a) => this.store.recordToolProgress(...a),
      },
    });
    const local = {
      ...this.context,
      ...workspace.memory,
      effects: workspace.effects,
      modelService: this.context.modelService?.scope({
        parentCallId: callId,
        purpose: entry.name,
      }),
    };
    let candidate;
    try {
      const data = await execute(local);
      signal?.throwIfAborted();
      if (data?.error)
        throw Object.assign(new Error(String(data.error)), {
          code: "TOOL_RETURNED_ERROR",
        });
      candidate = workspace.prepare(data, { name: entry.name, callId });
      const observation = {
        callId,
        toolName: entry.name,
        data: candidate.data,
        pendingArtifacts: structuredClone(candidate.pendingArtifacts),
        sources: structuredClone(candidate.sources),
        status: "candidate",
      };
      const verdict = await this.verifier.verify(structuredClone(observation), {
        sessionId: cid,
        runId: run.id,
        task: {
          goal: run.question,
          sourceMode: run.route?.sourceMode || run.sourceMode,
        },
        evidence: structuredClone(candidate.evidence),
      });
      signal?.throwIfAborted();
      // Verifier is a gate, not an untracked artifact editor. Modified outputs need a new execution.
      if (verdict?.accepted !== true)
        throw new ToolVerificationError(verdict?.reason);
      this.store.commitToolResult(candidate.pending, {
        callId,
        name: entry.name,
        status: "accepted",
        data: candidate.data,
        sourceIds: candidate.sources.map((s) => s.id),
      });
      this.publishMemory(candidate.memory);
      return candidate.data;
    } catch (error) {
      this.store.recordToolVerification(cid, run.id, {
        callId,
        name: entry.name,
        status:
          error.code === "VERIFICATION_REJECTED"
            ? "rejected"
            : signal?.aborted
              ? "cancelled"
              : "error",
        error: { code: error.code || error.name, message: error.message },
        ...(candidate
          ? {
              data: candidate.data,
              pendingArtifactCount: candidate.pendingArtifacts.length,
              uncommittedSourceIds: candidate.newSources.map((s) => s.id),
            }
          : {}),
      });
      throw error;
    }
  }
}
