import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ModelService } from "../server/llm/model-service.mjs";
import { SQLiteSessionStore } from "../server/trace/sqlite-session-store.mjs";

function fixture(transport) {
  const db = new DatabaseSync(":memory:");
  let chat = {
    id: "c",
    runs: [{ id: "r", status: "running", usage: 0, records: [], events: [] }],
    messages: [],
    cards: [],
    researchSources: [],
    documents: [],
  };
  const store = new SQLiteSessionStore({
    db,
    getProject: () => structuredClone(chat),
    putProject: (c) => {
      chat = structuredClone(c);
    },
    listChats: () => [chat],
  });
  const service = new ModelService({
    transport,
    recorder: store,
    scope: { sessionId: "c", runId: "r", purpose: "decision" },
  });
  return { db, store, service, chat: () => chat };
}
test("model ledger attributes concurrent internal batches to their parent call and counts tokens once", async () => {
  const f = fixture(async () => ({ usage: 7, content: "ok" }));
  try {
    const child = f.service.scope({
      parentCallId: "tool-1",
      purpose: "extract",
    });
    await Promise.all([
      child.complete([], {}, { batch: 1 }),
      child.complete([], {}, { batch: 2 }),
      f.service.complete([]),
    ]);
    const calls = f.store.readTrace("c", "r").modelCalls;
    assert.equal(calls.length, 3);
    assert.equal(f.chat().runs[0].usage, 21);
    assert.deepEqual(
      calls
        .filter((c) => c.parentCallId)
        .map((c) => c.batch)
        .sort(),
      [1, 2],
    );
    assert.ok(
      calls.every((c) => c.status === "completed" && c.durationMs >= 0),
    );
    f.store.finishModelCall(calls[0]);
    assert.equal(f.chat().runs[0].usage, 21);
    assert.equal(JSON.stringify(calls).includes("messages"), false);
  } finally {
    f.db.close();
  }
});
test("model service cancels uncooperative transport and discards late tokens and text", async () => {
  let release,
    receivedSignal,
    streamed = "";
  const f = fixture((_, options) => {
    receivedSignal = options.signal;
    return new Promise((resolve) => {
      release = () => {
        options.onText?.("late");
        resolve({ usage: 99 });
      };
    });
  });
  try {
    const controller = new AbortController();
    const promise = f.service.complete([], {
      signal: controller.signal,
      onText: (t) => {
        streamed += t;
      },
    });
    await new Promise((r) => setImmediate(r));
    controller.abort(new Error("stop"));
    await assert.rejects(promise, /stop/);
    release();
    await new Promise((r) => setImmediate(r));
    assert.equal(receivedSignal.aborted, true);
    assert.equal(streamed, "");
    const call = f.store.readTrace("c", "r").modelCalls[0];
    assert.equal(call.status, "cancelled");
    assert.equal(call.usageKnown, false);
    assert.equal(f.chat().runs[0].usage, 0);
  } finally {
    f.db.close();
  }
});
test("failed model IO records a structured failure without invented usage", async () => {
  const f = fixture(async () => {
    throw new Error("provider failed");
  });
  try {
    await assert.rejects(f.service.complete([]), /provider failed/);
    const call = f.store.readTrace("c", "r").modelCalls[0];
    assert.equal(call.status, "failed");
    assert.equal(call.usageKnown, false);
    assert.equal(call.error.message, "provider failed");
  } finally {
    f.db.close();
  }
});
