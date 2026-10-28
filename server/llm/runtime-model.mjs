import { ModelService } from "./model-service.mjs";
import { model } from "./client.mjs";
import { sessionStore } from "../trace/runtime-store.mjs";

/** Composition root binds the model port to durable accounting; never builds prompts or runs tasks. */
export function runtimeModel(
  sessionId,
  runId,
  signal,
  purpose,
  transport = model,
) {
  return new ModelService({
    transport,
    recorder: sessionStore,
    signal,
    scope: { sessionId, runId, purpose },
  });
}
