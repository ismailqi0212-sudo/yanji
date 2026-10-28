import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SQLiteSessionStore } from "../server/trace/sqlite-session-store.mjs";
import { runAgentLoop } from "../server/agent/loop.mjs";

function fixture() {
  const db = new DatabaseSync(":memory:");
  const chats = new Map([
    [
      "chat",
      {
        id: "chat",
        runs: [
          {
            id: "run",
            messageId: "assistant",
            status: "running",
            records: [],
            events: [],
          },
        ],
        messages: [{ id: "assistant", cardIds: [] }],
        cards: [],
        researchSources: [
          { id: "S1", name: "财务", sourceUrl: "https://example.com/filing" },
        ],
        documents: [
          { id: "pdf", name: "年报", chunks: [{ id: "D1", page: 10 }] },
        ],
      },
    ],
  ]);
  const store = new SQLiteSessionStore({
    db,
    getProject: (id) => {
      if (!chats.has(id)) throw new Error("missing");
      return structuredClone(chats.get(id));
    },
    putProject: (c) => {
      chats.set(c.id, structuredClone(c));
    },
    listChats: () => [...chats.values()].map((c) => structuredClone(c)),
  });
  return {
    db,
    store,
    chats,
    trace: { beginStep: (meta) => store.beginStep("chat", "run", meta) },
  };
}
const schema = (name) => ({
  type: "function",
  function: { name, parameters: { type: "object" } },
});
const call = (name, id = "1", args = "{}") => ({
  id,
  function: { name, arguments: args },
});
const tools = (execute) => ({
  schemas: [schema("lookup"), schema("finish")],
  finish: schema("finish"),
  execute,
});
const memory = { observe() {}, checkpoint() {}, compact() {} };

test("trace records raw decisions, ordered calls, parsed args, sources, timings and legacy records", async () => {
  const f = fixture();
  let turns = 0;
  const out = await runAgentLoop({
    messages: [],
    trace: f.trace,
    llm: async () =>
      ++turns === 1
        ? {
            content: "查资料",
            usage: 12,
            tool_calls: [
              call("lookup", "a", '{"ticker":"AAPL"}'),
              call("lookup", "b"),
            ],
          }
        : { tool_calls: [call("finish", "c")] },
    tools: tools(async (name, args) =>
      name === "finish"
        ? { done: true }
        : { value: 123, sourceIds: ["S1", "D1"] },
    ),
    memory: {
      ...memory,
      observe: (c, r, m) => f.store.commitObservation("chat", "run", c, r, m),
    },
  });
  assert.equal(out.steps, 2);
  const trace = f.store.readTrace("chat", "run");
  assert.equal(trace.steps.length, 2);
  const s = trace.steps[0];
  assert.equal(s.rawDecision.usage, 12);
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[0].args.ticker, "AAPL");
  assert.equal(s.calls[0].rawArguments, '{"ticker":"AAPL"}');
  assert.equal(s.calls[0].source[1].page, 10);
  assert.ok(s.durationMs >= 0);
  assert.ok(s.calls[0].observation.timing.durationMs >= 0);
  assert.equal(f.store.load("chat", "run").records.length, 3);
  assert.equal(trace.steps[1].status, "completed");
  assert.throws(() => f.store.appendStep("chat", "run", s), /UNIQUE/);
  trace.steps[0].rawDecision.content = "mutated";
  assert.equal(
    f.store.readTrace("chat", "run").steps[0].rawDecision.content,
    "查资料",
  );
  f.db.close();
});

test("preflight and LLM failures remain durable even before an observation/checkpoint", async () => {
  for (const host of [true, false]) {
    const f = fixture();
    await assert.rejects(
      () =>
        runAgentLoop({
          messages: [],
          trace: f.trace,
          memory,
          llm: async () => {
            throw new Error("模型断连");
          },
          tools: {
            ...tools(async () => {
              throw new Error("PDF损坏");
            }),
            ...(host ? { requiredFirst: schema("lookup") } : {}),
          },
        }),
      host ? /PDF损坏/ : /模型断连/,
    );
    const { steps, events } = f.store.readTrace("chat", "run");
    assert.equal(steps[0].status, "failed");
    assert.ok(events.some((e) => e.kind === "started"));
    if (host) {
      assert.equal(steps[0].step, 0);
      assert.equal(steps[0].calls[0].observation.status, "error");
      assert.match(steps[0].calls[0].observation.error.message, /PDF/);
    } else assert.equal(steps[0].rawDecision, null);
    f.db.close();
  }
});

test("interruption between calls preserves first observation and closes a cancelled round", async () => {
  const f = fixture(),
    controller = new AbortController();
  await assert.rejects(() =>
    runAgentLoop({
      messages: [],
      trace: f.trace,
      signal: controller.signal,
      memory,
      llm: async () => ({
        tool_calls: [call("lookup", "a"), call("lookup", "b")],
      }),
      tools: tools(async () => {
        controller.abort();
        return { value: 1 };
      }),
    }),
  );
  const s = f.store.readTrace("chat", "run").steps[0];
  assert.equal(s.status, "cancelled");
  assert.equal(s.calls.length, 1);
  f.db.close();
});

test("unfinished spans remain inspectable; session isolation and checkpoint history are preserved", () => {
  const f = fixture();
  const span = f.store.beginStep("chat", "run", { step: 1 });
  span.decision({ tool_calls: [call("lookup")] });
  assert.equal(f.store.readTrace("chat", "run").steps.length, 0);
  assert.equal(f.store.readTrace("chat", "run").events.length, 2);
  assert.throws(() => f.store.readTrace("other", "run"), /missing/);
  f.store.checkpoint("chat", "run", {
    step: 1,
    messages: [],
    seen: new Set(["S1"]),
    calculations: [],
  });
  f.store.checkpoint("chat", "run", {
    step: 2,
    messages: [],
    seen: new Set(["D1"]),
    calculations: [],
  });
  assert.equal(f.store.load("chat", "run").checkpoint.step, 2);
  assert.equal(f.store.readTrace("chat", "run").events.length, 2);
  f.db.close();
});

test("recovery is explicit and idempotent; old evidence and finished runs are not rewritten", () => {
  const f = fixture();
  assert.equal(f.store.load("chat", "run").status, "running");
  const c = f.chats.get("chat");
  c.reportJob = { status: "running" };
  c.runs.push({
    id: "old",
    status: "completed",
    records: [{ result: { sourceId: "S1" } }],
  });
  const original = structuredClone(c.runs[1]);
  f.store.recoverInterrupted();
  assert.equal(f.store.load("chat", "run").status, "interrupted");
  assert.deepEqual(f.store.load("chat", "old"), original);
  assert.equal(f.chats.get("chat").reportJob.status, "interrupted");
  f.store.recoverInterrupted();
  assert.equal(f.store.load("chat", "run").status, "interrupted");
  f.db.close();
});

test("observations expose sources through artifact pointers; unresolved IDs remain marked", () => {
  const f = fixture();
  f.chats.get("chat").cards.push({ id: "chart", sourceIds: ["D1", "missing"] });
  const span = f.store.beginStep("chat", "run", { step: 1 });
  span.observation(call("lookup"), {}, { cardId: "chart" }, { durationMs: 0 });
  span.end();
  const refs = f.store.readTrace("chat", "run").steps[0].calls[0].source;
  assert.equal(refs[0].kind, "document");
  assert.equal(refs[1].resolved, false);
  f.db.close();
});

test("completed and partial traces survive reopening a SQLite connection", async () => {
  const fs = await import("node:fs"),
    os = await import("node:os"),
    path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yanji-trace-")),
    f = fixture();
  try {
    let db = new DatabaseSync(path.join(dir, "trace.sqlite"));
    let adapter = new SQLiteSessionStore({
      db,
      getProject: f.store.getProject,
      putProject: f.store.putProject,
      listChats: f.store.listChats,
    });
    const span = adapter.beginStep("chat", "run", { step: 1 });
    span.decision({ content: "已决策" });
    span.end();
    adapter
      .beginStep("chat", "run", { step: 2 })
      .decision({ content: "未结束" });
    db.close();
    db = new DatabaseSync(path.join(dir, "trace.sqlite"));
    adapter = new SQLiteSessionStore({
      db,
      getProject: f.store.getProject,
      putProject: f.store.putProject,
      listChats: f.store.listChats,
    });
    const trace = adapter.readTrace("chat", "run");
    assert.equal(trace.steps.length, 1);
    assert.equal(trace.events.filter((e) => e.kind === "decision").length, 2);
    assert.equal(trace.steps[0].rawDecision.content, "已决策");
    db.close();
  } finally {
    f.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("importing legacy store no longer marks persisted active runs interrupted", async () => {
  const fs = await import("node:fs"),
    os = await import("node:os"),
    path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yanji-import-"));
  try {
    const db = new DatabaseSync(path.join(dir, "chat.sqlite"));
    db.exec("CREATE TABLE chats(id TEXT PRIMARY KEY,body TEXT NOT NULL)");
    const body = {
      id: "keep",
      updatedAt: "2026-10-27",
      runs: [{ id: "active", status: "running" }],
      reportJob: { status: "running" },
    };
    db.prepare("INSERT INTO chats VALUES(?,?)").run(
      "keep",
      JSON.stringify(body),
    );
    db.close();
    const uri = new URL("../server/memory/store.mjs", import.meta.url).href;
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const s=await import(${JSON.stringify(uri)});process.stdout.write(JSON.stringify(s.getProject('keep')));s.db.close();`,
      ],
      {
        env: { ...process.env, CHAT_DATA_DIR: dir, CHAT_NO_INHERIT: "1" },
        encoding: "utf8",
      },
    );
    assert.deepEqual(JSON.parse(output), body);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loop awaits an asynchronous trace adapter before invoking tools and returning completion", async () => {
  let persistedDecision = false,
    persistedObservation = false,
    flushed = false;
  const trace = {
    beginStep: async () => ({
      decision: async () => {
        await Promise.resolve();
        persistedDecision = true;
      },
      observation: async () => {
        await Promise.resolve();
        persistedObservation = true;
      },
      end: async () => {
        assert.equal(persistedObservation, true);
        await Promise.resolve();
        flushed = true;
      },
    }),
  };
  const out = await runAgentLoop({
    messages: [],
    trace,
    memory,
    llm: async () => ({ tool_calls: [call("finish")] }),
    tools: tools(async () => {
      assert.equal(persistedDecision, true);
      return { done: true };
    }),
  });
  assert.equal(out.steps, 1);
  assert.equal(flushed, true);
});
